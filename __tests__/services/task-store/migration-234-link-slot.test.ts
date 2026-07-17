/**
 * Tests for migrations/234_task_link_active_slot_unique.sql
 *
 * Covers:
 *   - the partial unique index over ACTIVE (tenant, user, task, provider,
 *     account) link slots exists after a full migration run
 *   - the index rejects a second active link in the same slot (duplicate
 *     class R1-b: pending-create link + imported link for one provider)
 *     while orphaned history rows and other providers stay allowed
 *   - the migration's cleanup orphans the worse duplicate per slot before
 *     the index is created: non-NULL provider_task_id wins, then latest
 *     updated_at, then highest id as a deterministic tie-break
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';
import { applyMigrationFile } from '../../../src/services/migration-runner';

const MIGRATION_234 = '234_task_link_active_slot_unique.sql';
const USER_ID = 42;

function insertLink(db: Database.Database, opts: {
  id: string;
  taskId: string;
  providerTaskId: string | null;
  provider?: string;
  account?: string;
  linkState?: string;
  updatedAt?: string;
}): void {
  db.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, ownership, link_state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'nexus_created', ?, ?, ?)`,
  ).run(
    opts.id,
    opts.taskId,
    USER_ID,
    USER_ID,
    opts.provider ?? 'ms_todo',
    opts.account ?? `${opts.provider ?? 'ms_todo'}:${USER_ID}`,
    opts.providerTaskId,
    opts.linkState ?? 'linked',
    opts.updatedAt ?? '2026-07-01 00:00:00',
    opts.updatedAt ?? '2026-07-01 00:00:00',
  );
}

function getActiveSlotIndex(db: Database.Database): { sql: string } | undefined {
  return db.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_task_provider_links_active_slot'`,
  ).get() as { sql: string } | undefined;
}

describe('migration 234 task link active slot unique', () => {
  it('creates the partial unique index over active link slots', () => {
    const db = createMigratedTestDatabase();
    try {
      const index = getActiveSlotIndex(db);
      expect(index).toBeTruthy();
      expect(index!.sql).toContain("WHERE link_state NOT IN ('orphaned')");
    } finally {
      db.close();
    }
  });

  it('rejects a second active link in the same slot but allows orphans and other providers', () => {
    const db = createMigratedTestDatabase();
    try {
      // The R1-b shape: a pending-create link with no provider id yet plus an
      // imported link for the same provider slot.
      insertLink(db, {
        id: 'link_slot_pending', taskId: 'task_slot', providerTaskId: null, linkState: 'pending_create',
      });
      // The violated constraint is the active-slot index: its column list
      // ends at provider_account_id (the legacy table UNIQUE also spans
      // provider_task_id, which differs between these two rows).
      expect(() => insertLink(db, {
        id: 'link_slot_imported', taskId: 'task_slot', providerTaskId: 'MS-G1',
      })).toThrow(
        /UNIQUE constraint failed: task_provider_links\.tenant_id, task_provider_links\.user_id, task_provider_links\.task_id, task_provider_links\.provider, task_provider_links\.provider_account_id$/,
      );

      // Orphaned history rows do not block the slot.
      expect(() => insertLink(db, {
        id: 'link_slot_orphan', taskId: 'task_slot', providerTaskId: 'MS-G2', linkState: 'orphaned',
      })).not.toThrow();

      // A different provider is a different slot.
      expect(() => insertLink(db, {
        id: 'link_slot_todoist', taskId: 'task_slot', providerTaskId: 'TD-1', provider: 'todoist',
      })).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('orphans the worse duplicate per active slot before creating the index', () => {
    const db = createMigratedTestDatabase({ stopBefore: MIGRATION_234 });
    try {
      expect(getActiveSlotIndex(db)).toBeUndefined();

      // Slot A: prefer the link that knows its provider_task_id, even when
      // the NULL twin is more recently updated.
      insertLink(db, {
        id: 'link_a_keep', taskId: 'task_a', providerTaskId: 'MS-A1', updatedAt: '2026-07-01 00:00:00',
      });
      insertLink(db, {
        id: 'link_a_lose', taskId: 'task_a', providerTaskId: null, linkState: 'pending_create', updatedAt: '2026-07-02 00:00:00',
      });
      // Slot B: same NULL-ness, latest updated_at wins.
      insertLink(db, {
        id: 'link_b_lose', taskId: 'task_b', providerTaskId: 'MS-B1', updatedAt: '2026-07-01 00:00:00',
      });
      insertLink(db, {
        id: 'link_b_keep', taskId: 'task_b', providerTaskId: 'MS-B2', updatedAt: '2026-07-03 00:00:00',
      });
      // Slot C: full tie, highest id wins deterministically.
      insertLink(db, {
        id: 'link_c1', taskId: 'task_c', providerTaskId: null, linkState: 'pending_create', updatedAt: '2026-07-01 00:00:00',
      });
      insertLink(db, {
        id: 'link_c2', taskId: 'task_c', providerTaskId: null, linkState: 'pending_update', updatedAt: '2026-07-01 00:00:00',
      });
      // Untouched: a single active link plus an already-orphaned twin that
      // must neither block the keeper nor be revived.
      insertLink(db, {
        id: 'link_d_only', taskId: 'task_d', providerTaskId: 'MS-D1',
      });
      insertLink(db, {
        id: 'link_d_orphan', taskId: 'task_d', providerTaskId: 'MS-D0', linkState: 'orphaned', updatedAt: '2026-07-09 00:00:00',
      });

      applyMigrationFile(db, MIGRATION_234);

      const states = Object.fromEntries(
        (db.prepare('SELECT id, link_state FROM task_provider_links').all() as Array<{ id: string; link_state: string }>)
          .map((row) => [row.id, row.link_state]),
      );
      expect(states).toEqual({
        link_a_keep: 'linked',
        link_a_lose: 'orphaned',
        link_b_lose: 'orphaned',
        link_b_keep: 'linked',
        link_c1: 'orphaned',
        link_c2: 'pending_update',
        link_d_only: 'linked',
        link_d_orphan: 'orphaned',
      });
      expect(getActiveSlotIndex(db)).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
