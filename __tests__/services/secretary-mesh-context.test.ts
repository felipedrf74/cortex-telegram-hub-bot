import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: vi.fn(),
  hasWritableCalendarForUser: vi.fn(() => true),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: vi.fn(),
}));

vi.mock('../../src/services/task-store/unified-task-store', () => ({
  getTasksDueToday: vi.fn(),
  getTasksDueThisWeek: vi.fn(),
  getOverdueTasks: vi.fn(),
  getPendingTasks: vi.fn(),
}));

vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { readSecretaryMeshContext } from '../../src/services/cross-agent-learning';
import * as calendar from '../../src/services/unified-calendar';
import * as focusPlanner from '../../src/services/focus-planner';
import * as unifiedTasks from '../../src/services/task-store/unified-task-store';
import * as mailPressure from '../../src/services/unified-mail-pressure';

describe('readSecretaryMeshContext', () => {
  beforeEach(() => {
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
    vi.mocked(unifiedTasks.getTasksDueToday).mockReturnValue([
      { id: 't1', title: 'Send proposal', dueDate: '2026-04-14T17:00:00.000Z' },
      { id: 't2', title: 'Review invoice', dueDate: '2026-04-14T18:00:00.000Z' },
    ] as any);
    vi.mocked(unifiedTasks.getTasksDueThisWeek).mockReturnValue([
      { id: 't1', title: 'Send proposal', dueDate: '2026-04-14T17:00:00.000Z' },
      { id: 't2', title: 'Review invoice', dueDate: '2026-04-14T18:00:00.000Z' },
      { id: 't3', title: 'Prepare travel bag', dueDate: '2026-04-16T06:00:00.000Z' },
    ] as any);
    vi.mocked(unifiedTasks.getOverdueTasks).mockReturnValue([
      { id: 't0', title: 'Submit report', dueDate: '2026-04-13T10:00:00.000Z' },
    ] as any);
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

  it('publishes richer secretary signals including Gmail pressure and fragmentation', async () => {
    const context = await readSecretaryMeshContext({ userId: 42, weekStart: '2026-04-14' });

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
  });
});
