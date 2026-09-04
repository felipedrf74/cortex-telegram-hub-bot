// Requests tab — sampled HTTP ledger, per-route latency, throttle counters,
// and a per-request drawer with correlated logs and errors.
const P = window.NexusPortal;

let root = null;
let nextBeforeId = null;
let filterState = { reqId: '', path: '', statusClass: '', minDurationMs: '', surface: '', userId: '' };

function statusTone(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warning';
  if (status >= 300) return 'info';
  return 'success';
}

function filterQuery(extra) {
  const params = new URLSearchParams();
  Object.entries(filterState).forEach(([k, v]) => { if (v) params.set(k, v); });
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== '') params.set(k, v); });
  const s = params.toString();
  return s ? '?' + s : '';
}

function renderRequests(list, append) {
  const tbody = root.querySelector('#req-tbody');
  if (!append && list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No requests match (the ledger is sampled: every failure and slow request is kept, fast 2xx traffic is sampled)</div></td></tr>';
    return;
  }
  const html = list.map((r) =>
    '<tr class="u-cur-pointer req-row" data-req="' + P.esc(r.reqId) + '">' +
    '<td class="mono text-muted">' + P.esc(P.shortDateTime(r.ts)) + '</td>' +
    '<td><span class="badge badge-' + statusTone(r.status) + '">' + r.status + '</span></td>' +
    '<td class="mono">' + P.esc(r.method) + ' ' + P.esc(r.path) + '</td>' +
    '<td class="mono text-muted">' + r.durationMs + 'ms</td>' +
    '<td class="text-muted">' + P.esc(r.surface) + (r.sampled ? ' <span class="text-muted" title="stored by sampling">·s</span>' : '') + '</td>' +
    '<td class="mono text-muted">' + (r.userId != null ? r.userId : '') + '</td>' +
    '<td class="mono text-muted">' + P.esc(r.reqId.slice(0, 12)) + '</td>' +
    '</tr>').join('');
  if (append) tbody.insertAdjacentHTML('beforeend', html); else tbody.innerHTML = html;
}

async function loadRequests(append) {
  const res = await P.apiFetch('/api/ops/requests' + filterQuery({ limit: 100, beforeId: append ? nextBeforeId : null }));
  if (!res.ok) { setStatus('Failed to load requests (HTTP ' + res.status + ')'); return; }
  const data = await res.json();
  nextBeforeId = data.nextBeforeId;
  root.querySelector('#req-older').disabled = !nextBeforeId;
  renderRequests(data.requests || [], append);
  setStatus('');
}

async function loadLatency() {
  const win = root.querySelector('#req-window').value;
  const res = await P.apiFetch('/api/ops/latency?window=' + encodeURIComponent(win));
  if (!res.ok) return;
  const data = await res.json();
  const tbody = root.querySelector('#latency-tbody');
  const routes = data.routes || [];
  if (routes.length === 0) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No traffic in window</div></td></tr>'; return; }
  tbody.innerHTML = routes.slice(0, 40).map((r) =>
    '<tr><td class="mono">' + P.esc(r.method) + ' ' + P.esc(r.route) + '</td>' +
    '<td class="text-right mono">' + r.count + '</td>' +
    '<td class="text-right mono">' + r.p50Ms + '</td>' +
    '<td class="text-right mono">' + r.p95Ms + '</td>' +
    '<td class="text-right mono">' + r.p99Ms + '</td>' +
    '<td class="text-right mono">' + r.maxMs + '</td>' +
    '<td class="text-right">' + (r.errorCount ? '<span class="badge badge-error">' + (r.errorRate * 100).toFixed(1) + '%</span>' : '<span class="text-muted">0</span>') + '</td></tr>').join('');
}

async function loadRateLimits() {
  const res = await P.apiFetch('/api/ops/rate-limits');
  if (!res.ok) return;
  const data = await res.json();
  const t = data.throttled || { last5m: 0, last1h: 0, byBucket: {} };
  root.querySelector('#rl-5m').textContent = t.last5m;
  root.querySelector('#rl-1h').textContent = t.last1h;
  const buckets = (data.buckets || []).filter((b) => b.activeKeys > 0);
  root.querySelector('#rl-buckets').innerHTML = buckets.length
    ? buckets.map((b) => '<span class="badge badge-neutral" title="limit ' + b.limit + '/min">' + P.esc(b.name) + ' · ' + b.activeKeys + ' keys · hottest ' + b.hottestCount + '</span>').join(' ')
    : '<span class="text-muted">no active buckets</span>';
}

async function openRequest(reqId) {
  const panel = root.querySelector('#req-detail');
  panel.hidden = false;
  panel.innerHTML = '<div class="empty">Loading ' + P.esc(reqId) + '…</div>';
  const res = await P.apiFetch('/api/ops/requests/' + encodeURIComponent(reqId));
  if (res.status === 404) { panel.innerHTML = '<div class="empty">No ledger row, logs or errors for ' + P.esc(reqId) + ' (it may have been sampled out or pruned)</div>'; return; }
  if (!res.ok) { panel.innerHTML = '<div class="empty">Failed (HTTP ' + res.status + ')</div>'; return; }
  const data = await res.json();
  const r = data.request;
  const head = r
    ? '<div class="u-p-space-3-0 grid grid-cols-4">' +
      '<div><div class="kpi-label">Status</div><span class="badge badge-' + statusTone(r.status) + '">' + r.status + '</span></div>' +
      '<div><div class="kpi-label">Duration</div><div class="mono">' + r.durationMs + 'ms</div></div>' +
      '<div><div class="kpi-label">User</div><div class="mono">' + (r.userId != null ? r.userId : '—') + '</div></div>' +
      '<div><div class="kpi-label">Client</div><div class="u-fs-11 text-muted">' + P.esc(r.userAgent || '—') + '</div></div></div>'
    : '<div class="text-muted">No ledger row for this request id (not sampled); showing correlated logs and errors.</div>';
  const logs = (data.logs || []).map((l) =>
    '<div class="u-fs-11 u-p-2-0 mono"><span class="text-muted">' + P.esc(l.ts.slice(11, 23)) + '</span> ' +
    '<span class="badge badge-' + (l.level >= 50 ? 'error' : l.level >= 40 ? 'warning' : 'neutral') + '">' + l.level + '</span> ' + P.esc(l.msg) + '</div>').join('');
  const errs = [].concat(
    (data.errors && data.errors.server || []).map((e) => '<div><span class="badge badge-error">server</span> ' + P.esc(e.message) + (e.issue_id ? ' <a href="#issues" class="req-issue" data-issue="' + e.issue_id + '">issue #' + e.issue_id + '</a>' : '') + '</div>'),
    (data.errors && data.errors.client || []).map((e) => '<div><span class="badge badge-warning">client</span> ' + P.esc(e.message) + (e.issue_id ? ' <a href="#issues" class="req-issue" data-issue="' + e.issue_id + '">issue #' + e.issue_id + '</a>' : '') + '</div>'),
  ).join('');
  panel.innerHTML =
    '<div class="card-header"><div class="card-title">🔎 ' + P.esc(r ? r.method + ' ' + r.path : reqId) + '</div>' +
    '<span class="card-subtitle mono">' + P.esc(reqId) + '</span>' +
    '<button class="btn btn-ghost btn-sm" id="req-detail-close">Close</button></div>' + head +
    '<div class="u-mt-space-3 card-title">Errors</div>' + (errs || '<div class="text-muted">none</div>') +
    '<div class="u-mt-space-3 card-title">Logs (' + (data.logs || []).length + ')</div>' + (logs || '<div class="text-muted">no runtime log lines carry this request id</div>') +
    '<div class="u-mt-space-3"><a href="#logs" class="btn btn-ghost btn-sm" id="req-open-logs">Open in Logs</a></div>';
  panel.querySelector('#req-detail-close').addEventListener('click', () => { panel.hidden = true; });
  panel.querySelector('#req-open-logs').addEventListener('click', (e) => {
    e.preventDefault();
    P.navigateTo('logs');
    if (P.sections.logs && P.sections.logs.showRequest) P.sections.logs.showRequest(reqId);
  });
  panel.querySelectorAll('.req-issue').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    P.navigateTo('issues');
    if (P.sections.issues && P.sections.issues.openIssue) P.sections.issues.openIssue(Number(a.dataset.issue));
  }));
}

function setStatus(text) { root.querySelector('#req-status').textContent = text; }

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Requests</h1>' +
    '<div class="section-subtitle">Sampled HTTP ledger keyed by x-request-id, with per-route latency and throttle counters</div></div>' +
    '<div class="section-actions"><select class="u-maxw-110 input" id="req-window"><option value="15m">15 min</option><option value="1h" selected>1 hour</option><option value="24h">24 hours</option></select>' +
    '<button class="btn btn-ghost btn-sm" id="req-refresh">Refresh</button></div></div>' +
    '<div class="grid grid-cols-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">⏱ Latency by route</div></div>' +
    '<div class="u-ovx-auto"><table class="data-table dense"><thead><tr><th>Route</th><th class="text-right">n</th><th class="text-right">p50</th><th class="text-right">p95</th><th class="text-right">p99</th><th class="text-right">max</th><th class="text-right">5xx</th></tr></thead>' +
    '<tbody id="latency-tbody"><tr><td colspan="7"><div class="empty">Loading…</div></td></tr></tbody></table></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">🚦 Rate limiting</div></div>' +
    '<div class="u-p-space-3-space-4 grid grid-cols-2"><div class="kpi-card"><div class="kpi-label">429s last 5 min</div><div class="kpi-value" id="rl-5m">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">429s last hour</div><div class="kpi-value" id="rl-1h">—</div></div></div>' +
    '<div id="rl-buckets" class="u-p-0-space-4-space-3 u-d-flex u-flexwrap-wrap u-gap-space-2"></div></div></div>' +
    '<div class="u-p-space-3-space-4 card mt-4" id="req-detail" hidden></div>' +
    '<div class="card mt-4"><div class="table-toolbar" id="req-filters">' +
    '<input class="u-maxw-190 input" data-f="reqId" placeholder="request id">' +
    '<input class="u-maxw-200 input" data-f="path" placeholder="path prefix">' +
    '<select class="u-maxw-110 input" data-f="statusClass"><option value="">any status</option><option value="2">2xx</option><option value="3">3xx</option><option value="4">4xx</option><option value="5">5xx</option></select>' +
    '<select class="u-maxw-110 input" data-f="surface"><option value="">any surface</option><option value="ios">ios</option><option value="portal">portal</option><option value="webhook">webhook</option><option value="oauth">oauth</option><option value="public">public</option><option value="health">health</option></select>' +
    '<input class="u-maxw-90 input" data-f="minDurationMs" placeholder="≥ ms">' +
    '<input class="u-maxw-100 input" data-f="userId" placeholder="user id">' +
    '<button class="btn btn-ghost btn-sm" id="req-apply">Apply</button>' +
    '<span class="u-ml-auto u-fs-11 text-muted" id="req-status"></span></div>' +
    '<div class="u-ovx-auto"><table class="data-table dense"><thead><tr><th>Time</th><th>Status</th><th>Request</th><th>Duration</th><th>Surface</th><th>User</th><th>Id</th></tr></thead>' +
    '<tbody id="req-tbody"><tr><td colspan="7"><div class="empty">Loading…</div></td></tr></tbody></table></div>' +
    '<div class="u-p-space-3-space-4"><button class="btn btn-ghost btn-sm" id="req-older" disabled>Load older</button></div></div>';

  const apply = () => {
    root.querySelectorAll('[data-f]').forEach((el) => { filterState[el.dataset.f] = el.value.trim(); });
    loadRequests(false).catch((err) => setStatus(err.message));
  };
  root.querySelector('#req-apply').addEventListener('click', apply);
  root.querySelector('#req-filters').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  root.querySelector('#req-refresh').addEventListener('click', () => { loadRequests(false); loadLatency(); loadRateLimits(); });
  root.querySelector('#req-window').addEventListener('change', loadLatency);
  root.querySelector('#req-older').addEventListener('click', () => loadRequests(true).catch((err) => setStatus(err.message)));
  root.querySelector('#req-tbody').addEventListener('click', (e) => {
    const row = e.target.closest('.req-row');
    if (row) openRequest(row.dataset.req);
  });
}

P.registerSection('requests', {
  mount,
  onShow() {
    loadRequests(false).catch((err) => setStatus(err.message));
    loadLatency();
    loadRateLimits();
  },
  showRequest(reqId) {
    filterState = { reqId: reqId || '', path: '', statusClass: '', minDurationMs: '', surface: '', userId: '' };
    root.querySelectorAll('[data-f]').forEach((el) => { el.value = filterState[el.dataset.f] || ''; });
    loadRequests(false).catch((err) => setStatus(err.message));
    if (reqId) openRequest(reqId);
  },
});
