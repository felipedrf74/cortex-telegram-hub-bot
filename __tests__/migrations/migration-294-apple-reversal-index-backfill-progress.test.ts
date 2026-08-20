import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migration = (name: string): string => readFileSync(
  resolve(__dirname, `../../migrations/${name}.sql`),
  'utf8',
);
const downMigration = (name: string): string => readFileSync(
  resolve(__dirname, `../../migrations/down/${name}.sql`),
  'utf8',
);

const inboxSql = migration('286_apple_notification_inbox');
const reversalIndexSql = migration('292_apple_reversal_transaction_index');
const upSql = migration('294_apple_reversal_index_backfill_progress');
const downSql = downMigration('294_apple_reversal_index_backfill_progress');

function createPre294Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec(inboxSql);
  db.prepare(`INSERT INTO apple_notification_inbox
    (notification_uuid, notification_type, signed_payload, state, attempts, received_at)
    VALUES ('legacy-refund', 'REFUND', 'signed-legacy-refund', 'failed', 5,
            '2026-08-18T00:00:00.000Z')`).run();
  db.exec(reversalIndexSql);
  return db;
}

describe('migration 294 Apple reversal-index backfill progress', () => {
  it('adds zeroed progress metadata and the bounded selection index', () => {
    const db = createPre294Db();
    try {
      db.exec(upSql);

      expect(db.prepare(`SELECT reversal_index_attempts AS attempts
                           FROM apple_notification_inbox
                          WHERE notification_uuid = 'legacy-refund'`).get())
        .toEqual({ attempts: 0 });
      expect((db.pragma('table_info(apple_notification_inbox)') as Array<{ name: string }>))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'reversal_index_attempts' })]));
      expect(db.prepare(`SELECT name FROM sqlite_master
                          WHERE type = 'index'
                            AND name IN (
                              'idx_apple_inbox_reversal_backfill_due',
                              'idx_apple_inbox_reversal_identity_missing_due'
                            ) ORDER BY name`).all())
        .toEqual([
          { name: 'idx_apple_inbox_reversal_backfill_due' },
          { name: 'idx_apple_inbox_reversal_identity_missing_due' },
        ]);
    } finally {
      db.close();
    }
  });

  it('preserves predecessor writes after expansion and reverses without data loss', () => {
    const db = createPre294Db();
    try {
      db.exec(upSql);
      // Exact shape of the migration-292 predecessor write: it neither knows
      // nor updates reversal_index_attempts.
      db.prepare(`UPDATE apple_notification_inbox
                     SET reversal_transaction_id = ?,
                         reversal_original_transaction_id = ?,
                         reversal_indexed_at = ?
                   WHERE notification_uuid = 'legacy-refund'`)
        .run('tx-legacy', null, '2026-08-20T00:00:00.000Z');
      expect(db.prepare(`SELECT reversal_transaction_id AS transactionId,
                                reversal_index_attempts AS attempts
                           FROM apple_notification_inbox
                          WHERE notification_uuid = 'legacy-refund'`).get())
        .toEqual({ transactionId: 'tx-legacy', attempts: 0 });

      db.exec(downSql);
      const columns = db.pragma('table_info(apple_notification_inbox)') as Array<{ name: string }>;
      expect(columns.some(({ name }) => name === 'reversal_index_attempts')).toBe(false);
      expect(db.prepare(`SELECT signed_payload AS signedPayload,
                                reversal_transaction_id AS transactionId
                           FROM apple_notification_inbox
                          WHERE notification_uuid = 'legacy-refund'`).get())
        .toEqual({ signedPayload: 'signed-legacy-refund', transactionId: 'tx-legacy' });
    } finally {
      db.close();
    }
  });

  it('serves both bounded due-row buckets without a temporary corpus sort', () => {
    const db = createPre294Db();
    try {
      db.exec(upSql);
      const cases = [
        {
          expectedIndex: 'idx_apple_inbox_reversal_backfill_due',
          predicate: 'reversal_indexed_at IS NULL',
        },
        {
          expectedIndex: 'idx_apple_inbox_reversal_identity_missing_due',
          predicate: '(reversal_transaction_id IS NULL AND reversal_original_transaction_id IS NULL)',
        },
      ];
      for (const { expectedIndex, predicate } of cases) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN
          SELECT id, signed_payload, reversal_index_attempts
            FROM apple_notification_inbox
           WHERE notification_type = ?
             AND ${predicate}
             AND reversal_index_attempts < ?
           ORDER BY reversal_index_attempts ASC, id ASC
           LIMIT ?`).all('REFUND', 3, 500) as Array<{ detail: string }>;
        const detail = plan.map((row) => row.detail).join('\n');
        expect(detail).toContain(expectedIndex);
        expect(detail).not.toContain('USE TEMP B-TREE');
      }
    } finally {
      db.close();
    }
  });
});
