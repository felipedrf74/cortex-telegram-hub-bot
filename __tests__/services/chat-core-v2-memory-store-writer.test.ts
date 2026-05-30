import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  CHAT_CORE_V2_MEMORY_STORED_VALUE_MAX_CHARS,
  ensureChatCoreV2MemoryTables,
  listChatV2MemoryItems,
  resolveChatV2MemorySensitivity,
  tryWriteChatV2MemoryFromTurnOutcome,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const ON_ENV = { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' } as Record<string, string | undefined>;

function rowsFor(tenantId: string, userId: string) {
  return listChatV2MemoryItems({ tenantId, userId }, db, { status: 'active', includeExpired: true });
}

describe('Chat Core v2 memory store writer (WP-17)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatCoreV2MemoryTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('writes a decision_rationale item on a verified outcome', () => {
    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'verified',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: 'created the gym session for tomorrow',
      domain: 'training',
      sourceTurnId: 'turn-verified-1',
      env: ON_ENV,
      now: '2026-05-30T10:00:00.000Z',
    }, db);

    const rows = rowsFor('tenant-1', 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('decision_rationale');
    expect(rows[0].value).toBe('created the gym session for tomorrow');
    expect(rows[0].status).toBe('active');
    expect(rows[0].sourceTurnId).toBe('turn-verified-1');
  });

  it('writes a user_correction item on a correction outcome', () => {
    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'correction',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: 'no, I meant the 7am run not the swim',
      domain: 'training',
      sourceTurnId: 'turn-correction-1',
      env: ON_ENV,
    }, db);

    const rows = rowsFor('tenant-1', 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('user_correction');
    expect(rows[0].value).toBe('no, I meant the 7am run not the swim');
  });

  it('does NOT write on a failed/empty outcome (no value)', () => {
    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'verified',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: '   ',
      sourceTurnId: 'turn-empty',
      env: ON_ENV,
    }, db);
    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'verified',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: 'has value',
      sourceTurnId: '   ',
      env: ON_ENV,
    }, db);

    expect(rowsFor('tenant-1', 'user-1')).toHaveLength(0);
  });

  it('is idempotent: the same outcome+turn produces the same deterministic memoryId (no duplicate row)', () => {
    const write = () => tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'correction',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: 'first write',
      domain: 'tasks',
      sourceTurnId: 'turn-idem',
      env: ON_ENV,
    }, db);
    write();
    // Re-run the SAME turn outcome (a retry) — must update in place, not insert.
    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'correction',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: 'second write same turn',
      domain: 'tasks',
      sourceTurnId: 'turn-idem',
      env: ON_ENV,
    }, db);

    const rows = rowsFor('tenant-1', 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('second write same turn');

    const distinctIds = db.prepare(
      'SELECT COUNT(DISTINCT memory_id) AS c FROM chat_v2_memory_items',
    ).get() as { c: number };
    expect(distinctIds.c).toBe(1);
  });

  it('maps domain to sensitivity (financial/health_adjacent/credential_adjacent/personal)', () => {
    expect(resolveChatV2MemorySensitivity('finance')).toBe('financial');
    expect(resolveChatV2MemorySensitivity('training')).toBe('health_adjacent');
    expect(resolveChatV2MemorySensitivity('connections')).toBe('credential_adjacent');
    expect(resolveChatV2MemorySensitivity('tasks')).toBe('personal');
    expect(resolveChatV2MemorySensitivity(undefined)).toBe('personal');

    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'verified',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: 'set the monthly budget cap',
      domain: 'finance',
      sourceTurnId: 'turn-finance',
      env: ON_ENV,
    }, db);
    expect(rowsFor('tenant-1', 'user-1')[0].sensitivity).toBe('financial');
  });

  it('truncates an over-long stored value to the at-rest cap', () => {
    const huge = 'x'.repeat(CHAT_CORE_V2_MEMORY_STORED_VALUE_MAX_CHARS + 500);
    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'correction',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: huge,
      sourceTurnId: 'turn-huge',
      env: ON_ENV,
    }, db);

    const rows = rowsFor('tenant-1', 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].value.length).toBe(CHAT_CORE_V2_MEMORY_STORED_VALUE_MAX_CHARS);
  });

  it('does NOT write when mode=off (kill-switch) and never throws', () => {
    expect(() => tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'verified',
      tenantId: 'tenant-1',
      userId: 'user-1',
      value: 'should not be stored',
      sourceTurnId: 'turn-off',
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' },
    }, db)).not.toThrow();

    expect(rowsFor('tenant-1', 'user-1')).toHaveLength(0);
  });

  it('coerces numeric tenant/user ids to strings at the boundary', () => {
    tryWriteChatV2MemoryFromTurnOutcome({
      outcome: 'verified',
      tenantId: 7 as unknown as string,
      userId: 42 as unknown as string,
      value: 'numeric ids',
      sourceTurnId: 'turn-numeric',
      env: ON_ENV,
    }, db);

    const rows = rowsFor('7', '42');
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe('7');
    expect(rows[0].userId).toBe('42');
  });
});
