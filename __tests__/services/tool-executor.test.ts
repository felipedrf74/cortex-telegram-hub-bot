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
  getEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn(),
  searchEmails: vi.fn(),
  readEmail: vi.fn(),
  sendEmail: vi.fn(),
  replyToEmail: vi.fn(),
  getUnreadEmails: vi.fn(),
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

import { executeToolCall } from '../../src/services/tool-executor';
import * as msTodo from '../../src/services/microsoft-todo';
import * as unifiedCal from '../../src/services/unified-calendar';
import * as outlookMail from '../../src/services/outlook-mail';
import { setReminder } from '../../src/state/reminders';
import { saveNote, searchNotes } from '../../src/state/notes';
import { setSharedMemory, removeSharedMemory } from '../../src/state/shared-memory';
import * as financeTracker from '../../src/services/finance-tracker';

// ─── Helpers ─────────────────────────────────────────────────────────

const mockTodo = vi.mocked(msTodo);
const mockCal = vi.mocked(unifiedCal);
const mockMail = vi.mocked(outlookMail);
const mockFinance = vi.mocked(financeTracker);
const AUTH_USER_ID = 42;
const execAsUser = (tool: string, input: Record<string, any> = {}) => executeToolCall(tool, input, AUTH_USER_ID);

beforeEach(() => {
  mockResolveCanonicalUserId.mockReset();
  mockResolveCanonicalUserId.mockImplementation((userRef: unknown) =>
    typeof userRef === 'number' && userRef > 0 ? userRef : null
  );
  mockGetTaskProviderForUser.mockReset();
  mockGetTaskProviderForUser.mockReturnValue(mockTodo);
});

// ═══════════════════════════════════════════════════════════════════
// Microsoft To Do tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Microsoft To Do', () => {
  it('returns a tenant-scope error when task tools run without a user context', async () => {
    const result = await executeToolCall('ms_todo_get_lists', {});
    expect(result).toEqual({ error: 'ms_todo_get_lists requires an authenticated user context' });
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
    });

    it('get_calendar_events — delegates with date range', async () => {
      const events = [{ id: 'evt1', title: 'Standup' }];
      mockCal.getEvents.mockResolvedValue(events as any);

      const result = await executeToolCall('get_calendar_events', {
        start_date: '2026-03-30',
        end_date: '2026-04-06',
      });
      expect(result).toEqual(events);
      expect(mockCal.getEvents).toHaveBeenCalledWith('2026-03-30', '2026-04-06');
    });

    it('create_calendar_event — delegates with event data and source', async () => {
      const created = { id: 'evt2', title: 'Swim session' };
      mockCal.createEvent.mockResolvedValue(created as any);

      await executeToolCall('create_calendar_event', {
        title: 'Swim session',
        start: '2026-04-01T06:00:00',
        end: '2026-04-01T07:00:00',
        description: '2km open water',
        categories: ['sport'],
        calendar_source: 'google',
      });
      expect(mockCal.createEvent).toHaveBeenCalledWith(
        {
          title: 'Swim session',
          start: '2026-04-01T06:00:00',
          end: '2026-04-01T07:00:00',
          description: '2km open water',
          categories: ['sport'],
          attendees: undefined,
          location: undefined,
        },
        'google',
        undefined,
      );
    });

    describe('update_calendar_event', () => {
      it('uses explicit calendar_source when provided', async () => {
        mockCal.updateEvent.mockResolvedValue({ id: 'evt1' } as any);

        await executeToolCall('update_calendar_event', {
          event_id: 'evt1',
          new_title: 'Renamed',
          calendar_source: 'outlook',
        });
        expect(mockCal.updateEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event_id: 'evt1', new_title: 'Renamed' }),
          'outlook',
          undefined,
        );
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
          undefined,
        );
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
          undefined,
        );
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
        expect(mockCal.deleteEvent).toHaveBeenCalledWith('evt1', 'google', undefined);
      });

      it('auto-detects outlook source from AAMk prefix', async () => {
        mockCal.deleteEvent.mockResolvedValue(undefined);

        await executeToolCall('delete_calendar_event', { event_id: 'AAMkXYZ' });
        expect(mockCal.deleteEvent).toHaveBeenCalledWith('AAMkXYZ', 'outlook', undefined);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Reminder tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Reminders', () => {
  it('set_reminder — requires tenant-scoped user context', async () => {
    const result = await executeToolCall('set_reminder', {
      message: 'Call coach',
      remind_at: '2026-04-01T08:00:00',
    });
    expect(result).toEqual({ error: 'set_reminder requires an authenticated user context' });
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
    const result = await executeToolCall('save_note', { content: 'Swim PR: 1:02:30' });
    expect(result).toEqual({ error: 'save_note requires an authenticated user context' });
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
    });

    it('search_outlook_emails — delegates with query and max_results', async () => {
      const emails = [{ id: 'msg1', subject: 'Invoice' }];
      mockMail.searchEmails.mockResolvedValue(emails as any);

      const result = await executeToolCall('search_outlook_emails', { query: 'Invoice', max_results: 5 });
      expect(result).toEqual(emails);
      expect(mockMail.searchEmails).toHaveBeenCalledWith('Invoice', 5);
    });

    it('search_outlook_emails — defaults max_results to 10 when not provided', async () => {
      mockMail.searchEmails.mockResolvedValue([]);

      await executeToolCall('search_outlook_emails', { query: 'test' });
      expect(mockMail.searchEmails).toHaveBeenCalledWith('test', 10);
    });

    it('read_outlook_email — delegates with message_id', async () => {
      const email = { id: 'msg1', subject: 'Invoice', body: '<html>' };
      mockMail.readEmail.mockResolvedValue(email as any);

      const result = await executeToolCall('read_outlook_email', { message_id: 'msg1' });
      expect(result).toEqual(email);
      expect(mockMail.readEmail).toHaveBeenCalledWith('msg1');
    });

    it('send_outlook_email — returns success message with recipient', async () => {
      mockMail.sendEmail.mockResolvedValue(undefined);

      const result = await executeToolCall('send_outlook_email', {
        to: 'coach@team.com',
        subject: 'Training update',
        body: 'Week 12 done',
        cc: 'manager@team.com',
      });
      expect(result).toEqual({ success: true, message: 'Email sent to coach@team.com' });
      expect(mockMail.sendEmail).toHaveBeenCalledWith({
        to: 'coach@team.com',
        subject: 'Training update',
        body: 'Week 12 done',
        cc: 'manager@team.com',
      });
    });

    it('reply_outlook_email — returns { success: true, message: "Reply sent" }', async () => {
      mockMail.replyToEmail.mockResolvedValue(undefined);

      const result = await executeToolCall('reply_outlook_email', {
        message_id: 'msg1',
        body: 'Thanks!',
      });
      expect(result).toEqual({ success: true, message: 'Reply sent' });
      expect(mockMail.replyToEmail).toHaveBeenCalledWith({ messageId: 'msg1', body: 'Thanks!' });
    });

    it('get_outlook_unread — returns unread_count and recent_unread', async () => {
      const emails = [{ id: 'msg1', subject: 'New lead' }];
      mockMail.getUnreadEmails.mockResolvedValue({ count: 3, emails } as any);

      const result = await executeToolCall('get_outlook_unread', { max_results: 5 });
      expect(result).toEqual({ unread_count: 3, recent_unread: emails });
      expect(mockMail.getUnreadEmails).toHaveBeenCalledWith(5);
    });

    it('get_outlook_unread — defaults max_results to 10', async () => {
      mockMail.getUnreadEmails.mockResolvedValue({ count: 0, emails: [] });

      await executeToolCall('get_outlook_unread', {});
      expect(mockMail.getUnreadEmails).toHaveBeenCalledWith(10);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Shared Memory tools
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — Shared Memory', () => {
  it('shared_memory_set — requires tenant-scoped user context', async () => {
    const result = await executeToolCall('shared_memory_set', {
      key: 'active_race',
      value: 'Ironman 2026',
    });
    expect(result).toEqual({ error: 'shared_memory_set requires an authenticated user context' });
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
    expect(setSharedMemory).toHaveBeenCalledWith(AUTH_USER_ID, 'active_race', 'Ironman 2026', 'secretary', undefined);
  });

  it('shared_memory_remove — returns { success: true, key } when entry exists', async () => {
    vi.mocked(removeSharedMemory).mockReturnValue(true);

    const result = await execAsUser('shared_memory_remove', { key: 'active_race' });
    expect(result).toEqual({ success: true, key: 'active_race' });
    expect(removeSharedMemory).toHaveBeenCalledWith(AUTH_USER_ID, 'active_race');
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
  });
});

// ═══════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════

describe('executeToolCall — error handling', () => {
  it('returns { error: "Unknown tool: ..." } for unrecognised tool names', async () => {
    const result = await executeToolCall('make_coffee', {});
    expect(result).toEqual({ error: 'Unknown tool: make_coffee' });
  });

  it('catches thrown errors and returns { error: "Tool execution failed: ..." }', async () => {
    mockTodo.isOutlookTodoConfigured.mockReturnValue(true);
    mockTodo.getLists.mockRejectedValue(new Error('Network timeout'));

    const result = await execAsUser('ms_todo_get_lists');
    expect(result).toEqual({ error: 'Tool execution failed: Network timeout' });
  });

  it('catches calendar errors and wraps the message', async () => {
    mockCal.isAnyCalendarConfigured.mockReturnValue(true);
    mockCal.getEvents.mockRejectedValue(new Error('Token expired'));

    const result = await executeToolCall('get_calendar_events', {
      start_date: '2026-03-30',
      end_date: '2026-04-06',
    });
    expect(result).toEqual({ error: 'Tool execution failed: Token expired' });
  });
});
