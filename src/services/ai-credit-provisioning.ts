// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Included monthly AI credit provisioning (plan §2, QA5 P1-2).
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
 * - The grant is idempotent per (user, period) inside the ledger, so
 *   concurrent operations mint exactly one lot.
 *
 * Period anchoring:
 * - A paid subscription anchors to its own billing period, so included
 *   credits expire exactly when the paid period does.
 * - Without a usable subscription period end (Apple-only records, missing
 *   timestamps), the calendar month in UTC is the anchor.
 * - The period key deliberately does NOT include the plan: exactly one
 *   included lot exists per user per period. A mid-period upgrade keeps the
 *   lot it already has and receives the higher allowance at the next period,
 *   which makes plan cycling useless as a way to mint extra credit.
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
export function resolveMonthlyProvisioningPeriod(userId: number, now: Date): MonthlyProvisioningPeriod {
  let periodEndIso: string | null = null;
  try {
    periodEndIso = getSubscriptionStatus(userId).currentPeriodEnd;
  } catch (err) {
    // A subscription read failure must not deny AI: fall back to the calendar
    // anchor rather than leaving the user without included credits.
    logger.warn({ err, userId }, 'ai-credit-provisioning: subscription read failed; using calendar period');
  }
  const periodEndMs = periodEndIso ? Date.parse(periodEndIso) : NaN;
  if (Number.isFinite(periodEndMs) && periodEndMs > now.getTime()) {
    return {
      periodKey: `sub:${new Date(periodEndMs).toISOString()}`,
      periodEnd: new Date(periodEndMs),
    };
  }
  return calendarMonthPeriod(now);
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
    const period = resolveMonthlyProvisioningPeriod(input.userId, now);
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
