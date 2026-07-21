import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runChatEvaluationSuite } from '../../src/services/chat-evaluation-harness';
import {
  ensureChatEvalHistoryTables,
  listChatEvalRuns,
  persistChatEvalRun,
} from '../../src/services/chat-eval-history';

let db: Database.Database;

describe('Chat eval history', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates normalized eval history tables without raw transcript columns', () => {
    ensureChatEvalHistoryTables(db);

    const runColumns = db.prepare('PRAGMA table_info(chat_eval_runs)').all() as Array<{ name: string }>;
    const scenarioColumns = db.prepare('PRAGMA table_info(chat_eval_scenario_results)').all() as Array<{ name: string }>;

    expect(runColumns.map((column) => column.name)).toContain('quality_metrics_json');
    expect(runColumns.map((column) => column.name)).toContain('day_to_day_summary_json');
    expect(scenarioColumns.map((column) => column.name)).toContain('scores_json');
    expect(scenarioColumns.map((column) => column.name)).not.toContain('turns_json');
    expect(scenarioColumns.map((column) => column.name)).not.toContain('raw_prompt');
    expect(scenarioColumns.map((column) => column.name)).not.toContain('provider_payload_json');
  });

  it('persists aggregate score, report metadata, and per-scenario results', async () => {
    const result = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });

    const persisted = persistChatEvalRun(result, {
      db,
      runId: 'chat-eval-test',
      packageVersion: '4.14.190',
      gitBranch: 'feature/chat-eval',
      gitCommit: 'abc1234',
      jsonReportPath: 'reports/chat-eval/test.json',
      markdownReportPath: 'reports/chat-eval/test.md',
      budgetUsd: 4,
    });

    expect(persisted.runId).toBe('chat-eval-test');
    expect(persisted.scenarioCount).toBe(result.scenarioCount);

    const run = db.prepare('SELECT * FROM chat_eval_runs WHERE run_id = ?').get('chat-eval-test') as any;
    expect(run.mode).toBe('fixture');
    expect(run.average_score).toBe(result.averageScore);
    expect(run.scenario_count).toBe(result.scenarioCount);
    expect(run.pass_count).toBe(result.statusCounts.pass);
    expect(run.passed).toBe(result.passed ? 1 : 0);
    expect(run.production_data_used).toBe(0);
    expect(run.real_provider_calls).toBe(0);
    expect(run.budget_usd).toBe(4);
    expect(run.json_report_path).toBe('reports/chat-eval/test.json');

    const dayToDaySummary = JSON.parse(run.day_to_day_summary_json);
    expect(dayToDaySummary).toMatchObject({
      mode: 'fixture',
      passed: true,
      scenarioCount: result.dayToDay.scenarios.length,
    });
    expect(JSON.stringify(dayToDaySummary)).not.toContain('userMessage');
    expect(JSON.stringify(dayToDaySummary)).not.toContain('turns');

    const scenarioCount = db.prepare('SELECT COUNT(*) as count FROM chat_eval_scenario_results WHERE run_id = ?')
      .get('chat-eval-test') as { count: number };
    expect(scenarioCount.count).toBe(result.scenarioCount);

    const firstScenario = db.prepare('SELECT * FROM chat_eval_scenario_results WHERE run_id = ? ORDER BY id ASC LIMIT 1')
      .get('chat-eval-test') as any;
    expect(JSON.parse(firstScenario.failures_json)).toEqual(expect.any(Array));
    expect(JSON.parse(firstScenario.notes_json)).toEqual(expect.any(Array));
    expect(JSON.parse(firstScenario.scores_json)).toHaveProperty('tenantIsolation');
  });

  it('updates an existing run idempotently instead of duplicating scenario rows', async () => {
    const first = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const second = await runChatEvaluationSuite({
      mode: 'real_provider',
      generatedAt: '2026-04-29T12:30:00.000Z',
    });

    persistChatEvalRun(first, { db, runId: 'chat-eval-repeat' });
    persistChatEvalRun(second, { db, runId: 'chat-eval-repeat', realProviderCalls: 7 });

    const runCount = db.prepare('SELECT COUNT(*) as count FROM chat_eval_runs WHERE run_id = ?')
      .get('chat-eval-repeat') as { count: number };
    const scenarioCount = db.prepare('SELECT COUNT(*) as count FROM chat_eval_scenario_results WHERE run_id = ?')
      .get('chat-eval-repeat') as { count: number };
    const run = db.prepare('SELECT * FROM chat_eval_runs WHERE run_id = ?').get('chat-eval-repeat') as any;

    expect(runCount.count).toBe(1);
    expect(scenarioCount.count).toBe(second.scenarioCount);
    expect(run.mode).toBe('real_provider');
    expect(run.real_provider_calls).toBe(7);
  });

  it('lists recent runs with parsed metadata only', async () => {
    const first = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const second = await runChatEvaluationSuite({
      mode: 'real_provider',
      generatedAt: '2026-04-30T12:00:00.000Z',
    });

    persistChatEvalRun(first, { db, runId: 'chat-eval-old' });
    persistChatEvalRun(second, { db, runId: 'chat-eval-new', realProviderCalls: true });

    const runs = listChatEvalRuns(db, { limit: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('chat-eval-new');
    expect(runs[0].qualityMetrics[0]).toHaveProperty('privacy');
    expect(runs[0].dayToDaySummary).toHaveProperty('failureSummary');
    expect(JSON.stringify(runs[0])).not.toContain('userMessage');
  });
});
