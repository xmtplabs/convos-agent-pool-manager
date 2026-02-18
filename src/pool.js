import { nanoid } from "nanoid";
import * as db from "./db/pool.js";
import * as railway from "./railway.js";
import * as cache from "./cache.js";
import { deriveStatus } from "./status.js";
import { ensureVolume, fetchAllVolumesByService } from "./volumes.js";
import { instanceEnvVars, resolveOpenRouterApiKey, generatePrivateWalletKey, generateGatewayToken, generateSetupPassword } from "./keys.js";
import { destroyInstance, destroyInstances } from "./delete.js";

const POOL_API_KEY = process.env.POOL_API_KEY;
const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);

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

  const vars = { ...instanceEnvVars() };
  if (vars.OPENCLAW_GATEWAY_TOKEN === undefined) vars.OPENCLAW_GATEWAY_TOKEN = generateGatewayToken();
  vars.GATEWAY_AUTH_TOKEN = vars.OPENCLAW_GATEWAY_TOKEN; // entrypoint reads this
  if (vars.SETUP_PASSWORD === undefined) vars.SETUP_PASSWORD = generateSetupPassword();
  const { key: openRouterKey, hash: openRouterKeyHash } = await resolveOpenRouterApiKey(id);
  if (openRouterKey) vars.OPENROUTER_API_KEY = openRouterKey;
  const privateWalletKey = generatePrivateWalletKey();
  vars.PRIVATE_WALLET_KEY = privateWalletKey;

  const serviceId = await railway.createService(name, vars);
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
    openRouterApiKey: openRouterKey || undefined,
    openRouterKeyHash: openRouterKeyHash || undefined,
    privateWalletKey,
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

  // Log deploy statuses for agent services
  for (const svc of agentServices) {
    const meta = metadataByServiceId.get(svc.id);
    console.log(`[tick] ${svc.name} deploy=${svc.deployStatus}${meta ? " (claimed)" : ""}`);
  }

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
      if (!result?.ready) console.log(`[tick] ${svc.name} health=${JSON.stringify(result)}`);
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
        const cached = cache.get(svc.id);
        toDelete.push({ svc, cached });
        cache.remove(svc.id);
      }
      continue;
    }

    // Build cache entry (preserve openRouterApiKey from create)
    const existing = cache.get(svc.id);
    const entry = {
      serviceId: svc.id,
      id: metadata?.id || svc.name.replace("convos-agent-", ""),
      name: svc.name,
      url,
      status,
      createdAt: svc.createdAt,
      deployStatus: svc.deployStatus,
    };
    if (existing?.openRouterApiKey) entry.openRouterApiKey = existing.openRouterApiKey;
    if (existing?.openRouterKeyHash) entry.openRouterKeyHash = existing.openRouterKeyHash;
    if (existing?.privateWalletKey) entry.privateWalletKey = existing.privateWalletKey;

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

  // Clean DB metadata for services that no longer exist on Railway
  await db.deleteOrphaned([...railwayServiceIds]).catch((err) =>
    console.warn(`[tick] deleteOrphaned failed: ${err.message}`)
  );

  // Delete dead services + their volumes (single volume query for all)
  await destroyInstances(toDelete);

  // Ensure all agent services have volumes
  const volumeMap = await fetchAllVolumesByService();
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

// Provisioning flow lives in provision.js (convos-sdk setup/join orchestration).
export { provision } from "./provision.js";

// Drain idle instances.
export async function drainPool(count) {
  const idle = cache.getByStatus("idle").slice(0, count);
  console.log(`[pool] Draining ${idle.length} idle instance(s)...`);
  const results = [];
  for (const inst of idle) {
    try {
      await destroyInstance(inst);
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
  if (!inst) return; // Already gone (e.g. duplicate kill request)

  // Remove from cache first to prevent duplicate kills
  cache.remove(inst.serviceId);

  console.log(`[pool] Killing instance ${inst.id} (${inst.agentName || inst.name})`);
  await destroyInstance(inst);
}

// Dismiss a crashed agent (user-initiated from dashboard).
export async function dismissCrashed(id) {
  const inst = cache.getAll().find((i) => i.id === id && i.status === "crashed");
  if (!inst) throw new Error(`Crashed instance ${id} not found`);

  console.log(`[pool] Dismissing crashed ${inst.id} (${inst.agentName || inst.name})`);
  await destroyInstance(inst);
}
