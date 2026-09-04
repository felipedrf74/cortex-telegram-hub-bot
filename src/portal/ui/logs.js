// Logs tab — query runtime_logs and tail the live ring over SSE.
import { sseSubscribe } from './sse.js';

const P = window.NexusPortal;
const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_TONE = { 10: 'neutral', 20: 'neutral', 30: 'info', 40: 'warning', 50: 'error', 60: 'error' };
const MAX_ROWS = 600;

let root = null;
let rows = [];
let liveStop = null;
let nextBeforeId = null;
let filterState = { level: '30', src: '', reqId: '', userId: '', q: '' };

function filterQuery(extra) {
  const params = new URLSearchParams();
  Object.entries(filterState).forEach(([k, v]) => { if (v) params.set(k, v); });
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== '') params.set(k, v); });
  const s = params.toString();
  return s ? '?' + s : '';
}

function renderRow(line) {
  const tone = LEVEL_TONE[line.level] || 'neutral';
  const name = LEVELS[line.level] || String(line.level);
  const reqLink = line.reqId
    ? '<a href="#requests" class="mono log-req" data-req="' + P.esc(line.reqId) + '" title="Open request">' + P.esc(line.reqId.slice(0, 12)) + '</a>'
    : '<span class="text-muted">—</span>';
  let data = '';
  if (line.data) {
    data = '<details class="log-data"><summary class="text-muted">data</summary><pre class="mono">' + P.esc(line.data) + '</pre></details>';
  }
  return '<tr class="log-row log-' + tone + '">' +
    '<td class="mono text-muted log-ts">' + P.esc(P.shortDateTime(line.ts)) + '</td>' +
    '<td><span class="badge badge-' + tone + '">' + P.esc(name) + '</span></td>' +
    '<td class="mono text-muted">' + P.esc(line.src || '') + '</td>' +
    '<td>' + reqLink + '</td>' +
    '<td class="mono text-muted">' + (line.userId != null ? P.esc(String(line.userId)) : '') + '</td>' +
    '<td class="log-msg">' + P.esc(line.msg) + data + '</td>' +
    '</tr>';
}

function renderTable() {
  const tbody = root.querySelector('#logs-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No log lines match</div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(renderRow).join('');
  root.querySelector('#logs-count').textContent = rows.length + ' lines';
}

async function loadLogs(append) {
  const res = await P.apiFetch('/api/ops/logs' + filterQuery({ limit: 200, beforeId: append ? nextBeforeId : null }));
  if (!res.ok) { setStatus('Failed to load logs (HTTP ' + res.status + ')'); return; }
  const data = await res.json();
  const fetched = (data.logs || []).slice().reverse(); // oldest first
  rows = append ? fetched.concat(rows) : fetched;
  nextBeforeId = data.nextBeforeId;
  root.querySelector('#logs-older').disabled = !nextBeforeId;
  renderTable();
  setStatus('');
}

async function loadStatus() {
  try {
    const res = await P.apiFetch('/api/ops/logs/status');
    if (!res.ok) return;
    const data = await res.json();
    const s = data.store || {};
    const el = root.querySelector('#logs-store-status');
    el.innerHTML =
      '<span class="badge badge-' + (s.dbAttached ? 'success' : 'warning') + '">' + (s.dbAttached ? 'store attached' : 'store buffering') + '</span> ' +
      '<span class="text-muted mono">' + (s.rowCount != null ? s.rowCount + ' rows' : '—') + ' · ring ' + s.ringSize + ' · dropped ' + s.droppedLines + '</span>';
  } catch (_) { /* optional */ }
}

function setStatus(text) {
  const el = root.querySelector('#logs-status');
  el.textContent = text;
}

function toggleLive() {
  const btn = root.querySelector('#logs-live');
  if (liveStop) {
    liveStop();
    liveStop = null;
    btn.textContent = '▶ Live';
    btn.classList.remove('active');
    return;
  }
  btn.textContent = '■ Stop';
  btn.classList.add('active');
  const wrap = root.querySelector('#logs-table-wrap');
  liveStop = sseSubscribe('/api/ops/logs/stream' + filterQuery(), (event, line) => {
    if (event !== 'log') return;
    rows.push(line);
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    renderTable();
    if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
  }, (state, detail) => {
    setStatus(state === 'open' ? 'Live tail connected' : state === 'error' ? 'Live tail error: ' + (detail || '') : '');
    if (state !== 'open' && liveStop) { liveStop = null; btn.textContent = '▶ Live'; btn.classList.remove('active'); }
  });
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Logs</h1>' +
    '<div class="section-subtitle">Runtime log store (redacted) with live tail. Click a request id to open it in Requests.</div></div>' +
    '<div class="section-actions"><span id="logs-store-status"></span></div></div>' +
    '<div class="card"><div class="table-toolbar" id="logs-filters">' +
    '<select class="u-maxw-120 input" data-f="level">' +
      '<option value="">all levels</option><option value="30" selected>info+</option><option value="40">warn+</option><option value="50">error+</option></select>' +
    '<input class="u-maxw-160 input" data-f="src" placeholder="src (http, cron:…)">' +
    '<input class="u-maxw-190 input" data-f="reqId" placeholder="request id">' +
    '<input class="u-maxw-100 input" data-f="userId" placeholder="user id">' +
    '<input class="input" type="search" data-f="q" placeholder="message contains…">' +
    '<button class="btn btn-ghost btn-sm" id="logs-apply">Apply</button>' +
    '<button class="btn btn-ghost btn-sm" id="logs-live">▶ Live</button>' +
    '<span class="u-ml-auto u-fs-11 text-muted mono" id="logs-count"></span></div>' +
    '<div class="u-p-0-space-4 u-fs-11 text-muted" id="logs-status"></div>' +
    '<div id="logs-table-wrap" class="u-ov-auto u-maxh-70vh"><table class="data-table dense" id="logs-table">' +
    '<thead><tr><th>Time</th><th>Level</th><th>Src</th><th>Request</th><th>User</th><th>Message</th></tr></thead>' +
    '<tbody id="logs-tbody"><tr><td colspan="6"><div class="empty">Loading…</div></td></tr></tbody></table></div>' +
    '<div class="u-p-space-3-space-4"><button class="btn btn-ghost btn-sm" id="logs-older" disabled>Load older</button></div></div>';

  root.querySelector('#logs-apply').addEventListener('click', () => {
    root.querySelectorAll('[data-f]').forEach((el) => { filterState[el.dataset.f] = el.value.trim(); });
    if (liveStop) toggleLive();
    loadLogs(false).catch((err) => setStatus(err.message));
  });
  root.querySelector('#logs-filters').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') root.querySelector('#logs-apply').click();
  });
  root.querySelector('#logs-live').addEventListener('click', toggleLive);
  root.querySelector('#logs-older').addEventListener('click', () => loadLogs(true).catch((err) => setStatus(err.message)));
  root.querySelector('#logs-tbody').addEventListener('click', (e) => {
    const link = e.target.closest('.log-req');
    if (!link) return;
    e.preventDefault();
    P.navigateTo('requests');
    const requests = P.sections.requests;
    if (requests && requests.showRequest) requests.showRequest(link.dataset.req);
  });
}

P.registerSection('logs', {
  mount,
  onShow() {
    loadLogs(false).catch((err) => setStatus(err.message));
    loadStatus();
  },
  onHide() {
    if (liveStop) toggleLive();
  },
  showRequest(reqId) {
    filterState = { level: '', src: '', reqId: reqId || '', userId: '', q: '' };
    root.querySelectorAll('[data-f]').forEach((el) => { el.value = filterState[el.dataset.f] || ''; });
    loadLogs(false).catch((err) => setStatus(err.message));
  },
});
