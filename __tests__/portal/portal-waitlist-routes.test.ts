import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  countFounderSlots: vi.fn(),
  requirePortalAdminToken: vi.fn(),
  getDb: vi.fn(),
  createInviteCode: vi.fn(),
  loggerError: vi.fn(),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/api/routes/waitlist', () => ({
  countFounderSlots: (...args: unknown[]) => hoisted.countFounderSlots(...args),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => hoisted.getDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/user-service', () => ({
  createInviteCode: (...args: unknown[]) => hoisted.createInviteCode(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: (...args: unknown[]) => hoisted.loggerError(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/portal/admin-audit', () => ({
  logPortalAdminMutation: (...args: unknown[]) => hoisted.logPortalAdminMutation(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

import { registerPortalWaitlistRoutes } from '../../src/portal/waitlist-routes';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  return {
    routes,
    app: {
      get: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`GET ${route}`, handlers);
      }),
      post: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`POST ${route}`, handlers);
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

function makeDb(overrides: {
  waitlistRows?: unknown[];
  totals?: unknown;
  selectedRow?: unknown;
  failOnList?: boolean;
} = {}) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        if (overrides.failOnList) throw new Error('raw waitlist db path /private/waitlist.sqlite');
        return overrides.waitlistRows ?? [];
      }),
      get: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes('SELECT * FROM waitlist')) return overrides.selectedRow;
        return overrides.totals ?? {};
      }),
      run: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
      }),
    })),
  };
  return { calls, db };
}

describe('portal waitlist routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.countFounderSlots.mockReturnValue(17);
    hoisted.createInviteCode.mockReturnValue('INVITE-123');
    hoisted.getDb.mockReturnValue(makeDb().db);
  });

  it('registers waitlist routes behind the admin token guard', () => {
    const { app, routes } = makeApp();

    registerPortalWaitlistRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/waitlist', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/waitlist/:id/approve', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/waitlist/:id/reject', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/waitlist/:id/invited', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(routes.get('GET /api/waitlist')?.[0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('lists waitlist entries with filters, bounded limit, and founder counters', () => {
    const recorder = makeDb({
      waitlistRows: [{ id: 1, email: 'founder@example.com' }],
      totals: { pending_total: 1 },
    });
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalWaitlistRoutes(app as any);
    const handler = routes.get('GET /api/waitlist')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ query: { status: 'pending', intent: 'founder', limit: '5000' } }, res);

    expect(payload.body).toEqual({
      ok: true,
      entries: [{ id: 1, email: 'founder@example.com' }],
      counters: {
        founder: 17,
        totals: { pending_total: 1 },
      },
    });
    expect(recorder.calls[0]).toEqual({
      sql: expect.stringContaining('FROM waitlist WHERE status = ? AND intent = ? ORDER BY created_at DESC LIMIT ?'),
      args: ['pending', 'founder', 1000],
    });
  });

  it('approves a founder waitlist entry, tags the invite, and records an audit event', () => {
    const req = { params: { id: '42' }, body: { expiresInDays: 14 } };
    const recorder = makeDb({
      selectedRow: {
        id: 42,
        email: 'founder@example.com',
        intent: 'founder',
        status: 'pending',
        founder_slot: 3,
      },
    });
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalWaitlistRoutes(app as any);
    const handler = routes.get('POST /api/waitlist/:id/approve')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.createInviteCode).toHaveBeenCalledWith(0, 1, 14);
    expect(recorder.calls).toContainEqual({
      sql: 'UPDATE invite_codes SET skill_preset = ? WHERE code = ?',
      args: [JSON.stringify({ tier: 'founder', founderSlot: 3 }), 'INVITE-123'],
    });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'waitlist.approve', {
      waitlistId: 42,
      email: 'founder@example.com',
      intent: 'founder',
      inviteCode: 'INVITE-123',
    });
    expect(payload.body).toEqual({
      ok: true,
      code: 'INVITE-123',
      email: 'founder@example.com',
      intent: 'founder',
    });
  });

  it('rejects invalid waitlist ids before approving or mutating state', () => {
    const { app, routes } = makeApp();
    registerPortalWaitlistRoutes(app as any);
    const handler = routes.get('POST /api/waitlist/:id/approve')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { id: 'bad' }, body: {} }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'invalid waitlist id' });
    expect(hoisted.getDb).not.toHaveBeenCalled();
    expect(hoisted.createInviteCode).not.toHaveBeenCalled();
  });

  it('does not re-approve non-pending entries unless forced', () => {
    const recorder = makeDb({
      selectedRow: {
        id: 42,
        email: 'founder@example.com',
        intent: 'founder',
        status: 'approved',
      },
    });
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalWaitlistRoutes(app as any);
    const handler = routes.get('POST /api/waitlist/:id/approve')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { id: '42' }, body: {} }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({
      ok: false,
      error: 'Already approved. Pass {"force": true} to re-approve.',
    });
    expect(hoisted.createInviteCode).not.toHaveBeenCalled();
  });

  it('rejects and marks invited entries with admin audit events', () => {
    const recorder = makeDb();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalWaitlistRoutes(app as any);
    const rejectHandler = routes.get('POST /api/waitlist/:id/reject')?.[2]!;
    const invitedHandler = routes.get('POST /api/waitlist/:id/invited')?.[1]!;
    const rejectResponse = makeResponse();
    const invitedResponse = makeResponse();

    rejectHandler({ params: { id: '42' }, body: { notes: 'not a fit' } }, rejectResponse.res);
    invitedHandler({ params: { id: '42' } }, invitedResponse.res);

    expect(rejectResponse.payload.body).toEqual({ ok: true });
    expect(invitedResponse.payload.body).toEqual({ ok: true });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: '42' } }),
      0,
      'waitlist.reject',
      { waitlistId: 42, notes: 'not a fit' },
    );
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: '42' } }),
      0,
      'waitlist.invited',
      { waitlistId: 42 },
    );
  });

  it('uses the shared internal-error helper for waitlist failures', () => {
    hoisted.getDb.mockReturnValue(makeDb({ failOnList: true }).db);
    const { app, routes } = makeApp();
    registerPortalWaitlistRoutes(app as any);
    const handler = routes.get('GET /api/waitlist')?.[1]!;
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
