import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: {
    telegram: { botToken: 'token' },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/utils/callback-store', () => ({
  storeCallback: vi.fn(() => 'cb-ref'),
}));

vi.mock('../../src/router', () => ({
  keywordMatch: vi.fn(() => null),
}));

vi.mock('../../src/handlers/shared-state', () => ({
  lastActiveDomain: new Map(),
  pendingCalendarRef: new Map(),
  isHtmlParseError: vi.fn(() => false),
}));

vi.mock('../../src/services/anthropic', () => ({
  classifyAndExtractImage: vi.fn(),
}));

vi.mock('../../src/services/invoice-filer', () => ({
  fileInvoice: vi.fn(),
  isInvoiceFilingConfigured: vi.fn(() => false),
}));

vi.mock('../../src/services/finance-tracker', () => ({
  addTransaction: vi.fn(),
  parseReceiptAmount: vi.fn(),
}));

vi.mock('../../src/services/invoice-queue', () => ({
  enqueueInvoice: vi.fn(),
  getPendingCount: vi.fn(() => 0),
}));

vi.mock('../../src/state/invoice-filings', () => ({
  recordFiling: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: vi.fn(),
  createEvent: vi.fn(),
  isAnyCalendarConfigured: vi.fn(() => false),
}));

vi.mock('../../src/services/outlook-calendar', () => ({
  getCategoryNameForColor: vi.fn(async () => 'Personal'),
}));

const mockResolveCanonicalUserId = vi.fn();
vi.mock('../../src/services/user-service', () => ({
  resolveCanonicalUserId: (...args: unknown[]) => mockResolveCanonicalUserId(...args),
}));

const mockGetTaskProviderForUser = vi.fn();
vi.mock('../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/utils/telegram-formatter', () => ({
  splitMessage: vi.fn((value: string) => [value]),
  escapeHtml: vi.fn((value: string) => value),
}));

vi.mock('../../src/utils/date-parser', () => ({
  formatTime: vi.fn(() => '09:00'),
}));

import { handleTaskExtraction } from '../../src/handlers/photo';

function makeCtx(telegramId = 42) {
  return {
    from: { id: telegramId },
    reply: vi.fn(async () => undefined),
  } as any;
}

describe('photo task extraction tenant routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCanonicalUserId.mockReturnValue(1042);
    mockGetTaskProviderForUser.mockReturnValue({
      findListByName: vi.fn(async (name: string) => ({ id: 'list-1', displayName: name })),
      getDefaultList: vi.fn(async () => ({ id: 'list-1', displayName: 'Tasks' })),
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Tasks' }] })),
      createTask: vi.fn(async (_listId: string, _listName: string, payload: Record<string, unknown>) => ({
        success: true,
        data: { id: 'task-1', title: payload.title },
      })),
      addChecklistItem: vi.fn(async () => ({ success: true, data: {} })),
    });
  });

  it('routes extracted tasks through the canonical user provider', async () => {
    const ctx = makeCtx();

    await handleTaskExtraction(ctx, {
      type: 'task',
      title: 'Buy groceries',
      listHint: 'Errands',
      subtasks: ['Buy milk', 'Buy eggs'],
    }, '');

    const provider = mockGetTaskProviderForUser.mock.results[0]?.value;
    expect(mockResolveCanonicalUserId).toHaveBeenCalledWith(42);
    expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(1042);
    expect(provider.findListByName).toHaveBeenCalledWith('Errands');
    expect(provider.createTask).toHaveBeenCalledWith('list-1', 'Errands', { title: 'Buy groceries' });
    expect(provider.addChecklistItem).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Tarefa criada da imagem'), { parse_mode: 'HTML' });
  });

  it('falls back to available lists when no hint or default list exists', async () => {
    const ctx = makeCtx();
    mockGetTaskProviderForUser.mockReturnValueOnce({
      findListByName: vi.fn(async () => null),
      getDefaultList: vi.fn(async () => null),
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-9', displayName: 'Inbox' }] })),
      createTask: vi.fn(async () => ({ success: true, data: { id: 'task-9', title: 'Document' } })),
      addChecklistItem: vi.fn(async () => ({ success: false, error: 'unsupported', data: null })),
    });

    await handleTaskExtraction(ctx, {
      type: 'task',
      title: 'Document',
      subtasks: ['Step one'],
    }, '');

    const provider = mockGetTaskProviderForUser.mock.results[0]?.value;
    expect(provider.getLists).toHaveBeenCalled();
    expect(provider.createTask).toHaveBeenCalledWith('list-9', 'Inbox', { title: 'Document' });
  });

  it('fails closed when no canonical tenant exists', async () => {
    const ctx = makeCtx(99);
    mockResolveCanonicalUserId.mockReturnValue(null);

    await handleTaskExtraction(ctx, {
      type: 'task',
      title: 'Scoped task',
      subtasks: [],
    }, '');

    expect(mockGetTaskProviderForUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('📷 Foto recebida, mas o provedor de tarefas não está disponível para este utilizador.');
  });
});
