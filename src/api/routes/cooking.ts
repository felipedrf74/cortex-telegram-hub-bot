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
 *   DELETE /meal-plan?date=&mealType=    — clear one meal plan slot
 *   GET    /shopping-list?week=          — fetch the shopping list for a week
 *   POST   /shopping-list/generate       — (re)generate from the week's meal plan
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
  getMealPlan,
  deleteMealPlan,
  generateShoppingList,
  getShoppingList,
  type Ingredient,
  type Recipe,
} from '../../services/cooking-chef';
import { createEvent as createCalendarEvent, isAnyCalendarConfigured } from '../../services/unified-calendar';
import { DateTime } from 'luxon';
import { config } from '../../config';

export function cookingRoutes(): Router {
  const router = Router();

  // ── Recipes ────────────────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/recipes?search=&tags=&limit=
   * List the user's recipes, newest first.
   */
  router.get('/recipes', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const tags = typeof req.query.tags === 'string' ? req.query.tags : undefined;
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 20, 100)
      : 20;

    try {
      const recipes = getRecipes(userId, { search, tags, limit });
      sendSuccess(res, { recipes, count: recipes.length });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS cooking recipes list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch recipes', 500);
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
    const { userId } = req as AuthenticatedRequest;
    const { title, ingredients, instructions, prepTime, cookTime, servings, tags, source } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      sendError(res, 'BAD_REQUEST', 'title is required');
      return;
    }
    if (!Array.isArray(ingredients)) {
      sendError(res, 'BAD_REQUEST', 'ingredients must be an array');
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
      });
      logger.info({ userId, recipeId: recipe.id }, 'iOS recipe created');
      sendSuccess(res, { recipe }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS cooking recipe create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to create recipe', 500);
    }
  }));

  /**
   * GET /api/v1/cooking/recipes/:id
   * Fetch a single recipe. Used by the iOS RecipeDetailView when
   * the user taps a row from the recipes list.
   */
  router.get('/recipes/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const recipeId = parseInt(req.params.id, 10);

    if (Number.isNaN(recipeId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const recipe = getRecipeById(userId, recipeId);
      if (!recipe) {
        sendError(res, 'NOT_FOUND', 'Recipe not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { recipe });
    } catch (err: any) {
      logger.error({ err, userId, recipeId }, 'iOS cooking recipe fetch failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch recipe', 500);
    }
  }));

  /**
   * PATCH /api/v1/cooking/recipes/:id
   * Partial update. Only the fields present in the body are written.
   * Returns 404 on missing or cross-user recipes.
   */
  router.patch('/recipes/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const recipeId = parseInt(req.params.id, 10);
    const { title, ingredients, instructions, prepTime, cookTime, servings, tags, source } = req.body;

    if (Number.isNaN(recipeId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    // Reject completely-empty bodies.
    if (title === undefined && ingredients === undefined && instructions === undefined
        && prepTime === undefined && cookTime === undefined && servings === undefined
        && tags === undefined && source === undefined) {
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
      });
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Recipe not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { recipe: updated });
    } catch (err: any) {
      logger.error({ err, userId, recipeId }, 'iOS cooking recipe update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update recipe', 500);
    }
  }));

  /**
   * DELETE /api/v1/cooking/recipes/:id
   */
  router.delete('/recipes/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const recipeId = parseInt(req.params.id, 10);

    if (Number.isNaN(recipeId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const deleted = deleteRecipe(userId, recipeId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Recipe not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { deleted: true, id: recipeId });
    } catch (err: any) {
      logger.error({ err, userId, recipeId }, 'iOS cooking recipe delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete recipe', 500);
    }
  }));

  // ── Meal Planning ──────────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/meal-plan?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Returns all meal plan entries for the given date range.
   */
  router.get('/meal-plan', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;

    if (!from || !to) {
      sendError(res, 'BAD_REQUEST', 'from and to query params are required (YYYY-MM-DD)');
      return;
    }

    try {
      const plans = getMealPlan(userId, from, to);
      sendSuccess(res, { meals: plans, count: plans.length, from, to });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS cooking meal-plan list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch meal plan', 500);
    }
  }));

  /**
   * POST /api/v1/cooking/meal-plan
   * Body: { date, mealType, title, recipeId?, notes? }
   * Upserts one meal plan slot (unique on user+date+mealType).
   */
  router.post('/meal-plan', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { date, mealType, title, recipeId, notes } = req.body;

    if (!date || !mealType || !title) {
      sendError(res, 'BAD_REQUEST', 'date, mealType, and title are required');
      return;
    }

    try {
      const plan = setMealPlan(userId, date, mealType, title, { recipeId, notes });
      sendSuccess(res, { meal: plan });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS cooking meal-plan set failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to save meal plan', 500);
    }
  }));

  /**
   * DELETE /api/v1/cooking/meal-plan?date=&mealType=
   */
  router.delete('/meal-plan', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const mealType = typeof req.query.mealType === 'string' ? req.query.mealType : undefined;

    if (!date || !mealType) {
      sendError(res, 'BAD_REQUEST', 'date and mealType query params are required');
      return;
    }

    try {
      const deleted = deleteMealPlan(userId, date, mealType);
      sendSuccess(res, { deleted, date, mealType });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS cooking meal-plan delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete meal plan', 500);
    }
  }));

  // ── Shopping List ──────────────────────────────────────────────────

  /**
   * GET /api/v1/cooking/shopping-list?week=YYYY-MM-DD
   * Returns the stored shopping list for the given week, or null.
   */
  router.get('/shopping-list', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const week = typeof req.query.week === 'string' ? req.query.week : undefined;

    if (!week) {
      sendError(res, 'BAD_REQUEST', 'week query param is required (YYYY-MM-DD)');
      return;
    }

    try {
      const list = getShoppingList(userId, week);
      sendSuccess(res, { list });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS cooking shopping-list get failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch shopping list', 500);
    }
  }));

  /**
   * POST /api/v1/cooking/shopping-list/generate
   * Body: { week: YYYY-MM-DD }
   * Rebuilds the shopping list by aggregating ingredients from every
   * meal plan entry in the week. Overwrites any existing list for that week.
   */
  router.post('/shopping-list/generate', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { week } = req.body;

    if (!week || typeof week !== 'string') {
      sendError(res, 'BAD_REQUEST', 'week is required in the body (YYYY-MM-DD)');
      return;
    }

    try {
      const list = generateShoppingList(userId, week);
      logger.info({ userId, week, itemCount: list.items.length }, 'iOS shopping list generated');
      sendSuccess(res, { list });
    } catch (err: any) {
      logger.error({ err, userId, week }, 'iOS cooking shopping-list generate failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to generate shopping list', 500);
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
    const { userId } = req as AuthenticatedRequest;
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
      const meals = getMealPlan(userId, week, weekEnd);

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
      const event = await createCalendarEvent({
        title,
        start: startDt.toISO() || startDt.toFormat("yyyy-LL-dd'T'HH:mm:ss"),
        end: endDt.toISO() || endDt.toFormat("yyyy-LL-dd'T'HH:mm:ss"),
        description,
      });

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
        mealCount: meals.length,
      });
    } catch (err: any) {
      logger.error({ err, userId, week }, 'iOS meal prep event creation failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to create prep event', 500);
    }
  }));

  return router;
}
