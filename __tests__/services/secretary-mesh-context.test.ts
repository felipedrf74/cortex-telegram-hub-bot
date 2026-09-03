import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unified-calendar', () => ({
  getEventsWithDiagnostics: vi.fn(),
  hasWritableCalendarForUser: vi.fn(() => true),
}));

let mockAgendaRows: any[] = [];
vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  )),
  getDb: () => ({
    prepare: vi.fn(() => ({ all: vi.fn(() => mockAgendaRows) })),
  }),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: vi.fn(),
}));

vi.mock('../../src/services/secretary-routine-profile', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/secretary-routine-profile')>(
    '../../src/services/secretary-routine-profile',
  )),
  getSecretaryRoutineProfile: vi.fn(() => ({
    status: 'configured',
    version: 1,
    timezone: 'Europe/Lisbon',
    workingWindows: [{
      id: '11111111-1111-4111-8111-111111111111',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      start: '08:00',
      end: '18:30',
    }],
    preferredFocusWindows: [],
    protectedRoutines: [],
    updatedAt: '2026-04-01T00:00:00.000Z',
  })),
}));

vi.mock('../../src/services/task-store/unified-task-store', () => ({
  getPendingTasks: vi.fn(),
}));

vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { readSecretaryMeshContext } from '../../src/services/cross-agent-learning';
import * as calendar from '../../src/services/unified-calendar';
import * as focusPlanner from '../../src/services/focus-planner';
import * as unifiedTasks from '../../src/services/task-store/unified-task-store';
import * as mailPressure from '../../src/services/unified-mail-pressure';
import * as routineProfile from '../../src/services/secretary-routine-profile';
import * as userService from '../../src/services/user-service';

describe('readSecretaryMeshContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));
    vi.clearAllMocks();
    mockAgendaRows = [];
    vi.mocked(calendar.hasWritableCalendarForUser).mockReturnValue(true);
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
      events: [
        { id: 'client', source: 'google', summary: 'Client meeting', start: '2026-04-14T09:00:00.000Z', end: '2026-04-14T09:30:00.000Z' },
        { id: 'sync', source: 'google', summary: 'Project sync', start: '2026-04-14T10:00:00.000Z', end: '2026-04-14T10:30:00.000Z' },
        { id: 'doctor', source: 'google', summary: 'Doctor appointment', start: '2026-04-14T11:00:00.000Z', end: '2026-04-14T11:30:00.000Z' },
        { id: 'sponsor', source: 'google', summary: 'Sponsor call', start: '2026-04-14T14:00:00.000Z', end: '2026-04-14T14:30:00.000Z' },
        { id: 'flight', source: 'google', summary: 'Flight to Porto', start: '2026-04-16T07:00:00.000Z', end: '2026-04-16T09:00:00.000Z' },
      ] as any,
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    vi.mocked(focusPlanner.getFocusBlockRecommendation).mockResolvedValue({
      date: '2026-04-15',
      blockStart: '2026-04-15T08:00:00.000Z',
      blockEnd: '2026-04-15T09:30:00.000Z',
    } as any);
    vi.mocked(unifiedTasks.getPendingTasks).mockReturnValue([
      { id: 't0', title: 'Submit report', dueDate: '2026-04-13T10:00:00.000Z' },
      { id: 't1', title: 'Send proposal', dueDate: '2026-04-14T17:00:00.000Z' },
      { id: 't2', title: 'Review invoice', dueDate: '2026-04-14T18:00:00.000Z' },
      { id: 't4', title: 'Brainstorm topic ideas', dueDate: undefined },
      { id: 't5', title: 'Clean inbox labels', dueDate: undefined },
    ] as any);
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['gmail'],
      totalUnread: 12,
      outlookUnread: null,
      gmailUnread: 12,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes richer secretary signals including Gmail pressure and fragmentation', async () => {
    const context = await readSecretaryMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-14' });

    expect(unifiedTasks.getPendingTasks).toHaveBeenCalledWith(42, 42);
    expect(context.dueToday.map((task) => task.id)).toEqual(['t1', 't2']);

    const signalTypes = context.derivedSignals.map((signal) => signal.signalType);
    expect(signalTypes).toContain('calendar_busy_blocks');
    expect(signalTypes).toContain('travel_window');
    expect(signalTypes).toContain('inbox_pressure');
    expect(signalTypes).toContain('calendar_fragmentation');
    expect(signalTypes).toContain('meeting_criticality');
    expect(signalTypes).toContain('deadline_pressure');
    expect(signalTypes).toContain('task_portability');

    const inbox = context.derivedSignals.find((signal) => signal.signalType === 'inbox_pressure');
    expect(inbox?.payload.mailUnreadTotal).toBe(12);
    expect(inbox?.payload.gmailUnread).toBe(12);
    expect(inbox?.payload.mailProviders).toEqual(['gmail']);

    const fragmentation = context.derivedSignals.find((signal) => signal.signalType === 'calendar_fragmentation');
    expect(fragmentation?.payload.dates).toContain('2026-04-14');

    const portability = context.derivedSignals.find((signal) => signal.signalType === 'task_portability');
    expect(portability?.payload.portableCount).toBe(2);
    expect(portability?.payload.fixedCount).toBe(3);
    expect(context.dueThisWeek.map((task) => task.id)).toEqual(['t1', 't2']);
    expect(context.overdue.map((task) => task.id)).toEqual(['t0']);
    expect(context.derivedSignals.find((signal) => signal.signalType === 'deadline_pressure')?.payload)
      .toMatchObject({ dueThisWeekCount: 2, overdueCount: 1 });
    expect(context.sourceHealth?.calendar.status).toBe('ready');
    expect(context.sourceHealth?.tasks.status).toBe('ready');
    expect(calendar.getEventsWithDiagnostics).toHaveBeenCalledOnce();
    expect(focusPlanner.getFocusBlockRecommendation).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        timezone: 'Europe/Lisbon',
        calendarEvents: expect.arrayContaining([
          expect.objectContaining({ id: 'client' }),
          expect.objectContaining({ id: 'flight' }),
        ]),
      }),
    );
  });

  it('keeps tenant task scope and projects task and meeting dates in the user timezone', async () => {
    vi.setSystemTime(new Date('2026-04-14T20:30:00.000Z')); // 2026-04-14 10:30 in Honolulu
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValueOnce({
      events: [
        { id: 'local', source: 'google', summary: 'Client meeting', start: '2026-04-14T01:00:00', end: '2026-04-14T02:00:00' },
        { id: 'offset', source: 'google', summary: 'Doctor call', start: '2026-04-14T01:00:00.000Z', end: '2026-04-14T02:00:00.000Z' },
      ] as any,
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    vi.mocked(unifiedTasks.getPendingTasks).mockReturnValueOnce([
      { id: 'tenant-local-task', title: 'Tenant local deadline', dueDate: '2026-04-14T01:30:00' },
      { id: 'tenant-offset-task', title: 'Tenant offset deadline', dueDate: '2026-04-14T01:30:00.000Z' },
    ] as any);

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-13',
      timezone: 'Pacific/Honolulu',
    });

    expect(unifiedTasks.getPendingTasks).toHaveBeenCalledWith(42, 42);
    expect(context.dueToday.map((task) => task.id)).toEqual(['tenant-local-task']);
    expect(context.overdue.map((task) => task.id)).toEqual(['tenant-offset-task']);
    expect(context.derivedSignals.find((signal) => signal.signalType === 'meeting_criticality')?.payload.dates)
      .toEqual(expect.arrayContaining(['2026-04-13', '2026-04-14']));
    expect(calendar.getEventsWithDiagnostics).toHaveBeenCalledWith(
      '2026-04-13T10:00:00.000Z',
      '2026-04-20T09:59:59.999Z',
      42,
    );
  });

  it('uses the request-captured local date instead of reading the process clock again', async () => {
    vi.setSystemTime(new Date('2026-04-14T23:59:59.999Z'));
    vi.mocked(unifiedTasks.getPendingTasks).mockReturnValueOnce([
      { id: 'captured', title: 'Captured-day task', dueDate: '2026-04-14T17:00:00.000Z' },
      { id: 'later', title: 'Later task', dueDate: '2026-04-15T17:00:00.000Z' },
    ] as any);

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-13',
      timezone: 'Europe/Lisbon',
      referenceDate: '2026-04-14',
    });

    expect(context.dueToday.map((task) => task.id)).toEqual(['captured']);
  });

  it('derives past and future task pressure from the requested week instead of process today', async () => {
    vi.mocked(unifiedTasks.getPendingTasks).mockReturnValue([
      { id: 'past', title: 'Past', dueDate: '2026-04-06T12:00:00.000Z' },
      { id: 'requested', title: 'Requested', dueDate: '2026-04-21T12:00:00.000Z' },
      { id: 'later', title: 'Later', dueDate: '2026-04-25T12:00:00.000Z' },
      { id: 'future', title: 'Future', dueDate: '2026-05-04T12:00:00.000Z' },
    ] as any);

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-21',
    });

    expect(context.weekStart).toBe('2026-04-20');
    expect(context.dueToday.map((task) => task.id)).toEqual(['requested']);
    expect(context.dueThisWeek.map((task) => task.id)).toEqual(['requested', 'later']);
    expect(context.overdue.map((task) => task.id)).toEqual(['past']);
    expect(context.pending.map((task) => task.id)).toEqual(['past', 'requested', 'later', 'future']);
  });

  it('binds the requested week and due timestamps to the account IANA timezone', async () => {
    vi.mocked(unifiedTasks.getPendingTasks).mockReturnValue([
      { id: 'utc-monday-local-sunday', title: 'Late Sunday task', dueDate: '2026-04-20T00:30:00.000Z' },
      { id: 'local-monday', title: 'Monday task', dueDate: '2026-04-20T16:00:00.000Z' },
    ] as any);

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-20',
      timezone: 'America/Los_Angeles',
    });

    expect(context.weekStart).toBe('2026-04-20');
    expect(context.dueToday.map((task) => task.id)).toEqual(['local-monday']);
    expect(context.overdue.map((task) => task.id)).toEqual(['utc-monday-local-sunday']);
    expect(calendar.getEventsWithDiagnostics).toHaveBeenCalledWith(
      '2026-04-20T07:00:00.000Z',
      '2026-04-27T06:59:59.999Z',
      42,
    );
  });

  it('fails closed before reads when tenant scope is invalid or mismatched', async () => {
    const context = await readSecretaryMeshContext({ userId: 42, tenantId: 84, weekStart: '2026-04-21' });

    expect(context).toEqual(expect.objectContaining({ userId: 42, events: [], pending: [], derivedSignals: [] }));
    expect(calendar.getEventsWithDiagnostics).not.toHaveBeenCalled();
    expect(unifiedTasks.getPendingTasks).not.toHaveBeenCalled();
    expect(mailPressure.getUnreadMailSummaryForUser).not.toHaveBeenCalled();
    expect(routineProfile.getSecretaryRoutineProfile).not.toHaveBeenCalled();
    expect(userService.getUserTimezoneById).not.toHaveBeenCalled();
  });

  it('keeps unsynced Nexus agenda commitments visible before provider sync', async () => {
    mockAgendaRows = [{
      title: 'Protected content block',
      start_at: '2026-04-15T09:00:00.000Z',
      end_at: '2026-04-15T10:00:00.000Z',
      provider_event_id: null,
      provider_source: null,
    }];

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-14',
      timezone: 'Europe/Lisbon',
    });

    expect(context.localAgendaItems).toEqual([
      expect.objectContaining({ title: 'Protected content block', providerEventId: null }),
    ]);
  });

  it('deduplicates the local ledger after its provider event is synchronized', async () => {
    mockAgendaRows = [{
      title: 'Client meeting',
      start_at: '2026-04-14T09:00:00.000Z',
      end_at: '2026-04-14T09:30:00.000Z',
      provider_event_id: 'client',
      provider_source: 'google',
    }];

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-14',
      timezone: 'Europe/Lisbon',
    });

    expect(context.localAgendaItems).toEqual([]);
    expect(context.events.filter((event) => event.id === 'client')).toHaveLength(1);
  });

  it('keeps a healthy read-only calendar ready while reporting write capability separately', async () => {
    vi.mocked(calendar.hasWritableCalendarForUser).mockReturnValueOnce(false);

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-14',
      timezone: 'Europe/Lisbon',
    });

    expect(context.sourceHealth?.calendar.status).toBe('ready');
    expect(context.writableCalendar).toBe(false);
  });

  it('does not expose a focus window when provider calendar state is unavailable', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValueOnce({
      events: [],
      status: 'unavailable',
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.'],
      sources: { configured: ['google'], fulfilled: [], failed: ['google'] },
    });

    const context = await readSecretaryMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-14' });

    expect(context.focusBlock).toBeNull();
    expect(context.sourceHealth?.calendar.status).toBe('degraded');
    expect(context.sourceHealth?.focus.status).toBe('unavailable');
  });

  it('does not turn an unavailable mail read into zero inbox pressure', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser)
      .mockRejectedValueOnce(new Error('mail unavailable'));

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-14',
    });

    expect(context.sourceHealth?.mail.status).toBe('unavailable');
    expect(context.derivedSignals.find((signal) => signal.signalType === 'inbox_pressure'))
      .toBeUndefined();
    expect(context.derivedSignals.find((signal) => signal.signalType === 'deadline_pressure'))
      .toBeUndefined();
  });

  it('does not publish failed task counts as confirmed workload or portability', async () => {
    vi.mocked(unifiedTasks.getPendingTasks)
      .mockImplementationOnce(() => { throw new Error('tasks unavailable'); });

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-14',
    });

    expect(context.sourceHealth?.tasks.status).toBe('unavailable');
    expect(context.derivedSignals.find((signal) => signal.signalType === 'inbox_pressure'))
      .toBeUndefined();
    expect(context.derivedSignals.find((signal) => signal.signalType === 'deadline_pressure'))
      .toBeUndefined();
    expect(context.derivedSignals.find((signal) => signal.signalType === 'task_portability'))
      .toBeUndefined();
  });

  it('adds protected routines without writing or inventing provider events', async () => {
    vi.mocked(routineProfile.getSecretaryRoutineProfile).mockReturnValueOnce({
      status: 'configured',
      version: 2,
      timezone: 'Europe/Lisbon',
      workingWindows: [],
      preferredFocusWindows: [],
      protectedRoutines: [{
        id: '22222222-2222-4222-8222-222222222222',
        weekdays: [3],
        start: '07:30',
        end: '08:30',
        label: 'Protected recovery',
        kind: 'recovery',
      }],
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-13',
      timezone: 'Europe/Lisbon',
    });

    expect(context.localAgendaItems).toContainEqual(expect.objectContaining({
      title: 'Protected recovery',
      providerEventId: null,
      providerSource: null,
    }));
    expect(calendar.hasWritableCalendarForUser).toHaveBeenCalledWith(42);
  });

  it('uses protected routine kind for travel orchestration even when the label is opaque', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValueOnce({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    vi.mocked(routineProfile.getSecretaryRoutineProfile).mockReturnValueOnce({
      status: 'configured',
      version: 4,
      timezone: 'Europe/Lisbon',
      workingWindows: [],
      preferredFocusWindows: [],
      protectedRoutines: [{
        id: '44444444-4444-4444-8444-444444444444',
        weekdays: [3],
        start: '07:30',
        end: '08:30',
        label: 'Protected block',
        kind: 'travel',
      }],
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-04-13',
      timezone: 'Europe/Lisbon',
    });

    expect(context.localAgendaItems).toContainEqual(expect.objectContaining({
      title: 'Protected block',
      routineKind: 'travel',
    }));
    expect(context.derivedSignals.find((signal) => signal.signalType === 'travel_window')?.payload.dates)
      .toContain('2026-04-15');
  });

  it('does not infer a focus workday for an unconfigured routine profile', async () => {
    vi.mocked(routineProfile.getSecretaryRoutineProfile).mockReturnValueOnce({
      status: 'unconfigured',
      version: 0,
      timezone: 'Europe/Lisbon',
      workingWindows: [],
      preferredFocusWindows: [],
      protectedRoutines: [],
      updatedAt: null,
    });

    const context = await readSecretaryMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });

    expect(focusPlanner.getFocusBlockRecommendation).not.toHaveBeenCalled();
    expect(context.focusBlock).toBeNull();
    expect(context.sourceHealth?.focus).toEqual(expect.objectContaining({
      status: 'unavailable',
      warningCodes: ['SECRETARY_ROUTINE_UNCONFIGURED'],
    }));
  });

  it('skips a nonexistent DST routine wall time instead of shifting the protected commitment', async () => {
    vi.mocked(routineProfile.getSecretaryRoutineProfile).mockReturnValueOnce({
      status: 'configured',
      version: 3,
      timezone: 'Europe/Lisbon',
      workingWindows: [],
      preferredFocusWindows: [],
      protectedRoutines: [{
        id: '33333333-3333-4333-8333-333333333333',
        weekdays: [7],
        start: '01:30',
        end: '02:30',
        label: 'DST-sensitive recovery',
        kind: 'recovery',
      }],
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 42,
      weekStart: '2026-03-23',
      timezone: 'Europe/Lisbon',
    });

    expect(context.localAgendaItems).not.toContainEqual(expect.objectContaining({
      title: 'DST-sensitive recovery',
    }));
    expect(context.sourceHealth?.calendar).toEqual(expect.objectContaining({
      status: 'degraded',
      warningCodes: expect.arrayContaining(['SECRETARY_ROUTINE_SCHEDULE_UNAVAILABLE']),
    }));
  });
});
