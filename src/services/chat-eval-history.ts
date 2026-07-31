// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  ChatEvalMode,
  ChatEvaluationSuiteResult,
  ChatEvalScenarioResult,
  ChatEvalStatus,
} from './chat-evaluation-harness';
import type { ChatLiveEvalRunEvidence } from './chat-live-evaluation-contract';

export interface ChatEvalRunCostAttestation {
  contractVersion: string;
  attested: boolean;
  reasons: string[];
  totalCeilingUsd: number;
  targetCeilingUsd: number;
  judgeCeilingUsd: number;
  targetActualSpendUsd: number;
  targetReservedAttemptCeilingUsd: number;
  targetCommittedCeilingUsd: number;
  judgeEstimatedSpendUsd: number;
  judgeActualSpendUsd: number;
  judgeReservedAttemptCeilingUsd: number;
  judgeCommittedCeilingUsd: number;
  judgeUsageCallCount: number;
  judgeProviderAttemptCount: number;
  judgeProviders: string[];
  judgeModels: string[];
  judgeUnresolvedPricingCount: number;
  judgeUsageDatabaseSha256: string | null;
  totalActualSpendUsd: number;
  totalEstimatedActualSpendUsd: number;
  totalConservativeCommitmentUsd: number;
  targetUsageCallCount: number;
  targetProviderAttemptCount: number;
  targetProviders: string[];
  unresolvedPricingCount: number;
  preparation: ChatLiveEvalRunEvidence['preparation'];
}

export interface PersistChatEvalRunOptions {
  databasePath?: string;
  db?: Database.Database;
  runId?: string;
  packageVersion?: string;
  gitBranch?: string;
  gitCommit?: string;
  jsonReportPath?: string;
  markdownReportPath?: string;
  budgetUsd?: number | null;
  costAttestation?: ChatEvalRunCostAttestation | null;
  preflightAttestation?: Record<string, unknown> | null;
  productionDataUsed?: boolean;
  realProviderCalls?: boolean | number;
}

export interface PersistChatEvalRunResult {
  runId: string;
  runRowId: number;
  scenarioCount: number;
  databasePath?: string;
}

export interface ChatEvalHistoryRun {
  id: number;
  runId: string;
  mode: ChatEvalMode;
  generatedAt: string;
  packageVersion: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  averageScore: number;
  scenarioCount: number;
  passCount: number;
  partialCount: number;
  failCount: number;
  blockedCount: number;
  passed: boolean;
  productionDataUsed: boolean;
  realProviderCalls: number;
  budgetUsd: number | null;
  totalBudgetCeilingUsd: number | null;
  targetBudgetCeilingUsd: number | null;
  judgeBudgetCeilingUsd: number | null;
  targetActualSpendUsd: number | null;
  judgeEstimatedSpendUsd: number | null;
  targetReservedAttemptCeilingUsd: number | null;
  targetCommittedCeilingUsd: number | null;
  totalEstimatedActualSpendUsd: number | null;
  totalConservativeCommitmentUsd: number | null;
  targetUsageCallCount: number;
  targetProviderAttemptCount: number;
  costAttestation: ChatEvalRunCostAttestation | null;
  preflightAttestation: Record<string, unknown> | null;
  jsonReportPath: string | null;
  markdownReportPath: string | null;
  qualityMetrics: Array<Record<string, unknown>>;
  dayToDaySummary: Record<string, unknown>;
  createdAt: string;
}

export const CHAT_EVAL_FROZEN_BASELINE_KEY = 'first_real_provider_staging' as const;

/**
 * How strongly the frozen run is tied to the artifact that produced it.
 * `deployed_artifact_attested` is the only class new runs can reach: paid
 * evaluation now fails closed unless the serving process reports a verified
 * staging release. `operator_checkout_only` exists solely for the first
 * baseline, captured before that binding existed, and is recorded immutably so
 * it can never be mistaken for artifact-bound evidence.
 */
export type ChatEvalBaselineProvenanceClass =
  | 'deployed_artifact_attested'
  | 'operator_checkout_only';

export interface ChatEvalFrozenBaseline {
  baselineKey: typeof CHAT_EVAL_FROZEN_BASELINE_KEY;
  runRowId: number;
  runId: string;
  acceptedAt: string;
  acceptedVia: 'portal_admin_token';
  evidenceJsonPath: string;
  evidenceMarkdownPath: string;
  /** SHA-256 of the exact committed archive bytes this baseline is pinned to. */
  evidenceJsonSha256: string;
  evidenceMarkdownSha256: string;
  /**
   * Whether the serving artifact attested itself, or the run predates that
   * binding and is therefore only as strong as the operator's local checkout.
   */
  provenanceClass: ChatEvalBaselineProvenanceClass;
  deployedRuntimeSha: string | null;
  deployedArtifactDigest: string | null;
  gitCommit: string;
  generatedAt: string;
  scenarioSetHash: string;
  evalContractVersion: string;
  seedProfileVersion: string;
  averageScore: number;
  scenarioPassRate: number;
  passed: boolean;
  scenarioCount: number;
  failCount: number;
  blockedCount: number;
  localeLeakageRate: number | null;
  totalEstimatedActualSpendUsd: number;
  totalBudgetCeilingUsd: number;
}

export interface ChatEvalBaselineFollowup {
  runRowId: number;
  runId: string;
  generatedAt: string;
  gitCommit: string | null;
  averageScore: number;
  scenarioPassRate: number;
  passed: boolean;
  scenarioCount: number;
  failCount: number;
  blockedCount: number;
  localeLeakageRate: number | null;
  totalEstimatedActualSpendUsd: number | null;
  totalBudgetCeilingUsd: number | null;
}

export interface ChatEvalBaselineComparison {
  comparable: boolean;
  reason: 'scenario_set_mismatch' | 'eval_contract_mismatch' | 'seed_profile_mismatch' | 'followup_evidence_invalid' | null;
  averageScoreDelta: number | null;
  scenarioPassRateDelta: number | null;
  failCountDelta: number | null;
  blockedCountDelta: number | null;
  localeLeakageRateDelta: number | null;
  estimatedActualSpendUsdDelta: number | null;
}

export interface ChatEvalFrozenBaselineState {
  status: 'not_recorded' | 'baseline_only' | 'comparable' | 'incompatible';
  baseline: ChatEvalFrozenBaseline | null;
  latestFollowup: ChatEvalBaselineFollowup | null;
  comparison: ChatEvalBaselineComparison | null;
}

export interface AcceptFrozenRealProviderBaselineInput {
  runId: string;
  evidenceJsonPath: string;
  evidenceMarkdownPath: string;
  /**
   * Digests of the committed archive pair. `docs/` is not part of the release
   * artifact, so the serving process cannot read these files; recording the
   * operator-supplied digests immutably is what makes the frozen baseline
   * pinned to specific bytes that any reviewer can re-verify from Git.
   */
  evidenceJsonSha256: string;
  evidenceMarkdownSha256: string;
  /**
   * Required only to freeze a run that carries no server-attested artifact
   * identity. Silence is never consent; the acknowledgement is recorded.
   */
  acknowledgeOperatorCheckoutProvenance?: boolean;
  runtime: {
    nodeEnv?: string;
    nexusEnv?: string;
    staging?: string;
  };
  /** Test/operator clock injection only; defaults to the server clock. */
  acceptedAt?: string;
}

export interface AcceptFrozenRealProviderBaselineResult {
  action: 'created' | 'already_frozen';
  baseline: ChatEvalFrozenBaseline;
}

export class ChatEvalBaselineAcceptanceError extends Error {
  constructor(
    readonly code: 'INVALID_BASELINE' | 'BASELINE_ALREADY_FROZEN',
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = 'ChatEvalBaselineAcceptanceError';
  }
}

export function ensureChatEvalHistoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_eval_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('fixture', 'local_engine', 'real_provider')),
      generated_at TEXT NOT NULL,
      package_version TEXT,
      git_branch TEXT,
      git_commit TEXT,
      average_score REAL NOT NULL,
      scenario_count INTEGER NOT NULL,
      pass_count INTEGER NOT NULL,
      partial_count INTEGER NOT NULL,
      fail_count INTEGER NOT NULL,
      blocked_count INTEGER NOT NULL,
      passed INTEGER NOT NULL DEFAULT 0,
      production_data_used INTEGER NOT NULL DEFAULT 0,
      real_provider_calls INTEGER NOT NULL DEFAULT 0,
      budget_usd REAL,
      total_budget_ceiling_usd REAL,
      target_budget_ceiling_usd REAL,
      judge_budget_ceiling_usd REAL,
      target_actual_spend_usd REAL,
      judge_estimated_spend_usd REAL,
      target_reserved_attempt_ceiling_usd REAL,
      target_committed_ceiling_usd REAL,
      total_estimated_actual_spend_usd REAL,
      total_conservative_commitment_usd REAL,
      target_usage_call_count INTEGER,
      target_provider_attempt_count INTEGER,
      cost_attestation_json TEXT,
      preflight_attestation_json TEXT,
      json_report_path TEXT,
      markdown_report_path TEXT,
      quality_metrics_json TEXT NOT NULL DEFAULT '[]',
      day_to_day_summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_eval_scenario_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pass', 'partial', 'fail', 'blocked')),
      evidence_mode TEXT NOT NULL,
      average_score REAL NOT NULL,
      failures_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      scores_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, scenario_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_eval_runs_generated_at
      ON chat_eval_runs(generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_eval_runs_mode_passed
      ON chat_eval_runs(mode, passed, generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_eval_scenario_results_run
      ON chat_eval_scenario_results(run_id, scenario_id, persona_id);
  `);
  ensureChatEvalRunEvidenceColumns(db);
  ensureFrozenChatEvalBaselineSchema(db);
}

function ensureFrozenChatEvalBaselineSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_eval_frozen_baselines (
      baseline_key TEXT PRIMARY KEY CHECK (baseline_key = 'first_real_provider_staging'),
      run_row_id INTEGER NOT NULL UNIQUE,
      run_id TEXT NOT NULL UNIQUE,
      accepted_at TEXT NOT NULL,
      accepted_via TEXT NOT NULL CHECK (accepted_via = 'portal_admin_token'),
      evidence_json_path TEXT NOT NULL,
      evidence_markdown_path TEXT NOT NULL,
      evidence_json_sha256 TEXT NOT NULL CHECK (length(evidence_json_sha256) = 64),
      evidence_markdown_sha256 TEXT NOT NULL CHECK (length(evidence_markdown_sha256) = 64),
      provenance_class TEXT NOT NULL
        CHECK (provenance_class IN ('deployed_artifact_attested', 'operator_checkout_only')),
      deployed_runtime_sha TEXT CHECK (deployed_runtime_sha IS NULL OR length(deployed_runtime_sha) = 40),
      deployed_artifact_digest TEXT CHECK (deployed_artifact_digest IS NULL OR length(deployed_artifact_digest) = 64),
      git_commit TEXT NOT NULL CHECK (length(git_commit) = 40),
      generated_at TEXT NOT NULL,
      scenario_set_hash TEXT NOT NULL CHECK (length(scenario_set_hash) = 64),
      eval_contract_version TEXT NOT NULL,
      seed_profile_version TEXT NOT NULL,
      average_score REAL NOT NULL,
      scenario_pass_rate REAL NOT NULL CHECK (scenario_pass_rate >= 0 AND scenario_pass_rate <= 1),
      passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
      scenario_count INTEGER NOT NULL CHECK (scenario_count > 0),
      fail_count INTEGER NOT NULL CHECK (fail_count >= 0),
      blocked_count INTEGER NOT NULL CHECK (blocked_count >= 0),
      locale_leakage_rate REAL,
      total_estimated_actual_spend_usd REAL NOT NULL CHECK (total_estimated_actual_spend_usd >= 0),
      total_budget_ceiling_usd REAL NOT NULL CHECK (total_budget_ceiling_usd >= 0),
      FOREIGN KEY (run_row_id) REFERENCES chat_eval_runs(id),
      FOREIGN KEY (run_id) REFERENCES chat_eval_runs(run_id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_baseline_no_update
    BEFORE UPDATE ON chat_eval_frozen_baselines
    BEGIN
      SELECT RAISE(ABORT, 'frozen baseline is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_baseline_no_delete
    BEFORE DELETE ON chat_eval_frozen_baselines
    BEGIN
      SELECT RAISE(ABORT, 'frozen baseline is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_run_no_update
    BEFORE UPDATE ON chat_eval_runs
    WHEN EXISTS (SELECT 1 FROM chat_eval_frozen_baselines WHERE run_row_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'frozen baseline run is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_run_no_delete
    BEFORE DELETE ON chat_eval_runs
    WHEN EXISTS (SELECT 1 FROM chat_eval_frozen_baselines WHERE run_row_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'frozen baseline run is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_scenario_no_insert
    BEFORE INSERT ON chat_eval_scenario_results
    WHEN EXISTS (
      SELECT 1 FROM chat_eval_frozen_baselines baseline
      JOIN chat_eval_runs run ON run.id = baseline.run_row_id
      WHERE run.run_id = NEW.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'frozen baseline scenario evidence is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_scenario_no_update
    BEFORE UPDATE ON chat_eval_scenario_results
    WHEN EXISTS (
      SELECT 1 FROM chat_eval_frozen_baselines baseline
      JOIN chat_eval_runs run ON run.id = baseline.run_row_id
      WHERE run.run_id = OLD.run_id OR run.run_id = NEW.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'frozen baseline scenario evidence is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_scenario_no_delete
    BEFORE DELETE ON chat_eval_scenario_results
    WHEN EXISTS (
      SELECT 1 FROM chat_eval_frozen_baselines baseline
      JOIN chat_eval_runs run ON run.id = baseline.run_row_id
      WHERE run.run_id = OLD.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'frozen baseline scenario evidence is immutable');
    END;
  `);
}

function ensureChatEvalRunEvidenceColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(chat_eval_runs)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  const additions: Array<[string, string]> = [
    ['total_budget_ceiling_usd', 'REAL'],
    ['target_budget_ceiling_usd', 'REAL'],
    ['judge_budget_ceiling_usd', 'REAL'],
    ['target_actual_spend_usd', 'REAL'],
    ['judge_estimated_spend_usd', 'REAL'],
    ['target_reserved_attempt_ceiling_usd', 'REAL'],
    ['target_committed_ceiling_usd', 'REAL'],
    ['total_estimated_actual_spend_usd', 'REAL'],
    ['total_conservative_commitment_usd', 'REAL'],
    ['target_usage_call_count', 'INTEGER'],
    ['target_provider_attempt_count', 'INTEGER'],
    ['cost_attestation_json', 'TEXT'],
    ['preflight_attestation_json', 'TEXT'],
  ];
  for (const [column, type] of additions) {
    if (existing.has(column)) continue;
    db.exec(`ALTER TABLE chat_eval_runs ADD COLUMN ${column} ${type}`);
    existing.add(column);
  }
}

export function persistChatEvalRun(
  result: ChatEvaluationSuiteResult,
  options: PersistChatEvalRunOptions = {},
): PersistChatEvalRunResult {
  const ownedDb = options.db ? null : new Database(options.databasePath || 'reports/chat-eval/chat-eval-history.sqlite');
  const db = options.db ?? ownedDb!;
  ensureChatEvalHistoryTables(db);

  const runId = options.runId ?? `chat-eval-${result.generatedAt.replace(/[:.]/g, '-')}`;
  const realProviderCalls = normalizeProviderCallCount(options.realProviderCalls, result.mode);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO chat_eval_runs (
        run_id, mode, generated_at, package_version, git_branch, git_commit,
        average_score, scenario_count, pass_count, partial_count, fail_count,
        blocked_count, passed, production_data_used, real_provider_calls,
        budget_usd, total_budget_ceiling_usd, target_budget_ceiling_usd,
        judge_budget_ceiling_usd, target_actual_spend_usd, judge_estimated_spend_usd,
        target_reserved_attempt_ceiling_usd, target_committed_ceiling_usd,
        total_estimated_actual_spend_usd, total_conservative_commitment_usd,
        target_usage_call_count, target_provider_attempt_count,
        cost_attestation_json, preflight_attestation_json,
        json_report_path, markdown_report_path,
        quality_metrics_json, day_to_day_summary_json
      )
      VALUES (
        @runId, @mode, @generatedAt, @packageVersion, @gitBranch, @gitCommit,
        @averageScore, @scenarioCount, @passCount, @partialCount, @failCount,
        @blockedCount, @passed, @productionDataUsed, @realProviderCalls,
        @budgetUsd, @totalBudgetCeilingUsd, @targetBudgetCeilingUsd,
        @judgeBudgetCeilingUsd, @targetActualSpendUsd, @judgeEstimatedSpendUsd,
        @targetReservedAttemptCeilingUsd, @targetCommittedCeilingUsd,
        @totalEstimatedActualSpendUsd, @totalConservativeCommitmentUsd,
        @targetUsageCallCount, @targetProviderAttemptCount,
        @costAttestationJson, @preflightAttestationJson,
        @jsonReportPath, @markdownReportPath,
        @qualityMetricsJson, @dayToDaySummaryJson
      )
      ON CONFLICT(run_id) DO UPDATE SET
        mode = excluded.mode,
        generated_at = excluded.generated_at,
        package_version = excluded.package_version,
        git_branch = excluded.git_branch,
        git_commit = excluded.git_commit,
        average_score = excluded.average_score,
        scenario_count = excluded.scenario_count,
        pass_count = excluded.pass_count,
        partial_count = excluded.partial_count,
        fail_count = excluded.fail_count,
        blocked_count = excluded.blocked_count,
        passed = excluded.passed,
        production_data_used = excluded.production_data_used,
        real_provider_calls = excluded.real_provider_calls,
        budget_usd = excluded.budget_usd,
        total_budget_ceiling_usd = excluded.total_budget_ceiling_usd,
        target_budget_ceiling_usd = excluded.target_budget_ceiling_usd,
        judge_budget_ceiling_usd = excluded.judge_budget_ceiling_usd,
        target_actual_spend_usd = excluded.target_actual_spend_usd,
        judge_estimated_spend_usd = excluded.judge_estimated_spend_usd,
        target_reserved_attempt_ceiling_usd = excluded.target_reserved_attempt_ceiling_usd,
        target_committed_ceiling_usd = excluded.target_committed_ceiling_usd,
        total_estimated_actual_spend_usd = excluded.total_estimated_actual_spend_usd,
        total_conservative_commitment_usd = excluded.total_conservative_commitment_usd,
        target_usage_call_count = excluded.target_usage_call_count,
        target_provider_attempt_count = excluded.target_provider_attempt_count,
        cost_attestation_json = excluded.cost_attestation_json,
        preflight_attestation_json = excluded.preflight_attestation_json,
        json_report_path = excluded.json_report_path,
        markdown_report_path = excluded.markdown_report_path,
        quality_metrics_json = excluded.quality_metrics_json,
        day_to_day_summary_json = excluded.day_to_day_summary_json
    `).run({
      runId,
      mode: result.mode,
      generatedAt: result.generatedAt,
      packageVersion: options.packageVersion ?? null,
      gitBranch: options.gitBranch ?? null,
      gitCommit: options.gitCommit ?? null,
      averageScore: result.averageScore,
      scenarioCount: result.scenarioCount,
      passCount: result.statusCounts.pass ?? 0,
      partialCount: result.statusCounts.partial ?? 0,
      failCount: result.statusCounts.fail ?? 0,
      blockedCount: result.statusCounts.blocked ?? 0,
      passed: result.passed ? 1 : 0,
      productionDataUsed: options.productionDataUsed ? 1 : 0,
      realProviderCalls,
      budgetUsd: options.budgetUsd ?? null,
      totalBudgetCeilingUsd: options.costAttestation?.totalCeilingUsd ?? null,
      targetBudgetCeilingUsd: options.costAttestation?.targetCeilingUsd ?? null,
      judgeBudgetCeilingUsd: options.costAttestation?.judgeCeilingUsd ?? null,
      targetActualSpendUsd: options.costAttestation?.targetActualSpendUsd ?? null,
      judgeEstimatedSpendUsd: options.costAttestation?.judgeEstimatedSpendUsd ?? null,
      targetReservedAttemptCeilingUsd: options.costAttestation?.targetReservedAttemptCeilingUsd ?? null,
      targetCommittedCeilingUsd: options.costAttestation?.targetCommittedCeilingUsd ?? null,
      totalEstimatedActualSpendUsd: options.costAttestation?.totalEstimatedActualSpendUsd ?? null,
      totalConservativeCommitmentUsd: options.costAttestation?.totalConservativeCommitmentUsd ?? null,
      targetUsageCallCount: options.costAttestation?.targetUsageCallCount ?? null,
      targetProviderAttemptCount: options.costAttestation?.targetProviderAttemptCount ?? null,
      costAttestationJson: options.costAttestation ? JSON.stringify(options.costAttestation) : null,
      preflightAttestationJson: options.preflightAttestation ? JSON.stringify(options.preflightAttestation) : null,
      jsonReportPath: options.jsonReportPath ?? null,
      markdownReportPath: options.markdownReportPath ?? null,
      qualityMetricsJson: JSON.stringify(result.qualityMetrics.map(summarizeQualityMetric)),
      dayToDaySummaryJson: JSON.stringify(buildDayToDaySummary(result)),
    });

    db.prepare('DELETE FROM chat_eval_scenario_results WHERE run_id = ?').run(runId);
    const insertScenario = db.prepare(`
      INSERT INTO chat_eval_scenario_results (
        run_id, scenario_id, persona_id, status, evidence_mode, average_score,
        failures_json, notes_json, scores_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const scenario of result.scenarios) {
      insertScenario.run(
        runId,
        scenario.id,
        scenario.personaId,
        scenario.status,
        scenario.evidenceMode,
        scenario.averageScore,
        JSON.stringify(scenario.failures),
        JSON.stringify(scenario.notes),
        JSON.stringify(scenario.scores),
      );
    }
  });

  transaction();

  const row = db.prepare('SELECT id FROM chat_eval_runs WHERE run_id = ?').get(runId) as { id: number };
  if (ownedDb) ownedDb.close();
  return {
    runId,
    runRowId: row.id,
    scenarioCount: result.scenarios.length,
    databasePath: options.databasePath,
  };
}

export function listChatEvalRuns(
  db: Database.Database,
  options: { limit?: number; mode?: ChatEvalMode } = {},
): ChatEvalHistoryRun[] {
  ensureChatEvalHistoryTables(db);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
  const rows = options.mode
    ? db.prepare('SELECT * FROM chat_eval_runs WHERE mode = ? ORDER BY generated_at DESC, id DESC LIMIT ?').all(options.mode, limit)
    : db.prepare('SELECT * FROM chat_eval_runs ORDER BY generated_at DESC, id DESC LIMIT ?').all(limit);
  return rows.map(mapRunRow);
}

export interface ChatEvalLatestRun {
  id: number;
  runId: string;
  mode: ChatEvalMode;
  passed: boolean;
  generatedAt: string;
  createdAt: string;
}

/**
 * Latest recorded run for one eval mode, or null when that mode has never
 * been recorded. Backs the local_engine promote gate: the gate reads
 * `passed` from the newest row only, so a stale green run never masks a
 * newer red one. "Newest" is INSERTION recency (created_at, then id) — not
 * the report's self-declared generated_at — so a clock rollback in the
 * report generator can never resurface an older run as the latest.
 */
export function getLatestChatEvalRunForMode(
  db: Database.Database,
  mode: ChatEvalMode,
): ChatEvalLatestRun | null {
  ensureChatEvalHistoryTables(db);
  const row = db.prepare(`
    SELECT id, run_id, mode, passed, generated_at, created_at
    FROM chat_eval_runs
    WHERE mode = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(mode) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    mode: row.mode as ChatEvalMode,
    passed: Number(row.passed) === 1,
    generatedAt: String(row.generated_at),
    createdAt: String(row.created_at),
  };
}

/**
 * Freeze the first staging real-provider run as the permanent quality
 * comparison identity. The portal route is the only runtime caller and is
 * protected by the portal-admin token; this service repeats every material
 * evidence check so a malformed or non-staging request fails closed.
 */
export function acceptFrozenRealProviderBaseline(
  db: Database.Database,
  input: AcceptFrozenRealProviderBaselineInput,
): AcceptFrozenRealProviderBaselineResult {
  ensureChatEvalHistoryTables(db);
  assertStagingBaselineRuntime(input.runtime);
  assertBaselineArchivePaths(input.runId, input.evidenceJsonPath, input.evidenceMarkdownPath);
  assertBaselineArchiveDigests(input.evidenceJsonSha256, input.evidenceMarkdownSha256);

  const existing = readFrozenBaseline(db);
  if (existing) {
    if (
      existing.runId === input.runId
      && existing.evidenceJsonPath === input.evidenceJsonPath
      && existing.evidenceMarkdownPath === input.evidenceMarkdownPath
      && existing.evidenceJsonSha256 === input.evidenceJsonSha256
      && existing.evidenceMarkdownSha256 === input.evidenceMarkdownSha256
    ) {
      return { action: 'already_frozen', baseline: existing };
    }
    throw new ChatEvalBaselineAcceptanceError(
      'BASELINE_ALREADY_FROZEN',
      `The first real-provider baseline is already frozen as ${existing.runId}.`,
      409,
    );
  }

  const row = db.prepare('SELECT * FROM chat_eval_runs WHERE run_id = ?').get(input.runId) as Record<string, unknown> | undefined;
  if (!row) invalidBaseline('The requested eval run does not exist.');
  const scenarioRows = readScenarioIdentityRows(db, input.runId);
  const evidence = validateFrozenBaselineCandidate(row!, scenarioRows);
  assertBaselineArchiveMatchesRun(row!, input.evidenceJsonPath, input.evidenceMarkdownPath);
  assertRunAggregatesMatchScenarioEvidence(row!, recomputeRunAggregates(db, input.runId));
  const provenance = resolveBaselineProvenance(row!, input.acknowledgeOperatorCheckoutProvenance);
  const acceptedAt = normalizeAcceptedAt(input.acceptedAt);
  const scenarioPassRate = round8(Number(row!.pass_count) / Number(row!.scenario_count));
  const localeLeakageRate = localeLeakageRateFromSummary(row!.day_to_day_summary_json);

  try {
    db.prepare(`
      INSERT INTO chat_eval_frozen_baselines (
        baseline_key, run_row_id, run_id, accepted_at, accepted_via,
        evidence_json_path, evidence_markdown_path,
        evidence_json_sha256, evidence_markdown_sha256,
        provenance_class, deployed_runtime_sha, deployed_artifact_digest,
        git_commit, generated_at,
        scenario_set_hash, eval_contract_version, seed_profile_version,
        average_score, scenario_pass_rate, passed, scenario_count, fail_count,
        blocked_count, locale_leakage_rate,
        total_estimated_actual_spend_usd, total_budget_ceiling_usd
      ) VALUES (?, ?, ?, ?, 'portal_admin_token', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      CHAT_EVAL_FROZEN_BASELINE_KEY,
      Number(row!.id),
      input.runId,
      acceptedAt,
      input.evidenceJsonPath,
      input.evidenceMarkdownPath,
      input.evidenceJsonSha256,
      input.evidenceMarkdownSha256,
      provenance.provenanceClass,
      provenance.deployedRuntimeSha,
      provenance.deployedArtifactDigest,
      String(row!.git_commit),
      String(row!.generated_at),
      scenarioIdentityHash(scenarioRows),
      evidence.contractVersion,
      evidence.seedProfileVersion,
      Number(row!.average_score),
      scenarioPassRate,
      Number(row!.passed) === 1 ? 1 : 0,
      Number(row!.scenario_count),
      Number(row!.fail_count),
      Number(row!.blocked_count),
      localeLeakageRate,
      Number(row!.total_estimated_actual_spend_usd),
      Number(row!.total_budget_ceiling_usd),
    );
  } catch (error) {
    const raced = readFrozenBaseline(db);
    if (raced) {
      if (
        raced.runId === input.runId
        && raced.evidenceJsonPath === input.evidenceJsonPath
        && raced.evidenceMarkdownPath === input.evidenceMarkdownPath
        && raced.evidenceJsonSha256 === input.evidenceJsonSha256
        && raced.evidenceMarkdownSha256 === input.evidenceMarkdownSha256
      ) return { action: 'already_frozen', baseline: raced };
      throw new ChatEvalBaselineAcceptanceError(
        'BASELINE_ALREADY_FROZEN',
        `The first real-provider baseline is already frozen as ${raced.runId}.`,
        409,
      );
    }
    throw error;
  }

  return { action: 'created', baseline: readFrozenBaseline(db)! };
}

/**
 * Aggregate-only baseline read model. A future run is comparable only when
 * its governed live-eval contract, seed profile, and scenario identity set
 * still match the frozen run. Incompatible evidence yields no numeric delta.
 */
export function readFrozenRealProviderBaselineState(
  db: Database.Database,
): ChatEvalFrozenBaselineState {
  ensureChatEvalHistoryTables(db);
  const baseline = readFrozenBaseline(db);
  if (!baseline) {
    return { status: 'not_recorded', baseline: null, latestFollowup: null, comparison: null };
  }

  const row = db.prepare(`
    SELECT * FROM chat_eval_runs
    WHERE mode = 'real_provider' AND id > ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(baseline.runRowId) as Record<string, unknown> | undefined;
  if (!row) return { status: 'baseline_only', baseline, latestFollowup: null, comparison: null };

  const latestFollowup = mapBaselineFollowup(row);
  const scenarioRows = readScenarioIdentityRows(db, latestFollowup.runId);
  const costAttestation = parseJsonObjectOrNull(row.cost_attestation_json);
  const preflight = parseJsonObjectOrNull(row.preflight_attestation_json);
  let reason: ChatEvalBaselineComparison['reason'] = null;
  if (!hasValidFollowupEvidence(row, scenarioRows, costAttestation, preflight)) {
    reason = 'followup_evidence_invalid';
  } else if (String(costAttestation!.contractVersion) !== baseline.evalContractVersion) {
    reason = 'eval_contract_mismatch';
  } else if (String(preflight!.seedProfileVersion) !== baseline.seedProfileVersion) {
    reason = 'seed_profile_mismatch';
  } else if (scenarioIdentityHash(scenarioRows) !== baseline.scenarioSetHash) {
    reason = 'scenario_set_mismatch';
  }

  if (reason) {
    return {
      status: 'incompatible',
      baseline,
      latestFollowup,
      comparison: emptyBaselineComparison(reason),
    };
  }

  return {
    status: 'comparable',
    baseline,
    latestFollowup,
    comparison: {
      comparable: true,
      reason: null,
      averageScoreDelta: round8(latestFollowup.averageScore - baseline.averageScore),
      scenarioPassRateDelta: round8(latestFollowup.scenarioPassRate - baseline.scenarioPassRate),
      failCountDelta: latestFollowup.failCount - baseline.failCount,
      blockedCountDelta: latestFollowup.blockedCount - baseline.blockedCount,
      localeLeakageRateDelta: nullableDelta(latestFollowup.localeLeakageRate, baseline.localeLeakageRate),
      estimatedActualSpendUsdDelta: nullableDelta(
        latestFollowup.totalEstimatedActualSpendUsd,
        baseline.totalEstimatedActualSpendUsd,
      ),
    },
  };
}

function readFrozenBaseline(db: Database.Database): ChatEvalFrozenBaseline | null {
  const row = db.prepare(`
    SELECT * FROM chat_eval_frozen_baselines WHERE baseline_key = ? LIMIT 1
  `).get(CHAT_EVAL_FROZEN_BASELINE_KEY) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    baselineKey: CHAT_EVAL_FROZEN_BASELINE_KEY,
    runRowId: Number(row.run_row_id),
    runId: String(row.run_id),
    acceptedAt: String(row.accepted_at),
    acceptedVia: 'portal_admin_token',
    evidenceJsonPath: String(row.evidence_json_path),
    evidenceMarkdownPath: String(row.evidence_markdown_path),
    evidenceJsonSha256: String(row.evidence_json_sha256),
    evidenceMarkdownSha256: String(row.evidence_markdown_sha256),
    provenanceClass: String(row.provenance_class) as ChatEvalBaselineProvenanceClass,
    deployedRuntimeSha: stringOrNull(row.deployed_runtime_sha),
    deployedArtifactDigest: stringOrNull(row.deployed_artifact_digest),
    gitCommit: String(row.git_commit),
    generatedAt: String(row.generated_at),
    scenarioSetHash: String(row.scenario_set_hash),
    evalContractVersion: String(row.eval_contract_version),
    seedProfileVersion: String(row.seed_profile_version),
    averageScore: Number(row.average_score),
    scenarioPassRate: Number(row.scenario_pass_rate),
    passed: Number(row.passed) === 1,
    scenarioCount: Number(row.scenario_count),
    failCount: Number(row.fail_count),
    blockedCount: Number(row.blocked_count),
    localeLeakageRate: numberOrNull(row.locale_leakage_rate),
    totalEstimatedActualSpendUsd: Number(row.total_estimated_actual_spend_usd),
    totalBudgetCeilingUsd: Number(row.total_budget_ceiling_usd),
  };
}

interface ScenarioIdentityRow {
  scenario_id: string;
  persona_id: string;
  evidence_mode: string;
  scores_json: string;
}

function readScenarioIdentityRows(db: Database.Database, runId: string): ScenarioIdentityRow[] {
  return db.prepare(`
    SELECT scenario_id, persona_id, evidence_mode, scores_json
    FROM chat_eval_scenario_results
    WHERE run_id = ?
    ORDER BY scenario_id ASC, persona_id ASC, evidence_mode ASC
  `).all(runId) as ScenarioIdentityRow[];
}

function scenarioIdentityHash(rows: ScenarioIdentityRow[]): string {
  const identity = rows.map((row) => ({
    scenario_id: row.scenario_id,
    persona_id: row.persona_id,
    evidence_mode: row.evidence_mode,
  }));
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function validateFrozenBaselineCandidate(
  row: Record<string, unknown>,
  scenarioRows: ScenarioIdentityRow[],
): { contractVersion: string; seedProfileVersion: string } {
  if (row.mode !== 'real_provider') invalidBaseline('The frozen baseline must be a real_provider run.');
  if (Number(row.production_data_used) !== 0) {
    invalidBaseline('The frozen baseline must use only the dedicated synthetic staging tenant; production data is forbidden.');
  }
  if (!/^[a-f0-9]{40}$/.test(String(row.git_commit ?? ''))) {
    invalidBaseline('The frozen baseline requires a full committed git SHA.');
  }
  if (scenarioRows.length === 0 || scenarioRows.length !== Number(row.scenario_count)) {
    invalidBaseline('The frozen baseline scenario evidence is missing or incomplete.');
  }
  const cost = parseJsonObjectOrNull(row.cost_attestation_json);
  const preflight = parseJsonObjectOrNull(row.preflight_attestation_json);
  const evidenceIssue = governedRealProviderEvidenceIssue(row, scenarioRows, cost, preflight);
  if (evidenceIssue) invalidBaseline(`The frozen baseline evidence is invalid: ${evidenceIssue}.`);
  return {
    contractVersion: String(cost!.contractVersion),
    seedProfileVersion: String(preflight!.seedProfileVersion),
  };
}

function hasValidFollowupEvidence(
  row: Record<string, unknown>,
  scenarioRows: ScenarioIdentityRow[],
  cost: Record<string, unknown> | null,
  preflight: Record<string, unknown> | null,
): boolean {
  return governedRealProviderEvidenceIssue(row, scenarioRows, cost, preflight) === null;
}

const REQUIRED_JUDGE_SCORE_DIMENSIONS = [
  'wording_quality',
  'groundedness',
  'sufficiency',
  'explanation_quality',
] as const;

const COST_NUMBER_KEYS = [
  'totalCeilingUsd',
  'targetCeilingUsd',
  'judgeCeilingUsd',
  'targetActualSpendUsd',
  'targetReservedAttemptCeilingUsd',
  'targetCommittedCeilingUsd',
  'judgeEstimatedSpendUsd',
  'judgeActualSpendUsd',
  'judgeReservedAttemptCeilingUsd',
  'judgeCommittedCeilingUsd',
  'judgeUsageCallCount',
  'judgeProviderAttemptCount',
  'judgeUnresolvedPricingCount',
  'totalActualSpendUsd',
  'totalEstimatedActualSpendUsd',
  'totalConservativeCommitmentUsd',
  'targetUsageCallCount',
  'targetProviderAttemptCount',
  'unresolvedPricingCount',
] as const;

function governedRealProviderEvidenceIssue(
  row: Record<string, unknown>,
  scenarioRows: ScenarioIdentityRow[],
  cost: Record<string, unknown> | null,
  preflight: Record<string, unknown> | null,
): string | null {
  if (row.mode !== 'real_provider' || Number(row.production_data_used) !== 0) {
    return 'the run is not dedicated synthetic real_provider evidence';
  }
  const scenarioCount = Number(row.scenario_count);
  if (!Number.isSafeInteger(scenarioCount) || scenarioCount <= 0 || scenarioRows.length !== scenarioCount) {
    return 'persisted scenario evidence is missing or incomplete';
  }
  if (
    Number(row.real_provider_calls) !== scenarioCount
    || scenarioRows.some((scenario) => !hasCompleteJudgeCoverage(scenario.scores_json))
  ) {
    return 'successful per-scenario judge coverage is incomplete or inconsistent with provider calls';
  }
  if (
    !cost
    || cost.contractVersion !== 'chat-live-eval-v1'
    || cost.attested !== true
    || !Array.isArray(cost.reasons)
    || cost.reasons.length !== 0
    || COST_NUMBER_KEYS.some((key) => !isFiniteNonNegativeNumber(cost[key]))
  ) {
    return 'cost attestation is missing or malformed';
  }
  const providers = strictStringArray(cost.targetProviders);
  const judgeProviders = strictStringArray(cost.judgeProviders);
  const judgeModels = strictStringArray(cost.judgeModels);
  if (
    !providers
    || providers.length === 0
    || providers.some((provider) => !['anthropic', 'gemini', 'openai'].includes(provider))
    || cost.unresolvedPricingCount !== 0
    || !Number.isSafeInteger(cost.targetUsageCallCount)
    || Number(cost.targetUsageCallCount) <= 0
    || !Number.isSafeInteger(cost.targetProviderAttemptCount)
    || Number(cost.targetProviderAttemptCount) <= 0
  ) {
    return 'target provider usage or pricing evidence is incomplete';
  }
  if (
    !sameStringArrays(judgeProviders, ['gemini'])
    || !sameStringArrays(judgeModels, ['gemini-2.5-flash-lite'])
    || cost.judgeUnresolvedPricingCount !== 0
    || !Number.isSafeInteger(cost.judgeUsageCallCount)
    || Number(cost.judgeUsageCallCount) !== scenarioCount
    || !Number.isSafeInteger(cost.judgeProviderAttemptCount)
    || Number(cost.judgeProviderAttemptCount) !== scenarioCount
    || typeof cost.judgeUsageDatabaseSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(cost.judgeUsageDatabaseSha256)
  ) {
    return 'judge provider usage, pricing, or private-ledger evidence is incomplete';
  }
  if (
    !preflight
    || preflight.contractVersion !== 'chat-live-eval-v1'
    || preflight.mode !== 'real_provider'
    || preflight.runId !== row.run_id
    || preflight.targetBaseCategory !== 'chat_live_eval_real'
    || preflight.providerPolicy !== 'metered_cloud_only'
    || preflight.productionDataUsed !== false
    || typeof preflight.seedProfileVersion !== 'string'
    || preflight.seedProfileVersion.length === 0
  ) {
    return 'authenticated real_provider preflight evidence is missing or malformed';
  }

  const preparation = cost.preparation;
  if (!preparation || typeof preparation !== 'object' || Array.isArray(preparation)) {
    return 'scenario preparation evidence is missing or malformed';
  }
  const preparationRecord = preparation as Record<string, unknown>;
  const scenarioIds = scenarioRows.map((scenario) => scenario.scenario_id).sort();
  const preparedScenarioIds = strictStringArray(preparationRecord.scenarioIds)?.sort() ?? null;
  const supportedScenarioIds = strictStringArray(preflight.supportedScenarioIds)?.sort() ?? null;
  if (
    Number(preparationRecord.scenarioCount) !== scenarioCount
    || !sameStringArrays(preparedScenarioIds, scenarioIds)
    || !sameStringArrays(supportedScenarioIds, scenarioIds)
  ) {
    return 'scenario preparation and preflight evidence do not match persisted scenarios';
  }
  const seedProfileVersions = strictStringArray(preparationRecord.seedProfileVersions);
  const seedProfileHashes = strictStringArray(preparationRecord.seedProfileHashes);
  if (
    !seedProfileVersions
    || seedProfileVersions.length !== 1
    || seedProfileVersions[0] !== preflight.seedProfileVersion
    || !seedProfileHashes
    || seedProfileHashes.length === 0
    || seedProfileHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  ) {
    return 'seed profile preparation is not cross-attested by preflight';
  }

  const budget = preflight.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return 'preflight cost budget is missing or malformed';
  }
  const budgetRecord = budget as Record<string, unknown>;
  if (
    !sameUsd(cost.totalCeilingUsd, 0.5)
    || !sameUsd(cost.targetCeilingUsd, 0.45)
    || !sameUsd(cost.judgeCeilingUsd, 0.05)
    || !sameUsd(budgetRecord.totalCeilingUsd, cost.totalCeilingUsd)
    || !sameUsd(budgetRecord.targetCeilingUsd, cost.targetCeilingUsd)
    || !sameUsd(budgetRecord.judgeCeilingUsd, cost.judgeCeilingUsd)
    || !sameUsd(row.budget_usd, cost.totalCeilingUsd)
  ) {
    return 'preflight, persisted, and attested budget ceilings do not match';
  }

  const rowToCost: Array<[string, typeof COST_NUMBER_KEYS[number]]> = [
    ['total_budget_ceiling_usd', 'totalCeilingUsd'],
    ['target_budget_ceiling_usd', 'targetCeilingUsd'],
    ['judge_budget_ceiling_usd', 'judgeCeilingUsd'],
    ['target_actual_spend_usd', 'targetActualSpendUsd'],
    ['target_reserved_attempt_ceiling_usd', 'targetReservedAttemptCeilingUsd'],
    ['target_committed_ceiling_usd', 'targetCommittedCeilingUsd'],
    ['judge_estimated_spend_usd', 'judgeEstimatedSpendUsd'],
    ['total_estimated_actual_spend_usd', 'totalEstimatedActualSpendUsd'],
    ['total_conservative_commitment_usd', 'totalConservativeCommitmentUsd'],
    ['target_usage_call_count', 'targetUsageCallCount'],
    ['target_provider_attempt_count', 'targetProviderAttemptCount'],
  ];
  if (rowToCost.some(([column, key]) => !sameUsd(row[column], cost[key]))) {
    return 'persisted cost columns do not match their attestation';
  }

  const targetActual = Number(cost.targetActualSpendUsd);
  const targetReserved = Number(cost.targetReservedAttemptCeilingUsd);
  const targetCommitted = Number(cost.targetCommittedCeilingUsd);
  const judgeEstimated = Number(cost.judgeEstimatedSpendUsd);
  const judgeActual = Number(cost.judgeActualSpendUsd);
  const judgeReserved = Number(cost.judgeReservedAttemptCeilingUsd);
  const judgeCommitted = Number(cost.judgeCommittedCeilingUsd);
  const totalActual = Number(cost.totalActualSpendUsd);
  const totalEstimated = Number(cost.totalEstimatedActualSpendUsd);
  const totalConservative = Number(cost.totalConservativeCommitmentUsd);
  if (
    judgeEstimated <= 0
    || judgeActual <= 0
    || judgeReserved <= 0
    || !sameUsd(targetCommitted, targetActual + targetReserved)
    || !sameUsd(judgeReserved, judgeEstimated)
    || !sameUsd(judgeCommitted, judgeActual + judgeReserved)
    || judgeActual > judgeReserved + 1e-8
    || !sameUsd(totalActual, targetActual + judgeActual)
    || !sameUsd(totalEstimated, totalActual)
    || !sameUsd(totalConservative, targetCommitted + judgeCommitted)
    || targetCommitted > Number(cost.targetCeilingUsd) + 1e-8
    || judgeCommitted > Number(cost.judgeCeilingUsd) + 1e-8
    || totalActual > Number(cost.totalCeilingUsd) + 1e-8
    || totalEstimated > Number(cost.totalCeilingUsd) + 1e-8
    || totalConservative > Number(cost.totalCeilingUsd) + 1e-8
  ) {
    return 'cost arithmetic is incoherent or exceeds a governed ceiling';
  }
  return null;
}

function hasCompleteJudgeCoverage(rawScores: string): boolean {
  const scores = parseJsonObject(rawScores);
  return REQUIRED_JUDGE_SCORE_DIMENSIONS.every((dimension) => {
    const score = scores[dimension];
    return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 2;
  });
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function strictStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) return null;
  const normalized = value.map((item) => (item as string).trim());
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function sameStringArrays(left: string[] | null, right: string[]): boolean {
  return Boolean(left && JSON.stringify(left) === JSON.stringify(right));
}

function sameUsd(left: unknown, right: unknown): boolean {
  return typeof left === 'number'
    && Number.isFinite(left)
    && typeof right === 'number'
    && Number.isFinite(right)
    && Math.abs(left - right) <= 1e-8;
}

function assertStagingBaselineRuntime(runtime: AcceptFrozenRealProviderBaselineInput['runtime']): void {
  const nodeEnv = String(runtime.nodeEnv ?? '').trim().toLowerCase();
  const nexusEnv = String(runtime.nexusEnv ?? '').trim().toLowerCase();
  const staging = String(runtime.staging ?? '').trim().toLowerCase();
  if (
    nodeEnv === 'production'
    || nexusEnv === 'production'
    || !(nodeEnv === 'staging' || staging === 'true' || staging === '1')
  ) {
    invalidBaseline('Frozen real-provider baseline acceptance is restricted to staging.');
  }
}

/** Run ids become archive path segments, so they may not shape the path. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,160}$/;
const FULL_SHA256 = /^[a-f0-9]{64}$/;

function assertBaselineArchivePaths(runId: string, jsonPath: string, markdownPath: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId.includes('..')) {
    invalidBaseline('Frozen baseline run id must be a plain archive-safe identifier.');
  }
  const base = `docs/release/eval-evidence/${runId}`;
  if (jsonPath !== `${base}.json` || markdownPath !== `${base}.md`) {
    invalidBaseline(`Frozen baseline evidence paths must be the exact docs/release/eval-evidence/${runId}.{json,md} pair.`);
  }
}

function assertBaselineArchiveDigests(jsonSha256: unknown, markdownSha256: unknown): void {
  if (!FULL_SHA256.test(String(jsonSha256 ?? '')) || !FULL_SHA256.test(String(markdownSha256 ?? ''))) {
    invalidBaseline('Frozen baseline requires the full lowercase SHA-256 digest of both archive files.');
  }
}

/**
 * The archive the operator is freezing must be the one the run itself declared
 * when it posted its evidence. Without this, a valid run could be frozen
 * against an unrelated committed file.
 */
function assertBaselineArchiveMatchesRun(
  row: Record<string, unknown>,
  jsonPath: string,
  markdownPath: string,
): void {
  const declaredJson = stringOrNull(row.json_report_path);
  const declaredMarkdown = stringOrNull(row.markdown_report_path);
  if (!declaredJson || !declaredMarkdown) {
    invalidBaseline('The frozen baseline run did not record its own archive report paths.');
  }
  if (declaredJson !== jsonPath || declaredMarkdown !== markdownPath) {
    invalidBaseline('Frozen baseline archive paths do not match the report paths recorded by the run.');
  }
}

interface BaselineProvenance {
  provenanceClass: ChatEvalBaselineProvenanceClass;
  deployedRuntimeSha: string | null;
  deployedArtifactDigest: string | null;
}

/**
 * Classify how the run bound itself to the artifact that served it. The
 * identity lives in the persisted preflight attestation because only the
 * serving process could report it.
 */
function resolveBaselineProvenance(
  row: Record<string, unknown>,
  acknowledged: boolean | undefined,
): BaselineProvenance {
  const preflight = parseJsonObjectOrNull(row.preflight_attestation_json);
  const deployed = preflight?.deployedRelease;
  const identity = deployed && typeof deployed === 'object' && !Array.isArray(deployed)
    ? deployed as Record<string, unknown>
    : null;
  const runtimeSha = typeof identity?.runtimeSha === 'string' ? identity.runtimeSha : '';
  const artifactDigest = typeof identity?.artifactDigest === 'string' ? identity.artifactDigest : '';

  if (/^[a-f0-9]{40}$/.test(runtimeSha) && /^[a-f0-9]{64}$/.test(artifactDigest) && identity?.role === 'staging') {
    return {
      provenanceClass: 'deployed_artifact_attested',
      deployedRuntimeSha: runtimeSha,
      deployedArtifactDigest: artifactDigest,
    };
  }

  if (acknowledged !== true) {
    invalidBaseline(
      'This run carries no server-attested deployed release identity. Freezing it as the permanent baseline '
      + 'requires explicitly acknowledging the reduced operator-checkout provenance.',
    );
  }
  return {
    provenanceClass: 'operator_checkout_only',
    deployedRuntimeSha: null,
    deployedArtifactDigest: null,
  };
}

interface RecomputedRunAggregates {
  scenarioCount: number;
  passCount: number;
  partialCount: number;
  failCount: number;
  blockedCount: number;
  averageScore: number;
}

function recomputeRunAggregates(db: Database.Database, runId: string): RecomputedRunAggregates {
  const rows = db.prepare(`
    SELECT status, average_score FROM chat_eval_scenario_results WHERE run_id = ?
  `).all(runId) as Array<{ status: string; average_score: number }>;

  const counts = { pass: 0, partial: 0, fail: 0, blocked: 0 } as Record<string, number>;
  let scoreTotal = 0;
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    scoreTotal += Number(row.average_score);
  }
  return {
    scenarioCount: rows.length,
    passCount: counts.pass,
    partialCount: counts.partial,
    failCount: counts.fail,
    blockedCount: counts.blocked,
    averageScore: rows.length > 0 ? scoreTotal / rows.length : 0,
  };
}

/**
 * The run-level aggregates arrive from the evaluation client. Before they
 * become a permanent, immutable comparison identity they must agree with the
 * per-scenario evidence persisted alongside them in this same database.
 */
function assertRunAggregatesMatchScenarioEvidence(
  row: Record<string, unknown>,
  recomputed: RecomputedRunAggregates,
): void {
  const declared = {
    scenarioCount: Number(row.scenario_count),
    passCount: Number(row.pass_count),
    partialCount: Number(row.partial_count),
    failCount: Number(row.fail_count),
    blockedCount: Number(row.blocked_count),
  };
  for (const [field, value] of Object.entries(declared)) {
    if (value !== recomputed[field as keyof RecomputedRunAggregates]) {
      invalidBaseline(
        `The frozen baseline ${field} does not match the recomputed value from its persisted scenario evidence.`,
      );
    }
  }
  if (round8(Number(row.average_score)) !== round8(recomputed.averageScore)) {
    invalidBaseline(
      'The frozen baseline average score does not match the recomputed value from its persisted scenario evidence.',
    );
  }
}

function normalizeAcceptedAt(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) invalidBaseline('Frozen baseline acceptance timestamp is invalid.');
  return date.toISOString();
}

function invalidBaseline(message: string): never {
  throw new ChatEvalBaselineAcceptanceError('INVALID_BASELINE', message, 400);
}

function mapBaselineFollowup(row: Record<string, unknown>): ChatEvalBaselineFollowup {
  return {
    runRowId: Number(row.id),
    runId: String(row.run_id),
    generatedAt: String(row.generated_at),
    gitCommit: stringOrNull(row.git_commit),
    averageScore: Number(row.average_score),
    scenarioPassRate: Number(row.scenario_count) > 0
      ? round8(Number(row.pass_count) / Number(row.scenario_count))
      : 0,
    passed: Number(row.passed) === 1,
    scenarioCount: Number(row.scenario_count),
    failCount: Number(row.fail_count),
    blockedCount: Number(row.blocked_count),
    localeLeakageRate: localeLeakageRateFromSummary(row.day_to_day_summary_json),
    totalEstimatedActualSpendUsd: numberOrNull(row.total_estimated_actual_spend_usd),
    totalBudgetCeilingUsd: numberOrNull(row.total_budget_ceiling_usd),
  };
}

function localeLeakageRateFromSummary(raw: unknown): number | null {
  const summary = parseJsonObject(raw);
  const locale = summary.localeLeakage;
  if (!locale || typeof locale !== 'object' || Array.isArray(locale)) return null;
  const observed = Number((locale as Record<string, unknown>).observedTurnCount);
  const leaked = Number((locale as Record<string, unknown>).leakedTurnCount);
  return Number.isFinite(observed) && observed > 0 && Number.isFinite(leaked) && leaked >= 0
    ? round8(leaked / observed)
    : null;
}

function emptyBaselineComparison(reason: NonNullable<ChatEvalBaselineComparison['reason']>): ChatEvalBaselineComparison {
  return {
    comparable: false,
    reason,
    averageScoreDelta: null,
    scenarioPassRateDelta: null,
    failCountDelta: null,
    blockedCountDelta: null,
    localeLeakageRateDelta: null,
    estimatedActualSpendUsdDelta: null,
  };
}

function nullableDelta(current: number | null, baseline: number | null): number | null {
  return current == null || baseline == null ? null : round8(current - baseline);
}

function round8(value: number): number {
  return Number(value.toFixed(8));
}

function normalizeProviderCallCount(value: PersistChatEvalRunOptions['realProviderCalls'], mode: ChatEvalMode): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'boolean') return value ? 1 : 0;
  return mode === 'real_provider' ? 1 : 0;
}

function summarizeQualityMetric(metric: ChatEvaluationSuiteResult['qualityMetrics'][number]): Record<string, unknown> {
  return {
    id: metric.id,
    label: metric.label,
    source: metric.source,
    privacy: metric.privacy,
    target: metric.target,
  };
}

function buildDayToDaySummary(result: ChatEvaluationSuiteResult): Record<string, unknown> {
  return {
    generatedAt: result.dayToDay.generatedAt,
    mode: result.dayToDay.mode,
    passed: result.dayToDay.passed,
    scenarioCount: result.dayToDay.scenarios.length,
    averageScore: result.dayToDay.averageScore,
    failureSummary: result.dayToDay.failureSummary,
    profileCoverage: result.dayToDay.profileCoverage,
    catalogCoverage: result.catalogCoverage,
    localeLeakage: buildLocaleLeakageSummary(result),
  };
}

function buildLocaleLeakageSummary(result: ChatEvaluationSuiteResult): Record<string, unknown> {
  let observedTurnCount = 0;
  let leakedTurnCount = 0;
  let unknownTurnCount = 0;
  const byExpectedLocale: Record<string, { observedTurnCount: number; leakedTurnCount: number; unknownTurnCount: number }> = {};
  for (const scenario of result.dayToDay.scenarios) {
    for (const turn of scenario.turns) {
      if (!turn.expectedLanguage || turn.executionStatus === 'blocked') continue;
      const locale = turn.expectedLanguage.toLowerCase();
      const bucket = byExpectedLocale[locale] ?? { observedTurnCount: 0, leakedTurnCount: 0, unknownTurnCount: 0 };
      const dimension = turn.scorerDimensions?.find((entry) => entry.dimension === 'response_language');
      if (!dimension || dimension.detail.includes('undecidable')) {
        unknownTurnCount += 1;
        bucket.unknownTurnCount += 1;
      } else {
        observedTurnCount += 1;
        bucket.observedTurnCount += 1;
        if (dimension.passed === false) {
          leakedTurnCount += 1;
          bucket.leakedTurnCount += 1;
        }
      }
      byExpectedLocale[locale] = bucket;
    }
  }
  return { observedTurnCount, leakedTurnCount, unknownTurnCount, byExpectedLocale };
}

function mapRunRow(raw: unknown): ChatEvalHistoryRun {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    mode: row.mode as ChatEvalMode,
    generatedAt: String(row.generated_at),
    packageVersion: stringOrNull(row.package_version),
    gitBranch: stringOrNull(row.git_branch),
    gitCommit: stringOrNull(row.git_commit),
    averageScore: Number(row.average_score),
    scenarioCount: Number(row.scenario_count),
    passCount: Number(row.pass_count),
    partialCount: Number(row.partial_count),
    failCount: Number(row.fail_count),
    blockedCount: Number(row.blocked_count),
    passed: Number(row.passed) === 1,
    productionDataUsed: Number(row.production_data_used) === 1,
    realProviderCalls: Number(row.real_provider_calls ?? 0),
    budgetUsd: row.budget_usd == null ? null : Number(row.budget_usd),
    totalBudgetCeilingUsd: numberOrNull(row.total_budget_ceiling_usd),
    targetBudgetCeilingUsd: numberOrNull(row.target_budget_ceiling_usd),
    judgeBudgetCeilingUsd: numberOrNull(row.judge_budget_ceiling_usd),
    targetActualSpendUsd: numberOrNull(row.target_actual_spend_usd),
    judgeEstimatedSpendUsd: numberOrNull(row.judge_estimated_spend_usd),
    targetReservedAttemptCeilingUsd: numberOrNull(row.target_reserved_attempt_ceiling_usd),
    targetCommittedCeilingUsd: numberOrNull(row.target_committed_ceiling_usd),
    totalEstimatedActualSpendUsd: numberOrNull(row.total_estimated_actual_spend_usd),
    totalConservativeCommitmentUsd: numberOrNull(row.total_conservative_commitment_usd),
    targetUsageCallCount: Number(row.target_usage_call_count ?? 0),
    targetProviderAttemptCount: Number(row.target_provider_attempt_count ?? 0),
    costAttestation: parseJsonObjectOrNull(row.cost_attestation_json) as ChatEvalRunCostAttestation | null,
    preflightAttestation: parseJsonObjectOrNull(row.preflight_attestation_json),
    jsonReportPath: stringOrNull(row.json_report_path),
    markdownReportPath: stringOrNull(row.markdown_report_path),
    qualityMetrics: parseJsonArray(row.quality_metrics_json),
    dayToDaySummary: parseJsonObject(row.day_to_day_summary_json),
    createdAt: String(row.created_at),
  };
}

function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => item && typeof item === 'object' && !Array.isArray(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseJsonObject(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}
