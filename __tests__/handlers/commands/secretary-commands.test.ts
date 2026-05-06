import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnqueue = vi.fn((_userId: number, fn: () => Promise<void>) => fn());
const mockFormatMsTodoLists = vi.fn(() => '<b>Lists</b>');
const mockFormatMsTodoTasks = vi.fn(() => '<b>Tasks</b>');
const mockFormatMsTodoTaskCreated = vi.fn(() => '<b>Created</b>');
const mockFormatChecklistItems = vi.fn(() => '<b>Checklist</b>');
const mockFormatAllTasks = vi.fn(() => '<b>All Tasks</b>');
const mockFormatCompletedTasks = vi.fn(() => '<b>Completed</b>');
const mockGetUserLanguage = vi.fn(() => 'en-US');

vi.mock('../../../src/handlers/shared-state', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args as [number, () => Promise<void>]),
}));

const mockGetTelegramTaskScope = vi.fn();
const mockReplyTaskProviderUnavailable = vi.fn(async () => undefined);
const mockBuildTaskListKeyboard = vi.fn(() => ({ inline_keyboard: [] }));
vi.mock('../../../src/handlers/commands/secretary-helpers', () => ({
  buildTaskListKeyboard: (...args: unknown[]) => mockBuildTaskListKeyboard(...args),
  handleUndone: vi.fn(async () => undefined),
  handleDeleteTask: vi.fn(async () => undefined),
  handleTodoSummary: vi.fn(async () => undefined),
  handleStatus: vi.fn(async () => undefined),
  handleDayOverview: vi.fn(async () => undefined),
  handleWeekOverview: vi.fn(async () => undefined),
  getTelegramTaskScope: (...args: unknown[]) => mockGetTelegramTaskScope(...args),
  replyTaskProviderUnavailable: (...args: unknown[]) => mockReplyTaskProviderUnavailable(...args),
}));

vi.mock('../../../src/handlers/message', () => ({
  handleDomainMessage: vi.fn(async () => undefined),
}));

vi.mock('../../../src/config', () => ({
  config: {
    todo: { defaultList: 'Tasks' },
  },
}));

vi.mock('../../../src/utils/callback-store', () => ({
  storeCallback: vi.fn(() => 'cb-ref'),
}));

vi.mock('../../../src/utils/telegram-formatter', () => ({
  formatMsTodoLists: (...args: unknown[]) => mockFormatMsTodoLists(...args),
  formatMsTodoTasks: (...args: unknown[]) => mockFormatMsTodoTasks(...args),
  formatMsTodoTaskCreated: (...args: unknown[]) => mockFormatMsTodoTaskCreated(...args),
  splitMessage: vi.fn((value: string) => [value]),
  escapeHtml: vi.fn((value: string) => value),
  formatChecklistItems: (...args: unknown[]) => mockFormatChecklistItems(...args),
  formatAllTasks: (...args: unknown[]) => mockFormatAllTasks(...args),
  formatCompletedTasks: (...args: unknown[]) => mockFormatCompletedTasks(...args),
}));

vi.mock('../../../src/utils/date-parser', () => ({
  startOfDay: vi.fn(() => '2026-04-17T00:00:00'),
  endOfDay: vi.fn(() => '2026-04-17T23:59:59'),
  startOfWeek: vi.fn(() => '2026-04-14T00:00:00'),
  endOfWeek: vi.fn(() => '2026-04-20T23:59:59'),
  formatDateTime: vi.fn((value: string) => value),
}));

vi.mock('../../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
}));

vi.mock('../../../src/utils/i18n', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerSecretaryCommands } from '../../../src/handlers/commands/secretary';

type CommandHandler = (ctx: any) => Promise<void> | void;

function createBotHarness() {
  const handlers = new Map<string, CommandHandler>();
  const bot = {
    command(name: string, handler: CommandHandler) {
      handlers.set(name, handler);
      return this;
    },
  };
  registerSecretaryCommands(bot as any, {});
  return handlers;
}

function makeCtx(match = '', telegramId = 42) {
  return {
    from: { id: telegramId },
    match,
    reply: vi.fn(async () => undefined),
    replyWithChatAction: vi.fn(async () => undefined),
  } as any;
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('secretary command tenant routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetTelegramTaskScope.mockReturnValue({
      userId: 1042,
      providerType: 'nexus',
      provider: {
        getLists: vi.fn(async () => ({
          success: true,
          data: [{ id: 'list-1', displayName: 'Tasks' }],
        })),
        findListByName: vi.fn(async (name: string) => ({
          id: 'list-1',
          displayName: name,
        })),
        getTasks: vi.fn(async () => ({
          success: true,
          data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
        })),
        createTask: vi.fn(async () => ({
          success: true,
          data: { id: 'task-2', title: 'Buy milk', listId: 'list-1', listName: 'Tasks' },
        })),
        getAllPendingTasks: vi.fn(async () => ({
          success: true,
          data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
        })),
        getTasksDueInRange: vi.fn(async () => ({
          success: true,
          data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks', dueDateTime: '2026-04-17T10:00:00' }],
        })),
      },
    });
  });

  it('routes list and task reads through the scoped provider', async () => {
    const handlers = createBotHarness();
    const listCtx = makeCtx();
    const tasksCtx = makeCtx('Tasks');
    const provider = {
      getLists: vi.fn(async () => ({
        success: true,
        data: [{ id: 'list-1', displayName: 'Tasks' }],
      })),
      findListByName: vi.fn(async (name: string) => ({
        id: 'list-1',
        displayName: name,
      })),
      getTasks: vi.fn(async () => ({
        success: true,
        data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
      })),
    };
    mockGetTelegramTaskScope.mockReturnValue({
      userId: 1042,
      providerType: 'nexus',
      provider,
    });

    await handlers.get('lists')!(listCtx);
    await handlers.get('tasks')!(tasksCtx);
    await flushAsyncWork();

    expect(provider.getLists).toHaveBeenCalled();
    expect(provider.findListByName).toHaveBeenCalledWith('Tasks');
    expect(provider.getTasks).toHaveBeenCalledWith('list-1', 'Tasks', { status: 'notStarted' });
    expect(listCtx.reply).toHaveBeenCalledWith(expect.stringContaining('Lists'), expect.any(Object));
    expect(tasksCtx.reply).toHaveBeenCalledWith(expect.stringContaining('Tasks'), expect.any(Object));
  });

  it('passes the active user language into deterministic task formatters', async () => {
    mockGetUserLanguage.mockReturnValue('pt-BR');
    const handlers = createBotHarness();
    const listCtx = makeCtx();
    const tasksCtx = makeCtx('Tasks');

    await handlers.get('lists')!(listCtx);
    await handlers.get('tasks')!(tasksCtx);
    await flushAsyncWork();

    expect(mockFormatMsTodoLists).toHaveBeenCalledWith(
      [{ id: 'list-1', displayName: 'Tasks' }],
      'pt-BR',
    );
    expect(mockFormatMsTodoTasks).toHaveBeenCalledWith(
      [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
      'Tasks',
      'pt-BR',
    );
  });

  it('routes task creation and due reads through the scoped provider', async () => {
    const handlers = createBotHarness();
    const newTaskCtx = makeCtx('Tasks | Buy milk');
    const dueTodayCtx = makeCtx();
    const provider = {
      findListByName: vi.fn(async (name: string) => ({
        id: 'list-1',
        displayName: name,
      })),
      createTask: vi.fn(async () => ({
        success: true,
        data: { id: 'task-2', title: 'Buy milk', listId: 'list-1', listName: 'Tasks' },
      })),
      getTasksDueInRange: vi.fn(async () => ({
        success: true,
        data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks', dueDateTime: '2026-04-17T10:00:00' }],
      })),
    };
    mockGetTelegramTaskScope.mockReturnValue({
      userId: 1042,
      providerType: 'nexus',
      provider,
    });

    await handlers.get('newtask')!(newTaskCtx);
    await handlers.get('duetoday')!(dueTodayCtx);
    await flushAsyncWork();

    expect(provider.findListByName).toHaveBeenCalledWith('Tasks');
    expect(provider.createTask).toHaveBeenCalledWith('list-1', 'Tasks', { title: 'Buy milk' });
    expect(provider.getTasksDueInRange).toHaveBeenCalledWith('2026-04-17T00:00:00', '2026-04-17T23:59:59');
  });

  it('routes aggregate task reads through the scoped provider', async () => {
    const handlers = createBotHarness();
    const allTasksCtx = makeCtx();
    const todosCtx = makeCtx();
    const allTasksProvider = {
      getAllPendingTasks: vi.fn(async () => ({
        success: true,
        data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
      })),
    };
    const todosProvider = {
      getDefaultList: vi.fn(async () => ({ id: 'list-1', displayName: 'Tasks' })),
      getTasks: vi.fn(async () => ({
        success: true,
        data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
      })),
    };

    mockGetTelegramTaskScope.mockReturnValueOnce({
      userId: 1042,
      providerType: 'nexus',
      provider: allTasksProvider,
    }).mockReturnValueOnce({
      userId: 1042,
      providerType: 'nexus',
      provider: todosProvider,
    });

    await handlers.get('alltasks')!(allTasksCtx);
    await handlers.get('todos')!(todosCtx);
    await flushAsyncWork();

    expect(allTasksProvider.getAllPendingTasks).toHaveBeenCalled();
    expect(todosProvider.getDefaultList).toHaveBeenCalled();
    expect(todosProvider.getTasks).toHaveBeenCalledWith('list-1', 'Tasks', { status: 'notStarted' });
  });

  it('fails closed when no scoped provider exists', async () => {
    const handlers = createBotHarness();
    const ctx = makeCtx();
    mockGetTelegramTaskScope.mockReturnValue(null);

    await handlers.get('lists')!(ctx);
    await flushAsyncWork();

    expect(mockReplyTaskProviderUnavailable).toHaveBeenCalledWith(ctx);
    expect(ctx.replyWithChatAction).not.toHaveBeenCalled();
  });
});
