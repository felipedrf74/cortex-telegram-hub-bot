// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for Layer 2 (smart context selection) in src/domains/secretary.ts.
 *
 * Strategy: tests are integration-style — call handleSecretary() with all
 * data sources mocked, then verify which mocks were called for each message
 * intent. This is the most accurate way to test the lazy-loading behavior
 * without exporting internal functions.
 *
 * Layer 2 contracts under test:
 *   - "show my tasks" → fetches tasks ONLY (no calendar/email/garmin)
 *   - "what's my week" → fetches calendar ONLY
 *   - "send email to John" → fetches email ONLY
 *   - "ok" (ambiguous) → fetches everything (safety net)
 *   - Cache shape: switching from "tasks" to "calendar" RE-fetches
 *     instead of returning stale partial data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (set up BEFORE imports) ──────────────────────────────────

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: vi.fn(),
  hasConnectedCalendarForUser: vi.fn(() => true),
  isAnyCalendarConfigured: vi.fn(() => true),
}));
vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => true),
  getAllPendingTasks: vi.fn(),
  getDefaultList: vi.fn(),
  createTask: vi.fn(),
}));
vi.mock('../../src/services/outlook-mail', () => ({
  getUnreadCount: vi.fn(),
  getUnreadCountForUser: vi.fn(),
  isOutlookMailConfigured: vi.fn(() => true),
  isOutlookMailConfiguredForUser: vi.fn(() => true),
}));
vi.mock('../../src/services/garmin', () => ({
  isGarminConfiguredForUser: vi.fn(() => true),
  getActivitiesByDateForUser: vi.fn(),
  getBodyBatteryEventsForUser: vi.fn(),
}));
vi.mock('../../src/services/unified-mail-pressure', () => ({
  isAnyMailConfiguredForUser: vi.fn(() => true),
  getUnreadMailSummaryForUser: vi.fn(),
}));
vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: vi.fn(),
}));
vi.mock('../../src/services/shared-decision-context', () => ({
  buildSharedDecisionContext: vi.fn(() => Promise.resolve('')),
  buildSharedDecisionContracts: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../src/state/reminders', () => ({
  getRemindersForToday: vi.fn(() => []),
  getActiveReminders: vi.fn(() => []),
  setReminder: vi.fn(),
}));
vi.mock('../../src/state/conversation', () => ({
  getConversationHistory: vi.fn(() => []),
  addToConversation: vi.fn(),
}));
vi.mock('../../src/state/shared-memory', () => ({
  getSharedMemorySummary: vi.fn(() => ''),
  getSharedMemory: vi.fn(() => []),
  getSharedMemoryByScope: vi.fn(() => ({ userPrivate: [], tenantShared: [] })),
}));
vi.mock('../../src/services/anthropic', () => ({
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
}));
const mockProviderCall = vi.fn();
const mockProviderContinue = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockEnsureActiveProvider = vi.fn();
vi.mock('../../src/services/provider-registry', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  ensureActiveProvider: (...args: unknown[]) => mockEnsureActiveProvider(...args),
}));
vi.mock('../../src/services/tool-executor', () => ({
  executeToolCall: vi.fn(),
}));
vi.mock('../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: vi.fn(),
}));
vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: secretary path uses the strict by-id helpers post-audit.
  getUserLanguage: vi.fn(() => 'en-US'),
  getUserLanguageById: vi.fn(() => 'en-US'),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
  getPreferredDisplayName: vi.fn(() => 'Test User'),
  getPreferredDisplayNameById: vi.fn(() => 'Test User'),
}));
vi.mock('../../src/skills/registry', () => ({
  isSubmoduleEnabled: vi.fn(() => true),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks
import { handleSecretary, _resetStateContextCacheForTesting } from '../../src/domains/secretary';
import * as calendar from '../../src/services/unified-calendar';
import * as todo from '../../src/services/microsoft-todo';
import * as mailPressure from '../../src/services/unified-mail-pressure';
import * as garmin from '../../src/services/garmin';
import * as anthropic from '../../src/services/anthropic';
import * as taskRouter from '../../src/services/task-store/task-router';
import * as dailyBrief from '../../src/services/daily-brief-orchestrator';
import { resetFastpathMetrics } from '../../src/services/secretary-fastpath';

const UID = 99;

beforeEach(() => {
  vi.clearAllMocks();
  resetFastpathMetrics();
  // Layer 2 cache is module-state — must reset between tests so a previous
  // test's cached value doesn't satisfy this test's expected fetches.
  _resetStateContextCacheForTesting();
  mockProviderCall.mockReset();
  mockProviderContinue.mockReset();
  mockGetActiveProvider.mockReset();
  mockEnsureActiveProvider.mockReset();

  // Default fixtures so the AI path doesn't error out
  vi.mocked(calendar.getEvents).mockResolvedValue([]);
  vi.mocked(calendar.hasConnectedCalendarForUser).mockReturnValue(true);
  vi.mocked(todo.getAllPendingTasks).mockResolvedValue({ success: true, data: [] });
  vi.mocked(mailPressure.isAnyMailConfiguredForUser).mockReturnValue(true);
  vi.mocked(taskRouter.getTaskProviderForUser).mockReturnValue({
    getAllPendingTasks: vi.mocked(todo.getAllPendingTasks),
  } as unknown as ReturnType<typeof taskRouter.getTaskProviderForUser>);
  vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
    configuredProviders: ['outlook'],
    totalUnread: 0,
    outlookUnread: 0,
    gmailUnread: null,
  });
  vi.mocked(garmin.getActivitiesByDateForUser).mockResolvedValue([]);
  vi.mocked(garmin.getBodyBatteryEventsForUser).mockResolvedValue(null);
  vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
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
      },
    },
  } as any);

  // Stub callDomain to return an empty (non-tool-loop) response
  vi.mocked(anthropic.callDomain).mockResolvedValue({
    text: 'AI response',
    toolCalls: [],
    stopReason: 'end_turn',
  });
  mockProviderCall.mockResolvedValue({
    text: 'AI response',
    toolCalls: [],
    stopReason: 'end_turn',
  });
  const provider = {
    name: 'test-provider',
    callDomain: (...args: unknown[]) => mockProviderCall(...args),
    continueWithToolResults: (...args: unknown[]) => mockProviderContinue(...args),
    classify: vi.fn(),
  };
  mockGetActiveProvider.mockReturnValue(provider);
  mockEnsureActiveProvider.mockReturnValue(provider);
});

// ════════════════════════════════════════════════════════════════════
// Layer 2: smart context lazy-loading
// ════════════════════════════════════════════════════════════════════

describe('Layer 2: smart context — lazy data fetching', () => {
  it('"show my tasks" → fetches tasks but NOT calendar/email/garmin', async () => {
    // Use a non-fastpath phrasing of the same intent so the test exercises
    // the AI path (where Layer 2 actually fires). "show my tasks for the
    // project" doesn't match the fastpath show_tasks regex.
    await handleSecretary('show me all my tasks for the marathon project', UID);

    expect(todo.getAllPendingTasks).toHaveBeenCalled();
    expect(calendar.getEvents).not.toHaveBeenCalled();
    expect(mailPressure.getUnreadMailSummaryForUser).not.toHaveBeenCalled();
    expect(garmin.getActivitiesByDateForUser).not.toHaveBeenCalled();
    expect(garmin.getBodyBatteryEventsForUser).not.toHaveBeenCalled();
  });

  it('"plan my Tuesday" → fetches calendar (and reminders, paired with calendar)', async () => {
    await handleSecretary('plan my Tuesday around the deadlines', UID);

    expect(calendar.getEvents).toHaveBeenCalled();
    // "deadlines" doesn't trigger task keyword, "Tuesday" triggers calendar
    expect(mailPressure.getUnreadMailSummaryForUser).not.toHaveBeenCalled();
    expect(garmin.getActivitiesByDateForUser).not.toHaveBeenCalled();
    // Tasks should NOT be fetched — no task keywords
    expect(todo.getAllPendingTasks).not.toHaveBeenCalled();
  });

  it('"send email to John about the project" → fetches email AND calendar (meeting cross-link)', async () => {
    await handleSecretary('send an email to John about the project meeting next week', UID);

    expect(mailPressure.getUnreadMailSummaryForUser).toHaveBeenCalled();
    expect(calendar.getEvents).toHaveBeenCalled(); // "meeting" pulls in calendar
    expect(todo.getAllPendingTasks).not.toHaveBeenCalled();
    expect(garmin.getActivitiesByDateForUser).not.toHaveBeenCalled();
  });

  it('"how was my training yesterday" → fetches garmin only', async () => {
    await handleSecretary('how was my training yesterday', UID);

    expect(garmin.getActivitiesByDateForUser).toHaveBeenCalledWith(UID, expect.any(String), expect.any(String));
    expect(garmin.getBodyBatteryEventsForUser).toHaveBeenCalledWith(UID, expect.any(String));
    expect(todo.getAllPendingTasks).not.toHaveBeenCalled();
    expect(mailPressure.getUnreadMailSummaryForUser).not.toHaveBeenCalled();
  });

  it('keeps Garmin reads scoped to the requesting user across sequential users', async () => {
    await handleSecretary('how was my training yesterday', 11);
    await handleSecretary('how was my training yesterday', 22);

    expect(garmin.getActivitiesByDateForUser).toHaveBeenNthCalledWith(1, 11, expect.any(String), expect.any(String));
    expect(garmin.getActivitiesByDateForUser).toHaveBeenNthCalledWith(2, 22, expect.any(String), expect.any(String));
    expect(garmin.getBodyBatteryEventsForUser).toHaveBeenNthCalledWith(1, 11, expect.any(String));
    expect(garmin.getBodyBatteryEventsForUser).toHaveBeenNthCalledWith(2, 22, expect.any(String));
  });

  it('ambiguous short follow-up → fetches EVERYTHING (safety net)', async () => {
    await handleSecretary('ok go ahead', UID);

    expect(todo.getAllPendingTasks).toHaveBeenCalled();
    expect(calendar.getEvents).toHaveBeenCalled();
    expect(mailPressure.getUnreadMailSummaryForUser).toHaveBeenCalled();
    expect(garmin.getActivitiesByDateForUser).toHaveBeenCalled();
  });

  it('long freeform with no domain keywords → fetches EVERYTHING (safety net)', async () => {
    await handleSecretary('what do you think about my situation overall', UID);

    expect(todo.getAllPendingTasks).toHaveBeenCalled();
    expect(calendar.getEvents).toHaveBeenCalled();
    expect(mailPressure.getUnreadMailSummaryForUser).toHaveBeenCalled();
    expect(garmin.getActivitiesByDateForUser).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// Layer 4 + 5: Adaptive model + history reduction (integration)
// ════════════════════════════════════════════════════════════════════
//
// These tests verify that handleSecretary forwards the right currentMessage
// down to the routing provider, which is what Layer 4 (model selection) and Layer 5
// (history reduction) need to make their per-call decisions. The actual
// model-string and history-slice logic is unit-tested in
// secretary-tools.test.ts (secretaryNeedsSonnet) and exercised here as a
// flow test against the mocked provider callDomain.

describe('Layer 4+5: callDomain forwarding', () => {
  it('provider callDomain receives the original currentMessage so it can pick model + history slice', async () => {
    await handleSecretary('show me my pending tasks for the project', UID);

    expect(mockProviderCall).toHaveBeenCalledTimes(1);
    const args = mockProviderCall.mock.calls[0];
    // Signature: callDomain(domain, history, currentMessage, stateContext, ...)
    expect(args[0]).toBe('secretary');
    expect(args[2]).toBe('show me my pending tasks for the project');
  });

  it('complex query is forwarded with the same shape (Sonnet path)', async () => {
    await handleSecretary('plan my week considering the marathon training', UID);
    expect(mockProviderCall).toHaveBeenCalledTimes(1);
    const args = mockProviderCall.mock.calls[0];
    expect(args[2]).toBe('plan my week considering the marathon training');
  });
});

// ════════════════════════════════════════════════════════════════════
// Layer 2: cache shape key prevents stale partial data
// ════════════════════════════════════════════════════════════════════

describe('Layer 2: cache shape invalidation', () => {
  it('switching from tasks-only to calendar-only re-fetches (no stale partial data)', async () => {
    // First call: only tasks
    await handleSecretary('show me all my tasks for the project', UID);
    expect(todo.getAllPendingTasks).toHaveBeenCalledTimes(1);
    expect(calendar.getEvents).not.toHaveBeenCalled();

    // Second call: only calendar — should NOT hit the cache (different shape)
    // and should re-fetch calendar (but not tasks again, since the second
    // intent doesn't need tasks)
    await handleSecretary('show me my agenda for tuesday', UID);
    expect(calendar.getEvents).toHaveBeenCalledTimes(1);
  });

  it('same shape within TTL hits the cache (no duplicate fetches)', async () => {
    await handleSecretary('show me all my tasks for the project', UID);
    expect(todo.getAllPendingTasks).toHaveBeenCalledTimes(1);

    // Second call with the same intent — should re-use cached result
    await handleSecretary('show me my pending tasks again', UID);
    // Still 1 — cache hit prevented re-fetch
    expect(todo.getAllPendingTasks).toHaveBeenCalledTimes(1);
  });
});
