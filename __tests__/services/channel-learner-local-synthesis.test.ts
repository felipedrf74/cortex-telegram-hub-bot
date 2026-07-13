// Channel synthesis cost control: one cloud request per changed scope. The
// former LOCAL_LLM_CHANNEL_SYNTHESIS experiment stays disabled until a local
// model demonstrates category coverage and actionable-pattern quality parity.
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
  withAiBudgetReservation,
} = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  writeSignal: vi.fn(),
  completeLocalReasoningOneShot: vi.fn(),
  isOllamaConfigured: vi.fn(),
  withAiBudgetReservation: vi.fn(async (_request: unknown, fn: () => Promise<unknown>) => fn()),
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
  withAiBudgetReservation,
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
  PATTERN_CATEGORIES,
  upsertSystemKnowledge,
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

const CLOUD_SYNTH_JSON = JSON.stringify({
  categories: PATTERN_CATEGORIES.map((category) => ({
    category,
    synthesized_text: category === 'hook_style'
      ? 'Merged hook guidance (CLOUD)'
      : category === 'title_pattern'
        ? 'Merged title guidance (CLOUD)'
        : `Merged ${category} guidance (CLOUD)`,
    source_channels: ['Channel UCloc1', 'Channel UCloc2'],
  })),
});

describe('channel-learner: batched cloud synthesis', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    completeOneShotWithFallback.mockReset();
    completeLocalReasoningOneShot.mockReset();
    isOllamaConfigured.mockReset();
    isOllamaConfigured.mockReturnValue(true);
    writeSignal.mockReset();
    withAiBudgetReservation.mockClear();
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
        return { text: CLOUD_SYNTH_JSON, provider: 'gemini' };
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    testDb?.close();
  });

  it('uses one cloud synthesis call for every multi-channel category and ignores the retired local flag', async () => {
    vi.stubEnv('LOCAL_LLM_CHANNEL_SYNTHESIS', 'true');
    seedTwoChannels();

    const run = await runProcessAllChannels();
    expect(run).toMatchObject({
      analyzed: 2,
      failed: 0,
      skipped_no_new_videos: 0,
      synthesized: true,
      synthesis_skipped_all_unchanged: false,
    });

    expect(completeLocalReasoningOneShot).not.toHaveBeenCalled();
    expect(isOllamaConfigured).not.toHaveBeenCalled();
    expect(cloudCalls('knowledge_synthesis')).toBe(1);
    expect(cloudCalls('channel_analysis')).toBe(2);
    for (const extractionCall of completeOneShotWithFallback.mock.calls.filter((call) => call[2] === 'channel_analysis')) {
      expect(extractionCall[4]).toMatchObject({
        model: 'gemini-2.5-flash',
        maxTokens: 2304,
      });
      expect(String(extractionCall[1]).length).toBeLessThanOrEqual(7000);
    }

    const synthCall = completeOneShotWithFallback.mock.calls.find((call) => call[2] === 'knowledge_synthesis')!;
    expect(synthCall[0]).toContain('content strategy synthesizer');
    expect(synthCall[1]).toContain('CATEGORY hook_style (2 creators)');
    expect(synthCall[1]).toContain('CATEGORY title_pattern (2 creators)');
    expect(String(synthCall[1]).length).toBeLessThanOrEqual(6000);
    expect(synthCall[4]).toMatchObject({
      model: 'gemini-2.5-flash',
      maxTokens: 2304,
      userId: 0,
      tenantId: 0,
    });
    const reservations = withAiBudgetReservation.mock.calls.map(([request]) => request as {
      baseCategory?: string;
      jobName?: string;
      runId?: string | null;
    });
    expect(reservations.length).toBeGreaterThan(0);
    expect(new Set(reservations.map((request) => request.baseCategory))).toEqual(new Set(['channel_learning']));
    expect(new Set(reservations.map((request) => request.runId)).size).toBe(1);
    expect(reservations.some((request) => request.jobName?.endsWith(':extract'))).toBe(true);
    expect(reservations.some((request) => request.jobName?.endsWith(':synthesize'))).toBe(true);
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.synthesized_text).toBe('Merged hook guidance (CLOUD)');
    expect(getSystemKnowledgeByCategory('title_pattern', adminContext)?.synthesized_text).toBe('Merged title guidance (CLOUD)');
  });

  it('retains the entire latest valid knowledge set when a batch omits a category', async () => {
    upsertSystemKnowledge('hook_style', 'Previous hook guidance', ['Old A', 'Old B'], adminContext);
    upsertSystemKnowledge('title_pattern', 'Previous title guidance', ['Old A', 'Old B'], adminContext);
    completeOneShotWithFallback.mockImplementation(async (_system, _prompt, jobName) => {
      if (jobName === 'channel_analysis') {
        return {
          text: JSON.stringify({
            channel_summary: 'Summary',
            patterns: PATTERN_CATEGORIES.map((category) => ({
              category,
              pattern_text: `New ${category}`,
              examples: ['Example'],
              confidence: 0.9,
              source_videos: ['vid'],
            })),
          }),
          provider: 'gemini',
        };
      }
      if (jobName === 'knowledge_synthesis') {
        return {
          text: JSON.stringify({ categories: [{
            category: 'hook_style',
            synthesized_text: 'Partial replacement',
            source_channels: ['Channel UCloc1', 'Channel UCloc2'],
          }] }),
          provider: 'gemini',
        };
      }
      throw new Error(`Unexpected job ${jobName}`);
    });
    seedTwoChannels();

    const run = await runProcessAllChannels();

    expect(run).toMatchObject({ synthesized: false, synthesis_deferred: true });
    expect(cloudCalls('knowledge_synthesis')).toBe(1);
    expect(getSystemKnowledgeByCategory('hook_style', adminContext)?.synthesized_text).toBe('Previous hook guidance');
    expect(getSystemKnowledgeByCategory('title_pattern', adminContext)?.synthesized_text).toBe('Previous title guidance');
  });
});
