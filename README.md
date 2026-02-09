# Convos Agent Pool Manager

Manages a pool of pre-warmed [convos-agent-railway-template](https://github.com/xmtplabs/convos-agent-railway-template) instances on [Railway](https://railway.com). Instances are created ahead of time so that when a user claims one, it's ready in seconds instead of minutes.

## How it works

```
                         ┌──────────────┐
                         │  Pool Manager │
                         │  (this repo)  │
                         └──┬───┬───┬───┘
               creates      │   │   │      polls /pool/status
            ┌───────────────┘   │   └───────────────┐
            ▼                   ▼                    ▼
    ┌──────────────┐   ┌──────────────┐     ┌──────────────┐
    │    agent     │   │    agent     │     │    agent     │
    │  instance 1  │   │  instance 2  │ ... │  instance N  │
    │  (Railway)   │   │  (Railway)   │     │  (Railway)   │
    └──────────────┘   └──────────────┘     └──────────────┘
```

1. The pool manager creates Railway services from [xmtplabs/convos-agent-railway-template](https://github.com/xmtplabs/convos-agent-railway-template)
2. It polls each instance's `/pool/status` endpoint until it reports `ready`
3. Ready instances are marked **idle** and available for claiming
4. When claimed via `POST /api/pool/claim`, the manager calls `/pool/provision` on the instance with the provided instructions, then backfills the pool
5. Claimed instances are renamed in Railway so they're identifiable in the dashboard

Instances are never destroyed by the pool manager — once claimed, they stay running.

## Related repos

| Repo | Description |
|------|-------------|
| [convos-agent-railway-template](https://github.com/xmtplabs/convos-agent-railway-template) | The bot template deployed on each Railway instance. Must have pool mode support (`POOL_MODE=true` endpoints). |

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
| `RAILWAY_API_TOKEN` | Railway project-scoped API token |
| `RAILWAY_PROJECT_ID` | Railway project ID |
| `RAILWAY_ENVIRONMENT_ID` | Railway environment ID |
| `RAILWAY_SOURCE_REPO` | GitHub repo to deploy (e.g. `xmtplabs/convos-agent-railway-template`) |
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

Serves a web form for claiming an instance (name + instructions).

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

### `POST /api/pool/claim`

Claims an idle instance and provisions it with instructions.

```json
{
  "agentId": "tokyo-trip-planner",
  "instructions": "You are a helpful trip planner for Tokyo."
}
```

Returns:

```json
{
  "inviteUrl": "https://dev.convos.org/v2?i=...",
  "qrDataUrl": "data:image/png;base64,...",
  "conversationId": "abc123",
  "instanceId": "rnM8UBQ_fZCz"
}
```

### `POST /api/pool/replenish`

Manually triggers a poll + replenish cycle.

## Instance lifecycle

```
provisioning  →  idle  →  claimed
    (deploying)    (ready)    (in use, never destroyed)
```

The background tick runs every 30 seconds:
1. Polls all `provisioning` instances — if `/pool/status` returns `ready`, marks them `idle`
2. Checks if idle + provisioning count is below `POOL_MIN_IDLE` — if so, creates new instances up to `POOL_MAX_TOTAL`
