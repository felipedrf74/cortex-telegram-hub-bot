// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router } from 'express';
import { authMiddleware } from './auth-middleware';
import { rateLimitMiddleware } from './rate-limiter';
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
import { billingRoutes } from './routes/billing';
import { oauthInitiateRoutes } from './routes/oauth-initiate';

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
      },
      auth_note: 'POST /auth/register with inviteCode to get a JWT. Include as Authorization: Bearer <token> on all other endpoints.',
    });
  });

  // Public routes (no JWT required)
  router.use('/auth', authRoutes());

  // Admin portal content dashboard — gated by its OWN portal-token
  // middleware, NOT by the iOS JWT. Mounted here (before authMiddleware)
  // so that `/api/v1/admin/content-dashboard` is reachable by the
  // admin portal's `Authorization: Bearer <PORTAL_TOKEN>` header without
  // having to register as an iOS device first.
  router.use('/admin/content-dashboard', contentDashboardRoutes());
  router.use('/admin/content', contentAdminWriteRoutes());

  // Protected routes (require JWT + rate limiting).
  // The middleware order matters: auth runs first to populate req.userId,
  // then rate-limit checks the per-user quota, THEN the route handlers run.
  router.use(authMiddleware);
  router.use(rateLimitMiddleware);

  // ── Per-user data isolation for ALL iOS API routes ─────────────────
  // Sets request-scoped user overrides so all downstream service calls
  // (Microsoft Graph, Google Calendar) use the authenticated user's
  // tokens instead of the owner singleton. Cleared on response finish.
  router.use((req, _res, next) => {
    const userId = (req as any).userId;
    if (userId) {
      const { setRequestUserId } = require('../services/microsoft-auth');
      const { setGoogleCalendarUserId } = require('../services/google-calendar');
      setRequestUserId(userId);
      setGoogleCalendarUserId(userId);
      _res.on('finish', () => {
        setRequestUserId(null);
        setGoogleCalendarUserId(null);
      });
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

  // Content includes both data lookups (pipeline) and one AI generation
  // endpoint (POST /script). Mounting under one router for cohesion.
  router.use('/content', contentRoutes());

  // TASK-14 Phase 1 — Cooking / Finance / Invoices routes that expose
  // the existing domain services (cooking-chef, finance-tracker,
  // invoice-collector) to the iOS Skills landing pages. Token-zero
  // CRUD — the AI pipeline is not touched by any route below.
  router.use('/cooking', cookingRoutes());
  router.use('/finance', financeRoutes());
  router.use('/invoices', invoicesRoutes());

  // Billing — subscription status (token-zero), Stripe checkout, Apple verify
  router.use('/billing', billingRoutes());

  // OAuth initiate — generate consent URLs for iOS integration onboarding
  router.use('/auth/oauth', oauthInitiateRoutes());

  // Onboarding (questionnaires + profile)
  router.use('/onboarding', onboardingRoutes());

  // Settings: /api/v1/settings/language, /api/v1/settings/push-token
  // Status & connections also live under /settings/ per spec 02-API-SPECIFICATION
  router.use('/settings', settingsRoutes());

  // Profile route is part of onboarding module
  // GET /api/v1/profile is handled by onboarding routes

  return router;
}
