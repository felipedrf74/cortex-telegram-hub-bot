// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { getPortalAuthContext } from '../api/secret-guards';
import { getUserById } from '../services/user-service';
import { logger } from '../utils/logger';

const PORTAL_ADMIN_TARGET_USER_KEY = Symbol.for('nexushub.portalAdminTargetUserId');

function parsePositiveUserId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sendJson(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    ok: false,
    error: { code, message },
  });
}

export function getPortalAdminTargetUserId(req: Request): number | undefined {
  return (req as Request & { [PORTAL_ADMIN_TARGET_USER_KEY]?: number })[PORTAL_ADMIN_TARGET_USER_KEY];
}

export interface PortalOperatorUserScopesConfig {
  readonly operatorUserScopes: Record<string, readonly number[]>;
}

// Resolve whether the authenticated operator is allowed to act on a specific
// target user id.
//
// Returns true when:
//   - No per-operator scopes are configured (single-owner deployment), OR
//   - The actor hint is present AND the configured scope list for that actor
//     includes the target user id.
//
// Fails closed (returns false) when scopes are configured but the actor has
// no entry, or the actor is missing from the request. This is intentional:
// the moment a deployment opts into per-operator scoping, every operator
// must be explicitly listed.
export function isOperatorScopedToUser(
  actorHint: string | undefined,
  targetUserId: number,
  scopes: Record<string, readonly number[]>,
): boolean {
  const actorCount = Object.keys(scopes).length;
  if (actorCount === 0) return true;

  if (!actorHint) return false;
  const normalized = actorHint.trim().toLowerCase();
  const allowed = scopes[normalized];
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(targetUserId);
}

export function portalOperatorUserScopesConfigured(): boolean {
  return Object.keys(config.portal.operatorUserScopes ?? {}).length > 0;
}

/**
 * Authorize a target user that was resolved from a body, query, or owned row.
 * This is the non-middleware companion to requireOperatorTargetUser().
 */
export function authorizePortalOperatorTargetUser(
  req: Request,
  res: Response,
  targetUserId: number,
): boolean {
  const parsedTargetUserId = parsePositiveUserId(targetUserId);
  if (!parsedTargetUserId) {
    sendJson(res, 400, 'INVALID_USER_ID', 'invalid userId');
    return false;
  }

  const user = getUserById(parsedTargetUserId);
  if (!user) {
    sendJson(res, 404, 'USER_NOT_FOUND', 'target user not found');
    return false;
  }

  const scopes = config.portal.operatorUserScopes ?? {};
  const auth = getPortalAuthContext(req);
  if (!isOperatorScopedToUser(auth?.actorHint, parsedTargetUserId, scopes)) {
    logger.warn(
      {
        actorHint: auth?.actorHint,
        targetUserId: parsedTargetUserId,
        matchedCredential: auth?.matchedCredential,
      },
      'Portal admin: operator is not scoped to target user',
    );
    sendJson(
      res,
      403,
      'FORBIDDEN',
      'operator is not scoped to target user',
    );
    return false;
  }

  (req as Request & { [PORTAL_ADMIN_TARGET_USER_KEY]?: number })[PORTAL_ADMIN_TARGET_USER_KEY] =
    parsedTargetUserId;
  return true;
}

// Middleware factory: validate `:userId` (or configured param) against:
//   1. Format — positive integer.
//   2. Existence — user row must exist in the users table.
//   3. Operator scope — when PORTAL_OPERATOR_USER_SCOPES is configured,
//      the authenticated operator must be explicitly scoped to this user.
//
// Pair this with `requirePortalAdminToken` so scope checks only run after
// the caller has proven they hold an admin credential. The middleware
// attaches the resolved target user id to the request so downstream audit
// entries can reference it directly via `getPortalAdminTargetUserId()`.
export function requireOperatorTargetUser(paramName: string = 'userId') {
  return function portalOperatorTargetUserGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const rawValue = (req.params as Record<string, unknown>)?.[paramName];
    const targetUserId = parsePositiveUserId(rawValue);
    if (!targetUserId) {
      sendJson(res, 400, 'INVALID_USER_ID', 'invalid userId');
      return;
    }

    if (!authorizePortalOperatorTargetUser(req, res, targetUserId)) return;
    next();
  };
}
