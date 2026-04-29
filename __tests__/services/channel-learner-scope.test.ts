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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test', model: 'test-model', classifierModel: 'test-classifier' },
  },
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback,
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
  getKnowledgeByCategory,
  updateChannelStatus,
  upsertPatterns,
} from '../../src/state/content-references';
import { processAllChannelScopes } from '../../src/services/channel-learner';

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
            patterns: [
              {
                category: 'hook_style',
                pattern_text: 'System hook pattern',
                examples: ['System example'],
                confidence: 0.92,
                source_videos: ['vid-system-1'],
              },
            ],
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

  it('resynthesizes user knowledge after shared system channels refresh without emitting per-user channel_dna signals', async () => {
    const systemChannel = addChannel('https://www.youtube.com/channel/UCsystem', 'manual', 0);
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
    });
    upsertPatterns(userChannel.id, [
      {
        category: 'hook_style',
        pattern_text: 'User hook pattern',
        examples: ['User example'],
        confidence: 0.88,
        source_videos: ['vid-user-1'],
      },
    ]);

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

    const systemKnowledge = getKnowledgeByCategory('hook_style', 0);
    const userKnowledge = getKnowledgeByCategory('hook_style', 42);

    expect(systemKnowledge?.user_id).toBe(0);
    expect(systemKnowledge?.synthesized_text).toContain('System hook pattern');
    expect(userKnowledge?.user_id).toBe(42);
    expect(userKnowledge?.synthesized_text).toBe('Merged user + system hook guidance');

    expect(writeSignal).toHaveBeenCalled();
    expect(writeSignal.mock.calls.some(([signal]) => signal.user_id === 42)).toBe(false);
  });
});
