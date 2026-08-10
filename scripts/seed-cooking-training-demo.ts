#!/usr/bin/env npx tsx

import * as dotenv from 'dotenv';
dotenv.config();

import { DateTime } from 'luxon';
import { config } from '../src/config';
import { getDb, closeDatabase } from '../src/services/database';
import { initDatabase } from '../src/services/database-bootstrap';
import { getUserById } from '../src/services/user-service';
import { addRecipe, generateShoppingList, setMealPlan } from '../src/services/cooking-chef';
import { createPlan, createSession, createWeek } from '../src/services/training-plans';
import { publishHighLegLoad } from '../src/services/training-signals';

interface CliArgs {
  userId: number;
  tenantId: number;
  destructiveDemo: boolean;
}

export function parseArgs(argv = process.argv): CliArgs {
  const userId = readRequiredPositiveIntFlag(argv, '--user-id');
  const tenantId = readRequiredPositiveIntFlag(argv, '--tenant-id');
  const destructiveDemo = argv.includes('--destructive-demo');

  return { userId, tenantId, destructiveDemo };
}

function readRequiredPositiveIntFlag(argv: string[], flag: string): number {
  const index = argv.indexOf(flag);
  const rawValue = index >= 0 ? argv[index + 1] : undefined;
  const value = Number.parseInt(rawValue ?? '', 10);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      'Usage: npx tsx scripts/seed-cooking-training-demo.ts --user-id <number> --tenant-id <number> --destructive-demo',
    );
  }

  return value;
}

export function assertDemoSeedAllowed(
  destructiveDemo: boolean,
  dbPath = config.app.databasePath || './data/bot.db',
  nodeEnv = process.env.NODE_ENV ?? '',
): void {
  const normalizedPath = dbPath.toLowerCase();
  const normalizedNodeEnv = nodeEnv.toLowerCase();
  const isDefaultDb = dbPath === './data/bot.db' || normalizedPath.endsWith('/data/bot.db');
  const looksProduction = normalizedNodeEnv === 'production' || /\b(prod|production)\b/.test(normalizedPath);

  if ((isDefaultDb || looksProduction) && !destructiveDemo) {
    throw new Error(
      `Refusing to seed destructive cooking demo data against "${dbPath}". Pass --destructive-demo after confirming this is not production data.`,
    );
  }
}

export function clearUserCookingAndTrainingState(userId: number, tenantId: number): void {
  const db = getDb();
  const clearScopedState = db.transaction(() => {
    const planIds = db.prepare(
      'SELECT id FROM fitness_training_plans WHERE user_id = ? AND tenant_id = ?',
    ).all(userId, tenantId) as Array<{ id: number }>;

    db.prepare('DELETE FROM shopping_lists WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM meal_plans WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM recipes WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM agent_signals WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);

    for (const planId of planIds) {
      db.prepare('DELETE FROM training_completions WHERE plan_id = ?').run(planId.id);
      db.prepare('DELETE FROM training_sessions WHERE plan_id = ?').run(planId.id);
      db.prepare('DELETE FROM training_weeks WHERE plan_id = ?').run(planId.id);
    }

    db.prepare('DELETE FROM fitness_training_plans WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
  });

  clearScopedState();
}

export function seedCookingTrainingDemo(userId: number, tenantId: number): void {
  const user = getUserById(userId);
  if (!user) {
    throw new Error(`User ${userId} not found. Sign in once in the iOS app first, then rerun this seed.`);
  }

  clearUserCookingAndTrainingState(userId, tenantId);

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
    tenantId,
  });

  const lunchRecipe = addRecipe(userId, 'Bowl de arroz com frango', [
    { name: 'Arroz', quantity: '140', unit: 'g' },
    { name: 'Frango', quantity: '180', unit: 'g' },
    { name: 'Legumes', quantity: '1', unit: 'dose' },
  ], {
    prepTime: 20,
    servings: 1,
    tags: 'lunch,recovery',
    tenantId,
  });

  const dinnerRecipe = addRecipe(userId, 'Frango com arroz e legumes', [
    { name: 'Frango', quantity: '220', unit: 'g' },
    { name: 'Arroz', quantity: '120', unit: 'g' },
    { name: 'Legumes', quantity: '1', unit: 'dose' },
  ], {
    prepTime: 35,
    servings: 1,
    tags: 'dinner,recovery',
    tenantId,
  });

  const tomorrowBreakfastRecipe = addRecipe(userId, 'Papas de aveia com frutos vermelhos', [
    { name: 'Aveia', quantity: '85', unit: 'g' },
    { name: 'Frutos vermelhos', quantity: '120', unit: 'g' },
    { name: 'Iogurte grego', quantity: '150', unit: 'g' },
  ], {
    prepTime: 8,
    servings: 1,
    tags: 'breakfast,training-day',
    tenantId,
  });

  const tomorrowDinnerRecipe = addRecipe(userId, 'Salmão com batata-doce', [
    { name: 'Salmão', quantity: '200', unit: 'g' },
    { name: 'Batata-doce', quantity: '250', unit: 'g' },
    { name: 'Espargos', quantity: '1', unit: 'molho' },
  ], {
    prepTime: 30,
    servings: 1,
    tags: 'dinner,training-day',
    tenantId,
  });

  setMealPlan(userId, today, 'breakfast', breakfastRecipe.title, {
    recipeId: breakfastRecipe.id,
    notes: 'Pré-intervalos',
    tenantId,
  });
  setMealPlan(userId, today, 'lunch', lunchRecipe.title, {
    recipeId: lunchRecipe.id,
    notes: 'Mantém os hidratos consistentes antes do treino',
    tenantId,
  });
  setMealPlan(userId, today, 'dinner', dinnerRecipe.title, {
    recipeId: dinnerRecipe.id,
    notes: 'Depois do treino de pernas',
    tenantId,
  });
  setMealPlan(userId, tomorrow, 'breakfast', tomorrowBreakfastRecipe.title, {
    recipeId: tomorrowBreakfastRecipe.id,
    notes: 'Abastece a sessão de amanhã',
    tenantId,
  });
  setMealPlan(userId, tomorrow, 'dinner', tomorrowDinnerRecipe.title, {
    recipeId: tomorrowDinnerRecipe.id,
    notes: 'Fecho do dia antes do bloco intenso',
    tenantId,
  });

  const plan = createPlan({
    user_id: userId,
    tenant_id: tenantId,
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
    tenantId,
    source: 'gym',
    rpe: 9,
    details: {
      lifts: ['squat', 'romanian deadlift'],
      notes: 'Demo seed for recovery dinner adaptation',
    },
  });

  generateShoppingList(userId, weekStart, tenantId);
  if (tomorrowWeekStart != weekStart) {
    generateShoppingList(userId, tomorrowWeekStart, tenantId);
  }

  console.log(`Seeded cooking/training demo for user #${userId} tenant #${tenantId}`);
  console.log(`Week: ${weekStart} -> ${DateTime.fromISO(weekStart).plus({ days: 6 }).toISODate()}`);
  console.log(`Meals: breakfast/lunch/dinner today + breakfast/dinner tomorrow`);
  console.log('Training: hard running today, hard cycling tomorrow, heavy leg-load signal active');
}

export function main(): void {
  const { userId, tenantId, destructiveDemo } = parseArgs();
  assertDemoSeedAllowed(destructiveDemo);
  initDatabase();
  try {
    const runSeed = getDb().transaction(() => seedCookingTrainingDemo(userId, tenantId));
    runSeed();
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  main();
}
