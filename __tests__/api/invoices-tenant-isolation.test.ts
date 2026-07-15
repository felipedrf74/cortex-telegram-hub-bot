import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request } from 'express';

let testDb: Database.Database;
const mockCollectMonthlyInvoices = vi.fn();
const mockInvalidateFinanceDerivedCaches = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/invoice-collector', () => ({
  collectMonthlyInvoices: (...args: unknown[]) => mockCollectMonthlyInvoices(...args),
  getAllVendors: vi.fn(),
}));

vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: vi.fn(),
  sendFiscalBundleNow: vi.fn(),
}));

vi.mock('../../src/state/fiscal-collection-profiles', () => ({
  updateFiscalCollectionProfile: vi.fn(),
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
import {
  addVendor,
  getAllVendors,
  getActiveVendors,
} from '../../src/state/invoice-vendors';


interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
  };
  return res;
}

async function dispatch(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  userId: number,
  body?: any,
  tenantId = userId,
): Promise<MockRes> {
  const router = invoicesRoutes();
  const req = {
    userId,
    tenantId,
    body,
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    query: {},
    params: {},
    headers: {},
  } as any as Request;
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

describe('Invoices API tenant isolation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    mockCollectMonthlyInvoices.mockReset();
    mockInvalidateFinanceDerivedCaches.mockReset();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('does not list or delete another user fiscal vendor through direct API calls', async () => {
    const userA = 101;
    const userB = 202;
    const vendorA = addVendor('Tenant A Accountant', 'billing-a.example', userA, 'invoice');
    const vendorB = addVendor('Tenant B Utility', 'billing-b.example', userB, 'fatura');

    const listForB = await dispatch('GET', '/vendors', userB);

    expect(listForB.statusCode).toBe(200);
    expect(listForB.body.ok).toBe(true);
    expect(listForB.body.data.dbRows.map((row: any) => row.id)).toEqual([vendorB.id]);
    expect(JSON.stringify(listForB.body)).toContain('Tenant B Utility');
    expect(JSON.stringify(listForB.body)).not.toContain('Tenant A Accountant');

    const deleteAFromB = await dispatch('DELETE', `/vendors/${vendorA.id}`, userB);

    expect(deleteAFromB.statusCode).toBe(404);
    expect(deleteAFromB.body.error.code).toBe('NOT_FOUND');
    expect(getActiveVendors(userA).map((row) => row.id)).toEqual([vendorA.id]);
    expect(getAllVendors(userB).map((row) => row.id)).toEqual([vendorB.id]);
    expect(mockInvalidateFinanceDerivedCaches).not.toHaveBeenCalled();

    const deleteBFromB = await dispatch('DELETE', `/vendors/${vendorB.id}`, userB);

    expect(deleteBFromB.statusCode).toBe(200);
    expect(getActiveVendors(userA).map((row) => row.id)).toEqual([vendorA.id]);
    expect(getActiveVendors(userB)).toEqual([]);
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(userB);
  });

  it('runs fiscal scan jobs only for the authenticated user scope', async () => {
    mockCollectMonthlyInvoices.mockResolvedValue({
      totalEmailsScanned: 4,
      totalFiled: 1,
      totalErrors: 0,
      vendorResults: [],
      errors: [],
    });

    const res = await dispatch('POST', '/scan-now', 202, {
      year: 2026,
      month: 4,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockCollectMonthlyInvoices).toHaveBeenCalledWith(202, 2026, 4, 202);
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(202);
  });
});
