import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  setCache: vi.fn(),
}));

vi.mock('../../src/services/cache-store', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cache-store')>(
    '../../src/services/cache-store',
  );
  return {
    ...actual,
    getCached: (...args: unknown[]) => cacheMocks.getCached(...args),
    setCache: (...args: unknown[]) => cacheMocks.setCache(...args),
  };
});

vi.mock('../../src/state/content-creator-profile', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/content-creator-profile')>(
    '../../src/state/content-creator-profile',
  );
  return {
    ...actual,
    getContentCreatorProfile: vi.fn(() => ({
      pillars: [],
      niches: [],
      audience: '',
      platforms: [],
      voiceRules: [],
      preferredFormats: [],
      dislikedTopics: [],
      bannedTopics: [],
      trustedSources: [],
      dislikedSources: [],
      contentGoals: [],
      languagePreference: '',
      voiceExamples: [],
      updatedAt: null,
    })),
  };
});

import {
  buildScriptCacheKey,
  contentEngineApiBaseUrl,
  deepSearch,
  ForwardedAiBudgetError,
  ForwardedContentPolicyError,
  ForwardedLocalInferenceError,
  getCaption,
  getCompetitor,
  getGaps,
  getHooks,
  getHotNews,
  getReaction,
  getReport,
  getRepurpose,
  getScript,
  getSeo,
  getSources,
  getThumbnail,
  getTitles,
  getTrending,
  logFeedback,
} from '../../src/services/content-engine';
import { runWithContext } from '../../src/utils/request-context';

beforeEach(() => {
  cacheMocks.getCached.mockReset();
  cacheMocks.getCached.mockReturnValue(null);
  cacheMocks.setCache.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('content-engine client base URL', () => {
  it.each([undefined, '', '   '])('rejects missing creator niche %j before gap research reaches the engine', async (niche) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getGaps(niche as string)).rejects.toThrow('Content gaps require a non-empty creator niche');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projects retired Spanish and unsupported direct script locales to English cache scope', () => {
    const spanishKey = buildScriptCacheKey(
      'safe topic',
      'general',
      8,
      'YouTube',
      null,
      'draft',
      null,
      'es-ES',
    );
    const unsupportedKey = buildScriptCacheKey(
      'safe topic',
      'general',
      8,
      'YouTube',
      null,
      'draft',
      null,
      'de-DE',
    );

    expect(spanishKey).toContain('lang:en-US');
    expect(unsupportedKey).toContain('lang:en-US');
  });

  it('keys scripts by normalized creator context without exposing private context in the key', () => {
    const privateContext = [
      'Authorized references:',
      '- Private source alpha',
      'Recent content memory:',
      '- Angle one',
    ].join('\n');
    const keyForProfile = (creatorProfile?: string | null) => buildScriptCacheKey(
      'safe topic',
      'general',
      8,
      'YouTube',
      null,
      'draft',
      null,
      'en-US',
      'structured',
      42,
      null,
      'detailed',
      null,
      42,
      null,
      creatorProfile,
    );

    const originalKey = keyForProfile(privateContext);
    const equivalentNormalizedKey = keyForProfile(`  ${privateContext}\n`);
    const changedKey = keyForProfile(privateContext.replace('Angle one', 'Angle two'));
    const removedKey = keyForProfile(null);

    expect(originalKey).toBe(equivalentNormalizedKey);
    expect(changedKey).not.toBe(originalKey);
    expect(removedKey).not.toBe(originalKey);
    expect(originalKey).toMatch(/:profile:[a-f0-9]{64}:/);
    expect(originalKey).not.toContain('Private source alpha');
    expect(originalKey).not.toContain('Angle one');
  });

  it('appends the API prefix to Docker service base URLs', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('does not duplicate the API prefix when callers provide it', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100/api/v1')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('trims trailing slashes before adding the API prefix', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100///')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('reconstructs stable quota errors returned by the Python hop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'AI_DAILY_LIMIT_REACHED',
        message: 'private provider response must not cross',
        details: { window: 'daily', unblocksAt: '2026-07-10T00:00:00.000Z' },
      },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '123' },
    })));

    await expect(getSources('safe topic')).rejects.toMatchObject({
      name: 'ForwardedAiBudgetError',
      code: 'AI_DAILY_LIMIT_REACHED',
      status: 429,
      publicMessage: 'Daily AI quota reached.',
      details: expect.objectContaining({ retryAfterSeconds: 123 }),
    });
  });

  it('does not retry a stable Content Engine quota denial', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'AI_PLAN_REQUIRED',
        message: 'An active paid plan is required.',
        details: { window: 'plan', unblocksAt: null },
      },
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deepSearch('safe topic')).rejects.toBeInstanceOf(ForwardedAiBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not transport-retry an ambiguous creative generation failure without a durable replay key', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connection closed after request dispatch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getHooks('Safe topic', 'general', 3, { language: 'en-US' })).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconstructs public-safe local capacity failures without exposing Python internals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'LOCAL_QUEUE_FULL',
        message: 'private local runtime detail must not cross',
        details: { retryable: true, providerRaw: 'must-not-cross' },
      },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })));

    const error = await getSources('safe topic').catch((caught) => caught) as ForwardedLocalInferenceError;

    expect(error).toBeInstanceOf(ForwardedLocalInferenceError);
    expect(error).toMatchObject({
      code: 'LOCAL_QUEUE_FULL',
      status: 503,
      publicMessage: 'Local inference queue is full.',
      details: { retryable: true },
    });
    expect(error.details).not.toHaveProperty('providerRaw');
  });

  it('reconstructs allowlisted Content policy denials with fixed public text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: {
        error: {
          code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED',
          message: 'provider secret must not cross',
          details: { providerRaw: 'must-not-cross' },
        },
      },
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    })));

    const error = await getSources('medical treatment').catch((caught) => caught) as ForwardedContentPolicyError;

    expect(error).toBeInstanceOf(ForwardedContentPolicyError);
    expect(error).toMatchObject({
      code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED',
      status: 422,
      publicMessage: 'This request requires reviewer-attested authority before content generation.',
      details: { retryable: false },
    });
    expect(error.message).not.toContain('provider secret');
    expect(error.details).not.toHaveProperty('providerRaw');
  });

  it('does not include an unrecognized upstream response body in the HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private provider response', { status: 422 })));

    const error = await getSources('safe topic').catch((caught) => caught) as Error;

    expect(error).toMatchObject({
      name: 'ContentEngineHttpError',
      message: 'Content Engine request failed with HTTP 422.',
    });
    expect(error.message).not.toContain('private provider response');
  });

  it.each([
    ['INTERNAL_ATTRIBUTION_INVALID', 403, 'Signed Content inference scope was rejected.'],
    ['INTERNAL_INFERENCE_ATTRIBUTION_INVALID', 403, 'Signed Content inference scope was rejected.'],
    ['INTERNAL_INFERENCE_ATTRIBUTION_MISMATCH', 403, 'Signed Content inference scope was rejected.'],
    ['ACCOUNT_DELETION_IN_PROGRESS', 409, 'No new Content inference can start while this account is being deleted.'],
  ] as const)('forwards stable Content inference denial %s', async (code, status, publicMessage) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code, message: 'Signed Content inference scope was rejected.' },
    }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(getSources('safe topic')).rejects.toMatchObject({
      name: 'ForwardedLocalInferenceError',
      code,
      status,
      publicMessage,
    });
  });

  it('allowlists forwarded details and clamps oversized Retry-After values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'AI_MONTHLY_LIMIT_REACHED',
        message: 'Monthly AI quota reached.',
        details: {
          window: 'monthly',
          requiredPlan: 'pro',
          monthlyResetAt: '2026-08-01T00:00:00.000Z',
          blockReason: 'private provider message must not cross',
          retryable: 'yes',
          costUsd: 999,
          providerRaw: 'secret',
        },
      },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '999999999' },
    })));

    const error = await getSources('safe topic').catch((caught) => caught) as ForwardedAiBudgetError;

    expect(error.details).toEqual({
      window: 'monthly',
      requiredPlan: 'pro',
      monthlyResetAt: '2026-08-01T00:00:00.000Z',
      retryAfterSeconds: 2_678_400,
    });
  });

  it('rejects unsupported provider script language before the result can be returned or cached', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      topic: 'Safe topic',
      script: 'Aquí tienes el guion completo para organizar todas tus tareas.',
      hook: '¿Quieres empezar ahora?',
      title_options: ['Cómo organizar tus tareas'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      caption: 'Guarda esta guía para mañana.',
      cta: 'Comparte este vídeo con alguien.',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getScript(
      'Safe topic',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'structured',
      42,
      undefined,
      null,
      'detailed',
      false,
      null,
      null,
      42,
    )).rejects.toMatchObject({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'content-engine-script',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cacheMocks.setCache).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'hooks',
      invoke: () => getHooks('Safe topic', 'general', 3, {
        language: 'en-US', format: 'Reel', sourcePackageId: 'sp_safe', sourceSummary: ['Bounded source.'], sourceReuseStatus: 'fresh',
      }),
      response: {
        topic: 'Safe topic', niche: 'general', duration_ms: 1,
        hooks: [{ text: 'Here is the clear opening', trigger_type: 'story', score: 8, why: 'It starts with a concrete moment', sfx: 'none', edit_cue: 'close up' }],
      },
      expected: { format: 'Reel', count: 3 },
    },
    {
      label: 'titles',
      invoke: () => getTitles('Safe topic', 'general', 4, {
        language: 'en-US', platform: 'Instagram', sourcePackageId: 'sp_safe', sourceSummary: ['Bounded source.'], sourceReuseStatus: 'fresh',
      }),
      response: {
        topic: 'Safe topic', duration_ms: 1,
        titles: [{ title: 'A clear launch plan', strategy: 'HOW_TO', score: 80, why: 'It promises a useful plan', char_count: 19 }],
      },
      expected: { platform: 'Instagram', count: 4 },
    },
    {
      label: 'thumbnail',
      invoke: () => getThumbnail('A clear launch plan', 'general', {
        language: 'en-US', topic: 'Safe topic', sourcePackageId: 'sp_safe', sourceSummary: ['Bounded source.'], sourceReuseStatus: 'fresh',
      }),
      response: {
        title: 'A clear launch plan', duration_ms: 1,
        concepts: [{
          layout: 'close_up', background_color: '#112233',
          text_overlay: { main_text: 'Launch With Clarity', font_style: 'bold', color: '#FFFFFF', position: 'center' },
          facial_expression: 'focused', additional_elements: ['simple checklist'], why_it_works: 'It makes the benefit immediately clear',
        }],
      },
      expected: { topic: 'Safe topic' },
    },
    {
      label: 'caption',
      invoke: () => getCaption('Safe topic', 'general', {
        language: 'en-US', sourcePackageId: 'sp_safe', sourceSummary: ['Bounded source.'], sourceReuseStatus: 'fresh',
      }),
      response: { topic: 'Safe topic', caption: 'Build the launch around one clear promise and one useful proof.', hashtags: ['launch'], duration_ms: 1 },
      expected: {},
    },
    {
      label: 'repurpose',
      invoke: () => getRepurpose('Safe topic', 'Source content', 'Newsletter', {
        language: 'en-US', sourcePackageId: 'sp_safe', sourceSummary: ['Bounded source.'], sourceReuseStatus: 'fresh',
      }),
      response: {
        topic: 'Safe topic', duration_ms: 1,
        outputs: [{ format: 'Reel', platform: 'Instagram', content: 'Turn the core promise into one short demonstration.', posting_delay: 'day 1', notes: 'Keep the example concrete.' }],
      },
      expected: { original_format: 'Newsletter', source_content: 'Source content' },
    },
  ])('forwards authenticated selectors and source context through the $label wrapper', async ({ invoke, response, expected }) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await invoke();

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(firstCall[1]?.body));
    expect(requestBody).toMatchObject({
      language: 'en-US',
      source_package_id: 'sp_safe',
      source_summary: ['Bounded source.'],
      source_reuse_status: 'fresh',
      ...expected,
    });
  });

  it.each([
    ['hot news', () => getHotNews({ language: 'en-US' }), {
      generated_at: '2026-08-31T12:00:00.000Z', degraded: false, warnings: [],
      topics: [{
        topic: 'Cómo organizar todas tus tareas', heat_score: 0.8, sources: ['news'],
        source_ids: ['source_1'], source_references: [], first_seen: null,
        niche: 'product', content_angle: 'Use one concrete workflow.', relevance: 8,
      }],
    }],
    ['hooks', () => getHooks('Safe topic', 'general', 1, { language: 'en-US' }), {
      topic: 'Safe topic', niche: 'general', duration_ms: 1,
      hooks: [{ text: 'Here is a clear opening', trigger_type: 'story', score: 8, why: 'It explains the value clearly', sfx: 'none', edit_cue: 'Aquí empieza la historia completa' }],
    }],
    ['titles', () => getTitles('Safe topic', 'general', 1, { language: 'en-US' }), {
      topic: 'Safe topic', duration_ms: 1,
      titles: [{ title: 'Cómo organizar todas tus tareas', strategy: 'HOW_TO', score: 80, why: 'Explica el beneficio claramente', char_count: 32 }],
    }],
    ['thumbnail', () => getThumbnail('Safe title', 'general', { language: 'en-US' }), {
      title: 'Safe title', duration_ms: 1,
      concepts: [{
        layout: 'close_up', background_color: '#112233',
        text_overlay: { main_text: 'Organiza Tu Semana', font_style: 'bold', color: '#FFFFFF', position: 'center' },
        facial_expression: 'focused', additional_elements: ['lista de tareas'], why_it_works: 'Promete una solución muy clara',
      }],
    }],
    ['caption', () => getCaption('Safe topic', 'general', { language: 'en-US' }), {
      topic: 'Safe topic', caption: 'Organiza todas tus tareas con este método sencillo y práctico.', hashtags: ['organizacion'], duration_ms: 1,
    }],
    ['repurpose', () => getRepurpose('Safe topic', 'Source content', 'YouTube', { language: 'en-US' }), {
      topic: 'Safe topic', duration_ms: 1,
      outputs: [{ format: 'Reel', platform: 'Instagram', content: 'Convierte la idea principal en una demostración sencilla.', posting_delay: 'día 1', notes: 'Mantén el ejemplo muy claro.' }],
    }],
    ['competitor analysis', () => getCompetitor('safe-channel', 10, { language: 'en-US' }), {
      channel: 'safe-channel', duration_ms: 1,
      analysis: {
        strengths: ['Aquí empieza una estrategia completa para todos'],
        weaknesses: [],
        actionable_insights: [],
      },
    }],
    ['gap analysis', () => getGaps('general', 10, { language: 'en-US' }), {
      niche: 'general', duration_ms: 1,
      gaps: [{
        topic: 'Safe topic', gap_type: 'quality_gap',
        suggested_angle: 'Aquí empieza una oportunidad completa para todos',
      }],
    }],
    ['SEO analysis', () => getSeo('Safe topic', { language: 'en-US' }), {
      topic: 'Safe topic', duration_ms: 1,
      clusters: [{
        keyword: 'safe keyword',
        notes: 'Aquí empieza una recomendación completa para todos',
      }],
    }],
  ] as const)('withholds wrong-locale %s output', async (_label, invoke, response) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(invoke()).rejects.toMatchObject({ code: 'CONTENT_OUTPUT_LOCALE_MISMATCH' });
  });

  it('withholds a caption pack when a rendered hashtag violates the requested locale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      topic: 'Safe topic',
      caption: 'Build one clear workflow and review it every week.',
      hashtags: ['consejos'],
      duration_ms: 1,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(getCaption('Safe topic', 'general', { language: 'en-US' }))
      .rejects.toMatchObject({ code: 'CONTENT_OUTPUT_LOCALE_MISMATCH' });
  });

  it.each([
    ['hot news', () => getHotNews({ language: 'en-US' }), {
      topics: [], generated_at: '2026-08-31T12:00:00.000Z', degraded: true,
    }],
    ['titles', () => getTitles('Safe topic', 'general', 1, { language: 'en-US' }), {
      topic: 'Safe topic', titles: [], duration_ms: 1,
    }],
    ['thumbnail', () => getThumbnail('Safe title', 'general', { language: 'en-US' }), {
      title: 'Safe title', concepts: [], duration_ms: 1,
    }],
    ['caption', () => getCaption('Safe topic', 'general', { language: 'en-US' }), {
      topic: 'Safe topic', caption: 'Build one clear workflow.', hashtags: ['creatorops'], duration_ms: 1,
    }],
    ['repurpose', () => getRepurpose('Safe topic', 'Source content', 'YouTube', { language: 'en-US' }), {
      topic: 'Safe topic', outputs: [], duration_ms: 1,
    }],
  ] as const)('withholds wrong-locale %s provider warning prose', async (_label, invoke, response) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ...response,
      warnings: ['Aquí empieza una advertencia completa para todos.'],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(invoke()).rejects.toMatchObject({ code: 'CONTENT_OUTPUT_LOCALE_MISMATCH' });
  });

  it('withholds competitor output when a model-authored content-mix label violates the locale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      channel: 'safe-channel',
      duration_ms: 1,
      analysis: {
        title_patterns: [],
        content_mix: { 'Aquí empieza una categoría completa': '40%' },
        strengths: [],
        weaknesses: [],
        actionable_insights: [],
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(getCompetitor('safe-channel', 10, { language: 'en-US' }))
      .rejects.toMatchObject({ code: 'CONTENT_OUTPUT_LOCALE_MISMATCH' });
  });

  it('preserves caller cancellation through the Python hop and never caches an undelivered script', async () => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('content client disconnected'), {
      name: 'AbortError',
      code: 'CONTENT_ENGINE_CLIENT_DISCONNECTED',
    });
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        expect(init?.signal).toBeDefined();
        expect(init?.signal).not.toBe(controller.signal);
        expect(init?.signal?.aborted).toBe(false);
        fetchStarted();
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const execution = getScript(
      'Safe topic',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'structured',
      42,
      undefined,
      null,
      'detailed',
      false,
      null,
      null,
      42,
      undefined,
      undefined,
      { abortSignal: controller.signal },
    );
    await started;
    controller.abort(cancellation);

    await expect(execution).rejects.toBe(cancellation);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cacheMocks.setCache).not.toHaveBeenCalled();
  });

  it.each([
    ['deep search', (signal: AbortSignal) => deepSearch('Safe topic', undefined, 10, { abortSignal: signal })],
    ['source search', (signal: AbortSignal) => getSources('Safe topic', { abortSignal: signal })],
    ['hot news', (signal: AbortSignal) => getHotNews({ abortSignal: signal })],
    ['trending search', (signal: AbortSignal) => getTrending(undefined, { abortSignal: signal })],
    ['reaction search', (signal: AbortSignal) => getReaction('Safe topic', { abortSignal: signal })],
    ['hook pack', (signal: AbortSignal) => getHooks('Safe topic', 'general', 8, { abortSignal: signal })],
    ['title pack', (signal: AbortSignal) => getTitles('Safe topic', 'general', 10, { abortSignal: signal })],
    ['thumbnail pack', (signal: AbortSignal) => getThumbnail('Safe title', 'general', { abortSignal: signal })],
    ['caption pack', (signal: AbortSignal) => getCaption('Safe topic', 'general', { abortSignal: signal })],
    ['competitor analysis', (signal: AbortSignal) => getCompetitor('safe-channel', 10, { abortSignal: signal })],
    ['gap analysis', (signal: AbortSignal) => getGaps('general', 10, { abortSignal: signal })],
    ['SEO analysis', (signal: AbortSignal) => getSeo('Safe topic', { abortSignal: signal })],
    ['repurpose pack', (signal: AbortSignal) => getRepurpose(
      'Safe topic',
      'Source content',
      'YouTube',
      { abortSignal: signal },
    )],
    ['feedback analysis', (signal: AbortSignal) => logFeedback({
      video_url: 'https://example.com/video',
      views: 1,
      retention_pct: 50,
    }, { abortSignal: signal })],
    ['performance report', (signal: AbortSignal) => {
      vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'content-engine-report-cancellation-secret');
      return runWithContext(
        { source: 'http', userId: 42, tenantId: 42 },
        () => getReport('week', { abortSignal: signal }),
      );
    }],
  ] as const)('propagates caller cancellation through the %s wrapper', async (_label, invoke) => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('content client disconnected'), {
      name: 'AbortError',
      code: 'CONTENT_ENGINE_CLIENT_DISCONNECTED',
    });
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        expect(init?.signal).toBeDefined();
        expect(init?.signal).not.toBe(controller.signal);
        fetchStarted();
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const execution = invoke(controller.signal);
    await started;
    controller.abort(cancellation);

    await expect(execution).rejects.toBe(cancellation);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates an unsupported stale cache entry before returning it', async () => {
    cacheMocks.getCached.mockReturnValue({
      topic: 'Safe topic',
      script: 'Aquí tienes el guion completo para organizar todas tus tareas.',
      hook: '¿Quieres empezar ahora?',
      title_options: ['Cómo organizar tus tareas'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      caption: 'Guarda esta guía para mañana.',
      cta: 'Comparte este vídeo con alguien.',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getScript(
      'Safe topic',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'structured',
      42,
      undefined,
      null,
      'detailed',
      false,
      null,
      null,
      42,
    )).rejects.toMatchObject({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'content-engine-script-cache',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheMocks.setCache).not.toHaveBeenCalled();
  });

  it.each([
    ['topic', 'How to hack private accounts', 'general', null, 'CONTENT_UNSUPPORTED_TOPIC'],
    ['niche', 'A safe creator workflow', 'medical dosage advice', null, 'CONTENT_HIGH_RISK_REVIEW_REQUIRED'],
    ['context', 'A safe creator workflow', 'general', { whyNow: 'Should I take ibuprofen for migraines?' }, 'CONTENT_HIGH_RISK_REVIEW_REQUIRED'],
    ['combined fields', 'insider', 'trading playbook', null, 'CONTENT_UNSUPPORTED_TOPIC'],
  ] as const)('blocks unsafe direct script %s input before cache or transport', async (
    _field,
    topic,
    niche,
    context,
    code,
  ) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getScript(
      topic, niche, 1, 'Reel', 'quick', null, 'en-US',
      'structured', 42, undefined, context, 'detailed', false, null, null, 42,
    )).rejects.toMatchObject({ code, status: 422 });
    expect(cacheMocks.getCached).not.toHaveBeenCalled();
    expect(cacheMocks.setCache).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks an unsafe direct script before validating an oversized canonical research query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getScript(
      `How to hack private accounts ${'x'.repeat(1_870)}`,
      'n'.repeat(160),
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'structured',
      42,
      undefined,
      null,
      'detailed',
      false,
      null,
      null,
      42,
    )).rejects.toMatchObject({ code: 'CONTENT_UNSUPPORTED_TOPIC', status: 422 });
    expect(cacheMocks.getCached).not.toHaveBeenCalled();
    expect(cacheMocks.setCache).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports successful script cache reads as hits without mutating fallback truth', async () => {
    const cachedResult = {
      topic: 'Safe topic',
      script: 'This cached script gives one concrete workflow and one useful next action.',
      hook: 'Start with the observable result.',
      title_options: ['A reliable workflow'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      caption: 'Save this workflow for the next review.',
      cta: 'Apply one step today.',
      cache_status: 'fresh',
      degraded: false,
    };
    cacheMocks.getCached.mockReturnValueOnce(cachedResult);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hit = await getScript(
      'Safe topic', 'general', 1, 'Reel', 'quick', null, 'en-US',
      'structured', 42, undefined, null, 'detailed', false, null, null, 42,
    );

    expect(hit.cache_status).toBe('hit');
    expect(fetchMock).not.toHaveBeenCalled();

    cacheMocks.getCached.mockReturnValueOnce({
      ...cachedResult,
      cache_status: 'fallback',
      degraded: true,
    });
    const fallback = await getScript(
      'Safe topic', 'general', 1, 'Reel', 'quick', null, 'en-US',
      'structured', 42, undefined, null, 'detailed', false, null, null, 42,
    );
    expect(fallback.cache_status).toBe('fallback');
    expect(fallback.degraded).toBe(true);
  });

  it('does not reuse a cached script after its creator context is removed', async () => {
    const cachedResult = {
      topic: 'Safe topic',
      script: 'This script uses the currently authorized creator context and stays reviewable.',
      hook: 'Start with the authorized context.',
      title_options: ['A context-aware workflow'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      caption: 'Review the context before publishing.',
      cta: 'Check the current references.',
      cache_status: 'fresh',
      degraded: false,
    };
    let originalKey: string | undefined;
    cacheMocks.getCached.mockImplementation((key: string) => {
      if (!originalKey) {
        originalKey = key;
        return cachedResult;
      }
      return key === originalKey ? cachedResult : null;
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(cachedResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const original = await getScript(
      'Safe topic', 'general', 1, 'Reel', 'quick', null, 'en-US',
      'structured', 42, undefined, null, 'detailed', false, null,
      'Authorized references:\n- Private source alpha', 42,
    );
    const afterRemoval = await getScript(
      'Safe topic', 'general', 1, 'Reel', 'quick', null, 'en-US',
      'structured', 42, undefined, null, 'detailed', false, null, null, 42,
    );
    const removedKey = String(cacheMocks.getCached.mock.calls[1]?.[0]);

    expect(original.cache_status).toBe('hit');
    expect(removedKey).not.toBe(originalKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(afterRemoval.cache_status).toBe('fresh');
  });
});
