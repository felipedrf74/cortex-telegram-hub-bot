// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import {
  ContentScriptJobError,
  cancelContentScriptJob,
  createContentScriptJob,
  getContentScriptJob,
  retryContentScriptJob,
} from '../../services/content-script-jobs';
import { logger } from '../../utils/logger';
import { ContentScriptJobEncryptionError } from '../../services/content-script-job-encryption';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentScriptJobRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  router.post('/script-jobs', (req, res: Response) => {
    const scope = routeScope(req as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_script_job_create');
    if (!scope) return;
    try {
      const result = createContentScriptJob({
        ...scope,
        idempotencyKey: readIdempotencyKey(req),
        request: req.body && typeof req.body === 'object' ? req.body : {},
      });
      sendSuccess(res, result.job, { status: result.replayed ? 200 : 202 });
    } catch (error) {
      sendJobError(res, error, 'create');
    }
  });

  router.get('/script-jobs/:jobId', (req, res: Response) => {
    const scope = routeScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_script_job_read');
    if (!scope) return;
    try {
      const job = getContentScriptJob(scope.tenantId, scope.userId, singleParam(req.params.jobId));
      if (!job) {
        sendError(res, 'CONTENT_SCRIPT_JOB_NOT_FOUND', 'Script job not found.', 404);
        return;
      }
      sendSuccess(res, job);
    } catch (error) {
      sendJobError(res, error, 'read');
    }
  });

  router.post('/script-jobs/:jobId/cancel', (req, res: Response) => {
    const scope = routeScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_script_job_cancel');
    if (!scope) return;
    try {
      sendSuccess(res, cancelContentScriptJob({ ...scope, jobId: singleParam(req.params.jobId) }));
    } catch (error) {
      sendJobError(res, error, 'cancel');
    }
  });

  router.post('/script-jobs/:jobId/retry', (req, res: Response) => {
    const scope = routeScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_script_job_retry');
    if (!scope) return;
    try {
      sendSuccess(res, retryContentScriptJob({ ...scope, jobId: singleParam(req.params.jobId) }), { status: 202 });
    } catch (error) {
      sendJobError(res, error, 'retry');
    }
  });
}

function routeScope(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  operation: string,
): { tenantId: number; userId: number } | null {
  if (!ensureValidContentRouteScope(res, req.userId, operation)) return null;
  if (!Number.isSafeInteger(req.tenantId) || Number(req.tenantId) <= 0 || Number(req.tenantId) !== req.userId) {
    sendError(res, 'CONTENT_TENANT_SCOPE_MISMATCH', 'The active tenant does not match the authenticated session.', 403);
    return null;
  }
  return { tenantId: Number(req.tenantId), userId: req.userId };
}

function readIdempotencyKey(req: { body?: unknown; header(name: string): string | undefined }): string {
  const body = req.body as { idempotencyKey?: unknown } | undefined;
  const bodyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const headerKey = (req.header('x-idempotency-key') ?? '').trim();
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    throw new ContentScriptJobError(
      'IDEMPOTENCY_CONFLICT',
      'Body and header idempotency keys must match.',
      409,
    );
  }
  return bodyKey || headerKey;
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function sendJobError(res: Response, error: unknown, operation: string): void {
  if (error instanceof ContentScriptJobEncryptionError) {
    sendError(res, error.code, 'Content script job encryption material is temporarily unavailable.', error.status);
    return;
  }
  if (error instanceof ContentScriptJobError) {
    sendError(res, error.code, error.message, error.status);
    return;
  }
  logger.error({ operation, errorName: error instanceof Error ? error.name : typeof error }, 'Content script job operation failed');
  sendInternalError(res, 'Content script job is temporarily unavailable.');
}
