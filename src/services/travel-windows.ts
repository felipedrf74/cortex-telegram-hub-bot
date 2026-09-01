// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Travel windows — slice C2 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * iOS POSTs a travel window via `POST /api/v1/training/week/travel`.
 * The window carries travel-stress metadata beyond just equipment:
 * time-zone shift, flight duration, sleep disruption expectations,
 * walking load (sightseeing volume), heat stress.
 *
 * Engines (C7 aggregator + C8 classifier) consume these as a
 * `travelStress` signal that modulates intensity ceiling and adapts
 * session selection. Substrate-only here — this module owns the
 * write + read primitives; the orchestration is downstream.
 *
 * The previous calendar-title regex (parsing "Travel" / "On the
 * road" from calendar events) stays as a fallback signal; this
 * explicit endpoint is the canonical producer.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';
import { stableTrainingRevisionHash } from './training-plan-revision-candidate-builder';

export interface TravelWindowRow {
  id: number;
  user_id: number;
  tenant_id: number | null;
  start_date: string;
  end_date: string;
  equipment_profile: string | null;
  time_zone_shift_hours: number | null;
  flight_duration_hours: number | null;
  sleep_disruption_expected: number;
  walking_load_expected: number;
  heat_stress: number;
  available_session_duration_minutes: number | null;
  notes: string | null;
  created_at: string;
  version: number;
  updated_at: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
}

export interface RecordTravelWindowInput {
  userId: number;
  tenantId?: number | null;
  startDate: string;
  endDate: string;
  equipmentProfile?: string;
  timeZoneShiftHours?: number;
  flightDurationHours?: number;
  sleepDisruptionExpected?: boolean;
  walkingLoadExpected?: boolean;
  heatStress?: boolean;
  availableSessionDurationMinutes?: number;
  notes?: string;
  idempotencyKey?: string;
}

export interface RecordTravelWindowResult {
  id: number;
  alreadyExisted: boolean;
  version: number;
}

export class TravelWindowIdempotencyConflictError extends Error {}
export class TravelWindowVersionConflictError extends Error {}

export function recordTravelWindow(input: RecordTravelWindowInput): RecordTravelWindowResult {
  validateTravelWindowInput(input);
  const db = getDb();
  const identity = normalizeTravelWindowIdentity(input);
  const requestHash = stableTrainingRevisionHash(identity);
  const idempotencyKey = input.idempotencyKey === undefined
    ? null
    : normalizeMutationKey(input.idempotencyKey);
  const receiptTenantId = idempotencyKey
    ? requireTenantIdParam(identity.tenantId, 'recordTravelWindow')
    : null;
  let result!: RecordTravelWindowResult;
  db.transaction(() => {
    if (idempotencyKey) {
      const replay = readTravelMutationReceipt(db, receiptTenantId!, identity.userId, idempotencyKey);
      if (replay) {
        assertTravelMutationReceipt(replay, 'create', requestHash);
        const stored = JSON.parse(replay.response_json) as Omit<RecordTravelWindowResult, 'alreadyExisted'>;
        result = { id: Number(stored.id), version: Number(stored.version), alreadyExisted: true };
        return;
      }
    }
    const existing = db.prepare(`
      SELECT id, COALESCE(version, 1) AS version FROM travel_windows
      WHERE user_id = ?
        AND tenant_id IS ?
        AND start_date = ?
        AND end_date = ?
        AND equipment_profile IS ?
        AND time_zone_shift_hours IS ?
        AND flight_duration_hours IS ?
        AND sleep_disruption_expected = ?
        AND walking_load_expected = ?
        AND heat_stress = ?
        AND available_session_duration_minutes IS ?
        AND notes IS ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(
      identity.userId,
      identity.tenantId,
      identity.startDate,
      identity.endDate,
      identity.equipmentProfile,
      identity.timeZoneShiftHours,
      identity.flightDurationHours,
      identity.sleepDisruptionExpected,
      identity.walkingLoadExpected,
      identity.heatStress,
      identity.availableSessionDurationMinutes,
      identity.notes,
    ) as { id: number; version: number } | undefined;
    if (existing) {
      result = { id: Number(existing.id), version: Number(existing.version), alreadyExisted: true };
    } else {
      const inserted = db.prepare(`
        INSERT INTO travel_windows (
          user_id, tenant_id, start_date, end_date, equipment_profile,
          time_zone_shift_hours, flight_duration_hours,
          sleep_disruption_expected, walking_load_expected, heat_stress,
          available_session_duration_minutes, notes, idempotency_key, request_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.userId,
        identity.tenantId,
        input.startDate,
        input.endDate,
        input.equipmentProfile ?? null,
        input.timeZoneShiftHours ?? null,
        input.flightDurationHours ?? null,
        input.sleepDisruptionExpected ? 1 : 0,
        input.walkingLoadExpected ? 1 : 0,
        input.heatStress ? 1 : 0,
        input.availableSessionDurationMinutes ?? null,
        identity.notes,
        idempotencyKey,
        requestHash,
      );
      result = { id: Number(inserted.lastInsertRowid), version: 1, alreadyExisted: false };
    }
    if (idempotencyKey) {
      recordTravelMutationReceipt(db, {
        tenantId: receiptTenantId!,
        userId: identity.userId,
        id: result.id,
        operation: 'create',
        key: idempotencyKey,
        requestHash,
        response: { id: result.id, version: result.version },
      });
    }
  })();
  logger.info({
    userId: input.userId,
    tenantId: identity.tenantId,
    startDate: input.startDate,
    endDate: input.endDate,
  }, result.alreadyExisted ? 'travel_window.replayed' : 'travel_window.recorded');
  return result;
}

function normalizeTravelWindowIdentity(input: RecordTravelWindowInput): {
  userId: number;
  tenantId: number | null;
  startDate: string;
  endDate: string;
  equipmentProfile: string | null;
  timeZoneShiftHours: number | null;
  flightDurationHours: number | null;
  sleepDisruptionExpected: number;
  walkingLoadExpected: number;
  heatStress: number;
  availableSessionDurationMinutes: number | null;
  notes: string | null;
} {
  return {
    userId: input.userId,
    tenantId: input.tenantId ?? null,
    startDate: input.startDate,
    endDate: input.endDate,
    equipmentProfile: input.equipmentProfile ?? null,
    timeZoneShiftHours: input.timeZoneShiftHours ?? null,
    flightDurationHours: input.flightDurationHours ?? null,
    sleepDisruptionExpected: input.sleepDisruptionExpected ? 1 : 0,
    walkingLoadExpected: input.walkingLoadExpected ? 1 : 0,
    heatStress: input.heatStress ? 1 : 0,
    availableSessionDurationMinutes: input.availableSessionDurationMinutes ?? null,
    notes: input.notes ?? null,
  };
}

/**
 * Find any travel window overlapping with a given date range. Returns
 * the most recently created when multiple overlap.
 */
export function findTravelWindowsInRange(
  userId: number,
  fromDate: string,
  toDate: string,
  tenantId?: number | null,
): TravelWindowRow[] {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'findTravelWindowsInRange');
  return db.prepare(`
    SELECT travel_windows.*, COALESCE(version, 1) AS version FROM travel_windows
    WHERE user_id = ?
      AND tenant_id = ?
      AND start_date <= ?
      AND end_date >= ?
    ORDER BY created_at DESC
  `).all(userId, scopedTenantId, toDate, fromDate) as TravelWindowRow[];
}

export function listTravelWindows(
  userId: number,
  tenantId: number,
  options: { fromDate?: string; toDate?: string; limit?: number } = {},
): TravelWindowRow[] {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'listTravelWindows');
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
  const clauses = ['user_id = ?', 'tenant_id = ?'];
  const params: Array<string | number> = [userId, scopedTenantId];
  if (options.fromDate) {
    clauses.push('end_date >= ?');
    params.push(options.fromDate);
  }
  if (options.toDate) {
    clauses.push('start_date <= ?');
    params.push(options.toDate);
  }
  params.push(limit);
  return db.prepare(`
    SELECT travel_windows.*, COALESCE(version, 1) AS version FROM travel_windows
    WHERE ${clauses.join(' AND ')}
    ORDER BY start_date ASC, id ASC
    LIMIT ?
  `).all(...params) as TravelWindowRow[];
}

export function getTravelWindowById(
  userId: number,
  tenantId: number,
  id: number,
): TravelWindowRow | null {
  const scopedTenantId = requireTenantIdParam(tenantId, 'getTravelWindowById');
  const row = getDb().prepare(`
    SELECT travel_windows.*, COALESCE(version, 1) AS version FROM travel_windows
    WHERE id = ? AND user_id = ? AND tenant_id = ?
  `).get(id, userId, scopedTenantId) as TravelWindowRow | undefined;
  return row ?? null;
}

export function updateTravelWindow(input: {
  userId: number;
  tenantId: number;
  id: number;
  expectedVersion: number;
  patch: Partial<Omit<RecordTravelWindowInput, 'userId' | 'tenantId' | 'idempotencyKey'>>;
}): TravelWindowRow | null {
  const db = getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'updateTravelWindow');
  const current = getTravelWindowById(input.userId, tenantId, input.id);
  if (!current) return null;
  if (current.version !== input.expectedVersion) {
    throw new TravelWindowVersionConflictError('Travel window version does not match If-Match.');
  }
  const next: RecordTravelWindowInput = {
    userId: input.userId,
    tenantId,
    startDate: input.patch.startDate ?? current.start_date,
    endDate: input.patch.endDate ?? current.end_date,
    equipmentProfile: input.patch.equipmentProfile ?? current.equipment_profile ?? undefined,
    timeZoneShiftHours: input.patch.timeZoneShiftHours ?? current.time_zone_shift_hours ?? undefined,
    flightDurationHours: input.patch.flightDurationHours ?? current.flight_duration_hours ?? undefined,
    sleepDisruptionExpected: input.patch.sleepDisruptionExpected ?? current.sleep_disruption_expected === 1,
    walkingLoadExpected: input.patch.walkingLoadExpected ?? current.walking_load_expected === 1,
    heatStress: input.patch.heatStress ?? current.heat_stress === 1,
    availableSessionDurationMinutes:
      input.patch.availableSessionDurationMinutes ?? current.available_session_duration_minutes ?? undefined,
    notes: input.patch.notes ?? current.notes ?? undefined,
  };
  validateTravelWindowInput(next);
  const changed = db.prepare(`
    UPDATE travel_windows SET
      start_date = ?, end_date = ?, equipment_profile = ?,
      time_zone_shift_hours = ?, flight_duration_hours = ?,
      sleep_disruption_expected = ?, walking_load_expected = ?, heat_stress = ?,
      available_session_duration_minutes = ?, notes = ?,
      version = COALESCE(version, 1) + 1, updated_at = ?
    WHERE id = ? AND user_id = ? AND tenant_id = ? AND COALESCE(version, 1) = ?
  `).run(
    next.startDate,
    next.endDate,
    next.equipmentProfile ?? null,
    next.timeZoneShiftHours ?? null,
    next.flightDurationHours ?? null,
    next.sleepDisruptionExpected ? 1 : 0,
    next.walkingLoadExpected ? 1 : 0,
    next.heatStress ? 1 : 0,
    next.availableSessionDurationMinutes ?? null,
    next.notes ?? null,
    new Date().toISOString(),
    input.id,
    input.userId,
    tenantId,
    input.expectedVersion,
  );
  if (changed.changes !== 1) {
    throw new TravelWindowVersionConflictError('Travel window changed before the update could be applied.');
  }
  return getTravelWindowById(input.userId, tenantId, input.id);
}

export function deleteTravelWindow(input: {
  userId: number;
  tenantId: number;
  id: number;
  expectedVersion: number;
}): boolean {
  const tenantId = requireTenantIdParam(input.tenantId, 'deleteTravelWindow');
  const current = getTravelWindowById(input.userId, tenantId, input.id);
  if (!current) return false;
  if (current.version !== input.expectedVersion) {
    throw new TravelWindowVersionConflictError('Travel window version does not match If-Match.');
  }
  const result = getDb().prepare(`
    DELETE FROM travel_windows
    WHERE id = ? AND user_id = ? AND tenant_id = ? AND COALESCE(version, 1) = ?
  `).run(input.id, input.userId, tenantId, input.expectedVersion);
  if (result.changes !== 1) {
    throw new TravelWindowVersionConflictError('Travel window changed before it could be deleted.');
  }
  return true;
}

export function updateTravelWindowIdempotently(input: {
  userId: number;
  tenantId: number;
  id: number;
  expectedVersion: number;
  patch: Partial<Omit<RecordTravelWindowInput, 'userId' | 'tenantId' | 'idempotencyKey'>>;
  idempotencyKey: string;
}): { window: TravelWindowRow; replayed: boolean } {
  const db = getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'updateTravelWindowIdempotently');
  const key = normalizeMutationKey(input.idempotencyKey);
  const requestHash = stableTrainingRevisionHash({
    operation: 'patch', id: input.id, expectedVersion: input.expectedVersion, patch: input.patch,
  });
  const replay = readTravelMutationReceipt(db, tenantId, input.userId, key);
  if (replay) {
    assertTravelMutationReceipt(replay, 'patch', requestHash);
    return { window: JSON.parse(replay.response_json) as TravelWindowRow, replayed: true };
  }
  let window!: TravelWindowRow;
  db.transaction(() => {
    const updated = updateTravelWindow(input);
    if (!updated) throw new Error('TRAVEL_WINDOW_NOT_FOUND');
    window = updated;
    recordTravelMutationReceipt(db, {
      tenantId,
      userId: input.userId,
      id: input.id,
      operation: 'patch',
      key,
      requestHash,
      response: window,
    });
  })();
  return { window, replayed: false };
}

export function deleteTravelWindowIdempotently(input: {
  userId: number;
  tenantId: number;
  id: number;
  expectedVersion: number;
  idempotencyKey: string;
}): { deleted: boolean; replayed: boolean } {
  const db = getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'deleteTravelWindowIdempotently');
  const key = normalizeMutationKey(input.idempotencyKey);
  const requestHash = stableTrainingRevisionHash({
    operation: 'delete', id: input.id, expectedVersion: input.expectedVersion,
  });
  const replay = readTravelMutationReceipt(db, tenantId, input.userId, key);
  if (replay) {
    assertTravelMutationReceipt(replay, 'delete', requestHash);
    return { deleted: (JSON.parse(replay.response_json) as { deleted: boolean }).deleted, replayed: true };
  }
  let deleted = false;
  db.transaction(() => {
    deleted = deleteTravelWindow(input);
    recordTravelMutationReceipt(db, {
      tenantId,
      userId: input.userId,
      id: input.id,
      operation: 'delete',
      key,
      requestHash,
      response: { deleted },
    });
  })();
  return { deleted, replayed: false };
}

function normalizeMutationKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 160) throw new TravelWindowIdempotencyConflictError('A valid Idempotency-Key is required.');
  return key;
}

function validateTravelWindowInput(input: RecordTravelWindowInput): void {
  if (!strictIsoDate(input.startDate) || !strictIsoDate(input.endDate)) {
    throw new Error('BAD_TRAVEL_INPUT: startDate and endDate must be valid YYYY-MM-DD calendar dates.');
  }
  const start = Date.parse(`${input.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${input.endDate}T00:00:00.000Z`);
  if (start > end) throw new Error('BAD_TRAVEL_INPUT: startDate must be on or before endDate.');
  if (Math.floor((end - start) / 86_400_000) > 366) {
    throw new Error('BAD_TRAVEL_INPUT: a travel window cannot exceed 366 days.');
  }
  if (input.equipmentProfile !== undefined
      && (!input.equipmentProfile.trim() || input.equipmentProfile.length > 64)) {
    throw new Error('BAD_TRAVEL_INPUT: equipmentProfile must contain 1 to 64 characters.');
  }
  boundedNumber(input.timeZoneShiftHours, -14, 14, 'timeZoneShiftHours');
  boundedNumber(input.flightDurationHours, 0, 48, 'flightDurationHours');
  boundedNumber(input.availableSessionDurationMinutes, 10, 360, 'availableSessionDurationMinutes', true);
  if (input.notes !== undefined && input.notes.length > 500) {
    throw new Error('BAD_TRAVEL_INPUT: notes cannot exceed 500 characters.');
  }
}

function strictIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function boundedNumber(
  value: number | undefined,
  min: number,
  max: number,
  field: string,
  integer = false,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`BAD_TRAVEL_INPUT: ${field} must be ${integer ? 'an integer' : 'a number'} from ${min} through ${max}.`);
  }
}

function readTravelMutationReceipt(
  db: ReturnType<typeof getDb>,
  tenantId: number,
  userId: number,
  key: string,
): { operation: 'create' | 'patch' | 'delete'; request_hash: string; response_json: string } | null {
  return (db.prepare(`
    SELECT operation, request_hash, response_json FROM travel_window_mutation_receipts
    WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
  `).get(tenantId, userId, key) as {
    operation: 'create' | 'patch' | 'delete';
    request_hash: string;
    response_json: string;
  } | undefined) ?? null;
}

function assertTravelMutationReceipt(
  receipt: { operation: 'create' | 'patch' | 'delete'; request_hash: string },
  operation: 'create' | 'patch' | 'delete',
  requestHash: string,
): void {
  if (receipt.operation !== operation || receipt.request_hash !== requestHash) {
    throw new TravelWindowIdempotencyConflictError(
      'Idempotency-Key belongs to a different travel mutation.',
    );
  }
}

function recordTravelMutationReceipt(
  db: ReturnType<typeof getDb>,
  input: {
    tenantId: number;
    userId: number;
    id: number;
    operation: 'create' | 'patch' | 'delete';
    key: string;
    requestHash: string;
    response: unknown;
  },
): void {
  db.prepare(`
    INSERT INTO travel_window_mutation_receipts (
      tenant_id, user_id, travel_window_id, operation,
      idempotency_key, request_hash, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.tenantId,
    input.userId,
    input.id,
    input.operation,
    input.key,
    input.requestHash,
    JSON.stringify(input.response),
  );
}

/**
 * Compute the travel-stress score for a date — a unitless [0..1]
 * score combining the optional flags. Used by C8 to gate intensity.
 */
export function computeTravelStressScore(window: TravelWindowRow): number {
  let score = 0;
  if (window.flight_duration_hours && window.flight_duration_hours > 4) score += 0.2;
  if (window.time_zone_shift_hours && Math.abs(window.time_zone_shift_hours) > 3) score += 0.25;
  if (window.sleep_disruption_expected) score += 0.20;
  if (window.walking_load_expected) score += 0.15;
  if (window.heat_stress) score += 0.20;
  return Math.min(1, score);
}
