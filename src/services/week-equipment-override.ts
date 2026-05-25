// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-week equipment override — slice C3 of the Week-Level
 * Adaptability + Periodization plan (v2.1).
 *
 * Thin layer around the `training_weeks.equipment_override_json`
 * column. Used by the planner to substitute the athlete's standing
 * equipmentAccess for a single week (typical use: travel week with
 * hotel-room-only equipment).
 *
 * The override JSON shape mirrors the existing EquipmentAccess type:
 *   { fullGym?: boolean, dumbbells?: boolean, kettlebells?: boolean,
 *     pullupBar?: boolean, bands?: boolean, treadmill?: boolean, ... }
 *
 * When the override is set, the engine reads it as the source of
 * truth for that week instead of the athlete's profile.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export type EquipmentOverrideShape = Record<string, boolean>;

export function setWeekEquipmentOverride(
  weekId: number,
  override: EquipmentOverrideShape | null,
): { changes: number } {
  const db = getDb();
  const result = db.prepare(
    'UPDATE training_weeks SET equipment_override_json = ? WHERE id = ?',
  ).run(override === null ? null : JSON.stringify(override), weekId);
  return { changes: result.changes };
}

export function getWeekEquipmentOverride(
  weekId: number,
): EquipmentOverrideShape | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT equipment_override_json FROM training_weeks WHERE id = ?',
  ).get(weekId) as { equipment_override_json: string | null } | undefined;
  if (!row || !row.equipment_override_json) return null;
  try {
    return JSON.parse(row.equipment_override_json) as EquipmentOverrideShape;
  } catch (err) {
    // R8 P1-3 — a corrupt JSON in the DB column is NOT the same as
    // "no override stored." Returning null silently in both cases
    // makes the user's travel/equipment override invisibly disappear.
    // Surface to operator logs so SRE can spot recurring corruption.
    logger.warn(
      { weekId, err },
      'week_equipment_override.parse_failed',
    );
    return null;
  }
}

export function clearWeekEquipmentOverride(weekId: number): { changes: number } {
  return setWeekEquipmentOverride(weekId, null);
}
