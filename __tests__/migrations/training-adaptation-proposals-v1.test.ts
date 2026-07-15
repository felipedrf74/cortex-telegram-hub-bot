// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationFileForTest, runMigrationsForTest } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('migration 230 — Training adaptation proposals v1', () => {
  it('applies additively, replays idempotently, and keeps the scoped graph valid', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      applyMigrationFileForTest(db, '230_training_adaptation_proposals_v1.sql');
      expect(db.prepare("SELECT filename FROM _migrations WHERE filename = '230_training_adaptation_proposals_v1.sql'").get())
        .toEqual({ filename: '230_training_adaptation_proposals_v1.sql' });
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'training_adaptation_%'
         ORDER BY name
      `).all()).toEqual([
        { name: 'training_adaptation_lifecycle_events' },
        { name: 'training_adaptation_previews' },
        { name: 'training_adaptation_proposals' },
      ]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'training_plan_adaptation_scope_v1'").get())
        .toEqual({ name: 'training_plan_adaptation_scope_v1' });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('enforces immutable content, scoped foreign keys, lifecycle transitions, and controlled erasure', () => {
    const db = createMigratedTestDatabase();
    try {
      db.pragma('foreign_keys = ON');
      seedRevisionGraph(db);
      seedAdaptation(db);

      expect(() => db.prepare("UPDATE training_adaptation_previews SET scope = 'WEEK' WHERE adaptation_id = 'adaptation-1'").run())
        .toThrow(/immutable/i);
      expect(() => db.prepare("UPDATE training_adaptation_proposals SET rationale = 'changed' WHERE proposal_id = 'proposal-1'").run())
        .toThrow(/immutable/i);
      expect(() => db.prepare("UPDATE training_adaptation_proposals SET status = 'ACTIVATED' WHERE proposal_id = 'proposal-1'").run())
        .toThrow(/lifecycle/i);
      expect(() => db.prepare("DELETE FROM training_adaptation_previews WHERE adaptation_id = 'adaptation-1'").run())
        .toThrow(/immutable/i);

      db.prepare(`
        UPDATE training_adaptation_proposals
           SET decision_id = 'decision-1', status = 'PENDING_REVIEW'
         WHERE proposal_id = 'proposal-1'
      `).run();
      db.prepare("UPDATE training_adaptation_proposals SET status = 'DEFERRED', deferred_at = datetime('now') WHERE proposal_id = 'proposal-1'").run();
      expect(db.prepare("SELECT status FROM training_adaptation_proposals WHERE proposal_id = 'proposal-1'").get())
        .toEqual({ status: 'DEFERRED' });
      expect(() => db.prepare(`
        INSERT INTO training_adaptation_lifecycle_events (
          event_id, proposal_id, tenant_id, user_id, event_type
        ) VALUES ('event-wrong-scope', 'proposal-1', 8, 7, 'DEFERRED')
      `).run()).toThrow(/FOREIGN KEY/i);

      db.prepare(`
        INSERT INTO training_adaptation_lifecycle_events (
          event_id, proposal_id, tenant_id, user_id, event_type
        ) VALUES ('event-1', 'proposal-1', 7, 7, 'DEFERRED')
      `).run();
      db.prepare(`
        INSERT INTO training_revision_erasure_authorizations (
          erasure_id, subject_user_id, reason, expires_at
        ) VALUES ('erase-1', 7, 'ACCOUNT_DELETION', datetime('now', '+5 minutes'))
      `).run();
      expect(db.prepare("DELETE FROM training_adaptation_previews WHERE adaptation_id = 'adaptation-1'").run().changes).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_proposals').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_lifecycle_events').get()).toEqual({ count: 0 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('has a staging-only inverse that removes only milestone 3 schema', () => {
    const db = createMigratedTestDatabase();
    try {
      db.exec(readFileSync(resolve(process.cwd(), 'migrations/down/230_training_adaptation_proposals_v1.sql'), 'utf8'));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'training_adaptation_%'").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'training_plan_revisions'").get())
        .toEqual({ name: 'training_plan_revisions' });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      db.close();
    }
  });
});

function seedRevisionGraph(db: Database.Database): void {
  db.prepare(`
    INSERT INTO training_profile_snapshots (
      snapshot_id, tenant_id, user_id, snapshot_sequence, schema_version,
      content_hash, encrypted_snapshot_body, snapshot_body_key_version,
      display_factor_index_json, normalized_goals_json, normalized_constraints_json,
      factor_evidence_json, source_versions_json, consent_context_json,
      missing_inputs_json, observed_at, captured_at
    ) VALUES (
      'snapshot-1', 7, 7, 1, 'training-profile-snapshot.v1',
      ?, 'encrypted', 'key-v1', '[]', '{}', '{}', '{}', '{}', '{}', '[]',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
    )
  `).run('a'.repeat(64));
  db.prepare(`
    INSERT INTO training_plan_families (
      family_id, tenant_id, user_id, family_key, plan_mode, discipline, origin
    ) VALUES ('family-1', 7, 7, 'continuous:general_fitness', 'continuous', 'strength', 'GENERATED')
  `).run();
  const insert = db.prepare(`
    INSERT INTO training_plan_revisions (
      revision_id, tenant_id, user_id, family_id, revision_sequence, parent_revision_id,
      profile_snapshot_id, origin, lifecycle_state, approval_state,
      creation_context_version, policy_version, catalog_version, catalog_source_hash,
      capability_registry_version, document_schema_version, revision_document_json,
      content_hash, quality_report_json
    ) VALUES (?, 7, 7, 'family-1', ?, ?, 'snapshot-1', 'GENERATED', ?, ?,
      'context-1', 'policy-1', 'catalog-1', ?, 'registry-1',
      'training-plan-revision.v2', '{}', ?, '{}')
  `);
  insert.run('source-1', 1, null, 'ACTIVE', 'APPROVED', 'b'.repeat(64), 'c'.repeat(64));
  insert.run('child-1', 2, 'source-1', 'CANDIDATE', 'UNREVIEWED', 'b'.repeat(64), 'd'.repeat(64));
}

function seedAdaptation(db: Database.Database): void {
  db.prepare(`
    INSERT INTO training_adaptation_previews (
      adaptation_id, tenant_id, user_id, family_id, source_revision_id,
      event_id, trigger_kind, scope, target_json, explicit_input_json, options_json,
      preview_hash, request_hash, expected_source_content_hash, expected_context_version,
      expected_active_pointer_version, policy_version, expires_at
    ) VALUES (
      'adaptation-1', 7, 7, 'family-1', 'source-1', 'event-1', 'BUSY_DAY', 'SESSION',
      '{"workoutKey":"w1"}', '{"availableMinutes":20}', '[]', ?, ?, ?,
      'context-1', 1, 'adaptation-policy-v1', datetime('now', '+30 minutes')
    )
  `).run('e'.repeat(64), 'f'.repeat(64), 'c'.repeat(64));
  db.prepare(`
    INSERT INTO training_adaptation_proposals (
      proposal_id, adaptation_id, tenant_id, user_id, family_id,
      source_revision_id, proposed_revision_id, scope, trigger_kind, option_kind,
      selected_option_id, option_hash, material_fingerprint, explicit_input_json,
      current_state_json, proposed_state_json, differences_json, evidence_json,
      rationale, expected_benefit, possible_downside, reversibility, future_session_effect,
      expected_source_content_hash, expected_context_version, expected_active_pointer_version,
      policy_version, preview_hash, idempotency_key, request_hash, expires_at
    ) VALUES (
      'proposal-1', 'adaptation-1', 7, 7, 'family-1', 'source-1', 'child-1',
      'SESSION', 'BUSY_DAY', 'SHORTEN_MINIMUM_EFFECTIVE', 'option-1', ?, ?,
      '{}', '{}', '{}', '[]', '[]', 'rationale', 'benefit', 'downside', 'reversible',
      'no future effect', ?, 'context-1', 1, 'adaptation-policy-v1', ?,
      'review:event:option', ?, datetime('now', '+30 minutes')
    )
  `).run('1'.repeat(64), '2'.repeat(64), 'c'.repeat(64), 'e'.repeat(64), '3'.repeat(64));
}
