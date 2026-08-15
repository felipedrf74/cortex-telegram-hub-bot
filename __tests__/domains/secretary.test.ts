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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isChatShadowBaselineEligible } from '../../src/services/chat-shadow-baseline';

// ─── Mock all dependencies ──────────────────────────────────────────

vi.mock('../../src/services/anthropic', () => ({
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
}));

const mockProviderCall = vi.fn();
const mockProviderContinue = vi.fn();
const mockGetActiveProvider = vi.fn(() => null);
const mockEnsureActiveProvider = vi.fn(() => null);

vi.mock('../../src/services/provider-registry', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  ensureActiveProvider: (...args: unknown[]) => mockEnsureActiveProvider(...args),
}));

vi.mock('../../src/services/skill-inference-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/skill-inference-service')>(
    '../../src/services/skill-inference-service',
  )),
  runWithSkillInferenceAccountAdmission: (
    _input: unknown,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ) => operation(new AbortController().signal),
  isSkillInferenceAccountDeletionError: (error: unknown) => (
    Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'ACCOUNT_DELETION_IN_PROGRESS')
  ),
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
  hasConnectedCalendarForUser: vi.fn().mockReturnValue(false),
  getEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfiguredForUser: vi.fn().mockReturnValue(false),
  getUnreadCountForUser: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../src/services/unified-mail-pressure', () => ({
  isAnyMailConfiguredForUser: vi.fn().mockReturnValue(false),
  getUnreadMailSummaryForUser: vi.fn().mockResolvedValue({
    configuredProviders: [],
    totalUnread: 0,
    outlookUnread: null,
    gmailUnread: null,
  }),
}));
vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: secretary path uses the strict by-id helpers post-audit.
  getUserLanguage: vi.fn().mockReturnValue('en-US'),
  getUserLanguageById: vi.fn().mockReturnValue('en-US'),
  getUserTimezone: vi.fn().mockReturnValue('Europe/Lisbon'),
  getUserTimezoneById: vi.fn().mockReturnValue('Europe/Lisbon'),
  getPreferredDisplayName: vi.fn().mockReturnValue('Test User'),
  getPreferredDisplayNameById: vi.fn().mockReturnValue('Test User'),
}));

const mockGetTaskProviderForUser = vi.fn();
const mockTaskGetAllPendingTasks = vi.fn();
vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/services/garmin', () => ({
  isGarminConfiguredForUser: vi.fn().mockReturnValue(false),
  getActivitiesByDateForUser: vi.fn().mockResolvedValue([]),
  getBodyBatteryEventsForUser: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: vi.fn().mockResolvedValue({
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
  }),
}));
vi.mock('../../src/services/shared-decision-context', () => ({
  buildSharedDecisionContext: vi.fn().mockResolvedValue(''),
  buildSharedDecisionContracts: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/state/shared-memory', () => ({
  getSharedMemorySummary: vi.fn().mockReturnValue(''),
  getSharedMemory: vi.fn().mockReturnValue([]),
  getSharedMemoryByScope: vi.fn().mockReturnValue({ userPrivate: [], tenantShared: [] }),
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
  LOGGER_REDACTION_PATHS: [],
}));

// ─── Imports ─────────────────────────────────────────────────────────

import { handleSecretary, _resetStateContextCacheForTesting } from '../../src/domains/secretary';
import { callDomain, continueWithToolResults } from '../../src/services/anthropic';
import { addToConversation } from '../../src/state/conversation';
import { executeToolCall } from '../../src/services/tool-executor';
import { now } from '../../src/utils/date-parser';
import { hasConnectedCalendarForUser, getEvents } from '../../src/services/unified-calendar';
import { getUnreadMailSummaryForUser, isAnyMailConfiguredForUser } from '../../src/services/unified-mail-pressure';
import { getRemindersForToday } from '../../src/state/reminders';
import { isSubmoduleEnabled } from '../../src/skills/registry';
import { composeDailyBrief } from '../../src/services/daily-brief-orchestrator';
import {
  buildSharedDecisionContext,
  buildSharedDecisionContracts,
} from '../../src/services/shared-decision-context';
import { getUserLanguage, getUserTimezone } from '../../src/services/user-service';
import { getSharedMemoryByScope } from '../../src/state/shared-memory';

const mockCallDomain = vi.mocked(callDomain);
const mockContinue = vi.mocked(continueWithToolResults);
const mockExecuteTool = vi.mocked(executeToolCall);
const mockGetUserLanguage = vi.mocked(getUserLanguage);
const mockGetUserTimezone = vi.mocked(getUserTimezone);

// ─── Shared setup ────────────────────────────────────────────────────

// Secretary has a 30s state context cache. Advance Date.now past the TTL
// on each test so the cache is always expired and context is rebuilt fresh.
let fakeTime = Date.now();

beforeEach(() => {
  vi.clearAllMocks();
  _resetStateContextCacheForTesting();
  mockCallDomain.mockReset();
  mockContinue.mockReset();
  mockExecuteTool.mockReset();
  mockProviderCall.mockReset();
  mockProviderContinue.mockReset();
  mockGetActiveProvider.mockReset();
  mockEnsureActiveProvider.mockReset();
  fakeTime += 60_000; // 60s jump — well past the 30s cache TTL
  vi.spyOn(Date, 'now').mockReturnValue(fakeTime);
  process.env.ANTHROPIC_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.SECRETARY_REASONING_V1_MODE;
  mockGetActiveProvider.mockReturnValue(null);
  mockEnsureActiveProvider.mockReturnValue(null);
  vi.mocked(isSubmoduleEnabled).mockReturnValue(true);
  mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] } as any);
  mockGetTaskProviderForUser.mockReturnValue({
    getAllPendingTasks: mockTaskGetAllPendingTasks,
  });
  vi.mocked(hasConnectedCalendarForUser).mockReturnValue(false);
  vi.mocked(getEvents).mockResolvedValue([] as any);
  vi.mocked(isAnyMailConfiguredForUser).mockReturnValue(false);
  vi.mocked(getUnreadMailSummaryForUser).mockResolvedValue({
    configuredProviders: [],
    totalUnread: 0,
    outlookUnread: null,
    gmailUnread: null,
  });
  vi.mocked(composeDailyBrief).mockResolvedValue({
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
  vi.mocked(buildSharedDecisionContext).mockResolvedValue('');
  vi.mocked(buildSharedDecisionContracts).mockResolvedValue({});
  vi.mocked(getSharedMemoryByScope).mockReturnValue({ userPrivate: [], tenantShared: [] });
  vi.mocked(getRemindersForToday).mockReturnValue([] as any);
  vi.mocked(now).mockReturnValue({
    toFormat: vi.fn().mockReturnValue('Monday, March 30 2026, 10:00'),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-03-27') }),
  } as any);
  mockGetUserLanguage.mockReturnValue('en-US');
  mockGetUserTimezone.mockReturnValue('Europe/Lisbon');
});

afterEach(() => {
  _resetStateContextCacheForTesting();
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SECRETARY_REASONING_V1_MODE;
});

// ═══════════════════════════════════════════════════════════════════

describe('handleSecretary', () => {
  it('returns text response when no tool calls', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'You have 3 tasks today.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('Give me a concise secretary summary', 42);
    expect(result).toEqual({ text: 'You have 3 tasks today.', domain: 'secretary' });
    expect(isChatShadowBaselineEligible(result)).toBe(true);
    expect(mockCallDomain).toHaveBeenCalledOnce();
  });

  it('lazily initializes the routing provider before using direct anthropic fallback', async () => {
    mockEnsureActiveProvider.mockReturnValue({
      name: 'lazy-provider',
      callDomain: (...args: unknown[]) => mockProviderCall(...args),
      continueWithToolResults: (...args: unknown[]) => mockProviderContinue(...args),
      classify: vi.fn(),
    });
    mockProviderCall.mockResolvedValue({
      text: 'Hello there.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('Hello', 42);

    expect(result).toEqual({ text: 'Hello there.', domain: 'secretary' });
    expect(mockEnsureActiveProvider).toHaveBeenCalledOnce();
    expect(mockProviderCall).toHaveBeenCalledOnce();
    expect(mockCallDomain).not.toHaveBeenCalled();
  });

  it('uses empty provider history and no tools for active structured reasoning', async () => {
    process.env.SECRETARY_REASONING_V1_MODE = 'active';
    mockEnsureActiveProvider.mockReturnValue({
      name: 'structured-provider',
      callDomain: (...args: unknown[]) => mockProviderCall(...args),
      continueWithToolResults: (...args: unknown[]) => mockProviderContinue(...args),
      classify: vi.fn(),
    });
    mockProviderCall.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[3]);
      const snapshotId = prompt.match(/snapshotId=([^\n]+)/)?.[1];
      const contextHash = prompt.match(/contextHash=([^\n]+)/)?.[1];
      return {
        text: JSON.stringify({
          schemaVersion: 'secretary_reasoning.v1', promptVersion: 'secretary_reasoning_prompt.v1',
          snapshotId, contextHash,
          candidates: [{
            behavior: 'answer', userFacingText: 'Use the nearest verified deadline.',
            conciseRationale: 'Bound to the current request.', evidenceIds: ['current-turn'],
            assumptions: [], unresolvedQuestions: [],
            factors: {
              relevance: 'weak', confidence: 'low', urgency: 'none', expectedImpact: 'none',
              risk: 'critical', reversibility: 'irreversible', requiredPermissions: ['made_up'],
              requiredApproval: 'admin_review', dependencies: ['made_up'], contextFreshness: 'unknown',
            },
          }],
        }),
        toolCalls: [], stopReason: 'end_turn',
      };
    });

    const result = await handleSecretary('Explain your role in one sentence', 42, 42);

    expect(result.text).toBe('Use the nearest verified deadline.');
    expect(mockProviderCall).toHaveBeenCalledTimes(1);
    expect(mockProviderCall.mock.calls[0][1]).toEqual([]);
    expect(mockProviderCall.mock.calls[0][4]).toEqual(expect.objectContaining({ filteredTools: [] }));
    expect(mockProviderContinue).not.toHaveBeenCalled();
  });

  it('makes exactly one tool-free repair call after invalid structured output', async () => {
    process.env.SECRETARY_REASONING_V1_MODE = 'active';
    mockEnsureActiveProvider.mockReturnValue({
      name: 'structured-provider',
      callDomain: (...args: unknown[]) => mockProviderCall(...args),
      continueWithToolResults: (...args: unknown[]) => mockProviderContinue(...args),
      classify: vi.fn(),
    });
    mockProviderCall.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[3]);
      if (!prompt.includes('<secretary_schema_repair>')) return { text: 'not-json', toolCalls: [], stopReason: 'end_turn' };
      const snapshotId = prompt.match(/snapshotId=([^\n]+)/)?.[1];
      const contextHash = prompt.match(/contextHash=([^\n]+)/)?.[1];
      return {
        text: JSON.stringify({
          schemaVersion: 'secretary_reasoning.v1', promptVersion: 'secretary_reasoning_prompt.v1',
          snapshotId, contextHash,
          candidates: [{
            behavior: 'answer', userFacingText: 'Repaired safely.', conciseRationale: 'Current request only.',
            evidenceIds: ['current-turn'], assumptions: [], unresolvedQuestions: [],
            factors: {
              relevance: 'direct', confidence: 'high', urgency: 'none', expectedImpact: 'low', risk: 'low',
              reversibility: 'not_applicable', requiredPermissions: [], requiredApproval: 'none', dependencies: [], contextFreshness: 'fresh',
            },
          }],
        }),
        toolCalls: [], stopReason: 'end_turn',
      };
    });

    const result = await handleSecretary('Explain what you can verify', 42, 42);
    expect(result.text).toBe('Repaired safely.');
    expect(isChatShadowBaselineEligible(result)).toBe(false);
    expect(mockProviderCall).toHaveBeenCalledTimes(2);
    expect(mockProviderCall.mock.calls.every((call) => (call[4] as any)?.filteredTools?.length === 0)).toBe(true);
    expect(mockProviderContinue).not.toHaveBeenCalled();
  });

  it('does not mark structured-reasoning unavailable copy as a legacy shadow baseline', async () => {
    process.env.SECRETARY_REASONING_V1_MODE = 'active';
    mockEnsureActiveProvider.mockReturnValue({
      name: 'structured-provider',
      callDomain: (...args: unknown[]) => mockProviderCall(...args),
      continueWithToolResults: (...args: unknown[]) => mockProviderContinue(...args),
      classify: vi.fn(),
    });
    mockProviderCall.mockResolvedValue({
      text: 'not-json',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('Summarize only what you can verify', 42, 42);

    expect(result.text).toBe(
      'I could not verify enough context to answer safely. Please try again or ask a more specific question.',
    );
    expect(isChatShadowBaselineEligible(result)).toBe(false);
    expect(mockProviderCall).toHaveBeenCalledTimes(2);
    expect(mockProviderContinue).not.toHaveBeenCalled();
  });

  it('runs structured reasoning in shadow without changing the legacy response', async () => {
    process.env.SECRETARY_REASONING_V1_MODE = 'shadow';
    mockEnsureActiveProvider.mockReturnValue({
      name: 'structured-provider',
      callDomain: (...args: unknown[]) => mockProviderCall(...args),
      continueWithToolResults: (...args: unknown[]) => mockProviderContinue(...args),
      classify: vi.fn(),
    });
    mockProviderCall.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[3]);
      if (!prompt.includes('<secretary_reasoning_contract>')) return { text: 'Legacy response.', toolCalls: [], stopReason: 'end_turn' };
      const snapshotId = prompt.match(/snapshotId=([^\n]+)/)?.[1];
      const contextHash = prompt.match(/contextHash=([^\n]+)/)?.[1];
      return {
        text: JSON.stringify({
          schemaVersion: 'secretary_reasoning.v1', promptVersion: 'secretary_reasoning_prompt.v1', snapshotId, contextHash,
          candidates: [{
            behavior: 'answer', userFacingText: 'Shadow response.', conciseRationale: 'Current request.', evidenceIds: ['current-turn'],
            assumptions: [], unresolvedQuestions: [], factors: {
              relevance: 'direct', confidence: 'high', urgency: 'none', expectedImpact: 'low', risk: 'low',
              reversibility: 'not_applicable', requiredPermissions: [], requiredApproval: 'none', dependencies: [], contextFreshness: 'fresh',
            },
          }],
        }), toolCalls: [], stopReason: 'end_turn',
      };
    });

    const result = await handleSecretary('Give me a thoughtful summary', 42, 42);
    expect(result.text).toBe('Legacy response.');
    expect(mockProviderCall).toHaveBeenCalledTimes(2);
    expect(mockProviderContinue).not.toHaveBeenCalled();
  });

  it('passes the resolved uid into the direct anthropic fallback when routing stays unavailable', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Fallback hello.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSecretary('Hello', 77);

    expect(mockCallDomain).toHaveBeenCalledWith(
      'secretary',
      [],
      'Hello',
      expect.any(String),
      expect.objectContaining({
        userId: 77,
        abortSignal: expect.any(AbortSignal),
      }),
      77,
    );
  });

  it('returns an honest unavailable response when routing stays unavailable and Anthropic direct fallback is disabled', async () => {
    delete process.env.ANTHROPIC_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
    mockGetUserLanguage.mockReturnValue('pt-BR');

    const result = await handleSecretary('Organiza o meu dia', 77);

    expect(result).toEqual({
      text: 'O chat com IA está temporariamente indisponível neste ambiente porque não há nenhum provedor configurado. As visualizações diretas e outras ações determinísticas continuam funcionando normalmente.',
      domain: 'secretary',
    });
    expect(mockCallDomain).not.toHaveBeenCalled();
  });

  it('stores user and assistant messages in conversation', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    // Use a phrasing that does NOT match any TASK-17 Layer 1 fastpath
    // pattern, so this test exercises the full AI flow it was designed
    // for. "Triage my emails today" → no fastpath match → AI path runs
    // → mocked callDomain returns 'Done.' → addToConversation gets the
    // raw assistant text (no fastpath wrapper).
    await handleSecretary('Triage my email backlog', 42);
    expect(addToConversation).toHaveBeenCalledWith(42, 'secretary', 'user', 'Triage my email backlog');
    expect(addToConversation).toHaveBeenCalledWith(42, 'secretary', 'assistant', 'Done.');
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

    const result = await handleSecretary('Show my lists', 42);
    expect(result.text).toBe('You have no task lists.');
    expect(mockExecuteTool).toHaveBeenCalledWith('ms_todo_get_lists', {}, 42);
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

    await handleSecretary('Search emails', 42);

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
    expect(result.text).toContain('could not complete or verify');
    expect(result.text).toContain('not claiming that any change was made');
  });

  it('returns fallback message when response is whitespace-only', async () => {
    mockCallDomain.mockResolvedValue({
      text: '   \n  ',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSecretary('Do something');
    expect(result.text).toContain('could not complete or verify');
    expect(result.text).toContain('not claiming that any change was made');
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

    await handleSecretary('Complex task', 42);
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

    await handleSecretary('Get tasks', 42);

    const storedCall = vi.mocked(addToConversation).mock.calls.find(
      (c) => c[2] === 'assistant',
    );
    expect(storedCall![3]).toBe('[Tools: ms_todo_get_tasks]\nHere are your tasks.');
  });
});

// ═══════════════════════════════════════════════════════════════════
// State context building (tested via callDomain args)
// ═══════════════════════════════════════════════════════════════════

describe('Secretary state context', () => {
  it('includes current date in context', async () => {
    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);

    await handleSecretary('Hi', 42);

    expect(mockCallDomain).toHaveBeenCalled();
    const stateCtx = mockCallDomain.mock.calls.at(-1)?.[3] as string;
    expect(stateCtx).toContain('Today:');
    expect(stateCtx).toContain('(Europe/Lisbon)');
  });

  it('includes pending todo summary when configured', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', listId: 'l1', listName: 'Work', title: 'Deploy v5', importance: 'high', status: 'notStarted', dueDateTime: '2026-03-29T09:00:00', isReminderOn: false, createdDateTime: '2026-03-28' },
      ],
    } as any);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('Check tasks', 42);

    expect(mockCallDomain).toHaveBeenCalled();
    const stateCtx = mockCallDomain.mock.calls.at(-1)?.[3] as string;
    expect(stateCtx).toContain('To Do: 1 pending');
    expect(stateCtx).toContain('1 overdue');
    expect(stateCtx).toContain('Work(1)');
  });

  it('includes unread email count when Outlook is configured', async () => {
    vi.mocked(isAnyMailConfiguredForUser).mockReturnValue(true);
    vi.mocked(getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook', 'gmail'],
      totalUnread: 7,
      outlookUnread: 4,
      gmailUnread: 3,
    });

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('Check inbox', 42);

    expect(mockCallDomain).toHaveBeenCalled();
    const stateCtx = mockCallDomain.mock.calls.at(-1)?.[3] as string;
    expect(stateCtx).toContain('Mail: 7 unread');
    expect(stateCtx).toContain('Outlook 4');
    expect(stateCtx).toContain('Gmail 3');
  });

  it('includes calendar events when configured', async () => {
    vi.mocked(hasConnectedCalendarForUser).mockReturnValue(true);
    vi.mocked(getEvents).mockResolvedValue([
      { summary: 'Team standup', start: '2026-03-30T09:00:00', end: '2026-03-30T09:30:00' },
    ] as any);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('My calendar', 42);

    expect(mockCallDomain).toHaveBeenCalled();
    const stateCtx = mockCallDomain.mock.calls.at(-1)?.[3] as string;
    expect(stateCtx).toContain('Calendar today (1)');
    expect(stateCtx).toContain('Team standup');
  });

  it('includes reminders when present', async () => {
    vi.mocked(getRemindersForToday).mockReturnValue([
      { id: 1, message: 'Call dentist', remind_at: '2026-03-30T14:00:00', recurring: null, status: 'active', created_at: '' },
    ] as any);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('Reminders', 42);

    expect(mockCallDomain).toHaveBeenCalled();
    const stateCtx = mockCallDomain.mock.calls.at(-1)?.[3] as string;
    expect(stateCtx).toContain('Reminders today');
    expect(stateCtx).toContain('Call dentist');
  });

  it('gracefully handles API errors without crashing', async () => {
    mockTaskGetAllPendingTasks.mockRejectedValue(new Error('API timeout'));
    vi.mocked(hasConnectedCalendarForUser).mockReturnValue(true);
    vi.mocked(getEvents).mockRejectedValue(new Error('Token expired'));

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);

    // Should not throw — all external calls have .catch() guards
    const result = await handleSecretary('Overview', 42);
    expect(result.text).toBe('OK');
  });

  it('includes planner coordination and typed contracts in the state context', async () => {
    vi.mocked(composeDailyBrief).mockResolvedValue({
      coordination: {
        topPriority: 'Protect the key session before adding admin.',
        executionOrder: ['Key session', 'Fueling coverage', 'Sponsor review'],
        watchouts: ['Inbox pressure is elevated'],
        handoffs: ['Content should follow training'],
      },
      day: {
        secretary: {
          priorityNote: 'Protect the key session before adding admin.',
          sequence: ['Key session', 'Fueling coverage', 'Sponsor review'],
          tradeoffNote: 'Move admin first, not training.',
        },
      },
    } as any);
    vi.mocked(buildSharedDecisionContracts).mockResolvedValue({
      training: {
        nonNegotiables: ['Keep the tempo run protected.'],
        preferredWindows: ['Sequence the day around the tempo run.'],
        fallbackIfDeferred: ['Cut optional admin before moving the session.'],
        budgetMode: null,
        publishDeadline: null,
        notes: [],
      },
    });

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('What should I prioritize today?', 42, 420);

    const stateCtx = mockCallDomain.mock.calls.at(-1)?.[3] as string;
    expect(vi.mocked(composeDailyBrief)).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 420,
    }));
    expect(vi.mocked(buildSharedDecisionContext)).toHaveBeenCalledWith('secretary', 42, 420);
    expect(vi.mocked(buildSharedDecisionContracts)).toHaveBeenCalledWith('secretary', 42, 420);
    expect(stateCtx).toContain('[PLANNER COORDINATION]');
    expect(stateCtx).toContain('Top priority: Protect the key session before adding admin.');
    expect(stateCtx).toContain('<shared_decision_contracts domain="secretary">');
    expect(stateCtx).toContain('training: nonNegotiables=Keep the tempo run protected.');
  });

  it('passes tenant scope into the deterministic daily-priority fastpath', async () => {
    vi.mocked(composeDailyBrief).mockResolvedValue({
      coordination: {
        topPriority: 'Handle the tenant-scoped priority first.',
        executionOrder: ['Tenant-scoped priority'],
        watchouts: [],
        handoffs: [],
      },
      day: {
        secretary: {
          priorityNote: 'Handle the tenant-scoped priority first.',
          sequence: ['Tenant-scoped priority'],
          tradeoffNote: null,
        },
      },
    } as any);

    const result = await handleSecretary('what should i do first today?', 42, 420);

    expect(result.text).toContain('Handle the tenant-scoped priority first.');
    expect(mockCallDomain).not.toHaveBeenCalled();
    expect(vi.mocked(composeDailyBrief)).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 420,
    }));
  });

  it('localizes planner coordination labels in the state context for portuguese users', async () => {
    mockGetUserLanguage.mockReturnValue('pt-PT');
    vi.mocked(composeDailyBrief).mockResolvedValue({
      coordination: {
        topPriority: 'Protege a sessão-chave antes de empurrar admin.',
        executionOrder: ['Sessão-chave', 'Cobertura de fueling'],
        watchouts: ['A manhã já está a partir o foco'],
        handoffs: ['O conteúdo fica melhor depois do treino'],
        dayOrchestration: {
          title: 'Hoje pede proteção do bloco principal.',
        },
        weekOrchestration: {
          title: 'A semana está a proteger consistência.',
        },
        nextBestAction: {
          summary: 'Fecha primeiro o que mantém a semana executável.',
        },
        blockers: [{ summary: 'Há pressão de agenda a subir.' }],
        suggestedMoves: [{ title: 'Agrupa admin numa só janela.' }],
      },
      day: {
        secretary: {
          priorityNote: null,
          sequence: [],
          tradeoffNote: 'Não sacrifiques o treino por admin leve.',
        },
      },
    } as any);

    mockCallDomain.mockResolvedValue({ text: 'OK', toolCalls: [], stopReason: 'end_turn' } as any);
    await handleSecretary('Como encaixo isto hoje?', 42);

    const stateCtx = mockCallDomain.mock.calls.at(-1)?.[3] as string;
    expect(stateCtx).toContain('[COORDENAÇÃO DO PLANNER]');
    expect(stateCtx).toContain('Prioridade principal: Protege a sessão-chave antes de empurrar admin.');
    expect(stateCtx).toContain('Postura do dia: Hoje pede proteção do bloco principal.');
    expect(stateCtx).toContain('Postura da semana: A semana está a proteger consistência.');
    expect(stateCtx).toContain('Próxima melhor ação: Fecha primeiro o que mantém a semana executável.');
    expect(stateCtx).toContain('Bloqueios: Há pressão de agenda a subir.');
    expect(stateCtx).toContain('Movimentos sugeridos: Agrupa admin numa só janela.');
    expect(stateCtx).toContain('Trade-off: Não sacrifiques o treino por admin leve.');
  });

  it('does not persist conversation or run fastpath state reads when no user scope is provided', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Anonymous reply.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);
    await handleSecretary('What do I have today?');

    expect(addToConversation).not.toHaveBeenCalled();
    expect(mockTaskGetAllPendingTasks).not.toHaveBeenCalled();
  });
});
