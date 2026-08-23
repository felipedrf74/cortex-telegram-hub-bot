// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => db,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../src/services/plan-quotas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/plan-quotas')>()),
  resolveBillingPlanForUser: vi.fn(() => 'pro'),
}));

vi.mock('../../src/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/logger')>()),
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { _resetHybridKillSwitchCacheForTests, setHybridKillSwitch } from '../../src/services/hybrid-runtime-kill-switches';
import { getAiCreditWallet } from '../../src/services/ai-credit-ledger';
import {
  DEVICE_INFERENCE_POLICY_VERSION,
  expireStaleDeviceInferenceAdmissions,
  getDeviceInferencePolicy,
  recordZeroCreditDeviceInferenceEvidence,
  reserveDeviceInferenceAdmission,
  settleDeviceInferenceAdmission,
} from '../../src/services/device-inference-policy';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const DIGEST = 'a'.repeat(64);
const EVIDENCE = {
  osVersion: 'iOS 26.0',
  osBuild: '23A1',
  deviceModel: 'iPhone18,1',
  locale: 'pt-BR',
  frameworkAvailable: true,
  availabilityReason: 'available',
  durationMs: 321,
};

describe('device-inference-policy', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    process.env.APPLE_FOUNDATION_MODELS_ENABLED = 'false';
    process.env.APPLE_FOUNDATION_MODELS_KILL_SWITCH = 'false';
    process.env.APPLE_FOUNDATION_MODELS_ELIGIBLE_OPERATIONS = 'local_content_parse,local_content_summarize';
    process.env.HYBRID_AI_CREDITS_ENABLED = 'true';
    process.env.HYBRID_AI_CREDITS_KILL_SWITCH = 'false';
    _resetHybridKillSwitchCacheForTests();
  });

  afterEach(() => {
    db.close();
    delete process.env.APPLE_FOUNDATION_MODELS_ENABLED;
    delete process.env.APPLE_FOUNDATION_MODELS_KILL_SWITCH;
    delete process.env.APPLE_FOUNDATION_MODELS_ELIGIBLE_OPERATIONS;
    delete process.env.HYBRID_AI_CREDITS_ENABLED;
    delete process.env.HYBRID_AI_CREDITS_KILL_SWITCH;
  });

  it('is default off and never makes blocked classes device eligible', () => {
    const policy = getDeviceInferencePolicy(NOW);
    expect(policy.enabled).toBe(false);
    expect(policy.operations.every((operation) => !operation.eligible)).toBe(true);
    expect(policy.constraints).toMatchObject({
      toolsEnabled: false,
      blockedOperationClasses: expect.arrayContaining([
        'deep', 'standard_script', 'scheduled_script', 'priority_script', 'commerce',
      ]),
    });
  });

  it('exposes only the closed configured operations and honors the dedicated kill switch', () => {
    process.env.APPLE_FOUNDATION_MODELS_ENABLED = 'true';
    process.env.APPLE_FOUNDATION_MODELS_ELIGIBLE_OPERATIONS = 'local_content_summarize,unknown,deep';
    expect(getDeviceInferencePolicy(NOW).operations.filter((entry) => entry.eligible).map((entry) => entry.key))
      .toEqual(['local_content_summarize']);

    setHybridKillSwitch({
      controlKey: 'apple_foundation_models',
      engaged: true,
      actorUserId: 1,
      reason: 'test stop',
    });
    expect(getDeviceInferencePolicy(NOW).enabled).toBe(false);
  });

  it('reserves before standard device execution and captures exactly once with no content evidence', () => {
    process.env.APPLE_FOUNDATION_MODELS_ENABLED = 'true';
    process.env.APPLE_FOUNDATION_MODELS_ELIGIBLE_OPERATIONS = 'standard_response';
    const issued = reserveDeviceInferenceAdmission({
      tenantId: 40,
      userId: 40,
      deviceId: 'device-40',
      requestDigest: DIGEST,
      clientOperationId: 'device-op-1',
      now: NOW,
    });
    expect(issued.kind).toBe('issued');
    if (issued.kind !== 'issued') throw new Error('expected admission');
    expect(getAiCreditWallet(40, 'pro', NOW).reservedCredits).toBe(1);

    const settled = settleDeviceInferenceAdmission({
      admissionId: issued.admission.id,
      tenantId: 40,
      userId: 40,
      deviceId: 'device-40',
      outcome: 'completed',
      evidence: EVIDENCE,
      now: NOW,
    });
    expect(settled).toEqual({ kind: 'settled', state: 'completed' });
    expect(getAiCreditWallet(40, 'pro', NOW)).toMatchObject({
      reservedCredits: 0,
      dailyUsedCredits: 1,
    });
    expect(db.prepare('SELECT * FROM device_inference_evidence').all()).toHaveLength(1);
    expect(db.prepare('PRAGMA table_info(device_inference_evidence)').all()
      .map((column: any) => column.name)).not.toEqual(expect.arrayContaining(['prompt', 'output']));

    expect(settleDeviceInferenceAdmission({
      admissionId: issued.admission.id,
      tenantId: 40,
      userId: 40,
      deviceId: 'device-40',
      outcome: 'completed',
      evidence: EVIDENCE,
      now: NOW,
    })).toEqual({ kind: 'replay', state: 'completed' });
    expect(getAiCreditWallet(40, 'pro', NOW).dailyUsedCredits).toBe(1);

    const recoveredAfterLostSettlementReply = reserveDeviceInferenceAdmission({
      tenantId: 40,
      userId: 40,
      deviceId: 'device-40',
      requestDigest: DIGEST,
      clientOperationId: 'device-op-1',
      now: NOW,
    });
    expect(recoveredAfterLostSettlementReply).toMatchObject({
      kind: 'replay',
      admission: { id: issued.admission.id, state: 'completed' },
    });
    expect(getAiCreditWallet(40, 'pro', NOW).dailyUsedCredits).toBe(1);
  });

  it('releases the reservation on runtime fallback', () => {
    process.env.APPLE_FOUNDATION_MODELS_ENABLED = 'true';
    process.env.APPLE_FOUNDATION_MODELS_ELIGIBLE_OPERATIONS = 'standard_response';
    const issued = reserveDeviceInferenceAdmission({
      tenantId: 41,
      userId: 41,
      deviceId: 'device-41',
      requestDigest: DIGEST,
      clientOperationId: 'device-op-2',
      now: NOW,
    });
    if (issued.kind !== 'issued') throw new Error('expected admission');
    expect(settleDeviceInferenceAdmission({
      admissionId: issued.admission.id,
      tenantId: 41,
      userId: 41,
      deviceId: 'device-41',
      outcome: 'fallback',
      evidence: { ...EVIDENCE, frameworkAvailable: false, availabilityReason: 'modelNotReady' },
      now: NOW,
    })).toEqual({ kind: 'settled', state: 'released' });
    expect(getAiCreditWallet(41, 'pro', NOW)).toMatchObject({
      reservedCredits: 0,
      dailyUsedCredits: 0,
    });
  });

  it('expires a late device result without capture and records it as fallback evidence', () => {
    process.env.APPLE_FOUNDATION_MODELS_ENABLED = 'true';
    process.env.APPLE_FOUNDATION_MODELS_ELIGIBLE_OPERATIONS = 'standard_response';
    const issued = reserveDeviceInferenceAdmission({
      tenantId: 43,
      userId: 43,
      deviceId: 'device-43',
      requestDigest: DIGEST,
      clientOperationId: 'device-op-expired',
      now: NOW,
    });
    if (issued.kind !== 'issued') throw new Error('expected admission');
    const late = new Date(NOW.getTime() + 11 * 60 * 1_000);
    expect(settleDeviceInferenceAdmission({
      admissionId: issued.admission.id,
      tenantId: 43,
      userId: 43,
      deviceId: 'device-43',
      outcome: 'completed',
      evidence: EVIDENCE,
      now: late,
    })).toEqual({ kind: 'settled', state: 'expired' });
    expect(getAiCreditWallet(43, 'pro', late)).toMatchObject({
      reservedCredits: 0,
      dailyUsedCredits: 0,
    });
    expect(db.prepare('SELECT outcome FROM device_inference_evidence').get())
      .toEqual({ outcome: 'fallback' });
  });

  it('releases an abandoned device admission on its own TTL instead of the 24-hour generic sweep', () => {
    process.env.APPLE_FOUNDATION_MODELS_ENABLED = 'true';
    process.env.APPLE_FOUNDATION_MODELS_ELIGIBLE_OPERATIONS = 'standard_response';
    const issued = reserveDeviceInferenceAdmission({
      tenantId: 44,
      userId: 44,
      deviceId: 'device-44',
      requestDigest: DIGEST,
      clientOperationId: 'device-op-abandoned',
      now: NOW,
    });
    if (issued.kind !== 'issued') throw new Error('expected admission');

    const afterTtl = new Date(NOW.getTime() + 11 * 60 * 1_000);
    expect(expireStaleDeviceInferenceAdmissions(afterTtl)).toBe(1);
    expect(getAiCreditWallet(44, 'pro', afterTtl)).toMatchObject({
      reservedCredits: 0,
      dailyUsedCredits: 0,
    });
    expect(db.prepare('SELECT state FROM device_inference_admissions WHERE id = ?')
      .get(issued.admission.id)).toEqual({ state: 'expired' });
  });

  it('records zero-credit local evidence only under the current eligible policy', () => {
    process.env.APPLE_FOUNDATION_MODELS_ENABLED = 'true';
    expect(recordZeroCreditDeviceInferenceEvidence({
      tenantId: 42,
      userId: 42,
      deviceId: 'device-42',
      operationKey: 'local_content_summarize',
      policyVersion: DEVICE_INFERENCE_POLICY_VERSION,
      outcome: 'completed',
      evidence: EVIDENCE,
    })).toBe(true);
    expect(getAiCreditWallet(42, 'pro', NOW).dailyUsedCredits).toBe(0);
    expect(recordZeroCreditDeviceInferenceEvidence({
      tenantId: 42,
      userId: 42,
      deviceId: 'device-42',
      operationKey: 'local_content_parse',
      policyVersion: 'stale',
      outcome: 'completed',
      evidence: EVIDENCE,
    })).toBe(false);
  });
});
