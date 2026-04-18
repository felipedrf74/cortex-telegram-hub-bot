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
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    setDbProvider(() => testDb);
    clearTenantScopeAnomaliesForTests();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns discovery, voice, and optimization status for the iOS content landing', async () => {
    const user = getOrCreateUser(47001, { username: 'creator-content' });
    setUserLanguage(user.id, 'pt-PT');

    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('brand_voice', 'Direct, sharp, coach-like.', JSON.stringify(['@felipe', '@danielbarada']), user.id, 2, '2026-04-14T09:00:00.000Z');

    testDb.prepare(`
      INSERT INTO content_ref_channels (user_id, channel_url, channel_name, status, video_count_analyzed, last_analyzed_at)
      VALUES (?, ?, ?, 'active', 12, ?)
    `).run(user.id, 'https://www.youtube.com/@felipe', 'Felipe', '2026-04-14T08:30:00.000Z');

    const insertSignal = testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, user_id)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', NULL)
    `);

    insertSignal.run('reaction-radar', 'reaction_opportunity', JSON.stringify({ title: 'Tariff shift explainer' }), 'urgent', '2026-04-14T08:05:00.000Z');
    insertSignal.run('performance-agent', 'pillar_performance', JSON.stringify({ pillar: 'training' }), 'normal', '2026-04-13T06:30:00.000Z');
    insertSignal.run('performance-agent', 'learning_digest', JSON.stringify({ summary: 'Hooks with stronger contrast won this week.' }), 'normal', '2026-04-13T06:35:00.000Z');

    const response = await dispatch('/intelligence', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.discovery).toMatchObject({
      status: 'ready',
      cadenceHours: 4,
      activeCount: 1,
      lastStatus: 'success',
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
      activeInsightCount: 2,
      performanceLastStatus: 'success',
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

    testDb.prepare(`
      INSERT INTO content_radar_preferences (user_id, topics_json, updated_at)
      VALUES (?, ?, ?)
    `).run(user.id, JSON.stringify(['fitness']), '2026-04-16T11:00:00.000Z');

    const insertSignal = testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at, created_at, consumed_by, user_id)
      VALUES (?, ?, ?, ?, 'active', datetime('now', '+7 days'), ?, '[]', NULL)
    `);

    insertSignal.run('reaction-radar', 'reaction_opportunity', JSON.stringify({ title: 'fitness reaction angle' }), 'urgent', '2026-04-16T08:05:00.000Z');
    insertSignal.run('reaction-radar', 'reaction_opportunity', JSON.stringify({ title: 'politics reaction angle' }), 'urgent', '2026-04-16T08:10:00.000Z');

    const response = await dispatch('/intelligence', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.discovery.activeCount).toBe(1);
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
});
