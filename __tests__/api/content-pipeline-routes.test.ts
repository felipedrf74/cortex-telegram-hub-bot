import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import Database from 'better-sqlite3';
import type { Request } from 'express';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/content-cache-invalidator', () => ({
  invalidateContentDerivedCaches: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

import { registerContentPipelineRoutes } from '../../src/api/routes/content-pipeline-routes';
import { invalidateContentDerivedCaches } from '../../src/services/content-cache-invalidator';

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

function mockReq(method: string, path: string, userId = 41, body: Record<string, unknown> = {}): Request {
  return {
    userId,
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    body,
    headers: {},
    header: () => undefined,
  } as any;
}

async function dispatch(method: string, path: string, body: Record<string, unknown> = {}, userId = 41): Promise<MockRes> {
  const router = Router();
  registerContentPipelineRoutes(router);
  const req = mockReq(method, path, userId, body);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

function seedIdea(userId: number, title: string, stage = 'ideas', createdAt = '2026-04-23T10:00:00.000Z'): number {
  const result = testDb.prepare(`
    INSERT INTO content_ideas (user_id, title, score, stage, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, title, 8.2, stage, createdAt);
  return Number(result.lastInsertRowid);
}

describe('content pipeline routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE content_ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        score REAL,
        stage TEXT DEFAULT 'ideas',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns grouped pipeline stages with per-user scoping', async () => {
    const now = new Date();
    const publishedThisMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      15,
      12,
      0,
      0,
    ).toISOString();
    seedIdea(41, 'Radar idea', 'ideas');
    seedIdea(41, 'Script ready', 'scripted');
    seedIdea(41, 'Published this month', 'published', publishedThisMonth);
    seedIdea(99, 'Other user idea', 'ideas');

    const response = await dispatch('GET', '/pipeline', {}, 41);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.stages.ideas).toHaveLength(1);
    expect(response.body.data.stages.scripted).toHaveLength(1);
    expect(response.body.data.stages.published).toHaveLength(1);
    expect(response.body.data.stats).toEqual({
      totalIdeas: 2,
      publishedThisMonth: 1,
    });
  });

  it('returns a stable empty pipeline when the table is unavailable', async () => {
    testDb.exec('DROP TABLE content_ideas');

    const response = await dispatch('GET', '/pipeline', {}, 41);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toEqual({
      stages: { ideas: [], scripted: [], filmed: [], editing: [], published: [] },
      stats: { totalIdeas: 0, publishedThisMonth: 0 },
    });
  });

  it('returns ideas with count metadata', async () => {
    seedIdea(41, 'Hybrid athlete workflow', 'ideas');
    seedIdea(41, 'Race-week recovery notes', 'scripted');
    seedIdea(99, 'Other user idea', 'ideas');

    const response = await dispatch('GET', '/ideas', {}, 41);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.ideas).toHaveLength(2);
    expect(response.body.data.count).toBe(2);
  });

  it('advances owned ideas and invalidates dashboard coordination caches', async () => {
    const id = seedIdea(41, 'Ready to script', 'ideas');

    const response = await dispatch('POST', `/pipeline/${id}/advance`, {}, 41);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({ advanced: true, newStage: 'scripted' });
    expect(testDb.prepare('SELECT stage FROM content_ideas WHERE id = ?').get(id)).toEqual({ stage: 'scripted' });
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(41);
  });

  it('does not report success or mutate global seed ideas', async () => {
    const id = seedIdea(0, 'System seed idea', 'ideas');

    const response = await dispatch('POST', `/pipeline/${id}/advance`, {}, 41);

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(testDb.prepare('SELECT stage FROM content_ideas WHERE id = ?').get(id)).toEqual({ stage: 'ideas' });
    expect(invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('rejects ideas owned by another user', async () => {
    const id = seedIdea(99, 'Other user idea', 'ideas');

    const response = await dispatch('POST', `/pipeline/${id}/advance`, {}, 41);

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });
});
