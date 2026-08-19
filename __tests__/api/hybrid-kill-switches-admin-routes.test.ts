// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getOwnerTarget: vi.fn(),
  insertAudit: vi.fn(),
  listSwitches: vi.fn(),
  setSwitch: vi.fn(),
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
vi.mock('../../src/services/hybrid-runtime-kill-switches', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/hybrid-runtime-kill-switches')>(
    '../../src/services/hybrid-runtime-kill-switches',
  )),
  listHybridKillSwitches: mocks.listSwitches,
  setHybridKillSwitch: mocks.setSwitch,
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

import { hybridKillSwitchesAdminRoutes } from '../../src/api/routes/hybrid-kill-switches-admin';

interface MockResponse {
  statusCode: number;
  body: any;
  status(code: number): MockResponse;
  json(body: any): MockResponse;
  setHeader(): MockResponse;
  getHeader(): unknown;
}

async function dispatch(
  url: string,
  input: { method?: string; body?: Record<string, unknown> } = {},
): Promise<MockResponse> {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const req = {
    method: input.method ?? 'GET',
    url,
    originalUrl: url,
    baseUrl: '',
    path: url,
    params: {},
    query: {},
    body: input.body ?? {},
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    header: () => undefined,
  } as unknown as Request;
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; done(); return res; },
    setHeader() { return res; },
    getHeader() { return undefined; },
  };
  hybridKillSwitchesAdminRoutes().handle(req, res as unknown as Response, done);
  await completed;
  return res;
}

const ENGAGED_STATE = {
  controlKey: 'hybrid_credits',
  engaged: true,
  reason: 'incident stop',
  actorUserId: 42,
  updatedAt: '2026-08-19T12:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnerTarget.mockReturnValue({ tenantId: 42, telegramId: 99 });
  mocks.getDb.mockReturnValue({});
  mocks.listSwitches.mockReturnValue([ENGAGED_STATE]);
  mocks.setSwitch.mockReturnValue({ kind: 'updated', state: ENGAGED_STATE });
});

describe('hybrid kill-switches admin routes (NH-0040)', () => {
  it('lists the switch states', async () => {
    const res = await dispatch('/');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.killSwitches).toEqual([ENGAGED_STATE]);
  });

  it('engages a switch with owner attribution and a portal admin audit row', async () => {
    const res = await dispatch('/', {
      method: 'POST',
      body: { controlKey: 'hybrid_credits', engaged: true, reason: 'incident stop' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.changed).toBe(true);
    expect(mocks.setSwitch).toHaveBeenCalledWith({
      controlKey: 'hybrid_credits',
      engaged: true,
      actorUserId: 42,
      reason: 'incident stop',
    });
    expect(mocks.insertAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      resource: 'hybrid_kill_switch.hybrid_credits',
    }));
  });

  it('does not write a portal audit row for an unchanged flip', async () => {
    mocks.setSwitch.mockReturnValue({ kind: 'unchanged', state: ENGAGED_STATE });
    const res = await dispatch('/', {
      method: 'POST',
      body: { controlKey: 'hybrid_credits', engaged: true, reason: 'again' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(mocks.insertAudit).not.toHaveBeenCalled();
  });

  it('refuses an open contract: unknown keys, bad key, non-boolean, empty or oversized reason', async () => {
    const bads = [
      { controlKey: 'hybrid_credits', engaged: true, reason: 'x', extra: 1 },
      { controlKey: 'not_a_switch', engaged: true, reason: 'x' },
      { controlKey: 'hybrid_credits', engaged: 'true', reason: 'x' },
      { controlKey: 'hybrid_credits', engaged: true, reason: '   ' },
      { controlKey: 'hybrid_credits', engaged: true, reason: 'r'.repeat(501) },
    ];
    for (const body of bads) {
      const res = await dispatch('/', { method: 'POST', body });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('HYBRID_KILL_SWITCH_INVALID');
    }
    expect(mocks.setSwitch).not.toHaveBeenCalled();
  });

  it('surfaces service rejections and missing owner identity', async () => {
    mocks.setSwitch.mockReturnValue({ kind: 'rejected', reason: 'control row missing; run migrations' });
    const rejected = await dispatch('/', {
      method: 'POST',
      body: { controlKey: 'hybrid_credits', engaged: true, reason: 'x' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.error.code).toBe('HYBRID_KILL_SWITCH_REJECTED');

    mocks.getOwnerTarget.mockReturnValue(null);
    const noOwner = await dispatch('/', {
      method: 'POST',
      body: { controlKey: 'hybrid_credits', engaged: true, reason: 'x' },
    });
    expect(noOwner.statusCode).toBe(503);
    expect(noOwner.body.error.code).toBe('OWNER_UNAVAILABLE');
  });
});
