// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cooking routes — token-zero CRUD over the cooking-chef service.
 *
 * Thin HTTP layer over `src/services/cooking-chef.ts`. The service owns
 * all the domain logic (recipes, meal plans, shopping list aggregation);
 * this file just adapts its functions to Express handlers, validates
 * incoming payloads, and returns envelope-formatted responses.
 *
 * Mount point: `/api/v1/cooking`
 *
 * Endpoints:
 *   GET    /recipes                      — list recipes with optional filters
 *   POST   /recipes                      — create a new recipe
 *   GET    /recipes/:id                  — fetch one recipe
 *   PATCH  /recipes/:id                  — update one recipe
 *   DELETE /recipes/:id                  — remove a recipe
 *   GET    /meal-plan?from=&to=          — list meal plan entries in range
 *   POST   /meal-plan                    — upsert one meal plan slot
 *   POST   /meal-plan/substitutions/suggest — suggest scoped substitution candidates
 *   POST   /meal-plan/substitutions/apply — accept a scoped substitution candidate
 *   DELETE /meal-plan?date=&mealType=    — clear one meal plan slot
 *   GET    /shopping-list?week=          — fetch the shopping list for a week
 *   POST   /shopping-list/generate       — (re)generate from the week's meal plan
 *   PATCH  /shopping-list/items/:index   — update one visible item's checked state
 *   GET    /pantry                       — list pantry items
 *   POST   /pantry/items                 — create/update one pantry item
 *   GET    /pantry/items/:id             — fetch one pantry item
 *   PATCH  /pantry/items/:id             — update one pantry item
 *   DELETE /pantry/items/:id             — remove one pantry item
 *   GET    /preferences                  — read Cooking preference memory
 *   POST   /preferences                  — write/correct Cooking preference memory
 *   POST   /meal-plan/create-prep-event  — schedule one scoped prep event
 *
 * These routes are the deterministic backend contract used by Cooking
 * clients; domain validation, safety policy, and tenant isolation remain in
 * the service layer.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import {
  addRecipe,
  getRecipes,
  getRecipeById,
  updateRecipe,
  deleteRecipe,
  setMealPlan,
  applyMealPlanSubstitution,
  suggestMealPlanSubstitutions,
  getMealPlan,
  deleteMealPlan,
  generateShoppingList,
  getShoppingList,
  updateShoppingListItemChecked,
  upsertPantryItem,
  getPantryItems,
  getPantryItemById,
  updatePantryItem,
  deletePantryItem,
  type Ingredient,
  type MealPlan,
  type PantryItemInput,
  type Recipe,
  type CookingSubstitutionReason,
  CookingRecipeDeleteConflictError,
} from '../../services/cooking-chef';
import { assessCookingMealPlan } from '../../services/cooking-intelligence';
import {
  buildCookingFinanceBudgetContext,
  buildCookingSecretaryAvailabilityContext,
  type CookingFinanceBudgetContext,
  type CookingSecretaryAvailabilityContext,
} from '../../services/cooking-planning-context';
import {
  buildCookingPreferenceReadModel,
  isCookingPreferenceKind,
  setCookingPreferenceMemory,
  type CookingPreferenceWriteInput,
} from '../../services/cooking-preferences';
import { hasConnectedCalendarForUser } from '../../services/unified-calendar';
import { getActivePlans, getCurrentWeek, getSessionsForWeek, type TrainingSession } from '../../services/training-plans';
import { invalidateCookingDerivedCaches } from '../../services/cache-coherence-registry';
import {
  buildCookingMealPrepSchedulingIntent,
  previewCookingMealPrepSchedulingIntent,
  submitCookingMealPrepSchedulingIntent,
} from '../../services/cooking-secretary-integration';
import { loadLiveCalendarBusyWindowsForSecretaryIntent } from '../../services/secretary-live-calendar-busy';
import { runOutboxTransaction } from '../../services/event-outbox';
import { consumeResourceBudget } from '../../services/resource-budgets';
import { assertTenantScope } from '../../services/tenant-scope';
import { readTrainingContextAll } from '../../services/training-signals';
import { DateTime } from 'luxon';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { resolveCalendarWritePreference } from '../../services/provider-preferences';
import { createUnifiedCalendarSecretaryProviderAdapter } from '../../services/secretary-unified-calendar-provider-adapter';
import { syncSecretaryAgendaItemsToProvider } from '../../services/secretary-agenda-provider-sync';
import { getSecretaryAgendaItemById } from '../../services/secretary-scheduling-arbitrator';
import { getUserTimezoneById } from '../../services/user-service';

type MealAdaptationKind = 'protein_up' | 'recovery' | 'carbs_up' | 'carbs_down';

interface MealAdaptation {
  kind: MealAdaptationKind;
  reasonCodes: string[];
  readinessScore: number | null;
}

type MealPlanRouteRow = MealPlan & {
  adaptation: MealAdaptation | null;
};

interface CookingTrainingSnapshot {
  hasTrainingContext: boolean;
  todayIso: string;
  tomorrowIso: string;
  readinessScore: number | null;
  lowReadiness: boolean;
  lowSleep: boolean;
  lowHrv: boolean;
  highLegLoad: boolean;
  todayScheduleKnown: boolean;
  todayHasTraining: boolean;
  todayHasHardSession: boolean;
  tomorrowScheduleKnown: boolean;
  tomorrowHasTraining: boolean;
  tomorrowHasHardSession: boolean;
}

function readCookingFinanceBudgetContextSafely(input: {
  userId: number;
  tenantId: number;
  from: string;
  to: string;
}): CookingFinanceBudgetContext {
  try {
    return buildCookingFinanceBudgetContext(input);
  } catch (err) {
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'Cooking Finance budget context unavailable');
    return {
      source: 'finance_monthly_budget',
      status: 'unavailable',
      integrity: null,
      affordability: null,
      budgetLimit: null,
      currency: null,
      monthKeys: [],
      notes: ['Finance budget context is temporarily unavailable.'],
    };
  }
}

function readCookingSecretaryAvailabilityContextSafely(input: {
  userId: number;
  tenantId: number;
  from: string;
  to: string;
}): CookingSecretaryAvailabilityContext {
  try {
    return buildCookingSecretaryAvailabilityContext(input);
  } catch (err) {
    const timezone = getUserTimezoneById(input.userId);
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'Cooking Secretary availability context unavailable');
    return {
      source: 'secretary_agenda_items',
      status: 'unknown',
      defaultCookingWindow: {
        startHour: 17,
        endHour: 21,
        timezone,
      },
      availableCookingMinutesByDate: {},
      busyAgendaItemIdsByDate: {},
      notes: ['Secretary availability context is temporarily unavailable.'],
    };
  }
}

function sendCookingInternalError(
  res: Response,
  opts: {
    err: unknown;
    userId: number;
    operation: string;
    message: string;
    extra?: Record<string, unknown>;
  },
): void {
  logger.error({ err: opts.err, userId: opts.userId, ...(opts.extra ?? {}) }, opts.operation);
  sendError(res, 'INTERNAL', opts.message, 500);
}

function sendCookingScopeConflictIfNeeded(res: Response, err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  if (!message.startsWith('COOKING_SCOPE_CONFLICT')) return false;
  sendError(res, 'FORBIDDEN', 'Cooking resource belongs to a different tenant scope', 403);
  return true;
}

function sendCookingPreferenceErrorIfNeeded(res: Response, err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  if (!message.startsWith('COOKING_PREFERENCE') && !message.startsWith('SKILL_MEMORY')) return false;
  const status = message.includes('SCOPE') ? 403 : 400;
  sendError(res, status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST', message, status);
  return true;
}

function sendCookingInputErrorIfNeeded(res: Response, err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  if (message.startsWith('COOKING_PANTRY_INVALID_EXPIRY')) {
    sendError(res, 'BAD_REQUEST', 'expiresAt must be a valid YYYY-MM-DD date', 400);
    return true;
  }
  if (message.startsWith('COOKING_PANTRY_INVALID')) {
    sendError(res, 'BAD_REQUEST', message.replace(/^COOKING_PANTRY_INVALID_[A-Z_]+:\s*/, ''), 400);
    return true;
  }
  if (message.startsWith('COOKING_MEAL_PLAN_RECIPE_NOT_FOUND')) {
    sendError(res, 'BAD_REQUEST', 'recipeId must reference an active recipe in the current tenant scope', 400);
    return true;
  }
  if (message.startsWith('COOKING_RECIPE_INVALID')) {
    sendError(res, 'BAD_REQUEST', message, 400);
    return true;
  }
  if (message.startsWith('COOKING_MEAL_PLAN_INVALID')) {
    sendError(res, 'BAD_REQUEST', message, 400);
    return true;
  }
  if (message.startsWith('COOKING_SUBSTITUTION_INVALID')) {
    sendError(res, 'BAD_REQUEST', message, 400);
    return true;
  }
  if (message.startsWith('COOKING_SHOPPING_LIST_INVALID_WEEK_START')) {
    sendError(res, 'BAD_REQUEST', 'week must be a valid Monday in YYYY-MM-DD format', 400);
    return true;
  }
  if (message.startsWith('COOKING_SHOPPING_LIST_INVALID_WEEK_DATE')) {
    sendError(res, 'BAD_REQUEST', 'week must be a valid YYYY-MM-DD date', 400);
    return true;
  }
  return false;
}

function sendCookingSafetyErrorIfNeeded(
  res: Response,
  err: unknown,
  context?: { userId?: number; tenantId?: number; route?: string; surface?: string },
): boolean {
  const message = err instanceof Error ? err.message : '';
  if (!message.startsWith('COOKING_SAFETY_BLOCKED')) return false;
  logger.warn(
    {
      event: 'COOKING_SAFETY_BLOCKED',
      userId: context?.userId,
      tenantId: context?.tenantId,
      route: context?.route,
      surface: context?.surface,
    },
    'COOKING_SAFETY_BLOCKED',
  );
  sendError(res, 'BAD_REQUEST', 'Cooking item conflicts with a saved cooking safety preference', 400);
  return true;
}

function parseStrictRouteInteger(value: unknown, minimum: number): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function parseBoundedRouteLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseStrictRouteInteger(value, 1);
  return parsed === null ? fallback : Math.min(parsed, maximum);
}

function isValidNutritionField(value: unknown): value is number | null | undefined {
  return value === undefined
    || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isValidIngredient(value: unknown): value is Ingredient {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ingredient = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(ingredient, 'name')
    && Object.prototype.hasOwnProperty.call(ingredient, 'quantity')
    && Object.prototype.hasOwnProperty.call(ingredient, 'unit')
    && typeof ingredient.name === 'string'
    && ingredient.name.trim().length > 0
    && typeof ingredient.quantity === 'string'
    && typeof ingredient.unit === 'string';
}

function isValidIngredientList(value: unknown): value is Ingredient[] {
  if (!Array.isArray(value)) return false;
  for (const ingredient of value) {
    if (!isValidIngredient(ingredient)) return false;
  }
  return true;
}

function isCookingSubstitutionReason(value: unknown): value is CookingSubstitutionReason {
  return value === 'allergy'
    || value === 'dietary_restriction'
    || value === 'disliked_ingredient'
    || value === 'expired_pantry';
}

function isHardTrainingSession(session: TrainingSession): boolean {
  const haystack = [
    session.session_type,
    session.title,
    session.intensity_text ?? '',
    session.description ?? '',
  ]
    .join(' ')
    .toLowerCase();

  return [
    'hard',
    'interval',
    'tempo',
    'threshold',
    'vo2',
    'brick',
    'long run',
    'long ride',
    'race pace',
    'heavy',
    'strength',
    'leg day',
  ].some((token) => haystack.includes(token));
}

function buildCookingLocalTrainingSnapshot(opts: { userId: number; tenantId: number }): CookingTrainingSnapshot {
  const { userId, tenantId } = opts;
  const zone = getUserTimezoneById(userId);
  const now = DateTime.now().setZone(zone);
  const tomorrow = now.plus({ days: 1 });
  const todayIso = now.toISODate() ?? DateTime.now().toISODate() ?? '';
  const tomorrowIso = tomorrow.toISODate() ?? todayIso;
  const todayName = now.toFormat('EEEE');
  const tomorrowName = tomorrow.toFormat('EEEE');

  const activePlans = getActivePlans(userId, tenantId);
  const inactiveSessionStatuses = new Set(['rest', 'skipped', 'unscheduled', 'deferred', 'dropped', 'cancelled', 'superseded']);
  const scheduleForDay = (target: DateTime, dayName: string): { known: boolean; sessions: TrainingSession[] } => {
    const targetDate = target.toISODate();
    if (!targetDate) return { known: false, sessions: [] };
    let known = false;
    const sessions: TrainingSession[] = [];
    for (const plan of activePlans) {
      if (targetDate < plan.start_date || targetDate > plan.end_date) continue;
      const week = getCurrentWeek(plan.id, { now: target.toJSDate(), timezone: zone });
      if (!week) continue;
      known = true;
      sessions.push(...getSessionsForWeek(week.id));
    }
    return {
      known,
      sessions: sessions.filter((session) => !inactiveSessionStatuses.has(String(session.status ?? '').toLowerCase()) && session.day_of_week === dayName),
    };
  };

  const todaySchedule = scheduleForDay(now, todayName);
  const tomorrowSchedule = scheduleForDay(tomorrow, tomorrowName);
  const trainingContext = readTrainingContextAll({ userId, tenantId });
  // Ordinary meal-plan reads stay local-only. Wearable fetches and OAuth token
  // refresh belong to sync jobs, which publish tenant-scoped training signals.
  const localReadinessScore = trainingContext.signals
    .find((signal) => signal.signal_type === 'low_readiness')
    ?.payload?.score;
  const readinessScore = typeof localReadinessScore === 'number'
    && Number.isFinite(localReadinessScore)
    && localReadinessScore >= 0
    && localReadinessScore <= 100
    ? localReadinessScore
    : null;

  return {
    hasTrainingContext: activePlans.length > 0 || trainingContext.signals.length > 0 || readinessScore != null,
    todayIso,
    tomorrowIso,
    readinessScore,
    lowReadiness: trainingContext.flags.lowReadiness,
    lowSleep: trainingContext.flags.lowSleep,
    lowHrv: trainingContext.flags.lowHrv,
    highLegLoad: trainingContext.flags.highLegLoad,
    todayScheduleKnown: todaySchedule.known,
    todayHasTraining: todaySchedule.sessions.length > 0,
    todayHasHardSession: todaySchedule.sessions.some(isHardTrainingSession),
    tomorrowScheduleKnown: tomorrowSchedule.known,
    tomorrowHasTraining: tomorrowSchedule.sessions.length > 0,
    tomorrowHasHardSession: tomorrowSchedule.sessions.some(isHardTrainingSession),
  };
}

function buildMealAdaptation(meal: MealPlan, snapshot: CookingTrainingSnapshot): MealAdaptation | null {
  if (!snapshot.hasTrainingContext) return null;

  const mealType = String((meal as any).meal_type ?? '').toLowerCase();
  const mealDate = String((meal as any).date ?? '');
  const isTodayMeal = mealDate === snapshot.todayIso;
  const isTomorrowMeal = mealDate === snapshot.tomorrowIso;
  const recoveryReasonCodes = [
    snapshot.lowReadiness ? 'LOW_READINESS' : null,
    snapshot.lowSleep ? 'LOW_SLEEP' : null,
    snapshot.lowHrv ? 'LOW_HRV' : null,
  ].filter(Boolean) as string[];

  if (!isTodayMeal && !isTomorrowMeal) return null;

  if (isTodayMeal && (mealType === 'breakfast' || mealType === 'lunch') && snapshot.todayHasHardSession) {
    return {
      kind: 'carbs_up',
      reasonCodes: ['HARD_SESSION_TODAY'],
      readinessScore: snapshot.readinessScore,
    };
  }

  if (isTodayMeal && mealType === 'dinner' && snapshot.todayHasTraining) {
    if (snapshot.highLegLoad) {
      return {
        kind: 'protein_up',
        reasonCodes: ['HIGH_LEG_LOAD', ...recoveryReasonCodes],
        readinessScore: snapshot.readinessScore,
      };
    }

    if (recoveryReasonCodes.length > 0) {
      return {
        kind: 'recovery',
        reasonCodes: recoveryReasonCodes,
        readinessScore: snapshot.readinessScore,
      };
    }

    return {
      kind: 'protein_up',
      reasonCodes: snapshot.todayHasHardSession ? ['HARD_SESSION_TODAY'] : ['TRAINING_TODAY'],
      readinessScore: snapshot.readinessScore,
    };
  }

  if (isTodayMeal && mealType === 'dinner' && snapshot.highLegLoad) {
    return {
      kind: 'protein_up',
      reasonCodes: ['HIGH_LEG_LOAD', ...recoveryReasonCodes],
      readinessScore: snapshot.readinessScore,
    };
  }

  if (isTodayMeal && recoveryReasonCodes.length > 0) {
    return {
      kind: 'recovery',
      reasonCodes: recoveryReasonCodes,
      readinessScore: snapshot.readinessScore,
    };
  }

  if (isTodayMeal && mealType === 'dinner' && snapshot.tomorrowHasHardSession) {
    return {
      kind: 'carbs_up',
      reasonCodes: ['HARD_SESSION_TOMORROW'],
      readinessScore: snapshot.readinessScore,
    };
  }

  if (isTodayMeal && mealType === 'dinner' && snapshot.tomorrowScheduleKnown && !snapshot.tomorrowHasTraining) {
    return {
      kind: 'carbs_down',
      reasonCodes: ['REST_DAY_TOMORROW'],
      readinessScore: snapshot.readinessScore,
    };
  }

  if (isTomorrowMeal && mealType === 'dinner' && snapshot.tomorrowHasTraining) {
    return {
      kind: 'protein_up',
      reasonCodes: snapshot.tomorrowHasHardSession ? ['HARD_SESSION_TOMORROW'] : ['TRAINING_TOMORROW'],
      readinessScore: snapshot.readinessScore,
    };
  }

  if (isTomorrowMeal && (mealType === 'breakfast' || mealType === 'lunch')) {
    if (snapshot.tomorrowHasHardSession) {
      return {
        kind: 'carbs_up',
        reasonCodes: ['HARD_SESSION_TOMORROW'],
        readinessScore: snapshot.readinessScore,
      };
    }

    if (snapshot.tomorrowHasTraining) {
      return {
        kind: 'carbs_up',
        reasonCodes: ['TRAINING_TOMORROW'],
        readinessScore: snapshot.readinessScore,
      };
    }
  }

  if (isTomorrowMeal && mealType === 'dinner' && snapshot.tomorrowScheduleKnown && !snapshot.tomorrowHasTraining) {
    return {
      kind: 'carbs_down',
      reasonCodes: ['REST_DAY'],
      readinessScore: snapshot.readinessScore,
    };
  }

  return null;
}

export function cookingRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'cooking_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  // ── Recipes ────────────────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/recipes?search=&tags=&limit=
   * List the user's recipes, newest first.
   */
  router.get('/recipes', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;

    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const tags = typeof req.query.tags === 'string' ? req.query.tags : undefined;
    const limit = parseBoundedRouteLimit(req.query.limit, 20, 100);

    try {
      const recipes = getRecipes(userId, { search, tags, limit, tenantId });
      sendSuccess(res, { recipes, count: recipes.length });
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'GET /recipes', surface: 'recipe' })) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking recipes list failed',
        message: 'Failed to fetch recipes',
      });
    }
  }));

  /**
   * POST /api/v1/cooking/recipes
   * Body: {
   *   title: string,
   *   ingredients: Ingredient[],
   *   instructions?, prepTime?, cookTime?, servings?, tags?, source?
   * }
   */
  router.post('/recipes', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { title, ingredients, instructions, prepTime, cookTime, servings, tags, source, protein, fat, carbs, calories } = req.body ?? {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      sendError(res, 'BAD_REQUEST', 'title is required');
      return;
    }
    if (!isValidIngredientList(ingredients)) {
      sendError(res, 'BAD_REQUEST', 'ingredients must be an array of objects with a non-empty string name and string quantity and unit');
      return;
    }
    if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') {
      sendError(res, 'BAD_REQUEST', 'instructions must be a string when provided');
      return;
    }
    if (!isValidNutritionField(protein) || !isValidNutritionField(fat)
        || !isValidNutritionField(carbs) || !isValidNutritionField(calories)) {
      sendError(res, 'BAD_REQUEST', 'nutrition fields must be non-negative numbers or null');
      return;
    }
    if (!consumeCookingWriteBudget(res, tenantId, userId, 'cooking_recipe_create')) return;

    try {
      const writeRecipe = () => addRecipe(userId, title.trim(), ingredients as Ingredient[], {
        instructions,
        prepTime,
        cookTime,
        servings,
        tags,
        source,
        protein,
        fat,
        carbs,
        calories,
        tenantId,
      });
      const recipe = runOutboxTransaction((emitDomainEvent) => {
        const created = writeRecipe();
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'cooking',
          eventType: 'cooking.meal_plan.updated',
          entityType: 'recipe',
          entityId: created.id,
          payload: {
            summary: { created: true, tags: Array.isArray(tags) ? tags.length : 0 },
            action: 'created',
          },
          privacyClassification: 'internal',
          idempotencyKey: `cooking.recipe.created:${tenantId}:${userId}:${created.id}`,
        });
        return created;
      });
      logger.info({ userId, recipeId: recipe.id }, 'iOS recipe created');
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { recipe }, { status: 201 });
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'POST /recipes', surface: 'recipe' })) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking recipe create failed',
        message: 'Failed to create recipe',
      });
    }
  }));

  /**
   * GET /api/v1/cooking/recipes/:id
   * Fetch a single recipe. Used by the iOS RecipeDetailView when
   * the user taps a row from the recipes list.
   */
  router.get('/recipes/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const recipeId = parseStrictRouteInteger(req.params.id, 1);

    if (recipeId === null) {
      sendError(res, 'BAD_REQUEST', 'id must be a positive integer');
      return;
    }

    try {
      const recipe = getRecipeById(userId, recipeId, tenantId);
      if (!recipe) {
        sendError(res, 'NOT_FOUND', 'Recipe not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { recipe });
    } catch (err: unknown) {
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'GET /recipes/:id', surface: 'recipe' })) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking recipe fetch failed',
        message: 'Failed to fetch recipe',
        extra: { recipeId },
      });
    }
  }));

  /**
   * PATCH /api/v1/cooking/recipes/:id
   * Partial update. Only the fields present in the body are written.
   * Returns 404 on missing or cross-user recipes.
   */
  router.patch('/recipes/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const recipeId = parseStrictRouteInteger(req.params.id, 1);
    const { title, ingredients, instructions, prepTime, cookTime, servings, tags, source, protein, fat, carbs, calories } = req.body ?? {};

    if (recipeId === null) {
      sendError(res, 'BAD_REQUEST', 'id must be a positive integer');
      return;
    }

    // Reject completely-empty bodies.
    if (title === undefined && ingredients === undefined && instructions === undefined
        && prepTime === undefined && cookTime === undefined && servings === undefined
        && tags === undefined && source === undefined
        && protein === undefined && fat === undefined && carbs === undefined && calories === undefined) {
      sendError(res, 'BAD_REQUEST', 'At least one field must be provided');
      return;
    }

    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      sendError(res, 'BAD_REQUEST', 'title must be a non-empty string when provided');
      return;
    }
    if (ingredients !== undefined && !isValidIngredientList(ingredients)) {
      sendError(res, 'BAD_REQUEST', 'ingredients must be an array of objects with a non-empty string name and string quantity and unit when provided');
      return;
    }
    if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') {
      sendError(res, 'BAD_REQUEST', 'instructions must be a string when provided');
      return;
    }
    if (!isValidNutritionField(protein) || !isValidNutritionField(fat)
        || !isValidNutritionField(carbs) || !isValidNutritionField(calories)) {
      sendError(res, 'BAD_REQUEST', 'nutrition fields must be non-negative numbers or null');
      return;
    }

    try {
      const updated = updateRecipe(userId, recipeId, {
        title: title !== undefined ? title.trim() : undefined,
        ingredients: ingredients as Ingredient[] | undefined,
        instructions,
        prepTime,
        cookTime,
        servings,
        tags,
        source,
        protein,
        fat,
        carbs,
        calories,
      }, tenantId);
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Recipe not found or not owned by user', 404);
        return;
      }
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { recipe: updated });
    } catch (err: unknown) {
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'PATCH /recipes/:id', surface: 'recipe' })) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking recipe update failed',
        message: 'Failed to update recipe',
        extra: { recipeId },
      });
    }
  }));

  /**
   * DELETE /api/v1/cooking/recipes/:id
   */
  router.delete('/recipes/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const recipeId = parseStrictRouteInteger(req.params.id, 1);

    if (recipeId === null) {
      sendError(res, 'BAD_REQUEST', 'id must be a positive integer');
      return;
    }

    try {
      const deleted = deleteRecipe(userId, recipeId, tenantId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Recipe not found or not owned by user', 404);
        return;
      }
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { deleted: true, id: recipeId });
    } catch (err: unknown) {
      if (err instanceof CookingRecipeDeleteConflictError) {
        sendError(res, 'COOKING_RECIPE_IN_USE', 'Recipe is used by an active meal plan', 409);
        return;
      }
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking recipe delete failed',
        message: 'Failed to delete recipe',
        extra: { recipeId },
      });
    }
  }));

  // ── Pantry ────────────────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/pantry?search=&category=&includeExpired=&limit=
   * Lists tenant/user-scoped pantry items. Expired rows are hidden by default
   * in day-to-day views, but can be requested explicitly for review/cleanup.
   */
  router.get('/pantry', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const includeExpired = String(req.query.includeExpired ?? '').toLowerCase() === 'true';
    const limit = parseBoundedRouteLimit(req.query.limit, 100, 250);

    try {
      const items = getPantryItems(userId, { tenantId, search, category, includeExpired, limit });
      sendSuccess(res, { items, count: items.length });
    } catch (err: unknown) {
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking pantry list failed',
        message: 'Failed to fetch pantry items',
      });
    }
  }));

  /**
   * POST /api/v1/cooking/pantry/items
   * Body: { name, quantity?, unit?, category?, expiresAt?, freshnessStatus?,
   *         availabilityStatus?, source?, confidence?, notes? }
   */
  router.post('/pantry/items', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const input = req.body as PantryItemInput;

    if (!input?.name || typeof input.name !== 'string' || !input.name.trim()) {
      sendError(res, 'BAD_REQUEST', 'name is required');
      return;
    }
    if (input.confidence !== undefined && input.confidence !== null
        && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)
          || input.confidence < 0 || input.confidence > 1)) {
      sendError(res, 'BAD_REQUEST', 'confidence must be a number between 0 and 1');
      return;
    }

    try {
      const item = upsertPantryItem(userId, input, tenantId);
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { item }, { status: 201 });
    } catch (err: unknown) {
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking pantry item upsert failed',
        message: 'Failed to save pantry item',
      });
    }
  }));

  /**
   * GET /api/v1/cooking/pantry/items/:id
   */
  router.get('/pantry/items/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const itemId = parseStrictRouteInteger(req.params.id, 1);

    if (itemId === null) {
      sendError(res, 'BAD_REQUEST', 'id must be a positive integer');
      return;
    }

    try {
      const item = getPantryItemById(userId, itemId, tenantId);
      if (!item) {
        sendError(res, 'NOT_FOUND', 'Pantry item not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { item });
    } catch (err: unknown) {
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking pantry item fetch failed',
        message: 'Failed to fetch pantry item',
        extra: { itemId },
      });
    }
  }));

  /**
   * PATCH /api/v1/cooking/pantry/items/:id
   */
  router.patch('/pantry/items/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const itemId = parseStrictRouteInteger(req.params.id, 1);
    const input = req.body as Partial<PantryItemInput>;

    if (itemId === null) {
      sendError(res, 'BAD_REQUEST', 'id must be a positive integer');
      return;
    }
    if (!input || Object.keys(input).length === 0) {
      sendError(res, 'BAD_REQUEST', 'At least one field must be provided');
      return;
    }
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) {
      sendError(res, 'BAD_REQUEST', 'name must be a non-empty string when provided');
      return;
    }
    if (input.confidence !== undefined && input.confidence !== null
        && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)
          || input.confidence < 0 || input.confidence > 1)) {
      sendError(res, 'BAD_REQUEST', 'confidence must be a number between 0 and 1');
      return;
    }

    try {
      const item = updatePantryItem(userId, itemId, input, tenantId);
      if (!item) {
        sendError(res, 'NOT_FOUND', 'Pantry item not found or not owned by user', 404);
        return;
      }
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { item });
    } catch (err: unknown) {
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking pantry item update failed',
        message: 'Failed to update pantry item',
        extra: { itemId },
      });
    }
  }));

  /**
   * DELETE /api/v1/cooking/pantry/items/:id
   */
  router.delete('/pantry/items/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const itemId = parseStrictRouteInteger(req.params.id, 1);

    if (itemId === null) {
      sendError(res, 'BAD_REQUEST', 'id must be a positive integer');
      return;
    }

    try {
      const deleted = deletePantryItem(userId, itemId, tenantId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Pantry item not found or not owned by user', 404);
        return;
      }
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { deleted: true, id: itemId });
    } catch (err: unknown) {
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking pantry item delete failed',
        message: 'Failed to delete pantry item',
        extra: { itemId },
      });
    }
  }));

  // ── Preference Memory ─────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/preferences
   * Reads active user-private Cooking preference memory for the active tenant.
   */
  router.get('/preferences', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;

    try {
      const preferences = buildCookingPreferenceReadModel(userId, tenantId);
      sendSuccess(res, { preferences });
    } catch (err: unknown) {
      if (sendCookingPreferenceErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking preferences read failed',
        message: 'Failed to fetch cooking preferences',
      });
    }
  }));

  /**
   * POST /api/v1/cooking/preferences
   * Body: { kind, value, correction?, confidence?, source? }
   *
   * Preferences are user-private by default. Tenant-shared Cooking memory
   * needs a membership-backed policy before being exposed here.
   */
  router.post('/preferences', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const input = req.body as CookingPreferenceWriteInput;

    if (!isCookingPreferenceKind(input?.kind)) {
      sendError(res, 'BAD_REQUEST', 'kind is required and must be a supported Cooking preference kind');
      return;
    }
    if (input.value === undefined || input.value === null || String(input.value).trim().length === 0) {
      sendError(res, 'BAD_REQUEST', 'value is required');
      return;
    }
    if (input.confidence !== undefined && input.confidence !== null
        && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)
          || input.confidence < 0 || input.confidence > 1)) {
      sendError(res, 'BAD_REQUEST', 'confidence must be a number between 0 and 1');
      return;
    }

    try {
      const memory = setCookingPreferenceMemory(userId, input, tenantId);
      invalidateCookingDerivedCaches(userId);
      const preferences = buildCookingPreferenceReadModel(userId, tenantId);
      sendSuccess(res, { memory, preferences }, { status: 201 });
    } catch (err: unknown) {
      if (sendCookingPreferenceErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking preferences write failed',
        message: 'Failed to save cooking preference',
      });
    }
  }));

  // ── Meal Planning ──────────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/meal-plan?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Returns all meal plan entries for the given date range.
   */
  router.get('/meal-plan', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;

    if (!from || !to) {
      sendError(res, 'BAD_REQUEST', 'from and to query params are required (YYYY-MM-DD)');
      return;
    }

    try {
      const plans = getMealPlan(userId, from, to, tenantId);
      const trainingSnapshot = buildCookingLocalTrainingSnapshot({ userId, tenantId });
      const meals: MealPlanRouteRow[] = plans.map((plan) => ({
        ...plan,
        adaptation: buildMealAdaptation(plan, trainingSnapshot),
      }));
      const recipesById = new Map(
        plans
          .map((plan) => plan.recipe_id ? getRecipeById(userId, plan.recipe_id, tenantId) : null)
          .filter((recipe): recipe is NonNullable<typeof recipe> => Boolean(recipe))
          .map((recipe) => [recipe.id, recipe]),
      );
      const userTimezone = getUserTimezoneById(userId);
      const fromDate = DateTime.fromISO(from, { zone: userTimezone });
      const toDate = DateTime.fromISO(to, { zone: userTimezone });
      const fromWeekStart = fromDate.startOf('week');
      const shoppingList = fromWeekStart.isValid
        && toDate.isValid
        && fromWeekStart.hasSame(toDate.startOf('week'), 'day')
        ? getShoppingList(userId, fromWeekStart.toISODate()!, tenantId)
        : null;
      const preferenceReadModel = buildCookingPreferenceReadModel(userId, tenantId);
      const financeBudgetContext = readCookingFinanceBudgetContextSafely({ userId, tenantId, from, to });
      const secretaryAvailabilityContext = readCookingSecretaryAvailabilityContextSafely({ userId, tenantId, from, to });
      const pantryItems = getPantryItems(userId, { tenantId, includeExpired: true, limit: 250 })
        .map((item) => ({
          name: item.name,
          quantity: item.quantity ?? undefined,
          unit: item.unit ?? undefined,
          expiresAt: item.expires_at,
          status: item.freshness_status === 'expired'
            ? 'expired' as const
            : item.availability_status === 'unavailable'
              ? 'unavailable' as const
              : item.freshness_status === 'unknown'
                ? 'unknown' as const
                : 'available' as const,
        }));
      const assessment = assessCookingMealPlan({
        meals: plans,
        recipesById,
        shoppingList,
        preferences: preferenceReadModel.profile,
        pantryItems,
        availableCookingMinutesByDate: secretaryAvailabilityContext.availableCookingMinutesByDate,
        financeBudgetContext,
        trainingContext: {
          trainingDates: [
            ...(trainingSnapshot.todayHasTraining ? [trainingSnapshot.todayIso] : []),
            ...(trainingSnapshot.tomorrowHasTraining ? [trainingSnapshot.tomorrowIso] : []),
          ],
          hardTrainingDates: [
            ...(trainingSnapshot.todayHasHardSession ? [trainingSnapshot.todayIso] : []),
            ...(trainingSnapshot.tomorrowHasHardSession ? [trainingSnapshot.tomorrowIso] : []),
          ],
        },
      });
      sendSuccess(res, {
        meals,
        count: meals.length,
        from,
        to,
        assessment,
        preferences: { summary: preferenceReadModel.summary },
        planningContext: {
          financeBudget: financeBudgetContext,
          secretaryAvailability: secretaryAvailabilityContext,
        },
      });
    } catch (err: unknown) {
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking meal-plan list failed',
        message: 'Failed to fetch meal plan',
      });
    }
  }));

  /**
   * POST /api/v1/cooking/meal-plan
   * Body: { date, mealType, title, recipeId?, notes? }
   * Upserts one meal plan slot (unique on user+date+mealType).
   */
  router.post('/meal-plan', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { date, mealType, title, recipeId, notes } = req.body ?? {};

    if (!date || !mealType || !title) {
      sendError(res, 'BAD_REQUEST', 'date, mealType, and title are required');
      return;
    }

    try {
      const plan = setMealPlan(userId, date, mealType, title, { recipeId, notes, tenantId });
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { meal: plan });
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'POST /meal-plan', surface: 'meal_plan' })) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking meal-plan set failed',
        message: 'Failed to save meal plan',
      });
    }
  }));

  /**
   * POST /api/v1/cooking/meal-plan/substitutions/suggest
   * Body: { date, mealType, originalIngredient, reason? }
   *
   * Returns deterministic, preference-safe substitution candidates for one
   * scoped meal ingredient. This is read-only: it never changes the recipe,
   * meal plan, or shopping list.
   */
  router.post('/meal-plan/substitutions/suggest', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { date, mealType, originalIngredient, reason } = req.body ?? {};

    if (typeof date !== 'string' || !date.trim()) {
      sendError(res, 'BAD_REQUEST', 'date is required');
      return;
    }
    if (typeof mealType !== 'string' || !mealType.trim()) {
      sendError(res, 'BAD_REQUEST', 'mealType is required');
      return;
    }
    if (typeof originalIngredient !== 'string' || !originalIngredient.trim()) {
      sendError(res, 'BAD_REQUEST', 'originalIngredient is required');
      return;
    }
    if (reason !== undefined && !isCookingSubstitutionReason(reason)) {
      sendError(res, 'BAD_REQUEST', 'reason must be allergy, dietary_restriction, disliked_ingredient, or expired_pantry');
      return;
    }

    try {
      const result = suggestMealPlanSubstitutions(userId, {
        date: date.trim(),
        mealType: mealType.trim().toLowerCase(),
        originalIngredient,
        reason,
      }, tenantId);
      if (!result.found) {
        const status = result.reason === 'meal_not_found' || result.reason === 'recipe_not_found' ? 404 : 400;
        sendError(res, status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', result.reason ?? 'substitution_not_found', status);
        return;
      }
      sendSuccess(res, {
        ...result,
        count: result.suggestions.length,
      });
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking substitution suggestion failed',
        message: 'Failed to suggest Cooking substitutions',
      });
    }
  }));

  /**
   * POST /api/v1/cooking/meal-plan/substitutions/apply
   * Body: { date, mealType, originalIngredient, suggestedIngredient, reason, updateShoppingList? }
   *
   * Accepts one deterministic substitution candidate and applies it to the
   * scoped meal's linked recipe. The optional shopping-list refresh keeps the
   * grocery plan aligned with the accepted replacement.
   */
  router.post('/meal-plan/substitutions/apply', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { date, mealType, originalIngredient, suggestedIngredient, reason, updateShoppingList } = req.body ?? {};

    if (typeof date !== 'string' || !date.trim()) {
      sendError(res, 'BAD_REQUEST', 'date is required');
      return;
    }
    if (typeof mealType !== 'string' || !mealType.trim()) {
      sendError(res, 'BAD_REQUEST', 'mealType is required');
      return;
    }
    if (typeof originalIngredient !== 'string' || !originalIngredient.trim()) {
      sendError(res, 'BAD_REQUEST', 'originalIngredient is required');
      return;
    }
    if (typeof suggestedIngredient !== 'string' || !suggestedIngredient.trim()) {
      sendError(res, 'BAD_REQUEST', 'suggestedIngredient is required');
      return;
    }
    if (!isCookingSubstitutionReason(reason)) {
      sendError(res, 'BAD_REQUEST', 'reason must be allergy, dietary_restriction, disliked_ingredient, or expired_pantry');
      return;
    }
    if (updateShoppingList !== undefined && typeof updateShoppingList !== 'boolean') {
      sendError(res, 'BAD_REQUEST', 'updateShoppingList must be a boolean when provided');
      return;
    }

    try {
      const result = applyMealPlanSubstitution(userId, {
        date,
        mealType,
        originalIngredient,
        suggestedIngredient,
        reason,
        updateShoppingList,
      }, tenantId);
      if (!result.applied) {
        const status = result.reason === 'meal_not_found' || result.reason === 'recipe_not_found' ? 404 : 400;
        sendError(res, status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', result.reason ?? 'substitution_not_applied', status);
        return;
      }
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, result);
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'POST /meal-plan/substitutions/apply', surface: 'meal_plan_substitution' })) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      const message = err instanceof Error ? err.message : '';
      if (message.startsWith('COOKING_SUBSTITUTION')) {
        sendError(res, 'BAD_REQUEST', message, 400);
        return;
      }
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking substitution application failed',
        message: 'Failed to apply Cooking substitution',
      });
    }
  }));

  /**
   * DELETE /api/v1/cooking/meal-plan?date=&mealType=
   */
  router.delete('/meal-plan', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const mealType = typeof req.query.mealType === 'string' ? req.query.mealType : undefined;

    if (!date || !mealType) {
      sendError(res, 'BAD_REQUEST', 'date and mealType query params are required');
      return;
    }

    try {
      const deleted = deleteMealPlan(userId, date, mealType, tenantId);
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { deleted, date, mealType });
    } catch (err: unknown) {
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking meal-plan delete failed',
        message: 'Failed to delete meal plan',
      });
    }
  }));

  // ── Shopping List ──────────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/shopping-list?week=YYYY-MM-DD
   * Returns the stored shopping list for the given week, or null.
   */
  router.get('/shopping-list', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const week = typeof req.query.week === 'string' ? req.query.week : undefined;

    if (!week) {
      sendError(res, 'BAD_REQUEST', 'week query param is required (YYYY-MM-DD)');
      return;
    }

    try {
      const list = getShoppingList(userId, week, tenantId);
      sendSuccess(res, { list });
    } catch (err: unknown) {
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'GET /shopping-list', surface: 'shopping_list' })) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking shopping-list get failed',
        message: 'Failed to fetch shopping list',
      });
    }
  }));

  /**
   * POST /api/v1/cooking/shopping-list/generate
   * Body: { week: YYYY-MM-DD }
   * Rebuilds the shopping list by aggregating ingredients from every
   * meal plan entry in the week. Overwrites any existing list for that week.
   */
  router.post('/shopping-list/generate', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { week } = req.body ?? {};

    if (!week || typeof week !== 'string') {
      sendError(res, 'BAD_REQUEST', 'week is required in the body (YYYY-MM-DD)');
      return;
    }

    try {
      const list = generateShoppingList(userId, week, tenantId);
      logger.info({ userId, week, itemCount: list.items.length }, 'iOS shopping list generated');
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { list });
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'POST /shopping-list/generate', surface: 'shopping_list' })) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking shopping-list generate failed',
        message: 'Failed to generate shopping list',
        extra: { week },
      });
    }
  }));

  /**
   * PATCH /api/v1/cooking/shopping-list/items/:index
   * Body: { week: YYYY-MM-DD, checked: boolean }
   * Persists the checked state for one item in the week's list.
   */
  router.patch('/shopping-list/items/:index', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const index = parseStrictRouteInteger(req.params.index, 0);
    const { week, checked } = req.body ?? {};

    if (index === null) {
      sendError(res, 'BAD_REQUEST', 'index must be a non-negative integer');
      return;
    }
    if (!week || typeof week !== 'string') {
      sendError(res, 'BAD_REQUEST', 'week is required in the body (YYYY-MM-DD)');
      return;
    }
    if (typeof checked !== 'boolean') {
      sendError(res, 'BAD_REQUEST', 'checked must be a boolean');
      return;
    }

    try {
      const list = updateShoppingListItemChecked(userId, week, index, checked, tenantId);
      if (!list) {
        sendError(res, 'NOT_FOUND', 'Shopping list not found for that week', 404);
        return;
      }
      invalidateCookingDerivedCaches(userId);
      sendSuccess(res, { list });
    } catch (err: unknown) {
      if (sendCookingSafetyErrorIfNeeded(res, err, { userId, tenantId, route: 'PATCH /shopping-list/items/:index', surface: 'shopping_list' })) return;
      if (sendCookingInputErrorIfNeeded(res, err)) return;
      const message = err instanceof Error ? err.message : '';
      if (message.includes('out of range')) {
        logger.error({ err, userId, week, index }, 'iOS cooking shopping-list item update rejected');
        sendError(res, 'BAD_REQUEST', message, 400);
        return;
      }
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking shopping-list item update failed',
        message: 'Failed to update shopping list item',
        extra: { week, index },
      });
    }
  }));

  // ─── Calendar integration (TASK-14 Phase 3) ──────────────────────

  /**
   * POST /api/v1/cooking/meal-plan/create-prep-event
   * Body: {
   *   week: YYYY-MM-DD,              // ISO Monday of the target week
   *   dayOfWeek?: number,            // 0-6, 0=Sunday, default 0 (Sunday)
   *   startHour?: number,            // 0-23, default 14 (2pm)
   *   durationMinutes?: number,      // default 120 (2 hours)
   * }
   *
   * Reads the week's meal plan, aggregates a "what to prep" summary
   * from the planned recipes, and creates ONE calendar event via the
   * unified-calendar service (auto-selects Outlook if configured,
   * else Google). Returns the created event's metadata so the iOS
   * UI can link out to it.
   *
   * The created event title is "Meal prep — <N meals>" and the
   * description lists every planned meal for the week with its
   * date and type. This gives the user a full context of what
   * they're prepping without needing to flip back to the app.
   *
   * Rationale: user wanted to be asked before calendar events are
   * created, not have them auto-created every time a meal is set.
   * The iOS Cooking landing page shows a "Schedule prep" button
   * that presents a confirmation sheet; tapping confirm hits this
   * endpoint.
   */
  router.post('/meal-plan/create-prep-event', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = assertTenantScope(req as AuthenticatedRequest, 'cooking_meal_prep_event');
    const { week, dayOfWeek, startHour, durationMinutes } = req.body ?? {};

    if (!week || typeof week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      sendError(res, 'BAD_REQUEST', 'week is required and must be YYYY-MM-DD');
      return;
    }
    if (dayOfWeek !== undefined
        && (!Number.isSafeInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)) {
      sendError(res, 'BAD_REQUEST', 'dayOfWeek must be an integer between 0 and 6');
      return;
    }
    if (startHour !== undefined
        && (!Number.isSafeInteger(startHour) || startHour < 0 || startHour > 23)) {
      sendError(res, 'BAD_REQUEST', 'startHour must be an integer between 0 and 23');
      return;
    }
    if (durationMinutes !== undefined
        && (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480)) {
      sendError(res, 'BAD_REQUEST', 'durationMinutes must be an integer between 1 and 480');
      return;
    }

    const tz = getUserTimezoneById(userId);
    const mondayDate = DateTime.fromISO(week, { zone: tz });
    if (!mondayDate.isValid || mondayDate.toISODate() !== week || mondayDate.weekday !== 1) {
      sendError(res, 'BAD_REQUEST', 'week must be a valid Monday in YYYY-MM-DD format');
      return;
    }

    // Defaults: Sunday at 14:00 for 120 minutes. These match what
    // the iOS confirmation sheet shows as the default selection.
    const dow = dayOfWeek ?? 0;
    const hour = startHour ?? 14;
    const duration = durationMinutes ?? 120;
    // dayOfWeek is 0-6 where 0=Sunday. Resolve and reject the exact local
    // start before any calendar/provider read so a stale request cannot create
    // Secretary work or consume an external provider budget.
    const dayOffsetFromMonday = dow === 0 ? 6 : dow - 1;
    const eventDay = mondayDate.plus({ days: dayOffsetFromMonday });
    const startDt = eventDay.set({ hour, minute: 0, second: 0, millisecond: 0 });
    const endDt = startDt.plus({ minutes: duration });
    if (startDt.toMillis() <= DateTime.now().setZone(tz).toMillis()) {
      sendError(
        res,
        'COOKING_PREP_PAST_WINDOW',
        'Meal prep must be scheduled for a future local time.',
        400,
      );
      return;
    }

    if (!hasConnectedCalendarForUser(userId)) {
      sendError(
        res,
        'CALENDAR_NOT_CONFIGURED',
        'No calendar provider is configured. Connect Google Calendar or Outlook in Settings first.',
        400,
      );
      return;
    }

    // Resolve the writable provider before preview or submit. Refusing an
    // ambiguous/unwritable preference must leave no Secretary agenda row for
    // a background worker to execute against a different provider later.
    const calendarPreference = resolveCalendarWritePreference(userId, tenantId);
    if (!calendarPreference.source) {
      sendError(
        res,
        calendarPreference.warningCode || 'CALENDAR_NOT_CONFIGURED',
        calendarPreference.warning || 'No writable calendar provider is connected.',
        400,
      );
      return;
    }

    try {
      // Read the week's meal plan so we can summarize what's being prepped.
      // Week ends on Sunday (6 days after Monday).
      const weekEnd = mondayDate.plus({ days: 6 }).toFormat('yyyy-LL-dd');
      const meals = getMealPlan(userId, week, weekEnd, tenantId);

      if (meals.length === 0) {
        sendError(
          res,
          'NO_MEALS_PLANNED',
          'No meals are planned for this week. Add some meals to the plan before scheduling prep.',
          400,
        );
        return;
      }

      // Set the event time. Use the configured timezone explicitly so
      // the event lands at the right local hour regardless of server TZ.
      const title = meals.length === 1
        ? `Meal prep — ${meals[0].title}`
        : `Meal prep — ${meals.length} meals`;

      // unified-calendar uses ISO strings that the underlying Google
      // API interprets with the event's timeZone field. Our helper
      // passes the user's timezone for the timeZone, so ISO without
      // offset works correctly.
      const startIso = startDt.toISO() || startDt.toFormat("yyyy-LL-dd'T'HH:mm:ss");
      const endIso = endDt.toISO() || endDt.toFormat("yyyy-LL-dd'T'HH:mm:ss");
      const secretaryInput = {
        userId,
        tenantId,
        week,
        title,
        startIso,
        endIso,
        durationMinutes: duration,
        mealCount: meals.length,
        providerTarget: calendarPreference.source,
      };
      const busyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(
        buildCookingMealPrepSchedulingIntent(secretaryInput),
      );
      if (busyWindows.degraded) {
        sendError(
          res,
          'COOKING_PREP_CALENDAR_UNAVAILABLE',
          'Calendar availability could not be checked right now.',
          503,
          { warningCodes: busyWindows.warningCodes },
        );
        return;
      }
      const secretaryInputWithBusyWindows = { ...secretaryInput, additionalBusyWindows: busyWindows.windows };
      const secretaryPreview = previewCookingMealPrepSchedulingIntent(secretaryInputWithBusyWindows);
      if (!['scheduled', 'reflowed', 'compressed'].includes(secretaryPreview.status) || !secretaryPreview.recommendedSlot) {
        sendError(
          res,
          'COOKING_PREP_NO_VALID_SLOT',
          'Secretary could not find a valid meal prep slot.',
          409,
          { reasonCodes: secretaryPreview.reasonCodes },
        );
        return;
      }

      const secretaryDecision = submitCookingMealPrepSchedulingIntent(secretaryInputWithBusyWindows);
      if (!['scheduled', 'reflowed', 'compressed'].includes(secretaryDecision.status) || !secretaryDecision.selectedSlot) {
        sendError(
          res,
          'COOKING_PREP_NO_VALID_SLOT',
          secretaryDecision.explanation || 'Secretary could not find a valid meal prep slot.',
          409,
          { reasonCodes: secretaryDecision.reasonCodes, agendaItemId: secretaryDecision.agendaItem.agendaItemId },
        );
        return;
      }

      const providerTarget = secretaryDecision.agendaItem.providerTarget;
      if (!providerTarget || providerTarget !== calendarPreference.source) {
        sendError(
          res,
          'COOKING_PREP_CALENDAR_PROVIDER_CONFLICT',
          'The meal prep block is pinned to a different calendar provider.',
          409,
          { agendaItemId: secretaryDecision.agendaItem.agendaItemId },
        );
        return;
      }
      const providerAdapter = createUnifiedCalendarSecretaryProviderAdapter(providerTarget);
      const providerSyncResults = await syncSecretaryAgendaItemsToProvider({
        ownerUserId: userId,
        tenantId,
        includeInactive: false,
      }, providerAdapter, {
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        // One exact row only; this is a provider-call budget, not a backlog
        // limit. It funds marker discovery, duplicate cleanup, and adoption.
        maxItems: 50,
        retryBudget: 0,
      });
      const providerSync = providerSyncResults.find(
        (entry) => entry.agendaItemId === secretaryDecision.agendaItem.agendaItemId,
      );
      const storedAgenda = getSecretaryAgendaItemById({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId,
      });
      const successfulSync = providerSync
        && providerSync.action !== 'failed'
        && providerSync.providerSyncState === 'synced'
        && providerSync.providerEventId
        && storedAgenda?.providerSyncState === 'synced'
        && storedAgenda.providerEventId === providerSync.providerEventId
        && storedAgenda.providerSource === providerSync.providerSource
        && storedAgenda.providerTarget === providerSync.providerSource
        ? {
            providerEventId: storedAgenda.providerEventId,
            providerSource: storedAgenda.providerSource,
          }
        : null;
      // An exact claimed batch intentionally returns no row when the stable
      // intent is already fresh. Reuse only a mapping that was durable before
      // this request; never turn a failed current sync into apparent success.
      const existingSync = !providerSync
        && storedAgenda?.providerSyncState === 'synced'
        && storedAgenda.providerEventId
        && storedAgenda.providerSource
        && storedAgenda.providerTarget === storedAgenda.providerSource
        ? {
            providerEventId: storedAgenda.providerEventId,
            providerSource: storedAgenda.providerSource,
          }
        : null;
      const durableSync = successfulSync ?? existingSync;
      if (!durableSync) {
        sendError(
          res,
          'COOKING_PREP_CALENDAR_SYNC_PENDING',
          'The meal prep block was saved, but calendar synchronization is still pending.',
          503,
          {
            agendaItemId: secretaryDecision.agendaItem.agendaItemId,
            reasonCode: providerSync?.reasonCode || 'provider_sync_claim_held',
          },
        );
        return;
      }
      const event = {
        id: durableSync.providerEventId,
        summary: title,
        start: secretaryDecision.selectedSlot.start,
        end: secretaryDecision.selectedSlot.end,
        source: durableSync.providerSource,
        // The governed sync result intentionally exposes only durable
        // identity. Keep the response field stable without inventing a link.
        htmlLink: null,
      };

      logger.info(
        { userId, week, eventId: event.id, mealCount: meals.length, source: event.source },
        'iOS meal prep calendar event created',
      );
      sendSuccess(res, {
        event: {
          id: event.id,
          title: event.summary,
          start: event.start,
          end: event.end,
          source: event.source,
          htmlLink: event.htmlLink,
        },
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        mealCount: meals.length,
      });
    } catch (err: unknown) {
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS meal prep event creation failed',
        message: 'Failed to create prep event',
        extra: { week },
      });
    }
  }));

  return router;
}

function consumeCookingWriteBudget(res: Response, tenantId: number, userId: number, budgetKey: string): boolean {
  const budget = consumeResourceBudget({
    tenantId,
    userId,
    budgetKey,
    limit: 60,
    windowSeconds: 60,
  });
  if (budget.allowed) return true;
  setRetryAfter(res, budget.resetAt);
  sendError(res, 'RATE_LIMITED', 'Too many cooking write requests. Try again shortly.', 429, {
    resetAt: budget.resetAt,
    budgetKey: budget.budgetKey,
  });
  return false;
}

function setRetryAfter(res: Response, resetAt: string): void {
  const seconds = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000));
  res.setHeader('Retry-After', String(Number.isFinite(seconds) ? seconds : 60));
}
