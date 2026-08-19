// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * QA5 P1-2: the plan's audited administrative credit grant existed in the
 * ledger but had no operator surface, so the documented incident-recovery
 * override did not exist in practice. These tests pin the route's closed body
 * contract, owner-derived attribution, and audit row.
 */

import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getOwnerTarget: vi.fn(),
  insertAudit: vi.fn(),
  grantAdminCredits: vi.fn(),
}));

vi.mock('express-rate-limit', () => ({
  ipKeyGenerator: (value: string) => value,
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../src/api/secret-guards', async () => ({
  ...(await vi.importActual<typeof import('../../src/api/secret-guards')>(
    '../../src/api/secret-guards',
  )),
  requirePortalAdminToken: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../src/api/rate-limiter', async () => ({
  ...(await vi.importActual<typeof import('../../src/api/rate-limiter')>('../../src/api/rate-limiter')),
  extractClientIp: () => '127.0.0.1',
}));
vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: mocks.getDb,
}));
vi.mock('../../src/services/ai-credit-ledger', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/ai-credit-ledger')>(
    '../../src/services/ai-credit-ledger',
  )),
  grantAdminAiCredits: mocks.grantAdminCredits,
}));
vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service')),
  getOwnerBootstrapTarget: mocks.getOwnerTarget,
}));
vi.mock('../../src/portal/admin-audit', async () => ({
  ...(await vi.importActual<typeof import('../../src/portal/admin-audit')>('../../src/portal/admin-audit')),
  insertPortalAdminMutationAuditStrict: mocks.insertAudit,
}));
vi.mock('../../src/utils/logger', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger')),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import { aiCreditGrantsAdminRoutes } from '../../src/api/routes/ai-credit-grants-admin';

interface MockResponse {
  statusCode: number;
  body: any;
  status(code: number): MockResponse;
  json(body: any): MockResponse;
  setHeader(): MockResponse;
  getHeader(): unknown;
}

async function dispatch(body: unknown): Promise<MockResponse> {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const req = {
    method: 'POST',
    url: '/',
    originalUrl: '/',
    baseUrl: '',
    path: '/',
    params: {},
    query: {},
    body,
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    header: () => undefined,
  } as unknown as Request;
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; done(); return res; },
    setHeader() { return res; },
    getHeader() { return undefined; },
  };
  aiCreditGrantsAdminRoutes().handle(req, res as unknown as Response, done);
  await completed;
  return res;
}

const LOT = {
  id: 7,
  userId: 40,
  lotType: 'promotional',
  creditsGranted: 100,
  creditsRemaining: 100,
};

const VALID = {
  userId: 40,
  grantId: 'support-2026-08-19-a',
  credits: 100,
  expiryDays: 30,
  reason: 'goodwill after a failed generation',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnerTarget.mockReturnValue({ tenantId: 42, telegramId: 99 });
  mocks.getDb.mockReturnValue({});
  mocks.grantAdminCredits.mockReturnValue({ kind: 'granted', lot: LOT });
});

describe('ai credit grants admin route (QA5 P1-2)', () => {
  it('grants with owner attribution and writes a portal admin audit row', async () => {
    const res = await dispatch({ ...VALID });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ lot: LOT, granted: true, replay: false });
    expect(mocks.grantAdminCredits).toHaveBeenCalledWith(expect.objectContaining({
      userId: 40,
      grantId: 'support-2026-08-19-a',
      credits: 100,
      expiryDays: 30,
      // Attribution comes from the owner bootstrap identity, never the body.
      actorUserId: 42,
      reason: 'goodwill after a failed generation',
    }));
    expect(mocks.insertAudit).toHaveBeenCalledTimes(1);
    const [, , auditInput] = mocks.insertAudit.mock.calls[0] as any[];
    expect(auditInput).toMatchObject({
      resource: 'ai_credit_admin_grant.support-2026-08-19-a',
      details: { targetUserId: 40, credits: 100, expiryDays: 30 },
    });
  });

  it('reports an idempotent replay without writing a second audit row', async () => {
    mocks.grantAdminCredits.mockReturnValue({ kind: 'already_granted', lot: LOT });
    const res = await dispatch({ ...VALID });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ lot: LOT, granted: false, replay: true });
    expect(mocks.insertAudit).not.toHaveBeenCalled();
  });

  it('enforces a closed body contract', async () => {
    const rejected: unknown[] = [
      null,
      'not-an-object',
      [],
      { ...VALID, unexpected: 'field' },
      { ...VALID, userId: 0 },
      { ...VALID, userId: 1.5 },
      { ...VALID, grantId: '   ' },
      { ...VALID, grantId: 'x'.repeat(201) },
      { ...VALID, credits: 0 },
      { ...VALID, credits: 2.5 },
      { ...VALID, expiryDays: 0 },
      { ...VALID, expiryDays: 1.5 },
      { ...VALID, reason: '' },
      { ...VALID, reason: 'x'.repeat(501) },
    ];
    for (const body of rejected) {
      const res = await dispatch(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('AI_CREDIT_GRANT_INVALID');
    }
    expect(mocks.grantAdminCredits).not.toHaveBeenCalled();
  });

  it('surfaces a ledger rejection as a 400 without an audit row', async () => {
    mocks.grantAdminCredits.mockReturnValue({ kind: 'rejected', reason: 'credits must be a positive integer up to 5000' });
    const res = await dispatch({ ...VALID, credits: 5001 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('AI_CREDIT_GRANT_REJECTED');
    expect(mocks.insertAudit).not.toHaveBeenCalled();
  });

  it('refuses when the owner bootstrap identity is unavailable', async () => {
    mocks.getOwnerTarget.mockReturnValue(null);
    const res = await dispatch({ ...VALID });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('OWNER_UNAVAILABLE');
    expect(mocks.grantAdminCredits).not.toHaveBeenCalled();
  });

  it('fails closed when the ledger throws', async () => {
    mocks.grantAdminCredits.mockImplementation(() => { throw new Error('ledger exploded'); });
    const res = await dispatch({ ...VALID });
    expect(res.statusCode).toBe(500);
    expect(mocks.insertAudit).not.toHaveBeenCalled();
  });
});
