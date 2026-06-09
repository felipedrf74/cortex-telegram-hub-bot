// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Health signals — slice A0c of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Time-varying high-sensitivity health signals as EVENTS, not mutable
 * fields on AthleteProfile. Pain, illness, injury, menstrual status,
 * and RED-S risk live here; the PlanGenerationContext (slice A3)
 * reads the latest event for a given date and surfaces it as a
 * `HealthSignal` to the engines. Safety guardrails (slice A4) consume
 * these signals to fire red-flag rules.
 *
 * Critical privacy posture (slice A4p):
 *
 *   - Every column except pain has its OWN consent scope. The user
 *     opts in per-family — opting in to pain tracking does NOT opt
 *     them into menstrual tracking. `recordHealthSignal` strips
 *     unauthorized fields silently.
 *
 *   - Menstrual status: per the v2.1 critique, we do NOT infer cycle
 *     phase from calendar estimates. This module ONLY stores user-
 *     declared status or symptom-only entries.
 *
 *   - RED-S energy availability risk: framed as RISK SCREENING, not
 *     diagnosis (IOC 2023 REDs CAT2 consensus). The app flags risk
 *     and recommends professional support; downstream code must
 *     never claim a clinical diagnosis.
 *
 *   - Default consent_scope is EMPTY — unlike readiness events which
 *     default to readiness_basic, health signals require explicit
 *     opt-in for every field. A row with no consent is rejected.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';

export type InjuryStatus =
  | 'none'
  | 'acute'
  | 'chronic_managed'
  | 'returning'
  | 'post_exertional_symptom_risk';

export type MenstrualStatus =
  | 'menses'
  | 'follicular'
  | 'ovulation'
  | 'luteal'
  | 'amenorrhea'
  | 'symptom_only';

export type EnergyAvailabilityRisk = 'low' | 'moderate' | 'high';

export type HealthConsentScope =
  | 'pain'
  | 'illness'
  | 'injury'
  | 'menstrual'
  | 'red_s_screening';

export interface HealthSignalRow {
  id: number;
  user_id: number;
  tenant_id: number;
  date: string;
  pain_score: number | null;
  pain_location: string | null;
  illness_symptoms_json: string | null;
  injury_status: InjuryStatus | null;
  menstrual_status: MenstrualStatus | null;
  energy_availability_risk: EnergyAvailabilityRisk | null;
  source: string | null;
  consent_scope: string;
  created_at: string;
}

export interface RecordHealthSignalInput {
  userId: number;
  tenantId: number;
  date: string;
  painScore?: number;
  painLocation?: string;
  illnessSymptoms?: readonly string[];
  injuryStatus?: InjuryStatus;
  menstrualStatus?: MenstrualStatus;
  energyAvailabilityRisk?: EnergyAvailabilityRisk;
  source?: string;
  consentScope: HealthConsentScope[];
}

export interface RecordHealthSignalResult {
  id: number;
  droppedFields: string[];
}

/**
 * Per-field consent mapping. A field can only be persisted if its
 * scope is in the row's `consentScope`. Adding a new field requires
 * adding a corresponding scope here.
 */
const FIELD_CONSENT_MAP: Record<string, HealthConsentScope> = {
  painScore: 'pain',
  painLocation: 'pain',
  illnessSymptoms: 'illness',
  injuryStatus: 'injury',
  menstrualStatus: 'menstrual',
  energyAvailabilityRisk: 'red_s_screening',
};

/**
 * Persist a health signal, enforcing per-field consent gating.
 *
 * Unlike readiness events, there is no "default" opt-in — every
 * sensitive field requires explicit user authorization. A row with no
 * consent scopes is rejected (better than writing an empty row).
 *
 * Fields whose scope is missing from `consentScope` are silently
 * dropped from the INSERT; the drops are recorded in
 * `droppedFields` for diagnostics (debug log + return value, never
 * surfaced to the user).
 */
export function recordHealthSignal(
  input: RecordHealthSignalInput,
): RecordHealthSignalResult {
  const tenantId = requireTenantIdParam(input.tenantId, 'recordHealthSignal');
  if (input.consentScope.length === 0) {
    throw new Error(
      'recordHealthSignal: consentScope cannot be empty; at least one ' +
      'scope must be authorized to persist a health signal.',
    );
  }

  const scopes = new Set(input.consentScope);
  const droppedFields: string[] = [];

  const consentedField = <K extends keyof typeof FIELD_CONSENT_MAP>(
    key: K,
    value: unknown,
  ): unknown => {
    if (value === undefined || value === null) return null;
    const requiredScope = FIELD_CONSENT_MAP[key];
    if (!scopes.has(requiredScope)) {
      droppedFields.push(key);
      return null;
    }
    return value;
  };

  const painScore = consentedField('painScore', input.painScore) as number | null;
  const painLocation = consentedField('painLocation', input.painLocation) as string | null;
  const illnessSymptoms = consentedField(
    'illnessSymptoms',
    input.illnessSymptoms,
  ) as readonly string[] | null;
  const injuryStatus = consentedField('injuryStatus', input.injuryStatus) as InjuryStatus | null;
  const menstrualStatus = consentedField('menstrualStatus', input.menstrualStatus) as MenstrualStatus | null;
  const energyAvailabilityRisk = consentedField(
    'energyAvailabilityRisk',
    input.energyAvailabilityRisk,
  ) as EnergyAvailabilityRisk | null;

  if (droppedFields.length > 0) {
    logger.debug(
      { userId: input.userId, droppedFields },
      'health_signals.consent_stripped',
    );
  }

  // After consent gating, refuse to insert a row with NO meaningful
  // health data. This protects against accidentally creating empty
  // rows that count as "the user reported something" in support
  // views without containing anything actionable.
  const hasAnyData =
    painScore !== null ||
    painLocation !== null ||
    illnessSymptoms !== null ||
    injuryStatus !== null ||
    menstrualStatus !== null ||
    energyAvailabilityRisk !== null;
  if (!hasAnyData) {
    throw new Error(
      'recordHealthSignal: no fields remained after consent gating; refusing to ' +
      `insert empty row (originally received: ${droppedFields.join(', ')})`,
    );
  }

  const consentScopeString = Array.from(scopes).sort().join(',');

  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO athlete_health_signals (
      user_id, tenant_id, date, pain_score, pain_location, illness_symptoms_json,
      injury_status, menstrual_status, energy_availability_risk,
      source, consent_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.userId,
    tenantId,
    input.date,
    painScore,
    painLocation,
    illnessSymptoms ? JSON.stringify(illnessSymptoms) : null,
    injuryStatus,
    menstrualStatus,
    energyAvailabilityRisk,
    input.source ?? null,
    consentScopeString,
  );

  return { id: Number(inserted.lastInsertRowid), droppedFields };
}

/**
 * Fetch the most recent health signal for a user, optionally bounded
 * by date. Returns null when no signals exist.
 *
 * NOTE: callers reading sensitive fields downstream MUST honor the
 * row's `consent_scope` — a row may have illness data but no
 * menstrual data because the user only opted into illness tracking.
 */
export function getLatestHealthSignal(
  userId: number,
  tenantId: number,
  asOfDate?: string,
  options: { maxAgeDays?: number } = {},
): HealthSignalRow | null {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'getLatestHealthSignal');
  const maxAgeDays = options.maxAgeDays;
  const hasMaxAgeDays = typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays > 0;
  const resolvedAsOfDate = (asOfDate ?? new Date().toISOString()).slice(0, 10);
  const cutoffDate = hasMaxAgeDays
    ? new Date(Date.parse(`${resolvedAsOfDate}T00:00:00.000Z`) - Math.floor(maxAgeDays) * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    : null;
  if (asOfDate) {
    const row = db.prepare(`
      SELECT * FROM athlete_health_signals
      WHERE user_id = ? AND tenant_id = ? AND date <= ?
        ${cutoffDate ? 'AND date >= ?' : ''}
      ORDER BY date DESC, created_at DESC
      LIMIT 1
    `).get(...(
      cutoffDate
        ? [userId, scopedTenantId, resolvedAsOfDate, cutoffDate]
        : [userId, scopedTenantId, resolvedAsOfDate]
    )) as HealthSignalRow | undefined;
    return row ?? null;
  }
  const row = db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE user_id = ? AND tenant_id = ?
      ${cutoffDate ? 'AND date >= ?' : ''}
    ORDER BY date DESC, created_at DESC
    LIMIT 1
  `).get(...(
    cutoffDate
      ? [userId, scopedTenantId, cutoffDate]
      : [userId, scopedTenantId]
  )) as HealthSignalRow | undefined;
  return row ?? null;
}

/**
 * Find any health signal with non-null pain in a date range. Used by
 * A4 (safety) to answer "has the user reported pain in the last N
 * days?".
 */
export function findPainSignalsInRange(
  userId: number,
  tenantId: number,
  fromDate: string,
  toDate: string,
): HealthSignalRow[] {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'findPainSignalsInRange');
  return db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE user_id = ?
      AND tenant_id = ?
      AND date BETWEEN ? AND ?
      AND pain_score IS NOT NULL
    ORDER BY date DESC, created_at DESC
  `).all(userId, scopedTenantId, fromDate, toDate) as HealthSignalRow[];
}

/**
 * Find any health signal with non-null illness symptoms in a date
 * range. Used by C4 (gap detector) to classify the return-protocol
 * (febrile_or_systemic_illness vs minor_illness_resolved).
 */
export function findIllnessSignalsInRange(
  userId: number,
  tenantId: number,
  fromDate: string,
  toDate: string,
): HealthSignalRow[] {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'findIllnessSignalsInRange');
  return db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE user_id = ?
      AND tenant_id = ?
      AND date BETWEEN ? AND ?
      AND illness_symptoms_json IS NOT NULL
    ORDER BY date DESC, created_at DESC
  `).all(userId, scopedTenantId, fromDate, toDate) as HealthSignalRow[];
}

/**
 * Delete all health signals for a user. Called by the privacy slice
 * (A4p) when the user requests history deletion. Returns the count
 * of deleted rows.
 *
 * The corresponding adaptation-ledger redaction is handled separately
 * by `purgeSensitivePayloadsForUser` (slice A0b).
 */
export function deleteHealthHistoryForUser(userId: number, tenantId: number): number {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'deleteHealthHistoryForUser');
  const result = db.prepare(
    'DELETE FROM athlete_health_signals WHERE user_id = ? AND tenant_id = ?',
  ).run(userId, scopedTenantId);
  if (result.changes > 0) {
    logger.info(
      { userId, tenantId: scopedTenantId, deleted: result.changes },
      'health_signals.delete_history',
    );
  }
  return result.changes;
}
