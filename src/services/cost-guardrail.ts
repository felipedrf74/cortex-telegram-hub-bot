// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cost Guardrail — global monitoring plus canonical daily/monthly AI budgets.
 *
 * Checks total API spend for the day against configurable limits and
 * enforces entitlement, per-user daily/monthly cost windows, and background
 * ceilings. api_usage is enforcement truth; usage_metering is analytics only.
 *
 * Telegram alerting fires at 50% / 80% / 100% of the global daily limit
 * (each tier fires once per UTC day).
 *
 * Paid-only blocking is rollout-gated by
 * PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED=true.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { DateTime } from 'luxon';
import {
  AUTOMATION_BUDGET_FRACTION,
  SYSTEM_DAILY_COST_CAP_USD,
  SYSTEM_MONTHLY_COST_CAP_USD,
  getEffectiveDailyCostLimitUsd,
  getEffectiveMonthlyCostLimitUsd,
  getUsageLevelForPlan,
  type BillingPlan,
  type UsageLevel,
} from './plan-quotas';
import { recordOperatorAlert } from './operator-alerts';
import { getNexusPointBalance, listNexusPointPackages, usdToPoints } from './nexus-points';
import { getActiveUserAiBudgetOverride } from './ai-budget-overrides';
import {
  getEffectiveEntitlement,
  isPaidAiCostControlsEnforcementEnabled,
  type AiEntitlementBlockReason,
  type UserEntitlement,
} from './entitlement';
import { isOwnerUserRef } from './user-service';
import { isGarminConfigured } from './garmin';
import {
  enterApiUsageAttribution,
  resolveApiUsageAttribution,
  runWithApiUsageAttribution,
  type AiRequestSource,
} from './api-usage-attribution';
import {
  getApiUsagePersistenceFailure,
  tryRecoverApiUsagePersistenceFailure,
} from './api-usage-fallback';
import { getCurrentRequestId } from '../utils/request-context';
import {
  isContentLiveEvalProviderCategory,
  isContentLiveEvalRegisteredModel,
} from './content-live-evaluation-artifact';

export type { AiRequestSource } from './api-usage-attribution';

// ── Telegram Alert Callback ──────────────────────────────────────

type AlertCallback = (message: string) => Promise<void>;
let _alertFn: AlertCallback | null = null;

/** Register a Telegram alert sender. Called once during startup from index.ts. */
export function setCostAlertCallback(fn: AlertCallback): void {
  _alertFn = fn;
}

// Tier alert ratchet: each tier fires once per UTC day, then ratchets up
type AlertTier = 'none' | 'half' | 'warning' | 'critical';
let _lastAlertTier: AlertTier = 'none';
let _lastAlertDate: string = '';

function tierRank(t: AlertTier): number {
  return t === 'none' ? 0 : t === 'half' ? 1 : t === 'warning' ? 2 : 3;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Canonical daily/monthly AI budget status ─────────────────────
const DEFAULT_DAILY_CAP_USD = Number(process.env.PER_USER_DAILY_USD_CAP || '0.00');
const RESERVATION_MULTIPLIER = 1.25;
const LEGACY_FREE_DAILY_COST_CAP_USD = 0.005;
const LEGACY_BETA_DAILY_COST_CAP_USD = 1.0;
const COACH_EXPECTED_HARD_MAX_USD = 0.00936;
const DEFAULT_ESTIMATED_COST_USD: Record<AiRequestSource, number> = {
  interactive: 0.003,
  automation: 0.006,
  system: 0.01,
};
const WORKLOAD_DEFAULT_ESTIMATED_COST_USD: ReadonlyArray<[RegExp, number]> = [
  [/coach/i, 0.005],
  // A five-topic Gemini Flash batch is bounded to fit beside one Coach call
  // inside Pro's $0.012/day automation envelope.
  [/content(?:_workflow)?/i, 0.002],
  [/(?:channel_analysis|knowledge_synthesis|channel_learning)/i, 0.009],
  [/autoresearch/i, 0.012],
];

export type AiAutomationPriority = 'coach' | 'content' | 'channel_learning' | 'other';

export type AiBudgetWindow = 'plan' | 'daily' | 'monthly' | 'automation_daily' | 'automation_monthly' | 'global';

export interface AiBudgetRequest {
  userId: number;
  requestSource: AiRequestSource;
  baseCategory: string;
  jobName?: string | null;
  runId?: string | null;
  /** Pre-multiplier expected provider cost. Rolling p95 is used when absent. */
  estimatedCostUsd?: number;
  /**
   * Use the explicit estimate verbatim (including zero) for a signed
   * chat-live-evaluation hard ceiling. This avoids replacing an Ollama
   * zero-cost attempt with the normal conservative cloud-call default.
   */
  exactHardCostEstimate?: boolean;
  /**
   * Optional signed, run-scoped hard ceiling used by explicitly authorized
   * local evaluation workloads. Unlike quota forecasts, this is rechecked
   * against durable api_usage before every concrete provider attempt.
   */
  hardRunCostLimitUsd?: number;
  /**
   * Optional signed per-job ceiling. Live evaluation uses one immutable job
   * per corpus sample so retries/fallbacks cannot consume a later sample's
   * reserved slice.
   */
  hardJobCostLimitUsd?: number;
  automationPriority?: AiAutomationPriority;
}

/**
 * Cross-process proof carried inside the signed internal-attribution token.
 * The opaque reservationId is also the owner token of the live SQLite lock,
 * so the internal AI proxy can prove that it is re-entering the exact outer
 * reservation instead of trusting user-supplied scope metadata.
 */
export interface SignedOuterAiBudgetReservation {
  reservationId: string;
  requestSource: AiRequestSource;
  baseCategory: string;
  jobName: string | null;
  runId: string | null;
  hardRunCostLimitUsd?: number;
  hardJobCostLimitUsd?: number;
}

interface ActiveAiBudgetReservationContext extends SignedOuterAiBudgetReservation {
  userId: number;
  active: boolean;
  approved: boolean;
}

const activeAiBudgetReservation = new AsyncLocalStorage<ActiveAiBudgetReservationContext | null>();
const activeAiBudgetReservationByRequestId = new Map<string, ActiveAiBudgetReservationContext>();

export interface DailyQuotaStatus {
  over: boolean;
  spentUsd: number;
  capUsd: number;
  plan: BillingPlan | string;
  usageLevel: UsageLevel;
  usageFraction: number;
  dailyUsageFraction: number;
  monthlyUsageFraction: number;
  dailyOver: boolean;
  monthlyOver: boolean;
  callsToday: number;
  boostAvailable: boolean;
  limitUsd: number;
  usedUsd: number;
  remainingUsd: number;
  planDailyLimitUsd: number;
  includedRemainingUsd: number;
  nexusPointsBalance: number;
  nexusPointsRemainingUsd: number;
  nexusPointsExpiringSoon: number;
  nexusPointsExpiringSoonUsd: number;
  nextCreditExpiryAt: string | null;
  totalRemainingUsd: number;
  pointsPurchaseAvailable: boolean;
  resetAt: string;
  dailyResetAt: string;
  monthlyResetAt: string;
  unblocksAt: string | null;
  monthlySpentUsd: number;
  monthlyCapUsd: number;
  monthlyRemainingUsd: number;
  automationSpentTodayUsd: number;
  automationSpentMonthlyUsd: number;
  automationDailyCapUsd: number;
  automationMonthlyCapUsd: number;
  automationDailyOver: boolean;
  automationMonthlyOver: boolean;
  automationDailyRemainingUsd: number;
  automationMonthlyRemainingUsd: number;
  requestSource: AiRequestSource;
  aiAccessAllowed: boolean;
  automationAllowed: boolean;
  blockReason: AiEntitlementBlockReason | null;
  entitlement: UserEntitlement | null;
}

function getQuotaResetAt(now = new Date()): string {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  )).toISOString();
}

function getUtcDayWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: start.toISOString(), end: getQuotaResetAt(now) };
}

function getUtcMonthWindow(now = new Date()): { start: string; end: string } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

function safeFraction(spent: number, cap: number): number {
  if (cap <= 0) return spent > 0 ? 1 : 0;
  return Math.max(0, Math.min(spent / cap, 1));
}

function legacyDailyCapUsd(plan: BillingPlan | 'system', configuredCapUsd: number): number {
  if (plan === 'system') {
    const configured = Number.parseFloat(process.env.SYSTEM_ACTOR_DAILY_USD_CAP ?? '1.0');
    return Number.isFinite(configured) && configured > 0 ? configured : Number.POSITIVE_INFINITY;
  }
  if (plan === 'free') return LEGACY_FREE_DAILY_COST_CAP_USD;
  if (plan === 'beta') {
    return Math.min(
      LEGACY_BETA_DAILY_COST_CAP_USD,
      Math.max(0, config.aiSafety.globalDailyLimitUsd - 0.01),
    );
  }
  return configuredCapUsd;
}

/**
 * Last-known billing identity for a quota read that failed closed.
 *
 * Failing closed must keep AI spend blocked, but it must not tell a paying
 * subscriber they are on no plan. `GET /api/v1/usage` spreads
 * `buildQuotaUsagePayload` verbatim and the iOS client assigns `plan`
 * unconditionally, so a transient entitlement/metering error that reported
 * 'none' downgraded a paying account on the very next poll — undoing the same
 * fix already applied to `GET /api/v1/billing/status`. Centralising it here
 * covers every caller of the payload builder instead of one route at a time.
 *
 * Only a currently-active paid row overrides 'none': Free, expired, cancelled
 * and system-pool reads keep the fail-closed answer. The row is read directly
 * rather than through stripe-service so that the degraded path stays free of
 * that module's dependency graph, and the whole lookup is wrapped — if the
 * database is what broke, the fallback must not throw on top of it.
 */
function lastKnownPaidPlanForFailedQuotaRead(
  userId: number,
  requestSource: AiRequestSource,
  now: Date,
): string | null {
  if (requestSource === 'system') return null;
  if (!Number.isInteger(userId) || userId <= 0) return null;
  try {
    const row = getDb().prepare(
      'SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?',
    ).get(userId) as { plan?: string | null; status?: string | null; current_period_end?: string | null } | undefined;
    if (!row) return null;
    if (row.plan !== 'pro' && row.plan !== 'max') return null;
    if (!['active', 'trialing'].includes(String(row.status))) return null;
    // Same expiry rule as getSubscriptionStatus: a lapsed period is not an
    // active plan. Legacy rows can hold SQLite's space-separated timestamp
    // instead of ISO-8601, so both forms are parsed.
    const periodEnd = typeof row.current_period_end === 'string' ? row.current_period_end.trim() : '';
    if (periodEnd) {
      const parsed = Date.parse(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(periodEnd)
          ? `${periodEnd.replace(' ', 'T')}Z`
          : periodEnd,
      );
      if (Number.isFinite(parsed) && parsed <= now.getTime()) return null;
    }
    return row.plan;
  } catch {
    return null;
  }
}

export function getDailyQuotaStatus(
  userId: number,
  options: { requestSource?: AiRequestSource; now?: Date } = {},
): DailyQuotaStatus {
  const requestSource = options.requestSource ?? (userId > 0 ? 'interactive' : 'system');
  const now = options.now ?? new Date();
  try {
    const db = getDb();
    // requestSource is the authority for the shared system pool. System jobs
    // may retain a positive target userId for attribution, but must never
    // inherit that user's/owner's entitlement or budget.
    const isSystem = requestSource === 'system';
    const entitlement = isSystem ? null : getEffectiveEntitlement(userId);
    const plan = isSystem ? 'system' : entitlement!.plan;
    // Per-user overrides tune included budgets only for an entitlement that is
    // currently allowed to spend. Dormant overrides on Free, beta/manual,
    // expired, or past-due accounts must not surface phantom allowance in the
    // public quota contract (and become effective only after paid eligibility).
    const legacyUserOverride = isSystem ? null : getActiveUserAiBudgetOverride(userId, now);
    const userOverride = isSystem || !entitlement!.aiAccessAllowed ? null : legacyUserOverride;
    const capUsd = isSystem
      ? SYSTEM_DAILY_COST_CAP_USD
      : userOverride?.dailyCostUsd ?? entitlement!.dailyCostCapUsd;
    const monthlyCapUsd = isSystem
      ? SYSTEM_MONTHLY_COST_CAP_USD
      : userOverride?.monthlyCostUsd ?? entitlement!.monthlyCostCapUsd;
    const usageLevel = isSystem ? 'owner' : getUsageLevelForPlan(plan as BillingPlan);
    const emptyPoints = { pointsBalance: 0, usdBalance: 0, nextCreditExpiryAt: null, pointsExpiringSoon: 0, usdExpiringSoon: 0 };
    const legacyNexusPoints = !isSystem ? getNexusPointBalance(userId, now) : emptyPoints;
    const nexusPoints = !isSystem && requestSource === 'interactive' && entitlement!.nexusPointsAllowed
      ? legacyNexusPoints
      : emptyPoints;

    const day = getUtcDayWindow(now);
    const month = isSystem
      ? getUtcMonthWindow(now)
      : {
          start: entitlement!.billingPeriodStart ?? getUtcMonthWindow(now).start,
          end: entitlement!.billingPeriodEnd ?? getUtcMonthWindow(now).end,
        };

    // Positive target user IDs are retained on system rows for attribution,
    // but those rows belong exclusively to the shared system pool. Excluding
    // them here prevents the same spend from also reducing a user's paid
    // allowance or Points headroom. Legacy NULL sources remain user spend.
    const usageScopePredicate = isSystem
      ? "request_source = 'system'"
      : "user_id = ? AND COALESCE(request_source, 'interactive') <> 'system'";
    const usageScopeParams = isSystem ? [] : [userId];
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ts >= datetime(?) AND ts < datetime(?) THEN cost_usd ELSE 0 END), 0) AS daily_total,
        COALESCE(SUM(CASE WHEN ts >= datetime(?) AND ts < datetime(?) THEN cost_usd ELSE 0 END), 0) AS monthly_total,
        COALESCE(SUM(CASE WHEN request_source = 'automation' AND ts >= datetime(?) AND ts < datetime(?) THEN cost_usd ELSE 0 END), 0) AS automation_daily,
        COALESCE(SUM(CASE WHEN request_source = 'automation' AND ts >= datetime(?) AND ts < datetime(?) THEN cost_usd ELSE 0 END), 0) AS automation_monthly,
        SUM(CASE WHEN ts >= datetime(?) AND ts < datetime(?) THEN 1 ELSE 0 END) AS calls
      FROM api_usage
      WHERE ${usageScopePredicate}
        AND ts >= datetime(?)
        AND ts < datetime(?)
    `).get(
      day.start, day.end,
      month.start, month.end,
      day.start, day.end,
      month.start, month.end,
      day.start, day.end,
      ...usageScopeParams,
      month.start < day.start ? month.start : day.start,
      month.end > day.end ? month.end : day.end,
    ) as {
      daily_total: number;
      monthly_total: number;
      automation_daily: number;
      automation_monthly: number;
      calls: number;
    };
    const dailySpent = Number(row.daily_total || 0);
    const monthlySpent = Number(row.monthly_total || 0);
    const automationDailySpent = Number(row.automation_daily || 0);
    const automationMonthlySpent = Number(row.automation_monthly || 0);
    let debitedTodayUsd = 0;
    let debitedMonthlyUsd = 0;
    if (!isSystem) {
      try {
        const debitRow = db.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN COALESCE(u.ts, d.created_at) >= datetime(?) AND COALESCE(u.ts, d.created_at) < datetime(?) THEN d.usd_cost_debited ELSE 0 END), 0) AS daily_debited,
            COALESCE(SUM(CASE WHEN COALESCE(u.ts, d.created_at) >= datetime(?) AND COALESCE(u.ts, d.created_at) < datetime(?) THEN d.usd_cost_debited ELSE 0 END), 0) AS monthly_debited
          FROM nexus_point_debits d
          LEFT JOIN api_usage u ON u.id = d.api_usage_id
          WHERE d.user_id = ?
        `).get(day.start, day.end, month.start, month.end, userId) as { daily_debited: number; monthly_debited: number };
        debitedTodayUsd = debitRow.daily_debited || 0;
        debitedMonthlyUsd = debitRow.monthly_debited || 0;
      } catch {
        debitedTodayUsd = 0;
        debitedMonthlyUsd = 0;
      }
    }

    const dailyIncludedRemaining = Math.max(capUsd - dailySpent, 0);
    const monthlyIncludedRemaining = Math.max(monthlyCapUsd - monthlySpent, 0);
    const includedRemainingUsd = Math.min(dailyIncludedRemaining, monthlyIncludedRemaining);
    const unsettledOverageUsd = Math.max(
      dailySpent - capUsd - debitedTodayUsd,
      monthlySpent - monthlyCapUsd - debitedMonthlyUsd,
      0,
    );
    const nexusPointsRemainingUsd = Math.max(nexusPoints.usdBalance - unsettledOverageUsd, 0);
    const nexusPointsRemaining = Math.max(nexusPoints.pointsBalance - usdToPoints(unsettledOverageUsd), 0);
    const totalRemainingUsd = includedRemainingUsd + nexusPointsRemainingUsd;
    const dailyFraction = safeFraction(dailySpent, capUsd);
    const monthlyFraction = safeFraction(monthlySpent, monthlyCapUsd);
    const fraction = Math.max(dailyFraction, monthlyFraction);
    const dailyOver = capUsd > 0 && dailySpent >= capUsd;
    const monthlyOver = monthlyCapUsd > 0 && monthlySpent >= monthlyCapUsd;
    const automationDailyCapUsd = capUsd * AUTOMATION_BUDGET_FRACTION;
    const automationMonthlyCapUsd = monthlyCapUsd * AUTOMATION_BUDGET_FRACTION;
    const automationDailyOver = automationDailyCapUsd > 0 && automationDailySpent >= automationDailyCapUsd;
    const automationMonthlyOver = automationMonthlyCapUsd > 0 && automationMonthlySpent >= automationMonthlyCapUsd;
    const accessAllowed = isSystem || Boolean(entitlement?.aiAccessAllowed);
    const automationAllowed = isSystem || Boolean(entitlement?.automationAllowed);
    const policyOver = !accessAllowed
      || (requestSource === 'automation' && (!automationAllowed || automationDailyOver || automationMonthlyOver))
      || ((dailyOver || monthlyOver) && totalRemainingUsd <= 0);
    // During attribution/observe-only rollout the new paid policy must not
    // silently flip legacy public `isOverLimit`/`allowed` contracts. Preserve
    // all daily/monthly/automation telemetry below, but expose an effective
    // blocking verdict only after enforcement is explicitly enabled. The
    // pre-existing global safety cap remains enforced separately.
    const legacyCap = legacyUserOverride?.dailyCostUsd ?? legacyDailyCapUsd(plan as BillingPlan | 'system', capUsd);
    const legacyIncludedRemainingUsd = Math.max(legacyCap - dailySpent, 0);
    const legacyUnsettledOverageUsd = Math.max(dailySpent - legacyCap - debitedTodayUsd, 0);
    const legacyPointsRemainingUsd = Math.max(legacyNexusPoints.usdBalance - legacyUnsettledOverageUsd, 0);
    const legacyOver = dailySpent >= legacyCap
      && legacyIncludedRemainingUsd + legacyPointsRemainingUsd <= 0;
    const enforcementEnabled = isPaidAiCostControlsEnforcementEnabled();
    const over = enforcementEnabled ? policyOver : legacyOver;
    const remainingUsd = Math.max(totalRemainingUsd, 0);
    const pointsPurchaseAvailable = requestSource === 'interactive' && Boolean(entitlement?.nexusPointsAllowed);
    const automationBlocked = requestSource === 'automation'
      && (automationDailyOver || automationMonthlyOver);
    const exhaustedByCost = (dailyOver || monthlyOver) && totalRemainingUsd <= 0;
    const policyUnblocksAt = !accessAllowed || (requestSource === 'automation' && !automationAllowed)
      ? null
      : automationBlocked
        ? (automationMonthlyOver ? month.end : day.end)
        : exhaustedByCost
          ? (monthlyOver ? month.end : day.end)
          : null;
    // `unblocksAt` describes an effective denial, not a hypothetical policy
    // decision. Observe-only clients still receive both reset timestamps.
    const unblocksAt = enforcementEnabled ? policyUnblocksAt : legacyOver ? day.end : null;
    // The legacy fraction is max(daily, monthly), so the legacy reset must
    // describe that same window. Resolve ties to monthly because a daily
    // reset cannot clear a simultaneously exhausted monthly window.
    const tiedAndBothExhausted = monthlyOver && dailyOver && monthlyFraction === dailyFraction;
    const legacyResetAt = monthlyFraction > dailyFraction || tiedAndBothExhausted
      ? month.end
      : day.end;

    return {
      over,
      spentUsd: dailySpent,
      capUsd,
      plan,
      usageLevel,
      usageFraction: Math.round(fraction * 100) / 100,
      dailyUsageFraction: Math.round(dailyFraction * 100) / 100,
      monthlyUsageFraction: Math.round(monthlyFraction * 100) / 100,
      dailyOver,
      monthlyOver,
      callsToday: Number(row.calls || 0),
      limitUsd: capUsd,
      usedUsd: dailySpent,
      remainingUsd,
      planDailyLimitUsd: capUsd,
      includedRemainingUsd,
      nexusPointsBalance: Math.round(nexusPointsRemaining * 1000) / 1000,
      nexusPointsRemainingUsd,
      nexusPointsExpiringSoon: nexusPoints.pointsExpiringSoon,
      nexusPointsExpiringSoonUsd: nexusPoints.usdExpiringSoon,
      nextCreditExpiryAt: nexusPoints.nextCreditExpiryAt,
      totalRemainingUsd,
      resetAt: legacyResetAt,
      dailyResetAt: day.end,
      monthlyResetAt: month.end,
      unblocksAt,
      monthlySpentUsd: monthlySpent,
      monthlyCapUsd,
      monthlyRemainingUsd: Math.max(monthlyCapUsd - monthlySpent, 0),
      automationSpentTodayUsd: automationDailySpent,
      automationSpentMonthlyUsd: automationMonthlySpent,
      automationDailyCapUsd,
      automationMonthlyCapUsd,
      automationDailyOver,
      automationMonthlyOver,
      automationDailyRemainingUsd: Math.max(automationDailyCapUsd - automationDailySpent, 0),
      automationMonthlyRemainingUsd: Math.max(automationMonthlyCapUsd - automationMonthlySpent, 0),
      requestSource,
      aiAccessAllowed: accessAllowed,
      automationAllowed,
      blockReason: entitlement?.blockReason ?? null,
      entitlement,
      boostAvailable: pointsPurchaseAvailable,
      pointsPurchaseAvailable,
    };
  } catch {
    return {
      over: isPaidAiCostControlsEnforcementEnabled(), spentUsd: 0, capUsd: DEFAULT_DAILY_CAP_USD,
      // Billing identity survives a failed quota read; AI access does not.
      // `aiAccessAllowed`, `blockReason` and the caps below stay fail-closed.
      plan: lastKnownPaidPlanForFailedQuotaRead(userId, requestSource, now) ?? 'none',
      usageLevel: 'none', usageFraction: 0,
      callsToday: 0, boostAvailable: false,
      limitUsd: DEFAULT_DAILY_CAP_USD,
      usedUsd: 0,
      remainingUsd: DEFAULT_DAILY_CAP_USD,
      planDailyLimitUsd: DEFAULT_DAILY_CAP_USD,
      includedRemainingUsd: DEFAULT_DAILY_CAP_USD,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      nexusPointsExpiringSoon: 0,
      nexusPointsExpiringSoonUsd: 0,
      nextCreditExpiryAt: null,
      totalRemainingUsd: DEFAULT_DAILY_CAP_USD,
      pointsPurchaseAvailable: false,
      resetAt: getQuotaResetAt(now),
      dailyResetAt: getQuotaResetAt(now),
      monthlyResetAt: getUtcMonthWindow(now).end,
      unblocksAt: null,
      monthlySpentUsd: 0,
      monthlyCapUsd: 0,
      monthlyRemainingUsd: 0,
      automationSpentTodayUsd: 0,
      automationSpentMonthlyUsd: 0,
      automationDailyCapUsd: 0,
      automationMonthlyCapUsd: 0,
      automationDailyOver: true,
      automationMonthlyOver: true,
      automationDailyRemainingUsd: 0,
      automationMonthlyRemainingUsd: 0,
      requestSource,
      aiAccessAllowed: false,
      automationAllowed: false,
      blockReason: 'entitlement_error',
      entitlement: null,
      dailyUsageFraction: 0,
      monthlyUsageFraction: 0,
      dailyOver: true,
      monthlyOver: true,
    };
  }
}

export function buildQuotaExceededMessage(quota: Pick<DailyQuotaStatus, 'plan' | 'limitUsd' | 'dailyResetAt' | 'monthlyResetAt' | 'monthlyOver' | 'pointsPurchaseAvailable' | 'aiAccessAllowed' | 'blockReason'>): string {
  if (quota.blockReason === 'subscription_inactive') {
    return 'AI access is paused because the paid subscription is not current. Renew the plan to continue; token-zero reads remain available.';
  }
  if (quota.blockReason === 'invalid_billing_period' || quota.blockReason === 'entitlement_error') {
    return 'AI access is temporarily unavailable while billing status is verified. Token-zero reads remain available; try again shortly.';
  }
  if (quota.blockReason === 'beta_ai_disabled') {
    return 'Model-backed AI is not included with this account grant. Token-zero reads and actions remain available.';
  }
  if (!quota.aiAccessAllowed || quota.plan === 'free' || quota.limitUsd <= 0) {
    return 'AI access is not available on the free plan. Upgrade to Pro or Max to continue.';
  }

  const resetAt = quota.monthlyOver ? quota.monthlyResetAt : quota.dailyResetAt;
  const period = quota.monthlyOver ? 'Monthly' : 'Daily';
  const points = quota.pointsPurchaseAvailable ? ' Buy Nexus Points for more interactive AI usage, or wait for the reset.' : '';
  return `${period} AI quota reached for the ${quota.plan} plan. Resets at ${resetAt}.${points}`;
}

export function buildQuotaUsagePayload(quota: DailyQuotaStatus): Record<string, unknown> {
  const usageFraction = Math.max(0, Math.min(1, quota.usageFraction));
  return {
    plan: quota.plan,
    resetAt: quota.resetAt,
    resetsAt: quota.resetAt,
    dailyResetAt: quota.dailyResetAt,
    monthlyResetAt: quota.monthlyResetAt,
    unblocksAt: quota.unblocksAt,
    usageLevel: quota.usageLevel,
    usageFraction,
    usagePercent: Math.round(usageFraction * 100),
    isOverLimit: quota.over,
    aiAccessAllowed: quota.aiAccessAllowed,
    blockReason: quota.blockReason,
    enforcementEnabled: isPaidAiCostControlsEnforcementEnabled(),
    dailyUsageFraction: quota.dailyUsageFraction,
    dailyUsagePercent: Math.round(quota.dailyUsageFraction * 100),
    dailyIsOverLimit: quota.dailyOver,
    dailyResetsAt: quota.dailyResetAt,
    monthlyUsageFraction: quota.monthlyUsageFraction,
    monthlyUsagePercent: Math.round(quota.monthlyUsageFraction * 100),
    monthlyIsOverLimit: quota.monthlyOver,
    monthlyResetsAt: quota.monthlyResetAt,
    daily: {
      usageFraction: quota.dailyUsageFraction,
      usagePercent: Math.round(quota.dailyUsageFraction * 100),
      isOverLimit: quota.dailyOver,
      resetAt: quota.dailyResetAt,
    },
    monthly: {
      usageFraction: quota.monthlyUsageFraction,
      usagePercent: Math.round(quota.monthlyUsageFraction * 100),
      isOverLimit: quota.monthlyOver,
      resetAt: quota.monthlyResetAt,
    },
    automation: {
      enabled: quota.automationAllowed,
      dailyUsageFraction: safeFraction(quota.automationSpentTodayUsd, quota.automationDailyCapUsd),
      monthlyUsageFraction: safeFraction(quota.automationSpentMonthlyUsd, quota.automationMonthlyCapUsd),
      dailyOverLimit: quota.automationDailyOver,
      monthlyOverLimit: quota.automationMonthlyOver,
    },
    boostAvailable: quota.boostAvailable,
    nexusPointsBalance: quota.nexusPointsBalance,
    nexusPointsExpiringSoon: quota.nexusPointsExpiringSoon,
    nextCreditExpiryAt: quota.nextCreditExpiryAt,
    pointsPurchaseAvailable: quota.pointsPurchaseAvailable,
    nexusPointPackages: listNexusPointPackages().map((pkg) => ({
      productId: pkg.productId,
      label: pkg.label,
      points: pkg.points,
    })),
  };
}

export function buildQuotaExceededPayload(quota: DailyQuotaStatus): Record<string, unknown> {
  return buildQuotaUsagePayload(quota);
}

/**
 * Check global daily spend against configured limits.
 * Sends Telegram alerts at 50% / 80% / 100% (each fires once per UTC day).
 * Returns the current daily spend.
 */
export function checkGlobalCostGuardrail(): { totalUsd: number; limitUsd: number; exceeded: boolean } {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM api_usage WHERE ts >= date('now')
    `).get() as { total: number };

    const limit = config.aiSafety.globalDailyLimitUsd;
    const half = limit * 0.5;
    const warning = limit * config.aiSafety.alertThresholdPercent; // default 0.80

    // Reset ratchet on new UTC day
    const today = todayKey();
    if (today !== _lastAlertDate) {
      _lastAlertTier = 'none';
      _lastAlertDate = today;
    }

    // Determine current tier based on spend
    let currentTier: AlertTier = 'none';
    if (row.total >= limit) currentTier = 'critical';
    else if (row.total >= warning) currentTier = 'warning';
    else if (row.total >= half) currentTier = 'half';

    // Fire alert if we crossed UP a tier today (won't re-fire same tier)
    if (tierRank(currentTier) > tierRank(_lastAlertTier)) {
      const pct = Math.round((row.total / limit) * 100);
      const icon = currentTier === 'critical' ? '🔴' : currentTier === 'warning' ? '🟠' : '🟡';
      const verb = currentTier === 'critical' ? 'REACHED' : 'crossed';
      logger.warn(
        { total: row.total, limit, tier: currentTier },
        `Cost guardrail tier ${currentTier} ${verb}`,
      );
      recordOperatorAlert({
        severity: currentTier === 'critical' ? 'critical' : 'warning',
        source: 'cost_guardrail',
        dedupeKey: `cost:${today}:${currentTier}`,
        title: `AI cost ${verb.toLowerCase()} ${pct}%`,
        detail: `Daily AI spend is $${row.total.toFixed(4)} of $${limit.toFixed(2)}.`,
        owner: 'ops',
        suspectedArea: 'ai_cost',
        userImpact: currentTier === 'critical'
          ? 'The global AI cost guardrail has been reached; AI-backed flows may be blocked or degraded.'
          : 'AI spend is elevated and should be checked before it affects beta usage.',
        runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#cost-guardrail-alerts',
        metadata: {
          totalUsd: row.total,
          limitUsd: limit,
          percentOfLimit: pct,
          tier: currentTier,
        },
      });
      if (_alertFn) {
        const msg =
          `${icon} <b>AI cost ${verb}</b>\n\n` +
          `Today: <code>$${row.total.toFixed(4)}</code> / $${limit.toFixed(2)} (${pct}%)\n` +
          `Tier: <b>${currentTier}</b>`;
        // Fire-and-forget — never cascade alert failures
        _alertFn(msg).catch(() => { /* swallow */ });
      }
      _lastAlertTier = currentTier;
    }

    return { totalUsd: row.total, limitUsd: limit, exceeded: row.total >= limit };
  } catch {
    return { totalUsd: 0, limitUsd: config.aiSafety.globalDailyLimitUsd, exceeded: false };
  }
}

export function isUserOverDailyCap(userId: number): DailyQuotaStatus {
  return getDailyQuotaStatus(userId);
}

export interface AiBudgetDecision {
  allowed: boolean;
  status: 200 | 403 | 429;
  code: 'OK' | 'AI_PLAN_REQUIRED' | 'AI_DAILY_LIMIT_REACHED' | 'AI_MONTHLY_LIMIT_REACHED' | 'SERVICE_DEGRADED';
  window: AiBudgetWindow | null;
  message: string;
  quota: DailyQuotaStatus;
  reservedCostUsd: number;
  retryAfterSeconds: number | null;
  unblocksAt: string | null;
  /** Internal disposition used by schedulers; never exposed as billing data. */
  internalReason?: 'lock_unavailable' | 'entitlement_error' | 'metering_unavailable';
}

function secondsUntil(iso: string): number {
  const milliseconds = Date.parse(iso) - Date.now();
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function getRollingP95CostUsd(request: AiBudgetRequest): number | null {
  try {
    // Reservation history describes the workload, not an individual tenant.
    // User isolation remains enforced by the quota windows below; sharing the
    // source/category p95 prevents a new or low-volume user from under-reserving
    // a workload that already has representative production history.
    // The active run is partial by definition and must not become its own
    // historical p95 sample. Its already-recorded spend is accounted for
    // separately below when computing the remaining run envelope.
    const currentRunPredicate = request.runId
      ? "AND COALESCE(run_id, '') <> ?"
      : '';
    const params = request.runId
      ? [request.requestSource, request.baseCategory, request.runId]
      : [request.requestSource, request.baseCategory];
    const rows = getDb().prepare(`
      SELECT SUM(cost_usd) AS cost_usd
      FROM api_usage
      WHERE request_source = ?
        AND base_category = ?
        ${currentRunPredicate}
        AND cost_usd > 0
        AND ts >= datetime('now', '-30 days')
      GROUP BY CASE
        WHEN run_id IS NOT NULL AND trim(run_id) <> '' THEN 'run:' || run_id
        ELSE 'row:' || id
      END
      ORDER BY cost_usd ASC
    `).all(...params) as Array<{ cost_usd: number }>;
    if (rows.length === 0) return null;
    const index = Math.max(0, Math.ceil(rows.length * 0.95) - 1);
    const value = Number(rows[index]?.cost_usd);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function tryGetCurrentRunSpentUsd(request: AiBudgetRequest): number | null {
  if (!request.runId) return 0;
  try {
    const systemPool = request.requestSource === 'system';
    const userPredicate = systemPool ? '' : 'AND user_id = ?';
    const params = systemPool
      ? [request.requestSource, request.baseCategory, request.runId]
      : [request.requestSource, request.baseCategory, request.runId, request.userId];
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM api_usage
      WHERE request_source = ?
        AND base_category = ?
        AND run_id = ?
        ${userPredicate}
        AND cost_usd > 0
    `).get(...params) as { cost_usd?: number } | undefined;
    const value = Number(row?.cost_usd ?? 0);
    if (!Number.isFinite(value)) return null;
    const reserved = request.hardRunCostLimitUsd !== undefined || request.hardJobCostLimitUsd !== undefined
      ? tryGetHardAttemptReservedUsd(request, false)
      : 0;
    return reserved == null ? null : Math.max(0, value) + reserved;
  } catch {
    return null;
  }
}

function tryGetCurrentJobSpentUsd(request: AiBudgetRequest): number | null {
  if (!request.runId || !request.jobName) return null;
  try {
    const systemPool = request.requestSource === 'system';
    const userPredicate = systemPool ? '' : 'AND user_id = ?';
    const params = systemPool
      ? [request.requestSource, request.baseCategory, request.runId, request.jobName]
      : [request.requestSource, request.baseCategory, request.runId, request.jobName, request.userId];
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM api_usage
      WHERE request_source = ?
        AND base_category = ?
        AND run_id = ?
        AND job_name = ?
        ${userPredicate}
        AND cost_usd > 0
    `).get(...params) as { cost_usd?: number } | undefined;
    const value = Number(row?.cost_usd ?? 0);
    if (!Number.isFinite(value)) return null;
    const reserved = tryGetHardAttemptReservedUsd(request, true);
    return reserved == null ? null : Math.max(0, value) + reserved;
  } catch {
    return null;
  }
}

function ensureHardAttemptReservationTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_provider_attempt_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      request_source TEXT NOT NULL,
      base_category TEXT NOT NULL,
      job_name TEXT,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_category TEXT NOT NULL,
      reserved_cost_usd REAL NOT NULL CHECK (reserved_cost_usd >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_provider_attempt_reservations_run
      ON ai_provider_attempt_reservations(request_source, base_category, run_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_provider_attempt_reservations_job
      ON ai_provider_attempt_reservations(request_source, base_category, run_id, job_name, user_id);
  `);
}

function tryGetHardAttemptReservedUsd(request: AiBudgetRequest, jobScoped: boolean): number | null {
  if (!request.runId || (jobScoped && !request.jobName)) return null;
  try {
    const db = getDb();
    ensureHardAttemptReservationTable(db);
    const systemPool = request.requestSource === 'system';
    const userPredicate = systemPool ? '' : 'AND user_id = ?';
    const jobPredicate = jobScoped ? 'AND job_name = ?' : '';
    const params: unknown[] = [request.requestSource, request.baseCategory, request.runId];
    if (jobScoped) params.push(request.jobName);
    if (!systemPool) params.push(request.userId);
    const row = db.prepare(`
      SELECT COALESCE(SUM(reserved_cost_usd), 0) AS reserved_cost_usd
        FROM ai_provider_attempt_reservations
       WHERE request_source = ?
         AND base_category = ?
         AND run_id = ?
         ${jobPredicate}
         ${userPredicate}
    `).get(...params) as { reserved_cost_usd?: number } | undefined;
    const value = Number(row?.reserved_cost_usd ?? 0);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

type HardProviderAttemptReservationResult = 'reserved' | 'limit_exceeded' | 'failed';

function hardScopeCommittedUsd(
  db: ReturnType<typeof getDb>,
  request: AiBudgetRequest,
  jobScoped: boolean,
): number {
  const systemPool = request.requestSource === 'system';
  const userPredicate = systemPool ? '' : 'AND user_id = ?';
  const jobPredicate = jobScoped ? 'AND job_name = ?' : '';
  const params: Array<string | number> = [request.requestSource, request.baseCategory, request.runId!];
  if (jobScoped) params.push(request.jobName!);
  if (!systemPool) params.push(request.userId);
  const usage = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS amount
      FROM api_usage
     WHERE request_source = ?
       AND base_category = ?
       AND run_id = ?
       ${jobPredicate}
       ${userPredicate}
       AND cost_usd > 0
  `).get(...params) as { amount?: number } | undefined;
  const reserved = db.prepare(`
    SELECT COALESCE(SUM(reserved_cost_usd), 0) AS amount
      FROM ai_provider_attempt_reservations
     WHERE request_source = ?
       AND base_category = ?
       AND run_id = ?
       ${jobPredicate}
       ${userPredicate}
  `).get(...params) as { amount?: number } | undefined;
  const usageUsd = Number(usage?.amount ?? 0);
  const reservedUsd = Number(reserved?.amount ?? 0);
  if (!Number.isFinite(usageUsd) || usageUsd < 0 || !Number.isFinite(reservedUsd) || reservedUsd < 0) {
    throw new Error('invalid hard-cost scope');
  }
  // Retaining both values is intentionally pessimistic. A timed-out provider
  // can be billed after the caller has abandoned it; its maximum reservation
  // therefore remains committed even when a late/estimated usage row exists.
  return usageUsd + reservedUsd;
}

function reserveHardProviderAttempt(input: {
  request: AiBudgetRequest;
  provider: string;
  model: string;
  providerCategory: string;
  maxCostUsd: number;
}): HardProviderAttemptReservationResult {
  try {
    const db = getDb();
    ensureHardAttemptReservationTable(db);
    if (!input.request.runId) return 'failed';
    const reserve = db.transaction((): HardProviderAttemptReservationResult => {
      if (input.request.hardRunCostLimitUsd !== undefined) {
        const hardRunLimitUsd = Number(input.request.hardRunCostLimitUsd);
        if (
          !Number.isFinite(hardRunLimitUsd)
          || hardRunLimitUsd <= 0
          || hardScopeCommittedUsd(db, input.request, false) + input.maxCostUsd > hardRunLimitUsd + Number.EPSILON
        ) return 'limit_exceeded';
      }
      if (input.request.hardJobCostLimitUsd !== undefined) {
        const hardJobLimitUsd = Number(input.request.hardJobCostLimitUsd);
        if (
          !input.request.jobName
          || !Number.isFinite(hardJobLimitUsd)
          || hardJobLimitUsd <= 0
          || hardScopeCommittedUsd(db, input.request, true) + input.maxCostUsd > hardJobLimitUsd + Number.EPSILON
        ) return 'limit_exceeded';
      }
      db.prepare(`
        INSERT INTO ai_provider_attempt_reservations (
          user_id, request_source, base_category, job_name, run_id,
          provider, model, provider_category, reserved_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.request.userId,
        input.request.requestSource,
        input.request.baseCategory,
        input.request.jobName ?? null,
        input.request.runId,
        input.provider,
        input.model,
        input.providerCategory,
        input.maxCostUsd,
      );
      return 'reserved';
    });
    // SQLite serializes competing writers before the in-transaction re-read,
    // so replayed/concurrent signed boundaries cannot both spend stale headroom.
    return reserve.immediate();
  } catch {
    return 'failed';
  }
}

function getCurrentRunSpentUsd(request: AiBudgetRequest): number {
  // Forecast-only callers retain the conservative historical behavior. A
  // hard run ceiling uses tryGetCurrentRunSpentUsd directly and fails closed.
  return tryGetCurrentRunSpentUsd(request) ?? 0;
}

export function estimateAiBudgetReservationUsd(request: AiBudgetRequest): number {
  const explicit = Number(request.estimatedCostUsd);
  if (
    request.exactHardCostEstimate === true
    && (request.baseCategory === 'chat_live_eval_local' || request.baseCategory === 'chat_live_eval_real')
    && request.hardRunCostLimitUsd !== undefined
    && Number.isFinite(explicit)
    && explicit >= 0
  ) {
    return Number(explicit.toFixed(8));
  }
  const validExplicit = Number.isFinite(explicit) && explicit > 0 ? explicit : null;
  const rollingP95 = getRollingP95CostUsd(request);
  const workloadDefault = WORKLOAD_DEFAULT_ESTIMATED_COST_USD
    .find(([pattern]) => pattern.test(`${request.baseCategory}:${request.jobName ?? ''}`))?.[1];
  const safeDefault = workloadDefault ?? DEFAULT_ESTIMATED_COST_USD[request.requestSource];
  const currentRunSpentUsd = getCurrentRunSpentUsd(request);
  const workloadBaseline = rollingP95 ?? safeDefault;
  // p95 describes the complete workload run. On a second or later provider
  // stage, quota already includes the earlier rows, so reserve only what
  // remains of the 125% run envelope instead of counting the whole p95 twice.
  const remainingRunEnvelopeUsd = Math.max(
    workloadBaseline * RESERVATION_MULTIPLIER - currentRunSpentUsd,
    0,
  );
  // An explicit estimate is a concrete-call floor (automation supplies a hard
  // provider maximum). It may increase, never reduce, remaining p95 headroom.
  const explicitFloorUsd = validExplicit ?? 0;
  // If an unexpected extra stage has already exhausted the historical run
  // envelope, retain the centrally configured per-call default instead of
  // allowing an unreserved call solely because remaining p95 reached zero.
  const unexpectedStageFloorUsd = currentRunSpentUsd > 0
    ? safeDefault * RESERVATION_MULTIPLIER
    : 0;
  return Number(Math.max(
    remainingRunEnvelopeUsd,
    explicitFloorUsd,
    unexpectedStageFloorUsd,
  ).toFixed(8));
}

function inferAutomationPriority(request: AiBudgetRequest): AiAutomationPriority {
  if (request.automationPriority) return request.automationPriority;
  const baseCategory = request.baseCategory.trim().toLowerCase();
  const jobName = request.jobName?.trim().toLowerCase() ?? '';
  if (baseCategory === 'coach_analysis' || jobName === 'garmin_coach' || jobName === 'daily_coach') return 'coach';
  if (['channel_analysis', 'knowledge_synthesis', 'channel_learning'].includes(baseCategory)
    || jobName === 'channel_relearn') return 'channel_learning';
  if (['content_workflow_reel', 'content_workflow_youtube', 'content_workflow_weekly'].includes(baseCategory)
    || ['tuesday_reels', 'thursday_youtube', 'friday_weekly'].includes(jobName)) return 'content';
  return 'other';
}

interface ScheduledContentPrioritySlot {
  weekday: 2 | 4 | 5;
  hour: number;
  minute: number;
  jobName: 'tuesday_reels' | 'thursday_youtube' | 'friday_weekly';
  baseCategory: 'content_workflow_reel' | 'content_workflow_youtube' | 'content_workflow_weekly';
  targets: ReadonlyArray<{ format: 'reel' | 'youtube'; count: number }>;
}

const SCHEDULED_CONTENT_PRIORITY_SLOTS: ReadonlyArray<ScheduledContentPrioritySlot> = [
  {
    weekday: 2,
    hour: 9,
    minute: 17,
    jobName: 'tuesday_reels',
    baseCategory: 'content_workflow_reel',
    targets: [{ format: 'reel', count: 5 }],
  },
  {
    weekday: 4,
    hour: 9,
    minute: 23,
    jobName: 'thursday_youtube',
    baseCategory: 'content_workflow_youtube',
    targets: [{ format: 'youtube', count: 5 }],
  },
  {
    weekday: 5,
    hour: 18,
    minute: 41,
    jobName: 'friday_weekly',
    baseCategory: 'content_workflow_weekly',
    targets: [{ format: 'reel', count: 4 }, { format: 'youtube', count: 2 }],
  },
];

function isContentPriorityEnabled(quota: DailyQuotaStatus): boolean {
  if (!quota.entitlement?.allowedSkills.has('content')) return false;
  try {
    const row = getDb().prepare(`
      SELECT enabled
        FROM user_skill_overrides
       WHERE user_id = ?
         AND skill = 'content'
         AND sub_skill IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT 1
    `).get(quota.entitlement.userId) as { enabled?: number } | undefined;
    return row?.enabled !== 0;
  } catch {
    // The default policy is enabled. Preserve the higher-priority allowance
    // when the optional override table cannot be read.
    return true;
  }
}

function scheduledContentWorkNeeded(userId: number, slot: ScheduledContentPrioritySlot): boolean {
  try {
    const db = getDb();
    const inventory = db.prepare(`
      SELECT
        SUM(CASE
          WHEN sentiment = 'pending'
           AND created_at >= datetime('now', '-7 days')
          THEN 1 ELSE 0 END
        ) AS pending_count,
        COUNT(*) AS historical_count
      FROM content_topic_feedback
      WHERE user_id = ?
        AND COALESCE(tenant_id, user_id) = ?
        AND source_job = ?
        AND format = ?
    `);
    let hasMissingInventory = false;
    let initialBatchIncomplete = false;
    for (const target of slot.targets) {
      const row = inventory.get(
        userId,
        userId,
        slot.jobName,
        target.format,
      ) as { pending_count?: number; historical_count?: number };
      if (Number(row.pending_count ?? 0) < target.count) hasMissingInventory = true;
      if (Number(row.historical_count ?? 0) < target.count) initialBatchIncomplete = true;
    }
    if (!hasMissingInventory) return false;
    if (initialBatchIncomplete) return true;

    const engagement = db.prepare(`
      SELECT (
        EXISTS(
          SELECT 1 FROM content_topic_feedback
           WHERE user_id = ?
             AND COALESCE(tenant_id, user_id) = ?
             AND created_at >= datetime('now', '-30 days')
             AND (
               sentiment != 'pending'
               OR COALESCE(script_generated, 0) = 1
               OR converted_at IS NOT NULL
             )
        )
        OR EXISTS(
          SELECT 1
            FROM content_domain_objects content_item
            JOIN content_artifacts content_artifact
              ON content_artifact.item_id = content_item.id
             AND content_artifact.tenant_id = content_item.tenant_id
             AND content_artifact.owner_user_id = content_item.owner_user_id
            JOIN content_revisions content_revision
              ON content_revision.id = content_artifact.current_revision_id
             AND content_revision.artifact_id = content_artifact.id
             AND content_revision.tenant_id = content_artifact.tenant_id
             AND content_revision.owner_user_id = content_artifact.owner_user_id
           WHERE content_item.owner_user_id = ?
             AND content_item.tenant_id = ?
             AND content_item.visibility_scope = 'user_private'
             AND content_item.scope_status = 'active'
             AND content_item.deleted_at IS NULL
             AND content_item.object_type = 'content_item'
             AND content_artifact.visibility_scope = 'user_private'
             AND content_artifact.scope_status = 'active'
             AND content_artifact.artifact_type IN ('script', 'platform_variant')
             AND content_revision.created_at >= datetime('now', '-30 days')
        )
      ) AS engaged
    `).get(userId, userId, userId, userId) as { engaged?: number };
    return engagement.engaged === 1;
  } catch {
    // Content outranks Channel Learning. If delivery state cannot be read,
    // keep one scheduled-call reserve instead of letting lower-priority work
    // consume allowance that may already be owed.
    return true;
  }
}

function scheduledContentOccurrence(
  slot: ScheduledContentPrioritySlot,
  localNow: DateTime,
): DateTime {
  const daysUntil = (slot.weekday - localNow.weekday + 7) % 7;
  let occurrence = localNow.startOf('day').plus({ days: daysUntil }).set({
    hour: slot.hour,
    minute: slot.minute,
  });
  // Keep a missed-today slot due for the rest of that local day; on the next
  // day it naturally rolls to next week and cannot strand the current month.
  if (daysUntil === 0 && occurrence.toMillis() < localNow.toMillis()) occurrence = localNow;
  return occurrence;
}

function expectedScheduledContentReserveByWindow(
  request: AiBudgetRequest,
  quota: DailyQuotaStatus,
): { dailyUsd: number; monthlyUsd: number } {
  const priority = inferAutomationPriority(request);
  if (priority === 'coach' || priority === 'content' || !isContentPriorityEnabled(quota)) {
    return { dailyUsd: 0, monthlyUsd: 0 };
  }

  const zone = config.app?.timezone || 'UTC';
  const localNow = DateTime.fromJSDate(new Date(), { zone });
  const monthlyReset = DateTime.fromISO(quota.monthlyResetAt, { setZone: true });
  const next = SCHEDULED_CONTENT_PRIORITY_SLOTS
    .filter((slot) => scheduledContentWorkNeeded(request.userId, slot))
    .map((slot) => ({ slot, occurrence: scheduledContentOccurrence(slot, localNow) }))
    .sort((a, b) => a.occurrence.toMillis() - b.occurrence.toMillis())[0];
  if (
    !next
    || !monthlyReset.isValid
    || next.occurrence.toMillis() >= monthlyReset.toMillis()
  ) {
    return { dailyUsd: 0, monthlyUsd: 0 };
  }

  // Protect exactly one next scheduled Content envelope. Once that inventory
  // is durable this query advances to the following slot, while full or
  // engagement-gated inventory releases the reserve for Channel Learning.
  const reserveUsd = estimateAiBudgetReservationUsd({
    userId: request.userId,
    requestSource: 'automation',
    baseCategory: next.slot.baseCategory,
    jobName: next.slot.jobName,
    automationPriority: 'content',
  });
  return {
    dailyUsd: next.slot.weekday === localNow.weekday ? reserveUsd : 0,
    monthlyUsd: reserveUsd,
  };
}

function hasSuccessfulCoachDeliveryInWindow(userId: number, start: string, end: string): boolean {
  try {
    const row = getDb().prepare(`
      SELECT 1 AS delivered
      FROM report_documents
      WHERE user_id = ?
        AND type = 'coach_briefing'
        AND source_job = 'garmin_coach'
        AND datetime(created_at) >= datetime(?)
        AND datetime(created_at) < datetime(?)
        AND length(trim(COALESCE(document_json, ''))) > 2
      LIMIT 1
    `).get(userId, start, end) as { delivered?: number } | undefined;
    return row?.delivered === 1;
  } catch {
    // Fail safe: keep protecting the Coach reserve when delivery truth cannot
    // be read. This may defer lower-priority work but cannot overspend.
    return false;
  }
}

/** Keep lower-priority headroom only when the scheduler would actually run Coach. */
function isCoachReserveEligible(userId: number): boolean {
  try {
    const entitlement = getEffectiveEntitlement(userId);
    if (!entitlement.automationAllowed || !entitlement.allowedSkills.has('triathlon')) return false;
    const db = getDb();
    const activePlan = db.prepare(`
      SELECT 1 AS present
        FROM fitness_training_plans
       WHERE user_id = ? AND tenant_id = ? AND status = 'active'
       LIMIT 1
    `).get(userId, userId) as { present?: number } | undefined;
    if (activePlan?.present !== 1) return false;
    if (isGarminConfigured() && isOwnerUserRef(userId, {
      allowPersistedTier: false,
      requireConfiguredIdentity: true,
    })) return true;
    const health = db.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM apple_health_data
         WHERE user_id = ? AND date = date('now')
      ) AS present
    `).get(userId) as { present?: number };
    return health.present === 1;
  } catch {
    return false;
  }
}

function expectedCoachReserveByWindow(
  request: AiBudgetRequest,
): { dailyUsd: number; monthlyUsd: number } {
  if (inferAutomationPriority(request) === 'coach') return { dailyUsd: 0, monthlyUsd: 0 };
  if (!isCoachReserveEligible(request.userId)) return { dailyUsd: 0, monthlyUsd: 0 };
  const reserveUsd = estimateAiBudgetReservationUsd({
    userId: request.userId,
    requestSource: 'automation',
    baseCategory: 'coach_analysis',
    jobName: 'daily_coach',
    estimatedCostUsd: COACH_EXPECTED_HARD_MAX_USD,
    automationPriority: 'coach',
  });
  const now = new Date();
  const day = getUtcDayWindow(now);
  const coachDeliveredToday = hasSuccessfulCoachDeliveryInWindow(request.userId, day.start, day.end);
  return {
    dailyUsd: coachDeliveredToday ? 0 : reserveUsd,
    // The monthly ceiling must also preserve today's expected call. A Coach
    // call earlier in the billing month does not satisfy today's delivery.
    monthlyUsd: coachDeliveredToday ? 0 : reserveUsd,
  };
}

export function getAutomationBudgetHeadroom(quota: DailyQuotaStatus): {
  dailyRemainingUsd: number;
  monthlyRemainingUsd: number;
} {
  return {
    dailyRemainingUsd: quota.automationDailyRemainingUsd,
    monthlyRemainingUsd: quota.automationMonthlyRemainingUsd,
  };
}

function deniedDecision(
  quota: DailyQuotaStatus,
  reservedCostUsd: number,
  input: {
    code: AiBudgetDecision['code'];
    status: 403 | 429;
    window: AiBudgetWindow;
    message: string;
    unblocksAt: string | null;
    internalReason?: AiBudgetDecision['internalReason'];
  },
): AiBudgetDecision {
  return {
    allowed: false,
    status: input.status,
    code: input.code,
    window: input.window,
    message: input.message,
    quota,
    reservedCostUsd,
    retryAfterSeconds: input.unblocksAt ? secondsUntil(input.unblocksAt) : null,
    unblocksAt: input.unblocksAt,
    internalReason: input.internalReason,
  };
}

/**
 * Read-only budget decision. Callers that will spend must use
 * withAiBudgetReservation so this check is serialized with the api_usage write.
 */
export function checkAiBudget(request: AiBudgetRequest): AiBudgetDecision {
  const quota = getDailyQuotaStatus(request.userId, { requestSource: request.requestSource });
  const reservedCostUsd = estimateAiBudgetReservationUsd(request);
  const global = checkGlobalCostGuardrail();

  const persistenceFailure = getApiUsagePersistenceFailure();
  let persistenceRecovered = !persistenceFailure;
  if (persistenceFailure) {
    try {
      persistenceRecovered = tryRecoverApiUsagePersistenceFailure(getDb());
    } catch {
      persistenceRecovered = false;
    }
  }
  if (persistenceFailure && !persistenceRecovered) {
    const currentFailure = getApiUsagePersistenceFailure() ?? persistenceFailure;
    return deniedDecision(quota, reservedCostUsd, {
      code: 'SERVICE_DEGRADED',
      status: 429,
      window: 'global',
      message: 'AI-backed features are temporarily degraded because usage metering is unavailable. Token-zero reads remain available.',
      unblocksAt: currentFailure.retryAt,
      internalReason: 'metering_unavailable',
    });
  }

  if (global.exceeded) {
    return deniedDecision(quota, reservedCostUsd, {
      code: 'SERVICE_DEGRADED',
      status: 429,
      window: 'global',
      message: 'AI-backed features are temporarily degraded because the workspace daily AI budget has been reached. Token-zero reads remain available.',
      unblocksAt: quota.dailyResetAt,
    });
  }

  if (request.hardRunCostLimitUsd !== undefined) {
    const hardLimitUsd = Number(request.hardRunCostLimitUsd);
    const runSpentUsd = tryGetCurrentRunSpentUsd(request);
    if (
      !request.runId
      || !Number.isFinite(hardLimitUsd)
      || hardLimitUsd <= 0
      || runSpentUsd == null
      || runSpentUsd + reservedCostUsd > hardLimitUsd + Number.EPSILON
    ) {
      return deniedDecision(quota, reservedCostUsd, {
        code: 'SERVICE_DEGRADED',
        status: 429,
        window: 'global',
        message: 'AI work was stopped because its explicit run cost ceiling could not safely cover the next provider attempt. No additional model call was made.',
        unblocksAt: null,
      });
    }
  }

  if (request.hardJobCostLimitUsd !== undefined) {
    const hardLimitUsd = Number(request.hardJobCostLimitUsd);
    const jobSpentUsd = tryGetCurrentJobSpentUsd(request);
    if (
      !request.runId
      || !request.jobName
      || !Number.isFinite(hardLimitUsd)
      || hardLimitUsd <= 0
      || jobSpentUsd == null
      || jobSpentUsd + reservedCostUsd > hardLimitUsd + Number.EPSILON
    ) {
      return deniedDecision(quota, reservedCostUsd, {
        code: 'SERVICE_DEGRADED',
        status: 429,
        window: 'global',
        message: 'AI work was stopped because its explicit job cost ceiling could not safely cover the next provider attempt. No additional model call was made.',
        unblocksAt: null,
      });
    }
  }

  if (quota.blockReason === 'entitlement_error') {
    return deniedDecision(quota, reservedCostUsd, {
      code: 'SERVICE_DEGRADED',
      status: 429,
      window: 'global',
      message: 'AI-backed features are temporarily degraded while entitlement status is verified. Token-zero reads remain available.',
      unblocksAt: new Date(Date.now() + 60_000).toISOString(),
      internalReason: 'entitlement_error',
    });
  }

  if (!isPaidAiCostControlsEnforcementEnabled()) {
    if (quota.over) {
      return deniedDecision(quota, reservedCostUsd, {
        code: 'AI_DAILY_LIMIT_REACHED',
        status: 429,
        window: 'daily',
        message: buildQuotaExceededMessage(quota),
        unblocksAt: quota.dailyResetAt,
      });
    }
    return {
      allowed: true,
      status: 200,
      code: 'OK',
      window: null,
      message: 'Paid AI cost controls are observing only',
      quota,
      reservedCostUsd,
      retryAfterSeconds: null,
      unblocksAt: null,
    };
  }

  if (!quota.aiAccessAllowed || (request.requestSource === 'automation' && !quota.automationAllowed)) {
    return deniedDecision(quota, reservedCostUsd, {
      code: 'AI_PLAN_REQUIRED',
      status: 403,
      window: 'plan',
      message: 'Model-backed AI requires an active paid plan. Token-zero reads and actions remain available.',
      unblocksAt: null,
    });
  }

  if (request.requestSource === 'automation') {
    const protectedCoachReserve = expectedCoachReserveByWindow(request);
    const protectedContentReserve = expectedScheduledContentReserveByWindow(request, quota);
    const automationDailyInsufficient = quota.automationSpentTodayUsd
      + reservedCostUsd
      + protectedCoachReserve.dailyUsd
      + protectedContentReserve.dailyUsd
      > quota.automationDailyCapUsd;
    const automationMonthlyInsufficient = quota.automationSpentMonthlyUsd
      + reservedCostUsd
      + protectedCoachReserve.monthlyUsd
      + protectedContentReserve.monthlyUsd
      > quota.automationMonthlyCapUsd;
    // Monthly takes precedence when both windows are exhausted: a daily
    // reset alone would not actually unblock the job.
    if (automationMonthlyInsufficient) {
      return deniedDecision(quota, reservedCostUsd, {
        code: 'AI_MONTHLY_LIMIT_REACHED',
        status: 429,
        window: 'automation_monthly',
        message: `Monthly automation AI quota reached for the ${quota.plan} plan.`,
        unblocksAt: quota.monthlyResetAt,
      });
    }
    if (automationDailyInsufficient) {
      return deniedDecision(quota, reservedCostUsd, {
        code: 'AI_DAILY_LIMIT_REACHED',
        status: 429,
        window: 'automation_daily',
        message: `Daily automation AI quota reached for the ${quota.plan} plan.`,
        unblocksAt: quota.dailyResetAt,
      });
    }
  }

  const pointsHeadroom = request.requestSource === 'interactive' ? quota.nexusPointsRemainingUsd : 0;
  // The Points balance is already reduced by settled overage (and the quota
  // snapshot also subtracts any unsettled overage). Comparing total spend to
  // cap + remaining Points would therefore charge settled overage twice.
  // Compare the new reservation with each window's remaining headroom instead.
  const dailyHeadroomUsd = Math.max(quota.capUsd - quota.spentUsd, 0) + pointsHeadroom;
  const monthlyHeadroomUsd = Math.max(quota.monthlyCapUsd - quota.monthlySpentUsd, 0) + pointsHeadroom;
  const dailyInsufficient = reservedCostUsd > dailyHeadroomUsd;
  const monthlyInsufficient = reservedCostUsd > monthlyHeadroomUsd;
  // Monthly takes precedence when both windows are exhausted: a daily reset
  // would not unblock the caller while the billing-period cap still binds.
  if (monthlyInsufficient) {
    return deniedDecision(quota, reservedCostUsd, {
      code: 'AI_MONTHLY_LIMIT_REACHED',
      status: 429,
      window: 'monthly',
      message: `Monthly AI quota reached for the ${quota.plan} plan.`,
      unblocksAt: quota.monthlyResetAt,
    });
  }
  if (dailyInsufficient) {
    return deniedDecision(quota, reservedCostUsd, {
      code: 'AI_DAILY_LIMIT_REACHED',
      status: 429,
      window: 'daily',
      message: `Daily AI quota reached for the ${quota.plan} plan.`,
      unblocksAt: quota.dailyResetAt,
    });
  }

  return {
    allowed: true,
    status: 200,
    code: 'OK',
    window: null,
    message: 'AI budget available',
    quota,
    reservedCostUsd,
    retryAfterSeconds: null,
    unblocksAt: null,
  };
}

export class AiBudgetError extends Error {
  readonly decision: AiBudgetDecision;

  constructor(decision: AiBudgetDecision) {
    super(decision.code);
    this.name = 'AiBudgetError';
    this.decision = decision;
  }
}

function createActiveReservationContext(
  lease: SqliteCostLockLease,
  userId: number,
  input: Partial<Pick<AiBudgetRequest, 'requestSource' | 'baseCategory' | 'jobName' | 'runId' | 'hardRunCostLimitUsd' | 'hardJobCostLimitUsd'>> = {},
): ActiveAiBudgetReservationContext {
  return {
    userId,
    reservationId: lease.ownerToken,
    requestSource: input.requestSource ?? (userId > 0 ? 'interactive' : 'system'),
    baseCategory: input.baseCategory ?? 'interactive',
    jobName: input.jobName ?? null,
    runId: input.runId ?? crypto.randomUUID(),
    ...(input.hardRunCostLimitUsd !== undefined ? { hardRunCostLimitUsd: input.hardRunCostLimitUsd } : {}),
    ...(input.hardJobCostLimitUsd !== undefined ? { hardJobCostLimitUsd: input.hardJobCostLimitUsd } : {}),
    active: true,
    approved: false,
  };
}

function currentActiveAiBudgetReservation(): ActiveAiBudgetReservationContext | null {
  const asyncLocal = activeAiBudgetReservation.getStore();
  if (asyncLocal?.active) return asyncLocal;
  const requestId = getCurrentRequestId();
  return requestId ? activeAiBudgetReservationByRequestId.get(requestId) ?? null : null;
}

/**
 * Returns marker material only inside the async chain that owns a live,
 * approved SQLite reservation for the same user. internal-attribution signs
 * this object; callers cannot manufacture a usable marker from body fields.
 */
export function getActiveAiBudgetReservationMarker(
  userId: number,
  providerCategory: string,
): SignedOuterAiBudgetReservation | null {
  const active = currentActiveAiBudgetReservation();
  if (!active || !active.active || !active.approved || active.userId !== userId) return null;
  // The provider category is independently signed in the attribution claims.
  // The marker must retain the outer workload's canonical base category so
  // Python re-entry keeps the same p95/run/budget lineage.
  if (!String(providerCategory || '').trim() || !active.baseCategory.trim()) return null;
  return {
    reservationId: active.reservationId,
    requestSource: active.requestSource,
    baseCategory: active.baseCategory,
    jobName: active.jobName,
    runId: active.runId,
    ...(active.hardRunCostLimitUsd !== undefined ? { hardRunCostLimitUsd: active.hardRunCostLimitUsd } : {}),
    ...(active.hardJobCostLimitUsd !== undefined ? { hardJobCostLimitUsd: active.hardJobCostLimitUsd } : {}),
  };
}

/**
 * Provider-boundary invariant. With enforcement enabled, no cloud/local model
 * network call may start unless an approved live reservation owns the shared
 * system lock or the matching user lock. This catches missed call sites and
 * fails closed before tokens are spent.
 */
export function assertAiBudgetReservationForProvider(input: {
  userId: number;
  category: string;
  /** Worst-case cost of this concrete request at its hard provider token cap. */
  maxCostUsd: number;
  provider?: string;
  model?: string;
  /** Provider can inject tokenized context without an exact request cap. */
  hasUnboundedProviderInjectedContext?: boolean;
}): void {
  const active = currentActiveAiBudgetReservation();
  if (!isPaidAiCostControlsEnforcementEnabled()) {
    const hasHardCeiling = active?.hardRunCostLimitUsd !== undefined
      || active?.hardJobCostLimitUsd !== undefined;
    if (!hasHardCeiling) return;
  }
  const userMatches = active?.requestSource === 'system'
    || active?.userId === input.userId;
  const lockUserId = active?.requestSource === 'system' ? 0 : active?.userId;
  if (
    !active
    || !active.active
    || !active.approved
    || !userMatches
    || lockUserId == null
    || !isLiveOuterReservation(lockUserId, active.reservationId)
  ) {
    throw new AiBudgetError(serviceDegradedDecision({
      userId: input.userId,
      requestSource: active?.requestSource ?? (input.userId > 0 ? 'interactive' : 'system'),
      baseCategory: input.category,
      jobName: active?.jobName ?? null,
      runId: active?.runId ?? null,
    }, 'AI-backed features are temporarily degraded because no active usage reservation was found. Token-zero reads remain available.'));
  }

  // A single reserved workflow can contain several concrete provider attempts
  // (multi-stage generation, repair, or fallback). Re-read api_usage before
  // every attempt while the same SQLite lock is still held so usage recorded by
  // an earlier stage in this run reduces the next stage's headroom. The live
  // reservation proves serialization; this fresh decision proves budget.
  const request: AiBudgetRequest = {
    userId: active.userId,
    requestSource: active.requestSource,
    baseCategory: active.baseCategory,
    jobName: active.jobName,
    runId: active.runId,
    ...(active.hardRunCostLimitUsd !== undefined ? { hardRunCostLimitUsd: active.hardRunCostLimitUsd } : {}),
    ...(active.hardJobCostLimitUsd !== undefined ? { hardJobCostLimitUsd: active.hardJobCostLimitUsd } : {}),
  };
  const provider = String(input.provider || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  if (active.baseCategory === 'content_live_eval') {
    if (
      !isContentLiveEvalProviderCategory(input.category)
      || !provider
      || !model
      || !isContentLiveEvalRegisteredModel(provider, model)
    ) {
      const decision = serviceDegradedDecision(
        request,
        'Content live evaluation was stopped because the exact reviewed provider, model, or standard-script route did not match. No model call was made.',
      );
      recordAiBudgetDeferral(request, decision);
      throw new AiBudgetError(decision);
    }
  }
  if (
    (active.baseCategory === 'chat_live_eval_local'
      && (provider !== 'ollama' || Number(input.maxCostUsd) !== 0))
    || (active.baseCategory === 'chat_live_eval_real'
      && !['anthropic', 'gemini', 'openai'].includes(provider))
  ) {
    const decision = serviceDegradedDecision(
      request,
      'Chat live evaluation was stopped because its governed provider policy did not match. No model call was made.',
    );
    recordAiBudgetDeferral(request, decision);
    throw new AiBudgetError(decision);
  }
  if (input.hasUnboundedProviderInjectedContext && active.requestSource !== 'interactive') {
    const decision = serviceDegradedDecision(
      request,
      'Background AI search was deferred because the request context could not be bounded for conservative cost preauthorization. No model call was made.',
    );
    recordAiBudgetDeferral(request, decision);
    throw new AiBudgetError(decision);
  }
  const hardMaximum = Number(input.maxCostUsd);
  if (!Number.isFinite(hardMaximum) || hardMaximum < 0) {
    const decision = serviceDegradedDecision(
      request,
      'AI work was deferred because the provider request did not expose resolved pricing and a conservative preauthorization amount. No model call was made.',
    );
    recordAiBudgetDeferral(request, decision);
    throw new AiBudgetError(decision);
  }
  // A provider-enforced output cap plus a conservative serialized-input limit
  // yields the accounting reservation under the reviewed registry. It limits
  // Nexus preauthorization but is not an external invoice guarantee. Feed it
  // into the canonical estimator for every source. These reservations are not
  // multiplied again; rolling p95/default forecasts retain the 125% reserve.
  request.estimatedCostUsd = hardMaximum;
  if (active.baseCategory === 'chat_live_eval_local' || active.baseCategory === 'chat_live_eval_real') {
    request.exactHardCostEstimate = true;
  }
  const decision = checkAiBudget(request);
  if (!decision.allowed) {
    recordAiBudgetDeferral(request, decision);
    throw new AiBudgetError(decision);
  }
  if (active.hardRunCostLimitUsd !== undefined || active.hardJobCostLimitUsd !== undefined) {
    const attemptReservation = provider && model
      ? reserveHardProviderAttempt({
        request,
        provider,
        model,
        providerCategory: input.category,
        maxCostUsd: hardMaximum,
      })
      : 'failed';
    if (attemptReservation !== 'reserved') {
      const reservationFailure = serviceDegradedDecision(
        request,
        attemptReservation === 'limit_exceeded'
          ? 'AI work was stopped because another provider attempt already committed the remaining explicit cost ceiling. No model call was made.'
          : 'AI work was stopped because its durable provider-attempt reservation could not be recorded. No model call was made.',
        attemptReservation === 'failed' ? 'metering_unavailable' : undefined,
      );
      recordAiBudgetDeferral(request, reservationFailure);
      throw new AiBudgetError(reservationFailure);
    }
  }
}

function isLiveOuterReservation(userId: number, reservationId: string): boolean {
  try {
    const db = getDb();
    ensureCostLockTable(db);
    const row = db.prepare(`
      SELECT 1 AS active
      FROM cost_guardrail_locks
      WHERE lock_key = ?
        AND owner_token = ?
        AND expires_at_ms > ?
      LIMIT 1
    `).get(`user:${userId}`, reservationId, Date.now()) as { active?: number } | undefined;
    return row?.active === 1;
  } catch {
    return false;
  }
}

function serviceDegradedDecision(
  request: AiBudgetRequest,
  message: string,
  internalReason?: AiBudgetDecision['internalReason'],
): AiBudgetDecision {
  const quota = getDailyQuotaStatus(request.userId, { requestSource: request.requestSource });
  return deniedDecision(quota, estimateAiBudgetReservationUsd(request), {
    code: 'SERVICE_DEGRADED',
    status: 429,
    window: 'global',
    message,
    unblocksAt: null,
    internalReason,
  });
}

/**
 * Re-enter a reservation held by a TS route while the Python content-engine
 * calls back into /internal/ai-complete. This intentionally does not acquire
 * the same user lock again (which would deadlock), but it verifies the signed
 * marker against the live cross-process SQLite owner token and performs a
 * fresh per-call budget check before provider execution.
 */
export async function withSignedOuterAiBudgetReservation<T>(
  request: AiBudgetRequest,
  marker: SignedOuterAiBudgetReservation,
  fn: () => Promise<T>,
): Promise<T> {
  const lockUserId = request.requestSource === 'system' ? 0 : request.userId;
  const markerMatchesRequest = marker.requestSource === request.requestSource
    && marker.baseCategory === request.baseCategory
    && (marker.jobName ?? null) === (request.jobName ?? null)
    && (marker.runId ?? null) === (request.runId ?? null)
    && (marker.hardRunCostLimitUsd ?? null) === (request.hardRunCostLimitUsd ?? null)
    && (marker.hardJobCostLimitUsd ?? null) === (request.hardJobCostLimitUsd ?? null)
    && typeof marker.reservationId === 'string'
    && marker.reservationId.length >= 16;
  if (!markerMatchesRequest || !isLiveOuterReservation(lockUserId, marker.reservationId)) {
    throw new AiBudgetError(serviceDegradedDecision(
      request,
      'AI-backed features are temporarily degraded because the outer usage reservation could not be verified. Token-zero reads remain available.',
    ));
  }

  const decision = checkAiBudget(request);
  if (!decision.allowed) {
    recordAiBudgetDeferral(request, decision);
    throw new AiBudgetError(decision);
  }
  const activeContext: ActiveAiBudgetReservationContext = {
    userId: request.userId,
    ...marker,
    active: true,
    approved: true,
  };
  try {
    return await activeAiBudgetReservation.run(activeContext, () => runWithApiUsageAttribution({
      requestSource: marker.requestSource,
      baseCategory: marker.baseCategory,
      jobName: marker.jobName,
      runId: marker.runId,
    }, fn));
  } finally {
    activeContext.active = false;
  }
}

function recordAiBudgetDeferral(request: AiBudgetRequest, decision: AiBudgetDecision): void {
  try {
    const attribution = resolveApiUsageAttribution(request.baseCategory, request.userId, {
      requestSource: request.requestSource,
      baseCategory: request.baseCategory,
      jobName: request.jobName ?? null,
      runId: request.runId ?? null,
    });
    getDb().prepare(`
      INSERT INTO ai_budget_deferrals (
        user_id, request_source, job_name, base_category, run_id,
        code, budget_window, reset_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.userId,
      attribution.requestSource,
      attribution.jobName,
      attribution.baseCategory,
      attribution.runId,
      decision.code,
      decision.window,
      decision.unblocksAt,
    );
  } catch (err) {
    logger.warn({ err, userId: request.userId, code: decision.code }, 'AI budget deferral persistence failed');
  }
}

/**
 * Serialize entitlement+budget check, provider call, api_usage INSERT, and
 * Nexus Points settlement. Provider instrumentation reads the async-local
 * attribution established here.
 */
export async function withAiBudgetReservation<T>(
  request: AiBudgetRequest,
  fn: () => Promise<T>,
): Promise<T> {
  const lockUserId = request.requestSource === 'system' ? 0 : request.userId;
  let lease: SqliteCostLockLease;
  try {
    lease = await acquireSqliteUserCostLock(lockUserId);
  } catch (err) {
    logger.error({ err, userId: request.userId, requestSource: request.requestSource }, 'AI budget lock unavailable');
    throw new AiBudgetError(serviceDegradedDecision(
      request,
      'AI-backed features are temporarily degraded because the usage budget lock is unavailable. Token-zero reads remain available.',
      'lock_unavailable',
    ));
  }
  const effectiveRequest: AiBudgetRequest = {
    ...request,
    runId: request.runId ?? crypto.randomUUID(),
  };
  const activeContext = createActiveReservationContext(lease, request.userId, effectiveRequest);
  try {
    return await activeAiBudgetReservation.run(activeContext, async () => {
      const decision = checkAiBudget(effectiveRequest);
      if (!decision.allowed) {
        recordAiBudgetDeferral(effectiveRequest, decision);
        throw new AiBudgetError(decision);
      }
      activeContext.approved = true;
      return runWithApiUsageAttribution({
        requestSource: effectiveRequest.requestSource,
        baseCategory: effectiveRequest.baseCategory,
        jobName: effectiveRequest.jobName ?? null,
        runId: effectiveRequest.runId ?? null,
      }, fn);
    });
  } finally {
    activeContext.active = false;
    lease.release();
  }
}

/**
 * Explicit-release canonical reservation for mixed token-zero/model routes.
 * This is the lazy equivalent of withAiBudgetReservation: it acquires the
 * classified lock, checks the same policy, approves provider-boundary access,
 * and installs the exact source/job/base/run attribution until release.
 */
export async function acquireAiBudgetReservation(
  request: AiBudgetRequest,
): Promise<() => void> {
  const effectiveRequest: AiBudgetRequest = {
    ...request,
    runId: request.runId ?? crypto.randomUUID(),
  };
  const lockUserId = effectiveRequest.requestSource === 'system' ? 0 : effectiveRequest.userId;
  let lease: SqliteCostLockLease;
  try {
    lease = await acquireSqliteUserCostLock(lockUserId);
  } catch (err) {
    logger.error({ err, userId: request.userId, requestSource: request.requestSource }, 'AI budget lock unavailable');
    throw new AiBudgetError(serviceDegradedDecision(
      effectiveRequest,
      'AI-backed features are temporarily degraded because the usage budget lock is unavailable. Token-zero reads remain available.',
      'lock_unavailable',
    ));
  }

  const previousContext = activeAiBudgetReservation.getStore() ?? null;
  const activeContext = createActiveReservationContext(lease, effectiveRequest.userId, effectiveRequest);
  const requestId = getCurrentRequestId();
  if (requestId) activeAiBudgetReservationByRequestId.set(requestId, activeContext);
  activeAiBudgetReservation.enterWith(activeContext);
  const restoreAttribution = enterApiUsageAttribution({
    requestSource: effectiveRequest.requestSource,
    baseCategory: effectiveRequest.baseCategory,
    jobName: effectiveRequest.jobName ?? null,
    runId: effectiveRequest.runId ?? null,
  });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeContext.active = false;
    lease.release();
    if (requestId && activeAiBudgetReservationByRequestId.get(requestId) === activeContext) {
      activeAiBudgetReservationByRequestId.delete(requestId);
    }
    restoreAttribution();
    activeAiBudgetReservation.enterWith(previousContext);
  };

  try {
    const decision = checkAiBudget(effectiveRequest);
    if (!decision.allowed) {
      recordAiBudgetDeferral(effectiveRequest, decision);
      throw new AiBudgetError(decision);
    }
    activeContext.approved = true;
    return release;
  } catch (err) {
    release();
    throw err;
  }
}

// ── Per-user check+spend mutex ───────────────────────────────────
//
// TOCTOU fix (hardening audit follow-up 2026-04-21 pass 2):
//
// Before this mutex, concurrent requests from the same user could
// both pass `isUserOverDailyCap` BEFORE either one wrote its
// `api_usage` row. Example on Free ($0.005/day) with $0.002/call:
//
//   req A: isUserOverDailyCap → over=false (spent=0)
//   req B: isUserOverDailyCap → over=false (spent=0) ← race!
//   req A: AI call completes, writes $0.002 (spent=0.002)
//   req B: AI call completes, writes $0.002 (spent=0.004) ✓
//   req C: (fresh request)    → over=false (spent=0.004)
//   req C: writes $0.002 (spent=0.006)  ← exceeds cap $0.005
//
// The mutex serializes check+spend PER USER so any pending AI call completes
// and writes its usage row before the next one checks the cap. Because PM2 can
// run multiple Node processes, the lock is SQLite-backed instead of a
// process-local Map. If SQLite locking is unavailable, callers fail closed.

// Provider calls may legitimately run for 180s and the Python proxy waits up
// to 300s. Keep a ten-minute lease and renew it while the owner is alive so
// another process can never enter the same budget window mid-call.
const SQLITE_COST_LOCK_TTL_MS = 600_000;
const SQLITE_COST_LOCK_HEARTBEAT_MS = 30_000;
const SQLITE_COST_LOCK_WAIT_MS = 30_000;
const SQLITE_COST_LOCK_POLL_MS = 25;

interface SqliteCostLockLease {
  lockKey: string;
  ownerToken: string;
  release: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryGetCostLockDb(): ReturnType<typeof getDb> | null {
  try {
    return getDb() ?? null;
  } catch {
    return null;
  }
}

function ensureCostLockTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_guardrail_locks (
      lock_key TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `);
}

async function acquireSqliteUserCostLock(userId: number): Promise<SqliteCostLockLease> {
  const db = tryGetCostLockDb();
  if (!db) {
    throw new Error('COST_GUARDRAIL_LOCK_UNAVAILABLE');
  }

  ensureCostLockTable(db);
  const lockKey = `user:${userId}`;
  const ownerToken = crypto.randomUUID();
  const startedAt = Date.now();

  while (Date.now() - startedAt < SQLITE_COST_LOCK_WAIT_MS) {
    const nowMs = Date.now();
    db.prepare('DELETE FROM cost_guardrail_locks WHERE lock_key = ? AND expires_at_ms <= ?')
      .run(lockKey, nowMs);
    const result = db.prepare(`
      INSERT OR IGNORE INTO cost_guardrail_locks (lock_key, owner_token, acquired_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(lockKey, ownerToken, nowMs, nowMs + SQLITE_COST_LOCK_TTL_MS);
    if (result.changes > 0) {
      let released = false;
      const heartbeat = setInterval(() => {
        if (released) return;
        try {
          const heartbeatResult = db.prepare(`
            UPDATE cost_guardrail_locks
            SET expires_at_ms = ?
            WHERE lock_key = ? AND owner_token = ?
          `).run(Date.now() + SQLITE_COST_LOCK_TTL_MS, lockKey, ownerToken);
          if (heartbeatResult.changes === 0) {
            logger.error({ userId, lockKey }, 'Cost guardrail SQLite lock heartbeat lost ownership');
          }
        } catch (err) {
          logger.error({ err, userId, lockKey }, 'Cost guardrail SQLite lock heartbeat failed');
        }
      }, SQLITE_COST_LOCK_HEARTBEAT_MS);
      if (typeof (heartbeat as any).unref === 'function') (heartbeat as any).unref();

      const release = () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          db.prepare('DELETE FROM cost_guardrail_locks WHERE lock_key = ? AND owner_token = ?')
            .run(lockKey, ownerToken);
        } catch (err) {
          logger.warn({ err, userId }, 'Cost guardrail SQLite lock release failed');
        }
      };
      return { lockKey, ownerToken, release };
    }
    await sleep(SQLITE_COST_LOCK_POLL_MS);
  }

  throw new Error(`COST_GUARDRAIL_LOCK_TIMEOUT: ${lockKey}`);
}

/** Test-only: drop every in-flight per-user lock. */
export function _resetUserCostLocksForTests(): void {
  // Kept for backwards-compatible tests; SQLite lock rows are released by
  // test DB teardown or explicit release functions.
  activeAiBudgetReservationByRequestId.clear();
}

/**
 * Get daily spend for a specific user (for portal display).
 */
export function getUserDailySpend(userId: number): { totalUsd: number; messageCount: number } {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as count
      FROM api_usage
      WHERE user_id = ?
        AND COALESCE(request_source, 'interactive') <> 'system'
        AND ts >= date('now')
    `).get(userId) as { total: number; count: number };
    return { totalUsd: row.total, messageCount: row.count };
  } catch {
    return { totalUsd: 0, messageCount: 0 };
  }
}

/**
 * Get today's spend breakdown by provider.
 * Returns: { anthropic: number, openai: number, gemini: number }
 */
export function getSpendByProvider(
  date?: string,
  scope: { userId?: number | null; tenantId?: number | null } = {},
): Record<string, number> {
  try {
    const db = getDb();
    // Use parameterized query to prevent SQL injection
    const filterDate = date || new Date().toISOString().slice(0, 10);
    const predicates = ['ts >= date(?)'];
    const params: any[] = [filterDate];
    if (scope.userId != null) {
      predicates.push('user_id = ?');
      params.push(scope.userId);
    }
    if (scope.tenantId != null) {
      predicates.push('tenant_id = ?');
      params.push(scope.tenantId);
    }
    const rows = db.prepare(`
      SELECT COALESCE(provider, 'anthropic') as provider, COALESCE(SUM(cost_usd), 0) as total
      FROM api_usage
      WHERE ${predicates.join(' AND ')}
      GROUP BY provider
    `).all(...params) as { provider: string; total: number }[];

    const result: Record<string, number> = { anthropic: 0, openai: 0, gemini: 0, ollama: 0 };
    for (const row of rows) {
      result[row.provider] = row.total;
    }
    return result;
  } catch {
    return { anthropic: 0, openai: 0, gemini: 0, ollama: 0 };
  }
}
