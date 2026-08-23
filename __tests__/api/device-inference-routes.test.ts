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
  responseHeaders: Record<string, unknown>;
  setHeader(name: string, value: unknown): void;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function mockRes(onSend: () => void): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    responseHeaders: {},
    setHeader(name, value) { res.responseHeaders[name] = value; },
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
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    header() { return undefined; },
  } as any;
}

function withBody(req: Request, body: unknown): Request {
  req.body = body;
  return req;
}

const VALID_EVIDENCE = {
  osVersion: ' iOS 26.0 ',
  osBuild: ' 23A1 ',
  deviceModel: ' iPhone18,1 ',
  locale: ' pt-PT ',
  frameworkAvailable: true,
  availabilityReason: 'available',
  durationMs: 123,
};

async function dispatch(
  req: Request,
  router: ReturnType<typeof deviceInferenceRoutes> = deviceInferenceRoutes(),
): Promise<MockRes> {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const res = mockRes(done);
  router.handle(req, res, done);
  await completed;
  return res;
}

describe('device inference routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserve.mockReturnValue({
      kind: 'issued',
      admission: { id: '00000000-0000-0000-0000-000000000001', state: 'reserved' },
    });
    mocks.settle.mockReturnValue({ kind: 'settled', state: 'completed' });
    mocks.evidence.mockReturnValue(true);
  });

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

  it('rejects invalid tenant and user scope before evaluating a contract', async () => {
    const invalidScopes = [
      { tenantId: undefined },
      { tenantId: 0 },
      { tenantId: 1.5 },
      { userId: undefined },
      { userId: 0 },
      { userId: 1.5 },
    ];
    for (const scope of invalidScopes) {
      const req = request('GET', '/policy') as any;
      Object.assign(req, scope);
      const response = await dispatch(req);
      expect(response.statusCode).toBe(403);
      expect(response.body.error.code).toBe('DEVICE_ID_REQUIRED');
    }
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

  it('rate-limits repeated authorization requests without rejecting an ordinary request', async () => {
    const router = deviceInferenceRoutes();
    const ordinary = await dispatch(request('POST', '/evidence'), router);
    expect(ordinary.statusCode).toBe(400);
    expect(ordinary.body.error.code).toBe('DEVICE_EVIDENCE_INVALID');

    let throttled: MockRes | null = null;
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      throttled = await dispatch(request('POST', '/evidence'), router);
    }
    expect(throttled?.statusCode).toBe(429);
    expect(throttled?.body.error.code).toBe('RATE_LIMITED');
    expect(throttled?.responseHeaders['Retry-After']).toBe(60);
  });

  it('uses a bounded IP key when authentication is absent and accepts HEAD as a read request', async () => {
    const unauthenticated = request('POST', '/evidence') as any;
    unauthenticated.userId = 0;
    unauthenticated.ip = '';
    unauthenticated.socket = { remoteAddress: '' };
    expect((await dispatch(unauthenticated)).statusCode).toBe(403);

    const head = await dispatch(request('HEAD', '/policy'));
    expect(head.statusCode).toBe(200);
    expect(mocks.getPolicy).toHaveBeenCalledOnce();
  });

  it('validates admission inputs and preserves issued, replay, and denied semantics', async () => {
    const valid = {
      operationKey: 'standard_response',
      requestDigest: 'a'.repeat(64),
      clientOperationId: 'device-operation:1',
    };
    const invalidBodies = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, operationKey: 'deep' },
      { ...valid, requestDigest: 7 },
      { ...valid, requestDigest: 'not-a-digest' },
      { ...valid, clientOperationId: 7 },
      { ...valid, clientOperationId: 'spaces are invalid' },
    ];
    for (const body of invalidBodies) {
      const response = await dispatch(withBody(request('POST', '/admissions'), body));
      expect(response.statusCode).toBe(400);
      expect(response.body.error.code).toBe('DEVICE_ADMISSION_INVALID');
    }

    const issued = await dispatch(withBody(request('POST', '/admissions'), valid));
    expect(issued.statusCode).toBe(201);
    expect(issued.body.data.replay).toBe(false);
    expect(mocks.reserve).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 7,
      userId: 7,
      deviceId: 'device-1',
      requestDigest: 'a'.repeat(64),
      clientOperationId: 'device-operation:1',
    }));

    mocks.reserve.mockReturnValueOnce({
      kind: 'replay',
      admission: { id: '00000000-0000-0000-0000-000000000001', state: 'completed' },
    });
    const replay = await dispatch(withBody(request('POST', '/admissions'), valid));
    expect(replay.statusCode).toBe(201);
    expect(replay.body.data.replay).toBe(true);

    mocks.reserve.mockReturnValueOnce({
      kind: 'denied',
      code: 'DEVICE_POLICY_DISABLED',
      message: 'disabled',
      statusCode: 409,
    });
    const denied = await dispatch(withBody(request('POST', '/admissions'), valid));
    expect(denied.statusCode).toBe(409);
    expect(denied.body.error.code).toBe('DEVICE_POLICY_DISABLED');
  });

  it('rejects every malformed runtime-evidence shape and normalizes valid evidence', async () => {
    const invalidEvidence = [
      null,
      [],
      { ...VALID_EVIDENCE, extra: true },
      { ...VALID_EVIDENCE, osVersion: 7 },
      { ...VALID_EVIDENCE, osBuild: '   ' },
      { ...VALID_EVIDENCE, deviceModel: '' },
      { ...VALID_EVIDENCE, locale: null },
      { ...VALID_EVIDENCE, frameworkAvailable: 'yes' },
      { ...VALID_EVIDENCE, availabilityReason: 7 },
      { ...VALID_EVIDENCE, availabilityReason: 'forged' },
      { ...VALID_EVIDENCE, durationMs: 1.5 },
      { ...VALID_EVIDENCE, durationMs: -1 },
      { ...VALID_EVIDENCE, durationMs: 600_001 },
    ];
    for (const evidence of invalidEvidence) {
      const response = await dispatch(withBody(
        request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'),
        { outcome: 'completed', evidence },
      ));
      expect(response.statusCode).toBe(400);
      expect(response.body.error.code).toBe('DEVICE_EVIDENCE_INVALID');
    }

    const response = await dispatch(withBody(
      request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'),
      { outcome: 'completed', evidence: VALID_EVIDENCE },
    ));
    expect(response.statusCode).toBe(200);
    expect(mocks.settle).toHaveBeenLastCalledWith(expect.objectContaining({
      evidence: {
        ...VALID_EVIDENCE,
        osVersion: 'iOS 26.0',
        osBuild: '23A1',
        deviceModel: 'iPhone18,1',
        locale: 'pt-PT',
      },
    }));
  });

  it('validates settlement identity and returns not-found, settled, and replay states', async () => {
    const validBody = { outcome: 'fallback', evidence: { ...VALID_EVIDENCE, availabilityReason: null, durationMs: null } };
    const invalidRequests = [
      withBody(request('POST', '/admissions/not-an-id/settle'), validBody),
      withBody(request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'), null),
      withBody(request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'), []),
      withBody(request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'), { ...validBody, extra: true }),
      withBody(request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'), { ...validBody, outcome: 7 }),
      withBody(request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'), { ...validBody, outcome: 'forged' }),
    ];
    for (const req of invalidRequests) {
      const response = await dispatch(req);
      expect(response.statusCode).toBe(400);
      expect(response.body.error.code).toBe('DEVICE_SETTLEMENT_INVALID');
    }

    mocks.settle.mockReturnValueOnce({ kind: 'not_found' });
    const missing = await dispatch(withBody(
      request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'),
      validBody,
    ));
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error.code).toBe('DEVICE_ADMISSION_NOT_FOUND');

    const settled = await dispatch(withBody(
      request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'),
      validBody,
    ));
    expect(settled.body.data).toEqual({ state: 'completed', replay: false });

    mocks.settle.mockReturnValueOnce({ kind: 'replay', state: 'released' });
    const replay = await dispatch(withBody(
      request('POST', '/admissions/00000000-0000-0000-0000-000000000001/settle'),
      validBody,
    ));
    expect(replay.body.data).toEqual({ state: 'released', replay: true });
  });

  it('validates zero-credit evidence and records only the current eligible policy', async () => {
    const valid = {
      operationKey: 'local_content_parse',
      policyVersion: 'apple-foundation-models.v1',
      outcome: 'completed',
      evidence: { ...VALID_EVIDENCE, availabilityReason: undefined, durationMs: undefined },
    };
    const invalidBodies = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, operationKey: 'standard_response' },
      { ...valid, policyVersion: 'stale' },
      { ...valid, outcome: 7 },
      { ...valid, outcome: 'forged' },
    ];
    for (const body of invalidBodies) {
      const response = await dispatch(withBody(request('POST', '/evidence'), body));
      expect(response.statusCode).toBe(400);
      expect(response.body.error.code).toBe('DEVICE_EVIDENCE_INVALID');
    }

    const malformedEvidence = await dispatch(withBody(request('POST', '/evidence'), {
      ...valid,
      operationKey: 'local_content_summarize',
      evidence: { ...VALID_EVIDENCE, durationMs: -1 },
    }));
    expect(malformedEvidence.statusCode).toBe(400);

    mocks.evidence.mockReturnValueOnce(false);
    const stale = await dispatch(withBody(request('POST', '/evidence'), valid));
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.code).toBe('DEVICE_POLICY_STALE');

    const recorded = await dispatch(withBody(request('POST', '/evidence'), valid));
    expect(recorded.statusCode).toBe(200);
    expect(recorded.body.data).toEqual({ recorded: true });
    expect(mocks.evidence).toHaveBeenLastCalledWith(expect.objectContaining({
      operationKey: 'local_content_parse',
      policyVersion: 'apple-foundation-models.v1',
      outcome: 'completed',
    }));
  });
});
