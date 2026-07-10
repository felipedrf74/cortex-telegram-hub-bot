// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for the canonical entitlement resolver.
 *
 * These pin the business rules the audit surfaced as mis-enforced:
 *   • Free is the default when nothing privileged applies.
 *   • Founder / Apple / Stripe active subscription → pro or max.
 *   • DB errors fail closed to free (never grant accidental access).
 *   • Free model-backed cost cap is zero; Secretary token-zero work remains.
 *   • Free users have only the Secretary skill.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDb = vi.fn();
type OwnerLookupOptions = {
  allowPersistedTier?: boolean;
  requireConfiguredIdentity?: boolean;
};
const mockIsOwnerUserRef = vi.fn<[number, OwnerLookupOptions?], boolean>();

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));
vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service');
  return {
    ...actual,
    isOwnerUserRef: (...args: [number, OwnerLookupOptions?]) => mockIsOwnerUserRef(...args),
  };
});

// Import under test AFTER mocks so the mocked modules are resolved.
import {
  getEffectiveEntitlement,
  isCoachBriefingEntitlementEligible,
  isAiAutomationEntitlementEligible,
  isAiAutomationAllowedForRuntime,
  isAiInteractiveEntitlementEligible,
  isSkillAllowedByEntitlement,
  FREE_TIER_ALLOWED_SKILLS,
} from '../../src/services/entitlement';
import {
  FREE_DAILY_COST_CAP_USD,
  _resetPortalOverridesForTests,
  setPlanAllowedSkillsOverride,
  applyPlanConfigRows,
  setPlanDailyCostCapOverride,
  setPlanMonthlyCostCapOverride,
} from '../../src/services/plan-quotas';

function mockSubscriptionRow(row: {
  plan: string | null;
  status: string | null;
  provider: string | null;
  current_period_end?: string | null;
  current_period_start?: string | null;
  cancel_at_period_end?: number;
}): void {
  const canonicalPaid = row.provider === 'apple' || row.provider === 'stripe';
  mockGetDb.mockReturnValue({
    prepare: () => ({
      get: () => ({
        ...row,
        current_period_start: Object.prototype.hasOwnProperty.call(row, 'current_period_start')
          ? row.current_period_start
          : canonicalPaid ? '2026-01-01T00:00:00.000Z' : null,
        current_period_end: Object.prototype.hasOwnProperty.call(row, 'current_period_end')
          ? row.current_period_end
          : canonicalPaid ? '2026-12-31T23:59:59.000Z' : null,
      }),
    }),
  });
}

function mockNoSubscription(): void {
  mockGetDb.mockReturnValue({
    prepare: () => ({ get: () => undefined }),
  });
}

function mockDbError(): void {
  mockGetDb.mockReturnValue({
    prepare: () => {
      throw new Error('db locked');
    },
  });
}

describe('getEffectiveEntitlement', () => {
  beforeEach(() => {
    _resetPortalOverridesForTests();
    mockIsOwnerUserRef.mockReturnValue(false);
    delete process.env.PAYWALL_ENABLED;
    delete process.env.OWNER_AI_AUTOMATIONS_ENABLED;
  });

  afterEach(() => {
    mockGetDb.mockReset();
    mockIsOwnerUserRef.mockReset();
    delete process.env.OWNER_AI_AUTOMATIONS_ENABLED;
  });

  it('returns free for unauthenticated (userId=0) without hitting the DB', () => {
    const ent = getEffectiveEntitlement(0);
    expect(ent.plan).toBe('free');
    expect(ent.source).toBe('free');
    expect(ent.dailyCostCapUsd).toBe(FREE_DAILY_COST_CAP_USD);
    expect(ent.allowedSkills.has('secretary')).toBe(true);
    // DB must NOT have been called — early return for falsy userId.
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it('returns owner entitlement when isOwnerUserRef is true', () => {
    mockIsOwnerUserRef.mockReturnValue(true);

    const ent = getEffectiveEntitlement(1);
    expect(ent.plan).toBe('owner');
    expect(ent.source).toBe('owner');
    expect(ent.isOwner).toBe(true);
    expect(ent.dailyCostCapUsd).toBeGreaterThan(FREE_DAILY_COST_CAP_USD);
    expect(ent.aiAccessAllowed).toBe(true);
    expect(ent.automationAllowed).toBe(false);
    expect(mockIsOwnerUserRef).toHaveBeenCalledWith(1, {
      allowPersistedTier: false,
      requireConfiguredIdentity: true,
    });
  });

  it('enables owner automations only through the explicit owner flag', () => {
    mockIsOwnerUserRef.mockReturnValue(true);
    process.env.OWNER_AI_AUTOMATIONS_ENABLED = 'true';
    expect(getEffectiveEntitlement(1).automationAllowed).toBe(true);
  });

  it('maps active founder subscription to source=founder with the founder plan', () => {
    mockSubscriptionRow({
      plan: 'max',
      status: 'active',
      provider: 'founder',
      current_period_end: null,
    });

    const ent = getEffectiveEntitlement(42);
    expect(ent.plan).toBe('max');
    expect(ent.source).toBe('founder');
    expect(ent.isFounder).toBe(true);
    expect(ent.subscriptionProvider).toBe('founder');
  });

  it('maps active Apple subscription to source=apple', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'active',
      provider: 'apple',
      current_period_end: '2026-12-31T23:59:59Z',
    });

    const ent = getEffectiveEntitlement(7);
    expect(ent.plan).toBe('pro');
    expect(ent.source).toBe('apple');
    expect(ent.subscriptionExpiresAt).toBe('2026-12-31T23:59:59.000Z');
  });

  it('normalizes valid SQLite billing timestamps to public UTC ISO-8601', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'active',
      provider: 'stripe',
      current_period_start: '2026-01-01 00:00:00',
      current_period_end: '2026-12-31 23:59:59',
    });

    const ent = getEffectiveEntitlement(8);
    expect(ent.aiAccessAllowed).toBe(true);
    expect(ent.billingPeriodStart).toBe('2026-01-01T00:00:00.000Z');
    expect(ent.billingPeriodEnd).toBe('2026-12-31T23:59:59.000Z');
    expect(ent.subscriptionExpiresAt).toBe('2026-12-31T23:59:59.000Z');
  });

  it('maps active Stripe subscription to source=stripe', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'active',
      provider: 'stripe',
      current_period_end: null,
    });

    const ent = getEffectiveEntitlement(7);
    expect(ent.source).toBe('stripe');
    expect(ent.plan).toBe('pro');
  });

  it('treats trialing + non-canonical provider as beta sandbox', () => {
    mockSubscriptionRow({
      plan: 'max',
      status: 'trialing',
      provider: 'beta_sandbox',
      current_period_end: null,
    });

    const ent = getEffectiveEntitlement(12);
    expect(ent.source).toBe('beta');
    expect(ent.plan).toBe('beta');
    expect(ent.aiAccessAllowed).toBe(false);
    expect(ent.automationAllowed).toBe(false);
    expect(isSkillAllowedByEntitlement(ent, 'triathlon')).toBe(true);
    expect(isSkillAllowedByEntitlement(ent, 'content')).toBe(true);
  });

  it('keeps active manual and beta product access while blocking model access', () => {
    for (const provider of ['manual', 'beta']) {
      mockSubscriptionRow({
        plan: 'max',
        status: 'active',
        provider,
        current_period_end: '2026-12-31T23:59:59.000Z',
      });
      const ent = getEffectiveEntitlement(120);
      expect(ent.aiAccessAllowed).toBe(false);
      expect(ent.automationAllowed).toBe(false);
      expect(ent.nexusPointsAllowed).toBe(false);
      expect(ent.plan).toBe('beta');
      expect(ent.status).toBe('active');
      expect(isSkillAllowedByEntitlement(ent, 'triathlon')).toBe(true);
      expect(isSkillAllowedByEntitlement(ent, 'content')).toBe(true);
      expect(isSkillAllowedByEntitlement(ent, 'training')).toBe(true);
    }
  });

  it('keeps an explicit active beta plan as product-only access', () => {
    mockSubscriptionRow({
      plan: 'beta',
      status: 'active',
      provider: 'beta',
      current_period_end: '2026-12-31T23:59:59.000Z',
    });

    const ent = getEffectiveEntitlement(120);
    expect(ent.plan).toBe('beta');
    expect(ent.source).toBe('beta');
    expect(ent.aiAccessAllowed).toBe(false);
    expect(ent.automationAllowed).toBe(false);
    expect(ent.nexusPointsAllowed).toBe(false);
    expect(isSkillAllowedByEntitlement(ent, 'content')).toBe(true);
  });

  it('blocks past-due paid rows even when their billing bounds remain current', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'past_due',
      provider: 'stripe',
    });

    const ent = getEffectiveEntitlement(121);
    expect(ent.status).toBe('past_due');
    expect(ent.aiAccessAllowed).toBe(false);
    expect(ent.nexusPointsAllowed).toBe(false);
  });

  it('keeps cancel-at-period-end subscriptions active until the paid period ends', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'active',
      provider: 'stripe',
      cancel_at_period_end: 1,
    });

    const ent = getEffectiveEntitlement(122);
    expect(ent.aiAccessAllowed).toBe(true);
    expect(ent.automationAllowed).toBe(true);
    expect(ent.nexusPointsAllowed).toBe(true);
  });

  it('fails cancel-at-period-end subscriptions closed after their paid period ends', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'active',
      provider: 'apple',
      cancel_at_period_end: 1,
      current_period_start: '2025-12-01T00:00:00.000Z',
      current_period_end: '2026-01-01T00:00:00.000Z',
    });

    const ent = getEffectiveEntitlement(123);
    expect(ent.aiAccessAllowed).toBe(false);
    expect(ent.automationAllowed).toBe(false);
    expect(ent.nexusPointsAllowed).toBe(false);
    expect(ent.blockReason).toBe('invalid_billing_period');
  });

  it('treats expired beta trial rows as free', () => {
    mockSubscriptionRow({
      plan: 'max',
      status: 'trialing',
      provider: 'beta',
      current_period_end: '2026-01-01T00:00:00.000Z',
    });

    const ent = getEffectiveEntitlement(12);
    expect(ent.source).toBe('free');
    expect(ent.plan).toBe('free');
    expect(ent.status).toBe('expired');
  });

  it('limits coach briefings to Pro/Max paid or founder entitlements', () => {
    expect(isCoachBriefingEntitlementEligible({ plan: 'pro', source: 'stripe' })).toBe(true);
    expect(isCoachBriefingEntitlementEligible({ plan: 'max', source: 'apple' })).toBe(true);
    expect(isCoachBriefingEntitlementEligible({ plan: 'max', source: 'founder' })).toBe(true);
    expect(isCoachBriefingEntitlementEligible({ plan: 'max', source: 'beta' })).toBe(false);
    expect(isCoachBriefingEntitlementEligible({ plan: 'owner', source: 'owner' })).toBe(false);
    expect(isCoachBriefingEntitlementEligible({ plan: 'free', source: 'free' })).toBe(false);
  });

  it('degrades canceled subscription to free with status=expired', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'canceled',
      provider: 'stripe',
      current_period_end: '2026-01-01T00:00:00Z',
    });

    const ent = getEffectiveEntitlement(9);
    expect(ent.plan).toBe('free');
    expect(ent.status).toBe('expired');
    expect(ent.dailyCostCapUsd).toBe(FREE_DAILY_COST_CAP_USD);
  });

  it('returns free when the subscription row is missing', () => {
    mockNoSubscription();

    const ent = getEffectiveEntitlement(11);
    expect(ent.plan).toBe('free');
    expect(ent.source).toBe('free');
  });

  it('fails CLOSED (free) when the DB throws', () => {
    mockDbError();

    const ent = getEffectiveEntitlement(13);
    expect(ent.plan).toBe('free');
    expect(ent.source).toBe('error');
    expect(ent.dailyCostCapUsd).toBe(FREE_DAILY_COST_CAP_USD);
  });

  it('does not grant owner AI globally when a local paywall bypass flag is disabled', async () => {
    process.env.PAYWALL_ENABLED = 'false';
    // Re-import to pick up the env flip — simplest is a fresh require.
    vi.resetModules();
    try {
      const mod = await import('../../src/services/entitlement');
      const ent = mod.getEffectiveEntitlement(99);
      expect(ent.plan).toBe('free');
      expect(ent.aiAccessAllowed).toBe(false);
      expect(ent.isOwner).toBe(false);
    } finally {
      // ALWAYS restore — otherwise the leaked env flips subsequent
      // test files in the same worker (observed: cost-guardrail.ts
      // then reports plan='beta' for every user when run after this).
      delete process.env.PAYWALL_ENABLED;
      vi.resetModules();
    }
  });

  it('fails closed for active paid subscriptions with invalid billing bounds', () => {
    mockSubscriptionRow({
      plan: 'pro',
      status: 'active',
      provider: 'stripe',
      current_period_start: null,
      current_period_end: null,
    });
    const ent = getEffectiveEntitlement(102);
    expect(ent.plan).toBe('pro');
    expect(ent.aiAccessAllowed).toBe(false);
    expect(ent.blockReason).toBe('invalid_billing_period');
  });

  it('allows paid trials interactively but not for automation or Points', () => {
    mockSubscriptionRow({ plan: 'max', status: 'trialing', provider: 'apple' });
    const ent = getEffectiveEntitlement(103);
    expect(isAiInteractiveEntitlementEligible(ent)).toBe(true);
    expect(isAiAutomationEntitlementEligible(ent)).toBe(false);
    expect(ent.nexusPointsAllowed).toBe(false);
  });

  it('keeps runtime enforcement disabled by default and enables paid-only automation explicitly', () => {
    mockNoSubscription();
    const ent = getEffectiveEntitlement(104);
    expect(isAiAutomationAllowedForRuntime(ent, {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isAiAutomationAllowedForRuntime(ent, {
      PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED: 'true',
    } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('isSkillAllowedByEntitlement', () => {
  beforeEach(() => {
    _resetPortalOverridesForTests();
  });

  it('allows Secretary for free users', () => {
    mockNoSubscription();
    mockIsOwnerUserRef.mockReturnValue(false);

    const ent = getEffectiveEntitlement(100);
    expect(ent.plan).toBe('free');
    expect(isSkillAllowedByEntitlement(ent, 'secretary')).toBe(true);
  });

  it('denies every non-Secretary skill for free users', () => {
    mockNoSubscription();
    mockIsOwnerUserRef.mockReturnValue(false);

    const ent = getEffectiveEntitlement(100);
    for (const skill of ['content', 'cooking', 'finance', 'training']) {
      expect(isSkillAllowedByEntitlement(ent, skill)).toBe(false);
    }
  });

  it('allows every skill for paid plans (granular gating lives in skill-tiers.ts)', () => {
    mockSubscriptionRow({ plan: 'pro', status: 'active', provider: 'stripe', current_period_end: null });

    const ent = getEffectiveEntitlement(101);
    expect(ent.plan).toBe('pro');
    for (const skill of ['content', 'cooking', 'finance', 'training']) {
      expect(isSkillAllowedByEntitlement(ent, skill)).toBe(true);
    }
  });
});

describe('FREE_TIER_ALLOWED_SKILLS', () => {
  it('contains exactly Secretary', () => {
    expect(FREE_TIER_ALLOWED_SKILLS.has('secretary')).toBe(true);
    expect(FREE_TIER_ALLOWED_SKILLS.has('content')).toBe(false);
    expect(FREE_TIER_ALLOWED_SKILLS.has('training')).toBe(false);
  });
});

// ── M-4: portal allowed-skills override wiring ────────────────────
//
// Business rule: the admin should be able to broaden or narrow the
// Free tier's allow-list at runtime via the portal's PUT /api/plans/:planId
// endpoint (which persists to `plan_configs.allowed_skills_json` AND
// calls `setPlanAllowedSkillsOverride`). The runtime gate must read
// that override on every request.
describe('portal allowed-skills override (M-4)', () => {
  beforeEach(() => {
    _resetPortalOverridesForTests();
    mockIsOwnerUserRef.mockReturnValue(false);
    mockNoSubscription();
  });

  it('free user gets the portal override list when set (wider than compiled-in)', async () => {
    setPlanAllowedSkillsOverride('free', ['secretary', 'training']);

    const ent = getEffectiveEntitlement(500);
    expect(ent.plan).toBe('free');
    expect(isSkillAllowedByEntitlement(ent, 'secretary')).toBe(true);
    expect(isSkillAllowedByEntitlement(ent, 'training')).toBe(true);   // unlocked by admin
    expect(isSkillAllowedByEntitlement(ent, 'content')).toBe(false);   // NOT in list
  });

  it('free user gets EMPTY access when admin clears the list (pause the plan)', async () => {
    setPlanAllowedSkillsOverride('free', []);

    const ent = getEffectiveEntitlement(501);
    expect(ent.plan).toBe('free');
    // Even Secretary is denied when the admin explicitly zeroes the list.
    expect(isSkillAllowedByEntitlement(ent, 'secretary')).toBe(false);
    expect(isSkillAllowedByEntitlement(ent, 'training')).toBe(false);
  });

  it('falls back to compiled-in rule when override cleared (null)', async () => {
    setPlanAllowedSkillsOverride('free', ['training']);  // wider than default
    setPlanAllowedSkillsOverride('free', null);           // clear

    const ent = getEffectiveEntitlement(502);
    expect(isSkillAllowedByEntitlement(ent, 'secretary')).toBe(true);   // compiled-in
    expect(isSkillAllowedByEntitlement(ent, 'training')).toBe(false);   // no longer granted
  });

  it('paid plans remain UNRESTRICTED when no override is set', () => {
    mockSubscriptionRow({ plan: 'pro', status: 'active', provider: 'stripe', current_period_end: null });
    const ent = getEffectiveEntitlement(503);
    expect(ent.plan).toBe('pro');
    for (const skill of ['content', 'cooking', 'finance', 'training', 'secretary']) {
      expect(isSkillAllowedByEntitlement(ent, skill)).toBe(true);
    }
  });

  it('paid plan can be narrowed by admin override', async () => {
    mockSubscriptionRow({ plan: 'pro', status: 'active', provider: 'stripe', current_period_end: null });
    setPlanAllowedSkillsOverride('pro', ['secretary', 'training']);  // no content/cooking/finance

    const ent = getEffectiveEntitlement(504);
    expect(ent.plan).toBe('pro');
    expect(isSkillAllowedByEntitlement(ent, 'secretary')).toBe(true);
    expect(isSkillAllowedByEntitlement(ent, 'training')).toBe(true);
    expect(isSkillAllowedByEntitlement(ent, 'content')).toBe(false);
    expect(isSkillAllowedByEntitlement(ent, 'finance')).toBe(false);
  });

  it('applyPlanConfigRows hydrates BOTH cost cap and allowed_skills from DB', async () => {
    applyPlanConfigRows([
      { plan_id: 'free', daily_cost_usd: 0.010, allowed_skills_json: '["secretary","training"]' },
      { plan_id: 'pro',  daily_cost_usd: 0.30,  allowed_skills_json: '["secretary","training","content"]' },
    ]);

    const entFree = getEffectiveEntitlement(505);
    expect(entFree.dailyCostCapUsd).toBe(0);
    expect(isSkillAllowedByEntitlement(entFree, 'training')).toBe(true);

    mockSubscriptionRow({ plan: 'pro', status: 'active', provider: 'stripe', current_period_end: null });
    const entPro = getEffectiveEntitlement(506);
    expect(entPro.dailyCostCapUsd).toBe(0.30);
    expect(isSkillAllowedByEntitlement(entPro, 'content')).toBe(true);
    expect(isSkillAllowedByEntitlement(entPro, 'finance')).toBe(false);  // NOT in override
  });

  it('malformed allowed_skills_json leaves compiled-in rule intact (fail-safe)', () => {
    applyPlanConfigRows([
      { plan_id: 'free', daily_cost_usd: 0.005, allowed_skills_json: 'this is not json' },
    ]);

    const ent = getEffectiveEntitlement(507);
    expect(isSkillAllowedByEntitlement(ent, 'secretary')).toBe(true);  // compiled-in rule still applies
    expect(isSkillAllowedByEntitlement(ent, 'training')).toBe(false);
  });

  it('keeps Free and beta model budgets at zero despite stale positive overrides', () => {
    setPlanDailyCostCapOverride('free', 0.5);
    setPlanMonthlyCostCapOverride('free', 5);
    applyPlanConfigRows([
      { plan_id: 'free', daily_cost_usd: 0.5, monthly_cost_usd: 5 },
      { plan_id: 'beta', daily_cost_usd: 0.5, monthly_cost_usd: 5 },
    ]);
    expect(getEffectiveEntitlement(508).dailyCostCapUsd).toBe(0);
    expect(getEffectiveEntitlement(508).monthlyCostCapUsd).toBe(0);

    mockSubscriptionRow({ plan: 'max', status: 'trialing', provider: 'beta' });
    const beta = getEffectiveEntitlement(509);
    expect(beta.plan).toBe('beta');
    expect(beta.dailyCostCapUsd).toBe(0);
    expect(beta.monthlyCostCapUsd).toBe(0);
  });

  it('clears stale paid overrides when corrupt negative plan caps are hydrated', () => {
    applyPlanConfigRows([
      { plan_id: 'pro', daily_cost_usd: 0.5, monthly_cost_usd: 5 },
    ]);
    mockSubscriptionRow({ plan: 'pro', status: 'active', provider: 'stripe' });
    expect(getEffectiveEntitlement(510).dailyCostCapUsd).toBe(0.5);
    expect(getEffectiveEntitlement(510).monthlyCostCapUsd).toBe(5);

    applyPlanConfigRows([
      { plan_id: 'pro', daily_cost_usd: -1, monthly_cost_usd: -30 },
    ]);

    const ent = getEffectiveEntitlement(510);
    expect(ent.dailyCostCapUsd).toBe(0.04);
    expect(ent.monthlyCostCapUsd).toBe(1.2);
  });
});
