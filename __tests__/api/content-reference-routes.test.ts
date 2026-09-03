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
  withDatabaseForTestAsync: vi.fn(),
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
        owner_scope TEXT,
        tenant_id INTEGER,
        owner_user_id INTEGER,
        visibility_scope TEXT,
        scope_status TEXT
      );
      CREATE TABLE content_ref_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_url TEXT NOT NULL,
        user_id INTEGER DEFAULT 0,
        tenant_id INTEGER,
        owner_user_id INTEGER,
        visibility_scope TEXT,
        scope_status TEXT
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

  it('deduplicates legacy mixed book inputs in favor of user-owned rows', () => {
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

  it('returns only active user-private books in the exact authenticated tenant and owner scope', async () => {
    const insert = testDb.prepare(`
      INSERT INTO book_library (
        title, author, extraction_status, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES (?, 'Author', 'ready', ?, 'user', ?, ?, ?, ?)
    `);
    insert.run('Private book', 41, 41, 41, 'user_private', 'active');
    insert.run('Tenant-shared book', 41, 41, 41, 'tenant_shared', 'active');
    insert.run('Public book', 41, 41, 41, 'public_published', 'active');
    insert.run('Quarantined book', 41, 41, 41, 'user_private', 'quarantined');
    insert.run('Foreign-owner book', 88, 41, 88, 'user_private', 'active');
    insert.run('Foreign-tenant book', 41, 88, 41, 'user_private', 'active');

    const { response } = await dispatch('GET', '/books', {}, 41);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.books.map((book: { title: string }) => book.title)).toEqual(['Private book']);
  });

  it.each([
    ['tenant-shared', 41, 41, 'tenant_shared', 'active'],
    ['public', 41, 41, 'public_published', 'active'],
    ['foreign-owner', 41, 88, 'user_private', 'active'],
    ['foreign-tenant', 88, 41, 'user_private', 'active'],
    ['quarantined', 41, 41, 'user_private', 'quarantined'],
  ])('does not delete a %s book row', async (_case, tenantId, ownerUserId, visibilityScope, scopeStatus) => {
    const result = testDb.prepare(`
      INSERT INTO book_library (
        title, author, extraction_status, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES ('Protected book', 'Author', 'ready', 41, 'user', ?, ?, ?, ?)
    `).run(tenantId, ownerUserId, visibilityScope, scopeStatus);

    const { response } = await dispatch('DELETE', `/books/${result.lastInsertRowid}`, {}, 41);

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM book_library WHERE id = ?')
      .get(result.lastInsertRowid)).toEqual({ count: 1 });
    expect(mockInvalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('deletes only the authenticated user\'s active private book row', async () => {
    const result = testDb.prepare(`
      INSERT INTO book_library (
        title, author, extraction_status, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES ('Private book', 'Author', 'ready', 41, 'user', 41, 41, 'user_private', 'active')
    `).run();

    const { response } = await dispatch('DELETE', `/books/${result.lastInsertRowid}`, {}, 41);

    expect(response.statusCode).toBe(200);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM book_library WHERE id = ?')
      .get(result.lastInsertRowid)).toEqual({ count: 0 });
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledWith(41);
  });

  it('rejects partial and unsafe private reference identifiers before mutation', async () => {
    const partialBook = await dispatch('DELETE', '/books/1suffix', {}, 41);
    const unsafeChannel = await dispatch(
      'DELETE',
      `/channels/${Number.MAX_SAFE_INTEGER + 1}`,
      {},
      41,
    );

    expect(partialBook.response.statusCode).toBe(400);
    expect(unsafeChannel.response.statusCode).toBe(400);
    expect(mockInvalidateContentDerivedCaches).not.toHaveBeenCalled();
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

  it.each([
    ['title', { title: 42, author: 'Author' }],
    ['author', { title: 'Title', author: { name: 'Author' } }],
    ['title', { title: 'x'.repeat(241), author: 'Author' }],
    ['author', { title: 'Title', author: 'x'.repeat(241) }],
    ['title', { title: 'Title\nInjected', author: 'Author' }],
    ['author', { title: 'Title', author: 'Author\u0000Injected' }],
  ])('rejects invalid book %s before persistence', async (_field, body) => {
    const { response } = await dispatch('POST', '/books', body);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM book_library').get()).toEqual({ count: 0 });
    expect(mockInvalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('accepts book title and author values at the 240-character boundary', async () => {
    const title = 't'.repeat(240);
    const author = 'a'.repeat(240);
    const { response } = await dispatch('POST', '/books', { title, author });

    expect(response.statusCode).toBe(201);
    expect(testDb.prepare('SELECT title, author FROM book_library').get()).toEqual({ title, author });
  });

  it.each([
    ['wrong type', { url: { href: 'https://youtube.com/@nexus' } }],
    ['oversize', { url: `https://youtube.com/@${'x'.repeat(2_049)}` }],
    ['control character', { url: 'https://youtube.com/@nexus\nsecond-line' }],
  ])('rejects %s channel URLs before state or cache mutation', async (_case, body) => {
    const { response } = await dispatch('POST', '/channels', body);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(addChannel).not.toHaveBeenCalled();
    expect(mockInvalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('accepts a channel URL at the 2,048-character boundary', async () => {
    const url = `https://youtube.com/@${'x'.repeat(2_027)}`;
    expect(url).toHaveLength(2_048);

    const { response } = await dispatch('POST', '/channels', { url }, 77);

    expect(response.statusCode).toBe(201);
    expect(addChannel).toHaveBeenCalledWith(url, 'ios', 77, 77);
  });

  it('lists channels through the content-reference state owner with user scope', async () => {
    const { response } = await dispatch('GET', '/channels', {}, 77);

    expect(getAllChannels).toHaveBeenCalledWith(77, 77);
    expect(response.body.data.channels).toEqual([
      { id: 4, channel_url: 'https://youtube.com/@nexus', channel_name: 'Nexus' },
    ]);
  });

  it.each([
    ['tenant-shared', 41, 41, 'tenant_shared', 'active'],
    ['public', 41, 41, 'public_published', 'active'],
    ['foreign-owner', 41, 88, 'user_private', 'active'],
    ['foreign-tenant', 88, 41, 'user_private', 'active'],
    ['quarantined', 41, 41, 'user_private', 'quarantined'],
  ])('does not delete a %s channel row', async (_case, tenantId, ownerUserId, visibilityScope, scopeStatus) => {
    const result = testDb.prepare(`
      INSERT INTO content_ref_channels (
        channel_url, user_id, tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES ('https://youtube.com/@protected', 41, ?, ?, ?, ?)
    `).run(tenantId, ownerUserId, visibilityScope, scopeStatus);

    const { response } = await dispatch('DELETE', `/channels/${result.lastInsertRowid}`, {}, 41);

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_ref_channels WHERE id = ?')
      .get(result.lastInsertRowid)).toEqual({ count: 1 });
    expect(mockInvalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('deletes only the authenticated user\'s active private channel row', async () => {
    const result = testDb.prepare(`
      INSERT INTO content_ref_channels (
        channel_url, user_id, tenant_id, owner_user_id, visibility_scope, scope_status
      ) VALUES ('https://youtube.com/@private', 41, 41, 41, 'user_private', 'active')
    `).run();

    const { response } = await dispatch('DELETE', `/channels/${result.lastInsertRowid}`, {}, 41);

    expect(response.statusCode).toBe(200);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_ref_channels WHERE id = ?')
      .get(result.lastInsertRowid)).toEqual({ count: 0 });
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledWith(41);
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

  it.each([
    ['wrong category type', { category: ['brand_voice'], payload: 'Direct.' }],
    ['oversize category', { category: 'c'.repeat(161), payload: 'Direct.' }],
    ['wrong payload type', { category: 'brand_voice', payload: Symbol('not-json') }],
    ['oversize string payload', { category: 'brand_voice', payload: 'x'.repeat(20_001) }],
    ['oversize JSON payload', { category: 'brand_voice', payload: { text: 'x'.repeat(20_001) } }],
  ])('rejects %s before Voice DNA persistence', async (_case, body) => {
    const { response } = await dispatch('POST', '/voice-dna', body);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_knowledge').get()).toEqual({ count: 0 });
    expect(mockInvalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('accepts Voice DNA category and string payload values at their boundaries', async () => {
    const category = 'c'.repeat(160);
    const payload = 'p'.repeat(20_000);
    const { response } = await dispatch('POST', '/voice-dna', { category, payload }, 55);

    expect(response.statusCode).toBe(200);
    expect(testDb.prepare(
      'SELECT category, synthesized_text FROM content_knowledge WHERE user_id = ?',
    ).get(55)).toEqual({ category, synthesized_text: payload });
  });

  it('preserves structured JSON Voice DNA payload support', async () => {
    const payload = { tone: 'calm', avoid: ['hype'] };
    const { response } = await dispatch('POST', '/voice-dna', {
      category: 'brand_voice',
      payload,
    }, 55);

    expect(response.statusCode).toBe(200);
    expect(testDb.prepare(
      'SELECT synthesized_text FROM content_knowledge WHERE user_id = ? AND category = ?',
    ).get(55, 'brand_voice')).toEqual({ synthesized_text: JSON.stringify(payload) });
  });

  it('preserves valid primitive JSON Voice DNA payload support', async () => {
    const { response } = await dispatch('POST', '/voice-dna', {
      category: 'voice_version',
      payload: 2,
    }, 55);

    expect(response.statusCode).toBe(200);
    expect(testDb.prepare(
      'SELECT synthesized_text FROM content_knowledge WHERE user_id = ? AND category = ?',
    ).get(55, 'voice_version')).toEqual({ synthesized_text: '2' });
  });

  it('refuses reference routes without a valid authenticated user scope', async () => {
    const { response, ensureValidScope } = await dispatch('GET', '/books', {}, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 0, 'content_route_books_list');
  });
});
