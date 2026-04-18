// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Coach Phase Memory — durable, per-user training coach narrative state.
 *
 * Before this module, every coach briefing was generated from a fresh
 * snapshot of the current session list, adherence percentage, and readiness
 * signals. The model had no memory of:
 *   - what macro phase the athlete is currently in (base / build / peak / taper / recovery)
 *   - when the last deload landed and why
 *   - the adherence TREND across weeks (up / down / flat)
 *   - any ongoing injury / overtraining narrative the coach chose to carry
 *   - the expected next shift (e.g. "week 3 of 6, deload scheduled end of week 4")
 *
 * Result: coach advice whiplashed week-over-week. A normal taper dip in
 * adherence would read as "adherence falling" and trigger a defensive
 * deload, when the *plan* already prescribed the taper. A volume bump
 * after a recovery week would read as "sudden high load" and be flagged
 * as risk, when it was the intended step. The remedy is a persistent
 * narrative document the coach consults before interpreting this week's
 * signals.
 *
 * Storage: piggybacks on the existing `report_documents` table (type =
 * `coach_phase`). No new DB migration needed — the table already holds
 * JSON payloads scoped per user, and `getLatestByType` gives us the
 * "current" phase doc in O(1). The coach briefing generator can update
 * the doc when its decision meaningfully changes, not on every call.
 *
 * Consumers:
 *   - `cross-agent-learning.readTrainingMeshContext` merges the latest
 *     phase doc into `TrainingMeshContext.coachPhaseMemory` so the
 *     shared-decision-context builder and the LLM-facing prompts have
 *     it alongside the current briefing.
 *   - Future: weekly coach reviewer, taper reminders, deload warnings.
 *
 * Not in scope for this module:
 *   - Automatic phase detection from session history. That logic lives
 *     in the coach-briefing generator (which has the full plan + Garmin
 *     context already). This module is storage + retrieval only.
 *   - APNs push on phase transitions — the coach briefing delivery
 *     channel handles that when it writes a new phase.
 */

import { storeReport, getLatestByType, type ReportDocument } from './report-document-store';
import { logger } from '../utils/logger';

export type TrainingMacroPhase =
  | 'base'        // aerobic / capacity building
  | 'build'       // progressive specific intensity
  | 'peak'        // sharpening toward a target event
  | 'taper'       // deliberate volume reduction before a key event
  | 'recovery'    // structured post-event / post-block downtime
  | 'transition'; // open-ended block without a specific macro intent

export type AdherenceTrend = 'improving' | 'steady' | 'declining' | 'unknown';

export interface CoachPhaseMemory {
  /** Macro phase the athlete is currently in. */
  phase: TrainingMacroPhase;
  /** 1-based week within the macro phase, if known. */
  weekInPhase?: number;
  /** Total weeks planned in the current macro phase, if known. */
  phaseTotalWeeks?: number;
  /** Human-readable phase narrative the coach chose to carry.
   *  e.g. "Transitioning from running emphasis to balanced with 2×bike/week.
   *  Expect soreness Wed–Thu." */
  narrative: string;
  /** Dates (YYYY-MM-DD) of deloads in the last ~4 weeks, most recent first.
   *  Helps the coach avoid re-interpreting a planned deload as a regression. */
  recentDeloadDates?: string[];
  /** Adherence trend across the last ~4 weeks. */
  adherenceTrend?: AdherenceTrend;
  /** Open injury or overtraining narrative the coach is tracking.
   *  Nullable — most weeks this will be absent. */
  activeConcern?: string | null;
  /** The next shift the coach anticipates, free text.
   *  e.g. "Deload end of week 4 if adherence stays ≥ 80%." */
  nextExpectedShift?: string | null;
  /** ISO timestamp of when this phase snapshot was written. */
  writtenAt: string;
}

/**
 * Persist the current coach phase narrative for a user. Returns the
 * stored report id, or -1 if tenant scoping is invalid.
 *
 * Idempotent by nature of the underlying report_documents table:
 * successive calls append new rows rather than updating in-place. This
 * is intentional — it preserves a narrative history so an auditor can
 * see how the coach's reading of the athlete has evolved. Readers use
 * `getCurrentCoachPhase()` which always returns the latest row.
 */
export function writeCoachPhaseMemory(userId: number, memory: CoachPhaseMemory): number {
  const title = memory.weekInPhase && memory.phaseTotalWeeks
    ? `Coach phase: ${memory.phase} (week ${memory.weekInPhase}/${memory.phaseTotalWeeks})`
    : `Coach phase: ${memory.phase}`;
  const summary = memory.narrative.slice(0, 280);
  const id = storeReport({
    userId,
    type: 'coach_phase',
    title,
    summary,
    documentJson: memory as unknown as Record<string, any>,
    sourceJob: 'coach-phase-memory',
  });
  if (id > 0) {
    logger.info(
      { userId, phase: memory.phase, weekInPhase: memory.weekInPhase ?? null },
      'Coach phase memory written',
    );
  }
  return id;
}

/**
 * Return the latest coach phase memory for a user, or null if none
 * has been written yet (first-run athletes, or users on a plan that
 * predates I6 coach-memory instrumentation).
 *
 * Callers should treat null as "no narrative available" and fall
 * back to stateless interpretation of this week's signals.
 */
export function getCurrentCoachPhase(userId: number): CoachPhaseMemory | null {
  const doc: ReportDocument | null = getLatestByType(userId, 'coach_phase');
  if (!doc || !doc.documentJson) return null;
  const raw = doc.documentJson as Partial<CoachPhaseMemory> & { writtenAt?: string };
  if (typeof raw.phase !== 'string' || typeof raw.narrative !== 'string') return null;
  return {
    phase: raw.phase as TrainingMacroPhase,
    narrative: raw.narrative,
    weekInPhase: typeof raw.weekInPhase === 'number' ? raw.weekInPhase : undefined,
    phaseTotalWeeks: typeof raw.phaseTotalWeeks === 'number' ? raw.phaseTotalWeeks : undefined,
    recentDeloadDates: Array.isArray(raw.recentDeloadDates)
      ? raw.recentDeloadDates.filter((d): d is string => typeof d === 'string')
      : undefined,
    adherenceTrend: raw.adherenceTrend,
    activeConcern: raw.activeConcern ?? null,
    nextExpectedShift: raw.nextExpectedShift ?? null,
    writtenAt: raw.writtenAt ?? doc.createdAt,
  };
}

/**
 * Format the phase memory as a short narrative block suitable for
 * inclusion in an LLM system prompt. Returns an empty string when no
 * memory exists so the prompt builder can concat unconditionally.
 *
 * Kept compact (≤ ~500 chars) so it doesn't dominate the prompt budget.
 */
export function formatCoachPhaseForPrompt(memory: CoachPhaseMemory | null): string {
  if (!memory) return '';
  const parts: string[] = [];
  parts.push(
    memory.weekInPhase && memory.phaseTotalWeeks
      ? `Macro phase: ${memory.phase} (week ${memory.weekInPhase} of ${memory.phaseTotalWeeks}).`
      : `Macro phase: ${memory.phase}.`,
  );
  if (memory.adherenceTrend) parts.push(`Adherence trend: ${memory.adherenceTrend}.`);
  if (memory.recentDeloadDates?.length) {
    parts.push(`Recent deload(s): ${memory.recentDeloadDates.slice(0, 3).join(', ')}.`);
  }
  if (memory.activeConcern) parts.push(`Active concern: ${memory.activeConcern}.`);
  if (memory.nextExpectedShift) parts.push(`Next expected shift: ${memory.nextExpectedShift}.`);
  if (memory.narrative) parts.push(`Narrative: ${memory.narrative}`);
  return parts.join(' ');
}
