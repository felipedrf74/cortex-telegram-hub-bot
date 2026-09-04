// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Operator username + password for the admin portal.
 *
 * The credential never lives in the database: the release env carries one
 * username and one scrypt hash (`PORTAL_OPERATOR_USERNAME`,
 * `PORTAL_OPERATOR_PASSWORD_HASH`). A successful check does not grant access
 * by itself — the session route mints the same signed `ps_` cookie session a
 * pre-minted token would, with the configured actor (`PORTAL_OPERATOR_ACTOR`,
 * default: the username) and scope (`PORTAL_OPERATOR_SCOPE`, default admin),
 * so every downstream guard, the actor allowlist and the audit trail behave
 * exactly as for token sign-in.
 *
 * Hash format: `scrypt$N$r$p$<salt base64url>$<hash base64url>` (64-byte
 * derived key). Generate one with `node dist/tools/portal-password-hash.js`.
 */

import crypto from 'crypto';
import type { PortalTokenScope } from './portal-session-token';
import { isPortalTokenScope, sanitizePortalActorHint } from './portal-session-token';

export const PORTAL_PASSWORD_HASH_PREFIX = 'scrypt';
export const PORTAL_PASSWORD_MIN_LENGTH = 12;
const KEY_LENGTH = 64;
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const MAX_PASSWORD_LENGTH = 512;

export interface PortalOperatorCredentials {
  username: string;
  passwordHash: string;
  actor: string;
  scope: PortalTokenScope;
}

export function hashPortalPassword(password: string, params: { N?: number; r?: number; p?: number } = {}): string {
  if (typeof password !== 'string' || password.length < PORTAL_PASSWORD_MIN_LENGTH) {
    throw new Error(`password must be at least ${PORTAL_PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('password is too long');
  const N = params.N ?? DEFAULT_PARAMS.N;
  const r = params.r ?? DEFAULT_PARAMS.r;
  const p = params.p ?? DEFAULT_PARAMS.p;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 });
  return [PORTAL_PASSWORD_HASH_PREFIX, N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

interface ParsedHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }

export function parsePortalPasswordHash(encoded: string | null | undefined): ParsedHash | null {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.trim().split('$');
  if (parts.length !== 6 || parts[0] !== PORTAL_PASSWORD_HASH_PREFIX) return null;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  if (N > 2 ** 22 || r > 64 || p > 16) return null;
  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    hash = Buffer.from(parts[5], 'base64url');
  } catch {
    return null;
  }
  if (salt.length < 8 || hash.length !== KEY_LENGTH) return null;
  return { N, r, p, salt, hash };
}

/** Constant-time password check; a malformed hash never verifies. */
export function verifyPortalPassword(password: string | null | undefined, encoded: string | null | undefined): boolean {
  const parsed = parsePortalPasswordHash(encoded);
  if (!parsed || typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) return false;
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(password, parsed.salt, KEY_LENGTH, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 128 * parsed.N * parsed.r * 2 });
  } catch {
    return false;
  }
  return derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash);
}

/** Constant-time username comparison (case-insensitive, trimmed). */
export function portalUsernameMatches(expected: string, provided: string | null | undefined): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(provided.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) {
    // Compare against ourselves to keep timing flat, then reject.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reads the operator credential from the environment. Returns null when the
 * pair is not configured; throws when it is configured inconsistently so the
 * boot preflight can refuse a half-configured credential instead of silently
 * disabling password sign-in.
 */
export function readPortalOperatorCredentials(env: NodeJS.ProcessEnv = process.env): PortalOperatorCredentials | null {
  const username = (env.PORTAL_OPERATOR_USERNAME || '').trim();
  const passwordHash = (env.PORTAL_OPERATOR_PASSWORD_HASH || '').trim();
  if (!username && !passwordHash) return null;
  if (!username || !passwordHash) {
    throw new Error('PORTAL_OPERATOR_USERNAME and PORTAL_OPERATOR_PASSWORD_HASH must be set together');
  }
  if (!parsePortalPasswordHash(passwordHash)) {
    throw new Error('PORTAL_OPERATOR_PASSWORD_HASH is not a valid scrypt hash. Generate one with: node dist/tools/portal-password-hash.js');
  }
  const actor = sanitizePortalActorHint(env.PORTAL_OPERATOR_ACTOR || username);
  if (!actor) throw new Error('PORTAL_OPERATOR_ACTOR (or the username) must be a plain actor hint (letters, digits, @ . _ : + -)');
  const scopeRaw = (env.PORTAL_OPERATOR_SCOPE || 'admin').trim().toLowerCase();
  if (!isPortalTokenScope(scopeRaw)) throw new Error('PORTAL_OPERATOR_SCOPE must be read, write or admin');
  return { username, passwordHash, actor, scope: scopeRaw };
}
