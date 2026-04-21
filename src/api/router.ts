// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Router } from 'express';
import { authMiddleware } from './auth-middleware';
import { rateLimitMiddleware } from './rate-limiter';
import { requestTimerMiddleware } from './request-timer';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { dashboardRoutes } from './routes/dashboard';
import { taskRoutes } from './routes/tasks';
import { trainingRoutes } from './routes/training';
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
        auditTrail: 'GET /api/v1/audit-trail/me',
        skills: 'GET /api/v1/skills/catalog, POST/DELETE /api/v1/skills/override (owner only)',
        signals: 'GET /api/v1/signals/active — active cross-skill training signals for the current user',
        cooking: 'GET/POST/DELETE /api/v1/cooking/{recipes|meal-plan|shopping-list}',
        finance: 'GET/POST/DELETE /api/v1/finance/{transactions|monthly-summary|tax/events|tax/calculate}',
        invoices: 'GET/POST/DELETE /api/v1/invoices/{vendors|scan-now} — vendor config + on-demand collection',
        billing: 'GET /api/v1/billing/status, POST /api/v1/billing/{checkout|portal|apple-verify}',
        plan: 'GET /api/v1/plan/{week|today}, POST /api/v1/plan/recompute — multiskill mesh (feature-flagged)',
      },
      auth_note: 'POST /auth/register with inviteCode to get a JWT. Include as Authorization: Bearer <token> on all other endpoints.',
    });
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

  // Apple App Store Server Notifications — public (no JWT).
  // Apple sends lifecycle events (renewal, expiry, refund) server-to-server.
  // Must be mounted BEFORE authMiddleware so Apple's POST is accepted.
  router.post('/billing/apple-notifications', express.json(), (req, res) => {
    try {
      const { signedPayload } = req.body || {};
      if (!signedPayload || typeof signedPayload !== 'string') {
        // Apple requires 200 — returning non-200 triggers retries
        res.status(200).json({ handled: false, reason: 'missing signedPayload' });
        return;
      }

      // Decode the outer JWS (notification envelope)
      const outerParts = signedPayload.split('.');
      if (outerParts.length !== 3) {
        res.status(200).json({ handled: false, reason: 'malformed outer JWS' });
        return;
      }

      let outerPayload: any;
      try {
        outerPayload = JSON.parse(Buffer.from(outerParts[1], 'base64url').toString('utf8'));
      } catch {
        res.status(200).json({ handled: false, reason: 'invalid outer JWS payload' });
        return;
      }

      const { notificationType, data } = outerPayload;
      const signedTransactionInfo = data?.signedTransactionInfo;

      if (!notificationType || !signedTransactionInfo) {
        res.status(200).json({ handled: false, reason: 'missing notificationType or signedTransactionInfo' });
        return;
      }

      // Validate bundle ID from the inner transaction.
      //
      // Hardening 2026-04-21: prior code wrapped the inner-payload
      // parse + bundle-id check in a try/catch that SWALLOWED errors
      // and fell through to `handleAppleNotification` on failure. An
      // attacker sending a malformed `signedTransactionInfo` (no
      // `bundleId` field, or invalid base64) would sail past the
      // check. Now: if the inner JWS isn't a well-formed 3-part
      // structure, OR the bundleId is missing, OR the bundleId
      // doesn't match, we REJECT with 200 (Apple retry policy
      // compliance). Crypto signature verification is still a known
      // gap flagged to the security owner.
      const innerParts = signedTransactionInfo.split('.');
      if (innerParts.length !== 3) {
        require('../utils/logger').logger.warn(
          { notificationType },
          'Apple notification: malformed inner JWS — rejecting',
        );
        res.status(200).json({ handled: false, reason: 'malformed inner JWS' });
        return;
      }
      let innerPayload: any;
      try {
        innerPayload = JSON.parse(Buffer.from(innerParts[1], 'base64url').toString('utf8'));
      } catch {
        require('../utils/logger').logger.warn(
          { notificationType },
          'Apple notification: inner JWS payload not valid JSON — rejecting',
        );
        res.status(200).json({ handled: false, reason: 'invalid inner payload' });
        return;
      }
      if (!innerPayload.bundleId) {
        require('../utils/logger').logger.warn(
          { notificationType },
          'Apple notification: missing bundleId in inner payload — rejecting',
        );
        res.status(200).json({ handled: false, reason: 'missing bundleId' });
        return;
      }
      if (innerPayload.bundleId !== 'me.nexushub.app') {
        require('../utils/logger').logger.warn(
          { bundleId: innerPayload.bundleId, notificationType },
          'Apple notification: bundle ID mismatch — rejecting',
        );
        res.status(200).json({ handled: false, reason: 'bundle mismatch' });
        return;
      }

      const { handleAppleNotification } = require('../services/stripe-service');
      const processed = handleAppleNotification(notificationType, signedTransactionInfo);

      res.status(200).json({ handled: processed });
    } catch (err: any) {
      // Never return errors to Apple — always 200
      require('../utils/logger').logger.error({ err }, 'Apple notification handler error');
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
      runWithContext({ requestId, source: 'http', userId }, () => {
        next();
      });
      return; // next() called inside runInContext
    }
    next();
  });

  // Garmin silent mode for ALL iOS API routes. iOS users can't enter
  // MFA codes, so if the Garmin session expires, we return an error
  // instead of triggering an MFA email flood. The user re-authenticates
  // via the Telegram bot (/readiness) where MFA is interactive.
  router.use((_req, _res, next) => {
    const { setSilentMode } = require('../services/garmin');
    setSilentMode(true);
    _res.on('finish', () => setSilentMode(false));
    next();
  });

  // Chat is the ONLY route allowed to touch the AI pipeline.
  router.use('/chat', chatRoutes());

  // Aggregated home screen
  router.use('/dashboard', dashboardRoutes());

  // Token-zero data routes — direct service calls, no AI involvement.
  router.use('/tasks', taskRoutes());
  router.use('/training', trainingRoutes());
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
  const { requireEntitlement } = require('./entitlement-middleware');

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
  const { notificationRoutes } = require('./routes/notifications');
  router.use('/notifications', notificationRoutes());

  // Durable report documents — morning briefing, evening summary, weekly review,
  // coach briefing. Structured JSON payloads rendered natively in iOS.
  const { reportRoutes } = require('./routes/reports');
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
