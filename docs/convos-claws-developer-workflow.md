# Convos Claws: Architecture & Developer Workflow

## What Are Convos Claws?

Convos Claws are AI agent instances running [OpenClaw](https://github.com/xmtplabs/openclaw) — a personal AI assistant framework — deployed as Fly.io Sprites and made available to testers on-demand via a pool manager.

Each "Claw" is a fully functional AI agent with its own XMTP identity, reachable through the Convos messaging app. Testers claim a pre-warmed instance, give it instructions (a system prompt), and start chatting.

---

## The Two Repos

```
┌─────────────────────────────────┐
│  xmtplabs/openclaw              │  The bot brain
│  (convos extension + gateway)   │
└──────────────┬──────────────────┘
               │ cloned + built inside each Sprite
               ▼
┌─────────────────────────────────┐
│  xmtplabs/convos-agent-         │  Orchestrator
│  pool-manager                   │  (creates, monitors, assigns Sprites)
└─────────────────────────────────┘
```

### 1. `xmtplabs/openclaw` — The Bot

A multi-channel AI assistant framework. The Convos extension (`extensions/convos/`) gives it an XMTP identity and lets it participate in Convos group chats.

**HTTP routes used by the pool manager** (served by `openclaw gateway run`):
- `GET /convos/status` — Health check: `{ ready, conversation, streaming }`
- `POST /convos/conversation` — Create new XMTP identity + group conversation
- `POST /convos/join` — Join an existing group via invite URL

The pool manager calls these routes directly — no intermediary wrapper.

### 2. `xmtplabs/convos-agent-pool-manager` — The Orchestrator

An Express server + Neon Postgres database that maintains a pool of pre-warmed Sprites running OpenClaw, ready for instant claim.

**Key source files:**

| Path | Purpose |
|------|---------|
| `src/index.js` | Express server, dashboard HTML, all API routes |
| `src/pool.js` | Core pool logic (create, claim, recycle, replenish, drain, reconcile) |
| `src/sprite.js` | Fly.io Sprites API wrapper (create, exec, checkpoint, restore) |
| `scripts/sprite-setup.sh` | Setup script run inside each new Sprite |
| `src/db/pool.js` | Database queries |
| `src/db/migrate.js` | Schema migration |
| `src/log.js` | Structured logging with levels |

---

## Sprite Lifecycle

### Creating a new Sprite (~5 min, infrequent)

1. `sprite.createSprite(name)` — fresh Sprite from base Ubuntu image
2. Run `scripts/sprite-setup.sh` via `sprite.exec()` — installs build tools, Bun, pnpm, clones and builds OpenClaw
3. Write `~/.openclaw/openclaw.json` (API config, convos plugin, gateway auth) and `~/.openclaw/.env` (Anthropic API key) via `sprite.exec()`
4. Start `openclaw gateway run --port 8080` via `sprite.startDetached()`
5. Poll `GET /convos/status` until `{ ready: true }` (~30-60s)
6. Verify `~/.convos/` does not exist (no XMTP state leaked before checkpoint)
7. `sprite.createCheckpoint("golden")` — snapshot the clean state
8. Store checkpoint ID in DB, mark idle

### Claiming (instant, user-facing)

1. `db.claimOne(agentName)` — atomically pick an idle instance
2. Write `INSTRUCTIONS.md` to `~/.openclaw/workspace/` via `sprite.exec()`
3. `POST /convos/conversation` on the gateway (or `/convos/join` for join mode)
4. Update DB with conversationId, inviteUrl, instructions
5. Return invite URL to caller
6. Start 1-for-1 replacement in background

### Recycling (~15s, after conversation ends)

1. `sprite.restoreCheckpoint(checkpointId)` — filesystem reset, processes killed
2. Start `openclaw gateway run --port 8080` via `sprite.startDetached()`
3. Poll gateway until it responds with `{ ready: true }`
4. Mark idle in DB — ready for the next claim

The golden checkpoint restores the Sprite to its pre-conversation state: OpenClaw installed, config written, gateway running, no XMTP identity.

### Destroying (rare)

Only happens when:
- Heartbeat detects an unreachable instance after restart attempts fail
- Reconcile finds the Sprite gone on Fly's side
- Explicit drain from the dashboard or API

Calls `sprite.deleteSprite()` + `db.deleteInstance()` and triggers a fresh replacement.

```
provisioning ──→ idle ──→ claimed ──→ recycled ──→ idle
 (building)     (ready)   (in use)   (checkpoint   (ready again)
                                      restored)
```

---

## Background Loops

| Loop | Interval | What it does |
|------|----------|--------------|
| **Tick** | 30s | Poll provisioning instances for readiness, replenish pool to `POOL_MIN_IDLE` |
| **Heartbeat** | 20s | Ping idle + claimed instances via `/convos/status`, clean up unreachable ones |
| **Reconcile** | 5min | Verify DB records against Sprites API, purge orphaned entries |

---

## Two Environments

Both environments use the **same Railway project** for the pool manager, with separate Railway environments. Agents run on Fly.io Sprites (not Railway).

|  | Staging | Production |
|--|---------|------------|
| **Pool manager URL** | `convos-agents-dev.up.railway.app` | `convos-agents.up.railway.app` |
| **XMTP network** | `dev` (default) | `production` (default) |
| **Convos app domain** | `dev.convos.org` | `popup.convos.org` |
| **OpenClaw branch** | `staging` (default) | `main` (default) |
| **DB (Neon)** | `staging` branch | `production` branch |
| **Badge color** | Yellow | Red |

Each environment has its own `POOL_API_KEY`, `DATABASE_URL`, and `RAILWAY_ENVIRONMENT_ID`. They share the same `RAILWAY_PROJECT_ID` and `RAILWAY_API_TOKEN`.

---

## Developer Workflows

### A. Changing the bot behavior (openclaw)

The most common change — modifying how the agent talks, handles messages, joins groups, etc.

```
1. Edit code in xmtplabs/openclaw (extensions/convos/ usually)
2. Push to the staging branch (staging pool builds from staging by default)
3. Drain the staging pool:
     npm run drain:all
     — or —
     POST /api/pool/drain  {"count": N}
4. Wait for new instances to spin up (they'll clone the latest openclaw code)
5. Verify via the dashboard or curl <sprite-url>/convos/status
6. When satisfied, merge to main and drain production
   (production builds from main by default)
```

No Docker cache bust needed — Sprites clone OpenClaw fresh each time they're created.

`POOL_ENVIRONMENT` determines the default branch: `production` → `main`, anything else → `staging`. Override with `OPENCLAW_GIT_REF` if needed.

### B. Changing the pool manager

Changes to instance lifecycle, API routes, dashboard UI, etc.

```
1. Edit code in convos-agent-pool-manager
2. Push to main (or feature branch → PR → main)
3. Railway auto-deploys the pool manager service
4. Test via the dashboard
```

The pool manager runs on Railway. Pushing triggers an automatic redeploy. Existing Sprites are unaffected — only newly created instances pick up pool manager logic changes.

### C. Full stack change (both repos)

Example: adding a new field to the provision request.

```
1. openclaw: Add handler for the new field in the convos extension
   → push to the target branch

2. pool-manager: Add the new field to /api/pool/claim request handling
   → push to main

3. Drain the pool so new Sprites pick up the openclaw change:
     npm run drain:all

4. Test end-to-end on staging

5. Promote to production
```

---

## API Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /` | None | Web dashboard for launching and managing agents |
| `GET /healthz` | None | Health check |
| `GET /version` | None | Build version and environment |
| `GET /api/pool/counts` | None | Idle/provisioning/claimed counts |
| `GET /api/pool/agents` | None | List claimed agents |
| `POST /api/pool/claim` | Bearer | Claim idle instance, provision with instructions |
| `DELETE /api/pool/instances` | Bearer | List claimed instance IDs (bulk operations) |
| `DELETE /api/pool/instances/:id` | Bearer | Recycle instance (restore checkpoint → idle) |
| `DELETE /api/pool/instances/:id/destroy` | Bearer | Permanently destroy instance |
| `POST /api/pool/replenish` | Bearer | Manually create N new instances |
| `POST /api/pool/drain` | Bearer | Destroy N idle instances |
| `POST /api/pool/reconcile` | Bearer | Sync DB with Sprites API |
| `GET /api/pool/status` | Bearer | Full pool status dump |
| `GET /api/pool/debug/:id` | Bearer | Probe a Sprite for diagnostics |

---

## Useful Commands

```bash
# Pool status (no auth)
curl https://convos-agents-dev.up.railway.app/api/pool/counts

# Full pool status
curl -H "Authorization: Bearer $POOL_API_KEY" \
  https://convos-agents-dev.up.railway.app/api/pool/status

# Drain all idle instances (force rebuild with new openclaw code)
npm run drain:all

# Drain N idle instances via API
curl -X POST https://convos-agents-dev.up.railway.app/api/pool/drain \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 10}'

# Claim an instance
curl -X POST https://convos-agents-dev.up.railway.app/api/pool/claim \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentName": "test-bot", "instructions": "You are a helpful assistant."}'

# Recycle a claimed instance back to idle
curl -X DELETE https://convos-agents-dev.up.railway.app/api/pool/instances/<id> \
  -H "Authorization: Bearer $POOL_API_KEY"

# Check pool manager version
curl https://convos-agents-dev.up.railway.app/version

# Set a Railway env var
railway variable set KEY=VAL -e staging -s convos-agent-pool-manager
```
