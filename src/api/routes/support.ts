// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Support routes — in-app feedback intake for the iOS app.
 *
 *   POST /api/v1/support/feedback       create a feedback/bug/question ticket
 *   GET  /api/v1/support/feedback/mine  the caller's own tickets (status only)
 *
 * Privacy: the body accepts an allowlisted diagnostics context only
 * (screen, appVersion, osVersion, deviceModel, lastClientErrorId) plus an
 * optional x-request-id the app observed. Chat content is never accepted or
 * attached. Rate limited to 5 tickets per user per hour.
 *
 * Auth: JWT (mounted under the protected router).
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import {
  countUserTicketsSince,
  createTicket,
  listTicketsForUser,
  TICKET_TITLE_MAX,
  type TicketKind,
} from '../../services/support-tickets';

export const FEEDBACK_MAX_PER_HOUR = 5;
const FEEDBACK_MESSAGE_MAX = 4000;
const FEEDBACK_KINDS = new Set<TicketKind>(['feedback', 'bug', 'question']);
const CONTEXT_ALLOWLIST = new Set(['screen', 'appVersion', 'osVersion', 'deviceModel', 'lastClientErrorId']);

interface FeedbackBody {
  kind?: unknown;
  title?: unknown;
  message?: unknown;
  requestId?: unknown;
  deviceId?: unknown;
  context?: unknown;
}

function asString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function pickFeedbackContext(context: unknown): { screen: string | null; appVersion: string | null; osVersion: string | null; deviceModel: string | null; lastClientErrorId: number | null; rejectedKeys: string[] } {
  const out = { screen: null as string | null, appVersion: null as string | null, osVersion: null as string | null, deviceModel: null as string | null, lastClientErrorId: null as number | null, rejectedKeys: [] as string[] };
  if (!context || typeof context !== 'object') return out;
  for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
    if (!CONTEXT_ALLOWLIST.has(key)) { out.rejectedKeys.push(key); continue; }
    if (key === 'lastClientErrorId') {
      const n = Number(value);
      out.lastClientErrorId = Number.isInteger(n) && n > 0 ? n : null;
    } else {
      (out as Record<string, unknown>)[key] = asString(value, 128);
    }
  }
  return out;
}

export function supportRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'support_route', { method: req.method, path: req.path })) return;
    next();
  });

  router.post('/feedback', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId, deviceId: sessionDeviceId } = req as AuthenticatedRequest;
    const body = (req.body || {}) as FeedbackBody;

    const message = asString(body.message, FEEDBACK_MESSAGE_MAX);
    if (!message) {
      sendError(res, 'BAD_REQUEST', 'message is required and must be a non-empty string');
      return;
    }
    const kind = typeof body.kind === 'string' && FEEDBACK_KINDS.has(body.kind as TicketKind) ? (body.kind as TicketKind) : 'feedback';
    const title = asString(body.title, TICKET_TITLE_MAX) ?? message.slice(0, 120);
    const context = pickFeedbackContext(body.context);
    if (context.rejectedKeys.length > 0) {
      sendError(res, 'BAD_REQUEST', `context keys not allowed: ${context.rejectedKeys.join(', ')}`);
      return;
    }

    try {
      if (countUserTicketsSince(userId, 60 * 60 * 1000) >= FEEDBACK_MAX_PER_HOUR) {
        sendError(res, 'RATE_LIMITED', 'Too many feedback reports this hour. Please try again later.', 429, { retryAfterSeconds: 3600 });
        return;
      }
      const ticket = createTicket({
        kind,
        source: 'ios_feedback',
        title,
        body: message,
        priority: kind === 'bug' ? 'p2' : 'p3',
        userId,
        tenantId: tenantId ?? userId,
        deviceId: asString(body.deviceId, 256) ?? sessionDeviceId ?? null,
        appVersion: context.appVersion,
        osVersion: context.osVersion,
        screen: context.screen ?? context.deviceModel,
        reqId: asString(body.requestId, 64),
        clientErrorId: context.lastClientErrorId,
        createdBy: `user:${userId}`,
      });
      logger.info({ userId, ticketId: ticket.id, kind }, 'Support feedback received');
      sendSuccess(res, { id: ticket.id, ref: ticket.ref, status: ticket.status, createdAt: ticket.createdAt }, { status: 201 });
    } catch (err) {
      logger.error({ err, userId }, 'Failed to create support ticket from feedback');
      sendInternalError(res, 'Failed to record feedback');
    }
  }));

  router.get('/feedback/mine', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      sendSuccess(res, { tickets: listTicketsForUser(userId) });
    } catch (err) {
      logger.error({ err, userId }, 'Failed to list support tickets');
      sendInternalError(res, 'Failed to load feedback');
    }
  }));

  return router;
}
