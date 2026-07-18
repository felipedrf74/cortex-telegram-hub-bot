import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';

const mockGetUserConnections = vi.fn();
const mockDbGet = vi.fn();
const mockDbAll = vi.fn(() => []);
const mockDbRun = vi.fn();
const mockDisconnectProvider = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockRevokeThirdPartyOAuthTokenForProvider = vi.fn(async () => ({
  attempted: false,
  revoked: false,
  reason: 'not_connected',
}));
// When set, the mocked database service returns this real sqlite handle
// instead of the prepare/get/run stubs. vi.doMock factories are only honored
// once per module path in this suite, so routing through mutable state is the
// reliable way to swap DB behavior per describe block.
let taskSyncDb: Database.Database | null = null;

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

function mockReq(userId: number): Request {
  return {
    userId,
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchDisconnect(userId: number, provider: string, query: Record<string, string> = {}): Promise<MockRes> {
  const { connectionRoutes } = await import('../../src/api/routes/connections');
  const router = connectionRoutes();
  const req = mockReq(userId);
  (req as any).method = 'DELETE';
  (req as any).url = `/${provider}`;
  (req as any).originalUrl = `/${provider}`;
  (req as any).baseUrl = '';
  (req as any).path = `/${provider}`;
  (req as any).query = query;
  const res = mockRes();

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      const result = originalJson(body);
      done();
      return result;
    };
    (router as any).handle(req, res, () => done());
    setTimeout(done, 250);
  });

  return res;
}

async function dispatchConnections(userId: number): Promise<MockRes> {
  const { connectionRoutes } = await import('../../src/api/routes/connections');
  const router = connectionRoutes();
  const req = mockReq(userId);
  (req as any).method = 'GET';
  (req as any).url = '/';
  (req as any).originalUrl = '/';
  (req as any).baseUrl = '';
  (req as any).path = '/';
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

describe('Connections routes', () => {
  const originalEnv = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    OUTLOOK_CLIENT_ID: process.env.OUTLOOK_CLIENT_ID,
    OUTLOOK_CLIENT_SECRET: process.env.OUTLOOK_CLIENT_SECRET,
    STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
    WHOOP_CLIENT_ID: process.env.WHOOP_CLIENT_ID,
    WHOOP_CLIENT_SECRET: process.env.WHOOP_CLIENT_SECRET,
  };

  beforeEach(async () => {
    vi.resetModules();
    process.env.GOOGLE_CLIENT_ID = 'google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    process.env.OUTLOOK_CLIENT_ID = '';
    process.env.OUTLOOK_CLIENT_SECRET = '';
    process.env.STRAVA_CLIENT_ID = '';
    process.env.STRAVA_CLIENT_SECRET = '';
    process.env.WHOOP_CLIENT_ID = '';
    process.env.WHOOP_CLIENT_SECRET = '';
    const observability = await import('../../src/services/tenant-scope-observability');
    observability.clearTenantScopeAnomaliesForTests();
    mockLoggerWarn.mockClear();
    mockLoggerError.mockClear();
    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: (...args: unknown[]) => mockLoggerWarn(...(args as [])),
        error: (...args: unknown[]) => mockLoggerError(...(args as [])),
        debug: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }));
    mockGetUserConnections.mockReset();
    mockGetUserConnections.mockReturnValue([
      {
        provider: 'google',
        connectedAt: '2026-04-15T09:00:00Z',
        lastReauthedAt: '2026-04-15T09:00:00Z',
        scopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/gmail.readonly',
        ],
      },
    ]);
    mockDbGet.mockReset();
    mockDbGet.mockReturnValue(undefined);
    mockDbAll.mockClear();
    mockDbRun.mockClear();
    taskSyncDb = null;
    vi.doMock('../../src/services/oauth-store', () => ({
      getUserConnections: (...args: unknown[]) => mockGetUserConnections(...args),
      disconnectProvider: (...args: unknown[]) => mockDisconnectProvider(...args),
    }));
    vi.doMock('../../src/services/user-data-export', () => ({
      revokeThirdPartyOAuthTokenForProvider:
        (...args: unknown[]) => mockRevokeThirdPartyOAuthTokenForProvider(...(args as [])),
    }));
    vi.doMock('../../src/services/database', () => ({
      getDb: vi.fn(() => taskSyncDb ?? ({
        prepare: vi.fn(() => ({
          get: (...args: unknown[]) => mockDbGet(...args),
          all: (...args: unknown[]) => mockDbAll(...args),
          run: (...args: unknown[]) => mockDbRun(...args),
        })),
      })),
    }));
  });

  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = originalEnv.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = originalEnv.GOOGLE_CLIENT_SECRET;
    process.env.OUTLOOK_CLIENT_ID = originalEnv.OUTLOOK_CLIENT_ID;
    process.env.OUTLOOK_CLIENT_SECRET = originalEnv.OUTLOOK_CLIENT_SECRET;
    process.env.STRAVA_CLIENT_ID = originalEnv.STRAVA_CLIENT_ID;
    process.env.STRAVA_CLIENT_SECRET = originalEnv.STRAVA_CLIENT_SECRET;
    process.env.WHOOP_CLIENT_ID = originalEnv.WHOOP_CLIENT_ID;
    process.env.WHOOP_CLIENT_SECRET = originalEnv.WHOOP_CLIENT_SECRET;
    vi.resetModules();
  });

  it('returns per-user connections plus provider availability', async () => {
    const res = await dispatchConnections(42);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.connections).toHaveLength(1);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.connections[0]).toEqual({
      provider: 'google',
      connectedAt: '2026-04-15T09:00:00Z',
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
      capabilities: ['calendar', 'gmail'],
    });
    expect(res.body.data.availability).toEqual([
      { provider: 'google', available: true, capabilities: ['calendar', 'gmail'] },
      {
        provider: 'outlook',
        available: false,
        capabilities: ['calendar', 'email', 'tasks'],
        reasonCode: 'NOT_CONFIGURED',
        detail: 'OAuth is not configured for outlook in this environment.',
      },
      { provider: 'garmin', available: true, capabilities: ['training', 'sleep', 'readiness'] },
      {
        provider: 'strava',
        available: false,
        capabilities: ['runs', 'rides', 'load'],
        reasonCode: 'NOT_CONFIGURED',
        detail: 'OAuth is not configured for strava in this environment.',
      },
      {
        provider: 'whoop',
        available: false,
        capabilities: ['recovery', 'strain', 'sleep'],
        reasonCode: 'COMING_SOON',
        detail: 'WHOOP support is coming soon in this iOS release.',
      },
    ]);
  });

  it('returns a client-safe message when the connections resolver fails unexpectedly', async () => {
    mockGetUserConnections.mockImplementation(() => {
      throw new Error('oauth_store table missing');
    });

    const res = await dispatchConnections(42);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Unable to load connections right now.',
    });
  });

  it('does not surface Garmin as connected from active metadata without scoped session material', async () => {
    const garminRow = {
      garmin_email: 'wrong-user@garmin.example',
      status: 'active',
      connected_at: '2026-05-02T10:00:00Z',
      updated_at: '2026-05-02T10:00:00Z',
    };
    mockDbGet.mockReset();
    mockDbGet
      .mockReturnValueOnce(garminRow)
      .mockReturnValueOnce({ status: 'active' })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ tokens_json: '{}' })
      .mockReturnValueOnce(garminRow)
      .mockReturnValueOnce({ status: 'active' })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ tokens_json: '{}' });

    const res = await dispatchConnections(42);
    const connectionProviders = res.body.data.connections.map((connection: any) => connection.provider);
    const garmin = res.body.data.integrations.find((integration: any) => integration.provider === 'garmin');

    expect(connectionProviders).toEqual(['google']);
    expect(garmin.state).toBe('disconnected');
    expect(res.body.data.capabilities.health).toBe(false);
  });

  it('fails closed on invalid tenant scope before loading connections', async () => {
    const res = await dispatchConnections(0);
    const observability = await import('../../src/services/tenant-scope-observability');

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(observability.getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'connections_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('marks Strava available when credentials exist and keeps WHOOP as coming soon', async () => {
    process.env.STRAVA_CLIENT_ID = 'strava-client';
    process.env.STRAVA_CLIENT_SECRET = 'strava-secret';
    process.env.WHOOP_CLIENT_ID = 'whoop-client';
    process.env.WHOOP_CLIENT_SECRET = 'whoop-secret';

    const res = await dispatchConnections(7);
    const availability = res.body.data.availability;

    expect(availability.find((item: any) => item.provider === 'strava')).toEqual({
      provider: 'strava',
      available: true,
      capabilities: ['runs', 'rides', 'load'],
    });
    expect(availability.find((item: any) => item.provider === 'whoop')).toEqual({
      provider: 'whoop',
      available: false,
      capabilities: ['recovery', 'strain', 'sleep'],
      reasonCode: 'COMING_SOON',
      detail: 'WHOOP support is coming soon in this iOS release.',
    });
  });

  it('returns canonical integrations[] array with one entry per provider (Gap 6)', async () => {
    const res = await dispatchConnections(42);
    const integrations = res.body.data.integrations;

    // One row per connectable provider, including coming_soon and not_configured.
    const providerNames = integrations.map((i: any) => i.provider).sort();
    expect(providerNames).toEqual(
      ['google', 'outlook', 'garmin', 'apple_health', 'strava', 'whoop', 'fitbit', 'todoist', 'notion'].sort(),
    );
  });

  it('includes canonical capability flags derived from the connected providers', async () => {
    const res = await dispatchConnections(42);
    // The default mock seeds google with gmail + calendar scopes, so both
    // capability flags flip true and no other integration is connected.
    expect(res.body.data.capabilities).toEqual({
      mail: true,
      calendar: true,
      externalTasks: false,
      health: false,
    });
    expect(res.body.data.counts.connected).toBe(1);
  });

  it('reflects Garmin needs_reauth as revoked in integrations[] (Gap 6 core)', async () => {
    // Override the db mock so the garmin row returns status=needs_reauth —
    // the legacy `connections[]` field hides this because it only adds
    // garmin when status=active. The canonical integrations[] must surface
    // revoked as a first-class state.
    mockDbGet.mockReturnValue({
      garmin_email: 'felipe@example.com',
      status: 'needs_reauth',
      connected_at: '2026-03-01T10:00:00Z',
      updated_at: '2026-04-20T10:00:00Z',
    });

    const res = await dispatchConnections(42);
    const garmin = res.body.data.integrations.find((i: any) => i.provider === 'garmin');

    expect(garmin.state).toBe('revoked');
    expect(garmin.reasonCode).toBe('NEEDS_REAUTH');
  });

  it('reflects Garmin mfa_pending as pending in integrations[]', async () => {
    mockDbGet.mockReturnValue({
      garmin_email: 'felipe@example.com',
      status: 'mfa_pending',
      connected_at: '2026-04-20T10:00:00Z',
      updated_at: '2026-04-20T10:00:00Z',
    });

    const res = await dispatchConnections(42);
    const garmin = res.body.data.integrations.find((i: any) => i.provider === 'garmin');

    expect(garmin.state).toBe('pending');
    expect(garmin.reasonCode).toBe('MFA_PENDING');
  });

  it('Gmail-only user gets outlook in integrations[] as disconnected (not missing)', async () => {
    const res = await dispatchConnections(42);
    const outlook = res.body.data.integrations.find((i: any) => i.provider === 'outlook');

    expect(outlook).toBeDefined();
    // Outlook OAuth config is NOT_CONFIGURED in this test's beforeEach
    // (OUTLOOK_CLIENT_ID = ''), so the canonical state is not_configured.
    expect(outlook.state).toBe('not_configured');
    expect(outlook.reasonCode).toBe('NOT_CONFIGURED');
  });

  describe('DELETE /connections/:provider task sync-state cleanup', () => {
    let syncDb: Database.Database;

    function seedTaskSyncRows(): void {
      syncDb.exec(`
        CREATE TABLE task_sync_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          last_sync_at TEXT,
          sync_cursor TEXT,
          status TEXT DEFAULT 'idle',
          error_message TEXT,
          tasks_synced INTEGER DEFAULT 0,
          sync_duration_ms INTEGER,
          UNIQUE(user_id, provider)
        );
        CREATE TABLE user_oauth_tokens (
          user_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          PRIMARY KEY (user_id, provider)
        );
      `);
      const insert = syncDb.prepare(
        `INSERT INTO task_sync_state (user_id, provider, last_sync_at, status)
         VALUES (?, ?, '2026-07-01T10:00:00Z', 'idle')`,
      );
      insert.run(42, 'ms_todo');
      insert.run(42, 'todoist');
      insert.run(77, 'ms_todo');
    }

    function remainingSyncRows(): Array<{ user_id: number; provider: string }> {
      return syncDb.prepare(
        'SELECT user_id, provider FROM task_sync_state ORDER BY user_id, provider',
      ).all() as Array<{ user_id: number; provider: string }>;
    }

    beforeEach(() => {
      syncDb = new Database(':memory:');
      seedTaskSyncRows();
      taskSyncDb = syncDb;
      mockDisconnectProvider.mockReset();
      mockRevokeThirdPartyOAuthTokenForProvider.mockClear();
    });

    afterEach(() => {
      taskSyncDb = null;
      syncDb.close();
    });

    it('removes only the disconnecting user Microsoft To Do sync-state row on outlook disconnect', async () => {
      const res = await dispatchDisconnect(42, 'outlook');

      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({ provider: 'outlook', disconnected: true }));
      expect(mockDisconnectProvider).toHaveBeenCalledWith(42, 'outlook');
      expect(remainingSyncRows()).toEqual([
        { user_id: 42, provider: 'todoist' },
        { user_id: 77, provider: 'ms_todo' },
      ]);
    });

    it('removes only the disconnecting user todoist sync-state row on todoist disconnect', async () => {
      const res = await dispatchDisconnect(42, 'todoist');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual(expect.objectContaining({ provider: 'todoist', disconnected: true }));
      expect(remainingSyncRows()).toEqual([
        { user_id: 42, provider: 'ms_todo' },
        { user_id: 77, provider: 'ms_todo' },
      ]);
    });

    it('leaves task sync-state untouched when disconnecting a non-task provider', async () => {
      const res = await dispatchDisconnect(42, 'google');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual(expect.objectContaining({ provider: 'google', disconnected: true }));
      expect(mockDisconnectProvider).toHaveBeenCalledWith(42, 'google');
      expect(remainingSyncRows()).toEqual([
        { user_id: 42, provider: 'ms_todo' },
        { user_id: 42, provider: 'todoist' },
        { user_id: 77, provider: 'ms_todo' },
      ]);
    });

    it('keeps disconnect successful when the sync-state cleanup fails (non-fatal)', async () => {
      syncDb.exec('DROP TABLE task_sync_state');

      const res = await dispatchDisconnect(42, 'outlook');

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({ provider: 'outlook', disconnected: true }));
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42, provider: 'outlook' }),
        expect.stringContaining('Task sync-state cleanup on disconnect failed'),
      );
    });
  });

  describe('DELETE /connections/:provider disconnect data-policy (M12)', () => {
    let policyDb: Database.Database;

    function seedFullTaskSchema(): void {
      policyDb.exec(`
        CREATE TABLE task_sync_state (
          user_id INTEGER NOT NULL, provider TEXT NOT NULL, last_sync_at TEXT,
          sync_cursor TEXT, status TEXT DEFAULT 'idle', error_message TEXT,
          tasks_synced INTEGER DEFAULT 0, sync_duration_ms INTEGER,
          UNIQUE(user_id, provider)
        );
        CREATE TABLE user_oauth_tokens (
          user_id INTEGER NOT NULL, provider TEXT NOT NULL, PRIMARY KEY (user_id, provider)
        );
        CREATE TABLE unified_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tenant_id INTEGER,
          provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', is_deleted INTEGER DEFAULT 0,
          synced_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          nexus_task_id TEXT NOT NULL, sync_state TEXT NOT NULL DEFAULT 'synced',
          source_of_truth TEXT NOT NULL DEFAULT 'nexus', deleted_at TEXT
        );
        CREATE TABLE task_provider_links (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tenant_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL, provider TEXT NOT NULL, provider_account_id TEXT NOT NULL,
          provider_task_id TEXT, provider_list_id TEXT, provider_project_id TEXT,
          ownership TEXT NOT NULL, link_state TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE task_list_sync_selection (
          id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
          provider TEXT NOT NULL, provider_list_id TEXT NOT NULL, sync_enabled INTEGER NOT NULL DEFAULT 1,
          UNIQUE(tenant_id, user_id, provider, provider_list_id)
        );
      `);
      policyDb.prepare(`INSERT INTO task_sync_state (user_id, provider, status) VALUES (42, 'ms_todo', 'idle')`).run();
      // Provider-origin import: unified_tasks.provider = ms_todo + active provider_imported link.
      policyDb.prepare(
        `INSERT INTO unified_tasks (user_id, tenant_id, provider, external_id, title, nexus_task_id, sync_state)
         VALUES (42, 42, 'ms_todo', 'ext1', 'Imported', 'task_ext1', 'synced')`,
      ).run();
      policyDb.prepare(
        `INSERT INTO task_provider_links (id, task_id, tenant_id, user_id, provider, provider_account_id, provider_task_id, provider_list_id, ownership, link_state)
         VALUES ('link1', 'task_ext1', 42, 42, 'ms_todo', 'ms_todo:42', 'ext1', 'listA', 'provider_imported', 'linked')`,
      ).run();
      policyDb.prepare(
        `INSERT INTO task_list_sync_selection (id, tenant_id, user_id, provider, provider_list_id, sync_enabled)
         VALUES ('sel1', 42, 42, 'ms_todo', 'listB', 0)`,
      ).run();
    }

    beforeEach(() => {
      policyDb = new Database(':memory:');
      seedFullTaskSchema();
      taskSyncDb = policyDb;
      mockDisconnectProvider.mockReset();
      mockRevokeThirdPartyOAuthTokenForProvider.mockClear();
    });

    afterEach(() => {
      taskSyncDb = null;
      policyDb.close();
    });

    function taskState(): { is_deleted: number; sync_state: string } {
      return policyDb.prepare(
        `SELECT is_deleted, sync_state FROM unified_tasks WHERE external_id = 'ext1'`,
      ).get() as { is_deleted: number; sync_state: string };
    }

    function linkState(): { link_state: string; provider_task_id: string | null } {
      return policyDb.prepare(
        `SELECT link_state, provider_task_id FROM task_provider_links WHERE id = 'link1'`,
      ).get() as { link_state: string; provider_task_id: string | null };
    }

    it('defaults to policy=keep with zeroed counts (backward compatible)', async () => {
      const res = await dispatchDisconnect(42, 'outlook');

      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.policy).toBe('keep');
      expect(res.body.data.counts).toEqual({ archivedCount: 0, removedCount: 0, keptLocalCount: 0 });
      // keep leaves the imported row and its link untouched.
      expect(taskState()).toEqual({ is_deleted: 0, sync_state: 'synced' });
      expect(linkState().link_state).toBe('linked');
    });

    it('rejects an unknown policy with 400', async () => {
      const res = await dispatchDisconnect(42, 'outlook', { policy: 'nuke' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('archive converts provider imports to local-only and orphans the link', async () => {
      const res = await dispatchDisconnect(42, 'outlook', { policy: 'archive' });

      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.policy).toBe('archive');
      expect(res.body.data.counts).toEqual({ archivedCount: 1, removedCount: 0, keptLocalCount: 0 });
      expect(taskState()).toEqual({ is_deleted: 0, sync_state: 'local_only' });
      expect(linkState()).toEqual({ link_state: 'orphaned', provider_task_id: null });
      // Selection is cleared on disconnect.
      const selCount = policyDb.prepare(`SELECT COUNT(*) AS c FROM task_list_sync_selection`).get() as { c: number };
      expect(selCount.c).toBe(0);
    });

    it('remove soft-deletes provider-origin imports', async () => {
      const res = await dispatchDisconnect(42, 'outlook', { policy: 'remove' });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.policy).toBe('remove');
      expect(res.body.data.counts).toEqual({ archivedCount: 0, removedCount: 1, keptLocalCount: 0 });
      expect(taskState()).toEqual({ is_deleted: 1, sync_state: 'local_only' });
      expect(linkState().link_state).toBe('orphaned');
    });

    it('leaves no stale connected sync-state row after disconnect', async () => {
      await dispatchDisconnect(42, 'outlook', { policy: 'archive' });
      const remaining = policyDb.prepare(
        `SELECT COUNT(*) AS c FROM task_sync_state WHERE user_id = 42 AND provider = 'ms_todo'`,
      ).get() as { c: number };
      expect(remaining.c).toBe(0);
    });

    it('accepts a policy for a non-task provider as a no-op', async () => {
      const res = await dispatchDisconnect(42, 'google', { policy: 'remove' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.policy).toBe('remove');
      expect(res.body.data.counts).toEqual({ archivedCount: 0, removedCount: 0, keptLocalCount: 0 });
      // Task rows are untouched for a non-task provider.
      expect(taskState()).toEqual({ is_deleted: 0, sync_state: 'synced' });
    });
  });
});
