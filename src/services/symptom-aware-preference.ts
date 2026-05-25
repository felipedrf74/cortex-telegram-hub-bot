// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Symptom-aware session preferences — slice B4b of the Week-Level
 * Adaptability + Periodization plan (v2.1).
 *
 * Stores user-declared intensity preferences for a given date with a
 * tagged reason (e.g., 'menstrual_symptom', 'travel_fatigue').
 * Engines (C8) consume these as soft signals that modulate the
 * intensity ceiling for that day, never overriding safety.
 *
 * Critical posture (per v2.1 critique):
 *
 *   - Symptom-aware, NOT phase-predictive. We never infer the
 *     athlete's cycle phase from calendar estimates.
 *   - Opt-in. Users with menstrual-symptom reasons must have the
 *     'menstrual' consent scope on their health-signal events
 *     (A0c); the application enforces this at the read layer.
 *   - Algorithmic modulation deferred. This module CAPTURES the
 *     preference; downstream code applies it as a soft override
 *     without claiming predictive power.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export type IntensityPreference = 'lower_intensity' | 'standard' | 'higher_intensity';

export interface SessionPreferenceRow {
  id: number;
  user_id: number;
  date: string;
  intensity_preference: IntensityPreference;
  reason_tag: string | null;
  notes: string | null;
  created_at: string;
}

export interface RecordPreferenceInput {
  userId: number;
  date: string;
  intensityPreference: IntensityPreference;
  reasonTag?: string;
  notes?: string;
}

/**
 * Record a session preference. Defensively normalizes inputs and
 * logs the capture for support diagnostics.
 */
export function recordSessionPreference(
  input: RecordPreferenceInput,
): { id: number } {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO athlete_session_preferences
      (user_id, date, intensity_preference, reason_tag, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.userId,
    input.date,
    input.intensityPreference,
    input.reasonTag ?? null,
    input.notes ?? null,
  );
  if (input.reasonTag) {
    logger.info(
      { userId: input.userId, reasonTag: input.reasonTag, preference: input.intensityPreference },
      'symptom_aware_preference.recorded',
    );
  }
  return { id: Number(inserted.lastInsertRowid) };
}

/**
 * Fetch the preference for a specific date, if any.
 */
export function getPreferenceForDate(
  userId: number,
  date: string,
): SessionPreferenceRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM athlete_session_preferences
    WHERE user_id = ? AND date = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(userId, date) as SessionPreferenceRow | undefined;
  return row ?? null;
}

/**
 * Fetch preferences in a date range.
 */
export function getPreferencesInRange(
  userId: number,
  fromDate: string,
  toDate: string,
): SessionPreferenceRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM athlete_session_preferences
    WHERE user_id = ? AND date BETWEEN ? AND ?
    ORDER BY date DESC, created_at DESC
  `).all(userId, fromDate, toDate) as SessionPreferenceRow[];
}

/**
 * Delete all preferences for a user. Called by the A4p delete-history
 * cascade when the user requests history deletion.
 */
export function deletePreferenceHistoryForUser(userId: number): number {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM athlete_session_preferences WHERE user_id = ?',
  ).run(userId);
  return result.changes;
}
