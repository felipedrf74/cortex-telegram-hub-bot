import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Portal route wiring hygiene.
 *
 * Two directions are checked statically (no server boot):
 *
 *   A. Every `registerPortal*Routes` export under `src/portal/` is called from
 *      `createPortalServer()`. Route modules that are written and tested but
 *      never mounted pass their own unit tests while being unreachable in
 *      production — this test makes that state fail loudly.
 *
 *   B. Every `/api/...` literal the admin SPA (`portal.html` + `src/portal/ui`)
 *      fetches resolves to a registered portal route (or an iOS admin route
 *      under `/api/v1/admin/`), and every registered portal route is either
 *      referenced by the SPA or explicitly allowlisted as API-only.
 */

const portalDir = path.resolve(__dirname, '../../src/portal');
const serverSource = fs.readFileSync(path.join(portalDir, 'server.ts'), 'utf8');

/** Route modules that are intentionally not mounted. Keep empty unless reviewed. */
const INTENTIONALLY_UNMOUNTED: string[] = [
  // Legacy composition kept for its unit test; server.ts mounts the split
  // registerPortalWebhookManagementRoutes instead.
  'registerPortalWebhookRoutes',
];

/**
 * Routes registered through exported path constants (not string literals in
 * `app.get(...)`), so the literal scan cannot see them. Prefixes only.
 */
const CONSTANT_ROUTE_PREFIXES = ['/api/chat-core-v2/'];

/**
 * Registered portal routes with no SPA consumer. Each entry needs a reason;
 * routes here are reachable only through direct API calls (curl, scripts,
 * webhook providers) or are scheduled to get a UI in a later portal phase.
 */
const API_ONLY_ROUTES: Record<string, string> = {
  'GET /api/webhooks/whatsapp': 'Meta webhook verification challenge (provider-facing)',
  'POST /api/webhooks/whatsapp': 'Meta webhook receiver (provider-facing)',
  'POST /api/webhooks/:provider': 'Generic webhook receiver (provider-facing)',
  'GET /api/errors': 'Errors & Issues panel (portal phase 2)',
  'GET /api/error-distribution': 'Errors & Issues panel (portal phase 2)',
  'GET /api/chat/diagnostics': 'Chat diagnostics card (portal phase 5)',
  'GET /api/users/:userId/chat-diagnostics': 'User drawer diagnostics tab (portal phase 3)',
  'GET /api/skills': 'Skill catalog read used by scripts; SPA reads snapshot.skillStatus',
  'POST /api/webhooks/subscriptions': 'Subscription management stays API-driven (scripts); the Operate card is read-only',
  'DELETE /api/webhooks/subscriptions/:id': 'Subscription management stays API-driven (scripts); the Operate card is read-only',
  'POST /api/webhooks/events/:id/replay': 'Replay stays API-driven (scripts); the Operate card is read-only',
  'GET /api/portal/eval-history': 'Chat eval evidence store; consumed by src/services/chat-eval-portal-retry.ts and the chat-quality runbook',
  'POST /api/portal/eval-history': 'Chat eval evidence store (service/runbook consumer)',
  'POST /api/portal/eval-history/frozen-baseline': 'Chat eval evidence store (service/runbook consumer)',
  'GET /api/portal/chat-quality': 'Chat quality snapshot for scripts/remote-chat-capability-flag-transaction.sh',
  'GET /api/portal/routing-corpus/next': 'Routing corpus labeling API (operator CLI)',
  'POST /api/portal/routing-corpus/label': 'Routing corpus labeling API (operator CLI)',
  'GET /api/portal/routing-corpus/progress': 'Routing corpus labeling API (operator CLI)',
  'GET /api/training-coach-v2-soak': 'Coach v2 soak metrics for the training release gate scripts',
  'POST /api/training-coach-v2-soak/reviews': 'Coach v2 rule review recording (release gate scripts)',
  'GET /api/content-workspace-metrics': 'Content workspace observability (runtime-and-observability standard)',
  'GET /api/ops/client-errors': 'Raw iOS error rows for scripts; the SPA shows them grouped under Issues (user drawer tab in portal phase 3)',
  'GET /api/users/:userId/decision-center/dashboard': 'Flag-gated (DECISION_DASHBOARD_ENABLED) operator snapshot, curl/scripts only',
  'PUT /api/users/:userId/tier': 'Tier changes are driven by plan entitlement; kept for operator scripts',
  'POST /api/skills/:name/subskills/:sub/enable': 'Sub-skill toggles use POST /api/skills/toggle from the SPA; kept for scripts',
  'POST /api/skills/:name/subskills/:sub/disable': 'Sub-skill toggles use POST /api/skills/toggle from the SPA; kept for scripts',
};

/**
 * Routes whose URL the SPA assembles from a variable action segment
 * (e.g. `'/api/operator-alerts/' + id + '/' + action`), so their static
 * tail cannot be found verbatim in the source. Map route -> SPA fragment
 * that proves the family is consumed.
 */
const SPA_DYNAMIC_ROUTES: Record<string, string> = {
  'POST /api/ops/issues/:id/ack': "'/api/ops/issues/' + id + '/' + action",
  'POST /api/ops/issues/:id/resolve': "'/api/ops/issues/' + id + '/' + action",
  'POST /api/ops/issues/:id/mute': "'/api/ops/issues/' + id + '/' + action",
  'POST /api/ops/issues/:id/reopen': "'/api/ops/issues/' + id + '/' + action",
  'POST /api/operator-alerts/:id/ack': "'/api/operator-alerts/' + id + '/' + action",
  'POST /api/operator-alerts/:id/resolve': "'/api/operator-alerts/' + id + '/' + action",
  'POST /api/operator-alerts/:id/retry-delivery': "'/api/operator-alerts/' + id + '/' + action",
  'GET /api/jobs/:name/history': "'/api/jobs/' + encodeURIComponent(name) + '/history'",
  'POST /api/jobs/:name/run': "'/api/jobs/' + encodeURIComponent(name) + '/run'",
  'POST /api/ops/queues/:kind/:id/replay': "'/api/ops/queues/' + kind + '/' + encodeURIComponent(id) + '/' + action",
  'POST /api/ops/queues/:kind/:id/cancel': "'/api/ops/queues/' + kind + '/' + encodeURIComponent(id) + '/' + action",
  'POST /api/ops/flags/kill-switches/:key': "'/api/ops/flags/kill-switches/' + encodeURIComponent(key)",
};

function listPortalSources(): { file: string; source: string }[] {
  return fs.readdirSync(portalDir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ file, source: fs.readFileSync(path.join(portalDir, file), 'utf8') }));
}

function listUiSources(): string {
  const parts = [fs.readFileSync(path.join(portalDir, 'portal.html'), 'utf8')];
  const uiDir = path.join(portalDir, 'ui');
  if (fs.existsSync(uiDir)) {
    for (const file of fs.readdirSync(uiDir)) {
      if (file.endsWith('.js')) parts.push(fs.readFileSync(path.join(uiDir, file), 'utf8'));
    }
  }
  return parts.join('\n');
}

function registeredRoutes(): { method: string; path: string; file: string }[] {
  const routes: { method: string; path: string; file: string }[] = [];
  const literal = /app\.(get|post|put|delete|patch)\(\s*['`]([^'`]+)['`]/g;
  for (const { file, source } of listPortalSources()) {
    let match: RegExpExecArray | null;
    while ((match = literal.exec(source)) !== null) {
      routes.push({ method: match[1].toUpperCase(), path: match[2], file });
    }
  }
  return routes;
}

function uiApiLiterals(uiSource: string): Set<string> {
  const literals = new Set<string>();
  const pattern = /['"`](\/api\/[A-Za-z0-9_\-/.]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(uiSource)) !== null) {
    literals.add(match[1].replace(/\/+$/, ''));
  }
  return literals;
}

describe('portal route registration hygiene', () => {
  it('mounts every exported registerPortal*Routes function in createPortalServer()', () => {
    const missing: string[] = [];
    const exportPattern = /export function (registerPortal\w+Routes)\b/g;
    for (const { file, source } of listPortalSources()) {
      if (file === 'server.ts') continue;
      let match: RegExpExecArray | null;
      while ((match = exportPattern.exec(source)) !== null) {
        const name = match[1];
        if (INTENTIONALLY_UNMOUNTED.includes(name)) continue;
        if (!serverSource.includes(`${name}(app`)) missing.push(`${name} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('only fetches /api paths from the SPA that resolve to a registered route', () => {
    const routes = registeredRoutes();
    const literals = uiApiLiterals(listUiSources());
    const unresolved: string[] = [];
    for (const literal of literals) {
      if (literal.startsWith('/api/v1/admin/') || literal === '/api/v1') continue;
      if (CONSTANT_ROUTE_PREFIXES.some((prefix) => literal.startsWith(prefix))) continue;
      const resolves = routes.some((route) => route.path === literal || route.path.startsWith(`${literal}/`));
      if (!resolves) unresolved.push(literal);
    }
    expect(unresolved).toEqual([]);
  });

  it('keeps every registered portal route either consumed by the SPA or allowlisted as API-only', () => {
    const uiSource = listUiSources();
    const orphans: string[] = [];
    for (const route of registeredRoutes()) {
      // Health, OAuth callbacks and static pages are not SPA fetch targets.
      if (!route.path.startsWith('/api/')) continue;
      const key = `${route.method} ${route.path}`;
      if (API_ONLY_ROUTES[key]) continue;
      if (SPA_DYNAMIC_ROUTES[key]) {
        if (!uiSource.includes(SPA_DYNAMIC_ROUTES[key])) orphans.push(`${key} (dynamic fragment missing)`);
        continue;
      }
      // Static segments between :params must all appear in the SPA source.
      const segments = route.path.split(/:[^/]+/).map((seg) => seg.replace(/\/+$/, '')).filter(Boolean);
      const consumed = segments.every((seg) => uiSource.includes(seg));
      if (!consumed) orphans.push(`${key} (${route.file})`);
    }
    expect(orphans).toEqual([]);
  });

  it('does not allowlist routes that no longer exist', () => {
    const registered = new Set(registeredRoutes().map((route) => `${route.method} ${route.path}`));
    const stale = [...Object.keys(API_ONLY_ROUTES), ...Object.keys(SPA_DYNAMIC_ROUTES)].filter((key) => !registered.has(key));
    expect(stale).toEqual([]);
  });
});
