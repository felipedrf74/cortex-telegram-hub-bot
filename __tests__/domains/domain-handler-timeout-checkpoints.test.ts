/**
 * M18 — tool-loop checkpointing in the legacy domain handler.
 *
 * Spike verdict (recorded in the M18 milestone): resuming a timed-out legacy
 * tool loop by re-injecting checkpointed tool results across the process
 * boundary is NOT provably safe (detached loop keeps running after the
 * Promise.race timeout; ADV-2 provider pinning cannot be guaranteed later;
 * sliced-history shape stability breaks tool_use_id scope). So the loop only
 * CHECKPOINTS completed read tool calls — write-behind, fail-open — and the
 * route queues a delivery job that consumes only the late foreground result
 * and otherwise fails honestly without starting another provider turn.
 *
 * These tests pin the checkpoint hook: completed tools 1-2 are persisted
 * while tool 3 stalls past the route timeout; blocked write tools are never
 * checkpointed; checkpoint failures never affect the live loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const mockCallDomainFn = vi.fn();
const mockContinueFn = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockEnsureActiveProvider = vi.fn();
const mockGetCurrentRequestId = vi.fn<() => string | undefined>();

vi.mock('../../src/services/provider-registry', async () => ({
  ...(await vi.importActual('../../src/services/provider-registry')),
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args as []),
  ensureActiveProvider: (...args: unknown[]) => mockEnsureActiveProvider(...args as []),
}));

vi.mock('../../src/services/anthropic', async () => ({
  ...(await vi.importActual('../../src/services/anthropic')),
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
}));

vi.mock('../../src/state/conversation', async () => ({
  ...(await vi.importActual('../../src/state/conversation')),
  getConversationHistory: vi.fn().mockReturnValue([]),
  addToConversation: vi.fn(),
}));

vi.mock('../../src/state/todos', async () => ({
  ...(await vi.importActual('../../src/state/todos')),
  listTodos: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/state/shared-memory', async () => ({
  ...(await vi.importActual('../../src/state/shared-memory')),
  getSharedMemorySummary: vi.fn().mockReturnValue(''),
  getSharedMemory: vi.fn().mockReturnValue([]),
  getSharedMemoryByScope: vi.fn().mockReturnValue({ userPrivate: [], tenantShared: [] }),
}));

vi.mock('../../src/services/tool-executor', async () => ({
  ...(await vi.importActual('../../src/services/tool-executor')),
  executeToolCall: vi.fn(),
}));

// Not under M18 ownership and irrelevant to checkpointing: the prompt
// context compiler (owned by the routing/context milestones) is stubbed so
// this mirror suite pins ONLY the tool-loop checkpoint hook.
vi.mock('../../src/services/chat-context-engine', async () => ({
  ...(await vi.importActual('../../src/services/chat-context-engine')),
  buildChatPromptContextBlock: vi.fn(async () => ''),
}));

vi.mock('../../src/utils/request-context', async () => ({
  ...(await vi.importActual('../../src/utils/request-context')),
  getCurrentRequestId: (...args: unknown[]) => mockGetCurrentRequestId(...args as []),
}));

vi.mock('../../src/utils/date-parser', async () => ({
  ...(await vi.importActual('../../src/utils/date-parser')),
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

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

import { handleSimpleDomain } from '../../src/domains/domain-handler';
import { executeToolCall } from '../../src/services/tool-executor';
import { now } from '../../src/utils/date-parser';
import { listLegacyToolLoopCheckpoints } from '../../src/services/chat-action-run-store';

const mockExecuteTool = vi.mocked(executeToolCall);

const USER_ID = 42;
const TENANT_ID = 42;
const RUN_ID = 'req-m18-checkpoints';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  testDb = createMigratedTestDatabase();
  delete process.env.ANTHROPIC_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  mockGetCurrentRequestId.mockReturnValue(RUN_ID);
  mockGetActiveProvider.mockReturnValue({
    name: 'mock-provider',
    callDomain: (...args: unknown[]) => mockCallDomainFn(...args),
    continueWithToolResults: (...args: unknown[]) => mockContinueFn(...args),
    classify: vi.fn(),
  });
  mockEnsureActiveProvider.mockReturnValue(null);
  vi.mocked(now).mockReturnValue({
    toFormat: vi.fn().mockReturnValue('Monday, March 30 2026, 10:00'),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-03-27') }),
  } as never);
});

afterEach(() => {
  testDb?.close();
});

describe('M18 tool-loop checkpointing (write-behind, fail-open)', () => {
  it('persists checkpoints for completed tools 1-2 while tool 3 stalls past the turn timeout', async () => {
    const tool3Started = deferred<void>();

    mockCallDomainFn.mockResolvedValue({
      text: '',
      toolCalls: [
        { id: 'tc-1', name: 'ms_todo_get_tasks', input: { list: 'today' } },
        { id: 'tc-2', name: 'get_calendar_events', input: { day: 'today' } },
      ],
      routedProviderName: 'mock-provider',
    });
    mockContinueFn.mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-3', name: 'search_notes', input: { q: 'stall' } }],
      routedProviderName: 'mock-provider',
    });
    mockExecuteTool.mockImplementation(async (name: string) => {
      if (name === 'search_notes') {
        tool3Started.resolve();
        return new Promise<never>(() => {}); // stalls forever (past any timeout)
      }
      return { ok: true, tool: name };
    });

    // Deliberately NOT awaited: the turn hangs on tool 3 exactly like a
    // production timeout (Promise.race abandons, loop keeps running).
    void handleSimpleDomain('secretary', 'plan my day', 5, USER_ID, undefined, TENANT_ID);
    await tool3Started.promise;

    const checkpoints = listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_ID });
    expect(checkpoints.map((c) => c.toolName)).toEqual(['ms_todo_get_tasks', 'get_calendar_events']);
    expect(checkpoints.map((c) => c.sequence)).toEqual([1, 2]);
  });

  it('never checkpoints FAILED tool results — a failed call is not completed work, so the partial reply cannot name it (M18 honesty)', async () => {
    const tool3Started = deferred<void>();

    mockCallDomainFn.mockResolvedValue({
      text: '',
      toolCalls: [
        { id: 'tc-1', name: 'ms_todo_get_tasks', input: { list: 'today' } },
        { id: 'tc-2', name: 'get_calendar_events', input: { day: 'today' } },
      ],
      routedProviderName: 'mock-provider',
    });
    mockContinueFn.mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-3', name: 'search_notes', input: { q: 'stall' } }],
      routedProviderName: 'mock-provider',
    });
    mockExecuteTool.mockImplementation(async (name: string) => {
      // Real tool-executor failure shape: returned, never thrown.
      if (name === 'get_calendar_events') return { success: false, error: 'provider auth expired' };
      if (name === 'search_notes') {
        tool3Started.resolve();
        return new Promise<never>(() => {}); // stalls past the turn timeout
      }
      return { ok: true, tool: name };
    });

    void handleSimpleDomain('secretary', 'plan my day', 5, USER_ID, undefined, TENANT_ID);
    await tool3Started.promise;

    const checkpoints = listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_ID });
    // Only the successful call is recorded as verified_success evidence; the
    // failed call gets NO row, so the timeout partial reply never claims it.
    expect(checkpoints.map((c) => c.toolName)).toEqual(['ms_todo_get_tasks']);
    expect(checkpoints.map((c) => c.sequence)).toEqual([1]);
  });

  it('excludes every real executeToolCall failure shape but keeps truncated large read payloads', async () => {
    const tool5Started = deferred<void>();

    mockCallDomainFn.mockResolvedValue({
      text: '',
      toolCalls: [
        { id: 'tc-1', name: 'ms_todo_search_tasks', input: {} }, // {error} shape (no success field)
        { id: 'tc-2', name: 'get_calendar_events', input: {} }, // TOOL_NOT_ALLOWED shape
        { id: 'tc-3', name: 'search_notes', input: {} }, // authorization-failure shape
        { id: 'tc-4', name: 'ms_todo_get_due_tasks', input: {} }, // huge success payload → truncated JSON
      ],
      routedProviderName: 'mock-provider',
    });
    mockContinueFn.mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-5', name: 'finance_get_transactions', input: {} }],
      routedProviderName: 'mock-provider',
    });
    mockExecuteTool.mockImplementation(async (name: string) => {
      if (name === 'ms_todo_search_tasks') return { error: 'Unknown tool: ms_todo_search_tasks' };
      if (name === 'get_calendar_events') {
        return { success: false, error: 'Tool "get_calendar_events" is not registered for execution', code: 'TOOL_NOT_ALLOWED' };
      }
      if (name === 'search_notes') {
        // formatToolAuthorizationFailure shape
        return { success: false, error: 'not authorized', code: 'CONFIRMATION_REQUIRED', confirmation_required: true, tool_risk: 'write' };
      }
      if (name === 'ms_todo_get_due_tasks') {
        // Successful read whose serialized form exceeds the 2000-char cap —
        // the checkpoint hook sees unparseable truncated JSON and must still
        // count it as completed work (failure shapes are compact and always
        // parse).
        return { items: Array.from({ length: 200 }, (_, i) => ({ id: i, note: `entry-${i}-${'x'.repeat(20)}` })) };
      }
      tool5Started.resolve();
      return new Promise<never>(() => {}); // stalls past the turn timeout
    });

    void handleSimpleDomain('secretary', 'plan my day', 5, USER_ID, undefined, TENANT_ID);
    await tool5Started.promise;

    const checkpoints = listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_ID });
    expect(checkpoints.map((c) => c.toolName)).toEqual(['ms_todo_get_due_tasks']);
  });

  it('never checkpoints blocked legacy write tools — only completed read work counts', async () => {
    mockCallDomainFn.mockResolvedValue({
      text: '',
      toolCalls: [
        { id: 'tc-1', name: 'create_calendar_event', input: { title: 'x' } }, // write → blocked
        { id: 'tc-2', name: 'ms_todo_get_tasks', input: {} },
      ],
      routedProviderName: 'mock-provider',
    });
    mockContinueFn.mockResolvedValue({ text: 'done', toolCalls: [], routedProviderName: 'mock-provider' });
    mockExecuteTool.mockResolvedValue({ ok: true });

    await handleSimpleDomain('secretary', 'schedule and check', 5, USER_ID, undefined, TENANT_ID);

    const checkpoints = listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_ID });
    expect(checkpoints.map((c) => c.toolName)).toEqual(['ms_todo_get_tasks']);
  });

  it('fails open: a broken request context never affects the live tool loop', async () => {
    mockGetCurrentRequestId.mockImplementation(() => { throw new Error('ctx boom'); });
    mockCallDomainFn.mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-1', name: 'ms_todo_get_tasks', input: {} }],
      routedProviderName: 'mock-provider',
    });
    mockContinueFn.mockResolvedValue({ text: 'all done', toolCalls: [], routedProviderName: 'mock-provider' });
    mockExecuteTool.mockResolvedValue({ ok: true });

    const result = await handleSimpleDomain('secretary', 'check tasks', 5, USER_ID, undefined, TENANT_ID);

    expect(result.text).toContain('all done');
    expect(listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_ID })).toHaveLength(0);
  });

  it('skips checkpointing without tenant scope (no cross-tenant guesses) and still answers', async () => {
    mockCallDomainFn.mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-1', name: 'ms_todo_get_tasks', input: {} }],
      routedProviderName: 'mock-provider',
    });
    mockContinueFn.mockResolvedValue({ text: 'answered', toolCalls: [], routedProviderName: 'mock-provider' });
    mockExecuteTool.mockResolvedValue({ ok: true });

    const result = await handleSimpleDomain('secretary', 'check tasks', 5, USER_ID); // no tenantId

    expect(result.text).toContain('answered');
    expect(listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_ID })).toHaveLength(0);
  });
});
