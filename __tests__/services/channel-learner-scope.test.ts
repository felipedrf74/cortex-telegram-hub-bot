import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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
  writeSignal,
}));

vi.mock('../../src/services/ai-automation-policy', () => ({
  recordAiAutomationEligibilitySkip: vi.fn(),
  resolveAiAutomationEligibility: vi.fn((userId: number) => ({
    allowed: userId === 42,
    reason: userId === 42 ? 'eligible' : 'automation_entitlement_required',
    entitlement: { source: userId === 42 ? 'founder' : 'free' },
  })),
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Ignore optional migration dependencies in focused tests.
      }
    }
  }
}

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
import { analyzeChannel, processAllChannelScopes } from '../../src/services/channel-learner';
import { resolveAiAutomationEligibility } from '../../src/services/ai-automation-policy';

const adminContext = createContentReferencesAdminContext('channel learner scope test');

describe('channel-learner: scoped synthesis', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    completeOneShotWithFallback.mockReset();
    writeSignal.mockReset();

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
        return { json: async () => ({ items: [{ id: 'UCsystem', snippet: { title: 'System Channel' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/search') && href.includes('channelId=UCsystem')) {
        return { json: async () => ({ items: [{ id: { videoId: 'vid-system-1' } }] }) } as Response;
      }
      if (href.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        return {
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
      INSERT INTO content_topic_feedback (
        topic, format, sentiment, source_job, user_id, tenant_id,
        owner_user_id, visibility_scope, scope_status
      ) VALUES ('Consumed shared topic', 'reel', 'approved', 'tuesday_reels', 42, 42, 42, 'user_private', 'active')
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

  it('resynthesizes user knowledge after shared system channels refresh without emitting per-user channel_dna signals', async () => {
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
      INSERT INTO content_topic_feedback (
        topic, format, sentiment, source_job, user_id, tenant_id,
        owner_user_id, visibility_scope, scope_status
      ) VALUES ('Consumed topic', 'reel', 'approved', 'tuesday_reels', 42, 42, 42, 'user_private', 'active')
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
    expect(systemKnowledge?.synthesized_text).toContain('System hook pattern');
    expect(userKnowledge?.user_id).toBe(42);
    expect(userKnowledge?.synthesized_text).toBe('Merged user + system hook guidance');

    expect(writeSignal).toHaveBeenCalled();
    expect(writeSignal.mock.calls.some(([signal]) => signal.user_id === 42)).toBe(false);
  });

  it('skips platform and user YouTube work when no eligible Content automation consumer exists', async () => {
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
    const channelRow = testDb.prepare(
      'SELECT status, analysis_fingerprint FROM content_ref_channels WHERE id = ?',
    ).get(userChannel.id) as { status: string; analysis_fingerprint: string | null };
    expect(channelRow).toEqual({ status: 'failed', analysis_fingerprint: null });
    const patterns = testDb.prepare(
      'SELECT pattern_text FROM content_patterns WHERE channel_id = ?',
    ).all(userChannel.id) as Array<{ pattern_text: string }>;
    expect(patterns.map((pattern) => pattern.pattern_text)).toContain('Prior valid hook pattern');
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
