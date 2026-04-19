// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, WeeklyPlan } from '../types';

/** A persisted plan carries both the deterministic WeeklyPlan and the
 *  AthleteState snapshot that produced it. The AthleteState is kept so
 *  the home-view route can re-run `adjustForFatigue` against *today's*
 *  readiness — without it we can only show guardrails frozen at
 *  plan-generation time. */
export interface StoredCoachPlan {
  plan: WeeklyPlan;
  athleteState: AthleteState;
}

export interface CoachPlanStore {
  save(entry: StoredCoachPlan): StoredCoachPlan;
  get(athleteId: number, weekStart: string): StoredCoachPlan | null;
}

export class InMemoryCoachPlanStore implements CoachPlanStore {
  private readonly store = new Map<string, StoredCoachPlan>();

  save(entry: StoredCoachPlan): StoredCoachPlan {
    this.store.set(`${entry.plan.athleteId}:${entry.plan.weekStart}`, entry);
    return entry;
  }

  get(athleteId: number, weekStart: string): StoredCoachPlan | null {
    return this.store.get(`${athleteId}:${weekStart}`) ?? null;
  }
}

