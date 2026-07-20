// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import {
  getContentCreatorProfile,
  upsertContentCreatorProfile,
  resetContentCreatorProfile,
  computeContentCreatorProfileCompleteness,
  ContentCreatorProfile,
} from '../../state/content-creator-profile';
import {
  recordRadarFeedback,
  revokeRadarFeedback,
  listRadarFeedback,
  radarFeedbackAggregateBySignal,
  isValidRadarFeedbackAction,
} from '../../state/content-radar-feedback';
import { summarizeCanonicalLifecycle } from '../../state/content-lifecycle';
import {
  ContentWorkspaceError,
} from '../../services/content-workspace';
import { ContentWorkspaceWriteDisabledError } from '../../services/content-workspace-capabilities';
import {
  recordContentRadarWorkspaceAction,
  type ContentRadarBriefDraft,
} from '../../services/content-radar-workspace-actions';
import { logger } from '../../utils/logger';

// CONTENT-UI-O1 (2026-05-04): unified per-tenant ContentCreatorProfile.
// CONTENT-UI-O2 (2026-05-04): per-signal Radar feedback endpoint.
//
// Both endpoints are JWT-authenticated via the parent contentRoutes()
// router (`requireEntitlement({ skill: 'content' })` + auth middleware).
// They derive `userId`/`tenantId` from the request, never from the body.

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

function profileEnvelope(profile: ContentCreatorProfile) {
  return {
    profile,
    completeness: computeContentCreatorProfileCompleteness(profile),
  };
}

export function registerContentCreatorProfileRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /** GET /api/v1/content/creator-profile — read the user's creator profile */
  router.get('/creator-profile', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_creator_profile_read')) return;
    try {
      const profile = getContentCreatorProfile(userId, tenantId);
      sendSuccess(res, profileEnvelope(profile));
    } catch (err) {
      logger.warn({ err, userId, tenantId },
        'content-creator-profile.read route failed');
      sendError(res, 'INTERNAL', 'Failed to read creator profile', 500);
    }
  }));

  /** PUT /api/v1/content/creator-profile — upsert the user's creator profile */
  router.put('/creator-profile', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_creator_profile_write')) return;

    if (!req.body || typeof req.body !== 'object') {
      sendError(res, 'VALIDATION', 'Body must be an object', 400);
      return;
    }
    try {
      const profile = upsertContentCreatorProfile(userId, tenantId, req.body);
      sendSuccess(res, profileEnvelope(profile));
    } catch (err) {
      logger.warn({ err, userId, tenantId },
        'content-creator-profile.write route failed');
      sendError(res, 'INTERNAL', 'Failed to save creator profile', 500);
    }
  }));

  /** DELETE /api/v1/content/creator-profile — soft-archive the user's profile */
  router.delete('/creator-profile', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_creator_profile_reset')) return;
    try {
      resetContentCreatorProfile(userId, tenantId);
      sendSuccess(res, profileEnvelope({
        pillars: [], niches: [], audience: '', platforms: [],
        voiceRules: [], preferredFormats: [], dislikedTopics: [],
        bannedTopics: [], trustedSources: [], dislikedSources: [],
        contentGoals: [], languagePreference: '', voiceExamples: [],
        updatedAt: null,
      }));
    } catch (err) {
      logger.warn({ err, userId, tenantId },
        'content-creator-profile.reset route failed');
      sendError(res, 'INTERNAL', 'Failed to reset creator profile', 500);
    }
  }));

  // ────────────────────────────────────────────────────────────────────
  // CONTENT-UI-O2 — per-signal Radar feedback
  // ────────────────────────────────────────────────────────────────────

  /** POST /api/v1/content/radar/feedback
   *  Body: { signalId: string, action: 'accept'|'reject'|'save'|'create_brief',
   *          reason?: string, signalTopic?: string, signalSummary?: string } */
  router.post('/radar/feedback', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_radar_feedback_write')) return;

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const signalId = typeof body.signalId === 'string' ? body.signalId.trim() : '';
    const action = body.action;
    if (!signalId) {
      sendError(res, 'VALIDATION', 'signalId is required', 400);
      return;
    }
    if (!isValidRadarFeedbackAction(action)) {
      sendError(res, 'VALIDATION',
        'action must be one of accept|reject|save|create_brief', 400);
      return;
    }

    try {
      const record = recordRadarFeedback(userId, tenantId, {
        signalId,
        action,
        reason: typeof body.reason === 'string' ? body.reason : null,
        signalTopic: typeof body.signalTopic === 'string' ? body.signalTopic : null,
        signalSummary: typeof body.signalSummary === 'string' ? body.signalSummary : null,
      });
      sendSuccess(res, { feedback: record });
    } catch (err) {
      logger.warn({ err, userId, tenantId, signalId, action },
        'content-radar-feedback.write failed');
      sendError(res, 'INTERNAL', 'Failed to record radar feedback', 500);
    }
  }));

  /** POST /api/v1/content/radar/workspace-actions
   *  Atomically records save/create_brief feedback and materializes the
   *  canonical item + typed artifact + initial immutable revision.
   *  Body: { signalId, action: 'save'|'create_brief', signalTopic,
   *          signalSummary?, reason?, brief? } */
  router.post('/radar/workspace-actions', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_radar_workspace_action')) return;
    if (!Number.isInteger(tenantId) || Number(tenantId) <= 0) {
      sendError(res, 'CONTENT_TENANT_SCOPE_REQUIRED', 'A valid tenant scope is required.', 401);
      return;
    }

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
      ? req.body as Record<string, unknown>
      : {};
    if (body.action !== 'save' && body.action !== 'create_brief') {
      sendError(res, 'VALIDATION', 'action must be save or create_brief', 400);
      return;
    }

    try {
      const result = recordContentRadarWorkspaceAction({
        scope: { userId, tenantId: Number(tenantId) },
        signalId: body.signalId as string,
        action: body.action,
        signalTopic: body.signalTopic as string,
        signalSummary: body.signalSummary as string | null | undefined,
        reason: body.reason as string | null | undefined,
        brief: body.brief as ContentRadarBriefDraft | null | undefined,
      });
      sendSuccess(res, result);
    } catch (error) {
      if (error instanceof ContentWorkspaceWriteDisabledError || error instanceof ContentWorkspaceError) {
        sendError(res, error.code, error.message, error.status, error.details);
        return;
      }
      logger.error({ err: error, userId, tenantId, action: body.action },
        'content-radar-workspace-action failed');
      sendError(res, 'INTERNAL', 'Failed to save this radar action. Existing content was preserved.', 500);
    }
  }));

  /** GET /api/v1/content/radar/feedback?signalId=&action=&limit=
   *  Returns the user's radar feedback history (most-recent-first). */
  router.get('/radar/feedback', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_radar_feedback_list')) return;

    const signalIdRaw = typeof req.query.signalId === 'string' ? req.query.signalId : undefined;
    const actionRaw = typeof req.query.action === 'string' ? req.query.action : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

    const items = listRadarFeedback(userId, tenantId, {
      signalId: signalIdRaw && signalIdRaw.trim() ? signalIdRaw.trim() : undefined,
      action: isValidRadarFeedbackAction(actionRaw) ? actionRaw : undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });
    sendSuccess(res, {
      feedback: items,
      aggregateBySignal: radarFeedbackAggregateBySignal(userId, tenantId),
    });
  }));

  /** DELETE /api/v1/content/radar/feedback
   *  Body/query: { signalId: string, action?: 'accept'|'reject'|'save'|'create_brief' }
   *  Archives active feedback rows so Undo can revoke server-side ranker input. */
  router.delete('/radar/feedback', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_radar_feedback_revoke')) return;

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const signalIdRaw = typeof body.signalId === 'string'
      ? body.signalId
      : typeof req.query.signalId === 'string'
        ? req.query.signalId
        : '';
    const actionRaw = typeof body.action === 'string'
      ? body.action
      : typeof req.query.action === 'string'
        ? req.query.action
        : undefined;
    const signalId = signalIdRaw.trim();
    if (!signalId) {
      sendError(res, 'VALIDATION', 'signalId is required', 400);
      return;
    }
    if (actionRaw !== undefined && !isValidRadarFeedbackAction(actionRaw)) {
      sendError(res, 'VALIDATION',
        'action must be one of accept|reject|save|create_brief', 400);
      return;
    }

    try {
      const revokedCount = revokeRadarFeedback(userId, tenantId, {
        signalId,
        action: isValidRadarFeedbackAction(actionRaw) ? actionRaw : undefined,
      });
      sendSuccess(res, {
        revokedCount,
        aggregateBySignal: radarFeedbackAggregateBySignal(userId, tenantId),
      });
    } catch (err) {
      logger.warn({ err, userId, tenantId, signalId, action: actionRaw },
        'content-radar-feedback.revoke failed');
      sendError(res, 'INTERNAL', 'Failed to revoke radar feedback', 500);
    }
  }));

  // ────────────────────────────────────────────────────────────────────
  // CONTENT-UI-O4 — canonical 12-stage lifecycle summary
  // ────────────────────────────────────────────────────────────────────

  /** GET /api/v1/content/lifecycle — derived 12-bucket lifecycle summary */
  router.get('/lifecycle', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_lifecycle_read')) return;
    try {
      const summary = summarizeCanonicalLifecycle(userId, tenantId);
      sendSuccess(res, { lifecycle: summary });
    } catch (err) {
      logger.warn({ err, userId, tenantId },
        'content-lifecycle.read route failed');
      sendError(res, 'INTERNAL', 'Failed to read lifecycle summary', 500);
    }
  }));
}
