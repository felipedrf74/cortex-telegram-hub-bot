import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import { buildChatActionPlan, executeChatActionPlan } from '../../src/services/chat';
import type { ChatActionPlan, ChatPlanStep } from '../../src/services/chat/types';

const baseInput = {
  text: 'Create task Buy milk and create task Call mom',
  userId: 42,
  tenantId: 42,
  conversationId: 'conv-multi',
  messageId: 'msg-multi',
  channel: 'ios' as const,
  locale: 'en-US',
  timezone: 'Europe/Lisbon',
  nowIso: '2026-05-23T12:00:00+01:00',
  persistRuns: false,
};

function answerStep(stepId: string, text: string, dependsOnStepIds?: string[]): ChatPlanStep {
  return {
    stepId,
    skill: 'tasks',
    type: 'answer',
    action: 'create_task',
    risk: 'read_only',
    riskClass: 'R0',
    provider: 'nexus',
    args: { text },
    requiredArgsPresent: true,
    idempotencyKey: `answer-${stepId}`,
    dependsOnStepIds,
    verification: { required: false, method: 'none' },
  };
}

describe('ChatActionPlanner multi-step DAG', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('turns two safe-write segments into a stable sequential DAG that requires confirmation', async () => {
    const plan = await buildChatActionPlan(baseInput);

    expect(plan).toMatchObject({
      planner: 'mixed',
      requiresConfirmation: true,
      steps: [
        { stepId: 'step_1', skill: 'tasks', action: 'create_task', requiredArgsPresent: true },
        { stepId: 'step_2', skill: 'tasks', action: 'create_task', requiredArgsPresent: true, dependsOnStepIds: ['step_1'] },
      ],
    });
    expect(plan?.debug?.routingSignals).toEqual(expect.arrayContaining([
      'multi_step_splitter',
      'multi_step_dag',
    ]));
  });

  it('requires a preview confirmation for three or more steps', async () => {
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Create task Buy milk, create task Call mom, create task Send invoice',
      messageId: 'msg-three',
    });

    expect(plan?.steps).toHaveLength(3);
    expect(plan?.requiresConfirmation).toBe(true);
  });

  it('emits multi-step result metadata and stops after the first blocked dependency', async () => {
    const sourcePlan: ChatActionPlan = {
      schemaVersion: 1,
      userId: '42',
      tenantId: '42',
      conversationId: 'conv-multi',
      messageId: 'msg-execute',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      channel: 'ios',
      createdAt: '2026-05-23T12:00:00+01:00',
      planner: 'mixed',
      steps: [
        answerStep('step_1', 'first'),
        answerStep('step_2', 'blocked', ['missing_step']),
        answerStep('step_3', 'independent'),
      ],
      requiresConfirmation: false,
      confidence: 0.9,
    };

    const response = await executeChatActionPlan(sourcePlan, {
      ...baseInput,
      text: 'synthetic multi-step execution',
      messageId: 'msg-execute',
    }, {});

    expect(response.metadata.type).toBe('chat_action_multi_step_result');
    expect(response.metadata.actionStatus).toBe('blocked');
    expect(response.metadata.multiStepSummary).toMatchObject({
      totalSteps: 3,
      succeeded: 1,
      blocked: 1,
      perStep: [
        { stepId: 'step_1', status: 'verified_success' },
        { stepId: 'step_2', status: 'blocked', error: 'dependency_failed' },
        { stepId: 'step_3', status: 'pending' },
      ],
    });
  });

  it('resolves task pronouns through step refs before executing dependent mutations', async () => {
    const completeTask = vi.fn(async () => ({ success: true }));
    const getTask = vi.fn(async (_listId: string, taskId: string) => ({
      success: true,
      data: { id: taskId, listId: 'list-1', title: 'Call mom' },
    }));
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Create a task to call mom and then mark that task done',
      messageId: 'msg-pronoun',
    });

    expect(plan?.steps).toMatchObject([
      { stepId: 'step_1', action: 'create_task', requiredArgsPresent: true },
      {
        stepId: 'step_2',
        action: 'complete_task',
        requiredArgsPresent: true,
        args: {
          taskId: { $ref: 'step_1.result.task.id' },
          listId: { $ref: 'step_1.result.task.listId' },
        },
      },
    ]);

    const response = await executeChatActionPlan(plan!, {
      ...baseInput,
      text: 'Create a task to call mom and then mark that task done',
      messageId: 'msg-pronoun',
    }, {
      taskProviderForUser: () => ({
        getLists: vi.fn(async () => ({ data: [{ id: 'list-1', displayName: 'Tasks', wellknownListName: 'defaultList' }] })),
        createTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', listId: 'list-1', title: 'Call mom' } })),
        getTask,
        completeTask,
      }),
    } as never, { confirmed: true });

    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(completeTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(response.metadata.multiStepSummary).toMatchObject({ totalSteps: 2, succeeded: 2 });
  });

  it('requires clarification before executing any multi-step plan with unresolved steps', async () => {
    const sourcePlan: ChatActionPlan = {
      schemaVersion: 1,
      userId: '42',
      tenantId: '42',
      conversationId: 'conv-multi',
      messageId: 'msg-mixed-clarification',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      channel: 'ios',
      createdAt: '2026-05-23T12:00:00+01:00',
      planner: 'mixed',
      steps: [
        answerStep('step_1', 'clear safe action'),
        {
          ...answerStep('step_2', 'missing detail'),
          type: 'set_task_reminder',
          action: 'set_task_reminder',
          risk: 'safe_write',
          args: { taskId: null, reminderAt: null },
          requiredArgsPresent: false,
          verification: { required: true, method: 'local_read_back' },
        },
        answerStep('step_3', 'another clear safe action'),
      ],
      requiresConfirmation: false,
      clarificationQuestion: 'When should I remind you?',
      clarificationReason: 'missing_required_fields',
      confidence: 0.9,
    };

    const response = await executeChatActionPlan(sourcePlan, {
      ...baseInput,
      text: 'synthetic mixed safe-write clarification',
      messageId: 'msg-mixed-clarification',
    }, {});

    expect(response.metadata.actionStatus).toBe('needs_clarification');
    expect(response.text).toBe('When should I remind you?');
    expect(response.metadata.clarification).toMatchObject({ question: 'When should I remind you?' });
    expect(response.metadata.multiStepSummary).toMatchObject({
      totalSteps: 3,
      succeeded: 0,
      needsClarification: 1,
      perStep: [
        { stepId: 'step_1', status: 'pending' },
        { stepId: 'step_2', status: 'pending' },
        { stepId: 'step_3', status: 'pending' },
      ],
    });
  });
});
