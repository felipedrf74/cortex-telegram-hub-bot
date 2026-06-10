import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetRecentReports = vi.fn();
const mockGetUnreadReportCount = vi.fn();
const mockGetLatestByType = vi.fn();
const mockGetReportById = vi.fn();
const mockMarkReportRead = vi.fn();
const mockNotificationCacheInvalidation = vi.hoisted(() => ({
  invalidateNotificationInboxCaches: vi.fn(),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getRecentReports: (...args: unknown[]) => mockGetRecentReports(...args),
  getUnreadReportCount: (...args: unknown[]) => mockGetUnreadReportCount(...args),
  getLatestByType: (...args: unknown[]) => mockGetLatestByType(...args),
  getReportById: (...args: unknown[]) => mockGetReportById(...args),
  markReportRead: (...args: unknown[]) => mockMarkReportRead(...args),
  isReportType: (value: unknown) => typeof value === 'string' && [
    'morning_briefing',
    'evening_summary',
    'weekly_review',
    'coach_briefing',
    'decision_briefing',
    'coach_phase',
  ].includes(value),
}));

vi.mock('../../src/services/notification-cache-invalidation', () => ({
  invalidateNotificationInboxCaches: (...args: unknown[]) => mockNotificationCacheInvalidation.invalidateNotificationInboxCaches(...args),
}));

import { reportRoutes } from '../../src/api/routes/reports';

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

function mockReq(method: string, path: string, query: Record<string, any> = {}, userId = 7, tenantId = userId): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    headers: {},
    userId,
    tenantId,
  } as any;
}

async function dispatch(method: string, path: string, query: Record<string, any> = {}, userId = 7, tenantId = userId): Promise<MockRes> {
  const router = reportRoutes();
  const req = mockReq(method, path, query, userId, tenantId);
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

describe('Reports routes', () => {
  beforeEach(() => {
    mockGetRecentReports.mockReset();
    mockGetUnreadReportCount.mockReset();
    mockGetLatestByType.mockReset();
    mockGetReportById.mockReset();
    mockMarkReportRead.mockReset();
    mockNotificationCacheInvalidation.invalidateNotificationInboxCaches.mockReset();
    clearTenantScopeAnomaliesForTests();

    mockGetRecentReports.mockReturnValue([]);
    mockGetUnreadReportCount.mockReturnValue(0);
    mockGetLatestByType.mockReturnValue(null);
    mockGetReportById.mockReturnValue(null);
    mockMarkReportRead.mockReturnValue(false);
  });

  it('lists reports for the authenticated user', async () => {
    mockGetRecentReports.mockReturnValue([
      {
        id: 11,
        type: 'morning_briefing',
        title: 'Morning Briefing',
        summary: 'Big day ahead.',
        status: 'unread',
        createdAt: '2026-04-17T06:00:00Z',
      },
    ]);
    mockGetUnreadReportCount.mockReturnValue(3);

    const res = await dispatch('GET', '/', { type: 'morning_briefing', limit: '5' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unreadCount).toBe(3);
    expect(res.body.data.count).toBe(1);
    expect(mockGetRecentReports).toHaveBeenCalledWith(7, { type: 'morning_briefing', limit: 5 });
    expect(mockGetUnreadReportCount).toHaveBeenCalledWith(7);
  });

  it('rejects invalid report type before calling the store', async () => {
    const res = await dispatch('GET', '/', { type: 'not_a_report', limit: '5' });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(mockGetRecentReports).not.toHaveBeenCalled();
  });

  it('rejects invalid report limits and clamps oversized valid limits', async () => {
    const invalid = await dispatch('GET', '/', { limit: 'nope' });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION');
    expect(mockGetRecentReports).not.toHaveBeenCalled();

    const partialNumeric = await dispatch('GET', '/', { limit: '20abc' });
    expect(partialNumeric.statusCode).toBe(400);
    expect(partialNumeric.body.error.code).toBe('VALIDATION');
    expect(mockGetRecentReports).not.toHaveBeenCalled();

    const clamped = await dispatch('GET', '/', { limit: '500' });
    expect(clamped.statusCode).toBe(200);
    expect(mockGetRecentReports).toHaveBeenCalledWith(7, { type: undefined, limit: 100 });
  });

  it('validates latest report type', async () => {
    const missing = await dispatch('GET', '/latest');
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION');

    const invalid = await dispatch('GET', '/latest', { type: 'not_a_report' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION');

    const valid = await dispatch('GET', '/latest', { type: 'decision_briefing' });
    expect(valid.statusCode).toBe(200);
    expect(mockGetLatestByType).toHaveBeenCalledWith(7, 'decision_briefing');
  });

  it('fails closed on invalid tenant scope before listing reports', async () => {
    const res = await dispatch('GET', '/', {}, 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetRecentReports).not.toHaveBeenCalled();
    expect(mockGetUnreadReportCount).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'reports_route_list',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });

  it('invalidates notification inbox caches after marking a report read', async () => {
    mockMarkReportRead.mockReturnValue(true);

    const res = await dispatch('POST', '/123/read', {}, 7, 17);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.marked).toBe(true);
    expect(mockMarkReportRead).toHaveBeenCalledWith(123, 7);
    expect(mockNotificationCacheInvalidation.invalidateNotificationInboxCaches).toHaveBeenCalledWith(7, 17);
  });
});
