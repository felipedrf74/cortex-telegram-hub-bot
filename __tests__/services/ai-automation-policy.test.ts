import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entitlement: {
    source: 'free',
    automationAllowed: false,
    allowedSkills: new Set(['secretary']),
  } as any,
  skillEnabled: true,
}));

vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: vi.fn(() => mocks.entitlement),
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => (
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED === 'true'
  )),
  isAiAutomationAllowedForRuntime: vi.fn((entitlement: any) => (
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED !== 'true'
      || entitlement.automationAllowed === true
  )),
  isSkillAllowedByEntitlement: vi.fn((entitlement: any, skillId: string) => (
    entitlement.allowedSkills.has(skillId)
  )),
}));

vi.mock('../../src/services/user-skill-access', () => ({
  isSkillEnabledForUser: vi.fn(() => mocks.skillEnabled),
}));

import { resolveAiAutomationEligibility } from '../../src/services/ai-automation-policy';

describe('AI automation rollout policy', () => {
  beforeEach(() => {
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
    mocks.skillEnabled = true;
    mocks.entitlement = {
      source: 'free',
      automationAllowed: false,
      allowedSkills: new Set(['secretary']),
    };
  });

  afterEach(() => {
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
  });

  it('preserves existing automation behavior while paid controls are observe-only', () => {
    expect(resolveAiAutomationEligibility(42, 'content')).toMatchObject({
      allowed: true,
      reason: 'eligible',
    });
  });

  it('still honors an explicit Content disable while observe-only', () => {
    mocks.skillEnabled = false;

    expect(resolveAiAutomationEligibility(42, 'content')).toMatchObject({
      allowed: false,
      reason: 'skill_disabled',
    });
  });

  it('blocks Free automation after paid controls are enabled', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';

    expect(resolveAiAutomationEligibility(42, 'content')).toMatchObject({
      allowed: false,
      reason: 'automation_entitlement_required',
    });
  });
});
