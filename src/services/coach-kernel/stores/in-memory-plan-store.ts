// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, WeeklyPlan } from '../types';

/** A persisted plan carries both the deterministic WeeklyPlan and the
 *  AthleteState snapshot that produced it. The AthleteState is kept so
 *  the home-view route can re-run `adjustForFatigue` against *today's*
 *  readiness — without it we can only show guardrails frozen at
 *  plan-generation time. */
export interface StoredCoachPlan {
  tenantId: number;
  plan: WeeklyPlan;
  athleteState: AthleteState;
}

export interface CoachPlanStore {
  save(entry: StoredCoachPlan): StoredCoachPlan;
  get(athleteId: number, tenantId: number, weekStart: string): StoredCoachPlan | null;
  /**
   * Drop every stored entry for the given athlete. Used when a plan
   * is cancelled — leaving the registry primed with the cancelled
   * plan's WeeklyPlan + AthleteState meant the home-view route kept
   * rendering the deleted plan's day strip and guardrails after the
   * DB rows were gone (production bug 2026-04-25). Returns the count
   * of removed entries so callers can audit what was cleaned.
   */
  clearForAthlete(athleteId: number, tenantId: number): number;
}

export class InMemoryCoachPlanStore implements CoachPlanStore {
  private readonly store = new Map<string, StoredCoachPlan>();

  save(entry: StoredCoachPlan): StoredCoachPlan {
    this.store.set(`${entry.tenantId}:${entry.plan.athleteId}:${entry.plan.weekStart}`, entry);
    return entry;
  }

  get(athleteId: number, tenantId: number, weekStart: string): StoredCoachPlan | null {
    return this.store.get(`${tenantId}:${athleteId}:${weekStart}`) ?? null;
  }

  clearForAthlete(athleteId: number, tenantId: number): number {
    const prefix = `${tenantId}:${athleteId}:`;
    let removed = 0;
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
