// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave 2 Secretary feedback consumers for Cooking, Finance, and Content.
 *
 * Training has a dedicated consumer because its coach/planning loop already
 * has a specialized feedback table. The other skills share this compact,
 * tenant-scoped sink until each skill promotes a richer planner-specific
 * consumer. This keeps the feedback bus useful across all source skills
 * without inventing a second scheduling system.
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { registerSecretaryFeedbackConsumer } from './secretary-feedback-bus';
import type {
  SecretarySchedulingDecisionStatus,
  SecretarySourceSkill,
  SecretarySourceSkillFeedback,
} from './secretary-scheduling-arbitrator';
import type { EventOutboxRecord } from './event-outbox';
import { filterKnownReasonCodes } from './secretary-reason-codes';
import { logger } from '../utils/logger';

const SOURCE_SKILLS = ['cooking', 'finance', 'content'] as const;
type SecretaryConsumerSourceSkill = typeof SOURCE_SKILLS[number];
export const SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE = 'secretary.source_feedback.requested.v1';
export const SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION = 'secretary-source-feedback-v1';
export const SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_VERSION = 1;

const FEEDBACK_STATUSES = new Set<SecretarySchedulingDecisionStatus>([
  'scheduled',
  'reflowed',
  'compressed',
  'deferred',
  'unscheduled',
  'rejected',
  'needs_more_context',
]);

export interface SecretarySourceSkillFeedbackRecord {
  id: number;
  userId: number;
  tenantId: string;
  targetSkill: SecretaryConsumerSourceSkill;
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

export function registerSecretarySourceSkillFeedbackConsumers(): void {
  if (registered) return;
  for (const sourceSkill of SOURCE_SKILLS) {
    registerSecretaryFeedbackConsumer({
      sourceSkill,
      handlerId: `${sourceSkill}-source-feedback-decisions`,
      handler: recordSecretarySourceSkillFeedback,
    });
  }
  registered = true;
}

export function _resetSecretarySourceSkillFeedbackConsumersForTests(): void {
  registered = false;
}

export function recordSecretarySourceSkillFeedback(
  feedback: SecretarySourceSkillFeedback,
  db: Database.Database = getDb(),
): void {
  if (!isConsumerSourceSkill(feedback.sourceSkill)) return;
  const tenantId = String(feedback.tenantId ?? '').trim();
  if (!Number.isSafeInteger(feedback.ownerUserId) || feedback.ownerUserId <= 0 || tenantId.length === 0) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_INVALID_SCOPE');
  }
  if (!Number.isSafeInteger(feedback.agendaVersion) || feedback.agendaVersion <= 0) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_INVALID_AGENDA_VERSION');
  }
  assertSecretarySourceSkillFeedbackSchemaReady(db);
  const now = new Date().toISOString();
  const hints = hintsForSourceFeedback(feedback);
  db.prepare(`
    INSERT INTO secretary_source_skill_feedback (
      user_id, tenant_id, target_skill, agenda_item_id, source_intent_id,
      agenda_version, feedback_type, status, reason_codes_json, scheduled_start, scheduled_end,
      should_refresh_source, downstream_implications_json, hints_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tenant_id, target_skill, source_intent_id)
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
    WHERE excluded.agenda_version > secretary_source_skill_feedback.agenda_version
       OR (
         excluded.agenda_version = secretary_source_skill_feedback.agenda_version
         AND excluded.agenda_item_id = secretary_source_skill_feedback.agenda_item_id
       )
  `).run(
    feedback.ownerUserId,
    tenantId,
    feedback.sourceSkill,
    feedback.agendaItemId,
    feedback.sourceIntentId,
    feedback.agendaVersion,
    feedbackTypeForSourceFeedback(feedback),
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
 * Durable DB-only consumer for Cooking, Finance, and Content feedback.
 *
 * Event payload fields are not decision authority. The exact scoped agenda
 * row and version are re-read inside the outbox lease transaction, then the
 * current logical-intent projection advances only monotonically.
 */
export function consumeSecretarySourceSkillFeedbackEvent(
  event: EventOutboxRecord,
  db: Database.Database,
): void {
  if (event.eventType !== SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE
      || event.sourceSkill !== 'secretary'
      || event.entityType !== 'secretary_agenda_item'
      || event.schemaVersion !== SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION
      || event.eventVersion !== SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_VERSION) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_CONTRACT_MISMATCH');
  }
  if (!Number.isSafeInteger(event.userId) || (event.userId ?? 0) <= 0 || event.tenantId !== event.userId) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_SCOPE_MISMATCH');
  }
  const agendaTenantId = event.payload?.agendaTenantId;
  if (typeof agendaTenantId !== 'string'
      || agendaTenantId.length === 0
      || agendaTenantId.trim() !== agendaTenantId) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_SCOPE_MISMATCH');
  }
  if (!Number.isSafeInteger(event.entityVersion) || event.entityVersion <= 0) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_VERSION_MISMATCH');
  }

  const row = db.prepare(`
    SELECT agenda_item_id, source_intent_id, source_skill, owner_user_id,
           tenant_id, version, decision_action, decision_reason_codes_json,
           start_at, end_at
    FROM secretary_agenda_items
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
      AND version = ?
  `).get(event.entityId, event.userId, agendaTenantId, event.entityVersion) as {
    agenda_item_id: string;
    source_intent_id: string;
    source_skill: SecretarySourceSkill;
    owner_user_id: number;
    tenant_id: string;
    version: number;
    decision_action: string;
    decision_reason_codes_json: string;
    start_at: string | null;
    end_at: string | null;
  } | undefined;
  if (!row) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_SCOPE_MISMATCH');
  }
  if (!isConsumerSourceSkill(row.source_skill)) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_SOURCE_SKILL_UNSUPPORTED');
  }

  const status = parseFeedbackStatus(row.decision_action);
  const reasonCodes = parsePersistedReasonCodes(row.decision_reason_codes_json);
  recordSecretarySourceSkillFeedback({
    sourceSkill: row.source_skill,
    sourceIntentId: row.source_intent_id,
    agendaItemId: row.agenda_item_id,
    ownerUserId: row.owner_user_id,
    tenantId: row.tenant_id,
    agendaVersion: row.version,
    status,
    reasonCodes,
    scheduledStart: row.start_at,
    scheduledEnd: row.end_at,
    shouldRefreshSource: shouldRefreshSource(status),
    downstreamImplications: downstreamImplicationsForSource(row.source_skill, status),
  }, db);
}

export function listSecretarySourceSkillFeedback(scope: {
  userId: number;
  tenantId: string | number;
  sourceSkill?: SecretaryConsumerSourceSkill;
}): SecretarySourceSkillFeedbackRecord[] {
  assertSecretarySourceSkillFeedbackSchemaReady(getDb());
  const params: unknown[] = [scope.userId, String(scope.tenantId)];
  const sourceFilter = scope.sourceSkill ? ' AND target_skill = ?' : '';
  if (scope.sourceSkill) params.push(scope.sourceSkill);
  const rows = getDb().prepare(`
    SELECT *
    FROM secretary_source_skill_feedback
    WHERE user_id = ? AND tenant_id = ?${sourceFilter}
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all(...params);
  return rows.map(rowToFeedbackRecord);
}

function assertSecretarySourceSkillFeedbackSchemaReady(db: Database.Database): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'secretary_source_skill_feedback'").get();
  if (!table) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_MISSING:secretary_source_skill_feedback');
  }
  const columns = db.prepare('PRAGMA table_info(secretary_source_skill_feedback)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const missing = [
    'user_id',
    'tenant_id',
    'target_skill',
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
    throw new Error(`SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_MISSING:${missing.join(',')}`);
  }
}

function feedbackTypeForSourceFeedback(feedback: SecretarySourceSkillFeedback): string {
  if (feedback.status === 'compressed') return `${feedback.sourceSkill}_compressed_window`;
  if (feedback.status === 'reflowed') return `${feedback.sourceSkill}_reflowed_window`;
  if (feedback.status === 'unscheduled' || feedback.status === 'deferred') return `${feedback.sourceSkill}_needs_schedule_attention`;
  if (feedback.status === 'needs_more_context') return `${feedback.sourceSkill}_needs_context`;
  return `${feedback.sourceSkill}_schedule_confirmed`;
}

function hintsForSourceFeedback(feedback: SecretarySourceSkillFeedback): string[] {
  const hints = new Set<string>();
  if (feedback.shouldRefreshSource) hints.add('refresh_user_facing_schedule_copy');
  if (feedback.status === 'compressed') hints.add('adapt_scope_to_available_time');
  if (feedback.status === 'reflowed') hints.add('refresh_time_window');
  if (feedback.status === 'unscheduled' || feedback.status === 'deferred') hints.add('ask_for_another_window');

  if (feedback.sourceSkill === 'cooking') {
    if (feedback.status === 'compressed') hints.add('simplify_meal_prep_scope');
    if (feedback.status === 'unscheduled') hints.add('do_not_create_meal_prep_event');
  }
  if (feedback.sourceSkill === 'finance') {
    hints.add('keep_finance_amounts_private');
    if (feedback.status !== 'scheduled') hints.add('keep_deadline_decision_open');
  }
  if (feedback.sourceSkill === 'content') {
    hints.add('refresh_content_publish_window');
    if (feedback.status === 'compressed') hints.add('reduce_content_block_scope');
  }
  return [...hints];
}

function parseFeedbackStatus(value: string): SecretarySchedulingDecisionStatus {
  if (!FEEDBACK_STATUSES.has(value as SecretarySchedulingDecisionStatus)) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_STATUS_INVALID');
  }
  return value as SecretarySchedulingDecisionStatus;
}

function parsePersistedReasonCodes(raw: string): ReturnType<typeof filterKnownReasonCodes> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_REASON_CODES_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_REASON_CODES_INVALID');
  }
  const reasonCodes = filterKnownReasonCodes(parsed);
  if (reasonCodes.length !== parsed.length) {
    throw new Error('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_REASON_CODES_INVALID');
  }
  return reasonCodes;
}

function shouldRefreshSource(status: SecretarySchedulingDecisionStatus): boolean {
  return ['reflowed', 'compressed', 'deferred', 'unscheduled', 'needs_more_context'].includes(status);
}

function downstreamImplicationsForSource(
  sourceSkill: SecretaryConsumerSourceSkill,
  status: SecretarySchedulingDecisionStatus,
): string[] {
  if (status === 'unscheduled') return [`${sourceSkill} should treat this as not placed on the agenda.`];
  if (status === 'deferred') return [`${sourceSkill} should refresh the intent before the deadline window closes.`];
  if (status === 'compressed') return [`${sourceSkill} should adapt the workload to the shorter scheduled block.`];
  if (status === 'reflowed') return [`${sourceSkill} should refresh any user-facing time copy for this item.`];
  if (status === 'needs_more_context') {
    return [`${sourceSkill} should provide the missing scheduling context or ask the user a targeted question.`];
  }
  return [];
}

function rowToFeedbackRecord(row: any): SecretarySourceSkillFeedbackRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tenantId: String(row.tenant_id),
    targetSkill: String(row.target_skill) as SecretaryConsumerSourceSkill,
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
    logger.warn({ err }, '[secretary-source-feedback] failed to parse JSON array');
    return [];
  }
}

function isConsumerSourceSkill(sourceSkill: SecretarySourceSkill): sourceSkill is SecretaryConsumerSourceSkill {
  return (SOURCE_SKILLS as readonly string[]).includes(sourceSkill);
}

registerSecretarySourceSkillFeedbackConsumers();
