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
import { runWithChatRequestLocale } from '../../src/services/chat-request-locale-context';

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

  it('refuses to pin the non-routable chat envelope as active REST continuity', () => {
    const now = Date.parse('2026-07-31T12:00:00.000Z');
    mockGetLastAssistantMessage.mockReturnValue('Could you clarify what you want Nexus to do?');

    rememberChatActiveDomain(42, 'chat', now - 1000, 7);

    expect(getChatDomainHandler('chat')).toBeUndefined();
    expect(getLastChatActiveDomain(42, now, 7)).toBeNull();
    expect(resolveChatActiveContext(42, now, 7)).toBeNull();
    expect(mockGetLastAssistantMessage).not.toHaveBeenCalled();
  });

  it('drops a previously persisted chat pseudo-domain before the next REST turn', () => {
    const now = Date.parse('2026-07-31T12:00:00.000Z');
    rememberChatActiveDomain(42, 'secretary', now - 1000, 7);
    testDb.prepare(`
      UPDATE chat_conversation_state
      SET last_domain = 'chat', last_domain_at = ?
      WHERE tenant_id = 7 AND user_id = 42
    `).run(new Date(now - 1000).toISOString());
    resetChatMessageContextForTests();
    mockGetLastAssistantMessage.mockReturnValue('Could you clarify what you want Nexus to do?');

    expect(getLastChatActiveDomain(42, now, 7)).toBeNull();
    expect(resolveChatActiveContext(42, now, 7)).toBeNull();
    expect(mockGetLastAssistantMessage).not.toHaveBeenCalled();
  });

  it.each(['tasks', 'training'])(
    'still pins the Chat Core v2 deterministic-read domain %s with every manifest flag off',
    (domain) => {
      // These domains have no legacy REST handler but are real conversation
      // domains emitted by the v2 deterministic read. The chat-envelope guard
      // must not take their continuity with it.
      const now = Date.parse('2026-07-31T12:00:00.000Z');
      rememberChatActiveDomain(42, domain, now - 1000, 7);

      expect(getChatDomainHandler(domain)).toBeUndefined();
      expect(getLastChatActiveDomain(42, now, 7)).toBe(domain);
    },
  );

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

  it('projects Spanish-authored manifest-tail reads to English instead of Portuguese', async () => {
    const cases = [
      ['connections', 'Mostrar el estado de mis conexiones', 'I could not check Connections'],
      ['notifications', 'Mostrar mis notificaciones', 'I could not check Notifications'],
      ['decision_center', 'Mostrar el estado de mis decisiones', 'I could not check Decision Center'],
    ] as const;

    for (const [domain, message, expectedText] of cases) {
      const handler = getChatDomainHandler(domain);
      await expect(handler?.(message)).resolves.toMatchObject({
        domain,
        text: expect.stringContaining(expectedText),
      });
    }
  });

  it('keeps genuine Portuguese manifest-tail reads in Portuguese', async () => {
    const cases = [
      ['connections', 'Mostrar o estado das minhas conexões', 'Não consegui verificar as conexões'],
      ['notifications', 'Mostrar as minhas notificações', 'Não consegui verificar as notificações'],
      ['decision_center', 'Mostrar o estado das minhas decisões', 'Não consegui verificar as decisões'],
    ] as const;

    for (const [domain, message, expectedText] of cases) {
      const handler = getChatDomainHandler(domain);
      await expect(handler?.(message)).resolves.toMatchObject({
        domain,
        text: expect.stringContaining(expectedText),
      });
    }
  });

  it('uses the supported request locale for otherwise ambiguous Portuguese manifest-tail reads', async () => {
    const handler = getChatDomainHandler('connections');
    const result = await runWithChatRequestLocale(
      'pt-BR',
      () => handler?.('mostrar estado', undefined, undefined),
    );

    expect(result).toMatchObject({
      domain: 'connections',
      text: expect.stringContaining('Não consegui verificar as conexões'),
    });
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
