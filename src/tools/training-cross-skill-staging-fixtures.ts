// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { initDatabase, getDb, closeDatabase } from '../services/database';
import { getUserById } from '../services/user-service';
import { addTransaction } from '../services/finance-tracker';
import { createPlan, createSession, createWeek, deletePlanHard } from '../services/training-plans';

const FIXTURE_PREFIX = '[NEXUS TRAINING CROSS-SKILL STAGING]';
const FIXTURE_SOURCE = 'training-cross-skill-staging-fixtures';

export type FixtureMode = 'seed' | 'cleanup' | 'status';

export interface FixtureReport {
  mode: FixtureMode;
  userId: number;
  startedAt: string;
  finishedAt: string;
  financeRowsRemoved?: number;
  financeRowsCreated?: number;
  planIdsRemoved?: number[];
  planIdCreated?: number;
  weekIdCreated?: number;
  sessionIdCreated?: number;
  activeFixturePlans: number;
  activeFixtureFinanceRows: number;
}

export function parseFixtureMode(argv: string[] = process.argv): FixtureMode {
  if (argv.includes('--cleanup')) return 'cleanup';
  if (argv.includes('--status')) return 'status';
  return 'seed';
}

export function parseFixtureUserId(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRAINING_CROSS_SKILL_STAGING_USER_ID;
  const userId = Number(raw);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id> is required.');
  }
  return userId;
}

export function assertStagingFixtureGate(mode: FixtureMode, env: NodeJS.ProcessEnv = process.env): void {
  const stagingMode = env.STAGING === 'true' || env.NODE_ENV === 'staging';
  if (!stagingMode || env.NODE_ENV === 'production') {
    throw new Error('Refusing fixture writes outside staging mode.');
  }
  if (env.TRAINING_CROSS_SKILL_STAGING_SMOKE !== '1') {
    throw new Error('TRAINING_CROSS_SKILL_STAGING_SMOKE=1 is required.');
  }
  const dbPath = env.DATABASE_PATH ?? '';
  if (!dbPath) {
    throw new Error('DATABASE_PATH=<staging database path> is required.');
  }
  if (!/staging|stage|test/i.test(dbPath) && env.TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB !== '1') {
    throw new Error('DATABASE_PATH must look like a staging/test database.');
  }
  if (mode !== 'status' && env.TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE !== '1') {
    throw new Error('TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE=1 is required for seed/cleanup.');
  }
}

function countFixtureFinanceRows(userId: number): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM finance_transactions
    WHERE user_id = ?
      AND description LIKE ?
  `).get(userId, `${FIXTURE_PREFIX}%`) as { n: number } | undefined;
  return row?.n ?? 0;
}

function findFixturePlanIds(userId: number): number[] {
  const rows = getDb().prepare(`
    SELECT id
    FROM fitness_training_plans
    WHERE user_id = ?
      AND (
        name LIKE ?
        OR preferences_json LIKE ?
      )
    ORDER BY id ASC
  `).all(userId, `${FIXTURE_PREFIX}%`, `%"source":"${FIXTURE_SOURCE}"%`) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

function cleanupFixtures(userId: number): Pick<FixtureReport, 'financeRowsRemoved' | 'planIdsRemoved'> {
  const db = getDb();
  const planIds = findFixturePlanIds(userId);
  const financeRowsRemoved = db.prepare(`
    DELETE FROM finance_transactions
    WHERE user_id = ?
      AND description LIKE ?
  `).run(userId, `${FIXTURE_PREFIX}%`).changes;

  const planIdsRemoved: number[] = [];
  for (const planId of planIds) {
    const result = deletePlanHard(planId, userId);
    if (result.ok) planIdsRemoved.push(planId);
  }

  return { financeRowsRemoved, planIdsRemoved };
}

function seedFixtures(userId: number): Pick<
  FixtureReport,
  'financeRowsRemoved' | 'financeRowsCreated' | 'planIdsRemoved' | 'planIdCreated' | 'weekIdCreated' | 'sessionIdCreated'
> {
  const removed = cleanupFixtures(userId);
  const zone = process.env.TZ || 'Europe/Lisbon';
  const now = DateTime.now().setZone(zone);
  const month = now.toFormat('yyyy-MM');
  const weekStart = now.startOf('week');
  const weekEnd = weekStart.plus({ days: 6 });
  const sessionDay = now.toFormat('cccc');

  addTransaction(userId, `${month}-02`, 'income', 1000, {
    subcategory: 'staging-smoke',
    currency: 'EUR',
    description: `${FIXTURE_PREFIX} income baseline for tight budget proof`,
  });
  addTransaction(userId, `${month}-03`, 'expense', 930, {
    subcategory: 'staging-smoke',
    currency: 'EUR',
    description: `${FIXTURE_PREFIX} expense pressure for tight budget proof`,
  });

  const plan = createPlan({
    user_id: userId,
    name: `${FIXTURE_PREFIX} Hybrid milestone proof`,
    sport: 'aaa-cross-skill-smoke',
    goal: 'prove Training can expose cross-skill staging signals',
    duration_weeks: 1,
    periodization: 'staging-smoke',
    start_date: weekStart.toISODate()!,
    end_date: weekEnd.toISODate()!,
    preferences_json: JSON.stringify({
      source: FIXTURE_SOURCE,
      purpose: 'cross-skill staging smoke',
      createdAt: now.toUTC().toISO(),
    }),
  });
  const week = createWeek({
    plan_id: plan.id,
    week_number: 1,
    focus: 'Cross-skill proof block',
    intensity_pct: 85,
    volume_sessions: 1,
    notes: `${FIXTURE_PREFIX} temporary week for staging smoke`,
  });
  const session = createSession({
    week_id: week.id,
    plan_id: plan.id,
    day_of_week: sessionDay,
    session_type: 'running',
    title: `${FIXTURE_PREFIX} Threshold run content proof`,
    description: 'Temporary hard session for cross-skill staging smoke content milestone proof.',
    duration_minutes: 45,
    intensity_text: 'threshold hard',
    status: 'pending',
    session_identity_key: `xskill-staging:${userId}:${plan.id}:${week.id}`,
    session_shape_hash: 'sha256:xskill-staging-threshold-proof',
  });

  return {
    ...removed,
    financeRowsCreated: 2,
    planIdCreated: plan.id,
    weekIdCreated: week.id,
    sessionIdCreated: session.id,
  };
}

function summarize(mode: FixtureMode, userId: number, startedAt: string, extra: Partial<FixtureReport> = {}): FixtureReport {
  return {
    mode,
    userId,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...extra,
    activeFixturePlans: findFixturePlanIds(userId).length,
    activeFixtureFinanceRows: countFixtureFinanceRows(userId),
  };
}

async function main(): Promise<void> {
  const envFile = process.env.TRAINING_CROSS_SKILL_STAGING_ENV_FILE;
  dotenv.config(envFile ? { path: envFile } : undefined);
  const startedAt = new Date().toISOString();
  const mode = parseFixtureMode();
  const userId = parseFixtureUserId();
  assertStagingFixtureGate(mode);

  initDatabase();
  try {
    const user = getUserById(userId);
    if (!user) throw new Error(`Staging user ${userId} does not exist.`);

    const extra = mode === 'seed'
      ? seedFixtures(userId)
      : mode === 'cleanup'
        ? cleanupFixtures(userId)
        : {};
    const report = summarize(mode, userId, startedAt, extra);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Training cross-skill staging fixture tool failed: ${message}\n`);
    process.exitCode = 1;
  });
}
