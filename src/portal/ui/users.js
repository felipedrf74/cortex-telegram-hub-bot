// Users — directory, funnel, detail slideout (skills, budget, sessions, security)
// Extracted from legacy.js (Phase 5 section extraction). The markup stays in
// portal.html; this module owns the section's data loading and rendering and
// talks to the shell through window.NexusPortal (fetch wrapper, helpers,
// section registry, event bus: app:start / refresh / poll / snapshot).
const P = window.NexusPortal;
const { apiFetch, apiJson, esc, shortDateTime, relativeTime, fmtNum, fmtCost, showToast, adminLoadErrorMessage } = P;
const navigateTo = (section) => P.navigateTo(section);

// ════════════════════════════════════════════════════════════
// Users
// ════════════════════════════════════════════════════════════
let allUsers = [];
let usersSortKey = 'lastActive';
let usersSortDir = 'desc';

async function loadUsers() {
  try {
    const r = await apiFetch('/api/users');
    if (!r.ok) return;
    const d = await r.json();
    allUsers = d.users || [];
    renderUsers();
  } catch { /* silent */ }
  loadUserFunnel();
}

async function loadUserFunnel() {
  try {
    const r = await apiFetch('/api/users/funnel');
    if (!r.ok) return;
    const f = (await r.json()).funnel || {};
    const status = f.usersByStatus || {};
    document.getElementById('funnel-total').textContent = f.total ?? '—';
    document.getElementById('funnel-status').textContent = Object.keys(status).map(k => k + ' ' + status[k]).join(' · ') || '—';
    document.getElementById('funnel-active').textContent = (f.active7d ?? '—') + ' / ' + (f.active30d ?? '—');
    const weeks = f.signupsByWeek || [];
    document.getElementById('funnel-signups').textContent = weeks.length ? (weeks.slice(-4).reduce((a, w) => a + w.count, 0) + ' signups last 4 wk') : 'no recent signups';
    document.getElementById('funnel-device').textContent = (f.withActiveDevice ?? '—') + ' / ' + (f.withActivePushToken ?? '—');
    document.getElementById('funnel-oauth').textContent = (f.withAnyOauthProvider ?? 0) + ' with a connected provider';
    const onboarding = f.onboarding || [];
    const completed = onboarding.filter(o => o.status === 'completed').reduce((a, o) => a + o.count, 0);
    const inProgress = onboarding.filter(o => o.status === 'in_progress').reduce((a, o) => a + o.count, 0);
    document.getElementById('funnel-onboarding').textContent = completed + ' done · ' + inProgress + ' open';
    document.getElementById('funnel-invites').textContent = (f.inviteCodesRedeemed ?? 0) + ' invite codes redeemed';
  } catch { /* optional */ }
}

function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  const search = (document.getElementById('users-search').value || '').toLowerCase();
  const tierFilter = document.getElementById('users-filter-tier').value;
  const statusFilter = document.getElementById('users-filter-status').value;

  let users = allUsers.filter(u => {
    const name = (u.first_name || u.username || '').toLowerCase();
    const id = String(u.id || '');
    const handle = (u.username || '').toLowerCase();
    if (search && !name.includes(search) && !id.includes(search) && !handle.includes(search)) return false;
    if (tierFilter && u.tier !== tierFilter) return false;
    if (statusFilter && u.status !== statusFilter) return false;
    return true;
  });

  // Sort
  users.sort((a, b) => {
    const dir = usersSortDir === 'asc' ? 1 : -1;
    if (usersSortKey === 'name') {
      return ((a.first_name || a.username || '') > (b.first_name || b.username || '') ? 1 : -1) * dir;
    }
    if (usersSortKey === 'tier') return ((a.tier || '') > (b.tier || '') ? 1 : -1) * dir;
    if (usersSortKey === 'status') return ((a.status || '') > (b.status || '') ? 1 : -1) * dir;
    if (usersSortKey === 'limit') return ((a.daily_message_limit || 0) - (b.daily_message_limit || 0)) * dir;
    if (usersSortKey === 'lastActive') {
      const at = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
      const bt = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
      return (at - bt) * dir;
    }
    return 0;
  });

  document.getElementById('users-count-label').textContent = users.length + ' / ' + allUsers.length;

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No users match your filters</div></td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const name = u.first_name || u.username || ('User #' + u.id);
    const initial = (name[0] || '?').toUpperCase();
    const handle = u.username ? '@' + u.username : '';
    const tierClass = 'tier-' + (u.tier || 'free');
    const statusBadge = u.status === 'active'
      ? '<span class="badge badge-success">Active</span>'
      : u.status === 'suspended'
        ? '<span class="badge badge-error">Suspended</span>'
        : '<span class="badge badge-neutral">' + esc(u.status || '?') + '</span>';
    const limit = u.daily_message_limit === 0 ? '∞' : (u.daily_message_limit || 0) + '/day';
    const lastActive = u.last_active_at ? relativeTime(u.last_active_at) : 'Never';
    return '<tr class="row-clickable" data-user-id="' + u.id + '">' +
      '<td><div class="user-cell"><div class="avatar">' + esc(initial) + '</div><div><div class="user-name">' + esc(name) + '</div><div class="user-handle">' + esc(handle || (u.email ? u.email : 'id:' + u.id)) + '</div></div></div></td>' +
      '<td><span class="tier-badge ' + tierClass + '">' + esc(u.tier || 'free') + '</span></td>' +
      '<td>' + statusBadge + '</td>' +
      '<td class="text-right num">' + limit + '</td>' +
      '<td class="text-muted">' + lastActive + '</td>' +
      '<td class="text-right"><button class="btn btn-xs" data-action="open-user" data-user-id="' + u.id + '">Manage →</button></td>' +
      '</tr>';
  }).join('');

  // Wire row + button click
  tbody.querySelectorAll('tr.row-clickable').forEach(tr => {
    tr.addEventListener('click', e => {
      const id = tr.dataset.userId;
      const user = allUsers.find(u => String(u.id) === String(id));
      if (user) openUserSlideout(user);
    });
  });
}

document.getElementById('users-search').addEventListener('input', renderUsers);
document.getElementById('users-filter-tier').addEventListener('change', renderUsers);
document.getElementById('users-filter-status').addEventListener('change', renderUsers);
document.getElementById('users-refresh-btn').addEventListener('click', loadUsers);

document.querySelectorAll('#users-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (usersSortKey === key) usersSortDir = usersSortDir === 'asc' ? 'desc' : 'asc';
    else { usersSortKey = key; usersSortDir = 'asc'; }
    document.querySelectorAll('#users-table th.sortable').forEach(t => {
      t.classList.remove('sorted-asc', 'sorted-desc');
    });
    th.classList.add('sorted-' + usersSortDir);
    renderUsers();
  });
});

// ────────── User detail slideout ──────────
let currentSlideoutUser = null;

async function openUserSlideout(user) {
  currentSlideoutUser = user;
  document.getElementById('slideout-user-name').textContent = user.first_name || user.username || ('User #' + user.id);
  document.getElementById('slideout-user-id').textContent = '@' + (user.username || user.email || '#' + user.id);

  // Show suspend or activate
  document.getElementById('slideout-suspend-btn').hidden = !(user.status === 'active' && user.tier !== 'owner');
  document.getElementById('slideout-activate-btn').hidden = user.status === 'active';

  document.getElementById('user-slideout').classList.add('open');
  document.getElementById('user-slideout-backdrop').classList.add('open');

  // Load skills + data summary in parallel
  const body = document.getElementById('slideout-body');
  body.innerHTML = '<div class="empty">Loading…</div>';

  try {
    const [skillsRes, summaryRes, pointsRes, budgetRes, sessionsRes, lockoutRes, integrationsRes] = await Promise.all([
      apiFetch('/api/users/' + user.id + '/skills'),
      apiFetch('/api/users/' + user.id + '/data-summary'),
      apiFetch('/api/billing/nexus-points/packages').catch(() => null),
      apiFetch('/api/users/' + user.id + '/ai-budget').catch(() => null),
      apiFetch('/api/users/' + user.id + '/sessions').catch(() => null),
      apiFetch('/api/users/' + user.id + '/lockout').catch(() => null),
      apiFetch('/api/users/' + user.id + '/integrations').catch(() => null),
    ]);
    const sessions = sessionsRes && sessionsRes.ok ? await sessionsRes.json() : { devices: [], pushTokens: [] };
    const lockout = lockoutRes && lockoutRes.ok ? await lockoutRes.json() : null;
    const integrations = integrationsRes && integrationsRes.ok ? await integrationsRes.json() : null;
    const lifecyclePanel = renderUserLifecyclePanel(user, sessions, lockout, integrations);
    const skillsData = skillsRes.ok ? await skillsRes.json() : { skills: [] };
    const summary = summaryRes.ok ? await summaryRes.json() : {};
    const pointsData = pointsRes && pointsRes.ok ? await pointsRes.json() : { packages: [], stripeEnabled: false };
    const budgetData = budgetRes && budgetRes.ok ? await budgetRes.json() : null;

    const tier = '<span class="tier-badge tier-' + esc(user.tier || 'free') + '">' + esc(user.tier || 'free') + '</span>';
    const limit = user.daily_message_limit === 0 ? '∞' : (user.daily_message_limit || 0) + '/day';

    const skillIcons = { secretary: '📋', triathlon: '🏋️', content: '🎬', cooking: '🍳', finance: '💰' };

    const skillsHtml = (skillsData.skills || []).map(s => {
      const icon = skillIcons[s.skill] || '⚙️';
      const oauthBadge = s.requiresOAuth
        ? (s.connected
          ? '<span class="badge badge-success">🔗 Connected</span>'
          : '<span class="badge badge-error">🔗 Not connected</span>')
        : '';
      const subRows = (s.subSkills || []).map(sub => {
        const onChange = 'data-on="change" data-act="toggleUserSkill" data-args="[' + user.id + ',&quot;' + esc(s.skill) + '&quot;,&quot;' + esc(sub.id) + '&quot;,&quot;$checked&quot;]"';
        return '<div class="sub-skill" data-opacity="' + (s.enabled ? 1 : 0.4) + '">' +
          '<label class="toggle">' +
            '<input type="checkbox" ' + (sub.enabled ? 'checked' : '') + (s.enabled ? '' : ' disabled') + ' ' + onChange + '>' +
            '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
          '</label>' +
          '<span class="toggle-label">' + esc(sub.label) + '</span>' +
        '</div>';
      }).join('');
      const masterChange = 'data-on="change" data-act="toggleUserSkill" data-args="[' + user.id + ',&quot;' + esc(s.skill) + '&quot;,null,&quot;$checked&quot;]"';
      return '<div class="skill-card">' +
        '<div class="skill-header">' +
          '<span class="skill-icon">' + icon + '</span>' +
          '<span class="skill-name">' + esc(s.label) + '</span>' +
          '<label class="toggle">' +
            '<input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' ' + masterChange + '>' +
            '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
          '</label>' +
        '</div>' +
        (oauthBadge ? '<div class="u-mb-8">' + oauthBadge + '</div>' : '') +
        subRows +
      '</div>';
    }).join('');

    const dataRows = [
      ['Conversations', summary.conversations],
      ['To-dos', summary.todos],
      ['Reminders', summary.reminders],
      ['Notes', summary.notes],
      ['Saved ideas', summary.savedIdeas],
      ['Finance txns', summary.financeTransactions],
    ].map(([k, v]) => '<div class="u-p-6-0 u-bb-1-solid-border flex-between">' +
      '<span class="u-fs-12 text-muted">' + k + '</span>' +
      '<span class="u-fs-12 mono">' + (v ?? 0) + '</span>' +
    '</div>').join('');
    const pointOptions = (pointsData.packages || []).map(pkg =>
      '<option value="' + esc(pkg.productId) + '">' +
        '$' + Number(pkg.priceUsd || 0).toFixed(2) + ' · ' + Number(pkg.points || 0).toLocaleString() + ' NP' +
      '</option>'
    ).join('');
    const budget = budgetData || {};
    const budgetEntitlement = budget.entitlement || {};
    const effectiveBudget = budget.effective || {};
    const budgetUsage = budget.usage || {};
    const budgetOverride = budget.override || {};
    const budgetResets = budget.resets || {};
    const pointsCheckoutEnabled = Boolean(pointsData.stripeEnabled && budgetEntitlement.nexusPointsAllowed);
    const budgetPct = value => Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)));
    const budgetRow = (label, used, cap, fraction, resetAt) =>
      '<div class="u-p-7-0 u-bb-1-solid-border">' +
        '<div class="flex-between"><span class="u-fs-12 text-muted">' + esc(label) + '</span>' +
        '<span class="u-fs-11 mono">$' + Number(used || 0).toFixed(4) + ' / $' + Number(cap || 0).toFixed(2) + '</span></div>' +
        '<div class="u-m-5-0-3 progress"><div class="progress-fill" data-w="' + budgetPct(fraction) + '"></div></div>' +
        '<div class="u-fs-10 text-muted">' + budgetPct(fraction) + '% · resets ' + esc(resetAt || '—') + '</div>' +
      '</div>';
    const deferrals = (budget.recentDeferrals || []).slice(0, 5).map(item =>
      '<div class="u-p-5-0 u-bb-1-solid-border flex-between">' +
        '<span class="u-fs-11">' + esc(item.jobName || item.baseCategory || item.requestSource || 'AI work') + '</span>' +
        '<span class="badge badge-neutral" title="' + esc(item.createdAt || '') + '">' + esc(item.code || 'deferred') + '</span>' +
      '</div>'
    ).join('') || '<div class="u-fs-11 text-muted">No recorded deferrals.</div>';
    const budgetPanel = '<div class="u-mb-space-3 card-title">AI budget and entitlement</div>' +
      '<div class="u-d-flex u-gap-6 u-flexwrap-wrap u-mb-8">' +
        '<span class="badge badge-neutral">Effective plan: ' + esc(budgetEntitlement.plan || 'free') + '</span>' +
        '<span class="badge badge-' + (budgetEntitlement.aiAccessAllowed ? 'success' : 'error') + '">' +
          (budgetEntitlement.aiAccessAllowed ? 'Interactive AI enabled' : 'AI blocked') + '</span>' +
        '<span class="badge badge-' + (budgetEntitlement.automationAllowed ? 'success' : 'neutral') + '">' +
          (budgetEntitlement.automationAllowed ? 'Automations enabled' : 'Automations disabled') + '</span>' +
        '<span class="badge badge-neutral">' + esc(budgetEntitlement.source || 'unknown') + ':' + esc(budgetEntitlement.status || 'none') + '</span>' +
      '</div>' +
      (budgetEntitlement.blockReason ? '<div class="u-fs-11 u-mb-8 text-muted">Block reason: <code>' + esc(budgetEntitlement.blockReason) + '</code></div>' : '') +
      budgetRow('Daily included', budgetUsage.dailyCostUsd, effectiveBudget.dailyCostUsd, budgetUsage.dailyFraction, budgetResets.dailyAt) +
      budgetRow('Monthly included', budgetUsage.monthlyCostUsd, effectiveBudget.monthlyCostUsd, budgetUsage.monthlyFraction, budgetResets.monthlyAt) +
      budgetRow('Automation · daily', budgetUsage.automationDailyCostUsd, effectiveBudget.automationDailyCostUsd, budgetUsage.automationDailyFraction, budgetResets.dailyAt) +
      budgetRow('Automation · monthly', budgetUsage.automationMonthlyCostUsd, effectiveBudget.automationMonthlyCostUsd, budgetUsage.automationMonthlyFraction, budgetResets.monthlyAt) +
      '<div class="u-d-grid u-cols-1fr-1fr u-gap-8 u-m-10-0-8">' +
        '<label class="u-fs-11 text-muted">Daily override USD<input id="slideout-ai-daily" class="input" type="number" min="0" step="0.001" value="' + esc(budgetOverride.dailyCostUsd ?? '') + '" placeholder="Plan default"></label>' +
        '<label class="u-fs-11 text-muted">Monthly override USD<input id="slideout-ai-monthly" class="input" type="number" min="0" step="0.01" value="' + esc(budgetOverride.monthlyCostUsd ?? '') + '" placeholder="Plan default"></label>' +
      '</div>' +
      '<input id="slideout-ai-reason" class="u-mb-8 input" maxlength="280" value="' + esc(budgetOverride.reason || '') + '" placeholder="Audit reason">' +
      '<button class="u-w-100p u-mb-10 btn btn-sm" data-act="saveUserAiBudget" data-args="[' + user.id + ']">Save AI overrides</button>' +
      '<div class="u-fs-11 u-mb-4 card-subtitle">Recent skip reasons</div>' + deferrals +
      '<div class="u-mb-space-5"></div>';
    const pointsPanel = '<div class="u-mb-space-3 card-title">Nexus Points checkout</div>' +
      '<div class="u-d-grid u-gap-space-2 u-mb-space-5">' +
        '<select id="slideout-points-package" class="input" ' + (pointsCheckoutEnabled ? '' : 'disabled') + '>' + pointOptions + '</select>' +
        '<textarea id="slideout-points-note" class="input" rows="2" maxlength="280" placeholder="Required support note" ' + (pointsCheckoutEnabled ? '' : 'disabled') + '></textarea>' +
        '<button class="btn btn-sm" data-act="createPortalNexusPointsCheckout" data-args="[' + user.id + ']" ' + (pointsCheckoutEnabled ? '' : 'disabled') + '>Create Stripe checkout URL</button>' +
        '<div id="slideout-points-result" class="u-fs-12 text-muted">' +
          (!budgetEntitlement.nexusPointsAllowed ? 'Available only for active paid/founder entitlements.' : '') + '</div>' +
      '</div>';

    body.innerHTML =
      '<div class="u-d-flex u-gap-space-3 u-mb-space-5">' +
        tier +
        '<span class="badge badge-' + (user.status === 'active' ? 'success' : 'error') + '">' + esc(user.status) + '</span>' +
        '<span class="badge badge-neutral mono">' + limit + '</span>' +
      '</div>' +
      '<div class="u-mb-space-3 card-title">Skill Access</div>' +
      '<div class="u-gap-space-3 u-mb-space-5 grid">' + skillsHtml + '</div>' +
      '<div class="u-mb-space-3 card-title">Data Summary</div>' +
      '<div class="u-mb-space-4">' + dataRows + '</div>' +
      budgetPanel +
      pointsPanel +
      lifecyclePanel +
      '<button class="u-w-100p btn btn-sm" data-act="openCookingManagerForUser" data-args="[' + user.id + ']">Open Cooking setup →</button>';
  } catch (err) {
    body.innerHTML = '<div class="empty">Failed to load user details</div>';
  }
}

function renderUserLifecyclePanel(user, sessions, lockout, integrations) {
  const devices = (sessions.devices || []).map(d =>
    '<div class="u-d-flex u-jc-space-between u-ai-center u-gap-8 u-p-4-0 u-bb-1-solid-border">' +
      '<div><div>' + esc(d.deviceName || 'Unnamed device') + '</div>' +
      '<div class="u-fs-10 text-muted mono">' + esc(d.deviceId).slice(0, 18) + ' · active ' + (d.lastActiveAt ? relativeTime(d.lastActiveAt) : '—') + (d.hasRefreshToken ? '' : ' · no refresh token') + '</div></div>' +
      '<button class="btn btn-ghost btn-sm" data-act="revokeUserSession" data-args="[' + user.id + ',&quot;' + esc(d.deviceId) + '&quot;]">Sign out</button></div>').join('') || '<div class="text-muted">No signed-in devices</div>';
  const tokens = (sessions.pushTokens || []).filter(t => !t.revokedAt).map(t =>
    '<div class="u-d-flex u-jc-space-between u-ai-center u-gap-8 u-p-4-0">' +
      '<span class="u-fs-11 mono text-muted">…' + esc(t.tokenSuffix) + ' · ' + esc(t.environment) + (t.appVersion ? ' · v' + esc(t.appVersion) : '') + ' · seen ' + relativeTime(t.lastSeenAt) + '</span>' +
      '<button class="btn btn-ghost btn-sm" data-act="revokeUserPushToken" data-args="[' + user.id + ',&quot;' + esc(t.tokenId) + '&quot;]">Revoke</button></div>').join('') || '<div class="text-muted">No active push tokens</div>';
  const lockHtml = !lockout
    ? '<span class="text-muted">unavailable</span>'
    : lockout.state === 'locked'
      ? '<span class="badge badge-error">locked until ' + esc(shortDateTime(lockout.lockedUntil)) + '</span> <span class="text-muted">' + lockout.attemptsInWindow + ' failed attempts</span> <button class="btn btn-ghost btn-sm" data-act="clearUserLockout" data-args="[' + user.id + ']">Clear lockout</button>'
      : '<span class="badge badge-success">unlocked</span> <span class="text-muted">' + (lockout.attemptsInWindow || 0) + ' failed attempts in window</span>' + (lockout.row ? ' <button class="btn btn-ghost btn-sm" data-act="clearUserLockout" data-args="[' + user.id + ']">Reset counter</button>' : '');
  const providers = integrations && integrations.summary ? (integrations.summary.providers || []) : [];
  const connMap = {};
  (integrations && integrations.connections || []).forEach(c => { connMap[c.provider] = c; });
  const providersHtml = providers.length
    ? providers.map(p => {
        const tone = p.state === 'connected' ? 'success' : p.state === 'degraded' || p.state === 'pending' ? 'warning' : p.state === 'revoked' ? 'error' : 'neutral';
        const c = connMap[p.provider];
        return '<span class="badge badge-' + tone + '" title="' + esc(c && c.expiresAt ? 'expires ' + c.expiresAt : (p.reasonCode || '')) + '">' + esc(p.provider) + ' · ' + esc(p.state) + '</span>';
      }).join(' ')
    : '<span class="text-muted">unavailable</span>';
  return '<div class="u-m-space-4-0-space-3 card-title">Sessions &amp; devices</div>' +
    '<div class="u-mb-space-2">' + devices + '</div>' +
    '<div class="u-mb-space-3"><button class="btn btn-ghost btn-sm" data-act="revokeAllUserSessions" data-args="[' + user.id + ']">Sign out all devices</button></div>' +
    '<div class="u-mb-space-3 card-title">Push tokens</div><div class="u-mb-space-4">' + tokens + '</div>' +
    '<div class="u-mb-space-3 card-title">Security</div><div class="u-mb-space-4">' + lockHtml + '</div>' +
    '<div class="u-mb-space-3 card-title">Integrations</div><div class="u-d-flex u-flexwrap-wrap u-gap-6 u-mb-space-4">' + providersHtml + '</div>' +
    '<div class="u-mb-space-4"><a href="#support" class="btn btn-ghost btn-sm" data-act="openSupportForUser" data-args="[' + user.id + ']">Tickets for this user →</a></div>';
}

window.revokeUserSession = async function(userId, deviceId) {
  if (!confirm('Sign out this device? The app will need to log in again.')) return;
  const r = await apiFetch('/api/users/' + userId + '/sessions/' + encodeURIComponent(deviceId) + '/revoke', { method: 'POST' });
  if (r.ok && currentSlideoutUser) openUserSlideout(currentSlideoutUser);
};
window.revokeAllUserSessions = async function(userId) {
  if (!confirm('Sign out ALL devices for this user?')) return;
  const r = await apiFetch('/api/users/' + userId + '/sessions/revoke-all', { method: 'POST' });
  if (r.ok && currentSlideoutUser) openUserSlideout(currentSlideoutUser);
};
window.revokeUserPushToken = async function(userId, tokenId) {
  const r = await apiFetch('/api/users/' + userId + '/push-tokens/' + encodeURIComponent(tokenId) + '/revoke', { method: 'POST' });
  if (r.ok && currentSlideoutUser) openUserSlideout(currentSlideoutUser);
};
window.clearUserLockout = async function(userId) {
  const r = await apiFetch('/api/users/' + userId + '/lockout/clear', { method: 'POST' });
  if (r.ok && currentSlideoutUser) openUserSlideout(currentSlideoutUser);
};
window.openSupportForUser = function(userId) {
  closeUserSlideout();
  navigateTo('support');
  const support = window.NexusPortal.sections.support;
  if (support && support.showUser) support.showUser(userId);
};

function closeUserSlideout() {
  document.getElementById('user-slideout').classList.remove('open');
  document.getElementById('user-slideout-backdrop').classList.remove('open');
  currentSlideoutUser = null;
}
document.getElementById('slideout-close').addEventListener('click', closeUserSlideout);
document.getElementById('user-slideout-backdrop').addEventListener('click', closeUserSlideout);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeUserSlideout(); });

async function createPortalNexusPointsCheckout(userId) {
  const packageEl = document.getElementById('slideout-points-package');
  const noteEl = document.getElementById('slideout-points-note');
  const resultEl = document.getElementById('slideout-points-result');
  const packageId = packageEl && packageEl.value;
  const note = noteEl && noteEl.value ? noteEl.value.trim() : '';
  if (!packageId || !note) {
    resultEl.textContent = 'Choose a package and add a support note.';
    return;
  }
  resultEl.textContent = 'Creating checkout session…';
  try {
    const res = await apiFetch('/api/users/' + userId + '/billing/nexus-points/stripe-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId, note }),
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      throw new Error(body?.error?.message || body?.message || 'Checkout failed');
    }
    const checkoutUrl = body.checkoutUrl || body.data?.checkoutUrl;
    resultEl.innerHTML = checkoutUrl
      ? '<a href="' + esc(checkoutUrl) + '" target="_blank" rel="noopener">Open Stripe checkout</a>'
      : 'Checkout created, but no URL was returned.';
  } catch (err) {
    resultEl.textContent = err && err.message ? err.message : 'Checkout failed';
  }
}
window.createPortalNexusPointsCheckout = createPortalNexusPointsCheckout;

async function saveUserAiBudget(userId) {
  const dailyEl = document.getElementById('slideout-ai-daily');
  const monthlyEl = document.getElementById('slideout-ai-monthly');
  const reasonEl = document.getElementById('slideout-ai-reason');
  const daily = dailyEl && dailyEl.value !== '' ? Number(dailyEl.value) : null;
  const monthly = monthlyEl && monthlyEl.value !== '' ? Number(monthlyEl.value) : null;
  if ((daily !== null && (!Number.isFinite(daily) || daily < 0)) ||
      (monthly !== null && (!Number.isFinite(monthly) || monthly < 0))) {
    showToast('AI overrides must be non-negative numbers', false);
    return;
  }
  const response = await apiFetch('/api/users/' + userId + '/limits', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      daily_ai_cost_limit_usd: daily,
      monthly_ai_cost_limit_usd: monthly,
      daily_ai_cost_limit_reason: reasonEl && reasonEl.value ? reasonEl.value.trim() : null,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showToast(body.message || 'Failed to save AI overrides', false);
    return;
  }
  showToast(daily === null && monthly === null ? 'AI overrides cleared' : 'AI overrides saved');
  if (currentSlideoutUser) openUserSlideout(currentSlideoutUser);
}
window.saveUserAiBudget = saveUserAiBudget;

document.getElementById('slideout-suspend-btn').addEventListener('click', async () => {
  if (!currentSlideoutUser) return;
  await apiFetch('/api/users/' + currentSlideoutUser.id + '/suspend', { method: 'POST' });
  showToast('User suspended');
  closeUserSlideout();
  loadUsers();
});
document.getElementById('slideout-activate-btn').addEventListener('click', async () => {
  if (!currentSlideoutUser) return;
  await apiFetch('/api/users/' + currentSlideoutUser.id + '/activate', { method: 'POST' });
  showToast('User activated');
  closeUserSlideout();
  loadUsers();
});
document.getElementById('slideout-reset-btn').addEventListener('click', async () => {
  if (!currentSlideoutUser) return;
  await apiFetch('/api/users/' + currentSlideoutUser.id + '/skills/reset', { method: 'POST' });
  showToast('Skills reset to defaults');
  openUserSlideout(currentSlideoutUser);
});

window.toggleUserSkill = async function(userId, skill, subSkill, enabled) {
  await apiFetch('/api/users/' + userId + '/skills', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill, subSkill, enabled }),
  });
  showToast(skill + (subSkill ? ':' + subSkill : '') + (enabled ? ' enabled' : ' disabled'));
};

let usersTimer = null;
P.on('app:start', () => {
  if (!usersTimer) usersTimer = setInterval(() => { if (!document.hidden && P.getCurrentSection() === 'users') loadUsers(); }, 30000);
});

P.registerSection('users', {
  mount() {},
  onShow() { loadUsers(); },
});
