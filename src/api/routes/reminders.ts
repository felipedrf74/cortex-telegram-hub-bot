// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Reminders routes — token-zero CRUD on the reminders table.
 *
 * The scheduler (services/scheduler.ts) polls for due reminders independently;
 * these routes only manipulate user-visible state. NO AI involvement.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import {
  setReminder,
  getActiveReminders,
  cancelReminder,
} from '../../state/reminders';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

export function reminderRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'reminders_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/reminders
   * Returns active reminders for the authenticated user (sorted by remind_at ASC).
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const reminders = getActiveReminders(userId);
    sendSuccess(res, {
      reminders: reminders.map(formatReminder),
      count: reminders.length,
    });
  }));

  /**
   * POST /api/v1/reminders
   * Body: { message, remindAt: ISO8601, recurring?: 'daily' | 'weekly' | 'monthly' }
   * Creates a new reminder for the authenticated user.
   */
  router.post('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { message, remindAt, recurring } = req.body;

    if (!message || typeof message !== 'string') {
      sendError(res, 'BAD_REQUEST', 'message is required and must be a string');
      return;
    }
    if (!remindAt || typeof remindAt !== 'string') {
      sendError(res, 'BAD_REQUEST', 'remindAt is required (ISO 8601 timestamp)');
      return;
    }
    if (recurring && !['daily', 'weekly', 'monthly'].includes(recurring)) {
      sendError(res, 'BAD_REQUEST', "recurring must be 'daily', 'weekly', or 'monthly'");
      return;
    }

    try {
      const reminder = setReminder(userId, {
        message,
        remind_at: remindAt,
        recurring: recurring || undefined,
      });
      logger.info({ userId, reminderId: reminder.id }, 'iOS reminder created');
      sendSuccess(res, { reminder: formatReminder(reminder) }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS reminders create failed');
      sendInternalError(res, 'Failed to create reminder');
    }
  }));

  /**
   * DELETE /api/v1/reminders/:id
   * Marks a reminder as cancelled. Only the owning user can cancel their own
   * reminders (cancelReminder filters by userId in the WHERE clause).
   */
  router.delete('/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      sendError(res, 'BAD_REQUEST', 'reminder id must be a positive integer');
      return;
    }

    try {
      cancelReminder(userId, id);
      sendSuccess(res, { cancelled: true, id });
    } catch (err: any) {
      logger.error({ err, userId, id }, 'iOS reminders delete failed');
      sendInternalError(res, 'Failed to cancel reminder');
    }
  }));

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Convert the snake_case DB row into camelCase for the iOS client.
 * Keeps the API contract idiomatic Swift without changing the schema.
 */
function formatReminder(r: any) {
  return {
    id: r.id,
    message: r.message,
    remindAt: r.remind_at,
    recurring: r.recurring || null,
    status: r.status,
    createdAt: r.created_at,
  };
}
