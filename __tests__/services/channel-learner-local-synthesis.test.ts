// Local-LLM pilot (2026-07-04): LOCAL_LLM_CHANNEL_SYNTHESIS env gate for
// channel-learner knowledge synthesis.
//
// Covers:
//  (a) env on + local success → cloud synthesis provider NOT called for
//      knowledge_synthesis; local one-shot called with category
//      'knowledge_synthesis_local' and the IDENTICAL prompts; result shape
//      identical (knowledge upserted, run result synthesized:true)
//  (b) env on + local throws (capacity) → cloud path runs (fallback proven)
//  (b2) env on + local returns empty output → cloud path runs
//  (c) env off (default) → local one-shot never called, cloud path only
//  (d) env on but Ollama not configured → local one-shot never called
//
// Harness mirrors channel-learner-relearn-gate.test.ts (in-memory SQLite +
// migrations, stubbed YouTube fetch, hoisted provider mocks).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const {
  completeOneShotWithFallback,
  writeSignal,
  completeLocalReasoningOneShot,
  isOllamaConfigured,
} = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  writeSignal: vi.fn(),
  completeLocalReasoningOneShot: vi.fn(),
  isOllamaConfigured: vi.fn(),
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

// channel-learner loads ollama-provider lazily (dynamic import) only when
// the env gate is on — this mock intercepts that import.
vi.mock('../../src/services/ollama-provider', () => ({
  isOllamaConfigured,
  completeLocalReasoningOneShot,
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
  addSystemChannel,
  createContentReferencesAdminContext,
  getSystemKnowledgeByCategory,
} from '../../src/state/content-references';
import { processAllChannels } from '../../src/services/channel-learner';
import { logger } from '../../src/utils/logger';

const adminContext = createContentReferencesAdminContext('channel learner local synthesis test');

type StubVideo = { videoId: string; title: string; publishedAt: string; viewCount: number };

let videosByChannel: Record<string, StubVideo[]>;
let resolvableChannels: Set<string>;

function video(videoId: string, publishedAt = '2026-06-01T00:00:00.000Z', viewCount = 1000): StubVideo {
  return { videoId, title: `Video ${videoId}`, publishedAt, viewCount };
}

function cloudCalls(jobName?: string): number {
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

async function runProcessAllChannels(): Promise<Awaited<ReturnType<typeof processAllChannels>>> {
  vi.useFakeTimers();
  try {
    const resultPromise = processAllChannels(false);
    await vi.runAllTimersAsync();
    return await resultPromise;
  } finally {
    vi.useRealTimers();
  }
}

/** Seed two channels that both contribute hook_style patterns so the
 * multi-channel synthesis LLM path (the pilot target) is exercised. */
function seedTwoChannels(): void {
  makeSystemChannel('UCloc1');
  makeSystemChannel('UCloc2');
  resolvableChannels.add('UCloc1').add('UCloc2');
  videosByChannel.UCloc1 = [video('vid-l11')];
  videosByChannel.UCloc2 = [video('vid-l21')];
}

const LOCAL_SYNTH_JSON = JSON.stringify({
  categories: [{
    category: 'hook_style',
    synthesized_text: 'Merged hook guidance (LOCAL)',
    source_channels: ['Channel UCloc1', 'Channel UCloc2'],
  }],
});

const CLOUD_SYNTH_JSON = JSON.stringify({
  categories: [{
    category: 'hook_style',
    synthesized_text: 'Merged hook guidance (CLOUD)',
    source_channels: ['Channel UCloc1', 'Channel UCloc2'],
  }],
});

describe('channel-learner: LOCAL_LLM_CHANNEL_SYNTHESIS local-first synthesis pilot', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    completeOneShotWithFallback.mockReset();
    completeLocalReasoningOneShot.mockReset();
    isOllamaConfigured.mockReset();
    isOllamaConfigured.mockReturnValue(true);
    writeSignal.mockReset();
    vi.mocked(logger.warn).mockClear();
    videosByChannel = {};
    resolvableChannels = new Set();

    completeOneShotWithFallback.mockImplementation(async (_system, _prompt, jobName) => {
      if (jobName === 'channel_analysis') {
        return {
          text: JSON.stringify({
            channel_summary: 'Summary',
            patterns: [{
              category: 'hook_style',
              pattern_text: 'Hook pattern',
              examples: ['Example'],
              confidence: 0.9,
              source_videos: ['vid'],
            }],
          }),
          provider: 'gemini',
        };
      }
      if (jobName === 'knowledge_synthesis') {
        return { text: CLOUD_SYNTH_JSON, provider: 'gemini' };
      }
      throw new Error(`Unexpected job ${jobName}`);
    });

    completeLocalReasoningOneShot.mockResolvedValue({
      text: LOCAL_SYNTH_JSON,
      stopReason: 'stop',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'qwen3.6:35b-a3b-q4_K_M', fallbackUsed: false },
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    testDb?.close();
  });

  it('(a) env on + local success: cloud synthesis NOT called, prompts identical to the cloud contract, result shape identical', async () => {
    vi.stubEnv('LOCAL_LLM_CHANNEL_SYNTHESIS', 'true');
    seedTwoChannels();

    const run = await runProcessAllChannels();
    // Result shape identical to the cloud path: both channels analyzed and
    // the scope synthesized.
    expect(run).toMatchObject({
      analyzed: 2,
      failed: 0,
      skipped_no_new_videos: 0,
      synthesized: true,
      synthesis_skipped_all_unchanged: false,
    });

    // Local one-shot used for synthesis; cloud synthesis never called.
    // (Extraction still flows through the cloud — the pilot covers ONLY
    // knowledge synthesis.)
    expect(completeLocalReasoningOneShot).toHaveBeenCalledTimes(1);
    expect(cloudCalls('knowledge_synthesis')).toBe(0);
    expect(cloudCalls('channel_analysis')).toBe(2);

    // Category + metering scope + caps flow through.
    const [localSystem, localUser, localCategory, localOpts] = completeLocalReasoningOneShot.mock.calls[0];
    expect(localCategory).toBe('knowledge_synthesis_local');
    expect(localOpts).toMatchObject({ maxTokens: 2048, temperature: 0.3, userId: 0, tenantId: 0 });
    // Prompt content identical to the cloud contract: the synthesis system
    // prompt and per-category user prompt are the same strings the cloud
    // call sites use.
    expect(localSystem).toContain('content strategy synthesizer');
    expect(localUser).toContain('Synthesize the "hook_style" patterns from 2 creators:');

    // The LOCAL synthesis text is what lands in the knowledge base.
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.synthesized_text).toBe('Merged hook guidance (LOCAL)');
  });

  it('(b) env on + local throws (capacity): cloud path runs unchanged with identical prompts', async () => {
    vi.stubEnv('LOCAL_LLM_CHANNEL_SYNTHESIS', 'true');
    completeLocalReasoningOneShot.mockRejectedValue(
      Object.assign(new Error('capacity_exceeded'), { kind: 'capacity_exceeded' }),
    );
    seedTwoChannels();

    const run = await runProcessAllChannels();
    expect(run).toMatchObject({ analyzed: 2, failed: 0, synthesized: true });

    expect(completeLocalReasoningOneShot).toHaveBeenCalledTimes(1);
    expect(cloudCalls('knowledge_synthesis')).toBe(1);
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.synthesized_text).toBe('Merged hook guidance (CLOUD)');

    // Fallback is observable and prompts are byte-identical across paths.
    expect(vi.mocked(logger.warn).mock.calls.some(
      ([, msg]) => typeof msg === 'string' && msg.includes('Local channel synthesis failed'),
    )).toBe(true);
    const [localSystem, localUser] = completeLocalReasoningOneShot.mock.calls[0];
    const cloudSynthCall = completeOneShotWithFallback.mock.calls.find((call) => call[2] === 'knowledge_synthesis')!;
    expect(cloudSynthCall[0]).toBe(localSystem);
    expect(cloudSynthCall[1]).toBe(localUser);
  });

  it('(b2) env on + local returns empty output: cloud path runs', async () => {
    vi.stubEnv('LOCAL_LLM_CHANNEL_SYNTHESIS', 'true');
    completeLocalReasoningOneShot.mockResolvedValue({ text: '   \n', stopReason: 'stop' });
    seedTwoChannels();

    const run = await runProcessAllChannels();
    expect(run).toMatchObject({ analyzed: 2, failed: 0, synthesized: true });
    expect(completeLocalReasoningOneShot).toHaveBeenCalledTimes(1);
    expect(cloudCalls('knowledge_synthesis')).toBe(1);
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.synthesized_text).toBe('Merged hook guidance (CLOUD)');
    expect(vi.mocked(logger.warn).mock.calls.some(
      ([, msg]) => typeof msg === 'string' && msg.includes('empty output'),
    )).toBe(true);
  });

  it('(c) env off (default): local one-shot is never called and the cloud path is untouched', async () => {
    // LOCAL_LLM_CHANNEL_SYNTHESIS deliberately unset.
    seedTwoChannels();

    const run = await runProcessAllChannels();
    expect(run).toMatchObject({ analyzed: 2, failed: 0, synthesized: true });
    expect(completeLocalReasoningOneShot).not.toHaveBeenCalled();
    expect(isOllamaConfigured).not.toHaveBeenCalled();
    expect(cloudCalls('knowledge_synthesis')).toBe(1);
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.synthesized_text).toBe('Merged hook guidance (CLOUD)');
  });

  it('(d) env on but Ollama not configured: local one-shot never called, cloud path runs', async () => {
    vi.stubEnv('LOCAL_LLM_CHANNEL_SYNTHESIS', 'true');
    isOllamaConfigured.mockReturnValue(false);
    seedTwoChannels();

    const run = await runProcessAllChannels();
    expect(run).toMatchObject({ analyzed: 2, failed: 0, synthesized: true });
    expect(completeLocalReasoningOneShot).not.toHaveBeenCalled();
    expect(cloudCalls('knowledge_synthesis')).toBe(1);
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.synthesized_text).toBe('Merged hook guidance (CLOUD)');
  });
});
