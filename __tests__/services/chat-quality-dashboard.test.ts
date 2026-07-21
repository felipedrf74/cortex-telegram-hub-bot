import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn(() => {
    throw new Error('tests must pass an explicit db');
  }),
  withDatabaseForTestAsync: vi.fn(),
}));

// The dashboard must never touch a live provider; routing-accuracy's import
// chain includes provider-backed modules, so make any live call observable.
vi.mock('../../src/services/provider-registry', () => ({
  getActiveProvider: vi.fn(() => {
    throw new Error('dashboard must not touch providers');
  }),
  getProvider: vi.fn(),
}));

vi.mock('../../src/services/anthropic', () => ({
  classifyMessage: vi.fn(() => {
    throw new Error('dashboard must not classify');
  }),
}));

import { persistChatEvalRun } from '../../src/services/chat-eval-history';
import type { ChatEvaluationSuiteResult } from '../../src/services/chat-evaluation-harness';
import {
  recordChatQualityGateOutcome,
  resetChatQualityGateOutcomeCountersForTests,
} from '../../src/services/chat-hybrid-metrics';
import { ensureRoutingCorpusTables } from '../../src/services/routing-corpus';
import { storeAcceptedAccuracySnapshot, type RoutingAccuracyReport } from '../../src/services/routing-accuracy';
import {
  ensureChatCoreV2OnlineEvalTables,
  recordChatV2OnlineEvalSample,
  CHAT_CORE_V2_ONLINE_EVAL_SAMPLER_VERSION,
} from '../../src/services/chat-core-v2/online-eval-sampler';
import type { ChatV2CompletionReadinessReportLike } from '../../src/services/chatv2-readiness-alerts';
import {
  buildChatQualityDashboard,
  loadChatV2ReadinessReportFromFile,
  DEFAULT_CHAT_V2_READINESS_REPORT_PATH,
} from '../../src/services/chat-quality-dashboard';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function makeSuiteResult(overrides: Partial<Record<string, unknown>> = {}): ChatEvaluationSuiteResult {
  return {
    generatedAt: '2026-07-18T10:00:00.000Z',
    mode: 'fixture',
    passed: true,
    averageScore: 0.9,
    scenarioCount: 2,
    statusCounts: { pass: 2, partial: 0, fail: 0, blocked: 0 },
    qualityMetrics: [
      { id: 'routeAccuracy', label: 'Route accuracy', source: 'chat_route_metadata', privacy: 'categorical_only', target: '>= 0.95' },
    ],
    dayToDay: {
      generatedAt: '2026-07-18T10:00:00.000Z',
      mode: 'fixture',
      passed: true,
      scenarios: [],
      averageScore: 0.9,
      failureSummary: { wrong_skill_routing: 1, stale_memory: 0 },
    },
    scenarios: [
      {
        id: 'scenario-a',
        title: 'Scenario A',
        personaId: 'persona-1',
        status: 'pass',
        evidenceMode: 'fixture',
        averageScore: 1,
        scores: { grounding: 1, response_language: 1 },
        failures: [],
        notes: [],
      },
      {
        id: 'scenario-b',
        title: 'Scenario B',
        personaId: 'persona-1',
        status: 'partial',
        evidenceMode: 'fixture',
        averageScore: 0.6,
        scores: { grounding: 1, response_language: 0 },
        failures: ['response_language: expected language es, detected pt'],
        notes: [],
      },
    ],
    ...overrides,
  } as unknown as ChatEvaluationSuiteResult;
}

function makeAccuracySnapshot(): RoutingAccuracyReport {
  return {
    version: 'routing-accuracy@1.0.0',
    generatedAt: '2026-07-15T08:00:00.000Z',
    itemCount: 10,
    clarifyAccuracyTarget: 0.85,
    surfaces: [
      {
        surface: 'intent_resolver',
        covered: 10,
        uncovered: 0,
        correct: 9,
        accuracy: 0.9,
        perDomain: [
          { domain: 'secretary', support: 6, truePositives: 6, falsePositives: 1, falseNegatives: 0, precision: 0.8571, recall: 1 },
          { domain: 'finance', support: 4, truePositives: 3, falsePositives: 0, falseNegatives: 1, precision: 1, recall: 0.75 },
        ],
        calibration: [],
        recommendedClarifyThreshold: null,
      },
    ],
  };
}

function makeReadinessReport(): ChatV2CompletionReadinessReportLike {
  return {
    schemaVersion: 'chat_v2_completion_readiness_report.v1',
    generatedAt: '2026-07-19T09:00:00.000Z',
    evidenceSources: ['runtime_route'],
    shadow: { passed: true, gates: [{ gateId: 'shadow_sample_count', passed: true, sampleCount: 100, observed: 100, threshold: 50 }] },
    legacyRetirement: {
      passed: false,
      gates: [
        { gateId: 'legacy_fallback_rate', passed: false, sampleCount: 40, observed: 0.2, threshold: 0.05, reasonCode: 'fallback_regression' },
      ],
    },
  };
}

describe('chat quality dashboard', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureRoutingCorpusTables(db);
    ensureChatCoreV2OnlineEvalTables(db);
    resetChatQualityGateOutcomeCountersForTests();
  });

  afterEach(() => {
    db.close();
    resetChatQualityGateOutcomeCountersForTests();
  });

  function seedEvalRuns(): void {
    persistChatEvalRun(makeSuiteResult(), { db, runId: 'run-recent', budgetUsd: 1.5, realProviderCalls: 3 });
    persistChatEvalRun(
      makeSuiteResult({
        generatedAt: '2026-06-10T10:00:00.000Z',
        passed: false,
        averageScore: 0.7,
        statusCounts: { pass: 1, partial: 0, fail: 1, blocked: 0 },
        dayToDay: {
          generatedAt: '2026-06-10T10:00:00.000Z',
          mode: 'fixture',
          passed: false,
          scenarios: [],
          averageScore: 0.7,
          failureSummary: { wrong_skill_routing: 2, missing_tool_call: 1 },
        },
      }),
      { db, runId: 'run-older', budgetUsd: 0.25 },
    );
  }

  function seedSampler(): void {
    const base = {
      tenantId: 't1',
      userId: 'u1',
      routeMethod: 'llm_synthesis' as const,
      risk: 'low' as const,
      sensitivity: 'normal' as const,
    };
    const decision = (reason: string) => ({
      sample: true,
      status: 'sampled' as const,
      reason: reason as never,
      sampleRate: 1,
      samplerVersion: CHAT_CORE_V2_ONLINE_EVAL_SAMPLER_VERSION,
    });
    recordChatV2OnlineEvalSample(
      { ...base, turnId: 'turn-1', sampleId: 's1', decision: decision('fallback'), createdAt: '2026-07-18T00:00:00.000Z' },
      db,
    );
    recordChatV2OnlineEvalSample(
      { ...base, turnId: 'turn-2', sampleId: 's2', decision: decision('fallback'), createdAt: '2026-07-19T00:00:00.000Z' },
      db,
    );
    recordChatV2OnlineEvalSample(
      { ...base, turnId: 'turn-3', sampleId: 's3', decision: decision('schema_failure'), createdAt: '2026-07-01T00:00:00.000Z' },
      db,
    );
    // Outside the 30-day window — must be excluded.
    recordChatV2OnlineEvalSample(
      { ...base, turnId: 'turn-4', sampleId: 's4', decision: decision('high_risk'), createdAt: '2026-01-01T00:00:00.000Z' },
      db,
    );
  }

  function seedCorpus(): void {
    db.prepare(`
      INSERT INTO routing_corpus_items (tenant_id, user_id, utterance_hash, utterance_text, source, label_status, label_domain, labeled_at)
      VALUES (0, NULL, ?, 'labeled item', 'manual', 'labeled', 'secretary', '2026-07-18 09:00:00')
    `).run('a'.repeat(64));
    db.prepare(`
      INSERT INTO routing_corpus_items (tenant_id, user_id, utterance_hash, utterance_text, source, label_status)
      VALUES (0, NULL, ?, 'pending item', 'manual', 'pending')
    `).run('b'.repeat(64));
  }

  it('aggregates eval trend, failure types, locale leakage, routing, sampler counts, and spend', () => {
    seedEvalRuns();
    seedSampler();
    seedCorpus();
    storeAcceptedAccuracySnapshot(makeAccuracySnapshot(), db);
    recordChatQualityGateOutcome('pass');
    recordChatQualityGateOutcome('pass');
    recordChatQualityGateOutcome('replaced');

    const dashboard = buildChatQualityDashboard(db, {
      now: NOW,
      readinessReport: makeReadinessReport(),
    });

    // Eval trend: newest first with spend + provider calls.
    expect(dashboard.evalTrend.map((run) => run.runId)).toEqual(['run-recent', 'run-older']);
    expect(dashboard.evalTrend[0]).toMatchObject({
      mode: 'fixture',
      passed: true,
      averageScore: 0.9,
      budgetUsd: 1.5,
      realProviderCalls: 3,
    });

    // Failure types summed across runs; zero-count types dropped.
    expect(dashboard.failureTypeBreakdown.runsConsidered).toBe(2);
    expect(dashboard.failureTypeBreakdown.counts).toEqual({
      wrong_skill_routing: 3,
      missing_tool_call: 1,
    });

    // Locale leakage from the newest run's response_language scores; no
    // real_provider run exists, so it falls back to any mode and LABELS it.
    expect(dashboard.localeLeakage).toEqual({
      runId: 'run-recent',
      mode: 'fixture',
      scenarioCount: 2,
      leakedCount: 1,
      rate: 0.5,
    });

    // Quality gate outcome counters (process-local).
    expect(dashboard.qualityGateOutcomes).toMatchObject({ pass: 2, replaced: 1, surgical_downgrade: 0 });

    // Routing accuracy from the accepted snapshot + corpus progress.
    expect(dashboard.routingAccuracy.snapshotGeneratedAt).toBe('2026-07-15T08:00:00.000Z');
    expect(dashboard.routingAccuracy.surfaces).toHaveLength(1);
    expect(dashboard.routingAccuracy.surfaces?.[0]).toMatchObject({
      surface: 'intent_resolver',
      covered: 10,
      accuracy: 0.9,
    });
    expect(dashboard.routingAccuracy.surfaces?.[0].perDomain).toEqual([
      { domain: 'secretary', support: 6, precision: 0.8571, recall: 1 },
      { domain: 'finance', support: 4, precision: 1, recall: 0.75 },
    ]);
    expect(dashboard.routingAccuracy.corpusProgress).toMatchObject({ total: 2, labeled: 1, pending: 1 });

    // Readiness rows from the provided report.
    expect(dashboard.readiness.available).toBe(true);
    const retirement = dashboard.readiness.rows?.find((row) => row.phase === 'legacyRetirement');
    expect(retirement).toMatchObject({ passed: false, blockedGateCount: 1 });

    // Sampler capture counts within the window only — and never raw text.
    expect(dashboard.samplerCaptures.windowDays).toBe(30);
    expect(dashboard.samplerCaptures.total).toBe(3);
    expect(dashboard.samplerCaptures.byStatus).toEqual({ sampled: 3 });
    expect(dashboard.samplerCaptures.byReason).toEqual([
      { status: 'sampled', reason: 'fallback', count: 2 },
      { status: 'sampled', reason: 'schema_failure', count: 1 },
    ]);
    expect(JSON.stringify(dashboard.samplerCaptures)).not.toContain('turn-');
    expect(JSON.stringify(dashboard.samplerCaptures)).not.toContain('labeled item');

    // Monthly spend groups by month; current month has no runs.
    expect(dashboard.monthlyEvalSpend.months).toEqual([
      { month: '2026-07', totalBudgetUsd: 1.5, runCount: 1 },
      { month: '2026-06', totalBudgetUsd: 0.25, runCount: 1 },
    ]);
    expect(dashboard.monthlyEvalSpend.currentMonthUsd).toBe(1.5);
  });

  it('prefers the newest real_provider run for locale leakage even when a fixture run is newer', () => {
    // Newer fixture run (clean) + older real_provider run (leaking): the
    // real_provider evidence must win so fixture runs cannot mask live
    // locale regressions.
    persistChatEvalRun(makeSuiteResult(), { db, runId: 'fixture-newest' });
    persistChatEvalRun(
      makeSuiteResult({
        generatedAt: '2026-07-10T10:00:00.000Z',
        mode: 'real_provider',
        scenarios: [
          {
            id: 'live-a',
            title: 'Live A',
            personaId: 'persona-1',
            status: 'fail',
            evidenceMode: 'real_provider',
            averageScore: 0.4,
            scores: { grounding: 1, response_language: 0 },
            failures: ['response_language: expected language es, detected en'],
            notes: [],
          },
        ],
      }),
      { db, runId: 'live-older', realProviderCalls: 5 },
    );

    const dashboard = buildChatQualityDashboard(db, { now: NOW });

    expect(dashboard.localeLeakage).toEqual({
      runId: 'live-older',
      mode: 'real_provider',
      scenarioCount: 1,
      leakedCount: 1,
      rate: 1,
    });
  });

  it('degrades gracefully on an empty database and missing readiness report', () => {
    const dashboard = buildChatQualityDashboard(db, { now: NOW });

    expect(dashboard.evalTrend).toEqual([]);
    expect(dashboard.failureTypeBreakdown).toEqual({ runsConsidered: 0, counts: {} });
    expect(dashboard.localeLeakage).toEqual({ runId: null, mode: null, scenarioCount: 0, leakedCount: 0, rate: null });
    expect(dashboard.routingAccuracy.snapshotGeneratedAt).toBeNull();
    expect(dashboard.routingAccuracy.surfaces).toBeNull();
    expect(dashboard.readiness).toMatchObject({ available: false, rows: null });
    expect(dashboard.samplerCaptures.total).toBe(0);
    expect(dashboard.monthlyEvalSpend).toEqual({ months: [], currentMonthUsd: 0 });
  });

  it('loads a readiness report artifact fail-soft', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-quality-'));
    try {
      const missing = loadChatV2ReadinessReportFromFile(path.join(dir, 'nope.json'));
      expect(missing.report).toBeNull();
      expect(missing.reason).toContain('not found');

      const badSchema = path.join(dir, 'bad.json');
      fs.writeFileSync(badSchema, JSON.stringify({ schemaVersion: 'other.v1' }));
      expect(loadChatV2ReadinessReportFromFile(badSchema).report).toBeNull();

      const invalid = path.join(dir, 'invalid.json');
      fs.writeFileSync(invalid, 'not json');
      expect(loadChatV2ReadinessReportFromFile(invalid).reason).toContain('not valid JSON');

      const good = path.join(dir, 'latest.json');
      fs.writeFileSync(good, JSON.stringify(makeReadinessReport()));
      const loaded = loadChatV2ReadinessReportFromFile(good);
      expect(loaded.reason).toBeNull();
      expect(loaded.report?.generatedAt).toBe('2026-07-19T09:00:00.000Z');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(DEFAULT_CHAT_V2_READINESS_REPORT_PATH).toBe('reports/chatv2-readiness/latest.json');
  });
});
