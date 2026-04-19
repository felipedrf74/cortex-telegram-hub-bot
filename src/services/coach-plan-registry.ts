// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Module-level singleton that retains the *raw* deterministic `WeeklyPlan`
 * objects produced by `buildCoachKernelTrainingPlan`, keyed by
 * (athleteId, weekStart). Each entry also stores the AthleteState that
 * generated the plan, which the home-view route needs to re-run
 * `adjustForFatigue` against today's live readiness.
 *
 * Motivation — the legacy `CoordinatedTrainingPlan` shape that the
 * generator currently returns discards `WeeklyPlan.guardrailResults` and
 * `WeeklyPlan.notes`. Those two fields carry the authoritative "what did
 * the coach change and why" story that the iOS `WeekProtectionModel`
 * surfaces via `kernelAdjustments`. Before this registry existed, that
 * reasoning was effectively write-only: the kernel computed it, the
 * converter threw it away, and the UI had to infer equivalents from the
 * LLM briefing (which is lossy and can drift from the deterministic plan).
 *
 * The registry is intentionally in-memory only. On process restart the
 * next plan generation will re-emit the guardrails — and the screen
 * contract's `isStale` flag already communicates "data older than
 * expected" to the client. If we later need cross-restart durability we
 * can add a SQLite-backed implementation behind the same `CoachPlanStore`
 * interface without touching callers.
 */

import { InMemoryCoachPlanStore, type CoachPlanStore, type StoredCoachPlan } from './coach-kernel/stores/in-memory-plan-store';
import type { AthleteState, WeeklyPlan } from './coach-kernel/types';

export type { StoredCoachPlan } from './coach-kernel/stores/in-memory-plan-store';

let store: CoachPlanStore = new InMemoryCoachPlanStore();

/** Swap the backing store — used by tests to get isolation. */
export function _setCoachPlanStoreForTests(next: CoachPlanStore): void {
  store = next;
}

/** Reset to a fresh in-memory store — used by tests between cases. */
export function _resetCoachPlanStoreForTests(): void {
  store = new InMemoryCoachPlanStore();
}

/** Persist a WeeklyPlan + its producing AthleteState so the home-view
 *  route can read guardrails *and* re-run fatigue adjustment later. */
export function recordWeeklyPlan(plan: WeeklyPlan, athleteState: AthleteState): StoredCoachPlan {
  return store.save({ plan, athleteState });
}

/** Look up a specific stored entry by athlete + week-start date. */
export function getStoredPlanForWeek(athleteId: number, weekStart: string): StoredCoachPlan | null {
  return store.get(athleteId, weekStart);
}

/** Back-compat convenience: just the WeeklyPlan for callers that don't
 *  need the AthleteState. */
export function getWeeklyPlanForWeek(athleteId: number, weekStart: string): WeeklyPlan | null {
  return store.get(athleteId, weekStart)?.plan ?? null;
}

/**
 * Pick the stored entry that contains `date` (YYYY-MM-DD). We scan
 * all stored weeks for this athlete and return the one whose
 * `weekStart..+6d` range includes `date`. Falls back to null when no
 * stored plan covers the given date (fresh server / stale cache after
 * restart).
 */
export function getStoredPlanCoveringDate(athleteId: number, date: string): StoredCoachPlan | null {
  // Try the common case first: callers usually know their own weekStart.
  const direct = store.get(athleteId, date);
  if (direct) return direct;

  const target = new Date(`${date}T00:00:00.000Z`).getTime();
  if (Number.isNaN(target)) return null;
  for (let offset = 0; offset <= 6; offset++) {
    const candidate = new Date(target - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const entry = store.get(athleteId, candidate);
    if (entry) return entry;
  }
  return null;
}

/** Back-compat convenience: same as `getStoredPlanCoveringDate` but
 *  returns only the WeeklyPlan. */
export function getWeeklyPlanCoveringDate(athleteId: number, date: string): WeeklyPlan | null {
  return getStoredPlanCoveringDate(athleteId, date)?.plan ?? null;
}
