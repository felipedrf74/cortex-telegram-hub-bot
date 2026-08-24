// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => db, initDatabase: vi.fn(), closeDatabase: vi.fn() };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { isCreditPackPurchaseEligible } from '../../src/services/credit-pack-entitlement';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function seedSubscription(input: {
  userId?: number;
  plan?: string;
  status?: string;
  provider?: string;
  start?: string | number | null;
  end?: string | number | null;
} = {}): void {
  const userId = input.userId ?? 40;
  db.prepare(`INSERT INTO users (id, first_name, status) VALUES (?, 'Pack QA', 'active')`).run(userId);
  db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, period, status, provider,
      current_period_start, current_period_end, updated_at
    ) VALUES (?, ?, 'monthly', ?, ?, ?, ?, datetime('now'))
  `).run(
    userId,
    input.plan ?? 'pro',
    input.status ?? 'active',
    input.provider ?? 'apple',
    input.start === undefined ? '2026-08-01T00:00:00.000Z' : input.start,
    input.end === undefined ? '2026-09-01T00:00:00.000Z' : input.end,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = createMigratedTestDatabase();
});

afterEach(() => {
  if (db.open) db.close();
  vi.useRealTimers();
});

describe('credit-pack paid-plan eligibility', () => {
  it('accepts only a current active paid-provider Pro or Max period', () => {
    seedSubscription();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(true);

    db.prepare("UPDATE subscriptions SET status = 'trialing' WHERE user_id = 40").run();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
    db.prepare("UPDATE subscriptions SET status = 'active', provider = 'manual' WHERE user_id = 40").run();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
    db.prepare("UPDATE subscriptions SET provider = 'stripe', plan = 'free' WHERE user_id = 40").run();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
  });

  it('fails closed for historical terminal rows that cannot prove the period was paid', () => {
    seedSubscription({ status: 'canceled', provider: 'stripe' });
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
    vi.setSystemTime(NOW);
    db.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = 40").run();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
    db.prepare("UPDATE subscriptions SET status = 'past_due' WHERE user_id = 40").run();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
  });

  it('accepts active lifetime Founder Pro/Max without synthetic billing-period bounds', () => {
    seedSubscription({ provider: 'founder', start: null, end: null });
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(true);
    db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE user_id = 40").run();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
  });

  it('uses canonical billing timestamp parsing and fails closed on missing or unreadable state', () => {
    seedSubscription({
      start: Math.floor(Date.parse('2026-08-01T00:00:00.000Z') / 1_000),
      end: Date.parse('2026-09-01T00:00:00.000Z'),
    });
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
    expect(isCreditPackPurchaseEligible({ userId: 41 })).toBe(false);

    db.close();
    expect(isCreditPackPurchaseEligible({ userId: 40 })).toBe(false);
  });
});
