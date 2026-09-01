// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from '../database';
import { DecisionCenterError } from './errors';

export const DECISION_CENTER_REPOSITORY_SCHEMA_VERSION = 'decision_center_repository@1.1.0' as const;

export interface DecisionCenterTableRequirement {
  readonly table: string;
  readonly columns: readonly string[];
}

export const DECISION_CENTER_REPOSITORY_REQUIREMENTS: readonly DecisionCenterTableRequirement[] = Object.freeze([
  requirement('notification_center_items', [
    'item_id', 'intent_id', 'user_id', 'tenant_id', 'status', 'actions_json',
    'decision_state', 'record_version', 'updated_at', 'priority_score',
    'snoozed_until', 'action_result_json',
  ]),
  requirement('notification_intents', [
    'intent_id', 'user_id', 'tenant_id', 'action_buttons_json',
    'decision_context_json', 'context_version', 'context_observed_at',
    'candidate_fingerprint', 'normalized_action_json',
  ]),
  requirement('notification_profiles', [
    'user_id', 'tenant_id', 'timezone', 'push_enabled', 'marketing_push_enabled',
    'portal_enabled', 'in_app_enabled', 'allow_time_sensitive',
    'digest_passive_items', 'updated_at',
  ]),
  requirement('notification_decision_logs', [
    'decision_log_id', 'intent_id', 'notification_id', 'user_id', 'tenant_id',
    'source_skill', 'decision', 'priority', 'reason', 'delivery_attempt_ids_json',
  ]),
  requirement('notification_delivery_attempts', [
    'attempt_id', 'notification_id', 'intent_id', 'user_id', 'tenant_id',
    'channel', 'provider', 'status', 'created_at',
  ]),
  requirement('notification_reliability_events', [
    'event_id', 'user_id', 'tenant_id', 'event_type', 'badge_count', 'created_at',
  ]),
  requirement('notification_device_tokens', [
    'token_id', 'user_id', 'tenant_id', 'token_hash', 'environment', 'device_id',
    'device_timezone', 'authorization_tier', 'last_seen_at', 'revoked_at',
  ]),
  requirement('notification_engagement_events', [
    'event_id', 'user_id', 'tenant_id', 'notification_id', 'intent_id',
    'source_skill', 'type', 'priority', 'event_type', 'created_at',
  ]),
  requirement('decision_action_executions', [
    'action_execution_id', 'decision_id', 'action_id', 'user_id', 'tenant_id',
    'idempotency_key', 'status', 'logical_action_hash', 'expected_record_version',
    'context_version', 'lease_expires_at', 'effect_results_json', 'recovery_json',
  ]),
  requirement('decision_conflict_evaluations', [
    'conflict_evaluation_id', 'decision_id', 'user_id', 'tenant_id',
    'context_version', 'disposition', 'created_at',
  ]),
  requirement('decision_exclusivity_claims', [
    'user_id', 'tenant_id', 'exclusivity_key', 'action_execution_id',
    'decision_id', 'context_version', 'status', 'lease_expires_at',
  ]),
  requirement('decision_flow_preferences', [
    'user_id', 'tenant_id', 'allow_low_risk_auto_reflow', 'updated_at',
  ]),
  requirement('decision_dependencies', [
    'dependency_id', 'decision_id', 'depends_on_decision_id', 'user_id',
    'tenant_id', 'relationship', 'created_at',
  ]),
  requirement('handled_by_nexus_items', [
    'handled_item_id', 'decision_id', 'user_id', 'tenant_id', 'source_skill',
    'action_taken', 'explanation_json', 'rollback_available', 'created_at',
  ]),
  requirement('decision_outcome_ledger', [
    'outcome_id', 'decision_id', 'user_id', 'tenant_id', 'source_skill',
    'action_taken', 'action_succeeded', 'partial_failure', 'created_at',
  ]),
  requirement('decision_quality_gate_events', [
    'event_id', 'user_id', 'tenant_id', 'source_skill', 'quality_status',
    'generic_blocked', 'created_at',
  ]),
  requirement('decision_lifecycle_events', [
    'event_id', 'decision_id', 'user_id', 'tenant_id', 'event', 'action_id',
    'metadata_json', 'created_at',
  ]),
  requirement('decision_metrics_daily', [
    'metric_date', 'tenant_id', 'source_skill', 'created_count',
    'surfaced_count', 'viewed_count', 'computed_at',
  ]),
  requirement('decision_queue_daily_rollups', [
    'user_id', 'tenant_id', 'local_date', 'timezone', 'final_open_count',
    'best_observed_open_count', 'updated_at',
  ]),
  requirement('decision_center_rank_snapshots', [
    'snapshot_id', 'user_id', 'tenant_id', 'ranking_as_of', 'ranking_version',
    'filter_fingerprint', 'created_at', 'expires_at', 'entry_count',
  ]),
  requirement('decision_center_rank_snapshot_entries', [
    'snapshot_id', 'user_id', 'tenant_id', 'ordinal', 'decision_id',
    'priority_tier', 'priority_score', 'decision_created_at', 'projection_json',
  ]),
  requirement('decision_type_suppressions', [
    'user_id', 'tenant_id', 'source_skill', 'type', 'mode', 'until', 'created_at',
  ]),
  requirement('decision_recipe_suppressions', [
    'user_id', 'tenant_id', 'source_skill', 'type', 'recipe', 'mode', 'until',
    'created_at',
  ]),
  requirement('event_outbox', [
    'event_id', 'tenant_id', 'user_id', 'event_type', 'entity_type', 'entity_id',
    'idempotency_key', 'status', 'fencing_token', 'lease_expires_at',
  ]),
  requirement('background_jobs', [
    'job_id', 'tenant_id', 'user_id', 'job_type', 'idempotency_key', 'status',
    'attempts', 'max_attempts', 'fencing_token', 'lease_expires_at',
  ]),
  requirement('agent_signals', [
    'id', 'source_agent', 'signal_type', 'payload', 'status', 'expires_at',
    'user_id', 'tenant_id', 'signal_identity', 'provenance_json',
  ]),
  requirement('report_documents_scoped', [
    'id', 'tenant_id', 'user_id', 'type', 'title', 'document_json',
    'source_job', 'dispatch_key', 'status', 'created_at',
  ]),
  requirement('report_document_dispatch_receipts', [
    'tenant_id', 'user_id', 'report_type', 'dispatch_key',
    'report_document_id', 'created_at',
  ]),
  requirement('scheduled_report_completion_receipts', [
    'receipt_id', 'job_id', 'user_id', 'tenant_id', 'report_job', 'local_date',
    'attempts', 'completed_at', 'created_at',
  ]),
  requirement('planning_recompute_receipts', [
    'receipt_id', 'user_id', 'tenant_id', 'idempotency_key_hash',
    'request_fingerprint', 'status', 'lease_token', 'lease_expires_at',
    'snapshot_id', 'response_json', 'last_error_code', 'created_at', 'updated_at',
  ]),
]);

export interface DecisionCenterRepositoryReadinessReport {
  readonly schemaVersion: typeof DECISION_CENTER_REPOSITORY_SCHEMA_VERSION;
  readonly ready: boolean;
  readonly missingTables: readonly string[];
  readonly missingColumns: Readonly<Record<string, readonly string[]>>;
}

/** Read-only schema inspection. This function contains no DDL or repair path. */
export function inspectDecisionCenterRepositoryReadiness(
  db: Database.Database,
  requirements: readonly DecisionCenterTableRequirement[] = DECISION_CENTER_REPOSITORY_REQUIREMENTS,
): DecisionCenterRepositoryReadinessReport {
  assertSafeRequirements(requirements);
  if (requirements.length === 0) return readyReport([], {});

  const names = requirements.map((entry) => entry.table);
  const placeholders = names.map(() => '?').join(', ');
  let rows: Array<{ name: string }>;
  try {
    rows = db.prepare(`
      SELECT name
        FROM sqlite_master
       WHERE type = 'table'
         AND name IN (${placeholders})
    `).all(...names) as Array<{ name: string }>;
  } catch (cause) {
    throw inspectionFailure(cause);
  }

  const present = new Set(rows.map((row) => row.name));
  const missingTables = names.filter((name) => !present.has(name));
  const missingColumns: Record<string, readonly string[]> = {};

  try {
    for (const entry of requirements) {
      if (!present.has(entry.table)) continue;
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${quotedIdentifier(entry.table)})`).all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      const missing = entry.columns.filter((column) => !columns.has(column));
      if (missing.length > 0) missingColumns[entry.table] = Object.freeze([...missing]);
    }
  } catch (cause) {
    throw inspectionFailure(cause);
  }

  return readyReport(missingTables, missingColumns);
}

export function assertDecisionCenterRepositoryReady(
  db: Database.Database,
  requirements: readonly DecisionCenterTableRequirement[] = DECISION_CENTER_REPOSITORY_REQUIREMENTS,
): DecisionCenterRepositoryReadinessReport {
  const report = inspectDecisionCenterRepositoryReadiness(db, requirements);
  if (report.ready) return report;
  throw new DecisionCenterError(
    'DECISION_REPOSITORY_NOT_READY',
    'Decision Center repository schema is not ready.',
    500,
    {
      missingTables: report.missingTables,
      missingColumns: report.missingColumns,
      schemaVersion: report.schemaVersion,
    },
  );
}

/**
 * Historical public name retained as a readiness assertion. It never creates,
 * alters, or repairs tables; process startup migrations own all DDL.
 */
export function ensureDecisionCenterTables(): void {
  assertDecisionCenterRepositoryReady(getDb());
}

function readyReport(
  missingTables: readonly string[],
  missingColumns: Readonly<Record<string, readonly string[]>>,
): DecisionCenterRepositoryReadinessReport {
  const frozenColumns = Object.freeze({ ...missingColumns });
  return Object.freeze({
    schemaVersion: DECISION_CENTER_REPOSITORY_SCHEMA_VERSION,
    ready: missingTables.length === 0 && Object.keys(frozenColumns).length === 0,
    missingTables: Object.freeze([...missingTables]),
    missingColumns: frozenColumns,
  });
}

function requirement(table: string, columns: readonly string[]): DecisionCenterTableRequirement {
  return Object.freeze({ table, columns: Object.freeze([...columns]) });
}

function assertSafeRequirements(requirements: readonly DecisionCenterTableRequirement[]): void {
  for (const entry of requirements) {
    assertIdentifier(entry.table);
    for (const column of entry.columns) assertIdentifier(column);
  }
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new DecisionCenterError(
      'DECISION_REPOSITORY_REQUIREMENT_INVALID',
      'Decision Center repository requirement contains an invalid identifier.',
      500,
    );
  }
}

function quotedIdentifier(value: string): string {
  assertIdentifier(value);
  return `"${value}"`;
}

function inspectionFailure(cause: unknown): DecisionCenterError<'DECISION_REPOSITORY_INSPECTION_FAILED'> {
  return new DecisionCenterError(
    'DECISION_REPOSITORY_INSPECTION_FAILED',
    'Decision Center repository schema could not be inspected.',
    500,
    undefined,
    cause instanceof Error ? { cause } : undefined,
  );
}
