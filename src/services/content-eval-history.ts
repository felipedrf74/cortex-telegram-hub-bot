// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import type {
  ContentDayToDayEvalResult,
  ContentEvalCaseResult,
} from './content-day-to-day-evaluation';

export interface PersistContentEvalRunOptions {
  databasePath?: string;
  db?: Database.Database;
  runId?: string;
  skillVersion?: string;
  packageVersion?: string;
  gitBranch?: string;
  gitCommit?: string;
  jsonReportPath?: string;
  markdownReportPath?: string;
}

export interface PersistContentEvalRunResult {
  runId: string;
  runRowId: number;
  caseCount: number;
  databasePath?: string;
}

export function ensureContentEvalHistoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_eval_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      skill_id TEXT NOT NULL DEFAULT 'content',
      skill_version TEXT,
      mode TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      package_version TEXT,
      git_branch TEXT,
      git_commit TEXT,
      overall_score INTEGER NOT NULL,
      min_score INTEGER NOT NULL,
      case_count INTEGER NOT NULL,
      pass_count INTEGER NOT NULL,
      partial_count INTEGER NOT NULL,
      fail_count INTEGER NOT NULL,
      critical_failure_count INTEGER NOT NULL,
      release_gate TEXT NOT NULL,
      passed INTEGER NOT NULL,
      production_data_used INTEGER NOT NULL DEFAULT 0,
      real_provider_calls INTEGER NOT NULL DEFAULT 0,
      provider TEXT,
      model TEXT,
      tier TEXT,
      category TEXT,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      execution_evidence_json TEXT NOT NULL DEFAULT '{}',
      json_report_path TEXT,
      markdown_report_path TEXT,
      open_conditions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_eval_case_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      status TEXT NOT NULL,
      score INTEGER NOT NULL,
      failures_json TEXT NOT NULL DEFAULT '[]',
      dimension_scores_json TEXT NOT NULL DEFAULT '{}',
      provider_trace_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, case_id)
    );

    CREATE INDEX IF NOT EXISTS idx_content_eval_runs_generated_at
      ON content_eval_runs(generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_eval_runs_gate
      ON content_eval_runs(skill_id, release_gate, mode);
    CREATE INDEX IF NOT EXISTS idx_content_eval_case_results_run
      ON content_eval_case_results(run_id, scenario_id, persona_id);
  `);

  // Existing local history databases predate executable-lane provenance.
  // Add the column in place without rewriting or discarding prior runs.
  const runColumns = db.prepare('PRAGMA table_info(content_eval_runs)').all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === 'execution_evidence_json')) {
    db.exec("ALTER TABLE content_eval_runs ADD COLUMN execution_evidence_json TEXT NOT NULL DEFAULT '{}'");
  }
}

export function persistContentEvalRun(
  result: ContentDayToDayEvalResult,
  options: PersistContentEvalRunOptions = {},
): PersistContentEvalRunResult {
  const ownedDb = options.db ? null : new Database(options.databasePath || 'reports/content-eval/content-eval-history.sqlite');
  const db = options.db ?? ownedDb!;
  ensureContentEvalHistoryTables(db);

  const runId = options.runId ?? `content-eval-${result.generatedAt.replace(/[:.]/g, '-')}`;
  const trace = firstProviderTrace(result.cases);
  const providerInvocation = result.aggregate.laneEvidence.realProviderSample.providerInvocations?.[0];
  const productionDataUsed = result.cases.some((testCase) => testCase.output.providerTrace.productionDataUsed);
  const realProviderCalls = result.aggregate.laneEvidence.realProviderSample.status === 'executed'
    ? result.aggregate.laneEvidence.realProviderSample.invocationCount
    : 0;
  const fallbackUsed = result.cases.some((testCase) => testCase.output.providerTrace.fallbackUsed);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO content_eval_runs (
        run_id, skill_version, mode, generated_at, package_version, git_branch, git_commit,
        overall_score, min_score, case_count, pass_count, partial_count, fail_count,
        critical_failure_count, release_gate, passed, production_data_used, real_provider_calls,
        provider, model, tier, category, fallback_used, execution_evidence_json, json_report_path, markdown_report_path,
        open_conditions_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        skill_version = excluded.skill_version,
        mode = excluded.mode,
        generated_at = excluded.generated_at,
        package_version = excluded.package_version,
        git_branch = excluded.git_branch,
        git_commit = excluded.git_commit,
        overall_score = excluded.overall_score,
        min_score = excluded.min_score,
        case_count = excluded.case_count,
        pass_count = excluded.pass_count,
        partial_count = excluded.partial_count,
        fail_count = excluded.fail_count,
        critical_failure_count = excluded.critical_failure_count,
        release_gate = excluded.release_gate,
        passed = excluded.passed,
        production_data_used = excluded.production_data_used,
        real_provider_calls = excluded.real_provider_calls,
        provider = excluded.provider,
        model = excluded.model,
        tier = excluded.tier,
        category = excluded.category,
        fallback_used = excluded.fallback_used,
        execution_evidence_json = excluded.execution_evidence_json,
        json_report_path = excluded.json_report_path,
        markdown_report_path = excluded.markdown_report_path,
        open_conditions_json = excluded.open_conditions_json
    `).run(
      runId,
      options.skillVersion ?? 'content@2.3.0-rc.1',
      result.mode,
      result.generatedAt,
      options.packageVersion ?? null,
      options.gitBranch ?? null,
      options.gitCommit ?? null,
      result.aggregate.overallScore,
      result.aggregate.minScore,
      result.aggregate.caseCount,
      result.aggregate.passCount,
      result.aggregate.partialCount,
      result.aggregate.failCount,
      result.aggregate.criticalFailureCount,
      result.aggregate.releaseGate,
      result.passed ? 1 : 0,
      productionDataUsed ? 1 : 0,
      realProviderCalls,
      providerInvocation?.provider ?? trace?.provider ?? null,
      providerInvocation?.model ?? trace?.model ?? null,
      providerInvocation?.tier ?? trace?.tier ?? null,
      providerInvocation?.category ?? trace?.category ?? null,
      fallbackUsed ? 1 : 0,
      JSON.stringify(result.aggregate.laneEvidence),
      options.jsonReportPath ?? null,
      options.markdownReportPath ?? null,
      JSON.stringify(result.openConditions),
    );

    db.prepare('DELETE FROM content_eval_case_results WHERE run_id = ?').run(runId);
    const insertCase = db.prepare(`
      INSERT INTO content_eval_case_results (
        run_id, case_id, persona_id, scenario_id, status, score,
        failures_json, dimension_scores_json, provider_trace_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const testCase of result.cases) {
      insertCase.run(
        runId,
        testCase.id,
        testCase.personaId,
        testCase.scenarioId,
        testCase.status,
        testCase.score,
        JSON.stringify(testCase.failures),
        JSON.stringify(testCase.dimensionScores),
        JSON.stringify(testCase.output.providerTrace),
      );
    }
  });

  transaction();

  const row = db.prepare('SELECT id FROM content_eval_runs WHERE run_id = ?').get(runId) as { id: number };
  if (ownedDb) ownedDb.close();
  return {
    runId,
    runRowId: row.id,
    caseCount: result.cases.length,
    databasePath: options.databasePath,
  };
}

function firstProviderTrace(cases: ContentEvalCaseResult[]): ContentEvalCaseResult['output']['providerTrace'] | undefined {
  return cases[0]?.output.providerTrace;
}
