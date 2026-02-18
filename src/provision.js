/**
 * Provisioning: claim an idle instance and set up convos identity + conversation.
 *
 * Flow:
 *   1. setVariables (channels, model, name) → redeploy → wait healthy
 *   2. POST /pool/provision — write AGENTS.md + invite/join convos
 *
 * The pool-server handles the full convos flow (invite or join) internally,
 * using the channel client's auto-created identity (persisted in state-dir).
 *
 * To disable convos provisioning, comment out the import in pool.js.
 */

import * as db from "./db/pool.js";
import * as railway from "./railway.js";
import * as cache from "./cache.js";
import { instanceEnvVarsForProvision } from "./pool.js";

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
    // OPENROUTER_API_KEY is already set from warm-up — instanceEnvVarsForProvision
    // omits it so the Railway upsert doesn't overwrite the per-instance key.
    const vars = instanceEnvVarsForProvision({
      model,
      agentName,
      privateWalletKey: instance.privateWalletKey,
    });
    const variables = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v ?? "")]));
    await railway.setVariables(instance.serviceId, variables);
    console.log(`[provision] Set vars, triggering redeploy...`);
    await railway.redeployService(instance.serviceId);
    const healthy = await waitHealthy(instance.url);
    if (!healthy) throw new Error(`Instance ${instance.id} did not become healthy after redeploy`);

    // Step 2: Write instructions + invite/join convos via pool API
    const provisionRes = await fetch(`${instance.url}/pool/provision`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ agentName, instructions: instructions || "", joinUrl }),
    });
    if (!provisionRes.ok) {
      const text = await provisionRes.text();
      throw new Error(`Provision failed on ${instance.id}: ${provisionRes.status} ${text}`);
    }
    const result = await provisionRes.json();

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
