// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * QA5 P0-1: in a LIVE PRODUCTION runtime, a test-mode Stripe key must never
 * be able to mint checkout sessions or settle entitlements — regardless of
 * STRIPE_SANDBOX_CHECKOUT_ALLOWED, which exists for sandbox/staging only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const hoisted = vi.hoisted(() => ({
  stripeConfig: {
    secretKey: 'sk_test_probe',
    webhookSecret: 'whsec_probe',
    managedPaymentsSandboxEnabled: false,
  },
  runtime: { isLiveProduction: false },
}));

vi.mock('stripe', () => ({ default: vi.fn(function StripeMock() { return {}; }) }));

vi.mock('../../src/config', () => ({
  config: {
    stripe: hoisted.stripeConfig,
    ios: { jwtSecret: 'test-ios-jwt-secret-at-least-32-bytes-long' },
    get isLiveProduction() { return hoisted.runtime.isLiveProduction; },
  },
}));

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  assertStripeCheckoutKeyMode,
  isStripeSandboxCheckoutAllowed,
  stripeEventLivemodeMatchesKey,
} from '../../src/services/stripe-service';

beforeEach(() => {
  testDb = new Database(':memory:');
  hoisted.runtime.isLiveProduction = false;
  hoisted.stripeConfig.secretKey = 'sk_test_probe';
  process.env.STRIPE_SANDBOX_CHECKOUT_ALLOWED = 'true';
});

afterEach(() => {
  delete process.env.STRIPE_SANDBOX_CHECKOUT_ALLOWED;
  testDb.close();
});

describe('stripe live-production guards (QA5 P0-1)', () => {
  it('ignores the sandbox hatch in live production so a test key cannot mint checkout', () => {
    // Sandbox/staging: the declared posture still works.
    expect(isStripeSandboxCheckoutAllowed()).toBe(true);
    expect(() => assertStripeCheckoutKeyMode()).not.toThrow();

    // Live production: the flag is inert and the test key is refused.
    hoisted.runtime.isLiveProduction = true;
    expect(isStripeSandboxCheckoutAllowed()).toBe(false);
    expect(() => assertStripeCheckoutKeyMode()).toThrow(/non-live Stripe key/);
  });

  it('still admits a genuine live key in live production', () => {
    hoisted.runtime.isLiveProduction = true;
    hoisted.stripeConfig.secretKey = 'sk_live_probe';
    expect(() => assertStripeCheckoutKeyMode()).not.toThrow();
  });

  it('fails closed on webhook livemode in live production, including a missing boolean', () => {
    hoisted.runtime.isLiveProduction = true;
    // A test-mode event under a test key would previously MATCH and settle.
    expect(stripeEventLivemodeMatchesKey({ livemode: false })).toBe(false);
    // Synthetic fixtures without the flag no longer pass in live production.
    expect(stripeEventLivemodeMatchesKey({})).toBe(false);
    expect(stripeEventLivemodeMatchesKey({ livemode: 'true' as unknown as boolean })).toBe(false);
    // Only a genuine live event settles.
    expect(stripeEventLivemodeMatchesKey({ livemode: true })).toBe(true);
  });

  it('keeps mode-equality semantics outside live production', () => {
    expect(stripeEventLivemodeMatchesKey({ livemode: false })).toBe(true);
    expect(stripeEventLivemodeMatchesKey({ livemode: true })).toBe(false);
    expect(stripeEventLivemodeMatchesKey({})).toBe(true);
  });
});
