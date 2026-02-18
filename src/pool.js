import { nanoid } from "nanoid";
import * as db from "./db/pool.js";
import * as railway from "./railway.js";
import * as cache from "./cache.js";
import { deriveStatus } from "./status.js";
import { ensureVolume, fetchAllVolumesByService, deleteVolume } from "./volumes.js";

const POOL_API_KEY = process.env.POOL_API_KEY;
const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);

const IS_PRODUCTION = (process.env.POOL_ENVIRONMENT || "staging") === "production";

function instanceEnvVars() {
  return {
    ANTHROPIC_API_KEY: process.env.INSTANCE_ANTHROPIC_API_KEY || "",
    XMTP_ENV: process.env.INSTANCE_XMTP_ENV || "dev",
    GATEWAY_AUTH_TOKEN: POOL_API_KEY,
    OPENCLAW_GIT_REF: process.env.OPENCLAW_GIT_REF || (IS_PRODUCTION ? "main" : "staging"),
    PORT: "8080",
  };
}

// Health-check a single instance via /convos/status.
// Returns parsed JSON on success, null on failure.
async function healthCheck(url) {
  try {
    const res = await fetch(`${url}/convos/status`, {
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
  const hasVolume = await ensureVolume(serviceId);
  if (!hasVolume) console.warn(`[pool]   Volume creation failed for ${serviceId}, will retry in tick`);

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
    const status = deriveStatus({
      deployStatus: svc.deployStatus,
      healthCheck: hc,
      createdAt: svc.createdAt,
    });

    const metadata = metadataByServiceId.get(svc.id);
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

  // Delete dead services — clean up volumes BEFORE deleting the service
  const volumeMap = await fetchAllVolumesByService();
  for (const svc of toDelete) {
    try {
      const volumeIds = volumeMap?.get(svc.id) || [];
      for (const vid of volumeIds) {
        await deleteVolume(vid, svc.id);
      }
      await railway.deleteService(svc.id);
      console.log(`[tick] Deleted dead service ${svc.id} (${svc.name})`);
    } catch (err) {
      console.warn(`[tick] Failed to delete ${svc.id}: ${err.message}`);
    }
  }

  // Ensure all agent services have volumes (self-healing for failed creates)
  if (volumeMap) {
    for (const svc of agentServices) {
      if (!volumeMap.has(svc.id) && svc.deployStatus === "SUCCESS") {
        console.log(`[tick] Agent ${svc.name} missing volume, creating...`);
        await ensureVolume(svc.id);
      }
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

    let result;
    if (joinUrl) {
      const res = await fetch(`${instance.url}/convos/join`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          inviteUrl: joinUrl,
          profileName: agentName,
          env: process.env.INSTANCE_XMTP_ENV || "dev",
          instructions,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Join failed on ${instance.id}: ${res.status} ${text}`);
      }
      result = await res.json();
      result.joined = true;
    } else {
      const res = await fetch(`${instance.url}/convos/conversation`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          name: agentName,
          profileName: agentName,
          env: process.env.INSTANCE_XMTP_ENV || "dev",
          instructions,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Create failed on ${instance.id}: ${res.status} ${text}`);
      }
      result = await res.json();
      result.joined = false;
    }

    if (result.conversationId == null) {
      throw new Error(`API returned unexpected format: missing conversationId`);
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
  const vMap = await fetchAllVolumesByService();
  for (const inst of idle) {
    try {
      const vols = vMap?.get(inst.serviceId) || [];
      for (const vid of vols) await deleteVolume(vid, inst.serviceId);
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

  const vMap = await fetchAllVolumesByService();
  const vols = vMap?.get(inst.serviceId) || [];
  for (const vid of vols) await deleteVolume(vid, inst.serviceId);

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

  const vMap = await fetchAllVolumesByService();
  const vols = vMap?.get(inst.serviceId) || [];
  for (const vid of vols) await deleteVolume(vid, inst.serviceId);

  try {
    await railway.deleteService(inst.serviceId);
  } catch (err) {
    // Service might already be gone
    console.warn(`[pool] Failed to delete Railway service:`, err.message);
  }

  cache.remove(inst.serviceId);
  await db.deleteByServiceId(inst.serviceId).catch(() => {});
}
