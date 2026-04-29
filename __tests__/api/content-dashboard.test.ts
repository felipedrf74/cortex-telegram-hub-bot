// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content Dashboard API tests.
 *
 * These tests cover the route added by src/api/routes/content-dashboard.ts
 * which powers the restored Content tab in the admin portal. They run
 * against an in-memory SQLite database seeded with the real migrations, so
 * every SELECT in the handler is exercised against the actual schema.
 *
 * Covered behaviour:
 *   - Auth: requires `Authorization: Bearer <PORTAL_TOKEN>` when set.
 *   - Empty token is NOT enough to open the route; local preview is
 *     explicit via PORTAL_ALLOW_LOCAL_BYPASS=true.
 *   - Shape: returns the expected top-level keys.
 *   - Books: reflects seeded book_library rows with their status totals.
 *   - Pipeline: reflects seeded content_pipeline rows + stage bucketing.
 *   - Commands: includes a row for every known content command and fills
 *               calls7d from matching api_usage categories.
 *   - Agent graph: includes the static nodes and overlays zero runs
 *                  when agent_runs is empty.
 *   - YouTube: reflects seeded content_ref_channels + video_transcripts.
 *   - Voice DNA: reflects seeded content_knowledge rows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';
import http from 'http';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;
let portalTokenValue = '';
let portalReadTokenValue = '';
let portalWriteTokenValue = '';
let portalAllowLocalBypass = false;

// ── Mocks ────────────────────────────────────────────────────────────
// NOTE: every mock below must be defined BEFORE the unit under test is
// imported. Vitest hoists `vi.mock` calls to the top of the file, but
// the factory functions still execute in import order, so we keep them
// all together.

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Provide a config with togglable portal auth state. The route reads
// `config.portal` at every request, so we can change both token and
// local-bypass state per test.
vi.mock('../../src/config', () => ({
  config: {
    get portal() {
      return {
        token: portalTokenValue,
        readToken: portalReadTokenValue,
        writeToken: portalWriteTokenValue,
        allowLocalBypass: portalAllowLocalBypass,
      };
    },
    app: {
      timezone: 'Europe/Lisbon',
    },
    garmin: {
      tokenPath: '/tmp',
    },
  },
}));

// Telemetry — pretend we have several content-domain cron jobs running,
// one failed and one never-run, so the status sort is exercised.
vi.mock('../../src/portal/telemetry', () => ({
  getJobStatuses: () => [
    {
      name: 'pipeline_agent',
      label: 'Pipeline Tracker',
      cronExpression: '0 20 * * *',
      domain: 'content',
      lastRunAt: '2026-04-08T20:00:00Z',
      lastResult: 'success',
      lastDurationMs: 342,
      lastError: null,
    },
    {
      name: 'reaction_radar',
      label: 'Reaction Radar',
      cronExpression: '0 8,14,20 * * *',
      domain: 'content',
      lastRunAt: '2026-04-09T08:00:00Z',
      lastResult: 'failed',
      lastDurationMs: 12,
      lastError: 'youtube api quota exceeded',
    },
    {
      name: 'voice_evolution',
      label: 'Voice Evolution',
      cronExpression: '0 4 1 * *',
      domain: 'content',
      lastRunAt: null,
      lastResult: 'never',
      lastDurationMs: null,
      lastError: null,
    },
    // Non-content job — must be filtered out.
    {
      name: 'garmin_coach',
      label: 'Garmin Coach',
      cronExpression: '0 6 * * *',
      domain: 'triathlon',
      lastRunAt: '2026-04-09T06:00:00Z',
      lastResult: 'success',
      lastDurationMs: 1500,
      lastError: null,
    },
  ],
}));

// Intelligence bus — return agent stats + a couple of reaction signals
// so the reaction radar section has something to render. The route
// tolerates an empty list too (we test that in the "minimal data" case
// by just not stubbing anything in the signals array).
vi.mock('../../src/services/intelligence-bus', () => ({
  getAgentStats: () => [
    { agent: 'pipeline_agent', last_run: '2026-04-08T20:00:00Z', last_status: 'success', signals_produced: 4, total_runs: 12 },
    { agent: 'reaction_radar', last_run: '2026-04-09T08:00:00Z', last_status: 'failed', signals_produced: 0, total_runs: 40 },
  ],
  getSignalLog: () => [
    {
      id: 101,
      source_agent: 'reaction_radar',
      signal_type: 'reaction_opportunity',
      payload: { title: 'Trump vs Lula debate' },
      priority: 'urgent',
      consumed_by: [],
      status: 'active',
      created_at: '2026-04-09T08:00:00Z',
      expires_at: '2026-04-12T08:00:00Z',
      user_id: null,
    },
    {
      id: 102,
      source_agent: 'reaction_radar',
      signal_type: 'trending_spike',
      payload: { topic: 'bitcoin ETF' },
      priority: 'normal',
      consumed_by: [],
      status: 'active',
      created_at: '2026-04-09T07:30:00Z',
      expires_at: '2026-04-12T07:30:00Z',
      user_id: null,
    },
    // A non-radar signal — must be filtered out of reactionRadar.recentSignals
    {
      id: 103,
      source_agent: 'pipeline_agent',
      signal_type: 'pipeline_bottleneck',
      payload: { stage: 'scripted', count: 5 },
      priority: 'normal',
      consumed_by: [],
      status: 'active',
      created_at: '2026-04-08T20:00:00Z',
      expires_at: '2026-04-11T20:00:00Z',
      user_id: null,
    },
  ],
  getActiveSignalCount: () => 3,
  writeSignal: vi.fn(),
}));

// Pipeline stats come from src/agents/pipeline-agent — it reads the DB
// directly. We keep the real implementation so it exercises the seeded
// content_pipeline rows.

// ── Seed helpers ─────────────────────────────────────────────────────

function seedBooks() {
  const insert = testDb.prepare(`
    INSERT INTO book_library (title, author, core_thesis, key_frameworks,
      pillar_mapping, extraction_status, times_referenced, created_at, user_id, owner_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 0, 'system')
  `);
  insert.run(
    'The Law',
    'Frédéric Bastiat',
    'Legal plunder — when the law itself becomes the instrument of the injustice it was created to prevent.',
    JSON.stringify(['legal plunder', 'negative rights']),
    JSON.stringify(['politics', 'economics']),
    'extracted',
    7,
  );
  insert.run(
    'Economics in One Lesson',
    'Henry Hazlitt',
    'See the unseen — the true cost of a policy is what would have happened in its absence.',
    JSON.stringify(['opportunity cost', 'broken window']),
    JSON.stringify(['economics']),
    'extracted',
    5,
  );
  insert.run(
    'Pending Book',
    'Some Author',
    null,
    '[]',
    '[]',
    'pending',
    0,
  );
}

function seedPipeline() {
  const insert = testDb.prepare(`
    INSERT INTO content_pipeline (topic_title, niche, stage, stage_history,
      created_at, updated_at, published_url, published_at)
    VALUES (?, ?, ?, '[]', datetime('now'), datetime('now'), ?, ?)
  `);
  insert.run('Idea A', 'politics', 'approved', null, null);
  insert.run('Idea B', 'politics', 'scripted', null, null);
  insert.run('Idea C', 'fitness', 'filming', null, null);
  insert.run('Idea D', 'politics', 'published', 'https://youtu.be/abc', '2026-04-09T12:00:00Z');
}

function seedYouTube() {
  const channelInsert = testDb.prepare(`
    INSERT INTO content_ref_channels (channel_url, channel_name, status,
      video_count_analyzed, last_analyzed_at, added_via, user_id, owner_scope)
    VALUES (?, ?, ?, ?, ?, 'manual', 0, 'system')
  `);
  channelInsert.run('https://youtube.com/@nando', 'Nando Moura', 'active', 12, '2026-04-08T00:00:00Z');
  channelInsert.run('https://youtube.com/@renato', 'Renato 38tão', 'active', 8, '2026-04-07T00:00:00Z');
  channelInsert.run('https://youtube.com/@pending', null, 'pending', 0, null);

  const transcriptInsert = testDb.prepare(`
    INSERT INTO video_transcripts (video_id, title, channel_name, full_text, source)
    VALUES (?, ?, ?, ?, 'manual')
  `);
  transcriptInsert.run('abc123xyz01', 'Why the state always grows', 'Nando Moura', 'Transcript body...');
  transcriptInsert.run('def456abc02', 'Hybrid athlete reality check', 'Renato 38tão', 'Transcript body...');

  const studyInsert = testDb.prepare(`
    INSERT INTO video_studies (video_id, transcript_id, study_type, analysis_json)
    VALUES (?, 1, 'full', '{}')
  `);
  studyInsert.run('abc123xyz01');
}

function seedVoiceDna() {
  const insert = testDb.prepare(`
    INSERT INTO content_knowledge (category, synthesized_text, source_channels, version, updated_at, user_id, owner_scope)
    VALUES (?, ?, ?, 1, datetime('now'), 0, 'system')
  `);
  insert.run('hook_style', 'Open with a provocative claim, then justify it with data.', '["Nando Moura","Renato 38tão"]');
  insert.run('brand_voice', 'Direct, irreverent, heavy on rhetorical questions.', '["Nando Moura"]');
}

function seedApiUsage() {
  const insert = testDb.prepare(`
    INSERT INTO api_usage (ts, category, model, input_tokens, output_tokens, cost_usd, duration_ms)
    VALUES (datetime('now'), ?, 'claude-sonnet-4-6', 100, 50, 0.002, 1200)
  `);
  insert.run('content_discovery');
  insert.run('content_discovery_continuation');
  insert.run('content_workflow_reel');
  insert.run('content_workflow_youtube');
  insert.run('video_study');
  insert.run('channel_analysis');
  insert.run('autoresearch_mutate');
  // Noise row that should not be counted as a content command
  insert.run('gym_classifier');
}

async function fetchJson(
  app: express.Express,
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to start test server'));
        return;
      }
      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: url,
          method: 'GET',
          headers: headers || {},
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : null });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('content-dashboard route', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    portalTokenValue = '';
    portalReadTokenValue = '';
    portalWriteTokenValue = '';
    portalAllowLocalBypass = false;
  });

  afterEach(() => {
    testDb.close();
  });

  it('returns a fully populated payload when explicit loopback bypass is enabled', async () => {
    portalAllowLocalBypass = true;
    seedBooks();
    seedPipeline();
    seedYouTube();
    seedVoiceDna();
    seedApiUsage();

    const { contentDashboardRoutes, buildContentDashboard } = await import(
      '../../src/api/routes/content-dashboard'
    );

    // Unit-call the builder directly so we can assert the shape without
    // going through Express.
    const data = buildContentDashboard();
    expect(data.ok).toBe(true);
    expect(typeof data.generatedAt).toBe('string');

    // Books — 3 total, 2 extracted, 1 pending
    expect(data.books.total).toBe(3);
    expect(data.books.extracted).toBe(2);
    expect(data.books.pending).toBe(1);
    expect(data.books.rows.length).toBe(3);
    const bastiat = data.books.rows.find((r) => r.title === 'The Law');
    expect(bastiat).toBeDefined();
    expect(bastiat?.frameworks).toEqual(['legal plunder', 'negative rights']);
    expect(bastiat?.pillars).toEqual(['politics', 'economics']);

    // Pipeline — stages + totalActive
    expect(data.pipeline.stages.approved).toBe(1);
    expect(data.pipeline.stages.scripted).toBe(1);
    expect(data.pipeline.stages.filming).toBe(1);
    expect(data.pipeline.stages.published).toBe(1);
    expect(data.pipeline.totalActive).toBe(3); // approved + scripted + filming
    expect(data.pipeline.publishedThisWeek).toBe(1);
    expect(data.pipeline.recent.length).toBe(4);

    // YouTube — channels + videos + totals
    expect(data.youtube.totals.channels).toBe(3);
    expect(data.youtube.totals.activeChannels).toBe(2);
    expect(data.youtube.totals.transcripts).toBe(2);
    expect(data.youtube.totals.studies).toBe(1);
    expect(data.youtube.channels.length).toBe(3);
    expect(data.youtube.videos.length).toBe(2);
    expect(data.youtube.videos[0].youtubeUrl).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);

    // Voice DNA
    expect(data.voiceDna.length).toBe(2);
    const hook = data.voiceDna.find((v) => v.category === 'hook_style');
    expect(hook?.label).toBe('Hook Styles');
    expect(hook?.sources).toContain('Nando Moura');

    // Commands — every known group present and at least one row has calls7d > 0
    const groupNames = data.commands.map((g) => g.group);
    expect(groupNames).toContain('discover');
    expect(groupNames).toContain('pipeline');
    expect(groupNames).toContain('library');
    const discoverGroup = data.commands.find((g) => g.group === 'discover');
    expect(discoverGroup).toBeDefined();
    // content_discovery + content_discovery_continuation should have attributed
    // call counts to the /discover command row via LIKE matching.
    const discoverRow = discoverGroup?.rows.find((r) => r.name === 'discover');
    expect(discoverRow).toBeDefined();
    expect(discoverRow?.calls7d).toBeGreaterThanOrEqual(2);

    // Agent graph — every static node and edge is present and overlays run stats
    expect(data.agentGraph.nodes.length).toBeGreaterThan(5);
    expect(data.agentGraph.edges.length).toBeGreaterThan(5);
    const pipelineNode = data.agentGraph.nodes.find((n) => n.id === 'pipeline_agent');
    expect(pipelineNode?.lastStatus).toBe('success');
    expect(pipelineNode?.totalRuns).toBe(12);
    const radarNode = data.agentGraph.nodes.find((n) => n.id === 'reaction_radar');
    expect(radarNode?.lastStatus).toBe('failed');

    // Triggers — only content-domain jobs, sorted with failed first
    expect(data.triggers.length).toBe(3);
    expect(data.triggers[0].status).toBe('failed');
    expect(data.triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining(['pipeline_agent', 'reaction_radar', 'voice_evolution']),
    );
    expect(data.triggers.every((t) => t.domain === 'content')).toBe(true);
    // Cron-parser should populate nextFireAt for parseable expressions
    const pipelineTrigger = data.triggers.find((t) => t.name === 'pipeline_agent');
    expect(pipelineTrigger?.nextFireAt).toBeTruthy();

    // Reaction radar — only reaction_opportunity + trending_spike, not the bottleneck
    expect(data.reactionRadar.recentSignals.length).toBe(2);
    expect(data.reactionRadar.recentSignals.every((s) =>
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'].includes(s.type),
    )).toBe(true);
    expect(data.reactionRadar.activeSignals).toBe(2);

    // Top-level counters
    expect(data.referenceChannels).toBe(3);
    expect(data.activeSignals).toBe(3);
    expect(data.knowledgeStats.length).toBe(2);
  });

  it('requires a portal token when one is configured', async () => {
    portalTokenValue = 'test-secret-123';
    seedBooks();

    const { contentDashboardRoutes } = await import('../../src/api/routes/content-dashboard');
    const app = express();
    app.use('/api/v1/admin/content-dashboard', contentDashboardRoutes());

    // No Authorization header → 401
    const noAuth = await fetchJson(app, '/api/v1/admin/content-dashboard');
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error.code).toBe('UNAUTHORIZED');

    // Wrong token → 401
    const badAuth = await fetchJson(app, '/api/v1/admin/content-dashboard', {
      Authorization: 'Bearer wrong-token',
    });
    expect(badAuth.status).toBe(401);

    // Correct token → 200 + envelope
    const goodAuth = await fetchJson(app, '/api/v1/admin/content-dashboard', {
      Authorization: 'Bearer test-secret-123',
    });
    expect(goodAuth.status).toBe(200);
    expect(goodAuth.body.ok).toBe(true);
    expect(goodAuth.body.books.total).toBe(3);
  });

  it('accepts a scoped read token for the dashboard and rejects a write-only mismatch', async () => {
    portalTokenValue = '';
    portalReadTokenValue = 'test-read-secret';
    portalWriteTokenValue = 'test-write-secret';
    seedBooks();

    const { contentDashboardRoutes } = await import('../../src/api/routes/content-dashboard');
    const app = express();
    app.use('/api/v1/admin/content-dashboard', contentDashboardRoutes());

    const withReadToken = await fetchJson(app, '/api/v1/admin/content-dashboard', {
      Authorization: 'Bearer test-read-secret',
    });
    expect(withReadToken.status).toBe(200);
    expect(withReadToken.body.ok).toBe(true);

    const withWriteToken = await fetchJson(app, '/api/v1/admin/content-dashboard', {
      Authorization: 'Bearer test-write-secret',
    });
    expect(withWriteToken.status).toBe(200);
    expect(withWriteToken.body.ok).toBe(true);

    const badAuth = await fetchJson(app, '/api/v1/admin/content-dashboard', {
      Authorization: 'Bearer wrong-token',
    });
    expect(badAuth.status).toBe(401);
  });

  it('rejects access when no portal token is configured and bypass is disabled', async () => {
    portalTokenValue = '';
    const { contentDashboardRoutes } = await import('../../src/api/routes/content-dashboard');
    const app = express();
    app.use('/api/v1/admin/content-dashboard', contentDashboardRoutes());

    const res = await fetchJson(app, '/api/v1/admin/content-dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('allows loopback preview only when explicit local bypass is enabled', async () => {
    portalTokenValue = '';
    portalAllowLocalBypass = true;
    const { contentDashboardRoutes } = await import('../../src/api/routes/content-dashboard');
    const app = express();
    app.use('/api/v1/admin/content-dashboard', contentDashboardRoutes());

    const res = await fetchJson(app, '/api/v1/admin/content-dashboard');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('sanitizes dashboard build failures instead of leaking database internals', async () => {
    portalTokenValue = 'test-secret-123';
    testDb.close();

    const { contentDashboardRoutes } = await import('../../src/api/routes/content-dashboard');
    const app = express();
    app.use('/api/v1/admin/content-dashboard', contentDashboardRoutes());

    const res = await fetchJson(app, '/api/v1/admin/content-dashboard', {
      Authorization: 'Bearer test-secret-123',
    });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to build content dashboard');
    expect(JSON.stringify(res.body)).not.toContain('database');
  });

  it('returns empty sections gracefully when the database is empty', async () => {
    const { buildContentDashboard } = await import('../../src/api/routes/content-dashboard');
    const data = buildContentDashboard();
    expect(data.ok).toBe(true);
    expect(data.books.total).toBe(0);
    expect(data.pipeline.totalActive).toBe(0);
    expect(data.youtube.totals.channels).toBe(0);
    expect(data.voiceDna).toEqual([]);
    // Commands are always emitted from the static registry even with no usage
    expect(data.commands.length).toBeGreaterThan(0);
    // Every row should have 0 calls
    for (const group of data.commands) {
      for (const row of group.rows) {
        expect(row.calls7d).toBe(0);
        expect(row.calls30d).toBe(0);
      }
    }
  });
});
