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
 *   DELETE /recipes/:id                  — remove a recipe
 *   GET    /meal-plan?from=&to=          — list meal plan entries in range
 *   POST   /meal-plan                    — upsert one meal plan slot
 *   POST   /meal-plan/substitutions/apply — accept a scoped substitution candidate
 *   DELETE /meal-plan?date=&mealType=    — clear one meal plan slot
 *   GET    /shopping-list?week=          — fetch the shopping list for a week
 *   POST   /shopping-list/generate       — (re)generate from the week's meal plan
 *   GET    /pantry                       — list pantry items
 *   POST   /pantry/items                 — create/update one pantry item
 *   PATCH  /pantry/items/:id             — update one pantry item
 *   DELETE /pantry/items/:id             — remove one pantry item
 *   GET    /preferences                  — read Cooking preference memory
 *   POST   /preferences                  — write/correct Cooking preference memory
 *
 * Part of TASK-14 Phase 1 (foundation) — backend plumbing for the
 * iOS Cooking skill landing page. Real UI features ship in follow-up
 * sessions; this file exists so the iOS CookingService + Repository
 * have something to call.
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
import { createEvent as createCalendarEvent, isAnyCalendarConfigured } from '../../services/unified-calendar';
import { getActivePlans, getCurrentWeek, getSessionsForWeek, getWeeksForPlan, type TrainingSession } from '../../services/training-plans';
import { invalidateCookingDerivedCaches } from '../../services/cooking-cache-invalidator';
import { submitCookingMealPrepSchedulingIntent } from '../../services/cooking-secretary-integration';
import { emitDomainEventSafely } from '../../services/event-outbox';
import { createNotificationIntent } from '../../services/notification-orchestrator';
import { readTrainingContextAll } from '../../services/training-signals';
import { getReadiness as getWearableReadiness } from '../../services/wearable/wearable-service';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

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
  todayHasTraining: boolean;
  todayHasHardSession: boolean;
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
    const timezone = config.app.timezone || 'Europe/Lisbon';
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

function sendCookingSafetyErrorIfNeeded(res: Response, err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  if (!message.startsWith('COOKING_SAFETY_BLOCKED')) return false;
  sendError(res, 'BAD_REQUEST', 'Cooking item conflicts with a saved allergy preference', 400);
  return true;
}

function isValidNutritionField(value: unknown): value is number | null | undefined {
  return value === undefined
    || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
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

async function buildCookingTrainingSnapshot(userId: number): Promise<CookingTrainingSnapshot> {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const now = DateTime.now().setZone(zone);
  const tomorrow = now.plus({ days: 1 });
  const todayIso = now.toISODate() ?? DateTime.now().toISODate() ?? '';
  const tomorrowIso = tomorrow.toISODate() ?? todayIso;
  const todayName = now.toFormat('EEEE');
  const tomorrowName = tomorrow.toFormat('EEEE');

  const activePlans = getActivePlans(userId);
  const sessionsForDay = (target: DateTime, dayName: string) => activePlans.flatMap((plan) => {
    const week = getCurrentWeek(plan.id);
    if (!week) return [];

    const targetWeek = target.hasSame(now, 'week')
      ? week
      : getWeeksForPlan(plan.id).find((candidate) => candidate.week_number === week.week_number + 1) ?? week;

    return getSessionsForWeek(targetWeek.id);
  }).filter((session) => session.status !== 'skipped' && session.day_of_week === dayName);

  const todaySessions = sessionsForDay(now, todayName);
  const tomorrowSessions = sessionsForDay(tomorrow, tomorrowName);
  const trainingContext = readTrainingContextAll({ userId });

  let readinessScore: number | null = null;
  try {
    readinessScore = (await getWearableReadiness(userId, todayIso))?.readinessScore ?? null;
  } catch (err) {
    logger.debug({ err, userId }, 'Cooking meal-plan readiness lookup failed');
  }

  return {
    hasTrainingContext: activePlans.length > 0 || trainingContext.signals.length > 0 || readinessScore != null,
    todayIso,
    tomorrowIso,
    readinessScore,
    lowReadiness: trainingContext.flags.lowReadiness || (readinessScore != null && readinessScore < 45),
    lowSleep: trainingContext.flags.lowSleep,
    lowHrv: trainingContext.flags.lowHrv,
    highLegLoad: trainingContext.flags.highLegLoad,
    todayHasTraining: todaySessions.length > 0,
    todayHasHardSession: todaySessions.some(isHardTrainingSession),
    tomorrowHasTraining: tomorrowSessions.length > 0,
    tomorrowHasHardSession: tomorrowSessions.some(isHardTrainingSession),
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

  if (isTodayMeal && mealType === 'dinner' && !snapshot.tomorrowHasTraining) {
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

  if (isTomorrowMeal && mealType === 'dinner' && !snapshot.tomorrowHasTraining) {
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
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 20, 100)
      : 20;

    try {
      const recipes = getRecipes(userId, { search, tags, limit, tenantId });
      sendSuccess(res, { recipes, count: recipes.length });
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingSafetyErrorIfNeeded(res, err)) return;
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
    const { title, ingredients, instructions, prepTime, cookTime, servings, tags, source, protein, fat, carbs, calories } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      sendError(res, 'BAD_REQUEST', 'title is required');
      return;
    }
    if (!Array.isArray(ingredients)) {
      sendError(res, 'BAD_REQUEST', 'ingredients must be an array');
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
      const recipe = addRecipe(userId, title.trim(), ingredients as Ingredient[], {
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
      emitDomainEventSafely({
        tenantId,
        userId,
        sourceSkill: 'cooking',
        eventType: 'cooking.meal_plan.updated',
        entityType: 'recipe',
        entityId: recipe.id,
        payload: {
          summary: { created: true, tags: Array.isArray(tags) ? tags.length : 0 },
          action: 'created',
        },
        privacyClassification: 'internal',
        idempotencyKey: `cooking.recipe.created:${tenantId}:${userId}:${recipe.id}`,
      });
      logger.info({ userId, recipeId: recipe.id }, 'iOS recipe created');
      sendSuccess(res, { recipe }, { status: 201 });
    } catch (err: unknown) {
      if (sendCookingScopeConflictIfNeeded(res, err)) return;
      if (sendCookingSafetyErrorIfNeeded(res, err)) return;
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
    const recipeId = parseInt(req.params.id, 10);

    if (Number.isNaN(recipeId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
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
      if (sendCookingSafetyErrorIfNeeded(res, err)) return;
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
    const recipeId = parseInt(req.params.id, 10);
    const { title, ingredients, instructions, prepTime, cookTime, servings, tags, source, protein, fat, carbs, calories } = req.body;

    if (Number.isNaN(recipeId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
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
    if (ingredients !== undefined && !Array.isArray(ingredients)) {
      sendError(res, 'BAD_REQUEST', 'ingredients must be an array when provided');
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
      sendSuccess(res, { recipe: updated });
    } catch (err: unknown) {
      if (sendCookingSafetyErrorIfNeeded(res, err)) return;
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
    const recipeId = parseInt(req.params.id, 10);

    if (Number.isNaN(recipeId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const deleted = deleteRecipe(userId, recipeId, tenantId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Recipe not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { deleted: true, id: recipeId });
    } catch (err: unknown) {
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
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 100, 250)
      : 100;

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
    const itemId = parseInt(req.params.id, 10);

    if (Number.isNaN(itemId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
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
    const itemId = parseInt(req.params.id, 10);
    const input = req.body as Partial<PantryItemInput>;

    if (Number.isNaN(itemId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
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
    const itemId = parseInt(req.params.id, 10);

    if (Number.isNaN(itemId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
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
      const trainingSnapshot = await buildCookingTrainingSnapshot(userId);
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
      const shoppingList = getShoppingList(userId, from, tenantId);
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
    const { date, mealType, title, recipeId, notes } = req.body;

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
      if (sendCookingSafetyErrorIfNeeded(res, err)) return;
      sendCookingInternalError(res, {
        err,
        userId,
        operation: 'iOS cooking meal-plan set failed',
        message: 'Failed to save meal plan',
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
      if (sendCookingSafetyErrorIfNeeded(res, err)) return;
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
    const { week } = req.body;

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
    const index = parseInt(req.params.index, 10);
    const { week, checked } = req.body;

    if (Number.isNaN(index) || index < 0) {
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { week, dayOfWeek, startHour, durationMinutes } = req.body;

    if (!week || typeof week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      sendError(res, 'BAD_REQUEST', 'week is required and must be YYYY-MM-DD');
      return;
    }

    // Defaults: Sunday at 14:00 for 120 minutes. These match what
    // the iOS confirmation sheet shows as the default selection.
    const dow = typeof dayOfWeek === 'number' && dayOfWeek >= 0 && dayOfWeek <= 6
      ? dayOfWeek
      : 0;
    const hour = typeof startHour === 'number' && startHour >= 0 && startHour <= 23
      ? startHour
      : 14;
    const duration = typeof durationMinutes === 'number' && durationMinutes > 0 && durationMinutes <= 480
      ? durationMinutes
      : 120;

    if (!isAnyCalendarConfigured()) {
      sendError(
        res,
        'CALENDAR_NOT_CONFIGURED',
        'No calendar provider is configured. Connect Google Calendar or Outlook in Settings first.',
        400,
      );
      return;
    }

    try {
      // Compute the target week's Monday (parse `week` as a local date).
      const tz = config.app.timezone;
      const mondayDate = DateTime.fromISO(week, { zone: tz });
      if (!mondayDate.isValid) {
        sendError(res, 'BAD_REQUEST', `Invalid date: ${week}`);
        return;
      }

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

      // Find the target day: dayOfWeek is 0-6 where 0=Sunday, so the
      // target day within the ISO week (Monday=1, ..., Sunday=7) is
      // computed as: Sunday→(Mon+6), Monday→(Mon+0), Tuesday→(Mon+1), etc.
      // Simplest: offset from Monday. Sunday = 6, Monday = 0, ..., Saturday = 5.
      const dayOffsetFromMonday = dow === 0 ? 6 : dow - 1;
      const eventDay = mondayDate.plus({ days: dayOffsetFromMonday });

      // Set the event time. Use the configured timezone explicitly so
      // the event lands at the right local hour regardless of server TZ.
      const startDt = eventDay.set({ hour, minute: 0, second: 0, millisecond: 0 });
      const endDt = startDt.plus({ minutes: duration });

      // Build a description that lists every planned meal for the week.
      const mealLines = meals.map((m) => {
        const mealDate = DateTime.fromISO(m.date).toFormat('EEE LLL d');
        return `• ${mealDate} ${m.meal_type}: ${m.title}`;
      });
      const description = [
        'Meal prep for the week. Planned meals:',
        '',
        ...mealLines,
        '',
        'Scheduled from Nexus Hub iOS — Cooking skill.',
      ].join('\n');

      const title = meals.length === 1
        ? `Meal prep — ${meals[0].title}`
        : `Meal prep — ${meals.length} meals`;

      // unified-calendar uses ISO strings that the underlying Google
      // API interprets with the event's timeZone field. Our helper
      // passes config.app.timezone for the timeZone, so ISO without
      // offset works correctly.
      const startIso = startDt.toISO() || startDt.toFormat("yyyy-LL-dd'T'HH:mm:ss");
      const endIso = endDt.toISO() || endDt.toFormat("yyyy-LL-dd'T'HH:mm:ss");
      const secretaryDecision = submitCookingMealPrepSchedulingIntent({
        userId,
        tenantId: tenantId ?? userId,
        week,
        title,
        startIso,
        endIso,
        durationMinutes: duration,
        mealCount: meals.length,
      });
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

      const event = await createCalendarEvent({
        title,
        start: secretaryDecision.selectedSlot.start,
        end: secretaryDecision.selectedSlot.end,
        description,
      }, undefined, userId);

      logger.info(
        { userId, week, eventId: event.id, mealCount: meals.length, source: event.source },
        'iOS meal prep calendar event created',
      );
      try {
        await createNotificationIntent({
          userId,
          tenantId: tenantId ?? userId,
          sourceSkill: 'cooking',
          type: 'reminder',
          priority: 'active',
          relatedEntityId: event.id,
          relatedEntityType: 'meal_prep_block',
          title: 'Meal prep reminder',
          body: `${meals.length} meal prep block scheduled.`,
          sensitiveBody: description,
          actionButtons: [
            { id: 'open_detail', label: 'Open', style: 'primary' },
            { id: 'not_now', label: 'Not now', style: 'secondary' },
          ],
          deeplink: `nexus://cooking/meal-plan/${encodeURIComponent(week)}`,
          dedupeKey: `cooking:meal-prep:${userId}:${week}:${event.id}`,
          privacyPolicy: 'standard',
        });
      } catch (notificationErr) {
        logger.warn({ err: notificationErr, userId, week, eventId: event.id }, 'Cooking notification intent emit failed');
      }
      invalidateCookingDerivedCaches(userId, { includeCalendarSurfaces: true });

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
