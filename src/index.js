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

// Pool counts (no auth — used by the claim form)
app.get("/api/pool/counts", async (_req, res) => {
  try {
    const counts = await db.countByStatus();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple claim form
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Convos Agent Pool</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      background: #FFF;
      min-height: 100vh;
      padding: 32px;
      color: #000;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 520px;
      width: 100%;
      margin: 0 auto;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
    }

    .logo-text {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }

    .status-pills {
      display: flex;
      gap: 8px;
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      padding: 6px 12px;
      background: #F5F5F5;
      border-radius: 20px;
      color: #666;
    }

    .status-pill .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .status-pill.idle .dot { background: #34C759; }
    .status-pill.provisioning .dot { background: #FF9500; }
    .status-pill.claimed .dot { background: #007AFF; }

    .card {
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 24px;
      padding: 32px;
    }

    .card h3 {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 24px;
      letter-spacing: -0.08px;
    }

    .unavailable-msg {
      text-align: center;
      padding: 24px 16px;
      color: #999;
      font-size: 14px;
    }

    .unavailable-msg svg {
      display: block;
      margin: 0 auto 12px;
    }

    .setting-group {
      margin-bottom: 20px;
    }

    .setting-label {
      display: block;
      color: #666;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
    }

    .setting-input {
      width: 100%;
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 15px;
      color: #000;
      font-family: inherit;
      transition: all 0.2s ease;
    }

    .setting-input:focus {
      outline: none;
      border-color: #000;
    }

    .setting-input::placeholder {
      color: #B2B2B2;
    }

    textarea.setting-input {
      resize: vertical;
      min-height: 100px;
    }

    .btn-primary {
      background: #FC4F37;
      color: #FFF;
      border: none;
      border-radius: 40px;
      padding: 18px 32px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      letter-spacing: -0.08px;
      width: 100%;
      margin-top: 4px;
    }

    .btn-primary:hover { opacity: 0.9; }
    .btn-primary:active { transform: scale(0.98); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .result-card {
      margin-top: 24px;
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 24px;
      padding: 32px;
      display: none;
    }

    .result-card h3 {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 20px;
      letter-spacing: -0.08px;
      color: #34C759;
    }

    .qr-container {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .qr-container img {
      border-radius: 16px;
      width: 256px;
      height: 256px;
    }

    .qr-info {
      margin-top: 24px;
      padding: 16px 20px;
      background: #F5F5F5;
      border-radius: 16px;
      width: 100%;
      max-width: 300px;
    }

    .qr-info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #EBEBEB;
    }

    .qr-info-row:last-child { border-bottom: none; }

    .qr-info-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .qr-info-value {
      font-size: 14px;
      font-weight: 500;
      color: #000;
    }

    .invite-url {
      margin-top: 16px;
      padding: 12px 16px;
      background: #F5F5F5;
      border-radius: 12px;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 11px;
      word-break: break-all;
      color: #666;
      cursor: pointer;
      transition: background 0.2s;
      width: 100%;
      max-width: 300px;
      text-align: center;
    }

    .invite-url:hover { background: #EBEBEB; }

    .error-message {
      color: #DC2626;
      font-size: 14px;
      margin-top: 12px;
      padding: 12px 16px;
      background: #FEE2E2;
      border-radius: 12px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <span class="logo-text">Convos Agent Pool</span>
      <div class="status-pills">
        <div class="status-pill idle"><span class="dot"></span><span id="s-idle">-</span> idle</div>
        <div class="status-pill provisioning"><span class="dot"></span><span id="s-prov">-</span> starting</div>
        <div class="status-pill claimed"><span class="dot"></span><span id="s-claim">-</span> claimed</div>
      </div>
    </header>

    <div class="card">
      <h3>Claim an Agent</h3>
      <div id="unavailable" class="unavailable-msg" style="display:none">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#FF9500" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="10">
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
          </circle>
        </svg>
        No idle instances available. Waiting for instances to start...
      </div>
      <form id="f">
        <div class="setting-group">
          <label class="setting-label" for="name">Name</label>
          <input id="name" name="name" class="setting-input" placeholder="e.g. tokyo-trip-planner" required />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="instructions">Instructions</label>
          <textarea id="instructions" name="instructions" class="setting-input" placeholder="You are a helpful trip planner for Tokyo..." required></textarea>
        </div>
        <button type="submit" id="btn" class="btn-primary" disabled>Claim Instance</button>
      </form>
    </div>

    <div class="result-card" id="result">
      <h3>Agent Claimed</h3>
      <div class="qr-container">
        <img id="result-qr" alt="Scan to connect" />
        <div class="qr-info">
          <div class="qr-info-row">
            <span class="qr-info-label">Agent</span>
            <span class="qr-info-value" id="result-agent"></span>
          </div>
          <div class="qr-info-row">
            <span class="qr-info-label">Instance</span>
            <span class="qr-info-value" id="result-instance"></span>
          </div>
        </div>
        <div class="invite-url" id="result-invite" onclick="copyInvite(this)" title="Click to copy"></div>
      </div>
    </div>
    <div class="error-message" id="error"></div>
  </div>

  <script>
    function copyInvite(el){
      var text=el.textContent.trim();
      navigator.clipboard.writeText(text).then(function(){
        var original=el.textContent;
        el.textContent='Copied!';
        el.style.background='#D4EDDA';el.style.color='#155724';
        setTimeout(function(){el.textContent=original;el.style.background='';el.style.color='';},1500);
      });
    }

    const f=document.getElementById('f'),btn=document.getElementById('btn');
    const resultCard=document.getElementById('result'),errorEl=document.getElementById('error');
    const resultQr=document.getElementById('result-qr'),resultAgent=document.getElementById('result-agent');
    const resultInstance=document.getElementById('result-instance'),resultInvite=document.getElementById('result-invite');
    const sIdle=document.getElementById('s-idle'),sProv=document.getElementById('s-prov'),sClaim=document.getElementById('s-claim');
    const unavail=document.getElementById('unavailable');
    let claiming=false;

    async function refreshStatus(){
      try{
        const res=await fetch('/api/pool/counts');
        const c=await res.json();
        sIdle.textContent=c.idle;sProv.textContent=c.provisioning;sClaim.textContent=c.claimed;
        if(!claiming){
          if(c.idle>0){btn.disabled=false;unavail.style.display='none'}
          else{btn.disabled=true;unavail.style.display='block'}
        }
      }catch{}
    }
    refreshStatus();
    setInterval(refreshStatus,10000);

    f.onsubmit=async e=>{
      e.preventDefault();
      claiming=true;btn.disabled=true;btn.textContent='Claiming...';
      resultCard.style.display='none';errorEl.style.display='none';
      try{
        const res=await fetch('/api/pool/claim',{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer ${POOL_API_KEY}'},
          body:JSON.stringify({agentId:f.name.value.trim(),instructions:f.instructions.value.trim()})
        });
        const data=await res.json();
        if(!res.ok)throw new Error(data.error||'Claim failed');
        resultQr.src=data.qrDataUrl;
        resultAgent.textContent=f.name.value.trim();
        resultInstance.textContent=data.instanceId;
        resultInvite.textContent=data.inviteUrl;
        resultCard.style.display='block';
      }catch(err){
        errorEl.textContent=err.message;
        errorEl.style.display='block';
      }finally{claiming=false;btn.textContent='Claim Instance';refreshStatus()}
    };
  </script>
</body>
</html>`);
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
  const { agentId, instructions } = req.body || {};
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions (string) is required" });
  }
  if (!agentId || typeof agentId !== "string") {
    return res.status(400).json({ error: "agentId (string) is required" });
  }

  try {
    const result = await pool.provision(agentId, instructions);
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
