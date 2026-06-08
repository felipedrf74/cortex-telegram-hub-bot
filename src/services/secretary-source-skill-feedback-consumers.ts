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

import { getDb } from './database';
import { registerSecretaryFeedbackConsumer } from './secretary-feedback-bus';
import type {
  SecretarySourceSkill,
  SecretarySourceSkillFeedback,
} from './secretary-scheduling-arbitrator';
import { logger } from '../utils/logger';

const SOURCE_SKILLS = ['cooking', 'finance', 'content'] as const;
type SecretaryConsumerSourceSkill = typeof SOURCE_SKILLS[number];

export interface SecretarySourceSkillFeedbackRecord {
  id: number;
  userId: number;
  tenantId: string;
  targetSkill: SecretaryConsumerSourceSkill;
  agendaItemId: string;
  sourceIntentId: string;
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

export function recordSecretarySourceSkillFeedback(feedback: SecretarySourceSkillFeedback): void {
  if (!isConsumerSourceSkill(feedback.sourceSkill)) return;
  assertSecretarySourceSkillFeedbackSchemaReady();
  const now = new Date().toISOString();
  const hints = hintsForSourceFeedback(feedback);
  getDb().prepare(`
    INSERT INTO secretary_source_skill_feedback (
      user_id, tenant_id, target_skill, agenda_item_id, source_intent_id,
      feedback_type, status, reason_codes_json, scheduled_start, scheduled_end,
      should_refresh_source, downstream_implications_json, hints_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tenant_id, target_skill, agenda_item_id, source_intent_id)
    DO UPDATE SET
      feedback_type = excluded.feedback_type,
      status = excluded.status,
      reason_codes_json = excluded.reason_codes_json,
      scheduled_start = excluded.scheduled_start,
      scheduled_end = excluded.scheduled_end,
      should_refresh_source = excluded.should_refresh_source,
      downstream_implications_json = excluded.downstream_implications_json,
      hints_json = excluded.hints_json,
      updated_at = excluded.updated_at
  `).run(
    feedback.ownerUserId,
    feedback.tenantId,
    feedback.sourceSkill,
    feedback.agendaItemId,
    feedback.sourceIntentId,
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

export function listSecretarySourceSkillFeedback(scope: {
  userId: number;
  tenantId: string | number;
  sourceSkill?: SecretaryConsumerSourceSkill;
}): SecretarySourceSkillFeedbackRecord[] {
  assertSecretarySourceSkillFeedbackSchemaReady();
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

function assertSecretarySourceSkillFeedbackSchemaReady(): void {
  const db = getDb();
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

function rowToFeedbackRecord(row: any): SecretarySourceSkillFeedbackRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tenantId: String(row.tenant_id),
    targetSkill: String(row.target_skill) as SecretaryConsumerSourceSkill,
    agendaItemId: String(row.agenda_item_id),
    sourceIntentId: String(row.source_intent_id),
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
