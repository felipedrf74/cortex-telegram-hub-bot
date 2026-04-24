import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/portal/telemetry', () => ({
  getJobStatuses: () => mockJobs,
}));

import { contentRoutes } from '../../src/api/routes/content';
import { getOrCreateUser, setUserLanguage } from '../../src/services/user-service';
import { setDbProvider } from '../../src/services/intelligence-bus';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // ignore incompatible migrations in unit tests
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_agent TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT NOT NULL DEFAULT (datetime('now', '+7 days')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_by TEXT NOT NULL DEFAULT '[]',
      user_id INTEGER,
      confidence REAL NOT NULL DEFAULT 0.5,
      format_tag TEXT,
      pillar_tag TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 1
    )
  `);
}

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

function mockReq(userId: number, headers: Record<string, string> = {}): Request {
  return {
    userId,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name] ?? undefined;
    },
  } as any;
}

async function dispatch(url: string, userId: number, headers: Record<string, string> = {}): Promise<MockRes> {
  const router = contentRoutes();
  const request = mockReq(userId, headers);
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
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
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
    testDb.prepare(`
      INSERT INTO config_pillars (name, keywords, weight, enabled, user_id)
      VALUES (?, ?, ?, 1, 0)
    `).run('Training', JSON.stringify(['run', 'ride', 'gym']), 1.2);
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
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, user_id)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', NULL)
    `);

    insertSignal.run(
      'reaction-radar',
      'reaction_opportunity',
      JSON.stringify({ title: 'Tariff shift explainer', summary: 'Macro topic is climbing fast.' }),
      'urgent',
      recentDiscoveryAt
    );
    insertSignal.run(
      'performance-agent',
      'pillar_performance',
      JSON.stringify({ pillar: 'training', summary: 'Training is outperforming other pillars this week.' }),
      'normal',
      recentOptimizationAt
    );
    insertSignal.run(
      'performance-agent',
      'learning_digest',
      JSON.stringify({ summary: 'Hooks with stronger contrast won this week.' }),
      'normal',
      recentOptimizationAt
    );

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
  });

  it('applies creator radar preferences and english response language from X-Language', async () => {
    const user = getOrCreateUser(57002, { username: 'content-english-radar' });
    setUserLanguage(user.id, 'pt-BR');
    const recentPreferenceAt = daysAgoIso(1);
    const recentFitnessSignalAt = daysAgoIso(1);
    const recentPoliticsSignalAt = daysAgoIso(1);

    testDb.prepare(`
      INSERT INTO content_radar_preferences (user_id, topics_json, updated_at)
      VALUES (?, ?, ?)
    `).run(user.id, JSON.stringify(['fitness', 'training consistency']), recentPreferenceAt);

    const insertSignal = testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, user_id)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', NULL)
    `);

    insertSignal.run(
      'reaction-radar',
      'reaction_opportunity',
      JSON.stringify({ title: 'fitness', summary: 'Janela de reação ativa: treino com forte gancho' }),
      'urgent',
      recentFitnessSignalAt
    );
    insertSignal.run(
      'reaction-radar',
      'reaction_opportunity',
      JSON.stringify({ title: 'politics', summary: 'Janela de reação ativa: debate fiscal' }),
      'urgent',
      recentPoliticsSignalAt
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
});
