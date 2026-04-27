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

// Load agent/.env so SHAUL_DB_PATH (and any DASHBOARD_PORT/etc) flow through.
// dotenv lives in agent/node_modules — try-load it; harmless if missing.
try {
  const dotenv = require(path.join(AGENT_DIR, 'node_modules', 'dotenv'));
  dotenv.config({ path: path.join(AGENT_DIR, '.env') });
} catch (_) { /* dotenv optional */ }

// ── memory DB (lazy, optional) ───────────────────────────────────────────────
const VIEWABLE_TABLES = [
  'business_profile', 'interactions', 'learned_insights', 'entities',
  'campaigns', 'creatives', 'posts', 'insights_daily', 'goals', 'reflections',
  'agenda_items', 'attendance', 'discovery_state', 'daily_briefings',
  'calendar_events', 'outbound_messages', 'marketing_memory',
];

// Probe multiple known paths — the agent and the dashboard occasionally end up
// with different cwds or env, so we look in every reasonable spot before
// giving up.
const DB_CANDIDATES = [
  process.env.SHAUL_DB_PATH,
  path.join(AGENT_DIR, 'data', 'shaul-memory.db'),
  path.join(AGENT_DIR, 'marketing', 'data', 'shaul-memory.db'),
  path.join(ROOT_DIR, 'data', 'shaul-memory.db'),
].filter(Boolean);

let memDb = null;
let memDbPath = null;
let memDbLastError = null;

function findExistingDbPath() {
  for (const p of DB_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function getMemDb() {
  if (memDb) return memDb;
  const p = findExistingDbPath();
  if (!p) { memDbLastError = `no DB at any of: ${DB_CANDIDATES.join(', ')}`; return null; }
  try {
    const Database = require('better-sqlite3');
    memDb = new Database(p, { readonly: false, fileMustExist: true });
    memDbPath = p;
    memDbLastError = null;
    return memDb;
  } catch (e) {
    memDbLastError = `open failed at ${p}: ${e.message}`;
    return null;
  }
}

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

// ── memory API ───────────────────────────────────────────────────────────────

function apiMemoryTables(req, res) {
  const db = getMemDb();
  if (!db) return sendJSON(res, 200, {
    available: false, tables: [], error: memDbLastError, candidates: DB_CANDIDATES,
  });
  const counts = {};
  for (const t of VIEWABLE_TABLES) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c; }
    catch (_) { counts[t] = 0; }
  }
  sendJSON(res, 200, { available: true, tables: VIEWABLE_TABLES, counts, db_path: memDbPath });
}

function apiMemoryRows(req, res) {
  const url = new URL(req.url, 'http://x');
  const table = url.searchParams.get('table');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (!VIEWABLE_TABLES.includes(table)) return sendJSON(res, 400, { error: 'invalid table' });
  const db = getMemDb();
  if (!db) return sendJSON(res, 503, { error: 'memory db not initialized yet — talk to Shaul first' });
  try {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    sendJSON(res, 200, { table, rows, columns, total, limit, offset });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

function apiMemoryDelete(req, res) {
  const url = new URL(req.url, 'http://x');
  const table = url.searchParams.get('table');
  const id = url.searchParams.get('id');
  if (!VIEWABLE_TABLES.includes(table)) return sendJSON(res, 400, { error: 'invalid table' });
  if (!id) return sendJSON(res, 400, { error: 'missing id' });
  const db = getMemDb();
  if (!db) return sendJSON(res, 503, { error: 'memory db not initialized' });
  try {
    const idCol = table === 'business_profile' ? 'user_id' : 'id';
    const r = db.prepare(`DELETE FROM ${table} WHERE ${idCol} = ?`).run(id);
    sendJSON(res, 200, { ok: true, deleted: r.changes });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

function serveMemoryHTML(req, res) {
  const html = getMemoryHTML();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

function getMemoryHTML() {
  return `<!DOCTYPE html>
<html lang="he" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🧠 Shaul Memory</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:16px}
  h1{font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:4px}
  .subtitle{font-size:.8rem;color:#6b7280;margin-bottom:20px}
  a.back{color:#60a5fa;text-decoration:none;font-size:.85rem;margin-bottom:14px;display:inline-block}
  .card{background:#1a1d27;border:1px solid #2a2d3e;border-radius:12px;padding:16px;margin-bottom:16px}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .tab{padding:6px 12px;background:#0f1117;border:1px solid #2a2d3e;border-radius:6px;cursor:pointer;font-size:.78rem;color:#9ca3af}
  .tab.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
  .tab .count{margin-right:6px;color:#6b7280;font-weight:600}
  .tab.active .count{color:#dbeafe}
  .table-wrap{overflow-x:auto;max-height:70vh}
  table{width:100%;border-collapse:collapse;font-size:.78rem}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #2a2d3e;vertical-align:top;max-width:380px}
  th{position:sticky;top:0;background:#0a0c14;font-weight:600;color:#9ca3af;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px}
  td{color:#e2e8f0;word-wrap:break-word;overflow-wrap:anywhere;white-space:pre-wrap}
  td.id{color:#60a5fa;font-weight:600}
  td.json{color:#fbbf24;font-family:monospace;font-size:.7rem}
  .pager{display:flex;justify-content:space-between;align-items:center;padding-top:10px;font-size:.8rem;color:#9ca3af}
  .btn-sm{padding:4px 10px;border:1px solid #2a2d3e;background:#0f1117;color:#9ca3af;border-radius:4px;font-size:.72rem;cursor:pointer;margin-right:4px}
  .btn-sm:hover{color:#e2e8f0}
  .btn-del{color:#ef4444;border-color:#7f1d1d}
  .empty{padding:40px;text-align:center;color:#6b7280}
</style>
</head>
<body>
<a class="back" href="/">← back to dashboard</a>
<h1>🧠 Shaul Long-Term Memory</h1>
<p class="subtitle">Everything Shaul remembers about you and your business</p>

<div class="card">
  <div class="tabs" id="tabs"></div>
  <div id="content"><div class="empty">Loading...</div></div>
</div>

<script>
let currentTable = null;
let currentOffset = 0;
const PAGE_SIZE = 100;

async function loadTabs() {
  const r = await fetch('/api/memory/tables');
  const d = await r.json();
  if (!d.available) {
    const cands = (d.candidates || []).map(c => '<li><code>' + c + '</code></li>').join('');
    const errLine = d.error ? '<p style="color:#fbbf24;font-size:.78rem;margin-top:8px"><b>error:</b> ' + escapeHtml(d.error) + '</p>' : '';
    document.getElementById('content').innerHTML =
      '<div class="empty"><p>📭 Memory DB not found.</p>'
      + '<p style="font-size:.8rem;margin-top:10px">Looked at:</p>'
      + '<ul style="text-align:left;display:inline-block;font-size:.75rem;margin-top:4px;color:#9ca3af">' + cands + '</ul>'
      + errLine
      + '<p style="font-size:.78rem;margin-top:14px;color:#9ca3af">If you have data via <code>mk memory</code>, set <code>SHAUL_DB_PATH</code> in <code>agent/.env</code> to point here.</p></div>';
    return;
  }
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  for (const t of d.tables) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.innerHTML = t + ' <span class="count">' + (d.counts[t] || 0) + '</span>';
    el.onclick = () => selectTable(t);
    tabs.appendChild(el);
  }
  selectTable(d.tables[0]);
}

async function selectTable(t) {
  currentTable = t;
  currentOffset = 0;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.textContent.startsWith(t));
  }
  await renderRows();
}

function isJsonish(v) {
  return typeof v === 'string' && (v.trim().startsWith('{') || v.trim().startsWith('['));
}

async function renderRows() {
  const url = '/api/memory/rows?table=' + encodeURIComponent(currentTable) + '&limit=' + PAGE_SIZE + '&offset=' + currentOffset;
  const r = await fetch(url);
  const d = await r.json();
  const c = document.getElementById('content');
  if (!r.ok) { c.innerHTML = '<div class="empty">' + (d.error || 'error') + '</div>'; return; }
  if (!d.rows || d.rows.length === 0) { c.innerHTML = '<div class="empty">📭 empty</div>'; return; }

  const idCol = currentTable === 'business_profile' ? 'user_id' : 'id';
  const cols = d.columns;
  let html = '<div class="table-wrap"><table><thead><tr>';
  for (const col of cols) html += '<th>' + col + '</th>';
  html += '<th>actions</th></tr></thead><tbody>';
  for (const row of d.rows) {
    html += '<tr>';
    for (const col of cols) {
      const v = row[col];
      const cls = col === 'id' || col === 'user_id' ? 'id' : (isJsonish(v) ? 'json' : '');
      const display = v === null ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      html += '<td class="' + cls + '">' + escapeHtml(display) + '</td>';
    }
    html += '<td><button class="btn-sm btn-del" onclick="del(' + JSON.stringify(row[idCol]) + ')">delete</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  const showingFrom = d.offset + 1;
  const showingTo = d.offset + d.rows.length;
  html += '<div class="pager"><div>showing ' + showingFrom + '–' + showingTo + ' of ' + d.total + '</div><div>'
    + '<button class="btn-sm" onclick="prev()" ' + (currentOffset === 0 ? 'disabled' : '') + '>← prev</button>'
    + '<button class="btn-sm" onclick="next(' + d.total + ')" ' + (showingTo >= d.total ? 'disabled' : '') + '>next →</button>'
    + '</div></div>';
  c.innerHTML = html;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function prev() { currentOffset = Math.max(0, currentOffset - PAGE_SIZE); renderRows(); }
function next(total) { if (currentOffset + PAGE_SIZE < total) { currentOffset += PAGE_SIZE; renderRows(); } }

async function del(id) {
  if (!confirm('delete row ' + id + ' from ' + currentTable + '?')) return;
  const r = await fetch('/api/memory/delete?table=' + encodeURIComponent(currentTable) + '&id=' + encodeURIComponent(id), { method: 'POST' });
  const d = await r.json();
  if (r.ok) { loadTabs(); renderRows(); } else { alert(d.error || 'failed'); }
}

loadTabs();
</script>
</body>
</html>`;
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
<p class="subtitle">GreenInvoice WhatsApp Agent · <a href="/memory" style="color:#60a5fa;text-decoration:none">🧠 Shaul Memory →</a></p>

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
  else if (m === 'GET'  && p === '/memory')            return serveMemoryHTML(req, res);
  else if (m === 'GET'  && p === '/api/status')        return apiStatus(req, res);
  else if (m === 'POST' && p === '/api/start')         return apiStart(req, res);
  else if (m === 'POST' && p === '/api/stop')          return apiStop(req, res);
  else if (m === 'POST' && p === '/api/restart')       return apiRestart(req, res);
  else if (m === 'GET'  && p === '/api/logs/stream')   return apiLogsStream(req, res);
  else if (m === 'GET'  && p === '/api/logs/download') return apiLogsDownload(req, res);
  else if (m === 'GET'  && p === '/api/logs/tail')     return apiLogsTail(req, res);
  else if (m === 'GET'  && p === '/api/memory/tables') return apiMemoryTables(req, res);
  else if (m === 'GET'  && p === '/api/memory/rows')   return apiMemoryRows(req, res);
  else if (m === 'POST' && p === '/api/memory/delete') return apiMemoryDelete(req, res);
  else { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`LAN access: http://<your-phone-ip>:${PORT}`);
});
