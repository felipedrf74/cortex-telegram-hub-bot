// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyPendingMigrations } from './migration-runner';

export const CHAT_EVAL_JUDGE_BASE_CATEGORY = 'chat_live_eval_real' as const;
export const CHAT_EVAL_JUDGE_JOB_NAME = 'chat_eval_judge' as const;
export const CHAT_EVAL_JUDGE_USAGE_CATEGORY = 'chat_eval_judge' as const;
export const CHAT_EVAL_JUDGE_USAGE_MODEL = 'gemini-2.5-flash-lite' as const;
export const CHAT_EVAL_JUDGE_EXPECTED_CALLS = 7;
export const CHAT_EVAL_JUDGE_LEDGER_ROOT = path.resolve('.local', 'chat-eval');

const CHAT_EVAL_RUN_ID_PATTERN = /^chat-eval-[a-zA-Z0-9._:-]{8,120}$/;
const CONTENT_EVAL_VERIFIER_FLAG = 'NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME';

export interface ChatEvalJudgeResultLike {
  mode: string;
  scenarioCount: number;
  judge?: {
    calls: number;
    estimatedSpendUsd: number;
    aborted: boolean;
    scenarios: Array<{
      scenarioId: string;
      status: string;
    }>;
  };
}

export interface ChatEvalJudgeUsageAttestation {
  attested: true;
  reasons: [];
  usageCallCount: number;
  providerAttemptCount: number;
  actualSpendUsd: number;
  reservedAttemptCeilingUsd: number;
  committedCeilingUsd: number;
  providers: ['gemini'];
  models: [typeof CHAT_EVAL_JUDGE_USAGE_MODEL];
  unresolvedPricingCount: 0;
  usageDatabaseSha256?: string;
}

export interface ChatEvalJudgeRuntimeResult<T extends ChatEvalJudgeResultLike> {
  result: T;
  judgeUsage: ChatEvalJudgeUsageAttestation & { usageDatabaseSha256: string };
  ledgerPath: string;
}

export class ChatEvalJudgeRuntimeError extends Error {
  readonly runId: string;
  readonly ledgerPath: string;

  constructor(message: string, runId: string, ledgerPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatEvalJudgeRuntimeError';
    this.runId = runId;
    this.ledgerPath = ledgerPath;
  }
}

interface JudgeUsageRow {
  id: number;
  category: string;
  model: string;
  tenant_id: number;
  user_id: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  provider: string;
  pricing_status: string;
  pricing_model_key: string | null;
  request_source: string;
  job_name: string | null;
  base_category: string | null;
  run_id: string | null;
}

interface JudgeAttemptRow {
  id: number;
  user_id: number;
  request_source: string;
  base_category: string;
  job_name: string | null;
  run_id: string;
  provider: string;
  model: string;
  provider_category: string;
  reserved_cost_usd: number;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}

function sameUsd(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8;
}

function requiredColumnsPresent(db: Database.Database, table: string, required: readonly string[]): boolean {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  return required.every((column) => columns.has(column));
}

function assertFreshLedgerSchema(db: Database.Database): void {
  const requiredUsageColumns = [
    'id', 'category', 'model', 'tenant_id', 'user_id', 'input_tokens',
    'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd',
    'provider', 'pricing_status', 'pricing_model_key', 'request_source',
    'job_name', 'base_category', 'run_id',
  ];
  if (!requiredColumnsPresent(db, 'api_usage', requiredUsageColumns)) {
    throw new Error('Chat eval judge ledger is missing required api_usage provenance columns');
  }
  const usageCount = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM api_usage').get() as { count?: number }).count ?? -1,
  );
  if (usageCount !== 0) {
    throw new Error('Chat eval judge ledger must start with zero usage rows');
  }
  const attemptTable = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ai_provider_attempt_reservations'",
  ).get() as { present?: number } | undefined;
  if (attemptTable?.present === 1) {
    const attemptCount = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM ai_provider_attempt_reservations').get() as { count?: number }).count ?? -1,
    );
    if (attemptCount !== 0) {
      throw new Error('Chat eval judge ledger must start with zero provider-attempt rows');
    }
  }
}

function assertPrivateDirectory(directory: string): string {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Chat eval judge ledger root must be a non-symlink directory');
  }
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function ensurePrivateRoot(rootDir: string): string {
  const resolved = path.resolve(rootDir);
  try {
    return assertPrivateDirectory(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    assertPrivateDirectory(parent);
    fs.mkdirSync(resolved, { mode: 0o700 });
    return assertPrivateDirectory(resolved);
  }
}

function createFreshLedger(rootDir: string, runId: string): {
  runDirectory: string;
  ledgerPath: string;
} {
  if (!CHAT_EVAL_RUN_ID_PATTERN.test(runId)) {
    throw new Error('Chat eval judge runtime requires a governed run id');
  }
  const root = ensurePrivateRoot(rootDir);
  const runDirectory = path.join(root, runId);
  try {
    fs.mkdirSync(runDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(`Chat eval judge runtime refuses pre-existing run directory: ${runDirectory}`);
    }
    throw error;
  }
  assertPrivateDirectory(runDirectory);

  const ledgerPath = path.join(runDirectory, 'judge-usage.sqlite');
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(
    ledgerPath,
    fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | noFollow,
    0o600,
  );
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  fs.chmodSync(ledgerPath, 0o600);
  const stat = fs.lstatSync(ledgerPath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error('Chat eval judge ledger is not a private owner-only regular file');
  }
  return { runDirectory, ledgerPath };
}

function safeFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function failAttestation(reason: string): never {
  throw new Error(`Chat eval judge usage attestation failed: ${reason}`);
}

export function attestChatEvalJudgeUsage(
  db: Database.Database,
  runId: string,
  result: ChatEvalJudgeResultLike,
  judgeBudgetUsd: number,
): ChatEvalJudgeUsageAttestation {
  if (
    result.mode !== 'real_provider'
    || result.scenarioCount !== CHAT_EVAL_JUDGE_EXPECTED_CALLS
    || !result.judge
    || result.judge.calls !== CHAT_EVAL_JUDGE_EXPECTED_CALLS
    || result.judge.aborted
    || result.judge.scenarios.length !== CHAT_EVAL_JUDGE_EXPECTED_CALLS
    || result.judge.scenarios.some((scenario) => scenario.status !== 'scored')
  ) {
    failAttestation('judge report was not seven fully scored, non-aborted real-provider scenarios');
  }
  if (
    !safeFiniteNonNegative(result.judge.estimatedSpendUsd)
    || result.judge.estimatedSpendUsd <= 0
    || result.judge.estimatedSpendUsd > judgeBudgetUsd + Number.EPSILON
  ) {
    failAttestation('judge report estimated spend was outside the governed ceiling');
  }

  const usageRows = db.prepare(`
    SELECT
      id, category, model, tenant_id, user_id, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, cost_usd, provider,
      pricing_status, pricing_model_key, request_source, job_name,
      base_category, run_id
    FROM api_usage
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId) as JudgeUsageRow[];
  const totalUsageCount = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM api_usage').get() as { count?: number }).count ?? -1,
  );
  if (totalUsageCount !== CHAT_EVAL_JUDGE_EXPECTED_CALLS) {
    failAttestation(`fresh judge ledger contained ${totalUsageCount} total usage rows instead of seven`);
  }
  if (usageRows.length !== CHAT_EVAL_JUDGE_EXPECTED_CALLS) {
    failAttestation(`expected seven usage rows, received ${usageRows.length}`);
  }

  const attemptTable = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ai_provider_attempt_reservations'",
  ).get() as { present?: number } | undefined;
  if (attemptTable?.present !== 1) {
    failAttestation('provider-attempt evidence table is missing');
  }
  const attemptRows = db.prepare(`
    SELECT
      id, user_id, request_source, base_category, job_name, run_id,
      provider, model, provider_category, reserved_cost_usd
    FROM ai_provider_attempt_reservations
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId) as JudgeAttemptRow[];
  const totalAttemptCount = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM ai_provider_attempt_reservations').get() as { count?: number }).count ?? -1,
  );
  if (totalAttemptCount !== CHAT_EVAL_JUDGE_EXPECTED_CALLS) {
    failAttestation(`fresh judge ledger contained ${totalAttemptCount} total provider attempts instead of seven`);
  }
  if (attemptRows.length !== CHAT_EVAL_JUDGE_EXPECTED_CALLS) {
    failAttestation(`expected seven provider attempts, received ${attemptRows.length}`);
  }

  let unresolvedPricingCount = 0;
  for (let index = 0; index < CHAT_EVAL_JUDGE_EXPECTED_CALLS; index += 1) {
    const usage = usageRows[index];
    const attempt = attemptRows[index];
    if (
      usage.category !== CHAT_EVAL_JUDGE_USAGE_CATEGORY
      || usage.provider !== 'gemini'
      || usage.model !== CHAT_EVAL_JUDGE_USAGE_MODEL
      || usage.request_source !== 'system'
      || usage.base_category !== CHAT_EVAL_JUDGE_BASE_CATEGORY
      || usage.job_name !== CHAT_EVAL_JUDGE_JOB_NAME
      || usage.run_id !== runId
      || usage.user_id !== 0
      || usage.tenant_id !== 0
      || !Number.isSafeInteger(usage.input_tokens)
      || !Number.isSafeInteger(usage.output_tokens)
      || !Number.isSafeInteger(usage.cache_read_tokens)
      || !Number.isSafeInteger(usage.cache_write_tokens)
      || usage.input_tokens < 0
      || usage.output_tokens < 0
      || usage.cache_read_tokens < 0
      || usage.cache_write_tokens < 0
      || usage.input_tokens + usage.output_tokens <= 0
      || !safeFiniteNonNegative(usage.cost_usd)
      || usage.cost_usd <= 0
      || typeof usage.pricing_model_key !== 'string'
      || usage.pricing_model_key.length === 0
    ) {
      failAttestation(`usage row ${index + 1} did not match the governed Gemini judge identity`);
    }
    if (usage.pricing_status !== 'resolved') unresolvedPricingCount += 1;
    if (
      attempt.user_id !== 0
      || attempt.request_source !== 'system'
      || attempt.base_category !== CHAT_EVAL_JUDGE_BASE_CATEGORY
      || attempt.job_name !== CHAT_EVAL_JUDGE_JOB_NAME
      || attempt.run_id !== runId
      || attempt.provider !== usage.provider
      || attempt.model !== usage.model
      || attempt.provider_category !== usage.category
      || !safeFiniteNonNegative(attempt.reserved_cost_usd)
      || attempt.reserved_cost_usd <= 0
    ) {
      failAttestation(`provider attempt ${index + 1} did not bind to its usage row`);
    }
  }
  if (unresolvedPricingCount !== 0) {
    failAttestation('judge usage included unresolved pricing');
  }

  const actualSpendUsd = roundUsd(
    usageRows.reduce((sum, row) => sum + Number(row.cost_usd), 0),
  );
  const reservedAttemptCeilingUsd = roundUsd(
    attemptRows.reduce((sum, row) => sum + Number(row.reserved_cost_usd), 0),
  );
  const committedCeilingUsd = roundUsd(actualSpendUsd + reservedAttemptCeilingUsd);
  if (
    !sameUsd(reservedAttemptCeilingUsd, result.judge.estimatedSpendUsd)
    || actualSpendUsd > reservedAttemptCeilingUsd + Number.EPSILON
    || committedCeilingUsd > judgeBudgetUsd + Number.EPSILON
  ) {
    failAttestation('judge actual, reserved, or conservative committed spend exceeded its evidence ceiling');
  }

  return {
    attested: true,
    reasons: [],
    usageCallCount: usageRows.length,
    providerAttemptCount: attemptRows.length,
    actualSpendUsd,
    reservedAttemptCeilingUsd,
    committedCeilingUsd,
    providers: ['gemini'],
    models: [CHAT_EVAL_JUDGE_USAGE_MODEL],
    unresolvedPricingCount: 0,
  };
}

function hashFileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export async function runWithChatEvalJudgeRuntime<T extends ChatEvalJudgeResultLike>(input: {
  runId: string;
  judgeBudgetUsd: number;
  execute: () => Promise<T>;
  rootDir?: string;
}): Promise<ChatEvalJudgeRuntimeResult<T>> {
  if (input.judgeBudgetUsd !== 0.05) {
    throw new Error('Chat eval judge runtime requires the exact $0.05 judge ceiling');
  }
  const { ledgerPath } = createFreshLedger(
    input.rootDir ?? CHAT_EVAL_JUDGE_LEDGER_ROOT,
    input.runId,
  );
  const previousVerifierFlag = process.env[CONTENT_EVAL_VERIFIER_FLAG];
  process.env[CONTENT_EVAL_VERIFIER_FLAG] = '1';
  let db: Database.Database | null = null;
  let result: T;
  let judgeUsage: ChatEvalJudgeUsageAttestation;
  try {
    db = new Database(ledgerPath, { fileMustExist: true });
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    applyPendingMigrations(db);
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    assertFreshLedgerSchema(db);

    const { withStandaloneToolDatabaseAsync } = await import('./standalone-tool-database');
    const { withAiBudgetReservation } = await import('./cost-guardrail');
    result = await withStandaloneToolDatabaseAsync(db, () =>
      withAiBudgetReservation({
        userId: 0,
        requestSource: 'system',
        baseCategory: CHAT_EVAL_JUDGE_BASE_CATEGORY,
        jobName: CHAT_EVAL_JUDGE_JOB_NAME,
        runId: input.runId,
        estimatedCostUsd: 0,
        exactHardCostEstimate: true,
        hardRunCostLimitUsd: input.judgeBudgetUsd,
      }, input.execute),
    );
    judgeUsage = attestChatEvalJudgeUsage(db, input.runId, result, input.judgeBudgetUsd);
  } catch (error) {
    throw new ChatEvalJudgeRuntimeError(
      `Chat eval judge runtime failed for ${input.runId}; retained audit ledger at ${ledgerPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      input.runId,
      ledgerPath,
      { cause: error },
    );
  } finally {
    if (db?.open) {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {}
      db.close();
    }
    fs.chmodSync(ledgerPath, 0o600);
    if (previousVerifierFlag === undefined) {
      delete process.env[CONTENT_EVAL_VERIFIER_FLAG];
    } else {
      process.env[CONTENT_EVAL_VERIFIER_FLAG] = previousVerifierFlag;
    }
  }

  const usageDatabaseSha256 = hashFileSha256(ledgerPath);
  return {
    result,
    judgeUsage: {
      ...judgeUsage!,
      usageDatabaseSha256,
    },
    ledgerPath,
  };
}
