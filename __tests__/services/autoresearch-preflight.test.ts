// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for the autoresearch pre-flight skip gate (src/services/autoresearch.ts).
 *
 * The scheduled evaluate-only run must SKIP (zero model calls) whenever the
 * prompt/config fingerprint is unchanged and a prior valid score exists,
 * regardless of that score. Propose/apply mode keeps the configurable quality
 * threshold. Hash changes, missing/legacy-NULL history, and { force: true }
 * trigger a run. Completed runs persist the end-of-run prompt hash + score.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: { anthropic: { apiKey: 'test-key-not-real' } },
}));

// Controllable in-memory "prompt file" so tests can change the prompt
// content (and therefore the fingerprint) between seeded run and gate check.
const promptState = vi.hoisted(() => ({
  content: 'PROMPT V1',
  writePrompt: vi.fn((_: string, content: string) => {
    promptState.content = content;
  }),
}));

vi.mock('../../src/utils/prompt-loader', () => ({
  loadPrompt: vi.fn(() => promptState.content),
  writePrompt: promptState.writePrompt,
  getPromptPath: vi.fn((name: string) => `/tmp/test-prompts/${name}.md`),
}));

const TEST_TARGET = vi.hoisted(() => ({
  id: 'secretary',
  promptFile: 'secretary',
  description: 'test target',
  model: 'claude-sonnet-4-6',
  scorerModel: 'claude-haiku-4-5-20251001',
  maxTokens: 256,
  criteria: [{ id: 'crit1', question: 'Is it good?', weight: 1 }],
  testInputs: [{ id: 'input1', userMessage: 'hello', description: 'basic input' }],
}));

const TOPIC_TARGET = vi.hoisted(() => ({
  id: 'topic_gen',
  promptFile: 'topic-generation',
  description: 'topic generation',
  model: 'claude-haiku-4-5-20251001',
  scorerModel: 'claude-haiku-4-5-20251001',
  maxTokens: 2048,
  criteria: [
    { id: 'complete_fields', question: 'Matches the live contract?', weight: 2 },
    { id: 'quality', question: 'Are the ideas high quality?', weight: 1 },
  ],
  testInputs: [
    { id: 'topic1', userMessage: 'topics one', description: 'one' },
    { id: 'topic2', userMessage: 'topics two', description: 'two' },
    { id: 'topic3', userMessage: 'topics three', description: 'three' },
  ],
}));

vi.mock('../../src/services/eval-criteria', () => ({
  getEvalTarget: vi.fn((id: string) => (
    id === TEST_TARGET.id ? TEST_TARGET
      : id === TOPIC_TARGET.id ? TOPIC_TARGET
        : undefined
  )),
  getAllTargets: vi.fn(() => [TEST_TARGET, TOPIC_TARGET]),
}));

// Every LLM call in autoresearch (generate, score, mutate) goes through
// completeOneShotWithFallback — counting its invocations counts LLM calls.
const provider = vi.hoisted(() => ({
  calls: [] as string[],
  scorePassed: true,
  invalidScore: false,
  staleTopicAliases: false,
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: vi.fn(async (_system: string, _user: string, scope: string) => {
    provider.calls.push(scope);
    if (scope === 'autoresearch_gen_topic_gen') {
      if (provider.staleTopicAliases) {
        return {
          text: JSON.stringify([{
            title: 'A stale-contract topic',
            niche: 'product',
            why_now: 'Relevant now',
            hook_idea: 'Start with proof',
            angleTag: 'framework',
            pillar_emoji: '',
            time_sensitivity: 'evergreen',
          }]),
        };
      }
      return {
        text: JSON.stringify([{
          title: 'A useful topic',
          niche: 'product',
          whyNow: 'Relevant now',
          hookIdea: 'Start with proof',
          angle_tag: 'framework',
          pillar_emoji: '',
          time_sensitivity: 'evergreen',
        }]),
      };
    }
    if (scope.startsWith('autoresearch_gen')) return { text: 'generated output' };
    if (scope === 'autoresearch_score') {
      if (provider.invalidScore) return { text: '{not valid json' };
      const inputs = scope && _user.includes('topic1')
        ? ['topic1', 'topic2', 'topic3'].map((inputId) => ({
          inputId,
          criteria: [{ id: 'quality', passed: provider.scorePassed }],
        }))
        : [{ inputId: 'input1', criteria: [{ id: 'crit1', passed: provider.scorePassed }] }];
      return { text: JSON.stringify(inputs) };
    }
    if (scope === 'autoresearch_mutate') {
      return { text: JSON.stringify({ description: 'test tweak', mutated_prompt: 'PROMPT MUTATED' }) };
    }
    return { text: '' };
  }),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  withAiBudgetReservation: vi.fn(async (_request: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

import { runAutoresearch, computePromptStateHash } from '../../src/services/autoresearch';
import { getEvalTarget, EvalTarget } from '../../src/services/eval-criteria';
import { withAiBudgetReservation } from '../../src/services/cost-guardrail';

const target = (): EvalTarget => getEvalTarget('secretary')!;

function seedCompletedRun(
  promptHash: string | null,
  finalScore: number | null,
  targetId = 'secretary',
): void {
  testDb.prepare(`
    INSERT INTO autoresearch_experiments
      (target, round_number, run_id, baseline_score, new_score, improvement,
       mutation_description, prompt_diff, decision, test_inputs_count,
       eval_details, git_commit_hash, duration_ms, prompt_hash, final_score)
    VALUES (?, 1, ?, 0.8, NULL, NULL, NULL, NULL, 'baseline_only', 1,
            '[]', NULL, 100, ?, ?)
  `).run(targetId, `seed-run-${Math.random().toString(36).slice(2)}`, promptHash, finalScore);
}

function latestRow(): { prompt_hash: string | null; final_score: number | null } {
  return testDb.prepare(
    'SELECT prompt_hash, final_score FROM autoresearch_experiments ORDER BY id DESC LIMIT 1',
  ).get() as { prompt_hash: string | null; final_score: number | null };
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  promptState.content = 'PROMPT V1';
  provider.calls = [];
  provider.scorePassed = true;
  provider.invalidScore = false;
  provider.staleTopicAliases = false;
  promptState.writePrompt.mockClear();
  vi.mocked(withAiBudgetReservation).mockClear();
  delete process.env.AUTORESEARCH_RESCORE_THRESHOLD;
});

afterEach(() => {
  testDb.close();
  delete process.env.AUTORESEARCH_RESCORE_THRESHOLD;
  vi.unstubAllEnvs();
});

describe('autoresearch pre-flight skip gate', () => {
  it('skips with zero LLM calls when prompt hash is unchanged and stored score >= threshold', async () => {
    seedCompletedRun(computePromptStateHash(target()), 0.95);

    const progressMessages: string[] = [];
    const result = await runAutoresearch('secretary', 3, true, async (msg) => {
      progressMessages.push(msg);
    });

    expect(result.skipped).toBe('skipped_unchanged');
    expect(result.rounds).toHaveLength(0);
    expect(result.finalScore).toBe(0.95);
    expect(provider.calls).toHaveLength(0);

    // Scheduler contract: rounds/finalScore/totalDurationMs stay consumable
    // and onProgress still receives a message.
    expect(Array.isArray(result.rounds)).toBe(true);
    expect(typeof result.finalScore).toBe('number');
    expect(typeof result.totalDurationMs).toBe('number');
    expect(typeof result.runId).toBe('string');
    expect(progressMessages.some((m) => m.includes('skipped'))).toBe(true);
  });

  it('runs when the prompt hash changed since the last run', async () => {
    seedCompletedRun(computePromptStateHash(target()), 0.95);
    promptState.content = 'PROMPT V2'; // prompt edited since last run

    const result = await runAutoresearch('secretary', 3, true);

    expect(result.skipped).toBeUndefined();
    // 1 test input, all criteria pass -> baseline eval (1 gen + 1 score),
    // score 1.0 >= 0.99 early-exit, no mutation call.
    expect(provider.calls).toEqual(['autoresearch_gen_secretary', 'autoresearch_score']);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].decision).toBe('baseline_only');
  });

  it('runs when the stored score is below the threshold even if the hash matches', async () => {
    seedCompletedRun(computePromptStateHash(target()), 0.5);

    const result = await runAutoresearch('secretary', 3, true);

    expect(result.skipped).toBeUndefined();
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it('force flag bypasses the gate even when hash matches and score is high', async () => {
    seedCompletedRun(computePromptStateHash(target()), 0.95);

    const result = await runAutoresearch('secretary', 3, true, undefined, { force: true });

    expect(result.skipped).toBeUndefined();
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it('runs when there is no prior history for the target (first run)', async () => {
    const result = await runAutoresearch('secretary', 3, true);

    expect(result.skipped).toBeUndefined();
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it('runs when the latest history row has legacy NULL fingerprint columns', async () => {
    seedCompletedRun(null, null);

    const result = await runAutoresearch('secretary', 3, true);

    expect(result.skipped).toBeUndefined();
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it('respects AUTORESEARCH_RESCORE_THRESHOLD: skips at default 0.9, runs when raised above stored score', async () => {
    seedCompletedRun(computePromptStateHash(target()), 0.92);

    const skippedResult = await runAutoresearch('secretary', 3, true);
    expect(skippedResult.skipped).toBe('skipped_unchanged');
    expect(provider.calls).toHaveLength(0);

    process.env.AUTORESEARCH_RESCORE_THRESHOLD = '0.95';
    const ranResult = await runAutoresearch('secretary', 3, true);
    expect(ranResult.skipped).toBeUndefined();
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it('persists the end-of-run prompt hash and final score for the next gate check', async () => {
    const result = await runAutoresearch('secretary', 3, true);
    expect(result.skipped).toBeUndefined();

    const row = latestRow();
    expect(row.prompt_hash).toBe(computePromptStateHash(target()));
    expect(row.final_score).toBe(result.finalScore);
    expect(row.final_score).toBe(1); // all criteria passed

    // The very next scheduled run for the unchanged prompt now skips.
    provider.calls = [];
    const secondRun = await runAutoresearch('secretary', 3, true);
    expect(secondRun.skipped).toBe('skipped_unchanged');
    expect(secondRun.finalScore).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it('a skipped run writes no new experiment rows', async () => {
    seedCompletedRun(computePromptStateHash(target()), 0.95);
    const before = (testDb.prepare('SELECT COUNT(*) AS n FROM autoresearch_experiments').get() as { n: number }).n;

    await runAutoresearch('secretary', 3, true);

    const after = (testDb.prepare('SELECT COUNT(*) AS n FROM autoresearch_experiments').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('hash changes when eval-target config changes even if the prompt is identical', () => {
    const baseHash = computePromptStateHash(target());
    const modified = {
      ...target(),
      criteria: [...target().criteria, { id: 'crit2', question: 'New criterion?', weight: 2 }],
    };
    expect(computePromptStateHash(modified)).not.toBe(baseHash);
    // Stable for identical input
    expect(computePromptStateHash(target())).toBe(baseHash);
  });

  it('evaluate_only skips an unchanged low-scoring fingerprint with zero model calls', async () => {
    seedCompletedRun(computePromptStateHash(target()), 0.2);

    const result = await runAutoresearch('secretary', 1, true, undefined, {
      mode: 'evaluate_only',
    });

    expect(result.mode).toBe('evaluate_only');
    expect(result.skipped).toBe('skipped_unchanged');
    expect(result.finalScore).toBe(0.2);
    expect(provider.calls).toHaveLength(0);
  });

  it('does not reuse an unchanged fingerprint when the stored score is outside the valid range', async () => {
    seedCompletedRun(computePromptStateHash(target()), 1.5);

    const result = await runAutoresearch('secretary', 1, true, undefined, {
      mode: 'evaluate_only',
    });

    expect(result.skipped).toBeUndefined();
    expect(provider.calls).toEqual(['autoresearch_gen_secretary', 'autoresearch_score']);
  });

  it('batches topic semantic scoring so scheduled evaluation uses four calls instead of the historical 39', async () => {
    const result = await runAutoresearch('topic_gen', 1, true, undefined, {
      mode: 'evaluate_only',
      force: true,
    });

    expect(result.mode).toBe('evaluate_only');
    expect(provider.calls.filter((scope) => scope === 'autoresearch_gen_topic_gen')).toHaveLength(3);
    expect(provider.calls.filter((scope) => scope === 'autoresearch_score')).toHaveLength(1);
    expect(provider.calls).toHaveLength(4);
    expect(1 - provider.calls.length / 39).toBeGreaterThanOrEqual(0.85);
    const reservations = vi.mocked(withAiBudgetReservation).mock.calls.map(([request]) => request as {
      baseCategory?: string;
      jobName?: string;
      runId?: string | null;
    });
    expect(reservations).toHaveLength(4);
    expect(new Set(reservations.map((request) => request.baseCategory))).toEqual(
      new Set(['autoresearch_topic_gen']),
    );
    expect(new Set(reservations.map((request) => request.runId))).toEqual(new Set([result.runId]));
    expect(reservations.filter((request) => request.jobName === 'autoresearch_topic_gen:generate')).toHaveLength(3);
    expect(reservations.filter((request) => request.jobName === 'autoresearch_topic_gen:score')).toHaveLength(1);
    expect(result.rounds[0].decision).toBe('baseline_only');
    expect(promptState.writePrompt).not.toHaveBeenCalled();
  });

  it('fails the deterministic live-contract criterion when topic output uses stale field aliases', async () => {
    provider.staleTopicAliases = true;

    const result = await runAutoresearch('topic_gen', 1, true, undefined, {
      mode: 'evaluate_only',
      force: true,
    });

    expect(result.rounds[0].baselineScore).toBeCloseTo(1 / 3);
    expect(result.rounds[0].decision).toBe('baseline_only');
    expect(promptState.writePrompt).not.toHaveBeenCalled();
  });

  it('propose returns a mutation without writing the prompt', async () => {
    provider.scorePassed = false;

    const result = await runAutoresearch('secretary', 1, true, undefined, {
      mode: 'propose',
      force: true,
    });

    expect(result.rounds[0]).toMatchObject({
      decision: 'proposed',
      mutationDescription: 'test tweak',
    });
    const reservations = vi.mocked(withAiBudgetReservation).mock.calls.map(([request]) => request as {
      baseCategory?: string;
      jobName?: string;
      runId?: string | null;
    });
    expect(new Set(reservations.map((request) => request.baseCategory))).toEqual(
      new Set(['autoresearch_secretary']),
    );
    expect(new Set(reservations.map((request) => request.runId))).toEqual(new Set([result.runId]));
    expect(reservations.map((request) => request.jobName)).toEqual([
      'autoresearch_secretary:generate',
      'autoresearch_secretary:score',
      'autoresearch_secretary:propose',
    ]);
    expect(promptState.writePrompt).not.toHaveBeenCalled();
    expect(promptState.content).toBe('PROMPT V1');
  });

  it('aborts invalid scorer output instead of silently converting it to a zero score', async () => {
    provider.invalidScore = true;

    await expect(runAutoresearch('secretary', 1, true, undefined, {
      mode: 'evaluate_only',
      force: true,
    })).rejects.toThrow('Scorer returned invalid JSON');

    expect(promptState.writePrompt).not.toHaveBeenCalled();
    const rows = (testDb.prepare('SELECT COUNT(*) AS count FROM autoresearch_experiments').get() as { count: number }).count;
    expect(rows).toBe(0);
  });

  it('rejects apply mode in production before any model, prompt, or Git work', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(runAutoresearch('secretary', 1, false, undefined, {
      mode: 'apply',
      force: true,
    })).rejects.toThrow('AUTORESEARCH_APPLY_DISABLED_IN_PRODUCTION');

    expect(provider.calls).toHaveLength(0);
    expect(promptState.writePrompt).not.toHaveBeenCalled();
  });
});
