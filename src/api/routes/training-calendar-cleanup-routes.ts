// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { requireTenantIdParam } from '../../services/tenant-scope';
import {
  retryTrainingCalendarCleanup,
  type TrainingCalendarCleanupProvider,
} from '../../services/training-calendar-cleanup-recovery';
import { logger } from '../../utils/logger';

export function registerTrainingCalendarCleanupRoutes(router: Router): void {
  router.post('/calendar-cleanup/retry', async (req, res: Response) => {
    const request = req as unknown as AuthenticatedRequest;
    let tenantId: number;
    try {
      tenantId = requireTenantIdParam(request.tenantId, 'training.calendar_cleanup.retry');
    } catch {
      sendError(res, 'TENANT_SCOPE_REQUIRED', 'A validated tenant scope is required.', 400);
      return;
    }

    const provider = normalizeProvider(req.body?.provider);
    if (!provider) {
      sendError(res, 'TRAINING_CALENDAR_CLEANUP_PROVIDER_INVALID', 'Provider must be google or outlook.', 400);
      return;
    }

    try {
      const result = await retryTrainingCalendarCleanup({
        userId: request.userId,
        tenantId,
        provider,
      });
      sendSuccess(res, result, { status: result.state === 'retrying' ? 202 : 200 });
    } catch (error) {
      logger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError', provider },
        'Training calendar cleanup recovery failed',
      );
      sendInternalError(res, 'Training calendar cleanup recovery is temporarily unavailable.', {
        code: 'TRAINING_CALENDAR_CLEANUP_UNAVAILABLE',
        status: 503,
      });
    }
  });
}

function normalizeProvider(value: unknown): TrainingCalendarCleanupProvider | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'google' || normalized === 'outlook' ? normalized : null;
}
