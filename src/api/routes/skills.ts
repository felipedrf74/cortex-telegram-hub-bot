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

import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError } from '../response-helpers';
import { DEFAULT_SKILLS, type SkillDefinition, type SubSkillDefinition, type SkillTier } from '../../skills/skill-config';
import {
  checkTierAccess,
  listSkillTiers,
  grantOverride,
  revokeOverride,
} from '../../services/skill-tiers';
import { getUserByTelegramId, getUserById } from '../../services/user-service';
import { logger } from '../../utils/logger';

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
  /** Reason from the gate: 'catalog' | 'override' | 'default' | 'denied'. */
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
  const access = checkTierAccess(user, skillId);
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
  const parentAccess = checkTierAccess(user, def.name);
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

// ─── Router ─────────────────────────────────────────────────────────

export function skillsRoutes(): Router {
  const router = Router();

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
    // userId from JWT may be autoincrement ID (iOS) or telegram_id (bot).
    // Try both lookups to support multi-provider auth.
    const user = getUserById(userId) || getUserByTelegramId(userId);
    if (!user) {
      sendError(res, 'USER_NOT_FOUND', `User ${userId} not registered`, 404);
      return;
    }

    const userCtx = { id: user.id, tier: user.tier as SkillTier };
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
      userTier: user.tier as SkillTier,
      skills,
      catalogRowCount: listSkillTiers().length,
    };

    sendSuccess(res, payload);
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
    const caller = getUserById(userId) || getUserByTelegramId(userId);
    if (!caller || caller.tier !== 'owner') {
      sendError(res, 'FORBIDDEN', 'Only owner can grant skill overrides', 403);
      return;
    }

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
      sendSuccess(res, { granted: true, targetUserId, skillId, expiresAt: expiresAt ?? null });
    } catch (err: any) {
      logger.error({ err, targetUserId, skillId }, 'grantOverride failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to grant override', 500);
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
    const caller = getUserById(userId) || getUserByTelegramId(userId);
    if (!caller || caller.tier !== 'owner') {
      sendError(res, 'FORBIDDEN', 'Only owner can revoke skill overrides', 403);
      return;
    }

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
    sendSuccess(res, { revoked: removed, targetUserId, skillId });
  });

  return router;
}
