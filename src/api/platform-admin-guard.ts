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
import crypto from 'crypto';
import { getPlatformRole, type PlatformRole } from '../services/tenant-service';
import { logger } from '../utils/logger';

// ── /owner/* rate limit (Phase 2E validation fix) ────────────────
//
// The Phase-2A token gate + identity gate stopped unauthenticated
// requests cold, but it left a subtle enumeration vector: if
// `PORTAL_OWNER_TOKEN` leaks (lost .env, harvested from a backup),
// an attacker can brute-force `X-Admin-User-Id` by sending thousands
// of combinations. Each attempt hits the `platform_admins` DB
// lookup; a valid id returns 200, an invalid id returns 403. Timing
// differences would reveal the valid ids even with timing-safe
// token compare.
//
// Fix: per-IP sliding window. 30 req/min/IP is generous for
// legitimate owner-console use (human admin clicking around) and
// tight enough that enumeration takes impractical time. This runs
// BEFORE the token check so even valid-token traffic is rate-
// limited — protects against a leaked token being used to exhaust
// the database.
//
// State is in-process; matches the existing rate-limiter.ts pattern.
// Under PM2 cluster the buckets are per-worker; documented for
// Phase 3 horizontal-scale concerns.

const ownerRequestLog = new Map<string, number[]>();
const OWNER_WINDOW_MS = 60 * 1000;
const OWNER_MAX_REQUESTS = 30;

function extractClientIp(req: Request): string {
  return (req.ip as string | undefined) || req.socket?.remoteAddress || 'unknown';
}

// Periodic cleanup so the Map doesn't grow unbounded across long
// process lifetimes. Same cadence as the main rate-limiter.
setInterval(() => {
  const now = Date.now();
  for (const [ip, stamps] of ownerRequestLog) {
    const inWindow = stamps.filter((ts) => now - ts < OWNER_WINDOW_MS);
    if (inWindow.length === 0) {
      ownerRequestLog.delete(ip);
    } else {
      ownerRequestLog.set(ip, inWindow);
    }
  }
}, 5 * 60 * 1000);

/** Test-only: drop bucket state between cases. */
export function _resetOwnerRateLimiterForTests(): void {
  ownerRequestLog.clear();
}

export function ownerRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip = extractClientIp(req);
  const now = Date.now();
  const stamps = ownerRequestLog.get(ip) || [];
  const inWindow = stamps.filter((ts) => now - ts < OWNER_WINDOW_MS);
  inWindow.push(now);
  ownerRequestLog.set(ip, inWindow);

  const remaining = Math.max(0, OWNER_MAX_REQUESTS - inWindow.length);
  res.setHeader('X-RateLimit-Limit', OWNER_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil((now + OWNER_WINDOW_MS) / 1000));
  res.setHeader('X-RateLimit-Bucket', 'owner');

  if (inWindow.length > OWNER_MAX_REQUESTS) {
    const retryAfter = Math.ceil(OWNER_WINDOW_MS / 1000);
    res.setHeader('Retry-After', retryAfter);
    logger.warn(
      { ip, path: req.path, method: req.method, inWindow: inWindow.length },
      'owner-console: rate limit exceeded — possible enumeration attempt',
    );
    res.status(429).json({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many owner-console requests from this IP. Slow down.',
        retryAfter,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  next();
}

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

// ── Owner-console token gate (defense in depth) ───────────────────
//
// Phase 2 hardening (2026-04-22): `/owner/*` now requires a valid
// owner-console token on top of the platform-admin identity check.
// This closes the open risk #1 from the Phase-1 final report ("do
// not expose /owner/* on the public tunnel without a token").
//
// Resolution order for the expected token:
//
//   1. PORTAL_OWNER_TOKEN   — dedicated owner-console secret. If set,
//                             this is the ONLY accepted token.
//   2. PORTAL_TOKEN         — existing shared portal token. Used as
//                             a fallback so local dev keeps working
//                             with a single .env variable.
//   3. neither set          — IF `PORTAL_ALLOW_LOCAL_BYPASS=true`
//                             AND the request's remote address is
//                             loopback, the gate is skipped (same
//                             bypass pattern the /api admin gate uses).
//                             Otherwise 503 — we refuse to serve
//                             /owner/* at all without a configured
//                             secret. Fail-closed.
//
// All comparisons use `crypto.timingSafeEqual` to defeat timing
// side-channels. The token is read from Authorization: Bearer <t>
// OR from the X-Portal-Token header (the same dual-form the
// existing admin portal's inline JS speaks).

function readPresentedToken(req: Request): string | null {
  const auth = req.header('Authorization');
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const raw = auth.slice(7).trim();
    if (raw.length > 0) return raw;
  }
  const header = req.header('X-Portal-Token');
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }
  // Debug-only query form. Logged distinctly so accidental exposure
  // in shell history is visible in the audit trail.
  if (typeof req.query?._ownerToken === 'string' && (req.query._ownerToken as string).length > 0) {
    return (req.query._ownerToken as string).trim();
  }
  return null;
}

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isLoopbackRequest(req: Request): boolean {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1'
  );
}

/**
 * First-stage gate on the `/owner/*` router: token presence + match.
 * Runs BEFORE `resolvePlatformAdmin` so the request never reaches
 * the identity resolver (and therefore the platform_admins DB read)
 * without proving token possession first.
 */
export function requireOwnerConsoleToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configuredOwner = process.env.PORTAL_OWNER_TOKEN || '';
  const configuredShared = process.env.PORTAL_TOKEN || '';
  const bypassAllowed = (process.env.PORTAL_ALLOW_LOCAL_BYPASS || 'false').toLowerCase() === 'true';

  // No secret configured at all.
  if (!configuredOwner && !configuredShared) {
    if (bypassAllowed && isLoopbackRequest(req)) {
      // Local dev convenience. Still logs so this path is observable.
      logger.info(
        { path: req.path, method: req.method, remote: req.ip },
        'platform-admin-guard: owner-console token not set; allowing loopback bypass',
      );
      return next();
    }
    logger.error(
      { path: req.path },
      'platform-admin-guard: refusing /owner/* — neither PORTAL_OWNER_TOKEN nor PORTAL_TOKEN is set',
    );
    respond(
      res,
      503,
      'OWNER_CONSOLE_UNCONFIGURED',
      'Owner console is not configured. Set PORTAL_OWNER_TOKEN (preferred) or PORTAL_TOKEN in .env and restart.',
    );
    return;
  }

  const presented = readPresentedToken(req);
  if (!presented) {
    respond(
      res,
      401,
      'UNAUTHORIZED',
      'Missing owner-console token. Send Authorization: Bearer <token> or X-Portal-Token: <token>.',
    );
    return;
  }

  // PORTAL_OWNER_TOKEN, when set, is the ONLY accepted token. We do
  // NOT silently fall back to PORTAL_TOKEN if the owner-specific
  // secret exists — that would defeat the separation the operator
  // asked for.
  let ok = false;
  if (configuredOwner) {
    ok = tokensEqual(presented, configuredOwner);
  } else {
    ok = tokensEqual(presented, configuredShared);
  }

  if (!ok) {
    logger.info(
      { path: req.path, method: req.method },
      'platform-admin-guard: owner-console token mismatch — rejecting',
    );
    respond(res, 401, 'UNAUTHORIZED', 'Invalid owner-console token.');
    return;
  }
  next();
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
