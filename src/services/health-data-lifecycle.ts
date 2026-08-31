// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  recordHealthSignal,
  type EnergyAvailabilityRisk,
  type HealthConsentScope,
  type HealthSignalRow,
  type InjuryStatus,
} from './health-signals';
import {
  deleteAllHealthDataForUser,
  CONSENT_EXPLANATIONS,
  type HealthDataDeletionResult,
} from './health-consent';
import {
  deriveSafetyTriggerFromSignal,
  wireHealthSignalToSafety,
  type WireHealthSignalOutput,
} from './coach-kernel/safety-wiring';
import { publishSafetyRedFlag } from './training-signals';
import { requireTenantIdParam } from './tenant-scope';
import { stableTrainingRevisionHash } from './training-plan-revision-candidate-builder';

export const HEALTH_DATA_LIFECYCLE_SCHEMA = 'health-data-lifecycle.v1' as const;
export const HEALTH_SENSITIVE_RETENTION_DAYS = 365;
export const HEALTH_INPUT_SYMPTOM_CODES = [
  'chest_pain',
  'fainting',
  'severe_dizziness',
  'fever',
  'cough',
  'congestion',
  'sore_throat',
  'fatigue',
  'gi_distress',
  'shortness_of_breath',
  'body_aches',
  'acute_injury',
  'worsening_pain',
] as const;
export type HealthInputSymptomCode = typeof HEALTH_INPUT_SYMPTOM_CODES[number];

const PUBLIC_HEALTH_SCOPES = ['pain', 'illness', 'injury', 'red_s_screening'] as const;
const PUBLIC_SCOPE_SET = new Set<string>(PUBLIC_HEALTH_SCOPES);
const SYMPTOM_SET = new Set<string>(HEALTH_INPUT_SYMPTOM_CODES);
const INJURY_SET = new Set<string>([
  'none', 'acute', 'chronic_managed', 'returning', 'post_exertional_symptom_risk',
]);
const ENERGY_SET = new Set<string>(['low', 'moderate', 'high']);

export class HealthDataLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface HealthSafetyDisposition {
  state: 'clear' | 'review' | 'pause_hard_training';
  triggerType: string | null;
  reasonCodes: string[];
  explanation: string;
}

export interface StructuredHealthSignal {
  date: string;
  painScore?: number;
  painLocation?: string;
  illnessSymptoms?: HealthInputSymptomCode[];
  injuryStatus?: InjuryStatus;
  energyAvailabilityRisk?: EnergyAvailabilityRisk;
  consentScope: HealthConsentScope[];
  source: 'structured_intake';
}

export interface StructuredHealthIntakeResource {
  schemaVersion: typeof HEALTH_DATA_LIFECYCLE_SCHEMA;
  id: number;
  version: number;
  signal: StructuredHealthSignal;
  safetyDisposition: HealthSafetyDisposition;
  correctionCount: number;
  latestCorrectionId: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface HealthConsentResource {
  schemaVersion: typeof HEALTH_DATA_LIFECYCLE_SCHEMA;
  state: 'not_granted' | 'active' | 'withdrawn';
  revision: number;
  activeScopes: HealthConsentScope[];
  withdrawn: boolean;
  explanations: Partial<Record<HealthConsentScope, string>>;
  createdAt: string | null;
  etag: string;
}

interface ConsentRow {
  revision: number;
  active_scopes_json: string;
  withdrawn: number;
  created_at: string;
  request_hash: string;
}

interface CorrectionRow {
  id: number;
  signal_id: number;
  effective_signal_json: string;
  safety_disposition_json: string;
  idempotency_key: string;
  request_hash: string;
  created_at: string;
}

interface HealthMutationReceiptRow {
  operation: 'create_intake' | 'delete_one' | 'delete_all';
  request_hash: string;
  response_json: string;
}

export interface StructuredHealthDeleteResult {
  signalId: number;
  version: number;
  deleted: true;
  replayed: boolean;
}

export type StructuredHealthDeleteAllResult = HealthDataDeletionResult & { replayed: boolean };

export function validateStructuredHealthInput(input: Record<string, unknown>, options: { correction?: boolean } = {}): StructuredHealthSignal {
  if (Object.prototype.hasOwnProperty.call(input, 'menstrualStatus')) {
    throw new HealthDataLifecycleError(
      'MENSTRUAL_COLLECTION_UNAVAILABLE',
      'New menstrual data is not collected in this release.',
      422,
    );
  }
  const date = typeof input.date === 'string' ? input.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new HealthDataLifecycleError('BAD_DATE', 'date must be a valid YYYY-MM-DD calendar date.');
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== date) {
    throw new HealthDataLifecycleError('BAD_DATE', 'date must be a valid YYYY-MM-DD calendar date.');
  }
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const oldest = new Date(today.getTime() - HEALTH_SENSITIVE_RETENTION_DAYS * 86_400_000);
  if (parsed > today) throw new HealthDataLifecycleError('FUTURE_HEALTH_INPUT', 'Health intake date cannot be in the future.');
  if (parsed <= oldest) throw new HealthDataLifecycleError('EXPIRED_HEALTH_INPUT', 'Health intake is outside the 365-day retention window.', 410);

  let painScore: number | undefined;
  if (input.painScore !== undefined && input.painScore !== null) {
    if (!Number.isInteger(input.painScore) || Number(input.painScore) < 0 || Number(input.painScore) > 10) {
      throw new HealthDataLifecycleError('BAD_PAIN_SCORE', 'painScore must be an integer from 0 through 10.');
    }
    painScore = Number(input.painScore);
  }
  const painLocation = typeof input.painLocation === 'string' && input.painLocation.trim()
    ? boundedText(input.painLocation, 80, 'painLocation')
    : undefined;
  const rawSymptoms = Array.isArray(input.illnessSymptoms) ? input.illnessSymptoms : [];
  if (rawSymptoms.length > 12 || rawSymptoms.some((value) => typeof value !== 'string' || !SYMPTOM_SET.has(value))) {
    throw new HealthDataLifecycleError('BAD_SYMPTOM_CODE', 'illnessSymptoms contains an unsupported symptom code.');
  }
  const illnessSymptoms = [...new Set(rawSymptoms as HealthInputSymptomCode[])];
  const injuryStatus = typeof input.injuryStatus === 'string'
    ? input.injuryStatus
    : undefined;
  if (injuryStatus !== undefined && !INJURY_SET.has(injuryStatus)) {
    throw new HealthDataLifecycleError('BAD_INJURY_STATUS', 'injuryStatus is not supported.');
  }
  const energyAvailabilityRisk = typeof input.energyAvailabilityRisk === 'string'
    ? input.energyAvailabilityRisk
    : undefined;
  if (energyAvailabilityRisk !== undefined && !ENERGY_SET.has(energyAvailabilityRisk)) {
    throw new HealthDataLifecycleError('BAD_ENERGY_RISK', 'energyAvailabilityRisk is not supported.');
  }
  const rawScopes = Array.isArray(input.consentScope) ? input.consentScope : [];
  if (rawScopes.length === 0 || rawScopes.some((value) => typeof value !== 'string' || !PUBLIC_SCOPE_SET.has(value))) {
    throw new HealthDataLifecycleError(
      'CONSENT_REQUIRED',
      'consentScope must explicitly include at least one supported health scope.',
      428,
    );
  }
  const consentScope = [...new Set(rawScopes as HealthConsentScope[])];
  if (painScore !== undefined || painLocation !== undefined) requireScope(consentScope, 'pain');
  if (illnessSymptoms.length > 0) requireScope(consentScope, 'illness');
  if (injuryStatus !== undefined) requireScope(consentScope, 'injury');
  if (energyAvailabilityRisk !== undefined) requireScope(consentScope, 'red_s_screening');
  if (
    painScore === undefined && painLocation === undefined && illnessSymptoms.length === 0
    && injuryStatus === undefined && energyAvailabilityRisk === undefined
  ) {
    throw new HealthDataLifecycleError('EMPTY_HEALTH_INPUT', options.correction
      ? 'Correction must retain at least one health fact.'
      : 'Structured intake must contain at least one health fact.');
  }
  return {
    date,
    ...(painScore !== undefined ? { painScore } : {}),
    ...(painLocation !== undefined ? { painLocation } : {}),
    ...(illnessSymptoms.length > 0 ? { illnessSymptoms } : {}),
    ...(injuryStatus !== undefined ? { injuryStatus: injuryStatus as InjuryStatus } : {}),
    ...(energyAvailabilityRisk !== undefined ? { energyAvailabilityRisk: energyAvailabilityRisk as EnergyAvailabilityRisk } : {}),
    consentScope,
    source: 'structured_intake',
  };
}

export function recordStructuredHealthIntake(input: {
  tenantId: number;
  userId: number;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  expiresAt?: string;
  db?: Database.Database;
}): { intake: StructuredHealthIntakeResource; replayed: boolean } {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'recordStructuredHealthIntake');
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const signal = validateStructuredHealthInput(input.payload);
  const expiresAt = resolveExpiresAt(signal.date, input.expiresAt);
  const requestHash = stableTrainingRevisionHash({ signal, expiresAt });
  const replay = findHealthMutationReceipt(db, tenantId, input.userId, idempotencyKey);
  if (replay) {
    assertHealthMutationReceiptMatch(replay, 'create_intake', requestHash);
    const intake = parseJson<StructuredHealthIntakeResource | null>(replay.response_json, null);
    if (!intake) {
      throw new HealthDataLifecycleError(
        'HEALTH_MUTATION_RECEIPT_INVALID',
        'Stored health intake receipt is invalid.',
        500,
      );
    }
    return { intake, replayed: true };
  }

  let signalId = 0;
  let intake!: StructuredHealthIntakeResource;
  const txn = db.transaction(() => {
    purgeExpiredHealthData(input.userId, tenantId, db);
    ensureConsentIncludes({
      tenantId,
      userId: input.userId,
      scopes: signal.consentScope,
      idempotencyKey: `intake-consent:${idempotencyKey}`,
      db,
    });
    const created = recordHealthSignal({
      userId: input.userId,
      tenantId,
      date: signal.date,
      painScore: signal.painScore,
      painLocation: signal.painLocation,
      illnessSymptoms: signal.illnessSymptoms,
      injuryStatus: signal.injuryStatus,
      energyAvailabilityRisk: signal.energyAvailabilityRisk,
      source: 'structured_intake',
      consentScope: signal.consentScope,
      publishSafetySignal: false,
      db,
    });
    signalId = created.id;
    db.prepare(`
      UPDATE athlete_health_signals
      SET expires_at = ?, idempotency_key = ?, request_hash = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).run(expiresAt, idempotencyKey, requestHash, signalId, tenantId, input.userId);
    recomputeHealthSafetyState(input.userId, tenantId, db);
    intake = requireIntakeResource(db, tenantId, input.userId, signalId);
    insertHealthMutationReceipt({
      db,
      tenantId,
      userId: input.userId,
      operation: 'create_intake',
      signalId,
      idempotencyKey,
      requestHash,
      response: intake,
    });
  });
  txn();
  return { intake, replayed: false };
}

export function listStructuredHealthIntakes(input: {
  tenantId: number;
  userId: number;
  limit?: number;
  db?: Database.Database;
}): StructuredHealthIntakeResource[] {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'listStructuredHealthIntakes');
  purgeExpiredHealthData(input.userId, tenantId, db);
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const rows = db.prepare(`
    SELECT id FROM athlete_health_signals
    WHERE tenant_id = ? AND user_id = ? AND source = 'structured_intake'
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
      AND date > date('now', '-365 days')
    ORDER BY date DESC, id DESC
    LIMIT ?
  `).all(tenantId, input.userId, limit) as Array<{ id: number }>;
  return rows.map((row) => requireIntakeResource(db, tenantId, input.userId, row.id));
}

export function appendStructuredHealthCorrection(input: {
  tenantId: number;
  userId: number;
  signalId: number;
  patch: Record<string, unknown>;
  reason: string;
  idempotencyKey: string;
  expectedVersion: number;
  db?: Database.Database;
}): { intake: StructuredHealthIntakeResource; correctionId: number; replayed: boolean } {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'appendStructuredHealthCorrection');
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const expectedVersion = requireExpectedIntakeVersion(input.expectedVersion);
  const reason = boundedText(input.reason, 240, 'reason');
  const requestHash = stableTrainingRevisionHash({
    operation: 'append_structured_health_correction',
    signalId: input.signalId,
    expectedVersion,
    patch: input.patch,
    reason,
  });
  const replay = db.prepare(`
    SELECT * FROM athlete_health_signal_corrections
    WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
  `).get(tenantId, input.userId, idempotencyKey) as CorrectionRow | undefined;
  if (replay) {
    if (replay.request_hash !== requestHash) {
      throw new HealthDataLifecycleError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key belongs to a different health correction.', 409);
    }
    return {
      intake: requireIntakeResource(db, tenantId, input.userId, input.signalId),
      correctionId: replay.id,
      replayed: true,
    };
  }
  const source = requireSignalRow(db, tenantId, input.userId, input.signalId);
  if (source.expires_at && Date.parse(source.expires_at) <= Date.now()) {
    throw new HealthDataLifecycleError('HEALTH_INTAKE_EXPIRED', 'Health intake is outside active retention.', 410);
  }
  const currentResource = requireIntakeResource(db, tenantId, input.userId, input.signalId);
  if (currentResource.version !== expectedVersion) {
    throw new HealthDataLifecycleError(
      'HEALTH_INTAKE_VERSION_CONFLICT',
      'Health intake version does not match expectedVersion.',
      412,
    );
  }
  const current = effectiveSignalForRow(db, source);
  const merged = mergeCorrection(current, input.patch);
  const effective = validateStructuredHealthInput(merged, { correction: true });
  const safety = deriveHealthSafetyDisposition(effective);
  let correctionId = 0;
  const txn = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT INTO athlete_health_signal_corrections (
        signal_id, tenant_id, user_id, correction_json, effective_signal_json,
        safety_disposition_json, reason, idempotency_key, request_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.signalId,
      tenantId,
      input.userId,
      JSON.stringify(input.patch),
      JSON.stringify(effective),
      JSON.stringify(safety),
      reason,
      idempotencyKey,
      requestHash,
    );
    correctionId = Number(inserted.lastInsertRowid);
    recomputeHealthSafetyState(input.userId, tenantId, db);
  });
  txn();
  return {
    intake: requireIntakeResource(db, tenantId, input.userId, input.signalId),
    correctionId,
    replayed: false,
  };
}

export function deleteStructuredHealthIntake(input: {
  tenantId: number;
  userId: number;
  signalId: number;
  expectedVersion: number;
  idempotencyKey: string;
  db?: Database.Database;
}): StructuredHealthDeleteResult {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'deleteStructuredHealthIntake');
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const expectedVersion = requireExpectedIntakeVersion(input.expectedVersion);
  const requestHash = stableTrainingRevisionHash({
    operation: 'delete_structured_health_intake',
    signalId: input.signalId,
    expectedVersion,
  });
  const receipt = findHealthMutationReceipt(db, tenantId, input.userId, idempotencyKey);
  if (receipt) {
    assertHealthMutationReceiptMatch(receipt, 'delete_one', requestHash);
    const stored = parseJson<Omit<StructuredHealthDeleteResult, 'replayed'>>(receipt.response_json, {
      signalId: input.signalId,
      version: expectedVersion,
      deleted: true,
    });
    return { ...stored, replayed: true };
  }

  const resource = requireIntakeResource(db, tenantId, input.userId, input.signalId);
  if (resource.version !== expectedVersion) {
    throw new HealthDataLifecycleError(
      'HEALTH_INTAKE_VERSION_CONFLICT',
      'Health intake version does not match expectedVersion.',
      412,
    );
  }
  const response = { signalId: input.signalId, version: resource.version, deleted: true as const };
  db.transaction(() => {
    db.prepare(`
      DELETE FROM athlete_health_signal_corrections
      WHERE signal_id = ? AND tenant_id = ? AND user_id = ?
    `).run(input.signalId, tenantId, input.userId);
    const result = db.prepare(`
      DELETE FROM athlete_health_signals
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND source = 'structured_intake'
    `).run(input.signalId, tenantId, input.userId);
    if (result.changes !== 1) {
      throw new HealthDataLifecycleError(
        'HEALTH_INTAKE_VERSION_CONFLICT',
        'Health intake changed before deletion could be applied.',
        412,
      );
    }
    recomputeHealthSafetyState(input.userId, tenantId, db);
    insertHealthMutationReceipt({
      db,
      tenantId,
      userId: input.userId,
      operation: 'delete_one',
      signalId: input.signalId,
      idempotencyKey,
      requestHash,
      response: response,
    });
  })();
  return { ...response, replayed: false };
}

export function deleteAllStructuredHealthData(input: {
  tenantId: number;
  userId: number;
  idempotencyKey: string;
  db?: Database.Database;
}): StructuredHealthDeleteAllResult {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'deleteAllStructuredHealthData');
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = stableTrainingRevisionHash({ operation: 'delete_all_structured_health_data' });
  const receipt = findHealthMutationReceipt(db, tenantId, input.userId, idempotencyKey);
  if (receipt) {
    assertHealthMutationReceiptMatch(receipt, 'delete_all', requestHash);
    const stored = parseJson<HealthDataDeletionResult | null>(receipt.response_json, null);
    if (!stored) {
      throw new HealthDataLifecycleError('HEALTH_MUTATION_RECEIPT_INVALID', 'Stored health deletion receipt is invalid.', 500);
    }
    return { ...stored, replayed: true };
  }

  let result!: HealthDataDeletionResult;
  db.transaction(() => {
    result = deleteAllHealthDataForUser(input.userId, tenantId, db);
    db.prepare('DELETE FROM training_health_safety_state WHERE tenant_id = ? AND user_id = ?')
      .run(tenantId, input.userId);
    reconcileSafetyRedFlagSignals(db, input.userId, tenantId, null);
    insertHealthMutationReceipt({
      db,
      tenantId,
      userId: input.userId,
      operation: 'delete_all',
      signalId: null,
      idempotencyKey,
      requestHash,
      response: result,
    });
  })();
  return { ...result, replayed: false };
}

export function getHealthConsent(input: {
  tenantId: number;
  userId: number;
  db?: Database.Database;
}): HealthConsentResource {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'getHealthConsent');
  const row = latestConsentRow(db, tenantId, input.userId);
  return consentResource(row);
}

export function reviseHealthConsent(input: {
  tenantId: number;
  userId: number;
  activeScopes: readonly string[];
  withdraw?: boolean;
  expectedRevision: number;
  idempotencyKey: string;
  reason?: string;
  db?: Database.Database;
}): { consent: HealthConsentResource; replayed: boolean } {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'reviseHealthConsent');
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const activeScopes = normalizePublicScopes(input.withdraw ? [] : input.activeScopes);
  const requestHash = stableTrainingRevisionHash({ activeScopes, withdraw: input.withdraw === true, expectedRevision: input.expectedRevision });
  const replay = db.prepare(`
    SELECT revision, active_scopes_json, withdrawn, created_at, request_hash
    FROM health_data_consent_revisions
    WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
  `).get(tenantId, input.userId, idempotencyKey) as ConsentRow | undefined;
  if (replay) {
    if (replay.request_hash !== requestHash) {
      throw new HealthDataLifecycleError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key belongs to another consent revision.', 409);
    }
    return { consent: consentResource(replay), replayed: true };
  }
  if (!input.withdraw && activeScopes.length === 0) {
    throw new HealthDataLifecycleError(
      'CONSENT_WITHDRAWAL_REQUIRED',
      'Use withdraw=true to remove all health consent scopes.',
      422,
    );
  }
  const current = latestConsentRow(db, tenantId, input.userId);
  const currentRevision = current?.revision ?? 0;
  if (input.expectedRevision !== currentRevision) {
    throw new HealthDataLifecycleError('CONSENT_VERSION_CONFLICT', 'Consent revision does not match If-Match.', 412);
  }
  const nextRevision = currentRevision + 1;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO health_data_consent_revisions (
        tenant_id, user_id, revision, active_scopes_json, withdrawn,
        reason, idempotency_key, request_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      input.userId,
      nextRevision,
      JSON.stringify(activeScopes),
      input.withdraw ? 1 : 0,
      input.reason ? boundedText(input.reason, 240, 'reason') : null,
      idempotencyKey,
      requestHash,
    );
    recomputeHealthSafetyState(input.userId, tenantId, db);
  })();
  return { consent: getHealthConsent({ tenantId, userId: input.userId, db }), replayed: false };
}

export function exportHealthData(input: {
  tenantId: number;
  userId: number;
  db?: Database.Database;
}): Record<string, unknown> {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'exportHealthData');
  const signals = db.prepare(`
    SELECT * FROM athlete_health_signals WHERE tenant_id = ? AND user_id = ? ORDER BY id
  `).all(tenantId, input.userId);
  const corrections = db.prepare(`
    SELECT * FROM athlete_health_signal_corrections WHERE tenant_id = ? AND user_id = ? ORDER BY id
  `).all(tenantId, input.userId);
  const consentRevisions = db.prepare(`
    SELECT revision, active_scopes_json, withdrawn, reason, created_at
    FROM health_data_consent_revisions WHERE tenant_id = ? AND user_id = ? ORDER BY revision
  `).all(tenantId, input.userId);
  const safetyState = db.prepare(`
    SELECT disposition, trigger_type, version, evaluated_at
    FROM training_health_safety_state WHERE tenant_id = ? AND user_id = ?
  `).get(tenantId, input.userId) ?? null;
  return {
    schemaVersion: HEALTH_DATA_LIFECYCLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    retentionDays: HEALTH_SENSITIVE_RETENTION_DAYS,
    signals,
    corrections,
    consentRevisions,
    safetyState,
  };
}

export function deriveHealthSafetyDisposition(signal: StructuredHealthSignal): HealthSafetyDisposition {
  const trigger = deriveSafetyTriggerFromSignal(signal);
  const output = wireHealthSignalToSafety({
    signal: {
      ...signal,
      capturedAt: `${signal.date}T00:00:00.000Z`,
    },
    source: trigger.source,
    triggerType: trigger.triggerType,
  });
  const state = output.effectiveSeverity === 'block'
    ? 'pause_hard_training'
    : output.effectiveSeverity === 'warning'
      ? 'review'
      : 'clear';
  return {
    state,
    triggerType: trigger.triggerType ?? null,
    reasonCodes: [...new Set(output.decisionReasons.map((reason) => reason.code))],
    explanation: state === 'pause_hard_training'
      ? 'Training safety is paused pending qualified professional review.'
      : state === 'review'
        ? 'The coach will use this report conservatively and show the reason before suggesting a change.'
        : 'No training safety pause is currently derived from this report.',
  };
}

/**
 * Canonical coaching read. It returns only the latest corrected signal chosen
 * by the server-owned safety state after current consent has been applied.
 * Raw signal rows must not authorize plan safety behavior.
 */
export function getEffectiveHealthSafetyOutput(input: {
  tenantId: number;
  userId: number;
  affectedDate?: string;
  maxAgeDays?: number;
  db?: Database.Database;
}): WireHealthSignalOutput | undefined {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'getEffectiveHealthSafetyOutput');
  const state = db.prepare(`
    SELECT source_signal_id AS signalId
      FROM training_health_safety_state
     WHERE tenant_id = ? AND user_id = ?
  `).get(tenantId, input.userId) as { signalId: number | null } | undefined;
  if (!state?.signalId) return undefined;
  const row = db.prepare(`
    SELECT * FROM athlete_health_signals
     WHERE id = ? AND tenant_id = ? AND user_id = ?
       AND source = 'structured_intake'
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
       AND date > date('now', '-365 days')
  `).get(state.signalId, tenantId, input.userId) as HealthSignalRow | undefined;
  if (!row) return undefined;
  const asOfDate = (input.affectedDate ?? new Date().toISOString()).slice(0, 10);
  if (row.date > asOfDate) return undefined;
  const maxAgeDays = Math.min(365, Math.max(1, Math.floor(input.maxAgeDays ?? 365)));
  const cutoff = new Date(Date.parse(`${asOfDate}T00:00:00.000Z`) - maxAgeDays * 86_400_000)
    .toISOString().slice(0, 10);
  if (row.date <= cutoff) return undefined;
  const consent = getHealthConsent({ tenantId, userId: input.userId, db });
  const effective = filterSignalByActiveConsent(
    effectiveSignalForRow(db, row),
    new Set(consent.withdrawn ? [] : consent.activeScopes),
  );
  if (!effective) return undefined;
  const trigger = deriveSafetyTriggerFromSignal(effective);
  return wireHealthSignalToSafety({
    signal: { ...effective, capturedAt: `${effective.date}T00:00:00.000Z` },
    source: trigger.source,
    triggerType: trigger.triggerType,
    affectedDate: input.affectedDate,
  });
}

export function purgeExpiredHealthData(userId: number, tenantId: number, db: Database.Database = getDb()): number {
  const scopedTenant = requireTenantIdParam(tenantId, 'purgeExpiredHealthData');
  const expired = db.prepare(`
    SELECT id FROM athlete_health_signals
    WHERE tenant_id = ? AND user_id = ?
      AND (
        (expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now'))
        OR date <= date('now', '-365 days')
      )
  `).all(scopedTenant, userId) as Array<{ id: number }>;
  if (expired.length === 0) return 0;
  let deleted = 0;
  db.transaction(() => {
    const deleteCorrections = db.prepare(`
      DELETE FROM athlete_health_signal_corrections
      WHERE signal_id = ? AND tenant_id = ? AND user_id = ?
    `);
    const deleteSignal = db.prepare(`
      DELETE FROM athlete_health_signals WHERE id = ? AND tenant_id = ? AND user_id = ?
    `);
    for (const row of expired) {
      deleteCorrections.run(row.id, scopedTenant, userId);
      deleted += deleteSignal.run(row.id, scopedTenant, userId).changes;
    }
  })();
  if (deleted > 0) recomputeHealthSafetyState(userId, scopedTenant, db);
  return deleted;
}

/**
 * Bounded global retention worker for dormant accounts. A scheduler may call
 * this repeatedly while `hasMore` is true; each pass deletes at most `limit`
 * source rows, explicitly removes their scoped corrections, and recomputes the
 * server-owned safety state for only the affected tenant/user scopes.
 */
export function sweepExpiredStructuredHealthData(input: {
  limit?: number;
  db?: Database.Database;
} = {}): { deleted: number; scopesProcessed: number; hasMore: boolean } {
  const db = input.db ?? getDb();
  const limit = Math.min(1_000, Math.max(1, Math.floor(input.limit ?? 250)));
  const expired = db.prepare(`
    SELECT id, tenant_id, user_id
    FROM athlete_health_signals
    WHERE tenant_id IS NOT NULL
      AND (
        (expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now'))
        OR date <= date('now', '-365 days')
      )
    ORDER BY COALESCE(expires_at, date || 'T00:00:00.000Z') ASC, id ASC
    LIMIT ?
  `).all(limit) as Array<{ id: number; tenant_id: number; user_id: number }>;
  if (expired.length === 0) return { deleted: 0, scopesProcessed: 0, hasMore: false };

  const scopes = new Map<string, { tenantId: number; userId: number }>();
  for (const row of expired) {
    scopes.set(`${row.tenant_id}:${row.user_id}`, { tenantId: row.tenant_id, userId: row.user_id });
  }
  let deleted = 0;
  db.transaction(() => {
    const deleteCorrections = db.prepare(`
      DELETE FROM athlete_health_signal_corrections
      WHERE signal_id = ? AND tenant_id = ? AND user_id = ?
    `);
    const statement = db.prepare('DELETE FROM athlete_health_signals WHERE id = ? AND tenant_id = ? AND user_id = ?');
    for (const row of expired) {
      deleteCorrections.run(row.id, row.tenant_id, row.user_id);
      deleted += statement.run(row.id, row.tenant_id, row.user_id).changes;
    }
    for (const scope of scopes.values()) {
      recomputeHealthSafetyState(scope.userId, scope.tenantId, db);
    }
  })();
  const hasMore = Boolean(db.prepare(`
    SELECT 1 FROM athlete_health_signals
    WHERE tenant_id IS NOT NULL
      AND (
        (expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now'))
        OR date <= date('now', '-365 days')
      )
    LIMIT 1
  `).get());
  return { deleted, scopesProcessed: scopes.size, hasMore };
}

function ensureConsentIncludes(input: {
  tenantId: number;
  userId: number;
  scopes: HealthConsentScope[];
  idempotencyKey: string;
  db: Database.Database;
}): void {
  const current = getHealthConsent(input);
  const merged = [...new Set([...current.activeScopes, ...input.scopes])];
  if (!current.withdrawn && merged.length === current.activeScopes.length) return;
  reviseHealthConsent({
    ...input,
    activeScopes: merged,
    expectedRevision: current.revision,
    withdraw: false,
  });
}

function recomputeHealthSafetyState(userId: number, tenantId: number, db: Database.Database): void {
  const consent = getHealthConsent({ userId, tenantId, db });
  const activeScopes = new Set(consent.withdrawn ? [] : consent.activeScopes);
  const rows = db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE tenant_id = ? AND user_id = ? AND source = 'structured_intake'
      AND date > date('now', '-365 days')
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY date DESC, id DESC
  `).all(tenantId, userId) as Array<HealthSignalRow & { expires_at: string | null }>;
  let chosen: { signalId: number; correctionId: number | null; safety: HealthSafetyDisposition } | null = null;
  for (const row of rows) {
    const signal = effectiveSignalForRow(db, row);
    const filtered = filterSignalByActiveConsent(signal, activeScopes);
    if (!filtered) continue;
    const safety = deriveHealthSafetyDisposition(filtered);
    const correction = latestCorrection(db, tenantId, userId, row.id);
    if (!chosen || severityRank(safety.state) > severityRank(chosen.safety.state)) {
      chosen = { signalId: row.id, correctionId: correction?.id ?? null, safety };
    }
  }
  const safety = chosen?.safety ?? {
    state: 'clear' as const,
    triggerType: null,
    reasonCodes: [],
    explanation: 'No active consented health report currently requires a training safety change.',
  };
  db.prepare(`
    INSERT INTO training_health_safety_state (
      tenant_id, user_id, disposition, trigger_type, source_signal_id,
      source_correction_id, version, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(tenant_id, user_id) DO UPDATE SET
      disposition = excluded.disposition,
      trigger_type = excluded.trigger_type,
      source_signal_id = excluded.source_signal_id,
      source_correction_id = excluded.source_correction_id,
      version = training_health_safety_state.version + 1,
      evaluated_at = excluded.evaluated_at
  `).run(
    tenantId,
    userId,
    safety.state,
    safety.triggerType,
    chosen?.signalId ?? null,
    chosen?.correctionId ?? null,
    new Date().toISOString(),
  );
  reconcileSafetyRedFlagSignals(db, userId, tenantId, chosen);
}

function reconcileSafetyRedFlagSignals(
  db: Database.Database,
  userId: number,
  tenantId: number,
  chosen: { signalId: number; correctionId: number | null; safety: HealthSafetyDisposition } | null,
): void {
  const bus = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_signals'
  `).get();
  if (!bus) return;
  db.prepare(`
    UPDATE agent_signals
       SET status = 'dismissed'
     WHERE tenant_id = ? AND user_id = ? AND status = 'active'
       AND signal_type = 'safety_red_flag'
       AND source_agent = 'training.health-intake'
  `).run(tenantId, userId);
  if (chosen?.safety.state !== 'pause_hard_training' || !chosen.safety.triggerType) return;
  const row = db.prepare(`
    SELECT date FROM athlete_health_signals
     WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(chosen.signalId, tenantId, userId) as { date: string } | undefined;
  if (!row) return;
  publishSafetyRedFlag({
    userId,
    tenantId,
    date: row.date,
    triggerType: chosen.safety.triggerType,
  }, db);
}

function requireIntakeResource(
  db: Database.Database,
  tenantId: number,
  userId: number,
  signalId: number,
): StructuredHealthIntakeResource {
  const row = requireSignalRow(db, tenantId, userId, signalId);
  const correction = latestCorrection(db, tenantId, userId, signalId);
  const signal = effectiveSignalForRow(db, row);
  const count = db.prepare(`
    SELECT COUNT(*) AS n FROM athlete_health_signal_corrections
    WHERE tenant_id = ? AND user_id = ? AND signal_id = ?
  `).get(tenantId, userId, signalId) as { n: number };
  return {
    schemaVersion: HEALTH_DATA_LIFECYCLE_SCHEMA,
    id: signalId,
    version: 1 + Number(count.n),
    signal,
    safetyDisposition: correction
      ? parseJson<HealthSafetyDisposition>(correction.safety_disposition_json, deriveHealthSafetyDisposition(signal))
      : deriveHealthSafetyDisposition(signal),
    correctionCount: Number(count.n),
    latestCorrectionId: correction?.id ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? new Date(Date.parse(`${row.date}T00:00:00.000Z`) + HEALTH_SENSITIVE_RETENTION_DAYS * 86_400_000).toISOString(),
  };
}

function requireSignalRow(
  db: Database.Database,
  tenantId: number,
  userId: number,
  signalId: number,
): HealthSignalRow & { expires_at: string | null } {
  const row = db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND source = 'structured_intake'
  `).get(signalId, tenantId, userId) as (HealthSignalRow & { expires_at: string | null }) | undefined;
  if (!row) throw new HealthDataLifecycleError('HEALTH_INTAKE_NOT_FOUND', 'Structured health intake not found.', 404);
  return row;
}

function effectiveSignalForRow(db: Database.Database, row: HealthSignalRow): StructuredHealthSignal {
  const correction = latestCorrection(db, row.tenant_id, row.user_id, row.id);
  if (correction) {
    return parseJson<StructuredHealthSignal>(correction.effective_signal_json, signalFromRow(row));
  }
  return signalFromRow(row);
}

function signalFromRow(row: HealthSignalRow): StructuredHealthSignal {
  return {
    date: row.date,
    ...(row.pain_score !== null ? { painScore: row.pain_score } : {}),
    ...(row.pain_location ? { painLocation: row.pain_location } : {}),
    ...(row.illness_symptoms_json
      ? { illnessSymptoms: parseJson<HealthInputSymptomCode[]>(row.illness_symptoms_json, []) }
      : {}),
    ...(row.injury_status ? { injuryStatus: row.injury_status } : {}),
    ...(row.energy_availability_risk ? { energyAvailabilityRisk: row.energy_availability_risk } : {}),
    consentScope: row.consent_scope.split(',').filter((scope): scope is HealthConsentScope => PUBLIC_SCOPE_SET.has(scope)),
    source: 'structured_intake',
  };
}

function latestCorrection(db: Database.Database, tenantId: number, userId: number, signalId: number): CorrectionRow | null {
  return (db.prepare(`
    SELECT * FROM athlete_health_signal_corrections
    WHERE tenant_id = ? AND user_id = ? AND signal_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(tenantId, userId, signalId) as CorrectionRow | undefined) ?? null;
}

function mergeCorrection(current: StructuredHealthSignal, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const allowed = [
    'date', 'painScore', 'painLocation', 'illnessSymptoms', 'injuryStatus',
    'energyAvailabilityRisk', 'consentScope',
  ];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'menstrualStatus')) next.menstrualStatus = patch.menstrualStatus;
  return next;
}

function filterSignalByActiveConsent(
  signal: StructuredHealthSignal,
  active: Set<HealthConsentScope>,
): StructuredHealthSignal | null {
  const consentScope = signal.consentScope.filter((scope) => active.has(scope));
  const filtered: StructuredHealthSignal = {
    date: signal.date,
    consentScope,
    source: 'structured_intake',
    ...(active.has('pain') ? { painScore: signal.painScore, painLocation: signal.painLocation } : {}),
    ...(active.has('illness') ? { illnessSymptoms: signal.illnessSymptoms } : {}),
    ...(active.has('injury') ? { injuryStatus: signal.injuryStatus } : {}),
    ...(active.has('red_s_screening') ? { energyAvailabilityRisk: signal.energyAvailabilityRisk } : {}),
  };
  const hasData = filtered.painScore !== undefined || filtered.painLocation !== undefined
    || (filtered.illnessSymptoms?.length ?? 0) > 0 || filtered.injuryStatus !== undefined
    || filtered.energyAvailabilityRisk !== undefined;
  return hasData ? filtered : null;
}

function latestConsentRow(db: Database.Database, tenantId: number, userId: number): ConsentRow | null {
  return (db.prepare(`
    SELECT revision, active_scopes_json, withdrawn, created_at, request_hash
    FROM health_data_consent_revisions
    WHERE tenant_id = ? AND user_id = ? ORDER BY revision DESC LIMIT 1
  `).get(tenantId, userId) as ConsentRow | undefined) ?? null;
}

function consentResource(row: ConsentRow | null): HealthConsentResource {
  const activeScopes = row && !row.withdrawn
    ? normalizePublicScopes(parseJson<string[]>(row.active_scopes_json, []))
    : [];
  return {
    schemaVersion: HEALTH_DATA_LIFECYCLE_SCHEMA,
    state: row === null ? 'not_granted' : row.withdrawn === 1 ? 'withdrawn' : 'active',
    revision: row?.revision ?? 0,
    activeScopes,
    withdrawn: row ? row.withdrawn === 1 : false,
    explanations: Object.fromEntries(activeScopes.map((scope) => [scope, CONSENT_EXPLANATIONS[scope]])),
    createdAt: row?.created_at ?? null,
    etag: `"health-consent-${row?.revision ?? 0}"`,
  };
}

function normalizePublicScopes(scopes: readonly string[]): HealthConsentScope[] {
  if (scopes.some((scope) => !PUBLIC_SCOPE_SET.has(scope))) {
    throw new HealthDataLifecycleError('BAD_CONSENT_SCOPE', 'Consent contains an unsupported scope.');
  }
  return [...new Set(scopes)] as HealthConsentScope[];
}

function requireScope(scopes: readonly HealthConsentScope[], expected: HealthConsentScope): void {
  if (!scopes.includes(expected)) {
    throw new HealthDataLifecycleError('CONSENT_REQUIRED', `${expected} consent is required for the supplied field.`, 428);
  }
}

function resolveExpiresAt(signalDate: string, value?: string): string {
  const now = Date.now();
  const signalRetentionBoundary = Date.parse(`${signalDate}T00:00:00.000Z`)
    + HEALTH_SENSITIVE_RETENTION_DAYS * 86_400_000;
  const max = Math.min(
    signalRetentionBoundary,
    now + HEALTH_SENSITIVE_RETENTION_DAYS * 86_400_000,
  );
  if (max <= now) {
    throw new HealthDataLifecycleError(
      'EXPIRED_HEALTH_INPUT',
      'Health intake has reached the 365-day retention boundary.',
      410,
    );
  }
  if (value === undefined) return new Date(max).toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now) {
    throw new HealthDataLifecycleError('EXPIRED_HEALTH_INPUT', 'expiresAt must be a future ISO instant.', 410);
  }
  if (parsed > max) {
    throw new HealthDataLifecycleError(
      'RETENTION_EXCEEDED',
      'expiresAt cannot exceed 365 days from the reported health date.',
    );
  }
  return new Date(parsed).toISOString();
}

function requireIdempotencyKey(value: string): string {
  const key = value?.trim();
  if (!key || key.length > 160) {
    throw new HealthDataLifecycleError('IDEMPOTENCY_REQUIRED', 'A non-empty Idempotency-Key of at most 160 characters is required.', 428);
  }
  return key;
}

function requireExpectedIntakeVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HealthDataLifecycleError(
      'PRECONDITION_REQUIRED',
      'If-Match health intake version or expectedVersion is required.',
      428,
    );
  }
  return value;
}

function findHealthMutationReceipt(
  db: Database.Database,
  tenantId: number,
  userId: number,
  idempotencyKey: string,
): HealthMutationReceiptRow | null {
  return (db.prepare(`
    SELECT operation, request_hash, response_json
      FROM health_data_mutation_receipts
     WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
  `).get(tenantId, userId, idempotencyKey) as HealthMutationReceiptRow | undefined) ?? null;
}

function assertHealthMutationReceiptMatch(
  receipt: HealthMutationReceiptRow,
  operation: HealthMutationReceiptRow['operation'],
  requestHash: string,
): void {
  if (receipt.operation !== operation || receipt.request_hash !== requestHash) {
    throw new HealthDataLifecycleError(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency-Key belongs to another health data mutation.',
      409,
    );
  }
}

function insertHealthMutationReceipt(input: {
  db: Database.Database;
  tenantId: number;
  userId: number;
  operation: HealthMutationReceiptRow['operation'];
  signalId: number | null;
  idempotencyKey: string;
  requestHash: string;
  response: unknown;
}): void {
  input.db.prepare(`
    INSERT INTO health_data_mutation_receipts (
      tenant_id, user_id, operation, signal_id, idempotency_key,
      request_hash, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.tenantId,
    input.userId,
    input.operation,
    input.signalId,
    input.idempotencyKey,
    input.requestHash,
    JSON.stringify(input.response),
  );
}

function boundedText(value: string, maxLength: number, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new HealthDataLifecycleError('BAD_INPUT', `${field} must contain 1 to ${maxLength} characters.`);
  }
  return trimmed;
}

function severityRank(state: HealthSafetyDisposition['state']): number {
  return state === 'pause_hard_training' ? 2 : state === 'review' ? 1 : 0;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
