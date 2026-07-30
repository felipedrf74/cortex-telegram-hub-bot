import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: vi.fn(() => {
    throw new Error('tests must pass an explicit db');
  }),
  withDatabaseForTestAsync: vi.fn(),
}));

// The dashboard must never touch a live provider; routing-accuracy's import
// chain includes provider-backed modules, so make any live call observable.
vi.mock('../../src/services/provider-registry', async () => ({
  ...(await vi.importActual('../../src/services/provider-registry')),
  getActiveProvider: vi.fn(() => {
    throw new Error('dashboard must not touch providers');
  }),
  getProvider: vi.fn(),
}));

vi.mock('../../src/services/anthropic', async () => ({
  ...(await vi.importActual('../../src/services/anthropic')),
  classifyMessage: vi.fn(() => {
    throw new Error('dashboard must not classify');
  }),
}));

import {
  acceptFrozenRealProviderBaseline,
  persistChatEvalRun,
  type ChatEvalRunCostAttestation,
} from '../../src/services/chat-eval-history';
import type { ChatEvaluationSuiteResult } from '../../src/services/chat-evaluation-harness';
import {
  recordChatQualityGateOutcome,
  resetChatQualityGateOutcomeCountersForTests,
} from '../../src/services/chat-hybrid-metrics';
import { CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING } from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
} from '../../src/services/chat-v2-completion-evidence';
import { recordChatRoutingClarifyDecisionPersisted } from '../../src/services/chat-routing-clarify-metrics';
import { ensureRoutingCorpusTables } from '../../src/services/routing-corpus';
import type { RoutingAccuracyReport } from '../../src/services/routing-accuracy';
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
      scenarios: [{
        scenarioId: 'locale-observation',
        title: 'Locale observation',
        personaId: 'persona-1',
        passed: false,
        averageScore: 1,
        turns: [
          {
            turnId: 'locale-ok',
            expectedLanguage: 'en',
            executionStatus: 'executed',
            scorerDimensions: [{ dimension: 'response_language', passed: true, score: 2, detail: 'response language en' }],
            failures: [],
          },
          {
            turnId: 'locale-leak',
            expectedLanguage: 'es',
            executionStatus: 'executed',
            scorerDimensions: [{ dimension: 'response_language', passed: false, score: 0, detail: 'expected language es, detected pt' }],
            failures: [],
          },
        ],
      }],
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
        scores: {
          grounding: 1,
          response_language: 1,
          wording_quality: 2,
          groundedness: 2,
          sufficiency: 2,
          explanation_quality: 2,
        },
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
        scores: {
          grounding: 1,
          response_language: 0,
          wording_quality: 1,
          groundedness: 1,
          sufficiency: 1,
          explanation_quality: 1,
        },
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
  const passingPhase = () => ({ passed: true, gates: [] });
  return {
    schemaVersion: 'chat_v2_completion_readiness_report.v1',
    generatedAt: '2026-07-19T09:00:00.000Z',
    evidenceSources: ['runtime_route'],
    evidenceContract: {
      retirementObserverCorpusBinding: CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
      responseLocaleEvidenceVersion: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
    },
    shadow: { passed: true, gates: [{ gateId: 'shadow_sample_count', passed: true, sampleCount: 100, observed: 100, threshold: 50 }] },
    answerCanary: passingPhase(),
    deterministicRead: passingPhase(),
    writePreview: passingPhase(),
    confirmedWrites: passingPhase(),
    cloudAllowlist: passingPhase(),
    legacyRetirement: {
      passed: false,
      gates: [
        { gateId: 'legacy_fallback_rate', passed: false, sampleCount: 40, observed: 0.2, threshold: 0.05, reasonCode: 'fallback_regression' },
      ],
    },
  };
}

function costEvidence(
  scenarioIds: string[],
  totalEstimatedActualSpendUsd: number,
  totalCeilingUsd: number,
): ChatEvalRunCostAttestation {
  const judgeEstimatedSpendUsd = totalCeilingUsd === 0.5 && scenarioIds.length > 0 ? 0.004 : 0;
  const judgeActualSpendUsd = judgeEstimatedSpendUsd / 2;
  const judgeReservedAttemptCeilingUsd = judgeEstimatedSpendUsd;
  const judgeCommittedCeilingUsd = judgeActualSpendUsd + judgeReservedAttemptCeilingUsd;
  const targetActualSpendUsd = totalEstimatedActualSpendUsd - judgeActualSpendUsd;
  const targetCommittedCeilingUsd = targetActualSpendUsd;
  return {
    contractVersion: 'chat-live-eval-v1',
    attested: true,
    reasons: [],
    totalCeilingUsd,
    targetCeilingUsd: totalCeilingUsd === 0.5 ? 0.45 : totalCeilingUsd,
    judgeCeilingUsd: totalCeilingUsd === 0.5 ? 0.05 : 0,
    targetActualSpendUsd,
    targetReservedAttemptCeilingUsd: 0,
    targetCommittedCeilingUsd,
    judgeEstimatedSpendUsd,
    judgeActualSpendUsd,
    judgeReservedAttemptCeilingUsd,
    judgeCommittedCeilingUsd,
    judgeUsageCallCount: judgeEstimatedSpendUsd > 0 ? scenarioIds.length : 0,
    judgeProviderAttemptCount: judgeEstimatedSpendUsd > 0 ? scenarioIds.length : 0,
    judgeProviders: judgeEstimatedSpendUsd > 0 ? ['gemini'] : [],
    judgeModels: judgeEstimatedSpendUsd > 0 ? ['gemini-2.5-flash-lite'] : [],
    judgeUnresolvedPricingCount: 0,
    judgeUsageDatabaseSha256: judgeEstimatedSpendUsd > 0 ? 'b'.repeat(64) : null,
    totalActualSpendUsd: totalEstimatedActualSpendUsd,
    totalEstimatedActualSpendUsd,
    totalConservativeCommitmentUsd: targetCommittedCeilingUsd + judgeCommittedCeilingUsd,
    targetUsageCallCount: 1,
    targetProviderAttemptCount: 1,
    targetProviders: ['gemini'],
    unresolvedPricingCount: 0,
    preparation: {
      scenarioCount: scenarioIds.length,
      scenarioIds: [...scenarioIds].sort(),
      seedProfileVersions: ['single-tenant-live-v2'],
      seedProfileHashes: ['a'.repeat(64)],
      aggregateResetCounts: {},
    },
  };
}

function preflight(runId: string, scenarioIds: string[]): Record<string, unknown> {
  return {
    contractVersion: 'chat-live-eval-v1',
    mode: 'real_provider',
    runId,
    budget: { totalCeilingUsd: 0.5, targetCeilingUsd: 0.45, judgeCeilingUsd: 0.05 },
    targetBaseCategory: 'chat_live_eval_real',
    providerPolicy: 'metered_cloud_only',
    productionDataUsed: false,
    seedProfileVersion: 'single-tenant-live-v2',
    supportedScenarioIds: [...scenarioIds].sort(),
  };
}

describe('chat quality dashboard', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/160_chatv2_legacy_retirement_evidence.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/179_chat_v2_fallback_attribution_counter.sql'), 'utf8'));
    ensureRoutingCorpusTables(db);
    ensureChatCoreV2OnlineEvalTables(db);
    resetChatQualityGateOutcomeCountersForTests();
  });

  afterEach(() => {
    db.close();
    resetChatQualityGateOutcomeCountersForTests();
  });

  function seedEvalRuns(): void {
    persistChatEvalRun(makeSuiteResult(), {
      db,
      runId: 'run-recent',
      budgetUsd: 1.5,
      realProviderCalls: 3,
      costAttestation: costEvidence(['scenario-a', 'scenario-b'], 0.12, 1.5),
    });
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
      {
        db,
        runId: 'run-older',
        budgetUsd: 0.25,
        costAttestation: costEvidence(['scenario-a', 'scenario-b'], 0.02, 0.25),
      },
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
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES (?, 1)
    `).run(JSON.stringify(makeAccuracySnapshot()));
    recordChatQualityGateOutcome('pass');
    recordChatQualityGateOutcome('pass');
    recordChatQualityGateOutcome('replaced');
    for (let index = 0; index < 9; index += 1) {
      recordChatRoutingClarifyDecisionPersisted(db, false, NOW);
    }
    recordChatRoutingClarifyDecisionPersisted(db, true, NOW);
    db.prepare(`
      INSERT INTO chat_v2_legacy_retirement_evidence (
        evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
        route_id, replaced, tested, shadow_parity_rate, route_sample_count,
        raw_field_audit_count, safe_metadata_json, created_at
      ) VALUES ('runtime_route', 'route_exit', 'dashboard-training', ?, 'hmac',
        'training_plan_shortcut', 1, 1, 0.96, 50, 0, ?, ?)
    `).run(
      `hmac:test:${'e'.repeat(64)}`,
      JSON.stringify({
        schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
        parityLabelImport: true,
        evaluator: 'manual',
        peerReviewSignoffHash: 'f'.repeat(64),
        sampleCount: 50,
        matchingCount: 48,
        safetyRegressionCount: 0,
        qualityRegressionCount: 0,
        degradedNotComparableCount: 0,
        reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
        parityRate: 0.96,
        reviewCompletenessChecked: true,
        rawReviewArtifactCompletenessChecked: true,
        observedRouteSampleCount: 50,
        observerManifestSha256: '1'.repeat(64),
        observerObservationsSha256: '2'.repeat(64),
        rawReviewArtifactSha256: '3'.repeat(64),
        ...CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
      }),
      NOW.toISOString(),
    );
    db.prepare(`
      INSERT INTO chat_v2_legacy_fallback_attribution_counter (
        tenant_id, window_start, domain, route_owner, route_method,
        fallback_count, total_count, updated_at
      ) VALUES ('tenant-a', '2026-07-20T11', 'training',
        'training_plan_shortcut', 'training-plan-shortcut', 2, 100, ?)
    `).run(NOW.toISOString());

    const dashboard = buildChatQualityDashboard(db, {
      now: NOW,
      readinessReport: makeReadinessReport(),
    });

    // Eval trend: actual estimated spend and budget ceilings remain distinct.
    expect(dashboard.evalTrend.map((run) => run.runId)).toEqual(['run-recent', 'run-older']);
    expect(dashboard.evalTrend[0]).toMatchObject({
      mode: 'fixture',
      passed: true,
      averageScore: 0.9,
      estimatedActualSpendUsd: 0.12,
      budgetCeilingUsd: 1.5,
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
      unknownCount: 0,
      rate: 0.5,
    });

    // Quality gate outcome counters (process-local).
    expect(dashboard.qualityGateOutcomes).toMatchObject({ pass: 2, replaced: 1, surgical_downgrade: 0 });
    expect(dashboard.routingClarifyBudget).toEqual({
      windowDays: 30,
      evaluatedTurns: 10,
      clarifiedTurns: 1,
      rate: 0.1,
      budgetLimit: 0.1,
      withinBudget: true,
    });

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

    // Per-route campaign uses paired behavior evidence and shows the exact
    // owner-gated disable stage plus trailing-24h fallback.
    expect(dashboard.retirementCampaign).toMatchObject({
      fallbackWindowHours: 24,
      fallbackThreshold: 0.02,
      candidateRouteCount: 1,
      alertRouteCount: 0,
    });
    expect(dashboard.retirementCampaign.rows.find((row) => row.routeId === 'training_plan_shortcut'))
      .toMatchObject({
        disableStages: ['training_plan_shortcut'],
        behaviorParitySamples: 50,
        behaviorParityRate: 0.96,
        fallback24h: { rate: 0.02, passed: true },
        verdict: 'pass',
      });

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

    // Monthly estimated actual spend never relabels the budget ceiling.
    expect(dashboard.monthlyEvalSpend.months).toEqual([
      {
        month: '2026-07', totalEstimatedActualSpendUsd: 0.12,
        totalBudgetCeilingUsd: 1.5, actualSpendEvidenceRunCount: 1, runCount: 1,
      },
      {
        month: '2026-06', totalEstimatedActualSpendUsd: 0.02,
        totalBudgetCeilingUsd: 0.25, actualSpendEvidenceRunCount: 1, runCount: 1,
      },
    ]);
    expect(dashboard.monthlyEvalSpend.currentMonthEstimatedActualSpendUsd).toBe(0.12);
    expect(dashboard.monthlyEvalSpend.currentMonthBudgetCeilingUsd).toBe(1.5);
    expect(dashboard.frozenLiveBaseline.status).toBe('not_recorded');
  });

  it('surfaces the immutable live baseline and only emits deltas for a compatible future run', () => {
    const baselineId = 'chat-eval-dashboard-baseline';
    const baselineResult = makeSuiteResult({ mode: 'real_provider', averageScore: 0.8 });
    persistChatEvalRun(baselineResult, {
      db,
      runId: baselineId,
      gitBranch: 'main',
      gitCommit: 'a'.repeat(40),
      budgetUsd: 0.5,
      realProviderCalls: 2,
      costAttestation: costEvidence(['scenario-a', 'scenario-b'], 0.016, 0.5),
      preflightAttestation: preflight(baselineId, ['scenario-a', 'scenario-b']),
    });
    acceptFrozenRealProviderBaseline(db, {
      runId: baselineId,
      evidenceJsonPath: `docs/release/eval-evidence/${baselineId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${baselineId}.md`,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    });

    const followupId = 'chat-eval-dashboard-followup';
    const followupResult = makeSuiteResult({
      generatedAt: '2026-07-19T10:00:00.000Z',
      mode: 'real_provider',
      averageScore: 0.9,
    });
    persistChatEvalRun(followupResult, {
      db,
      runId: followupId,
      gitBranch: 'main',
      gitCommit: 'b'.repeat(40),
      budgetUsd: 0.5,
      realProviderCalls: 2,
      costAttestation: costEvidence(['scenario-a', 'scenario-b'], 0.02, 0.5),
      preflightAttestation: preflight(followupId, ['scenario-a', 'scenario-b']),
    });

    const dashboard = buildChatQualityDashboard(db, { now: NOW });
    expect(dashboard.frozenLiveBaseline).toMatchObject({
      status: 'comparable',
      baseline: { runId: baselineId, averageScore: 0.8 },
      latestFollowup: { runId: followupId, averageScore: 0.9 },
      comparison: {
        comparable: true,
        averageScoreDelta: 0.1,
        estimatedActualSpendUsdDelta: 0.004,
      },
    });
  });

  it('prefers real_provider locale evidence even when newer fixture runs exceed the dashboard query limit', () => {
    // Enough newer fixture runs to evict the live run from both the trend and
    // failure windows. Locale truth must come from its own mode-filtered read.
    persistChatEvalRun(makeSuiteResult(), { db, runId: 'fixture-newest' });
    persistChatEvalRun(
      makeSuiteResult({
        generatedAt: '2026-07-10T10:00:00.000Z',
        mode: 'real_provider',
        dayToDay: {
          generatedAt: '2026-07-10T10:00:00.000Z',
          mode: 'real_provider',
          passed: false,
          scenarios: [{
            scenarioId: 'live-a',
            title: 'Live A',
            personaId: 'persona-1',
            passed: false,
            averageScore: 0,
            turns: [{
              turnId: 'live-a-1',
              expectedLanguage: 'es',
              executionStatus: 'executed',
              scorerDimensions: [{ dimension: 'response_language', passed: false, score: 0, detail: 'expected language es, detected en' }],
              failures: [],
            }],
          }],
          averageScore: 0,
          failureSummary: {},
        },
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
    for (let index = 0; index < 25; index += 1) {
      persistChatEvalRun(makeSuiteResult(), { db, runId: `fixture-after-live-${index}` });
    }

    const dashboard = buildChatQualityDashboard(db, {
      now: NOW,
      evalTrendLimit: 5,
      failureRunLimit: 5,
    });

    expect(dashboard.localeLeakage).toEqual({
      runId: 'live-older',
      mode: 'real_provider',
      scenarioCount: 1,
      leakedCount: 1,
      unknownCount: 0,
      rate: 1,
    });
  });

  it('degrades gracefully on an empty database and missing readiness report', () => {
    const dashboard = buildChatQualityDashboard(db, { now: NOW });

    expect(dashboard.evalTrend).toEqual([]);
    expect(dashboard.failureTypeBreakdown).toEqual({ runsConsidered: 0, counts: {} });
    expect(dashboard.localeLeakage).toEqual({ runId: null, mode: null, scenarioCount: 0, leakedCount: 0, unknownCount: 0, rate: null });
    expect(dashboard.routingAccuracy.snapshotGeneratedAt).toBeNull();
    expect(dashboard.routingAccuracy.surfaces).toBeNull();
    expect(dashboard.readiness).toMatchObject({ available: false, rows: null });
    expect(dashboard.samplerCaptures.total).toBe(0);
    expect(dashboard.monthlyEvalSpend).toEqual({
      months: [],
      currentMonthEstimatedActualSpendUsd: 0,
      currentMonthBudgetCeilingUsd: 0,
    });
    expect(dashboard.frozenLiveBaseline).toEqual({
      status: 'not_recorded', baseline: null, latestFollowup: null, comparison: null,
    });
    expect(dashboard.routingClarifyBudget).toEqual({
      windowDays: 30,
      evaluatedTurns: 0,
      clarifiedTurns: 0,
      rate: null,
      budgetLimit: 0.1,
      withinBudget: null,
    });
    expect(dashboard.retirementCampaign.candidateRouteCount).toBe(0);
    expect(dashboard.retirementCampaign.rows).toHaveLength(9);
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

      const malformed = path.join(dir, 'malformed.json');
      fs.writeFileSync(malformed, JSON.stringify({
        ...makeReadinessReport(),
        legacyRetirement: { passed: false, gates: { corrupt: true } },
      }));
      const malformedResult = loadChatV2ReadinessReportFromFile(malformed);
      expect(malformedResult.report).toBeNull();
      expect(malformedResult.reason).toContain('gates array');

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
