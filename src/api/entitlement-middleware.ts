// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Express middleware that gates a route (or router) behind a minimum
 * plan tier AND a skill-allowlist check. Replaces the ad-hoc-per-route
 * inline checks the entitlement audit (2026-04-21) found missing on
 * `/content`, `/cooking`, `/finance`, and `/training`.
 *
 * USAGE
 *
 *   // Block /api/v1/content from Free users entirely.
 *   router.use('/content', requireEntitlement({ skill: 'content' }),
 *             contentRoutes());
 *
 *   // Block /api/v1/cooking from Free users, but let Pro+ in.
 *   router.use('/cooking', requireEntitlement({ skill: 'cooking' }),
 *             cookingRoutes());
 *
 * The middleware runs AFTER authMiddleware, so `req.userId` is
 * already populated. It uses the canonical `getEffectiveEntitlement`
 * resolver (see services/entitlement.ts) — there is no tier-related
 * DB read duplicated in each route.
 *
 * ERROR SHAPE
 *
 *   403 FORBIDDEN { code: 'TIER_REQUIRED', details: { requiredPlan, currentPlan, skill } }
 *
 * The iOS client renders a paywall when it sees `TIER_REQUIRED`. The
 * backend no longer trusts the client to gate on its own — Free users
 * hitting /content/discover directly get a 403 before any AI spend.
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth-middleware';
import { sendError } from './response-helpers';
import { getEffectiveEntitlement, isSkillAllowedByEntitlement } from '../services/entitlement';
import { logger } from '../utils/logger';

export interface RequireEntitlementOptions {
  /** The skill id being gated (e.g. 'content', 'cooking', 'finance'). */
  skill: string;
  /**
   * Optional additional plan-floor check. By default the allow-list is
   * the only gate — if the user's entitlement has the skill in its
   * `allowedSkills` set they pass. Set this when a specific route needs
   * to enforce Max-only even though the skill is technically allowed on
   * Pro (currently future-proofing only — no route uses this today).
   *
   * 2026-04-21 pass 2: default was 'pro', which meant the middleware
   * over-denied Free users on routes that happened to use this on a
   * free skill (e.g. if Secretary ever got gated through it). Now
   * the allow-list IS the contract; minPlan is an optional extra floor.
   */
  minPlan?: 'free' | 'pro' | 'max';
}

export function requireEntitlement(opts: RequireEntitlementOptions) {
  const minPlan: 'free' | 'pro' | 'max' = opts.minPlan ?? 'free';
  return function entitlementMiddleware(req: Request, res: Response, next: NextFunction): void {
    const userId = (req as AuthenticatedRequest).userId;
    if (typeof userId !== 'number' || userId <= 0) {
      // authMiddleware should have caught this; be defensive anyway.
      sendError(res, 'UNAUTHORIZED', 'Authenticated user required', 401);
      return;
    }

    const entitlement = getEffectiveEntitlement(userId);

    // Skill-allowlist check: free tier only has Secretary.
    if (!isSkillAllowedByEntitlement(entitlement, opts.skill)) {
      logger.info(
        { userId, skill: opts.skill, plan: entitlement.plan, source: entitlement.source },
        'entitlement: rejected free-tier call to paid skill',
      );
      sendError(
        res,
        'TIER_REQUIRED',
        `Upgrade required to access ${opts.skill}`,
        403,
        {
          requiredPlan: minPlan,
          currentPlan: entitlement.plan,
          skill: opts.skill,
          source: entitlement.source,
        },
      );
      return;
    }

    // Plan-level floor (currently only relevant if some skills require
    // Max explicitly — today every paid plan gets everything, so this
    // branch is future-proofing).
    const rank = planRank(entitlement.plan);
    if (rank < planRank(minPlan)) {
      logger.info(
        { userId, skill: opts.skill, plan: entitlement.plan, minPlan },
        'entitlement: rejected user with insufficient plan',
      );
      sendError(
        res,
        'TIER_REQUIRED',
        `Plan ${minPlan} or higher required`,
        403,
        { requiredPlan: minPlan, currentPlan: entitlement.plan, skill: opts.skill },
      );
      return;
    }

    // Attach the entitlement for downstream handlers that want to
    // emit usage-remaining metadata or render paywall hints without
    // re-querying.
    (req as AuthenticatedRequest & { entitlement?: ReturnType<typeof getEffectiveEntitlement> }).entitlement = entitlement;
    next();
  };
}

function planRank(plan: string): number {
  switch (plan) {
  case 'free': return 0;
  case 'pro': return 1;
  case 'max': return 2;
  case 'beta':
  case 'owner':
    return 3;
  default:
    return 0;
  }
}
