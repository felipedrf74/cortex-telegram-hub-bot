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
import { logPerformanceFeedback } from '../../src/services/content-learning-store';
import { setContentRadarPreferences } from '../../src/services/content-radar-preferences';


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
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, tenant_id, user_id)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', ?, NULL)
    `);

    insertSignal.run(
      'reaction-radar',
      'reaction_opportunity',
      JSON.stringify({ title: 'Tariff shift explainer', summary: 'Macro topic is climbing fast.' }),
      'urgent',
      recentDiscoveryAt,
      user.id
    );
    insertSignal.run(
      'performance-agent',
      'pillar_performance',
      JSON.stringify({ pillar: 'training', summary: 'Training is outperforming other pillars this week.' }),
      'normal',
      recentOptimizationAt,
      user.id
    );
    insertSignal.run(
      'performance-agent',
      'learning_digest',
      JSON.stringify({ summary: 'Hooks with stronger contrast won this week.' }),
      'normal',
      recentOptimizationAt,
      user.id
    );
    logPerformanceFeedback({
      views: 8600,
      retentionPct: 64,
      likes: 720,
      comments: 80,
      subsGained: 18,
      selectedTitle: 'Como reconstruir consistência de treino',
      hookUsed: 'Pare de perder consistência',
      userId: user.id,
      tenantId: user.id,
    });
    logPerformanceFeedback({
      views: 2400,
      retentionPct: 47,
      likes: 190,
      comments: 18,
      subsGained: 4,
      selectedTitle: 'Recuperação sem drama',
      userId: user.id,
      tenantId: user.id,
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
    expect(response.body.data.discovery.recentSignals).toHaveLength(1);
    expect(response.body.data.discovery.recentSignals[0]).toMatchObject({
      type: 'reaction_opportunity',
      title: 'Tariff shift explainer',
      summary: 'Janela de reação ativa: Macro topic is climbing fast.',
      priority: 'urgent',
    });
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
    expect(response.body.data.schedule.filmingRecommendation).toBeTruthy();
    expect(response.body.data.optimization.recentSignals).toHaveLength(2);
    expect(response.body.data.optimization.recentSignals[0]).toMatchObject({
      type: 'learning_digest',
      summary: 'Aprendizagem recente: Hooks with stronger contrast won this week.',
    });
    expect(response.body.data.optimization.recentSignals[1]).toMatchObject({
      type: 'pillar_performance',
      title: 'Treino',
      summary: 'Performance de Treino: Training is outperforming other pillars this week.',
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
    expect(response.body.data.discovery.recentSignals).toHaveLength(1);
    expect(response.body.data.discovery.recentSignals[0]).toMatchObject({
      title: 'Training',
      summary: 'Reaction window: treino com forte gancho',
    });
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
