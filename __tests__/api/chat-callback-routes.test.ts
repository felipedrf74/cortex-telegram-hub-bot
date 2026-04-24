import { Router, Response } from 'express';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserLanguage = vi.fn(() => 'en');
const mockTryDeterministicChatCommand = vi.fn();
const mockGetCallback = vi.fn(() => null);
const mockApplyCoachRecommendations = vi.fn();
const mockPersistAssistantEdit = vi.fn();
const mockPersistCallbackAssistantResponse = vi.fn();
const mockCompleteTask = vi.fn();

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
}));

vi.mock('../../src/utils/callback-store', () => ({
  getCallback: (...args: unknown[]) => mockGetCallback(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  applyCoachRecommendations: (...args: unknown[]) => mockApplyCoachRecommendations(...args),
}));

vi.mock('../../src/api/routes/chat-persistence', () => ({
  persistAssistantEdit: (...args: unknown[]) => mockPersistAssistantEdit(...args),
  persistCallbackAssistantResponse: (...args: unknown[]) => mockPersistCallbackAssistantResponse(...args),
}));

vi.mock('../../src/services/microsoft-todo', () => ({
  completeTask: (...args: unknown[]) => mockCompleteTask(...args),
  getTasks: vi.fn(async () => ({ success: true, data: [] })),
  deleteTask: vi.fn(async () => undefined),
  deleteList: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: vi.fn(),
  },
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

function mockReq(userId: number, body?: any): Request {
  return {
    userId,
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
): Promise<MockRes> {
  const router = Router();
  registerChatCallbackRoutes(router, guard);
  const req = mockReq(userId, body);
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
    mockGetCallback.mockReset();
    mockApplyCoachRecommendations.mockReset();
    mockPersistAssistantEdit.mockReset();
    mockPersistCallbackAssistantResponse.mockReset();
    mockCompleteTask.mockReset();

    mockGetUserLanguage.mockReturnValue('en');
    mockGetCallback.mockReturnValue(null);
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

  it('uses stored todo callback data to complete tasks and persist the callback response', async () => {
    mockGetCallback.mockReturnValue({
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
    expect(mockCompleteTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(mockPersistCallbackAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7001,
      messageId: 'msg-2',
      text: '✅ Completed: Pagar imposto',
      domain: 'secretary',
    }));
  });
});
