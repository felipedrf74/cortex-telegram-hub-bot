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

  /** Minimal attestation that satisfies the route's cost guard. */
  function attestedCostEvidence(): Record<string, unknown> {
    const numeric = Object.fromEntries([
      'totalCeilingUsd', 'targetCeilingUsd', 'judgeCeilingUsd',
      'targetActualSpendUsd', 'targetReservedAttemptCeilingUsd', 'targetCommittedCeilingUsd',
      'judgeEstimatedSpendUsd', 'judgeActualSpendUsd', 'judgeReservedAttemptCeilingUsd',
      'judgeCommittedCeilingUsd', 'judgeUsageCallCount', 'judgeProviderAttemptCount',
      'judgeUnresolvedPricingCount', 'totalActualSpendUsd',
      'totalEstimatedActualSpendUsd', 'totalConservativeCommitmentUsd',
      'targetUsageCallCount', 'targetProviderAttemptCount', 'unresolvedPricingCount',
    ].map((key) => [key, 0]));
    return {
      contractVersion: 'chat-live-eval-v1',
      attested: true,
      reasons: [],
      targetProviders: ['gemini'],
      judgeProviders: ['gemini'],
      judgeModels: ['gemini-2.5-flash-lite'],
      judgeUsageDatabaseSha256: null,
      preparation: { scenarioCount: 1 },
      ...numeric,
    };
  }

  it('refuses a hand-typed deployed-release claim that the serving process cannot corroborate', () => {
    const { routes, app } = makeApp();
    registerPortalEvalHistoryRoutes(app as any);
    const suite = {
      generatedAt: '2026-07-31T17:19:58.073Z',
      mode: 'real_provider',
      passed: false,
      averageScore: 1.3,
      scenarioCount: 1,
      statusCounts: { pass: 0, partial: 0, fail: 1, blocked: 0 },
      qualityMetrics: [],
      dayToDay: {},
      scenarios: [],
    };
    const preflight = {
      contractVersion: 'chat-live-eval-v1',
      mode: 'real_provider',
      runId: 'chat-eval-forged',
      providerPolicy: 'metered_cloud_only',
      productionDataUsed: false,
      seedProfileVersion: 'single-tenant-live-v3',
      supportedScenarioIds: ['morning_planning'],
      // Well-formed, entirely fabricated, and not what this process is serving.
      deployedRelease: { runtimeSha: 'c'.repeat(40), artifactDigest: 'd'.repeat(64), role: 'staging' },
    };

    vi.stubEnv('NEXUS_RELEASE_SHA', '');
    vi.stubEnv('NEXUS_RELEASE_ARTIFACT_SHA256', '');
    vi.stubEnv('NEXUS_RELEASE_ROLE', '');
    const handler = routes.get('POST /api/portal/eval-history')?.at(-1)!;
    handler({ body: { result: suite, costAttestation: null, preflightAttestation: preflight } }, makeResponse().res);
    expect(mocks.persistChatEvalRun).not.toHaveBeenCalled();

    // Even a fully attested process must reject an identity that is not its own.
    vi.stubEnv('NEXUS_RELEASE_SHA', 'a'.repeat(40));
    vi.stubEnv('NEXUS_RELEASE_ARTIFACT_SHA256', 'b'.repeat(64));
    vi.stubEnv('NEXUS_RELEASE_ROLE', 'staging');
    mocks.persistChatEvalRun.mockReturnValue({ runId: 'chat-eval-forged', runRowId: 1, scenarioCount: 1 });
    handler({
      body: {
        result: suite,
        costAttestation: attestedCostEvidence(),
        preflightAttestation: preflight,
      },
    }, makeResponse().res);
    const forwarded = mocks.persistChatEvalRun.mock.calls.at(-1)?.[1];
    expect(forwarded?.preflightAttestation?.deployedRelease ?? null).toBeNull();

    // Not vacuous: the identity this process really serves IS carried through.
    handler({
      body: {
        result: suite,
        costAttestation: attestedCostEvidence(),
        preflightAttestation: {
          ...preflight,
          deployedRelease: { runtimeSha: 'a'.repeat(40), artifactDigest: 'b'.repeat(64), role: 'staging' },
        },
      },
    }, makeResponse().res);
    expect(mocks.persistChatEvalRun.mock.calls.at(-1)?.[1]?.preflightAttestation?.deployedRelease).toEqual({
      runtimeSha: 'a'.repeat(40),
      artifactDigest: 'b'.repeat(64),
      role: 'staging',
    });
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
