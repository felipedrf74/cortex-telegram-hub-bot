// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Router } from 'express';
import { authMiddleware } from './auth-middleware';
import { rateLimitMiddleware, webhookRateLimitMiddleware } from './rate-limiter';
import { requestTimerMiddleware } from './request-timer';
import { authRoutes } from './routes/auth';
import { legalRoutes } from './routes/legal';
import { chatRoutes } from './routes/chat';
import { attachmentRoutes } from './routes/attachments';
import { dashboardRoutes } from './routes/dashboard';
import { taskRoutes } from './routes/tasks';
import { trainingRoutes } from './routes/training';
import { registerTrainingExerciseMediaRoutes } from './routes/training-exercise-media-routes';
import { contentRoutes } from './routes/content';
import { onboardingRoutes } from './routes/onboarding';
import { settingsRoutes } from './routes/settings';
import { calendarRoutes } from './routes/calendar';
import { reminderRoutes } from './routes/reminders';
import { notesRoutes } from './routes/notes';
import { connectionRoutes } from './routes/connections';
import { wearableRoutes } from './routes/wearable';
import { usageRoutes } from './routes/usage';
import { clientErrorsRoutes } from './routes/client-errors';
import { aiReportsRoutes } from './routes/ai-reports';
import { auditTrailRoutes } from './routes/audit-trail';
import { skillsRoutes } from './routes/skills';
import { signalsRoutes } from './routes/signals';
import { cookingRoutes } from './routes/cooking';
import { financeRoutes } from './routes/finance';
import { invoicesRoutes } from './routes/invoices';
import { contentDashboardRoutes } from './routes/content-dashboard';
import { contentAdminWriteRoutes } from './routes/content-admin-write';
import { healthDataRoutes } from './routes/health-data';
import { garminAuthRoutes } from './routes/garmin-auth';
import { billingRoutes } from './routes/billing';
import { oauthInitiateRoutes } from './routes/oauth-initiate';
import { internalRoutes } from './routes/internal';
import { planRoutes } from './routes/plan';
import { requireEntitlement } from './entitlement-middleware';
import { notificationRoutes } from './routes/notifications';
import { decisionRoutes, deviceTokenRoutes } from './routes/decisions';
import { reportRoutes } from './routes/reports';
import { summaryRoutes } from './routes/summaries';
import { syncRoutes } from './routes/sync';
import { eventBackboneAdminRoutes } from './routes/event-backbone-admin';
import { productLearningAdminRoutes } from './routes/product-learning-admin';
import { localInferenceAdminRoutes } from './routes/local-inference-admin';
import { verifyAppleJws } from '../services/apple-jws-verifier';
import { handleAppleNotification } from '../services/stripe-service';
import { captureMessage } from '../services/error-tracker';
import { logger } from '../utils/logger';

const WEBSITE_CORS_ALLOWLIST = new Set([
  'https://nexushub.me',
  'https://www.nexushub.me',
]);
const WEBSITE_CORS_ALLOWLIST_REGEX = /^https:\/\/[a-z0-9-]+\.nexushub-landing\.pages\.dev$/;
const WEBSITE_CORS_METHODS = new Set(['GET', 'POST', 'OPTIONS']);

function isWebsiteCorsRoute(path: string): boolean {
  return path === '/auth'
    || path.startsWith('/auth/')
    || path === '/legal'
    || path.startsWith('/legal/')
    || path === '/billing/status'
    || path === '/billing/usage'
    || path === '/billing/nexus-points/stripe-checkout';
}

function applyWebsiteCors(req: express.Request, res: express.Response): boolean {
  if (!isWebsiteCorsRoute(req.path)) return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  if (!WEBSITE_CORS_ALLOWLIST.has(origin) && !WEBSITE_CORS_ALLOWLIST_REGEX.test(origin)) {
    return false;
  }
  const requestedMethod = String(req.headers['access-control-request-method'] || req.method || '').toUpperCase();
  if (req.method === 'OPTIONS' && requestedMethod && !WEBSITE_CORS_METHODS.has(requestedMethod)) {
    return false;
  }
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '600');
  return true;
}

/**
 * Creates the iOS API router.
 * Mount on the existing portal Express app: `app.use('/api/v1', createApiRouter())`
 */
export function createApiRouter(): Router {
  const router = Router();

  // Public: API info / health check (no auth)
  router.get('/', (_req, res) => {
    res.json({
      name: 'Nexus Hub iOS API',
      version: 'v1',
      status: 'online',
      endpoints: {
        auth: 'POST /api/v1/auth/register, POST /api/v1/auth/refresh',
        chat: 'POST /api/v1/chat, GET /api/v1/chat/history',
        attachments: 'POST /api/v1/attachments/extract — image invoice/calendar/task extraction preview',
        dashboard: 'GET /api/v1/dashboard',
        tasks: 'GET/POST/PATCH/DELETE /api/v1/tasks',
        training: 'GET /api/v1/training/*',
        calendar: 'GET /api/v1/calendar/events, GET /api/v1/calendar/today',
        reminders: 'GET/POST/DELETE /api/v1/reminders',
        notes: 'GET/POST /api/v1/notes',
        connections: 'GET /api/v1/connections',
        wearable: 'GET /api/v1/wearable/{summary|readiness|sleep|providers}',
        usage: 'GET /api/v1/usage, GET /api/v1/usage/range, GET /api/v1/usage/today',
        onboarding: 'GET/POST /api/v1/onboarding',
        settings: 'GET/PATCH /api/v1/settings',
        clientErrors: 'POST /api/v1/client-errors',
        aiReports: 'POST /api/v1/ai-reports — report objectionable or inaccurate AI output',
        auditTrail: 'GET /api/v1/audit-trail/me',
        skills: 'GET /api/v1/skills/catalog, POST/DELETE /api/v1/skills/override (owner only)',
        signals: 'GET /api/v1/signals/active — active cross-skill training signals for the current user',
        cooking: 'GET/POST/DELETE /api/v1/cooking/{recipes|meal-plan|shopping-list}',
        finance: 'GET/POST/DELETE /api/v1/finance/{transactions|monthly-summary|tax/events|tax/calculate}',
        invoices: 'GET/POST/DELETE /api/v1/invoices/{vendors|scan-now|scraper-mfa-reply} — vendor config + on-demand collection',
        billing: 'GET /api/v1/billing/status, POST /api/v1/billing/{checkout|portal|apple-verify|nexus-points/stripe-checkout}',
        legal: 'GET /api/v1/legal/current, GET /api/v1/legal/{terms|privacy}',
        plan: 'GET /api/v1/plan/{week|today}, POST /api/v1/plan/recompute — multiskill mesh (feature-flagged)',
        summaries: 'GET /api/v1/summaries/{home|week|training|content|notifications} — fast app read models',
        decisions: 'GET /api/v1/decisions/summary, GET/POST/PATCH /api/v1/decisions — user-scoped decision orchestration',
        sync: 'GET /api/v1/sync/changes?since=cursor — RAMEN-lite delta sync',
        productLearningAdmin: 'GET /api/v1/admin/product-learning/summary, POST /api/v1/admin/product-learning/physical-device-observations (portal admin only)',
        localInferenceAdmin: 'GET/POST /api/v1/admin/local-inference/runtime-control, GET /api/v1/admin/local-inference/summary (portal admin only)',
      },
      auth_note: 'POST /auth/register/email, /auth/register/apple, or /auth/register/google/finish to get a JWT. Invite codes are optional and grant reviewer/early-access entitlements when supplied.',
    });
  });

  router.use((req, res, next) => {
    const corsApplied = applyWebsiteCors(req, res);
    if (req.method === 'OPTIONS' && corsApplied) {
      res.status(204).end();
      return;
    }
    next();
  });

  // Public routes (no JWT required).
  //
  // Hardening audit 2026-04-20: `/auth/register` and `/auth/refresh`
  // previously had NO rate limit at all — the `rateLimitMiddleware`
  // below only kicks in on authenticated routes (it runs AFTER
  // `authMiddleware` populates `req.userId`). The invite code
  // `BETA2026` was brute-forceable and /auth/refresh was a DoS vector.
  // Mount the limiter HERE so `/auth/*` gets the IP-bucket fallback
  // the limiter implements for userId-less requests. Legitimate
  // register/refresh traffic is well under 30 req/min/IP; credential
  // stuffing is capped.
  router.use('/auth', rateLimitMiddleware, authRoutes());
  router.use('/legal', legalRoutes());

  // Internal service-to-service routes — Python content-engine reports
  // usage here. Authenticated by shared secret, not JWT.
  router.use('/internal', internalRoutes());

  // Admin portal content dashboard — gated by its OWN portal-token
  // middleware, NOT by the iOS JWT. Mounted here (before authMiddleware)
  // so that `/api/v1/admin/content-dashboard` is reachable by the
  // admin portal's `Authorization: Bearer <PORTAL_TOKEN>` header without
  // having to register as an iOS device first.
  router.use('/admin/content-dashboard', contentDashboardRoutes());
  router.use('/admin/content', contentAdminWriteRoutes());
  router.use('/admin/event-backbone', eventBackboneAdminRoutes());
  router.use('/admin/product-learning', productLearningAdminRoutes());
  router.use('/admin/local-inference', localInferenceAdminRoutes());

  // Apple App Store Server Notifications — public (no JWT).
  // Apple sends lifecycle events (renewal, expiry, refund) server-to-server.
  // Must be mounted BEFORE authMiddleware so Apple's POST is accepted.
  //
  // L-1 (2026-04-21, pass 2): wrapped in webhookRateLimitMiddleware to
  // prevent a forged-payload flood from CPU-starving the event loop
  // BEFORE the cheap bundle-id + JWS validation rejects bad traffic.
  router.post('/billing/apple-notifications', webhookRateLimitMiddleware, express.json(), (req, res) => {
    const rejectInvalidAppleNotification = (reason: string, error?: unknown) => {
      logger.warn({ reason, err: error }, 'Apple notification: invalid or forged JWS rejected');
      captureMessage('APPLE_NOTIFICATION_FORGED_OR_INVALID', 'warning', {
        error_code: 'APPLE_NOTIFICATION_FORGED_OR_INVALID',
        reason,
      });
      res.status(200).json({ handled: false, reason: 'invalid signature' });
    };

    try {
      const { signedPayload } = req.body || {};
      if (!signedPayload || typeof signedPayload !== 'string') {
        // Apple requires 200 — returning non-200 triggers retries
        res.status(200).json({ handled: false, reason: 'missing signedPayload' });
        return;
      }

      let outerPayload: any;
      try {
        outerPayload = verifyAppleJws(signedPayload, { requireX5c: true }).payload;
      } catch (err) {
        rejectInvalidAppleNotification('invalid outer JWS', err);
        return;
      }

      const { notificationType, subtype, notificationUUID, data } = outerPayload;
      const signedTransactionInfo = data?.signedTransactionInfo;

      if (!notificationType || !signedTransactionInfo) {
        res.status(200).json({ handled: false, reason: 'missing notificationType or signedTransactionInfo' });
        return;
      }

      let innerPayload: any;
      try {
        innerPayload = verifyAppleJws(signedTransactionInfo, { requireX5c: true }).payload;
      } catch (err) {
        rejectInvalidAppleNotification('invalid inner transaction JWS', err);
        return;
      }
      if (!innerPayload.bundleId) {
        logger.warn(
          { notificationType },
          'Apple notification: missing bundleId in inner payload — rejecting',
        );
        res.status(200).json({ handled: false, reason: 'missing bundleId' });
        return;
      }
      if (innerPayload.bundleId !== 'me.nexushub.app') {
        logger.warn(
          { bundleId: innerPayload.bundleId, notificationType },
          'Apple notification: bundle ID mismatch — rejecting',
        );
        res.status(200).json({ handled: false, reason: 'bundle mismatch' });
        return;
      }

      // notificationUUID drives replay de-duplication and `environment` is
      // recorded as provenance; both live on the outer (already verified)
      // envelope, so they are threaded through rather than re-decoded.
      const processed = handleAppleNotification(notificationType, signedTransactionInfo, {
        notificationUUID: typeof notificationUUID === 'string' ? notificationUUID : null,
        subtype: typeof subtype === 'string' ? subtype : null,
        environment: typeof data?.environment === 'string' ? data.environment : null,
      });

      res.status(200).json({ handled: processed });
    } catch (err: any) {
      // Never return errors to Apple — always 200
      logger.error({ err }, 'Apple notification handler error');
      res.status(200).json({ handled: false, reason: 'internal error' });
    }
  });

  // Protected routes (require JWT + rate limiting).
  // The middleware order matters: auth runs first to populate req.userId,
  // then rate-limit checks the per-user quota, THEN the route handlers run.
  router.use(authMiddleware);
  router.use(rateLimitMiddleware);
  router.use(requestTimerMiddleware);

  // ── Per-user data isolation for ALL iOS API routes ─────────────────
  // Wrap every authenticated request in AsyncLocalStorage context so all
  // downstream service calls (Microsoft Graph, Google Calendar, caches,
  // logs, content personalization) resolve the current user safely.
  //
  // Historical note: this middleware used to mutate global per-request
  // overrides for Outlook/Google. Those setters are now no-ops, and the
  // request context below is the actual isolation boundary.
  router.use((req, _res, next) => {
    const userId = (req as any).userId;
    if (userId) {
      const { runWithContext, generateRequestId } = require('../utils/request-context');
      const requestId = (req as any).requestId || generateRequestId();
      // Wrap the rest of the middleware chain in a context that propagates
      // through await / Promise.all / timeouts without parameter threading.
      runWithContext({ requestId, source: 'http', userId, garminSilent: true }, () => {
        next();
      });
      return; // next() called inside runInContext
    }
    next();
  });

  // Chat and attachment extraction are the only app routes allowed to touch
  // the AI pipeline. Operational skill flows below stay token-zero.
  router.use('/chat', chatRoutes());
  router.use('/attachments', attachmentRoutes());

  // Aggregated home screen
  router.use('/dashboard', dashboardRoutes());
  router.use('/summaries', summaryRoutes());
  router.use('/sync', syncRoutes());

  // Token-zero data routes — direct service calls, no AI involvement.
  router.use('/tasks', taskRoutes());
  // Exercise media owns a hidden dark-route contract: disabled and ineligible
  // callers receive the same 404. Mount its self-contained authenticated,
  // entitlement-aware router before the broader Training paywall middleware;
  // all other Training routes preserve the existing entitlement behavior.
  const trainingExerciseMediaRouter = Router();
  registerTrainingExerciseMediaRoutes(trainingExerciseMediaRouter);
  router.use('/training', trainingExerciseMediaRouter);
  router.use('/training', requireEntitlement({ skill: 'training' }), trainingRoutes());
  router.use('/calendar', calendarRoutes());
  router.use('/reminders', reminderRoutes());
  router.use('/notes', notesRoutes());
  router.use('/connections', connectionRoutes());
  router.use('/wearable', wearableRoutes());
  router.use('/health-data', healthDataRoutes());
  router.use('/garmin', garminAuthRoutes());
  router.use('/usage', usageRoutes());

  // Phase 1 Slice D — Skills catalog for iOS Skills tab. Pure read of
  // skill-config + skill_tiers + per-user override state; no LLM calls.
  router.use('/skills', skillsRoutes());

  // Phase 3 Slice B — Cross-skill signal observability. Read-only
  // view of what the coaching system is adapting to right now.
  router.use('/signals', signalsRoutes());

  // Client error reporting (audit P0-9): write-only ingestion endpoint for
  // iOS / web crash reports. JWT + rate-limit protected via the middleware
  // chain above. Reads are admin-only and exposed via the portal, not here.
  router.use('/client-errors', clientErrorsRoutes());

  // App Review guideline 1.2: in-app reporting for objectionable or
  // inaccurate AI output. Write-only from iOS; reads are an operator concern
  // and stay in the portal.
  router.use('/ai-reports', aiReportsRoutes());

  // GDPR self-service audit trail (audit P0-10): users can view their own
  // audit history (Article 15). Read-only, scoped to the authenticated
  // user's user_id — never returns rows for any other user.
  router.use('/audit-trail', auditTrailRoutes());

  // Hardening 2026-04-21: paid skills now go through a central
  // `requireEntitlement` middleware that rejects free-tier users
  // BEFORE they enter the route. Prior code relied on per-route
  // ad-hoc checks that were missing on content/cooking/finance —
  // Free users could hit any /content POST and burn AI spend.
  // The resolver in services/entitlement.ts is the sole source of
  // truth for "can this user access this skill?".
  // Content includes both data lookups (pipeline) and one AI generation
  // endpoint (POST /script). Mounting under one router for cohesion.
  router.use('/content', requireEntitlement({ skill: 'content' }), contentRoutes());

  // TASK-14 Phase 1 — Cooking / Finance / Invoices routes that expose
  // the existing domain services (cooking-chef, finance-tracker,
  // invoice-collector) to the iOS Skills landing pages. Token-zero
  // CRUD — the AI pipeline is not touched by any route below.
  router.use('/cooking', requireEntitlement({ skill: 'cooking' }), cookingRoutes());
  router.use('/finance', requireEntitlement({ skill: 'finance' }), financeRoutes());
  router.use('/invoices', requireEntitlement({ skill: 'finance' }), invoicesRoutes());

  // Billing — subscription status (token-zero), Stripe checkout, Apple verify
  router.use('/billing', billingRoutes());
  router.use('/plan', planRoutes());

  // OAuth initiate — generate consent URLs for iOS integration onboarding
  router.use('/auth/oauth', oauthInitiateRoutes());

  // Content notification inbox — durable notifications for content events.
  // Powers the iOS notification center (unread badge, read/resolve actions).
  router.use('/notifications', notificationRoutes());

  // Decision Center — action-oriented facade over durable NotificationIntents.
  router.use('/decisions', decisionRoutes());
  router.use('/device-tokens', deviceTokenRoutes());

  // Durable report documents — morning briefing, evening summary, weekly review,
  // coach briefing. Structured JSON payloads rendered natively in iOS.
  router.use('/reports', reportRoutes());

  // Onboarding (questionnaires + profile)
  router.use('/onboarding', onboardingRoutes());

  // Settings: /api/v1/settings/language, /api/v1/settings/push-token
  // Status & connections also live under /settings/ per spec 02-API-SPECIFICATION
  router.use('/settings', settingsRoutes());

  // Profile route is part of onboarding module
  // GET /api/v1/profile is handled by onboarding routes

  return router;
}
