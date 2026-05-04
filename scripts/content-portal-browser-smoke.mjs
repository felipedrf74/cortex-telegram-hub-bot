#!/usr/bin/env node
//
// CONTENT-UI-O5 (2026-05-04): browser-runtime smoke for the new Content
// portal surfaces (Tenant Scope picker + scope-aware apiFetch +
// Performance panel + Canonical 12-bucket lifecycle band).
//
// Two modes:
//
//   --validate-only         Reads `src/portal/portal.html` and asserts
//                           every required ID, function, and structure
//                           is present. NO browser, NO engine needed.
//                           Runs in CI / local without external deps.
//
//   default (Playwright)    Launches Chromium, loads
//                           `http://localhost:8200/`, signs in with
//                           the portal token, applies a tenant scope,
//                           captures network calls, and asserts that
//                           the new Content surfaces render and that
//                           x-nexus-user-id / x-nexus-tenant-id headers
//                           accompany every /api/v1/admin/content/*
//                           call after scope is applied. Requires
//                           the engine running locally and a valid
//                           PORTAL_TOKEN.
//                           The local engine must also be started with
//                           IOS_API_ENABLED=true plus dummy IOS_* secrets so
//                           `/api/v1/admin/content/*` is mounted.
//
// Exit code 0 = all assertions passed. Non-zero = failure (with a
// reasonably actionable message printed to stderr).

import * as fs from 'node:fs';
import * as path from 'node:path';

function readArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

function readFlag(name) {
  return process.argv.includes(`--${name}`)
    || process.env[`CONTENT_PORTAL_SMOKE_${name.toUpperCase().replace(/-/g, '_')}`] === '1';
}

function parseArgs() {
  return {
    validateOnly: readFlag('validate-only'),
    baseUrl: (readArg('base-url')
      ?? process.env.CONTENT_PORTAL_SMOKE_BASE_URL
      ?? 'http://127.0.0.1:8200').replace(/\/+$/, ''),
    portalToken: readArg('portal-token')
      ?? process.env.CONTENT_PORTAL_SMOKE_TOKEN
      ?? '',
    userId: Number.parseInt(readArg('user-id') ?? '1', 10),
    tenantId: Number.parseInt(readArg('tenant-id') ?? '1', 10),
    headed: readFlag('headed'),
  };
}

const REQUIRED_IDS = [
  // Login overlay
  'login-token',
  'login-btn',
  // Scope picker
  'content-scope-card',
  'content-scope-user-id',
  'content-scope-tenant-id',
  'content-scope-save-btn',
  'content-scope-clear-btn',
  'content-scope-status',
  // Performance panel
  'content-performance-card',
  'content-perf-topics-total',
  'content-perf-published-30d',
  'content-perf-scripts-30d',
  'content-perf-radar-total',
  'content-perf-highlights',
  'content-perf-warnings',
  'content-perf-top-accepted',
  'content-perf-top-rejected',
  // Canonical lifecycle band
  'content-canonical-lifecycle-card',
  'content-canonical-lifecycle-band',
  'content-canonical-lifecycle-meta',
];

const REQUIRED_FUNCTIONS = [
  'loadStoredScope',
  'persistScope',
  'isContentScopedRoute',
  'apiFetch',
  'refreshContentScopeUI',
  'saveContentScope',
  'clearContentScope',
  'loadContentPerformance',
  'renderContentPerformance',
  'loadContentCanonicalLifecycle',
  'renderContentCanonicalLifecycle',
];

function findHtmlPath() {
  // Resolve relative to script (works when invoked from any cwd).
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(here, '../src/portal/portal.html'),
    path.resolve(process.cwd(), 'src/portal/portal.html'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Cannot find src/portal/portal.html — run from engine root.');
}

// ─── Mode 1: --validate-only ───────────────────────────────────────

function validateStructure() {
  const html = fs.readFileSync(findHtmlPath(), 'utf8');
  const messages = [];

  let ok = true;
  for (const id of REQUIRED_IDS) {
    if (!html.includes(`id="${id}"`)) {
      ok = false;
      messages.push(`✗ MISSING DOM id="${id}"`);
    } else {
      messages.push(`✓ id="${id}" present`);
    }
  }
  for (const fn of REQUIRED_FUNCTIONS) {
    // Match `function NAME(`, `const NAME =`, `async function NAME(`, etc.
    const re = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(|(?:const|let)\\s+${fn}\\s*=`);
    if (!re.test(html)) {
      ok = false;
      messages.push(`✗ MISSING JS function/const ${fn}`);
    } else {
      messages.push(`✓ JS ${fn} defined`);
    }
  }

  for (const fn of ['saveContentScope', 'clearContentScope', 'loadContentPerformance']) {
    if (!html.includes(`window.${fn} = ${fn}`)) {
      ok = false;
      messages.push(`✗ inline Content handler ${fn} is not exposed on window`);
    } else {
      messages.push(`✓ inline Content handler ${fn} exposed on window`);
    }
  }

  // Spot-check the scope wrapper actually attaches headers when scoped.
  const wrapperMatch = html.match(/if\s*\(isContentScopedRoute\(url\)\)\s*\{[\s\S]{0,300}?x-nexus-user-id[\s\S]{0,300}?x-nexus-tenant-id/);
  if (!wrapperMatch) {
    ok = false;
    messages.push('✗ apiFetch wrapper does NOT attach x-nexus-user-id and x-nexus-tenant-id');
  } else {
    messages.push('✓ apiFetch wrapper attaches both x-nexus-user-id and x-nexus-tenant-id');
  }

  // Spot-check the wrapper guards on isContentScopedRoute.
  if (!html.includes("url.includes('/api/v1/admin/content')")) {
    ok = false;
    messages.push("✗ isContentScopedRoute does not guard '/api/v1/admin/content'");
  } else {
    messages.push("✓ isContentScopedRoute guards '/api/v1/admin/content'");
  }

  // Keep the browser smoke selector in lock-step with the portal shell.
  if (!html.includes('data-nav="content"')) {
    ok = false;
    messages.push('✗ Content nav item data-nav="content" missing');
  } else {
    messages.push('✓ Content nav item data-nav="content" present');
  }

  // The scoped panels are the new tenant-aware evidence surfaces. They must
  // not be hidden by a failure in the older aggregate dashboard endpoint.
  const perfLoad = html.indexOf('loadContentPerformance().catch(() => {})');
  const lifecycleLoad = html.indexOf('loadContentCanonicalLifecycle().catch(() => {})');
  const legacyDashboardFetch = html.indexOf("apiFetch('/api/v1/admin/content-dashboard')");
  if (
    perfLoad < 0 || lifecycleLoad < 0 || legacyDashboardFetch < 0
    || perfLoad > legacyDashboardFetch || lifecycleLoad > legacyDashboardFetch
  ) {
    ok = false;
    messages.push('✗ scoped performance/lifecycle panels load only after legacy content-dashboard succeeds');
  } else {
    messages.push('✓ scoped performance/lifecycle panels load independently of legacy content-dashboard');
  }

  return { ok, messages };
}

// ─── Mode 2: live Playwright smoke ─────────────────────────────────

async function runLivePlaywrightSmoke(args) {
  if (!args.portalToken) {
    console.error('--portal-token is required for live smoke');
    return 2;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    console.error('Playwright not installed in this workspace.');
    console.error('Hint: --validate-only works without Playwright.');
    return 3;
  }

  console.log(`[smoke] launching chromium against ${args.baseUrl}`);
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  const scopedRequests = [];
  const scopedResponses = [];
  let captureScopedRequests = false;

  page.on('request', (req) => {
    const url = req.url();
    if (captureScopedRequests && url.includes('/api/v1/admin/content')) {
      scopedRequests.push({
        url,
        userIdHeader: req.headers()['x-nexus-user-id'] ?? null,
        tenantIdHeader: req.headers()['x-nexus-tenant-id'] ?? null,
      });
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (captureScopedRequests && url.includes('/api/v1/admin/content/')) {
      scopedResponses.push({ url, status: res.status() });
    }
  });

  let exitCode = 0;
  try {
    await page.goto(`${args.baseUrl}/admin`, { waitUntil: 'domcontentloaded' });

    // Sign in via the JS prompt overlay.
    await page.waitForSelector('#login-overlay', { state: 'visible', timeout: 8000 }).catch(() => null);
    if (await page.locator('#login-overlay').isVisible().catch(() => false)) {
      await page.waitForSelector('#login-token', { state: 'visible', timeout: 5000 });
      await page.fill('#login-token', args.portalToken);
      await page.click('#login-btn');
      await page.waitForFunction(() => {
        const overlay = document.getElementById('login-overlay');
        return !overlay || overlay.style.display === 'none';
      }, { timeout: 8000 });
    }

    // Navigate to Content section.
    await page.click('a[data-nav="content"]', { timeout: 8000 }).catch(() => null);
    await page.evaluate(() => {
      const win = window;
      if (typeof win.navigateTo === 'function') {
        win.navigateTo('content');
      } else {
        window.location.hash = '#content';
      }
    });
    // Wait for the Tenant Scope card to appear.
    await page.waitForSelector('#content-scope-card', { timeout: 8000 });
    console.log('✓ Tenant Scope card visible');

    // Apply scope and wait for the Performance card to render.
    await page.fill('#content-scope-user-id', String(args.userId));
    await page.fill('#content-scope-tenant-id', String(args.tenantId));
    captureScopedRequests = true;
    await page.click('#content-scope-save-btn');
    await page.evaluate(({ userId, tenantId }) => {
      const userInput = document.getElementById('content-scope-user-id');
      const tenantInput = document.getElementById('content-scope-tenant-id');
      if (userInput) userInput.value = String(userId);
      if (tenantInput) tenantInput.value = String(tenantId);
      const win = window;
      if (typeof win.saveContentScope === 'function') win.saveContentScope();
    }, { userId: args.userId, tenantId: args.tenantId });

    await page.waitForSelector('#content-performance-card:not([style*="display: none"])', { timeout: 8000 })
      .catch(() => { throw new Error('Performance card did not become visible after scope apply'); });
    console.log('✓ Performance card visible after scope apply');

    await page.waitForSelector('#content-canonical-lifecycle-card:not([style*="display: none"])', { timeout: 8000 })
      .catch(() => { throw new Error('Canonical lifecycle card did not become visible after scope apply'); });
    console.log('✓ Canonical lifecycle card visible after scope apply');

    // Allow trailing fetches to settle.
    await page.waitForTimeout(800);

    const panelState = await page.evaluate(() => ({
      performanceMeta: document.getElementById('content-performance-meta')?.textContent || '',
      lifecycleMeta: document.getElementById('content-canonical-lifecycle-meta')?.textContent || '',
    }));
    if (/Failed to load|Network error|No data returned/i.test(panelState.performanceMeta)) {
      throw new Error('Performance card rendered a failed state: ' + panelState.performanceMeta);
    }
    if (/Failed to load|Network error|No data/i.test(panelState.lifecycleMeta)) {
      throw new Error('Canonical lifecycle card rendered a failed state: ' + panelState.lifecycleMeta);
    }

    const lacking = scopedRequests.filter(r =>
      r.userIdHeader !== String(args.userId)
      || r.tenantIdHeader !== String(args.tenantId)
    );
    if (lacking.length > 0) {
      throw new Error(
        `Some V1 admin content requests missing scope headers: \n  - ` +
        lacking.slice(0, 5).map(r => r.url + ' (user=' + r.userIdHeader + ', tenant=' + r.tenantIdHeader + ')').join('\n  - ')
      );
    }
    console.log(`✓ ${scopedRequests.length} V1 admin content requests carried scope headers`);

    const requiredEndpointStatuses = scopedResponses.filter(r =>
      /\/api\/v1\/admin\/content\/(performance|lifecycle)\?/.test(r.url)
    );
    const failingEndpointStatuses = requiredEndpointStatuses.filter(r => r.status < 200 || r.status >= 300);
    if (failingEndpointStatuses.length > 0) {
      throw new Error(
        `Scoped panel endpoints returned non-2xx: \n  - ` +
        failingEndpointStatuses.map(r => r.url + ' status=' + r.status).join('\n  - ')
      );
    }
    console.log(`✓ ${requiredEndpointStatuses.length} scoped panel endpoint responses were 2xx`);

  } catch (err) {
    exitCode = 1;
    console.error('✗ smoke FAILED:', (err && err.message) || String(err));
  } finally {
    await browser.close();
  }
  return exitCode;
}

// ─── Entry ─────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs();
  if (args.validateOnly) {
    const { ok, messages } = validateStructure();
    for (const m of messages) console.log(m);
    if (!ok) {
      console.error(`\n${messages.filter(m => m.startsWith('✗')).length} structural assertions FAILED`);
      process.exit(1);
    }
    console.log(`\nALL STRUCTURAL ASSERTIONS PASSED (${messages.length})`);
    return;
  }
  process.exit(await runLivePlaywrightSmoke(args));
})().catch(err => {
  console.error('content-portal-browser-smoke fatal:', err);
  process.exit(99);
});
