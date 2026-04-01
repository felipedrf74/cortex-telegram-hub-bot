/**
 * Secretary Domain Handler Tests
 *
 * Tests handleSecretary's specialized behavior:
 * - State context building with external APIs (Todo, Calendar, Email, Garmin)
 * - Tool result truncation at 2000 chars
 * - Empty response fallback guard
 * - Tool loop max iteration cap (4)
 * - Conversation history management
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock all dependencies ──────────────────────────────────────────

vi.mock('../../src/services/anthropic', () => ({
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
}));

vi.mock('../../src/state/conversation', () => ({
  getConversationHistory: vi.fn().mockReturnValue([]),
  addToConversation: vi.fn(),
}));

vi.mock('../../src/state/reminders', () => ({
  getActiveReminders: vi.fn().mockReturnValue([]),
  getRemindersForToday: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  isAnyCalendarConfigured: vi.fn().mockReturnValue(false),
  getEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn().mockReturnValue(false),
  getUnreadCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn().mockReturnValue(false),
  getAllPendingTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
}));

vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: vi.fn().mockReturnValue(false),
  getActivitiesByDate: vi.fn().mockResolvedValue([]),
  getBodyBatteryEvents: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/state/shared-memory', () => ({
  getSharedMemorySummary: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/services/tool-executor', () => ({
  executeToolCall: vi.fn(),
}));

vi.mock('../../src/services/usage-metering', () => ({
  recordUsage: vi.fn(),
}));

vi.mock('../../src/utils/date-parser', () => ({
  now: vi.fn(),
  formatDateTime: vi.fn((d: string) => d),
  startOfDay: vi.fn().mockReturnValue('2026-03-30T00:00:00'),
  endOfDay: vi.fn().mockReturnValue('2026-03-30T23:59:59'),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────

import { handleSecretary } from '../../src/domains/secretary';
import { callDomain, continueWithToolResults } from '../../src/services/anthropic';
import { addToConversation } from '../../src/state/conversation';
import { executeToolCall } from '../../src/services/tool-executor';
import { now } from '../../src/utils/date-parser';
import { isOutlookTodoConfigured, getAllPendingTasks } from '../../src/services/microsoft-todo';
import { isAnyCalendarConfigured, getEvents } from '../../src/services/unified-calendar';
import { isOutlookMailConfigured, getUnreadCount } from '../../src/services/outlook-mail';
import { getRemindersForToday } from '../../src/state/reminders';

const mockCallDomain = vi.mocked(callDomain);
const mockContinue = vi.mocked(continueWithToolResults);
const mockExecuteTool = vi.mocked(executeToolCall);

// ─── Shared setup ────────────────────────────────────────────────────

// Secretary has a 30s state context cache. Advance Date.now past the TTL
// on each test so the cache is always expired and context is rebuilt fresh.
let fakeTime = Date.now();

beforeEach(() => {
  vi.clearAllMocks();
  fakeTime += 60_000; // 60s jump — well past the 30s cache TTL
  vi.spyOn(Date, 'now').mockReturnValue(fakeTime);
  vi.mocked(now).mockReturnValue({
    toFormat: vi.fn().mockReturnValue('Monday, March 30 2026, 10:00'),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-03-27') }),
  } as any);
});

// ═══════════════════════════════════════════════════════════════════

describe('handleSecretary', () => {
  it('returns text response when no tool calls', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'You have 3 tasks today.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('What do I have today?');
    expect(result).toEqual({ text: 'You have 3 tasks today.', domain: 'secretary' });
    expect(mockCallDomain).toHaveBeenCalledOnce();
  });

  it('stores user and assistant messages in conversation', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSecretary('Check email');
    expect(addToConversation).toHaveBeenCalledWith('secretary', 'user', 'Check email');
    expect(addToConversation).toHaveBeenCalledWith('secretary', 'assistant', 'Done.');
  });

  it('executes tool calls and returns final text', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{ type: 'tool_use', id: 'tc_1', name: 'ms_todo_get_lists', input: {} }],
      stopReason: 'tool_use',
    } as any);
    mockExecuteTool.mockResolvedValue({ success: true, data: [] });
    mockContinue.mockResolvedValue({
      text: 'You have no task lists.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('Show my lists');
    expect(result.text).toBe('You have no task lists.');
    expect(mockExecuteTool).toHaveBeenCalledWith('ms_todo_get_lists', {});
  });

  it('truncates tool results larger than 2000 characters', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{ type: 'tool_use', id: 'tc_1', name: 'search_outlook_emails', input: { query: 'test' } }],
      stopReason: 'tool_use',
    } as any);

    // Return a very large result
    const largeResult = { emails: 'x'.repeat(3000) };
    mockExecuteTool.mockResolvedValue(largeResult);

    mockContinue.mockResolvedValue({
      text: 'Found emails.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSecretary('Search emails');

    // Verify continueWithToolResults received truncated content
    const continueArgs = mockContinue.mock.calls[0];
    const toolConvo = continueArgs[4] as any[];
    const userMsg = toolConvo[1]; // second message is the user (tool_result)
    const toolResultContent = userMsg.content[0].content;
    expect(toolResultContent.length).toBeLessThanOrEqual(2020); // 2000 + "...(truncated)"
    expect(toolResultContent).toContain('...(truncated)');
  });

  it('returns fallback message when response is empty', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('Do something');
    expect(result.text).toContain('encountered some issues');
  });

  it('returns fallback message when response is whitespace-only', async () => {
    mockCallDomain.mockResolvedValue({
      text: '   \n  ',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('Do something');
    expect(result.text).toContain('encountered some issues');
  });

  it('caps tool iterations at 4', async () => {
    const toolCall = { type: 'tool_use', id: 'tc_1', name: 'ms_todo_get_tasks', input: {} };

    mockCallDomain.mockResolvedValue({
      text: '', toolCalls: [toolCall], stopReason: 'tool_use',
    } as any);
    mockExecuteTool.mockResolvedValue({ success: true, data: [] });

    // Every continuation returns more tool calls
    mockContinue.mockResolvedValue({
      text: 'Still working...', toolCalls: [toolCall], stopReason: 'tool_use',
    } as any);

    await handleSecretary('Complex task');
    expect(mockContinue).toHaveBeenCalledTimes(4);
  });

  it('prefixes stored text with [Tools: ...] and deduplicates', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [
        { type: 'tool_use', id: 'tc_1', name: 'ms_todo_get_tasks', input: {} },
        { type: 'tool_use', id: 'tc_2', name: 'ms_todo_get_tasks', input: {} },
      ],
      stopReason: 'tool_use',
    } as any);
    mockExecuteTool.mockResolvedValue({ success: true, data: [] });
    mockContinue.mockResolvedValue({
      text: 'Here are your tasks.', toolCalls: [], stopReason: 'end_turn',
    } as any);

    await handleSecretary('Get tasks');

    const storedCall = vi.mocked(addToConversation).mock.calls.find(
      (c) => c[1] === 'assistant',
    );
    expect(storedCall![2]).toBe('[Tools: ms_todo_get_tasks]\nHere are your tasks.');
  });
});

// ═══════════════════════════════════════════════════════════════════
// State context building (tested via callDomain args)
// ═══════════════════════════════════════════════════════════════════

describe('Secretary state context', () => {
  it('includes current date in context', async () => {
    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);

    await handleSecretary('Hi');

    const stateCtx = mockCallDomain.mock.calls[0][3] as string;
    expect(stateCtx).toContain('Monday, March 30 2026');
  });

  it('includes pending todo summary when configured', async () => {
    vi.mocked(isOutlookTodoConfigured).mockReturnValue(true);
    vi.mocked(getAllPendingTasks).mockResolvedValue({
      success: true,
      data: [
        { id: 't1', listId: 'l1', listName: 'Work', title: 'Deploy v5', importance: 'high', status: 'notStarted', dueDateTime: '2026-03-29T09:00:00', isReminderOn: false, createdDateTime: '2026-03-28' },
      ],
    } as any);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('Check tasks');

    const stateCtx = mockCallDomain.mock.calls[0][3] as string;
    expect(stateCtx).toContain('To Do: 1 pending');
    expect(stateCtx).toContain('1 overdue');
    expect(stateCtx).toContain('Work(1)');
  });

  it('includes unread email count when Outlook is configured', async () => {
    vi.mocked(isOutlookMailConfigured).mockReturnValue(true);
    vi.mocked(getUnreadCount).mockResolvedValue(7);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('Check inbox');

    const stateCtx = mockCallDomain.mock.calls[0][3] as string;
    expect(stateCtx).toContain('Outlook: 7 unread');
  });

  it('includes calendar events when configured', async () => {
    vi.mocked(isAnyCalendarConfigured).mockReturnValue(true);
    vi.mocked(getEvents).mockResolvedValue([
      { summary: 'Team standup', start: '2026-03-30T09:00:00', end: '2026-03-30T09:30:00' },
    ] as any);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('My calendar');

    const stateCtx = mockCallDomain.mock.calls[0][3] as string;
    expect(stateCtx).toContain('Calendar today (1)');
    expect(stateCtx).toContain('Team standup');
  });

  it('includes reminders when present', async () => {
    vi.mocked(getRemindersForToday).mockReturnValue([
      { id: 1, message: 'Call dentist', remind_at: '2026-03-30T14:00:00', recurring: null, status: 'active', created_at: '' },
    ] as any);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('Reminders');

    const stateCtx = mockCallDomain.mock.calls[0][3] as string;
    expect(stateCtx).toContain('Reminders today');
    expect(stateCtx).toContain('Call dentist');
  });

  it('gracefully handles API errors without crashing', async () => {
    vi.mocked(isOutlookTodoConfigured).mockReturnValue(true);
    vi.mocked(getAllPendingTasks).mockRejectedValue(new Error('API timeout'));
    vi.mocked(isAnyCalendarConfigured).mockReturnValue(true);
    vi.mocked(getEvents).mockRejectedValue(new Error('Token expired'));

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);

    // Should not throw — all external calls have .catch() guards
    const result = await handleSecretary('Overview');
    expect(result.text).toBe('OK');
  });
});
