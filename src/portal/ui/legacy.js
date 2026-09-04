// Nexus Hub admin portal — legacy SPA script (classic, non-module).
// Extracted from the inline <script> in portal.html so the dashboard CSP can
// drop 'unsafe-inline' for scripts. Sections migrate from here to ES modules
// under src/portal/ui/*.js one at a time.
'use strict';
(function() {

  // The dashboard CSP serves style-src without 'unsafe-inline', so per-row
  // dynamic styling (bar widths, provider colours) rides on data-* attributes
  // and is applied through CSSOM, which the policy allows, as nodes land.
  const SAFE_CSS_COLOR = /^(#[0-9a-fA-F]{3,8}|var\(--[a-zA-Z0-9-]+(?:,[^;{}]*)?\)|rgba?\([0-9.,\s%]+\)|color-mix\([^;{}]+\)|[a-z]+)$/;
  const SAFE_CSS_NUMBER = /^-?\d+(\.\d+)?$/;
  const DYNAMIC_STYLE_SELECTOR = '[data-w],[data-color],[data-bg],[data-opacity]';
  function applyDynamicStyles(root) {
    if (!root || root.nodeType !== 1) return;
    const nodes = root.matches(DYNAMIC_STYLE_SELECTOR) ? [root] : [];
    nodes.push(...root.querySelectorAll(DYNAMIC_STYLE_SELECTOR));
    for (const el of nodes) {
      const { w, color, bg, opacity } = el.dataset;
      if (w !== undefined && SAFE_CSS_NUMBER.test(w)) el.style.width = w + '%';
      if (color !== undefined && SAFE_CSS_COLOR.test(color)) el.style.color = color;
      if (bg !== undefined && SAFE_CSS_COLOR.test(bg)) el.style.background = bg;
      if (opacity !== undefined && SAFE_CSS_NUMBER.test(opacity)) el.style.opacity = opacity;
    }
  }
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) applyDynamicStyles(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
  applyDynamicStyles(document.documentElement);
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
  // Two sign-in methods share the overlay: an operator username + password
  // (when the deployment configures PORTAL_OPERATOR_USERNAME) and a session
  // token. Both end in the same cookie session.
  let LOGIN_METHOD = 'token';
  let LOGIN_METHODS_PROBED = false;
  function setLoginMethod(method) {
    LOGIN_METHOD = method === 'password' ? 'password' : 'token';
    const passwordForm = document.getElementById('login-password-form');
    const tokenForm = document.getElementById('login-token-form');
    const sub = document.getElementById('login-sub');
    const switchLink = document.getElementById('login-switch');
    if (passwordForm) passwordForm.hidden = LOGIN_METHOD !== 'password';
    if (tokenForm) tokenForm.hidden = LOGIN_METHOD === 'password';
    if (sub) sub.textContent = LOGIN_METHOD === 'password' ? 'Sign in with your operator account' : 'Sign in with your portal access token';
    if (switchLink) switchLink.textContent = LOGIN_METHOD === 'password' ? 'Use a session token instead' : 'Use username and password';
    const focusId = LOGIN_METHOD === 'password' ? 'login-username' : 'login-token';
    setTimeout(() => { const el = document.getElementById(focusId); if (el) el.focus(); }, 50);
  }
  async function probeLoginMethods() {
    if (LOGIN_METHODS_PROBED) return;
    LOGIN_METHODS_PROBED = true;
    try {
      const res = await fetch('/api/auth/session/methods', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const methods = await res.json();
      const switchLink = document.getElementById('login-switch');
      if (switchLink) switchLink.hidden = !methods.password;
      if (methods.password) setLoginMethod('password');
    } catch (_) {
      // token sign-in stays available
    }
  }
  function showLoginForm() {
    const overlay = document.getElementById('login-overlay');
    overlay.hidden = false;
    probeLoginMethods();
    setLoginMethod(LOGIN_METHOD);
  }
  function setLoginError(message) {
    document.getElementById('login-error').textContent = message || '';
  }
  async function doLoginPassword(event) {
    if (event && event.preventDefault) event.preventDefault();
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const btn = document.getElementById('login-password-btn');
    const username = (usernameEl.value || '').trim();
    const password = passwordEl.value || '';
    if (!username || !password) return;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    setLoginError('');
    try {
      const res = await fetch('/api/auth/session/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        SESSION = await res.json();
        TOKEN = '';
        passwordEl.value = '';
        hideLoginForm();
        startApp();
        return;
      }
      if (res.status === 429) setLoginError('Too many attempts, try again later');
      else if (res.status === 503) setLoginError('Password sign-in is not configured on this deployment');
      else setLoginError('Invalid username or password');
    } catch (_) {
      setLoginError('Network error');
    }
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
  function hideLoginForm() {
    document.getElementById('login-overlay').hidden = true;
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
  document.getElementById('login-password-form').addEventListener('submit', doLoginPassword);
  document.getElementById('login-switch').addEventListener('click', (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginMethod(LOGIN_METHOD === 'password' ? 'token' : 'password');
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
  // Modules are deferred scripts; startApp waits for app.js to signal that
  // every section has registered before the first navigation.
  let signalModulesReady = () => {};
  const modulesReady = new Promise((resolve) => { signalModulesReady = resolve; });
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
    setContentScope: (scope) => {
      CONTENT_SCOPE = { userId: (scope && scope.userId) || '', tenantId: (scope && scope.tenantId) || '' };
      persistScope(CONTENT_SCOPE);
    },
    fmtCost: (n) => fmtCost(n),
    getCurrentSection: () => currentSection,
    signalModulesReady: () => signalModulesReady(),
    // Tiny event bus for the section modules: 'app:start' (after sign-in),
    // 'refresh' (topbar button), 'poll' (each snapshot poll), 'snapshot'.
    listeners: Object.create(null),
    on(event, fn) {
      (this.listeners[event] = this.listeners[event] || []).push(fn);
      return () => this.off(event, fn);
    },
    off(event, fn) {
      const list = this.listeners[event];
      if (list) this.listeners[event] = list.filter((f) => f !== fn);
    },
    emit(event, payload) {
      (this.listeners[event] || []).slice().forEach((fn) => {
        try { fn(payload); } catch (err) { console.warn('portal listener failed', event, err); }
      });
    },
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
    return '<div class="u-ta-left u-maxw-620 u-m-0-auto empty">' +
      '<div class="u-fw-700 u-c-error u-mb-6">' + esc(title) + '</div>' +
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
    SECTIONS.forEach(s => {
      const sec = document.querySelector('[data-section="' + s + '"]');
      const nav = document.querySelector('[data-nav="' + s + '"]');
      if (sec) sec.classList.toggle('active', s === section);
      if (nav) nav.classList.toggle('active', s === section);
    });
    if (location.hash !== '#' + section) {
      history.replaceState(null, '', '#' + section);
    }
    // Section loaders run from each module's onShow (src/portal/ui/*.js).
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

  window.addEventListener('hashchange', () => {
    const section = location.hash.replace('#', '') || 'dashboard';
    navigateTo(section);
  });

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    window.NexusPortal.emit('refresh');
    showToast('Refreshing…', 'info');
  });

  // Notification Decision Center moved to ui/notifications.js (Phase 5 section extraction).

  // Settings moved to ui/settings.js (Phase 5 section extraction).

  // Invite codes, Founders, Audit Trail and Waitlist moved to ui/*.js (Phase 5 section extraction).

  // Cooking moved to ui/cooking.js (Phase 5 section extraction). The router
  // hook below stays so the section activates through the module registry.
  function renderCookingPortal() {
    window.NexusPortal.activateSection('cooking');
  }
  // Users drawer → "Open Cooking setup" (resolved on window by the action dispatcher).
  window.openCookingManagerForUser = function(userId) {
    navigateTo('cooking');
    const cooking = window.NexusPortal.sections.cooking;
    if (cooking && cooking.openForUser) cooking.openForUser(userId);
  };

  // Dashboard, users, skills, ai, jobs and content moved to ui/*.js (Phase 5
  // section extraction); the shell only routes, authenticates and dispatches.
  async function startApp() {
    await Promise.race([modulesReady, new Promise((resolve) => setTimeout(resolve, 5000))]);
    window.NexusPortal.emit('app:start');
    if (typeof window.NexusPortal.onAppStart === 'function') window.NexusPortal.onAppStart();
    const initialSection = location.hash.replace('#', '') || 'dashboard';
    navigateTo(initialSection);
  }

  // ────────── Delegated actions (CSP: no inline handlers) ──────────
  // Markup declares data-act="<name>" [data-args='[…]'] [data-on="change"]
  // instead of inline on* attributes. Argument tokens: "$el" (element),
  // "$checked", "$value", "$valueBool", "$valueNum".
  // Every action is exposed on window by the module that owns it.
  const PORTAL_ACTIONS = Object.create(null);
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
