// AI — plan budgets, provider health, model config, domain routing, quality, cost
// Extracted from legacy.js (Phase 5 section extraction). The markup stays in
// portal.html; this module owns the section's data loading and rendering and
// talks to the shell through window.NexusPortal (fetch wrapper, helpers,
// section registry, event bus: app:start / refresh / poll / snapshot).
const P = window.NexusPortal;
const { apiFetch, apiJson, esc, shortDateTime, relativeTime, fmtNum, fmtCost, showToast, adminLoadErrorMessage } = P;
const navigateTo = (section) => P.navigateTo(section);

let aiPlanLimits = [];

async function loadAiPlanLimits() {
  const tbody = document.querySelector('#ai-plan-limits-table tbody');
  if (!tbody) return;
  try {
    const response = await apiFetch('/api/plans');
    if (!response.ok) throw new Error('plan budgets unavailable');
    const payload = await response.json();
    // Beta/manual grants are deliberately fixed at zero model allowance and
    // are not an editable paid plan. Keep their seeded row out of this editor
    // instead of rendering a Save action that the API correctly rejects.
    aiPlanLimits = (payload.plans || []).filter(plan =>
      ['free', 'pro', 'max', 'owner'].includes(String(plan.planId || '').toLowerCase())
    );
    renderAiPlanLimits();
  } catch {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty">Unable to load plan budgets</div></td></tr>';
  }
}

function renderAiPlanLimits() {
  const tbody = document.querySelector('#ai-plan-limits-table tbody');
  if (!tbody) return;
  if (aiPlanLimits.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No plan budgets configured</div></td></tr>';
    return;
  }
  tbody.innerHTML = aiPlanLimits.map(plan => {
    const id = String(plan.planId || '').toLowerCase();
    const fixedZero = id === 'free';
    const backgroundDaily = Number(plan.dailyCostUsd || 0) * 0.30;
    const backgroundMonthly = Number(plan.monthlyCostUsd || 0) * 0.30;
    const tokenLabel = plan.dailyTokenLimit == null ? 'tokens: —' : 'tokens: ' + fmtNum(plan.dailyTokenLimit);
    const messageLabel = plan.dailyMessageLimit == null ? 'messages: —' : 'messages: ' + fmtNum(plan.dailyMessageLimit);
    return '<tr>' +
      '<td><span class="tier-badge tier-' + esc(id) + '">' + esc(plan.displayName || id) + '</span></td>' +
      '<td><input class="u-maxw-110 input mono" type="number" min="0" step="0.001" id="plan-daily-' + esc(id) + '" value="' + Number(plan.dailyCostUsd || 0) + '"' + (fixedZero ? ' disabled title="Paid-only invariant"' : '') + '></td>' +
      '<td><input class="u-maxw-110 input mono" type="number" min="0" step="0.01" id="plan-monthly-' + esc(id) + '" value="' + Number(plan.monthlyCostUsd || 0) + '"' + (fixedZero ? ' disabled title="Paid-only invariant"' : '') + '></td>' +
      '<td class="mono">$' + backgroundDaily.toFixed(3) + '/day · $' + backgroundMonthly.toFixed(2) + '/month</td>' +
      '<td class="u-fs-11 text-muted">' + tokenLabel + '<br>' + messageLabel + ' (telemetry)</td>' +
      '<td class="text-right"><button class="btn btn-xs" data-save-plan="' + esc(id) + '"' + (fixedZero ? ' disabled title="Free AI budget is fixed at zero"' : '') + '>Save</button></td>' +
    '</tr>';
  }).join('');
  tbody.querySelectorAll('[data-save-plan]').forEach(button => {
    button.addEventListener('click', () => saveAiPlanLimit(button.dataset.savePlan));
  });
}

async function saveAiPlanLimit(planId) {
  const plan = aiPlanLimits.find(item => String(item.planId) === String(planId));
  const dailyEl = document.getElementById('plan-daily-' + planId);
  const monthlyEl = document.getElementById('plan-monthly-' + planId);
  const dailyCostUsd = Number(dailyEl && dailyEl.value);
  const monthlyCostUsd = Number(monthlyEl && monthlyEl.value);
  if (!plan || !Number.isFinite(dailyCostUsd) || dailyCostUsd < 0 || !Number.isFinite(monthlyCostUsd) || monthlyCostUsd < 0) {
    showToast('Daily and monthly limits must be non-negative numbers', false);
    return;
  }
  try {
    const response = await apiFetch('/api/plans/' + encodeURIComponent(planId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyCostUsd,
        monthlyCostUsd,
        dailyTokenLimit: plan.dailyTokenLimit,
        dailyMessageLimit: plan.dailyMessageLimit,
        allowedSkills: plan.allowedSkills,
      }),
    });
    if (!response.ok) throw new Error('plan update failed');
    showToast('AI plan budget updated');
    await loadAiPlanLimits();
  } catch {
    showToast('AI plan budget update failed', false);
  }
}
// ════════════════════════════════════════════════════════════
// Provider Health
//
// Pulls from TWO sources and merges:
//   1. /api/provider-health  → in-memory circuit breaker + fallback metrics
//                               (only populated for routing-provider calls)
//   2. /api/provider-stats   → api_usage-backed totals (ALWAYS populated)
//
// The dashboard's "No provider data yet" issue was that (1) is empty for
// direct anthropic-hook calls. (2) guarantees we have something to show.
// ════════════════════════════════════════════════════════════
async function loadProviderHealth() {
  try {
    const [healthRes, statsRes] = await Promise.all([
      apiFetch('/api/provider-health').catch(() => null),
      apiFetch('/api/provider-stats').catch(() => null),
    ]);

    const health = healthRes && healthRes.ok ? await healthRes.json() : { providers: {} };
    const stats = statsRes && statsRes.ok ? await statsRes.json() : { providers: [] };

    const el = document.getElementById('provider-health-content');
    const dashEl = document.getElementById('dash-providers');

    // Merge: iterate the broader set (stats has all known providers + any
    // with SQLite rows), then overlay circuit/fallback metrics from health.
    const statProviders = Array.isArray(stats.providers) ? stats.providers : [];
    const healthMap = health.providers || {};

    if (statProviders.length === 0 && Object.keys(healthMap).length === 0) {
      el.innerHTML = '<div class="empty">No provider data yet</div>';
      dashEl.innerHTML = '<div class="empty">No provider data yet</div>';
      return;
    }

    // Build the unified row list. Any provider that has either SQLite stats
    // OR in-memory metrics shows up.
    const providerNames = new Set();
    statProviders.forEach(p => providerNames.add(p.name));
    Object.keys(healthMap).forEach(n => providerNames.add(n));

    const rows = Array.from(providerNames).map(name => {
      const s = statProviders.find(p => p.name === name) || {
        name, today: { calls: 0, cost: 0, tokens: 0, lastCallAt: null },
        week: { calls: 0, cost: 0 }, circuit: { state: 'CLOSED', failures: 0 },
      };
      const h = healthMap[name] || {};
      const metrics = h.metrics || {};
      return {
        name,
        circuit: s.circuit || h.circuit || { state: 'CLOSED', failures: 0 },
        todayCalls: s.today.calls,
        todayCost: s.today.cost,
        todayTokens: s.today.tokens,
        weekCalls: s.week.calls,
        weekCost: s.week.cost,
        failures: metrics.failureCount || 0,
        fallbacks: metrics.fallbackTriggerCount || 0,
        cbOpens: metrics.circuitOpenCount || 0,
        lastOk: metrics.lastSuccessAt || s.today.lastCallAt,
        lastFail: metrics.lastFailureAt,
      };
    }).sort((a, b) => (b.todayCost + b.weekCost) - (a.todayCost + a.weekCost));

    const providerIcons = { anthropic: '🟣', openai: '🟢', gemini: '🔵' };

    const html = rows.map(p => {
      const icon = providerIcons[p.name] || '⚪';
      const lastOk = p.lastOk ? shortDateTime(p.lastOk) : '—';
      const lastFail = p.lastFail ? shortDateTime(p.lastFail) : '—';
      const circuitClass = p.circuit.state || 'CLOSED';
      return '<div class="provider-card">' +
        '<div class="provider-card-header">' +
          '<div class="provider-name">' + icon + ' ' + esc(p.name) + '</div>' +
          '<span class="provider-circuit ' + circuitClass + '">● ' + circuitClass + '</span>' +
        '</div>' +
        '<div class="provider-stats">' +
          '<div>Calls today<br><b>' + p.todayCalls + '</b></div>' +
          '<div>Cost today<br><b>$' + (p.todayCost).toFixed(3) + '</b></div>' +
          '<div>7d calls<br><b>' + p.weekCalls + '</b></div>' +
          '<div>7d cost<br><b>$' + (p.weekCost).toFixed(3) + '</b></div>' +
        '</div>' +
        (p.failures + p.fallbacks + p.cbOpens > 0
          ? '<div class="u-fs-10 u-mt-6 text-tertiary mono">' +
              'Errors: ' + p.failures + ' · Fallbacks: ' + p.fallbacks + ' · CB opens: ' + p.cbOpens +
            '</div>'
          : '') +
        '<div class="u-fs-10 u-mt-4 text-tertiary mono">OK: ' + lastOk + ' · Fail: ' + lastFail + '</div>' +
      '</div>';
    }).join('');

    el.innerHTML = html;
    dashEl.innerHTML = html;
  } catch { /* silent */ }
}

// ════════════════════════════════════════════════════════════
// Model Configuration
// ════════════════════════════════════════════════════════════
async function loadModelConfig() {
  try {
    const r = await apiFetch('/api/model-config');
    if (!r.ok) return;
    const d = await r.json();
    const el = document.getElementById('model-config-content');
    const states = d.states || [];
    const options = d.options || {};
    const allModels = p => [...new Set([...(options[p]?.chat || []), ...(options[p]?.classifier || [])])];
    const providerIcons = { anthropic: '🟣', openai: '🟢', gemini: '🔵' };
    const domainIcons = { secretary: '📋', triathlon: '🏊', content: '🎬', finance: '💰', cooking: '👨‍🍳' };

    el.innerHTML = states.map(s => {
      const icon = providerIcons[s.provider] || '⚪';
      const mkSelect = (role, current, opts) => {
        const optHtml = opts.map(m => '<option value="' + esc(m) + '"' + (m === current ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
        return '<select id="model-sel-' + s.provider + '-' + role + '" data-original="' + esc(current) + '" data-on="change" data-act="showApplyBtn" data-args="[&quot;' + s.provider + '&quot;,&quot;' + role + '&quot;]">' + optHtml + '</select>';
      };
      const mkBadge = src => src === 'override' ? '<span class="badge badge-accent">override</span>' : '';
      const mkReset = (role, src) => src === 'override'
        ? '<button class="btn btn-xs" data-act="resetModel" data-args="[&quot;' + s.provider + '&quot;,&quot;' + role + '&quot;]">Reset</button>'
        : '';
      const mkApplyBtn = role => '<span id="apply-' + s.provider + '-' + role + '" hidden>' +
        '<button class="btn btn-primary btn-xs" data-act="applyModelChange" data-args="[&quot;' + s.provider + '&quot;,&quot;' + role + '&quot;]">Apply</button>' +
      '</span>';
      const mkRow = (label, role, model, src, opts) => '<div class="u-ai-center u-mb-6 flex gap-2">' +
        '<span class="u-minw-90 u-fs-11 text-muted">' + label + '</span>' +
        '<div class="u-flex-1">' + mkSelect(role, model, opts) + '</div>' +
        mkApplyBtn(role) + ' ' + mkBadge(src) + ' ' + mkReset(role, src) +
      '</div>';
      const domainRows = s.domains ? Object.entries(s.domains).map(([dom, dd]) => {
        const di = domainIcons[dom] || '⚙️';
        return mkRow(di + ' ' + dom, dom, dd.model, dd.source, allModels(s.provider));
      }).join('') : '';
      return '<div class="u-mb-14 u-p-12 u-bg-bg-tertiary u-b-1-solid-border u-r-radius-lg">' +
        '<div class="u-fw-600 u-mb-8 u-tt-capitalize">' + icon + ' ' + esc(s.provider) + '</div>' +
        '<div class="u-fs-10 u-mb-4 u-tt-uppercase u-ls-0-06em text-muted">Provider tiers</div>' +
        mkRow('Chat', 'chat', s.chat.model, s.chat.source, options[s.provider]?.chat || []) +
        mkRow('Classifier', 'classifier', s.classifier.model, s.classifier.source, options[s.provider]?.classifier || []) +
        (domainRows ? '<div class="u-fs-10 u-m-8-0-4 u-bt-1-solid-border u-pt-8 u-tt-uppercase u-ls-0-06em text-muted">Per-domain overrides</div>' + domainRows : '') +
      '</div>';
    }).join('');
  } catch { /* silent */ }
}

window.showApplyBtn = function(provider, role) {
  const sel = document.getElementById('model-sel-' + provider + '-' + role);
  const btn = document.getElementById('apply-' + provider + '-' + role);
  if (!sel || !btn) return;
  btn.hidden = sel.value === sel.dataset.original;
};
window.applyModelChange = async function(provider, role) {
  const sel = document.getElementById('model-sel-' + provider + '-' + role);
  if (!sel) return;
  try {
    const r = await apiFetch('/api/model-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, role, model: sel.value }),
    });
    const d = await r.json();
    if (d.ok) showToast(provider + ' ' + role + ' → ' + sel.value);
    else showToast('Failed', false);
    loadModelConfig();
  } catch { showToast('Error', false); }
};
window.resetModel = async function(provider, role) {
  try {
    const r = await apiFetch('/api/model-config', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, role }),
    });
    const d = await r.json();
    if (d.ok) showToast(provider + ' ' + role + ' reset');
    loadModelConfig();
  } catch { showToast('Error', false); }
};

// ════════════════════════════════════════════════════════════
// Domain Routing — live view of which provider runs each domain
// ════════════════════════════════════════════════════════════
//
// Pulls /api/domain-routing on load (and after every toggle), renders the
// master switches at the top + a table with one row per domain. Each row
// shows the resolved provider, the model name, the fallback, and the
// default the code would use. Per-domain toggles update the gemini_domains
// set; the master switches update gemini_routing_enabled and the
// provider-neutral Secretary primary-route setting. All changes persist to kv_store and take
// effect immediately (no pm2 restart needed because the backend clears
// its cached domain→pair map on every toggle POST).
const PROVIDER_PILL_CLASS = {
  anthropic: 'badge badge-purple',
  openai:    'badge badge-success',
  gemini:    'badge badge-info',
};
const PROVIDER_ICON = { anthropic: '🟣', openai: '🟢', gemini: '🔵' };
const DOMAIN_ICON = {
  secretary: '📋', triathlon: '🏊', content: '🎬', finance: '💰', cooking: '👨‍🍳',
};
const ALL_DOMAINS = ['secretary', 'triathlon', 'content', 'finance', 'cooking'];

async function loadDomainRouting() {
  try {
    const r = await apiFetch('/api/domain-routing');
    if (!r.ok) return;
    const d = await r.json();
    const domains = Array.isArray(d.domains) ? d.domains : [];
    const enabled = !!d.geminiRoutingEnabled;
    const secretaryPrimaryRouteEnabled = !!d.secretaryPrimaryRouteEnabled;
    const configured = !!d.geminiConfigured;

    // Master toggle states
    const enabledCheckbox = document.getElementById('domain-routing-enabled');
    const includeSecCheckbox = document.getElementById('domain-routing-secretary-primary');
    if (enabledCheckbox) enabledCheckbox.checked = enabled;
    if (includeSecCheckbox) {
      includeSecCheckbox.checked = secretaryPrimaryRouteEnabled;
      includeSecCheckbox.disabled = false;
    }

    // Status pill — shows whether Gemini is configured + active counts
    const geminiCount = domains.filter(d => d.provider === 'gemini').length;
    const openaiCount = domains.filter(d => d.provider === 'openai').length;
    const anthropicCount = domains.filter(d => d.provider === 'anthropic').length;
    const statusEl = document.getElementById('domain-routing-status');
    if (statusEl) {
      if (!configured) {
        statusEl.innerHTML = '<span class="u-c-text-warning">⚠ GEMINI_API_KEY not set</span>';
      } else if (!enabled) {
        statusEl.innerHTML = '<span class="u-c-text-tertiary">Gemini routes disabled · ' + openaiCount + ' → openai · ' + anthropicCount + ' → anthropic</span>';
      } else {
        statusEl.innerHTML = '<span class="u-c-text-secondary">' + geminiCount + ' → gemini · ' + openaiCount + ' → openai · ' + anthropicCount + ' → anthropic</span>';
      }
    }

    // Summary line in the card header
    const summaryEl = document.getElementById('domain-routing-summary');
    if (summaryEl) {
      const verb = enabled ? 'active' : 'disabled';
      summaryEl.textContent = 'Gemini routing ' + verb + ' · ' + domains.length + ' domains · ' + geminiCount + ' on Gemini';
    }

    // Table rows
    const tbody = document.querySelector('#domain-routing-table tbody');
    if (!tbody) return;
    if (domains.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No routing data — backend may have failed to initialize</div></td></tr>';
      return;
    }

    tbody.innerHTML = domains.map(row => {
      const dIcon = DOMAIN_ICON[row.domain] || '·';
      const pIcon = PROVIDER_ICON[row.provider] || '⚪';
      const fIcon = PROVIDER_ICON[row.fallback] || '⚪';
      const defIcon = PROVIDER_ICON[row.defaultProvider] || '⚪';
      const pillClass = PROVIDER_PILL_CLASS[row.provider] || 'badge';
      const isOverride = row.provider !== row.defaultProvider;

      // Per-domain toggle. Secretary is controlled by its provider-neutral
      // primary-route safeguard.
      // For others, the toggle calls togglePerDomain to update the
      // gemini_domains set on the backend.
      let toggle;
      if (row.isSecretary) {
        toggle = '<span class="u-fs-11 card-subtitle">controlled by Secretary route ↑</span>';
      } else {
        toggle = '<label class="u-gap-6 u-jc-flex-end u-cur-pointer u-fs-11 flex items-center">' +
          '<input type="checkbox" data-domain="' + esc(row.domain) + '"' + (row.geminiEnabled ? ' checked' : '') + ' data-on="change" data-act="togglePerDomain" data-args="[&quot;$el&quot;]" />' +
          '<span>' + (row.geminiEnabled ? 'on Gemini' : 'on Anthropic') + '</span>' +
        '</label>';
      }

      return '<tr>' +
        '<td><strong>' + dIcon + ' ' + esc(row.domain) + '</strong></td>' +
        '<td><span class="' + pillClass + '">' + pIcon + ' ' + esc(row.provider) + '</span>' +
          (isOverride ? ' <span class="u-fs-10 badge badge-accent">override</span>' : '') + '</td>' +
        '<td><code class="u-fs-11">' + esc(row.model || '—') + '</code></td>' +
        '<td><span class="card-subtitle">' + fIcon + ' ' + esc(row.fallback) + '</span></td>' +
        '<td><span class="card-subtitle">' + defIcon + ' ' + esc(row.defaultProvider) + '</span></td>' +
        '<td class="text-right">' + toggle + '</td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    const tbody = document.querySelector('#domain-routing-table tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="empty">Failed to load routing config</div></td></tr>';
  }
}

// ════════════════════════════════════════════════════════════
// Secretary Optimization (TASK-17 Layer 1+ metrics)
// ════════════════════════════════════════════════════════════
//
// Polls /api/secretary-metrics on the same 30s timer as the rest of
// the AI section. Renders three KPI cards (hit rate / latency /
// pattern count) and a per-pattern hit table. Counters are in-memory
// on the backend so they reset on pm2 restart — that's expected for
// operational telemetry. Non-fatal: if the endpoint errors, the card
// shows "—" placeholders and the rest of the dashboard keeps working.
async function loadSecretaryOptimization() {
  try {
    const r = await apiFetch('/api/secretary-metrics');
    if (!r.ok) return;
    const d = await r.json();
    const fp = d.fastpath || {};

    const hitRate = fp.hitRate || 0;
    const hitRatePct = (hitRate * 100).toFixed(1) + '%';
    const totalAttempts = fp.totalAttempts || 0;
    const totalHits = fp.totalHits || 0;
    const avgLatency = Math.round(fp.avgLatencyMs || 0);
    const patterns = Array.isArray(fp.registeredPatterns) ? fp.registeredPatterns : [];
    const hits = fp.hitsByPattern || {};

    // KPI tiles
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('secretary-opt-hit-rate', totalAttempts > 0 ? hitRatePct : '—');
    setText('secretary-opt-hits-total', totalHits + ' / ' + totalAttempts + ' attempts');
    setText('secretary-opt-latency', avgLatency > 0 ? String(avgLatency) : '—');
    setText('secretary-opt-pattern-count', String(patterns.length));

    // Header summary (uses the same color-coded thresholds documented
    // in the API endpoint comment: >50% excellent, 30-50% healthy, <30% needs work)
    const summary = document.getElementById('secretary-opt-summary');
    if (summary) {
      if (totalAttempts === 0) {
        summary.textContent = 'No attempts yet — send a message to populate';
      } else {
        const verdict = hitRate >= 0.5 ? '✓ excellent' : hitRate >= 0.3 ? '· healthy' : '⚠ needs more patterns';
        summary.textContent = totalHits + ' fastpath hits saved AI calls · ' + verdict;
      }
    }

    // Per-pattern table — sorted by hit count descending
    const tbody = document.querySelector('#secretary-opt-patterns tbody');
    if (!tbody) return;
    const rows = patterns
      .map((p) => ({ id: p, count: hits[p] || 0 }))
      .sort((a, b) => b.count - a.count);
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3"><div class="empty">No patterns registered</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        const share = totalHits > 0 ? ((row.count / totalHits) * 100).toFixed(0) + '%' : '—';
        const muted = row.count === 0 ? ' class="u-op-0-5"' : '';
        return '<tr' + muted + '>' +
          '<td><code class="u-fs-11">' + esc(row.id) + '</code></td>' +
          '<td class="text-right">' + row.count + '</td>' +
          '<td class="text-right card-subtitle">' + share + '</td>' +
        '</tr>';
      })
      .join('');
  } catch (err) {
    const tbody = document.querySelector('#secretary-opt-patterns tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3"><div class="empty">Failed to load metrics</div></td></tr>';
  }
}

// Helper: POST to /api/domain-routing/toggle and refresh the view
async function postRoutingChange(body, successMessage) {
  try {
    const r = await apiFetch('/api/domain-routing/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) {
      if (successMessage) showToast(successMessage);
      loadDomainRouting();
      // Refresh provider health too — circuit breaker state may have changed
      try { loadProviderHealth(); } catch {}
    } else {
      showToast('Routing change failed: ' + (d.message || 'unknown'), false);
    }
  } catch (e) {
    showToast('Network error: ' + e.message, false);
  }
}

// Master switch: enable/disable Gemini routing entirely
window.toggleGeminiRouting = function(checkbox) {
  postRoutingChange(
    { enabled: !!checkbox.checked },
    'Gemini routing ' + (checkbox.checked ? 'enabled' : 'disabled'),
  );
};

// Provider-neutral Secretary primary-route safeguard.
window.toggleSecretaryPrimaryRoute = function(checkbox) {
  postRoutingChange(
    { secretaryPrimaryRouteEnabled: !!checkbox.checked },
    'Secretary primary route ' + (checkbox.checked ? 'enabled' : 'disabled'),
  );
};

// Per-domain toggle: include/exclude one non-secretary domain from Gemini
window.togglePerDomain = function(checkbox) {
  const domain = checkbox.dataset.domain;
  if (!domain) return;
  // Read current set from the table, flip the one that just toggled,
  // then send the new full set to the backend (which replaces the kv_store
  // value atomically). Secretary is always excluded from this set since
  // it is controlled by the Secretary primary-route switch.
  const current = new Set();
  document.querySelectorAll('#domain-routing-table input[type="checkbox"][data-domain]').forEach(el => {
    if (el.checked) current.add(el.dataset.domain);
  });
  postRoutingChange(
    { domains: [...current] },
    domain + ' ' + (checkbox.checked ? '→ Gemini' : '→ Anthropic'),
  );
};

// ════════════════════════════════════════════════════════════
// Quality scores + Error distribution + Task metrics
// ════════════════════════════════════════════════════════════
async function loadQualityScores() {
  try {
    const r = await apiFetch('/api/quality-scores');
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok) return;
    const tbody = document.querySelector('#quality-scores-table tbody');
    const agents = d.byAgent || [];
    tbody.innerHTML = agents.map(a => {
      const sc = a.avgScore >= 80 ? 'var(--success)' : a.avgScore >= 50 ? 'var(--warning)' : 'var(--error)';
      const pc = a.passRate >= 0.9 ? 'var(--success)' : a.passRate >= 0.6 ? 'var(--warning)' : 'var(--error)';
      return '<tr>' +
        '<td class="mono">' + esc(a.agent) + '</td>' +
        '<td class="text-right mono" data-color="' + sc + '">' + a.avgScore.toFixed(0) + '</td>' +
        '<td class="text-right">' + a.totalTasks + '</td>' +
        '<td class="text-right mono" data-color="' + pc + '">' + (a.passRate * 100).toFixed(0) + '%</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="4"><div class="empty">No quality scores yet</div></td></tr>';
  } catch { /* silent */ }
}

async function loadModelIntelligence() {
  try {
    const r = await apiFetch('/api/model-intelligence');
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok) return;
    const el = document.getElementById('model-intelligence-content');
    const insights = d.insights || [];
    if (insights.length === 0) {
      el.innerHTML = '<div class="empty">No usage data yet — insights appear after API calls are made</div>';
      return;
    }
    el.innerHTML = insights.map(i => {
      const icon = i.type === 'cost' ? '💸' : i.type === 'summary' ? '📊' : 'ℹ️';
      const bg = i.type === 'cost' ? 'rgba(255,107,53,0.08)' : 'transparent';
      return '<div class="u-p-10-14 u-bb-1-solid-border" data-bg="' + bg + '">' +
        '<div class="u-d-flex u-gap-8 u-ai-start">' +
          '<span class="u-fs-16">' + icon + '</span>' +
          '<div>' +
            '<div class="u-fw-600 u-fs-13 u-c-text-primary">' + esc(i.title) + '</div>' +
            '<div class="u-fs-12 u-c-text-secondary u-mt-2">' + esc(i.detail) + '</div>' +
            (i.impact ? '<div class="u-fs-11 u-c-accent u-mt-4 u-fw-600">' + esc(i.impact) + '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch { /* silent */ }
}

async function loadErrorDist() {
  try {
    const r = await apiFetch('/api/error-distribution');
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok) return;
    const dist = d.distribution || {};
    const el = document.getElementById('error-dist-content');
    const entries = Object.entries(dist);
    if (entries.length === 0) {
      el.innerHTML = '<div class="empty">No categorized errors in the last 7 days</div>';
      return;
    }
    const total = entries.reduce((s, [, c]) => s + c, 0);
    el.innerHTML = entries.sort((a, b) => b[1] - a[1]).map(([cat, count]) => {
      const pct = ((count / total) * 100).toFixed(0);
      const colors = { syntax: '#FF6B35', test_failure: '#FFD60A', rate_limit: '#BF5AF2', timeout: '#5AC8FA', integration: '#34C759', context_overflow: '#FF9F0A', unknown: '#48484A' };
      const color = colors[cat] || '#48484A';
      return '<div class="u-ai-center u-m-8-0 flex gap-3">' +
        '<span class="u-minw-140 u-fs-11 mono" data-color="' + color + '">' + esc(cat) + '</span>' +
        '<div class="u-flex-1 u-h-8 u-bg-bg-tertiary u-r-radius-full u-ov-hidden">' +
          '<div class="u-h-100p" data-w="' + pct + '" data-bg="' + color + '"></div>' +
        '</div>' +
        '<span class="u-minw-40 u-ta-right u-fs-11 mono">' + count + '</span>' +
      '</div>';
    }).join('');
  } catch { /* silent */ }
}

// Per-endpoint cost dashboard (Quarter). Loads /api/cost-by-domain for a
// given window, renders a full breakdown table by (category × provider ×
// model), a provider-split strip showing the Anthropic vs Gemini cost
// distribution, and a 30-day sparkline of total daily cost.
//
// Accepts a `days` argument so the range selector buttons can re-request
// without a page reload. Also highlights the active button via the
// .btn-sm-active class.
//
// When called without arguments (e.g. from the 30-second background
// refresh timer), preserves the user's currently-selected range via the
// _activeCostRange module-level state. Without this the background timer
// would reset the view to 7d every 30 seconds, making the 1d/30d
// buttons feel broken because clicking them only worked for <30 seconds.
//
// MUST be assigned to `window` — the whole <script> is wrapped in an
// IIFE with 'use strict', so plain `function foo()` declarations stay
// private to that closure. Inline data-act="loadCostByDomain" data-args="[1]" runs
// in the global scope and looks the function up on window. Without
// this assignment the buttons are dead (silent reference error).
let _activeCostRange = 7;
window.loadCostByDomain = async function(days) {
  try {
    if (days == null) days = _activeCostRange;
    _activeCostRange = days;
    // Update button active state
    [1, 7, 30].forEach(d => {
      const btn = document.getElementById('cost-range-' + d);
      if (btn) btn.classList.toggle('btn-sm-active', d === days);
    });

    const r = await apiFetch('/api/cost-by-domain?days=' + days);
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok) return;

    const tbody = document.querySelector('#cost-by-domain-table tbody');
    const totalEl = document.getElementById('cost-by-domain-total');
    const rows = d.detailed || [];

    if (totalEl) {
      totalEl.textContent = '$' + (d.totalCost || 0).toFixed(3) + ' · ' +
        (d.totalCalls || 0) + ' calls · last ' + days + 'd';
    }

    // ── Provider split strip ─────────────────────────────────
    const splitEl = document.getElementById('cost-provider-split');
    if (splitEl) {
      const providerColors = {
        anthropic: '#D97757', openai: '#10A37F', gemini: '#4285F4', unknown: '#888',
      };
      splitEl.innerHTML = (d.providerSplit || []).map(p => {
        const color = providerColors[p.provider] || '#888';
        return '<span><span data-color="' + color + '">●</span> ' +
          esc(p.provider) + ' <strong>$' + (p.cost || 0).toFixed(3) + '</strong>' +
          ' <span class="text-tertiary">(' + (p.percentOfCost || 0).toFixed(1) + '%)</span>' +
          '</span>';
      }).join('');
    }

    const pricingEl = document.getElementById('cost-pricing-status');
    if (pricingEl) {
      const statuses = d.pricingStatus || [];
      const unresolved = statuses.find(p => p.pricingStatus === 'unresolved');
      const legacy = statuses.find(p => p.pricingStatus === 'legacy');
      const unresolvedSpend = unresolved ? unresolved.unresolvedSpendUsd || 0 : 0;
      const legacyRows = legacy ? legacy.rows || 0 : 0;
      pricingEl.textContent = unresolvedSpend > 0
        ? 'unresolved pricing $' + unresolvedSpend.toFixed(4)
        : (legacyRows > 0 ? 'legacy pricing rows ' + legacyRows : 'pricing resolved');
    }

    // ── Sparkline ─────────────────────────────────────────────
    const canvas = document.getElementById('cost-sparkline');
    if (canvas && d.dailySeries && d.dailySeries.length > 0) {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const series = d.dailySeries;
      const maxCost = Math.max(...series.map(p => p.cost || 0), 0.0001);
      ctx.strokeStyle = 'rgba(217, 119, 87, 0.9)'; // anthropic orange
      ctx.fillStyle = 'rgba(217, 119, 87, 0.15)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      series.forEach((p, i) => {
        const x = (i / Math.max(series.length - 1, 1)) * (W - 2) + 1;
        const y = H - (((p.cost || 0) / maxCost) * (H - 4)) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // Fill under the line
      ctx.lineTo(W - 1, H);
      ctx.lineTo(1, H);
      ctx.closePath();
      ctx.fill();
    }

    // ── Detailed table ────────────────────────────────────────
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty">No AI usage in the last ' + days + ' days</div></td></tr>';
      return;
    }

    const skillIcons = {
      secretary: '📋', triathlon: '🏊', content: '🎬', finance: '💰', cooking: '👨‍🍳',
      classify: '🧭', chat: '💬', coach: '🏋️', knowledge: '🧠', unknown: '❔',
    };
    const providerColors = {
      anthropic: '#D97757', openai: '#10A37F', gemini: '#4285F4', unknown: '#888',
    };

    // Find max cost for the inline bar
    const maxCost = Math.max(...rows.map(r => r.cost || 0), 0.0001);

    // Shorten verbose model names for display
    function shortModel(m) {
      if (!m) return '—';
      return m
        .replace('claude-', '')
        .replace('-20251001', '')
        .replace('-20260101', '')
        .replace('gemini-', 'g-');
    }

    // Match icon against a category like "domain_secretary" → "secretary"
    function categoryIcon(cat) {
      const lowered = (cat || '').toLowerCase();
      for (const key of Object.keys(skillIcons)) {
        if (lowered.includes(key)) return skillIcons[key];
      }
      return '⚙️';
    }

    tbody.innerHTML = rows.map(r => {
      const icon = categoryIcon(r.category);
      const pColor = providerColors[r.provider] || '#888';
      const barPct = ((r.cost || 0) / maxCost * 100).toFixed(0);
      const costFmt = '$' + (r.cost || 0).toFixed(r.cost >= 0.01 ? 3 : 4);
      const perCallFmt = '$' + (r.costPerCall || 0).toFixed(r.costPerCall >= 0.01 ? 3 : 4);
      const avgMs = Math.round(r.avgDurationMs || 0).toLocaleString();
      const p95Ms = Math.round(r.p95DurationMs || 0).toLocaleString();
      // Warn color if p95 is > 2× avg (wide distribution, long tail)
      const p95Color = (r.p95DurationMs > r.avgDurationMs * 2)
        ? 'var(--warning, #f59e0b)'
        : '';
      return '<tr>' +
        '<td><span class="u-mr-6">' + icon + '</span>' +
          '<span class="u-fs-11 mono">' + esc(r.category) + '</span>' +
        '</td>' +
        '<td><span class="u-fs-11 mono" data-color="' + pColor + '">● ' + esc(r.provider) + '</span></td>' +
        '<td><span class="u-fs-10 u-c-text-tertiary mono">' + esc(shortModel(r.model)) + '</span></td>' +
        '<td class="u-fs-11 text-right mono">' + (r.calls || 0).toLocaleString() + '</td>' +
        '<td class="u-fs-11 text-right mono">' + perCallFmt + '</td>' +
        '<td class="u-fs-11 text-right mono">' + Math.round(r.tokens || 0).toLocaleString() + '</td>' +
        '<td class="u-fs-11 text-right mono">' + avgMs + '</td>' +
        '<td class="u-fs-11 text-right mono" data-color="' + p95Color + '">' + p95Ms + '</td>' +
        '<td class="u-pos-relative text-right mono">' +
          '<div class="cost-share-bar" data-w="' + barPct + '"></div>' +
          '<span class="u-pos-relative u-z-1 u-fw-600">' + costFmt + '</span>' +
        '</td>' +
      '</tr>';
    }).join('');
  } catch { /* silent */ }
};

// AI KPI tiles come from the shared snapshot poll.
P.on('snapshot', (snap) => {
  const usage = snap.apiUsage || {};
  if (usage.today) {
    document.getElementById('ai-calls-today').textContent = fmtNum(usage.today.calls);
    document.getElementById('ai-tokens-today').textContent = fmtNum(usage.today.tokens) + ' tokens';
  }
  if (usage.last7d) {
    document.getElementById('ai-calls-week').textContent = fmtNum(usage.last7d.calls);
    document.getElementById('ai-cost-week').textContent = fmtCost(usage.last7d.cost);
  }
  if (usage.last30d) {
    document.getElementById('ai-calls-month').textContent = fmtNum(usage.last30d.calls);
    document.getElementById('ai-cost-month').textContent = fmtCost(usage.last30d.cost);
  }
});
// Provider health also feeds the dashboard card, so it follows the snapshot
// poll whenever either section is on screen.
P.on('poll', () => {
  const section = P.getCurrentSection();
  if (section === 'dashboard' || section === 'ai') loadProviderHealth();
});

function refreshAiPanels() {
  loadModelConfig();
  loadDomainRouting();
  loadSecretaryOptimization();
  loadQualityScores();
  loadErrorDist();
  loadModelIntelligence();
  loadCostByDomain();
}
let aiTimer = null;
P.on('app:start', () => {
  loadProviderHealth();
  refreshAiPanels();
  if (!aiTimer) aiTimer = setInterval(() => {
    if (document.hidden || P.getCurrentSection() !== 'ai') return;
    refreshAiPanels();
    loadProviderHealth();
  }, 30000);
});

P.registerSection('ai', {
  mount() {},
  onShow() { loadAiPlanLimits(); refreshAiPanels(); loadProviderHealth(); },
});
