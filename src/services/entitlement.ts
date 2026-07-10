// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Canonical entitlement resolver.
 *
 * Feature access and model-backed access are deliberately separate. Free users
 * retain deterministic Secretary surfaces, while every model call must consult
 * aiAccessAllowed/automationAllowed before spending provider tokens.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { isOwnerUserRef } from './user-service';
import {
  type BillingPlan,
  getEffectiveDailyCostLimitUsd,
  getEffectiveMonthlyCostLimitUsd,
  getPlanAllowedSkillsOverride,
} from './plan-quotas';

export type EntitlementSource =
  | 'owner'
  | 'founder'
  | 'apple'
  | 'stripe'
  | 'beta'
  | 'free'
  | 'error';

export type EntitlementStatus = 'active' | 'trialing' | 'past_due' | 'expired' | 'none';

export type AiEntitlementBlockReason =
  | 'plan_required'
  | 'subscription_inactive'
  | 'invalid_billing_period'
  | 'beta_ai_disabled'
  | 'entitlement_error';

export type AiAutomationBlockReason =
  | AiEntitlementBlockReason
  | 'trial_automation_disabled'
  | 'owner_automation_disabled';

export interface UserEntitlement {
  userId: number;
  plan: BillingPlan;
  source: EntitlementSource;
  status: EntitlementStatus;
  /** Raw provider status retained for billing/status compatibility. */
  subscriptionStatus: string | null;
  subscriptionProvider: string | null;
  subscriptionExpiresAt: string | null;
  isFounder: boolean;
  isOwner: boolean;
  isTrial: boolean;
  dailyCostCapUsd: number;
  monthlyCostCapUsd: number;
  /** Inclusive period start and exclusive period end used by quota SQL. */
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  aiAccessAllowed: boolean;
  automationAllowed: boolean;
  nexusPointsAllowed: boolean;
  blockReason: AiEntitlementBlockReason | null;
  automationBlockReason: AiAutomationBlockReason | null;
  allowedSkills: ReadonlySet<string>;
  evaluatedAt: string;
}

/** Token-zero Secretary access remains available on Free. */
export const FREE_TIER_ALLOWED_SKILLS: ReadonlySet<string> = new Set(['secretary']);
/** Product-only compatibility grant; it never implies model eligibility. */
export const BETA_TIER_ALLOWED_SKILLS: ReadonlySet<string> = new Set([
  'secretary',
  'triathlon',
  'training',
  'content',
  'cooking',
  'finance',
]);

function resolveAllowedSkillsForPlan(plan: BillingPlan): ReadonlySet<string> {
  const override = getPlanAllowedSkillsOverride(plan);
  if (override !== undefined) return override;
  if (plan === 'free') return FREE_TIER_ALLOWED_SKILLS;
  if (plan === 'beta') return BETA_TIER_ALLOWED_SKILLS;
  return _UNRESTRICTED;
}

interface SubscriptionRow {
  plan: string | null;
  status: string | null;
  provider: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
}

function calendarMonthWindow(now: Date): { start: string; end: string } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

function parseBillingTimestamp(value: string | null): { milliseconds: number; iso: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const normalizedInput = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const milliseconds = Date.parse(normalizedInput);
  if (!Number.isFinite(milliseconds)) return null;
  return { milliseconds, iso: new Date(milliseconds).toISOString() };
}

function normalizeProviderBillingPeriod(
  sub: SubscriptionRow,
  nowMs: number,
): { start: string; end: string } | null {
  const start = parseBillingTimestamp(sub.current_period_start);
  const end = parseBillingTimestamp(sub.current_period_end);
  if (!start || !end || start.milliseconds >= end.milliseconds || start.milliseconds > nowMs || end.milliseconds <= nowMs) {
    return null;
  }
  return { start: start.iso, end: end.iso };
}

function ownerAutomationsEnabled(): boolean {
  return process.env.OWNER_AI_AUTOMATIONS_ENABLED === 'true';
}

function buildEntitlement(input: {
  userId: number;
  plan: BillingPlan;
  source: EntitlementSource;
  status: EntitlementStatus;
  subscriptionStatus?: string | null;
  subscriptionProvider: string | null;
  subscriptionExpiresAt: string | null;
  isFounder?: boolean;
  isOwner?: boolean;
  isTrial?: boolean;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  aiAccessAllowed: boolean;
  automationAllowed: boolean;
  nexusPointsAllowed: boolean;
  blockReason: AiEntitlementBlockReason | null;
  automationBlockReason: AiAutomationBlockReason | null;
  evaluatedAt: string;
}): UserEntitlement {
  return {
    userId: input.userId,
    plan: input.plan,
    source: input.source,
    status: input.status,
    subscriptionStatus: input.subscriptionStatus ?? null,
    subscriptionProvider: input.subscriptionProvider,
    subscriptionExpiresAt: input.subscriptionExpiresAt,
    isFounder: input.isFounder ?? false,
    isOwner: input.isOwner ?? false,
    isTrial: input.isTrial ?? false,
    dailyCostCapUsd: getEffectiveDailyCostLimitUsd(input.plan),
    monthlyCostCapUsd: getEffectiveMonthlyCostLimitUsd(input.plan),
    billingPeriodStart: input.billingPeriodStart,
    billingPeriodEnd: input.billingPeriodEnd,
    aiAccessAllowed: input.aiAccessAllowed,
    automationAllowed: input.automationAllowed,
    nexusPointsAllowed: input.nexusPointsAllowed,
    blockReason: input.blockReason,
    automationBlockReason: input.automationBlockReason,
    allowedSkills: resolveAllowedSkillsForPlan(input.plan),
    evaluatedAt: input.evaluatedAt,
  };
}

export function getEffectiveEntitlement(userId: number | null | undefined): UserEntitlement {
  const now = new Date();
  const evaluatedAt = now.toISOString();

  if (typeof userId !== 'number' || userId <= 0) {
    return freeEntitlement({ userId: 0, source: 'free', evaluatedAt, blockReason: 'plan_required' });
  }

  let isOwner = false;
  try {
    isOwner = isOwnerUserRef(userId, {
      allowPersistedTier: false,
      requireConfiguredIdentity: true,
    });
  } catch {
    isOwner = false;
  }
  if (isOwner) {
    const month = calendarMonthWindow(now);
    const automationAllowed = ownerAutomationsEnabled();
    return buildEntitlement({
      userId,
      plan: 'owner',
      source: 'owner',
      status: 'active',
      subscriptionStatus: 'active',
      subscriptionProvider: 'owner',
      subscriptionExpiresAt: null,
      isOwner: true,
      billingPeriodStart: month.start,
      billingPeriodEnd: month.end,
      aiAccessAllowed: true,
      automationAllowed,
      nexusPointsAllowed: false,
      blockReason: null,
      automationBlockReason: automationAllowed ? null : 'owner_automation_disabled',
      evaluatedAt,
    });
  }

  let sub: SubscriptionRow | undefined;
  try {
    sub = getDb().prepare(`
      SELECT plan, status, provider, current_period_start, current_period_end
      FROM subscriptions
      WHERE user_id = ?
    `).get(userId) as SubscriptionRow | undefined;
  } catch (err) {
    logger.error({ err, userId }, 'Entitlement resolve failed closed');
    return freeEntitlement({ userId, source: 'error', evaluatedAt, blockReason: 'entitlement_error' });
  }

  const plan = normalizePlan(sub?.plan ?? null);
  const rawStatus = sub?.status ?? null;
  const provider = sub?.provider ?? null;
  const normalizedPeriodEnd = parseBillingTimestamp(sub?.current_period_end ?? null);
  const periodEndMs = normalizedPeriodEnd?.milliseconds ?? NaN;
  const expiredByDate = Number.isFinite(periodEndMs) && periodEndMs <= now.getTime();

  if (sub && provider === 'founder' && rawStatus === 'active' && !expiredByDate && (plan === 'pro' || plan === 'max')) {
    const month = calendarMonthWindow(now);
    return buildEntitlement({
      userId,
      plan,
      source: 'founder',
      status: 'active',
      subscriptionStatus: rawStatus,
      subscriptionProvider: provider,
      subscriptionExpiresAt: normalizedPeriodEnd?.iso ?? null,
      isFounder: true,
      billingPeriodStart: month.start,
      billingPeriodEnd: month.end,
      aiAccessAllowed: true,
      automationAllowed: true,
      nexusPointsAllowed: true,
      blockReason: null,
      automationBlockReason: null,
      evaluatedAt,
    });
  }

  if (sub && (provider === 'apple' || provider === 'stripe') && (plan === 'pro' || plan === 'max')
    && (rawStatus === 'active' || rawStatus === 'trialing')) {
    const billingPeriod = normalizeProviderBillingPeriod(sub, now.getTime());
    const validPeriod = billingPeriod !== null;
    const isTrial = rawStatus === 'trialing';
    return buildEntitlement({
      userId,
      plan,
      source: provider,
      status: isTrial ? 'trialing' : 'active',
      subscriptionStatus: rawStatus,
      subscriptionProvider: provider,
      subscriptionExpiresAt: billingPeriod?.end ?? null,
      isTrial,
      billingPeriodStart: billingPeriod?.start ?? null,
      billingPeriodEnd: billingPeriod?.end ?? null,
      aiAccessAllowed: validPeriod,
      automationAllowed: validPeriod && !isTrial,
      nexusPointsAllowed: validPeriod && !isTrial,
      blockReason: validPeriod ? null : 'invalid_billing_period',
      automationBlockReason: !validPeriod
        ? 'invalid_billing_period'
        : isTrial ? 'trial_automation_disabled' : null,
      evaluatedAt,
    });
  }

  // Historical/manual beta grants retain their legacy paid product surfaces,
  // but never receive provider spend or Nexus Points overage. Keep `plan=beta`
  // as the explicit product-access tier so model eligibility cannot be inferred
  // from a stale Max/Pro plan string. This covers invite-era trial rows plus
  // active portal/manual grants; expired or past-due grants still fall through
  // to Free below.
  const isLegacyBetaOrManualGrant = (rawStatus === 'active' || rawStatus === 'trialing')
    && !expiredByDate
    && (plan === 'pro' || plan === 'max' || plan === 'beta')
    && provider !== 'apple'
    && provider !== 'stripe'
    && provider !== 'founder'
    && (rawStatus === 'trialing' || provider === 'beta' || provider === 'manual' || provider === 'beta_sandbox');
  if (sub && isLegacyBetaOrManualGrant) {
    const month = calendarMonthWindow(now);
    return buildEntitlement({
      userId,
      plan: 'beta',
      source: 'beta',
      status: rawStatus === 'active' ? 'active' : 'trialing',
      subscriptionStatus: rawStatus,
      subscriptionProvider: provider ?? 'beta',
      subscriptionExpiresAt: normalizedPeriodEnd?.iso ?? null,
      billingPeriodStart: month.start,
      billingPeriodEnd: month.end,
      aiAccessAllowed: false,
      automationAllowed: false,
      nexusPointsAllowed: false,
      blockReason: 'beta_ai_disabled',
      automationBlockReason: 'beta_ai_disabled',
      evaluatedAt,
    });
  }

  const status: EntitlementStatus = expiredByDate
    || rawStatus === 'expired'
    || rawStatus === 'canceled'
    ? 'expired'
    : rawStatus === 'past_due' ? 'past_due' : 'none';
  return freeEntitlement({
    userId,
    source: 'free',
    status,
    subscriptionStatus: rawStatus,
    evaluatedAt,
    blockReason: status === 'none' ? 'plan_required' : 'subscription_inactive',
  });
}

export function isAiInteractiveEntitlementEligible(
  entitlement: Pick<UserEntitlement, 'aiAccessAllowed'>,
): boolean {
  return entitlement.aiAccessAllowed;
}

export function isAiAutomationEntitlementEligible(
  entitlement: Pick<UserEntitlement, 'automationAllowed'>,
): boolean {
  return entitlement.automationAllowed;
}

/** Rollout switch: policy is observable before it becomes blocking. */
export function isPaidAiCostControlsEnforcementEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED === 'true';
}

export function isAiInteractiveAllowedForRuntime(
  entitlement: Pick<UserEntitlement, 'aiAccessAllowed'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isPaidAiCostControlsEnforcementEnabled(env)
    || isAiInteractiveEntitlementEligible(entitlement);
}

export function isAiAutomationAllowedForRuntime(
  entitlement: Pick<UserEntitlement, 'automationAllowed'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isPaidAiCostControlsEnforcementEnabled(env)
    || isAiAutomationEntitlementEligible(entitlement);
}

export function isSkillAllowedByEntitlement(entitlement: UserEntitlement, skillId: string): boolean {
  return entitlement.allowedSkills.has(skillId);
}

/** Compatibility helper; new automation code should use isAiAutomationEntitlementEligible. */
export function isCoachBriefingEntitlementEligible(
  entitlement: Pick<UserEntitlement, 'plan' | 'source'>,
): boolean {
  return (entitlement.plan === 'pro' || entitlement.plan === 'max')
    && entitlement.source !== 'beta';
}

export function entitlementPlanToSkillTier(plan: BillingPlan): 'free' | 'pro' | 'max' | 'owner' {
  if (plan === 'owner' || plan === 'max' || plan === 'pro') return plan;
  if (plan === 'beta') return 'max';
  return 'free';
}

function freeEntitlement(opts: {
  userId: number;
  source: EntitlementSource;
  evaluatedAt: string;
  blockReason: AiEntitlementBlockReason;
  status?: EntitlementStatus;
  subscriptionStatus?: string | null;
}): UserEntitlement {
  const month = calendarMonthWindow(new Date(opts.evaluatedAt));
  return buildEntitlement({
    userId: opts.userId,
    plan: 'free',
    source: opts.source,
    status: opts.status ?? 'none',
    subscriptionStatus: opts.subscriptionStatus ?? null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    billingPeriodStart: month.start,
    billingPeriodEnd: month.end,
    aiAccessAllowed: false,
    automationAllowed: false,
    nexusPointsAllowed: false,
    blockReason: opts.blockReason,
    automationBlockReason: opts.blockReason,
    evaluatedAt: opts.evaluatedAt,
  });
}

function normalizePlan(plan: string | null): BillingPlan {
  const lower = (plan ?? '').toLowerCase();
  if (lower === 'pro' || lower === 'max' || lower === 'owner' || lower === 'beta') return lower;
  return 'free';
}

const _UNRESTRICTED: ReadonlySet<string> = {
  has: () => true,
  [Symbol.iterator]: function* () { /* sentinel */ },
  get size() { return Infinity; },
  entries: () => [].values() as any,
  forEach: () => { /* sentinel */ },
  keys: () => [].values() as any,
  values: () => [].values() as any,
} as unknown as ReadonlySet<string>;
