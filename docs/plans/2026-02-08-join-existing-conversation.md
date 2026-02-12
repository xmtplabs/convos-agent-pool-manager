# Join Existing Conversation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow pool-managed agents to join an existing Convos conversation (via invite link) with preloaded instructions and introduce themselves, as an alternative to the current "create new conversation" flow.

**Architecture:** Extends the existing claim/provision pipeline with an optional `joinUrl` parameter. When present, the clawdbot instance joins the existing conversation instead of creating a new one, then sends an introduction message. Three repos are touched: pool manager (API + dashboard), clawdbot-railway-template (join branch in `/pool/provision`), and OpenClaw convos plugin (new `/convos/join` HTTP route).

**Tech Stack:** Node.js/Express, Neon Postgres, XMTP via convos-node-sdk, OpenClaw plugin SDK

---

## Repo Map

| Repo | Local Path | Role |
|------|-----------|------|
| **concierge-pool-manager** | `/Users/saulxmtp/Developer/concierge-pool-manager` | Pool API + dashboard UI |
| **clawdbot-railway-template** | `github.com/saulmc/clawdbot-railway-template` | Instance server deployed by pool |
| **openclaw** | `github.com/xmtplabs/openclaw` (branch: `saul/concierge-instructions-md`) | Agent framework with Convos channel plugin |

## Current Flow (for context)

```
Pool Manager                    Clawdbot (server.js)            OpenClaw Convos Plugin
─────────────                   ────────────────────            ──────────────────────
POST /api/pool/claim
  { agentId, instructions }
  → pool.provision()
    → POST {url}/pool/provision
      { instructions, name }
                                → writes INSTRUCTIONS.md
                                → POST /convos/conversation     → client.createConversation()
                                  { name }
                                ← { inviteUrl, conversationId,
                                    qrDataUrl }
```

## Target Flow

```
Pool Manager                    Clawdbot (server.js)            OpenClaw Convos Plugin
─────────────                   ────────────────────            ──────────────────────
POST /api/pool/claim
  { agentId, instructions,
    joinUrl }
  → pool.provision()
    → POST {url}/pool/provision
      { instructions, name,
        joinUrl }
                                → writes INSTRUCTIONS.md
                                → POST /convos/join             → client.joinConversation()
                                  { inviteUrl }
                                ← { conversationId, status }
                                → POST /convos/conversation/send → client.sendMessage()
                                  { conversationId, message }
                                ← { ok }
```

---

## Task 1: Add `POST /convos/join` HTTP route to OpenClaw convos plugin

> **Repo:** openclaw (branch `saul/concierge-instructions-md`)

This is the foundation — expose `client.joinConversation()` as an HTTP route so the clawdbot template can call it.

**Files:**
- Modify: `extensions/convos/index.ts` (after the `/convos/conversation` route, around line 416)

**Step 1: Add the `/convos/join` HTTP route**

Insert this route registration after the existing `/convos/conversation` route block (after line 416):

```typescript
    api.registerHttpRoute({
      path: "/convos/join",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const inviteUrl = typeof body.inviteUrl === "string" ? body.inviteUrl : undefined;
          if (!inviteUrl) {
            jsonResponse(res, 400, { error: "inviteUrl (string) is required" });
            return;
          }
          const accountId = typeof body.accountId === "string" ? body.accountId : undefined;

          const runtime = getConvosRuntime();
          const cfg = runtime.config.loadConfig() as OpenClawConfig;
          const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId });
          const client = getClientForAccount(account.accountId);
          if (!client) {
            jsonResponse(res, 503, {
              error: "Convos channel client not running. Start the channel first.",
            });
            return;
          }

          const result = await client.joinConversation(inviteUrl);
          jsonResponse(res, 200, {
            conversationId: result.conversationId,
            status: result.status,
          });
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
```

**Step 2: Add the `/convos/conversation/send` HTTP route**

Insert after the `/convos/join` route. This lets the clawdbot template send an intro message after joining:

```typescript
    api.registerHttpRoute({
      path: "/convos/conversation/send",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
          const message = typeof body.message === "string" ? body.message : undefined;
          if (!conversationId || !message) {
            jsonResponse(res, 400, { error: "conversationId and message (strings) are required" });
            return;
          }
          const accountId = typeof body.accountId === "string" ? body.accountId : undefined;

          const runtime = getConvosRuntime();
          const cfg = runtime.config.loadConfig() as OpenClawConfig;
          const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId });
          const client = getClientForAccount(account.accountId);
          if (!client) {
            jsonResponse(res, 503, {
              error: "Convos channel client not running. Start the channel first.",
            });
            return;
          }

          await client.sendMessage(conversationId, message);
          jsonResponse(res, 200, { ok: true });
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
```

**Step 3: Verify the plugin loads**

Run: `cd <openclaw-dir> && pnpm openclaw plugins list`

Expected: Convos plugin appears in the list without errors.

**Step 4: Commit**

```bash
git add extensions/convos/index.ts
git commit -m "feat(convos): add /convos/join and /convos/conversation/send HTTP routes

Expose joinConversation() and sendMessage() as HTTP routes for
the clawdbot pool template to call when joining existing conversations."
```

---

## Task 2: Add join support to clawdbot `/pool/provision` endpoint

> **Repo:** clawdbot-railway-template (`github.com/saulmc/clawdbot-railway-template`)

Extend the existing `/pool/provision` endpoint to handle an optional `joinUrl` parameter. When present, join the conversation instead of creating one, then send an intro message.

**Files:**
- Modify: `src/server.js:348-428` (the `/pool/provision` route handler)

**Step 1: Extract `joinUrl` from request body and branch logic**

Replace the existing `/pool/provision` handler (lines 348-428) with:

```javascript
app.post("/pool/provision", requirePoolAuth, async (req, res) => {
  if (!poolReady) {
    return res.status(503).json({ error: "Instance not ready yet" });
  }
  if (poolProvisioned) {
    return res.status(409).json({
      error: "Already provisioned",
      conversationId: poolConversationId,
      inviteUrl: poolInviteUrl,
      qrDataUrl: poolQrDataUrl,
    });
  }

  const { instructions, name, joinUrl } = req.body || {};
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions (string) is required" });
  }

  const agentName = (typeof name === "string" && name.trim()) || "Agent";

  try {
    // Write instructions to INSTRUCTIONS.md in the workspace directory.
    // OpenClaw reads INSTRUCTIONS.md at runtime as operator-provided directives.
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "INSTRUCTIONS.md"), instructions);
    console.log("[pool] Wrote instructions to INSTRUCTIONS.md");

    let result;
    let usedFastPath = false;

    if (joinUrl && typeof joinUrl === "string") {
      // --- Join existing conversation flow ---
      console.log(`[pool] Join mode: joining conversation via ${joinUrl.slice(0, 40)}...`);

      // Join the conversation via the Convos plugin's HTTP route.
      const joinResult = await convosHttp("/convos/join", {
        method: "POST",
        body: { inviteUrl: joinUrl },
      });
      console.log(`[pool] Joined conversation: ${joinResult.conversationId} (status: ${joinResult.status})`);

      if (!joinResult.conversationId) {
        return res.status(202).json({
          status: "waiting_for_acceptance",
          message: "Join request sent but not yet accepted by group admin.",
        });
      }

      // Send an introduction message.
      const introMessage = `Hi! I'm ${agentName}. I've joined this conversation and I'm ready to help. Let me know what you need!`;
      try {
        await convosHttp("/convos/conversation/send", {
          method: "POST",
          body: { conversationId: joinResult.conversationId, message: introMessage },
        });
        console.log("[pool] Sent intro message");
      } catch (introErr) {
        console.warn("[pool] Failed to send intro message:", introErr.message);
      }

      poolProvisioned = true;
      poolConversationId = joinResult.conversationId;
      // No invite URL or QR for join mode — conversation already exists.
      poolInviteUrl = joinUrl;
      poolQrDataUrl = null;

      result = {
        conversationId: joinResult.conversationId,
        inviteUrl: joinUrl,
        qrDataUrl: null,
        joined: true,
      };
    } else {
      // --- Create new conversation flow (existing behavior) ---
      try {
        result = await convosHttp("/convos/conversation", {
          method: "POST",
          body: { name: agentName },
        });
        usedFastPath = true;
        console.log("[pool] Fast path: conversation created via running client");
      } catch (fastErr) {
        console.log(`[pool] Fast path unavailable (${fastErr.message}), falling back to setup...`);
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            result = await convosHttp("/convos/setup", {
              method: "POST",
              body: { env: XMTP_ENV, name: agentName, force: true },
            });
            break;
          } catch (err) {
            if (attempt === 5) throw err;
            console.log(`[pool] Setup attempt ${attempt} failed, retrying in 2s...`);
            await sleep(2000);
          }
        }
      }

      poolProvisioned = true;
      poolConversationId = result.conversationId;
      poolInviteUrl = result.inviteUrl;
      poolQrDataUrl = result.qrDataUrl;

      // Only need join polling for the slow (setup) path.
      if (!usedFastPath) {
        pollForJoinAndComplete();
      }
    }

    console.log(`[pool] Provisioned. conversationId=${poolConversationId}`);
    if (poolInviteUrl) console.log(`[pool] Invite URL: ${poolInviteUrl}`);

    res.json({
      inviteUrl: result.inviteUrl || null,
      qrDataUrl: result.qrDataUrl || null,
      conversationId: result.conversationId,
      joined: !!result.joined,
    });
  } catch (err) {
    console.error("[pool] Provision failed:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});
```

**Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: support joining existing conversations in /pool/provision

When joinUrl is provided, join the conversation instead of creating a
new one, then send an introduction message. Falls back to existing
create-conversation flow when joinUrl is absent."
```

---

## Task 3: Extend pool manager `provision()` to pass `joinUrl` through

> **Repo:** concierge-pool-manager (this repo)

**Files:**
- Modify: `src/pool.js:111-165`

**Step 1: Update the `provision()` function signature and body**

Replace the `provision` function (lines 111-165) with:

```javascript
// Launch an agent — provision an idle instance with instructions.
// If joinUrl is provided, join an existing conversation instead of creating one.
// Returns { inviteUrl, qrDataUrl, conversationId, joined } or null if no idle instances.
export async function provision(agentId, instructions, joinUrl) {
  // 1. Atomically claim an idle instance
  const instance = await db.claimOne(agentId);
  if (!instance) return null;

  console.log(`[pool] Launching ${instance.id} for agentId="${agentId}"${joinUrl ? " (join mode)" : ""}`);

  // 2. Call /pool/provision on the instance
  const provisionBody = { instructions, name: agentId };
  if (joinUrl) provisionBody.joinUrl = joinUrl;

  console.log(`[pool] POST ${instance.railway_url}/pool/provision name="${provisionBody.name}"${joinUrl ? ` joinUrl="${joinUrl.slice(0, 40)}..."` : ""}`);
  const res = await fetch(`${instance.railway_url}/pool/provision`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${POOL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(provisionBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Provision failed on ${instance.id}: ${res.status} ${text}`);
  }

  const result = await res.json();

  // 3. Store the invite URL, conversation ID, and instructions
  await db.setClaimed(instance.id, {
    inviteUrl: result.inviteUrl || joinUrl || null,
    conversationId: result.conversationId,
    instructions,
  });

  // 4. Rename the Railway service so it's identifiable in the dashboard
  try {
    await railway.renameService(instance.railway_service_id, `convos-agent-${agentId}`);
    console.log(`[pool] Renamed ${instance.id} → convos-agent-${agentId}`);
  } catch (err) {
    console.warn(`[pool] Failed to rename ${instance.id}:`, err.message);
  }

  console.log(`[pool] Provisioned ${instance.id}: ${result.joined ? "joined" : "created"} conversation ${result.conversationId}`);

  // 5. Trigger backfill (don't await — fire and forget)
  replenish().catch((err) => console.error("[pool] Backfill error:", err));

  return {
    inviteUrl: result.inviteUrl || null,
    qrDataUrl: result.qrDataUrl || null,
    conversationId: result.conversationId,
    instanceId: instance.id,
    joined: !!result.joined,
  };
}
```

**Step 2: Commit**

```bash
git add src/pool.js
git commit -m "feat: pass joinUrl through provision flow

provision() now accepts optional joinUrl parameter and forwards it
to the instance's /pool/provision endpoint."
```

---

## Task 4: Update pool manager API route to accept `joinUrl`

> **Repo:** concierge-pool-manager (this repo)

**Files:**
- Modify: `src/index.js:747-768`

**Step 1: Update the `/api/pool/claim` route handler**

Replace lines 747-768 with:

```javascript
app.post("/api/pool/claim", requireAuth, async (req, res) => {
  const { agentId, instructions, joinUrl } = req.body || {};
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions (string) is required" });
  }
  if (!agentId || typeof agentId !== "string") {
    return res.status(400).json({ error: "agentId (string) is required" });
  }
  if (joinUrl && typeof joinUrl !== "string") {
    return res.status(400).json({ error: "joinUrl must be a string if provided" });
  }

  try {
    const result = await pool.provision(agentId, instructions, joinUrl || undefined);
    if (!result) {
      return res.status(503).json({
        error: "No idle instances available. Try again in a few minutes.",
      });
    }
    res.json(result);
  } catch (err) {
    console.error("[api] Launch failed:", err);
    res.status(500).json({ error: err.message });
  }
});
```

**Step 2: Commit**

```bash
git add src/index.js
git commit -m "feat: accept optional joinUrl in /api/pool/claim

When joinUrl is provided, the agent joins an existing conversation
instead of creating a new one."
```

---

## Task 5: Add "Join Conversation" toggle to dashboard UI

> **Repo:** concierge-pool-manager (this repo)

**Files:**
- Modify: `src/index.js` (dashboard HTML form around lines 508-519, and JS handler around lines 673-690)

**Step 1: Add mode toggle and join URL input to the form**

Replace lines 508-518 (the form HTML) with:

```html
      <form id="f">
        <div class="mode-toggle">
          <button type="button" class="mode-btn active" id="mode-create">New Conversation</button>
          <button type="button" class="mode-btn" id="mode-join">Join Existing</button>
        </div>
        <div class="setting-group" id="join-url-group" style="display:none">
          <label class="setting-label" for="join-url">Conversation Link</label>
          <input id="join-url" name="joinUrl" class="setting-input" placeholder="Paste a Convos invite link..." />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="name">Name</label>
          <input id="name" name="name" class="setting-input" placeholder="e.g. Tokyo Trip" required />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="instructions">Instructions</label>
          <textarea id="instructions" name="instructions" class="setting-input" placeholder="You are a helpful trip planner for Tokyo..." required></textarea>
        </div>
        <button type="submit" id="btn" class="btn-primary" disabled>Launch Agent</button>
      </form>
```

**Step 2: Add CSS for the mode toggle**

Add these styles inside the `<style>` block (after the existing `.btn-primary` styles):

```css
    .mode-toggle {
      display: flex;
      gap: 0;
      margin-bottom: 20px;
      border: 1px solid #E5E5E5;
      border-radius: 8px;
      overflow: hidden;
    }

    .mode-btn {
      flex: 1;
      padding: 8px 16px;
      border: none;
      background: #F5F5F5;
      color: #666;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }

    .mode-btn.active {
      background: #000;
      color: #FFF;
    }

    .mode-btn:hover:not(.active) {
      background: #E8E8E8;
    }
```

**Step 3: Add mode toggle JS logic**

Add this inside the `<script>` block, before the `// Launch form` comment (before line 671):

```javascript
    // Mode toggle
    var modeCreate=document.getElementById('mode-create');
    var modeJoin=document.getElementById('mode-join');
    var joinUrlGroup=document.getElementById('join-url-group');
    var joinUrlInput=document.getElementById('join-url');
    var isJoinMode=false;

    modeCreate.onclick=function(){
      isJoinMode=false;
      modeCreate.classList.add('active');modeJoin.classList.remove('active');
      joinUrlGroup.style.display='none';
      joinUrlInput.removeAttribute('required');
      btn.textContent='Launch Agent';
    };
    modeJoin.onclick=function(){
      isJoinMode=true;
      modeJoin.classList.add('active');modeCreate.classList.remove('active');
      joinUrlGroup.style.display='block';
      joinUrlInput.setAttribute('required','required');
      btn.textContent='Join & Launch';
    };
```

**Step 4: Update form submission handler to include joinUrl**

Replace the form submission handler (lines 673-690) with:

```javascript
    // Launch form
    var f=document.getElementById('f'),errorEl=document.getElementById('error');
    f.onsubmit=async function(e){
      e.preventDefault();
      var agentName=f.name.value.trim();
      var payload={agentId:agentName,instructions:f.instructions.value.trim()};
      if(isJoinMode){
        var jUrl=joinUrlInput.value.trim();
        if(!jUrl){errorEl.textContent='Conversation link is required';errorEl.style.display='block';return;}
        payload.joinUrl=jUrl;
      }
      launching=true;btn.disabled=true;btn.textContent=isJoinMode?'Joining...':'Launching...';errorEl.style.display='none';
      try{
        var res=await fetch('/api/pool/claim',{method:'POST',headers:authHeaders,
          body:JSON.stringify(payload)
        });
        var data=await res.json();
        if(!res.ok)throw new Error(data.error||'Launch failed');
        f.reset();
        // Reset mode toggle
        if(isJoinMode){modeCreate.onclick();}
        if(data.joined){
          // Join mode: show success inline instead of QR
          errorEl.style.display='block';
          errorEl.style.background='#D4EDDA';errorEl.style.color='#155724';errorEl.style.borderColor='#C3E6CB';
          errorEl.textContent='Agent "'+agentName+'" joined the conversation successfully!';
          setTimeout(function(){errorEl.style.display='none';errorEl.style.background='';errorEl.style.color='';errorEl.style.borderColor='';},5000);
        }else{
          showQr(agentName||data.instanceId,data.inviteUrl);
        }
        refreshFeed();
      }catch(err){
        errorEl.textContent=err.message;
        errorEl.style.display='block';errorEl.style.background='';errorEl.style.color='';errorEl.style.borderColor='';
      }finally{launching=false;btn.textContent=isJoinMode?'Join & Launch':'Launch Agent';refreshStatus();}
    };
```

**Step 5: Update agent cards to show join mode indicator**

In the `renderFeed` function (around line 595), update the agent card template to show "Joined" badge when appropriate. Replace the agent-header line:

```javascript
        '<div class="agent-header">'+
          '<span class="agent-name">'+name+'</span>'+
          '<span class="agent-uptime">'+timeAgo(a.claimed_at)+'</span>'+
        '</div>'+
```

With:

```javascript
        '<div class="agent-header">'+
          '<span class="agent-name">'+name+'</span>'+
          (!a.invite_url||a.invite_url.startsWith('http')?'':'<span style="font-size:11px;color:#28A745;margin-left:6px">joined</span>')+
          '<span class="agent-uptime">'+timeAgo(a.claimed_at)+'</span>'+
        '</div>'+
```

**Step 6: Commit**

```bash
git add src/index.js
git commit -m "feat: add Join Existing mode to dashboard UI

Adds a toggle between 'New Conversation' and 'Join Existing' modes.
Join mode shows a URL input, sends joinUrl with the claim request,
and shows a success banner instead of QR code on completion."
```

---

## Task 6: Add `join_url` column to database

> **Repo:** concierge-pool-manager (this repo)

This stores whether the agent was launched in join mode, for display and audit purposes.

**Files:**
- Modify: `src/db/migrate.js:37-48` (add migration after existing instructions column migration)
- Modify: `src/db/pool.js:38-47` (update `setClaimed` to store `joinUrl`)

**Step 1: Add migration for `join_url` column**

In `src/db/migrate.js`, add after the instructions column migration (after line 48):

```javascript
  // Add join_url column if missing
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'join_url'
      ) THEN
        ALTER TABLE pool_instances ADD COLUMN join_url TEXT;
      END IF;
    END $$
  `;
```

**Step 2: Update `setClaimed` in `src/db/pool.js`**

Replace lines 38-47 with:

```javascript
export async function setClaimed(id, { inviteUrl, conversationId, instructions, joinUrl }) {
  await sql`
    UPDATE pool_instances
    SET invite_url = ${inviteUrl},
        conversation_id = ${conversationId},
        instructions = ${instructions || null},
        join_url = ${joinUrl || null},
        updated_at = NOW()
    WHERE id = ${id}
  `;
}
```

**Step 3: Update `pool.provision()` to pass `joinUrl` to `setClaimed`**

In `src/pool.js`, in the `provision()` function's `setClaimed` call, add `joinUrl`:

```javascript
  await db.setClaimed(instance.id, {
    inviteUrl: result.inviteUrl || joinUrl || null,
    conversationId: result.conversationId,
    instructions,
    joinUrl: joinUrl || null,
  });
```

**Step 4: Run migration**

Run: `npm run db:migrate`

Expected: "Migration complete."

**Step 5: Commit**

```bash
git add src/db/migrate.js src/db/pool.js src/pool.js
git commit -m "feat: add join_url column to track join-mode launches

Stores the original invite URL used for join-mode agents, separate
from the invite_url field."
```

---

## Task 7: Manual integration test

> **Repo:** All three

This is a manual end-to-end test. No automated test infrastructure exists in the pool manager.

**Step 1: Deploy OpenClaw changes**

Push the `saul/concierge-instructions-md` branch with the new routes to a test instance.

**Step 2: Deploy clawdbot template changes**

Push the updated `server.js` to the clawdbot-railway-template repo. Existing pool instances will need to be drained and re-created to pick up the new code.

**Step 3: Deploy pool manager changes**

Run: `npm run db:migrate && npm run dev`

**Step 4: Test the "Create" flow (regression)**

1. Open the pool manager dashboard at `http://localhost:3001`
2. Verify "New Conversation" mode is active by default
3. Enter a name and instructions
4. Click "Launch Agent"
5. Verify QR code modal appears as before

Expected: Existing behavior unchanged.

**Step 5: Test the "Join" flow**

1. Create a Convos conversation from the Convos app and copy its invite link
2. Click "Join Existing" toggle in the dashboard
3. Paste the invite link into the "Conversation Link" field
4. Enter a name and instructions
5. Click "Join & Launch"
6. Verify green success banner appears (no QR modal)
7. Open the Convos conversation — verify the agent's intro message appeared
8. Send a message — verify the agent responds using the provided instructions

Expected: Agent joins conversation, introduces itself, and responds based on INSTRUCTIONS.md.

**Step 6: Verify agent appears in Live Agents feed**

Check that the joined agent appears in the feed with correct name and instructions preview.

---

## Implementation Order

Tasks must be done in this order due to dependencies:

```
Task 1 (OpenClaw: /convos/join route)
  ↓
Task 2 (Clawdbot: join branch in /pool/provision)
  ↓
Task 3 (Pool manager: provision() passthrough)
  ↓
Task 4 (Pool manager: /api/pool/claim route)
  ↓
Task 5 (Pool manager: dashboard UI)
  ↓
Task 6 (Pool manager: database column)
  ↓
Task 7 (Integration test)
```

Tasks 3-6 can be done as a single commit batch if preferred since they're all in this repo.
