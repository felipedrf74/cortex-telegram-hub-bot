import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { DateTime } from 'luxon';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
    garmin: { tokenPath: '/tmp' },
  },
}));

import { cookingRoutes } from '../../src/api/routes/cooking';
import { getOrCreateUser } from '../../src/services/user-service';
import { addRecipe, setMealPlan, generateShoppingList } from '../../src/services/cooking-chef';
import { createPlan, createWeek, createSession } from '../../src/services/training-plans';
import { publishHighLegLoad, publishLowSleep } from '../../src/services/training-signals';
import { setDbProvider } from '../../src/services/intelligence-bus';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip incompatible migrations in unit tests */ }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_agent TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_by TEXT NOT NULL DEFAULT '[]',
      user_id INTEGER,
      confidence REAL NOT NULL DEFAULT 0.5,
      format_tag TEXT,
      pillar_tag TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 1
    )
  `);
}

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(userId: number, body?: any): Request {
  return { userId, body } as any;
}

async function dispatch(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  userId: number,
  body?: any,
): Promise<MockRes> {
  const router = cookingRoutes();
  const req = mockReq(userId, body);
  const parsed = new URL(url, 'http://test.local');
  (req as any).method = method;
  (req as any).url = parsed.pathname + parsed.search;
  (req as any).originalUrl = parsed.pathname + parsed.search;
  (req as any).baseUrl = '';
  (req as any).path = parsed.pathname;
  (req as any).query = Object.fromEntries(parsed.searchParams.entries());
  (req as any).params = {};
  (req as any).headers = {};

  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Cooking API — shopping list item updates', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });

  afterEach(() => testDb?.close());

  it('persists checked state for one shopping list item', async () => {
    const user = getOrCreateUser(21001, { username: 'cook' });
    const recipe = addRecipe(user.id, 'Pasta', [
      { name: 'Tomatoes', quantity: '2', unit: 'pcs' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Pasta night', { recipeId: recipe.id });
    generateShoppingList(user.id, '2026-04-13');

    const res = await dispatch('PATCH', '/shopping-list/items/0', user.id, {
      week: '2026-04-13',
      checked: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.list.items[0].name).toBe('Tomatoes');
    expect(res.body.data.list.items[0].checked).toBe(true);
  });

  it('returns 404 when the week has no shopping list', async () => {
    const user = getOrCreateUser(21002, { username: 'cook2' });

    const res = await dispatch('PATCH', '/shopping-list/items/0', user.id, {
      week: '2026-04-13',
      checked: true,
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an out-of-range item index', async () => {
    const user = getOrCreateUser(21003, { username: 'cook3' });
    const recipe = addRecipe(user.id, 'Soup', [
      { name: 'Carrot', quantity: '3', unit: 'pcs' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'lunch', 'Soup lunch', { recipeId: recipe.id });
    generateShoppingList(user.id, '2026-04-13');

    const res = await dispatch('PATCH', '/shopping-list/items/4', user.id, {
      week: '2026-04-13',
      checked: true,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('enriches dinner meals with training-aware adaptation after heavy leg load', async () => {
    const user = getOrCreateUser(21004, { username: 'cook4' });
    const recipe = addRecipe(user.id, 'Chicken bowl', [
      { name: 'Chicken', quantity: '250', unit: 'g' },
    ]);
    const today = DateTime.now().setZone('Europe/Lisbon').toISODate()!;
    setMealPlan(user.id, today, 'dinner', 'Chicken bowl', { recipeId: recipe.id });
    publishHighLegLoad({ userId: user.id, source: 'gym', rpe: 9 });

    const res = await dispatch('GET', `/meal-plan?from=${today}&to=${today}`, user.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.meals).toHaveLength(1);
    expect(res.body.data.meals[0].adaptation).toMatchObject({
      kind: 'protein_up',
      reasonCodes: ['HIGH_LEG_LOAD'],
    });
  });

  it('does not invent meal adaptations without training context', async () => {
    const user = getOrCreateUser(21005, { username: 'cook5' });
    const today = DateTime.now().setZone('Europe/Lisbon').toISODate()!;
    setMealPlan(user.id, today, 'dinner', 'Pasta simples');

    const res = await dispatch('GET', `/meal-plan?from=${today}&to=${today}`, user.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.meals[0].adaptation).toBeNull();
  });

  it('boosts breakfast carbs before a hard session on the same day', async () => {
    const user = getOrCreateUser(21008, { username: 'cook8' });
    const today = DateTime.now().setZone('Europe/Lisbon');
    const todayIso = today.toISODate()!;
    setMealPlan(user.id, todayIso, 'breakfast', 'Aveia com banana');

    const plan = createPlan({
      user_id: user.id,
      name: 'Run plan',
      sport: 'running',
      duration_weeks: 2,
      start_date: today.startOf('week').toISODate()!,
      end_date: today.startOf('week').plus({ weeks: 2, days: 6 }).toISODate()!,
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1 });
    createWeek({ plan_id: plan.id, week_number: 2 });
    createSession({
      week_id: week.id,
      plan_id: plan.id,
      day_of_week: today.toFormat('EEEE'),
      session_type: 'running',
      title: 'Track intervals',
      intensity_text: 'VO2 intervals',
    });

    const res = await dispatch('GET', `/meal-plan?from=${todayIso}&to=${todayIso}`, user.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.meals[0].adaptation).toMatchObject({
      kind: 'carbs_up',
      reasonCodes: ['HARD_SESSION_TODAY'],
    });
  });

  it('marks tomorrow dinner for recovery after a scheduled training day', async () => {
    const user = getOrCreateUser(21009, { username: 'cook9' });
    const now = DateTime.now().setZone('Europe/Lisbon');
    const tomorrow = now.plus({ days: 1 });
    const tomorrowIso = tomorrow.toISODate()!;
    setMealPlan(user.id, tomorrowIso, 'dinner', 'Salmão com legumes');

    const plan = createPlan({
      user_id: user.id,
      name: 'Strength plan',
      sport: 'strength',
      duration_weeks: 2,
      start_date: now.startOf('week').toISODate()!,
      end_date: now.startOf('week').plus({ weeks: 2, days: 6 }).toISODate()!,
    });
    const week1 = createWeek({ plan_id: plan.id, week_number: 1 });
    const week2 = createWeek({ plan_id: plan.id, week_number: 2 });
    const targetWeek = tomorrow.hasSame(now, 'week') ? week1 : week2;
    createSession({
      week_id: targetWeek.id,
      plan_id: plan.id,
      day_of_week: tomorrow.toFormat('EEEE'),
      session_type: 'mobility',
      title: 'Mobility reset',
      intensity_text: 'easy',
    });

    const res = await dispatch('GET', `/meal-plan?from=${tomorrowIso}&to=${tomorrowIso}`, user.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.meals[0].adaptation).toMatchObject({
      kind: 'protein_up',
      reasonCodes: ['TRAINING_TOMORROW'],
    });
  });

  it('falls back to recovery-focused meals after low sleep', async () => {
    const user = getOrCreateUser(21010, { username: 'cook10' });
    const today = DateTime.now().setZone('Europe/Lisbon').toISODate()!;
    setMealPlan(user.id, today, 'lunch', 'Arroz com atum');
    publishLowSleep({ userId: user.id, score: 44, totalHours: 5.2 });

    const res = await dispatch('GET', `/meal-plan?from=${today}&to=${today}`, user.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.meals[0].adaptation).toMatchObject({
      kind: 'recovery',
      reasonCodes: ['LOW_SLEEP'],
    });
  });

  it('groups generated shopping list items with aisle metadata', async () => {
    const user = getOrCreateUser(21006, { username: 'cook6' });
    const recipe = addRecipe(user.id, 'Breakfast bowl', [
      { name: 'Banana', quantity: '2', unit: 'pcs' },
      { name: 'Greek yogurt', quantity: '1', unit: 'cup' },
      { name: 'Olive oil', quantity: '1', unit: 'tbsp' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'breakfast', 'Breakfast bowl', { recipeId: recipe.id });

    const res = await dispatch('POST', '/shopping-list/generate', user.id, {
      week: '2026-04-13',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.list.items).toEqual([
      expect.objectContaining({ name: 'Banana', aisle: 'produce' }),
      expect.objectContaining({ name: 'Greek yogurt', aisle: 'protein' }),
      expect.objectContaining({ name: 'Olive oil', aisle: 'pantry' }),
    ]);
  });

  it('classifies portuguese ingredient names into useful aisles', async () => {
    const user = getOrCreateUser(21007, { username: 'cook7' });
    const recipe = addRecipe(user.id, 'Jantar PT', [
      { name: 'Frango', quantity: '220', unit: 'g' },
      { name: 'Legumes', quantity: '1', unit: 'dose' },
      { name: 'Arroz', quantity: '120', unit: 'g' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Jantar PT', { recipeId: recipe.id });

    const res = await dispatch('POST', '/shopping-list/generate', user.id, {
      week: '2026-04-13',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.list.items).toEqual([
      expect.objectContaining({ name: 'Legumes', aisle: 'produce' }),
      expect.objectContaining({ name: 'Frango', aisle: 'protein' }),
      expect.objectContaining({ name: 'Arroz', aisle: 'pantry' }),
    ]);
  });
});
