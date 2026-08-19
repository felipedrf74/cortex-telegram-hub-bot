// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const entitlementMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: entitlementMock,
}));

import {
  FreeTierCloudInferenceBlockedError,
  _resetFreeTierBindingCacheForTests,
  assertFreeTierCloudDispatchAllowed,
  isFreeTierLocalOnlyBindingEnabled,
  isLocalOnlyBoundPlan,
} from '../../src/services/free-tier-inference-binding';

beforeEach(() => {
  _resetFreeTierBindingCacheForTests();
  entitlementMock.mockReset();
  delete process.env.FREE_TIER_LOCAL_ONLY_ENABLED;
  delete process.env.FREE_TIER_LOCAL_ONLY_KILL_SWITCH;
});

describe('free-tier-inference-binding', () => {
  it('binds exactly the free and beta plans', () => {
    expect(isLocalOnlyBoundPlan('free')).toBe(true);
    expect(isLocalOnlyBoundPlan('beta')).toBe(true);
    expect(isLocalOnlyBoundPlan('pro')).toBe(false);
    expect(isLocalOnlyBoundPlan('max')).toBe(false);
    expect(isLocalOnlyBoundPlan('owner')).toBe(false);
  });

  it('is default OFF and the kill switch always wins', () => {
    expect(isFreeTierLocalOnlyBindingEnabled()).toBe(false);
    process.env.FREE_TIER_LOCAL_ONLY_ENABLED = 'true';
    expect(isFreeTierLocalOnlyBindingEnabled()).toBe(true);
    process.env.FREE_TIER_LOCAL_ONLY_KILL_SWITCH = 'true';
    expect(isFreeTierLocalOnlyBindingEnabled()).toBe(false);
  });

  it('is a no-op while disabled, even for free plans', () => {
    entitlementMock.mockReturnValue({ plan: 'free' });
    expect(() => assertFreeTierCloudDispatchAllowed({ userId: 42, surface: 'test' })).not.toThrow();
    expect(entitlementMock).not.toHaveBeenCalled();
  });

  it('refuses cloud dispatch for a bound account with a retryable capacity error', () => {
    process.env.FREE_TIER_LOCAL_ONLY_ENABLED = 'true';
    entitlementMock.mockReturnValue({ plan: 'free' });
    let caught: unknown;
    try {
      assertFreeTierCloudDispatchAllowed({ userId: 42, surface: 'legacy_chat_cloud_dispatch' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FreeTierCloudInferenceBlockedError);
    const blocked = caught as FreeTierCloudInferenceBlockedError;
    expect(blocked.code).toBe('FREE_TIER_LOCAL_ONLY');
    expect(blocked.httpStatus).toBe(503);
    expect(blocked.retryable).toBe(true);
    expect(blocked.surface).toBe('legacy_chat_cloud_dispatch');
    // Capacity messaging, not an upsell or an internal error.
    expect(blocked.message).toMatch(/local capacity/i);
  });

  it('passes paid plans through and honors a caller-resolved plan', () => {
    process.env.FREE_TIER_LOCAL_ONLY_ENABLED = 'true';
    entitlementMock.mockReturnValue({ plan: 'pro' });
    expect(() => assertFreeTierCloudDispatchAllowed({ userId: 42, surface: 'test' })).not.toThrow();
    expect(() => assertFreeTierCloudDispatchAllowed({ plan: 'max', surface: 'test' })).not.toThrow();
    expect(() => assertFreeTierCloudDispatchAllowed({ plan: 'beta', surface: 'test' }))
      .toThrow(FreeTierCloudInferenceBlockedError);
  });

  it('proceeds without a user identity: system work is never bound', () => {
    process.env.FREE_TIER_LOCAL_ONLY_ENABLED = 'true';
    expect(() => assertFreeTierCloudDispatchAllowed({ surface: 'system' })).not.toThrow();
    expect(entitlementMock).not.toHaveBeenCalled();
  });

  it('memoizes the plan lookup briefly per user', () => {
    process.env.FREE_TIER_LOCAL_ONLY_ENABLED = 'true';
    entitlementMock.mockReturnValue({ plan: 'pro' });
    assertFreeTierCloudDispatchAllowed({ userId: 42, surface: 'test' });
    assertFreeTierCloudDispatchAllowed({ userId: 42, surface: 'test' });
    expect(entitlementMock).toHaveBeenCalledTimes(1);
  });
});
