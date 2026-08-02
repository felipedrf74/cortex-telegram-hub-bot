import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const HELPER = path.resolve(__dirname, '../../scripts/lib/chat-capability-flag-transaction.mjs');
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const FLAG = 'AI_ROUTING_MANIFEST_CLASSIFIER';
const ENABLE_TRANSACTION_ID = '20260802T010000Z-abcdef123456';
const OBSERVATION_TRANSACTION_ID = '20260802T010511Z-fedcba654321';
const ENABLE_COMPLETED_AT = '2026-08-02T01:00:10.000Z';
const OBSERVATION_GENERATED_AT = '2026-08-02T01:05:11.000Z';
const SMOKE_RAW = '{}\n';

let helper: any;

beforeAll(async () => {
  helper = await import(pathToFileURL(HELPER).href);
});

const capabilityFlags = [
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
  'AI_ROUTING_MANIFEST_KILL',
] as const;

function allOff(): Record<string, boolean> {
  return Object.fromEntries(capabilityFlags.map((flag) => [flag, false]));
}

function enabledPrefix(): Record<string, boolean> {
  return { ...allOff(), [FLAG]: true };
}

function routingEvidence(): Record<string, unknown> {
  return {
    schema: 'nexus.chat-capability-flag-evidence.v1',
    kind: 'routing_divergence',
    status: 'passed',
    environment: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: FLAG,
    collectedWithTargetEnabled: false,
    evidenceSha256: 'c'.repeat(64),
    generatedAt: '2026-08-02T00:59:59.000Z',
    selectedSurface: 'classifierKeyword',
    comparisonCount: 200,
    minimumComparisons: 200,
    agreementRate: 0.99,
    windowSinceInclusive: '2026-08-02T00:50:01.000Z',
    windowUntilInclusive: '2026-08-02T00:59:58.000Z',
    shadowHookReceiptSchema: 'nexus.chat-shadow-route-hook-transaction.v1',
    shadowHookReceiptSha256: '2'.repeat(64),
    shadowHookTransactionId: '20260802T005000Z-123456abcdef',
    shadowHookPlanDigest: `sha256:${'3'.repeat(64)}`,
    shadowHookPlanSequence: 1,
    shadowHookCompletedAt: '2026-08-02T00:50:00.000Z',
    shadowHookReceiptRuntimeSha: RUNTIME_SHA,
    shadowHookReceiptArtifactDigest: ARTIFACT_DIGEST,
    shadowHookReceiptRole: 'staging',
    shadowHookReceiptStatus: 'passed',
    shadowHookReceiptAction: 'enable',
    dedicatedTenantId: 42,
    liveShadowRouteHookGlobal: false,
    liveShadowRouteHookDedicatedUser: true,
    liveShadowRouteHookDedicatedTenant: true,
    liveShadowPlannerGlobal: false,
    liveShadowPlannerDedicatedUser: false,
    liveShadowPlannerDedicatedTenant: false,
    liveHealthSha256: '4'.repeat(64),
    liveHealthCheckedAt: '2026-08-02T00:59:58.500Z',
  };
}

function enableReceipt(): Record<string, unknown> {
  const plan = helper.buildCapabilityFlagPlan({
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: FLAG,
    desiredValue: true,
    configuredFlags: allOff(),
    previousPlanSequence: 0,
    transitionReason: 'gate_pass',
    evidenceAttestation: routingEvidence(),
    stagingPrerequisite: null,
    generatedAt: '2026-08-02T01:00:00.000Z',
  });
  return helper.buildCapabilityFlagReceipt({
    plan,
    transactionId: ENABLE_TRANSACTION_ID,
    status: 'passed',
    startedAt: '2026-08-02T01:00:01.000Z',
    completedAt: ENABLE_COMPLETED_AT,
    health: { backend: 'passed', content: 'passed', identity: 'passed' },
    rollback: { status: 'not_required' },
  });
}

function shadowPlannerOff(): Record<string, unknown> {
  return {
    global: false,
    user1000014: false,
    tenant1000014: false,
    user1000016: false,
    tenant1000016: false,
    dedicatedEval: { present: true, user: false, tenant: false },
  };
}

function observationPlan(): Record<string, unknown> {
  return helper.buildCapabilityObservationPlan({
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: FLAG,
    previousObservationSequence: 0,
    receiptRaw: `${JSON.stringify(enableReceipt())}\n`,
    liveConfigured: enabledPrefix(),
    liveEffective: enabledPrefix(),
    liveMasterKill: false,
    shadowPlannerEffective: shadowPlannerOff(),
    smokeScriptSha256: 'd'.repeat(64),
    expectedProductionPlanSequence: 1,
    generatedAt: OBSERVATION_GENERATED_AT,
  });
}

function stagingPrerequisite(plan: Record<string, any>): Record<string, unknown> {
  return {
    schema: 'nexus.chat-capability-staging-prerequisite.v1',
    flag: FLAG,
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    enableTransactionId: ENABLE_TRANSACTION_ID,
    enableReceiptSha256: plan.enableReceiptSha256,
    enableCompletedAt: ENABLE_COMPLETED_AT,
    normalSmokeSha256: createHash('sha256').update(SMOKE_RAW).digest('hex'),
    normalSmokeProfile: 'nexus.staging-smoke.canonical.token-zero-locale.v2',
    normalSmokeStartedAt: '2026-08-02T01:05:12.000Z',
    normalSmokeCompletedAt: '2026-08-02T01:05:13.000Z',
    normalSmokeCheckCount: 24,
    qualityDashboardSha256: 'e'.repeat(64),
    qualityDashboardGeneratedAt: '2026-08-02T01:05:13.100Z',
    qualityMonitorSha256: 'f'.repeat(64),
    qualityMonitorStartedAt: '2026-08-02T01:05:13.200Z',
    qualityMonitorCompletedAt: '2026-08-02T01:05:13.300Z',
    qualityMonitorVerdict: 'passed',
    durableAlertWindowStartedAt: ENABLE_COMPLETED_AT,
    durableAlertActivityRowCount: 0,
    scheduledMonitorLastRunAt: '2026-08-02T01:05:13.300Z',
    scheduledMonitorLastResult: 'success',
    observationMinimumMs: 300_000,
    observationElapsedMs: 303_500,
    backendUptimeSeconds: 600,
    liveHealthSha256: '1'.repeat(64),
    liveHealthTimestamp: '2026-08-02T01:05:13.400Z',
    liveHealthCheckedAt: '2026-08-02T01:05:13.500Z',
    stagingConfigured: enabledPrefix(),
    stagingEffective: enabledPrefix(),
    masterKill: false,
  };
}

function emptySnapshot(costKey: string): Record<string, unknown> {
  return { tablePresent: true, rowCount: 0, maxId: null, [costKey]: 0 };
}

function providerLedger(): Record<string, unknown> {
  return {
    scope: 'global',
    expectedFixtureUserIds: [1_000_014, 1_000_016],
    apiUsageBefore: emptySnapshot('totalCostUsd'),
    apiUsageAfter: emptySnapshot('totalCostUsd'),
    apiUsageRowDelta: 0,
    apiUsageCostDeltaUsd: 0,
    hardCeilingReservationsBefore: emptySnapshot('totalReservedCostUsd'),
    hardCeilingReservationsAfter: emptySnapshot('totalReservedCostUsd'),
    hardCeilingReservationRowDelta: 0,
    hardCeilingReservedCostDeltaUsd: 0,
  };
}

function observationReceipt(): Record<string, unknown> {
  const plan = observationPlan();
  return helper.buildCapabilityObservationReceipt({
    plan,
    transactionId: OBSERVATION_TRANSACTION_ID,
    stagingPrerequisite: stagingPrerequisite(plan),
    smokeRaw: SMOKE_RAW,
    observationStartedAt: '2026-08-02T01:05:11.100Z',
    observationCompletedAt: '2026-08-02T01:05:13.600Z',
    configuredBefore: enabledPrefix(),
    effectiveBefore: enabledPrefix(),
    masterKillBefore: false,
    configuredAfter: enabledPrefix(),
    effectiveAfter: enabledPrefix(),
    masterKillAfter: false,
    flagSpecificEvidence: null,
    providerLedger: providerLedger(),
  });
}

describe('chat capability staging observation transaction', () => {
  it('binds one mature exact enable, contiguous live prefix, smoke profile, and expiry', () => {
    const plan = observationPlan();
    expect(plan).toMatchObject({
      schema: 'nexus.chat-capability-observation-plan.v1',
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      flag: FLAG,
      observationSequence: 1,
      enableTransactionId: ENABLE_TRANSACTION_ID,
      enablePlanSequence: 1,
      enableCompletedAt: ENABLE_COMPLETED_AT,
      smokeNotBefore: '2026-08-02T01:05:10.000Z',
      smokeProfile: 'nexus.staging-smoke.canonical.token-zero-locale.v2',
      expectedProductionPlanSequence: 1,
      expiresAt: '2026-08-02T02:05:11.000Z',
      masterKill: false,
    });
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(helper.validateCapabilityObservationPlan(plan)).toEqual(plan);
  });

  it('rejects hidden shadow planning, state drift, non-prefix state, and stale maturity', () => {
    const receiptRaw = `${JSON.stringify(enableReceipt())}\n`;
    const base = {
      role: 'staging', runtimeSha: RUNTIME_SHA, artifactDigest: ARTIFACT_DIGEST,
      flag: FLAG, previousObservationSequence: 0, receiptRaw,
      liveConfigured: enabledPrefix(), liveEffective: enabledPrefix(), liveMasterKill: false,
      shadowPlannerEffective: shadowPlannerOff(), smokeScriptSha256: 'd'.repeat(64),
      expectedProductionPlanSequence: 1, generatedAt: OBSERVATION_GENERATED_AT,
    };
    expect(() => helper.buildCapabilityObservationPlan({
      ...base,
      shadowPlannerEffective: { ...shadowPlannerOff(), user1000016: true },
    })).toThrow(/shadow|token-zero|effectively off/i);
    expect(() => helper.buildCapabilityObservationPlan({
      ...base,
      liveEffective: allOff(),
    })).toThrow(/prefix|receipt|live/i);
    expect(() => helper.buildCapabilityObservationPlan({
      ...base,
      liveConfigured: {
        ...enabledPrefix(),
        AI_ROUTING_MANIFEST_ORCHESTRATOR: false,
        AI_ROUTING_MANIFEST_SHADOW: true,
      },
      liveEffective: {
        ...enabledPrefix(),
        AI_ROUTING_MANIFEST_ORCHESTRATOR: false,
        AI_ROUTING_MANIFEST_SHADOW: true,
      },
    })).toThrow(/prefix|receipt|live/i);
    expect(() => helper.buildCapabilityObservationPlan({
      ...base,
      generatedAt: '2026-08-02T01:05:09.999Z',
    })).toThrow(/maturity|five|generated/i);
  });

  it('publishes a strict receipt only for unchanged state and zero durable ledger deltas', () => {
    const receipt = observationReceipt();
    expect(receipt).toMatchObject({
      schema: 'nexus.chat-capability-observation-receipt.v1',
      status: 'passed',
      transactionId: OBSERVATION_TRANSACTION_ID,
      smokeCheckCount: 24,
      masterKillBefore: false,
      masterKillAfter: false,
      expectedProductionPlanSequence: 1,
    });
    expect(helper.validateCapabilityObservationReceipt(receipt)).toEqual(receipt);

    const usage = structuredClone(receipt);
    usage.providerLedger.apiUsageAfter = {
      tablePresent: true, rowCount: 1, maxId: 1, totalCostUsd: 0.001,
    };
    usage.providerLedger.apiUsageRowDelta = 1;
    usage.providerLedger.apiUsageCostDeltaUsd = 0.001;
    expect(() => helper.validateCapabilityObservationReceipt(usage)).toThrow(/ledger|usage|delta/i);

    const reservation = structuredClone(receipt);
    reservation.providerLedger.hardCeilingReservationsAfter = {
      tablePresent: true, rowCount: 1, maxId: 1, totalReservedCostUsd: 0.01,
    };
    reservation.providerLedger.hardCeilingReservationRowDelta = 1;
    reservation.providerLedger.hardCeilingReservedCostDeltaUsd = 0.01;
    expect(() => helper.validateCapabilityObservationReceipt(reservation))
      .toThrow(/ledger|reservation|delta/i);

    for (const key of ['apiUsageBefore', 'hardCeilingReservationsBefore']) {
      const missing = structuredClone(receipt);
      missing.providerLedger[key] = {
        ...missing.providerLedger[key],
        tablePresent: false,
      };
      expect(() => helper.validateCapabilityObservationReceipt(missing))
        .toThrow(/ledger|table|scope|reservation|usage/i);
    }

    const alert = structuredClone(receipt);
    alert.stagingPrerequisite.durableAlertActivityRowCount = 1;
    expect(() => helper.validateCapabilityObservationReceipt(alert)).toThrow(/alert|prerequisite/i);

    const drift = structuredClone(receipt);
    drift.configuredAfter.AI_ROUTING_MANIFEST_CLASSIFIER = false;
    expect(() => helper.validateCapabilityObservationReceipt(drift)).toThrow(/prefix|changed/i);
  });
});
