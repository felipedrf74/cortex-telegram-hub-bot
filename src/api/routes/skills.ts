// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Skills Catalog API — Phase 1 Slice D
 *
 * The iOS Skills tab calls GET /api/v1/skills/catalog to render a tree
 * of parent skills → sub-skills with tier badges and a per-user
 * "accessible now" boolean. The endpoint is PURE — it reads from the
 * skill-config code-level definitions and overlays the DB catalog tier
 * + per-user override state. It does NOT go through the chat pipeline,
 * so it costs $0 in LLM tokens (per the Token-Zero Principle in
 * specs/08-TOKEN-ZERO-ARCHITECTURE.md).
 *
 * Endpoints:
 *   GET  /api/v1/skills/catalog        — full catalog + per-user access
 *   POST /api/v1/skills/override       — admin grants override (owner only)
 *   DEL  /api/v1/skills/override/:id   — admin revokes override (owner only)
 */

import crypto from 'crypto';
import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import { DEFAULT_SKILLS, type SkillDefinition, type SubSkillDefinition, type SkillTier } from '../../skills/skill-config';
import {
  checkSkillAccess,
  listSkillTiers,
  grantOverride,
  revokeOverride,
} from '../../services/skill-tiers';
import {
  activateSkillVersion,
  createSkillVersion,
  getAllSkillMetadata,
  getSkillMetadata,
  listSkillVersions,
  setSkillVersionStatus,
  toPublicSkillVersion,
  type SkillReleaseType,
  type SkillRolloutScope,
  type SkillVersionStatus,
} from '../../services/skill-version-registry';
import { getUserByTelegramId, getUserById } from '../../services/user-service';
import {
  entitlementPlanToSkillTier,
  getEffectiveEntitlement,
} from '../../services/entitlement';
import { logger } from '../../utils/logger';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { invalidateDashboardCoordinationCaches } from '../../services/cache-coherence-registry';

// ─── Response shapes ────────────────────────────────────────────────

interface CatalogSubSkill {
  name: string;
  description: string;
  toolCount: number;
  requiredTier: SkillTier;
  coachPersona: string | null;
  promptFile: string | null;
  /** Whether the CURRENT user can access this sub-skill right now. */
  accessible: boolean;
  /** Reason from the canonical gate, e.g. 'catalog', 'user_grant', or 'global_disabled'. */
  accessReason: string;
}

interface CatalogSkill {
  name: string;
  description: string;
  version: string;
  requiredTier: SkillTier;
  /** Whether the user can access the parent skill — the chat gate. */
  accessible: boolean;
  accessReason: string;
  subSkills: CatalogSubSkill[];
}

interface CatalogResponse {
  userTier: SkillTier;
  skills: CatalogSkill[];
  /** Total catalog row count for UI diagnostics. */
  catalogRowCount: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

function subSkillToCatalog(
  parent: SkillDefinition,
  sub: SubSkillDefinition,
  user: { id: number; tier: SkillTier },
): CatalogSubSkill {
  const skillId = `${parent.name}.${sub.name}`;
  const access = checkSkillAccess(user, skillId);
  return {
    name: sub.name,
    description: sub.description,
    toolCount: sub.tools.length,
    requiredTier: sub.requiredTier ?? parent.requiredTier ?? 'pro',
    coachPersona: sub.coachPersona ?? null,
    promptFile: sub.promptFile ?? null,
    accessible: access.allowed,
    accessReason: access.reason,
  };
}

function skillToCatalog(
  def: SkillDefinition,
  user: { id: number; tier: SkillTier },
): CatalogSkill {
  const parentAccess = checkSkillAccess(user, def.name);
  return {
    name: def.name,
    description: def.description,
    version: def.version,
    requiredTier: def.requiredTier ?? 'pro',
    accessible: parentAccess.allowed,
    accessReason: parentAccess.reason,
    subSkills: def.subSkills.map((sub) => subSkillToCatalog(def, sub, user)),
  };
}

function getCaller(userId: number) {
  return getUserById(userId) || getUserByTelegramId(userId);
}

function requireOwner(res: Response, userId: number): boolean {
  const caller = getCaller(userId);
  const entitlement = caller ? getEffectiveEntitlement(caller.id) : null;
  if (!caller || !entitlement?.isOwner) {
    sendError(res, 'FORBIDDEN', 'Only owner can mutate skill version metadata', 403);
    return false;
  }
  return true;
}

function buildCatalogEtag(payload: CatalogResponse): string {
  return `"skills-catalog-${crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex')}"`;
}

function requestMatchesEtag(req: AuthenticatedRequest, etag: string): boolean {
  const raw = req.headers?.['if-none-match'];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return values.map((value) => value.trim()).some((value) => value === etag);
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseSkillVersionBody(body: any) {
  return {
    skillId: String(body?.skillId ?? ''),
    skillName: String(body?.skillName ?? ''),
    version: String(body?.version ?? ''),
    releaseType: String(body?.releaseType ?? 'minor') as SkillReleaseType,
    releaseTitle: String(body?.releaseTitle ?? ''),
    releaseSummary: String(body?.releaseSummary ?? ''),
    capabilitiesAdded: asStringArray(body?.capabilitiesAdded),
    logicImprovements: asStringArray(body?.logicImprovements),
    bugFixes: asStringArray(body?.bugFixes),
    securityFixes: asStringArray(body?.securityFixes),
    tenantScopeChanges: asStringArray(body?.tenantScopeChanges),
    memoryContextChanges: asStringArray(body?.memoryContextChanges),
    modelRoutingChanges: asStringArray(body?.modelRoutingChanges),
    dataSchemaChanges: asStringArray(body?.dataSchemaChanges),
    iosPortalContractChanges: asStringArray(body?.iosPortalContractChanges),
    testsAdded: asStringArray(body?.testsAdded),
    smokeTestsPassed: asStringArray(body?.smokeTestsPassed),
    evaluationResults: body?.evaluationResults && typeof body.evaluationResults === 'object' && !Array.isArray(body.evaluationResults)
      ? body.evaluationResults as Record<string, unknown>
      : undefined,
    openRisks: asStringArray(body?.openRisks),
    knownLimitations: asStringArray(body?.knownLimitations),
    rollbackNotes: typeof body?.rollbackNotes === 'string' ? body.rollbackNotes : null,
    internalNotes: typeof body?.internalNotes === 'string' ? body.internalNotes : null,
    createdBy: typeof body?.createdBy === 'string' ? body.createdBy : null,
    status: typeof body?.status === 'string' ? body.status as SkillVersionStatus : undefined,
    rolloutScope: typeof body?.rolloutScope === 'string' ? body.rolloutScope as SkillRolloutScope : undefined,
    compatibleApiVersion: typeof body?.compatibleApiVersion === 'string' ? body.compatibleApiVersion : null,
    memorySchemaVersion: typeof body?.memorySchemaVersion === 'string' ? body.memorySchemaVersion : null,
    qualityGateStatus: typeof body?.qualityGateStatus === 'string' ? body.qualityGateStatus : null,
  };
}

// ─── Router ─────────────────────────────────────────────────────────

export function skillsRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'skills_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/skills/catalog
   * Returns the full skill catalog annotated with the current user's
   * per-skill access. Used by the iOS Skills tab to render tier badges
   * and enable/disable UI state.
   *
   * Response shape:
   * {
   *   ok: true,
   *   data: {
   *     userTier: 'pro',
   *     skills: [
   *       {
   *         name: 'triathlon',
   *         description: '...',
   *         version: '3.0.0',
   *         requiredTier: 'pro',
   *         accessible: true,
   *         accessReason: 'catalog',
   *         subSkills: [
   *           {
   *             name: 'gym',
   *             description: 'Strength coach — ...',
   *             toolCount: 0,
   *             requiredTier: 'pro',
   *             coachPersona: 'strength',
   *             promptFile: 'triathlon/gym.md',
   *             accessible: true,
   *             accessReason: 'catalog'
   *           },
   *           ...
   *         ]
   *       }
   *     ],
   *     catalogRowCount: 42
   *   }
   * }
   */
  router.get('/catalog', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    // userId from JWT is now always users.id (since v4.12.0).
    // Telegram ID fallback kept for legacy sessions (7-day JWT expiry).
    const user = getCaller(userId);
    if (!user) {
      sendError(res, 'USER_NOT_FOUND', `User ${userId} not registered`, 404);
      return;
    }

    const entitlement = getEffectiveEntitlement(user.id);
    const effectiveTier = entitlementPlanToSkillTier(entitlement.plan);
    const userCtx = { id: user.id, tier: effectiveTier };
    const skills: CatalogSkill[] = Object.values(DEFAULT_SKILLS).map((def) =>
      skillToCatalog(def, userCtx),
    );

    // Sort for deterministic iOS rendering — secretary first (free anchor),
    // then alphabetical by parent name.
    skills.sort((a, b) => {
      if (a.name === 'secretary') return -1;
      if (b.name === 'secretary') return 1;
      return a.name.localeCompare(b.name);
    });

    const payload: CatalogResponse = {
      userTier: effectiveTier,
      skills,
      catalogRowCount: listSkillTiers().length,
    };

    const etag = buildCatalogEtag(payload);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=30');
    if (requestMatchesEtag(req as AuthenticatedRequest, etag)) {
      res.status(304).end();
      return;
    }

    sendSuccess(res, payload);
  });

  /**
   * GET /api/v1/skills/versions
   * Safe, authenticated read of current release/capability metadata.
   * This is intentionally public to the signed-in user but excludes
   * internal operator notes and raw test logs.
   */
  router.get('/versions', (req, res: Response) => {
    const { tenantId, userId } = req as AuthenticatedRequest;
    sendSuccess(res, {
      skills: getAllSkillMetadata({ tenantId, userId }),
    });
  });

  /**
   * GET /api/v1/skills/versions/:skillId/history
   * Public release history for a skill. Internal notes are omitted.
   */
  router.get('/versions/:skillId/history', (req, res: Response) => {
    const rows = listSkillVersions(req.params.skillId).map(toPublicSkillVersion);
    sendSuccess(res, {
      skillId: req.params.skillId,
      versions: rows,
    });
  });

  /**
   * GET /api/v1/skills/versions/:skillId
   * Current active metadata for one skill, with tenant/user rollout
   * resolution when scoped releases exist.
   */
  router.get('/versions/:skillId', (req, res: Response) => {
    const { tenantId, userId } = req as unknown as AuthenticatedRequest;
    sendSuccess(res, getSkillMetadata(req.params.skillId, { tenantId, userId }));
  });

  /**
   * POST /api/v1/skills/versions
   * Owner-only release metadata creation. This creates release truth;
   * it does not enable/disable skills and does not change model routing.
   */
  router.post('/versions', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!requireOwner(res, userId)) return;

    try {
      const created = createSkillVersion(parseSkillVersionBody(req.body));
      sendSuccess(res, toPublicSkillVersion(created), { status: 201 });
    } catch (err: any) {
      logger.warn({ err }, 'createSkillVersion failed');
      sendError(res, 'BAD_REQUEST', err?.message || 'Invalid skill version payload');
    }
  });

  /**
   * POST /api/v1/skills/versions/:skillId/:version/status
   * Owner-only status transition. Used by release management and rollback
   * reporting; it does not deploy code.
   */
  router.post('/versions/:skillId/:version/status', (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!requireOwner(res, userId)) return;

    const status = req.body?.status as SkillVersionStatus | undefined;
    if (!status) {
      sendError(res, 'BAD_REQUEST', 'status is required');
      return;
    }

    try {
      const updated = setSkillVersionStatus(req.params.skillId, req.params.version, status, {
        actor: String(userId),
      });
      sendSuccess(res, toPublicSkillVersion(updated));
    } catch (err: any) {
      logger.warn({ err, skillId: req.params.skillId, version: req.params.version }, 'setSkillVersionStatus failed');
      sendError(res, 'BAD_REQUEST', err?.message || 'Invalid skill version status transition');
    }
  });

  /**
   * POST /api/v1/skills/versions/:skillId/:version/activate
   * Owner-only rollout activation. Supports global, tenant, user, and
   * canary-scoped release metadata without changing existing skill flows.
   */
  router.post('/versions/:skillId/:version/activate', (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!requireOwner(res, userId)) return;

    try {
      const activated = activateSkillVersion(req.params.skillId, req.params.version, {
        scopeType: req.body?.scopeType as SkillRolloutScope | undefined,
        tenantId: typeof req.body?.tenantId === 'number' ? req.body.tenantId : null,
        userId: typeof req.body?.targetUserId === 'number' ? req.body.targetUserId : null,
        canaryKey: typeof req.body?.canaryKey === 'string' ? req.body.canaryKey : null,
        actor: String(userId),
        notes: typeof req.body?.notes === 'string' ? req.body.notes : null,
      });
      sendSuccess(res, toPublicSkillVersion(activated));
    } catch (err: any) {
      logger.warn({ err, skillId: req.params.skillId, version: req.params.version }, 'activateSkillVersion failed');
      sendError(res, 'BAD_REQUEST', err?.message || 'Invalid skill version activation');
    }
  });

  /**
   * POST /api/v1/skills/override
   * Admin grants a per-user skill access override. Only the owner can
   * call this. The override bypasses the tier gate for the specified
   * user + skill ID combination.
   *
   * Request body:
   * {
   *   targetUserId: 123,       // telegram user id to grant access to
   *   skillId: 'triathlon.gym',
   *   reason?: 'beta tester',
   *   expiresAt?: '2026-12-31T23:59:59Z'  // optional ISO expiry
   * }
   */
  router.post('/override', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!requireOwner(res, userId)) return;

    const { targetUserId, skillId, reason, expiresAt } = req.body ?? {};
    if (typeof targetUserId !== 'number' || typeof skillId !== 'string') {
      sendError(res, 'BAD_REQUEST', 'targetUserId (number) and skillId (string) are required');
      return;
    }

    const target = getUserByTelegramId(targetUserId);
    if (!target) {
      sendError(res, 'USER_NOT_FOUND', `Target user ${targetUserId} not found`, 404);
      return;
    }

    try {
      grantOverride({
        userId: target.id,
        skillId,
        reason,
        grantedBy: userId,
        expiresAt,
      });
      invalidateDashboardCoordinationCaches(target.id);
      sendSuccess(res, { granted: true, targetUserId, skillId, expiresAt: expiresAt ?? null });
    } catch (err: any) {
      logger.error({ err, targetUserId, skillId }, 'grantOverride failed');
      sendInternalError(res, 'Failed to grant override');
    }
  });

  /**
   * DELETE /api/v1/skills/override
   * Admin revokes a per-user skill override.
   *
   * The iOS client sends identifiers as query params because the
   * HTTP client's DELETE helper doesn't carry a body. The Telegram
   * portal sends them in the body. Both paths are accepted here —
   * the body wins if both are present.
   *
   * Query params:   ?targetUserId=123&skillId=triathlon.gym
   * Request body:   { targetUserId: 123, skillId: 'triathlon.gym' }
   */
  router.delete('/override', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!requireOwner(res, userId)) return;

    // Accept from body OR query string — body takes precedence.
    const bodyTarget = req.body?.targetUserId;
    const queryTarget = req.query?.targetUserId;
    const rawTargetUserId = bodyTarget ?? queryTarget;
    const targetUserId =
      typeof rawTargetUserId === 'string' ? Number(rawTargetUserId) : rawTargetUserId;
    const skillId = (req.body?.skillId ?? req.query?.skillId) as string | undefined;

    if (typeof targetUserId !== 'number' || Number.isNaN(targetUserId) || typeof skillId !== 'string') {
      sendError(res, 'BAD_REQUEST', 'targetUserId (number) and skillId (string) are required');
      return;
    }

    const target = getUserByTelegramId(targetUserId);
    if (!target) {
      sendError(res, 'USER_NOT_FOUND', `Target user ${targetUserId} not found`, 404);
      return;
    }

    const removed = revokeOverride(target.id, skillId);
    if (removed) {
      invalidateDashboardCoordinationCaches(target.id);
    }
    sendSuccess(res, { revoked: removed, targetUserId, skillId });
  });

  return router;
}
