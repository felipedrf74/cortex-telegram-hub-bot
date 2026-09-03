// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from './database';
import {
  cancelSecretaryAgendaItem,
  getSecretaryAgendaItemById,
  previewSecretarySchedulingIntent,
  submitSecretarySchedulingIntent,
  type SecretaryAgendaItem,
  type SecretarySchedulingDecision,
  type SecretarySchedulingIntent,
  type SecretarySchedulingPreview,
  type SecretaryTimeWindow,
} from './secretary-scheduling-arbitrator';
import {
  getContentArtifact,
  getContentRevision,
  getContentWorkspaceItem,
  type ContentNextAction,
  type ContentProductionState,
  type ContentWorkspaceItem,
  type ContentWorkspaceItemType,
  type ContentWorkspaceScope,
} from './content-workspace';
import { getContentRevisionClaimPolicy } from './content-workspace-lineage';
import {
  recordContentWorkspaceProductSignal,
  startContentWorkspaceObservation,
} from './content-workspace-observability';
import { assertContentWorkspaceWriteEnabled } from './content-workspace-capabilities';
import { emitDomainEvent } from './event-outbox';
import { CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_EVENT } from './content-schedule-signal-reconciliation';
import { safeContentLogErrorFields } from './content-log-safety';
import { logger } from '../utils/logger';

export const CONTENT_SCHEDULE_SCHEMA_VERSION = 'content-schedule-v1';
export const CONTENT_SCHEDULE_WORK_KINDS = [
  'write',
  'revise',
  'record',
  'edit',
  'review',
  'publish_prep',
] as const;
export type ContentScheduleWorkKind = typeof CONTENT_SCHEDULE_WORK_KINDS[number];
export type ContentSchedulePriority = 'low' | 'normal' | 'high' | 'urgent';

export const CONTENT_CALENDAR_SCHEMA_VERSION = 'content-calendar-v1';
export const CONTENT_CALENDAR_DEFAULT_LIMIT = 200;
export const CONTENT_CALENDAR_MAX_LIMIT = 500;
export const CONTENT_CALENDAR_MAX_RANGE_DAYS = 366;

export interface ContentCalendarItemSummary {
  id: number;
  itemType: ContentWorkspaceItemType;
  title: string;
  status: ContentProductionState;
  nextAction: ContentNextAction;
}

interface ContentCalendarEntryBase {
  kind: 'deadline' | 'work_block';
  startsAt: string;
  endsAt: string | null;
  item: ContentCalendarItemSummary;
  publicationExecution: 'not_performed';
}

export interface ContentCalendarDeadlineEntry extends ContentCalendarEntryBase {
  kind: 'deadline';
  meaning: 'target_date_not_publication';
  endsAt: null;
}

export interface ContentCalendarWorkBlockEntry extends ContentCalendarEntryBase {
  kind: 'work_block';
  meaning: 'private_work_time_not_publication';
  endsAt: string;
  workKind: ContentScheduleWorkKind;
  schedule: Pick<
    ContentScheduleView,
    | 'state'
    | 'authority'
    | 'authorityStatus'
    | 'visibleTitle'
    | 'titleDisclosure'
    | 'contentChangedSinceScheduling'
    | 'recoverable'
    | 'nextAction'
  >;
}

export type ContentCalendarEntry = ContentCalendarDeadlineEntry | ContentCalendarWorkBlockEntry;

export interface ContentCalendarReadModel {
  schemaVersion: typeof CONTENT_CALENDAR_SCHEMA_VERSION;
  range: {
    from: string;
    to: string;
    semantics: 'from_inclusive_to_exclusive';
  };
  entries: ContentCalendarEntry[];
  hasMore: boolean;
  scheduleAuthority: {
    authority: 'secretary';
    status: 'current' | 'partially_unavailable';
    unavailableEntryCount: number;
  };
  publicationExecution: 'not_performed';
  explanation: 'Deadlines are target dates and work blocks reserve private work time. Neither publishes content.';
}

export interface GetContentCalendarInput {
  scope: ContentWorkspaceScope;
  from: string;
  to: string;
  limit?: number;
}

export interface ContentScheduleChoice {
  start: string;
  end: string;
  recommended: boolean;
}

export interface ContentSchedulePreviewView {
  schemaVersion: typeof CONTENT_SCHEDULE_SCHEMA_VERSION;
  previewKey: string;
  itemId: number;
  status: 'ready' | 'unavailable' | 'submitting' | 'confirmed' | 'failed' | 'stale' | 'expired';
  workKind: ContentScheduleWorkKind;
  durationMinutes: number;
  visibleTitle: string;
  titleDisclosure: 'generic' | 'content_title';
  contextShared: string[];
  choices: ContentScheduleChoice[];
  why: string;
  exactEffect: string;
  expiresAt: string;
  publicationExecution: 'not_performed';
}

export interface ContentScheduleView {
  schemaVersion: typeof CONTENT_SCHEDULE_SCHEMA_VERSION;
  itemId: number;
  state: 'scheduled' | 'provider_synced' | 'sync_failed' | 'cancel_pending' | 'cancel_failed' | 'cancelled' | 'completed' | 'stale';
  localAgendaState: 'scheduled' | 'cancellation_pending' | 'cancelled' | 'completed' | 'stale';
  providerSyncState: 'pending' | 'synced' | 'failed' | 'deletion_pending' | 'deletion_failed' | 'removed';
  authority: 'secretary';
  authorityStatus: 'current' | 'unavailable';
  scheduledStart: string;
  scheduledEnd: string;
  visibleTitle: string;
  titleDisclosure: 'generic' | 'content_title';
  contextShared: string[];
  scheduledRevisionNumber: number;
  contentChangedSinceScheduling: boolean;
  publicationExecution: 'not_performed';
  recoverable: boolean;
  nextAction: 'none' | 'wait_for_provider_sync' | 'retry_cancellation' | 'wait_for_provider_cleanup' | 'create_new_preview' | 'reload_schedule';
}

export interface CreateContentSchedulePreviewInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  artifactId?: number;
  workKind: ContentScheduleWorkKind;
  durationMinutes: number;
  preferredWindows: SecretaryTimeWindow[];
  deadlineAt?: string | null;
  priority?: ContentSchedulePriority;
  shareContentTitle?: boolean;
  idempotencyKey: string;
  now?: string;
}

export interface ConfirmContentSchedulePreviewInput {
  scope: ContentWorkspaceScope;
  previewKey: string;
  selectedSlot?: SecretaryTimeWindow;
  idempotencyKey: string;
  now?: string;
}

export interface CancelContentScheduleInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  idempotencyKey: string;
  now?: string;
}

export interface ContentScheduleMutation<T> {
  value: T;
  replayed: boolean;
  changed: boolean;
}

export class ContentScheduleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentScheduleError';
  }
}

export interface ContentScheduleDependencies {
  preview(intent: SecretarySchedulingIntent, options?: { now?: string }): SecretarySchedulingPreview;
  submit(intent: SecretarySchedulingIntent, options?: { now?: string }): SecretarySchedulingDecision;
  getAgenda(scope: { agendaItemId: string; ownerUserId: number; tenantId: string | number }): SecretaryAgendaItem | null;
  cancelAgenda(scope: {
    agendaItemId: string;
    ownerUserId: number;
    tenantId: string | number;
    reason?: string | null;
    now?: string;
  }): SecretaryAgendaItem | null;
}

const DEFAULT_DEPENDENCIES: ContentScheduleDependencies = {
  preview: previewSecretarySchedulingIntent,
  submit: submitSecretarySchedulingIntent,
  getAgenda: getSecretaryAgendaItemById,
  cancelAgenda: cancelSecretaryAgendaItem,
};

interface SchedulePreviewRow {
  id: number;
  preview_key: string;
  tenant_id: number;
  owner_user_id: number;
  item_id: number;
  artifact_id: number;
  revision_id: number;
  base_revision_number: number;
  base_content_hash: string;
  base_workflow_version: number;
  work_kind: ContentScheduleWorkKind;
  duration_minutes: number;
  preferred_windows_json: string;
  deadline_at: string | null;
  priority: ContentSchedulePriority;
  title_disclosure: 'generic' | 'content_title';
  visible_title: string;
  context_shared_json: string;
  intent_json: string;
  preview_result_json: string;
  preview_fingerprint: string;
  status: 'previewed' | 'unavailable' | 'submitting' | 'confirmed' | 'failed' | 'stale' | 'expired';
  create_idempotency_key: string;
  create_request_hash: string;
  confirmation_idempotency_key: string | null;
  confirmation_request_hash: string | null;
  secretary_source_intent_id: string;
  secretary_agenda_item_id: string | null;
  last_error_code: string | null;
  expires_at: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ScheduleBindingRow {
  id: number;
  tenant_id: number;
  owner_user_id: number;
  item_id: number;
  artifact_id: number;
  revision_id: number;
  base_revision_number: number;
  base_workflow_version: number;
  preview_id: number;
  secretary_agenda_item_id: string;
  secretary_source_intent_id: string;
  state: ContentScheduleView['state'];
  scheduled_start_at: string;
  scheduled_end_at: string;
  visible_title: string;
  title_disclosure: 'generic' | 'content_title';
  context_shared_json: string;
  provider_sync_state: SecretaryAgendaItem['providerSyncState'];
  publication_execution: 'not_performed';
  cancellation_idempotency_key: string | null;
  cancellation_request_hash: string | null;
  last_error_code: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CalendarScheduleBindingRow extends ScheduleBindingRow {
  work_kind: ContentScheduleWorkKind;
}

interface CalendarDeadlineRow {
  item_id: number;
}

interface StoredPreviewResult {
  status: SecretarySchedulingPreview['status'];
  recommendedSlot: SecretaryTimeWindow | null;
  alternatives: SecretaryTimeWindow[];
  reasonCodes: string[];
  confidence: 'low' | 'medium' | 'high';
}

export function createContentSchedulePreview(
  input: CreateContentSchedulePreviewInput,
  db: Database.Database = getDb(),
  dependencies: ContentScheduleDependencies = DEFAULT_DEPENDENCIES,
): ContentScheduleMutation<ContentSchedulePreviewView> {
  const observation = startContentWorkspaceObservation('schedule_preview');
  try {
    assertContentWorkspaceWriteEnabled(normalizeScope(input.scope), 'scheduling');
    const result = createContentSchedulePreviewInternal(input, db, dependencies);
    observation.complete(result.replayed ? 'replayed' : result.changed ? 'success' : 'no_change');
    return result;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

function createContentSchedulePreviewInternal(
  input: CreateContentSchedulePreviewInput,
  db: Database.Database,
  dependencies: ContentScheduleDependencies,
): ContentScheduleMutation<ContentSchedulePreviewView> {
  const scope = normalizeScope(input.scope);
  const itemId = positiveInteger(input.itemId, 'itemId');
  const workKind = enumValue(input.workKind, CONTENT_SCHEDULE_WORK_KINDS, 'workKind');
  const durationMinutes = integerInRange(input.durationMinutes, 15, 480, 'durationMinutes');
  const preferredWindows = normalizeWindows(input.preferredWindows, 'preferredWindows');
  const priority = enumValue(input.priority ?? 'normal', ['low', 'normal', 'high', 'urgent'] as const, 'priority');
  const deadlineAt = optionalIso(input.deadlineAt, 'deadlineAt');
  const shareContentTitle = optionalBoolean(input.shareContentTitle, 'shareContentTitle') ?? false;
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const now = normalizeNow(input.now);
  const requestedArtifactId = input.artifactId == null
    ? null
    : positiveInteger(input.artifactId, 'artifactId');
  // Idempotency describes the normalized client intent, not mutable server
  // state. A lost-response retry must replay the same preview after autosave or
  // a workflow change; confirmation remains the freshness boundary.
  const requestHash = hashPayload({
    itemId,
    artifactId: requestedArtifactId,
    workKind,
    durationMinutes,
    preferredWindows,
    deadlineAt,
    priority,
    shareContentTitle,
  });
  const replay = findPreviewByCreateKey(db, scope, idempotencyKey);
  if (replay) {
    assertMatchingHash(replay.create_request_hash, requestHash, 'create schedule preview');
    return { value: mapPreviewView(replay), replayed: true, changed: false };
  }

  const item = getContentWorkspaceItem(scope, itemId, db);
  if (!item || item.itemType !== 'content_item') {
    throw new ContentScheduleError('CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404);
  }
  assertWorkKindEligible(item.productionState, workKind);
  reconcileContentScheduleBinding(db, dependencies, scope, itemId, now);
  assertNoUnresolvedContentSchedule(db, scope, itemId);

  const artifactId = requestedArtifactId == null
    ? item.currentArtifactId
    : requestedArtifactId;
  const artifact = artifactId == null ? null : getContentArtifact(scope, artifactId, db);
  if (!artifact || artifact.itemId !== item.id || !artifact.currentRevision) {
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_REVISION_REQUIRED',
      'Select a saved content version before scheduling work.',
      409,
    );
  }
  if (requiresReleaseReadiness(workKind)) {
    assertRevisionCanBeScheduled(scope, artifact.currentRevision.id, db);
  }

  const visibleTitle = calendarSafeTitle(shareContentTitle ? item.title : genericScheduleTitle(workKind));
  const titleDisclosure = shareContentTitle ? 'content_title' : 'generic';
  const contextShared = [
    'content_reference',
    'work_kind',
    'duration',
    'availability_windows',
    'priority',
    ...(deadlineAt ? ['deadline'] : []),
    ...(shareContentTitle ? ['content_title'] : []),
  ];
  const previewKey = `csp_${crypto.randomUUID()}`;
  const sourceIntentId = `content-work:${previewKey}`;
  const intent: SecretarySchedulingIntent = {
    intentId: sourceIntentId,
    action: 'find_time_for_this',
    sourceSkill: 'content',
    sourceAction: `schedule_${workKind}`,
    sourceEntityId: previewKey,
    sourceEntityType: 'content_schedule_preview',
    ownerUserId: scope.userId,
    tenantId: scope.tenantId,
    title: visibleTitle,
    requestedDurationMinutes: durationMinutes,
    minimumDurationMinutes: durationMinutes,
    preferredWindows,
    deadline: deadlineAt,
    priority,
    flexibility: 'fixed',
    softPreferences: { contentWorkKind: workKind },
    reason: 'The user requested a protected block for content work.',
    context: null,
    createdAt: now,
    updatedAt: now,
  };

  let result: SecretarySchedulingPreview;
  try {
    result = dependencies.preview(intent, { now });
  } catch {
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_PREVIEW_FAILED',
      'Secretary could not preview a time right now. Nothing was scheduled.',
      503,
      { publicationExecution: 'not_performed', recovery: 'retry_preview' },
    );
  }
  const storedResult: StoredPreviewResult = {
    status: result.status,
    recommendedSlot: sanitizeWindow(result.recommendedSlot),
    alternatives: result.alternatives.map((window) => sanitizeWindow(window)).filter(isWindow),
    reasonCodes: [...result.reasonCodes],
    confidence: result.confidence,
  };
  const ready = isAcceptedSecretaryStatus(result.status) && storedResult.recommendedSlot != null;
  const expiresAt = new Date(Date.parse(now) + 15 * 60_000).toISOString();
  const fingerprint = hashPayload({
    requestHash,
    sourceIntentId,
    result: storedResult,
    expiresAt,
  });

  const stored = db.transaction(() => {
    const existing = findPreviewByCreateKey(db, scope, idempotencyKey);
    if (existing) {
      assertMatchingHash(existing.create_request_hash, requestHash, 'create schedule preview');
      return { row: existing, replayed: true };
    }
    db.prepare(`
      INSERT INTO content_schedule_previews (
        preview_key, tenant_id, owner_user_id, item_id, artifact_id, revision_id,
        base_revision_number, base_content_hash, base_workflow_version,
        work_kind, duration_minutes, preferred_windows_json, deadline_at, priority,
        title_disclosure, visible_title, context_shared_json, intent_json,
        preview_result_json, preview_fingerprint, status,
        create_idempotency_key, create_request_hash, secretary_source_intent_id,
        expires_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      previewKey,
      scope.tenantId,
      scope.userId,
      item.id,
      artifact.id,
      artifact.currentRevision!.id,
      artifact.currentRevision!.revisionNumber,
      artifact.currentRevision!.contentHash,
      item.workflowVersion,
      workKind,
      durationMinutes,
      stableJson(preferredWindows),
      deadlineAt,
      priority,
      titleDisclosure,
      visibleTitle,
      stableJson(contextShared),
      stableJson(intent),
      stableJson(storedResult),
      fingerprint,
      ready ? 'previewed' : 'unavailable',
      idempotencyKey,
      requestHash,
      sourceIntentId,
      expiresAt,
      scope.userId,
      now,
      now,
    );
    const row = findPreviewByKey(db, scope, previewKey);
    if (!row) throw new ContentScheduleError('CONTENT_SCHEDULE_WRITE_FAILED', 'Schedule preview was not readable.', 500);
    return { row, replayed: false };
  }).immediate();

  return { value: mapPreviewView(stored.row), replayed: stored.replayed, changed: !stored.replayed };
}

export function confirmContentSchedulePreview(
  input: ConfirmContentSchedulePreviewInput,
  db: Database.Database = getDb(),
  dependencies: ContentScheduleDependencies = DEFAULT_DEPENDENCIES,
): ContentScheduleMutation<ContentScheduleView> {
  const observation = startContentWorkspaceObservation('schedule_confirm');
  try {
    assertContentWorkspaceWriteEnabled(normalizeScope(input.scope), 'scheduling');
    const result = confirmContentSchedulePreviewInternal(input, db, dependencies);
    observation.complete(result.replayed ? 'replayed' : result.changed ? 'success' : 'no_change');
    if (result.changed) {
      recordContentWorkspaceProductSignal('internal_scheduled_state_or_confirmed_work_block');
    }
    return result;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

function confirmContentSchedulePreviewInternal(
  input: ConfirmContentSchedulePreviewInput,
  db: Database.Database,
  dependencies: ContentScheduleDependencies,
): ContentScheduleMutation<ContentScheduleView> {
  const scope = normalizeScope(input.scope);
  const previewKey = normalizeOpaqueKey(input.previewKey, 'previewKey', 'csp_');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const now = normalizeNow(input.now);

  const prepared = db.transaction(() => {
    const preview = requirePreview(db, scope, previewKey);
    const result = parseStoredPreviewResult(preview.preview_result_json);
    if (preview.status === 'unavailable') {
      throw new ContentScheduleError(
        'CONTENT_SCHEDULE_SLOT_UNAVAILABLE',
        'Secretary did not find a suitable time. Create a new preview with different availability.',
        409,
        { recovery: 'create_new_preview' },
      );
    }
    const selected = input.selectedSlot == null
      ? result.recommendedSlot
      : normalizeWindow(input.selectedSlot, 'selectedSlot');
    if (!selected || !previewChoices(result).some((choice) => windowsEqual(choice, selected))) {
      throw new ContentScheduleError(
        'CONTENT_SCHEDULE_SLOT_INVALID',
        'Choose one of the current Secretary preview options.',
        400,
      );
    }
    const requestHash = hashPayload({ previewKey, selectedSlot: selected });
    if (preview.confirmation_idempotency_key) {
      if (preview.confirmation_idempotency_key !== idempotencyKey) {
        throw new ContentScheduleError(
          'CONTENT_SCHEDULE_CONFIRMATION_IN_PROGRESS',
          'This preview already has a confirmation request. Reload its current state before retrying.',
          409,
          { recovery: 'reload_schedule' },
        );
      }
      assertMatchingHash(preview.confirmation_request_hash, requestHash, 'confirm schedule preview');
    }
    if (preview.status === 'confirmed') {
      const binding = findBindingByPreview(db, scope, preview.id);
      if (!binding) throw inconsistentScheduleState();
      return { kind: 'replay' as const, binding };
    }
    if (preview.status === 'expired' || Date.parse(preview.expires_at) <= Date.parse(now)) {
      if (preview.status === 'previewed' || preview.status === 'failed') {
        db.prepare(`
          UPDATE content_schedule_previews
             SET status = 'expired', updated_at = ?
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
        `).run(now, preview.id, scope.tenantId, scope.userId);
      }
      return { kind: 'expired' as const };
    }
    const staleReason = schedulePreviewStaleReason(db, scope, preview);
    if (staleReason) {
      if (preview.status !== 'stale') {
        db.prepare(`
          UPDATE content_schedule_previews
             SET status = 'stale', last_error_code = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
        `).run(staleReason, now, preview.id, scope.tenantId, scope.userId);
      }
      return { kind: 'stale' as const, reason: staleReason };
    }
    if (requiresReleaseReadiness(preview.work_kind)) {
      assertRevisionCanBeScheduled(scope, preview.revision_id, db);
    }
    if (preview.status === 'previewed' || preview.status === 'failed') {
      db.prepare(`
        UPDATE content_schedule_previews
           SET status = 'submitting', confirmation_idempotency_key = ?,
               confirmation_request_hash = ?, last_error_code = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
      `).run(idempotencyKey, requestHash, now, preview.id, scope.tenantId, scope.userId);
    } else if (preview.status !== 'submitting') {
      throw new ContentScheduleError('CONTENT_SCHEDULE_CONFIRMATION_INVALID', 'This preview cannot be confirmed.', 409);
    }
    return { kind: 'submit' as const, preview: requirePreview(db, scope, previewKey), selected };
  }).immediate();

  if (prepared.kind === 'replay') {
    db.transaction(() => {
      enqueueContentScheduleSignalReconciliation(db, scope, prepared.binding);
    }).immediate();
    return {
      value: mapScheduleView(
        prepared.binding,
        readAgendaFamily(
          dependencies,
          scope,
          prepared.binding.secretary_source_intent_id,
          prepared.binding.secretary_agenda_item_id,
          db,
        ),
        db,
        scope,
      ),
      replayed: true,
      changed: false,
    };
  }
  if (prepared.kind === 'expired') {
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_PREVIEW_EXPIRED',
      'This scheduling preview expired. Your content was preserved; create a new preview.',
      409,
      { recovery: 'create_new_preview', publicationExecution: 'not_performed' },
    );
  }
  if (prepared.kind === 'stale') {
    throw stalePreviewError(prepared.reason);
  }

  const intent = parseStoredIntent(prepared.preview.intent_json);
  const submitIntent: SecretarySchedulingIntent = {
    ...intent,
    action: 'schedule_this',
    preferredWindows: [{ start: prepared.selected.start, end: prepared.selected.end, hard: true }],
    requestedDurationMinutes: minutesBetween(prepared.selected),
    minimumDurationMinutes: minutesBetween(prepared.selected),
    flexibility: 'fixed',
    updatedAt: now,
  };
  let submittedAgendaId: string | null = null;
  let finalized:
    | { kind: 'stale'; reason: string }
    | { kind: 'replay' | 'created'; binding: ScheduleBindingRow };

  try {
    // Secretary persistence and the canonical binding share this SQLite write
    // transaction. With the in-process Secretary adapter, a crash or binding
    // failure rolls both back together. The recovery path below still handles
    // injected/future adapters whose side effect is not transaction-local.
    finalized = db.transaction(() => {
      const preview = requirePreview(db, scope, previewKey);
      if (preview.status === 'confirmed') {
        const existing = findBindingByPreview(db, scope, preview.id);
        if (!existing) throw inconsistentScheduleState();
        return { kind: 'replay' as const, binding: existing };
      }
      const staleReason = schedulePreviewStaleReason(db, scope, preview);
      if (staleReason) {
        db.prepare(`
          UPDATE content_schedule_previews
             SET status = 'stale', last_error_code = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'submitting'
        `).run(staleReason, now, preview.id, scope.tenantId, scope.userId);
        return { kind: 'stale' as const, reason: staleReason };
      }
      if (requiresReleaseReadiness(preview.work_kind)) {
        assertRevisionCanBeScheduled(scope, preview.revision_id, db);
      }
      reconcileContentScheduleBinding(db, dependencies, scope, preview.item_id, now);
      assertNoUnresolvedContentSchedule(db, scope, preview.item_id);

      let decision: SecretarySchedulingDecision;
      try {
        decision = dependencies.submit(submitIntent, { now });
      } catch {
        throw new ContentScheduleError(
          'CONTENT_SECRETARY_SUBMIT_FAILED',
          'Secretary could not confirm the work block. Your content was preserved and nothing was published.',
          503,
          { recovery: 'retry_confirmation', publicationExecution: 'not_performed' },
        );
      }
      submittedAgendaId = decision.agendaItem.agendaItemId;

      if (
        !isAcceptedSecretaryStatus(decision.status)
        || !decision.selectedSlot
        || !windowsEqual(decision.selectedSlot, prepared.selected)
      ) {
        throw new ContentScheduleError(
          'CONTENT_SCHEDULE_SLOT_CHANGED',
          'The selected time changed before confirmation. Your content was preserved; create a new preview.',
          409,
          { recovery: 'create_new_preview', publicationExecution: 'not_performed' },
        );
      }
      if (
        decision.agendaItem.ownerUserId !== scope.userId
        || String(decision.agendaItem.tenantId) !== String(scope.tenantId)
        || decision.agendaItem.sourceIntentId !== preview.secretary_source_intent_id
      ) {
        throw new ContentScheduleError(
          'CONTENT_SECRETARY_SCOPE_MISMATCH',
          'Secretary returned a work block outside the expected private scope.',
          502,
          { recovery: 'retry_confirmation', publicationExecution: 'not_performed' },
        );
      }

      const agendaFamily = readAgendaFamily(
        dependencies,
        scope,
        preview.secretary_source_intent_id,
        decision.agendaItem.agendaItemId,
        db,
      );
      const agenda = agendaFamily[0] ?? null;
      if (
        !agenda
        || agenda.agendaItemId !== decision.agendaItem.agendaItemId
        || agenda.ownerUserId !== scope.userId
        || String(agenda.tenantId) !== String(scope.tenantId)
        || agenda.sourceIntentId !== preview.secretary_source_intent_id
        || !isActiveAgendaLifecycle(agenda.lifecycleState)
        || agenda.startAt !== prepared.selected.start
        || agenda.endAt !== prepared.selected.end
        || agenda.title !== preview.visible_title
      ) {
        throw new ContentScheduleError(
          'CONTENT_SECRETARY_CONFIRMATION_MISMATCH',
          'Secretary could not verify the exact work block that was selected.',
          409,
          { recovery: 'create_new_preview', publicationExecution: 'not_performed' },
        );
      }

      const previewUpdate = db.prepare(`
        UPDATE content_schedule_previews
           SET secretary_agenda_item_id = ?, last_error_code = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'submitting'
      `).run(
        agenda.agendaItemId,
        now,
        preview.id,
        scope.tenantId,
        scope.userId,
      );
      if (previewUpdate.changes !== 1) throw inconsistentScheduleState();

      db.prepare(`
        INSERT INTO content_schedule_bindings (
          tenant_id, owner_user_id, item_id, artifact_id, revision_id,
          base_revision_number, base_workflow_version, preview_id,
          secretary_agenda_item_id, secretary_source_intent_id, state,
          scheduled_start_at, scheduled_end_at, visible_title, title_disclosure,
          context_shared_json, provider_sync_state, publication_execution,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_performed', ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.userId,
        preview.item_id,
        preview.artifact_id,
        preview.revision_id,
        preview.base_revision_number,
        preview.base_workflow_version,
        preview.id,
        agenda.agendaItemId,
        preview.secretary_source_intent_id,
        'scheduled',
        agenda.startAt,
        agenda.endAt,
        preview.visible_title,
        preview.title_disclosure,
        preview.context_shared_json,
        agenda.providerSyncState,
        scope.userId,
        now,
        now,
      );
      const bindingState = bindingStateFor(agenda);
      if (bindingState !== 'scheduled') {
        db.prepare(`
          UPDATE content_schedule_bindings
             SET state = ?, updated_at = ?
           WHERE preview_id = ? AND tenant_id = ? AND owner_user_id = ?
        `).run(bindingState, now, preview.id, scope.tenantId, scope.userId);
      }
      const confirmation = db.prepare(`
        UPDATE content_schedule_previews
           SET status = 'confirmed', confirmed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'submitting'
      `).run(now, now, preview.id, scope.tenantId, scope.userId);
      if (confirmation.changes !== 1) throw inconsistentScheduleState();
      const binding = findBindingByPreview(db, scope, preview.id);
      if (!binding) throw inconsistentScheduleState();
      return { kind: 'created' as const, binding };
    }).immediate();
  } catch (error) {
    const cleanupVerified = submittedAgendaId == null || safeCancelAgendaFamily(
      dependencies,
      scope,
      prepared.preview.secretary_source_intent_id,
      submittedAgendaId,
      now,
      db,
    );
    try {
      if (cleanupVerified) {
        markPreviewFailed(
          db,
          scope,
          prepared.preview.id,
          error instanceof ContentScheduleError ? error.code : 'CONTENT_SCHEDULE_CONFIRMATION_FAILED',
          now,
        );
      } else {
        markPreviewRecoveryRequired(
          db,
          scope,
          prepared.preview.id,
          submittedAgendaId!,
          now,
        );
      }
    } catch {
      // The preview remains `submitting`, which is intentionally recoverable by
      // replay/reconciliation; never replace the originating failure with a
      // best-effort bookkeeping error.
    }
    if (!cleanupVerified) {
      throw new ContentScheduleError(
        'CONTENT_SCHEDULE_RECOVERY_REQUIRED',
        'The work block was not linked to Content and Secretary cleanup is still pending. Retry confirmation to recover safely.',
        503,
        {
          recovery: 'retry_confirmation',
          secretaryCleanup: 'pending',
          publicationExecution: 'not_performed',
        },
      );
    }
    if (error instanceof ContentScheduleError) throw error;
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_CONFIRMATION_FAILED',
      'The work block could not be confirmed. Your content was preserved and no publication occurred.',
      500,
      { recovery: 'retry_confirmation', publicationExecution: 'not_performed' },
    );
  }

  if (finalized.kind === 'stale') throw stalePreviewError(finalized.reason);
  const agendaFamily = readAgendaFamily(
    dependencies,
    scope,
    finalized.binding.secretary_source_intent_id,
    finalized.binding.secretary_agenda_item_id,
    db,
  );
  return {
    value: mapScheduleView(finalized.binding, agendaFamily, db, scope),
    replayed: finalized.kind === 'replay',
    changed: finalized.kind === 'created',
  };
}

export function getContentSchedule(
  scopeInput: ContentWorkspaceScope,
  itemIdInput: number,
  db: Database.Database = getDb(),
  dependencies: ContentScheduleDependencies = DEFAULT_DEPENDENCIES,
): ContentScheduleView | null {
  const scope = normalizeScope(scopeInput);
  const itemId = positiveInteger(itemIdInput, 'itemId');
  if (!getContentWorkspaceItem(scope, itemId, db)) return null;
  const binding = findLatestBinding(db, scope, itemId);
  if (!binding) return null;
  return mapScheduleView(
    binding,
    readAgendaFamily(dependencies, scope, binding.secretary_source_intent_id, binding.secretary_agenda_item_id, db),
    db,
    scope,
  );
}

/**
 * Canonical, owner-scoped calendar projection for Content. A deadline remains
 * a target date and a Secretary agenda remains private work time; neither is
 * represented as a publishing action. Secretary is re-read for every work
 * block so reflow, cancellation, completion, and provider failure are mapped
 * from current authority without exposing agenda or binding identifiers.
 */
export function getContentCalendar(
  input: GetContentCalendarInput,
  db: Database.Database = getDb(),
  dependencies: ContentScheduleDependencies = DEFAULT_DEPENDENCIES,
): ContentCalendarReadModel {
  const scope = normalizeScope(input.scope);
  const from = requiredCalendarIso(input.from, 'from');
  const to = requiredCalendarIso(input.to, 'to');
  if (Date.parse(to) <= Date.parse(from)) {
    throw new ContentScheduleError(
      'CONTENT_VALIDATION_FAILED',
      'to must be after from.',
      400,
      { field: 'to' },
    );
  }
  if (Date.parse(to) - Date.parse(from) > CONTENT_CALENDAR_MAX_RANGE_DAYS * 86_400_000) {
    throw new ContentScheduleError(
      'CONTENT_CALENDAR_RANGE_TOO_LARGE',
      `Calendar ranges cannot exceed ${CONTENT_CALENDAR_MAX_RANGE_DAYS} days.`,
      400,
      { maximumDays: CONTENT_CALENDAR_MAX_RANGE_DAYS },
    );
  }
  const limit = input.limit == null
    ? CONTENT_CALENDAR_DEFAULT_LIMIT
    : integerInRange(input.limit, 1, CONTENT_CALENDAR_MAX_LIMIT, 'limit');
  const candidateLimit = limit + 1;

  const deadlineRows = db.prepare(`
    SELECT o.id AS item_id
      FROM content_domain_objects o
     WHERE o.tenant_id = ?
       AND o.owner_user_id = ?
       AND o.visibility_scope = 'user_private'
       AND o.scope_status = 'active'
       AND o.deleted_at IS NULL
       AND o.object_type IN ('content_item', 'project')
       AND o.production_state <> 'archived'
       AND o.deadline_at >= ?
       AND o.deadline_at < ?
     ORDER BY o.deadline_at ASC, o.id ASC
     LIMIT ?
  `).all(scope.tenantId, scope.userId, from, to, candidateLimit) as CalendarDeadlineRow[];

  const scheduleRows = db.prepare(`
    WITH ranked_bindings AS (
      SELECT binding.*,
             ROW_NUMBER() OVER (
               PARTITION BY binding.item_id
               ORDER BY CASE
                 WHEN binding.state IN (
                   'scheduled', 'provider_synced', 'sync_failed',
                   'cancel_pending', 'cancel_failed'
                 ) THEN 0 ELSE 1
               END,
               binding.id DESC
             ) AS binding_rank
        FROM content_schedule_bindings binding
       WHERE binding.tenant_id = ? AND binding.owner_user_id = ?
    ),
    ranked_agenda AS (
      SELECT agenda.*,
             ROW_NUMBER() OVER (
               PARTITION BY agenda.source_intent_id
               ORDER BY agenda.version DESC, agenda.updated_at DESC
             ) AS agenda_rank
        FROM secretary_agenda_items agenda
       WHERE agenda.owner_user_id = ?
         AND agenda.tenant_id = ?
         AND agenda.source_skill = 'content'
    )
    SELECT binding.*, preview.work_kind
      FROM ranked_bindings binding
      JOIN content_schedule_previews preview
        ON preview.id = binding.preview_id
       AND preview.tenant_id = binding.tenant_id
       AND preview.owner_user_id = binding.owner_user_id
      JOIN content_domain_objects item
        ON item.id = binding.item_id
       AND item.tenant_id = binding.tenant_id
       AND item.owner_user_id = binding.owner_user_id
      LEFT JOIN ranked_agenda agenda
        ON agenda.source_intent_id = binding.secretary_source_intent_id
       AND agenda.agenda_rank = 1
     WHERE binding.binding_rank = 1
       AND item.visibility_scope = 'user_private'
       AND item.scope_status = 'active'
       AND item.deleted_at IS NULL
       AND item.object_type = 'content_item'
       AND item.production_state <> 'archived'
       AND COALESCE(agenda.start_at, binding.scheduled_start_at) < ?
       AND COALESCE(agenda.end_at, binding.scheduled_end_at) > ?
     ORDER BY COALESCE(agenda.start_at, binding.scheduled_start_at) ASC,
              binding.item_id ASC
     LIMIT ?
  `).all(
    scope.tenantId,
    scope.userId,
    scope.userId,
    String(scope.tenantId),
    to,
    from,
    candidateLimit,
  ) as CalendarScheduleBindingRow[];

  const deadlineEntries = deadlineRows.flatMap<ContentCalendarDeadlineEntry>((row) => {
    const item = getContentWorkspaceItem(scope, Number(row.item_id), db);
    if (!item?.deadlineAt) return [];
    return [{
      kind: 'deadline',
      meaning: 'target_date_not_publication',
      startsAt: item.deadlineAt,
      endsAt: null,
      item: mapCalendarItem(item),
      publicationExecution: 'not_performed',
    }];
  });

  const workBlockEntries = scheduleRows.flatMap<ContentCalendarWorkBlockEntry>((row) => {
    const item = getContentWorkspaceItem(scope, Number(row.item_id), db);
    if (!item) return [];
    const schedule = mapScheduleView(
      row,
      readAgendaFamily(
        dependencies,
        scope,
        row.secretary_source_intent_id,
        row.secretary_agenda_item_id,
        db,
      ),
      db,
      scope,
    );
    if (schedule.scheduledStart >= to || schedule.scheduledEnd <= from) return [];
    return [{
      kind: 'work_block',
      meaning: 'private_work_time_not_publication',
      startsAt: schedule.scheduledStart,
      endsAt: schedule.scheduledEnd,
      item: mapCalendarItem(item),
      workKind: row.work_kind,
      schedule: {
        state: schedule.state,
        authority: schedule.authority,
        authorityStatus: schedule.authorityStatus,
        visibleTitle: schedule.visibleTitle,
        titleDisclosure: schedule.titleDisclosure,
        contentChangedSinceScheduling: schedule.contentChangedSinceScheduling,
        recoverable: schedule.recoverable,
        nextAction: schedule.nextAction,
      },
      publicationExecution: 'not_performed',
    }];
  });

  const ordered = [...deadlineEntries, ...workBlockEntries].sort(compareCalendarEntries);
  const entries = ordered.slice(0, limit);
  const unavailableEntryCount = entries.filter((entry) => (
    entry.kind === 'work_block' && entry.schedule.authorityStatus === 'unavailable'
  )).length;
  return {
    schemaVersion: CONTENT_CALENDAR_SCHEMA_VERSION,
    range: { from, to, semantics: 'from_inclusive_to_exclusive' },
    entries,
    hasMore: ordered.length > limit
      || deadlineRows.length === candidateLimit
      || scheduleRows.length === candidateLimit,
    scheduleAuthority: {
      authority: 'secretary',
      status: unavailableEntryCount > 0 ? 'partially_unavailable' : 'current',
      unavailableEntryCount,
    },
    publicationExecution: 'not_performed',
    explanation: 'Deadlines are target dates and work blocks reserve private work time. Neither publishes content.',
  };
}

function mapCalendarItem(item: ContentWorkspaceItem): ContentCalendarItemSummary {
  return {
    id: item.id,
    itemType: item.itemType,
    title: item.title,
    status: item.productionState,
    nextAction: item.nextAction,
  };
}

function compareCalendarEntries(left: ContentCalendarEntry, right: ContentCalendarEntry): number {
  const byStart = left.startsAt.localeCompare(right.startsAt);
  if (byStart !== 0) return byStart;
  if (left.kind !== right.kind) return left.kind === 'deadline' ? -1 : 1;
  return left.item.id - right.item.id;
}

export function cancelContentSchedule(
  input: CancelContentScheduleInput,
  db: Database.Database = getDb(),
  dependencies: ContentScheduleDependencies = DEFAULT_DEPENDENCIES,
): ContentScheduleMutation<ContentScheduleView> {
  const observation = startContentWorkspaceObservation('schedule_cancel');
  try {
    assertContentWorkspaceWriteEnabled(normalizeScope(input.scope), 'scheduling');
    const result = cancelContentScheduleInternal(input, db, dependencies);
    if (result.replayed) observation.complete('replayed');
    else if (result.value.state === 'cancel_failed') observation.complete('failure', 'schedule_cancellation_failure');
    else observation.complete(result.changed ? 'success' : 'no_change');
    return result;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

function cancelContentScheduleInternal(
  input: CancelContentScheduleInput,
  db: Database.Database,
  dependencies: ContentScheduleDependencies,
): ContentScheduleMutation<ContentScheduleView> {
  const scope = normalizeScope(input.scope);
  const itemId = positiveInteger(input.itemId, 'itemId');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const requestHash = hashPayload({ itemId, action: 'cancel_content_work_schedule' });
  const now = normalizeNow(input.now);

  reconcileContentScheduleBinding(db, dependencies, scope, itemId, now);
  const bindingForKey = findBindingByCancellationKey(db, scope, idempotencyKey);
  if (bindingForKey) {
    assertMatchingHash(bindingForKey.cancellation_request_hash, requestHash, 'cancel content schedule');
    if (bindingForKey.item_id !== itemId) {
      throw new ContentScheduleError(
        'CONTENT_IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for another content schedule.',
        409,
      );
    }
    const replayAgendaFamily = readAgendaFamily(
      dependencies,
      scope,
      bindingForKey.secretary_source_intent_id,
      bindingForKey.secretary_agenda_item_id,
      db,
    );
    const cancellationIsLocallyConfirmed = replayAgendaFamily.length > 0
      && !replayAgendaFamily.some((agenda) => isActiveAgendaLifecycle(agenda.lifecycleState));
    if (bindingForKey.state === 'cancelled'
      || (bindingForKey.state === 'cancel_pending' && cancellationIsLocallyConfirmed)) {
      db.transaction(() => {
        enqueueContentScheduleSignalReconciliation(db, scope, bindingForKey);
      }).immediate();
      return {
        value: mapScheduleView(
          bindingForKey,
          replayAgendaFamily,
          db,
          scope,
        ),
        replayed: true,
        changed: false,
      };
    }
  }

  const prepared = db.transaction(() => {
    const binding = bindingForKey ?? findLatestBinding(db, scope, itemId);
    if (!binding) {
      throw new ContentScheduleError('CONTENT_SCHEDULE_NOT_FOUND', 'No schedule exists for this content item.', 404);
    }
    if (binding.cancellation_idempotency_key) {
      if (binding.cancellation_idempotency_key !== idempotencyKey) {
        throw new ContentScheduleError(
          'CONTENT_SCHEDULE_CANCELLATION_IN_PROGRESS',
          'This schedule already has a cancellation request. Reload before retrying.',
          409,
          { recovery: 'reload_schedule' },
        );
      }
      assertMatchingHash(binding.cancellation_request_hash, requestHash, 'cancel content schedule');
    }
    if (binding.state === 'cancelled') return { kind: 'replay' as const, binding };
    if (binding.state === 'completed') {
      throw new ContentScheduleError(
        'CONTENT_SCHEDULE_ALREADY_COMPLETED',
        'This work block is already complete and cannot be cancelled.',
        409,
        { recovery: 'create_new_preview' },
      );
    }
    if (binding.state === 'stale') {
      throw new ContentScheduleError(
        'CONTENT_SCHEDULE_STALE',
        'This schedule is stale. Create a new preview if more time is needed.',
        409,
      );
    }
    const agendaFamily = readAgendaFamily(
      dependencies,
      scope,
      binding.secretary_source_intent_id,
      binding.secretary_agenda_item_id,
      db,
    );
    if (agendaFamily.length === 0) {
      throw new ContentScheduleError(
        'CONTENT_SCHEDULE_AUTHORITY_UNAVAILABLE',
        'Secretary could not verify the current work block. Reload before retrying cancellation.',
        503,
        { recovery: 'reload_schedule' },
      );
    }
    if (agendaFamily[0].lifecycleState === 'completed') {
      throw new ContentScheduleError(
        'CONTENT_SCHEDULE_ALREADY_COMPLETED',
        'This work block is already complete and cannot be cancelled.',
        409,
        { recovery: 'create_new_preview' },
      );
    }
    if (!['cancel_pending', 'cancel_failed'].includes(binding.state)) {
      db.prepare(`
        UPDATE content_schedule_bindings
           SET state = 'cancel_pending', cancellation_idempotency_key = ?,
               cancellation_request_hash = ?, last_error_code = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
      `).run(idempotencyKey, requestHash, now, binding.id, scope.tenantId, scope.userId);
    } else if (!binding.cancellation_idempotency_key) {
      db.prepare(`
        UPDATE content_schedule_bindings
           SET cancellation_idempotency_key = ?, cancellation_request_hash = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
      `).run(idempotencyKey, requestHash, now, binding.id, scope.tenantId, scope.userId);
    } else if (binding.state === 'cancel_failed') {
      db.prepare(`
        UPDATE content_schedule_bindings
           SET state = 'cancel_pending', last_error_code = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
      `).run(now, binding.id, scope.tenantId, scope.userId);
    }
    return { kind: 'cancel' as const, binding: findBindingById(db, scope, binding.id)! };
  }).immediate();

  if (prepared.kind === 'replay') {
    return {
      value: mapScheduleView(
        prepared.binding,
        readAgendaFamily(
          dependencies,
          scope,
          prepared.binding.secretary_source_intent_id,
          prepared.binding.secretary_agenda_item_id,
          db,
        ),
        db,
        scope,
      ),
      replayed: true,
      changed: false,
    };
  }

  const beforeCancellation = readAgendaFamily(
    dependencies,
    scope,
    prepared.binding.secretary_source_intent_id,
    prepared.binding.secretary_agenda_item_id,
    db,
  );
  try {
    for (const agenda of beforeCancellation.filter((candidate) => isActiveAgendaLifecycle(candidate.lifecycleState))) {
      dependencies.cancelAgenda({
        agendaItemId: agenda.agendaItemId,
        ownerUserId: scope.userId,
        tenantId: scope.tenantId,
        reason: 'User cancelled the Content work block.',
        now,
      });
    }
  } catch {
    markCancellationFailed(
      db,
      scope,
      prepared.binding.id,
      aggregateStoredProviderState(beforeCancellation, prepared.binding.provider_sync_state),
      now,
    );
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_CANCELLATION_FAILED',
      'Secretary could not confirm cancellation. The work block remains visible and can be retried safely.',
      503,
      { recovery: 'retry_cancellation' },
    );
  }
  const agendaFamily = readAgendaFamily(
    dependencies,
    scope,
    prepared.binding.secretary_source_intent_id,
    prepared.binding.secretary_agenda_item_id,
    db,
  );
  if (
    agendaFamily.length === 0
    || agendaFamily.some((agenda) => isActiveAgendaLifecycle(agenda.lifecycleState))
  ) {
    markCancellationFailed(
      db,
      scope,
      prepared.binding.id,
      aggregateStoredProviderState(agendaFamily, prepared.binding.provider_sync_state),
      now,
    );
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_CANCELLATION_FAILED',
      'Secretary did not confirm cancellation of every current work-block version. The schedule remains visible.',
      503,
      { recovery: 'retry_cancellation' },
    );
  }

  const finalBinding = db.transaction(() => {
    const binding = findBindingById(db, scope, prepared.binding.id);
    if (!binding) throw inconsistentScheduleState();
    const providerCleanupPending = hasProviderCleanupPending(agendaFamily);
    const providerCleanupFailed = agendaFamily.some((agenda) => agenda.providerSyncState === 'delete_failed');
    const nextState = providerCleanupPending
      ? providerCleanupFailed ? 'cancel_failed' : 'cancel_pending'
      : 'cancelled';
    const providerSyncState = providerCleanupPending
      ? aggregateStoredProviderState(agendaFamily, binding.provider_sync_state)
      : agendaFamily.some((agenda) => agenda.providerSyncState === 'deleted') ? 'deleted' : 'not_synced';
    db.prepare(`
      UPDATE content_schedule_bindings
         SET state = ?, provider_sync_state = ?, last_error_code = NULL,
             cancelled_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run(
      nextState,
      providerSyncState,
      nextState === 'cancelled' ? now : null,
      now,
      binding.id,
      scope.tenantId,
      scope.userId,
    );
    const updated = findBindingById(db, scope, binding.id);
    if (!updated) throw inconsistentScheduleState();
    enqueueContentScheduleSignalReconciliation(db, scope, updated);
    return updated;
  }).immediate();

  return {
    value: mapScheduleView(finalBinding, agendaFamily, db, scope),
    replayed: false,
    changed: true,
  };
}

function schedulePreviewStaleReason(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  preview: SchedulePreviewRow,
): string | null {
  const item = getContentWorkspaceItem(scope, preview.item_id, db);
  if (!item || item.itemType !== 'content_item') return 'CONTENT_SCHEDULE_ITEM_MISSING';
  if (!isWorkKindEligible(item.productionState, preview.work_kind)) return 'CONTENT_SCHEDULE_STATE_CHANGED';
  if (item.workflowVersion !== preview.base_workflow_version) return 'CONTENT_SCHEDULE_WORKFLOW_CHANGED';
  const artifact = getContentArtifact(scope, preview.artifact_id, db);
  if (!artifact || artifact.itemId !== item.id || !artifact.currentRevision) return 'CONTENT_SCHEDULE_ARTIFACT_CHANGED';
  if (
    artifact.currentRevision.id !== preview.revision_id
    || artifact.currentRevision.revisionNumber !== preview.base_revision_number
    || artifact.currentRevision.contentHash !== preview.base_content_hash
  ) return 'CONTENT_SCHEDULE_REVISION_CHANGED';
  return null;
}

function assertRevisionCanBeScheduled(
  scope: ContentWorkspaceScope,
  revisionId: number,
  db: Database.Database,
): void {
  const revision = getContentRevision(scope, revisionId, db);
  if (!revision) {
    throw new ContentScheduleError('CONTENT_SCHEDULE_REVISION_REQUIRED', 'The selected content version no longer exists.', 409);
  }
  const policy = getContentRevisionClaimPolicy(scope, revisionId, db);
  if (policy.status === 'not_recorded' && revision.actorType !== 'user') {
    throw new ContentScheduleError(
      'CONTENT_LINEAGE_REVIEW_REQUIRED',
      'Review sources and claims for AI-generated or imported content before scheduling.',
      409,
      { recovery: 'record_revision_lineage_or_save_user_revision' },
    );
  }
  if (policy.blocksApproval) {
    throw new ContentScheduleError(
      'CONTENT_CLAIM_SAFETY_BLOCKED',
      'Resolve unsupported sensitive claims before scheduling.',
      409,
      { reasonCodes: policy.blockCodes, recovery: 'review_sources_or_revise_claims' },
    );
  }
}

function findPreviewByCreateKey(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  idempotencyKey: string,
): SchedulePreviewRow | null {
  const row = db.prepare(`
    SELECT * FROM content_schedule_previews
     WHERE tenant_id = ? AND owner_user_id = ? AND create_idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, idempotencyKey) as SchedulePreviewRow | undefined;
  return row ?? null;
}

function findPreviewByKey(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  previewKey: string,
): SchedulePreviewRow | null {
  const row = db.prepare(`
    SELECT * FROM content_schedule_previews
     WHERE tenant_id = ? AND owner_user_id = ? AND preview_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, previewKey) as SchedulePreviewRow | undefined;
  return row ?? null;
}

function requirePreview(db: Database.Database, scope: ContentWorkspaceScope, previewKey: string): SchedulePreviewRow {
  const row = findPreviewByKey(db, scope, previewKey);
  if (!row) throw new ContentScheduleError('CONTENT_SCHEDULE_PREVIEW_NOT_FOUND', 'Schedule preview not found.', 404);
  return row;
}

function findBindingByPreview(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  previewId: number,
): ScheduleBindingRow | null {
  const row = db.prepare(`
    SELECT * FROM content_schedule_bindings
     WHERE tenant_id = ? AND owner_user_id = ? AND preview_id = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, previewId) as ScheduleBindingRow | undefined;
  return row ?? null;
}

function findBindingById(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  bindingId: number,
): ScheduleBindingRow | null {
  const row = db.prepare(`
    SELECT * FROM content_schedule_bindings
     WHERE tenant_id = ? AND owner_user_id = ? AND id = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, bindingId) as ScheduleBindingRow | undefined;
  return row ?? null;
}

function findBindingByCancellationKey(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  idempotencyKey: string,
): ScheduleBindingRow | null {
  const row = db.prepare(`
    SELECT * FROM content_schedule_bindings
     WHERE tenant_id = ? AND owner_user_id = ? AND cancellation_idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, idempotencyKey) as ScheduleBindingRow | undefined;
  return row ?? null;
}

function findLatestBinding(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  itemId: number,
): ScheduleBindingRow | null {
  const row = db.prepare(`
    SELECT * FROM content_schedule_bindings
     WHERE tenant_id = ? AND owner_user_id = ? AND item_id = ?
     ORDER BY CASE
       WHEN state IN ('scheduled', 'provider_synced', 'sync_failed', 'cancel_pending', 'cancel_failed') THEN 0
       ELSE 1
     END, id DESC
     LIMIT 1
  `).get(scope.tenantId, scope.userId, itemId) as ScheduleBindingRow | undefined;
  return row ?? null;
}

function mapPreviewView(row: SchedulePreviewRow): ContentSchedulePreviewView {
  const result = parseStoredPreviewResult(row.preview_result_json);
  const status: ContentSchedulePreviewView['status'] = row.status === 'previewed' ? 'ready' : row.status;
  return {
    schemaVersion: CONTENT_SCHEDULE_SCHEMA_VERSION,
    previewKey: row.preview_key,
    itemId: Number(row.item_id),
    status,
    workKind: row.work_kind,
    durationMinutes: Number(row.duration_minutes),
    visibleTitle: row.visible_title,
    titleDisclosure: row.title_disclosure,
    contextShared: parseStringArray(row.context_shared_json),
    choices: previewChoices(result).map((window, index) => ({
      start: window.start,
      end: window.end,
      recommended: index === 0,
    })),
    why: status === 'ready'
      ? 'Secretary found time within the availability you provided.'
      : status === 'unavailable'
        ? 'Secretary could not find a suitable slot within this availability.'
        : 'The scheduling request has an updated state.',
    exactEffect: 'Confirmation creates a Secretary agenda item for content work. It does not publish content.',
    expiresAt: row.expires_at,
    publicationExecution: 'not_performed',
  };
}

function mapScheduleView(
  row: ScheduleBindingRow,
  agendaFamily: SecretaryAgendaItem[],
  db: Database.Database,
  scope: ContentWorkspaceScope,
): ContentScheduleView {
  const artifact = getContentArtifact(scope, Number(row.artifact_id), db);
  const contentChanged = artifact?.currentRevision == null
    || artifact.currentRevision.id !== Number(row.revision_id)
    || artifact.currentRevision.revisionNumber !== Number(row.base_revision_number);
  const agenda = agendaFamily[0] ?? null;
  const authorityStatus: ContentScheduleView['authorityStatus'] = agenda ? 'current' : 'unavailable';
  const projectedProvider = providerProjection(row, agendaFamily);
  const currentIsActive = agenda != null && isActiveAgendaLifecycle(agenda.lifecycleState);
  const projectedState: ContentScheduleView['state'] = !agenda
    ? 'stale'
    : agenda.lifecycleState === 'completed'
      ? 'completed'
      : !currentIsActive && row.cancellation_idempotency_key != null
        ? hasProviderCleanupPending(agendaFamily)
          ? projectedProvider === 'deletion_failed' ? 'cancel_failed' : 'cancel_pending'
          : 'cancelled'
        : !currentIsActive
          ? 'stale'
          : row.state === 'cancel_pending' || row.state === 'cancel_failed'
            ? row.state
            : projectedProvider === 'failed'
              ? 'sync_failed'
              : projectedProvider === 'synced'
                ? 'provider_synced'
                : 'scheduled';
  const localAgendaState: ContentScheduleView['localAgendaState'] = projectedState === 'cancelled'
    ? 'cancelled'
    : projectedState === 'completed'
      ? 'completed'
    : projectedState === 'stale'
      ? 'stale'
      : projectedState === 'cancel_pending' || projectedState === 'cancel_failed'
        ? 'cancellation_pending'
        : 'scheduled';
  const nextAction: ContentScheduleView['nextAction'] = authorityStatus === 'unavailable'
    ? 'reload_schedule'
    : projectedState === 'cancel_pending'
      ? 'wait_for_provider_cleanup'
      : projectedState === 'cancel_failed' && !currentIsActive && projectedProvider === 'deletion_failed'
        ? 'wait_for_provider_cleanup'
        : projectedState === 'cancel_failed'
          ? 'retry_cancellation'
    : projectedState === 'sync_failed'
      ? 'wait_for_provider_sync'
      : projectedState === 'stale'
        ? 'create_new_preview'
        : 'none';
  return {
    schemaVersion: CONTENT_SCHEDULE_SCHEMA_VERSION,
    itemId: Number(row.item_id),
    state: projectedState,
    localAgendaState,
    providerSyncState: projectedProvider,
    authority: 'secretary',
    authorityStatus,
    scheduledStart: agenda?.startAt ?? row.scheduled_start_at,
    scheduledEnd: agenda?.endAt ?? row.scheduled_end_at,
    visibleTitle: row.visible_title,
    titleDisclosure: row.title_disclosure,
    contextShared: parseStringArray(row.context_shared_json),
    scheduledRevisionNumber: Number(row.base_revision_number),
    contentChangedSinceScheduling: contentChanged,
    publicationExecution: 'not_performed',
    recoverable: authorityStatus === 'unavailable'
      || ['sync_failed', 'cancel_pending', 'cancel_failed', 'stale'].includes(projectedState),
    nextAction,
  };
}

function providerProjection(
  row: ScheduleBindingRow,
  agendaFamily: SecretaryAgendaItem[],
): ContentScheduleView['providerSyncState'] {
  const agenda = agendaFamily[0] ?? null;
  const cancellationRequested = row.cancellation_idempotency_key != null;
  if (cancellationRequested && agendaFamily.some((candidate) => candidate.providerSyncState === 'delete_failed')) {
    return 'deletion_failed';
  }
  if (cancellationRequested && hasProviderCleanupPending(agendaFamily)) return 'deletion_pending';
  if (cancellationRequested && agendaFamily.some((candidate) => candidate.providerSyncState === 'deleted')) return 'removed';
  const state = agenda?.providerSyncState ?? row.provider_sync_state;
  if (state === 'synced') return 'synced';
  if (state === 'deleted') return 'removed';
  if (state === 'delete_failed') return 'deletion_failed';
  if (['create_failed', 'update_failed', 'readback_failed'].includes(state)) return 'failed';
  return 'pending';
}

function bindingStateFor(agenda: SecretaryAgendaItem): ScheduleBindingRow['state'] {
  if (agenda.providerSyncState === 'synced') return 'provider_synced';
  if (['create_failed', 'update_failed', 'readback_failed'].includes(agenda.providerSyncState)) return 'sync_failed';
  return 'scheduled';
}

function markPreviewFailed(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  previewId: number,
  errorCode: string,
  now: string,
): void {
  db.prepare(`
    UPDATE content_schedule_previews
       SET status = 'failed', last_error_code = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'submitting'
  `).run(errorCode, now, previewId, scope.tenantId, scope.userId);
}

function markPreviewRecoveryRequired(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  previewId: number,
  agendaItemId: string,
  now: string,
): void {
  db.prepare(`
    UPDATE content_schedule_previews
       SET status = 'failed', secretary_agenda_item_id = ?,
           last_error_code = 'CONTENT_SCHEDULE_RECOVERY_REQUIRED', updated_at = ?
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'submitting'
       AND (secretary_agenda_item_id IS NULL OR secretary_agenda_item_id = ?)
  `).run(agendaItemId, now, previewId, scope.tenantId, scope.userId, agendaItemId);
}

function markCancellationFailed(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  bindingId: number,
  providerSyncState: string,
  now: string,
): void {
  db.prepare(`
    UPDATE content_schedule_bindings
       SET state = 'cancel_failed', provider_sync_state = ?,
           last_error_code = 'CONTENT_SCHEDULE_CANCELLATION_FAILED', updated_at = ?
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND state = 'cancel_pending'
  `).run(providerSyncState, now, bindingId, scope.tenantId, scope.userId);
}

function readAgenda(
  dependencies: ContentScheduleDependencies,
  scope: ContentWorkspaceScope,
  agendaItemId: string,
): SecretaryAgendaItem | null {
  try {
    return dependencies.getAgenda({ agendaItemId, ownerUserId: scope.userId, tenantId: scope.tenantId });
  } catch {
    return null;
  }
}

function readAgendaFamily(
  dependencies: ContentScheduleDependencies,
  scope: ContentWorkspaceScope,
  sourceIntentId: string,
  fallbackAgendaItemId: string,
  db: Database.Database,
): SecretaryAgendaItem[] {
  let ids: string[] = [];
  try {
    ids = (db.prepare(`
      SELECT agenda_item_id
        FROM secretary_agenda_items
       WHERE owner_user_id = ? AND tenant_id = ?
         AND source_skill = 'content' AND source_intent_id = ?
       ORDER BY version DESC
    `).all(scope.userId, String(scope.tenantId), sourceIntentId) as Array<{ agenda_item_id: string }>)
      .map((row) => row.agenda_item_id);
  } catch {
    ids = [];
  }
  if (!ids.includes(fallbackAgendaItemId)) ids.push(fallbackAgendaItemId);
  return ids
    .map((agendaItemId) => readAgenda(dependencies, scope, agendaItemId))
    .filter((agenda): agenda is SecretaryAgendaItem => (
      agenda != null
      && agenda.ownerUserId === scope.userId
      && String(agenda.tenantId) === String(scope.tenantId)
      && agenda.sourceIntentId === sourceIntentId
      && agenda.sourceSkill === 'content'
    ))
    .sort((left, right) => right.version - left.version);
}

function safeCancelAgendaFamily(
  dependencies: ContentScheduleDependencies,
  scope: ContentWorkspaceScope,
  sourceIntentId: string,
  fallbackAgendaItemId: string,
  now: string,
  db: Database.Database,
): boolean {
  const before = readAgendaFamily(dependencies, scope, sourceIntentId, fallbackAgendaItemId, db);
  if (before.length === 0) return true;
  try {
    for (const agenda of before.filter((candidate) => isActiveAgendaLifecycle(candidate.lifecycleState))) {
      dependencies.cancelAgenda({
        agendaItemId: agenda.agendaItemId,
        ownerUserId: scope.userId,
        tenantId: scope.tenantId,
        reason: 'Content schedule confirmation did not complete.',
        now,
      });
    }
  } catch {
    return false;
  }
  const after = readAgendaFamily(dependencies, scope, sourceIntentId, fallbackAgendaItemId, db);
  return after.length > 0 && !after.some((agenda) => isActiveAgendaLifecycle(agenda.lifecycleState));
}

function enqueueContentScheduleSignalReconciliation(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  binding: ScheduleBindingRow,
): void {
  if (!['cancel_pending', 'cancel_failed', 'cancelled'].includes(binding.state)) return;
  const cancellationFingerprint = binding.cancellation_request_hash
    ?? hashPayload({ bindingId: binding.id, itemId: binding.item_id, state: 'cancelled' });
  try {
    emitDomainEvent({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sourceSkill: 'content',
      eventType: CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_EVENT,
      entityType: 'content_schedule_binding',
      entityId: binding.id,
      schemaVersion: 'content.schedule-signal-reconciliation.v1',
      payload: { itemId: binding.item_id },
      privacyClassification: 'private_content',
      idempotencyKey: `content.schedule_signal_reconciliation:${binding.id}:${cancellationFingerprint}`,
    }, db);
  } catch (error) {
    logger.error(
      { ...safeContentLogErrorFields(error), bindingId: binding.id },
      'Content schedule signal reconciliation enqueue failed',
    );
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_QUEUE_UNAVAILABLE',
      'The work-block cancellation could not queue its derived-signal reconciliation. Retry cancellation safely.',
      503,
      {
        recovery: 'retry_cancellation',
        secretaryCancellationMayBeCommitted: true,
        publicationExecution: 'not_performed',
      },
    );
  }
}

function reconcileContentScheduleBinding(
  db: Database.Database,
  dependencies: ContentScheduleDependencies,
  scope: ContentWorkspaceScope,
  itemId: number,
  now: string,
): void {
  const binding = findLatestBinding(db, scope, itemId);
  if (!binding || ['cancelled', 'completed', 'stale'].includes(binding.state)) return;
  const agendaFamily = readAgendaFamily(
    dependencies,
    scope,
    binding.secretary_source_intent_id,
    binding.secretary_agenda_item_id,
    db,
  );
  const current = agendaFamily[0] ?? null;
  if (!current) return;

  let nextState = binding.state;
  let providerSyncState = current.providerSyncState;
  let lastErrorCode: string | null = binding.last_error_code;
  let cancelledAt = binding.cancelled_at;

  if (current.lifecycleState === 'completed') {
    if (['scheduled', 'provider_synced', 'sync_failed'].includes(binding.state)) {
      nextState = 'completed';
      lastErrorCode = null;
    }
  } else if (!isActiveAgendaLifecycle(current.lifecycleState)) {
    if (binding.cancellation_idempotency_key) {
      providerSyncState = aggregateStoredProviderState(agendaFamily, binding.provider_sync_state);
      if (hasProviderCleanupPending(agendaFamily)) {
        nextState = agendaFamily.some((agenda) => agenda.providerSyncState === 'delete_failed')
          ? 'cancel_failed'
          : 'cancel_pending';
      } else {
        nextState = 'cancelled';
        providerSyncState = agendaFamily.some((agenda) => agenda.providerSyncState === 'deleted')
          ? 'deleted'
          : 'not_synced';
        cancelledAt = cancelledAt ?? now;
        lastErrorCode = null;
      }
    } else if (['scheduled', 'provider_synced', 'sync_failed'].includes(binding.state)) {
      nextState = 'stale';
      lastErrorCode = 'CONTENT_SECRETARY_AGENDA_TERMINAL';
    }
  } else if (['scheduled', 'provider_synced', 'sync_failed'].includes(binding.state)) {
    const projected = bindingStateFor(current);
    const legalForwardProjection = binding.state === 'scheduled'
      || (binding.state === 'provider_synced' && projected === 'sync_failed')
      || (binding.state === 'sync_failed' && projected === 'provider_synced');
    if (legalForwardProjection) nextState = projected;
    lastErrorCode = projected === 'sync_failed' ? 'CONTENT_SCHEDULE_PROVIDER_SYNC_FAILED' : null;
  }

  if (
    nextState === binding.state
    && providerSyncState === binding.provider_sync_state
    && lastErrorCode === binding.last_error_code
    && cancelledAt === binding.cancelled_at
  ) return;

  db.transaction(() => {
    db.prepare(`
      UPDATE content_schedule_bindings
         SET state = ?, provider_sync_state = ?, last_error_code = ?,
             cancelled_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run(
      nextState,
      providerSyncState,
      lastErrorCode,
      cancelledAt,
      now,
      binding.id,
      scope.tenantId,
      scope.userId,
    );
    const updated = findBindingById(db, scope, binding.id);
    if (!updated) throw inconsistentScheduleState();
    if (!isActiveAgendaLifecycle(current.lifecycleState)) {
      enqueueContentScheduleSignalReconciliation(db, scope, updated);
    }
  }).immediate();
}

function assertNoUnresolvedContentSchedule(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  itemId: number,
): void {
  const binding = db.prepare(`
    SELECT state
      FROM content_schedule_bindings
     WHERE tenant_id = ? AND owner_user_id = ? AND item_id = ?
       AND state IN ('scheduled', 'provider_synced', 'sync_failed', 'cancel_pending', 'cancel_failed')
     ORDER BY id DESC
     LIMIT 1
  `).get(scope.tenantId, scope.userId, itemId) as { state: ScheduleBindingRow['state'] } | undefined;
  if (!binding) return;
  if (binding.state === 'cancel_pending' || binding.state === 'cancel_failed') {
    throw new ContentScheduleError(
      'CONTENT_SCHEDULE_CLEANUP_PENDING',
      'The previous work block is still being removed. Wait for cleanup before scheduling another block.',
      409,
      { recovery: binding.state === 'cancel_failed' ? 'retry_cancellation' : 'reload_schedule' },
    );
  }
  throw new ContentScheduleError(
    'CONTENT_SCHEDULE_ALREADY_EXISTS',
    'This content already has an active work block. Cancel or complete it before scheduling another.',
    409,
    { recovery: 'reload_schedule' },
  );
}

function hasProviderCleanupPending(agendaFamily: SecretaryAgendaItem[]): boolean {
  return agendaFamily.some((agenda) => (
    agenda.providerEventId != null && agenda.providerSyncState !== 'deleted'
  ));
}

function aggregateStoredProviderState(
  agendaFamily: SecretaryAgendaItem[],
  fallback: SecretaryAgendaItem['providerSyncState'],
): SecretaryAgendaItem['providerSyncState'] {
  if (agendaFamily.some((agenda) => agenda.providerSyncState === 'delete_failed')) return 'delete_failed';
  if (agendaFamily.some((agenda) => agenda.providerSyncState === 'synced')) return 'synced';
  if (agendaFamily.some((agenda) => agenda.providerSyncState === 'readback_failed')) return 'readback_failed';
  if (agendaFamily.some((agenda) => agenda.providerSyncState === 'update_failed')) return 'update_failed';
  if (agendaFamily.some((agenda) => agenda.providerSyncState === 'create_failed')) return 'create_failed';
  if (agendaFamily.some((agenda) => agenda.providerSyncState === 'deleted')) return 'deleted';
  if (agendaFamily.some((agenda) => agenda.providerSyncState === 'not_synced')) return 'not_synced';
  return fallback;
}

function isActiveAgendaLifecycle(lifecycleState: SecretaryAgendaItem['lifecycleState']): boolean {
  return ['scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync'].includes(lifecycleState);
}

function requiresReleaseReadiness(workKind: ContentScheduleWorkKind): boolean {
  return workKind === 'record' || workKind === 'publish_prep';
}

function isWorkKindEligible(
  productionState: ContentProductionState,
  workKind: ContentScheduleWorkKind,
): boolean {
  if (requiresReleaseReadiness(workKind)) return productionState === 'approved';
  return ['inbox', 'active', 'review', 'approved'].includes(productionState);
}

function assertWorkKindEligible(
  productionState: ContentProductionState,
  workKind: ContentScheduleWorkKind,
): void {
  if (isWorkKindEligible(productionState, workKind)) return;
  const releaseReady = requiresReleaseReadiness(workKind);
  throw new ContentScheduleError(
    releaseReady ? 'CONTENT_SCHEDULE_REQUIRES_APPROVAL' : 'CONTENT_SCHEDULE_STATE_UNAVAILABLE',
    releaseReady
      ? 'Approve and review the saved version before scheduling recording or publication preparation.'
      : 'Move this content into an active development state before scheduling work.',
    409,
    {
      currentState: productionState,
      recovery: releaseReady ? 'review_and_approve' : 'restore_or_activate_content',
    },
  );
}

function parseStoredIntent(value: string): SecretarySchedulingIntent {
  const parsed = parseRecord(value, 'CONTENT_SCHEDULE_INTENT_INVALID');
  if (
    typeof parsed.intentId !== 'string'
    || parsed.sourceSkill !== 'content'
    || typeof parsed.ownerUserId !== 'number'
    || (typeof parsed.tenantId !== 'number' && typeof parsed.tenantId !== 'string')
    || typeof parsed.title !== 'string'
  ) throw inconsistentScheduleState();
  return parsed as unknown as SecretarySchedulingIntent;
}

function parseStoredPreviewResult(value: string): StoredPreviewResult {
  const parsed = parseRecord(value, 'CONTENT_SCHEDULE_PREVIEW_INVALID');
  const recommendedSlot = sanitizeWindow(parsed.recommendedSlot);
  const alternatives = Array.isArray(parsed.alternatives)
    ? parsed.alternatives.map(sanitizeWindow).filter(isWindow)
    : [];
  if (
    typeof parsed.status !== 'string'
    || !['low', 'medium', 'high'].includes(String(parsed.confidence))
    || !Array.isArray(parsed.reasonCodes)
    || !parsed.reasonCodes.every((code) => typeof code === 'string')
  ) throw inconsistentScheduleState();
  return {
    status: parsed.status as StoredPreviewResult['status'],
    recommendedSlot,
    alternatives,
    reasonCodes: parsed.reasonCodes as string[],
    confidence: parsed.confidence as StoredPreviewResult['confidence'],
  };
}

function previewChoices(result: StoredPreviewResult): SecretaryTimeWindow[] {
  const choices = [result.recommendedSlot, ...result.alternatives].filter(isWindow);
  return choices.filter((choice, index) => choices.findIndex((candidate) => windowsEqual(candidate, choice)) === index);
}

function stalePreviewError(reason: string): ContentScheduleError {
  return new ContentScheduleError(
    'CONTENT_SCHEDULE_PREVIEW_STALE',
    'The content changed after this preview. Your edits were preserved; create a new scheduling preview.',
    409,
    { reason, recovery: 'create_new_preview', publicationExecution: 'not_performed' },
  );
}

function inconsistentScheduleState(): ContentScheduleError {
  return new ContentScheduleError(
    'CONTENT_SCHEDULE_INTEGRITY_FAILED',
    'The saved scheduling state is inconsistent. No additional change was made.',
    500,
  );
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  return {
    tenantId: positiveInteger(scope?.tenantId, 'tenantId'),
    userId: positiveInteger(scope?.userId, 'userId'),
  };
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 200) {
    throw new ContentScheduleError('CONTENT_IDEMPOTENCY_KEY_REQUIRED', 'Provide an idempotency key between 8 and 200 characters.', 400);
  }
  const normalized = value.trim();
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new ContentScheduleError(
      'CONTENT_VALIDATION_FAILED',
      'The idempotency key contains unsupported control characters.',
      400,
      { field: 'idempotencyKey' },
    );
  }
  return normalized;
}

function normalizeOpaqueKey(value: unknown, field: string, prefix: string): string {
  if (typeof value !== 'string'
    || !value.startsWith(prefix)
    || value.length > 200
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field} is invalid.`, 400, { field });
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field} must be a positive integer.`, 400, { field });
  }
  return Number(value);
}

function integerInRange(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ContentScheduleError(
      'CONTENT_VALIDATION_FAILED',
      `${field} must be an integer from ${minimum} to ${maximum}.`,
      400,
      { field },
    );
  }
  return Number(value);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field} is invalid.`, 400, { field });
  }
  return value as T;
}

function normalizeWindows(value: unknown, field: string): SecretaryTimeWindow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field} must contain 1 to 10 time windows.`, 400, { field });
  }
  return value.map((window, index) => normalizeWindow(window, `${field}[${index}]`));
}

function normalizeWindow(value: unknown, field: string): SecretaryTimeWindow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field} must be a time window.`, 400, { field });
  }
  const record = value as Record<string, unknown>;
  if (record.hard !== undefined && typeof record.hard !== 'boolean') {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field}.hard must be a boolean.`, 400, {
      field: `${field}.hard`,
    });
  }
  const start = requiredIso(record.start, `${field}.start`);
  const end = requiredIso(record.end, `${field}.end`);
  if (Date.parse(end) <= Date.parse(start)) {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field} must end after it starts.`, 400, { field });
  }
  return { start, end, hard: record.hard === true };
}

function sanitizeWindow(value: unknown): SecretaryTimeWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  try {
    const start = requiredCalendarIso(record.start, 'secretaryPreview.start');
    const end = requiredCalendarIso(record.end, 'secretaryPreview.end');
    if (Date.parse(end) <= Date.parse(start)) return null;
    return { start, end };
  } catch {
    return null;
  }
}

function isWindow(value: SecretaryTimeWindow | null): value is SecretaryTimeWindow {
  return value != null;
}

function windowsEqual(left: SecretaryTimeWindow, right: SecretaryTimeWindow): boolean {
  return left.start === right.start && left.end === right.end;
}

function minutesBetween(window: SecretaryTimeWindow): number {
  return Math.round((Date.parse(window.end) - Date.parse(window.start)) / 60_000);
}

function requiredIso(value: unknown, field: string): string {
  return requiredCalendarIso(value, field);
}

function requiredCalendarIso(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match) {
    throw new ContentScheduleError(
      'CONTENT_VALIDATION_FAILED',
      `${field} must be an ISO date-time with a timezone.`,
      400,
      { field },
    );
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneOffset = zone === 'Z' ? null : zone.slice(1).split(':').map(Number);
  const maximumDay = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    day < 1
    || day > maximumDay
    || hour > 23
    || minute > 59
    || second > 59
    || (zoneOffset != null && (zoneOffset[0] > 23 || zoneOffset[1] > 59))
    || !Number.isFinite(Date.parse(raw))
  ) {
    throw new ContentScheduleError(
      'CONTENT_VALIDATION_FAILED',
      `${field} must be a valid ISO date-time.`,
      400,
      { field },
    );
  }
  return new Date(raw).toISOString();
}

function optionalIso(value: unknown, field: string): string | null {
  if (value == null) return null;
  return requiredIso(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ContentScheduleError('CONTENT_VALIDATION_FAILED', `${field} must be a boolean.`, 400, { field });
  }
  return value;
}

function normalizeNow(value: unknown): string {
  return value == null ? new Date().toISOString() : requiredIso(value, 'now');
}

function genericScheduleTitle(workKind: ContentScheduleWorkKind): string {
  const labels: Record<ContentScheduleWorkKind, string> = {
    write: 'Write',
    revise: 'Revise',
    record: 'Record',
    edit: 'Edit',
    review: 'Review',
    publish_prep: 'Prepare',
  };
  return `Content work: ${labels[workKind]}`;
}

function calendarSafeTitle(value: string): string {
  const characters = Array.from(value.trim());
  if (characters.length <= 200) return characters.join('');
  return `${characters.slice(0, 199).join('')}…`;
}

function hashPayload(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function parseRecord(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ContentScheduleError(code, 'Saved scheduling data is invalid.', 500);
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function assertMatchingHash(actual: string | null, expected: string, operation: string): void {
  if (actual !== expected) {
    throw new ContentScheduleError(
      'CONTENT_IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different request.',
      409,
      { operation },
    );
  }
}

function isAcceptedSecretaryStatus(status: string): boolean {
  return ['scheduled', 'reflowed', 'compressed'].includes(status);
}
