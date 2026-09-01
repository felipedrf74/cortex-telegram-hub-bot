// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Test-only compatibility schema installer.
 *
 * Production schema ownership belongs exclusively to governed SQL migrations.
 * Tests that intentionally assemble narrow in-memory fixtures may call this
 * installer before exercising the production readiness assertion.
 */
import { getDb } from '../services/database';
import { ensureBackgroundJobTables } from '../services/background-job-queue';
import { ensureEventOutboxTables } from '../services/event-outbox';
import { ensureNotificationTables } from '../services/notification-orchestrator';

const ensuredDecisionCenterDatabases = new WeakSet<object>();

export function initializeDecisionCenterSchemaForTests(): void {
  const db = getDb();
  if (ensuredDecisionCenterDatabases.has(db) && decisionFlowSchemaReady(db)) return;
  ensureNotificationTables();
  ensureEventOutboxTables(db);
  ensureBackgroundJobTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_agent TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      consumed_by TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      tenant_id INTEGER,
      user_id INTEGER,
      confidence REAL DEFAULT 0.5,
      format_tag TEXT,
      pillar_tag TEXT,
      evidence_count INTEGER DEFAULT 1,
      mesh_priority INTEGER
    );
    CREATE TABLE IF NOT EXISTS report_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      document_json TEXT NOT NULL,
      source_job TEXT,
      status TEXT NOT NULL DEFAULT 'unread',
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn('notification_center_items', 'snoozed_until', 'TEXT');
  ensureColumn('notification_center_items', 'action_result_json', 'TEXT');
  ensureColumn('notification_center_items', 'priority_score', 'INTEGER');
  ensureColumn('notification_center_items', 'decision_state', 'TEXT');
  ensureColumn('notification_center_items', 'record_version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('notification_center_items', 'updated_at', 'TEXT');
  ensureColumn('notification_intents', 'context_version', 'TEXT');
  ensureColumn('notification_intents', 'context_observed_at', 'TEXT');
  ensureColumn('notification_intents', 'candidate_fingerprint', 'TEXT');
  ensureColumn('notification_intents', 'normalized_action_json', 'TEXT');
  ensureColumn('agent_signals', 'signal_identity', 'TEXT');
  ensureColumn('agent_signals', 'provenance_json', 'TEXT');
  ensureColumn('report_documents', 'tenant_id', 'INTEGER');
  db.prepare('UPDATE report_documents SET tenant_id = user_id WHERE tenant_id IS NULL').run();
  ensureColumn('report_documents', 'dispatch_key', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_action_executions (
      action_execution_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      executor_skill TEXT NOT NULL,
      status TEXT NOT NULL,
      expected_effect_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      failed_at TEXT,
      error_code TEXT,
      UNIQUE(decision_id, action_id, user_id, tenant_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_action_scope
      ON decision_action_executions(user_id, tenant_id, decision_id, action_id);
    CREATE INDEX IF NOT EXISTS idx_notification_center_decision_home
      ON notification_center_items(user_id, tenant_id, status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_notification_center_decision_rank
      ON notification_center_items(user_id, tenant_id, status, priority_score DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_center_active_expiry
      ON notification_center_items(status, expires_at) WHERE expires_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS decision_dependencies (
      dependency_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      depends_on_decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'blocks',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(decision_id, depends_on_decision_id, user_id, tenant_id, relationship)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_dependencies_scope
      ON decision_dependencies(user_id, tenant_id, decision_id, relationship);
    CREATE INDEX IF NOT EXISTS idx_decision_dependencies_blocker
      ON decision_dependencies(user_id, tenant_id, depends_on_decision_id, relationship);
    CREATE TABLE IF NOT EXISTS handled_by_nexus_items (
      handled_item_id TEXT PRIMARY KEY,
      decision_id TEXT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      why_brief TEXT NOT NULL,
      explanation_json TEXT,
      related_entities_json TEXT NOT NULL DEFAULT '[]',
      rollback_available INTEGER NOT NULL DEFAULT 0,
      changed_rule_option TEXT,
      privacy_classification TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_handled_by_nexus_scope_created
      ON handled_by_nexus_items(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_outcome_ledger (
      outcome_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      automation_eligibility TEXT NOT NULL DEFAULT 'never',
      action_shown TEXT,
      action_taken TEXT,
      accepted INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      snoozed INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      asked_nexus INTEGER NOT NULL DEFAULT 0,
      manually_corrected INTEGER NOT NULL DEFAULT 0,
      undo_used INTEGER NOT NULL DEFAULT 0,
      time_to_action_ms INTEGER,
      action_succeeded INTEGER NOT NULL DEFAULT 0,
      partial_failure INTEGER NOT NULL DEFAULT 0,
      failed_reason TEXT,
      feature_snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_outcome_scope_created
      ON decision_outcome_ledger(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_quality_gate_events (
      event_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      quality_status TEXT NOT NULL,
      quality_score INTEGER NOT NULL DEFAULT 0,
      missing_fields_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL,
      generic_blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_quality_gate_scope_created
      ON decision_quality_gate_events(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      action_id TEXT,
      reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_lifecycle_events_scope_created
      ON decision_lifecycle_events(user_id, tenant_id, decision_id, created_at);
    CREATE TABLE IF NOT EXISTS decision_metrics_daily (
      metric_date TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL DEFAULT '*',
      created_count INTEGER NOT NULL DEFAULT 0,
      surfaced_count INTEGER NOT NULL DEFAULT 0,
      viewed_count INTEGER NOT NULL DEFAULT 0,
      dismissed_count INTEGER NOT NULL DEFAULT 0,
      snoozed_count INTEGER NOT NULL DEFAULT 0,
      action_succeeded_count INTEGER NOT NULL DEFAULT 0,
      action_failed_count INTEGER NOT NULL DEFAULT 0,
      expired_count INTEGER NOT NULL DEFAULT 0,
      gate_blocked_count INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (metric_date, tenant_id, source_skill)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_metrics_daily_tenant
      ON decision_metrics_daily(tenant_id, metric_date);
    CREATE TABLE IF NOT EXISTS decision_queue_daily_rollups (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      reached_zero_at TEXT,
      final_open_count INTEGER NOT NULL DEFAULT 0,
      best_observed_open_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, local_date)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_queue_daily_rollups_scope_date
      ON decision_queue_daily_rollups(user_id, tenant_id, local_date DESC);
    CREATE TABLE IF NOT EXISTS decision_type_suppressions (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      mode TEXT NOT NULL,
      until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, source_skill, type)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_type_suppressions_scope
      ON decision_type_suppressions(user_id, tenant_id);
    CREATE TABLE IF NOT EXISTS decision_recipe_suppressions (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      recipe TEXT NOT NULL,
      mode TEXT NOT NULL,
      until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, source_skill, type, recipe)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_recipe_suppressions_scope
      ON decision_recipe_suppressions(user_id, tenant_id, source_skill, type);
  `);
  ensureColumn('decision_action_executions', 'logical_action_hash', 'TEXT');
  ensureColumn('decision_action_executions', 'expected_record_version', 'INTEGER');
  ensureColumn('decision_action_executions', 'context_version', 'TEXT');
  ensureColumn('decision_action_executions', 'lease_expires_at', 'TEXT');
  ensureColumn('decision_action_executions', 'effect_results_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('decision_action_executions', 'recovery_json', "TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    UPDATE notification_center_items
       SET updated_at = COALESCE(updated_at, created_at),
           record_version = COALESCE(record_version, 1)
     WHERE updated_at IS NULL OR record_version IS NULL;
    CREATE TABLE IF NOT EXISTS decision_conflict_evaluations (
      conflict_evaluation_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      policy_version TEXT NOT NULL,
      context_version TEXT NOT NULL,
      disposition TEXT NOT NULL,
      hard_conflict_count INTEGER NOT NULL DEFAULT 0,
      soft_conflict_count INTEGER NOT NULL DEFAULT 0,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      related_decision_ids_json TEXT NOT NULL DEFAULT '[]',
      precedence_trace_json TEXT NOT NULL DEFAULT '[]',
      winner_decision_id TEXT,
      resolution TEXT,
      automatically_resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS decision_exclusivity_claims (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      exclusivity_key TEXT NOT NULL,
      action_execution_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      context_version TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, exclusivity_key)
    );
    CREATE TABLE IF NOT EXISTS decision_flow_preferences (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      allow_low_risk_auto_reflow INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE TABLE IF NOT EXISTS decision_center_rank_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      ranking_as_of TEXT NOT NULL,
      ranking_version INTEGER NOT NULL,
      filter_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      entry_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_rank_snapshots_scope_latest
      ON decision_center_rank_snapshots(user_id, tenant_id, ranking_version, filter_fingerprint, ranking_as_of DESC);
    CREATE TABLE IF NOT EXISTS decision_center_rank_snapshot_entries (
      snapshot_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      decision_id TEXT NOT NULL,
      priority_tier TEXT NOT NULL,
      priority_score REAL NOT NULL,
      decision_created_at TEXT NOT NULL,
      projection_json TEXT,
      PRIMARY KEY (snapshot_id, ordinal),
      UNIQUE (snapshot_id, decision_id),
      FOREIGN KEY (snapshot_id) REFERENCES decision_center_rank_snapshots(snapshot_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_decision_rank_snapshot_entries_scope
      ON decision_center_rank_snapshot_entries(snapshot_id, user_id, tenant_id, ordinal);
    CREATE TABLE IF NOT EXISTS scheduled_report_completion_receipts (
      receipt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      report_job TEXT NOT NULL,
      local_date TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, tenant_id, report_job, local_date)
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_report_receipts_scope_date
      ON scheduled_report_completion_receipts(user_id, tenant_id, local_date DESC, report_job);
    CREATE TABLE IF NOT EXISTS planning_recompute_receipts (
      receipt_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      idempotency_key_hash TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_token TEXT,
      lease_expires_at TEXT,
      snapshot_id TEXT,
      response_json TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, tenant_id, idempotency_key_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_planning_recompute_receipts_scope_created
      ON planning_recompute_receipts(user_id, tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_report_documents_scoped_dispatch
      ON report_documents(tenant_id, user_id, type, dispatch_key);
    CREATE TABLE IF NOT EXISTS report_document_dispatch_receipts (
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      report_type TEXT NOT NULL,
      dispatch_key TEXT NOT NULL,
      report_document_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, user_id, report_type, dispatch_key),
      UNIQUE (report_document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_report_document_dispatch_receipts_report
      ON report_document_dispatch_receipts(report_document_id, tenant_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_notification_intents_candidate_fingerprint
      ON notification_intents(user_id, tenant_id, candidate_fingerprint, created_at DESC)
      WHERE candidate_fingerprint IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_decision_conflict_scope_created
      ON decision_conflict_evaluations(user_id, tenant_id, decision_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_exclusivity_lease
      ON decision_exclusivity_claims(user_id, tenant_id, lease_expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_execution_active_logical_action
      ON decision_action_executions(user_id, tenant_id, logical_action_hash)
      WHERE logical_action_hash IS NOT NULL AND status IN ('started', 'succeeded', 'partially_failed');
  `);
  ensureColumn('decision_conflict_evaluations', 'precedence_trace_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('decision_conflict_evaluations', 'winner_decision_id', 'TEXT');
  ensureColumn('handled_by_nexus_items', 'explanation_json', 'TEXT');
  ensuredDecisionCenterDatabases.add(db);
}

function decisionFlowSchemaReady(db: ReturnType<typeof getDb>): boolean {
  try {
    const preferenceTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'decision_flow_preferences'
       LIMIT 1
    `).get();
    if (!preferenceTable) return false;
    const snapshotTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'decision_center_rank_snapshots'
       LIMIT 1
    `).get();
    if (!snapshotTable) return false;
    const recomputeTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'planning_recompute_receipts'
       LIMIT 1
    `).get();
    if (!recomputeTable) return false;
    const dispatchReceiptTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'report_document_dispatch_receipts'
       LIMIT 1
    `).get();
    if (!dispatchReceiptTable) return false;
    const signalColumns = new Set((db.prepare('PRAGMA table_info(agent_signals)').all() as Array<{ name: string }>).map((row) => row.name));
    if (!signalColumns.has('signal_identity') || !signalColumns.has('provenance_json')) return false;
    const reportColumns = new Set((db.prepare('PRAGMA table_info(report_documents)').all() as Array<{ name: string }>).map((row) => row.name));
    if (!reportColumns.has('dispatch_key')) return false;
    const itemColumns = new Set((db.prepare('PRAGMA table_info(notification_center_items)').all() as Array<{ name: string }>).map((row) => row.name));
    return itemColumns.has('decision_state') && itemColumns.has('record_version') && itemColumns.has('updated_at');
  } catch {
    return false;
  }
}


function ensureColumn(table: string, column: string, ddl: string): void {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
