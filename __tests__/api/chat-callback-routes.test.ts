import { Router, Response } from 'express';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserLanguage = vi.fn(() => 'en');
const mockTryDeterministicChatCommand = vi.fn();
const mockGetCallbackForScope = vi.fn(() => null);
const mockConsumeCallbackForScope = vi.fn(() => true);
const mockStoreCallback = vi.fn(() => 'ref-scoped');
const mockStoreCallbackForScope = vi.fn(() => 'ref-scoped');
const mockApplyCoachRecommendations = vi.fn();
const mockPersistAssistantEdit = vi.fn();
const mockPersistCallbackAssistantResponse = vi.fn();
const mockCompleteTask = vi.fn();
const mockGetTasks = vi.fn(async () => ({ success: true, data: [] }));
const mockDeleteTask = vi.fn(async () => undefined);
const mockDeleteList = vi.fn(async () => undefined);
const mockGetTaskProviderForUser = vi.fn();

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  );
  return {
    ...actual,
    // Identity-safety: chat-callback-routes uses the strict by-id helper.
    getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
    getUserLanguageById: (...args: unknown[]) => mockGetUserLanguage(...args),
  };
});

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
  getPendingTasksCacheKey: (userId?: number, tenantId?: number) =>
    `u:${userId ?? 'unknown'}:t:${tenantId ?? userId ?? 'unknown'}:fastpath:pending-tasks`,
}));

vi.mock('../../src/utils/callback-store', () => ({
  getCallbackForScope: (...args: unknown[]) => mockGetCallbackForScope(...args),
  consumeCallbackForScope: (...args: unknown[]) => mockConsumeCallbackForScope(...args),
  storeCallback: (...args: unknown[]) => mockStoreCallback(...args),
  storeCallbackForScope: (...args: unknown[]) => mockStoreCallbackForScope(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  applyCoachRecommendations: (...args: unknown[]) => mockApplyCoachRecommendations(...args),
}));

vi.mock('../../src/api/routes/chat-persistence', () => ({
  persistAssistantEdit: (...args: unknown[]) => mockPersistAssistantEdit(...args),
  persistCallbackAssistantResponse: (...args: unknown[]) => mockPersistCallbackAssistantResponse(...args),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

// M5 single write path: callback task/list writes land in the offline-first
// ledger by default; the direct provider path survives behind
// TASK_SINGLE_WRITE_PATH=0.
const mockRecordLocalTaskMutation = vi.fn();
const mockResolveOfflineNexusTaskId = vi.fn();
const mockDeleteOfflineFirstTaskList = vi.fn();
const mockResolveOfflineTaskListRef = vi.fn();

vi.mock('../../src/services/task-store/offline-first-task-service', () => ({
  recordLocalTaskMutation: (...args: unknown[]) => mockRecordLocalTaskMutation(...args),
  resolveOfflineNexusTaskId: (...args: unknown[]) => mockResolveOfflineNexusTaskId(...args),
  deleteOfflineFirstTaskList: (...args: unknown[]) => mockDeleteOfflineFirstTaskList(...args),
  resolveOfflineTaskListRef: (...args: unknown[]) => mockResolveOfflineTaskListRef(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  registerChatCallbackRoutes,
  type ChatRouteScopeGuard,
} from '../../src/api/routes/chat-callback-routes';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(userId: number, body?: any, tenantId = userId): Request {
  return {
    userId,
    tenantId,
    body,
    method: 'POST',
    url: '/callback',
    originalUrl: '/callback',
    baseUrl: '',
    path: '/callback',
    query: {},
    params: {},
  } as any;
}

async function dispatch(
  userId: number,
  body: any,
  guard: ChatRouteScopeGuard = (() => true) as ChatRouteScopeGuard,
  tenantId = userId,
): Promise<MockRes> {
  const router = Router();
  registerChatCallbackRoutes(router, guard);
  const req = mockReq(userId, body, tenantId);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('chat callback route registrar', () => {
  beforeEach(() => {
    mockGetUserLanguage.mockReset();
    mockTryDeterministicChatCommand.mockReset();
    mockGetCallbackForScope.mockReset();
    mockConsumeCallbackForScope.mockReset();
    mockStoreCallback.mockReset();
    mockStoreCallbackForScope.mockReset();
    mockApplyCoachRecommendations.mockReset();
    mockPersistAssistantEdit.mockReset();
    mockPersistCallbackAssistantResponse.mockReset();
    mockCompleteTask.mockReset();
    mockGetTasks.mockReset();
    mockDeleteTask.mockReset();
    mockDeleteList.mockReset();
    mockGetTaskProviderForUser.mockReset();

    mockGetUserLanguage.mockReturnValue('en');
    mockGetCallbackForScope.mockReturnValue(null);
    mockConsumeCallbackForScope.mockReturnValue(true);
    mockStoreCallback.mockReturnValue('ref-scoped');
    mockStoreCallbackForScope.mockReturnValue('ref-scoped');
    mockGetTasks.mockResolvedValue({ success: true, data: [] });
    mockDeleteTask.mockResolvedValue(undefined);
    mockDeleteList.mockResolvedValue(undefined);
    mockGetTaskProviderForUser.mockReturnValue({
      completeTask: mockCompleteTask,
      getTasks: mockGetTasks,
      deleteTask: mockDeleteTask,
      deleteList: mockDeleteList,
    });
    vi.unstubAllEnvs();
    mockRecordLocalTaskMutation.mockReset();
    mockResolveOfflineNexusTaskId.mockReset();
    mockDeleteOfflineFirstTaskList.mockReset();
    mockResolveOfflineTaskListRef.mockReset();
    mockRecordLocalTaskMutation.mockReturnValue({
      task: { id: 'task_nexus_cb', title: 'Callback task', status: 'completed' },
      mutationId: 'mutation-callback',
      idempotentReplay: false,
    });
    mockResolveOfflineNexusTaskId.mockReturnValue('task_nexus_cb');
    mockDeleteOfflineFirstTaskList.mockReturnValue({ deleted: true, mutationId: 'mutation-list-delete', idempotentReplay: false });
    mockResolveOfflineTaskListRef.mockReturnValue({ id: '61', name: 'Inbox' });
  });

  it('handles deterministic command callbacks and persists the edited assistant message', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: '<b>Today</b>',
      domain: 'secretary',
      buttons: [[{ text: 'Tasks', callbackData: 'cmd:/todo_summary' }]],
    });

    const res = await dispatch(7001, {
      callbackData: 'cmd:/day',
      messageId: 'msg-1',
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      text: '<b>Today</b>',
      editOriginal: true,
      newButtons: [[{ text: 'Tasks', callbackData: 'cmd:/todo_summary' }]],
    });
    expect(mockTryDeterministicChatCommand).toHaveBeenCalledWith('/day', 7001, 7001);
    expect(mockPersistAssistantEdit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7001,
      messageId: 'msg-1',
      text: '<b>Today</b>',
      domain: 'secretary',
      routeMethod: 'fast-path',
    }));
  });

  it('fails closed when the caller scope guard rejects the request', async () => {
    const guard = ((res: Response) => {
      res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      return false;
    }) as ChatRouteScopeGuard;

    const res = await dispatch(0, { callbackData: 'cmd:/day' }, guard);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockTryDeterministicChatCommand).not.toHaveBeenCalled();
  });

  it('returns a localized client-safe error instead of leaking callback failures', async () => {
    mockGetUserLanguage.mockReturnValue('pt-BR');
    mockTryDeterministicChatCommand.mockRejectedValue(new Error('database password mismatch'));

    const res = await dispatch(7001, { callbackData: 'cmd:/day' });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Falha ao processar a ação.',
    });
    expect(JSON.stringify(res.body)).not.toContain('database password mismatch');
  });

  it('uses tenant-scoped stored todo callback data to complete tasks and persist the callback response', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      taskId: 'task-1',
      title: 'Pagar imposto',
    });

    const res = await dispatch(7001, {
      callbackData: 'td:tc:ref-1',
      messageId: 'msg-2',
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      text: '✅ Completed: Pagar imposto',
      editOriginal: true,
      newButtons: null,
    });
    expect(mockGetCallbackForScope).toHaveBeenCalledWith('ref-1', { tenantId: 7001, userId: 7001 });
    expect(mockResolveOfflineNexusTaskId).toHaveBeenCalledWith(7001, 7001, 'task-1');
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledWith(7001, 7001, {
      taskId: 'task_nexus_cb',
      operation: 'task.complete',
      patch: { source: 'chat_callback' },
    });
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-1', { tenantId: 7001, userId: 7001 });
    expect(mockConsumeCallbackForScope.mock.invocationCallOrder[0])
      .toBeLessThan(mockRecordLocalTaskMutation.mock.invocationCallOrder[0]);
    expect(mockPersistCallbackAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7001,
      messageId: 'msg-2',
      text: '✅ Completed: Pagar imposto',
      domain: 'secretary',
    }));
  });

  it('uses tenant-scoped stored todo callback data to delete tasks after consuming the callback', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      taskId: 'task-1',
      title: 'Old task',
      type: 'task',
    });

    const res = await dispatch(7001, {
      callbackData: 'td:dy:ref-delete-task',
      messageId: 'msg-delete-task',
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      text: '🗑️ Deleted: Old task',
      editOriginal: true,
      newButtons: null,
    });
    expect(mockGetCallbackForScope).toHaveBeenCalledWith('ref-delete-task', { tenantId: 7001, userId: 7001 });
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-delete-task', { tenantId: 7001, userId: 7001 });
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledWith(7001, 7001, {
      taskId: 'task_nexus_cb',
      operation: 'task.delete',
      patch: { source: 'chat_callback' },
    });
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockConsumeCallbackForScope.mock.invocationCallOrder[0])
      .toBeLessThan(mockRecordLocalTaskMutation.mock.invocationCallOrder[0]);
    expect(mockPersistCallbackAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7001,
      messageId: 'msg-delete-task',
      text: '🗑️ Deleted: Old task',
      domain: 'secretary',
    }));
  });

  it('legacy flag-off path deletes tasks through the provider after consuming the callback', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      taskId: 'task-1',
      title: 'Old task',
      type: 'task',
    });

    const res = await dispatch(7001, {
      callbackData: 'td:dy:ref-delete-task-legacy',
      messageId: 'msg-delete-task-legacy',
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(mockDeleteTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(mockRecordLocalTaskMutation).not.toHaveBeenCalled();
  });

  it('expires unresolvable task callbacks before consuming the one-shot ref', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      taskId: 'task-unknown',
      title: 'Ghost task',
    });
    mockResolveOfflineNexusTaskId.mockReturnValue(null);

    const res = await dispatch(7001, {
      callbackData: 'td:tc:ref-ghost',
      messageId: 'msg-ghost',
    });

    expect(res.statusCode).toBe(410);
    expect(res.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockRecordLocalTaskMutation).not.toHaveBeenCalled();
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  it('uses tenant-scoped stored todo callback data to delete lists after consuming the callback', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      listName: 'Inbox',
      type: 'list',
    });

    const res = await dispatch(7001, {
      callbackData: 'td:dy:ref-delete-list',
      messageId: 'msg-delete-list',
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      text: '🗑️ Deleted list: Inbox',
      editOriginal: true,
      newButtons: null,
    });
    expect(mockGetCallbackForScope).toHaveBeenCalledWith('ref-delete-list', { tenantId: 7001, userId: 7001 });
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-delete-list', { tenantId: 7001, userId: 7001 });
    expect(mockResolveOfflineTaskListRef).toHaveBeenCalledWith(7001, 7001, 'list-1', 'Inbox');
    expect(mockDeleteOfflineFirstTaskList).toHaveBeenCalledWith(7001, 7001, { listId: '61' });
    expect(mockDeleteList).not.toHaveBeenCalled();
    expect(mockConsumeCallbackForScope.mock.invocationCallOrder[0])
      .toBeLessThan(mockDeleteOfflineFirstTaskList.mock.invocationCallOrder[0]);
    expect(mockPersistCallbackAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7001,
      messageId: 'msg-delete-list',
      text: '🗑️ Deleted list: Inbox',
      domain: 'secretary',
    }));
  });

  it('mutates once when a task-complete callback ref is tapped twice sequentially', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      taskId: 'task-1',
      title: 'Pay tax',
    });
    mockConsumeCallbackForScope
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const first = await dispatch(7001, {
      callbackData: 'td:tc:ref-double-complete',
      messageId: 'msg-double-complete-1',
    });
    const second = await dispatch(7001, {
      callbackData: 'td:tc:ref-double-complete',
      messageId: 'msg-double-complete-2',
    });

    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(second.statusCode).toBe(410);
    expect(second.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledTimes(1);
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledWith(7001, 7001, expect.objectContaining({
      operation: 'task.complete',
    }));
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockConsumeCallbackForScope).toHaveBeenCalledTimes(2);
  });

  it('mutates once when a task-delete callback ref is tapped twice sequentially', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      taskId: 'task-1',
      title: 'Old task',
      type: 'task',
    });
    mockConsumeCallbackForScope
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const first = await dispatch(7001, {
      callbackData: 'td:dy:ref-double-delete',
      messageId: 'msg-double-delete-1',
    });
    const second = await dispatch(7001, {
      callbackData: 'td:dy:ref-double-delete',
      messageId: 'msg-double-delete-2',
    });

    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(second.statusCode).toBe(410);
    expect(second.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledTimes(1);
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledWith(7001, 7001, expect.objectContaining({
      operation: 'task.delete',
    }));
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockConsumeCallbackForScope).toHaveBeenCalledTimes(2);
  });

  it('rejects task callbacks when scoped callback lookup fails', async () => {
    mockGetCallbackForScope.mockReturnValue(null);

    const res = await dispatch(7001, {
      callbackData: 'td:tc:ref-foreign',
      messageId: 'msg-2',
    });

    expect(res.statusCode).toBe(410);
    expect(res.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockConsumeCallbackForScope).not.toHaveBeenCalled();
  });

  it('does not mutate tasks when destructive callback consume fails', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      taskId: 'task-1',
      title: 'Pagar imposto',
    });
    mockConsumeCallbackForScope.mockReturnValue(false);

    const res = await dispatch(7001, {
      callbackData: 'td:tc:ref-1',
      messageId: 'msg-2',
    });

    expect(res.statusCode).toBe(410);
    expect(res.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-1', { tenantId: 7001, userId: 7001 });
    expect(mockRecordLocalTaskMutation).not.toHaveBeenCalled();
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  it('does not apply coach recommendations when callback consume fails', async () => {
    mockGetCallbackForScope.mockReturnValue({
      recommendationIds: ['rec-1'],
    });
    mockConsumeCallbackForScope.mockReturnValue(false);

    const res = await dispatch(7001, {
      callbackData: 'coach:apply:ref-coach-1',
      messageId: 'msg-coach',
    });

    expect(res.statusCode).toBe(410);
    expect(res.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-coach-1', { tenantId: 7001, userId: 7001 });
    expect(mockApplyCoachRecommendations).not.toHaveBeenCalled();
  });

  it('consumes malformed task-complete callback refs and does not mutate tasks', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      title: 'Missing task id',
    });

    const res = await dispatch(7001, {
      callbackData: 'td:tc:ref-malformed',
      messageId: 'msg-2',
    });

    expect(res.statusCode).toBe(410);
    expect(res.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-malformed', { tenantId: 7001, userId: 7001 });
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockPersistCallbackAssistantResponse).not.toHaveBeenCalled();
  });

  it('consumes malformed task-delete callback refs and does not mutate tasks or lists', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listName: 'Missing list id',
      type: 'list',
    });

    const res = await dispatch(7001, {
      callbackData: 'td:dy:ref-malformed-delete',
      messageId: 'msg-2',
    });

    expect(res.statusCode).toBe(410);
    expect(res.body.error.code).toBe('CALLBACK_EXPIRED');
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-malformed-delete', { tenantId: 7001, userId: 7001 });
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockDeleteList).not.toHaveBeenCalled();
    expect(mockPersistCallbackAssistantResponse).not.toHaveBeenCalled();
  });

  it('applies coach recommendations only after consuming the scoped callback', async () => {
    mockGetCallbackForScope.mockReturnValue({
      recommendationIds: ['rec-1', 'rec-2'],
    });
    mockApplyCoachRecommendations.mockResolvedValue({
      count: 2,
      appliedRecommendations: ['rec-1', 'rec-2'],
    });

    const res = await dispatch(7001, {
      callbackData: 'coach:apply:ref-coach-ok',
      messageId: 'msg-coach',
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-coach-ok', { tenantId: 7001, userId: 7001 });
    expect(mockApplyCoachRecommendations).toHaveBeenCalledWith(7001, 7001, ['rec-1', 'rec-2']);
    expect(mockConsumeCallbackForScope.mock.invocationCallOrder[0])
      .toBeLessThan(mockApplyCoachRecommendations.mock.invocationCallOrder[0]);
    expect(mockPersistAssistantEdit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7001,
      messageId: 'msg-coach',
      domain: 'triathlon',
    }));
  });

  it('passes tenant scope into the callback guard before any action executes', async () => {
    const guard = ((res: Response, userId: number | undefined, tenantId: number | undefined) => {
      if (userId !== tenantId) {
        res.status(403).json({ error: { code: 'FORBIDDEN' } });
        return false;
      }
      return true;
    }) as ChatRouteScopeGuard;

    const res = await dispatch(7001, { callbackData: 'cmd:/day' }, guard, 9001);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockTryDeterministicChatCommand).not.toHaveBeenCalled();
  });

  it('uses the authenticated user task provider instead of global task services', async () => {
    mockGetCallbackForScope.mockReturnValue({
      listId: 'list-1',
      listName: 'Scoped',
    });
    mockGetTasks.mockResolvedValue({
      success: true,
      data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Scoped' }],
    });

    const res = await dispatch(7001, {
      callbackData: 'td:ls:ref-2',
      messageId: 'msg-3',
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(7001);
    expect(mockGetTasks).toHaveBeenCalledWith('list-1', 'Scoped', { status: 'notStarted' });
    expect(JSON.stringify(res.body.newButtons)).toContain('td:tc:');
  });
});
