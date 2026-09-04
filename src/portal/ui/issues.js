// Issues tab — grouped server/client errors with an ack/resolve/mute lifecycle.
const P = window.NexusPortal;

let root = null;
let filterState = { status: 'open', kind: '', q: '' };
let openIssueId = null;

function tone(status) {
  return status === 'open' ? 'error' : status === 'acked' ? 'warning' : status === 'resolved' ? 'success' : 'neutral';
}

function filterQuery() {
  const params = new URLSearchParams();
  Object.entries(filterState).forEach(([k, v]) => { if (v) params.set(k, v); });
  params.set('limit', '200');
  return '?' + params.toString();
}

function renderSummary(summary) {
  const s = summary || { byStatus: {}, byKind: {}, openLast24h: 0 };
  root.querySelector('#iss-kpi-open').textContent = (s.byStatus && s.byStatus.open) || 0;
  root.querySelector('#iss-kpi-24h').textContent = s.openLast24h || 0;
  root.querySelector('#iss-kpi-server').textContent = (s.byKind && s.byKind.server) || 0;
  root.querySelector('#iss-kpi-client').textContent = (s.byKind && s.byKind.client) || 0;
}

async function loadIssues() {
  const res = await P.apiFetch('/api/ops/issues' + filterQuery());
  if (!res.ok) { setStatus('Failed to load issues (HTTP ' + res.status + ')'); return; }
  const data = await res.json();
  renderSummary(data.summary);
  const tbody = root.querySelector('#iss-tbody');
  const issues = data.issues || [];
  if (issues.length === 0) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No issues match</div></td></tr>'; return; }
  tbody.innerHTML = issues.map((i) =>
    '<tr class="iss-row" data-id="' + i.id + '" style="cursor:pointer">' +
    '<td><span class="badge badge-' + tone(i.status) + '">' + P.esc(i.status) + '</span>' + (i.regressedAt ? ' <span class="badge badge-warning" title="reopened after resolve">regressed</span>' : '') + '</td>' +
    '<td><span class="badge badge-' + (i.kind === 'client' ? 'info' : 'neutral') + '">' + P.esc(i.kind) + '</span> <span class="text-muted mono">' + P.esc(i.source) + '</span></td>' +
    '<td>' + P.esc(i.title) + '</td>' +
    '<td class="text-right mono">' + i.occurrenceCount + '</td>' +
    '<td class="text-muted">' + P.esc(P.relativeTime(i.firstSeenAt)) + '</td>' +
    '<td class="text-muted">' + P.esc(P.relativeTime(i.lastSeenAt)) + '</td>' +
    '<td class="mono text-muted">' + P.esc(i.lastAppVersion || '') + '</td></tr>').join('');
  setStatus(issues.length + ' issues');
}

async function act(id, action) {
  const res = await P.apiFetch('/api/ops/issues/' + id + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) { setStatus('Action failed (HTTP ' + res.status + ')'); return; }
  await Promise.all([loadIssues(), openIssue(id)]);
  if (P.refreshIssueBadge) P.refreshIssueBadge();
}

async function openIssue(id) {
  openIssueId = id;
  const panel = root.querySelector('#iss-detail');
  panel.style.display = 'block';
  panel.innerHTML = '<div class="empty">Loading issue #' + id + '…</div>';
  const res = await P.apiFetch('/api/ops/issues/' + id);
  if (!res.ok) { panel.innerHTML = '<div class="empty">Issue not found</div>'; return; }
  const data = await res.json();
  const i = data.issue;
  const actions = ['ack', 'resolve', 'mute', 'reopen'].filter((a) => !(a === 'reopen' && i.status === 'open') && !(a === 'ack' && i.status === 'acked') && !(a === 'resolve' && i.status === 'resolved') && !(a === 'mute' && i.status === 'muted'));
  const occ = (data.occurrences || []).map((o) =>
    '<tr><td class="mono text-muted">' + P.esc(P.shortDateTime(o.ts)) + '</td><td>' + P.esc(o.level) + '</td>' +
    '<td>' + (o.reqId ? '<a href="#requests" class="mono iss-req" data-req="' + P.esc(o.reqId) + '">' + P.esc(o.reqId.slice(0, 12)) + '</a>' : '<span class="text-muted">—</span>') + '</td>' +
    '<td class="mono text-muted">' + (o.userId != null ? o.userId : '') + '</td><td class="mono text-muted">' + P.esc(o.appVersion || '') + '</td>' +
    '<td>' + P.esc(o.message) + '</td></tr>').join('');
  panel.innerHTML =
    '<div class="card-header"><div class="card-title">🐞 #' + i.id + ' ' + P.esc(i.title) + '</div>' +
    '<div>' + actions.map((a) => '<button class="btn btn-ghost btn-sm iss-act" data-act="' + a + '">' + a + '</button>').join(' ') +
    ' <button class="btn btn-ghost btn-sm" id="iss-ticket">Create ticket</button>' +
    ' <button class="btn btn-ghost btn-sm" id="iss-close">Close</button></div></div>' +
    '<div class="grid grid-cols-4" style="padding:var(--space-3) 0">' +
    '<div><div class="kpi-label">Status</div><span class="badge badge-' + tone(i.status) + '">' + P.esc(i.status) + '</span></div>' +
    '<div><div class="kpi-label">Occurrences</div><div class="mono">' + i.occurrenceCount + '</div></div>' +
    '<div><div class="kpi-label">First / last seen</div><div class="text-muted" style="font-size:11px">' + P.esc(P.shortDateTime(i.firstSeenAt)) + '<br>' + P.esc(P.shortDateTime(i.lastSeenAt)) + '</div></div>' +
    '<div><div class="kpi-label">Links</div><div style="font-size:11px">' +
      (i.lastAlertId ? '<a href="#alerts" class="iss-alert">alert #' + i.lastAlertId + '</a> ' : '') +
      (i.lastReqId ? '<a href="#requests" class="mono iss-req" data-req="' + P.esc(i.lastReqId) + '">last request</a>' : '<span class="text-muted">no request id</span>') +
    '</div></div></div>' +
    (i.notes ? '<div class="text-muted" style="font-size:12px">Notes: ' + P.esc(i.notes) + '</div>' : '') +
    (i.sampleStack ? '<details><summary class="text-muted">Sample stack</summary><pre class="mono" style="font-size:11px;white-space:pre-wrap">' + P.esc(i.sampleStack) + '</pre></details>' : '') +
    '<div class="card-title" style="margin-top:var(--space-3)">Recent occurrences</div>' +
    '<div style="overflow-x:auto"><table class="data-table dense"><thead><tr><th>Time</th><th>Level</th><th>Request</th><th>User</th><th>App</th><th>Message</th></tr></thead><tbody>' +
    (occ || '<tr><td colspan="6"><div class="empty">No linked occurrences yet (rows recorded before this issue existed are not linked)</div></td></tr>') + '</tbody></table></div>';
  panel.querySelector('#iss-close').addEventListener('click', () => { panel.style.display = 'none'; openIssueId = null; });
  panel.querySelector('#iss-ticket').addEventListener('click', async () => {
    const res = await P.apiFetch('/api/ops/issues/' + i.id + '/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) { setStatus('Ticket creation failed (HTTP ' + res.status + ')'); return; }
    const data = await res.json();
    if (P.refreshSupportBadge) P.refreshSupportBadge();
    P.navigateTo('support');
    if (P.sections.support && P.sections.support.openTicket) P.sections.support.openTicket(data.ticket.id);
  });
  panel.querySelectorAll('.iss-act').forEach((b) => b.addEventListener('click', () => act(i.id, b.dataset.act)));
  panel.querySelectorAll('.iss-req').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    P.navigateTo('requests');
    if (P.sections.requests && P.sections.requests.showRequest) P.sections.requests.showRequest(a.dataset.req);
  }));
  panel.querySelectorAll('.iss-alert').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); P.navigateTo('alerts'); }));
}

async function loadChatV2Failures() {
  const box = root.querySelector('#iss-chatv2');
  try {
    const res = await P.apiFetch('/api/chat-core-v2/observability/failure-events?limit=20');
    if (res.status === 404) { box.innerHTML = '<div class="text-muted" style="font-size:12px">Chat Core v2 orchestrator is off (no failure feed).</div>'; return; }
    if (!res.ok) { box.innerHTML = '<div class="text-muted">Unavailable (HTTP ' + res.status + ')</div>'; return; }
    const data = await res.json();
    const events = data.events || data.rows || data.failureEvents || [];
    box.innerHTML = events.length
      ? '<table class="data-table dense"><tbody>' + events.slice(0, 20).map((e) => '<tr><td class="mono text-muted">' + P.esc(String(e.createdAt || e.ts || '')) + '</td><td class="mono text-muted">' + P.esc(String(e.tenantId || e.tenant_id || '')) + '</td><td>' + P.esc(String(e.redactedSummary || e.redacted_summary || e.status || '')) + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="text-muted" style="font-size:12px">No Chat Core v2 failure events.</div>';
  } catch (_) {
    box.innerHTML = '<div class="text-muted">Unavailable</div>';
  }
}

function setStatus(text) { root.querySelector('#iss-status').textContent = text; }

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Issues</h1>' +
    '<div class="section-subtitle">Server errors and iOS client errors grouped by fingerprint. Resolved issues that recur are reopened and raise an alert.</div></div>' +
    '<div class="section-actions"><button class="btn btn-ghost btn-sm" id="iss-refresh">Refresh</button></div></div>' +
    '<div class="grid grid-cols-4">' +
    '<div class="kpi-card featured"><div class="kpi-label">Open</div><div class="kpi-value" id="iss-kpi-open">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">Active last 24h</div><div class="kpi-value" id="iss-kpi-24h">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">Server (open+acked)</div><div class="kpi-value" id="iss-kpi-server">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">Client (open+acked)</div><div class="kpi-value" id="iss-kpi-client">—</div></div></div>' +
    '<div class="card mt-4" id="iss-detail" style="display:none;padding:var(--space-3) var(--space-4)"></div>' +
    '<div class="card mt-4"><div class="table-toolbar" id="iss-filters">' +
    '<select class="input" data-f="status" style="max-width:130px"><option value="open">open</option><option value="acked">acked</option><option value="resolved">resolved</option><option value="muted">muted</option><option value="all">all</option></select>' +
    '<select class="input" data-f="kind" style="max-width:120px"><option value="">any kind</option><option value="server">server</option><option value="client">client (iOS)</option></select>' +
    '<input class="input" type="search" data-f="q" placeholder="title contains…">' +
    '<button class="btn btn-ghost btn-sm" id="iss-apply">Apply</button>' +
    '<span class="text-muted" id="iss-status" style="margin-left:auto;font-size:11px"></span></div>' +
    '<div style="overflow-x:auto"><table class="data-table dense"><thead><tr><th>Status</th><th>Kind / source</th><th>Title</th><th class="text-right">Count</th><th>First</th><th>Last</th><th>App</th></tr></thead>' +
    '<tbody id="iss-tbody"><tr><td colspan="7"><div class="empty">Loading…</div></td></tr></tbody></table></div></div>' +
    '<div class="card mt-4"><div class="card-header"><div class="card-title">💬 Chat Core v2 failures</div><span class="card-subtitle">Failed orchestrator spans (redacted)</span></div><div id="iss-chatv2" style="padding:var(--space-3) var(--space-4)"><div class="empty">Loading…</div></div></div>';

  const apply = () => {
    root.querySelectorAll('[data-f]').forEach((el) => { filterState[el.dataset.f] = el.value.trim(); });
    loadIssues().catch((err) => setStatus(err.message));
  };
  root.querySelector('#iss-apply').addEventListener('click', apply);
  root.querySelector('#iss-filters').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  root.querySelector('#iss-refresh').addEventListener('click', () => { loadIssues(); loadChatV2Failures(); if (openIssueId) openIssue(openIssueId); });
  root.querySelector('#iss-tbody').addEventListener('click', (e) => {
    const row = e.target.closest('.iss-row');
    if (row) openIssue(Number(row.dataset.id));
  });
}

P.registerSection('issues', {
  mount,
  onShow() {
    loadIssues().catch((err) => setStatus(err.message));
    loadChatV2Failures();
  },
  openIssue(id) {
    filterState.status = 'all';
    const sel = root.querySelector('[data-f="status"]');
    if (sel) sel.value = 'all';
    loadIssues().catch((err) => setStatus(err.message));
    openIssue(id);
  },
});
