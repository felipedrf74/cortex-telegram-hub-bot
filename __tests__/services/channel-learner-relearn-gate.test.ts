// Migration 222 re-learn cost controls: new-video gate + failure backoff.
//
// Covers:
//  (a) unchanged channel (same fingerprint) → analysis + synthesis skipped,
//      counted as skipped_no_new_videos in the run result
//  (b) new video → analyzed, fingerprint updated
//  (c) NULL fingerprint (pre-migration row / first run) → analyzed
//  (d) 3 consecutive failures → 12h auto-retry suppressed, 7-day retry
//      allowed, success resets the counter
//  (e) all-skipped scope → zero synthesis LLM calls
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import path from 'path';

let testDb: Database.Database;
const { completeOneShotWithFallback, writeSignal } = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  writeSignal: vi.fn(),
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

vi.mock('../../src/portal/anthropic-hook', () => ({
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


import {
  addSystemChannel,
  createContentReferencesAdminContext,
  getSystemKnowledgeByCategory,
  PATTERN_CATEGORIES,
  updateChannelStatus,
} from '../../src/state/content-references';
import {
  analyzeChannel,
  computeChannelAnalysisFingerprint,
  processAllChannels,
} from '../../src/services/channel-learner';
import { logger } from '../../src/utils/logger';

const adminContext = createContentReferencesAdminContext('channel learner relearn gate test');

type StubVideo = { videoId: string; title: string; publishedAt: string; viewCount: number };

let videosByChannel: Record<string, StubVideo[]>;
let resolvableChannels: Set<string>;

function video(videoId: string, publishedAt = '2026-06-01T00:00:00.000Z', viewCount = 1000): StubVideo {
  return { videoId, title: `Video ${videoId}`, publishedAt, viewCount };
}

function llmCalls(jobName?: string): number {
  if (!jobName) return completeOneShotWithFallback.mock.calls.length;
  return completeOneShotWithFallback.mock.calls.filter((call) => call[2] === jobName).length;
}

function makeSystemChannel(channelKey: string): number {
  const ch = addSystemChannel(`https://www.youtube.com/channel/${channelKey}`, 'manual', adminContext);
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
  `).run(ch.id);
  return ch.id;
}

function getRow(id: number): {
  status: string;
  last_analyzed_at: string | null;
  analysis_fingerprint: string | null;
  last_checked_at: string | null;
  consecutive_failure_count: number;
} {
  return testDb.prepare(
    `SELECT status, last_analyzed_at, analysis_fingerprint, last_checked_at,
            COALESCE(consecutive_failure_count, 0) AS consecutive_failure_count
       FROM content_ref_channels WHERE id = ?`,
  ).get(id) as ReturnType<typeof getRow>;
}

function backdate(id: number, modifier: string): void {
  testDb.prepare(`
    UPDATE content_ref_channels
       SET last_analyzed_at = datetime('now', ?),
           updated_at = datetime('now', ?)
     WHERE id = ?
  `).run(modifier, modifier, id);
}

async function runProcessAllChannels(force = false): Promise<Awaited<ReturnType<typeof processAllChannels>>> {
  vi.useFakeTimers();
  try {
    const resultPromise = processAllChannels(force);
    await vi.runAllTimersAsync();
    return await resultPromise;
  } finally {
    vi.useRealTimers();
  }
}

describe('channel-learner: re-learn new-video gate + failure backoff (migration 222)', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    completeOneShotWithFallback.mockReset();
    writeSignal.mockReset();
    writeSignal.mockReturnValue(1);
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    videosByChannel = {};
    resolvableChannels = new Set();

    completeOneShotWithFallback.mockImplementation(async (_system, _prompt, jobName) => {
      if (jobName === 'channel_analysis') {
        return {
          text: JSON.stringify({
            channel_summary: 'Summary',
            patterns: PATTERN_CATEGORIES.map((category) => ({
              category,
              pattern_text: `${category} pattern`,
              examples: [`${category} example`],
              confidence: 0.9,
              source_videos: ['vid'],
            })),
          }),
          provider: 'gemini',
        };
      }
      if (jobName === 'knowledge_synthesis') {
        return {
          text: JSON.stringify({
            categories: PATTERN_CATEGORIES.map((category) => ({
              category,
              synthesized_text: `Merged ${category} guidance`,
              source_channels: ['Channel A', 'Channel B'],
            })),
          }),
          provider: 'gemini',
        };
      }
      throw new Error(`Unexpected job ${jobName}`);
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);
      const parsed = new URL(href);
      if (href.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
        const id = parsed.searchParams.get('id') || '';
        if (!resolvableChannels.has(id)) {
          return { json: async () => ({ items: [] }) } as Response;
        }
        return { json: async () => ({ items: [{ id, snippet: { title: `Channel ${id}` } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/search')) {
        const channelId = parsed.searchParams.get('channelId') || '';
        const vids = videosByChannel[channelId] || [];
        return { json: async () => ({ items: vids.map((v) => ({ id: { videoId: v.videoId } })) }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        const ids = (parsed.searchParams.get('id') || '').split(',').filter(Boolean);
        const items = Object.entries(videosByChannel).flatMap(([channelId, vids]) => vids
          .filter((v) => ids.includes(v.videoId))
          .map((v) => ({
            id: v.videoId,
            snippet: {
              title: v.title,
              description: `Description for ${v.videoId}`,
              publishedAt: v.publishedAt,
              channelTitle: `Channel ${channelId}`,
            },
            statistics: { viewCount: String(v.viewCount), likeCount: '10', commentCount: '2' },
            contentDetails: { duration: 'PT10M' },
          })));
        return { json: async () => ({ items }) } as Response;
      }
      throw new Error(`Unexpected fetch ${href}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    testDb?.close();
  });

  it('(a) skips analysis and synthesis for an unchanged channel and counts it as skipped_no_new_videos', async () => {
    const chId = makeSystemChannel('UCalpha');
    resolvableChannels.add('UCalpha');
    videosByChannel.UCalpha = [video('vid-a1'), video('vid-a2')];

    const run1 = await runProcessAllChannels();
    expect(run1).toMatchObject({
      analyzed: 1,
      failed: 0,
      skipped_no_new_videos: 0,
      synthesized: true,
      synthesis_skipped_all_unchanged: false,
    });

    const afterRun1 = getRow(chId);
    expect(afterRun1.status).toBe('active');
    expect(afterRun1.analysis_fingerprint).toBe(computeChannelAnalysisFingerprint(videosByChannel.UCalpha));
    const knowledgeVersionAfterRun1 = getSystemKnowledgeByCategory('hook_style', adminContext)?.version;
    expect(knowledgeVersionAfterRun1).toBeGreaterThanOrEqual(1);

    // Second cycle: nothing new published. Backdate so the channel is stale
    // for the weekly re-learn path.
    backdate(chId, '-9 days');
    completeOneShotWithFallback.mockClear();

    const run2 = await runProcessAllChannels();
    expect(run2).toMatchObject({
      analyzed: 0,
      failed: 0,
      skipped_no_new_videos: 1,
      synthesized: false,
      synthesis_skipped_all_unchanged: true,
    });

    // No LLM traffic at all: no extraction, no synthesis.
    expect(llmCalls()).toBe(0);

    // Skip is observable: channel back to active, fingerprint intact,
    // last_analyzed_at + last_checked_at bumped off the backdated value.
    const afterRun2 = getRow(chId);
    expect(afterRun2.status).toBe('active');
    expect(afterRun2.analysis_fingerprint).toBe(afterRun1.analysis_fingerprint);
    const freshness = testDb.prepare(`
      SELECT last_analyzed_at >= datetime('now', '-1 hour') AS analyzed_recent,
             last_checked_at >= datetime('now', '-1 hour') AS checked_recent
        FROM content_ref_channels WHERE id = ?
    `).get(chId) as { analyzed_recent: number; checked_recent: number };
    expect(freshness.analyzed_recent).toBe(1);
    expect(freshness.checked_recent).toBe(1);

    // Synthesis really skipped: knowledge version unchanged.
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.version).toBe(knowledgeVersionAfterRun1);
  });

  it('(b) re-analyzes when a new video appears and updates the fingerprint', async () => {
    const chId = makeSystemChannel('UCbeta');
    resolvableChannels.add('UCbeta');
    videosByChannel.UCbeta = [video('vid-b1')];

    const run1 = await runProcessAllChannels();
    expect(run1.analyzed).toBe(1);
    const fingerprintBefore = getRow(chId).analysis_fingerprint;
    expect(fingerprintBefore).toContain('vid-b1');

    // A new video is published.
    videosByChannel.UCbeta.push(video('vid-b2', '2026-06-20T00:00:00.000Z', 5000));
    backdate(chId, '-9 days');
    completeOneShotWithFallback.mockClear();

    const run2 = await runProcessAllChannels();
    expect(run2).toMatchObject({
      analyzed: 1,
      failed: 0,
      skipped_no_new_videos: 0,
      synthesized: true,
      synthesis_skipped_all_unchanged: false,
    });
    expect(llmCalls('channel_analysis')).toBe(1);

    const fingerprintAfter = getRow(chId).analysis_fingerprint;
    expect(fingerprintAfter).not.toBe(fingerprintBefore);
    expect(fingerprintAfter).toContain('vid-b1');
    expect(fingerprintAfter).toContain('vid-b2');
  });

  it('(c) analyzes a stale active channel with a NULL fingerprint (backward compatible first run)', async () => {
    const chId = makeSystemChannel('UCgamma');
    resolvableChannels.add('UCgamma');
    videosByChannel.UCgamma = [video('vid-g1')];

    // Simulate a pre-migration row: active, analyzed in the past, but no
    // fingerprint ever persisted.
    updateChannelStatus(chId, 'active', {
      channel_name: 'Channel UCgamma',
      channel_id: 'UCgamma',
      video_count_analyzed: 1,
    }, { adminContext });
    backdate(chId, '-9 days');
    expect(getRow(chId).analysis_fingerprint).toBeNull();

    const run = await runProcessAllChannels();
    expect(run).toMatchObject({
      analyzed: 1,
      failed: 0,
      skipped_no_new_videos: 0,
      synthesized: true,
    });
    expect(llmCalls('channel_analysis')).toBe(1);
    expect(getRow(chId).analysis_fingerprint).toBe(computeChannelAnalysisFingerprint(videosByChannel.UCgamma));
  });

  it('(d) caps auto-retry after 3 consecutive failures to once per 7 days and resets on success', async () => {
    const chId = makeSystemChannel('UCfail');
    // Not resolvable → every analysis attempt fails at channel resolution.

    // Failure 1 (direct).
    const attempt1 = await analyzeChannel(chId);
    expect(attempt1.success).toBe(false);
    expect(getRow(chId)).toMatchObject({ status: 'failed', consecutive_failure_count: 1 });

    // Below the threshold the 12h auto-retry still applies.
    backdate(chId, '-13 hours');
    const run1 = await runProcessAllChannels();
    expect(run1.failed).toBe(1); // retried and failed again
    expect(getRow(chId)).toMatchObject({ status: 'failed', consecutive_failure_count: 2 });

    // Failure 3 → enters backoff.
    await analyzeChannel(chId);
    expect(getRow(chId).consecutive_failure_count).toBe(3);
    expect(vi.mocked(logger.warn).mock.calls.some(
      ([, msg]) => typeof msg === 'string' && msg.includes('entered failure backoff'),
    )).toBe(true);

    // 12h retry suppressed while in backoff.
    backdate(chId, '-13 hours');
    const run2 = await runProcessAllChannels();
    expect(run2).toMatchObject({ analyzed: 0, failed: 0, skipped_no_new_videos: 0 });
    expect(getRow(chId)).toMatchObject({ status: 'failed', consecutive_failure_count: 3 });

    // 7-day retry allowed (still failing → counter keeps climbing).
    backdate(chId, '-8 days');
    const run3 = await runProcessAllChannels();
    expect(run3.failed).toBe(1);
    expect(getRow(chId)).toMatchObject({ status: 'failed', consecutive_failure_count: 4 });

    // Channel becomes healthy → next 7-day retry succeeds and resets the counter.
    resolvableChannels.add('UCfail');
    videosByChannel.UCfail = [video('vid-f1')];
    backdate(chId, '-8 days');
    const run4 = await runProcessAllChannels();
    expect(run4.analyzed).toBe(1);
    const finalRow = getRow(chId);
    expect(finalRow).toMatchObject({ status: 'active', consecutive_failure_count: 0 });
    expect(finalRow.analysis_fingerprint).toBe(computeChannelAnalysisFingerprint(videosByChannel.UCfail));
    expect(vi.mocked(logger.info).mock.calls.some(
      ([, msg]) => typeof msg === 'string' && msg.includes('left failure backoff'),
    )).toBe(true);
  });

  it('(e) makes zero synthesis LLM calls when every channel in the scope is skipped by the new-video gate', async () => {
    const chA = makeSystemChannel('UCe1');
    const chB = makeSystemChannel('UCe2');
    resolvableChannels.add('UCe1').add('UCe2');
    videosByChannel.UCe1 = [video('vid-e11')];
    videosByChannel.UCe2 = [video('vid-e21')];

    const run1 = await runProcessAllChannels();
    expect(run1.analyzed).toBe(2);
    // Two channels contribute hook_style patterns → cross-channel synthesis
    // uses the LLM in the baseline run.
    expect(llmCalls('knowledge_synthesis')).toBe(1);

    backdate(chA, '-9 days');
    backdate(chB, '-9 days');
    completeOneShotWithFallback.mockClear();

    const run2 = await runProcessAllChannels();
    expect(run2).toMatchObject({
      analyzed: 0,
      failed: 0,
      skipped_no_new_videos: 2,
      synthesized: false,
      synthesis_skipped_all_unchanged: true,
    });
    expect(llmCalls('knowledge_synthesis')).toBe(0);
    expect(llmCalls('channel_analysis')).toBe(0);
    expect(llmCalls()).toBe(0);
  });
});
