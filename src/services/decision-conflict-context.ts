// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import {
  buildNormalizedDecisionAction,
  normalizeDecisionAction,
  type NormalizedDecisionAction,
} from './decision-action-contract';
import type { ConflictComparisonAction } from './decision-conflict-evaluator';
import { DOMAIN_COMMITMENT_ADAPTERS } from './decision-domain-commitment-adapters';
import { secretaryAgendaStateRevision } from './secretary-agenda-state-revision';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

export interface DecisionConflictScope {
  userId: number;
  tenantId: number;
}

export interface DecisionConflictContextAdapter {
  id: string;
  loadComparisons(input: {
    scope: DecisionConflictScope;
    candidate: NormalizedDecisionAction;
    excludeDecisionId?: string;
    now: Date;
  }): ConflictComparisonAction[];
}

export interface LoadedDecisionConflictContext {
  existing: ConflictComparisonAction[];
  activeExecutionExclusivityKeys: string[];
  sourceHealth: Array<{ source: string; status: 'available' | 'failed'; reasonCode?: string }>;
}

const adapters: DecisionConflictContextAdapter[] = [
  { id: 'active_normalized_decisions', loadComparisons: loadActiveNormalizedDecisions },
  { id: 'secretary_agenda_commitments', loadComparisons: loadSecretaryAgendaCommitments },
  { id: 'training_schedule_commitments', loadComparisons: loadTrainingScheduleCommitments },
  ...DOMAIN_COMMITMENT_ADAPTERS,
];

/** Domain owners can register deterministic adapters without adding model or free-text policy. */
export function registerDecisionConflictContextAdapter(adapter: DecisionConflictContextAdapter): void {
  const index = adapters.findIndex((candidate) => candidate.id === adapter.id);
  if (index >= 0) adapters[index] = adapter;
  else adapters.push(adapter);
}

export function loadDecisionConflictContext(input: {
  scope: DecisionConflictScope;
  candidate: NormalizedDecisionAction;
  excludeDecisionId?: string;
  now?: Date;
}): LoadedDecisionConflictContext {
  const now = input.now ?? new Date();
  const existing: ConflictComparisonAction[] = [];
  const sourceHealth: LoadedDecisionConflictContext['sourceHealth'] = [];
  for (const adapter of adapters) {
    try {
      existing.push(...adapter.loadComparisons({ ...input, now }));
      sourceHealth.push({ source: adapter.id, status: 'available' });
    } catch {
      sourceHealth.push({ source: adapter.id, status: 'failed', reasonCode: 'authoritative_context_unavailable' });
    }
  }

  let activeExecutionExclusivityKeys: string[] = [];
  try {
    activeExecutionExclusivityKeys = (getDb().prepare(`
      SELECT exclusivity_key AS exclusivityKey, decision_id AS decisionId
        FROM decision_exclusivity_claims
       WHERE user_id = ? AND tenant_id = ?
         AND (status = 'partially_failed'
           OR (status = 'started' AND datetime(lease_expires_at) > datetime(?)))
       ORDER BY exclusivity_key ASC
    `).all(input.scope.userId, input.scope.tenantId, now.toISOString()) as Array<{ exclusivityKey: string; decisionId: string }>)
      .filter((row) => row.decisionId !== input.excludeDecisionId)
      .map((row) => row.exclusivityKey);
    sourceHealth.push({ source: 'active_execution_claims', status: 'available' });
  } catch {
    sourceHealth.push({ source: 'active_execution_claims', status: 'failed', reasonCode: 'execution_claims_unavailable' });
  }

  const unique = new Map<string, ConflictComparisonAction>();
  for (const comparison of existing) {
    const key = comparison.decisionId ?? comparison.action.logicalActionHash;
    if (comparison.action.logicalActionHash === input.candidate.logicalActionHash && comparison.decisionId === input.excludeDecisionId) continue;
    unique.set(key, comparison);
  }
  return {
    existing: [...unique.values()].sort((left, right) => compareCodeUnits(left.decisionId ?? '', right.decisionId ?? '')),
    activeExecutionExclusivityKeys: [...new Set(activeExecutionExclusivityKeys)].sort(),
    sourceHealth,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function loadActiveNormalizedDecisions(input: {
  scope: DecisionConflictScope;
  excludeDecisionId?: string;
  now: Date;
}): ConflictComparisonAction[] {
  const rows = getDb().prepare(`
    SELECT items.item_id AS decisionId, items.source_skill AS sourceSkill,
           items.status, items.decision_state AS decisionState,
           items.created_at AS createdAt, COALESCE(items.updated_at, items.created_at) AS updatedAt,
           items.expires_at AS expiresAt, intents.normalized_action_json AS normalizedActionJson
      FROM notification_center_items items
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id AND intents.tenant_id = items.tenant_id
     WHERE items.user_id = ? AND items.tenant_id = ?
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
       AND intents.normalized_action_json IS NOT NULL
       AND (? IS NULL OR items.item_id != ?)
       AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))
     ORDER BY items.created_at DESC
     LIMIT 200
  `).all(
    input.scope.userId,
    input.scope.tenantId,
    input.excludeDecisionId ?? null,
    input.excludeDecisionId ?? null,
    input.now.toISOString(),
  ) as Array<{
    decisionId: string;
    sourceSkill: string;
    status: string;
    decisionState: string | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    normalizedActionJson: string;
  }>;
  return rows.flatMap((row) => {
    let action: NormalizedDecisionAction | null = null;
    try { action = normalizeDecisionAction(JSON.parse(row.normalizedActionJson)); } catch { action = null; }
    if (!action) return [];
    // Completed/actioned rows are historical outcomes, not proof that the
    // underlying domain commitment is still current. Long-lived commitments
    // must be projected by an authoritative domain adapter (for example the
    // Secretary agenda adapter below) instead of remaining active forever.
    const approved = row.decisionState === 'approved';
    return [{
      action,
      decisionId: row.decisionId,
      authority: row.sourceSkill === 'security' || row.sourceSkill === 'system'
        ? 'system_policy'
        : approved ? 'approved_commitment' : 'optimization',
      approved,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.expiresAt ? { validUntil: row.expiresAt } : {}),
    }];
  });
}

function loadSecretaryAgendaCommitments(input: {
  scope: DecisionConflictScope;
  candidate: NormalizedDecisionAction;
}): ConflictComparisonAction[] {
  const requested = input.candidate.requestedWindow;
  const calendarKeys = input.candidate.exclusivityKeys.filter((key) => key.startsWith('calendar_timeline:'));
  if (!requested || calendarKeys.length === 0) return [];
  const rows = getDb().prepare(`
    SELECT agenda_item_id AS agendaItemId, version, source_shape_hash AS sourceShapeHash,
           start_at AS startAt, end_at AS endAt,
           lifecycle_state AS lifecycleState, provider_sync_state AS providerSyncState,
           provider_event_id AS providerEventId, provider_source AS providerSource,
           decision_action AS decisionAction, decision_reason_codes_json AS decisionReasonCodes,
           decision_explanation AS decisionExplanation, scheduled_segments_json AS scheduledSegments,
           updated_at AS updatedAt, created_at AS createdAt
      FROM secretary_agenda_items
     WHERE owner_user_id = ? AND tenant_id = ?
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed')
       AND start_at IS NOT NULL AND end_at IS NOT NULL
       AND datetime(start_at) < datetime(?) AND datetime(end_at) > datetime(?)
     ORDER BY start_at ASC
     LIMIT 100
  `).all(
    input.scope.userId,
    String(input.scope.tenantId),
    requested.end,
    requested.start,
  ) as Array<{
    agendaItemId: string;
    version: number;
    sourceShapeHash: string;
    startAt: string;
    endAt: string;
    lifecycleState: string;
    providerSyncState: string;
    providerEventId: string | null;
    providerSource: string | null;
    decisionAction: string | null;
    decisionReasonCodes: string | null;
    decisionExplanation: string | null;
    scheduledSegments: string | null;
    updatedAt: string;
    createdAt: string;
  }>;
  const candidateIds = new Set(input.candidate.targetEntities.map((entity) => `${entity.type}:${entity.id}`));
  return rows.flatMap((row) => {
    if (candidateIds.has(`secretary_agenda_item:${row.agendaItemId}`)) return [];
    const action = buildNormalizedDecisionAction({
      intent: 'preserve_approved_secretary_commitment',
      targetEntities: [{ type: 'secretary_agenda_item', id: row.agendaItemId, version: String(row.version) }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      requestedWindow: { start: row.startAt, end: row.endAt, timezone: requested.timezone },
      preconditions: [{
        type: 'agenda_state',
        ref: row.agendaItemId,
        expectedVersion: secretaryAgendaStateRevision(row),
        required: true,
      }],
      expectedEffects: [{ type: 'preserve_commitment', targetRef: `secretary_agenda_item:${row.agendaItemId}` }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: calendarKeys,
      authorizationScope: ['calendar:read'],
      risk: 'medium',
      // This projects an approved commitment, not an action with a registered
      // compensation adapter. Treat replacement conservatively.
      reversibility: 'irreversible',
      contextVersion: `agenda:${row.agendaItemId}:${row.version}`,
    });
    return [{
      action,
      decisionId: `agenda:${row.agendaItemId}`,
      authority: 'approved_commitment',
      approved: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }];
  });
}

/** Exact plan-session overlap projection for authoritative M4 schedules. The
 * candidate intentionally remains a single Decision; comparisons are emitted
 * only for agenda rows that overlap a stored immutable session window. */
function loadTrainingScheduleCommitments(input: {
  scope: DecisionConflictScope;
  candidate: NormalizedDecisionAction;
}): ConflictComparisonAction[] {
  const target = input.candidate.targetEntities.find((entry) => entry.type === 'training_plan_revision');
  const calendarKeys = input.candidate.exclusivityKeys.filter((key) => key.startsWith('calendar_timeline:'));
  if (!target || calendarKeys.length === 0
      || !input.candidate.affectedResources.some((resource) => resource.type === 'calendar_timeline_overlap')) return [];
  const row = getDb().prepare(`
    SELECT revision_document_json AS document
      FROM training_plan_revisions
     WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(target.id, input.scope.userId, input.scope.tenantId) as { document: string } | undefined;
  if (!row) return [];
  let document: {
    capacityContext?: { source?: string };
    weeks?: Array<{ workouts?: Array<{
      scheduledStartAt?: string;
      scheduledEndAt?: string;
      scheduleTimeZone?: string;
      sessionType?: string;
    }> }>;
  };
  try { document = JSON.parse(row.document); } catch { return []; }
  if (document.capacityContext?.source !== 'AUTHORITATIVE') return [];
  const windows = (document.weeks ?? []).flatMap((week) => week.workouts ?? [])
    .filter((workout) => workout.sessionType !== 'rest'
      && validIso(workout.scheduledStartAt)
      && validIso(workout.scheduledEndAt)
      && typeof workout.scheduleTimeZone === 'string')
    .map((workout) => ({
      start: new Date(workout.scheduledStartAt!).toISOString(),
      end: new Date(workout.scheduledEndAt!).toISOString(),
      timezone: workout.scheduleTimeZone!,
    }));
  if (windows.length === 0) return [];
  const start = windows.reduce((value, window) => window.start < value ? window.start : value, windows[0].start);
  const end = windows.reduce((value, window) => window.end > value ? window.end : value, windows[0].end);
  const rows = getDb().prepare(`
    SELECT agenda_item_id AS agendaItemId, version, source_shape_hash AS sourceShapeHash,
           start_at AS startAt, end_at AS endAt,
           lifecycle_state AS lifecycleState, provider_sync_state AS providerSyncState,
           provider_event_id AS providerEventId, provider_source AS providerSource,
           decision_action AS decisionAction,
           decision_reason_codes_json AS decisionReasonCodes,
           decision_explanation AS decisionExplanation,
           scheduled_segments_json AS scheduledSegments,
           updated_at AS updatedAt, created_at AS createdAt
      FROM secretary_agenda_items
     WHERE owner_user_id = ? AND tenant_id = ?
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed')
       AND start_at IS NOT NULL AND end_at IS NOT NULL
       AND datetime(start_at) < datetime(?) AND datetime(end_at) > datetime(?)
     ORDER BY start_at ASC
     LIMIT 200
  `).all(input.scope.userId, String(input.scope.tenantId), end, start) as Array<{
    agendaItemId: string;
    version: number;
    sourceShapeHash: string;
    startAt: string;
    endAt: string;
    lifecycleState: string;
    providerSyncState: string;
    providerEventId: string | null;
    providerSource: string | null;
    decisionAction: string | null;
    decisionReasonCodes: string | null;
    decisionExplanation: string | null;
    scheduledSegments: string | null;
    updatedAt: string;
    createdAt: string;
  }>;
  const commitments = rows.flatMap((agenda) => {
    const agendaStart = Date.parse(agenda.startAt);
    const agendaEnd = Date.parse(agenda.endAt);
    if (!Number.isFinite(agendaStart) || !Number.isFinite(agendaEnd) || agendaEnd <= agendaStart) return [];
    const overlap = windows.find((window) => agendaStart < Date.parse(window.end) && agendaEnd > Date.parse(window.start));
    if (!overlap) return [];
    const action = buildNormalizedDecisionAction({
      intent: 'preserve_approved_secretary_commitment',
      targetEntities: [{ type: 'secretary_agenda_item', id: agenda.agendaItemId, version: String(agenda.version) }],
      affectedResources: [
        { type: 'calendar_timeline_overlap', id: 'primary' },
        { type: 'training_schedule', id: target.id },
      ],
      requestedWindow: { start: agenda.startAt, end: agenda.endAt, timezone: overlap.timezone },
      preconditions: [{
        type: 'agenda_state',
        ref: agenda.agendaItemId,
        expectedVersion: secretaryAgendaStateRevision(agenda),
        required: true,
      }],
      expectedEffects: [{ type: 'preserve_commitment', targetRef: `secretary_agenda_item:${agenda.agendaItemId}` }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: calendarKeys,
      authorizationScope: ['calendar:read'],
      risk: 'medium',
      reversibility: 'irreversible',
      contextVersion: `agenda:${agenda.agendaItemId}:${agenda.version}`,
    });
    return [{
      action,
      decisionId: `agenda:${agenda.agendaItemId}`,
      authority: 'approved_commitment' as const,
      approved: true,
      createdAt: agenda.createdAt,
      updatedAt: agenda.updatedAt,
    }];
  });
  if (commitments.length > 0) {
    incrementTrainingGenerationCounter('m4_cross_domain_conflict_total', commitments.length);
  }
  return commitments;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
