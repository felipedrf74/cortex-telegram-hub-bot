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
import { logger } from '../utils/logger';
import { routeMessage } from '../router';
import type { DomainName } from '../domains/types';
import { generateRequestId, runWithContext } from '../utils/request-context';
import { pushEvent } from '../portal/telemetry';
import { getDb } from '../services/database';
import { verifyIosJwt } from '../services/ios-jwt';
import { getUserLanguageById, getUserTimezoneById, resolveCurrentTenantIdForUser } from '../services/user-service';
import { config } from '../config';
import { tryHandleChatActionPlan } from '../services/chat-action-planner';
import {
  analyzeChatSkillOrchestration,
  applyChatSkillRoutingDecision,
  buildChatSkillRoutingLogContext,
} from '../services/chat-skill-orchestrator';
import { inferChatTurnContract, type ChatTurnContract } from '../services/chat-turn-contract';
import { buildChatInternetResearchAnswer } from '../services/chat-internet-research';
import {
  isChatResearchRouterEnabled,
  isChatTurnContractEnabled,
} from '../services/runtime-flags';
import { buildSimpleStateContext } from '../domains/domain-handler';
import type { NexusChatOwnerSkill } from '../services/chat-answer-contract';

const WEBSOCKET_RATE_WINDOW_MS = 60_000;
const DEFAULT_ALLOWED_WEBSOCKET_ORIGINS = [
  'https://nexushub.me',
  'https://www.nexushub.me',
  'https://api.nexushub.me',
];

function normalizedAllowedWebSocketOrigins(): Set<string> {
  const configured = (process.env.IOS_WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = configured.length > 0 ? configured : DEFAULT_ALLOWED_WEBSOCKET_ORIGINS;
  return new Set(origins.map((origin) => {
    try {
      return new URL(origin).origin.toLowerCase();
    } catch {
      return origin.toLowerCase();
    }
  }));
}

export function isAllowedWebSocketOrigin(originHeader: string | string[] | undefined): boolean {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin) return true; // Native iOS clients normally omit Origin.
  if (origin.trim().toLowerCase() === 'null') return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const normalized = parsed.origin.toLowerCase();
  if (normalizedAllowedWebSocketOrigins().has(normalized)) return true;

  const isLocalDevelopment = process.env.NODE_ENV !== 'production' && process.env.STAGING !== 'true';
  if (isLocalDevelopment && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }

  return false;
}

export function consumeWebSocketMessageBudget(
  state: { messageTimestamps?: number[] },
  now = Date.now(),
  limit = config.ios.rateLimit,
): boolean {
  const safeLimit = Math.max(1, Math.floor(limit || 1));
  const current = Array.isArray(state.messageTimestamps) ? state.messageTimestamps : [];
  const recent = current.filter((timestamp) => Number.isFinite(timestamp) && now - timestamp < WEBSOCKET_RATE_WINDOW_MS);
  recent.push(now);
  state.messageTimestamps = recent;
  return recent.length <= safeLimit;
}

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

async function streamTextFrame(
  ws: WebSocket,
  input: {
    text: string;
    messageId: string;
    userId: number;
    tenantId: number;
  },
): Promise<void> {
  const chunkSize = 20;
  for (let i = 0; i < input.text.length; i += chunkSize) {
    const chunk = input.text.slice(i, i + chunkSize);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'chunk',
        text: chunk,
        messageId: input.messageId,
        userId: input.userId,
        tenantId: input.tenantId,
      }));
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
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

    if (!isAllowedWebSocketOrigin(request.headers.origin)) {
      logger.warn({ origin: request.headers.origin }, 'WebSocket upgrade rejected due to untrusted Origin');
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
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
        if (!consumeWebSocketMessageBudget(ws as any)) {
          pushEvent({
            ts: new Date().toISOString(),
            type: 'auth',
            summary: 'iOS WS rate limit exceeded',
            detail: 'WebSocket message rate limit exceeded',
            domain: 'secretary',
          });
          ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMITED', message: 'Too many messages. Please reconnect and try again.' }));
          ws.close(1008, 'Rate limited');
          return;
        }

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
            const payload = verifyIosJwt(msg.token) as { userId: number; tenantId?: number; deviceId: string };
            const db = getDb();
            const user = db.prepare('SELECT status FROM users WHERE id = ?').get(payload.userId) as { status?: string } | undefined;
            if (!user || (user.status && user.status !== 'active')) {
              throw new Error('inactive websocket user');
            }
            const canonicalTenantId = resolveCurrentTenantIdForUser(payload.userId);
            const tokenTenantId = typeof payload.tenantId === 'number' && Number.isInteger(payload.tenantId)
              ? payload.tenantId
              : canonicalTenantId;
            if (tokenTenantId !== canonicalTenantId) {
              throw new Error('websocket tenant mismatch');
            }
            if (typeof payload.deviceId === 'string' && payload.deviceId.length > 0) {
              const device = db
                .prepare('SELECT 1 FROM ios_devices WHERE user_id = ? AND device_id = ?')
                .get(payload.userId, payload.deviceId) as { 1?: number } | undefined;
              if (!device) throw new Error('revoked websocket device');
            }
            (ws as any).userId = payload.userId;
            (ws as any).tenantId = canonicalTenantId;
            (ws as any).deviceId = payload.deviceId;
            (ws as any).authenticated = true;
            ws.send(JSON.stringify({ type: 'auth_ok', userId: payload.userId, tenantId: canonicalTenantId }));
            logger.info({ userId: payload.userId, tenantId: canonicalTenantId, platform: 'ios' }, 'WebSocket authenticated');
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
        if (tenantId !== resolveCurrentTenantIdForUser(userId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Tenant scope changed. Please reconnect.' }));
          ws.close(4003, 'Tenant scope changed');
          return;
        }

        await runWithContext(
          { requestId: generateRequestId(), source: 'http', userId, tenantId },
          async () => {
            const messageId = `msg-${Date.now()}`;

            const actionResult = await tryHandleChatActionPlan({
              text: String(msg.text),
              userId,
              tenantId,
              conversationId: typeof msg.clientMessageId === 'string' && msg.clientMessageId.trim()
                ? msg.clientMessageId.trim()
                : messageId,
              messageId,
              channel: 'ios',
              locale: getUserLanguageById(userId) || undefined,
              timezone: getUserTimezoneById(userId),
            });
            if (actionResult) {
              const response = actionResult.response;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'status',
                  messageId,
                  status: response.metadata?.actionStatus ?? actionResult.status,
                  metadata: {
                    type: response.metadata?.type,
                    actionStatus: response.metadata?.actionStatus,
                    involvedSkills: response.metadata?.involvedSkills,
                  },
                  userId,
                  tenantId,
                }));
              }
              await streamTextFrame(ws, {
                text: response.text,
                messageId,
                userId,
                tenantId,
              });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'done',
                  messageId,
                  domain: response.domain,
                  userId,
                  tenantId,
                  metadata: response.metadata,
                }));
              }
              return;
            }

            const messageText = String(msg.text);
            const preRoutingDecision = analyzeChatSkillOrchestration({
              message: messageText,
              userId,
              tenantId,
            });
            const preTurnContract = isChatTurnContractEnabled(process.env, { userId, tenantId })
              ? inferChatTurnContract({
                message: messageText,
                involvedSkills: preRoutingDecision.involvedSkills,
              })
              : null;
            const rawRoute = await routeMessage(messageText, undefined, userId, tenantId);
            const contractAwareRoute = preTurnContract ? applyWebSocketTurnContractRouteHint(rawRoute, preTurnContract) : rawRoute;
            const routingDecision = analyzeChatSkillOrchestration({
              message: messageText,
              routedDomain: contractAwareRoute.domain,
              userId,
              tenantId,
            });
            const route = applyChatSkillRoutingDecision(contractAwareRoute, routingDecision);
            logger.info(
              {
                userId,
                tenantId,
                domain: route.domain,
                method: route.method,
                orchestration: buildChatSkillRoutingLogContext(routingDecision),
                contractSkill: preTurnContract?.skill ?? null,
                contractRouteKind: preTurnContract?.routeKind ?? null,
              },
              'iOS WebSocket message routed',
            );

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
              logger.warn({ err, userId, tenantId, domain: route.domain }, 'iOS WebSocket tier gate check failed — fail-closed');
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'error',
                  code: 'ACCESS_CHECK_UNAVAILABLE',
                  message: 'Nexus could not verify access for this request. Please reconnect and try again.',
                  details: { domain: route.domain },
                }));
                ws.close(1011, 'Access check unavailable');
              }
              return;
            }

            if (preTurnContract?.riskClass === 'destructive' || routingDecision.safety.destructive) {
              const text = preTurnContract?.language === 'pt' || preTurnContract?.language === 'mixed'
                ? 'Não vou executar ações destrutivas por streaming sem uma confirmação verificada no Nexus. Abre o app/Decision Center para rever e confirmar com segurança.'
                : 'I will not execute destructive streaming actions without verified Nexus confirmation. Open the app or Decision Center to review and confirm safely.';
              await streamTextFrame(ws, { text, messageId, userId, tenantId });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'done',
                  messageId,
                  domain: route.domain,
                  userId,
                  tenantId,
                  metadata: {
                    type: 'chat_destructive_guardrail',
                    riskClass: preTurnContract?.riskClass ?? 'destructive',
                    routeKind: preTurnContract?.routeKind ?? 'action',
                  },
                }));
              }
              logger.warn({ userId, tenantId, domain: route.domain }, 'iOS WebSocket destructive chat turn blocked');
              return;
            }

            if (
              isChatResearchRouterEnabled(process.env, { userId, tenantId })
              && preTurnContract?.routeKind === 'internet_research'
              && (preTurnContract.groundingRequired === 'web' || preTurnContract.groundingRequired === 'local_and_web')
            ) {
              const researchDomain = domainForWebSocketTurnContractSkill(preTurnContract.skill) ?? route.domain;
              const localContext = preTurnContract.groundingRequired === 'local_and_web'
                ? await buildSimpleStateContext(researchDomain, userId, messageText, tenantId)
                : null;
              const research = await buildChatInternetResearchAnswer({
                message: messageText,
                language: preTurnContract.language,
                skill: preTurnContract.skill,
                expectedResponseShape: preTurnContract.expectedResponseShape,
                userId,
                tenantId,
                groundingRequired: preTurnContract.groundingRequired,
                localContext,
              });
              await streamTextFrame(ws, { text: research.text, messageId, userId, tenantId });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'done',
                  messageId,
                  domain: researchDomain,
                  userId,
                  tenantId,
                  metadata: {
                    type: 'chat_internet_research',
                    webSources: research.sources,
                    degraded: research.degraded,
                    degradedReason: research.degradedReason ?? null,
                    routeKind: preTurnContract.routeKind,
                    groundingRequired: preTurnContract.groundingRequired,
                    contextCompiler: research.context ?? null,
                  },
                }));
              }
              logger.info(
                { userId, tenantId, domain: researchDomain, sourceCount: research.sources.length, degraded: research.degraded },
                'iOS WebSocket handled selective internet research turn',
              );
              return;
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

            await streamTextFrame(ws, { text: result.text, messageId, userId, tenantId });

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

function domainForWebSocketTurnContractSkill(skill: NexusChatOwnerSkill): DomainName | null {
  switch (skill) {
    case 'secretary':
    case 'tasks':
    case 'connections':
    case 'notifications':
    case 'decision_center':
      return 'secretary';
    case 'training':
      return 'triathlon';
    case 'content':
    case 'finance':
    case 'cooking':
      return skill;
    default:
      return null;
  }
}

function shouldApplyWebSocketTurnContractRouteHint(contract: ChatTurnContract, route: { domain: string; confidence: number }): boolean {
  if (contract.routeKind === 'action') return false;
  if (contract.riskClass === 'high' || contract.riskClass === 'destructive') return false;
  if (contract.skill === 'chat' || contract.skill === 'system' || contract.skill === 'owner_admin') return false;
  const hintedDomain = domainForWebSocketTurnContractSkill(contract.skill);
  if (!hintedDomain || route.domain === hintedDomain) return false;
  return contract.confidence >= 0.8;
}

function applyWebSocketTurnContractRouteHint<T extends { domain: string; method: string; confidence: number }>(
  route: T,
  contract: ChatTurnContract,
): T {
  if (!shouldApplyWebSocketTurnContractRouteHint(contract, route)) return route;
  const hintedDomain = domainForWebSocketTurnContractSkill(contract.skill);
  if (!hintedDomain) return route;
  return {
    ...route,
    domain: hintedDomain,
    method: `${route.method}+turn-contract`,
    confidence: Math.max(route.confidence, contract.confidence),
  };
}
