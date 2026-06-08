// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { entitlementPlanToSkillTier, getEffectiveEntitlement } from '../entitlement';
import { checkSkillAccess } from '../skill-tiers';
import { getUserById } from '../user-service';
import type { ChatActionSkill } from './registry';
import type {
  ChatActionPlan,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatPlannerInput,
  ChatPlanStep,
} from './types';
import { buildActionResponse } from './executor/response-builder';

export type ChatActionAccessDeniedCode = 'TIER_REQUIRED' | 'ACCESS_CHECK_UNAVAILABLE';

export interface ChatActionAuthorizationDenial {
  allowed: false;
  code: ChatActionAccessDeniedCode;
  message: string;
  skillId: string;
  actionSkill: ChatActionSkill;
  action: string;
  userTier?: string;
  requiredTier?: string;
  reason?: string;
}

export type ChatActionAuthorizationResult =
  | { allowed: true }
  | ChatActionAuthorizationDenial;

const CHAT_ACTION_SKILL_ENTITLEMENT: Record<ChatActionSkill, string> = {
  secretary_calendar: 'secretary.calendar',
  secretary_reminders: 'secretary.reminders',
  mail: 'secretary.email',
  tasks: 'secretary.tasks',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

export function entitlementSkillForChatActionSkill(skill: ChatActionSkill): string | null {
  return CHAT_ACTION_SKILL_ENTITLEMENT[skill] ?? null;
}

export function authorizeChatActionPlanSteps(input: {
  userId: number;
  tenantId: number;
  steps: ChatPlanStep[];
}): ChatActionAuthorizationResult {
  const user = getUserById(input.userId);
  if (!user) {
    const first = input.steps[0];
    return {
      allowed: false,
      code: 'ACCESS_CHECK_UNAVAILABLE',
      message: 'Nexus could not verify access for this request. Please reconnect and try again.',
      skillId: first ? entitlementSkillForChatActionSkill(first.skill) ?? first.skill : 'unknown',
      actionSkill: first?.skill ?? 'secretary_calendar',
      action: first?.action ?? 'unknown',
      reason: 'user_not_found',
    };
  }

  try {
    const entitlement = getEffectiveEntitlement(user.id);
    const effectiveUser = { id: user.id, tier: entitlementPlanToSkillTier(entitlement.plan) };
    for (const step of input.steps) {
      const skillId = entitlementSkillForChatActionSkill(step.skill);
      if (!skillId) {
        return {
          allowed: false,
          code: 'ACCESS_CHECK_UNAVAILABLE',
          message: 'Nexus could not verify access for this action. Please try again later.',
          skillId: step.skill,
          actionSkill: step.skill,
          action: step.action,
          reason: 'unknown_action_skill',
        };
      }
      const access = checkSkillAccess(effectiveUser, skillId);
      if (!access.allowed) {
        return {
          allowed: false,
          code: 'TIER_REQUIRED',
          message: `This action requires access to ${skillId}.`,
          skillId,
          actionSkill: step.skill,
          action: step.action,
          userTier: access.userTier,
          requiredTier: access.requiredTier,
          reason: access.reason,
        };
      }
    }
  } catch (err) {
    const first = input.steps[0];
    return {
      allowed: false,
      code: 'ACCESS_CHECK_UNAVAILABLE',
      message: 'Nexus could not verify access for this request. Please try again.',
      skillId: first ? entitlementSkillForChatActionSkill(first.skill) ?? first.skill : 'unknown',
      actionSkill: first?.skill ?? 'secretary_calendar',
      action: first?.action ?? 'unknown',
      reason: err instanceof Error ? err.message : 'access_check_failed',
    };
  }

  return { allowed: true };
}

export function buildChatActionAccessDeniedResponse(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  denial: ChatActionAuthorizationDenial,
): ChatActionRouteResponse {
  const isPT = input.locale?.startsWith('pt');
  const text = denial.code === 'TIER_REQUIRED'
    ? isPT
      ? 'Esta ação precisa de um plano com acesso a esse skill. Nada foi alterado.'
      : 'This action needs a plan with access to that skill. Nothing was changed.'
    : isPT
      ? 'Não consegui verificar o acesso para esta ação. Nada foi alterado.'
      : 'I could not verify access for this action. Nothing was changed.';
  return buildActionResponse(input, plan, 'blocked' as ChatActionStatus, text, {
    type: 'chat_action_access_denied',
    actionStatus: 'blocked',
    error: {
      code: denial.code,
      message: denial.message,
      details: {
        skill: denial.skillId,
        actionSkill: denial.actionSkill,
        action: denial.action,
        userTier: denial.userTier ?? null,
        requiredTier: denial.requiredTier ?? null,
        reason: denial.reason ?? null,
      },
    },
    accessDenied: {
      code: denial.code,
      skill: denial.skillId,
      actionSkill: denial.actionSkill,
      action: denial.action,
      userTier: denial.userTier ?? null,
      requiredTier: denial.requiredTier ?? null,
      reason: denial.reason ?? null,
    },
  });
}
