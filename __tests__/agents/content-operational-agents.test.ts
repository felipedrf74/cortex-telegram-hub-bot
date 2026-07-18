import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';

let testDb: Database.Database;
vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
    youtube: { apiKey: '' },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { setDbProvider } from '../../src/services/intelligence-bus';
import { runPipelineAgent } from '../../src/agents/pipeline-agent';
import { runSEOAgent } from '../../src/agents/seo-agent';
import { runPerformanceAgent } from '../../src/agents/performance-agent';
import { runReactionRadar } from '../../src/agents/reaction-radar-agent';
import { buildEditorialCoordinationSignals } from '../../src/agents/editorial-coordinator-agent';


function latestAgentRun(agentName: string): any {
  return testDb.prepare(`
    SELECT * FROM agent_runs
     WHERE agent_name = ?
     ORDER BY id DESC
     LIMIT 1
  `).get(agentName);
}

function activeSignals(type?: string): any[] {
  const rows = type
    ? testDb.prepare(`SELECT * FROM agent_signals WHERE signal_type = ? ORDER BY id ASC`).all(type)
    : testDb.prepare(`SELECT * FROM agent_signals ORDER BY id ASC`).all();
  return rows.map((row: any) => ({
    ...row,
    payload: JSON.parse(row.payload),
  }));
}

describe('Content operational agents direct health checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb as any);
  });

  afterEach(() => {
    testDb?.close();
    setDbProvider(() => null as any);
  });

  it('pipeline agent does not turn a user-private backlog into global bottleneck signals', async () => {
    seedWorkspaceAgentItem(
      { tenantId: 101, userId: 501 },
      'Tenant A Private Launch Plan',
      'active',
      'draft',
      '-14 days',
    );

    await runPipelineAgent({ tenantId: 202, userId: 502 });

    const signals = activeSignals();
    expect(signals.map((signal) => signal.signal_type)).toEqual(['pipeline_capacity']);
    expect(JSON.stringify(signals)).not.toContain('Tenant A Private Launch Plan');
    expect(signals[0]).toMatchObject({ tenant_id: 202, user_id: 502 });
    expect(latestAgentRun('pipeline-agent')).toMatchObject({ status: 'success', signals_produced: 1 });
  });

  it('pipeline agent detects bottlenecks only inside the requested private scope', async () => {
    seedWorkspaceAgentItem(
      { tenantId: 101, userId: 501 },
      'Private Content System Deep Dive',
      'active',
      'draft',
      '-14 days',
    );

    await runPipelineAgent({ tenantId: 101, userId: 501 });

    const bottlenecks = activeSignals('pipeline_bottleneck');
    expect(bottlenecks).toHaveLength(1);
    expect(bottlenecks[0].payload.bottleneck_stage).toBe('scripted');
    expect(bottlenecks[0].payload.stuck_count).toBe(1);
    expect(bottlenecks[0]).toMatchObject({ tenant_id: 101, user_id: 501 });
    expect(latestAgentRun('pipeline-agent')).toMatchObject({ status: 'success', signals_produced: 1 });
  });

  it('SEO and performance agents fail closed when no user-scoped creator channel is configured', async () => {
    await runSEOAgent();
    await runPerformanceAgent();

    expect(latestAgentRun('seo-agent')).toMatchObject({
      status: 'skipped',
      signals_produced: 0,
      error_message: 'No user-scoped creator YouTube channel configured',
    });
    expect(latestAgentRun('performance-agent')).toMatchObject({
      status: 'skipped',
      signals_produced: 0,
      error_message: 'No user-scoped creator YouTube channel configured',
    });
    expect(activeSignals()).toEqual([]);
  });

  it('reaction radar skips entirely when no user-scoped creator channel exists', async () => {
    // Creator gate (2026-07-03 audit): without a verified own channel there
    // is no consumer for radar signals, so the run must not burn YouTube
    // quota at all — same fail-closed rationale as the SEO/performance agents.
    await runReactionRadar();

    expect(latestAgentRun('reaction-radar')).toMatchObject({
      status: 'skipped',
      signals_produced: 0,
      error_message: 'No user-scoped creator YouTube channel configured',
    });
    expect(activeSignals('reaction_opportunity')).toEqual([]);
  }, 8_000);

  it('reaction radar completes without fake opportunities when platform APIs are unavailable', async () => {
    // Seed a verified own channel so the run passes the creator gate and
    // exercises the API-unavailable path.
    testDb.prepare(`
      INSERT INTO content_ref_channels (channel_url, channel_name, channel_id, status, added_via, user_id, tenant_id, owner_user_id)
      VALUES ('https://youtube.com/@creator', 'Test Creator', 'UC_test_creator', 'active', 'ios_own_channel', 7, 7, 7)
    `).run();

    await runReactionRadar();

    expect(latestAgentRun('reaction-radar')).toMatchObject({
      status: 'success',
      signals_produced: 0,
    });
    expect(activeSignals('reaction_opportunity')).toEqual([]);
  }, 8_000);

  it('editorial coordinator emits useful cross-skill signals without generic noise', () => {
    const result = buildEditorialCoordinationSignals({
      content: {
        recentSignals: [{ type: 'reaction_opportunity', title: 'AI creator systems angle', summary: 'A reaction window is open.' }],
        unreadNotifications: [{
          id: 71,
          title: 'Sponsor deliverable due',
          body: 'Brand deal draft needs disclosure review',
          data: { sponsor: true },
          createdAt: '2026-05-14T09:00:00.000Z',
        }],
        filmingRecommendation: {
          date: '2026-05-15',
          confidence: 'high',
          reason: 'Clear afternoon focus block and fresh reaction window.',
          reasons: ['Focus block open', 'Trend is timely'],
          trainingLoad: 'low',
          calendarLoad: 'moderate',
          calendarReservationAvailable: true,
          blockStart: '2026-05-15T14:00:00.000Z',
          blockEnd: '2026-05-15T16:00:00.000Z',
        },
        nextExecution: {
          mode: 'reaction_window',
          title: 'AI creator systems angle',
          summary: 'Timely reaction to a platform trend.',
          confidence: 'high',
          sourceType: 'reaction_opportunity',
        },
      } as any,
      secretary: {
        focusBlock: {
          date: '2026-05-15',
          start: '2026-05-15T14:00:00.000Z',
          end: '2026-05-15T16:00:00.000Z',
          reason: 'Protected creator work block',
          reasons: ['No meetings'],
        },
      } as any,
      training: {
        trainingContext: {
          flags: { lowReadiness: false },
        },
      } as any,
    });

    expect(result.signals.map((signal) => signal.signalType)).toEqual([
      'content_capture_opportunity',
      'shoot_day_locked',
      'sponsor_deliverable_due',
    ]);
    expect(result.signals.find((signal) => signal.signalType === 'content_capture_opportunity')?.payload).toMatchObject({
      reason: 'Clear afternoon focus block and fresh reaction window.',
      nextExecutionMode: 'reaction_window',
      sourceSignalType: 'reaction_opportunity',
    });
    expect(JSON.stringify(result.signals)).not.toMatch(/post consistently|generic|undefined/i);
  });
});

function seedWorkspaceAgentItem(
  scope: { tenantId: number; userId: number },
  title: string,
  productionState: string,
  artifactPhase: string,
  updatedOffset: string,
): void {
  testDb.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, title, production_state, artifact_phase,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?, ?, ?, ?,
      ?, ?, datetime('now', ?), datetime('now', ?))
  `).run(
    scope.tenantId,
    scope.userId,
    productionState,
    title,
    productionState,
    artifactPhase,
    scope.userId,
    scope.userId,
    updatedOffset,
    updatedOffset,
  );
}
