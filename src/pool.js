import { nanoid } from "nanoid";
import * as db from "./db/pool.js";
import * as railway from "./railway.js";

const POOL_API_KEY = process.env.POOL_API_KEY;
const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);
const STUCK_TIMEOUT_MS = parseInt(process.env.POOL_STUCK_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const RECONCILE_INTERVAL_MS = parseInt(process.env.POOL_RECONCILE_INTERVAL_MS || String(5 * 60 * 1000), 10);
let _lastReconcile = 0;

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

// Create a single new Railway service and register it in the DB.
// Order: createService → insertInstance (no URL) → createDomain → updateUrl
// This ensures the DB record exists as early as possible so reconcile can
// detect orphans if we crash between steps.
export async function createInstance() {
  const id = nanoid(12);
  const name = `convos-agent-${id}`;

  console.log(`[pool] Creating instance ${name}...`);

  // 1. Create Railway service from repo
  const serviceId = await railway.createService(name, instanceEnvVars());
  console.log(`[pool]   Railway service created: ${serviceId}`);

  // 2. Insert DB record immediately (railway_url=null for now).
  //    pollProvisioning skips records with no URL, and the stuck timeout
  //    will clean up if domain creation fails.
  await db.insertInstance({ id, railwayServiceId: serviceId });
  console.log(`[pool]   Registered as provisioning (no URL yet)`);

  // 3. Generate public domain
  const domain = await railway.createDomain(serviceId);
  const url = `https://${domain}`;
  console.log(`[pool]   Domain: ${url}`);

  // 4. Update DB with the URL so pollProvisioning can reach it
  await db.updateInstanceUrl(id, url);
  console.log(`[pool]   URL set: ${url}`);

  return { id, serviceId, url, name };
}

// Check provisioning instances — if their /convos/status says ready, mark idle.
// If stuck beyond STUCK_TIMEOUT_MS, verify against Railway and clean up dead ones.
export async function pollProvisioning() {
  const instances = await db.listProvisioning();
  for (const inst of instances) {
    // No URL yet — can't health-check, but still enforce stuck timeout.
    // This happens when createInstance() inserted the DB record but failed
    // before createDomain/updateUrl completed.
    if (!inst.railway_url) {
      const age = Date.now() - new Date(inst.created_at).getTime();
      if (age > STUCK_TIMEOUT_MS) {
        console.warn(`[pool] ${inst.id} stuck in provisioning for ${Math.round(age / 60000)}min (no URL) — cleaning up`);
        await cleanupInstance(inst, "stuck in provisioning (no URL)");
      }
      continue;
    }
    try {
      const res = await fetch(`${inst.railway_url}/convos/status`, {
        headers: { Authorization: `Bearer ${POOL_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        // Service responded but not ready (e.g. Railway 404 "Application not found")
        // Check if stuck beyond timeout
        const age = Date.now() - new Date(inst.created_at).getTime();
        if (age > STUCK_TIMEOUT_MS) {
          console.warn(`[pool] ${inst.id} stuck in provisioning for ${Math.round(age / 60000)}min (HTTP ${res.status}) — cleaning up`);
          await cleanupInstance(inst, "stuck in provisioning");
        }
        continue;
      }
      const status = await res.json();
      if (status.ready && !status.conversation) {
        await db.markIdle(inst.id, inst.railway_url);
        console.log(`[pool] ${inst.id} is now idle`);
      }
    } catch {
      const age = Date.now() - new Date(inst.created_at).getTime();
      if (age > STUCK_TIMEOUT_MS) {
        console.warn(`[pool] ${inst.id} stuck in provisioning for ${Math.round(age / 60000)}min — cleaning up`);
        await cleanupInstance(inst, "stuck in provisioning");
      }
    }
  }
}

// Verify an instance against Railway and remove it if the service is gone or unreachable.
async function cleanupInstance(inst, reason) {
  const service = await railway.getServiceInfo(inst.railway_service_id);
  if (!service) {
    console.log(`[pool] ${inst.id} — Railway service gone, removing from DB (${reason})`);
    await db.deleteInstance(inst.id);
    return;
  }
  // Service exists on Railway but is unreachable — delete it
  console.log(`[pool] ${inst.id} — deleting unreachable Railway service and removing from DB (${reason})`);
  try {
    await railway.deleteService(inst.railway_service_id);
  } catch (err) {
    console.warn(`[pool] ${inst.id} — failed to delete Railway service: ${err.message}`);
  }
  await db.deleteInstance(inst.id);
}

// Handle an unreachable instance — idle instances are cleaned up immediately,
// claimed instances get a 3-strike retry to avoid killing active sessions on
// transient failures.
async function handleUnreachable(inst, reason) {
  if (inst.status === "claimed") {
    const failures = await db.incrementHealthCheckFailures(inst.id);
    const threshold = 3;
    if (failures >= threshold) {
      console.log(`[reconcile] ${inst.id} (claimed) ${reason} — ${failures} consecutive failures, cleaning up`);
      await cleanupInstance(inst, `claimed but unreachable after ${failures} failures`);
      return true;
    }
    console.log(`[reconcile] ${inst.id} (claimed) ${reason} — failure ${failures}/${threshold}, will retry`);
    return false;
  }
  // Idle instances can be cleaned up immediately
  console.log(`[reconcile] ${inst.id} (${inst.status}) ${reason} — cleaning up`);
  await cleanupInstance(inst, `${inst.status} but unreachable`);
  return true;
}

// Health-check a single non-provisioning instance. Returns true if it was cleaned up.
async function healthCheckInstance(inst) {
  if (!inst.railway_url) {
    console.warn(`[reconcile] ${inst.id} (${inst.status}) has no railway_url — removing orphaned entry`);
    await db.deleteInstance(inst.id);
    return true;
  }

  try {
    const res = await fetch(`${inst.railway_url}/convos/status`, {
      headers: { Authorization: `Bearer ${POOL_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return await handleUnreachable(inst, `unreachable (HTTP ${res.status})`);
    }
    // Successful health check — reset failure count if any
    if (inst.health_check_failures > 0) {
      await db.resetHealthCheckFailures(inst.id);
    }
    return false;
  } catch {
    return await handleUnreachable(inst, `unreachable (timeout/error)`);
  }
}

// Reconcile DB state with Railway in both directions:
//   Direction 1 (DB→Railway): Remove DB records whose Railway service is gone or unreachable.
//   Direction 2 (Railway→DB): Delete Railway services not tracked in the DB (orphans).
// Uses RAILWAY_ENVIRONMENT_ID to filter services so staging never touches production.
const ORPHAN_GRACE_MS = 10 * 60 * 1000; // 10 minutes

export async function reconcile() {
  const myEnvId = process.env.RAILWAY_ENVIRONMENT_ID;
  const [allServices, instances] = await Promise.all([
    railway.listProjectServices(),
    db.listAll(),
  ]);

  const toCheck = instances.filter((i) => i.status !== "provisioning");
  let cleaned = 0;

  if (allServices === null) {
    // API error — fall back to N+1 getServiceInfo for DB→Railway only, skip orphan detection
    console.warn(`[reconcile] listProjectServices failed, falling back to per-service checks`);
    for (const inst of toCheck) {
      const service = await railway.getServiceInfo(inst.railway_service_id);
      if (!service) {
        console.log(`[reconcile] ${inst.id} (${inst.status}) — Railway service gone, removing from DB`);
        await db.deleteInstance(inst.id);
        cleaned++;
        continue;
      }
      try {
        if (await healthCheckInstance(inst)) cleaned++;
      } catch (err) {
        console.warn(`[reconcile] ${inst.id} health check error: ${err.message}`);
      }
    }
  } else {
    // Filter to services in our environment
    const envServices = allServices.filter((s) => s.environmentIds.includes(myEnvId));
    const railwayServiceMap = new Map(envServices.map((s) => [s.id, s]));

    console.log(`[reconcile] ${envServices.length} services in env ${myEnvId}, ${instances.length} DB records`);

    // Direction 1: DB → Railway
    for (const inst of toCheck) {
      if (!railwayServiceMap.has(inst.railway_service_id)) {
        console.log(`[reconcile] ${inst.id} (${inst.status}) — Railway service gone (not in env), removing from DB`);
        await db.deleteInstance(inst.id);
        cleaned++;
        continue;
      }
      try {
        if (await healthCheckInstance(inst)) cleaned++;
      } catch (err) {
        console.warn(`[reconcile] ${inst.id} health check error: ${err.message}`);
      }
    }

    // Direction 2: Railway → DB (orphan detection)
    const dbServiceIds = new Set(instances.map((i) => i.railway_service_id));
    const agentOrphans = envServices.filter(
      (s) =>
        s.name.startsWith("convos-agent-") &&
        s.name !== "convos-agent-pool-manager" &&
        !dbServiceIds.has(s.id)
    );

    for (const svc of agentOrphans) {
      const age = Date.now() - new Date(svc.createdAt).getTime();
      if (age < ORPHAN_GRACE_MS) {
        console.log(`[reconcile] Orphan ${svc.id} (${svc.name}) is only ${Math.round(age / 1000)}s old, skipping`);
        continue;
      }
      try {
        await railway.deleteService(svc.id);
        console.log(`[reconcile] Deleted orphan ${svc.id} (${svc.name})`);
        cleaned++;
      } catch (err) {
        console.warn(`[reconcile] Failed to delete orphan ${svc.id}: ${err.message}`);
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[reconcile] Cleaned ${cleaned} instance(s)`);
  }
  return cleaned;
}

// Ensure pool has enough idle instances. Create new ones if needed.
export async function replenish() {
  const counts = await db.countByStatus();
  const total = counts.provisioning + counts.idle + counts.claimed;
  const deficit = MIN_IDLE - (counts.idle + counts.provisioning);

  console.log(
    `[pool] Status: ${counts.idle} idle, ${counts.provisioning} provisioning, ${counts.claimed} claimed (total: ${total}, min_idle: ${MIN_IDLE}, max: ${MAX_TOTAL})`
  );

  if (deficit <= 0) {
    console.log(`[pool] Pool is healthy, no action needed`);
    return;
  }

  const canCreate = Math.min(deficit, MAX_TOTAL - total);
  if (canCreate <= 0) {
    console.log(`[pool] At max capacity (${total}/${MAX_TOTAL}), cannot create more`);
    return;
  }

  console.log(`[pool] Creating ${canCreate} new instance(s)...`);
  const results = [];
  for (let i = 0; i < canCreate; i++) {
    try {
      const inst = await createInstance();
      results.push(inst);
    } catch (err) {
      console.error(`[pool] Failed to create instance:`, err);
    }
  }
  return results;
}

// Launch an agent — claim an idle instance and provision it directly via OpenClaw.
// If joinUrl is provided, join an existing conversation instead of creating one.
// Returns { inviteUrl, conversationId, instanceId, joined } or null if no idle instances.
export async function provision(agentName, instructions, joinUrl) {
  // 1. Atomically claim an idle instance
  const instance = await db.claimOne(agentName);
  if (!instance) return null;

  console.log(`[pool] Launching ${instance.id} for agentName="${agentName}"${joinUrl ? " (join mode)" : ""}`);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${POOL_API_KEY}`,
  };

  // 2. Call OpenClaw gateway directly — one call writes instructions,
  //    creates XMTP identity, creates conversation, starts message stream.
  let result;
  try {
    if (joinUrl) {
      console.log(`[pool] POST ${instance.railway_url}/convos/join`);
      const res = await fetch(`${instance.railway_url}/convos/join`, {
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
        throw new Error(`Join failed on ${instance.id} (agent=${agentName}): ${res.status} ${text}`);
      }
      result = await res.json();
      if (result.conversationId == null) {
        throw new Error(`OpenClaw API returned unexpected response format: missing conversationId (join mode)`);
      }
      result.joined = true;
    } else {
      console.log(`[pool] POST ${instance.railway_url}/convos/conversation`);
      const res = await fetch(`${instance.railway_url}/convos/conversation`, {
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
        throw new Error(`Create failed on ${instance.id} (agent=${agentName}): ${res.status} ${text}`);
      }
      result = await res.json();
      if (result.conversationId == null) {
        throw new Error(`OpenClaw API returned unexpected response format: missing conversationId (create mode)`);
      }
      result.joined = false;
    }
  } catch (err) {
    console.error(`[pool] Provision failed for ${instance.id} (agent=${agentName}), releasing claim:`, err.message);
    try {
      await db.markIdle(instance.id, instance.railway_url);
    } catch (releaseErr) {
      console.error(`[pool] Failed to release claim for ${instance.id}:`, releaseErr.message);
    }
    throw err;
  }

  // 3. Store results in DB
  await db.setClaimed(instance.id, {
    inviteUrl: result.inviteUrl || joinUrl || null,
    conversationId: result.conversationId,
    instructions,
    joinUrl: joinUrl || null,
  });

  // 4. Rename the Railway service for dashboard visibility
  try {
    await railway.renameService(instance.railway_service_id, `convos-agent-${agentName}`);
    console.log(`[pool] Renamed ${instance.id} → convos-agent-${agentName}`);
  } catch (err) {
    console.warn(`[pool] Failed to rename ${instance.id}:`, err.message);
  }

  console.log(`[pool] Provisioned ${instance.id}: ${result.joined ? "joined" : "created"} conversation ${result.conversationId}`);

  // 5. Trigger backfill (don't await — fire and forget)
  replenish().catch((err) => console.error("[pool] Backfill error:", err));

  return {
    inviteUrl: result.inviteUrl || null,
    conversationId: result.conversationId,
    instanceId: instance.id,
    joined: result.joined,
  };
}

// Drain idle instances from the pool — delete from Railway and remove from DB.
export async function drainPool(count) {
  const idle = await db.listIdle(count);
  console.log(`[pool] Draining ${idle.length} idle instance(s)...`);
  const results = [];
  for (const inst of idle) {
    try {
      await railway.deleteService(inst.railway_service_id);
      await db.deleteInstance(inst.id);
      results.push(inst.id);
      console.log(`[pool]   Drained ${inst.id}`);
    } catch (err) {
      console.error(`[pool]   Failed to drain ${inst.id}:`, err.message);
    }
  }
  return results;
}

// Kill a launched instance — delete from Railway and remove from DB.
export async function killInstance(id) {
  const instances = await db.listAll();
  const inst = instances.find((i) => i.id === id);
  if (!inst) throw new Error(`Instance ${id} not found`);

  console.log(`[pool] Killing instance ${inst.id} (${inst.claimed_by})`);

  try {
    await railway.deleteService(inst.railway_service_id);
    console.log(`[pool]   Railway service deleted`);
  } catch (err) {
    console.warn(`[pool]   Failed to delete Railway service:`, err.message);
  }

  await db.deleteInstance(id);
  console.log(`[pool]   Removed from DB`);

  // Trigger backfill
  replenish().catch((err) => console.error("[pool] Backfill error:", err));
}

// Run a single reconcile + poll + replenish cycle.
export async function tick() {
  // Reconcile periodically (every RECONCILE_INTERVAL_MS, not every tick)
  const now = Date.now();
  if (now - _lastReconcile > RECONCILE_INTERVAL_MS) {
    await reconcile();
    _lastReconcile = now;
  }
  await pollProvisioning();
  await replenish();
}
