// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Nexus Hub Status Portal — Express server.
 *
 * Runs inside the main Nexus Hub Node.js process.
 * Provides:
 *   GET  /              → serves the single-page dashboard (portal.html)
 *   GET  /api/snapshot  → full JSON payload for the dashboard (cached 3s)
 *   POST /api/action/:name → quick actions (refresh garmin, trigger reports, etc.)
 *
 * Auth: scoped Bearer portal credentials or signed ps_ operator sessions on /api/* routes.
 * `PORTAL_TOKEN` remains legacy-compatible only when scoped credentials are
 * absent or explicit legacy fallback is enabled.
 */
import compression from 'compression';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { config } from '../config';
import { getDb } from '../services/database';
import {
  expireSubscriptions,
  setDbProvider as setWebhookDbProvider,
} from '../services/webhook-registry';
import { getActiveUserTargets, getOwnerBootstrapTarget } from '../services/user-service';
import { shouldStartContentLiveEvalBackgroundServices } from '../services/content-live-evaluation-runtime';
import { logger } from '../utils/logger';
import { generateRequestId, runWithContext } from '../utils/request-context';
import { requirePortalTokenByMethod } from '../api/secret-guards';
import { rateLimitMiddleware } from '../api/rate-limiter';
import { createAdminPreBodyGuard } from '../api/admin-pre-body-guard';
import {
  getConfiguredPortalCredentials,
  validatePortalAdminBetaReadiness,
  validatePortalCredentialStrength,
} from './security';
import { registerPortalAdminDataRoutes } from './admin-data-routes';
import { registerPortalActionRoutes } from './action-routes';
import { registerPortalChatQualityRoutes } from './chat-quality-routes';
import { registerPortalChatRoutes } from './chat-routes';
import { registerPortalChatCoreV2GateRoutes } from './chat-core-v2-gate-routes';
import { registerPortalChatCoreV2ObservabilityRoutes } from './chat-core-v2-observability-routes';
import { registerPortalCookingRoutes } from './cooking-routes';
import { registerPortalDecisionCenterRoutes } from './decision-center-routes';
import { registerPortalDocumentRoutes } from './document-routes';
import { registerPortalEnvironmentRoutes } from './environment-routes';
import { registerPortalEvalHistoryRoutes } from './eval-history-routes';
import { registerPortalFounderRoutes } from './founder-routes';
import { registerPortalHealthRoutes } from './health-routes';
import { registerPortalInviteRoutes } from './invite-routes';
import { registerPortalOperationsRoutes } from './operations-routes';
import { registerPortalOAuthRoutes } from './oauth-routes';
import { registerPortalPlanRoutes } from './plan-routes';
import { registerPortalProviderRoutes } from './provider-routes';
import { registerPortalRoutingCorpusRoutes } from './routing-corpus-routes';
import { registerPortalSkillRoutes } from './skill-routes';
import { buildPortalSnapshot } from './snapshot-builder';
import { registerPortalSnapshotRoutes } from './snapshot-routes';
import { registerPortalSettingsRoutes } from './settings-routes';
import { registerPortalStaticRoutes } from './static-routes';
import { registerPortalUserRoutes } from './user-routes';
import { registerPortalUserSkillRoutes } from './user-skill-routes';
import { registerPortalWaitlistRoutes } from './waitlist-routes';
import {
  registerPortalWebhookManagementRoutes,
  registerPublicPortalWebhookRoutes,
} from './webhook-routes';

// ─── Uptime Helper ──────────────────────────────────────────────────

const startedAt = Date.now();

// ─── Cache warming targets ──────────────────────────────────────────

const DASHBOARD_WARM_MAX_USERS = 20;
const DASHBOARD_WARM_STAGGER_MS = 500;

/**
 * Users whose dashboard cache is warmed at boot and refreshed periodically.
 * Bounded to the most recently active users so warming stays cheap; the
 * owner bootstrap user is included only as a fallback when nothing else is
 * active (fresh deployments).
 */
export function resolveDashboardWarmTargets(): number[] {
  const seen = new Set<number>();
  const targets: number[] = [];
  const push = (tenantId: number | null | undefined) => {
    if (typeof tenantId !== 'number' || !Number.isFinite(tenantId) || seen.has(tenantId)) return;
    seen.add(tenantId);
    targets.push(tenantId);
  };
  try {
    getActiveUserTargets().forEach((target) => push(target?.tenantId));
  } catch {
    // Fall through to the owner fallback below.
  }
  if (targets.length === 0) {
    push(getOwnerBootstrapTarget()?.tenantId);
  }
  return targets.slice(0, DASHBOARD_WARM_MAX_USERS);
}

// ─── Express App Factory ────────────────────────────────────────────

export function isUnsafePublicPortalBind(bind: string | undefined): boolean {
  const normalized = (bind || '').trim().toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

export function createPortalSecurityHeadersMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; "
      + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
      + "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; "
      + "connect-src 'self' https://api.nexushub.me https://*.nexushub-landing.pages.dev; "
      + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  };
}

export function createResponseCompressionMiddleware() {
  return compression({
    threshold: 1024,
    level: 6,
    filter(req: Request, res: Response) {
      const contentType = String(res.getHeader('Content-Type') ?? '').toLowerCase();
      if (/^(image|video|audio)\//.test(contentType)) return false;
      if (/application\/(zip|gzip|x-gzip|pdf)/.test(contentType)) return false;
      return compression.filter(req, res);
    },
  });
}

export function createPortalServer(): http.Server {
  const app = express();

  // The registry deliberately receives its database lazily to avoid module
  // cycles; wire it before any callback or startup expiry scan can use it.
  setWebhookDbProvider(() => getDb() as any);

  app.use(createPortalSecurityHeadersMiddleware());

  // ── Request logging + tracing middleware (audit QW-15 + Quarter) ───
  // Wraps every HTTP request in two layers:
  //   1. A request-context (Quarter: distributed tracing) so all log
  //      calls during the request automatically include reqId/src/userId.
  //      If the upstream sent us an X-Request-Id header, we honor it
  //      (this is what makes "follow a single request through the API
  //      → portal → content-engine" possible). Otherwise we generate a
  //      fresh ID and echo it back in the response so the client can
  //      reference it in bug reports.
  //   2. A structured pino log on res.finish with method, path, status,
  //      duration, and userId. The reqId is added automatically by the
  //      logger mixin so we don't have to thread it manually.
  //
  // We hook res.on('finish') instead of wrapping res.end to keep the
  // middleware non-invasive. The auth middleware (further down the chain)
  // populates req.userId before res.send happens, so by the time finish
  // fires we can read it from the modified request object.
  //
  // Why not pino-http? pino-http is a separate package and the project's
  // CLAUDE.md says "no third-party HTTP libs". A 30-line bespoke middleware
  // does the same job here.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incomingId = req.header('x-request-id');
    const requestId = incomingId || generateRequestId();
    // Echo the ID back so the client can quote it in bug reports.
    res.setHeader('x-request-id', requestId);

    runWithContext({ requestId, source: 'http' }, () => {
      const start = process.hrtime.bigint();
      const path = req.path;
      res.on('finish', () => {
        const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
        const userId = (req as any).userId as number | undefined;
        const isHealthOrSnapshot = path === '/health' || path === '/api/snapshot';
        // Skip noisy health-check polling at info level — log them at debug
        // so they're visible if you crank up LOG_LEVEL but don't fill the
        // normal log stream. The portal dashboard polls /api/snapshot every
        // 5 seconds.
        const logLevel = isHealthOrSnapshot ? 'debug' : 'info';
        logger[logLevel](
          {
            method: req.method,
            path,
            status: res.statusCode,
            durationMs,
            userId,
            ip: req.ip || req.socket?.remoteAddress,
          },
          'http',
        );
      });
      next();
    });
  });

  app.use(createResponseCompressionMiddleware());

  // Provider callbacks must see the exact request bytes and cannot present a
  // portal operator credential. Keep only the externally called, self-
  // authenticating webhook surface before the global JSON parser and portal
  // auth; its routes carry their own unauthenticated IP limiter.
  registerPublicPortalWebhookRoutes(app);

  // ── Webhook router (TASK-16b) ───────────────────────────────────────
  // Mounted BEFORE express.json() because the Todoist webhook needs the
  // raw bytes for HMAC verification. The router uses its own scoped
  // express.raw() parser and JSON.parses the body manually after verifying.
  try {
    const { createWebhookRouter } = require('../api/routes/webhooks');
    app.use('/webhooks', createWebhookRouter());
  } catch (err) {
    logger.warn({ err }, 'Webhook router failed to mount (non-fatal)');
  }

  // ── Waitlist router (landing page public form) ─────────────────────
  // Mounted at root /waitlist so it bypasses the portal token auth on /api.
  // The router has its own scoped express.json() parser and rate limiter.
  try {
    const { createWaitlistRouter } = require('../api/routes/waitlist');
    app.use('/waitlist', createWaitlistRouter());
  } catch (err) {
    logger.warn({ err }, 'Waitlist router failed to mount (non-fatal)');
  }

  // ── Public website checkout (landing page Stripe handoff) ──────────
  // Mounted at root /billing so nexushub.me can start Stripe Checkout
  // without a Nexus account session. Authenticated billing stays under
  // /api/v1/billing and never trusts client-supplied price IDs.
  try {
    const { createPublicBillingRouter } = require('../api/routes/public-billing');
    app.use('/billing', createPublicBillingRouter());
  } catch (err) {
    logger.warn({ err }, 'Public billing router failed to mount (non-fatal)');
  }

  // ── iOS API (mounted before the global JSON parser) ──────────────────
  if (config.ios?.enabled) {
    // Initialize SQLite-backed cache store (survives restarts)
    try {
      const { initCacheStore, clearExpired } = require('../services/cache-store');
      initCacheStore();
      setInterval(clearExpired, 60 * 60 * 1000);
    } catch (err) {
      logger.error({ err }, 'Failed to initialize cache store');
    }

    const { createApiRouter } = require('../api/router');
    // Product-learning admin requests are authenticated inside createApiRouter,
    // before the shared JWT limiter is mounted. Apply a narrow IP guard before
    // any body parsing so invalid credentials cannot grow portal.auth audit
    // rows without bound, and keep this tiny contract off the 8 MB upload cap.
    app.use(
      '/api/v1/admin/product-learning',
      createAdminPreBodyGuard({ bucketName: 'admin-product-learning-ip' }),
    );
    app.use(
      '/api/v1/admin/content',
      createAdminPreBodyGuard({
        // Preserve the existing /api/v1 request-size contract; this mount is
        // here to bound work before either JSON parsing or portal-token audit.
        bodyLimitBytes: 8 * 1024 * 1024,
        bucketName: 'admin-content-ip',
      }),
    );
    app.use(
      '/api/v1/admin/local-inference',
      createAdminPreBodyGuard({ bucketName: 'admin-local-inference-ip' }),
    );
    app.use(
      '/api/v1/admin/hybrid-kill-switches',
      createAdminPreBodyGuard({ bucketName: 'admin-hybrid-kill-switches-ip' }),
    );
    app.use('/api/v1/billing/nexus-points/stripe-checkout', (req: Request, res: Response, next: NextFunction) => {
      const rawLength = req.headers['content-length'];
      const contentLength = Array.isArray(rawLength) ? Number(rawLength[0]) : Number(rawLength || 0);
      if (Number.isFinite(contentLength) && contentLength > 8 * 1024) {
        res.status(413).json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
        return;
      }
      next();
    });
    // Receipt uploads send base64-encoded images, so the iOS surface needs
    // a larger JSON cap than the rest of the portal.
    app.use('/api/v1', express.json({ limit: '8mb' }), createApiRouter());
    logger.info('iOS API enabled on /api/v1');

    // Warm caches on startup so first app open is instant. Warming used to
    // target only the owner bootstrap user; it now covers the active user
    // set (bounded) so no single tenant is privileged at runtime.
    if (shouldStartContentLiveEvalBackgroundServices()) try {
      const { warmTaskCache } = require('../api/routes/tasks');
      const { warmDashboardCache } = require('../api/routes/dashboard');
      const warmTargets = resolveDashboardWarmTargets();

      // Stagger startup warming: dashboard first (slowest), then tasks
      warmTargets.forEach((userId, index) => {
        const offsetMs = index * DASHBOARD_WARM_STAGGER_MS;
        setTimeout(() => warmDashboardCache(userId).catch(() => {}), 3000 + offsetMs);
        // Periodic refresh: dashboard every 3 min, tasks every 2 min
        setInterval(() => warmDashboardCache(userId).catch(() => {}), 3 * 60 * 1000 + offsetMs);
      });
      setTimeout(() => warmTaskCache().catch(() => {}), 5000);
      setInterval(() => warmTaskCache().catch(() => {}), 2 * 60 * 1000);
    } catch (err) {
      logger.debug({ err }, 'Cache warming setup failed (non-critical)');
    }

    // Ensure ios_devices table exists
    try {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS ios_devices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          device_id TEXT NOT NULL UNIQUE,
          device_name TEXT,
          push_token TEXT,
          refresh_token TEXT NOT NULL,
          last_active_at TEXT DEFAULT (datetime('now')),
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    } catch (err) {
      logger.error({ err }, 'Failed to create ios_devices table');
    }
  }


  // Live-eval evidence can legitimately exceed Express's 100 KB default.
  // Mount this narrowly scoped route family before the global parser so its
  // own limiter -> admin auth -> 2 MB/32 KB parser chain receives the raw
  // request stream. All other portal routes retain the smaller global cap.
  registerPortalEvalHistoryRoutes(app);

  app.use(express.json());

  // ── AI provider routing (must initialize BEFORE any AI call) ─────────
  //
  // Two responsibilities:
  //   1. initDomainRouting() loads the feature flags (gemini routing on/off,
  //      include-secretary, per-domain set) from env + kv_store
  //   2. createRoutingProvider() instantiates the actual TaskRoutingProvider
  //      and stores it in the module-level _activeProvider singleton that
  //      domain-handler.ts looks up via getActiveProvider()
  //
  // Without #2, getActiveProvider() returns null and every domain call falls
  // through to the direct-Anthropic fallback path — which is what was
  // happening before this fix. The dashboard would show "0 Gemini calls" no
  // matter what the routing config said.
  //
  // This block runs unconditionally (NOT inside the iOS-gated block below)
  // because scheduled jobs also route through the same AI providers and
  // need the routing system regardless of whether iOS is enabled.
  try {
    const { initDomainRouting } = require('../services/domain-provider-router');
    initDomainRouting();
    const { createRoutingProvider, getActiveProvider } = require('../services/provider-registry');
    createRoutingProvider();
    const active = getActiveProvider();
    if (active) {
      const { getDomainProviderConfig } = require('../services/domain-provider-router');
      const cfg = getDomainProviderConfig();
      logger.info(
        {
          activeProvider: active.name || 'TaskRoutingProvider',
          domains: cfg.map((d: { domain: string; provider: string }) => `${d.domain}→${d.provider}`).join(', '),
        },
        '✅ AI provider routing active',
      );
    } else {
      logger.warn('createRoutingProvider() returned null — all AI calls will fall back to direct Anthropic');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to initialize AI provider routing — falling back to direct Anthropic on every call');
  }

  // ── OAuth Callback Routes (no auth — public redirect targets) ──────
  registerPortalOAuthRoutes(app);

  // ── Health Check ──────────────────────────────────────────────────
  registerPortalHealthRoutes(app, {
    startedAt,
    buildSnapshot: () => buildPortalSnapshot(startedAt),
  });

  // ── Auth middleware for /api/* ──────────────────────────────────
  const configuredPortalTokens = getConfiguredPortalCredentials(config.portal);

  // PORTAL_TOKEN strength check (M-3 mitigation, 2026-04-21 pass 2).
  //
  // The portal still uses static bearer credentials and no session
  // system, so the threat model collapses onto "how hard is the token
  // to guess or harvest?" We now support optional read/write-scoped
  // tokens, but every configured credential must still clear the same
  // minimum bar before we even bind the admin surface.
  //
  // We refuse to even BIND a portal with a known-weak token. The floor
  // is 12 chars: at 72 symbols/char (alnum + a few punct) that's
  // ~1.9e22 combinations — cryptographically infeasible to brute-force
  // even against a fast endpoint. Raising the floor to 16 breaks real
  // existing deployments whose tokens are 15 chars and still plenty
  // strong (hotfix 2026-04-21 after the initial 16-char threshold
  // caused a prod crash-loop). The block-list below catches the actual
  // historical foot-guns — 'changeme', 'admin', 'password' etc.
  // Admins that need a throwaway local preview can leave PORTAL_TOKEN
  // empty, but request-time bypass is now explicit via
  // PORTAL_ALLOW_LOCAL_BYPASS=true and loopback-only in non-production.
  validatePortalCredentialStrength(configuredPortalTokens);

  // Gap 5 preflight: classify admin exposure and refuse to boot when the
  // declared beta-hardened policy cannot be satisfied. Emits a structured
  // warning when admin is exposed in production without signed sessions or
  // actor signatures, so the on-call runbook has a single log line to check.
  validatePortalAdminBetaReadiness(config.portal);

  // AUTH-O10 (closed-beta-auth-hardening, 2026-05-04): mount the IP-bucket
  // rate limiter on portal `/api/*` (not `/api/v1/*` — iOS already mounts
  // its own at `createApiRouter()` above). Without this, distributed
  // brute-force against the portal token would be unbounded.
  // The rate limiter is unauthenticated-safe (falls back to IP bucket
  // when no userId is on the request).
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/v1/') || req.path.startsWith('/v1')) {
      return next();
    }
    return rateLimitMiddleware(req, res, next);
  });

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // Skip portal auth for iOS API routes — they use their own JWT middleware
    if (req.path.startsWith('/v1/') || req.path.startsWith('/v1')) {
      return next();
    }
    return requirePortalTokenByMethod(req, res, next);
  });

  registerPortalStaticRoutes(app);

  registerPortalSnapshotRoutes(app, {
    buildSnapshot: () => buildPortalSnapshot(startedAt),
  });

  registerPortalEnvironmentRoutes(app, { startedAt });

  registerPortalSkillRoutes(app);

  registerPortalCookingRoutes(app);

  registerPortalDecisionCenterRoutes(app);

  registerPortalActionRoutes(app);

  registerPortalDocumentRoutes(app);

  registerPortalOperationsRoutes(app);

  registerPortalProviderRoutes(app);

  registerPortalUserRoutes(app);

  registerPortalInviteRoutes(app);

  registerPortalPlanRoutes(app);

  registerPortalFounderRoutes(app);

  registerPortalAdminDataRoutes(app);

  registerPortalChatRoutes(app);

  registerPortalChatQualityRoutes(app);

  registerPortalRoutingCorpusRoutes(app);

  registerPortalUserSkillRoutes(app);

  registerPortalWaitlistRoutes(app);

  registerPortalSettingsRoutes(app);

  registerPortalWebhookManagementRoutes(app);

  // Chat Core v2 operator observability + gate readiness (default-off: the
  // register functions no-op unless CHAT_CORE_V2_ORCHESTRATOR_MODE != off).
  registerPortalChatCoreV2ObservabilityRoutes(app);

  registerPortalChatCoreV2GateRoutes(app);

  // ── Start HTTP server ──────────────────────────────────────────
  const server = http.createServer(app);
  const bind = config.portal.bind;
  const port = config.portal.port;

  // Expire stale webhook subscriptions on server start
  try { expireSubscriptions(); } catch { /* non-critical */ }

  // Handle listen errors gracefully — EADDRINUSE should NOT crash the process
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error({ port, bind }, `Portal port ${port} already in use — portal disabled but process continues`);
    } else {
      logger.error({ err, port, bind }, 'Portal server error');
    }
  });

  // Attach WebSocket server for iOS streaming only when explicitly enabled.
  // Release builds use REST-only chat until the stream transport is promoted
  // from experimental to production-grade.
  if (config.ios?.enabled && config.ios?.websocketEnabled) {
    try {
      const { attachWebSocket } = require('../api/websocket');
      attachWebSocket(server);
    } catch (err) {
      logger.error({ err }, 'Failed to attach WebSocket server');
    }
  }

  server.listen(port, bind, () => {
    logger.info({ port, bind }, `Nexus Hub Status Portal running at http://${bind}:${port}`);
    if (!config.portal.adminToken && (config.portal.writeToken || config.portal.readToken)) {
      logger.warn(
        {
          hasLegacyToken: Boolean(config.portal.token),
          hasReadToken: Boolean(config.portal.readToken),
          hasWriteToken: Boolean(config.portal.writeToken),
        },
        'PORTAL_ADMIN_TOKEN not set — remote sensitive portal mutations will reject requests until a dedicated admin token is configured',
      );
    }
    if (!config.portal.adminToken && config.portal.token && !config.portal.readToken && !config.portal.writeToken) {
      logger.warn('PORTAL_ADMIN_TOKEN not set — admin mutations still rely on the legacy PORTAL_TOKEN. Configure a dedicated admin token to split operator scope.');
    }
    if (configuredPortalTokens.length === 0 && config.portal.allowLocalBypass) {
      logger.warn('No portal admin token is set — admin API is only available from loopback because PORTAL_ALLOW_LOCAL_BYPASS=true');
    }
    if (configuredPortalTokens.length === 0 && !config.portal.allowLocalBypass) {
      logger.warn('No portal admin token is set — admin API will reject portal requests until a token is configured');
    }
    if (!config.health.token && config.health.allowUnauthenticatedDetailed) {
      logger.warn('HEALTH_TOKEN not set — /health/detailed is only available from loopback because HEALTH_ALLOW_UNAUTHENTICATED=true');
    }
    if (!config.health.token && !config.health.allowUnauthenticatedDetailed) {
      logger.warn('HEALTH_TOKEN not set — /health/detailed will reject requests until a token is configured');
    }
  });

  return server;
}
