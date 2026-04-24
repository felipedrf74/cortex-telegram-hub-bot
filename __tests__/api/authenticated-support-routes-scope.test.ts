import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockDbAll = vi.fn();
const mockDbRun = vi.fn();
const mockSaveNote = vi.fn();
const mockSearchNotes = vi.fn();
const mockUpdateNote = vi.fn();
const mockDeleteNote = vi.fn();
const mockSetReminder = vi.fn();
const mockGetActiveReminders = vi.fn();
const mockCancelReminder = vi.fn();
const mockBuildActiveSignalsResponse = vi.fn();
const mockCheckQuota = vi.fn();
const mockGetDailyUsage = vi.fn();
const mockGetUsageRange = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => mockDbAll(...args),
      run: (...args: unknown[]) => mockDbRun(...args),
    }),
  }),
}));

vi.mock('../../src/state/notes', () => ({
  saveNote: (...args: unknown[]) => mockSaveNote(...args),
  searchNotes: (...args: unknown[]) => mockSearchNotes(...args),
  updateNote: (...args: unknown[]) => mockUpdateNote(...args),
  deleteNote: (...args: unknown[]) => mockDeleteNote(...args),
  getNoteById: vi.fn(),
}));

vi.mock('../../src/state/reminders', () => ({
  setReminder: (...args: unknown[]) => mockSetReminder(...args),
  getActiveReminders: (...args: unknown[]) => mockGetActiveReminders(...args),
  cancelReminder: (...args: unknown[]) => mockCancelReminder(...args),
}));

vi.mock('../../src/services/signals-observability', () => ({
  buildActiveSignalsResponse: (...args: unknown[]) => mockBuildActiveSignalsResponse(...args),
}));

vi.mock('../../src/services/usage-metering', () => ({
  getDailyUsage: (...args: unknown[]) => mockGetDailyUsage(...args),
  getUsageRange: (...args: unknown[]) => mockGetUsageRange(...args),
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

  it('sanitizes usage failures instead of leaking internal quota errors', async () => {
    mockCheckQuota.mockImplementationOnce(() => {
      throw new Error('quota ledger exploded for tenant=12');
    });

    const res = await dispatch(usageRoutes, 'GET', '/', 12);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to fetch usage');
    expect(JSON.stringify(res.body)).not.toContain('quota ledger exploded');
  });

  it('sanitizes signals failures instead of leaking observability internals', async () => {
    mockBuildActiveSignalsResponse.mockImplementationOnce(() => {
      throw new Error('signals pipeline exploded for tenant 12');
    });

    const res = await dispatch(signalsRoutes, 'GET', '/active', 12);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to load active signals');
    expect(JSON.stringify(res.body)).not.toContain('signals pipeline exploded');
  });

  it('sanitizes audit trail failures instead of leaking query internals', async () => {
    mockDbAll.mockImplementationOnce(() => {
      throw new Error('audit query failed for tenant 12');
    });

    const res = await dispatch(auditTrailRoutes, 'GET', '/me', 12);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to fetch audit trail');
    expect(JSON.stringify(res.body)).not.toContain('audit query failed');
  });

  it('sanitizes client error ingestion failures instead of leaking persistence internals', async () => {
    mockDbRun.mockImplementationOnce(() => {
      throw new Error('client_errors insert failed for tenant 12');
    });

    const res = await dispatch(clientErrorsRoutes, 'POST', '/', 12, {
      message: 'boom',
      source: 'ios',
      level: 'error',
    });

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to persist client error');
    expect(JSON.stringify(res.body)).not.toContain('client_errors insert failed');
  });

  it('sanitizes note creation failures instead of leaking persistence internals', async () => {
    mockSaveNote.mockImplementationOnce(() => {
      throw new Error('notes sqlite write failed for user 12');
    });

    const res = await dispatch(notesRoutes, 'POST', '/', 12, {
      content: 'Remember this',
    });

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to save note');
    expect(JSON.stringify(res.body)).not.toContain('notes sqlite write failed');
  });

  it('sanitizes reminder creation failures instead of leaking scheduler internals', async () => {
    mockSetReminder.mockImplementationOnce(() => {
      throw new Error('scheduler insert failed for tenant 12');
    });

    const res = await dispatch(reminderRoutes, 'POST', '/', 12, {
      message: 'Pay invoice',
      remindAt: '2026-04-23T09:00:00.000Z',
    });

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to create reminder');
    expect(JSON.stringify(res.body)).not.toContain('scheduler insert failed');
  });
});
