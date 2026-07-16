// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express from 'express';
import http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({
  buildSummary: vi.fn(),
  logAdminMutation: vi.fn(),
  logAudit: vi.fn(),
  recordPhysicalDevice: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    health: { allowUnauthenticatedDetailed: false },
    portal: {
      token: '', readToken: '', writeToken: '', adminToken: 'product-learning-admin-token',
      adminRequireActor: false, adminActorAllowlist: [], adminActorSignatureSecret: '',
      adminActorSignatureToleranceMs: 300000, sessionSecret: '', sessionMaxAgeMs: 28800000,
      requireSessionAuth: false, allowLegacyFallback: false, allowLocalBypass: false,
    },
  },
}));

vi.mock('../../src/services/audit-trail', () => ({ getAuditTrail: vi.fn(() => []), logAudit: mocks.logAudit }));
vi.mock('../../src/services/user-service', () => ({ getOwnerBootstrapTarget: vi.fn(() => ({ tenantId: 1 })) }));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { productLearningAdminRoutes } from '../../src/api/routes/product-learning-admin';
import {
  createAdminPreBodyGuard,
  PRODUCT_LEARNING_ADMIN_BODY_LIMIT_BYTES,
  type AdminPreBodyGuardOptions,
} from '../../src/api/admin-pre-body-guard';

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, unknown>;
  status(code: number): MockResponse;
  json(body: any): MockResponse;
  setHeader(name: string, value: unknown): MockResponse;
  getHeader(name: string): unknown;
}

function request(
  method: 'GET' | 'POST',
  url: string,
  options: { query?: Record<string, unknown>; body?: unknown; token?: string } = {},
): Request {
  const token = options.token === undefined ? 'product-learning-admin-token' : options.token;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return {
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    params: {},
    query: options.query ?? {},
    body: options.body ?? {},
    headers,
    ip: '203.0.113.9',
    socket: { remoteAddress: '203.0.113.9' },
    header(name: string) { return headers[name.toLowerCase()]; },
  } as any;
}

async function dispatch(req: Request): Promise<MockResponse> {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
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
  productLearningAdminRoutes({
    buildSummary: mocks.buildSummary,
    logAdminMutation: mocks.logAdminMutation,
    recordPhysicalDevice: mocks.recordPhysicalDevice,
  }).handle(req, res, done);
  await completed;
  return res;
}

describe('product learning admin routes', () => {
  beforeEach(() => {
    mocks.buildSummary.mockReset().mockReturnValue({
      schemaVersion: 'product-learning-observability.v1',
      generatedAt: '2026-07-15T12:00:00.000Z',
      schemaAvailable: true,
      scope: { tenantId: 7 },
      totals: {
        cases: 3,
        activeCases: 2,
        historicalCases: 1,
        retiredCases: 0,
        staleCases: 1,
        exportEligibleGoldenCases: 0,
        promotions: 1,
      },
      lifecycleCounts: { observed: 2, candidate: 1, reviewed: 0, golden: 0, retired: 0 },
      transitionCounts: { observed_to_candidate: 1 },
      feedback: { adaptationAccepted: 1, adaptationDismissed: 1, acceptanceRate: 0.5 },
      coverage: { observedCategories: 3, totalCategories: 8, missingCategories: [] },
      activity: {
        active: {
          cases: 2,
          lifecycleCounts: { observed: 2, candidate: 0, reviewed: 0, golden: 0, retired: 0 },
          feedback: { adaptationAccepted: 1, adaptationDismissed: 0, acceptanceRate: 1 },
          coverage: { observedCategories: 2, totalCategories: 8, missingCategories: [] },
        },
        historical: {
          cases: 1,
          lifecycleCounts: { observed: 0, candidate: 1, reviewed: 0, golden: 0, retired: 0 },
          feedback: { adaptationAccepted: 0, adaptationDismissed: 1, acceptanceRate: 0 },
          coverage: { observedCategories: 1, totalCategories: 8, missingCategories: [] },
        },
      },
      categories: [],
    });
    mocks.logAdminMutation.mockReset();
    mocks.logAudit.mockReset();
    mocks.recordPhysicalDevice.mockReset().mockReturnValue({
      id: 'training-physical-device-observation-opaque',
      tenantId: 7,
      userId: 7,
      owner: 'training',
      lifecycle: 'observed',
      privacyClass: 'redacted-product',
      redactedInput: { kind: 'physical_device_observation', outcomeCode: 'failed', subjectFingerprint: 'a'.repeat(64) },
      expectedContract: { contractId: 'training.physical_device.v1' },
      evidenceReferences: ['testflight://build/56/review-availability'],
      producerVersion: 'training-learning-producers.v2',
      confidence: 1,
      observedAt: '2026-07-15T12:30:00.000Z',
      expiresAt: '2027-01-11T12:30:00.000Z',
    });
  });

  it('requires the dedicated portal admin credential', async () => {
    const response = await dispatch(request('GET', '/summary', { token: '' }));
    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mocks.buildSummary).not.toHaveBeenCalled();
  });

  it('rate-limits the exported router before admin authorization when mounted alone', async () => {
    const app = express();
    app.use('/api/v1/admin/product-learning', productLearningAdminRoutes({
      buildSummary: mocks.buildSummary,
      logAdminMutation: mocks.logAdminMutation,
      recordPhysicalDevice: mocks.recordPhysicalDevice,
    }));

    const responses = [];
    for (let requestIndex = 0; requestIndex <= 30; requestIndex += 1) {
      responses.push(await fetchJson(
        app,
        'GET',
        '/api/v1/admin/product-learning/summary',
        undefined,
        { authorization: 'Bearer invalid-admin-token' },
      ));
    }

    expect(responses.slice(0, 30).every((response) => response.status === 401)).toBe(true);
    expect(responses[30]?.status).toBe(429);
    expect(responses[30]?.headers['retry-after']).toBe('60');
    expect(responses[30]?.body.error.code).toBe('RATE_LIMITED');
    expect(mocks.logAudit).toHaveBeenCalledTimes(30);
    expect(mocks.buildSummary).not.toHaveBeenCalled();
  });

  it('returns aggregate-only metrics for an optional tenant scope', async () => {
    const response = await dispatch(request('GET', '/summary?tenantId=7', { query: { tenantId: '7' } }));
    expect(response.statusCode).toBe(200);
    expect(mocks.buildSummary).toHaveBeenCalledWith({ tenantId: 7 });
    expect(response.body.data).toMatchObject({
      scope: { tenantId: 7 },
      totals: { cases: 3, activeCases: 2, historicalCases: 1, staleCases: 1, promotions: 1 },
      activity: { active: { cases: 2 }, historical: { cases: 1 } },
    });
    expect(JSON.stringify(response.body)).not.toContain('userId');
  });

  it('rejects free-form physical-device fields and accepts only the exact build contract', async () => {
    const body = {
      observationId: 'build-56-review-availability-20260715',
      tenantId: 7,
      userId: 7,
      buildNumber: '56',
      checkCode: 'review_availability',
      result: 'failed',
      evidenceReference: 'testflight://build/56/review-availability',
      observedAt: '2026-07-15T12:30:00.000Z',
    };
    const rejected = await dispatch(request('POST', '/physical-device-observations', {
      body: { ...body, notes: 'raw device or calendar details must never be accepted' },
    }));
    expect(rejected.statusCode).toBe(400);
    expect(mocks.recordPhysicalDevice).not.toHaveBeenCalled();

    const accepted = await dispatch(request('POST', '/physical-device-observations', { body }));
    expect(accepted.statusCode).toBe(201);
    expect(mocks.recordPhysicalDevice).toHaveBeenCalledWith(body);
    expect(accepted.body.data.observation).toEqual(expect.objectContaining({
      lifecycle: 'observed',
      kind: 'physical_device_observation',
      outcomeCode: 'failed',
    }));
    expect(JSON.stringify(accepted.body)).not.toContain('notes');

    expect(mocks.logAdminMutation).toHaveBeenCalledWith(
      expect.anything(),
      7,
      'product_learning.physical_device_observation.accepted',
      {
        tenantId: 7,
        caseId: 'training-physical-device-observation-opaque',
        buildNumber: '56',
        checkCode: 'review_availability',
        lifecycle: 'observed',
        outcomeCode: 'failed',
      },
    );
    const auditMetadata = mocks.logAdminMutation.mock.calls[0]?.[3];
    expect(JSON.stringify(auditMetadata)).not.toContain(body.observationId);
    expect(JSON.stringify(auditMetadata)).not.toContain(body.evidenceReference);
  });

  it('returns 429 before auth and bounds invalid-credential audit inserts', async () => {
    const app = guardedProductLearningApp({ maxRequests: 2 });

    const first = await fetchJson(app, 'GET', '/api/v1/admin/product-learning/summary', undefined, {
      authorization: 'Bearer invalid-admin-token',
    });
    const second = await fetchJson(app, 'GET', '/api/v1/admin/product-learning/summary', undefined, {
      authorization: 'Bearer invalid-admin-token',
    });
    const blocked = await fetchJson(app, 'GET', '/api/v1/admin/product-learning/summary', undefined, {
      authorization: 'Bearer invalid-admin-token',
    });

    expect([first.status, second.status, blocked.status]).toEqual([401, 401, 429]);
    expect(blocked.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip');
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(mocks.logAudit).toHaveBeenCalledTimes(2);
    expect(mocks.logAudit.mock.calls.every(([entry]) => (
      entry.resource === 'portal.auth'
      && entry.details.outcome === 'failure'
      && entry.details.reason === 'invalid_token'
    ))).toBe(true);
    expect(mocks.logAdminMutation).not.toHaveBeenCalled();
    expect(mocks.buildSummary).not.toHaveBeenCalled();
  });

  it('rejects an oversized product-learning body before auth while leaving sibling admin routes untouched', async () => {
    const app = guardedProductLearningApp({ maxRequests: 3 });

    for (let requestIndex = 0; requestIndex < 4; requestIndex += 1) {
      const sibling = await fetchJson(app, 'GET', '/api/v1/admin/sibling');
      expect(sibling.status).toBe(200);
      expect(sibling.body).toEqual({ ok: true });
    }

    const oversized = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/product-learning/physical-device-observations',
      { padding: 'x'.repeat(PRODUCT_LEARNING_ADMIN_BODY_LIMIT_BYTES) },
      {
        authorization: 'Bearer product-learning-admin-token',
        'transfer-encoding': 'chunked',
      },
    );

    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.recordPhysicalDevice).not.toHaveBeenCalled();
  });

  it('bounds distributed invalid-credential audits with a global pre-auth bucket', async () => {
    let now = Date.parse('2026-07-16T12:00:00.000Z');
    const app = guardedProductLearningApp({
      globalMaxRequests: 2,
      maxRequests: 10,
      maxTrackedIps: 1,
      now: () => now,
      windowMs: 1_000,
    });
    const invalidHeaders = (ip: string) => ({
      authorization: 'Bearer invalid-admin-token',
      'cf-connecting-ip': ip,
    });

    const tracked = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.1'),
    );
    const overflow = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.2'),
    );
    now += 500;
    const globallyBlocked = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.3'),
    );
    const replayBlocked = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.4'),
    );
    now += 501;
    const recovered = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.5'),
    );

    expect([tracked.status, overflow.status, globallyBlocked.status, replayBlocked.status, recovered.status])
      .toEqual([401, 401, 429, 429, 401]);
    expect(tracked.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip');
    expect(overflow.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip-overflow');
    expect(globallyBlocked.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip-global');
    expect(replayBlocked.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip-global');
    expect(recovered.headers['x-ratelimit-bucket']).not.toBe('test-product-learning-admin-ip-global');
    expect(globallyBlocked.headers['retry-after']).toBe('1');
    expect(replayBlocked.headers['retry-after']).toBe('1');
    expect(globallyBlocked.body.error.code).toBe('RATE_LIMITED');
    expect(mocks.logAudit).toHaveBeenCalledTimes(3);
    expect(mocks.buildSummary).not.toHaveBeenCalled();
  });

  it('does not let one per-IP-blocked client poison the global operator budget', async () => {
    const app = guardedProductLearningApp({
      globalMaxRequests: 2,
      maxRequests: 1,
      maxTrackedIps: 10,
    });
    const invalidHeaders = (ip: string) => ({
      authorization: 'Bearer invalid-admin-token',
      'cf-connecting-ip': ip,
    });

    const first = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.10'),
    );
    const noisyReplays = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      noisyReplays.push(await fetchJson(
        app,
        'GET',
        '/api/v1/admin/product-learning/summary',
        undefined,
        invalidHeaders('198.51.100.10'),
      ));
    }
    const freshOperator = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.11'),
    );
    const globallyBlocked = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.12'),
    );

    expect(first.status).toBe(401);
    expect(noisyReplays.map((response) => response.status)).toEqual([429, 429, 429, 429]);
    expect(noisyReplays.every((response) => (
      response.headers['x-ratelimit-bucket'] === 'test-product-learning-admin-ip'
    ))).toBe(true);
    expect(freshOperator.status).toBe(401);
    expect(freshOperator.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip');
    expect(globallyBlocked.status).toBe(429);
    expect(globallyBlocked.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip-global');
    expect(mocks.logAudit).toHaveBeenCalledTimes(2);
  });

  it('keeps map-full clients on bounded overflow until the fixed periodic prune', async () => {
    let now = Date.parse('2026-07-16T12:00:00.000Z');
    const app = guardedProductLearningApp({
      globalMaxRequests: 10,
      maxRequests: 1,
      maxTrackedIps: 1,
      now: () => now,
      pruneEveryRequests: 4,
      windowMs: 1_000,
    });
    const invalidHeaders = (ip: string) => ({
      authorization: 'Bearer invalid-admin-token',
      'cf-connecting-ip': ip,
    });

    const tracked = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.1'),
    );
    now += 1_001;
    const overflowAllowed = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.2'),
    );
    const overflowBlocked = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.3'),
    );

    expect([tracked.status, overflowAllowed.status, overflowBlocked.status]).toEqual([401, 401, 429]);
    expect(tracked.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip');
    expect(overflowAllowed.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip-overflow');
    expect(overflowBlocked.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip-overflow');
    expect(mocks.logAudit).toHaveBeenCalledTimes(2);

    const reusedSlot = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/product-learning/summary',
      undefined,
      invalidHeaders('198.51.100.4'),
    );
    expect(reusedSlot.status).toBe(401);
    expect(reusedSlot.headers['x-ratelimit-bucket']).toBe('test-product-learning-admin-ip');
    expect(mocks.logAudit).toHaveBeenCalledTimes(3);
  });
});

function guardedProductLearningApp(options: AdminPreBodyGuardOptions) {
  const app = express();
  app.use('/api/v1/admin/product-learning', createAdminPreBodyGuard({
    ...options,
    bucketName: 'test-product-learning-admin-ip',
    now: options.now ?? (() => Date.parse('2026-07-16T12:00:00.000Z')),
  }));

  const api = express.Router();
  api.use('/admin/product-learning', productLearningAdminRoutes({
    buildSummary: mocks.buildSummary,
    logAdminMutation: mocks.logAdminMutation,
    recordPhysicalDevice: mocks.recordPhysicalDevice,
  }));
  api.get('/admin/sibling', (_req, res) => res.json({ ok: true }));
  app.use('/api/v1', express.json({ limit: '8mb' }), api);
  return app;
}

async function fetchJson(
  app: express.Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to start product-learning admin test server'));
        return;
      }

      const payload = body === undefined ? undefined : JSON.stringify(body);
      const useChunkedEncoding = headers['transfer-encoding']?.toLowerCase() === 'chunked';
      const request = http.request({
        host: '127.0.0.1',
        port: address.port,
        method,
        path,
        headers: {
          ...(payload === undefined ? {} : {
            'content-type': 'application/json',
            ...(useChunkedEncoding ? {} : {
              'content-length': String(Buffer.byteLength(payload)),
            }),
          }),
          ...headers,
        },
      }, (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => {
          server.close(() => {
            resolve({
              status: response.statusCode ?? 0,
              body: responseBody ? JSON.parse(responseBody) : null,
              headers: response.headers,
            });
          });
        });
      });
      request.once('error', (error) => {
        server.close(() => reject(error));
      });
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  });
}
