// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Canonical entitlement resolver.
 *
 * Before this module existed, five places answered "what is user X's
 * effective plan?" and they disagreed:
 *
 *   • `cost-guardrail.resolvePlanFromSubscriptionState` (file-private,
 *     reads subscriptions + users.tier + isOwnerUserRef)
 *   • `skill-tiers.checkTierAccess` (reads ONLY users.tier — ignored
 *     subscription status, so a canceled user kept 'pro' access)
 *   • `stripe-service.getSubscriptionStatus` (reads subscriptions
 *     directly, derives own boolean)
 *   • `dashboard.hasHomeSkillAccess` (combines checkTierAccess +
 *     isSkillEnabled with AND)
 *   • Each individual route doing its own ad-hoc read
 *
 * This file replaces all of them with one pure resolver that returns
 * a `UserEntitlement` — every downstream gate reads from here.
 *
 * ## Precedence (top wins)
 *
 *   1. OWNER (env-configured OWNER_TELEGRAM_ID) → 'owner'
 *   2. Active founder assignment (provider='founder') → founder.plan
 *   3. Active Apple App Store subscription → subscription.plan
 *   4. Active Stripe/web subscription → subscription.plan
 *   5. Active beta sandbox grant (trialing, invite-code era) → 'max'
 *   6. Otherwise → 'free'
 *
 * Free users get the Secretary skill ONLY and the budget defined in
 * `FREE_DAILY_COST_CAP_USD` (see plan-quotas.ts). Any skill other
 * than Secretary requires plan ≥ pro.
 *
 * ## Fail-closed behavior
 *
 * Any DB error during resolution returns a degraded 'free' entitlement
 * with `source: 'error'`. This is intentionally conservative — better
 * to fall back to the tightest budget than to accidentally grant
 * Max-tier access when the database hiccups.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { isOwnerUserRef } from './user-service';
import { type BillingPlan, getEffectiveDailyCostLimitUsd } from './plan-quotas';

// ── Types ────────────────────────────────────────────────────────

export type EntitlementSource =
  | 'owner'      // user is the configured OWNER (Felipe)
  | 'founder'    // portal-assigned founder (subscriptions.provider='founder')
  | 'apple'      // active Apple App Store subscription
  | 'stripe'     // active website/Stripe subscription
  | 'beta'       // beta-sandbox trial (trialing + non-canonical provider)
  | 'free'       // no privileged state — default for every registrant
  | 'error';     // DB lookup failed — degraded fail-closed

export type EntitlementStatus = 'active' | 'past_due' | 'expired' | 'none';

export interface UserEntitlement {
  userId: number;
  plan: BillingPlan;
  source: EntitlementSource;
  status: EntitlementStatus;
  subscriptionProvider: string | null;
  subscriptionExpiresAt: string | null;
  isFounder: boolean;
  isOwner: boolean;
  /** Daily cost cap in USD, picked up from plan-quotas.ts which
   *  honors portal overrides. Callers MUST use this value instead of
   *  re-deriving from the plan string. */
  dailyCostCapUsd: number;
  /** Set of allowed skill ids. Free users get Secretary only. Pro/Max
   *  get everything from the skill-tiers catalog. */
  allowedSkills: ReadonlySet<string>;
  evaluatedAt: string;
}

/**
 * Skill IDs that Free-tier users are allowed to access. Secretary is
 * the "free tier anchor" — every user, even free, gets a taste. All
 * other skills require plan ≥ pro.
 */
export const FREE_TIER_ALLOWED_SKILLS: ReadonlySet<string> = new Set([
  'secretary',
]);

// Rows
interface SubscriptionRow {
  plan: string | null;
  status: string | null;
  provider: string | null;
  current_period_end: string | null;
}

/** Paywall kill-switch — when false, every user gets owner-equivalent
 *  Max-tier access. Used during beta so internal testers don't hit the
 *  cap. Production must ship with this true. */
const PAYWALL_ENABLED = (process.env.PAYWALL_ENABLED ?? 'true') !== 'false';

// ── Public API ───────────────────────────────────────────────────

/**
 * Resolve the effective entitlement for a user. Safe to call on the
 * hot path — the work is 2 indexed SELECTs + a few pure comparisons.
 * Returns a synthesized 'free' entitlement if `userId` is falsy/zero.
 */
export function getEffectiveEntitlement(userId: number | null | undefined): UserEntitlement {
  const evaluatedAt = new Date().toISOString();

  if (typeof userId !== 'number' || userId <= 0) {
    return freeEntitlement({
      userId: 0,
      source: 'free',
      evaluatedAt,
      isOwner: false,
      isFounder: false,
    });
  }

  if (!PAYWALL_ENABLED) {
    // Beta kill-switch: everyone is treated as owner (max-tier, high
    // cost cap). Production MUST enable the paywall before GA.
    return {
      userId,
      plan: 'owner',
      source: 'owner',
      status: 'active',
      subscriptionProvider: 'paywall_disabled',
      subscriptionExpiresAt: null,
      isFounder: false,
      isOwner: isOwnerUserRef(userId),
      dailyCostCapUsd: getEffectiveDailyCostLimitUsd('owner'),
      allowedSkills: allSkills(),
      evaluatedAt,
    };
  }

  // Rule 1 — env-configured owner
  let isOwner = false;
  try {
    isOwner = isOwnerUserRef(userId);
  } catch {
    isOwner = false;
  }
  if (isOwner) {
    return {
      userId,
      plan: 'owner',
      source: 'owner',
      status: 'active',
      subscriptionProvider: 'owner',
      subscriptionExpiresAt: null,
      isFounder: false,
      isOwner: true,
      dailyCostCapUsd: getEffectiveDailyCostLimitUsd('owner'),
      allowedSkills: allSkills(),
      evaluatedAt,
    };
  }

  // Rules 2-5 — subscription table
  let sub: SubscriptionRow | undefined;
  try {
    const db = getDb();
    sub = db
      .prepare(
        'SELECT plan, status, provider, current_period_end FROM subscriptions WHERE user_id = ?',
      )
      .get(userId) as SubscriptionRow | undefined;
  } catch (err) {
    logger.error({ err, userId }, 'Entitlement resolve: subscription lookup failed — fail-closed to free');
    return freeEntitlement({ userId, source: 'error', evaluatedAt, isOwner: false, isFounder: false });
  }

  const subscriptionExpiresAt = sub?.current_period_end ?? null;
  const isActiveSub = sub?.status === 'active' || sub?.status === 'trialing';

  if (sub && isActiveSub) {
    const plan = normalizePlan(sub.plan);

    // Rule 2: founder assignment
    if (sub.provider === 'founder' && (plan === 'pro' || plan === 'max')) {
      return {
        userId,
        plan,
        source: 'founder',
        status: 'active',
        subscriptionProvider: 'founder',
        subscriptionExpiresAt,
        isFounder: true,
        isOwner: false,
        dailyCostCapUsd: getEffectiveDailyCostLimitUsd(plan),
        allowedSkills: allSkills(),
        evaluatedAt,
      };
    }

    // Rule 3: Apple subscription
    if (sub.provider === 'apple' && (plan === 'pro' || plan === 'max')) {
      return {
        userId,
        plan,
        source: 'apple',
        status: 'active',
        subscriptionProvider: 'apple',
        subscriptionExpiresAt,
        isFounder: false,
        isOwner: false,
        dailyCostCapUsd: getEffectiveDailyCostLimitUsd(plan),
        allowedSkills: allSkills(),
        evaluatedAt,
      };
    }

    // Rule 4: Stripe / web subscription
    if (sub.provider === 'stripe' && (plan === 'pro' || plan === 'max')) {
      return {
        userId,
        plan,
        source: 'stripe',
        status: 'active',
        subscriptionProvider: 'stripe',
        subscriptionExpiresAt,
        isFounder: false,
        isOwner: false,
        dailyCostCapUsd: getEffectiveDailyCostLimitUsd(plan),
        allowedSkills: allSkills(),
        evaluatedAt,
      };
    }

    // Rule 5: beta trial (trialing status, any provider that isn't
    // the owner/founder/apple/stripe canonical set — historically the
    // beta-invite flow set a trialing row for 365 days).
    if (sub.status === 'trialing' && (plan === 'pro' || plan === 'max')) {
      return {
        userId,
        plan,
        source: 'beta',
        status: 'active',
        subscriptionProvider: sub.provider ?? 'beta',
        subscriptionExpiresAt,
        isFounder: false,
        isOwner: false,
        dailyCostCapUsd: getEffectiveDailyCostLimitUsd(plan),
        allowedSkills: allSkills(),
        evaluatedAt,
      };
    }
  }

  // Rule 6 — no privileged state → Free
  const status: EntitlementStatus =
    sub?.status === 'past_due' ? 'past_due'
      : sub?.status === 'expired' || sub?.status === 'canceled' ? 'expired'
        : 'none';
  return freeEntitlement({ userId, source: 'free', status, evaluatedAt, isOwner: false, isFounder: false });
}

/**
 * Thin wrapper: "is this user allowed to use this skill?"
 * Centralizes the free-tier Secretary-only rule so callers don't
 * have to reimplement it.
 */
export function isSkillAllowedByEntitlement(
  entitlement: UserEntitlement,
  skillId: string,
): boolean {
  if (entitlement.plan === 'free') {
    return entitlement.allowedSkills.has(skillId);
  }
  // Paid plans get the whole catalog (per-skill granular caps live in
  // plan_configs / per-user overrides — separate concern).
  return entitlement.allowedSkills.has(skillId);
}

// ── Internal helpers ─────────────────────────────────────────────

function freeEntitlement(opts: {
  userId: number;
  source: EntitlementSource;
  evaluatedAt: string;
  isOwner: boolean;
  isFounder: boolean;
  status?: EntitlementStatus;
}): UserEntitlement {
  return {
    userId: opts.userId,
    plan: 'free',
    source: opts.source,
    status: opts.status ?? 'none',
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    isFounder: opts.isFounder,
    isOwner: opts.isOwner,
    dailyCostCapUsd: getEffectiveDailyCostLimitUsd('free'),
    allowedSkills: FREE_TIER_ALLOWED_SKILLS,
    evaluatedAt: opts.evaluatedAt,
  };
}

function normalizePlan(plan: string | null): BillingPlan {
  const lower = (plan ?? '').toLowerCase();
  if (lower === 'pro' || lower === 'max' || lower === 'owner' || lower === 'beta') {
    return lower as BillingPlan;
  }
  return 'free';
}

/**
 * The full skill set granted to paid users. Kept in-memory — the
 * skill-tiers.ts catalog owns per-skill tier requirements; this set
 * is just "anything not free-gated". Pro users hit the catalog for
 * per-skill enforcement.
 */
function allSkills(): ReadonlySet<string> {
  // Not a hard-coded list — we intentionally return "unrestricted"
  // for paid plans. `isSkillAllowedByEntitlement` short-circuits on
  // the `plan === 'free'` branch; paid plans fall through to the
  // existing catalog gate in skill-tiers.ts for granular checks.
  return _UNRESTRICTED;
}

/** Sentinel set that `.has()` always returns true on. Used to mean
 *  "this entitlement does not impose a skill-level restriction; ask
 *  the skill-tiers catalog for the granular answer". */
const _UNRESTRICTED: ReadonlySet<string> = {
  has: () => true,
  [Symbol.iterator]: function* () { /* empty — caller should not iterate */ },
  get size() { return Infinity; },
  entries: () => [].values() as any,
  forEach: () => { /* no-op */ },
  keys: () => [].values() as any,
  values: () => [].values() as any,
} as unknown as ReadonlySet<string>;
