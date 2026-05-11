// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Garmin Connect authentication for iOS users.
//
// Garmin doesn't support OAuth2 for third-party apps — it uses
// username/password + MFA email verification. This endpoint handles
// the two-step flow:
//   1. POST /garmin/login — start login with email/password
//   2. POST /garmin/verify — submit the MFA code from email
//
// Tokens are stored per-user in garmin_user_tokens table.

import { Router, Response } from 'express';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import type { AuthenticatedRequest } from '../auth-middleware';
import {
  clearGarminSession,
  hasActiveGarminConnection,
  markGarminConnectionActive,
  upsertGarminSession,
} from '../../services/garmin-session-store';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import {
  startGarminInteractiveLogin,
  verifyGarminInteractiveLogin,
} from '../../services/garmin-interactive-auth';

async function beginGarminLogin(userId: number, email: string, password: string) {
  const db = getDb();

  try {
    const result = await startGarminInteractiveLogin(userId, email, password);
    if (!result.mfaRequired && result.tokens) {
      upsertGarminSession(userId, result.tokens);
      markGarminConnectionActive(userId, result.email);
      logger.info({ userId }, 'Garmin login succeeded without MFA');
      return {
        mfaRequired: false,
        connected: true,
        status: 'active' as const,
        verificationFlow: null,
      };
    }

    db.prepare(`
      INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status)
      VALUES (?, ?, '{}', 'mfa_pending')
      ON CONFLICT(user_id) DO UPDATE SET
        garmin_email = excluded.garmin_email,
        status = 'mfa_pending',
        updated_at = datetime('now')
    `).run(userId, result.email);

    logger.info({ userId }, 'Garmin login requires MFA — code sent to email');
    return {
      mfaRequired: true,
      connected: false,
      status: 'mfa_pending' as const,
      verificationFlow: result.verificationFlow ?? {
        channel: 'email_code' as const,
        verifyEndpoint: '/api/v1/garmin/verify',
        instructions: [
          'Check your email for the Garmin verification code.',
          'Enter the code in the Garmin reconnect screen to finish the connection.',
        ],
      },
    };
  } catch (loginErr: any) {
    if (loginErr?.code === 'GARMIN_RATE_LIMITED') {
      throw loginErr;
    }
    throw loginErr;
  }
}

function normalizeGarminStatus(
  userId: number,
  record: { status?: string | null } | undefined,
): { connected: boolean; status: string } {
  const rawStatus = record?.status || 'not_connected';
  const connected = rawStatus === 'active' && hasActiveGarminConnection(userId);
  return {
    connected,
    status: connected ? 'active' : rawStatus === 'active' ? 'needs_reauth' : rawStatus,
  };
}

export function garminAuthRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'garmin_auth_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * POST /api/v1/garmin/login
   * Start Garmin login — triggers MFA email to the user.
   * Body: { email: string, password: string }
   */
  router.post('/login', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { email, password } = req.body;

    if (!email || !password) {
      sendError(res, 'BAD_REQUEST', 'email and password are required');
      return;
    }

    try {
      const result = await beginGarminLogin(userId, email, password);
      sendSuccess(res, result);
    } catch (err: any) {
      logger.error({ err, userId }, 'Garmin login failed');
      sendError(res, err?.code === 'GARMIN_RATE_LIMITED' ? 'GARMIN_RATE_LIMITED' : 'AUTH_FAILED', 'Garmin login failed', err?.statusCode ?? 401);
    }
  }));

  /**
   * POST /api/v1/garmin/reauth
   * Manual recovery flow for expired Garmin sessions.
   * Body is optional:
   *   - no credentials -> return the verification flow contract
   *   - email/password -> start the MFA flow immediately
   */
  router.post('/reauth', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { email, password } = req.body ?? {};

    if (email && password) {
      try {
        const result = await beginGarminLogin(userId, String(email), String(password));
        sendSuccess(res, result);
        return;
      } catch (err: any) {
        logger.error({ err, userId }, 'Garmin manual reauth failed');
        sendError(res, err?.code === 'GARMIN_RATE_LIMITED' ? 'GARMIN_RATE_LIMITED' : 'AUTH_FAILED', 'Garmin re-authentication failed', err?.statusCode ?? 401);
        return;
      }
    }

    const db = getDb();
    const record = db.prepare(`
      SELECT garmin_email, status, last_refresh, last_used
      FROM garmin_user_tokens
      WHERE user_id = ?
    `).get(userId) as {
      garmin_email?: string | null;
      status?: string | null;
      last_refresh?: string | null;
      last_used?: string | null;
    } | undefined;

    const state = normalizeGarminStatus(userId, record);

    sendSuccess(res, {
      connected: state.connected,
      status: state.status,
      email: record?.garmin_email || null,
      verificationFlow: {
        channel: 'email_code',
        startEndpoint: '/api/v1/garmin/login',
        verifyEndpoint: '/api/v1/garmin/verify',
        credentialsRequired: true,
        instructions: [
          'Enter your Garmin email and password to request a verification code.',
          'When the code arrives by email, submit it to the verify endpoint to complete the reconnect flow.',
        ],
      },
      lastRefresh: record?.last_refresh || null,
      lastSync: record?.last_used || null,
    });
  }));

  /**
   * POST /api/v1/garmin/verify
   * Submit the MFA verification code.
   * Body: { code: string }
   */
  router.post('/verify', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { code } = req.body;

    if (!code) {
      sendError(res, 'BAD_REQUEST', 'code is required');
      return;
    }

    try {
      const db = getDb();
      const record = db.prepare(
        'SELECT garmin_email FROM garmin_user_tokens WHERE user_id = ? AND status = ?'
      ).get(userId, 'mfa_pending') as { garmin_email: string } | undefined;

      if (!record) {
        sendError(res, 'NO_PENDING', 'No pending Garmin login. Start with POST /garmin/login first.');
        return;
      }

      logger.info({ userId }, 'Garmin MFA verification attempt');

      const result = await verifyGarminInteractiveLogin(userId, String(code));
      upsertGarminSession(userId, result.tokens);
      markGarminConnectionActive(userId, result.email || record.garmin_email);

      const connected = hasActiveGarminConnection(userId);
      if (!connected) {
        db.prepare(`
          UPDATE garmin_user_tokens
          SET status = 'needs_reauth', updated_at = datetime('now')
          WHERE user_id = ?
        `).run(userId);
        sendError(res, 'GARMIN_SESSION_NOT_VERIFIED', 'Garmin verification did not persist a usable session.', 502);
        return;
      }

      sendSuccess(res, { verified: true, connected: true, status: 'active' });
    } catch (err: any) {
      logger.error({ err, userId }, 'Garmin MFA verification failed');
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      sendError(res, err?.code || 'VERIFY_FAILED', 'Verification failed', statusCode);
    }
  }));

  /**
   * GET /api/v1/garmin/status
   * Check if the user has Garmin connected.
   */
  router.get('/status', (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      const db = getDb();
      const record = db.prepare(
        'SELECT garmin_email, status, last_refresh, last_used FROM garmin_user_tokens WHERE user_id = ?'
      ).get(userId) as any;

      const state = normalizeGarminStatus(userId, record);
      sendSuccess(res, {
        connected: state.connected,
        email: record?.garmin_email || null,
        status: state.status,
        lastSync: record?.last_used || null,
        reauthEndpoint: state.status === 'needs_reauth' ? '/api/v1/garmin/reauth' : null,
      });
    } catch {
      sendSuccess(res, { connected: false, status: 'not_connected' });
    }
  });

  /**
   * DELETE /api/v1/garmin/disconnect
   * Remove Garmin connection for this user.
   */
  router.delete('/disconnect', (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      clearGarminSession(userId);
      sendSuccess(res, { disconnected: true });
    } catch (err: any) {
      sendInternalError(res, 'Disconnect failed');
    }
  });

  return router;
}
