# Convos Agent Pool Manager

Manages a pool of pre-warmed [OpenClaw](https://github.com/xmtplabs/openclaw) agent instances on [Fly.io Sprites](https://sprites.dev). Instances are created ahead of time so that when a user claims one, it's ready in seconds instead of minutes.

## How it works

```
                         ┌──────────────┐
                         │  Pool Manager │
                         │  (this repo)  │
                         └──┬───┬───┬───┘
              creates       │   │   │      polls /convos/status
           ┌────────────────┘   │   └────────────────┐
           ▼                    ▼                     ▼
   ┌──────────────┐    ┌──────────────┐      ┌──────────────┐
   │   OpenClaw   │    │   OpenClaw   │      │   OpenClaw   │
   │  instance 1  │    │  instance 2  │ ...  │  instance N  │
   │  (Sprite)    │    │  (Sprite)    │      │  (Sprite)    │
   └──────────────┘    └──────────────┘      └──────────────┘
```

1. The pool manager creates a Fly.io Sprite, runs `scripts/sprite-setup.sh` to install OpenClaw from source, then starts the OpenClaw gateway
2. It polls each instance's `/convos/status` endpoint until it reports `ready`
3. A **golden checkpoint** is taken of the clean state (OpenClaw installed, gateway running, no XMTP identity)
4. Ready instances are marked **idle** and available for claiming
5. When claimed via `POST /api/pool/claim`, the manager writes `INSTRUCTIONS.md` and calls `/convos/conversation` (or `/convos/join`) on the gateway
6. When recycled, the checkpoint is restored (~15s) instead of rebuilding from scratch (~5min)

## Instance lifecycle

```
provisioning ──→ idle ──→ claimed ──→ recycled ──→ idle
 (building)     (ready)   (in use)   (checkpoint   (ready again)
                                      restored)
```

- **provisioning**: Sprite created, setup script running, gateway starting
- **idle**: Gateway responding, golden checkpoint taken, waiting to be claimed
- **claimed**: Bound to a conversation with custom instructions
- **recycled**: Checkpoint restored, gateway restarted, returned to idle

Instances are only destroyed when broken (heartbeat failure), explicitly drained, or during reconciliation.

## Related repos

| Repo | Description |
|------|-------------|
| [openclaw](https://github.com/xmtplabs/openclaw) | The AI agent framework. Cloned and built inside each Sprite. Provides the gateway HTTP server and Convos XMTP extension. |

## Setup

Requires Node.js 22+ and [Docker](https://www.docker.com/) (for local Postgres).

```sh
git clone https://github.com/xmtplabs/convos-agent-pool-manager.git
cd convos-agent-pool-manager
npm install
```

Copy `.env.example` to `.env` and fill in the values:

```sh
cp .env.example .env
```

Start a local Postgres:

```sh
docker compose up -d
```

Run the database migration:

```sh
npm run db:migrate
```

Start the server:

```sh
npm start
```

Drain all idle instances (useful after code changes):

```sh
npm run drain:all
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default `3001`) |
| `POOL_API_KEY` | Shared secret for API auth (Bearer token) |
| `POOL_ENVIRONMENT` | `dev`, `staging`, or `production` — controls dashboard badge, safety confirms, and defaults for `INSTANCE_XMTP_ENV` and `OPENCLAW_GIT_REF` |
| `SPRITE_TOKEN` | Fly.io Sprites API token |
| `INSTANCE_ANTHROPIC_API_KEY` | Anthropic API key injected into each Sprite's OpenClaw config |
| `INSTANCE_XMTP_ENV` | XMTP network. Optional — defaults to `production` if `POOL_ENVIRONMENT=production`, else `dev` |
| `POOL_MIN_IDLE` | Minimum idle instances to maintain (default `3`) |
| `POOL_MAX_TOTAL` | Maximum total instances (default `50`) |
| `HEARTBEAT_INTERVAL_MS` | Interval for keep-alive pings to Sprites (default `20000`) |
| `OPENCLAW_GIT_REF` | OpenClaw git branch to build inside Sprites. Optional — defaults to `main` if `POOL_ENVIRONMENT=production`, else `staging` |
| `DATABASE_URL` | Postgres connection string. Local dev: `postgresql://postgres:postgres@localhost:5433/pool_manager` (via Docker Compose). Deployed: Neon connection string. |

## API

### Public (no auth)

#### `GET /`

Dashboard web UI for launching and managing agents.

#### `GET /healthz`

Health check. Returns `{"ok": true}`.

#### `GET /version`

Returns build version and environment.

```json
{ "version": "2026-02-11:openclaw-gateway-direct", "environment": "staging" }
```

#### `GET /api/pool/counts`

Pool counts by status.

```json
{ "provisioning": 2, "idle": 3, "claimed": 1 }
```

#### `GET /api/pool/agents`

List all claimed (live) agents with their names, instructions, and invite URLs.

### Auth required (`Authorization: Bearer <POOL_API_KEY>`)

#### `POST /api/pool/claim`

Claim an idle instance and provision it with instructions.

```json
{
  "agentName": "tokyo-trip-planner",
  "instructions": "You are a helpful trip planner for Tokyo.",
  "joinUrl": "https://dev.convos.org/v2?i=..."
}
```

`joinUrl` is optional — if provided, the agent joins an existing conversation instead of creating a new one.

Returns:

```json
{
  "inviteUrl": "https://dev.convos.org/v2?i=...",
  "conversationId": "abc123",
  "instanceId": "rnM8UBQ_fZCz",
  "joined": false
}
```

#### `DELETE /api/pool/instances`

List all claimed instance IDs (used by the dashboard for bulk operations).

#### `DELETE /api/pool/instances/:id`

Recycle a claimed instance — restores the golden checkpoint, restarts the gateway, and returns it to idle.

#### `DELETE /api/pool/instances/:id/destroy`

Permanently destroy an instance — deletes the Sprite and removes it from the database.

#### `POST /api/pool/replenish`

Manually create N new instances.

```json
{ "count": 3 }
```

#### `POST /api/pool/drain`

Destroy N idle instances from the pool.

```json
{ "count": 5 }
```

#### `POST /api/pool/reconcile`

Verify database state against Sprites API and clean up orphaned records.

#### `GET /api/pool/status`

Full pool status — counts and all instances.

```json
{
  "counts": { "provisioning": 2, "idle": 3, "claimed": 1 },
  "instances": [...]
}
```

#### `GET /api/pool/debug/:id`

Probe a Sprite to inspect running processes, gateway status, environment, listening ports, and Sprite API info.
