// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-SEC-001 (2026-04-24) — admin-session JWT hardening.
 *
 * Pins the new secure-mode semantics of `resolvePlatformAdmin` and
 * the `admin-session-service` mint/verify helpers. The KEY contract
 * this file protects:
 *
 *   When PORTAL_ADMIN_JWT_SECRET is configured, X-Admin-User-Id
 *   is IGNORED and identity comes from the signed Bearer token's
 *   `sub` claim. An attacker with just the portal token CANNOT
 *   forge a valid session JWT without also having the JWT secret.
 *
 * Pre-existing tests in platform-admin-guard.test.ts continue to
 * cover the legacy path (PORTAL_ADMIN_JWT_SECRET unset); those
 * tests still pass unchanged because the guard's new warning log
 * doesn't change behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const mockGetPlatformRole = vi.fn();

vi.mock('../../src/services/tenant-service', () => ({
  getPlatformRole: (...args: unknown[]) => mockGetPlatformRole(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { resolvePlatformAdmin, type PlatformAdminRequest } from '../../src/api/platform-admin-guard';
import {
  mintAdminSession,
  verifyAdminSession,
  extractBearerToken,
} from '../../src/services/admin-session-service';

const TEST_SECRET = 'test-jwt-secret-32-bytes-please-definitely-long-enough';

function mockReq(headers: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return {
    headers,
    query,
    path: '/owner/tenants',
    method: 'GET',
    header(name: string) {
      // Case-insensitive lookup mirroring Express's req.header.
      const lc = name.toLowerCase();
      for (const [k, v] of Object.entries(this.headers as Record<string, string>)) {
        if (k.toLowerCase() === lc) return v;
      }
      return undefined;
    },
  } as unknown as Request;
}

function mockRes(): Response {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn(function (this: any, code: number) { res.statusCode = code; return this; }),
    json: vi.fn(function (this: any, payload: any) { res.body = payload; return this; }),
  };
  return res as Response;
}

beforeEach(() => {
  process.env.PORTAL_ADMIN_JWT_SECRET = TEST_SECRET;
  mockGetPlatformRole.mockReset();
});

afterEach(() => {
  delete process.env.PORTAL_ADMIN_JWT_SECRET;
  mockGetPlatformRole.mockReset();
});

// ─── admin-session-service (unit) ────────────────────────────────

describe('admin-session-service — extractBearerToken', () => {
  it('pulls the token out of a Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
    expect(extractBearerToken('BEARER xyz')).toBe('xyz');
  });

  it('returns null on a non-Bearer scheme (no Basic/Digest acceptance)', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('Digest abc')).toBeNull();
  });

  it('returns null on missing / empty / malformed input', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('admin-session-service — mintAdminSession / verifyAdminSession', () => {
  it('round-trips: mint → verify returns the same sub + role', () => {
    const token = mintAdminSession(42, 'platform_admin', { secret: TEST_SECRET });
    const result = verifyAdminSession(token, TEST_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe(42);
      expect(result.claims.role).toBe('platform_admin');
    }
  });

  it('mint throws when secret is unset (refuse to produce unverifiable tokens)', () => {
    const prev = process.env.PORTAL_ADMIN_JWT_SECRET;
    delete process.env.PORTAL_ADMIN_JWT_SECRET;
    expect(() => mintAdminSession(42, 'platform_admin')).toThrow(/PORTAL_ADMIN_JWT_SECRET/);
    if (prev) process.env.PORTAL_ADMIN_JWT_SECRET = prev;
  });

  it('mint rejects non-positive userIds (defensive — no zero/negative admins)', () => {
    expect(() => mintAdminSession(0, 'platform_admin', { secret: TEST_SECRET })).toThrow(/invalid userId/);
    expect(() => mintAdminSession(-1, 'platform_admin', { secret: TEST_SECRET })).toThrow();
    expect(() => mintAdminSession(NaN, 'platform_admin', { secret: TEST_SECRET })).toThrow();
  });

  it('verify returns secret_missing when no secret is configured', () => {
    const r = verifyAdminSession('whatever', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('secret_missing');
  });

  it('verify returns bad_signature when token was signed with a different secret', () => {
    const token = mintAdminSession(1, 'platform_owner', { secret: 'wrong-secret-32-bytes-definitely-long' });
    const r = verifyAdminSession(token, TEST_SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('verify returns expired on a token whose exp is in the past', () => {
    // Use jsonwebtoken directly to mint an already-expired token.
    const token = jwt.sign({ sub: 1, role: 'platform_admin' }, TEST_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    const r = verifyAdminSession(token, TEST_SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('verify returns missing_sub when the token payload has no sub', () => {
    const token = jwt.sign({ role: 'platform_admin' }, TEST_SECRET, { algorithm: 'HS256' });
    const r = verifyAdminSession(token, TEST_SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_sub');
  });

  it('verify returns bad_sub when sub is zero / negative / non-numeric', () => {
    for (const badSub of [0, -1, 'oops']) {
      const token = jwt.sign({ sub: badSub, role: 'platform_admin' }, TEST_SECRET, { algorithm: 'HS256' });
      const r = verifyAdminSession(token, TEST_SECRET);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad_sub');
    }
  });

  it('verify coerces an unknown role to platform_readonly (safe default; guard re-fetches from DB)', () => {
    const token = jwt.sign({ sub: 1, role: 'mystery_role' }, TEST_SECRET, { algorithm: 'HS256' });
    const r = verifyAdminSession(token, TEST_SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.role).toBe('platform_readonly');
  });

  it('verify rejects an alg=none token (defeats the classic JWT "alg:none" forge)', () => {
    // Manually craft a token with alg: none. jsonwebtoken refuses to
    // produce one via its high-level API, so we build the parts.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 1, role: 'platform_owner' })).toString('base64url');
    const forged = `${header}.${payload}.`;   // empty signature
    const r = verifyAdminSession(forged, TEST_SECRET);
    expect(r.ok).toBe(false);
  });
});

// ─── resolvePlatformAdmin — secure mode ─────────────────────────

describe('resolvePlatformAdmin — secure mode (JWT identity, OI-SEC-001)', () => {
  it('accepts a valid JWT and attaches req.platformAdmin from the sub claim', () => {
    mockGetPlatformRole.mockReturnValue('platform_admin');
    const token = mintAdminSession(7, 'platform_admin', { secret: TEST_SECRET });
    const req = mockReq({ Authorization: 'Bearer ' + token });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin).toEqual({ userId: 7, role: 'platform_admin' });
    expect(mockGetPlatformRole).toHaveBeenCalledWith(7);
  });

  it('IGNORES X-Admin-User-Id when the token is valid — identity comes from sub only', () => {
    mockGetPlatformRole.mockReturnValue('platform_admin');
    const token = mintAdminSession(7, 'platform_admin', { secret: TEST_SECRET });
    const req = mockReq({
      Authorization: 'Bearer ' + token,
      // Attacker sends a different id in the header — must NOT change identity.
      'X-Admin-User-Id': '7',   // matching is allowed
    });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin.userId).toBe(7);
  });

  it('REJECTS with 400 when X-Admin-User-Id MISMATCHES the token sub (confused-deputy attempt)', () => {
    mockGetPlatformRole.mockReturnValue('platform_admin');
    const token = mintAdminSession(7, 'platform_admin', { secret: TEST_SECRET });
    const req = mockReq({
      Authorization: 'Bearer ' + token,
      'X-Admin-User-Id': '999',   // attacker trying to overlay a different id
    });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(400);
    expect((res as any).body.error.code).toBe('BAD_REQUEST');
    expect((res as any).body.error.message).toMatch(/conflicts/i);
    // The DB role check must NOT have fired — we rejected before
    // trusting either identity source.
    expect(mockGetPlatformRole).not.toHaveBeenCalled();
  });

  it('rejects 401 when Authorization header is missing', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects 401 when the token signature is invalid (wrong secret)', () => {
    const token = mintAdminSession(7, 'platform_admin', { secret: 'different-secret-32-bytes-def-long' });
    const req = mockReq({ Authorization: 'Bearer ' + token });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.error.message).toMatch(/Invalid admin session token/i);
    expect(mockGetPlatformRole).not.toHaveBeenCalled();
  });

  it('rejects 401 with a distinct "expired" message when exp is in the past', () => {
    const token = jwt.sign({ sub: 1, role: 'platform_owner' }, TEST_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    const req = mockReq({ Authorization: 'Bearer ' + token });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.error.message).toMatch(/expired/i);
  });

  it('rejects 403 when the token sub is no longer a platform admin (post-mint revocation)', () => {
    // Role was revoked in the DB AFTER the token was minted — a
    // legitimate token, but the admin lost access. Must reject.
    mockGetPlatformRole.mockReturnValue(null);
    const token = mintAdminSession(7, 'platform_admin', { secret: TEST_SECRET });
    const req = mockReq({ Authorization: 'Bearer ' + token });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('NOT_A_PLATFORM_ADMIN');
    expect((res as any).body.error.message).toMatch(/revoked/i);
  });

  it('rejects 403 when the DB lookup throws (fail-closed on infrastructure errors)', () => {
    mockGetPlatformRole.mockImplementation(() => { throw new Error('db exploded'); });
    const token = mintAdminSession(7, 'platform_admin', { secret: TEST_SECRET });
    const req = mockReq({ Authorization: 'Bearer ' + token });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('NOT_A_PLATFORM_ADMIN');
  });

  it('DB-role check is NOT bypassed by a token claiming role=platform_owner', () => {
    // A forged token that SAYS "platform_owner" but whose sub is a
    // regular user must still be rejected by the DB re-check — the
    // role claim in the JWT is informational only.
    mockGetPlatformRole.mockReturnValue(null); // no platform_admins row
    const token = mintAdminSession(99, 'platform_owner', { secret: TEST_SECRET });
    const req = mockReq({ Authorization: 'Bearer ' + token });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
  });

  it('DB-re-fetched role overrides the token role claim (token said admin, DB says readonly)', () => {
    // A token minted when the user was platform_admin. They've since
    // been demoted to platform_readonly. The attached context must
    // reflect the CURRENT DB role (readonly), not the stale token
    // role (admin) — downstream requirePlatformWrite will then
    // correctly 403 them.
    mockGetPlatformRole.mockReturnValue('platform_readonly');
    const token = mintAdminSession(7, 'platform_admin', { secret: TEST_SECRET });
    const req = mockReq({ Authorization: 'Bearer ' + token });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin.role).toBe('platform_readonly');
  });
});

// ─── Mode selection ─────────────────────────────────────────────

describe('resolvePlatformAdmin — mode selection', () => {
  it('falls back to LEGACY mode when PORTAL_ADMIN_JWT_SECRET is unset', () => {
    delete process.env.PORTAL_ADMIN_JWT_SECRET;
    mockGetPlatformRole.mockReturnValue('platform_admin');
    const req = mockReq({ 'X-Admin-User-Id': '7' });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin).toEqual({ userId: 7, role: 'platform_admin' });
  });

  it('LEGACY mode IGNORES any Bearer token (it is the unhardened path)', () => {
    delete process.env.PORTAL_ADMIN_JWT_SECRET;
    mockGetPlatformRole.mockReturnValue('platform_admin');
    // Even if a Bearer token is present, legacy mode doesn't parse it.
    const req = mockReq({
      Authorization: 'Bearer ignored-in-legacy-mode',
      'X-Admin-User-Id': '7',
    });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin.userId).toBe(7);
  });

  it('SECURE mode rejects a request that ONLY has X-Admin-User-Id (no Bearer token)', () => {
    // Attacker in SECURE mode sends ONLY the header, hoping the
    // guard falls back to legacy. It must NOT — secure mode is
    // "token or nothing".
    const req = mockReq({ 'X-Admin-User-Id': '7' });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
    expect(mockGetPlatformRole).not.toHaveBeenCalled();
  });
});
