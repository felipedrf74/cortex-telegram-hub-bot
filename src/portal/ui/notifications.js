// Decision Center tab — notification intents, decisions, reliability and
// preferences for the selected user/tenant scope (shared with the Content tab).
const P = window.NexusPortal;

let root = null;

function el(id) { return root.querySelector('#' + id); }

function setEmptyScope() {
  el('notification-kpi-unread').textContent = '—';
  el('notification-kpi-decision').textContent = '—';
  el('notification-kpi-profiles').textContent = '—';
  el('notification-center-content').innerHTML = '<div class="empty">Select a user/tenant scope above to load Decision Center safely.</div>';
  el('notification-reliability-content').innerHTML = '<div class="empty">Notification reliability is scoped to a selected user.</div>';
  el('notification-preferences-content').innerHTML = '<div class="empty">Decision preferences are scoped to a selected user.</div>';
}

async function load() {
  const scope = P.getContentScope();
  try {
    if (!scope.userId) { setEmptyScope(); return; }
    const userId = scope.userId;
    const tenantId = scope.tenantId || scope.userId;
    const query = '?tenantId=' + encodeURIComponent(tenantId);
    const [summary, center, prefs, reliabilityResponse] = await Promise.all([
      P.apiJson('/api/users/' + encodeURIComponent(userId) + '/decision-center/summary' + query),
      P.apiJson('/api/users/' + encodeURIComponent(userId) + '/decision-center/decisions' + query + '&limit=100&status=all'),
      P.apiJson('/api/users/' + encodeURIComponent(userId) + '/decision-center/preferences' + query),
      P.apiJson('/api/users/' + encodeURIComponent(userId) + '/decision-center/notification-reliability' + query),
    ]);
    const items = center.items || [];
    const openCount = (summary.summary && summary.summary.openCount != null) ? summary.summary.openCount : items.filter((i) => ['unread', 'read', 'failed', 'snoozed'].includes(i.status)).length;
    const needsDecision = items.filter((i) => ['decision_required', 'conflict_detected', 'approval_required', 'reflow_suggestion'].includes(i.type)).length;
    const decisionPrefs = (prefs.preferences && prefs.preferences.decisionPreferences) || {};
    const profile = (prefs.preferences && prefs.preferences.profile) || {};

    el('notification-kpi-unread').textContent = P.fmtNum(openCount);
    el('notification-kpi-decision').textContent = P.fmtNum(needsDecision);
    el('notification-kpi-profiles').textContent = profile.pushEnabled ? 'push on' : 'push off';
    const navBadge = document.getElementById('nav-notifications-badge');
    if (navBadge) navBadge.textContent = openCount ? String(openCount) : '';

    const grouped = {
      all: items,
      decision: items.filter((i) => ['decision_required', 'reflow_suggestion'].includes(i.type)),
      conflicts: items.filter((i) => i.type === 'conflict_detected'),
      approvals: items.filter((i) => i.type === 'approval_required'),
      training: items.filter((i) => i.sourceSkill === 'training'),
      finance: items.filter((i) => i.sourceSkill === 'finance'),
      security: items.filter((i) => i.sourceSkill === 'security' || i.type === 'security_account'),
    };
    const chips = Object.entries(grouped).map(([key, rows]) =>
      '<span class="badge ' + (rows.length ? 'badge-accent' : 'badge-neutral') + '" style="margin-right:6px;margin-bottom:6px">' + P.esc(key) + ' · ' + rows.length + '</span>').join('');

    const rows = items.map((i) => '<tr>' +
      '<td><span class="badge badge-neutral">' + P.esc(i.sourceSkill || 'system') + '</span></td>' +
      '<td><div style="font-weight:600">' + P.esc(i.title) + '</div>' +
        '<div class="text-muted" style="font-size:12px;line-height:1.4">' + P.esc(i.summary || '') + '</div>' +
        (i.blockedByDecisionIds && i.blockedByDecisionIds.length ? '<div class="badge badge-warning" style="margin-top:6px">blocked by ' + i.blockedByDecisionIds.length + '</div>' : '') +
      '</td>' +
      '<td><span class="badge badge-neutral">' + P.esc(i.type) + '</span></td>' +
      '<td><span class="badge ' + (i.urgency === 'urgent' ? 'badge-warning' : 'badge-neutral') + '">' + P.esc(i.urgency || 'optional') + '</span></td>' +
      '<td>' + P.esc(i.status) + '</td>' +
      '<td>' + ((i.actions || []).slice(0, 2).map((a) =>
        '<button class="btn btn-xs" style="margin-right:4px" data-op="decision-action" data-decision="' + P.esc(String(i.decisionId)) + '" data-action="' + P.esc(String(a.id)) + '">' + P.esc(a.label || a.id) + '</button>').join('') || '<span class="text-muted">—</span>') + '</td>' +
      '<td class="mono" style="font-size:11px">' + P.esc(i.createdAt || '—') + '</td>' +
    '</tr>').join('');
    el('notification-center-content').innerHTML =
      '<div style="margin-bottom:var(--space-3)">' + chips + '</div>' +
      '<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Skill</th><th>Safe preview</th><th>Type</th><th>Urgency</th><th>Status</th><th>Actions</th><th>Created</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="7"><div class="empty">No Decision Center items</div></td></tr>') + '</tbody></table></div>';

    const reliability = reliabilityResponse.dashboard || {};
    const g = (o, k) => (o && o[k] != null ? o[k] : '—');
    const reliabilityRows = [
      ['Dedupe', 'Deduped', g(reliability.dedupe, 'dedupedCount'), 'Active keys', g(reliability.dedupe, 'activeDedupeKeyCount')],
      ['Digest', 'Pending', g(reliability.digest, 'pendingCount'), 'Due', g(reliability.digest, 'dueCount')],
      ['Push', 'Sent', g(reliability.pushOutcome, 'sentCount'), 'Blocked', g(reliability.pushOutcome, 'blockedCount')],
      ['Badge', 'Expected', g(reliability.badge, 'expectedBadgeCount'), 'Drift', g(reliability.badge, 'drift')],
      ['Read state', 'Client failures', g(reliability.readState, 'clientReportedReadFailureCount'), 'Server failures', g(reliability.readState, 'serverReadFailureCount')],
      ['Quality', 'Suppressed/gated', g(reliability.quality, 'suppressedOrGatedCount'), 'Dead links', g(reliability.quality, 'deadDeeplinkCount')],
      ['Actions', 'Unsupported', g(reliability.quality, 'unsupportedActionBlockedCount'), 'Failed', g(reliability.quality, 'actionFailureCount')],
    ].map((r) => '<tr><td><span class="badge badge-neutral">' + P.esc(r[0]) + '</span></td><td>' + P.esc(r[1]) + '</td><td class="mono">' + P.esc(String(r[2])) + '</td><td>' + P.esc(r[3]) + '</td><td class="mono">' + P.esc(String(r[4])) + '</td></tr>').join('');
    const topicRows = ((reliability.quality && reliability.quality.byTopic) || []).slice(0, 20).map((row) => '<tr>' +
      '<td><span class="badge badge-neutral">' + P.esc(row.sourceSkill || 'unknown') + '</span></td>' +
      '<td>' + P.esc(row.type || '—') + '</td><td>' + P.esc(row.recipe || '—') + '</td>' +
      ['suppressedOrGatedCount', 'dedupedCount', 'supersededCount', 'unsupportedActionBlockedCount', 'actionFailedCount', 'deadDeeplinkCount'].map((k) => '<td class="mono">' + P.esc(String(row[k] != null ? row[k] : 0)) + '</td>').join('') +
    '</tr>').join('');
    el('notification-reliability-content').innerHTML =
      '<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Area</th><th>Metric</th><th>Value</th><th>Metric</th><th>Value</th></tr></thead><tbody>' + reliabilityRows + '</tbody></table></div>' +
      '<div style="overflow-x:auto;margin-top:var(--space-3)"><table class="data-table"><thead><tr><th>Skill</th><th>Type</th><th>Recipe</th><th>Gated</th><th>Deduped</th><th>Superseded</th><th>Unsupported</th><th>Failed</th><th>Dead links</th></tr></thead>' +
      '<tbody>' + (topicRows || '<tr><td colspan="9"><div class="empty">No topic reliability events</div></td></tr>') + '</tbody></table></div>' +
      '<div class="text-muted" style="margin-top:var(--space-2);font-size:12px">Generated ' + P.esc(reliability.generatedAt || '—') + '</div>';

    const onOff = (v) => (v ? 'on' : 'off');
    el('notification-preferences-content').innerHTML =
      '<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>User</th><th>Push</th><th>Urgent push</th><th>Time-sensitive</th><th>Auto-hide resolved</th><th>Digest</th><th>Updated</th></tr></thead>' +
      '<tbody><tr><td class="mono">' + P.esc(String(userId)) + '</td><td>' + onOff(decisionPrefs.pushEnabled) + '</td><td>' + onOff(decisionPrefs.urgentDecisionPushEnabled) + '</td><td>' + onOff(decisionPrefs.timeSensitiveAllowed) + '</td><td>' + onOff(decisionPrefs.autoHideResolved) + '</td><td>' + onOff(profile.digestPassiveItems) + '</td>' +
      '<td class="mono" style="font-size:11px">' + P.esc(profile.updatedAt || '—') + '</td></tr></tbody></table></div>';
  } catch (err) {
    P.setCardError('notification-center-content', 'Could not load Notification Center', err);
    P.setCardError('notification-reliability-content', 'Could not load notification reliability', err);
    P.setCardError('notification-preferences-content', 'Could not load notification preferences', err);
  }
}

async function decisionAction(decisionId, actionId) {
  const scope = P.getContentScope();
  try {
    if (!scope.userId) { P.showToast('Select a user scope before acting on a decision', false); return; }
    const tenantId = scope.tenantId || scope.userId;
    const r = await P.apiFetch('/api/users/' + encodeURIComponent(scope.userId) + '/decision-center/decisions/' + encodeURIComponent(decisionId) + '/actions?tenantId=' + encodeURIComponent(tenantId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, idempotencyKey: 'portal-' + decisionId + '-' + actionId + '-' + Date.now() }),
    });
    const d = await r.json();
    if (d.ok) { P.showToast('Decision action verified'); load(); }
    else P.showToast((d.error && d.error.message) || 'Decision action failed', false);
  } catch (_) {
    P.showToast('Decision action failed', false);
  }
}

function kpi(label, id, sub) {
  return '<div class="kpi-card"><div class="kpi-label">' + label + '</div><div class="kpi-value" id="' + id + '">—</div><div class="kpi-sub">' + sub + '</div></div>';
}
function card(title, subtitle, id, loading, extraStyle) {
  return '<div class="card"' + (extraStyle ? ' style="' + extraStyle + '"' : '') + '><div class="card-header"><div><div class="card-title">' + title + '</div><div class="card-subtitle">' + subtitle + '</div></div></div><div id="' + id + '"><div class="empty">' + loading + '</div></div></div>';
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Decision Center</h1>' +
    '<div class="section-subtitle">Secretary-orchestrated notification intents, decisions, and safe portal previews</div></div></div>' +
    '<div class="kpi-grid" style="margin-bottom:var(--space-4)">' + kpi('Unread', 'notification-kpi-unread', 'active center items') + kpi('Needs decision', 'notification-kpi-decision', 'approval or conflict') + kpi('Preferences', 'notification-kpi-profiles', 'scoped profiles') + '</div>' +
    card('Notification center', 'Portal shows privacy-safe bodies; private detail stays in the authenticated app', 'notification-center-content', 'Loading notifications…') +
    card('Notification reliability', 'Dedupe, digest, push, badge drift, and read-state telemetry for the selected scope', 'notification-reliability-content', 'Loading reliability…', 'margin-top:var(--space-4)') +
    card('Notification preferences', 'Channel and digest settings by scoped user profile', 'notification-preferences-content', 'Loading preferences…', 'margin-top:var(--space-4)');
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op="decision-action"]');
    if (btn) decisionAction(btn.dataset.decision, btn.dataset.action);
  });
}

let refreshTimer = null;
P.registerSection('notifications', {
  mount,
  onShow() {
    load();
    if (!refreshTimer) refreshTimer = setInterval(() => { if (!document.hidden && root && root.classList.contains('active')) load(); }, 30000);
  },
});
