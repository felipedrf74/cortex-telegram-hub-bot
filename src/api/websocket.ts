// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WebSocket server for real-time streaming of AI responses to the iOS app.
 *
 * Protocol:
 *   Client sends:  { "type": "message", "text": "...", "token": "jwt" }
 *   Server streams: { "type": "chunk", "text": "partial text", "messageId": "msg-123" }
 *   Server ends:    { "type": "done", "messageId": "msg-123", "domain": "secretary", "metadata": null }
 *   Server error:   { "type": "error", "message": "..." }
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';
import { routeMessage } from '../router';
import type { DomainName } from '../domains/types';
import { generateRequestId, runWithContext } from '../utils/request-context';
import { pushEvent } from '../portal/telemetry';
import { getDb } from '../services/database';

function getDomainHandlers(): Record<string, (message: string, userId?: number, tenantId?: number) => Promise<{ text: string; domain: DomainName }>> {
  const { handleSecretary } = require('../domains/secretary');
  const { handleTriathlon } = require('../domains/triathlon');
  const { handleContent } = require('../domains/content-creator');
  const { handleFinance } = require('../domains/finance');
  const { handleCooking } = require('../domains/cooking');
  return {
    secretary: handleSecretary,
    triathlon: handleTriathlon,
    content: handleContent,
    finance: handleFinance,
    cooking: handleCooking,
  };
}

/**
 * Attach WebSocket server to the existing HTTP server.
 * Handles upgrade requests to /ws path.
 */
export function attachWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade to WebSocket
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Accept connection without auth — auth happens via first message payload
    // (JWT in URL query params appears in server access logs, which is a security risk)
    wss.handleUpgrade(request, socket, head, (ws) => {
      (ws as any).authenticated = false;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    logger.info({ platform: 'ios' }, 'WebSocket connected (pending auth)');

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // First message must be auth: { type: "auth", token: "jwt" }
        if (!(ws as any).authenticated) {
          if (msg.type !== 'auth' || !msg.token) {
            pushEvent({
              ts: new Date().toISOString(),
              type: 'auth',
              summary: 'iOS WS auth failed',
              detail: 'First message was not a valid auth frame',
              domain: 'secretary',
            });
            ws.send(JSON.stringify({ type: 'error', message: 'First message must be { type: "auth", token: "jwt" }' }));
            ws.close(4001, 'Auth required');
            return;
          }
          try {
            const payload = jwt.verify(msg.token, config.ios.jwtSecret) as { userId: number; deviceId: string };
            const db = getDb();
            const user = db.prepare('SELECT status FROM users WHERE id = ?').get(payload.userId) as { status?: string } | undefined;
            if (!user || (user.status && user.status !== 'active')) {
              throw new Error('inactive websocket user');
            }
            if (typeof payload.deviceId === 'string' && payload.deviceId.length > 0) {
              const device = db
                .prepare('SELECT 1 FROM ios_devices WHERE user_id = ? AND device_id = ?')
                .get(payload.userId, payload.deviceId) as { 1?: number } | undefined;
              if (!device) throw new Error('revoked websocket device');
            }
            (ws as any).userId = payload.userId;
            (ws as any).tenantId = payload.userId;
            (ws as any).deviceId = payload.deviceId;
            (ws as any).authenticated = true;
            ws.send(JSON.stringify({ type: 'auth_ok', userId: payload.userId, tenantId: payload.userId }));
            logger.info({ userId: payload.userId, tenantId: payload.userId, platform: 'ios' }, 'WebSocket authenticated');
            return;
          } catch {
            pushEvent({
              ts: new Date().toISOString(),
              type: 'auth',
              summary: 'iOS WS auth rejected',
              detail: 'JWT verification failed for WebSocket auth',
              domain: 'secretary',
            });
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            ws.close(4001, 'Invalid token');
            return;
          }
        }

        const userId = (ws as any).userId as number;
        const tenantId = (ws as any).tenantId as number;
        if (msg.type !== 'message' || !msg.text) return;

        await runWithContext(
          { requestId: generateRequestId(), source: 'http', userId },
          async () => {
            const messageId = `msg-${Date.now()}`;

            const route = await routeMessage(msg.text, undefined, userId, tenantId);

        // ─── Phase 1 Slice C — Tier gate for iOS WebSocket stream ───
        // Same gate as the REST chat endpoint. We emit an 'error' frame
        // with enough detail for the client to render a tier-upgrade
        // prompt, then close the message flow without invoking the
        // domain handler (so no tokens are spent on blocked users).
            try {
              const { getUserByTelegramId } = require('../services/user-service');
              const { checkTierAccess } = require('../services/skill-tiers');
              const user = getUserByTelegramId(userId);
              if (user) {
                const tierResult = checkTierAccess({ id: user.id, tier: user.tier }, route.domain);
                if (!tierResult.allowed) {
                  logger.info(
                    { userId, tenantId, domain: route.domain, userTier: tierResult.userTier, requiredTier: tierResult.requiredTier, reason: tierResult.reason },
                    'iOS WebSocket tier gate blocked',
                  );
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: 'error',
                      code: 'TIER_REQUIRED',
                      message: `This feature requires the ${tierResult.requiredTier} tier. Your current tier: ${tierResult.userTier}.`,
                      details: {
                        domain: route.domain,
                        userTier: tierResult.userTier,
                        requiredTier: tierResult.requiredTier,
                      },
                    }));
                  }
                  return;
                }
              }
            } catch (err) {
              logger.warn({ err }, 'iOS WebSocket tier gate check failed — falling through (fail-open)');
            }

            const handlers = getDomainHandlers();
            const handler = handlers[route.domain];

            if (!handler) {
              ws.send(JSON.stringify({ type: 'error', message: `No handler for ${route.domain}` }));
              return;
            }

            // Execute handler — for streaming, we simulate chunked delivery
            // since the domain handlers return full text at once
            const result = await handler(route.strippedMessage, userId, tenantId);

            // Stream the response in chunks
            const fullText = result.text;
            const chunkSize = 20; // characters per chunk
            for (let i = 0; i < fullText.length; i += chunkSize) {
              const chunk = fullText.slice(i, i + chunkSize);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'chunk',
                  text: chunk,
                  messageId,
                  userId,
                  tenantId,
                }));
              }
              // Small delay between chunks for visual streaming effect
              await new Promise(resolve => setTimeout(resolve, 30));
            }

            // Send completion
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'done',
                messageId,
                domain: result.domain || route.domain,
                userId,
                tenantId,
                metadata: null,
              }));
            }
          },
        );
      } catch (err: any) {
        pushEvent({
          ts: new Date().toISOString(),
          type: 'error',
          summary: 'iOS WS message failed',
          detail: err?.message || 'unknown websocket failure',
          domain: 'secretary',
        });
        logger.error({ err, platform: 'ios' }, 'WebSocket message handling failed');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      }
    });

    ws.on('close', () => {
      logger.debug({ userId: (ws as any).userId, tenantId: (ws as any).tenantId, platform: 'ios' }, 'WebSocket disconnected');
    });

    // Ping/pong for keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));
  });

  logger.info('WebSocket server attached on /ws');
}
