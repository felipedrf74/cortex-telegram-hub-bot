// Nexus Hub admin portal — ES module entry.
//
// The inline script in portal.html exposes `window.NexusPortal` (fetch
// wrapper with auth, escaping, navigation, section registry). Modules
// register sections here; the inline router calls `activateSection()`
// when the operator opens a module-backed tab.
import './logs.js';
import './requests.js';
import './issues.js';
import './support.js';
import './operate.js';
import './audit.js';
import './invites.js';
import './founders.js';
import './waitlist.js';
import './settings.js';
import './alerts.js';
import './notifications.js';
import './cooking.js';
import './dashboard.js';
import './users.js';
import './skills.js';
import './ai.js';
import './jobs.js';
import './content.js';
import { sseSubscribe } from './sse.js';

const P = window.NexusPortal;

// Dashboard "Support & Issues" card: painted from the same summaries that feed
// the nav badges (poll or alerts stream), so the overview shows open tickets by
// priority and open issues without opening either tab.
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
function paintTriage(summary) {
  const support = summary.support;
  if (support && support.byStatus) {
    const s = support.byStatus;
    const p = support.byPriority || {};
    setText('dash-tickets-open', String((s.new || 0) + (s.open || 0) + (s.waiting_user || 0)));
    setText('dash-tickets-priority', ['p0', 'p1', 'p2', 'p3'].map((k) => k + ' ' + (p[k] || 0)).join(' · '));
    setText('dash-tickets-stale', String(support.newOlderThan48h || 0));
    setText('dash-tickets-week', (support.createdLast7d || 0) + ' created this week');
  }
  const issues = summary.issues;
  if (issues && issues.byStatus) {
    const k = issues.byKind || {};
    setText('dash-issues-open', String(issues.byStatus.open || 0));
    setText('dash-issues-kind', 'server ' + (k.server || 0) + ' · iOS ' + (k.client || 0));
    setText('dash-issues-24h', String(issues.openLast24h || 0));
    setText('dash-issues-acked', (issues.byStatus.acked || 0) + ' acknowledged');
  }
}

async function refreshSupportBadge() {
  try {
    const res = await P.apiFetch('/api/support/summary');
    if (!res.ok) return;
    const data = await res.json();
    const fresh = (data.byStatus && data.byStatus.new) || 0;
    const badge = document.getElementById('nav-support-count');
    if (badge) badge.textContent = fresh > 0 ? String(fresh) : '';
    paintTriage({ support: data });
  } catch (_) {
    // badge is best-effort
  }
}

async function refreshIssueBadge() {
  try {
    const res = await P.apiFetch('/api/ops/issues/summary');
    if (!res.ok) return;
    const data = await res.json();
    const open = (data.byStatus && data.byStatus.open) || 0;
    const badge = document.getElementById('nav-issues-count');
    if (badge) badge.textContent = open > 0 ? String(open) : '';
    paintTriage({ issues: data });
  } catch (_) {
    // badge is best-effort
  }
}

function applyAlertsPush(payload) {
  const alerts = payload.alerts || [];
  const badge = document.getElementById('nav-alerts-count');
  if (badge) badge.textContent = alerts.length > 0 ? String(alerts.length) : '';
  const issues = payload.issues;
  if (issues && issues.byStatus) {
    const open = issues.byStatus.open || 0;
    const issueBadge = document.getElementById('nav-issues-count');
    if (issueBadge) issueBadge.textContent = open > 0 ? String(open) : '';
  }
  const support = payload.support;
  if (support && support.byStatus) {
    const fresh = support.byStatus.new || 0;
    const supportBadge = document.getElementById('nav-support-count');
    if (supportBadge) supportBadge.textContent = fresh > 0 ? String(fresh) : '';
  }
  paintTriage({ support: payload.support, issues: payload.issues });
  if (typeof P.onAlertsPush === 'function') P.onAlertsPush(payload);
}

let alertsStreamStop = null;
let alertsPollTimer = null;

// Live badge counts: SSE first, polling fallback when the stream cannot open.
function startAlertsStream() {
  if (alertsStreamStop) return;
  alertsStreamStop = sseSubscribe('/api/ops/alerts/stream', (event, data) => {
    if (event === 'alerts') applyAlertsPush(data);
  }, (state) => {
    if (state === 'open') {
      if (alertsPollTimer) { clearInterval(alertsPollTimer); alertsPollTimer = null; }
      // Badge counts arrive on the stream; stop polling for them.
      if (supportPollTimer) { clearInterval(supportPollTimer); supportPollTimer = null; }
      return;
    }
    alertsStreamStop = null;
    ensureSupportPoll();
    if (!alertsPollTimer) alertsPollTimer = setInterval(() => { if (!document.hidden) refreshIssueBadge(); }, 60000);
    // Reconnect lazily; the poll keeps badges roughly fresh meanwhile.
    setTimeout(startAlertsStream, 30000);
  });
}

let supportPollTimer = null;
function ensureSupportPoll() {
  if (!supportPollTimer) supportPollTimer = setInterval(() => { if (!document.hidden) refreshSupportBadge(); }, 60000);
}
P.onAppStart = () => {
  refreshIssueBadge();
  refreshSupportBadge();
  ensureSupportPoll();
  startAlertsStream();
  // Sections that own a nav badge refresh it without being opened.
  Object.values(P.sections).forEach((section) => {
    if (typeof section.refreshBadge === 'function') section.refreshBadge();
  });
};
P.refreshSupportBadge = refreshSupportBadge;
P.refreshIssueBadge = refreshIssueBadge;

// Every section module above has registered; the shell may navigate.
P.signalModulesReady();
