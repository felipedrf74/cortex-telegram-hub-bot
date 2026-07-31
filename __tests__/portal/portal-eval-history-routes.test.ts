import fs from 'node:fs';
import path from 'node:path';
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

vi.mock('../../src/api/secret-guards', async () => ({
  ...await vi.importActual<typeof import('../../src/api/secret-guards')>('../../src/api/secret-guards'),
  requirePortalAdminToken: mocks.requirePortalAdminToken,
}));

vi.mock('../../src/services/database', async () => ({
  ...await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database'),
  getDb: (...args: unknown[]) => mocks.getDb(...args),
}));

vi.mock('../../src/services/chat-eval-history', async () => ({
  ...await vi.importActual<typeof import('../../src/services/chat-eval-history')>('../../src/services/chat-eval-history'),
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

vi.mock('../../src/portal/http', async () => ({
  ...await vi.importActual<typeof import('../../src/portal/http')>('../../src/portal/http'),
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

  it('rate-limits history and frozen-baseline routes before admin authorization', () => {
    const { app, routes } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/portal/eval-history', expect.any(Function), mocks.requirePortalAdminToken, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/portal/eval-history', expect.any(Function), mocks.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/portal/eval-history/frozen-baseline', expect.any(Function), mocks.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(routes.get('GET /api/portal/eval-history')?.[1]).toBe(mocks.requirePortalAdminToken);
    expect(routes.get('POST /api/portal/eval-history')?.[1]).toBe(mocks.requirePortalAdminToken);
    expect(routes.get('POST /api/portal/eval-history/frozen-baseline')?.[1]).toBe(mocks.requirePortalAdminToken);
  });

  it('mounts scoped eval-history body parsing before the default portal JSON parser', () => {
    const serverSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf8',
    );
    const evalHistoryIndex = serverSource.indexOf('registerPortalEvalHistoryRoutes(app);');
    const defaultJsonIndex = serverSource.indexOf('app.use(express.json());');

    expect(evalHistoryIndex).toBeGreaterThan(-1);
    expect(defaultJsonIndex).toBeGreaterThan(evalHistoryIndex);
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
        evidenceJsonSha256: 'e'.repeat(64),
        evidenceMarkdownSha256: 'f'.repeat(64),
        acceptedBy: 'untrusted-client-claim',
      },
    }, res);

    expect(mocks.acceptFrozenRealProviderBaseline).toHaveBeenCalledWith({ __db: true }, {
      runId: 'chat-eval-first-live',
      evidenceJsonPath: 'docs/release/eval-evidence/chat-eval-first-live.json',
      evidenceMarkdownPath: 'docs/release/eval-evidence/chat-eval-first-live.md',
      evidenceJsonSha256: 'e'.repeat(64),
      evidenceMarkdownSha256: 'f'.repeat(64),
      // Absent from the request body, so the reduced-provenance escape hatch
      // is never opened by omission.
      acknowledgeOperatorCheckoutProvenance: false,
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
      evidenceJsonSha256: 'e'.repeat(64),
      evidenceMarkdownSha256: 'f'.repeat(64),
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

  it('preserves durable judge-ledger evidence while normalizing cost attestation', async () => {
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);
    const result = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const costAttestation = {
      contractVersion: 'chat-live-eval-v1',
      attested: true,
      reasons: [],
      totalCeilingUsd: 0.5,
      targetCeilingUsd: 0.45,
      judgeCeilingUsd: 0.05,
      targetActualSpendUsd: 0.1,
      targetReservedAttemptCeilingUsd: 0.02,
      targetCommittedCeilingUsd: 0.12,
      judgeEstimatedSpendUsd: 0.007,
      judgeActualSpendUsd: 0.003,
      judgeReservedAttemptCeilingUsd: 0.007,
      judgeCommittedCeilingUsd: 0.01,
      judgeUsageCallCount: 7,
      judgeProviderAttemptCount: 7,
      judgeProviders: ['gemini'],
      judgeModels: ['gemini-2.5-flash-lite'],
      judgeUnresolvedPricingCount: 0,
      judgeUsageDatabaseSha256: 'b'.repeat(64),
      totalActualSpendUsd: 0.103,
      totalEstimatedActualSpendUsd: 0.103,
      totalConservativeCommitmentUsd: 0.13,
      targetUsageCallCount: 12,
      targetProviderAttemptCount: 13,
      targetProviders: ['gemini'],
      unresolvedPricingCount: 0,
      preparation: {
        scenarioCount: 7,
        scenarioIds: ['scenario-a'],
        seedProfileVersions: ['single-tenant-live-v2'],
        seedProfileHashes: ['a'.repeat(64)],
        aggregateResetCounts: {},
      },
    };
    mocks.persistChatEvalRun.mockReturnValue({
      runId: 'chat-eval-ledger-route',
      runRowId: 43,
      scenarioCount: result.scenarioCount,
    });

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/eval-history')?.at(-1)!({
      body: {
        result,
        runId: 'chat-eval-ledger-route',
        costAttestation,
      },
    }, res);

    expect(mocks.persistChatEvalRun).toHaveBeenCalledWith(result, expect.objectContaining({
      costAttestation,
    }));
    expect(payload.body).toEqual({
      ok: true,
      runId: 'chat-eval-ledger-route',
      runRowId: 43,
      scenarioCount: result.scenarioCount,
    });

    mocks.persistChatEvalRun.mockClear();
    const { payload: invalidPayload, res: invalidRes } = makeResponse();
    routes.get('POST /api/portal/eval-history')?.at(-1)!({
      body: {
        result: { ...result, mode: 'local_engine' },
        runId: 'chat-eval-missing-ledger-identity',
        costAttestation: {
          ...costAttestation,
          judgeUsageDatabaseSha256: undefined,
        },
        preflightAttestation: {
          contractVersion: 'chat-live-eval-v1',
          mode: 'local_engine',
          runId: 'chat-eval-missing-ledger-identity',
          providerPolicy: 'local_only',
          productionDataUsed: false,
          seedProfileVersion: 'single-tenant-live-v2',
          supportedScenarioIds: ['scenario-a'],
        },
      },
    }, invalidRes);

    expect(invalidPayload.statusCode).toBe(400);
    expect(invalidPayload.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_EVAL_EVIDENCE' },
    });
    expect(mocks.persistChatEvalRun).not.toHaveBeenCalled();
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
