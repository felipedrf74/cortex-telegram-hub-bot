import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
  executeChatCoreV2Command,
} from '../../src/services/chat-core-v2/command-executor';
import { getDb } from '../../src/services/database';
import { recordChatV2CommandEvent } from '../../src/services/chat-core-v2/command-events';
import {
  decisionDismissVersionForItem,
  decisionSnoozeVersionForItem,
} from '../../src/services/chat-core-v2/command-status-policy';
import { computeContentHash } from '../../src/services/task-store/unified-task-store';
import type { AICommandEnvelope } from '../../src/services/chat-core-v2/types';

const mockInvalidateTaskCaches = vi.hoisted(() => vi.fn());
const mockTaskProvider = vi.hoisted(() => ({
  createTask: vi.fn(),
  getTask: vi.fn(),
}));
const mockResolveTaskCreationList = vi.hoisted(() => vi.fn());
const mockGetDecisionItem = vi.hoisted(() => vi.fn());
const mockDismissDecision = vi.hoisted(() => vi.fn());
const mockSnoozeDecision = vi.hoisted(() => vi.fn());

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

vi.mock('../../src/services/decision-center', () => ({
  getDecisionItem: (...args: unknown[]) => mockGetDecisionItem(...args),
  dismissDecision: (...args: unknown[]) => mockDismissDecision(...args),
  snoozeDecision: (...args: unknown[]) => mockSnoozeDecision(...args),
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

function decisionItem(status = 'unread', title = 'Pick a client-review slot') {
  return {
    decisionId: 'dc_schedule',
    status,
    title,
    summary: 'Secretary found a scheduling conflict.',
    safePreviewTitle: title,
    safePreviewBody: 'Choose whether to keep or dismiss this suggestion.',
    urgency: 'medium',
    sourceSkill: 'secretary',
    type: 'schedule_choice',
    actions: [
      { id: 'open_detail', label: 'Open', style: 'primary' },
      { id: 'dismiss', label: 'Not now', style: 'secondary' },
    ],
    expiresAt: '2026-05-28T16:45:00.000Z',
  } as Parameters<typeof decisionDismissVersionForItem>[0];
}

function decisionDismissCommand(item = decisionItem()): AICommandEnvelope<Record<string, unknown>> {
  const decisionVersion = decisionDismissVersionForItem(item);
  return {
    commandId: 'cmd_decision_dismiss_dc_schedule',
    commandSchemaVersion: 'decision_center.dismiss@1.0.0',
    previewSchemaVersion: 'decision_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: '5',
    userId: '5',
    domain: 'decision_center',
    commandType: 'decision_center.dismiss',
    origin: 'decision_center',
    payload: {
      operation: 'dismiss',
      decisionId: item.decisionId,
      title: item.title,
      currentStatus: item.status,
      targetStatus: 'dismissed',
      sourceSkill: item.sourceSkill,
      type: item.type,
      urgency: item.urgency,
    },
    basedOn: {
      entityIds: [`decision:${item.decisionId}`],
      entityVersions: {
        [`decision:${item.decisionId}`]: decisionVersion,
      },
      contextHash: 'ctx-decision-dismiss',
      createdAt: NOW.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: {
        [`decision:${item.decisionId}`]: decisionVersion,
      },
      requiredPermissionsVersion: 'decision-center-permissions:5:5:decision_center:v1',
      requiredDecisionVersion: decisionVersion,
      invariants: [{
        type: 'decision_status',
        description: 'Decision must still be dismissible when the command executes.',
        check: 'decision_is_active',
      }],
    },
    authorization: {
      actorUserId: '5',
      tenantId: '5',
      actingSurface: 'system_automation',
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
      permissionSnapshotVersion: 'decision-center-permissions:5:5:decision_center:v1',
      authTime: NOW.toISOString(),
    },
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    idempotencyKey: `decision-center:5:5:decision_center.dismiss:${item.decisionId}:cmd_decision_dismiss_dc_schedule`,
  };
}

function decisionSnoozeCommand(item = decisionItem()): AICommandEnvelope<Record<string, unknown>> {
  const decisionVersion = decisionSnoozeVersionForItem(item);
  const snoozedUntil = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  return {
    commandId: 'cmd_decision_snooze_dc_schedule',
    commandSchemaVersion: 'decision_center.snooze@1.0.0',
    previewSchemaVersion: 'decision_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: '5',
    userId: '5',
    domain: 'decision_center',
    commandType: 'decision_center.snooze',
    origin: 'decision_center',
    payload: {
      operation: 'snooze',
      decisionId: item.decisionId,
      title: item.title,
      currentStatus: item.status,
      targetStatus: 'snoozed',
      sourceSkill: item.sourceSkill,
      type: item.type,
      urgency: item.urgency,
      snoozeMinutes: 60,
      snoozedUntil,
    },
    basedOn: {
      entityIds: [`decision:${item.decisionId}`],
      entityVersions: {
        [`decision:${item.decisionId}`]: decisionVersion,
      },
      contextHash: 'ctx-decision-snooze',
      createdAt: NOW.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: {
        [`decision:${item.decisionId}`]: decisionVersion,
      },
      requiredPermissionsVersion: 'decision-center-permissions:5:5:decision_center:v1',
      requiredDecisionVersion: decisionVersion,
      invariants: [{
        type: 'decision_status',
        description: 'Decision must still be snooze-eligible when the command executes.',
        check: 'decision_is_snooze_eligible',
      }],
    },
    authorization: {
      actorUserId: '5',
      tenantId: '5',
      actingSurface: 'system_automation',
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
      permissionSnapshotVersion: 'decision-center-permissions:5:5:decision_center:v1',
      authTime: NOW.toISOString(),
    },
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    idempotencyKey: `decision-center:5:5:decision_center.snooze:${item.decisionId}:60:cmd_decision_snooze_dc_schedule`,
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
    mockGetDecisionItem.mockReset();
    mockDismissDecision.mockReset();
    mockSnoozeDecision.mockReset();
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

  it('does not claim task creation when the provider cannot independently read back the created task', async () => {
    mockTaskProvider.createTask.mockResolvedValue({
      success: true,
      data: {
        id: '404',
        listId: '4',
        title: 'comprar suplementos CODX',
        status: 'notStarted',
      },
    });
    const originalGetTask = mockTaskProvider.getTask;
    Object.defineProperty(mockTaskProvider, 'getTask', {
      configurable: true,
      value: undefined,
    });

    try {
      const result = await executeChatCoreV2Command({
        command: nativeCreateCommand(),
        capabilityId: 'tasks.create',
        userId: 5,
        tenantId: 5,
        locale: 'en-US',
        now: NOW,
      });

      expect(result).toMatchObject({
        ok: false,
        capabilityId: 'tasks.create',
        status: 'verification_failed',
        reason: 'verification_failed',
        createdTaskId: 404,
      });
      expect(result.response?.text).toBe('I sent the request, but I could not verify that "comprar suplementos CODX" was created yet.');
      expect(result.response?.text).not.toContain('Done — I created');
    } finally {
      Object.defineProperty(mockTaskProvider, 'getTask', {
        configurable: true,
        value: originalGetTask,
      });
    }
  });

  it('does not verify task creation from an empty provider readback payload', async () => {
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
      data: {},
    });

    const result = await executeChatCoreV2Command({
      command: nativeCreateCommand(),
      capabilityId: 'tasks.create',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      capabilityId: 'tasks.create',
      status: 'verification_failed',
      reason: 'verification_failed',
      createdTaskId: 404,
    });
    expect(result.response?.text).toBe('I sent the request, but I could not verify that "comprar suplementos CODX" was created yet.');
    expect(result.response?.text).not.toContain('Done — I created');
  });

  it('does not verify task creation when provider readback returns a different task id', async () => {
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
        id: '405',
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
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      capabilityId: 'tasks.create',
      status: 'verification_failed',
      reason: 'verification_failed',
      createdTaskId: 404,
    });
    expect(result.response?.text).toBe('I sent the request, but I could not verify that "comprar suplementos CODX" was created yet.');
    expect(result.response?.text).not.toContain('Done — I created');
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

  it('dismisses and event-logs a Decision Center-origin command through the bus', async () => {
    const activeDecision = decisionItem('unread');
    const dismissedDecision = decisionItem('dismissed');
    let decisionReadback = activeDecision;
    mockGetDecisionItem.mockImplementation(() => decisionReadback);
    mockDismissDecision.mockImplementation(() => {
      decisionReadback = dismissedDecision;
      return dismissedDecision;
    });
    const command = decisionDismissCommand(activeDecision);

    const result = await executeChatCoreV2Command({
      command,
      capabilityId: 'decision_center.dismiss',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      capabilityId: 'decision_center.dismiss',
      status: 'verified',
      dismissedDecisionId: 'dc_schedule',
    });
    expect(mockDismissDecision).toHaveBeenCalledWith('dc_schedule', 5, 5);
    expect(result.response?.text).toBe('Done — I dismissed "Pick a client-review slot" from Decision Center.');
    expect(recordChatV2CommandEvent).toHaveBeenCalledWith(expect.objectContaining({
      commandId: command.commandId,
      commandType: 'decision_center.dismiss',
      eventName: 'verification_completed',
      status: 'verified',
      origin: 'decision_center',
      capabilityId: 'decision_center.dismiss',
      idempotencyKey: command.idempotencyKey,
    }));
    const verificationEvent = vi.mocked(recordChatV2CommandEvent).mock.calls
      .map(([event]) => event)
      .find((event) => event.eventName === 'verification_completed');
    expect(verificationEvent?.metadata).toEqual({
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      decisionId: 'dc_schedule',
    });
  });

  it('does not claim Decision Center dismiss when post-action readback mismatches', async () => {
    const activeDecision = decisionItem('unread');
    const dismissedDecision = decisionItem('dismissed');
    mockGetDecisionItem.mockImplementation(() => activeDecision);
    mockDismissDecision.mockReturnValue(dismissedDecision);
    const command = decisionDismissCommand(activeDecision);

    const result = await executeChatCoreV2Command({
      command,
      capabilityId: 'decision_center.dismiss',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      capabilityId: 'decision_center.dismiss',
      status: 'verification_failed',
      reason: 'verification_failed',
      dismissedDecisionId: 'dc_schedule',
    });
    expect(result.response?.text).toBe('I sent the request, but I could not verify that "Pick a client-review slot" was dismissed from Decision Center yet.');
    expect(result.response?.text).not.toContain('Done — I dismissed');
    expect(mockDismissDecision).toHaveBeenCalledWith('dc_schedule', 5, 5);
    expect(mockGetDecisionItem).toHaveBeenNthCalledWith(1, 'dc_schedule', 5, 5);
    expect(mockGetDecisionItem).toHaveBeenNthCalledWith(2, 'dc_schedule', 5, 5);
    expect(recordChatV2CommandEvent).toHaveBeenCalledWith(expect.objectContaining({
      commandId: command.commandId,
      commandType: 'decision_center.dismiss',
      eventName: 'verification_failed',
      status: 'verification_failed',
      reason: 'verification_failed',
      origin: 'decision_center',
      capabilityId: 'decision_center.dismiss',
      metadata: {
        executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
        decisionId: 'dc_schedule',
      },
    }));
  });

  it('snoozes and event-logs a Decision Center-origin command through the bus', async () => {
    const activeDecision = decisionItem('unread');
    const snoozedDecision = {
      ...decisionItem('snoozed'),
      snoozedUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    };
    let decisionReadback = activeDecision;
    mockGetDecisionItem.mockImplementation(() => decisionReadback);
    mockSnoozeDecision.mockImplementation(() => {
      decisionReadback = snoozedDecision;
      return snoozedDecision;
    });
    const command = decisionSnoozeCommand(activeDecision);

    const result = await executeChatCoreV2Command({
      command,
      capabilityId: 'decision_center.snooze',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      capabilityId: 'decision_center.snooze',
      status: 'verified',
      snoozedDecisionId: 'dc_schedule',
    });
    expect(mockSnoozeDecision).toHaveBeenCalledWith('dc_schedule', 5, 5, 60);
    expect(result.response?.text).toBe('Done — I snoozed "Pick a client-review slot" in Decision Center for 1 hour.');
    expect(recordChatV2CommandEvent).toHaveBeenCalledWith(expect.objectContaining({
      commandId: command.commandId,
      commandType: 'decision_center.snooze',
      eventName: 'verification_completed',
      status: 'verified',
      origin: 'decision_center',
      capabilityId: 'decision_center.snooze',
      idempotencyKey: command.idempotencyKey,
    }));
  });

  it('does not claim Decision Center snooze when post-action readback mismatches', async () => {
    const activeDecision = decisionItem('unread');
    const snoozedDecision = {
      ...decisionItem('snoozed'),
      snoozedUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    };
    mockGetDecisionItem.mockImplementation(() => activeDecision);
    mockSnoozeDecision.mockReturnValue(snoozedDecision);
    const command = decisionSnoozeCommand(activeDecision);

    const result = await executeChatCoreV2Command({
      command,
      capabilityId: 'decision_center.snooze',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      capabilityId: 'decision_center.snooze',
      status: 'verification_failed',
      reason: 'verification_failed',
      snoozedDecisionId: 'dc_schedule',
    });
    expect(result.response?.text).toBe('I sent the request, but I could not verify that "Pick a client-review slot" was snoozed in Decision Center yet.');
    expect(result.response?.text).not.toContain('Done — I snoozed');
    expect(mockSnoozeDecision).toHaveBeenCalledWith('dc_schedule', 5, 5, 60);
    expect(mockGetDecisionItem).toHaveBeenNthCalledWith(1, 'dc_schedule', 5, 5);
    expect(mockGetDecisionItem).toHaveBeenNthCalledWith(2, 'dc_schedule', 5, 5);
    expect(recordChatV2CommandEvent).toHaveBeenCalledWith(expect.objectContaining({
      commandId: command.commandId,
      commandType: 'decision_center.snooze',
      eventName: 'verification_failed',
      status: 'verification_failed',
      reason: 'verification_failed',
      origin: 'decision_center',
      capabilityId: 'decision_center.snooze',
      metadata: {
        executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
        decisionId: 'dc_schedule',
      },
    }));
  });

  it('rejects Decision Center dismiss when decision_center:write is missing', async () => {
    const activeDecision = decisionItem('unread');
    mockGetDecisionItem.mockReturnValue(activeDecision);
    const baseCommand = decisionDismissCommand(activeDecision);
    const command = {
      ...baseCommand,
      authorization: {
        ...baseCommand.authorization,
        delegatedScopes: ['decision_center:read'],
      },
    };

    const result = await executeChatCoreV2Command({
      command,
      capabilityId: 'decision_center.dismiss',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      capabilityId: 'decision_center.dismiss',
      status: 'rejected_by_policy',
      reason: 'command_gate_rejected',
      gateVerdict: {
        reason: 'missing_delegated_scope',
        missingScopes: ['decision_center:write'],
      },
    });
    expect(mockDismissDecision).not.toHaveBeenCalled();
  });

  it('rejects Decision Center dismiss execution when the live decision version changed', async () => {
    const previewDecision = decisionItem('unread', 'Pick a client-review slot');
    const changedDecision = decisionItem('unread', 'Pick a different client-review slot');
    mockGetDecisionItem.mockReturnValue(changedDecision);

    const result = await executeChatCoreV2Command({
      command: decisionDismissCommand(previewDecision),
      capabilityId: 'decision_center.dismiss',
      userId: 5,
      tenantId: 5,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      capabilityId: 'decision_center.dismiss',
      status: 'stale',
      reason: 'command_gate_rejected',
      gateVerdict: {
        reason: 'stale_entity_version',
      },
    });
    expect(mockDismissDecision).not.toHaveBeenCalled();
  });
});
