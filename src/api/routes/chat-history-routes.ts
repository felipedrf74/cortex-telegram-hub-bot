// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { clearChatHistory, listChatMessages } from '../../services/chat-history-store';
import { clearAllConversations } from '../../state/conversation';
import { sendInternalError } from '../response-helpers';

type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

interface ChatHistoryRouteOptions {
  clearActiveDomain(userId: number, tenantId?: number): void;
}

export function registerChatHistoryRoutes(
  router: Router,
  ensureValidChatRouteScope: ChatRouteScopeGuard,
  options: ChatHistoryRouteOptions,
): void {
  /**
   * GET /api/v1/chat/history?limit=50&before=<cursor>
   * Fetch conversation history.
   */
  router.get('/history', async (req, res: Response) => {
    const { userId, tenantId = userId } = req as AuthenticatedRequest;
    const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
    const before = req.query.before as string | undefined;

    if (!ensureValidChatRouteScope(res, userId, 'chat_route_history', {
      limit,
      hasBefore: Boolean(before),
    })) {
      return;
    }

    try {
      res.json(listChatMessages(userId, limit, before, tenantId));
    } catch (err: any) {
      logger.debug({ err }, 'iOS chat history query failed');
      res.json({ messages: [], cursor: null, hasMore: false });
    }
  });

  /**
   * DELETE /api/v1/chat/history
   * Clears persisted chat history and per-domain conversation context.
   */
  router.delete('/history', async (req, res: Response) => {
    const { userId, tenantId = userId } = req as AuthenticatedRequest;

    if (!ensureValidChatRouteScope(res, userId, 'chat_route_clear_history')) {
      return;
    }

    try {
      clearChatHistory(userId, tenantId);
      clearAllConversations(userId, tenantId);
      options.clearActiveDomain(userId, tenantId);
      res.json({ ok: true, data: { cleared: true } });
    } catch (err: any) {
      logger.error({ err, userId, platform: 'ios' }, 'iOS chat history clear failed');
      sendInternalError(res, 'Failed to clear chat history', {
        code: 'CHAT_HISTORY_CLEAR_FAILED',
        status: 500,
      });
    }
  });
}
