import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(() => ({ policyVersion: 'apple-foundation-models.v1', enabled: false })),
  reserve: vi.fn(),
  settle: vi.fn(),
  evidence: vi.fn(),
}));

vi.mock('../../src/services/device-inference-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/device-inference-policy')>()),
  DEVICE_INFERENCE_POLICY_VERSION: 'apple-foundation-models.v1',
  getDeviceInferencePolicy: mocks.getPolicy,
  reserveDeviceInferenceAdmission: mocks.reserve,
  settleDeviceInferenceAdmission: mocks.settle,
  recordZeroCreditDeviceInferenceEvidence: mocks.evidence,
}));

import { deviceInferenceRoutes } from '../../src/api/routes/device-inference';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function mockRes(onSend: () => void): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; onSend(); return res; },
  };
  return res;
}

function request(method: string, path: string, deviceId = 'device-1'): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    params: {},
    query: {},
    body: {},
    headers: {},
    userId: 7,
    tenantId: 7,
    deviceId,
    header() { return undefined; },
  } as any;
}

async function dispatch(req: Request): Promise<MockRes> {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const res = mockRes(done);
  deviceInferenceRoutes().handle(req, res, done);
  await completed;
  return res;
}

describe('device inference routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a bounded authenticated device identity on every contract', async () => {
    const calls = [
      request('GET', '/policy', ''),
      request('POST', '/admissions', ''),
      request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle', ''),
      request('POST', '/evidence', ''),
      request('GET', '/policy', 'x'.repeat(201)),
    ];
    for (const req of calls) {
      const response = await dispatch(req);
      expect(response.statusCode).toBe(403);
      expect(response.body.error.code).toBe('DEVICE_ID_REQUIRED');
    }
    expect(mocks.getPolicy).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
  });

  it('returns the default-off policy for a registered authenticated device', async () => {
    const response = await dispatch(request('GET', '/policy'));
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({
      policyVersion: 'apple-foundation-models.v1',
      enabled: false,
    });
    expect(mocks.getPolicy).toHaveBeenCalledOnce();
  });
});
