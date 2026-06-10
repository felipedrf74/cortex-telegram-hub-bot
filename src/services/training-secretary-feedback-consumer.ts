// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training consumer for Secretary scheduling feedback (W-B).
 *
 * Secretary emits after every persisted scheduling decision. Training stores a
 * compact, tenant-scoped hint so the next plan/coach pass can account for
 * compressed sessions, reflows, and unscheduled work without re-parsing
 * Secretary agenda rows.
 */

import { getDb } from './database';
import { registerSecretaryFeedbackConsumer } from './secretary-feedback-bus';
import type { SecretarySourceSkillFeedback } from './secretary-scheduling-arbitrator';
import { logger } from '../utils/logger';

const HANDLER_ID = 'training-feedback-decisions';

export interface TrainingSecretaryFeedbackDecision {
  id: number;
  userId: number;
  tenantId: string;
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

export function recordTrainingSecretaryFeedback(feedback: SecretarySourceSkillFeedback): void {
  if (feedback.sourceSkill !== 'training') return;
  assertTrainingFeedbackDecisionsSchemaReady();
  const now = new Date().toISOString();
  const hints = hintsForTrainingFeedback(feedback);
  getDb().prepare(`
    INSERT INTO training_feedback_decisions (
      user_id, tenant_id, source_skill, agenda_item_id, source_intent_id,
      feedback_type, status, reason_codes_json, scheduled_start, scheduled_end,
      should_refresh_source, downstream_implications_json, hints_json, created_at, updated_at
    ) VALUES (?, ?, 'secretary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tenant_id, agenda_item_id, source_intent_id)
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
    feedback.agendaItemId,
    feedback.sourceIntentId,
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

export function listTrainingSecretaryFeedbackDecisions(scope: {
  userId: number;
  tenantId: string | number;
}): TrainingSecretaryFeedbackDecision[] {
  assertTrainingFeedbackDecisionsSchemaReady();
  const rows = getDb().prepare(`
    SELECT *
    FROM training_feedback_decisions
    WHERE user_id = ? AND tenant_id = ?
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all(scope.userId, String(scope.tenantId));
  return rows.map(rowToTrainingFeedbackDecision);
}

function assertTrainingFeedbackDecisionsSchemaReady(): void {
  const db = getDb();
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

function rowToTrainingFeedbackDecision(row: any): TrainingSecretaryFeedbackDecision {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tenantId: String(row.tenant_id),
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
    logger.warn({ err }, '[training-secretary-feedback] failed to parse JSON array');
    return [];
  }
}

registerTrainingSecretaryFeedbackConsumer();
