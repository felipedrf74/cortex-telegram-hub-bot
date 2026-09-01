import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: vi.fn(),
  hasWritableCalendarForUser: vi.fn(() => true),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: vi.fn(),
}));

vi.mock('../../src/services/task-store/unified-task-store', () => ({
  getPendingTasks: vi.fn(),
}));

vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserTimezoneById: vi.fn(() => 'UTC'),
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

describe('readSecretaryMeshContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));
    vi.clearAllMocks();
    vi.mocked(calendar.hasWritableCalendarForUser).mockReturnValue(true);
    vi.mocked(calendar.getEvents).mockResolvedValue([
      { summary: 'Client meeting', start: '2026-04-14T09:00:00.000Z', end: '2026-04-14T09:30:00.000Z' },
      { summary: 'Project sync', start: '2026-04-14T10:00:00.000Z', end: '2026-04-14T10:30:00.000Z' },
      { summary: 'Doctor appointment', start: '2026-04-14T11:00:00.000Z', end: '2026-04-14T11:30:00.000Z' },
      { summary: 'Sponsor call', start: '2026-04-14T14:00:00.000Z', end: '2026-04-14T14:30:00.000Z' },
      { summary: 'Flight to Porto', start: '2026-04-16T07:00:00.000Z', end: '2026-04-16T09:00:00.000Z' },
    ] as any);
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
    const context = await readSecretaryMeshContext({ userId: 42, tenantId: 84, weekStart: '2026-04-14' });

    expect(unifiedTasks.getPendingTasks).toHaveBeenCalledWith(42, 84);
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
  });

  it('keeps tenant task scope and projects task and meeting dates in the user timezone', async () => {
    vi.setSystemTime(new Date('2026-04-14T20:30:00.000Z')); // 2026-04-14 10:30 in Honolulu
    vi.mocked(calendar.getEvents).mockResolvedValueOnce([
      { summary: 'Client meeting', start: '2026-04-14T01:00:00', end: '2026-04-14T02:00:00' },
      { summary: 'Doctor call', start: '2026-04-14T01:00:00.000Z', end: '2026-04-14T02:00:00.000Z' },
    ] as any);
    vi.mocked(unifiedTasks.getPendingTasks).mockReturnValueOnce([
      { id: 'tenant-local-task', title: 'Tenant local deadline', dueDate: '2026-04-14T01:30:00' },
      { id: 'tenant-offset-task', title: 'Tenant offset deadline', dueDate: '2026-04-14T01:30:00.000Z' },
    ] as any);

    const context = await readSecretaryMeshContext({
      userId: 42,
      tenantId: 900,
      weekStart: '2026-04-13',
      timezone: 'Pacific/Honolulu',
    });

    expect(unifiedTasks.getPendingTasks).toHaveBeenCalledWith(42, 900);
    expect(context.dueToday.map((task) => task.id)).toEqual(['tenant-local-task']);
    expect(context.overdue.map((task) => task.id)).toEqual(['tenant-offset-task']);
    expect(context.derivedSignals.find((signal) => signal.signalType === 'meeting_criticality')?.payload.dates)
      .toEqual(expect.arrayContaining(['2026-04-13', '2026-04-14']));
    expect(calendar.getEvents).toHaveBeenCalledWith(
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
      tenantId: 84,
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
      tenantId: 84,
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
      tenantId: 84,
      weekStart: '2026-04-20',
      timezone: 'America/Los_Angeles',
    });

    expect(context.weekStart).toBe('2026-04-20');
    expect(context.dueToday.map((task) => task.id)).toEqual(['local-monday']);
    expect(context.overdue.map((task) => task.id)).toEqual(['utc-monday-local-sunday']);
    expect(calendar.getEvents).toHaveBeenCalledWith(
      '2026-04-20T07:00:00.000Z',
      '2026-04-27T06:59:59.999Z',
      42,
    );
  });

  it('fails closed before reads when tenant scope is invalid', async () => {
    const context = await readSecretaryMeshContext({ userId: 42, tenantId: 0, weekStart: '2026-04-21' });

    expect(context).toEqual(expect.objectContaining({ userId: 42, events: [], pending: [], derivedSignals: [] }));
    expect(calendar.getEvents).not.toHaveBeenCalled();
    expect(unifiedTasks.getPendingTasks).not.toHaveBeenCalled();
  });
});
