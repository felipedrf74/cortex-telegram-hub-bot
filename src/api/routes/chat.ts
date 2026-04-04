// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage, isSystemCommand } from '../../router';
import { logger } from '../../utils/logger';
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
      // Check if it's a system command
      const systemCmd = isSystemCommand(text);
      if (systemCmd) {
        // Handle system commands directly
        // /help, /status, /clear etc. — return informational response
        res.json({
          id: `msg-${Date.now()}`,
          text: `System command "${systemCmd}" processed.`,
          domain: 'system',
          routeMethod: 'pattern',
          confidence: 1.0,
          buttons: null,
          metadata: null,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Build active conversation context
      let activeContext = null;
      const lastState = lastActiveDomain.get(userId);
      if (lastState && Date.now() - lastState.timestamp < 5 * 60 * 1000) {
        // Within 5-minute continuity window
        try {
          const { getLastAssistantMessage } = require('../../state/conversation');
          const lastMsg = getLastAssistantMessage(userId, lastState.domain);
          if (lastMsg) {
            activeContext = { domain: lastState.domain, lastAssistantMessage: lastMsg };
          }
        } catch { /* conversation state not available */ }
      }

      // Route the message
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

      const result = await handler(route.strippedMessage, userId);

      res.json({
        id: `msg-${Date.now()}`,
        text: result.text,
        domain: result.domain || route.domain,
        routeMethod: route.method,
        confidence: route.confidence,
        buttons: null, // TODO: extract from IOSAdapter when integrated
        metadata: null,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.error({ err, text, platform: 'ios' }, 'iOS chat/message failed');
      res.status(500).json({
        error: { code: 'INTERNAL', message: err.message || 'Failed to process message' },
      });
    }
  });

  /**
   * POST /api/v1/chat/callback
   * Handle inline button presses.
   */
  router.post('/callback', async (req, res: Response) => {
    const { callbackData, messageId } = req.body;

    if (!callbackData) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'callbackData is required' },
      });
      return;
    }

    try {
      // Import the callback handler from the existing system
      const { handleCallbackAction } = require('../../handlers/callback-query');
      const result = await handleCallbackAction(callbackData, (req as AuthenticatedRequest).userId);

      res.json({
        text: result?.text || 'Action processed',
        editOriginal: result?.editOriginal ?? false,
        newButtons: result?.newButtons || null,
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
      params.push(limit + 1); // +1 to check hasMore

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
      // If messages table doesn't exist yet, return empty
      logger.debug({ err }, 'iOS chat history query failed (table may not exist)');
      res.json({ messages: [], cursor: null, hasMore: false });
    }
  });

  return router;
}
