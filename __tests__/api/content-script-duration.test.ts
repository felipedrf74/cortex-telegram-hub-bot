import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  CONTENT_LIVE_EVAL_CORPUS,
  CONTENT_LIVE_EVAL_OPT_IN,
} from '../../src/services/content-live-evaluation-artifact';
import { ContentOutputLanguageMismatchError } from '../../src/services/content-output-language';

const mockGetScript = vi.fn(async () => ({
  topic: 'Test topic',
  script: '[0:00] Test script',
  hook: 'Test hook',
  title_options: ['Title A', 'Title B', 'Title C'],
  sources_used: [],
  estimated_duration: '10:00',
  duration_ms: 1200,
  hashtags: ['#test'],
  caption: 'Caption',
  cta: 'CTA',
  degraded: false,
  warnings: [],
}));
const mockCompleteOneShotWithFallback = vi.fn(async () => ({
  text: 'Expanded or rewritten script body.',
  provider: 'gemini',
}));
const mockCompleteOneShotWithSearch = vi.fn(async () => ({
  text: 'Source note: current compact research summary.',
  sources: ['https://example.com/source-a'],
}));
const mockCompleteOneShotWithOpenAIWebSearch = vi.fn(async () => ({
  text: 'Lower-cost source note.',
  sources: ['https://example.com/lower-cost-source'],
}));
const mockIsOpenAIConfigured = vi.fn(() => false);
const mockWithAiBudgetReservation = vi.fn(async (_request: unknown, providerCall: () => Promise<unknown>) => providerCall());
const mockPersistContentArtifacts = vi.fn(() => ({
  sourcePackageId: 'sp_1234567890abcdef_abcdef1234567890',
  researchArtifactId: 'ra_1234567890abcdef_abcdef1234567890',
  voiceCardVersion: 'voice-v1',
}));
const mockGetAllKnowledge = vi.fn(() => [
  { category: 'brand_voice', synthesized_text: 'Direct founder voice.' },
  { category: 'hook_style', synthesized_text: 'Open with a misconception.' },
]);
const mockListRecentContentIdeaMemory = vi.fn(() => [
  { topic: 'Old SaaS angle', hook: 'The costly myth', angle: 'proof', format: 'YouTube' },
]);
const mockResolveScriptTopicContext = vi.fn(() => null);
const mockBuildAuthorizedContentReferenceContext = vi.fn(() => ({ references: [] }));
const mockBuildContentCreativeProfileContext = vi.fn(() => ({
  tenantId: 12,
  userId: 12,
  platform: 'youtube',
  contextBlock: '',
  memories: [],
  appliedMemoryKeys: [],
  omittedPrivateMemoryKeys: [],
  warnings: [],
  followUpQuestions: [],
  quality: { completenessScore: 0, confidenceScore: 0, staleCount: 0, missingCriticalKeys: [] },
}));
const mockAssessContentNovelty = vi.fn(() => ({
  status: 'novel',
  noveltyScore: 1,
  duplicationRisk: 0,
  reuseAllowed: false,
  matchedCandidates: [],
  reasonCodes: [],
  reviewWarnings: [],
  strategicReuse: {
    intent: 'none',
    originalContentId: null,
    transformationType: null,
    platformChanged: false,
    formatChanged: false,
    angleChanged: false,
    referenceChanged: false,
  },
}));
const mockAssertContentLiveEvalSyntheticRuntimeScope = vi.fn();
const mockGetContentSourcePackage = vi.fn(() => ({
  sourcePackageId: 'sp_1234567890abcdef_abcdef1234567890',
  researchArtifactId: 'ra_1234567890abcdef_abcdef1234567890',
  freshnessClass: 'cached',
  language: 'pt-BR',
  format: 'YouTube',
  sources: [],
  sourceSummary: ['Stored compact source.'],
  tokenEstimate: 12,
  expiresAt: '2026-04-17T00:00:00.000Z',
}));
const mockGetContentResearchArtifact = vi.fn(() => ({
  researchArtifactId: 'ra_1234567890abcdef_abcdef1234567890',
  topicHash: '1234567890abcdef',
  freshnessClass: 'cached',
  language: 'pt-BR',
  format: 'YouTube',
  claims: ['Stored compact claim.'],
  unsafeOrUnverifiedClaims: [],
  expiresAt: '2026-04-17T00:00:00.000Z',
}));
const mockSaveGeneratedScriptToWorkspace = vi.fn(() => ({
  schemaVersion: 'content-workspace-capture-v1',
  workspaceSchemaVersion: 'content-workspace-v1',
  item: { id: 451, workflowVersion: 2 },
  artifact: { id: 452 },
  revisionId: 453,
  replayed: false,
}));
const mockRecordContentVariantFeedback = vi.fn(() => ({
  topic: 'Test topic',
  variantKind: 'script',
  sentiment: 'approved',
  accepted: true,
  sourcePackageId: 'sp_1234567890abcdef_abcdef1234567890',
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  AiBudgetError: class AiBudgetError extends Error {
    decision: any;
    constructor(decision: any) { super(decision.code); this.name = 'AiBudgetError'; this.decision = decision; }
  },
  buildQuotaExceededPayload: vi.fn(() => ({})),
  isUserOverDailyCap: vi.fn(() => ({
    over: false,
    spentUsd: 0,
    capUsd: 0.2,
    plan: 'pro',
    resetAt: '2026-04-15T00:00:00.000Z',
  })),
  enforceCostGuardrails: vi.fn(() => ({
    block: false,
    status: 200,
    reason: 'ok',
    global: { totalUsd: 0, limitUsd: 100, exceeded: false },
    quota: {
      over: false,
      spentUsd: 0,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    },
  })),
  buildQuotaExceededMessage: vi.fn(() => 'quota exceeded'),
  acquireCostLock: vi.fn(async () => () => { /* no-op */ }),
  getDailyQuotaStatus: vi.fn(() => ({
    over: false,
    usageFraction: 0,
    spentUsd: 0,
    capUsd: 0.2,
    plan: 'pro',
    resetAt: '2026-04-15T00:00:00.000Z',
  })),
  withAiBudgetReservation: (request: unknown, providerCall: () => Promise<unknown>) => (
    mockWithAiBudgetReservation(request, providerCall)
  ),
}));

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: content-script-routes uses the strict by-id helper.
  getUserLanguage: vi.fn(() => 'en-US'),
  getUserLanguageById: vi.fn(() => 'en-US'),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
}));

vi.mock('../../src/state/content-references', () => ({
  getKnowledgeByCategory: vi.fn(() => null),
  getAllKnowledge: (...args: unknown[]) => mockGetAllKnowledge(...args),
}));

vi.mock('../../src/api/routes/content-topic-context', () => ({
  resolveScriptTopicContext: (...args: unknown[]) => mockResolveScriptTopicContext(...args),
}));

vi.mock('../../src/services/content-reference-context', () => ({
  buildAuthorizedContentReferenceContext: (...args: unknown[]) => mockBuildAuthorizedContentReferenceContext(...args),
}));

vi.mock('../../src/services/content-memory-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/content-memory-profile')>()),
  buildContentCreativeProfileContext: (...args: unknown[]) => mockBuildContentCreativeProfileContext(...args),
}));

vi.mock('../../src/services/content-novelty-reuse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/content-novelty-reuse')>()),
  assessContentNovelty: (...args: unknown[]) => mockAssessContentNovelty(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: vi.fn(() => null),
      all: vi.fn(() => []),
      run: vi.fn(),
    }),
  }),
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

vi.mock('../../src/services/content-live-evaluation-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/content-live-evaluation-request')>()),
  assertContentLiveEvalSyntheticRuntimeScope: (...args: unknown[]) => (
    mockAssertContentLiveEvalSyntheticRuntimeScope(...args)
  ),
}));

vi.mock('../../src/services/content-engine', () => ({
  SYNTHETIC_EVALUATION_SCRIPT_EXECUTION_POLICY: {
    cache: 'bypass',
    intelligenceSignals: 'bypass',
  },
  getScript: (...args: unknown[]) => {
    const providerBoundary = args[16] as ((providerCall: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const providerCall = () => mockGetScript(...args.slice(0, 16), undefined, args[17]);
    return providerBoundary ? providerBoundary(providerCall) : providerCall();
  },
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: (...args: unknown[]) => mockCompleteOneShotWithFallback(...args),
  completeOneShotWithSearch: (...args: unknown[]) => mockCompleteOneShotWithSearch(...args),
}));

vi.mock('../../src/services/openai-provider', () => ({
  completeOneShotWithWebSearch: (...args: unknown[]) => mockCompleteOneShotWithOpenAIWebSearch(...args),
  isOpenAIConfigured: (...args: unknown[]) => mockIsOpenAIConfigured(...args),
}));

vi.mock('../../src/services/api-usage-fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/api-usage-fallback')>();
  return {
    ...actual,
    rethrowAiUsageFailClosedError: (error: any) => {
    if (error?.name === 'ApiUsagePersistenceError'
      || error?.code === 'AI_USAGE_PERSISTENCE_FAILED'
      || error?.name === 'AiBudgetError') throw error;
    },
  };
});

vi.mock('../../src/services/content-token-artifact-store', () => ({
  persistContentArtifacts: (...args: unknown[]) => mockPersistContentArtifacts(...args),
  getContentSourcePackage: (...args: unknown[]) => mockGetContentSourcePackage(...args),
  getContentResearchArtifact: (...args: unknown[]) => mockGetContentResearchArtifact(...args),
  recordContentVariantFeedback: (...args: unknown[]) => mockRecordContentVariantFeedback(...args),
  listRecentContentIdeaMemory: (...args: unknown[]) => mockListRecentContentIdeaMemory(...args),
}));

vi.mock('../../src/services/content-workspace-capture', () => ({
  saveGeneratedScriptToWorkspace: (...args: unknown[]) => mockSaveGeneratedScriptToWorkspace(...args),
}));

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(
  body: any,
  path = '/script',
  headers: Record<string, string> = {},
  method = 'POST',
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
    body,
    userId: 12,
    tenantId: 12,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

async function dispatch(
  body: any,
  path = '/script',
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<MockRes> {
  const { contentRoutes } = await import('../../src/api/routes/content');
  const router = contentRoutes();
  const req = mockReq(body, path, headers, method);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });
  for (let i = 0; i < 5 && res.body == null; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return res;
}

describe('Content API — script duration presets', () => {
  beforeEach(() => {
    mockGetScript.mockClear();
    mockCompleteOneShotWithFallback.mockClear();
    mockCompleteOneShotWithSearch.mockClear();
    mockCompleteOneShotWithOpenAIWebSearch.mockClear();
    mockIsOpenAIConfigured.mockReset();
    mockIsOpenAIConfigured.mockReturnValue(false);
    mockPersistContentArtifacts.mockClear();
    mockGetContentSourcePackage.mockClear();
    mockGetContentResearchArtifact.mockClear();
    mockSaveGeneratedScriptToWorkspace.mockClear();
    mockRecordContentVariantFeedback.mockClear();
    mockWithAiBudgetReservation.mockClear();
    mockGetAllKnowledge.mockClear();
    mockListRecentContentIdeaMemory.mockClear();
    mockResolveScriptTopicContext.mockClear();
    mockBuildAuthorizedContentReferenceContext.mockClear();
    mockBuildContentCreativeProfileContext.mockClear();
    mockAssessContentNovelty.mockClear();
    mockAssertContentLiveEvalSyntheticRuntimeScope.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the governed live-eval route synthetic, non-persistent, and cache-bypassed', async () => {
    vi.stubEnv('CONTENT_LIVE_EVAL_ENABLED', '1');
    vi.stubEnv('NEXUS_CONTENT_LIVE_EVAL_RUNTIME', '1');
    const scenario = CONTENT_LIVE_EVAL_CORPUS[0];
    mockGetScript.mockResolvedValueOnce({
      topic: scenario.topic,
      script: 'A practical creator workflow with three useful steps and one clear next action.',
      hook: 'Turn rough notes into a useful plan.',
      title_options: ['A useful weekly plan', 'Three practical creator steps'],
      sources_used: [{ title: 'Synthetic source', url: 'https://example.invalid/source', source_type: 'test', relevance_note: 'Synthetic only' }],
      estimated_duration: '45 seconds',
      duration_ms: 1200,
      hashtags: [],
      caption: 'Synthetic evaluation caption.',
      cta: 'Choose one next action.',
      degraded: false,
      warnings: [],
      cache_status: 'fresh',
    });
    const headers = {
      'x-nexus-content-live-eval-opt-in': CONTENT_LIVE_EVAL_OPT_IN,
      'x-nexus-content-live-eval-run-id': 'content-live-eval-route-20260719',
      'x-nexus-content-live-eval-budget-usd': '1.00',
      'x-nexus-content-live-eval-scenario-id': scenario.id,
    };

    const response = await dispatch({
      topic: scenario.topic,
      niche: scenario.niche,
      format: scenario.format,
      targetDurationSeconds: scenario.targetDurationSeconds,
      language: scenario.language,
      mode: 'standard',
      renderMode: 'structured',
      scriptStyle: 'detailed',
      forceRefresh: true,
      saveToIdeas: false,
    }, '/script', headers);

    expect(response.statusCode).toBe(200);
    expect(mockGetAllKnowledge).not.toHaveBeenCalled();
    expect(mockAssertContentLiveEvalSyntheticRuntimeScope).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      runId: 'content-live-eval-route-20260719',
    }));
    expect(mockResolveScriptTopicContext).not.toHaveBeenCalled();
    expect(mockBuildAuthorizedContentReferenceContext).not.toHaveBeenCalled();
    expect(mockBuildContentCreativeProfileContext).not.toHaveBeenCalled();
    expect(mockAssessContentNovelty).not.toHaveBeenCalled();
    expect(mockListRecentContentIdeaMemory).not.toHaveBeenCalled();
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
    expect(mockGetScript.mock.calls[0]?.[17]).toEqual({
      cache: 'bypass',
      intelligenceSignals: 'bypass',
    });
    expect(mockWithAiBudgetReservation.mock.calls[0]?.[0]).toMatchObject({
      baseCategory: 'content_live_eval',
      jobName: `content_live_eval:${scenario.id}`,
      hardRunCostLimitUsd: 1,
      hardJobCostLimitUsd: 0.2,
    });
  });

  it('rejects unsupported short durations', async () => {
    const response = await dispatch({
      topic: 'Fast AI automation tip',
      format: 'Reel',
      targetDurationSeconds: 20,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toContain('15, 30, 45, or 60 seconds');
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('localizes invalid script format validation for Portuguese requests', async () => {
    const response = await dispatch(
      {
        topic: 'Produto solo com vibe coding',
        format: 'podcast',
      },
      '/script',
      { 'x-language': 'pt-BR' },
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toBe('o formato deve ser YouTube ou Reel');
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('rejects unsupported YouTube duration presets', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 12,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toContain('8, 10, or 15');
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('sanitizes script generation failures instead of leaking backend internals', async () => {
    mockGetScript.mockRejectedValueOnce(new Error('Gemini pipeline exploded for tenant=12'));

    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 8,
      forceRefresh: true,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('INTERNAL');
    expect(response.body.error.message).toBe('Script generation failed');
    expect(JSON.stringify(response.body)).not.toContain('Gemini pipeline exploded');
  });

  it('forwards script style and scoped Voice DNA memory into script generation', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 8,
      scriptStyle: 'bullets',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(mockGetScript).toHaveBeenCalled();
    const args = mockGetScript.mock.calls.at(-1) ?? [];
    expect(args[5]).toContain('[brand_voice] Direct founder voice.');
    expect(args[5]).toContain('[hook_style] Open with a misconception.');
    expect(args[11]).toBe('bullets');
    expect(args[15]).toBe(12);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 12,
        requestSource: 'interactive',
        baseCategory: 'content_engine_script_draft',
        jobName: 'content_script_generate',
      }),
      expect.any(Function),
    );
  });

  it('defaults script generation to draft-first metadata and low usage impact', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 8,
      forceRefresh: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    const args = mockGetScript.mock.calls.at(-1) ?? [];
    expect(args[1]).toBe('general');
    expect(args[4]).toBe('draft');
    expect(response.body.data.generationMode).toBe('draft');
    expect(response.body.data.usageImpact).toBe('low');
    expect(response.body.data.contentCost).toBeTruthy();
    expect(response.body.data.promptBudget).toBeTruthy();
    expect(response.body.data.research.route).toBe('fresh_compact');
    expect(response.body.data.research.sourcePackageId).toBeUndefined();
    expect(response.body.data.research.researchArtifactId).toBeUndefined();
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
    expect(response.body.data.requestedMode).toBe('draft');
    expect(response.body.data.appliedMode).toBe('draft');
    expect(response.body.data.downgradeReason).toBe('none');
    expect(response.body.data.expandOptions.map((option: any) => option.action)).toContain('expand_full');
  });

  it('persists generated scripts when the iOS saveToIdeas flag is set', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.savedIdea).toEqual(expect.objectContaining({
      saved: true,
      topic: 'Test topic',
      variantKind: 'script',
      accepted: false,
      approvalStatus: 'draft',
      learningApplied: false,
      sourcePackageId: null,
      workspace: {
        schemaVersion: 'content-workspace-capture-v1',
        itemId: 451,
        artifactId: 452,
        revisionId: 453,
        workflowVersion: 2,
        replayed: false,
      },
    }));
    expect(response.body.data.savedIdea.variantTextChars).toBe(response.body.data.script.length);
    expect(mockSaveGeneratedScriptToWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 12, userId: 12 },
      topic: response.body.data.topic,
      format: 'YouTube',
      scriptText: response.body.data.script,
      captureOrigin: 'script_generation',
    }));
    expect(mockRecordContentVariantFeedback).not.toHaveBeenCalled();
  });

  it('persists the complete engine script including a long tail sentinel', async () => {
    const fullEngineScript = [
      ...Array.from({ length: 24 }, (_, index) => `Section ${index + 1}: preserve this complete generated paragraph.`),
      'TAIL_SENTINEL_SAVED_SCRIPT_INTEGRITY_91D2',
    ].join('\n');
    mockGetScript.mockResolvedValueOnce({
      topic: 'Lossless saved script',
      script: fullEngineScript,
      hook: 'Preserve the entire generated script.',
      title_options: ['Lossless script'],
      sources_used: [],
      estimated_duration: '10:00',
      duration_ms: 1200,
      hashtags: ['#integrity'],
      caption: 'Complete script.',
      cta: 'Save this.',
      degraded: false,
      warnings: [],
    });

    const response = await dispatch({
      topic: 'Lossless saved script',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.script).toBe(fullEngineScript);
    expect(response.body.data.script).toContain('TAIL_SENTINEL_SAVED_SCRIPT_INTEGRITY_91D2');
    expect(mockSaveGeneratedScriptToWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      scriptText: fullEngineScript,
    }));
  });

  it('withholds blocked engine output and never auto-saves or returns the raw text', async () => {
    const blockedEngineScript = 'RAW_PROVIDER_OUTPUT\nKeep this exact evidence for review.';
    mockGetScript.mockResolvedValueOnce({
      topic: 'Blocked output review',
      script: blockedEngineScript,
      hook: 'Review this output.',
      title_options: ['Blocked output'],
      sources_used: [],
      estimated_duration: '8:00',
      duration_ms: 1200,
      hashtags: [],
      caption: '',
      cta: 'Review this.',
      degraded: false,
      warnings: [],
    });

    const response = await dispatch({
      topic: 'Blocked output review',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'CONTENT_SCRIPT_OUTPUT_BLOCKED',
        details: {
          reasonCodes: ['raw_script_artifact_blocked'],
          displayWithheld: true,
          retryable: true,
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(blockedEngineScript);
    expect(JSON.stringify(response.body)).not.toContain('RAW_PROVIDER_OUTPUT');
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });

  it('withholds Spanish engine output before artifact or workspace persistence', async () => {
    const leakedScript = 'Aquí tienes un guion completo para organizar tu mañana sin estrés.';
    mockGetScript.mockResolvedValueOnce({
      topic: 'Historical Spanish-authored topic',
      script: leakedScript,
      hook: '¿Quieres transformar tus hábitos desde esta mañana?',
      title_options: ['Cómo organizar tu mañana'],
      sources_used: [{ title: 'Public source', url: 'https://example.com/source' }],
      estimated_duration: '8:00',
      duration_ms: 1200,
      hashtags: ['#hábitos'],
      caption: 'Una rutina clara para empezar bien.',
      cta: 'Guarda este guion.',
      degraded: false,
      warnings: [],
      cache_status: 'fresh',
    });

    const response = await dispatch({
      topic: 'Cómo organizar tu mañana',
      language: 'es-419',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    }, '/script', { 'x-language': 'es-419' });

    expect(mockGetScript).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(502);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_LOCALE_MISMATCH',
      details: {
        contentMutationApplied: false,
        displayWithheld: true,
        retryable: true,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(leakedScript);
    expect(JSON.stringify(response.body)).not.toContain('Aquí tienes');
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });

  it('maps an engine output-language rejection to the safe 502 contract', async () => {
    mockGetScript.mockRejectedValueOnce(
      new ContentOutputLanguageMismatchError('en', 'es', 'content-engine-script'),
    );

    const response = await dispatch({
      topic: 'Build a reliable morning workflow',
      language: 'en-US',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    }, '/script', { 'x-language': 'en-US' });

    expect(response.statusCode).toBe(502);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_LOCALE_MISMATCH',
      details: {
        contentMutationApplied: false,
        displayWithheld: true,
        retryable: true,
      },
    });
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });

  it('withholds Spanish generated metadata before source or workspace persistence', async () => {
    mockGetScript.mockResolvedValueOnce({
      topic: 'Reliable content workflow',
      script: 'This complete English script explains one concrete workflow and action.',
      hook: 'Start with the measurable result.',
      title_options: ['A reliable content workflow'],
      sources_used: [{
        title: 'Raw third-party source title',
        url: 'https://example.com/source',
        relevance_note: 'Aquí tienes la explicación completa.',
      }],
      estimated_duration: '8:00',
      duration_ms: 1200,
      warnings: ['Aquí tienes una advertencia importante.'],
      expand_options: [{
        id: 'expand',
        label: 'Cómo mejorar el guion',
        action: 'expand_full',
      }],
    });

    const response = await dispatch({
      topic: 'Reliable content workflow',
      language: 'en-US',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    }, '/script', { 'x-language': 'en-US' });

    expect(response.statusCode).toBe(502);
    expect(response.body.error.code).toBe('CONTENT_SCRIPT_LOCALE_MISMATCH');
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });

  it('does not persist source artifacts before final public response locale validation', async () => {
    mockGetScript.mockResolvedValueOnce({
      topic: 'Reliable content workflow',
      script: 'This complete English script explains one concrete workflow and action.',
      hook: 'Start with the measurable result.',
      title_options: ['A reliable content workflow'],
      sources_used: [{
        title: 'Raw third-party source title',
        url: 'https://www.w3.org/TR/WCAG22/',
        source_type: 'article',
        relevance_note: 'A current source for the workflow.',
      }],
      estimated_duration: '8:00',
      duration_ms: 1200,
      warnings: [],
      cache_status: 'fresh',
    });

    const response = await dispatch({
      topic: 'Reliable content workflow',
      niche: 'productividad',
      language: 'en-US',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    }, '/script', { 'x-language': 'en-US' });

    expect(response.statusCode).toBe(502);
    expect(response.body.error.code).toBe('CONTENT_SCRIPT_LOCALE_MISMATCH');
    expect(response.body.error.details.contentMutationApplied).toBe(false);
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });

  it('fails closed on malformed generated display-field shapes', async () => {
    mockGetScript.mockResolvedValueOnce({
      topic: 'Reliable content workflow',
      script: 'This complete English script explains one concrete workflow and action.',
      hook: 'Start with the measurable result.',
      title_options: ['A reliable content workflow'],
      sources_used: [],
      hashtags: [{ text: 'Aquí tienes etiquetas' }] as any,
      caption: { text: 'Aquí tienes la descripción' } as any,
      estimated_duration: '8:00',
      duration_ms: 1200,
    });

    const response = await dispatch({
      topic: 'Reliable content workflow',
      language: 'en-US',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    }, '/script', { 'x-language': 'en-US' });

    expect(response.statusCode).toBe(502);
    expect(response.body.error.code).toBe('CONTENT_SCRIPT_LOCALE_MISMATCH');
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });

  it('localizes deterministic response fields before saving a Portuguese script', async () => {
    mockGetScript.mockResolvedValueOnce({
      topic: 'Rotina de conteúdo',
      script: 'Comece pelo resultado concreto. Mostre uma fonte e um exemplo. Termine com uma ação simples.',
      hook: '',
      title_options: ['Uma rotina de conteúdo fiável'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 1200,
      warnings: [],
    });

    const response = await dispatch({
      topic: 'Rotina de conteúdo',
      language: 'pt-BR',
      format: 'Reel',
      maxDurationMinutes: 1,
      saveToIdeas: true,
    }, '/script', { 'x-language': 'pt-BR' });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.cta).not.toMatch(/\b(?:save|pick)\b/i);
    expect(mockSaveGeneratedScriptToWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        cta: expect.not.stringMatching(/\b(?:save|pick)\b/i),
      }),
    );
  });

  it('does not auto-save degraded fallback generations as approved ideas', async () => {
    mockGetScript.mockResolvedValueOnce({
      topic: 'Fallback topic',
      script: '[0:00] Fallback script',
      hook: 'Fallback hook',
      title_options: ['Fallback title'],
      sources_used: [{
        title: '[Mock] fallback source',
        url: 'https://example.com/web/fallback',
        source_type: 'article',
        relevance_note: 'Mock source',
      }],
      estimated_duration: '8:00',
      duration_ms: 10,
      hashtags: [],
      caption: '',
      cta: 'Review before publishing.',
      degraded: true,
      warnings: ['AI generation was unavailable; returned a fallback draft.'],
      cache_status: 'fallback',
      quality_score: 95,
    });

    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 8,
      saveToIdeas: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.degraded).toBe(true);
    expect(response.body.data.qualityScore).toBeLessThanOrEqual(49);
    expect(response.body.data.scriptQuality).toBeNull();
    expect(response.body.data.sourcesUsed).toEqual([]);
    expect(response.body.data.savedIdea).toEqual(expect.objectContaining({
      saved: false,
      accepted: false,
      reason: 'review_required_degraded_generation',
    }));
    expect(mockSaveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
    expect(mockPersistContentArtifacts).not.toHaveBeenCalled();
  });

  it('does not label recovered fresh metadata parsing as provider fallback', async () => {
    mockGetScript.mockResolvedValueOnce({
      topic: 'Open-water panic breathing reset',
      script: 'First-time triathlete in open water? That sudden gasp for air can feel like your race is over. Stop, exhale twice, and restart with bubbles before breath. Practice the reset after a hard pool 25 so race-day panic has a familiar exit ramp.',
      hook: 'First-time triathlete in open water? That sudden gasp for air can feel like your race is over.',
      title_options: ['Open-water panic reset', 'Bubbles before breath', 'Fix panic breathing fast'],
      sources_used: [{
        title: 'USA Triathlon open water swim safety',
        url: 'https://www.usatriathlon.org/safety/open-water-swimming',
        source_type: 'article',
        relevance_note: 'Open-water safety cue source.',
      }],
      estimated_duration: '0:60',
      duration_ms: 1800,
      hashtags: ['#triathlon', '#openwaterswim'],
      caption: 'Practice the panic reset before race day.',
      cta: 'Save this and test it after your next hard pool 25.',
      degraded: false,
      warnings: ['Script metadata was omitted; fallback metadata was derived.'],
      cache_status: 'fresh',
      quality_score: 88,
    });

    const response = await dispatch({
      topic: 'Open-water panic breathing reset',
      format: 'Reel',
      targetDurationSeconds: 60,
      saveToIdeas: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.degraded).toBe(false);
    expect(response.body.data.qualityScore).toBeLessThanOrEqual(49);
    expect(response.body.data.warnings).toContain('Script metadata was omitted; fallback metadata was derived.');
    expect(response.body.data.warnings).not.toContain('Model fallback output needs human review before publishing.');
    expect(response.body.data.savedIdea).toEqual(expect.objectContaining({
      saved: true,
      accepted: false,
      approvalStatus: 'draft',
      learningApplied: false,
    }));
    expect(mockSaveGeneratedScriptToWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'Open-water panic breathing reset',
    }));
  });

  it('returns persisted source packages and research artifacts through tenant-scoped routes', async () => {
    const sourcePackage = await dispatch({}, '/source-packages/sp_1234567890abcdef_abcdef1234567890', {}, 'GET');
    expect(sourcePackage.statusCode).toBe(200);
    expect(sourcePackage.body.ok).toBe(true);
    expect(sourcePackage.body.data.sourceSummary).toEqual(['Stored compact source.']);
    expect(mockGetContentSourcePackage).toHaveBeenCalledWith(
      { tenantId: 12, userId: 12 },
      'sp_1234567890abcdef_abcdef1234567890',
    );

    const researchArtifact = await dispatch({}, '/research-artifacts/ra_1234567890abcdef_abcdef1234567890', {}, 'GET');
    expect(researchArtifact.statusCode).toBe(200);
    expect(researchArtifact.body.ok).toBe(true);
    expect(researchArtifact.body.data.claims).toEqual(['Stored compact claim.']);
    expect(mockGetContentResearchArtifact).toHaveBeenCalledWith(
      { tenantId: 12, userId: 12 },
      'ra_1234567890abcdef_abcdef1234567890',
    );
  });

  it('rejects unsupported content topics before spending AI tokens', async () => {
    const response = await dispatch({
      topic: 'Show me how to hack account access and steal private files',
      format: 'YouTube',
      maxDurationMinutes: 8,
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('CONTENT_UNSUPPORTED_TOPIC');
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('requires explicit review acknowledgement for high-risk topics before generation', async () => {
    const response = await dispatch({
      topic: 'Should I take ibuprofen for migraines?',
      format: 'YouTube',
      maxDurationMinutes: 8,
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('CONTENT_HIGH_RISK_REVIEW_REQUIRED');
    expect(response.body.error.details.acknowledgeField).toBe('highRiskAcknowledged');
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('downgrades acknowledged high-risk requests to draft and explains the downgrade', async () => {
    const response = await dispatch({
      topic: 'Should I take ibuprofen for migraines?',
      format: 'YouTube',
      maxDurationMinutes: 8,
      mode: 'deep',
      highRiskAcknowledged: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    const args = mockGetScript.mock.calls.at(-1) ?? [];
    expect(args[4]).toBe('draft');
    expect(response.body.data.requestedMode).toBe('deep');
    expect(response.body.data.appliedMode).toBe('draft');
    expect(response.body.data.downgradeReason).toBe('high_risk_draft_only');
    expect(response.body.data.research.route).toBe('high_risk_review');
  });

  it('surfaces feature-flag downgrades instead of silently changing modes', async () => {
    vi.stubEnv('CONTENT_DISABLE_DEEP_RESEARCH', 'true');

    const response = await dispatch({
      topic: 'latest creator tools today',
      format: 'YouTube',
      maxDurationMinutes: 8,
      mode: 'deep',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    const args = mockGetScript.mock.calls.at(-1) ?? [];
    expect(args[4]).toBe('draft');
    expect(response.body.data.requestedMode).toBe('deep');
    expect(response.body.data.appliedMode).toBe('draft');
    expect(response.body.data.downgradeReason).toBe('deep_research_disabled');
  });

  it('honors the quality-audit kill switch for route-level quality warnings', async () => {
    vi.stubEnv('CONTENT_DISABLE_MODEL_QUALITY_AUDIT', 'true');

    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 8,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.qualityWarnings).not.toContain('Draft needs expansion before publishing.');
  });

  it('expands an existing draft through the cheap edit route without rerunning script research', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      script: 'Draft hook and outline.',
      action: 'expand_full',
      sourceSummary: ['Prior compact source package.'],
    }, '/script/expand');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.script).toBe('Expanded or rewritten script body.');
    expect(response.body.data.editPatch).toEqual(expect.objectContaining({
      contractVersion: 'content-script-edit.v1',
      status: 'proposed',
      applied: false,
      operation: 'expand',
      action: 'expand_full',
      applyMode: 'replace_document',
      target: { kind: 'document', id: 'script' },
      proposedText: 'Expanded or rewritten script body.',
      baseScriptCharCount: 'Draft hook and outline.'.length,
      baseContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(response.body.data.requestedMode).toBe('expand');
    expect(response.body.data.appliedMode).toBe('expand');
    expect(response.body.data.research.route).toBe('reused_research');
    expect(response.body.data.research.sourceSummary).toEqual(['Prior compact source package.']);
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(mockGetScript).not.toHaveBeenCalled();
    expect(mockWithAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({ baseCategory: 'content_script_expand', jobName: 'content_script_expand' }),
      expect.any(Function),
    );
  });

  it('rewrites an existing draft through the cheap edit route without rerunning script generation', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      script: 'Draft hook and outline.',
      action: 'rewrite_hook',
      instruction: 'Make it punchier',
      sourceSummary: ['Prior compact source package.'],
    }, '/script/rewrite');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.script).toBe('Draft hook and outline.');
    expect(response.body.data.editPatch).toEqual(expect.objectContaining({
      contractVersion: 'content-script-edit.v1',
      status: 'proposed',
      applied: false,
      operation: 'rewrite',
      action: 'rewrite_hook',
      applyMode: 'replace_field',
      target: { kind: 'field', id: 'hook' },
      proposedText: 'Expanded or rewritten script body.',
      baseScriptCharCount: 'Draft hook and outline.'.length,
      baseContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(response.body.data.requestedMode).toBe('rewrite');
    expect(response.body.data.appliedMode).toBe('rewrite');
    expect(response.body.data.editState).toBe('proposed');
    expect(response.body.data.contentMutationApplied).toBe(false);
    expect(response.body.data.research.route).toBe('reused_research');
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(mockGetScript).not.toHaveBeenCalled();
    expect(mockWithAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({ baseCategory: 'content_script_rewrite', jobName: 'content_script_rewrite' }),
      expect.any(Function),
    );
  });

  it('binds retired Spanish edit requests to an explicit English provider contract', async () => {
    const response = await dispatch({
      topic: 'Cómo construir un producto SaaS',
      script: 'Este borrador histórico fue escrito por el usuario.',
      action: 'rewrite_hook',
      instruction: 'Hazlo más directo',
    }, '/script/rewrite', { 'x-language': 'es-419' });

    expect(response.statusCode).toBe(200);
    const systemPrompt = String(mockCompleteOneShotWithFallback.mock.calls.at(-1)?.[0] ?? '');
    expect(systemPrompt).toContain('Reply only in English.');
    expect(systemPrompt).toContain('Do not emit Spanish output.');
    expect(systemPrompt).not.toContain('Use the user language.');
  });

  it('rejects a Spanish edit result under the resolved English contract without another provider call', async () => {
    mockCompleteOneShotWithFallback.mockResolvedValueOnce({
      text: 'Aquí tienes la versión revisada con un título más directo y una llamada a la acción.',
      provider: 'gemini',
    });

    const response = await dispatch({
      topic: 'Cómo construir un producto SaaS',
      script: 'Historical user-authored draft.',
      action: 'rewrite_hook',
      instruction: 'Hazlo más directo',
    }, '/script/rewrite', { 'x-language': 'es-419' });

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(502);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_EDIT_LOCALE_MISMATCH',
      details: { originalPreserved: true },
    });
    expect(JSON.stringify(response.body)).not.toContain('Aquí tienes');
  });

  it('rejects a short Iberian acknowledgement under the resolved English edit contract', async () => {
    mockCompleteOneShotWithFallback.mockResolvedValueOnce({
      text: 'Entendido.',
      provider: 'gemini',
    });

    const response = await dispatch({
      topic: 'How to build a SaaS product',
      script: 'Historical user-authored draft.',
      action: 'rewrite_hook',
      instruction: 'Make it more direct',
    }, '/script/rewrite', { 'x-language': 'en-US' });

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(502);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_EDIT_LOCALE_MISMATCH',
      details: { originalPreserved: true },
    });
    expect(JSON.stringify(response.body)).not.toContain('Entendido');
  });

  it('returns section expansion as a proposal while preserving the full legacy script field', async () => {
    const originalScript = 'Intro stays here.\nBody and CTA must survive.';
    mockCompleteOneShotWithFallback.mockResolvedValueOnce({
      text: 'Expanded intro proposal only.',
      provider: 'gemini',
    });

    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      script: originalScript,
      action: 'expand_section:intro',
    }, '/script/expand');

    expect(response.statusCode).toBe(200);
    expect(response.body.data.script).toBe(originalScript);
    expect(response.body.data.editPatch).toEqual(expect.objectContaining({
      contractVersion: 'content-script-edit.v1',
      status: 'proposed',
      applied: false,
      operation: 'expand',
      applyMode: 'replace_section',
      target: { kind: 'section', id: 'intro' },
      proposedText: 'Expanded intro proposal only.',
      baseContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(response.body.data.contentMutationApplied).toBe(false);
  });

  it('rejects oversized script input without truncating it or spending edit tokens', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      script: `Keep all of this:${'x'.repeat(20_001)}`,
      action: 'rewrite_hook',
    }, '/script/rewrite');

    expect(response.statusCode).toBe(413);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_INPUT_TOO_LARGE',
      details: {
        field: 'script',
        maxChars: 20_000,
        truncated: false,
      },
    });
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('rejects oversized provider edit output and preserves the original script', async () => {
    mockCompleteOneShotWithFallback.mockResolvedValueOnce({
      text: 'y'.repeat(24_001),
      provider: 'gemini',
    });

    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      script: 'Original script must remain authoritative.',
      action: 'rewrite',
    }, '/script/rewrite');

    expect(response.statusCode).toBe(502);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCRIPT_EDIT_OUTPUT_TOO_LARGE',
      details: {
        maxChars: 24_000,
        actualChars: 24_001,
        originalPreserved: true,
      },
    });
  });

  it('rejects unsupported edit topics before spending edit tokens', async () => {
    const response = await dispatch({
      topic: 'Show me how to hack account access and steal private files',
      script: 'Draft hook and outline.',
      action: 'rewrite_hook',
    }, '/script/rewrite');

    expect(response.statusCode).toBe(422);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('CONTENT_UNSUPPORTED_TOPIC');
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('refreshes research explicitly without expanding or rewriting the current script', async () => {
    const response = await dispatch({
      topic: 'latest creator tools today',
      script: 'Keep this current script.',
    }, '/script/research-refresh');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.script).toBe('Keep this current script.');
    expect(response.body.data.requestedMode).toBe('research_refresh');
    expect(response.body.data.research.route).toBe('fresh_compact');
    expect(response.body.data.research.sourceSummary.join(' ')).toContain('Source note');
    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(mockGetScript).not.toHaveBeenCalled();
    expect(mockWithAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({ baseCategory: 'content_research_refresh', jobName: 'content_research_refresh' }),
      expect.any(Function),
    );
  });

  it('binds retired Spanish research refresh requests to explicit English source notes', async () => {
    const response = await dispatch({
      topic: 'Herramientas actuales para creadores',
      script: 'Keep this historical user-authored script.',
    }, '/script/research-refresh', { 'x-language': 'es-419' });

    expect(response.statusCode).toBe(200);
    const systemPrompt = String(mockCompleteOneShotWithSearch.mock.calls.at(-1)?.[0] ?? '');
    const userPrompt = String(mockCompleteOneShotWithSearch.mock.calls.at(-1)?.[1] ?? '');
    expect(systemPrompt).toContain('Return source notes only in English.');
    expect(userPrompt).toContain('Write every source note in English.');
    expect(userPrompt).not.toContain('in the user language');
  });

  it('rejects Spanish research notes under the resolved English contract without retrying', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Aquí están las fuentes públicas actuales y las notas más importantes para este tema.',
      sources: ['https://example.com/source-a'],
    });

    const response = await dispatch({
      topic: 'Herramientas actuales para creadores',
      script: 'Keep this historical user-authored script.',
    }, '/script/research-refresh', { 'x-language': 'es-419' });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(502);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_RESEARCH_LOCALE_MISMATCH',
      details: { originalPreserved: true },
    });
    expect(JSON.stringify(response.body)).not.toContain('Aquí están');
  });

  it('refreshes through bounded OpenAI search when Gemini maximum cost does not fit', async () => {
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithSearch.mockRejectedValueOnce(Object.assign(
      new Error('AI_DAILY_LIMIT_REACHED'),
      { name: 'AiBudgetError', decision: { code: 'AI_DAILY_LIMIT_REACHED', window: 'daily' } },
    ));

    const response = await dispatch({
      topic: 'latest creator tools today',
      script: 'Keep this current script.',
    }, '/script/research-refresh');

    expect(response.statusCode).toBe(200);
    expect(response.body.data.operationTrace.provider).toBe('openai-web-search');
    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
  });

  it('localizes topic-generation format validation for Portuguese requests', async () => {
    const response = await dispatch(
      { format: 'podcast' },
      '/topics/generate',
      { 'x-language': 'pt-BR' },
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toBe('o formato deve ser "reel" ou "youtube"');
  });

  it('content route resolves and forwards first-party topic context into canonical script generation', async () => {
    const topicContext = {
      pipelineId: 451,
      niche: 'creator operations',
      hookIdea: 'The workflow most creators skip',
      whyNow: 'New first-party workflow evidence is available',
      angleTag: 'proof',
      sourceJob: 'content_agency',
    };
    mockResolveScriptTopicContext.mockReturnValueOnce(topicContext);

    const body = {
      topic: '  Build a repeatable creator workflow  ',
      format: 'YouTube',
      maxDurationMinutes: 8,
      workspaceItemId: 451,
      niche: 'untrusted request niche',
    };
    const response = await dispatch(body);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(mockResolveScriptTopicContext).toHaveBeenCalledWith(12, body, undefined, 12);
    const engineArgs = mockGetScript.mock.calls.at(-1) ?? [];
    expect(engineArgs[0]).toBe('Build a repeatable creator workflow');
    expect(engineArgs[1]).toBe('creator operations');
    expect(engineArgs[2]).toBe(8);
    expect(engineArgs[9]).toBe(480);
    expect(engineArgs[10]).toEqual(topicContext);
    expect(engineArgs[15]).toBe(12);
  });
});
