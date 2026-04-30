/**
 * Tool Executor Tests
 *
 * Tests the executeToolCall dispatcher for all 20+ tools across 6 categories:
 * Microsoft To Do, Calendar (unified), Outlook Email, Reminders, Notes, Shared Memory.
 *
 * All external service modules are mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTaskProviderForUser = vi.fn();
const mockResolveCanonicalUserId = vi.fn();
const mockInvalidateCalendarCaches = vi.fn();
const mockInvalidateFinanceDerivedCaches = vi.fn();
const mockInvalidateCookingDerivedCaches = vi.fn();

// ─── Mock all external services ──────────────────────────────────────

vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(),
  getLists: vi.fn(),
  createList: vi.fn(),
  deleteList: vi.fn(),
  getTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  deleteTask: vi.fn(),
  searchTasks: vi.fn(),
  getTasksDueInRange: vi.fn(),
  moveTask: vi.fn(),
  getChecklistItems: vi.fn(),
  addChecklistItem: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  isAnyCalendarConfigured: vi.fn(),
  hasConnectedCalendarForUser: vi.fn(),
  getEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));

vi.mock('../../src/services/calendar-cache-invalidator', () => ({
  invalidateCalendarCaches: (...args: unknown[]) => mockInvalidateCalendarCaches(...args),
}));

vi.mock('../../src/services/finance-cache-invalidator', () => ({
  invalidateFinanceDerivedCaches: (...args: unknown[]) => mockInvalidateFinanceDerivedCaches(...args),
}));

vi.mock('../../src/services/cooking-cache-invalidator', () => ({
  invalidateCookingDerivedCaches: (...args: unknown[]) => mockInvalidateCookingDerivedCaches(...args),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn(),
  isOutlookMailConfiguredForUser: vi.fn(),
  searchEmails: vi.fn(),
  searchEmailsForUser: vi.fn(),
  readEmail: vi.fn(),
  readEmailForUser: vi.fn(),
  sendEmail: vi.fn(),
  sendEmailForUser: vi.fn(),
  replyToEmail: vi.fn(),
  replyToEmailForUser: vi.fn(),
  getUnreadEmails: vi.fn(),
  getUnreadEmailsForUser: vi.fn(),
}));

vi.mock('../../src/state/reminders', () => ({
  setReminder: vi.fn(),
}));

vi.mock('../../src/state/notes', () => ({
  saveNote: vi.fn(),
  searchNotes: vi.fn(),
}));

vi.mock('../../src/state/shared-memory', () => ({
  setSharedMemory: vi.fn(),
  removeSharedMemory: vi.fn(),
}));

vi.mock('../../src/services/finance-tracker', () => ({
  addTransaction: vi.fn(),
  getTransactions: vi.fn(),
  deleteTransaction: vi.fn(),
  getMonthlySummary: vi.fn(),
  calculateAndStoreTax: vi.fn(),
  calculateMonthlyTax: vi.fn(),
  getTaxEvents: vi.fn(),
  markTaxPaid: vi.fn(),
  getAnnualTaxSummary: vi.fn(),
  getBudgetStatus: vi.fn(),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  resolveCanonicalUserId: (...args: unknown[]) => mockResolveCanonicalUserId(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// ─── Imports (after mocks are declared) ─────────────────────────────

import { executeToolCall as executeToolCallWithoutContext } from '../../src/services/tool-executor';
import * as msTodo from '../../src/services/microsoft-todo';
import * as unifiedCal from '../../src/services/unified-calendar';
import * as outlookMail from '../../src/services/outlook-mail';
import * as cookingChef from '../../src/services/cooking-chef';
import { setReminder } from '../../src/state/reminders';
import { saveNote, searchNotes } from '../../src/state/notes';
import { setSharedMemory, removeSharedMemory } from '../../src/state/shared-memory';
import * as financeTracker from '../../src/services/finance-tracker';
import {
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
} from '../../src/services/chat-tool-authorization';

// ─── Helpers ─────────────────────────────────────────────────────────

const mockTodo = vi.mocked(msTodo);
const mockCal = vi.mocked(unifiedCal);
const mockMail = vi.mocked(outlookMail);
const mockFinance = vi.mocked(financeTracker);
const AUTH_USER_ID = 42;
const executeToolCall = (
  tool: string,
  input: Record<string, any> = {},
  userId = AUTH_USER_ID,
  tenantId = userId,
) => {
  if (getCurrentChatToolAuthorizationContext()) {
    return executeToolCallWithoutContext(tool, input, userId, tenantId);
  }
  return runWithChatToolAuthorization({
    userId,
    tenantId,
    confirmedDestructiveAction: true,
    confirmationSource: 'explicit_current_turn',
  }, () => executeToolCallWithoutContext(tool, input, userId, tenantId));
};
const execAsUser = (tool: string, input: Record<string, any> = {}) => executeToolCall(tool, input, AUTH_USER_ID);
const execAsTenantUser = (tool: string, input: Record<string, any> = {}, tenantId = 1001) =>
  executeToolCall(tool, input, AUTH_USER_ID, tenantId);

beforeEach(() => {
  mockResolveCanonicalUserId.mockReset();
  mockResolveCanonicalUserId.mockImplementation((userRef: unknown) =>
    typeof userRef === 'number' && userRef > 0 ? userRef : null
  );
  mockGetTaskProviderForUser.mockReset();
  mockGetTaskProviderForUser.mockReturnValue(mockTodo);
  mockInvalidateCalendarCaches.mockReset();
  mockInvalidateFinanceDerivedCaches.mockReset();
  mockInvalidateCookingDerivedCaches.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// Microsoft To Do tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Microsoft To Do', () => {
  it('returns a tenant-scope error when task tools run without a user context', async () => {
    const result = await executeToolCallWithoutContext('ms_todo_get_lists', {});
    expect(result).toMatchObject({
      success: false,
      code: 'AUTH_REQUIRED',
      error: 'ms_todo_get_lists requires authenticated chat authorization context',
    });
  });

  describe('when configured', () => {
    beforeEach(() => {
      mockTodo.isOutlookTodoConfigured.mockReturnValue(true);
      mockGetTaskProviderForUser.mockReset();
      mockGetTaskProviderForUser.mockReturnValue(mockTodo);
    });

    it('ms_todo_get_lists — delegates to getLists()', async () => {
      const lists = [{ id: 'list1', displayName: 'Work', isOwner: true, isShared: false }];
      mockTodo.getLists.mockResolvedValue({ success: true, data: lists });

      const result = await execAsUser('ms_todo_get_lists');
      expect(result).toEqual({ success: true, data: lists });
      expect(mockTodo.getLists).toHaveBeenCalledOnce();
      expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(AUTH_USER_ID);
    });

    it('ms_todo_create_list — delegates with list name', async () => {
      mockTodo.createList.mockResolvedValue({ success: true, data: { id: 'list2', displayName: 'Personal' } as any });

      await execAsUser('ms_todo_create_list', { name: 'Personal' });
      expect(mockTodo.createList).toHaveBeenCalledWith('Personal');
    });

    it('ms_todo_delete_list — delegates with list_id', async () => {
      mockTodo.deleteList.mockResolvedValue({ success: true, data: undefined });

      await execAsUser('ms_todo_delete_list', { list_id: 'list1' });
      expect(mockTodo.deleteList).toHaveBeenCalledWith('list1');
    });

    it('ms_todo_get_tasks — passes list_id, list_name and status filter', async () => {
      mockTodo.getTasks.mockResolvedValue({ success: true, data: [] });

      await execAsUser('ms_todo_get_tasks', {
        list_id: 'list1',
        list_name: 'Work',
        status: 'notStarted',
      });
      expect(mockTodo.getTasks).toHaveBeenCalledWith('list1', 'Work', { status: 'notStarted' });
    });

    describe('ms_todo_create_task', () => {
      it('returns slim success response on success', async () => {
        mockTodo.createTask.mockResolvedValue({
          success: true,
          data: { id: 'task123', title: 'Deploy app' } as any,
        });

        const result = await execAsUser('ms_todo_create_task', {
          list_id: 'list1',
          list_name: 'Work',
          title: 'Deploy app',
        });
        expect(result).toEqual({ success: true, id: 'task123', title: 'Deploy app' });
      });

      it('returns error response on failure', async () => {
        mockTodo.createTask.mockResolvedValue({
          success: false,
          data: null,
          error: 'List not found',
        });

        const result = await execAsUser('ms_todo_create_task', {
          list_id: 'bad-id',
          list_name: 'Missing',
          title: 'Task',
        });
        expect(result).toEqual({ success: false, error: 'List not found' });
      });

      it('passes all optional fields to createTask', async () => {
        mockTodo.createTask.mockResolvedValue({ success: true, data: { id: 't1', title: 'Review' } as any });

        await execAsUser('ms_todo_create_task', {
          list_id: 'list1',
          list_name: 'Work',
          title: 'Review',
          body: 'Detailed notes',
          importance: 'high',
          due_date_time: '2026-04-01T09:00:00',
          reminder_date_time: '2026-03-31T08:00:00',
        });
        expect(mockTodo.createTask).toHaveBeenCalledWith('list1', 'Work', {
          title: 'Review',
          body: 'Detailed notes',
          importance: 'high',
          dueDateTime: '2026-04-01T09:00:00',
          reminderDateTime: '2026-03-31T08:00:00',
        });
      });
    });

    describe('per-user native task routing', () => {
      it('falls back to the user default list when the model sends an invalid list_id', async () => {
        mockResolveCanonicalUserId.mockImplementation((userRef: unknown) => {
          if (userRef === 99) return 1001;
          return typeof userRef === 'number' && userRef > 0 ? userRef : null;
        });
        const mockProvider = {
          createTask: vi.fn(async (_listId: string, listName: string, payload: Record<string, unknown>) => ({
            success: true,
            data: { id: 'task-native-1', title: payload.title, listName } as any,
          })),
        };
        mockGetTaskProviderForUser.mockReturnValue(mockProvider);

        const result = await executeToolCall('ms_todo_create_task', {
          list_id: '12345',
          list_name: 'Inbox',
          title: 'Review deck',
        }, 99);

        expect(result).toEqual({ success: true, id: 'task-native-1', title: 'Review deck' });
        expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(1001);
        expect(mockProvider.createTask).toHaveBeenCalledWith('12345', 'Inbox', expect.objectContaining({
          title: 'Review deck',
        }));
      });

      it('prefers the real capture list when the model sends a generic inbox label without a list id', async () => {
        const mockProvider = {
          getLists: vi.fn(async () => ({
            success: true,
            data: [
              { id: 'tasks-1', displayName: 'Tasks', wellknownListName: 'defaultList' },
              { id: 'ec-1', displayName: 'European Commision' },
            ],
          })),
          findListByName: vi.fn(async (name: string) => {
            if (name === 'Inbox') return null;
            if (name === 'Tasks') return { id: 'tasks-1', displayName: 'Tasks' };
            return null;
          }),
          getDefaultList: vi.fn(async () => ({ id: 'ec-1', displayName: 'European Commision' })),
          createTask: vi.fn(async (_listId: string, listName: string, payload: Record<string, unknown>) => ({
            success: true,
            data: { id: 'task-native-2', title: payload.title, listName } as any,
          })),
        };
        mockGetTaskProviderForUser.mockReturnValue(mockProvider);

        const result = await executeToolCall('ms_todo_create_task', {
          list_name: 'Inbox',
          title: 'pay via verde',
        }, 99);

        expect(result).toEqual({ success: true, id: 'task-native-2', title: 'pay via verde' });
        expect(mockProvider.createTask).toHaveBeenCalledWith(
          'tasks-1',
          'Tasks',
          expect.objectContaining({ title: 'pay via verde' }),
        );
      });

      it('uses the active task provider for due-task lookups when a user context exists', async () => {
        const mockProvider = {
          getTasksDueInRange: vi.fn(async (start: string, end: string) => ({
            success: true,
            data: [{ id: 'task-1', title: `due ${start} ${end}` }],
          })),
        };
        mockGetTaskProviderForUser.mockReturnValue(mockProvider);

        const result = await executeToolCall('ms_todo_get_due_tasks', {
          start_date: '2026-04-15T00:00:00.000Z',
          end_date: '2026-04-15T23:59:59.000Z',
        }, 99);

        expect(mockProvider.getTasksDueInRange).toHaveBeenCalledWith(
          '2026-04-15T00:00:00.000Z',
          '2026-04-15T23:59:59.000Z',
        );
        expect(mockTodo.getTasksDueInRange).not.toHaveBeenCalled();
        expect(result).toEqual({
          success: true,
          data: [{ id: 'task-1', title: 'due 2026-04-15T00:00:00.000Z 2026-04-15T23:59:59.000Z' }],
        });
      });

      it('uses the active task provider for task search when a user context exists', async () => {
        const mockProvider = {
          searchTasks: vi.fn(async (query: string) => ({
            success: true,
            data: [{ id: 'task-2', title: query }],
          })),
        };
        mockGetTaskProviderForUser.mockReturnValue(mockProvider);

        const result = await executeToolCall('ms_todo_search_tasks', {
          query: 'review training deck',
        }, 99);

        expect(mockProvider.searchTasks).toHaveBeenCalledWith('review training deck');
        expect(mockTodo.searchTasks).not.toHaveBeenCalled();
        expect(result).toEqual({
          success: true,
          data: [{ id: 'task-2', title: 'review training deck' }],
        });
      });
    });

    describe('ms_todo_update_task', () => {
      it('returns error when task_id is missing', async () => {
        const result = await execAsUser('ms_todo_update_task', { list_id: 'list1' });
        expect(result).toEqual({
          success: false,
          error: 'Missing task_id — cannot update a task without its ID.',
        });
        expect(mockTodo.updateTask).not.toHaveBeenCalled();
      });

      it('returns slim success response on success', async () => {
        mockTodo.updateTask.mockResolvedValue({ success: true, data: { title: 'Updated' } as any });

        const result = await execAsUser('ms_todo_update_task', {
          list_id: 'list1',
          task_id: 'task1',
          title: 'Updated',
          list_name: 'Work',
        });
        expect(result).toEqual({ success: true, title: 'Updated' });
      });

      it('uses fallback title "updated" when data has no title', async () => {
        mockTodo.updateTask.mockResolvedValue({ success: true, data: {} as any });

        const result = await execAsUser('ms_todo_update_task', {
          list_id: 'list1',
          task_id: 'task1',
        });
        expect(result).toEqual({ success: true, title: 'updated' });
      });

      it('returns error response on failure', async () => {
        mockTodo.updateTask.mockResolvedValue({ success: false, data: null, error: 'Not found' });

        const result = await execAsUser('ms_todo_update_task', {
          list_id: 'list1',
          task_id: 'task1',
        });
        expect(result).toEqual({ success: false, error: 'Not found' });
      });
    });

    describe('ms_todo_complete_task', () => {
      it('returns error when task_id is missing', async () => {
        const result = await execAsUser('ms_todo_complete_task', { list_id: 'list1' });
        expect(result).toEqual({
          success: false,
          error: 'Missing task_id — cannot complete a task without its ID.',
        });
      });

      it('returns slim success with title on success', async () => {
        mockTodo.completeTask.mockResolvedValue({ success: true, data: { title: 'Buy groceries' } as any });

        const result = await execAsUser('ms_todo_complete_task', {
          list_id: 'list1',
          task_id: 'task1',
          list_name: 'Personal',
        });
        expect(result).toEqual({ success: true, title: 'Buy groceries' });
        expect(mockTodo.completeTask).toHaveBeenCalledWith('list1', 'task1', 'Personal');
      });

      it('uses fallback title "done" when data has no title', async () => {
        mockTodo.completeTask.mockResolvedValue({ success: true, data: {} as any });

        const result = await execAsUser('ms_todo_complete_task', {
          list_id: 'list1',
          task_id: 'task1',
        });
        expect(result).toEqual({ success: true, title: 'done' });
      });
    });

    describe('ms_todo_uncomplete_task', () => {
      it('returns error when task_id is missing', async () => {
        const result = await execAsUser('ms_todo_uncomplete_task', { list_id: 'list1' });
        expect(result).toEqual({
          success: false,
          error: 'Missing task_id — cannot uncomplete a task without its ID.',
        });
      });

      it('returns slim success with fallback title "reopened"', async () => {
        mockTodo.uncompleteTask.mockResolvedValue({ success: true, data: {} as any });

        const result = await execAsUser('ms_todo_uncomplete_task', {
          list_id: 'list1',
          task_id: 'task1',
        });
        expect(result).toEqual({ success: true, title: 'reopened' });
      });
    });

    describe('ms_todo_delete_task', () => {
      it('returns error when task_id is missing', async () => {
        const result = await execAsUser('ms_todo_delete_task', { list_id: 'list1' });
        expect(result).toEqual({
          success: false,
          error: 'Missing task_id — cannot delete a task without its ID.',
        });
      });

      it('returns { success: true } on success', async () => {
        mockTodo.deleteTask.mockResolvedValue({ success: true, data: undefined });

        const result = await execAsUser('ms_todo_delete_task', {
          list_id: 'list1',
          task_id: 'task1',
        });
        expect(result).toEqual({ success: true });
        expect(mockTodo.deleteTask).toHaveBeenCalledWith('list1', 'task1');
      });

      it('returns { success: false, error } on failure', async () => {
        mockTodo.deleteTask.mockResolvedValue({ success: false, data: undefined, error: 'Not found' });

        const result = await execAsUser('ms_todo_delete_task', {
          list_id: 'list1',
          task_id: 'task1',
        });
        expect(result).toEqual({ success: false, error: 'Not found' });
      });
    });

    it('ms_todo_search_tasks — delegates with query', async () => {
      const tasks = [{ id: 't1', title: 'Deploy' }];
      mockTodo.searchTasks.mockResolvedValue({ success: true, data: tasks as any });

      const result = await execAsUser('ms_todo_search_tasks', { query: 'Deploy' });
      expect(result).toEqual({ success: true, data: tasks });
      expect(mockTodo.searchTasks).toHaveBeenCalledWith('Deploy');
    });

    it('ms_todo_get_due_tasks — delegates with date range', async () => {
      mockTodo.getTasksDueInRange.mockResolvedValue({ success: true, data: [] });

      await execAsUser('ms_todo_get_due_tasks', {
        start_date: '2026-03-30',
        end_date: '2026-04-06',
      });
      expect(mockTodo.getTasksDueInRange).toHaveBeenCalledWith('2026-03-30', '2026-04-06');
    });

    it('ms_todo_move_task — delegates all four IDs', async () => {
      mockTodo.moveTask.mockResolvedValue({ success: true, data: {} as any });

      await execAsUser('ms_todo_move_task', {
        list_id: 'src-list',
        task_id: 'task1',
        target_list_id: 'tgt-list',
        target_list_name: 'Archive',
      });
      expect(mockTodo.moveTask).toHaveBeenCalledWith('src-list', 'task1', 'tgt-list', 'Archive');
    });

    it('ms_todo_get_checklist — delegates list_id and task_id', async () => {
      mockTodo.getChecklistItems.mockResolvedValue({ success: true, data: [] });

      await execAsUser('ms_todo_get_checklist', { list_id: 'list1', task_id: 'task1' });
      expect(mockTodo.getChecklistItems).toHaveBeenCalledWith('list1', 'task1');
    });

    it('ms_todo_add_checklist_item — delegates list_id, task_id, title', async () => {
      mockTodo.addChecklistItem.mockResolvedValue({ success: true, data: {} as any });

      await execAsUser('ms_todo_add_checklist_item', {
        list_id: 'list1',
        task_id: 'task1',
        title: 'Step one',
      });
      expect(mockTodo.addChecklistItem).toHaveBeenCalledWith('list1', 'task1', 'Step one');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Calendar tools (unified: Google + Outlook)
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Calendar', () => {
  describe('when no calendar is configured', () => {
    beforeEach(() => {
      mockCal.isAnyCalendarConfigured.mockReturnValue(false);
    });

    it.each(['get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event'])(
      '%s returns configuration error',
      async (tool) => {
        const result = await executeToolCall(tool, {});
        expect(result).toHaveProperty('error');
        expect(result.error).toContain('No calendar is configured');
      },
    );
  });

  describe('when configured', () => {
    beforeEach(() => {
      mockCal.isAnyCalendarConfigured.mockReturnValue(true);
      mockCal.hasConnectedCalendarForUser.mockReturnValue(true);
    });

    it('get_calendar_events — delegates with date range', async () => {
      const events = [{ id: 'evt1', title: 'Standup' }];
      mockCal.getEvents.mockResolvedValue(events as any);

      const result = await executeToolCall('get_calendar_events', {
        start_date: '2026-03-30',
        end_date: '2026-04-06',
      });
      expect(result).toEqual(events);
      expect(mockCal.getEvents).toHaveBeenCalledWith('2026-03-30', '2026-04-06', AUTH_USER_ID);
    });

    it('get_calendar_events — preserves tenant scope when user context exists', async () => {
      const events = [{ id: 'evt1', title: 'Scoped standup' }];
      mockCal.getEvents.mockResolvedValue(events as any);

      const result = await execAsUser('get_calendar_events', {
        start_date: '2026-03-30',
        end_date: '2026-04-06',
      });

      expect(result).toEqual(events);
      expect(mockCal.hasConnectedCalendarForUser).toHaveBeenCalledWith(AUTH_USER_ID);
      expect(mockCal.getEvents).toHaveBeenCalledWith('2026-03-30', '2026-04-06', AUTH_USER_ID);
    });

    it('create_calendar_event — delegates with event data and source', async () => {
      const created = { id: 'evt2', title: 'Swim session' };
      mockCal.createEvent.mockResolvedValue(created as any);

      const result = await executeToolCall('create_calendar_event', {
        title: 'Swim session',
        start: '2026-04-01T06:00:00',
        end: '2026-04-01T07:00:00',
        description: '2km open water',
        categories: ['sport'],
        calendar_source: 'google',
        recurrence: {
          pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
          range: { type: 'noEnd', startDate: '2026-04-01' },
        },
      });
      expect(result).toEqual(created);
      expect(mockCal.createEvent).toHaveBeenCalledWith(
        {
          title: 'Swim session',
          start: '2026-04-01T06:00:00',
          end: '2026-04-01T07:00:00',
          description: '2km open water',
          categories: ['sport'],
          attendees: undefined,
          location: undefined,
          recurrence: {
            pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
            range: { type: 'noEnd', startDate: '2026-04-01' },
          },
        },
        'google',
        AUTH_USER_ID,
      );
      expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(AUTH_USER_ID);
    });

    describe('update_calendar_event', () => {
      it('uses explicit calendar_source when provided', async () => {
        mockCal.updateEvent.mockResolvedValue({ id: 'evt1' } as any);

        const result = await executeToolCall('update_calendar_event', {
          event_id: 'evt1',
          new_title: 'Renamed',
          calendar_source: 'outlook',
        });
        expect(result).toEqual({ id: 'evt1' });
        expect(mockCal.updateEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event_id: 'evt1', new_title: 'Renamed' }),
          'outlook',
          AUTH_USER_ID,
        );
        expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(AUTH_USER_ID);
      });

      it('auto-detects outlook source from AAMk event_id prefix', async () => {
        mockCal.updateEvent.mockResolvedValue({} as any);

        await executeToolCall('update_calendar_event', {
          event_id: 'AAMkABC123',
          new_start: '2026-04-02T10:00:00',
        });
        expect(mockCal.updateEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event_id: 'AAMkABC123' }),
          'outlook',
          AUTH_USER_ID,
        );
        expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(AUTH_USER_ID);
      });

      it('auto-detects google source for non-AAMk event_id', async () => {
        mockCal.updateEvent.mockResolvedValue({} as any);

        await executeToolCall('update_calendar_event', {
          event_id: 'google_event_xyz',
          new_start: '2026-04-02T10:00:00',
        });
        expect(mockCal.updateEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event_id: 'google_event_xyz' }),
          'google',
          AUTH_USER_ID,
        );
        expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(AUTH_USER_ID);
      });
    });

    describe('delete_calendar_event', () => {
      it('uses explicit calendar_source when provided', async () => {
        mockCal.deleteEvent.mockResolvedValue(undefined);

        const result = await executeToolCall('delete_calendar_event', {
          event_id: 'evt1',
          calendar_source: 'google',
        });
        expect(result).toEqual({ success: true, message: 'Event deleted' });
        expect(mockCal.deleteEvent).toHaveBeenCalledWith('evt1', 'google', AUTH_USER_ID);
        expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(AUTH_USER_ID);
      });

      it('auto-detects outlook source from AAMk prefix', async () => {
        mockCal.deleteEvent.mockResolvedValue(undefined);

        await executeToolCall('delete_calendar_event', { event_id: 'AAMkXYZ' });
        expect(mockCal.deleteEvent).toHaveBeenCalledWith('AAMkXYZ', 'outlook', AUTH_USER_ID);
        expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(AUTH_USER_ID);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Reminder tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Reminders', () => {
  it('set_reminder — requires tenant-scoped user context', async () => {
    const result = await executeToolCallWithoutContext('set_reminder', {
      message: 'Call coach',
      remind_at: '2026-04-01T08:00:00',
    });
    expect(result).toMatchObject({
      success: false,
      code: 'AUTH_REQUIRED',
      error: 'set_reminder requires authenticated chat authorization context',
    });
  });

  it('set_reminder — delegates to setReminder with all fields', async () => {
    const reminder = { id: 1, message: 'Call coach', remind_at: '2026-04-01T08:00:00' };
    vi.mocked(setReminder).mockReturnValue(reminder as any);

    const result = await execAsUser('set_reminder', {
      message: 'Call coach',
      remind_at: '2026-04-01T08:00:00',
      recurring: 'weekly',
    });
    expect(result).toEqual(reminder);
    expect(setReminder).toHaveBeenCalledWith(AUTH_USER_ID, {
      message: 'Call coach',
      remind_at: '2026-04-01T08:00:00',
      recurring: 'weekly',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Note tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Notes', () => {
  it('save_note — requires tenant-scoped user context', async () => {
    const result = await executeToolCallWithoutContext('save_note', { content: 'Swim PR: 1:02:30' });
    expect(result).toMatchObject({
      success: false,
      code: 'AUTH_REQUIRED',
      error: 'save_note requires authenticated chat authorization context',
    });
  });

  it('save_note — delegates with content, domain, and tags', async () => {
    const note = { id: 1, content: 'Swim PR: 1:02:30' };
    vi.mocked(saveNote).mockReturnValue(note as any);

    const result = await execAsUser('save_note', {
      content: 'Swim PR: 1:02:30',
      domain: 'triathlon',
      tags: ['pr', 'swim'],
    });
    expect(result).toEqual(note);
    expect(saveNote).toHaveBeenCalledWith(AUTH_USER_ID, {
      content: 'Swim PR: 1:02:30',
      domain: 'triathlon',
      tags: ['pr', 'swim'],
    });
  });

  it('search_notes — delegates with query, domain, and tag filters', async () => {
    const notes = [{ id: 1, content: 'Swim PR' }];
    vi.mocked(searchNotes).mockReturnValue(notes as any);

    const result = await execAsUser('search_notes', {
      query: 'swim',
      domain: 'triathlon',
      tag: 'pr',
    });
    expect(result).toEqual(notes);
    expect(searchNotes).toHaveBeenCalledWith(AUTH_USER_ID, {
      query: 'swim',
      domain: 'triathlon',
      tag: 'pr',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Outlook Email tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Outlook Email', () => {
  describe('when Outlook is not configured', () => {
    beforeEach(() => {
      mockMail.isOutlookMailConfigured.mockReturnValue(false);
    });

    it.each(['search_outlook_emails', 'read_outlook_email', 'send_outlook_email', 'reply_outlook_email', 'get_outlook_unread'])(
      '%s returns configuration error',
      async (tool) => {
        const result = await executeToolCall(tool, {});
        expect(result).toHaveProperty('error');
        expect(result.error).toContain('Outlook is not configured');
      },
    );
  });

  describe('when configured', () => {
    beforeEach(() => {
      mockMail.isOutlookMailConfigured.mockReturnValue(true);
      mockMail.isOutlookMailConfiguredForUser.mockReturnValue(true);
    });

    it('search_outlook_emails — delegates with query and max_results', async () => {
      const emails = [{ id: 'msg1', subject: 'Invoice' }];
      mockMail.searchEmailsForUser.mockResolvedValue(emails as any);

      const result = await executeToolCall('search_outlook_emails', { query: 'Invoice', max_results: 5 });
      expect(result).toEqual(emails);
      expect(mockMail.searchEmailsForUser).toHaveBeenCalledWith(AUTH_USER_ID, 'Invoice', 5);
    });

    it('search_outlook_emails — preserves tenant scope when user context exists', async () => {
      const emails = [{ id: 'msg1', subject: 'Invoice' }];
      mockMail.searchEmailsForUser.mockResolvedValue(emails as any);

      const result = await execAsUser('search_outlook_emails', { query: 'Invoice', max_results: 5 });

      expect(result).toEqual(emails);
      expect(mockMail.isOutlookMailConfiguredForUser).toHaveBeenCalledWith(AUTH_USER_ID);
      expect(mockMail.searchEmailsForUser).toHaveBeenCalledWith(AUTH_USER_ID, 'Invoice', 5);
    });

    it('search_outlook_emails — defaults max_results to 10 when not provided', async () => {
      mockMail.searchEmailsForUser.mockResolvedValue([]);

      await executeToolCall('search_outlook_emails', { query: 'test' });
      expect(mockMail.searchEmailsForUser).toHaveBeenCalledWith(AUTH_USER_ID, 'test', 10);
    });

    it('read_outlook_email — delegates with message_id', async () => {
      const email = { id: 'msg1', subject: 'Invoice', body: '<html>' };
      mockMail.readEmailForUser.mockResolvedValue(email as any);

      const result = await executeToolCall('read_outlook_email', { message_id: 'msg1' });
      expect(result).toEqual(email);
      expect(mockMail.readEmailForUser).toHaveBeenCalledWith(AUTH_USER_ID, 'msg1');
    });

    it('read_outlook_email — uses user-scoped mailbox when context exists', async () => {
      const email = { id: 'msg1', subject: 'Invoice', body: '<html>' };
      mockMail.readEmailForUser.mockResolvedValue(email as any);

      const result = await execAsUser('read_outlook_email', { message_id: 'msg1' });

      expect(result).toEqual(email);
      expect(mockMail.readEmailForUser).toHaveBeenCalledWith(AUTH_USER_ID, 'msg1');
    });

    it('send_outlook_email — returns success message with recipient', async () => {
      mockMail.sendEmailForUser.mockResolvedValue(undefined);

      const result = await executeToolCall('send_outlook_email', {
        to: 'coach@team.com',
        subject: 'Training update',
        body: 'Week 12 done',
        cc: 'manager@team.com',
      });
      expect(result).toEqual({ success: true, message: 'Email sent to coach@team.com' });
      expect(mockMail.sendEmailForUser).toHaveBeenCalledWith(AUTH_USER_ID, {
        to: 'coach@team.com',
        subject: 'Training update',
        body: 'Week 12 done',
        cc: 'manager@team.com',
      });
    });

    it('send_outlook_email — uses user-scoped mailbox when context exists', async () => {
      mockMail.sendEmailForUser.mockResolvedValue(undefined);

      const result = await execAsUser('send_outlook_email', {
        to: 'coach@team.com',
        subject: 'Training update',
        body: 'Week 12 done',
      });

      expect(result).toEqual({ success: true, message: 'Email sent to coach@team.com' });
      expect(mockMail.sendEmailForUser).toHaveBeenCalledWith(AUTH_USER_ID, {
        to: 'coach@team.com',
        subject: 'Training update',
        body: 'Week 12 done',
        cc: undefined,
      });
    });

    it('reply_outlook_email — returns { success: true, message: "Reply sent" }', async () => {
      mockMail.replyToEmailForUser.mockResolvedValue(undefined);

      const result = await executeToolCall('reply_outlook_email', {
        message_id: 'msg1',
        body: 'Thanks!',
      });
      expect(result).toEqual({ success: true, message: 'Reply sent' });
      expect(mockMail.replyToEmailForUser).toHaveBeenCalledWith(AUTH_USER_ID, { messageId: 'msg1', body: 'Thanks!' });
    });

    it('reply_outlook_email — uses user-scoped mailbox when context exists', async () => {
      mockMail.replyToEmailForUser.mockResolvedValue(undefined);

      const result = await execAsUser('reply_outlook_email', {
        message_id: 'msg1',
        body: 'Thanks!',
      });

      expect(result).toEqual({ success: true, message: 'Reply sent' });
      expect(mockMail.replyToEmailForUser).toHaveBeenCalledWith(AUTH_USER_ID, {
        messageId: 'msg1',
        body: 'Thanks!',
      });
    });

    it('get_outlook_unread — returns unread_count and recent_unread', async () => {
      const emails = [{ id: 'msg1', subject: 'New lead' }];
      mockMail.getUnreadEmailsForUser.mockResolvedValue({ count: 3, emails } as any);

      const result = await executeToolCall('get_outlook_unread', { max_results: 5 });
      expect(result).toEqual({ unread_count: 3, recent_unread: emails });
      expect(mockMail.getUnreadEmailsForUser).toHaveBeenCalledWith(AUTH_USER_ID, 5);
    });

    it('get_outlook_unread — uses user-scoped mailbox when context exists', async () => {
      const emails = [{ id: 'msg1', subject: 'New lead' }];
      mockMail.getUnreadEmailsForUser.mockResolvedValue({ count: 3, emails } as any);

      const result = await execAsUser('get_outlook_unread', { max_results: 5 });

      expect(result).toEqual({ unread_count: 3, recent_unread: emails });
      expect(mockMail.getUnreadEmailsForUser).toHaveBeenCalledWith(AUTH_USER_ID, 5);
    });

    it('get_outlook_unread — defaults max_results to 10', async () => {
      mockMail.getUnreadEmailsForUser.mockResolvedValue({ count: 0, emails: [] });

      await executeToolCall('get_outlook_unread', {});
      expect(mockMail.getUnreadEmailsForUser).toHaveBeenCalledWith(AUTH_USER_ID, 10);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Shared Memory tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Shared Memory', () => {
  it('shared_memory_set — requires tenant-scoped user context', async () => {
    const result = await executeToolCallWithoutContext('shared_memory_set', {
      key: 'active_race',
      value: 'Ironman 2026',
    });
    expect(result).toMatchObject({
      success: false,
      code: 'AUTH_REQUIRED',
      error: 'shared_memory_set requires authenticated chat authorization context',
    });
  });

  it('shared_memory_set — delegates to setSharedMemory, returns entry fields', async () => {
    const entry = { key: 'active_race', value: 'Ironman 2026', domain: 'secretary', expires_at: undefined };
    vi.mocked(setSharedMemory).mockReturnValue(entry as any);

    const result = await execAsUser('shared_memory_set', {
      key: 'active_race',
      value: 'Ironman 2026',
      expires_at: undefined,
    });
    expect(result).toEqual({ success: true, key: 'active_race', value: 'Ironman 2026' });
    expect(setSharedMemory).toHaveBeenCalledWith(AUTH_USER_ID, 'active_race', 'Ironman 2026', 'secretary', undefined, AUTH_USER_ID);
  });

  it('shared_memory_set — inherits explicit Chat tenant scope for multi-turn memory', async () => {
    const entry = { key: 'planning_style', value: 'Protect mornings', domain: 'secretary', expires_at: undefined };
    vi.mocked(setSharedMemory).mockReturnValue(entry as any);

    const result = await execAsTenantUser('shared_memory_set', {
      key: 'planning_style',
      value: 'Protect mornings',
    }, 1001);

    expect(result).toEqual({ success: true, key: 'planning_style', value: 'Protect mornings' });
    expect(setSharedMemory).toHaveBeenCalledWith(AUTH_USER_ID, 'planning_style', 'Protect mornings', 'secretary', undefined, 1001);
  });

  it('shared_memory_remove — returns { success: true, key } when entry exists', async () => {
    vi.mocked(removeSharedMemory).mockReturnValue(true);

    const result = await execAsUser('shared_memory_remove', { key: 'active_race' });
    expect(result).toEqual({ success: true, key: 'active_race' });
    expect(removeSharedMemory).toHaveBeenCalledWith(AUTH_USER_ID, 'active_race', AUTH_USER_ID);
  });

  it('shared_memory_remove — returns { success: false, key } when entry does not exist', async () => {
    vi.mocked(removeSharedMemory).mockReturnValue(false);

    const result = await execAsUser('shared_memory_remove', { key: 'nonexistent' });
    expect(result).toEqual({ success: false, key: 'nonexistent' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Finance tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Finance', () => {
  beforeEach(() => {
    mockFinance.addTransaction.mockReset();
    mockFinance.deleteTransaction.mockReset();
    mockFinance.calculateAndStoreTax.mockReset();
    mockFinance.calculateMonthlyTax.mockReset();
    mockFinance.markTaxPaid.mockReset();
  });

  it('preserves a user-specified currency when logging a transaction', async () => {
    mockResolveCanonicalUserId.mockImplementation((userRef: unknown) => {
      if (userRef === 77) return 7077;
      return typeof userRef === 'number' && userRef > 0 ? userRef : null;
    });
    mockFinance.addTransaction.mockReturnValue({
      id: 17,
      date: '2026-04-15',
      category: 'expense',
      amount: 28,
      currency: 'EUR',
      subcategory: 'meals',
      description: 'Lunch',
      receipt_ref: null,
    } as any);

    const result = await executeToolCall('finance_add_transaction', {
      date: '2026-04-15',
      category: 'expense',
      amount: 28,
      currency: 'EUR',
      subcategory: 'meals',
      description: 'Lunch',
    }, 77);

    expect(mockFinance.addTransaction).toHaveBeenCalledWith(7077, '2026-04-15', 'expense', 28, {
      subcategory: 'meals',
      description: 'Lunch',
      currency: 'EUR',
    });
    expect(result).toEqual({
      success: true,
      id: 17,
      date: '2026-04-15',
      category: 'expense',
      amount: 28,
      currency: 'EUR',
    });
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(7077);
  });

  it('invalidates finance-derived surfaces after deleting a transaction', async () => {
    mockFinance.deleteTransaction.mockReturnValue(true);

    const result = await execAsUser('finance_delete_transaction', { transaction_id: 88 });

    expect(result).toEqual({ success: true });
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(AUTH_USER_ID);
  });

  it('invalidates finance-derived surfaces after calculating tax', async () => {
    mockFinance.calculateAndStoreTax.mockReturnValue({
      month: '2026-04',
      gross_income: 2500,
      deductions: 200,
    } as any);
    mockFinance.calculateMonthlyTax.mockReturnValue({
      effectiveRate: 12.5,
      bracket: 'mid',
    } as any);

    const result = await execAsUser('finance_calculate_tax', { month: '2026-04' });

    expect(result).toMatchObject({
      month: '2026-04',
      effectiveRate: 12.5,
      bracket: 'mid',
    });
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(AUTH_USER_ID);
  });

  it('invalidates finance-derived surfaces after marking tax paid', async () => {
    mockFinance.markTaxPaid.mockReturnValue(true);

    const result = await execAsUser('finance_mark_tax_paid', { month: '2026-04' });

    expect(result).toEqual({ success: true, month: '2026-04', status: 'paid' });
    expect(mockInvalidateFinanceDerivedCaches).toHaveBeenCalledWith(AUTH_USER_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cooking tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Cooking', () => {
  it('invalidates cooking-derived surfaces after setting a meal', async () => {
    const setMealSpy = vi.spyOn(cookingChef, 'setMealPlan');
    setMealSpy.mockReturnValue({
      date: '2026-04-15',
      meal_type: 'dinner',
      title: 'Salmon bowl',
    } as any);

    const result = await execAsUser('cooking_set_meal', {
      date: '2026-04-15',
      meal_type: 'dinner',
      title: 'Salmon bowl',
    });

    expect(result).toEqual({
      success: true,
      date: '2026-04-15',
      meal_type: 'dinner',
      title: 'Salmon bowl',
    });
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(AUTH_USER_ID);
    setMealSpy.mockRestore();
  });

  it('passes authenticated tenant scope into cooking meal writes', async () => {
    const setMealSpy = vi.spyOn(cookingChef, 'setMealPlan');
    setMealSpy.mockReturnValue({
      date: '2026-04-15',
      meal_type: 'dinner',
      title: 'Tenant-safe salmon bowl',
    } as any);

    const result = await execAsTenantUser('cooking_set_meal', {
      date: '2026-04-15',
      meal_type: 'dinner',
      title: 'Tenant-safe salmon bowl',
    }, 1001);

    expect(result).toEqual({
      success: true,
      date: '2026-04-15',
      meal_type: 'dinner',
      title: 'Tenant-safe salmon bowl',
    });
    expect(setMealSpy).toHaveBeenCalledWith(
      AUTH_USER_ID,
      '2026-04-15',
      'dinner',
      'Tenant-safe salmon bowl',
      expect.objectContaining({ tenantId: 1001 }),
    );
    setMealSpy.mockRestore();
  });

  it('passes authenticated tenant scope into cooking pantry writes', async () => {
    const upsertSpy = vi.spyOn(cookingChef, 'upsertPantryItem');
    upsertSpy.mockReturnValue({
      id: 55,
      name: 'Rice',
      freshness_status: 'fresh',
    } as any);

    const result = await execAsTenantUser('cooking_upsert_pantry_item', {
      name: 'Rice',
      quantity: '1',
      unit: 'kg',
      freshness_status: 'fresh',
    }, 1001);

    expect(result).toEqual({
      success: true,
      id: 55,
      name: 'Rice',
      freshness_status: 'fresh',
    });
    expect(upsertSpy).toHaveBeenCalledWith(
      AUTH_USER_ID,
      expect.objectContaining({ name: 'Rice', quantity: '1', unit: 'kg' }),
      1001,
    );
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(AUTH_USER_ID);
    upsertSpy.mockRestore();
  });

  it('passes authenticated tenant scope into cooking pantry reads', async () => {
    const listSpy = vi.spyOn(cookingChef, 'getPantryItems');
    listSpy.mockReturnValue([{ id: 56, name: 'Oats' }] as any);

    const result = await execAsTenantUser('cooking_get_pantry', {
      search: 'oats',
      include_expired: true,
    }, 1001);

    expect(result).toEqual([{ id: 56, name: 'Oats' }]);
    expect(listSpy).toHaveBeenCalledWith(AUTH_USER_ID, expect.objectContaining({
      tenantId: 1001,
      search: 'oats',
      includeExpired: true,
    }));
    listSpy.mockRestore();
  });

  it('invalidates cooking-derived surfaces after deleting a meal', async () => {
    const deleteMealSpy = vi.spyOn(cookingChef, 'deleteMealPlan');
    deleteMealSpy.mockReturnValue(true);

    const result = await execAsUser('cooking_delete_meal', {
      date: '2026-04-15',
      meal_type: 'dinner',
    });

    expect(result).toEqual({ success: true });
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(AUTH_USER_ID);
    deleteMealSpy.mockRestore();
  });

  it('invalidates cooking-derived surfaces after regenerating the shopping list', async () => {
    const generateSpy = vi.spyOn(cookingChef, 'generateShoppingList');
    generateSpy.mockReturnValue({ items: [{ name: 'Eggs' }] } as any);

    const result = await execAsUser('cooking_generate_shopping_list', {
      week_start: '2026-04-13',
    });

    expect(result).toEqual({ items: [{ name: 'Eggs' }] });
    expect(mockInvalidateCookingDerivedCaches).toHaveBeenCalledWith(AUTH_USER_ID);
    generateSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — error handling', () => {
  it('returns { error: "Unknown tool: ..." } for unrecognised tool names', async () => {
    const result = await executeToolCallWithoutContext('make_coffee', {});
    expect(result).toEqual({
      success: false,
      error: 'Tool "make_coffee" is not registered for execution',
      code: 'TOOL_NOT_ALLOWED',
    });
  });

  it('catches thrown errors without returning raw provider text', async () => {
    mockTodo.isOutlookTodoConfigured.mockReturnValue(true);
    mockTodo.getLists.mockRejectedValue(new Error('Network timeout'));

    const result = await execAsUser('ms_todo_get_lists');
    expect(result).toEqual({ error: 'Tool execution failed' });
  });

  it('catches calendar errors without leaking token or provider details', async () => {
    mockCal.isAnyCalendarConfigured.mockReturnValue(true);
    mockCal.getEvents.mockRejectedValue(new Error('Token expired'));

    const result = await executeToolCall('get_calendar_events', {
      start_date: '2026-03-30',
      end_date: '2026-04-06',
    });
    expect(result).toEqual({ error: 'Tool execution failed' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Chat tool authorization
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — chat authorization guard', () => {
  beforeEach(() => {
    mockCal.deleteEvent.mockReset();
    vi.mocked(setReminder).mockReset();
  });

  it('blocks destructive chat tool calls without explicit confirmation', async () => {
    mockCal.hasConnectedCalendarForUser.mockReturnValue(true);

    const result = await runWithChatToolAuthorization({
      userId: AUTH_USER_ID,
      tenantId: 1001,
      confirmedDestructiveAction: false,
      confirmationSource: 'none',
    }, () => execAsTenantUser('delete_calendar_event', {
      event_id: 'evt-1',
      calendar_source: 'google',
    }, 1001));

    expect(result).toMatchObject({
      success: false,
      code: 'CONFIRMATION_REQUIRED',
      confirmation_required: true,
      tool_risk: 'destructive',
    });
    expect(mockCal.deleteEvent).not.toHaveBeenCalled();
  });

  it('allows confirmed destructive chat tool calls inside the same tenant scope', async () => {
    mockCal.hasConnectedCalendarForUser.mockReturnValue(true);
    mockCal.deleteEvent.mockResolvedValue(undefined as any);

    const result = await runWithChatToolAuthorization({
      userId: AUTH_USER_ID,
      tenantId: 1001,
      confirmedDestructiveAction: true,
      confirmationSource: 'explicit_current_turn',
    }, () => execAsTenantUser('delete_calendar_event', {
      event_id: 'evt-1',
      calendar_source: 'google',
    }, 1001));

    expect(result).toEqual({ success: true, message: 'Event deleted' });
    expect(mockCal.deleteEvent).toHaveBeenCalledWith('evt-1', 'google', AUTH_USER_ID);
  });

  it('blocks chat tool calls when the tenant context changes under the request', async () => {
    const result = await runWithChatToolAuthorization({
      userId: AUTH_USER_ID,
      tenantId: 1001,
      confirmedDestructiveAction: true,
      confirmationSource: 'explicit_current_turn',
    }, () => execAsTenantUser('set_reminder', {
      message: 'Pay invoice',
      remind_at: '2026-05-01T09:00:00Z',
    }, 2002));

    expect(result).toMatchObject({
      success: false,
      code: 'TENANT_SCOPE_MISMATCH',
      confirmation_required: false,
    });
    expect(setReminder).not.toHaveBeenCalled();
  });

  it('blocks prompt-injected tenant ids before the tool can execute', async () => {
    const result = await runWithChatToolAuthorization({
      userId: AUTH_USER_ID,
      tenantId: AUTH_USER_ID,
      confirmedDestructiveAction: false,
      confirmationSource: 'none',
    }, () => execAsTenantUser('set_reminder', {
      tenant_id: AUTH_USER_ID + 1,
      message: 'Use the other tenant',
      remind_at: '2026-05-01T09:00:00Z',
    }, AUTH_USER_ID));

    expect(result).toMatchObject({
      success: false,
      code: 'TENANT_SCOPE_MISMATCH',
      confirmation_required: false,
    });
    expect(setReminder).not.toHaveBeenCalled();
  });

  it('rejects prompt-injected explicit user ids instead of silently rewriting them to the chat user', async () => {
    const result = await runWithChatToolAuthorization({
      userId: AUTH_USER_ID,
      tenantId: AUTH_USER_ID,
      confirmedDestructiveAction: false,
      confirmationSource: 'none',
    }, () => execAsUser('create_training_plan', {
      user_id: AUTH_USER_ID + 1,
      name: 'Injected plan',
      sport: 'running',
      goal: 'access another user',
      duration_weeks: 4,
      start_date: '2026-05-01',
    }));

    expect(result).toMatchObject({
      success: false,
      code: 'AUTH_REQUIRED',
      error: 'create_training_plan requested a user outside the authenticated chat user',
      confirmation_required: false,
      tool_risk: 'write',
    });
  });
});
