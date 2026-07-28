import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

// M13: chat-message-context is now write-through durable (chat_conversation_state).
// The database mock serves a fully migrated :memory: copy so the durable
// fallback paths run against the real schema.
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

const mockGetLastAssistantMessage = vi.fn();
const mockGetLastCoachState = vi.fn();
const mockHandleSecretary = vi.fn();
const mockHandleTriathlon = vi.fn();
const mockHandleContent = vi.fn();
const mockHandleFinance = vi.fn();
const mockHandleCooking = vi.fn();

vi.mock('../../src/state/conversation', () => ({
  getLastAssistantMessage: (...args: unknown[]) => mockGetLastAssistantMessage(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  getLastCoachState: (...args: unknown[]) => mockGetLastCoachState(...args),
}));

vi.mock('../../src/domains/secretary', () => ({
  handleSecretary: (...args: unknown[]) => mockHandleSecretary(...args),
}));

vi.mock('../../src/domains/triathlon', () => ({
  handleTriathlon: (...args: unknown[]) => mockHandleTriathlon(...args),
}));

vi.mock('../../src/domains/content-creator', () => ({
  handleContent: (...args: unknown[]) => mockHandleContent(...args),
}));

vi.mock('../../src/domains/finance', () => ({
  handleFinance: (...args: unknown[]) => mockHandleFinance(...args),
}));

vi.mock('../../src/domains/cooking', () => ({
  handleCooking: (...args: unknown[]) => mockHandleCooking(...args),
}));

import {
  CHAT_ACTIVE_DOMAIN_TTL_MS,
  buildDefaultButtonsForChatDomain,
  clearChatActiveDomain,
  getChatDomainHandler,
  getDurableChatContinuity,
  getLastChatActiveDomain,
  rememberChatActiveDomain,
  resetChatMessageContextForTests,
  resolveChatActiveContext,
  setLastActiveDomain,
} from '../../src/api/routes/chat-message-context';
import { storeChatMessage } from '../../src/services/chat-history-store';

describe('chat message context helpers', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    resetChatMessageContextForTests();
    mockGetLastAssistantMessage.mockReset();
    mockGetLastCoachState.mockReset();
    mockHandleSecretary.mockReset();
    mockHandleTriathlon.mockReset();
    mockHandleContent.mockReset();
    mockHandleFinance.mockReset();
    mockHandleCooking.mockReset();
  });

  it('keeps recent active-domain continuity with the last assistant message', () => {
    const now = Date.parse('2026-04-24T11:00:00.000Z');
    mockGetLastAssistantMessage.mockReturnValue('Latest secretary answer');

    rememberChatActiveDomain(42, 'secretary', now - 1000);

    expect(getLastChatActiveDomain(42, now)).toBe('secretary');
    expect(resolveChatActiveContext(42, now)).toEqual({
      domain: 'secretary',
      lastAssistantMessage: 'Latest secretary answer',
    });
    expect(mockGetLastAssistantMessage).toHaveBeenCalledWith(42, 'secretary');
  });

  it('drops expired or missing active-domain continuity', () => {
    const now = Date.parse('2026-04-24T11:00:00.000Z');

    rememberChatActiveDomain(42, 'finance', now - CHAT_ACTIVE_DOMAIN_TTL_MS - 1);

    expect(getLastChatActiveDomain(42, now)).toBeNull();
    expect(resolveChatActiveContext(42, now)).toBeNull();
    expect(mockGetLastAssistantMessage).not.toHaveBeenCalled();

    rememberChatActiveDomain(42, 'finance', now - 1000);
    clearChatActiveDomain(42);
    expect(getLastChatActiveDomain(42, now)).toBeNull();
  });

  it('exposes a scheduler-facing active-domain helper without Telegram state', () => {
    const before = Date.now();

    setLastActiveDomain(42, 'triathlon', 7);

    expect(getLastChatActiveDomain(42, before, 7)).toBe('triathlon');
    expect(getLastChatActiveDomain(42, before)).toBeNull();
  });

  it('fails closed when the conversation store cannot provide continuity', () => {
    const now = Date.parse('2026-04-24T11:00:00.000Z');
    mockGetLastAssistantMessage.mockImplementation(() => {
      throw new Error('conversation unavailable');
    });

    rememberChatActiveDomain(42, 'content', now - 1000);

    expect(resolveChatActiveContext(42, now)).toBeNull();
  });

  it('resolves only registered chat domain handlers', async () => {
    mockHandleSecretary.mockResolvedValue({ text: 'Done', domain: 'secretary' });

    const handler = getChatDomainHandler('secretary');

    expect(handler).toBeTypeOf('function');
    await expect(handler?.('What is today?', 42)).resolves.toEqual({ text: 'Done', domain: 'secretary' });
    expect(getChatDomainHandler('unknown')).toBeUndefined();
  });

  it('builds localized secretary default action buttons', () => {
    expect(buildDefaultButtonsForChatDomain('secretary', 'pt-PT')).toEqual([[
      { text: '📅 Hoje', callbackData: 'cmd:/day' },
      { text: '📋 Tarefas', callbackData: 'cmd:/todo_summary' },
      { text: '🗓 Semana', callbackData: 'cmd:/week' },
    ]]);
  });

  it('only exposes coach recommendation buttons for fresh triathlon state', () => {
    const requestStartedAt = Date.parse('2026-04-24T11:00:00.000Z');
    mockGetLastCoachState.mockReturnValue({
      timestamp: requestStartedAt,
      recommendations: [
        {
          eventId: 'evt-1',
          action: 'MODIFY',
          summary: 'Adjust intensity',
        },
      ],
    });

    const buttons = buildDefaultButtonsForChatDomain('triathlon', 'en-US', 42, requestStartedAt);
    expect(buttons?.[0]?.[0]?.text).toContain('Adjust intensity');

    mockGetLastCoachState.mockReturnValue({
      timestamp: requestStartedAt - 2000,
      recommendations: [
        {
          eventId: 'evt-2',
          action: 'MODIFY',
          summary: 'Old recommendation',
        },
      ],
    });

    expect(buildDefaultButtonsForChatDomain('triathlon', 'en-US', 42, requestStartedAt)).toBeNull();
  });

  describe('M13 durable continuity', () => {
    const now = Date.parse('2026-07-20T12:00:00.000Z');

    it('returns the active domain after a simulated restart within TTL, null after TTL', () => {
      rememberChatActiveDomain(42, 'secretary', now - 1000, 7);

      // Restart seam: only the in-process read cache is wiped; the durable
      // chat_conversation_state row survives.
      resetChatMessageContextForTests();
      expect(getLastChatActiveDomain(42, now, 7)).toBe('secretary');

      resetChatMessageContextForTests();
      expect(getLastChatActiveDomain(42, now - 1000 + CHAT_ACTIVE_DOMAIN_TTL_MS, 7)).toBeNull();
    });

    it('never leaks continuity across tenants for the same user', () => {
      rememberChatActiveDomain(42, 'finance', now - 1000, 7);
      resetChatMessageContextForTests();

      expect(getLastChatActiveDomain(42, now, 9)).toBeNull();
      expect(getLastChatActiveDomain(42, now)).toBeNull();
      expect(getDurableChatContinuity(42, 9, now)).toBeNull();
      expect(getLastChatActiveDomain(42, now, 7)).toBe('finance');
    });

    it('recovers lastAssistantMessage from chat-history-store after restart when the conversation store misses', () => {
      // messages.user_id has an FK to users(id).
      testDb.prepare(
        "INSERT INTO users (id, first_name, status) VALUES (42, 'Test', 'active')",
      ).run();
      storeChatMessage({
        tenantId: 7,
        userId: 42,
        messageId: 'assistant-msg-1',
        role: 'assistant',
        text: 'Durable secretary answer',
      });
      rememberChatActiveDomain(42, 'secretary', now - 1000, 7, {
        lastAssistantMessageId: 'assistant-msg-1',
      });

      resetChatMessageContextForTests();
      mockGetLastAssistantMessage.mockReturnValue(null);

      expect(resolveChatActiveContext(42, now, 7)).toEqual({
        domain: 'secretary',
        lastAssistantMessage: 'Durable secretary answer',
      });
    });

    it('exposes anchor entities through getDurableChatContinuity', () => {
      rememberChatActiveDomain(42, 'secretary', now - 1000, 7, {
        anchorEntityIds: ['task-9'],
      });

      const continuity = getDurableChatContinuity(42, 7, now);
      expect(continuity?.domain).toBe('secretary');
      expect(continuity?.anchorEntities.map((anchor) => anchor.entityId)).toEqual(['task-9']);
    });

    it('keeps the turn on the Map when the durable write fails', () => {
      const realDb = testDb;
      testDb = new Proxy(realDb, {
        get() {
          throw new Error('db down (simulated)');
        },
      }) as typeof realDb;

      expect(() => rememberChatActiveDomain(42, 'triathlon', now - 1000, 7)).not.toThrow();
      expect(getLastChatActiveDomain(42, now, 7)).toBe('triathlon');

      testDb = realDb;
    });
  });
});
