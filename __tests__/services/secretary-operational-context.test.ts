// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllPendingTasks: vi.fn(),
  getEventsWithDiagnostics: vi.fn(),
  getUnreadMailSummaryForUser: vi.fn(),
  isAnyMailConfiguredForUser: vi.fn(),
  getRemindersForWindow: vi.fn(),
  getActivitiesByDateForUser: vi.fn(),
  isGarminConfiguredForUser: vi.fn(),
  getLatestReadinessEvent: vi.fn(),
  isSubmoduleEnabled: vi.fn(),
  composeDailyBrief: vi.fn(),
}));

vi.mock('../../src/services/task-store/task-router', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/task-store/task-router')>(
    '../../src/services/task-store/task-router',
  );
  return {
    ...actual,
    getTaskProviderForUser: () => ({ getAllPendingTasks: mocks.getAllPendingTasks }),
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
  return { ...actual, getUserTimezone: () => 'UTC' };
});
vi.mock('../../src/skills/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/skills/registry')>('../../src/skills/registry');
  return { ...actual, isSubmoduleEnabled: mocks.isSubmoduleEnabled };
});
vi.mock('../../src/services/daily-brief-orchestrator', () => ({ composeDailyBrief: mocks.composeDailyBrief }));

import { collectSecretaryOperationalContext } from '../../src/services/chat-core-v2/secretary-operational-context';

describe('secretary operational context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      coordination: {
        topPriority: 'Review launch plan', executionOrder: ['Review launch plan'], watchouts: [], handoffs: [],
        blockers: [], suggestedMoves: [], protectedBlocks: [], nextBestAction: null, confidence: 'high',
      },
    });
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
      id: 9, user_id: 7, tenant_id: 42, message: 'Call supplier', remind_at: '2026-07-10T16:00:00.000Z',
      recurring: null, status: 'active', timezone: 'UTC', agenda_item_id: null, created_at: '2026-07-09 08:00:00',
    }]);
    mocks.getActivitiesByDateForUser.mockResolvedValue([{
      activityId: 4, activityName: 'SECRET ACTIVITY NAME', activityType: { typeKey: 'running' },
      startTimeLocal: '2026-07-09T07:00:00', duration: 3600, averageHR: 180,
    }]);
    mocks.getLatestReadinessEvent.mockReturnValue({
      id: 11, user_id: 7, tenant_id: 42, date: '2026-07-10', sleep_hours: 4.2, sleep_quality: 30,
      stress_score: 90, hrv_status: 'low', resting_hr_status: 'elevated', source: 'garmin',
      consent_scope: 'readiness_basic,hrv_status,resting_hr', created_at: '2026-07-10 07:00:00',
    });

    const result = await collectSecretaryOperationalContext({
      message: 'Plan my day around tasks, calendar, reminders, email and training',
      userId: 7,
      tenantId: 42,
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
    expect(mocks.getRemindersForWindow).toHaveBeenCalledWith(
      7, 42, '2026-07-10T00:00:00.000Z', '2026-07-10T23:59:59.999Z', 'UTC',
    );
    expect(mocks.getLatestReadinessEvent).toHaveBeenCalledWith(7, 42);
  });

  it('keeps not-requested and ambiguous Garmin empty-or-failure states unknown', async () => {
    const result = await collectSecretaryOperationalContext({
      message: 'How many unread emails?', userId: 7, tenantId: 42,
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
      message: 'What does Garmin say about training?', userId: 7, tenantId: 42,
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
      message, userId: 7, tenantId: 42,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(mocks.getEventsWithDiagnostics).toHaveBeenCalledWith(expectedStart, expectedEnd, 7);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'calendar', content: expect.stringContaining(`Calendar coverage ${label}`) }),
    ]));
  });

  it('uses the same requested future horizon for reminder evidence', async () => {
    await collectSecretaryOperationalContext({
      message: 'What reminders do I have tomorrow?', userId: 7, tenantId: 42,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(mocks.getRemindersForWindow).toHaveBeenCalledWith(
      7, 42, '2026-07-11T00:00:00.000Z', '2026-07-11T23:59:59.999Z', 'UTC',
    );
  });

  it('reports disabled integrations and source failures without fabricating empty data', async () => {
    mocks.isSubmoduleEnabled.mockImplementation((_skill: string, source: string) => source !== 'calendar');
    mocks.getAllPendingTasks.mockResolvedValue({ success: false, data: [], error: 'provider failed' });
    mocks.getRemindersForWindow.mockImplementation(() => { throw new Error('schema unavailable'); });
    mocks.getLatestReadinessEvent.mockImplementation(() => { throw new Error('read failed'); });
    mocks.isAnyMailConfiguredForUser.mockReturnValue(false);
    mocks.isGarminConfiguredForUser.mockReturnValue(false);

    const result = await collectSecretaryOperationalContext({
      message: 'Plan my day', userId: 7, tenantId: 42, planning: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tasks', status: 'failed' }),
      expect.objectContaining({ source: 'calendar', status: 'permission_denied', reasonCode: 'secretary_calendar_disabled' }),
      expect.objectContaining({ source: 'mail', status: 'permission_denied', reasonCode: 'mail_integration_not_connected' }),
      expect.objectContaining({ source: 'reminders', status: 'failed' }),
      expect.objectContaining({ source: 'readiness', status: 'failed' }),
      expect.objectContaining({ source: 'garmin', status: 'permission_denied' }),
    ]));
  });
});
