# Sprite Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate convos-agent-pool-manager from Railway deployments to Fly.io Sprite microVMs.

**Architecture:** Replace Railway GraphQL API with Sprite REST API + exec. Keep the warm pool model — idle instances stay awake via heartbeat (20s ping). Claiming remains instant (server already running). Background provisioning creates Sprites, runs a setup script via exec, starts the server, and polls until ready.

**Tech Stack:** Node.js 22+, Express 5, `@fly/sprites` SDK, Neon Postgres, Sprite REST API (`https://api.sprites.dev/v1/`)

---

### Task 1: Install Sprite SDK

**Files:**
- Modify: `package.json`

**Step 1: Install the SDK**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && npm install @fly/sprites`
Expected: `@fly/sprites` added to `dependencies` in `package.json`

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @fly/sprites SDK dependency"
```

---

### Task 2: Create `src/sprite.js`

**Files:**
- Create: `src/sprite.js`
- Reference: `src/railway.js` (being replaced)

**Step 1: Write the Sprite client module**

```javascript
import { SpritesClient } from "@fly/sprites";

let _client;
function client() {
  if (!_client) {
    const token = process.env.SPRITE_TOKEN;
    if (!token) throw new Error("SPRITE_TOKEN not set");
    _client = new SpritesClient(token);
  }
  return _client;
}

// Create a new sprite and set its URL to public.
// Returns { name, url } where url is the public HTTPS URL.
export async function createSprite(name) {
  console.log(`[sprite] Creating sprite: ${name}`);
  const result = await client().createSprite(name);
  // Make the sprite URL publicly accessible (no sprite auth on HTTP)
  const sprite = client().sprite(name);
  await fetch(`https://api.sprites.dev/v1/sprites/${name}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${process.env.SPRITE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url_settings: { auth: "public" } }),
  });
  console.log(`[sprite]   URL: ${result.url}`);
  return { name: result.name, url: result.url };
}

// Delete a sprite by name. No-op if already gone.
export async function deleteSprite(name) {
  console.log(`[sprite] Deleting sprite: ${name}`);
  try {
    await client().deleteSprite(name);
  } catch (err) {
    if (err.message?.includes("404")) return;
    throw err;
  }
}

// Check if a sprite exists. Returns { name, status } or null.
// Status is one of: "cold", "warm", "running"
export async function getSpriteInfo(name) {
  try {
    const res = await fetch(`https://api.sprites.dev/v1/sprites/${name}`, {
      headers: { Authorization: `Bearer ${process.env.SPRITE_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { name: data.name, status: data.status };
  } catch {
    return null;
  }
}

// List all sprites whose names start with a given prefix.
// Returns array of { name, updated_at }.
export async function listSprites(prefix = "convos-agent-") {
  const sprites = await client().listAllSprites();
  return sprites.filter((s) => s.name.startsWith(prefix));
}

// Execute a command inside a sprite. Waits for completion.
// Returns { stdout, stderr, exitCode }.
export async function exec(name, command) {
  console.log(`[sprite] exec on ${name}: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`);
  const sprite = client().sprite(name);
  const result = await sprite.exec(command);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

// Start a long-running process inside a sprite (detached session).
// Returns the session ID so we can check on it later.
export async function startDetached(name, command) {
  console.log(`[sprite] Starting detached on ${name}: ${command.slice(0, 80)}`);
  const sprite = client().sprite(name);
  const session = await sprite.createSession();
  const cmd = sprite.spawn("bash", ["-c", command], {
    detachable: true,
    sessionId: session.id,
  });
  // Don't await — let it run in background
  cmd.stdout.on("data", () => {});
  cmd.stderr.on("data", () => {});
  return session.id;
}
```

**Step 2: Verify the module loads**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && node -e "import('./src/sprite.js').then(() => console.log('OK'))"`
Expected: `OK` (no syntax errors)

**Step 3: Commit**

```bash
git add src/sprite.js
git commit -m "feat: add Sprite API client (replaces railway.js)"
```

---

### Task 3: Create setup script for Sprites

**Files:**
- Create: `scripts/sprite-setup.sh`

**Step 1: Write the setup script**

This script runs inside a fresh Sprite via exec. It installs OpenClaw and the convos-agent wrapper, mirroring what the Dockerfile does.

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Sprite setup: convos-agent ==="

# --- Build tools (most already present on Sprite Ubuntu image) ---
apt-get update -qq && apt-get install -y -qq git ca-certificates curl python3 make g++ > /dev/null 2>&1
echo "[1/6] Build tools ready"

# --- Install Bun (needed for OpenClaw build) ---
if ! command -v bun &> /dev/null; then
  curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1
  export PATH="$HOME/.bun/bin:$PATH"
fi
echo "[2/6] Bun ready"

# --- Enable corepack for pnpm ---
corepack enable 2>/dev/null || true

# --- Clone and build OpenClaw ---
OPENCLAW_BRANCH="${OPENCLAW_GIT_REF:-main}"
rm -rf /opt/openclaw-src
git clone --depth 1 --branch "$OPENCLAW_BRANCH" https://github.com/xmtplabs/openclaw /opt/openclaw-src
cd /opt/openclaw-src

# Patch extension version constraints
find ./extensions -name 'package.json' -type f | while read f; do
  sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"
  sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"
done

pnpm install --no-frozen-lockfile > /dev/null 2>&1
pnpm build > /dev/null 2>&1
pnpm ui:install > /dev/null 2>&1 && pnpm ui:build > /dev/null 2>&1
echo "[3/6] OpenClaw built"

# --- Create openclaw CLI wrapper ---
mkdir -p /usr/local/bin
cat > /usr/local/bin/openclaw << 'WRAPPER'
#!/usr/bin/env bash
exec node /opt/openclaw-src/dist/entry.js "$@"
WRAPPER
chmod +x /usr/local/bin/openclaw
echo "[4/6] OpenClaw CLI ready"

# --- Clone convos-agent wrapper ---
rm -rf /opt/convos-agent
git clone --depth 1 https://github.com/xmtplabs/convos-agent-railway-template /opt/convos-agent
cd /opt/convos-agent
npm install --omit=dev > /dev/null 2>&1
echo "[5/6] Convos-agent wrapper installed"

# --- Create persistent directories ---
mkdir -p /root/.openclaw /root/.openclaw/workspace

echo "[6/6] Setup complete"
```

**Step 2: Commit**

```bash
git add scripts/sprite-setup.sh
git commit -m "feat: add sprite setup script for fresh Sprite provisioning"
```

---

### Task 4: Database migration — rename Railway columns to Sprite columns

**Files:**
- Modify: `src/db/migrate.js`

**Step 1: Add column rename migration**

Add the following migration block after the existing `join_url` migration (after line 61 in `src/db/migrate.js`):

```javascript
  // Rename Railway columns to Sprite columns
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'railway_service_id'
      ) THEN
        ALTER TABLE pool_instances RENAME COLUMN railway_service_id TO sprite_name;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'railway_url'
      ) THEN
        ALTER TABLE pool_instances RENAME COLUMN railway_url TO sprite_url;
      END IF;
    END $$
  `;
```

Also update the initial `CREATE TABLE` to use the new column names for fresh installs (change `railway_service_id` to `sprite_name` and `railway_url` to `sprite_url`).

**Step 2: Run the migration locally**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && node --env-file=.env src/db/migrate.js`
Expected: `Migration complete.`

**Step 3: Commit**

```bash
git add src/db/migrate.js
git commit -m "feat: migrate DB columns from railway_* to sprite_*"
```

---

### Task 5: Update `src/db/pool.js` — use new column names

**Files:**
- Modify: `src/db/pool.js`

**Step 1: Rename all column references**

Replace all occurrences:
- `railway_service_id` → `sprite_name`
- `railway_url` → `sprite_url`
- `railwayServiceId` → `spriteName` (JS property names)
- `railwayUrl` → `spriteUrl` (JS property names)

Specifically:

`insertInstance` (line 3): Change parameter destructuring from `{ id, railwayServiceId, railwayUrl }` to `{ id, spriteName, spriteUrl }`. Change SQL column names.

`markIdle` (line 10): Change parameter from `railwayUrl` to `spriteUrl`. Change SQL column name.

**Step 2: Verify syntax**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && node -e "import('./src/db/pool.js').then(() => console.log('OK'))"`
Expected: `OK`

**Step 3: Commit**

```bash
git add src/db/pool.js
git commit -m "refactor: rename railway_* to sprite_* in DB layer"
```

---

### Task 6: Update `src/pool.js` — replace Railway with Sprite calls

**Files:**
- Modify: `src/pool.js`

This is the biggest change. Replace the Railway import and all Railway API calls with Sprite equivalents.

**Step 1: Replace import and env var helper**

Change line 3 from:
```javascript
import * as railway from "./railway.js";
```
to:
```javascript
import * as sprite from "./sprite.js";
```

Replace `instanceEnvVars()` (lines 12-22) with a function that returns the env file content as a string (since we write a .env file via exec rather than passing vars to an API):

```javascript
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
```

**Step 2: Rewrite `createInstance()`**

Replace the existing function (lines 25-46) with:

```javascript
export async function createInstance() {
  const id = nanoid(12);
  const name = `convos-agent-${id}`;

  console.log(`[pool] Creating instance ${name}...`);

  // 1. Create Sprite
  const { url } = await sprite.createSprite(name);
  console.log(`[pool]   Sprite created: ${url}`);

  // 2. Run setup script inside the Sprite
  const setupScript = (await import("fs")).readFileSync(
    new URL("../scripts/sprite-setup.sh", import.meta.url), "utf-8"
  );
  const envVars = instanceEnvString();

  await sprite.exec(name, setupScript);
  console.log(`[pool]   Setup script complete`);

  // 3. Write .env file for the convos-agent wrapper
  await sprite.exec(name, `cat > /opt/convos-agent/.env << 'ENVEOF'\n${envVars}\nENVEOF`);
  console.log(`[pool]   Environment written`);

  // 4. Start the server (detached so it keeps running)
  await sprite.startDetached(name, "cd /opt/convos-agent && node src/server.js");
  console.log(`[pool]   Server starting`);

  // 5. Insert into DB as 'provisioning'
  await db.insertInstance({ id, spriteName: name, spriteUrl: url });
  console.log(`[pool]   Registered as provisioning`);

  return { id, name, url };
}
```

**Step 3: Update `pollProvisioning()`**

Replace `inst.railway_url` references (lines 54-55) with `inst.sprite_url`:

```javascript
if (!inst.sprite_url) continue;
// ...
const res = await fetch(`${inst.sprite_url}/pool/status`, {
```

In the cleanup path (line 71), change:
```javascript
await db.markIdle(inst.id, inst.sprite_url);
```

**Step 4: Rewrite `cleanupInstance()`**

Replace Railway service check + delete (lines 85-100) with Sprite equivalent:

```javascript
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
```

**Step 5: Rewrite `reconcile()`**

Replace individual Railway service checks with a bulk Sprite list call:

```javascript
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
```

**Step 6: Update `provision()` — remove Railway rename**

In the `provision()` function (lines 161-217):
- Replace `inst.railway_url` with `inst.sprite_url` (lines 172-173)
- Remove the `railway.renameService()` call entirely (lines 198-203) — Sprite names are immutable, and the dashboard already shows `claimed_by` from the database.

**Step 7: Update `drainPool()`**

Replace `railway.deleteService(inst.railway_service_id)` (line 226) with:
```javascript
await sprite.deleteSprite(inst.sprite_name);
```

**Step 8: Update `killInstance()`**

Replace `railway.deleteService(inst.railway_service_id)` (line 246) with:
```javascript
await sprite.deleteSprite(inst.sprite_name);
```

**Step 9: Verify syntax**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && node -e "import('./src/pool.js').then(() => console.log('OK'))"`
Expected: `OK`

**Step 10: Commit**

```bash
git add src/pool.js
git commit -m "feat: replace Railway API calls with Sprite API in pool logic"
```

---

### Task 7: Add heartbeat loop to keep instances awake

**Files:**
- Modify: `src/pool.js`
- Modify: `src/index.js`

**Step 1: Add heartbeat function to `src/pool.js`**

Add at the end of `src/pool.js`:

```javascript
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

        // If it's idle, just clean up. If claimed, try to restart server first.
        if (inst.status === "idle") {
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
```

**Step 2: Add heartbeat interval to `src/index.js`**

After the existing tick interval (line 1070), add:

```javascript
// Heartbeat — keep Sprites awake and monitor health
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "20000", 10);
setInterval(() => {
  pool.heartbeat().catch((err) => console.error("[heartbeat] Error:", err));
}, HEARTBEAT_INTERVAL);
```

**Step 3: Commit**

```bash
git add src/pool.js src/index.js
git commit -m "feat: add heartbeat loop to keep Sprites awake (20s interval)"
```

---

### Task 8: Update `src/index.js` — routes and dashboard

**Files:**
- Modify: `src/index.js`

**Step 1: Update the setup redirect route**

Change `instance.railway_url` to `instance.sprite_url` on line 1009:
```javascript
res.redirect(`${instance.sprite_url}/setup`);
```

**Step 2: Update dashboard kill confirmation text**

On line 833, change `'This will delete the Railway service permanently.'` to:
```javascript
'This will delete the Sprite permanently.'
```

**Step 3: Verify syntax**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && node -c src/index.js`
Expected: No output (success)

**Step 4: Commit**

```bash
git add src/index.js
git commit -m "refactor: update routes and dashboard text for Sprite migration"
```

---

### Task 9: Update `.env.example`

**Files:**
- Modify: `.env.example`

**Step 1: Replace Railway env vars with Sprite env vars**

Replace the entire file with:

```
# Pool Manager Config
PORT=3001
POOL_API_KEY=your-shared-pool-secret          # different per environment
POOL_ENVIRONMENT=staging                       # "staging" or "production"

# Sprite API
SPRITE_TOKEN=your-sprite-api-token

# Env vars to inject into each Sprite instance
INSTANCE_ANTHROPIC_API_KEY=sk-ant-...
INSTANCE_XMTP_ENV=dev                          # "dev" for staging, "production" for production

# Pool sizing
POOL_MIN_IDLE=3
POOL_MAX_TOTAL=50                              # Sprites have no project-level cap

# Heartbeat (keeps Sprites awake)
HEARTBEAT_INTERVAL_MS=20000                    # 20 seconds

# Neon Postgres
DATABASE_URL=postgresql://...                  # different per environment
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: update .env.example for Sprite config"
```

---

### Task 10: Modify convos-agent template — conditional XMTP pre-warm

**Files:**
- Modify: `/Users/saulxmtp/Developer/clawdbot-railway-template/src/server.js` (lines ~1996-2031)

This is a change in a separate repo (`convos-agent-railway-template`), not the pool manager.

**Step 1: Make pre-warm conditional**

Find the XMTP pre-warm block in the pool mode startup sequence. It looks approximately like:

```javascript
// Pre-warm XMTP identity
try {
  // ... multiple retries calling /convos/setup ...
} catch (err) {
  console.warn("Pre-warm failed:", err.message);
}
```

Wrap it in a conditional that checks if identity files already exist:

```javascript
import fs from "fs";
import path from "path";

// Skip pre-warm if XMTP identity already cached on disk
const identityPath = path.join(STATE_DIR, "auth.json");
if (fs.existsSync(identityPath)) {
  console.log("[pool] XMTP identity already cached, skipping pre-warm");
} else {
  // Pre-warm XMTP identity (existing code)
  try {
    // ... existing retry logic ...
  } catch (err) {
    console.warn("Pre-warm failed:", err.message);
  }
}
```

**Step 2: Verify the server still starts in pool mode**

Run: `cd /Users/saulxmtp/Developer/clawdbot-railway-template && node -c src/server.js`
Expected: No output (success)

**Step 3: Commit (in the template repo)**

```bash
cd /Users/saulxmtp/Developer/clawdbot-railway-template
git add src/server.js
git commit -m "perf: skip XMTP pre-warm when identity already cached (faster Sprite restarts)"
```

---

### Task 11: Delete `src/railway.js`

**Files:**
- Delete: `src/railway.js`

**Step 1: Remove the old Railway client**

Run: `rm /Users/saulxmtp/Developer/concierge-pool-manager/src/railway.js`

**Step 2: Verify nothing imports it**

Run: `grep -r "railway" /Users/saulxmtp/Developer/concierge-pool-manager/src/`
Expected: No results (all references already updated in previous tasks)

**Step 3: Commit**

```bash
git add -A src/railway.js
git commit -m "chore: remove railway.js (replaced by sprite.js)"
```

---

### Task 12: End-to-end smoke test

**Step 1: Set up `.env` with Sprite credentials**

Copy `.env.example` to `.env` and fill in:
- `SPRITE_TOKEN` — from Sprites dashboard
- `INSTANCE_ANTHROPIC_API_KEY` — existing Anthropic key
- `DATABASE_URL` — existing Neon connection string (staging)

**Step 2: Run the database migration**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && node --env-file=.env src/db/migrate.js`
Expected: `Migration complete.`

**Step 3: Start the pool manager**

Run: `cd /Users/saulxmtp/Developer/concierge-pool-manager && node --env-file=.env src/index.js`
Expected: `Pool manager listening on :3001`

**Step 4: Verify a single instance provisions**

In another terminal:
```bash
curl -s -X POST http://localhost:3001/api/pool/replenish \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 1}'
```
Expected: `{"ok":true,"created":1,...}`

**Step 5: Watch logs until instance goes idle**

Watch the pool manager logs for:
```
[pool] <id> is now idle
```

This confirms: Sprite created, setup script ran, server started, `/pool/status` returned `ready: true`.

**Step 6: Test claiming**

```bash
curl -s -X POST http://localhost:3001/api/pool/claim \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "test-agent", "instructions": "You are a test agent."}'
```
Expected: JSON response with `inviteUrl`, `conversationId`, `instanceId`

**Step 7: Verify heartbeat is running**

Watch logs for:
```
[heartbeat] ...
```
messages appearing every 20 seconds, pinging the claimed instance.

**Step 8: Test drain**

```bash
curl -s -X POST http://localhost:3001/api/pool/drain \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 1}'
```

Then verify the Sprite was deleted:
```bash
curl -s -H "Authorization: Bearer $SPRITE_TOKEN" \
  "https://api.sprites.dev/v1/sprites?prefix=convos-agent-"
```
Expected: Empty or reduced sprite list.
