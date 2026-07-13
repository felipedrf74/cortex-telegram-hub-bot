// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import {
  getTrainingPlanRevisionV1Mode,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
  type RuntimeFlagScope,
} from './runtime-flags';
import { TrainingPlanRevisionError } from './training-plan-revision-errors';

export function assertLegacyPlanGenerationAllowed(
  scope: RuntimeFlagScope,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldGuard(scope, env)) return;
  throw blocked('Use the versioned Training candidate flow while Milestone 1 is active.');
}

export function assertLegacyPlanMutationAllowed(
  scope: RuntimeFlagScope,
  planId: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldGuard(scope, env)) return;
  const row = getDb().prepare(`
    SELECT source_revision_id AS sourceRevisionId
      FROM fitness_training_plans
     WHERE id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(planId, scope.userId, scope.tenantId) as { sourceRevisionId: string | null } | undefined;
  if (row?.sourceRevisionId) throw blocked('This plan is owned by an immutable Training revision.');
}

export function assertLegacyWeekMutationAllowed(
  scope: RuntimeFlagScope,
  weekId: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldGuard(scope, env)) return;
  const row = getDb().prepare(`
    SELECT COALESCE(weeks.source_revision_id, plans.source_revision_id) AS sourceRevisionId
      FROM training_weeks weeks
      JOIN fitness_training_plans plans ON plans.id = weeks.plan_id
     WHERE weeks.id = ? AND plans.user_id = ? AND plans.tenant_id = ?
     LIMIT 1
  `).get(weekId, scope.userId, scope.tenantId) as { sourceRevisionId: string | null } | undefined;
  if (row?.sourceRevisionId) throw blocked('This week is owned by an immutable Training revision.');
}

export function assertLegacySessionMutationAllowed(
  scope: RuntimeFlagScope,
  sessionId: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldGuard(scope, env)) return;
  const row = getDb().prepare(`
    SELECT COALESCE(sessions.source_revision_id, plans.source_revision_id) AS sourceRevisionId
      FROM training_sessions sessions
      JOIN fitness_training_plans plans ON plans.id = sessions.plan_id
     WHERE sessions.id = ? AND plans.user_id = ? AND plans.tenant_id = ?
     LIMIT 1
  `).get(sessionId, scope.userId, scope.tenantId) as { sourceRevisionId: string | null } | undefined;
  if (row?.sourceRevisionId) throw blocked('This session is owned by an immutable Training revision.');
}

export function assertLegacyCalendarEventMutationAllowed(
  scope: RuntimeFlagScope,
  calendarEventId: string,
  calendarSource: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldGuard(scope, env)) return;
  const row = getDb().prepare(`
    SELECT COALESCE(sessions.source_revision_id, plans.source_revision_id) AS sourceRevisionId
      FROM training_sessions sessions
      JOIN fitness_training_plans plans ON plans.id = sessions.plan_id
     WHERE sessions.calendar_event_id = ? AND sessions.calendar_source = ?
       AND plans.user_id = ? AND plans.tenant_id = ?
     LIMIT 1
  `).get(calendarEventId, calendarSource, scope.userId, scope.tenantId) as {
    sourceRevisionId: string | null;
  } | undefined;
  if (row?.sourceRevisionId) throw blocked('This calendar-linked session is owned by an immutable Training revision.');
}

function shouldGuard(scope: RuntimeFlagScope, env: NodeJS.ProcessEnv): boolean {
  // Mode must be checked before touching the database: off and shadow retain
  // byte-identical legacy execution behavior.
  if (getTrainingPlanRevisionV1Mode(env, scope) !== 'active'
      || !isTrainingPlanRevisionV1ExplicitlyEnrolled(env, scope)) return false;
  if (scope.userId !== scope.tenantId) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PLAN_REVISION_PERSONAL_SCOPE_REQUIRED',
      'Training plan revisions are limited to personal accounts in Milestone 1.',
      404,
    );
  }
  return true;
}

function blocked(message: string): TrainingPlanRevisionError {
  return new TrainingPlanRevisionError(
    'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
    message,
    409,
  );
}
