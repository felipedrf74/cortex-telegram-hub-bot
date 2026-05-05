import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCallback = vi.fn();
const mockFormatMsTodoTasks = vi.fn((_tasks: unknown[], _listName: string, _language?: string) => '<b>Tasks</b>\nScoped task');
const mockGetUserLanguage = vi.fn(() => 'en-US');
vi.mock('../../src/utils/callback-store', () => ({
  storeCallback: vi.fn(() => 'cb-ref'),
  getCallback: (...args: unknown[]) => mockGetCallback(...args),
}));

const mockGetTelegramTaskScope = vi.fn();
const mockBuildTaskListKeyboard = vi.fn(() => ({ inline_keyboard: [] }));
vi.mock('../../src/handlers/commands/secretary-helpers', () => ({
  buildTaskListKeyboard: (...args: unknown[]) => mockBuildTaskListKeyboard(...args),
  getTelegramTaskScope: (...args: unknown[]) => mockGetTelegramTaskScope(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/utils/telegram-formatter', () => ({
  escapeHtml: vi.fn((value: string) => value),
  formatMsTodoTasks: (...args: unknown[]) => mockFormatMsTodoTasks(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: vi.fn(),
}));

vi.mock('../../src/services/anthropic', () => ({
  classifyAndExtractImage: vi.fn(),
}));

vi.mock('../../src/handlers/photo', () => ({
  handleTaskExtraction: vi.fn(),
}));

vi.mock('../../src/handlers/telegram-file', () => ({
  downloadTelegramFile: vi.fn(),
}));

import { registerCallbackQueries } from '../../src/handlers/callback-query';

type CallbackHandler = (ctx: any) => Promise<void> | void;

function createBotHarness() {
  const handlers: Array<{ pattern: RegExp; handler: CallbackHandler }> = [];
  const bot = {
    callbackQuery(pattern: RegExp, handler: CallbackHandler) {
      handlers.push({ pattern, handler });
      return this;
    },
  };
  registerCallbackQueries(bot as any);
  return handlers;
}

function getTodoHandler() {
  const handlers = createBotHarness();
  const match = handlers.find(({ pattern }) => pattern.test('td:ls:any-ref'));
  if (!match) throw new Error('todo callback handler not registered');
  return match.handler;
}

function makeCtx(data = 'td:ls:ref', telegramId = 42) {
  return {
    from: { id: telegramId },
    callbackQuery: { data },
    answerCallbackQuery: vi.fn(async () => undefined),
    editMessageText: vi.fn(async () => undefined),
  } as any;
}

describe('callback query tenant routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetCallback.mockReturnValue({
      listId: 'list-1',
      listName: 'Tasks',
      taskId: 'task-1',
      title: 'Scoped task',
      type: 'task',
      level: 'high',
    });
    mockGetTelegramTaskScope.mockReturnValue({
      userId: 1042,
      providerType: 'nexus',
      provider: {
        getTasks: vi.fn(async () => ({
          success: true,
          data: [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
        })),
        completeTask: vi.fn(async () => ({ success: true, data: { id: 'task-1' } })),
        deleteTask: vi.fn(async () => ({ success: true, data: undefined })),
        deleteList: vi.fn(async () => ({ success: true, data: undefined })),
        updateTask: vi.fn(async () => ({ success: true, data: { id: 'task-1' } })),
      },
    });
  });

  it('routes list callbacks through the scoped provider', async () => {
    const handler = getTodoHandler();
    const ctx = makeCtx('td:ls:ref');

    await handler(ctx);

    const scope = mockGetTelegramTaskScope.mock.results[0]?.value;
    expect(scope.provider.getTasks).toHaveBeenCalledWith('list-1', 'Tasks', { status: 'notStarted' });
    expect(ctx.editMessageText).toHaveBeenLastCalledWith(expect.stringContaining('Scoped task'), expect.any(Object));
  });

  it('passes the active user language into list callback formatting', async () => {
    mockGetUserLanguage.mockReturnValue('pt-PT');
    const handler = getTodoHandler();

    await handler(makeCtx('td:ls:ref'));

    expect(mockFormatMsTodoTasks).toHaveBeenCalledWith(
      [{ id: 'task-1', title: 'Scoped task', listId: 'list-1', listName: 'Tasks' }],
      'Tasks',
      'pt-PT',
    );
  });

  it('routes complete, delete, and priority callbacks through the scoped provider', async () => {
    const handler = getTodoHandler();

    await handler(makeCtx('td:tc:ref'));
    await handler(makeCtx('td:dy:ref'));
    await handler(makeCtx('td:ep:ref'));

    const completeScope = mockGetTelegramTaskScope.mock.results[0]?.value;
    const deleteScope = mockGetTelegramTaskScope.mock.results[1]?.value;
    const updateScope = mockGetTelegramTaskScope.mock.results[2]?.value;
    expect(completeScope.provider.completeTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(deleteScope.provider.deleteTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(updateScope.provider.updateTask).toHaveBeenCalledWith('list-1', 'task-1', { importance: 'high' });
  });

  it('routes list deletion through the scoped provider', async () => {
    const handler = getTodoHandler();
    mockGetCallback.mockReturnValueOnce({
      listId: 'list-1',
      listName: 'Tasks',
      type: 'list',
    });

    await handler(makeCtx('td:dy:ref'));

    const scope = mockGetTelegramTaskScope.mock.results[0]?.value;
    expect(scope.provider.deleteList).toHaveBeenCalledWith('list-1');
  });

  it('fails closed when no scoped provider exists', async () => {
    const handler = getTodoHandler();
    const ctx = makeCtx('td:tc:ref');
    mockGetTelegramTaskScope.mockReturnValue(null);

    await handler(ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith('⚠️ Task provider unavailable for this user.');
  });
});
