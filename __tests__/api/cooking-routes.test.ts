import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { DateTime } from 'luxon';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const mockCalendarCreateEvent = vi.fn();
const mockIsAnyCalendarConfigured = vi.fn();
const mockInvalidateCookingDerivedCaches = vi.fn();
const mockSubmitCookingMealPrepSchedulingIntent = vi.fn();

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
    financeEncryption: { enabled: false, masterKey: null },
  },
}));

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: (...args: unknown[]) => mockCalendarCreateEvent(...args),
  isAnyCalendarConfigured: (...args: unknown[]) => mockIsAnyCalendarConfigured(...args),
}));

vi.mock('../../src/services/cooking-cache-invalidator', () => ({
  invalidateCookingDerivedCaches: (...args: unknown[]) => mockInvalidateCookingDerivedCaches(...args),
}));

vi.mock('../../src/services/cooking-secretary-integration', () => ({
  submitCookingMealPrepSchedulingIntent: (...args: unknown[]) => mockSubmitCookingMealPrepSchedulingIntent(...args),
}));

import { cookingRoutes } from '../../src/api/routes/cooking';
import { getOrCreateUser } from '../../src/services/user-service';
import { addRecipe, setMealPlan, generateShoppingList, upsertPantryItem } from '../../src/services/cooking-chef';
import * as cookingChef from '../../src/services/cooking-chef';
import { createPlan, createWeek, createSession } from '../../src/services/training-plans';
import { publishHighLegLoad, publishLowSleep } from '../../src/services/training-signals';
import { setDbProvider } from '../../src/services/intelligence-bus';
import { addTransaction } from '../../src/services/finance-tracker';
import { submitSecretarySchedulingIntent } from '../../src/services/secretary-scheduling-arbitrator';

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

function mockReq(userId: number, body?: any, tenantId = userId): Request {
  return { userId, tenantId, body } as any;
}

async function dispatch(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  userId: number,
  body?: any,
  tenantId = userId,
): Promise<MockRes> {
  const router = cookingRoutes();
  const req = mockReq(userId, body, tenantId);
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
    clearTenantScopeAnomaliesForTests();
    mockCalendarCreateEvent.mockReset();
    mockIsAnyCalendarConfigured.mockReset();
    mockInvalidateCookingDerivedCaches.mockReset();
    mockSubmitCookingMealPrepSchedulingIntent.mockReset();
    mockIsAnyCalendarConfigured.mockReturnValue(true);
    mockCalendarCreateEvent.mockResolvedValue({
      id: 'evt-meal-prep',
      summary: 'Meal prep — 1 meals',
      start: '2026-04-19T14:00:00.000+01:00',
      end: '2026-04-19T16:00:00.000+01:00',
      source: 'outlook',
      htmlLink: 'https://calendar.example/prep',
    });
    mockSubmitCookingMealPrepSchedulingIntent.mockImplementation((input: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: { start: input.startIso, end: input.endIso, label: 'meal prep window' },
      agendaItem: { agendaItemId: 'sec-cooking-prep-1' },
      explanation: 'scheduled',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: {
        sourceSkill: 'cooking',
        sourceIntentId: 'cooking-intent',
        agendaItemId: 'sec-cooking-prep-1',
        status: 'scheduled',
        reasonCodes: ['scheduled_in_available_window'],
        scheduledStart: input.startIso,
        scheduledEnd: input.endIso,
        shouldRefreshSource: false,
        downstreamImplications: [],
      },
    }));
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

  it('creates, lists, updates, and deletes pantry items through tenant-scoped APIs', async () => {
    const user = getOrCreateUser(21014, { username: 'cook14' });

    const created = await dispatch('POST', '/pantry/items', user.id, {
      name: 'Greek yogurt',
      quantity: '2',
      unit: 'cups',
      category: 'protein',
      expiresAt: '2099-01-01',
    }, 101);

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.item).toMatchObject({
      name: 'Greek yogurt',
      tenant_id: 101,
      freshness_status: 'fresh',
    });

    const listed = await dispatch('GET', '/pantry', user.id, undefined, 101);
    expect(listed.statusCode).toBe(200);
    expect(listed.body.data.items).toEqual([
      expect.objectContaining({ name: 'Greek yogurt', quantity: '2' }),
    ]);

    const updated = await dispatch('PATCH', `/pantry/items/${created.body.data.item.id}`, user.id, {
      quantity: '3',
      notes: 'For weekday breakfast',
    }, 101);
    expect(updated.statusCode).toBe(200);
    expect(updated.body.data.item).toMatchObject({ quantity: '3', notes: 'For weekday breakfast' });

    const deleted = await dispatch('DELETE', `/pantry/items/${created.body.data.item.id}`, user.id, undefined, 101);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(user.id);
  });

  it('does not expose same-user pantry items across tenants', async () => {
    const user = getOrCreateUser(21015, { username: 'cook15' });
    const item = upsertPantryItem(user.id, { name: 'Tenant A rice' }, 101);

    const tenantBList = await dispatch('GET', '/pantry', user.id, undefined, 202);
    const tenantBFetch = await dispatch('GET', `/pantry/items/${item.id}`, user.id, undefined, 202);
    const tenantBDelete = await dispatch('DELETE', `/pantry/items/${item.id}`, user.id, undefined, 202);

    expect(tenantBList.statusCode).toBe(200);
    expect(tenantBList.body.data.items).toEqual([]);
    expect(tenantBFetch.statusCode).toBe(404);
    expect(tenantBDelete.statusCode).toBe(404);
  });

  it('writes and reads Cooking preference memory through tenant-scoped APIs', async () => {
    const user = getOrCreateUser(21016, { username: 'cook16' });

    const written = await dispatch('POST', '/preferences', user.id, {
      kind: 'weekday_max_prep_minutes',
      value: 45,
      source: 'onboarding',
    }, 101);
    const corrected = await dispatch('POST', '/preferences', user.id, {
      kind: 'weekday_max_prep_minutes',
      value: 20,
      correction: true,
      source: 'chat_correction',
    }, 101);
    const read = await dispatch('GET', '/preferences', user.id, undefined, 101);

    expect(written.statusCode, JSON.stringify(written.body)).toBe(201);
    expect(corrected.statusCode, JSON.stringify(corrected.body)).toBe(201);
    expect(corrected.body.data.memory).toMatchObject({
      memoryKey: 'weekday_max_prep_minutes',
      memoryValue: '20',
      freshnessStatus: 'corrected',
    });
    expect(read.statusCode).toBe(200);
    expect(read.body.data.preferences.profile.weekdayMaxPrepMinutes).toBe(20);
    expect(read.body.data.preferences.summary).toContain('Weekday prep tolerance: 20 minutes');
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(user.id);
  });

  it('does not expose same-user Cooking preference memory across tenants', async () => {
    const user = getOrCreateUser(21017, { username: 'cook17' });

    await dispatch('POST', '/preferences', user.id, {
      kind: 'disliked_ingredient',
      value: 'mushrooms',
    }, 101);
    await dispatch('POST', '/preferences', user.id, {
      kind: 'disliked_ingredient',
      value: 'cilantro',
    }, 202);

    const tenantA = await dispatch('GET', '/preferences', user.id, undefined, 101);
    const tenantB = await dispatch('GET', '/preferences', user.id, undefined, 202);

    expect(tenantA.body.data.preferences.profile.dislikedIngredients).toEqual(['mushrooms']);
    expect(tenantB.body.data.preferences.profile.dislikedIngredients).toEqual(['cilantro']);
  });

  it('applies Cooking allergy preference memory before meal-plan response composition', async () => {
    const user = getOrCreateUser(21018, { username: 'cook18' });
    const recipe = addRecipe(user.id, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Peanut noodles', { recipeId: recipe.id, tenantId: 101 });
    await dispatch('POST', '/preferences', user.id, {
      kind: 'allergy',
      value: 'peanuts',
      source: 'chat_correction',
    }, 101);

    const res = await dispatch('GET', '/meal-plan?from=2026-04-13&to=2026-04-13', user.id, undefined, 101);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.assessment.status).toBe('blocked');
    expect(res.body.data.assessment.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        ingredient: 'Peanuts',
      }),
    ]));
    expect(res.body.data.assessment.substitutionSuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originalIngredient: 'Peanuts',
        suggestedIngredient: 'sunflower seed butter',
        reason: 'allergy',
      }),
    ]));
    expect(res.body.data.preferences.summary).toContain('Allergies: peanuts');
  });

  it('applies Finance budget and Secretary availability context before meal-plan response composition', async () => {
    const user = getOrCreateUser(21019, { username: 'cook19' });
    const recipe = addRecipe(user.id, 'Big dinner prep', [
      { name: 'Chicken', quantity: '500', unit: 'g' },
      { name: 'Rice', quantity: '300', unit: 'g' },
    ], { tenantId: 101, prepTime: 40, cookTime: 40 });
    setMealPlan(user.id, '2026-05-04', 'dinner', 'Big dinner prep', { recipeId: recipe.id, tenantId: 101 });
    addTransaction(user.id, '2026-05-01', 'income', 1000, { currency: 'EUR' });
    addTransaction(user.id, '2026-05-02', 'groceries', 900, { currency: 'EUR' });
    const decision = submitSecretarySchedulingIntent({
      intentId: `secretary:busy:test:${user.id}:101`,
      sourceSkill: 'secretary',
      sourceAction: 'protect_time_for_this',
      sourceEntityId: 'busy-window',
      sourceEntityType: 'calendar_block',
      ownerUserId: user.id,
      tenantId: 101,
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

    const res = await dispatch('GET', '/meal-plan?from=2026-05-04&to=2026-05-04', user.id, undefined, 101);

    expect(decision.status).toBe('scheduled');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.assessment.scheduleFit).toMatchObject({
      status: 'over_capacity',
      overCapacityDates: ['2026-05-04'],
    });
    expect(res.body.data.assessment.budgetFit).toMatchObject({
      status: 'unknown',
      currency: 'EUR',
    });
    expect(res.body.data.assessment.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COOKING_TIME_OVER_CAPACITY', source: 'secretary_schedule_context' }),
      expect.objectContaining({ code: 'FINANCE_BUDGET_TIGHT', source: 'finance_monthly_budget' }),
    ]));
    expect(res.body.data.planningContext.financeBudget).toMatchObject({
      source: 'finance_monthly_budget',
      status: 'available',
      affordability: 'tight',
    });
    expect(res.body.data.planningContext.secretaryAvailability.availableCookingMinutesByDate).toEqual({
      '2026-05-04': 60,
    });
  });

  it('fails closed on invalid tenant scope before loading a meal plan', async () => {
    const res = await dispatch('GET', '/meal-plan?from=2026-04-13&to=2026-04-13', 0);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'cooking_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('does not leak internal exception details on recipe list failures', async () => {
    const user = getOrCreateUser(21011, { username: 'cook11' });
    const spy = vi.spyOn(cookingChef, 'getRecipes').mockImplementation(() => {
      throw new Error('db exploded with vendor path /private/secret');
    });

    const res = await dispatch('GET', '/recipes', user.id);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to fetch recipes');
    expect(JSON.stringify(res.body)).not.toContain('/private/secret');

    spy.mockRestore();
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
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(user.id);
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

  it('normalizes compatible shopping-list units before aggregating quantities', async () => {
    const user = getOrCreateUser(21013, { username: 'cook13' });
    const lunch = addRecipe(user.id, 'Lunch prep', [
      { name: 'Chicken', quantity: '500', unit: 'g' },
      { name: 'Olive oil', quantity: '1', unit: 'tbsp' },
    ]);
    const dinner = addRecipe(user.id, 'Dinner prep', [
      { name: 'Chicken', quantity: '0.5', unit: 'kg' },
      { name: 'Olive oil', quantity: '15', unit: 'ml' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'lunch', 'Lunch prep', { recipeId: lunch.id });
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Dinner prep', { recipeId: dinner.id });

    const res = await dispatch('POST', '/shopping-list/generate', user.id, {
      week: '2026-04-13',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.list.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Chicken', quantity: '1', unit: 'kg' }),
        expect.objectContaining({ name: 'Olive oil', quantity: '30', unit: 'ml' }),
      ]),
    );
  });

  it('invalidates calendar-backed surfaces after creating a meal prep event', async () => {
    const user = getOrCreateUser(21012, { username: 'cook12' });
    const recipe = addRecipe(user.id, 'Prep chicken', [
      { name: 'Chicken', quantity: '500', unit: 'g' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Prep chicken', { recipeId: recipe.id });

    const res = await dispatch('POST', '/meal-plan/create-prep-event', user.id, {
      week: '2026-04-13',
      dayOfWeek: 0,
      startHour: 14,
      durationMinutes: 120,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.agendaItemId).toBe('sec-cooking-prep-1');
    expect(mockSubmitCookingMealPrepSchedulingIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: user.id,
      tenantId: user.id,
      week: '2026-04-13',
      durationMinutes: 120,
      mealCount: 1,
    }));
    expect(mockSubmitCookingMealPrepSchedulingIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mockCalendarCreateEvent.mock.invocationCallOrder[0]);
    expect(mockCalendarCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(user.id, { includeCalendarSurfaces: true });
  });
});
