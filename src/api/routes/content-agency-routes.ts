// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { logger } from '../../utils/logger';
import {
  buildContentAgencyBrief,
  buildContentAgencyCompetitorStudy,
  buildContentAgencyPackage,
  buildContentAgencyTranscriptStudy,
  evaluateContentAgencyPackage,
  getContentAgencyProject,
  handoffContentAgencyPackageToPipeline,
  persistContentAgencyArtifact,
  validateContentAgencyReadiness,
} from '../../services/content-agency';
import {
  listContentAgencyRules,
  validateContentAgencyRuleCoverage,
  validateContentAgencyRuntimeRuleCoverage,
} from '../../services/content-agency-rules';

interface ContentAgencyResponseContract {
  tenantId: number | null;
  userId: number | null;
  visibilityScope: string;
  platform: string;
  format: string;
  objective: string;
  sourceTrace: string[];
  referenceIds: string[];
  confidence: number;
  qualityScore: number | null;
  warnings: string[];
  blockers: string[];
  reviewRequired: boolean;
  nextBestActions: string[];
}

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function uniqueStrings(...values: unknown[]): string[] {
  return [...new Set(values.flatMap(toStringArray))];
}

function buildResponseContract(
  artifact: any,
  fallback: Partial<ContentAgencyResponseContract> = {},
): ContentAgencyResponseContract {
  const brief = artifact?.brief && typeof artifact.brief === 'object' ? artifact.brief : artifact;
  const quality = artifact?.quality && typeof artifact.quality === 'object' ? artifact.quality : null;
  const warnings = uniqueStrings(artifact?.warnings, quality?.warnings, fallback.warnings);
  const blockers = uniqueStrings(artifact?.blockers, quality?.blockers, fallback.blockers);
  const nextBestActions = uniqueStrings(artifact?.nextBestActions, brief?.nextBestActions, fallback.nextBestActions);
  const sourceTrace = uniqueStrings(artifact?.sourceTrace, brief?.sourceTrace, fallback.sourceTrace);
  const referenceIds = uniqueStrings(artifact?.referenceIds, fallback.referenceIds);
  const confidence = Number.isFinite(Number(artifact?.confidence ?? brief?.confidence ?? fallback.confidence))
    ? Number(artifact?.confidence ?? brief?.confidence ?? fallback.confidence)
    : 0.5;

  return {
    tenantId: Number.isFinite(Number(artifact?.tenantId ?? brief?.tenantId ?? fallback.tenantId))
      ? Number(artifact?.tenantId ?? brief?.tenantId ?? fallback.tenantId)
      : null,
    userId: Number.isFinite(Number(artifact?.userId ?? brief?.userId ?? fallback.userId))
      ? Number(artifact?.userId ?? brief?.userId ?? fallback.userId)
      : null,
    visibilityScope: String(artifact?.visibilityScope ?? brief?.visibilityScope ?? fallback.visibilityScope ?? 'user_private'),
    platform: String(artifact?.platform ?? brief?.platform ?? fallback.platform ?? 'generic'),
    format: String(artifact?.format ?? brief?.format ?? fallback.format ?? 'generic_script'),
    objective: String(artifact?.objective ?? brief?.objective ?? brief?.goal ?? fallback.objective ?? 'Build a useful content package'),
    sourceTrace,
    referenceIds,
    confidence,
    qualityScore: Number.isFinite(Number(quality?.score ?? (artifact as any)?.qualityScore ?? fallback.qualityScore))
      ? Number(quality?.score ?? (artifact as any)?.qualityScore ?? fallback.qualityScore)
      : null,
    warnings,
    blockers,
    reviewRequired: Boolean((artifact?.reviewRequired ?? fallback.reviewRequired) ?? (blockers.length > 0 || warnings.length > 0)),
    nextBestActions,
  };
}

export function registerContentAgencyRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  router.get('/agency/rules', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_rules_read')) return;

    const coverage = validateContentAgencyRuleCoverage();
    const runtimeCoverage = validateContentAgencyRuntimeRuleCoverage();
    sendSuccess(res, {
      rules: listContentAgencyRules(),
      coverage,
      runtimeCoverage,
      readiness: validateContentAgencyReadiness(),
    });
  }));

  router.post('/agency/brief', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_brief_create')) return;

    try {
      const brief = buildContentAgencyBrief({
        ...(req.body && typeof req.body === 'object' ? req.body : {}),
        userId,
        tenantId: tenantId ?? userId,
      });
      persistContentAgencyArtifact('brief', brief);
      sendSuccess(res, { brief, contract: buildResponseContract(brief) }, { status: 201 });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'content agency brief failed');
      sendInternalError(res, 'Failed to create content agency brief');
    }
  }));

  router.post('/agency/competitor-study', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_competitor_study')) return;

    try {
      const fallbackBrief = buildContentAgencyBrief({
        ...(req.body?.brief && typeof req.body.brief === 'object' ? req.body.brief : {}),
        userId,
        tenantId: tenantId ?? userId,
      });
      const study = buildContentAgencyCompetitorStudy({
        userId,
        tenantId: tenantId ?? userId,
        brief: req.body?.brief ?? fallbackBrief,
        competitors: Array.isArray(req.body?.competitors) ? req.body.competitors : [],
      });
      persistContentAgencyArtifact('competitor_study', study);
      sendSuccess(res, { study, contract: buildResponseContract(study, buildResponseContract(fallbackBrief)) }, { status: 201 });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'content agency competitor study failed');
      sendInternalError(res, 'Failed to create competitor study');
    }
  }));

  router.post('/agency/transcript-study', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_transcript_study')) return;

    try {
      const fallbackBrief = buildContentAgencyBrief({
        ...(req.body?.brief && typeof req.body.brief === 'object' ? req.body.brief : {}),
        userId,
        tenantId: tenantId ?? userId,
      });
      const study = buildContentAgencyTranscriptStudy({
        userId,
        tenantId: tenantId ?? userId,
        transcript: typeof req.body?.transcript === 'string' ? req.body.transcript : '',
        title: typeof req.body?.title === 'string' ? req.body.title : null,
      });
      persistContentAgencyArtifact('transcript_study', study);
      sendSuccess(res, { study, contract: buildResponseContract(study, buildResponseContract(fallbackBrief)) }, { status: 201 });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'content agency transcript study failed');
      sendInternalError(res, 'Failed to create transcript study');
    }
  }));

  router.post('/agency/package', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_package_create')) return;

    try {
      const pkg = buildContentAgencyPackage({
        ...(req.body && typeof req.body === 'object' ? req.body : {}),
        userId,
        tenantId: tenantId ?? userId,
      });
      persistContentAgencyArtifact('package', pkg);
      persistContentAgencyArtifact('compliance_review', {
        id: `${pkg.id}_compliance`,
        userId,
        tenantId: tenantId ?? userId,
        visibilityScope: pkg.visibilityScope,
        platform: pkg.platform,
        format: pkg.format,
        status: pkg.complianceReview.status,
        complianceReview: pkg.complianceReview,
        warnings: pkg.complianceReview.warnings,
        blockers: pkg.complianceReview.blockers,
        sourceTrace: pkg.sourceTrace,
      });
      persistContentAgencyArtifact('experiment_run', {
        id: `${pkg.id}_experiment`,
        userId,
        tenantId: tenantId ?? userId,
        visibilityScope: pkg.visibilityScope,
        platform: pkg.platform,
        format: pkg.format,
        status: 'planned',
        experimentPlan: pkg.experimentPlan,
        warnings: [],
        blockers: [],
        sourceTrace: pkg.sourceTrace,
      });
      persistContentAgencyArtifact('quality_review', {
        id: `${pkg.id}_quality`,
        userId,
        tenantId: tenantId ?? userId,
        visibilityScope: pkg.visibilityScope,
        platform: pkg.platform,
        format: pkg.format,
        quality: pkg.quality,
        warnings: pkg.quality.warnings,
        blockers: pkg.quality.blockers,
        sourceTrace: pkg.sourceTrace,
      });
      sendSuccess(res, { package: pkg, contract: buildResponseContract(pkg) }, { status: 201 });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'content agency package failed');
      sendInternalError(res, 'Failed to create content agency package');
    }
  }));

  router.post('/agency/score', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_score')) return;

    try {
      const pkg = req.body?.package;
      if (!pkg || typeof pkg !== 'object') {
        sendError(res, 'VALIDATION', 'package is required', 400);
        return;
      }
      const quality = evaluateContentAgencyPackage({
        brief: pkg.brief,
        competitorStudy: pkg.competitorStudy,
        transcriptStudy: pkg.transcriptStudy,
        hookBank: pkg.hookBank ?? [],
        scriptVariants: pkg.scriptVariants ?? [],
        creativeDirection: pkg.creativeDirection,
        complianceReview: pkg.complianceReview,
        sourceTrace: pkg.sourceTrace ?? [],
      });
      persistContentAgencyArtifact('quality_review', {
        id: `${pkg.id ?? 'package'}_quality_rescore`,
        userId,
        tenantId: tenantId ?? userId,
        visibilityScope: pkg.visibilityScope ?? 'user_private',
        platform: pkg.platform,
        format: pkg.format,
        quality,
        warnings: quality.warnings,
        blockers: quality.blockers,
        sourceTrace: pkg.sourceTrace ?? [],
      });
      sendSuccess(res, { quality, contract: buildResponseContract({ ...pkg, quality }, buildResponseContract(pkg)) });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'content agency score failed');
      sendInternalError(res, 'Failed to score content agency package');
    }
  }));

  router.get('/agency/projects/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const projectId = req.params.id;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_project_get', { projectId })) return;

    const project = getContentAgencyProject({
      userId,
      tenantId: tenantId ?? userId,
      id: projectId,
    });
    if (!project) {
      sendError(res, 'NOT_FOUND', 'Content agency project not found', 404);
      return;
    }
    sendSuccess(res, { ...project, contract: buildResponseContract(project.artifact) });
  }));

  router.post('/agency/projects/:id/handoff', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const projectId = req.params.id;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_pipeline_handoff', { projectId })) return;

    try {
      const result = handoffContentAgencyPackageToPipeline({
        userId,
        tenantId: tenantId ?? userId,
        packageId: projectId,
      });
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Content agency package not found', 404, {
          handoff: result,
          contract: buildResponseContract(result, {
            tenantId: tenantId ?? userId,
            userId,
            blockers: result.blockers,
            warnings: result.warnings,
            nextBestActions: result.nextBestActions,
            sourceTrace: result.sourceTrace,
            reviewRequired: true,
          }),
        });
        return;
      }
      if (result.status === 'blocked') {
        sendError(res, 'CONTENT_AGENCY_HANDOFF_BLOCKED', 'Resolve blockers before moving this package to the pipeline.', 409, {
          handoff: result,
          contract: buildResponseContract(result, {
            tenantId: tenantId ?? userId,
            userId,
            blockers: result.blockers,
            warnings: result.warnings,
            nextBestActions: result.nextBestActions,
            sourceTrace: result.sourceTrace,
            reviewRequired: true,
          }),
        });
        return;
      }
      sendSuccess(res, {
        handoff: result,
        contract: buildResponseContract(result, {
          tenantId: tenantId ?? userId,
          userId,
          visibilityScope: 'user_private',
          warnings: result.warnings,
          blockers: result.blockers,
          nextBestActions: result.nextBestActions,
          sourceTrace: result.sourceTrace,
          reviewRequired: result.blockers.length > 0,
        }),
      }, { status: result.status === 'created' ? 201 : 200 });
    } catch (err) {
      logger.error({ err, userId, tenantId, projectId }, 'content agency pipeline handoff failed');
      sendInternalError(res, 'Failed to move content agency package to pipeline');
    }
  }));
}
