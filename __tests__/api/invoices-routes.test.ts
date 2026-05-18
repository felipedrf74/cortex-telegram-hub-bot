import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockGetAllVendorsMerged = vi.fn();
const mockCollectMonthlyInvoices = vi.fn();
const mockAddVendor = vi.fn();
const mockRemoveVendor = vi.fn();
const mockGetAllVendorsDb = vi.fn();
const mockGetFiscalCollectionSummary = vi.fn();
const mockSendFiscalBundleNow = vi.fn();
const mockUpdateFiscalCollectionProfile = vi.fn();
const mockInvalidateFinanceDerivedCaches = vi.fn();

vi.mock('../../src/services/invoice-collector', () => ({
  getAllVendors: (...args: unknown[]) => mockGetAllVendorsMerged(...args),
  collectMonthlyInvoices: (...args: unknown[]) => mockCollectMonthlyInvoices(...args),
}));

vi.mock('../../src/state/invoice-vendors', () => ({
  addVendor: (...args: unknown[]) => mockAddVendor(...args),
  removeVendor: (...args: unknown[]) => mockRemoveVendor(...args),
  getAllVendors: (...args: unknown[]) => mockGetAllVendorsDb(...args),
}));

vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: (...args: unknown[]) => mockGetFiscalCollectionSummary(...args),
  sendFiscalBundleNow: (...args: unknown[]) => mockSendFiscalBundleNow(...args),
}));

vi.mock('../../src/state/fiscal-collection-profiles', () => ({
  updateFiscalCollectionProfile: (...args: unknown[]) => mockUpdateFiscalCollectionProfile(...args),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateFinanceDerivedCaches: (...args: unknown[]) =>
    mockInvalidateFinanceDerivedCaches(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { invoicesRoutes } from '../../src/api/routes/invoices';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { return r; },
  };
  return r;
}

function mockReq(
  method: string,
  path: string,
  userId = 12,
  body?: any,
  scope: { tenantId?: number } = {},
): Request {
  const req: any = {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    headers: {},
    body,
    userId,
  };
  if (Object.prototype.hasOwnProperty.call(scope, 'tenantId')) {
    req.tenantId = scope.tenantId;
  } else {
    req.tenantId = userId;
  }
  return {
    ...req,
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  userIdOrBody?: any,
  body?: any,
  scope: { tenantId?: number } = {},
): Promise<MockRes> {
  const router = invoicesRoutes();
  const hasExplicitUser = typeof userIdOrBody === 'number';
  const req = mockReq(
    method,
    path,
    hasExplicitUser ? userIdOrBody : 12,
    hasExplicitUser ? body : userIdOrBody,
    scope,
  );
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Invoices API routes', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    mockGetAllVendorsMerged.mockReset();
    mockCollectMonthlyInvoices.mockReset();
    mockAddVendor.mockReset();
    mockRemoveVendor.mockReset();
    mockGetAllVendorsDb.mockReset();
    mockGetFiscalCollectionSummary.mockReset();
    mockSendFiscalBundleNow.mockReset();
    mockUpdateFiscalCollectionProfile.mockReset();
    mockInvalidateFinanceDerivedCaches.mockReset();

    mockGetFiscalCollectionSummary.mockReturnValue({
      profile: {
        user_id: 12,
        destination_email: 'felipe@nexushub.me',
        cadence: 'monthly',
        primary_day: 28,
        secondary_day: null,
        enabled: 1,
      },
      destinationEmail: 'felipe@nexushub.me',
      nextRunAt: '2026-04-28T08:00:00.000Z',
      providers: [{ provider: 'gmail', connected: true }],
      ruleCount: 4,
      customRuleCount: 2,
      deliveryAvailable: true,
      warnings: [],
    });
  });

  it('returns the fiscal collection summary for the authenticated user', async () => {
    const res = await dispatch('GET', '/profile');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.destinationEmail).toBe('felipe@nexushub.me');
    expect(mockGetFiscalCollectionSummary).toHaveBeenCalledWith(12);
  });

  it('returns a client-safe message when the fiscal collection summary fails unexpectedly', async () => {
    mockGetFiscalCollectionSummary.mockImplementation(() => {
      throw new Error('sqlite busy: invoice_profile corrupted');
    });

    const res = await dispatch('GET', '/profile');

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Unable to load fiscal collection profile right now.',
    });
  });

  it('fails closed on invalid tenant scope before loading the fiscal profile', async () => {
    const res = await dispatch('GET', '/profile', 12, undefined, { tenantId: undefined });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetFiscalCollectionSummary).not.toHaveBeenCalledWith(12);
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'invoices_route',
        reason: 'missing_tenant_scope',
        userId: 12,
      }),
    ]);
  });

  it('lists only user-scoped invoice vendors for the app-facing fiscal UI', async () => {
    mockGetAllVendorsMerged.mockReturnValue([
      {
        name: 'Santander Consumer',
        senderPatterns: ['santanderconsumer.pt'],
        subjectPatterns: ['fatura'],
        builtin: true,
      },
    ]);
    mockGetAllVendorsDb.mockReturnValue([
      {
        id: 91,
        name: 'Jaqueline Energia',
        sender_pattern: 'energia.example',
        subject_patterns: 'fatura,recibo',
        enabled: 1,
        created_at: '2026-04-22T10:00:00.000Z',
      },
      {
        id: 92,
        name: 'Disabled Vendor',
        sender_pattern: 'disabled.example',
        subject_patterns: null,
        enabled: 0,
        created_at: '2026-04-22T11:00:00.000Z',
      },
    ]);

    const res = await dispatch('GET', '/vendors', 44);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockGetAllVendorsDb).toHaveBeenCalledWith(44);
    expect(mockGetAllVendorsMerged).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({
      active: [
        {
          name: 'Jaqueline Energia',
          senderPatterns: ['energia.example'],
          subjectPatterns: ['fatura', 'recibo'],
          builtin: false,
        },
      ],
      dbRows: [
        {
          id: 91,
          name: 'Jaqueline Energia',
          sender_pattern: 'energia.example',
          subject_patterns: 'fatura,recibo',
          enabled: 1,
          created_at: '2026-04-22T10:00:00.000Z',
        },
        {
          id: 92,
          name: 'Disabled Vendor',
          sender_pattern: 'disabled.example',
          subject_patterns: null,
          enabled: 0,
          created_at: '2026-04-22T11:00:00.000Z',
        },
      ],
      builtinCount: 0,
      customCount: 2,
    });
  });

  it('does not expose legacy global built-in invoice vendors to users with no configured rules', async () => {
    mockGetAllVendorsMerged.mockReturnValue([
      {
        name: 'Santander Consumer',
        senderPatterns: ['santanderconsumer.pt'],
        subjectPatterns: ['fatura'],
        builtin: true,
      },
      {
        name: 'NOS Empresas',
        senderPatterns: ['nos.pt'],
        subjectPatterns: ['fatura'],
        builtin: true,
      },
    ]);
    mockGetAllVendorsDb.mockReturnValue([]);

    const res = await dispatch('GET', '/vendors', 99);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockGetAllVendorsDb).toHaveBeenCalledWith(99);
    expect(mockGetAllVendorsMerged).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({
      active: [],
      dbRows: [],
      builtinCount: 0,
      customCount: 0,
    });
  });

  it('validates profile updates before touching the state layer', async () => {
    const res = await dispatch('PUT', '/profile', {
      cadence: 'weekly',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockUpdateFiscalCollectionProfile).not.toHaveBeenCalled();
  });

  it('updates the fiscal collection profile and returns the refreshed summary', async () => {
    const res = await dispatch('PUT', '/profile', {
      destinationEmail: 'docs@nexushub.me',
      cadence: 'twice_monthly',
      primaryDay: 10,
      secondaryDay: 24,
      enabled: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUpdateFiscalCollectionProfile).toHaveBeenCalledWith(12, {
      destination_email: 'docs@nexushub.me',
      cadence: 'twice_monthly',
      primary_day: 10,
      secondary_day: 24,
      enabled: true,
    });
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(12);
    expect(mockGetFiscalCollectionSummary).toHaveBeenLastCalledWith(12);
  });

  it('sends the fiscal bundle immediately for the authenticated user', async () => {
    mockSendFiscalBundleNow.mockResolvedValue({
      destinationEmail: 'docs@nexushub.me',
      totalDocuments: 3,
      sent: true,
    });

    const res = await dispatch('POST', '/bundle-now', {
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-14T23:59:59Z',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.result.sent).toBe(true);
    expect(mockSendFiscalBundleNow).toHaveBeenCalledWith(12, {
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-14T23:59:59Z',
    });
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(12);
  });

  it('invalidates finance-derived surfaces after adding a fiscal vendor', async () => {
    mockAddVendor.mockReturnValue({
      id: 31,
      name: 'Vodafone',
      sender_pattern: 'vodafone.pt',
      subject_patterns: 'fatura',
      enabled: 1,
    });

    const res = await dispatch('POST', '/vendors', {
      name: 'Vodafone',
      senderPattern: 'vodafone.pt',
      subjectPatterns: 'fatura',
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddVendor).toHaveBeenCalledWith('Vodafone', 'vodafone.pt', 12, 'fatura');
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(12);
  });

  it('invalidates finance-derived surfaces after deleting a fiscal vendor', async () => {
    mockRemoveVendor.mockReturnValue(true);

    const res = await dispatch('DELETE', '/vendors/31');

    expect(res.statusCode).toBe(200);
    expect(mockRemoveVendor).toHaveBeenCalledWith(31, 12);
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(12);
  });

  it('passes the authenticated user to the legacy scan-now route', async () => {
    mockCollectMonthlyInvoices.mockResolvedValue({
      totalEmailsScanned: 7,
      totalFiled: 2,
    });

    const res = await dispatch('POST', '/scan-now', {
      year: 2026,
      month: 4,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockCollectMonthlyInvoices).toHaveBeenCalledWith(12, 2026, 4);
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(12);
  });
});
