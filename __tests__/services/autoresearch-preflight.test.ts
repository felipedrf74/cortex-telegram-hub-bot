// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for the autoresearch pre-flight skip gate (src/services/autoresearch.ts).
 *
 * The scheduled Sunday run must SKIP (zero LLM calls) when the target's
 * prompt/config fingerprint is unchanged since the last completed run AND
 * that run's stored final score is at/above AUTORESEARCH_RESCORE_THRESHOLD
 * (default 0.9). It must RUN when the hash changed, the score is low, the
 * history is missing/legacy-NULL, or { force: true } is passed. Completed
 * runs must persist the end-of-run prompt hash + final score (migration 223
 * columns on autoresearch_experiments).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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
const promptState = vi.hoisted(() => ({ content: 'PROMPT V1' }));

vi.mock('../../src/utils/prompt-loader', () => ({
  loadPrompt: vi.fn(() => promptState.content),
  writePrompt: vi.fn((_name: string, content: string) => {
    promptState.content = content;
  }),
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

vi.mock('../../src/services/eval-criteria', () => ({
  getEvalTarget: vi.fn((id: string) => (id === TEST_TARGET.id ? TEST_TARGET : undefined)),
  getAllTargets: vi.fn(() => [TEST_TARGET]),
}));

// Every LLM call in autoresearch (generate, score, mutate) goes through
// completeOneShotWithFallback — counting its invocations counts LLM calls.
const provider = vi.hoisted(() => ({
  calls: [] as string[],
  scorePassed: true,
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: vi.fn(async (_system: string, _user: string, scope: string) => {
    provider.calls.push(scope);
    if (scope.startsWith('autoresearch_gen')) return { text: 'generated output' };
    if (scope === 'autoresearch_score') {
      return { text: JSON.stringify([{ id: 'crit1', passed: provider.scorePassed }]) };
    }
    if (scope === 'autoresearch_mutate') {
      return { text: JSON.stringify({ description: 'test tweak', mutated_prompt: 'PROMPT MUTATED' }) };
    }
    return { text: '' };
  }),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

import { runAutoresearch, computePromptStateHash } from '../../src/services/autoresearch';
import { getEvalTarget, EvalTarget } from '../../src/services/eval-criteria';

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
  testDb = new Database(':memory:');
  applyMigrations(testDb);
  promptState.content = 'PROMPT V1';
  provider.calls = [];
  provider.scorePassed = true;
  delete process.env.AUTORESEARCH_RESCORE_THRESHOLD;
});

afterEach(() => {
  testDb.close();
  delete process.env.AUTORESEARCH_RESCORE_THRESHOLD;
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
});
