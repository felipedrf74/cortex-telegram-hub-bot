// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTaskProviderForUser: vi.fn(),
  getAllPendingTasks: vi.fn(),
  getEventsWithDiagnostics: vi.fn(),
  getUnreadMailSummaryForUser: vi.fn(),
  isAnyMailConfiguredForUser: vi.fn(),
  getRemindersForWindow: vi.fn(),
  getActivitiesByDateForUser: vi.fn(),
  isGarminConfiguredForUser: vi.fn(),
  getLatestReadinessEvent: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserById: vi.fn(),
  isSubmoduleEnabled: vi.fn(),
  composeDailyBrief: vi.fn(),
  composeWeeklyPlan: vi.fn(),
}));

vi.mock('../../src/services/task-store/task-router', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/task-store/task-router')>(
    '../../src/services/task-store/task-router',
  );
  return {
    ...actual,
    getTaskProviderForUser: mocks.getTaskProviderForUser,
  };
});
vi.mock('../../src/services/unified-calendar', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/unified-calendar')>(
    '../../src/services/unified-calendar',
  );
  return {
    ...actual,
    getEventsWithDiagnostics: mocks.getEventsWithDiagnostics,
  };
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
vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  );
  return {
    ...actual,
    getUserTimezone: mocks.getUserTimezone,
    getUserById: mocks.getUserById,
  };
});
vi.mock('../../src/skills/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/skills/registry')>('../../src/skills/registry');
  return { ...actual, isSubmoduleEnabled: mocks.isSubmoduleEnabled };
});
vi.mock('../../src/services/daily-brief-orchestrator', () => ({ composeDailyBrief: mocks.composeDailyBrief }));
vi.mock('../../src/services/weekly-plan-orchestrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/weekly-plan-orchestrator')>(
    '../../src/services/weekly-plan-orchestrator',
  )), composeWeeklyPlan: mocks.composeWeeklyPlan }));

import { collectSecretaryOperationalContext } from '../../src/services/chat-core-v2/secretary-operational-context';

describe('secretary operational context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskProviderForUser.mockReturnValue({ getAllPendingTasks: mocks.getAllPendingTasks });
    mocks.getUserTimezone.mockReturnValue('UTC');
    mocks.getUserById.mockReturnValue({ id: 7, timezone: 'UTC', language: 'en-US' });
    mocks.isSubmoduleEnabled.mockReturnValue(true);
    mocks.getAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    mocks.getEventsWithDiagnostics.mockResolvedValue({
      events: [], status: 'ready', warningCodes: [], warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });
    mocks.isAnyMailConfiguredForUser.mockReturnValue(true);
    mocks.getUnreadMailSummaryForUser.mockResolvedValue({
      configuredProviders: ['outlook'], outlookUnread: 0, gmailUnread: null, totalUnread: 0,
    });
    mocks.getRemindersForWindow.mockReturnValue([]);
    mocks.isGarminConfiguredForUser.mockReturnValue(true);
    mocks.getActivitiesByDateForUser.mockResolvedValue([]);
    mocks.getLatestReadinessEvent.mockReturnValue(null);
    mocks.composeDailyBrief.mockResolvedValue({
      date: '2026-07-10',
      generatedAt: '2026-07-10T12:00:00.000Z',
      degraded: false,
      gated: { skills: [] },
      day: {
        secretary: {
          calendarEventCount: 1,
          pendingTasks: 1,
          tasksDueOnDate: 1,
          overdueTasks: 0,
          mailUnreadTotal: 3,
          writableCalendar: true,
        },
      },
      coordination: {
        topPriority: 'Review launch plan', executionOrder: ['Review launch plan'], watchouts: [], handoffs: [],
        blockers: [], suggestedMoves: [], protectedBlocks: [], nextBestAction: null, confidence: 'high',
        secretaryToday: { summary: 'Review launch plan first.' },
      },
    });
    mocks.composeWeeklyPlan.mockResolvedValue({
      weekStart: '2026-07-06',
      weekEnd: '2026-07-12',
      generatedAt: '2026-07-10T12:00:00.000Z',
      timezone: 'UTC',
      warningCodes: [],
      warnings: [],
      sourceHealth: {
        calendar: { status: 'ready', warningCodes: [], warnings: [] },
        tasks: { status: 'ready', warningCodes: [], warnings: [] },
        mail: { status: 'ready', warningCodes: [], warnings: [] },
        focus: { status: 'ready', warningCodes: [], warnings: [] },
        training: { status: 'ready', warningCodes: [], warnings: [] },
        cooking: { status: 'ready', warningCodes: [], warnings: [] },
        content: { status: 'ready', warningCodes: [], warnings: [] },
        finance: { status: 'ready', warningCodes: [], warnings: [] },
      },
      days: [{
        date: '2026-07-10',
        secretary: {
          calendarEventCount: 1,
          pendingTasks: 1,
          tasksDueOnDate: 1,
          overdueTasks: 0,
          mailUnreadTotal: 3,
          writableCalendar: true,
        },
      }],
      conflicts: [],
      degraded: false,
      gated: { skills: [] },
    });
  });

  it('fails closed before any personal operational producer read for a distinct tenant', async () => {
    const observedAt = '2026-07-10T12:00:00.000Z';
    const result = await collectSecretaryOperationalContext({
      message: 'Plan my private day around tasks, calendar, reminders, email and training',
      userId: 7,
      tenantId: 42,
      planning: true,
      now: new Date(observedAt),
    });

    expect(result).toEqual({
      items: [],
      diagnostics: [
        'tasks',
        'calendar',
        'mail',
        'reminders',
        'readiness',
        'garmin',
        'daily_context',
      ].map((source) => ({
        source,
        status: 'permission_denied',
        observedAt,
        reasonCode: 'authenticated_scope_unavailable',
      })),
    });
    expect(mocks.isSubmoduleEnabled).not.toHaveBeenCalled();
    expect(mocks.getTaskProviderForUser).not.toHaveBeenCalled();
    expect(mocks.getAllPendingTasks).not.toHaveBeenCalled();
    expect(mocks.getEventsWithDiagnostics).not.toHaveBeenCalled();
    expect(mocks.isAnyMailConfiguredForUser).not.toHaveBeenCalled();
    expect(mocks.getUnreadMailSummaryForUser).not.toHaveBeenCalled();
    expect(mocks.getRemindersForWindow).not.toHaveBeenCalled();
    expect(mocks.getLatestReadinessEvent).not.toHaveBeenCalled();
    expect(mocks.isGarminConfiguredForUser).not.toHaveBeenCalled();
    expect(mocks.getActivitiesByDateForUser).not.toHaveBeenCalled();
    expect(mocks.getUserTimezone).not.toHaveBeenCalled();
    expect(mocks.getUserById).not.toHaveBeenCalled();
    expect(mocks.composeDailyBrief).not.toHaveBeenCalled();
    expect(mocks.composeWeeklyPlan).not.toHaveBeenCalled();
  });

  it('collects bounded live evidence without provider bodies or raw health metrics', async () => {
    mocks.getAllPendingTasks.mockResolvedValue({ success: true, data: [{
      id: 'task-1', listId: 'list-1', title: 'Review launch plan', body: 'SECRET TASK BODY',
      importance: 'high', dueDateTime: '2026-07-10T17:00:00.000Z', createdDateTime: '2026-07-09T09:00:00.000Z',
    }] });
    mocks.getEventsWithDiagnostics.mockResolvedValue({
      events: [{
        id: 'event-1', source: 'outlook', summary: 'Planning review',
        start: '2026-07-10T14:00:00.000Z', end: '2026-07-10T15:00:00.000Z',
        description: 'SECRET EVENT BODY', location: 'SECRET LOCATION',
      }],
      status: 'ready', warningCodes: [], warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });
    mocks.getUnreadMailSummaryForUser.mockResolvedValue({
      configuredProviders: ['outlook'], outlookUnread: 3, gmailUnread: null, totalUnread: 3,
    });
    mocks.getRemindersForWindow.mockReturnValue([{
      id: 9, user_id: 7, tenant_id: 7, message: 'Call supplier', remind_at: '2026-07-10T16:00:00.000Z',
      recurring: null, status: 'active', timezone: 'UTC', agenda_item_id: null, created_at: '2026-07-09 08:00:00',
    }]);
    mocks.getActivitiesByDateForUser.mockResolvedValue([{
      activityId: 4, activityName: 'SECRET ACTIVITY NAME', activityType: { typeKey: 'running' },
      startTimeLocal: '2026-07-09T07:00:00', duration: 3600, averageHR: 180,
    }]);
    mocks.getLatestReadinessEvent.mockReturnValue({
      id: 11, user_id: 7, tenant_id: 7, date: '2026-07-10', sleep_hours: 4.2, sleep_quality: 30,
      stress_score: 90, hrv_status: 'low', resting_hr_status: 'elevated', source: 'garmin',
      consent_scope: 'readiness_basic,hrv_status,resting_hr', created_at: '2026-07-10 07:00:00',
    });

    const result = await collectSecretaryOperationalContext({
      message: 'Plan my day around tasks, calendar, reminders, email and training',
      userId: 7,
      tenantId: 7,
      planning: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tasks', status: 'available' }),
      expect.objectContaining({ source: 'calendar', status: 'available' }),
      expect.objectContaining({ source: 'mail', status: 'available' }),
      expect.objectContaining({ source: 'reminders', status: 'available' }),
      expect.objectContaining({ source: 'readiness', status: 'available' }),
      expect.objectContaining({ source: 'garmin', status: 'available' }),
      expect.objectContaining({ source: 'daily_context', status: 'available' }),
    ]));
    const evidence = result.items.map((item) => item.content).join('\n');
    expect(evidence).toContain('Review launch plan');
    expect(evidence).toContain('recovery_signal=caution');
    expect(evidence).not.toContain('SECRET TASK BODY');
    expect(evidence).not.toContain('SECRET EVENT BODY');
    expect(evidence).not.toContain('SECRET LOCATION');
    expect(evidence).not.toContain('SECRET ACTIVITY NAME');
    expect(evidence).not.toContain('180');
    expect(evidence).not.toContain('4.2');
    expect(mocks.composeWeeklyPlan).toHaveBeenCalledTimes(1);
    expect(mocks.composeDailyBrief).toHaveBeenCalledTimes(1);
    expect(mocks.composeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      forceRefresh: true,
      cacheMode: 'bypass',
    }));
    const canonicalWeek = await mocks.composeWeeklyPlan.mock.results[0]?.value;
    const dailyInput = mocks.composeDailyBrief.mock.calls[0]?.[0] as {
      weekPlan?: unknown;
      daySnapshot?: { week?: unknown };
      forceRefresh?: boolean;
      cacheMode?: string;
    };
    expect(dailyInput.weekPlan).toBe(canonicalWeek);
    expect(dailyInput.daySnapshot?.week).toBe(canonicalWeek);
    expect(dailyInput.forceRefresh).toBe(true);
    expect(dailyInput.cacheMode).toBe('bypass');
    expect(mocks.getAllPendingTasks).not.toHaveBeenCalled();
    expect(mocks.getEventsWithDiagnostics).not.toHaveBeenCalled();
    expect(mocks.getUnreadMailSummaryForUser).not.toHaveBeenCalled();
    expect(mocks.getRemindersForWindow).toHaveBeenCalledWith(
      7, 7, '2026-07-10T00:00:00.000Z', '2026-07-10T23:59:59.999Z', 'UTC',
    );
    expect(mocks.getLatestReadinessEvent).toHaveBeenCalledWith(7, 7);
  });

  it('keeps not-requested and ambiguous Garmin empty-or-failure states unknown', async () => {
    const result = await collectSecretaryOperationalContext({
      message: 'How many unread emails?', userId: 7, tenantId: 7,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tasks', status: 'unknown', reasonCode: 'source_not_requested_for_turn' }),
      expect.objectContaining({ source: 'calendar', status: 'unknown', reasonCode: 'source_not_requested_for_turn' }),
      expect.objectContaining({ source: 'garmin', status: 'unknown', reasonCode: 'source_not_requested_for_turn' }),
      expect.objectContaining({ source: 'mail', status: 'empty', reasonCode: 'no_unread_mail' }),
    ]));
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'mail', content: expect.stringContaining('total=0') }),
    ]));

    const garmin = await collectSecretaryOperationalContext({
      message: 'What does Garmin say about training?', userId: 7, tenantId: 7,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(garmin.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'garmin', status: 'unknown', reasonCode: 'garmin_empty_or_read_failed' }),
    ]));
  });

  it.each([
    ['What is on my calendar tomorrow?', '2026-07-11T00:00:00.000Z', '2026-07-11T23:59:59.999Z', 'tomorrow'],
    ['What is on my calendar Friday?', '2026-07-10T00:00:00.000Z', '2026-07-10T23:59:59.999Z', 'friday'],
    ['Plan my week', '2026-07-10T00:00:00.000Z', '2026-07-12T23:59:59.999Z', 'the rest of this week'],
    ['Plan next week', '2026-07-13T00:00:00.000Z', '2026-07-19T23:59:59.999Z', 'next week'],
    ['What is on my calendar next month?', '2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z', 'next month'],
    ['What is on my calendar in 3 days?', '2026-07-13T00:00:00.000Z', '2026-07-13T23:59:59.999Z', 'in 3 days'],
  ] as const)('queries the calendar horizon requested by the user: %s', async (message, expectedStart, expectedEnd, label) => {
    const result = await collectSecretaryOperationalContext({
      message, userId: 7, tenantId: 7,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(mocks.getEventsWithDiagnostics).toHaveBeenCalledWith(expectedStart, expectedEnd, 7);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'calendar', content: expect.stringContaining(`Calendar coverage ${label}`) }),
    ]));
  });

  it('uses the same requested future horizon for reminder evidence', async () => {
    await collectSecretaryOperationalContext({
      message: 'What reminders do I have tomorrow?', userId: 7, tenantId: 7,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(mocks.getRemindersForWindow).toHaveBeenCalledWith(
      7, 7, '2026-07-11T00:00:00.000Z', '2026-07-11T23:59:59.999Z', 'UTC',
    );
  });

  it('reports disabled integrations and source failures without fabricating empty data', async () => {
    mocks.isSubmoduleEnabled.mockImplementation((_skill: string, source: string) => source !== 'calendar');
    mocks.getAllPendingTasks.mockResolvedValue({ success: false, data: [], error: 'provider failed' });
    mocks.getRemindersForWindow.mockImplementation(() => { throw new Error('schema unavailable'); });
    mocks.getLatestReadinessEvent.mockImplementation(() => { throw new Error('read failed'); });
    mocks.isAnyMailConfiguredForUser.mockReturnValue(false);
    mocks.isGarminConfiguredForUser.mockReturnValue(false);
    mocks.composeWeeklyPlan.mockResolvedValueOnce({
      ...(await mocks.composeWeeklyPlan()),
      degraded: true,
      sourceHealth: {
        calendar: { status: 'unavailable', warningCodes: ['CALENDAR_SOURCE_UNAVAILABLE'], warnings: ['Calendar unavailable'] },
        tasks: { status: 'unavailable', warningCodes: ['TASK_SOURCE_UNAVAILABLE'], warnings: ['Tasks unavailable'] },
        mail: { status: 'unavailable', warningCodes: ['MAIL_SOURCE_UNAVAILABLE'], warnings: ['Mail unavailable'] },
        focus: { status: 'unavailable', warningCodes: ['FOCUS_SOURCE_UNAVAILABLE'], warnings: ['Focus unavailable'] },
        training: { status: 'ready', warningCodes: [], warnings: [] },
        cooking: { status: 'ready', warningCodes: [], warnings: [] },
        content: { status: 'ready', warningCodes: [], warnings: [] },
        finance: { status: 'ready', warningCodes: [], warnings: [] },
      },
    });
    mocks.composeDailyBrief.mockResolvedValueOnce({
      ...(await mocks.composeDailyBrief()),
      degraded: true,
    });

    const result = await collectSecretaryOperationalContext({
      message: 'Plan my day', userId: 7, tenantId: 7, planning: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tasks', status: 'failed' }),
      expect.objectContaining({ source: 'calendar', status: 'failed', reasonCode: 'CALENDAR_SOURCE_UNAVAILABLE' }),
      expect.objectContaining({ source: 'mail', status: 'failed', reasonCode: 'MAIL_SOURCE_UNAVAILABLE' }),
      expect.objectContaining({ source: 'reminders', status: 'failed' }),
      expect.objectContaining({ source: 'readiness', status: 'failed' }),
      expect.objectContaining({ source: 'garmin', status: 'permission_denied' }),
    ]));
  });
});
