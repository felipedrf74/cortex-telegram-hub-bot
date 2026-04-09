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
  deleteRecipe,
  setMealPlan,
  getMealPlan,
  deleteMealPlan,
  generateShoppingList,
  getShoppingList,
  type Ingredient,
} from '../../services/cooking-chef';

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

  return router;
}
