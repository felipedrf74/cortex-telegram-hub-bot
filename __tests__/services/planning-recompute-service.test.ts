import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

const mockComposeWeeklyPlan = vi.fn();
const mockComposeDailyBrief = vi.fn();
const mockInvalidatePlanningCaches = vi.fn();
const mockGetUserById = vi.fn();
let testDb: Database.Database;
let mockUserTimezone = 'Europe/Lisbon';

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/weekly-plan-orchestrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/weekly-plan-orchestrator')>(
    '../../src/services/weekly-plan-orchestrator',
  )),
  composeWeeklyPlan: (...args: unknown[]) => mockComposeWeeklyPlan(...args),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidatePlanningCaches: (...args: unknown[]) => mockInvalidatePlanningCaches(...args),
}));

vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  )),
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

function installSchema(): void {
  testDb.exec(`
    CREATE TABLE planning_recompute_receipts (
      receipt_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      idempotency_key_hash TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_token TEXT,
      lease_expires_at TEXT,
      snapshot_id TEXT,
      response_json TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, tenant_id, idempotency_key_hash)
    );
  `);
}

function installCoherentComposers(): void {
  mockComposeWeeklyPlan.mockImplementation(async (input: any) => ({
    weekStart: input.weekStart,
    weekEnd: '2026-04-19',
    generatedAt: input.context.capturedAt,
    timezone: input.context.timezone,
    warningCodes: [],
    warnings: [],
    sourceHealth: Object.fromEntries(['calendar', 'tasks', 'mail', 'focus', 'training', 'cooking', 'content', 'finance']
      .map((key) => [key, { status: 'ready', warningCodes: [], warnings: [] }])),
    variant: 'steady',
    degraded: false,
    gated: { skills: [] },
    garmin_stale: false,
    conflicts: [],
    creativeCopy: { headline: '', note: '' },
    summary: { sessionCount: 0, mealCount: 0, activeConflictCount: 0 },
    days: [],
  }));
  mockComposeDailyBrief.mockImplementation(async (input: any) => ({
    date: input.date,
    generatedAt: input.context.capturedAt,
    timezone: input.context.timezone,
    warningCodes: [],
    warnings: [],
    sourceHealth: {
      ...input.weekPlan.sourceHealth,
      decision_center: { status: 'ready', warningCodes: [], warnings: [] },
    },
    degraded: false,
    gated: { skills: [] },
    garmin_stale: false,
    conflicts: [],
    creativeCopy: { headline: '', note: '' },
    day: null,
    coordination: null,
  }));
}

describe('planning recompute service', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    installSchema();
    mockComposeWeeklyPlan.mockReset();
    mockComposeDailyBrief.mockReset();
    mockInvalidatePlanningCaches.mockReset();
    mockGetUserById.mockReset();
    mockUserTimezone = 'Europe/Lisbon';
    mockGetUserById.mockImplementation((userId: number) => ({
      id: userId,
      timezone: mockUserTimezone,
      language: 'en-US',
    }));
    installCoherentComposers();
  });

  afterEach(() => {
    vi.useRealTimers();
    testDb.close();
  });

  it('creates one coherent weekly/daily snapshot and exact replays do no work', async () => {
    const { recomputePlanningSnapshot } = await import('../../src/services/planning-recompute-service');
    const input = {
      userId: 11,
      tenantId: 11,
      timezone: 'Europe/Lisbon',
      locale: 'pt-PT',
      idempotencyKey: 'recompute-once',
      weekStart: '2026-04-13',
      date: '2026-04-14',
      now: new Date('2026-04-14T10:30:00.000Z'),
    };

    const first = await recomputePlanningSnapshot(input);
    const replay = await recomputePlanningSnapshot(input);

    expect(replay).toEqual(first);
    expect(first).not.toHaveProperty('snapshot');
    expect(first.week).not.toHaveProperty('planningSnapshot');
    expect(first.today).not.toHaveProperty('planningSnapshot');
    expect(first.week.generatedAt).toBe(first.today.generatedAt);
    expect(mockComposeWeeklyPlan).toHaveBeenCalledTimes(1);
    expect(mockComposeDailyBrief).toHaveBeenCalledTimes(1);
    expect(mockInvalidatePlanningCaches).toHaveBeenCalledTimes(1);
    expect(mockComposeDailyBrief).toHaveBeenCalledWith(expect.objectContaining({
      weekPlan: first.week,
      cacheMode: 'bypass',
    }));

    const receipt = testDb.prepare(`
      SELECT status, idempotency_key_hash AS keyHash, response_json AS responseJson
        FROM planning_recompute_receipts
    `).get() as { status: string; keyHash: string; responseJson: string };
    expect(receipt.status).toBe('completed');
    expect(receipt.keyHash).toHaveLength(64);
    expect(receipt.responseJson).not.toContain('recompute-once');
  });

  it('rejects changed payload reuse without invalidating or composing', async () => {
    const { recomputePlanningSnapshot } = await import('../../src/services/planning-recompute-service');
    const base = {
      userId: 11,
      tenantId: 11,
      timezone: 'Europe/Lisbon',
      locale: 'en',
      idempotencyKey: 'stable-key',
      weekStart: '2026-04-13',
      date: '2026-04-14',
      now: new Date('2026-04-14T10:30:00.000Z'),
    };
    await recomputePlanningSnapshot(base);
    mockInvalidatePlanningCaches.mockClear();
    mockComposeWeeklyPlan.mockClear();

    await expect(recomputePlanningSnapshot({ ...base, date: '2026-04-15' }))
      .rejects.toMatchObject({ code: 'PLANNING_RECOMPUTE_IDEMPOTENCY_REUSED', status: 409 });
    expect(mockInvalidatePlanningCaches).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['Europe/Lisbon', '2026-03-29T00:30:00.000Z', '2026-03-29'],
    ['America/Sao_Paulo', '2026-04-13T02:30:00.000Z', '2026-04-12'],
    ['America/Los_Angeles', '2026-11-01T08:30:00.000Z', '2026-11-01'],
  ])('anchors implicit today to the captured local day in %s', async (timezone, now, expectedDate) => {
    mockUserTimezone = timezone;
    const { recomputePlanningSnapshot } = await import('../../src/services/planning-recompute-service');
    const result = await recomputePlanningSnapshot({
      userId: 15,
      tenantId: 15,
      timezone,
      locale: 'en',
      idempotencyKey: `local-day-${timezone}`,
      now: new Date(now),
    });

    expect(result.today.date).toBe(expectedDate);
    expect(result.week.timezone).toBe(timezone);
    expect(result.week.weekStart).toBe(DateTime.fromISO(expectedDate, { zone: timezone }).startOf('week').toISODate());
  });

  it('supports requested past and future weeks but rejects dates outside that week', async () => {
    const { recomputePlanningSnapshot } = await import('../../src/services/planning-recompute-service');
    const base = {
      userId: 17,
      tenantId: 17,
      timezone: 'Europe/Lisbon',
      locale: 'en',
      now: new Date('2026-08-31T10:00:00.000Z'),
    };
    const past = await recomputePlanningSnapshot({
      ...base,
      idempotencyKey: 'past-week',
      weekStart: '2026-01-05',
      date: '2026-01-09',
    });
    const future = await recomputePlanningSnapshot({
      ...base,
      idempotencyKey: 'future-week',
      weekStart: '2027-01-04',
      date: '2027-01-10',
    });
    expect(past.week.weekStart).toBe('2026-01-05');
    expect(future.week.weekStart).toBe('2027-01-04');

    await expect(recomputePlanningSnapshot({
      ...base,
      idempotencyKey: 'outside-week',
      weekStart: '2027-01-04',
      date: '2027-01-11',
    })).rejects.toMatchObject({ code: 'PLANNING_RECOMPUTE_INVALID', status: 400 });
  });

  it('leases retries after failure and keeps tenants isolated for the same key', async () => {
    const { recomputePlanningSnapshot } = await import('../../src/services/planning-recompute-service');
    const base = {
      userId: 19,
      tenantId: 19,
      timezone: 'Europe/Lisbon',
      locale: 'en',
      idempotencyKey: 'retry-and-scope',
      weekStart: '2026-04-13',
      date: '2026-04-14',
      now: new Date('2026-04-14T10:30:00.000Z'),
    };
    mockComposeWeeklyPlan.mockRejectedValueOnce(new Error('source unavailable'));
    await expect(recomputePlanningSnapshot(base)).rejects.toThrow('source unavailable');
    const retry = await recomputePlanningSnapshot(base);
    const otherAccount = await recomputePlanningSnapshot({ ...base, userId: 30, tenantId: 30 });

    expect(retry.week.timezone).toBe('Europe/Lisbon');
    expect(otherAccount.week.timezone).toBe('Europe/Lisbon');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM planning_recompute_receipts').get())
      .toMatchObject({ count: 2 });
  });

  it('renews the lease while orchestration is still running', async () => {
    vi.useFakeTimers({ now: new Date('2026-04-14T10:30:00.000Z') });
    const { recomputePlanningSnapshot } = await import('../../src/services/planning-recompute-service');
    let releaseWeekly!: () => void;
    mockComposeWeeklyPlan.mockImplementationOnce((input: any) => new Promise((resolve) => {
      releaseWeekly = () => resolve({
        weekStart: input.weekStart,
        weekEnd: '2026-04-19',
        generatedAt: input.context.capturedAt,
        timezone: input.context.timezone,
        warningCodes: [],
        warnings: [],
        sourceHealth: Object.fromEntries(['calendar', 'tasks', 'mail', 'focus', 'training', 'cooking', 'content', 'finance']
          .map((key) => [key, { status: 'ready', warningCodes: [], warnings: [] }])),
        variant: 'steady',
        degraded: false,
        gated: { skills: [] },
        garmin_stale: false,
        conflicts: [],
        creativeCopy: { headline: '', note: '' },
        summary: { sessionCount: 0, mealCount: 0, activeConflictCount: 0 },
        days: [],
      });
    }));
    const input = {
      userId: 31,
      tenantId: 31,
      timezone: 'Europe/Lisbon',
      locale: 'en',
      idempotencyKey: 'slow-recompute',
      weekStart: '2026-04-13',
      date: '2026-04-14',
      now: new Date('2026-04-14T10:30:00.000Z'),
    };

    const first = recomputePlanningSnapshot(input);
    await vi.advanceTimersByTimeAsync(0);
    const initialExpiry = (testDb.prepare(`
      SELECT lease_expires_at AS leaseExpiresAt FROM planning_recompute_receipts
    `).get() as { leaseExpiresAt: string }).leaseExpiresAt;

    await vi.advanceTimersByTimeAsync(60_000);
    const renewedExpiry = (testDb.prepare(`
      SELECT lease_expires_at AS leaseExpiresAt FROM planning_recompute_receipts
    `).get() as { leaseExpiresAt: string }).leaseExpiresAt;
    expect(Date.parse(renewedExpiry)).toBeGreaterThan(Date.parse(initialExpiry));

    await expect(recomputePlanningSnapshot({
      ...input,
      now: new Date('2026-04-14T10:35:30.000Z'),
    })).rejects.toMatchObject({ code: 'PLANNING_RECOMPUTE_IN_PROGRESS', status: 409 });

    releaseWeekly();
    await first;
  });
});
