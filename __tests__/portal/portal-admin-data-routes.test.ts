import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const targetUserGuard = ((_req: unknown, _res: unknown, next: () => void) => next()) as unknown as ReturnType<typeof vi.fn>;
  return {
    getDb: vi.fn(),
    requirePortalAdminToken: vi.fn(),
    countUserFinanceData: vi.fn(),
    sendPortalInternalError: vi.fn(),
    targetUserGuard,
    requireOperatorTargetUser: vi.fn(() => targetUserGuard),
  };
});

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => hoisted.getDb(...args),
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

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/services/user-data-export', () => ({
  countUserFinanceData: (...args: unknown[]) => hoisted.countUserFinanceData(...args),
}));

vi.mock('../../src/portal/admin-target-user', () => ({
  requireOperatorTargetUser: (...args: unknown[]) => hoisted.requireOperatorTargetUser(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

import { registerPortalAdminDataRoutes } from '../../src/portal/admin-data-routes';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  return {
    routes,
    app: {
      get: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`GET ${route}`, handlers);
      }),
    },
  };
}

function makeResponse() {
  const payload = {
    statusCode: 200,
    body: undefined as unknown,
  };
  const res: any = {
    status: vi.fn((code: number) => {
      payload.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      payload.body = body;
      return res;
    }),
  };
  return { payload, res };
}

function makeDbRecorder(counts: Record<string, number> = {}, auditRows: unknown[] = []) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    calls,
    db: {
      prepare: vi.fn((sql: string) => ({
        all: vi.fn((...args: unknown[]) => {
          calls.push({ sql, args });
          return auditRows;
        }),
        get: vi.fn((...args: unknown[]) => {
          calls.push({ sql, args });
          const table = sql.match(/FROM ([a-z_]+)/)?.[1] ?? '';
          return { c: counts[table] ?? 0 };
        }),
      })),
    },
  };
}

describe('portal admin data routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.countUserFinanceData.mockReturnValue({ transactions: 2, taxEvents: 1 });
    hoisted.getDb.mockReturnValue(makeDbRecorder().db);
  });

  it('registers audit and data-summary routes behind the admin token + operator target-user guards', () => {
    const { app, routes } = makeApp();

    registerPortalAdminDataRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/audit-trail', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/users/:userId/data-summary', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(routes.get('GET /api/audit-trail')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('GET /api/users/:userId/data-summary')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('GET /api/users/:userId/data-summary')?.[1]).toBe(hoisted.targetUserGuard);
    expect(hoisted.requireOperatorTargetUser).toHaveBeenCalledWith('userId');
  });

  it('loads audit trail entries with a bounded default limit', () => {
    const recorder = makeDbRecorder({}, [{ id: 1, action: 'login' }]);
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalAdminDataRoutes(app as any);
    const handler = routes.get('GET /api/audit-trail')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ query: { limit: 'bad' } }, res);

    expect(payload.body).toEqual({ entries: [{ id: 1, action: 'login' }] });
    expect(recorder.calls).toEqual([{
      sql: 'SELECT * FROM audit_trail ORDER BY ts DESC LIMIT ?',
      args: [50],
    }]);
  });

  it('loads user-scoped audit entries with a max limit of 500', () => {
    const recorder = makeDbRecorder({}, [{ id: 2, user_id: 42 }]);
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalAdminDataRoutes(app as any);
    const handler = routes.get('GET /api/audit-trail')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ query: { userId: '42', limit: '9999' } }, res);

    expect(payload.body).toEqual({ entries: [{ id: 2, user_id: 42 }] });
    expect(recorder.calls).toEqual([{
      sql: 'SELECT * FROM audit_trail WHERE user_id = ? ORDER BY ts DESC LIMIT ?',
      args: [42, 500],
    }]);
  });

  it('returns data-summary counts by canonical user id', () => {
    const recorder = makeDbRecorder({
      conversations: 3,
      todos: 4,
      reminders: 5,
      notes: 6,
      shared_memory: 7,
      saved_ideas: 8,
    });
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalAdminDataRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/data-summary')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' } }, res);

    expect(hoisted.countUserFinanceData).toHaveBeenCalledWith(42);
    expect(payload.body).toEqual({
      conversations: 3,
      todos: 4,
      reminders: 5,
      notes: 6,
      sharedMemory: 7,
      savedIdeas: 8,
      financeTransactions: 2,
      financeTaxEvents: 1,
    });
  });

  it('rejects invalid user ids before data-summary work', () => {
    const { app, routes } = makeApp();
    registerPortalAdminDataRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/data-summary')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: 'not-a-number' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'invalid userId' });
    expect(hoisted.countUserFinanceData).not.toHaveBeenCalled();
  });

  it('uses the shared internal-error helper for data route failures', () => {
    hoisted.getDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => {
          throw new Error('raw audit db path /private/audit.sqlite');
        }),
      })),
    });
    const { app, routes } = makeApp();
    registerPortalAdminDataRoutes(app as any);
    const handler = routes.get('GET /api/audit-trail')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ query: {} }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: request failed',
    );
  });
});
