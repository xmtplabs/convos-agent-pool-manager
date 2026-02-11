# OpenClaw Gateway Direct Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify the pool manager by removing the convos-agent-railway-template intermediary and talking to OpenClaw's gateway directly. Add checkpoint-based recycling to reuse Sprites instead of destroying and rebuilding them.

**Context:** The OpenClaw `convos-cli-migration` branch introduces a new Convos CLI that creates XMTP identities lazily on `/convos/conversation` — not during gateway startup. This means a running gateway with no XMTP state is a clean, reusable starting point. Combined with Sprite checkpoints (which capture filesystem state), we can snapshot that clean state and restore to it after each conversation ends.

**Branch:** `openclaw-gateway-direct` (off `sprite-migration`)

**Repos affected:** `concierge-pool-manager` only. OpenClaw consumed as-is from `convos-cli-migration`.

---

## Architecture

**Before:**
```
Pool Manager → [Sprite: convos-agent-railway-template/server.js → OpenClaw]
               cloned into each Sprite, provides /pool/status, /pool/provision
               starts OpenClaw as subprocess
```

**After:**
```
Pool Manager → [Sprite: openclaw gateway run]
               no intermediary, pool manager calls OpenClaw HTTP routes directly
               writes INSTRUCTIONS.md via sprite.exec()
```

The setup script stops cloning convos-agent-railway-template into Sprites. The template repo itself is untouched — we just stop using it.

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Platform | Sprites (stay) | Already smoke-tested, exec API useful for config/instructions |
| Intermediary server | Eliminate | OpenClaw gateway serves all needed HTTP routes natively |
| Pool model | Keep warm pool (MIN_IDLE=3) | Instant claims are a requirement |
| Instance recycling | Checkpoint restore | Reuse Sprites in ~15s instead of rebuilding in ~5min |
| Pre-built artifact | Defer | Sprite cloning is coming — will eliminate build-per-Sprite entirely |
| Instructions | INSTRUCTIONS.md in workspace | OpenClaw reads it at agent startup, same mechanism as today |

---

## Sprite Lifecycle

### Creating a new Sprite (infrequent — scaling up)

1. `sprite.createSprite(name)` — fresh Sprite from base Ubuntu image
2. Run `scripts/sprite-setup.sh` via `sprite.exec()` — installs build tools, Bun, pnpm, clones and builds OpenClaw (~3-5 min)
3. Write `~/.openclaw/openclaw.json` via `sprite.exec()` — API key, convos plugin enabled, XMTP env. The `ANTHROPIC_API_KEY` must be written into config or a `.env` file (not passed inline to the start command), so it survives checkpoint restore.
4. Start `openclaw gateway run --port 8080` via `sprite.startDetached()`
5. Poll `GET /convos/status` until it returns `{ ready: true }` (confirms gateway + convos plugin loaded)
6. Verify `~/.convos/` does not exist (no XMTP identity files leaked into the checkpoint)
7. `sprite.createCheckpoint("golden")` — snapshot the clean state
8. Store checkpoint ID in DB, mark idle

### Claiming an instance (user-facing, instant)

1. `db.claimOne(agentId)` — pick an idle instance
2. Write `INSTRUCTIONS.md` to `~/.openclaw/workspace/` via `sprite.exec()`
3. `POST /convos/conversation` on the gateway — creates XMTP identity + conversation (~2-5s)
4. Update DB with conversationId, inviteUrl, instructions
5. Return inviteUrl to caller

For join mode: `POST /convos/join` with inviteUrl instead of step 3.

### Recycling (after conversation ends)

1. `sprite.restoreCheckpoint(checkpointId)` — filesystem reset (~1s), processes killed
2. Start `openclaw gateway run --port 8080` via `sprite.startDetached()` (~10-15s)
3. Poll gateway until it responds
4. Mark idle in DB

The Sprite is reused — no rebuild needed. The golden checkpoint restores it to the pre-conversation state (OpenClaw installed, config written, gateway ready, no XMTP state).

### Destroying (rare — broken Sprites only)

- Heartbeat failure after restart attempt fails
- Reconcile finds Sprite gone on Fly's side
- Explicit drain from dashboard/API

Only in these cases do we `sprite.deleteSprite()` + `db.deleteInstance()` and trigger a fresh replacement.

---

## Health Checking

The convos-agent-railway-template provided `/pool/status` returning `{ ready, provisioned }`. With the new design, the pool manager uses OpenClaw's `GET /convos/status` endpoint (being added as part of this work).

**`GET /convos/status` response:**
```json
{ "ready": true, "conversation": null, "streaming": false }               // idle
{ "ready": true, "conversation": { "id": "abc..." }, "streaming": true }  // healthy claimed
{ "ready": true, "conversation": { "id": "abc..." }, "streaming": false } // conversation bound but XMTP stream dead
```

**Readiness probe (`pollProvisioning`):** `GET /convos/status` — any response with `ready: true` means the gateway and convos plugin are loaded. Connection error means still booting.

**Heartbeat:** `GET /convos/status` on idle and claimed instances every 20s. For claimed instances, check `streaming: true` to confirm the XMTP child process is actually running — not just that the conversation variable is set.

---

## Setup Script Changes

`scripts/sprite-setup.sh` — remove the convos-agent-railway-template clone:

```diff
- # --- Clone convos-agent wrapper ---
- rm -rf /opt/convos-agent
- git clone --depth 1 https://github.com/xmtplabs/convos-agent-railway-template /opt/convos-agent
- cd /opt/convos-agent
- npm install --omit=dev > /dev/null 2>&1
- echo "[5/6] Convos-agent wrapper installed"

- # --- Create persistent directories ---
- mkdir -p /opt/convos-agent/.openclaw/workspace
- chmod -R 777 /opt/convos-agent

+ # --- Create workspace directory ---
+ mkdir -p ~/.openclaw/workspace
```

Set `OPENCLAW_GIT_REF` to the convos-cli-migration branch (or its successor once merged to main).

---

## Pool Manager Changes

### `src/sprite.js` — add checkpoint methods

```javascript
export async function createCheckpoint(name, comment) {
  const sprite = client().sprite(name);
  const res = await sprite.createCheckpoint(comment);
  // Consume NDJSON stream, return checkpoint ID from final message
  // ...
}

export async function restoreCheckpoint(name, checkpointId) {
  const sprite = client().sprite(name);
  const res = await sprite.restoreCheckpoint(checkpointId);
  // Consume NDJSON stream, wait for completion
  // ...
}
```

### `src/pool.js` — major changes

**`createInstance()`:**
- Remove: `.env` file writing for the wrapper, `startDetached("node /opt/convos-agent/src/server.js")`
- Add: write `openclaw.json` config via exec, `startDetached("openclaw gateway run --port 8080")`, take golden checkpoint after health check passes

**`pollProvisioning()`:**
- Replace `/pool/status` check with gateway readiness probe

**`provision()`:**
- Remove: `POST /pool/provision` to the wrapper
- Add: write `INSTRUCTIONS.md` via `sprite.exec()`, `POST /convos/conversation` directly to gateway

**`heartbeat()`:**
- Replace `/pool/status` ping with gateway probe

**`killInstance()` → split into `recycleInstance()` and `destroyInstance()`:**
- `recycleInstance()`: restore checkpoint → start gateway → poll → mark idle
- `destroyInstance()`: delete Sprite + delete DB row (for broken instances, drain)

**Shared helper:**
```javascript
async function startGateway(name) {
  await sprite.startDetached(name, "openclaw gateway run --port 8080");
}
```

`ANTHROPIC_API_KEY` is not passed inline — it's written into the OpenClaw config (or a `.env` file) during setup, before the golden checkpoint. This ensures it survives checkpoint restore + gateway restart.

Called in `createInstance()` (after setup) and `recycleInstance()` (after checkpoint restore).

### `src/index.js` — route changes

- Claim route: pass `env` parameter through for `/convos/conversation`
- Dashboard "Kill" button: calls `recycleInstance()` by default
- Dashboard: add separate "Destroy" option for permanent removal
- Remove references to `/pool/provision`, `/pool/status`

### `src/db/migrate.js` — add checkpoint_id column

```sql
ALTER TABLE pool_instances ADD COLUMN checkpoint_id TEXT;
```

### `src/db/pool.js` — store checkpoint_id

Update `insertInstance()` to accept and store `checkpointId`. Add `markIdle()` variant or update to also set checkpoint_id on first idle transition.

---

## Database Schema

```sql
pool_instances (
  id              TEXT PRIMARY KEY,
  sprite_name     TEXT NOT NULL,
  sprite_url      TEXT,
  status          TEXT DEFAULT 'provisioning',  -- provisioning | idle | claimed
  claimed_by      TEXT,
  invite_url      TEXT,
  conversation_id TEXT,
  instructions    TEXT,
  join_url        TEXT,
  checkpoint_id   TEXT,                         -- NEW: golden checkpoint version (e.g., "v0")
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ
)
```

---

## Environment Variables

```diff
  # Pool Manager Config
  PORT=3001
  POOL_API_KEY=your-shared-pool-secret
  POOL_ENVIRONMENT=staging

  # Sprite API
  SPRITE_TOKEN=your-sprite-api-token

  # Env vars to inject into each Sprite instance
  INSTANCE_ANTHROPIC_API_KEY=sk-ant-...
  INSTANCE_XMTP_ENV=dev

  # Pool sizing
  POOL_MIN_IDLE=3
  POOL_MAX_TOTAL=50

  # Heartbeat
  HEARTBEAT_INTERVAL_MS=20000

  # Neon Postgres
  DATABASE_URL=postgresql://...

+ # OpenClaw branch to build from
+ OPENCLAW_GIT_REF=convos-cli-migration
-
- # Wrapper-specific (no longer needed)
- POOL_AUTH_CHOICE=apiKey
- INSTANCE_SETUP_PASSWORD=pool-managed
```

---

## Migration Phases

All work is in `concierge-pool-manager`. Each phase can be deployed to staging independently.

### Phase 1: Setup script + gateway startup

- Update `scripts/sprite-setup.sh`: remove convos-agent-railway-template clone, set OpenClaw branch
- Update `createInstance()`: write `openclaw.json` via exec, start `openclaw gateway run`
- Update `pollProvisioning()`: probe gateway instead of `/pool/status`
- Update `heartbeat()`: same probe change
- **Test:** Create a Sprite, verify gateway starts, verify health check detects readiness

### Phase 2: Direct provisioning

- Rewrite `provision()`: write INSTRUCTIONS.md via exec, `POST /convos/conversation` directly
- Update join flow: `POST /convos/join` directly
- Remove all `/pool/provision` request logic
- **Test:** Claim an instance, verify conversation created, verify agent responds to messages

### Phase 3: Checkpointing

- Add `createCheckpoint()` and `restoreCheckpoint()` to `src/sprite.js`
- Add `checkpoint_id` column via `src/db/migrate.js`
- Update `createInstance()`: take golden checkpoint after gateway confirmed ready
- Before taking the golden checkpoint, verify `~/.convos/` does not exist — XMTP identity files created during `/convos/conversation` must not leak into the snapshot
- **Test:** Create instance, verify checkpoint exists, manually restore and confirm clean state. Verify `~/.convos/` is absent after restore.

### Phase 4: Recycling

- Split `killInstance()` into `recycleInstance()` and `destroyInstance()`
- `recycleInstance()`: restore checkpoint → start gateway → poll → mark idle
- Update dashboard: "Kill" calls recycle, add "Destroy" for permanent removal
- Update `drainPool()`: calls `destroyInstance()` (actual deletion)
- **Test:** Claim instance, recycle it, verify it returns to idle, claim again

---

## Requests for OpenClaw (`convos-cli-migration`)

Feedback for the developer completing the Convos CLI migration. These would make pool manager integration cleaner.

### Health endpoint (`GET /convos/status`) — being implemented

The OpenClaw engineer is adding `GET /convos/status` to the convos-cli-migration branch. Expected response:

```json
// GET /convos/status
{ "ready": true, "conversation": null, "streaming": false }                // gateway up, no conversation
{ "ready": true, "conversation": { "id": "abc..." }, "streaming": true }   // conversation bound, XMTP stream alive
{ "ready": true, "conversation": { "id": "abc..." }, "streaming": false }  // conversation bound, XMTP stream dead
```

The `streaming` field is critical for heartbeat — a 409 from `/convos/conversation` only confirms the instance variable is set, not that the XMTP child process is actually running and processing messages.

Used by the pool manager for: `pollProvisioning()` (detect when gateway is ready), `heartbeat()` (detect when instances are alive and XMTP stream is healthy), and distinguishing idle vs claimed instances.

### Document INSTRUCTIONS.md in the pool manager integration doc

The integration doc covers the Convos plugin lifecycle but doesn't mention how to provide instructions to the agent. Pool managers need to know:

- Write `INSTRUCTIONS.md` to the workspace directory (`~/.openclaw/workspace/` by default)
- OpenClaw loads it at agent startup as operator-provided directives
- It's an OpenClaw core feature (not Convos-specific), documented in `src/agents/workspace.ts` and `src/agents/system-prompt.ts`

This is the primary mechanism for making a pool-provisioned instance behave differently from a generic one.

---

## Future: Sprite Cloning

When Fly.io ships Sprite forking/cloning:

1. Build ONE golden Sprite with OpenClaw installed + configured
2. On demand: clone from the golden Sprite (seconds, not minutes)
3. Start gateway → take per-instance checkpoint → mark idle
4. Recycling still works the same (restore per-instance checkpoint)

This eliminates the per-Sprite build entirely. The setup script goes away. The pool replenishes in seconds instead of minutes. The architecture otherwise stays the same.
