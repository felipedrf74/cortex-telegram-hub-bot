// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CoachRecommendation } from '../services/garmin-coach';
import { getDb } from '../services/database';
import { logger } from '../utils/logger';

export interface PersistedCoachState {
  recommendations: CoachRecommendation[];
  briefingSummary: string;
  timestamp: number;
  expiresAt: number;
}

interface CoachStateRow {
  recommendations_json: string;
  briefing_summary: string;
  created_at_ms: number;
  expires_at_ms: number;
}

function getDbSafe() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

export function saveCoachState(
  userId: number,
  recommendations: CoachRecommendation[],
  briefingSummary: string,
  timestamp: number,
  ttlMs: number,
): void {
  const db = getDbSafe();
  if (!db) return;

  try {
    db.prepare(`
      INSERT INTO coach_states (
        user_id,
        recommendations_json,
        briefing_summary,
        created_at_ms,
        expires_at_ms
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        recommendations_json = excluded.recommendations_json,
        briefing_summary = excluded.briefing_summary,
        created_at_ms = excluded.created_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        updated_at = datetime('now')
    `).run(
      userId,
      JSON.stringify(recommendations),
      briefingSummary,
      timestamp,
      timestamp + ttlMs,
    );
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to persist coach state');
  }
}

export function loadCoachState(userId: number, nowMs = Date.now()): PersistedCoachState | null {
  const db = getDbSafe();
  if (!db) return null;

  const row = db.prepare(`
    SELECT recommendations_json, briefing_summary, created_at_ms, expires_at_ms
    FROM coach_states
    WHERE user_id = ?
  `).get(userId) as CoachStateRow | undefined;

  if (!row) return null;

  if (row.expires_at_ms <= nowMs) {
    deleteCoachState(userId);
    return null;
  }

  try {
    const recommendations = JSON.parse(row.recommendations_json) as CoachRecommendation[];
    if (!Array.isArray(recommendations)) {
      throw new Error('Coach recommendations payload is not an array');
    }

    return {
      recommendations,
      briefingSummary: row.briefing_summary,
      timestamp: row.created_at_ms,
      expiresAt: row.expires_at_ms,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Persisted coach state payload is invalid — dropping row');
    deleteCoachState(userId);
    return null;
  }
}

export function deleteCoachState(userId: number): void {
  const db = getDbSafe();
  if (!db) return;
  db.prepare('DELETE FROM coach_states WHERE user_id = ?').run(userId);
}

export function pruneExpiredCoachStates(nowMs = Date.now()): number {
  const db = getDbSafe();
  if (!db) return 0;
  return db.prepare('DELETE FROM coach_states WHERE expires_at_ms <= ?').run(nowMs).changes;
}
