import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  executeChatReasoningFrame,
  expireStaleChatActionPlans,
  parseDeterministicActionFrame,
} from '../../src/services/chat-reasoning-engine';

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE chat_action_plans (
      action_plan_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      source_message_id TEXT NOT NULL,
      client_request_id TEXT,
      status TEXT NOT NULL,
      frame_json TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      created_entity_refs_json TEXT NOT NULL DEFAULT '[]',
      rollback_token TEXT,
      correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );
    CREATE UNIQUE INDEX idx_chat_action_plans_message
      ON chat_action_plans (tenant_id, user_id, source_message_id);
  `);
}

describe('Chat Reasoning Engine persistence and retry safety', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    setupSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('resumes an executing action plan without creating a duplicate provider task', async () => {
    const frame = parseDeterministicActionFrame('Create task Prozis with subtasks creatine K2 D3')!;
    testDb.prepare(`
      INSERT INTO chat_action_plans (
        action_plan_id, tenant_id, user_id, source_message_id, status,
        frame_json, steps_json, created_entity_refs_json, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))
    `).run(
      'cap-existing',
      9001,
      7001,
      'msg-retry-after-crash',
      'executing',
      JSON.stringify(frame),
      JSON.stringify(frame.steps),
      JSON.stringify([{ entityType: 'task', entityId: 'task-1', listId: 'list-1', title: 'Prozis' }]),
    );

    const checklistItems = [{ id: 'ci-1', displayName: 'creatine', isChecked: false }];
    const provider = {
      createTask: vi.fn(),
      getTask: vi.fn(async () => ({
        success: true,
        data: { id: 'task-1', listId: 'list-1', title: 'Prozis', checklistItems },
      })),
      getChecklistItems: vi.fn(async () => ({ success: true, data: checklistItems })),
      addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => {
        const item = { id: `ci-${checklistItems.length + 1}`, displayName, isChecked: false };
        checklistItems.push(item);
        return { success: true, data: item };
      }),
    };

    const result = await executeChatReasoningFrame({
      text: 'Create task Prozis with subtasks creatine K2 D3',
      userId: 7001,
      tenantId: 9001,
      sourceMessageId: 'msg-retry-after-crash',
      frame,
      provider,
    });

    expect(provider.createTask).not.toHaveBeenCalled();
    expect(provider.addChecklistItem).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    expect(result.response.metadata).toMatchObject({
      actionPlanId: 'cap-existing',
      idempotentReplay: true,
      verificationStatus: 'verified',
    });
    expect(testDb.prepare('SELECT status FROM chat_action_plans WHERE action_plan_id = ?').get('cap-existing')).toMatchObject({
      status: 'completed',
    });
  });

  it('fails closed when an executing retry has no saved task reference', async () => {
    const frame = parseDeterministicActionFrame('Create task Prozis with subtasks creatine K2 D3')!;
    testDb.prepare(`
      INSERT INTO chat_action_plans (
        action_plan_id, tenant_id, user_id, source_message_id, status,
        frame_json, steps_json, created_entity_refs_json, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))
    `).run(
      'cap-no-ref',
      9001,
      7001,
      'msg-in-flight-no-ref',
      'executing',
      JSON.stringify(frame),
      JSON.stringify(frame.steps),
      '[]',
    );
    const provider = { createTask: vi.fn(), addChecklistItem: vi.fn() };

    const result = await executeChatReasoningFrame({
      text: 'Create task Prozis with subtasks creatine K2 D3',
      userId: 7001,
      tenantId: 9001,
      sourceMessageId: 'msg-in-flight-no-ref',
      frame,
      provider,
    });

    expect(provider.createTask).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'in_progress',
      response: {
        metadata: {
          type: 'chat_action_in_progress',
          idempotentReplay: true,
        },
      },
    });
  });

  it('scopes action-plan idempotency by tenant and user', async () => {
    const frame = parseDeterministicActionFrame('Create task Prozis with subtasks creatine K2 D3')!;
    const makeProvider = (taskId: string) => {
      const checklistItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
      return {
        getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Inbox', wellknownListName: 'defaultList' }] })),
        createTask: vi.fn(async (_listId: string, _listName: string, data: any) => ({
          success: true,
          data: { id: taskId, listId: 'list-1', title: data.title },
        })),
        addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => {
          const item = { id: `${taskId}-ci-${checklistItems.length + 1}`, displayName, isChecked: false };
          checklistItems.push(item);
          return { success: true, data: item };
        }),
        getTask: vi.fn(async () => ({ success: true, data: { id: taskId, listId: 'list-1', title: 'Prozis', checklistItems } })),
        getChecklistItems: vi.fn(async () => ({ success: true, data: checklistItems })),
      };
    };

    await executeChatReasoningFrame({
      text: 'Create task Prozis with subtasks creatine K2 D3',
      userId: 7001,
      tenantId: 9001,
      sourceMessageId: 'msg-same-source',
      frame,
      provider: makeProvider('task-a'),
    });
    await executeChatReasoningFrame({
      text: 'Create task Prozis with subtasks creatine K2 D3',
      userId: 7001,
      tenantId: 9002,
      sourceMessageId: 'msg-same-source',
      frame,
      provider: makeProvider('task-b'),
    });

    const rows = testDb.prepare(`
      SELECT tenant_id, user_id, source_message_id, status
      FROM chat_action_plans
      ORDER BY tenant_id ASC
    `).all();
    expect(rows).toEqual([
      { tenant_id: 9001, user_id: 7001, source_message_id: 'msg-same-source', status: 'completed' },
      { tenant_id: 9002, user_id: 7001, source_message_id: 'msg-same-source', status: 'completed' },
    ]);
  });

  it('expires stale pending plans', () => {
    testDb.prepare(`
      INSERT INTO chat_action_plans (
        action_plan_id, tenant_id, user_id, source_message_id, status,
        frame_json, steps_json, created_entity_refs_json, expires_at
      ) VALUES
        ('cap-old', 9001, 7001, 'old', 'executing', '{}', '[]', '[]', datetime('now', '-1 day')),
        ('cap-done', 9001, 7001, 'done', 'completed', '{}', '[]', '[]', datetime('now', '-1 day'))
    `).run();

    expect(expireStaleChatActionPlans()).toBe(1);
    expect(testDb.prepare('SELECT status FROM chat_action_plans WHERE action_plan_id = ?').get('cap-old')).toMatchObject({
      status: 'expired',
    });
    expect(testDb.prepare('SELECT status FROM chat_action_plans WHERE action_plan_id = ?').get('cap-done')).toMatchObject({
      status: 'completed',
    });
  });
});
