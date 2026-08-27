// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { isAppleValueGrantEnvironmentAllowed } from '../../src/services/apple-value-grant-policy';

describe('Apple value-grant environment policy', () => {
  it('admits Production and rejects missing or unknown environments', () => {
    expect(isAppleValueGrantEnvironmentAllowed('Production', 42, {})).toBe(true);
    expect(isAppleValueGrantEnvironmentAllowed(null, 42, {})).toBe(false);
    expect(isAppleValueGrantEnvironmentAllowed('TestFlight', 42, {})).toBe(false);
  });

  it('admits Sandbox only for the exact configured App Review account', () => {
    expect(isAppleValueGrantEnvironmentAllowed('Sandbox', 42, {
      APPLE_ALLOW_SANDBOX_GRANTS: 'true',
    })).toBe(false);
    expect(isAppleValueGrantEnvironmentAllowed('Sandbox', 42, {
      APPLE_ALLOW_SANDBOX_GRANTS: 'true',
      APPLE_APP_REVIEW_SANDBOX_USER_ID: '7',
    })).toBe(false);
    expect(isAppleValueGrantEnvironmentAllowed('Sandbox', 42, {
      APPLE_ALLOW_SANDBOX_GRANTS: 'true',
      APPLE_APP_REVIEW_SANDBOX_USER_ID: '42',
    })).toBe(true);
  });

  it('fails closed for malformed or multi-account Sandbox configuration', () => {
    for (const reviewUserId of ['42,', '42,99', '0', 'not-a-user']) {
      expect(isAppleValueGrantEnvironmentAllowed('Sandbox', 42, {
        APPLE_ALLOW_SANDBOX_GRANTS: 'true',
        APPLE_APP_REVIEW_SANDBOX_USER_ID: reviewUserId,
      })).toBe(false);
    }
  });

  it('never admits Xcode in production', () => {
    expect(isAppleValueGrantEnvironmentAllowed('Xcode', 42, { NODE_ENV: 'production' })).toBe(false);
    expect(isAppleValueGrantEnvironmentAllowed('Xcode', 42, { NODE_ENV: 'development' })).toBe(true);
  });
});
