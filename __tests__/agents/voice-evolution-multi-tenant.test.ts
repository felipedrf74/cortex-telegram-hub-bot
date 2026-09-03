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

function seedReferenceTranscript(userId: number, videoId: string, text: string): void {
  testDb.prepare(`
    INSERT INTO video_transcripts
      (video_id, title, channel_name, language, full_text, source, user_id, tenant_id,
       owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by,
       updated_by, audit_metadata_json, created_at)
    VALUES (?, ?, 'reference-channel', 'en', ?, 'channel_analysis', ?, ?, ?, 'user_private',
       'active', 'active', ?, ?, '{}', datetime('now'))
  `).run(videoId, `${videoId} title`, text, userId, userId, userId, userId, userId);
}

async function seedCreatorEditPair(
  userId: number,
  key: string,
  creatorText: string,
  generatedText = `agent draft for ${key}`,
): Promise<void> {
  const { saveGeneratedScriptToWorkspace } = await import('../../src/services/content-workspace-capture');
  const { saveContentRevision } = await import('../../src/services/content-workspace');
  const captured = saveGeneratedScriptToWorkspace({
    scope: { userId, tenantId: userId },
    topic: `${key} topic`,
    format: 'reel',
    scriptText: generatedText,
    idempotencyKey: `voice-generated:${userId}:${key}`,
    captureOrigin: 'script_generation',
  });
  saveContentRevision({
    scope: { userId, tenantId: userId },
    artifactId: captured.artifact.id,
    baseRevision: captured.revision.revisionNumber,
    content: { format: 'plain_text', text: creatorText },
    changeSummary: 'Creator edited the generated draft',
    changeReason: 'authenticated_creator_edit',
    actorType: 'user',
    actorId: String(userId),
    provenance: { source: 'authenticated_user_api' },
    idempotencyKey: `voice-creator-edit:${userId}:${key}`,
  });
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

  it('learns only from each tenant’s direct agent-to-user revision pairs', async () => {
    const { saveGeneratedScriptToWorkspace } = await import('../../src/services/content-workspace-capture');
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');

    seedUser(25, 'founder');
    seedUser(28, 'knitter');
    seedUser(30, 'script-only');

    await seedCreatorEditPair(
      25,
      'founder-edit',
      `founder-creator-revision with marathon cadence ${'x'.repeat(3_100)} founder-creator-truncation-tail`,
      `founder-agent-draft strength phrasing ${'s'.repeat(3_100)} founder-agent-truncation-tail`,
    );
    await seedCreatorEditPair(
      28,
      'knitter-edit',
      'knitter-creator-revision with yarn cadence',
      'knitter-agent-draft with generic phrasing',
    );
    saveGeneratedScriptToWorkspace({
      scope: { userId: 30, tenantId: 30 },
      topic: 'Script-only topic',
      format: 'reel',
      scriptText: 'script-only-agent-draft without a creator revision',
      idempotencyKey: 'voice-generated:30:script-only',
      captureOrigin: 'script_generation',
    });

    seedReferenceTranscript(25, 'founder-reference-video', 'reference transcript must never become creator voice');
    seedReferenceTranscript(28, 'knitter-reference-video', 'competitor transcript must never become creator voice');

    mockCompleteOneShotWithFallback.mockImplementation(async (...args: unknown[]) => {
      const prompt = args.find((arg): arg is string => typeof arg === 'string' && arg.includes('CANONICAL CREATOR EDIT PAIRS')) ?? '';
      expect(prompt).not.toContain('reference transcript must never become creator voice');
      expect(prompt).not.toContain('competitor transcript must never become creator voice');
      expect(prompt).not.toContain('published video');
      if (prompt.includes('founder-creator-revision')) {
        expect(prompt).not.toContain('knitter-creator-revision');
        expect(prompt).toContain('founder-agent-draft');
        expect(prompt).not.toContain('founder-creator-truncation-tail');
        expect(prompt).not.toContain('founder-agent-truncation-tail');
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
      if (prompt.includes('knitter-creator-revision')) {
        expect(prompt).not.toContain('founder-creator-revision');
        expect(prompt).toContain('knitter-agent-draft');
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
    await runVoiceEvolutionAgent();

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(2);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(2);
    for (const call of mockCompleteOneShotWithFallback.mock.calls) {
      expect(call[4]).toEqual(expect.objectContaining({
        maxRetries: 0,
        allowFallbackAfterProviderFailure: false,
      }));
    }
    expect(mockCompleteOneShotWithFallback.mock.calls.every((call) => (
      !String(call[1]).includes('script-only-agent-draft')
    ))).toBe(true);

    await seedCreatorEditPair(
      28,
      'knitter-edit-new',
      'knitter-creator-revision with a newly changed stitch cadence',
      'knitter-agent-draft for a new pattern',
    );
    await runVoiceEvolutionAgent();

    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(3);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(3);
    expect(String(mockCompleteOneShotWithFallback.mock.calls[2][1])).toContain('newly changed stitch cadence');
    expect(String(mockCompleteOneShotWithFallback.mock.calls[2][1])).not.toContain('founder-creator-revision');

    // A fourth unchanged run must observe the fingerprint written only after
    // the successful changed-input outputs and make zero additional calls.
    await runVoiceEvolutionAgent();
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(3);
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(3);

    const fingerprints = testDb.prepare(`
      SELECT user_id, tenant_id, payload
      FROM agent_signals
      WHERE signal_type = 'voice_analysis_fingerprint'
      ORDER BY user_id, id
    `).all() as { user_id: number; tenant_id: number; payload: string }[];
    expect(fingerprints).toHaveLength(3);
    expect(fingerprints.map((row) => [row.user_id, row.tenant_id])).toEqual([
      [25, 25],
      [28, 28],
      [28, 28],
    ]);
    expect(fingerprints.every((row) => row.payload.includes('voice-evolution-input-v2'))).toBe(true);

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

  it('makes no provider call for unedited drafts or arbitrary cached transcripts', async () => {
    const { saveGeneratedScriptToWorkspace } = await import('../../src/services/content-workspace-capture');
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'no-edit-evidence');
    saveGeneratedScriptToWorkspace({
      scope: { userId: 25, tenantId: 25 },
      topic: 'Unedited draft',
      format: 'reel',
      scriptText: 'agent-only draft is not creator voice evidence',
      idempotencyKey: 'voice-generated:25:no-edit-evidence',
      captureOrigin: 'script_generation',
    });
    seedReferenceTranscript(25, 'competitor-reference', 'private competitor transcript is not creator evidence');

    await runVoiceEvolutionAgent();

    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_signals
      WHERE user_id = ? AND tenant_id = ?
    `).get(25, 25)).toEqual({ count: 0 });
  });

  it('persists only non-absent book influences grounded in supplied book context and creator text', async () => {
    const { runVoiceEvolutionForTarget } = await import('../../src/agents/voice-evolution-agent');
    const { writeSignal } = await import('../../src/services/intelligence-bus');
    seedUser(25, 'book-grounding');
    await seedCreatorEditPair(
      25,
      'book-grounding',
      'For the next draft, make the cue obvious before asking for action.',
    );
    expect(writeSignal({
      source_agent: 'book-extractor',
      signal_type: 'book_knowledge',
      payload: {
        title: 'Atomic Habits',
        key_concepts: ['make the cue obvious', 'identity habits'],
        summary: 'A framework for shaping repeatable behavior.',
      },
    })).toBeGreaterThan(0);
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify(validVoiceAnalysis({
        book_influences: [
          {
            book_or_concept: 'make the cue obvious',
            how_it_appears: 'make the cue obvious',
            adoption_level: 'integrated',
          },
          {
            book_or_concept: 'identity habits',
            how_it_appears: 'asking for action',
            adoption_level: 'absent',
          },
          {
            book_or_concept: 'Atomic Habits',
            how_it_appears: 'stack a habit after lunch',
            adoption_level: 'emerging',
          },
          {
            book_or_concept: 'invented framework',
            how_it_appears: 'asking for action',
            adoption_level: 'integrated',
          },
        ],
      })),
    });

    await runVoiceEvolutionForTarget({ tenantId: 25, userId: 25 });

    const signal = testDb.prepare(`
      SELECT payload
        FROM agent_signals
       WHERE tenant_id = ? AND user_id = ?
         AND signal_type = 'voice_pattern'
         AND json_extract(payload, '$.observation') = 'book_voice_influence'
       LIMIT 1
    `).get(25, 25) as { payload: string };
    expect(JSON.parse(signal.payload).influences).toEqual([
      expect.objectContaining({
        book_or_concept: 'make the cue obvious',
        adoption_level: 'integrated',
      }),
    ]);
    expect(testDb.prepare(`
      SELECT pattern_text
        FROM content_learned_patterns
       WHERE tenant_id = ? AND user_id = ? AND category = 'book_influence'
       ORDER BY pattern_text
    `).all(25, 25)).toEqual([{ pattern_text: 'make the cue obvious' }]);
  });

  it('persists zero outputs when cancellation arrives after provider dispatch', async () => {
    const { runVoiceEvolutionForTarget } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'post-provider-cancel');
    await seedCreatorEditPair(25, 'post-provider-cancel', 'creator revision must not be persisted after cancellation');

    let resolveProvider!: (result: { text: string }) => void;
    mockCompleteOneShotWithFallback.mockImplementation(() => new Promise((resolve) => {
      resolveProvider = resolve;
    }));
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('account deletion started'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    const outcome = runVoiceEvolutionForTarget(
      { tenantId: 25, userId: 25 },
      { abortSignal: controller.signal },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1));
    controller.abort(cancellation);
    resolveProvider({ text: JSON.stringify(validVoiceAnalysis()) });

    expect(await outcome).toBe(cancellation);
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
  });

  it('rejects syntactically valid JSON that does not satisfy the provider output schema', async () => {
    const { runVoiceEvolutionAgent } = await import('../../src/agents/voice-evolution-agent');
    seedUser(25, 'malformed-provider-output');
    await seedCreatorEditPair(25, 'malformed-provider', 'tenant-private malformed-provider creator revision');
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
    await seedCreatorEditPair(25, 'oversized-provider', 'tenant-private oversized-provider creator revision');
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
    await seedCreatorEditPair(25, 'concurrent-run', 'tenant-private concurrent-run creator revision');

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
    await seedCreatorEditPair(25, 'first-malformed', 'first tenant malformed-output creator revision');
    await seedCreatorEditPair(28, 'second-valid', 'second tenant valid-output creator revision');
    mockCompleteOneShotWithFallback.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      if (prompt.includes('first tenant malformed-output creator revision')) {
        return {
          text: JSON.stringify(validVoiceAnalysis({ recurring_phrases: 'not-an-array' })),
        };
      }
      if (prompt.includes('second tenant valid-output creator revision')) {
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
      'first tenant malformed-output creator revision',
    );
    expect(String(mockCompleteOneShotWithFallback.mock.calls[1][1])).toContain(
      'second tenant valid-output creator revision',
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
    await seedCreatorEditPair(25, 'persistence-failure', 'tenant-private persistence-failure creator revision');
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
    await seedCreatorEditPair(25, 'first-persistence', 'first tenant persistence-failure creator revision');
    await seedCreatorEditPair(28, 'later-must-not-run', 'later tenant must not enter provider prompt');
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
      'first tenant persistence-failure creator revision',
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
    await seedCreatorEditPair(25, 'fingerprint-read-failure', 'tenant-private read-failure creator revision');
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
    await seedCreatorEditPair(25, 'paid', 'paid creator revision');
    await seedCreatorEditPair(28, 'trial', 'trial creator revision must not enter a prompt');
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
    expect(String(mockCompleteOneShotWithFallback.mock.calls[0][1])).toContain('paid creator revision');
    expect(String(mockCompleteOneShotWithFallback.mock.calls[0][1])).not.toContain('trial creator revision');
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
    await seedCreatorEditPair(25, 'scheduled-voice', 'stable scheduled creator revision');
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
    await seedCreatorEditPair(25, 'scheduled-invalid', 'scheduled invalid schema creator revision');
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
