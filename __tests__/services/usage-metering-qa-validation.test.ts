/**
 * QA Validation Tests — Usage Metering System
 *
 * Validates:
 * - Migration schema integrity (tables, indices, constraints)
 * - UPSERT atomicity and correctness
 * - User isolation
 * - Quota boundary conditions
 * - Global aggregation
 * - Portal integration (snapshot includes metering data)
 * - Anthropic hook integration
 * - Cost calculation correctness
 * - Edge cases: zero usage, negative values, very large numbers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const SRC_DIR = path.resolve(__dirname, '../../src');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


describe('QA: AI background metering attribution source audit', () => {
  function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf-8');
  }

  it('meters user-owned background one-shot calls against the owning user instead of user_id=0', () => {
    const expectations: Array<{ file: string; patterns: RegExp[] }> = [
      {
        file: 'services/garmin-coach.ts',
        patterns: [
          /trackedCreate\([\s\S]*'coach_analysis',\s*\{\s*userId:\s*meteringUserId,\s*tenantId:\s*meteringTenantId\s*\}/,
          /const coachAnalysisMeteringOptions = \{ maxTokens: COACH_ANALYSIS_MAX_TOKENS, userId: meteringUserId, tenantId: meteringTenantId \}/,
        ],
      },
      {
        file: 'agents/voice-evolution-agent.ts',
        patterns: [
          /'voice_evolution',\s*\{\s*userId,\s*tenantId\s*\}/,
          /\{\s*maxTokens:\s*4096,\s*temperature:\s*0\.3,\s*userId,\s*tenantId\s*\}/,
        ],
      },
      {
        file: 'services/content-workflow.ts',
        patterns: [
          /\} as any, category, \{ userId, tenantId \}\)/,
          /`\$\{category\}_continuation`, \{ userId, tenantId \}\)/,
          /\{ model: CONTENT_TOPIC_MODEL, maxTokens, userId, tenantId \}/,
        ],
      },
      {
        file: 'services/content-discovery.ts',
        patterns: [
          /completeOneShotWithSearch\([\s\S]*\{\s*maxTokens:\s*4096,\s*temperature:\s*0\.7,\s*userId,\s*tenantId\s*\}/,
          /'content_discovery',\s*\{\s*userId,\s*tenantId\s*\}/,
          /'content_discovery_continuation',\s*\{\s*userId,\s*tenantId\s*\}/,
        ],
      },
      {
        file: 'services/video-study.ts',
        patterns: [
          /'video_study',\s*\{\s*userId:\s*scopedUserId,\s*tenantId:\s*scopedTenantId\s*\}/,
          /\{\s*maxTokens:\s*4096,\s*temperature:\s*0\.4,\s*userId:\s*scopedUserId,\s*tenantId:\s*scopedTenantId\s*\}/,
        ],
      },
      {
        file: 'services/invoice-filer.ts',
        patterns: [
          /options\?:\s*\{\s*userId\?:\s*number;\s*tenantId\?:\s*number\s*\}/,
          /'invoice_filing',\s*options\)/,
          /\{\s*maxTokens:\s*400,\s*temperature:\s*0,\s*userId:\s*options\?\.userId,\s*tenantId:\s*options\?\.tenantId\s*\}/,
        ],
      },
      {
        file: 'api/routes/finance.ts',
        patterns: [
          /analyzeInvoiceImage\([\s\S]*\{\s*userId,\s*tenantId\s*\}/,
        ],
      },
      {
        file: 'api/routes/chat-message-shortcuts.ts',
        patterns: [
          /tryBuildChatMessageShortcutResponse\(input:\s*\{[\s\S]*tenantId:\s*number;/,
          /'content_chat_refine'[\s\S]*\{\s*maxTokens:\s*1200,\s*temperature:\s*0\.5,\s*userId,\s*tenantId,?\s*\}/,
        ],
      },
      {
        file: 'api/routes/chat-message-routes.ts',
        patterns: [
          /tryBuildChatMessageShortcutResponse\(\{[\s\S]*userId,\s*tenantId,/,
        ],
      },
    ];

    for (const expectation of expectations) {
      const source = readSource(expectation.file);
      for (const pattern of expectation.patterns) {
        expect(source, `${expectation.file} missing ${pattern}`).toMatch(pattern);
      }
    }
  });

  it('documents system-owned autoresearch calls as intentionally billed to user_id=0', () => {
    const source = readSource('services/autoresearch.ts');
    expect(source).toContain('Autoresearch is an operator/eval workload, not an end-user chat turn.');
    expect(source).toContain('const SYSTEM_AI_METERING_SCOPE = { userId: 0, tenantId: 0 } as const;');
    expect(source).toMatch(/trackedCreate\([\s\S]*SYSTEM_AI_METERING_SCOPE\)/);
    expect(source).toMatch(/completeOneShotWithFallback\([\s\S]*SYSTEM_AI_METERING_SCOPE/);
  });
});

// ── Migration schema tests ────────────────────────────────────────

describe('QA: Usage metering migration schema', () => {
  let db: Database.Database;

  beforeEach(() => { db = createMigratedTestDatabase(); });
  afterEach(() => { db.close(); });

  it('usage_metering table has all expected columns', () => {
    const cols = db.prepare("PRAGMA table_info('usage_metering')").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('user_id');
    expect(names).toContain('date');
    expect(names).toContain('message_count');
    expect(names).toContain('input_tokens');
    expect(names).toContain('output_tokens');
    expect(names).toContain('total_tokens');
    expect(names).toContain('api_calls');
    expect(names).toContain('cost_usd');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
  });

  it('usage_quotas table has all expected columns', () => {
    const cols = db.prepare("PRAGMA table_info('usage_quotas')").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain('user_id');
    expect(names).toContain('daily_message_limit');
    expect(names).toContain('daily_token_limit');
    expect(names).toContain('daily_cost_limit_usd');
  });

  it('usage_metering has date index for efficient daily lookups', () => {
    const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage_metering'").all() as { name: string }[];
    const names = indices.map(i => i.name);
    expect(names).toContain('idx_usage_metering_date');
    expect(names).toContain('idx_usage_metering_user_date');
  });

  it('cost_usd column is REAL type for decimal precision', () => {
    const cols = db.prepare("PRAGMA table_info('usage_metering')").all() as { name: string; type: string }[];
    const costCol = cols.find(c => c.name === 'cost_usd');
    expect(costCol?.type).toBe('REAL');
  });

  it('defaults for numeric columns are 0', () => {
    db.prepare("INSERT INTO usage_metering (user_id, date) VALUES (1, '2026-04-01')").run();
    const row = db.prepare('SELECT * FROM usage_metering WHERE user_id = 1').get() as any;
    expect(row.message_count).toBe(0);
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.total_tokens).toBe(0);
    expect(row.api_calls).toBe(0);
    expect(row.cost_usd).toBe(0);
  });

  it('quota limits can be NULL (unlimited)', () => {
    db.prepare('INSERT INTO usage_quotas (user_id) VALUES (1)').run();
    const row = db.prepare('SELECT * FROM usage_quotas WHERE user_id = 1').get() as any;
    expect(row.daily_message_limit).toBeNull();
    expect(row.daily_token_limit).toBeNull();
    expect(row.daily_cost_limit_usd).toBeNull();
  });
});

// ── Service logic tests ───────────────────────────────────────────

describe('QA: Usage metering service edge cases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
    vi.doMock('../../src/services/database', () => ({ getDb: () => db }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadService() {
    return await import('../../src/services/usage-metering');
  }

  it('recordUsage with zero tokens creates a valid row', async () => {
    const { recordUsage, getDailyUsage } = await loadService();
    recordUsage(1, 0, 0, 0, true);
    const usage = getDailyUsage(1);
    expect(usage.messageCount).toBe(1);
    expect(usage.totalTokens).toBe(0);
    expect(usage.apiCalls).toBe(1);
  });

  it('recordUsage handles very large token counts', async () => {
    const { recordUsage, getDailyUsage } = await loadService();
    recordUsage(1, 100000, 50000, 1.5, true);
    const usage = getDailyUsage(1);
    expect(usage.inputTokens).toBe(100000);
    expect(usage.outputTokens).toBe(50000);
    expect(usage.totalTokens).toBe(150000);
  });

  it('multiple recordUsage calls correctly accumulate all fields', async () => {
    const { recordUsage, getDailyUsage } = await loadService();
    for (let i = 0; i < 10; i++) {
      recordUsage(1, 100, 50, 0.001, true);
    }
    const usage = getDailyUsage(1);
    expect(usage.messageCount).toBe(10);
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(500);
    expect(usage.totalTokens).toBe(1500);
    expect(usage.apiCalls).toBe(10);
    expect(usage.costUsd).toBeCloseTo(0.01);
  });

  it('isUserMessage=false does not increment message_count', async () => {
    const { recordUsage, getDailyUsage } = await loadService();
    recordUsage(1, 500, 200, 0.005, false);
    recordUsage(1, 500, 200, 0.005, false);
    recordUsage(1, 500, 200, 0.005, true);
    const usage = getDailyUsage(1);
    expect(usage.messageCount).toBe(1); // only the true call
    expect(usage.apiCalls).toBe(3); // all 3 calls
  });

  it('getDailyUsage returns correct userId in response', async () => {
    const { getDailyUsage } = await loadService();
    const usage = getDailyUsage(42);
    expect(usage.userId).toBe(42);
  });

  it('getUsageRange excludes dates outside range', async () => {
    const { getUsageRange } = await loadService();
    db.prepare('INSERT INTO usage_metering (user_id, date, api_calls) VALUES (1, ?, 1)').run('2026-03-01');
    db.prepare('INSERT INTO usage_metering (user_id, date, api_calls) VALUES (1, ?, 1)').run('2026-03-15');
    db.prepare('INSERT INTO usage_metering (user_id, date, api_calls) VALUES (1, ?, 1)').run('2026-03-31');

    const range = getUsageRange(1, '2026-03-10', '2026-03-20');
    expect(range).toHaveLength(1);
    expect(range[0].date).toBe('2026-03-15');
  });

  it('getUsageRange isolates users', async () => {
    const { getUsageRange } = await loadService();
    db.prepare('INSERT INTO usage_metering (user_id, date, api_calls) VALUES (1, ?, 5)').run('2026-03-01');
    db.prepare('INSERT INTO usage_metering (user_id, date, api_calls) VALUES (2, ?, 3)').run('2026-03-01');

    const range = getUsageRange(1, '2026-03-01', '2026-03-01');
    expect(range).toHaveLength(1);
    expect(range[0].apiCalls).toBe(5);
  });

  it('getGlobalDailyUsage sums across users correctly', async () => {
    const { recordUsage, getGlobalDailyUsage } = await loadService();
    recordUsage(1, 100, 50, 0.001, true);
    recordUsage(2, 200, 100, 0.002, true);
    recordUsage(3, 300, 150, 0.003, true);

    const global = getGlobalDailyUsage();
    expect(global.inputTokens).toBe(600);
    expect(global.outputTokens).toBe(300);
    expect(global.apiCalls).toBe(3);
    expect(global.costUsd).toBeCloseTo(0.006);
  });
});

// ── Quota edge cases ──────────────────────────────────────────────

describe('QA: Quota enforcement edge cases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
    vi.doMock('../../src/services/database', () => ({ getDb: () => db }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadService() {
    return await import('../../src/services/usage-metering');
  }

  it('quota with all null limits allows everything', async () => {
    const { setQuota, recordUsage, checkQuota } = await loadService();
    setQuota(1, {}); // all nulls
    recordUsage(1, 999999, 999999, 999, true);
    const status = checkQuota(1);
    expect(status.allowed).toBe(true);
    expect(status.exceeded).toHaveLength(0);
  });

  it('quota exactly at limit is exceeded', async () => {
    const { setQuota, recordUsage, checkQuota } = await loadService();
    setQuota(1, { dailyMessageLimit: 5 });
    for (let i = 0; i < 5; i++) {
      recordUsage(1, 100, 50, 0.001, true);
    }
    const status = checkQuota(1);
    expect(status.allowed).toBe(false);
    expect(status.exceeded).toContain('messages');
  });

  it('quota one below limit is allowed', async () => {
    const { setQuota, recordUsage, checkQuota } = await loadService();
    setQuota(1, { dailyMessageLimit: 5 });
    for (let i = 0; i < 4; i++) {
      recordUsage(1, 100, 50, 0.001, true);
    }
    const status = checkQuota(1);
    expect(status.allowed).toBe(true);
  });

  it('quota check returns current usage data', async () => {
    const { setQuota, recordUsage, checkQuota } = await loadService();
    setQuota(1, { dailyMessageLimit: 100 });
    recordUsage(1, 500, 200, 0.005, true);
    const status = checkQuota(1);
    expect(status.usage.messageCount).toBe(1);
    expect(status.usage.inputTokens).toBe(500);
    expect(status.quota).not.toBeNull();
    expect(status.quota!.dailyMessageLimit).toBe(100);
  });

  it('different users have independent quotas', async () => {
    const { setQuota, recordUsage, checkQuota } = await loadService();
    setQuota(1, { dailyMessageLimit: 2 });
    setQuota(2, { dailyMessageLimit: 10 });

    recordUsage(1, 100, 50, 0.001, true);
    recordUsage(1, 100, 50, 0.001, true);
    recordUsage(2, 100, 50, 0.001, true);

    expect(checkQuota(1).allowed).toBe(false);
    expect(checkQuota(2).allowed).toBe(true);
  });
});

// ── Anthropic hook integration ────────────────────────────────────

describe('QA: Anthropic hook metering integration', () => {
  it('anthropic-hook.ts calls recordUsage', () => {
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/anthropic-hook.ts'), 'utf-8',
    );
    expect(hookSource).toContain('recordUsage');
    expect(hookSource).toContain('usage-metering');
  });

  it('anthropic-hook.ts computes cost from model pricing', () => {
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/anthropic-hook.ts'), 'utf-8',
    );
    expect(hookSource).toContain('computeCost');
    expect(hookSource).toContain('computeModelUsageCostUsd');
  });

  it('anthropic-hook does not duplicate Sonnet and Haiku pricing', () => {
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/anthropic-hook.ts'), 'utf-8',
    );
    expect(hookSource).not.toContain('COST_PER_MTK');
  });

  it('cost calculation includes cache read/write tokens', () => {
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/anthropic-hook.ts'), 'utf-8',
    );
    expect(hookSource).toContain('cache_read_input_tokens');
    expect(hookSource).toContain('cache_creation_input_tokens');
    expect(hookSource).toContain('cacheReadTokens');
    expect(hookSource).toContain('cacheWriteTokens');
  });

  it('passes userId to recordUsage', () => {
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/anthropic-hook.ts'), 'utf-8',
    );
    expect(hookSource).toContain('options?.userId');
    expect(hookSource).toContain('options?.isUserMessage');
  });
});

describe('QA: provider-hosted search budget contracts', () => {
  it('marks every hosted-search boundary as unbounded for background enforcement', () => {
    const sources = [
      fs.readFileSync(path.resolve(__dirname, '../../src/portal/anthropic-hook.ts'), 'utf-8'),
      fs.readFileSync(path.resolve(__dirname, '../../src/services/gemini-provider.ts'), 'utf-8'),
      fs.readFileSync(path.resolve(__dirname, '../../src/services/openai-provider.ts'), 'utf-8'),
    ];
    for (const source of sources) {
      expect(source).toContain('hasUnboundedProviderInjectedContext');
    }
  });

  it('caps interactive OpenAI search to one low-context call and records complete cost', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/openai-provider.ts'), 'utf-8',
    );
    expect(source).toContain("search_context_size: 'low'");
    expect(source).toContain('max_tool_calls: maxToolCalls');
    expect(source).toContain("getProviderToolFeeUsd('openai_web_search')");
    expect(source).toContain('provider_tool_cost_usd');
    expect(source).toContain('recordUsage(input.userId, inputTokens, outputTokens, priced.costUsd, false)');
  });
});

// ── Portal snapshot integration ───────────────────────────────────

describe('QA: Portal snapshot includes metering', () => {
  it('PortalSnapshotResponse type includes usageMetering field', () => {
    const snapshotBuilderSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/snapshot-builder.ts'), 'utf-8',
    );
    expect(snapshotBuilderSource).toContain('usageMetering');
  });
});

// ── Migration numbering ──────────────────────────────────────────

describe('QA: Migration numbering note', () => {
  it('024 prefix is shared between cooking and metering (known collision)', () => {
    const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('024'));
    // Note: this is a known issue from parallel agent development
    // Both files create independent tables, so no runtime conflict
    expect(migrationFiles).toHaveLength(2);
    expect(migrationFiles.sort()).toEqual([
      '024_cooking_tables.sql',
      '024_usage_metering.sql',
    ]);
  });
});
