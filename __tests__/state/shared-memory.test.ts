import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  applySharedMemoryCorrection,
  getSharedMemory,
  getSharedMemoryByScope,
  setSharedMemory,
} from '../../src/state/shared-memory';

function createSharedMemoryTable(): void {
  testDb.exec(`
    CREATE TABLE shared_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL DEFAULT 0,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source_domain TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, key)
    );
  `);
}

describe('shared-memory scoped Chat memory', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSharedMemoryTable();
  });

  it('updates scoped memory when the user corrects a prior preference', () => {
    setSharedMemory(7, 'workout_preference', 'before work', 'triathlon', undefined, 10);

    const entry = applySharedMemoryCorrection({
      userId: 7,
      tenantId: 10,
      key: 'workout_preference',
      correctedValue: 'after work',
      sourceDomain: 'triathlon',
    });

    expect(entry.value).toBe('after work');
    expect(getSharedMemory(7, 'workout_preference', 10)).toEqual([
      expect.objectContaining({ value: 'after work', tenant_id: 10, user_id: 7 }),
    ]);
  });

  it('partitions memory by tenant during tenant switches', () => {
    setSharedMemory(7, 'content_workflow', 'Tenant A launch workflow', 'content', undefined, 10);
    setSharedMemory(7, 'content_workflow', 'Tenant B support workflow', 'content', undefined, 11);

    expect(getSharedMemory(7, 'content_workflow', 10)[0].value).toBe('Tenant A launch workflow');
    expect(getSharedMemory(7, 'content_workflow', 11)[0].value).toBe('Tenant B support workflow');
  });

  it('separates user-private and tenant-shared memory buckets without exposing other users', () => {
    setSharedMemory(7, 'private_preference', 'protect mornings', 'secretary', undefined, 10, 'user_private');
    setSharedMemory(7, 'shared_deadline', 'launch review Thursday', 'content', undefined, 10, 'tenant_shared');
    setSharedMemory(8, 'shared_deadline', 'other user secret', 'content', undefined, 10, 'tenant_shared');

    const buckets = getSharedMemoryByScope(7, 10);

    expect(buckets.userPrivate).toEqual([
      expect.objectContaining({ key: 'private_preference', value: 'protect mornings' }),
    ]);
    expect(buckets.tenantShared).toEqual([
      expect.objectContaining({ key: 'shared_deadline', value: 'launch review Thursday' }),
    ]);
    expect([...buckets.userPrivate, ...buckets.tenantShared].map((entry) => entry.value)).not.toContain('other user secret');
  });

  it('rejects unsafe memory values instead of storing secrets', () => {
    expect(() => setSharedMemory(
      7,
      'provider_token',
      'refresh_token=secret-refresh-token',
      'secretary',
      undefined,
      10,
    )).toThrow(/CHAT_MEMORY_UNSAFE/);

    expect(getSharedMemory(7, undefined, 10)).toEqual([]);
  });
});
