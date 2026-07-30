import Database from 'better-sqlite3';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_EVAL_JUDGE_BASE_CATEGORY,
  CHAT_EVAL_JUDGE_JOB_NAME,
  CHAT_EVAL_JUDGE_USAGE_CATEGORY,
  CHAT_EVAL_JUDGE_USAGE_MODEL,
  attestChatEvalJudgeUsage,
  runWithChatEvalJudgeRuntime,
  type ChatEvalJudgeResultLike,
} from '../../src/services/chat-eval-judge-runtime';
import { getDb } from '../../src/services/database';
import {
  assertAiBudgetReservationForProvider,
  getActiveAiBudgetReservationMarker,
} from '../../src/services/cost-guardrail';

const RUN_ID = 'chat-eval-2026-07-30T12-00-00-000Z';
const JUDGE_BUDGET_USD = 0.05;

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-eval-judge-'));
  temporaryRoots.push(root);
  return root;
}

function resultLike(overrides: Partial<ChatEvalJudgeResultLike> = {}): ChatEvalJudgeResultLike {
  return {
    mode: 'real_provider',
    scenarioCount: 7,
    judge: {
      calls: 7,
      estimatedSpendUsd: 0.007,
      aborted: false,
      scenarios: Array.from({ length: 7 }, (_, index) => ({
        scenarioId: `scenario-${index + 1}`,
        status: 'scored',
      })),
    },
    ...overrides,
  };
}

function insertSuccessfulJudgeUsage(
  db: Database.Database,
  runId = RUN_ID,
  overrides: Partial<{
    category: string;
    provider: string;
    model: string;
    pricingStatus: string;
    requestSource: string;
    baseCategory: string;
    jobName: string;
    costUsd: number;
  }> = {},
): void {
  db.prepare(`
    INSERT INTO api_usage (
      category, model, tenant_id, user_id, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, provider,
      pricing_status, pricing_model_key, request_source, job_name,
      base_category, run_id, provider_tool_cost_usd,
      web_search_requests, grounded_search_prompts
    ) VALUES (?, ?, 0, 0, 100, 50, 0, 0, ?, 25, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
  `).run(
    overrides.category ?? CHAT_EVAL_JUDGE_USAGE_CATEGORY,
    overrides.model ?? CHAT_EVAL_JUDGE_USAGE_MODEL,
    overrides.costUsd ?? 0.0005,
    overrides.provider ?? 'gemini',
    overrides.pricingStatus ?? 'resolved',
    CHAT_EVAL_JUDGE_USAGE_MODEL,
    overrides.requestSource ?? 'system',
    overrides.jobName ?? CHAT_EVAL_JUDGE_JOB_NAME,
    overrides.baseCategory ?? CHAT_EVAL_JUDGE_BASE_CATEGORY,
    runId,
  );
}

function createAttestationDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      model TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      provider TEXT NOT NULL,
      pricing_status TEXT NOT NULL,
      pricing_model_key TEXT,
      request_source TEXT NOT NULL,
      job_name TEXT,
      base_category TEXT,
      run_id TEXT,
      provider_tool_cost_usd REAL NOT NULL,
      web_search_requests INTEGER NOT NULL,
      grounded_search_prompts INTEGER NOT NULL
    );
    CREATE TABLE ai_provider_attempt_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      request_source TEXT NOT NULL,
      base_category TEXT NOT NULL,
      job_name TEXT,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_category TEXT NOT NULL,
      reserved_cost_usd REAL NOT NULL
    );
  `);
  return db;
}

function insertAttempt(db: Database.Database, runId = RUN_ID, overrides: Partial<{
  provider: string;
  model: string;
  providerCategory: string;
  requestSource: string;
  baseCategory: string;
  jobName: string;
  reservedCostUsd: number;
}> = {}): void {
  db.prepare(`
    INSERT INTO ai_provider_attempt_reservations (
      user_id, request_source, base_category, job_name, run_id,
      provider, model, provider_category, reserved_cost_usd
    ) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.requestSource ?? 'system',
    overrides.baseCategory ?? CHAT_EVAL_JUDGE_BASE_CATEGORY,
    overrides.jobName ?? CHAT_EVAL_JUDGE_JOB_NAME,
    runId,
    overrides.provider ?? 'gemini',
    overrides.model ?? CHAT_EVAL_JUDGE_USAGE_MODEL,
    overrides.providerCategory ?? CHAT_EVAL_JUDGE_USAGE_CATEGORY,
    overrides.reservedCostUsd ?? 0.001,
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat eval judge runtime', () => {
  it('creates a private fresh ledger, binds one exact reservation before work, and attests seven calls', async () => {
    const root = temporaryRoot();
    const execute = vi.fn(async () => {
      const db = getDb();
      const marker = getActiveAiBudgetReservationMarker(0, CHAT_EVAL_JUDGE_USAGE_CATEGORY);
      expect(marker).toMatchObject({
        requestSource: 'system',
        baseCategory: CHAT_EVAL_JUDGE_BASE_CATEGORY,
        jobName: CHAT_EVAL_JUDGE_JOB_NAME,
        runId: RUN_ID,
        hardRunCostLimitUsd: JUDGE_BUDGET_USD,
      });

      for (let index = 0; index < 7; index += 1) {
        assertAiBudgetReservationForProvider({
          userId: 0,
          category: CHAT_EVAL_JUDGE_USAGE_CATEGORY,
          provider: 'gemini',
          model: CHAT_EVAL_JUDGE_USAGE_MODEL,
          maxCostUsd: 0.001,
        });
        insertSuccessfulJudgeUsage(db);
      }
      return resultLike();
    });

    const output = await runWithChatEvalJudgeRuntime({
      runId: RUN_ID,
      judgeBudgetUsd: JUDGE_BUDGET_USD,
      rootDir: root,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(output.judgeUsage).toMatchObject({
      attested: true,
      usageCallCount: 7,
      providerAttemptCount: 7,
      actualSpendUsd: 0.0035,
      reservedAttemptCeilingUsd: 0.007,
      committedCeilingUsd: 0.0105,
      providers: ['gemini'],
      models: [CHAT_EVAL_JUDGE_USAGE_MODEL],
      unresolvedPricingCount: 0,
    });
    expect(output.judgeUsage.usageDatabaseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lstatSync(output.ledgerPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.dirname(output.ledgerPath)).mode & 0o777).toBe(0o700);
    expect(() => getDb()).toThrow(/not initialized/i);
  }, 60_000);

  it('refuses a pre-existing run directory and a symlinked ledger root before execute', async () => {
    const existingRoot = temporaryRoot();
    mkdirSync(path.join(existingRoot, RUN_ID), { mode: 0o700 });
    const execute = vi.fn(async () => resultLike());
    await expect(runWithChatEvalJudgeRuntime({
      runId: RUN_ID,
      judgeBudgetUsd: JUDGE_BUDGET_USD,
      rootDir: existingRoot,
      execute,
    })).rejects.toThrow(/fresh|already exists|pre-existing/i);
    expect(execute).not.toHaveBeenCalled();

    const symlinkParent = temporaryRoot();
    const target = path.join(symlinkParent, 'target');
    mkdirSync(target, { mode: 0o700 });
    const linked = path.join(symlinkParent, 'linked');
    symlinkSync(target, linked);
    await expect(runWithChatEvalJudgeRuntime({
      runId: `${RUN_ID}-symlink`,
      judgeBudgetUsd: JUDGE_BUDGET_USD,
      rootDir: linked,
      execute,
    })).rejects.toThrow(/symlink|canonical|root/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('closes and unbinds the ledger after an execution failure while retaining private audit bytes', async () => {
    const root = temporaryRoot();
    let ledgerPath = '';
    await expect(runWithChatEvalJudgeRuntime({
      runId: `${RUN_ID}-failure`,
      judgeBudgetUsd: JUDGE_BUDGET_USD,
      rootDir: root,
      execute: async () => {
        ledgerPath = getDb().name;
        throw new Error('injected suite failure');
      },
    })).rejects.toThrow(/injected suite failure/);

    expect(() => getDb()).toThrow(/not initialized/i);
    expect(lstatSync(ledgerPath).isFile()).toBe(true);
    expect(lstatSync(ledgerPath).mode & 0o777).toBe(0o600);
  }, 60_000);
});

describe('chat eval judge usage attestation', () => {
  it('accepts only seven matched, resolved Gemini flash-lite usage and attempt rows under the cap', () => {
    const db = createAttestationDatabase();
    for (let index = 0; index < 7; index += 1) {
      insertAttempt(db);
      insertSuccessfulJudgeUsage(db);
    }
    const attestation = attestChatEvalJudgeUsage(db, RUN_ID, resultLike(), JUDGE_BUDGET_USD);
    expect(attestation.attested).toBe(true);
    expect(attestation.actualSpendUsd).toBe(0.0035);
    expect(attestation.committedCeilingUsd).toBe(0.0105);
    db.close();
  });

  it('refuses an extra usage row attributed to a different run id', () => {
    const db = createAttestationDatabase();
    for (let index = 0; index < 7; index += 1) {
      insertAttempt(db);
      insertSuccessfulJudgeUsage(db);
    }
    insertSuccessfulJudgeUsage(db, `${RUN_ID}-other`);

    expect(() =>
      attestChatEvalJudgeUsage(db, RUN_ID, resultLike(), JUDGE_BUDGET_USD),
    ).toThrow(/total usage rows instead of seven/i);
    db.close();
  });

  it('refuses an extra provider-attempt row attributed to a different run id', () => {
    const db = createAttestationDatabase();
    for (let index = 0; index < 7; index += 1) {
      insertAttempt(db);
      insertSuccessfulJudgeUsage(db);
    }
    insertAttempt(db, `${RUN_ID}-other`);

    expect(() =>
      attestChatEvalJudgeUsage(db, RUN_ID, resultLike(), JUDGE_BUDGET_USD),
    ).toThrow(/total provider attempts instead of seven/i);
    db.close();
  });

  it.each([
    ['wrong model', { model: 'gemini-2.5-flash' }],
    ['wrong provider', { provider: 'openai' }],
    ['unresolved pricing', { pricingStatus: 'unresolved' }],
    ['wrong source', { requestSource: 'interactive' }],
    ['wrong base category', { baseCategory: 'chat_eval_judge' }],
    ['wrong job', { jobName: 'other' }],
  ])('rejects %s evidence', (_label, usageOverride) => {
    const db = createAttestationDatabase();
    for (let index = 0; index < 7; index += 1) {
      insertAttempt(db);
      insertSuccessfulJudgeUsage(db, RUN_ID, usageOverride);
    }
    expect(() => attestChatEvalJudgeUsage(
      db,
      RUN_ID,
      resultLike(),
      JUDGE_BUDGET_USD,
    )).toThrow(/judge usage|attestation|evidence/i);
    db.close();
  });

  it('rejects blocked judge output, missing attempts, and conservative overspend', () => {
    const blockedDb = createAttestationDatabase();
    for (let index = 0; index < 7; index += 1) {
      insertAttempt(blockedDb);
      insertSuccessfulJudgeUsage(blockedDb);
    }
    expect(() => attestChatEvalJudgeUsage(
      blockedDb,
      RUN_ID,
      resultLike({
        judge: {
          calls: 7,
          estimatedSpendUsd: 0.007,
          aborted: true,
          scenarios: [{ scenarioId: 'scenario-1', status: 'blocked' }],
        },
      }),
      JUDGE_BUDGET_USD,
    )).toThrow(/judge report|scored|aborted/i);
    blockedDb.close();

    const missingAttemptDb = createAttestationDatabase();
    for (let index = 0; index < 7; index += 1) insertSuccessfulJudgeUsage(missingAttemptDb);
    expect(() => attestChatEvalJudgeUsage(
      missingAttemptDb,
      RUN_ID,
      resultLike(),
      JUDGE_BUDGET_USD,
    )).toThrow(/attempt/i);
    missingAttemptDb.close();

    const overspendDb = createAttestationDatabase();
    for (let index = 0; index < 7; index += 1) {
      insertAttempt(overspendDb, RUN_ID, { reservedCostUsd: 0.004 });
      insertSuccessfulJudgeUsage(overspendDb, RUN_ID, { costUsd: 0.004 });
    }
    expect(() => attestChatEvalJudgeUsage(
      overspendDb,
      RUN_ID,
      resultLike({ judge: { ...resultLike().judge!, estimatedSpendUsd: 0.04 } }),
      JUDGE_BUDGET_USD,
    )).toThrow(/ceiling|budget|spend/i);
    overspendDb.close();
  });
});
