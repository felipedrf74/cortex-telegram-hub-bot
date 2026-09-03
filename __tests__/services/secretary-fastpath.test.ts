// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for src/services/secretary-fastpath.ts (Layer 1 of TASK-17).
 *
 * Strategy:
 *   - Mock all downstream services (calendar/todo/email/reminders) so each
 *     test is hermetic and runs in milliseconds.
 *   - Verify pattern matching for both PT-BR and EN phrasings.
 *   - Verify handlers return identical Telegram-HTML structure to what the
 *     AI would produce — empty-state, success, partial-failure all covered.
 *   - Verify graceful degradation: handler throws → matched: false (so the
 *     caller can fall through to the AI path).
 *   - Verify sub-skill gating: tasks pattern is skipped when isSubmoduleEnabled
 *     returns false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (must be defined BEFORE the import that uses them) ───────

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: vi.fn(),
  getEvents: vi.fn(),
  getEventsWithDiagnostics: vi.fn(),
  getEventsForSources: vi.fn(),
  hasConnectedCalendarForUser: vi.fn(() => true),
  hasWritableCalendarForUser: vi.fn(() => true),
}));

vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => true),
}));

const mockGetTaskProviderForUser = vi.fn();
const mockTaskGetAllPendingTasks = vi.fn();
const mockTaskGetDefaultList = vi.fn();
const mockTaskCreateTask = vi.fn();
vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  getUnreadCountForUser: vi.fn(),
  isOutlookMailConfiguredForUser: vi.fn(() => true),
}));
vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: vi.fn(),
  isAnyMailConfiguredForUser: vi.fn(() => true),
}));
vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: vi.fn(),
}));
vi.mock('../../src/services/weekly-plan-orchestrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/weekly-plan-orchestrator')>(
    '../../src/services/weekly-plan-orchestrator',
  )),
  composeWeeklyPlan: vi.fn(),
}));
vi.mock('../../src/services/decision-center', () => ({
  getDecisionSummary: vi.fn(() => ({
    openCount: 1,
    urgentCount: 0,
    todayCount: 1,
    handledTodayCount: 2,
    topDecisionTitle: 'Schedule decision',
    topDecisionSourceSkill: 'secretary',
    topDecisionUrgency: 'today',
    topDecisionWhy: 'A focus block moved.',
    topSuggestion: null,
    ctaLabel: '1 Decision',
    badgeCount: 1,
    gamification: null,
    previewItems: [{
      decisionId: 'dc_1',
      safePreviewTitle: 'Schedule decision',
      title: 'Schedule decision',
      recommendedActionLabel: 'Accept',
      whySummary: 'A focus block moved.',
    }],
  })),
  listHandledByNexusItems: vi.fn(() => [{
    itemId: 'handled_1',
    title: 'Calendar sync retried',
    actionTaken: 'retry_calendar_sync',
    whyBrief: 'Safe retry with no plan mutation.',
  }]),
}));
vi.mock('../../src/services/report-document-store', () => ({
  getRecentReports: vi.fn(() => [{
    id: 10,
    type: 'morning_briefing',
    title: 'Morning Briefing',
    summary: 'Three decisions are clear.',
    createdAt: '2026-05-19T08:00:00.000Z',
  }]),
  getLatestByType: vi.fn(() => ({
    id: 10,
    type: 'morning_briefing',
    title: 'Morning Briefing',
    summary: 'Three decisions are clear.',
    createdAt: '2026-05-19T08:00:00.000Z',
  })),
}));

vi.mock('../../src/state/reminders', () => ({
  getRemindersForToday: vi.fn(() => []),
  setReminder: vi.fn(),
}));

vi.mock('../../src/skills/registry', () => ({
  isSubmoduleEnabled: vi.fn(() => true),
}));

// Mock user-service so tests can control per-user language without
// seeding a real SQLite user row. Default returns 'pt-BR' so every
// existing test that doesn't override keeps its previous behavior.
// Bilingual tests below override `getUserLanguage` via `vi.mocked`.
vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: vi.fn(() => 'pt-BR'),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  setUserLanguage: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidateCalendarCaches: vi.fn(),
}));

// Import AFTER mocks so the module picks them up
import {
  tryFastpath,
  getFastpathPatterns,
  getFastpathMetrics,
  resetFastpathMetrics,
} from '../../src/services/secretary-fastpath';
import * as calendar from '../../src/services/unified-calendar';
import * as mailPressure from '../../src/services/unified-mail-pressure';
import * as reminders from '../../src/state/reminders';
import * as registry from '../../src/skills/registry';
import * as dailyBrief from '../../src/services/daily-brief-orchestrator';
import * as weeklyPlan from '../../src/services/weekly-plan-orchestrator';
import * as cacheCoherence from '../../src/services/cache-coherence-registry';
import * as decisionCenter from '../../src/services/decision-center';

const UID = 42;

// ─── Setup helpers ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetFastpathMetrics();
  // Default everything to "configured + sub-skill enabled"
  vi.mocked(calendar.hasConnectedCalendarForUser).mockReturnValue(true);
  vi.mocked(calendar.hasWritableCalendarForUser).mockReturnValue(true);
  vi.mocked(mailPressure.isAnyMailConfiguredForUser).mockReturnValue(true);
  vi.mocked(registry.isSubmoduleEnabled).mockReturnValue(true);
  // Default empty fixtures
  vi.mocked(calendar.createEvent).mockResolvedValue({
    id: 'evt-1',
    summary: 'Created event',
    title: 'Created event',
    start: '2026-05-16T09:00:00.000+01:00',
    end: '2026-05-16T13:00:00.000+01:00',
    source: 'outlook',
  } as any);
  vi.mocked(calendar.getEventsForSources).mockResolvedValue([{
    id: 'evt-1',
    summary: 'Created event',
    title: 'Created event',
    start: '2026-05-16T09:00:00.000+01:00',
    end: '2026-05-16T13:00:00.000+01:00',
    source: 'outlook',
  } as any]);
  vi.mocked(calendar.getEvents).mockResolvedValue([]);
  vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
    events: [],
    status: 'ready',
    warningCodes: [],
    warnings: [],
    sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
  });
  mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
  mockTaskGetDefaultList.mockReset();
  mockTaskCreateTask.mockReset();
  mockGetTaskProviderForUser.mockReturnValue({
    getAllPendingTasks: mockTaskGetAllPendingTasks,
    getDefaultList: mockTaskGetDefaultList,
    createTask: mockTaskCreateTask,
  });
  vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
    configuredProviders: ['outlook'],
    totalUnread: 0,
    outlookUnread: 0,
    gmailUnread: null,
  });
  vi.mocked(reminders.getRemindersForToday).mockReturnValue([]);
  vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
    warningCodes: [],
    sourceHealth: {
      calendar: { status: 'ready', warningCodes: [], warnings: [] },
      tasks: { status: 'ready', warningCodes: [], warnings: [] },
      mail: { status: 'ready', warningCodes: [], warnings: [] },
      focus: { status: 'ready', warningCodes: [], warnings: [] },
      training: { status: 'ready', warningCodes: [], warnings: [] },
      cooking: { status: 'ready', warningCodes: [], warnings: [] },
      content: { status: 'ready', warningCodes: [], warnings: [] },
      finance: { status: 'ready', warningCodes: [], warnings: [] },
      decision_center: { status: 'ready', warningCodes: [], warnings: [] },
    },
    coordination: {
      topPriority: null,
      executionOrder: [],
      watchouts: [],
      handoffs: [],
    },
    day: {
      secretary: {
        priorityNote: null,
        sequence: [],
        tradeoffNote: null,
        pendingTasks: 0,
        overdueTasks: 0,
        calendarEventCount: 0,
        mailUnreadTotal: 0,
      },
    },
  } as any);
  vi.mocked(weeklyPlan.composeWeeklyPlan).mockResolvedValue({
    sourceHealth: {
      calendar: { status: 'ready', warningCodes: [], warnings: [] },
    },
    days: [],
  } as any);
});

// ════════════════════════════════════════════════════════════════════
// Pattern matching
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / pattern matching', () => {
  it('rejects a tenant mismatch before metrics or source reads', async () => {
    const metricsBefore = getFastpathMetrics();

    await expect(tryFastpath(UID, "what's my day?", 'en-US', UID + 1))
      .rejects.toMatchObject({ code: 'TENANT_SCOPE_MISMATCH' });

    expect(getFastpathMetrics()).toEqual(metricsBefore);
    expect(calendar.getEventsWithDiagnostics).not.toHaveBeenCalled();
    expect(mockGetTaskProviderForUser).not.toHaveBeenCalled();
  });

  it('exposes registered patterns including Decision Center and reports', () => {
    const patterns = getFastpathPatterns();
    expect(patterns).toEqual(
      expect.arrayContaining([
        'day_overview',
        'status_overview',
        'create_calendar_event',
        'daily_priority',
        'week_overview',
        'show_tasks',
        'unread_emails',
        'overdue_tasks',
        'set_reminder',
        'quick_add_task',
        'decision_center_summary',
        'handled_by_nexus_summary',
        'latest_report',
      ]),
    );
    expect(patterns).toHaveLength(13);
  });

  it.each([
    ["what's my day?", 'day_overview'],
    ['what is my day', 'day_overview'],
    ['What do I need to do today?', 'day_overview'],
    ['o que tenho hoje', 'day_overview'],
    ['/day', 'day_overview'],
    ['today', 'day_overview'],
    ['hoje', 'day_overview'],
    ['mostra meu dia', 'day_overview'],
    ['/status', 'status_overview'],
    ['plan status', 'status_overview'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it('routes calendar write phrases to the planner instead of fastpath provider writes', async () => {
    const result = await tryFastpath(
      UID,
      'Colocar no calendario evento no proximo sabado, 16/5, das 9h as 13h. Volei Lucas, convide o felipedrf@hotmail.com',
    );
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:calendar');
    expect(calendar.createEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["what's my week?", 'week_overview'],
    ['esta semana', 'week_overview'],
    ['/week', 'week_overview'],
    ['mostra minha semana', 'week_overview'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ["what's my priority today?", 'daily_priority'],
    ['what should i do first today?', 'daily_priority'],
    ['what should I focus on now?', 'daily_priority'],
    ['o que faço primeiro', 'daily_priority'],
    ['qual a prioridade hoje?', 'daily_priority'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['what needs my decision?', 'decision_center_summary'],
    ['decision center', 'decision_center_summary'],
    ['o que precisa da minha decisão?', 'decision_center_summary'],
    ['what did Nexus handle?', 'handled_by_nexus_summary'],
    ['handled by Nexus', 'handled_by_nexus_summary'],
    ['latest report', 'latest_report'],
    ['morning briefing', 'latest_report'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['show my tasks', 'show_tasks'],
    ['list todos', 'show_tasks'],
    ['mostra minhas tarefas', 'show_tasks'],
    ['/tasks', 'show_tasks'],
    ['/todo', 'show_tasks'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['unread emails', 'unread_emails'],
    ['quantos não lidos', 'unread_emails'],
    ['quantos emails não lidos?', 'unread_emails'],
    ['inbox', 'unread_emails'],
    ['check mail', 'unread_emails'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['overdue', 'overdue_tasks'],
    ['atrasadas', 'overdue_tasks'],
    ['tarefas atrasadas', 'overdue_tasks'],
    ['/overdue', 'overdue_tasks'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['remind me at 15:30 call dentist', 'set_reminder'],
    ['lembra às 15:30 ligar dentista', 'set_reminder'],
    ['avisa 9:00 reunião com Pedro', 'set_reminder'],
    ['reminder at 8:00 take vitamins', 'set_reminder'],
  ])('routes "%s" → planner instead of %s fastpath', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe(`write_action_routed_to_planner:${expectedPattern === 'set_reminder' ? 'reminders' : expectedPattern}`);
    expect(reminders.setReminder).not.toHaveBeenCalled();
  });

  it.each([
    ['add task: buy milk', 'quick_add_task'],
    ['nova tarefa: comprar leite', 'quick_add_task'],
    ['adicionar tarefa: revisar PR', 'quick_add_task'],
  ])('routes "%s" → planner instead of %s fastpath', async (input, expectedPattern) => {
    mockTaskGetDefaultList.mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    mockTaskCreateTask.mockResolvedValue({ success: true, data: { id: 'T1', title: 'x' } } as any);
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe(`write_action_routed_to_planner:${expectedPattern === 'quick_add_task' ? 'tasks' : expectedPattern}`);
    expect(mockTaskCreateTask).not.toHaveBeenCalled();
  });

  it.each([
    'plan my week considering my training and content schedule',
    'should I reschedule the meeting with Pedro?',
    'help me decide between two options for the gym',
    'random freeform question that needs reasoning',
    '',
  ])('does NOT match "%s" (needs AI)', async (input) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// day_overview handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / day_overview handler', () => {
  it('answers the natural-language day-planning question with explicit calendar and priority framing', async () => {
    const result = await tryFastpath(UID, 'What do I need to do today?', 'en-US');

    expect(result.matched).toBe(true);
    expect(result.response?.text.toLowerCase()).toContain('today');
    expect(result.response?.text.toLowerCase()).toContain('calendar');
    expect(result.response?.text.toLowerCase()).toContain('priority');
  });

  it('returns formatted HTML with calendar events', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
      events: [{
        id: '1',
        summary: 'Standup',
        start: '2026-04-07T09:00:00.000Z',
        end: '2026-04-07T09:30:00.000Z',
        provider: 'google',
      } as any, {
        id: '2',
        summary: 'Gym session',
        start: '2026-04-07T18:00:00.000Z',
        end: '2026-04-07T19:00:00.000Z',
        provider: 'google',
      } as any],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });

    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response).toBeDefined();
    expect(result.response!.text).toContain('AGENDA:');
    expect(result.response!.text).toContain('Standup');
    expect(result.response!.text).toContain('Gym session');
    expect(result.response!.domain).toBe('secretary');
  });

  it('shows "Sem eventos hoje" when calendar is empty', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Sem eventos hoje');
  });

  it('shows pending tasks count and overdue badge', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const today = new Date().toISOString();
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Pay tax', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
        { id: 't2', title: 'Edit podcast', dueDateTime: today, listName: 'Inbox', listId: 'L1' } as any,
        { id: 't3', title: 'No date task', dueDateTime: null, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('TAREFAS:');
    expect(result.response!.text).toContain('3 pendentes');
    expect(result.response!.text).toContain('1 atrasadas');
    expect(result.response!.text).toContain('Edit podcast'); // due today
  });

  it('includes unread email count when present', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook', 'gmail'],
      totalUnread: 7,
      outlookUnread: 2,
      gmailUnread: 5,
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('E-MAILS:');
    expect(result.response!.text).toContain('7');
  });

  it('handles partial API failures gracefully', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockRejectedValue(new Error('Calendar API down'));
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [{ id: 't1', title: 'Buy groceries', dueDateTime: null, listName: 'Inbox', listId: 'L1' } as any],
    });
    const result = await tryFastpath(UID, "what's my day?");
    // Even with calendar errored out, we still get a valid response with tasks
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('TAREFAS:');
    expect(result.response!.text).toContain('Não foi possível confirmar o calendário');
    expect(result.response!.text).not.toContain('Sem eventos hoje');
  });

  it('does not render a partial calendar read as an empty agenda', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
      events: [],
      status: 'degraded',
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.'],
      sources: { configured: ['google', 'outlook'], fulfilled: ['outlook'], failed: ['google'] },
    });

    const result = await tryFastpath(UID, "what's my day?");

    expect(result.response!.text).toContain('Parte do calendário não pôde ser confirmada');
    expect(result.response!.text).not.toContain('Sem eventos hoje');
  });

  it('includes canonical Nexus agenda commitments before provider synchronization', async () => {
    vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
      sourceHealth: {
        calendar: { status: 'ready', warningCodes: [], warnings: [] },
        tasks: { status: 'ready', warningCodes: [], warnings: [] },
        training: { status: 'ready', warningCodes: [], warnings: [] },
      },
      coordination: { topPriority: null, executionOrder: [], watchouts: [], handoffs: [] },
      day: {
        secretary: {
          calendarEventCount: 1,
          priorityNote: null,
          sequence: [],
          tradeoffNote: null,
        },
      },
    } as any);

    const result = await tryFastpath(UID, "what's my day?");

    expect(result.response!.text).toContain('1 compromissos Nexus incluídos');
    expect(result.response!.text).not.toContain('Sem eventos hoje');
  });

  it('does not call a failed canonical training read a rest day', async () => {
    vi.mocked(dailyBrief.composeDailyBrief).mockRejectedValue(new Error('planning unavailable'));

    const result = await tryFastpath(UID, "what's my day?", 'en-US');

    expect(result.response!.text).toContain('Training plan could not be confirmed');
    expect(result.response!.text).not.toContain('No training planned today');
  });
});

// ════════════════════════════════════════════════════════════════════
// create_calendar_event handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / create_calendar_event handler', () => {
  it('routes a Portuguese calendar event with an attendee invite to the planner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    try {
      vi.mocked(calendar.createEvent).mockResolvedValueOnce({
        id: 'evt-volley',
        summary: 'Volei Lucas',
        start: '2026-05-16T09:00:00.000+01:00',
        end: '2026-05-16T13:00:00.000+01:00',
        source: 'outlook',
      } as any);

      const result = await tryFastpath(
        UID,
        'Colocar no calendario evento no proximo sabado, 16/5, das 9h as 13h. Volei Lucas, convide o felipedrf@hotmail.com',
        'pt-PT',
      );

      expect(result.matched).toBe(false);
      expect(result.missReason).toBe('write_action_routed_to_planner:calendar');
      expect(calendar.createEvent).not.toHaveBeenCalled();
      expect(cacheCoherence.invalidateCalendarCaches).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes calendar unavailable write phrases to the planner without provider writes', async () => {
    vi.mocked(calendar.hasWritableCalendarForUser).mockReturnValueOnce(false);

    const result = await tryFastpath(
      UID,
      'Adicionar evento no calendário amanhã das 9h às 10h Consulta',
      'pt-PT',
    );

    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:calendar');
    expect(calendar.createEvent).not.toHaveBeenCalled();
  });

  it('does not fall back directly to a connected default calendar from fastpath', async () => {
    vi.mocked(calendar.createEvent).mockReset();
    vi.mocked(calendar.createEvent)
      .mockRejectedValueOnce(new Error('google not connected'))
      .mockResolvedValueOnce({
        id: 'evt-school',
        summary: 'Atividade Escola Sunny',
        start: '2026-05-15T09:30:00.000+01:00',
        end: '2026-05-15T10:30:00.000+01:00',
        source: 'outlook',
      } as any);
    vi.mocked(calendar.getEventsForSources).mockResolvedValueOnce([{
      id: 'evt-school',
      summary: 'Atividade Escola Sunny',
      start: '2026-05-15T09:30:00.000+01:00',
      end: '2026-05-15T10:30:00.000+01:00',
      source: 'outlook',
    } as any]);

    const result = await tryFastpath(
      UID,
      'Colocar na agenda do google para o dia 15/5 das 9:30 as 10:30 Atividade Escola Sunny',
      'pt-PT',
    );

    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:calendar');
    expect(calendar.createEvent).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// show_tasks handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / show_tasks handler', () => {
  it('returns "Sem tarefas pendentes" on empty list', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Sem tarefas pendentes');
  });

  it('groups tasks by list and shows count', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Buy milk', dueDateTime: null, listName: 'Personal', listId: 'L1' } as any,
        { id: 't2', title: 'Review PR', dueDateTime: null, listName: 'Work', listId: 'L2' } as any,
        { id: 't3', title: 'Call dentist', dueDateTime: null, listName: 'Personal', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Tarefas Pendentes</b> (3)');
    expect(result.response!.text).toContain('Personal</b> (2)');
    expect(result.response!.text).toContain('Work</b> (1)');
    expect(result.response!.text).toContain('Buy milk');
    expect(result.response!.text).toContain('Review PR');
  });

  it('returns error message on API failure', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: false,
      data: [],
      error: 'Graph API rate limited',
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Erro ao buscar tarefas');
  });
});

// ════════════════════════════════════════════════════════════════════
// unread_emails handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / unread_emails handler', () => {
  it('returns count when > 0', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook', 'gmail'],
      totalUnread: 12,
      outlookUnread: 7,
      gmailUnread: 5,
    });
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('<b>12</b>');
  });

  it('returns "Caixa de entrada limpa" when 0', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['gmail'],
      totalUnread: 0,
      outlookUnread: null,
      gmailUnread: 0,
    });
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Caixa de entrada limpa');
  });

  it('returns config error when no mail provider is configured', async () => {
    vi.mocked(mailPressure.isAnyMailConfiguredForUser).mockReturnValue(false);
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Email não configurado');
  });

  it('does not call a partial mail-provider failure a clean inbox', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook', 'gmail'],
      totalUnread: 0,
      outlookUnread: null,
      gmailUnread: 0,
    });

    const result = await tryFastpath(UID, 'inbox', 'en-US');

    expect(result.response!.text).toContain('Mail could not be confirmed');
    expect(result.response!.text).not.toContain('Inbox clean');
  });
});

describe('secretary-fastpath / daily_priority handler', () => {
  it('returns planner coordination for prioritization asks', async () => {
    vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
      coordination: {
        topPriority: 'Protect the long run before content work.',
        executionOrder: ['Long run', 'Breakfast + recovery', 'Review sponsor draft'],
        watchouts: ['Inbox pressure is elevated'],
        handoffs: ['Content should follow training'],
      },
      day: {
        secretary: {
          priorityNote: 'Protect the long run before content work.',
          sequence: ['Long run', 'Breakfast + recovery', 'Review sponsor draft'],
          tradeoffNote: 'Do not trade training for admin drift.',
        },
      },
    } as any);

    const result = await tryFastpath(UID, "what's my priority today?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('PRIORIDADE');
    expect(result.response!.text).toContain('Protect the long run before content work.');
    expect(result.response!.text).toContain('1. Long run');
    expect(result.response!.text).toContain('Inbox pressure is elevated');
  });

  it('does not return an all-clear priority when canonical source health is incomplete', async () => {
    vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
      sourceHealth: {
        calendar: {
          status: 'unavailable',
          warningCodes: ['CALENDAR_SOURCE_UNAVAILABLE'],
          warnings: ['Calendar could not be confirmed.'],
        },
      },
      coordination: {
        topPriority: null,
        executionOrder: [],
        blockers: [],
        secretaryToday: {
          summary: 'Secretary built the best available state, but the calendar still needs confirmation.',
        },
      },
      day: { secretary: { priorityNote: null, sequence: [] } },
    } as any);

    const result = await tryFastpath(UID, "what's my priority today?");
    expect(result.response!.text).toContain('calendar still needs confirmation');
    expect(result.response!.text).not.toContain('Inbox clean');
  });
});

// ════════════════════════════════════════════════════════════════════
// set_reminder handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / set_reminder handler', () => {
  it('routes "15:30" reminders to the planner without persisting', async () => {
    const result = await tryFastpath(UID, 'remind me at 15:30 call dentist');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:reminders');
    expect(reminders.setReminder).not.toHaveBeenCalled();
  });

  it('routes "3.30" reminder writes to the planner', async () => {
    const result = await tryFastpath(UID, 'lembra às 3.30 acordar');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:reminders');
  });

  it('routes invalid-time reminder write phrases to the planner', async () => {
    const result = await tryFastpath(UID, 'remind me at 25:00 invalid');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:reminders');
    expect(reminders.setReminder).not.toHaveBeenCalled();
  });

  it('does not touch reminders DB even when the write mock would fail', async () => {
    vi.mocked(reminders.setReminder).mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const result = await tryFastpath(UID, 'remind me at 10:00 test');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:reminders');
  });
});

// ════════════════════════════════════════════════════════════════════
// quick_add_task handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / quick_add_task handler', () => {
  it('routes task creation to the planner without creating a provider task', async () => {
    mockTaskGetDefaultList.mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    mockTaskCreateTask.mockResolvedValue({ success: true, data: { id: 'T1', title: 'Buy milk' } } as any);
    const result = await tryFastpath(UID, 'add task: buy milk');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:tasks');
    expect(mockTaskCreateTask).not.toHaveBeenCalled();
  });

  it('does not inspect default task lists for quick task writes', async () => {
    mockTaskGetDefaultList.mockResolvedValue(null);
    const result = await tryFastpath(UID, 'add task: buy milk');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:tasks');
    expect(mockTaskGetDefaultList).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// Decision Center / Reports handlers
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / decision and report handlers', () => {
  it('answers Decision Center summary without AI', async () => {
    const result = await tryFastpath(UID, 'what needs my decision?', 'en-US');

    expect(result.matched).toBe(true);
    expect(result.patternId).toBe('decision_center_summary');
    expect(result.response?.text).toContain('Decision Center');
    expect(result.response?.text).toContain('1 open');
    expect(result.response?.text).toContain('Schedule decision');
  });

  it('threads the canonical tenant scope into Decision Center fastpaths', async () => {
    const result = await tryFastpath(UID, 'what needs my decision?', 'en-US', UID);

    expect(result.matched).toBe(true);
    expect(vi.mocked(decisionCenter.getDecisionSummary)).toHaveBeenCalledWith(UID, UID, 3);
  });

  it('answers handled-by-Nexus history without AI', async () => {
    const result = await tryFastpath(UID, 'what did Nexus handle?', 'en-US', UID);

    expect(result.matched).toBe(true);
    expect(result.patternId).toBe('handled_by_nexus_summary');
    expect(result.response?.text).toContain('Handled by Nexus');
    expect(result.response?.text).toContain('Calendar sync retried');
    expect(vi.mocked(decisionCenter.listHandledByNexusItems)).toHaveBeenCalledWith(UID, UID, 5);
  });

  it('answers latest report without AI', async () => {
    const result = await tryFastpath(UID, 'latest report', 'en-US', UID);

    expect(result.matched).toBe(true);
    expect(result.patternId).toBe('latest_report');
    expect(result.response?.text).toContain('Latest report');
    expect(result.response?.text).toContain('Morning Briefing');
    const reportStore = await import('../../src/services/report-document-store');
    expect(vi.mocked(reportStore.getRecentReports)).toHaveBeenCalledWith(UID, {
      limit: 1,
      tenantId: UID,
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// Sub-skill gating
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / sub-skill gating', () => {
  it('skips show_tasks when tasks sub-skill is disabled', async () => {
    vi.mocked(registry.isSubmoduleEnabled).mockImplementation(
      (_d, sub) => sub !== 'tasks',
    );
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(false);
    expect(mockTaskGetAllPendingTasks).not.toHaveBeenCalled();
  });

  it('skips week_overview when calendar sub-skill is disabled', async () => {
    vi.mocked(registry.isSubmoduleEnabled).mockImplementation(
      (_d, sub) => sub !== 'calendar',
    );
    const result = await tryFastpath(UID, "what's my week?");
    expect(result.matched).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Graceful degradation
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / graceful degradation', () => {
  it('falls through to AI when handler throws unexpectedly', async () => {
    mockTaskGetAllPendingTasks.mockImplementation(() => {
      throw new Error('Unexpected sync throw');
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Metrics
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / metrics', () => {
  it('tracks attempts, hits, and per-pattern counts', async () => {
    await tryFastpath(UID, "what's my day?");
    await tryFastpath(UID, 'show my tasks');
    await tryFastpath(UID, 'plan my entire week considering training');

    const m = getFastpathMetrics();
    expect(m.totalAttempts).toBe(3);
    expect(m.totalHits).toBe(2);
    expect(m.hitRate).toBeCloseTo(2 / 3, 2);
    expect(m.hitsByPattern.day_overview).toBe(1);
    expect(m.hitsByPattern.show_tasks).toBe(1);
    expect(m.missesByReason.no_pattern).toBe(1);
  });

  it('tracks skipped subskills and handler errors as miss reasons', async () => {
    vi.mocked(registry.isSubmoduleEnabled).mockImplementation(
      (_d, sub) => sub !== 'tasks',
    );
    const gated = await tryFastpath(UID, 'show my tasks');
    expect(gated.missReason).toBe('subskill_disabled:tasks');

    vi.mocked(registry.isSubmoduleEnabled).mockReturnValue(true);
    mockTaskGetAllPendingTasks.mockImplementation(() => {
      throw new Error('Unexpected sync throw');
    });
    const failed = await tryFastpath(UID, 'show my tasks');
    expect(failed.missReason).toBe('handler_error');

    const m = getFastpathMetrics();
    expect(m.skippedBySubskill.tasks).toBe(1);
    expect(m.handlerFailuresByPattern.show_tasks).toBe(1);
    expect(m.missesByReason['subskill_disabled:tasks']).toBe(1);
    expect(m.missesByReason.handler_error).toBe(1);
  });

  it('avgLatencyMs is non-negative', async () => {
    await tryFastpath(UID, "what's my day?");
    expect(getFastpathMetrics().avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// Bilingual responses (April 2026)
//
// Every handler accepts a `lang` parameter and routes its user-facing
// copy through the COPY table. These tests cover the EN branch so
// the existing PT tests + these new EN tests together prove the
// table is complete for every key the code reads.
// ════════════════════════════════════════════════════════════════════

import * as userSvc from '../../src/services/user-service';
import { normalizeLangHeader } from '../../src/services/secretary-fastpath';

describe('secretary-fastpath / bilingual — EN', () => {
  beforeEach(() => {
    // Force EN for every test in this block. Individual tests can
    // still override via langOverride argument, but the default
    // mirrors the iOS path where setUserLanguage has already
    // written 'en-US' to the user row.
    vi.mocked(userSvc.getUserLanguage).mockReturnValue('en-US');

    // `vi.clearAllMocks()` in the outer beforeEach clears CALL
    // HISTORY but NOT `.mockImplementation` overrides. The
    // "shows error when DB write fails" test earlier in the file
    // leaves `setReminder` throwing, which would bleed into our
    // happy-path set_reminder test below. Reset it to a clean
    // no-op function explicitly.
    vi.mocked(reminders.setReminder).mockReset();
    vi.mocked(reminders.setReminder).mockImplementation(
      (() => ({ id: 1 })) as any,
    );
  });

  // ── day_overview ──
  it('day_overview returns English copy when user lang is en-US', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    // English header + empty-state copy
    expect(result.response!.text).toContain('AGENDA:');
    expect(result.response!.text).toContain('No events today');
    // Should NOT contain the Portuguese strings
    expect(result.response!.text).not.toContain('Sem eventos hoje');
  });

  it('day_overview shows English task copy', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Pay tax', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.response!.text).toContain('TASKS:');
    expect(result.response!.text).toContain('1 pending');
    expect(result.response!.text).toContain('1 overdue');
    expect(result.response!.text).not.toContain('pendentes');
  });

  it('day_overview shows English email header', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['gmail'],
      totalUnread: 7,
      outlookUnread: null,
      gmailUnread: 7,
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.response!.text).toContain('EMAILS:');
    expect(result.response!.text).toContain('7 unread');
    expect(result.response!.text).not.toContain('não lidos');
  });

  // ── week_overview ──
  it('week_overview uses English day names and WEEK header', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });
    const result = await tryFastpath(UID, "what's my week?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('WEEK');
    expect(result.response!.text).toContain('Mon');
    expect(result.response!.text).toContain('free'); // "— free" in English
    expect(result.response!.text).not.toContain('SEMANA');
    expect(result.response!.text).not.toContain('livre');
  });

  it('never labels unconfirmed calendar days as free', async () => {
    vi.mocked(calendar.getEventsWithDiagnostics).mockResolvedValue({
      events: [],
      status: 'unavailable',
      warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'],
      warnings: ['Outlook Calendar is unavailable right now.'],
      sources: { configured: ['outlook'], fulfilled: [], failed: ['outlook'] },
    });

    const result = await tryFastpath(UID, "what's my week?", 'en-US');

    expect(result.response!.text).toContain('calendar unconfirmed');
    expect(result.response!.text).not.toContain('— free');
  });

  it('builds status from the canonical daily snapshot', async () => {
    vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
      warningCodes: [],
      sourceHealth: {
        calendar: { status: 'ready', warningCodes: [], warnings: [] },
        tasks: { status: 'ready', warningCodes: [], warnings: [] },
        mail: { status: 'ready', warningCodes: [], warnings: [] },
      },
      day: {
        secretary: {
          pendingTasks: 4,
          calendarEventCount: 2,
          mailUnreadTotal: 9,
        },
      },
    } as any);
    vi.mocked(reminders.getRemindersForToday).mockReturnValue([
      { id: 1, remind_at: '2026-05-11T09:00:00.000Z', message: 'Call dentist' } as any,
    ]);

    const result = await tryFastpath(UID, '/status', 'en-US', UID);

    expect(dailyBrief.composeDailyBrief).toHaveBeenCalledWith(expect.objectContaining({
      userId: UID,
      tenantId: UID,
      language: 'en-US',
    }));
    expect(result.response!.text).toContain('Tasks: 4 pending');
    expect(result.response!.text).toContain('Agenda today: 2 commitments');
    expect(result.response!.text).toContain('Inbox: 9 unread');
    expect(result.response!.text).toContain("Today's reminders: 1");
  });

  it('does not render unavailable canonical sources as healthy zeroes', async () => {
    vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
      warningCodes: ['CALENDAR_UNAVAILABLE', 'TASKS_UNAVAILABLE', 'MAIL_UNAVAILABLE'],
      sourceHealth: {
        calendar: { status: 'unavailable', warningCodes: ['CALENDAR_UNAVAILABLE'], warnings: [] },
        tasks: { status: 'unavailable', warningCodes: ['TASKS_UNAVAILABLE'], warnings: [] },
        mail: { status: 'unavailable', warningCodes: ['MAIL_UNAVAILABLE'], warnings: [] },
      },
      day: {
        secretary: {
          pendingTasks: 0,
          calendarEventCount: 0,
          mailUnreadTotal: 0,
        },
      },
    } as any);

    const result = await tryFastpath(UID, '/status', 'en-US', UID);

    expect(result.response!.text).toContain('Tasks: unconfirmed');
    expect(result.response!.text).toContain('Agenda today: unconfirmed');
    expect(result.response!.text).toContain('Inbox: unconfirmed');
    expect(result.response!.text).not.toContain('0 commitments');
    expect(result.response!.text).toContain('sources need confirmation');
  });

  it('does not label provider-only days as free when the canonical week fails', async () => {
    vi.mocked(weeklyPlan.composeWeeklyPlan).mockRejectedValue(new Error('canonical week unavailable'));

    const result = await tryFastpath(UID, "what's my week?", 'en-US');

    expect(result.response!.text).toContain('calendar unconfirmed');
    expect(result.response!.text).not.toContain('— free');
  });

  it('includes canonical Nexus commitments in the week before provider synchronization', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
    try {
      vi.mocked(weeklyPlan.composeWeeklyPlan).mockResolvedValue({
        sourceHealth: {
          calendar: { status: 'ready', warningCodes: [], warnings: [] },
        },
        days: [{
          date: '2026-05-11',
          secretary: { calendarEventCount: 1 },
        }],
      } as any);

      const result = await tryFastpath(UID, "what's my week?", 'en-US');

      expect(result.response!.text).toContain('1 Nexus commitments included');
      expect(result.response!.text).not.toContain('Mon 11/05</b> — free');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── show_tasks ──
  it('show_tasks uses "Pending Tasks" header in English', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Buy milk', dueDateTime: null, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.response!.text).toContain('Pending Tasks');
    expect(result.response!.text).not.toContain('Tarefas Pendentes');
  });

  it('show_tasks returns English empty-state', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.response!.text).toContain('No pending tasks!');
    expect(result.response!.text).not.toContain('Sem tarefas pendentes');
  });

  // ── unread_emails ──
  it('unread_emails uses English unread line', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook'],
      totalUnread: 3,
      outlookUnread: 3,
      gmailUnread: null,
    });
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.response!.text).toContain('<b>3</b> unread emails');
    expect(result.response!.text).not.toContain('e-mails');
  });

  it('unread_emails uses English zero-state', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['gmail'],
      totalUnread: 0,
      outlookUnread: null,
      gmailUnread: 0,
    });
    const result = await tryFastpath(UID, 'inbox');
    expect(result.response!.text).toContain('Inbox clean!');
    expect(result.response!.text).not.toContain('Caixa de entrada');
  });

  it('unread_emails uses English config-missing line', async () => {
    vi.mocked(mailPressure.isAnyMailConfiguredForUser).mockReturnValue(false);
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.response!.text).toContain('Email not configured');
    expect(result.response!.text).toContain('Settings > Connections');
    expect(result.response!.text).not.toContain('/settings');
    expect(result.response!.text).not.toContain('Email não configurado');
  });

  // ── overdue_tasks ──
  it('overdue_tasks uses "Overdue Task(s)" header in English', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Pay tax', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
        { id: 't2', title: 'Review doc', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, 'overdue');
    expect(result.response!.text).toContain('2 Overdue Tasks');
    expect(result.response!.text).toContain('due:');
    expect(result.response!.text).not.toContain('Atrasada');
    expect(result.response!.text).not.toContain('prazo:');
  });

  it('overdue_tasks empty state is English', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    const result = await tryFastpath(UID, 'overdue');
    expect(result.response!.text).toContain('No overdue tasks!');
    expect(result.response!.text).not.toContain('Nenhuma tarefa');
  });

  // ── set_reminder ──
  it('set_reminder routes English write phrases to the planner', async () => {
    const result = await tryFastpath(UID, 'remind me at 10:00 take vitamins');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:reminders');
  });

  it('set_reminder invalid time still routes to the planner', async () => {
    const result = await tryFastpath(UID, 'remind me at 25:00 invalid');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:reminders');
  });

  // ── quick_add_task ──
  it('quick_add_task routes English writes to the planner', async () => {
    mockTaskGetDefaultList.mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    mockTaskCreateTask.mockResolvedValue({ success: true, data: { id: 'T1', title: 'x' } } as any);
    const result = await tryFastpath(UID, 'add task: buy milk');
    expect(result.matched).toBe(false);
    expect(result.missReason).toBe('write_action_routed_to_planner:tasks');
    expect(mockTaskCreateTask).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// Language override (explicit langOverride parameter)
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / language override', () => {
  beforeEach(() => {
    // User row says pt-BR, but the override should win.
    vi.mocked(userSvc.getUserLanguage).mockReturnValue('pt-BR');
  });

  it('langOverride=en-US produces English copy even when user row is pt-BR', async () => {
    const result = await tryFastpath(UID, "what's my day?", 'en-US');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('AGENDA:');
    expect(result.response!.text).toContain('No events today');
  });

  it('langOverride=pt-BR produces Portuguese copy even when user row is en-US', async () => {
    vi.mocked(userSvc.getUserLanguage).mockReturnValue('en-US');
    const result = await tryFastpath(UID, "what's my day?", 'pt-BR');
    expect(result.response!.text).toContain('Sem eventos hoje');
  });

  it('rejects an invalid anonymous sentinel before language or source reads', async () => {
    await expect(tryFastpath(0, "what's my day?"))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });

    expect(userSvc.getUserLanguage).not.toHaveBeenCalled();
    expect(calendar.getEventsWithDiagnostics).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// normalizeLangHeader — boundary parser
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / normalizeLangHeader', () => {
  it.each([
    ['pt-BR', 'pt-BR'],
    ['pt-br', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['pt_pt', 'pt-PT'],
    ['pt', 'pt-BR'],
    ['pt_BR', 'pt-BR'],
    ['en', 'en-US'],
    ['en-US', 'en-US'],
    ['en-GB', 'en-US'],
    ['EN', 'en-US'],
    ['es', 'en-US'],
    ['es-419', 'en-US'],
    ['es-ES', 'en-US'],
  ])('maps "%s" → %s', (input, expected) => {
    expect(normalizeLangHeader(input)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['unknown value', 'it-IT'],
  ])('falls back to pt-BR for %s', (_label, input) => {
    expect(normalizeLangHeader(input)).toBe('pt-BR');
  });

  it('accepts array values (Express passes repeated headers as arrays)', () => {
    expect(normalizeLangHeader(['en', 'pt-BR'])).toBe('en-US');
  });
});
