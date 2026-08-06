import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const baseSql = readFileSync(resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql'), 'utf8');
const upSql = readFileSync(resolve(__dirname, '../../migrations/281_secretary_provider_target_and_failure_disposition.sql'), 'utf8');
const downSql = readFileSync(resolve(__dirname, '../../migrations/down/281_secretary_provider_target_and_failure_disposition.sql'), 'utf8');

function insertAgenda(db: Database.Database, input: { id: string; providerSource?: 'google' | 'outlook' }): void {
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, intent_action,
      owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
      provider_event_id, provider_source, version, title, decision_action,
      source_shape_hash, created_at, updated_at
    ) VALUES (?, ?, 'cooking', 'schedule_this', 42, 'tenant-cooking',
      'scheduled', ?, ?, ?, 1, 'Meal prep', 'scheduled', ?, ?, ?)
  `).run(
    input.id,
    `intent-${input.id}`,
    input.providerSource ? 'synced' : 'not_synced',
    input.providerSource ? `event-${input.id}` : null,
    input.providerSource ?? null,
    `shape-${input.id}`,
    '2026-08-05T08:00:00.000Z',
    '2026-08-05T08:00:00.000Z',
  );
}

describe('migration 281 Secretary provider target', () => {
  it('backfills only authoritative mappings and validates target/disposition values', () => {
    const db = new Database(':memory:');
    try {
      db.exec(baseSql);
      insertAgenda(db, { id: 'mapped', providerSource: 'outlook' });
      insertAgenda(db, { id: 'unowned' });
      db.exec(upSql);

      expect(db.prepare(`
        SELECT agenda_item_id AS id, provider_target AS target
          FROM secretary_agenda_items ORDER BY agenda_item_id
      `).all()).toEqual([
        { id: 'mapped', target: 'outlook' },
        { id: 'unowned', target: null },
      ]);
      expect(() => db.prepare(`
        UPDATE secretary_agenda_items SET provider_target = 'apple' WHERE agenda_item_id = 'unowned'
      `).run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`
        UPDATE secretary_agenda_items
           SET provider_sync_failure_disposition = 'unknown'
         WHERE agenda_item_id = 'unowned'
      `).run()).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('reverses the additive columns without removing agenda rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec(baseSql);
      insertAgenda(db, { id: 'legacy' });
      db.exec(upSql);
      db.exec(downSql);
      const columns = db.pragma('table_info(secretary_agenda_items)') as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
        'provider_target',
        'provider_sync_failure_disposition',
        'provider_sync_retry_after_at',
      ]));
      expect(db.prepare(`SELECT agenda_item_id AS id FROM secretary_agenda_items`).get()).toEqual({ id: 'legacy' });
    } finally {
      db.close();
    }
  });
});
