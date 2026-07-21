// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import type {
  ChatEvalMode,
  ChatEvaluationSuiteResult,
  ChatEvalScenarioResult,
  ChatEvalStatus,
} from './chat-evaluation-harness';

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
  jsonReportPath: string | null;
  markdownReportPath: string | null;
  qualityMetrics: Array<Record<string, unknown>>;
  dayToDaySummary: Record<string, unknown>;
  createdAt: string;
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
        budget_usd, json_report_path, markdown_report_path,
        quality_metrics_json, day_to_day_summary_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        json_report_path = excluded.json_report_path,
        markdown_report_path = excluded.markdown_report_path,
        quality_metrics_json = excluded.quality_metrics_json,
        day_to_day_summary_json = excluded.day_to_day_summary_json
    `).run(
      runId,
      result.mode,
      result.generatedAt,
      options.packageVersion ?? null,
      options.gitBranch ?? null,
      options.gitCommit ?? null,
      result.averageScore,
      result.scenarioCount,
      result.statusCounts.pass ?? 0,
      result.statusCounts.partial ?? 0,
      result.statusCounts.fail ?? 0,
      result.statusCounts.blocked ?? 0,
      result.passed ? 1 : 0,
      options.productionDataUsed ? 1 : 0,
      realProviderCalls,
      options.budgetUsd ?? null,
      options.jsonReportPath ?? null,
      options.markdownReportPath ?? null,
      JSON.stringify(result.qualityMetrics.map(summarizeQualityMetric)),
      JSON.stringify(buildDayToDaySummary(result)),
    );

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
  };
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
