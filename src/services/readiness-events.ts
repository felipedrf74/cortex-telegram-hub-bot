// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Readiness events — slice A0c of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Time-varying readiness signals as EVENTS, not mutable fields on
 * AthleteProfile. Sleep, stress, HRV-derived status, and resting-HR
 * trend statuses live here; the PlanGenerationContext (slice A3)
 * reads the latest event for a given date and surfaces it as a
 * `ReadinessSnapshot` to the engines.
 *
 * Consent model (privacy slice A4p):
 *
 *   The `consent_scope` column holds a comma-separated list of
 *   readiness scopes the user has authorized:
 *
 *     - readiness_basic   — sleep, stress (default opt-in)
 *     - hrv_status        — HRV-derived training-readiness ratings
 *     - resting_hr        — resting HR trend
 *
 *   The application enforces per-column gating: a value can only be
 *   persisted if the corresponding scope is in `consent_scope`.
 *   `recordReadinessEvent` strips fields the user hasn't authorized
 *   and emits a debug log so support can diagnose silent drops.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';

export type HrvStatus = 'balanced' | 'low' | 'unbalanced' | 'poor';
export type RestingHrStatus = 'normal' | 'elevated';

export type ReadinessConsentScope =
  | 'readiness_basic'
  | 'hrv_status'
  | 'resting_hr';

export interface ReadinessEventRow {
  id: number;
  user_id: number;
  tenant_id: number;
  date: string;
  sleep_hours: number | null;
  sleep_quality: number | null;
  stress_score: number | null;
  hrv_status: HrvStatus | null;
  resting_hr_status: RestingHrStatus | null;
  source: string | null;
  consent_scope: string;
  created_at: string;
}

export interface RecordReadinessEventInput {
  userId: number;
  tenantId: number;
  /** ISO 8601 date (YYYY-MM-DD). */
  date: string;
  sleepHours?: number;
  sleepQuality?: number;
  stressScore?: number;
  hrvStatus?: HrvStatus;
  restingHrStatus?: RestingHrStatus;
  source?: string;
  /** Set of scopes the user has explicitly authorized for this event. */
  consentScope: ReadinessConsentScope[];
}

export interface RecordReadinessEventResult {
  id: number;
  /** Fields that were stripped due to missing consent. Useful for diagnostics. */
  droppedFields: string[];
}

/**
 * Persist a readiness event, enforcing per-field consent gating.
 *
 * Fields whose corresponding consent scope is not present are
 * silently dropped from the INSERT (a debug log records what was
 * stripped — useful for support but not visible to the user, since
 * showing "we dropped X because you haven't opted in" would be both
 * noisy and self-defeating).
 *
 * Consent → field mapping:
 *
 *   readiness_basic → sleep_hours, sleep_quality, stress_score
 *   hrv_status      → hrv_status
 *   resting_hr      → resting_hr_status
 *
 * `consentScope` MUST contain at least `readiness_basic` — events
 * with no consent at all are rejected (better to ask the user than
 * to write an empty row).
 */
export function recordReadinessEvent(
  input: RecordReadinessEventInput,
): RecordReadinessEventResult {
  const tenantId = requireTenantIdParam(input.tenantId, 'recordReadinessEvent');
  if (!input.consentScope.includes('readiness_basic')) {
    throw new Error(
      'recordReadinessEvent: consentScope must include readiness_basic; ' +
      `received [${input.consentScope.join(', ')}]`,
    );
  }

  const scopes = new Set(input.consentScope);
  const droppedFields: string[] = [];

  const sleepHours = input.sleepHours;
  const sleepQuality = input.sleepQuality;
  const stressScore = input.stressScore;
  // readiness_basic implicit for these three.

  let hrvStatus: HrvStatus | null = input.hrvStatus ?? null;
  if (hrvStatus !== null && !scopes.has('hrv_status')) {
    droppedFields.push('hrvStatus');
    hrvStatus = null;
  }

  let restingHrStatus: RestingHrStatus | null = input.restingHrStatus ?? null;
  if (restingHrStatus !== null && !scopes.has('resting_hr')) {
    droppedFields.push('restingHrStatus');
    restingHrStatus = null;
  }

  if (droppedFields.length > 0) {
    logger.debug(
      { userId: input.userId, droppedFields },
      'readiness_events.consent_stripped',
    );
  }

  const consentScopeString = Array.from(scopes).sort().join(',');

  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO athlete_readiness_events (
      user_id, tenant_id, date, sleep_hours, sleep_quality, stress_score,
      hrv_status, resting_hr_status, source, consent_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.userId,
    tenantId,
    input.date,
    sleepHours ?? null,
    sleepQuality ?? null,
    stressScore ?? null,
    hrvStatus,
    restingHrStatus,
    input.source ?? null,
    consentScopeString,
  );

  return { id: Number(inserted.lastInsertRowid), droppedFields };
}

/**
 * Fetch the most recent readiness event for a user, optionally
 * bounded by date (e.g., "as of yesterday"). When multiple events
 * exist on the same date (e.g., Garmin + Apple Health both reported),
 * returns the one with the newest `created_at`.
 *
 * Returns null when no events exist for the user.
 */
export function getLatestReadinessEvent(
  userId: number,
  tenantId: number,
  asOfDate?: string,
): ReadinessEventRow | null {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'getLatestReadinessEvent');
  if (asOfDate) {
    const row = db.prepare(`
      SELECT * FROM athlete_readiness_events
      WHERE user_id = ? AND tenant_id = ? AND date <= ?
      ORDER BY date DESC, created_at DESC
      LIMIT 1
    `).get(userId, scopedTenantId, asOfDate) as ReadinessEventRow | undefined;
    return row ?? null;
  }
  const row = db.prepare(`
    SELECT * FROM athlete_readiness_events
    WHERE user_id = ? AND tenant_id = ?
    ORDER BY date DESC, created_at DESC
    LIMIT 1
  `).get(userId, scopedTenantId) as ReadinessEventRow | undefined;
  return row ?? null;
}

/**
 * List readiness events for a user within a date range, newest first.
 * Used by load-model (B1) and HRV pairing rules (B5) that need a
 * rolling window of readings.
 *
 * `limit` caps the result size; default 60 matches the longest CTL
 * window the engine cares about (42 days) with a 2-week safety margin.
 */
export function getReadinessEventsInRange(
  userId: number,
  tenantId: number,
  fromDate: string,
  toDate: string,
  limit = 60,
): ReadinessEventRow[] {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'getReadinessEventsInRange');
  return db.prepare(`
    SELECT * FROM athlete_readiness_events
    WHERE user_id = ? AND tenant_id = ? AND date BETWEEN ? AND ?
    ORDER BY date DESC, created_at DESC
    LIMIT ?
  `).all(userId, scopedTenantId, fromDate, toDate, Math.max(1, Math.min(limit, 1000))) as ReadinessEventRow[];
}

/**
 * Delete all readiness events for a user. Called by the privacy
 * slice (A4p) when the user requests history deletion. Returns the
 * count of deleted rows for logging/audit purposes.
 *
 * NOTE: the corresponding adaptation-ledger redaction is handled
 * separately by `purgeSensitivePayloadsForUser` (slice A0b) — that
 * function preserves ledger ROWS for audit while removing their
 * sensitive payloads. Together these provide the "delete my health
 * history" primitive.
 */
export function deleteReadinessHistoryForUser(userId: number, tenantId: number): number {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'deleteReadinessHistoryForUser');
  const result = db.prepare(
    'DELETE FROM athlete_readiness_events WHERE user_id = ? AND tenant_id = ?',
  ).run(userId, scopedTenantId);
  if (result.changes > 0) {
    logger.info(
      { userId, tenantId: scopedTenantId, deleted: result.changes },
      'readiness_events.delete_history',
    );
  }
  return result.changes;
}
