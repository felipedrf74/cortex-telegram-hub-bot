import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  dismissSignal,
  getSignalLog,
  readRankedSignals,
  setDbProvider,
} from '../../src/services/intelligence-bus';

let testDb: Database.Database;

function insertSignal(input: { id?: number; userId: number | null; tenantId: number | null; type?: string }): number {
  const info = testDb.prepare(`
    INSERT INTO agent_signals (
      id, source_agent, signal_type, payload, priority, consumed_by, status,
      expires_at, tenant_id, user_id, confidence, evidence_count
    )
    VALUES (?, 'test', ?, '{}', 'normal', '[]', 'active', datetime('now', '+1 day'), ?, ?, 0.9, 1)
  `).run(input.id ?? null, input.type ?? 'voice_pattern', input.tenantId, input.userId);
  return Number(info.lastInsertRowid);
}

describe('intelligence bus tenant scope', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE agent_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_agent TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        consumed_by TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        tenant_id INTEGER,
        user_id INTEGER,
        confidence REAL DEFAULT 0.5,
        format_tag TEXT,
        pillar_tag TEXT,
        evidence_count INTEGER DEFAULT 1,
        mesh_priority INTEGER
      );
    `);
    setDbProvider(() => testDb as any);
  });

  it('assertNoOtherTenantSignals: scoped reads do not enumerate another tenant', () => {
    insertSignal({ userId: 10, tenantId: 10 });
    insertSignal({ userId: 20, tenantId: 20 });

    const rows = getSignalLog(10, 10, 10);

    expect(rows.map((row) => row.user_id)).toEqual([10]);
  });

  it('ranked signal reads require and apply tenant scope', () => {
    insertSignal({ userId: 10, tenantId: 10, type: 'voice_pattern' });
    insertSignal({ userId: 20, tenantId: 20, type: 'voice_pattern' });

    const ranked = readRankedSignals('test-consumer', ['voice_pattern'], {
      userId: 10,
      tenantId: 10,
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].tenant_id).toBe(10);
    expect(ranked[0].user_id).toBe(10);
  });

  it('does not let user B dismiss user A signals', () => {
    const signalA = insertSignal({ userId: 10, tenantId: 10 });

    const changedByB = dismissSignal(signalA, 20, 20);
    const changedByA = dismissSignal(signalA, 10, 10);

    expect(changedByB).toBe(0);
    expect(changedByA).toBe(1);
    const row = testDb.prepare('SELECT status FROM agent_signals WHERE id = ?').get(signalA) as { status: string };
    expect(row.status).toBe('dismissed');
  });
});
