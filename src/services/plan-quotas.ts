// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
/**
 * Central plan-quota registry + portal override layer.
 *
 * Paid-only cost controls 2026-07-09:
 *   - Free and beta/manual grants have zero model-backed allowance.
 *     Deterministic Secretary reads/actions are gated separately.
 *   - Daily and monthly defaults live alongside runtime overrides
 *     so the portal admin surface can mutate the cap without a
 *     redeploy. Persistence is the caller's concern (DB-backed portal
 *     route uses `plan_configs` table — see migrations 075 and 226).
 *
 * This module is the SINGLE source of truth for "what cap applies to
 * plan X"; every enforcement path (cost-guardrail, entitlement
 * resolver, chat route) reads from it via `getEffectiveDailyCostLimitUsd`.
 */

export type BillingPlan = 'free' | 'pro' | 'max' | 'owner' | 'beta';
export type UsageLevel = 'none' | 'enhanced' | 'maximum' | 'owner';

/** Free has no model-backed budget; token-zero Secretary remains available. */
export const FREE_DAILY_COST_CAP_USD = 0;
export const FREE_MONTHLY_COST_CAP_USD = 0;
export const BETA_DAILY_COST_CAP_USD = 0;
export const BETA_MONTHLY_COST_CAP_USD = 0;
export const SYSTEM_DAILY_COST_CAP_USD = 0.10;
export const SYSTEM_MONTHLY_COST_CAP_USD = 0.30;
export const AUTOMATION_BUDGET_FRACTION = 0.30;

const DEFAULT_EFFECTIVE_DAILY_COST_LIMITS: Record<BillingPlan, number> = {
  free: FREE_DAILY_COST_CAP_USD,
  pro: 0.04,
  max: 0.06,
  owner: 100,
  beta: BETA_DAILY_COST_CAP_USD,
};

const DEFAULT_EFFECTIVE_MONTHLY_COST_LIMITS: Record<BillingPlan, number> = {
  free: FREE_MONTHLY_COST_CAP_USD,
  pro: 1.20,
  max: 1.80,
  owner: 3000,
  beta: BETA_MONTHLY_COST_CAP_USD,
};

/**
 * Persisted overrides set by the portal admin UI at runtime. When a
 * portal admin edits a plan's cap, the new value is written here by
 * the portal route. The next `getEffectiveDailyCostLimitUsd` call
 * picks up the override automatically. Callers are required to call
 * `loadPlanConfigOverridesFromDb()` on startup so the in-memory
 * registry reflects persisted values across restarts.
 */
const portalDailyOverrides: Partial<Record<BillingPlan, number>> = {};
const portalMonthlyOverrides: Partial<Record<BillingPlan, number>> = {};

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
  beta: 'none',
};

function isZeroModelBudgetPlan(plan: BillingPlan): boolean {
  return plan === 'free' || plan === 'beta';
}

export function getEffectiveDailyCostLimitUsd(plan: BillingPlan): number {
  // Paid-only invariant: neither stale DB rows nor runtime portal setters may
  // manufacture included model budget for Free/beta accounts.
  if (isZeroModelBudgetPlan(plan)) return 0;
  // Portal override wins when present — lets admin tune caps live.
  if (plan in portalDailyOverrides && typeof portalDailyOverrides[plan] === 'number') {
    return portalDailyOverrides[plan] as number;
  }
  return DEFAULT_EFFECTIVE_DAILY_COST_LIMITS[plan];
}

export function getEffectiveMonthlyCostLimitUsd(plan: BillingPlan): number {
  if (isZeroModelBudgetPlan(plan)) return 0;
  if (plan in portalMonthlyOverrides && typeof portalMonthlyOverrides[plan] === 'number') {
    return portalMonthlyOverrides[plan] as number;
  }
  return DEFAULT_EFFECTIVE_MONTHLY_COST_LIMITS[plan];
}

export function getAutomationCostLimits(plan: BillingPlan): { dailyCostUsd: number; monthlyCostUsd: number } {
  return {
    dailyCostUsd: getEffectiveDailyCostLimitUsd(plan) * AUTOMATION_BUDGET_FRACTION,
    monthlyCostUsd: getEffectiveMonthlyCostLimitUsd(plan) * AUTOMATION_BUDGET_FRACTION,
  };
}

export function getStoredDailyCostLimitUsdForTier(tier: 'free' | 'pro' | 'max' | 'owner'): number {
  return STORED_DAILY_COST_LIMITS[tier];
}

export function getUsageLevelForPlan(plan: BillingPlan): UsageLevel {
  return PLAN_USAGE_LEVELS[plan];
}

/**
 * Resolve the billing plan from canonical server-side state.
 *
 * Keep this helper as the only plan resolver used by quota enforcement and
 * Nexus Points settlement so both paths agree on the included daily budget.
 */
export function resolveBillingPlanForUser(userId: number): BillingPlan {
  // Keep this compatibility export, but delegate to the canonical entitlement
  // resolver. Dynamic require avoids the plan-quotas <-> entitlement import
  // cycle at module initialization time.
  try {
    const { getEffectiveEntitlement } = require('./entitlement') as typeof import('./entitlement');
    return getEffectiveEntitlement(userId).plan;
  } catch {
    return 'free';
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
  if (isZeroModelBudgetPlan(plan)) {
    delete portalDailyOverrides[plan];
    return;
  }
  if (capUsd === null) {
    delete portalDailyOverrides[plan];
    return;
  }
  if (!Number.isFinite(capUsd) || capUsd < 0) return;
  portalDailyOverrides[plan] = capUsd;
}

export function setPlanMonthlyCostCapOverride(plan: BillingPlan, capUsd: number | null): void {
  if (isZeroModelBudgetPlan(plan)) {
    delete portalMonthlyOverrides[plan];
    return;
  }
  if (capUsd === null) {
    delete portalMonthlyOverrides[plan];
    return;
  }
  if (!Number.isFinite(capUsd) || capUsd < 0) return;
  portalMonthlyOverrides[plan] = capUsd;
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
  for (const key of Object.keys(portalDailyOverrides) as BillingPlan[]) {
    delete portalDailyOverrides[key];
  }
  for (const key of Object.keys(portalMonthlyOverrides) as BillingPlan[]) {
    delete portalMonthlyOverrides[key];
  }
  for (const key of Object.keys(portalAllowedSkills) as BillingPlan[]) {
    delete portalAllowedSkills[key];
  }
}

/** Returns the current effective registry (for admin/debug/telemetry). */
export function snapshotPlanCaps(): Record<BillingPlan, number> {
  const snap = { ...DEFAULT_EFFECTIVE_DAILY_COST_LIMITS };
  for (const key of Object.keys(portalDailyOverrides) as BillingPlan[]) {
    const override = portalDailyOverrides[key];
    if (typeof override === 'number') snap[key] = override;
  }
  return snap;
}

export function snapshotPlanMonthlyCaps(): Record<BillingPlan, number> {
  const snap = { ...DEFAULT_EFFECTIVE_MONTHLY_COST_LIMITS };
  for (const key of Object.keys(portalMonthlyOverrides) as BillingPlan[]) {
    const override = portalMonthlyOverrides[key];
    if (typeof override === 'number') snap[key] = override;
  }
  return snap;
}

/**
 * Hydrate the in-memory portal-override registry from the DB's
 * `plan_configs` table (created by migration 075 and extended by migration
 * 226). Called once at startup and again whenever the portal UI writes a new
 * config. Silently no-ops if the table is missing — this lets legacy environments
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
    monthly_cost_usd?: number | null;
    allowed_skills_json?: string | null;
  }>,
): void {
  for (const row of rows) {
    const plan = row.plan_id as BillingPlan;
    if (!(plan in DEFAULT_EFFECTIVE_DAILY_COST_LIMITS)) continue; // unknown plan name — skip
    if (isZeroModelBudgetPlan(plan)) {
      delete portalDailyOverrides[plan];
      delete portalMonthlyOverrides[plan];
    } else {
      if (typeof row.daily_cost_usd === 'number' && Number.isFinite(row.daily_cost_usd) && row.daily_cost_usd >= 0) {
        portalDailyOverrides[plan] = row.daily_cost_usd;
      } else {
        delete portalDailyOverrides[plan];
      }
      if (typeof row.monthly_cost_usd === 'number' && Number.isFinite(row.monthly_cost_usd) && row.monthly_cost_usd >= 0) {
        portalMonthlyOverrides[plan] = row.monthly_cost_usd;
      } else if (row.monthly_cost_usd !== undefined) {
        delete portalMonthlyOverrides[plan];
      }
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
