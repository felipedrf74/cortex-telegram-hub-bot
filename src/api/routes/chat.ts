// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage, isSystemCommand } from '../../router';
import { logger } from '../../utils/logger';
import { getCached, setCache } from '../../services/cache-store';

// Commands whose responses can be cached (deterministic for a few minutes)
const CACHEABLE_COMMANDS = new Set(['/day', '/status', '/week', '/todosummary', '/training today', '/training plan']);
const CHAT_CMD_TTL = 180; // 3 minutes
// NOTE: IOSAdapter exists but domain handlers currently don't accept an adapter parameter.
// Messages are processed via handler(message, userId) which returns { text, domain }.
// Buttons sent via Grammy InlineKeyboard are Telegram-specific and not captured here.
// Future: refactor domain handlers to accept MessageAdapter for platform-agnostic responses.
import type { DomainName } from '../../domains/types';

// Domain handlers — same functions used by bot.ts
// Lazy-loaded to avoid circular dependency issues
function getDomainHandlers(): Record<string, (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>> {
  const { handleSecretary } = require('../../domains/secretary');
  const { handleTriathlon } = require('../../domains/triathlon');
  const { handleContent } = require('../../domains/content-creator');
  const { handleFinance } = require('../../domains/finance');
  const { handleCooking } = require('../../domains/cooking');
  return {
    secretary: handleSecretary,
    triathlon: handleTriathlon,
    content: handleContent,
    finance: handleFinance,
    cooking: handleCooking,
  };
}

// Track last active domain per iOS user (for conversation continuity)
const lastActiveDomain = new Map<number, { domain: DomainName; timestamp: number }>();

export function chatRoutes(): Router {
  const router = Router();

  /**
   * POST /api/v1/chat/message
   * Send a message — equivalent to typing in Telegram.
   * Routes through Router → Domain Handler → returns AI response.
   *
   * For system commands (/day, /tasks, etc.), we route them through the
   * domain handler as natural language since the handler functions
   * accept the raw message text including the / prefix.
   */
  router.post('/message', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { text, attachments } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'text is required' },
      });
      return;
    }

    try {
      // Check cache for known deterministic commands (saves $0.02-0.05 per hit)
      const normalizedText = text.trim().toLowerCase();
      if (CACHEABLE_COMMANDS.has(normalizedText)) {
        const cacheKey = `chat-cmd:${userId}:${normalizedText}`;
        const cached = getCached(cacheKey);
        if (cached) {
          logger.debug({ cmd: normalizedText, platform: 'ios' }, 'Returning cached chat command');
          res.json(cached);
          return;
        }
      }

      // Build active conversation context
      let activeContext = null;
      const lastState = lastActiveDomain.get(userId);
      if (lastState && Date.now() - lastState.timestamp < 5 * 60 * 1000) {
        try {
          const { getLastAssistantMessage } = require('../../state/conversation');
          const lastMsg = getLastAssistantMessage(userId, lastState.domain);
          if (lastMsg) {
            activeContext = { domain: lastState.domain, lastAssistantMessage: lastMsg };
          }
        } catch { /* conversation state not available */ }
      }

      // Route the message (handles both commands and natural language)
      const route = await routeMessage(text, activeContext);
      logger.info({ domain: route.domain, method: route.method, confidence: route.confidence, platform: 'ios' }, 'iOS message routed');

      // Track domain for continuity
      lastActiveDomain.set(userId, { domain: route.domain, timestamp: Date.now() });

      // Execute domain handler
      const handlers = getDomainHandlers();
      const handler = handlers[route.domain];
      if (!handler) {
        res.status(400).json({
          error: { code: 'UNKNOWN_DOMAIN', message: `No handler for domain: ${route.domain}` },
        });
        return;
      }

      // Execute with a 40-second timeout (iOS client times out at 45s)
      // Secretary tool-use commands (/todo, /day) can take 15-30s with Claude Sonnet
      const handlerPromise = handler(route.strippedMessage, userId);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Response timeout — AI is taking too long')), 40000),
      );
      const result = await Promise.race([handlerPromise, timeoutPromise]);

      // Extract buttons from the response text if present.
      // The handler returns HTML text which may contain callback references.
      // Parse common button patterns from callback store.
      let buttons: { text: string; callbackData: string }[][] | null = null;
      try {
        const { getRecentCallbacks } = require('../../utils/callback-store');
        const recentCallbacks = getRecentCallbacks?.();
        if (recentCallbacks && recentCallbacks.length > 0) {
          // Convert to button rows (each callback becomes a button)
          const row = recentCallbacks.slice(0, 6).map((cb: { label: string; ref: string }) => ({
            text: cb.label || 'Action',
            callbackData: cb.ref,
          }));
          if (row.length > 0) {
            buttons = [row];
          }
        }
      } catch {
        // callback-store may not export getRecentCallbacks — buttons stay null
      }

      const response = {
        id: `msg-${Date.now()}`,
        text: result.text,
        domain: result.domain || route.domain,
        routeMethod: route.method,
        confidence: route.confidence,
        buttons,
        metadata: null,
        timestamp: new Date().toISOString(),
      };

      // Cache the response if it was a deterministic command
      if (CACHEABLE_COMMANDS.has(normalizedText)) {
        setCache(`chat-cmd:${userId}:${normalizedText}`, response, CHAT_CMD_TTL);
      }

      res.json(response);
    } catch (err: any) {
      logger.error({ err, text, platform: 'ios' }, 'iOS chat/message failed');
      res.status(500).json({
        error: { code: 'INTERNAL', message: err.message || 'Failed to process message' },
      });
    }
  });

  /**
   * POST /api/v1/chat/callback
   * Handle inline button presses (equivalent to Telegram callback queries).
   */
  router.post('/callback', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { callbackData, messageId } = req.body;

    if (!callbackData) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'callbackData is required' },
      });
      return;
    }

    try {
      // Resolve the callback data from the store
      const { getCallback } = require('../../utils/callback-store');
      const cbData = getCallback(callbackData);

      // The callback-query handler in the existing system processes these
      // For iOS, we need to handle the most common callback patterns:
      // td:tc:ref — todo complete
      // td:ls:ref — list select
      // td:dy:ref / td:dn:ref — delete yes/no
      const prefix = callbackData.split(':').slice(0, 2).join(':');
      let responseText = 'Action processed';
      let editOriginal = false;

      switch (prefix) {
        case 'td:tc': {
          // Complete a task
          if (cbData?.listId && cbData?.taskId) {
            const todo = require('../../services/microsoft-todo');
            await todo.completeTask(cbData.listId, cbData.taskId);
            responseText = `✅ Completed: ${cbData.title || 'task'}`;
            editOriginal = true;
          }
          break;
        }
        case 'td:dy': {
          // Delete confirmed
          if (cbData?.listId && cbData?.taskId) {
            const todo = require('../../services/microsoft-todo');
            await todo.deleteTask(cbData.listId, cbData.taskId);
            responseText = `🗑️ Deleted: ${cbData.title || 'task'}`;
            editOriginal = true;
          } else if (cbData?.listId && cbData?.type === 'list') {
            const todo = require('../../services/microsoft-todo');
            await todo.deleteList(cbData.listId);
            responseText = `🗑️ Deleted list: ${cbData.listName || 'list'}`;
            editOriginal = true;
          }
          break;
        }
        case 'td:dn': {
          responseText = 'Cancelled.';
          editOriginal = true;
          break;
        }
        default: {
          // Try generic callback handler
          try {
            const { handleCallbackAction } = require('../../handlers/callback-query');
            const result = await handleCallbackAction(callbackData, userId);
            if (result?.text) responseText = result.text;
            if (result?.editOriginal !== undefined) editOriginal = result.editOriginal;
          } catch {
            responseText = `Action "${prefix}" processed.`;
          }
        }
      }

      res.json({
        text: responseText,
        editOriginal,
        newButtons: null,
      });
    } catch (err: any) {
      logger.error({ err, callbackData, platform: 'ios' }, 'iOS callback failed');
      res.status(500).json({
        error: { code: 'INTERNAL', message: err.message || 'Failed to process callback' },
      });
    }
  });

  /**
   * GET /api/v1/chat/history?limit=50&before=<cursor>
   * Fetch conversation history.
   */
  router.get('/history', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
    const before = req.query.before as string | undefined;

    try {
      const db = (require('../../services/database') as typeof import('../../services/database')).getDb();

      let query = 'SELECT * FROM messages WHERE user_id = ?';
      const params: any[] = [userId];

      if (before) {
        query += ' AND created_at < ?';
        params.push(before);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit + 1);

      const rows = db.prepare(query).all(...params) as any[];
      const hasMore = rows.length > limit;
      const messages = rows.slice(0, limit).reverse().map(row => ({
        id: row.id?.toString() || `msg-${row.rowid}`,
        text: row.text || row.content || '',
        role: row.role || (row.is_bot ? 'assistant' : 'user'),
        domain: row.domain || null,
        timestamp: row.created_at || row.timestamp || new Date().toISOString(),
        buttons: null,
        metadata: null,
      }));

      res.json({
        messages,
        cursor: hasMore ? rows[limit]?.created_at : null,
        hasMore,
      });
    } catch (err: any) {
      logger.debug({ err }, 'iOS chat history query failed (table may not exist)');
      res.json({ messages: [], cursor: null, hasMore: false });
    }
  });

  return router;
}
