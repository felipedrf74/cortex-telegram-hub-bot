import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alertMocks = vi.hoisted(() => ({
  recordOperatorAlert: vi.fn(),
  recordParityFallbackWrapperSpy: vi.fn(),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: vi.fn(() => {
    throw new Error('tests must pass an explicit db');
  }),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/operator-alerts', async () => ({
  ...(await vi.importActual('../../src/services/operator-alerts')),
  recordOperatorAlert: (...args: unknown[]) => alertMocks.recordOperatorAlert(...args),
}));

// Spy-through on the exported regression wrapper: the digest must record
// regressions THROUGH recordChatV2ParityFallbackRegressionAlerts (single
// path, no dead export), so we observe the wrapper while keeping its real
// behavior (which itself lazily imports the mocked operator-alerts).
vi.mock('../../src/services/chatv2-readiness-alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/chatv2-readiness-alerts')>();
  return {
    ...actual,
    recordChatV2ParityFallbackRegressionAlerts: (...args: Parameters<typeof actual.recordChatV2ParityFallbackRegressionAlerts>) => {
      alertMocks.recordParityFallbackWrapperSpy(...args);
      return actual.recordChatV2ParityFallbackRegressionAlerts(...args);
    },
  };
});

// routing chain safety: any live provider call is an observable failure.
vi.mock('../../src/services/provider-registry', async () => ({
  ...(await vi.importActual('../../src/services/provider-registry')),
  getActiveProvider: vi.fn(() => {
    throw new Error('digest must not touch providers');
  }),
  getProvider: vi.fn(),
}));

vi.mock('../../src/services/anthropic', async () => ({
  ...(await vi.importActual('../../src/services/anthropic')),
  classifyMessage: vi.fn(() => {
    throw new Error('digest must not classify');
  }),
}));

import {
  acceptFrozenRealProviderBaseline,
  persistChatEvalRun,
  type ChatEvalRunCostAttestation,
} from '../../src/services/chat-eval-history';
import type { ChatEvaluationSuiteResult } from '../../src/services/chat-evaluation-harness';
import { resetChatQualityGateOutcomeCountersForTests } from '../../src/services/chat-hybrid-metrics';
import { recordChatRoutingClarifyDecisionPersisted } from '../../src/services/chat-routing-clarify-metrics';
import { ensureRoutingCorpusTables } from '../../src/services/routing-corpus';
import {
  ensureChatCoreV2OnlineEvalTables,
  recordChatV2OnlineEvalSample,
  CHAT_CORE_V2_ONLINE_EVAL_SAMPLER_VERSION,
} from '../../src/services/chat-core-v2/online-eval-sampler';
import {
  loadAgentJobManifest,
  assertAgentJobRuntimeRegistration,
} from '../../src/services/agent-job-manifest';
import type { ChatV2CompletionReadinessReportLike } from '../../src/services/chatv2-readiness-alerts';
import {
  buildChatQualityWeeklyDigest,
  buildChatQualityDigestAlertInput,
  runChatQualityWeeklyDigest,
} from '../../src/services/chat-quality-digest';

const NOW = new Date('2026-07-20T08:00:00.000Z');

function makeSuiteResult(generatedAt: string, overrides: Partial<Record<string, unknown>> = {}): ChatEvaluationSuiteResult {
  return {
    generatedAt,
    mode: 'fixture',
    passed: true,
    averageScore: 0.9,
    scenarioCount: 1,
    statusCounts: { pass: 1, partial: 0, fail: 0, blocked: 0 },
    qualityMetrics: [],
    dayToDay: {
      generatedAt,
      mode: 'fixture',
      passed: true,
      scenarios: [],
      averageScore: 0.9,
      failureSummary: {},
    },
    scenarios: [],
    ...overrides,
  } as unknown as ChatEvaluationSuiteResult;
}

function makeReadinessReport(): ChatV2CompletionReadinessReportLike {
  return {
    schemaVersion: 'chat_v2_completion_readiness_report.v1',
    generatedAt: '2026-07-19T09:00:00.000Z',
    shadow: {
      passed: false,
      gates: [
        // Non-parity blocked gate: digest material only, never an immediate alert.
        { gateId: 'shadow_sample_count', passed: false, sampleCount: 10, observed: 10, threshold: 50 },
      ],
    },
    legacyRetirement: {
      passed: false,
      gates: [
        { gateId: 'legacy_fallback_rate', passed: false, sampleCount: 40, observed: 0.2, threshold: 0.05 },
        { gateId: 'legacy_parity_match_rate', passed: false, sampleCount: 40, observed: 0.8, threshold: 0.98 },
      ],
    },
  };
}

function costEvidence(
  scenarioIds: string[],
  estimatedActualUsd: number,
  ceilingUsd: number,
): ChatEvalRunCostAttestation {
  const judgeEstimatedSpendUsd = ceilingUsd === 0.5 && scenarioIds.length > 0 ? 0.004 : 0;
  const judgeActualSpendUsd = judgeEstimatedSpendUsd / 2;
  const judgeReservedAttemptCeilingUsd = judgeEstimatedSpendUsd;
  const judgeCommittedCeilingUsd = judgeActualSpendUsd + judgeReservedAttemptCeilingUsd;
  const targetActualSpendUsd = estimatedActualUsd - judgeActualSpendUsd;
  const targetCommittedCeilingUsd = targetActualSpendUsd;
  return {
    contractVersion: 'chat-live-eval-v1',
    attested: true,
    reasons: [],
    totalCeilingUsd: ceilingUsd,
    targetCeilingUsd: ceilingUsd === 0.5 ? 0.45 : ceilingUsd,
    judgeCeilingUsd: ceilingUsd === 0.5 ? 0.05 : 0,
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
    totalActualSpendUsd: estimatedActualUsd,
    totalEstimatedActualSpendUsd: estimatedActualUsd,
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
    contractVersion: 'chat-live-eval-v1', mode: 'real_provider', runId,
    budget: { totalCeilingUsd: 0.5, targetCeilingUsd: 0.45, judgeCeilingUsd: 0.05 },
    targetBaseCategory: 'chat_live_eval_real', providerPolicy: 'metered_cloud_only',
    productionDataUsed: false, seedProfileVersion: 'single-tenant-live-v2',
    supportedScenarioIds: [...scenarioIds].sort(),
  };
}

function seedWeeks(db: Database.Database): void {
  // Current week (>= 2026-07-13T08:00Z): two runs.
  persistChatEvalRun(makeSuiteResult('2026-07-18T10:00:00.000Z', { averageScore: 0.9, passed: true }), {
    db, runId: 'cur-1', budgetUsd: 2,
    costAttestation: costEvidence([], 0.2, 2),
  });
  persistChatEvalRun(makeSuiteResult('2026-07-15T10:00:00.000Z', {
    averageScore: 0.7,
    passed: false,
    statusCounts: { pass: 0, partial: 0, fail: 1, blocked: 0 },
  }), { db, runId: 'cur-2', budgetUsd: 1, costAttestation: costEvidence([], 0.1, 1) });
  // Previous week: one run.
  persistChatEvalRun(makeSuiteResult('2026-07-08T10:00:00.000Z', { averageScore: 0.6, passed: false }), {
    db, runId: 'prev-1', budgetUsd: 0.5, costAttestation: costEvidence([], 0.05, 0.5),
  });
  // Ancient run outside both windows.
  persistChatEvalRun(makeSuiteResult('2026-05-01T10:00:00.000Z'), {
    db, runId: 'old-1', budgetUsd: 9, costAttestation: costEvidence([], 0.9, 9),
  });

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
  recordChatV2OnlineEvalSample({ ...base, turnId: 'c1', sampleId: 'c1', decision: decision('fallback'), createdAt: '2026-07-17T00:00:00.000Z' }, db);
  recordChatV2OnlineEvalSample({ ...base, turnId: 'c2', sampleId: 'c2', decision: decision('fallback'), createdAt: '2026-07-18T00:00:00.000Z' }, db);
  recordChatV2OnlineEvalSample({ ...base, turnId: 'c3', sampleId: 'c3', decision: decision('model_refusal'), createdAt: '2026-07-19T00:00:00.000Z' }, db);
  recordChatV2OnlineEvalSample({ ...base, turnId: 'p1', sampleId: 'p1', decision: decision('fallback'), createdAt: '2026-07-08T00:00:00.000Z' }, db);

  db.prepare(`
    INSERT INTO routing_corpus_items (tenant_id, user_id, utterance_hash, utterance_text, source, label_status, label_domain, labeled_at)
    VALUES (0, NULL, ?, 'this week', 'manual', 'labeled', 'secretary', '2026-07-16 09:00:00')
  `).run('a'.repeat(64));
  db.prepare(`
    INSERT INTO routing_corpus_items (tenant_id, user_id, utterance_hash, utterance_text, source, label_status, label_domain, labeled_at)
    VALUES (0, NULL, ?, 'previous week', 'manual', 'labeled', 'finance', '2026-07-09 09:00:00')
  `).run('b'.repeat(64));
  db.prepare(`
    INSERT INTO routing_corpus_items (tenant_id, user_id, utterance_hash, utterance_text, source, label_status)
    VALUES (0, NULL, ?, 'pending', 'manual', 'pending')
  `).run('c'.repeat(64));
}

describe('chat quality weekly digest', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureRoutingCorpusTables(db);
    ensureChatCoreV2OnlineEvalTables(db);
    resetChatQualityGateOutcomeCountersForTests();
    alertMocks.recordOperatorAlert.mockReset();
    alertMocks.recordParityFallbackWrapperSpy.mockReset();
    alertMocks.recordOperatorAlert.mockReturnValue({ ok: true, action: 'created' });
  });

  afterEach(() => {
    db.close();
    resetChatQualityGateOutcomeCountersForTests();
  });

  it('computes week-over-week deltas across eval, sampler, and corpus signals', () => {
    seedWeeks(db);
    for (let index = 0; index < 9; index += 1) {
      recordChatRoutingClarifyDecisionPersisted(db, false, NOW);
    }
    recordChatRoutingClarifyDecisionPersisted(db, true, NOW);
    const digest = buildChatQualityWeeklyDigest(db, { now: NOW, readinessReport: makeReadinessReport() });

    expect(digest.weekStart).toBe('2026-07-13T08:00:00.000Z');
    expect(digest.weekEnd).toBe('2026-07-20T08:00:00.000Z');

    expect(digest.eval.current).toEqual({
      runCount: 2,
      averageScore: 0.8,
      passRate: 0.5,
      estimatedActualSpendUsd: 0.3,
      budgetCeilingUsd: 3,
      actualSpendEvidenceRunCount: 2,
      byMode: {
        realProvider: {
          runCount: 0, averageScore: null, passRate: null,
          estimatedActualSpendUsd: 0, budgetCeilingUsd: 0, actualSpendEvidenceRunCount: 0,
        },
        other: {
          runCount: 2, averageScore: 0.8, passRate: 0.5,
          estimatedActualSpendUsd: 0.3, budgetCeilingUsd: 3, actualSpendEvidenceRunCount: 2,
        },
      },
    });
    expect(digest.eval.previous).toEqual({
      runCount: 1,
      averageScore: 0.6,
      passRate: 0,
      estimatedActualSpendUsd: 0.05,
      budgetCeilingUsd: 0.5,
      actualSpendEvidenceRunCount: 1,
      byMode: {
        realProvider: {
          runCount: 0, averageScore: null, passRate: null,
          estimatedActualSpendUsd: 0, budgetCeilingUsd: 0, actualSpendEvidenceRunCount: 0,
        },
        other: {
          runCount: 1, averageScore: 0.6, passRate: 0,
          estimatedActualSpendUsd: 0.05, budgetCeilingUsd: 0.5, actualSpendEvidenceRunCount: 1,
        },
      },
    });
    expect(digest.eval.deltas).toEqual({
      averageScore: 0.2,
      passRate: 0.5,
      estimatedActualSpendUsd: 0.25,
      budgetCeilingUsd: 2.5,
    });

    expect(digest.sampler.current).toEqual({ sampledCount: 3, byReason: { fallback: 2, model_refusal: 1 } });
    expect(digest.sampler.previous).toEqual({ sampledCount: 1, byReason: { fallback: 1 } });
    expect(digest.sampler.delta).toBe(2);

    expect(digest.corpus).toEqual({
      labeledThisWeek: 1,
      labeledPreviousWeek: 1,
      totalLabeled: 2,
      totalPending: 1,
    });

    expect(digest.readiness).toEqual({
      available: true,
      reason: null,
      blockedGateCount: 3,
      parityFallbackRegressionCount: 2,
    });
    expect(digest.routingClarifyBudget).toEqual({
      windowDays: 7,
      evaluatedTurns: 10,
      clarifiedTurns: 1,
      rate: 0.1,
      budgetLimit: 0.1,
      withinBudget: true,
    });

    expect(digest.text).toContain('Evals: 2 run(s)');
    expect(digest.text).toContain('estimated actual spend $0.3');
    expect(digest.text).toContain('budget ceiling $3');
    expect(digest.text).toContain('vs prev week');
    expect(digest.text).toContain('Sampler: 3 capture(s)');
    expect(digest.text).toContain('Clarify budget: 1 / 10 turns (rate 0.1, limit 0.1, within budget).');
    expect(digest.text).toContain('2 parity/fallback regression(s)');
  });

  it('splits eval quality by real_provider vs other mode so fixture runs cannot mask live regressions', () => {
    // Live real_provider regression (0.4, failed) alongside a healthy
    // fixture run (0.95) in the same week: the aggregate looks mediocre,
    // the byMode split makes the live regression explicit.
    persistChatEvalRun(makeSuiteResult('2026-07-18T10:00:00.000Z', {
      mode: 'real_provider',
      averageScore: 0.4,
      passed: false,
      statusCounts: { pass: 0, partial: 0, fail: 1, blocked: 0 },
    }), {
      db, runId: 'live-1', budgetUsd: 4, realProviderCalls: 12,
      costAttestation: costEvidence([], 0.4, 4),
    });
    persistChatEvalRun(makeSuiteResult('2026-07-17T10:00:00.000Z', {
      averageScore: 0.95,
      passed: true,
    }), { db, runId: 'fixture-1', budgetUsd: 0, costAttestation: costEvidence([], 0, 0) });

    const digest = buildChatQualityWeeklyDigest(db, { now: NOW });

    expect(digest.eval.current.byMode.realProvider).toEqual({
      runCount: 1, averageScore: 0.4, passRate: 0,
      estimatedActualSpendUsd: 0.4, budgetCeilingUsd: 4, actualSpendEvidenceRunCount: 1,
    });
    expect(digest.eval.current.byMode.other).toEqual({
      runCount: 1, averageScore: 0.95, passRate: 1,
      estimatedActualSpendUsd: 0, budgetCeilingUsd: 0, actualSpendEvidenceRunCount: 1,
    });
    expect(digest.eval.current).toMatchObject({
      runCount: 2, averageScore: 0.675, passRate: 0.5,
      estimatedActualSpendUsd: 0.4, budgetCeilingUsd: 4, actualSpendEvidenceRunCount: 2,
    });
    expect(digest.text).toContain('real_provider');
  });

  it('handles an empty week without deltas or divide-by-zero', () => {
    const digest = buildChatQualityWeeklyDigest(db, { now: NOW });

    expect(digest.eval.current).toEqual({
      runCount: 0,
      averageScore: null,
      passRate: null,
      estimatedActualSpendUsd: 0,
      budgetCeilingUsd: 0,
      actualSpendEvidenceRunCount: 0,
      byMode: {
        realProvider: {
          runCount: 0, averageScore: null, passRate: null,
          estimatedActualSpendUsd: 0, budgetCeilingUsd: 0, actualSpendEvidenceRunCount: 0,
        },
        other: {
          runCount: 0, averageScore: null, passRate: null,
          estimatedActualSpendUsd: 0, budgetCeilingUsd: 0, actualSpendEvidenceRunCount: 0,
        },
      },
    });
    expect(digest.eval.deltas).toEqual({
      averageScore: null,
      passRate: null,
      estimatedActualSpendUsd: null,
      budgetCeilingUsd: null,
    });
    expect(digest.sampler.delta).toBeNull();
    expect(digest.corpus.labeledThisWeek).toBe(0);
    expect(digest.readiness.available).toBe(false);
    expect(digest.text).toContain('Evals: no runs recorded this week.');
    expect(digest.frozenLiveBaseline.status).toBe('not_recorded');
    expect(digest.text).toContain('Frozen live baseline: not recorded; quality deltas unavailable.');
    expect(digest.text).toContain('Sampler: no captures this week.');
    expect(digest.text).toContain('Readiness: unavailable');
  });

  it('includes comparable future deltas against the immutable live baseline', () => {
    const baselineId = 'chat-eval-digest-baseline';
    const scenarios = [{
      id: 'morning_planning',
      title: 'Morning planning',
      personaId: 'dedicated-eval',
      status: 'pass',
      evidenceMode: 'custom_live_v1',
      averageScore: 0.7,
      scores: {
        correctness: 1,
        wording_quality: 2,
        groundedness: 2,
        sufficiency: 2,
        explanation_quality: 2,
      },
      failures: [],
      notes: [],
    }];
    const baseline = makeSuiteResult('2026-07-14T10:00:00.000Z', {
      mode: 'real_provider', averageScore: 0.7, scenarioCount: 1, scenarios,
    });
    const scenarioIds = baseline.scenarios.map((scenario) => scenario.id);
    persistChatEvalRun(baseline, {
      db, runId: baselineId, gitCommit: 'a'.repeat(40), budgetUsd: 0.5,
      realProviderCalls: 1, costAttestation: costEvidence(scenarioIds, 0.01, 0.5),
      preflightAttestation: preflight(baselineId, scenarioIds),
    });
    acceptFrozenRealProviderBaseline(db, {
      runId: baselineId,
      evidenceJsonPath: `docs/release/eval-evidence/${baselineId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${baselineId}.md`,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    });
    const followupId = 'chat-eval-digest-followup';
    const followup = makeSuiteResult('2026-07-18T10:00:00.000Z', {
      mode: 'real_provider', averageScore: 0.9, scenarioCount: 1,
      scenarios: [{ ...scenarios[0], averageScore: 0.9 }],
    });
    persistChatEvalRun(followup, {
      db, runId: followupId, gitCommit: 'b'.repeat(40), budgetUsd: 0.5,
      realProviderCalls: 1, costAttestation: costEvidence(scenarioIds, 0.015, 0.5),
      preflightAttestation: preflight(followupId, scenarioIds),
    });

    const digest = buildChatQualityWeeklyDigest(db, { now: NOW });
    expect(digest.frozenLiveBaseline).toMatchObject({
      status: 'comparable',
      baseline: { runId: baselineId },
      latestFollowup: { runId: followupId },
      comparison: { averageScoreDelta: 0.2, estimatedActualSpendUsdDelta: 0.005 },
    });
    expect(digest.text).toContain(`Frozen live baseline: ${baselineId}`);
    expect(digest.text).toContain(`latest ${followupId}`);
    expect(digest.text).toContain('score delta +0.2');
  });

  it('routes the digest as one weekly info alert and regressions as their own alerts', async () => {
    seedWeeks(db);
    const result = await runChatQualityWeeklyDigest({
      db,
      now: NOW,
      readinessReport: makeReadinessReport(),
    });

    expect(result.digestRecorded).toBe(true);
    expect(result.regressionAlertCount).toBe(2);

    // M22: regressions must be recorded THROUGH the exported wrapper —
    // single path, no dead export.
    expect(alertMocks.recordParityFallbackWrapperSpy).toHaveBeenCalledTimes(1);
    expect(alertMocks.recordParityFallbackWrapperSpy).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: 'chat_v2_completion_readiness_report.v1' }),
    );

    const calls = alertMocks.recordOperatorAlert.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(3);

    const digestAlert = calls[0];
    expect(digestAlert).toMatchObject({
      severity: 'info',
      source: 'chat_quality_digest',
      dedupeKey: 'chat-quality-digest:2026-07-20',
      runbookUrl: 'docs/release/chat-quality-operations.md',
    });
    expect(digestAlert.detail).toContain('Chat quality digest');
    // Operator-alert sanitization flattens whitespace, so the detail must be
    // single-line-safe (' | '-separated) with the full sections in metadata.
    expect(digestAlert.detail).not.toContain('\n');
    expect(digestAlert.detail).toContain(' | ');

    // Parity/fallback regressions keep their own (non-info) severity and
    // dedupe keys; the non-parity shadow gate is NOT alerted immediately.
    const regressionAlerts = calls.slice(1);
    expect(regressionAlerts.map((alert) => alert.dedupeKey).sort()).toEqual([
      'chatv2-readiness:legacyRetirement:legacy_fallback_rate',
      'chatv2-readiness:legacyRetirement:legacy_parity_match_rate',
    ]);
    expect(regressionAlerts.find((alert) => alert.dedupeKey.endsWith('legacy_fallback_rate'))?.severity).toBe('critical');
    expect(regressionAlerts.find((alert) => alert.dedupeKey.endsWith('legacy_parity_match_rate'))?.severity).toBe('warning');
    expect(calls.some((alert) => alert.dedupeKey.includes('shadow_sample_count'))).toBe(false);
  });

  it('records only the digest alert when no readiness report is available', async () => {
    const result = await runChatQualityWeeklyDigest({ db, now: NOW, readinessReport: null });

    expect(result.digestRecorded).toBe(true);
    expect(result.regressionAlertCount).toBe(0);
    expect(alertMocks.recordParityFallbackWrapperSpy).not.toHaveBeenCalled();
    expect(alertMocks.recordOperatorAlert).toHaveBeenCalledTimes(1);
    expect(alertMocks.recordOperatorAlert.mock.calls[0][0]).toMatchObject({ severity: 'info' });
    expect(result.digest.readiness.available).toBe(false);
  });

  it('builds a stable digest alert payload', () => {
    seedWeeks(db);
    const digest = buildChatQualityWeeklyDigest(db, { now: NOW });
    const input = buildChatQualityDigestAlertInput(digest);
    expect(input).toMatchObject({
      severity: 'info',
      source: 'chat_quality_digest',
      dedupeKey: 'chat-quality-digest:2026-07-20',
      owner: 'ai-quality',
      suspectedArea: 'chat_quality',
    });
    expect(input.metadata).toMatchObject({
      evalRunCount: 2,
      sampledCount: 3,
      labeledThisWeek: 1,
    });
    // Compact single-line detail; full structured sections ride in metadata
    // (array-of-strings, matching sibling metadata usage like evidenceSources).
    expect(input.detail).toBe(digest.text.split('\n').join(' | '));
    expect(input.metadata?.sections).toEqual(digest.text.split('\n'));
    for (const section of input.metadata?.sections as string[]) {
      expect(section.length).toBeLessThanOrEqual(300);
    }
  });

  it('is registered in the scheduler with a governed AgentJobManifest identity', () => {
    const manifest = loadAgentJobManifest();
    const entry = manifest.jobs.find((job) => job.id === 'chat_quality_weekly_digest');
    expect(entry).toMatchObject({
      name: 'Chat Quality Weekly Digest',
      schedule: '30 7 * * 1',
      domain: 'system',
      providerUsage: 'none',
    });
    expect(() => assertAgentJobRuntimeRegistration({
      id: 'chat_quality_weekly_digest',
      name: 'Chat Quality Weekly Digest',
      runtimeSchedule: '30 7 * * 1',
      declaredSchedule: '30 7 * * 1',
      domain: 'system',
    })).not.toThrow();
  });
});
