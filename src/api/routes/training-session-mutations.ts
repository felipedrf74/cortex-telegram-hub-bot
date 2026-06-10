// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import { resolveTrainingDay, trainingWeekdayMatches } from '../../services/training-date-utils';

type MutationPlanRef = { id: number; user_id?: number | null; tenant_id?: number | null };
type MutationWeekRef = { id: number };
type MutationSessionRef = {
  id: number;
  plan_id: number;
  day_of_week?: string | null;
  status?: string | null;
};
type WeeklyAdherenceValue = { adherenceRate?: number | null } | number | null | undefined;

export interface TrainingSessionMutationDeps {
  getActivePlan(userId: number, tenantId: number): MutationPlanRef | null;
  getCurrentWeek(planId: number): MutationWeekRef | null;
  getSessionsForWeek(weekId: number): MutationSessionRef[] | null | undefined;
  getSessionById(sessionId: number): MutationSessionRef | null;
  getPlanById(planId: number): MutationPlanRef | null;
  getWeeklyAdherence?(planId: number, weekId: number): WeeklyAdherenceValue;
}

export type TrainingSessionMutationResolution =
  | { kind: 'bad_input'; message: string }
  | { kind: 'no_active_session' }
  | { kind: 'not_found'; rowId: number }
  | { kind: 'forbidden'; rowId: number; session: MutationSessionRef }
  | { kind: 'resolved'; rowId: number; session: MutationSessionRef; plan: MutationPlanRef };

export interface ResolveTrainingMutationOptions {
  excludeSkippedSessions?: boolean;
}

type RequestedSessionResolution =
  | { kind: 'today' }
  | { kind: 'explicit'; rowId: number }
  | { kind: 'invalid'; message: string };

function parseRequestedTrainingSessionId(sessionId: unknown): RequestedSessionResolution {
  if (sessionId === undefined || sessionId === null) return { kind: 'today' };
  if (typeof sessionId === 'string') {
    const trimmed = sessionId.trim();
    if (!trimmed || trimmed === 'today') return { kind: 'today' };
    if (!/^\d+$/.test(trimmed)) {
      return { kind: 'invalid', message: 'sessionId must be a positive integer or "today"' };
    }
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed > 0) return { kind: 'explicit', rowId: parsed };
    return { kind: 'invalid', message: 'sessionId must be a positive integer or "today"' };
  }
  if (typeof sessionId === 'number') {
    if (Number.isSafeInteger(sessionId) && sessionId > 0) return { kind: 'explicit', rowId: sessionId };
    return { kind: 'invalid', message: 'sessionId must be a positive integer or "today"' };
  }
  return { kind: 'invalid', message: 'sessionId must be a positive integer or "today"' };
}

function resolveRequestedTrainingSessionId(
  userId: number,
  tenantId: number,
  sessionId: unknown,
  deps: TrainingSessionMutationDeps,
  options: ResolveTrainingMutationOptions = {},
): { rowId: number | null; error?: string } {
  const requested = parseRequestedTrainingSessionId(sessionId);
  if (requested.kind === 'invalid') return { rowId: null, error: requested.message };
  if (requested.kind === 'explicit') return { rowId: requested.rowId };

  const plan = deps.getActivePlan(userId, tenantId);
  if (!plan) return { rowId: null };

  const week = deps.getCurrentWeek(plan.id);
  if (!week) return { rowId: null };

  const sessions = deps.getSessionsForWeek(week.id);
  const today = resolveTrainingDay();
  const todaySession = sessions?.find((session) => {
    if (!trainingWeekdayMatches(session.day_of_week, today)) return false;
    if (session.status === 'completed') return false;
    if (options.excludeSkippedSessions && session.status === 'skipped') return false;
    return true;
  });

  return { rowId: todaySession?.id ?? null };
}

export function resolveTrainingMutationSession(
  userId: number,
  tenantId: number,
  sessionId: unknown,
  deps: TrainingSessionMutationDeps,
  options: ResolveTrainingMutationOptions = {},
): TrainingSessionMutationResolution {
  const { rowId, error } = resolveRequestedTrainingSessionId(userId, tenantId, sessionId, deps, options);
  if (error) {
    return { kind: 'bad_input', message: error };
  }
  if (rowId == null) {
    return { kind: 'no_active_session' };
  }

  const session = deps.getSessionById(rowId);
  if (!session) {
    return { kind: 'not_found', rowId };
  }

  const plan = deps.getPlanById(session.plan_id);
  if (!plan || plan.user_id !== userId || plan.tenant_id !== tenantId) {
    return { kind: 'forbidden', rowId, session };
  }

  return { kind: 'resolved', rowId, session, plan };
}

export function getTrainingWeeklyAdherenceRate(
  userId: number,
  tenantId: number,
  deps: Pick<TrainingSessionMutationDeps, 'getActivePlan' | 'getCurrentWeek' | 'getWeeklyAdherence'>,
): number | null {
  try {
    const plan = deps.getActivePlan(userId, tenantId);
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
