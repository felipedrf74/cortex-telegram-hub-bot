import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch {
      // A few historical migrations are intentionally dependency-sensitive in
      // isolated tests. Agents under test create or read the tables they need.
    }
  }
}

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
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
    setDbProvider(() => testDb as any);
  });

  afterEach(() => {
    testDb?.close();
    setDbProvider(() => null as any);
  });

  it('pipeline agent does not turn a user-private backlog into global bottleneck signals', async () => {
    testDb.prepare(`
      INSERT INTO content_pipeline (
        topic_title, niche, stage, stage_history, updated_at,
        user_id, tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES (
        'Tenant A Private Launch Plan', 'creator agency', 'scripted', '[]',
        datetime('now', '-14 days'), 501, 101, 501, 'user_private', 'active'
      )
    `).run();

    await runPipelineAgent();

    const signals = activeSignals();
    expect(signals.map((signal) => signal.signal_type)).toEqual(['pipeline_capacity']);
    expect(JSON.stringify(signals)).not.toContain('Tenant A Private Launch Plan');
    expect(latestAgentRun('pipeline-agent')).toMatchObject({ status: 'success', signals_produced: 1 });
  });

  it('pipeline agent detects bottlenecks only from platform/global pipeline rows', async () => {
    testDb.prepare(`
      INSERT INTO content_pipeline (
        topic_title, niche, stage, stage_history, updated_at,
        user_id, tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES (
        'Public Content System Deep Dive', 'creator agency', 'scripted', '[]',
        datetime('now', '-14 days'), 0, NULL, 0, 'platform_internal', 'active'
      )
    `).run();

    await runPipelineAgent();

    const bottlenecks = activeSignals('pipeline_bottleneck');
    expect(bottlenecks).toHaveLength(1);
    expect(bottlenecks[0].payload.bottleneck_stage).toBe('scripted');
    expect(bottlenecks[0].payload.stuck_count).toBe(1);
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

  it('reaction radar completes without fake opportunities when platform APIs are unavailable', async () => {
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
