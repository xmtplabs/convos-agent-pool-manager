import { nanoid } from "nanoid";
import * as db from "./db/pool.js";
import * as railway from "./railway.js";

const POOL_API_KEY = process.env.POOL_API_KEY;
const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);

function instanceEnvVars() {
  return {
    POOL_MODE: "true",
    POOL_API_KEY: POOL_API_KEY,
    POOL_AUTH_CHOICE: process.env.POOL_AUTH_CHOICE || "apiKey",
    ANTHROPIC_API_KEY: process.env.INSTANCE_ANTHROPIC_API_KEY || "",
    XMTP_ENV: process.env.INSTANCE_XMTP_ENV || "dev",
    SETUP_PASSWORD: process.env.INSTANCE_SETUP_PASSWORD || "pool-managed",
    PORT: "8080",
  };
}

// Create a single new Railway service and register it in the DB.
export async function createInstance() {
  const id = nanoid(12);
  const name = `concierge-${id}`;

  console.log(`[pool] Creating instance ${name}...`);

  // 1. Create Railway service from repo
  const serviceId = await railway.createService(name);
  console.log(`[pool]   Railway service created: ${serviceId}`);

  // 2. Set env vars (this triggers the first deployment)
  await railway.setVariables(serviceId, instanceEnvVars());
  console.log(`[pool]   Env vars set`);

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
export async function pollProvisioning() {
  const instances = await db.listProvisioning();
  for (const inst of instances) {
    if (!inst.railway_url) {
      // Domain might not be set yet — skip instances without URLs
      continue;
    }
    try {
      const res = await fetch(`${inst.railway_url}/pool/status`, {
        headers: { Authorization: `Bearer ${POOL_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const status = await res.json();
      if (status.ready && !status.provisioned) {
        await db.markIdle(inst.id, inst.railway_url);
        console.log(`[pool] ${inst.id} is now idle`);
      }
    } catch {
      // Instance not ready yet, check age for stuck detection
      const age = Date.now() - new Date(inst.created_at).getTime();
      if (age > 10 * 60 * 1000) {
        console.warn(`[pool] ${inst.id} stuck in provisioning for ${Math.round(age / 60000)}min`);
      }
    }
  }
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

// Provision an idle instance with instructions.
// Returns { inviteUrl, qrDataUrl, conversationId } or null if no idle instances.
export async function provision(conciergeId, instructions) {
  // 1. Atomically claim an idle instance
  const instance = await db.claimOne(conciergeId);
  if (!instance) return null;

  console.log(`[pool] Claiming ${instance.id} for concierge ${conciergeId}`);

  // 2. Call /pool/provision on the instance
  const res = await fetch(`${instance.railway_url}/pool/provision`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${POOL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ instructions }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Provision failed on ${instance.id}: ${res.status} ${text}`);
  }

  const result = await res.json();

  // 3. Store the invite URL and conversation ID
  await db.setClaimed(instance.id, {
    inviteUrl: result.inviteUrl,
    conversationId: result.conversationId,
  });

  console.log(`[pool] Provisioned ${instance.id}: ${result.inviteUrl}`);

  // 4. Trigger backfill (don't await — fire and forget)
  replenish().catch((err) => console.error("[pool] Backfill error:", err));

  return {
    inviteUrl: result.inviteUrl,
    qrDataUrl: result.qrDataUrl,
    conversationId: result.conversationId,
    instanceId: instance.id,
  };
}

// Run a single replenish + poll cycle.
export async function tick() {
  await pollProvisioning();
  await replenish();
}
