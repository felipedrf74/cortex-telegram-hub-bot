import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

import { addTransaction } from '../../src/services/finance-tracker';
import {
  buildCookingFinanceBudgetContext,
  buildCookingSecretaryAvailabilityContext,
} from '../../src/services/cooking-planning-context';
import { submitSecretarySchedulingIntent } from '../../src/services/secretary-scheduling-arbitrator';

describe('cooking planning context bridge', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('derives a prorated Cooking grocery budget from Finance monthly headroom', () => {
    addTransaction(7, '2026-05-01', 'income', 1000, { tenantId: 70, currency: 'EUR', description: 'creator income' });
    addTransaction(7, '2026-05-03', 'groceries', 900, { tenantId: 70, currency: 'EUR', description: 'prior grocery and bills' });

    const context = buildCookingFinanceBudgetContext({
      userId: 7,
      tenantId: 70,
      from: '2026-05-04',
      to: '2026-05-10',
      timezone: 'Europe/Lisbon',
    });

    expect(context).toMatchObject({
      source: 'finance_monthly_budget',
      status: 'available',
      integrity: 'reliable',
      affordability: 'tight',
      currency: 'EUR',
      monthKeys: ['2026-05'],
    });
    expect(context.budgetLimit).toBeCloseTo(22.58, 2);
  });

  it('converts Secretary agenda pressure into available cooking minutes for the active tenant', () => {
    const decision = submitSecretarySchedulingIntent({
      intentId: 'secretary:busy:test:70:7:2026-05-04',
      sourceSkill: 'secretary',
      sourceAction: 'protect_time_for_this',
      sourceEntityId: 'busy-window',
      sourceEntityType: 'calendar_block',
      ownerUserId: 7,
      tenantId: 70,
      title: 'Client meeting',
      requestedDurationMinutes: 180,
      minimumDurationMinutes: 180,
      preferredWindows: [{
        start: '2026-05-04T17:30:00.000+01:00',
        end: '2026-05-04T20:30:00.000+01:00',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }, { now: '2026-05-01T00:00:00.000Z' });

    const context = buildCookingSecretaryAvailabilityContext({
      userId: 7,
      tenantId: 70,
      from: '2026-05-04',
      to: '2026-05-04',
      timezone: 'Europe/Lisbon',
    });
    const otherTenant = buildCookingSecretaryAvailabilityContext({
      userId: 7,
      tenantId: 71,
      from: '2026-05-04',
      to: '2026-05-04',
      timezone: 'Europe/Lisbon',
    });

    expect(decision.status).toBe('scheduled');
    expect(context.status).toBe('available');
    expect(context.availableCookingMinutesByDate).toEqual({ '2026-05-04': 60 });
    expect(context.busyAgendaItemIdsByDate['2026-05-04']).toEqual([decision.agendaItem.agendaItemId]);
    expect(otherTenant.status).toBe('unknown');
    expect(otherTenant.availableCookingMinutesByDate).toEqual({});
  });
});
