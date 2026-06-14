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
  deletedCalendarEvents?: Array<{
    eventId: string;
    source: string;
  }>;
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
  let canceledAgendaItems = 0;

  // 2026-05-25 fix — match secretary agenda rows by plan_id (any
  // plan_version), not just sessions belonging to the current
  // version. Prior bug: regenerating a plan bumps plan_version,
  // which left agenda rows whose `source_intent_id` carried the
  // OLD version unable to match the cancel cascade. Combined with
  // an FK cascade that deleted the old `training_sessions` rows,
  // the `source_entity_id` fallback also failed because the
  // current sessionIds no longer contained the old session ids.
  // The result was orphan calendar events on the user's Outlook
  // or Google calendar. SQL now matches every prior-version row in
  // one shot via `source_intent_id LIKE 'training:${planId}:%'`,
  // plus a defensive `source_entity_id IN (sessionIds)` for the
  // rare row whose intent_id was never populated.
  for (const row of findMatchingSecretaryAgendaItems(input.userId, tenantId, input.planId, sessionIds)) {
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

  markDeletedSecretaryProviderMappings({
    ownerUserId: input.userId,
    tenantId,
    planId: input.planId,
    deletedCalendarEvents: input.deletedCalendarEvents ?? [],
  });

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

function normalizePlanVersion(value?: number | null): number {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 1;
}

function normalizeTenantId(value: number | string | null | undefined, fallbackUserId: number): number {
  const parsed = Number(value ?? fallbackUserId);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallbackUserId;
}

/**
 * Build a SQL `LIKE` pattern that catches every secretary agenda
 * row a training plan ever owned, across all `plan_version` values.
 * The `source_intent_id` shape is `training:${planId}:${planVersion}:${sessionId}`,
 * so the prefix `training:${planId}:` matches every version of every
 * session for that plan.
 *
 * Exported for tests that need to assert prefix shape.
 */
export function buildTrainingPlanIntentPrefixPattern(planId: number): string {
  return `training:${planId}:%`;
}

function markDeletedSecretaryProviderMappings(scope: {
  ownerUserId: number;
  tenantId: number;
  planId: number;
  deletedCalendarEvents: Array<{
    eventId: string;
    source: string;
  }>;
}): number {
  const deletionKeys = [...new Set(scope.deletedCalendarEvents
    .map((event) => {
      const source = String(event.source || '').trim();
      const eventId = String(event.eventId || '').trim();
      return source && eventId ? `${source}:${eventId}` : '';
    })
    .filter(Boolean))];
  if (deletionKeys.length === 0) return 0;

  const placeholders = deletionKeys.map(() => '?').join(',');
  try {
    const result = getDb().prepare(`
      UPDATE secretary_agenda_items
         SET provider_sync_state = 'deleted',
             updated_at = CURRENT_TIMESTAMP
       WHERE owner_user_id = ?
         AND tenant_id = ?
         AND source_skill = 'training'
         AND source_intent_id LIKE ?
         AND lifecycle_state IN ('canceled', 'superseded')
         AND provider_event_id IS NOT NULL
         AND provider_event_id != ''
         AND provider_source IS NOT NULL
         AND COALESCE(provider_sync_state, '') != 'deleted'
         AND (provider_source || ':' || provider_event_id) IN (${placeholders})
    `).run(
      scope.ownerUserId,
      String(scope.tenantId),
      buildTrainingPlanIntentPrefixPattern(scope.planId),
      ...deletionKeys,
    );
    return Number(result.changes ?? 0);
  } catch (err) {
    logger.warn(
      { err, userId: scope.ownerUserId, tenantId: scope.tenantId, planId: scope.planId },
      'Failed to mark Training-owned Secretary provider mappings deleted during plan cancellation cascade',
    );
    return 0;
  }
}

/**
 * Enumerate Secretary-owned calendar events the training skill is
 * about to cancel — used by `training-plan-cancellation` to add
 * provider-event-delete targets that aren't tracked in
 * `training_agenda_event_ownership`. Returns one entry per
 * `secretary_agenda_items` row that still has a live
 * `provider_event_id`. Skips rows whose `provider_sync_state` is
 * already `'deleted'` so we don't enqueue redundant deletes.
 *
 * The query scopes to one plan (any `plan_version`) by matching on
 * `source_intent_id LIKE 'training:${planId}:%'` — the same broadened
 * scope the cascade itself uses to find prior-version orphans.
 */
export function findSecretaryAgendaCalendarEventsForPlan(
  planId: number,
  ownerUserId: number,
  tenantId: number | string,
): Array<{ calendar_event_id: string; calendar_source: string }> {
  try {
    const rows = getDb().prepare(`
      SELECT provider_event_id AS calendar_event_id,
             provider_source AS calendar_source
        FROM secretary_agenda_items
       WHERE owner_user_id = ?
         AND tenant_id = ?
         AND source_skill = 'training'
         AND source_intent_id LIKE ?
         AND provider_event_id IS NOT NULL
         AND provider_event_id != ''
         AND provider_source IS NOT NULL
         AND COALESCE(provider_sync_state, '') != 'deleted'
    `).all(
      ownerUserId,
      String(tenantId),
      buildTrainingPlanIntentPrefixPattern(planId),
    ) as Array<{ calendar_event_id: string | null; calendar_source: string | null }>;
    return rows
      .filter((row) => row.calendar_event_id && row.calendar_source)
      .map((row) => ({
        calendar_event_id: String(row.calendar_event_id),
        calendar_source: String(row.calendar_source),
      }));
  } catch {
    return [];
  }
}

function findMatchingSecretaryAgendaItems(
  ownerUserId: number,
  tenantId: number,
  planId: number,
  sessionIds: number[],
): Array<{
  agenda_item_id: string;
  source_intent_id: string | null;
  source_entity_id: string | null;
}> {
  // Primary match: every active training agenda row whose
  // `source_intent_id` belongs to this plan (any version).
  // Defensive fallback: any row whose `source_entity_id` is one
  // of the current plan's session ids — covers the edge case of a
  // row that was persisted without a `source_intent_id` (legacy
  // intent paths that didn't normalize the intent shape).
  const intentPattern = buildTrainingPlanIntentPrefixPattern(planId);
  const params: Array<string | number> = [
    ownerUserId,
    String(tenantId),
    intentPattern,
  ];
  let entityClause = '';
  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    entityClause = ` OR (source_entity_type = 'training_session' AND source_entity_id IN (${placeholders}))`;
    for (const id of sessionIds) params.push(String(id));
  }

  try {
    return getDb().prepare(`
      SELECT agenda_item_id, source_intent_id, source_entity_id
        FROM secretary_agenda_items
       WHERE owner_user_id = ?
         AND tenant_id = ?
         AND source_skill = 'training'
         AND lifecycle_state NOT IN ('canceled', 'completed', 'superseded')
         AND (
           source_intent_id LIKE ?
           ${entityClause}
         )
    `).all(...params) as Array<{
      agenda_item_id: string;
      source_intent_id: string | null;
      source_entity_id: string | null;
    }>;
  } catch {
    return [];
  }
}
