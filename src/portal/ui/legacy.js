// Nexus Hub admin portal — legacy SPA script (classic, non-module).
// Extracted from the inline <script> in portal.html so the dashboard CSP can
// drop 'unsafe-inline' for scripts. Sections migrate from here to ES modules
// under src/portal/ui/*.js one at a time.
'use strict';
(function() {
  // ════════════════════════════════════════════════════════════
  // Auth: per-tab in-memory token ONLY.
  //
  // Security hardening (v4.14):
  //   ✘ NO localStorage persistence (prevents XSS → admin escalation)
  //   ✘ NO URL ?token= support (prevents referer/log leakage)
  //   ✘ NO server-side injection into HTML
  //   ✓ Token lives only in JS memory for the current tab
  //   ✓ Closing the tab = instant session end
  //   ✓ 401 → prompt re-auth, no stale tokens
  //
  // Future: replace with server-side session + HTTP-only cookie.
  // ════════════════════════════════════════════════════════════

  // Clean up any legacy localStorage token from older versions
  try { localStorage.removeItem('portal_token'); } catch {}
  // Strip any ?token= from URL to prevent leakage
  if (new URLSearchParams(location.search).has('token')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  let TOKEN = '';  // In-memory only — dies with the tab
  // Cookie session (Phase 5): when PORTAL_SESSION_SECRET is configured the
  // server mints an HttpOnly portal_session cookie and hands back a CSRF
  // proof. The cookie survives reloads; the proof lives here and is sent as
  // x-portal-csrf on every mutating request. Without a session secret the
  // in-memory bearer flow above stays in force.
  let SESSION = null;  // { scope, actor, expiresAt, csrf }

  // ────────── Login flow ──────────
  function showLoginForm() {
    const overlay = document.getElementById('login-overlay');
    overlay.style.display = 'flex';
    setTimeout(() => document.getElementById('login-token').focus(), 50);
  }
  function hideLoginForm() {
    document.getElementById('login-overlay').style.display = 'none';
  }
  async function doLogin() {
    const input = document.getElementById('login-token');
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');
    const t = input.value.trim();
    if (!t) return;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    errEl.textContent = '';
    try {
      const sessionRes = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
      if (sessionRes.ok) {
        SESSION = await sessionRes.json();
        TOKEN = '';
        input.value = '';
        hideLoginForm();
        startApp();
        return;
      }
      if (sessionRes.status === 429) {
        errEl.textContent = 'Too many attempts, wait a minute';
        btn.disabled = false;
        btn.textContent = 'Sign In';
        return;
      }
      // 503 (sessions not configured) or a token the session route does not
      // accept: fall back to the bearer probe that predates cookie sessions.
      const res = await fetch('/api/snapshot', { headers: { Authorization: 'Bearer ' + t } });
      if (res.ok) {
        TOKEN = t;  // In-memory only — no localStorage
        input.value = '';  // Clear the input immediately
        hideLoginForm();
        startApp();
      } else {
        errEl.textContent = 'Invalid token';
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
    } catch {
      errEl.textContent = 'Network error';
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('logout-link').addEventListener('click', async () => {
    TOKEN = '';
    if (SESSION) {
      try {
        await fetch('/api/auth/session/logout', { method: 'POST', headers: { 'x-portal-csrf': SESSION.csrf || '' } });
      } catch (_) {
        // the cookie expires on its own; reload regardless
      }
      SESSION = null;
    }
    location.reload();
  });

  // ────────── Tenant scope (added 2026-05-04 — content-creation-ui slice) ──
  //
  // The Content Creation V1 admin routes (/api/v1/admin/content/links,
  // /voice-dna upsert, /pillars when scoped) require an explicit
  // user/tenant scope via x-nexus-user-id / x-nexus-tenant-id headers OR
  // body fields. Before this slice the portal SPA sent NO scope at all,
  // which silently caused scoped writes to be rejected.
  //
  // We persist the active scope to localStorage so it survives reloads,
  // expose it as a top-of-Content-section input, and make `apiFetch`
  // automatically attach the scope headers ONLY when the URL is a
  // scoped content or notification route (so legacy /api/* paths keep
  // their old behavior). Operators can clear the scope by leaving the
  // inputs empty.
  const SCOPE_STORAGE_KEY = 'nexus-portal-content-scope-v1';

  function loadStoredScope() {
    try {
      const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
      if (!raw) return { userId: '', tenantId: '' };
      const parsed = JSON.parse(raw);
      return { userId: parsed.userId || '', tenantId: parsed.tenantId || '' };
    } catch (_) { return { userId: '', tenantId: '' }; }
  }
  function persistScope(scope) {
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({
        userId: scope.userId || '', tenantId: scope.tenantId || ''
      }));
    } catch (_) {}
  }
  let CONTENT_SCOPE = loadStoredScope();

  function isContentScopedRoute(url) {
    if (typeof url !== 'string') return false;
    return url === '/api/v1/admin/content'
      || url.startsWith('/api/v1/admin/content/')
      || url.startsWith('/api/v1/admin/content?');
  }
  function isNotificationScopedRoute(url) {
    return typeof url === 'string'
      && (
        url.includes('/api/notifications')
        || url.includes('/api/notification-preferences')
      );
  }

  // ────────── Fetch wrapper with auth ──────────
  async function apiFetch(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const method = String(opts.method || 'GET').toUpperCase();
    if (!TOKEN && SESSION && SESSION.csrf && method !== 'GET' && method !== 'HEAD') headers['x-portal-csrf'] = SESSION.csrf;
    if (isContentScopedRoute(url) || isNotificationScopedRoute(url)) {
      if (CONTENT_SCOPE.userId) headers['x-nexus-user-id'] = String(CONTENT_SCOPE.userId);
      if (CONTENT_SCOPE.tenantId) headers['x-nexus-tenant-id'] = String(CONTENT_SCOPE.tenantId);
    }
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
      TOKEN = '';
      SESSION = null;
      showLoginForm();
      throw new Error('Unauthorized');
    }
    return res;
  }

  async function responseErrorMessage(res) {
    try {
      const body = await res.json();
      return body?.error?.message || body?.message || body?.error || ('HTTP ' + res.status);
    } catch (_) {
      return 'HTTP ' + res.status;
    }
  }

  async function apiJson(url, opts = {}) {
    const res = await apiFetch(url, opts);
    if (!res.ok) throw new Error(await responseErrorMessage(res));
    return res.json();
  }

  // ────────── Bridge for ES-module sections (/portal/ui/*.js) ──────────
  // Modules register {mount, onShow, onHide}; the router activates them.
  window.NexusPortal = {
    apiFetch, apiJson,
    esc: (s) => esc(s),
    shortDateTime: (iso) => shortDateTime(iso),
    relativeTime: (iso) => relativeTime(iso),
    navigateTo: (section) => navigateTo(section),
    getToken: () => TOKEN,
    getSession: () => SESSION,
    setCardError: (id, title, err) => setCardError(id, title, err),
    setTableError: (tbodyId, colspan, title, err) => setTableError(tbodyId, colspan, title, err),
    showToast: (msg, ok) => showToast(msg, ok),
    adminLoadErrorMessage: (err) => adminLoadErrorMessage(err),
    fmtNum: (n) => fmtNum(n),
    getContentScope: () => ({ userId: CONTENT_SCOPE.userId, tenantId: CONTENT_SCOPE.tenantId }),
    sections: Object.create(null),
    registerSection(id, def) {
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) return;
      this.sections[id] = Object.assign({ mounted: false }, def);
    },
    activateSection(id) {
      const s = Object.prototype.hasOwnProperty.call(this.sections, id) ? this.sections[id] : undefined;
      if (!s) return;
      if (!s.mounted) {
        const container = document.querySelector('[data-section="' + id + '"]');
        if (!container) return;
        s.mount(container);
        s.mounted = true;
      }
      if (s.onShow) s.onShow();
    },
    deactivateSections(except) {
      Object.keys(this.sections).forEach((id) => {
        const s = this.sections[id];
        if (id !== except && s.mounted && s.onHide) s.onHide();
      });
    },
  };

  function adminLoadErrorMessage(err) {
    const raw = err && err.message ? err.message : String(err || 'Request failed');
    if (raw === 'Unauthorized' || /token|session|unauthorized/i.test(raw)) {
      return 'This section needs the current admin-capable portal credential. Sign out and sign in with the current PORTAL_ADMIN_TOKEN or operator token.';
    }
    return raw;
  }

  function cardErrorHtml(title, err) {
    return '<div class="empty" style="text-align:left;max-width:620px;margin:0 auto">' +
      '<div style="font-weight:700;color:var(--error);margin-bottom:6px">' + esc(title) + '</div>' +
      '<div class="text-muted">' + esc(adminLoadErrorMessage(err)) + '</div>' +
    '</div>';
  }

  function setCardError(id, title, err) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = cardErrorHtml(title, err);
  }

  function setTableError(tbodyId, colspan, title, err) {
    const el = document.getElementById(tbodyId);
    if (el) el.innerHTML = '<tr><td colspan="' + colspan + '">' + cardErrorHtml(title, err) + '</td></tr>';
  }

  // ────────── HTML escape ──────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // ────────── Time helpers ──────────
  function shortTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function shortDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return shortTime(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + shortTime(iso);
  }
  function relativeTime(iso) {
    if (!iso) return '—';
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtCost(n) {
    if (n == null || isNaN(n)) return '$—';
    if (n >= 100) return '$' + n.toFixed(0);
    if (n >= 10) return '$' + n.toFixed(1);
    return '$' + n.toFixed(2);
  }

  // ────────── Toast ──────────
  function showToast(msg, ok = true) {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast ' + (ok === true || ok === 'ok' ? 'ok' : ok === 'warn' ? 'warn' : ok === 'info' ? 'info' : 'err');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 250);
    }, 3000);
  }

  // ════════════════════════════════════════════════════════════
  // Navigation — hash routing between sections
  // ════════════════════════════════════════════════════════════
  const SECTIONS = ['dashboard', 'alerts', 'users', 'ai', 'jobs', 'skills', 'content', 'cooking', 'notifications', 'settings', 'invites', 'founders', 'waitlist', 'audit', 'logs', 'requests', 'issues', 'support'];
  let currentSection = 'dashboard';

  function navigateTo(section) {
    if (!SECTIONS.includes(section)) section = 'dashboard';
    currentSection = section;
    if (section === 'jobs') loadJobControl();
    SECTIONS.forEach(s => {
      const sec = document.querySelector('[data-section="' + s + '"]');
      const nav = document.querySelector('[data-nav="' + s + '"]');
      if (sec) sec.classList.toggle('active', s === section);
      if (nav) nav.classList.toggle('active', s === section);
    });
    if (location.hash !== '#' + section) {
      history.replaceState(null, '', '#' + section);
    }
    // On-demand section loaders
    if (section === 'users') loadUsers();
    if (section === 'jobs') loadQuickActions();
    if (section === 'skills') loadSkillsUserSelector();
    if (section === 'ai') loadAiPlanLimits();
    if (section === 'content') loadContentDashboard();
    if (section === 'cooking') renderCookingPortal();
    // Module-backed sections (src/portal/ui/*.js)
    window.NexusPortal.deactivateSections(section);
    window.NexusPortal.activateSection(section);
  }

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(el.dataset.nav);
    });
  });
  document.querySelectorAll('[data-jump-to]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(el.dataset.jumpTo);
    });
  });

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
        '<td><input class="input mono" style="max-width:110px" type="number" min="0" step="0.001" id="plan-daily-' + esc(id) + '" value="' + Number(plan.dailyCostUsd || 0) + '"' + (fixedZero ? ' disabled title="Paid-only invariant"' : '') + '></td>' +
        '<td><input class="input mono" style="max-width:110px" type="number" min="0" step="0.01" id="plan-monthly-' + esc(id) + '" value="' + Number(plan.monthlyCostUsd || 0) + '"' + (fixedZero ? ' disabled title="Paid-only invariant"' : '') + '></td>' +
        '<td class="mono">$' + backgroundDaily.toFixed(3) + '/day · $' + backgroundMonthly.toFixed(2) + '/month</td>' +
        '<td class="text-muted" style="font-size:11px">' + tokenLabel + '<br>' + messageLabel + ' (telemetry)</td>' +
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
  window.addEventListener('hashchange', () => {
    const section = location.hash.replace('#', '') || 'dashboard';
    navigateTo(section);
  });

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    pollAll();
    showToast('Refreshing…', 'info');
  });

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
    } catch (err) { /* silent */ }
  }

  async function pollUsageSummary() {
    try {
      const r = await apiFetch('/api/usage/summary');
      if (!r.ok) return;
      const d = await r.json();
      renderUsageSummary(d);
    } catch (err) { /* silent */ }
  }

  function renderSnapshot(snap) {
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

    // AI section KPIs
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

    // Dashboard: recent activity
    renderActivity(snap.recentEvents || []);

    // Dashboard: integrations summary
    renderDashIntegrations(snap.integrations || []);

    // Skills section: domain status
    renderDomainStatus(snap.domainStatus || []);

    // Skills section: skill modules
    // Skills grid: if a per-user scope is active, keep THAT view and let
    // loadUserSkills drive the render. The background snapshot poller
    // would otherwise reset the grid to the global view every 15 seconds.
    if (_skillsScopeUserId == null) {
      renderSkillsGrid(snap.skillStatus || []);
    } else {
      loadUserSkills(_skillsScopeUserId);
    }

    // Jobs section: scheduled runs + history
    renderNextRuns(snap.nextRuns || []);
    renderJobsList(snap.jobs || [], snap.jobHistory || {});
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
      return '<div class="flex-between" style="padding:var(--space-2) var(--space-1);border-bottom:1px solid var(--border)">' +
        '<div class="flex gap-2" style="align-items:center">' +
          '<span class="status-dot ' + dot + '"></span>' +
          '<span style="font-size:12px">' + esc(i.name) + '</span>' +
        '</div>' +
        '<span class="text-tertiary mono" style="font-size:10px">' + esc(sub) + '</span>' +
        '</div>';
    }).join('');
  }

  // Operator Alerts moved to ui/alerts.js (Phase 5 section extraction).

  function renderDomainStatus(domains) {
    const el = document.getElementById('domain-status-content');
    if (!domains || domains.length === 0) {
      el.innerHTML = '<div class="empty">No domain data</div>';
      return;
    }
    el.innerHTML = '<div class="grid grid-cols-auto" style="gap:var(--space-3)">' + domains.map(d => {
      const dot = d.active ? 'online' : 'offline';
      return '<div class="provider-card">' +
        '<div class="provider-card-header">' +
          '<div class="provider-name"><span class="status-dot ' + dot + '" style="margin-right:8px"></span>' + esc(d.label || d.domain) + '</div>' +
          '<span class="domain-tag domain-' + esc(d.domain) + '">' + esc(d.domain) + '</span>' +
        '</div>' +
        '<div class="provider-stats">' +
          '<div>Today: <b>' + (d.messagesToday || 0) + '</b></div>' +
          '<div>Total: <b>' + (d.totalMessages || 0) + '</b></div>' +
          '<div style="grid-column:span 2">Last: <b>' + (d.lastMessageAt ? relativeTime(d.lastMessageAt) : '—') + '</b></div>' +
        '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  // Skills scope state. When _skillsScopeUserId is null we're in global
  // mode (the historical behavior) and toggles go to /api/skills/toggle.
  // When it's a user id, we render the per-user override view and
  // toggles go to /api/users/:id/skills (which layers on top of the
  // global state). The scope is switched via the dropdown above the grid.
  let _skillsScopeUserId = null;

  function renderSkillsGrid(skills) {
    const el = document.getElementById('skills-grid');
    if (!skills || skills.length === 0) {
      el.innerHTML = '<div class="empty">No skills loaded</div>';
      return;
    }

    // Normalize shape so we can reuse the renderer for both:
    //   global  (from /api/snapshot.skillStatus)  — fields: name, subSkills[].name, subSkills[].description, subSkills[].toolCount
    //   per-user (from /api/users/:id/skills)     — fields: skill, subSkills[].id, subSkills[].label, no toolCount
    const normalized = skills.map(s => ({
      key: s.name || s.skill,
      label: s.label || s.name || s.skill,
      description: s.description || '',
      enabled: s.enabled,
      source: s.source || 'default',
      subSkills: (s.subSkills || []).map(sub => ({
        key: sub.name || sub.id,
        label: sub.description || sub.label || sub.name || sub.id,
        enabled: sub.enabled,
        source: sub.source || 'default',
        toolCount: sub.toolCount,
      })),
    }));

    el.innerHTML = normalized.map(s => {
      const subs = s.subSkills.map(sub => {
        const onChange = 'data-on="change" data-act="onSkillToggle" data-args="[&quot;' + esc(s.key) + '&quot;,&quot;' + esc(sub.key) + '&quot;,&quot;$checked&quot;]"';
        const overrideBadge = sub.source === 'override'
          ? '<span class="badge badge-accent" style="font-size:9px;margin-left:4px">override</span>'
          : '';
        const toolCount = sub.toolCount != null
          ? '<span class="text-tertiary mono" style="margin-left:auto;font-size:10px">' + sub.toolCount + ' tools</span>'
          : '';
        return '<div class="sub-skill">' +
          '<label class="toggle">' +
            '<input type="checkbox" ' + (sub.enabled ? 'checked' : '') + ' ' + onChange + '>' +
            '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
          '</label>' +
          '<span class="toggle-label">' + esc(sub.label) + '</span>' +
          overrideBadge +
          toolCount +
        '</div>';
      }).join('');
      const masterChange = 'data-on="change" data-act="onSkillToggle" data-args="[&quot;' + esc(s.key) + '&quot;,null,&quot;$checked&quot;]"';
      const masterBadge = s.source === 'override'
        ? '<span class="badge badge-accent" style="font-size:9px;margin-left:4px">override</span>'
        : '';
      return '<div class="skill-card">' +
        '<div class="skill-header">' +
          '<span class="skill-icon">🧩</span>' +
          '<span class="skill-name">' + esc(s.label) + '</span>' +
          masterBadge +
          '<label class="toggle">' +
            '<input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' ' + masterChange + '>' +
            '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
          '</label>' +
        '</div>' +
        '<div class="text-muted" style="font-size:11px;margin-bottom:8px">' + esc(s.description) + '</div>' +
        subs +
        '</div>';
    }).join('');
  }

  // Populate the user selector dropdown with registered users (from
  // /api/users). Called when the Skills section becomes visible.
  async function loadSkillsUserSelector() {
    try {
      if (!allUsers || allUsers.length === 0) {
        const r = await apiFetch('/api/users');
        if (r.ok) {
          const d = await r.json();
          allUsers = d.users || [];
        }
      }
      const sel = document.getElementById('skills-user-select');
      if (!sel) return;
      // Keep the "Global" option at index 0 and append users after it
      const currentValue = sel.value;
      sel.innerHTML = '<option value="global">🌐 Global (affects all users)</option>' +
        allUsers.map(u => {
          const label = [u.first_name || '', u.last_name || ''].filter(Boolean).join(' ').trim()
            || u.username
            || ('#' + u.id);
          return '<option value="' + esc(String(u.id)) + '">👤 ' + esc(label) + ' (' + esc(String(u.id)) + ')</option>';
        }).join('');
      // Restore the previously-selected value across reloads
      if (currentValue && sel.querySelector('option[value="' + currentValue + '"]')) {
        sel.value = currentValue;
      }
    } catch { /* silent — Skills page still works with just Global */ }
  }

  // Wired to the dropdown onchange. Switches the scope state and
  // re-renders the grid from the appropriate data source.
  window.onSkillsUserChange = function(sel) {
    const val = sel.value;
    const resetBtn = document.getElementById('skills-reset-user');
    const hint = document.getElementById('skills-scope-hint');
    const subtitle = document.getElementById('skills-subtitle');

    if (val === 'global') {
      _skillsScopeUserId = null;
      if (resetBtn) resetBtn.style.display = 'none';
      if (hint) hint.textContent = 'Toggles here affect ALL users. Pick a user to set per-user overrides.';
      if (subtitle) subtitle.textContent = 'Skill packages and sub-skill toggles';
      // The snapshot poller picks up skillStatus, so we just force a
      // fresh render from the cached snapshot. If the cache is empty
      // we re-fetch the snapshot directly.
      pollAll();
    } else {
      _skillsScopeUserId = parseInt(val, 10);
      if (resetBtn) resetBtn.style.display = '';
      if (hint) hint.textContent = 'Showing per-user overrides. Toggles affect ONLY this user.';
      if (subtitle) subtitle.textContent = 'Per-user skill overrides — user ID ' + _skillsScopeUserId;
      loadUserSkills(_skillsScopeUserId);
    }
  };

  async function loadUserSkills(userId) {
    try {
      const r = await apiFetch('/api/users/' + userId + '/skills');
      if (!r.ok) return;
      const d = await r.json();
      renderSkillsGrid(d.skills || []);
    } catch { /* silent */ }
  }

  window.resetSelectedUserSkills = async function() {
    if (!_skillsScopeUserId) return;
    if (!confirm('Reset all skill overrides for user ' + _skillsScopeUserId + '?\n\nThis reverts every skill and sub-skill back to the global default for this user.')) return;
    try {
      const r = await apiFetch('/api/users/' + _skillsScopeUserId + '/skills/reset', { method: 'POST' });
      if (r.ok) {
        showToast('User overrides reset');
        loadUserSkills(_skillsScopeUserId);
      }
    } catch { showToast('Reset failed', false); }
  };

  // Dispatcher called by both master-skill and sub-skill checkboxes in the
  // rendered grid. Routes to the right backend endpoint based on scope.
  //
  //   subSkill = null  → master-skill toggle
  //   subSkill ≠ null  → sub-skill toggle
  window.onSkillToggle = async function(skill, subSkill, enabled) {
    try {
      if (_skillsScopeUserId) {
        // Per-user override
        const r = await apiFetch('/api/users/' + _skillsScopeUserId + '/skills', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skill, subSkill: subSkill || undefined, enabled }),
        });
        if (r.ok) {
          showToast(skill + (subSkill ? ':' + subSkill : '') + (enabled ? ' enabled' : ' disabled') + ' for user');
          loadUserSkills(_skillsScopeUserId);
        } else {
          showToast('Toggle failed', false);
        }
      } else {
        // Global toggle — keep historical endpoint shapes
        if (subSkill) {
          const r = await apiFetch('/api/skills/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain: skill, subSkill, enabled }),
          });
          const d = await r.json();
          if (d.ok) showToast(skill + ':' + subSkill + (enabled ? ' enabled' : ' disabled'));
          else showToast('Toggle failed', false);
        } else {
          const ep = '/api/skills/' + encodeURIComponent(skill) + (enabled ? '/enable' : '/disable');
          const r = await apiFetch(ep, { method: 'POST' });
          if (r.ok) showToast(skill + (enabled ? ' enabled' : ' disabled'));
          else showToast('Toggle failed', false);
        }
      }
    } catch { showToast('Toggle failed', false); }
  };

  function renderNextRuns(nextRuns) {
    const tbody = document.querySelector('#next-runs-table tbody');
    if (!nextRuns || nextRuns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty">No upcoming jobs</div></td></tr>';
      return;
    }
    tbody.innerHTML = nextRuns.slice(0, 12).map(r => '<tr>' +
      '<td>' + esc(r.label) + '</td>' +
      '<td><code class="mono" style="font-size:10px">' + esc(r.cronExpression) + '</code></td>' +
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
    el.innerHTML = '<div style="overflow-x:auto"><table class="data-table dense"><thead><tr><th>Job</th><th>Cron</th><th>Next run</th><th>Last</th><th class="text-right">24h</th><th>Governance</th><th></th></tr></thead><tbody>' +
      jobs.map(j => {
        const paused = j.lifecycle === 'paused';
        const state = j.running ? 'running' : paused ? 'paused' : !j.enabled ? 'disabled' : (j.lastResult || 'never');
        const cls = state === 'success' ? 'success' : state === 'failed' ? 'error' : state === 'running' ? 'info' : state === 'paused' || state === 'disabled' ? 'warning' : 'neutral';
        const denied = j.manual.policy === 'deny';
        const disabled = denied || j.running || !j.runnerAvailable || j.cooldownRemainingMs > 0;
        const title = denied ? (j.manual.reason || 'manual run denied') : j.running ? 'already running' : !j.runnerAvailable ? 'runner unavailable in this process' : j.cooldownRemainingMs > 0 ? 'cooldown active' : j.manual.policy === 'confirm' ? 'asks for confirmation: ' + j.manual.reason : 'run now';
        const gov = j.governance ? '<span class="text-muted">' + esc(j.governance.policyOwner) + '</span> · <span class="mono" title="provider usage">' + esc(j.governance.providerUsage === 'none' ? 'no provider' : 'provider-capable') + '</span>' : '<span class="text-muted">not in manifest</span>';
        return '<tr>' +
          '<td><span class="domain-tag domain-' + esc(j.domain || 'system') + '">' + esc(j.domain || 'sys') + '</span> ' + esc(j.label || j.name) + '<div class="mono text-muted" style="font-size:11px">' + esc(j.name) + '</div></td>' +
          '<td class="mono">' + esc(j.cronExpression || '—') + '</td>' +
          '<td class="text-muted">' + (j.nextRunAt ? esc(relativeTime(j.nextRunAt)) : '—') + '</td>' +
          '<td><span class="badge badge-' + cls + '">' + esc(state) + '</span> <span class="text-muted">' + (j.lastRunAt ? esc(relativeTime(j.lastRunAt)) : '') + '</span>' + (j.lastError ? '<div class="mono text-muted" style="font-size:11px" title="' + esc(j.lastError) + '">' + esc(String(j.lastError).slice(0, 60)) + '</div>' : '') + '</td>' +
          '<td class="text-right mono">' + j.stats24h.runs + (j.stats24h.failed ? ' <span class="badge badge-error">' + j.stats24h.failed + ' failed</span>' : '') + '</td>' +
          '<td>' + gov + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-jobctl="run" data-job="' + esc(j.name) + '" title="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>' + (j.manual.policy === 'confirm' ? 'Run…' : 'Run') + '</button> ' +
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
    box.style.display = 'block';
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
      if (close) close.addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; });
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
    document.getElementById('slideout-suspend-btn').style.display = user.status === 'active' && user.tier !== 'owner' ? '' : 'none';
    document.getElementById('slideout-activate-btn').style.display = user.status !== 'active' ? '' : 'none';

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
          return '<div class="sub-skill" style="opacity:' + (s.enabled ? 1 : 0.4) + '">' +
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
          (oauthBadge ? '<div style="margin-bottom:8px">' + oauthBadge + '</div>' : '') +
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
      ].map(([k, v]) => '<div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<span class="text-muted" style="font-size:12px">' + k + '</span>' +
        '<span class="mono" style="font-size:12px">' + (v ?? 0) + '</span>' +
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
        '<div style="padding:7px 0;border-bottom:1px solid var(--border)">' +
          '<div class="flex-between"><span class="text-muted" style="font-size:12px">' + esc(label) + '</span>' +
          '<span class="mono" style="font-size:11px">$' + Number(used || 0).toFixed(4) + ' / $' + Number(cap || 0).toFixed(2) + '</span></div>' +
          '<div class="progress" style="margin:5px 0 3px"><div class="progress-fill" style="width:' + budgetPct(fraction) + '%"></div></div>' +
          '<div class="text-muted" style="font-size:10px">' + budgetPct(fraction) + '% · resets ' + esc(resetAt || '—') + '</div>' +
        '</div>';
      const deferrals = (budget.recentDeferrals || []).slice(0, 5).map(item =>
        '<div class="flex-between" style="padding:5px 0;border-bottom:1px solid var(--border)">' +
          '<span style="font-size:11px">' + esc(item.jobName || item.baseCategory || item.requestSource || 'AI work') + '</span>' +
          '<span class="badge badge-neutral" title="' + esc(item.createdAt || '') + '">' + esc(item.code || 'deferred') + '</span>' +
        '</div>'
      ).join('') || '<div class="text-muted" style="font-size:11px">No recorded deferrals.</div>';
      const budgetPanel = '<div class="card-title" style="margin-bottom:var(--space-3)">AI budget and entitlement</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
          '<span class="badge badge-neutral">Effective plan: ' + esc(budgetEntitlement.plan || 'free') + '</span>' +
          '<span class="badge badge-' + (budgetEntitlement.aiAccessAllowed ? 'success' : 'error') + '">' +
            (budgetEntitlement.aiAccessAllowed ? 'Interactive AI enabled' : 'AI blocked') + '</span>' +
          '<span class="badge badge-' + (budgetEntitlement.automationAllowed ? 'success' : 'neutral') + '">' +
            (budgetEntitlement.automationAllowed ? 'Automations enabled' : 'Automations disabled') + '</span>' +
          '<span class="badge badge-neutral">' + esc(budgetEntitlement.source || 'unknown') + ':' + esc(budgetEntitlement.status || 'none') + '</span>' +
        '</div>' +
        (budgetEntitlement.blockReason ? '<div class="text-muted" style="font-size:11px;margin-bottom:8px">Block reason: <code>' + esc(budgetEntitlement.blockReason) + '</code></div>' : '') +
        budgetRow('Daily included', budgetUsage.dailyCostUsd, effectiveBudget.dailyCostUsd, budgetUsage.dailyFraction, budgetResets.dailyAt) +
        budgetRow('Monthly included', budgetUsage.monthlyCostUsd, effectiveBudget.monthlyCostUsd, budgetUsage.monthlyFraction, budgetResets.monthlyAt) +
        budgetRow('Automation · daily', budgetUsage.automationDailyCostUsd, effectiveBudget.automationDailyCostUsd, budgetUsage.automationDailyFraction, budgetResets.dailyAt) +
        budgetRow('Automation · monthly', budgetUsage.automationMonthlyCostUsd, effectiveBudget.automationMonthlyCostUsd, budgetUsage.automationMonthlyFraction, budgetResets.monthlyAt) +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0 8px">' +
          '<label class="text-muted" style="font-size:11px">Daily override USD<input id="slideout-ai-daily" class="input" type="number" min="0" step="0.001" value="' + esc(budgetOverride.dailyCostUsd ?? '') + '" placeholder="Plan default"></label>' +
          '<label class="text-muted" style="font-size:11px">Monthly override USD<input id="slideout-ai-monthly" class="input" type="number" min="0" step="0.01" value="' + esc(budgetOverride.monthlyCostUsd ?? '') + '" placeholder="Plan default"></label>' +
        '</div>' +
        '<input id="slideout-ai-reason" class="input" maxlength="280" value="' + esc(budgetOverride.reason || '') + '" placeholder="Audit reason" style="margin-bottom:8px">' +
        '<button class="btn btn-sm" data-act="saveUserAiBudget" data-args="[' + user.id + ']" style="width:100%;margin-bottom:10px">Save AI overrides</button>' +
        '<div class="card-subtitle" style="font-size:11px;margin-bottom:4px">Recent skip reasons</div>' + deferrals +
        '<div style="margin-bottom:var(--space-5)"></div>';
      const pointsPanel = '<div class="card-title" style="margin-bottom:var(--space-3)">Nexus Points checkout</div>' +
        '<div style="display:grid;gap:var(--space-2);margin-bottom:var(--space-5)">' +
          '<select id="slideout-points-package" class="input" ' + (pointsCheckoutEnabled ? '' : 'disabled') + '>' + pointOptions + '</select>' +
          '<textarea id="slideout-points-note" class="input" rows="2" maxlength="280" placeholder="Required support note" ' + (pointsCheckoutEnabled ? '' : 'disabled') + '></textarea>' +
          '<button class="btn btn-sm" data-act="createPortalNexusPointsCheckout" data-args="[' + user.id + ']" ' + (pointsCheckoutEnabled ? '' : 'disabled') + '>Create Stripe checkout URL</button>' +
          '<div id="slideout-points-result" class="text-muted" style="font-size:12px">' +
            (!budgetEntitlement.nexusPointsAllowed ? 'Available only for active paid/founder entitlements.' : '') + '</div>' +
        '</div>';

      body.innerHTML =
        '<div style="display:flex;gap:var(--space-3);margin-bottom:var(--space-5)">' +
          tier +
          '<span class="badge badge-' + (user.status === 'active' ? 'success' : 'error') + '">' + esc(user.status) + '</span>' +
          '<span class="badge badge-neutral mono">' + limit + '</span>' +
        '</div>' +
        '<div class="card-title" style="margin-bottom:var(--space-3)">Skill Access</div>' +
        '<div class="grid" style="gap:var(--space-3);margin-bottom:var(--space-5)">' + skillsHtml + '</div>' +
        '<div class="card-title" style="margin-bottom:var(--space-3)">Data Summary</div>' +
        '<div style="margin-bottom:var(--space-4)">' + dataRows + '</div>' +
        budgetPanel +
        pointsPanel +
        lifecyclePanel +
        '<button class="btn btn-sm" data-act="openCookingManagerForUser" data-args="[' + user.id + ']" style="width:100%">Open Cooking setup →</button>';
    } catch (err) {
      body.innerHTML = '<div class="empty">Failed to load user details</div>';
    }
  }

  function renderUserLifecyclePanel(user, sessions, lockout, integrations) {
    const devices = (sessions.devices || []).map(d =>
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">' +
        '<div><div>' + esc(d.deviceName || 'Unnamed device') + '</div>' +
        '<div class="text-muted mono" style="font-size:10px">' + esc(d.deviceId).slice(0, 18) + ' · active ' + (d.lastActiveAt ? relativeTime(d.lastActiveAt) : '—') + (d.hasRefreshToken ? '' : ' · no refresh token') + '</div></div>' +
        '<button class="btn btn-ghost btn-sm" data-act="revokeUserSession" data-args="[' + user.id + ',&quot;' + esc(d.deviceId) + '&quot;]">Sign out</button></div>').join('') || '<div class="text-muted">No signed-in devices</div>';
    const tokens = (sessions.pushTokens || []).filter(t => !t.revokedAt).map(t =>
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0">' +
        '<span class="mono text-muted" style="font-size:11px">…' + esc(t.tokenSuffix) + ' · ' + esc(t.environment) + (t.appVersion ? ' · v' + esc(t.appVersion) : '') + ' · seen ' + relativeTime(t.lastSeenAt) + '</span>' +
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
    return '<div class="card-title" style="margin:var(--space-4) 0 var(--space-3)">Sessions &amp; devices</div>' +
      '<div style="margin-bottom:var(--space-2)">' + devices + '</div>' +
      '<div style="margin-bottom:var(--space-3)"><button class="btn btn-ghost btn-sm" data-act="revokeAllUserSessions" data-args="[' + user.id + ']">Sign out all devices</button></div>' +
      '<div class="card-title" style="margin-bottom:var(--space-3)">Push tokens</div><div style="margin-bottom:var(--space-4)">' + tokens + '</div>' +
      '<div class="card-title" style="margin-bottom:var(--space-3)">Security</div><div style="margin-bottom:var(--space-4)">' + lockHtml + '</div>' +
      '<div class="card-title" style="margin-bottom:var(--space-3)">Integrations</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--space-4)">' + providersHtml + '</div>' +
      '<div style="margin-bottom:var(--space-4)"><a href="#support" class="btn btn-ghost btn-sm" data-act="openSupportForUser" data-args="[' + user.id + ']">Tickets for this user →</a></div>';
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

  // ════════════════════════════════════════════════════════════
  // Skills (global toggle)
  // ════════════════════════════════════════════════════════════
  window.toggleSubSkill = async function(domain, subSkill, enabled) {
    try {
      const r = await apiFetch('/api/skills/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, subSkill, enabled }),
      });
      const d = await r.json();
      if (d.ok) showToast(domain + ':' + subSkill + (enabled ? ' enabled' : ' disabled'));
      else showToast('Toggle failed', false);
    } catch { showToast('Toggle failed', false); }
  };
  window.toggleSkillMaster = async function(skillName, enabled) {
    try {
      const ep = '/api/skills/' + encodeURIComponent(skillName) + (enabled ? '/enable' : '/disable');
      await apiFetch(ep, { method: 'POST' });
      showToast(skillName + (enabled ? ' enabled' : ' disabled'));
    } catch { showToast('Toggle failed', false); }
  };

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
            ? '<div class="text-tertiary mono" style="font-size:10px;margin-top:6px">' +
                'Errors: ' + p.failures + ' · Fallbacks: ' + p.fallbacks + ' · CB opens: ' + p.cbOpens +
              '</div>'
            : '') +
          '<div class="text-tertiary mono" style="font-size:10px;margin-top:4px">OK: ' + lastOk + ' · Fail: ' + lastFail + '</div>' +
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
        const mkApplyBtn = role => '<span id="apply-' + s.provider + '-' + role + '" style="display:none">' +
          '<button class="btn btn-primary btn-xs" data-act="applyModelChange" data-args="[&quot;' + s.provider + '&quot;,&quot;' + role + '&quot;]">Apply</button>' +
        '</span>';
        const mkRow = (label, role, model, src, opts) => '<div class="flex gap-2" style="align-items:center;margin-bottom:6px">' +
          '<span class="text-muted" style="min-width:90px;font-size:11px">' + label + '</span>' +
          '<div style="flex:1">' + mkSelect(role, model, opts) + '</div>' +
          mkApplyBtn(role) + ' ' + mkBadge(src) + ' ' + mkReset(role, src) +
        '</div>';
        const domainRows = s.domains ? Object.entries(s.domains).map(([dom, dd]) => {
          const di = domainIcons[dom] || '⚙️';
          return mkRow(di + ' ' + dom, dom, dd.model, dd.source, allModels(s.provider));
        }).join('') : '';
        return '<div style="margin-bottom:14px;padding:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-lg)">' +
          '<div style="font-weight:600;margin-bottom:8px;text-transform:capitalize">' + icon + ' ' + esc(s.provider) + '</div>' +
          '<div class="text-muted" style="font-size:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em">Provider tiers</div>' +
          mkRow('Chat', 'chat', s.chat.model, s.chat.source, options[s.provider]?.chat || []) +
          mkRow('Classifier', 'classifier', s.classifier.model, s.classifier.source, options[s.provider]?.classifier || []) +
          (domainRows ? '<div class="text-muted" style="font-size:10px;margin:8px 0 4px;border-top:1px solid var(--border);padding-top:8px;text-transform:uppercase;letter-spacing:0.06em">Per-domain overrides</div>' + domainRows : '') +
        '</div>';
      }).join('');
    } catch { /* silent */ }
  }

  window.showApplyBtn = function(provider, role) {
    const sel = document.getElementById('model-sel-' + provider + '-' + role);
    const btn = document.getElementById('apply-' + provider + '-' + role);
    if (!sel || !btn) return;
    btn.style.display = sel.value !== sel.dataset.original ? '' : 'none';
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
          statusEl.innerHTML = '<span style="color:var(--text-warning)">⚠ GEMINI_API_KEY not set</span>';
        } else if (!enabled) {
          statusEl.innerHTML = '<span style="color:var(--text-tertiary)">Gemini routes disabled · ' + openaiCount + ' → openai · ' + anthropicCount + ' → anthropic</span>';
        } else {
          statusEl.innerHTML = '<span style="color:var(--text-secondary)">' + geminiCount + ' → gemini · ' + openaiCount + ' → openai · ' + anthropicCount + ' → anthropic</span>';
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
          toggle = '<span class="card-subtitle" style="font-size:11px">controlled by Secretary route ↑</span>';
        } else {
          toggle = '<label class="flex items-center" style="gap:6px;justify-content:flex-end;cursor:pointer;font-size:11px">' +
            '<input type="checkbox" data-domain="' + esc(row.domain) + '"' + (row.geminiEnabled ? ' checked' : '') + ' data-on="change" data-act="togglePerDomain" data-args="[&quot;$el&quot;]" />' +
            '<span>' + (row.geminiEnabled ? 'on Gemini' : 'on Anthropic') + '</span>' +
          '</label>';
        }

        return '<tr>' +
          '<td><strong>' + dIcon + ' ' + esc(row.domain) + '</strong></td>' +
          '<td><span class="' + pillClass + '">' + pIcon + ' ' + esc(row.provider) + '</span>' +
            (isOverride ? ' <span class="badge badge-accent" style="font-size:10px">override</span>' : '') + '</td>' +
          '<td><code style="font-size:11px">' + esc(row.model || '—') + '</code></td>' +
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
          const muted = row.count === 0 ? ' style="opacity:0.5"' : '';
          return '<tr' + muted + '>' +
            '<td><code style="font-size:11px">' + esc(row.id) + '</code></td>' +
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
          '<td class="text-right mono" style="color:' + sc + '">' + a.avgScore.toFixed(0) + '</td>' +
          '<td class="text-right">' + a.totalTasks + '</td>' +
          '<td class="text-right mono" style="color:' + pc + '">' + (a.passRate * 100).toFixed(0) + '%</td>' +
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
        return '<div style="padding:10px 14px;border-bottom:1px solid var(--border);background:' + bg + '">' +
          '<div style="display:flex;gap:8px;align-items:start">' +
            '<span style="font-size:16px">' + icon + '</span>' +
            '<div>' +
              '<div style="font-weight:600;font-size:13px;color:var(--text-primary)">' + esc(i.title) + '</div>' +
              '<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">' + esc(i.detail) + '</div>' +
              (i.impact ? '<div style="font-size:11px;color:var(--accent);margin-top:4px;font-weight:600">' + esc(i.impact) + '</div>' : '') +
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
        return '<div class="flex gap-3" style="align-items:center;margin:8px 0">' +
          '<span class="mono" style="min-width:140px;color:' + color + ';font-size:11px">' + esc(cat) + '</span>' +
          '<div style="flex:1;height:8px;background:var(--bg-tertiary);border-radius:var(--radius-full);overflow:hidden">' +
            '<div style="width:' + pct + '%;height:100%;background:' + color + '"></div>' +
          '</div>' +
          '<span class="mono" style="min-width:40px;text-align:right;font-size:11px">' + count + '</span>' +
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
          return '<span><span style="color:' + color + '">●</span> ' +
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
          ? 'color:var(--warning, #f59e0b)'
          : '';
        return '<tr>' +
          '<td><span style="margin-right:6px">' + icon + '</span>' +
            '<span class="mono" style="font-size:11px">' + esc(r.category) + '</span>' +
          '</td>' +
          '<td><span class="mono" style="font-size:11px;color:' + pColor + '">● ' + esc(r.provider) + '</span></td>' +
          '<td><span class="mono" style="font-size:10px;color:var(--text-tertiary)">' + esc(shortModel(r.model)) + '</span></td>' +
          '<td class="text-right mono" style="font-size:11px">' + (r.calls || 0).toLocaleString() + '</td>' +
          '<td class="text-right mono" style="font-size:11px">' + perCallFmt + '</td>' +
          '<td class="text-right mono" style="font-size:11px">' + Math.round(r.tokens || 0).toLocaleString() + '</td>' +
          '<td class="text-right mono" style="font-size:11px">' + avgMs + '</td>' +
          '<td class="text-right mono" style="font-size:11px;' + p95Color + '">' + p95Ms + '</td>' +
          '<td class="text-right mono" style="position:relative">' +
            '<div style="position:absolute;left:0;top:50%;transform:translateY(-50%);width:' + barPct + '%;height:70%;background:var(--accent-bg,rgba(255,107,53,0.12));border-radius:3px;z-index:0"></div>' +
            '<span style="position:relative;z-index:1;font-weight:600">' + costFmt + '</span>' +
          '</td>' +
        '</tr>';
      }).join('');
    } catch { /* silent */ }
  };

  // Notification Decision Center moved to ui/notifications.js (Phase 5 section extraction).

  // Settings moved to ui/settings.js (Phase 5 section extraction).

  // Invite codes, Founders, Audit Trail and Waitlist moved to ui/*.js (Phase 5 section extraction).

  // ════════════════════════════════════════════════════════════
  // Cooking portal manager
  // ════════════════════════════════════════════════════════════
  const COOKING_PREF_KINDS_NUMERIC = new Set(['weekday_max_prep_minutes', 'budget_limit']);
  const COOKING_PREF_KINDS_BOOLEAN = new Set(['batch_cooking_preferred']);
  let cookingPortalState = {
    userId: null,
    tenantId: null,
    preferences: null,
    pantry: [],
    error: '',
    loading: false,
  };

  function getCookingTarget(quiet = false) {
    const userInput = document.getElementById('cooking-target-user-id');
    const tenantInput = document.getElementById('cooking-target-tenant-id');
    const userId = Number.parseInt(userInput?.value || '', 10);
    const tenantId = Number.parseInt(tenantInput?.value || userInput?.value || '', 10);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0) {
      if (!quiet) showToast('Enter a valid Cooking user ID', false);
      return null;
    }
    return { userId, tenantId };
  }

  function setCookingScopeStatus(text, kind = 'neutral') {
    const el = document.getElementById('cooking-scope-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'badge mono badge-' + kind;
  }

  function updateCookingKpis() {
    const prefs = cookingPortalState.preferences?.preferences || cookingPortalState.preferences || {};
    const profile = prefs.profile || {};
    const memories = prefs.memories || [];
    const pantry = cookingPortalState.pantry || [];
    const allergies = Array.isArray(profile.allergies) ? profile.allergies : [];
    const restrictions = Array.isArray(profile.dietaryRestrictions) ? profile.dietaryRestrictions : [];
    const expired = pantry.filter(item => item.freshness_status === 'expired' || item.freshnessStatus === 'expired').length;
    const badge = document.getElementById('nav-cooking-badge');
    if (badge) badge.textContent = (memories.length || pantry.length) ? String(memories.length + pantry.length) : '';
    document.getElementById('cooking-kpi-preferences').textContent = fmtNum(memories.length);
    document.getElementById('cooking-kpi-preferences-sub').textContent = memories.length ? 'metadata only' : 'scoped metadata';
    document.getElementById('cooking-kpi-pantry').textContent = fmtNum(pantry.length);
    document.getElementById('cooking-kpi-pantry-sub').textContent = expired ? expired + ' expired' : 'including expired';
    document.getElementById('cooking-kpi-allergies').textContent = fmtNum(allergies.length);
    document.getElementById('cooking-kpi-diet').textContent = fmtNum(restrictions.length);
  }

  function renderCookingPreferences() {
    const prefs = cookingPortalState.preferences?.preferences || cookingPortalState.preferences || {};
    const memories = prefs.memories || [];
    const meta = document.getElementById('cooking-preferences-meta');
    const summary = document.getElementById('cooking-preferences-summary');
    const list = document.getElementById('cooking-preferences-list');
    if (!cookingPortalState.userId) {
      meta.textContent = 'Select a user to load Cooking preferences';
      summary.textContent = 'No preferences loaded';
      list.innerHTML = '<div class="empty">No Cooking preferences loaded</div>';
      return;
    }
    if (cookingPortalState.error) {
      meta.textContent = 'Load failed for user ' + cookingPortalState.userId + ' · tenant ' + cookingPortalState.tenantId;
      summary.textContent = 'Cooking preferences unavailable for this scoped request';
      list.innerHTML = '<div class="empty">Failed to load Cooking preferences</div>';
      return;
    }
    meta.textContent = 'User ' + cookingPortalState.userId + ' · tenant ' + cookingPortalState.tenantId;
    summary.textContent = prefs.summary || prefs.skillMemorySummary || 'No preference summary available';
    if (!memories.length) {
      list.innerHTML = '<div class="empty">No Cooking preference memories returned</div>';
      return;
    }
    list.innerHTML = '<div style="overflow-x:auto"><table class="data-table">' +
      '<thead><tr><th>Kind</th><th>Scope</th><th>Confidence</th><th>Freshness</th><th>Updated</th></tr></thead>' +
      '<tbody>' + memories.map(memory => {
        const key = memory.memoryKey || memory.memoryType || 'preference';
        return '<tr>' +
          '<td><span class="mono">' + esc(key) + '</span></td>' +
          '<td><span class="badge badge-neutral">' + esc(memory.scope || 'unknown') + '</span></td>' +
          '<td class="mono">' + esc(memory.confidence ?? '—') + '</td>' +
          '<td>' + esc(memory.freshnessStatus || memory.status || '—') + '</td>' +
          '<td class="text-muted">' + esc(memory.updatedAt ? relativeTime(memory.updatedAt) : '—') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderCookingPantry() {
    const list = document.getElementById('cooking-pantry-list');
    const meta = document.getElementById('cooking-pantry-meta');
    const items = cookingPortalState.pantry || [];
    if (!cookingPortalState.userId) {
      meta.textContent = 'Select a user to load pantry state';
      list.innerHTML = '<div class="empty">No pantry loaded</div>';
      return;
    }
    if (cookingPortalState.error) {
      meta.textContent = 'Load failed for user ' + cookingPortalState.userId + ' · tenant ' + cookingPortalState.tenantId;
      list.innerHTML = '<div class="empty">Failed to load Cooking pantry</div>';
      return;
    }
    meta.textContent = items.length + ' items · user ' + cookingPortalState.userId + ' · tenant ' + cookingPortalState.tenantId;
    if (!items.length) {
      list.innerHTML = '<div class="empty">No pantry items returned</div>';
      return;
    }
    list.innerHTML = '<div style="overflow-x:auto"><table class="data-table">' +
      '<thead><tr><th>Item</th><th>Quantity</th><th>Freshness</th><th>Expires</th><th></th></tr></thead>' +
      '<tbody>' + items.map(item => {
        const freshness = item.freshness_status || item.freshnessStatus || 'unknown';
        const badgeClass = freshness === 'expired' ? 'badge-error' : freshness === 'aging' ? 'badge-warning' : 'badge-success';
        const qty = [item.quantity, item.unit].filter(Boolean).join(' ') || '—';
        return '<tr>' +
          '<td><div style="font-weight:600">' + esc(item.name || 'Unnamed item') + '</div><div class="text-muted" style="font-size:11px">' + esc(item.category || item.availability_status || 'pantry') + '</div></td>' +
          '<td class="mono">' + esc(qty) + '</td>' +
          '<td><span class="badge ' + badgeClass + '">' + esc(freshness) + '</span></td>' +
          '<td class="text-muted">' + esc(item.expires_at || item.expiresAt || '—') + '</td>' +
          '<td class="text-right"><button class="btn btn-xs btn-danger" data-act="deleteCookingPantryItem" data-args="[' + Number(item.id) + ']">Delete</button></td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function setCookingSubstitutionResult(message, kind = 'neutral') {
    const status = document.getElementById('cooking-substitution-status');
    const result = document.getElementById('cooking-substitution-result');
    if (status) {
      status.textContent = kind === 'success' ? 'Applied' : kind === 'error' ? 'Failed' : 'Ready';
      status.className = 'badge badge-' + kind;
    }
    if (result) result.textContent = message;
  }

  function renderCookingPortal() {
    if (!getCookingTarget(true) && !cookingPortalState.userId) setCookingScopeStatus('No user selected');
    if (cookingPortalState.loading) setCookingScopeStatus('Loading…', 'neutral');
    else if (cookingPortalState.error) setCookingScopeStatus('Load failed', 'error');
    else if (cookingPortalState.userId) setCookingScopeStatus('User ' + cookingPortalState.userId + ' · tenant ' + cookingPortalState.tenantId, 'success');
    updateCookingKpis();
    renderCookingPreferences();
    renderCookingPantry();
  }

  async function loadCookingPortal() {
    const target = getCookingTarget();
    if (!target) return;
    cookingPortalState = { ...cookingPortalState, ...target, loading: true, error: '' };
    renderCookingPortal();
    const query = '?tenantId=' + encodeURIComponent(String(target.tenantId));
    try {
      const [preferencesRes, pantryRes] = await Promise.all([
        apiFetch('/api/users/' + target.userId + '/cooking/preferences' + query),
        apiFetch('/api/users/' + target.userId + '/cooking/pantry' + query + '&includeExpired=true&limit=250'),
      ]);
      const preferences = await preferencesRes.json();
      const pantry = await pantryRes.json();
      if (!preferencesRes.ok) throw new Error(preferences?.error?.message || 'Cooking preferences load failed');
      if (!pantryRes.ok) throw new Error(pantry?.error?.message || 'Cooking pantry load failed');
      cookingPortalState = {
        ...cookingPortalState,
        ...target,
        preferences,
        pantry: pantry.items || [],
        error: '',
        loading: false,
      };
      renderCookingPortal();
    } catch (err) {
      cookingPortalState = {
        ...cookingPortalState,
        ...target,
        preferences: null,
        pantry: [],
        error: err?.message || 'Cooking portal load failed',
        loading: false,
      };
      renderCookingPortal();
      showToast(cookingPortalState.error, false);
    }
  }

  function coerceCookingPreferenceValue(kind, raw) {
    const trimmed = String(raw ?? '').trim();
    if (COOKING_PREF_KINDS_NUMERIC.has(kind)) return Number(trimmed);
    if (COOKING_PREF_KINDS_BOOLEAN.has(kind)) return ['true', 'yes', '1', 'on'].includes(trimmed.toLowerCase());
    return trimmed;
  }

  async function saveCookingPreferenceFromPortal() {
    const target = getCookingTarget();
    if (!target) return;
    const kind = document.getElementById('cooking-preference-kind').value;
    const rawValue = document.getElementById('cooking-preference-value').value;
    if (!String(rawValue || '').trim()) {
      showToast('Enter a Cooking preference value', false);
      return;
    }
    const body = {
      tenantId: target.tenantId,
      kind,
      value: coerceCookingPreferenceValue(kind, rawValue),
      correction: document.getElementById('cooking-preference-correction').checked,
      source: 'portal_browser',
      confidence: 0.9,
    };
    const btn = document.getElementById('cooking-save-preference-btn');
    btn.disabled = true;
    try {
      const res = await apiFetch('/api/users/' + target.userId + '/cooking/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Preference write failed');
      document.getElementById('cooking-preference-value').value = '';
      showToast('Cooking preference saved');
      await loadCookingPortal();
    } catch (err) {
      showToast(err?.message || 'Cooking preference write failed', false);
    } finally {
      btn.disabled = false;
    }
  }

  async function saveCookingPantryFromPortal() {
    const target = getCookingTarget();
    if (!target) return;
    const name = document.getElementById('cooking-pantry-name').value.trim();
    if (!name) {
      showToast('Enter a pantry item name', false);
      return;
    }
    const body = {
      tenantId: target.tenantId,
      name,
      quantity: document.getElementById('cooking-pantry-quantity').value.trim(),
      unit: document.getElementById('cooking-pantry-unit').value.trim(),
      category: document.getElementById('cooking-pantry-category').value.trim(),
      expiresAt: document.getElementById('cooking-pantry-expires-at').value,
      freshnessStatus: document.getElementById('cooking-pantry-freshness').value,
      notes: document.getElementById('cooking-pantry-notes').value.trim(),
      confidence: 0.9,
    };
    const btn = document.getElementById('cooking-save-pantry-btn');
    btn.disabled = true;
    try {
      const res = await apiFetch('/api/users/' + target.userId + '/cooking/pantry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Pantry write failed');
      ['cooking-pantry-name', 'cooking-pantry-quantity', 'cooking-pantry-unit', 'cooking-pantry-category', 'cooking-pantry-expires-at', 'cooking-pantry-freshness', 'cooking-pantry-notes'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      showToast('Pantry item saved');
      await loadCookingPortal();
    } catch (err) {
      showToast(err?.message || 'Pantry write failed', false);
    } finally {
      btn.disabled = false;
    }
  }

  async function applyCookingSubstitutionFromPortal() {
    const target = getCookingTarget();
    if (!target) return;
    const date = document.getElementById('cooking-substitution-date').value;
    const mealType = document.getElementById('cooking-substitution-meal-type').value;
    const originalIngredient = document.getElementById('cooking-substitution-original').value.trim();
    const suggestedIngredient = document.getElementById('cooking-substitution-suggested').value.trim();
    const reason = document.getElementById('cooking-substitution-reason').value;
    const updateShoppingList = document.getElementById('cooking-substitution-update-shopping').checked;
    if (!date || !mealType || !originalIngredient || !suggestedIngredient) {
      showToast('Enter meal date, meal type, original ingredient, and substitute', false);
      setCookingSubstitutionResult('Missing required substitution fields.', 'error');
      return;
    }

    const btn = document.getElementById('cooking-apply-substitution-btn');
    btn.disabled = true;
    setCookingSubstitutionResult('Applying substitution for user ' + target.userId + ' · tenant ' + target.tenantId + '…');
    try {
      const res = await apiFetch('/api/users/' + target.userId + '/cooking/meal-plan/substitutions/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: target.tenantId,
          date,
          mealType,
          originalIngredient,
          suggestedIngredient,
          reason,
          updateShoppingList,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Substitution apply failed');
      const substitution = data?.result?.substitution || {};
      const message = 'Applied ' + originalIngredient + ' → ' + suggestedIngredient +
        ' for ' + mealType + ' on ' + date +
        (substitution.shoppingListUpdated ? '; shopping list refreshed.' : '; shopping list unchanged.');
      setCookingSubstitutionResult(message, 'success');
      showToast('Cooking substitution applied');
      await loadCookingPortal();
    } catch (err) {
      const message = err?.message || 'Cooking substitution apply failed';
      setCookingSubstitutionResult(message, 'error');
      showToast(message, false);
    } finally {
      btn.disabled = false;
    }
  }

  window.deleteCookingPantryItem = async function(itemId) {
    const target = getCookingTarget();
    if (!target || !itemId) return;
    if (!confirm('Delete this Cooking pantry item?')) return;
    try {
      const res = await apiFetch('/api/users/' + target.userId + '/cooking/pantry/' + encodeURIComponent(String(itemId)), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: target.tenantId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Pantry delete failed');
      showToast('Pantry item deleted');
      await loadCookingPortal();
    } catch (err) {
      showToast(err?.message || 'Pantry delete failed', false);
    }
  };

  window.openCookingManagerForUser = function(userId) {
    const userInput = document.getElementById('cooking-target-user-id');
    const tenantInput = document.getElementById('cooking-target-tenant-id');
    if (userInput) userInput.value = String(userId);
    if (tenantInput) tenantInput.value = String(userId);
    navigateTo('cooking');
    loadCookingPortal();
  };

  document.getElementById('cooking-refresh-btn')?.addEventListener('click', loadCookingPortal);
  document.getElementById('cooking-load-btn')?.addEventListener('click', loadCookingPortal);
  document.getElementById('cooking-clear-btn')?.addEventListener('click', () => {
    ['cooking-target-user-id', 'cooking-target-tenant-id'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    cookingPortalState = { userId: null, tenantId: null, preferences: null, pantry: [], error: '', loading: false };
    setCookingSubstitutionResult('Use this after a candidate is reviewed for allergy, dietary, disliked-ingredient, or pantry freshness safety.');
    renderCookingPortal();
  });
  document.getElementById('cooking-save-preference-btn')?.addEventListener('click', saveCookingPreferenceFromPortal);
  document.getElementById('cooking-save-pantry-btn')?.addEventListener('click', saveCookingPantryFromPortal);
  document.getElementById('cooking-apply-substitution-btn')?.addEventListener('click', applyCookingSubstitutionFromPortal);

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
      status.style.color = 'var(--accent)';
    } else {
      status.textContent = 'Operator/platform scope (no x-nexus-* headers)';
      status.style.color = 'var(--text-tertiary)';
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
    CONTENT_SCOPE = { userId, tenantId };
    persistScope(CONTENT_SCOPE);
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
    CONTENT_SCOPE = { userId: '', tenantId: '' };
    persistScope(CONTENT_SCOPE);
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
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
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
        ? '<ul style="margin:0;padding-left:var(--space-4);font-size:12px">'
          + accepted.map(t => '<li>' + esc(t.topic) + ' <span class="text-muted">×' + t.count + '</span></li>').join('')
          + '</ul>'
        : '<div class="empty">No accepts yet</div>';
    }
    const rejected = (ra.topRejectedTopics || []);
    const rejectedHost = document.getElementById('content-perf-top-rejected');
    if (rejectedHost) {
      rejectedHost.innerHTML = rejected.length
        ? '<ul style="margin:0;padding-left:var(--space-4);font-size:12px">'
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
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
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
        <div style="min-width:74px;padding:6px 10px;border-radius:8px;
                    background:${bg};opacity:${opacity};
                    text-align:center;font-family:var(--font-mono,inherit)">
          <div style="font-size:16px;font-weight:700;color:${dimmed ? 'var(--text-tertiary)' : tint}">
            ${b.count}
          </div>
          <div style="font-size:9px;font-weight:600;color:var(--text-secondary);margin-top:2px">
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
      return '<div class="kpi-card" style="padding:var(--space-3)">' +
        '<div class="kpi-label">' + esc(CONTENT_PIPELINE_LABELS[s]) + '</div>' +
        '<div class="kpi-value" style="font-size:24px">' + (unavailable ? count : fmtNum(count)) + '</div>' +
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
      '<div style="overflow-x:auto"><table class="data-table">' +
      '<thead><tr><th>Topic</th><th>Niche</th><th>Stage</th><th>Updated</th><th>Published</th></tr></thead>' +
      '<tbody>' +
      rows.map(r => {
        const pubCell = r.publishedUrl
          ? '<a href="' + esc(r.publishedUrl) + '" target="_blank" rel="noopener" style="color:var(--accent)">View</a>'
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
      '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--domain-secretary);margin-right:6px"></span>last run OK</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#E25C5C;margin-right:6px"></span>last run failed</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--text-tertiary);margin-right:6px"></span>never run</span>' +
      '<span style="margin-left:auto;font-family:ui-monospace,monospace">' +
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
        '<td><div>' + esc(t.label) + '</div><div class="text-muted mono" style="font-size:10px">' + esc(t.name) + '</div></td>' +
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
      const statusBadge = '<span class="badge badge-' +
        (b.status === 'extracted' ? 'success' : b.status === 'pending' || b.status === 'extracting' ? 'warning' : 'neutral') +
        '" style="font-size:10px">' + esc(b.status) + '</span>';
      const frameworksPreview = (b.frameworks && b.frameworks.length > 0)
        ? '<div class="text-muted" style="font-size:11px;margin-top:4px">Frameworks: ' +
            esc(b.frameworks.slice(0, 3).join(', ')) + '</div>'
        : '';
      const thesis = b.thesis
        ? '<div class="text-muted" style="font-size:11px;margin-top:4px;line-height:1.4">' + esc(b.thesis).slice(0, 220) + (b.thesis.length > 220 ? '…' : '') + '</div>'
        : '';
      const actions = b.status === 'failed'
        ? '<button class="btn btn-ghost btn-sm" style="font-size:10px" data-act="retryBookExtraction" data-args="[' + b.id + ']">🔁 Retry</button>'
        : '';
      const deleteBtn = '<button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--error)" data-act="deleteBook" data-args="[' + b.id + ']">✕</button>';
      return '<div style="padding:var(--space-3) 0;border-bottom:1px solid var(--border)">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-2)">' +
          '<div><div style="font-weight:600;font-size:13px">' + esc(b.title) + '</div>' +
          '<div class="text-muted" style="font-size:11px">' + esc(b.author) + ' · ' + (b.timesReferenced || 0) + ' refs</div>' +
          '</div><div style="display:flex;gap:4px;align-items:center">' + actions + deleteBtn + statusBadge + '</div></div>' +
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
      return '<div style="padding:var(--space-2) 0;border-bottom:1px solid var(--border);display:flex;gap:var(--space-3);align-items:flex-start">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:' + dotColor + ';margin-top:6px;flex-shrink:0"></span>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:500">' + esc(s.summary) + '</div>' +
        '<div class="text-muted" style="font-size:10px;margin-top:2px">' + esc(s.type) + ' · ' + relativeTime(s.createdAt) + '</div>' +
        '</div>' +
        '<span class="badge ' + pri + '" style="font-size:10px">' + esc(s.priority) + '</span>' +
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
        const statusBadge = '<span class="badge badge-' +
          (c.status === 'active' ? 'success' :
           c.status === 'pending' || c.status === 'analyzing' ? 'warning' :
           c.status === 'failed' ? 'error' : 'neutral') +
          '" style="font-size:10px">' + esc(c.status) + '</span>';
        const nameLine = c.name ? esc(c.name) : c.url.slice(0, 48);
        const analyzed = c.videosAnalyzed || 0;
        const lastAt = c.lastAnalyzedAt ? relativeTime(c.lastAnalyzedAt) : 'never';
        const errorLine = c.errorMessage
          ? '<div class="text-muted" style="font-size:10px;color:#E25C5C">' + esc(c.errorMessage).slice(0, 120) + '</div>'
          : '';
        return '<div style="padding:var(--space-2) 0;border-bottom:1px solid var(--border)">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-2)">' +
          '<div style="min-width:0;flex:1"><div style="font-weight:500;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(nameLine) + '</div>' +
          '<div class="text-muted mono" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="' + esc(c.url) + '" target="_blank" rel="noopener" style="color:inherit">' + esc(c.url) + '</a></div></div>' +
          '<div style="display:flex;gap:4px;align-items:center">' +
            '<button class="btn btn-ghost btn-sm" style="font-size:10px" data-act="reanalyzeChannel" data-args="[' + c.id + ']" title="Re-analyze">🔄</button>' +
            '<button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--error)" data-act="deleteChannel" data-args="[' + c.id + ']" title="Remove">✕</button>' +
            statusBadge +
          '</div></div>' +
          '<div class="text-muted" style="font-size:10px;margin-top:4px">' + analyzed + ' videos · ' + lastAt + '</div>' +
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
          ? '<span class="badge badge-success" style="font-size:10px">' + esc(v.studyType || 'study') + '</span>'
          : '<span class="badge badge-neutral" style="font-size:10px">transcript</span>';
        const titleLine = v.title || v.videoId;
        return '<div style="padding:var(--space-2) 0;border-bottom:1px solid var(--border)">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-2)">' +
          '<div style="min-width:0;flex:1"><div style="font-weight:500;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="' + esc(v.youtubeUrl) + '" target="_blank" rel="noopener" style="color:inherit">' + esc(titleLine) + '</a></div>' +
          '<div class="text-muted" style="font-size:10px">' + esc(v.channelName || '—') + ' · ' + relativeTime(v.createdAt) + '</div></div>' +
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
      return '<div class="card" style="background:var(--bg-tertiary)">' +
        '<div class="card-header" style="margin-bottom:var(--space-2)">' +
        '<div class="card-title" style="font-size:11px">' + esc(v.label) + '</div>' +
        '<span class="card-subtitle">v' + v.version + ' · ' + relativeTime(v.updatedAt) + '</span>' +
        '</div>' +
        '<div id="' + id + '" style="font-size:12px;line-height:1.5;color:var(--text-primary);white-space:pre-wrap">' + esc(textPreview) + (hasMore ? '…' : '') + '</div>' +
        (hasMore
          ? '<button class="btn btn-sm btn-ghost" style="margin-top:var(--space-2)" data-act="expandVoiceDna" data-args="[' + idx + ']">Expand</button>'
          : '') +
        (v.sources && v.sources.length > 0
          ? '<div class="text-muted" style="font-size:10px;margin-top:var(--space-2)">Sources: ' + esc(v.sources.slice(0, 4).join(', ')) + (v.sources.length > 4 ? ' +' + (v.sources.length - 4) : '') + '</div>'
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
      return '<div style="margin-bottom:var(--space-4)">' +
        '<div class="card-title" style="font-size:11px;margin-bottom:var(--space-2)">' + esc(label) + '</div>' +
        '<div style="overflow-x:auto"><table class="data-table">' +
        '<thead><tr><th style="width:120px">Command</th><th>Description</th><th class="text-right" style="width:70px">7d</th><th class="text-right" style="width:110px">30d</th><th style="width:110px">Last used</th></tr></thead>' +
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
    ed.style.display = ed.style.display === 'none' ? 'block' : 'none';
    if (ed.style.display === 'block') loadPillars();
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
        return '<div style="display:flex;gap:var(--space-2);align-items:center;margin-bottom:var(--space-2)">' +
          '<span style="font-size:12px;font-weight:600;min-width:80px">' + esc(p.name) + '</span>' +
          '<input type="text" value="' + esc(kws) + '" style="flex:1;padding:4px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-primary);font-size:11px" ' +
          'onchange="updatePillarKeywords(' + p.id + ', this.value)">' +
          '<button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--error)" data-act="deletePillar" data-args="[' + p.id + ']">✕</button>' +
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
      pollSnapshot();
    } catch { showToast('Action failed', false); }
  };

  // ════════════════════════════════════════════════════════════
  // Polling orchestrator
  // ════════════════════════════════════════════════════════════
  async function pollAll() {
    pollSnapshot();
    pollUsageSummary();
    loadProviderHealth();
  }

  let pollTimer = null;
  let secondaryTimer = null;

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

  function startApp() {
    // Initial render
    pollAll();
    loadReleaseInfo();
    if (typeof window.NexusPortal.onAppStart === 'function') window.NexusPortal.onAppStart();
    loadModelConfig();
    loadDomainRouting();
    loadSecretaryOptimization();
    loadQualityScores();
    loadErrorDist();
    loadModelIntelligence();
    loadCostByDomain();
    // Load waitlist once on boot so the nav badge shows the pending count
    // even when the operator is on another tab. Subsequent refreshes are
    // driven by the 30s secondary timer below.

    // Polling intervals
    // - Snapshot + usage: 15s (drives KPIs and dashboard)
    // - Provider health + model config: 30s
    // Background tabs skip the polls; the next visible tick catches up.
    pollTimer = setInterval(() => { if (!document.hidden) pollAll(); }, 15000);
    secondaryTimer = setInterval(() => {
      if (document.hidden) return;
      loadModelConfig();
      loadDomainRouting();
      loadSecretaryOptimization();
      loadProviderHealth();
      loadQualityScores();
      loadErrorDist();
      loadModelIntelligence();
      loadCostByDomain();
      // Refresh users in background if user is on the Users tab
      if (currentSection === 'users') loadUsers();
      if (currentSection === 'content') loadContentDashboard();
    }, 30000);
    // Release identity changes only on deploy; refresh once a minute.
    setInterval(() => { if (!document.hidden) loadReleaseInfo(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAll(); });

    // Initial section from URL hash
    const initialSection = location.hash.replace('#', '') || 'dashboard';
    navigateTo(initialSection);
  }


  // ────────── Delegated actions (CSP: no inline handlers) ──────────
  // Markup declares data-act="<name>" [data-args='[…]'] [data-on="change"]
  // instead of inline on* attributes. Argument tokens: "$el" (element),
  // "$checked", "$value", "$valueBool", "$valueNum".
  const PORTAL_ACTIONS = {
    clearContentScope,
    createPortalNexusPointsCheckout,
    loadContentPerformance,
    saveContentScope,
    saveUserAiBudget,
  };
  // Resolved on window at dispatch time (assigned as window.<name> above):
  // ackAlert, addBook, addChannel, addPillar, applyModelChange, approveWaitlist, clearUserLockout, copyInvite, copyInviteCode, deleteBook, deleteChannel, deleteCookingPantryItem, deleteInviteCode, deletePillar, doAction, expandVoiceDna, loadCostByDomain, markInvited, onSkillToggle, onSkillsUserChange, openCookingManagerForUser, openSupportForUser, portalDecisionCenterAction, reanalyzeChannel, rejectWaitlist, removeFounder, resetModel, resetSelectedUserSkills, resetSetting, resolveAlert, retryAlertDelivery, retryBookExtraction, revokeAllUserSessions, revokeUserPushToken, revokeUserSession, showApplyBtn, ticketFromAlert, toggleGeminiRouting, togglePerDomain, togglePillarEditor, toggleSecretaryPrimaryRoute, toggleUserSkill, triggerChannelRelearn, triggerVoiceSynthesis, updateSetting
  function resolveActionArg(el, token) {
    if (token === '$el') return el;
    if (token === '$checked') return el.checked;
    if (token === '$value') return el.value;
    if (token === '$valueBool') return el.value === 'true';
    if (token === '$valueNum') return Number(el.value);
    return token;
  }
  function dispatchPortalAction(event, kind) {
    const el = event.target.closest('[data-act]');
    if (!el) return;
    const expected = el.dataset.on || 'click';
    if (expected !== kind) return;
    const name = el.dataset.act;
    const fn = PORTAL_ACTIONS[name] || window[name];
    if (typeof fn !== 'function') { console.warn('portal action not found', name); return; }
    let args = [];
    if (el.dataset.args) {
      try { args = JSON.parse(el.dataset.args); } catch (err) { console.warn('portal action args invalid', name, err); return; }
    }
    if (kind === 'click' && el.tagName === 'A') event.preventDefault();
    fn.apply(null, args.map((token) => resolveActionArg(el, token)));
  }
  document.addEventListener('click', (event) => dispatchPortalAction(event, 'click'));
  document.addEventListener('change', (event) => dispatchPortalAction(event, 'change'));
  // ────────── Boot ──────────
  // The token is never persisted (no localStorage, no server injection). A
  // cookie session, when the deployment has one, resumes without a prompt;
  // otherwise every page load starts at the login form.
  (async function resumeSession() {
    try {
      const res = await fetch('/api/auth/session', { headers: { Accept: 'application/json' } });
      if (res.ok) {
        SESSION = await res.json();
        startApp();
        return;
      }
    } catch (_) {
      // fall through to the login form
    }
    showLoginForm();
  })();
})();
