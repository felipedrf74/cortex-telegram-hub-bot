import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  dismissSignal,
  expireStaleSignals,
  GovernedSignalWriteError,
  getActiveSignalCount,
  getSignalLog,
  readActiveScopedSignalsBySource,
  readSignals,
  readRankedSignals,
  reconcileGovernedSignalSet,
  runSignalWriteTransaction,
  setDbProvider,
  writeGovernedSignal,
} from '../../src/services/intelligence-bus';

let testDb: Database.Database;

function expectGovernedWriteError(
  write: () => unknown,
  code: GovernedSignalWriteError['code'],
): void {
  try {
    write();
    throw new Error('Expected governed signal write to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(GovernedSignalWriteError);
    expect((error as GovernedSignalWriteError).code).toBe(code);
  }
}

function insertSignal(input: {
  id?: number;
  userId: number | null;
  tenantId: number | null;
  type?: string;
  sourceAgent?: string;
}): number {
  const info = testDb.prepare(`
    INSERT INTO agent_signals (
      id, source_agent, signal_type, payload, priority, consumed_by, status,
      expires_at, tenant_id, user_id, confidence, evidence_count
    )
    VALUES (?, ?, ?, '{}', 'normal', '[]', 'active', datetime('now', '+1 day'), ?, ?, 0.9, 1)
  `).run(input.id ?? null, input.sourceAgent ?? 'test', input.type ?? 'voice_pattern', input.tenantId, input.userId);
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
        mesh_priority INTEGER,
        signal_identity TEXT,
        provenance_json TEXT
      );
    `);
    setDbProvider(() => testDb as any);
  });

  it('persists explicit provenance for governed writes', () => {
    const observedAt = new Date(Date.now() - 1_000).toISOString();
    const id = writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: { pattern: 'concise openings' },
      user_id: 10,
      tenant_id: 10,
      confidence: 0.8,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime',
        observedAt,
      },
    });

    expect(id).toBeGreaterThan(0);
    const row = testDb.prepare(`
      SELECT payload, confidence, signal_identity, provenance_json
        FROM agent_signals
       WHERE id = ?
    `).get(id) as {
      payload: string;
      confidence: number;
      signal_identity: string;
      provenance_json: string;
    };
    expect(JSON.parse(row.payload)._signalProvenance).toEqual({
      producerVersion: 'intelligence-bus-test.v1',
      source: 'runtime',
      observedAt,
    });
    expect(row.confidence).toBe(0.8);
    expect(row.signal_identity).toMatch(/^sig_[a-f0-9]{64}$/);
    expect(JSON.parse(row.provenance_json)).toEqual({
      producerVersion: 'intelligence-bus-test.v1',
      source: 'runtime',
      observedAt,
    });
  });

  it('uses stable payload ordering while keeping signal identity scoped by tenant', () => {
    const common = {
      source_agent: 'test-agent',
      signal_type: 'voice_pattern' as const,
      user_id: 10,
      confidence: 0.8,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime' as const,
        observedAt: new Date().toISOString(),
      },
    };
    const first = writeGovernedSignal({
      ...common,
      tenant_id: 10,
      payload: { b: 2, nested: { z: true, a: 'x' }, a: 1 },
    });
    const reordered = writeGovernedSignal({
      ...common,
      tenant_id: 10,
      payload: { a: 1, nested: { a: 'x', z: true }, b: 2 },
    });
    const otherTenant = writeGovernedSignal({
      ...common,
      tenant_id: 20,
      payload: { a: 1, nested: { a: 'x', z: true }, b: 2 },
    });
    const identities = testDb.prepare(`
      SELECT id, signal_identity AS identity
        FROM agent_signals
       WHERE id IN (?, ?, ?)
       ORDER BY id
    `).all(first, reordered, otherTenant) as Array<{ id: number; identity: string }>;

    expect(identities[0].identity).toBe(identities[1].identity);
    expect(identities[2].identity).not.toBe(identities[0].identity);
  });

  it('rolls back a governed signal replacement as one transaction', () => {
    const id = writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: { pattern: 'original' },
      user_id: 10,
      tenant_id: 10,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime',
        observedAt: new Date().toISOString(),
      },
    });

    expect(() => runSignalWriteTransaction(() => {
      const replacementId = writeGovernedSignal({
        source_agent: 'test-agent',
        signal_type: 'voice_pattern',
        payload: { pattern: 'replacement' },
        user_id: 10,
        tenant_id: 10,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        provenance: {
          producerVersion: 'intelligence-bus-test.v1',
          source: 'runtime',
          observedAt: new Date().toISOString(),
        },
      });
      expect(reconcileGovernedSignalSet({
        sourceAgent: 'test-agent',
        userId: 10,
        tenantId: 10,
        keepSignalIds: [replacementId],
      })).toBe(1);
      throw new Error('simulate replacement failure');
    })).toThrow('simulate replacement failure');

    expect(testDb.prepare('SELECT id, status FROM agent_signals ORDER BY id').all()).toEqual([
      { id, status: 'active' },
    ]);
  });

  it('reconciles a complete producer set within the exact user and tenant scope', () => {
    const keep = insertSignal({ userId: 10, tenantId: 10 });
    const stale = insertSignal({ userId: 10, tenantId: 10 });
    const otherUser = insertSignal({ userId: 20, tenantId: 10 });
    const otherTenant = insertSignal({ userId: 10, tenantId: 20 });

    expect(reconcileGovernedSignalSet({
      sourceAgent: 'test',
      userId: 10,
      tenantId: 10,
      keepSignalIds: [keep],
    })).toBe(1);
    expect(testDb.prepare('SELECT id, status FROM agent_signals ORDER BY id').all()).toEqual([
      { id: keep, status: 'active' },
      { id: stale, status: 'dismissed' },
      { id: otherUser, status: 'active' },
      { id: otherTenant, status: 'active' },
    ]);

    expect(reconcileGovernedSignalSet({
      sourceAgent: 'test',
      userId: 10,
      tenantId: 10,
      keepSignalIds: [],
    })).toBe(1);
    expect(testDb.prepare('SELECT status FROM agent_signals WHERE id = ?').get(keep))
      .toEqual({ status: 'dismissed' });
  });

  it('normalizes a compatibility source identity before persistence', () => {
    const id = writeGovernedSignal({
      source_agent: '  TEST-AGENT  ',
      signal_type: 'voice_pattern',
      payload: { pattern: 'bounded identity' },
      user_id: 10,
      tenant_id: 10,
      confidence: 0.8,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime',
        observedAt: new Date(Date.now() - 1_000).toISOString(),
      },
    });

    expect(testDb.prepare('SELECT source_agent FROM agent_signals WHERE id = ?').get(id))
      .toEqual({ source_agent: 'test-agent' });
  });

  it.each([
    ['missing provenance', undefined],
    ['unversioned producer', { producerVersion: 'intelligence-bus-test', source: 'runtime', observedAt: new Date().toISOString() }],
    ['invalid source', { producerVersion: 'intelligence-bus-test.v1', source: 'assumed', observedAt: new Date().toISOString() }],
    ['invalid observation time', { producerVersion: 'intelligence-bus-test.v1', source: 'runtime', observedAt: 'not-a-date' }],
  ])('rejects %s on governed writes', (_label, provenance) => {
    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 10,
      tenant_id: 10,
      provenance,
    } as any), 'invalid_provenance');

    expect(testDb.prepare('SELECT COUNT(*) AS count FROM agent_signals').get()).toEqual({ count: 0 });
  });

  it.each([
    'performance-agent',
    'performance_agent',
    'reaction-radar',
    'reaction-radar-agent',
    'reaction_radar',
    'reaction_radar_agent',
    'seo-agent',
    'seo_agent',
  ])(
    'rejects governed writes from paused Content producer identity %s before persistence',
    (sourceAgent) => {
      expectGovernedWriteError(() => writeGovernedSignal({
        source_agent: sourceAgent,
        signal_type: 'content_formula',
        payload: {},
        provenance: {
          producerVersion: 'intelligence-bus-test.v1',
          source: 'runtime',
          observedAt: new Date().toISOString(),
        },
      }), 'paused_source_agent');

      expect(testDb.prepare('SELECT COUNT(*) AS count FROM agent_signals').get()).toEqual({ count: 0 });
    },
  );

  it.each([-0.01, 1.01, Number.NaN])('rejects invalid governed confidence %s', (confidence) => {
    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 10,
      tenant_id: 10,
      confidence,
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime',
        observedAt: new Date().toISOString(),
      },
    }), 'invalid_confidence');
  });

  it.each([
    ['invalid timestamp', 'not-a-date', 'invalid_expiry'],
    ['already expired', new Date(Date.now() - 60_000).toISOString(), 'expired_signal'],
  ] as const)('rejects governed expiry that is %s', (_label, expiresAt, code) => {
    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 10,
      tenant_id: 10,
      expires_at: expiresAt,
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime',
        observedAt: new Date().toISOString(),
      },
    }), code);
  });

  it('rejects governed writes that violate signal scope', () => {
    const provenance = {
      producerVersion: 'intelligence-bus-test.v1',
      source: 'runtime' as const,
      observedAt: new Date().toISOString(),
    };

    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      provenance,
    }), 'missing_user_scope');
    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'pipeline_capacity',
      payload: {},
      provenance,
    }), 'missing_user_scope');
    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 10,
      tenant_id: 0,
      provenance,
    }), 'invalid_tenant_scope');
    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 10,
      tenant_id: 10.5,
      provenance,
    }), 'invalid_tenant_scope');
    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 10.5,
      tenant_id: 10,
      provenance,
    }), 'missing_user_scope');
  });

  it('throws a typed persistence error when the bus cannot write', () => {
    setDbProvider(() => {
      throw new Error('database unavailable');
    });

    expectGovernedWriteError(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 10,
      tenant_id: 10,
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime',
        observedAt: new Date().toISOString(),
      },
    }), 'write_rejected');
  });

  it('isolates two users inside the same explicit tenant', () => {
    const provenance = {
      producerVersion: 'intelligence-bus-test.v1',
      source: 'runtime' as const,
      observedAt: new Date().toISOString(),
    };
    writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: { owner: 'a' },
      user_id: 10,
      tenant_id: 99,
      provenance,
    });
    writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: { owner: 'b' },
      user_id: 20,
      tenant_id: 99,
      provenance,
    });

    expect(readSignals('reader-a', ['voice_pattern'], 10, 10, undefined, 99)
      .map((signal) => signal.payload.owner)).toEqual(['a']);
    expect(readSignals('reader-b', ['voice_pattern'], 10, 20, undefined, 99)
      .map((signal) => signal.payload.owner)).toEqual(['b']);
    expect(readSignals('wrong-tenant', ['voice_pattern'], 10, 10, undefined, 100)).toEqual([]);
  });

  it('excludes expired active rows from flat, ranked, and count reads before cleanup runs', () => {
    testDb.prepare(`
      INSERT INTO agent_signals (
        source_agent, signal_type, payload, priority, consumed_by, status,
        expires_at, tenant_id, user_id, confidence, evidence_count
      ) VALUES (
        'test', 'voice_pattern', '{"owner":"expired"}', 'urgent', '[]', 'active',
        ?, 10, 10, 1.0, 1
      )
    `).run(new Date(Date.now() - 60_000).toISOString());
    insertSignal({ userId: 10, tenantId: 10, type: 'voice_pattern' });

    expect(readSignals('flat', ['voice_pattern'], 10, 10, undefined, 10)
      .map((signal) => signal.payload.owner)).not.toContain('expired');
    expect(readRankedSignals('ranked', ['voice_pattern'], { userId: 10, tenantId: 10 })
      .map((signal) => signal.payload.owner)).not.toContain('expired');
    expect(getActiveSignalCount(10, 10)).toBe(1);
  });

  it('keeps the documented legacy user-as-tenant fallback when tenant is unavailable', () => {
    const id = writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 33,
      provenance: {
        producerVersion: 'intelligence-bus-test.v1',
        source: 'runtime',
        observedAt: new Date().toISOString(),
      },
    });

    expect(testDb.prepare('SELECT tenant_id, user_id FROM agent_signals WHERE id = ?').get(id))
      .toEqual({ tenant_id: 33, user_id: 33 });
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

  it('excludes paused hyphen and underscore source identities from scoped counts and rankings', () => {
    insertSignal({ userId: 10, tenantId: 10, sourceAgent: 'performance-agent' });
    insertSignal({ userId: 10, tenantId: 10, sourceAgent: 'seo_agent' });
    const activeId = insertSignal({ userId: 10, tenantId: 10, sourceAgent: 'voice-evolution' });
    insertSignal({ userId: 20, tenantId: 20, sourceAgent: 'voice-evolution' });

    const exclusion = ['performance_agent', 'seo-agent'];
    expect(getActiveSignalCount(10, 10, { excludeSourceAgents: exclusion })).toBe(1);
    expect(readRankedSignals('test-consumer', ['voice_pattern'], {
      userId: 10,
      tenantId: 10,
      excludeSourceAgents: exclusion,
    }).map((signal) => signal.id)).toEqual([activeId]);
  });

  it('excludes paused source aliases before the flat-read limit is applied', () => {
    const pausedHyphenId = insertSignal({
      userId: 10,
      tenantId: 10,
      sourceAgent: 'performance-agent',
    });
    const pausedUnderscoreId = insertSignal({
      userId: 10,
      tenantId: 10,
      sourceAgent: 'SEO_agent',
    });
    const pausedHistoricalRuntimeId = insertSignal({
      userId: 10,
      tenantId: 10,
      sourceAgent: 'reaction-radar-agent',
    });
    const activeId = insertSignal({
      userId: 10,
      tenantId: 10,
      sourceAgent: 'voice-evolution',
    });
    testDb.prepare("UPDATE agent_signals SET created_at = datetime('now', '+3 minutes') WHERE id = ?").run(pausedHyphenId);
    testDb.prepare("UPDATE agent_signals SET created_at = datetime('now', '+2 minutes') WHERE id = ?").run(pausedUnderscoreId);
    testDb.prepare("UPDATE agent_signals SET created_at = datetime('now', '+1 minute') WHERE id = ?").run(pausedHistoricalRuntimeId);
    testDb.prepare("UPDATE agent_signals SET created_at = datetime('now', '-3 minutes') WHERE id = ?").run(activeId);

    expect(readSignals(
      'flat-reader',
      ['voice_pattern'],
      1,
      10,
      undefined,
      10,
      { excludeSourceAgents: ['performance_agent', 'reaction_radar', 'seo-agent'] },
    ).map((signal) => signal.id)).toEqual([activeId]);
    expect(getSignalLog(
      1,
      10,
      10,
      { excludeSourceAgents: ['performance_agent', 'reaction_radar', 'seo-agent'] },
    ).map((signal) => signal.id)).toEqual([activeId]);
  });

  it('excludes whitespace-padded historical paused aliases before limiting', () => {
    const pausedId = insertSignal({
      userId: 10,
      tenantId: 10,
      sourceAgent: '  reaction-radar-agent  ',
    });
    const activeId = insertSignal({
      userId: 10,
      tenantId: 10,
      sourceAgent: 'voice-evolution',
    });
    testDb.prepare("UPDATE agent_signals SET created_at = datetime('now', '+1 minute') WHERE id = ?").run(pausedId);

    expect(readSignals(
      'flat-reader',
      ['voice_pattern'],
      1,
      10,
      undefined,
      10,
      { excludeSourceAgents: ['reaction_radar'] },
    ).map((signal) => signal.id)).toEqual([activeId]);
  });

  it('excludes legacy and paused-input learning digests from decision-visible counts', () => {
    const activeId = insertSignal({ userId: 10, tenantId: 10, sourceAgent: 'voice-evolution' });
    const insertDigest = testDb.prepare(`
      INSERT INTO agent_signals (
        source_agent, signal_type, payload, priority, consumed_by, status,
        expires_at, tenant_id, user_id, confidence, evidence_count
      ) VALUES ('learning-digest', 'creator_learning_digest', ?, 'normal', '[]', 'active',
        datetime('now', '+1 day'), 10, 10, 0.9, 1)
    `);
    insertDigest.run(JSON.stringify({
      inputEligibility: {
        policyVersion: 'active-content-agent-sources.v1',
        sourceAgents: ['performance-agent'],
        sourceSignalIds: [activeId],
      },
      _signalProvenance: {
        producerVersion: 'cross-agent-learning.v3',
        source: 'runtime',
        observedAt: new Date().toISOString(),
      },
    }));
    insertDigest.run(JSON.stringify({
      inputEligibility: {
        policyVersion: 'active-content-agent-sources.v1',
        sourceAgents: ['voice-evolution'],
        sourceSignalIds: [activeId],
      },
      _signalProvenance: {
        producerVersion: 'cross-agent-learning.v3',
        source: 'runtime',
        observedAt: new Date().toISOString(),
      },
    }));

    expect(getActiveSignalCount(10, 10, {
      excludeIneligibleContentLearningDigests: true,
    })).toBe(2);
  });

  it('skips malformed active rows without hiding valid eligible signal counts', () => {
    const validId = insertSignal({ userId: 10, tenantId: 10, sourceAgent: 'voice-evolution' });
    testDb.prepare(`
      INSERT INTO agent_signals (
        source_agent, signal_type, payload, priority, consumed_by, status,
        expires_at, tenant_id, user_id, confidence, evidence_count
      ) VALUES ('voice-evolution', 'voice_pattern', '{not-json', 'normal', '[]', 'active',
        datetime('now', '+1 day'), 10, 10, 0.9, 1)
    `).run();

    expect(getActiveSignalCount(10, 10, {
      excludeIneligibleContentLearningDigests: true,
    })).toBe(1);
    expect(readSignals('safe-reader', ['voice_pattern'], 10, 10, undefined, 10).map((row) => row.id)).toEqual([validId]);
    expect(getSignalLog(10, 10, 10).map((row) => row.id)).toEqual([validId]);
    expect(readRankedSignals('safe-ranked-reader', ['voice_pattern'], {
      userId: 10,
      tenantId: 10,
    }).map((row) => row.id)).toEqual([validId]);
  });

  it('treats same-day ISO expiries as stale before the cleanup sweep runs', () => {
    const currentId = insertSignal({ userId: 10, tenantId: 10, sourceAgent: 'voice-evolution' });
    const staleId = insertSignal({ userId: 10, tenantId: 10, sourceAgent: 'voice-evolution' });
    testDb.prepare('UPDATE agent_signals SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), staleId);

    expect(readSignals('fresh-reader', ['voice_pattern'], 10, 10, undefined, 10).map((row) => row.id)).toEqual([currentId]);
    expect(readRankedSignals('fresh-ranked-reader', ['voice_pattern'], {
      userId: 10,
      tenantId: 10,
    }).map((row) => row.id)).toEqual([currentId]);
    expect(getActiveSignalCount(10, 10)).toBe(1);

    expect(expireStaleSignals()).toBe(1);
    expect(testDb.prepare('SELECT status FROM agent_signals WHERE id = ?').get(staleId)).toEqual({ status: 'expired' });
  });

  it('reads every logically active row for an exact lifecycle producer without presentation limits', () => {
    for (let index = 0; index < 60; index += 1) {
      insertSignal({
        userId: 10,
        tenantId: 10,
        sourceAgent: 'mesh.finance-context',
        type: 'budget_remaining',
      });
    }
    insertSignal({
      userId: 10,
      tenantId: 10,
      sourceAgent: 'mesh.training-context',
      type: 'budget_remaining',
    });
    insertSignal({
      userId: 20,
      tenantId: 20,
      sourceAgent: 'mesh.finance-context',
      type: 'budget_remaining',
    });

    expect(readActiveScopedSignalsBySource({
      sourceAgent: 'mesh.finance-context',
      signalType: 'budget_remaining',
      userId: 10,
      tenantId: 10,
    }, { strict: true })).toHaveLength(60);
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

  it('dismisses only a platform-global row when no scope is supplied', () => {
    const globalId = insertSignal({ userId: null, tenantId: null, type: 'content_sprint_mode' });
    const tenantId = insertSignal({ userId: null, tenantId: 42, type: 'content_sprint_mode' });

    expect(dismissSignal(globalId)).toBe(1);
    expect(dismissSignal(tenantId)).toBe(0);
    expect(testDb.prepare('SELECT id, status FROM agent_signals ORDER BY id').all()).toEqual([
      { id: globalId, status: 'dismissed' },
      { id: tenantId, status: 'active' },
    ]);
  });
});

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolutePath] : [];
  });
}

describe('governed signal writer production contract', () => {
  it('prevents production source from referencing the legacy writer', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const intelligenceBusPath = path.join(sourceRoot, 'services', 'intelligence-bus.ts');
    const violations: string[] = [];

    for (const file of listTypeScriptFiles(sourceRoot)) {
      if (file === intelligenceBusPath) continue;
      const source = readFileSync(file, 'utf8');
      // Parsing every production module made this contract exceed the shared
      // runner timeout under coverage instrumentation. An identifier cannot
      // exist in a file that lacks its spelling, so use the text check only as
      // a lossless prefilter and keep the actual policy decision AST-based.
      if (!source.includes('writeSignal')) continue;
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === 'writeSignal') {
          const position = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          violations.push(`${path.relative(process.cwd(), file)}:${position.line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }

    expect(violations).toEqual([]);
  });
});
