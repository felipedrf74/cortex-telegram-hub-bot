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

function getDomainHandlers(): Record<string, (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>> {
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

    // Authenticate via query param token
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const payload = jwt.verify(token, config.ios.jwtSecret) as {
        userId: number;
        deviceId: string;
      };

      wss.handleUpgrade(request, socket, head, (ws) => {
        (ws as any).userId = payload.userId;
        (ws as any).deviceId = payload.deviceId;
        wss.emit('connection', ws, request);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const userId = (ws as any).userId as number;
    logger.info({ userId, platform: 'ios' }, 'WebSocket connected');

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'message' || !msg.text) return;

        const messageId = `msg-${Date.now()}`;

        // Route the message
        const route = await routeMessage(msg.text);
        const handlers = getDomainHandlers();
        const handler = handlers[route.domain];

        if (!handler) {
          ws.send(JSON.stringify({ type: 'error', message: `No handler for ${route.domain}` }));
          return;
        }

        // Execute handler — for streaming, we simulate chunked delivery
        // since the domain handlers return full text at once
        const result = await handler(route.strippedMessage, userId);

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
            metadata: null,
          }));
        }
      } catch (err: any) {
        logger.error({ err, platform: 'ios' }, 'WebSocket message handling failed');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      }
    });

    ws.on('close', () => {
      logger.debug({ userId, platform: 'ios' }, 'WebSocket disconnected');
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
