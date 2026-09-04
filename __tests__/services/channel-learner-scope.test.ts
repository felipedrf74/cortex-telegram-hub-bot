import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;
const { completeOneShotWithFallback, writeSignal, invalidateContentDerivedCaches } = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  writeSignal: vi.fn(),
  invalidateContentDerivedCaches: vi.fn(),
}));
vi.hoisted(() => {
  process.env.YOUTUBE_API_KEY = 'test-youtube-key';
});

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test', model: 'test-model', classifierModel: 'test-classifier' },
  },
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback,
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  AiBudgetError: class AiBudgetError extends Error {},
  withAiBudgetReservation: vi.fn(async (_request: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/services/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

vi.mock('../../src/utils/prompt-loader', () => ({
  loadPrompt: vi.fn(() => 'prompt'),
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

vi.mock('../../src/services/video-study', () => ({
  deepAnalyzeTopVideos: vi.fn(async () => ({ transcriptCount: 0, deepPatterns: '' })),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  writeGovernedSignal: writeSignal,
}));

vi.mock('../../src/services/cache-coherence-registry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cache-coherence-registry')>(
    '../../src/services/cache-coherence-registry',
  )),
  invalidateContentDerivedCaches,
}));

vi.mock('../../src/services/ai-automation-policy', () => ({
  recordAiAutomationEligibilitySkip: vi.fn(),
  resolveAiAutomationEligibility: vi.fn((userId: number) => ({
    allowed: userId === 42,
    reason: userId === 42 ? 'eligible' : 'automation_entitlement_required',
    entitlement: { source: userId === 42 ? 'founder' : 'free' },
  })),
}));


import {
  addChannel,
  addSystemChannel,
  createContentReferencesAdminContext,
  getKnowledgeByCategory,
  getSystemKnowledgeByCategory,
  PATTERN_CATEGORIES,
  updateChannelStatus,
  upsertPatterns,
} from '../../src/state/content-references';
import {
  ChannelAutomationTargetsUnavailableError,
  ChannelSourceUnavailableError,
  addAndAnalyzeChannel,
  analyzeChannel,
  planChannelRelearnScopes,
  processAllChannelScopes,
} from '../../src/services/channel-learner';
import { resolveAiAutomationEligibility } from '../../src/services/ai-automation-policy';

const adminContext = createContentReferencesAdminContext('channel learner scope test');

describe('channel-learner: scoped synthesis', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    completeOneShotWithFallback.mockReset();
    writeSignal.mockReset();
    writeSignal.mockReturnValue(1);
    invalidateContentDerivedCaches.mockReset();
    vi.mocked(resolveAiAutomationEligibility).mockClear();

    completeOneShotWithFallback.mockImplementation(async (_system, prompt, jobName) => {
      if (jobName === 'channel_analysis') {
        return {
          text: JSON.stringify({
            channel_summary: 'System summary',
            patterns: PATTERN_CATEGORIES.map((category) => ({
              category,
              pattern_text: `System ${category} pattern`,
              examples: [`System ${category} example`],
              confidence: 0.92,
              source_videos: ['vid-system-1'],
            })),
          }),
          provider: 'gemini',
        };
      }

      if (jobName === 'knowledge_synthesis') {
        expect(String(prompt)).toContain('System Channel');
        expect(String(prompt)).toContain('User Channel');
        return {
          text: JSON.stringify({
            categories: [
              {
                category: 'hook_style',
                synthesized_text: 'Merged user + system hook guidance',
                source_channels: ['System Channel', 'User Channel'],
              },
            ],
          }),
          provider: 'gemini',
        };
      }

      throw new Error(`Unexpected job ${jobName}`);
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: 'UCsystem', snippet: { title: 'System Channel' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/search') && href.includes('channelId=UCsystem')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: 'vid-system-1' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{
              id: 'vid-system-1',
              snippet: {
                title: 'System video',
                description: 'A system seed example',
                publishedAt: '2026-04-17T09:00:00.000Z',
                channelTitle: 'System Channel',
              },
              statistics: {
                viewCount: '1000',
                likeCount: '100',
                commentCount: '12',
              },
              contentDetails: { duration: 'PT10M' },
            }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch ${href}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    testDb?.close();
  });

  it('runs shared platform learning for an eligible consumer without requiring a private channel', async () => {
    testDb.prepare(
      "INSERT INTO users (id, telegram_id, tier, status) VALUES (42, 4200, 'pro', 'active')",
    ).run();
    const systemChannel = addSystemChannel('https://www.youtube.com/channel/UCsystem', 'manual', adminContext);
    testDb.prepare(`
      UPDATE content_ref_channels
         SET tenant_id = 0,
             owner_user_id = 0,
             visibility_scope = 'platform_internal',
             scope_status = 'active',
             lifecycle_state = 'active',
             created_by = 0,
             updated_by = 0
       WHERE id = ?
    `).run(systemChannel.id);
    testDb.prepare(`
      INSERT INTO shared_knowledge_consumption (user_id, tenant_id, source)
      VALUES (42, 42, 'content_prompt')
    `).run();

    vi.useFakeTimers();
    const resultPromise = processAllChannelScopes(false);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.analyzed).toBe(1);
    expect(fetch).toHaveBeenCalled();
    expect(completeOneShotWithFallback.mock.calls.filter(([, , job]) => job === 'channel_analysis')).toHaveLength(1);
    const privateChannels = (testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM content_ref_channels
       WHERE user_id = 42
         AND COALESCE(visibility_scope, 'user_private') = 'user_private'
    `).get() as { count: number }).count;
    expect(privateChannels).toBe(0);
  });

  it('fails scheduled target selection closed when active-user truth is unavailable', () => {
    testDb.exec('ALTER TABLE users RENAME TO users_unavailable');

    expect(() => planChannelRelearnScopes())
      .toThrow(ChannelAutomationTargetsUnavailableError);
    expect(resolveAiAutomationEligibility).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('preserves typed YouTube HTTP unavailability instead of reporting no channel or videos', async () => {
    const channel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 42);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'private upstream detail' } }),
    } as Response)));

    await expect(analyzeChannel(channel.id)).rejects.toMatchObject({
      name: ChannelSourceUnavailableError.name,
      code: 'CONTENT_CHANNEL_SOURCE_UNAVAILABLE',
      reason: 'http',
      status: 503,
      retryable: true,
    });
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(testDb.prepare(
      'SELECT status, error_message FROM content_ref_channels WHERE id = ?',
    ).get(channel.id)).toEqual({
      status: 'failed',
      error_message: 'CONTENT_CHANNEL_SOURCE_UNAVAILABLE',
    });
  });

  it.each([
    ['missing required snippet fields', {
      id: 'vid-system-1',
      snippet: {
        description: 'Description',
        publishedAt: '2026-04-17T09:00:00.000Z',
        channelTitle: 'System Channel',
      },
      statistics: { viewCount: '1000' },
      contentDetails: { duration: 'PT10M' },
    }],
    ['a non-numeric required view count', {
      id: 'vid-system-1',
      snippet: {
        title: 'System video',
        description: 'Description',
        publishedAt: '2026-04-17T09:00:00.000Z',
        channelTitle: 'System Channel',
      },
      statistics: { viewCount: 'not-a-count' },
      contentDetails: { duration: 'PT10M' },
    }],
    ['invalid published-at and duration fields', {
      id: 'vid-system-1',
      snippet: {
        title: 'System video',
        description: 'Description',
        publishedAt: 'not-rfc3339',
        channelTitle: 'System Channel',
      },
      statistics: { viewCount: '1000' },
      contentDetails: { duration: 'ten minutes' },
    }],
    ['an unrequested video id', {
      id: 'vid-from-another-response',
      snippet: {
        title: 'Unexpected video',
        description: 'Description',
        publishedAt: '2026-04-17T09:00:00.000Z',
        channelTitle: 'Another Channel',
      },
      statistics: { viewCount: '1000' },
      contentDetails: { duration: 'PT10M' },
    }],
  ])('rejects malformed YouTube 2xx video details with typed source unavailability: %s', async (_label, videoDetails) => {
    const channel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 42);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: 'UCsystem', snippet: { title: 'System Channel' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/search')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: 'vid-system-1' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        return { ok: true, status: 200, json: async () => ({ items: [videoDetails] }) } as Response;
      }
      throw new Error(`Unexpected fetch ${href}`);
    }));

    await expect(analyzeChannel(channel.id)).rejects.toMatchObject({
      name: ChannelSourceUnavailableError.name,
      code: 'CONTENT_CHANNEL_SOURCE_UNAVAILABLE',
      reason: 'invalid_response',
      status: 503,
      retryable: true,
    });
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(testDb.prepare(
      'SELECT status, error_message FROM content_ref_channels WHERE id = ?',
    ).get(channel.id)).toEqual({
      status: 'failed',
      error_message: 'CONTENT_CHANNEL_SOURCE_UNAVAILABLE',
    });
  });

  it('accepts omitted optional YouTube like and comment counters without inventing a malformed source', async () => {
    const channel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 42);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: 'UCsystem', snippet: { title: 'System Channel' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/search')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: 'vid-system-1' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{
              id: 'vid-system-1',
              snippet: {
                title: 'System video',
                description: 'Description',
                publishedAt: '2026-04-17T09:00:00.000Z',
                channelTitle: 'System Channel',
              },
              statistics: { viewCount: '1000' },
              contentDetails: { duration: 'PT10M' },
            }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch ${href}`);
    }));

    await expect(analyzeChannel(channel.id)).resolves.toMatchObject({
      success: true,
      videosAnalyzed: 1,
    });
    expect(completeOneShotWithFallback).toHaveBeenCalledTimes(1);
  });

  it('keeps a valid empty YouTube result distinct from source unavailability', async () => {
    const channel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 42);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: href.startsWith('https://www.googleapis.com/youtube/v3/channels')
            ? [{ id: 'UCsystem', snippet: { title: 'System Channel' } }]
            : [],
        }),
      } as Response;
    }));

    await expect(analyzeChannel(channel.id)).resolves.toMatchObject({
      success: false,
      error: 'CHANNEL_SOURCE_NO_RESULTS',
      videosAnalyzed: 0,
    });
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
  });

  it('resynthesizes user knowledge after shared system channels refresh without emitting per-user channel_dna signals', async () => {
    testDb.prepare(
      "INSERT INTO users (id, telegram_id, tier, status) VALUES (42, 4200, 'pro', 'active')",
    ).run();
    const systemChannel = addSystemChannel('https://www.youtube.com/channel/UCsystem', 'manual', adminContext);
    testDb.prepare(`
      UPDATE content_ref_channels
         SET tenant_id = 0,
             owner_user_id = 0,
             visibility_scope = 'platform_internal',
             scope_status = 'active',
             lifecycle_state = 'active',
             created_by = 0,
             updated_by = 0
       WHERE id = ?
    `).run(systemChannel.id);

    const userChannel = addChannel('https://www.youtube.com/@user', 'manual', 42);
    updateChannelStatus(userChannel.id, 'active', {
      channel_name: 'User Channel',
      channel_id: 'UCuser',
      video_count_analyzed: 1,
    }, { userId: 42 });
    upsertPatterns(userChannel.id, [
      {
        category: 'hook_style',
        pattern_text: 'User hook pattern',
        examples: ['User example'],
        confidence: 0.88,
        source_videos: ['vid-user-1'],
      },
    ], { userId: 42 });
    testDb.prepare(`
      INSERT INTO shared_knowledge_consumption (user_id, tenant_id, source)
      VALUES (42, 42, 'content_prompt')
    `).run();

    vi.useFakeTimers();
    const resultPromise = processAllChannelScopes(false);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toMatchObject({
      analyzed: 1,
      failed: 0,
      synthesized: true,
    });

    const systemKnowledge = getSystemKnowledgeByCategory('hook_style', adminContext);
    const userKnowledge = getKnowledgeByCategory('hook_style', 42);

    expect(systemKnowledge?.user_id).toBe(0);
    expect(systemKnowledge?.synthesized_text).toContain('System hook_style pattern');
    expect(userKnowledge?.user_id).toBe(42);
    expect(userKnowledge?.synthesized_text).toBe('Merged user + system hook guidance');

    expect(writeSignal).toHaveBeenCalled();
    expect(writeSignal.mock.calls.some(([signal]) => signal.user_id === 42)).toBe(false);
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(undefined);
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(42);
  });

  it('skips platform and user YouTube work when no eligible Content automation consumer exists', async () => {
    testDb.prepare(
      "INSERT INTO users (id, telegram_id, tier, status) VALUES (77, 7700, 'free', 'active')",
    ).run();
    const denied = addChannel('https://www.youtube.com/@denied', 'manual', 77);
    expect(denied.user_id).toBe(77);

    const result = await processAllChannelScopes(false);

    expect(result).toEqual({
      analyzed: 0,
      failed: 0,
      skipped_no_new_videos: 0,
      synthesized: false,
      synthesis_skipped_all_unchanged: false,
      synthesis_deferred: false,
    });
    expect(resolveAiAutomationEligibility).toHaveBeenCalledWith(77, 'content');
    expect(fetch).not.toHaveBeenCalled();
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('defers platform scope when eligible users have no shared-consumption evidence', async () => {
    testDb.prepare(
      "INSERT INTO users (id, telegram_id, tier, status) VALUES (42, 4200, 'pro', 'active')",
    ).run();
    const systemChannel = addSystemChannel('https://www.youtube.com/channel/UCsystem', 'manual', adminContext);
    testDb.prepare(`
      UPDATE content_ref_channels
         SET tenant_id = 0,
             owner_user_id = 0,
             visibility_scope = 'platform_internal',
             scope_status = 'active',
             lifecycle_state = 'active',
             created_by = 0,
             updated_by = 0
       WHERE id = ?
    `).run(systemChannel.id);

    const result = await processAllChannelScopes(false);

    expect(result).toMatchObject({
      analyzed: 0,
      failed: 0,
      synthesized: false,
      synthesis_deferred: true,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(testDb.prepare(`
      SELECT request_source, job_name, base_category, code
        FROM ai_budget_deferrals
       WHERE code = 'SHARED_KNOWLEDGE_CONSUMPTION_REQUIRED'
    `).get()).toEqual({
      request_source: 'system',
      job_name: 'channel_relearn',
      base_category: 'channel_learning',
      code: 'SHARED_KNOWLEDGE_CONSUMPTION_REQUIRED',
    });
  });

  it('retains prior patterns and does not advance the fingerprint after invalid extraction output', async () => {
    const userChannel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 42);
    upsertPatterns(userChannel.id, [{
      category: 'hook_style',
      pattern_text: 'Prior valid hook pattern',
      examples: ['Prior example'],
      confidence: 0.9,
      source_videos: ['prior-video'],
    }], { userId: 42 });
    completeOneShotWithFallback.mockResolvedValue({ text: '{not-json', provider: 'gemini' });

    const result = await analyzeChannel(userChannel.id);

    expect(result.success).toBe(false);
    expect(invalidateContentDerivedCaches).toHaveBeenCalledTimes(1);
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(42);
    const channelRow = testDb.prepare(
      'SELECT status, analysis_fingerprint FROM content_ref_channels WHERE id = ?',
    ).get(userChannel.id) as { status: string; analysis_fingerprint: string | null };
    expect(channelRow).toEqual({ status: 'failed', analysis_fingerprint: null });
    const patterns = testDb.prepare(
      'SELECT pattern_text FROM content_patterns WHERE channel_id = ?',
    ).all(userChannel.id) as Array<{ pattern_text: string }>;
    expect(patterns.map((pattern) => pattern.pattern_text)).toContain('Prior valid hook pattern');
  });

  it('rejects non-default tenant add-and-analyze before channel or provider mutation', async () => {
    const before = testDb.prepare('SELECT COUNT(*) AS count FROM content_ref_channels').get() as { count: number };

    await expect(addAndAnalyzeChannel(
      'https://www.youtube.com/channel/UCtenant',
      'portal',
      42,
      314,
    )).rejects.toMatchObject({
      name: 'UnsupportedChannelLearningScopeError',
      code: 'UNSUPPORTED_SCOPE',
      status: 409,
      message: 'Channel analysis and synthesis currently support user-default tenant only',
    });

    const after = testDb.prepare('SELECT COUNT(*) AS count FROM content_ref_channels').get() as { count: number };
    expect(after).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('invalidates the creator cache when add-and-analyze first commits a channel row', async () => {
    completeOneShotWithFallback.mockResolvedValue({ text: '{not-json', provider: 'gemini' });

    const result = await addAndAnalyzeChannel(
      'https://www.youtube.com/channel/UCsystem',
      'portal',
      42,
      42,
    );

    expect(result.channel.user_id).toBe(42);
    expect(result.analysis.success).toBe(false);
    expect(invalidateContentDerivedCaches.mock.calls).toEqual([[42], [42]]);
  });

  it('cancels channel search work when the interactive request disconnects', async () => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('content client disconnected'), {
      name: 'AbortError',
      code: 'CONTENT_CLIENT_DISCONNECTED',
    });
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        fetchStarted();
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const analysis = addAndAnalyzeChannel(
      'https://www.youtube.com/channel/UCsystem',
      'portal',
      42,
      42,
      {
        requestSource: 'interactive',
        jobName: 'channel_add_manual',
        abortSignal: controller.signal,
      },
    );
    await started;
    controller.abort(cancellation);

    await expect(analysis).rejects.toBe(cancellation);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit)?.signal).toBe(controller.signal);
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
  });

  it('does not persist extracted patterns after provider work is cancelled', async () => {
    const channel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 42);
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('content client disconnected'), {
      name: 'AbortError',
      code: 'CONTENT_CLIENT_DISCONNECTED',
    });
    completeOneShotWithFallback.mockImplementationOnce(async () => {
      controller.abort(cancellation);
      return {
        provider: 'gemini',
        text: JSON.stringify({
          channel_summary: 'Cancelled result',
          patterns: PATTERN_CATEGORIES.map((category) => ({
            category,
            pattern_text: `Cancelled ${category}`,
            examples: ['Must not persist'],
            confidence: 0.9,
            source_videos: ['vid-system-1'],
          })),
        }),
      };
    });

    await expect(analyzeChannel(channel.id, {
      budgetContext: {
        requestSource: 'interactive',
        jobName: 'channel_reanalyze_manual',
        abortSignal: controller.signal,
      },
    })).rejects.toBe(cancellation);

    expect(testDb.prepare(
      'SELECT COUNT(*) AS count FROM content_patterns WHERE channel_id = ?',
    ).get(channel.id)).toEqual({ count: 0 });
    expect(testDb.prepare(
      'SELECT status, analysis_fingerprint FROM content_ref_channels WHERE id = ?',
    ).get(channel.id)).toEqual({ status: 'pending', analysis_fingerprint: null });
    expect(writeSignal).not.toHaveBeenCalled();
  });

  it('rejects category-incomplete extraction and retains the prior pattern set', async () => {
    const userChannel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 42);
    upsertPatterns(userChannel.id, [{
      category: 'hook_style',
      pattern_text: 'Prior complete-run hook',
      examples: ['Prior example'],
      confidence: 0.9,
      source_videos: ['prior-video'],
    }], { userId: 42 });
    completeOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify({
        channel_summary: 'Incomplete summary',
        patterns: [{
          category: 'hook_style',
          pattern_text: 'Only one category',
          examples: ['Example'],
          confidence: 0.95,
          source_videos: ['vid-system-1'],
        }],
      }),
      provider: 'gemini',
    });

    const result = await analyzeChannel(userChannel.id);

    expect(result.success).toBe(false);
    const patterns = testDb.prepare(
      'SELECT pattern_text FROM content_patterns WHERE channel_id = ?',
    ).all(userChannel.id) as Array<{ pattern_text: string }>;
    expect(patterns.map((pattern) => pattern.pattern_text)).toEqual(['Prior complete-run hook']);
  });

  it('rolls pattern replacement back atomically when any insert fails', () => {
    const userChannel = addChannel('https://www.youtube.com/@atomic', 'manual', 42);
    upsertPatterns(userChannel.id, [{
      category: 'hook_style',
      pattern_text: 'Prior atomic hook',
      examples: ['Prior example'],
      confidence: 0.9,
      source_videos: ['prior-video'],
    }], { userId: 42 });

    expect(() => upsertPatterns(userChannel.id, [{
      category: 'hook_style',
      pattern_text: 'Replacement starts',
      examples: ['Replacement'],
      confidence: 0.9,
      source_videos: ['replacement-video'],
    }, {
      category: null as any,
      pattern_text: 'Invalid category insert',
      examples: ['Invalid'],
      confidence: 0.9,
      source_videos: ['replacement-video'],
    }], { userId: 42 })).toThrow();

    const patterns = testDb.prepare(
      'SELECT category, pattern_text FROM content_patterns WHERE channel_id = ?',
    ).all(userChannel.id) as Array<{ category: string; pattern_text: string }>;
    expect(patterns).toEqual([{ category: 'hook_style', pattern_text: 'Prior atomic hook' }]);
  });
});
