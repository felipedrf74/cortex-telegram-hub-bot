import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  getDb: vi.fn(),
  measureChatCoreV2ShadowGateReadiness: vi.fn(),
  listChatCoreV2GateCheckLog: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', () => ({
  recordPortalAuthAudit: vi.fn(),
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

vi.mock('../../src/services/chat-core-v2/gate-metrics-store', () => ({
  measureChatCoreV2ShadowGateReadiness: (...args: unknown[]) => mocks.measureChatCoreV2ShadowGateReadiness(...args),
  listChatCoreV2GateCheckLog: (...args: unknown[]) => mocks.listChatCoreV2GateCheckLog(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mocks.sendPortalInternalError(...args),
}));

import {
  registerPortalChatCoreV2GateRoutes,
  CHAT_CORE_V2_GATE_READINESS_ROUTE,
} from '../../src/portal/chat-core-v2-gate-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;

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
  const payload = { statusCode: 200, body: undefined as unknown };
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

const HONEST_REPORT = {
  version: 'chat_core_v2_gate_metrics_store@1.0.0',
  shadow: { rowCount: 0, meetsMinRows: false, meetsSchemaValidity: false, meetsSafeShape: false },
  persistedRecallAt8: null,
  recallCorpusContentHash: null,
  recallTarget: 0.9,
  recallMeetsTarget: false,
  recallBoundToSyntheticSeed: false,
  gateCanPromote: false,
  notes: 'gateCanPromote=false: no persisted recall@8 yet (expected until WP-19-seed runs)',
};

describe('portal chat-core-v2 gate readiness route (WP-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
    mocks.getDb.mockReturnValue({ __db: true });
    mocks.measureChatCoreV2ShadowGateReadiness.mockReturnValue(HONEST_REPORT);
    mocks.listChatCoreV2GateCheckLog.mockReturnValue([]);
  });

  it('does NOT register the route when mode=off (so a request 404s — default-off)', () => {
    const { app, routes } = makeApp();
    registerPortalChatCoreV2GateRoutes(app as any, { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' } as any);

    expect(app.get).not.toHaveBeenCalled();
    expect(routes.has(`GET ${CHAT_CORE_V2_GATE_READINESS_ROUTE}`)).toBe(false);
  });

  it('does NOT register the route when the mode env var is absent (default-off)', () => {
    const { app } = makeApp();
    registerPortalChatCoreV2GateRoutes(app as any, {} as any);
    expect(app.get).not.toHaveBeenCalled();
  });

  it('registers an admin-protected GET route when mode != off', () => {
    const { app, routes } = makeApp();
    registerPortalChatCoreV2GateRoutes(app as any, { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' } as any);

    expect(app.get).toHaveBeenCalledWith(
      CHAT_CORE_V2_GATE_READINESS_ROUTE,
      mocks.requirePortalAdminToken,
      expect.any(Function),
    );
    expect(routes.get(`GET ${CHAT_CORE_V2_GATE_READINESS_ROUTE}`)?.[0]).toBe(mocks.requirePortalAdminToken);
  });

  it('returns a 200 honest envelope (gateCanPromote=false) when mode is on', () => {
    const { app, routes } = makeApp();
    registerPortalChatCoreV2GateRoutes(app as any, { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' } as any);

    const { payload, res } = makeResponse();
    const handler = routes.get(`GET ${CHAT_CORE_V2_GATE_READINESS_ROUTE}`)?.at(-1)!;
    handler({ query: {} }, res);

    expect(mocks.measureChatCoreV2ShadowGateReadiness).toHaveBeenCalledWith({ __db: true });
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ ok: true, report: HONEST_REPORT, recentChecks: [] });
    // No PII: the envelope is counts/metrics only.
    const serialized = JSON.stringify(payload.body);
    expect(serialized).not.toMatch(/message|userId|tenantId|email/i);
  });

  it('401s when the admin token guard rejects (auth enforced before the handler)', () => {
    const { app, routes } = makeApp();
    registerPortalChatCoreV2GateRoutes(app as any, { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' } as any);

    // Simulate the real admin guard rejecting: it sends 401 and does NOT call next.
    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, res: any) => {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } });
    });

    const handlers = routes.get(`GET ${CHAT_CORE_V2_GATE_READINESS_ROUTE}`)!;
    expect(handlers[0]).toBe(mocks.requirePortalAdminToken);

    const { payload, res } = makeResponse();
    let nextCalled = false;
    handlers[0]({ query: {} }, res, () => {
      nextCalled = true;
    });

    expect(payload.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
    // The data handler must never run when auth fails.
    expect(mocks.measureChatCoreV2ShadowGateReadiness).not.toHaveBeenCalled();
  });

  it('delegates unexpected failures to the portal error helper', () => {
    const { app, routes } = makeApp();
    registerPortalChatCoreV2GateRoutes(app as any, { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' } as any);
    const err = new Error('db unavailable');
    mocks.measureChatCoreV2ShadowGateReadiness.mockImplementation(() => {
      throw err;
    });

    const { res } = makeResponse();
    const handler = routes.get(`GET ${CHAT_CORE_V2_GATE_READINESS_ROUTE}`)?.at(-1)!;
    handler({ query: {} }, res);

    expect(mocks.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      err,
      'Portal request failed',
      'Portal: chat-core-v2 gate readiness request failed',
    );
  });
});
