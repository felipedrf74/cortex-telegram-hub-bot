// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// M13 durable conversation continuity: DB-backed active-domain pin with an
// in-process read cache. The DB (chat_conversation_state, migration 256) is
// the source of truth; the Map is a private read cache that must survive a
// simulated restart (Map reset) by falling back to the DB row.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;
let failDbAccess = false;

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (failDbAccess) throw new Error('database unavailable (simulated)');
    return testDb;
  },
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

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  CHAT_ACTIVE_DOMAIN_TTL_MS,
  CHAT_ANCHOR_ENTITY_TTL_MS,
  clearActiveChatDomain,
  getActiveChatDomain,
  getDurableChatContinuity,
  rememberActiveChatDomain,
  resetChatConversationStateForTests,
} from '../../src/services/chat-conversation-state';

const USER = 42;
const TENANT_A = 7;
const TENANT_B = 9;
const NOW = Date.parse('2026-07-20T12:00:00.000Z');

describe('chat-conversation-state (M13 durable continuity)', () => {
  beforeEach(() => {
    failDbAccess = false;
    testDb = createMigratedTestDatabase();
    resetChatConversationStateForTests();
  });

  it('migration 256 creates the expected schema and is idempotent', () => {
    const columns = testDb
      .prepare('PRAGMA table_info(chat_conversation_state)')
      .all() as Array<{ name: string; pk: number }>;
    const names = columns.map((column) => column.name);
    expect(names).toEqual([
      'tenant_id',
      'user_id',
      'conversation_id',
      'last_domain',
      'last_domain_at',
      'last_assistant_message_id',
      'anchor_entities_json',
      'updated_at',
    ]);
    const pkColumns = columns.filter((column) => column.pk > 0).map((column) => column.name);
    expect(pkColumns).toEqual(['tenant_id', 'user_id']);

    // Re-applying the migration SQL is a no-op (IF NOT EXISTS everywhere).
    const sql = readFileSync(
      join(process.cwd(), 'migrations/256_chat_conversation_state.sql'),
      'utf8',
    );
    expect(() => testDb.exec(sql)).not.toThrow();
    expect(() => testDb.exec(sql)).not.toThrow();
  });

  it('survives a restart: Map reset still returns the domain within TTL, null after TTL', () => {
    rememberActiveChatDomain(USER, 'secretary', NOW - 1_000, TENANT_A);

    // Simulate process restart: the in-memory cache is wiped, the DB row stays.
    resetChatConversationStateForTests();

    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBe('secretary');

    // A second restart plus an after-TTL read must expire exactly like the Map did.
    resetChatConversationStateForTests();
    expect(getActiveChatDomain(USER, NOW - 1_000 + CHAT_ACTIVE_DOMAIN_TTL_MS, TENANT_A)).toBeNull();
  });

  it('scopes rows by tenant: same user under another tenant never leaks (tenant_leak guard)', () => {
    rememberActiveChatDomain(USER, 'finance', NOW - 1_000, TENANT_A);
    resetChatConversationStateForTests();

    expect(getActiveChatDomain(USER, NOW, TENANT_B)).toBeNull();
    expect(getActiveChatDomain(USER, NOW)).toBeNull(); // default scope = userId tenant
    expect(getDurableChatContinuity(USER, TENANT_B, NOW)).toBeNull();
    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBe('finance');
  });

  it('clearActiveChatDomain clears the domain pin from cache and durable row', () => {
    rememberActiveChatDomain(USER, 'content', NOW - 1_000, TENANT_A);
    clearActiveChatDomain(USER, TENANT_A);

    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBeNull();
    resetChatConversationStateForTests();
    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBeNull();
    const continuity = getDurableChatContinuity(USER, TENANT_A, NOW);
    expect(continuity?.domain ?? null).toBeNull();
  });

  it('clearActiveChatDomain preserves conversation/assistant/anchor continuity (adversarial-review fix)', () => {
    rememberActiveChatDomain(USER, 'secretary', NOW - 1_000, TENANT_A, {
      conversationId: 'conv-keep',
      lastAssistantMessageId: 'assistant-keep',
      anchorEntityIds: ['task-keep'],
    });
    clearActiveChatDomain(USER, TENANT_A);
    resetChatConversationStateForTests();

    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBeNull();
    const continuity = getDurableChatContinuity(USER, TENANT_A, NOW);
    expect(continuity).not.toBeNull();
    expect(continuity?.domain).toBeNull();
    expect(continuity?.conversationId).toBe('conv-keep');
    expect(continuity?.lastAssistantMessageId).toBe('assistant-keep');
    expect(continuity?.anchorEntities.map((anchor) => anchor.entityId)).toEqual(['task-keep']);
  });

  it('fails open to the Map when the DB write fails: the turn continues', () => {
    failDbAccess = true;

    expect(() => rememberActiveChatDomain(USER, 'triathlon', NOW - 1_000, TENANT_A)).not.toThrow();
    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBe('triathlon');

    // Reads also fail open (no throw) when the DB is unavailable on a Map miss.
    resetChatConversationStateForTests();
    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBeNull();
  });

  it('getDurableChatContinuity returns the typed row with 30-minute anchor decay at read time', () => {
    rememberActiveChatDomain(USER, 'secretary', NOW - CHAT_ANCHOR_ENTITY_TTL_MS - 1_000, TENANT_A, {
      conversationId: 'conv-1',
      lastAssistantMessageId: 'assistant-msg-1',
      anchorEntityIds: ['task-old'],
    });
    rememberActiveChatDomain(USER, 'secretary', NOW - 1_000, TENANT_A, {
      anchorEntityIds: ['task-fresh', 'event-fresh'],
    });

    const continuity = getDurableChatContinuity(USER, TENANT_A, NOW);
    expect(continuity).not.toBeNull();
    expect(continuity?.userId).toBe(USER);
    expect(continuity?.tenantId).toBe(TENANT_A);
    expect(continuity?.conversationId).toBe('conv-1');
    expect(continuity?.domain).toBe('secretary');
    expect(continuity?.domainAt).toBe(NOW - 1_000);
    expect(continuity?.lastAssistantMessageId).toBe('assistant-msg-1');
    // task-old was referenced > 30 min ago — decayed at read time.
    expect(continuity?.anchorEntities.map((anchor) => anchor.entityId).sort()).toEqual([
      'event-fresh',
      'task-fresh',
    ]);

    // Domain honors the 5-minute TTL while anchors keep their own 30-minute decay.
    const later = getDurableChatContinuity(USER, TENANT_A, NOW + CHAT_ACTIVE_DOMAIN_TTL_MS);
    expect(later?.domain).toBeNull();
    expect(later?.anchorEntities.map((anchor) => anchor.entityId).sort()).toEqual([
      'event-fresh',
      'task-fresh',
    ]);
  });

  it('keeps a single durable row per (tenant, user) across repeated writes', () => {
    rememberActiveChatDomain(USER, 'secretary', NOW - 3_000, TENANT_A);
    rememberActiveChatDomain(USER, 'finance', NOW - 2_000, TENANT_A);
    rememberActiveChatDomain(USER, 'cooking', NOW - 1_000, TENANT_A);

    const rows = testDb
      .prepare('SELECT COUNT(*) AS count FROM chat_conversation_state WHERE tenant_id = ? AND user_id = ?')
      .get(TENANT_A, USER) as { count: number };
    expect(rows.count).toBe(1);
    resetChatConversationStateForTests();
    expect(getActiveChatDomain(USER, NOW, TENANT_A)).toBe('cooking');
  });
});
