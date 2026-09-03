// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  composeWeeklyPlan: vi.fn(),
  composeDailyBrief: vi.fn(),
  invalidatePlanningCaches: vi.fn(),
  getUserById: vi.fn(),
  getUserTimezone: vi.fn(),
  getTaskProviderForUser: vi.fn(),
  getEventsWithDiagnostics: vi.fn(),
  getUnreadMailSummaryForUser: vi.fn(),
  isAnyMailConfiguredForUser: vi.fn(),
  getRemindersForWindow: vi.fn(),
  getActivitiesByDateForUser: vi.fn(),
  isGarminConfiguredForUser: vi.fn(),
  getLatestReadinessEvent: vi.fn(),
  isSubmoduleEnabled: vi.fn(),
}));

let testDb: Database.Database;

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  )),
  getDb: () => testDb,
}));
vi.mock('../../src/services/weekly-plan-orchestrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/weekly-plan-orchestrator')>(
    '../../src/services/weekly-plan-orchestrator',
  )),
  composeWeeklyPlan: (...args: unknown[]) => mocks.composeWeeklyPlan(...args),
}));
vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mocks.composeDailyBrief(...args),
}));
vi.mock('../../src/services/cache-coherence-registry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cache-coherence-registry')>(
    '../../src/services/cache-coherence-registry',
  )),
  invalidatePlanningCaches: (...args: unknown[]) => mocks.invalidatePlanningCaches(...args),
}));
vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  );
  return {
    ...actual,
    getUserById: (...args: unknown[]) => mocks.getUserById(...args),
    getUserTimezone: (...args: unknown[]) => mocks.getUserTimezone(...args),
  };
});
vi.mock('../../src/services/task-store/task-router', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/task-store/task-router')>(
    '../../src/services/task-store/task-router',
  );
  return { ...actual, getTaskProviderForUser: mocks.getTaskProviderForUser };
});
vi.mock('../../src/services/unified-calendar', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/unified-calendar')>(
    '../../src/services/unified-calendar',
  );
  return { ...actual, getEventsWithDiagnostics: mocks.getEventsWithDiagnostics };
});
vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: mocks.getUnreadMailSummaryForUser,
  isAnyMailConfiguredForUser: mocks.isAnyMailConfiguredForUser,
}));
vi.mock('../../src/state/reminders', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/reminders')>('../../src/state/reminders');
  return { ...actual, getRemindersForWindow: mocks.getRemindersForWindow };
});
vi.mock('../../src/services/garmin', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/garmin')>('../../src/services/garmin');
  return {
    ...actual,
    getActivitiesByDateForUser: mocks.getActivitiesByDateForUser,
    isGarminConfiguredForUser: mocks.isGarminConfiguredForUser,
  };
});
vi.mock('../../src/services/readiness-events', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/readiness-events')>(
    '../../src/services/readiness-events',
  );
  return { ...actual, getLatestReadinessEvent: mocks.getLatestReadinessEvent };
});
vi.mock('../../src/skills/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/skills/registry')>('../../src/skills/registry');
  return { ...actual, isSubmoduleEnabled: mocks.isSubmoduleEnabled };
});

import { recomputePlanningSnapshot } from '../../src/services/planning-recompute-service';
import { composeSecretaryScheduledPlanningSnapshot } from '../../src/services/secretary-scheduled-report';
import { collectSecretaryOperationalContext } from '../../src/services/chat-core-v2/secretary-operational-context';

const sourceHealth = Object.fromEntries(
  ['calendar', 'tasks', 'mail', 'focus', 'training', 'cooking', 'content', 'finance']
    .map((source) => [source, { status: 'ready', warningCodes: [], warnings: [] }]),
);

describe('Secretary canonical snapshot cross-surface parity', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
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
    vi.clearAllMocks();
    mocks.getUserById.mockReturnValue({ id: 7, timezone: 'UTC', language: 'en-US' });
    mocks.getUserTimezone.mockReturnValue('UTC');
    mocks.isSubmoduleEnabled.mockReturnValue(true);
    mocks.getTaskProviderForUser.mockReturnValue(null);
    mocks.getEventsWithDiagnostics.mockResolvedValue({
      events: [], status: 'ready', warningCodes: [], warnings: [],
      sources: { configured: [], fulfilled: [], failed: [] },
    });
    mocks.isAnyMailConfiguredForUser.mockReturnValue(false);
    mocks.getUnreadMailSummaryForUser.mockResolvedValue({
      configuredProviders: [], outlookUnread: null, gmailUnread: null, totalUnread: 0,
    });
    mocks.getRemindersForWindow.mockReturnValue([]);
    mocks.getActivitiesByDateForUser.mockResolvedValue([]);
    mocks.isGarminConfiguredForUser.mockReturnValue(false);
    mocks.getLatestReadinessEvent.mockReturnValue(null);

    const day = {
      date: '2026-07-10',
      weekday: 'Friday',
      headline: 'Review launch plan first.',
      training: { title: 'Rest', type: 'rest', status: 'rest', durationMinutes: null, intensity: null, reason: null, decisions: [] },
      meals: [],
      content: null,
      secretary: {
        focusBlock: null, pendingTasks: 3, tasksDueOnDate: 1, overdueTasks: 1,
        calendarEventCount: 2, mailUnreadTotal: 4, writableCalendar: true,
        travel: false, busy: false, priorityNote: null, sequence: [], tradeoffNote: null, decisions: [],
      },
      finance: null,
    };
    const week = {
      weekStart: '2026-07-06', weekEnd: '2026-07-12', generatedAt: '2026-07-10T12:00:00.000Z',
      timezone: 'UTC', warningCodes: [], warnings: [], sourceHealth,
      variant: 'steady', degraded: false, gated: { skills: [] }, garmin_stale: false,
      conflicts: [], creativeCopy: { headline: '', note: '' },
      summary: { sessionCount: 0, mealCount: 0, activeConflictCount: 0 }, days: [day],
    };
    const daily = {
      date: '2026-07-10', generatedAt: '2026-07-10T12:00:00.000Z', timezone: 'UTC',
      warningCodes: [], warnings: [],
      sourceHealth: { ...sourceHealth, decision_center: { status: 'ready', warningCodes: [], warnings: [] } },
      degraded: false, gated: { skills: [] }, garmin_stale: false, conflicts: [],
      creativeCopy: { headline: '', note: '' }, day,
      coordination: {
        topPriority: 'Review launch plan', executionOrder: ['Review launch plan'], watchouts: [], handoffs: [],
        blockers: [], suggestedMoves: [], protectedBlocks: [], nextBestAction: null, confidence: 'high',
        secretaryToday: { summary: 'Review launch plan first.' },
      },
    };
    mocks.composeWeeklyPlan.mockResolvedValue(week);
    mocks.composeDailyBrief.mockResolvedValue(daily);
  });

  afterEach(() => testDb.close());

  it('keeps recompute, scheduled reports, and planning chat on the same deterministic fixture', async () => {
    const scheduled = await composeSecretaryScheduledPlanningSnapshot({
      userId: 7, tenantId: 7, localDate: '2026-07-10',
    });
    const recomputed = await recomputePlanningSnapshot({
      userId: 7,
      tenantId: 7,
      idempotencyKey: 'cross-surface-parity',
      weekStart: '2026-07-06',
      date: '2026-07-10',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    const chat = await collectSecretaryOperationalContext({
      message: 'Plan my day', userId: 7, tenantId: 7, planning: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(recomputed.week).toEqual(scheduled.week);
    expect(recomputed.today).toEqual(scheduled.daily);
    expect(scheduled.today.day).toEqual(scheduled.daily.day);
    expect(chat.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'daily_context',
        content: expect.stringContaining('"topPriority":"Review launch plan"'),
      }),
      expect.objectContaining({
        source: 'calendar',
        content: expect.stringContaining('event_count=2'),
      }),
      expect.objectContaining({
        source: 'tasks',
        content: expect.stringContaining('pending=3'),
      }),
      expect.objectContaining({
        source: 'mail',
        content: expect.stringContaining('unread_total=4'),
      }),
    ]));
    expect(chat.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'calendar', status: 'available' }),
      expect.objectContaining({ source: 'tasks', status: 'available' }),
      expect.objectContaining({ source: 'mail', status: 'available' }),
      expect.objectContaining({ source: 'daily_context', status: 'available' }),
    ]));

    for (const call of mocks.composeWeeklyPlan.mock.calls) {
      expect(call[0]).toMatchObject({ userId: 7, tenantId: 7, weekStart: '2026-07-06' });
    }
    for (const call of mocks.composeDailyBrief.mock.calls) {
      expect(call[0]).toMatchObject({ userId: 7, tenantId: 7, date: '2026-07-10' });
      expect(call[0].weekPlan).toBe(mocks.composeWeeklyPlan.mock.results[0]?.value instanceof Promise
        ? await mocks.composeWeeklyPlan.mock.results[0]?.value
        : mocks.composeWeeklyPlan.mock.results[0]?.value);
    }
  });
});
