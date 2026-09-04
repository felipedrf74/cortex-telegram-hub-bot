// Support tab — ticket queue (feedback, bugs, incidents, access requests).
const P = window.NexusPortal;

let root = null;
let filterState = { status: 'active', kind: '', priority: '', q: '', userId: '' };
let openTicketId = null;

const STATUS_TONE = { new: 'error', open: 'warning', waiting_user: 'info', resolved: 'success', closed: 'neutral' };
const PRIORITY_TONE = { p0: 'error', p1: 'error', p2: 'warning', p3: 'neutral' };
const STATUSES = ['new', 'open', 'waiting_user', 'resolved', 'closed'];
const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];
const KINDS = ['feedback', 'bug', 'question', 'incident', 'access_request', 'data_request', 'task'];

function filterQuery() {
  const params = new URLSearchParams();
  Object.entries(filterState).forEach(([k, v]) => { if (v) params.set(k, v); });
  params.set('limit', '200');
  return '?' + params.toString();
}

function setStatus(text) { root.querySelector('#sup-status').textContent = text; }

function renderSummary(s) {
  const summary = s || { byStatus: {}, byPriority: {}, newOlderThan48h: 0, createdLast7d: 0 };
  root.querySelector('#sup-kpi-new').textContent = summary.byStatus.new || 0;
  root.querySelector('#sup-kpi-open').textContent = (summary.byStatus.open || 0) + (summary.byStatus.waiting_user || 0);
  root.querySelector('#sup-kpi-p1').textContent = (summary.byPriority.p0 || 0) + (summary.byPriority.p1 || 0);
  root.querySelector('#sup-kpi-stale').textContent = summary.newOlderThan48h || 0;
  const badge = document.getElementById('nav-support-count');
  if (badge) badge.textContent = summary.byStatus.new > 0 ? String(summary.byStatus.new) : '';
}

async function loadTickets() {
  const res = await P.apiFetch('/api/support/tickets' + filterQuery());
  if (!res.ok) { setStatus('Failed to load tickets (HTTP ' + res.status + ')'); return; }
  const data = await res.json();
  renderSummary(data.summary);
  const tbody = root.querySelector('#sup-tbody');
  const tickets = data.tickets || [];
  if (tickets.length === 0) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No tickets match</div></td></tr>'; setStatus(''); return; }
  tbody.innerHTML = tickets.map((t) =>
    '<tr class="sup-row" data-id="' + t.id + '" style="cursor:pointer">' +
    '<td class="mono">' + P.esc(t.ref) + '</td>' +
    '<td><span class="badge badge-' + (PRIORITY_TONE[t.priority] || 'neutral') + '">' + P.esc(t.priority) + '</span></td>' +
    '<td><span class="badge badge-' + (STATUS_TONE[t.status] || 'neutral') + '">' + P.esc(t.status) + '</span></td>' +
    '<td><span class="text-muted">' + P.esc(t.kind) + '</span> · <span class="text-muted">' + P.esc(t.source) + '</span></td>' +
    '<td>' + P.esc(t.title) + '</td>' +
    '<td class="mono text-muted">' + (t.userId != null ? t.userId : '') + '</td>' +
    '<td class="text-muted">' + P.esc(P.relativeTime(t.lastEventAt)) + '</td></tr>').join('');
  setStatus(tickets.length + ' tickets');
}

async function patchTicket(id, patch) {
  const res = await P.apiFetch('/api/support/tickets/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  if (!res.ok) { setStatus('Update failed (HTTP ' + res.status + ')'); return; }
  await Promise.all([loadTickets(), openTicket(id)]);
}

async function comment(id, body) {
  if (!body.trim()) return;
  const res = await P.apiFetch('/api/support/tickets/' + id + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
  if (!res.ok) { setStatus('Comment failed (HTTP ' + res.status + ')'); return; }
  await openTicket(id);
}

async function link(id, links) {
  const res = await P.apiFetch('/api/support/tickets/' + id + '/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(links) });
  if (!res.ok) { setStatus('Link failed (HTTP ' + res.status + ')'); return; }
  await openTicket(id);
}

function select(id, options, value) {
  return '<select class="input" id="' + id + '" style="max-width:150px">' + options.map((o) => '<option value="' + o + '"' + (o === value ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>';
}

async function openTicket(id) {
  openTicketId = id;
  const panel = root.querySelector('#sup-detail');
  panel.style.display = 'block';
  panel.innerHTML = '<div class="empty">Loading ticket…</div>';
  const res = await P.apiFetch('/api/support/tickets/' + id);
  if (!res.ok) { panel.innerHTML = '<div class="empty">Ticket not found</div>'; return; }
  const data = await res.json();
  const t = data.ticket;
  const events = (data.events || []).map((e) => {
    const meta = e.meta ? Object.entries(e.meta).map(([k, v]) => k + ': ' + (v == null ? '—' : String(v))).join(', ') : '';
    return '<div style="padding:6px 0;border-bottom:1px solid var(--border)">' +
      '<span class="text-muted mono" style="font-size:11px">' + P.esc(P.shortDateTime(e.ts)) + '</span> ' +
      '<span class="badge badge-neutral">' + P.esc(e.type) + '</span> <span class="text-muted" style="font-size:11px">' + P.esc(e.actor) + '</span>' +
      (e.body ? '<div style="white-space:pre-wrap;margin-top:4px">' + P.esc(e.body) + '</div>' : '') +
      (meta ? '<div class="text-muted mono" style="font-size:11px;margin-top:2px">' + P.esc(meta) + '</div>' : '') + '</div>';
  }).join('');
  const links = [];
  if (t.userId != null) links.push('<a href="#users" class="sup-link-user" data-user="' + t.userId + '">user #' + t.userId + '</a>');
  if (t.issueId) links.push('<a href="#issues" class="sup-link-issue" data-issue="' + t.issueId + '">issue #' + t.issueId + '</a>');
  if (t.alertId) links.push('<a href="#alerts" class="sup-link-alert">alert #' + t.alertId + '</a>');
  if (t.reqId) links.push('<a href="#requests" class="mono sup-link-req" data-req="' + P.esc(t.reqId) + '">request ' + P.esc(t.reqId.slice(0, 12)) + '</a>');
  if (t.clientErrorId) links.push('<span class="text-muted">client error #' + t.clientErrorId + '</span>');
  if (t.externalRef) links.push('<span class="text-muted">ref: ' + P.esc(t.externalRef) + '</span>');
  panel.innerHTML =
    '<div class="card-header"><div class="card-title">🎫 ' + P.esc(t.ref) + ' · ' + P.esc(t.title) + '</div>' +
    '<button class="btn btn-ghost btn-sm" id="sup-close">Close</button></div>' +
    '<div class="grid grid-cols-4" style="padding:var(--space-3) 0;gap:var(--space-3)">' +
    '<div><div class="kpi-label">Status</div>' + select('sup-f-status', STATUSES, t.status) + '</div>' +
    '<div><div class="kpi-label">Priority</div>' + select('sup-f-priority', PRIORITIES, t.priority) + '</div>' +
    '<div><div class="kpi-label">Kind</div>' + select('sup-f-kind', KINDS, t.kind) + '</div>' +
    '<div><div class="kpi-label">Assignee</div><input class="input" id="sup-f-assignee" value="' + P.esc(t.assignee || '') + '" placeholder="unassigned" style="max-width:150px"></div></div>' +
    '<div class="text-muted" style="font-size:12px">source ' + P.esc(t.source) + ' · created ' + P.esc(P.shortDateTime(t.createdAt)) + ' by ' + P.esc(t.createdBy) +
    (t.appVersion ? ' · app ' + P.esc(t.appVersion) : '') + (t.osVersion ? ' · ' + P.esc(t.osVersion) : '') + (t.screen ? ' · ' + P.esc(t.screen) : '') + '</div>' +
    '<div style="margin:var(--space-2) 0;display:flex;flex-wrap:wrap;gap:var(--space-2)">' + (links.join(' · ') || '<span class="text-muted">no links</span>') +
    ' <span class="text-muted">·</span> <input class="input" id="sup-link-value" placeholder="link issue #, alert #, user # or request id" style="max-width:280px">' +
    '<button class="btn btn-ghost btn-sm" id="sup-link-btn">Link</button></div>' +
    (t.body ? '<div class="card-title" style="margin-top:var(--space-3)">Report</div><div style="white-space:pre-wrap">' + P.esc(t.body) + '</div>' : '') +
    '<div class="card-title" style="margin-top:var(--space-3)">Timeline</div>' + (events || '<div class="text-muted">no events</div>') +
    '<div style="margin-top:var(--space-3);display:flex;gap:var(--space-2)"><textarea class="input" id="sup-comment" rows="2" placeholder="Operator note (never shown to the user)"></textarea>' +
    '<button class="btn btn-ghost btn-sm" id="sup-comment-btn">Add note</button></div>';

  panel.querySelector('#sup-close').addEventListener('click', () => { panel.style.display = 'none'; openTicketId = null; });
  panel.querySelector('#sup-f-status').addEventListener('change', (e) => patchTicket(t.id, { status: e.target.value }));
  panel.querySelector('#sup-f-priority').addEventListener('change', (e) => patchTicket(t.id, { priority: e.target.value }));
  panel.querySelector('#sup-f-kind').addEventListener('change', (e) => patchTicket(t.id, { kind: e.target.value }));
  panel.querySelector('#sup-f-assignee').addEventListener('change', (e) => patchTicket(t.id, { assignee: e.target.value }));
  panel.querySelector('#sup-comment-btn').addEventListener('click', () => comment(t.id, panel.querySelector('#sup-comment').value));
  panel.querySelector('#sup-link-btn').addEventListener('click', () => {
    const raw = panel.querySelector('#sup-link-value').value.trim();
    if (!raw) return;
    const m = raw.match(/^(issue|alert|user)\s*#?\s*(\d+)$/i);
    if (m) {
      const key = m[1].toLowerCase() + 'Id';
      link(t.id, { [key]: Number(m[2]) });
    } else {
      link(t.id, { reqId: raw });
    }
  });
  panel.querySelectorAll('.sup-link-issue').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); P.navigateTo('issues');
    if (P.sections.issues && P.sections.issues.openIssue) P.sections.issues.openIssue(Number(a.dataset.issue));
  }));
  panel.querySelectorAll('.sup-link-req').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); P.navigateTo('requests');
    if (P.sections.requests && P.sections.requests.showRequest) P.sections.requests.showRequest(a.dataset.req);
  }));
  panel.querySelectorAll('.sup-link-alert').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); P.navigateTo('alerts'); }));
  panel.querySelectorAll('.sup-link-user').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); P.navigateTo('users'); }));
}

async function createTicket() {
  const title = root.querySelector('#sup-new-title').value.trim();
  if (!title) { setStatus('Title is required'); return; }
  const payload = {
    title,
    kind: root.querySelector('#sup-new-kind').value,
    priority: root.querySelector('#sup-new-priority').value,
    body: root.querySelector('#sup-new-body').value.trim() || undefined,
    userId: root.querySelector('#sup-new-user').value.trim() || undefined,
    source: root.querySelector('#sup-new-source').value,
  };
  const res = await P.apiFetch('/api/support/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) { setStatus('Create failed (HTTP ' + res.status + ')'); return; }
  const data = await res.json();
  root.querySelector('#sup-new-title').value = '';
  root.querySelector('#sup-new-body').value = '';
  root.querySelector('#sup-new').style.display = 'none';
  await loadTickets();
  openTicket(data.ticket.id);
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Support</h1>' +
    '<div class="section-subtitle">Tickets from in-app feedback, promoted issues and alerts, email intake, and operator tasks. User text is sanitized; chat content is never attached.</div></div>' +
    '<div class="section-actions"><button class="btn btn-ghost btn-sm" id="sup-new-toggle">+ New ticket</button><button class="btn btn-ghost btn-sm" id="sup-refresh">Refresh</button></div></div>' +
    '<div class="grid grid-cols-4">' +
    '<div class="kpi-card featured"><div class="kpi-label">New</div><div class="kpi-value" id="sup-kpi-new">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">In progress</div><div class="kpi-value" id="sup-kpi-open">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">P0 / P1 active</div><div class="kpi-value" id="sup-kpi-p1">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">New &gt; 48h</div><div class="kpi-value" id="sup-kpi-stale">—</div></div></div>' +
    '<div class="card mt-4" id="sup-new" style="display:none;padding:var(--space-3) var(--space-4)"><div class="card-title">New ticket</div>' +
    '<div class="table-toolbar" style="padding:0;margin-top:var(--space-2)"><input class="input" id="sup-new-title" placeholder="Title">' +
    select('sup-new-kind', KINDS, 'task') + select('sup-new-priority', PRIORITIES, 'p3') + select('sup-new-source', ['operator', 'email', 'waitlist'], 'operator') +
    '<input class="input" id="sup-new-user" placeholder="user id (optional)" style="max-width:150px"></div>' +
    '<textarea class="input" id="sup-new-body" rows="3" placeholder="Details (sanitized; no chat content)" style="margin-top:var(--space-2)"></textarea>' +
    '<div style="margin-top:var(--space-2)"><button class="btn btn-ghost btn-sm" id="sup-create">Create</button></div></div>' +
    '<div class="card mt-4" id="sup-detail" style="display:none;padding:var(--space-3) var(--space-4)"></div>' +
    '<div class="card mt-4"><div class="table-toolbar" id="sup-filters">' +
    select('sup-f-list-status', ['active', 'new', 'open', 'waiting_user', 'resolved', 'closed', 'all'], 'active') +
    '<select class="input" data-f="kind" style="max-width:150px"><option value="">any kind</option>' + KINDS.map((k) => '<option value="' + k + '">' + k + '</option>').join('') + '</select>' +
    '<select class="input" data-f="priority" style="max-width:110px"><option value="">any priority</option>' + PRIORITIES.map((k) => '<option value="' + k + '">' + k + '</option>').join('') + '</select>' +
    '<input class="input" type="search" data-f="q" placeholder="title or ref contains…">' +
    '<button class="btn btn-ghost btn-sm" id="sup-apply">Apply</button>' +
    '<span class="text-muted" id="sup-status" style="margin-left:auto;font-size:11px"></span></div>' +
    '<div style="overflow-x:auto"><table class="data-table dense"><thead><tr><th>Ref</th><th>Priority</th><th>Status</th><th>Kind / source</th><th>Title</th><th>User</th><th>Last event</th></tr></thead>' +
    '<tbody id="sup-tbody"><tr><td colspan="7"><div class="empty">Loading…</div></td></tr></tbody></table></div></div>';

  root.querySelector('#sup-f-list-status').setAttribute('data-f', 'status');
  const apply = () => {
    filterState.userId = '';
    root.querySelectorAll('[data-f]').forEach((el) => { filterState[el.dataset.f] = el.value.trim(); });
    loadTickets().catch((err) => setStatus(err.message));
  };
  root.querySelector('#sup-apply').addEventListener('click', apply);
  root.querySelector('#sup-filters').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  root.querySelector('#sup-refresh').addEventListener('click', () => { loadTickets(); if (openTicketId) openTicket(openTicketId); });
  root.querySelector('#sup-new-toggle').addEventListener('click', () => { const el = root.querySelector('#sup-new'); el.style.display = el.style.display === 'none' ? 'block' : 'none'; });
  root.querySelector('#sup-create').addEventListener('click', createTicket);
  root.querySelector('#sup-tbody').addEventListener('click', (e) => {
    const row = e.target.closest('.sup-row');
    if (row) openTicket(Number(row.dataset.id));
  });
}

P.registerSection('support', {
  mount,
  onShow() { loadTickets().catch((err) => setStatus(err.message)); },
  showUser(userId) {
    filterState = { status: 'all', kind: '', priority: '', q: '', userId: String(userId) };
    const sel = root.querySelector('#sup-f-list-status');
    if (sel) sel.value = 'all';
    root.querySelectorAll('[data-f]').forEach((el) => { if (el.dataset.f !== 'status') el.value = ''; });
    loadTickets().catch((err) => setStatus(err.message));
    setStatus('Showing tickets for user #' + userId);
  },
  openTicket(id) {
    filterState.userId = '';
    filterState.status = 'all';
    const sel = root.querySelector('#sup-f-list-status');
    if (sel) sel.value = 'all';
    loadTickets().catch((err) => setStatus(err.message));
    openTicket(id);
  },
});
