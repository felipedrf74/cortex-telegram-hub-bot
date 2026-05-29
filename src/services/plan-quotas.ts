// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
import { config } from '../config';
import { getDb } from './database';
import { isOwnerUserRef } from './user-service';

/**
 * Central plan-quota registry + portal override layer.
 *
 * Hardening audit 2026-04-21:
 *   - Free tier daily cost cap was `0` (i.e. "no AI at all"). Business
 *     rule is `$0.005/day` so Free users get a taste of the secretary
 *     AI path before needing to upgrade.
 *   - Defaults now live alongside a runtime override (`setPlanConfig`)
 *     so the portal admin surface can mutate the cap without a
 *     redeploy. Persistence is the caller's concern (DB-backed portal
 *     route uses `plan_configs` table — see migration 075).
 *
 * This module is the SINGLE source of truth for "what cap applies to
 * plan X"; every enforcement path (cost-guardrail, entitlement
 * resolver, chat route) reads from it via `getEffectiveDailyCostLimitUsd`.
 */

export type BillingPlan = 'free' | 'pro' | 'max' | 'owner' | 'beta';
export type UsageLevel = 'none' | 'enhanced' | 'maximum' | 'owner';

/**
 * Free tier daily cost budget per business rule (2026-04-21):
 * users without an active subscription + no founder assignment get
 * a tiny daily AI budget so the Secretary skill is still usable, but
 * heavier skills remain locked behind the paid plans.
 */
export const FREE_DAILY_COST_CAP_USD = 0.005;

const DEFAULT_EFFECTIVE_DAILY_COST_LIMITS: Record<BillingPlan, number> = {
  free: FREE_DAILY_COST_CAP_USD,
  pro: 0.04,
  max: 0.06,
  owner: 100,
  beta: 100,
};

/**
 * Persisted overrides set by the portal admin UI at runtime. When a
 * portal admin edits a plan's cap, the new value is written here by
 * the portal route. The next `getEffectiveDailyCostLimitUsd` call
 * picks up the override automatically. Callers are required to call
 * `loadPlanConfigOverridesFromDb()` on startup so the in-memory
 * registry reflects persisted values across restarts.
 */
const portalOverrides: Partial<Record<BillingPlan, number>> = {};

/**
 * Parallel override for per-plan allowed-skills sets. Populated from
 * the `plan_configs.allowed_skills_json` column at boot (and again
 * whenever the portal admin edits a plan). `null` means "no override —
 * fall back to the compiled-in rule in entitlement.ts". Added
 * 2026-04-21 as the second pass of the tenant+entitlement hardening;
 * before this, the portal's allowed_skills_json was decorative.
 */
const portalAllowedSkills: Partial<Record<BillingPlan, ReadonlySet<string>>> = {};

const STORED_DAILY_COST_LIMITS: Record<'free' | 'pro' | 'max' | 'owner', number> = {
  free: FREE_DAILY_COST_CAP_USD,
  pro: 0.04,
  max: 0.06,
  owner: 0,
};

const PLAN_USAGE_LEVELS: Record<BillingPlan, UsageLevel> = {
  free: 'none',
  pro: 'enhanced',
  max: 'maximum',
  owner: 'owner',
  beta: 'owner',
};

const DEFAULT_INTERNAL_UNLIMITED_EMAILS = '';

function internalUnlimitedEmailAllowlist(): Set<string> {
  return new Set(
    (process.env.NEXUS_INTERNAL_UNLIMITED_EMAILS || DEFAULT_INTERNAL_UNLIMITED_EMAILS)
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isInternalUnlimitedEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return internalUnlimitedEmailAllowlist().has(normalized);
}

export function getEffectiveDailyCostLimitUsd(plan: BillingPlan): number {
  // Portal override wins when present — lets admin tune caps live.
  if (plan in portalOverrides && typeof portalOverrides[plan] === 'number') {
    return portalOverrides[plan] as number;
  }
  return DEFAULT_EFFECTIVE_DAILY_COST_LIMITS[plan];
}

export function getStoredDailyCostLimitUsdForTier(tier: 'free' | 'pro' | 'max' | 'owner'): number {
  return STORED_DAILY_COST_LIMITS[tier];
}

export function getUsageLevelForPlan(plan: BillingPlan): UsageLevel {
  return PLAN_USAGE_LEVELS[plan];
}

function isStagingRuntime(): boolean {
  return process.env.STAGING === 'true' || process.env.NODE_ENV === 'staging';
}

function stagingBypassTierAllowlist(): Set<string> {
  return new Set(
    (process.env.NEXUS_STAGING_BILLING_BYPASS_TIERS || 'owner,beta')
      .split(',')
      .map((tier) => tier.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Resolve the billing plan from canonical server-side state.
 *
 * Keep this helper as the only plan resolver used by quota enforcement and
 * Nexus Points settlement so both paths agree on the included daily budget.
 */
export function resolveBillingPlanForUser(userId: number): BillingPlan {
  const db = getDb();

  let isOwner = isOwnerUserRef(userId);
  let userTier: string | null = null;
  let userEmail: string | null = null;

  try {
    const user = db.prepare(
      'SELECT telegram_id, tier, email FROM users WHERE id = ?'
    ).get(userId) as { telegram_id: number | null; tier: string | null; email?: string | null } | undefined;
    userTier = user?.tier ?? null;
    userEmail = user?.email ?? null;
    if (user?.tier === 'owner') isOwner = true;
  } catch {
    try {
      const user = db.prepare(
        'SELECT telegram_id, tier FROM users WHERE id = ?'
      ).get(userId) as { telegram_id: number | null; tier: string | null } | undefined;
      userTier = user?.tier ?? null;
      userEmail = null;
      if (user?.tier === 'owner') isOwner = true;
    } catch {
      userTier = null;
      userEmail = null;
    }
  }

  if (isOwner) return 'owner';

  if (isInternalUnlimitedEmail(userEmail)) return 'beta';

  if (!config.billing.paywallEnabled && isStagingRuntime()) {
    const allowlist = stagingBypassTierAllowlist();
    if (userTier && allowlist.has(userTier.toLowerCase())) return 'beta';
  }

  try {
    const sub = readSubscriptionPlanRow(db, userId);

    const subscriptionActive = !!sub
      && ['active', 'trialing'].includes(sub.status)
      && (!sub.current_period_end || new Date(sub.current_period_end).getTime() > Date.now());

    if (subscriptionActive && sub.status === 'trialing' && (sub.provider ?? '').toLowerCase().includes('beta')) {
      return 'beta';
    }

    if (subscriptionActive && sub.plan === 'beta') {
      return 'beta';
    }

    if (subscriptionActive && (sub.plan === 'pro' || sub.plan === 'max')) {
      return sub.plan;
    }
  } catch {
    // Fall back to the users table below.
  }

  if (userTier === 'beta') return 'beta';
  if (userTier === 'max') return 'max';
  if (userTier === 'pro') return 'pro';

  return 'free';
}

function readSubscriptionPlanRow(
  db: ReturnType<typeof getDb>,
  userId: number,
): { plan: string; status: string; provider?: string | null; current_period_end?: string | null } | undefined {
  try {
    return db.prepare(
      'SELECT plan, status, provider, current_period_end FROM subscriptions WHERE user_id = ?'
    ).get(userId) as { plan: string; status: string; provider?: string | null; current_period_end?: string | null } | undefined;
  } catch {
    return db.prepare(
      'SELECT plan, status FROM subscriptions WHERE user_id = ?'
    ).get(userId) as { plan: string; status: string } | undefined;
  }
}

/**
 * Portal admin writes here when mutating a plan's daily cap. The
 * portal route should ALSO persist to the `plan_configs` table so
 * this registry rehydrates after a process restart.
 *
 * Pass `null` to clear the override and fall back to the compiled-in
 * default.
 */
export function setPlanDailyCostCapOverride(plan: BillingPlan, capUsd: number | null): void {
  if (capUsd === null) {
    delete portalOverrides[plan];
    return;
  }
  if (!Number.isFinite(capUsd) || capUsd < 0) return;
  portalOverrides[plan] = capUsd;
}

/**
 * Portal admin writes here when mutating the allowed-skill list for a
 * plan. Pass `null` to clear the override (compiled-in rule applies).
 * Unknown skill ids are accepted as-is — this registry doesn't know
 * the catalog; the entitlement resolver asks it "does this set have
 * that id?" and treats a missing id as denied.
 */
export function setPlanAllowedSkillsOverride(plan: BillingPlan, skillIds: Iterable<string> | null): void {
  if (skillIds === null) {
    delete portalAllowedSkills[plan];
    return;
  }
  const normalized = new Set<string>();
  for (const id of skillIds) {
    if (typeof id === 'string' && id.length > 0) {
      normalized.add(id.toLowerCase());
    }
  }
  portalAllowedSkills[plan] = normalized;
}

/**
 * Read the portal-managed allowed-skill set for a plan. Returns
 * `undefined` when no override exists (caller should fall back to the
 * compiled-in rule). Use this instead of `FREE_TIER_ALLOWED_SKILLS`
 * directly when you want the admin to have final say.
 */
export function getPlanAllowedSkillsOverride(plan: BillingPlan): ReadonlySet<string> | undefined {
  return portalAllowedSkills[plan];
}

/** Test-only: reset all portal overrides between cases. */
export function _resetPortalOverridesForTests(): void {
  for (const key of Object.keys(portalOverrides) as BillingPlan[]) {
    delete portalOverrides[key];
  }
  for (const key of Object.keys(portalAllowedSkills) as BillingPlan[]) {
    delete portalAllowedSkills[key];
  }
}

/** Returns the current effective registry (for admin/debug/telemetry). */
export function snapshotPlanCaps(): Record<BillingPlan, number> {
  const snap = { ...DEFAULT_EFFECTIVE_DAILY_COST_LIMITS };
  for (const key of Object.keys(portalOverrides) as BillingPlan[]) {
    const override = portalOverrides[key];
    if (typeof override === 'number') snap[key] = override;
  }
  return snap;
}

/**
 * Hydrate the in-memory portal-override registry from the DB's
 * `plan_configs` table (see migration 075). Called once at startup
 * and again whenever the portal UI writes a new config. Silently
 * no-ops if the table is missing — this lets legacy environments
 * (pre-migration) still boot.
 *
 * The DB is queried through a callback (avoid importing `database`
 * here to keep this module cycle-free). The caller passes a row
 * provider; the function mutates the override map.
 *
 * `allowed_skills_json` is optional and forward-compatible — older
 * environments that don't persist it won't populate the allowed-
 * skills override; those plans fall back to the compiled-in rule in
 * entitlement.ts. Added 2026-04-21 when the hardening audit wired
 * the column through to the runtime gate.
 */
export function applyPlanConfigRows(
  rows: ReadonlyArray<{
    plan_id: string;
    daily_cost_usd: number;
    allowed_skills_json?: string | null;
  }>,
): void {
  for (const row of rows) {
    const plan = row.plan_id as BillingPlan;
    if (!(plan in DEFAULT_EFFECTIVE_DAILY_COST_LIMITS)) continue; // unknown plan name — skip
    if (typeof row.daily_cost_usd === 'number' && Number.isFinite(row.daily_cost_usd)) {
      portalOverrides[plan] = row.daily_cost_usd;
    }
    // Best-effort parse of the allowed_skills_json column. A malformed
    // JSON payload leaves the compiled-in rule intact — we never want
    // a corrupt portal row to accidentally widen access.
    if (typeof row.allowed_skills_json === 'string' && row.allowed_skills_json.length > 0) {
      try {
        const parsed = JSON.parse(row.allowed_skills_json);
        if (Array.isArray(parsed)) {
          setPlanAllowedSkillsOverride(plan, parsed.filter((x) => typeof x === 'string'));
        }
      } catch {
        // Leave override unset → compiled-in rule applies. Logged at
        // the caller site in index.ts for observability.
      }
    }
  }
}
