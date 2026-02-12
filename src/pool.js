import { readFileSync } from "fs";
import { customAlphabet } from "nanoid";
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
import * as db from "./db/pool.js";
import * as sprite from "./sprite.js";
import * as log from "./log.js";

const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);

// Retry helper for transient WebSocket/network errors on Sprite exec calls.
async function retryExec(name, command, { retries = 2, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sprite.exec(name, command);
    } catch (err) {
      if (attempt > retries) throw err;
      log.warn(`[pool] exec attempt ${attempt} failed on ${name}, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
const RECONCILE_INTERVAL_MS = parseInt(process.env.POOL_RECONCILE_INTERVAL_MS || String(5 * 60 * 1000), 10);
let _lastReconcile = 0;

// Circuit breaker: stop creating instances after repeated failures.
let _consecutiveFailures = 0;
let _backoffUntil = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

const POOL_ENVIRONMENT = process.env.POOL_ENVIRONMENT || "dev";
const IS_PRODUCTION = POOL_ENVIRONMENT === "production";
const SPRITE_PREFIX = `convos-agent-${POOL_ENVIRONMENT}-`;
const XMTP_ENV = process.env.INSTANCE_XMTP_ENV || (IS_PRODUCTION ? "production" : "dev");
const ANTHROPIC_API_KEY_VALUE = process.env.INSTANCE_ANTHROPIC_API_KEY || "";

// OpenClaw config written into each Sprite before the gateway starts.
function openclawConfig() {
  return JSON.stringify({
    auth: {
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          mode: "token",
        },
      },
    },
    channels: {
      convos: {
        enabled: true,
        env: XMTP_ENV,
      },
    },
    plugins: {
      entries: {
        convos: { enabled: true },
      },
    },
    gateway: {
      mode: "local",
      port: 8080,
      bind: "lan",
      auth: {
        token: "pool-managed",
      },
      reload: {
        mode: "off",
      },
    },
  }, null, 2);
}

// Register the openclaw gateway as a Sprite Service.
// Services auto-restart on wake, so the gateway survives hibernation.
// Retries on transient network errors since this is a remote API call.
async function startGateway(name, { retries = 2, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await sprite.registerService(name, "gateway",
        "source ~/.openclaw/.env && OPENCLAW_HIDE_BANNER=1 openclaw gateway run --port 8080 2>&1 | tee -a /tmp/gateway.log",
      );
      return;
    } catch (err) {
      if (attempt > retries) throw err;
      log.warn(`[pool] startGateway attempt ${attempt} failed on ${name}, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Format elapsed time as human-readable string (e.g. "4m 12s" or "45s").
function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// Create a single new Sprite and register it in the DB.
export async function createInstance() {
  const id = nanoid(12);
  const name = `${SPRITE_PREFIX}${id}`;
  const startTime = Date.now();

  log.info(`[pool] Creating ${id}`);

  // 1. Create Sprite
  const { url } = await sprite.createSprite(name);
  log.debug(`[pool]   Sprite created: ${url}`);

  // 2. Register in DB immediately so tick() sees it as provisioning
  await db.insertInstance({ id, spriteName: name, spriteUrl: url });
  log.debug(`[pool]   Registered as provisioning`);

  // 3–9: Setup, config, env, start, wait, checkpoint — clean up on failure
  try {
    // 3. Run setup in phases (separate exec calls to avoid WebSocket timeout)
    const gitRef = process.env.OPENCLAW_GIT_REF || (IS_PRODUCTION ? "main" : "staging");

    // Phase 1: Build tools + clone + pnpm install
    const setupScript = readFileSync(
      new URL("../scripts/sprite-setup.sh", import.meta.url), "utf-8"
    );
    await retryExec(name, `export OPENCLAW_GIT_REF=${gitRef}\n${setupScript}`);
    log.debug(`[pool]   Phase 1 done (tools + install)`);

    // Phase 2: pnpm build
    const pathPrefix = 'export PATH="$(npm config get prefix)/bin:$HOME/.bun/bin:$PATH"';
    await retryExec(name, `${pathPrefix} && cd /openclaw && pnpm build 2>&1 | tail -20`);
    log.debug(`[pool]   Phase 2 done (build)`);

    // Phase 3: CLI wrapper + workspace
    await retryExec(name, `mkdir -p /usr/local/bin && cat > /usr/local/bin/openclaw << 'WRAPPER'\n#!/usr/bin/env bash\nexec node /openclaw/dist/entry.js "$@"\nWRAPPER\nchmod +x /usr/local/bin/openclaw && mkdir -p ~/.openclaw/workspace`);
    log.debug(`[pool]   Phase 3 done (CLI + workspace)`);

    // 4. Write openclaw.json config (API provider, convos plugin, gateway auth)
    const config = openclawConfig();
    await retryExec(name, `cat > ~/.openclaw/openclaw.json << 'CFGEOF'\n${config}\nCFGEOF`);
    log.debug(`[pool]   OpenClaw config written`);

    // 5. Write .env with ANTHROPIC_API_KEY (persists in checkpoint, sourced on gateway start)
    await retryExec(name, `cat > ~/.openclaw/.env << 'ENVEOF'\nANTHROPIC_API_KEY=${ANTHROPIC_API_KEY_VALUE}\nENVEOF`);
    log.debug(`[pool]   Environment written`);

    // 6. Start the gateway
    await startGateway(name);
    log.debug(`[pool]   Gateway starting`);

    // 7. Wait for gateway to become ready
    await waitForGateway(url);
    log.debug(`[pool]   Gateway ready`);

    // 8. Verify no XMTP state leaked (must be clean for golden checkpoint)
    const convosCheck = await sprite.exec(name, "test -d ~/.convos && echo exists || echo clean");
    if (String(convosCheck.stdout).trim() === "exists") {
      throw new Error("~/.convos/ exists before checkpoint — XMTP state leaked");
    }

    // 9. Take golden checkpoint
    const checkpointId = await sprite.createCheckpoint(name, "golden");

    // 10. Mark idle with checkpoint
    await db.markIdle(id, url, checkpointId);
    log.info(`[pool] ${id} ready (${formatElapsed(Date.now() - startTime)}) checkpoint=${checkpointId}`);
  } catch (err) {
    const elapsed = formatElapsed(Date.now() - startTime);
    const r = err.result || {};
    if (r.exitCode !== undefined) {
      const stdoutLines = String(r.stdout || "").trim().split("\n");
      const tail = stdoutLines.slice(-5).join("\n  ");
      log.error(`[pool] ${id} setup failed (${elapsed}): exit ${r.exitCode}\n  stdout (last 5):\n  ${tail}\n  stderr: ${String(r.stderr || "").trim()}`);
    } else {
      log.error(`[pool] ${id} setup failed (${elapsed}): ${err.message}`);
    }
    // Clean up the failed sprite and DB entry
    await sprite.deleteSprite(name).catch(() => {});
    await db.deleteInstance(id);
    throw err;
  }

  return { id, name, url };
}

// Poll the gateway until it responds with ready: true.
async function waitForGateway(url, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/convos/status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = await res.json();
        if (body.ready) return;
      }
    } catch {
      // gateway not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Gateway at ${url} did not become ready within ${timeoutMs / 1000}s`);
}

// Clean up provisioning instances orphaned by a previous process.
// Called once at startup — any "provisioning" row in the DB has no
// createInstance() coroutine driving it, so delete it.
export async function cleanupOrphans() {
  const orphans = await db.listProvisioning();
  if (orphans.length === 0) return;
  log.info(`[startup] Cleaning up ${orphans.length} orphaned provisioning instance(s)`);
  for (const inst of orphans) {
    await sprite.deleteSprite(inst.sprite_name).catch(() => {});
    await db.deleteInstance(inst.id);
    log.info(`[startup]   Removed orphan ${inst.id}`);
  }
}

// Verify an instance against Sprite API and remove it if gone or unreachable.
async function cleanupInstance(inst, reason) {
  const info = await sprite.getSpriteInfo(inst.sprite_name);
  if (!info) {
    log.info(`[pool] ${inst.id} — Sprite gone, removing from DB (${reason})`);
    await db.deleteInstance(inst.id);
    return;
  }
  log.info(`[pool] ${inst.id} — deleting unreachable Sprite and removing from DB (${reason})`);
  try {
    await sprite.deleteSprite(inst.sprite_name);
  } catch (err) {
    log.warn(`[pool] ${inst.id} — failed to delete Sprite: ${err.message}`);
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
      log.debug(`[reconcile] ${inst.id} — Sprite gone, purging DB record`);
      await db.deleteInstance(inst.id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log.info(`[reconcile] Purged ${cleaned} stale DB records`);
  }
  return cleaned;
}

// Track last status string to suppress duplicate status lines.
let _lastStatusStr = "";

// Ensure pool has enough idle instances. Create new ones if needed.
export async function replenish() {
  const counts = await db.countByStatus();
  const total = counts.provisioning + counts.idle + counts.claimed;
  const deficit = MIN_IDLE - (counts.idle + counts.provisioning);

  const statusStr = `${counts.provisioning} provisioning, ${counts.idle} idle, ${counts.claimed} claimed`;

  if (deficit <= 0) {
    if (statusStr !== _lastStatusStr) {
      log.info(`[pool] Status: ${statusStr}`);
      _lastStatusStr = statusStr;
    }
    return;
  }

  const canCreate = Math.min(deficit, MAX_TOTAL - total);
  if (canCreate <= 0) {
    log.info(`[pool] At max capacity (${total}/${MAX_TOTAL}), cannot create more`);
    return;
  }

  // Circuit breaker: skip creation if backing off after repeated failures
  if (Date.now() < _backoffUntil) {
    const remaining = Math.round((_backoffUntil - Date.now()) / 1000);
    log.info(`[pool] Circuit breaker active — skipping creation (${remaining}s remaining)`);
    return;
  }

  log.info(`[pool] Status: ${statusStr} — need ${canCreate}`);
  _lastStatusStr = statusStr;

  // Fire all creations concurrently — each registers in DB immediately,
  // so subsequent ticks won't double-count.
  for (let i = 0; i < canCreate; i++) {
    createInstance()
      .then(() => { _consecutiveFailures = 0; })
      .catch((err) => {
        _consecutiveFailures++;
        log.error(`[pool] Failed to create instance (${_consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);
        if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          _backoffUntil = Date.now() + BACKOFF_MS;
          log.error(`[pool] Circuit breaker tripped — pausing instance creation for ${BACKOFF_MS / 1000}s`);
        }
      });
  }
}

// Poll one-shot process-join-requests on a claimed instance.
// Compensates for the --watch stream not delivering DMs in Sprite environments.
// Runs in the background; stops after a join is approved or timeout.
function pollJoinRequests(spriteName, conversationId, instanceId) {
  const POLL_INTERVAL_MS = 5000;
  const MAX_POLLS = 60; // 5 min max
  let polls = 0;

  const timer = setInterval(async () => {
    polls++;
    try {
      const r = await sprite.exec(spriteName,
        `timeout 10 node /openclaw/extensions/convos/node_modules/@convos/cli/bin/run.js conversations process-join-requests --conversation ${conversationId} --env ${XMTP_ENV} --json 2>/dev/null`);
      const stdout = String(r.stdout).trim();
      // Parse last JSON object from output
      const lastBrace = stdout.lastIndexOf("}");
      if (lastBrace !== -1) {
        let depth = 0;
        for (let i = lastBrace; i >= 0; i--) {
          if (stdout[i] === "}") depth++;
          else if (stdout[i] === "{") depth--;
          if (depth === 0) {
            const result = JSON.parse(stdout.slice(i, lastBrace + 1));
            if (result.processed > 0) {
              log.info(`[pool] ${instanceId}: join approved via poll (${result.processed} processed)`);
              clearInterval(timer);
              return;
            }
            break;
          }
        }
      }
    } catch (err) {
      log.debug(`[pool] ${instanceId}: join poll error: ${err.message}`);
    }
    if (polls >= MAX_POLLS) {
      log.debug(`[pool] ${instanceId}: join poll timeout after ${MAX_POLLS} polls`);
      clearInterval(timer);
    }
  }, POLL_INTERVAL_MS);
}

// Launch an agent — provision an idle instance with instructions.
// If joinUrl is provided, join an existing conversation instead of creating one.
// Returns { inviteUrl, conversationId, joined } or null if no idle instances.
export async function provision(agentName, instructions, joinUrl) {
  // 1. Atomically claim an idle instance
  const instance = await db.claimOne(agentName);
  if (!instance) return null;

  log.info(`[pool] Launching ${instance.id} for agent="${agentName}"${joinUrl ? " (join mode)" : ""}`);

  // 2. Write INSTRUCTIONS.md to the workspace
  await retryExec(instance.sprite_name, `cat > ~/.openclaw/workspace/INSTRUCTIONS.md << 'INSTREOF'\n${instructions}\nINSTREOF`);
  log.debug(`[pool]   INSTRUCTIONS.md written`);

  // 3. Create or join a conversation via the gateway
  let result;
  if (joinUrl) {
    log.debug(`[pool] POST ${instance.sprite_url}/convos/join profileName="${agentName}" joinUrl="${joinUrl.slice(0, 40)}..."`);
    const res = await fetch(`${instance.sprite_url}/convos/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteUrl: joinUrl, profileName: agentName, env: XMTP_ENV }),
    });
    if (res.status === 409) {
      throw new Error(`Instance ${instance.id} already bound to a conversation`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Join failed on ${instance.id}: ${res.status} ${text}`);
    }
    result = await res.json();
    // status is "joined" or "waiting_for_acceptance"
    result.joined = result.status === "joined";
  } else {
    log.debug(`[pool] POST ${instance.sprite_url}/convos/conversation name="${agentName}"`);
    const res = await fetch(`${instance.sprite_url}/convos/conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agentName, profileName: agentName, env: XMTP_ENV }),
    });
    if (res.status === 409) {
      throw new Error(`Instance ${instance.id} already bound to a conversation`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Conversation create failed on ${instance.id}: ${res.status} ${text}`);
    }
    result = await res.json();
  }

  // 4. Store the invite URL, conversation ID, and instructions
  await db.setClaimed(instance.id, {
    inviteUrl: result.inviteUrl || joinUrl || null,
    conversationId: result.conversationId,
    instructions,
    joinUrl: joinUrl || null,
  });

  log.info(`[pool] Provisioned ${instance.id}: ${result.joined ? "joined" : result.status === "waiting_for_acceptance" ? "waiting for acceptance" : "created"} conversation ${result.conversationId || "(pending)"}`);

  // 4b. Background: poll one-shot process-join-requests until a join is approved.
  // The --watch stream in the gateway subprocess doesn't reliably deliver DMs
  // from new senders in the Sprite environment, so we compensate by running
  // the batch processor periodically.
  if (!joinUrl) {
    pollJoinRequests(instance.sprite_name, result.conversationId, instance.id);
  }

  // 5. Always start a 1-for-1 replacement (capped by MAX_TOTAL).
  const counts = await db.countByStatus();
  const total = counts.provisioning + counts.idle + counts.claimed;
  if (total < MAX_TOTAL) {
    log.info(`[pool] Starting 1-for-1 replacement (${total}/${MAX_TOTAL})`);
    createInstance().catch((err) => log.error("[pool] Replacement error:", err));
  }

  return {
    inviteUrl: result.inviteUrl || null,
    inviteSlug: result.inviteSlug || null,
    conversationId: result.conversationId || null,
    instanceId: instance.id,
    joined: !!result.joined,
    waitingForAcceptance: result.status === "waiting_for_acceptance",
  };
}

// Drain idle instances from the pool — permanently destroy Sprites.
export async function drainPool(count) {
  const idle = await db.listIdle(count);
  log.info(`[pool] Draining ${idle.length} idle instance(s)...`);
  const results = [];
  for (const inst of idle) {
    try {
      await sprite.deleteSprite(inst.sprite_name);
      await db.deleteInstance(inst.id);
      results.push(inst.id);
      log.info(`[pool]   Drained ${inst.id}`);
    } catch (err) {
      log.error(`[pool]   Failed to drain ${inst.id}:`, err.message);
    }
  }
  return results;
}

// Recycle a claimed instance — restore checkpoint, restart gateway, return to idle.
// Falls back to destroyInstance if there's no checkpoint or restore fails.
export async function recycleInstance(id) {
  const instances = await db.listAll();
  const inst = instances.find((i) => i.id === id);
  if (!inst) throw new Error(`Instance ${id} not found`);

  log.info(`[pool] Recycling instance ${inst.id} (${inst.claimed_by})`);

  if (!inst.checkpoint_id) {
    log.warn(`[pool]   No checkpoint — falling back to destroy`);
    return destroyInstance(id);
  }

  try {
    // 1. Restore filesystem to golden checkpoint (kills all processes)
    await sprite.restoreCheckpoint(inst.sprite_name, inst.checkpoint_id);
    log.info(`[pool]   Checkpoint restored`);

    // 2. Restart the gateway
    await startGateway(inst.sprite_name);
    log.info(`[pool]   Gateway restarting`);

    // 3. Wait for gateway to come up
    await waitForGateway(inst.sprite_url, { timeoutMs: 60_000 });
    log.info(`[pool]   Gateway ready`);

    // 4. Mark idle (clears claimed_by, conversation_id, etc.)
    await db.markIdle(inst.id, inst.sprite_url);
    log.info(`[pool]   Instance ${inst.id} recycled → ready`);
  } catch (err) {
    log.error(`[pool]   Recycle failed: ${err.message} — destroying`);
    await destroyInstance(id);
  }
}

// Permanently destroy an instance — delete Sprite and remove from DB.
export async function destroyInstance(id) {
  const instances = await db.listAll();
  const inst = instances.find((i) => i.id === id);
  if (!inst) throw new Error(`Instance ${id} not found`);

  log.info(`[pool] Destroying instance ${inst.id} (${inst.claimed_by})`);

  try {
    await sprite.deleteSprite(inst.sprite_name);
    log.info(`[pool]   Sprite deleted`);
  } catch (err) {
    log.warn(`[pool]   Failed to delete Sprite:`, err.message);
  }

  await db.deleteInstance(id);
  log.info(`[pool]   Removed from DB`);

  // Trigger backfill
  replenish().catch((err) => log.error("[pool] Backfill error:", err));
}

// Heartbeat — keep Sprites awake and recover or remove dead instances.
//
// Normal case: HTTP ping keeps the Sprite awake, gateway stays running.
// Recovery case: HTTP ping fails → exec wakes the Sprite → Service restarts
//   the gateway → next ping succeeds.
// Dead case: Both HTTP and exec fail → Sprite is gone → clean up.
//
// _heartbeatState tracks { fails, recoveries } per instance.
// After MAX_RECOVERIES exec wakes without the gateway coming back, give up.
const _heartbeatState = new Map();
const MAX_HEARTBEAT_FAILURES = 3;
const MAX_RECOVERIES = 3;

export async function heartbeat() {
  const instances = await db.listAll();
  const toPing = instances.filter((i) => i.status === "idle" || i.status === "claimed");

  for (const inst of toPing) {
    if (!inst.sprite_url) continue;
    const state = _heartbeatState.get(inst.id) || { fails: 0, recoveries: 0 };
    try {
      const res = await fetch(`${inst.sprite_url}/convos/status`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        _heartbeatState.delete(inst.id);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      state.fails++;
      _heartbeatState.set(inst.id, state);
      log.warn(`[heartbeat] ${inst.id} (${inst.status}) failed ping ${state.fails}/${MAX_HEARTBEAT_FAILURES}: ${err.message}`);

      if (state.fails >= MAX_HEARTBEAT_FAILURES) {
        if (state.recoveries >= MAX_RECOVERIES) {
          log.error(`[heartbeat] ${inst.id} — ${MAX_RECOVERIES} recovery attempts failed — cleaning up`);
          _heartbeatState.delete(inst.id);
          await cleanupInstance(inst, "heartbeat failure after recovery attempts");
          continue;
        }
        // Try to wake the Sprite via exec. If it works, the Service will
        // restart the gateway and the next heartbeat should succeed.
        try {
          await sprite.exec(inst.sprite_name, "true");
          state.recoveries++;
          state.fails = 0;
          log.info(`[heartbeat] ${inst.id} — woke via exec (${state.recoveries}/${MAX_RECOVERIES}), waiting for Service to restart gateway`);
        } catch {
          log.error(`[heartbeat] ${inst.id} — exec failed, Sprite is dead — cleaning up`);
          _heartbeatState.delete(inst.id);
          await cleanupInstance(inst, "heartbeat failure");
        }
      }
    }
  }
}

// Run a single reconcile + replenish cycle.
export async function tick() {
  // Reconcile periodically (every RECONCILE_INTERVAL_MS, not every tick)
  const now = Date.now();
  if (now - _lastReconcile > RECONCILE_INTERVAL_MS) {
    await reconcile();
    _lastReconcile = now;
  }
  await replenish();
}
