// Audit tab — GDPR action log with user/action/resource/text/time filters,
// cursor paging and a server-rendered CSV export. First legacy section moved
// out of ui/legacy.js into a module (Phase 5).
const P = window.NexusPortal;

let root = null;
let entries = [];
let nextBeforeId = null;
let usersPopulated = false;
let facetsLoaded = false;

function el(id) { return root.querySelector('#' + id); }

function filterParams() {
  const params = new URLSearchParams();
  const get = (id) => (el(id) ? el(id).value || '' : '').trim();
  if (get('audit-filter')) params.set('userId', get('audit-filter'));
  if (get('audit-action')) params.set('action', get('audit-action'));
  if (get('audit-resource')) params.set('resource', get('audit-resource'));
  if (get('audit-q')) params.set('q', get('audit-q'));
  if (get('audit-since')) params.set('since', new Date(get('audit-since')).toISOString());
  if (get('audit-until')) params.set('until', new Date(get('audit-until')).toISOString());
  return params;
}

// Populate the user dropdown from the shared /api/users endpoint once per
// session; a manual Refresh forces a reload.
async function populateUsers(force) {
  if (usersPopulated && !force) return;
  const d = await P.apiJson('/api/users');
  const users = d.users || [];
  const sel = el('audit-filter');
  const current = sel.value;
  const sorted = [...users].sort((a, b) => {
    const at = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
    const bt = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
    return bt - at;
  });
  sel.innerHTML = ['<option value="">All users</option>'].concat(sorted.map((u) => {
    const name = u.first_name || u.username || ('User #' + u.id);
    const handle = u.username ? ' @' + u.username : '';
    return '<option value="' + u.id + '">' + P.esc(name + handle) + ' · ' + u.id + '</option>';
  })).join('');
  if (current) sel.value = current;
  usersPopulated = true;
}

async function populateFacets() {
  if (facetsLoaded) return;
  try {
    const d = await P.apiJson('/api/audit-trail/facets');
    const sel = el('audit-action');
    const current = sel.value;
    sel.innerHTML = '<option value="">All actions</option>' + (d.actions || []).map((a) => '<option value="' + P.esc(a.value) + '">' + P.esc(a.value) + ' (' + a.count + ')</option>').join('');
    sel.value = current;
    facetsLoaded = true;
  } catch (_) {
    // facets are a convenience; the free-text filters still work
  }
}

function render() {
  const tbody = el('audit-tbody');
  el('audit-count-label').textContent = entries.length + ' entries';
  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty">No audit entries</div></td></tr>';
    return;
  }
  tbody.innerHTML = entries.map((e) => '<tr>' +
    '<td class="u-fs-11 mono text-muted">' + P.shortDateTime(e.ts) + '</td>' +
    '<td class="mono">' + (e.user_id || '—') + '</td>' +
    '<td><span class="badge badge-info">' + P.esc(e.action) + '</span></td>' +
    '<td class="text-muted">' + P.esc(e.resource || '—') + '</td>' +
    '<td class="u-maxw-300 u-ov-hidden u-to-ellipsis u-ws-nowrap text-muted">' + P.esc(e.details || '—') + '</td>' +
  '</tr>').join('');
}

async function load(append) {
  try {
    await populateUsers(false);
    await populateFacets();
    const params = filterParams();
    params.set('limit', '200');
    if (append && nextBeforeId) params.set('beforeId', String(nextBeforeId));
    const d = await P.apiJson('/api/audit-trail?' + params.toString());
    entries = append ? entries.concat(d.entries || []) : (d.entries || []);
    nextBeforeId = d.nextBeforeId || null;
    el('audit-more').hidden = !nextBeforeId;
    render();
  } catch (err) {
    entries = [];
    el('audit-count-label').textContent = '0 entries';
    P.setTableError('audit-tbody', 5, 'Could not load audit trail', err);
  }
}

async function exportCsv() {
  const params = filterParams();
  params.set('format', 'csv');
  params.set('limit', '500');
  try {
    const res = await P.apiFetch('/api/audit-trail?' + params.toString());
    if (!res.ok) { P.showToast('Export failed (HTTP ' + res.status + ')', false); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audit-trail-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    P.showToast('Exported audit trail (current filters, up to 500 rows)');
  } catch (err) {
    P.showToast('Export failed: ' + P.adminLoadErrorMessage(err), false);
  }
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Audit Trail</h1>' +
    '<div class="section-subtitle">GDPR-compliant action log</div></div>' +
    '<div class="section-actions"><button class="btn btn-ghost btn-sm" id="audit-refresh-btn">Refresh</button>' +
    '<button class="btn btn-primary btn-sm" id="audit-export-btn">Export CSV</button></div></div>' +
    '<div class="card"><div class="u-flexwrap-wrap u-gap-8 table-toolbar">' +
    '<select class="u-maxw-220 input" id="audit-filter"><option value="">All users</option></select>' +
    '<select class="u-maxw-200 input" id="audit-action"><option value="">All actions</option></select>' +
    '<input class="u-maxw-180 input" id="audit-resource" placeholder="Resource prefix">' +
    '<input class="u-maxw-200 input" id="audit-q" placeholder="Search details…">' +
    '<input class="u-maxw-200 input" id="audit-since" type="datetime-local" title="Since">' +
    '<input class="u-maxw-200 input" id="audit-until" type="datetime-local" title="Until">' +
    '<button class="btn btn-ghost btn-sm" id="audit-apply">Apply</button>' +
    '<button class="btn btn-ghost btn-sm" id="audit-more" hidden>Load older</button>' +
    '<span class="u-ml-auto u-fs-11 text-muted mono" id="audit-count-label"></span></div>' +
    '<div class="u-ovx-auto"><table class="data-table" id="audit-table"><thead><tr>' +
    '<th>Timestamp</th><th>User</th><th>Action</th><th>Resource</th><th>Details</th></tr></thead>' +
    '<tbody id="audit-tbody"><tr><td colspan="5"><div class="empty">Loading…</div></td></tr></tbody></table></div></div>';

  el('audit-refresh-btn').addEventListener('click', () => { populateUsers(true).then(() => load(false)).catch((err) => P.setTableError('audit-tbody', 5, 'Could not load audit trail', err)); });
  el('audit-filter').addEventListener('change', () => load(false));
  el('audit-export-btn').addEventListener('click', exportCsv);
  el('audit-apply').addEventListener('click', () => load(false));
  el('audit-more').addEventListener('click', () => load(true));
  ['audit-resource', 'audit-q'].forEach((id) => el(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') load(false); }));
}

P.registerSection('audit', {
  mount,
  onShow() { load(false); },
});
