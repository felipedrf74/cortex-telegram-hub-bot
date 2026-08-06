// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * F24 — transactionally couples a week-reflow mutation to its durable
 * calendar/Secretary reconciliation request. External provider calls remain
 * asynchronous; the returned propagation receipt therefore says pending,
 * never distributed-atomic success.
 */
import type Database from 'better-sqlite3';

import { getDb } from './database';
import { emitDomainEvent } from './event-outbox';
import { invalidateTrainingDerivedCaches } from './cache-coherence-registry';
import { requireTenantIdParam } from './tenant-scope';
import { withTrainingCalendarOperationLock } from './training-operation-locks';
import {
  executeWeekReflow,
  type ReflowInput,
  type ReflowResult,
} from './training-week-reflow';
import type { CalendarSource } from './unified-calendar';
import { logger } from '../utils/logger';

export const TRAINING_WEEK_REFLOW_OPERATION = 'week_reflow' as const;
export type TrainingReflowSyncTarget = CalendarSource | 'auto' | 'none' | 'apple';

export interface PropagatedWeekReflowInput extends ReflowInput {
  userId: number;
  tenantId: number;
  planVersion: number;
  syncTarget: TrainingReflowSyncTarget;
}

export interface WeekReflowPropagationReceipt {
  state: 'not_synced';
  pending: boolean;
  adaptationRevision: number | null;
}

export type PropagatedWeekReflowResult = ReflowResult & {
  propagation: WeekReflowPropagationReceipt;
};

export async function executeWeekReflowWithPropagation(
  input: PropagatedWeekReflowInput,
): Promise<PropagatedWeekReflowResult> {
  const tenantId = requireTenantIdParam(input.tenantId, 'executeWeekReflowWithPropagation');
  assertReflowScope(input, tenantId, getDb());

  if (input.mode === 'preview') {
    const result = executeWeekReflow(stripPropagationFields(input));
    return withPropagationReceipt(result, false);
  }

  return withTrainingCalendarOperationLock(
    {
      userId: input.userId,
      tenantId,
      planId: input.planId,
      operation: 'calendar_reflow',
    },
    async (lease) => {
      // Ownership and version are re-read under the lock so a plan
      // regeneration cannot win between the route's first check and commit.
      lease.assertActive();
      assertReflowScope(input, tenantId, getDb());
      const result = executeWeekReflow({
        ...stripPropagationFields(input),
        afterApply: (db, context) => {
          if (context.affectedSessionIds.length === 0) return;
          lease.assertActive();
          emitWeekReflowPropagationRequest({
            db,
            userId: input.userId,
            tenantId,
            planId: input.planId,
            planVersion: input.planVersion,
            weekId: input.weekId,
            adaptationRevision: context.adaptationRevision,
            sessionIds: context.affectedSessionIds,
            reflowScope: hasAppliedPlanPause(context.perActionResults) ? 'plan' : 'week',
            syncTarget: input.syncTarget,
          });
          // This runs inside executeWeekReflow's transaction; failing here
          // rolls back desired state, revision, ledger, and outbox together.
          lease.assertActive();
        },
      });

      lease.assertActive();

      if (result.mutated) {
        try {
          invalidateTrainingDerivedCaches(input.userId);
        } catch (err) {
          // Cache invalidation is an after-commit accelerator; the durable
          // worker repeats it after convergence, so never turn a committed
          // reflow into a transport 500 because a cache backend is degraded.
          logger.warn(
            { err, userId: input.userId, planId: input.planId },
            'week_reflow.training_cache_invalidation_failed',
          );
        }
      }
      return withPropagationReceipt(
        result,
        result.mutated && result.affectedSessionIds.length > 0,
      );
    },
  );
}

function emitWeekReflowPropagationRequest(input: {
  db: Database.Database;
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  weekId: number;
  adaptationRevision: number;
  sessionIds: number[];
  reflowScope: 'week' | 'plan';
  syncTarget: TrainingReflowSyncTarget;
}): void {
  emitDomainEvent({
    tenantId: input.tenantId,
    userId: input.userId,
    sourceSkill: 'training',
    eventType: 'training.plan_calendar_sync.requested.v1',
    entityType: 'training_plan',
    entityId: input.planId,
    entityVersion: input.planVersion,
    schemaVersion: 'training-plan-calendar-sync.v1',
    payload: {
      // `operation` deliberately avoids privacy-sanitizer reserved key words
      // such as calendar/title/description while preserving a literal router
      // branch compatible with the manifest generator.
      operation: TRAINING_WEEK_REFLOW_OPERATION,
      planId: input.planId,
      planVersion: input.planVersion,
      adaptationRevision: input.adaptationRevision,
      weekId: input.weekId,
      sessionIds: input.sessionIds,
      reflowScope: input.reflowScope,
      syncTarget: input.syncTarget,
    },
    privacyClassification: 'health',
    idempotencyKey:
      `training.plan_reflow_sync.requested:${input.planId}:${input.adaptationRevision}`,
  }, input.db);
}

function hasAppliedPlanPause(perActionResults: unknown): boolean {
  if (!Array.isArray(perActionResults)) return false;
  return perActionResults.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const result = candidate as Record<string, unknown>;
    const action = result.action;
    return result.skipped === false
      && Number(result.mutatedRows) > 0
      && Boolean(action)
      && typeof action === 'object'
      && (action as Record<string, unknown>).type === 'pause_training';
  });
}

function assertReflowScope(
  input: Pick<PropagatedWeekReflowInput, 'userId' | 'planId' | 'planVersion' | 'weekId'>,
  tenantId: number,
  db: Database.Database,
): void {
  const row = db.prepare(`
    SELECT plans.id, plans.user_id, COALESCE(plans.tenant_id, plans.user_id) AS tenant_id,
           COALESCE(plans.plan_version, 1) AS plan_version
    FROM fitness_training_plans plans
    JOIN training_weeks weeks ON weeks.plan_id = plans.id
    WHERE plans.id = ? AND weeks.id = ?
    LIMIT 1
  `).get(input.planId, input.weekId) as {
    id: number;
    user_id: number;
    tenant_id: number;
    plan_version: number;
  } | undefined;
  if (!row
      || row.user_id !== input.userId
      || row.tenant_id !== tenantId
      || row.plan_version !== input.planVersion) {
    throw new Error('TRAINING_WEEK_REFLOW_SCOPE_MISMATCH');
  }
}

function stripPropagationFields(input: PropagatedWeekReflowInput): ReflowInput {
  const {
    userId: _userId,
    tenantId: _tenantId,
    planVersion: _planVersion,
    syncTarget: _syncTarget,
    ...reflow
  } = input;
  return reflow;
}

function withPropagationReceipt(
  result: ReflowResult,
  pending: boolean,
): PropagatedWeekReflowResult {
  return {
    ...result,
    propagation: {
      state: 'not_synced',
      pending,
      adaptationRevision: result.adaptationRevision,
    },
  };
}
