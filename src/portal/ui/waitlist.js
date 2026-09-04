// Waitlist tab — landing-page signups, founder slots, approve → invite.
// Filters (status, intent) hit the API; the search box filters client-side
// over the cached entries so typing feels instant.
const P = window.NexusPortal;

let root = null;
let entries = [];
let searchTimer = null;

function el(id) { return root.querySelector('#' + id); }
function setText(id, value) { const node = el(id); if (node) node.textContent = value; }

function updateNavBadge(pending) {
  const badge = document.getElementById('waitlist-nav-count');
  if (!badge) return;
  if (pending > 0) badge.textContent = pending;
  badge.hidden = !(pending > 0);
}

async function fetchWaitlist(params) {
  return P.apiJson('/api/waitlist?' + params.toString());
}

async function load() {
  try {
    const params = new URLSearchParams();
    const status = el('waitlist-filter-status').value;
    const intent = el('waitlist-filter-intent').value;
    if (status) params.set('status', status);
    if (intent) params.set('intent', intent);
    params.set('limit', '500');
    const d = await fetchWaitlist(params);
    if (!d.ok) return;
    entries = d.entries || [];
    const founder = (d.counters && d.counters.founder) || { filled: 0, max: 100 };
    const totals = (d.counters && d.counters.totals) || {};
    setText('waitlist-kpi-founder', founder.filled || 0);
    setText('waitlist-kpi-founder-sub', 'of ' + (founder.max || 100));
    setText('waitlist-kpi-general', totals.general_total || 0);
    setText('waitlist-kpi-pending', totals.pending_total || 0);
    setText('waitlist-kpi-signed', totals.signed_up_total || 0);
    updateNavBadge(totals.pending_total || 0);
    render();
  } catch (err) {
    entries = [];
    ['waitlist-kpi-founder', 'waitlist-kpi-general', 'waitlist-kpi-pending', 'waitlist-kpi-signed'].forEach((id) => setText(id, '—'));
    setText('waitlist-count-label', '');
    P.setTableError('waitlist-tbody', 7, 'Could not load waitlist', err);
  }
}

const STATUS_BADGES = {
  pending: '<span class="badge badge-warning">⏳ Pending</span>',
  approved: '<span class="badge badge-success">✓ Approved</span>',
  invited: '<span class="badge badge-info">📧 Invited</span>',
  signed_up: '<span class="badge badge-success">🎉 Signed up</span>',
  rejected: '<span class="badge badge-error">✕ Rejected</span>',
};

function render() {
  const tbody = el('waitlist-tbody');
  const search = (el('waitlist-search').value || '').toLowerCase();
  const rows = search ? entries.filter((r) => (r.email || '').toLowerCase().includes(search)) : entries;
  setText('waitlist-count-label', rows.length + ' / ' + entries.length + ' entries');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No waitlist entries match your filters.</div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => {
    const statusHtml = STATUS_BADGES[r.status] || '<span class="badge badge-neutral">' + P.esc(r.status) + '</span>';
    const intentHtml = r.intent === 'founder'
      ? '<span class="badge badge-accent">🏆 Founder</span>'
      : '<span class="badge badge-neutral">General</span>';
    const slotHtml = r.founder_slot ? '<span class="mono">#' + r.founder_slot + '</span>' : '<span class="text-tertiary">—</span>';
    const srcHtml = r.source
      ? '<span class="u-fs-11 mono text-muted">' + P.esc(r.source) + '</span>'
      : '<span class="text-tertiary">—</span>';
    let actionsHtml = '';
    if (r.status === 'pending') {
      actionsHtml =
        '<button class="btn btn-primary btn-xs" data-op="approve" data-id="' + r.id + '">Approve → invite</button> ' +
        '<button class="btn btn-danger btn-xs" data-op="reject" data-id="' + r.id + '">Reject</button>';
    } else if (r.status === 'approved' && r.invite_code) {
      actionsHtml =
        '<button class="btn btn-xs" data-op="copy" data-code="' + P.esc(r.invite_code) + '">Copy code</button> ' +
        '<button class="btn btn-xs" data-op="invited" data-id="' + r.id + '">Mark emailed</button>';
    }
    return '<tr>' +
      '<td><div class="user-name">' + P.esc(r.email) + '</div>' +
      (r.use_case ? '<div class="u-maxw-320 u-ov-hidden u-to-ellipsis user-handle">' + P.esc(r.use_case) + '</div>' : '') +
      '</td>' +
      '<td>' + intentHtml + '</td>' +
      '<td>' + srcHtml + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td>' + slotHtml + '</td>' +
      '<td class="u-fs-11 text-muted mono">' + (r.created_at ? P.shortDateTime(r.created_at) : '—') + '</td>' +
      '<td class="text-right">' + actionsHtml + '</td>' +
    '</tr>';
  }).join('');
}

async function approve(id) {
  try {
    const r = await P.apiFetch('/api/waitlist/' + encodeURIComponent(id) + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 30 }),
    });
    const d = await r.json();
    if (d.ok) {
      P.showToast('✓ Approved — invite code: ' + d.code);
      try { await navigator.clipboard.writeText(d.code); } catch (_) { /* clipboard is optional */ }
    } else {
      P.showToast('Approval failed: ' + (d.error || 'unknown'), false);
    }
    load();
  } catch (_) {
    P.showToast('Error approving', false);
  }
}

async function reject(id) {
  if (!window.confirm('Reject this waitlist entry?')) return;
  try {
    const r = await P.apiFetch('/api/waitlist/' + encodeURIComponent(id) + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    if (d.ok) P.showToast('Rejected');
    load();
  } catch (_) {
    P.showToast('Error', false);
  }
}

async function markInvited(id) {
  try {
    const r = await P.apiFetch('/api/waitlist/' + encodeURIComponent(id) + '/invited', { method: 'POST' });
    if (r.ok) P.showToast('Marked as invited');
    load();
  } catch (_) {
    P.showToast('Error', false);
  }
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    P.showToast('Copied ' + code);
  } catch (_) {
    P.showToast('Copy failed', false);
  }
}

function exportCsv() {
  if (entries.length === 0) { P.showToast('No data to export', false); return; }
  const headers = ['email', 'intent', 'source', 'status', 'founder_slot', 'use_case', 'utm_source', 'utm_campaign', 'created_at', 'approved_at', 'invite_code'];
  const rows = entries.map((e) => headers.map((h) => {
    const v = e[h];
    if (v == null) return '';
    return '"' + String(v).replace(/"/g, '""') + '"';
  }).join(','));
  const blob = new Blob([headers.join(',') + '\n' + rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'waitlist-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  P.showToast('Exported ' + entries.length + ' entries');
}

// Pending count for the nav badge without opening the tab (called from app start).
async function refreshBadge() {
  try {
    const d = await fetchWaitlist(new URLSearchParams({ status: 'pending', limit: '1' }));
    updateNavBadge((d.counters && d.counters.totals && d.counters.totals.pending_total) || 0);
  } catch (_) {
    // badge is best-effort
  }
}

function kpi(label, id, sub, subId) {
  return '<div class="kpi-card"><div class="kpi-label">' + label + '</div><div class="kpi-value" id="' + id + '">—</div>' +
    '<div class="kpi-sub"' + (subId ? ' id="' + subId + '"' : '') + '>' + sub + '</div></div>';
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Waitlist</h1>' +
    '<div class="section-subtitle">Landing page signups · founder slots · approve to invite</div></div>' +
    '<div class="section-actions"><button class="btn btn-ghost btn-sm" id="waitlist-refresh-btn">Refresh</button>' +
    '<button class="btn btn-primary btn-sm" id="waitlist-export-btn">Export CSV</button></div></div>' +
    '<div class="u-mb-space-4 grid grid-cols-4">' +
    kpi('Founder slots', 'waitlist-kpi-founder', 'of 100', 'waitlist-kpi-founder-sub') +
    kpi('General waitlist', 'waitlist-kpi-general', 'total signups') +
    kpi('Pending approval', 'waitlist-kpi-pending', 'awaiting review') +
    kpi('Signed up', 'waitlist-kpi-signed', 'redeemed invite') + '</div>' +
    '<div class="card"><div class="table-toolbar">' +
    '<input class="u-maxw-240 input" type="search" placeholder="Search email…" id="waitlist-search">' +
    '<select class="u-maxw-160 input" id="waitlist-filter-status"><option value="">All statuses</option><option value="pending" selected>Pending</option><option value="approved">Approved</option><option value="invited">Invited</option><option value="signed_up">Signed up</option><option value="rejected">Rejected</option></select>' +
    '<select class="u-maxw-140 input" id="waitlist-filter-intent"><option value="">All intents</option><option value="founder">🏆 Founder</option><option value="general">General</option></select>' +
    '<span class="u-ml-auto u-fs-11 text-muted mono" id="waitlist-count-label"></span></div>' +
    '<div class="u-ovx-auto"><table class="data-table" id="waitlist-table"><thead><tr>' +
    '<th>Email</th><th>Intent</th><th>Source</th><th>Status</th><th>Founder #</th><th>Signed up</th><th class="text-right">Actions</th></tr></thead>' +
    '<tbody id="waitlist-tbody"><tr><td colspan="7"><div class="empty">Loading waitlist…</div></td></tr></tbody></table></div></div>';

  el('waitlist-refresh-btn').addEventListener('click', load);
  el('waitlist-export-btn').addEventListener('click', exportCsv);
  el('waitlist-filter-status').addEventListener('change', load);
  el('waitlist-filter-intent').addEventListener('change', load);
  el('waitlist-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op]');
    if (!btn) return;
    const op = btn.dataset.op;
    if (op === 'approve') approve(btn.dataset.id);
    else if (op === 'reject') reject(btn.dataset.id);
    else if (op === 'invited') markInvited(btn.dataset.id);
    else if (op === 'copy') copyCode(btn.dataset.code);
  });
}

P.registerSection('waitlist', {
  mount,
  onShow() { load(); },
  refreshBadge,
});
