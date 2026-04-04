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
