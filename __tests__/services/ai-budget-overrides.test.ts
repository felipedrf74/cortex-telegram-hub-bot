import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => db,
}));

import {
  getActiveUserAiBudgetOverride,
  setUserAiBudgetOverride,
} from '../../src/services/ai-budget-overrides';

describe('user AI budget monthly override semantics', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE user_ai_budget_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        daily_cost_usd REAL NOT NULL,
        monthly_cost_usd REAL,
        reason TEXT,
        expires_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        updated_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => db.close());

  it('preserves monthly when omitted and clears it only for explicit null', () => {
    setUserAiBudgetOverride({ userId: 7, dailyCostUsd: 0.05, monthlyCostUsd: 1.4 });
    setUserAiBudgetOverride({ userId: 7, dailyCostUsd: 0.06 });
    expect(getActiveUserAiBudgetOverride(7)).toMatchObject({
      dailyCostUsd: 0.06,
      monthlyCostUsd: 1.4,
    });

    setUserAiBudgetOverride({ userId: 7, dailyCostUsd: 0.06, monthlyCostUsd: null });
    expect(getActiveUserAiBudgetOverride(7)).toMatchObject({
      dailyCostUsd: 0.06,
      monthlyCostUsd: null,
    });
  });

  it('normalizes SQLite-space and ISO timestamps before deciding expiry', () => {
    setUserAiBudgetOverride({
      userId: 8,
      dailyCostUsd: 0.05,
      monthlyCostUsd: 1.4,
      expiresAt: '2026-07-09 12:00:00',
    });

    expect(getActiveUserAiBudgetOverride(8, new Date('2026-07-09T11:59:59.000Z'))).not.toBeNull();
    expect(getActiveUserAiBudgetOverride(8, new Date('2026-07-09T12:00:01.000Z'))).toBeNull();
  });
});
