// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { WeeklyPlan } from '../types';

export interface CoachPlanStore {
  save(plan: WeeklyPlan): WeeklyPlan;
  get(athleteId: number, weekStart: string): WeeklyPlan | null;
}

export class InMemoryCoachPlanStore implements CoachPlanStore {
  private readonly store = new Map<string, WeeklyPlan>();

  save(plan: WeeklyPlan): WeeklyPlan {
    this.store.set(`${plan.athleteId}:${plan.weekStart}`, plan);
    return plan;
  }

  get(athleteId: number, weekStart: string): WeeklyPlan | null {
    return this.store.get(`${athleteId}:${weekStart}`) ?? null;
  }
}

