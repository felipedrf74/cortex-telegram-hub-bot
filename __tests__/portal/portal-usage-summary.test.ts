import { describe, expect, it, vi } from 'vitest';
import { buildPortalUsageSummary } from '../../src/portal/usage-summary';

function makeDb() {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('SELECT COUNT(*) as c FROM users')) {
          return { c: 9 };
        }
        if (!sql.includes('COUNT(DISTINCT user_id)')) {
          return null;
        }
        if (sql.includes("date('now', '-30 days')")) {
          return { activeUsers: 7, messages: 70, cost: 12.5, tokens: 7000 };
        }
        if (sql.includes("date('now', '-7 days')")) {
          return { activeUsers: 4, messages: 40, cost: 6.25, tokens: 4000 };
        }
        return { activeUsers: 2, messages: 20, cost: 1.5, tokens: 2000 };
      }),
      all: vi.fn(() => [
        { day: '2026-04-19', cost: 1.25 },
        { day: '2026-04-21', cost: 3.5 },
      ]),
    })),
  };
}

describe('portal usage summary', () => {
  it('builds usage windows, user total, and a padded seven-day sparkline', () => {
    const summary = buildPortalUsageSummary(makeDb(), new Date('2026-04-23T12:00:00Z'));

    expect(summary).toEqual({
      ok: true,
      totalUsers: 9,
      today: { activeUsers: 2, messages: 20, cost: 1.5, tokens: 2000 },
      week: { activeUsers: 4, messages: 40, cost: 6.25, tokens: 4000 },
      month: { activeUsers: 7, messages: 70, cost: 12.5, tokens: 7000 },
      sparkline: [0, 0, 1.25, 0, 3.5, 0, 0],
    });
  });

  it('degrades to zero values when usage tables are unavailable', () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('missing table');
      }),
    };

    const summary = buildPortalUsageSummary(db, new Date('2026-04-23T12:00:00Z'));

    expect(summary).toEqual({
      ok: true,
      totalUsers: 0,
      today: { activeUsers: 0, messages: 0, cost: 0, tokens: 0 },
      week: { activeUsers: 0, messages: 0, cost: 0, tokens: 0 },
      month: { activeUsers: 0, messages: 0, cost: 0, tokens: 0 },
      sparkline: [0, 0, 0, 0, 0, 0, 0],
    });
  });
});

