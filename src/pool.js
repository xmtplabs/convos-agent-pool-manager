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
export async function createInstance() {
  const id = nanoid(12);
  const name = `convos-agent-${id}`;

  console.log(`[pool] Creating instance ${name}...`);

  // 1. Create Railway service from repo (env vars passed inline to avoid
  //    a separate setVariables call that would trigger another main deploy)
  const serviceId = await railway.createService(name, instanceEnvVars());
  console.log(`[pool]   Railway service created: ${serviceId}`);

  // 3. Generate public domain
  const domain = await railway.createDomain(serviceId);
  const url = `https://${domain}`;
  console.log(`[pool]   Domain: ${url}`);

  // 4. Insert into DB as 'provisioning'
  await db.insertInstance({ id, railwayServiceId: serviceId, railwayUrl: url });
  console.log(`[pool]   Registered as provisioning`);

  return { id, serviceId, url, name };
}

// Check provisioning instances — if their /pool/status says ready, mark idle.
// If stuck beyond STUCK_TIMEOUT_MS, verify against Railway and clean up dead ones.
export async function pollProvisioning() {
  const instances = await db.listProvisioning();
  for (const inst of instances) {
    if (!inst.railway_url) continue;
    try {
      const res = await fetch(`${inst.railway_url}/pool/status`, {
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
      if (status.ready && !status.provisioned) {
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

// Reconcile DB state with Railway — remove orphaned entries where the service no longer exists.
export async function reconcile() {
  const instances = await db.listAll();
  // Only check non-claimed instances (provisioning + idle) to avoid disrupting active agents
  const toCheck = instances.filter((i) => i.status !== "claimed");
  let cleaned = 0;

  for (const inst of toCheck) {
    const service = await railway.getServiceInfo(inst.railway_service_id);
    if (!service) {
      console.log(`[reconcile] ${inst.id} (${inst.status}) — Railway service gone, removing from DB`);
      await db.deleteInstance(inst.id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[reconcile] Cleaned ${cleaned} orphaned instance(s)`);
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

// Launch an agent — provision an idle instance with instructions.
// If joinUrl is provided, join an existing conversation instead of creating one.
// Returns { inviteUrl, qrDataUrl, conversationId, joined } or null if no idle instances.
export async function provision(agentId, instructions, joinUrl) {
  // 1. Atomically claim an idle instance
  const instance = await db.claimOne(agentId);
  if (!instance) return null;

  console.log(`[pool] Launching ${instance.id} for agentId="${agentId}"${joinUrl ? " (join mode)" : ""}`);

  // 2. Call /pool/provision on the instance
  const provisionBody = { instructions, name: agentId };
  if (joinUrl) provisionBody.joinUrl = joinUrl;

  console.log(`[pool] POST ${instance.railway_url}/pool/provision name="${provisionBody.name}"${joinUrl ? ` joinUrl="${joinUrl.slice(0, 40)}..."` : ""}`);
  const res = await fetch(`${instance.railway_url}/pool/provision`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${POOL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(provisionBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Provision failed on ${instance.id}: ${res.status} ${text}`);
  }

  const result = await res.json();

  // 3. Store the invite URL, conversation ID, and instructions
  await db.setClaimed(instance.id, {
    inviteUrl: result.inviteUrl || joinUrl || null,
    conversationId: result.conversationId,
    instructions,
    joinUrl: joinUrl || null,
  });

  // 4. Rename the Railway service so it's identifiable in the dashboard
  try {
    await railway.renameService(instance.railway_service_id, `convos-agent-${agentId}`);
    console.log(`[pool] Renamed ${instance.id} → convos-agent-${agentId}`);
  } catch (err) {
    console.warn(`[pool] Failed to rename ${instance.id}:`, err.message);
  }

  console.log(`[pool] Provisioned ${instance.id}: ${result.joined ? "joined" : "created"} conversation ${result.conversationId}`);

  // 5. Trigger backfill (don't await — fire and forget)
  replenish().catch((err) => console.error("[pool] Backfill error:", err));

  return {
    inviteUrl: result.inviteUrl || null,
    qrDataUrl: result.qrDataUrl || null,
    conversationId: result.conversationId,
    instanceId: instance.id,
    joined: !!result.joined,
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
