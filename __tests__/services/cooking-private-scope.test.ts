import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  cookingPrivateScopePredicate,
  cookingScopeParams,
} from '../../src/services/cooking-tenant-scope';

describe('cooking private scope predicate', () => {
  it('admits only active user-private tenant-owned and user-owned rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE scoped_items (
          id INTEGER PRIMARY KEY,
          scope_status TEXT NOT NULL,
          visibility_scope TEXT NOT NULL,
          tenant_id INTEGER NOT NULL,
          owner_user_id INTEGER NOT NULL
        );
        INSERT INTO scoped_items VALUES
          (1, 'active',   'user_private', 70, 7),
          (2, 'archived', 'user_private', 70, 7),
          (3, 'active',   'tenant_shared', 70, 7),
          (4, 'active',   'user_private', 71, 7),
          (5, 'active',   'user_private', 70, 8);
      `);

      const rows = db.prepare(`
        SELECT id
        FROM scoped_items
        WHERE ${cookingPrivateScopePredicate()}
        ORDER BY id
      `).all(...cookingScopeParams(7, 70)) as Array<{ id: number }>;

      expect(rows.map(({ id }) => id)).toEqual([1]);
    } finally {
      db.close();
    }
  });
});
