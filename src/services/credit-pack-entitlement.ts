// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Server-owned eligibility for credit-pack purchases.
 *
 * The product contract permits packs only while the owning Nexus account has
 * an active Pro or Max subscription. The mutable subscription row cannot
 * prove whether a historical period was paid rather than trialing, so terminal
 * rows fail closed. Delayed Apple fulfillment remains retryable until the
 * authoritative active paid entitlement is present; an already-granted lot is
 * handled idempotently by the fulfillment service before this check.
 */

import { logger } from '../utils/logger';
import { getEffectiveEntitlement } from './entitlement';

export function isCreditPackPurchaseEligible(input: {
  userId: number;
}): boolean {
  if (!Number.isInteger(input.userId) || input.userId <= 0) return false;
  try {
    const entitlement = getEffectiveEntitlement(input.userId);
    return (entitlement.plan === 'pro' || entitlement.plan === 'max')
      && entitlement.status === 'active'
      && !entitlement.isTrial
      && entitlement.nexusPointsAllowed
      && (entitlement.source === 'apple'
        || entitlement.source === 'stripe'
        || entitlement.source === 'founder');
  } catch (err) {
    logger.error({ err, userId: input.userId }, 'credit-pack entitlement check failed closed');
    return false;
  }
}
