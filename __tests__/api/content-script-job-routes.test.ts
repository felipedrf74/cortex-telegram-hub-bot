import { Router, type Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jobMocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
}));

vi.mock('../../src/services/content-script-jobs', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/content-script-jobs')>(
    '../../src/services/content-script-jobs',
  );
  class ContentScriptJobError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
      readonly details?: Record<string, unknown>,
    ) {
      super(message);
    }
  }
  return {
    ...actual,
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
import { ContentScriptJobCreditSettlementError } from '../../src/services/content-script-job-credits';

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

  it('fails cancellation closed when the terminal credit release cannot commit', async () => {
    jobMocks.cancel.mockImplementationOnce(() => {
      throw new ContentScriptJobCreditSettlementError('release_error');
    });

    const response = await dispatch('POST', '/script-jobs/script-job-1/cancel');

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toEqual({
      code: 'CONTENT_SCRIPT_CREDIT_SETTLEMENT_FAILED',
      message: 'The script state could not be committed with its credit settlement.',
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

  it.each([
    { label: 'format alias', field: 'format', value: 'shorts' },
    { label: 'mode casing', field: 'mode', value: 'DRAFT' },
    { label: 'language alias', field: 'language', value: 'en' },
    { label: 'render mode casing', field: 'renderMode', value: 'STRUCTURED' },
    { label: 'script style alias', field: 'scriptStyle', value: 'outline' },
    { label: 'legacy style field', field: 'style', value: 'outline' },
    { label: 'string minute duration', field: 'maxDurationMinutes', value: '8' },
    { label: 'fractional second duration', field: 'targetDurationSeconds', value: 60.5 },
    { label: 'string force-refresh flag', field: 'forceRefresh', value: 'true' },
    { label: 'null delivery mode', field: 'deliveryMode', value: null },
    { label: 'empty delivery mode', field: 'deliveryMode', value: '' },
    { label: 'unsupported delivery mode', field: 'deliveryMode', value: 'STANDARD' },
  ])('rejects an explicit non-contract $label before service dispatch', async ({ field, value }) => {
    const response = await dispatch('POST', '/script-jobs', {
      topic: 'Strict async request',
      [field]: value,
    }, 42, 42, { 'x-idempotency-key': 'strict-async-request-001' });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION',
      details: { field },
    });
    expect(jobMocks.create).not.toHaveBeenCalled();
  });

  it.each([42, null, { nested: true }])(
    'rejects a non-string body idempotency key even when the header is valid',
    async (idempotencyKey) => {
      const response = await dispatch('POST', '/script-jobs', {
        topic: 'Typed idempotency source',
        idempotencyKey,
      }, 42, 42, { 'x-idempotency-key': 'typed-idempotency-request-001' });

      expect(response.statusCode).toBe(400);
      expect(response.body.error).toMatchObject({
        code: 'VALIDATION',
        message: 'idempotencyKey must be a string.',
        details: { field: 'idempotencyKey' },
      });
      expect(jobMocks.create).not.toHaveBeenCalled();
    },
  );

  it('rejects an explicit empty body idempotency key instead of falling through to the header', async () => {
    const response = await dispatch('POST', '/script-jobs', {
      topic: 'No empty key fallback',
      idempotencyKey: '',
    }, 42, 42, { 'x-idempotency-key': 'valid-header-request-001' });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION',
      message: 'idempotencyKey must not be empty.',
      details: { field: 'idempotencyKey' },
    });
    expect(jobMocks.create).not.toHaveBeenCalled();
  });

  it('preserves typed service validation for an explicit-null pinned-source field', async () => {
    jobMocks.create.mockImplementationOnce(() => {
      throw new ContentScriptJobError(
        'VALIDATION',
        'sources[0].title must be a string.',
        400,
        { field: 'sources[0].title', reason: 'invalid_type' },
      );
    });
    const response = await dispatch('POST', '/script-jobs', {
      topic: 'Typed source field',
      sources: [{ title: null, relevance_note: 'Context' }],
    }, 42, 42, { 'x-idempotency-key': 'typed-source-field-001' });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION',
      details: { field: 'sources[0].title', reason: 'invalid_type' },
    });
  });

  it.each([null, [], 'not-an-object'])('rejects a non-object create body before service dispatch', async (body) => {
    const response = await dispatch(
      'POST',
      '/script-jobs',
      body,
      42,
      42,
      { 'x-idempotency-key': 'typed-body-request-001' },
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION',
      details: { field: 'body' },
    });
    expect(jobMocks.create).not.toHaveBeenCalled();
  });

  it('rejects oversized body and header idempotency keys before service dispatch', async () => {
    const oversizedKey = 'x'.repeat(201);
    const bodyResponse = await dispatch('POST', '/script-jobs', {
      topic: 'Oversized body key',
      idempotencyKey: oversizedKey,
    });

    expect(bodyResponse.statusCode).toBe(400);
    expect(bodyResponse.body.error).toEqual({
      code: 'VALIDATION',
      message: 'idempotencyKey must be at most 200 characters.',
    });
    expect(jobMocks.create).not.toHaveBeenCalled();

    const headerResponse = await dispatch('POST', '/script-jobs', {
      topic: 'Oversized header key',
    }, 42, 42, { 'x-idempotency-key': oversizedKey });

    expect(headerResponse.statusCode).toBe(400);
    expect(headerResponse.body.error.code).toBe('VALIDATION');
    expect(jobMocks.create).not.toHaveBeenCalled();
  });
});

async function dispatch(
  method: string,
  path: string,
  body: unknown = {},
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
