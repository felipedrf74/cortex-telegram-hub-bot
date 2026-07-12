import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';

let testDb: Database.Database;
const mockInvalidateContentDerivedCaches = vi.hoisted(() => vi.fn());

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
  invalidateContentDerivedCaches: (...args: unknown[]) =>
    mockInvalidateContentDerivedCaches(...args),
}));

vi.mock('../../src/services/content-dashboard-service', () => ({
  getVoiceDna: vi.fn(() => [
    {
      id: 7,
      category: 'brand_voice',
      label: 'Voice',
      text: 'Direct, premium, useful.',
      sources: ['manual'],
      version: 2,
      updatedAt: '2026-04-22T10:00:00.000Z',
    },
  ]),
}));

vi.mock('../../src/state/content-references', () => ({
  getAllChannels: vi.fn(() => [
    { id: 4, channel_url: 'https://youtube.com/@nexus', channel_name: 'Nexus' },
  ]),
  addChannel: vi.fn((url: string, addedVia: string, userId: number) => ({
    id: 9,
    channel_url: url,
    channel_name: `${addedVia}:${userId}`,
  })),
}));

import {
  dedupeContentBooks,
  registerContentReferenceRoutes,
} from '../../src/api/routes/content-reference-routes';
import { addChannel, getAllChannels } from '../../src/state/content-references';

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
  userId: number | undefined = 41,
  body: Record<string, unknown> = {},
): Request {
  return {
    userId,
    // 2026-05-18 (skill-hardening QA P1 follow-up): mirror iosAuthMiddleware
    // setting tenantId alongside userId. Routes no longer have the
    // `tenantId = userId` destructuring default.
    tenantId: userId,
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
  registerContentReferenceRoutes(router, ensureValidScope);
  const req = mockReq(method, path, userId, body);
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

describe('content reference routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE book_library (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        core_thesis TEXT,
        extraction_status TEXT,
        personal_notes TEXT,
        user_id INTEGER DEFAULT 0,
        owner_scope TEXT
      );
      CREATE TABLE content_ref_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_url TEXT NOT NULL,
        user_id INTEGER DEFAULT 0
      );
      CREATE TABLE content_knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        synthesized_text TEXT NOT NULL,
        source_channels TEXT,
        user_id INTEGER NOT NULL,
        owner_scope TEXT,
        version INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, category)
      );
    `);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('prefers user-owned duplicate books over system seed books', () => {
    const rows = dedupeContentBooks([
      { id: 1, title: 'Storyworthy', author: 'Matthew Dicks', user_id: 0, owner_scope: 'system' },
      { id: 2, title: 'Storyworthy', author: 'Matthew Dicks', user_id: 41, owner_scope: 'user' },
      { id: 3, title: 'Atomic Habits', author: 'James Clear', user_id: 0, owner_scope: 'system' },
    ], 41);

    expect(rows.map((row) => row.id)).toEqual([2, 3]);
  });

  it('returns scoped book references without leaking owner fields', async () => {
    testDb.prepare(`
      INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope)
      VALUES (?, ?, ?, ?, ?)
    `).run('Storyworthy', 'Matthew Dicks', 'extracted', 0, 'system');
    testDb.prepare(`
      INSERT INTO book_library (title, author, extraction_status, personal_notes, user_id, owner_scope)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Storyworthy', 'Matthew Dicks', 'pending', 'Use for hooks', 41, 'user');

    const { response } = await dispatch('GET', '/books');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.books).toEqual([
      expect.objectContaining({
        id: 2,
        title: 'Storyworthy',
        author: 'Matthew Dicks',
        extraction_status: 'pending',
        personal_notes: 'Use for hooks',
      }),
    ]);
    expect(response.body.data.books[0]).not.toHaveProperty('user_id');
    expect(response.body.data.books[0]).not.toHaveProperty('owner_scope');
  });

  it('does not expose platform seed books as user references', async () => {
    testDb.prepare(`
      INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope)
      VALUES (?, ?, ?, ?, ?)
    `).run('Economics in One Lesson', 'Henry Hazlitt', 'extracted', 0, 'system');

    const { response } = await dispatch('GET', '/books', {}, 88);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.books).toEqual([]);
  });

  it('keeps user-owned political or economics books scoped to that user only', async () => {
    testDb.prepare(`
      INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope)
      VALUES (?, ?, ?, ?, ?)
    `).run('Economics in One Lesson', 'Henry Hazlitt', 'extracted', 41, 'user');

    const ownerResponse = await dispatch('GET', '/books', {}, 41);
    const otherResponse = await dispatch('GET', '/books', {}, 88);

    expect(ownerResponse.response.body.data.books).toEqual([
      expect.objectContaining({ title: 'Economics in One Lesson' }),
    ]);
    expect(otherResponse.response.body.data.books).toEqual([]);
  });

  it('adds channels through the content-reference state owner with user scope', async () => {
    const { response } = await dispatch('POST', '/channels', { url: '  https://youtube.com/@nexus  ' }, 77);

    expect(addChannel).toHaveBeenCalledWith('https://youtube.com/@nexus', 'ios', 77, 77);
    expect(response.statusCode).toBe(201);
    expect(response.body.data.channel).toEqual({
      id: 9,
      url: 'https://youtube.com/@nexus',
      name: 'ios:77',
    });
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledWith(77);
  });

  it('lists channels through the content-reference state owner with user scope', async () => {
    const { response } = await dispatch('GET', '/channels', {}, 77);

    expect(getAllChannels).toHaveBeenCalledWith(77, 77);
    expect(response.body.data.channels).toEqual([
      { id: 4, channel_url: 'https://youtube.com/@nexus', channel_name: 'Nexus' },
    ]);
  });

  it('upserts voice DNA entries for the authenticated user', async () => {
    const { response } = await dispatch('POST', '/voice-dna', {
      category: 'brand_voice',
      payload: '  Use calm authority.  ',
    }, 55);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({ upserted: true });

    const row = testDb.prepare('SELECT * FROM content_knowledge WHERE user_id = ? AND category = ?')
      .get(55, 'brand_voice') as any;
    expect(row.synthesized_text).toBe('Use calm authority.');
    expect(row.owner_scope).toBe('user');
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledWith(55);
  });

  it('refuses reference routes without a valid authenticated user scope', async () => {
    const { response, ensureValidScope } = await dispatch('GET', '/books', {}, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 0, 'content_route_books_list');
  });
});
