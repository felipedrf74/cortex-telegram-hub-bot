import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function apply(db: Database.Database, filename: string): void {
  db.exec(readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
}

describe('migration 199 — training agenda ownership tenant uniqueness', () => {
  it('drops the stale non-tenant unique index while preserving tenant-scoped uniqueness', () => {
    const db = new Database(':memory:');
    try {
      apply(db, '023_fitness_training_plans.sql');
      apply(db, '081_training_agenda_event_ownership.sql');
      apply(db, '082_training_session_identity_shape_hash.sql');
      apply(db, '099_training_agenda_ownership_tenant_scope.sql');
      apply(db, '199_drop_stale_training_agenda_unique_index.sql');

      const indexes = db.prepare('PRAGMA index_list(training_agenda_event_ownership)').all() as Array<{ name: string }>;
      const names = indexes.map((idx) => idx.name);
      expect(names).not.toContain('idx_training_agenda_ownership_unique');
      expect(names).toContain('idx_training_agenda_ownership_unique_tenant');

      const insert = db.prepare(`
        INSERT INTO training_agenda_event_ownership
          (tenant_id, plan_id, plan_version, session_id, user_id, calendar_event_id, calendar_source, status)
        VALUES
          (@tenantId, @planId, 1, NULL, @userId, @eventId, 'google', 'active')
      `);

      insert.run({ tenantId: 1, planId: 10, userId: 1, eventId: 'evt-shared' });
      expect(() => insert.run({ tenantId: 2, planId: 10, userId: 2, eventId: 'evt-shared' })).not.toThrow();
      expect(() => insert.run({ tenantId: 1, planId: 10, userId: 1, eventId: 'evt-shared' })).toThrow();
    } finally {
      db.close();
    }
  });
});
