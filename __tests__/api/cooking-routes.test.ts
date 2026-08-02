import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request } from 'express';
import { DateTime } from 'luxon';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

let testDb: Database.Database;
const mockCalendarCreateEvent = vi.fn();
const mockIsAnyCalendarConfigured = vi.fn();
const mockHasConnectedCalendarForUser = vi.fn();
const mockGetEventsWithDiagnostics = vi.fn();
const mockInvalidateCookingDerivedCaches = vi.fn();
const mockPreviewCookingMealPrepSchedulingIntent = vi.fn();
const mockSubmitCookingMealPrepSchedulingIntent = vi.fn();
const mockGetWearableReadiness = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
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
  deleteEvent: vi.fn(),
  deduplicateEvents: vi.fn((events: unknown[]) => events),
  eventFingerprint: vi.fn(() => 'event-fingerprint'),
  getConfiguredSources: vi.fn(() => []),
  getEvents: vi.fn(async () => []),
  getEventsWithDiagnostics: (...args: unknown[]) => mockGetEventsWithDiagnostics(...args),
  hasConnectedCalendarForUser: (...args: unknown[]) => mockHasConnectedCalendarForUser(...args),
  hasWritableCalendarForUser: vi.fn(() => false),
  isAnyCalendarConfigured: (...args: unknown[]) => mockIsAnyCalendarConfigured(...args),
  updateEvent: vi.fn(),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateCookingDerivedCaches: (...args: unknown[]) => mockInvalidateCookingDerivedCaches(...args),
}));

vi.mock('../../src/services/cooking-secretary-integration', () => ({
  buildCookingMealPrepSchedulingIntent: (input: any) => ({
    intentId: `cooking:meal-prep:${input.tenantId}:${input.userId}:${input.week}`,
    sourceSkill: 'cooking',
    sourceAction: 'schedule_meal_prep',
    sourceEntityId: input.week,
    sourceEntityType: 'meal_prep_block',
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    title: input.title,
    requestedDurationMinutes: input.durationMinutes,
    preferredWindows: [{ start: input.startIso, end: input.endIso, label: 'meal prep window', hard: true }],
    priority: 'normal',
    flexibility: 'fixed',
  }),
  previewCookingMealPrepSchedulingIntent: (...args: unknown[]) => mockPreviewCookingMealPrepSchedulingIntent(...args),
  submitCookingMealPrepSchedulingIntent: (...args: unknown[]) => mockSubmitCookingMealPrepSchedulingIntent(...args),
}));

vi.mock('../../src/services/wearable/wearable-service', () => ({
  getReadiness: (...args: unknown[]) => mockGetWearableReadiness(...args),
}));

import { cookingRoutes } from '../../src/api/routes/cooking';
import { getOrCreateUser } from '../../src/services/user-service';
import { addRecipe, setMealPlan, generateShoppingList, upsertPantryItem, getRecipeById, getShoppingList, getMealPlan } from '../../src/services/cooking-chef';
import * as cookingChef from '../../src/services/cooking-chef';
import { createPlan, createWeek, createSession } from '../../src/services/training-plans';
import { publishHighLegLoad, publishLowSleep } from '../../src/services/training-signals';
import { setDbProvider } from '../../src/services/intelligence-bus';
import { addTransaction } from '../../src/services/finance-tracker';
import { submitSecretarySchedulingIntent } from '../../src/services/secretary-scheduling-arbitrator';
import { listNotificationCenterItems } from '../../src/services/notification-orchestrator';


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
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
    clearTenantScopeAnomaliesForTests();
    mockCalendarCreateEvent.mockReset();
    mockIsAnyCalendarConfigured.mockReset();
    mockHasConnectedCalendarForUser.mockReset();
    mockGetEventsWithDiagnostics.mockReset();
    mockInvalidateCookingDerivedCaches.mockReset();
    mockPreviewCookingMealPrepSchedulingIntent.mockReset();
    mockSubmitCookingMealPrepSchedulingIntent.mockReset();
    mockGetWearableReadiness.mockReset();
    mockGetWearableReadiness.mockResolvedValue(null);
    mockLoggerWarn.mockReset();
    mockIsAnyCalendarConfigured.mockReturnValue(true);
    mockHasConnectedCalendarForUser.mockReturnValue(true);
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: [], fulfilled: [], failed: [] },
    });
    mockCalendarCreateEvent.mockResolvedValue({
      id: 'evt-meal-prep',
      summary: 'Meal prep — 1 meals',
      start: '2026-04-19T14:00:00.000+01:00',
      end: '2026-04-19T16:00:00.000+01:00',
      source: 'outlook',
      htmlLink: 'https://calendar.example/prep',
    });
    const secretaryDecisionForInput = (input: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      recommendedSlot: { start: input.startIso, end: input.endIso, label: 'meal prep window' },
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
    });
    mockPreviewCookingMealPrepSchedulingIntent.mockImplementation(secretaryDecisionForInput);
    mockSubmitCookingMealPrepSchedulingIntent.mockImplementation(secretaryDecisionForInput);
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

  it('rejects non-string recipe instructions on create without leaking SQLite errors', async () => {
    const user = getOrCreateUser(21020, { username: 'cook20' });

    const res = await dispatch('POST', '/recipes', user.id, {
      title: 'Peanut recovery bowl',
      ingredients: [{ name: 'Peanuts', quantity: '30', unit: 'g' }],
      instructions: ['Cook rice', 'Top with peanuts'],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'instructions must be a string when provided',
    });
  });

  it('accepts empty-string recipe instructions as intentional blank instructions', async () => {
    const user = getOrCreateUser(21022, { username: 'cook22' });

    const created = await dispatch('POST', '/recipes', user.id, {
      title: 'Plain rice',
      ingredients: [{ name: 'Rice', quantity: '100', unit: 'g' }],
      instructions: '',
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.recipe.instructions).toBe('');
  });

  it.each([
    ['boolean', true],
    ['object', {}],
    ['number', 42],
  ])('rejects %s recipe instructions on create', async (_label, instructions) => {
    const user = getOrCreateUser(21023, { username: 'cook23' });

    const res = await dispatch('POST', '/recipes', user.id, {
      title: 'Instruction type probe',
      ingredients: [{ name: 'Rice', quantity: '100', unit: 'g' }],
      instructions,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'instructions must be a string when provided',
    });
  });

  it('rejects non-string recipe instructions on update without leaking SQLite errors', async () => {
    const user = getOrCreateUser(21021, { username: 'cook21' });
    const recipe = addRecipe(user.id, 'Rice bowl', [
      { name: 'Rice', quantity: '100', unit: 'g' },
    ]);

    const res = await dispatch('PATCH', `/recipes/${recipe.id}`, user.id, {
      instructions: ['Unexpected array instruction'],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'instructions must be a string when provided',
    });
  });

  it.each([
    ['boolean', true],
    ['object', {}],
    ['number', 42],
  ])('rejects %s recipe instructions on update', async (_label, instructions) => {
    const user = getOrCreateUser(21024, { username: 'cook24' });
    const recipe = addRecipe(user.id, 'Rice bowl', [
      { name: 'Rice', quantity: '100', unit: 'g' },
    ]);

    const res = await dispatch('PATCH', `/recipes/${recipe.id}`, user.id, {
      instructions,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'instructions must be a string when provided',
    });
  });

  it('handles SQL-shaped recipe titles as data without widening query scope', async () => {
    const user = getOrCreateUser(21025, { username: 'cook25' });
    const title = "Robert'); DROP TABLE recipes; --";

    const created = await dispatch('POST', '/recipes', user.id, {
      title,
      ingredients: [{ name: 'Rice', quantity: '100', unit: 'g' }],
    });
    const listed = await dispatch('GET', '/recipes?search=Robert', user.id);

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.recipe.title).toBe(title);
    expect(listed.statusCode).toBe(200);
    expect(listed.body.data.recipes).toEqual([
      expect.objectContaining({ title }),
    ]);
  });

  it('ignores body-side tenantId spoofing on recipe create and update', async () => {
    const user = getOrCreateUser(21026, { username: 'cook26' });

    const created = await dispatch('POST', '/recipes', user.id, {
      title: 'Tenant-safe bowl',
      ingredients: [{ name: 'Rice', quantity: '100', unit: 'g' }],
      tenantId: 202,
    }, 101);
    const recipeId = created.body.data.recipe.id;
    const updated = await dispatch('PATCH', `/recipes/${recipeId}`, user.id, {
      title: 'Still tenant-safe bowl',
      tenantId: 202,
    }, 101);
    const tenantBRead = await dispatch('GET', `/recipes/${recipeId}`, user.id, undefined, 202);

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.recipe.tenant_id).toBe(101);
    expect(updated.statusCode, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data.recipe.tenant_id).toBe(101);
    expect(tenantBRead.statusCode).toBe(404);
  });

  it('treats prototype-shaped ingredient payloads as data without polluting objects', async () => {
    const user = getOrCreateUser(21027, { username: 'cook27' });
    const ingredient = JSON.parse('{"name":"Rice","quantity":"100","unit":"g","__proto__":{"polluted":true}}');

    const created = await dispatch('POST', '/recipes', user.id, {
      title: 'Prototype probe bowl',
      ingredients: [ingredient],
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(({} as any).polluted).toBeUndefined();
    expect(created.body.data.recipe.ingredients[0].name).toBe('Rice');
  });

  it('handles reasonably oversized recipe text without crashing or leaking internals', async () => {
    const user = getOrCreateUser(21028, { username: 'cook28' });
    const longTitle = `Batch prep ${'x'.repeat(2048)}`;
    const longInstructions = 'Prep safely. '.repeat(500);

    const created = await dispatch('POST', '/recipes', user.id, {
      title: longTitle,
      ingredients: [{ name: 'Rice', quantity: '100', unit: 'g' }],
      instructions: longInstructions,
    });

    expect(created.statusCode, JSON.stringify(created.body).slice(0, 400)).toBe(201);
    expect(created.body.data.recipe.title).toBe(longTitle);
    expect(created.body.data.recipe.instructions).toBe(longInstructions);
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

  it('rejects recipe writes that conflict with stored allergy memory', async () => {
    const user = getOrCreateUser(210181, { username: 'cook18a' });
    await dispatch('POST', '/preferences', user.id, {
      kind: 'allergy',
      value: 'peanuts',
      source: 'chat_correction',
    }, 101);

    const res = await dispatch('POST', '/recipes', user.id, {
      title: 'Peanut noodles',
      ingredients: [
        { name: 'Peanuts', quantity: '30', unit: 'g' },
        { name: 'Noodles', quantity: '100', unit: 'g' },
      ],
    }, 101);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cooking item conflicts with a saved cooking safety preference',
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'COOKING_SAFETY_BLOCKED',
        userId: user.id,
        tenantId: 101,
        route: 'POST /recipes',
        surface: 'recipe',
      }),
      'COOKING_SAFETY_BLOCKED',
    );
    expect(cookingChef.getRecipes(user.id, { tenantId: 101 })).toEqual([]);
  });

  it('logs meal-plan safety blocks with route context', async () => {
    const user = getOrCreateUser(2101811, { username: 'cook18plan' });
    await dispatch('POST', '/preferences', user.id, {
      kind: 'allergy',
      value: 'peanuts',
      source: 'chat_correction',
    }, 101);

    const res = await dispatch('POST', '/meal-plan', user.id, {
      date: '2026-04-13',
      mealType: 'dinner',
      title: 'Peanut noodles',
    }, 101);

    expect(res.statusCode).toBe(400);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'COOKING_SAFETY_BLOCKED',
        userId: user.id,
        tenantId: 101,
        route: 'POST /meal-plan',
        surface: 'meal_plan',
      }),
      'COOKING_SAFETY_BLOCKED',
    );
    expect(cookingChef.getMealPlan(user.id, '2026-04-13', '2026-04-13', 101)).toEqual([]);
  });

  it('rejects substitution actions that would introduce a stored allergy', async () => {
    const user = getOrCreateUser(210182, { username: 'cook18b' });
    const recipe = addRecipe(user.id, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Peanut noodles', { recipeId: recipe.id, tenantId: 101 });
    await dispatch('POST', '/preferences', user.id, {
      kind: 'allergy',
      value: 'almonds',
      source: 'chat_correction',
    }, 101);
    mockInvalidateCookingDerivedCaches.mockClear();

    const res = await dispatch('POST', '/meal-plan/substitutions/apply', user.id, {
      date: '2026-04-13',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      suggestedIngredient: 'Almond butter',
      reason: 'allergy',
    }, 101);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cooking item conflicts with a saved cooking safety preference',
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'COOKING_SAFETY_BLOCKED',
        userId: user.id,
        tenantId: 101,
        route: 'POST /meal-plan/substitutions/apply',
        surface: 'meal_plan_substitution',
      }),
      'COOKING_SAFETY_BLOCKED',
    );
    expect(getRecipeById(user.id, recipe.id, 101)!.ingredients.map((ingredient) => ingredient.name)).toEqual(['Peanuts', 'Noodles']);
    expect(mockInvalidateCookingDerivedCaches).not.toHaveBeenCalled();
  });

  it('suggests scoped substitution candidates without mutating the meal plan', async () => {
    const user = getOrCreateUser(210183, { username: 'cook18c' });
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
    mockInvalidateCookingDerivedCaches.mockClear();

    const res = await dispatch('POST', '/meal-plan/substitutions/suggest', user.id, {
      date: '2026-04-13',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      reason: 'allergy',
      tenantId: 202,
    }, 101);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.count).toBeGreaterThan(0);
    expect(res.body.data.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originalIngredient: 'Peanuts',
        suggestedIngredient: 'sunflower seed butter',
        reason: 'allergy',
      }),
    ]));
    expect(getRecipeById(user.id, recipe.id, 101)!.ingredients.map((ingredient) => ingredient.name)).toEqual(['Peanuts', 'Noodles']);
    expect(mockInvalidateCookingDerivedCaches).not.toHaveBeenCalled();
  });

  it('does not suggest substitutions across tenant scope', async () => {
    const user = getOrCreateUser(210184, { username: 'cook18d' });
    const recipe = addRecipe(user.id, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Peanut noodles', { recipeId: recipe.id, tenantId: 101 });

    const res = await dispatch('POST', '/meal-plan/substitutions/suggest', user.id, {
      date: '2026-04-13',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      reason: 'allergy',
    }, 202);

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('accepts a scoped substitution candidate and refreshes the shopping list', async () => {
    const user = getOrCreateUser(21023, { username: 'cook23' });
    const recipe = addRecipe(user.id, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], {
      tenantId: 101,
      instructions: 'Toss noodles with peanuts.',
    });
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Peanut noodles', {
      recipeId: recipe.id,
      notes: 'Use peanuts if available.',
      tenantId: 101,
    });
    generateShoppingList(user.id, '2026-04-13', 101);

    const res = await dispatch('POST', '/meal-plan/substitutions/apply', user.id, {
      date: '2026-04-13',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      suggestedIngredient: 'sunflower seed butter',
      reason: 'allergy',
      updateShoppingList: true,
      tenantId: 202,
    }, 101);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.substitution).toMatchObject({
      originalIngredient: 'Peanuts',
      suggestedIngredient: 'sunflower seed butter',
      reason: 'allergy',
      sourceRecipeId: recipe.id,
      shoppingListUpdated: true,
    });
    expect(res.body.data.substitution.affectedRecipeId).not.toBe(recipe.id);
    expect(res.body.data.recipe.ingredients).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sunflower seed butter', quantity: '30', unit: 'g' }),
    ]));
    expect(res.body.data.meal.title).toBe('sunflower seed butter noodles');

    const originalRecipe = getRecipeById(user.id, recipe.id, 101)!;
    expect(originalRecipe.title).toBe('Peanut noodles');
    expect(originalRecipe.ingredients.map((ingredient) => ingredient.name)).toEqual(['Peanuts', 'Noodles']);

    const updatedMeal = getMealPlan(user.id, '2026-04-13', '2026-04-13', 101)[0];
    expect(updatedMeal.recipe_id).not.toBe(recipe.id);

    const updatedRecipe = getRecipeById(user.id, updatedMeal.recipe_id!, 101)!;
    expect(updatedRecipe.title).toBe('sunflower seed butter noodles');
    expect(updatedRecipe.instructions).toBe('Toss noodles with sunflower seed butter.');
    expect(updatedRecipe.ingredients.map((ingredient) => ingredient.name)).not.toContain('Peanuts');

    expect(updatedMeal.notes).toBe('Use sunflower seed butter if available.');

    const updatedList = getShoppingList(user.id, '2026-04-13', 101)!;
    expect(updatedList.items.map((item) => item.name)).toContain('sunflower seed butter');
    expect(updatedList.items.map((item) => item.name)).not.toContain('Peanuts');
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(user.id);
  });

  it('does not apply a substitution across tenant scope', async () => {
    const user = getOrCreateUser(21024, { username: 'cook24' });
    const recipe = addRecipe(user.id, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Peanut noodles', { recipeId: recipe.id, tenantId: 101 });

    const res = await dispatch('POST', '/meal-plan/substitutions/apply', user.id, {
      date: '2026-04-13',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      suggestedIngredient: 'sunflower seed butter',
      reason: 'allergy',
    }, 202);

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(getRecipeById(user.id, recipe.id, 101)!.ingredients).toEqual([
      { name: 'Peanuts', quantity: '30', unit: 'g' },
    ]);
    expect(getRecipeById(user.id, recipe.id, 202)).toBeNull();
    expect(mockInvalidateCookingDerivedCaches).not.toHaveBeenCalled();
  });

  it('rejects invalid substitution reasons before mutating Cooking data', async () => {
    const user = getOrCreateUser(21025, { username: 'cook25' });
    const recipe = addRecipe(user.id, 'Mushroom toast', [
      { name: 'Mushrooms', quantity: '1', unit: 'cup' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Mushroom toast', { recipeId: recipe.id });

    const res = await dispatch('POST', '/meal-plan/substitutions/apply', user.id, {
      date: '2026-04-13',
      mealType: 'dinner',
      originalIngredient: 'Mushrooms',
      suggestedIngredient: 'zucchini',
      reason: 'because_i_said_so',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('reason must be');
    expect(getRecipeById(user.id, recipe.id)!.ingredients[0].name).toBe('Mushrooms');
    expect(mockInvalidateCookingDerivedCaches).not.toHaveBeenCalled();
  });

  it('applies Finance budget and Secretary availability context before meal-plan response composition', async () => {
    const user = getOrCreateUser(21019, { username: 'cook19' });
    const recipe = addRecipe(user.id, 'Big dinner prep', [
      { name: 'Chicken', quantity: '500', unit: 'g' },
      { name: 'Rice', quantity: '300', unit: 'g' },
    ], { tenantId: 101, prepTime: 40, cookTime: 40 });
    setMealPlan(user.id, '2026-05-04', 'dinner', 'Big dinner prep', { recipeId: recipe.id, tenantId: 101 });
    addTransaction(user.id, '2026-05-01', 'income', 1000, { currency: 'EUR', tenantId: 101 });
    addTransaction(user.id, '2026-05-02', 'groceries', 900, { currency: 'EUR', tenantId: 101 });
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

  it('does not leak training signals into meal adaptation across tenants', async () => {
    const user = getOrCreateUser(210041, { username: 'cook4tenant' });
    const today = DateTime.now().setZone('Europe/Lisbon').toISODate()!;
    setMealPlan(user.id, today, 'dinner', 'Tenant A chicken bowl', { tenantId: 101 });
    setMealPlan(user.id, today, 'dinner', 'Tenant B chicken bowl', { tenantId: 202 });
    publishHighLegLoad({ userId: user.id, tenantId: 101, source: 'gym', rpe: 9 });

    const tenantA = await dispatch('GET', `/meal-plan?from=${today}&to=${today}`, user.id, undefined, 101);
    const tenantB = await dispatch('GET', `/meal-plan?from=${today}&to=${today}`, user.id, undefined, 202);

    expect(tenantA.statusCode).toBe(200);
    expect(tenantA.body.data.meals[0].adaptation).toMatchObject({
      kind: 'protein_up',
      reasonCodes: ['HIGH_LEG_LOAD'],
    });
    expect(tenantB.statusCode).toBe(200);
    expect(tenantB.body.data.meals[0].adaptation).toBeNull();
  });

  it('suppresses wearable readiness adaptation for non-default tenant scope', async () => {
    const user = getOrCreateUser(210042, { username: 'cook4wearable' });
    const today = DateTime.now().setZone('Europe/Lisbon').toISODate()!;
    mockGetWearableReadiness.mockResolvedValue({ readinessScore: 30 });
    setMealPlan(user.id, today, 'dinner', 'Default tenant dinner', { tenantId: user.id });
    setMealPlan(user.id, today, 'dinner', 'Tenant B dinner', { tenantId: 202 });

    const defaultTenant = await dispatch('GET', `/meal-plan?from=${today}&to=${today}`, user.id);

    expect(defaultTenant.statusCode).toBe(200);
    expect(defaultTenant.body.data.meals[0].adaptation).toMatchObject({
      kind: 'recovery',
      readinessScore: 30,
      reasonCodes: ['LOW_READINESS'],
    });
    expect(mockGetWearableReadiness).toHaveBeenCalledTimes(1);

    mockGetWearableReadiness.mockClear();
    const tenantB = await dispatch('GET', `/meal-plan?from=${today}&to=${today}`, user.id, undefined, 202);

    expect(tenantB.statusCode).toBe(200);
    expect(tenantB.body.data.meals[0].adaptation).toBeNull();
    expect(mockGetWearableReadiness).not.toHaveBeenCalled();
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
      tenant_id: user.id,
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
      tenant_id: user.id,
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
    publishLowSleep({ userId: user.id, tenantId: user.id, score: 44, totalHours: 5.2 });

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
    expect(mockPreviewCookingMealPrepSchedulingIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: user.id,
      tenantId: user.id,
      week: '2026-04-13',
      durationMinutes: 120,
      mealCount: 1,
    }));
    expect(mockSubmitCookingMealPrepSchedulingIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: user.id,
      tenantId: user.id,
      week: '2026-04-13',
      durationMinutes: 120,
      mealCount: 1,
    }));
    expect(mockPreviewCookingMealPrepSchedulingIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mockSubmitCookingMealPrepSchedulingIntent.mock.invocationCallOrder[0]);
    expect(mockSubmitCookingMealPrepSchedulingIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mockCalendarCreateEvent.mock.invocationCallOrder[0]);
    expect(mockCalendarCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(user.id, { includeCalendarSurfaces: true });
    const notifications = listNotificationCenterItems(user.id, user.id, { sourceSkill: 'cooking' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceSkill: 'cooking',
      type: 'reminder',

    });
    // Localized from the account language now; assert the redaction guarantee
    // rather than an English literal.
    expect(notifications[0].safeBody).toEqual(expect.any(String));
    expect(notifications[0].safeBody.length).toBeGreaterThan(0);
  });

  it('checks the authenticated user calendar before creating a meal prep event', async () => {
    const user = getOrCreateUser(21014, { username: 'cook14' });
    const recipe = addRecipe(user.id, 'Prep rice', [
      { name: 'Rice', quantity: '500', unit: 'g' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Prep rice', { recipeId: recipe.id });
    mockHasConnectedCalendarForUser.mockReturnValue(false);
    mockIsAnyCalendarConfigured.mockReturnValue(true);

    const res = await dispatch('POST', '/meal-plan/create-prep-event', user.id, {
      week: '2026-04-13',
      dayOfWeek: 0,
      startHour: 14,
      durationMinutes: 120,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('CALENDAR_NOT_CONFIGURED');
    expect(mockHasConnectedCalendarForUser).toHaveBeenCalledWith(user.id);
    expect(mockCalendarCreateEvent).not.toHaveBeenCalled();
    expect(mockPreviewCookingMealPrepSchedulingIntent).not.toHaveBeenCalled();
  });

  it('fails closed when meal prep scheduling cannot verify live calendar availability', async () => {
    const user = getOrCreateUser(21015, { username: 'cook15' });
    const recipe = addRecipe(user.id, 'Prep beans', [
      { name: 'Beans', quantity: '500', unit: 'g' },
    ]);
    setMealPlan(user.id, '2026-04-13', 'dinner', 'Prep beans', { recipeId: recipe.id });
    mockGetEventsWithDiagnostics.mockResolvedValueOnce({
      events: [],
      status: 'unavailable',
      warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'],
      warnings: ['Outlook Calendar is unavailable right now.'],
      sources: { configured: ['outlook'], fulfilled: [], failed: ['outlook'] },
    });

    const res = await dispatch('POST', '/meal-plan/create-prep-event', user.id, {
      week: '2026-04-13',
      dayOfWeek: 0,
      startHour: 14,
      durationMinutes: 120,
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('COOKING_PREP_CALENDAR_UNAVAILABLE');
    expect(res.body.error.details.warningCodes).toEqual(['OUTLOOK_CALENDAR_UNAVAILABLE']);
    expect(mockPreviewCookingMealPrepSchedulingIntent).not.toHaveBeenCalled();
    expect(mockCalendarCreateEvent).not.toHaveBeenCalled();
  });
});
