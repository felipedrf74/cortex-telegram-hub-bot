// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../helpers/apply-migrations';
import {
  getProviderAwarePendingTodoTasks,
  getProviderAwareTaskReadModel,
  getProviderAwareTodoTasksDueInRange,
} from '../../../src/services/task-store/provider-aware-read-model';

let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

describe('provider-aware task read model', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id, auth_provider) VALUES (?, ?, ?)').run(42, 42, 'ios');
    testDb.prepare('INSERT OR IGNORE INTO native_task_lists (user_id, name, is_default) VALUES (?, ?, 1)').run(42, 'Inbox');
  });

  afterEach(() => {
    testDb.close();
  });

  it('shows chat-created native tasks and synced unified tasks in one read model', async () => {
    const listId = (testDb.prepare('SELECT id FROM native_task_lists WHERE user_id = ?').get(42) as { id: number }).id;
    testDb.prepare(`
      INSERT INTO native_tasks (user_id, list_id, title, status, due_date_time, importance)
      VALUES (?, ?, ?, 'notStarted', ?, 'normal')
    `).run(42, listId, 'comprar suplementos', '2026-05-31');
    testDb.prepare(`
      INSERT INTO unified_tasks (user_id, provider, external_id, title, status, priority, due_date, project_name)
      VALUES (?, 'todoist', 'todoist-1', ?, 'pending', 3, ?, 'Todoist')
    `).run(42, 'Rever briefing', '2026-05-31');

    const tasks = await getProviderAwareTaskReadModel(42);

    expect(tasks.map((task) => `${task.provider}:${task.title}`).sort()).toEqual([
      'nexus:comprar suplementos',
      'todoist:Rever briefing',
    ]);
  });

  it('dedupes native rows over stale unified nexus projections', async () => {
    const listId = (testDb.prepare('SELECT id FROM native_task_lists WHERE user_id = ?').get(42) as { id: number }).id;
    testDb.prepare(`
      INSERT INTO native_tasks (id, user_id, list_id, title, status, importance)
      VALUES (?, ?, ?, ?, 'notStarted', 'normal')
    `).run(9, 42, listId, 'Native fresh title');
    testDb.prepare(`
      INSERT INTO unified_tasks (user_id, provider, external_id, title, status, priority, project_name)
      VALUES (?, 'nexus', '9', ?, 'pending', 2, 'Inbox')
    `).run(42, 'Stale projected title');

    const tasks = await getProviderAwareTaskReadModel(42);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      provider: 'nexus',
      externalId: '9',
      title: 'Native fresh title',
    });
  });

  it('provides Microsoft To Do shaped pending and date-range results for fast reads', async () => {
    const listId = (testDb.prepare('SELECT id FROM native_task_lists WHERE user_id = ?').get(42) as { id: number }).id;
    testDb.prepare(`
      INSERT INTO native_tasks (user_id, list_id, title, status, due_date_time, importance)
      VALUES (?, ?, ?, 'notStarted', ?, 'high')
    `).run(42, listId, 'Suplemento matinal', '2026-05-31T09:00:00');
    testDb.prepare(`
      INSERT INTO unified_tasks (user_id, provider, external_id, title, status, priority, due_date, project_name)
      VALUES (?, 'ms_todo', 'ms-1', ?, 'completed', 2, ?, 'Tasks')
    `).run(42, 'Completed elsewhere', '2026-05-31');

    const pending = await getProviderAwarePendingTodoTasks(42);
    const dueToday = await getProviderAwareTodoTasksDueInRange(42, '2026-05-31T00:00:00', '2026-05-31T23:59:59');

    expect(pending.success).toBe(true);
    expect(pending.data.map((task) => task.title)).toEqual(['Suplemento matinal']);
    expect(dueToday.success).toBe(true);
    expect(dueToday.data).toEqual([
      expect.objectContaining({
        title: 'Suplemento matinal',
        importance: 'high',
        status: 'notStarted',
      }),
    ]);
  });
});
