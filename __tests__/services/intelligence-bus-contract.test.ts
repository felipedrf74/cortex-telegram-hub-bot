import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dismissSignal,
  expireStaleSignals,
  getActiveSignalCount,
  getAgentStats,
  getSignalLog,
  GovernedSignalWriteError,
  isAllowedSignalSourceAgent,
  logAgentRun,
  markConsumed,
  readRankedSignals,
  readSignals,
  setDbProvider,
  setPlanningInvalidator,
  setScopeAnomalyReporter,
  type AgentSignal,
  type ScopeAnomalyReport,
  type SignalType,
  writeGovernedSignal,
  writeSignal,
} from '../../src/services/intelligence-bus';

const NOW = new Date('2026-07-25T12:00:00.000Z');

type DbCall = {
  kind: 'run' | 'get' | 'all';
  sql: string;
  args: unknown[];
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function signalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    source_agent: 'test-agent',
    signal_type: 'voice_pattern',
    payload: JSON.stringify({
      observation: 'precise',
      _signalProvenance: {
        producerVersion: 'intelligence-contract.v1',
        source: 'runtime',
        observedAt: '2026-07-25T09:00:00.000Z',
      },
    }),
    priority: 'normal',
    consumed_by: '[]',
    status: 'active',
    created_at: '2026-07-25T10:00:00.000Z',
    expires_at: '2026-07-26T10:00:00.000Z',
    tenant_id: 42,
    user_id: 42,
    confidence: 0.8,
    format_tag: 'youtube',
    pillar_tag: 'engineering',
    evidence_count: 4,
    mesh_priority: 2,
    ...overrides,
  };
}

class RecordingDb {
  tenantColumn = true;
  calls: DbCall[] = [];
  selectedRows: Record<string, unknown>[] = [];
  statsRows: Record<string, unknown>[] = [];
  consumedRow: Record<string, unknown> | undefined;
  countRow: Record<string, unknown> | undefined = { cnt: 0 };
  insertResult: Record<string, unknown> = { lastInsertRowid: 101 };
  dismissResult: Record<string, unknown> = { changes: 1 };
  expireResult: Record<string, unknown> = { changes: 2 };
  throwOnPrepare: RegExp | null = null;
  throwOnRun: RegExp | null = null;
  throwOnGet: RegExp | null = null;
  throwOnAll: RegExp | null = null;

  prepare(rawSql: string) {
    const sql = normalizeSql(rawSql);
    if (this.throwOnPrepare?.test(sql)) throw new Error('prepare failed');
    return {
      run: (...args: unknown[]) => {
        this.calls.push({ kind: 'run', sql, args });
        if (this.throwOnRun?.test(sql)) throw new Error('run failed');
        if (sql.includes("SET status = 'dismissed'")) return this.dismissResult;
        if (sql.includes("SET status = 'expired'")) return this.expireResult;
        if (sql.startsWith('INSERT INTO agent_signals')) return this.insertResult;
        return { changes: 1 };
      },
      get: (...args: unknown[]) => {
        this.calls.push({ kind: 'get', sql, args });
        if (this.throwOnGet?.test(sql)) throw new Error('get failed');
        if (sql.startsWith('SELECT consumed_by FROM agent_signals')) return this.consumedRow;
        if (sql.startsWith('SELECT COUNT(*) as cnt FROM agent_signals')) return this.countRow;
        return undefined;
      },
      all: (...args: unknown[]) => {
        this.calls.push({ kind: 'all', sql, args });
        if (this.throwOnAll?.test(sql)) throw new Error('all failed');
        if (sql.startsWith('PRAGMA table_info(')) {
          return this.tenantColumn
            ? [{ name: 'id' }, { name: 'tenant_id' }, { name: 'user_id' }]
            : [{ name: 'id' }, { name: 'user_id' }];
        }
        if (sql.includes('FROM agent_runs r1')) return this.statsRows;
        if (sql.includes('FROM agent_signals')) return this.selectedRows;
        return [];
      },
    };
  }

  nonPragmaCalls(): DbCall[] {
    return this.calls.filter((call) => !call.sql.startsWith('PRAGMA table_info('));
  }
}

const validProvenance = () => ({
  producerVersion: 'intelligence-contract.v1',
  source: 'runtime' as const,
  observedAt: NOW.toISOString(),
});

const expectedGovernedError = (
  code: GovernedSignalWriteError['code'],
  signalType: SignalType,
  sourceAgent = 'test-agent',
) => ({
  name: 'GovernedSignalWriteError',
  code,
  signalType,
  sourceAgent,
  message: `Governed signal write rejected (${code}) for ${sourceAgent}:${signalType}`,
});

describe('intelligence-bus direct contract without native database workers', () => {
  let database: RecordingDb;
  let anomalies: ScopeAnomalyReport[];
  let planningInvalidations: Array<number | undefined>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    database = new RecordingDb();
    anomalies = [];
    planningInvalidations = [];
    setDbProvider(() => database as any);
    setScopeAnomalyReporter((report) => anomalies.push(report));
    setPlanningInvalidator((userId) => planningInvalidations.push(userId));
  });

  afterEach(() => {
    setScopeAnomalyReporter(null);
    setPlanningInvalidator(() => undefined);
    vi.useRealTimers();
  });

  it('accepts every registered source identity and stable domain prefix, and rejects malformed identities', () => {
    const exactAgents = [
      'book-extractor',
      'channel-learner',
      'content-analysis',
      'content.pipeline',
      'content.test',
      'cooking.fueling',
      'finance.training',
      'garmin.sync',
      'learning-digest',
      'performance-agent',
      'pipeline',
      'pipeline-agent',
      'portal',
      'reaction-radar',
      'secretary.calendar',
      'seo-agent',
      'session.analytics',
      'training-cross-skill-smoke.fixture',
      'training.test',
      'voice-evolution',
      'a',
      'b',
      'c',
      'bulk',
      'agent-a',
      'agent-b',
      'mesh-agent',
      'test',
      'test-agent',
    ];
    const prefixedAgents = [
      'mesh.worker',
      'triathlon.coach',
      'training.runner',
      'cooking.chef',
      'finance.budget',
      'content.editor',
      'secretary.agenda',
      'session.planner',
      'test.fixture',
    ];

    for (const sourceAgent of [...exactAgents, ...prefixedAgents]) {
      expect(isAllowedSignalSourceAgent(sourceAgent), sourceAgent).toBe(true);
    }
    expect(isAllowedSignalSourceAgent('  TEST-AGENT  ')).toBe(true);

    for (const sourceAgent of [
      '',
      '-starts-with-punctuation',
      'unknown-agent',
      'bad agent',
      'bad\nagent',
      'x'.repeat(81),
    ]) {
      expect(isAllowedSignalSourceAgent(sourceAgent), sourceAgent).toBe(false);
    }
  });

  it('returns fail-safe defaults when the provider is absent or throws', () => {
    for (const provider of [
      () => null as any,
      () => {
        throw new Error('database unavailable');
      },
    ]) {
      setDbProvider(provider);
      expect(writeSignal({
        source_agent: 'test-agent',
        signal_type: 'voice_pattern',
        payload: {},
        user_id: 42,
      })).toBe(-1);
      expect(readSignals('consumer', ['voice_pattern'], 3, 42)).toEqual([]);
      expect(() => markConsumed(1, 'consumer')).not.toThrow();
      expect(dismissSignal(1, 42)).toBe(0);
      expect(expireStaleSignals()).toBe(0);
      expect(getActiveSignalCount(42)).toBe(0);
      expect(getSignalLog(3, 42)).toEqual([]);
      expect(getAgentStats()).toEqual([]);
      expect(() => logAgentRun('agent', 'success', 1, 2, 3)).not.toThrow();
      expect(readRankedSignals('consumer', ['voice_pattern'], { userId: 42 })).toEqual([]);
    }
  });

  it('persists every governed provenance source and both supported producer version separators', () => {
    const sources = [
      'runtime',
      'user-feedback',
      'measured-outcome',
      'trusted-external',
      'human-approved',
    ] as const;
    const producerVersions = ['producer.v1', 'producer-v20'] as const;
    let expectedId = 200;

    for (const source of sources) {
      for (const producerVersion of producerVersions) {
        database.insertResult = { lastInsertRowid: expectedId };
        const id = writeGovernedSignal({
          source_agent: 'test-agent',
          signal_type: 'voice_pattern',
          payload: { source },
          user_id: 42,
          tenant_id: 42,
          confidence: 1,
          expires_at: '2026-07-25T13:00:00+00:00',
          provenance: {
            producerVersion,
            source,
            observedAt: '2026-07-25T12:00:00Z',
          },
        });
        expect(id).toBe(expectedId);
        expectedId += 1;
      }
    }
  });

  it.each([
    ['missing provenance', undefined],
    ['null provenance', null],
    ['primitive provenance', 'runtime'],
    ['unversioned producer', { producerVersion: 'producer', source: 'runtime', observedAt: NOW.toISOString() }],
    ['zero producer version', { producerVersion: 'producer.v0', source: 'runtime', observedAt: NOW.toISOString() }],
    ['uppercase producer start', { producerVersion: 'Producer.v1', source: 'runtime', observedAt: NOW.toISOString() }],
    ['oversized producer', { producerVersion: `${'x'.repeat(121)}.v1`, source: 'runtime', observedAt: NOW.toISOString() }],
    ['invalid source', { producerVersion: 'producer.v1', source: 'assumed', observedAt: NOW.toISOString() }],
    ['non-string source', { producerVersion: 'producer.v1', source: 1, observedAt: NOW.toISOString() }],
    ['non-string observed time', { producerVersion: 'producer.v1', source: 'runtime', observedAt: 1 }],
    ['invalid observed shape', { producerVersion: 'producer.v1', source: 'runtime', observedAt: '2026-07-25' }],
    ['invalid observed instant', { producerVersion: 'producer.v1', source: 'runtime', observedAt: '2026-99-99T12:00:00Z' }],
  ])('rejects governed writes with %s', (_label, provenance) => {
    let thrown: unknown;
    try {
      writeGovernedSignal({
        source_agent: 'test-agent',
        signal_type: 'voice_pattern',
        payload: {},
        user_id: 42,
        tenant_id: 42,
        provenance,
      } as any);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GovernedSignalWriteError);
    expect(thrown).toMatchObject(expectedGovernedError('invalid_provenance', 'voice_pattern'));
    expect(database.nonPragmaCalls()).toEqual([]);
  });

  it.each([
    ['negative confidence', -0.01, 'invalid_confidence'],
    ['confidence above one', 1.01, 'invalid_confidence'],
    ['NaN confidence', Number.NaN, 'invalid_confidence'],
    ['infinite confidence', Number.POSITIVE_INFINITY, 'invalid_confidence'],
    ['zero tenant', 0, 'invalid_tenant_scope'],
    ['negative tenant', -1, 'invalid_tenant_scope'],
    ['NaN tenant', Number.NaN, 'invalid_tenant_scope'],
    ['null tenant', null, 'invalid_tenant_scope'],
  ] as const)('rejects governed %s', (_label, value, code) => {
    const input = {
      source_agent: 'test-agent',
      signal_type: 'voice_pattern' as const,
      payload: {},
      user_id: 42,
      tenant_id: code === 'invalid_confidence' ? 42 : value,
      confidence: code === 'invalid_confidence' ? value : 0.5,
      provenance: validProvenance(),
    };

    expect(() => writeGovernedSignal(input as any)).toThrowError(
      expect.objectContaining(expectedGovernedError(code, 'voice_pattern')),
    );
  });

  it('accepts governed confidence boundaries and the legacy user-as-tenant fallback', () => {
    for (const confidence of [undefined, 0, 1]) {
      database.insertResult = { lastInsertRowid: confidence === undefined ? 300 : 301 + confidence };
      expect(writeGovernedSignal({
        source_agent: 'test-agent',
        signal_type: 'voice_pattern',
        payload: {},
        user_id: 42,
        confidence,
        provenance: validProvenance(),
      })).toBe(confidence === undefined ? 300 : 301 + confidence);
    }
    const inserts = database.nonPragmaCalls().filter((call) => call.sql.startsWith('INSERT INTO agent_signals'));
    expect(inserts.map((call) => call.args.slice(5, 8))).toEqual([
      [42, 42, 0.5],
      [42, 42, 0],
      [42, 42, 1],
    ]);
  });

  it.each([
    ['missing per-user scope', 'voice_pattern', undefined, undefined, 'missing_user_scope'],
    ['zero per-user scope', 'voice_pattern', 0, 42, 'missing_user_scope'],
    ['unexpected global user scope', 'content_formula', 42, 42, 'unexpected_user_scope'],
  ] as const)('rejects governed scope: %s', (_label, signalType, userId, tenantId, code) => {
    expect(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: signalType,
      payload: {},
      user_id: userId,
      tenant_id: tenantId,
      provenance: validProvenance(),
    })).toThrowError(expect.objectContaining(expectedGovernedError(code, signalType)));

    expect(anomalies).toEqual([{
      layer: 'intelligence_bus',
      operation: 'write_signal',
      reason: code === 'invalid_tenant_scope' ? 'invalid_user_scope' : code,
      userId: userId ?? null,
      signalType,
      details: {
        sourceAgent: 'test-agent',
        governedWrite: true,
        validationFailure: code,
      },
    }]);
  });

  it.each([
    ['malformed expiry', 'not-a-date', 'invalid_expiry'],
    ['date-only expiry', '2026-07-26', 'invalid_expiry'],
    ['before observation', '2026-07-25T11:59:59.000Z', 'expired_signal'],
    ['equal to observation and now', NOW.toISOString(), 'expired_signal'],
  ] as const)('rejects governed expiry that is %s', (_label, expiresAt, code) => {
    expect(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 42,
      tenant_id: 42,
      expires_at: expiresAt,
      provenance: validProvenance(),
    })).toThrowError(expect.objectContaining(expectedGovernedError(code, 'voice_pattern')));
  });

  it('turns a persistence rejection into a typed governed write error', () => {
    database.insertResult = {};
    expect(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 42,
      tenant_id: 42,
      provenance: validProvenance(),
    })).toThrowError(expect.objectContaining(expectedGovernedError('write_rejected', 'voice_pattern')));

    database.throwOnRun = /INSERT INTO agent_signals/;
    expect(() => writeGovernedSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 42,
      tenant_id: 42,
      provenance: validProvenance(),
    })).toThrowError(expect.objectContaining(expectedGovernedError('write_rejected', 'voice_pattern')));
  });

  it('uses the exact default expiry contract for every signal type and preserves global versus private scope', () => {
    const expiryContract: Array<[SignalType, number, boolean]> = [
      ['trending_spike', 24, true],
      ['competitor_upload', 48, true],
      ['hook_effectiveness', 60 * 24, true],
      ['pillar_performance', 60 * 24, true],
      ['retention_pattern', 60 * 24, true],
      ['voice_pattern', 90 * 24, false],
      ['voice_phrase_trend', 90 * 24, false],
      ['voice_analysis_fingerprint', 370 * 24, false],
      ['channel_dna', 30 * 24, true],
      ['book_knowledge', 365 * 24 * 10, true],
      ['book_reference_effective', 60 * 24, true],
      ['keyword_rank_change', 14 * 24, true],
      ['keyword_opportunity', 14 * 24, true],
      ['pipeline_bottleneck', 7 * 24, false],
      ['pipeline_capacity', 7 * 24, false],
      ['content_sprint_mode', 7 * 24, true],
      ['reaction_opportunity', 48, true],
      ['content_published', 30 * 24, true],
      ['learning_digest', 7 * 24, true],
      ['creator_learning_digest', 7 * 24, false],
      ['content_formula', 90 * 24, true],
      ['audience_insight', 30 * 24, true],
      ['gym_load_today', 36, false],
      ['running_load_today', 36, false],
      ['cycling_load_today', 36, false],
      ['swim_load_today', 36, false],
      ['high_leg_load', 48, false],
      ['high_shoulder_load', 48, false],
      ['low_sleep', 24, false],
      ['low_hrv', 24, false],
      ['low_readiness', 24, false],
      ['safety_red_flag', 24, false],
      ['planned_hard_run', 48, false],
      ['planned_hard_ride', 48, false],
      ['planned_race_this_week', 7 * 24, false],
      ['training_session_scheduled', 72, false],
      ['calendar_conflict', 24, false],
      ['training_schedule_stale', 24, false],
      ['training_plan_canceled', 7 * 24, false],
      ['low_adherence', 24, false],
      ['high_adherence', 24, false],
      ['plan_drift', 48, false],
      ['training_load_forecast', 48, false],
      ['recovery_state', 24, false],
      ['session_prescription', 48, false],
      ['session_immovability', 48, false],
      ['fueling_requirements', 48, false],
      ['rest_day_scheduled', 7 * 24, false],
      ['meal_plan_window', 7 * 24, false],
      ['fueling_support_status', 48, false],
      ['meal_execution_readiness', 7 * 24, false],
      ['fueling_gap_risk', 48, false],
      ['grocery_spend_forecast', 7 * 24, false],
      ['batch_cook_day', 7 * 24, false],
      ['content_capture_opportunity', 72, false],
      ['shoot_day_locked', 7 * 24, false],
      ['publishing_commitment', 7 * 24, false],
      ['sponsor_deliverable_due', 14 * 24, false],
      ['calendar_busy_blocks', 7 * 24, false],
      ['calendar_fragmentation', 7 * 24, false],
      ['travel_window', 14 * 24, false],
      ['inbox_pressure', 24, false],
      ['meeting_criticality', 48, false],
      ['deadline_pressure', 24, false],
      ['task_portability', 24, false],
      ['budget_remaining', 7 * 24, false],
      ['tax_deadline', 30 * 24, false],
      ['subscription_renewal_due', 30 * 24, false],
      ['expense_anomaly', 7 * 24, false],
    ];

    for (const [signalType, hours, global] of expiryContract) {
      database.calls = [];
      expect(writeSignal({
        source_agent: 'test-agent',
        signal_type: signalType,
        payload: { signalType },
        user_id: 42,
        tenant_id: 42,
      }), signalType).toBe(101);
      const insert = database.nonPragmaCalls()[0];
      expect(insert.args[4], signalType).toBe(new Date(NOW.getTime() + hours * 3_600_000).toISOString());
      expect(insert.args[5], signalType).toBe(42);
      expect(insert.args[6], signalType).toBe(global ? null : 42);
    }
  });

  it('persists explicit write fields, provenance, and priority-one invalidation exactly', () => {
    const expiresAt = '2026-07-27T12:00:00.000Z';
    expect(writeSignal({
      source_agent: 'mesh.worker',
      signal_type: 'voice_pattern',
      payload: { pattern: 'concise' },
      priority: 'urgent',
      expires_at: expiresAt,
      user_id: 42,
      tenant_id: 99,
      confidence: 0.91,
      format_tag: 'short',
      pillar_tag: 'tech',
      evidence_count: 8,
      meshPriority: 1,
      provenance: {
        producerVersion: 'mesh.worker.v2',
        source: 'measured-outcome',
        observedAt: '2026-07-25T11:00:00.000Z',
      },
    })).toBe(101);

    expect(database.nonPragmaCalls()).toEqual([{
      kind: 'run',
      sql: normalizeSql(`
        INSERT INTO agent_signals
          (source_agent, signal_type, payload, priority, expires_at, tenant_id, user_id,
           confidence, format_tag, pillar_tag, evidence_count, mesh_priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      args: [
        'mesh.worker',
        'voice_pattern',
        JSON.stringify({
          pattern: 'concise',
          _signalProvenance: {
            producerVersion: 'mesh.worker.v2',
            source: 'measured-outcome',
            observedAt: '2026-07-25T11:00:00.000Z',
          },
        }),
        'urgent',
        expiresAt,
        99,
        42,
        0.91,
        'short',
        'tech',
        8,
        1,
      ],
    }]);
    expect(planningInvalidations).toEqual([42]);
    expect(anomalies).toEqual([]);
  });

  it('uses the legacy insert shape when tenant_id is unavailable and applies exact defaults', () => {
    database.tenantColumn = false;
    expect(writeSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: { note: 'legacy' },
      user_id: 42,
    })).toBe(101);

    const insert = database.nonPragmaCalls()[0];
    expect(insert.sql).toBe(normalizeSql(`
      INSERT INTO agent_signals
        (source_agent, signal_type, payload, priority, expires_at, user_id,
         confidence, format_tag, pillar_tag, evidence_count, mesh_priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `));
    expect(insert.args).toEqual([
      'test-agent',
      'voice_pattern',
      JSON.stringify({
        note: 'legacy',
        _signalProvenance: {
          producerVersion: 'legacy-unknown',
          source: 'runtime',
          observedAt: NOW.toISOString(),
        },
      }),
      'normal',
      new Date(NOW.getTime() + 90 * 24 * 3_600_000).toISOString(),
      42,
      0.5,
      null,
      null,
      1,
      null,
    ]);
    expect(planningInvalidations).toEqual([]);
  });

  it('fails legacy writes closed with exact anomaly evidence for source and scope violations', () => {
    expect(writeSignal({
      source_agent: 'evil agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 42,
      tenant_id: 42,
    })).toBe(-1);
    expect(anomalies.pop()).toEqual({
      layer: 'intelligence_bus',
      operation: 'write_signal',
      reason: 'invalid_user_scope',
      userId: 42,
      signalType: 'voice_pattern',
      details: {
        sourceAgent: 'evil agent',
        invalidSourceAgent: true,
      },
    });

    expect(writeSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
    })).toBe(-1);
    expect(anomalies.pop()).toEqual({
      layer: 'intelligence_bus',
      operation: 'write_signal',
      reason: 'missing_user_scope',
      userId: null,
      signalType: 'voice_pattern',
      details: { sourceAgent: 'test-agent' },
    });

    expect(writeSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: {},
      user_id: 0,
      tenant_id: 99,
    })).toBe(-1);
    expect(anomalies.pop()).toEqual({
      layer: 'intelligence_bus',
      operation: 'write_signal',
      reason: 'invalid_user_scope',
      userId: 0,
      signalType: 'voice_pattern',
      details: { sourceAgent: 'test-agent' },
    });
  });

  it('normalizes global legacy writes while reporting unexpected private scope, and anomaly failures stay non-fatal', () => {
    setScopeAnomalyReporter(() => {
      throw new Error('observability unavailable');
    });
    expect(writeSignal({
      source_agent: 'test-agent',
      signal_type: 'content_formula',
      payload: { formula: 'hook to payoff' },
      user_id: 42,
      tenant_id: 99,
    })).toBe(101);

    const insert = database.nonPragmaCalls()[0];
    expect(insert.args[5]).toBe(99);
    expect(insert.args[6]).toBeNull();
  });

  it('reads tenant-scoped signals with an exact time window and filters already-consumed rows', () => {
    database.selectedRows = [
      signalRow(),
      signalRow({
        id: 8,
        consumed_by: JSON.stringify(['reader']),
        payload: { ignored: true },
      }),
    ];

    expect(readSignals('reader', ['voice_pattern', 'low_sleep'], 5, 42, 2.9, 99)).toEqual([{
      id: 7,
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: { observation: 'precise' },
      priority: 'normal',
      consumed_by: [],
      status: 'active',
      created_at: '2026-07-25T10:00:00.000Z',
      expires_at: '2026-07-26T10:00:00.000Z',
      user_id: 42,
      tenant_id: 42,
      confidence: 0.8,
      format_tag: 'youtube',
      pillar_tag: 'engineering',
      evidence_count: 4,
      provenance: {
        producerVersion: 'intelligence-contract.v1',
        source: 'runtime',
        observedAt: '2026-07-25T09:00:00.000Z',
      },
      meshPriority: 2,
    }]);

    expect(database.nonPragmaCalls()).toEqual([{
      kind: 'all',
      sql: normalizeSql(`
        SELECT * FROM agent_signals
        WHERE status = 'active'
          AND signal_type IN (?,?)
          AND (tenant_id IS NULL OR tenant_id = ?)
          AND (user_id IS NULL OR user_id = ?)
          AND created_at > datetime('now', '-2 days')
        ORDER BY
          CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT ?
      `),
      args: ['voice_pattern', 'low_sleep', 99, 42, 5],
    }]);
  });

  it.each([
    ['tenant global', true, undefined, 99, ['voice_pattern', 99, 4], 'AND (tenant_id IS NULL OR tenant_id = ?) AND user_id IS NULL'],
    ['platform global', true, undefined, undefined, ['voice_pattern', 4], 'AND tenant_id IS NULL AND user_id IS NULL'],
    ['legacy user', false, 42, undefined, ['voice_pattern', 42, 4], 'AND (user_id IS NULL OR user_id = ?)'],
    ['legacy global', false, undefined, undefined, ['voice_pattern', 4], 'AND user_id IS NULL'],
  ] as const)('builds the exact read scope for %s', (_label, tenantColumn, userId, tenantId, args, sqlFragment) => {
    database.tenantColumn = tenantColumn;
    database.selectedRows = [];
    expect(readSignals('reader', ['voice_pattern'], 4, userId, undefined, tenantId)).toEqual([]);
    const query = database.nonPragmaCalls()[0];
    expect(query.args).toEqual(args);
    expect(query.sql).toContain(sqlFragment);
  });

  it('records invalid read scope and degrades query and parse failures to an empty list', () => {
    database.selectedRows = [];
    expect(readSignals('reader', ['voice_pattern'], 2, 0)).toEqual([]);
    expect(anomalies).toEqual([{
      layer: 'intelligence_bus',
      operation: 'read_signals',
      reason: 'invalid_user_scope',
      userId: 0,
      details: {
        consumer: 'reader',
        signalTypes: ['voice_pattern'],
      },
    }]);

    database.throwOnAll = /SELECT \* FROM agent_signals/;
    expect(readSignals('reader', ['voice_pattern'])).toEqual([]);
    database.throwOnAll = null;
    database.selectedRows = [signalRow({ payload: '{broken' })];
    expect(readSignals('reader', ['voice_pattern'])).toEqual([]);
  });

  it('parses legacy row defaults without inventing scoped or tagged values', () => {
    database.selectedRows = [signalRow({
      payload: { observation: 'legacy' },
      consumed_by: [],
      user_id: undefined,
      tenant_id: undefined,
      confidence: undefined,
      format_tag: undefined,
      pillar_tag: undefined,
      evidence_count: undefined,
      mesh_priority: undefined,
    })];

    const result = getSignalLog(1);
    expect(result).toEqual([expect.objectContaining({
      payload: { observation: 'legacy' },
      consumed_by: [],
      user_id: null,
      tenant_id: null,
      confidence: 0.5,
      format_tag: null,
      pillar_tag: null,
      evidence_count: 1,
      provenance: {
        producerVersion: 'legacy-unknown',
        source: 'runtime',
        observedAt: '2026-07-25T10:00:00.000Z',
      },
      meshPriority: undefined,
    })]);
  });

  it('marks a consumer exactly once and tolerates missing or malformed rows', () => {
    database.consumedRow = { consumed_by: JSON.stringify(['alpha']) };
    markConsumed(7, 'beta');
    expect(database.nonPragmaCalls()).toEqual([
      {
        kind: 'get',
        sql: 'SELECT consumed_by FROM agent_signals WHERE id = ?',
        args: [7],
      },
      {
        kind: 'run',
        sql: 'UPDATE agent_signals SET consumed_by = ? WHERE id = ?',
        args: [JSON.stringify(['alpha', 'beta']), 7],
      },
    ]);

    database.calls = [];
    database.consumedRow = { consumed_by: JSON.stringify(['beta']) };
    markConsumed(8, 'beta');
    expect(database.nonPragmaCalls()[1].args).toEqual([JSON.stringify(['beta']), 8]);

    database.calls = [];
    database.consumedRow = undefined;
    markConsumed(9, 'beta');
    expect(database.nonPragmaCalls()).toHaveLength(1);

    database.calls = [];
    database.consumedRow = { consumed_by: '{broken' };
    expect(() => markConsumed(10, 'beta')).not.toThrow();
    expect(database.nonPragmaCalls()).toHaveLength(1);
  });

  it.each([
    ['platform global', true, undefined, undefined, [7], 'tenant_id IS NULL AND user_id IS NULL'],
    ['tenant global', true, undefined, 99, [7, 99], 'tenant_id = ? AND user_id IS NULL'],
    ['tenant user', true, 42, 99, [7, 99, 42], 'tenant_id = ? AND (user_id IS NULL OR user_id = ?)'],
    ['legacy global', false, undefined, undefined, [7], 'user_id IS NULL'],
    ['legacy user', false, 42, undefined, [7, 42], '(user_id IS NULL OR user_id = ?)'],
  ] as const)('dismisses only the authorized %s scope', (_label, tenantColumn, userId, tenantId, args, sqlFragment) => {
    database.tenantColumn = tenantColumn;
    database.dismissResult = { changes: 3 };
    expect(dismissSignal(7, userId, tenantId)).toBe(3);
    const update = database.nonPragmaCalls()[0];
    expect(update.args).toEqual(args);
    expect(update.sql).toContain(sqlFragment);
  });

  it('rejects invalid dismiss scope and maps database failures or missing change counts to zero', () => {
    expect(dismissSignal(7, undefined, 0)).toBe(0);
    expect(dismissSignal(7, 0, 99)).toBe(0);
    expect(database.nonPragmaCalls()).toEqual([]);

    database.dismissResult = {};
    expect(dismissSignal(7)).toBe(0);

    database.throwOnRun = /SET status = 'dismissed'/;
    expect(dismissSignal(7)).toBe(0);
  });

  it('expires stale signals and exposes active counts for every tenant schema branch', () => {
    expect(expireStaleSignals()).toBe(2);
    expect(database.nonPragmaCalls()[0]).toEqual({
      kind: 'run',
      sql: normalizeSql(`
        UPDATE agent_signals
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at < datetime('now')
      `),
      args: [],
    });

    const cases: Array<[boolean, number | undefined, number | undefined, unknown[], string]> = [
      [true, 42, 99, [99, 42], "status = 'active' AND tenant_id = ? AND (user_id IS NULL OR user_id = ?)"],
      [true, undefined, 99, [99], "status = 'active' AND tenant_id = ? AND user_id IS NULL"],
      [true, undefined, undefined, [], "status = 'active' AND tenant_id IS NULL AND user_id IS NULL"],
      [false, 42, undefined, [42], "status = 'active' AND (user_id IS NULL OR user_id = ?)"],
      [false, undefined, undefined, [], "status = 'active' AND user_id IS NULL"],
    ];
    for (const [tenantColumn, userId, tenantId, args, whereClause] of cases) {
      database.calls = [];
      database.tenantColumn = tenantColumn;
      database.countRow = { cnt: 6 };
      expect(getActiveSignalCount(userId, tenantId)).toBe(6);
      expect(database.nonPragmaCalls()[0]).toEqual({
        kind: 'get',
        sql: `SELECT COUNT(*) as cnt FROM agent_signals WHERE ${whereClause}`,
        args,
      });
    }
  });

  it('maps expiry/count failures and absent result fields to zero', () => {
    database.expireResult = {};
    expect(expireStaleSignals()).toBe(0);
    database.throwOnRun = /SET status = 'expired'/;
    expect(expireStaleSignals()).toBe(0);

    database.throwOnRun = null;
    database.countRow = undefined;
    expect(getActiveSignalCount()).toBe(0);
    database.throwOnGet = /SELECT COUNT/;
    expect(getActiveSignalCount()).toBe(0);
  });

  it('builds exact signal-log scopes, parses rows, and degrades failures safely', () => {
    const cases: Array<[boolean, number | undefined, number | undefined, unknown[], string]> = [
      [true, 42, 99, [99, 42, 5], 'tenant_id = ? AND (user_id IS NULL OR user_id = ?)'],
      [true, undefined, 99, [99, 5], 'tenant_id = ? AND user_id IS NULL'],
      [true, undefined, undefined, [5], 'tenant_id IS NULL AND user_id IS NULL'],
      [false, 42, undefined, [42, 5], '(user_id IS NULL OR user_id = ?)'],
      [false, undefined, undefined, [5], 'user_id IS NULL'],
    ];
    for (const [tenantColumn, userId, tenantId, args, whereClause] of cases) {
      database.calls = [];
      database.tenantColumn = tenantColumn;
      database.selectedRows = [signalRow()];
      expect(getSignalLog(5, userId, tenantId)).toHaveLength(1);
      expect(database.nonPragmaCalls()[0]).toMatchObject({
        kind: 'all',
        args,
      });
      expect(database.nonPragmaCalls()[0].sql).toContain(`WHERE ${whereClause}`);
      expect(database.nonPragmaCalls()[0].sql).toContain('ORDER BY created_at DESC LIMIT ?');
    }

    database.throwOnAll = /SELECT \* FROM agent_signals/;
    expect(getSignalLog()).toEqual([]);
  });

  it('returns agent stats and logs agent runs with an exact nullable error contract', () => {
    database.statsRows = [{
      agent: 'pipeline-agent',
      last_run: '2026-07-25T11:00:00.000Z',
      last_status: 'success',
      signals_produced: 3,
      total_runs: 2,
    }];
    expect(getAgentStats()).toEqual(database.statsRows);
    expect(database.nonPragmaCalls()[0].sql).toBe(normalizeSql(`
      SELECT
        agent_name as agent,
        MAX(created_at) as last_run,
        (SELECT status FROM agent_runs r2 WHERE r2.agent_name = r1.agent_name ORDER BY created_at DESC LIMIT 1) as last_status,
        SUM(signals_produced) as signals_produced,
        COUNT(*) as total_runs
      FROM agent_runs r1
      GROUP BY agent_name
      ORDER BY last_run DESC
    `));

    database.calls = [];
    logAgentRun('pipeline-agent', 'error', 3, 4, 125, 'failed');
    logAgentRun('pipeline-agent', 'success', 5, 6, 225);
    expect(database.nonPragmaCalls()).toEqual([
      {
        kind: 'run',
        sql: normalizeSql(`
          INSERT INTO agent_runs (agent_name, status, signals_produced, signals_consumed, duration_ms, error_message)
          VALUES (?, ?, ?, ?, ?, ?)
        `),
        args: ['pipeline-agent', 'error', 3, 4, 125, 'failed'],
      },
      {
        kind: 'run',
        sql: normalizeSql(`
          INSERT INTO agent_runs (agent_name, status, signals_produced, signals_consumed, duration_ms, error_message)
          VALUES (?, ?, ?, ?, ?, ?)
        `),
        args: ['pipeline-agent', 'success', 5, 6, 225, null],
      },
    ]);
  });

  it('maps agent stats and run-log database failures to fail-safe outputs', () => {
    database.throwOnAll = /FROM agent_runs r1/;
    expect(getAgentStats()).toEqual([]);
    database.throwOnRun = /INSERT INTO agent_runs/;
    expect(() => logAgentRun('agent', 'error', 0, 0, 1, 'private detail')).not.toThrow();
  });

  it('ranks exact rows by confidence, freshness, priority, and tie-break confidence', () => {
    database.selectedRows = [
      signalRow({
        id: 1,
        priority: 'urgent',
        confidence: 0.8,
        created_at: '2026-07-25T10:00:00.000Z',
        expires_at: '2026-07-25T14:00:00.000Z',
      }),
      signalRow({
        id: 2,
        priority: 'normal',
        confidence: 1,
        created_at: '2026-07-25T11:00:00.000Z',
        expires_at: '2026-07-25T13:00:00.000Z',
      }),
      signalRow({
        id: 3,
        priority: 'unknown',
        confidence: 0.6,
        created_at: '2026-07-25T12:00:00.000Z',
        expires_at: '2026-07-25T12:00:00.000Z',
      }),
      signalRow({
        id: 4,
        consumed_by: JSON.stringify(['ranker']),
      }),
    ];

    const result = readRankedSignals('ranker', ['voice_pattern'], {
      limit: 3,
      userId: 42,
      tenantId: 99,
      pillar: 'engineering',
      format: 'youtube',
      minConfidence: 0.25,
    });

    expect(result.map((signal) => ({
      id: signal.id,
      relevanceScore: signal.relevanceScore,
      ageHours: signal.ageHours,
    }))).toEqual([
      { id: 1, relevanceScore: 0.566, ageHours: 2 },
      { id: 2, relevanceScore: 0.495, ageHours: 1 },
      { id: 3, relevanceScore: 0, ageHours: 0 },
    ]);
    expect(database.nonPragmaCalls()).toEqual([{
      kind: 'all',
      sql: normalizeSql(`
        SELECT * FROM agent_signals
        WHERE status = 'active' AND signal_type IN (?) AND confidence >= ? AND tenant_id = ? AND (user_id IS NULL OR user_id = ?) AND (pillar_tag IS NULL OR pillar_tag = ?) AND (format_tag IS NULL OR format_tag = ?)
        ORDER BY confidence DESC, created_at DESC
        LIMIT ?
      `),
      args: ['voice_pattern', 0.25, 99, 42, 'engineering', 'youtube', 9],
    }]);
  });

  it.each([
    ['tenant-global defaults', true, undefined, undefined, ['voice_pattern', 0.1, 60], 'tenant_id IS NULL AND user_id IS NULL'],
    ['tenant-only scope', true, undefined, 99, ['voice_pattern', 0.1, 99, 60], 'tenant_id = ? AND user_id IS NULL'],
    ['legacy user scope', false, 42, undefined, ['voice_pattern', 0.1, 42, 60], '(user_id IS NULL OR user_id = ?)'],
    ['legacy global scope', false, undefined, undefined, ['voice_pattern', 0.1, 60], 'user_id IS NULL'],
  ] as const)('builds ranked query scope for %s', (_label, tenantColumn, userId, tenantId, args, sqlFragment) => {
    database.tenantColumn = tenantColumn;
    database.selectedRows = [];
    expect(readRankedSignals('reader', ['voice_pattern'], { userId, tenantId })).toEqual([]);
    const query = database.nonPragmaCalls()[0];
    expect(query.args).toEqual(args);
    expect(query.sql).toContain(sqlFragment);
  });

  it('respects ranked limit, sorts equal scores by confidence, and maps query/parse failures to empty', () => {
    database.selectedRows = [
      signalRow({ id: 1, confidence: 0.8, priority: 'background' }),
      signalRow({ id: 2, confidence: 0.9, priority: 'background' }),
    ];
    expect(readRankedSignals('reader', ['voice_pattern'], { limit: 1 }).map((row) => row.id)).toEqual([2]);

    database.throwOnAll = /SELECT \* FROM agent_signals/;
    expect(readRankedSignals('reader', ['voice_pattern'])).toEqual([]);
    database.throwOnAll = null;
    database.selectedRows = [signalRow({ payload: '{broken' })];
    expect(readRankedSignals('reader', ['voice_pattern'])).toEqual([]);
  });
});
