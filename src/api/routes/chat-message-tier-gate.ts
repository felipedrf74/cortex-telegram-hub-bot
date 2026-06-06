// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { checkSkillAccess } from '../../services/skill-tiers';
import { getUserById, getUserByTelegramId } from '../../services/user-service';
import { entitlementPlanToSkillTier, getEffectiveEntitlement } from '../../services/entitlement';
import { logger } from '../../utils/logger';

export function sendChatTierRequiredIfNeeded(
  res: Response,
  userId: number,
  domain: string,
): boolean {
  try {
    const user = getUserById(userId) || getUserByTelegramId(userId);
    if (!user) return false;

    const entitlement = getEffectiveEntitlement(user.id);
    const accessResult = checkSkillAccess(
      { id: user.id, tier: entitlementPlanToSkillTier(entitlement.plan) },
      domain,
    );
    if (accessResult.allowed) return false;

    logger.info(
      {
        userId,
        domain,
        userTier: accessResult.userTier,
        requiredTier: accessResult.requiredTier,
        reason: accessResult.reason,
      },
      'iOS tier gate blocked message',
    );
    res.status(403).json({
      error: {
        code: 'TIER_REQUIRED',
        message: `This feature requires the ${accessResult.requiredTier} tier. Your current tier: ${accessResult.userTier}.`,
        details: {
          domain,
          userTier: accessResult.userTier,
          requiredTier: accessResult.requiredTier,
          reason: accessResult.reason,
        },
      },
    });
    return true;
  } catch (err) {
    logger.warn({ err, userId, domain }, 'iOS tier gate check failed — fail-closed');
    res.status(503).json({
      error: {
        code: 'ACCESS_CHECK_UNAVAILABLE',
        message: 'Nexus could not verify access for this request. Please try again.',
        details: { domain },
      },
    });
    return true;
  }
}
