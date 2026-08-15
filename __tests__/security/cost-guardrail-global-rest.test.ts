import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const ROUTE_ROOT = path.resolve(__dirname, '../../src/api/routes');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    billing: { paywallEnabled: true },
    aiSafety: { globalDailyLimitUsd: 10.0, alertThresholdPercent: 0.8 },
    telegram: { allowedUserIds: [] },
    app: { timezone: 'UTC' },
  },
}));

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service');
  return {
    ...actual,
    isOwnerUserRef: vi.fn(() => false),
  };
});

vi.mock('../../src/services/operator-alerts', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/operator-alerts')>('../../src/services/operator-alerts');
  return {
    ...actual,
    recordOperatorAlert: vi.fn(),
  };
});


function seedUser(userId: number, plan: 'pro' | 'max' = 'pro'): void {
  testDb.prepare(`
    INSERT INTO users (id, first_name, status, tier, auth_provider)
    VALUES (?, ?, 'active', ?, 'email')
  `).run(userId, `User ${userId}`, plan);
  testDb.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, status, provider, current_period_start, current_period_end
    )
    VALUES (?, ?, 'active', 'stripe', datetime('now', '-1 day'), datetime('now', '+29 days'))
  `).run(userId, plan);
}

function seedUsage(userId: number, amount: number): void {
  testDb.prepare(`
    INSERT INTO api_usage (user_id, tenant_id, category, model, cost_usd, ts)
    VALUES (?, ?, 'test', 'mock', ?, datetime('now'))
  `).run(userId, userId, amount);
}

import { checkAiBudget, _resetUserCostLocksForTests } from '../../src/services/cost-guardrail';

function interactiveDecision(userId: number) {
  return checkAiBudget({
    userId,
    requestSource: 'interactive',
    baseCategory: 'chat_secretary',
  });
}

describe('global cost guardrail for REST AI routes', () => {
  beforeEach(() => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    testDb = createMigratedTestDatabase();
    seedUser(25, 'max');
    seedUser(28, 'pro');
  });

  afterEach(() => {
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
    _resetUserCostLocksForTests();
    testDb.close();
  });

  it('blocks AI routes with SERVICE_DEGRADED when global daily spend is exhausted', () => {
    seedUsage(28, 11.0);

    const decision = interactiveDecision(25);

    expect(decision).toMatchObject({
      allowed: false,
      status: 429,
      code: 'SERVICE_DEGRADED',
    });
  });

  it('distinguishes per-user daily quota exhaustion from global degradation', () => {
    seedUsage(28, 0.05);
    seedUsage(25, 0.61);

    const decision = interactiveDecision(25);

    expect(decision).toMatchObject({
      allowed: false,
      status: 429,
      code: 'AI_DAILY_LIMIT_REACHED',
    });
  });

  it('allows clean routes under both global and per-user caps', () => {
    seedUsage(25, 0.05);

    const decision = interactiveDecision(25);

    expect(decision).toMatchObject({
      allowed: true,
      status: 200,
      code: 'OK',
    });
  });

  it('keeps app-facing provider entry points on the canonical reservation APIs', () => {
    const callbackWrappedFiles = [
      'attachments.ts',
      'content-script-routes.ts',
      'finance.ts',
      'internal.ts',
    ];

    for (const file of callbackWrappedFiles) {
      const source = fs.readFileSync(path.join(ROUTE_ROOT, file), 'utf8');
      expect(source, `${file} should use the classified SQLite budget reservation`).toContain('withAiBudgetReservation');
    }
    const trainingSource = fs.readFileSync(path.join(ROUTE_ROOT, 'training.ts'), 'utf8');
    const coachSource = fs.readFileSync(path.resolve(ROUTE_ROOT, '../../services/garmin-coach.ts'), 'utf8');
    expect(trainingSource).toContain("budgetRequestSource: 'interactive'");
    expect(coachSource).toContain('withAiBudgetReservation({');
    const chatSource = fs.readFileSync(path.join(ROUTE_ROOT, 'chat-message-routes.ts'), 'utf8');
    expect(chatSource).toContain('acquireAiBudgetReservation');

    const deterministicTrainingPlan = fs.readFileSync(path.join(ROUTE_ROOT, 'training-plan-routes.ts'), 'utf8');
    expect(deterministicTrainingPlan).toContain('Plan generation is deterministic and token-zero');
    expect(deterministicTrainingPlan).not.toContain('enforceCostGuardrails');
    expect(deterministicTrainingPlan).not.toContain('acquireCostLock');
  });

  it('keeps iOS WebSocket token-zero work before the model reservation', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf8');
    const tokenZeroIndex = source.indexOf('const tokenZeroReadHandled = await runWithSkillInferenceAccountAdmission');
    const actionPlanIndex = source.indexOf('const deterministicAction = await tryHandleChatActionPlan');
    const reservationIndex = source.indexOf('withAiBudgetReservation({');
    const providerRoutingIndex = source.indexOf('const rawRoute = await routeMessage');

    expect(tokenZeroIndex).toBeGreaterThan(-1);
    expect(actionPlanIndex).toBeGreaterThan(-1);
    expect(reservationIndex).toBeGreaterThan(-1);
    expect(providerRoutingIndex).toBeGreaterThan(-1);
    expect(tokenZeroIndex).toBeLessThan(reservationIndex);
    expect(actionPlanIndex).toBeLessThan(reservationIndex);
    expect(reservationIndex).toBeLessThan(providerRoutingIndex);
  });
});
