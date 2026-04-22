// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for platform-admin-guard (/owner/* entry gate).
 *
 * Pins:
 *   - Missing `X-Admin-User-Id` header → 401 UNAUTHORIZED.
 *   - Header present but no `platform_admins` row → 403 NOT_A_PLATFORM_ADMIN.
 *   - Valid row → attaches `req.platformAdmin = { userId, role }` and calls next().
 *   - requirePlatformOwner rejects non-owner platform admins with
 *     403 INSUFFICIENT_PLATFORM_ROLE.
 *   - requirePlatformWrite rejects platform_readonly.
 *   - Query-param fallback `?_asAdmin=N` also works (debug path).
 *   - Misordered middleware (requirePlatformOwner BEFORE resolve) → 500.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

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

import {
  resolvePlatformAdmin,
  requirePlatformOwner,
  requirePlatformWrite,
  type PlatformAdminRequest,
} from '../../src/api/platform-admin-guard';

function mockReq(headers: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return {
    headers,
    query,
    path: '/owner/tenants',
    method: 'GET',
    header(name: string) { return this.headers[name.toLowerCase()] ?? this.headers[name]; },
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

describe('resolvePlatformAdmin', () => {
  beforeEach(() => {
    mockGetPlatformRole.mockReset();
  });

  afterEach(() => {
    mockGetPlatformRole.mockReset();
  });

  it('rejects with 401 when X-Admin-User-Id is missing', () => {
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(mockReq(), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.error.code).toBe('UNAUTHORIZED');
    expect((res as any).body.error.message).toMatch(/X-Admin-User-Id/i);
  });

  it('rejects with 401 when X-Admin-User-Id is non-numeric', () => {
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(
      mockReq({ 'X-Admin-User-Id': 'not-a-number' }),
      res,
      next as NextFunction,
    );

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
  });

  it('rejects with 401 when X-Admin-User-Id is <= 0', () => {
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(
      mockReq({ 'X-Admin-User-Id': '0' }),
      res,
      next as NextFunction,
    );
    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
  });

  it('rejects with 403 when user is not in platform_admins', () => {
    mockGetPlatformRole.mockReturnValueOnce(null);
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(
      mockReq({ 'X-Admin-User-Id': '42' }),
      res,
      next as NextFunction,
    );

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('NOT_A_PLATFORM_ADMIN');
    expect(mockGetPlatformRole).toHaveBeenCalledWith(42);
  });

  it('accepts a platform_owner and attaches req.platformAdmin', () => {
    mockGetPlatformRole.mockReturnValueOnce('platform_owner');
    const req = mockReq({ 'X-Admin-User-Id': '1' });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin).toEqual({
      userId: 1,
      role: 'platform_owner',
    });
  });

  it('accepts a platform_admin and attaches req.platformAdmin', () => {
    mockGetPlatformRole.mockReturnValueOnce('platform_admin');
    const req = mockReq({ 'X-Admin-User-Id': '42' });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin?.role).toBe('platform_admin');
  });

  it('falls back to ?_asAdmin= query when header absent', () => {
    mockGetPlatformRole.mockReturnValueOnce('platform_admin');
    const req = mockReq({}, { _asAdmin: '7' });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as PlatformAdminRequest).platformAdmin?.userId).toBe(7);
  });

  it('fails closed on DB error (returns 403 NOT_A_PLATFORM_ADMIN)', () => {
    mockGetPlatformRole.mockImplementationOnce(() => {
      throw new Error('db gone');
    });
    const res = mockRes();
    const next = vi.fn();
    resolvePlatformAdmin(
      mockReq({ 'X-Admin-User-Id': '1' }),
      res,
      next as NextFunction,
    );

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('NOT_A_PLATFORM_ADMIN');
  });
});

describe('requirePlatformOwner', () => {
  it('returns 500 when run before resolvePlatformAdmin (middleware order bug)', () => {
    const res = mockRes();
    const next = vi.fn();
    requirePlatformOwner(mockReq(), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(500);
    expect((res as any).body.error.code).toBe('INTERNAL');
  });

  it('rejects a platform_admin with 403 INSUFFICIENT_PLATFORM_ROLE', () => {
    const req = mockReq() as any;
    req.platformAdmin = { userId: 42, role: 'platform_admin' };
    const res = mockRes();
    const next = vi.fn();
    requirePlatformOwner(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('INSUFFICIENT_PLATFORM_ROLE');
    expect((res as any).body.error.details).toMatchObject({
      currentRole: 'platform_admin',
      requiredRole: 'platform_owner',
    });
  });

  it('accepts a platform_owner', () => {
    const req = mockReq() as any;
    req.platformAdmin = { userId: 1, role: 'platform_owner' };
    const res = mockRes();
    const next = vi.fn();
    requirePlatformOwner(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requirePlatformWrite', () => {
  it('rejects platform_readonly', () => {
    const req = mockReq() as any;
    req.platformAdmin = { userId: 9, role: 'platform_readonly' };
    const res = mockRes();
    const next = vi.fn();
    requirePlatformWrite(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('INSUFFICIENT_PLATFORM_ROLE');
  });

  it('accepts platform_admin + platform_owner', () => {
    for (const role of ['platform_admin', 'platform_owner'] as const) {
      const req = mockReq() as any;
      req.platformAdmin = { userId: 1, role };
      const res = mockRes();
      const next = vi.fn();
      requirePlatformWrite(req, res, next as NextFunction);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('returns 500 when run before resolvePlatformAdmin', () => {
    const res = mockRes();
    const next = vi.fn();
    requirePlatformWrite(mockReq(), res, next as NextFunction);
    expect((res as any).statusCode).toBe(500);
  });
});
