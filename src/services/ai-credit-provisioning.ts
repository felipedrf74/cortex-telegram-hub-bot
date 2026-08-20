// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Included monthly AI credit provisioning (plan §2, QA5 P1-2, QA6 P1).
 *
 * The ledger has always been able to MINT an included monthly lot
 * (`grantMonthlyAiCredits`), but nothing in the runtime ever called it. With
 * admission wired into chat and script jobs, enabling
 * `HYBRID_AI_CREDITS_ENABLED` therefore denied 100% of paid AI: every wallet
 * read returned `availableCredits: 0` and every reservation returned
 * `insufficient_credits`.
 *
 * This module closes that gap with LAZY provisioning:
 * - Admission and the wallet read call `ensureMonthlyAiCreditsForUser` first,
 *   so a paid user's current-period lot exists the moment they need it.
 * - No backfill job and no dependency on renewal webhooks: an existing
 *   subscriber, a user whose renewal notification was lost, and a brand-new
 *   subscriber all provision on their next operation.
 *
 * Period identity is the whole safety story (QA6 P1). The first version keyed
 * the lot on the period END and fell back to a calendar anchor whenever the
 * subscription read failed, so the key moved underneath a user who had paid
 * once — a transient read error, a late renewal webhook, or a mid-period plan
 * change each minted a SECOND live lot. Three rules keep one paid period to
 * one allowance:
 *
 * 1. Anchor on the period START. A mid-period upgrade re-prices the
 *    subscription and moves `current_period_end`, but not the start, so the
 *    key is unchanged and the grant is a no-op. Plan cycling mints nothing.
 * 2. A subscription READ FAILURE denies provisioning instead of silently
 *    switching anchors. Admission then denies this one operation and the next
 *    call retries — a lost read never becomes a second lot.
 * 3. When the period genuinely moves (renewal, or a stopgap calendar lot
 *    replaced by a real billing period), the ledger SUPERSEDES: it revokes
 *    every other live included lot inside the same transaction and grants
 *    exactly the plan allowance. Live included credits can never exceed the
 *    plan allowance, whatever the key says.
 */

import { logger } from '../utils/logger';
import type { BillingPlan } from './plan-quotas';
import {
  MONTHLY_INCLUDED_GRANT_PATH,
  getPlanCreditPolicy,
  grantMonthlyAiCredits,
  registerAiCreditGrantPath,
  type GrantAiCreditsResult,
} from './ai-credit-ledger';
import { getSubscriptionStatus } from './stripe-service';

export interface MonthlyProvisioningPeriod {
  periodKey: string;
  periodEnd: Date;
}

/**
 * `unavailable` is NOT the same as "no subscription": it means the record
 * could not be read at all, and the only safe response is to grant nothing.
 */
export type MonthlyProvisioningPeriodResolution =
  | { kind: 'resolved'; period: MonthlyProvisioningPeriod }
  | { kind: 'unavailable' };

/** End of the current UTC calendar month, used when no billing period exists. */
function calendarMonthPeriod(now: Date): MonthlyProvisioningPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    periodKey: `cal:${year}-${String(month + 1).padStart(2, '0')}`,
    // Day 0 of the next month is the last day of this one, at end of day UTC.
    periodEnd: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
  };
}

/**
 * Resolve the period the included lot belongs to. Exported for tests and for
 * operators reasoning about why a lot carries a given expiry.
 */
export function resolveMonthlyProvisioningPeriod(
  userId: number,
  now: Date,
): MonthlyProvisioningPeriodResolution {
  let subscription: { currentPeriodStart: string | null; currentPeriodEnd: string | null };
  try {
    subscription = getSubscriptionStatus(userId);
  } catch (err) {
    // Deny rather than re-anchor. Falling back to the calendar month here is
    // what let one transient SQLITE_BUSY mint a second lot for a period the
    // user had already been granted (QA6 P1 path A).
    logger.warn(
      { err, userId },
      'ai-credit-provisioning: subscription read failed; denying provisioning for this call',
    );
    return { kind: 'unavailable' };
  }

  const periodEndMs = subscription.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : NaN;
  const hasLivePeriod = Number.isFinite(periodEndMs) && periodEndMs > now.getTime();
  if (!hasLivePeriod) {
    // No usable billing period (Apple-only records, missing timestamps, or a
    // lapsed period awaiting its renewal webhook): the calendar month is the
    // stopgap anchor, and the real period supersedes it when it arrives.
    return { kind: 'resolved', period: calendarMonthPeriod(now) };
  }

  const periodStartMs = subscription.currentPeriodStart
    ? Date.parse(subscription.currentPeriodStart)
    : NaN;
  // Period START is the stable identity. Records written before the start was
  // captured fall back to the end, which is still correct for them — they
  // simply do not get the mid-period-change immunity.
  const anchorIso = Number.isFinite(periodStartMs)
    ? new Date(periodStartMs).toISOString()
    : new Date(periodEndMs).toISOString();
  return {
    kind: 'resolved',
    period: { periodKey: `sub:${anchorIso}`, periodEnd: new Date(periodEndMs) },
  };
}

export type EnsureMonthlyAiCreditsOutcome =
  | { kind: 'granted' }
  | { kind: 'already_granted' }
  | { kind: 'not_applicable'; reason: 'plan_grants_no_monthly_credits' }
  | { kind: 'failed'; reason: string };

/**
 * Make sure the user's included monthly lot for the current period exists.
 * Safe to call on every admission and wallet read: it is idempotent, cheap
 * after the first call in a period, and never throws into the caller.
 */
export function ensureMonthlyAiCreditsForUser(input: {
  userId: number;
  plan: BillingPlan;
  now?: Date;
}): EnsureMonthlyAiCreditsOutcome {
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    return { kind: 'failed', reason: 'invalid userId' };
  }
  try {
    const policy = getPlanCreditPolicy(input.plan);
    if (policy.monthlyCredits <= 0) {
      return { kind: 'not_applicable', reason: 'plan_grants_no_monthly_credits' };
    }
    const resolution = resolveMonthlyProvisioningPeriod(input.userId, now);
    if (resolution.kind === 'unavailable') {
      return { kind: 'failed', reason: 'subscription_period_unavailable' };
    }
    const period = resolution.period;
    const granted: GrantAiCreditsResult = grantMonthlyAiCredits({
      userId: input.userId,
      plan: input.plan,
      periodKey: period.periodKey,
      periodEnd: period.periodEnd,
      now,
    });
    if (granted.kind === 'granted') {
      logger.info(
        { userId: input.userId, plan: input.plan, periodKey: period.periodKey, credits: policy.monthlyCredits },
        'ai-credit-provisioning: included monthly credits granted',
      );
      return { kind: 'granted' };
    }
    if (granted.kind === 'already_granted') return { kind: 'already_granted' };
    return { kind: 'failed', reason: granted.reason };
  } catch (err) {
    // Provisioning is best-effort at call sites that must not fail closed on
    // a ledger hiccup; admission still denies if no credits materialize.
    logger.error({ err, userId: input.userId, plan: input.plan }, 'ai-credit-provisioning: ensure failed');
    return { kind: 'failed', reason: 'exception' };
  }
}

// Activation guard (QA5 P1-2): registering here is a module-load side effect,
// and this module is only in the graph because admission imports it. If a
// regression removes the provisioning call from admission, nothing registers
// and `assertAiCreditActivationReady()` fails at boot instead of the runtime
// silently denying every paid operation.
registerAiCreditGrantPath(MONTHLY_INCLUDED_GRANT_PATH);
