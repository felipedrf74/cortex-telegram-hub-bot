import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

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
    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('../../src/services/oauth-store', () => ({
      getUserConnections: vi.fn(() => [
        {
          provider: 'google',
          connectedAt: '2026-04-15T09:00:00Z',
          lastReauthedAt: '2026-04-15T09:00:00Z',
          scopes: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/gmail.readonly',
          ],
        },
      ]),
    }));
    vi.doMock('../../src/services/database', () => ({
      getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({
          get: vi.fn(() => undefined),
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
    vi.doMock('../../src/services/oauth-store', () => ({
      getUserConnections: vi.fn(() => {
        throw new Error('oauth_store table missing');
      }),
    }));

    const res = await dispatchConnections(42);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Unable to load connections right now.',
    });
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
      ['google', 'outlook', 'garmin', 'strava', 'whoop', 'fitbit', 'todoist', 'notion'].sort(),
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
    vi.doMock('../../src/services/database', () => ({
      getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({
          get: vi.fn(() => ({
            garmin_email: 'felipe@example.com',
            status: 'needs_reauth',
            connected_at: '2026-03-01T10:00:00Z',
            updated_at: '2026-04-20T10:00:00Z',
          })),
          all: vi.fn(() => []),
          run: vi.fn(),
        })),
      })),
    }));

    const res = await dispatchConnections(42);
    const garmin = res.body.data.integrations.find((i: any) => i.provider === 'garmin');

    expect(garmin.state).toBe('revoked');
    expect(garmin.reasonCode).toBe('NEEDS_REAUTH');
  });

  it('reflects Garmin mfa_pending as pending in integrations[]', async () => {
    vi.doMock('../../src/services/database', () => ({
      getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({
          get: vi.fn(() => ({
            garmin_email: 'felipe@example.com',
            status: 'mfa_pending',
            connected_at: '2026-04-20T10:00:00Z',
            updated_at: '2026-04-20T10:00:00Z',
          })),
          all: vi.fn(() => []),
          run: vi.fn(),
        })),
      })),
    }));

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
});
