// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { logger } from '../../utils/logger';
import {
  ContentAgencyIntegrityError,
  ContentAgencyPackageVersionError,
  ContentAgencyValidationError,
  buildContentAgencyBrief,
  buildContentAgencyCompetitorStudy,
  buildContentAgencyPackage,
  buildContentAgencyTranscriptStudy,
  evaluateContentAgencyPackage,
  getContentAgencyPackage,
  getContentAgencyProject,
  handoffContentAgencyPackageToWorkspace,
  normalizeContentAgencyArtifactId,
  persistContentAgencyArtifact,
  persistContentAgencyPackageBundle,
  type ContentAgencyBriefInput,
  type ContentAgencyCompetitorInput,
  type ContentAgencyPackageInput,
  validateContentAgencyReadiness,
} from '../../services/content-agency';
import {
  listContentAgencyRules,
  validateContentAgencyRuleCoverage,
  validateContentAgencyRuntimeRuleCoverage,
} from '../../services/content-agency-rules';
import { assertTenantScope, requireMutationScope, TenantScopeError } from '../../services/tenant-scope';
import { ContentWorkspaceWriteDisabledError } from '../../services/content-workspace-capabilities';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';

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

function routeContentAgencyTenantId(
  req: AuthenticatedRequest,
  res: Response,
  operation: string,
  mutationTable?: string,
): number | null {
  try {
    return (mutationTable
      ? requireMutationScope(req, mutationTable, operation)
      : assertTenantScope(req, operation)).tenantId;
  } catch (err) {
    if (err instanceof TenantScopeError) {
      sendError(res, err.code, err.message, err.status);
      return null;
    }
    throw err;
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().slice(0, 2_048))
      .filter(Boolean)
      .slice(0, 64)
    : [];
}

function uniqueStrings(...values: unknown[]): string[] {
  return [...new Set(values.flatMap(toStringArray))].slice(0, 64);
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
  const rawConfidence = artifact?.confidence ?? brief?.confidence ?? fallback.confidence;
  const confidence = typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0.5;
  const rawQualityScore = quality?.score ?? artifact?.qualityScore ?? fallback.qualityScore;
  const visibilityScope = artifact?.visibilityScope ?? brief?.visibilityScope ?? fallback.visibilityScope;
  const platform = artifact?.platform ?? brief?.platform ?? fallback.platform;
  const format = artifact?.format ?? brief?.format ?? fallback.format;
  const objective = artifact?.objective ?? brief?.objective ?? brief?.goal ?? fallback.objective;
  const tenantId = artifact?.tenantId ?? brief?.tenantId ?? fallback.tenantId;
  const userId = artifact?.userId ?? brief?.userId ?? fallback.userId;

  return {
    tenantId: Number.isSafeInteger(tenantId) && Number(tenantId) > 0
      ? Number(tenantId)
      : null,
    userId: Number.isSafeInteger(userId) && Number(userId) > 0
      ? Number(userId)
      : null,
    visibilityScope: visibilityScope === 'tenant_shared' || visibilityScope === 'platform_internal'
      ? visibilityScope
      : 'user_private',
    platform: typeof platform === 'string' && platform.trim() ? platform.trim().slice(0, 80) : 'generic',
    format: typeof format === 'string' && format.trim() ? format.trim().slice(0, 80) : 'generic_script',
    objective: typeof objective === 'string' && objective.trim()
      ? objective.trim().slice(0, 600)
      : 'Build a useful content package',
    sourceTrace,
    referenceIds,
    confidence,
    qualityScore: typeof rawQualityScore === 'number' && Number.isFinite(rawQualityScore)
      ? Math.max(0, Math.min(100, rawQualityScore))
      : null,
    warnings,
    blockers,
    reviewRequired: typeof artifact?.reviewRequired === 'boolean'
      ? artifact.reviewRequired
      : typeof fallback.reviewRequired === 'boolean'
        ? fallback.reviewRequired
        : blockers.length > 0 || warnings.length > 0,
    nextBestActions,
  };
}

function requireAgencyRequestBody(value: unknown, field = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentAgencyValidationError(`${field} must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

function bindPrivateAgencyScope(
  value: unknown,
  userId: number,
  tenantId: number,
  field: string,
): Record<string, unknown> {
  const input = value === undefined || value === null
    ? {}
    : requireAgencyRequestBody(value, field);
  if (input.userId !== undefined && input.userId !== userId) {
    throw new ContentAgencyValidationError(`${field}.userId must match the authenticated user.`, `${field}.userId`);
  }
  if (input.tenantId !== undefined && input.tenantId !== tenantId) {
    throw new ContentAgencyValidationError(`${field}.tenantId must match the authenticated tenant.`, `${field}.tenantId`);
  }
  if (input.visibilityScope !== undefined && input.visibilityScope !== 'user_private') {
    throw new ContentAgencyValidationError(
      `${field}.visibilityScope must be user_private on public Content Agency routes.`,
      `${field}.visibilityScope`,
    );
  }
  return {
    ...input,
    userId,
    tenantId,
    visibilityScope: 'user_private',
  };
}

function safeAgencyErrorFields(error: unknown): { errorName: string; errorCode: string } {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  const safeToken = (value: unknown, fallback: string): string => (
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value)
      ? value
      : fallback
  );
  return {
    errorName: safeToken(candidate?.name, typeof error),
    errorCode: safeToken(candidate?.code, 'CONTENT_AGENCY_INTERNAL_ERROR'),
  };
}

function sendContentAgencyFailure(
  res: Response,
  error: unknown,
  context: { operation: string; userId: number; tenantId: number },
  publicMessage: string,
): void {
  if (error instanceof ContentAgencyValidationError) {
    sendError(res, error.code, error.message, error.status, { field: error.field });
    return;
  }
  if (error instanceof ContentAgencyIntegrityError) {
    sendError(res, error.code, error.message, error.status);
    return;
  }
  if (error instanceof ContentAgencyPackageVersionError) {
    sendError(res, error.code, error.message, error.status);
    return;
  }
  logger.error({
    ...safeAgencyErrorFields(error),
    operation: context.operation,
    userId: context.userId,
    tenantId: context.tenantId,
  }, 'content agency operation failed');
  sendInternalError(res, publicMessage);
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
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_brief_create')) return;
    const tenantId = routeContentAgencyTenantId(authReq, res, 'content_agency_brief_create', 'content_agency_artifacts');
    if (tenantId == null) return;

    try {
      const brief = buildContentAgencyBrief(bindPrivateAgencyScope(
        requireAgencyRequestBody(req.body),
        userId,
        tenantId,
        'body',
      ) as unknown as ContentAgencyBriefInput);
      persistContentAgencyArtifact('brief', brief);
      sendSuccess(res, { brief, contract: buildResponseContract(brief) }, { status: 201 });
    } catch (err) {
      sendContentAgencyFailure(
        res,
        err,
        { operation: 'content_agency_brief_create', userId, tenantId },
        'Failed to create content agency brief',
      );
    }
  }));

  router.post('/agency/competitor-study', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_competitor_study')) return;
    const tenantId = routeContentAgencyTenantId(authReq, res, 'content_agency_competitor_study', 'content_agency_artifacts');
    if (tenantId == null) return;

    try {
      const body = bindPrivateAgencyScope(
        requireAgencyRequestBody(req.body),
        userId,
        tenantId,
        'body',
      );
      const fallbackBrief = buildContentAgencyBrief(bindPrivateAgencyScope(
        body.brief,
        userId,
        tenantId,
        'brief',
      ) as unknown as ContentAgencyBriefInput);
      const study = buildContentAgencyCompetitorStudy({
        userId,
        tenantId,
        brief: fallbackBrief,
        competitors: body.competitors as ContentAgencyCompetitorInput['competitors'],
      });
      persistContentAgencyArtifact('competitor_study', study);
      sendSuccess(res, { study, contract: buildResponseContract(study, buildResponseContract(fallbackBrief)) }, { status: 201 });
    } catch (err) {
      sendContentAgencyFailure(
        res,
        err,
        { operation: 'content_agency_competitor_study', userId, tenantId },
        'Failed to create competitor study',
      );
    }
  }));

  router.post('/agency/transcript-study', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_transcript_study')) return;
    const tenantId = routeContentAgencyTenantId(authReq, res, 'content_agency_transcript_study', 'content_agency_artifacts');
    if (tenantId == null) return;

    try {
      const body = bindPrivateAgencyScope(
        requireAgencyRequestBody(req.body),
        userId,
        tenantId,
        'body',
      );
      const fallbackBrief = buildContentAgencyBrief(bindPrivateAgencyScope(
        body.brief,
        userId,
        tenantId,
        'brief',
      ) as unknown as ContentAgencyBriefInput);
      const study = buildContentAgencyTranscriptStudy({
        userId,
        tenantId,
        transcript: body.transcript as string | null | undefined,
        title: body.title as string | null | undefined,
      });
      persistContentAgencyArtifact('transcript_study', study);
      sendSuccess(res, { study, contract: buildResponseContract(study, buildResponseContract(fallbackBrief)) }, { status: 201 });
    } catch (err) {
      sendContentAgencyFailure(
        res,
        err,
        { operation: 'content_agency_transcript_study', userId, tenantId },
        'Failed to create transcript study',
      );
    }
  }));

  router.post('/agency/package', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_package_create')) return;
    const tenantId = routeContentAgencyTenantId(authReq, res, 'content_agency_package_create', 'content_agency_artifacts');
    if (tenantId == null) return;

    try {
      const body = bindPrivateAgencyScope(
        requireAgencyRequestBody(req.body),
        userId,
        tenantId,
        'body',
      );
      const pkg = buildContentAgencyPackage({
        ...body,
        brief: bindPrivateAgencyScope(body.brief, userId, tenantId, 'brief'),
        userId,
        tenantId,
      } as unknown as ContentAgencyPackageInput);
      const persistence = persistContentAgencyPackageBundle(pkg);
      sendSuccess(res, {
        package: persistence.package,
        contract: buildResponseContract(persistence.package),
        mutation: { created: persistence.created, replayed: !persistence.created },
      }, { status: persistence.created ? 201 : 200 });
    } catch (err) {
      sendContentAgencyFailure(
        res,
        err,
        { operation: 'content_agency_package_create', userId, tenantId },
        'Failed to create content agency package',
      );
    }
  }));

  router.post('/agency/score', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_score')) return;
    const tenantId = routeContentAgencyTenantId(authReq, res, 'content_agency_score', 'content_agency_artifacts');
    if (tenantId == null) return;

    try {
      const body = requireAgencyRequestBody(req.body);
      const submittedPackage = requireAgencyRequestBody(body.package, 'package');
      const packageId = normalizeContentAgencyArtifactId(submittedPackage.id, 'package.id');
      const pkg = getContentAgencyPackage({ userId, tenantId, id: packageId });
      if (!pkg) {
        sendError(res, 'NOT_FOUND', 'Content agency package not found', 404);
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
        tenantId,
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
      sendContentAgencyFailure(
        res,
        err,
        { operation: 'content_agency_score', userId, tenantId },
        'Failed to score content agency package',
      );
    }
  }));

  router.get('/agency/projects/:id', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_project_get')) return;
    const tenantId = routeContentAgencyTenantId(authReq, res, 'content_agency_project_get');
    if (tenantId == null) return;

    try {
      const projectId = normalizeContentAgencyArtifactId(req.params.id, 'projectId');
      const project = getContentAgencyProject({
        userId,
        tenantId,
        id: projectId,
      });
      if (!project) {
        sendError(res, 'NOT_FOUND', 'Content agency project not found', 404);
        return;
      }
      sendSuccess(res, { ...project, contract: buildResponseContract(project.artifact) });
    } catch (err) {
      sendContentAgencyFailure(
        res,
        err,
        { operation: 'content_agency_project_get', userId, tenantId },
        'Failed to read content agency project',
      );
    }
  }));

  router.post('/agency/projects/:id/handoff', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidContentRouteScope(res, userId, 'content_agency_workspace_handoff')) return;
    const tenantId = routeContentAgencyTenantId(authReq, res, 'content_agency_workspace_handoff', 'content_domain_objects');
    if (tenantId == null) return;

    try {
      const projectId = normalizeContentAgencyArtifactId(req.params.id, 'projectId');
      const result = handoffContentAgencyPackageToWorkspace({
        userId,
        tenantId,
        packageId: projectId,
      });
      if (result.changed) invalidateContentDerivedCaches(userId);
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Content agency package not found', 404, {
          handoff: result,
          contract: buildResponseContract(result, {
            tenantId,
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
        sendError(res, 'CONTENT_AGENCY_HANDOFF_BLOCKED', 'Resolve blockers before adding this package to the Content workspace.', 409, {
          handoff: result,
          contract: buildResponseContract(result, {
            tenantId,
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
          tenantId,
          userId,
          visibilityScope: 'user_private',
          warnings: result.warnings,
          blockers: result.blockers,
          nextBestActions: result.nextBestActions,
          sourceTrace: result.sourceTrace,
          reviewRequired: true,
        }),
      }, { status: result.status === 'created' ? 201 : 200 });
    } catch (err) {
      if (err instanceof ContentWorkspaceWriteDisabledError) {
        sendError(res, err.code, err.message, err.status, err.details);
        return;
      }
      sendContentAgencyFailure(
        res,
        err,
        { operation: 'content_agency_workspace_handoff', userId, tenantId },
        'Failed to add content agency package to the Content workspace',
      );
    }
  }));
}
