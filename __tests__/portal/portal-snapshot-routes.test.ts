import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getCachedPortalSnapshot: vi.fn(),
  setCachedPortalSnapshot: vi.fn(),
  getDb: vi.fn(),
  buildPortalUsageSummary: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../src/portal/snapshot-cache', () => ({
  getCachedPortalSnapshot: (...args: unknown[]) => hoisted.getCachedPortalSnapshot(...args),
  setCachedPortalSnapshot: (...args: unknown[]) => hoisted.setCachedPortalSnapshot(...args),
}));

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

vi.mock('../../src/portal/usage-summary', () => ({
  buildPortalUsageSummary: (...args: unknown[]) => hoisted.buildPortalUsageSummary(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: (...args: unknown[]) => hoisted.loggerError(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalSnapshotRoutes } from '../../src/portal/snapshot-routes';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const routes = new Map<string, Handler>();
  return {
    routes,
    app: {
      get: vi.fn((route: string, handler: Handler) => {
        routes.set(route, handler);
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

describe('portal snapshot routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(123_000);
  });

  it('registers snapshot and usage summary routes through one bounded route owner', () => {
    const { app, routes } = makeApp();

    registerPortalSnapshotRoutes(app as any, { buildSnapshot: vi.fn() });

    expect(app.get).toHaveBeenCalledWith('/api/snapshot', expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/usage/summary', expect.any(Function));
    expect(Array.from(routes.keys())).toEqual(['/api/snapshot', '/api/usage/summary']);
  });

  it('returns cached snapshot data without rebuilding or recaching', () => {
    const cached = { ok: true, source: 'cache' };
    const buildSnapshot = vi.fn(() => ({ ok: true, source: 'builder' }));
    hoisted.getCachedPortalSnapshot.mockReturnValue(cached);
    const { app, routes } = makeApp();
    registerPortalSnapshotRoutes(app as any, { buildSnapshot });
    const handler = routes.get('/api/snapshot')!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(hoisted.getCachedPortalSnapshot).toHaveBeenCalledWith(123_000);
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(hoisted.setCachedPortalSnapshot).not.toHaveBeenCalled();
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBe(cached);
  });

  it('builds, caches, and returns snapshot data on cache miss', () => {
    const built = { ok: true, source: 'builder' };
    const buildSnapshot = vi.fn(() => built);
    hoisted.getCachedPortalSnapshot.mockReturnValue(undefined);
    const { app, routes } = makeApp();
    registerPortalSnapshotRoutes(app as any, { buildSnapshot });
    const handler = routes.get('/api/snapshot')!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(hoisted.setCachedPortalSnapshot).toHaveBeenCalledWith(built, 123_000);
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBe(built);
  });

  it('returns a stable snapshot error without leaking internal exception text', () => {
    const buildSnapshot = vi.fn(() => {
      throw new Error('sqlite exploded with private path');
    });
    hoisted.getCachedPortalSnapshot.mockReturnValue(undefined);
    const { app, routes } = makeApp();
    registerPortalSnapshotRoutes(app as any, { buildSnapshot });
    const handler = routes.get('/api/snapshot')!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.statusCode).toBe(500);
    expect(payload.body).toEqual({ error: 'Failed to build snapshot' });
    expect(JSON.stringify(payload.body)).not.toContain('sqlite exploded');
    expect(hoisted.loggerError).toHaveBeenCalledWith(expect.objectContaining({
      err: expect.any(Error),
    }), 'Portal: snapshot failed');
  });

  it('returns the portal usage summary from the shared summary builder', () => {
    const db = { prepare: vi.fn() };
    const summary = { ok: true, periods: [] };
    hoisted.getDb.mockReturnValue(db);
    hoisted.buildPortalUsageSummary.mockReturnValue(summary);
    const { app, routes } = makeApp();
    registerPortalSnapshotRoutes(app as any, { buildSnapshot: vi.fn() });
    const handler = routes.get('/api/usage/summary')!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(hoisted.getDb).toHaveBeenCalledTimes(1);
    expect(hoisted.buildPortalUsageSummary).toHaveBeenCalledWith(db);
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBe(summary);
  });

  it('returns a stable usage summary error without leaking internal exception text', () => {
    hoisted.getDb.mockImplementation(() => {
      throw new Error('db path /private/user.sqlite unavailable');
    });
    const { app, routes } = makeApp();
    registerPortalSnapshotRoutes(app as any, { buildSnapshot: vi.fn() });
    const handler = routes.get('/api/usage/summary')!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.statusCode).toBe(500);
    expect(payload.body).toEqual({ ok: false, error: 'Failed to build usage summary' });
    expect(JSON.stringify(payload.body)).not.toContain('/private/user.sqlite');
    expect(hoisted.loggerError).toHaveBeenCalledWith(expect.objectContaining({
      err: expect.any(Error),
    }), 'Portal: usage/summary failed');
  });
});
