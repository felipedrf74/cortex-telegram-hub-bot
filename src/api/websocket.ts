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
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { logger } from '../utils/logger';
import { routeMessage } from '../router';
import type { DomainName } from '../domains/types';
import { generateRequestId, runWithContext } from '../utils/request-context';
import { pushEvent } from '../portal/telemetry';
import { getDb } from '../services/database';
import { verifyIosJwt } from '../services/ios-jwt';
import { getUserLanguageById, getUserTimezoneById, resolveCurrentTenantIdForUser } from '../services/user-service';
import { config } from '../config';
import { tryHandleChatActionPlan } from '../services/chat';
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
import { withAiBudgetReservation } from '../services/cost-guardrail';
import { withAiCreditAdmission } from '../services/ai-credit-admission';
import { toStableAiBudgetError } from './response-helpers';
import { tryBuildChatCoreV2DeterministicReadRoute } from '../services/chat-core-v2';
import { buildChatCoreV2DeterministicReadShortcutResponse } from './routes/chat-core-v2-deterministic-read-response';
import {
  checkResponseLocaleFidelity,
  detectRetiredSpanishInputSignal,
  detectResponseLanguage,
  detectStrictShortResponseLanguage,
} from '../services/chat-language-detector';
import { runWithChatRequestLocale } from '../services/chat-request-locale-context';
import { normalizeSupportedLang } from '../utils/i18n';
import { buildManifestClassifierTerminalResponse } from '../services/chat-manifest-classifier-terminal';
import { runWithSkillInferenceAccountAdmission } from '../services/skill-inference-service';
import { isProviderRequestCancellation } from '../services/ai-provider';

const WEBSOCKET_RATE_WINDOW_MS = 60_000;
const WEBSOCKET_PING_INTERVAL_MS = 30_000;
export const DEFAULT_WEBSOCKET_MAX_FRAME_BYTES = 16 * 1024;
export const DEFAULT_WEBSOCKET_AUTH_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBSOCKET_MAX_CONNECTIONS = 100;
export const DEFAULT_WEBSOCKET_MAX_CONNECTIONS_PER_IP = 20;
const DEFAULT_ALLOWED_WEBSOCKET_ORIGINS = [
  'https://nexushub.me',
  'https://www.nexushub.me',
  'https://api.nexushub.me',
];
const activeWebSocketConnectionsByIp = new Map<string, number>();
let activeWebSocketConnectionCount = 0;

export function buildWebSocketAiBudgetErrorFrame(
  error: unknown,
  userId?: number,
  tenantId?: number,
): Record<string, unknown> | null {
  const budgetError = toStableAiBudgetError(error);
  if (!budgetError) return null;
  return {
    type: 'error',
    code: budgetError.code,
    message: budgetError.message,
    details: budgetError.details,
    userId,
    tenantId,
  };
}

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

export function webSocketMaxPayloadBytes(): number {
  const configured = Number.parseInt(process.env.IOS_WS_MAX_FRAME_BYTES || '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_WEBSOCKET_MAX_FRAME_BYTES;
  return Math.min(Math.max(configured, 1024), 64 * 1024);
}

function parseBoundedPositiveInteger(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

export function webSocketAuthTimeoutMs(): number {
  return parseBoundedPositiveInteger(
    process.env.IOS_WS_AUTH_TIMEOUT_MS,
    DEFAULT_WEBSOCKET_AUTH_TIMEOUT_MS,
    100,
    60_000,
  );
}

export function webSocketConnectionLimits(): { maxConnections: number; maxConnectionsPerIp: number } {
  return {
    maxConnections: parseBoundedPositiveInteger(
      process.env.IOS_WS_MAX_CONNECTIONS,
      DEFAULT_WEBSOCKET_MAX_CONNECTIONS,
      1,
      10_000,
    ),
    maxConnectionsPerIp: parseBoundedPositiveInteger(
      process.env.IOS_WS_MAX_CONNECTIONS_PER_IP,
      DEFAULT_WEBSOCKET_MAX_CONNECTIONS_PER_IP,
      1,
      1_000,
    ),
  };
}

export function resetWebSocketConnectionCountersForTests(): void {
  activeWebSocketConnectionsByIp.clear();
  activeWebSocketConnectionCount = 0;
}

export function webSocketFrameByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.byteLength(String(data), 'utf8');
}

function webSocketFrameToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

function webSocketRemoteIp(request: http.IncomingMessage): string {
  return request.socket.remoteAddress || 'unknown';
}

function rejectWebSocketUpgrade(socket: { write(data: string): void; destroy(): void }, status: number, reason: string): void {
  const body = `${reason}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n' +
    body,
  );
  socket.destroy();
}

function webSocketLimitRejectionReason(remoteIp: string): string | null {
  const limits = webSocketConnectionLimits();
  if (activeWebSocketConnectionCount >= limits.maxConnections) {
    return 'WebSocket connection limit exceeded';
  }
  if ((activeWebSocketConnectionsByIp.get(remoteIp) || 0) >= limits.maxConnectionsPerIp) {
    return 'WebSocket per-IP connection limit exceeded';
  }
  return null;
}

function registerWebSocketConnection(remoteIp: string): () => void {
  activeWebSocketConnectionCount += 1;
  activeWebSocketConnectionsByIp.set(remoteIp, (activeWebSocketConnectionsByIp.get(remoteIp) || 0) + 1);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    activeWebSocketConnectionCount = Math.max(0, activeWebSocketConnectionCount - 1);
    const nextForIp = Math.max(0, (activeWebSocketConnectionsByIp.get(remoteIp) || 0) - 1);
    if (nextForIp === 0) {
      activeWebSocketConnectionsByIp.delete(remoteIp);
    } else {
      activeWebSocketConnectionsByIp.set(remoteIp, nextForIp);
    }
  };
}

function getDomainHandlers(): Record<string, (
  message: string,
  userId?: number,
  tenantId?: number,
  abortSignal?: AbortSignal,
) => Promise<{ text: string; domain: DomainName }>> {
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

export interface WebSocketResponseLanguageGuard {
  contained: boolean;
  expected: 'es' | 'pt' | 'en' | 'unknown';
  detected: 'es' | 'pt' | 'en' | 'unknown';
  confidence: number;
}

export function resolveWebSocketResponseLocale(
  storedLocale: string | null | undefined,
  message: string,
): 'pt-BR' | 'pt-PT' | 'en-US' {
  const normalizedStoredLocale = normalizeSupportedLang(storedLocale, 'en-US');
  return (
    detectRetiredSpanishInputSignal(message)
    || detectResponseLanguage(message).language === 'es'
  )
    ? 'en-US'
    : normalizedStoredLocale;
}

function buildWebSocketLocaleMismatchReply(locale: string): string {
  if (locale === 'pt-PT') {
    return 'Não consegui apresentar esta resposta em português com segurança. Tenta enviar o pedido novamente.';
  }
  if (locale === 'pt-BR') {
    return 'Não consegui apresentar esta resposta em português com segurança. Tente enviar o pedido novamente.';
  }
  return "I couldn't safely deliver that reply in English. Please try your request again.";
}

/**
 * Runs the legacy WebSocket domain handler inside the request-locale scope
 * used by provider prompt builders, then performs a zero-provider language
 * check on the complete reply before the first chunk can be emitted.
 *
 * The detector fails open on short or mixed text. A confident mismatch is
 * replaced locally; the mismatched text is never returned to the streamer and
 * the handler is never retried.
 */
export async function executeWebSocketDomainHandlerWithLocale<
  T extends { text: string; domain: DomainName },
>(input: {
  locale: string | null | undefined;
  message: string;
  userId: number;
  tenantId: number;
  abortSignal?: AbortSignal;
  handler: (
    message: string,
    userId?: number,
    tenantId?: number,
    abortSignal?: AbortSignal,
  ) => Promise<T>;
}): Promise<{ response: T; languageGuard: WebSocketResponseLanguageGuard }> {
  // Spanish remains accepted only as an authored-input compatibility signal.
  // A confident Spanish message therefore selects the English response
  // contract even when an old/stored preference still points at Portuguese.
  // Uncertain input fails open to the stored locale, preserving regional PT.
  throwIfWebSocketRequestAborted(input.abortSignal);
  const effectiveLocale = resolveWebSocketResponseLocale(input.locale, input.message);
  const response = await runWithChatRequestLocale(
    effectiveLocale,
    () => input.handler(input.message, input.userId, input.tenantId, input.abortSignal),
  );
  throwIfWebSocketRequestAborted(input.abortSignal);
  const fidelity = checkResponseLocaleFidelity(effectiveLocale, response.text);
  const strictShortLanguage = detectStrictShortResponseLanguage(
    response.text,
    fidelity.expected,
  );
  const detected = strictShortLanguage ?? fidelity.detected;
  const contained = fidelity.expected !== 'unknown'
    && detected !== 'unknown'
    && detected !== fidelity.expected;
  const languageGuard: WebSocketResponseLanguageGuard = {
    contained,
    expected: fidelity.expected,
    detected,
    confidence: strictShortLanguage ? 1 : fidelity.confidence,
  };

  if (!contained) {
    return { response, languageGuard };
  }

  return {
    response: {
      ...response,
      text: buildWebSocketLocaleMismatchReply(effectiveLocale),
    },
    languageGuard,
  };
}

function webSocketClientDisconnectedError(): Error {
  return Object.assign(new Error('websocket_client_disconnected'), {
    name: 'AbortError',
    code: 'CHAT_REQUEST_CANCELLED',
  });
}

function throwIfWebSocketRequestAborted(abortSignal?: AbortSignal): void {
  if (!abortSignal?.aborted) return;
  throw abortSignal.reason instanceof Error
    ? abortSignal.reason
    : webSocketClientDisconnectedError();
}

function sendTrackedWebSocketFrame(
  ws: WebSocket,
  frame: Record<string, unknown>,
  options: { abortSignal?: AbortSignal; onPublished?: () => void } = {},
): boolean {
  throwIfWebSocketRequestAborted(options.abortSignal);
  if (ws.readyState !== WebSocket.OPEN) throw webSocketClientDisconnectedError();
  ws.send(JSON.stringify(frame));
  options.onPublished?.();
  return true;
}

async function streamTextFrame(
  ws: WebSocket,
  input: {
    text: string;
    messageId: string;
    userId: number;
    tenantId: number;
    abortSignal?: AbortSignal;
    onFirstChunk?: () => void;
  },
): Promise<void> {
  const chunkSize = 20;
  let firstChunkPublished = false;
  throwIfWebSocketRequestAborted(input.abortSignal);
  for (let i = 0; i < input.text.length; i += chunkSize) {
    throwIfWebSocketRequestAborted(input.abortSignal);
    if (ws.readyState !== WebSocket.OPEN) {
      if (input.abortSignal) throw webSocketClientDisconnectedError();
      return;
    }
    const chunk = input.text.slice(i, i + chunkSize);
    ws.send(JSON.stringify({
      type: 'chunk',
      text: chunk,
      messageId: input.messageId,
      userId: input.userId,
      tenantId: input.tenantId,
    }));
    if (!firstChunkPublished) {
      firstChunkPublished = true;
      input.onFirstChunk?.();
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    throwIfWebSocketRequestAborted(input.abortSignal);
  }
}

async function trySendTokenZeroSecretaryRead(
  ws: WebSocket,
  input: {
    text: string;
    messageId: string;
    userId: number;
    tenantId: number;
    locale: 'pt-BR' | 'pt-PT' | 'en-US';
    abortSignal: AbortSignal;
    onPublished: () => void;
  },
): Promise<boolean> {
  throwIfWebSocketRequestAborted(input.abortSignal);
  const read = tryBuildChatCoreV2DeterministicReadRoute({
    normalizedText: input.text,
    userId: input.userId,
    tenantId: input.tenantId,
    surface: 'ios',
    locale: input.locale,
    timezone: getUserTimezoneById(input.userId),
  });
  if (!read) return false;
  const built = buildChatCoreV2DeterministicReadShortcutResponse({
    result: read,
    requestStartedAt: Date.now(),
  });
  // The Free contract preserves deterministic Secretary reads/actions. Other
  // skill read models continue through their normal entitlement checks.
  if (built.conversationDomain !== 'secretary') return false;
  await streamTextFrame(ws, {
    text: built.response.text,
    messageId: input.messageId,
    userId: input.userId,
    tenantId: input.tenantId,
    abortSignal: input.abortSignal,
    onFirstChunk: input.onPublished,
  });
  sendTrackedWebSocketFrame(ws, {
    type: 'done',
    messageId: input.messageId,
    domain: 'secretary',
    userId: input.userId,
    tenantId: input.tenantId,
    metadata: { ...built.response.metadata, tokenZero: true },
  }, {
    abortSignal: input.abortSignal,
    onPublished: input.onPublished,
  });
  return true;
}

type WebSocketActionResult = NonNullable<Awaited<ReturnType<typeof tryHandleChatActionPlan>>>;

async function sendWebSocketActionResult(
  ws: WebSocket,
  actionResult: WebSocketActionResult,
  input: {
    messageId: string;
    userId: number;
    tenantId: number;
    abortSignal: AbortSignal;
    onPublished: () => void;
  },
): Promise<void> {
  const response = actionResult.response;
  const actionError = response.metadata?.error as { code?: string; message?: string; details?: unknown } | undefined;
  if (actionError?.code === 'TIER_REQUIRED' || actionError?.code === 'ACCESS_CHECK_UNAVAILABLE') {
    sendTrackedWebSocketFrame(ws, {
      type: 'error',
      code: actionError.code,
      message: actionError.message || response.text,
      details: actionError.details ?? null,
      messageId: input.messageId,
      userId: input.userId,
      tenantId: input.tenantId,
    }, input);
    return;
  }
  const hasWriteStep = actionResult.plan.steps.some((step) => step.risk !== 'read_only');
  const actionStatus = hasWriteStep && actionResult.status === 'needs_confirmation'
    ? 'ACTION_CONFIRMATION_REQUIRED'
    : response.metadata?.actionStatus ?? actionResult.status;
  sendTrackedWebSocketFrame(ws, {
    type: 'status',
    messageId: input.messageId,
    status: actionStatus,
    metadata: {
      type: response.metadata?.type,
      actionStatus,
      involvedSkills: response.metadata?.involvedSkills,
    },
    userId: input.userId,
    tenantId: input.tenantId,
  }, input);
  await streamTextFrame(ws, {
    text: response.text,
    messageId: input.messageId,
    userId: input.userId,
    tenantId: input.tenantId,
    abortSignal: input.abortSignal,
    onFirstChunk: input.onPublished,
  });
  sendTrackedWebSocketFrame(ws, {
    type: 'done',
    messageId: input.messageId,
    domain: response.domain,
    userId: input.userId,
    tenantId: input.tenantId,
    metadata: {
      ...response.metadata,
      ...(hasWriteStep && actionResult.status === 'needs_confirmation'
        ? { actionStatus: 'ACTION_CONFIRMATION_REQUIRED' }
        : {}),
      tokenZero: true,
    },
  }, input);
}

/**
 * Attach WebSocket server to the existing HTTP server.
 * Handles upgrade requests to /ws path.
 */
export function attachWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: webSocketMaxPayloadBytes() });

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

    const remoteIp = webSocketRemoteIp(request);
    const limitRejectionReason = webSocketLimitRejectionReason(remoteIp);
    if (limitRejectionReason) {
      logger.warn({ remoteIp, activeWebSocketConnectionCount }, 'WebSocket upgrade rejected due to connection limit');
      pushEvent({
        ts: new Date().toISOString(),
        type: 'auth',
        summary: 'iOS WS connection limit exceeded',
        detail: limitRejectionReason,
        domain: 'secretary',
      });
      rejectWebSocketUpgrade(socket, 429, 'Too Many Requests');
      return;
    }

    // Accept connection without auth — auth happens via first message payload
    // (JWT in URL query params appears in server access logs, which is a security risk)
    wss.handleUpgrade(request, socket, head, (ws) => {
      (ws as any).remoteIp = remoteIp;
      (ws as any).releaseConnectionSlot = registerWebSocketConnection(remoteIp);
      (ws as any).authenticated = false;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    logger.info({ platform: 'ios', remoteIp: (ws as any).remoteIp }, 'WebSocket connected (pending auth)');

    let authTimeout: ReturnType<typeof setTimeout> | undefined;
    let pingInterval: ReturnType<typeof setInterval> | undefined;
    let cleanedUp = false;

    const clearAuthTimeout = () => {
      if (!authTimeout) return;
      clearTimeout(authTimeout);
      authTimeout = undefined;
    };

    const cleanupConnection = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearAuthTimeout();
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = undefined;
      }
      const releaseConnectionSlot = (ws as any).releaseConnectionSlot as (() => void) | undefined;
      releaseConnectionSlot?.();
      logger.debug({ userId: (ws as any).userId, tenantId: (ws as any).tenantId, platform: 'ios' }, 'WebSocket disconnected');
    };

    (ws as any).isAlive = true;
    ws.on('pong', () => {
      (ws as any).isAlive = true;
    });

    authTimeout = setTimeout(() => {
      if ((ws as any).authenticated) return;
      pushEvent({
        ts: new Date().toISOString(),
        type: 'auth',
        summary: 'iOS WS auth timeout',
        detail: 'WebSocket did not authenticate before timeout',
        domain: 'secretary',
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', code: 'AUTH_TIMEOUT', message: 'Authentication timed out. Please reconnect.' }));
        ws.close(4001, 'Auth timeout');
        const terminateTimer = setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.terminate();
          }
        }, 250);
        if (typeof (terminateTimer as any).unref === 'function') (terminateTimer as any).unref();
        return;
      }
      ws.terminate();
    }, webSocketAuthTimeoutMs());
    if (typeof (authTimeout as any).unref === 'function') (authTimeout as any).unref();

    pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if ((ws as any).isAlive === false) {
        pushEvent({
          ts: new Date().toISOString(),
          type: 'auth',
          summary: 'iOS WS liveness timeout',
          detail: 'WebSocket did not respond to ping',
          domain: 'secretary',
        });
        ws.terminate();
        return;
      }
      (ws as any).isAlive = false;
      ws.ping();
    }, WEBSOCKET_PING_INTERVAL_MS);
    if (typeof (pingInterval as any).unref === 'function') (pingInterval as any).unref();

    ws.on('message', async (data) => {
      let modelResponsePublished = false;
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

        const frameBytes = webSocketFrameByteLength(data);
        if (frameBytes > webSocketMaxPayloadBytes()) {
          pushEvent({
            ts: new Date().toISOString(),
            type: 'auth',
            summary: 'iOS WS frame rejected',
            detail: 'WebSocket frame exceeded maximum payload size',
            domain: 'secretary',
          });
          ws.send(JSON.stringify({ type: 'error', code: 'PAYLOAD_TOO_LARGE', message: 'Message is too large.' }));
          ws.close(1009, 'Message too large');
          return;
        }

        let msg: any;
        try {
          msg = JSON.parse(webSocketFrameToString(data));
        } catch (parseErr) {
          if (!(ws as any).authenticated) {
            pushEvent({
              ts: new Date().toISOString(),
              type: 'auth',
              summary: 'iOS WS auth failed',
              detail: 'First message was not valid JSON',
              domain: 'secretary',
            });
            ws.send(JSON.stringify({ type: 'error', message: 'First message must be a valid auth JSON frame.' }));
            ws.close(4001, 'Invalid auth frame');
            return;
          }
          throw parseErr;
        }

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
            clearAuthTimeout();
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
        const clientAbortController = new AbortController();
        const abortMessageOnSocketClose = (): void => {
          if (clientAbortController.signal.aborted) return;
          clientAbortController.abort(webSocketClientDisconnectedError());
        };
        ws.once('close', abortMessageOnSocketClose);
        ws.once('error', abortMessageOnSocketClose);
        try {
          if (tenantId !== resolveCurrentTenantIdForUser(userId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Tenant scope changed. Please reconnect.' }));
            ws.close(4003, 'Tenant scope changed');
            return;
          }

          await runWithContext(
          { requestId: generateRequestId(), source: 'http', userId, tenantId },
          async () => {
            const messageId = `msg-${Date.now()}`;
            const messageText = String(msg.text);
            const responseLocale = resolveWebSocketResponseLocale(
              getUserLanguageById(userId),
              messageText,
            );

            // Resolve deterministic Secretary reads before acquiring the AI
            // lock. Free users and quota-exhausted paid users must not queue
            // behind a long provider call for token-zero state access.
            const tokenZeroReadHandled = await runWithSkillInferenceAccountAdmission({
              userId,
              abortSignal: clientAbortController.signal,
            }, (accountAbortSignal) => trySendTokenZeroSecretaryRead(ws, {
              text: messageText,
              messageId,
              userId,
              tenantId,
              locale: responseLocale,
              abortSignal: accountAbortSignal,
              onPublished: () => { modelResponsePublished = true; },
            }));
            if (tokenZeroReadHandled) {
              return;
            }

            const deterministicActionHandled = await runWithSkillInferenceAccountAdmission({
              userId,
              abortSignal: clientAbortController.signal,
            }, async (accountAbortSignal) => {
              const deterministicAction = await tryHandleChatActionPlan({
                text: messageText,
                userId,
                tenantId,
                conversationId: typeof msg.clientMessageId === 'string' && msg.clientMessageId.trim()
                  ? msg.clientMessageId.trim()
                  : messageId,
                messageId,
                channel: 'ios',
                locale: responseLocale,
                timezone: getUserTimezoneById(userId),
                requireSafeWriteConfirmation: true,
                blockNonReadOnlyPlans: true,
                allowModelPlanner: false,
                abortSignal: accountAbortSignal,
              });
              if (!deterministicAction) return false;
              await sendWebSocketActionResult(ws, deterministicAction, {
                messageId,
                userId,
                tenantId,
                abortSignal: accountAbortSignal,
                onPublished: () => { modelResponsePublished = true; },
              });
              return true;
            });
            if (deterministicActionHandled) return;

            // Once this turn enters the paid/model-backed block, keep both the
            // account-deletion fence and client lifecycle attached through
            // routing, validation, and the final WebSocket frame.
            await runWithSkillInferenceAccountAdmission({
              userId,
              abortSignal: clientAbortController.signal,
            }, (accountAbortSignal) => withAiCreditAdmission({
              userId,
              tenantScope: String(tenantId),
              operationClass: 'standard',
              workload: 'ios_websocket_chat',
              clientOperationId: messageId,
            }, () => withAiBudgetReservation({
              userId,
              requestSource: 'interactive',
              baseCategory: 'ios_websocket_chat',
              jobName: 'ios_websocket',
            }, async () => {
            const streamModelResponse = (input: {
              text: string;
              messageId: string;
              userId: number;
              tenantId: number;
            }) => streamTextFrame(ws, {
              ...input,
              abortSignal: accountAbortSignal,
              onFirstChunk: () => { modelResponsePublished = true; },
            });
            const sendModelFrame = (frame: Record<string, unknown>): boolean => sendTrackedWebSocketFrame(
              ws,
              frame,
              {
                abortSignal: accountAbortSignal,
                onPublished: () => { modelResponsePublished = true; },
              },
            );
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
            const preGateDomain = preRoutingDecision.primaryDomain
              ?? (preTurnContract ? domainForWebSocketTurnContractSkill(preTurnContract.skill) : null)
              ?? 'secretary';

        // ─── Phase 1 Slice C — Tier gate for iOS WebSocket stream ───
        // Same gate as the REST chat endpoint. We emit an 'error' frame
        // with enough detail for the client to render a tier-upgrade
        // prompt, then close the message flow without invoking the
        // domain handler (so no tokens are spent on blocked users).
            try {
              const { getUserById } = require('../services/user-service');
              const { checkSkillAccess } = require('../services/skill-tiers');
              const { entitlementPlanToSkillTier, getEffectiveEntitlement } = require('../services/entitlement');
              // iOS WebSocket auth resolves the internal user id directly;
              // the legacy platform-id fallback lookup was removed in the
              // 2026-07 messaging-platform purge (Stage A).
              const user = getUserById(userId);
              if (user) {
                const entitlement = getEffectiveEntitlement(user.id);
                const tierResult = checkSkillAccess(
                  { id: user.id, tier: entitlementPlanToSkillTier(entitlement.plan) },
                  preGateDomain,
                );
                if (!tierResult.allowed) {
                  logger.info(
                    { userId, tenantId, domain: preGateDomain, userTier: tierResult.userTier, requiredTier: tierResult.requiredTier, reason: tierResult.reason },
                    'iOS WebSocket tier gate blocked',
                  );
                  sendModelFrame({
                    type: 'error',
                    code: 'TIER_REQUIRED',
                    message: `This feature requires the ${tierResult.requiredTier} tier. Your current tier: ${tierResult.userTier}.`,
                    details: {
                      domain: preGateDomain,
                      userTier: tierResult.userTier,
                      requiredTier: tierResult.requiredTier,
                    },
                  });
                  return;
                }
              }
            } catch (err) {
              logger.warn({ err, userId, tenantId, domain: preGateDomain }, 'iOS WebSocket tier gate check failed — fail-closed');
              if (sendModelFrame({
                type: 'error',
                code: 'ACCESS_CHECK_UNAVAILABLE',
                message: 'Nexus could not verify access for this request. Please reconnect and try again.',
                details: { domain: preGateDomain },
              })) {
                ws.close(1011, 'Access check unavailable');
              }
              return;
            }

            const actionResult = await tryHandleChatActionPlan({
              text: messageText,
              userId,
              tenantId,
              conversationId: typeof msg.clientMessageId === 'string' && msg.clientMessageId.trim()
                ? msg.clientMessageId.trim()
                : messageId,
              messageId,
              channel: 'ios',
              locale: responseLocale,
              timezone: getUserTimezoneById(userId),
              requireSafeWriteConfirmation: true,
              blockNonReadOnlyPlans: true,
              abortSignal: accountAbortSignal,
            });
            if (actionResult) {
              const response = actionResult.response;
              const actionError = response.metadata?.error as { code?: string; message?: string; details?: unknown } | undefined;
              if (actionError?.code === 'TIER_REQUIRED' || actionError?.code === 'ACCESS_CHECK_UNAVAILABLE') {
                sendModelFrame({
                  type: 'error',
                  code: actionError.code,
                  message: actionError.message || response.text,
                  details: actionError.details ?? null,
                  messageId,
                  userId,
                  tenantId,
                });
                return;
              }
              const hasWriteStep = actionResult.plan.steps.some((step) => step.risk !== 'read_only');
              if (hasWriteStep && actionResult.status === 'needs_confirmation') {
                sendModelFrame({
                  type: 'status',
                  messageId,
                  status: 'ACTION_CONFIRMATION_REQUIRED',
                  metadata: {
                    type: 'chat_action_confirmation_required',
                    actionStatus: 'ACTION_CONFIRMATION_REQUIRED',
                    involvedSkills: response.metadata?.involvedSkills,
                  },
                  userId,
                  tenantId,
                });
                await streamModelResponse({
                  text: response.text,
                  messageId,
                  userId,
                  tenantId,
                });
                sendModelFrame({
                  type: 'done',
                  messageId,
                  domain: response.domain,
                  userId,
                  tenantId,
                  metadata: {
                    ...response.metadata,
                    actionStatus: 'ACTION_CONFIRMATION_REQUIRED',
                  },
                });
                return;
              }
              sendModelFrame({
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
              });
              await streamModelResponse({
                text: response.text,
                messageId,
                userId,
                tenantId,
              });
              sendModelFrame({
                type: 'done',
                messageId,
                domain: response.domain,
                userId,
                tenantId,
                metadata: response.metadata,
              });
              return;
            }

            const rawRoute = await routeMessage(
              messageText,
              undefined,
              userId,
              tenantId,
              accountAbortSignal,
            );
            if (rawRoute.disposition) {
              const classifierTerminal = buildManifestClassifierTerminalResponse(
                rawRoute.disposition,
                responseLocale,
              );
              await streamModelResponse({
                text: classifierTerminal.text,
                messageId,
                userId,
                tenantId,
              });
              sendModelFrame({
                type: 'done',
                messageId,
                domain: classifierTerminal.domain,
                userId,
                tenantId,
                metadata: {
                  type: 'chat_manifest_classifier_terminal',
                  disposition: classifierTerminal.disposition,
                  actionStatus: classifierTerminal.actionStatus,
                  reasonCodes: classifierTerminal.reasonCodes,
                },
              });
              logger.info(
                { userId, tenantId, disposition: classifierTerminal.disposition },
                'iOS WebSocket chat terminated on an explicit manifest-classifier outcome',
              );
              return;
            }
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

            if (preTurnContract?.riskClass === 'destructive' || routingDecision.safety.destructive) {
              const text = preTurnContract?.language === 'pt' || preTurnContract?.language === 'mixed'
                ? 'Não vou executar ações destrutivas por streaming sem uma confirmação verificada no Nexus. Abre o app/Decision Center para rever e confirmar com segurança.'
                : 'I will not execute destructive streaming actions without verified Nexus confirmation. Open the app or Decision Center to review and confirm safely.';
              await streamModelResponse({ text, messageId, userId, tenantId });
              sendModelFrame({
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
              });
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
                abortSignal: accountAbortSignal,
              });
              await streamModelResponse({ text: research.text, messageId, userId, tenantId });
              sendModelFrame({
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
              });
              logger.info(
                { userId, tenantId, domain: researchDomain, sourceCount: research.sources.length, degraded: research.degraded },
                'iOS WebSocket handled selective internet research turn',
              );
              return;
            }

            const handlers = getDomainHandlers();
            const handler = handlers[route.domain];

            if (!handler) {
              sendModelFrame({ type: 'error', message: `No handler for ${route.domain}` });
              return;
            }

            // Execute handler — for streaming, we simulate chunked delivery
            // since the domain handlers return full text at once
            const executed = await executeWebSocketDomainHandlerWithLocale({
              locale: responseLocale,
              message: route.strippedMessage,
              userId,
              tenantId,
              abortSignal: accountAbortSignal,
              handler,
            });
            const result = executed.response;
            if (executed.languageGuard.contained) {
              logger.warn(
                {
                  userId,
                  tenantId,
                  domain: result.domain || route.domain,
                  expectedLanguage: executed.languageGuard.expected,
                  detectedLanguage: executed.languageGuard.detected,
                  detectionConfidence: executed.languageGuard.confidence,
                },
                'Contained mismatched iOS WebSocket response language before streaming',
              );
            }

            await streamModelResponse({ text: result.text, messageId, userId, tenantId });

            // Send completion
            sendModelFrame({
              type: 'done',
              messageId,
              domain: result.domain || route.domain,
              userId,
              tenantId,
              metadata: executed.languageGuard.contained
                ? {
                  type: 'chat_response_locale_contained',
                  responseLanguageGuard: executed.languageGuard,
                }
                : null,
            });
            })));
          },
          );
        } finally {
          ws.off('close', abortMessageOnSocketClose);
          ws.off('error', abortMessageOnSocketClose);
        }
      } catch (err: any) {
        if (err?.code === 'ACCOUNT_DELETION_IN_PROGRESS') {
          if (!modelResponsePublished && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'ACCOUNT_DELETION_IN_PROGRESS',
              message: 'No new chat work can start while this account is being deleted.',
            }));
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(4003, 'Account unavailable');
          }
          return;
        }
        if (isProviderRequestCancellation(err)) return;
        const budgetErrorFrame = buildWebSocketAiBudgetErrorFrame(
          err,
          (ws as any).userId,
          (ws as any).tenantId,
        );
        if (budgetErrorFrame) {
          logger.warn(
            { userId: (ws as any).userId, tenantId: (ws as any).tenantId, code: budgetErrorFrame.code, platform: 'ios_ws' },
            'iOS WebSocket blocked by AI budget policy',
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(budgetErrorFrame));
          }
          return;
        }
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

    ws.on('close', cleanupConnection);
    ws.on('error', cleanupConnection);
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
