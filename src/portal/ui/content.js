// Content — dashboard, scope, performance, lifecycle, books, channels, pillars, voice DNA
// Extracted from legacy.js (Phase 5 section extraction). The markup stays in
// portal.html; this module owns the section's data loading and rendering and
// talks to the shell through window.NexusPortal (fetch wrapper, helpers,
// section registry, event bus: app:start / refresh / poll / snapshot).
const P = window.NexusPortal;
const { apiFetch, apiJson, esc, shortDateTime, relativeTime, fmtNum, fmtCost, showToast, adminLoadErrorMessage } = P;
const navigateTo = (section) => P.navigateTo(section);
// Scope lives in the shell (apiFetch attaches the x-nexus-* headers); read it
// live so every panel sees the operator's current choice.
const CONTENT_SCOPE = {
  get userId() { return P.getContentScope().userId; },
  get tenantId() { return P.getContentScope().tenantId; },
};

// ════════════════════════════════════════════════════════════
// Content dashboard
// ════════════════════════════════════════════════════════════
let contentDashboardCache = null;

async function loadContentDashboard() {
  // 2026-05-04 — Refresh the scope picker UI from persisted state
  // before any data load so the operator can see the active scope for the
  // tenant-scoped panels/actions. The legacy mixed overview is intentionally
  // owner-bootstrap/platform scoped and receives no x-nexus scope headers.
  refreshContentScopeUI();
  // CONTENT-UI-O3/O4 panels are scoped, first-class surfaces. Keep them
  // independent from the legacy content-dashboard payload so a missing
  // legacy endpoint does not hide tenant-scoped evidence.
  loadContentPerformance().catch(() => {});
  loadContentCanonicalLifecycle().catch(() => {});
  try {
    const r = await apiFetch('/api/v1/admin/content-dashboard');
    if (!r.ok) {
      document.getElementById('content-commands-groups').innerHTML =
        '<div class="empty">Failed to load content dashboard (' + r.status + ')</div>';
      return;
    }
    const data = await r.json();
    contentDashboardCache = data;
    renderContentDashboard(data);
  } catch (err) {
    document.getElementById('content-commands-groups').innerHTML =
      '<div class="empty">Network error loading content dashboard</div>';
  }
}

// ────────── Tenant scope UI helpers (2026-05-04) ──────────
function refreshContentScopeUI() {
  const userInput = document.getElementById('content-scope-user-id');
  const tenantInput = document.getElementById('content-scope-tenant-id');
  const status = document.getElementById('content-scope-status');
  if (!userInput || !tenantInput || !status) return;
  userInput.value = CONTENT_SCOPE.userId || '';
  tenantInput.value = CONTENT_SCOPE.tenantId || '';
  if (CONTENT_SCOPE.userId || CONTENT_SCOPE.tenantId) {
    status.textContent = 'Scoped panels/actions: user=' + (CONTENT_SCOPE.userId || '—')
      + ' / tenant=' + (CONTENT_SCOPE.tenantId || '—')
      + ' · mixed overview remains owner-bootstrap/platform';
    // The element carries the u-c-text-tertiary utility (!important), which an
    // inline colour cannot beat; swap utilities instead.
    status.classList.add('u-c-accent');
    status.classList.remove('u-c-text-tertiary');
  } else {
    status.textContent = 'Operator/platform scope (no x-nexus-* headers)';
    status.classList.add('u-c-text-tertiary');
    status.classList.remove('u-c-accent');
  }
}
function saveContentScope() {
  const userId = (document.getElementById('content-scope-user-id').value || '').trim();
  const tenantId = (document.getElementById('content-scope-tenant-id').value || '').trim();
  // Numeric-only sanity. Empty stays empty (clears scope).
  if (userId && !/^\d+$/.test(userId)) {
    showToast('User ID must be numeric', false);
    return;
  }
  if (tenantId && !/^\d+$/.test(tenantId)) {
    showToast('Tenant ID must be numeric', false);
    return;
  }
  P.setContentScope({ userId, tenantId });
  refreshContentScopeUI();
  showToast(
    (userId || tenantId)
      ? 'Scope applied. Re-loading Content dashboard.'
      : 'Scope cleared. Re-loading Content dashboard.',
    true
  );
  // Reload dashboard with new scope.
  loadContentDashboard();
}
function clearContentScope() {
  P.setContentScope({ userId: '', tenantId: '' });
  refreshContentScopeUI();
  showToast('Scope cleared. Re-loading Content dashboard.', true);
  loadContentDashboard();
}

// ────────── Performance panel (CONTENT-UI-O3, 2026-05-04) ──────────
async function loadContentPerformance() {
  const card = document.getElementById('content-performance-card');
  if (!card) return;
  if (!CONTENT_SCOPE.userId) {
    // No scope active — hide the performance card; it's tenant-only.
    card.hidden = true;
    return;
  }
  card.hidden = false;
  document.getElementById('content-performance-meta').textContent = 'Loading…';
  try {
    const params = new URLSearchParams({
      userId: String(CONTENT_SCOPE.userId),
    });
    if (CONTENT_SCOPE.tenantId) params.set('tenantId', String(CONTENT_SCOPE.tenantId));
    const r = await apiFetch('/api/v1/admin/content/performance?' + params.toString());
    if (!r.ok) {
      document.getElementById('content-performance-meta').textContent =
        'Failed to load (' + r.status + ')';
      return;
    }
    const data = await r.json();
    const perf = data && data.performance;
    if (!perf) {
      document.getElementById('content-performance-meta').textContent = 'No data returned';
      return;
    }
    renderContentPerformance(perf);
  } catch (err) {
    document.getElementById('content-performance-meta').textContent =
      'Network error loading performance';
  }
}

function renderContentPerformance(perf) {
  const meta = document.getElementById('content-performance-meta');
  if (meta) meta.textContent = 'As of ' + (perf.generatedAt || 'now')
    + ' · tenant=' + perf.tenantId + ' / owner=' + perf.ownerUserId;
  setText('content-perf-topics-total', String(perf.topics.total));
  const breakdown = Object.entries(perf.topics.byStatus || {})
    .map(([k, v]) => k + ' ' + v).join(' · ');
  setText('content-perf-topics-sub', breakdown || 'no topics yet');
  const publicationUnavailable = perf.topics.publicationTracking
    && perf.topics.publicationTracking.availability === 'unavailable';
  setText(
    'content-perf-published-30d',
    publicationUnavailable || perf.topics.publishedLast30d == null
      ? '—'
      : String(perf.topics.publishedLast30d)
  );
  setText(
    'content-perf-published-30d-sub',
    publicationUnavailable ? 'publication not tracked' : 'reported cadence'
  );
  setText('content-perf-scripts-30d', String(perf.scripts.last30d));
  setText('content-perf-scripts-sub', 'total ' + perf.scripts.total);
  const ra = perf.radarFeedback || { total: 0, byAction: { accept: 0, reject: 0 } };
  setText('content-perf-radar-total', String(ra.total));
  setText('content-perf-radar-sub',
    (ra.byAction.accept || 0) + ' ✓ · ' + (ra.byAction.reject || 0) + ' ✗ · '
    + (ra.byAction.save || 0) + ' 🔖 · ' + (ra.byAction.create_brief || 0) + ' 📝');

  const hi = document.getElementById('content-perf-highlights');
  if (hi) hi.innerHTML = (perf.highlights || []).length
    ? perf.highlights.map(h => '<li>' + esc(h) + '</li>').join('')
    : '<li class="empty">No evidence-backed highlights yet.</li>';

  const wa = document.getElementById('content-perf-warnings');
  if (wa) wa.innerHTML = (perf.warnings || []).length
    ? perf.warnings.map(w => '<li>' + esc(w) + '</li>').join('')
    : '<li class="empty">No warnings.</li>';

  const accepted = (ra.topAcceptedTopics || []);
  const acceptedHost = document.getElementById('content-perf-top-accepted');
  if (acceptedHost) {
    acceptedHost.innerHTML = accepted.length
      ? '<ul class="u-m-0 u-pl-space-4 u-fs-12">'
        + accepted.map(t => '<li>' + esc(t.topic) + ' <span class="text-muted">×' + t.count + '</span></li>').join('')
        + '</ul>'
      : '<div class="empty">No accepts yet</div>';
  }
  const rejected = (ra.topRejectedTopics || []);
  const rejectedHost = document.getElementById('content-perf-top-rejected');
  if (rejectedHost) {
    rejectedHost.innerHTML = rejected.length
      ? '<ul class="u-m-0 u-pl-space-4 u-fs-12">'
        + rejected.map(t => '<li>' + esc(t.topic) + ' <span class="text-muted">×' + t.count + '</span></li>').join('')
        + '</ul>'
      : '<div class="empty">No rejects yet</div>';
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ────────── Canonical lifecycle (CONTENT-UI-O4, 2026-05-04) ──────────
// Renders the 12-bucket canonical lifecycle as a horizontal pill row
// inside the existing Content Pipeline card. Visible only when scope
// is active (the legacy 5-stage view is the no-scope fallback).
async function loadContentCanonicalLifecycle() {
  const card = document.getElementById('content-canonical-lifecycle-card');
  if (!card) return;
  if (!CONTENT_SCOPE.userId) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  setText('content-canonical-lifecycle-meta', 'Loading…');
  try {
    const params = new URLSearchParams({ userId: String(CONTENT_SCOPE.userId) });
    if (CONTENT_SCOPE.tenantId) params.set('tenantId', String(CONTENT_SCOPE.tenantId));
    const r = await apiFetch('/api/v1/admin/content/lifecycle?' + params.toString());
    if (!r.ok) {
      setText('content-canonical-lifecycle-meta', 'Failed to load (' + r.status + ')');
      return;
    }
    const data = await r.json();
    const lc = data && data.lifecycle;
    if (!lc) {
      setText('content-canonical-lifecycle-meta', 'No data');
      return;
    }
    renderContentCanonicalLifecycle(lc);
  } catch (err) {
    setText('content-canonical-lifecycle-meta', 'Network error');
  }
}

const CANONICAL_LIFECYCLE_TINTS = {
  discovered: 'var(--info)',
  suggested: 'var(--info)',
  accepted: 'var(--success)',
  briefing: 'var(--warning)',
  drafting: 'var(--warning)',
  review: 'var(--domain-content)',
  approved: 'var(--domain-content)',
  scheduled: 'var(--accent)',
  published: 'var(--success)',
  measured: 'var(--info)',
  archived: 'var(--text-tertiary)',
  rejected: 'var(--error)',
};

function renderContentCanonicalLifecycle(lc) {
  const meta = document.getElementById('content-canonical-lifecycle-meta');
  if (meta) meta.textContent = (lc.total || 0) + ' items · tenant=' + lc.tenantId
    + ' / owner=' + lc.ownerUserId;
  const band = document.getElementById('content-canonical-lifecycle-band');
  if (!band) return;
  const buckets = Array.isArray(lc.buckets) ? lc.buckets : [];
  if (buckets.length === 0) {
    band.innerHTML = '<div class="empty">No lifecycle data yet.</div>';
    return;
  }
  band.innerHTML = buckets.map(b => {
    const tint = CANONICAL_LIFECYCLE_TINTS[b.stage] || 'var(--text-secondary)';
    const dimmed = !b.count;
    const opacity = dimmed ? '0.45' : '1';
    const bg = dimmed
      ? 'rgba(150,150,150,0.06)'
      : `color-mix(in srgb, ${tint} 14%, var(--bg-elevated))`;
    return `
      <div class="bucket-chip" data-bg="${bg}" data-opacity="${opacity}">
        <div class="u-fs-16 u-fw-700" data-color="${dimmed ? 'var(--text-tertiary)' : tint}">
          ${b.count}
        </div>
        <div class="u-fs-9 u-fw-600 u-c-text-secondary u-mt-2">
          ${esc(b.label)}
        </div>
      </div>
    `;
  }).join('');
}

// The portal script runs inside an IIFE. Inline `onclick="..."` handlers
// resolve against `window`, so expose the Content controls they invoke.
window.saveContentScope = saveContentScope;
window.clearContentScope = clearContentScope;
window.loadContentPerformance = loadContentPerformance;
window.loadContentCanonicalLifecycle = loadContentCanonicalLifecycle;

function renderContentDashboard(d) {
  if (!d || d.ok !== true) return;
  renderContentKpis(d);
  renderContentPipeline(d.pipeline || { stages: {}, recent: [] });
  renderContentAgentGraph(d.agentGraph || { nodes: [], edges: [] });
  renderContentTriggers(d.triggers || []);
  renderContentBooks(d.books || { rows: [] });
  renderContentReactionRadar(d.reactionRadar || { recentSignals: [] });
  renderContentYouTube(d.youtube || { channels: [], videos: [] });
  renderContentVoiceDna(d.voiceDna || []);
  renderContentCommands(d.commands || []);

  // Update the nav badge with the active signal count
  const badge = document.getElementById('nav-content-badge');
  if (badge) {
    const n = d.activeSignals || 0;
    badge.textContent = n > 0 ? String(n) : '';
  }
}

function renderContentKpis(d) {
  const pipe = d.pipeline || {};
  const books = d.books || {};
  const yt = d.youtube || { totals: {} };
  const total = pipe.totalActive != null ? pipe.totalActive : 0;
  document.getElementById('content-kpi-pipeline').textContent = fmtNum(total);
  document.getElementById('content-kpi-pipeline-sub').textContent =
    pipe.publishedThisWeek == null
      || (pipe.publicationTracking && pipe.publicationTracking.availability === 'unavailable')
      ? 'Publication tracking unavailable'
      : pipe.publishedThisWeek + ' published this week';
  document.getElementById('content-kpi-books').textContent = fmtNum(books.extracted || 0);
  document.getElementById('content-kpi-books-sub').textContent =
    'of ' + fmtNum(books.total || 0) + ' · ' + fmtNum(books.pending || 0) + ' pending';
  document.getElementById('content-kpi-channels').textContent =
    fmtNum((yt.totals && yt.totals.activeChannels) || 0);
  document.getElementById('content-kpi-channels-sub').textContent =
    'of ' + fmtNum((yt.totals && yt.totals.channels) || 0) + ' total';
  document.getElementById('content-kpi-signals').textContent = fmtNum(d.activeSignals || 0);
}

const CONTENT_PIPELINE_STAGES = ['approved', 'scripted', 'filming', 'editing', 'published'];
const CONTENT_PIPELINE_LABELS = {
  approved: 'Approved',
  scripted: 'Scripted',
  filming: 'Filming',
  editing: 'Editing',
  published: 'Published',
};

function renderContentPipeline(p) {
  const stagesEl = document.getElementById('content-pipeline-stages');
  const recentEl = document.getElementById('content-pipeline-recent');
  const metaEl = document.getElementById('content-pipeline-meta');

  const stageBoxes = CONTENT_PIPELINE_STAGES.map(s => {
    const tracking = p.stageTracking && p.stageTracking[s];
    const unavailable = s === 'published' && (
      !p.stages
      || p.stages[s] == null
      || (tracking && tracking.tracking === 'not_modeled')
    );
    const count = unavailable ? '—' : ((p.stages && p.stages[s]) || 0);
    return '<div class="u-p-space-3 kpi-card">' +
      '<div class="kpi-label">' + esc(CONTENT_PIPELINE_LABELS[s]) + '</div>' +
      '<div class="u-fs-24 kpi-value">' + (unavailable ? count : fmtNum(count)) + '</div>' +
      '</div>';
  }).join('');
  stagesEl.innerHTML = stageBoxes;

  let metaParts = [];
  if (p.bottleneck) {
    metaParts.push(
      '⚠️ Bottleneck: ' + esc(p.bottleneck.stage) +
      ' (' + p.bottleneck.count + ' stuck, ~' + p.bottleneck.avgDays + 'd)',
    );
  }
  if (p.publishedThisWeek != null) {
    metaParts.push(p.publishedThisWeek + ' published this week');
  } else if (p.publicationTracking && p.publicationTracking.availability === 'unavailable') {
    metaParts.push('Publication tracking unavailable');
  }
  metaEl.textContent = metaParts.join(' · ') || '—';

  const rows = (p.recent || []).slice(0, 15);
  if (rows.length === 0) {
    recentEl.innerHTML = '<div class="empty">No pipeline items yet</div>';
    return;
  }
  recentEl.innerHTML =
    '<div class="u-ovx-auto"><table class="data-table">' +
    '<thead><tr><th>Topic</th><th>Niche</th><th>Stage</th><th>Updated</th><th>Published</th></tr></thead>' +
    '<tbody>' +
    rows.map(r => {
      const pubCell = r.publishedUrl
        ? '<a href="' + esc(r.publishedUrl) + '" target="_blank" rel="noopener" class="u-c-accent">View</a>'
        : '—';
      return '<tr>' +
        '<td>' + esc(r.topicTitle) + '</td>' +
        '<td class="text-muted">' + esc(r.niche || '—') + '</td>' +
        '<td><span class="badge badge-' + esc(stageToBadge(r.stage)) + '">' + esc(r.stage) + '</span></td>' +
        '<td class="text-muted">' + relativeTime(r.updatedAt) + '</td>' +
        '<td>' + pubCell + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

function stageToBadge(stage) {
  if (stage === 'published') return 'success';
  if (stage === 'editing' || stage === 'filming') return 'info';
  if (stage === 'scripted') return 'warning';
  return 'neutral';
}

// ── Agent mesh graph ──
const CONTENT_AGENT_POSITIONS = {
  channel_learner:   { x:  80, y:  90 },
  book_extractor:    { x:  80, y: 230 },
  voice_evolution:   { x: 310, y: 140 },
  performance_agent: { x:  80, y: 380 },
  reaction_radar:    { x: 540, y:  80 },
  content_discovery: { x: 540, y: 220 },
  seo_agent:         { x: 310, y: 380 },
  content_workflow:  { x: 770, y: 180 },
  pipeline_agent:    { x: 770, y: 340 },
  autoresearch:      { x: 540, y: 440 },
};

function renderContentAgentGraph(g) {
  const svg = document.getElementById('content-agent-graph');
  if (!svg) return;
  const nodes = g.nodes || [];
  const edges = g.edges || [];

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  // Build edges as curves
  const edgeSvg = edges.map((e, i) => {
    const from = CONTENT_AGENT_POSITIONS[e.from];
    const to = CONTENT_AGENT_POSITIONS[e.to];
    if (!from || !to) return '';
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const mx = from.x + dx / 2 + (dy > 0 ? 30 : -30);
    const my = from.y + dy / 2;
    const markerId = 'arrow-' + i;
    return (
      '<defs><marker id="' + markerId + '" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)"/>' +
      '</marker></defs>' +
      '<path d="M ' + (from.x + 70) + ' ' + from.y + ' Q ' + mx + ' ' + my + ' ' + (to.x - 70) + ' ' + to.y + '" ' +
      'fill="none" stroke="var(--text-tertiary)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#' + markerId + ')" opacity="0.65"/>' +
      '<text x="' + mx + '" y="' + (my - 4) + '" text-anchor="middle" fill="var(--text-tertiary)" font-size="9" font-family="ui-monospace, monospace">' + esc(e.signal) + '</text>'
    );
  }).join('');

  // Build nodes
  const nodeSvg = nodes.map(n => {
    const p = CONTENT_AGENT_POSITIONS[n.id] || { x: 0, y: 0 };
    const statusColor =
      n.lifecycle === 'paused' ? 'var(--text-tertiary)' :
      n.lastStatus === 'success' ? 'var(--domain-secretary)' :
      n.lastStatus === 'failed' ? '#E25C5C' :
      n.lastStatus === 'never' ? 'var(--text-tertiary)' :
      'var(--text-secondary)';
    const runsLabel = n.lifecycle === 'paused'
      ? 'paused · no signals emitted'
      : n.totalRuns > 0
      ? (n.totalRuns + ' runs · ' + (n.signalsProduced || 0) + ' signals')
      : 'never run';
    return (
      '<g transform="translate(' + (p.x - 70) + ',' + (p.y - 28) + ')">' +
      '<rect width="140" height="56" rx="10" fill="var(--bg-secondary)" stroke="var(--border)" stroke-width="1.5"/>' +
      '<circle cx="12" cy="12" r="4" fill="' + statusColor + '"/>' +
      '<text x="22" y="16" fill="var(--text-primary)" font-size="12" font-weight="600">' + esc(n.label) + '</text>' +
      '<text x="12" y="34" fill="var(--text-secondary)" font-size="10">' + esc(runsLabel) + '</text>' +
      '<text x="12" y="48" fill="var(--text-tertiary)" font-size="9">' + esc(n.lifecycle === 'paused' ? 'tenant scope required' : (n.cron ? '⏰ ' + n.cron : 'on demand')) + '</text>' +
      '</g>'
    );
  }).join('');

  svg.innerHTML = edgeSvg + nodeSvg;

  // Build the legend
  const legend = document.getElementById('content-agent-legend');
  legend.innerHTML =
    '<span><span class="u-d-inline-block u-w-8 u-h-8 u-r-50p u-bg-domain-secretary u-mr-6"></span>last run OK</span>' +
    '<span><span class="u-d-inline-block u-w-8 u-h-8 u-r-50p u-bg-e25c5c u-mr-6"></span>last run failed</span>' +
    '<span><span class="u-d-inline-block u-w-8 u-h-8 u-r-50p u-bg-text-tertiary u-mr-6"></span>never run</span>' +
    '<span class="u-ml-auto u-ff-ui-monospace-monospace">' +
    nodes.length + ' agents · ' + edges.length + ' signal routes</span>';
}

function renderContentTriggers(triggers) {
  const tbody = document.getElementById('content-triggers-tbody');
  if (!triggers || triggers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No content triggers registered</div></td></tr>';
    return;
  }
  tbody.innerHTML = triggers.map(t => {
    const statusBadge = '<span class="badge badge-' + esc(triggerStatusClass(t.status)) + '">' + esc(t.lifecycle === 'paused' ? 'paused' : (t.lastResult || 'never')) + '</span>';
    return '<tr>' +
      '<td><div>' + esc(t.label) + '</div><div class="u-fs-10 text-muted mono">' + esc(t.name) + '</div></td>' +
      '<td class="mono">' + esc(t.lifecycle === 'paused' ? 'Paused' : (t.cronHuman || t.cronExpression)) + '</td>' +
      '<td class="text-muted">' + (t.lastRunAt ? shortDateTime(t.lastRunAt) + ' · ' + relativeTime(t.lastRunAt) : '—') + '</td>' +
      '<td class="text-muted mono">' + (t.lastDurationMs != null ? t.lastDurationMs + 'ms' : '—') + '</td>' +
      '<td class="text-muted">' + (t.nextFireAt ? shortDateTime(t.nextFireAt) : '—') + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '</tr>';
  }).join('');
}

function triggerStatusClass(s) {
  if (s === 'ok') return 'success';
  if (s === 'failed') return 'error';
  if (s === 'running') return 'info';
  return 'neutral';
}

function renderContentBooks(books) {
  const el = document.getElementById('content-books-list');
  const meta = document.getElementById('content-books-meta');
  meta.textContent = (books.extracted || 0) + '/' + (books.total || 0) + ' extracted';
  const rows = books.rows || [];
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No books yet</div>';
    return;
  }
  el.innerHTML = rows.slice(0, 20).map(b => {
    const statusBadge = '<span class="u-fs-10 badge badge-' +
      (b.status === 'extracted' ? 'success' : b.status === 'pending' || b.status === 'extracting' ? 'warning' : 'neutral') +
      '">' + esc(b.status) + '</span>';
    const frameworksPreview = (b.frameworks && b.frameworks.length > 0)
      ? '<div class="u-fs-11 u-mt-4 text-muted">Frameworks: ' +
          esc(b.frameworks.slice(0, 3).join(', ')) + '</div>'
      : '';
    const thesis = b.thesis
      ? '<div class="u-fs-11 u-mt-4 u-lh-1-4 text-muted">' + esc(b.thesis).slice(0, 220) + (b.thesis.length > 220 ? '…' : '') + '</div>'
      : '';
    const actions = b.status === 'failed'
      ? '<button class="u-fs-10 btn btn-ghost btn-sm" data-act="retryBookExtraction" data-args="[' + b.id + ']">🔁 Retry</button>'
      : '';
    const deleteBtn = '<button class="u-fs-10 u-c-error btn btn-ghost btn-sm" data-act="deleteBook" data-args="[' + b.id + ']">✕</button>';
    return '<div class="u-p-space-3-0 u-bb-1-solid-border">' +
      '<div class="u-d-flex u-jc-space-between u-ai-flex-start u-gap-space-2">' +
        '<div><div class="u-fw-600 u-fs-13">' + esc(b.title) + '</div>' +
        '<div class="u-fs-11 text-muted">' + esc(b.author) + ' · ' + (b.timesReferenced || 0) + ' refs</div>' +
        '</div><div class="u-d-flex u-gap-4 u-ai-center">' + actions + deleteBtn + statusBadge + '</div></div>' +
      thesis + frameworksPreview +
      '</div>';
  }).join('');
}

function renderContentReactionRadar(rr) {
  const el = document.getElementById('content-radar-list');
  const meta = document.getElementById('content-radar-meta');
  const pillarToggle = document.getElementById('pillar-editor-toggle');
  if (rr.lastStatus === 'paused') {
    meta.textContent = 'Paused · tenant-user scope rebuild required';
    if (pillarToggle) pillarToggle.disabled = true;
    el.innerHTML = '<div class="empty">Historical Reaction Radar signals are hidden while the agent is paused.</div>';
    return;
  }
  if (pillarToggle) pillarToggle.disabled = false;
  meta.textContent = (rr.activeSignals || 0) + ' active · last ' + (rr.lastRunAt ? relativeTime(rr.lastRunAt) : 'never');
  const rows = rr.recentSignals || [];
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No recent reactions</div>';
    return;
  }
  el.innerHTML = rows.slice(0, 12).map(s => {
    const pri = s.priority === 'urgent' ? 'badge-error' : s.priority === 'normal' ? 'badge-info' : 'badge-neutral';
    const dotColor = s.status === 'active' ? 'var(--domain-secretary)' : 'var(--text-tertiary)';
    return '<div class="u-p-space-2-0 u-bb-1-solid-border u-d-flex u-gap-space-3 u-ai-flex-start">' +
      '<span class="signal-dot" data-bg="' + dotColor + '"></span>' +
      '<div class="u-flex-1 u-minw-0">' +
      '<div class="u-fs-12 u-fw-500">' + esc(s.summary) + '</div>' +
      '<div class="u-fs-10 u-mt-2 text-muted">' + esc(s.type) + ' · ' + relativeTime(s.createdAt) + '</div>' +
      '</div>' +
      '<span class="u-fs-10 badge ' + pri + '">' + esc(s.priority) + '</span>' +
      '</div>';
  }).join('');
}

function renderContentYouTube(yt) {
  const chEl = document.getElementById('content-youtube-channels');
  const vdEl = document.getElementById('content-youtube-videos');
  const metaEl = document.getElementById('content-youtube-meta');
  const t = yt.totals || {};
  metaEl.textContent =
    (t.activeChannels || 0) + '/' + (t.channels || 0) + ' channels · ' +
    (t.studies || 0) + ' studies · ' + (t.transcripts || 0) + ' transcripts';

  const channels = yt.channels || [];
  if (channels.length === 0) {
    chEl.innerHTML = '<div class="empty">No reference channels yet</div>';
  } else {
    chEl.innerHTML = channels.slice(0, 15).map(c => {
      const statusBadge = '<span class="u-fs-10 badge badge-' +
        (c.status === 'active' ? 'success' :
         c.status === 'pending' || c.status === 'analyzing' ? 'warning' :
         c.status === 'failed' ? 'error' : 'neutral') +
        '">' + esc(c.status) + '</span>';
      const nameLine = c.name ? esc(c.name) : c.url.slice(0, 48);
      const analyzed = c.videosAnalyzed || 0;
      const lastAt = c.lastAnalyzedAt ? relativeTime(c.lastAnalyzedAt) : 'never';
      const errorLine = c.errorMessage
        ? '<div class="u-fs-10 u-c-e25c5c text-muted">' + esc(c.errorMessage).slice(0, 120) + '</div>'
        : '';
      return '<div class="u-p-space-2-0 u-bb-1-solid-border">' +
        '<div class="u-d-flex u-jc-space-between u-ai-flex-start u-gap-space-2">' +
        '<div class="u-minw-0 u-flex-1"><div class="u-fw-500 u-fs-12 u-ov-hidden u-to-ellipsis u-ws-nowrap">' + esc(nameLine) + '</div>' +
        '<div class="u-fs-10 u-ov-hidden u-to-ellipsis u-ws-nowrap text-muted mono"><a href="' + esc(c.url) + '" target="_blank" rel="noopener" class="u-c-inherit">' + esc(c.url) + '</a></div></div>' +
        '<div class="u-d-flex u-gap-4 u-ai-center">' +
          '<button class="u-fs-10 btn btn-ghost btn-sm" data-act="reanalyzeChannel" data-args="[' + c.id + ']" title="Re-analyze">🔄</button>' +
          '<button class="u-fs-10 u-c-error btn btn-ghost btn-sm" data-act="deleteChannel" data-args="[' + c.id + ']" title="Remove">✕</button>' +
          statusBadge +
        '</div></div>' +
        '<div class="u-fs-10 u-mt-4 text-muted">' + analyzed + ' videos · ' + lastAt + '</div>' +
        errorLine +
        '</div>';
    }).join('');
  }

  const videos = yt.videos || [];
  if (videos.length === 0) {
    vdEl.innerHTML = '<div class="empty">No videos analyzed yet</div>';
  } else {
    vdEl.innerHTML = videos.slice(0, 15).map(v => {
      const badge = v.hasStudy
        ? '<span class="u-fs-10 badge badge-success">' + esc(v.studyType || 'study') + '</span>'
        : '<span class="u-fs-10 badge badge-neutral">transcript</span>';
      const titleLine = v.title || v.videoId;
      return '<div class="u-p-space-2-0 u-bb-1-solid-border">' +
        '<div class="u-d-flex u-jc-space-between u-ai-flex-start u-gap-space-2">' +
        '<div class="u-minw-0 u-flex-1"><div class="u-fw-500 u-fs-12 u-ov-hidden u-to-ellipsis u-ws-nowrap"><a href="' + esc(v.youtubeUrl) + '" target="_blank" rel="noopener" class="u-c-inherit">' + esc(titleLine) + '</a></div>' +
        '<div class="u-fs-10 text-muted">' + esc(v.channelName || '—') + ' · ' + relativeTime(v.createdAt) + '</div></div>' +
        badge + '</div></div>';
    }).join('');
  }
}

function renderContentVoiceDna(voiceDna) {
  const el = document.getElementById('content-voice-dna');
  if (!voiceDna || voiceDna.length === 0) {
    el.innerHTML = '<div class="empty">No voice DNA extracted yet — run the channel learner or voice evolution agent.</div>';
    return;
  }
  el.innerHTML = voiceDna.map((v, idx) => {
    const textPreview = (v.text || '').slice(0, 320);
    const hasMore = (v.text || '').length > 320;
    const id = 'voicedna-' + idx;
    return '<div class="u-bg-bg-tertiary card">' +
      '<div class="u-mb-space-2 card-header">' +
      '<div class="u-fs-11 card-title">' + esc(v.label) + '</div>' +
      '<span class="card-subtitle">v' + v.version + ' · ' + relativeTime(v.updatedAt) + '</span>' +
      '</div>' +
      '<div id="' + id + '" class="u-fs-12 u-lh-1-5 u-c-text-primary u-ws-pre-wrap">' + esc(textPreview) + (hasMore ? '…' : '') + '</div>' +
      (hasMore
        ? '<button class="u-mt-space-2 btn btn-sm btn-ghost" data-act="expandVoiceDna" data-args="[' + idx + ']">Expand</button>'
        : '') +
      (v.sources && v.sources.length > 0
        ? '<div class="u-fs-10 u-mt-space-2 text-muted">Sources: ' + esc(v.sources.slice(0, 4).join(', ')) + (v.sources.length > 4 ? ' +' + (v.sources.length - 4) : '') + '</div>'
        : '') +
      '</div>';
  }).join('');
}

window.expandVoiceDna = function(idx) {
  if (!contentDashboardCache || !contentDashboardCache.voiceDna) return;
  const v = contentDashboardCache.voiceDna[idx];
  if (!v) return;
  const el = document.getElementById('voicedna-' + idx);
  if (el) el.textContent = v.text;
};

const CONTENT_COMMAND_GROUP_LABELS = {
  discover: '🔎 Discovery',
  research: '🎥 Research',
  ideate: '💡 Ideation',
  script: '✍️ Scripts',
  visuals: '🖼️ Visuals',
  analysis: '📊 Analysis',
  library: '📚 Book Library',
  seo: '🔍 SEO',
  pipeline: '🚀 Pipeline',
};

function renderContentCommands(groups) {
  const el = document.getElementById('content-commands-groups');
  if (!groups || groups.length === 0) {
    el.innerHTML = '<div class="empty">No content commands registered</div>';
    return;
  }
  el.innerHTML = groups.map(g => {
    const label = CONTENT_COMMAND_GROUP_LABELS[g.group] || g.group;
    const rows = (g.rows || []).map(r => {
      const cost = r.costUsd7d > 0 ? ' · ' + fmtCost(r.costUsd7d) : '';
      return '<tr>' +
        '<td class="mono">' + esc(r.label) + '</td>' +
        '<td class="text-muted">' + esc(r.description) + '</td>' +
        '<td class="num">' + fmtNum(r.calls7d) + '</td>' +
        '<td class="num">' + fmtNum(r.calls30d) + cost + '</td>' +
        '<td class="text-muted">' + (r.lastUsedAt ? relativeTime(r.lastUsedAt) : '—') + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="u-mb-space-4">' +
      '<div class="u-fs-11 u-mb-space-2 card-title">' + esc(label) + '</div>' +
      '<div class="u-ovx-auto"><table class="data-table">' +
      '<thead><tr><th class="u-w-120">Command</th><th>Description</th><th class="u-w-70 text-right">7d</th><th class="u-w-110 text-right">30d</th><th class="u-w-110">Last used</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }).join('');
}

// Wire up the refresh button once the section exists
const contentRefreshBtn = document.getElementById('content-refresh-btn');
if (contentRefreshBtn) {
  contentRefreshBtn.addEventListener('click', () => {
    loadContentDashboard();
    showToast('Refreshing content dashboard…', 'info');
  });
}

// ═══════════════════════════════════════════════════════════
// Content admin write handlers (portal forms → backend API)
// Added Session 5 — wires the HTML forms above to the 13
// POST/PUT/DELETE routes at /api/v1/admin/content/*
// ═══════════════════════════════════════════════════════════

// ── Books ─────────────────────────────────────────────────
window.addBook = async function() {
  const title = document.getElementById('add-book-title').value.trim();
  const author = document.getElementById('add-book-author').value.trim();
  if (!title || !author) { showToast('Title and author required', 'error'); return; }
  const btn = document.getElementById('add-book-btn');
  btn.disabled = true; btn.textContent = '…';
  try {
    const res = await apiFetch('/api/v1/admin/content/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Book added: ' + esc(title), 'success');
      document.getElementById('add-book-title').value = '';
      document.getElementById('add-book-author').value = '';
      loadContentDashboard();
    } else {
      showToast(data.error?.message || 'Failed', 'error');
    }
  } catch (e) { showToast('Network error', 'error'); }
  btn.disabled = false; btn.textContent = '+ Add';
};

window.retryBookExtraction = async function(id) {
  showToast('Retrying extraction…', 'info');
  try {
    const res = await apiFetch('/api/v1/admin/content/books/' + id + '/retry', { method: 'POST' });
    const data = await res.json();
    showToast(data.ok ? 'Extraction retried' : (data.error?.message || 'Failed'), data.ok ? 'success' : 'error');
    loadContentDashboard();
  } catch { showToast('Network error', 'error'); }
};

window.deleteBook = async function(id) {
  if (!confirm('Delete this book?')) return;
  try {
    const res = await apiFetch('/api/v1/admin/content/books/' + id, { method: 'DELETE' });
    const data = await res.json();
    showToast(data.ok ? 'Book removed' : 'Failed', data.ok ? 'success' : 'error');
    loadContentDashboard();
  } catch { showToast('Network error', 'error'); }
};

// ── YouTube channels ──────────────────────────────────────
window.addChannel = async function() {
  const url = document.getElementById('add-channel-url').value.trim();
  if (!url) { showToast('Channel URL required', 'error'); return; }
  const btn = document.getElementById('add-channel-btn');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  try {
    const res = await apiFetch('/api/v1/admin/content/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Channel added: ' + esc(data.channel?.name || url), 'success');
      document.getElementById('add-channel-url').value = '';
      loadContentDashboard();
    } else {
      showToast(data.error?.message || 'Failed', 'error');
    }
  } catch (e) { showToast('Network error', 'error'); }
  btn.disabled = false; btn.textContent = '+ Add Channel';
};

window.triggerChannelRelearn = async function() {
  const btn = document.getElementById('channel-relearn-btn');
  btn.disabled = true; btn.textContent = '🔄 Running…';
  showToast('Channel re-learn started (may take 30-60s)…', 'info');
  try {
    const res = await apiFetch('/api/v1/admin/content/channels/relearn', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      const r = data.result || {};
      showToast('Re-learn done: ' + (r.analyzed || 0) + ' analyzed, ' + (r.failed || 0) + ' failed', 'success');
      loadContentDashboard();
    } else {
      showToast(data.error?.message || 'Failed', 'error');
    }
  } catch { showToast('Network error', 'error'); }
  btn.disabled = false; btn.textContent = '🔄 Re-learn All';
};

window.deleteChannel = async function(id) {
  if (!confirm('Remove this channel?')) return;
  try {
    const res = await apiFetch('/api/v1/admin/content/channels/' + id, { method: 'DELETE' });
    const data = await res.json();
    showToast(data.ok ? 'Channel removed' : 'Failed', data.ok ? 'success' : 'error');
    loadContentDashboard();
  } catch { showToast('Network error', 'error'); }
};

window.reanalyzeChannel = async function(id) {
  showToast('Re-analyzing channel…', 'info');
  try {
    const res = await apiFetch('/api/v1/admin/content/channels/' + id + '/reanalyze', { method: 'POST' });
    const data = await res.json();
    showToast(data.ok ? 'Re-analysis complete' : (data.error?.message || 'Failed'), data.ok ? 'success' : 'error');
    loadContentDashboard();
  } catch { showToast('Network error', 'error'); }
};

// ── Reaction Radar pillars ────────────────────────────────
window.togglePillarEditor = function() {
  const ed = document.getElementById('pillar-editor');
  ed.hidden = !ed.hidden;
  if (!ed.hidden) loadPillars();
};

async function loadPillars() {
  try {
    const res = await apiFetch('/api/v1/admin/content/pillars');
    const data = await res.json();
    if (!data.ok) return;
    const rows = data.pillars || [];
    const el = document.getElementById('pillar-editor-rows');
    el.innerHTML = rows.map(p => {
      const kws = (p.keywords || []).join(', ');
      return '<div class="u-d-flex u-gap-space-2 u-ai-center u-mb-space-2">' +
        '<span class="u-fs-12 u-fw-600 u-minw-80">' + esc(p.name) + '</span>' +
        '<input type="text" value="' + esc(kws) + '" class="u-flex-1 u-p-4-8 u-r-radius-sm u-b-1-solid-border u-bg-bg-tertiary u-c-text-primary u-fs-11" ' +
        'data-on="change" data-act="updatePillarKeywords" data-args="[' + p.id + ',&quot;$value&quot;]">' +
        '<button class="u-fs-11 u-c-error btn btn-ghost btn-sm" data-act="deletePillar" data-args="[' + p.id + ']">✕</button>' +
        '</div>';
    }).join('');
  } catch { /* silent */ }
}

window.addPillar = async function() {
  const name = document.getElementById('add-pillar-name').value.trim();
  const kwStr = document.getElementById('add-pillar-keywords').value.trim();
  if (!name || !kwStr) { showToast('Name and keywords required', 'error'); return; }
  const keywords = kwStr.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const res = await apiFetch('/api/v1/admin/content/pillars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, keywords }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Pillar "' + esc(name) + '" added', 'success');
      document.getElementById('add-pillar-name').value = '';
      document.getElementById('add-pillar-keywords').value = '';
      loadPillars();
    } else {
      showToast(data.error?.message || 'Failed', 'error');
    }
  } catch { showToast('Network error', 'error'); }
};

window.updatePillarKeywords = async function(id, kwStr) {
  const keywords = kwStr.split(',').map(s => s.trim()).filter(Boolean);
  try {
    await apiFetch('/api/v1/admin/content/pillars/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords }),
    });
    showToast('Pillar updated', 'success');
  } catch { showToast('Update failed', 'error'); }
};

window.deletePillar = async function(id) {
  if (!confirm('Delete this pillar?')) return;
  try {
    const res = await apiFetch('/api/v1/admin/content/pillars/' + id, { method: 'DELETE' });
    const data = await res.json();
    showToast(data.ok ? 'Pillar removed' : 'Failed', data.ok ? 'success' : 'error');
    loadPillars();
  } catch { showToast('Network error', 'error'); }
};

// ── Voice DNA ─────────────────────────────────────────────
window.triggerVoiceSynthesis = async function() {
  const btn = document.getElementById('voice-synthesize-btn');
  btn.disabled = true; btn.textContent = '🧬 Running…';
  showToast('Voice synthesis started (may take 30-60s)…', 'info');
  try {
    const res = await apiFetch('/api/v1/admin/content/voice-dna/synthesize', { method: 'POST' });
    const data = await res.json();
    showToast(data.ok ? 'Synthesis complete' : (data.error?.message || 'Failed'), data.ok ? 'success' : 'error');
    loadContentDashboard();
  } catch { showToast('Network error', 'error'); }
  btn.disabled = false; btn.textContent = '🧬 Synthesize Now';
};

let contentTimer = null;
P.on('app:start', () => {
  if (!contentTimer) contentTimer = setInterval(() => { if (!document.hidden && P.getCurrentSection() === 'content') loadContentDashboard(); }, 30000);
});

P.registerSection('content', {
  mount() {},
  onShow() { loadContentDashboard(); },
});
