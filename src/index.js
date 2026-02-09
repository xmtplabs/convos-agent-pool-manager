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

// Version — check this to verify what code is deployed.
const BUILD_VERSION = "2026-02-08T23:pool-v2";
app.get("/version", (_req, res) => res.json({ version: BUILD_VERSION }));

// Pool counts (no auth — used by the launch form)
app.get("/api/pool/counts", async (_req, res) => {
  try {
    const counts = await db.countByStatus();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List launched agents (no auth — used by the page)
app.get("/api/pool/agents", async (_req, res) => {
  try {
    const agents = await db.listClaimed();
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kill all launched instances (returns list of IDs so frontend can track)
app.delete("/api/pool/instances", requireAuth, async (_req, res) => {
  try {
    const agents = await db.listClaimed();
    res.json({ ids: agents.map((a) => a.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kill a launched instance
app.delete("/api/pool/instances/:id", requireAuth, async (req, res) => {
  try {
    await pool.killInstance(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[api] Kill failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard page
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
      max-width: 900px;
      width: 100%;
      margin: 0 auto;
    }

    /* Header — matches /setup */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
    }

    .logo-container {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .logo-text {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: #666;
      padding: 6px 12px;
      background: #F5F5F5;
      border-radius: 20px;
    }

    .status-badge .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }

    .status-badge.ready .dot { background: #34C759; }
    .status-badge.starting .dot { background: #FF9500; }
    .status-badge.claimed .dot { background: #007AFF; }

    /* Two-column grid — matches /setup */
    .main-content {
      display: grid;
      grid-template-columns: 1fr 300px;
      gap: 24px;
      margin-bottom: 24px;
    }

    @media (max-width: 768px) {
      .main-content {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 24px;
      padding: 32px;
    }

    .card h3 {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 20px;
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

    .setting-group { margin-bottom: 20px; }

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

    .setting-input:focus { outline: none; border-color: #000; }
    .setting-input::placeholder { color: #B2B2B2; }
    textarea.setting-input { resize: vertical; min-height: 80px; }

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

    .mode-toggle {
      display: flex;
      gap: 4px;
      padding: 4px;
      margin-bottom: 20px;
      background: #F5F5F5;
      border-radius: 12px;
    }

    .mode-btn {
      flex: 1;
      padding: 10px 16px;
      border: none;
      background: transparent;
      color: #666;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      border-radius: 8px;
    }

    .mode-btn.active {
      background: #FFF;
      color: #000;
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    .mode-btn:hover:not(.active) {
      color: #333;
    }

    .success-banner {
      display: none;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      background: #F0FDF4;
      border: 1px solid #BBF7D0;
      border-radius: 16px;
      margin-top: 16px;
    }

    .success-banner.active {
      display: flex;
    }

    .success-banner svg {
      flex-shrink: 0;
    }

    .success-banner .success-text {
      font-size: 14px;
      font-weight: 500;
      color: #166534;
    }

    .success-banner .success-sub {
      font-size: 13px;
      color: #15803D;
      margin-top: 2px;
    }

    .btn-secondary {
      background: #F5F5F5;
      color: #000;
      border: none;
      border-radius: 12px;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-secondary:hover { background: #EBEBEB; }

    .btn-danger {
      background: #FEE2E2;
      color: #DC2626;
      border: none;
      border-radius: 12px;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-danger:hover { background: #FECACA; }

    .error-message {
      color: #DC2626;
      font-size: 14px;
      margin-top: 12px;
      padding: 12px 16px;
      background: #FEE2E2;
      border-radius: 12px;
      display: none;
    }

    /* Pool controls sidebar */
    .pool-controls-card {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .pool-info {
      padding: 16px 20px;
      background: #F5F5F5;
      border-radius: 16px;
    }

    .pool-info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #EBEBEB;
    }

    .pool-info-row:last-child {
      border-bottom: none;
    }

    .pool-info-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .pool-info-value {
      font-size: 14px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
    }

    .pool-info-value.ready {
      background: #D4EDDA;
      color: #155724;
    }

    .pool-info-value.starting {
      background: #FFF3CD;
      color: #856404;
    }

    .pool-info-value.active {
      background: #D1ECF1;
      color: #0C5460;
    }

    .pool-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .pool-action-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .pool-action-row input {
      width: 56px;
      padding: 8px 4px;
      font-size: 14px;
      text-align: center;
      border: 1px solid #EBEBEB;
      border-radius: 12px;
      font-family: inherit;
      color: #000;
      background: #FFF;
    }

    .pool-action-row input:focus { outline: none; border-color: #000; }

    .pool-action-row .btn-secondary {
      flex: 1;
    }

    /* Agent feed */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 32px 0 16px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .live-count {
      font-size: 13px;
      font-weight: 500;
      color: #999;
    }

    .agent-card {
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 24px;
      padding: 24px 28px;
      margin-bottom: 12px;
    }

    .agent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .agent-name {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.08px;
    }

    .agent-uptime {
      font-size: 13px;
      color: #999;
      font-weight: 500;
    }

    .agent-instructions {
      font-size: 14px;
      color: #666;
      line-height: 1.5;
      margin-bottom: 16px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .agent-actions {
      display: flex;
      gap: 8px;
    }

    .agent-card.destroying {
      opacity: 0.5;
      pointer-events: none;
      position: relative;
    }

    .agent-card.destroying .agent-uptime {
      color: #DC2626;
    }

    @keyframes destroyPulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 0.3; }
    }

    .agent-card.destroying {
      animation: destroyPulse 1.5s ease-in-out infinite;
    }

    /* QR modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }

    .modal-overlay.active {
      display: flex;
    }

    .modal {
      background: #FFF;
      border-radius: 24px;
      padding: 32px;
      max-width: 400px;
      width: 90%;
      text-align: center;
    }

    .modal h3 {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 20px;
      letter-spacing: -0.08px;
    }

    .modal img {
      border-radius: 16px;
      width: 256px;
      height: 256px;
      margin: 0 auto;
      display: block;
    }

    .modal .invite-url {
      margin: 16px auto 0;
      padding: 12px 16px;
      background: #F5F5F5;
      border-radius: 12px;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 11px;
      word-break: break-all;
      color: #666;
      cursor: pointer;
      transition: background 0.2s;
      max-width: 300px;
    }

    .modal .invite-url:hover { background: #EBEBEB; }

    .modal .btn-secondary {
      margin-top: 20px;
      width: 100%;
    }

    .empty-state {
      text-align: center;
      padding: 40px 16px;
      color: #999;
      font-size: 14px;
    }

    @media (max-width: 768px) {
      body { padding: 16px; }

      .header {
        flex-wrap: wrap;
        gap: 12px;
      }

      .header-right {
        flex-wrap: wrap;
        gap: 6px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="logo-container">
        <span class="logo-text">Convos Agent Pool</span>
        <span style="font-size:13px;color:#999;font-weight:400;letter-spacing:0;">Quickly spin up agents and iterate on instructions</span>
      </div>
      <div class="header-right">
        <div class="status-badge ready"><span class="dot"></span><span id="s-idle">-</span> ready</div>
        <div class="status-badge starting"><span class="dot"></span><span id="s-prov">-</span> starting</div>
        <div class="status-badge claimed"><span class="dot"></span><span id="s-alloc">-</span> claimed</div>
      </div>
    </header>

    <div class="main-content">
      <div class="card">
        <h3>Launch an Agent</h3>
        <div id="unavailable" class="unavailable-msg" style="display:none">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#FF9500" stroke-width="1.5">
            <circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="10">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
            </circle>
          </svg>
          No instances ready. Waiting for pool to warm up...
        </div>
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
        <div class="error-message" id="error"></div>
        <div class="success-banner" id="success">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
          <div>
            <div class="success-text" id="success-text"></div>
            <div class="success-sub" id="success-sub">The agent is now active in the conversation.</div>
          </div>
        </div>
      </div>

      <div class="card pool-controls-card">
        <h3>Pool Controls</h3>
        <div class="pool-info">
          <div class="pool-info-row">
            <span class="pool-info-label">Ready</span>
            <span class="pool-info-value ready" id="s-idle2">-</span>
          </div>
          <div class="pool-info-row">
            <span class="pool-info-label">Starting</span>
            <span class="pool-info-value starting" id="s-prov2">-</span>
          </div>
          <div class="pool-info-row">
            <span class="pool-info-label">Claimed</span>
            <span class="pool-info-value active" id="s-alloc2">-</span>
          </div>
        </div>
        <div class="pool-actions">
          <div class="pool-action-row">
            <input id="replenish-count" type="number" min="1" max="20" value="3" />
            <button class="btn-secondary" id="replenish-btn">+ Add</button>
          </div>
          <div class="pool-action-row">
            <button class="btn-danger" id="drain-btn" style="flex:1">Drain Idle</button>
          </div>
        </div>
      </div>
    </div>

    <div class="section-header">
      <span class="section-title">Live Agents</span>
      <span class="live-count" id="live-count"></span>
    </div>
    <div id="feed"></div>
  </div>

  <div class="modal-overlay" id="qr-modal">
    <div class="modal">
      <h3 id="modal-title">QR Code</h3>
      <img id="modal-qr" alt="Scan to connect" />
      <div class="invite-url" id="modal-invite" onclick="copyText(this)" title="Click to copy"></div>
      <button class="btn-secondary" onclick="closeModal()">Close</button>
    </div>
  </div>

  <script>
    const API_KEY='${POOL_API_KEY}';
    const authHeaders={'Authorization':'Bearer '+API_KEY,'Content-Type':'application/json'};

    function copyText(el){
      navigator.clipboard.writeText(el.textContent.trim()).then(function(){
        var orig=el.textContent;
        el.textContent='Copied!';el.style.background='#D4EDDA';el.style.color='#155724';
        setTimeout(function(){el.textContent=orig;el.style.background='';el.style.color='';},1500);
      });
    }

    function timeAgo(dateStr){
      var ms=Date.now()-new Date(dateStr).getTime();
      var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
      if(d>0)return d+'d '+h%24+'h';
      if(h>0)return h+'h '+m%60+'m';
      if(m>0)return m+'m';
      return '<1m';
    }

    // Pool status — header badges + sidebar info
    const sIdle=document.getElementById('s-idle'),sProv=document.getElementById('s-prov'),sAlloc=document.getElementById('s-alloc');
    const sIdle2=document.getElementById('s-idle2'),sProv2=document.getElementById('s-prov2'),sAlloc2=document.getElementById('s-alloc2');
    const unavail=document.getElementById('unavailable'),btn=document.getElementById('btn');
    const liveCount=document.getElementById('live-count');
    let launching=false;

    async function refreshStatus(){
      try{
        var res=await fetch('/api/pool/counts');
        var c=await res.json();
        sIdle.textContent=c.idle;sProv.textContent=c.provisioning;sAlloc.textContent=c.claimed;
        sIdle2.textContent=c.idle;sProv2.textContent=c.provisioning;sAlloc2.textContent=c.claimed;
        if(!launching){
          if(c.idle>0){btn.disabled=false;unavail.style.display='none'}
          else{btn.disabled=true;unavail.style.display='block'}
        }
      }catch{}
    }

    // Agent feed
    const feed=document.getElementById('feed');
    var agentsCache=[];

    async function refreshFeed(){
      try{
        var res=await fetch('/api/pool/agents');
        agentsCache=await res.json();
        renderFeed();
      }catch{}
    }

    function renderFeed(){
      liveCount.textContent=agentsCache.length?agentsCache.length+' running':'';
      if(!agentsCache.length){
        feed.innerHTML='<div class="empty-state">No live agents yet. Launch one above.</div>';
        return;
      }
      feed.innerHTML=agentsCache.map(function(a){
        var name=(a.claimed_by||a.id).replace(/&/g,'&amp;').replace(/</g,'&lt;');
        var instr=(a.instructions||'No instructions').replace(/&/g,'&amp;').replace(/</g,'&lt;');
        return '<div class="agent-card" id="agent-'+a.id+'">'+
          '<div class="agent-header">'+
            '<span class="agent-name">'+name+'</span>'+
            '<span class="agent-uptime">'+timeAgo(a.claimed_at)+'</span>'+
          '</div>'+
          '<div class="agent-instructions">'+instr+'</div>'+
          '<div class="agent-actions">'+
            '<button class="btn-secondary" data-qr="'+a.id+'">Show QR</button>'+
            '<button class="btn-danger" data-kill="'+a.id+'">Kill</button>'+
          '</div>'+
        '</div>';
      }).join('');
    }

    // Event delegation for agent actions
    feed.onclick=function(e){
      var qrId=e.target.getAttribute('data-qr');
      if(qrId){
        var a=agentsCache.find(function(x){return x.id===qrId;});
        if(a)showQr(a.claimed_by||a.id,a.invite_url||'');
        return;
      }
      var killId=e.target.getAttribute('data-kill');
      if(killId){
        var a2=agentsCache.find(function(x){return x.id===killId;});
        if(a2)killAgent(a2.id,a2.claimed_by||a2.id);
      }
    };

    // QR modal
    var modal=document.getElementById('qr-modal');
    function showQr(name,url){
      document.getElementById('modal-title').textContent=name;
      // Generate QR via a free API
      document.getElementById('modal-qr').src='https://api.qrserver.com/v1/create-qr-code/?size=256x256&data='+encodeURIComponent(url);
      document.getElementById('modal-invite').textContent=url;
      modal.classList.add('active');
    }
    function closeModal(){modal.classList.remove('active');}
    modal.onclick=function(e){if(e.target===modal)closeModal();};

    // Kill single agent
    function markDestroying(id){
      var card=document.getElementById('agent-'+id);
      if(card){
        card.classList.add('destroying');
        var uptime=card.querySelector('.agent-uptime');
        if(uptime)uptime.textContent='Destroying...';
      }
    }

    async function killOne(id){
      markDestroying(id);
      var res=await fetch('/api/pool/instances/'+id,{method:'DELETE',headers:authHeaders});
      var data=await res.json();
      if(!res.ok)throw new Error(data.error||'Kill failed');
      var card=document.getElementById('agent-'+id);
      if(card)card.remove();
      return id;
    }

    async function killAgent(id,name){
      if(!confirm('Are you sure you want to kill "'+name+'"? This will delete the Railway service permanently.'))return;
      try{
        await killOne(id);
        refreshStatus();
      }catch(err){
        alert('Failed to kill: '+err.message);
        var card=document.getElementById('agent-'+id);
        if(card)card.classList.remove('destroying');
      }
    }

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

    // Launch form
    var f=document.getElementById('f'),errorEl=document.getElementById('error');
    var successEl=document.getElementById('success'),successTextEl=document.getElementById('success-text');
    f.onsubmit=async function(e){
      e.preventDefault();
      var agentName=f.name.value.trim();
      var payload={agentId:agentName,instructions:f.instructions.value.trim()};
      if(isJoinMode){
        var jUrl=joinUrlInput.value.trim();
        if(!jUrl){errorEl.textContent='Conversation link is required';errorEl.style.display='block';return;}
        payload.joinUrl=jUrl;
      }
      launching=true;btn.disabled=true;btn.textContent=isJoinMode?'Joining...':'Launching...';
      errorEl.style.display='none';successEl.classList.remove('active');
      try{
        var res=await fetch('/api/pool/claim',{method:'POST',headers:authHeaders,
          body:JSON.stringify(payload)
        });
        var data=await res.json();
        if(!res.ok)throw new Error(data.error||'Launch failed');
        f.reset();
        if(isJoinMode){modeCreate.onclick();}
        if(data.joined){
          successTextEl.textContent=agentName+' joined the conversation';
          successEl.classList.add('active');
          setTimeout(function(){successEl.classList.remove('active');},8000);
        }else{
          showQr(agentName||data.instanceId,data.inviteUrl);
        }
        refreshFeed();
      }catch(err){
        errorEl.textContent=err.message;
        errorEl.style.display='block';
      }finally{launching=false;btn.textContent=isJoinMode?'Join & Launch':'Launch Agent';refreshStatus();}
    };

    // Pool controls
    var replenishBtn=document.getElementById('replenish-btn');
    var replenishCount=document.getElementById('replenish-count');
    replenishBtn.onclick=async function(){
      var n=parseInt(replenishCount.value)||3;
      replenishBtn.disabled=true;replenishBtn.textContent='Adding...';
      try{
        var res=await fetch('/api/pool/replenish',{method:'POST',headers:authHeaders,
          body:JSON.stringify({count:n})
        });
        var data=await res.json();
        if(!res.ok)throw new Error(data.error||'Failed');
        refreshStatus();
      }catch(err){
        alert('Failed to add instances: '+err.message);
      }finally{replenishBtn.disabled=false;replenishBtn.textContent='+ Add';}
    };

    // Drain — remove idle instances from the pool
    var drainBtn=document.getElementById('drain-btn');
    drainBtn.onclick=async function(){
      var n=parseInt(replenishCount.value)||3;
      drainBtn.disabled=true;drainBtn.textContent='Draining...';
      try{
        var res=await fetch('/api/pool/drain',{method:'POST',headers:authHeaders,
          body:JSON.stringify({count:n})
        });
        var data=await res.json();
        if(!res.ok)throw new Error(data.error||'Failed');
        refreshStatus();
      }catch(err){
        alert('Failed to drain pool: '+err.message);
      }finally{drainBtn.disabled=false;drainBtn.textContent='Drain';}
    };

    // Initial load + polling
    refreshStatus();refreshFeed();
    setInterval(function(){refreshStatus();refreshFeed();},15000);
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

// Launch an agent — claim an idle instance and provision it with instructions.
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

// Manually trigger a replenish cycle, optionally creating N instances
app.post("/api/pool/replenish", requireAuth, async (req, res) => {
  try {
    const count = Math.min(parseInt(req.body?.count) || 0, 20);
    if (count > 0) {
      const results = [];
      for (let i = 0; i < count; i++) {
        try {
          const inst = await pool.createInstance();
          results.push(inst);
        } catch (err) {
          console.error(`[pool] Failed to create instance:`, err);
        }
      }
      const counts = await db.countByStatus();
      return res.json({ ok: true, created: results.length, counts });
    }
    await pool.tick();
    const counts = await db.countByStatus();
    res.json({ ok: true, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger reconciliation — verify DB against Railway and clean up orphans
app.post("/api/pool/reconcile", requireAuth, async (_req, res) => {
  try {
    const cleaned = await pool.reconcile();
    const counts = await db.countByStatus();
    res.json({ ok: true, cleaned, counts });
  } catch (err) {
    console.error("[api] Reconcile failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Drain idle instances from the pool
app.post("/api/pool/drain", requireAuth, async (req, res) => {
  try {
    const count = Math.min(parseInt(req.body?.count) || 1, 20);
    const drained = await pool.drainPool(count);
    const counts = await db.countByStatus();
    res.json({ ok: true, drained: drained.length, counts });
  } catch (err) {
    console.error("[api] Drain failed:", err);
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
