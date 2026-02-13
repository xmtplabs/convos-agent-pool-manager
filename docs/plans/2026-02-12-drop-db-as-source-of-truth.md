# Drop DB as Source of Truth

**Date:** 2026-02-12
**Status:** Approved
**Branch:** `saul/reconcile-refactor`

## Problem

The DB mirrors Railway state (service existence, URLs, provisioning/idle/claimed status), requiring a ~100-line reconciliation system to keep them in sync. This has already produced orphaned production records and creates a class of drift bugs every time the pool manager crashes between Railway and DB writes.

The agent's `/convos/status` endpoint returns rich data (invite URL, conversation ID, ready state), and Railway's API knows which services exist and their deployment status. The DB is shadowing information that lives authoritatively elsewhere.

## Design

**Railway + health checks become the single source of truth for instance status.** The DB shrinks to a metadata-only table for display purposes, written only on claim.

### Status Derivation

Instance status is derived from Railway deploy status + HTTP health checks:

| Railway Deploy Status | + Health Check | Pool Status | Action |
|---|---|---|---|
| `QUEUED` / `WAITING` / `BUILDING` / `DEPLOYING` | -- | `starting` | Wait |
| `SUCCESS` | responds, no conversation | `idle` | Available for claiming |
| `SUCCESS` | responds, has conversation | `claimed` | In use |
| `SUCCESS` | no response, age < timeout | `starting` | Wait (app booting) |
| `SUCCESS` | no response, age >= timeout, no metadata row | `dead` | Delete silently, replenish |
| `SUCCESS` | no response, age >= timeout, has metadata row | `crashed` | Show on dashboard, user dismisses |
| `FAILED` / `CRASHED` / `REMOVED` / `SKIPPED`, no metadata row | -- | `dead` | Delete silently, replenish |
| `FAILED` / `CRASHED` / `REMOVED` / `SKIPPED`, has metadata row | -- | `crashed` | Show on dashboard, user dismisses |
| `SLEEPING` | -- | -- | Delete from Railway, replenish |

Deploy status is fetched in the same `listProjectServices` GraphQL call by adding `deployments(first: 1) { edges { node { id status } } }` to the query. No extra API calls.

Health checks only run for `SUCCESS` deploys.

### Crashed Agent Detection

A metadata row exists only for claimed agents (inserted on claim, not on create). Therefore:

- Dead service + has metadata row = **crashed** (was actively serving a conversation)
- Dead service + no metadata row = **dead** (was idle/provisioning, silently delete and replace)

Crashed agents are shown on the dashboard with a distinct visual treatment and a dismiss button.

### DB Schema

Rename `pool_instances` to `agent_metadata`. Drop unused columns. This table is written **only on claim**, not on instance creation.

```sql
ALTER TABLE pool_instances RENAME TO agent_metadata;

ALTER TABLE agent_metadata
  DROP COLUMN railway_url,
  DROP COLUMN status,
  DROP COLUMN health_check_failures,
  DROP COLUMN updated_at,
  DROP COLUMN join_url;

ALTER TABLE agent_metadata RENAME COLUMN claimed_by TO agent_name;

DELETE FROM agent_metadata WHERE agent_name IS NULL;
```

Final schema:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | nanoid |
| `railway_service_id` | TEXT NOT NULL | Links to Railway |
| `agent_name` | TEXT NOT NULL | Display name |
| `conversation_id` | TEXT | Conversation identifier |
| `invite_url` | TEXT | For QR code display |
| `instructions` | TEXT | For dashboard display |
| `created_at` | TIMESTAMPTZ | Original instance creation time |
| `claimed_at` | TIMESTAMPTZ | When the instance was claimed |

### In-Memory Cache

A module-level `Map<serviceId, instance>` holds the current state of all instances, rebuilt every tick. All API endpoints read from this map instead of the DB.

A `Set<serviceId>` tracks instances currently being claimed, preventing:
- Two simultaneous claim requests from grabbing the same instance (the `await` to the agent API releases the event loop)
- The tick loop from treating a mid-claim instance as idle

### Tick Loop (every 30s)

Unified single pass replacing `reconcile` + `pollProvisioning` + `replenish`:

1. Fetch all services from Railway (single GraphQL call with deploy status)
2. For each `convos-agent-*` service in our environment (skip any in the `claiming` Set):
   - Map deploy status + health check to pool status (see table above)
   - Delete dead services from Railway
   - Mark crashed services in cache
3. Health-check `SUCCESS` services in parallel via `Promise.allSettled`
4. Count idle + starting; if below `MIN_IDLE`, create new services

### Claim Flow

1. Read in-memory cache, find first service with `status === 'idle'` not in `claiming` Set
2. Add to `claiming` Set (synchronous, before any `await`)
3. `POST /convos/conversation` or `/convos/join` on the instance
4. On success: insert metadata row in DB, rename Railway service, update cache
5. Remove from `claiming` Set (in `finally` block)

Failure is simple: if step 3 fails, nothing was written. The instance stays idle on Railway. No rollback needed.

### API Changes

| Endpoint | Data source change |
|----------|-------------------|
| `GET /api/pool/counts` | In-memory cache (was DB query) |
| `GET /api/pool/agents` | Cache + metadata DB for instructions (was DB query) |
| `GET /api/pool/status` | Full cache (was DB listAll) |
| `POST /api/pool/claim` | Cache lookup + agent API + DB insert (was DB claimOne + agent API + DB update) |
| `POST /api/pool/drain` | Cache filter + Railway delete (was DB listIdle + Railway + DB delete) |
| `DELETE /api/pool/instances/:id` | Cache + Railway delete + DB delete if exists (was DB find + Railway + DB delete) |
| `DELETE /api/pool/crashed/:id` | **New** -- dismiss crashed agent, delete Railway service if exists, remove metadata row |

### Migration Path

No downtime needed:
1. Deploy new code -- tick loop starts building cache from Railway immediately
2. Run migration script to rename table and drop columns
3. Existing claimed agents survive (have metadata rows, tick picks them up)
4. Existing idle/provisioning instances survive (no metadata rows, tick discovers them from Railway)
5. Orphaned DB records from old code are cleaned up by the `DELETE WHERE agent_name IS NULL`

## What Gets Deleted

- `src/db/pool.js` -- all status-tracking queries (`markIdle`, `claimOne`, `listProvisioning`, `countByStatus`, `incrementHealthCheckFailures`, `resetHealthCheckFailures`)
- `reconcile()` function (~100 lines)
- `pollProvisioning()` function
- `FOR UPDATE SKIP LOCKED` atomic claiming
- `status`, `railway_url`, `health_check_failures`, `updated_at`, `join_url` columns

## What Gets Added

- In-memory `Map` cache + `Set` claiming guard
- Deploy status in `listProjectServices` GraphQL query
- Parallel health checks via `Promise.allSettled`
- `DELETE /api/pool/crashed/:id` endpoint
- Dashboard crashed agent cards with dismiss button
