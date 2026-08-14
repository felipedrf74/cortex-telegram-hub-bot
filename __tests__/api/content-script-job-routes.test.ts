import { Router, type Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jobMocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
}));

vi.mock('../../src/services/content-script-jobs', () => {
  class ContentScriptJobError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    ContentScriptJobError,
    createContentScriptJob: (...args: unknown[]) => jobMocks.create(...args),
    getContentScriptJob: (...args: unknown[]) => jobMocks.get(...args),
    cancelContentScriptJob: (...args: unknown[]) => jobMocks.cancel(...args),
    retryContentScriptJob: (...args: unknown[]) => jobMocks.retry(...args),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerContentScriptJobRoutes } from '../../src/api/routes/content-script-job-routes';
import { ContentScriptJobError } from '../../src/services/content-script-jobs';
import { ContentScriptJobEncryptionError } from '../../src/services/content-script-job-encryption';

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
}

describe('content script job routes', () => {
  beforeEach(() => {
    Object.values(jobMocks).forEach((mock) => mock.mockReset());
    jobMocks.create.mockReturnValue({
      replayed: false,
      job: { jobId: 'script-job-1', status: 'queued', progress: 0 },
    });
    jobMocks.get.mockReturnValue({ jobId: 'script-job-1', status: 'completed', result: { script: 'ready' } });
    jobMocks.cancel.mockReturnValue({ jobId: 'script-job-1', status: 'cancelled' });
    jobMocks.retry.mockReturnValue({ jobId: 'script-job-1', status: 'queued' });
  });

  it('preserves the additive create, read, cancel, and retry HTTP contracts', async () => {
    const created = await dispatch('POST', '/script-jobs', {
      topic: 'Private launch',
      format: 'YouTube',
    }, 42, 42, { 'x-idempotency-key': 'script-route-create-001' });
    const read = await dispatch('GET', '/script-jobs/script-job-1');
    const cancelled = await dispatch('POST', '/script-jobs/script-job-1/cancel');
    const retried = await dispatch('POST', '/script-jobs/script-job-1/retry');

    expect(created.statusCode).toBe(202);
    expect(created.body.data).toMatchObject({ jobId: 'script-job-1', status: 'queued' });
    expect(jobMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'script-route-create-001',
      request: expect.objectContaining({ topic: 'Private launch', format: 'YouTube' }),
    }));
    expect(read.body.data).toMatchObject({ jobId: 'script-job-1', status: 'completed' });
    expect(jobMocks.get).toHaveBeenCalledWith(42, 42, 'script-job-1');
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(jobMocks.cancel).toHaveBeenCalledWith({ tenantId: 42, userId: 42, jobId: 'script-job-1' });
    expect(retried.statusCode).toBe(202);
    expect(jobMocks.retry).toHaveBeenCalledWith({ tenantId: 42, userId: 42, jobId: 'script-job-1' });
  });

  it('keeps jobs tenant-private and does not invoke service handlers on scope mismatch', async () => {
    const mismatch = await dispatch('POST', '/script-jobs/script-job-1/cancel', {}, 42, 77);
    jobMocks.get.mockReturnValueOnce(null);
    const foreignRead = await dispatch('GET', '/script-jobs/not-owned');

    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.body.error.code).toBe('CONTENT_TENANT_SCOPE_MISMATCH');
    expect(jobMocks.cancel).not.toHaveBeenCalled();
    expect(foreignRead.statusCode).toBe(404);
    expect(foreignRead.body.error.code).toBe('CONTENT_SCRIPT_JOB_NOT_FOUND');
  });

  it('returns replay status and sanitizes encryption-key failures', async () => {
    jobMocks.create.mockReturnValueOnce({
      replayed: true,
      job: { jobId: 'script-job-1', status: 'queued', progress: 0 },
    });
    const replay = await dispatch('POST', '/script-jobs', {
      idempotencyKey: 'script-route-create-001',
      topic: 'Private launch',
    });
    jobMocks.cancel.mockImplementationOnce(() => {
      throw new ContentScriptJobEncryptionError(
        'CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE',
        'private key material and ciphertext details',
      );
    });
    const unavailable = await dispatch('POST', '/script-jobs/script-job-1/cancel');

    expect(replay.statusCode).toBe(200);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body.error).toEqual({
      code: 'CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE',
      message: 'Content script job encryption material is temporarily unavailable.',
    });
    expect(JSON.stringify(unavailable.body)).not.toContain('ciphertext');
    expect(JSON.stringify(unavailable.body)).not.toContain('private key material');
  });

  it('maps a service idempotency conflict to HTTP 409', async () => {
    jobMocks.create.mockImplementationOnce(() => {
      throw new ContentScriptJobError(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key belongs to another script request.',
        409,
      );
    });

    const response = await dispatch('POST', '/script-jobs', {
      topic: 'Conflicting replay',
      idempotencyKey: 'conflict-key',
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.error).toEqual({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'This idempotency key belongs to another script request.',
    });
  });

  it('accepts matching body/header keys and rejects ambiguous idempotency sources before service dispatch', async () => {
    const matching = await dispatch('POST', '/script-jobs', {
      topic: 'Matching source',
      idempotencyKey: 'same-key',
    }, 42, 42, { 'x-idempotency-key': 'same-key' });
    expect(matching.statusCode).toBe(202);
    expect(jobMocks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      idempotencyKey: 'same-key',
    }));

    jobMocks.create.mockClear();
    const ambiguous = await dispatch('POST', '/script-jobs', {
      topic: 'Ambiguous source',
      idempotencyKey: 'body-key',
    }, 42, 42, { 'x-idempotency-key': 'header-key' });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.body.error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(jobMocks.create).not.toHaveBeenCalled();
  });
});

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 42,
  tenantId: number | undefined = 42,
  headers: Record<string, string> = {},
): Promise<MockResponse> {
  const router = Router();
  registerContentScriptJobRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
    if (Number.isSafeInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return false;
  });
  const request = {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    params: {},
    query: {},
    body,
    userId,
    tenantId,
    headers,
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
  } as unknown as Request;
  const response = mockResponse();
  await new Promise<void>((resolve, reject) => {
    (router as any).handle(request, response, (error: unknown) => error ? reject(error) : resolve());
    setImmediate(resolve);
  });
  await vi.waitFor(() => expect(response.body).not.toBeNull());
  return response;
}

function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { response.statusCode = code; return response; },
    json(body) { response.body = body; return response; },
    setHeader(name, value) { response.headers[name.toLowerCase()] = String(value); },
    getHeader(name) { return response.headers[name.toLowerCase()]; },
  };
  return response;
}
