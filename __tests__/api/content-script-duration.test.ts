import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import fs from 'fs';
import path from 'path';

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
const mockStoreScript = vi.fn(() => 451);
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
  getUserLanguage: vi.fn(() => 'pt-BR'),
  getUserLanguageById: vi.fn(() => 'pt-BR'),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
}));

vi.mock('../../src/state/content-references', () => ({
  getKnowledgeByCategory: vi.fn(() => null),
  getAllKnowledge: vi.fn(() => [
    { category: 'brand_voice', synthesized_text: 'Direct founder voice.' },
    { category: 'hook_style', synthesized_text: 'Open with a misconception.' },
  ]),
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

vi.mock('../../src/services/content-engine', () => ({
  getScript: (...args: unknown[]) => {
    const providerBoundary = args[16] as ((providerCall: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const providerCall = () => mockGetScript(...args.slice(0, 16));
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
  listRecentContentIdeaMemory: vi.fn(() => [
    { topic: 'Old SaaS angle', hook: 'The costly myth', angle: 'proof', format: 'YouTube' },
  ]),
}));

vi.mock('../../src/services/content-learning-store', () => ({
  storeScript: (...args: unknown[]) => mockStoreScript(...args),
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
    mockStoreScript.mockClear();
    mockRecordContentVariantFeedback.mockClear();
    mockWithAiBudgetReservation.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      accepted: true,
      sourcePackageId: null,
      scriptId: 451,
    }));
    expect(response.body.data.savedIdea.variantTextChars).toBe(response.body.data.script.length);
    expect(mockStoreScript).toHaveBeenCalledWith(expect.objectContaining({
      topic: response.body.data.topic,
      format: 'YouTube',
      scriptText: response.body.data.script,
      userId: 12,
      tenantId: 12,
    }));
    expect(mockRecordContentVariantFeedback).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 12,
      userId: 12,
      topic: response.body.data.topic,
      variantText: response.body.data.script,
      sentiment: 'approved',
      variantKind: 'script',
      sourcePackageId: undefined,
    }));
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
    expect(mockStoreScript).not.toHaveBeenCalled();
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
      accepted: true,
    }));
    expect(mockStoreScript).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(response.body.data.script).toBe('Expanded or rewritten script body.');
    expect(response.body.data.requestedMode).toBe('rewrite');
    expect(response.body.data.appliedMode).toBe('rewrite');
    expect(response.body.data.research.route).toBe('reused_research');
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(mockGetScript).not.toHaveBeenCalled();
    expect(mockWithAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({ baseCategory: 'content_script_rewrite', jobName: 'content_script_rewrite' }),
      expect.any(Function),
    );
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
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content-script-routes.ts'),
      'utf8',
    );
    const contentRouteSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content.ts'),
      'utf8',
    );
    const topicContextSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content-topic-context.ts'),
      'utf8',
    );

    expect(contentRouteSource).toContain("import { registerContentScriptRoutes } from './content-script-routes';");
    expect(contentRouteSource).toContain('registerContentScriptRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);');
    expect(routeSource).toContain("import { resolveScriptTopicContext } from './content-topic-context';");
    expect(routeSource).toContain('const scriptTopicContext = resolveScriptTopicContext(userId, req.body || {}, undefined, tenantId);');
    expect(routeSource).toContain("scriptTopicContext?.niche || niche || 'general'");
    expect(routeSource).toContain('durationPreset.targetDurationSeconds,');
    expect(routeSource).toContain('scriptTopicContext,');
    expect(routeSource).not.toContain('draftFirst=true');
    expect(routeSource).not.toContain('budgetState=${budgetState}');
    expect(routeSource).toContain("Budget enforcement is external to the model and must not shorten, simplify, or reduce delivery quality.");
    expect(topicContextSource).toContain('function resolveScriptTopicContext(');
    expect(topicContextSource).toContain('parseOptionalPositiveId(raw.pipelineId)');
    expect(topicContextSource).toContain('parseOptionalPositiveId(raw.topicFeedbackId)');
    expect(topicContextSource).toContain('parseOptionalPositiveId(raw.ideaId)');
  });
});
