import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockDbAll = vi.fn();
const mockDbRun = vi.fn();
const mockSearchNotes = vi.fn();
const mockGetActiveReminders = vi.fn();
const mockBuildActiveSignalsResponse = vi.fn();
const mockCheckQuota = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => mockDbAll(...args),
      run: (...args: unknown[]) => mockDbRun(...args),
    }),
  }),
}));

vi.mock('../../src/state/notes', () => ({
  saveNote: vi.fn(),
  searchNotes: (...args: unknown[]) => mockSearchNotes(...args),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  getNoteById: vi.fn(),
}));

vi.mock('../../src/state/reminders', () => ({
  setReminder: vi.fn(),
  getActiveReminders: (...args: unknown[]) => mockGetActiveReminders(...args),
  cancelReminder: vi.fn(),
}));

vi.mock('../../src/services/signals-observability', () => ({
  buildActiveSignalsResponse: (...args: unknown[]) => mockBuildActiveSignalsResponse(...args),
}));

vi.mock('../../src/services/usage-metering', () => ({
  getDailyUsage: vi.fn(),
  getUsageRange: vi.fn(),
  checkQuota: (...args: unknown[]) => mockCheckQuota(...args),
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
}));

import { auditTrailRoutes } from '../../src/api/routes/audit-trail';
import { clientErrorsRoutes } from '../../src/api/routes/client-errors';
import { notesRoutes } from '../../src/api/routes/notes';
import { reminderRoutes } from '../../src/api/routes/reminders';
import { signalsRoutes } from '../../src/api/routes/signals';
import { usageRoutes } from '../../src/api/routes/usage';

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
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeReq(method: string, path: string, userId: number, body?: any): Request {
  const parsed = new URL(path, 'http://test.local');
  return {
    method,
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    params: {},
    headers: {},
    body: body ?? {},
    userId,
  } as any;
}

async function dispatch(routerFactory: () => any, method: string, path: string, userId: number, body?: any): Promise<MockRes> {
  const router = routerFactory();
  const req = makeReq(method, path, userId, body);
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

describe('Authenticated support routes scope guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTenantScopeAnomaliesForTests();
  });

  it('fails closed on invalid tenant scope for audit trail', async () => {
    const res = await dispatch(auditTrailRoutes, 'GET', '/me', 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockDbAll).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({ operation: 'audit_trail_route', userId: 0 }),
    ]);
  });

  it('fails closed on invalid tenant scope for client error ingestion', async () => {
    const res = await dispatch(clientErrorsRoutes, 'POST', '/', 0, { message: 'boom' });

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockDbRun).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({ operation: 'client_errors_route', userId: 0 }),
    ]);
  });

  it('fails closed on invalid tenant scope for notes', async () => {
    const res = await dispatch(notesRoutes, 'GET', '/', 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockSearchNotes).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({ operation: 'notes_route', userId: 0 }),
    ]);
  });

  it('fails closed on invalid tenant scope for reminders', async () => {
    const res = await dispatch(reminderRoutes, 'GET', '/', 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetActiveReminders).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({ operation: 'reminders_route', userId: 0 }),
    ]);
  });

  it('fails closed on invalid tenant scope for signals', async () => {
    const res = await dispatch(signalsRoutes, 'GET', '/active', 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockBuildActiveSignalsResponse).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({ operation: 'signals_route', userId: 0 }),
    ]);
  });

  it('fails closed on invalid tenant scope for usage', async () => {
    const res = await dispatch(usageRoutes, 'GET', '/', 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockCheckQuota).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({ operation: 'usage_route', userId: 0 }),
    ]);
  });
});
