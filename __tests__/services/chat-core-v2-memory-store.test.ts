import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { MemoryItem } from '../../src/services/chat-core-v2';
import {
  ensureChatCoreV2MemoryTables,
  getChatV2MemoryItem,
  listChatV2MemoryItems,
  setChatV2MemoryStatus,
  upsertChatV2MemoryItem,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const baseMemory: MemoryItem = {
  memoryId: 'memory-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  type: 'domain_preference',
  domain: 'training',
  value: 'User prefers not to train before 08:00.',
  sourceTurnId: 'turn-1',
  confidence: 0.82,
  sensitivity: 'health_adjacent',
  status: 'needs_confirmation',
  createdAt: '2026-05-24T10:00:00.000Z',
  updatedAt: '2026-05-24T10:00:00.000Z',
};

describe('Chat Core v2 memory store', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates scoped memory tables with status and sensitivity columns', () => {
    ensureChatCoreV2MemoryTables(db);

    const columns = db.prepare('PRAGMA table_info(chat_v2_memory_items)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain('memory_id');
    expect(names).toContain('tenant_id');
    expect(names).toContain('user_id');
    expect(names).toContain('confidence');
    expect(names).toContain('sensitivity');
    expect(names).toContain('status');
    expect(names).not.toContain('raw_prompt');
    expect(names).not.toContain('provider_payload_json');
  });

  it('upserts model-proposed memory without duplicating rows', () => {
    const first = upsertChatV2MemoryItem(baseMemory, db);
    const second = upsertChatV2MemoryItem({
      ...baseMemory,
      value: 'User prefers afternoon training.',
      confidence: 0.91,
      status: 'active',
      updatedAt: '2026-05-24T10:10:00.000Z',
    }, db);

    const count = db.prepare('SELECT COUNT(*) as count FROM chat_v2_memory_items WHERE memory_id = ?')
      .get('memory-1') as { count: number };

    expect(first.status).toBe('needs_confirmation');
    expect(second.value).toBe('User prefers afternoon training.');
    expect(second.confidence).toBe(0.91);
    expect(second.status).toBe('active');
    expect(count.count).toBe(1);
  });

  it('lists active, non-expired memory by tenant and user scope', () => {
    upsertChatV2MemoryItem({
      ...baseMemory,
      memoryId: 'active-training',
      status: 'active',
      updatedAt: '2026-05-24T10:30:00.000Z',
      expiresAt: '2026-05-25T10:00:00.000Z',
    }, db);
    upsertChatV2MemoryItem({
      ...baseMemory,
      memoryId: 'expired-training',
      status: 'active',
      updatedAt: '2026-05-24T10:20:00.000Z',
      expiresAt: '2026-05-24T09:59:00.000Z',
    }, db);
    upsertChatV2MemoryItem({
      ...baseMemory,
      memoryId: 'other-tenant',
      tenantId: 'tenant-2',
      status: 'active',
    }, db);
    upsertChatV2MemoryItem({
      ...baseMemory,
      memoryId: 'tasks-memory',
      domain: 'tasks',
      type: 'user_preference',
      value: 'User likes short task titles.',
      status: 'active',
      sensitivity: 'personal',
      updatedAt: '2026-05-24T10:40:00.000Z',
    }, db);

    const training = listChatV2MemoryItems({ userId: 'user-1', tenantId: 'tenant-1' }, db, {
      domain: 'training',
      now: '2026-05-24T10:00:00.000Z',
    });
    const allActive = listChatV2MemoryItems({ userId: 'user-1', tenantId: 'tenant-1' }, db, {
      now: '2026-05-24T10:00:00.000Z',
    });

    expect(training.map((memory) => memory.memoryId)).toEqual(['active-training']);
    expect(allActive.map((memory) => memory.memoryId)).toEqual(['tasks-memory', 'active-training']);
  });

  it('supports scoped status transitions without crossing tenant boundaries', () => {
    upsertChatV2MemoryItem({
      ...baseMemory,
      status: 'active',
    }, db);

    const wrongTenant = setChatV2MemoryStatus('memory-1', { userId: 'user-1', tenantId: 'tenant-2' }, 'superseded', db);
    const updated = setChatV2MemoryStatus(
      'memory-1',
      { userId: 'user-1', tenantId: 'tenant-1' },
      'superseded',
      db,
      '2026-05-24T11:00:00.000Z',
    );
    const active = listChatV2MemoryItems({ userId: 'user-1', tenantId: 'tenant-1' }, db);
    const superseded = listChatV2MemoryItems({ userId: 'user-1', tenantId: 'tenant-1' }, db, {
      status: 'superseded',
    });

    expect(wrongTenant).toBeNull();
    expect(updated?.status).toBe('superseded');
    expect(updated?.updatedAt).toBe('2026-05-24T11:00:00.000Z');
    expect(active).toHaveLength(0);
    expect(superseded).toHaveLength(1);
  });

  it('keeps memory reads scoped by tenant and user', () => {
    upsertChatV2MemoryItem({
      ...baseMemory,
      status: 'active',
    }, db);
    upsertChatV2MemoryItem({
      ...baseMemory,
      tenantId: 'tenant-2',
      status: 'active',
      value: 'Different tenant can reuse the same memory id safely.',
    }, db);

    expect(getChatV2MemoryItem('memory-1', { userId: 'user-1', tenantId: 'tenant-1' }, db)?.value)
      .toBe('User prefers not to train before 08:00.');
    expect(getChatV2MemoryItem('memory-1', { userId: 'user-2', tenantId: 'tenant-1' }, db)).toBeNull();
    expect(getChatV2MemoryItem('memory-1', { userId: 'user-1', tenantId: 'tenant-2' }, db)?.value)
      .toBe('Different tenant can reuse the same memory id safely.');
  });

  it('rejects invalid memory metadata before SQLite constraints', () => {
    expect(() => upsertChatV2MemoryItem({
      ...baseMemory,
      confidence: 1.2,
    }, db)).toThrow(/confidence/);

    expect(() => upsertChatV2MemoryItem({
      ...baseMemory,
      type: 'profile' as MemoryItem['type'],
    }, db)).toThrow(/type/);

    expect(() => upsertChatV2MemoryItem({
      ...baseMemory,
      domain: 'health' as MemoryItem['domain'],
    }, db)).toThrow(/domain/);

    expect(() => setChatV2MemoryStatus(
      'memory-1',
      { userId: 'user-1', tenantId: 'tenant-1' },
      'pending' as MemoryItem['status'],
      db,
    )).toThrow(/status/);
  });
});
