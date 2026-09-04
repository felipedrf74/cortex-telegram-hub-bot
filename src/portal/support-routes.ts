// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Support ticket routes for the operator portal.
 *
 *   GET   /api/support/summary                       counts for badges / overview
 *   GET   /api/support/tickets                       list (status/kind/priority/source/user/q)
 *   GET   /api/support/tickets/:id                   ticket + timeline
 *   POST  /api/support/tickets                       operator-created ticket        (admin, audited)
 *   PATCH /api/support/tickets/:id                   status/priority/kind/title/assignee/externalRef/dueAt (admin, audited)
 *   POST  /api/support/tickets/:id/events            operator comment              (admin, audited)
 *   POST  /api/support/tickets/:id/link              link issue/alert/request/user (admin, audited)
 *   POST  /api/ops/issues/:id/ticket                 promote an issue to a ticket  (admin, audited)
 *   POST  /api/operator-alerts/:id/ticket            promote an alert to a ticket  (admin, audited)
 *
 * Reads use the portal read scope. Ticket bodies are sanitized by the
 * service; this layer only validates shape and bounds.
 */

import type { Express, Request, Response } from 'express';
import { extractPortalActorHint, getPortalAuthContext, requirePortalAdminToken } from '../api/secret-guards';
import { getIssue } from '../services/issue-tracker';
import { listOperatorAlerts } from '../services/operator-alerts';
import {
  addTicketComment,
  createTicket,
  getSupportSummary,
  getTicket,
  linkTicket,
  listTickets,
  TICKET_BODY_MAX,
  TICKET_EVENT_BODY_MAX,
  TICKET_KINDS,
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX,
  updateTicket,
  type TicketKind,
  type TicketPriority,
  type TicketSource,
  type TicketStatus,
  type UpdateTicketInput,
} from '../services/support-tickets';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

function str(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function int(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function portalActor(req: Request): string {
  const hint = getPortalAuthContext(req)?.actorHint ?? extractPortalActorHint(req);
  return `operator:${hint ?? 'portal'}`;
}

function failed(res: Response, err: unknown, what: string): void {
  sendPortalInternalError(res, err, 'Portal request failed', `Portal: ${what} request failed`);
}

export function registerPortalSupportRoutes(app: Express): void {
  app.get('/api/support/summary', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...getSupportSummary() });
    } catch (err) {
      failed(res, err, 'support summary');
    }
  });

  app.get('/api/support/tickets', (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, unknown>;
      const statusRaw = str(q.status, 16);
      const status = statusRaw === 'all' || statusRaw === 'active' ? statusRaw : oneOf<TicketStatus>(statusRaw, TICKET_STATUSES);
      res.json({
        ok: true,
        tickets: listTickets({
          status,
          kind: oneOf<TicketKind>(q.kind, TICKET_KINDS),
          priority: oneOf<TicketPriority>(q.priority, TICKET_PRIORITIES),
          source: oneOf<TicketSource>(q.source, TICKET_SOURCES),
          userId: int(q.userId),
          q: str(q.q, 200),
          limit: int(q.limit),
        }),
        summary: getSupportSummary(),
      });
    } catch (err) {
      failed(res, err, 'support tickets');
    }
  });

  app.get('/api/support/tickets/:id', (req: Request, res: Response) => {
    try {
      const id = int(req.params.id);
      if (!id) { res.status(400).json({ ok: false, message: 'Invalid ticket id' }); return; }
      const detail = getTicket(id);
      if (!detail) { res.status(404).json({ ok: false, message: 'Ticket not found' }); return; }
      res.json({ ok: true, ...detail });
    } catch (err) {
      failed(res, err, 'support ticket detail');
    }
  });

  app.post('/api/support/tickets', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = str(body.title, TICKET_TITLE_MAX);
      if (!title) { res.status(400).json({ ok: false, message: 'title is required' }); return; }
      const ticket = createTicket({
        kind: oneOf<TicketKind>(body.kind, TICKET_KINDS) ?? 'task',
        source: oneOf<TicketSource>(body.source, ['operator', 'email', 'waitlist'] as const) ?? 'operator',
        title,
        body: str(body.body, TICKET_BODY_MAX) ?? null,
        priority: oneOf<TicketPriority>(body.priority, TICKET_PRIORITIES),
        userId: int(body.userId) ?? null,
        externalRef: str(body.externalRef, 512) ?? null,
        assignee: str(body.assignee, 128) ?? null,
        createdBy: portalActor(req),
        quiet: true,
      });
      logPortalAdminMutation(req, ticket.userId ?? 0, 'support_ticket.create', { ticketId: ticket.id, ref: ticket.ref, kind: ticket.kind, priority: ticket.priority });
      res.status(201).json({ ok: true, ticket });
    } catch (err) {
      failed(res, err, 'support ticket create');
    }
  });

  app.patch('/api/support/tickets/:id', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = int(req.params.id);
      if (!id) { res.status(400).json({ ok: false, message: 'Invalid ticket id' }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: UpdateTicketInput = {};
      if (body.status !== undefined) {
        const status = oneOf<TicketStatus>(body.status, TICKET_STATUSES);
        if (!status) { res.status(400).json({ ok: false, message: 'Invalid status' }); return; }
        patch.status = status;
      }
      if (body.priority !== undefined) {
        const priority = oneOf<TicketPriority>(body.priority, TICKET_PRIORITIES);
        if (!priority) { res.status(400).json({ ok: false, message: 'Invalid priority' }); return; }
        patch.priority = priority;
      }
      if (body.kind !== undefined) {
        const kind = oneOf<TicketKind>(body.kind, TICKET_KINDS);
        if (!kind) { res.status(400).json({ ok: false, message: 'Invalid kind' }); return; }
        patch.kind = kind;
      }
      if (body.title !== undefined) patch.title = str(body.title, TICKET_TITLE_MAX) ?? '';
      if (body.assignee !== undefined) patch.assignee = str(body.assignee, 128) ?? null;
      if (body.externalRef !== undefined) patch.externalRef = str(body.externalRef, 512) ?? null;
      if (body.dueAt !== undefined) patch.dueAt = str(body.dueAt, 40) ?? null;
      const ticket = updateTicket(id, patch, portalActor(req));
      if (!ticket) { res.status(404).json({ ok: false, message: 'Ticket not found' }); return; }
      logPortalAdminMutation(req, ticket.userId ?? 0, 'support_ticket.update', { ticketId: id, fields: Object.keys(patch) });
      res.json({ ok: true, ticket });
    } catch (err) {
      failed(res, err, 'support ticket update');
    }
  });

  app.post('/api/support/tickets/:id/events', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = int(req.params.id);
      if (!id) { res.status(400).json({ ok: false, message: 'Invalid ticket id' }); return; }
      const body = str((req.body as { body?: unknown } | undefined)?.body, TICKET_EVENT_BODY_MAX);
      if (!body) { res.status(400).json({ ok: false, message: 'body is required' }); return; }
      const event = addTicketComment(id, portalActor(req), body);
      if (!event) { res.status(404).json({ ok: false, message: 'Ticket not found' }); return; }
      logPortalAdminMutation(req, 0, 'support_ticket.comment', { ticketId: id, eventId: event.id });
      res.status(201).json({ ok: true, event });
    } catch (err) {
      failed(res, err, 'support ticket comment');
    }
  });

  app.post('/api/support/tickets/:id/link', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = int(req.params.id);
      if (!id) { res.status(400).json({ ok: false, message: 'Invalid ticket id' }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const links: Parameters<typeof linkTicket>[1] = {};
      if (body.issueId !== undefined) links.issueId = int(body.issueId) ?? null;
      if (body.alertId !== undefined) links.alertId = int(body.alertId) ?? null;
      if (body.reqId !== undefined) links.reqId = str(body.reqId, 64) ?? null;
      if (body.userId !== undefined) links.userId = int(body.userId) ?? null;
      if (body.clientErrorId !== undefined) links.clientErrorId = int(body.clientErrorId) ?? null;
      const ticket = linkTicket(id, links, portalActor(req));
      if (!ticket) { res.status(404).json({ ok: false, message: 'Ticket not found' }); return; }
      logPortalAdminMutation(req, ticket.userId ?? 0, 'support_ticket.link', { ticketId: id, links: Object.keys(links) });
      res.json({ ok: true, ticket });
    } catch (err) {
      failed(res, err, 'support ticket link');
    }
  });

  app.post('/api/ops/issues/:id/ticket', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = int(req.params.id);
      if (!id) { res.status(400).json({ ok: false, message: 'Invalid issue id' }); return; }
      const detail = getIssue(id, 1);
      if (!detail) { res.status(404).json({ ok: false, message: 'Issue not found' }); return; }
      const { issue } = detail;
      const ticket = createTicket({
        kind: issue.kind === 'client' ? 'bug' : 'incident',
        source: 'issue',
        title: `${issue.kind === 'client' ? 'iOS' : 'Server'} issue #${issue.id}: ${issue.title}`,
        body: `Issue #${issue.id} (${issue.kind}/${issue.source}), ${issue.occurrenceCount} occurrences since ${issue.firstSeenAt}.`,
        priority: oneOf<TicketPriority>((req.body as { priority?: unknown } | undefined)?.priority, TICKET_PRIORITIES) ?? (issue.level === 'fatal' ? 'p1' : 'p2'),
        userId: issue.lastUserId,
        issueId: issue.id,
        alertId: issue.lastAlertId,
        reqId: issue.lastReqId,
        appVersion: issue.lastAppVersion,
        createdBy: portalActor(req),
        quiet: true,
      });
      logPortalAdminMutation(req, ticket.userId ?? 0, 'support_ticket.create', { ticketId: ticket.id, ref: ticket.ref, fromIssue: issue.id });
      res.status(201).json({ ok: true, ticket });
    } catch (err) {
      failed(res, err, 'issue to ticket');
    }
  });

  app.post('/api/operator-alerts/:id/ticket', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = int(req.params.id);
      if (!id) { res.status(400).json({ ok: false, message: 'Invalid alert id' }); return; }
      const alert = listOperatorAlerts({ status: 'all', limit: 100 }).find((a) => a.id === id);
      if (!alert) { res.status(404).json({ ok: false, message: 'Alert not found (only the 100 most recent alerts can be promoted)' }); return; }
      const ticket = createTicket({
        kind: 'incident',
        source: 'alert',
        title: `Alert #${alert.id}: ${alert.title}`,
        body: alert.detail ?? null,
        priority: alert.severity === 'critical' ? 'p1' : 'p2',
        alertId: alert.id,
        createdBy: portalActor(req),
        quiet: true,
      });
      logPortalAdminMutation(req, 0, 'support_ticket.create', { ticketId: ticket.id, ref: ticket.ref, fromAlert: alert.id });
      res.status(201).json({ ok: true, ticket });
    } catch (err) {
      failed(res, err, 'alert to ticket');
    }
  });
}
