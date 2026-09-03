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
    // independently from userId so we can exercise the assertTenantScope
    // catch path with a valid userId + invalid tenantId.
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

describe('Content API — intelligence summary', () => {
  beforeEach(() => {
    mockJobs = [
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
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
    clearTenantScopeAnomaliesForTests();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns discovery, voice, and optimization status for the iOS content landing', async () => {
    const user = getOrCreateUser(47001, { username: 'creator-content' });
    setUserLanguage(user.id, 'pt-PT');
    const recentDiscoveryAt = daysAgoIso(2);
    const recentOptimizationAt = daysAgoIso(3);

    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('brand_voice', 'Direct, sharp, coach-like.', JSON.stringify(['@felipe', '@danielbarada']), user.id, 2, '2026-04-14T09:00:00.000Z');

    testDb.prepare(`
      INSERT INTO content_ref_channels (user_id, channel_url, channel_name, status, video_count_analyzed, last_analyzed_at)
      VALUES (?, ?, ?, 'active', 12, ?)
    `).run(user.id, 'https://www.youtube.com/@felipe', 'Felipe', '2026-04-14T08:30:00.000Z');

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
    insertSignal.run('reaction-radar', 'reaction_opportunity', JSON.stringify({ title: 'Tariff shift explainer' }), 'urgent', recentDiscoveryAt, user.id, user.id, '{}');
    insertSignal.run('performance-agent', 'pillar_performance', JSON.stringify({ pillar: 'training' }), 'normal', recentOptimizationAt, user.id, user.id, '{}');
    insertSignal.run('performance-agent', 'learning_digest', JSON.stringify({ summary: 'Hooks with stronger contrast won this week.' }), 'normal', recentOptimizationAt, user.id, user.id, '{}');
    insertSignal.run('autoresearch', 'creator_learning_digest', JSON.stringify({ summary: 'Keep the current repeatable format.', inputEligibility }), 'normal', recentOptimizationAt, user.id, user.id, learningProvenance);

    const response = await dispatch('/intelligence', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.discovery).toMatchObject({
      status: 'warming_up',
      reactionRadarLifecycle: 'paused',
      cadenceHours: null,
      activeCount: 0,
      lastRunAt: null,
      lastStatus: 'paused',
    });
    expect(response.body.data.script).toMatchObject({
      status: 'ready',
      voicePatternCount: 1,
      referenceChannelCount: 1,
      sourceCount: 2,
      hasBrandVoice: true,
    });
    expect(response.body.data.optimization).toMatchObject({
      status: 'ready',
      cadence: 'weekly',
      activeInsightCount: 1,
      performanceLifecycle: 'paused',
      performanceLastRunAt: null,
      performanceLastStatus: 'paused',
      seoLifecycle: 'paused',
      seoLastRunAt: null,
      seoLastStatus: 'paused',
      autoresearchLastStatus: 'never',
    });
  });

  it('honestly reports setup-needed state when voice DNA is missing', async () => {
    const user = getOrCreateUser(47002, { username: 'creator-empty' });
    setUserLanguage(user.id, 'en');
    mockJobs = mockJobs.map((job) => ({ ...job, lastResult: 'never' as const, lastRunAt: null }));

    const response = await dispatch('/intelligence', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.discovery.status).toBe('warming_up');
    expect(response.body.data.script.status).toBe('needs_setup');
    expect(response.body.data.optimization.status).toBe('warming_up');
    expect(response.body.data.script.referenceChannelCount).toBe(0);
  });

  it('filters discovery counts through creator radar preferences when present', async () => {
    const user = getOrCreateUser(47003, { username: 'creator-filtered-radar' });
    setUserLanguage(user.id, 'pt-BR');
    const recentFitnessSignalAt = daysAgoIso(1);
    const recentPoliticsSignalAt = daysAgoIso(1);

    setContentRadarPreferences(user.id, ['fitness']);

    const insertSignal = testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, tenant_id, user_id)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', ?, NULL)
    `);

    insertSignal.run('reaction-radar', 'reaction_opportunity', JSON.stringify({ title: 'fitness reaction angle' }), 'urgent', recentFitnessSignalAt, user.id);
    insertSignal.run('reaction-radar', 'reaction_opportunity', JSON.stringify({ title: 'politics reaction angle' }), 'urgent', recentPoliticsSignalAt, user.id);

    const response = await dispatch('/intelligence', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.discovery.activeCount).toBe(0);
  });

  it('fails closed on invalid tenant scope before building intelligence summary', async () => {
    const response = await dispatch('/intelligence', 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'content_route_intelligence_summary',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // QA regression pin (skill-hardening 2026-05-18 follow-up, P3-2):
  // Pin the assertTenantScope catch path (valid userId + invalid tenantId)
  // separately from the ensureValidContentRouteScope path (invalid userId).
  // ─────────────────────────────────────────────────────────────────────

  it('returns 401 (not 500) when assertTenantScope rejects valid-user + tenantId=0', async () => {
    const response = await dispatch('/intelligence', 42, {}, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    // See content-intelligence-detail.test.ts: tenantId=0 categorises as
    // 'invalid_user_scope' per the current reason-derivation logic.
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'content_route_intelligence_summary',
          userId: 42,
        }),
      ]),
    );
  });

  it('returns 401 when assertTenantScope rejects valid-user + negative tenant', async () => {
    const response = await dispatch('/intelligence', 42, {}, -7);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when assertTenantScope rejects valid-user + undefined tenant', async () => {
    const response = await dispatch('/intelligence', 42, {}, null);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});
