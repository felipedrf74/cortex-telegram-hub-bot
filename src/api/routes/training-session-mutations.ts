// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';

type MutationPlanRef = { id: number; user_id?: number | null };
type MutationWeekRef = { id: number };
type MutationSessionRef = {
  id: number;
  plan_id: number;
  day_of_week?: string | null;
  status?: string | null;
};
type WeeklyAdherenceValue = { adherenceRate?: number | null } | number | null | undefined;

export interface TrainingSessionMutationDeps {
  getActivePlan(userId: number): MutationPlanRef | null;
  getCurrentWeek(planId: number): MutationWeekRef | null;
  getSessionsForWeek(weekId: number): MutationSessionRef[] | null | undefined;
  getSessionById(sessionId: number): MutationSessionRef | null;
  getPlanById(planId: number): MutationPlanRef | null;
  getWeeklyAdherence?(planId: number, weekId: number): WeeklyAdherenceValue;
}

export type TrainingSessionMutationResolution =
  | { kind: 'no_active_session' }
  | { kind: 'not_found'; rowId: number }
  | { kind: 'forbidden'; rowId: number; session: MutationSessionRef }
  | { kind: 'resolved'; rowId: number; session: MutationSessionRef; plan: MutationPlanRef };

export interface ResolveTrainingMutationOptions {
  excludeSkippedSessions?: boolean;
}

function resolveRequestedTrainingSessionId(
  userId: number,
  sessionId: unknown,
  deps: TrainingSessionMutationDeps,
  options: ResolveTrainingMutationOptions = {},
): number | null {
  if (sessionId && sessionId !== 'today' && !Number.isNaN(Number(sessionId))) {
    return Number(sessionId);
  }

  const plan = deps.getActivePlan(userId);
  if (!plan) return null;

  const week = deps.getCurrentWeek(plan.id);
  if (!week) return null;

  const sessions = deps.getSessionsForWeek(week.id);
  const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const todaySession = sessions?.find((session) => {
    if (session.day_of_week !== todayName) return false;
    if (session.status === 'completed') return false;
    if (options.excludeSkippedSessions && session.status === 'skipped') return false;
    return true;
  });

  return todaySession?.id ?? null;
}

export function resolveTrainingMutationSession(
  userId: number,
  sessionId: unknown,
  deps: TrainingSessionMutationDeps,
  options: ResolveTrainingMutationOptions = {},
): TrainingSessionMutationResolution {
  const rowId = resolveRequestedTrainingSessionId(userId, sessionId, deps, options);
  if (rowId == null) {
    return { kind: 'no_active_session' };
  }

  const session = deps.getSessionById(rowId);
  if (!session) {
    return { kind: 'not_found', rowId };
  }

  const plan = deps.getPlanById(session.plan_id);
  if (!plan || plan.user_id !== userId) {
    return { kind: 'forbidden', rowId, session };
  }

  return { kind: 'resolved', rowId, session, plan };
}

export function getTrainingWeeklyAdherenceRate(
  userId: number,
  deps: Pick<TrainingSessionMutationDeps, 'getActivePlan' | 'getCurrentWeek' | 'getWeeklyAdherence'>,
): number | null {
  try {
    const plan = deps.getActivePlan(userId);
    if (!plan) return null;

    const week = deps.getCurrentWeek(plan.id);
    if (!week) return null;

    const adherence = deps.getWeeklyAdherence?.(plan.id, week.id);
    if (typeof adherence === 'number') {
      return adherence > 1 ? adherence / 100 : adherence;
    }

    if (typeof adherence?.adherenceRate === 'number') {
      return adherence.adherenceRate / 100;
    }

    return null;
  } catch (err) {
    logger.debug({ err, userId }, 'Training weekly adherence read failed (non-critical)');
    return null;
  }
}
