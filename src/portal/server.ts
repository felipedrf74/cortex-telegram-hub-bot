// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Nexus Hub Status Portal — Express server.
 *
 * Runs inside the same Node.js process as the Grammy bot.
 * Provides:
 *   GET  /              → serves the single-page dashboard (portal.html)
 *   GET  /api/snapshot  → full JSON payload for the dashboard (cached 3s)
 *   POST /api/action/:name → quick actions (refresh garmin, trigger reports, etc.)
 *
 * Auth: scoped Bearer portal credentials or signed ps_ operator sessions on /api/* routes.
 * `PORTAL_TOKEN` remains legacy-compatible only when scoped credentials are
 * absent or explicit legacy fallback is enabled.
 */
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
// fs + path used by the /owner-ui + /admin-console + /console + /user-console
// shell-serve handlers. These are legacy-shaped (inline fs.readFileSync) from
// the OI-USR-404/OI-NAV-203 additions; a follow-up should move them into
// static-routes.ts alongside createAdminDashboardHandler so we can drop these
// imports from server.ts. — 2026-04-24 rebase onto decomposed server.ts
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getDb } from '../services/database';
import { expireSubscriptions } from '../services/webhook-registry';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { logger } from '../utils/logger';
import { generateRequestId, runWithContext } from '../utils/request-context';
import { requirePortalTokenByMethod } from '../api/secret-guards';
import {
  getConfiguredPortalCredentials,
  validatePortalCredentialStrength,
} from './security';
import { registerPortalAdminDataRoutes } from './admin-data-routes';
import { registerPortalActionRoutes } from './action-routes';
import { registerPortalContentRoutes } from './content-routes';
import { registerPortalDocumentRoutes } from './document-routes';
import { registerPortalFounderRoutes } from './founder-routes';
import { registerPortalHealthRoutes } from './health-routes';
import { registerPortalIntelligenceRoutes } from './intelligence-routes';
import { registerPortalInviteRoutes } from './invite-routes';
import { registerPortalOperationsRoutes } from './operations-routes';
import { registerPortalOAuthRoutes } from './oauth-routes';
import { registerPortalPlanRoutes } from './plan-routes';
import { registerPortalProviderRoutes } from './provider-routes';
import { registerPortalSkillRoutes } from './skill-routes';
import { buildPortalSnapshot } from './snapshot-builder';
import { registerPortalSnapshotRoutes } from './snapshot-routes';
import { registerPortalSettingsRoutes } from './settings-routes';
import { registerPortalStaticRoutes } from './static-routes';
import { registerPortalUserRoutes } from './user-routes';
import { registerPortalUserSkillRoutes } from './user-skill-routes';
import { registerPortalWaitlistRoutes } from './waitlist-routes';
import { registerPortalWebhookRoutes } from './webhook-routes';

// ─── Uptime Helper ──────────────────────────────────────────────────

const startedAt = Date.now();

// ─── Express App Factory ────────────────────────────────────────────

export function createPortalServer(bot?: any): http.Server {
  const app = express();

  // ── Request logging + tracing middleware (audit QW-15 + Quarter) ───
  // Wraps every HTTP request in two layers:
  //   1. A request-context (Quarter: distributed tracing) so all log
  //      calls during the request automatically include reqId/src/userId.
  //      If the upstream sent us an X-Request-Id header, we honor it
  //      (this is what makes "follow a single request through the bot
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

  // ── Webhook router (TASK-16b + Month 2: Telegram webhooks) ─────────
  // Mounted BEFORE express.json() because the Todoist webhook needs the
  // raw bytes for HMAC verification. The router uses its own scoped
  // express.raw() parser and JSON.parses the body manually after verifying.
  //
  // The Telegram webhook handler (mounted ONLY when config.telegram.webhookUrl
  // is set) uses its OWN scoped express.json() inside the route definition,
  // so it works fine even though the global express.json() runs later.
  // Passing `bot` here gives the router access to grammy's webhookCallback.
  try {
    const { createWebhookRouter } = require('../api/routes/webhooks');
    app.use('/webhooks', createWebhookRouter(bot));
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
    // Receipt uploads send base64-encoded images, so the iOS surface needs
    // a larger JSON cap than the rest of the portal.
    app.use('/api/v1', express.json({ limit: '8mb' }), createApiRouter());
    logger.info('iOS API enabled on /api/v1');

    // Warm ALL caches on startup so first app open is instant
    try {
      const { warmTaskCache } = require('../api/routes/tasks');
      const { warmDashboardCache } = require('../api/routes/dashboard');
      const ownerTarget = getOwnerBootstrapTarget();
      const userId = ownerTarget?.tenantId ?? null;

      // Stagger startup warming: dashboard first (slowest), then tasks
      if (userId) {
        setTimeout(() => warmDashboardCache(userId).catch(() => {}), 3000);
        // Periodic refresh: dashboard every 3 min, tasks every 2 min
        setInterval(() => warmDashboardCache(userId).catch(() => {}), 3 * 60 * 1000);
      }
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

  // ── /workspace-ui — Minimal tenant-workspace HTML demo ──────────────
  //
  // Single HTML file served at GET /workspace-ui so the Phase-1 MVP
  // workspace endpoints can be exercised from a browser. NOT a Phase-3
  // SPA — that work splits portal.html into owner + workspace apps.
  // This is a 440-line zero-build demo meant for local review only.
  app.get('/workspace-ui', (_req: Request, res: Response) => {
    const htmlPath = path.join(__dirname, 'workspace-ui.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('workspace-ui.html not found in dist/portal (run npm run build)');
      return;
    }
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  });

  // ── /owner-ui — Minimal owner-console HTML demo ─────────────────────
  //
  // Mirrors /workspace-ui: single HTML, zero-build, vanilla JS. Sends
  // Authorization: Bearer <portal-token> + X-Admin-User-Id so both
  // gates of the /owner/* router are exercised. Login screen prompts
  // for BOTH credentials (token + admin user id).
  app.get('/owner-ui', (_req: Request, res: Response) => {
    const htmlPath = path.join(__dirname, 'owner-ui.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('owner-ui.html not found in dist/portal (run npm run build)');
      return;
    }
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  });

  // ── /admin and /console — new top-level IA shells (2026-04-22) ────
  //
  // Part of the admin/user-console IA pass
  // (feature/nexus-hub-portal-uiux-admin-user-console). See
  //   docs/portal/nexus-hub-portal-uiux-admin-user-console-spec.md
  // These serve NEW HTML shells that reorganize the existing portal
  // capabilities into two disjoint consoles:
  //   /admin   → admin-console.html (platform-owner + platform-admin scope)
  //   /console → user-console.html  (tenant-scoped power user workspace)
  //
  // Both are additive. /portal, /owner-ui, /workspace-ui still resolve
  // to their existing HTML unchanged — nothing is removed or hidden.
  const serveShell = (filename: string) => (_req: Request, res: Response) => {
    const htmlPath = path.join(__dirname, filename);
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send(filename + ' not found in dist/portal (run npm run build)');
      return;
    }
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  };
  // OI-NAV-201 (2026-04-24): /admin now serves the new Admin Console
  // shell (wired in static-routes.ts#registerPortalStaticRoutes).
  // /admin-console stays alive as a 301 redirect for permanent
  // bookmark preservation — old bookmarks and deep links keep
  // working indefinitely without us carrying two parallel route
  // handlers. 301 (permanent) tells browsers + iOS + monitors to
  // update their cached URL; 302 would force the hop forever.
  app.get('/admin-console', (_req: Request, res: Response) => {
    res.redirect(301, '/admin');
  });
  app.get('/console', serveShell('user-console.html'));
  app.get('/user-console', serveShell('user-console.html'));

  // ── /invite/accept — invitation acceptance landing (2026-04-22) ──
  //
  // OI-NAV-203 from the UI/UX pass open-items. Pairs with the
  // Team → Invite button in the User Console, which generates a
  // link of the shape
  //   {origin}/invite/accept?code=<invite_code>
  //
  // The landing page:
  //   (1) strips ?code=… from the URL on load (history.replaceState)
  //       so screenshots / copy-link / browser-history don't carry
  //       the live secret,
  //   (2) prompts for an iOS JWT if none is cached in sessionStorage,
  //   (3) POSTs to /workspace/my-invites/:code/accept (existing),
  //   (4) handles every documented error shape from that endpoint
  //       (NOT_FOUND, EMAIL_MISMATCH, EXPIRED, REVOKED,
  //       ALREADY_ACCEPTED, 401, network) with a bespoke UI state,
  //   (5) on success, persists the newly-joined tenant as
  //       nx.usr.tenantId so /console lands on the right workspace.
  app.get('/invite/accept', serveShell('invite-accept.html'));

  // ── /invite/inspect/:code (OI-NAV-203a, 2026-04-24) ─────────────────
  //
  // Unauthenticated read of invite metadata for the cold-invitee
  // flow. Returns enough info for the landing UI to decide between
  //   - "sign in to accept" (invitee email has an account already)
  //   - "create an account to accept" (first-time Nexus Hub user)
  // without requiring the invitee to first paste an iOS JWT (which
  // a cold invitee without the iOS app installed cannot produce).
  //
  // Exposed to anyone holding the code, same disclosure level as
  // the invite email itself. Does NOT leak inviting user id, other
  // tenants' data, or any internal ids — see PublicInviteInfo for
  // the strict subset returned.
  app.get('/invite/inspect/:code', async (req: Request, res: Response) => {
    try {
      // Lazy-load to avoid pulling services into server.ts's
      // require graph at boot — matches the existing require-in-
      // handler pattern used elsewhere in this file.
      const { getPublicInviteInfo } = require('../services/tenant-invite-service');
      const code = String(req.params.code || '');
      const info = getPublicInviteInfo(code);
      // Response is uniformly 200 — the UI renders based on
      // `valid` + `reason` + `isExpired` + `hasAccount`. We do NOT
      // 404 on missing codes because the response is a well-formed
      // "no match" envelope, and 404ing would leak code-guessing
      // oracle info via status codes. (A 404 would be identical to
      // "valid: false, reason: 'not_found'" from a timing standpoint,
      // so this is a belt-and-suspenders move.)
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, data: info, timestamp: new Date().toISOString() });
    } catch (e) {
      logger.error({ err: e }, 'portal: /invite/inspect/:code failed');
      res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL', message: 'Failed to inspect invite' },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── POST /invite/request-signup-link (OI-NAV-203b, 2026-04-24) ──
  //
  // Cold-invitee flow: the invitee (who has no account and no iOS
  // token) requests a magic-link email that will eventually create
  // their account + accept the invite (consume handler is tracked
  // as OI-NAV-203c — requires a user-from-email creation decision).
  //
  // This endpoint ONLY issues the token + dispatches to the mailer.
  // It does NOT create a user, does NOT issue a session, and does
  // NOT touch the invite row — all those live downstream on the
  // consume side.
  //
  // Rate-limit surface: unauthenticated by design (cold invitees
  // have no JWT). Email is taken from the invite row, not the
  // request body, so an attacker holding a code can't direct the
  // link somewhere else. The code itself is the shared secret.
  app.post('/invite/request-signup-link', express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const { getPublicInviteInfo } = require('../services/tenant-invite-service');
      const { issueMagicLinkToken } = require('../services/magic-link-service');
      const { sendMagicLink } = require('../services/mailer');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const code = typeof body.code === 'string' ? body.code : '';
      if (!code) {
        res.status(400).json({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'code is required' },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      const info = getPublicInviteInfo(code);
      if (!info.valid) {
        // Don't echo back the specific reason — the response is
        // uniformly "we tried" to avoid giving attackers an oracle
        // on code validity (consistent with /invite/inspect's
        // 200-for-everything shape).
        res.json({
          ok: true,
          data: { sent: true, debugReason: 'invalid_code' },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (info.status !== 'pending' || info.isExpired) {
        res.json({
          ok: true,
          data: { sent: true, debugReason: 'invite_not_accepting' },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      // Issue the token tied to this invite.
      const { rawToken, row } = issueMagicLinkToken({
        email: info.inviteeEmail,
        intent: 'invite_signup',
        tenantId: null, // tenant_id is derivable from invite_id; don't duplicate
        inviteId: null, // Note: public info doesn't surface invite id; the consume handler re-derives via the token
        ttlSeconds: 60 * 60, // 1 hour
        metadata: { inviteCode: code, tenantSlug: info.tenantSlug },
      });
      const origin = (req.headers.origin as string) || `${req.protocol}://${req.get('host')}`;
      const url = `${origin}/invite/accept?code=${encodeURIComponent(code)}&magic=${encodeURIComponent(rawToken)}`;
      let debugUrl: string | undefined;
      try {
        const result = await sendMagicLink({
          to: info.inviteeEmail,
          url,
          intentLabel: `Accept invite to ${info.tenantName}`,
          expiresAt: row.expiresAt,
          tenantName: info.tenantName,
        });
        debugUrl = result.debugUrl;
      } catch (mailerErr) {
        logger.error({ err: mailerErr, code }, 'portal: mailer.sendMagicLink failed');
        // Mailer is not yet implemented in prod (OI-NAV-203c). Return
        // a 503 with the specific code so UI can show "email provider
        // not configured" rather than misleading "sent: true".
        const isUnimpl = mailerErr
          && typeof mailerErr === 'object'
          && (mailerErr as { code?: string }).code === 'BACKEND_UNIMPLEMENTED';
        res.status(isUnimpl ? 503 : 500).json({
          ok: false,
          error: {
            code: isUnimpl ? 'MAILER_UNCONFIGURED' : 'INTERNAL',
            message: isUnimpl
              ? 'Magic-link email provider is not configured yet (OI-NAV-203c).'
              : 'Failed to send magic-link email.',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      // Success — the link has been handed off to the mailer.
      // `debugUrl` is populated ONLY by the 'console' backend (dev)
      // so automated tests + dev UI can verify without parsing logs.
      res.json({
        ok: true,
        data: { sent: true, debugUrl },
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      logger.error({ err: e }, 'portal: /invite/request-signup-link failed');
      res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL', message: 'Failed to request signup link' },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── /workspace/* — Tenant Workspace user console ────────────────────
  //
  // Introduced by the portal redesign (2026-04-22, see
  // docs/portal/nexus-hub-portal-owner-workspace-redesign.md).
  //
  // The workspace router enforces its own auth chain internally:
  //   authMiddleware (iOS JWT) → resolveTenantContext (membership)
  // It is mounted at a DIFFERENT prefix than /api/v1 so iOS traffic
  // does NOT accidentally leak into the workspace routes through the
  // existing /api middleware. All existing portal /api/* routes
  // continue to work unchanged; this is strictly additive.
  try {
    const { createPortalWorkspaceRouter } = require('../api/portal-workspace-router');
    app.use('/workspace', createPortalWorkspaceRouter());
    logger.info('Tenant workspace router mounted at /workspace/*');
  } catch (err) {
    // Non-fatal: boots at pre-migration-076 cannot resolve tenants;
    // the portal remains functional even if this router can't mount.
    logger.warn({ err }, 'Workspace router failed to mount (non-fatal)');
  }

  app.use(express.json());

  // ── /owner/* — Platform Owner control plane ─────────────────────────
  //
  // Mounted AFTER the global express.json() because its own json()
  // middleware inside the router deliberately duplicates the parser
  // (defense-in-depth; if the global one is ever removed or scoped
  // out, /owner/* body parsing still works). Mounted BEFORE the
  // legacy /api/* portal routes so its path prefix never collides
  // with an existing handler.
  //
  // Auth chain:
  //   (shared PORTAL_TOKEN check on legacy /api/* — N/A here)
  //   → resolvePlatformAdmin (X-Admin-User-Id identity resolution)
  //
  // Because /owner/* sits OUTSIDE /api/*, it does not inherit the
  // existing portal-token middleware. For the MVP, the platform-
  // admin identity check is the sole auth gate — intentionally
  // strict, since a misconfigured deployment would reject rather
  // than leak. Phase 2 layers a proper admin login session on top.
  try {
    const { createPortalOwnerRouter } = require('../api/portal-owner-router');
    app.use('/owner', createPortalOwnerRouter());
    logger.info('Owner control-plane router mounted at /owner/*');
  } catch (err) {
    logger.warn({ err }, 'Owner router failed to mount (non-fatal)');
  }

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
  // because the Telegram bot also routes through the same AI providers and
  // needs the routing system regardless of whether iOS is enabled.
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

  registerPortalSkillRoutes(app);

  registerPortalContentRoutes(app);

  registerPortalActionRoutes(app, bot);

  registerPortalIntelligenceRoutes(app);

  registerPortalDocumentRoutes(app);

  registerPortalOperationsRoutes(app);

  registerPortalProviderRoutes(app);

  registerPortalUserRoutes(app);

  registerPortalInviteRoutes(app);

  registerPortalPlanRoutes(app);

  registerPortalFounderRoutes(app);

  registerPortalAdminDataRoutes(app);

  registerPortalUserSkillRoutes(app);

  registerPortalWaitlistRoutes(app);

  registerPortalSettingsRoutes(app);

  registerPortalWebhookRoutes(app);

  // ── Start HTTP server ──────────────────────────────────────────
  const server = http.createServer(app);
  const bind = config.portal.bind;
  const port = config.portal.port;

  // Expire stale webhook subscriptions on server start
  try { expireSubscriptions(); } catch { /* non-critical */ }

  // Handle listen errors gracefully — EADDRINUSE should NOT crash the bot
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error({ port, bind }, `Portal port ${port} already in use — portal disabled but bot continues`);
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
