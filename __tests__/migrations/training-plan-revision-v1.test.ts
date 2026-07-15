// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationFileForTest, runMigrationsForTest } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const TABLES = [
  'training_profile_snapshots',
  'training_plan_families',
  'training_plan_revisions',
  'training_plan_revision_approvals',
  'training_plan_current_contexts',
  'training_active_plan_references',
  'training_plan_revision_operations',
];

function seedRevisionGraph(db: Database.Database): void {
  db.prepare(`
    INSERT INTO training_profile_snapshots (
      snapshot_id, tenant_id, user_id, snapshot_sequence, schema_version,
      content_hash, encrypted_snapshot_body, snapshot_body_key_version,
      display_factor_index_json, normalized_goals_json, normalized_constraints_json,
      factor_evidence_json, source_versions_json, consent_context_json,
      missing_inputs_json, observed_at, captured_at
    ) VALUES (
      'snapshot-1', 9, 7, 1, 'training-profile-snapshot.v1',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'encrypted-test-body', 'training-profile-snapshot-aes256gcm.v1', '[]',
      '{"goal":"general_fitness"}', '{}', '{}', '{}', '{}', '[]',
      '2026-07-12T09:00:00.000Z', '2026-07-12T09:00:00.000Z'
    )
  `).run();
  db.prepare(`
    INSERT INTO training_plan_families (
      family_id, tenant_id, user_id, family_key, plan_mode, discipline, origin
    ) VALUES ('family-1', 9, 7, 'general-fitness-continuous', 'continuous', 'strength', 'GENERATED')
  `).run();
  db.prepare(`
    INSERT INTO training_plan_revisions (
      revision_id, tenant_id, user_id, family_id, revision_sequence,
      profile_snapshot_id, origin, lifecycle_state, creation_context_version,
      policy_version, catalog_version, catalog_source_hash,
      capability_registry_version, document_schema_version,
      revision_document_json, content_hash, quality_report_json
    ) VALUES (
      'revision-1', 9, 7, 'family-1', 1, 'snapshot-1', 'GENERATED', 'CANDIDATE',
      'context-1', 'policy-1', 'catalog-1',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'training-workout-capabilities.v1', 'training-plan-revision.v1',
      '{"planMode":"continuous"}',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', '{}'
    )
  `).run();
}

describe('migration 228 — Training plan revision v1', () => {
  it('applies additively through the production migration runner', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      expect(db.prepare('SELECT filename FROM _migrations WHERE filename = ?').get('228_training_plan_revision_v1.sql'))
        .toEqual({ filename: '228_training_plan_revision_v1.sql' });
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'training_%'
      `).all() as Array<{ name: string }>;
      expect(tables.map((entry) => entry.name)).toEqual(expect.arrayContaining(TABLES));

      const planColumns = db.prepare('PRAGMA table_info(fitness_training_plans)').all() as Array<{ name: string }>;
      const weekColumns = db.prepare('PRAGMA table_info(training_weeks)').all() as Array<{ name: string }>;
      const sessionColumns = db.prepare('PRAGMA table_info(training_sessions)').all() as Array<{ name: string }>;
      expect(planColumns.map((entry) => entry.name)).toContain('source_revision_id');
      expect(weekColumns.map((entry) => entry.name)).toEqual(expect.arrayContaining([
        'source_revision_id', 'revision_week_key',
      ]));
      expect(sessionColumns.map((entry) => entry.name)).toEqual(expect.arrayContaining([
        'source_revision_id', 'revision_session_key',
      ]));
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(() => db.prepare(`
        INSERT INTO training_plan_revision_operations (
          operation_id, tenant_id, user_id, operation_type, idempotency_key,
          request_hash, status
        ) VALUES ('operation-short-hash', 7, 7, 'CREATE_CANDIDATE', 'key', 'short', 'IN_PROGRESS')
      `).run()).toThrow(/CHECK constraint failed/i);
    } finally {
      db.close();
    }
  });

  it('replays safely when one additive legacy column already exists', () => {
    const db = createMigratedTestDatabase({ excludeFiles: ['228_training_plan_revision_v1.sql'] });
    try {
      db.exec('ALTER TABLE fitness_training_plans ADD COLUMN source_revision_id TEXT');
      applyMigrationFileForTest(db, '228_training_plan_revision_v1.sql');
      expect(db.prepare('SELECT filename FROM _migrations WHERE filename = ?').get('228_training_plan_revision_v1.sql'))
        .toEqual({ filename: '228_training_plan_revision_v1.sql' });
      const columns = db.prepare('PRAGMA table_info(fitness_training_plans)').all() as Array<{ name: string }>;
      expect(columns.filter((column) => column.name === 'source_revision_id')).toHaveLength(1);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('enforces immutable snapshot and revision content while permitting lifecycle transitions', () => {
    const db = createMigratedTestDatabase();
    try {
      seedRevisionGraph(db);

      expect(() => db.prepare(`
        UPDATE training_profile_snapshots SET normalized_goals_json = '{"goal":"different"}'
         WHERE snapshot_id = 'snapshot-1'
      `).run()).toThrow(/immutable/i);
      expect(() => db.prepare(`
        UPDATE training_plan_revisions SET revision_document_json = '{"planMode":"event_based"}'
         WHERE revision_id = 'revision-1'
      `).run()).toThrow(/immutable/i);
      expect(() => db.prepare(`
        UPDATE training_plan_revisions
           SET lifecycle_state = 'PENDING_REVIEW', decision_id = 'decision-1'
         WHERE revision_id = 'revision-1'
      `).run()).not.toThrow();
      expect(() => db.prepare(`
        UPDATE training_plan_revisions SET decision_id = 'decision-2'
         WHERE revision_id = 'revision-1'
      `).run()).toThrow(/decision binding is immutable/i);
    } finally {
      db.close();
    }
  });

  it('keeps approval receipts immutable and active pointers CAS-versioned', () => {
    const db = createMigratedTestDatabase();
    try {
      db.pragma('foreign_keys = ON');
      seedRevisionGraph(db);
      db.prepare(`
        INSERT INTO training_plan_revision_approvals (
          approval_id, tenant_id, user_id, family_id, revision_id, decision_id,
          decision_record_version, action_execution_id, approved_content_hash,
          approved_context_version, actor_type, approval_source, approved_at
        ) VALUES (
          'approval-1', 9, 7, 'family-1', 'revision-1', 'decision-1', 3, 'execution-1',
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          'context-1', 'user', 'DECISION_CENTER',
          '2026-07-12T10:00:00.000Z'
        )
      `).run();
      expect(() => db.prepare(`
        UPDATE training_plan_revision_approvals SET approved_content_hash = 'different'
         WHERE approval_id = 'approval-1'
      `).run()).toThrow(/immutable/i);

      db.prepare(`
        INSERT INTO training_active_plan_references (
          tenant_id, user_id, family_id, active_revision_id, pointer_version
        ) VALUES (9, 7, 'family-1', 'revision-1', 1)
      `).run();
      expect(db.prepare(`
        UPDATE training_active_plan_references
           SET pointer_version = pointer_version + 1
         WHERE tenant_id = 9 AND user_id = 7 AND family_id = 'family-1' AND pointer_version = 1
      `).run().changes).toBe(1);
      expect(db.prepare(`
        UPDATE training_active_plan_references
           SET pointer_version = pointer_version + 1
         WHERE tenant_id = 9 AND user_id = 7 AND family_id = 'family-1' AND pointer_version = 1
      `).run().changes).toBe(0);
    } finally {
      db.close();
    }
  });

  it('enforces one coherent revision, family, snapshot and context graph for the current pointer', () => {
    const db = createMigratedTestDatabase();
    try {
      db.pragma('foreign_keys = ON');
      seedRevisionGraph(db);
      db.prepare(`
        INSERT INTO training_plan_current_contexts (
          tenant_id, user_id, family_id, current_revision_id,
          current_profile_snapshot_id, current_context_version,
          base_context_version, profile_source_version,
          calendar_source_version, conflict_source_version
        ) VALUES (
          9, 7, 'family-1', 'revision-1', 'snapshot-1', 'context-1',
          'base-context-1', 'profile_12345678', 'calendar_12345678', 'conflict_12345678'
        )
      `).run();
      expect(() => db.prepare(`
        UPDATE training_plan_current_contexts
           SET current_context_version = 'wrong-context'
         WHERE family_id = 'family-1'
      `).run()).toThrow(/graph is inconsistent/i);
      expect(() => db.prepare(`
        UPDATE training_plan_current_contexts
           SET current_profile_snapshot_id = 'missing-snapshot'
         WHERE family_id = 'family-1'
      `).run()).toThrow();
    } finally {
      db.close();
    }
  });
});
