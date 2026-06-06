// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { requirePortalAdminToken } from '../secret-guards';
import { sendError, sendSuccess } from '../response-helpers';
import {
  cancelEvent,
  listDeadLetterEvents,
  replayEvent,
} from '../../services/event-outbox';
import {
  cancelJob,
  listDeadLetterJobs,
  replayJob,
} from '../../services/background-job-queue';

export function eventBackboneAdminRoutes(): Router {
  const router = Router();
  router.use(requirePortalAdminToken);

  router.get('/events/dead-letter', (req, res: Response) => {
    const scope = parseScope(req.query);
    if (!scope) {
      sendError(res, 'BAD_REQUEST', 'tenantId is required');
      return;
    }
    const events = listDeadLetterEvents(scope);
    sendSuccess(res, { events, count: events.length });
  });

  router.post('/events/:eventId/replay', (req, res: Response) => {
    const tenantId = positiveInt(req.query.tenantId);
    if (!tenantId) {
      sendError(res, 'BAD_REQUEST', 'tenantId is required');
      return;
    }
    const replayed = replayEvent(req.params.eventId, tenantId);
    sendSuccess(res, { replayed, eventId: req.params.eventId });
  });

  router.post('/events/:eventId/cancel', (req, res: Response) => {
    const tenantId = positiveInt(req.query.tenantId);
    if (!tenantId) {
      sendError(res, 'BAD_REQUEST', 'tenantId is required');
      return;
    }
    const canceled = cancelEvent(req.params.eventId, tenantId);
    sendSuccess(res, { canceled, eventId: req.params.eventId });
  });

  router.get('/jobs/dead-letter', (req, res: Response) => {
    const scope = parseScope(req.query);
    if (!scope) {
      sendError(res, 'BAD_REQUEST', 'tenantId is required');
      return;
    }
    const jobs = listDeadLetterJobs(scope);
    sendSuccess(res, { jobs, count: jobs.length });
  });

  router.post('/jobs/:jobId/replay', (req, res: Response) => {
    const tenantId = positiveInt(req.query.tenantId);
    if (!tenantId) {
      sendError(res, 'BAD_REQUEST', 'tenantId is required');
      return;
    }
    const replayed = replayJob(req.params.jobId, tenantId);
    sendSuccess(res, { replayed, jobId: req.params.jobId });
  });

  router.post('/jobs/:jobId/cancel', (req, res: Response) => {
    const tenantId = positiveInt(req.query.tenantId);
    if (!tenantId) {
      sendError(res, 'BAD_REQUEST', 'tenantId is required');
      return;
    }
    const canceled = cancelJob(req.params.jobId, tenantId);
    sendSuccess(res, { canceled, jobId: req.params.jobId });
  });

  return router;
}

function parseScope(query: Record<string, unknown>): { tenantId: number; userId?: number; limit?: number } | null {
  const tenantId = positiveInt(query.tenantId);
  if (!tenantId) return null;
  const userId = positiveInt(query.userId);
  const limit = positiveInt(query.limit);
  return {
    tenantId,
    ...(userId ? { userId } : {}),
    ...(limit ? { limit } : {}),
  };
}

function positiveInt(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' || typeof raw === 'number'
    ? Number.parseInt(String(raw), 10)
    : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
