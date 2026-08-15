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
  default: vi.fn(function AnthropicSdkMock() {
    return {};
  }),
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
  AiBudgetError: class AiBudgetError extends Error {},
  withAiBudgetReservation: (...args: unknown[]) => mockWithAiBudgetReservation(...args),
}));

vi.mock('../../src/services/skill-inference-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/skill-inference-service')>(
    '../../src/services/skill-inference-service',
  )),
  runWithSkillInferenceAccountAdmission: (
    input: { abortSignal?: AbortSignal },
    operation: (signal: AbortSignal) => Promise<unknown>,
  ) => operation(input.abortSignal ?? new AbortController().signal),
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

function validVoiceAnalysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    additions: [],
    removals: [],
    rephrasing: [],
    recurring_phrases: [],
    book_influences: [],
    voice_summary: 'valid scoped voice summary',
    ...overrides,
  };
}

async function captureAggregateFailure(run: Promise<void>): Promise<AggregateError> {
  const result = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(AggregateError);
  return result as AggregateError;
}

async function captureFailure(run: Promise<void>): Promise<Error & { cause?: unknown }> {
  const result = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  return result as Error & { cause?: unknown };
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
    const { saveGeneratedScriptToWorkspace } = await import('../../src/services/content-workspace-capture');
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');

    seedUser(25, 'founder');
    seedUser(28, 'knitter');
    seedUser(30, 'script-only');

    saveGeneratedScriptToWorkspace({
      scope: { userId: 25, tenantId: 25 },
      topic: 'Founder training topic',
      format: 'reel',
      scriptText: `founder-only-script strength phrasing ${'s'.repeat(3_100)} founder-script-truncation-tail`,
      captureOrigin: 'script_generation',
    });
    saveGeneratedScriptToWorkspace({
      scope: { userId: 28, tenantId: 28 },
      topic: 'Knitting pattern topic',
      format: 'reel',
      scriptText: 'knitter-only-script knitting phrasing',
      captureOrigin: 'script_generation',
    });
    saveGeneratedScriptToWorkspace({
      scope: { userId: 30, tenantId: 30 },
      topic: 'Script-only topic',
      format: 'reel',
      scriptText: 'script-only-script without a transcript',
      captureOrigin: 'script_generation',
    });

    seedTranscript(
      25,
      'founder-video',
      `founder-only-transcript with marathon cadence ${'x'.repeat(2_100)} founder-truncation-tail`,
    );
    seedTranscript(25, 'founder-video-companion', 'founder-companion-transcript');
    seedTranscript(28, 'knitter-video', 'knitter-only-transcript with yarn cadence');

    mockCompleteOneShotWithFallback.mockImplementation(async (...args: unknown[]) => {
      const prompt = args.find((arg): arg is string => typeof arg === 'string' && arg.includes('AI-GENERATED SCRIPTS')) ?? '';
      if (prompt.includes('founder-only-transcript')) {
        expect(prompt).not.toContain('knitter-only-transcript');
        expect(prompt).toContain('founder-companion-transcript');
        expect(prompt).toContain('\n\n===');
        expect(prompt).not.toContain('founder-truncation-tail');
        expect(prompt).not.toContain('founder-script-truncation-tail');
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
      if (prompt.includes('script-only-script')) {
        expect(prompt).toContain('No published transcripts available for this period.');
        return {
          text: JSON.stringify(validVoiceAnalysis({ voice_summary: 'script-only summary' })),
        };
      }
      throw new Error(`unexpected prompt: ${prompt}`);
    });

    await runVoiceEvolutionAgent();
    await runVoiceEvolutionAgent();

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(3);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(3);
    expect(String(mockCompleteOneShotWithFallback.mock.calls[2][1])).toContain('script-only-script');
    expect(String(mockCompleteOneShotWithFallback.mock.calls[2][1])).not.toContain('founder-only-transcript');

    seedTranscript(28, 'knitter-video-new', 'knitter-only-transcript with a newly changed stitch cadence');
    await runVoiceEvolutionAgent();

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(4);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(4);
    expect(String(mockCompleteOneShotWithFallback.mock.calls[3][1])).toContain('newly changed stitch cadence');
    expect(String(mockCompleteOneShotWithFallback.mock.calls[3][1])).not.toContain('founder-only-transcript');

    // A fourth unchanged run must observe the fingerprint written only after
    // the successful changed-input outputs and make zero additional calls.
    await runVoiceEvolutionAgent();
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(4);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(4);

    const fingerprints = testDb.prepare(`
      SELECT user_id, tenant_id, payload
      FROM agent_signals
      WHERE signal_type = 'voice_analysis_fingerprint'
      ORDER BY user_id, id
    `).all() as { user_id: number; tenant_id: number; payload: string }[];
    expect(fingerprints).toHaveLength(4);
    expect(fingerprints.map((row) => [row.user_id, row.tenant_id])).toEqual([
      [25, 25],
      [28, 28],
      [28, 28],
      [30, 30],
    ]);
    expect(fingerprints.every((row) => !row.payload.includes('transcript'))).toBe(true);

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

  it('rejects syntactically valid JSON that does not satisfy the provider output schema', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'malformed-provider-output');
    seedTranscript(25, 'malformed-provider-video', 'tenant-private malformed-provider transcript');
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify(validVoiceAnalysis({
        additions: [{
          pattern: 'invalid frequency must not be processed',
          examples: ['private example'],
          frequency: 'always',
          category: 'argument',
        }],
      })),
    });

    const failure = await captureAggregateFailure(runVoiceEvolutionAgent());
    expect((failure.errors[0] as Error).message).toContain(
      'Voice Evolution provider schema invalid at $.additions[0].frequency',
    );

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_signals
      WHERE user_id = ? AND tenant_id = ?
    `).get(25, 25)).toEqual({ count: 0 });
  });

  it.each([
    {
      label: 'top-level array cardinality',
      analysis: validVoiceAnalysis({
        additions: Array.from({ length: 21 }, (_, index) => ({
          pattern: `bounded pattern ${index}`,
          examples: ['bounded example'],
          frequency: 'often',
          category: 'argument',
        })),
      }),
      expectedMessage: 'Voice Evolution provider schema invalid at $.additions: exceeds 20 items',
    },
    {
      label: 'field length',
      analysis: validVoiceAnalysis({ voice_summary: 'x'.repeat(2_001) }),
      expectedMessage: 'Voice Evolution provider schema invalid at $.voice_summary: exceeds 2000 characters',
    },
  ])('rejects otherwise valid JSON exceeding the $label limit', async ({ analysis, expectedMessage }) => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'oversized-provider-output');
    seedTranscript(25, 'oversized-provider-video', 'tenant-private oversized-provider transcript');
    mockCompleteOneShotWithFallback.mockResolvedValue({ text: JSON.stringify(analysis) });

    const failure = await captureAggregateFailure(runVoiceEvolutionAgent());
    expect((failure.errors[0] as Error).message).toContain(expectedMessage);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_signals
      WHERE user_id = ? AND tenant_id = ?
    `).get(25, 25)).toEqual({ count: 0 });
  });

  it('serializes concurrent identical tenant runs into one reservation, provider call, and output set', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'concurrent-run');
    seedTranscript(25, 'concurrent-run-video', 'tenant-private concurrent-run transcript');

    let resolveProvider!: (result: { text: string }) => void;
    mockCompleteOneShotWithFallback.mockImplementation(() => new Promise((resolve) => {
      resolveProvider = resolve;
    }));

    const firstRun = runVoiceEvolutionAgent();
    await vi.waitFor(() => expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1));
    const overlappingRun = runVoiceEvolutionAgent();
    await vi.waitFor(() => expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(1));

    resolveProvider({ text: JSON.stringify(validVoiceAnalysis()) });
    await Promise.all([firstRun, overlappingRun]);

    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(1);
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(testDb.prepare(`
      SELECT signal_type, COUNT(*) AS count
      FROM agent_signals
      WHERE user_id = ? AND tenant_id = ?
      GROUP BY signal_type
      ORDER BY signal_type
    `).all(25, 25)).toEqual([
      { signal_type: 'voice_analysis_fingerprint', count: 1 },
      { signal_type: 'voice_pattern', count: 1 },
    ]);
  });

  it('attempts later tenants before surfacing an aggregate provider-schema failure', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'first-malformed');
    seedUser(28, 'second-valid');
    seedTranscript(25, 'first-malformed-video', 'first tenant malformed-output transcript');
    seedTranscript(28, 'second-valid-video', 'second tenant valid-output transcript');
    mockCompleteOneShotWithFallback.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      if (prompt.includes('first tenant malformed-output transcript')) {
        return {
          text: JSON.stringify(validVoiceAnalysis({ recurring_phrases: 'not-an-array' })),
        };
      }
      if (prompt.includes('second tenant valid-output transcript')) {
        return {
          text: JSON.stringify(validVoiceAnalysis({ voice_summary: 'second tenant persisted summary' })),
        };
      }
      throw new Error('unexpected tenant prompt');
    });

    const failure = await captureAggregateFailure(runVoiceEvolutionAgent());

    expect(failure.message).toContain('after all targets were attempted (1/2)');
    expect((failure.errors[0] as Error).message).toContain(
      'Voice Evolution provider schema invalid at $.recurring_phrases: expected array',
    );
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(2);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(2);
    expect(String(mockCompleteOneShotWithFallback.mock.calls[0][1])).toContain(
      'first tenant malformed-output transcript',
    );
    expect(String(mockCompleteOneShotWithFallback.mock.calls[1][1])).toContain(
      'second tenant valid-output transcript',
    );
    expect(testDb.prepare(`
      SELECT user_id, tenant_id, signal_type
      FROM agent_signals
      ORDER BY user_id, id
    `).all()).toEqual([
      { user_id: 28, tenant_id: 28, signal_type: 'voice_pattern' },
      { user_id: 28, tenant_id: 28, signal_type: 'voice_analysis_fingerprint' },
    ]);
  });

  it('rolls back signals and learned patterns when the final fingerprint write fails', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'persistence-failure');
    seedTranscript(25, 'persistence-failure-video', 'tenant-private persistence-failure transcript');
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify(validVoiceAnalysis({
        additions: [{
          pattern: 'retryable learned pattern',
          examples: ['retryable example'],
          frequency: 'often',
          category: 'argument',
        }],
      })),
    });
    testDb.exec(`
      CREATE TRIGGER fail_voice_fingerprint_insert
      BEFORE INSERT ON agent_signals
      WHEN NEW.signal_type = 'voice_analysis_fingerprint'
      BEGIN
        SELECT RAISE(ABORT, 'injected final fingerprint failure');
      END
    `);

    const failure = await captureFailure(runVoiceEvolutionAgent());
    expect(failure.name).toBe('VoiceEvolutionPersistenceError');
    expect(failure.message).toBe('Voice Evolution governed output transaction failed');
    expect((failure.cause as Error).message).toContain(
      'Voice Evolution failed to persist voice_analysis_fingerprint output',
    );

    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_signals
      WHERE user_id = ? AND tenant_id = ?
    `).get(25, 25)).toEqual({ count: 0 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM content_learned_patterns
      WHERE user_id = ? AND tenant_id = ?
    `).get(25, 25)).toEqual({ count: 0 });

    // The same input remains retryable because the fingerprint was not written.
    testDb.exec('DROP TRIGGER fail_voice_fingerprint_insert');
    await runVoiceEvolutionAgent();
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(2);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_signals
      WHERE signal_type = 'voice_analysis_fingerprint'
        AND user_id = ?
        AND tenant_id = ?
    `).get(25, 25)).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_signals
      WHERE user_id = ? AND tenant_id = ?
    `).get(25, 25)).toEqual({ count: 3 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM content_learned_patterns
      WHERE user_id = ?
        AND tenant_id = ?
        AND pattern_text = 'retryable learned pattern'
    `).get(25, 25)).toEqual({ count: 1 });
  });

  it('aborts later tenants after a typed governed persistence failure', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'first-persistence-failure');
    seedUser(28, 'later-must-not-run');
    seedTranscript(25, 'first-persistence-video', 'first tenant persistence-failure transcript');
    seedTranscript(28, 'later-must-not-run-video', 'later tenant must not enter provider prompt');
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify(validVoiceAnalysis({
        additions: [{
          pattern: 'must roll back before abort',
          examples: ['rollback evidence'],
          frequency: 'often',
          category: 'argument',
        }],
      })),
    });
    testDb.exec(`
      CREATE TRIGGER fail_first_voice_fingerprint_insert
      BEFORE INSERT ON agent_signals
      WHEN NEW.signal_type = 'voice_analysis_fingerprint'
      BEGIN
        SELECT RAISE(ABORT, 'injected global persistence failure');
      END
    `);

    const failure = await captureFailure(runVoiceEvolutionAgent());

    expect(failure.name).toBe('VoiceEvolutionPersistenceError');
    expect((failure.cause as Error).message).toContain(
      'Voice Evolution failed to persist voice_analysis_fingerprint output',
    );
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(1);
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(String(mockCompleteOneShotWithFallback.mock.calls[0][1])).toContain(
      'first tenant persistence-failure transcript',
    );
    expect(String(mockCompleteOneShotWithFallback.mock.calls[0][1])).not.toContain(
      'later tenant must not enter provider prompt',
    );
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_signals
      WHERE user_id IN (?, ?)
    `).get(25, 28)).toEqual({ count: 0 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM content_learned_patterns
      WHERE user_id IN (?, ?)
    `).get(25, 28)).toEqual({ count: 0 });
  });

  it('fails closed without budget or provider work when the fingerprint read fails', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'fingerprint-read-failure');
    seedTranscript(25, 'fingerprint-read-failure-video', 'tenant-private read-failure transcript');
    testDb.exec('ALTER TABLE agent_signals RENAME TO agent_signals_unavailable');

    await expect(runVoiceEvolutionAgent()).rejects.toThrow(
      'Voice Evolution fingerprint read failed; provider call blocked',
    );

    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
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

  it('audits scheduled usage by run id and makes zero calls for the unchanged tenant fingerprint', async () => {
    const { runScheduledVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'scheduled-voice');
    seedTranscript(25, 'scheduled-voice-video', 'stable scheduled voice transcript');
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify(validVoiceAnalysis()),
    });
    mockWithAiBudgetReservation.mockImplementation(async (request: any, fn: () => Promise<unknown>) => {
      const result = await fn();
      testDb.prepare(`
        INSERT INTO api_usage (
          category, model, tenant_id, user_id, cost_usd, provider,
          request_source, job_name, base_category, run_id
        ) VALUES ('voice_evolution', 'test-model', 25, 25, 0.02, 'gemini',
                  'automation', 'voice_evolution', 'voice_evolution', ?)
      `).run(request.runId);
      return result;
    });

    await runScheduledVoiceEvolutionAgent();
    await runScheduledVoiceEvolutionAgent();

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({ runId: expect.any(String) }),
      expect.any(Function),
    );
    expect(testDb.prepare(`
      SELECT status, provider_calls, cost_usd, skip_reason
        FROM agent_job_runs
       WHERE job_id = 'voice_evolution'
       ORDER BY id
    `).all()).toEqual([
      { status: 'success', provider_calls: 1, cost_usd: 0.02, skip_reason: null },
      {
        status: 'skipped_unchanged',
        provider_calls: 0,
        cost_usd: 0,
        skip_reason: 'domain_fingerprint_unchanged',
      },
    ]);
  });

  it('audits a scheduled provider-schema failure and keeps it retryable', async () => {
    const { runScheduledVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'scheduled-invalid-voice');
    seedTranscript(25, 'scheduled-invalid-video', 'scheduled invalid schema transcript');
    mockCompleteOneShotWithFallback.mockResolvedValue({ text: JSON.stringify({ voice_summary: 'incomplete' }) });
    mockWithAiBudgetReservation.mockImplementation(async (request: any, fn: () => Promise<unknown>) => {
      const result = await fn();
      testDb.prepare(`
        INSERT INTO api_usage (
          category, model, tenant_id, user_id, cost_usd, provider,
          request_source, job_name, base_category, run_id
        ) VALUES ('voice_evolution', 'test-model', 25, 25, 0.02, 'gemini',
                  'automation', 'voice_evolution', 'voice_evolution', ?)
      `).run(request.runId);
      return result;
    });

    await expect(runScheduledVoiceEvolutionAgent()).rejects.toBeInstanceOf(AggregateError);

    expect(testDb.prepare(`
      SELECT status, provider_calls, error_code, output_fingerprint
        FROM agent_job_runs
       WHERE job_id = 'voice_evolution'
    `).get()).toEqual({
      status: 'failed',
      provider_calls: 1,
      error_code: 'VoiceEvolutionProviderSchemaError',
      output_fingerprint: null,
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM agent_signals
       WHERE source_agent = 'voice-evolution'
         AND signal_type = 'voice_analysis_fingerprint'
    `).get()).toEqual({ count: 0 });
  });
});
