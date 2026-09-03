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
 *   - Pipeline: reflects tenant-scoped canonical workspace projections.
 *   - Commands: includes a row for every known content command and fills
 *               calls7d from matching api_usage categories.
 *   - Agent graph: includes the static nodes and overlays zero runs
 *                  when agent_runs is empty.
 *   - YouTube: reflects seeded content_ref_channels + video_transcripts.
 *   - Voice DNA: reflects seeded content_knowledge rows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import express from 'express';
import http from 'http';
import {
  createContentArtifact,
  createContentWorkspaceItem,
} from '../../src/services/content-workspace';
import { getDb } from '../../src/services/database';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


let testDb: Database.Database;
let portalTokenValue = '';
let portalReadTokenValue = '';
let portalWriteTokenValue = '';
let portalAllowLocalBypass = false;
const mockDashboardActiveSignalCount = vi.fn((..._args: unknown[]) => 3);
const mockDashboardSignalLog = vi.fn((..._args: unknown[]) => undefined);
const mockDashboardAgentStats = vi.fn((..._args: unknown[]) => [
  { agent: 'pipeline-agent', last_run: '2026-04-08T20:00:00Z', last_status: 'success', signals_produced: 4, total_runs: 12 },
  { agent: 'reaction-radar', last_run: '2026-04-09T08:00:00Z', last_status: 'failed', signals_produced: 0, total_runs: 40 },
  { agent: 'performance-agent', last_run: '2026-04-06T06:00:00Z', last_status: 'success', signals_produced: 9, total_runs: 5 },
  { agent: 'seo-agent', last_run: '2026-04-07T06:00:00Z', last_status: 'success', signals_produced: 7, total_runs: 6 },
]);
const dashboardLifecycleState = vi.hoisted(() => ({ reactionRadarActive: false }));

// ── Mocks ────────────────────────────────────────────────────────────
// NOTE: every mock below must be defined BEFORE the unit under test is
// imported. Vitest hoists `vi.mock` calls to the top of the file, but
// the factory functions still execute in import order, so we keep them
// all together.

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn(() => testDb),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/content-agent-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/content-agent-lifecycle')>();
  return {
    ...actual,
    isPausedContentAgent: (agentId: string) => (
      dashboardLifecycleState.reactionRadarActive
        && agentId.trim().toLowerCase().replaceAll('-', '_') === 'reaction_radar'
        ? false
        : actual.isPausedContentAgent(agentId)
    ),
  };
});

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
    {
      name: 'performance_agent',
      label: 'Performance Intel',
      cronExpression: '0 6 * * 0',
      domain: 'content',
      lastRunAt: '2026-04-06T06:00:00Z',
      lastResult: 'success',
      lastDurationMs: 10,
      lastError: null,
    },
    {
      name: 'seo_agent',
      label: 'SEO Tracking',
      cronExpression: '0 6 * * 1',
      domain: 'content',
      lastRunAt: '2026-04-07T06:00:00Z',
      lastResult: 'success',
      lastDurationMs: 10,
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
  getAgentStats: (...args: unknown[]) => mockDashboardAgentStats(...args),
  getSignalLog: (...args: unknown[]) => {
    mockDashboardSignalLog(...args);
    return [
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
    ];
  },
  getActiveSignalCount: (...args: unknown[]) => mockDashboardActiveSignalCount(...args),
  writeSignal: vi.fn(),
  writeGovernedSignal: vi.fn(() => 1),
}));

// Pipeline stats come from the canonical workspace read model through the
// real pipeline agent implementation.

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
  const scope = { tenantId: 1, userId: 1 };
  createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: 'Idea A',
    idempotencyKey: 'dashboard-idea-approved',
  }, testDb).value;
  const scripted = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: 'Idea B',
    idempotencyKey: 'dashboard-idea-scripted',
  }, testDb).value;
  createContentArtifact({
    scope,
    itemId: scripted.id,
    expectedWorkflowVersion: scripted.workflowVersion,
    artifactType: 'script',
    title: 'Idea B script',
    initialContent: { format: 'plain_text', text: 'Canonical script fixture.' },
    idempotencyKey: 'dashboard-script-artifact',
  }, testDb);
  const published = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: 'Idea C',
    idempotencyKey: 'dashboard-idea-published',
  }, testDb).value;

  testDb.prepare(`
    UPDATE content_domain_objects
       SET production_state = 'published', lifecycle_state = 'published', updated_at = datetime('now')
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
  `).run(published.id, scope.tenantId, scope.userId);
  testDb.prepare(`
    INSERT INTO content_workflow_events (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, object_id, action, from_state, to_state,
      approval_state, review_required, reason_codes_json,
      actor_user_id, metadata_json, created_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
      'workspace_state_changed', 'approved', 'published', 'approved', 0,
      '[]', ?, '{}', datetime('now'))
  `).run(scope.tenantId, scope.userId, String(published.id), scope.userId);

}

function seedYouTube() {
  const channelInsert = testDb.prepare(`
    INSERT INTO content_ref_channels (channel_url, channel_name, status,
      video_count_analyzed, last_analyzed_at, added_via, user_id, owner_scope,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, 'manual', 0, 'system', 0, 0, 'platform_internal',
      'active', 'active', 0, 0)
  `);
  channelInsert.run('https://youtube.com/@nando', 'Nando Moura', 'active', 12, '2026-04-08T00:00:00Z');
  channelInsert.run('https://youtube.com/@renato', 'Renato 38tão', 'active', 8, '2026-04-07T00:00:00Z');
  channelInsert.run('https://youtube.com/@pending', null, 'pending', 0, null);

  const transcriptInsert = testDb.prepare(`
    INSERT INTO video_transcripts (video_id, title, channel_name, full_text, source,
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by)
    VALUES (?, ?, ?, ?, 'manual', 0, 0, 0, 'platform_internal', 'active', 'active', 0, 0)
  `);
  transcriptInsert.run('abc123xyz01', 'Why the state always grows', 'Nando Moura', 'Transcript body...');
  transcriptInsert.run('def456abc02', 'Hybrid athlete reality check', 'Renato 38tão', 'Transcript body...');

  const studyInsert = testDb.prepare(`
    INSERT INTO video_studies (video_id, transcript_id, study_type, analysis_json,
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by)
    VALUES (?, 1, 'full', '{}', 0, 0, 0, 'platform_internal', 'active', 'active', 0, 0)
  `);
  studyInsert.run('abc123xyz01');

  testDb.prepare(`
    INSERT INTO content_ref_channels (
      channel_url, channel_name, status, video_count_analyzed, added_via,
      user_id, owner_scope, tenant_id, owner_user_id, visibility_scope,
      lifecycle_state, scope_status, created_by, updated_by
    ) VALUES (
      'https://youtube.com/@private', 'Private creator channel', 'active', 99, 'manual',
      77, 'user', 77, 77, 'user_private', 'active', 'active', 77, 77
    )
  `).run();
  testDb.prepare(`
    INSERT INTO video_transcripts (
      video_id, title, channel_name, full_text, source, user_id, tenant_id,
      owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by
    ) VALUES (
      'private00001', 'Private transcript title', 'Private creator channel', 'Private transcript body',
      'manual', 77, 77, 77, 'user_private', 'active', 'active', 77, 77
    )
  `).run();
  testDb.prepare(`
    INSERT INTO video_studies (
      video_id, transcript_id, study_type, analysis_json, user_id, tenant_id,
      owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by
    ) VALUES (
      'private00001', (SELECT id FROM video_transcripts WHERE video_id = 'private00001' AND user_id = 77),
      'full', '{}', 77, 77, 77, 'user_private', 'active', 'active', 77, 77
    )
  `).run();
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
    testDb = createMigratedTestDatabase();
    portalTokenValue = '';
    portalReadTokenValue = '';
    portalWriteTokenValue = '';
    portalAllowLocalBypass = false;
    dashboardLifecycleState.reactionRadarActive = false;
    mockDashboardActiveSignalCount.mockClear();
    mockDashboardActiveSignalCount.mockReturnValue(3);
    mockDashboardSignalLog.mockClear();
    mockDashboardAgentStats.mockClear();
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
    const data = buildContentDashboard({ tenantId: 1, userId: 1 });
    expect(data.ok).toBe(true);
    expect(typeof data.generatedAt).toBe('string');
    expect(data.availability).toBe('available');
    expect(data.unavailableSections).toEqual([]);
    expect(data.scope).toEqual({
      mode: 'mixed_operator_overview',
      workspaceScope: { tenantId: 1, userId: 1 },
      workspaceScopedSections: ['pipeline', 'activeSignals'],
      platformSections: [
        'commands',
        'books',
        'youtube',
        'agentGraph',
        'triggers',
        'voiceDna',
        'reactionRadar',
        'knowledgeStats',
        'referenceChannels',
      ],
    });

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
    expect(data.pipeline.stages.filming).toBe(0);
    expect(data.pipeline.stageTracking.filming).toMatchObject({
      tracking: 'not_modeled',
      reasonCode: 'CONTENT_FILMING_STATE_NOT_MODELED',
    });
    expect(data.pipeline.stages.editing).toBe(0);
    expect(data.pipeline.stages.published).toBeNull();
    expect(data.pipeline.totalActive).toBe(2); // approved + scripted
    expect(data.pipeline.publishedThisWeek).toBeNull();
    expect(data.pipeline.publicationTracking).toMatchObject({
      availability: 'unavailable',
      reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
      publicationExecution: 'not_supported',
    });
    expect(data.pipeline.recent.length).toBe(2);

    // YouTube — channels + videos + totals
    expect(data.youtube.totals.channels).toBe(3);
    expect(data.youtube.totals.activeChannels).toBe(2);
    expect(data.youtube.totals.transcripts).toBe(2);
    expect(data.youtube.totals.studies).toBe(1);
    expect(data.youtube.channels.length).toBe(3);
    expect(data.youtube.videos.length).toBe(2);
    expect(JSON.stringify(data.youtube)).not.toContain('Private creator channel');
    expect(JSON.stringify(data.youtube)).not.toContain('Private transcript title');
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
    const pipelineGroup = data.commands.find((g) => g.group === 'pipeline');
    const pipelineCommands = pipelineGroup?.rows.map((row) => row.name) ?? [];
    expect(pipelineCommands).not.toContain('filmed');
    expect(pipelineCommands).not.toContain('editing');
    expect(pipelineCommands).not.toContain('published');
    const discoverGroup = data.commands.find((g) => g.group === 'discover');
    expect(discoverGroup).toBeDefined();
    // content_discovery + content_discovery_continuation should have attributed
    // call counts to the /discover command row via LIKE matching.
    const discoverRow = discoverGroup?.rows.find((r) => r.name === 'discover');
    expect(discoverRow).toBeDefined();
    expect(discoverRow?.calls7d).toBeGreaterThanOrEqual(2);
    const seoGroup = data.commands.find((g) => g.group === 'seo');
    expect(seoGroup?.rows.find((r) => r.name === 'seokeyword')?.description).toContain('Paused');
    expect(seoGroup?.rows.find((r) => r.name === 'seorank')?.description).toContain('no global ranks');

    // Agent graph — every node is present, while only active lifecycle edges
    // remain visible, with current run stats overlaid.
    expect(data.agentGraph.nodes.length).toBeGreaterThan(5);
    expect(data.agentGraph.edges).toEqual([
      { from: 'book_extractor', to: 'voice_evolution', signal: 'book_knowledge' },
      { from: 'book_extractor', to: 'content_workflow', signal: 'book_knowledge' },
    ]);
    const pipelineNode = data.agentGraph.nodes.find((n) => n.id === 'pipeline_agent');
    expect(mockDashboardAgentStats).toHaveBeenCalledWith({ strict: true });
    expect(pipelineNode?.lastStatus).toBe('success');
    expect(pipelineNode?.totalRuns).toBe(12);
    const radarNode = data.agentGraph.nodes.find((n) => n.id === 'reaction_radar');
    expect(radarNode?.lastStatus).toBe('paused');
    const autoresearchNode = data.agentGraph.nodes.find((n) => n.id === 'autoresearch');
    expect(autoresearchNode?.emits).toEqual([]);
    expect(autoresearchNode?.role).toContain('read-only evaluation');
    expect(autoresearchNode?.role).toContain('never mutates prompts automatically');
    const voiceNode = data.agentGraph.nodes.find((n) => n.id === 'voice_evolution');
    expect(voiceNode?.consumes).toEqual(['book_knowledge']);
    expect(voiceNode?.emits).toEqual([
      'voice_pattern',
      'voice_phrase_trend',
      'voice_analysis_fingerprint',
    ]);
    expect(voiceNode?.role).toContain('agent-draft to creator-revision pairs');
    expect(data.agentGraph.nodes.find((n) => n.id === 'channel_learner')?.emits)
      .toEqual(['channel_dna']);
    expect(data.agentGraph.nodes.find((n) => n.id === 'content_discovery'))
      .toMatchObject({ emits: [], consumes: [] });
    expect(data.agentGraph.nodes.find((n) => n.id === 'content_workflow'))
      .toMatchObject({
        emits: [],
        consumes: ['book_knowledge', 'trending_spike', 'competitor_upload', 'reaction_opportunity'],
      });
    expect(pipelineNode).toMatchObject({
      emits: ['pipeline_bottleneck', 'pipeline_capacity'],
      consumes: [
        'keyword_opportunity',
        'hook_effectiveness',
        'pillar_performance',
        'content_formula',
        'content_sprint_mode',
      ],
    });
    for (const pausedId of ['performance_agent', 'reaction_radar', 'seo_agent']) {
      const pausedNode = data.agentGraph.nodes.find((node) => node.id === pausedId);
      expect(pausedNode).toMatchObject({
        lifecycle: 'paused',
        emits: [],
        lastRun: null,
        lastStatus: 'paused',
        totalRuns: 0,
        signalsProduced: 0,
      });
      expect(pausedNode?.role).toContain('Paused');
      expect(data.agentGraph.edges.some((edge) => edge.from === pausedId || edge.to === pausedId)).toBe(false);
    }

    // Triggers — only content-domain jobs, with paused jobs projected truthfully.
    expect(data.triggers.length).toBe(5);
    expect(data.triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining(['pipeline_agent', 'reaction_radar', 'voice_evolution']),
    );
    expect(data.triggers.every((t) => t.domain === 'content')).toBe(true);
    // Cron-parser should populate nextFireAt for parseable expressions
    const pipelineTrigger = data.triggers.find((t) => t.name === 'pipeline_agent');
    expect(pipelineTrigger?.nextFireAt).toBeTruthy();
    for (const pausedId of ['performance_agent', 'reaction_radar', 'seo_agent']) {
      expect(data.triggers.find((trigger) => trigger.name === pausedId)).toMatchObject({
        lifecycle: 'paused',
        status: 'paused',
        lastRunAt: null,
        lastResult: 'paused',
        lastDurationMs: null,
        nextFireAt: null,
      });
    }

    // Paused Reaction Radar does not expose historical runs or signals.
    expect(data.reactionRadar.recentSignals).toEqual([]);
    expect(data.reactionRadar.activeSignals).toBe(0);
    expect(data.reactionRadar.lastStatus).toBe('paused');
    expect(data.reactionRadar.lastRunAt).toBeNull();

    // Top-level counters
    expect(data.referenceChannels).toBe(3);
    expect(data.activeSignals).toBe(3);
    expect(mockDashboardActiveSignalCount).toHaveBeenCalledWith(1, 1, {
      excludeSourceAgents: ['performance_agent', 'reaction_radar', 'seo_agent'],
      excludeIneligibleContentLearningDigests: true,
      strict: true,
    });
    expect(data.knowledgeStats.length).toBe(2);
  });

  it('excludes paused producers before applying the reaction signal-log limit', async () => {
    dashboardLifecycleState.reactionRadarActive = true;
    const { buildContentDashboard } = await import('../../src/api/routes/content-dashboard');

    buildContentDashboard({ tenantId: 1, userId: 1 });

    expect(mockDashboardSignalLog).toHaveBeenCalledWith(40, undefined, undefined, {
      excludeSourceAgents: ['performance_agent', 'reaction_radar', 'seo_agent'],
    });
  });

  it('marks an active-signal read failure instead of presenting the zero fallback as available', async () => {
    mockDashboardActiveSignalCount.mockImplementationOnce(() => {
      throw new Error('sensitive storage failure details');
    });
    const { buildContentDashboard } = await import('../../src/api/routes/content-dashboard');

    const data = buildContentDashboard({ tenantId: 1, userId: 1 });

    expect(data.ok).toBe(true);
    expect(data.activeSignals).toBe(0);
    expect(data.availability).toBe('partial');
    expect(data.unavailableSections).toEqual(['activeSignals']);
  });

  it('marks agent runtime stats unavailable instead of presenting fallback never-runs as confirmed', async () => {
    mockDashboardAgentStats.mockImplementationOnce(() => {
      throw new Error('sensitive runtime storage failure details');
    });
    const { buildContentDashboard } = await import('../../src/api/routes/content-dashboard');

    const data = buildContentDashboard({ tenantId: 1, userId: 1 });

    expect(data.ok).toBe(true);
    expect(data.agentGraph.nodes.find((node) => node.id === 'pipeline_agent')?.lastStatus).toBe('never');
    expect(data.availability).toBe('partial');
    expect(data.unavailableSections).toEqual(['agentStats']);
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

  it('rate-limits unauthorized and authorized bursts before additional dashboard database work', async () => {
    portalTokenValue = 'test-secret-123';
    const {
      contentDashboardRoutes,
      CONTENT_DASHBOARD_RATE_LIMIT_PER_MINUTE,
    } = await import('../../src/api/routes/content-dashboard');

    const unauthorizedApp = express();
    unauthorizedApp.use('/api/v1/admin/content-dashboard', contentDashboardRoutes());
    for (let index = 0; index < CONTENT_DASHBOARD_RATE_LIMIT_PER_MINUTE; index += 1) {
      const response = await fetchJson(unauthorizedApp, '/api/v1/admin/content-dashboard');
      expect(response.status).toBe(401);
    }
    const unauthorizedBlocked = await fetchJson(unauthorizedApp, '/api/v1/admin/content-dashboard');
    expect(unauthorizedBlocked.status).toBe(429);
    expect(unauthorizedBlocked.body.error.code).toBe('RATE_LIMITED');

    const authorizedApp = express();
    authorizedApp.use('/api/v1/admin/content-dashboard', contentDashboardRoutes());
    for (let index = 0; index < CONTENT_DASHBOARD_RATE_LIMIT_PER_MINUTE; index += 1) {
      const response = await fetchJson(authorizedApp, '/api/v1/admin/content-dashboard', {
        Authorization: 'Bearer test-secret-123',
      });
      expect(response.status).toBe(200);
    }
    const databaseCallsBeforeBlock = vi.mocked(getDb).mock.calls.length;
    const authorizedBlocked = await fetchJson(authorizedApp, '/api/v1/admin/content-dashboard', {
      Authorization: 'Bearer test-secret-123',
    });
    expect(authorizedBlocked.status).toBe(429);
    expect(authorizedBlocked.body.error.code).toBe('RATE_LIMITED');
    expect(getDb).toHaveBeenCalledTimes(databaseCallsBeforeBlock);
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
    expect(data.availability).toBe('partial');
    expect(data.unavailableSections).toEqual(['activeSignals']);
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
