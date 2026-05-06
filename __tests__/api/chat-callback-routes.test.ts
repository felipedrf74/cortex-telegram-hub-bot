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

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: chat-callback-routes uses the strict by-id helper.
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguage(...args),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
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
    expect(mockCompleteTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(mockConsumeCallbackForScope).toHaveBeenCalledWith('ref-1', { tenantId: 7001, userId: 7001 });
    expect(mockPersistCallbackAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7001,
      messageId: 'msg-2',
      text: '✅ Completed: Pagar imposto',
      domain: 'secretary',
    }));
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
