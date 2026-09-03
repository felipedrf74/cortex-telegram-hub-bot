import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const integrationMocks = vi.hoisted(() => ({
  buildAuthorizedContentReferenceContext: vi.fn(),
  getActiveAiBudgetReservationMarker: vi.fn(),
  getAllKnowledge: vi.fn(),
  getCached: vi.fn(),
  getUserLanguage: vi.fn(),
  readSignals: vi.fn(),
  saveGeneratedScriptToWorkspace: vi.fn(),
  setCache: vi.fn(),
  withAiBudgetReservation: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test', classifierModel: 'test-model' },
    app: { timezone: 'Europe/Lisbon' },
    contentEngine: {
      baseUrl: 'http://content-engine.integration:8100',
      enabled: true,
      internalApiSecret: 'integration-secret',
      port: 8100,
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: vi.fn(),
  completeOneShotWithSearch: vi.fn(),
  isGeminiProviderConfigured: vi.fn(() => true),
}));

vi.mock('../../src/services/openai-provider', () => ({
  completeOneShotWithWebSearch: vi.fn(),
  isOpenAIConfigured: vi.fn(() => false),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  getActiveAiBudgetReservationMarker: integrationMocks.getActiveAiBudgetReservationMarker,
  withAiBudgetReservation: integrationMocks.withAiBudgetReservation,
}));

vi.mock('../../src/state/content-references', () => ({
  buildKnowledgePromptBlock: vi.fn(() => ''),
  getAllKnowledge: integrationMocks.getAllKnowledge,
}));

vi.mock('../../src/services/content-reference-context', () => ({
  buildAuthorizedContentReferenceContext:
    integrationMocks.buildAuthorizedContentReferenceContext,
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: integrationMocks.getUserLanguage,
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  readSignals: integrationMocks.readSignals,
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: integrationMocks.getCached,
  setCache: integrationMocks.setCache,
}));

vi.mock('../../src/services/content-workspace-capture', () => ({
  saveGeneratedScriptToWorkspace: integrationMocks.saveGeneratedScriptToWorkspace,
}));

vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: Object.freeze({ contentProxyEnabled: false }),
}));

// Intentionally real: this integration spec exercises the workflow's dynamic
// import through getScript(), buildScriptCacheKey(), and engineFetch().
import { buildScriptCacheKey, type ScriptResponse } from '../../src/services/content-engine';
import { generateScript, type TopicCandidate } from '../../src/services/content-workflow';

const topic: TopicCandidate & { feedbackId: number } = {
  title: 'Scoped creator workflow',
  niche: 'creator systems',
  whyNow: 'Creators need reliable systems now.',
  hookIdea: 'Start with tenant-safe evidence.',
  angleTag: 'operations',
  feedbackId: 73,
};

const engineResponse: ScriptResponse = {
  topic: topic.title,
  script: [
    'Build a reliable creator workflow by starting with clear evidence.',
    'Then organize each decision, explain the tradeoffs, and review the result before publishing.',
  ].join(' '),
  hook: 'Start with clear evidence before you create.',
  title_options: ['Build a Reliable Creator Workflow'],
  sources_used: [{
    title: 'Trusted workflow guide',
    url: 'https://example.com/trusted-workflow',
    source_type: 'web',
    relevance_note: 'This source supports the workflow.',
  }],
  estimated_duration: '8:00',
  duration_ms: 120,
  hashtags: ['#CreatorWorkflow'],
  caption: 'Use this reliable workflow for your next project.',
  cta: 'Save the workflow and review your results.',
  degraded: false,
  warnings: [],
  cache_status: 'miss',
};

describe('content-workflow -> real content-engine integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    integrationMocks.getAllKnowledge.mockReturnValue([]);
    integrationMocks.getCached.mockReturnValue(null);
    integrationMocks.getUserLanguage.mockReturnValue('en-US');
    integrationMocks.readSignals.mockReturnValue([]);
    integrationMocks.saveGeneratedScriptToWorkspace.mockReturnValue({ replayed: true });
    integrationMocks.buildAuthorizedContentReferenceContext.mockReturnValue({
      references: [{
        needsReview: false,
        title: 'Trusted workflow guide',
        url: 'https://example.com/trusted-workflow',
      }],
    });
    integrationMocks.getActiveAiBudgetReservationMarker.mockReturnValue(null);
    integrationMocks.withAiBudgetReservation.mockImplementation(
      async (_request: unknown, providerCall: () => Promise<unknown>) => providerCall(),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves a tenant distinct from the user through the real engine request and cache boundary', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify(engineResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateScript(
      topic,
      'youtube',
      42,
      314,
      { requestSource: 'interactive' },
    );

    const scriptContext = {
      topicFeedbackId: topic.feedbackId,
      niche: topic.niche,
      hookIdea: topic.hookIdea,
      whyNow: topic.whyNow,
      angleTag: topic.angleTag,
    };
    const expectedCacheKey = buildScriptCacheKey(
      topic.title,
      topic.niche,
      8,
      'YouTube',
      undefined,
      'standard',
      null,
      'en-US',
      'structured',
      42,
      scriptContext,
      'detailed',
      undefined,
      314,
    );
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    const requestBody = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;

    expect(result).toEqual(engineResponse);
    expect(requestUrl).toBe('http://content-engine.integration:8100/api/v1/script');
    expect(requestBody).toMatchObject({
      topic: topic.title,
      user_id: 42,
      tenant_id: 314,
    });
    expect(integrationMocks.getCached).toHaveBeenCalledWith(expectedCacheKey);
    expect(integrationMocks.setCache).toHaveBeenCalledWith(
      expectedCacheKey,
      engineResponse,
      24 * 3600,
    );
    expect(expectedCacheKey).toContain('scope:42');
    expect(expectedCacheKey).toContain('tenant:314');
    expect(integrationMocks.buildAuthorizedContentReferenceContext).toHaveBeenCalledWith(42, 314);
    expect(integrationMocks.getAllKnowledge).toHaveBeenCalledWith(42, 314);
    expect(integrationMocks.withAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, requestSource: 'interactive' }),
      expect.any(Function),
    );
    expect(integrationMocks.saveGeneratedScriptToWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { userId: 42, tenantId: 314 } }),
    );
  });

  it('forwards an explicit format-bound runtime instead of treating format as an ideal length', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(engineResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await generateScript(topic, 'youtube', 42, 314, {
      requestSource: 'interactive',
      targetDurationSeconds: 600,
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      format: 'YouTube',
      max_duration_minutes: 10,
      target_duration_seconds: 600,
    });
  });

  it('fails closed when the canonical workspace cannot durably capture the generated script', async () => {
    const persistenceError = Object.assign(new Error('workspace capture unavailable'), {
      code: 'CONTENT_WORKSPACE_WRITE_DISABLED',
    });
    integrationMocks.saveGeneratedScriptToWorkspace.mockImplementationOnce(() => {
      throw persistenceError;
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(engineResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateScript(
      topic,
      'youtube',
      42,
      314,
      { requestSource: 'interactive' },
    )).rejects.toBe(persistenceError);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(integrationMocks.saveGeneratedScriptToWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { userId: 42, tenantId: 314 } }),
    );
  });

  it('forwards workflow cancellation to the real engine HTTP signal', async () => {
    const controller = new AbortController();
    let resolveFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    let forwardedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedSignal = init?.signal ?? undefined;
      resolveFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        const rejectFromAbort = () => reject(forwardedSignal?.reason);
        if (forwardedSignal?.aborted) rejectFromAbort();
        else forwardedSignal?.addEventListener('abort', rejectFromAbort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cancellation = Object.assign(new Error('client disconnected'), {
      name: 'AbortError',
      code: 'CONTENT_ENGINE_CLIENT_DISCONNECTED',
    });

    const execution = generateScript(
      topic,
      'youtube',
      42,
      314,
      { requestSource: 'interactive', abortSignal: controller.signal },
    );
    await fetchStarted;
    controller.abort(cancellation);

    await expect(execution).rejects.toBe(cancellation);
    expect(forwardedSignal).toBeDefined();
    expect(forwardedSignal).not.toBe(controller.signal);
    expect(forwardedSignal?.aborted).toBe(true);
    expect(integrationMocks.setCache).not.toHaveBeenCalled();
    expect(integrationMocks.saveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });

  it('returns and caches the bounded payload-free digest the engine actually compiled', async () => {
    integrationMocks.readSignals.mockReturnValue([
      {
        id: 1,
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { description: 'Lead with the creator workflow constraint.' },
        priority: 'normal',
        consumed_by: [],
        status: 'active',
        created_at: '2026-08-30T10:00:00.000Z',
        expires_at: '2026-09-01T10:00:00.000Z',
        user_id: 42,
        tenant_id: 314,
        confidence: 0.9,
        format_tag: 'youtube',
        pillar_tag: 'creator systems',
        evidence_count: 3,
      },
      {
        id: 2,
        source_agent: 'content.pipeline',
        signal_type: 'pipeline_capacity',
        payload: {},
        priority: 'normal',
        consumed_by: [],
        status: 'active',
        created_at: '2026-08-30T09:00:00.000Z',
        expires_at: '2026-09-01T09:00:00.000Z',
        user_id: 42,
        tenant_id: 314,
        confidence: 0.8,
        format_tag: 'youtube',
        pillar_tag: 'creator systems',
        evidence_count: 2,
      },
    ]);
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({
      ...engineResponse,
      agent_signals_used: [{
        type: 'voice_pattern',
        source: 'voice-evolution',
      }, {
        type: 'retention_pattern',
        source: 'forged-unselected-agent',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateScript(topic, 'youtube', 42, 314);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(requestBody.context_signals).toEqual(expect.arrayContaining([
      {
        type: 'voice_pattern',
        source: 'voice-evolution',
        payload: { description: 'Lead with the creator workflow constraint.' },
      },
      {
        type: 'pipeline_capacity',
        source: 'content.pipeline',
        payload: {},
      },
    ]));
    expect(result.agent_signals_used).toEqual([{
      type: 'voice_pattern',
      source: 'voice-evolution',
    }]);
    expect(integrationMocks.setCache).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agent_signals_used: [{
          type: 'voice_pattern',
          source: 'voice-evolution',
        }],
      }),
      24 * 3600,
    );
    expect(JSON.stringify(result.agent_signals_used)).not.toContain('recommendation');
    expect(result.agent_signals_used).not.toContainEqual({
      type: 'pipeline_capacity',
      source: 'content.pipeline',
    });
    expect(result.agent_signals_used).not.toContainEqual({
      type: 'retention_pattern',
      source: 'forged-unselected-agent',
    });
  });

  it('changes the v9 script cache key when selected agent-signal payload changes', async () => {
    const signal = (recommendation: string) => ({
      id: 1,
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      payload: { description: recommendation },
      priority: 'normal',
      consumed_by: [],
      status: 'active',
      created_at: '2026-08-30T10:00:00.000Z',
      expires_at: '2026-09-01T10:00:00.000Z',
      user_id: 42,
      tenant_id: 314,
      confidence: 0.9,
      format_tag: 'youtube',
      pillar_tag: 'creator systems',
      evidence_count: 3,
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ...engineResponse,
      agent_signals_used: [{ type: 'voice_pattern', source: 'voice-evolution' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    integrationMocks.readSignals.mockReturnValue([signal('First governed recommendation.')]);
    await generateScript(topic, 'youtube', 42, 314);
    const firstKey = String(integrationMocks.setCache.mock.calls.at(-1)?.[0]);

    integrationMocks.readSignals.mockReturnValue([signal('Changed governed recommendation.')]);
    await generateScript(topic, 'youtube', 42, 314);
    const secondKey = String(integrationMocks.setCache.mock.calls.at(-1)?.[0]);

    expect(firstKey).toMatch(/^script-v9:/);
    expect(secondKey).toMatch(/^script-v9:/);
    expect(secondKey).not.toBe(firstKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the server-authored consumed-signal digest on a real engine cache hit', async () => {
    integrationMocks.readSignals.mockReturnValue([{
      id: 7,
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      payload: { description: 'Use concise direct phrasing.' },
      priority: 'normal',
      consumed_by: [],
      status: 'active',
      created_at: '2026-08-30T09:00:00.000Z',
      expires_at: '2026-09-01T09:00:00.000Z',
      user_id: 42,
      tenant_id: 314,
      confidence: 0.8,
      format_tag: 'youtube',
      pillar_tag: 'creator systems',
      evidence_count: 2,
    }]);
    integrationMocks.getCached.mockReturnValue({
      ...engineResponse,
      cache_status: 'hit',
      agent_signals_used: [{
        type: 'voice_pattern',
        source: 'voice-evolution',
      }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateScript(topic, 'youtube', 42, 314);

    expect(integrationMocks.getCached).toHaveBeenCalledWith(expect.stringMatching(/^script-v9:/));
    expect(result.agent_signals_used).toEqual([{
      type: 'voice_pattern',
      source: 'voice-evolution',
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrationMocks.setCache).not.toHaveBeenCalled();
    expect(integrationMocks.saveGeneratedScriptToWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { userId: 42, tenantId: 314 } }),
    );
  });

  it.each([
    ['missing user', 0, 314],
    ['missing tenant', 42, 0],
    ['invalid tenant', 42, 1.5],
  ] as const)('fails closed for %s before entering the engine', async (_label, userId, tenantId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateScript(
      topic,
      'youtube',
      userId,
      tenantId,
      { requestSource: 'interactive' },
    )).rejects.toMatchObject({ code: 'CONTENT_TENANT_SCOPE_REQUIRED' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrationMocks.getCached).not.toHaveBeenCalled();
    expect(integrationMocks.buildAuthorizedContentReferenceContext).not.toHaveBeenCalled();
    expect(integrationMocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(integrationMocks.saveGeneratedScriptToWorkspace).not.toHaveBeenCalled();
  });
});
