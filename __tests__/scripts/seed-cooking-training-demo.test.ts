import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { databasePath: './data/bot.db' },
  },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!mocks.db) throw new Error('test db not set');
    return mocks.db;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: vi.fn(),
}));

vi.mock('../../src/services/cooking-chef', () => ({
  addRecipe: vi.fn(),
  generateShoppingList: vi.fn(),
  setMealPlan: vi.fn(),
}));

vi.mock('../../src/services/training-plans', () => ({
  createPlan: vi.fn(),
  createSession: vi.fn(),
  createWeek: vi.fn(),
}));

vi.mock('../../src/services/training-signals', () => ({
  publishHighLegLoad: vi.fn(),
}));

import {
  assertDemoSeedAllowed,
  clearUserCookingAndTrainingState,
  parseArgs,
} from '../../scripts/seed-cooking-training-demo';

function createSeedTables(db: Database.Database, includeAgentSignals = true): void {
  db.exec(`
    CREATE TABLE shopping_lists (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL);
    CREATE TABLE meal_plans (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL);
    CREATE TABLE recipes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL);
    CREATE TABLE fitness_training_plans (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL);
    CREATE TABLE training_completions (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL);
    CREATE TABLE training_sessions (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL);
    CREATE TABLE training_weeks (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL);
  `);
  if (includeAgentSignals) {
    db.exec('CREATE TABLE agent_signals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL)');
  }
}

function insertScopedRows(db: Database.Database, userId: number, tenantId: number, planId: number): void {
  db.prepare('INSERT INTO shopping_lists (user_id, tenant_id) VALUES (?, ?)').run(userId, tenantId);
  db.prepare('INSERT INTO meal_plans (user_id, tenant_id) VALUES (?, ?)').run(userId, tenantId);
  db.prepare('INSERT INTO recipes (user_id, tenant_id) VALUES (?, ?)').run(userId, tenantId);
  db.prepare('INSERT INTO agent_signals (user_id, tenant_id) VALUES (?, ?)').run(userId, tenantId);
  db.prepare('INSERT INTO fitness_training_plans (id, user_id, tenant_id) VALUES (?, ?, ?)').run(planId, userId, tenantId);
  db.prepare('INSERT INTO training_completions (plan_id) VALUES (?)').run(planId);
  db.prepare('INSERT INTO training_sessions (plan_id) VALUES (?)').run(planId);
  db.prepare('INSERT INTO training_weeks (plan_id) VALUES (?)').run(planId);
}

function countRows(db: Database.Database, table: string, where = '1=1', params: unknown[] = []): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params) as { count: number }).count;
}

describe('seed-cooking-training-demo', () => {
  afterEach(() => {
    mocks.db?.close();
    mocks.db = null;
  });

  it('requires explicit user and tenant flags', () => {
    expect(() => parseArgs(['node', 'seed', '--user-id', '12'])).toThrow(/--tenant-id/);
    expect(() => parseArgs(['node', 'seed', '--tenant-id', '12'])).toThrow(/--user-id/);
    expect(parseArgs(['node', 'seed', '--user-id', '12', '--tenant-id', '34', '--destructive-demo']))
      .toEqual({ userId: 12, tenantId: 34, destructiveDemo: true });
  });

  it('refuses production or default database targets without destructive confirmation', () => {
    expect(() => assertDemoSeedAllowed(false, './data/bot.db', 'development')).toThrow(/Refusing/);
    expect(() => assertDemoSeedAllowed(false, '/srv/nexus-prod/bot.db', 'development')).toThrow(/Refusing/);
    expect(() => assertDemoSeedAllowed(false, '/tmp/cooking-demo-test.db', 'development')).not.toThrow();
    expect(() => assertDemoSeedAllowed(true, './data/bot.db', 'production')).not.toThrow();
  });

  it('deletes cooking and training demo rows by user and tenant only', () => {
    const db = new Database(':memory:');
    mocks.db = db;
    createSeedTables(db);
    insertScopedRows(db, 1, 101, 10);
    insertScopedRows(db, 1, 202, 20);
    insertScopedRows(db, 2, 101, 30);

    clearUserCookingAndTrainingState(1, 101);

    for (const table of ['shopping_lists', 'meal_plans', 'recipes', 'agent_signals']) {
      expect(countRows(db, table, 'user_id = ? AND tenant_id = ?', [1, 101])).toBe(0);
      expect(countRows(db, table, 'user_id = ? AND tenant_id = ?', [1, 202])).toBe(1);
      expect(countRows(db, table, 'user_id = ? AND tenant_id = ?', [2, 101])).toBe(1);
    }
    expect(countRows(db, 'fitness_training_plans', 'id = ?', [10])).toBe(0);
    expect(countRows(db, 'fitness_training_plans', 'id IN (20, 30)')).toBe(2);
    for (const table of ['training_completions', 'training_sessions', 'training_weeks']) {
      expect(countRows(db, table, 'plan_id = ?', [10])).toBe(0);
      expect(countRows(db, table, 'plan_id IN (20, 30)')).toBe(2);
    }
  });

  it('rolls back destructive deletes when a later delete fails', () => {
    const db = new Database(':memory:');
    mocks.db = db;
    createSeedTables(db, false);
    db.prepare('INSERT INTO shopping_lists (user_id, tenant_id) VALUES (?, ?)').run(1, 101);
    db.prepare('INSERT INTO meal_plans (user_id, tenant_id) VALUES (?, ?)').run(1, 101);
    db.prepare('INSERT INTO recipes (user_id, tenant_id) VALUES (?, ?)').run(1, 101);
    db.prepare('INSERT INTO fitness_training_plans (id, user_id, tenant_id) VALUES (?, ?, ?)').run(10, 1, 101);

    expect(() => clearUserCookingAndTrainingState(1, 101)).toThrow(/agent_signals/);

    expect(countRows(db, 'shopping_lists', 'user_id = ? AND tenant_id = ?', [1, 101])).toBe(1);
    expect(countRows(db, 'meal_plans', 'user_id = ? AND tenant_id = ?', [1, 101])).toBe(1);
    expect(countRows(db, 'recipes', 'user_id = ? AND tenant_id = ?', [1, 101])).toBe(1);
    expect(countRows(db, 'fitness_training_plans', 'id = ?', [10])).toBe(1);
  });
});
