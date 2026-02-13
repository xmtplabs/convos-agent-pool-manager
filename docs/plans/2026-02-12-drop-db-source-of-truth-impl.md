# Drop DB as Source of Truth — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace DB-as-source-of-truth with Railway + health checks. DB becomes metadata-only, written on claim.

**Architecture:** In-memory cache (Map) rebuilt every tick from Railway API + HTTP health checks. Metadata DB table stores agent display info (name, instructions, invite URL) inserted only on claim. Status is derived, never stored.

**Tech Stack:** Node 22, Express 5, Neon Postgres (metadata only), Railway GraphQL API, Node built-in test runner

**Design doc:** `docs/plans/2026-02-12-drop-db-as-source-of-truth.md`

---

### Task 1: Add Deploy Status to Railway GraphQL Query

**Files:**
- Modify: `src/railway.js:200-232` (`listProjectServices`)

**Step 1: Update the GraphQL query**

In `listProjectServices()`, add `deployments(first: 1)` to the service node query and return `deployStatus` in the mapped result:

```js
export async function listProjectServices() {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  try {
    const data = await gql(
      `query($id: String!) {
        project(id: $id) {
          services(first: 500) {
            edges {
              node {
                id
                name
                createdAt
                serviceInstances { edges { node { environmentId } } }
                deployments(first: 1) {
                  edges { node { id status } }
                }
              }
            }
          }
        }
      }`,
      { id: projectId }
    );
    const edges = data.project?.services?.edges;
    if (!edges) return null;
    return edges.map((e) => ({
      id: e.node.id,
      name: e.node.name,
      createdAt: e.node.createdAt,
      environmentIds: (e.node.serviceInstances?.edges || []).map((si) => si.node.environmentId),
      deployStatus: e.node.deployments?.edges?.[0]?.node?.status || null,
    }));
  } catch (err) {
    console.warn(`[railway] listProjectServices failed: ${err.message}`);
    return null;
  }
}
```

**Step 2: Verify locally**

Run: `node --env-file=.env -e "import('./src/railway.js').then(r => r.listProjectServices().then(s => console.log(JSON.stringify(s?.slice(0,3), null, 2))))"`

Expected: Services include `"deployStatus": "SUCCESS"` (or similar).

**Step 3: Commit**

```bash
git add src/railway.js
git commit -m "feat: include deploy status in listProjectServices query"
```

---

### Task 2: Create Cache Module

**Files:**
- Create: `src/cache.js`
- Create: `src/cache.test.js`

**Step 1: Write the test**

```js
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getAll, getByStatus, getCounts, set, remove, isBeingClaimed, startClaim, endClaim } from "./cache.js";

describe("cache", () => {
  beforeEach(() => {
    // Clear cache between tests
    for (const inst of getAll()) {
      remove(inst.serviceId);
    }
  });

  it("set and getAll", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle", name: "convos-agent-abc", url: "https://abc.up.railway.app" });
    set("svc-2", { serviceId: "svc-2", status: "claimed", name: "convos-agent-trip", url: "https://trip.up.railway.app" });
    assert.equal(getAll().length, 2);
  });

  it("getByStatus filters correctly", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle" });
    set("svc-2", { serviceId: "svc-2", status: "claimed" });
    set("svc-3", { serviceId: "svc-3", status: "starting" });
    assert.equal(getByStatus("idle").length, 1);
    assert.equal(getByStatus("claimed").length, 1);
  });

  it("getCounts returns all statuses", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle" });
    set("svc-2", { serviceId: "svc-2", status: "idle" });
    set("svc-3", { serviceId: "svc-3", status: "claimed" });
    const counts = getCounts();
    assert.equal(counts.idle, 2);
    assert.equal(counts.claimed, 1);
    assert.equal(counts.starting, 0);
  });

  it("remove deletes entry", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle" });
    remove("svc-1");
    assert.equal(getAll().length, 0);
  });

  it("claiming set prevents double-claim", () => {
    assert.equal(isBeingClaimed("svc-1"), false);
    startClaim("svc-1");
    assert.equal(isBeingClaimed("svc-1"), true);
    endClaim("svc-1");
    assert.equal(isBeingClaimed("svc-1"), false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test src/cache.test.js`
Expected: FAIL — `src/cache.js` does not exist.

**Step 3: Write the implementation**

```js
// In-memory cache of instance state, rebuilt every tick.
// All API endpoints read from this instead of the DB.

/** @type {Map<string, {serviceId: string, status: string, name: string, url: string, createdAt: string, deployStatus: string|null, inviteUrl?: string, conversationId?: string}>} */
const instances = new Map();

/** @type {Set<string>} */
const claiming = new Set();

export function set(serviceId, data) {
  instances.set(serviceId, data);
}

export function get(serviceId) {
  return instances.get(serviceId) || null;
}

export function remove(serviceId) {
  instances.delete(serviceId);
}

export function getAll() {
  return [...instances.values()];
}

export function getByStatus(status) {
  return getAll().filter((i) => i.status === status);
}

export function getCounts() {
  const counts = { starting: 0, idle: 0, claimed: 0, crashed: 0 };
  for (const inst of instances.values()) {
    if (counts[inst.status] !== undefined) counts[inst.status]++;
  }
  return counts;
}

// Find the first idle instance not currently being claimed.
export function findClaimable() {
  for (const inst of instances.values()) {
    if (inst.status === "idle" && !claiming.has(inst.serviceId)) {
      return inst;
    }
  }
  return null;
}

export function startClaim(serviceId) {
  claiming.add(serviceId);
}

export function endClaim(serviceId) {
  claiming.delete(serviceId);
}

export function isBeingClaimed(serviceId) {
  return claiming.has(serviceId);
}
```

**Step 4: Run test to verify it passes**

Run: `node --test src/cache.test.js`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add src/cache.js src/cache.test.js
git commit -m "feat: add in-memory cache module with claiming guard"
```

---

### Task 3: Write Status Derivation Logic

**Files:**
- Create: `src/status.js`
- Create: `src/status.test.js`

**Step 1: Write the test**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveStatus } from "./status.js";

describe("deriveStatus", () => {
  const STUCK_MS = 15 * 60 * 1000;
  const young = new Date(Date.now() - 60_000).toISOString(); // 1 min old
  const old = new Date(Date.now() - STUCK_MS - 60_000).toISOString(); // 16 min old

  it("BUILDING → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "BUILDING", createdAt: young }), "starting");
  });

  it("DEPLOYING → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "DEPLOYING", createdAt: young }), "starting");
  });

  it("QUEUED → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "QUEUED", createdAt: young }), "starting");
  });

  it("WAITING → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "WAITING", createdAt: young }), "starting");
  });

  it("FAILED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "FAILED", createdAt: young }), "dead");
  });

  it("CRASHED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "CRASHED", createdAt: young }), "dead");
  });

  it("REMOVED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "REMOVED", createdAt: young }), "dead");
  });

  it("SKIPPED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "SKIPPED", createdAt: young }), "dead");
  });

  it("SLEEPING → sleeping", () => {
    assert.equal(deriveStatus({ deployStatus: "SLEEPING", createdAt: young }), "sleeping");
  });

  it("SUCCESS + healthy + no conversation → idle", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: { ready: true, conversation: null } }), "idle");
  });

  it("SUCCESS + healthy + has conversation → claimed", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: { ready: true, conversation: "conv-123" } }), "claimed");
  });

  it("SUCCESS + unreachable + young → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: null, createdAt: young }), "starting");
  });

  it("SUCCESS + unreachable + old → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: null, createdAt: old }), "dead");
  });

  it("null deploy status + young → starting", () => {
    assert.equal(deriveStatus({ deployStatus: null, createdAt: young }), "starting");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test src/status.test.js`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```js
const STUCK_TIMEOUT_MS = parseInt(process.env.POOL_STUCK_TIMEOUT_MS || String(15 * 60 * 1000), 10);

const STARTING_STATUSES = new Set(["QUEUED", "WAITING", "BUILDING", "DEPLOYING"]);
const DEAD_STATUSES = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

// Derive pool status from Railway deploy status + health check result.
// healthCheck is the parsed JSON from /convos/status, or null if unreachable.
export function deriveStatus({ deployStatus, healthCheck = null, createdAt = null }) {
  if (deployStatus === "SLEEPING") return "sleeping";
  if (DEAD_STATUSES.has(deployStatus)) return "dead";
  if (STARTING_STATUSES.has(deployStatus)) return "starting";

  if (deployStatus === "SUCCESS") {
    if (healthCheck) {
      return healthCheck.conversation ? "claimed" : "idle";
    }
    // Unreachable — check age
    const age = createdAt ? Date.now() - new Date(createdAt).getTime() : Infinity;
    return age < STUCK_TIMEOUT_MS ? "starting" : "dead";
  }

  // Unknown or null deploy status — treat as starting if young
  const age = createdAt ? Date.now() - new Date(createdAt).getTime() : Infinity;
  return age < STUCK_TIMEOUT_MS ? "starting" : "dead";
}
```

**Step 4: Run test to verify it passes**

Run: `node --test src/status.test.js`
Expected: All 14 tests PASS.

**Step 5: Commit**

```bash
git add src/status.js src/status.test.js
git commit -m "feat: add status derivation from Railway deploy status + health checks"
```

---

### Task 4: Rewrite DB Layer as Metadata-Only

**Files:**
- Modify: `src/db/pool.js` (rewrite entirely)

**Step 1: Replace contents of `src/db/pool.js`**

```js
import { sql } from "./connection.js";

// Insert metadata when an instance is claimed.
export async function insertMetadata({ id, railwayServiceId, agentName, conversationId, inviteUrl, instructions }) {
  await sql`
    INSERT INTO agent_metadata (id, railway_service_id, agent_name, conversation_id, invite_url, instructions, claimed_at)
    VALUES (${id}, ${railwayServiceId}, ${agentName}, ${conversationId}, ${inviteUrl || null}, ${instructions || null}, NOW())
  `;
}

// Find metadata by Railway service ID.
export async function findByServiceId(railwayServiceId) {
  const result = await sql`
    SELECT * FROM agent_metadata WHERE railway_service_id = ${railwayServiceId}
  `;
  return result.rows[0] || null;
}

// Find metadata by instance ID.
export async function findById(id) {
  const result = await sql`
    SELECT * FROM agent_metadata WHERE id = ${id}
  `;
  return result.rows[0] || null;
}

// List all metadata rows (for enriching cache with instructions).
export async function listAll() {
  const result = await sql`
    SELECT * FROM agent_metadata ORDER BY claimed_at DESC
  `;
  return result.rows;
}

// Delete metadata row (when dismissing crashed agent or killing instance).
export async function deleteByServiceId(railwayServiceId) {
  await sql`DELETE FROM agent_metadata WHERE railway_service_id = ${railwayServiceId}`;
}

export async function deleteById(id) {
  await sql`DELETE FROM agent_metadata WHERE id = ${id}`;
}
```

**Step 2: Verify syntax**

Run: `node -e "import('./src/db/pool.js').then(() => console.log('OK')).catch(e => console.error(e))"`
Expected: `OK` (module parses without error).

**Step 3: Commit**

```bash
git add src/db/pool.js
git commit -m "refactor: rewrite db layer as metadata-only (no status tracking)"
```

---

### Task 5: Rewrite the Tick Loop

**Files:**
- Modify: `src/pool.js` (major rewrite)

This is the biggest task. Replace `reconcile()`, `pollProvisioning()`, and the old `tick()` with a unified tick that builds the cache from Railway + health checks.

**Step 1: Rewrite `src/pool.js`**

```js
import { nanoid } from "nanoid";
import * as db from "./db/pool.js";
import * as railway from "./railway.js";
import * as cache from "./cache.js";
import { deriveStatus } from "./status.js";

const POOL_API_KEY = process.env.POOL_API_KEY;
const MIN_IDLE = parseInt(process.env.POOL_MIN_IDLE || "3", 10);
const MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "10", 10);

const IS_PRODUCTION = (process.env.POOL_ENVIRONMENT || "staging") === "production";

function instanceEnvVars() {
  return {
    ANTHROPIC_API_KEY: process.env.INSTANCE_ANTHROPIC_API_KEY || "",
    XMTP_ENV: process.env.INSTANCE_XMTP_ENV || "dev",
    GATEWAY_AUTH_TOKEN: POOL_API_KEY,
    OPENCLAW_GIT_REF: process.env.OPENCLAW_GIT_REF || (IS_PRODUCTION ? "main" : "staging"),
    PORT: "8080",
  };
}

// Health-check a single instance via /convos/status.
// Returns parsed JSON on success, null on failure.
async function healthCheck(url) {
  try {
    const res = await fetch(`${url}/convos/status`, {
      headers: { Authorization: `Bearer ${POOL_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Resolve a Railway service's public URL from its domain.
async function getServiceUrl(serviceId) {
  // The domain is already known for services we created.
  // For discovery, we need to query it.
  try {
    const domain = await railway.getServiceDomain(serviceId);
    return domain ? `https://${domain}` : null;
  } catch {
    return null;
  }
}

// Create a single new Railway service (no DB write).
export async function createInstance() {
  const id = nanoid(12);
  const name = `convos-agent-${id}`;

  console.log(`[pool] Creating instance ${name}...`);

  const serviceId = await railway.createService(name, instanceEnvVars());
  console.log(`[pool]   Railway service created: ${serviceId}`);

  const domain = await railway.createDomain(serviceId);
  const url = `https://${domain}`;
  console.log(`[pool]   Domain: ${url}`);

  // Add to cache immediately as starting
  cache.set(serviceId, {
    serviceId,
    id,
    name,
    url,
    status: "starting",
    createdAt: new Date().toISOString(),
    deployStatus: "BUILDING",
  });

  return { id, serviceId, url, name };
}

// Unified tick: rebuild cache from Railway, health-check, replenish.
export async function tick() {
  const myEnvId = process.env.RAILWAY_ENVIRONMENT_ID;
  const allServices = await railway.listProjectServices();

  if (allServices === null) {
    console.warn(`[tick] listProjectServices failed, skipping tick`);
    return;
  }

  // Filter to agent services in our environment
  const agentServices = allServices.filter(
    (s) =>
      s.name.startsWith("convos-agent-") &&
      s.name !== "convos-agent-pool-manager" &&
      s.environmentIds.includes(myEnvId)
  );

  // Load metadata rows for enrichment
  const metadataRows = await db.listAll();
  const metadataByServiceId = new Map(metadataRows.map((r) => [r.railway_service_id, r]));

  // Health-check all SUCCESS services in parallel
  const successServices = agentServices.filter((s) => s.deployStatus === "SUCCESS");

  // Get URLs for services (we need domains to health-check)
  // For services already in cache, reuse their URL
  const urlMap = new Map();
  for (const svc of successServices) {
    const cached = cache.get(svc.id);
    if (cached?.url) {
      urlMap.set(svc.id, cached.url);
    }
  }

  // For services not in cache, fetch domains in parallel
  const needUrls = successServices.filter((s) => !urlMap.has(s.id));
  if (needUrls.length > 0) {
    const urlResults = await Promise.allSettled(
      needUrls.map(async (svc) => {
        const url = await getServiceUrl(svc.id);
        return { id: svc.id, url };
      })
    );
    for (const r of urlResults) {
      if (r.status === "fulfilled" && r.value.url) {
        urlMap.set(r.value.id, r.value.url);
      }
    }
  }

  // Health-check SUCCESS services in parallel
  const healthResults = new Map();
  const toCheck = successServices.filter(
    (s) => urlMap.has(s.id) && !cache.isBeingClaimed(s.id)
  );

  const checks = await Promise.allSettled(
    toCheck.map(async (svc) => {
      const result = await healthCheck(urlMap.get(svc.id));
      return { id: svc.id, result };
    })
  );
  for (const c of checks) {
    if (c.status === "fulfilled") {
      healthResults.set(c.value.id, c.value.result);
    }
  }

  // Rebuild cache and take action on dead/sleeping services
  const toDelete = [];

  for (const svc of agentServices) {
    // Skip services being claimed right now
    if (cache.isBeingClaimed(svc.id)) continue;

    const hc = healthResults.get(svc.id) || null;
    const status = deriveStatus({
      deployStatus: svc.deployStatus,
      healthCheck: hc,
      createdAt: svc.createdAt,
    });

    const metadata = metadataByServiceId.get(svc.id);
    const url = urlMap.get(svc.id) || cache.get(svc.id)?.url || null;

    if (status === "dead" || status === "sleeping") {
      if (metadata) {
        // Was claimed — mark as crashed in cache for dashboard
        cache.set(svc.id, {
          serviceId: svc.id,
          id: metadata.id,
          name: svc.name,
          url,
          status: "crashed",
          createdAt: svc.createdAt,
          deployStatus: svc.deployStatus,
          agentName: metadata.agent_name,
          instructions: metadata.instructions,
          inviteUrl: metadata.invite_url,
          conversationId: metadata.conversation_id,
          claimedAt: metadata.claimed_at,
        });
      } else {
        // Was idle/provisioning — delete silently
        cache.remove(svc.id);
        toDelete.push(svc);
      }
      continue;
    }

    // Build cache entry
    const entry = {
      serviceId: svc.id,
      id: metadata?.id || svc.name.replace("convos-agent-", ""),
      name: svc.name,
      url,
      status,
      createdAt: svc.createdAt,
      deployStatus: svc.deployStatus,
    };

    // Enrich with health-check data
    if (hc) {
      entry.inviteUrl = hc.inviteUrl || metadata?.invite_url || null;
      entry.conversationId = hc.conversationId || hc.conversation || metadata?.conversation_id || null;
    }

    // Enrich with metadata
    if (metadata) {
      entry.agentName = metadata.agent_name;
      entry.instructions = metadata.instructions;
      entry.inviteUrl = entry.inviteUrl || metadata.invite_url;
      entry.conversationId = entry.conversationId || metadata.conversation_id;
      entry.claimedAt = metadata.claimed_at;
    }

    cache.set(svc.id, entry);
  }

  // Remove cache entries for services no longer in Railway
  const railwayServiceIds = new Set(agentServices.map((s) => s.id));
  for (const inst of cache.getAll()) {
    if (!railwayServiceIds.has(inst.serviceId) && !cache.isBeingClaimed(inst.serviceId)) {
      cache.remove(inst.serviceId);
    }
  }

  // Delete dead services from Railway
  for (const svc of toDelete) {
    try {
      await railway.deleteService(svc.id);
      console.log(`[tick] Deleted dead service ${svc.id} (${svc.name})`);
    } catch (err) {
      console.warn(`[tick] Failed to delete ${svc.id}: ${err.message}`);
    }
  }

  // Replenish
  const counts = cache.getCounts();
  const total = counts.starting + counts.idle + counts.claimed;
  const deficit = MIN_IDLE - (counts.idle + counts.starting);

  console.log(
    `[tick] ${counts.idle} idle, ${counts.starting} starting, ${counts.claimed} claimed, ${counts.crashed || 0} crashed (total: ${total})`
  );

  if (deficit > 0) {
    const canCreate = Math.min(deficit, MAX_TOTAL - total);
    if (canCreate > 0) {
      console.log(`[tick] Creating ${canCreate} new instance(s)...`);
      for (let i = 0; i < canCreate; i++) {
        try {
          await createInstance();
        } catch (err) {
          console.error(`[tick] Failed to create instance:`, err);
        }
      }
    }
  }
}

// Claim an idle instance and provision it.
export async function provision(agentName, instructions, joinUrl) {
  const instance = cache.findClaimable();
  if (!instance) return null;

  cache.startClaim(instance.serviceId);
  try {
    console.log(`[pool] Claiming ${instance.id} for "${agentName}"${joinUrl ? " (join)" : ""}`);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${POOL_API_KEY}`,
    };

    let result;
    if (joinUrl) {
      const res = await fetch(`${instance.url}/convos/join`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          inviteUrl: joinUrl,
          profileName: agentName,
          env: process.env.INSTANCE_XMTP_ENV || "dev",
          instructions,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Join failed on ${instance.id}: ${res.status} ${text}`);
      }
      result = await res.json();
      result.joined = true;
    } else {
      const res = await fetch(`${instance.url}/convos/conversation`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          name: agentName,
          profileName: agentName,
          env: process.env.INSTANCE_XMTP_ENV || "dev",
          instructions,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Create failed on ${instance.id}: ${res.status} ${text}`);
      }
      result = await res.json();
      result.joined = false;
    }

    if (result.conversationId == null) {
      throw new Error(`API returned unexpected format: missing conversationId`);
    }

    // Insert metadata row
    await db.insertMetadata({
      id: instance.id,
      railwayServiceId: instance.serviceId,
      agentName,
      conversationId: result.conversationId,
      inviteUrl: result.inviteUrl || joinUrl || null,
      instructions,
    });

    // Update cache
    cache.set(instance.serviceId, {
      ...instance,
      status: "claimed",
      agentName,
      conversationId: result.conversationId,
      inviteUrl: result.inviteUrl || joinUrl || null,
      instructions,
      claimedAt: new Date().toISOString(),
    });

    // Rename Railway service for dashboard visibility
    try {
      await railway.renameService(instance.serviceId, `convos-agent-${agentName}`);
    } catch (err) {
      console.warn(`[pool] Failed to rename ${instance.id}:`, err.message);
    }

    console.log(`[pool] Provisioned ${instance.id}: ${result.joined ? "joined" : "created"} conversation ${result.conversationId}`);

    return {
      inviteUrl: result.inviteUrl || null,
      conversationId: result.conversationId,
      instanceId: instance.id,
      joined: result.joined,
    };
  } finally {
    cache.endClaim(instance.serviceId);
  }
}

// Drain idle instances.
export async function drainPool(count) {
  const idle = cache.getByStatus("idle").slice(0, count);
  console.log(`[pool] Draining ${idle.length} idle instance(s)...`);
  const results = [];
  for (const inst of idle) {
    try {
      await railway.deleteService(inst.serviceId);
      cache.remove(inst.serviceId);
      results.push(inst.id);
      console.log(`[pool]   Drained ${inst.id}`);
    } catch (err) {
      console.error(`[pool]   Failed to drain ${inst.id}:`, err.message);
    }
  }
  return results;
}

// Kill a specific instance.
export async function killInstance(id) {
  const inst = cache.getAll().find((i) => i.id === id);
  if (!inst) throw new Error(`Instance ${id} not found`);

  console.log(`[pool] Killing instance ${inst.id} (${inst.agentName || inst.name})`);

  try {
    await railway.deleteService(inst.serviceId);
  } catch (err) {
    console.warn(`[pool] Failed to delete Railway service:`, err.message);
  }

  cache.remove(inst.serviceId);
  await db.deleteByServiceId(inst.serviceId).catch(() => {});
}

// Dismiss a crashed agent (user-initiated from dashboard).
export async function dismissCrashed(id) {
  const inst = cache.getAll().find((i) => i.id === id && i.status === "crashed");
  if (!inst) throw new Error(`Crashed instance ${id} not found`);

  console.log(`[pool] Dismissing crashed ${inst.id} (${inst.agentName || inst.name})`);

  try {
    await railway.deleteService(inst.serviceId);
  } catch (err) {
    // Service might already be gone
    console.warn(`[pool] Failed to delete Railway service:`, err.message);
  }

  cache.remove(inst.serviceId);
  await db.deleteByServiceId(inst.serviceId).catch(() => {});
}
```

**Step 2: Verify syntax**

Run: `node --check src/pool.js`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/pool.js
git commit -m "refactor: rewrite pool with cache-based tick, no DB status tracking"
```

---

### Task 6: Add `getServiceDomain` to Railway Module

**Files:**
- Modify: `src/railway.js`

The tick loop needs to discover domains for services not yet in cache (e.g. after restart).

**Step 1: Add the function**

```js
// Get the public domain for a service. Returns domain string or null.
export async function getServiceDomain(serviceId) {
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  try {
    const data = await gql(
      `query($serviceId: String!, $environmentId: String!) {
        serviceDomains(serviceId: $serviceId, environmentId: $environmentId) {
          serviceDomains { domain }
          customDomains { domain }
        }
      }`,
      { serviceId, environmentId }
    );
    const sd = data.serviceDomains;
    return sd?.customDomains?.[0]?.domain || sd?.serviceDomains?.[0]?.domain || null;
  } catch {
    return null;
  }
}
```

**Step 2: Commit**

```bash
git add src/railway.js
git commit -m "feat: add getServiceDomain for URL discovery on restart"
```

---

### Task 7: Update API Endpoints

**Files:**
- Modify: `src/index.js`

**Step 1: Update imports and endpoints**

Replace `import * as db from "./db/pool.js";` references with cache reads. Keep `db` import for metadata queries where needed.

Key changes:
- `GET /api/pool/counts` → `cache.getCounts()`
- `GET /api/pool/agents` → `cache.getByStatus("claimed")` (already enriched with metadata)
- `GET /api/pool/status` → `cache.getAll()` + `cache.getCounts()`
- `POST /api/pool/reconcile` → trigger an immediate `tick()` instead
- Add `DELETE /api/pool/crashed/:id` → `pool.dismissCrashed()`

See design doc for full endpoint mapping. The dashboard HTML needs one addition: crashed agent cards with red styling and a "Dismiss" button.

**Step 2: Verify the server starts**

Run: `node --env-file=.env src/index.js` (Ctrl+C after startup message)
Expected: `Pool manager listening on :3001`

**Step 3: Commit**

```bash
git add src/index.js
git commit -m "refactor: update API endpoints to read from cache instead of DB"
```

---

### Task 8: Write Migration Script

**Files:**
- Modify: `src/db/migrate.js`

**Step 1: Rewrite migration**

```js
import { sql } from "./connection.js";

async function migrate() {
  // If old table exists, rename and clean up
  const oldTable = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'pool_instances'
  `;

  if (oldTable.rows.length > 0) {
    console.log("Migrating pool_instances → agent_metadata...");

    await sql`ALTER TABLE pool_instances RENAME TO agent_metadata`;

    // Drop unused columns (ignore errors if already dropped)
    const dropCols = ["railway_url", "status", "health_check_failures", "updated_at", "join_url"];
    for (const col of dropCols) {
      try {
        await sql`ALTER TABLE agent_metadata DROP COLUMN IF EXISTS ${sql(col)}`;
      } catch (err) {
        console.warn(`  Could not drop ${col}: ${err.message}`);
      }
    }

    // Rename columns
    try {
      await sql`ALTER TABLE agent_metadata RENAME COLUMN claimed_by TO agent_name`;
    } catch (err) {
      console.warn(`  Could not rename claimed_by: ${err.message}`);
    }

    // Delete non-claimed rows (no useful metadata)
    const deleted = await sql`DELETE FROM agent_metadata WHERE agent_name IS NULL`;
    console.log(`  Cleaned ${deleted.count || 0} non-claimed rows`);

    console.log("Migration complete.");
  } else {
    // Fresh install — create agent_metadata directly
    await sql`
      CREATE TABLE IF NOT EXISTS agent_metadata (
        id TEXT PRIMARY KEY,
        railway_service_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        conversation_id TEXT,
        invite_url TEXT,
        instructions TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log("Created agent_metadata table.");
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

**Step 2: Test migration on staging**

Run against staging Neon branch: `node --env-file=.env src/db/migrate.js`
Expected: `Migrating pool_instances → agent_metadata...` then `Migration complete.`

**Step 3: Commit**

```bash
git add src/db/migrate.js
git commit -m "refactor: migration script to rename pool_instances → agent_metadata"
```

---

### Task 9: Clean Up

**Files:**
- Modify: `src/db/pool.js` — already done in Task 4
- Delete: `src/db/seed-existing.js` (if no longer needed)
- Modify: `package.json` — verify no unused deps

**Step 1: Check if seed-existing.js is still relevant**

Read `src/db/seed-existing.js` — if it references old schema columns, delete it.

**Step 2: Verify no dead imports**

Run: `node --check src/index.js && node --check src/pool.js && node --check src/cache.js && node --check src/status.js`
Expected: No errors.

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass (cache + status tests).

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up dead code and unused files"
```

---

### Task 10: Deploy and Verify on Staging

**Step 1: Run migration on staging Neon**

```bash
node --env-file=.env src/db/migrate.js
```

**Step 2: Deploy to staging**

Push to trigger Railway deploy, or deploy manually.

**Step 3: Verify**

```bash
# Check version
curl https://convos-agents-dev.up.railway.app/version

# Check counts (should rebuild from Railway on first tick)
curl https://convos-agents-dev.up.railway.app/api/pool/counts

# Check dashboard loads
open https://convos-agents-dev.up.railway.app
```

**Step 4: Launch a test agent from the dashboard**

Verify the full flow: launch → QR code → agent responds → kill → replenish.
