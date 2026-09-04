// Operate tab — queues + dead letters, runtime flags + kill switches,
// provider health history, notification delivery, and a read-only webhooks card.
const P = window.NexusPortal;

let root = null;
let deadLetterKind = 'jobs';
let providerHours = 24;
let deliveryFilters = { hours: 24, status: '' };
let flagFilter = '';
let flagsCache = null;

function el(id) { return root.querySelector('#' + id); }
function setStatus(id, text) { const node = el(id); if (node) node.textContent = text; }

function tone(status) {
  if (status === 'ok' || status === 'sent' || status === 'completed' || status === 'processed' || status === 'active') return 'success';
  if (status === 'fail' || status === 'failed' || status === 'dead_letter' || status === 'error') return 'error';
  if (status === 'pending' || status === 'processing' || status === 'skipped' || status === 'canceled') return 'warning';
  return 'neutral';
}

function fmtAge(sec) {
  if (sec == null) return '—';
  if (sec < 90) return sec + 's';
  if (sec < 5400) return Math.round(sec / 60) + 'm';
  if (sec < 172800) return Math.round(sec / 3600) + 'h';
  return Math.round(sec / 86400) + 'd';
}

function fmtValue(value) {
  if (value === null || value === undefined) return '<span class="text-muted">—</span>';
  if (typeof value === 'boolean') return '<span class="badge badge-' + (value ? 'success' : 'neutral') + '">' + (value ? 'on' : 'off') + '</span>';
  if (Array.isArray(value)) return '<span class="mono">' + P.esc(value.join(', ') || '(empty)') + '</span>';
  if (typeof value === 'object') return '<span class="mono">' + P.esc(Object.entries(value).map(([k, v]) => k + '=' + v).join(', ') || '(empty)') + '</span>';
  return '<span class="mono">' + P.esc(String(value)) + '</span>';
}

function genericTable(rows, emptyText, maxCols) {
  if (!rows || rows.length === 0) return '<div class="empty">' + P.esc(emptyText) + '</div>';
  const cols = Object.keys(rows[0]).filter((k) => k !== 'ok').slice(0, maxCols || 8);
  return '<div class="u-ovx-auto"><table class="data-table dense"><thead><tr>' +
    cols.map((c) => '<th>' + P.esc(c) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + cols.map((c) => '<td class="mono">' + P.esc(r[c] == null ? '' : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]))) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

// ── Queues ────────────────────────────────────────────────────────────────

function renderDepth(prefix, depth) {
  const s = depth.byStatus || {};
  el(prefix + '-pending').textContent = s.pending || 0;
  el(prefix + '-processing').textContent = s.processing || 0;
  el(prefix + '-dead').textContent = depth.deadLetter || 0;
  el(prefix + '-oldest').textContent = fmtAge(depth.oldestPendingAgeSec);
  el(prefix + '-failed24').textContent = depth.failedLast24h || 0;
  const types = depth.byType || [];
  el(prefix + '-types').innerHTML = types.length === 0
    ? '<div class="empty">Queue is empty</div>'
    : '<table class="data-table dense"><thead><tr><th>Type</th><th class="text-right">Pending</th><th class="text-right">Dead</th><th class="text-right">Total</th></tr></thead><tbody>' +
      types.map((t) => '<tr><td class="mono">' + P.esc(t.type) + '</td><td class="text-right">' + t.pending + '</td><td class="text-right">' + (t.deadLetter ? '<span class="badge badge-error">' + t.deadLetter + '</span>' : '0') + '</td><td class="text-right">' + t.total + '</td></tr>').join('') +
      '</tbody></table>';
}

async function loadQueues() {
  try {
    const d = await P.apiJson('/api/ops/queues');
    renderDepth('q-jobs', d.backgroundJobs || {});
    renderDepth('q-events', d.eventOutbox || {});
    setStatus('q-status', 'Updated ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('q-status', 'Queues unavailable: ' + (err && err.message ? err.message : err));
  }
  await loadDeadLetters();
}

async function loadDeadLetters() {
  const tbody = el('dl-tbody');
  try {
    const d = await P.apiJson('/api/ops/queues/dead-letter?kind=' + deadLetterKind + '&limit=100');
    const items = d.items || [];
    setStatus('dl-count', items.length + ' dead-letter ' + deadLetterKind);
    if (items.length === 0) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No dead-letter ' + deadLetterKind + '</div></td></tr>'; return; }
    tbody.innerHTML = items.map((i) =>
      '<tr><td class="mono" title="' + P.esc(i.id) + '">' + P.esc(i.id.length > 18 ? i.id.slice(0, 18) + '…' : i.id) + '</td>' +
      '<td class="mono">' + P.esc(i.type) + '</td>' +
      '<td class="mono">' + i.tenantId + (i.userId != null ? ' / u' + i.userId : '') + '</td>' +
      '<td class="text-right">' + i.attempts + (i.maxAttempts != null ? '/' + i.maxAttempts : '') + '</td>' +
      '<td class="text-muted" title="' + P.esc(i.lastError || '') + '">' + P.esc((i.lastError || '—').slice(0, 80)) + '</td>' +
      '<td class="text-muted">' + P.esc(P.relativeTime(i.failedAt || i.createdAt)) + '</td>' +
      '<td><button class="btn btn-ghost btn-sm" data-op="dl-replay" data-id="' + P.esc(i.id) + '">Replay</button> ' +
      '<button class="btn btn-ghost btn-sm" data-op="dl-cancel" data-id="' + P.esc(i.id) + '">Cancel</button></td></tr>').join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">' + P.esc('Could not load dead letters: ' + (err && err.message ? err.message : err)) + '</div></td></tr>';
  }
}

async function queueAction(id, action) {
  const kind = deadLetterKind;
  if (!window.confirm(action + ' ' + kind.slice(0, -1) + ' ' + id + '?')) return;
  const res = await P.apiFetch('/api/ops/queues/' + kind + '/' + encodeURIComponent(id) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const d = await res.json().catch(() => ({}));
  setStatus('dl-count', res.ok ? action + ' accepted for ' + id : (d.message || action + ' failed (HTTP ' + res.status + ')'));
  await loadQueues();
}

// ── Flags & kill switches ─────────────────────────────────────────────────

function renderKillSwitches(switches, error) {
  const box = el('ks-list');
  if (error) { box.innerHTML = '<div class="empty">Kill switches unavailable</div>'; return; }
  if (!switches || switches.length === 0) { box.innerHTML = '<div class="empty">No kill switches configured</div>'; return; }
  box.innerHTML = '<table class="data-table dense"><thead><tr><th>Switch</th><th>State</th><th>Reason</th><th>Updated</th><th></th></tr></thead><tbody>' +
    switches.map((s) =>
      '<tr><td class="mono">' + P.esc(s.controlKey) + '</td>' +
      '<td><span class="badge badge-' + (s.engaged ? 'error' : 'success') + '">' + (s.engaged ? 'ENGAGED (blocked)' : 'released') + '</span></td>' +
      '<td class="text-muted">' + P.esc(s.reason || '') + '</td>' +
      '<td class="text-muted">' + P.esc(P.relativeTime(s.updatedAt)) + (s.actorUserId ? ' by u' + s.actorUserId : '') + '</td>' +
      '<td><button class="btn btn-ghost btn-sm" data-op="ks-toggle" data-key="' + P.esc(s.controlKey) + '" data-engaged="' + (s.engaged ? '1' : '0') + '">' + (s.engaged ? 'Release' : 'Engage') + '</button></td></tr>').join('') +
    '</tbody></table>';
}

function renderFlags() {
  const box = el('flags-list');
  if (!flagsCache) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const needle = flagFilter.trim().toLowerCase();
  const flags = (flagsCache.flags || []).filter((f) => !needle || f.name.toLowerCase().includes(needle) || f.area.includes(needle) || f.envKeys.some((k) => k.toLowerCase().includes(needle)));
  setStatus('flags-count', flags.length + ' of ' + (flagsCache.flags || []).length + ' flags');
  if (flags.length === 0) { box.innerHTML = '<div class="empty">No flags match</div>'; return; }
  const areas = [...new Set(flags.map((f) => f.area))].sort();
  box.innerHTML = areas.map((area) =>
    '<div class="mt-4"><div class="u-tt-uppercase u-ls-04em card-subtitle">' + P.esc(area) + '</div>' +
    '<table class="data-table dense"><thead><tr><th>Flag</th><th>Value</th><th>Env keys</th><th>Semantics</th><th class="text-right">Overrides</th></tr></thead><tbody>' +
    flags.filter((f) => f.area === area).map((f) =>
      '<tr><td class="mono" title="' + P.esc(f.name) + '">' + P.esc(f.name) + (f.error ? ' <span class="badge badge-error" title="' + P.esc(f.error) + '">error</span>' : '') + '</td>' +
      '<td>' + fmtValue(f.value) + '</td>' +
      '<td class="mono text-muted">' + f.envKeys.map((k) => '<span title="' + (f.envSet && f.envSet[k] ? 'set in environment' : 'not set (default)') + '">' + (f.envSet && f.envSet[k] ? '●' : '○') + ' ' + P.esc(k) + '</span>').join('<br>') + '</td>' +
      '<td class="text-muted">' + P.esc(f.semantics) + (f.scoped ? ' · scoped' : '') + '</td>' +
      '<td class="text-right">' + (f.scopedOverrides ? '<span class="badge badge-info">' + f.scopedOverrides + '</span>' : '<span class="text-muted">0</span>') + '</td></tr>').join('') +
    '</tbody></table></div>').join('');
}

async function loadFlags() {
  try {
    flagsCache = await P.apiJson('/api/ops/flags');
    renderKillSwitches(flagsCache.killSwitches, flagsCache.killSwitchError);
    renderFlags();
  } catch (err) {
    el('flags-list').innerHTML = '<div class="empty">' + P.esc('Could not load flags: ' + (err && err.message ? err.message : err)) + '</div>';
  }
}

async function toggleKillSwitch(key, engaged) {
  const verb = engaged ? 'ENGAGE (block)' : 'release';
  const reason = window.prompt('Reason to ' + verb + ' kill switch "' + key + '" (audited):');
  if (reason === null || !reason.trim()) return;
  const res = await P.apiFetch('/api/ops/flags/kill-switches/' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engaged, reason: reason.trim() }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) window.alert(d.message || 'Kill switch update failed (HTTP ' + res.status + ')');
  await loadFlags();
}

// ── Provider health history ───────────────────────────────────────────────

function sparkline(buckets) {
  if (!buckets || buckets.length === 0) return '<span class="text-muted">no probes</span>';
  const w = 240; const h = 36; const bw = Math.max(2, w / buckets.length);
  const bars = buckets.map((b, i) => {
    const ratio = b.probes ? b.failures / b.probes : 0;
    const height = Math.max(3, Math.round(h * (ratio || 0.12)));
    const color = ratio === 0 ? 'var(--success)' : ratio < 0.5 ? 'var(--warning, #d97706)' : 'var(--error)';
    return '<rect x="' + (i * bw).toFixed(1) + '" y="' + (h - height) + '" width="' + Math.max(1, bw - 1).toFixed(1) + '" height="' + height + '" fill="' + color + '"><title>' + P.esc(b.ts) + ': ' + b.failures + '/' + b.probes + ' failed' + (b.avgLatencyMs != null ? ', avg ' + b.avgLatencyMs + 'ms' : '') + '</title></rect>';
  }).join('');
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="hourly failure ratio">' + bars + '</svg>';
}

async function loadProviders() {
  const box = el('ph-list');
  try {
    const d = await P.apiJson('/api/ops/provider-health-history?hours=' + providerHours);
    const providers = d.providers || [];
    if (providers.length === 0) { box.innerHTML = '<div class="empty">No probes in the last ' + providerHours + 'h</div>'; return; }
    box.innerHTML = '<div class="grid grid-cols-2">' + providers.map((p) =>
      '<div class="u-p-space-3-space-4 card">' +
      '<div class="card-header"><div class="card-title">' + P.esc(p.provider) + ' <span class="badge badge-' + tone(p.lastStatus) + '">' + P.esc(p.lastStatus || 'n/a') + '</span></div>' +
      '<span class="card-subtitle">' + (p.currentStreak ? p.currentStreak.count + '× ' + P.esc(p.currentStreak.status) + ' streak' : '') + '</span></div>' +
      '<div class="mt-4">' + sparkline(p.buckets) + '</div>' +
      '<div class="u-fs-12 u-mt-6 text-muted">' + p.probes + ' probes · ' + Math.round(p.failureRate * 100) + '% failed · avg ' + (p.avgLatencyMs != null ? p.avgLatencyMs + 'ms' : '—') + ' · p95 ' + (p.p95LatencyMs != null ? p.p95LatencyMs + 'ms' : '—') + '</div>' +
      (p.lastError ? '<div class="u-fs-11 u-mt-4 mono text-muted" title="' + P.esc(p.lastError) + '">last error: ' + P.esc(p.lastError.slice(0, 90)) + '</div>' : '') +
      '</div>').join('') + '</div>' + (d.truncated ? '<div class="text-muted mt-4">History truncated to the newest rows.</div>' : '');
  } catch (err) {
    box.innerHTML = '<div class="empty">' + P.esc('Could not load provider history: ' + (err && err.message ? err.message : err)) + '</div>';
  }
}

// ── Notification delivery ─────────────────────────────────────────────────

function chips(map) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) return '<span class="text-muted">—</span>';
  return entries.map(([k, v]) => '<span class="u-mr-4 badge badge-' + tone(k) + '">' + P.esc(k) + ' ' + v + '</span>').join('');
}

async function loadDelivery() {
  const tbody = el('nd-tbody');
  try {
    const params = new URLSearchParams({ hours: String(deliveryFilters.hours), limit: '100' });
    if (deliveryFilters.status) params.set('status', deliveryFilters.status);
    const d = await P.apiJson('/api/ops/notification-delivery?' + params.toString());
    const s = d.summary || {};
    el('nd-summary').innerHTML =
      '<div><span class="text-muted">Status</span> ' + chips(s.byStatus) + '</div>' +
      '<div class="mt-4"><span class="text-muted">Channel</span> ' + chips(s.byChannel) + ' <span class="text-muted">Provider</span> ' + chips(s.byProvider) + '</div>' +
      '<div class="mt-4"><span class="text-muted">Response codes</span> ' + chips(s.byResponseCode) + ' <span class="text-muted">Error codes</span> ' + chips(s.byErrorCode) + '</div>';
    setStatus('nd-count', (s.total || 0) + ' attempts in ' + deliveryFilters.hours + 'h');
    const attempts = d.attempts || [];
    if (attempts.length === 0) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No delivery attempts</div></td></tr>'; return; }
    tbody.innerHTML = attempts.map((a) =>
      '<tr><td class="text-muted">' + P.esc(P.shortDateTime(a.createdAt)) + '</td>' +
      '<td class="mono">u' + a.userId + '</td>' +
      '<td>' + P.esc(a.channel) + ' <span class="text-muted">' + P.esc(a.provider) + '</span></td>' +
      '<td><span class="badge badge-' + tone(a.status) + '">' + P.esc(a.status) + '</span></td>' +
      '<td class="mono">' + P.esc(a.providerResponseCode || '—') + '</td>' +
      '<td class="mono text-muted">' + P.esc(a.errorCode || '') + '</td>' +
      '<td class="mono text-muted" title="' + P.esc(a.notificationId || '') + '">' + P.esc((a.notificationId || a.intentId || '').slice(0, 14)) + '</td></tr>').join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">' + P.esc('Could not load deliveries: ' + (err && err.message ? err.message : err)) + '</div></td></tr>';
  }
}

// ── Webhooks (read-only) ──────────────────────────────────────────────────

async function loadWebhooks() {
  const owner = (el('wh-owner').value || '').trim();
  const suffix = owner ? '?owner_user_id=' + encodeURIComponent(owner) : '';
  const targets = [
    ['wh-stats', '/api/webhooks/stats', (d) => genericTable([d], 'No stats', 8)],
    ['wh-subs', '/api/webhooks/subscriptions', (d) => genericTable(d.subscriptions, 'No subscriptions', 7)],
    ['wh-events', '/api/webhooks/events', (d) => genericTable(d.events, 'No recent events', 7)],
  ];
  await Promise.all(targets.map(async ([id, path, render]) => {
    try {
      const res = await P.apiFetch(path + suffix);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el(id).innerHTML = '<div class="empty">' + P.esc(d.message || (d.error && d.error.message) || ('HTTP ' + res.status)) + '</div>'; return; }
      el(id).innerHTML = render(d);
    } catch (err) {
      el(id).innerHTML = '<div class="empty">' + P.esc(String(err && err.message ? err.message : err)) + '</div>';
    }
  }));
}

// ── Mount ─────────────────────────────────────────────────────────────────

function depthCard(prefix, title, subtitle) {
  return '<div class="card"><div class="card-header"><div class="card-title">' + title + '</div><span class="card-subtitle">' + subtitle + '</span></div>' +
    '<div class="u-mt-space-3 grid grid-cols-4">' +
    '<div class="kpi-card"><div class="kpi-label">Pending</div><div class="kpi-value" id="' + prefix + '-pending">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">Processing</div><div class="kpi-value" id="' + prefix + '-processing">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">Dead-letter</div><div class="kpi-value" id="' + prefix + '-dead">—</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">Oldest pending</div><div class="kpi-value" id="' + prefix + '-oldest">—</div><div class="kpi-sub">failed 24h: <span id="' + prefix + '-failed24">—</span></div></div></div>' +
    '<div class="mt-4" id="' + prefix + '-types"><div class="empty">Loading…</div></div></div>';
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Operate</h1>' +
    '<div class="section-subtitle">Queues, runtime flags and kill switches, provider health history, notification delivery, webhooks. Env flags are read-only; kill switches and dead-letter actions are audited.</div></div>' +
    '<div class="section-actions"><span class="u-fs-11 text-muted mono" id="q-status"></span> <button class="btn btn-ghost btn-sm" id="op-refresh">Refresh all</button></div></div>' +

    '<div class="grid grid-cols-2">' + depthCard('q-jobs', '📬 Background jobs', 'background_jobs') + depthCard('q-events', '📡 Event outbox', 'event_outbox') + '</div>' +

    '<div class="card mt-4"><div class="card-header"><div class="card-title">☠️ Dead letters</div>' +
    '<div class="section-actions"><select class="u-maxw-140 input" id="dl-kind"><option value="jobs">Jobs</option><option value="events">Events</option></select>' +
    '<span class="u-fs-11 text-muted mono" id="dl-count"></span></div></div>' +
    '<div class="u-ovx-auto"><table class="data-table dense"><thead><tr><th>Id</th><th>Type</th><th>Tenant / user</th><th class="text-right">Attempts</th><th>Last error</th><th>Failed</th><th></th></tr></thead>' +
    '<tbody id="dl-tbody"><tr><td colspan="7"><div class="empty">Loading…</div></td></tr></tbody></table></div></div>' +

    '<div class="card mt-4"><div class="card-header"><div class="card-title">🛑 Kill switches</div><span class="card-subtitle">DB-backed, take effect within seconds, audited</span></div><div id="ks-list"><div class="empty">Loading…</div></div></div>' +

    '<div class="card mt-4"><div class="card-header"><div class="card-title">🚩 Runtime flags</div>' +
    '<div class="section-actions"><input class="u-maxw-260 input" id="flags-filter" placeholder="Filter by name, area, env key…">' +
    '<span class="u-fs-11 text-muted mono" id="flags-count"></span></div></div>' +
    '<div class="u-fs-12 text-muted">● env key set · ○ default. Values are parsed readings; env flags change only through deployment configuration.</div>' +
    '<div id="flags-list"><div class="empty">Loading…</div></div></div>' +

    '<div class="card mt-4"><div class="card-header"><div class="card-title">🩺 Provider health history</div>' +
    '<div class="section-actions"><select class="u-maxw-120 input" id="ph-hours"><option value="24">24h</option><option value="72">72h</option><option value="168">7d</option></select></div></div>' +
    '<div id="ph-list"><div class="empty">Loading…</div></div></div>' +

    '<div class="card mt-4"><div class="card-header"><div class="card-title">📨 Notification delivery</div>' +
    '<div class="section-actions"><select class="u-maxw-110 input" id="nd-hours"><option value="24">24h</option><option value="72">72h</option><option value="168">7d</option></select>' +
    '<input class="u-maxw-180 input" id="nd-status" placeholder="status (sent, failed…)">' +
    '<button class="btn btn-ghost btn-sm" id="nd-apply">Apply</button><span class="u-fs-11 text-muted mono" id="nd-count"></span></div></div>' +
    '<div id="nd-summary" class="mt-4"></div>' +
    '<div class="u-ovx-auto mt-4"><table class="data-table dense"><thead><tr><th>When</th><th>User</th><th>Channel</th><th>Status</th><th>Code</th><th>Error</th><th>Notification</th></tr></thead>' +
    '<tbody id="nd-tbody"><tr><td colspan="7"><div class="empty">Loading…</div></td></tr></tbody></table></div></div>' +

    '<div class="card mt-4"><div class="card-header"><div class="card-title">🔗 Webhooks</div>' +
    '<div class="section-actions"><input class="u-maxw-320 input" id="wh-owner" placeholder="owner user id (required when operator scopes are set)"><button class="btn btn-ghost btn-sm" id="wh-load">Load</button></div></div>' +
    '<div class="grid grid-cols-2 mt-4"><div><div class="card-subtitle">Stats</div><div id="wh-stats"><div class="empty">Not loaded</div></div></div>' +
    '<div><div class="card-subtitle">Subscriptions</div><div id="wh-subs"><div class="empty">Not loaded</div></div></div></div>' +
    '<div class="mt-4"><div class="card-subtitle">Recent events</div><div id="wh-events"><div class="empty">Not loaded</div></div></div></div>';

  el('op-refresh').addEventListener('click', () => { loadQueues(); loadFlags(); loadProviders(); loadDelivery(); });
  el('dl-kind').addEventListener('change', (e) => { deadLetterKind = e.target.value === 'events' ? 'events' : 'jobs'; loadDeadLetters(); });
  el('flags-filter').addEventListener('input', (e) => { flagFilter = e.target.value; renderFlags(); });
  el('ph-hours').addEventListener('change', (e) => { providerHours = Number(e.target.value) || 24; loadProviders(); });
  el('nd-apply').addEventListener('click', () => {
    deliveryFilters = { hours: Number(el('nd-hours').value) || 24, status: (el('nd-status').value || '').trim() };
    loadDelivery();
  });
  el('wh-load').addEventListener('click', loadWebhooks);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op]');
    if (!btn) return;
    if (btn.dataset.op === 'dl-replay') queueAction(btn.dataset.id, 'replay');
    else if (btn.dataset.op === 'dl-cancel') queueAction(btn.dataset.id, 'cancel');
    else if (btn.dataset.op === 'ks-toggle') toggleKillSwitch(btn.dataset.key, btn.dataset.engaged !== '1');
  });
}

P.registerSection('operate', {
  mount,
  onShow() {
    loadQueues();
    loadFlags();
    loadProviders();
    loadDelivery();
  },
});
