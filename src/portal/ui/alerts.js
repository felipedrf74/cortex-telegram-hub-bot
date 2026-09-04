// Operator Alerts tab — durable incident queue with delivery status, ack,
// resolve, retry and ticket promotion. Also paints the dashboard's alerts
// card and the nav badge from the live alerts stream.
const P = window.NexusPortal;

let root = null;
let alerts = [];
let delivery = {};

function el(id) { return root ? root.querySelector('#' + id) : null; }
function fmtNum(n) { return Number(n || 0).toLocaleString(); }

function renderDashAlerts(list) {
  const box = document.getElementById('dash-alerts');
  if (!box) return;
  const active = (list || []).filter((a) => a.status !== 'resolved').slice(0, 4);
  if (active.length === 0) {
    box.innerHTML = '<div class="empty">No active operator alerts</div>';
    return;
  }
  box.innerHTML = active.map((a) => {
    const dot = a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'online';
    return '<div class="flex-between" style="padding:var(--space-2) var(--space-1);border-bottom:1px solid var(--border)">' +
      '<div class="flex gap-2" style="align-items:center;min-width:0">' +
        '<span class="status-dot ' + dot + '"></span>' +
        '<span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + P.esc(a.title) + '</span>' +
      '</div>' +
      '<span class="text-tertiary mono" style="font-size:10px">' + P.esc(a.deliveryStatus || 'pending') + '</span>' +
      '</div>';
  }).join('');
}

function renderTable() {
  if (!root) return;
  const openCount = alerts.filter((a) => a.status === 'open').length;
  const navBadge = document.getElementById('nav-alerts-count');
  if (navBadge) navBadge.textContent = openCount > 0 ? String(openCount) : '';
  el('alerts-kpi-pending').textContent = fmtNum(delivery.pending);
  el('alerts-kpi-delivered').textContent = fmtNum(delivery.delivered);
  el('alerts-kpi-failed').textContent = fmtNum(delivery.failed);
  el('alerts-kpi-dead').textContent = fmtNum(delivery.dead_letter);
  el('alerts-count-label').textContent = alerts.length + ' shown';
  const tbody = el('alerts-tbody');
  if (alerts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No alerts in this state</div></td></tr>';
    return;
  }
  tbody.innerHTML = alerts.map((a) => {
    const severityClass = a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info';
    const statusClass = a.status === 'resolved' ? 'success' : a.status === 'acknowledged' ? 'info' : 'warning';
    const deliveryClass =
      a.deliveryStatus === 'delivered' ? 'success' :
      a.deliveryStatus === 'dead_letter' ? 'error' :
      a.deliveryStatus === 'failed' || a.deliveryStatus === 'not_configured' ? 'warning' :
      'neutral';
    const button = (op, label, title) => '<button class="btn btn-ghost btn-sm" data-op="' + op + '" data-id="' + a.id + '"' + (title ? ' title="' + title + '"' : '') + '>' + label + '</button>';
    const retryButton = (a.deliveryStatus === 'failed' || a.deliveryStatus === 'dead_letter' || a.deliveryStatus === 'not_configured') ? button('retry-delivery', 'Retry') : '';
    const ackButton = a.status === 'open' ? button('ack', 'Ack') : '';
    const resolveButton = a.status !== 'resolved' ? button('resolve', 'Resolve') : '';
    const ticketButton = button('ticket', 'Ticket', 'Open a support ticket for this alert');
    return '<tr>' +
      '<td><div style="font-weight:600">' + P.esc(a.title) + '</div>' +
        '<div class="text-muted" style="font-size:11px;max-width:520px">' + P.esc(a.userImpact || a.detail || '—') + '</div>' +
        '<div class="text-tertiary mono" style="font-size:10px">' + P.esc(a.source) + ' · ' + P.esc(a.suspectedArea || 'unknown') + '</div></td>' +
      '<td><span class="badge badge-' + severityClass + '">' + P.esc(a.severity) + '</span></td>' +
      '<td><span class="badge badge-' + statusClass + '">' + P.esc(a.status) + '</span></td>' +
      '<td><span class="badge badge-' + deliveryClass + '">' + P.esc(a.deliveryStatus || 'pending') + '</span>' +
        (a.lastDeliveryError ? '<div class="text-tertiary" style="font-size:10px;margin-top:4px">' + P.esc(a.lastDeliveryError).slice(0, 90) + '</div>' : '') +
        (a.nextDeliveryAttemptAt ? '<div class="text-tertiary" style="font-size:10px;margin-top:4px">next ' + P.relativeTime(a.nextDeliveryAttemptAt) + '</div>' : '') +
        '</td>' +
      '<td>' + P.esc(a.owner || 'ops') + '</td>' +
      '<td class="text-muted">' + P.relativeTime(a.lastSeenAt || a.createdAt) + '<div class="mono text-tertiary" style="font-size:10px">' + fmtNum(a.occurrenceCount || 1) + 'x</div></td>' +
      '<td><div class="flex gap-2" style="justify-content:flex-end">' + retryButton + ackButton + resolveButton + ticketButton + '</div></td>' +
      '</tr>';
  }).join('');
}

function currentStatus() {
  const sel = el('alerts-filter-status');
  return (sel && sel.value) || 'open';
}

async function load() {
  const status = currentStatus();
  try {
    const r = await P.apiFetch('/api/operator-alerts?status=' + encodeURIComponent(status) + '&limit=50');
    if (!r.ok) throw new Error('alerts unavailable');
    const d = await r.json();
    alerts = d.alerts || [];
    delivery = d.delivery || {};
    renderTable();
    if (status === 'open') renderDashAlerts(alerts);
  } catch (_) {
    const tbody = el('alerts-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="empty">Unable to load operator alerts</div></td></tr>';
    const dash = document.getElementById('dash-alerts');
    if (dash) dash.innerHTML = '<div class="empty">Unable to load alerts</div>';
  }
}

async function mutate(id, action, successMessage) {
  try {
    const r = await P.apiFetch('/api/operator-alerts/' + id + '/' + action, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error('mutation failed');
    P.showToast(successMessage);
    await load();
  } catch (_) {
    P.showToast('Alert action failed', false);
  }
}

async function ticketFromAlert(id) {
  try {
    const r = await P.apiFetch('/api/operator-alerts/' + id + '/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) return;
    const d = await r.json();
    if (P.refreshSupportBadge) P.refreshSupportBadge();
    P.navigateTo('support');
    const support = P.sections.support;
    if (support && support.openTicket) support.openTicket(d.ticket.id);
  } catch (_) {
    // surfaced by apiFetch
  }
}

// Live push from /api/ops/alerts/stream (open alerts): keep the dashboard
// card and, when the tab shows open alerts, the table current without polling.
P.onAlertsPush = (payload) => {
  const list = payload.alerts || [];
  renderDashAlerts(list);
  if (root && root.classList.contains('active') && currentStatus() === 'open') {
    alerts = list;
    delivery = payload.delivery || delivery;
    renderTable();
  }
};

function kpi(label, id) {
  return '<div class="kpi-card"><div class="kpi-label">' + label + '</div><div class="kpi-value" id="' + id + '">—</div></div>';
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Operator Alerts</h1>' +
    '<div class="section-subtitle">Durable incident queue, delivery status, acknowledgement, and resolution</div></div>' +
    '<div class="section-actions"><select class="input" id="alerts-filter-status" style="max-width:150px">' +
    '<option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="all">All</option></select>' +
    '<button class="btn btn-ghost btn-sm" id="alerts-refresh-btn">Refresh</button></div></div>' +
    '<div class="grid grid-cols-4">' + kpi('Pending', 'alerts-kpi-pending') + kpi('Delivered', 'alerts-kpi-delivered') + kpi('Retrying', 'alerts-kpi-failed') + kpi('Dead Letter', 'alerts-kpi-dead') + '</div>' +
    '<div class="card mt-4"><div class="card-header"><div class="card-title">Alert Queue</div><span class="card-subtitle" id="alerts-count-label">—</span></div>' +
    '<div style="overflow-x:auto"><table class="data-table"><thead><tr>' +
    '<th>Alert</th><th>Severity</th><th>Status</th><th>Delivery</th><th>Owner</th><th>Last Seen</th><th></th></tr></thead>' +
    '<tbody id="alerts-tbody"><tr><td colspan="7"><div class="empty">Loading alerts…</div></td></tr></tbody></table></div></div>';
  el('alerts-refresh-btn').addEventListener('click', load);
  el('alerts-filter-status').addEventListener('change', load);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.op === 'ack') mutate(id, 'ack', 'Alert acknowledged');
    else if (btn.dataset.op === 'resolve') mutate(id, 'resolve', 'Alert resolved');
    else if (btn.dataset.op === 'retry-delivery') mutate(id, 'retry-delivery', 'Delivery retry queued');
    else if (btn.dataset.op === 'ticket') ticketFromAlert(id);
  });
}

// Dashboard card before the tab is ever opened.
async function refreshBadge() {
  try {
    const r = await P.apiFetch('/api/operator-alerts?status=open&limit=50');
    if (!r.ok) return;
    const d = await r.json();
    renderDashAlerts(d.alerts || []);
    const navBadge = document.getElementById('nav-alerts-count');
    if (navBadge) navBadge.textContent = (d.alerts || []).length > 0 ? String((d.alerts || []).length) : '';
  } catch (_) {
    // best-effort
  }
}

P.registerSection('alerts', {
  mount,
  onShow() { load(); },
  refreshBadge,
});
