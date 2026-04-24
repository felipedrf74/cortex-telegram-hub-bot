// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { checkTierAccess } from '../../services/skill-tiers';
import { getUserById, getUserByTelegramId } from '../../services/user-service';
import { logger } from '../../utils/logger';

export function sendChatTierRequiredIfNeeded(
  res: Response,
  userId: number,
  domain: string,
): boolean {
  try {
    const user = getUserById(userId) || getUserByTelegramId(userId);
    if (!user) return false;

    const tierResult = checkTierAccess({ id: user.id, tier: user.tier }, domain);
    if (tierResult.allowed) return false;

    logger.info(
      {
        userId,
        domain,
        userTier: tierResult.userTier,
        requiredTier: tierResult.requiredTier,
        reason: tierResult.reason,
      },
      'iOS tier gate blocked message',
    );
    res.status(403).json({
      error: {
        code: 'TIER_REQUIRED',
        message: `This feature requires the ${tierResult.requiredTier} tier. Your current tier: ${tierResult.userTier}.`,
        details: {
          domain,
          userTier: tierResult.userTier,
          requiredTier: tierResult.requiredTier,
        },
      },
    });
    return true;
  } catch (err) {
    logger.warn({ err }, 'iOS tier gate check failed — falling through (fail-open)');
    return false;
  }
}
