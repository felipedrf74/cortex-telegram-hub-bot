// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

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
  pro: 0.2,
  max: 0.6,
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

const STORED_DAILY_COST_LIMITS: Record<'free' | 'pro' | 'max' | 'owner', number> = {
  free: FREE_DAILY_COST_CAP_USD,
  pro: 0.2,
  max: 0.6,
  owner: 0,
};

const PLAN_USAGE_LEVELS: Record<BillingPlan, UsageLevel> = {
  free: 'none',
  pro: 'enhanced',
  max: 'maximum',
  owner: 'owner',
  beta: 'owner',
};

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

/** Test-only: reset all portal overrides between cases. */
export function _resetPortalOverridesForTests(): void {
  for (const key of Object.keys(portalOverrides) as BillingPlan[]) {
    delete portalOverrides[key];
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
 */
export function applyPlanConfigRows(rows: ReadonlyArray<{ plan_id: string; daily_cost_usd: number }>): void {
  for (const row of rows) {
    const plan = row.plan_id as BillingPlan;
    if (!(plan in DEFAULT_EFFECTIVE_DAILY_COST_LIMITS)) continue; // unknown plan name — skip
    if (typeof row.daily_cost_usd === 'number' && Number.isFinite(row.daily_cost_usd)) {
      portalOverrides[plan] = row.daily_cost_usd;
    }
  }
}
