// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-SEC-001 (2026-04-24) — signed admin session tokens.
 *
 * Problem we're solving: the legacy `/owner/*` auth chain trusted a
 * `X-Admin-User-Id: N` header as the identity claim, separate from
 * the `PORTAL_OWNER_TOKEN` Bearer credential. Anyone holding the
 * token could send ANY admin id in the header and impersonate them
 * — a textbook confused-deputy gap.
 *
 * Fix: bind the identity INTO the credential. An admin session token
 * is a compact HMAC-signed JWT whose `sub` claim is the admin user
 * id. The signature proves the token was minted by someone with the
 * signing secret; `sub` is trusted transitively. With the JWT mode
 * enabled, `X-Admin-User-Id` is IGNORED — the token alone carries
 * identity.
 *
 * Why a bespoke module instead of folding this into
 * platform-admin-guard.ts: mint + verify are symmetric crypto
 * operations that want the same helpers + constants + tests. The
 * CLI script (scripts/mint-admin-token.ts) needs mint() without
 * needing the full Express middleware chain, and this gives it a
 * clean entry point.
 *
 * This module does NOT:
 *   - persist anything — tokens are stateless; revocation requires
 *     rotating the signing secret (or a future OI-SEC-001a
 *     revocation list if we need fast per-token kill)
 *   - check `platform_admins` membership — the caller (the guard)
 *     does that. Keeps this module pure crypto + narrow contract.
 */

import jwt from 'jsonwebtoken';
import type { PlatformRole } from './tenant-service';

/**
 * Payload we pack into the signed JWT. Only `sub` (admin user id)
 * is load-bearing — everything else is observability (the caller
 * re-fetches role from `platform_admins` at verify time, so a role
 * demotion between mint and use takes effect immediately).
 */
export interface AdminSessionClaims {
  /** users.id of the platform admin. The identity claim we trust. */
  sub: number;
  /** Role at mint time — informational; always re-checked server-side. */
  role: PlatformRole;
  /** Issued-at (seconds since epoch). jsonwebtoken sets this automatically. */
  iat?: number;
  /** Expires-at (seconds since epoch). jsonwebtoken sets this from expiresIn. */
  exp?: number;
}

export type AdminSessionVerifyFailure =
  | 'secret_missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'missing_sub'
  | 'bad_sub';

export type AdminSessionVerifyResult =
  | { ok: true; claims: AdminSessionClaims }
  | { ok: false; reason: AdminSessionVerifyFailure };

/**
 * Default token lifetime — 24 hours. Short enough that a leaked
 * token can't be used forever; long enough that a human admin
 * doesn't get logged out mid-session. Override via second arg.
 */
export const DEFAULT_ADMIN_SESSION_TTL = '24h';

/**
 * Read the signing secret from env. Returns empty string if unset —
 * callers must treat that as "JWT mode disabled, fall back to legacy".
 * Exported so the guard can branch on it before calling verify.
 */
export function getAdminSessionSecret(): string {
  return process.env.PORTAL_ADMIN_JWT_SECRET || '';
}

/**
 * Mint an admin session token. Called by scripts/mint-admin-token.ts
 * (offline) and reserved for a future /owner/session endpoint.
 *
 * Throws if the signing secret isn't configured — minting a token
 * without a secret would produce something that later verifies
 * against the wrong (empty) secret, which is strictly worse than
 * failing loudly here.
 */
export function mintAdminSession(
  userId: number,
  role: PlatformRole,
  opts: { expiresIn?: string | number; secret?: string } = {},
): string {
  const secret = opts.secret ?? getAdminSessionSecret();
  if (!secret) {
    throw new Error(
      'PORTAL_ADMIN_JWT_SECRET is not set — cannot mint admin session tokens. '
      + 'Add a 32+ byte random value to .env and restart.',
    );
  }
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error(`mintAdminSession: invalid userId ${userId}`);
  }
  const payload: AdminSessionClaims = { sub: userId, role };
  return jwt.sign(payload, secret, {
    expiresIn: (opts.expiresIn ?? DEFAULT_ADMIN_SESSION_TTL) as jwt.SignOptions['expiresIn'],
    // HS256 is the default, but pin it explicitly — the
    // "alg:none" vulnerability class is worth defending against
    // even when not obviously applicable.
    algorithm: 'HS256',
  });
}

/**
 * Verify an admin session token. Returns a structured result so the
 * guard can distinguish "no such secret configured" (→ fall back to
 * legacy mode) from "wrong secret / expired / bad shape" (→ 401).
 *
 * Rejects tokens with a non-positive `sub` because `platform_admins`
 * rows use positive user ids — refusing a zero/negative sub early
 * keeps downstream DB queries honest.
 */
export function verifyAdminSession(
  token: string | null | undefined,
  secret: string = getAdminSessionSecret(),
): AdminSessionVerifyResult {
  if (!secret) return { ok: false, reason: 'secret_missing' };
  if (typeof token !== 'string' || token.trim().length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err && typeof err === 'object' && 'name' in err) {
      const name = (err as { name?: string }).name;
      if (name === 'TokenExpiredError') return { ok: false, reason: 'expired' };
      if (name === 'JsonWebTokenError') return { ok: false, reason: 'bad_signature' };
    }
    return { ok: false, reason: 'bad_signature' };
  }

  if (!decoded || typeof decoded !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  const rawSub = (decoded as { sub?: unknown }).sub;
  if (typeof rawSub === 'undefined' || rawSub === null) {
    return { ok: false, reason: 'missing_sub' };
  }
  const sub = typeof rawSub === 'number' ? rawSub : Number(rawSub);
  if (!Number.isFinite(sub) || sub <= 0) {
    return { ok: false, reason: 'bad_sub' };
  }

  const role = (decoded as { role?: unknown }).role;
  // role is informational — if it's missing or malformed, fall back
  // to a safe default and let the guard re-fetch from the DB.
  const safeRole: PlatformRole = role === 'platform_owner'
    || role === 'platform_admin'
    || role === 'platform_readonly'
    ? role
    : 'platform_readonly';

  return {
    ok: true,
    claims: {
      sub,
      role: safeRole,
      iat: (decoded as { iat?: number }).iat,
      exp: (decoded as { exp?: number }).exp,
    },
  };
}

/**
 * Convenience: extract the Bearer token from an Authorization header.
 * Returns null if the header is missing or non-Bearer shape.
 *
 * Kept here (not in secret-guards.ts) so admin-session-service has no
 * Express dependency — the CLI minting script doesn't need Express.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const parts = authHeader.split(/\s+/, 2);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== 'bearer') return null;
  const raw = parts[1]?.trim();
  return raw && raw.length > 0 ? raw : null;
}
