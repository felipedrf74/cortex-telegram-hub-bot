// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendAiBudgetError, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import {
  CONTENT_AGENT_WORKFLOW_VERSION,
  ContentAgentJobError,
  acceptContentAgentProposal,
  cancelContentAgentJob,
  createContentAgentJob,
  getContentAgentJob,
  listContentAgentJobs,
  rejectContentAgentProposal,
  retryContentAgentJob,
  runContentAgentJob,
} from '../../services/content-agent-jobs';
import {
  getContentArtifact,
  getContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../services/content-workspace';
import { ContentWorkspaceWriteDisabledError } from '../../services/content-workspace-capabilities';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import { logger } from '../../utils/logger';
import {
  ContentIdempotencyKeyError,
  resolveContentIdempotencyKey,
} from './content-idempotency-key';
import { safeContentLogErrorFields } from '../../services/content-log-safety';
import { bindContentRequestCancellation } from './content-request-cancellation';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

/**
 * Canonical specialist-job and proposal-review API.
 *
 * Jobs never mutate an artifact while they run. Only an explicit proposal
 * accept can append a canonical revision, and the service protects that write
 * with the proposal's pinned base revision.
 */
export function registerContentAgentJobRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  router.get('/workspace/agent-jobs', (req, res: Response) => {
    const scope = resolveRouteScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_agent_jobs_list',
    );
    if (!scope) return;
    try {
      const page = listContentAgentJobs({
        scope,
        artifactId: req.query.artifactId,
        status: req.query.status,
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      sendSuccess(res, page);
    } catch (error) {
      sendAgentJobError(res, error, 'content agent jobs list failed');
    }
  });

  router.post('/workspace/agent-jobs', (req, res: Response) => {
    const scope = resolveRouteScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_agent_job_create',
    );
    if (!scope) return;
    try {
      const result = createContentAgentJob({
        scope,
        artifactId: req.body?.artifactId,
        packageId: req.body?.packageId,
        idempotencyKey: resolveContentIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_AGENT_WORKFLOW_VERSION,
        job: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      }, { status: result.changed && !result.replayed ? 201 : 200 });
    } catch (error) {
      sendAgentJobError(res, error, 'content agent job create failed');
    }
  });

  router.get('/workspace/agent-jobs/:jobKey', (req, res: Response) => {
    const scope = resolveRouteScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_agent_job_read',
    );
    if (!scope) return;
    try {
      const job = getContentAgentJob(scope, req.params.jobKey);
      if (!job) {
        sendError(res, 'CONTENT_AGENT_JOB_NOT_FOUND', 'Specialist review not found.', 404);
        return;
      }
      sendSuccess(res, { schemaVersion: CONTENT_AGENT_WORKFLOW_VERSION, job });
    } catch (error) {
      sendAgentJobError(res, error, 'content agent job read failed');
    }
  });

  router.post('/workspace/agent-jobs/:jobKey/run', async (req, res: Response) => {
    await mutateJob(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'run');
  });

  router.post('/workspace/agent-jobs/:jobKey/cancel', async (req, res: Response) => {
    await mutateJob(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'cancel');
  });

  router.post('/workspace/agent-jobs/:jobKey/retry', async (req, res: Response) => {
    await mutateJob(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'retry');
  });

  router.post('/workspace/agent-proposals/:proposalKey/accept', (req, res: Response) => {
    mutateProposal(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'accept');
  });

  router.post('/workspace/agent-proposals/:proposalKey/reject', (req, res: Response) => {
    mutateProposal(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'reject');
  });
}

async function mutateJob(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  action: 'run' | 'cancel' | 'retry',
): Promise<void> {
  const scope = resolveRouteScope(req, res, ensureValidContentRouteScope, `content_agent_job_${action}`);
  if (!scope) return;
  const requestCancellation = action === 'run'
    ? bindContentRequestCancellation(req, res, 'content_agent_job_run')
    : null;
  try {
    const input = {
      scope,
      jobKey: singleRouteParam(req.params.jobKey),
      idempotencyKey: resolveContentIdempotencyKey(req),
    };
    const result = action === 'run'
      ? await runContentAgentJob({ ...input, abortSignal: requestCancellation!.signal })
      : action === 'cancel'
        ? cancelContentAgentJob(input)
        : retryContentAgentJob(input);
    if (requestCancellation?.signal.aborted) return;
    sendSuccess(res, {
      schemaVersion: CONTENT_AGENT_WORKFLOW_VERSION,
      job: result.value,
      mutation: { replayed: result.replayed, changed: result.changed },
    });
  } catch (error) {
    if (requestCancellation?.signal.aborted) return;
    sendAgentJobError(res, error, `content agent job ${action} failed`);
  } finally {
    requestCancellation?.cleanup();
  }
}

function mutateProposal(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  action: 'accept' | 'reject',
): void {
  const scope = resolveRouteScope(req, res, ensureValidContentRouteScope, `content_agent_proposal_${action}`);
  if (!scope) return;
  try {
    const input = {
      scope,
      proposalKey: singleRouteParam(req.params.proposalKey),
      idempotencyKey: resolveContentIdempotencyKey(req),
    };
    const result = action === 'accept'
      ? acceptContentAgentProposal(input)
      : rejectContentAgentProposal(input);
    if (action === 'accept' && result.changed && !result.replayed) {
      invalidateContentDerivedCaches(scope.userId);
    }
    let item;
    if (action === 'accept') {
      const acceptedArtifactId = result.value.acceptedArtifactId;
      const acceptedArtifact = acceptedArtifactId == null
        ? null
        : getContentArtifact(scope, acceptedArtifactId);
      item = acceptedArtifact
        ? getContentWorkspaceItem(scope, acceptedArtifact.itemId)
        : null;
      if (!item) {
        throw new ContentAgentJobError(
          'CONTENT_AGENT_ACCEPT_READBACK_FAILED',
          'The accepted change was saved but its authoritative workspace item could not be read.',
          500,
        );
      }
    }
    sendSuccess(res, {
      schemaVersion: CONTENT_AGENT_WORKFLOW_VERSION,
      proposal: result.value,
      ...(item ? { item } : {}),
      mutation: { replayed: result.replayed, changed: result.changed },
    });
  } catch (error) {
    sendAgentJobError(res, error, `content agent proposal ${action} failed`);
  }
}

function resolveRouteScope(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  operation: string,
): ContentWorkspaceScope | null {
  if (!ensureValidContentRouteScope(res, req.userId, operation)) return null;
  if (!Number.isSafeInteger(req.tenantId) || Number(req.tenantId) <= 0) {
    sendError(res, 'CONTENT_TENANT_SCOPE_REQUIRED', 'A valid tenant scope is required.', 401);
    return null;
  }
  if (Number(req.tenantId) !== req.userId) {
    sendError(res, 'CONTENT_TENANT_SCOPE_MISMATCH', 'The active tenant does not match the authenticated session.', 403);
    return null;
  }
  return { tenantId: Number(req.tenantId), userId: req.userId };
}

function singleRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function sendAgentJobError(res: Response, error: unknown, operation: string): void {
  if (sendAiBudgetError(res, error)) return;
  if (error instanceof ContentIdempotencyKeyError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  if (error instanceof ContentWorkspaceWriteDisabledError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  if (error instanceof ContentAgentJobError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  logger.error({ operation, ...safeContentLogErrorFields(error) }, 'content agent operation failed');
  sendInternalError(res, 'Content specialist review is temporarily unavailable.');
}
