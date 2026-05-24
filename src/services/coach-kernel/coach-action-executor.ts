// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Coach action executor — Codex R2 P1 fix.
 *
 * Translates the typed `CoachAction[]` discriminated union (slice C8)
 * into actual `training_sessions` / `fitness_training_plans`
 * mutations. Designed to be called from inside the `executeWeekReflow`
 * transaction so the row mutations + adaptation ledger insert + plan
 * revision bump all commit or rollback together.
 *
 * Each action type maps to a single SQL UPDATE (or a no-op when the
 * action doesn't have a structural meaning for the v1 schema):
 *
 *   - drop_session         → UPDATE training_sessions SET status='skipped'
 *   - move_session         → UPDATE training_sessions SET day_of_week=?
 *   - scale_volume         → UPDATE training_sessions SET duration_minutes=round(d*m)
 *   - downgrade_intensity  → UPDATE training_sessions SET intensity_text=?
 *   - pause_training       → UPDATE fitness_training_plans SET status='paused'
 *   - swap_exercise        → no-op (deferred; exercises_json mutation is non-trivial)
 *   - insert_recovery_day  → no-op (deferred; requires inserting a new row)
 *
 * Skipped/deferred actions return 0 mutated rows AND log a debug
 * entry so support can confirm which adapt-types are not yet
 * executable. This avoids silently dropping actions on the floor.
 */

import type Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import type { CoachAction } from './scenario-classifier';
import {
  actionableStatusesSqlList,
  isActionableSessionStatus,
} from './session-status';

// R4 P2 fix — single source of truth for the "do not rewrite this
// row" guard. Replaces four hand-rolled `NOT IN ('completed',
// 'skipped', 'moved')` clauses + one in-memory triple-OR with the
// canonical list from session-status.ts.
//
// R5 P2 fix — Codex caught that the executor used the *terminal
// denylist* (`status NOT IN ('completed','skipped','moved')`) at the
// final mutation boundary. session-status.ts explicitly says any
// unknown status (e.g. a future 'cancelled' or 'archived') is
// non-actionable, so the denylist would let the executor mutate a
// row whose status the rest of the system would skip. Switching to
// the actionable allowlist (`status IN ('pending','scheduled')`) at
// the SQL boundary closes that gap.
const ACTIONABLE_SQL_LIST = actionableStatusesSqlList();

const DAY_NAMES: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

/** Normalize a day-of-week string to the canonical `Monday` form. */
function normalizeDay(value: string): string {
  return DAY_NAMES[value.toLowerCase()] ?? value;
}

export interface ExecuteCoachActionsInput {
  /** Plan id the actions apply to. The executor verifies plan_id on each session mutation. */
  planId: number;
  actions: readonly CoachAction[];
}

export interface ExecuteCoachActionsResult {
  /** Total rows mutated across `training_sessions` + `fitness_training_plans`. */
  mutatedRows: number;
  /** Per-action breakdown — useful for the ledger after_patch_json. */
  perActionResults: Array<{
    action: CoachAction;
    mutatedRows: number;
    skipped: boolean;
    skipReason?: string;
  }>;
}

/**
 * Apply a CoachAction[] to the database. Caller MUST invoke this
 * inside an open transaction (the `executeWeekReflow` callback does
 * exactly that) so a throw from any single UPDATE rolls the whole
 * apply back.
 *
 * Each `drop_session` / `move_session` / `scale_volume` /
 * `downgrade_intensity` action ONLY mutates a session row when:
 *   - The session id parses to a positive integer.
 *   - The row exists AND belongs to the supplied `planId`.
 *
 * This prevents a CoachAction with a forged sessionId from mutating
 * another plan's session row in the (unlikely) event the upstream
 * classifier produces foreign IDs.
 */
export function executeCoachActions(
  db: Database.Database,
  input: ExecuteCoachActionsInput,
): ExecuteCoachActionsResult {
  let mutatedRows = 0;
  const perActionResults: ExecuteCoachActionsResult['perActionResults'] = [];

  for (const action of input.actions) {
    const r = executeOne(db, input.planId, action);
    mutatedRows += r.mutatedRows;
    perActionResults.push(r);
  }

  return { mutatedRows, perActionResults };
}

function executeOne(
  db: Database.Database,
  planId: number,
  action: CoachAction,
): ExecuteCoachActionsResult['perActionResults'][number] {
  switch (action.type) {
    case 'drop_session': {
      const id = parseSessionId(action.sessionId);
      if (id === null) return skip(action, 'invalid_session_id');
      // R3 P1 fix — never rewrite completed/skipped/moved history.
      const r = db.prepare(`
        UPDATE training_sessions
        SET status = 'skipped', updated_at = datetime('now')
        WHERE id = ? AND plan_id = ?
          AND status IN (${ACTIONABLE_SQL_LIST})
      `).run(id, planId);
      if (r.changes === 0) return skip(action, 'session_not_actionable');
      return { action, mutatedRows: r.changes, skipped: false };
    }
    case 'move_session': {
      const id = parseSessionId(action.sessionId);
      if (id === null) return skip(action, 'invalid_session_id');
      // toDate is an ISO date; map it to the day-of-week name for the
      // existing schema (training_sessions.day_of_week is a string).
      const dt = Date.parse(action.toDate);
      if (!Number.isFinite(dt)) return skip(action, 'invalid_to_date');
      const dayIdx = new Date(dt).getUTCDay(); // 0=Sun..6=Sat
      const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayIdx];
      const r = db.prepare(`
        UPDATE training_sessions
        SET day_of_week = ?, status = 'moved', updated_at = datetime('now')
        WHERE id = ? AND plan_id = ?
          AND status IN (${ACTIONABLE_SQL_LIST})
      `).run(normalizeDay(dayName), id, planId);
      if (r.changes === 0) return skip(action, 'session_not_actionable');
      return { action, mutatedRows: r.changes, skipped: false };
    }
    case 'scale_volume': {
      const id = parseSessionId(action.sessionId);
      if (id === null) return skip(action, 'invalid_session_id');
      if (!Number.isFinite(action.multiplier) || action.multiplier <= 0) {
        return skip(action, 'invalid_multiplier');
      }
      const row = db.prepare(
        'SELECT duration_minutes, status FROM training_sessions WHERE id = ? AND plan_id = ?',
      ).get(id, planId) as { duration_minutes: number | null; status: string } | undefined;
      if (!row) return skip(action, 'session_not_found_or_foreign');
      if (!isActionableSessionStatus(row.status)) {
        // R5 P2 fix — flip the in-memory check to the actionable
        // allowlist so future-added non-actionable statuses (e.g.
        // 'cancelled', 'archived') stay protected without needing a
        // dedicated denylist update.
        return skip(action, 'session_not_actionable');
      }
      const original = row.duration_minutes ?? 0;
      const scaled = Math.max(1, Math.round(original * action.multiplier));
      const r = db.prepare(`
        UPDATE training_sessions
        SET duration_minutes = ?, updated_at = datetime('now')
        WHERE id = ? AND plan_id = ?
          AND status IN (${ACTIONABLE_SQL_LIST})
      `).run(scaled, id, planId);
      if (r.changes === 0) return skip(action, 'session_not_actionable');
      return { action, mutatedRows: r.changes, skipped: false };
    }
    case 'downgrade_intensity': {
      const id = parseSessionId(action.sessionId);
      if (id === null) return skip(action, 'invalid_session_id');
      const newText = `cap@${action.targetCeiling}`;
      const r = db.prepare(`
        UPDATE training_sessions
        SET intensity_text = ?, updated_at = datetime('now')
        WHERE id = ? AND plan_id = ?
          AND status IN (${ACTIONABLE_SQL_LIST})
      `).run(newText, id, planId);
      if (r.changes === 0) return skip(action, 'session_not_actionable');
      return { action, mutatedRows: r.changes, skipped: false };
    }
    case 'pause_training': {
      // Plan-scoped action.
      const r = db.prepare(`
        UPDATE fitness_training_plans
        SET status = 'paused', updated_at = datetime('now')
        WHERE id = ?
      `).run(planId);
      return { action, mutatedRows: r.changes, skipped: false };
    }
    case 'swap_exercise':
      return skip(action, 'exercises_json_mutation_deferred');
    case 'insert_recovery_day':
      return skip(action, 'insert_session_deferred');
    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = action;
      void _exhaustive;
      return skip({ type: 'pause_training', reasonCode: 'unknown', severity: 'pause' } as CoachAction, 'unknown_action_type');
    }
  }
}

function skip(action: CoachAction, reason: string): ExecuteCoachActionsResult['perActionResults'][number] {
  logger.debug({ actionType: action.type, reason }, 'coach_action_executor.skipped');
  return { action, mutatedRows: 0, skipped: true, skipReason: reason };
}

function parseSessionId(value: string): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
