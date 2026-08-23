// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Server-owned Apple Foundation Models routing policy (plan Addendum A).
 *
 * The client can execute only operation keys marked eligible here. Prompts and
 * outputs never enter this store. Credit-bearing execution receives a durable
 * server admission first; zero-credit parsing/summarization of already-local
 * content may execute directly and reports only non-content runtime evidence.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config';
import type { BillingPlan } from './plan-quotas';
import { resolveBillingPlanForUser } from './plan-quotas';
import { isAiCreditAdmissionEnabled } from './ai-credit-admission';
import {
  captureAiCreditReservation,
  releaseAiCreditReservation,
  reserveAiCredits,
} from './ai-credit-ledger';
import { ensureMonthlyAiCreditsForUser } from './ai-credit-provisioning';
import { getDb } from './database';
import { isAppleFoundationModelsActive } from './hybrid-runtime-kill-switches';

export const DEVICE_INFERENCE_POLICY_VERSION = 'apple-foundation-models.v1' as const;
export const DEVICE_INFERENCE_ADMISSION_TTL_MS = 10 * 60 * 1_000;

export type DeviceInferenceOperationKey =
  | 'standard_response'
  | 'local_content_parse'
  | 'local_content_summarize';

export type DeviceInferenceEvidenceOutcome = 'completed' | 'failed' | 'unavailable' | 'fallback';

interface DeviceInferenceOperationDefinition {
  key: DeviceInferenceOperationKey;
  creditBearing: boolean;
  creditOperationClass: 'standard' | null;
  localContentOnly: boolean;
  maxInputCharacters: number;
}

const DEVICE_OPERATION_DEFINITIONS: readonly DeviceInferenceOperationDefinition[] = Object.freeze([
  {
    key: 'standard_response',
    creditBearing: true,
    creditOperationClass: 'standard',
    localContentOnly: false,
    maxInputCharacters: 8_000,
  },
  {
    key: 'local_content_parse',
    creditBearing: false,
    creditOperationClass: null,
    localContentOnly: true,
    maxInputCharacters: 12_000,
  },
  {
    key: 'local_content_summarize',
    creditBearing: false,
    creditOperationClass: null,
    localContentOnly: true,
    maxInputCharacters: 12_000,
  },
]);

const DEVICE_OPERATION_KEYS = new Set<DeviceInferenceOperationKey>(
  DEVICE_OPERATION_DEFINITIONS.map((operation) => operation.key),
);

export interface DeviceInferencePolicy {
  policyVersion: typeof DEVICE_INFERENCE_POLICY_VERSION;
  enabled: boolean;
  expiresAt: string;
  minimumOSMajor: 26;
  framework: 'FoundationModels';
  model: 'SystemLanguageModel.default';
  operations: Array<DeviceInferenceOperationDefinition & { eligible: boolean }>;
  constraints: {
    toolsEnabled: false;
    serverFallbackRequired: true;
    blockedOperationClasses: readonly ['deep', 'standard_script', 'scheduled_script', 'priority_script', 'commerce'];
    evidenceContainsPromptOrOutput: false;
  };
}

function configuredEligibleOperations(): Set<DeviceInferenceOperationKey> {
  const eligible = new Set<DeviceInferenceOperationKey>();
  for (const raw of config.deviceInference.eligibleOperations.split(',')) {
    const key = raw.trim().toLowerCase() as DeviceInferenceOperationKey;
    if (DEVICE_OPERATION_KEYS.has(key)) eligible.add(key);
  }
  return eligible;
}

export function isDeviceInferenceOperationKey(value: unknown): value is DeviceInferenceOperationKey {
  return typeof value === 'string' && DEVICE_OPERATION_KEYS.has(value as DeviceInferenceOperationKey);
}

export function getDeviceInferencePolicy(now = new Date()): DeviceInferencePolicy {
  const enabled = isAppleFoundationModelsActive();
  const configured = configuredEligibleOperations();
  const creditAdmissionAvailable = isAiCreditAdmissionEnabled();
  return {
    policyVersion: DEVICE_INFERENCE_POLICY_VERSION,
    enabled,
    expiresAt: new Date(now.getTime() + 5 * 60 * 1_000).toISOString(),
    minimumOSMajor: 26,
    framework: 'FoundationModels',
    model: 'SystemLanguageModel.default',
    operations: DEVICE_OPERATION_DEFINITIONS.map((operation) => ({
      ...operation,
      eligible: enabled
        && configured.has(operation.key)
        && (!operation.creditBearing || creditAdmissionAvailable),
    })),
    constraints: {
      toolsEnabled: false,
      serverFallbackRequired: true,
      blockedOperationClasses: ['deep', 'standard_script', 'scheduled_script', 'priority_script', 'commerce'],
      evidenceContainsPromptOrOutput: false,
    },
  };
}

interface DeviceAdmissionRow {
  id: string;
  tenant_scope: string;
  user_id: number;
  device_id: string;
  operation_key: 'standard_response';
  request_digest: string;
  client_operation_id: string;
  policy_version: string;
  reservation_id: number;
  state: 'issued' | 'completed' | 'released' | 'expired';
  issued_at: string;
  expires_at: string;
  settled_at: string | null;
}

export interface DeviceInferenceAdmission {
  id: string;
  operationKey: 'standard_response';
  policyVersion: string;
  state: DeviceAdmissionRow['state'];
  issuedAt: string;
  expiresAt: string;
}

function mapAdmission(row: DeviceAdmissionRow): DeviceInferenceAdmission {
  return {
    id: row.id,
    operationKey: row.operation_key,
    policyVersion: row.policy_version,
    state: row.state,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

export type DeviceInferenceAdmissionResult =
  | { kind: 'issued' | 'replay'; admission: DeviceInferenceAdmission }
  | { kind: 'denied'; code: string; message: string; statusCode: number };

function denialFromCreditResult(
  result: Exclude<ReturnType<typeof reserveAiCredits>, { kind: 'reserved' | 'replay' }>,
): Extract<DeviceInferenceAdmissionResult, { kind: 'denied' }> {
  if (result.kind === 'operation_not_available') {
    return {
      kind: 'denied',
      code: 'DEVICE_OPERATION_NOT_AVAILABLE',
      message: `On-device standard responses are unavailable on the ${result.plan} plan.`,
      statusCode: 403,
    };
  }
  if (result.kind === 'daily_cap_exceeded') {
    return {
      kind: 'denied',
      code: 'AI_CREDIT_DAILY_CAP',
      message: `Daily AI credit cap reached: ${result.dailyRemainingCredits} credits remain.`,
      statusCode: 429,
    };
  }
  return {
    kind: 'denied',
    code: 'INSUFFICIENT_AI_CREDITS',
    message: `This operation needs ${result.requiredCredits} AI credit; ${result.availableCredits} are available.`,
    statusCode: 402,
  };
}

function getAdmissionByReplay(input: {
  tenantScope: string;
  userId: number;
  deviceId: string;
  requestDigest: string;
  clientOperationId: string;
}): DeviceAdmissionRow | undefined {
  return getDb().prepare(
    `SELECT * FROM device_inference_admissions
     WHERE tenant_scope = ? AND user_id = ? AND device_id = ?
       AND operation_key = 'standard_response' AND request_digest = ? AND client_operation_id = ?`,
  ).get(
    input.tenantScope,
    input.userId,
    input.deviceId,
    input.requestDigest,
    input.clientOperationId,
  ) as DeviceAdmissionRow | undefined;
}

export function reserveDeviceInferenceAdmission(input: {
  tenantId: number;
  userId: number;
  deviceId: string;
  requestDigest: string;
  clientOperationId: string;
  now?: Date;
}): DeviceInferenceAdmissionResult {
  const now = input.now ?? new Date();
  const policy = getDeviceInferencePolicy(now);
  const standard = policy.operations.find((operation) => operation.key === 'standard_response');
  if (!policy.enabled || standard?.eligible !== true) {
    return {
      kind: 'denied',
      code: 'DEVICE_INFERENCE_DISABLED',
      message: 'On-device standard responses are not enabled by the current server policy.',
      statusCode: 503,
    };
  }

  const tenantScope = String(input.tenantId);
  const existing = getAdmissionByReplay({ ...input, tenantScope });
  if (existing) {
    if ((existing.state === 'issued' && Date.parse(existing.expires_at) > now.getTime())
        || existing.state === 'completed') {
      return { kind: 'replay', admission: mapAdmission(existing) };
    }
    return {
      kind: 'denied',
      code: 'DEVICE_ADMISSION_SETTLED',
      message: `This device operation is already ${existing.state}; use a new client operation id.`,
      statusCode: 409,
    };
  }

  const plan: BillingPlan = resolveBillingPlanForUser(input.userId);
  ensureMonthlyAiCreditsForUser({ userId: input.userId, plan, now });
  const reserved = reserveAiCredits({
    userId: input.userId,
    plan,
    operationClass: 'standard',
    replayScope: {
      tenantScope,
      workload: 'apple_foundation_models',
      requestHash: input.requestDigest,
      clientOperationId: input.clientOperationId,
    },
    now,
  });
  if (reserved.kind !== 'reserved' && reserved.kind !== 'replay') {
    return denialFromCreditResult(reserved);
  }
  if (reserved.kind === 'replay' && reserved.reservation.state !== 'reserved') {
    return {
      kind: 'denied',
      code: 'DEVICE_ADMISSION_SETTLED',
      message: `This device operation is already ${reserved.reservation.state}.`,
      statusCode: 409,
    };
  }

  const admissionId = randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + DEVICE_INFERENCE_ADMISSION_TTL_MS).toISOString();
  try {
    getDb().prepare(
      `INSERT INTO device_inference_admissions (
         id, tenant_scope, user_id, device_id, operation_key, request_digest,
         client_operation_id, policy_version, reservation_id, state, issued_at, expires_at
       ) VALUES (?, ?, ?, ?, 'standard_response', ?, ?, ?, ?, 'issued', ?, ?)`,
    ).run(
      admissionId,
      tenantScope,
      input.userId,
      input.deviceId,
      input.requestDigest,
      input.clientOperationId,
      DEVICE_INFERENCE_POLICY_VERSION,
      reserved.reservation.id,
      issuedAt,
      expiresAt,
    );
  } catch (error) {
    const replay = getAdmissionByReplay({ ...input, tenantScope });
    if (replay) return { kind: 'replay', admission: mapAdmission(replay) };
    if (reserved.kind === 'reserved') {
      releaseAiCreditReservation({ reservationId: reserved.reservation.id, now });
    }
    throw error;
  }
  return {
    kind: 'issued',
    admission: {
      id: admissionId,
      operationKey: 'standard_response',
      policyVersion: DEVICE_INFERENCE_POLICY_VERSION,
      state: 'issued',
      issuedAt,
      expiresAt,
    },
  };
}

export interface DeviceInferenceEvidenceInput {
  osVersion: string;
  osBuild: string;
  deviceModel: string;
  locale: string;
  frameworkAvailable: boolean;
  availabilityReason?: string | null;
  durationMs?: number | null;
}

function bounded(value: string, max: number): string {
  return value.replace(/[\r\n\t]/gu, ' ').trim().slice(0, max);
}

function insertEvidence(input: {
  admissionId?: string | null;
  tenantId: number;
  userId: number;
  deviceId: string;
  operationKey: DeviceInferenceOperationKey;
  policyVersion: string;
  outcome: DeviceInferenceEvidenceOutcome;
  evidence: DeviceInferenceEvidenceInput;
}): void {
  getDb().prepare(
    `INSERT OR IGNORE INTO device_inference_evidence (
       admission_id, tenant_scope, user_id, device_id, operation_key, policy_version,
       outcome, os_version, os_build, device_model, locale, framework_available,
       availability_reason, duration_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.admissionId ?? null,
    String(input.tenantId),
    input.userId,
    bounded(input.deviceId, 200),
    input.operationKey,
    input.policyVersion,
    input.outcome,
    bounded(input.evidence.osVersion, 100),
    bounded(input.evidence.osBuild, 100),
    bounded(input.evidence.deviceModel, 200),
    bounded(input.evidence.locale, 100),
    input.evidence.frameworkAvailable ? 1 : 0,
    input.evidence.availabilityReason
      ? bounded(input.evidence.availabilityReason, 200)
      : null,
    input.evidence.durationMs ?? null,
  );
}

export type DeviceInferenceSettlementResult =
  | { kind: 'settled' | 'replay'; state: 'completed' | 'released' | 'expired' }
  | { kind: 'not_found' };

export function settleDeviceInferenceAdmission(input: {
  admissionId: string;
  tenantId: number;
  userId: number;
  deviceId: string;
  outcome: DeviceInferenceEvidenceOutcome;
  evidence: DeviceInferenceEvidenceInput;
  now?: Date;
}): DeviceInferenceSettlementResult {
  const db = getDb();
  const now = input.now ?? new Date();
  const tx = db.transaction((): DeviceInferenceSettlementResult => {
    const row = db.prepare(
      `SELECT * FROM device_inference_admissions
       WHERE id = ? AND tenant_scope = ? AND user_id = ? AND device_id = ?`,
    ).get(input.admissionId, String(input.tenantId), input.userId, input.deviceId) as DeviceAdmissionRow | undefined;
    if (!row) return { kind: 'not_found' };
    if (row.state !== 'issued') {
      return { kind: 'replay', state: row.state === 'completed' ? 'completed' : row.state };
    }

    const admissionExpired = Date.parse(row.expires_at) <= now.getTime();
    const completed = input.outcome === 'completed' && !admissionExpired;
    const settlement = completed
      ? captureAiCreditReservation({
          reservationId: row.reservation_id,
          resultRef: `device:${row.id}`,
          now,
        })
      : releaseAiCreditReservation({ reservationId: row.reservation_id, now });
    const settledState: 'completed' | 'released' | 'expired' = admissionExpired
      ? 'expired'
      : completed
        ? (settlement.kind === 'captured'
            || (settlement.kind === 'invalid_state' && settlement.state === 'captured')
          ? 'completed'
          : 'expired')
        : (settlement.kind === 'invalid_state' && settlement.state === 'captured')
          ? 'completed'
          : 'released';

    const changed = db.prepare(
      `UPDATE device_inference_admissions SET state = ?, settled_at = ?
       WHERE id = ? AND state = 'issued'`,
    ).run(settledState, now.toISOString(), row.id);
    if (changed.changes !== 1) {
      throw new Error('device-inference: admission settlement lost its immediate transaction');
    }
    insertEvidence({
      admissionId: row.id,
      tenantId: input.tenantId,
      userId: input.userId,
      deviceId: input.deviceId,
      operationKey: row.operation_key,
      policyVersion: row.policy_version,
      outcome: admissionExpired ? 'fallback' : input.outcome,
      evidence: input.evidence,
    });
    return { kind: 'settled', state: settledState };
  });
  return tx.immediate();
}

/** Release device reservations whose short-lived admission can no longer run. */
export function expireStaleDeviceInferenceAdmissions(
  now = new Date(),
  limit = 200,
): number {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, reservation_id
       FROM device_inference_admissions
      WHERE state = 'issued' AND expires_at <= ?
      ORDER BY expires_at, id
      LIMIT ?`,
  ).all(now.toISOString(), Math.max(1, Math.min(1_000, Math.floor(limit)))) as Array<{
    id: string;
    reservation_id: number;
  }>;
  let expired = 0;
  for (const row of rows) {
    const settlement = releaseAiCreditReservation({ reservationId: row.reservation_id, now });
    const state = settlement.kind === 'invalid_state' && settlement.state === 'captured'
      ? 'completed'
      : 'expired';
    expired += db.prepare(
      `UPDATE device_inference_admissions
          SET state = ?, settled_at = ?
        WHERE id = ? AND state = 'issued'`,
    ).run(state, now.toISOString(), row.id).changes;
  }
  return expired;
}

/** Non-content runtime identity evidence for zero-credit local convenience. */
export function recordZeroCreditDeviceInferenceEvidence(input: {
  tenantId: number;
  userId: number;
  deviceId: string;
  operationKey: 'local_content_parse' | 'local_content_summarize';
  policyVersion: string;
  outcome: DeviceInferenceEvidenceOutcome;
  evidence: DeviceInferenceEvidenceInput;
}): boolean {
  const policy = getDeviceInferencePolicy();
  const operation = policy.operations.find((entry) => entry.key === input.operationKey);
  if (!policy.enabled || policy.policyVersion !== input.policyVersion || operation?.eligible !== true) {
    return false;
  }
  insertEvidence({ ...input });
  return true;
}
