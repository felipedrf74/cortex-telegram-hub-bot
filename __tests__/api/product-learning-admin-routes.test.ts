// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({
  buildSummary: vi.fn(),
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

vi.mock('../../src/services/audit-trail', () => ({ getAuditTrail: vi.fn(() => []), logAudit: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { productLearningAdminRoutes } from '../../src/api/routes/product-learning-admin';

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
      totals: { cases: 3, staleCases: 1, exportEligibleGoldenCases: 0, promotions: 1 },
      lifecycleCounts: { observed: 2, candidate: 1, reviewed: 0, golden: 0, retired: 0 },
      transitionCounts: { observed_to_candidate: 1 },
      feedback: { adaptationAccepted: 1, adaptationDismissed: 1, acceptanceRate: 0.5 },
      coverage: { observedCategories: 3, totalCategories: 8, missingCategories: [] },
      categories: [],
    });
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
      producerVersion: 'training-learning-producers.v1',
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

  it('returns aggregate-only metrics for an optional tenant scope', async () => {
    const response = await dispatch(request('GET', '/summary?tenantId=7', { query: { tenantId: '7' } }));
    expect(response.statusCode).toBe(200);
    expect(mocks.buildSummary).toHaveBeenCalledWith({ tenantId: 7 });
    expect(response.body.data).toMatchObject({
      scope: { tenantId: 7 },
      totals: { cases: 3, staleCases: 1, promotions: 1 },
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
  });
});
