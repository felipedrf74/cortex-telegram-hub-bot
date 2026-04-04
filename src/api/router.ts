// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router } from 'express';
import { authMiddleware } from './auth-middleware';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { dashboardRoutes } from './routes/dashboard';
import { taskRoutes } from './routes/tasks';
import { trainingRoutes } from './routes/training';
import { contentRoutes } from './routes/content';
import { onboardingRoutes } from './routes/onboarding';
import { settingsRoutes } from './routes/settings';

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
        onboarding: 'GET/POST /api/v1/onboarding',
        settings: 'GET/PATCH /api/v1/settings',
      },
      auth_note: 'POST /auth/register with inviteCode to get a JWT. Include as Authorization: Bearer <token> on all other endpoints.',
    });
  });

  // Public routes (no JWT required)
  router.use('/auth', authRoutes());

  // Protected routes (require JWT)
  router.use(authMiddleware);
  router.use('/chat', chatRoutes());
  router.use('/dashboard', dashboardRoutes());
  router.use('/tasks', taskRoutes());
  router.use('/training', trainingRoutes());
  router.use('/content', contentRoutes());
  router.use('/onboarding', onboardingRoutes());

  // Settings routes include /status, /connections, /language, /push-token
  // Mount at root of protected routes so /api/v1/status, /api/v1/connections work
  router.use('/', settingsRoutes());

  // Profile route is part of onboarding module
  // GET /api/v1/profile is handled by onboarding routes

  return router;
}
