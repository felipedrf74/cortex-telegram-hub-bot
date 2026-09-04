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
import { sseSubscribe } from './sse.js';

const P = window.NexusPortal;

async function refreshSupportBadge() {
  try {
    const res = await P.apiFetch('/api/support/summary');
    if (!res.ok) return;
    const data = await res.json();
    const fresh = (data.byStatus && data.byStatus.new) || 0;
    const badge = document.getElementById('nav-support-count');
    if (badge) badge.textContent = fresh > 0 ? String(fresh) : '';
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
      return;
    }
    alertsStreamStop = null;
    if (!alertsPollTimer) alertsPollTimer = setInterval(refreshIssueBadge, 60000);
    // Reconnect lazily; the poll keeps badges roughly fresh meanwhile.
    setTimeout(startAlertsStream, 30000);
  });
}

P.onAppStart = () => {
  refreshIssueBadge();
  refreshSupportBadge();
  setInterval(refreshSupportBadge, 60000);
  startAlertsStream();
};
P.refreshSupportBadge = refreshSupportBadge;
P.refreshIssueBadge = refreshIssueBadge;
