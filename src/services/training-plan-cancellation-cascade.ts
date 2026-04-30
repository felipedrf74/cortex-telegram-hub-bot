// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { writeSignal } from './intelligence-bus';
import { cancelSecretaryAgendaItem } from './secretary-scheduling-arbitrator';
import { markSkillMemoriesStaleForRelatedSkillVersion } from './skill-memory';
import { logger } from '../utils/logger';

export interface TrainingCancellationCascadeInput {
  userId: number;
  tenantId?: number | string | null;
  planId: number;
  planVersion?: number | null;
  sessionIds: number[];
  reason?: string | null;
}

export interface TrainingCancellationCascadeResult {
  canceledAgendaItems: number;
  staleMemories: number;
  signalId: number | null;
}

const DOWNSTREAM_MEMORY_SKILLS = ['cooking', 'secretary', 'chat'] as const;

export function cancelTrainingPlanCrossSkillDependents(
  input: TrainingCancellationCascadeInput,
): TrainingCancellationCascadeResult {
  const tenantId = normalizeTenantId(input.tenantId, input.userId);
  const planVersion = normalizePlanVersion(input.planVersion);
  const sessionIds = [...new Set(input.sessionIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0))];
  const sourceIntentIds = new Set(sessionIds.map((sessionId) =>
    buildTrainingSourceIntentId(input.planId, planVersion, sessionId)));
  const sourceEntityIds = new Set(sessionIds.map(String));
  let canceledAgendaItems = 0;

  if (sessionIds.length > 0) {
    for (const row of findMatchingSecretaryAgendaItems(input.userId, tenantId)) {
      const sourceIntentId = String(row.source_intent_id ?? '');
      const sourceEntityId = row.source_entity_id == null ? '' : String(row.source_entity_id);
      if (!sourceIntentIds.has(sourceIntentId) && !sourceEntityIds.has(sourceEntityId)) continue;
      try {
        const updated = cancelSecretaryAgendaItem({
          agendaItemId: row.agenda_item_id,
          ownerUserId: input.userId,
          tenantId,
          reason: input.reason || 'training_plan_canceled',
        });
        if (updated?.lifecycleState === 'canceled') canceledAgendaItems += 1;
      } catch (err) {
        logger.warn(
          { err, userId: input.userId, tenantId, planId: input.planId, agendaItemId: row.agenda_item_id },
          'Failed to cancel Secretary agenda item during Training plan cancellation cascade',
        );
      }
    }
  }

  const relatedSkillVersion = buildTrainingRelatedSkillVersion(planVersion);
  let staleMemories = 0;
  for (const skillId of DOWNSTREAM_MEMORY_SKILLS) {
    try {
      staleMemories += markSkillMemoriesStaleForRelatedSkillVersion({
        tenantId,
        userId: input.userId,
        skillId,
        relatedSkillVersion,
        reason: input.reason || 'training_plan_canceled',
      });
    } catch (err) {
      logger.warn(
        { err, userId: input.userId, tenantId, planId: input.planId, skillId, relatedSkillVersion },
        'Failed to stale downstream skill memory during Training plan cancellation cascade',
      );
    }
  }

  let signalId: number | null = null;
  try {
    const id = writeSignal({
      source_agent: 'training.cancel',
      signal_type: 'training_plan_canceled',
      priority: 'urgent',
      user_id: input.userId,
      tenant_id: tenantId,
      confidence: 1,
      evidence_count: Math.max(1, sessionIds.length),
      meshPriority: 1,
      payload: {
        plan_id: input.planId,
        plan_version: planVersion,
        session_ids: sessionIds,
        reason: input.reason || 'training_plan_canceled',
        canceled_agenda_items: canceledAgendaItems,
        stale_memories: staleMemories,
      },
    });
    signalId = id > 0 ? id : null;
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, tenantId, planId: input.planId },
      'Failed to emit Training plan canceled cross-skill signal',
    );
  }

  return { canceledAgendaItems, staleMemories, signalId };
}

export function buildTrainingRelatedSkillVersion(planVersion?: number | null): string {
  return `training-plan-v${normalizePlanVersion(planVersion)}`;
}

function buildTrainingSourceIntentId(planId: number, planVersion: number, sessionId: number): string {
  return `training:${planId}:${planVersion}:${sessionId}`;
}

function normalizePlanVersion(value?: number | null): number {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 1;
}

function normalizeTenantId(value: number | string | null | undefined, fallbackUserId: number): number {
  const parsed = Number(value ?? fallbackUserId);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallbackUserId;
}

function findMatchingSecretaryAgendaItems(ownerUserId: number, tenantId: number): Array<{
  agenda_item_id: string;
  source_intent_id: string | null;
  source_entity_id: string | null;
}> {
  try {
    return getDb().prepare(`
      SELECT agenda_item_id, source_intent_id, source_entity_id
        FROM secretary_agenda_items
       WHERE owner_user_id = ?
         AND tenant_id = ?
         AND source_skill = 'training'
         AND lifecycle_state NOT IN ('canceled', 'completed', 'superseded')
    `).all(ownerUserId, String(tenantId)) as Array<{
      agenda_item_id: string;
      source_intent_id: string | null;
      source_entity_id: string | null;
    }>;
  } catch {
    return [];
  }
}
