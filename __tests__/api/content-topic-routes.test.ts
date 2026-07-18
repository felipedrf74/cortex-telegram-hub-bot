import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';

let testDb: Database.Database;
let topicStore: Map<number, any>;

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateContentDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  localizeFilmingRecommendation: vi.fn((recommendation: any) => recommendation),
}));

vi.mock('../../src/services/content-radar-preferences', () => ({
  getContentRadarPreferences: vi.fn(() => ({ topics: ['running'], updatedAt: '2026-04-24T10:00:00.000Z' })),
  setContentRadarPreferences: vi.fn((userId: number, topics: string[], tenantId?: number) => ({
    topics,
    userId,
    tenantId,
    updatedAt: '2026-04-24T10:05:00.000Z',
  })),
}));

vi.mock('../../src/services/content-topic-secretary-sync', () => ({
  cleanupContentTopicSecretaryArtifacts: vi.fn(async () => ({ taskDeleted: true, calendarDeleted: true, errors: [] })),
}));

vi.mock('../../src/services/content-topic-workspace-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/content-topic-workspace-compat')>();
  return {
    ...actual,
    assertContentTopicCompatibilityCanArchive: vi.fn(),
    findContentTopicCompatibilityUpdateReplay: vi.fn(() => null),
    hasContentTopicCompatibilityDeleteReplay: vi.fn(() => false),
  };
});

vi.mock('../../src/services/content-workspace-observability', () => ({
  recordContentWorkspaceProductSignal: vi.fn(),
}));

vi.mock('../../src/services/resource-budgets', () => ({
  consumeResourceBudget: vi.fn(() => ({
    allowed: true,
    resetAt: '2026-07-17T12:00:00.000Z',
    budgetKey: 'test',
  })),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  CONTENT_TOPIC_STATUSES: ['planned', 'drafting', 'ready', 'published', 'cancelled'],
  addTopic: vi.fn((userId: number, title: string, opts: any) => {
    const topic = {
      id: 11,
      user_id: userId,
      tenant_id: opts.tenantId,
      owner_user_id: userId,
      visibility_scope: 'user_private',
      scope_status: 'active',
      title,
      notes: opts.notes,
      scheduled_date: opts.scheduledDate,
      scheduled_at: opts.scheduledAt,
      status: opts.status,
      secretary_task_list_id: null,
      secretary_task_list_name: null,
      secretary_task_external_id: null,
      calendar_event_id: null,
      calendar_source: null,
      secretary_sync_status: null,
      secretary_sync_error: null,
      workspace_item_id: 111,
      compatibility_artifact_id: 211,
      compatibility_schema_version: 'content-topic-compatibility-v1',
      compatibility_mode: 'canonical_workspace',
      schedule_semantics: opts.scheduledDate || opts.scheduledAt ? 'workspace_deadline' : 'none',
      created_at: '2026-04-24T10:00:00.000Z',
      updated_at: '2026-04-24T10:00:00.000Z',
    };
    topicStore.set(topic.id, topic);
    return topic;
  }),
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
  getTopicById: vi.fn((userId: number, topicId: number, tenantId: number = userId) => {
    const topic = topicStore.get(topicId);
    return topic?.user_id === userId
      && topic?.tenant_id === tenantId
      && topic?.owner_user_id === userId
      && (topic?.visibility_scope ?? 'user_private') === 'user_private'
      && (topic?.scope_status ?? 'active') === 'active'
      ? topic
      : null;
  }),
  updateTopic: vi.fn((userId: number, topicId: number, updates: any, tenantId: number = userId) => {
    const existing = topicStore.get(topicId) ?? {
      id: topicId,
      user_id: userId,
      tenant_id: userId,
      owner_user_id: userId,
      visibility_scope: 'user_private',
      scope_status: 'active',
      title: 'Race week recap',
      notes: null,
      scheduled_date: '2026-04-25',
      scheduled_at: null,
      status: 'planned',
      secretary_task_list_id: null,
      secretary_task_list_name: null,
      secretary_task_external_id: null,
      calendar_event_id: null,
      calendar_source: null,
      secretary_sync_status: null,
      secretary_sync_error: null,
      created_at: '2026-04-24T10:00:00.000Z',
      updated_at: '2026-04-24T10:00:00.000Z',
    };
    if (
      existing.user_id !== userId
      || existing.tenant_id !== tenantId
      || existing.owner_user_id !== userId
      || (existing.visibility_scope ?? 'user_private') !== 'user_private'
      || (existing.scope_status ?? 'active') !== 'active'
    ) return null;
    const topic = {
      ...existing,
      title: updates.title !== undefined ? updates.title : existing.title,
      notes: updates.notes !== undefined ? updates.notes : existing.notes,
      scheduled_date: updates.scheduled_date !== undefined ? updates.scheduled_date : existing.scheduled_date,
      scheduled_at: updates.scheduled_at !== undefined ? updates.scheduled_at : existing.scheduled_at,
      status: updates.status !== undefined ? updates.status : existing.status,
      secretary_task_list_id: updates.secretary_task_list_id !== undefined ? updates.secretary_task_list_id : existing.secretary_task_list_id,
      secretary_task_list_name: updates.secretary_task_list_name !== undefined ? updates.secretary_task_list_name : existing.secretary_task_list_name,
      secretary_task_external_id: updates.secretary_task_external_id !== undefined ? updates.secretary_task_external_id : existing.secretary_task_external_id,
      calendar_event_id: updates.calendar_event_id !== undefined ? updates.calendar_event_id : existing.calendar_event_id,
      calendar_source: updates.calendar_source !== undefined ? updates.calendar_source : existing.calendar_source,
      secretary_sync_status: updates.secretary_sync_status !== undefined ? updates.secretary_sync_status : existing.secretary_sync_status,
      secretary_sync_error: updates.secretary_sync_error !== undefined ? updates.secretary_sync_error : existing.secretary_sync_error,
      updated_at: '2026-04-24T10:10:00.000Z',
    };
    topicStore.set(topicId, topic);
    return topic;
  }),
  deleteTopic: vi.fn((userId: number, topicId: number, tenantId: number = userId) => {
    const topic = topicStore.get(topicId);
    if (
      topic?.user_id !== userId
      || topic?.tenant_id !== tenantId
      || topic?.owner_user_id !== userId
      || (topic?.visibility_scope ?? 'user_private') !== 'user_private'
      || (topic?.scope_status ?? 'active') !== 'active'
    ) return false;
    return topicStore.delete(topicId);
  }),
  // BE-3 (Content Studio): default = no replay hit; individual tests override.
  findTopicByClientRequestId: vi.fn(() => null),
}));

import { registerContentTopicRoutes } from '../../src/api/routes/content-topic-routes';
import { invalidateContentDerivedCaches } from '../../src/services/cache-coherence-registry';
import { getContentRadarPreferences, setContentRadarPreferences } from '../../src/services/content-radar-preferences';
import { cleanupContentTopicSecretaryArtifacts } from '../../src/services/content-topic-secretary-sync';
import {
  findContentTopicCompatibilityUpdateReplay,
  hasContentTopicCompatibilityDeleteReplay,
} from '../../src/services/content-topic-workspace-compat';
import { recordContentWorkspaceProductSignal } from '../../src/services/content-workspace-observability';
import { consumeResourceBudget } from '../../src/services/resource-budgets';
import {
  addTopic,
  deleteTopic,
  findTopicByClientRequestId,
  getFilmingRecommendation,
  getTopicById,
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
  tenantId: number | undefined = userId,
): Request {
  const parsed = new URL(path, 'http://test.local');
  return {
    userId,
    // 2026-05-18 (skill-hardening QA P1 follow-up): mirror iosAuthMiddleware
    // by setting tenantId alongside userId. Routes no longer have the
    // `tenantId = userId` destructuring default, so missing tenantId in
    // the request now yields `tenantId: undefined` instead of the user-id
    // fallback. Tests should reflect production where the middleware
    // ALWAYS sets both fields.
    tenantId,
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
  tenantId: number | undefined = userId,
  ensureValidScope = makeEnsureValidScope(),
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentTopicRoutes(router, () => 'pt-BR', ensureValidScope);
  const req = mockReq(method, path, body, userId, tenantId);
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
    testDb = new Database(':memory:');
    topicStore = new Map();
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  it('reads and writes radar preferences through explicit user scope', async () => {
    const read = await dispatch('GET', '/radar-preferences', {}, 77);
    expect(read.response.statusCode).toBe(200);
    expect(read.response.body.data.topics).toEqual(['running']);
    expect(getContentRadarPreferences).toHaveBeenCalledWith(77, 77);
    expect(read.ensureValidScope).toHaveBeenCalledWith(expect.anything(), 77, 'content_route_radar_preferences_read');

    const write = await dispatch('PUT', '/radar-preferences', { topics: ['hybrid', 'product'] }, 77);
    expect(write.response.statusCode).toBe(200);
    expect(setContentRadarPreferences).toHaveBeenCalledWith(77, ['hybrid', 'product'], 77);
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
    expect(getUpcomingTopicCount).toHaveBeenCalledWith(77, 14, 77);
    expect(getFilmingRecommendation).toHaveBeenCalledWith(77, expect.any(Array), 77);
    expect(recordContentWorkspaceProductSignal).toHaveBeenCalledWith('legacy_topics_compatibility_read');
    expect(response.body.data.upcomingCount).toBe(1);
    expect(response.body.data.filmingRecommendation.confidence).toBe('high');
  });

  it('uses a tight default topic limit when the client does not request one', async () => {
    const { response } = await dispatch('GET', '/topics', {}, 77);

    expect(response.statusCode).toBe(200);
    expect(getTopics).toHaveBeenCalledWith(77, expect.objectContaining({
      limit: 20,
    }));
  });

  it('creates topics, trims title, and invalidates dashboard coordination caches', async () => {
    const { response } = await dispatch('POST', '/topics', {
      title: '  Race recap  ',
      notes: 'Use training angle',
      scheduledDate: '2026-04-25',
      scheduledDateTime: '2026-04-25T09:30:00',
      status: 'drafting',
    }, 77);

    expect(response.statusCode).toBe(201);
    expect(addTopic).toHaveBeenCalledWith(77, 'Race recap', {
      notes: 'Use training angle',
      scheduledDate: '2026-04-25',
      scheduledAt: '2026-04-25T09:30:00',
      status: 'drafting',
      tenantId: 77,
    });
    expect(updateTopic).not.toHaveBeenCalled();
    expect(response.body.data.topic.schedule_semantics).toBe('workspace_deadline');
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(77);
  });

  it('captures a date-only canonical deadline without claiming a Secretary task exists', async () => {
    const { response } = await dispatch('POST', '/topics', {
      title: '  Topic test  ',
      scheduledDate: '2026-04-26',
    }, 77);

    expect(response.statusCode).toBe(201);
    expect(addTopic).toHaveBeenCalledWith(77, 'Topic test', {
      notes: null,
      scheduledDate: '2026-04-26',
      scheduledAt: null,
      status: 'planned',
      tenantId: 77,
    });
    expect(updateTopic).not.toHaveBeenCalled();
    expect(response.body.data.topic.secretary_task_external_id).toBeNull();
    expect(response.body.data.topic.calendar_event_id).toBeNull();
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

  it('rejects invalid scheduledDateTime values before creating topics', async () => {
    const { response } = await dispatch('POST', '/topics', {
      title: 'Race recap',
      scheduledDateTime: 'tomorrow at nine',
    }, 77);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(addTopic).not.toHaveBeenCalled();
  });

  // BE-2/BE-3 (Content Studio): creation provenance + idempotent replay.

  it('rejects unknown source values before creating topics', async () => {
    const { response } = await dispatch('POST', '/topics', {
      title: 'Race recap',
      source: 'telepathy',
    }, 77);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(addTopic).not.toHaveBeenCalled();
  });

  it('records capture provenance and the idempotency key on create', async () => {
    const { response } = await dispatch('POST', '/topics', {
      title: 'Open water fear',
      source: 'capture',
      idempotencyKey: 'cap-123',
    }, 77);

    expect(response.statusCode).toBe(201);
    expect(addTopic).toHaveBeenCalledWith(77, 'Open water fear', {
      notes: null,
      scheduledDate: null,
      scheduledAt: null,
      status: 'planned',
      tenantId: 77,
      provenance: { source: 'capture', clientRequestId: 'cap-123' },
    });
    expect(recordContentWorkspaceProductSignal).toHaveBeenCalledWith('legacy_topics_compatibility_mutation');
  });

  it('replays an already-applied create without re-creating or double-charging', async () => {
    const existing = {
      id: 99,
      user_id: 77,
      tenant_id: 77,
      owner_user_id: 77,
      title: 'Open water fear',
      notes: null,
      scheduled_date: null,
      scheduled_at: null,
      status: 'planned',
      secretary_sync_status: null,
      secretary_sync_error: null,
      created_at: '2026-06-10T10:00:00.000Z',
      updated_at: '2026-06-10T10:00:00.000Z',
    };
    vi.mocked(findTopicByClientRequestId).mockReturnValueOnce(existing as any);

    const { response } = await dispatch('POST', '/topics', {
      title: 'Open water fear',
      source: 'capture',
      idempotencyKey: 'cap-123',
    }, 77);

    expect(findTopicByClientRequestId).toHaveBeenCalledWith(77, 'cap-123', 77, {
      title: 'Open water fear',
      notes: null,
      scheduledDate: null,
      scheduledAt: null,
      status: 'planned',
      source: 'capture',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.idempotentReplay).toBe(true);
    expect(response.body.data.topic.id).toBe(99);
    expect(addTopic).not.toHaveBeenCalled();
    expect(consumeResourceBudget).not.toHaveBeenCalled();
  });

  it('accepts the idempotency key via the Idempotency-Key header', async () => {
    const router = Router();
    registerContentTopicRoutes(router, () => 'pt-BR', makeEnsureValidScope());
    const req = mockReq('POST', '/topics', { title: 'Header keyed' }, 77);
    (req.headers as any)['idempotency-key'] = 'hdr-456';
    const res = mockRes();
    await new Promise<void>((resolve, reject) => {
      (router as any).handle(req, res, (err: any) => (err ? reject(err) : resolve()));
      setImmediate(resolve);
    });

    expect(res.statusCode).toBe(201);
    expect(addTopic).toHaveBeenCalledWith(77, 'Header keyed', expect.objectContaining({
      provenance: { source: null, clientRequestId: 'hdr-456' },
    }));
  });

  it('updates and deletes only through scoped topic mutations', async () => {
    topicStore.set(11, {
      id: 11,
      user_id: 77,
      tenant_id: 77,
      owner_user_id: 77,
      title: 'Race week recap',
      notes: null,
      scheduled_date: '2026-04-25',
      scheduled_at: null,
      status: 'planned',
      secretary_task_list_id: null,
      secretary_task_list_name: null,
      secretary_task_external_id: null,
      calendar_event_id: null,
      calendar_source: null,
      secretary_sync_status: null,
      secretary_sync_error: null,
      created_at: '2026-04-24T10:00:00.000Z',
      updated_at: '2026-04-24T10:00:00.000Z',
    });
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
      scheduled_at: undefined,
      status: undefined,
    }, 77, expect.stringMatching(/^server-/), { retireLegacySchedule: false });
    expect(remove.response.statusCode).toBe(200);
    expect(getTopicById).toHaveBeenCalledWith(77, 11, 77);
    expect(deleteTopic).toHaveBeenCalledWith(77, 11, 77, expect.stringMatching(/^server-/), { retireLegacySchedule: false });
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(77);
    expect(recordContentWorkspaceProductSignal).toHaveBeenCalledTimes(2);
    expect(recordContentWorkspaceProductSignal).toHaveBeenNthCalledWith(1, 'legacy_topics_compatibility_mutation');
    expect(recordContentWorkspaceProductSignal).toHaveBeenNthCalledWith(2, 'legacy_topics_compatibility_mutation');
  });

  it('cleans up imported Secretary artifacts before soft-deleting the canonical item', async () => {
    topicStore.set(11, {
      id: 11,
      user_id: 77,
      tenant_id: 77,
      owner_user_id: 77,
      title: 'Race week recap',
      notes: null,
      scheduled_date: '2026-04-25',
      scheduled_at: '2026-04-25T09:30:00',
      status: 'planned',
      secretary_task_list_id: 'list-1',
      secretary_task_list_name: 'Content',
      secretary_task_external_id: 'task-1',
      calendar_event_id: 'evt-1',
      calendar_source: 'google',
      secretary_sync_status: 'task_calendar_synced',
      secretary_sync_error: null,
      created_at: '2026-04-24T10:00:00.000Z',
      updated_at: '2026-04-24T10:00:00.000Z',
    });

    const remove = await dispatch('DELETE', '/topics/11', {}, 77);

    expect(remove.response.statusCode).toBe(200);
    expect(cleanupContentTopicSecretaryArtifacts).toHaveBeenCalledWith(77, expect.objectContaining({
      id: 11,
      secretary_task_external_id: 'task-1',
      calendar_event_id: 'evt-1',
    }), { tenantId: 77 });
    expect(deleteTopic).toHaveBeenCalledWith(77, 11, 77, expect.stringMatching(/^server-/), { retireLegacySchedule: true });
  });

  it('passes the authenticated tenant to Secretary cleanup before a scoped schedule update', async () => {
    topicStore.set(11, {
      id: 11,
      user_id: 77,
      tenant_id: 88,
      owner_user_id: 77,
      visibility_scope: 'user_private',
      scope_status: 'active',
      title: 'Tenant 88 filming block',
      notes: null,
      scheduled_date: '2026-04-25',
      scheduled_at: '2026-04-25T09:30:00',
      status: 'planned',
      secretary_task_list_id: 'list-88',
      secretary_task_list_name: 'Content',
      secretary_task_external_id: 'task-88',
      calendar_event_id: 'evt-88',
      calendar_source: 'google',
      secretary_sync_status: 'task_calendar_synced',
      secretary_sync_error: null,
      created_at: '2026-04-24T10:00:00.000Z',
      updated_at: '2026-04-24T10:00:00.000Z',
    });

    const update = await dispatch('PATCH', '/topics/11', {
      scheduledDate: null,
      scheduledDateTime: null,
    }, 77, 88);

    expect(update.response.statusCode).toBe(200);
    expect(cleanupContentTopicSecretaryArtifacts).toHaveBeenCalledWith(77, expect.objectContaining({
      id: 11,
      tenant_id: 88,
      secretary_task_external_id: 'task-88',
    }), { tenantId: 88 });
    expect(updateTopic).toHaveBeenCalledWith(
      77,
      11,
      expect.objectContaining({ scheduled_date: null, scheduled_at: null }),
      88,
      expect.stringMatching(/^server-/),
      { retireLegacySchedule: true },
    );
  });

  it('replays keyed updates before budget consumption or external cleanup', async () => {
    const replay = {
      id: 11,
      user_id: 77,
      tenant_id: 77,
      owner_user_id: 77,
      title: 'Already updated',
      notes: null,
      scheduled_date: null,
      scheduled_at: null,
      status: 'drafting',
      workspace_item_id: 111,
      compatibility_artifact_id: 211,
      created_at: '2026-04-24T10:00:00.000Z',
      updated_at: '2026-04-24T10:10:00.000Z',
    };
    topicStore.set(11, { ...replay, visibility_scope: 'user_private', scope_status: 'active' });
    vi.mocked(findContentTopicCompatibilityUpdateReplay).mockReturnValueOnce(replay as any);

    const { response } = await dispatch('PATCH', '/topics/11', {
      title: 'Already updated',
      idempotencyKey: 'update-replay-001',
    }, 77);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.idempotentReplay).toBe(true);
    expect(findContentTopicCompatibilityUpdateReplay).toHaveBeenCalledWith(expect.objectContaining({
      compatTopicId: 11,
      title: 'Already updated',
      idempotencyKey: 'update-replay-001',
    }));
    expect(consumeResourceBudget).not.toHaveBeenCalled();
    expect(cleanupContentTopicSecretaryArtifacts).not.toHaveBeenCalled();
    expect(updateTopic).not.toHaveBeenCalled();
  });

  it('replays keyed deletes before budget consumption or a second provider cleanup', async () => {
    vi.mocked(hasContentTopicCompatibilityDeleteReplay).mockReturnValueOnce(true);

    const { response } = await dispatch('DELETE', '/topics/11', {
      idempotencyKey: 'delete-replay-001',
    }, 77);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({ deleted: true, id: 11, idempotentReplay: true });
    expect(hasContentTopicCompatibilityDeleteReplay).toHaveBeenCalledWith(
      { tenantId: 77, userId: 77 },
      11,
      { idempotencyKey: 'delete-replay-001' },
    );
    expect(consumeResourceBudget).not.toHaveBeenCalled();
    expect(cleanupContentTopicSecretaryArtifacts).not.toHaveBeenCalled();
    expect(deleteTopic).not.toHaveBeenCalled();
  });

  it('does not mutate a same-user topic from a different tenant scope', async () => {
    topicStore.set(11, {
      id: 11,
      user_id: 77,
      tenant_id: 88,
      owner_user_id: 77,
      visibility_scope: 'user_private',
      scope_status: 'active',
      title: 'Private tenant 88 topic',
      notes: 'Must not cross the tenant boundary',
      scheduled_date: null,
      scheduled_at: null,
      status: 'planned',
      created_at: '2026-04-24T10:00:00.000Z',
      updated_at: '2026-04-24T10:00:00.000Z',
    });

    const update = await dispatch('PATCH', '/topics/11', { title: 'Cross-tenant edit' }, 77, 77);
    const remove = await dispatch('DELETE', '/topics/11', {}, 77, 77);

    expect(update.response.statusCode).toBe(404);
    expect(remove.response.statusCode).toBe(404);
    expect(getTopicById).toHaveBeenCalledWith(77, 11, 77);
    expect(updateTopic).not.toHaveBeenCalled();
    expect(deleteTopic).not.toHaveBeenCalled();
    expect(topicStore.get(11)?.title).toBe('Private tenant 88 topic');
  });

  it('refuses topic routes without a valid authenticated user scope', async () => {
    const { response, ensureValidScope } = await dispatch('POST', '/topics', { title: 'Race recap' }, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(addTopic).not.toHaveBeenCalled();
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 0, 'content_route_topics_create');
    expect(recordContentWorkspaceProductSignal).not.toHaveBeenCalled();
  });
});
