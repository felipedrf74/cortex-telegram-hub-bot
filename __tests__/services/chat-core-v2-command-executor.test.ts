import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeChatCoreV2Command,
} from '../../src/services/chat-core-v2';
import { getDb } from '../../src/services/database';
import { recordChatV2CommandEvent } from '../../src/services/chat-core-v2/command-events';
import { computeContentHash } from '../../src/services/task-store/unified-task-store';
import type { AICommandEnvelope } from '../../src/services/chat-core-v2/types';

const mockInvalidateTaskCaches = vi.hoisted(() => vi.fn());
const mockTaskProvider = vi.hoisted(() => ({
  createTask: vi.fn(),
  getTask: vi.fn(),
}));
const mockResolveTaskCreationList = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../src/services/chat-core-v2/command-events', () => ({
  recordChatV2CommandEvent: vi.fn(),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidateTaskCaches: (...args: unknown[]) => mockInvalidateTaskCaches(...args),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: vi.fn(() => mockTaskProvider),
}));

vi.mock('../../src/services/task-store/task-list-resolution', () => ({
  resolveTaskCreationList: (...args: unknown[]) => mockResolveTaskCreationList(...args),
}));

const NOW = new Date('2026-05-27T16:45:00.000Z');

const NATIVE_TASK_FOR_HASH = {
  id: 303,
  provider: 'nexus',
  externalId: '303',
  projectId: 4,
  projectName: 'Tarefas',
  title: 'comprar suplementos',
  description: undefined,
  status: 'pending',
  priority: 2,
  dueDate: undefined,
  dueIsDatetime: false,
  tags: undefined,
  notes: undefined,
  completedAt: undefined,
  providerData: {
    chatCoreV2TaskStore: 'native_tasks',
    nativeListId: 4,
  },
} as const;

function nativeCompleteCommand(entityVersion = computeContentHash(NATIVE_TASK_FOR_HASH)): AICommandEnvelope<Record<string, unknown>> {
  return {
    commandId: 'cmd_native_303',
    commandSchemaVersion: 'tasks.complete@1.0.0',
    previewSchemaVersion: 'task_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: '5',
    userId: '5',
    domain: 'tasks',
    commandType: 'tasks.complete',
    origin: 'chat',
    payload: {
      operation: 'complete',
      taskStore: 'native_tasks',
      taskId: 303,
      nativeListId: 4,
      title: 'comprar suplementos',
      currentStatus: 'pending',
      targetStatus: 'completed',
    },
    basedOn: {
      entityIds: ['native_task:303'],
      entityVersions: {
        'native_task:303': entityVersion,
      },
      contextHash: 'ctx123',
      createdAt: NOW.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: {
        'native_task:303': entityVersion,
      },
      requiredPermissionsVersion: 'chat-v2-permissions:5:5:tasks:v1',
      invariants: [{
        type: 'task_status',
        description: 'Task must still be pending when the preview is confirmed.',
        check: 'task_is_pending',
      }],
    },
    authorization: {
      actorUserId: '5',
      tenantId: '5',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: 'chat-v2-permissions:5:5:tasks:v1',
      authTime: NOW.toISOString(),
    },
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    idempotencyKey: 'chat-v2:5:5:tasks.complete:303:cmd_native_303',
  };
}

function nativeCreateCommand(): AICommandEnvelope<Record<string, unknown>> {
  return {
    commandId: 'cmd_create_native_404',
    commandSchemaVersion: 'tasks.create@1.0.0',
    previewSchemaVersion: 'task_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: '5',
    userId: '5',
    domain: 'tasks',
    commandType: 'tasks.create',
    origin: 'chat',
    payload: {
      operation: 'create',
      title: 'comprar suplementos CODX',
      dueDateTime: null,
      list: null,
      notes: null,
    },
    basedOn: {
      entityIds: ['task_draft:cmd_create_native_404'],
      entityVersions: {},
      contextHash: 'ctx-create',
      createdAt: NOW.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: {},
      requiredPermissionsVersion: 'chat-v2-permissions:5:5:tasks:v1',
      invariants: [],
    },
    authorization: {
      actorUserId: '5',
      tenantId: '5',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: 'chat-v2-permissions:5:5:tasks:v1',
      authTime: NOW.toISOString(),
    },
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    idempotencyKey: 'chat-v2:5:5:create-native',
  };
}

describe('Chat Core v2 command executor', () => {
  beforeEach(() => {
    vi.mocked(recordChatV2CommandEvent).mockReset();
    vi.mocked(getDb).mockReset();
    mockInvalidateTaskCaches.mockReset();
    mockTaskProvider.createTask.mockReset();
    mockTaskProvider.getTask.mockReset();
    mockResolveTaskCreationList.mockReset();
    mockResolveTaskCreationList.mockResolvedValue({ id: '4', displayName: 'Inbox' });
  });

  it('creates chat tasks through the iOS-visible task provider path', async () => {
    mockTaskProvider.createTask.mockResolvedValue({
      success: true,
      data: {
        id: '404',
        listId: '4',
        title: 'comprar suplementos CODX',
        status: 'notStarted',
      },
    });
    mockTaskProvider.getTask.mockResolvedValue({
      success: true,
      data: {
        id: '404',
        listId: '4',
        title: 'comprar suplementos CODX',
        status: 'notStarted',
      },
    });

    const result = await executeChatCoreV2Command({
      command: nativeCreateCommand(),
      capabilityId: 'tasks.create',
      userId: 5,
      tenantId: 5,
      locale: 'pt-PT',
      now: NOW,
    });

    expect(mockResolveTaskCreationList).toHaveBeenCalledWith(mockTaskProvider, null);
    expect(mockTaskProvider.createTask).toHaveBeenCalledWith('4', 'Inbox', {
      title: 'comprar suplementos CODX',
      body: undefined,
      dueDateTime: undefined,
    });
    expect(mockTaskProvider.getTask).toHaveBeenCalledWith('4', '404', 'Inbox');
    expect(result).toMatchObject({
      ok: true,
      capabilityId: 'tasks.create',
      status: 'verified',
      createdTaskId: 404,
    });
    expect(result.response?.text).toBe('Feito — criei a tarefa "comprar suplementos CODX".');
    expect(mockInvalidateTaskCaches).toHaveBeenCalledWith({
      userId: 5,
      listIds: ['4'],
      includeDerivedSurfaces: true,
    });
  });

  it('completes and readback-verifies iOS native tasks', async () => {
    const run = vi.fn(() => ({ changes: 1 }));
    const getNativeBeforeExecution = vi.fn(() => ({
      id: 303,
      list_id: 4,
      list_name: 'Tarefas',
      title: 'comprar suplementos',
      body: null,
      importance: 'normal',
      status: 'notStarted',
      due_date_time: null,
      tags: null,
      completed_at: null,
    }));
    const get = vi.fn(() => ({
      title: 'comprar suplementos',
      status: 'completed',
    }));
    vi.mocked(getDb).mockReturnValue({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT t.*, l.name AS list_name')) return { get: getNativeBeforeExecution };
        if (sql.includes('SELECT title, status')) return { get };
        return { run };
      }),
    } as any);

    const result = await executeChatCoreV2Command({
      command: nativeCompleteCommand(),
      capabilityId: 'tasks.complete',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      capabilityId: 'tasks.complete',
      status: 'verified',
      completedTaskId: 303,
    });
    expect(run).toHaveBeenCalledWith(303, 5);
    expect(get).toHaveBeenCalledWith(303, 5);
    expect(result.response?.text).toBe('Done — I marked "comprar suplementos" as done.');
    expect(mockInvalidateTaskCaches).toHaveBeenCalledWith({
      userId: 5,
      listIds: ['4'],
      includeDerivedSurfaces: true,
    });
  });

  it('does not claim task completion when native readback verification fails', async () => {
    const run = vi.fn(() => ({ changes: 0 }));
    const getNativeBeforeExecution = vi.fn(() => ({
      id: 303,
      list_id: 4,
      list_name: 'Tarefas',
      title: 'comprar suplementos',
      body: null,
      importance: 'normal',
      status: 'notStarted',
      due_date_time: null,
      tags: null,
      completed_at: null,
    }));
    const get = vi.fn(() => ({
      title: 'comprar suplementos',
      status: 'completed',
    }));
    vi.mocked(getDb).mockReturnValue({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT t.*, l.name AS list_name')) return { get: getNativeBeforeExecution };
        if (sql.includes('SELECT title, status')) return { get };
        return { run };
      }),
    } as any);

    const result = await executeChatCoreV2Command({
      command: nativeCompleteCommand(),
      capabilityId: 'tasks.complete',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      capabilityId: 'tasks.complete',
      status: 'verification_failed',
      reason: 'verification_failed',
    });
    expect(result.response?.text).toBe('I sent the request, but I could not verify that "comprar suplementos" was completed yet.');
    expect(result.response?.text).not.toContain('Done — I marked');
  });
});
