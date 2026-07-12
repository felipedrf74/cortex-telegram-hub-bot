import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => db,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  isOwnerUserRef: vi.fn(() => false),
}));

vi.mock('../../src/config', () => ({
  config: {
    billing: { paywallEnabled: true },
    aiSafety: { globalDailyLimitUsd: 10, alertThresholdPercent: 0.8 },
    garmin: { email: '', password: '' },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  AiBudgetError,
  assertAiBudgetReservationForProvider,
  checkAiBudget,
  estimateAiBudgetReservationUsd,
  getActiveAiBudgetReservationMarker,
  getDailyQuotaStatus,
  withAiBudgetReservation,
  withSignedOuterAiBudgetReservation,
} from '../../src/services/cost-guardrail';
import { resolveApiUsageAttribution } from '../../src/services/api-usage-attribution';
import { _resetPortalOverridesForTests } from '../../src/services/plan-quotas';
import {
  createInternalAttributionToken,
  verifyInternalAttributionToken,
} from '../../src/services/internal-attribution';
import {
  _resetApiUsagePersistenceFailureForTests,
  getApiUsagePersistenceFailure,
  tripApiUsagePersistenceFailure,
  recordApiUsageTimeoutEstimate,
} from '../../src/services/api-usage-fallback';

function createSchema(): void {
  db.exec(`
    CREATE TABLE subscriptions (
      user_id INTEGER UNIQUE,
      plan TEXT,
      status TEXT,
      provider TEXT,
      current_period_start TEXT,
      current_period_end TEXT
    );
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      category TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'test-model',
      user_id INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      pricing_status TEXT NOT NULL DEFAULT 'legacy',
      request_source TEXT NOT NULL DEFAULT 'interactive',
      job_name TEXT,
      base_category TEXT,
      run_id TEXT
    );
    CREATE TABLE user_ai_budget_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      daily_cost_usd REAL NOT NULL,
      monthly_cost_usd REAL,
      reason TEXT,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE nexus_point_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      points_remaining REAL NOT NULL DEFAULT 0,
      usd_allowance_remaining REAL NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE nexus_point_debits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      api_usage_id INTEGER,
      usd_cost_debited REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE cost_guardrail_locks (
      lock_key TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE ai_budget_deferrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      request_source TEXT NOT NULL,
      job_name TEXT,
      base_category TEXT NOT NULL,
      run_id TEXT,
      code TEXT NOT NULL,
      budget_window TEXT,
      reset_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE report_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      source_job TEXT,
      document_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE user_skill_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      skill TEXT NOT NULL,
      sub_skill TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE content_topic_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER,
      format TEXT NOT NULL,
      source_job TEXT,
      sentiment TEXT NOT NULL DEFAULT 'pending',
      script_generated INTEGER NOT NULL DEFAULT 0,
      converted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE content_scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER,
      scope_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE fitness_training_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE apple_health_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL
    );
  `);
}

function addPaidUser(userId: number, plan: 'pro' | 'max' = 'pro', status: 'active' | 'trialing' = 'active'): void {
  db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, status, provider, current_period_start, current_period_end
    ) VALUES (?, ?, ?, 'stripe', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(userId, plan, status);
}

function makeCoachEligible(userId: number): void {
  db.prepare(`
    INSERT INTO fitness_training_plans (user_id, tenant_id, status)
    VALUES (?, ?, 'active')
  `).run(userId, userId);
  db.prepare(`
    INSERT INTO apple_health_data (user_id, date)
    VALUES (?, date('now'))
  `).run(userId);
}

describe('paid AI budget enforcement', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-09T12:00:00.000Z') });
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
    _resetPortalOverridesForTests();
    _resetApiUsagePersistenceFailureForTests();
    db = new Database(':memory:');
    createSchema();
  });

  afterEach(() => {
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
    delete process.env.SYSTEM_ACTOR_DAILY_USD_CAP;
    _resetApiUsagePersistenceFailureForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    db.close();
  });

  it('computes Free as ineligible while observation mode preserves pre-enforcement behavior', () => {
    const observed = checkAiBudget({
      userId: 10,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    });
    expect(observed.allowed).toBe(true);
    expect(observed.quota.aiAccessAllowed).toBe(false);
    expect(observed.quota.blockReason).toBe('plan_required');
    expect(observed.quota.over).toBe(false);
    expect(observed.quota.dailyOver).toBe(false);
    expect(observed.quota.monthlyOver).toBe(false);
    expect(observed.quota.unblocksAt).toBeNull();

    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    const enforced = checkAiBudget({
      userId: 10,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    });
    expect(enforced).toMatchObject({
      allowed: false,
      status: 403,
      code: 'AI_PLAN_REQUIRED',
      window: 'plan',
    });
  });

  it('preserves the legacy Free daily cap in observation mode without enabling new plan policy', () => {
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-09T10:00:00.000Z', 'chat_secretary', 11, 0.005, 'interactive', 'chat_secretary')
    `).run();

    expect(checkAiBudget({
      userId: 11,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    })).toMatchObject({
      allowed: false,
      code: 'AI_DAILY_LIMIT_REACHED',
      window: 'daily',
      quota: { aiAccessAllowed: false, over: true },
    });

    // New plan/automation/monthly policy remains observe-only below the
    // legacy daily stop.
    expect(checkAiBudget({
      userId: 12,
      requestSource: 'automation',
      baseCategory: 'channel_analysis',
      jobName: 'channel_relearn',
    })).toMatchObject({ allowed: true, code: 'OK' });
  });

  it('preserves the legacy shared system actor $1 daily stop in observation mode', () => {
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-09T10:00:00.000Z', 'autoresearch', 0, 1, 'system', 'autoresearch')
    `).run();

    expect(checkAiBudget({
      userId: 99,
      requestSource: 'system',
      baseCategory: 'autoresearch',
    })).toMatchObject({
      allowed: false,
      code: 'AI_DAILY_LIMIT_REACHED',
      quota: { plan: 'system', over: true },
    });
  });

  it('returns a monthly-specific denial and billing-cycle reset', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(20);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-02T12:00:00.000Z', 'chat_secretary', 20, 1.197, 'interactive', 'chat_secretary')
    `).run();
    const result = checkAiBudget({
      userId: 20,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
      estimatedCostUsd: 0.004,
    });
    expect(result).toMatchObject({
      allowed: false,
      status: 429,
      code: 'AI_MONTHLY_LIMIT_REACHED',
      window: 'monthly',
      unblocksAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('maps entitlement lookup failures to retryable service degradation', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    db.exec('DROP TABLE subscriptions');

    const result = checkAiBudget({
      userId: 19,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    });
    expect(result).toMatchObject({
      allowed: false,
      status: 429,
      code: 'SERVICE_DEGRADED',
      window: 'global',
      internalReason: 'entitlement_error',
    });
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keeps the quota fallback non-blocking in observation mode', () => {
    db.exec('DROP TABLE subscriptions');
    const status = getDailyQuotaStatus(17);
    expect(status.blockReason).toBe('entitlement_error');
    expect(status.over).toBe(false);
    expect(status.dailyOver).toBe(false);
    expect(status.monthlyOver).toBe(false);
  });

  it('self-heals the metering latch after its advertised 60 second retry window', () => {
    addPaidUser(18);
    tripApiUsagePersistenceFailure('gemini', 'chat_secretary');
    const blocked = checkAiBudget({
      userId: 18,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    });
    expect(blocked).toMatchObject({
      allowed: false,
      code: 'SERVICE_DEGRADED',
      internalReason: 'metering_unavailable',
    });
    expect(blocked.retryAfterSeconds).toBe(60);

    vi.advanceTimersByTime(60_001);
    const recovered = checkAiBudget({
      userId: 18,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    });
    expect(recovered.allowed).toBe(true);
    expect(getApiUsagePersistenceFailure()).toBeNull();
    expect(db.prepare(`
      SELECT pricing_status, request_source, cost_usd
      FROM api_usage
      WHERE category = 'api_usage_recovery_probe'
    `).get()).toEqual({
      pricing_status: 'zero-cost',
      request_source: 'system',
      cost_usd: 0,
    });
  });

  it('records a conservative timeout estimate in quota truth', () => {
    const id = recordApiUsageTimeoutEstimate({
      category: 'coach_analysis',
      model: 'gemini-2.5-flash',
      provider: 'gemini',
      userId: 18,
      tenantId: 18,
      maxCostUsd: 0.00936,
      timeoutMs: 30_000,
    }, db);
    expect(id).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT category, user_id, cost_usd, pricing_status, duration_ms
        FROM api_usage WHERE id = ?
    `).get(id)).toEqual({
      category: 'coach_analysis',
      user_id: 18,
      cost_usd: 0.00936,
      pricing_status: 'timeout-estimate',
      duration_ms: 30_000,
    });
  });

  it('resets daily usage at UTC midnight and monthly usage at the paid billing-cycle boundary', () => {
    addPaidUser(21);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES
        ('2026-06-30T23:59:59.000Z', 'chat_secretary', 21, 0.70, 'interactive', 'chat_secretary'),
        ('2026-07-08T23:59:59.000Z', 'chat_secretary', 21, 0.03, 'interactive', 'chat_secretary'),
        ('2026-07-09T00:00:00.000Z', 'chat_secretary', 21, 0.005, 'interactive', 'chat_secretary')
    `).run();

    const status = getDailyQuotaStatus(21);
    expect(status.spentUsd).toBeCloseTo(0.005, 8);
    expect(status.monthlySpentUsd).toBeCloseTo(0.035, 8);
    expect(status.dailyResetAt).toBe('2026-07-10T00:00:00.000Z');
    expect(status.monthlyResetAt).toBe('2026-08-01T00:00:00.000Z');
    expect(status.resetAt).toBe(status.dailyResetAt);
    expect(status.unblocksAt).toBeNull();
  });

  it('uses a UTC calendar month for founder plan windows', () => {
    db.prepare(`
      INSERT INTO subscriptions (user_id, plan, status, provider, current_period_start, current_period_end)
      VALUES (22, 'max', 'active', 'founder', NULL, NULL)
    `).run();
    const status = getDailyQuotaStatus(22);
    expect(status.plan).toBe('max');
    expect(status.monthlyCapUsd).toBe(1.8);
    expect(status.monthlyResetAt).toBe('2026-08-01T00:00:00.000Z');
    expect(status.entitlement?.isFounder).toBe(true);
  });

  it('uses one shared system pool even when a system job retains a positive target userId', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-09T10:00:00.000Z', 'autoresearch', 888, 0.09, 'system', 'autoresearch')
    `).run();

    const result = checkAiBudget({
      userId: 777,
      requestSource: 'system',
      baseCategory: 'autoresearch',
      estimatedCostUsd: 0.009,
    });
    expect(result).toMatchObject({
      allowed: false,
      code: 'AI_DAILY_LIMIT_REACHED',
      window: 'daily',
    });
    expect(result.quota.plan).toBe('system');
    expect(result.quota.spentUsd).toBeCloseTo(0.09, 8);
  });

  it('does not charge positive-target system rows against the target users paid allowance', () => {
    addPaidUser(888);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES
        ('2026-07-09T09:00:00.000Z', 'autoresearch', 888, 0.09, 'system', 'autoresearch'),
        ('2026-07-09T10:00:00.000Z', 'chat_secretary', 888, 0.01, 'interactive', 'chat_secretary')
    `).run();

    const status = getDailyQuotaStatus(888, { requestSource: 'interactive' });
    expect(status.spentUsd).toBeCloseTo(0.01, 8);
    expect(status.monthlySpentUsd).toBeCloseTo(0.01, 8);
    expect(status.callsToday).toBe(1);
    expect(status.remainingUsd).toBeCloseTo(0.03, 8);
  });

  it('enforces daily and monthly automation ceilings at 30 percent', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(61);
    addPaidUser(62);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-09T09:00:00.000Z', 'scheduled_content', 61, 0.010, 'automation', 'scheduled_content')
    `).run();
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-02T09:00:00.000Z', 'scheduled_content', 62, 0.359, 'automation', 'scheduled_content')
    `).run();

    expect(checkAiBudget({
      userId: 61,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'scheduled_content',
      automationPriority: 'content',
    })).toMatchObject({ allowed: false, code: 'AI_DAILY_LIMIT_REACHED', window: 'automation_daily' });
    expect(checkAiBudget({
      userId: 62,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'scheduled_content',
      automationPriority: 'content',
    })).toMatchObject({ allowed: false, code: 'AI_MONTHLY_LIMIT_REACHED', window: 'automation_monthly' });
  });

  it('never spends Nexus Points for automation requests', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(60);
    db.prepare(`
      INSERT INTO nexus_point_credits (
        user_id, points_remaining, usd_allowance_remaining, expires_at, status
      ) VALUES (60, 500, 0.5, '2026-08-01T00:00:00.000Z', 'active')
    `).run();
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-09T09:00:00.000Z', 'scheduled_content', 60, 0.011,
        'automation', 'content_workflow_reel')
    `).run();

    expect(checkAiBudget({
      userId: 60,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'tuesday_reels',
      automationPriority: 'content',
    })).toMatchObject({
      allowed: false,
      status: 429,
      code: 'AI_DAILY_LIMIT_REACHED',
      window: 'automation_daily',
    });
  });

  it('uses the monthly reset when both daily and monthly windows bind', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(63);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES
        ('2026-07-02T09:00:00.000Z', 'chat_secretary', 63, 1.16, 'interactive', 'chat_secretary'),
        ('2026-07-09T09:00:00.000Z', 'chat_secretary', 63, 0.04, 'interactive', 'chat_secretary')
    `).run();
    expect(checkAiBudget({
      userId: 63,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    })).toMatchObject({
      allowed: false,
      code: 'AI_MONTHLY_LIMIT_REACHED',
      window: 'monthly',
      unblocksAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('continues protecting todays Coach reserve when Coach ran earlier in the billing month', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(64);
    makeCoachEligible(64);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, job_name, base_category)
      VALUES
        ('2026-07-02T09:00:00.000Z', 'coach_analysis', 64, 0.005, 'automation', 'daily_coach', 'coach_analysis'),
        ('2026-07-03T09:00:00.000Z', 'scheduled_content', 64, 0.345, 'automation', 'scheduled_content', 'scheduled_content')
    `).run();
    expect(checkAiBudget({
      userId: 64,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'scheduled_content',
      automationPriority: 'content',
    })).toMatchObject({ allowed: false, code: 'AI_MONTHLY_LIMIT_REACHED', window: 'automation_monthly' });
  });

  it('does not release the Coach reserve for a metered attempt without a durable daily report', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(65);
    makeCoachEligible(65);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, job_name, base_category)
      VALUES ('2026-07-09T08:00:00.000Z', 'coach_analysis', 65, 0.002, 'automation', 'daily_coach', 'coach_analysis')
    `).run();

    expect(checkAiBudget({
      userId: 65,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'tuesday_reels',
      automationPriority: 'content',
    })).toMatchObject({
      allowed: false,
      code: 'AI_DAILY_LIMIT_REACHED',
      window: 'automation_daily',
    });
  });

  it('releases the Coach reserve only after the daily report is durable', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(66);
    makeCoachEligible(66);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, job_name, base_category)
      VALUES ('2026-07-09T08:00:00.000Z', 'coach_analysis', 66, 0.002, 'automation', 'daily_coach', 'coach_analysis')
    `).run();
    db.prepare(`
      INSERT INTO report_documents (user_id, type, source_job, document_json, created_at)
      VALUES (66, 'coach_briefing', 'garmin_coach', '{"status":"delivered"}', '2026-07-09T08:00:01.000Z')
    `).run();

    expect(checkAiBudget({
      userId: 66,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'tuesday_reels',
      automationPriority: 'content',
    }).allowed).toBe(true);
  });

  it('protects one next scheduled Content envelope from Channel Learning, then releases it for full inventory', () => {
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'));
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(67);
    makeCoachEligible(67);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-02T09:00:00.000Z', 'scheduled_content', 67, 0.347, 'automation', 'scheduled_content')
    `).run();
    db.prepare(`
      INSERT INTO report_documents (user_id, type, source_job, document_json, created_at)
      VALUES (67, 'coach_briefing', 'garmin_coach', '{"status":"delivered"}', '2026-07-12T08:00:01.000Z')
    `).run();

    const channelRequest = {
      userId: 67,
      requestSource: 'automation' as const,
      baseCategory: 'channel_analysis',
      jobName: 'channel_relearn',
      automationPriority: 'channel_learning' as const,
    };
    const protectedChannel = checkAiBudget(channelRequest);
    expect(protectedChannel.quota.automationSpentMonthlyUsd).toBeCloseTo(0.347, 8);
    expect(protectedChannel.reservedCostUsd).toBeCloseTo(0.01125, 8);
    expect(protectedChannel).toMatchObject({
      allowed: false,
      code: 'AI_MONTHLY_LIMIT_REACHED',
      window: 'automation_monthly',
    });

    const insertInventory = db.prepare(`
      INSERT INTO content_topic_feedback (
        user_id, tenant_id, format, source_job, sentiment, created_at
      ) VALUES (67, 67, ?, ?, 'pending', '2026-07-12T10:00:00.000Z')
    `);
    for (let i = 0; i < 5; i += 1) insertInventory.run('reel', 'tuesday_reels');
    for (let i = 0; i < 5; i += 1) insertInventory.run('youtube', 'thursday_youtube');
    for (let i = 0; i < 4; i += 1) insertInventory.run('reel', 'friday_weekly');
    for (let i = 0; i < 2; i += 1) insertInventory.run('youtube', 'friday_weekly');

    expect(checkAiBudget(channelRequest).allowed).toBe(true);
  });

  it('does not strand Channel allowance when historical Content inventory has no measured engagement', () => {
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'));
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(68);
    makeCoachEligible(68);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-02T09:00:00.000Z', 'scheduled_content', 68, 0.344, 'automation', 'scheduled_content')
    `).run();
    db.prepare(`
      INSERT INTO report_documents (user_id, type, source_job, document_json, created_at)
      VALUES (68, 'coach_briefing', 'garmin_coach', '{"status":"delivered"}', '2026-07-12T08:00:01.000Z')
    `).run();
    const insertOldInventory = db.prepare(`
      INSERT INTO content_topic_feedback (
        user_id, tenant_id, format, source_job, sentiment, created_at
      ) VALUES (68, 68, ?, ?, 'pending', '2026-05-01T10:00:00.000Z')
    `);
    for (let i = 0; i < 5; i += 1) insertOldInventory.run('reel', 'tuesday_reels');
    for (let i = 0; i < 5; i += 1) insertOldInventory.run('youtube', 'thursday_youtube');
    for (let i = 0; i < 4; i += 1) insertOldInventory.run('reel', 'friday_weekly');
    for (let i = 0; i < 2; i += 1) insertOldInventory.run('youtube', 'friday_weekly');

    expect(checkAiBudget({
      userId: 68,
      requestSource: 'automation',
      baseCategory: 'channel_analysis',
      jobName: 'channel_relearn',
      automationPriority: 'channel_learning',
    }).allowed).toBe(true);
  });

  it('allows no-history Pro Content while protecting one Coach reservation in both windows', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(30);
    makeCoachEligible(30);
    const result = checkAiBudget({
      userId: 30,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'scheduled_content',
      automationPriority: 'content',
    });
    expect(result.allowed).toBe(true);
    expect(result.reservedCostUsd).toBe(0.0025);
    expect(result.quota.automationDailyCapUsd).toBeCloseTo(0.012, 8);
    expect(result.quota.automationMonthlyCapUsd).toBeCloseTo(0.36, 8);
  });

  it('admits Tuesday Content and the same-day 21:00 Coach call on Pro defaults', () => {
    vi.setSystemTime(new Date('2026-07-07T09:17:00.000Z'));
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(31);
    makeCoachEligible(31);

    const content = checkAiBudget({
      userId: 31,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'tuesday_reels',
      automationPriority: 'content',
    });
    expect(content.allowed).toBe(true);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, job_name, base_category)
      VALUES ('2026-07-07T09:18:00.000Z', 'content_workflow_reel', 31, 0.002,
        'automation', 'tuesday_reels', 'content_workflow_reel')
    `).run();

    vi.setSystemTime(new Date('2026-07-07T21:00:00.000Z'));
    expect(checkAiBudget({
      userId: 31,
      requestSource: 'automation',
      baseCategory: 'coach_analysis',
      jobName: 'garmin_coach',
      automationPriority: 'coach',
      estimatedCostUsd: 0.00936,
    })).toMatchObject({ allowed: true, reservedCostUsd: 0.00936 });
  });

  it('does not reserve Coach allowance for a paid user without scheduler eligibility', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(32, 'max');
    const result = checkAiBudget({
      userId: 32,
      requestSource: 'automation',
      baseCategory: 'channel_analysis',
      jobName: 'channel_relearn',
      automationPriority: 'channel_learning',
      estimatedCostUsd: 0.015,
    });
    expect(result.allowed).toBe(true);
  });

  it('uses workload-wide rolling 30-day p95 and applies the 125% reservation multiplier', () => {
    for (let i = 1; i <= 20; i += 1) {
      db.prepare(`
        INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
        VALUES ('2026-07-08T12:00:00.000Z', 'custom_job', ?, ?, 'automation', 'custom_job')
      `).run(i % 2 === 0 ? 40 : 41, i / 1000);
    }
    expect(estimateAiBudgetReservationUsd({
      userId: 40,
      requestSource: 'automation',
      baseCategory: 'custom_job',
    })).toBeCloseTo(0.02375, 8);
    expect(estimateAiBudgetReservationUsd({
      userId: 40,
      requestSource: 'automation',
      baseCategory: 'custom_job',
      estimatedCostUsd: 0.001,
    })).toBeCloseTo(0.02375, 8);
    expect(estimateAiBudgetReservationUsd({
      userId: 40,
      requestSource: 'automation',
      baseCategory: 'custom_job',
      estimatedCostUsd: 0.03,
    })).toBeCloseTo(0.03, 8);
  });

  it('reserves only the remaining p95 envelope on a later stage of the same run', () => {
    for (let i = 1; i <= 20; i += 1) {
      db.prepare(`
        INSERT INTO api_usage (
          ts, category, user_id, cost_usd, request_source, base_category, run_id
        ) VALUES (
          '2026-07-08T12:00:00.000Z', 'custom_job', ?, 0.01,
          'automation', 'custom_job', ?
        )
      `).run(i % 2 === 0 ? 40 : 41, `historical-run-${i}`);
    }
    db.prepare(`
      INSERT INTO api_usage (
        ts, category, user_id, cost_usd, request_source, base_category, run_id
      ) VALUES (
        '2026-07-09T10:00:00.000Z', 'custom_job', 40, 0.004,
        'automation', 'custom_job', 'active-run'
      )
    `).run();

    expect(estimateAiBudgetReservationUsd({
      userId: 40,
      requestSource: 'automation',
      baseCategory: 'custom_job',
      runId: 'active-run',
    })).toBeCloseTo(0.0085, 8);
    expect(estimateAiBudgetReservationUsd({
      userId: 40,
      requestSource: 'automation',
      baseCategory: 'custom_job',
      runId: 'active-run',
      estimatedCostUsd: 0.02,
    })).toBeCloseTo(0.02, 8);
  });

  it('does not double-count settled overage when calculating remaining Points headroom', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(45);
    db.prepare(`
      INSERT INTO nexus_point_credits (
        user_id, points_remaining, usd_allowance_remaining, expires_at, status
      ) VALUES (45, 295, 0.295, '2026-08-01T00:00:00.000Z', 'active')
    `).run();
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-09T10:00:00.000Z', 'chat_secretary', 45, 0.045, 'interactive', 'chat_secretary')
    `).run();
    db.prepare(`
      INSERT INTO nexus_point_debits (user_id, usd_cost_debited, created_at)
      VALUES (45, 0.005, '2026-07-09T10:00:01.000Z')
    `).run();

    const fullRemainingAllowance = checkAiBudget({
      userId: 45,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
      // A provider hard maximum is already conservative and is not
      // multiplied by another 125%.
      estimatedCostUsd: 0.295,
    });

    expect(fullRemainingAllowance.allowed).toBe(true);
    expect(fullRemainingAllowance.reservedCostUsd).toBeCloseTo(0.295, 8);
    expect(fullRemainingAllowance.quota.nexusPointsRemainingUsd).toBeCloseTo(0.295, 8);
  });

  it('serializes concurrent check-and-spend through the actual usage write and records the denial', async () => {
    vi.useRealTimers();
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(50);
    const request = {
      userId: 50,
      requestSource: 'interactive' as const,
      baseCategory: 'chat_secretary',
      estimatedCostUsd: 0.021,
      runId: 'concurrent-run',
    };
    const spend = () => withAiBudgetReservation(request, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const attribution = resolveApiUsageAttribution('chat_secretary', 50);
      db.prepare(`
        INSERT INTO api_usage (
          category, user_id, cost_usd, request_source, job_name, base_category, run_id
        ) VALUES ('chat_secretary', 50, 0.02, ?, ?, ?, ?)
      `).run(
        attribution.requestSource,
        attribution.jobName,
        attribution.baseCategory,
        attribution.runId,
      );
      return 'spent';
    });

    const results = await Promise.allSettled([spend(), spend()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(AiBudgetError);
    expect(rejection.reason.decision.code).toBe('AI_DAILY_LIMIT_REACHED');
    expect(db.prepare('SELECT COUNT(*) AS count FROM api_usage').get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT request_source, base_category, run_id, code, budget_window
      FROM ai_budget_deferrals
    `).get()).toEqual({
      request_source: 'interactive',
      base_category: 'chat_secretary',
      run_id: 'concurrent-run',
      code: 'AI_DAILY_LIMIT_REACHED',
      budget_window: 'daily',
    });
  });

  it('renews the SQLite lease while a provider reservation remains active', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(70);
    let releaseProvider!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const providerPending = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const pending = withAiBudgetReservation({
      userId: 70,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    }, async () => {
      signalEntered();
      await providerPending;
    });
    await entered;
    const before = db.prepare(`SELECT expires_at_ms FROM cost_guardrail_locks WHERE lock_key = 'user:70'`).get() as { expires_at_ms: number };
    expect(before.expires_at_ms - Date.now()).toBeGreaterThan(180_000);
    await vi.advanceTimersByTimeAsync(30_001);
    const after = db.prepare(`SELECT expires_at_ms FROM cost_guardrail_locks WHERE lock_key = 'user:70'`).get() as { expires_at_ms: number };
    expect(after.expires_at_ms).toBeGreaterThan(before.expires_at_ms);
    releaseProvider();
    await pending;
  });

  it('fails closed at a provider boundary without an approved reservation', () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(71);
    expect(() => assertAiBudgetReservationForProvider({
      userId: 71,
      category: 'chat_secretary',
      maxCostUsd: 0.01,
    })).toThrow(AiBudgetError);
  });

  it('fails closed when automation omits a verifiable provider maximum', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(74);
    await expect(withAiBudgetReservation({
      userId: 74,
      requestSource: 'automation',
      baseCategory: 'coach_analysis',
      jobName: 'daily_coach',
      automationPriority: 'coach',
    }, async () => {
      assertAiBudgetReservationForProvider({ userId: 74, category: 'coach_analysis' } as any);
    })).rejects.toBeInstanceOf(AiBudgetError);
  });

  it('fails closed on provider-hosted search for automation and system reservations', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(77);

    await expect(withAiBudgetReservation({
      userId: 77,
      requestSource: 'automation',
      baseCategory: 'content_workflow_reel',
      jobName: 'tuesday_reels',
      automationPriority: 'content',
    }, async () => {
      assertAiBudgetReservationForProvider({
        userId: 77,
        category: 'content_workflow_reel',
        maxCostUsd: 0.001,
        hasUnboundedProviderInjectedContext: true,
      });
    })).rejects.toMatchObject({ decision: { code: 'SERVICE_DEGRADED' } });

    await expect(withAiBudgetReservation({
      userId: 77,
      requestSource: 'system',
      baseCategory: 'autoresearch',
    }, async () => {
      assertAiBudgetReservationForProvider({
        userId: 77,
        category: 'autoresearch',
        maxCostUsd: 0.001,
        hasUnboundedProviderInjectedContext: true,
      });
    })).rejects.toMatchObject({ decision: { code: 'SERVICE_DEGRADED' } });
  });

  it('rechecks an automation hard maximum before network work can start', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(75);
    db.prepare(`
      INSERT INTO api_usage (ts, category, user_id, cost_usd, request_source, base_category)
      VALUES ('2026-07-09T08:00:00.000Z', 'coach_analysis', 75, 0.004, 'automation', 'coach_analysis')
    `).run();
    let providerStarted = false;

    await expect(withAiBudgetReservation({
      userId: 75,
      requestSource: 'automation',
      baseCategory: 'coach_analysis',
      jobName: 'daily_coach',
      automationPriority: 'coach',
    }, async () => {
      assertAiBudgetReservationForProvider({
        userId: 75,
        category: 'coach_analysis',
        maxCostUsd: 0.009,
      });
      providerStarted = true;
    })).rejects.toBeInstanceOf(AiBudgetError);
    expect(providerStarted).toBe(false);
  });

  it('applies a concrete provider hard maximum to the shared system pool', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    let providerStarted = false;

    await expect(withAiBudgetReservation({
      userId: 501,
      requestSource: 'system',
      baseCategory: 'autoresearch',
    }, async () => {
      assertAiBudgetReservationForProvider({
        userId: 501,
        category: 'autoresearch',
        maxCostUsd: 0.101,
      });
      providerStarted = true;
    })).rejects.toMatchObject({
      decision: { code: 'AI_DAILY_LIMIT_REACHED', window: 'daily' },
    });
    expect(providerStarted).toBe(false);
  });

  it('fails closed on unresolved provider pricing for interactive and system work', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(76);

    await expect(withAiBudgetReservation({
      userId: 76,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    }, async () => {
      assertAiBudgetReservationForProvider({
        userId: 76,
        category: 'chat_secretary',
        maxCostUsd: Number.POSITIVE_INFINITY,
      });
    })).rejects.toMatchObject({ decision: { code: 'SERVICE_DEGRADED' } });

    await expect(withAiBudgetReservation({
      userId: 99,
      requestSource: 'system',
      baseCategory: 'autoresearch',
    }, async () => {
      assertAiBudgetReservationForProvider({
        userId: 99,
        category: 'autoresearch',
        maxCostUsd: Number.POSITIVE_INFINITY,
      });
    })).rejects.toMatchObject({ decision: { code: 'SERVICE_DEGRADED' } });
  });

  it('allows a provider boundary only inside the approved reservation', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(72);
    await withAiBudgetReservation({
      userId: 72,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    }, async () => {
      expect(() => assertAiBudgetReservationForProvider({
        userId: 72,
        category: 'chat_secretary',
        maxCostUsd: 0.01,
      })).not.toThrow();
    });
  });

  it('fails unresolved provider pricing closed for interactive work before network I/O', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(74);
    await withAiBudgetReservation({
      userId: 74,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
    }, async () => {
      expect(() => assertAiBudgetReservationForProvider({
        userId: 74,
        category: 'chat_secretary',
        maxCostUsd: Number.POSITIVE_INFINITY,
      })).toThrow(AiBudgetError);
    });
  });

  it('rechecks current headroom before every provider attempt in one reservation', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    addPaidUser(73);
    await withAiBudgetReservation({
      userId: 73,
      requestSource: 'interactive',
      baseCategory: 'chat_secretary',
      runId: 'multi-stage-run',
    }, async () => {
      expect(() => assertAiBudgetReservationForProvider({
        userId: 73,
        category: 'chat_secretary',
        maxCostUsd: 0.01,
      })).not.toThrow();
      db.prepare(`
        INSERT INTO api_usage (
          ts, category, user_id, cost_usd, request_source, base_category, run_id
        ) VALUES ('2026-07-09T10:00:00.000Z', 'chat_secretary', 73, 0.039,
          'interactive', 'chat_secretary', 'multi-stage-run')
      `).run();
      expect(() => assertAiBudgetReservationForProvider({
        userId: 73,
        category: 'chat_secretary_repair',
        maxCostUsd: 0.01,
      })).toThrow(AiBudgetError);
    });
    expect(db.prepare(`
      SELECT code, budget_window, run_id
      FROM ai_budget_deferrals
      WHERE user_id = 73
    `).get()).toEqual({
      code: 'AI_DAILY_LIMIT_REACHED',
      budget_window: 'daily',
      run_id: 'multi-stage-run',
    });
  });

  it('validates signed system re-entry against the shared user:0 lock for a positive target user', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    await withAiBudgetReservation({
      userId: 73,
      requestSource: 'system',
      baseCategory: 'autoresearch',
      runId: 'system-run',
    }, async () => {
      const marker = getActiveAiBudgetReservationMarker(73, 'autoresearch');
      expect(marker).not.toBeNull();
      await expect(withSignedOuterAiBudgetReservation({
        userId: 73,
        requestSource: 'system',
        baseCategory: 'autoresearch',
        jobName: marker!.jobName,
        runId: marker!.runId,
      }, marker!, async () => 'ok')).resolves.toBe('ok');
    });
  });

  it('keeps provider category exact while preserving the outer workload base on signed re-entry', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'test-internal-attribution-secret');
    addPaidUser(78);

    await withAiBudgetReservation({
      userId: 78,
      requestSource: 'interactive',
      baseCategory: 'content_script_generation',
      jobName: 'content_script_manual',
      runId: 'content-run-78',
    }, async () => {
      const token = createInternalAttributionToken({
        userId: 78,
        tenantId: 78,
        category: 'content_engine_script_draft',
      });
      const claims = verifyInternalAttributionToken(token, 'content_engine_script_draft');

      expect(claims).toMatchObject({
        category: 'content_engine_script_draft',
        outerReservation: {
          requestSource: 'interactive',
          baseCategory: 'content_script_generation',
          jobName: 'content_script_manual',
          runId: 'content-run-78',
        },
      });
      await expect(withSignedOuterAiBudgetReservation({
        userId: 78,
        requestSource: 'interactive',
        baseCategory: claims!.outerReservation!.baseCategory,
        jobName: claims!.outerReservation!.jobName,
        runId: claims!.outerReservation!.runId,
      }, claims!.outerReservation!, async () => 'reentered')).resolves.toBe('reentered');
    });
  });
});
