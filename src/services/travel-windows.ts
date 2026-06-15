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
}

export interface RecordTravelWindowResult {
  id: number;
  alreadyExisted: boolean;
}

export function recordTravelWindow(input: RecordTravelWindowInput): RecordTravelWindowResult {
  if (Date.parse(input.startDate) > Date.parse(input.endDate)) {
    throw new Error('recordTravelWindow: startDate must be ≤ endDate');
  }
  const db = getDb();
  const identity = normalizeTravelWindowIdentity(input);
  const existing = db.prepare(`
    SELECT id FROM travel_windows
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
  ) as { id: number } | undefined;
  if (existing) {
    logger.info({
      userId: input.userId,
      tenantId: identity.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
    }, 'travel_window.replayed');
    return { id: Number(existing.id), alreadyExisted: true };
  }
  const inserted = db.prepare(`
    INSERT INTO travel_windows (
      user_id, tenant_id, start_date, end_date, equipment_profile,
      time_zone_shift_hours, flight_duration_hours,
      sleep_disruption_expected, walking_load_expected, heat_stress,
      available_session_duration_minutes, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.userId,
    input.tenantId ?? null,
    input.startDate,
    input.endDate,
    input.equipmentProfile ?? null,
    input.timeZoneShiftHours ?? null,
    input.flightDurationHours ?? null,
    input.sleepDisruptionExpected ? 1 : 0,
    input.walkingLoadExpected ? 1 : 0,
    input.heatStress ? 1 : 0,
    input.availableSessionDurationMinutes ?? null,
    input.notes ?? null,
  );
  logger.info({
    userId: input.userId,
    tenantId: identity.tenantId,
    startDate: input.startDate,
    endDate: input.endDate,
  }, 'travel_window.recorded');
  return { id: Number(inserted.lastInsertRowid), alreadyExisted: false };
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
  const tenantScoped = typeof tenantId === 'number' && Number.isFinite(tenantId);
  if (tenantScoped) {
    return db.prepare(`
      SELECT * FROM travel_windows
      WHERE user_id = ?
        AND tenant_id = ?
        AND start_date <= ?
        AND end_date >= ?
      ORDER BY created_at DESC
    `).all(userId, tenantId, toDate, fromDate) as TravelWindowRow[];
  }
  return db.prepare(`
    SELECT * FROM travel_windows
    WHERE user_id = ?
      AND start_date <= ?
      AND end_date >= ?
    ORDER BY created_at DESC
  `).all(userId, toDate, fromDate) as TravelWindowRow[];
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
