// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Client Errors route — POST /api/v1/client-errors
 *
 * Audit P0-9: backend ingestion endpoint for iOS (and future web) error
 * reports. The iOS app's ClientErrorReporter POSTs structured error
 * payloads here. Insertion is bounded — message ≤ 2KB, stack ≤ 8KB,
 * context ≤ 4KB — so an attacker holding a JWT can't fill the disk by
 * spamming giant payloads.
 *
 * Reads are admin-only and exposed via the portal, not via the public
 * iOS API. The iOS app is write-only on this resource.
 *
 * Auth: JWT-protected (mounted under the protected router).
 * Rate limit: inherits from the global rate-limiter (60 req/min/user).
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { sanitizeLogText, stringifySanitizedLogContext } from '../../utils/log-sanitizer';

// Hard size caps — keep in sync with the iOS reporter so it can pre-truncate.
const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;
const MAX_CONTEXT = 4_000;
const ALLOWED_LEVELS = new Set(['error', 'fatal', 'warning']);
const ALLOWED_SOURCES = new Set(['ios', 'ios-watch', 'web', 'mac']);

interface ClientErrorBody {
  message?: unknown;
  stack?: unknown;
  level?: unknown;
  source?: unknown;
  deviceId?: unknown;
  appVersion?: unknown;
  osVersion?: unknown;
  userAgent?: unknown;
  context?: unknown;
}

function asString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

export function clientErrorsRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'client_errors_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * POST /api/v1/client-errors
   * Body: {
   *   message: string (required, ≤2000 chars)
   *   stack?: string (≤8000 chars)
   *   level?: 'error' | 'fatal' | 'warning' (default: 'error')
   *   source?: 'ios' | 'ios-watch' | 'web' | 'mac' (default: 'ios')
   *   deviceId?: string
   *   appVersion?: string
   *   osVersion?: string
   *   userAgent?: string
   *   context?: object (will be JSON-stringified, ≤4000 chars after stringify)
   * }
   *
   * Returns: { id: number, ts: string }
   */
  router.post('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const body = (req.body || {}) as ClientErrorBody;

    const rawMessage = asString(body.message, MAX_MESSAGE);
    const message = rawMessage ? sanitizeLogText(rawMessage).slice(0, MAX_MESSAGE) : null;
    if (!message) {
      sendError(res, 'BAD_REQUEST', 'message is required and must be a non-empty string');
      return;
    }

    const level = typeof body.level === 'string' && ALLOWED_LEVELS.has(body.level)
      ? body.level
      : 'error';
    const source = typeof body.source === 'string' && ALLOWED_SOURCES.has(body.source)
      ? body.source
      : 'ios';

    const rawStack = asString(body.stack, MAX_STACK);
    const stack = rawStack ? sanitizeLogText(rawStack).slice(0, MAX_STACK) : null;
    const deviceId = asString(body.deviceId, 256);
    const appVersion = asString(body.appVersion, 64);
    const osVersion = asString(body.osVersion, 64);
    const userAgent = asString(body.userAgent, 512);

    let contextJson: string | null = null;
    if (body.context && typeof body.context === 'object') {
      contextJson = stringifySanitizedLogContext(body.context, MAX_CONTEXT);
    }

    try {
      const result = getDb().prepare(`
        INSERT INTO client_errors
          (user_id, device_id, source, level, message, stack, context, app_version, os_version, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, deviceId, source, level, message, stack, contextJson, appVersion, osVersion, userAgent);

      // Mirror critical errors to pino so the operator can spot trends in
      // logs even before opening the portal. Stack is omitted at info level
      // to keep the log line readable.
      logger.warn(
        { source, level, userId, deviceId, appVersion, osVersion, msg: message.slice(0, 200) },
        'Client error reported',
      );

      sendSuccess(res, {
        id: result.lastInsertRowid as number,
        ts: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'Failed to persist client error');
      sendInternalError(res, 'Failed to persist client error');
    }
  }));

  return router;
}
