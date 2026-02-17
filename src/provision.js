/**
 * Provisioning: claim an idle instance and set up convos identity + conversation.
 *
 * Flow:
 *   1. setVariables (channels, model, name) → redeploy → wait healthy
 *   2. POST /pool/provision — write AGENTS.md (instructions with identity preset)
 *   3. POST /convos-sdk/setup — create XMTP identity + conversation
 *   4. POST /convos-sdk/setup/complete — persist config to disk
 *   5. POST /convos-sdk/join — (optional) join existing conversation
 *
 * To disable convos provisioning, comment out the import in pool.js.
 */

import * as db from "./db/pool.js";
import * as railway from "./railway.js";
import * as cache from "./cache.js";
import { instanceEnvVarsForProvision } from "./pool.js";
import { resolveOpenRouterApiKey } from "./keys.js";

const POOL_API_KEY = process.env.POOL_API_KEY;

async function waitHealthy(url, maxAttempts = 180, intervalMs = 2000) {
  const headers = { Authorization: `Bearer ${POOL_API_KEY}` };
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${url}/pool/health`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.ready) return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function provision(opts) {
  const { agentName, instructions, joinUrl, model } = opts;

  const instance = cache.findClaimable();
  if (!instance) return null;

  cache.startClaim(instance.serviceId);
  try {
    console.log(`[provision] Claiming ${instance.id} for "${agentName}"${joinUrl ? " (join)" : ""}`);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${POOL_API_KEY}`,
    };

    // Step 1: setVariables, redeploy, wait healthy
    const openRouterKey = instance.openRouterApiKey ?? (await resolveOpenRouterApiKey(instance.id));
    const vars = instanceEnvVarsForProvision({
      model,
      agentName,
      openRouterApiKey: openRouterKey,
      privateWalletKey: instance.privateWalletKey,
    });
    const variables = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v ?? "")]));
    await railway.setVariables(instance.serviceId, variables);
    console.log(`[provision] Set vars, triggering redeploy...`);
    await railway.redeployService(instance.serviceId);
    const healthy = await waitHealthy(instance.url);
    if (!healthy) throw new Error(`Instance ${instance.id} did not become healthy after redeploy`);

    // Step 2: Write instructions via pool API
    const provisionRes = await fetch(`${instance.url}/pool/provision`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ agentName, instructions: instructions || "" }),
    });
    if (!provisionRes.ok) {
      const text = await provisionRes.text();
      throw new Error(`Provision failed on ${instance.id}: ${provisionRes.status} ${text}`);
    }

    // Step 2: Create identity + conversation via convos-sdk (proxied through pool-server)
    const setupRes = await fetch(`${instance.url}/convos-sdk/setup`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        name: agentName,
        env: process.env.INSTANCE_XMTP_ENV || "dev",
      }),
    });
    if (!setupRes.ok) {
      const text = await setupRes.text();
      throw new Error(`Setup failed on ${instance.id}: ${setupRes.status} ${text}`);
    }
    const setupResult = await setupRes.json();

    // Step 3: Save config to disk
    const completeRes = await fetch(`${instance.url}/convos-sdk/setup/complete`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!completeRes.ok) {
      const text = await completeRes.text();
      throw new Error(`Setup complete failed on ${instance.id}: ${completeRes.status} ${text}`);
    }

    let result = {
      conversationId: setupResult.conversationId,
      inviteUrl: setupResult.inviteUrl || null,
      joined: false,
    };

    // Step 4 (optional): Join existing conversation
    // setup/complete triggers a config hot reload that restarts the channel.
    // Wait for the agent to be healthy again before joining so the channel
    // client is ready (avoids DB lock contention from one-off clients).
    if (joinUrl) {
      const healthyAfterSetup = await waitHealthy(instance.url, 30, 1000);
      if (!healthyAfterSetup) {
        throw new Error(`Instance ${instance.id} did not become healthy after setup/complete`);
      }
      const joinRes = await fetch(`${instance.url}/convos-sdk/join`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ invite: joinUrl }),
      });
      if (!joinRes.ok) {
        const text = await joinRes.text();
        throw new Error(`Join failed on ${instance.id}: ${joinRes.status} ${text}`);
      }
      const joinResult = await joinRes.json();
      result = {
        conversationId: joinResult.conversationId || result.conversationId,
        inviteUrl: joinUrl,
        joined: true,
      };
    }

    // Insert metadata row
    await db.insertMetadata({
      id: instance.id,
      railwayServiceId: instance.serviceId,
      agentName,
      conversationId: result.conversationId,
      inviteUrl: result.inviteUrl || joinUrl || null,
      instructions,
    });

    // Update cache
    cache.set(instance.serviceId, {
      ...instance,
      status: "claimed",
      agentName,
      conversationId: result.conversationId,
      inviteUrl: result.inviteUrl || joinUrl || null,
      instructions,
      claimedAt: new Date().toISOString(),
    });

    // Rename Railway service for dashboard visibility
    try {
      await railway.renameService(instance.serviceId, `convos-agent-${agentName}`);
    } catch (err) {
      console.warn(`[provision] Failed to rename ${instance.id}:`, err.message);
    }

    console.log(`[provision] Provisioned ${instance.id}: ${result.joined ? "joined" : "created"} conversation ${result.conversationId}`);

    return {
      inviteUrl: result.inviteUrl || null,
      conversationId: result.conversationId,
      instanceId: instance.id,
      joined: result.joined,
    };
  } finally {
    cache.endClaim(instance.serviceId);
  }
}
