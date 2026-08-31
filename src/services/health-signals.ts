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

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';
import { deriveSafetyTriggerFromSignal } from './coach-kernel/safety-wiring';
import { publishSafetyRedFlag } from './training-signals';

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
  expires_at?: string | null;
  idempotency_key?: string | null;
  request_hash?: string | null;
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
  /** Structured lifecycle callers recompute/publish once after correction and consent authority is committed. */
  publishSafetySignal?: boolean;
  db?: Database.Database;
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

  const db = input.db ?? getDb();
  let id = 0;
  db.transaction(() => {
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

    id = Number(inserted.lastInsertRowid);
    // The sanitized derived safety signal is written in the same database
    // transaction as the private source row. A crash cannot leave one without
    // the other; provider or model output is never involved in this decision.
    if (input.publishSafetySignal !== false) {
      publishStructuredRedFlagIfNeeded({
        userId: input.userId,
        tenantId,
        date: input.date,
        source: input.source,
        painScore,
        painLocation,
        illnessSymptoms,
        injuryStatus,
        energyAvailabilityRisk,
      }, db);
    }
  })();

  return { id, droppedFields };
}

function publishStructuredRedFlagIfNeeded(input: {
  userId: number;
  tenantId: number;
  date: string;
  source?: string;
  painScore: number | null;
  painLocation: string | null;
  illnessSymptoms: readonly string[] | null;
  injuryStatus: InjuryStatus | null;
  energyAvailabilityRisk: EnergyAvailabilityRisk | null;
}, db: Database.Database): void {
  const trigger = deriveSafetyTriggerFromSignal({
    source: input.source,
    painScore: input.painScore ?? undefined,
    painLocation: input.painLocation ?? undefined,
    illnessSymptoms: input.illnessSymptoms ?? undefined,
    injuryStatus: input.injuryStatus ?? undefined,
    energyAvailabilityRisk: input.energyAvailabilityRisk ?? undefined,
  });
  if (trigger.source !== 'structured_intake' || !trigger.triggerType) return;
  publishSafetyRedFlag({
    userId: input.userId,
    tenantId: input.tenantId,
    date: input.date,
    triggerType: trigger.triggerType,
  }, db);
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
  // Sensitive Training health data is active for at most 365 days. Callers
  // may ask for a shorter window, never a longer implicit one.
  const maxAgeDays = Math.min(365, options.maxAgeDays ?? 365);
  const hasMaxAgeDays = typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays > 0;
  const resolvedAsOfDate = (asOfDate ?? new Date().toISOString()).slice(0, 10);
  const cutoffDate = hasMaxAgeDays
    ? new Date(Date.parse(`${resolvedAsOfDate}T00:00:00.000Z`) - Math.floor(maxAgeDays) * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    : null;
  if (asOfDate) {
    const rows = db.prepare(`
      SELECT * FROM athlete_health_signals
      WHERE user_id = ? AND tenant_id = ? AND date <= ?
        ${cutoffDate ? 'AND date > ?' : ''}
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
      ORDER BY date DESC, created_at DESC
    `).all(...(
      cutoffDate
        ? [userId, scopedTenantId, resolvedAsOfDate, cutoffDate]
        : [userId, scopedTenantId, resolvedAsOfDate]
    )) as HealthSignalRow[];
    return firstAuthorizedHealthSignal(rows, db);
  }
  const rows = db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE user_id = ? AND tenant_id = ?
      ${cutoffDate ? 'AND date > ?' : ''}
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY date DESC, created_at DESC
  `).all(...(
    cutoffDate
      ? [userId, scopedTenantId, cutoffDate]
      : [userId, scopedTenantId]
  )) as HealthSignalRow[];
  return firstAuthorizedHealthSignal(rows, db);
}

function applyLatestHealthCorrection(
  row: HealthSignalRow,
  db: Database.Database = getDb(),
): HealthSignalRow {
  const correction = db.prepare(`
    SELECT effective_signal_json
    FROM athlete_health_signal_corrections
    WHERE tenant_id = ? AND user_id = ? AND signal_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(row.tenant_id, row.user_id, row.id) as { effective_signal_json: string } | undefined;
  if (!correction) return row;
  try {
    const effective = JSON.parse(correction.effective_signal_json) as Record<string, unknown>;
    return {
      ...row,
      date: typeof effective.date === 'string' ? effective.date : row.date,
      pain_score: typeof effective.painScore === 'number' ? effective.painScore : null,
      pain_location: typeof effective.painLocation === 'string' ? effective.painLocation : null,
      illness_symptoms_json: Array.isArray(effective.illnessSymptoms)
        ? JSON.stringify(effective.illnessSymptoms)
        : null,
      injury_status: typeof effective.injuryStatus === 'string'
        ? effective.injuryStatus as InjuryStatus
        : null,
      menstrual_status: null,
      energy_availability_risk: typeof effective.energyAvailabilityRisk === 'string'
        ? effective.energyAvailabilityRisk as EnergyAvailabilityRisk
        : null,
      consent_scope: Array.isArray(effective.consentScope)
        ? effective.consentScope.filter((scope): scope is string => typeof scope === 'string').join(',')
        : row.consent_scope,
      source: 'structured_intake',
    };
  } catch (err) {
    logger.warn({ err, signalId: row.id }, 'health_signal.correction_parse_failed');
    return row;
  }
}

function currentHealthConsentScopes(
  db: Database.Database,
  tenantId: number,
  userId: number,
): Set<HealthConsentScope> | null {
  const row = db.prepare(`
    SELECT active_scopes_json, withdrawn
    FROM health_data_consent_revisions
    WHERE tenant_id = ? AND user_id = ?
    ORDER BY revision DESC
    LIMIT 1
  `).get(tenantId, userId) as {
    active_scopes_json: string;
    withdrawn: number;
  } | undefined;
  // Pre-lifecycle rows retain their row-level consent contract. Once the
  // lifecycle authority exists, its latest revision is authoritative.
  if (!row) return null;
  if (row.withdrawn === 1) return new Set();
  try {
    const parsed = JSON.parse(row.active_scopes_json) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((scope): scope is HealthConsentScope =>
      typeof scope === 'string' && Object.values(FIELD_CONSENT_MAP).includes(scope as HealthConsentScope)));
  } catch (err) {
    logger.warn({ err, tenantId, userId }, 'health_signal.current_consent_parse_failed');
    return new Set();
  }
}

function authorizedHealthSignal(
  row: HealthSignalRow,
  db: Database.Database,
  currentScopes: Set<HealthConsentScope> | null,
): HealthSignalRow | null {
  const effective = applyLatestHealthCorrection(row, db);
  const rowScopes = new Set(effective.consent_scope.split(',').filter(Boolean) as HealthConsentScope[]);
  const allowed = (scope: HealthConsentScope): boolean =>
    rowScopes.has(scope) && (currentScopes === null || currentScopes.has(scope));
  const authorized: HealthSignalRow = {
    ...effective,
    pain_score: allowed('pain') ? effective.pain_score : null,
    pain_location: allowed('pain') ? effective.pain_location : null,
    illness_symptoms_json: allowed('illness') ? effective.illness_symptoms_json : null,
    injury_status: allowed('injury') ? effective.injury_status : null,
    menstrual_status: allowed('menstrual') ? effective.menstrual_status : null,
    energy_availability_risk: allowed('red_s_screening') ? effective.energy_availability_risk : null,
    consent_scope: [...rowScopes].filter(allowed).sort().join(','),
  };
  const hasAuthorizedData = authorized.pain_score !== null
    || authorized.pain_location !== null
    || authorized.illness_symptoms_json !== null
    || authorized.injury_status !== null
    || authorized.menstrual_status !== null
    || authorized.energy_availability_risk !== null;
  return hasAuthorizedData ? authorized : null;
}

function firstAuthorizedHealthSignal(
  rows: HealthSignalRow[],
  db: Database.Database,
): HealthSignalRow | null {
  if (rows.length === 0) return null;
  const currentScopes = currentHealthConsentScopes(db, rows[0].tenant_id, rows[0].user_id);
  for (const row of rows) {
    const authorized = authorizedHealthSignal(row, db, currentScopes);
    if (authorized) return authorized;
  }
  return null;
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
  const rows = db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE user_id = ?
      AND tenant_id = ?
      AND date BETWEEN ? AND ?
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY date DESC, created_at DESC
  `).all(userId, scopedTenantId, fromDate, toDate) as HealthSignalRow[];
  const currentScopes = currentHealthConsentScopes(db, scopedTenantId, userId);
  return rows
    .map((row) => authorizedHealthSignal(row, db, currentScopes))
    .filter((row): row is HealthSignalRow => row !== null
      && row.date >= fromDate
      && row.date <= toDate
      && row.pain_score !== null);
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
  const rows = db.prepare(`
    SELECT * FROM athlete_health_signals
    WHERE user_id = ?
      AND tenant_id = ?
      AND date BETWEEN ? AND ?
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY date DESC, created_at DESC
  `).all(userId, scopedTenantId, fromDate, toDate) as HealthSignalRow[];
  const currentScopes = currentHealthConsentScopes(db, scopedTenantId, userId);
  return rows
    .map((row) => authorizedHealthSignal(row, db, currentScopes))
    .filter((row): row is HealthSignalRow => {
      if (!row || row.date < fromDate || row.date > toDate || !row.illness_symptoms_json) return false;
      try {
        const symptoms = JSON.parse(row.illness_symptoms_json) as unknown;
        return Array.isArray(symptoms) && symptoms.length > 0;
      } catch {
        // Keep an authorized corrupt row visible to the safety classifier so
        // it logs and takes the conservative illness fallback. Silently
        // dropping it would misclassify the gap as a vacation.
        return true;
      }
    });
}

/**
 * Delete all health signals for a user. Called by the privacy slice
 * (A4p) when the user requests history deletion. Returns the count
 * of deleted rows.
 *
 * The corresponding adaptation-ledger redaction is handled separately
 * by `purgeSensitivePayloadsForUser` (slice A0b).
 */
export function deleteHealthHistoryForUser(
  userId: number,
  tenantId: number,
  db: Database.Database = getDb(),
): number {
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
