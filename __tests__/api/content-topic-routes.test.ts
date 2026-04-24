import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, type Request, type Response } from 'express';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/services/content-cache-invalidator', () => ({
  invalidateContentDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  localizeFilmingRecommendation: vi.fn((recommendation: any) => recommendation),
}));

vi.mock('../../src/services/content-radar-preferences', () => ({
  getContentRadarPreferences: vi.fn(() => ({ topics: ['running'], updatedAt: '2026-04-24T10:00:00.000Z' })),
  setContentRadarPreferences: vi.fn((userId: number, topics: string[]) => ({
    topics,
    userId,
    updatedAt: '2026-04-24T10:05:00.000Z',
  })),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  CONTENT_TOPIC_STATUSES: ['planned', 'drafting', 'ready', 'published', 'cancelled'],
  addTopic: vi.fn((userId: number, title: string, opts: any) => ({
    id: 11,
    user_id: userId,
    title,
    notes: opts.notes,
    scheduled_date: opts.scheduledDate,
    status: opts.status,
    created_at: '2026-04-24T10:00:00.000Z',
    updated_at: '2026-04-24T10:00:00.000Z',
  })),
  getTopics: vi.fn(() => [
    { id: 7, title: 'Race week recap', status: 'ready', scheduled_date: '2026-04-25' },
  ]),
  getUpcomingTopicCount: vi.fn(() => 1),
  getFilmingRecommendation: vi.fn(async () => ({
    date: '2026-04-25',
    confidence: 'high',
    reason: 'Clear window.',
    reasons: ['Clear calendar.'],
    readinessScore: 82,
    trainingLoad: 'light',
    calendarLoad: 'light',
  })),
  updateTopic: vi.fn((userId: number, topicId: number, updates: any) => ({
    id: topicId,
    user_id: userId,
    title: updates.title ?? 'Race week recap',
    notes: updates.notes ?? null,
    scheduled_date: updates.scheduled_date ?? null,
    status: updates.status ?? 'planned',
    created_at: '2026-04-24T10:00:00.000Z',
    updated_at: '2026-04-24T10:10:00.000Z',
  })),
  deleteTopic: vi.fn(() => true),
}));

import { registerContentTopicRoutes } from '../../src/api/routes/content-topic-routes';
import { invalidateContentDerivedCaches } from '../../src/services/content-cache-invalidator';
import { getContentRadarPreferences, setContentRadarPreferences } from '../../src/services/content-radar-preferences';
import {
  addTopic,
  deleteTopic,
  getFilmingRecommendation,
  getTopics,
  getUpcomingTopicCount,
  updateTopic,
} from '../../src/services/content-scheduler';

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
  body: Record<string, unknown> = {},
  userId: number | undefined = 41,
): Request {
  const parsed = new URL(path, 'http://test.local');
  return {
    userId,
    method,
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    params: {},
    body,
    headers: { 'x-language': 'pt-BR' },
    header(name: string) {
      return (this.headers as any)[name.toLowerCase()] ?? (this.headers as any)[name];
    },
  } as any;
}

function makeEnsureValidScope() {
  return vi.fn((
    res: Response,
    userId: number | undefined,
  ): userId is number => {
    if (typeof userId === 'number' && userId > 0) return true;
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid authenticated user scope' } });
    return false;
  });
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 41,
  ensureValidScope = makeEnsureValidScope(),
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentTopicRoutes(router, () => 'pt-BR', ensureValidScope);
  const req = mockReq(method, path, body, userId);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });

  return { response: res, ensureValidScope };
}

describe('content topic routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads and writes radar preferences through explicit user scope', async () => {
    const read = await dispatch('GET', '/radar-preferences', {}, 77);
    expect(read.response.statusCode).toBe(200);
    expect(read.response.body.data.topics).toEqual(['running']);
    expect(getContentRadarPreferences).toHaveBeenCalledWith(77);
    expect(read.ensureValidScope).toHaveBeenCalledWith(expect.anything(), 77, 'content_route_radar_preferences_read');

    const write = await dispatch('PUT', '/radar-preferences', { topics: ['hybrid', 'product'] }, 77);
    expect(write.response.statusCode).toBe(200);
    expect(setContentRadarPreferences).toHaveBeenCalledWith(77, ['hybrid', 'product']);
    expect(write.ensureValidScope).toHaveBeenCalledWith(expect.anything(), 77, 'content_route_radar_preferences_write');
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(77);
  });

  it('rejects malformed radar preference payloads before mutating state', async () => {
    const { response } = await dispatch('PUT', '/radar-preferences', { topics: ['valid', 7] }, 77);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(setContentRadarPreferences).not.toHaveBeenCalled();
  });

  it('lists topics with upcoming count and filming recommendation in one response', async () => {
    const { response } = await dispatch('GET', '/topics?status=ready&scheduledOnly=true&limit=7', {}, 77);

    expect(response.statusCode).toBe(200);
    expect(getTopics).toHaveBeenCalledWith(77, expect.objectContaining({
      status: 'ready',
      scheduledOnly: true,
      limit: 7,
    }));
    expect(getUpcomingTopicCount).toHaveBeenCalledWith(77, 14);
    expect(getFilmingRecommendation).toHaveBeenCalledWith(77, expect.any(Array));
    expect(response.body.data.upcomingCount).toBe(1);
    expect(response.body.data.filmingRecommendation.confidence).toBe('high');
  });

  it('creates topics, trims title, and invalidates dashboard coordination caches', async () => {
    const { response } = await dispatch('POST', '/topics', {
      title: '  Race recap  ',
      notes: 'Use training angle',
      scheduledDate: '2026-04-25',
      status: 'drafting',
    }, 77);

    expect(response.statusCode).toBe(201);
    expect(addTopic).toHaveBeenCalledWith(77, 'Race recap', {
      notes: 'Use training angle',
      scheduledDate: '2026-04-25',
      status: 'drafting',
    });
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(77);
  });

  it('rejects invalid scheduledDate values before creating or updating topics', async () => {
    const create = await dispatch('POST', '/topics', {
      title: 'Race recap',
      scheduledDate: '25/04/2026',
    }, 77);
    const update = await dispatch('PATCH', '/topics/11', {
      scheduledDate: '25/04/2026',
    }, 77);

    expect(create.response.statusCode).toBe(400);
    expect(update.response.statusCode).toBe(400);
    expect(addTopic).not.toHaveBeenCalled();
    expect(updateTopic).not.toHaveBeenCalled();
  });

  it('updates and deletes only through scoped topic mutations', async () => {
    const update = await dispatch('PATCH', '/topics/11', {
      title: '  Updated angle  ',
      scheduledDate: null,
    }, 77);
    const remove = await dispatch('DELETE', '/topics/11', {}, 77);

    expect(update.response.statusCode).toBe(200);
    expect(updateTopic).toHaveBeenCalledWith(77, 11, {
      title: 'Updated angle',
      notes: undefined,
      scheduled_date: null,
      status: undefined,
    });
    expect(remove.response.statusCode).toBe(200);
    expect(deleteTopic).toHaveBeenCalledWith(77, 11);
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(77);
  });

  it('refuses topic routes without a valid authenticated user scope', async () => {
    const { response, ensureValidScope } = await dispatch('POST', '/topics', { title: 'Race recap' }, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(addTopic).not.toHaveBeenCalled();
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 0, 'content_route_topics_create');
  });
});
