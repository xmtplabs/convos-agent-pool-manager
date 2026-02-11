import { readFileSync } from "fs";
import { customAlphabet } from "nanoid";
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
import * as db from "./db/pool.js";
import * as sprite from "./sprite.js";

const POOL_API_KEY = process.env.POOL_API_KEY;
const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);

// Retry helper for transient WebSocket/network errors on Sprite exec calls.
async function retryExec(name, command, { retries = 2, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sprite.exec(name, command);
    } catch (err) {
      if (attempt > retries) throw err;
      console.warn(`[pool] exec attempt ${attempt} failed on ${name}, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
const STUCK_TIMEOUT_MS = parseInt(process.env.POOL_STUCK_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const RECONCILE_INTERVAL_MS = parseInt(process.env.POOL_RECONCILE_INTERVAL_MS || String(5 * 60 * 1000), 10);
let _lastReconcile = 0;

function instanceEnvString() {
  return [
    `POOL_MODE=true`,
    `POOL_API_KEY=${POOL_API_KEY}`,
    `POOL_AUTH_CHOICE=${process.env.POOL_AUTH_CHOICE || "apiKey"}`,
    `ANTHROPIC_API_KEY=${process.env.INSTANCE_ANTHROPIC_API_KEY || ""}`,
    `XMTP_ENV=${process.env.INSTANCE_XMTP_ENV || "dev"}`,
    `SETUP_PASSWORD=${process.env.INSTANCE_SETUP_PASSWORD || "pool-managed"}`,
    `PORT=8080`,
  ].join("\n");
}

// Create a single new Sprite and register it in the DB.
export async function createInstance() {
  const id = nanoid(12);
  const name = `convos-agent-${id}`;

  console.log(`[pool] Creating instance ${name}...`);

  // 1. Create Sprite
  const { url } = await sprite.createSprite(name);
  console.log(`[pool]   Sprite created: ${url}`);

  // 2. Register in DB immediately so tick() sees it as provisioning
  await db.insertInstance({ id, spriteName: name, spriteUrl: url });
  console.log(`[pool]   Registered as provisioning`);

  // 3–5: Setup, env, and start — clean up sprite+DB on any failure
  try {
    // 3. Run setup script inside the Sprite (takes several minutes)
    const setupScript = readFileSync(
      new URL("../scripts/sprite-setup.sh", import.meta.url), "utf-8"
    );
    await sprite.exec(name, setupScript);
    console.log(`[pool]   Setup script complete`);

    // 4. Write .env file for the convos-agent wrapper
    const envVars = instanceEnvString();
    await retryExec(name, `cat > /opt/convos-agent/.env << 'ENVEOF'\n${envVars}\nENVEOF`);
    console.log(`[pool]   Environment written`);

    // 5. Start the server (detached so it keeps running)
    await sprite.startDetached(name, "cd /opt/convos-agent && node src/server.js");
    console.log(`[pool]   Server starting`);
  } catch (err) {
    const r = err.result || {};
    if (r.exitCode !== undefined) {
      console.error(`[pool]   Setup failed (exit ${r.exitCode}):\n  stdout: ${String(r.stdout || "").trim().split("\n").pop()}\n  stderr: ${String(r.stderr || "").trim()}`);
    } else {
      console.error(`[pool]   Instance setup failed: ${err.message}`);
    }
    // Clean up the failed sprite and DB entry
    await sprite.deleteSprite(name).catch(() => {});
    await db.deleteInstance(id);
    throw err;
  }

  return { id, name, url };
}

// Check provisioning instances — if their /pool/status says ready, mark idle.
// If stuck beyond STUCK_TIMEOUT_MS, verify against Sprite API and clean up dead ones.
export async function pollProvisioning() {
  const instances = await db.listProvisioning();
  if (instances.length > 0) {
    console.log(`[poll] Checking ${instances.length} provisioning instance(s)...`);
  }
  for (const inst of instances) {
    if (!inst.sprite_url) continue;
    const age = Date.now() - new Date(inst.created_at).getTime();
    const ageStr = `${Math.round(age / 1000)}s`;
    try {
      const res = await fetch(`${inst.sprite_url}/pool/status`, {
        headers: { Authorization: `Bearer ${POOL_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.log(`[poll] ${inst.id} (${ageStr}) — HTTP ${res.status}`);
        if (age > STUCK_TIMEOUT_MS) {
          console.warn(`[poll] ${inst.id} stuck for ${Math.round(age / 60000)}min — cleaning up`);
          await cleanupInstance(inst, "stuck in provisioning");
        }
        continue;
      }
      const status = await res.json();
      console.log(`[poll] ${inst.id} (${ageStr}) — ready=${status.ready} provisioned=${status.provisioned}`);
      if (status.ready && !status.provisioned) {
        await db.markIdle(inst.id, inst.sprite_url);
        console.log(`[poll] ${inst.id} is now idle`);
      }
    } catch (err) {
      console.log(`[poll] ${inst.id} (${ageStr}) — ${err.message || "fetch error"}`);
      if (age > STUCK_TIMEOUT_MS) {
        console.warn(`[poll] ${inst.id} stuck for ${Math.round(age / 60000)}min — cleaning up`);
        await cleanupInstance(inst, "stuck in provisioning");
      }
    }
  }
}

// Verify an instance against Sprite API and remove it if gone or unreachable.
async function cleanupInstance(inst, reason) {
  const info = await sprite.getSpriteInfo(inst.sprite_name);
  if (!info) {
    console.log(`[pool] ${inst.id} — Sprite gone, removing from DB (${reason})`);
    await db.deleteInstance(inst.id);
    return;
  }
  console.log(`[pool] ${inst.id} — deleting unreachable Sprite and removing from DB (${reason})`);
  try {
    await sprite.deleteSprite(inst.sprite_name);
  } catch (err) {
    console.warn(`[pool] ${inst.id} — failed to delete Sprite: ${err.message}`);
  }
  await db.deleteInstance(inst.id);
}

// Reconcile DB state with Sprites — remove orphaned entries where the Sprite no longer exists.
export async function reconcile() {
  const instances = await db.listAll();
  const toCheck = instances.filter((i) => i.status !== "claimed");
  if (toCheck.length === 0) return 0;

  // Get all sprites at once (much faster than checking one by one)
  const allSprites = await sprite.listSprites();
  const spriteNames = new Set(allSprites.map((s) => s.name));
  let cleaned = 0;

  for (const inst of toCheck) {
    if (!spriteNames.has(inst.sprite_name)) {
      console.log(`[reconcile] ${inst.id} (${inst.status}) — Sprite gone, removing from DB`);
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

  console.log(`[pool] POST ${instance.sprite_url}/pool/provision name="${provisionBody.name}"${joinUrl ? ` joinUrl="${joinUrl.slice(0, 40)}..."` : ""}`);
  const res = await fetch(`${instance.sprite_url}/pool/provision`, {
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

  console.log(`[pool] Provisioned ${instance.id}: ${result.joined ? "joined" : "created"} conversation ${result.conversationId}`);

  // 4. Trigger backfill (don't await — fire and forget)
  replenish().catch((err) => console.error("[pool] Backfill error:", err));

  return {
    inviteUrl: result.inviteUrl || null,
    qrDataUrl: result.qrDataUrl || null,
    conversationId: result.conversationId,
    instanceId: instance.id,
    joined: !!result.joined,
  };
}

// Drain idle instances from the pool — delete Sprites and remove from DB.
export async function drainPool(count) {
  const idle = await db.listIdle(count);
  console.log(`[pool] Draining ${idle.length} idle instance(s)...`);
  const results = [];
  for (const inst of idle) {
    try {
      await sprite.deleteSprite(inst.sprite_name);
      await db.deleteInstance(inst.id);
      results.push(inst.id);
      console.log(`[pool]   Drained ${inst.id}`);
    } catch (err) {
      console.error(`[pool]   Failed to drain ${inst.id}:`, err.message);
    }
  }
  return results;
}

// Kill a launched instance — delete Sprite and remove from DB.
export async function killInstance(id) {
  const instances = await db.listAll();
  const inst = instances.find((i) => i.id === id);
  if (!inst) throw new Error(`Instance ${id} not found`);

  console.log(`[pool] Killing instance ${inst.id} (${inst.claimed_by})`);

  try {
    await sprite.deleteSprite(inst.sprite_name);
    console.log(`[pool]   Sprite deleted`);
  } catch (err) {
    console.warn(`[pool]   Failed to delete Sprite:`, err.message);
  }

  await db.deleteInstance(id);
  console.log(`[pool]   Removed from DB`);

  // Trigger backfill
  replenish().catch((err) => console.error("[pool] Backfill error:", err));
}

// Heartbeat — ping all non-provisioning instances to keep Sprites awake.
// Also serves as a health check: if an instance fails 3 consecutive pings, clean it up.
const _failCounts = new Map();
const MAX_HEARTBEAT_FAILURES = 3;

export async function heartbeat() {
  const instances = await db.listAll();
  const toPing = instances.filter((i) => i.status === "idle" || i.status === "claimed");

  for (const inst of toPing) {
    if (!inst.sprite_url) continue;
    try {
      const res = await fetch(`${inst.sprite_url}/pool/status`, {
        headers: { Authorization: `Bearer ${POOL_API_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        _failCounts.delete(inst.id);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      const fails = (_failCounts.get(inst.id) || 0) + 1;
      _failCounts.set(inst.id, fails);
      console.warn(`[heartbeat] ${inst.id} (${inst.status}) failed ping ${fails}/${MAX_HEARTBEAT_FAILURES}: ${err.message}`);

      if (fails >= MAX_HEARTBEAT_FAILURES) {
        console.error(`[heartbeat] ${inst.id} unreachable — cleaning up`);
        _failCounts.delete(inst.id);

        // Check if the Sprite actually exists before deciding what to do
        const info = await sprite.getSpriteInfo(inst.sprite_name);
        if (!info) {
          // Sprite is gone (or sprite_name is a stale Railway UUID) — just remove from DB
          console.log(`[heartbeat] ${inst.id} — Sprite gone, removing from DB`);
          await db.deleteInstance(inst.id);
        } else if (inst.status === "idle") {
          await cleanupInstance(inst, "heartbeat failure");
        } else {
          // Attempt to restart the server on the claimed Sprite
          try {
            await sprite.startDetached(inst.sprite_name, "cd /opt/convos-agent && node src/server.js");
            console.log(`[heartbeat] ${inst.id} — server restarted`);
            _failCounts.delete(inst.id);
          } catch {
            console.error(`[heartbeat] ${inst.id} — restart failed, cleaning up`);
            await cleanupInstance(inst, "heartbeat failure + restart failed");
          }
        }
      }
    }
  }
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
