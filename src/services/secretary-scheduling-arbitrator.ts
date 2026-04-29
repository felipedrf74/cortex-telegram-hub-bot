// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary scheduling arbitrator.
 *
 * This service is the first runtime layer over migration 083's
 * `secretary_agenda_items` ledger. It gives skills a typed way to ask
 * Secretary for time without writing provider events directly.
 *
 * Scope of this layer:
 * - normalize scheduling intents from skills,
 * - choose a feasible slot using explicit capacity inputs,
 * - persist agenda ownership/lifecycle state,
 * - expose source-skill feedback and decision reasons.
 *
 * Provider sync is performed by `secretary-agenda-provider-sync` using the
 * persisted agenda item and provider_sync_state fields, so retries stay
 * idempotent and the scheduling engine remains provider-agnostic.
 */

import crypto from 'crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';

export type SecretarySourceSkill = 'secretary' | 'training' | 'cooking' | 'finance' | 'content';

export type SecretarySchedulingIntentAction =
  | 'schedule_this'
  | 'reschedule_this'
  | 'cancel_this'
  | 'find_time_for_this'
  | 'protect_time_for_this'
  | 'create_reminder'
  | 'create_follow_up'
  | 'request_clarification';

export type SecretaryAgendaLifecycleState =
  | 'proposed'
  | 'scheduled'
  | 'synced'
  | 'reflowed'
  | 'compressed'
  | 'deferred'
  | 'canceled'
  | 'superseded'
  | 'unscheduled'
  | 'failed_sync'
  | 'completed';

export type SecretaryProviderSyncState =
  | 'not_synced'
  | 'synced'
  | 'create_failed'
  | 'update_failed'
  | 'delete_failed'
  | 'readback_failed'
  | 'deleted';

export type SecretarySchedulingDecisionStatus =
  | 'scheduled'
  | 'reflowed'
  | 'compressed'
  | 'deferred'
  | 'unscheduled'
  | 'rejected'
  | 'needs_more_context';

export type SecretaryIntentPriority = 'low' | 'normal' | 'high' | 'urgent' | number;
export type SecretaryIntentFlexibility = 'fixed' | 'flexible' | 'compressible' | 'splittable';

export interface SecretaryTimeWindow {
  start: string;
  end: string;
  label?: string;
  hard?: boolean;
}

export interface SecretarySchedulingIntent {
  intentId: string;
  action?: SecretarySchedulingIntentAction;
  sourceSkill: SecretarySourceSkill;
  sourceAction?: string | null;
  sourceEntityId?: string | number | null;
  sourceEntityType?: string | null;
  ownerUserId: number;
  tenantId: string | number;
  title: string;
  requestedDurationMinutes?: number | null;
  minimumDurationMinutes?: number | null;
  preferredWindows?: SecretaryTimeWindow[];
  hardConstraints?: {
    unavailableWindows?: SecretaryTimeWindow[];
    protectedWindows?: SecretaryTimeWindow[];
    hardCommitments?: SecretaryTimeWindow[];
  };
  softPreferences?: Record<string, unknown>;
  deadline?: string | null;
  priority?: SecretaryIntentPriority;
  flexibility?: SecretaryIntentFlexibility;
  recurrence?: unknown;
  dependencies?: string[];
  energyCost?: number | null;
  reason?: string | null;
  context?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SecretaryAgendaItem {
  agendaItemId: string;
  sourceIntentId: string;
  sourceSkill: SecretarySourceSkill;
  sourceAction: string | null;
  intentAction: SecretarySchedulingIntentAction;
  sourceEntityId: string | null;
  sourceEntityType: string | null;
  ownerUserId: number;
  tenantId: string;
  lifecycleState: SecretaryAgendaLifecycleState;
  providerSyncState: SecretaryProviderSyncState;
  providerEventId: string | null;
  providerSource: string | null;
  version: number;
  title: string;
  startAt: string | null;
  endAt: string | null;
  durationMinutes: number | null;
  decisionAction: SecretarySchedulingDecisionStatus;
  decisionReasonCodes: string[];
  sourceShapeHash: string;
  scheduledSegments: SecretaryTimeWindow[];
  cancellationReason: string | null;
  supersededByAgendaItemId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface SecretarySchedulingDecision {
  status: SecretarySchedulingDecisionStatus;
  agendaItem: SecretaryAgendaItem;
  reasonCodes: string[];
  explanation: string;
  selectedSlot: SecretaryTimeWindow | null;
  alternativeSlots: SecretaryTimeWindow[];
  conflicts: string[];
  downstreamImplications: string[];
  confidence: 'low' | 'medium' | 'high';
  feedback: SecretarySourceSkillFeedback;
}

export interface SecretarySourceSkillFeedback {
  sourceSkill: SecretarySourceSkill;
  sourceIntentId: string;
  agendaItemId: string;
  status: SecretarySchedulingDecisionStatus;
  reasonCodes: string[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  shouldRefreshSource: boolean;
  downstreamImplications: string[];
}

export interface SecretarySchedulingBatchResult {
  decisions: SecretarySchedulingDecision[];
  scheduledCount: number;
  unscheduledCount: number;
  feedbackBySourceSkill: Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]>;
}

export interface SecretarySchedulingOptions {
  existingAgendaItems?: Array<Pick<SecretaryAgendaItem, 'startAt' | 'endAt' | 'lifecycleState' | 'title'>>;
  additionalBusyWindows?: SecretaryTimeWindow[];
  now?: string;
}

type NormalizedWindow = {
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  label?: string;
};

type CandidateSlot = {
  startMs: number;
  endMs: number;
  durationMinutes: number;
  sourceWindow: NormalizedWindow;
};

const ACTIVE_BUSY_STATES = new Set<SecretaryAgendaLifecycleState>([
  'scheduled',
  'synced',
  'reflowed',
  'compressed',
  'failed_sync',
]);

const VALID_SOURCE_SKILLS = new Set<SecretarySourceSkill>([
  'secretary',
  'training',
  'cooking',
  'finance',
  'content',
]);

const SKILL_PRIORITY_WEIGHT: Record<SecretarySourceSkill, number> = {
  finance: 16,
  training: 12,
  secretary: 10,
  cooking: 8,
  content: 6,
};

export function submitSecretarySchedulingIntent(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingDecision {
  return scheduleOne(intent, options, []);
}

export function arbitrateSecretarySchedulingIntents(
  intents: SecretarySchedulingIntent[],
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingBatchResult {
  const ordered = [...intents].sort(compareIntentPriority);
  const acceptedBusyWindows: SecretaryTimeWindow[] = [];
  const decisions: SecretarySchedulingDecision[] = [];

  for (const intent of ordered) {
    const decision = scheduleOne(intent, options, acceptedBusyWindows);
    decisions.push(decision);
    if (decision.selectedSlot && ['scheduled', 'reflowed', 'compressed'].includes(decision.status)) {
      acceptedBusyWindows.push(decision.selectedSlot);
    }
  }

  const feedbackBySourceSkill = buildFeedbackBySourceSkill(decisions);
  return {
    decisions,
    scheduledCount: decisions.filter((decision) => ['scheduled', 'reflowed', 'compressed'].includes(decision.status)).length,
    unscheduledCount: decisions.filter((decision) => ['unscheduled', 'deferred', 'rejected', 'needs_more_context'].includes(decision.status)).length,
    feedbackBySourceSkill,
  };
}

export function listSecretaryAgendaItems(scope: {
  ownerUserId: number;
  tenantId: string | number;
  includeInactive?: boolean;
}): SecretaryAgendaItem[] {
  const db = getDb();
  const tenantId = normalizeTenantId(scope.tenantId);
  const rows = scope.includeInactive
    ? db.prepare(`
        SELECT * FROM secretary_agenda_items
        WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY COALESCE(start_at, updated_at) ASC, version ASC
      `).all(scope.ownerUserId, tenantId)
    : db.prepare(`
        SELECT * FROM secretary_agenda_items
        WHERE owner_user_id = ? AND tenant_id = ?
          AND lifecycle_state NOT IN ('canceled', 'superseded', 'completed')
        ORDER BY COALESCE(start_at, updated_at) ASC, version ASC
      `).all(scope.ownerUserId, tenantId);
  return rows.map(rowToAgendaItem);
}

export function getSecretaryAgendaItemById(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
}): SecretaryAgendaItem | null {
  const row = getDb().prepare(`
    SELECT *
    FROM secretary_agenda_items
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
  `).get(scope.agendaItemId, scope.ownerUserId, normalizeTenantId(scope.tenantId));
  return row ? rowToAgendaItem(row) : null;
}

export function cancelSecretaryAgendaItem(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  reason?: string | null;
  now?: string;
}): SecretaryAgendaItem | null {
  const nowIso = normalizeNow(scope.now);
  getDb().prepare(`
    UPDATE secretary_agenda_items
    SET lifecycle_state = 'canceled',
        cancellation_reason = COALESCE(?, cancellation_reason),
        updated_at = ?
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
      AND lifecycle_state NOT IN ('canceled', 'completed')
  `).run(
    scope.reason ?? null,
    nowIso,
    scope.agendaItemId,
    scope.ownerUserId,
    normalizeTenantId(scope.tenantId),
  );
  return getSecretaryAgendaItemById(scope);
}

function scheduleOne(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions,
  acceptedBusyWindows: SecretaryTimeWindow[],
): SecretarySchedulingDecision {
  const nowIso = normalizeNow(options.now);
  const validation = validateIntent(intent);
  if (validation.length > 0) {
    return persistDecision({
      intent,
      nowIso,
      status: validation.includes('invalid_source_skill') || validation.includes('invalid_owner_scope')
        ? 'rejected'
        : 'needs_more_context',
      lifecycleState: validation.includes('invalid_source_skill') || validation.includes('invalid_owner_scope')
        ? 'unscheduled'
        : 'proposed',
      reasonCodes: validation,
      explanation: explainDecision(intent, validation.includes('invalid_source_skill') ? 'rejected' : 'needs_more_context', validation),
      selectedSlot: null,
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: downstreamFor(intent, validation.includes('missing_duration') ? 'needs_more_context' : 'rejected'),
    });
  }

  const latest = findLatestAgendaItemForIntent(intent);
  const sourceShapeHash = computeSourceShapeHash(intent);
  const duration = Math.max(1, Math.round(Number(intent.requestedDurationMinutes)));
  const busyWindows = buildBusyWindows(intent, options, acceptedBusyWindows);
  const candidateWindows = normalizeWindows(intent.preferredWindows ?? []);
  const exactSlot = findFirstAvailableSlot(candidateWindows, busyWindows, duration);

  if (exactSlot) {
    const reflowed = latest
      && latest.lifecycleState !== 'superseded'
      && latest.startAt
      && latest.endAt
      && (Date.parse(latest.startAt) !== exactSlot.startMs || Date.parse(latest.endAt) !== exactSlot.endMs);
    const status: SecretarySchedulingDecisionStatus = reflowed ? 'reflowed' : 'scheduled';
    const reasonCodes = reflowed
      ? ['reflowed_to_available_window', ...slotReasonCodes(intent, exactSlot)]
      : ['scheduled_in_available_window', ...slotReasonCodes(intent, exactSlot)];

    return persistDecision({
      intent,
      nowIso,
      status,
      lifecycleState: reflowed ? 'reflowed' : 'scheduled',
      reasonCodes,
      explanation: explainDecision(intent, status, reasonCodes),
      selectedSlot: slotToWindow(exactSlot),
      alternativeSlots: candidateWindowsToAlternatives(candidateWindows, exactSlot),
      conflicts: conflictSummaries(busyWindows),
      downstreamImplications: downstreamFor(intent, status),
      latest,
      sourceShapeHash,
    });
  }

  if ((intent.flexibility ?? 'flexible') === 'compressible') {
    const minimumDuration = Math.max(
      15,
      Math.min(duration, Math.round(Number(intent.minimumDurationMinutes ?? Math.ceil(duration * 0.6)))),
    );
    const compressedSlot = findLargestAvailableSlot(candidateWindows, busyWindows, minimumDuration, duration);
    if (compressedSlot) {
      const reasonCodes = ['compressed_to_fit_capacity', ...slotReasonCodes(intent, compressedSlot)];
      return persistDecision({
        intent,
        nowIso,
        status: 'compressed',
        lifecycleState: 'compressed',
        reasonCodes,
        explanation: explainDecision(intent, 'compressed', reasonCodes),
        selectedSlot: slotToWindow(compressedSlot),
        alternativeSlots: candidateWindowsToAlternatives(candidateWindows, compressedSlot),
        conflicts: conflictSummaries(busyWindows),
        downstreamImplications: downstreamFor(intent, 'compressed'),
        latest,
        sourceShapeHash,
      });
    }
  }

  const hasFutureDeadline = hasDeadlineAfterWindows(intent.deadline, candidateWindows);
  const status: SecretarySchedulingDecisionStatus = hasFutureDeadline && (intent.flexibility ?? 'flexible') === 'flexible'
    ? 'deferred'
    : 'unscheduled';
  const reasonCodes = [
    status === 'deferred' ? 'deferred_due_to_current_capacity' : 'unscheduled_no_capacity',
    candidateWindows.length === 0 ? 'missing_availability' : 'no_valid_slot',
    ...priorityReasonCodes(intent),
  ];

  return persistDecision({
    intent,
    nowIso,
    status,
    lifecycleState: status,
    reasonCodes,
    explanation: explainDecision(intent, status, reasonCodes),
    selectedSlot: null,
    alternativeSlots: candidateWindows.map((window) => ({ start: window.start, end: window.end, label: window.label })),
    conflicts: conflictSummaries(busyWindows),
    downstreamImplications: downstreamFor(intent, status),
    latest,
    sourceShapeHash,
  });
}

function persistDecision(input: {
  intent: SecretarySchedulingIntent;
  nowIso: string;
  status: SecretarySchedulingDecisionStatus;
  lifecycleState: SecretaryAgendaLifecycleState;
  reasonCodes: string[];
  explanation: string;
  selectedSlot: SecretaryTimeWindow | null;
  alternativeSlots: SecretaryTimeWindow[];
  conflicts: string[];
  downstreamImplications: string[];
  latest?: SecretaryAgendaItem | null;
  sourceShapeHash?: string;
}): SecretarySchedulingDecision {
  const db = getDb();
  const tenantId = normalizeTenantId(input.intent.tenantId);
  const latest = input.latest ?? findLatestAgendaItemForIntent(input.intent);
  const sourceShapeHash = input.sourceShapeHash ?? computeSourceShapeHash(input.intent);

  if (
    latest
    && latest.sourceShapeHash === sourceShapeHash
    && latest.lifecycleState !== 'superseded'
    && agendaSlotMatches(latest, input.selectedSlot)
  ) {
    return decisionFromExisting(input.intent, latest, input.status, input.reasonCodes, input.explanation, input.conflicts, input.downstreamImplications);
  }

  const version = latest ? latest.version + 1 : 1;
  const agendaItemId = buildAgendaItemId(input.intent, version);
  const startAt = input.selectedSlot?.start ?? null;
  const endAt = input.selectedSlot?.end ?? null;
  const durationMinutes = input.selectedSlot
    ? minutesBetween(input.selectedSlot.start, input.selectedSlot.end)
    : input.intent.requestedDurationMinutes != null
      ? Math.round(Number(input.intent.requestedDurationMinutes))
      : null;

  const writeAgendaItem = db.transaction(() => {
    if (latest && latest.lifecycleState !== 'superseded') {
      db.prepare(`
        UPDATE secretary_agenda_items
        SET lifecycle_state = 'superseded',
            provider_sync_state = CASE
              WHEN provider_sync_state = 'not_synced' THEN 'not_synced'
              ELSE provider_sync_state
            END,
            superseded_by_agenda_item_id = ?,
            updated_at = ?
        WHERE agenda_item_id = ?
      `).run(agendaItemId, input.nowIso, latest.agendaItemId);
    }

    db.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, provider_event_id, provider_source,
        version, title, start_at, end_at, duration_minutes, decision_action,
        decision_reason_codes_json, source_shape_hash, scheduled_segments_json,
        cancellation_reason, superseded_by_agenda_item_id, created_at, updated_at,
        completed_at, source_created_at, source_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_synced', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)
    `).run(
      agendaItemId,
      input.intent.intentId,
      input.intent.sourceSkill,
      input.intent.sourceAction ?? null,
      input.intent.action ?? defaultActionForStatus(input.status),
      input.intent.sourceEntityId != null ? String(input.intent.sourceEntityId) : null,
      input.intent.sourceEntityType ?? null,
      input.intent.ownerUserId,
      tenantId,
      input.lifecycleState,
      version,
      input.intent.title.trim(),
      startAt,
      endAt,
      durationMinutes,
      input.status,
      JSON.stringify(input.reasonCodes),
      sourceShapeHash,
      JSON.stringify(input.selectedSlot ? [input.selectedSlot] : []),
      input.nowIso,
      input.nowIso,
      input.intent.createdAt ?? null,
      input.intent.updatedAt ?? null,
    );
  });

  writeAgendaItem();

  const agendaItem = findAgendaItemById(agendaItemId);
  if (!agendaItem) {
    logger.error({ agendaItemId }, 'Secretary agenda item insert succeeded but row could not be read back');
    throw new Error('Secretary agenda item insert read-back failed');
  }

  return {
    status: input.status,
    agendaItem,
    reasonCodes: input.reasonCodes,
    explanation: input.explanation,
    selectedSlot: input.selectedSlot,
    alternativeSlots: input.alternativeSlots,
    conflicts: input.conflicts,
    downstreamImplications: input.downstreamImplications,
    confidence: confidenceFor(input.status, input.reasonCodes),
    feedback: buildFeedback(input.intent, agendaItem, input.status, input.reasonCodes, input.downstreamImplications),
  };
}

function agendaSlotMatches(agendaItem: SecretaryAgendaItem, selectedSlot: SecretaryTimeWindow | null): boolean {
  if (!selectedSlot) return agendaItem.startAt === null && agendaItem.endAt === null;
  return agendaItem.startAt === selectedSlot.start && agendaItem.endAt === selectedSlot.end;
}

function decisionFromExisting(
  intent: SecretarySchedulingIntent,
  agendaItem: SecretaryAgendaItem,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: string[],
  explanation: string,
  conflicts: string[],
  downstreamImplications: string[],
): SecretarySchedulingDecision {
  const selectedSlot = agendaItem.startAt && agendaItem.endAt
    ? { start: agendaItem.startAt, end: agendaItem.endAt }
    : null;
  const resolvedStatus = agendaItem.decisionAction || status;
  return {
    status: resolvedStatus,
    agendaItem,
    reasonCodes: agendaItem.decisionReasonCodes.length > 0 ? agendaItem.decisionReasonCodes : reasonCodes,
    explanation,
    selectedSlot,
    alternativeSlots: [],
    conflicts,
    downstreamImplications,
    confidence: confidenceFor(resolvedStatus, reasonCodes),
    feedback: buildFeedback(intent, agendaItem, resolvedStatus, reasonCodes, downstreamImplications),
  };
}

function validateIntent(intent: SecretarySchedulingIntent): string[] {
  const reasonCodes: string[] = [];
  if (!Number.isFinite(intent.ownerUserId) || intent.ownerUserId <= 0) reasonCodes.push('invalid_owner_scope');
  if (!normalizeTenantId(intent.tenantId)) reasonCodes.push('invalid_tenant_scope');
  if (!VALID_SOURCE_SKILLS.has(intent.sourceSkill)) reasonCodes.push('invalid_source_skill');
  if (!intent.intentId?.trim()) reasonCodes.push('missing_intent_id');
  if (!intent.title?.trim()) reasonCodes.push('missing_title');
  if (!Number.isFinite(Number(intent.requestedDurationMinutes)) || Number(intent.requestedDurationMinutes) <= 0) {
    reasonCodes.push('missing_duration');
  }
  if (!Array.isArray(intent.preferredWindows) || intent.preferredWindows.length === 0) {
    reasonCodes.push('missing_availability');
  }
  return reasonCodes;
}

function findLatestAgendaItemForIntent(intent: SecretarySchedulingIntent): SecretaryAgendaItem | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM secretary_agenda_items
    WHERE owner_user_id = ?
      AND tenant_id = ?
      AND source_skill = ?
      AND source_intent_id = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(
    intent.ownerUserId,
    normalizeTenantId(intent.tenantId),
    intent.sourceSkill,
    intent.intentId,
  );
  return row ? rowToAgendaItem(row) : null;
}

function findAgendaItemById(agendaItemId: string): SecretaryAgendaItem | null {
  const row = getDb().prepare('SELECT * FROM secretary_agenda_items WHERE agenda_item_id = ?').get(agendaItemId);
  return row ? rowToAgendaItem(row) : null;
}

function buildBusyWindows(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions,
  acceptedBusyWindows: SecretaryTimeWindow[],
): NormalizedWindow[] {
  const persisted = listSecretaryAgendaItems({
    ownerUserId: intent.ownerUserId,
    tenantId: intent.tenantId,
  })
    .filter((item) => item.sourceSkill !== intent.sourceSkill || item.sourceIntentId !== intent.intentId)
    .filter((item) => ACTIVE_BUSY_STATES.has(item.lifecycleState) && item.startAt && item.endAt)
    .map((item) => ({
      start: item.startAt!,
      end: item.endAt!,
      label: item.title,
    }));
  const existing = (options.existingAgendaItems ?? [])
    .filter((item) => ACTIVE_BUSY_STATES.has(item.lifecycleState) && item.startAt && item.endAt)
    .map((item) => ({
      start: item.startAt!,
      end: item.endAt!,
      label: item.title,
    }));
  return normalizeWindows([
    ...persisted,
    ...existing,
    ...(options.additionalBusyWindows ?? []),
    ...acceptedBusyWindows,
    ...(intent.hardConstraints?.unavailableWindows ?? []),
    ...(intent.hardConstraints?.protectedWindows ?? []),
    ...(intent.hardConstraints?.hardCommitments ?? []),
  ]);
}

function normalizeWindows(windows: SecretaryTimeWindow[]): NormalizedWindow[] {
  const normalized: NormalizedWindow[] = [];
  for (const window of windows) {
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const item: NormalizedWindow = {
      startMs,
      endMs,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    };
    if (window.label) item.label = window.label;
    normalized.push(item);
  }
  return normalized.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function findFirstAvailableSlot(
  windows: NormalizedWindow[],
  busyWindows: NormalizedWindow[],
  durationMinutes: number,
): CandidateSlot | null {
  const durationMs = durationMinutes * 60_000;
  for (const window of windows) {
    const slot = findSlotInWindow(window, busyWindows, durationMs, durationMs);
    if (slot) return slot;
  }
  return null;
}

function findLargestAvailableSlot(
  windows: NormalizedWindow[],
  busyWindows: NormalizedWindow[],
  minimumDurationMinutes: number,
  requestedDurationMinutes: number,
): CandidateSlot | null {
  const minimumMs = minimumDurationMinutes * 60_000;
  const requestedMs = requestedDurationMinutes * 60_000;
  let best: CandidateSlot | null = null;
  for (const window of windows) {
    const slot = findSlotInWindow(window, busyWindows, minimumMs, requestedMs);
    if (!slot) continue;
    if (!best || slot.durationMinutes > best.durationMinutes) best = slot;
  }
  return best;
}

function findSlotInWindow(
  window: NormalizedWindow,
  busyWindows: NormalizedWindow[],
  minimumMs: number,
  preferredMs: number,
): CandidateSlot | null {
  let cursor = window.startMs;
  const overlaps = busyWindows
    .filter((busy) => busy.endMs > window.startMs && busy.startMs < window.endMs)
    .sort((left, right) => left.startMs - right.startMs);

  for (const busy of overlaps) {
    const gapEnd = Math.min(busy.startMs, window.endMs);
    const gapMs = gapEnd - cursor;
    if (gapMs >= minimumMs) {
      const durationMs = Math.min(preferredMs, gapMs);
      return {
        startMs: cursor,
        endMs: cursor + durationMs,
        durationMinutes: Math.round(durationMs / 60_000),
        sourceWindow: window,
      };
    }
    cursor = Math.max(cursor, busy.endMs);
    if (cursor >= window.endMs) break;
  }

  const tailMs = window.endMs - cursor;
  if (tailMs >= minimumMs) {
    const durationMs = Math.min(preferredMs, tailMs);
    return {
      startMs: cursor,
      endMs: cursor + durationMs,
      durationMinutes: Math.round(durationMs / 60_000),
      sourceWindow: window,
    };
  }
  return null;
}

function slotToWindow(slot: CandidateSlot): SecretaryTimeWindow {
  return {
    start: new Date(slot.startMs).toISOString(),
    end: new Date(slot.endMs).toISOString(),
    label: slot.sourceWindow.label,
  };
}

function candidateWindowsToAlternatives(
  windows: NormalizedWindow[],
  selected: CandidateSlot,
): SecretaryTimeWindow[] {
  return windows
    .filter((window) => window.startMs !== selected.sourceWindow.startMs || window.endMs !== selected.sourceWindow.endMs)
    .slice(0, 3)
    .map((window) => ({ start: window.start, end: window.end, label: window.label }));
}

function conflictSummaries(busyWindows: NormalizedWindow[]): string[] {
  return busyWindows
    .slice(0, 5)
    .map((busy) => busy.label ? `${busy.label}: ${busy.start} - ${busy.end}` : `${busy.start} - ${busy.end}`);
}

function compareIntentPriority(left: SecretarySchedulingIntent, right: SecretarySchedulingIntent): number {
  const leftScore = scoreIntent(left);
  const rightScore = scoreIntent(right);
  if (leftScore !== rightScore) return rightScore - leftScore;
  const leftDeadline = left.deadline ? Date.parse(left.deadline) : Number.POSITIVE_INFINITY;
  const rightDeadline = right.deadline ? Date.parse(right.deadline) : Number.POSITIVE_INFINITY;
  return leftDeadline - rightDeadline || left.intentId.localeCompare(right.intentId);
}

function scoreIntent(intent: SecretarySchedulingIntent): number {
  const base = typeof intent.priority === 'number'
    ? intent.priority
    : intent.priority === 'urgent'
      ? 100
      : intent.priority === 'high'
        ? 70
        : intent.priority === 'low'
          ? 20
          : 45;
  const deadlineBoost = intent.deadline && Number.isFinite(Date.parse(intent.deadline)) ? 18 : 0;
  const fixedBoost = intent.flexibility === 'fixed' ? 8 : 0;
  return base + SKILL_PRIORITY_WEIGHT[intent.sourceSkill] + deadlineBoost + fixedBoost;
}

function priorityReasonCodes(intent: SecretarySchedulingIntent): string[] {
  const codes: string[] = [];
  if (intent.priority === 'urgent' || intent.priority === 'high' || Number(intent.priority) >= 70) {
    codes.push('high_priority_intent');
  }
  if (intent.deadline) codes.push('deadline_present');
  if (intent.sourceSkill === 'finance' && intent.deadline) codes.push('finance_deadline_priority');
  if (intent.sourceSkill === 'training') codes.push('training_schedule_request');
  if (intent.sourceSkill === 'cooking') codes.push('cooking_support_request');
  if (intent.sourceSkill === 'content') codes.push('content_focus_request');
  return codes;
}

function slotReasonCodes(intent: SecretarySchedulingIntent, slot: CandidateSlot): string[] {
  const codes = priorityReasonCodes(intent);
  if (slot.durationMinutes < Number(intent.requestedDurationMinutes)) codes.push('duration_reduced');
  if (intent.flexibility === 'fixed') codes.push('fixed_intent_respected');
  return codes;
}

function hasDeadlineAfterWindows(deadline: string | null | undefined, windows: NormalizedWindow[]): boolean {
  if (!deadline || windows.length === 0) return false;
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return false;
  const latestWindowEnd = Math.max(...windows.map((window) => window.endMs));
  return deadlineMs > latestWindowEnd;
}

function explainDecision(
  intent: SecretarySchedulingIntent,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: string[],
): string {
  const title = intent.title.trim() || 'This item';
  switch (status) {
    case 'scheduled':
      return `${title} was scheduled in an available window.`;
    case 'reflowed':
      return `${title} was moved to a new available window because the previous placement no longer fit.`;
    case 'compressed':
      return `${title} was compressed to fit the available capacity.`;
    case 'deferred':
      return `${title} was deferred because current windows are full but the deadline leaves room to revisit it.`;
    case 'unscheduled':
      return `${title} was left unscheduled because no valid slot was available.`;
    case 'rejected':
      return `${title} was rejected because the scheduling request failed policy or ownership validation.`;
    case 'needs_more_context':
      return reasonCodes.includes('missing_duration')
        ? `${title} needs a duration before Secretary can schedule it.`
        : `${title} needs clearer availability before Secretary can schedule it.`;
    default:
      return `${title} produced a scheduling decision.`;
  }
}

function downstreamFor(
  intent: SecretarySchedulingIntent,
  status: SecretarySchedulingDecisionStatus,
): string[] {
  const implications: string[] = [];
  if (status === 'unscheduled') {
    implications.push(`${intent.sourceSkill} should treat this as not placed on the agenda.`);
  }
  if (status === 'deferred') {
    implications.push(`${intent.sourceSkill} should refresh the intent before the deadline window closes.`);
  }
  if (status === 'compressed') {
    implications.push(`${intent.sourceSkill} should adapt the workload to the shorter scheduled block.`);
  }
  if (status === 'reflowed') {
    implications.push(`${intent.sourceSkill} should refresh any user-facing time copy for this item.`);
  }
  if (status === 'needs_more_context') {
    implications.push(`${intent.sourceSkill} should provide the missing scheduling context or ask the user a targeted question.`);
  }
  return implications;
}

function defaultActionForStatus(status: SecretarySchedulingDecisionStatus): SecretarySchedulingIntentAction {
  if (status === 'needs_more_context') return 'request_clarification';
  if (status === 'unscheduled') return 'find_time_for_this';
  return 'schedule_this';
}

function buildFeedback(
  intent: SecretarySchedulingIntent,
  agendaItem: SecretaryAgendaItem,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: string[],
  downstreamImplications: string[],
): SecretarySourceSkillFeedback {
  return {
    sourceSkill: intent.sourceSkill,
    sourceIntentId: intent.intentId,
    agendaItemId: agendaItem.agendaItemId,
    status,
    reasonCodes,
    scheduledStart: agendaItem.startAt,
    scheduledEnd: agendaItem.endAt,
    shouldRefreshSource: ['reflowed', 'compressed', 'deferred', 'unscheduled', 'needs_more_context'].includes(status),
    downstreamImplications,
  };
}

function buildFeedbackBySourceSkill(decisions: SecretarySchedulingDecision[]): Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]> {
  const empty: Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]> = {
    secretary: [],
    training: [],
    cooking: [],
    finance: [],
    content: [],
  };
  for (const decision of decisions) {
    empty[decision.feedback.sourceSkill].push(decision.feedback);
  }
  return empty;
}

function confidenceFor(status: SecretarySchedulingDecisionStatus, reasonCodes: string[]): 'low' | 'medium' | 'high' {
  if (status === 'scheduled' || status === 'reflowed') return 'high';
  if (status === 'compressed' || status === 'deferred') return 'medium';
  if (reasonCodes.includes('missing_duration') || reasonCodes.includes('missing_availability')) return 'low';
  return 'medium';
}

function computeSourceShapeHash(intent: SecretarySchedulingIntent): string {
  return sha256(stableStringify({
    action: intent.action ?? 'schedule_this',
    sourceSkill: intent.sourceSkill,
    sourceEntityId: intent.sourceEntityId ?? null,
    sourceEntityType: intent.sourceEntityType ?? null,
    title: intent.title,
    requestedDurationMinutes: intent.requestedDurationMinutes ?? null,
    minimumDurationMinutes: intent.minimumDurationMinutes ?? null,
    preferredWindows: intent.preferredWindows ?? [],
    hardConstraints: intent.hardConstraints ?? {},
    deadline: intent.deadline ?? null,
    priority: intent.priority ?? 'normal',
    flexibility: intent.flexibility ?? 'flexible',
    dependencies: intent.dependencies ?? [],
    energyCost: intent.energyCost ?? null,
  })).slice(0, 32);
}

function buildAgendaItemId(intent: SecretarySchedulingIntent, version: number): string {
  return `sec_agenda_${sha256(`${intent.ownerUserId}:${normalizeTenantId(intent.tenantId)}:${intent.sourceSkill}:${intent.intentId}:${version}`).slice(0, 24)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function normalizeTenantId(value: string | number): string {
  return String(value ?? '').trim();
}

function normalizeNow(now?: string): string {
  if (now) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
}

function rowToAgendaItem(row: any): SecretaryAgendaItem {
  return {
    agendaItemId: row.agenda_item_id,
    sourceIntentId: row.source_intent_id,
    sourceSkill: row.source_skill,
    sourceAction: row.source_action ?? null,
    intentAction: row.intent_action,
    sourceEntityId: row.source_entity_id ?? null,
    sourceEntityType: row.source_entity_type ?? null,
    ownerUserId: Number(row.owner_user_id),
    tenantId: String(row.tenant_id),
    lifecycleState: row.lifecycle_state,
    providerSyncState: row.provider_sync_state,
    providerEventId: row.provider_event_id ?? null,
    providerSource: row.provider_source ?? null,
    version: Number(row.version),
    title: row.title,
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    decisionAction: row.decision_action,
    decisionReasonCodes: safeParseArray(row.decision_reason_codes_json),
    sourceShapeHash: row.source_shape_hash,
    scheduledSegments: safeParseArray(row.scheduled_segments_json),
    cancellationReason: row.cancellation_reason ?? null,
    supersededByAgendaItemId: row.superseded_by_agenda_item_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    sourceCreatedAt: row.source_created_at ?? null,
    sourceUpdatedAt: row.source_updated_at ?? null,
  };
}

function safeParseArray<T = any>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
