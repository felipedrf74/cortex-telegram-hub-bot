// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { upsertTask } from '../../../src/services/task-store/unified-task-store';
import {
  applyTaskDisconnectPolicy,
  normalizeTaskDisconnectPolicy,
  taskProviderForConnection,
} from '../../../src/services/task-store/task-disconnect-policy';
import type { NormalizedTask } from '../../../src/services/task-store/types';

const USER = 8;

function importProviderTask(externalId: string, listId = 'listA', title = `Imported ${externalId}`): void {
  const task: NormalizedTask = {
    provider: 'ms_todo',
    externalId,
    title,
    status: 'pending',
    priority: 0,
    providerData: { listId },
  };
  upsertTask(USER, task);
}

/** A Nexus-created task that was pushed OUT to the provider (row.provider='nexus'). */
function seedNexusSyncedTask(externalId: string): string {
  const nexusTaskId = `task_nexus_${externalId}`;
  testDb.prepare(
    `INSERT INTO unified_tasks (user_id, tenant_id, provider, external_id, title, status, priority, nexus_task_id, sync_state, source_of_truth)
     VALUES (?, ?, 'nexus', ?, ?, 'pending', 0, ?, 'synced', 'nexus')`,
  ).run(USER, USER, externalId, `Nexus ${externalId}`, nexusTaskId);
  testDb.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, ownership, link_state
     ) VALUES (?, ?, ?, ?, 'ms_todo', 'ms_todo:8', ?, 'listA', 'provider_imported', 'linked')`,
  ).run(`link_${externalId}`, nexusTaskId, USER, USER, `ms_${externalId}`);
  return nexusTaskId;
}

function taskRow(externalId: string): { is_deleted: number; sync_state: string } {
  return testDb.prepare(
    `SELECT is_deleted, sync_state FROM unified_tasks WHERE user_id = ? AND external_id = ?`,
  ).get(USER, externalId) as { is_deleted: number; sync_state: string };
}

function activeLinkCount(taskId: string): number {
  const row = testDb.prepare(
    `SELECT COUNT(*) AS count FROM task_provider_links
     WHERE user_id = ? AND task_id = ? AND link_state NOT IN ('orphaned')`,
  ).get(USER, taskId) as { count: number };
  return row.count;
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER, USER);
});

afterEach(() => {
  testDb.close();
});

describe('normalizeTaskDisconnectPolicy + taskProviderForConnection', () => {
  it('defaults empty policy to keep and rejects unknown', () => {
    expect(normalizeTaskDisconnectPolicy(undefined)).toBe('keep');
    expect(normalizeTaskDisconnectPolicy('')).toBe('keep');
    expect(normalizeTaskDisconnectPolicy('archive')).toBe('archive');
    expect(normalizeTaskDisconnectPolicy('REMOVE')).toBe('remove');
    expect(normalizeTaskDisconnectPolicy('nuke')).toBeNull();
    expect(normalizeTaskDisconnectPolicy(3)).toBeNull();
  });

  it('maps connection providers to task providers', () => {
    expect(taskProviderForConnection('outlook')).toBe('ms_todo');
    expect(taskProviderForConnection('todoist')).toBe('todoist');
    expect(taskProviderForConnection('notion')).toBe('notion');
    expect(taskProviderForConnection('google')).toBeNull();
  });
});

describe('applyTaskDisconnectPolicy', () => {
  it('keep is a no-op with zeroed counts and leaves the link active', () => {
    importProviderTask('ext1');
    const counts = applyTaskDisconnectPolicy({ tenantId: USER, userId: USER, provider: 'ms_todo', policy: 'keep' });
    expect(counts).toEqual({ archivedCount: 0, removedCount: 0, keptLocalCount: 0 });
    expect(taskRow('ext1')).toEqual({ is_deleted: 0, sync_state: 'synced' });
    const imported = testDb.prepare(
      `SELECT nexus_task_id FROM unified_tasks WHERE user_id = ? AND external_id = 'ext1'`,
    ).get(USER) as { nexus_task_id: string };
    expect(activeLinkCount(imported.nexus_task_id)).toBe(1);
  });

  it('archive converts provider imports to local-only and keeps nexus-synced rows local', () => {
    importProviderTask('ext1');
    const nexusTaskId = seedNexusSyncedTask('n1');

    const counts = applyTaskDisconnectPolicy({ tenantId: USER, userId: USER, provider: 'ms_todo', policy: 'archive' });

    expect(counts).toEqual({ archivedCount: 1, removedCount: 0, keptLocalCount: 1 });
    // Provider import kept, now local-only.
    expect(taskRow('ext1')).toEqual({ is_deleted: 0, sync_state: 'local_only' });
    // Nexus-origin synced row kept, now local-only.
    expect(taskRow('n1')).toEqual({ is_deleted: 0, sync_state: 'local_only' });
    // Both links orphaned (no active links remain).
    expect(activeLinkCount(nexusTaskId)).toBe(0);
    const importedTaskId = testDb.prepare(
      `SELECT nexus_task_id FROM unified_tasks WHERE user_id = ? AND external_id = 'ext1'`,
    ).get(USER) as { nexus_task_id: string };
    expect(activeLinkCount(importedTaskId.nexus_task_id)).toBe(0);
  });

  it('remove soft-deletes provider-origin imports but keeps nexus-synced rows local', () => {
    importProviderTask('ext1');
    seedNexusSyncedTask('n1');

    const counts = applyTaskDisconnectPolicy({ tenantId: USER, userId: USER, provider: 'ms_todo', policy: 'remove' });

    expect(counts).toEqual({ archivedCount: 0, removedCount: 1, keptLocalCount: 1 });
    // Provider import removed (tombstoned).
    expect(taskRow('ext1')).toEqual({ is_deleted: 1, sync_state: 'local_only' });
    // Nexus-origin synced row kept local.
    expect(taskRow('n1')).toEqual({ is_deleted: 0, sync_state: 'local_only' });
  });

  it('surrenders provider ids on orphaned links (M4 invariant)', () => {
    importProviderTask('ext1');
    applyTaskDisconnectPolicy({ tenantId: USER, userId: USER, provider: 'ms_todo', policy: 'archive' });
    const link = testDb.prepare(
      `SELECT link_state, provider_task_id FROM task_provider_links WHERE user_id = ? AND provider = 'ms_todo' LIMIT 1`,
    ).get(USER) as { link_state: string; provider_task_id: string | null };
    expect(link.link_state).toBe('orphaned');
    expect(link.provider_task_id).toBeNull();
  });

  it('is idempotent — a second call finds nothing to do', () => {
    importProviderTask('ext1');
    applyTaskDisconnectPolicy({ tenantId: USER, userId: USER, provider: 'ms_todo', policy: 'archive' });
    const second = applyTaskDisconnectPolicy({ tenantId: USER, userId: USER, provider: 'ms_todo', policy: 'archive' });
    expect(second).toEqual({ archivedCount: 0, removedCount: 0, keptLocalCount: 0 });
  });

  it('reconnect re-imports an archived provider row without creating a twin', () => {
    importProviderTask('ext1');
    applyTaskDisconnectPolicy({ tenantId: USER, userId: USER, provider: 'ms_todo', policy: 'archive' });
    expect(taskRow('ext1').sync_state).toBe('local_only');

    // Reconnect + re-import the same provider task (with a provider-side edit).
    importProviderTask('ext1', 'listA', 'Imported ext1 (edited upstream)');

    const rows = testDb.prepare(
      `SELECT id, nexus_task_id, sync_state FROM unified_tasks
       WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'ext1' AND is_deleted = 0`,
    ).all(USER) as Array<{ id: number; nexus_task_id: string; sync_state: string }>;
    // Exactly one live row — re-linked in place, no duplicate twin.
    expect(rows).toHaveLength(1);
    expect(rows[0].sync_state).toBe('synced');
    expect(activeLinkCount(rows[0].nexus_task_id)).toBe(1);
  });
});
