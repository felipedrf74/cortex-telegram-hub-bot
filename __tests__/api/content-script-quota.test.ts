import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockIsUserOverDailyCap = vi.fn((..._args: unknown[]) => ({
  over: false,
  spentUsd: 0,
  capUsd: 0.2,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
}));
const mockWithAiBudgetReservation = vi.fn();
const mockGetScriptProvider = vi.fn();
const mockExecuteSkillInference = vi.fn();
const mockRunWithSkillInferenceAccountAdmission = vi.fn();
const mockRejectSkillInferenceApplicationResult = vi.fn();
const mockRejectSkillInferenceApplicationOperationResults = vi.fn();
const mockLoggerError = vi.fn();
const localRoutingState = vi.hoisted(() => ({
  contentProxyEnabled: false,
  mode: 'off' as 'off' | 'shadow' | 'canary' | 'active',
  rolloutPercent: 0,
  enrolled: false,
}));

vi.mock('../../src/services/local-primary-config', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/local-primary-config')>(
    '../../src/services/local-primary-config',
  );
  return {
    ...actual,
    localPrimaryInferenceConfig: {
      ...actual.localPrimaryInferenceConfig,
      get contentProxyEnabled() { return localRoutingState.contentProxyEnabled; },
    },
  };
});

vi.mock('../../src/services/local-inference-runtime-control', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/local-inference-runtime-control')>(
    '../../src/services/local-inference-runtime-control',
  );
  return {
    ...actual,
    getLocalInferenceRuntimeControl: () => ({
      environment: 'staging',
      mode: localRoutingState.mode,
      rolloutPercent: localRoutingState.rolloutPercent,
    }),
  };
});

vi.mock('../../src/services/skill-inference-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/skill-inference-service')>(
    '../../src/services/skill-inference-service',
  );
  return {
    ...actual,
    isLocalInferenceUserEnrolled: () => localRoutingState.enrolled,
    executeSkillInference: (...args: unknown[]) => mockExecuteSkillInference(...args),
    runWithSkillInferenceAccountAdmission: (...args: unknown[]) => (
      mockRunWithSkillInferenceAccountAdmission(...args)
    ),
    rejectSkillInferenceApplicationResult: (...args: unknown[]) => mockRejectSkillInferenceApplicationResult(...args),
    rejectSkillInferenceApplicationOperationResults: (...args: unknown[]) => (
      mockRejectSkillInferenceApplicationOperationResults(...args)
    ),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }),
    transaction: (fn: () => unknown) => fn,
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/cost-guardrail', () => {
  class AiBudgetError extends Error {
    decision: any;
    constructor(decision: any) { super(decision.code); this.name = 'AiBudgetError'; this.decision = decision; }
  }
  return {
    AiBudgetError,
    buildQuotaExceededPayload: vi.fn((quota: { plan: string; resetAt: string }) => ({
      plan: quota.plan,
      resetAt: quota.resetAt,
    })),
    isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
    getDailyQuotaStatus: (...args: unknown[]) => {
      const quota = mockIsUserOverDailyCap(...args);
      return { ...quota, usageFraction: quota.over ? 1 : 0 };
    },
    withAiBudgetReservation: (...args: unknown[]) => mockWithAiBudgetReservation(...args),
    buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
  };
});

vi.mock('../../src/services/content-engine', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/content-engine')>(
    '../../src/services/content-engine',
  );
  return {
    ...actual,
    getScript: (...args: unknown[]) => {
      const providerBoundary = args[16] as ((providerCall: () => Promise<unknown>) => Promise<unknown>) | undefined;
      const providerCall = () => mockGetScriptProvider(...args);
      return providerBoundary ? providerBoundary(providerCall) : providerCall();
    },
  };
});

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: content-script-routes uses the strict by-id helper.
  getUserLanguage: () => 'pt-BR',
  getUserLanguageById: () => 'pt-BR',
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => true),
}));

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  getHeader(name: string): string | undefined;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
    setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = value; return response; },
    getHeader(name: string) { return response.headers[name.toLowerCase()]; },
  };
  return response;
}

function mockReq(body: any, userId?: number | null, routePath = '/script'): Request {
  return {
    method: 'POST',
    url: routePath,
    originalUrl: routePath,
    baseUrl: '',
    path: routePath,
    query: {},
    params: {},
    headers: {},
    header: () => undefined,
    socket: { remoteAddress: '127.0.0.1' },
    body,
    userId,
    tenantId: userId,
  } as any;
}

async function dispatch(body: any, userId: number | null = 12, routePath = '/script'): Promise<MockRes> {
  const { contentRoutes } = await import('../../src/api/routes/content');
  const router = contentRoutes();
  const req = mockReq(body, userId, routePath);
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

describe('Content API — script quota enforcement', () => {
  beforeEach(() => {
    mockIsUserOverDailyCap.mockReset();
    mockWithAiBudgetReservation.mockReset();
    mockGetScriptProvider.mockReset();
    mockExecuteSkillInference.mockReset();
    mockRunWithSkillInferenceAccountAdmission.mockReset();
    mockRunWithSkillInferenceAccountAdmission.mockImplementation(async (
      input: { abortSignal?: AbortSignal },
      operation: (abortSignal: AbortSignal) => Promise<unknown>,
    ) => operation(input.abortSignal ?? new AbortController().signal));
    mockRejectSkillInferenceApplicationResult.mockReset();
    mockRejectSkillInferenceApplicationOperationResults.mockReset();
    localRoutingState.contentProxyEnabled = false;
    localRoutingState.mode = 'off';
    localRoutingState.rolloutPercent = 0;
    localRoutingState.enrolled = false;
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockWithAiBudgetReservation.mockImplementation(async (_request: unknown, providerCall: () => Promise<unknown>) => {
      const quota = mockIsUserOverDailyCap(12);
      if (quota.over) {
        const error = new Error('AI_DAILY_LIMIT_REACHED') as Error & { name: string; decision: Record<string, unknown> };
        error.name = 'AiBudgetError';
        error.decision = {
          allowed: false,
          status: 429,
          code: 'AI_DAILY_LIMIT_REACHED',
          window: 'daily',
          message: `Daily AI quota reached for the ${quota.plan} plan.`,
          quota: { ...quota, usageFraction: 1 },
          reservedCostUsd: 0.01,
          retryAfterSeconds: 60,
          unblocksAt: quota.resetAt,
        };
        throw error;
      }
      return providerCall();
    });
  });

  it('returns 429 before invoking script generation when quota is exhausted', async () => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
    });

    const errorLogs = mockLoggerError.mock.calls.map(([entry]) => ({
      name: (entry as any)?.err?.name,
      message: (entry as any)?.err?.message,
      decision: (entry as any)?.err?.decision,
    }));
    expect(response.statusCode, JSON.stringify({ body: response.body, logs: errorLogs })).toBe(429);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('AI_DAILY_LIMIT_REACHED');
    expect(response.body.error.details).toEqual({
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
      window: 'daily',
      unblocksAt: '2026-04-15T00:00:00.000Z',
      retryAfterSeconds: 60,
      error: 'rate_limited',
      retryable: true,
    });
    expect(mockGetScriptProvider).not.toHaveBeenCalled();
  });

  it('rejects an oversized synchronous topic before provider or budget admission', async () => {
    const response = await dispatch({
      topic: 'x'.repeat(2_001),
      format: 'Reel',
    });

    expect(response.statusCode).toBe(413);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_INPUT_TOO_LARGE',
      details: {
        field: 'topic',
        maxChars: 2_000,
        actualChars: 2_001,
        truncated: false,
      },
    });
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
    expect(mockGetScriptProvider).not.toHaveBeenCalled();
  });

  it('admits the exact synchronous topic boundary before normal budget policy', async () => {
    const response = await dispatch({
      topic: 'x'.repeat(2_000),
      format: 'Reel',
    });

    expect(response.statusCode).toBe(429);
    expect(response.body.error.code).toBe('AI_DAILY_LIMIT_REACHED');
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized regeneration seed without truncating or admitting budget', async () => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
      forceRefresh: true,
      regenerationSeed: 'r'.repeat(121),
    });

    expect(response.statusCode).toBe(413);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_INPUT_TOO_LARGE',
      details: {
        field: 'regenerationSeed',
        maxChars: 120,
        actualChars: 121,
        truncated: false,
      },
    });
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
    expect(mockGetScriptProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['niche', { audience: 'creators' }],
    ['regenerationSeed', 42],
    ['niche', null],
    ['regenerationSeed', null],
  ])('rejects an explicit non-string %s before provider or budget admission', async (field, value) => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
      [field]: value,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      details: { field },
    });
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
    expect(mockGetScriptProvider).not.toHaveBeenCalled();
  });

  it('does not reserve cloud dollars before an enrolled local-primary script attempt', async () => {
    localRoutingState.contentProxyEnabled = true;
    localRoutingState.mode = 'active';
    localRoutingState.rolloutPercent = 100;
    localRoutingState.enrolled = true;
    mockGetScriptProvider.mockRejectedValueOnce(new Error('local_route_reached'));

    const response = await dispatch({
      topic: 'A safe local content workflow',
      format: 'Reel',
    });

    expect(response.statusCode).toBe(500);
    expect(mockGetScriptProvider).toHaveBeenCalledTimes(1);
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('keeps the existing cloud reservation for a non-enrolled canary user', async () => {
    localRoutingState.contentProxyEnabled = true;
    localRoutingState.mode = 'canary';
    localRoutingState.rolloutPercent = 25;
    localRoutingState.enrolled = false;

    const response = await dispatch({
      topic: 'A safe cloud-backed content workflow',
      format: 'Reel',
    });

    expect(response.statusCode).toBe(429);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(1);
    expect(mockGetScriptProvider).not.toHaveBeenCalled();
  });

  it('returns a retryable public-safe capacity error instead of a degraded local script', async () => {
    localRoutingState.contentProxyEnabled = true;
    localRoutingState.mode = 'active';
    localRoutingState.rolloutPercent = 100;
    localRoutingState.enrolled = true;
    const { ForwardedLocalInferenceError } = await import('../../src/services/content-engine');
    mockGetScriptProvider.mockRejectedValueOnce(new ForwardedLocalInferenceError({
      code: 'LOCAL_QUEUE_FULL',
      status: 503,
      message: 'Local inference queue is full.',
      details: { retryable: true },
    }));

    const response = await dispatch({ topic: 'A safe capacity check', format: 'Reel' });

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'LOCAL_QUEUE_FULL',
      details: { retryable: true },
    });
    expect(response.headers['retry-after']).toBe('60');
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('does not count a locally generated script that the public safety gate withholds', async () => {
    localRoutingState.contentProxyEnabled = true;
    localRoutingState.mode = 'active';
    localRoutingState.rolloutPercent = 100;
    localRoutingState.enrolled = true;
    mockGetScriptProvider.mockResolvedValueOnce({
      topic: 'Fluxo local seguro',
      script: 'RAW_PROVIDER_OUTPUT\nEste texto deve ser retido antes da entrega.',
      hook: 'Revê este fluxo local.',
      title_options: ['Fluxo local seguro'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      hashtags: [],
      caption: '',
      cta: 'Revê o resultado.',
      degraded: false,
      warnings: [],
    });

    const response = await dispatch({ topic: 'Fluxo local seguro', format: 'Reel' });

    expect(response.statusCode).toBe(422);
    expect(response.body.error.code).toBe('CONTENT_SCRIPT_OUTPUT_BLOCKED');
    expect(mockRejectSkillInferenceApplicationOperationResults).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 12,
      userId: 12,
      reason: 'content_script_final_safety_block',
    }));
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('holds account admission across synchronous script generation and passes its signal to Python', async () => {
    localRoutingState.contentProxyEnabled = true;
    localRoutingState.mode = 'active';
    localRoutingState.rolloutPercent = 100;
    localRoutingState.enrolled = true;
    const accountController = new AbortController();
    mockRunWithSkillInferenceAccountAdmission.mockImplementationOnce(async (
      input: { userId: number; abortSignal?: AbortSignal },
      operation: (abortSignal: AbortSignal) => Promise<unknown>,
    ) => {
      expect(input).toMatchObject({ userId: 12, abortSignal: expect.any(AbortSignal) });
      return operation(accountController.signal);
    });
    mockGetScriptProvider.mockResolvedValueOnce({
      topic: 'Fluxo local seguro',
      script: 'RAW_PROVIDER_OUTPUT\nEste texto deve ser retido antes da entrega.',
      hook: 'Revê este fluxo local.',
      title_options: ['Fluxo local seguro'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      hashtags: [],
      caption: '',
      cta: 'Revê o resultado.',
      degraded: false,
      warnings: [],
    });

    const response = await dispatch({ topic: 'Fluxo local seguro', format: 'Reel' });

    expect(response.statusCode).toBe(422);
    expect(mockRunWithSkillInferenceAccountAdmission).toHaveBeenCalledTimes(1);
    const runtimeOptions = mockGetScriptProvider.mock.calls[0]?.[18] as { abortSignal?: AbortSignal };
    expect(runtimeOptions.abortSignal).toBe(accountController.signal);
  });

  it('returns a conflict without starting Python when account deletion already owns the fence', async () => {
    mockRunWithSkillInferenceAccountAdmission.mockRejectedValueOnce(Object.assign(
      new Error('account deletion started'),
      { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    ));

    const response = await dispatch({ topic: 'Do not recreate my content', format: 'Reel' });

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe('ACCOUNT_DELETION_IN_PROGRESS');
    expect(mockGetScriptProvider).not.toHaveBeenCalled();
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('routes an enrolled private rewrite locally without reserving cloud budget', async () => {
    localRoutingState.contentProxyEnabled = true;
    localRoutingState.mode = 'active';
    localRoutingState.rolloutPercent = 100;
    localRoutingState.enrolled = true;
    const accountController = new AbortController();
    mockRunWithSkillInferenceAccountAdmission.mockImplementationOnce(async (
      input: { userId: number; abortSignal?: AbortSignal },
      operation: (abortSignal: AbortSignal) => Promise<unknown>,
    ) => {
      expect(input).toMatchObject({ userId: 12, abortSignal: expect.any(AbortSignal) });
      return operation(accountController.signal);
    });
    mockExecuteSkillInference.mockResolvedValueOnce({
      text: 'Roteiro revisto com uma abertura mais direta e clara.',
      provider: 'ollama',
      route: 'local',
      runId: 'content-edit:test',
    });

    const response = await dispatch({
      topic: 'Como criar um produto SaaS',
      script: 'Roteiro original do utilizador.',
      action: 'rewrite_hook',
    }, 12, '/script/rewrite');

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.editPatch).toMatchObject({
      operation: 'rewrite',
      proposedText: 'Roteiro revisto com uma abertura mais direta e clara.',
    });
    expect(mockExecuteSkillInference).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'content',
      taskType: 'content_script_rewrite',
      containsPrivateData: true,
      allowCloudEscalation: false,
      runId: expect.stringMatching(/^content-edit:[0-9a-f-]{36}$/u),
      abortSignal: accountController.signal,
    }));
    const inferenceRequest = mockExecuteSkillInference.mock.calls[0]?.[0] as {
      operationId: string;
      runId: string;
    };
    expect(inferenceRequest.runId).not.toBe(`content-edit:${inferenceRequest.operationId}`);
    expect(mockRunWithSkillInferenceAccountAdmission).toHaveBeenCalledTimes(1);
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('rejects a rewrite before provider admission while account deletion owns the fence', async () => {
    mockRunWithSkillInferenceAccountAdmission.mockRejectedValueOnce(Object.assign(
      new Error('account deletion started'),
      { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    ));

    const response = await dispatch({
      topic: 'Do not recreate this draft',
      script: 'Private draft pending deletion.',
      action: 'rewrite_hook',
    }, 12, '/script/rewrite');

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe('ACCOUNT_DELETION_IN_PROGRESS');
    expect(mockExecuteSkillInference).not.toHaveBeenCalled();
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('rejects research refresh before search admission while account deletion owns the fence', async () => {
    mockRunWithSkillInferenceAccountAdmission.mockRejectedValueOnce(Object.assign(
      new Error('account deletion started'),
      { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    ));

    const response = await dispatch({
      topic: 'Do not refresh research for this account',
      script: 'Private draft pending deletion.',
    }, 12, '/script/research-refresh');

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe('ACCOUNT_DELETION_IN_PROGRESS');
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('withholds an invalid enrolled local edit without exporting the private draft to cloud', async () => {
    localRoutingState.contentProxyEnabled = true;
    localRoutingState.mode = 'active';
    localRoutingState.rolloutPercent = 100;
    localRoutingState.enrolled = true;
    mockExecuteSkillInference.mockResolvedValueOnce({
      text: 'Here is the rewritten English hook.',
      provider: 'ollama',
      route: 'local',
      runId: 'content-edit:test',
    });

    const response = await dispatch({
      topic: 'Como criar um produto SaaS',
      script: 'Roteiro original do utilizador.',
      action: 'rewrite_hook',
    }, 12, '/script/rewrite');

    expect(response.statusCode).toBe(502);
    expect(response.body.error.code).toBe('CONTENT_SCRIPT_EDIT_LOCALE_MISMATCH');
    expect(mockRejectSkillInferenceApplicationResult).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'content_script_edit_locale_mismatch',
    }));
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('rejects invalid authenticated user scope before starting a budget reservation', async () => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
    }, null);

    expect(response.statusCode).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(response.body.error.message).toBe('Invalid authenticated user scope');
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
  });
});
