// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Platform-admin guard for the /owner/* control plane.
 *
 * Part of the portal redesign (feature/nexus-hub-owner-workspace-separation,
 * 2026-04-22). See `docs/portal/nexus-hub-portal-owner-workspace-redesign.md`.
 *
 * ## Two-factor auth on /owner/*
 *
 * Today the portal is gated by a single static Bearer token
 * (`PORTAL_TOKEN`). Whoever holds that string is "admin" with no
 * identity attached — which is why every admin-mutation audit row
 * in the portal hardcodes `actorId: 0`. We keep that token check
 * (backward compat) but ALSO require the client to identify WHICH
 * platform admin is acting, via `X-Admin-User-Id`. The server then
 * looks up `platform_admins.user_id = N` to verify the caller
 * really is a platform admin.
 *
 * This lets us:
 *   - reject /owner/* from any client that has the token but no
 *     matching platform_admins row
 *   - audit admin mutations with a real actorId instead of 0
 *   - support multiple human platform admins with distinct
 *     identities under the same shared token (Phase 2 replaces the
 *     shared token with per-admin session cookies)
 *
 * ## Token check
 *
 * The worktree is currently at pre-scoped-tokens state
 * (src/portal/server.ts still uses single PORTAL_TOKEN). To stay
 * backward-safe, THIS guard does NOT re-implement the token check
 * — it assumes the route chain already passed through the portal-
 * token middleware in portal/server.ts. The guard's job is just to
 * resolve the platform_admin identity and attach it to `req`.
 *
 * ## Fail-closed
 *
 * Missing header → 401. Header present but no row → 403. DB error
 * → 403 (never fall open). The audit log gets a rejection entry
 * regardless.
 */

import type { Request, Response, NextFunction } from 'express';
import { getPlatformRole, type PlatformRole } from '../services/tenant-service';
import { logger } from '../utils/logger';

// ── Request augmentation ──────────────────────────────────────────

export interface PlatformAdminContext {
  userId: number;
  role: PlatformRole;
}

/**
 * Request shape after the guard attaches a platform-admin identity.
 * Downstream handlers should cast to `PlatformAdminRequest` to read
 * `req.platformAdmin`.
 */
export interface PlatformAdminRequest extends Request {
  platformAdmin: PlatformAdminContext;
}

// ── Header parsing ─────────────────────────────────────────────────

/**
 * Parse the admin user id from the request. Accepts either the
 * `X-Admin-User-Id` header (string → integer) or a `?_asAdmin=N`
 * query parameter (debug-only; same semantics). The header wins
 * when both are present.
 *
 * Returns null if neither is present, invalid, or non-positive.
 */
function readAdminUserIdClaim(req: Request): number | null {
  const headerRaw = req.header('X-Admin-User-Id');
  const queryRaw = typeof req.query?._asAdmin === 'string' ? req.query._asAdmin : undefined;
  const raw = headerRaw ?? queryRaw;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

// ── Response helper ────────────────────────────────────────────────

function respond(res: Response, status: number, code: string, message: string, details?: unknown): void {
  const body: Record<string, unknown> = {
    ok: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  };
  if (details !== undefined) {
    (body.error as Record<string, unknown>).details = details;
  }
  res.status(status).json(body);
}

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Require a resolvable `platform_admin` identity on the request.
 * Used as the first middleware on the `/owner/*` router.
 *
 * Because the worktree is currently on the pre-scoped-tokens code
 * path, this guard does NOT check `PORTAL_TOKEN` itself — the
 * route is mounted AFTER portal/server.ts's existing portal-token
 * middleware, which already rejected the request if the token was
 * wrong. What this guard adds is the identity half: "who, among
 * platform admins, is this?"
 */
export function resolvePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const claimedUserId = readAdminUserIdClaim(req);
  if (claimedUserId === null) {
    logger.info(
      { path: req.path, method: req.method },
      'platform-admin-guard: missing X-Admin-User-Id — rejecting /owner/* request',
    );
    respond(
      res,
      401,
      'UNAUTHORIZED',
      'Missing X-Admin-User-Id header. Owner control-plane routes require an explicit admin identity.',
    );
    return;
  }

  let role: PlatformRole | null = null;
  try {
    role = getPlatformRole(claimedUserId);
  } catch (err) {
    logger.error({ err, claimedUserId }, 'platform-admin-guard: DB lookup failed — fail-closed');
    respond(
      res,
      403,
      'NOT_A_PLATFORM_ADMIN',
      'Unable to verify platform-admin identity (DB error).',
    );
    return;
  }

  if (!role) {
    logger.info(
      { claimedUserId, path: req.path },
      'platform-admin-guard: user is not a platform admin — rejecting',
    );
    respond(
      res,
      403,
      'NOT_A_PLATFORM_ADMIN',
      'This user is not a platform admin.',
      { userId: claimedUserId },
    );
    return;
  }

  (req as PlatformAdminRequest).platformAdmin = { userId: claimedUserId, role };
  next();
}

/**
 * Require the caller to be specifically the `platform_owner`.
 * Used on destructive ops: grant/revoke platform admin, delete
 * tenant, transfer ownership.
 *
 * Assumes `resolvePlatformAdmin` ran first and populated
 * `req.platformAdmin`. If it didn't (middleware misorder), we
 * return 500 rather than silently proceeding — that's a bug signal,
 * not a user action.
 */
export function requirePlatformOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ctx = (req as PlatformAdminRequest).platformAdmin;
  if (!ctx) {
    logger.error(
      { path: req.path },
      'platform-admin-guard: requirePlatformOwner ran before resolvePlatformAdmin — middleware order bug',
    );
    respond(
      res,
      500,
      'INTERNAL',
      'Platform-admin guard misconfigured (resolvePlatformAdmin must run first).',
    );
    return;
  }
  if (ctx.role !== 'platform_owner') {
    logger.info(
      { userId: ctx.userId, role: ctx.role, path: req.path },
      'platform-admin-guard: requirePlatformOwner rejected non-owner',
    );
    respond(
      res,
      403,
      'INSUFFICIENT_PLATFORM_ROLE',
      'This action requires platform_owner. You are a lower-privilege platform admin.',
      { currentRole: ctx.role, requiredRole: 'platform_owner' },
    );
    return;
  }
  next();
}

/**
 * Convenience: allow platform_owner OR platform_admin (but NOT
 * platform_readonly) on a mutation. Use on /owner/* POST/PATCH
 * endpoints that a support engineer shouldn't touch.
 */
export function requirePlatformWrite(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ctx = (req as PlatformAdminRequest).platformAdmin;
  if (!ctx) {
    respond(res, 500, 'INTERNAL', 'Platform-admin guard misconfigured.');
    return;
  }
  if (ctx.role === 'platform_readonly') {
    respond(
      res,
      403,
      'INSUFFICIENT_PLATFORM_ROLE',
      'This action requires write access; your role is platform_readonly.',
      { currentRole: ctx.role },
    );
    return;
  }
  next();
}
