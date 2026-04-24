// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for the canonical entitlement resolver.
 *
 * These pin the business rules the audit surfaced as mis-enforced:
 *   • Free is the default when nothing privileged applies.
 *   • Founder / Apple / Stripe active subscription → pro or max.
 *   • DB errors fail closed to free (never grant accidental access).
 *   • Free daily cost cap = $0.005 per business rule.
 *   • Free users have only the Secretary skill.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDb = vi.fn();
const mockIsOwnerUserRef = vi.fn<[number], boolean>();

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
}));
vi.mock('../../src/services/user-service', () => ({
  isOwnerUserRef: (...args: [number]) => mockIsOwnerUserRef(...args),
}));

// Import under test AFTER mocks so the mocked modules are resolved.
import {
  getEffectiveEntitlement,
  isSkillAllowedByEntitlement,
  FREE_TIER_ALLOWED_SKILLS,
} from '../../src/services/entitlement';
import {
  FREE_DAILY_COST_CAP_USD,
  _resetPortalOverridesForTests,
  setPlanAllowedSkillsOverride,
  applyPlanConfigRows,
} from '../../src/services/plan-quotas';

function mockSubscriptionRow(row: {
  plan: string | null;
  status: string | null;
  provider: string | null;
  current_period_end?: string | null;
}): void {
  mockGetDb.mockReturnValue({
    prepare: () => ({
      get: () => row,
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
  });

  afterEach(() => {
    mockGetDb.mockReset();
    mockIsOwnerUserRef.mockReset();
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
    expect(ent.subscriptionExpiresAt).toBe('2026-12-31T23:59:59Z');
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
    expect(ent.plan).toBe('max');
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

  it('keeps the beta bypass available in test/dev runtimes without normalizing it as production behavior', async () => {
    process.env.PAYWALL_ENABLED = 'false';
    // Re-import to pick up the env flip — simplest is a fresh require.
    vi.resetModules();
    try {
      const mod = await import('../../src/services/entitlement');
      const ent = mod.getEffectiveEntitlement(99);
      expect(ent.plan).toBe('owner');
      expect(ent.subscriptionProvider).toBe('paywall_disabled');
      expect(ent.dailyCostCapUsd).toBeGreaterThan(FREE_DAILY_COST_CAP_USD);
    } finally {
      // ALWAYS restore — otherwise the leaked env flips subsequent
      // test files in the same worker (observed: cost-guardrail.ts
      // then reports plan='beta' for every user when run after this).
      delete process.env.PAYWALL_ENABLED;
      vi.resetModules();
    }
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
    expect(entFree.dailyCostCapUsd).toBe(0.010);
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
});
