import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetTaskProviderForUser = vi.fn();
const mockResolveTaskProvider = vi.fn();
vi.mock('../../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
  resolveTaskProvider: (...args: unknown[]) => mockResolveTaskProvider(...args),
}));

const mockResolveCanonicalUserId = vi.fn();
vi.mock('../../../src/services/user-service', () => ({
  resolveCanonicalUserId: (...args: unknown[]) => mockResolveCanonicalUserId(...args),
  getUserLanguage: vi.fn(() => 'en'),
}));

vi.mock('../../../src/services/microsoft-todo', () => ({
  getAllPendingTasks: vi.fn(),
  getTasksDueInRange: vi.fn(),
}));

const mockGetActiveReminders = vi.fn();
vi.mock('../../../src/state/reminders', () => ({
  getActiveReminders: (...args: unknown[]) => mockGetActiveReminders(...args),
}));

const mockGetEvents = vi.fn();
const mockHasConnectedCalendarForUser = vi.fn();
vi.mock('../../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  hasConnectedCalendarForUser: (...args: unknown[]) => mockHasConnectedCalendarForUser(...args),
  isAnyCalendarConfigured: vi.fn(() => false),
}));

const mockIsOutlookMailConfiguredForUser = vi.fn();
const mockGetUnreadCountForUser = vi.fn();
vi.mock('../../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn(() => false),
  isOutlookMailConfiguredForUser: (...args: unknown[]) => mockIsOutlookMailConfiguredForUser(...args),
  getUnreadCount: vi.fn(async () => 0),
  getUnreadCountForUser: (...args: unknown[]) => mockGetUnreadCountForUser(...args),
}));

vi.mock('../../../src/utils/callback-store', () => ({
  storeCallback: vi.fn(() => 'cb-ref'),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../../src/utils/date-parser', () => ({
  startOfDay: vi.fn(() => '2026-04-17T00:00:00'),
  endOfDay: vi.fn(() => '2026-04-17T23:59:59'),
  startOfWeek: vi.fn(() => '2026-04-14T00:00:00'),
  endOfWeek: vi.fn(() => '2026-04-20T23:59:59'),
  now: vi.fn(() => ({
    toFormat: vi.fn((format: string) => {
      if (format.includes('cccc')) return 'Friday, April 17 2026';
      if (format.includes('LLL dd')) return 'Apr 14';
      return 'Friday, April 17 2026';
    }),
    startOf: vi.fn(() => ({ toFormat: vi.fn(() => 'Apr 14') })),
    endOf: vi.fn(() => ({ toFormat: vi.fn(() => 'Apr 20 2026') })),
  })),
  formatTime: vi.fn(() => '09:00'),
  formatDateTime: vi.fn((value: string) => value),
  formatDate: vi.fn((value: string) => value),
  parseNaturalDate: vi.fn(() => null),
}));

import {
  handleDeleteTask,
  handlePendingEdit,
  handleTodoSummary,
  handleStatus,
  handleUndone,
  handleDayOverview,
  handleWeekOverview,
} from '../../../src/handlers/commands/secretary-helpers';

function makeCtx(telegramId = 42) {
  return {
    from: { id: telegramId },
    reply: vi.fn(async () => undefined),
  } as any;
}

describe('secretary helper tenant routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCanonicalUserId.mockReturnValue(1042);
    mockResolveTaskProvider.mockReturnValue('nexus');
    mockGetTaskProviderForUser.mockReturnValue({
      searchTasks: vi.fn(async () => ({
        success: true,
        data: [
          {
            id: 'task-1',
            title: 'Scoped task',
            listId: 'list-1',
            listName: 'Inbox',
            status: 'completed',
          },
        ],
      })),
      uncompleteTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', status: 'notStarted' } })),
      updateTask: vi.fn(async () => ({ success: true, data: { id: 'task-1' } })),
      getAllPendingTasks: vi.fn(async () => ({
        success: true,
        data: [
          {
            id: 'task-1',
            title: 'Scoped task',
            listId: 'list-1',
            listName: 'Inbox',
            importance: 'high',
            dueDateTime: '2026-04-17T10:00:00',
          },
        ],
      })),
      getTasksDueInRange: vi.fn(async () => ({
        success: true,
        data: [
          {
            id: 'task-1',
            title: 'Scoped task',
            listId: 'list-1',
            listName: 'Inbox',
            importance: 'high',
            dueDateTime: '2026-04-17T10:00:00',
          },
        ],
      })),
    });
    mockGetActiveReminders.mockReturnValue([
      { id: 1, message: 'Scoped reminder', remind_at: '2026-04-17T08:00:00', status: 'active' },
    ]);
    mockHasConnectedCalendarForUser.mockReturnValue(true);
    mockGetEvents.mockResolvedValue([
      {
        id: 'evt-1',
        summary: 'Scoped meeting',
        start: '2026-04-17T09:00:00',
        end: '2026-04-17T10:00:00',
        source: 'outlook',
      },
    ]);
    mockIsOutlookMailConfiguredForUser.mockReturnValue(true);
    mockGetUnreadCountForUser.mockResolvedValue(5);
  });

  it('routes todo summary through the canonical user task provider', async () => {
    const ctx = makeCtx();

    await handleTodoSummary(ctx);

    expect(mockResolveCanonicalUserId).toHaveBeenCalledWith(42);
    expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(1042);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Pending'), { parse_mode: 'HTML' });
  });

  it('routes status through scoped task, reminder, calendar, and mail reads', async () => {
    const ctx = makeCtx();

    await handleStatus(ctx);

    expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(1042);
    expect(mockGetActiveReminders).toHaveBeenCalledWith(1042);
    expect(mockHasConnectedCalendarForUser).toHaveBeenCalledWith(1042);
    expect(mockGetEvents).toHaveBeenCalledWith('2026-04-17T00:00:00', '2026-04-17T23:59:59', 1042);
    expect(mockIsOutlookMailConfiguredForUser).toHaveBeenCalledWith(1042);
    expect(mockGetUnreadCountForUser).toHaveBeenCalledWith(1042);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Tasks: 1 pending tasks'), { parse_mode: 'HTML' });
  });

  it('routes day and week overviews through the scoped user provider', async () => {
    const ctx = makeCtx();

    await handleDayOverview(ctx);
    await handleWeekOverview(ctx);

    const provider = mockGetTaskProviderForUser.mock.results[0]?.value;
    expect(provider.getTasksDueInRange).toHaveBeenCalledWith('2026-04-17T00:00:00', '2026-04-17T23:59:59');
    expect(provider.getAllPendingTasks).toHaveBeenCalled();
    expect(mockGetEvents).toHaveBeenCalledWith('2026-04-17T00:00:00', '2026-04-17T23:59:59', 1042);
    expect(mockGetEvents).toHaveBeenCalledWith('2026-04-14T00:00:00', '2026-04-20T23:59:59', 1042);
  });

  it('routes undo, delete, and pending edits through the scoped provider', async () => {
    const ctx = {
      ...makeCtx(),
      replyWithChatAction: vi.fn(async () => undefined),
    } as any;

    await handleUndone(ctx, 'Scoped task');
    await handleDeleteTask(ctx, 'Scoped task');
    await handlePendingEdit(ctx, {
      listId: 'list-1',
      taskId: 'task-1',
      title: 'Scoped task',
      listName: 'Inbox',
      field: 'title',
      expires: Date.now() + 1000,
    }, 'Renamed task');

    const provider = mockGetTaskProviderForUser.mock.results[0]?.value;
    expect(provider.searchTasks).toHaveBeenCalledWith('Scoped task');
    expect(provider.uncompleteTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(provider.updateTask).toHaveBeenCalledWith('list-1', 'task-1', { title: 'Renamed task' });
  });

  it('fails closed when no canonical tenant exists', async () => {
    mockResolveCanonicalUserId.mockReturnValue(null);
    const ctx = makeCtx(99);

    await handleTodoSummary(ctx);
    await handleStatus(ctx);
    await handleUndone(ctx, 'Scoped task');

    expect(mockGetTaskProviderForUser).not.toHaveBeenCalled();
    expect(mockGetActiveReminders).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('⚠️ Task provider unavailable for this user.');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Tasks: unavailable'), { parse_mode: 'HTML' });
  });
});
