// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Free-tier local-only inference binding (plan §1 row 1, NH-0040).
 *
 * When active, accounts on the free (and free-equivalent beta) plan run
 * user-visible AI on local inference only. Cloud dispatch for those accounts
 * is refused with a retryable capacity response — never silently rerouted.
 *
 * Scope contract (matches the plan's routing table):
 * - Binds user-visible generation (chat and skill inference). Platform
 *   classification keeps its own §1 route with a cloud fallback for every
 *   tier, so classify/toolUse system tasks are NOT blocked here.
 * - Scripts and deep reasoning are already unavailable to free plans through
 *   credit-class availability; this binding closes the generation path.
 * - Default OFF until activation: while off, free-plan access rules are
 *   unchanged (entitlement continues to deny model-backed operations).
 */

import { config } from '../config';
import { getEffectiveEntitlement } from './entitlement';

export const FREE_TIER_LOCAL_ONLY_ERROR_CODE = 'FREE_TIER_LOCAL_ONLY' as const;

/** Plans bound to local inference only while the binding is active. */
export function isLocalOnlyBoundPlan(plan: string): boolean {
  return plan === 'free' || plan === 'beta';
}

export function isFreeTierLocalOnlyBindingEnabled(): boolean {
  return config.freeTierLocalInference?.enabled === true;
}

export class FreeTierCloudInferenceBlockedError extends Error {
  readonly code = FREE_TIER_LOCAL_ONLY_ERROR_CODE;
  readonly httpStatus = 503;
  // Retryable to the CLIENT (capacity-style 503: try again shortly), but this
  // is a per-user POLICY decision, never provider-health evidence. The
  // provider-fallback layer must not read this flag as a retryable provider
  // failure — see isFreeTierCloudInferenceBlockedError and the early re-throw
  // in executeWithFallback (QA5 P1-4).
  readonly retryable = true;
  constructor(readonly surface: string) {
    super('Free-plan AI runs on Nexus local capacity only. Please retry shortly.');
    this.name = 'FreeTierCloudInferenceBlockedError';
  }
}

/** True for a free-tier local-only policy refusal, from any module boundary. */
export function isFreeTierCloudInferenceBlockedError(err: unknown): err is FreeTierCloudInferenceBlockedError {
  return err instanceof FreeTierCloudInferenceBlockedError
    || !!(err && typeof err === 'object' && (err as any).code === FREE_TIER_LOCAL_ONLY_ERROR_CODE);
}

// Guards sit on per-call dispatch paths; memoize the plan lookup briefly so
// a burst of provider calls for one user costs one entitlement resolution.
const PLAN_CACHE_TTL_MS = 5_000;
const planCache = new Map<number, { at: number; bound: boolean }>();

export function _resetFreeTierBindingCacheForTests(): void {
  planCache.clear();
}

function isUserLocalOnlyBound(userId: number): boolean {
  const now = Date.now();
  const cached = planCache.get(userId);
  if (cached && now - cached.at < PLAN_CACHE_TTL_MS) return cached.bound;
  const bound = isLocalOnlyBoundPlan(getEffectiveEntitlement(userId).plan);
  if (planCache.size > 512) planCache.clear();
  planCache.set(userId, { at: now, bound });
  return bound;
}

/**
 * Refuse a cloud generation dispatch for a locally-bound account. Callers
 * pass the plan when they already resolved it; otherwise the user id.
 * Without a user identity there is nothing to bind — system work proceeds.
 */
export function assertFreeTierCloudDispatchAllowed(input: {
  userId?: number;
  plan?: string;
  surface: string;
}): void {
  if (!isFreeTierLocalOnlyBindingEnabled()) return;
  const bound = input.plan !== undefined
    ? isLocalOnlyBoundPlan(input.plan)
    : typeof input.userId === 'number' && input.userId > 0 && isUserLocalOnlyBound(input.userId);
  if (bound) {
    throw new FreeTierCloudInferenceBlockedError(input.surface);
  }
}
