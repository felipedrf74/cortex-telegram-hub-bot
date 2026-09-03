// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import {
  CONTENT_SCRIPT_JOB_IDEMPOTENCY_KEY_MAX_CHARS,
  ContentScriptJobError,
  cancelContentScriptJob,
  createContentScriptJob,
  getContentScriptJob,
  retryContentScriptJob,
} from '../../services/content-script-jobs';
import { logger } from '../../utils/logger';
import { ContentScriptJobEncryptionError } from '../../services/content-script-job-encryption';
import { ContentScriptJobCreditSettlementError } from '../../services/content-script-job-credits';
import {
  hasUnsupportedContentControlCharacters,
  validateExplicitContentScriptRequestFields,
} from './content-script-utils';
import { safeContentLogErrorFields } from '../../services/content-log-safety';

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
      const request = readScriptJobRequestBody(req.body);
      const explicitContractViolation = validateExplicitContentScriptRequestFields(request, {
        booleanFields: ['forceRefresh'],
      });
      if (explicitContractViolation) {
        throw new ContentScriptJobError(
          'VALIDATION',
          explicitContractViolation.message,
          400,
          { field: explicitContractViolation.field },
        );
      }
      if (request.style !== undefined) {
        throw new ContentScriptJobError(
          'VALIDATION',
          'style is not supported for script jobs; use scriptStyle.',
          400,
          { field: 'style' },
        );
      }
      if (request.deliveryMode !== undefined
          && (typeof request.deliveryMode !== 'string'
            || !['standard', 'scheduled', 'priority'].includes(request.deliveryMode))) {
        throw new ContentScriptJobError(
          'VALIDATION',
          'deliveryMode must be one of: standard, scheduled, priority.',
          400,
          { field: 'deliveryMode' },
        );
      }
      const result = createContentScriptJob({
        ...scope,
        idempotencyKey: readIdempotencyKey(request, req.header('x-idempotency-key')),
        request,
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

function readScriptJobRequestBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContentScriptJobError(
      'VALIDATION',
      'Body must be an object.',
      400,
      { field: 'body' },
    );
  }
  return body as Record<string, unknown>;
}

function readIdempotencyKey(
  body: Record<string, unknown>,
  rawHeaderKey: string | undefined,
): string {
  const bodyValue = body.idempotencyKey;
  if (bodyValue !== undefined && typeof bodyValue !== 'string') {
    throw new ContentScriptJobError(
      'VALIDATION',
      'idempotencyKey must be a string.',
      400,
      { field: 'idempotencyKey' },
    );
  }
  const bodyKey = typeof bodyValue === 'string' ? bodyValue.trim() : '';
  const headerKey = (rawHeaderKey ?? '').trim();
  const suppliedKeys = [
    ...(bodyValue !== undefined ? [bodyKey] : []),
    ...(rawHeaderKey !== undefined ? [headerKey] : []),
  ];
  if (suppliedKeys.some((value) => value.length === 0)) {
    throw new ContentScriptJobError(
      'VALIDATION',
      'idempotencyKey must not be empty.',
      400,
      { field: 'idempotencyKey' },
    );
  }
  if (suppliedKeys.some((value) => value.length > CONTENT_SCRIPT_JOB_IDEMPOTENCY_KEY_MAX_CHARS)) {
    throw new ContentScriptJobError(
      'VALIDATION',
      `idempotencyKey must be at most ${CONTENT_SCRIPT_JOB_IDEMPOTENCY_KEY_MAX_CHARS} characters.`,
      400,
    );
  }
  if (suppliedKeys.some((value) => hasUnsupportedContentControlCharacters(value))) {
    throw new ContentScriptJobError(
      'VALIDATION',
      'idempotencyKey contains unsupported control characters.',
      400,
      { field: 'idempotencyKey', reason: 'unsupported_control_characters' },
    );
  }
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    throw new ContentScriptJobError(
      'IDEMPOTENCY_CONFLICT',
      'Body and header idempotency keys must match.',
      409,
    );
  }
  const key = bodyKey || headerKey;
  return key;
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function sendJobError(res: Response, error: unknown, operation: string): void {
  if (error instanceof ContentScriptJobEncryptionError) {
    sendError(res, error.code, 'Content script job encryption material is temporarily unavailable.', error.status);
    return;
  }
  if (error instanceof ContentScriptJobCreditSettlementError) {
    sendError(res, error.code, error.message, error.status);
    return;
  }
  if (error instanceof ContentScriptJobError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  logger.error({ operation, ...safeContentLogErrorFields(error) }, 'Content script job operation failed');
  sendInternalError(res, 'Content script job is temporarily unavailable.');
}
