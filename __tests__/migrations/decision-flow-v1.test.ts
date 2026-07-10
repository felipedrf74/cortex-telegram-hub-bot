import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  applyMigrationFileForTest,
  runMigrationsForTest,
  withDatabaseForTest,
} from '../../src/services/database';
import { ensureDecisionCenterTables } from '../../src/services/decision-center';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function apply(db: Database.Database, filename: string): void {
  db.exec(readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
}

describe('migration 227 — Decision flow v1', () => {
  it('backfills legacy rows and adds scoped conflict/concurrency indexes', () => {
    const db = new Database(':memory:');
    try {
      apply(db, '113_secretary_notification_orchestrator.sql');
      apply(db, '119_decision_center_facade.sql');
      db.prepare(`
        INSERT INTO notification_intents (
          intent_id, user_id, tenant_id, source_skill, type, priority,
          title, body, status, created_at
        ) VALUES ('intent-legacy', 7, 7, 'secretary', 'decision_required', 'active',
          'Review', 'Review this item', 'delivered', '2026-07-01T10:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO notification_center_items (
          item_id, intent_id, user_id, tenant_id, title, body, safe_body,
          source_skill, type, priority, status, created_at
        ) VALUES ('decision-legacy', 'intent-legacy', 7, 7, 'Review', 'Review this item',
          'Review this item', 'secretary', 'decision_required', 'active', 'unread',
          '2026-07-01T10:00:00.000Z')
      `).run();

      apply(db, '227_decision_flow_v1.sql');

      const itemColumns = db.prepare('PRAGMA table_info(notification_center_items)').all() as Array<{ name: string }>;
      expect(itemColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'decision_state', 'record_version', 'updated_at',
      ]));
      const intentColumns = db.prepare('PRAGMA table_info(notification_intents)').all() as Array<{ name: string }>;
      expect(intentColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'context_version', 'context_observed_at', 'candidate_fingerprint', 'normalized_action_json',
      ]));
      const executionColumns = db.prepare('PRAGMA table_info(decision_action_executions)').all() as Array<{ name: string }>;
      expect(executionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'logical_action_hash', 'expected_record_version', 'context_version', 'lease_expires_at',
        'effect_results_json', 'recovery_json',
      ]));
      expect(executionColumns.map((column) => column.name)).not.toContain('attempt_count');

      expect(db.prepare('SELECT record_version, updated_at FROM notification_center_items WHERE item_id = ?').get('decision-legacy'))
        .toEqual({ record_version: 1, updated_at: '2026-07-01T10:00:00.000Z' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_conflict_evaluations'").get())
        .toEqual({ name: 'decision_conflict_evaluations' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_exclusivity_claims'").get())
        .toEqual({ name: 'decision_exclusivity_claims' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_flow_preferences'").get())
        .toEqual({ name: 'decision_flow_preferences' });
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        'idx_notification_intents_candidate_fingerprint',
        'idx_decision_conflict_scope_created',
        'idx_decision_exclusivity_lease',
        'idx_decision_execution_active_logical_action',
      ]));
      expect(indexes.map((index) => index.name)).not.toContain('idx_notification_center_decision_state_version');
      db.prepare(`
        INSERT INTO decision_action_executions (
          action_execution_id, decision_id, action_id, user_id, tenant_id,
          idempotency_key, executor_skill, status, logical_action_hash
        ) VALUES ('attempt-partial', 'decision-legacy', 'review', 7, 7,
          'attempt-partial-key', 'secretary', 'partially_failed', 'logical-uncertain')
      `).run();
      expect(() => db.prepare(`
        INSERT INTO decision_action_executions (
          action_execution_id, decision_id, action_id, user_id, tenant_id,
          idempotency_key, executor_skill, status, logical_action_hash
        ) VALUES ('attempt-replay', 'decision-legacy', 'review', 7, 7,
          'attempt-replay-key', 'secretary', 'started', 'logical-uncertain')
      `).run()).toThrow();
    } finally {
      db.close();
    }
  });

  it('applies through the production migration runner on a fresh database', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      expect(db.prepare('SELECT filename FROM _migrations WHERE filename = ?').get('227_decision_flow_v1.sql'))
        .toEqual({ filename: '227_decision_flow_v1.sql' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_conflict_evaluations'").get())
        .toEqual({ name: 'decision_conflict_evaluations' });
    } finally {
      db.close();
    }
  });

  it('survives runtime self-healing before the production runner applies migration 227', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db, { excludeFiles: ['227_decision_flow_v1.sql'] });
      withDatabaseForTest(db, () => ensureDecisionCenterTables());

      expect(() => applyMigrationFileForTest(db, '227_decision_flow_v1.sql')).not.toThrow();
      expect(db.prepare('SELECT filename FROM _migrations WHERE filename = ?').get('227_decision_flow_v1.sql'))
        .toEqual({ filename: '227_decision_flow_v1.sql' });
      const itemColumns = db.prepare('PRAGMA table_info(notification_center_items)').all() as Array<{ name: string }>;
      expect(itemColumns.filter((column) => column.name === 'record_version')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('recovers when decision flow 227 is applied before upstream migration 226', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db, {
        excludeFiles: ['226_paid_ai_cost_controls.sql', '227_decision_flow_v1.sql'],
      });
      applyMigrationFileForTest(db, '227_decision_flow_v1.sql');
      expect(() => applyMigrationFileForTest(db, '226_paid_ai_cost_controls.sql')).not.toThrow();

      expect(db.prepare(`
        SELECT filename FROM _migrations
         WHERE filename IN ('226_paid_ai_cost_controls.sql', '227_decision_flow_v1.sql')
         ORDER BY id ASC
      `).all()).toEqual([
        { filename: '227_decision_flow_v1.sql' },
        { filename: '226_paid_ai_cost_controls.sql' },
      ]);
      const executionColumns = db.prepare('PRAGMA table_info(decision_action_executions)').all() as Array<{ name: string }>;
      expect(executionColumns.map((column) => column.name)).toContain('logical_action_hash');
      const usageColumns = db.prepare('PRAGMA table_info(api_usage)').all() as Array<{ name: string }>;
      expect(usageColumns.map((column) => column.name)).toContain('request_source');
    } finally {
      db.close();
    }
  });
});
