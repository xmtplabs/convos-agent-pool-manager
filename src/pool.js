import { nanoid } from "nanoid";
import * as db from "./db/pool.js";
import * as railway from "./railway.js";
import * as cache from "./cache.js";
import { deriveStatus } from "./status.js";

const POOL_API_KEY = process.env.POOL_API_KEY;
const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);

const IS_PRODUCTION = (process.env.POOL_ENVIRONMENT || "staging") === "production";

function instanceEnvVars() {
  return {
    ANTHROPIC_API_KEY: process.env.INSTANCE_ANTHROPIC_API_KEY || "",
    XMTP_ENV: process.env.INSTANCE_XMTP_ENV || "dev",
    GATEWAY_AUTH_TOKEN: POOL_API_KEY,
    OPENCLAW_STATE_DIR: "/data",
    PORT: "8080",
  };
}

// Health-check a single instance via /pool/health.
// Returns parsed JSON on success, null on failure.
async function healthCheck(url) {
  try {
    const res = await fetch(`${url}/pool/health`, {
      headers: { Authorization: `Bearer ${POOL_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Resolve a Railway service's public URL from its domain.
async function getServiceUrl(serviceId) {
  try {
    const domain = await railway.getServiceDomain(serviceId);
    return domain ? `https://${domain}` : null;
  } catch {
    return null;
  }
}

// Create a single new Railway service (no DB write).
export async function createInstance() {
  const id = nanoid(12);
  const name = `convos-agent-${id}`;

  console.log(`[pool] Creating instance ${name}...`);

  const serviceId = await railway.createService(name, instanceEnvVars());
  console.log(`[pool]   Railway service created: ${serviceId}`);

  // Attach persistent volume for OpenClaw state
  try {
    const vol = await railway.createVolume(serviceId, "/data");
    console.log(`[pool]   Volume created: ${vol.id}`);
  } catch (err) {
    console.warn(`[pool]   Failed to create volume for ${serviceId}:`, err.message);
  }

  const domain = await railway.createDomain(serviceId);
  const url = `https://${domain}`;
  console.log(`[pool]   Domain: ${url}`);

  // Add to cache immediately as starting
  cache.set(serviceId, {
    serviceId,
    id,
    name,
    url,
    status: "starting",
    createdAt: new Date().toISOString(),
    deployStatus: "BUILDING",
  });

  return { id, serviceId, url, name };
}

// Unified tick: rebuild cache from Railway, health-check, replenish.
export async function tick() {
  const myEnvId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!myEnvId) {
    console.warn(`[tick] RAILWAY_ENVIRONMENT_ID not set, skipping tick`);
    return;
  }

  const allServices = await railway.listProjectServices();

  if (allServices === null) {
    console.warn(`[tick] listProjectServices failed, skipping tick`);
    return;
  }

  // Filter to agent services in our environment
  const agentServices = allServices.filter(
    (s) =>
      s.name.startsWith("convos-agent-") &&
      s.name !== "convos-agent-pool-manager" &&
      s.environmentIds.includes(myEnvId)
  );

  // Load metadata rows for enrichment
  const metadataRows = await db.listAll();
  const metadataByServiceId = new Map(metadataRows.map((r) => [r.railway_service_id, r]));

  // Health-check all SUCCESS services in parallel
  const successServices = agentServices.filter((s) => s.deployStatus === "SUCCESS");

  // Get URLs for services (we need domains to health-check)
  // For services already in cache, reuse their URL
  const urlMap = new Map();
  for (const svc of successServices) {
    const cached = cache.get(svc.id);
    if (cached?.url) {
      urlMap.set(svc.id, cached.url);
    }
  }

  // For services not in cache, fetch domains in parallel
  const needUrls = successServices.filter((s) => !urlMap.has(s.id));
  if (needUrls.length > 0) {
    const urlResults = await Promise.allSettled(
      needUrls.map(async (svc) => {
        const url = await getServiceUrl(svc.id);
        return { id: svc.id, url };
      })
    );
    for (const r of urlResults) {
      if (r.status === "fulfilled" && r.value.url) {
        urlMap.set(r.value.id, r.value.url);
      }
    }
  }

  // Health-check SUCCESS services in parallel
  const healthResults = new Map();
  const toCheck = successServices.filter(
    (s) => urlMap.has(s.id) && !cache.isBeingClaimed(s.id)
  );

  const checks = await Promise.allSettled(
    toCheck.map(async (svc) => {
      const result = await healthCheck(urlMap.get(svc.id));
      return { id: svc.id, result };
    })
  );
  for (const c of checks) {
    if (c.status === "fulfilled") {
      healthResults.set(c.value.id, c.value.result);
    }
  }

  // Rebuild cache and take action on dead/sleeping services
  const toDelete = [];

  for (const svc of agentServices) {
    // Skip services being claimed right now
    if (cache.isBeingClaimed(svc.id)) continue;

    const hc = healthResults.get(svc.id) || null;
    const metadata = metadataByServiceId.get(svc.id);
    const status = deriveStatus({
      deployStatus: svc.deployStatus,
      healthCheck: hc,
      createdAt: svc.createdAt,
      hasMetadata: !!metadata,
    });
    const url = urlMap.get(svc.id) || cache.get(svc.id)?.url || null;

    if (status === "dead" || status === "sleeping") {
      if (metadata) {
        // Was claimed — mark as crashed in cache for dashboard
        cache.set(svc.id, {
          serviceId: svc.id,
          id: metadata.id,
          name: svc.name,
          url,
          status: "crashed",
          createdAt: svc.createdAt,
          deployStatus: svc.deployStatus,
          agentName: metadata.agent_name,
          instructions: metadata.instructions,
          inviteUrl: metadata.invite_url,
          conversationId: metadata.conversation_id,
          claimedAt: metadata.claimed_at,
        });
      } else {
        // Was idle/provisioning — delete silently
        cache.remove(svc.id);
        toDelete.push(svc);
      }
      continue;
    }

    // Build cache entry
    const entry = {
      serviceId: svc.id,
      id: metadata?.id || svc.name.replace("convos-agent-", ""),
      name: svc.name,
      url,
      status,
      createdAt: svc.createdAt,
      deployStatus: svc.deployStatus,
    };

    // Enrich with metadata
    if (metadata) {
      entry.agentName = metadata.agent_name;
      entry.instructions = metadata.instructions;
      entry.inviteUrl = metadata.invite_url;
      entry.conversationId = metadata.conversation_id;
      entry.claimedAt = metadata.claimed_at;
    }

    cache.set(svc.id, entry);
  }

  // Remove cache entries for services no longer in Railway
  const railwayServiceIds = new Set(agentServices.map((s) => s.id));
  for (const inst of cache.getAll()) {
    if (!railwayServiceIds.has(inst.serviceId) && !cache.isBeingClaimed(inst.serviceId)) {
      cache.remove(inst.serviceId);
    }
  }

  // Delete dead services from Railway
  for (const svc of toDelete) {
    try {
      await railway.deleteService(svc.id);
      console.log(`[tick] Deleted dead service ${svc.id} (${svc.name})`);
    } catch (err) {
      console.warn(`[tick] Failed to delete ${svc.id}: ${err.message}`);
    }
  }

  // Replenish
  const counts = cache.getCounts();
  const total = counts.starting + counts.idle + counts.claimed;
  const deficit = MIN_IDLE - (counts.idle + counts.starting);

  console.log(
    `[tick] ${counts.idle} idle, ${counts.starting} starting, ${counts.claimed} claimed, ${counts.crashed || 0} crashed (total: ${total})`
  );

  if (deficit > 0) {
    const canCreate = Math.min(deficit, MAX_TOTAL - total);
    if (canCreate > 0) {
      console.log(`[tick] Creating ${canCreate} new instance(s)...`);
      for (let i = 0; i < canCreate; i++) {
        try {
          await createInstance();
        } catch (err) {
          console.error(`[tick] Failed to create instance:`, err);
        }
      }
    }
  }
}

// Claim an idle instance and provision it.
// 1. POST /pool/provision — writes instructions (agnostic)
// 2. POST /convos-sdk/setup — creates identity + conversation (proxied through pool-server)
// 3. POST /convos-sdk/setup/complete — saves config to disk
// For join: step 2 creates owner conversation, then POST /convos-sdk/join joins the target.
export async function provision(agentName, instructions, joinUrl) {
  const instance = cache.findClaimable();
  if (!instance) return null;

  cache.startClaim(instance.serviceId);
  try {
    console.log(`[pool] Claiming ${instance.id} for "${agentName}"${joinUrl ? " (join)" : ""}`);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${POOL_API_KEY}`,
    };

    // Step 1: Write instructions via pool API (agnostic)
    const provisionRes = await fetch(`${instance.url}/pool/provision`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ agentName, instructions }),
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
    if (joinUrl) {
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
      console.warn(`[pool] Failed to rename ${instance.id}:`, err.message);
    }

    console.log(`[pool] Provisioned ${instance.id}: ${result.joined ? "joined" : "created"} conversation ${result.conversationId}`);

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

// Drain idle instances.
export async function drainPool(count) {
  const idle = cache.getByStatus("idle").slice(0, count);
  console.log(`[pool] Draining ${idle.length} idle instance(s)...`);
  const results = [];
  for (const inst of idle) {
    try {
      await railway.deleteService(inst.serviceId);
      cache.remove(inst.serviceId);
      results.push(inst.id);
      console.log(`[pool]   Drained ${inst.id}`);
    } catch (err) {
      console.error(`[pool]   Failed to drain ${inst.id}:`, err.message);
    }
  }
  return results;
}

// Kill a specific instance.
export async function killInstance(id) {
  const inst = cache.getAll().find((i) => i.id === id);
  if (!inst) throw new Error(`Instance ${id} not found`);

  console.log(`[pool] Killing instance ${inst.id} (${inst.agentName || inst.name})`);

  try {
    await railway.deleteService(inst.serviceId);
  } catch (err) {
    console.warn(`[pool] Failed to delete Railway service:`, err.message);
  }

  cache.remove(inst.serviceId);
  await db.deleteByServiceId(inst.serviceId).catch(() => {});
}

// Dismiss a crashed agent (user-initiated from dashboard).
export async function dismissCrashed(id) {
  const inst = cache.getAll().find((i) => i.id === id && i.status === "crashed");
  if (!inst) throw new Error(`Crashed instance ${id} not found`);

  console.log(`[pool] Dismissing crashed ${inst.id} (${inst.agentName || inst.name})`);

  try {
    await railway.deleteService(inst.serviceId);
  } catch (err) {
    // Service might already be gone
    console.warn(`[pool] Failed to delete Railway service:`, err.message);
  }

  cache.remove(inst.serviceId);
  await db.deleteByServiceId(inst.serviceId).catch(() => {});
}
