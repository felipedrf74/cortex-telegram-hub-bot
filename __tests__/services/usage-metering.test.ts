import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb, closeDatabase } from '../../src/services/database';
import {
  recordUsage,
  getUserUsageToday,
  getUserUsageRange,
  getDailyTotals,
  getUserMessageCountToday,
  resetMeteringStatements,
} from '../../src/services/usage-metering';

describe('usage-metering', () => {
  beforeEach(() => {
    // Re-initialize in-memory DB for each test
    try { closeDatabase(); } catch { /* ignore */ }
    initDatabase();
    resetMeteringStatements();
  });

  describe('recordUsage', () => {
    it('should record a single usage entry', () => {
      recordUsage(123456789, 'secretary', 150, 0.005);

      const usage = getUserUsageToday(123456789);
      expect(usage.total_messages).toBe(1);
      expect(usage.total_tokens).toBe(150);
      expect(usage.total_cost).toBeCloseTo(0.005);
    });

    it('should increment message count on subsequent calls for same user/domain/day', () => {
      recordUsage(123456789, 'secretary', 150, 0.005);
      recordUsage(123456789, 'secretary', 200, 0.008);

      const usage = getUserUsageToday(123456789);
      expect(usage.total_messages).toBe(2);
      expect(usage.total_tokens).toBe(350);
      expect(usage.total_cost).toBeCloseTo(0.013);
    });

    it('should track separate domains independently', () => {
      recordUsage(123456789, 'secretary', 150, 0.005);
      recordUsage(123456789, 'triathlon', 100, 0.002);
      recordUsage(123456789, 'content', 80, 0.001);

      const usage = getUserUsageToday(123456789);
      expect(usage.total_messages).toBe(3);
      expect(usage.by_domain).toHaveLength(3);
      expect(usage.by_domain.find((d) => d.domain === 'secretary')?.messages).toBe(1);
      expect(usage.by_domain.find((d) => d.domain === 'triathlon')?.messages).toBe(1);
      expect(usage.by_domain.find((d) => d.domain === 'content')?.messages).toBe(1);
    });

    it('should track separate users independently', () => {
      recordUsage(111, 'secretary', 150, 0.005);
      recordUsage(222, 'secretary', 200, 0.008);

      const usage1 = getUserUsageToday(111);
      const usage2 = getUserUsageToday(222);
      expect(usage1.total_messages).toBe(1);
      expect(usage2.total_messages).toBe(1);
      expect(usage1.total_tokens).toBe(150);
      expect(usage2.total_tokens).toBe(200);
    });

    it('should not throw on invalid data (non-critical)', () => {
      // recordUsage is designed to swallow errors
      expect(() => recordUsage(0, 'secretary', 0, 0)).not.toThrow();
    });
  });

  describe('getUserUsageToday', () => {
    it('should return empty summary for unknown user', () => {
      const usage = getUserUsageToday(999);
      expect(usage.total_messages).toBe(0);
      expect(usage.total_tokens).toBe(0);
      expect(usage.total_cost).toBe(0);
      expect(usage.by_domain).toHaveLength(0);
    });

    it('should include user_id and period in summary', () => {
      recordUsage(123, 'secretary', 100, 0.003);
      const usage = getUserUsageToday(123);
      expect(usage.user_id).toBe(123);
      expect(usage.period).toBe('today');
    });
  });

  describe('getUserUsageRange', () => {
    it('should return usage for date range', () => {
      // Insert directly to control dates
      const db = getDb();
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(123, '2026-03-28', 'secretary', 5, 1000, 0.05);
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(123, '2026-03-29', 'triathlon', 3, 500, 0.02);
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(123, '2026-04-01', 'secretary', 2, 300, 0.01);

      resetMeteringStatements();
      const usage = getUserUsageRange(123, '2026-03-28', '2026-03-31');
      expect(usage.total_messages).toBe(8);
      expect(usage.total_tokens).toBe(1500);
      expect(usage.by_domain).toHaveLength(2);
    });

    it('should exclude dates outside range', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(123, '2026-03-01', 'secretary', 10, 2000, 0.10);

      resetMeteringStatements();
      const usage = getUserUsageRange(123, '2026-03-28', '2026-04-01');
      expect(usage.total_messages).toBe(0);
    });
  });

  describe('getDailyTotals', () => {
    it('should return daily totals across all users', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(111, '2026-03-30', 'secretary', 5, 1000, 0.05);
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(222, '2026-03-30', 'triathlon', 3, 500, 0.02);
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(111, '2026-03-31', 'content', 2, 300, 0.01);

      resetMeteringStatements();
      const totals = getDailyTotals('2026-03-30', '2026-03-31');
      expect(totals).toHaveLength(2);
      // Ordered DESC by date
      expect(totals[0].date).toBe('2026-03-31');
      expect(totals[0].total_messages).toBe(2);
      expect(totals[1].date).toBe('2026-03-30');
      expect(totals[1].total_messages).toBe(8);
    });

    it('should return empty array for range with no data', () => {
      const totals = getDailyTotals('2026-01-01', '2026-01-31');
      expect(totals).toHaveLength(0);
    });
  });

  describe('getUserMessageCountToday', () => {
    it('should return 0 for unknown user', () => {
      expect(getUserMessageCountToday(999)).toBe(0);
    });

    it('should return total message count across all domains', () => {
      recordUsage(123, 'secretary', 100, 0.003);
      recordUsage(123, 'triathlon', 80, 0.002);
      recordUsage(123, 'secretary', 120, 0.004);

      expect(getUserMessageCountToday(123)).toBe(3);
    });
  });

  describe('upsert behavior', () => {
    it('should accumulate tokens and cost across multiple calls', () => {
      recordUsage(123, 'secretary', 100, 0.003);
      recordUsage(123, 'secretary', 200, 0.006);
      recordUsage(123, 'secretary', 150, 0.004);

      const usage = getUserUsageToday(123);
      const secretary = usage.by_domain.find((d) => d.domain === 'secretary');
      expect(secretary).toBeDefined();
      expect(secretary!.messages).toBe(3);
      expect(secretary!.tokens).toBe(450);
      expect(secretary!.cost).toBeCloseTo(0.013);
    });

    it('should handle high-volume recording', () => {
      for (let i = 0; i < 100; i++) {
        recordUsage(123, 'secretary', 50, 0.001);
      }
      expect(getUserMessageCountToday(123)).toBe(100);
    });
  });
});
