// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getEffectiveEntitlement,
  isAiAutomationAllowedForRuntime,
  isPaidAiCostControlsEnforcementEnabled,
  isSkillAllowedByEntitlement,
  type UserEntitlement,
} from './entitlement';
import { isSkillEnabledForUser } from './user-skill-access';
import { getDb } from './database';
import { logger } from '../utils/logger';

export type AiAutomationEligibilityReason =
  | 'eligible'
  | 'automation_entitlement_required'
  | 'skill_not_in_plan'
  | 'skill_disabled';

export interface AiAutomationEligibility {
  allowed: boolean;
  reason: AiAutomationEligibilityReason;
  entitlement: UserEntitlement;
}

export interface AiAutomationSkipContext {
  jobName: string;
  baseCategory: string;
  runId?: string | null;
}

const AUTOMATION_SKIP_CODES: Record<Exclude<AiAutomationEligibilityReason, 'eligible'>, string> = {
  automation_entitlement_required: 'AI_AUTOMATION_ENTITLEMENT_REQUIRED',
  skill_not_in_plan: 'AI_SKILL_NOT_IN_PLAN',
  skill_disabled: 'AI_SKILL_DISABLED',
};

/**
 * Canonical background-AI eligibility composition. Entitlement decides who
 * may spend tokens; plan skill grants and explicit per-user/global skill
 * disables decide whether the named automation should run.
 */
export function resolveAiAutomationEligibility(
  userId: number,
  skillId: string,
): AiAutomationEligibility {
  const entitlement = getEffectiveEntitlement(userId);
  // Explicit global/user skill disables predate paid-AI enforcement and must
  // continue to apply during the observe-only rollout.
  if (!isSkillEnabledForUser(userId, skillId)) {
    return { allowed: false, reason: 'skill_disabled', entitlement };
  }
  if (!isPaidAiCostControlsEnforcementEnabled()) {
    return { allowed: true, reason: 'eligible', entitlement };
  }
  if (!isAiAutomationAllowedForRuntime(entitlement)) {
    return { allowed: false, reason: 'automation_entitlement_required', entitlement };
  }
  if (!isSkillAllowedByEntitlement(entitlement, skillId)) {
    return { allowed: false, reason: 'skill_not_in_plan', entitlement };
  }
  return { allowed: true, reason: 'eligible', entitlement };
}

export function isContentAutomationEligible(userId: number): boolean {
  return resolveAiAutomationEligibility(userId, 'content').allowed;
}

/**
 * Persist plan/skill preflight skips for the owner portal. The same reason for
 * the same job is coalesced to one row per UTC day so frequent schedulers do
 * not turn observability into write amplification.
 */
export function recordAiAutomationEligibilitySkip(
  userId: number,
  eligibility: AiAutomationEligibility,
  context: AiAutomationSkipContext,
): void {
  if (eligibility.allowed || eligibility.reason === 'eligible') return;
  const code = AUTOMATION_SKIP_CODES[eligibility.reason];
  try {
    getDb().prepare(`
      INSERT INTO ai_budget_deferrals (
        user_id, request_source, job_name, base_category, run_id,
        code, budget_window, reset_at
      )
      SELECT ?, 'automation', ?, ?, ?, ?, 'plan', NULL
      WHERE NOT EXISTS (
        SELECT 1
          FROM ai_budget_deferrals
         WHERE user_id = ?
           AND request_source = 'automation'
           AND COALESCE(job_name, '') = COALESCE(?, '')
           AND base_category = ?
           AND code = ?
           AND created_at >= datetime('now', 'start of day')
      )
    `).run(
      userId,
      context.jobName,
      context.baseCategory,
      context.runId ?? null,
      code,
      userId,
      context.jobName,
      context.baseCategory,
      code,
    );
  } catch (err) {
    // Observe-only rollout and pre-migration startup must not break a job
    // merely because the additive deferral table is not available yet.
    logger.debug(
      { err, userId, jobName: context.jobName, reason: eligibility.reason },
      'AI automation preflight skip persistence unavailable',
    );
  }
}
