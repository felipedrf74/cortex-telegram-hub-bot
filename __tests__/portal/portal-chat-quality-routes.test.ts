import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  getDb: vi.fn(),
  buildChatQualityDashboard: vi.fn(),
  loadChatV2ReadinessReportFromFile: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', () => ({
  allowLocalHealthBypass: vi.fn(),
  allowLocalPortalBypass: vi.fn(),
  bearerTokenMatches: vi.fn(),
  computePortalActorSignature: vi.fn(),
  createPortalSessionToken: vi.fn(),
  extractBearerToken: vi.fn(),
  extractPortalActorHint: vi.fn(),
  getPortalAuthContext: vi.fn(),
  isLoopbackRequest: vi.fn(),
  requirePortalAdminToken: mocks.requirePortalAdminToken,
  requirePortalToken: vi.fn(),
  requirePortalTokenByMethod: vi.fn(),
  requirePortalWriteToken: vi.fn(),
  secureSecretMatches: vi.fn(),
  verifyPortalActorSignature: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mocks.getDb(...args),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/chat-quality-dashboard', () => ({
  buildChatQualityDashboard: (...args: unknown[]) => mocks.buildChatQualityDashboard(...args),
  loadChatV2ReadinessReportFromFile: (...args: unknown[]) => mocks.loadChatV2ReadinessReportFromFile(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mocks.sendPortalInternalError(...args),
}));

import { registerPortalChatQualityRoutes } from '../../src/portal/chat-quality-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;

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
    contentType: undefined as string | undefined,
    sent: undefined as unknown,
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
    type: vi.fn((value: string) => {
      payload.contentType = value;
      return res;
    }),
    send: vi.fn((body: unknown) => {
      payload.sent = body;
      return res;
    }),
  };
  return { payload, res };
}

describe('portal chat quality routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
    mocks.getDb.mockReturnValue({ __db: true });
    mocks.loadChatV2ReadinessReportFromFile.mockReturnValue({ report: null, reason: 'readiness report artifact not found' });
  });

  it('registers the dashboard JSON endpoint behind the admin token guard', () => {
    const { app, routes } = makeApp();
    registerPortalChatQualityRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/portal/chat-quality', mocks.requirePortalAdminToken, expect.any(Function));
    expect(routes.get('GET /api/portal/chat-quality')?.[0]).toBe(mocks.requirePortalAdminToken);
    // HTML shell page carries no data, so it is intentionally unguarded.
    expect(routes.has('GET /chat-quality')).toBe(true);
  });

  it('returns the aggregated dashboard with the fail-soft readiness report', () => {
    const { app, routes } = makeApp();
    registerPortalChatQualityRoutes(app as any);
    const dashboard = { version: 'chat-quality-dashboard@1.0.0', evalTrend: [] };
    mocks.buildChatQualityDashboard.mockReturnValue(dashboard);
    mocks.loadChatV2ReadinessReportFromFile.mockReturnValue({
      report: { schemaVersion: 'chat_v2_completion_readiness_report.v1' },
      reason: null,
    });

    const { payload, res } = makeResponse();
    const handler = routes.get('GET /api/portal/chat-quality')?.at(-1)!;
    handler({ query: {} }, res);

    expect(mocks.buildChatQualityDashboard).toHaveBeenCalledWith({ __db: true }, {
      readinessReport: { schemaVersion: 'chat_v2_completion_readiness_report.v1' },
      readinessUnavailableReason: undefined,
    });
    expect(payload.body).toEqual({ ok: true, dashboard });
  });

  it('passes the unavailable reason through when no readiness artifact exists', () => {
    const { app, routes } = makeApp();
    registerPortalChatQualityRoutes(app as any);
    mocks.buildChatQualityDashboard.mockReturnValue({ readiness: { available: false } });

    const { res } = makeResponse();
    routes.get('GET /api/portal/chat-quality')?.at(-1)!({ query: {} }, res);

    expect(mocks.buildChatQualityDashboard).toHaveBeenCalledWith({ __db: true }, {
      readinessReport: null,
      readinessUnavailableReason: 'readiness report artifact not found',
    });
  });

  it('delegates unexpected failures to the portal error helper', () => {
    const { app, routes } = makeApp();
    registerPortalChatQualityRoutes(app as any);
    const err = new Error('db unavailable');
    mocks.buildChatQualityDashboard.mockImplementation(() => {
      throw err;
    });

    const { res } = makeResponse();
    routes.get('GET /api/portal/chat-quality')?.at(-1)!({ query: {} }, res);

    expect(mocks.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      err,
      'Portal request failed',
      'Portal: chat quality dashboard request failed',
    );
  });

  it('serves the token-gated HTML shell without embedding data', () => {
    const { app, routes } = makeApp();
    registerPortalChatQualityRoutes(app as any);

    const { payload, res } = makeResponse();
    routes.get('GET /chat-quality')?.at(-1)!({}, res);

    expect(payload.contentType).toBe('html');
    expect(String(payload.sent)).toContain('Chat Quality Dashboard');
    expect(String(payload.sent)).toContain("fetch('/api/portal/chat-quality'");
    expect(String(payload.sent)).toContain('Routing clarify budget');
    expect(String(payload.sent)).toContain('Frozen live baseline');
    expect(String(payload.sent)).toContain('Estimated actual spend (USD)');
    expect(String(payload.sent)).toContain('Budget ceiling (USD)');
    expect(String(payload.sent)).toContain('Judge calls');
    expect(String(payload.sent)).not.toContain('Provider calls');
    expect(String(payload.sent)).toContain('quality deltas unavailable');
    expect(String(payload.sent)).toContain('ChatV2 per-route retirement campaign');
    expect(String(payload.sent)).toContain('Routing agreement and online-eval health are diagnostic only');
    expect(mocks.buildChatQualityDashboard).not.toHaveBeenCalled();
  });
});
