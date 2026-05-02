// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sendError } from './response-helpers';
// Beta gap 3 (2026-04-24): moved from inline `require()` to a static
// import. The lazy pattern below originally hedged against a circular
// dependency that no longer exists, and the runtime `require()` wasn't
// interceptable by vitest's mock system — so the user-status and new
// device-revocation checks couldn't be unit tested against a mocked DB.
// `services/database` doesn't import anything in `api/*`, so a top-level
// import is cycle-safe.
import { getDb } from '../services/database';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../services/tenant-scope-observability';

export interface AuthenticatedRequest extends Request {
  tenantId: number;
  userId: number;
  deviceId: string;
}

const ACTIVE_TENANT_HEADER_NAMES = [
  'x-nexus-active-tenant-id',
  'x-nexus-tenant-id',
] as const;

function readRequestedActiveTenant(req: Request): { header: string; raw: string; tenantId: number | null } | null {
  for (const header of ACTIVE_TENANT_HEADER_NAMES) {
    const rawValue = req.header?.(header) ?? req.headers[header];
    const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const trimmed = raw.trim();
    const tenantId = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
    return {
      header,
      raw,
      tenantId: Number.isFinite(tenantId) && tenantId > 0 ? tenantId : null,
    };
  }
  return null;
}

function isValidAuthPayloadUserId(userId: unknown): userId is number {
  return typeof userId === 'number' && Number.isInteger(userId) && isValidTenantUserId(userId);
}

/**
 * JWT authentication middleware for iOS API routes.
 * Validates the Bearer token and attaches userId/deviceId to the request.
 *
 * Emits the canonical error envelope ({ ok: false, error: { code,
 * message }, timestamp }) so every 401 on the /api/v1 surface decodes
 * with the same Swift enum the rest of the contract uses. The legacy
 * bare-shape ({ error: { code, message } }) emitted previously still
 * decoded on the client via a fallback path, but the unified shape
 * lets the staging smoke tighten its 401 assertion and removes the
 * "which shape is it?" ambiguity for future contract changes.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.debug(
      { event: 'auth', action: 'jwt.verify', outcome: 'rejected', reason: 'missing_token' },
      'iOS JWT rejected',
    );
    sendError(res, 'UNAUTHORIZED', 'Missing token', 401);
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.ios.jwtSecret) as {
      userId?: unknown;
      deviceId?: unknown;
    };

    if (!isValidAuthPayloadUserId(payload.userId)) {
      recordTenantScopeAnomaly({
        layer: 'delivery',
        operation: 'ios_auth_jwt_payload',
        reason: payload.userId == null ? 'missing_user_scope' : 'invalid_user_scope',
        userId: typeof payload.userId === 'number' ? payload.userId : null,
        details: {
          userIdType: typeof payload.userId,
        },
      });
      sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
      return;
    }

    // Hardening audit 2026-04-20: verify the user is still active
    // BEFORE admitting the request. Previously the middleware trusted
    // the JWT `userId` verbatim — a banned / disabled / hard-deleted
    // user with an unexpired token had full access until natural
    // expiry. One indexed SELECT on `users.status` closes that.
    // Indexed on `idx_users_status` (migrations/030_users.sql:22).
    //
    // Beta gap 3 (2026-04-24): we ALSO verify that the device session
    // has not been revoked — POST /auth/logout and /auth/logout-all
    // delete the matching `ios_devices` row, but the access token in
    // the client's pocket remains cryptographically valid until its
    // 7-day JWT expiry. Without this check, a signed-out device (or a
    // device whose refresh token was revoked for account switching)
    // could keep using its access token until natural expiry. The
    // `device_id` column has a UNIQUE constraint (migration 038) so
    // the lookup is indexed. Tokens minted BEFORE the sign-out still
    // match the row and keep working — what breaks is only the
    // post-logout path, which is exactly the intent.
    try {
      const db = getDb();
      const row = db
        .prepare('SELECT status FROM users WHERE id = ?')
        .get(payload.userId) as { status?: string } | undefined;
      if (!row) {
        // Token references a user that no longer exists — probably
        // post-deletion. Reject rather than proceed with a dangling id.
        logger.warn(
          { event: 'auth', action: 'jwt.verify', outcome: 'rejected', reason: 'user_not_found', userId: payload.userId },
          'iOS JWT: user row not found — rejecting',
        );
        sendError(res, 'UNAUTHORIZED', 'User account no longer exists', 401);
        return;
      }
      if (row.status && row.status !== 'active') {
        logger.warn(
          { event: 'auth', action: 'jwt.verify', outcome: 'rejected', reason: 'inactive_user', userId: payload.userId, status: row.status },
          'iOS JWT: user status is not active — rejecting',
        );
        sendError(res, 'UNAUTHORIZED', 'User account is not active', 401);
        return;
      }

      // Device session check — only run when the JWT carries a deviceId
      // (all tokens minted by createAuthSessionAndRegisterDevice do).
      // Older tokens without deviceId are not subject to this check,
      // which keeps the transition non-breaking for any already-issued
      // legacy JWT.
      if (typeof payload.deviceId === 'string' && payload.deviceId.length > 0) {
        const device = db
          .prepare('SELECT 1 FROM ios_devices WHERE user_id = ? AND device_id = ?')
          .get(payload.userId, payload.deviceId) as { 1?: number } | undefined;
        if (!device) {
          logger.info(
            { userId: payload.userId, deviceId: payload.deviceId },
            'iOS JWT: device session revoked — rejecting',
          );
          sendError(res, 'UNAUTHORIZED', 'Session has been revoked', 401);
          return;
        }
      }
    } catch (err) {
      // DB lookup failed. Fail CLOSED: if we can't verify the user's
      // status we don't admit the request. This is a deliberate
      // availability-for-security tradeoff — an open auth bypass on DB
      // degradation is worse than a brief 401 storm.
      logger.error(
        { event: 'auth', action: 'jwt.verify', outcome: 'degraded', reason: 'user_status_check_failed', err, userId: payload.userId },
        'iOS JWT: user-status check failed — rejecting',
      );
      sendError(res, 'UNAUTHORIZED', 'Authentication service unavailable', 401);
      return;
    }

    const requestedTenant = readRequestedActiveTenant(req);
    if (requestedTenant) {
      if (!isValidTenantUserId(requestedTenant.tenantId)) {
        recordTenantScopeAnomaly({
          layer: 'delivery',
          operation: 'ios_auth_active_tenant',
          reason: 'invalid_user_scope',
          userId: payload.userId,
          details: {
            header: requestedTenant.header,
            raw: requestedTenant.raw,
          },
        });
        sendError(res, 'FORBIDDEN', 'Invalid active tenant scope', 403);
        return;
      }

      if (requestedTenant.tenantId !== payload.userId) {
        recordTenantScopeAnomaly({
          layer: 'delivery',
          operation: 'ios_auth_active_tenant',
          reason: 'tenant_mismatch',
          userId: payload.userId,
          details: {
            header: requestedTenant.header,
            requestedTenantId: requestedTenant.tenantId,
            canonicalTenantId: payload.userId,
          },
        });
        sendError(res, 'FORBIDDEN', 'Active tenant switching is not enabled for this session', 403);
        return;
      }
    }

    // Nexus currently uses users.id as the canonical tenant key for iOS
    // runtime data. Keep tenant scope explicit on the request so downstream
    // Chat/agenda/memory paths never have to infer it from frontend filters.
    // If a client attempts same-user workspace switching before the backend
    // has a membership-backed active-tenant model, fail closed above instead
    // of silently accepting or ignoring the requested tenant.
    const authenticatedDeviceId = typeof payload.deviceId === 'string' ? payload.deviceId : '';
    (req as AuthenticatedRequest).tenantId = payload.userId;
    (req as AuthenticatedRequest).userId = payload.userId;
    (req as AuthenticatedRequest).deviceId = authenticatedDeviceId;

    // Update last_active_at for portal user tracking (fire-and-forget, non-blocking)
    try {
      const db = getDb();
      db.prepare(
        "UPDATE ios_devices SET last_active_at = datetime('now') WHERE user_id = ? AND device_id = ?"
      ).run(payload.userId, authenticatedDeviceId);
      db.prepare(
        "UPDATE users SET last_active_at = datetime('now') WHERE id = ?"
      ).run(payload.userId);
    } catch { /* non-critical — don't block the request */ }

    next();
  } catch (err) {
    logger.debug(
      { event: 'auth', action: 'jwt.verify', outcome: 'rejected', reason: 'invalid_or_expired_token', err },
      'iOS JWT verification failed',
    );
    sendError(res, 'UNAUTHORIZED', 'Invalid or expired token', 401);
  }
}
