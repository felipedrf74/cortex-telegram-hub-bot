// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserById = vi.fn();
const mockGetUserByTelegramId = vi.fn();
const mockGetEffectiveEntitlement = vi.fn();
const mockCheckSkillAccess = vi.fn();

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  getUserByTelegramId: (...args: unknown[]) => mockGetUserByTelegramId(...args),
}));

vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: (...args: unknown[]) => mockGetEffectiveEntitlement(...args),
  entitlementPlanToSkillTier: (plan: string) => (plan === 'beta' ? 'max' : plan),
}));

vi.mock('../../src/services/skill-tiers', () => ({
  checkSkillAccess: (...args: unknown[]) => mockCheckSkillAccess(...args),
}));

import { authorizeChatActionPlanSteps } from '../../src/services/chat/authorization';
import type { ChatPlanStep } from '../../src/services/chat/types';

function step(overrides: Partial<ChatPlanStep>): ChatPlanStep {
  return {
    stepId: 'step-1',
    skill: 'training',
    type: 'training_plan_create',
    action: 'training_plan_create',
    risk: 'safe_write',
    provider: 'nexus',
    args: {},
    requiredArgsPresent: true,
    idempotencyKey: 'idem-1',
    verification: { required: false, method: 'none' },
    ...overrides,
  } as ChatPlanStep;
}

describe('chat action plan authorization', () => {
  beforeEach(() => {
    mockGetUserById.mockReset();
    mockGetUserByTelegramId.mockReset();
    mockGetEffectiveEntitlement.mockReset();
    mockCheckSkillAccess.mockReset();

    mockGetUserById.mockReturnValue({ id: 42, tier: 'free' });
    mockGetUserByTelegramId.mockReturnValue(null);
    mockGetEffectiveEntitlement.mockReturnValue({ plan: 'free' });
    mockCheckSkillAccess.mockImplementation((_user, skillId: string) => ({
      allowed: skillId.startsWith('secretary.'),
      reason: 'catalog',
      userTier: 'free',
      requiredTier: skillId.startsWith('secretary.') ? 'free' : 'pro',
      skillId,
    }));
  });

  it('denies paid planner steps for free-tier users before execution', () => {
    const result = authorizeChatActionPlanSteps({
      userId: 42,
      tenantId: 42,
      steps: [step({ skill: 'training', action: 'training_plan_create', type: 'training_plan_create' })],
    });

    expect(result).toMatchObject({
      allowed: false,
      code: 'TIER_REQUIRED',
      skillId: 'triathlon',
      actionSkill: 'training',
      action: 'training_plan_create',
      userTier: 'free',
      requiredTier: 'pro',
    });
    expect(mockCheckSkillAccess).toHaveBeenCalledWith({ id: 42, tier: 'free' }, 'triathlon');
  });

  it('allows Secretary reminder steps as a free-tier Secretary surface', () => {
    const result = authorizeChatActionPlanSteps({
      userId: 42,
      tenantId: 42,
      steps: [step({ skill: 'secretary_reminders', action: 'set_reminder', type: 'set_reminder' })],
    });

    expect(result).toEqual({ allowed: true });
    expect(mockCheckSkillAccess).toHaveBeenCalledWith({ id: 42, tier: 'free' }, 'secretary.reminders');
  });

  it('checks every step and denies the paid step in a mixed cross-skill plan', () => {
    const result = authorizeChatActionPlanSteps({
      userId: 42,
      tenantId: 42,
      steps: [
        step({ skill: 'secretary_calendar', action: 'schedule_event', type: 'schedule_event' }),
        step({ skill: 'finance', action: 'finance_payment_action', type: 'finance_payment_action' }),
      ],
    });

    expect(result).toMatchObject({
      allowed: false,
      code: 'TIER_REQUIRED',
      skillId: 'finance',
      actionSkill: 'finance',
      action: 'finance_payment_action',
    });
    expect(mockCheckSkillAccess).toHaveBeenNthCalledWith(1, { id: 42, tier: 'free' }, 'secretary.calendar');
    expect(mockCheckSkillAccess).toHaveBeenNthCalledWith(2, { id: 42, tier: 'free' }, 'finance');
  });

  it('fails closed when a step has no canonical entitlement mapping', () => {
    const result = authorizeChatActionPlanSteps({
      userId: 42,
      tenantId: 42,
      steps: [step({ skill: 'unknown_skill' as never })],
    });

    expect(result).toMatchObject({
      allowed: false,
      code: 'ACCESS_CHECK_UNAVAILABLE',
      skillId: 'unknown_skill',
      actionSkill: 'unknown_skill',
      reason: 'unknown_action_skill',
    });
  });
});
