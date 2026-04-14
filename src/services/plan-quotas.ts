// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type BillingPlan = 'free' | 'pro' | 'max' | 'owner' | 'beta';
export type UsageLevel = 'none' | 'enhanced' | 'maximum' | 'owner';

const EFFECTIVE_DAILY_COST_LIMITS: Record<BillingPlan, number> = {
  free: 0,
  pro: 0.2,
  max: 0.6,
  owner: 100,
  beta: 100,
};

const STORED_DAILY_COST_LIMITS: Record<'free' | 'pro' | 'max' | 'owner', number> = {
  free: 0,
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
  return EFFECTIVE_DAILY_COST_LIMITS[plan];
}

export function getStoredDailyCostLimitUsdForTier(tier: 'free' | 'pro' | 'max' | 'owner'): number {
  return STORED_DAILY_COST_LIMITS[tier];
}

export function getUsageLevelForPlan(plan: BillingPlan): UsageLevel {
  return PLAN_USAGE_LEVELS[plan];
}
