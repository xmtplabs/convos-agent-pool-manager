# Convos Agent Pool Manager

Manages a pool of pre-warmed [OpenClaw](https://github.com/xmtplabs/openclaw) agent instances on [Railway](https://railway.com). Instances are created ahead of time so that when a user claims one, it's ready in seconds instead of minutes.

## How it works

```
                         ┌──────────────┐
                         │  Pool Manager │
                         │  (this repo)  │
                         └──┬───┬───┬───┘
               creates      │   │   │      polls /convos/status
            ┌───────────────┘   │   └───────────────┐
            ▼                   ▼                    ▼
    ┌──────────────┐   ┌──────────────┐     ┌──────────────┐
    │   OpenClaw   │   │   OpenClaw   │     │   OpenClaw   │
    │  instance 1  │   │  instance 2  │ ... │  instance N  │
    │  (Railway)   │   │  (Railway)   │     │  (Railway)   │
    └──────────────┘   └──────────────┘     └──────────────┘
```

1. The pool manager creates Railway services from the `agent/` directory in this repo (Dockerfile + entrypoint that builds and runs OpenClaw)
2. It polls each instance's `/convos/status` endpoint until it reports `ready`
3. Ready instances are marked **idle** and available for claiming
4. When claimed via `POST /api/pool/claim`, the manager calls `/convos/conversation` (or `/convos/join`) on the instance with the provided instructions, then backfills the pool
5. Claimed instances are renamed in Railway so they're identifiable in the dashboard

## Architecture

This is a **2-repo system**:

| Repo | Description |
|------|-------------|
| **this repo** (`convos-agent-pool-manager`) | Pool manager + agent Dockerfile/entrypoint in `agent/` |
| [openclaw](https://github.com/xmtplabs/openclaw) | The AI gateway that runs inside each agent instance |

The `agent/Dockerfile` clones OpenClaw from source, builds it, and the `agent/entrypoint.sh` configures and starts the gateway.

## Setup

Requires Node.js 22+ and a [Neon](https://neon.tech) Postgres database.

```sh
git clone https://github.com/xmtplabs/convos-agent-pool-manager.git
cd convos-agent-pool-manager
npm install
```

Copy `.env.example` to `.env` and fill in the values:

```sh
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default `3001`) |
| `POOL_API_KEY` | Shared secret for API auth (Bearer token) |
| `POOL_ENVIRONMENT` | `"staging"`, `"dev"`, or `"production"` |
| `RAILWAY_API_TOKEN` | Railway project-scoped API token |
| `RAILWAY_PROJECT_ID` | Railway project ID |
| `RAILWAY_ENVIRONMENT_ID` | Railway environment ID |
| `RAILWAY_SOURCE_REPO` | GitHub repo to deploy (e.g. `xmtplabs/convos-agent-pool-manager`) |
| `RAILWAY_SOURCE_BRANCH` | Branch to deploy from (e.g. `staging`, `main`) |
| `RAILWAY_SOURCE_ROOT_DIR` | Subdirectory containing the Dockerfile (`agent`) |
| `OPENCLAW_GIT_REF` | OpenClaw git ref to build from (default: `staging` or `main`) |
| `INSTANCE_ANTHROPIC_API_KEY` | Anthropic API key injected into each instance |
| `INSTANCE_XMTP_ENV` | XMTP environment (`dev` or `production`) |
| `POOL_MIN_IDLE` | Minimum idle instances to maintain (default `3`) |
| `POOL_MAX_TOTAL` | Maximum total instances (default `10`) |
| `DATABASE_URL` | Neon Postgres connection string |

Run the database migration:

```sh
npm run db:migrate
```

Start the server:

```sh
npm start
```

## API

All endpoints (except `GET /` and `GET /healthz`) require a `Authorization: Bearer <POOL_API_KEY>` header.

### `GET /`

Serves a web dashboard for managing the pool and claiming instances.

### `GET /healthz`

Health check. Returns `{"ok": true}`.

### `GET /api/pool/status`

Returns pool counts and all instances.

```json
{
  "counts": { "provisioning": 2, "idle": 3, "claimed": 1 },
  "instances": [...]
}
```

### `GET /api/pool/counts`

Returns pool counts only (no auth required).

```json
{ "provisioning": 2, "idle": 3, "claimed": 1 }
```

### `POST /api/pool/claim`

Claims an idle instance and provisions it. Creates a new conversation or joins an existing one.

**Create mode** (default):

```json
{
  "agentName": "tokyo-trip-planner",
  "instructions": "You are a helpful trip planner for Tokyo."
}
```

**Join mode** (join existing conversation via invite URL):

```json
{
  "agentName": "tokyo-trip-planner",
  "instructions": "You are a helpful trip planner for Tokyo.",
  "joinUrl": "https://dev.convos.org/v2?i=..."
}
```

Returns:

```json
{
  "inviteUrl": "https://dev.convos.org/v2?i=...",
  "conversationId": "abc123",
  "instanceId": "rnM8UBQ_fZCz",
  "joined": false
}
```

### `POST /api/pool/replenish`

Manually triggers a poll + replenish cycle. Pass `{"count": N}` to create N instances directly.

### `POST /api/pool/drain`

Removes idle instances from the pool. Pass `{"count": N}` to drain up to N idle instances.

### `POST /api/pool/reconcile`

Verifies DB state against Railway and removes orphaned entries.

## Instance lifecycle

```
provisioning  →  idle  →  claimed
    (building)     (ready)    (in use)
```

The background tick runs every 30 seconds:
1. Polls all `provisioning` instances — if `/convos/status` returns `ready`, marks them `idle`
2. Checks if idle + provisioning count is below `POOL_MIN_IDLE` — if so, creates new instances up to `POOL_MAX_TOTAL`
3. Periodically reconciles DB against Railway to clean up orphaned entries

## Environments

Three Railway environments share the same project:

| Environment | Pool Manager URL | XMTP Network | Source Branch |
|-------------|-----------------|---------------|---------------|
| dev | `convos-agent-pool-manager-dev.up.railway.app` | dev | *(your branch)* |
| staging | `convos-agents-dev.up.railway.app` | dev | `staging` |
| production | `convos-agents.up.railway.app` | production | `main` |
