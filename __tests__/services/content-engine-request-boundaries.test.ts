import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithContext } from '../../src/utils/request-context';

vi.mock('../../src/state/content-creator-profile', () => ({
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
    languagePreference: 'en-US',
    voiceExamples: [],
    updatedAt: null,
  })),
}));
import {
  ContentEngineReportScopeError,
  ContentEngineRequestValidationError,
  deepSearch,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Content Engine TypeScript request boundaries', () => {
  it.each([
    ['deep-search query', () => deepSearch('')],
    ['deep-search niche count', () => deepSearch('Safe topic', Array.from({ length: 13 }, () => 'niche'))],
    ['output language selector', () => getHotNews({ language: 'es-ES' as never })],
    ['source query length', () => getSources('x'.repeat(2_001))],
    ['trending niche length', () => getTrending('x'.repeat(161))],
    ['reaction topic', () => getReaction('   ')],
    ['hook count', () => getHooks('Safe topic', 'general', 9)],
    ['title count', () => getTitles('Safe topic', 'general', 11)],
    ['thumbnail combined brief', () => getThumbnail('t'.repeat(1_401), 'general', { topic: 'q'.repeat(1_400) })],
    ['caption niche length', () => getCaption('Safe topic', 'n'.repeat(161))],
    ['competitor video count', () => getCompetitor('safe-channel', 51)],
    ['gap count', () => getGaps('general', 21)],
    ['SEO topic controls', () => getSeo('safe\ttopic')],
    ['SEO platform selector', () => getSeo('Safe topic', { platform: 'TikTok' as never })],
    ['repurpose source length', () => getRepurpose('Safe topic', 'x'.repeat(5_001))],
  ] as const)('rejects an invalid %s before HTTP dispatch', async (_label, invoke) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(invoke()).rejects.toBeInstanceOf(ContentEngineRequestValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['source package', () => getCaption('Safe topic', 'general', { sourcePackageId: 'x'.repeat(257) })],
    ['source summary count', () => getHooks('Safe topic', 'general', 1, {
      sourceSummary: Array.from({ length: 9 }, () => 'Bounded source'),
    })],
    ['source reuse selector', () => getTitles('Safe topic', 'general', 1, {
      sourceReuseStatus: 'cached' as never,
    })],
  ] as const)('rejects invalid creative %s metadata before HTTP dispatch', async (_label, invoke) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(invoke()).rejects.toMatchObject({ code: 'CONTENT_ENGINE_REQUEST_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes bounded deep-search text before crossing the HTTP boundary', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      query: 'Safe topic',
      briefs: [],
      search_count: 0,
      duration_ms: 1,
      degraded: false,
      warnings: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await deepSearch('  Safe topic  ', ['  creator ops  '], 3, { language: 'en-US' });

    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      query: 'Safe topic',
      niches: ['creator ops'],
      max_results: 3,
      language: 'en-US',
    });
  });

  it.each([
    ['format', () => getScript('Safe topic', 'general', 8, 'Podcast' as never)],
    ['duration', () => getScript('Safe topic', 'general', 31)],
    ['target duration', () => getScript(
      'Safe topic', 'general', 8, 'YouTube', 'draft', null, 'en-US', 'structured',
      undefined, 14,
    )],
    ['topic context field', () => getScript(
      'Safe topic', 'general', 8, 'YouTube', 'draft', null, 'en-US', 'structured',
      undefined, undefined, { unknown: 'value' } as never,
    )],
  ] as const)('rejects an invalid script %s before cache or HTTP work', async (_label, invoke) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(invoke()).rejects.toMatchObject({ code: 'CONTENT_ENGINE_REQUEST_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['video URL', { video_url: '', views: 1, retention_pct: 50 }],
    ['views', { video_url: 'https://example.com/video', views: -1, retention_pct: 50 }],
    ['retention', { video_url: 'https://example.com/video', views: 1, retention_pct: Number.NaN }],
    ['comments', { video_url: 'https://example.com/video', views: 1, retention_pct: 50, comments: 1.5 }],
    ['hook', { video_url: 'https://example.com/video', views: 1, retention_pct: 50, hook_used: 'x'.repeat(2_001) }],
    ['notes controls', { video_url: 'https://example.com/video', views: 1, retention_pct: 50, notes: 'safe\u0001note' }],
  ] as const)('rejects invalid feedback %s before HTTP dispatch', async (_label, feedback) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(logFeedback(feedback)).rejects.toMatchObject({ code: 'CONTENT_ENGINE_REQUEST_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes valid feedback text and preserves numeric metrics', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'logged',
      analysis: {},
      duration_ms: 1,
      degraded: true,
      warnings: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await logFeedback({
      video_url: '  https://example.com/video  ',
      views: 12,
      retention_pct: 62.5,
      likes: 3,
      comments: 1,
      subs_gained: 2,
      hook_used: '  A bounded hook  ',
      notes: '  First line\nSecond line  ',
    });

    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      video_url: 'https://example.com/video',
      views: 12,
      retention_pct: 62.5,
      likes: 3,
      comments: 1,
      subs_gained: 2,
      hook_used: 'A bounded hook',
      notes: 'First line\nSecond line',
    });
  });

  it('fails a report closed without authenticated signed request context', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getReport('week')).rejects.toBeInstanceOf(ContentEngineReportScopeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends report period only with authenticated user, tenant, and signed attribution', async () => {
    vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'content-engine-report-test-secret');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      period: 'Last 30 Days',
      report: {
        status: 'no_data',
        degraded: false,
        data_source_status: 'available',
        videos_published: null,
        outcomes_logged: 0,
        publication_tracking: {
          availability: 'unavailable',
          reason_code: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
          publication_execution: 'not_supported',
        },
      },
      duration_ms: 1,
      degraded: false,
      warnings: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await runWithContext(
      { source: 'http', userId: 7, tenantId: 44 },
      () => getReport('month', { language: 'en-US' }),
    );

    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(request[1].body));
    expect(body).toMatchObject({ period: 'month', language: 'en-US', user_id: 7, tenant_id: 44 });
    expect(body.internal_attribution_token).toEqual(expect.any(String));
  });
});
