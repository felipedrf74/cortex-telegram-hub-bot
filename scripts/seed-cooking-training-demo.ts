#!/usr/bin/env npx tsx

import * as dotenv from 'dotenv';
dotenv.config();

import { DateTime } from 'luxon';
import { initDatabase, getDb, closeDatabase } from '../src/services/database';
import { getUserById } from '../src/services/user-service';
import { addRecipe, generateShoppingList, setMealPlan } from '../src/services/cooking-chef';
import { createPlan, createSession, createWeek } from '../src/services/training-plans';
import { publishHighLegLoad } from '../src/services/training-signals';

interface CliArgs {
  userId: number;
}

function parseArgs(): CliArgs {
  const userFlag = process.argv.indexOf('--user-id');
  const rawUserId = userFlag >= 0 ? process.argv[userFlag + 1] : undefined;
  const userId = Number.parseInt(rawUserId ?? '12', 10);

  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('Usage: npx tsx scripts/seed-cooking-training-demo.ts --user-id <number>');
  }

  return { userId };
}

function clearUserCookingAndTrainingState(userId: number): void {
  const db = getDb();
  const planIds = db.prepare('SELECT id FROM fitness_training_plans WHERE user_id = ?').all(userId) as Array<{ id: number }>;

  db.prepare('DELETE FROM shopping_lists WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM meal_plans WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM recipes WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM agent_signals WHERE user_id = ?').run(userId);

  for (const planId of planIds) {
    db.prepare('DELETE FROM training_completions WHERE plan_id = ?').run(planId.id);
    db.prepare('DELETE FROM training_sessions WHERE plan_id = ?').run(planId.id);
    db.prepare('DELETE FROM training_weeks WHERE plan_id = ?').run(planId.id);
  }

  db.prepare('DELETE FROM fitness_training_plans WHERE user_id = ?').run(userId);
}

function seedCookingTrainingDemo(userId: number): void {
  const user = getUserById(userId);
  if (!user) {
    throw new Error(`User ${userId} not found. Sign in once in the iOS app first, then rerun this seed.`);
  }

  clearUserCookingAndTrainingState(userId);

  const zone = user.timezone || 'Europe/Lisbon';
  const now = DateTime.now().setZone(zone);
  const today = now.toISODate()!;
  const tomorrow = now.plus({ days: 1 }).toISODate()!;
  const weekStart = now.startOf('week').toISODate()!;
  const tomorrowWeekStart = now.plus({ days: 1 }).startOf('week').toISODate()!;
  const weekEnd = now.startOf('week').plus({ days: 13 }).toISODate()!;
  const todayName = now.toFormat('EEEE');
  const tomorrowName = now.plus({ days: 1 }).toFormat('EEEE');

  const breakfastRecipe = addRecipe(userId, 'Aveia com banana e mel', [
    { name: 'Aveia', quantity: '80', unit: 'g' },
    { name: 'Banana', quantity: '1', unit: 'un' },
    { name: 'Mel', quantity: '1', unit: 'c.sopa' },
  ], {
    prepTime: 5,
    servings: 1,
    tags: 'breakfast,performance',
  });

  const lunchRecipe = addRecipe(userId, 'Bowl de arroz com frango', [
    { name: 'Arroz', quantity: '140', unit: 'g' },
    { name: 'Frango', quantity: '180', unit: 'g' },
    { name: 'Legumes', quantity: '1', unit: 'dose' },
  ], {
    prepTime: 20,
    servings: 1,
    tags: 'lunch,recovery',
  });

  const dinnerRecipe = addRecipe(userId, 'Frango com arroz e legumes', [
    { name: 'Frango', quantity: '220', unit: 'g' },
    { name: 'Arroz', quantity: '120', unit: 'g' },
    { name: 'Legumes', quantity: '1', unit: 'dose' },
  ], {
    prepTime: 35,
    servings: 1,
    tags: 'dinner,recovery',
  });

  const tomorrowBreakfastRecipe = addRecipe(userId, 'Papas de aveia com frutos vermelhos', [
    { name: 'Aveia', quantity: '85', unit: 'g' },
    { name: 'Frutos vermelhos', quantity: '120', unit: 'g' },
    { name: 'Iogurte grego', quantity: '150', unit: 'g' },
  ], {
    prepTime: 8,
    servings: 1,
    tags: 'breakfast,training-day',
  });

  const tomorrowDinnerRecipe = addRecipe(userId, 'Salmão com batata-doce', [
    { name: 'Salmão', quantity: '200', unit: 'g' },
    { name: 'Batata-doce', quantity: '250', unit: 'g' },
    { name: 'Espargos', quantity: '1', unit: 'molho' },
  ], {
    prepTime: 30,
    servings: 1,
    tags: 'dinner,training-day',
  });

  setMealPlan(userId, today, 'breakfast', breakfastRecipe.title, {
    recipeId: breakfastRecipe.id,
    notes: 'Pré-intervalos',
  });
  setMealPlan(userId, today, 'lunch', lunchRecipe.title, {
    recipeId: lunchRecipe.id,
    notes: 'Mantém os hidratos consistentes antes do treino',
  });
  setMealPlan(userId, today, 'dinner', dinnerRecipe.title, {
    recipeId: dinnerRecipe.id,
    notes: 'Depois do treino de pernas',
  });
  setMealPlan(userId, tomorrow, 'breakfast', tomorrowBreakfastRecipe.title, {
    recipeId: tomorrowBreakfastRecipe.id,
    notes: 'Abastece a sessão de amanhã',
  });
  setMealPlan(userId, tomorrow, 'dinner', tomorrowDinnerRecipe.title, {
    recipeId: tomorrowDinnerRecipe.id,
    notes: 'Fecho do dia antes do bloco intenso',
  });

  const plan = createPlan({
    user_id: userId,
    name: 'Cooking demo training week',
    sport: 'running',
    duration_weeks: 2,
    start_date: weekStart,
    end_date: weekEnd,
    periodization: 'dynamic',
  });
  const weekOne = createWeek({
    plan_id: plan.id,
    week_number: 1,
    focus: 'Fueling alignment',
    intensity_pct: 100,
    volume_sessions: 2,
    notes: 'Demo week for cooking-training validation',
  });
  const weekTwo = createWeek({
    plan_id: plan.id,
    week_number: 2,
    focus: 'Carry-over week',
    intensity_pct: 90,
    volume_sessions: 2,
  });

  createSession({
    week_id: weekOne.id,
    plan_id: plan.id,
    day_of_week: todayName,
    session_type: 'running',
    title: 'Track intervals',
    intensity_text: 'VO2 intervals',
    duration_minutes: 55,
  });
  createSession({
    week_id: tomorrowWeekStart == weekStart ? weekOne.id : weekTwo.id,
    plan_id: plan.id,
    day_of_week: tomorrowName,
    session_type: 'cycling',
    title: 'Tempo ride',
    intensity_text: 'threshold blocks',
    duration_minutes: 70,
  });

  publishHighLegLoad({
    userId,
    source: 'gym',
    rpe: 9,
    details: {
      lifts: ['squat', 'romanian deadlift'],
      notes: 'Demo seed for recovery dinner adaptation',
    },
  });

  generateShoppingList(userId, weekStart);
  if (tomorrowWeekStart != weekStart) {
    generateShoppingList(userId, tomorrowWeekStart);
  }

  console.log(`Seeded cooking/training demo for user #${userId}`);
  console.log(`Week: ${weekStart} -> ${DateTime.fromISO(weekStart).plus({ days: 6 }).toISODate()}`);
  console.log(`Meals: breakfast/lunch/dinner today + breakfast/dinner tomorrow`);
  console.log('Training: hard running today, hard cycling tomorrow, heavy leg-load signal active');
}

function main(): void {
  const { userId } = parseArgs();
  initDatabase();
  try {
    seedCookingTrainingDemo(userId);
  } finally {
    closeDatabase();
  }
}

main();
