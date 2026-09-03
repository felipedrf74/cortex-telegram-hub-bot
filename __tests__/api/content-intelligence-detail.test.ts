import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request } from 'express';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

let testDb: Database.Database;
let mockJobs = [
  {
    name: 'reaction_radar',
    label: 'Reaction Radar',
    cronExpression: '0 8,14,20 * * *',
    domain: 'content',
    lastRunAt: '2026-04-14T08:00:00.000Z',
    lastResult: 'success',
    lastDurationMs: 4200,
    lastError: null,
  },
  {
    name: 'performance_agent',
    label: 'Performance Intel',
    cronExpression: '0 6 * * 0',
    domain: 'content',
    lastRunAt: '2026-04-13T06:00:00.000Z',
    lastResult: 'success',
    lastDurationMs: 6500,
    lastError: null,
  },
  {
    name: 'seo_agent',
    label: 'SEO Tracker',
    cronExpression: '0 6 * * 1',
    domain: 'content',
    lastRunAt: '2026-04-12T06:00:00.000Z',
    lastResult: 'success',
    lastDurationMs: 5100,
    lastError: null,
  },
  {
    name: 'autoresearch',
    label: 'Autoresearch',
    cronExpression: '0 3 * * 0',
    domain: 'content',
    lastRunAt: null,
    lastResult: 'never',
    lastDurationMs: null,
    lastError: null,
  },
];

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/portal/telemetry', () => ({
  getJobStatuses: () => mockJobs,
}));

import { contentRoutes } from '../../src/api/routes/content';
import { getOrCreateUser, setUserLanguage } from '../../src/services/user-service';
import { setDbProvider } from '../../src/services/intelligence-bus';
import { createContentArtifact, createContentWorkspaceItem } from '../../src/services/content-workspace';
import {
  recordContentPerformanceOutcome,
  type RecordContentPerformanceOutcomeInput,
} from '../../src/services/content-performance-lineage';
import { setContentRadarPreferences } from '../../src/services/content-radar-preferences';
import { ensureContentTenantScopeColumns } from '../../src/services/content-tenant-scope';


interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(
  userId: number,
  headers: Record<string, string> = {},
  tenantIdOverride?: number | null | undefined,
): Request {
  return {
    userId,
    // 2026-05-18 follow-up QA P3-2: allow caller to override tenantId
    // independently from userId so we can exercise the
    // assertTenantScope-catch path with a valid userId + invalid tenantId.
    tenantId: tenantIdOverride === undefined ? userId : tenantIdOverride,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name] ?? undefined;
    },
  } as any;
}

async function dispatch(
  url: string,
  userId: number,
  headers: Record<string, string> = {},
  tenantIdOverride?: number | null | undefined,
): Promise<MockRes> {
  const router = contentRoutes();
  const request = mockReq(userId, headers, tenantIdOverride);
  const parsed = new URL(url, 'http://test.local');
  (request as any).method = 'GET';
  (request as any).url = parsed.pathname + parsed.search;
  (request as any).originalUrl = parsed.pathname + parsed.search;
  (request as any).baseUrl = '';
  (request as any).path = parsed.pathname;
  (request as any).query = Object.fromEntries(parsed.searchParams.entries());
  (request as any).params = {};
  (request as any).headers = headers;

  const response = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(request, response, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return response;
}

function recordCanonicalPerformance(
  userId: number,
  suffix: string,
  outcome: Omit<
    RecordContentPerformanceOutcomeInput,
    'scope' | 'itemId' | 'artifactId' | 'revisionId' | 'idempotencyKey'
  >,
): void {
  const scope = { tenantId: userId, userId };
  const item = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: `Intelligence performance ${suffix}`,
    idempotencyKey: `intelligence-performance-item-${userId}-${suffix}`,
  }, testDb).value;
  const artifact = createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `Published script ${suffix}` },
    idempotencyKey: `intelligence-performance-artifact-${userId}-${suffix}`,
  }, testDb).value;
  recordContentPerformanceOutcome({
    scope,
    itemId: item.id,
    artifactId: artifact.id,
    revisionId: artifact.currentRevisionId!,
    idempotencyKey: `intelligence-performance-outcome-${userId}-${suffix}`,
    ...outcome,
  }, testDb);
}

function daysAgoIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe('Content API — intelligence detail', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
    clearTenantScopeAnomaliesForTests();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns drill-in discovery, script, schedule, and optimization detail for iOS', async () => {
    const user = getOrCreateUser(57001, { username: 'content-deep-dive' });
    setUserLanguage(user.id, 'pt-PT');
    const recentDiscoveryAt = daysAgoIso(2);
    const recentOptimizationAt = daysAgoIso(3);

    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('brand_voice', 'Direct, sharp, coach-like.', JSON.stringify(['@felipe', '@danielbarada']), user.id, 2, '2026-04-14T09:00:00.000Z');

    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('hook_style', 'Open with a contrarian line and immediate payoff.', JSON.stringify(['@felipe']), user.id, 1, '2026-04-14T08:45:00.000Z');

    testDb.prepare(`
      INSERT INTO content_ref_channels (user_id, channel_url, channel_name, status, video_count_analyzed, last_analyzed_at)
      VALUES (?, ?, ?, 'active', 12, ?)
    `).run(user.id, 'https://www.youtube.com/@felipe', 'Felipe', '2026-04-14T08:30:00.000Z');

    testDb.exec(`
      CREATE TABLE IF NOT EXISTS config_pillars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        keywords TEXT,
        weight REAL NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        language TEXT,
        user_id INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Closed-beta-auth-hardening (2026-05-04): the previous test seeded
    // the `Training` pillar at user_id=0 (platform-seed bucket) and
    // expected the response to merge it with the user-scoped `Recovery`
    // pillar. The strict-per-user fix in
    // `services/content-intelligence.ts` now refuses to surface
    // user_id=0 rows for any per-user read (they were a cross-tenant
    // leak vector — every user inherited every platform-seed pillar
    // with weight > 1). Both pillars are now seeded per-user; the
    // assertion below was updated to match the strict-per-user
    // contract.
    testDb.prepare(`
      INSERT INTO config_pillars (name, keywords, weight, enabled, user_id)
      VALUES (?, ?, ?, 1, ?)
    `).run('Training', JSON.stringify(['run', 'ride', 'gym']), 1.2, user.id);
    testDb.prepare(`
      INSERT INTO config_pillars (name, keywords, weight, enabled, user_id)
      VALUES (?, ?, ?, 1, ?)
    `).run('Recovery', JSON.stringify(['recovery', 'sleep']), 1.0, user.id);

    testDb.prepare(`
      INSERT INTO content_notifications (user_id, type, title, body, data, status, created_at)
      VALUES (?, 'script_ready', ?, ?, '{}', 'unread', ?)
    `).run(user.id, 'Roteiro pronto para Recovery vlog', 'O draft já está pronto para revisão.', '2026-04-14T09:15:00.000Z');
    testDb.prepare(`
      INSERT INTO content_notifications (user_id, type, title, body, data, status, created_at)
      VALUES (?, 'topic_candidates_ready', ?, ?, '{}', 'unread', ?)
    `).run(user.id, 'Tópicos prontos para esta semana', 'Há novas ideias a aguardar decisão.', '2026-04-14T09:10:00.000Z');

    const insertSignal = testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, tenant_id, user_id, provenance_json)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', ?, ?, ?)
    `);
    const learningProvenance = JSON.stringify({
      producerVersion: 'cross-agent-learning.v3',
      source: 'runtime',
      observedAt: recentOptimizationAt,
    });
    const inputEligibility = {
      policyVersion: 'active-content-agent-sources.v1',
      sourceAgents: ['autoresearch'],
      sourceSignalIds: [1],
    };

    insertSignal.run(
      'reaction-radar',
      'reaction_opportunity',
      JSON.stringify({ title: 'Tariff shift explainer', summary: 'Macro topic is climbing fast.' }),
      'urgent',
      recentDiscoveryAt,
      user.id,
      user.id,
      '{}'
    );
    insertSignal.run(
      'performance-agent',
      'pillar_performance',
      JSON.stringify({ pillar: 'training', summary: 'Training is outperforming other pillars this week.' }),
      'normal',
      recentOptimizationAt,
      user.id,
      user.id,
      '{}'
    );
    insertSignal.run(
      'performance-agent',
      'learning_digest',
      JSON.stringify({ summary: 'Hooks with stronger contrast won this week.' }),
      'normal',
      recentOptimizationAt,
      user.id,
      user.id,
      '{}'
    );
    insertSignal.run(
      'autoresearch',
      'creator_learning_digest',
      JSON.stringify({ summary: 'Keep the current repeatable format.', inputEligibility }),
      'normal',
      recentOptimizationAt,
      user.id,
      user.id,
      learningProvenance
    );
    recordCanonicalPerformance(user.id, 'strong', {
      views: 8600,
      retentionPct: 64,
      likes: 720,
      comments: 80,
      subsGained: 18,
      selectedTitle: 'Como reconstruir consistência de treino',
      hookUsed: 'Pare de perder consistência',
    });
    recordCanonicalPerformance(user.id, 'moderate', {
      views: 2400,
      retentionPct: 47,
      likes: 190,
      comments: 18,
      subsGained: 4,
      selectedTitle: 'Recuperação sem drama',
    });

    const response = await dispatch('/intelligence/detail', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.discovery.deskReadyCount).toBe(2);
    expect(response.body.data.discovery.deskItems[0]).toMatchObject({
      type: 'script_ready',
      title: 'Roteiro pronto para Recovery vlog',
    });
    expect(response.body.data.discovery.monitoredPillars).toEqual([
      { name: 'Training', keywordCount: 3 },
      { name: 'Recovery', keywordCount: 2 },
    ]);
    expect(response.body.data.discovery).toMatchObject({
      reactionRadarLifecycle: 'paused',
      cadenceHours: null,
      activeCount: 0,
      lastRunAt: null,
      lastStatus: 'paused',
    });
    expect(response.body.data.discovery.recentSignals).toEqual([]);
    expect(response.body.data.script.entries).toHaveLength(2);
    expect(response.body.data.script.entries[0]).toMatchObject({
      category: 'brand_voice',
      label: 'Voz da marca',
      sourceCount: 2,
      version: 2,
    });
    expect(response.body.data.script.knowledgeCategories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'brand_voice',
          label: 'Voz da marca',
          sourceCount: 2,
        }),
      ])
    );
    expect(response.body.data.schedule.status).toBe('ready');
    expect(response.body.data.schedule).toMatchObject({
      statusSemantics: 'recommendation_availability_not_calendar_authority',
      calendarAuthority: 'not_included',
      recommendationSemantics: 'proposal_not_calendar_reservation',
    });
    expect(response.body.data.schedule.filmingRecommendation).toBeTruthy();
    expect(response.body.data.optimization).toMatchObject({
      activeInsightCount: 1,
      performanceLifecycle: 'paused',
      performanceLastRunAt: null,
      performanceLastStatus: 'paused',
      seoLifecycle: 'paused',
      seoLastRunAt: null,
      seoLastStatus: 'paused',
    });
    expect(response.body.data.optimization.recentSignals).toHaveLength(1);
    expect(response.body.data.optimization.recentSignals[0]).toMatchObject({
      type: 'creator_learning_digest',
      summary: 'Aprendizagem recente: Keep the current repeatable format.',
    });
    expect(response.body.data.optimization.performanceSummary).toMatchObject({
      count: 2,
      avgViews: 5500,
      avgRetention: 55.5,
      totalLikes: 910,
      totalComments: 98,
      totalSubsGained: 22,
      topEntry: {
        title: 'Como reconstruir consistência de treino',
        views: 8600,
        retentionPct: 64,
        likes: 720,
        comments: 80,
        subsGained: 18,
      },
    });
    expect(response.body.data.optimization.performanceSummary.recentEntries).toHaveLength(2);
  });

  it('applies creator radar preferences and english response language from X-Language', async () => {
    const user = getOrCreateUser(57002, { username: 'content-english-radar' });
    setUserLanguage(user.id, 'pt-BR');
    const recentFitnessSignalAt = daysAgoIso(1);
    const recentPoliticsSignalAt = daysAgoIso(1);

    setContentRadarPreferences(user.id, ['fitness', 'training consistency']);

    const insertSignal = testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, tenant_id, user_id)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', ?, NULL)
    `);

    insertSignal.run(
      'reaction-radar',
      'reaction_opportunity',
      JSON.stringify({ title: 'fitness', summary: 'Janela de reação ativa: treino com forte gancho' }),
      'urgent',
      recentFitnessSignalAt,
      user.id
    );
    insertSignal.run(
      'reaction-radar',
      'reaction_opportunity',
      JSON.stringify({ title: 'politics', summary: 'Janela de reação ativa: debate fiscal' }),
      'urgent',
      recentPoliticsSignalAt,
      user.id
    );

    const response = await dispatch('/intelligence/detail', user.id, { 'x-language': 'en-US' });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.discovery.preferredTopics).toEqual(['fitness', 'training consistency']);
    expect(response.body.data.discovery.monitoredPillars).toEqual([
      { name: 'fitness', keywordCount: 1 },
      { name: 'training consistency', keywordCount: 1 },
    ]);
    expect(response.body.data.discovery.recentSignals).toEqual([]);
  });

  it('keeps intelligence details private across tenant scope and limits NULL legacy rows to personal tenant', async () => {
    const user = getOrCreateUser(57003, { username: 'content-intelligence-scope' });
    ensureContentTenantScopeColumns(testDb);

    const insertPillar = testDb.prepare(`
      INSERT INTO config_pillars (
        name, keywords, weight, enabled, user_id,
        tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)
    `);
    insertPillar.run('Personal legacy pillar', '["personal"]', user.id, null, null, null, null);
    insertPillar.run('Tenant 84 pillar', '["tenant84"]', user.id, 84, user.id, 'user_private', 'active');
    insertPillar.run('Foreign shared pillar', '["shared"]', 999, 84, 999, 'tenant_shared', 'active');
    insertPillar.run('Malformed foreign pillar', '["malformed"]', user.id, 84, 999, 'user_private', 'active');

    const insertNotification = testDb.prepare(`
      INSERT INTO content_notifications (
        user_id, type, title, body, data, status,
        tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES (?, 'script_ready', ?, ?, '{}', 'unread', ?, ?, ?, ?)
    `);
    insertNotification.run(user.id, 'Personal legacy desk', 'personal-legacy-detail', null, null, null, null);
    insertNotification.run(user.id, 'Tenant 84 desk', 'tenant-84-detail', 84, user.id, 'user_private', 'active');
    insertNotification.run(999, 'Foreign shared desk', 'foreign-shared-detail', 84, 999, 'tenant_shared', 'active');
    insertNotification.run(user.id, 'Malformed foreign desk', 'malformed-foreign-detail', 84, 999, 'user_private', 'active');

    const insertKnowledge = testDb.prepare(`
      INSERT INTO content_knowledge (
        category, synthesized_text, source_channels, user_id,
        tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES (?, ?, '[]', ?, ?, ?, ?, ?)
    `);
    insertKnowledge.run('personal_legacy_voice', 'personal-legacy-voice-detail', user.id, null, null, null, null);
    insertKnowledge.run('tenant_84_voice', 'tenant-84-voice-detail', user.id, 84, user.id, 'user_private', 'active');
    insertKnowledge.run('foreign_shared_voice', 'foreign-shared-voice-detail', 999, 84, 999, 'tenant_shared', 'active');

    const tenant84 = await dispatch('/intelligence/detail', user.id, {}, 84);
    const tenant84Json = JSON.stringify(tenant84.body.data);
    expect(tenant84.statusCode).toBe(200);
    expect(tenant84Json).toContain('Tenant 84 pillar');
    expect(tenant84Json).toContain('Tenant 84 desk');
    expect(tenant84Json).toContain('tenant_84_voice');
    expect(tenant84Json).not.toContain('Personal legacy pillar');
    expect(tenant84Json).not.toContain('personal-legacy-detail');
    expect(tenant84Json).not.toContain('personal_legacy_voice');
    expect(tenant84Json).not.toContain('Foreign shared pillar');
    expect(tenant84Json).not.toContain('foreign-shared-detail');
    expect(tenant84Json).not.toContain('foreign_shared_voice');
    expect(tenant84Json).not.toContain('Malformed foreign pillar');
    expect(tenant84Json).not.toContain('malformed-foreign-detail');

    const personal = await dispatch('/intelligence/detail', user.id);
    const personalJson = JSON.stringify(personal.body.data);
    expect(personal.statusCode).toBe(200);
    expect(personalJson).toContain('Personal legacy pillar');
    expect(personalJson).toContain('Personal legacy desk');
    expect(personalJson).toContain('personal_legacy_voice');
    expect(personalJson).not.toContain('Tenant 84 pillar');
    expect(personalJson).not.toContain('tenant-84-detail');
    expect(personalJson).not.toContain('tenant_84_voice');
  });

  it('fails closed on invalid tenant scope before building intelligence detail', async () => {
    const response = await dispatch('/intelligence/detail', 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'content_route_intelligence_detail',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // QA regression pin (skill-hardening 2026-05-18 follow-up, P3-2):
  // The previous QA found that the existing "fails closed" test passes
  // userId=0 (and mockReq sets tenantId=userId=0), which trips
  // ensureValidContentRouteScope FIRST and never exercises the new
  // requireContentIntelligenceScope catch block on assertTenantScope.
  // These tests pass valid userId + invalid tenantId so the route enters
  // the catch path and we lock in the 401-not-500 contract.
  // ─────────────────────────────────────────────────────────────────────

  it('returns 401 (not 500) when assertTenantScope rejects valid-user + invalid-tenant', async () => {
    const response = await dispatch('/intelligence/detail', 42, {}, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    // Note: when tenantId === 0 (invalid) but userId is valid, the existing
    // assertTenantScope reason-derivation logic categorises this as
    // 'invalid_user_scope' (the reason ternary only flips to
    // 'missing_tenant_scope' when tenantId === null). Pinning the actual
    // behavior so a future change to that ternary is visible.
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'content_route_intelligence_detail',
          userId: 42,
        }),
      ]),
    );
  });

  it('returns 401 when assertTenantScope rejects valid-user + negative tenant', async () => {
    const response = await dispatch('/intelligence/detail', 42, {}, -7);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when assertTenantScope rejects valid-user + undefined tenant', async () => {
    const response = await dispatch('/intelligence/detail', 42, {}, null);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});
