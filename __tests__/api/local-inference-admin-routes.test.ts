// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildSummary: vi.fn(),
  drainWaiting: vi.fn(),
  getControl: vi.fn(),
  getDb: vi.fn(),
  getEndUserErrors: vi.fn(),
  getNonAiLatency: vi.fn(),
  getOwnerTarget: vi.fn(),
  getProvider: vi.fn(),
  insertAudit: vi.fn(),
  loggerWarn: vi.fn(),
  setControl: vi.fn(),
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
vi.mock('../../src/services/local-inference-reporting', () => ({
  buildLocalInferenceSummary: mocks.buildSummary,
}));
vi.mock('../../src/services/provider-registry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/provider-registry')>(
    '../../src/services/provider-registry',
  )),
  getProvider: mocks.getProvider,
}));
vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: mocks.getDb,
}));
vi.mock('../../src/services/local-inference-runtime-control', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/local-inference-runtime-control')>(
    '../../src/services/local-inference-runtime-control',
  )),
  drainLocalInferenceWaitingQueueForRuntimeOff: mocks.drainWaiting,
  getLocalInferenceRuntimeControl: mocks.getControl,
  LocalInferenceRuntimeControlError: class extends Error {},
  setLocalInferenceRuntimeControl: mocks.setControl,
}));
vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service')),
  getOwnerBootstrapTarget: mocks.getOwnerTarget,
}));
vi.mock('../../src/portal/admin-audit', async () => ({
  ...(await vi.importActual<typeof import('../../src/portal/admin-audit')>('../../src/portal/admin-audit')),
  insertPortalAdminMutationAuditStrict: mocks.insertAudit,
}));
vi.mock('../../src/api/request-timer', async () => ({
  ...(await vi.importActual<typeof import('../../src/api/request-timer')>('../../src/api/request-timer')),
  getEndUserApiErrorSnapshot: mocks.getEndUserErrors,
  getNonAiLatencySnapshot: mocks.getNonAiLatency,
}));
vi.mock('../../src/utils/logger', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger')),
  logger: {
    info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
}));

import { localInferenceAdminRoutes } from '../../src/api/routes/local-inference-admin';

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, unknown>;
  status(code: number): MockResponse;
  json(body: any): MockResponse;
  setHeader(name: string, value: unknown): MockResponse;
  getHeader(name: string): unknown;
}

async function dispatch(
  url: string,
  input: { method?: string; body?: Record<string, unknown> } = {},
): Promise<MockResponse> {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const query = Object.fromEntries(new URL(url, 'http://localhost').searchParams.entries());
  const req = {
    method: input.method ?? 'GET',
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    params: {},
    query,
    body: input.body ?? {},
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    header: () => undefined,
  } as unknown as Request;
  const headers: Record<string, unknown> = {};
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    headers,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; done(); return res; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return res; },
    getHeader(name) { return headers[name.toLowerCase()]; },
  };
  localInferenceAdminRoutes().handle(req, res as unknown as Response, done);
  await completed;
  return res;
}

describe('local inference admin routes', () => {
  beforeEach(() => {
    mocks.buildSummary.mockReset().mockReturnValue({ schemaVersion: 'local-inference-summary.v1' });
    mocks.drainWaiting.mockReset();
    mocks.getControl.mockReset();
    mocks.getDb.mockReset();
    mocks.getEndUserErrors.mockReset();
    mocks.getNonAiLatency.mockReset();
    mocks.getOwnerTarget.mockReset();
    mocks.getProvider.mockReset();
    mocks.insertAudit.mockReset();
    mocks.loggerWarn.mockReset();
    mocks.setControl.mockReset();
  });

  it('returns aggregate evidence together with the independently probed model identity', async () => {
    const getProviderHealth = vi.fn().mockResolvedValue({
      name: 'ollama',
      healthy: true,
      degraded: false,
      activeModel: 'qwen3.5:9b',
      activeModelDigest: 'sha256:signed',
      observedModelDigest: 'sha256:signed',
      manifestVersion: '2026-08-24.1',
      transport: 'unix_socket_gateway',
    });
    mocks.getProvider.mockReturnValue({ getProviderHealth });

    const response = await dispatch('/summary?windowHours=72');

    expect(response.statusCode).toBe(200);
    expect(mocks.buildSummary).toHaveBeenCalledWith(72);
    expect(getProviderHealth).toHaveBeenCalledOnce();
    expect(response.body.data).toMatchObject({
      summary: { schemaVersion: 'local-inference-summary.v1' },
      modelHealth: {
        healthy: true,
        activeModelDigest: 'sha256:signed',
        observedModelDigest: 'sha256:signed',
        transport: 'unix_socket_gateway',
      },
    });
  });

  it('keeps aggregate reporting available when provider construction or probing fails', async () => {
    mocks.getProvider.mockImplementation(() => { throw new Error('provider unavailable'); });

    const response = await dispatch('/summary');

    expect(response.statusCode).toBe(200);
    expect(response.body.data.modelHealth).toEqual({
      name: 'ollama',
      healthy: false,
      degraded: true,
      warning: 'provider_health_probe_failed',
    });
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
  });

  it('rejects report windows outside the bounded contract before probing the provider', async () => {
    const response = await dispatch('/summary?windowHours=2161');

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('LOCAL_REPORT_WINDOW_INVALID');
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.buildSummary).not.toHaveBeenCalled();
  });

  it('uses the canonical owner tenant id to mutate and audit runtime control', async () => {
    const db = {
      transaction: (callback: () => unknown) => ({ immediate: callback }),
    };
    const before = {
      environment: 'production',
      mode: 'off',
      rolloutPercent: 0,
    };
    const after = {
      ...before,
      mode: 'shadow',
      manifestVersion: '2026-08-24.1',
      activeModelId: 'qwen2.5-3b-control',
      activeModelDigest: 'sha256:signed-model',
      profileVersion: 'nexus-skill-inference-v1',
      nonAiP95BaselineMs: 12,
      nonAiBaselineSampleCount: 20,
      nonAiBaselineCapturedAt: '2026-08-12T00:00:00.000Z',
      endUserErrorRateBaselinePercent: 0,
      endUserErrorBaselineSampleCount: 20,
    };
    mocks.getDb.mockReturnValue(db);
    mocks.getControl.mockReturnValue(before);
    mocks.getOwnerTarget.mockReturnValue({ tenantId: 42, telegramId: 99 });
    mocks.getNonAiLatency.mockReturnValue({ sampleCount: 20, p95Ms: 12 });
    mocks.getEndUserErrors.mockReturnValue({ sampleCount: 20, serverErrorRatePercent: 0 });
    mocks.setControl.mockReturnValue(after);

    const response = await dispatch('/runtime-control', {
      method: 'POST',
      body: {
        mode: 'shadow',
        rolloutPercent: 0,
        reason: 'owner starts shadow evidence',
        evidenceReference: 'qa:runtime-control-post',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.setControl).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'shadow',
      updatedBy: 42,
      actorType: 'owner',
      nonAiP95BaselineMs: 12,
      endUserErrorRateBaselinePercent: 0,
    }), db, { deferInMemoryQueueDrain: true });
    expect(mocks.insertAudit).toHaveBeenCalledWith(db, expect.anything(), expect.objectContaining({
      userId: 42,
      tenantId: 42,
      resource: 'local_inference.runtime_control',
      details: expect.objectContaining({
        activeModelDigest: 'sha256:signed-model',
        profileVersion: 'nexus-skill-inference-v1',
      }),
    }));
    expect(response.body.data.runtimeControl).toEqual(after);
  });

  it('captures both pre-activation baselines for a direct production OFF-to-active transition', async () => {
    const db = {
      transaction: (callback: () => unknown) => ({ immediate: callback }),
    };
    mocks.getDb.mockReturnValue(db);
    mocks.getControl.mockReturnValue({
      environment: 'production',
      mode: 'off',
      rolloutPercent: 0,
    });
    mocks.getOwnerTarget.mockReturnValue({ tenantId: 42, telegramId: 99 });
    mocks.getNonAiLatency.mockReturnValue({ sampleCount: 25, p95Ms: 18 });
    mocks.getEndUserErrors.mockReturnValue({ sampleCount: 30, serverErrorRatePercent: 0.2 });
    mocks.setControl.mockReturnValue({
      environment: 'production',
      mode: 'active',
      rolloutPercent: 100,
    });

    const response = await dispatch('/runtime-control', {
      method: 'POST',
      body: {
        mode: 'active',
        rolloutPercent: 100,
        reason: 'owner activates accepted release',
        evidenceReference: 'sha256:accepted-economics-v6',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.setControl).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'active',
      rolloutPercent: 100,
      nonAiP95BaselineMs: 18,
      nonAiBaselineSampleCount: 25,
      endUserErrorRateBaselinePercent: 0.2,
      endUserErrorBaselineSampleCount: 30,
    }), db, { deferInMemoryQueueDrain: true });
  });
});
