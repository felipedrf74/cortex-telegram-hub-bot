// Jobs — scheduled runs, job control, quick actions
// Extracted from legacy.js (Phase 5 section extraction). The markup stays in
// portal.html; this module owns the section's data loading and rendering and
// talks to the shell through window.NexusPortal (fetch wrapper, helpers,
// section registry, event bus: app:start / refresh / poll / snapshot).
const P = window.NexusPortal;
const { apiFetch, apiJson, esc, shortDateTime, relativeTime, fmtNum, fmtCost, showToast, adminLoadErrorMessage } = P;
const navigateTo = (section) => P.navigateTo(section);

function renderNextRuns(nextRuns) {
  const tbody = document.querySelector('#next-runs-table tbody');
  if (!nextRuns || nextRuns.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty">No upcoming jobs</div></td></tr>';
    return;
  }
  tbody.innerHTML = nextRuns.slice(0, 12).map(r => '<tr>' +
    '<td>' + esc(r.label) + '</td>' +
    '<td><code class="u-fs-10 mono">' + esc(r.cronExpression) + '</code></td>' +
    '<td><span class="domain-tag domain-' + esc(r.domain) + '">' + esc(r.domain) + '</span></td>' +
    '<td class="mono">' + esc(r.humanDelta) + '</td>' +
    '</tr>').join('');
}

function renderJobsList(jobs, history) {
  const el = document.getElementById('jobs-list-content');
  if (!jobs || jobs.length === 0) {
    el.innerHTML = '<div class="empty">No jobs</div>';
    return;
  }
  el.innerHTML = jobs.map(j => {
    const paused = j.lifecycle === 'paused';
    const result = paused ? 'paused' : (j.lastResult || 'never');
    const cls = result === 'success' ? 'success' : result === 'failed' ? 'error' : result === 'running' ? 'info' : 'neutral';
    const dur = j.lastDurationMs != null ? Math.round(j.lastDurationMs / 1000) + 's' : '—';
    const last = paused ? 'Paused' : (j.lastRunAt ? relativeTime(j.lastRunAt) : 'Never');
    return '<div class="job-row">' +
      '<div class="job-name"><span class="domain-tag domain-' + esc(j.domain || 'system') + '">' + esc(j.domain || 'sys') + '</span>' + esc(j.label || j.name) + '</div>' +
      '<div class="job-cron">' + esc(j.cronExpression || '—') + '</div>' +
      '<div class="job-meta">' + last + '</div>' +
      '<div class="job-meta">' + dur + '</div>' +
      '<span class="badge badge-' + cls + '">' + result + '</span>' +
      '</div>';
  }).join('');
}

// ── Job control: /api/jobs — governance, next run, manual run, history ──
let jobCtlJobs = [];
let jobCtlFilter = '';
async function loadJobControl() {
  const el = document.getElementById('jobctl-content');
  if (!el) return;
  try {
    const d = await apiJson('/api/jobs');
    jobCtlJobs = d.jobs || [];
    renderJobControl();
  } catch (err) {
    el.innerHTML = '<div class="empty">' + esc('Could not load job control: ' + adminLoadErrorMessage(err)) + '</div>';
  }
}
function renderJobControl() {
  const el = document.getElementById('jobctl-content');
  if (!el) return;
  const needle = jobCtlFilter.trim().toLowerCase();
  const jobs = jobCtlJobs.filter(j => !needle || j.name.toLowerCase().includes(needle) || (j.label || '').toLowerCase().includes(needle) || (j.domain || '').includes(needle));
  if (jobs.length === 0) { el.innerHTML = '<div class="empty">No jobs match</div>'; return; }
  el.innerHTML = '<div class="u-ovx-auto"><table class="data-table dense"><thead><tr><th>Job</th><th>Cron</th><th>Next run</th><th>Last</th><th class="text-right">24h</th><th>Governance</th><th></th></tr></thead><tbody>' +
    jobs.map(j => {
      const paused = j.lifecycle === 'paused';
      const state = j.running ? 'running' : paused ? 'paused' : !j.enabled ? 'disabled' : (j.lastResult || 'never');
      const cls = state === 'success' ? 'success' : state === 'failed' ? 'error' : state === 'running' ? 'info' : state === 'paused' || state === 'disabled' ? 'warning' : 'neutral';
      const denied = j.manual.policy === 'deny';
      const disabled = denied || j.running || !j.runnerAvailable || j.cooldownRemainingMs > 0;
      const title = denied ? (j.manual.reason || 'manual run denied') : j.running ? 'already running' : !j.runnerAvailable ? 'runner unavailable in this process' : j.cooldownRemainingMs > 0 ? 'cooldown active' : j.manual.policy === 'confirm' ? 'asks for confirmation: ' + j.manual.reason : 'run now';
      const gov = j.governance ? '<span class="text-muted">' + esc(j.governance.policyOwner) + '</span> · <span class="mono" title="provider usage">' + esc(j.governance.providerUsage === 'none' ? 'no provider' : 'provider-capable') + '</span>' : '<span class="text-muted">not in manifest</span>';
      return '<tr>' +
        '<td><span class="domain-tag domain-' + esc(j.domain || 'system') + '">' + esc(j.domain || 'sys') + '</span> ' + esc(j.label || j.name) + '<div class="u-fs-11 mono text-muted">' + esc(j.name) + '</div></td>' +
        '<td class="mono">' + esc(j.cronExpression || '—') + '</td>' +
        '<td class="text-muted">' + (j.nextRunAt ? esc(relativeTime(j.nextRunAt)) : '—') + '</td>' +
        '<td><span class="badge badge-' + cls + '">' + esc(state) + '</span> <span class="text-muted">' + (j.lastRunAt ? esc(relativeTime(j.lastRunAt)) : '') + '</span>' + (j.lastError ? '<div class="u-fs-11 mono text-muted" title="' + esc(j.lastError) + '">' + esc(String(j.lastError).slice(0, 60)) + '</div>' : '') + '</td>' +
        '<td class="text-right mono">' + j.stats24h.runs + (j.stats24h.failed ? ' <span class="badge badge-error">' + j.stats24h.failed + ' failed</span>' : '') + '</td>' +
        '<td>' + gov + '</td>' +
        '<td class="u-ws-nowrap"><button class="btn btn-ghost btn-sm" data-jobctl="run" data-job="' + esc(j.name) + '" title="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>' + (j.manual.policy === 'confirm' ? 'Run…' : 'Run') + '</button> ' +
        '<button class="btn btn-ghost btn-sm" data-jobctl="history" data-job="' + esc(j.name) + '">History</button></td></tr>';
    }).join('') + '</tbody></table></div>';
}
async function runJobNow(name) {
  const job = jobCtlJobs.find(j => j.name === name);
  if (!job) return;
  let body = {};
  if (job.manual.policy === 'confirm') {
    if (!confirm('"' + (job.label || job.name) + '" ' + (job.manual.reason || 'may spend provider budget') + '. Run it now?')) return;
    body = { confirm: true };
  }
  try {
    const res = await apiFetch('/api/jobs/' + encodeURIComponent(name) + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    showToast(res.ok ? 'Started ' + (job.label || job.name) : (d.message || 'Run failed (HTTP ' + res.status + ')'), res.ok);
  } catch (err) {
    showToast('Run failed: ' + adminLoadErrorMessage(err), false);
  }
  setTimeout(loadJobControl, 1500);
}
async function showJobHistory(name) {
  const box = document.getElementById('jobctl-history');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div class="empty">Loading history for ' + esc(name) + '…</div>';
  try {
    const d = await apiJson('/api/jobs/' + encodeURIComponent(name) + '/history' + '?limit=50');
    const rows = d.history || [];
    box.innerHTML = '<div class="card-header"><div class="card-title">History · ' + esc(name) + '</div><button class="btn btn-ghost btn-sm" id="jobctl-history-close">Close</button></div>' +
      (rows.length === 0 ? '<div class="empty">No runs recorded</div>' :
      '<table class="data-table dense"><thead><tr><th>When</th><th>Result</th><th class="text-right">Duration</th><th>Error</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td class="text-muted">' + esc(shortDateTime(r.ts)) + '</td><td><span class="badge badge-' + (r.result === 'success' ? 'success' : 'error') + '">' + esc(r.result) + '</span></td><td class="text-right mono">' + (r.durationMs != null ? (r.durationMs / 1000).toFixed(1) + 's' : '—') + '</td><td class="mono text-muted" title="' + esc(r.errorMessage || '') + '">' + esc((r.errorMessage || '').slice(0, 120)) + '</td></tr>').join('') +
      '</tbody></table>');
    const close = document.getElementById('jobctl-history-close');
    if (close) close.addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
  } catch (err) {
    box.innerHTML = '<div class="empty">' + esc('Could not load history: ' + adminLoadErrorMessage(err)) + '</div>';
  }
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-jobctl]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.jobctl === 'run') runJobNow(btn.dataset.job);
  else if (btn.dataset.jobctl === 'history') showJobHistory(btn.dataset.job);
});
const jobCtlRefresh = document.getElementById('jobctl-refresh');
if (jobCtlRefresh) jobCtlRefresh.addEventListener('click', loadJobControl);
const jobCtlFilterInput = document.getElementById('jobctl-filter');
if (jobCtlFilterInput) jobCtlFilterInput.addEventListener('input', (e) => { jobCtlFilter = e.target.value; renderJobControl(); });

// ═══════════════════════════════════════════════════════════
// Quick actions (Jobs section)
// ════════════════════════════════════════════════════════════
const QUICK_ACTIONS = [
  { name: 'refresh-garmin', label: '🔁 Refresh Garmin', icon: '🔁' },
  { name: 'trigger-briefing', label: '📅 Trigger briefing', icon: '📅' },
  { name: 'clear-history', label: '🧹 Clear history', icon: '🧹' },
  { name: 'test-invoice-storage', label: '🧾 Test invoice storage', icon: '🧾' },
  { name: 'test-graph', label: '📡 Test Graph', icon: '📡' },
  { name: 'resynthesize-knowledge', label: '🧠 Re-synth knowledge', icon: '🧠' },
  { name: 'run-voice-evolution', label: '🎙️ Run voice evolution', icon: '🎙️' },
  { name: 'run-pipeline-agent', label: '🚀 Run pipeline agent', icon: '🚀' },
];
function loadQuickActions() {
  const el = document.getElementById('quick-actions-content');
  el.innerHTML = QUICK_ACTIONS.map(a =>
    '<button class="btn btn-sm" data-act="doAction" data-args="[&quot;' + a.name + '&quot;]">' + esc(a.label) + '</button>'
  ).join('');
}
window.doAction = async function(name) {
  showToast('Running ' + name + '…', 'info');
  try {
    const r = await apiFetch('/api/action/' + name, { method: 'POST' });
    const d = await r.json();
    showToast(d.message || (d.ok ? 'Done' : 'Failed'), d.ok !== false);
    P.emit('refresh');
  } catch { showToast('Action failed', false); }
};

P.on('snapshot', (snap) => {
  renderNextRuns(snap.nextRuns || []);
  renderJobsList(snap.jobs || [], snap.jobHistory || {});
});

P.registerSection('jobs', {
  mount() {},
  onShow() { loadJobControl(); loadQuickActions(); },
});
