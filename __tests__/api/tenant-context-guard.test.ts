// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for tenant-context-guard (/workspace/* entry gate).
 *
 * Pins:
 *   - Missing req.userId (auth-middleware didn't run) → 500.
 *   - X-Tenant-Id can be numeric or the `user-<id>` slug.
 *   - Absent X-Tenant-Id falls back to the solo tenant (== userId).
 *   - Unknown tenant id → 404 TENANT_NOT_FOUND.
 *   - Not a member → 403 NOT_A_MEMBER.
 *   - Suspended tenant → 423 TENANT_SUSPENDED regardless of method.
 *   - Archived tenant allows GET/HEAD, rejects mutations with 423.
 *   - Active member → next() + req.tenantContext attached.
 *   - requireTenantAdmin rejects tenant_member with 403.
 *   - requireTenantWrite rejects tenant_viewer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mockGetTenantById = vi.fn();
const mockGetMembership = vi.fn();
const mockEnsureSoloTenantFor = vi.fn();

vi.mock('../../src/services/tenant-service', () => ({
  getTenantById: (...args: unknown[]) => mockGetTenantById(...args),
  getMembership: (...args: unknown[]) => mockGetMembership(...args),
  ensureSoloTenantFor: (...args: unknown[]) => mockEnsureSoloTenantFor(...args),
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
  resolveTenantContext,
  requireTenantAdmin,
  requireTenantWrite,
  type TenantContextRequest,
} from '../../src/api/tenant-context-guard';

function mockReq(
  userId: number | undefined,
  headers: Record<string, string> = {},
  method = 'GET',
): Request {
  return {
    userId,
    headers,
    method,
    path: '/workspace/me',
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

function activeTenant(id: number, overrides: Partial<{ status: string; plan: string; slug: string }> = {}) {
  return {
    id,
    slug: overrides.slug ?? `user-${id}`,
    displayName: `Tenant ${id}`,
    status: overrides.status ?? 'active',
    plan: overrides.plan ?? 'free',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: id,
    metadata: {},
  };
}

describe('resolveTenantContext', () => {
  beforeEach(() => {
    mockGetTenantById.mockReset();
    mockGetMembership.mockReset();
    mockEnsureSoloTenantFor.mockReset();
  });

  afterEach(() => {
    mockGetTenantById.mockReset();
    mockGetMembership.mockReset();
    mockEnsureSoloTenantFor.mockReset();
  });

  it('returns 500 when req.userId is missing (auth-middleware order bug)', () => {
    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(mockReq(undefined), res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(500);
    expect((res as any).body.error.code).toBe('INTERNAL');
  });

  it('falls back to solo tenant when X-Tenant-Id absent', () => {
    mockGetTenantById.mockImplementation((id: number) => (id === 42 ? activeTenant(42) : null));
    mockGetMembership.mockImplementation((tid: number, uid: number) =>
      tid === 42 && uid === 42 ? { tenantId: 42, userId: 42, role: 'tenant_admin', joinedAt: '2026-01-01', invitedBy: null } : null,
    );

    const req = mockReq(42) as any;
    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as TenantContextRequest).tenantContext.tenantId).toBe(42);
    expect((req as TenantContextRequest).tenantContext.role).toBe('tenant_admin');
  });

  it('accepts numeric X-Tenant-Id', () => {
    mockGetTenantById.mockImplementation((id: number) => (id === 7 ? activeTenant(7) : null));
    mockGetMembership.mockReturnValue({ tenantId: 7, userId: 42, role: 'tenant_member', joinedAt: '', invitedBy: null });

    const req = mockReq(42, { 'X-Tenant-Id': '7' }) as any;
    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as TenantContextRequest).tenantContext.tenantId).toBe(7);
  });

  it('accepts slug X-Tenant-Id ("user-7")', () => {
    mockGetTenantById.mockImplementation((id: number) => (id === 7 ? activeTenant(7) : null));
    mockGetMembership.mockReturnValue({ tenantId: 7, userId: 42, role: 'tenant_member', joinedAt: '', invitedBy: null });

    const req = mockReq(42, { 'X-Tenant-Id': 'user-7' }) as any;
    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((req as TenantContextRequest).tenantContext.tenantId).toBe(7);
  });

  it('returns 404 TENANT_NOT_FOUND when non-existent tenant requested', () => {
    mockGetTenantById.mockReturnValue(null);

    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(mockReq(42, { 'X-Tenant-Id': '999' }), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(404);
    expect((res as any).body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('provisions a solo tenant on fallback when none exists yet', () => {
    // First lookup: null. After ensureSoloTenantFor, second lookup: tenant.
    let callCount = 0;
    mockGetTenantById.mockImplementation((id: number) => {
      callCount++;
      if (callCount === 1) return null;
      return id === 42 ? activeTenant(42) : null;
    });
    mockEnsureSoloTenantFor.mockReturnValue(42);
    mockGetMembership.mockReturnValue({ tenantId: 42, userId: 42, role: 'tenant_admin', joinedAt: '', invitedBy: null });

    const req = mockReq(42) as any;
    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(req, res, next as NextFunction);

    expect(mockEnsureSoloTenantFor).toHaveBeenCalledWith(42);
    expect(next).toHaveBeenCalledOnce();
    expect((req as TenantContextRequest).tenantContext.tenantId).toBe(42);
  });

  it('returns 403 NOT_A_MEMBER when user is not a member of target tenant', () => {
    mockGetTenantById.mockReturnValue(activeTenant(99));
    mockGetMembership.mockReturnValue(null);  // not a member

    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(
      mockReq(42, { 'X-Tenant-Id': '99' }),
      res,
      next as NextFunction,
    );

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('NOT_A_MEMBER');
    expect((res as any).body.error.details).toMatchObject({ tenantId: 99 });
  });

  it('returns 423 TENANT_SUSPENDED for a suspended tenant, even on GET', () => {
    mockGetTenantById.mockReturnValue(activeTenant(42, { status: 'suspended' }));
    mockGetMembership.mockReturnValue({ tenantId: 42, userId: 42, role: 'tenant_admin', joinedAt: '', invitedBy: null });

    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(mockReq(42), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(423);
    expect((res as any).body.error.code).toBe('TENANT_SUSPENDED');
  });

  it('returns 423 TENANT_ARCHIVED on a mutation but allows GET', () => {
    mockGetTenantById.mockReturnValue(activeTenant(42, { status: 'archived' }));
    mockGetMembership.mockReturnValue({ tenantId: 42, userId: 42, role: 'tenant_admin', joinedAt: '', invitedBy: null });

    // POST: blocked
    const postRes = mockRes();
    const postNext = vi.fn();
    resolveTenantContext(mockReq(42, {}, 'POST'), postRes, postNext as NextFunction);
    expect(postNext).not.toHaveBeenCalled();
    expect((postRes as any).statusCode).toBe(423);
    expect((postRes as any).body.error.code).toBe('TENANT_ARCHIVED');

    // GET: allowed
    const getRes = mockRes();
    const getNext = vi.fn();
    resolveTenantContext(mockReq(42, {}, 'GET'), getRes, getNext as NextFunction);
    expect(getNext).toHaveBeenCalledOnce();
    expect((getRes as any).statusCode).toBe(200);
  });

  it('fail-closes on DB error during membership lookup', () => {
    mockGetTenantById.mockReturnValue(activeTenant(42));
    mockGetMembership.mockImplementationOnce(() => {
      throw new Error('db gone');
    });

    const res = mockRes();
    const next = vi.fn();
    resolveTenantContext(mockReq(42), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('NOT_A_MEMBER');
  });
});

describe('requireTenantAdmin', () => {
  it('returns 500 when tenantContext missing (order bug)', () => {
    const res = mockRes();
    const next = vi.fn();
    requireTenantAdmin(mockReq(42), res, next as NextFunction);
    expect((res as any).statusCode).toBe(500);
  });

  it('rejects a tenant_member with 403', () => {
    const req = mockReq(42) as any;
    req.tenantContext = { tenantId: 42, tenant: activeTenant(42), userId: 42, role: 'tenant_member', joinedAt: '' };
    const res = mockRes();
    const next = vi.fn();
    requireTenantAdmin(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('INSUFFICIENT_TENANT_ROLE');
  });

  it('accepts a tenant_admin', () => {
    const req = mockReq(42) as any;
    req.tenantContext = { tenantId: 42, tenant: activeTenant(42), userId: 42, role: 'tenant_admin', joinedAt: '' };
    const res = mockRes();
    const next = vi.fn();
    requireTenantAdmin(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requireTenantWrite', () => {
  it('rejects tenant_viewer', () => {
    const req = mockReq(42) as any;
    req.tenantContext = { tenantId: 42, tenant: activeTenant(42), userId: 42, role: 'tenant_viewer', joinedAt: '' };
    const res = mockRes();
    const next = vi.fn();
    requireTenantWrite(req, res, next as NextFunction);
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('INSUFFICIENT_TENANT_ROLE');
  });

  it('accepts tenant_member and tenant_admin', () => {
    for (const role of ['tenant_member', 'tenant_admin'] as const) {
      const req = mockReq(42) as any;
      req.tenantContext = { tenantId: 42, tenant: activeTenant(42), userId: 42, role, joinedAt: '' };
      const res = mockRes();
      const next = vi.fn();
      requireTenantWrite(req, res, next as NextFunction);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});
