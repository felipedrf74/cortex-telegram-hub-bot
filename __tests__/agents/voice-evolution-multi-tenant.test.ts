import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

const mockCompleteOneShotWithFallback = vi.fn();
const mockResolveAiAutomationEligibility = vi.fn();
const mockWithAiBudgetReservation = vi.fn(async (_request: unknown, fn: () => Promise<unknown>) => fn());
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test-key', model: 'claude-test' },
    isStaging: false,
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({})),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  GeminiProvider: vi.fn(),
  _sleep: vi.fn(),
  completeOneShot: vi.fn(),
  completeOneShotWithSearch: vi.fn(),
  completeOneShotWithFallback: (...args: unknown[]) => mockCompleteOneShotWithFallback(...args),
  completeVisionOneShot: vi.fn(),
  completeVisionOneShotWithFallback: vi.fn(),
  isGeminiProviderConfigured: vi.fn(() => true),
  scrubSearchGroundingPromptForPrivacy: vi.fn((prompt: string) => prompt),
}));

vi.mock('../../src/services/ai-automation-policy', () => ({
  recordAiAutomationEligibilitySkip: vi.fn(),
  resolveAiAutomationEligibility: (...args: unknown[]) => mockResolveAiAutomationEligibility(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  withAiBudgetReservation: (...args: unknown[]) => mockWithAiBudgetReservation(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mockLogger,
  LOGGER_REDACTION_PATHS: [],
}));

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


function seedUser(id: number, label: string): void {
  testDb.prepare(`
    INSERT INTO users (id, telegram_id, email, username, first_name, tier, status, auth_provider)
    VALUES (?, ?, ?, ?, ?, 'pro', 'active', 'email')
  `).run(id, 10_000 + id, `${label}@example.test`, label, label);
}

function seedTranscript(userId: number, videoId: string, text: string): void {
  testDb.prepare(`
    INSERT INTO video_transcripts
      (video_id, title, channel_name, language, full_text, source, user_id, tenant_id,
       owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by,
       updated_by, audit_metadata_json, created_at)
    VALUES (?, ?, 'test-channel', 'en', ?, 'test', ?, ?, ?, 'user_private',
       'active', 'active', ?, ?, '{}', datetime('now'))
  `).run(videoId, `${videoId} title`, text, userId, userId, userId, userId, userId);
}

describe('Voice Evolution Agent — multi-tenant scope', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockCompleteOneShotWithFallback.mockReset();
    mockResolveAiAutomationEligibility.mockReset();
    mockResolveAiAutomationEligibility.mockReturnValue({
      allowed: true,
      reason: 'eligible',
      entitlement: { source: 'founder' },
    });
    mockWithAiBudgetReservation.mockReset();
    mockWithAiBudgetReservation.mockImplementation(async (_request: unknown, fn: () => Promise<unknown>) => fn());
    Object.values(mockLogger).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
    });

    testDb = createMigratedTestDatabase();

    const { setDbProvider, setScopeAnomalyReporter } = await import('../../src/services/intelligence-bus');
    setDbProvider(() => testDb);
    setScopeAnomalyReporter(null);
  });

  afterEach(async () => {
    const { setDbProvider, setScopeAnomalyReporter } = await import('../../src/services/intelligence-bus');
    setScopeAnomalyReporter(null);
    setDbProvider(() => null as any);
    testDb.close();
  });

  it('builds voice signals from each active tenant’s own transcripts and scripts only', async () => {
    const { storeScript } = await import('../../src/services/content-learning-store');
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');

    seedUser(25, 'founder');
    seedUser(28, 'knitter');

    storeScript({
      userId: 25,
      tenantId: 25,
      topic: 'Founder training topic',
      format: 'reel',
      scriptText: 'founder-only-script strength phrasing',
    });
    storeScript({
      userId: 28,
      tenantId: 28,
      topic: 'Knitting pattern topic',
      format: 'reel',
      scriptText: 'knitter-only-script knitting phrasing',
    });

    seedTranscript(25, 'founder-video', 'founder-only-transcript with marathon cadence');
    seedTranscript(28, 'knitter-video', 'knitter-only-transcript with yarn cadence');

    mockCompleteOneShotWithFallback.mockImplementation(async (...args: unknown[]) => {
      const prompt = args.find((arg): arg is string => typeof arg === 'string' && arg.includes('AI-GENERATED SCRIPTS')) ?? '';
      if (prompt.includes('founder-only-transcript')) {
        expect(prompt).not.toContain('knitter-only-transcript');
        return {
          text: JSON.stringify({
            additions: [{ pattern: 'founder-signal', examples: ['marathon cadence'], frequency: 'often', category: 'argument' }],
            removals: [],
            rephrasing: [],
            recurring_phrases: [{ phrase: 'founder phrase', context: 'training', count: 2 }],
            book_influences: [],
            voice_summary: 'founder summary',
          }),
        };
      }
      if (prompt.includes('knitter-only-transcript')) {
        expect(prompt).not.toContain('founder-only-transcript');
        return {
          text: JSON.stringify({
            additions: [{ pattern: 'knitter-signal', examples: ['yarn cadence'], frequency: 'often', category: 'anecdote' }],
            removals: [],
            rephrasing: [],
            recurring_phrases: [{ phrase: 'knitter phrase', context: 'crafting', count: 2 }],
            book_influences: [],
            voice_summary: 'knitter summary',
          }),
        };
      }
      throw new Error(`unexpected prompt: ${prompt}`);
    });

    await runVoiceEvolutionAgent();

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(2);

    const signals = testDb.prepare(`
      SELECT user_id, tenant_id, signal_type, payload
      FROM agent_signals
      WHERE signal_type IN ('voice_pattern', 'voice_phrase_trend')
      ORDER BY user_id, id
    `).all() as { user_id: number | null; tenant_id: number | null; signal_type: string; payload: string }[];

    expect(signals.every((row) => row.user_id != null && row.tenant_id != null)).toBe(true);

    const founderPayloads = signals.filter((row) => row.user_id === 25).map((row) => row.payload).join('\n');
    const knitterPayloads = signals.filter((row) => row.user_id === 28).map((row) => row.payload).join('\n');

    expect(founderPayloads).toContain('founder-signal');
    expect(founderPayloads).toContain('founder phrase');
    expect(founderPayloads).not.toContain('knitter-signal');
    expect(knitterPayloads).toContain('knitter-signal');
    expect(knitterPayloads).toContain('knitter phrase');
    expect(knitterPayloads).not.toContain('founder-signal');

    const learned = testDb.prepare(`
      SELECT user_id, tenant_id, pattern_text
      FROM content_learned_patterns
      WHERE category = 'voice_addition'
      ORDER BY user_id
    `).all() as { user_id: number; tenant_id: number; pattern_text: string }[];

    expect(learned).toEqual([
      expect.objectContaining({ user_id: 25, tenant_id: 25, pattern_text: 'founder-signal' }),
      expect.objectContaining({ user_id: 28, tenant_id: 28, pattern_text: 'knitter-signal' }),
    ]);
  });

  it('skips Free/trial scopes before data or model work and attributes the paid call as automation', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'paid');
    seedUser(28, 'trial');
    seedTranscript(25, 'paid-video', 'paid transcript');
    seedTranscript(28, 'trial-video', 'trial transcript must not enter a prompt');
    mockResolveAiAutomationEligibility.mockImplementation((userId: number) => ({
      allowed: userId === 25,
      reason: userId === 25 ? 'eligible' : 'automation_entitlement_required',
      entitlement: { source: userId === 25 ? 'stripe' : 'stripe' },
    }));
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify({
        additions: [], removals: [], rephrasing: [], recurring_phrases: [], book_influences: [], voice_summary: 'paid summary',
      }),
    });

    await runVoiceEvolutionAgent();

    expect(mockResolveAiAutomationEligibility).toHaveBeenCalledWith(25, 'content');
    expect(mockResolveAiAutomationEligibility).toHaveBeenCalledWith(28, 'content');
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(String(mockCompleteOneShotWithFallback.mock.calls[0][1])).toContain('paid transcript');
    expect(String(mockCompleteOneShotWithFallback.mock.calls[0][1])).not.toContain('trial transcript');
    expect(mockWithAiBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 25,
      requestSource: 'automation',
      baseCategory: 'voice_evolution',
      jobName: 'voice_evolution',
      automationPriority: 'other',
    }), expect.any(Function));
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: 28 }),
      expect.any(Function),
    );
  });
});
