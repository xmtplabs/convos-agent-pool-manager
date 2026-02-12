# OpenClaw Gateway Direct — Local Smoke Test

> Smoke test for the changes described in [2026-02-10-openclaw-gateway-direct.md](./2026-02-10-openclaw-gateway-direct.md).
> That plan removes the convos-agent-railway-template intermediary and talks to
> OpenClaw's gateway directly, with checkpoint-based recycling to reuse Sprites
> instead of destroying and rebuilding them.

## Setup

### 1. Run migration

Adds `checkpoint_id` column to `pool_instances`:

```bash
node --env-file=.env src/db/migrate.js
```

### 2. Verify `.env`

```
SPRITE_TOKEN=...
INSTANCE_ANTHROPIC_API_KEY=sk-ant-...
INSTANCE_XMTP_ENV=dev
POOL_API_KEY=...
POOL_MIN_IDLE=1
POOL_MAX_TOTAL=3
DATABASE_URL=...
```

`OPENCLAW_GIT_REF` can be omitted — defaults to `convos-cli-migration` in the setup script.

### 3. Drain old-format instances

Old instances use the wrapper pattern and won't respond to `/convos/status`:

```bash
curl -X POST http://localhost:3001/api/pool/drain \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 20}'
```

### 4. Start the pool manager

```bash
npm run dev
```

---

## Phase 1: Sprite Creation + Gateway Startup

Add one instance:

```bash
curl -X POST http://localhost:3001/api/pool/replenish \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 1}'
```

**Watch terminal for** (takes 3–5 min for setup script):

```
[pool] Creating instance convos-agent-xxxx...
[pool]   Sprite created: https://convos-agent-xxxx-xxxxx.sprites.app
[pool]   Setup script complete
[pool]   OpenClaw config written
[pool]   Gateway starting
```

Then on poll (~30s after gateway starts):

```
[poll] xxxx — ready=true
[poll] xxxx — golden checkpoint: cp_xxxxx
[poll] xxxx is now idle
```

**Verify gateway directly** (Sprite URL is remote even when pool manager is local):

```bash
curl https://convos-agent-xxxx-xxxxx.sprites.app/convos/status
# {"ready":true,"conversation":null,"streaming":false}
```

Get the Sprite URL from logs or:

```bash
curl http://localhost:3001/api/pool/status \
  -H "Authorization: Bearer $POOL_API_KEY" | jq '.instances[]'
```

**If stuck in provisioning**, debug with:

```bash
curl http://localhost:3001/api/pool/debug/INSTANCE_ID \
  -H "Authorization: Bearer $POOL_API_KEY"
```

---

## Phase 2: Claim (Create Conversation)

```bash
curl -X POST http://localhost:3001/api/pool/claim \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "smoke-test",
    "instructions": "You are a smoke test agent. Say hello when messaged."
  }'
```

**Expected response:**

```json
{
  "inviteUrl": "https://...",
  "conversationId": "abc...",
  "instanceId": "xxxx",
  "joined": false
}
```

**Logs should show:**

```
[pool]   INSTRUCTIONS.md written
[pool] POST https://convos-agent-xxxx.../convos/conversation
[pool] Provisioned xxxx: created conversation abc...
```

**Verify:**

- Open `inviteUrl` in an XMTP client, send a message, confirm agent replies
- Gateway status should show streaming:

```bash
curl https://convos-agent-xxxx-xxxxx.sprites.app/convos/status
# {"ready":true,"conversation":{"id":"abc..."},"streaming":true}
```

---

## Phase 3: Verify Checkpoint

```bash
curl http://localhost:3001/api/pool/status \
  -H "Authorization: Bearer $POOL_API_KEY" \
  | jq '.instances[] | {id, status, checkpoint_id}'
```

Every instance that went through idle should have a non-null `checkpoint_id`.

---

## Phase 4: Recycle + Re-Claim

### 4a: Recycle

Get claimed instance ID:

```bash
curl http://localhost:3001/api/pool/agents | jq '.[0].id'
```

Recycle it:

```bash
curl -X POST http://localhost:3001/api/pool/instances/INSTANCE_ID/recycle \
  -H "Authorization: Bearer $POOL_API_KEY"
```

**Logs should show:**

```
[pool] Recycling instance xxxx (smoke-test)
[sprite] Restoring checkpoint cp_xxxxx on convos-agent-xxxx
[sprite] Checkpoint cp_xxxxx restored on convos-agent-xxxx
[pool]   Checkpoint restored
[pool]   Gateway restarting
[pool]   Recycled — waiting for gateway readiness
```

Then on next poll (~30s):

```
[poll] xxxx — ready=true
[poll] xxxx is now idle
```

**Verify clean state:**

```bash
curl https://convos-agent-xxxx-xxxxx.sprites.app/convos/status
# {"ready":true,"conversation":null,"streaming":false}
```

### 4b: Re-claim the recycled instance

```bash
curl -X POST http://localhost:3001/api/pool/claim \
  -H "Authorization: Bearer $POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "recycled-test",
    "instructions": "You are running on a recycled Sprite."
  }'
```

Should succeed with a fresh conversation.

### 4c: Destroy

```bash
curl -X DELETE http://localhost:3001/api/pool/instances/INSTANCE_ID \
  -H "Authorization: Bearer $POOL_API_KEY"
```

**Logs:**

```
[pool] Destroying instance xxxx
[pool]   Sprite deleted
[pool]   Removed from DB
```

A replacement should start building automatically.

---

## Dashboard

Open `http://localhost:3001` in a browser. Verify:

- Pool counts update
- Claimed agents appear with **Recycle** and **Destroy** buttons
- Recycle removes the card (no confirm dialog), agent reappears as idle in pool counts
- Destroy shows confirmation dialog, then removes the card

---

## Quick Checklist

| # | Test | How to verify |
|---|------|--------------|
| 1 | Sprite builds from `convos-cli-migration` | Logs: `Setup script complete` |
| 2 | Gateway starts and responds | `curl <sprite-url>/convos/status` → `ready: true` |
| 3 | Golden checkpoint created | `checkpoint_id` non-null in `/api/pool/status` |
| 4 | Claim creates conversation | Response has `inviteUrl` + `conversationId` |
| 5 | Agent responds to messages | Message via XMTP client |
| 6 | Recycle restores to idle | Status goes provisioning → idle in ~15-30s |
| 7 | Re-claim after recycle | New conversation on same Sprite |
| 8 | Destroy deletes Sprite | DB row gone, backfill starts |
| 9 | Dashboard buttons work | Recycle (no confirm), Destroy (with confirm) |
| 10 | Heartbeat uses `/convos/status` | No auth errors in logs |
