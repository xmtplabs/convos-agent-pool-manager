# Convos Claws: Code Logistics & Developer Workflow

## What Are Convos Claws?

Convos Claws are AI agent instances running a fork of [OpenClaw](https://github.com/xmtplabs/openclaw) — a personal AI assistant framework — deployed as containerized Railway services and made available to testers on-demand via a pool manager.

Each "Claw" is a fully functional AI agent with its own XMTP identity, reachable through the Convos messaging app. Testers claim a pre-warmed instance, give it instructions (a system prompt), and start chatting.

---

## The Three Repos

```
┌─────────────────────────────────┐
│  xmtplabs/openclaw              │  The bot brain
│  (convos extension + agent)     │
└──────────────┬──────────────────┘
               │ cloned at Docker build time
               ▼
┌─────────────────────────────────┐
│  xmtplabs/convos-agent-         │  Docker wrapper for Railway
│  railway-template               │  (pool-mode, setup wizard, proxy)
│                                 │
└──────────────┬──────────────────┘
               │ deployed as Railway services
               ▼
┌─────────────────────────────────┐
│  xmtplabs/convos-agent-         │  Orchestrator
│  pool-manager                   │  (creates, monitors, assigns instances)
└─────────────────────────────────┘
```

### 1. `xmtplabs/openclaw` — The Bot

**What it is:** A multi-channel AI assistant framework (WhatsApp, Telegram, Discord, etc.). The xmtplabs fork adds a **Convos extension** (`extensions/convos/`) that gives it an XMTP identity and lets it participate in Convos group chats.

**Key paths:**
| Path | Purpose |
|------|---------|
| `extensions/convos/index.ts` | Plugin entry: HTTP routes for setup, join, send, rename |
| `extensions/convos/src/channel.ts` | Message handling, greeting logic |
| `extensions/convos/src/sdk-client.ts` | XMTP/Convos SDK wrapper |
| `extensions/convos/src/setup.ts` | Identity creation flow |
| `extensions/convos/src/config-schema.ts` | Config shape (privateKey, env, policies) |

**HTTP routes exposed by the Convos extension** (called by the railway template):
- `POST /convos/setup` — Create XMTP identity
- `GET /convos/setup/status` — Poll join status
- `POST /convos/setup/complete` — Persist config
- `POST /convos/conversation` — Create new group (fast path)
- `POST /convos/join` — Join existing group via invite URL
- `POST /convos/rename` — Rename conversation + set agent profile
- `POST /convos/conversation/send` — Send a message

### 2. `xmtplabs/convos-agent-railway-template` — The Container

**What it is:** A Dockerfile + Node.js wrapper (`src/server.js`, ~2000 lines) that:
1. Builds openclaw from source (shallow clone at Docker build time)
2. Runs it as an internal gateway on `127.0.0.1:18789`
3. Reverse-proxies all traffic through an Express server on port 8080
4. Adds **pool mode** endpoints for automated provisioning
5. Adds an interactive **setup wizard** for manual configuration

**Key paths:**
| Path | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build: clone openclaw → build → wrap |
| `src/server.js` | Express wrapper: proxy, pool endpoints, setup UI |
| `railway.toml` | Railway config (healthcheck, restart policy) |

**Dockerfile build args that matter:**
```dockerfile
ARG OPENCLAW_CACHE_BUST=33    # Bump to force fresh openclaw clone
ARG OPENCLAW_GIT_REF=main     # Branch of openclaw to build from
ARG OPENCLAW_GIT_REPO=https://github.com/xmtplabs/openclaw.git
```

**Pool-mode endpoints** (called by the pool manager):
- `GET /pool/status` — Returns `{ ready, provisioned }` (used for health polling)
- `POST /pool/provision` — Accepts `{ instructions, name?, joinUrl? }`, provisions the agent

**Pool-mode boot sequence:**
1. Writes base openclaw config
2. Starts internal gateway
3. Creates XMTP identity via `POST /convos/setup`
4. Completes setup, persists private key
5. Sets `poolReady = true`, waits for provision call

### 3. `xmtplabs/convos-agent-pool-manager` — The Orchestrator

**What it is:** An Express server + Neon Postgres database that maintains a pool of pre-warmed Railway agent instances, ready for instant claim.

**Key paths:**
| Path | Purpose |
|------|---------|
| `src/index.js` | Express server, dashboard HTML, all API routes |
| `src/pool.js` | Core pool logic (create, claim, replenish, drain, reconcile) |
| `src/railway.js` | Railway GraphQL API client |
| `src/db/pool.js` | Database queries |
| `src/db/migrate.js` | Schema migration |

**Instance lifecycle:**
```
provisioning ──→ idle ──→ claimed
(deploying)      (ready)   (in use forever)
```

**Background loops:**
- Every 30s: poll provisioning instances, replenish if below `POOL_MIN_IDLE`
- Every 5min: reconcile DB against Railway (clean up orphans)

**API endpoints:**
| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /` | None | Web dashboard |
| `GET /api/pool/counts` | None | Idle/provisioning/claimed counts |
| `POST /api/pool/claim` | Bearer | Claim idle instance, provision with instructions |
| `POST /api/pool/replenish` | Bearer | Manually add N instances |
| `POST /api/pool/drain` | Bearer | Delete N idle instances |
| `POST /api/pool/reconcile` | Bearer | Sync DB with Railway |
| `GET /api/pool/status` | Bearer | Full pool status dump |

---

## Two Environments

Both environments live in the **same Railway project**, in separate Railway environments.

|  | Staging | Production |
|--|---------|------------|
| **Pool manager URL** | `convos-agents-dev.up.railway.app` | `convos-agents.up.railway.app` |
| **XMTP network** | `dev` | `production` |
| **Convos app domain** | `dev.convos.org` | `popup.convos.org` |
| **Template branch** | `staging` | `main` |
| **Openclaw branch** | `staging` | `main` |
| **DB (Neon)** | `staging` branch | `production` branch |
| **Badge color** | Yellow | Red |

Each environment has its own `POOL_API_KEY`, `DATABASE_URL`, and `RAILWAY_ENVIRONMENT_ID`. They share the same `RAILWAY_PROJECT_ID` and `RAILWAY_API_TOKEN`.

---

## Developer Workflows

### A. Changing the bot behavior (openclaw)

This is the most common change — modifying how the agent talks, handles messages, joins groups, etc.

```
1. Edit code in xmtplabs/openclaw (extensions/convos/ usually)
2. Push to the staging branch
3. In convos-agent-railway-template (staging branch):
   - Bump OPENCLAW_CACHE_BUST in Dockerfile (e.g., 34 → 35)
   - Push to staging
4. Railway rebuilds the Docker image (picks up new openclaw code)
5. Drain the staging pool:
     POST /api/pool/drain  {"count": N}
6. Wait for new instances to spin up with updated code
7. Verify: curl <instance-url>/version  (check openclaw commit hash)
8. When satisfied, repeat steps 2-7 for production (main branch)
```

**Why the cache bust?** Docker layer caching means `git clone` won't re-run unless the layer is invalidated. Bumping `OPENCLAW_CACHE_BUST` is a one-line change that forces a fresh clone.

### B. Changing the wrapper (railway template)

Changes to pool-mode endpoints, setup wizard, proxy behavior, environment variables, etc.

```
1. Edit src/server.js in convos-agent-railway-template
2. Push to staging
3. Railway auto-rebuilds
4. Drain staging pool + wait for new instances
5. When satisfied, merge/push to main for production
```

No cache bust needed — wrapper changes are in a later Docker stage.

### C. Changing the pool manager

Changes to how instances are created, claimed, monitored, or the dashboard UI.

```
1. Edit code in convos-agent-pool-manager
2. Push to staging (or feature branch → PR → staging)
3. Railway auto-deploys the pool manager service
4. Test via staging dashboard
5. When satisfied, merge to main for production
```

### D. Full stack change (all three repos)

Example: adding a new field to the provision request.

```
1. openclaw: Add handler for the new field in convos extension
   → push to staging

2. railway-template: Pass the new field through /pool/provision → openclaw
   → bump OPENCLAW_CACHE_BUST, push to staging

3. pool-manager: Add the new field to /api/pool/claim request handling + DB
   → push to staging

4. Drain staging pool, wait for rebuild, test end-to-end

5. Promote each repo to production (main branch) in reverse order:
   pool-manager → railway-template (with cache bust) → openclaw
   (so production instances can handle the new field before it's sent)
```

---

## Checking Instance Versions

Every deployed instance bakes version info into the Docker image at build time.

```bash
curl https://<instance-url>/version
```

Returns:
```json
{
  "wrapper": "abc1234",      // convos-agent-railway-template commit
  "openclaw": "def5678",     // openclaw commit
  "builtAt": "2026-02-08T..."
}
```

---

## Useful Commands

```bash
# Pool status
curl https://convos-agents-dev.up.railway.app/api/pool/counts

# Drain pool (force rebuild)
curl -X POST https://convos-agents-dev.up.railway.app/api/pool/drain \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 10}'

# Claim an instance
curl -X POST https://convos-agents-dev.up.railway.app/api/pool/claim \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "test-bot", "instructions": "You are a helpful assistant."}'

# Check instance version
curl https://convos-agent-test-bot.up.railway.app/version

# Set Railway env var
railway variable set KEY=VAL -e staging -s convos-agent-pool-manager

# View instance logs
railway logs -s "convos-agent-<name>"
```

---

## Current Branch State (as of 2026-02-10)

| Repo | staging | main | Notes |
|------|---------|------|-------|
| **openclaw** | In sync with main | Same as staging | Both have group ID polling fix |
| **railway-template** | Default branch, ahead of main | Has README update only | Pool-mode + cache bust changes may not be on main yet |
| **pool-manager** | Has PRs #3-#8 individually | Has squashed fix #9 + extras | main is actually ahead of staging |

**Watch out:**
- Railway template `main` may be missing pool-mode changes that are on `staging` — verify before pointing production at it
- Pool manager `staging` is behind `main` — consider rebasing
- Feature branch `feat/validate-join-url-environment` is based on pool-manager `staging`, not `main`
