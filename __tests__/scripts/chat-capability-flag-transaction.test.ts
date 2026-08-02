import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const OPERATOR = path.join(ROOT, 'scripts/chat-capability-flag-operator.sh');
const REMOTE = path.join(ROOT, 'scripts/remote-chat-capability-flag-transaction.sh');
const HELPER = path.join(ROOT, 'scripts/lib/chat-capability-flag-transaction.mjs');

const PLAN_SCHEMA = 'nexus.chat-capability-flag-plan.v1';
const EVIDENCE_SCHEMA = 'nexus.chat-capability-flag-evidence.v1';
const RECEIPT_SCHEMA = 'nexus.chat-capability-flag-transaction.v1';
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const EVIDENCE_SHA256 = 'c'.repeat(64);
const GENERATED_AT = '2026-08-02T01:02:03.000Z';
const TRANSACTION_ID = '20260802T010203Z-abcdef123456';
const SECRET_SENTINEL = 'do-not-print-this-private-value';

const CAPABILITY_FLAGS = [
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
] as const;
const MASTER_KILL = 'AI_ROUTING_MANIFEST_KILL';
const GOVERNED_FLAGS = [...CAPABILITY_FLAGS, MASTER_KILL] as const;

type FlagState = Record<(typeof GOVERNED_FLAGS)[number], boolean>;

function allOff(): FlagState {
  return Object.fromEntries(GOVERNED_FLAGS.map((flag) => [flag, false])) as FlagState;
}

function enabledPrefix(length: number): FlagState {
  const state = allOff();
  for (const flag of CAPABILITY_FLAGS.slice(0, length)) state[flag] = true;
  return state;
}

function routingEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: EVIDENCE_SCHEMA,
    kind: 'routing_divergence',
    status: 'passed',
    environment: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
    collectedWithTargetEnabled: false,
    evidenceSha256: EVIDENCE_SHA256,
    generatedAt: GENERATED_AT,
    selectedSurface: 'classifierKeyword',
    comparisonCount: 200,
    minimumComparisons: 200,
    agreementRate: 0.99,
    ...overrides,
  };
}

function rawRoutingGate(): string {
  return `${JSON.stringify({
    generatedAt: GENERATED_AT,
    evidence: {
      window: {
        sinceInclusive: '2026-08-01T00:00:00.000Z',
        throughInclusive: '2026-08-01T23:59:59.999Z',
        untilInclusive: '2026-08-01T23:59:59.999Z',
        upperBoundSource: 'until_flag',
      },
      identity: {
        enforced: true,
        releaseIdentity: {
          runtimeSha: RUNTIME_SHA,
          artifactDigest: ARTIFACT_DIGEST,
          role: 'staging',
        },
      },
      capabilityFlagBinding: {
        enforced: true,
        selectedSurface: 'classifierKeyword',
        selectedSurfaceFlag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        counts: {
          unknownFlagStateBundles: 0,
          selectedSurfaceFlagOnBundles: 0,
          masterKillEngagedBundles: 0,
          flagEligibleBundles: 200,
        },
        observedStates: [{
          state: 'classifierKeyword=off,orchestratorPrimary=off,registrySubset=off,shadowRoute=off,masterKill=off',
          bundles: 200,
        }],
      },
    },
    surfaceTotals: {
      classifierKeyword: { compared: 200, agreed: 198, agreementRate: 0.99 },
    },
    gate: {
      enabled: true,
      selectedSurface: 'classifierKeyword',
      capabilityFlag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      minimumComparisons: 200,
      minimumAgreementRate: 0.99,
      passed: true,
      failures: [],
    },
  }, null, 2)}\n`;
}

function detailedHealth(
  configured: FlagState,
  timestamp = '2026-08-02T01:02:08.750Z',
  monitorLastRunAt = timestamp,
  monitorLastResult = 'success',
): string {
  const databaseCheckedAt = new Date(Date.parse(timestamp) - 250).toISOString();
  return JSON.stringify({
    status: 'healthy',
    uptime: 600,
    database: 'connected',
    databaseProbe: {
      status: 'connected',
      checkedAt: databaseCheckedAt,
      latencyMs: 2,
    },
    releaseAttestation: {
      schema: 'nexus.chat-capability-release-attestation.v1',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      role: 'staging',
      processId: 4102,
      classifierPromptRuntimeForceDisabled: false,
      shadowPlannerEffective: {
        global: false,
        user1000014: false,
        tenant1000014: false,
        user1000016: false,
        tenant1000016: false,
      },
      capabilityFlags: {
        configured: Object.fromEntries(CAPABILITY_FLAGS.map((flag) => [flag, configured[flag]])),
        effective: Object.fromEntries(CAPABILITY_FLAGS.map((flag) => [flag, configured[flag]])),
        masterKill: configured[MASTER_KILL],
      },
    },
    jobs: [{
      name: 'chat_quality_regression_monitor',
      lastRunAt: monitorLastRunAt,
      lastResult: monitorLastResult,
      lastDurationMs: 25,
      lastError: null,
    }],
    timestamp,
  });
}

function clarifyDashboard(
  evaluatedTurns: number,
  clarifiedTurns: number,
  generatedAt: string,
): string {
  const rate = evaluatedTurns === 0
    ? null
    : Math.round((clarifiedTurns / evaluatedTurns) * 10_000) / 10_000;
  return JSON.stringify({
    ok: true,
    dashboard: {
      version: 'chat-quality-dashboard@1.2.0',
      generatedAt,
      routingClarifyBudget: {
        windowDays: 30,
        evaluatedTurns,
        clarifiedTurns,
        rate,
        budgetLimit: 0.1,
        withinBudget: rate === null ? null : rate <= 0.1,
      },
    },
  });
}

function exactStagingSmoke(
  overrides: Record<string, unknown> = {},
): string {
  const requiredChecks = [
    'content-engine /health',
    'nexus-hub /api/snapshot',
    'snapshot.uptime',
    'snapshot.bot',
    'snapshot.integrations',
    'snapshot.apiUsage',
    'cost-by-domain.totalCost',
    'cost-by-domain.detailed',
    'cost-by-domain.providerSplit',
    'cost-by-domain.dailySeries',
    'provider-stats.providers',
    'iOS /api/v1/dashboard',
    'iOS /api/v1/tasks/lists',
    'iOS /api/v1/training/today',
    'iOS /api/v1/plan/today',
    'iOS chat-message route boundary',
    'pm2 nexus-hub online',
    'pm2 content-engine online',
    'pm2 nexus-hub restarts == 0',
    'training plan preview e2e',
    'locale fidelity chat smoke',
    'Staging DB integrity',
    'Ollama release policy',
    'immutable staging selector',
  ];
  const localeDetail = JSON.stringify({
    ok: true,
    userId: 1_000_016,
    turns: [
      {
        requestedLocale: 'es-419', expectedLocale: 'en-US', storedLanguage: 'es-ES',
        httpStatus: 200, ok: true, routeMethod: 'authenticated-identity',
        responseType: 'authenticated_identity', authenticatedUserId: 1_000_016,
        hasDisplayName: true, expected: 'en', detected: 'en', confidence: 0.9,
        replyPreview: 'This authenticated session is signed in as Locale Smoke.',
      },
      {
        requestedLocale: 'en-US', expectedLocale: 'en-US', storedLanguage: 'es-ES',
        httpStatus: 200, ok: true, routeMethod: 'authenticated-identity',
        responseType: 'authenticated_identity', authenticatedUserId: 1_000_016,
        hasDisplayName: true, expected: 'en', detected: 'en', confidence: 0.9,
        replyPreview: 'This authenticated session is signed in as Locale Smoke.',
      },
      {
        requestedLocale: 'pt-BR', expectedLocale: 'pt-BR', storedLanguage: 'es-ES',
        httpStatus: 200, ok: true, routeMethod: 'authenticated-identity',
        responseType: 'authenticated_identity', authenticatedUserId: 1_000_016,
        hasDisplayName: true, expected: 'pt', detected: 'pt', confidence: 0.9,
        replyPreview: 'A sessão autenticada está em nome de Locale Smoke.',
      },
    ],
    providerUsageBefore: 0,
    providerUsageAfter: 0,
    providerUsageDelta: 0,
  });
  const trainingDetail = JSON.stringify({
    ok: true,
    httpStatus: 200,
    responseOk: true,
    planStatus: 'preview',
    userId: 1_000_014,
    blockerIds: [],
    warningCodes: [],
    totalSessions: 10,
    calendarFetchDegraded: true,
  });
  return JSON.stringify({
    version: '2',
    profile: 'nexus.staging-smoke.canonical.token-zero-locale.v2',
    runStartedAt: '2026-08-02T01:07:08.500Z',
    runCompletedAt: '2026-08-02T01:07:09.300Z',
    branch: 'protected-main-exact-artifact',
    sha: RUNTIME_SHA,
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    host: 'staging',
    verdict: 'passed',
    totals: { passed: requiredChecks.length, failed: 0, total: requiredChecks.length },
    checks: requiredChecks.map((name) => ({
      name,
      status: 'passed',
      detail: name === 'locale fidelity chat smoke'
        ? localeDetail
        : name === 'training plan preview e2e'
          ? trainingDetail
          : 'verified',
    })),
    ...overrides,
  });
}

function qualityMonitorRaw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'nexus.chat-capability-quality-monitor.v1',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    startedAt: '2026-08-02T01:07:09.550Z',
    completedAt: '2026-08-02T01:07:09.700Z',
    readinessAvailable: true,
    readinessArtifactHealthy: true,
    readinessUnavailableReason: null,
    readinessHealthAlertCount: 0,
    readinessRegressionAlertCount: 0,
    behaviorRegressionAlertCount: 0,
    fallbackRegressionAlertCount: 0,
    recordedAlertCount: 0,
    monitoredAlertSources: [
      'chat_quality_regression_monitor',
      'chat_v2_retirement_monitor',
    ],
    alertWindowStartedAt: '2026-08-02T01:02:08.000Z',
    durableAlertActivityRowCount: 0,
    verdict: 'passed',
    ...overrides,
  });
}

function actionSkillGate(): string {
  return JSON.stringify({
    schemaVersion: 'routing_action_skill_accuracy_report.v1',
    dbPath: '/private/staging-routing.db',
    report: {
      version: 'routing-action-skill-accuracy@1.0.0',
      generatedAt: '2026-08-02T01:02:08.700Z',
      corpusIdentityDigest: `sha256:${'d'.repeat(64)}`,
      sourceIdentity: {
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        releaseRunId: 'routing-action-skill-refresh-20260802T010000Z',
        promptSha256: 'e'.repeat(64),
        requestBuilderVersion: 'manifest-classifier-request@1.0.0',
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        usageCategory: 'gemini_classify',
        requestSource: 'system',
        baseCategory: 'routing_action_skill_cache_refresh',
        jobName: 'routing_action_skill_cache_refresh',
        userId: 0,
        tenantId: 0,
      },
      releaseEvidence: {
        hardBudgetUsd: 0.25,
        planDigests: [`sha256:${'f'.repeat(64)}`],
        completedPlanDigests: [`sha256:${'f'.repeat(64)}`],
        terminalPlanSequence: 1,
        terminalPlanDigest: `sha256:${'f'.repeat(64)}`,
        terminalPlanStatus: 'completed',
      },
      itemCount: 300,
      covered: 300,
      uncovered: 0,
      coverage: 1,
      correct: 288,
      agreement: 0.96,
      gate: {
        passed: true,
        requiredItemCount: 300,
        requiredCovered: 300,
        minimumAgreement: 0.95,
        reasons: [],
      },
    },
  });
}

function crossSkillPreflight(): string {
  return JSON.stringify({
    schema: 'nexus.chat-capability-cross-skill-preflight.v1',
    generatedAt: '2026-08-02T01:02:08.700Z',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    executorCoverage: {
      draft_email: true,
      send_email: true,
      connections_retry_sync: true,
    },
    legacyTailCoverage: {
      connections: true,
      notifications: true,
      decision_center: true,
    },
    trainingPlanCreateOutputRefs: 'absent',
    passed: true,
  });
}

function crossSkillSmoke(): string {
  return JSON.stringify({
    schema: 'nexus.training-cross-skill-staging-smoke.v1',
    runId: 'training-cross-skill-20260802T010203Z',
    startedAt: '2026-08-02T01:02:03.000Z',
    finishedAt: '2026-08-02T01:02:08.700Z',
    dryRun: false,
    dedicatedStagingIdentity: true,
    dedicatedIdentitySource: 'chat_eval_dedicated_tenant_db_attested',
    releaseIdentity: {
      environment: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
    },
    prerequisitesPassed: true,
    operationStatuses: {
      local_fixture_contracts: 'pass',
      phase7_cross_skill_flag_contract: 'pass',
      secretary_conflict: 'pass',
      cooking_fueling_gap: 'pass',
      finance_budget_constraint: 'pass',
      content_workload: 'pass',
      training_content_milestone: 'pass',
      shared_context_scope: 'pass',
    },
    crossSkillExecutionEffective: true,
    masterKill: false,
    trainingPlanCreateOutputRefs: 'absent',
    verdict: 'passed',
  });
}

async function loadHelper(): Promise<any> {
  return import(pathToFileURL(HELPER).href);
}

async function classifierPlan(overrides: Record<string, unknown> = {}): Promise<any> {
  const helper = await loadHelper();
  return helper.buildCapabilityFlagPlan({
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
    desiredValue: true,
    configuredFlags: allOff(),
    previousPlanSequence: 0,
    transitionReason: 'gate_pass',
    evidenceAttestation: routingEvidence(),
    stagingPrerequisite: null,
    generatedAt: GENERATED_AT,
    ...overrides,
  });
}

describe('chat capability flag transaction', () => {
  it('derives routing attestation from exact raw gate bytes instead of trusting a claimed hash', async () => {
    const helper = await loadHelper();
    const rawEvidence = rawRoutingGate();
    const attestation = helper.buildCapabilityEvidenceAttestation({
      rawEvidence,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      configuredFlags: allOff(),
    });
    expect(attestation).toEqual({
      ...routingEvidence(),
      evidenceSha256: createHash('sha256').update(rawEvidence).digest('hex'),
    });

    for (const mutate of [
      (raw: any) => { raw.gate.passed = false; },
      (raw: any) => { raw.gate.minimumComparisons = 199; },
      (raw: any) => { raw.surfaceTotals.classifierKeyword.compared = 199; },
      (raw: any) => { raw.evidence.capabilityFlagBinding.counts.selectedSurfaceFlagOnBundles = 1; },
      (raw: any) => { raw.evidence.identity.releaseIdentity.runtimeSha = 'f'.repeat(40); },
    ]) {
      const invalid = JSON.parse(rawEvidence);
      mutate(invalid);
      expect(() => helper.buildCapabilityEvidenceAttestation({
        rawEvidence: JSON.stringify(invalid),
        flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        configuredFlags: allOff(),
      })).toThrow(/gate|evidence|comparison|flag|release|identity|minimum/i);
    }
  });

  it('derives production staging prerequisite from a strict ON receipt and live exact health', async () => {
    const helper = await loadHelper();
    const plan = await classifierPlan();
    const receipt = helper.buildCapabilityFlagReceipt({
      plan,
      transactionId: TRANSACTION_ID,
      status: 'passed',
      startedAt: GENERATED_AT,
      completedAt: '2026-08-02T01:02:08.000Z',
      health: { backend: 'passed', content: 'passed', identity: 'passed' },
      rollback: { status: 'not_required' },
    });
    const configured = { ...allOff(), AI_ROUTING_MANIFEST_CLASSIFIER: true };
    const receiptRaw = `${JSON.stringify(receipt, null, 2)}\n`;
    const healthRaw = detailedHealth(configured, '2026-08-02T01:07:10.000Z');
    const dashboardRaw = clarifyDashboard(1_000, 50, '2026-08-02T01:07:09.500Z');
    const smokeRaw = exactStagingSmoke();
    const monitorRaw = qualityMonitorRaw();
    const prerequisite = helper.buildStagingCapabilityPrerequisite({
      receiptRaw,
      healthRaw,
      dashboardRaw,
      smokeRaw,
      monitorRaw,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      checkedAt: '2026-08-02T01:07:10.250Z',
    });
    expect(prerequisite).toMatchObject({
      schema: 'nexus.chat-capability-staging-prerequisite.v1',
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      enableTransactionId: TRANSACTION_ID,
      enableReceiptSha256: createHash('sha256').update(receiptRaw).digest('hex'),
      liveHealthSha256: createHash('sha256').update(healthRaw).digest('hex'),
      liveHealthTimestamp: '2026-08-02T01:07:10.000Z',
      liveHealthCheckedAt: '2026-08-02T01:07:10.250Z',
      stagingConfigured: configured,
      stagingEffective: configured,
    });
    expect(prerequisite.masterKill).toBe(false);

    for (const invalid of [
      { receiptRaw: receiptRaw.replace(RUNTIME_SHA, 'f'.repeat(40)), healthRaw },
      { receiptRaw, healthRaw: healthRaw.replace('"masterKill":false', '"masterKill":true') },
      { receiptRaw, healthRaw: healthRaw.replace('"AI_ROUTING_MANIFEST_CLASSIFIER":true', '"AI_ROUTING_MANIFEST_CLASSIFIER":false') },
      { receiptRaw, healthRaw: healthRaw.replace('"status":"healthy"', '"status":"degraded"') },
      { receiptRaw, healthRaw: healthRaw.replace('"database":"connected"', '"database":"disconnected"') },
      { receiptRaw, healthRaw: healthRaw.replace('"uptime":600', '"uptime":10') },
      {
        receiptRaw,
        healthRaw: healthRaw.replace(
          '"timestamp":"2026-08-02T01:07:10.000Z"',
          '"timestamp":"2026-08-02T00:59:08.750Z"',
        ),
      },
    ]) {
      expect(() => helper.buildStagingCapabilityPrerequisite({
        ...invalid,
        dashboardRaw,
        smokeRaw,
        monitorRaw,
        flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        checkedAt: '2026-08-02T01:07:10.250Z',
      })).toThrow(/staging|receipt|health|release|flag|kill/i);
    }

    const driftedHealth = healthRaw.replace(
      '"AI_ROUTING_MANIFEST_ORCHESTRATOR":false',
      '"AI_ROUTING_MANIFEST_ORCHESTRATOR":true',
    );
    expect(() => helper.buildStagingCapabilityPrerequisite({
      receiptRaw,
      healthRaw: driftedHealth,
      dashboardRaw,
      smokeRaw,
      monitorRaw,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      checkedAt: '2026-08-02T01:07:10.250Z',
    })).toThrow(/state|drift|receipt|staging/i);
  });

  it('binds exact live staging proof into every production enable plan and receipt', async () => {
    const helper = await loadHelper();
    const stagingPlan = await classifierPlan();
    const stagingReceipt = helper.buildCapabilityFlagReceipt({
      plan: stagingPlan,
      transactionId: TRANSACTION_ID,
      status: 'passed',
      startedAt: GENERATED_AT,
      completedAt: '2026-08-02T01:02:08.000Z',
      health: { backend: 'passed', content: 'passed', identity: 'passed' },
      rollback: { status: 'not_required' },
    });
    const configured = { ...allOff(), AI_ROUTING_MANIFEST_CLASSIFIER: true };
    const receiptRaw = `${JSON.stringify(stagingReceipt, null, 2)}\n`;
    const checkedAt = '2026-08-02T01:07:10.250Z';
    const healthRaw = detailedHealth(
      configured,
      '2026-08-02T01:07:10.000Z',
      '2026-08-02T01:07:09.000Z',
    );
    const dashboardRaw = clarifyDashboard(1_000, 50, '2026-08-02T01:07:09.500Z');
    const smokeRaw = exactStagingSmoke();
    const monitorRaw = qualityMonitorRaw();
    const forgedSmoke = JSON.parse(smokeRaw);
    forgedSmoke.checks[0].name = 'forged passed check';
    const stagingPrerequisite = helper.buildStagingCapabilityPrerequisite({
      receiptRaw,
      healthRaw,
      dashboardRaw,
      smokeRaw,
      monitorRaw,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      checkedAt,
    });
    expect(stagingPrerequisite).toMatchObject({
      observationMinimumMs: 300_000,
      observationElapsedMs: 302_250,
      normalSmokeProfile: 'nexus.staging-smoke.canonical.token-zero-locale.v2',
      normalSmokeCheckCount: 24,
      qualityMonitorCompletedAt: '2026-08-02T01:07:09.700Z',
      qualityMonitorVerdict: 'passed',
      scheduledMonitorLastRunAt: '2026-08-02T01:07:09.000Z',
      scheduledMonitorLastResult: 'success',
      durableAlertWindowStartedAt: '2026-08-02T01:02:08.000Z',
      durableAlertActivityRowCount: 0,
    });
    const observationPlan = helper.buildCapabilityObservationPlan({
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      previousObservationSequence: 0,
      receiptRaw,
      liveConfigured: configured,
      liveEffective: configured,
      liveMasterKill: false,
      shadowPlannerEffective: {
        global: false,
        user1000014: false,
        tenant1000014: false,
        user1000016: false,
        tenant1000016: false,
      },
      smokeScriptSha256: '9'.repeat(64),
      expectedProductionPlanSequence: 1,
      generatedAt: '2026-08-02T01:07:08.100Z',
    });
    const emptyApiUsage = {
      tablePresent: true, rowCount: 0, maxId: null, totalCostUsd: 0,
    };
    const emptyReservations = {
      tablePresent: true, rowCount: 0, maxId: null, totalReservedCostUsd: 0,
    };
    const observationReceipt = helper.buildCapabilityObservationReceipt({
      plan: observationPlan,
      transactionId: '20260802T010708Z-aabbccddeeff',
      stagingPrerequisite,
      smokeRaw,
      observationStartedAt: '2026-08-02T01:07:08.200Z',
      observationCompletedAt: '2026-08-02T01:07:10.400Z',
      configuredBefore: configured,
      effectiveBefore: configured,
      masterKillBefore: false,
      configuredAfter: configured,
      effectiveAfter: configured,
      masterKillAfter: false,
      flagSpecificEvidence: null,
      providerLedger: {
        scope: 'global',
        expectedFixtureUserIds: [1_000_014, 1_000_016],
        apiUsageBefore: emptyApiUsage,
        apiUsageAfter: emptyApiUsage,
        apiUsageRowDelta: 0,
        apiUsageCostDeltaUsd: 0,
        hardCeilingReservationsBefore: emptyReservations,
        hardCeilingReservationsAfter: emptyReservations,
        hardCeilingReservationRowDelta: 0,
        hardCeilingReservedCostDeltaUsd: 0,
      },
    });
    const observationRaw = `${JSON.stringify(observationReceipt, null, 2)}\n`;
    const observedStagingPrerequisite = helper
      .buildProductionStagingCapabilityPrerequisiteFromObservation({
        observationRaw,
        flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        checkedAt: '2026-08-02T01:07:10.500Z',
      });
    const productionPlan = helper.buildCapabilityFlagPlan({
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      desiredValue: true,
      configuredFlags: allOff(),
      previousPlanSequence: 0,
      transitionReason: 'gate_pass',
      evidenceAttestation: routingEvidence(),
      stagingPrerequisite: observedStagingPrerequisite,
      generatedAt: '2026-08-02T01:07:11.000Z',
    });
    expect(productionPlan.stagingPrerequisite).toEqual(observedStagingPrerequisite);
    const productionReceipt = helper.buildCapabilityFlagReceipt({
      plan: productionPlan,
      transactionId: '20260802T010210Z-fedcba654321',
      status: 'passed',
      startedAt: '2026-08-02T01:07:11.000Z',
      completedAt: '2026-08-02T01:07:12.000Z',
      health: { backend: 'passed', content: 'passed', identity: 'passed' },
      rollback: { status: 'not_required' },
    });
    expect(productionReceipt.stagingPrerequisite).toEqual(observedStagingPrerequisite);
    expect(helper.validateCapabilityFlagReceipt(productionReceipt)).toEqual(productionReceipt);

    for (const stagingProof of [
      null,
      {
        ...observedStagingPrerequisite,
        basePrerequisite: {
          ...observedStagingPrerequisite.basePrerequisite,
          artifactDigest: 'f'.repeat(64),
        },
      },
    ]) {
      expect(() => helper.buildCapabilityFlagPlan({
        role: 'production',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        desiredValue: true,
        configuredFlags: allOff(),
        previousPlanSequence: 0,
        transitionReason: 'gate_pass',
        evidenceAttestation: routingEvidence(),
        stagingPrerequisite: stagingProof,
        generatedAt: '2026-08-02T01:07:11.000Z',
      })).toThrow(/staging|prerequisite|health|digest/i);
    }

    for (const invalid of [
      {
        healthRaw: detailedHealth(
          configured,
          '2026-08-02T01:07:10.000Z',
          '2026-08-02T01:02:07.000Z',
        ),
        dashboardRaw,
        smokeRaw,
        monitorRaw: qualityMonitorRaw({ readinessRegressionAlertCount: 1, verdict: 'failed' }),
        checkedAt,
      },
      {
        healthRaw,
        dashboardRaw,
        smokeRaw: exactStagingSmoke({ verdict: 'failed' }),
        monitorRaw,
        checkedAt,
      },
      {
        healthRaw,
        dashboardRaw,
        smokeRaw: exactStagingSmoke({
          checks: JSON.parse(smokeRaw).checks.map((check: Record<string, unknown>) => (
            check.name === 'training plan preview e2e'
              ? {
                  ...check,
                  detail: JSON.stringify({
                    ...JSON.parse(String(check.detail)),
                    userId: 1_000_015,
                  }),
                }
              : check
          )),
        }),
        monitorRaw,
        checkedAt,
      },
      {
        healthRaw,
        dashboardRaw,
        smokeRaw: JSON.stringify(forgedSmoke),
        monitorRaw,
        checkedAt,
      },
      {
        healthRaw,
        dashboardRaw,
        smokeRaw,
        monitorRaw: qualityMonitorRaw({
          durableAlertActivityRowCount: 1,
        }),
        checkedAt,
      },
      {
        healthRaw,
        dashboardRaw,
        smokeRaw: exactStagingSmoke({
          checks: JSON.parse(smokeRaw).checks.map((check: Record<string, unknown>) => (
            check.name === 'locale fidelity chat smoke'
              ? {
                  ...check,
                  detail: JSON.stringify({
                    ...JSON.parse(String(check.detail)),
                    providerUsageAfter: 1,
                    providerUsageDelta: 1,
                  }),
                }
              : check
          )),
        }),
        monitorRaw,
        checkedAt,
      },
    ]) {
      expect(() => helper.buildStagingCapabilityPrerequisite({
        receiptRaw,
        flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        ...invalid,
      })).toThrow(/monitor|smoke|observation|five|staging|dashboard|health/i);
    }
  });

  it('normalizes calibration and target-on budget evidence for the clarify rollout', async () => {
    const helper = await loadHelper();
    const configuredBefore = enabledPrefix(4);
    const healthBefore = detailedHealth(configuredBefore);
    const calibrationRaw = JSON.stringify({
      version: 'routing-calibration@1.0.0',
      provenance: {
        source: 'corpus',
        corpusSize: 300,
        generatedAt: '2026-07-30T08:34:49.775Z',
      },
      clarify: { epsilon: 0.05, actionableFloor: 0.2 },
    });
    const baselineRaw = clarifyDashboard(1_000, 50, '2026-08-02T01:02:08.700Z');
    const calibration = helper.buildClarifyCalibrationEvidenceAttestation({
      calibrationRaw,
      dashboardRaw: baselineRaw,
      healthRaw: healthBefore,
      flag: 'AI_ROUTING_CLARIFY',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      configuredFlags: configuredBefore,
      checkedAt: '2026-08-02T01:02:09.000Z',
    });
    expect(calibration).toMatchObject({
      kind: 'clarify_calibration',
      collectedWithTargetEnabled: false,
      corpusSize: 300,
      baselineEvaluatedTurns: 1_000,
      baselineClarifiedTurns: 50,
      baselineGlobalRate: 0.05,
      budgetLimit: 0.1,
    });
    const stagingPlan = helper.buildCapabilityFlagPlan({
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_CLARIFY',
      desiredValue: true,
      configuredFlags: configuredBefore,
      previousPlanSequence: 4,
      transitionReason: 'gate_pass',
      evidenceAttestation: calibration,
      stagingPrerequisite: null,
      generatedAt: '2026-08-02T01:02:10.000Z',
    });
    const stagingReceipt = helper.buildCapabilityFlagReceipt({
      plan: stagingPlan,
      transactionId: '20260802T010210Z-aabbccddeeff',
      status: 'passed',
      startedAt: '2026-08-02T01:02:10.000Z',
      completedAt: '2026-08-02T01:02:12.000Z',
      health: { backend: 'passed', content: 'passed', identity: 'passed' },
      rollback: { status: 'not_required' },
    });
    const configuredAfter = enabledPrefix(5);
    const healthAfter = detailedHealth(configuredAfter, '2026-08-02T01:03:08.750Z')
      .replace('2026-08-02T01:02:08.500Z', '2026-08-02T01:03:08.500Z');
    const currentDashboardRaw = clarifyDashboard(1_100, 58, '2026-08-02T01:03:08.700Z');
    const receiptRaw = `${JSON.stringify(stagingReceipt, null, 2)}\n`;
    const budget = helper.buildClarifyBudgetEvidenceAttestation({
      receiptRaw,
      dashboardRaw: currentDashboardRaw,
      healthRaw: healthAfter,
      flag: 'AI_ROUTING_CLARIFY',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      checkedAt: '2026-08-02T01:03:09.000Z',
    });
    expect(budget).toMatchObject({
      kind: 'clarify_budget',
      collectedWithTargetEnabled: true,
      evaluatedTurns: 1_100,
      clarifiedTurns: 58,
      clarifyRate: 0.0527,
      candidateEvaluatedTurns: 100,
      candidateClarifiedTurns: 8,
      candidateClarifyRate: 0.08,
      withinBudget: true,
      outcomesReviewRequired: 'owner_plan_digest_ack',
    });

    const overBudget = clarifyDashboard(1_100, 61, '2026-08-02T01:03:08.700Z');
    expect(() => helper.buildClarifyBudgetEvidenceAttestation({
      receiptRaw,
      dashboardRaw: overBudget,
      healthRaw: healthAfter,
      flag: 'AI_ROUTING_CLARIFY',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      checkedAt: '2026-08-02T01:03:09.000Z',
    })).toThrow(/clarify|budget|rate/i);
  });

  it('normalizes the exact cache-only action gate and cross-skill preflight/smoke evidence', async () => {
    const helper = await loadHelper();
    const promptBefore = enabledPrefix(5);
    const action = helper.buildActionSkillEvidenceAttestation({
      rawEvidence: actionSkillGate(),
      healthRaw: detailedHealth(promptBefore),
      flag: 'AI_CLASSIFY_MANIFEST_PROMPT',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      configuredFlags: promptBefore,
      checkedAt: '2026-08-02T01:02:09.000Z',
    });
    expect(action).toMatchObject({
      kind: 'action_skill_accuracy',
      collectedWithTargetEnabled: false,
      labeledRows: 300,
      cacheRows: 300,
      agreementRate: 0.96,
      executionMode: 'cache_only',
      gatePassed: true,
    });

    const crossBefore = enabledPrefix(6);
    const preflight = helper.buildCrossSkillPreflightEvidenceAttestation({
      rawEvidence: crossSkillPreflight(),
      healthRaw: detailedHealth(crossBefore),
      flag: 'AI_CROSS_SKILL_EXECUTION',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      configuredFlags: crossBefore,
      checkedAt: '2026-08-02T01:02:09.000Z',
    });
    expect(preflight).toMatchObject({
      kind: 'cross_skill_preflight',
      collectedWithTargetEnabled: false,
      executorCoveragePassed: true,
      legacyTailCoveragePassed: true,
      outputRefsDecision: 'absent',
    });

    const crossAfter = enabledPrefix(7);
    const smoke = helper.buildCrossSkillSmokeEvidenceAttestation({
      rawEvidence: crossSkillSmoke(),
      healthRaw: detailedHealth(crossAfter),
      flag: 'AI_CROSS_SKILL_EXECUTION',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      configuredFlags: crossAfter,
      checkedAt: '2026-08-02T01:02:09.000Z',
    });
    expect(smoke).toMatchObject({
      kind: 'cross_skill_smoke',
      collectedWithTargetEnabled: true,
      smokeStatus: 'passed',
      releaseIdentityVerified: true,
      dedicatedStagingIdentity: true,
      dedicatedIdentitySource: 'chat_eval_dedicated_tenant_db_attested',
      outputRefsDecision: 'absent',
    });

    expect(() => helper.buildActionSkillEvidenceAttestation({
      rawEvidence: actionSkillGate().replace('"covered":300', '"covered":299'),
      healthRaw: detailedHealth(promptBefore),
      flag: 'AI_CLASSIFY_MANIFEST_PROMPT',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      configuredFlags: promptBefore,
      checkedAt: '2026-08-02T01:02:09.000Z',
    })).toThrow(/300|cache|covered|gate/i);
  });

  it('builds one exact-release-bound canonical plan from only the governed allowlist', async () => {
    const helper = await loadHelper();
    expect(helper.CHAT_CAPABILITY_FLAGS).toEqual(GOVERNED_FLAGS);
    expect(helper.CHAT_CAPABILITY_EVIDENCE_KINDS).toEqual([
      'routing_divergence',
      'clarify_calibration',
      'clarify_budget',
      'action_skill_accuracy',
      'cross_skill_preflight',
      'cross_skill_smoke',
    ]);

    const plan = await classifierPlan();
    expect(plan).toMatchObject({
      schema: PLAN_SCHEMA,
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      desiredValue: true,
      previousPlanSequence: 0,
      planSequence: 1,
      transitionReason: 'gate_pass',
      evidenceAttestation: routingEvidence(),
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
      configuredBefore: allOff(),
      configuredAfter: {
        ...allOff(),
        AI_ROUTING_MANIFEST_CLASSIFIER: true,
      },
    });
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(plan.configuredBefore)).toEqual(GOVERNED_FLAGS);
    expect(Object.keys(plan.configuredAfter)).toEqual(GOVERNED_FLAGS);

    const repeated = await classifierPlan();
    expect(repeated).toEqual(plan);
    expect((await classifierPlan({
      evidenceAttestation: routingEvidence({ evidenceSha256: 'd'.repeat(64) }),
    })).planDigest)
      .not.toBe(plan.planDigest);
    expect((await classifierPlan({
      artifactDigest: 'e'.repeat(64),
      evidenceAttestation: routingEvidence({ artifactDigest: 'e'.repeat(64) }),
    })).planDigest)
      .not.toBe(plan.planDigest);
    const laterPlan = await classifierPlan({ previousPlanSequence: 7 });
    expect(laterPlan).toMatchObject({ previousPlanSequence: 7, planSequence: 8 });
    expect(laterPlan.planDigest).not.toBe(plan.planDigest);

    for (const [index, [flag, selectedSurface]] of [
      ['AI_ROUTING_MANIFEST_CLASSIFIER', 'classifierKeyword'],
      ['AI_ROUTING_MANIFEST_ORCHESTRATOR', 'orchestratorPrimary'],
      ['AI_ROUTING_MANIFEST_SHADOW', 'shadowRoute'],
      ['AI_ROUTING_MANIFEST_REGISTRY', 'registrySubset'],
    ].entries() as ArrayIterator<[number, readonly [string, string]]>) {
      expect(() => helper.buildCapabilityFlagPlan({
        role: 'staging',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        flag,
        desiredValue: true,
        configuredFlags: enabledPrefix(index),
        previousPlanSequence: 0,
        transitionReason: 'gate_pass',
        evidenceAttestation: routingEvidence({ flag, selectedSurface }),
        stagingPrerequisite: null,
        generatedAt: GENERATED_AT,
      })).not.toThrow();
      if (index > 0) {
        expect(() => helper.buildCapabilityFlagPlan({
          role: 'staging',
          runtimeSha: RUNTIME_SHA,
          artifactDigest: ARTIFACT_DIGEST,
          flag,
          desiredValue: true,
          configuredFlags: allOff(),
          previousPlanSequence: 0,
          transitionReason: 'gate_pass',
          evidenceAttestation: routingEvidence({ flag, selectedSurface }),
          stagingPrerequisite: null,
          generatedAt: GENERATED_AT,
        })).toThrow(/order|earlier|preced|sequence/i);
      }
      expect(() => helper.buildCapabilityFlagPlan({
        role: 'staging',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        flag,
        desiredValue: true,
        configuredFlags: enabledPrefix(index),
        previousPlanSequence: 0,
        transitionReason: 'gate_pass',
        evidenceAttestation: routingEvidence({ flag, selectedSurface: 'wrongSurface' }),
        stagingPrerequisite: null,
        generatedAt: GENERATED_AT,
      })).toThrow(/surface/i);
    }

    expect(() => helper.buildCapabilityFlagPlan({
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      desiredValue: false,
      configuredFlags: enabledPrefix(3),
      previousPlanSequence: 3,
      transitionReason: 'operator_rollback',
      evidenceAttestation: null,
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
    })).toThrow(/order|later|reverse|sequence/i);

    for (const invalid of [
      { flag: 'UNREVIEWED_FLAG' },
      { flag: ['AI_ROUTING_CLARIFY', 'AI_CROSS_SKILL_EXECUTION'] },
      { runtimeSha: 'short' },
      { artifactDigest: 'short' },
      { role: 'development' },
      { previousPlanSequence: -1 },
      { previousPlanSequence: 1.5 },
      { previousPlanSequence: Number.MAX_SAFE_INTEGER },
      { transitionReason: 'skip_gate' },
      { evidenceAttestation: null },
      { evidenceAttestation: routingEvidence({ status: 'failed' }) },
      { evidenceAttestation: routingEvidence({ selectedSurface: 'all' }) },
      { evidenceAttestation: routingEvidence({ comparisonCount: 199 }) },
      { evidenceAttestation: routingEvidence({ minimumComparisons: 199 }) },
      { evidenceAttestation: routingEvidence({ agreementRate: 0.989 }) },
      { evidenceAttestation: routingEvidence({ collectedWithTargetEnabled: true }) },
      { evidenceAttestation: routingEvidence({ kind: 'unreviewed_gate' }) },
      { evidenceAttestation: routingEvidence({ runtimeSha: 'd'.repeat(40) }) },
    ]) {
      expect(() => helper.buildCapabilityFlagPlan({
        role: 'staging',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        desiredValue: true,
        configuredFlags: allOff(),
        previousPlanSequence: 0,
        transitionReason: 'gate_pass',
        evidenceAttestation: routingEvidence(),
        stagingPrerequisite: null,
        generatedAt: GENERATED_AT,
        ...invalid,
      })).toThrow();
    }

    const enabled = { ...allOff(), AI_ROUTING_MANIFEST_CLASSIFIER: true };
    const disable = helper.buildCapabilityFlagPlan({
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      desiredValue: false,
      configuredFlags: enabled,
      previousPlanSequence: 8,
      transitionReason: 'operator_rollback',
      evidenceAttestation: null,
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
    });
    expect(disable).toMatchObject({
      previousPlanSequence: 8,
      planSequence: 9,
      configuredBefore: enabled,
      configuredAfter: allOff(),
      effectiveAfter: allOff(),
      changedFlags: ['AI_ROUTING_MANIFEST_CLASSIFIER'],
      evidenceAttestation: null,
    });
  });

  it('requires exact owner authorization and the exact immutable plan digest before apply', async () => {
    const helper = await loadHelper();
    const plan = await classifierPlan();

    expect(() => helper.assertCapabilityFlagApplyAuthorization({
      ownerAuthorized: '0',
      ackPlan: plan.planDigest,
      planDigest: plan.planDigest,
    })).toThrow(/owner|authoriz/i);
    expect(() => helper.assertCapabilityFlagApplyAuthorization({
      ownerAuthorized: '1',
      ackPlan: `sha256:${'f'.repeat(64)}`,
      planDigest: plan.planDigest,
    })).toThrow(/plan|digest|ack/i);
    expect(() => helper.assertCapabilityFlagApplyAuthorization({
      ownerAuthorized: 'true',
      ackPlan: plan.planDigest,
      planDigest: plan.planDigest,
    })).toThrow(/owner|authoriz/i);
    expect(helper.assertCapabilityFlagApplyAuthorization({
      ownerAuthorized: '1',
      ackPlan: plan.planDigest,
      planDigest: plan.planDigest,
    })).toBe(true);
  });

  it('rewrites dotenv as inert data, preserves private/unmanaged bytes, and changes one semantic flag', async () => {
    const helper = await loadHelper();
    const plan = await classifierPlan();
    const source = [
      '# keep this comment and ordering byte-for-byte',
      `PORTAL_TOKEN=${SECRET_SENTINEL}`,
      'SHELLISH_LITERAL=$(touch /tmp/nexus-flag-transaction-must-not-run)',
      'AI_ROUTING_MANIFEST_CLASSIFIER=false',
      'UNRELATED_VALUE=unchanged',
      '',
    ].join('\n');

    const rewritten = helper.rewriteCapabilityFlagDotenv({ source, plan });
    expect(rewritten).toMatchObject({
      configuredBefore: allOff(),
      configuredAfter: {
        ...allOff(),
        AI_ROUTING_MANIFEST_CLASSIFIER: true,
      },
      changedFlags: ['AI_ROUTING_MANIFEST_CLASSIFIER'],
    });
    expect(rewritten.contents).toContain(`# keep this comment and ordering byte-for-byte\n`);
    expect(rewritten.contents).toContain(`PORTAL_TOKEN=${SECRET_SENTINEL}\n`);
    expect(rewritten.contents).toContain(
      'SHELLISH_LITERAL=$(touch /tmp/nexus-flag-transaction-must-not-run)\n',
    );
    expect(rewritten.contents).toContain('UNRELATED_VALUE=unchanged\n');
    for (const flag of GOVERNED_FLAGS) {
      const assignments = rewritten.contents
        .split(/\r?\n/u)
        .filter((line: string) => line === `${flag}=${flag === plan.flag ? 'true' : 'false'}`);
      expect(assignments, flag).toHaveLength(1);
    }

    expect(() => helper.rewriteCapabilityFlagDotenv({
      source: `${source}AI_ROUTING_MANIFEST_CLASSIFIER=false\n`,
      plan,
    })).toThrow(/duplicate/i);
    expect(() => helper.rewriteCapabilityFlagDotenv({
      source: source.replace('AI_ROUTING_MANIFEST_CLASSIFIER=false',
        'AI_ROUTING_MANIFEST_CLASSIFIER=yes'),
      plan,
    })).toThrow(/boolean|canonical|true|false/i);
  });

  it('makes the master kill suppress every capability without rewriting their configured values', async () => {
    const helper = await loadHelper();
    const configured = {
      ...allOff(),
      AI_ROUTING_MANIFEST_CLASSIFIER: true,
      AI_ROUTING_CLARIFY: true,
    };
    const plan = helper.buildCapabilityFlagPlan({
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: MASTER_KILL,
      desiredValue: true,
      configuredFlags: configured,
      previousPlanSequence: 2,
      transitionReason: 'emergency_kill',
      evidenceAttestation: null,
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
    });

    expect(plan.configuredAfter).toEqual({ ...configured, [MASTER_KILL]: true });
    for (const flag of CAPABILITY_FLAGS) expect(plan.effectiveAfter[flag], flag).toBe(false);
    expect(plan.changedFlags).toEqual([MASTER_KILL]);

    const cleanup = helper.buildCapabilityFlagPlan({
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_CLARIFY',
      desiredValue: false,
      configuredFlags: { ...configured, [MASTER_KILL]: true },
      previousPlanSequence: 3,
      transitionReason: 'operator_rollback',
      evidenceAttestation: null,
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
    });
    expect(cleanup.configuredAfter).toMatchObject({
      AI_ROUTING_MANIFEST_CLASSIFIER: true,
      AI_ROUTING_CLARIFY: false,
      AI_ROUTING_MANIFEST_KILL: true,
    });
    for (const flag of CAPABILITY_FLAGS) expect(cleanup.effectiveAfter[flag], flag).toBe(false);

    expect(() => helper.buildCapabilityFlagPlan({
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: 'AI_ROUTING_MANIFEST_REGISTRY',
      desiredValue: true,
      configuredFlags: { ...allOff(), [MASTER_KILL]: true },
      previousPlanSequence: 4,
      transitionReason: 'gate_pass',
      evidenceAttestation: routingEvidence({
        flag: 'AI_ROUTING_MANIFEST_REGISTRY',
        selectedSurface: 'registrySubset',
      }),
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
    })).toThrow(/kill/i);

    expect(() => helper.buildCapabilityFlagPlan({
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: MASTER_KILL,
      desiredValue: false,
      configuredFlags: { ...configured, [MASTER_KILL]: true },
      previousPlanSequence: 5,
      transitionReason: 'operator_rollback',
      evidenceAttestation: null,
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
    })).toThrow(/kill|configured|off/i);

    const clearKill = helper.buildCapabilityFlagPlan({
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: MASTER_KILL,
      desiredValue: false,
      configuredFlags: { ...allOff(), [MASTER_KILL]: true },
      previousPlanSequence: 6,
      transitionReason: 'operator_rollback',
      evidenceAttestation: null,
      stagingPrerequisite: null,
      generatedAt: GENERATED_AT,
    });
    expect(clearKill.configuredAfter).toEqual(allOff());
    expect(clearKill.effectiveAfter).toEqual(allOff());
  });

  it('builds and validates a strict durable receipt without dotenv or secret material', async () => {
    const helper = await loadHelper();
    const plan = await classifierPlan();
    const receipt = helper.buildCapabilityFlagReceipt({
      plan,
      transactionId: TRANSACTION_ID,
      status: 'passed',
      startedAt: GENERATED_AT,
      completedAt: '2026-08-02T01:02:08.000Z',
      health: { backend: 'passed', content: 'passed', identity: 'passed' },
      rollback: { status: 'not_required' },
    });

    expect(receipt).toMatchObject({
      schema: RECEIPT_SCHEMA,
      transactionId: TRANSACTION_ID,
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      planDigest: plan.planDigest,
      planSequence: plan.planSequence,
      flag: plan.flag,
      evidenceAttestation: plan.evidenceAttestation,
      configuredBefore: plan.configuredBefore,
      configuredAfter: plan.configuredAfter,
      status: 'passed',
      rollback: { status: 'not_required' },
    });
    expect(helper.validateCapabilityFlagReceipt(receipt)).toEqual(receipt);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toMatch(/PORTAL_TOKEN|dotenv|rawEnvironment|secretValue/i);

    for (const forbidden of [
      { rawEnvironment: `PORTAL_TOKEN=${SECRET_SENTINEL}` },
      { dotenvBefore: SECRET_SENTINEL },
      { secretValue: SECRET_SENTINEL },
      { unexpected: true },
    ]) {
      expect(() => helper.validateCapabilityFlagReceipt({ ...receipt, ...forbidden }))
        .toThrow(/schema|field|unknown|forbidden/i);
    }
  });

  it('ships executable inspect/apply operators with durable systemd and fail-closed rollback wiring', () => {
    for (const file of [OPERATOR, REMOTE, HELPER]) {
      expect(existsSync(file), file).toBe(true);
    }
    expect(statSync(OPERATOR).mode & 0o111).not.toBe(0);
    expect(statSync(REMOTE).mode & 0o111).not.toBe(0);

    const help = spawnSync('bash', [OPERATOR, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(help.status, `${help.stdout}\n${help.stderr}`).toBe(0);
    for (const mode of ['inspect', 'apply', 'inspect-secrets', 'apply-secrets']) {
      expect(help.stdout, mode).toContain(mode);
    }

    const operator = readFileSync(OPERATOR, 'utf8');
    const remote = readFileSync(REMOTE, 'utf8');
    const helper = readFileSync(HELPER, 'utf8');
    const transaction = `${remote}\n${helper}`;

    expect(operator).toContain(PLAN_SCHEMA);
    expect(operator).toContain(EVIDENCE_SCHEMA);
    expect(operator).toContain(RECEIPT_SCHEMA);
    expect(operator).toContain('NEXUS_RELEASE_OWNER_AUTHORIZED');
    expect(operator).toContain('--ack-plan');
    expect(operator).toContain('systemd-run');
    expect(operator).toContain('--user');
    expect(operator).toContain('--collect');
    expect(operator).not.toMatch(/(?:--wait|--pipe)(?:\s|$)/u);
    expect(operator).toContain('remote-chat-capability-flag-transaction.sh');

    expect(remote).toContain(RECEIPT_SCHEMA);
    expect(remote).toContain('/home/dominguez/.local/state/nexus-release/.release.lock');
    expect(remote).toContain('/run/lock/nexus-release-sonar.lock');
    expect(remote).toContain('flock -n');
    expect(remote).toContain('.complete.json');
    expect(remote).toContain('NEXUS_RELEASE_SHA');
    expect(remote).toContain('NEXUS_RELEASE_ARTIFACT_SHA256');
    expect(remote).toContain('env -i');
    expect(remote).toMatch(/\bdelete\b/u);
    expect(remote).toMatch(/\bstart\b/u);
    expect(remote).toContain('rollback_failed');
    expect(remote).toContain('rolled_back');
    expect(remote).toMatch(/trap\s+[^\n]*EXIT/u);
    expect(remote).not.toMatch(/(?:^|\n)\s*(?:source|\.)\s+[^\n]*\.env(?:\s|$)/u);
    expect(remote).not.toMatch(/(?:^|\n)\s*set\s+-a(?:\s|$)/u);

    expect(transaction).toContain('fsyncSync');
    expect(transaction).toContain('renameSync');
    expect(transaction).toMatch(/\.next-/u);
    expect(transaction).toContain('.env.before');
    expect(transaction).toContain('restore');
    expect(transaction).toContain(MASTER_KILL);
  });
});
