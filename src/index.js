import express from "express";
import * as pool from "./pool.js";
import * as cache from "./cache.js";
import { deleteAllProjectVolumes } from "./volumes.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const POOL_API_KEY = process.env.POOL_API_KEY;
const POOL_ENVIRONMENT = process.env.POOL_ENVIRONMENT || "staging";

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
const BUILD_VERSION = "2026-02-12T01:cache-v1";
app.get("/version", (_req, res) => res.json({ version: BUILD_VERSION, environment: POOL_ENVIRONMENT }));

// Pool counts (no auth — used by the launch form)
app.get("/api/pool/counts", (_req, res) => {
  res.json(cache.getCounts());
});

// List launched agents (no auth — used by the page)
app.get("/api/pool/agents", (_req, res) => {
  const claimed = cache.getByStatus("claimed");
  const crashed = cache.getByStatus("crashed");
  res.json({ claimed, crashed });
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

// Dismiss a crashed agent
app.delete("/api/pool/crashed/:id", requireAuth, async (req, res) => {
  try {
    await pool.dismissCrashed(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[api] Dismiss failed:", err);
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

    /* Header */
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

    .logo-sub {
      font-size: 13px;
      color: #999;
      font-weight: 400;
    }

    /* Pool bar */
    .pool-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #FAFAFA;
      border: 1px solid #EBEBEB;
      border-radius: 14px;
      margin-bottom: 24px;
    }

    .pool-bar-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pool-bar-label {
      font-size: 12px;
      font-weight: 600;
      color: #999;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-right: 6px;
    }

    .pool-stat {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 13px;
      font-weight: 500;
      padding: 4px 10px;
      background: #FFF;
      border-radius: 8px;
      color: #666;
      border: 1px solid #EBEBEB;
    }

    .pool-stat .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }

    .pool-stat.ready .dot { background: #34C759; }
    .pool-stat.starting .dot { background: #FF9500; }
    .pool-stat.claimed .dot { background: #007AFF; }
    .pool-stat.crashed .dot { background: #DC2626; }

    .pool-bar-right {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pool-bar-right input {
      width: 48px;
      padding: 5px 4px;
      font-size: 13px;
      text-align: center;
      border: 1px solid #EBEBEB;
      border-radius: 8px;
      font-family: inherit;
      color: #000;
      background: #FFF;
    }

    .pool-bar-right input:focus { outline: none; border-color: #999; }

    .pool-btn {
      font-size: 12px;
      font-weight: 600;
      padding: 5px 10px;
      border: 1px solid #EBEBEB;
      border-radius: 8px;
      cursor: pointer;
      background: #FFF;
      color: #666;
      transition: all 0.15s ease;
    }

    .pool-btn:hover { background: #F5F5F5; border-color: #CCC; }
    .pool-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .pool-btn.danger {
      color: #DC2626;
      border-color: #FECACA;
    }

    .pool-btn.danger:hover { background: #FEF2F2; }

    /* Two-column grid */
    .main-content {
      display: grid;
      grid-template-columns: 1fr 340px;
      gap: 24px;
      align-items: start;
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

    .btn-warn {
      background: #FEF3C7;
      color: #92400E;
      border: none;
      border-radius: 12px;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-warn:hover { background: #FDE68A; }

    .error-message {
      color: #DC2626;
      font-size: 14px;
      margin-top: 12px;
      padding: 12px 16px;
      background: #FEE2E2;
      border-radius: 12px;
      display: none;
    }

    /* Agent feed (right column) */
    .feed-column {
      display: flex;
      flex-direction: column;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
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
      border-radius: 20px;
      padding: 20px;
      margin-bottom: 10px;
    }

    .agent-card.crashed {
      border-color: #FECACA;
      background: #FEF2F2;
    }

    .agent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .agent-name {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.08px;
    }

    .agent-uptime {
      font-size: 12px;
      color: #999;
      font-weight: 500;
    }

    .agent-status-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #FEE2E2;
      color: #DC2626;
    }

    .agent-instructions {
      font-size: 13px;
      color: #666;
      line-height: 1.4;
      margin-bottom: 12px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .agent-actions {
      display: flex;
      gap: 6px;
    }

    .agent-actions .btn-secondary,
    .agent-actions .btn-danger,
    .agent-actions .btn-warn {
      padding: 6px 12px;
      font-size: 12px;
      border-radius: 8px;
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
      padding: 32px 16px;
      color: #999;
      font-size: 13px;
    }

    .env-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 8px;
      border-radius: 6px;
      margin-left: 10px;
      vertical-align: middle;
    }

    .env-badge.env-staging {
      background: #FEF3C7;
      border: 1px solid #FDE68A;
      color: #92400E;
    }

    .env-badge.env-production {
      background: #FEE2E2;
      border: 1px solid #FECACA;
      color: #991B1B;
    }

    body.env-production { border-top: 3px solid #DC2626; }
    body.env-staging { border-top: 3px solid #F59E0B; }

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

      .pool-bar {
        flex-wrap: wrap;
        gap: 10px;
      }

      .pool-bar-left {
        flex-wrap: wrap;
        width: 100%;
      }

      .pool-bar-right {
        width: 100%;
      }
    }
  </style>
</head>
<body class="env-${POOL_ENVIRONMENT}">
  <div class="container">
    <header class="header">
      <div class="logo-container">
        <span class="logo-text">Convos Agent Pool<span class="env-badge env-${POOL_ENVIRONMENT}">${POOL_ENVIRONMENT}</span></span>
        <span class="logo-sub">Internal tool for quickly spinning up agents with new instructions.</span>
      </div>
    </header>

    <div class="pool-bar">
      <div class="pool-bar-left">
        <span class="pool-bar-label">Pool</span>
        <div class="pool-stat ready"><span class="dot"></span><span id="s-idle">-</span> ready</div>
        <div class="pool-stat starting"><span class="dot"></span><span id="s-starting">-</span> starting</div>
        <div class="pool-stat claimed"><span class="dot"></span><span id="s-claimed">-</span> claimed</div>
        <div class="pool-stat crashed" id="s-crashed-wrap" style="display:none"><span class="dot"></span><span id="s-crashed">0</span> crashed</div>
      </div>
      <div class="pool-bar-right">
        <input id="replenish-count" type="number" min="1" max="20" value="3" />
        <button class="pool-btn" id="replenish-btn">+ Add</button>
        <button class="pool-btn danger" id="drain-btn">Drain</button>
      </div>
    </div>

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

      <div class="feed-column">
        <div class="section-header">
          <span class="section-title">Live Agents</span>
          <span class="live-count" id="live-count"></span>
        </div>
        <div id="feed"></div>
      </div>
    </div>
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
    const POOL_ENV='${POOL_ENVIRONMENT}';
    const authHeaders={'Authorization':'Bearer '+API_KEY,'Content-Type':'application/json'};

    function copyText(el){
      navigator.clipboard.writeText(el.textContent.trim()).then(function(){
        var orig=el.textContent;
        el.textContent='Copied!';el.style.background='#D4EDDA';el.style.color='#155724';
        setTimeout(function(){el.textContent=orig;el.style.background='';el.style.color='';},1500);
      });
    }

    function timeAgo(dateStr){
      if(!dateStr)return '';
      var ms=Date.now()-new Date(dateStr).getTime();
      var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
      if(d>0)return d+'d '+h%24+'h';
      if(h>0)return h+'h '+m%60+'m';
      if(m>0)return m+'m';
      return '<1m';
    }

    // Pool status
    var sIdle=document.getElementById('s-idle'),sStarting=document.getElementById('s-starting'),sClaimed=document.getElementById('s-claimed');
    var sCrashed=document.getElementById('s-crashed'),sCrashedWrap=document.getElementById('s-crashed-wrap');
    var unavail=document.getElementById('unavailable'),btn=document.getElementById('btn');
    var liveCount=document.getElementById('live-count');
    var launching=false;

    async function refreshStatus(){
      try{
        var res=await fetch('/api/pool/counts');
        var c=await res.json();
        sIdle.textContent=c.idle;sStarting.textContent=c.starting;sClaimed.textContent=c.claimed;
        if(c.crashed>0){sCrashed.textContent=c.crashed;sCrashedWrap.style.display='';}
        else{sCrashedWrap.style.display='none';}
        if(!launching){
          if(c.idle>0){btn.disabled=false;unavail.style.display='none'}
          else{btn.disabled=true;unavail.style.display='block'}
        }
      }catch{}
    }

    // Agent feed
    var feed=document.getElementById('feed');
    var claimedCache=[],crashedCache=[];

    async function refreshFeed(){
      try{
        var res=await fetch('/api/pool/agents');
        var data=await res.json();
        claimedCache=data.claimed||[];
        crashedCache=data.crashed||[];
        renderFeed();
      }catch{}
    }

    function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');}

    function renderFeed(){
      var total=claimedCache.length+crashedCache.length;
      liveCount.textContent=claimedCache.length?claimedCache.length+' running':'';
      if(!total){
        feed.innerHTML='<div class="empty-state">No live agents yet.</div>';
        return;
      }
      var html='';
      // Crashed agents first
      crashedCache.forEach(function(a){
        var name=esc(a.agentName||a.id);
        var instr=esc(a.instructions||'No instructions');
        html+='<div class="agent-card crashed" id="agent-'+a.id+'">'+
          '<div class="agent-header">'+
            '<span class="agent-name">'+name+' <span class="agent-status-badge">Crashed</span></span>'+
            '<span class="agent-uptime">'+timeAgo(a.claimedAt)+'</span>'+
          '</div>'+
          '<div class="agent-instructions">'+instr+'</div>'+
          '<div class="agent-actions">'+
            '<button class="btn-secondary" data-qr="'+a.id+'">Show QR</button>'+
            '<button class="btn-warn" data-dismiss="'+a.id+'">Dismiss</button>'+
          '</div>'+
        '</div>';
      });
      // Live agents
      claimedCache.forEach(function(a){
        var name=esc(a.agentName||a.id);
        var instr=esc(a.instructions||'No instructions');
        html+='<div class="agent-card" id="agent-'+a.id+'">'+
          '<div class="agent-header">'+
            '<span class="agent-name">'+name+'</span>'+
            '<span class="agent-uptime">'+timeAgo(a.claimedAt)+'</span>'+
          '</div>'+
          '<div class="agent-instructions">'+instr+'</div>'+
          '<div class="agent-actions">'+
            '<button class="btn-secondary" data-qr="'+a.id+'">Show QR</button>'+
            '<button class="btn-danger" data-kill="'+a.id+'">Kill</button>'+
          '</div>'+
        '</div>';
      });
      feed.innerHTML=html;
    }

    // Event delegation for agent actions
    feed.onclick=function(e){
      var qrId=e.target.getAttribute('data-qr');
      if(qrId){
        var a=claimedCache.concat(crashedCache).find(function(x){return x.id===qrId;});
        if(a)showQr(a.agentName||a.id,a.inviteUrl||'');
        return;
      }
      var killId=e.target.getAttribute('data-kill');
      if(killId){
        var a2=claimedCache.find(function(x){return x.id===killId;});
        if(a2)killAgent(a2.id,a2.agentName||a2.id);
        return;
      }
      var dismissId=e.target.getAttribute('data-dismiss');
      if(dismissId){
        var a3=crashedCache.find(function(x){return x.id===dismissId;});
        if(a3)dismissAgent(a3.id,a3.agentName||a3.id);
      }
    };

    // QR modal
    var modal=document.getElementById('qr-modal');
    function showQr(name,url){
      document.getElementById('modal-title').textContent=name;
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
      var confirmMsg=(POOL_ENV==='production'?'[PRODUCTION] ':'')+
        'Are you sure you want to kill "'+name+'"? This will delete the Railway service permanently.';
      if(!confirm(confirmMsg))return;
      try{
        await killOne(id);
        refreshStatus();
      }catch(err){
        alert('Failed to kill: '+err.message);
        var card=document.getElementById('agent-'+id);
        if(card)card.classList.remove('destroying');
      }
    }

    // Dismiss crashed agent
    async function dismissAgent(id,name){
      var confirmMsg=(POOL_ENV==='production'?'[PRODUCTION] ':'')+
        'Dismiss crashed agent "'+name+'"? This will clean up the Railway service.';
      if(!confirm(confirmMsg))return;
      markDestroying(id);
      try{
        var res=await fetch('/api/pool/crashed/'+id,{method:'DELETE',headers:authHeaders});
        var data=await res.json();
        if(!res.ok)throw new Error(data.error||'Dismiss failed');
        var card=document.getElementById('agent-'+id);
        if(card)card.remove();
        refreshStatus();refreshFeed();
      }catch(err){
        alert('Failed to dismiss: '+err.message);
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
      var payload={agentName:agentName,instructions:f.instructions.value.trim()};
      if(isJoinMode){
        var jUrl=joinUrlInput.value.trim();
        if(!jUrl){errorEl.textContent='Conversation link is required';errorEl.style.display='block';return;}
        if(POOL_ENV==='production'&&/dev\\.convos\\.org/i.test(jUrl)){
          errorEl.textContent='That looks like a dev environment link. Use a popup.convos.org link for production.';errorEl.style.display='block';return;
        }
        if(POOL_ENV!=='production'&&/popup\\.convos\\.org/i.test(jUrl)){
          errorEl.textContent='That looks like a production link. Use a dev.convos.org link for the dev environment.';errorEl.style.display='block';return;
        }
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
      var drainMsg=(POOL_ENV==='production'?'[PRODUCTION] ':'')+
        'Drain '+n+' idle instance(s) from the pool?';
      if(!confirm(drainMsg))return;
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
app.get("/api/pool/status", requireAuth, (_req, res) => {
  const counts = cache.getCounts();
  const instances = cache.getAll();
  res.json({ counts, instances });
});

// Launch an agent — claim an idle instance and provision it with instructions.
app.post("/api/pool/claim", requireAuth, async (req, res) => {
  const { agentName, instructions, joinUrl } = req.body || {};
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions (string) is required" });
  }
  if (!agentName || typeof agentName !== "string") {
    return res.status(400).json({ error: "agentName (string) is required" });
  }
  if (joinUrl && typeof joinUrl !== "string") {
    return res.status(400).json({ error: "joinUrl must be a string if provided" });
  }
  if (joinUrl && POOL_ENVIRONMENT === "production" && /dev\.convos\.org/i.test(joinUrl)) {
    return res.status(400).json({ error: "dev.convos.org links cannot be used in the production environment" });
  }
  if (joinUrl && POOL_ENVIRONMENT !== "production" && /popup\.convos\.org/i.test(joinUrl)) {
    return res.status(400).json({ error: `popup.convos.org links cannot be used in the ${POOL_ENVIRONMENT} environment` });
  }

  try {
    const result = await pool.provision(agentName, instructions, joinUrl || undefined);
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
      return res.json({ ok: true, created: results.length, counts: cache.getCounts() });
    }
    await pool.tick();
    res.json({ ok: true, counts: cache.getCounts() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger a tick (replaces old reconcile endpoint)
app.post("/api/pool/reconcile", requireAuth, async (_req, res) => {
  try {
    await pool.tick();
    res.json({ ok: true, counts: cache.getCounts() });
  } catch (err) {
    console.error("[api] Tick failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Drain idle instances from the pool
app.post("/api/pool/drain", requireAuth, async (req, res) => {
  try {
    const count = Math.min(parseInt(req.body?.count) || 1, 20);
    const drained = await pool.drainPool(count);
    res.json({ ok: true, drained: drained.length, counts: cache.getCounts() });
  } catch (err) {
    console.error("[api] Drain failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Background tick ---
// Rebuild cache from Railway + health checks every 30 seconds.
const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL_MS || "30000", 10);
setInterval(() => {
  pool.tick().catch((err) => console.error("[tick] Error:", err));
}, TICK_INTERVAL);

// One-time orphan volume cleanup, then run initial tick
deleteAllProjectVolumes()
  .catch((err) => console.warn("[startup] Orphan volume cleanup failed:", err.message))
  .then(() => pool.tick())
  .catch((err) => console.error("[tick] Initial tick error:", err));

app.listen(PORT, () => {
  console.log(`Pool manager listening on :${PORT}`);
});
