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
      },
      auth_note: 'POST /auth/register with inviteCode to get a JWT. Include as Authorization: Bearer <token> on all other endpoints.',
    });
  });

  // Public routes (no JWT required)
  router.use('/auth', authRoutes());

  // Protected routes (require JWT + rate limiting).
  // The middleware order matters: auth runs first to populate req.userId,
  // then rate-limit checks the per-user quota, THEN the route handlers run.
  router.use(authMiddleware);
  router.use(rateLimitMiddleware);

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

  // Onboarding (questionnaires + profile)
  router.use('/onboarding', onboardingRoutes());

  // Settings: /api/v1/settings/language, /api/v1/settings/push-token
  // Status & connections also live under /settings/ per spec 02-API-SPECIFICATION
  router.use('/settings', settingsRoutes());

  // Profile route is part of onboarding module
  // GET /api/v1/profile is handled by onboarding routes

  return router;
}
