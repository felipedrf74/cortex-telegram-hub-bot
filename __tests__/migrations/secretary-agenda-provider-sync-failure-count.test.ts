import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function apply(db: Database.Database, filename: string): void {
  db.exec(readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
}

describe('migration 220 — secretary agenda provider sync failure count', () => {
  it('adds the counter with a zero default for existing rows', () => {
    const db = new Database(':memory:');
    try {
      apply(db, '083_secretary_agenda_ledger.sql');

      db.prepare(`
        INSERT INTO secretary_agenda_items (
          agenda_item_id, source_intent_id, source_skill, intent_action,
          owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
          version, title, decision_action, source_shape_hash
          , created_at, updated_at
        ) VALUES (
          'agenda-legacy', 'intent-legacy', 'training', 'schedule_this',
          74, 'tenant-legacy', 'scheduled', 'not_synced',
          1, 'Legacy row', 'scheduled', 'hash-legacy',
          '2026-06-01T10:00:00.000Z', '2026-06-01T10:00:00.000Z'
        )
      `).run();

      apply(db, '220_secretary_agenda_provider_sync_failure_count.sql');

      const columns = db.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('provider_sync_failure_count');

      const legacy = db.prepare(
        "SELECT provider_sync_failure_count FROM secretary_agenda_items WHERE agenda_item_id = 'agenda-legacy'",
      ).get() as { provider_sync_failure_count: number };
      expect(legacy.provider_sync_failure_count).toBe(0);
    } finally {
      db.close();
    }
  });
});
