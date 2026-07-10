import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const ROUTE_ROOT = path.resolve(__dirname, '../../src/api/routes');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
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

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime-only extensions; tests assert the
        // guardrail contract, not every unrelated migration side effect.
      }
    }
  }
}

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

import { enforceCostGuardrails, _resetUserCostLocksForTests } from '../../src/services/cost-guardrail';

describe('global cost guardrail for REST AI routes', () => {
  beforeEach(() => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
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

    const decision = enforceCostGuardrails(25);

    expect(decision).toMatchObject({
      block: true,
      status: 429,
      reason: 'SERVICE_DEGRADED',
    });
  });

  it('distinguishes per-user daily quota exhaustion from global degradation', () => {
    seedUsage(28, 0.05);
    seedUsage(25, 0.61);

    const decision = enforceCostGuardrails(25);

    expect(decision).toMatchObject({
      block: true,
      status: 429,
      reason: 'AI_DAILY_LIMIT_REACHED',
    });
  });

  it('allows clean routes under both global and per-user caps', () => {
    seedUsage(25, 0.05);

    const decision = enforceCostGuardrails(25);

    expect(decision).toMatchObject({
      block: false,
      status: 200,
      reason: 'ok',
    });
  });

  it('keeps app-facing provider entry points on the canonical reservation APIs', () => {
    const callbackWrappedFiles = [
      'attachments.ts',
      'training.ts',
      'content-script-routes.ts',
      'finance.ts',
      'internal.ts',
    ];

    for (const file of callbackWrappedFiles) {
      const source = fs.readFileSync(path.join(ROUTE_ROOT, file), 'utf8');
      expect(source, `${file} should use the classified SQLite budget reservation`).toContain('withAiBudgetReservation');
    }
    const chatSource = fs.readFileSync(path.join(ROUTE_ROOT, 'chat-message-routes.ts'), 'utf8');
    expect(chatSource).toContain('acquireAiBudgetReservation');

    const deterministicTrainingPlan = fs.readFileSync(path.join(ROUTE_ROOT, 'training-plan-routes.ts'), 'utf8');
    expect(deterministicTrainingPlan).toContain('Plan generation is deterministic and token-zero');
    expect(deterministicTrainingPlan).not.toContain('enforceCostGuardrails');
    expect(deterministicTrainingPlan).not.toContain('acquireCostLock');
  });

  it('keeps iOS WebSocket token-zero work before the model reservation', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf8');
    const tokenZeroIndex = source.indexOf('if (await trySendTokenZeroSecretaryRead(ws');
    const actionPlanIndex = source.indexOf('const deterministicAction = await tryHandleChatActionPlan');
    const reservationIndex = source.indexOf('await withAiBudgetReservation({');
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
