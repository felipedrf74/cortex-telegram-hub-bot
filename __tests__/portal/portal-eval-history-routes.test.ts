import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runChatEvaluationSuite } from '../../src/services/chat-evaluation-harness';

const mocks = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  getDb: vi.fn(),
  listChatEvalRuns: vi.fn(),
  persistChatEvalRun: vi.fn(),
  readFrozenRealProviderBaselineState: vi.fn(),
  acceptFrozenRealProviderBaseline: vi.fn(),
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

vi.mock('../../src/services/chat-eval-history', () => ({
  ensureChatEvalHistoryTables: vi.fn(),
  listChatEvalRuns: (...args: unknown[]) => mocks.listChatEvalRuns(...args),
  persistChatEvalRun: (...args: unknown[]) => mocks.persistChatEvalRun(...args),
  readFrozenRealProviderBaselineState: (...args: unknown[]) => mocks.readFrozenRealProviderBaselineState(...args),
  acceptFrozenRealProviderBaseline: (...args: unknown[]) => mocks.acceptFrozenRealProviderBaseline(...args),
  ChatEvalBaselineAcceptanceError: class ChatEvalBaselineAcceptanceError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) {
      super(message);
    }
  },
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mocks.sendPortalInternalError(...args),
}));

import { registerPortalEvalHistoryRoutes } from '../../src/portal/eval-history-routes';
import { ChatEvalBaselineAcceptanceError } from '../../src/services/chat-eval-history';

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

describe('portal eval history routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
    mocks.getDb.mockReturnValue({ __db: true });
    mocks.readFrozenRealProviderBaselineState.mockReturnValue({
      status: 'not_recorded', baseline: null, latestFollowup: null, comparison: null,
    });
  });

  it('registers admin-protected history and frozen-baseline routes', () => {
    const { app, routes } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/portal/eval-history', mocks.requirePortalAdminToken, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/portal/eval-history', mocks.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/portal/eval-history/frozen-baseline', mocks.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(routes.get('GET /api/portal/eval-history')?.[0]).toBe(mocks.requirePortalAdminToken);
    expect(routes.get('POST /api/portal/eval-history')?.[0]).toBe(mocks.requirePortalAdminToken);
    expect(routes.get('POST /api/portal/eval-history/frozen-baseline')?.[0]).toBe(mocks.requirePortalAdminToken);
  });

  it('lists recent eval runs with optional filters', () => {
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);
    mocks.listChatEvalRuns.mockReturnValue([{ runId: 'chat-eval-1' }]);

    const { payload, res } = makeResponse();
    const handler = routes.get('GET /api/portal/eval-history')?.at(-1)!;
    handler({ query: { limit: '5', mode: 'real_provider' } }, res);

    expect(mocks.listChatEvalRuns).toHaveBeenCalledWith({ __db: true }, { limit: 5, mode: 'real_provider' });
    expect(payload.body).toEqual({
      ok: true,
      runs: [{ runId: 'chat-eval-1' }],
      frozenBaseline: { status: 'not_recorded', baseline: null, latestFollowup: null, comparison: null },
    });
    expect(mocks.readFrozenRealProviderBaselineState).toHaveBeenCalledWith({ __db: true });
  });

  it('accepts the immutable first baseline only through the admin route and passes server runtime evidence', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('STAGING', 'true');
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);
    mocks.acceptFrozenRealProviderBaseline.mockReturnValue({
      action: 'created',
      baseline: { runId: 'chat-eval-first-live' },
    });

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/eval-history/frozen-baseline')?.at(-1)!({
      body: {
        runId: 'chat-eval-first-live',
        evidenceJsonPath: 'docs/release/eval-evidence/chat-eval-first-live.json',
        evidenceMarkdownPath: 'docs/release/eval-evidence/chat-eval-first-live.md',
        acceptedBy: 'untrusted-client-claim',
      },
    }, res);

    expect(mocks.acceptFrozenRealProviderBaseline).toHaveBeenCalledWith({ __db: true }, {
      runId: 'chat-eval-first-live',
      evidenceJsonPath: 'docs/release/eval-evidence/chat-eval-first-live.json',
      evidenceMarkdownPath: 'docs/release/eval-evidence/chat-eval-first-live.md',
      runtime: { nodeEnv: 'staging', nexusEnv: undefined, staging: 'true' },
    });
    expect(payload.body).toEqual({ ok: true, action: 'created', baseline: { runId: 'chat-eval-first-live' } });
    vi.unstubAllEnvs();
  });

  it('returns a fail-closed client error when baseline evidence is invalid', () => {
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);
    const error = new ChatEvalBaselineAcceptanceError(
      'BASELINE_ALREADY_FROZEN',
      'The first baseline is already frozen.',
      409,
    );
    mocks.acceptFrozenRealProviderBaseline.mockImplementation(() => { throw error; });

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/eval-history/frozen-baseline')?.at(-1)!({ body: {
      runId: 'chat-eval-other',
      evidenceJsonPath: 'docs/release/eval-evidence/chat-eval-other.json',
      evidenceMarkdownPath: 'docs/release/eval-evidence/chat-eval-other.md',
    } }, res);

    expect(payload.statusCode).toBe(409);
    expect(payload.body).toEqual({
      ok: false,
      error: { code: 'BASELINE_ALREADY_FROZEN', message: 'The first baseline is already frozen.' },
    });
    expect(mocks.sendPortalInternalError).not.toHaveBeenCalled();
  });

  it('persists a wrapped eval result', async () => {
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);
    const result = await runChatEvaluationSuite({ mode: 'fixture', generatedAt: '2026-04-29T12:00:00.000Z' });
    mocks.persistChatEvalRun.mockReturnValue({ runId: 'chat-eval-route', runRowId: 42, scenarioCount: result.scenarioCount });

    const { payload, res } = makeResponse();
    const handler = routes.get('POST /api/portal/eval-history')?.at(-1)!;
    handler({
      body: {
        result,
        runId: 'chat-eval-route',
        packageVersion: '4.14.190',
        gitBranch: 'feature/chat-eval',
        gitCommit: 'abc1234',
        jsonReportPath: 'reports/chat-eval/report.json',
        markdownReportPath: 'reports/chat-eval/report.md',
        budgetUsd: 4,
        realProviderCalls: 3,
        costAttestation: null,
        preflightAttestation: null,
      },
    }, res);

    expect(mocks.persistChatEvalRun).toHaveBeenCalledWith(result, expect.objectContaining({
      db: { __db: true },
      runId: 'chat-eval-route',
      packageVersion: '4.14.190',
      budgetUsd: 4,
      realProviderCalls: 3,
      costAttestation: null,
      preflightAttestation: null,
    }));
    expect(payload.body).toEqual({ ok: true, runId: 'chat-eval-route', runRowId: 42, scenarioCount: result.scenarioCount });
  });

  it('rejects missing or malformed eval results', () => {
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);

    const { payload, res } = makeResponse();
    const handler = routes.get('POST /api/portal/eval-history')?.at(-1)!;
    handler({ body: { runId: 'missing-result' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({
      ok: false,
      error: {
        code: 'INVALID_EVAL_RESULT',
        message: 'result must be a chat evaluation suite result',
      },
    });
    expect(mocks.persistChatEvalRun).not.toHaveBeenCalled();
  });

  it('delegates unexpected failures to the portal error helper', () => {
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);
    const err = new Error('db unavailable');
    mocks.listChatEvalRuns.mockImplementation(() => {
      throw err;
    });

    const { res } = makeResponse();
    const handler = routes.get('GET /api/portal/eval-history')?.at(-1)!;
    handler({ query: {} }, res);

    expect(mocks.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      err,
      'Portal request failed',
      'Portal: eval history request failed',
    );
  });
});
