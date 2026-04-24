import { Router, Response } from 'express';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListChatMessages = vi.fn();
const mockClearChatHistory = vi.fn();
const mockClearAllConversations = vi.fn();

vi.mock('../../src/services/chat-history-store', () => ({
  listChatMessages: (...args: unknown[]) => mockListChatMessages(...args),
  clearChatHistory: (...args: unknown[]) => mockClearChatHistory(...args),
}));

vi.mock('../../src/state/conversation', () => ({
  clearAllConversations: (...args: unknown[]) => mockClearAllConversations(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { registerChatHistoryRoutes } from '../../src/api/routes/chat-history-routes';

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

function mockReq(method: 'GET' | 'DELETE', url: string, userId: number): Request {
  const query: Record<string, string> = {};
  const queryString = url.split('?')[1];
  if (queryString) {
    for (const [key, value] of new URLSearchParams(queryString).entries()) {
      query[key] = value;
    }
  }

  return {
    userId,
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    query,
    params: {},
  } as any;
}

async function dispatch(
  method: 'GET' | 'DELETE',
  url: string,
  userId: number,
  guard = (() => true),
  clearActiveDomain = vi.fn(),
): Promise<{ res: MockRes; clearActiveDomain: ReturnType<typeof vi.fn> }> {
  const router = Router();
  registerChatHistoryRoutes(router, guard as any, { clearActiveDomain });

  const req = mockReq(method, url, userId);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return { res, clearActiveDomain };
}

describe('chat history route registrar', () => {
  beforeEach(() => {
    mockListChatMessages.mockReset();
    mockClearChatHistory.mockReset();
    mockClearAllConversations.mockReset();
  });

  it('returns bounded chat history using the authenticated user scope', async () => {
    mockListChatMessages.mockReturnValue({
      messages: [{ id: 'msg-1', role: 'assistant', text: 'Olá' }],
      cursor: 'cursor-1',
      hasMore: true,
    });

    const { res } = await dispatch('GET', '/history?limit=150&before=cursor-0', 7001);

    expect(res.statusCode).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(mockListChatMessages).toHaveBeenCalledWith(7001, 100, 'cursor-0');
  });

  it('clears persisted history, conversation state, and active-domain state together', async () => {
    const { res, clearActiveDomain } = await dispatch('DELETE', '/history', 7001);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { cleared: true } });
    expect(mockClearChatHistory).toHaveBeenCalledWith(7001);
    expect(mockClearAllConversations).toHaveBeenCalledWith(7001);
    expect(clearActiveDomain).toHaveBeenCalledWith(7001);
  });

  it('fails closed before loading history when the scope guard rejects the request', async () => {
    const guard = ((res: Response) => {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } });
      return false;
    });

    const { res } = await dispatch('GET', '/history?limit=10', 0, guard);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockListChatMessages).not.toHaveBeenCalled();
  });

  it('sanitizes clear-history failures instead of leaking the raw exception', async () => {
    mockClearChatHistory.mockImplementationOnce(() => {
      throw new Error('sqlite busy while clearing tenant 7001 history');
    });

    const { res } = await dispatch('DELETE', '/history', 7001);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'CHAT_HISTORY_CLEAR_FAILED',
        message: 'Failed to clear chat history',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('sqlite busy while clearing tenant 7001 history');
  });
});
