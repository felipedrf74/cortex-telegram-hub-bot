import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

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

import {
  claimUserChatMessage,
  clearChatHistory,
  findCompletedAssistantForClientMessage,
  listChatMessages,
  markMessageLifecycle,
  repairStuckChatMessages,
  storeChatMessage,
  updateAssistantMessage,
} from '../../src/services/chat-history-store';

function createMessagesTable(): void {
  testDb.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER,
      message_uuid TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      domain TEXT,
      route_method TEXT,
      confidence REAL,
      buttons_json TEXT,
      metadata_json TEXT,
      lifecycle_state TEXT NOT NULL DEFAULT 'completed',
      client_message_id TEXT,
      request_id TEXT,
      retry_of_message_uuid TEXT,
      completed_at TEXT,
      failed_at TEXT,
      canceled_at TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

describe('chat-history-store tenant scope', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createMessagesTable();
  });

  it('stores and lists chat history by tenant and user scope', () => {
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'shared-id-a',
      role: 'assistant',
      text: 'Tenant A answer',
      domain: 'secretary',
      timestamp: '2026-04-29T08:00:00.000Z',
    });
    storeChatMessage({
      tenantId: 11,
      userId: 7,
      messageId: 'shared-id-b',
      role: 'assistant',
      text: 'Tenant B answer',
      domain: 'secretary',
      timestamp: '2026-04-29T08:01:00.000Z',
    });

    expect(listChatMessages(7, 10, undefined, 10).messages).toEqual([
      expect.objectContaining({ id: 'shared-id-a', text: 'Tenant A answer' }),
    ]);
    expect(listChatMessages(7, 10, undefined, 11).messages).toEqual([
      expect.objectContaining({ id: 'shared-id-b', text: 'Tenant B answer' }),
    ]);
  });

  it('updates assistant messages only inside the matching tenant scope', () => {
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'assistant-1',
      role: 'assistant',
      text: 'Tenant A original',
      timestamp: '2026-04-29T08:00:00.000Z',
    });
    storeChatMessage({
      tenantId: 11,
      userId: 7,
      messageId: 'assistant-1',
      role: 'assistant',
      text: 'Tenant B original',
      timestamp: '2026-04-29T08:00:00.000Z',
    });

    expect(updateAssistantMessage(7, 'assistant-1', {
      text: 'Tenant A updated',
      timestamp: '2026-04-29T08:02:00.000Z',
    }, 10)).toBe(true);

    expect(listChatMessages(7, 10, undefined, 10).messages[0].text).toBe('Tenant A updated');
    expect(listChatMessages(7, 10, undefined, 11).messages[0].text).toBe('Tenant B original');
  });

  it('clears chat history only inside the matching tenant scope', () => {
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'tenant-a',
      role: 'assistant',
      text: 'Tenant A',
      timestamp: '2026-04-29T08:00:00.000Z',
    });
    storeChatMessage({
      tenantId: 11,
      userId: 7,
      messageId: 'tenant-b',
      role: 'assistant',
      text: 'Tenant B',
      timestamp: '2026-04-29T08:01:00.000Z',
    });

    clearChatHistory(7, 10);

    expect(listChatMessages(7, 10, undefined, 10).messages).toEqual([]);
    expect(listChatMessages(7, 10, undefined, 11).messages).toEqual([
      expect.objectContaining({ id: 'tenant-b', text: 'Tenant B' }),
    ]);
  });

  it('does not expose quarantined legacy rows through active chat history', () => {
    testDb.prepare(`
      INSERT INTO messages (
        tenant_id, user_id, visibility_scope, scope_status, created_by,
        message_uuid, role, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(0, 7, 'system_internal', 'quarantined', null, 'legacy-ambiguous', 'assistant', 'Legacy secret', '2026-04-29T08:00:00.000Z');

    expect(listChatMessages(7, 10, undefined, 7).messages).toEqual([]);
  });

  it('rejects writes without a valid user scope', () => {
    expect(() => storeChatMessage({
      tenantId: 0,
      userId: 0,
      messageId: 'bad',
      role: 'user',
      text: 'should not persist',
    })).toThrow(/CHAT_SCOPE_INVALID/);
  });

  it('stores lifecycle metadata and finds completed assistant exchanges by client message id', () => {
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'msg-user-client-1',
      role: 'user',
      text: 'plan my day',
      lifecycleState: 'sent',
      clientMessageId: 'client-1',
      requestId: 'req-1',
      timestamp: '2026-04-29T08:00:00.000Z',
    });
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'msg-assistant-client-1',
      role: 'assistant',
      text: 'Here is the plan.',
      domain: 'secretary',
      lifecycleState: 'completed',
      retryOfMessageId: 'msg-user-client-1',
      requestId: 'req-1',
      timestamp: '2026-04-29T08:00:01.000Z',
    });

    const replay = findCompletedAssistantForClientMessage(7, 'client-1', 10);
    expect(replay).toMatchObject({
      userMessageId: 'msg-user-client-1',
      assistantMessage: {
        id: 'msg-assistant-client-1',
        text: 'Here is the plan.',
        lifecycleState: 'completed',
        retryOfMessageId: 'msg-user-client-1',
      },
    });
  });

  it('claims client messages once and rejects idempotency key text reuse', () => {
    expect(claimUserChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'msg-user-client-claim',
      text: 'plan my day',
      clientMessageId: 'client-claim',
      requestId: 'req-claim-1',
      timestamp: '2026-04-29T08:00:00.000Z',
    })).toEqual({
      status: 'claimed',
      messageId: 'msg-user-client-claim',
      existingLifecycleState: 'sent',
    });

    expect(claimUserChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'msg-user-client-claim',
      text: 'plan my day',
      clientMessageId: 'client-claim',
      requestId: 'req-claim-2',
    })).toEqual({
      status: 'duplicate',
      messageId: 'msg-user-client-claim',
      existingLifecycleState: 'sent',
    });

    expect(claimUserChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'msg-user-client-claim',
      text: 'different text',
      clientMessageId: 'client-claim',
      requestId: 'req-claim-3',
    })).toMatchObject({
      status: 'conflict',
      messageId: 'msg-user-client-claim',
    });
  });

  it('allows a repaired failed user message to be retried without creating a second user row', () => {
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'msg-user-retry',
      role: 'user',
      text: 'try again',
      lifecycleState: 'canceled',
      clientMessageId: 'client-retry',
      timestamp: '2026-04-29T08:00:00.000Z',
    });

    expect(claimUserChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'msg-user-retry',
      text: 'try again',
      clientMessageId: 'client-retry',
      requestId: 'req-retry',
    })).toEqual({
      status: 'claimed',
      messageId: 'msg-user-retry',
      existingLifecycleState: 'canceled',
    });

    const messages = listChatMessages(7, 10, undefined, 10).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'msg-user-retry',
      lifecycleState: 'retried',
      requestId: 'req-retry',
      errorCode: null,
    });
  });

  it('does not duplicate rows when the same message uuid is retried', () => {
    const entry = {
      tenantId: 10,
      userId: 7,
      messageId: 'same-message',
      role: 'user' as const,
      text: 'first',
      clientMessageId: 'client-dup',
      timestamp: '2026-04-29T08:00:00.000Z',
    };
    storeChatMessage(entry);
    storeChatMessage({ ...entry, text: 'retry text should not create a duplicate' });

    expect(listChatMessages(7, 10, undefined, 10).messages).toHaveLength(1);
    expect(listChatMessages(7, 10, undefined, 10).messages[0]).toMatchObject({
      id: 'same-message',
      text: 'first',
    });
  });

  it('marks lifecycle states inside tenant scope only', () => {
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'assistant-tenant-a',
      role: 'assistant',
      text: 'Streaming',
      lifecycleState: 'streaming',
      timestamp: '2026-04-29T08:00:00.000Z',
    });

    expect(markMessageLifecycle(7, 'assistant-tenant-a', 'failed', 11, {
      errorCode: 'WRONG_TENANT',
      timestamp: '2026-04-29T08:05:00.000Z',
    })).toBe(false);
    expect(markMessageLifecycle(7, 'assistant-tenant-a', 'failed', 10, {
      errorCode: 'STREAM_INTERRUPTED',
      errorMessage: 'Stream disconnected',
      timestamp: '2026-04-29T08:05:00.000Z',
    })).toBe(true);

    expect(listChatMessages(7, 10, undefined, 10).messages[0]).toMatchObject({
      id: 'assistant-tenant-a',
      lifecycleState: 'failed',
      errorCode: 'STREAM_INTERRUPTED',
    });
  });

  it('repairs stuck streaming assistant messages and unanswered sent user messages', () => {
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'stuck-assistant',
      role: 'assistant',
      text: 'Partial',
      lifecycleState: 'streaming',
      timestamp: '2026-04-29T08:00:00.000Z',
    });
    storeChatMessage({
      tenantId: 10,
      userId: 7,
      messageId: 'unanswered-user',
      role: 'user',
      text: 'What happened?',
      lifecycleState: 'sent',
      timestamp: '2026-04-29T08:00:00.000Z',
    });

    const result = repairStuckChatMessages(7, 10, {
      olderThanMs: 60_000,
      now: new Date('2026-04-29T08:10:00.000Z'),
    });

    expect(result).toEqual({ failedMessages: 1, canceledMessages: 1 });
    const messages = listChatMessages(7, 10, undefined, 10).messages;
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stuck-assistant', lifecycleState: 'failed', errorCode: 'STREAM_INTERRUPTED' }),
      expect.objectContaining({ id: 'unanswered-user', lifecycleState: 'canceled', errorCode: 'UNANSWERED_DRAFT_REPAIRED' }),
    ]));
  });
});
