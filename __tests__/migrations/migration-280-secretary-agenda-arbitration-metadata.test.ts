import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const baseSql = readFileSync(resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql'), 'utf8');
const upSql = readFileSync(resolve(__dirname, '../../migrations/280_secretary_agenda_arbitration_metadata.sql'), 'utf8');
const downSql = readFileSync(resolve(__dirname, '../../migrations/down/280_secretary_agenda_arbitration_metadata.sql'), 'utf8');

function insertLegacyAgendaItem(db: Database.Database): void {
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, intent_action,
      owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
      version, title, decision_action, source_shape_hash, created_at, updated_at
    ) VALUES (
      'agenda-before-rank', 'intent-before-rank', 'training', 'schedule_this',
      42, 'tenant-rank-test', 'scheduled', 'not_synced',
      1, 'Legacy agenda row', 'scheduled', 'shape-before-rank',
      '2026-08-05T08:00:00.000Z', '2026-08-05T08:00:00.000Z'
    )
  `).run();
}

describe('migration 280 secretary agenda arbitration metadata', () => {
  it('adds nullable rank metadata without assigning a preemption rank to legacy rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec(baseSql);
      insertLegacyAgendaItem(db);

      db.exec(upSql);

      const columns = db.pragma('table_info(secretary_agenda_items)') as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      expect(columns.filter(({ name }) => name.startsWith('arbitration_'))).toEqual([
        expect.objectContaining({ name: 'arbitration_score', type: 'INTEGER', notnull: 0 }),
        expect.objectContaining({ name: 'arbitration_deadline_at', type: 'TEXT', notnull: 0 }),
        expect.objectContaining({ name: 'arbitration_flexibility', type: 'TEXT', notnull: 0 }),
        expect.objectContaining({ name: 'arbitration_policy_version', type: 'TEXT', notnull: 0 }),
      ]);

      expect(db.prepare(`
        SELECT arbitration_score AS score,
               arbitration_deadline_at AS deadlineAt,
               arbitration_flexibility AS flexibility,
               arbitration_policy_version AS policyVersion
          FROM secretary_agenda_items
         WHERE agenda_item_id = 'agenda-before-rank'
      `).get()).toEqual({
        score: null,
        deadlineAt: null,
        flexibility: null,
        policyVersion: null,
      });

      const indexColumns = db.prepare(`
        SELECT name
          FROM pragma_index_info('idx_secretary_agenda_arbitration_scope')
         ORDER BY seqno
      `).all() as Array<{ name: string }>;
      expect(indexColumns.map(({ name }) => name)).toEqual([
        'owner_user_id',
        'tenant_id',
        'lifecycle_state',
        'start_at',
        'end_at',
        'arbitration_score',
      ]);

      expect(() => db.prepare(`
        UPDATE secretary_agenda_items
           SET arbitration_flexibility = 'unknown'
         WHERE agenda_item_id = 'agenda-before-rank'
      `).run()).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('reverses the additive metadata without removing legacy agenda rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec(baseSql);
      insertLegacyAgendaItem(db);
      db.exec(upSql);
      db.exec(downSql);

      const columns = db.pragma('table_info(secretary_agenda_items)') as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
        'arbitration_score',
        'arbitration_deadline_at',
        'arbitration_flexibility',
        'arbitration_policy_version',
      ]));
      expect(db.prepare(`
        SELECT agenda_item_id AS agendaItemId
          FROM secretary_agenda_items
         WHERE agenda_item_id = 'agenda-before-rank'
      `).get()).toEqual({ agendaItemId: 'agenda-before-rank' });
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_secretary_agenda_arbitration_scope'
      `).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
