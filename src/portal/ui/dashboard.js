// Dashboard — KPIs, provider status, integrations, activity, release card
// Extracted from legacy.js (Phase 5 section extraction). The markup stays in
// portal.html; this module owns the section's data loading and rendering and
// talks to the shell through window.NexusPortal (fetch wrapper, helpers,
// section registry, event bus: app:start / refresh / poll / snapshot).
const P = window.NexusPortal;
const { apiFetch, apiJson, esc, shortDateTime, relativeTime, fmtNum, fmtCost, showToast, adminLoadErrorMessage } = P;
const navigateTo = (section) => P.navigateTo(section);

// ════════════════════════════════════════════════════════════
// Sparkline renderer
// ════════════════════════════════════════════════════════════
function renderSparkline(svg, values, opts = {}) {
  if (!svg || !values || values.length === 0) return;
  const w = 80, h = 28;
  const max = Math.max(...values, 0.01);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = w / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const areaPath = linePath + ' L ' + w + ' ' + h + ' L 0 ' + h + ' Z';
  svg.innerHTML = '<path class="area" d="' + areaPath + '"/><path d="' + linePath + '"/>';
}

// ════════════════════════════════════════════════════════════
// Dashboard: KPIs + provider status + integrations + activity
// ════════════════════════════════════════════════════════════
let lastSnapshot = null;

async function pollSnapshot() {
  try {
    const r = await apiFetch('/api/snapshot');
    if (!r.ok) return;
    const snap = await r.json();
    lastSnapshot = snap;
    renderSnapshot(snap);
  } catch (err) {
    console.warn('[portal] dashboard snapshot poll failed', err);
  }
}

async function pollUsageSummary() {
  try {
    const r = await apiFetch('/api/usage/summary');
    if (!r.ok) return;
    const d = await r.json();
    renderUsageSummary(d);
  } catch (err) {
    console.warn('[portal] dashboard usage summary failed', err);
  }
}

function renderSnapshot(snap) {
  // Other sections render from this same payload; the fan-out must survive a
  // dashboard paint failure (one missing element must not starve the rest).
  try {
    // Topbar version + uptime + cost + bot status
    const ver = snap.version || '?';
    document.getElementById('app-version').textContent = 'v' + ver;
    document.getElementById('footer-version').textContent = ver + (_releaseShortSha ? ' · ' + _releaseShortSha : '');
    document.getElementById('topbar-uptime').textContent = snap.uptime?.human || '—';
    document.getElementById('topbar-cost').textContent = fmtCost(snap.healthSummary?.apiCostToday);

    const serverStatus = snap.server?.status || 'offline';
    const botPolling = snap.bot?.polling;
    const botRestarting = snap.bot?.restarting;
    const botStatus = botPolling ? 'online' : botRestarting ? 'restarting' : 'offline';
    const dot = document.getElementById('bot-status-dot');
    const text = document.getElementById('bot-status-text');
    dot.className = 'status-dot ' + (serverStatus === 'online' ? 'online' : 'error');
    text.textContent = serverStatus === 'online' ? 'Online' : 'Offline';

    // Dashboard KPIs (uptime cell — others come from /api/usage/summary)
    document.getElementById('kpi-uptime').textContent = snap.uptime?.human || '—';
    document.getElementById('kpi-uptime-sub').textContent = 'Server: ' + serverStatus + ' · Bot: ' + botStatus;

    // Dashboard: recent activity
    renderActivity(snap.recentEvents || []);

    // Dashboard: integrations summary
    renderDashIntegrations(snap.integrations || []);
  } finally {
    P.emit('snapshot', snap);
  }
}

function renderUsageSummary(d) {
  if (!d || !d.ok) return;
  const t = d.today || {};
  const w = d.week || {};
  document.getElementById('kpi-active-users').textContent = fmtNum(t.activeUsers);
  document.getElementById('kpi-active-users-sub').textContent = 'of ' + fmtNum(d.totalUsers) + ' total';
  document.getElementById('kpi-cost-today').textContent = fmtCost(t.cost);
  document.getElementById('kpi-cost-today-sub').textContent = fmtCost(w.cost) + ' this week';
  document.getElementById('kpi-messages-today').textContent = fmtNum(t.messages);
  document.getElementById('kpi-messages-today-sub').textContent = fmtNum(t.tokens) + ' tokens';
  renderSparkline(document.getElementById('kpi-cost-sparkline'), d.sparkline || []);
  document.getElementById('nav-users-count').textContent = d.totalUsers || '';
}

function renderActivity(events) {
  const el = document.getElementById('dash-activity');
  document.getElementById('event-count').textContent = events.length ? '(' + events.length + ')' : '';
  if (events.length === 0) {
    el.innerHTML = '<div class="empty">No activity yet</div>';
    return;
  }
  const TYPE_ICONS = { message: '💬', tool_call: '🔧', error: '❌', job: '⏱', api_call: '🤖', auth: '🔑' };
  el.innerHTML = events.slice(0, 12).map(ev => {
    const icon = TYPE_ICONS[ev.type] || '•';
    const dom = ev.domain ? '<span class="domain-tag domain-' + esc(ev.domain) + '">' + esc(ev.domain) + '</span> ' : '';
    return '<div class="activity-row">' +
      '<div class="activity-icon">' + icon + '</div>' +
      '<div class="activity-body">' +
        '<div class="activity-text">' + dom + esc(ev.summary) + '</div>' +
        '<div class="activity-time">' + relativeTime(ev.ts) + '</div>' +
      '</div></div>';
  }).join('');
}

function renderDashIntegrations(integrations) {
  const el = document.getElementById('dash-integrations');
  if (integrations.length === 0) {
    el.innerHTML = '<div class="empty">No integrations</div>';
    return;
  }
  const groups = {};
  integrations.forEach(i => {
    const g = i.group || 'other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(i);
  });
  el.innerHTML = integrations.map(i => {
    const ok = i.tokenHealth === 'valid' || i.status === 'polling' || i.status === 'configured';
    const dot = ok ? 'online' : i.tokenHealth === 'warning' ? 'warning' : i.tokenHealth === 'expired' ? 'error' : 'offline';
    const sub = i.lastApiCall ? 'Last call: ' + relativeTime(i.lastApiCall) : i.status || '—';
    return '<div class="u-p-space-2-space-1 u-bb-1-solid-border flex-between">' +
      '<div class="u-ai-center flex gap-2">' +
        '<span class="status-dot ' + dot + '"></span>' +
        '<span class="u-fs-12">' + esc(i.name) + '</span>' +
      '</div>' +
      '<span class="u-fs-10 text-tertiary mono">' + esc(sub) + '</span>' +
      '</div>';
  }).join('');
}

// Operator Alerts moved to ui/alerts.js (Phase 5 section extraction).

// ── Release & environment card ──
let _releaseShortSha = null;
const BETA_SAFE_EXPOSURE_MODES = ['disabled', 'loopback_only', 'session_only', 'signed_static'];

function releaseChip(label, tone, title) {
  return '<span class="badge badge-' + tone + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(label) + '</span>';
}

function renderReleaseInfo(r) {
  document.getElementById('release-version').textContent = 'v' + (r.version || '—');
  document.getElementById('release-commit').textContent = r.gitShortSha || (r.stampPresent ? '—' : 'no build stamp');
  document.getElementById('release-branch').textContent = r.branch ? (r.branch + (r.dirty ? ' · dirty build' : '')) : '';
  document.getElementById('release-deployed').textContent = r.deployedAt ? relativeTime(r.deployedAt) : '—';
  document.getElementById('release-booted').textContent = r.bootedAt ? ('booted ' + relativeTime(r.bootedAt) + ' · pid ' + r.pid) : '';
  const mig = r.migrations || { applied: 0, available: 0, pending: [] };
  const pending = (mig.pending || []).length;
  document.getElementById('release-migrations').innerHTML = pending === 0
    ? '<span class="badge badge-success">' + mig.applied + ' applied</span>'
    : '<span class="badge badge-error">' + pending + ' pending</span>';
  document.getElementById('release-migrations-sub').textContent = pending === 0
    ? ('latest ' + (mig.latestApplied || '—'))
    : (mig.pending || []).slice(0, 3).join(', ');

  const chips = [];
  chips.push(releaseChip(r.env || 'development', 'info', 'NODE_ENV'));
  chips.push(releaseChip('node ' + (r.node || '—'), 'neutral', r.platform || ''));
  const betaSafe = BETA_SAFE_EXPOSURE_MODES.indexOf(r.adminExposureMode) !== -1;
  chips.push(releaseChip('admin: ' + (r.adminExposureMode || 'unknown'), betaSafe ? 'success' : 'warning', 'Portal admin exposure mode'));
  chips.push(releaseChip(r.betaHardened ? 'beta-hardened' : 'not beta-hardened', r.betaHardened ? 'success' : 'warning', 'PORTAL_BETA_HARDENED'));
  const integ = r.integrations || {};
  chips.push(releaseChip(integ.sentry ? 'Sentry on' : 'Sentry not configured', integ.sentry ? 'success' : 'error', 'SENTRY_DSN'));
  chips.push(releaseChip(integ.operatorAlertWebhook ? 'Alert webhook on' : 'Alert webhook not configured', integ.operatorAlertWebhook ? 'success' : 'error', 'OPERATOR_ALERT_WEBHOOK_URL'));
  chips.push(releaseChip('iOS API ' + (integ.iosApi ? 'on' : 'off'), integ.iosApi ? 'success' : 'neutral', 'IOS_API_ENABLED'));
  chips.push(releaseChip('Anthropic ' + (integ.anthropic ? 'on' : 'off'), 'neutral', 'ANTHROPIC_ENABLED'));
  chips.push(releaseChip('Ollama ' + (integ.ollama ? 'on' : 'off'), 'neutral', 'OLLAMA_ENABLED'));
  if (r.db && r.db.sizeBytes != null) {
    chips.push(releaseChip('db ' + (r.db.sizeBytes / 1024 / 1024).toFixed(1) + ' MB' + (r.db.walBytes ? ' · wal ' + (r.db.walBytes / 1024 / 1024).toFixed(1) + ' MB' : ''), 'neutral', 'SQLite file size'));
  }
  document.getElementById('release-flags').innerHTML = chips.join('');

  const problems = [];
  if (pending > 0) problems.push('pending migrations');
  if (!betaSafe) problems.push('admin exposure');
  if (!integ.sentry) problems.push('no Sentry');
  if (!integ.operatorAlertWebhook) problems.push('no alert webhook');
  document.getElementById('release-subtitle').textContent = problems.length
    ? 'Attention: ' + problems.join(', ')
    : 'Healthy · uptime ' + (r.uptimeSeconds != null ? Math.floor(r.uptimeSeconds / 3600) + 'h' : '—');

  _releaseShortSha = r.gitShortSha || null;
  const footer = document.getElementById('footer-version');
  if (footer && r.version) footer.textContent = r.version + (r.gitShortSha ? ' · ' + r.gitShortSha : '');
}

async function loadReleaseInfo() {
  try {
    const res = await apiFetch('/api/release');
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.release) renderReleaseInfo(data.release);
  } catch (e) {
    document.getElementById('release-subtitle').textContent = 'Release info unavailable';
  }
}

// ── Polling ──────────────────────────────────────────────────────────────
// Snapshot + usage every 15 s while the tab is visible; 'poll' lets other
// sections (provider health) refresh on the same cadence, and 'refresh' is the
// topbar button. Release identity changes only on deploy: once a minute.
async function pollAll() {
  pollSnapshot();
  pollUsageSummary();
  P.emit('poll');
}
let pollTimer = null;
P.on('refresh', pollAll);
let started = false;
P.on('app:start', () => {
  pollAll();
  loadReleaseInfo();
  // Timers and listeners are installed once; a repeated app:start (re-login in
  // the same tab) only refreshes.
  if (started) return;
  started = true;
  pollTimer = setInterval(() => { if (!document.hidden) pollAll(); }, 15000);
  setInterval(() => { if (!document.hidden) loadReleaseInfo(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAll(); });
});

P.registerSection('dashboard', {
  mount() {},
  onShow() { pollAll(); },
});
