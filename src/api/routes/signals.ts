// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Signals API — Phase 3 Slice B
 *
 * Exposes the cross-skill training signal bus to the iOS client so
 * the user can see what the coaching system is adapting to right now.
 * Read-only, per-user scoped, token-zero (pure SQL read + formatting).
 *
 * Endpoints:
 *   GET /api/v1/signals/active   — current active signals + flags
 *
 * The response shape is owned by services/signals-observability.ts.
 * This route is a thin wrapper: auth → call service → send envelope.
 */

import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError } from '../response-helpers';
import { buildActiveSignalsResponse } from '../../services/signals-observability';
import { logger } from '../../utils/logger';

export function signalsRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/signals/active
   *
   * Returns the current user's active training signals — the same ones
   * the sport coach personas see when generating a response. Useful for:
   *   - Explaining "why did the coach do X today?"
   *   - Debugging unexpected coach behavior
   *   - Giving the user confidence that the system is watching their state
   *
   * Response:
   *   {
   *     ok: true,
   *     data: {
   *       userId,
   *       timestamp,
   *       counts: { total, urgent },
   *       flags: { lowSleep, lowHrv, lowReadiness, highLegLoad, ... },
   *       signals: [{ id, type, title, summary, priority, source, createdAt, ... }]
   *     }
   *   }
   */
  router.get('/active', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const payload = buildActiveSignalsResponse(userId);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId }, 'GET /api/v1/signals/active failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to load active signals', 500);
    }
  });

  return router;
}
