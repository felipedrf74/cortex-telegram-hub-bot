// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for the entitlement middleware.
 *
 * Two properties must hold:
 *   1. Defense in depth (L-2): if the middleware is mis-mounted and
 *      runs BEFORE authMiddleware (or a request arrives with no
 *      userId), it must FAIL CLOSED with 401 — never silently call
 *      next() and let the downstream handler see an unauthenticated
 *      request.
 *   2. Correctness: a Free user is denied a paid skill with 403
 *      TIER_REQUIRED; a paid user is permitted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mockGetDb = vi.fn();
const mockIsOwnerUserRef = vi.fn<[number], boolean>();

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));
vi.mock('../../src/services/user-service', () => ({
  isOwnerUserRef: (...args: [number]) => mockIsOwnerUserRef(...args),
}));

import { requireEntitlement } from '../../src/api/entitlement-middleware';
import { _resetPortalOverridesForTests } from '../../src/services/plan-quotas';

function mockReq(opts: { userId?: number | null } = {}): Request {
  return { userId: opts.userId } as unknown as Request;
}

function mockRes(): Response {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn(function (this: any, code: number) { res.statusCode = code; return this; }),
    json: vi.fn(function (this: any, payload: any) { res.body = payload; return this; }),
    setHeader: vi.fn(),
  };
  return res as Response;
}

describe('requireEntitlement middleware — defense-in-depth (L-2)', () => {
  beforeEach(() => {
    _resetPortalOverridesForTests();
    mockIsOwnerUserRef.mockReturnValue(false);
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
  });

  afterEach(() => {
    mockGetDb.mockReset();
    mockIsOwnerUserRef.mockReset();
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
  });

  it('returns 401 UNAUTHORIZED when req.userId is missing (mis-mounted order)', () => {
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: undefined }), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when req.userId is 0 (unauthenticated sentinel)', () => {
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 0 }), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
  });

  it('returns 401 when req.userId is negative', () => {
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: -1 }), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
  });

  it('returns 401 when req.userId is a non-number (e.g. JWT returns a string)', () => {
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw({ userId: '42' as any } as unknown as Request, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
  });
});

describe('requireEntitlement middleware — tier gating', () => {
  beforeEach(() => {
    _resetPortalOverridesForTests();
    mockIsOwnerUserRef.mockReturnValue(false);
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
  });

  afterEach(() => {
    mockGetDb.mockReset();
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
  });

  it('denies a Free user with 403 TIER_REQUIRED on a paid skill', () => {
    mockGetDb.mockReturnValue({ prepare: () => ({ get: () => undefined }) }); // no sub = free
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 901 }), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.code).toBe('TIER_REQUIRED');
    expect((res as any).body.error.details.currentPlan).toBe('free');
    expect((res as any).body.error.details.skill).toBe('content');
  });

  it('keeps token-zero Secretary product access when paid enforcement is enabled', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    mockGetDb.mockReturnValue({ prepare: () => ({ get: () => undefined }) });
    const mw = requireEntitlement({ skill: 'secretary' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 905 }), res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((res as any).statusCode).toBe(200);
  });

  it('uses AI_PLAN_REQUIRED when enforcement denies an ineligible paid skill', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    mockGetDb.mockReturnValue({ prepare: () => ({ get: () => undefined }) });
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 907 }), res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error).toMatchObject({
      code: 'AI_PLAN_REQUIRED',
      details: {
        currentPlan: 'free',
        skill: 'content',
        window: 'plan',
        unblocksAt: null,
        retryable: false,
      },
    });
  });

  it.each([false, true])('preserves beta product access with enforcement=%s', (enforcementEnabled) => {
    if (enforcementEnabled) process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    mockGetDb.mockReturnValue({
      prepare: () => ({
        get: () => ({
          plan: 'max',
          status: 'trialing',
          provider: 'beta',
          current_period_start: null,
          current_period_end: null,
        }),
      }),
    });
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 906 }), res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((res as any).statusCode).toBe(200);
  });

  it('permits a Pro (active stripe) user on a paid skill', () => {
    mockGetDb.mockReturnValue({
      prepare: () => ({
        get: () => ({ plan: 'pro', status: 'active', provider: 'stripe', current_period_end: null }),
      }),
    });
    const mw = requireEntitlement({ skill: 'content' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 902 }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).statusCode).toBe(200);
  });

  it('permits a Free user on the secretary skill', () => {
    mockGetDb.mockReturnValue({ prepare: () => ({ get: () => undefined }) });
    const mw = requireEntitlement({ skill: 'secretary' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 903 }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).statusCode).toBe(200);
  });

  it('denies a Pro user when minPlan is "max"', () => {
    mockGetDb.mockReturnValue({
      prepare: () => ({
        get: () => ({ plan: 'pro', status: 'active', provider: 'stripe', current_period_end: null }),
      }),
    });
    const mw = requireEntitlement({ skill: 'content', minPlan: 'max' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 904 }), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.error.details.requiredPlan).toBe('max');
    expect((res as any).body.error.details.currentPlan).toBe('pro');
  });

  it('permits an owner regardless of minPlan', () => {
    mockIsOwnerUserRef.mockReturnValue(true);
    const mw = requireEntitlement({ skill: 'content', minPlan: 'max' });
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ userId: 1 }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
  });
});
