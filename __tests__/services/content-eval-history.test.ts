import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runContentDayToDayEvaluation } from '../../src/services/content-day-to-day-evaluation';
import {
  ensureContentEvalHistoryTables,
  persistContentEvalRun,
} from '../../src/services/content-eval-history';

let db: Database.Database;

describe('Content eval history', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates normalized eval history tables without raw transcript columns', () => {
    ensureContentEvalHistoryTables(db);

    const runColumns = db.prepare('PRAGMA table_info(content_eval_runs)').all() as Array<{ name: string }>;
    const caseColumns = db.prepare('PRAGMA table_info(content_eval_case_results)').all() as Array<{ name: string }>;

    expect(runColumns.map((column) => column.name)).toContain('overall_score');
    expect(caseColumns.map((column) => column.name)).toContain('dimension_scores_json');
    expect(caseColumns.map((column) => column.name)).not.toContain('transcript_json');
    expect(caseColumns.map((column) => column.name)).not.toContain('raw_prompt');
  });

  it('persists score, release-gate, provider metadata, and per-case dimensions', () => {
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });

    const persisted = persistContentEvalRun(result, {
      db,
      runId: 'content-eval-test',
      packageVersion: '4.14.97',
      gitBranch: 'feature/content',
      gitCommit: 'abc1234',
      jsonReportPath: 'reports/content-eval/test.json',
      markdownReportPath: 'reports/content-eval/test.md',
    });

    expect(persisted.runId).toBe('content-eval-test');
    expect(persisted.caseCount).toBe(result.aggregate.caseCount);

    const run = db.prepare('SELECT * FROM content_eval_runs WHERE run_id = ?').get('content-eval-test') as any;
    expect(run.skill_id).toBe('content');
    expect(run.skill_version).toBe('content@2.3.0-rc.1');
    expect(run.mode).toBe('fixture');
    expect(run.overall_score).toBe(result.aggregate.overallScore);
    expect(run.release_gate).toBe(result.aggregate.releaseGate);
    expect(run.provider).toBe('fixture');
    expect(run.model).toBe('deterministic-content-fixture');
    expect(run.production_data_used).toBe(0);
    expect(run.real_provider_calls).toBe(0);
    expect(run.json_report_path).toBe('reports/content-eval/test.json');

    const caseCount = db.prepare('SELECT COUNT(*) as count FROM content_eval_case_results WHERE run_id = ?')
      .get('content-eval-test') as { count: number };
    expect(caseCount.count).toBe(result.aggregate.caseCount);

    const firstCase = db.prepare('SELECT * FROM content_eval_case_results WHERE run_id = ? ORDER BY id ASC LIMIT 1')
      .get('content-eval-test') as any;
    expect(JSON.parse(firstCase.failures_json)).toEqual(expect.any(Array));
    expect(JSON.parse(firstCase.dimension_scores_json)).toHaveProperty('tenant_safety');
    expect(JSON.parse(firstCase.provider_trace_json)).toMatchObject({
      category: 'content_day_to_day_eval',
      preservesLiveRouting: true,
    });
  });

  it('updates an existing run idempotently instead of duplicating case rows', () => {
    const first = runContentDayToDayEvaluation({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const second = runContentDayToDayEvaluation({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:30:00.000Z',
    });

    persistContentEvalRun(first, { db, runId: 'content-eval-repeat' });
    persistContentEvalRun(second, { db, runId: 'content-eval-repeat' });

    const runCount = db.prepare('SELECT COUNT(*) as count FROM content_eval_runs WHERE run_id = ?')
      .get('content-eval-repeat') as { count: number };
    const caseCount = db.prepare('SELECT COUNT(*) as count FROM content_eval_case_results WHERE run_id = ?')
      .get('content-eval-repeat') as { count: number };

    expect(runCount.count).toBe(1);
    expect(caseCount.count).toBe(second.aggregate.caseCount);
  });
});
