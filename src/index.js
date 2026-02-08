import express from "express";
import * as pool from "./pool.js";
import * as db from "./db/pool.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const POOL_API_KEY = process.env.POOL_API_KEY;

const app = express();
app.disable("x-powered-by");
app.use(express.json());

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== POOL_API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  return next();
}

// --- Routes ---

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Simple claim form
app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Concierge Pool</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;width:100%;max-width:480px}
  h1{font-size:1.25rem;margin-bottom:1.5rem;color:#fff}
  label{display:block;font-size:.875rem;color:#aaa;margin-bottom:.375rem}
  input,textarea{width:100%;padding:.625rem;background:#111;border:1px solid #333;border-radius:6px;color:#fff;font:inherit;margin-bottom:1rem}
  textarea{resize:vertical;min-height:100px}
  input:focus,textarea:focus{outline:none;border-color:#666}
  button{width:100%;padding:.75rem;background:#fff;color:#000;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:.9rem}
  button:hover{background:#ddd}
  button:disabled{opacity:.5;cursor:not-allowed}
  .result{margin-top:1.5rem;padding:1rem;border-radius:8px;background:#111;border:1px solid #333;display:none}
  .result a{color:#7df;word-break:break-all}
  .result .label{font-size:.75rem;color:#888;margin-bottom:.25rem}
  .result .value{margin-bottom:.75rem}
  .error{color:#f77}
</style>
</head><body>
<div class="card">
  <h1>Claim a Concierge</h1>
  <form id="f">
    <label for="name">Name</label>
    <input id="name" name="name" placeholder="e.g. tokyo-trip-planner" required>
    <label for="instructions">Instructions</label>
    <textarea id="instructions" name="instructions" placeholder="You are a helpful trip planner for Tokyo..." required></textarea>
    <button type="submit" id="btn">Claim Instance</button>
  </form>
  <div class="result" id="result"></div>
</div>
<script>
const f=document.getElementById('f'),btn=document.getElementById('btn'),result=document.getElementById('result');
f.onsubmit=async e=>{
  e.preventDefault();
  btn.disabled=true;btn.textContent='Claiming...';result.style.display='none';
  try{
    const res=await fetch('/api/pool/claim',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer ${POOL_API_KEY}'},
      body:JSON.stringify({conciergeId:f.name.value.trim(),instructions:f.instructions.value.trim()})
    });
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'Claim failed');
    result.innerHTML=
      '<div class="label">Invite URL</div><div class="value"><a href="'+data.inviteUrl+'" target="_blank">'+data.inviteUrl+'</a></div>'+
      '<div class="label">Conversation ID</div><div class="value">'+data.conversationId+'</div>'+
      '<div class="label">Instance ID</div><div class="value">'+data.instanceId+'</div>';
    result.style.display='block';
  }catch(err){
    result.innerHTML='<div class="error">'+err.message+'</div>';
    result.style.display='block';
  }finally{btn.disabled=false;btn.textContent='Claim Instance'}
};
</script>
</body></html>`);
});

// Pool status overview
app.get("/api/pool/status", requireAuth, async (_req, res) => {
  try {
    const counts = await db.countByStatus();
    const instances = await db.listAll();
    res.json({ counts, instances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim an idle instance and provision it with instructions.
// This is what the webapp calls.
app.post("/api/pool/claim", requireAuth, async (req, res) => {
  const { conciergeId, instructions } = req.body || {};
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions (string) is required" });
  }
  if (!conciergeId || typeof conciergeId !== "string") {
    return res.status(400).json({ error: "conciergeId (string) is required" });
  }

  try {
    const result = await pool.provision(conciergeId, instructions);
    if (!result) {
      return res.status(503).json({
        error: "No idle instances available. Try again in a few minutes.",
      });
    }
    res.json(result);
  } catch (err) {
    console.error("[api] Claim failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Redirect to the setup page of an idle instance
app.get("/api/pool/setup", requireAuth, async (_req, res) => {
  try {
    const instance = await db.findIdle();
    if (!instance) {
      return res.status(503).json({
        error: "No idle instances available. Try again in a few minutes.",
      });
    }
    res.redirect(`${instance.railway_url}/setup`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger a replenish cycle
app.post("/api/pool/replenish", requireAuth, async (_req, res) => {
  try {
    await pool.tick();
    const counts = await db.countByStatus();
    res.json({ ok: true, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Background tick ---
// Poll provisioning instances and replenish every 30 seconds.
const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL_MS || "30000", 10);
setInterval(() => {
  pool.tick().catch((err) => console.error("[tick] Error:", err));
}, TICK_INTERVAL);

// Run initial tick on startup
setTimeout(() => {
  pool.tick().catch((err) => console.error("[tick] Initial tick error:", err));
}, 2000);

app.listen(PORT, () => {
  console.log(`Pool manager listening on :${PORT}`);
});
