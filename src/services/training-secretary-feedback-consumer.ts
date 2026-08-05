// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training consumer for Secretary scheduling feedback (W-B).
 *
 * Secretary emits after every persisted scheduling decision. Training stores a
 * compact, tenant-scoped hint so the next plan/coach pass can account for
 * compressed sessions, reflows, and unscheduled work without re-parsing
 * Secretary agenda rows.
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { registerSecretaryFeedbackConsumer } from './secretary-feedback-bus';
import type {
  SecretarySchedulingDecisionStatus,
  SecretarySourceSkillFeedback,
} from './secretary-scheduling-arbitrator';
import type { EventOutboxRecord } from './event-outbox';
import { filterKnownReasonCodes } from './secretary-reason-codes';
import { logger } from '../utils/logger';

const HANDLER_ID = 'training-feedback-decisions';
const MAX_CURRENT_PLAN_FEEDBACK_DECISIONS = 128;
export const TRAINING_SECRETARY_FEEDBACK_EVENT_TYPE = 'secretary.training_feedback.requested.v1';
export const TRAINING_SECRETARY_FEEDBACK_SCHEMA_VERSION = 'secretary-training-feedback-v1';

const FEEDBACK_STATUSES = new Set<SecretarySchedulingDecisionStatus>([
  'scheduled',
  'reflowed',
  'compressed',
  'deferred',
  'unscheduled',
  'rejected',
  'needs_more_context',
]);

export interface TrainingSecretaryFeedbackDecision {
  id: number;
  userId: number;
  tenantId: string;
  agendaItemId: string;
  sourceIntentId: string;
  agendaVersion: number;
  feedbackType: string;
  status: string;
  reasonCodes: string[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  shouldRefreshSource: boolean;
  downstreamImplications: string[];
  hints: string[];
  createdAt: string;
  updatedAt: string;
}

let registered = false;

export function registerTrainingSecretaryFeedbackConsumer(): void {
  if (registered) return;
  registerSecretaryFeedbackConsumer({
    sourceSkill: 'training',
    handlerId: HANDLER_ID,
    handler: recordTrainingSecretaryFeedback,
  });
  registered = true;
}

export function _resetTrainingSecretaryFeedbackConsumerForTests(): void {
  registered = false;
}

export function recordTrainingSecretaryFeedback(
  feedback: SecretarySourceSkillFeedback,
  db: Database.Database = getDb(),
): void {
  if (feedback.sourceSkill !== 'training') return;
  const tenantId = String(feedback.tenantId ?? '').trim();
  if (!Number.isSafeInteger(feedback.ownerUserId) || feedback.ownerUserId <= 0 || tenantId.length === 0) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_INVALID_SCOPE');
  }
  if (!Number.isSafeInteger(feedback.agendaVersion) || feedback.agendaVersion <= 0) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_INVALID_AGENDA_VERSION');
  }
  assertTrainingFeedbackDecisionsSchemaReady(db);
  const now = new Date().toISOString();
  const hints = hintsForTrainingFeedback(feedback);
  db.prepare(`
    INSERT INTO training_feedback_decisions (
      user_id, tenant_id, source_skill, agenda_item_id, source_intent_id,
      agenda_version, feedback_type, status, reason_codes_json, scheduled_start, scheduled_end,
      should_refresh_source, downstream_implications_json, hints_json, created_at, updated_at
    ) VALUES (?, ?, 'secretary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tenant_id, source_intent_id)
    DO UPDATE SET
      agenda_item_id = excluded.agenda_item_id,
      agenda_version = excluded.agenda_version,
      feedback_type = excluded.feedback_type,
      status = excluded.status,
      reason_codes_json = excluded.reason_codes_json,
      scheduled_start = excluded.scheduled_start,
      scheduled_end = excluded.scheduled_end,
      should_refresh_source = excluded.should_refresh_source,
      downstream_implications_json = excluded.downstream_implications_json,
      hints_json = excluded.hints_json,
      updated_at = excluded.updated_at
    WHERE excluded.agenda_version > training_feedback_decisions.agenda_version
  `).run(
    feedback.ownerUserId,
    tenantId,
    feedback.agendaItemId,
    feedback.sourceIntentId,
    feedback.agendaVersion,
    feedbackTypeForTrainingFeedback(feedback),
    feedback.status,
    JSON.stringify(feedback.reasonCodes),
    feedback.scheduledStart,
    feedback.scheduledEnd,
    feedback.shouldRefreshSource ? 1 : 0,
    JSON.stringify(feedback.downstreamImplications),
    JSON.stringify(hints),
    now,
    now,
  );
}

/**
 * Durable event-outbox consumer used by the single default `'*'` router.
 *
 * The outbox's tenant partition is numeric by contract, while Secretary keeps
 * a legacy-compatible string-or-number tenant type. The producer therefore
 * partitions by the positive owner id and carries the exact normalized
 * Secretary tenant in the privacy-bounded payload. This consumer re-reads the
 * agenda row using all four boundaries (agenda id, owner, exact tenant, and
 * version) before projecting anything; converting the tenant to a number here
 * would weaken isolation for non-numeric legacy scopes.
 */
export function consumeTrainingSecretaryFeedbackEvent(
  event: EventOutboxRecord,
  db: Database.Database,
): void {
  if (event.eventType !== TRAINING_SECRETARY_FEEDBACK_EVENT_TYPE
      || event.sourceSkill !== 'secretary'
      || event.entityType !== 'secretary_agenda_item'
      || event.schemaVersion !== TRAINING_SECRETARY_FEEDBACK_SCHEMA_VERSION) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_CONTRACT_MISMATCH');
  }
  if (!Number.isSafeInteger(event.userId) || (event.userId ?? 0) <= 0 || event.tenantId !== event.userId) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_SCOPE_MISMATCH');
  }
  const agendaTenantId = event.payload?.agendaTenantId;
  if (typeof agendaTenantId !== 'string' || agendaTenantId.length === 0 || agendaTenantId.trim() !== agendaTenantId) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_SCOPE_MISMATCH');
  }
  if (!Number.isSafeInteger(event.entityVersion) || event.entityVersion <= 0) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_VERSION_MISMATCH');
  }

  const row = db.prepare(`
    SELECT agenda_item_id, source_intent_id, owner_user_id, tenant_id, version,
           decision_action, decision_reason_codes_json, start_at, end_at
    FROM secretary_agenda_items
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
      AND source_skill = 'training'
      AND version = ?
  `).get(event.entityId, event.userId, agendaTenantId, event.entityVersion) as {
    agenda_item_id: string;
    source_intent_id: string;
    owner_user_id: number;
    tenant_id: string;
    version: number;
    decision_action: string;
    decision_reason_codes_json: string;
    start_at: string | null;
    end_at: string | null;
  } | undefined;
  if (!row) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_SCOPE_MISMATCH');
  }

  const status = parseFeedbackStatus(row.decision_action);
  const reasonCodes = parsePersistedReasonCodes(row.decision_reason_codes_json);
  const downstreamImplications = downstreamImplicationsForTraining(status);
  recordTrainingSecretaryFeedback({
    sourceSkill: 'training',
    sourceIntentId: row.source_intent_id,
    agendaItemId: row.agenda_item_id,
    ownerUserId: row.owner_user_id,
    tenantId: row.tenant_id,
    agendaVersion: row.version,
    status,
    reasonCodes,
    scheduledStart: row.start_at,
    scheduledEnd: row.end_at,
    shouldRefreshSource: shouldRefreshTrainingSource(status),
    downstreamImplications,
  }, db);
}

export function listTrainingSecretaryFeedbackDecisions(scope: {
  userId: number;
  tenantId: string | number;
}): TrainingSecretaryFeedbackDecision[] {
  const db = getDb();
  assertTrainingFeedbackDecisionsSchemaReady(db);
  const rows = db.prepare(`
    SELECT *
    FROM training_feedback_decisions
    WHERE user_id = ? AND tenant_id = ?
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all(scope.userId, String(scope.tenantId));
  return rows.map(rowToTrainingFeedbackDecision);
}

export interface TrainingSecretaryFeedbackPlanScope {
  userId: number;
  tenantId: string | number;
  planId: number;
  planVersion: number;
}

/**
 * Read a bounded set of current per-session Secretary projections for one
 * exact active Training plan version.
 *
 * One row is retained per source intent by migration 276. Attention states are
 * deliberately ordered before routine confirmations so a later scheduled
 * session cannot hide another session that is still compressed, deferred,
 * unscheduled, or missing context. `agenda_version` never participates in this
 * cross-intent ordering: it is monotonic only within one source intent. The
 * final id tie-break is deterministic, while downstream aggregation unions the
 * allowlisted consequences instead of treating that id as a plan-wide clock.
 */
export function listCurrentTrainingSecretaryFeedbackDecisionsForPlan(
  scope: TrainingSecretaryFeedbackPlanScope,
): TrainingSecretaryFeedbackDecision[] {
  const tenantId = String(scope.tenantId).trim();
  if (!Number.isSafeInteger(scope.userId) || scope.userId <= 0
      || !Number.isSafeInteger(scope.planId) || scope.planId <= 0
      || !Number.isSafeInteger(scope.planVersion) || scope.planVersion <= 0
      || tenantId.length === 0) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_INVALID_PLAN_SCOPE');
  }

  const db = getDb();
  assertTrainingFeedbackDecisionsSchemaReady(db);
  const sourceIntentPrefix = `training:${scope.planId}:${scope.planVersion}:`;
  const rows = db.prepare(`
    SELECT *
    FROM training_feedback_decisions
    WHERE user_id = ?
      AND tenant_id = ?
      AND source_skill = 'secretary'
      AND substr(source_intent_id, 1, length(?)) = ?
    ORDER BY CASE status
               WHEN 'unscheduled' THEN 0
               WHEN 'needs_more_context' THEN 1
               WHEN 'deferred' THEN 2
               WHEN 'compressed' THEN 3
               WHEN 'reflowed' THEN 4
               WHEN 'scheduled' THEN 5
               WHEN 'rejected' THEN 6
               ELSE 7
             END ASC,
             COALESCE(julianday(updated_at), 0) DESC,
             id DESC
    LIMIT ?
  `).all(
    scope.userId,
    tenantId,
    sourceIntentPrefix,
    sourceIntentPrefix,
    MAX_CURRENT_PLAN_FEEDBACK_DECISIONS,
  );
  return rows.map(rowToTrainingFeedbackDecision);
}

/**
 * Compatibility representative for callers that still expect one row.
 * This is attention-first current state, not a plan-wide agenda-version read.
 */
export function getLatestTrainingSecretaryFeedbackDecisionForPlan(
  scope: TrainingSecretaryFeedbackPlanScope,
): TrainingSecretaryFeedbackDecision | null {
  return listCurrentTrainingSecretaryFeedbackDecisionsForPlan(scope)[0] ?? null;
}

function assertTrainingFeedbackDecisionsSchemaReady(db: Database.Database): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'training_feedback_decisions'").get();
  if (!table) {
    throw new Error('TRAINING_FEEDBACK_DECISIONS_SCHEMA_MISSING:training_feedback_decisions');
  }
  const columns = db.prepare('PRAGMA table_info(training_feedback_decisions)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const missing = [
    'user_id',
    'tenant_id',
    'source_skill',
    'agenda_item_id',
    'source_intent_id',
    'agenda_version',
    'feedback_type',
    'status',
    'reason_codes_json',
    'scheduled_start',
    'scheduled_end',
    'should_refresh_source',
    'downstream_implications_json',
    'hints_json',
  ].filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(`TRAINING_FEEDBACK_DECISIONS_SCHEMA_MISSING:${missing.join(',')}`);
  }
}

function feedbackTypeForTrainingFeedback(feedback: SecretarySourceSkillFeedback): string {
  if (feedback.status === 'compressed') return 'compressed_session';
  if (feedback.status === 'reflowed') return 'reflowed_session';
  if (feedback.status === 'unscheduled' || feedback.status === 'deferred') return 'schedule_attention';
  if (feedback.status === 'needs_more_context') return 'needs_context';
  return 'schedule_confirmed';
}

function hintsForTrainingFeedback(feedback: SecretarySourceSkillFeedback): string[] {
  const hints = new Set<string>();
  if (feedback.status === 'compressed') hints.add('recovery_debt');
  if (feedback.status === 'reflowed') hints.add('refresh_user_facing_time_copy');
  if (feedback.shouldRefreshSource) hints.add('refresh_training_plan_context');
  for (const implication of feedback.downstreamImplications) {
    if (/shorter|compressed|adapt/i.test(implication)) hints.add('adapt_workload_to_capacity');
  }
  return [...hints];
}

function parseFeedbackStatus(value: string): SecretarySchedulingDecisionStatus {
  if (!FEEDBACK_STATUSES.has(value as SecretarySchedulingDecisionStatus)) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_STATUS_INVALID');
  }
  return value as SecretarySchedulingDecisionStatus;
}

function parsePersistedReasonCodes(raw: string): ReturnType<typeof filterKnownReasonCodes> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_REASON_CODES_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_REASON_CODES_INVALID');
  }
  const reasonCodes = filterKnownReasonCodes(parsed);
  if (reasonCodes.length !== parsed.length) {
    throw new Error('TRAINING_SECRETARY_FEEDBACK_EVENT_REASON_CODES_INVALID');
  }
  return reasonCodes;
}

function shouldRefreshTrainingSource(status: SecretarySchedulingDecisionStatus): boolean {
  return ['reflowed', 'compressed', 'deferred', 'unscheduled', 'needs_more_context'].includes(status);
}

function downstreamImplicationsForTraining(status: SecretarySchedulingDecisionStatus): string[] {
  if (status === 'unscheduled') return ['training should treat this as not placed on the agenda.'];
  if (status === 'deferred') return ['training should refresh the intent before the deadline window closes.'];
  if (status === 'compressed') return ['training should adapt the workload to the shorter scheduled block.'];
  if (status === 'reflowed') return ['training should refresh any user-facing time copy for this item.'];
  if (status === 'needs_more_context') {
    return ['training should provide the missing scheduling context or ask the user a targeted question.'];
  }
  return [];
}

function rowToTrainingFeedbackDecision(row: any): TrainingSecretaryFeedbackDecision {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tenantId: String(row.tenant_id),
    agendaItemId: String(row.agenda_item_id),
    sourceIntentId: String(row.source_intent_id),
    agendaVersion: Number(row.agenda_version),
    feedbackType: String(row.feedback_type),
    status: String(row.status),
    reasonCodes: safeJsonArray(row.reason_codes_json),
    scheduledStart: row.scheduled_start ?? null,
    scheduledEnd: row.scheduled_end ?? null,
    shouldRefreshSource: Number(row.should_refresh_source) === 1,
    downstreamImplications: safeJsonArray(row.downstream_implications_json),
    hints: safeJsonArray(row.hints_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function safeJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (err) {
    logger.warn({ err }, '[training-secretary-feedback] failed to parse JSON array');
    return [];
  }
}

registerTrainingSecretaryFeedbackConsumer();
