import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import Database from 'better-sqlite3';
import type { Request } from 'express';

let testDb: Database.Database;

const mocks = vi.hoisted(() => ({
  generateAndStoreTopicCandidates: vi.fn(),
  generateWeeklyPackage: vi.fn(),
  updateFeedback: vi.fn(),
  logPerformanceFeedback: vi.fn(),
  getPerformanceSummary: vi.fn(),
  getLearnedPatterns: vi.fn(),
  getArtifactChain: vi.fn(),
  getRecentScripts: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/content-workflow', () => ({
  generateAndStoreTopicCandidates: mocks.generateAndStoreTopicCandidates,
  generateWeeklyPackage: mocks.generateWeeklyPackage,
  updateFeedback: mocks.updateFeedback,
}));

vi.mock('../../src/services/content-learning-store', () => ({
  logPerformanceFeedback: mocks.logPerformanceFeedback,
  getPerformanceSummary: mocks.getPerformanceSummary,
  getLearnedPatterns: mocks.getLearnedPatterns,
  getArtifactChain: mocks.getArtifactChain,
  getRecentScripts: mocks.getRecentScripts,
}));

import { registerContentLearningRoutes } from '../../src/api/routes/content-learning-routes';

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
  method: string,
  path: string,
  userId = 41,
  body: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return {
    userId,
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId = 41,
  query: Record<string, unknown> = {},
): Promise<MockRes> {
  const router = Router();
  registerContentLearningRoutes(router, () => 'pt-BR');
  const req = mockReq(method, path, userId, body, query);
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

function seedTopicFeedback(userId: number, topic: string, sentiment = 'pending'): number {
  const result = testDb.prepare(`
    INSERT INTO content_topic_feedback
      (topic, niche, format, sentiment, source_job, hook_idea, why_now, angle_tag, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    topic,
    'ai-tech',
    'reel',
    sentiment,
    'manual',
    'Open with tension',
    'Strong signal today',
    'timely',
    userId,
    '2026-04-23T10:00:00.000Z',
  );
  return Number(result.lastInsertRowid);
}

function seedPipeline(userId: number): number {
  const result = testDb.prepare(`
    INSERT INTO content_pipeline (topic_title, stage, user_id)
    VALUES (?, ?, ?)
  `).run('Pipeline topic', 'scripted', userId);
  return Number(result.lastInsertRowid);
}

describe('content learning routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE content_topic_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        niche TEXT,
        format TEXT,
        sentiment TEXT,
        source_job TEXT,
        hook_idea TEXT,
        why_now TEXT,
        angle_tag TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT
      );
      CREATE TABLE content_pipeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_title TEXT NOT NULL,
        stage TEXT,
        user_id INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('localizes topic generation validation without loading the workflow engine', async () => {
    const response = await dispatch('POST', '/topics/generate', { format: 'podcast' });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toBe('o formato deve ser "reel" ou "youtube"');
    expect(mocks.generateAndStoreTopicCandidates).not.toHaveBeenCalled();
  });

  it('generates topic candidates through the content workflow service', async () => {
    mocks.generateAndStoreTopicCandidates.mockResolvedValueOnce({
      format: 'youtube',
      sourceJob: 'manual',
      dayLabel: 'Sexta-feira',
      candidates: [
        {
          feedbackId: 12,
          title: 'Build in public without chaos',
          niche: 'ai-tech',
          whyNow: 'Strong founder signal',
          hookIdea: 'Start with the hidden cost',
          angleTag: 'operator',
        },
      ],
    });

    const response = await dispatch('POST', '/topics/generate', {
      format: 'youtube',
      sourceJob: 'manual',
    }, 77);

    expect(response.statusCode).toBe(200);
    expect(mocks.generateAndStoreTopicCandidates).toHaveBeenCalledWith(77, 'youtube', 'manual');
    expect(response.body.data).toEqual(expect.objectContaining({
      format: 'youtube',
      sourceJob: 'manual',
      count: 1,
      candidates: [
        expect.objectContaining({
          feedbackId: 12,
          title: 'Build in public without chaos',
        }),
      ],
    }));
  });

  it('forbids feedback updates for another user topic', async () => {
    const id = seedTopicFeedback(99, 'Other user topic');

    const response = await dispatch('POST', `/topics/${id}/feedback`, { sentiment: 'approved' }, 41);

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(mocks.updateFeedback).not.toHaveBeenCalled();
  });

  it('updates owned topic feedback', async () => {
    const id = seedTopicFeedback(41, 'Owned topic');

    const response = await dispatch('POST', `/topics/${id}/feedback`, { sentiment: 'approved' }, 41);

    expect(response.statusCode).toBe(200);
    expect(mocks.updateFeedback).toHaveBeenCalledWith(id, 'approved');
    expect(response.body.data).toEqual({
      feedbackId: id,
      sentiment: 'approved',
      title: 'Owned topic',
    });
  });

  it('returns pending topics scoped to the authenticated user', async () => {
    seedTopicFeedback(41, 'My pending topic');
    seedTopicFeedback(99, 'Other pending topic');

    const response = await dispatch('GET', '/topics/pending', {}, 41);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.count).toBe(1);
    expect(response.body.data.topics).toEqual([
      expect.objectContaining({
        title: 'My pending topic',
        format: 'reel',
      }),
    ]);
  });

  it('requires views and retention when logging performance feedback', async () => {
    const response = await dispatch('POST', '/performance', { views: 1200 });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(mocks.logPerformanceFeedback).not.toHaveBeenCalled();
  });

  it('logs performance feedback with authenticated user ownership', async () => {
    mocks.logPerformanceFeedback.mockReturnValueOnce(55);

    const response = await dispatch('POST', '/performance', {
      pipelineId: 8,
      views: 1200,
      retentionPct: 43.5,
      likes: 100,
    }, 77);

    expect(response.statusCode).toBe(200);
    expect(mocks.logPerformanceFeedback).toHaveBeenCalledWith(expect.objectContaining({
      pipelineId: 8,
      views: 1200,
      retentionPct: 43.5,
      likes: 100,
      userId: 77,
    }));
    expect(response.body.data).toEqual({ feedbackId: 55 });
  });

  it('forbids artifact-chain access for another user pipeline', async () => {
    const pipelineId = seedPipeline(99);

    const response = await dispatch('GET', `/artifact-chain/${pipelineId}`, {}, 41);

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(mocks.getArtifactChain).not.toHaveBeenCalled();
  });

  it('returns artifact-chain for an owned pipeline', async () => {
    const pipelineId = seedPipeline(41);
    mocks.getArtifactChain.mockReturnValueOnce({
      idea: null,
      topicFeedback: null,
      pipeline: { id: pipelineId },
      script: null,
      performance: [],
      patterns: [],
    });

    const response = await dispatch('GET', `/artifact-chain/${pipelineId}`, {}, 41);

    expect(response.statusCode).toBe(200);
    expect(mocks.getArtifactChain).toHaveBeenCalledWith(pipelineId);
    expect(response.body.data.pipeline).toEqual({ id: pipelineId });
  });

  it('returns recent scripts using bounded query defaults', async () => {
    mocks.getRecentScripts.mockReturnValueOnce([
      {
        id: 9,
        topic: 'Operator systems',
        format: 'reel',
        hook: 'Stop building random tools',
        titleOptions: ['A'],
        estimatedDuration: '00:45',
        niche: 'ai-tech',
        createdAt: '2026-04-23T10:00:00.000Z',
        scriptText: 'x'.repeat(320),
      },
    ]);

    const response = await dispatch('GET', '/scripts/recent', {}, 77);

    expect(response.statusCode).toBe(200);
    expect(mocks.getRecentScripts).toHaveBeenCalledWith(77, 30, 10);
    expect(response.body.data).toEqual({
      count: 1,
      scripts: [
        expect.objectContaining({
          id: 9,
          topic: 'Operator systems',
          preview: 'x'.repeat(300),
        }),
      ],
    });
  });
});
