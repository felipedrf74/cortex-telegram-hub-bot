// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const summaryMock = vi.hoisted(() => vi.fn());
const setControlMock = vi.hoisted(() => vi.fn());
const ownerTargetMock = vi.hoisted(() => vi.fn());
const safetyIncidentsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: { autoRollbackEnabled: true },
}));
vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: () => { throw new Error('explicit database required'); },
}));
vi.mock('../../src/services/local-inference-reporting', () => ({
  buildLocalInferenceSummary: (...args: unknown[]) => summaryMock(...args),
}));
vi.mock('../../src/services/local-inference-runtime-control', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/local-inference-runtime-control')>(
    '../../src/services/local-inference-runtime-control',
  )),
  getLocalInferenceRuntimeControl: () => ({ mode: 'active', environment: 'production' }),
  setLocalInferenceRuntimeControl: (...args: unknown[]) => setControlMock(...args),
}));
vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service')),
  getOwnerBootstrapTarget: () => ownerTargetMock(),
}));
vi.mock('../../src/services/local-inference-safety-incidents', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/local-inference-safety-incidents')>(
    '../../src/services/local-inference-safety-incidents',
  )),
  listRecentCriticalLocalInferenceSafetyIncidents: (...args: unknown[]) => safetyIncidentsMock(...args),
}));
vi.mock('../../src/utils/logger', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger')),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { evaluateLocalInferenceRollback } from '../../src/services/local-inference-auto-rollback';

const fakeDb = {
  transaction: (callback: () => unknown) => ({ immediate: callback }),
  prepare: (sql: string) => ({
    get: () => sql.includes('SELECT mode') ? { mode: 'active' } : { updated_by: 37 },
  }),
};

function summary() {
  return {
    window: { startsAt: '2026-08-11T00:00:00.000Z', generatedAt: '2026-08-12T00:00:00.000Z' },
    operations: {
      locallyAttempted: 30,
      localRoutingDecisions: 30,
      localSuccessPercent: 94,
      eligibleFallbackPercent: 16,
      cloudFallbackAttempts: 20,
      cloudFallbackReliabilityAttempts: 20,
      cloudFallbackSuccessPercent: 98,
      ordinaryChatOperations: 25,
      scriptOperations: 20,
      completedScriptOperations: 20,
    },
    latency: {
      ordinaryChatFirstTokenP95Ms: 13_000,
      ordinaryChatTotalP95Ms: 46_000,
      scriptThroughputAverageTokensPerSecond: 3.8,
      scriptJobP95DurationMs: 12 * 60 * 1_000 + 1,
      ordinaryChatFirstTokenSampleCount: 20,
      ordinaryChatTotalSampleCount: 20,
      scriptThroughputSampleCount: 20,
      scriptJobDurationSampleCount: 20,
    },
    quality: { structuredRuns: 100, schemaValidityPercent: 98, rejectionReasons: [] },
    pricingProof: {
      profileVersionObservationCount: 30,
      profileVersionStablePass: true,
      modelDigestObservationCount: 1,
      modelDigestStablePass: true,
    },
    host: {
      manifestAvailable: true,
      manifestVersionMatchesControl: true,
      modelDigestMatchesControl: true,
      profileVersionMatchesControl: true,
      runtimeContractMatchesControl: true,
      memoryAvailableBytes: 8 * 1024 ** 3,
      memoryHeadroomPass: true,
      swapUsedBytes: 0,
      zeroSwapPass: true,
    },
    nonAiApiLatency: {
      currentSampleCount: 30,
      regressionPercent: 0,
    },
    endUserApiErrors: {
      currentSampleCount: 30,
      regressionPercentagePoints: 0,
    },
  };
}

describe('local inference automatic rollback', () => {
  beforeEach(() => {
    summaryMock.mockReset();
    setControlMock.mockReset();
    ownerTargetMock.mockReset().mockReturnValue({ tenantId: 42, telegramId: 99 });
    safetyIncidentsMock.mockReset().mockReturnValue([]);
  });

  it('rolls back immediately for host pressure or sustained non-AI API regression', () => {
    summaryMock.mockReturnValue({
      ...summary(),
      operations: {
        ...summary().operations,
        locallyAttempted: 0,
        localRoutingDecisions: 0,
        cloudFallbackAttempts: 0,
        cloudFallbackReliabilityAttempts: 0,
        ordinaryChatOperations: 0,
        scriptOperations: 0,
      },
      latency: {
        ...summary().latency,
        ordinaryChatFirstTokenSampleCount: 19,
        ordinaryChatTotalSampleCount: 19,
        scriptThroughputSampleCount: 19,
        scriptJobDurationSampleCount: 19,
      },
      quality: { structuredRuns: 0, schemaValidityPercent: null, rejectionReasons: [] },
      host: {
        manifestAvailable: true,
        manifestVersionMatchesControl: true,
        modelDigestMatchesControl: true,
        profileVersionMatchesControl: true,
        runtimeContractMatchesControl: true,
        memoryAvailableBytes: 5 * 1024 ** 3,
        memoryHeadroomPass: false,
        swapUsedBytes: 4096,
        zeroSwapPass: false,
      },
      nonAiApiLatency: {
        currentSampleCount: 20,
        regressionPercent: 5.01,
      },
      endUserApiErrors: {
        currentSampleCount: 20,
        regressionPercentagePoints: 0.501,
      },
    });

    const result = evaluateLocalInferenceRollback(fakeDb as never);

    expect(result.rolledBack).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      `host_memory_available_${5 * 1024 ** 3}bytes`,
      'host_swap_used_4096bytes',
      'non_ai_api_p95_regression_5.01pct',
      'end_user_api_error_regression_0.501pp',
    ]));
  });

  it('atomically turns routing OFF when a meaningful window crosses operational thresholds', () => {
    summaryMock.mockReturnValue(summary());
    const result = evaluateLocalInferenceRollback(fakeDb as never);

    expect(result.rolledBack).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'local_success_94.00pct',
      'eligible_fallback_16.00pct',
      'cloud_fallback_success_98.00pct',
      'ordinary_chat_first_token_p95_13000ms',
      'ordinary_chat_total_p95_46000ms',
      'script_throughput_average_3.8tps',
      'script_job_p95_720001ms',
      'schema_validity_98.00pct',
    ]));
    expect(setControlMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'off',
      rolloutPercent: 0,
      updatedBy: 42,
      actorType: 'system_monitor',
    }), fakeDb);
  });

  it('does not roll back from undersized operational samples', () => {
    summaryMock.mockReturnValue({
      ...summary(),
      operations: {
        ...summary().operations,
        locallyAttempted: 19,
        localRoutingDecisions: 19,
        cloudFallbackAttempts: 19,
        cloudFallbackReliabilityAttempts: 19,
        ordinaryChatOperations: 19,
        scriptOperations: 9,
        completedScriptOperations: 9,
      },
      latency: {
        ...summary().latency,
        ordinaryChatFirstTokenSampleCount: 19,
        ordinaryChatTotalSampleCount: 19,
        scriptThroughputSampleCount: 19,
        scriptJobDurationSampleCount: 19,
      },
      quality: { structuredRuns: 99, schemaValidityPercent: 98, rejectionReasons: [] },
    });
    expect(evaluateLocalInferenceRollback(fakeDb as never)).toEqual({ rolledBack: false, reasons: [] });
    expect(setControlMock).not.toHaveBeenCalled();
  });

  it('uses the last durably authorized runtime actor when owner bootstrap is temporarily unavailable', () => {
    summaryMock.mockReturnValue(summary());
    ownerTargetMock.mockReturnValue(null);

    const result = evaluateLocalInferenceRollback(fakeDb as never);

    expect(result.rolledBack).toBe(true);
    expect(setControlMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'off',
      updatedBy: 37,
      actorType: 'system_monitor',
    }), fakeDb);
  });

  it('still disables routing when both owner bootstrap and durable actor attribution are unavailable', () => {
    summaryMock.mockReturnValue(summary());
    ownerTargetMock.mockReturnValue(null);
    const actorlessDb = {
      transaction: (callback: () => unknown) => ({ immediate: callback }),
      prepare: (sql: string) => ({
        get: () => sql.includes('SELECT mode') ? { mode: 'active' } : { updated_by: null },
      }),
    };

    expect(evaluateLocalInferenceRollback(actorlessDb as never)).toMatchObject({ rolledBack: true });
    expect(setControlMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'off',
      updatedBy: null,
      actorType: 'system_monitor',
    }), actorlessDb);
  });

  it('retains typed critical incident evidence as a backup rollback trigger', () => {
    summaryMock.mockReturnValue({
      ...summary(),
      operations: {
        ...summary().operations,
        locallyAttempted: 1,
        localRoutingDecisions: 1,
        cloudFallbackAttempts: 0,
        cloudFallbackReliabilityAttempts: 0,
        ordinaryChatOperations: 1,
        completedScriptOperations: 0,
      },
      latency: {
        ...summary().latency,
        ordinaryChatFirstTokenP95Ms: 1_000,
        ordinaryChatTotalP95Ms: 2_000,
        scriptThroughputAverageTokensPerSecond: null,
        scriptJobP95DurationMs: null,
        ordinaryChatFirstTokenSampleCount: 1,
        ordinaryChatTotalSampleCount: 1,
        scriptThroughputSampleCount: 0,
        scriptJobDurationSampleCount: 0,
      },
      quality: { structuredRuns: 1, schemaValidityPercent: 100, rejectionReasons: [] },
    });
    safetyIncidentsMock.mockReturnValue([{ code: 'tenant_isolation_escape', count: 1 }]);

    expect(evaluateLocalInferenceRollback(fakeDb as never)).toMatchObject({
      rolledBack: true,
      reasons: ['safety_incident_tenant_isolation_escape'],
    });
  });

  it('does not treat a successfully blocked cooking-safety response as an escaped safety failure', () => {
    summaryMock.mockReturnValue({
      ...summary(),
      operations: {
        ...summary().operations,
        locallyAttempted: 1,
        localRoutingDecisions: 1,
        cloudFallbackAttempts: 0,
        cloudFallbackReliabilityAttempts: 0,
        ordinaryChatOperations: 1,
        completedScriptOperations: 0,
      },
      latency: {
        ...summary().latency,
        ordinaryChatFirstTokenSampleCount: 1,
        ordinaryChatTotalSampleCount: 1,
        scriptThroughputSampleCount: 0,
        scriptJobDurationSampleCount: 0,
      },
      quality: {
        structuredRuns: 1,
        schemaValidityPercent: 100,
        rejectionReasons: [{ reason: 'cooking_safety_blocked', count: 1 }],
      },
    });

    expect(evaluateLocalInferenceRollback(fakeDb as never)).toEqual({ rolledBack: false, reasons: [] });
  });

  it('rolls back durable canary or active mode when the signed manifest is unavailable or drifts', () => {
    summaryMock.mockReturnValue({
      ...summary(),
      host: {
        ...summary().host,
        manifestAvailable: false,
        manifestVersionMatchesControl: false,
      },
    });
    expect(evaluateLocalInferenceRollback(fakeDb as never).reasons)
      .toContain('model_manifest_unavailable');

    setControlMock.mockReset();
    summaryMock.mockReturnValue({
      ...summary(),
      host: {
        ...summary().host,
        manifestAvailable: true,
        manifestVersionMatchesControl: false,
      },
    });
    expect(evaluateLocalInferenceRollback(fakeDb as never).reasons)
      .toContain('model_manifest_version_changed');

    setControlMock.mockReset();
    summaryMock.mockReturnValue({
      ...summary(),
      host: {
        ...summary().host,
        modelDigestMatchesControl: false,
        runtimeContractMatchesControl: false,
      },
    });
    expect(evaluateLocalInferenceRollback(fakeDb as never).reasons)
      .toContain('active_model_digest_changed');

    setControlMock.mockReset();
    summaryMock.mockReturnValue({
      ...summary(),
      host: {
        ...summary().host,
        profileVersionMatchesControl: false,
        runtimeContractMatchesControl: false,
      },
    });
    expect(evaluateLocalInferenceRollback(fakeDb as never).reasons)
      .toContain('skill_profile_version_changed');
  });

  it('rolls back after any observed specialist-profile or model-digest drift', () => {
    summaryMock.mockReturnValue({
      ...summary(),
      pricingProof: {
        profileVersionObservationCount: 30,
        profileVersionStablePass: false,
        modelDigestObservationCount: 30,
        modelDigestStablePass: false,
      },
    });

    expect(evaluateLocalInferenceRollback(fakeDb as never).reasons).toEqual(expect.arrayContaining([
      'skill_profile_version_changed',
      'model_digest_changed',
    ]));
  });
});
