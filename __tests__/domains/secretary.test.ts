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

vi.mock('../../src/skills/registry', () => ({
  isSubmoduleEnabled: vi.fn().mockReturnValue(true),
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
import { isGarminConfigured, getActivitiesByDate, getBodyBatteryEvents } from '../../src/services/garmin';
import { getSharedMemorySummary } from '../../src/state/shared-memory';

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

  // ─── Bug P0: buildStateContext must stay compact (<500 tokens ≈ <2000 chars) ───
  // When all data sources are active with realistic data, the context was
  // previously 800+ tokens due to verbose Garmin per-activity breakdowns,
  // causing Claude to hallucinate status briefings instead of answering questions.

  it('stays under 2000 characters even with all data sources active (Bug P0)', async () => {
    // Enable ALL data sources with realistic volumes
    vi.mocked(isOutlookTodoConfigured).mockReturnValue(true);
    vi.mocked(getAllPendingTasks).mockResolvedValue({
      success: true,
      data: [
        { id: 't1', listId: 'l1', listName: 'Work', title: 'Deploy v5', importance: 'high', status: 'notStarted', dueDateTime: '2026-03-29T09:00:00', isReminderOn: false, createdDateTime: '2026-03-28' },
        { id: 't2', listId: 'l1', listName: 'Work', title: 'Code review', importance: 'normal', status: 'notStarted', dueDateTime: '2026-03-30T09:00:00', isReminderOn: false, createdDateTime: '2026-03-28' },
        { id: 't3', listId: 'l2', listName: 'Personal', title: 'Buy groceries', importance: 'low', status: 'notStarted', dueDateTime: '2026-03-30T18:00:00', isReminderOn: false, createdDateTime: '2026-03-28' },
        { id: 't4', listId: 'l3', listName: 'Content', title: 'Record video', importance: 'high', status: 'notStarted', dueDateTime: '2026-03-31T10:00:00', isReminderOn: false, createdDateTime: '2026-03-28' },
        { id: 't5', listId: 'l3', listName: 'Content', title: 'Edit thumbnail', importance: 'normal', status: 'notStarted', dueDateTime: '2026-04-01T10:00:00', isReminderOn: false, createdDateTime: '2026-03-28' },
      ],
    } as any);

    vi.mocked(isAnyCalendarConfigured).mockReturnValue(true);
    vi.mocked(getEvents).mockResolvedValue([
      { summary: 'Team standup', start: '2026-03-30T09:00:00', end: '2026-03-30T09:30:00' },
      { summary: 'Client call', start: '2026-03-30T11:00:00', end: '2026-03-30T12:00:00' },
      { summary: 'Gym session', start: '2026-03-30T17:00:00', end: '2026-03-30T18:30:00' },
    ] as any);

    vi.mocked(isOutlookMailConfigured).mockReturnValue(true);
    vi.mocked(getUnreadCount).mockResolvedValue(12);

    vi.mocked(getRemindersForToday).mockReturnValue([
      { id: 1, message: 'Call dentist', remind_at: '2026-03-30T14:00:00', recurring: null, status: 'active', created_at: '' },
      { id: 2, message: 'Submit tax return', remind_at: '2026-03-30T16:00:00', recurring: null, status: 'active', created_at: '' },
    ] as any);

    // Garmin: 3 days of activities with realistic volumes (the main source of bloat)
    vi.mocked(isGarminConfigured).mockReturnValue(true);
    vi.mocked(getActivitiesByDate).mockResolvedValue([
      { activityId: 1, activityName: 'Morning Run', activityType: { typeKey: 'running' }, startTimeLocal: '2026-03-30T07:00:00', duration: 2700, distance: 5000, averageHR: 145, calories: 350 },
      { activityId: 2, activityName: 'Strength Training Upper Body', activityType: { typeKey: 'strength_training' }, startTimeLocal: '2026-03-30T17:00:00', duration: 3600, averageHR: 120, calories: 280 },
      { activityId: 3, activityName: 'Easy Recovery Run', activityType: { typeKey: 'running' }, startTimeLocal: '2026-03-29T07:30:00', duration: 1800, distance: 3000, averageHR: 135, calories: 220 },
      { activityId: 4, activityName: 'Long Endurance Cycling Session', activityType: { typeKey: 'cycling' }, startTimeLocal: '2026-03-29T16:00:00', duration: 5400, distance: 30000, averageHR: 140, calories: 600 },
      { activityId: 5, activityName: 'Strength Training Lower Body', activityType: { typeKey: 'strength_training' }, startTimeLocal: '2026-03-29T18:00:00', duration: 3000, averageHR: 125, calories: 300 },
      { activityId: 6, activityName: 'Morning Yoga Flow', activityType: { typeKey: 'yoga' }, startTimeLocal: '2026-03-28T08:00:00', duration: 2400, calories: 150 },
      { activityId: 7, activityName: 'Tempo Run with Intervals', activityType: { typeKey: 'running' }, startTimeLocal: '2026-03-28T16:00:00', duration: 3300, distance: 8000, averageHR: 160, calories: 520 },
      { activityId: 8, activityName: 'Evening Swim Open Water', activityType: { typeKey: 'open_water_swimming' }, startTimeLocal: '2026-03-28T18:00:00', duration: 2700, distance: 1500, averageHR: 130, calories: 350 },
    ] as any);
    vi.mocked(getBodyBatteryEvents).mockResolvedValue({
      bodyBatteryValuesArray: [[1711800000000, 72]],
      bodyBatteryChargedValue: 45,
      bodyBatteryDrainedValue: 38,
    });

    vi.mocked(getSharedMemorySummary).mockReturnValue('[Shared] marathon_date: April 15 | rest_day: false');

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('What is 2+2?');

    const stateCtx = mockCallDomain.mock.calls[0][3] as string;

    // Bug P0 fix: context must stay under 2000 chars (~500 tokens)
    // to prevent Claude from hallucinating status briefings
    expect(stateCtx.length).toBeLessThan(2000);

    // Must still contain essential info (just compact)
    expect(stateCtx).toContain('To Do:');
    expect(stateCtx).toContain('Calendar today');
    expect(stateCtx).toContain('Outlook:');
  });

  it('Garmin summary uses compact format, not per-activity breakdown', async () => {
    vi.mocked(isGarminConfigured).mockReturnValue(true);
    vi.mocked(getActivitiesByDate).mockResolvedValue([
      { activityId: 1, activityName: 'Morning Run', activityType: { typeKey: 'running' }, startTimeLocal: '2026-03-30T07:00:00', duration: 2700, distance: 5000, averageHR: 145, calories: 350 },
      { activityId: 2, activityName: 'Strength', activityType: { typeKey: 'strength_training' }, startTimeLocal: '2026-03-29T17:00:00', duration: 3600, averageHR: 120, calories: 280 },
    ] as any);
    vi.mocked(getBodyBatteryEvents).mockResolvedValue({
      bodyBatteryValuesArray: [[1711800000000, 65]],
    });

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('How am I doing?');

    const stateCtx = mockCallDomain.mock.calls[0][3] as string;

    // Should NOT contain per-activity details (the verbose format)
    expect(stateCtx).not.toMatch(/avgHR:\d+/);
    expect(stateCtx).not.toMatch(/\d+cal/);
    // Should contain compact summary
    expect(stateCtx).toContain('Garmin');
  });
});
