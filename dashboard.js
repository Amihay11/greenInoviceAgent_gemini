'use strict';
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { execFile, spawn } = require('child_process');

const ROOT_DIR  = __dirname;
const AGENT_DIR = path.join(ROOT_DIR, 'agent');
const PID_FILE  = path.join(ROOT_DIR, 'agent.pid');
const LOG_FILE  = path.join(ROOT_DIR, 'agent.log');
const START_SH  = path.join(ROOT_DIR, 'start-background.sh');
const STOP_SH   = path.join(ROOT_DIR, 'stop.sh');
const PORT      = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
const IS_WIN    = process.platform === 'win32';

// ── helpers ───────────────────────────────────────────────────────────────────

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function getStatus() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return { running: false, pid: null, uptime: '0s' };
    process.kill(pid, 0); // throws ESRCH if dead
    const uptime = formatUptime(Date.now() - fs.statSync(PID_FILE).mtimeMs);
    return { running: true, pid, uptime };
  } catch (_) {
    return { running: false, pid: null, uptime: '0s' };
  }
}

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function runScript(scriptPath, cb) {
  if (IS_WIN) {
    cb(new Error('Windows: use start-background.sh equivalent manually'));
  } else {
    execFile('bash', [scriptPath], { cwd: ROOT_DIR }, cb);
  }
}

// Windows-native start (no bash)
function winStart(cb) {
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['index.js'], {
    cwd: AGENT_DIR, detached: true, stdio: ['ignore', logFd, logFd]
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  cb(null, `Agent started (PID ${child.pid})`);
}

function winStop(cb) {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid);
    fs.unlinkSync(PID_FILE);
    cb(null, `Agent stopped (PID ${pid})`);
  } catch (e) {
    cb(e);
  }
}

// ── API handlers ──────────────────────────────────────────────────────────────

function apiStatus(req, res) {
  sendJSON(res, 200, getStatus());
}

function apiStart(req, res) {
  const s = getStatus();
  if (s.running) return sendJSON(res, 200, { ok: true, message: `Already running (PID ${s.pid})` });
  const done = (err, stdout) => {
    if (err) return sendJSON(res, 500, { ok: false, error: err.message });
    sendJSON(res, 200, { ok: true, message: (stdout || '').trim() || 'Started' });
  };
  IS_WIN ? winStart(done) : runScript(START_SH, done);
}

function apiStop(req, res) {
  const done = (err, stdout, stderr) => {
    if (err) return sendJSON(res, 500, { ok: false, error: (stderr || err.message).trim() });
    sendJSON(res, 200, { ok: true, message: (stdout || '').trim() || 'Stopped' });
  };
  IS_WIN ? winStop(done) : runScript(STOP_SH, done);
}

function apiRestart(req, res) {
  const stopDone = () => {
    setTimeout(() => {
      const done = (err, stdout) => {
        if (err) return sendJSON(res, 500, { ok: false, error: err.message });
        sendJSON(res, 200, { ok: true, message: 'Restarted. ' + ((stdout || '').trim()) });
      };
      IS_WIN ? winStart(done) : runScript(START_SH, done);
    }, 1500);
  };
  IS_WIN ? winStop(stopDone) : runScript(STOP_SH, stopDone);
}

function apiLogsStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  let fileSize = 0;
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-50);
    for (const line of lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
    fileSize = fs.statSync(LOG_FILE).size;
  } catch (_) {}

  const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000);

  const poll = setInterval(() => {
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size === fileSize) return;
      if (stat.size < fileSize) fileSize = 0; // truncated/rotated
      const newBytes = stat.size - fileSize;
      const buf = Buffer.alloc(newBytes);
      const fd = fs.openSync(LOG_FILE, 'r');
      fs.readSync(fd, buf, 0, newBytes, fileSize);
      fs.closeSync(fd);
      fileSize = stat.size;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    } catch (_) {}
  }, 1000);

  req.on('close', () => { clearInterval(poll); clearInterval(heartbeat); });
}

function apiLogsDownload(req, res) {
  try {
    const stat = fs.statSync(LOG_FILE);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="agent.log"',
      'Content-Length': stat.size,
    });
    fs.createReadStream(LOG_FILE).pipe(res);
  } catch (_) {
    res.writeHead(404); res.end('Log file not found');
  }
}

function apiLogsTail(req, res) {
  const n = parseInt(new URL(req.url, `http://x`).searchParams.get('n') || '200', 10);
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-n);
    sendJSON(res, 200, { lines, count: lines.length });
  } catch (_) {
    sendJSON(res, 404, { lines: [], count: 0 });
  }
}

// ── HTML dashboard ────────────────────────────────────────────────────────────

function serveHTML(req, res) {
  const html = getDashboardHTML();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="he" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:16px}
  h1{font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:4px}
  .subtitle{font-size:.8rem;color:#6b7280;margin-bottom:20px}
  .card{background:#1a1d27;border:1px solid #2a2d3e;border-radius:12px;padding:16px;margin-bottom:16px}
  .status-row{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .dot{width:14px;height:14px;border-radius:50%;background:#374151;flex-shrink:0}
  .dot.running{background:#10b981;box-shadow:0 0 0 0 #10b98140;animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 #10b98180}70%{box-shadow:0 0 0 8px #10b98100}100%{box-shadow:0 0 0 0 #10b98100}}
  .status-text{font-size:1rem;font-weight:600}
  .badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  .badge{background:#0f1117;border:1px solid #2a2d3e;border-radius:6px;padding:3px 10px;font-size:.75rem;color:#9ca3af}
  .badge span{color:#e2e8f0;font-weight:600}
  .btn-row{display:flex;gap:8px;flex-wrap:wrap}
  .btn{flex:1;min-width:80px;min-height:44px;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .btn-start{background:#10b981;color:#fff}
  .btn-stop{background:#ef4444;color:#fff}
  .btn-restart{background:#4f46e5;color:#fff}
  .log-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .log-title{font-size:.95rem;font-weight:600}
  .log-actions{display:flex;gap:8px}
  .btn-sm{padding:5px 12px;border:1px solid #2a2d3e;background:#0f1117;color:#9ca3af;border-radius:6px;font-size:.78rem;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
  .btn-sm:hover{color:#e2e8f0}
  #log-output{background:#0a0c14;border-radius:8px;padding:10px 12px;height:380px;overflow-y:auto;font-family:'Courier New',monospace;font-size:.75rem;line-height:1.5}
  .log-default{color:#9ca3af}
  .log-error{color:#ef4444}
  .log-warn{color:#f59e0b}
  .log-success{color:#10b981}
  .log-info{color:#60a5fa}
  .scroll-hint{font-size:.72rem;color:#6b7280;margin-top:6px;text-align:right}
  #toast{position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-80px);background:#1a1d27;border:1px solid #2a2d3e;border-radius:10px;padding:10px 20px;font-size:.85rem;transition:transform .3s;z-index:100;white-space:nowrap}
  #toast.show{transform:translateX(-50%) translateY(0)}
  #toast.ok{border-color:#10b981;color:#10b981}
  #toast.err{border-color:#ef4444;color:#ef4444}
</style>
</head>
<body>
<h1>🤖 Agent Dashboard</h1>
<p class="subtitle">GreenInvoice WhatsApp Agent</p>

<div class="card">
  <div class="status-row">
    <div class="dot" id="dot"></div>
    <div class="status-text" id="status-text">Checking...</div>
  </div>
  <div class="badges">
    <div class="badge">PID: <span id="pid">—</span></div>
    <div class="badge">Uptime: <span id="uptime">—</span></div>
  </div>
  <div class="btn-row">
    <button class="btn btn-start" onclick="act('start')">▶ Start</button>
    <button class="btn btn-stop"  onclick="act('stop')">■ Stop</button>
    <button class="btn btn-restart" onclick="act('restart')">↺ Restart</button>
  </div>
</div>

<div class="card">
  <div class="log-header">
    <div class="log-title">📋 Live Logs</div>
    <div class="log-actions">
      <button class="btn-sm" id="scroll-btn" onclick="toggleScroll()">Auto-scroll: ON</button>
      <button class="btn-sm" onclick="clearLogs()">Clear</button>
      <a class="btn-sm" href="/api/logs/download" download>⬇ Download</a>
    </div>
  </div>
  <div id="log-output"></div>
  <div class="scroll-hint" id="scroll-hint"></div>
</div>

<div id="toast"></div>

<script>
let autoScroll = true;
let toastTimer = null;

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + (type || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = '', 3000);
}

function setButtons(disabled) {
  document.querySelectorAll('.btn').forEach(b => b.disabled = disabled);
}

async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    const dot = document.getElementById('dot');
    dot.className = 'dot' + (d.running ? ' running' : '');
    document.getElementById('status-text').textContent = d.running ? 'Running' : 'Stopped';
    document.getElementById('pid').textContent = d.pid || '—';
    document.getElementById('uptime').textContent = d.running ? d.uptime : '—';
  } catch (_) {}
}

async function act(action) {
  setButtons(true);
  showToast('Sending ' + action + '...');
  try {
    const r = await fetch('/api/' + action, { method: 'POST' });
    const d = await r.json();
    showToast(d.message || d.error || action, d.ok ? 'ok' : 'err');
    setTimeout(refreshStatus, action === 'restart' ? 2500 : 1200);
  } catch (e) {
    showToast('Error: ' + e.message, 'err');
  } finally {
    setButtons(false);
  }
}

function classifyLine(text) {
  const t = text.toLowerCase();
  if (t.includes('error') || t.includes('err:') || t.includes('exception')) return 'log-error';
  if (t.includes('warn')) return 'log-warn';
  if (t.includes('ready') || t.includes('started') || t.includes('connected')) return 'log-success';
  if (t.includes('info') || t.includes('loading')) return 'log-info';
  return 'log-default';
}

function appendLine(text) {
  const el = document.getElementById('log-output');
  const div = document.createElement('div');
  div.className = classifyLine(text);
  div.textContent = text;
  el.appendChild(div);
  while (el.children.length > 1000) el.removeChild(el.firstChild);
  if (autoScroll) el.scrollTop = el.scrollHeight;
}

function clearLogs() {
  document.getElementById('log-output').innerHTML = '';
}

function toggleScroll() {
  autoScroll = !autoScroll;
  document.getElementById('scroll-btn').textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
  if (autoScroll) {
    const el = document.getElementById('log-output');
    el.scrollTop = el.scrollHeight;
  }
}

// Pause auto-scroll when user scrolls up
document.getElementById('log-output').addEventListener('scroll', function() {
  const el = this;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (!atBottom && autoScroll) {
    autoScroll = false;
    document.getElementById('scroll-btn').textContent = 'Auto-scroll: OFF';
    document.getElementById('scroll-hint').textContent = '↑ Scrolled up — auto-scroll paused';
  } else if (atBottom && !autoScroll) {
    autoScroll = true;
    document.getElementById('scroll-btn').textContent = 'Auto-scroll: ON';
    document.getElementById('scroll-hint').textContent = '';
  }
});

// SSE log stream
function startStream() {
  const es = new EventSource('/api/logs/stream');
  es.onmessage = e => appendLine(JSON.parse(e.data));
  es.onerror = () => document.getElementById('scroll-hint').textContent = 'Log stream reconnecting...';
  es.onopen = () => document.getElementById('scroll-hint').textContent = '';
}

refreshStatus();
setInterval(refreshStatus, 5000);
startStream();
</script>
</body>
</html>`;
}

// ── router ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method;
  res.setHeader('Access-Control-Allow-Origin', '*');

  if      (m === 'GET'  && p === '/')                  return serveHTML(req, res);
  else if (m === 'GET'  && p === '/api/status')        return apiStatus(req, res);
  else if (m === 'POST' && p === '/api/start')         return apiStart(req, res);
  else if (m === 'POST' && p === '/api/stop')          return apiStop(req, res);
  else if (m === 'POST' && p === '/api/restart')       return apiRestart(req, res);
  else if (m === 'GET'  && p === '/api/logs/stream')   return apiLogsStream(req, res);
  else if (m === 'GET'  && p === '/api/logs/download') return apiLogsDownload(req, res);
  else if (m === 'GET'  && p === '/api/logs/tail')     return apiLogsTail(req, res);
  else { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`LAN access: http://<your-phone-ip>:${PORT}`);
});
