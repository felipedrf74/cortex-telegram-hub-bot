/**
 * Skills Catalog API — Phase 1 Slice D tests
 *
 * Tests the route handlers by mocking Express req/res directly and
 * calling the router's `handle` function. This pattern is faster than
 * supertest (no HTTP round-trip) and doesn't require spinning up the
 * whole API server for a single endpoint.
 *
 * Coverage:
 *  - GET /catalog returns all 5 parent skills with correct tier badges
 *  - GET /catalog marks sport sub-skills (gym/running/cycle/swim) as
 *    accessible for pro users
 *  - GET /catalog blocks free users from pro parent domains
 *  - GET /catalog puts secretary first for stable iOS rendering
 *  - POST /override requires owner tier (403 for pro)
 *  - POST /override grants access + unblocks a previously blocked skill
 *  - DELETE /override requires owner tier
 *  - Unknown user returns 404
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const cacheMocks = vi.hoisted(() => ({
  invalidateDashboardCoordinationCaches: vi.fn(),
}));

let testDb: Database.Database;

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

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
  },
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
  invalidateDashboardCoordinationCaches: (...args: unknown[]) =>
    cacheMocks.invalidateDashboardCoordinationCaches(...args),
}));


import { skillsRoutes } from '../../src/api/routes/skills';
import { getOrCreateUser, setUserTier } from '../../src/services/user-service';

function grantFounderEntitlement(user: { id: number }, plan: 'pro' | 'max' = 'pro'): void {
  testDb.prepare(`
    INSERT INTO subscriptions (user_id, plan, status, provider, current_period_end)
    VALUES (?, ?, 'active', 'founder', '2099-12-31T23:59:59.000Z')
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      status = excluded.status,
      provider = excluded.provider,
      current_period_end = excluded.current_period_end
  `).run(user.id, plan);
}

function configureCanonicalOwner(telegramId: number): void {
  setUserTier(telegramId, 'owner');
  process.env.OWNER_TELEGRAM_ID = String(telegramId);
}

// ─── Mock req/res helpers ───────────────────────────────────────────

interface MockRes {
  statusCode: number;
  body: any;
  ended: boolean;
  headers: Record<string, number | string | string[]>;
  status(code: number): MockRes;
  setHeader(name: string, value: number | string | string[]): MockRes;
  getHeader(name: string): number | string | string[] | undefined;
  json(body: any): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    ended: false,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    setHeader(name: string, value: number | string | string[]) { r.headers[name.toLowerCase()] = value; return r; },
    getHeader(name: string) { return r.headers[name.toLowerCase()]; },
    json(body: any) { r.body = body; return r; },
    end() { r.ended = true; return r; },
  };
  return r;
}

function mockReq(userId: number, body?: any): Request {
  return { userId, tenantId: userId, body } as any;
}

/**
 * Dispatch a request through the skillsRoutes router stack. Uses the
 * Express router's internal `handle` method to avoid standing up a
 * server. Returns the mocked Response after handlers finish.
 */
async function dispatch(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  userId: number,
  body?: any,
  options: { headers?: Record<string, string | string[]> } = {},
): Promise<MockRes> {
  const router = skillsRoutes();
  const req = mockReq(userId, body);
  (req as any).method = method;
  (req as any).url = url;
  (req as any).originalUrl = url;
  (req as any).baseUrl = '';
  (req as any).path = url.split('?')[0];
  (req as any).query = {};
  (req as any).params = {};
  (req as any).headers = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    (req as any).headers[name.toLowerCase()] = value;
  }

  const res = mockRes();

  await new Promise<void>((resolve) => {
    // Express router handle signature: (req, res, next)
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    // In case the handler responds synchronously before next() is called,
    // give it a microtask tick to finish.
    setImmediate(resolve);
  });

  return res;
}


/**
 * M21: dispatch() callers must be the canonical users.id (verified-JWT
 * semantics — the route-level getUserByTelegramId fallback was removed).
 * Fixtures are still seeded through the legacy telegram_id key, so this
 * resolves the canonical id for a seeded fixture user.
 */
function callerId(fixtureKey: number): number {
  const row = testDb.prepare('SELECT id FROM users WHERE telegram_id = ?').get(fixtureKey) as { id: number } | undefined;
  if (!row) throw new Error(`fixture user ${fixtureKey} not seeded`);
  return row.id;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Skills API — GET /catalog', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => {
    delete process.env.OWNER_TELEGRAM_ID;
    testDb?.close();
  });

  it('returns 404 for unknown user', async () => {
    const res = await dispatch('GET', '/catalog', 99999);
    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('fails closed on invalid tenant scope before loading the skills catalog', async () => {
    const res = await dispatch('GET', '/catalog', 0);
    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'skills_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('returns the full catalog for a pro user with all parents accessible', async () => {
    const user = getOrCreateUser(1001, { username: 'pro' });
    grantFounderEntitlement(user);
    expect(user.tier).toBe('pro'); // Phase 1 default

    const res = await dispatch('GET', '/catalog', callerId(1001));
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const data = res.body.data;
    expect(data.userTier).toBe('pro');
    expect(data.skills).toHaveLength(8); // 5 domain skills + 3 platform skills (connections, notifications, decision_center) promoted 2026-05-15

    // Every parent should be accessible for pro
    for (const skill of data.skills) {
      expect(skill.accessible, `pro should access parent ${skill.name}`).toBe(true);
    }
  });

  it('secretary sorts first in the response (free tier anchor)', async () => {
    getOrCreateUser(1002, { username: 'pro2' });
    const res = await dispatch('GET', '/catalog', callerId(1002));
    expect(res.body.data.skills[0].name).toBe('secretary');
  });

  it('triathlon exposes 4 sport persona sub-skills + 6 capability sub-skills', async () => {
    const user = getOrCreateUser(1003, { username: 'pro3' });
    grantFounderEntitlement(user);
    const res = await dispatch('GET', '/catalog', callerId(1003));
    const triathlon = res.body.data.skills.find((s: any) => s.name === 'triathlon');
    expect(triathlon).toBeDefined();
    expect(triathlon.subSkills).toHaveLength(10);

    // Sub-skill name → expected prompt filename stem. The `cycle`
    // sub-skill's prompt file is `cycling.md` (Phase 2 Slice A: aligns
    // with the sport classifier's `cycling` enum value).
    const sportNameToPromptStem: Record<string, string> = {
      gym: 'gym',
      running: 'running',
      cycle: 'cycling',
      swim: 'swim',
    };
    for (const name of Object.keys(sportNameToPromptStem)) {
      const sub = triathlon.subSkills.find((s: any) => s.name === name);
      expect(sub, `sport sub-skill ${name}`).toBeDefined();
      expect(sub.coachPersona).not.toBeNull();
      expect(sub.promptFile).toBe(`triathlon/${sportNameToPromptStem[name]}.md`);
      expect(sub.accessible).toBe(true); // pro user can reach pro sport skills
    }
  });

  it('free user can access secretary but NOT triathlon sub-skills', async () => {
    const user = getOrCreateUser(1004, { username: 'free' });
    setUserTier(1004, 'free'); // downgrade from Phase 1 default

    const res = await dispatch('GET', '/catalog', callerId(1004));
    expect(res.body.data.userTier).toBe('free');

    const secretary = res.body.data.skills.find((s: any) => s.name === 'secretary');
    expect(secretary.accessible).toBe(true);
    // Every secretary sub-skill should be accessible
    for (const sub of secretary.subSkills) {
      expect(sub.accessible, `free should access secretary.${sub.name}`).toBe(true);
    }

    const triathlon = res.body.data.skills.find((s: any) => s.name === 'triathlon');
    expect(triathlon.accessible).toBe(false);
    // Every triathlon sub-skill is pro, so all blocked for free
    for (const sub of triathlon.subSkills) {
      expect(sub.accessible, `free should NOT access triathlon.${sub.name}`).toBe(false);
    }
  });

  it('response includes catalogRowCount > 20 (seeded via migration 045)', async () => {
    getOrCreateUser(1005, { username: 'cnt' });
    const res = await dispatch('GET', '/catalog', callerId(1005));
    expect(res.body.data.catalogRowCount).toBeGreaterThan(20);
  });

  it('supports private ETag validation for repeated catalog reads', async () => {
    getOrCreateUser(1006, { username: 'etag-reader' });

    const first = await dispatch('GET', '/catalog', callerId(1006));
    expect(first.statusCode).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.getHeader('cache-control')).toBe('private, max-age=30');

    const etag = first.getHeader('etag');
    expect(etag).toEqual(expect.stringMatching(/^"skills-catalog-[a-f0-9]{32}"$/));

    const second = await dispatch('GET', '/catalog', callerId(1006), undefined, {
      headers: { 'If-None-Match': String(etag) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.ended).toBe(true);
    expect(second.body).toBeNull();
    expect(second.getHeader('etag')).toBe(etag);
    expect(second.getHeader('cache-control')).toBe('private, max-age=30');
  });
});

describe('Skills API — version registry', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    cacheMocks.invalidateDashboardCoordinationCaches.mockClear();
  });
  afterEach(() => {
    delete process.env.OWNER_TELEGRAM_ID;
    testDb?.close();
  });

  it('returns current skill version metadata for an authenticated user', async () => {
    getOrCreateUser(1501, { username: 'version-reader' });

    const res = await dispatch('GET', '/versions', callerId(1501));

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.skills.map((skill: any) => skill.skillId)).toEqual([
      'chat',
      'secretary',
      'training',
      'finance',
      'cooking',
      'content',
    ]);
    expect(res.body.data.skills.find((skill: any) => skill.skillId === 'content').currentVersion).toBe('2.0.0');
    expect(res.body.data.skills.find((skill: any) => skill.skillId === 'secretary').currentVersion).toBe('2.2.0');
  });

  it('returns one skill metadata and supports the triathlon training alias', async () => {
    getOrCreateUser(1502, { username: 'version-reader-2' });

    const res = await dispatch('GET', '/versions/triathlon', callerId(1502));

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.skillId).toBe('training');
    expect(res.body.data.currentVersion).toBe('3.0.0');
  });

  it('denies version mutation to non-owner users', async () => {
    getOrCreateUser(1503, { username: 'pro' });

    const res = await dispatch('POST', '/versions', callerId(1503), {
      skillId: 'content',
      skillName: 'Content Creation',
      version: '2.1.0',
      releaseType: 'minor',
      releaseTitle: 'Unauthorized write',
      releaseSummary: 'Should not be accepted.',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('does not accept a stale persisted owner tier as owner authority', async () => {
    getOrCreateUser(1510, { username: 'stale-owner' });
    setUserTier(1510, 'owner');
    delete process.env.OWNER_TELEGRAM_ID;

    const res = await dispatch('POST', '/versions', callerId(1510), {
      skillId: 'content',
      skillName: 'Content Creation',
      version: '2.1.0',
      releaseType: 'minor',
      releaseTitle: 'Unauthorized stale tier write',
      releaseSummary: 'Should not be accepted.',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('owner can create version metadata without exposing internal notes in release history', async () => {
    getOrCreateUser(1504, { username: 'owner' });
    configureCanonicalOwner(1504);

    const createRes = await dispatch('POST', '/versions', callerId(1504), {
      skillId: 'content',
      skillName: 'Content Creation',
      version: '2.1.0',
      releaseType: 'minor',
      releaseTitle: 'Source provenance foundation',
      releaseSummary: 'Adds source-ledger metadata for content artifacts.',
      capabilitiesAdded: ['source registry'],
      testsAdded: ['skill-version-registry.test.ts'],
      rollbackNotes: 'Roll back to content@2.0.0.',
      internalNotes: 'private security investigation details',
      status: 'candidate',
    });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.body.data.skillId).toBe('content');
    expect(JSON.stringify(createRes.body)).not.toContain('private security investigation details');

    const historyRes = await dispatch('GET', '/versions/content/history', callerId(1504));
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.body.data.versions.map((version: any) => version.version)).toContain('2.1.0');
    expect(JSON.stringify(historyRes.body)).not.toContain('private security investigation details');
  });

  it('owner can activate tenant-specific rollout metadata without changing global users', async () => {
    getOrCreateUser(1505, { username: 'owner' });
    configureCanonicalOwner(1505);

    await dispatch('POST', '/versions', callerId(1505), {
      skillId: 'secretary',
      skillName: 'Secretary',
      version: '2.1.0',
      releaseType: 'minor',
      releaseTitle: 'Tenant schedule canary',
      releaseSummary: 'Canary scheduling metadata.',
      capabilitiesAdded: ['tenant schedule canary'],
      rollbackNotes: 'Remove tenant rollout.',
      status: 'candidate',
      rolloutScope: 'tenant',
    });

    const canary = getOrCreateUser(1506, { username: 'tenant-canary' });
    getOrCreateUser(1507, { username: 'ordinary' });

    const activateRes = await dispatch('POST', '/versions/secretary/2.1.0/activate', callerId(1505), {
      scopeType: 'tenant',
      tenantId: canary.id,
    });
    expect(activateRes.statusCode).toBe(200);
    expect(activateRes.body.data.version).toBe('2.1.0');

    const canaryRes = await dispatch('GET', '/versions/secretary', callerId(1506));
    const ordinaryRes = await dispatch('GET', '/versions/secretary', callerId(1507));
    expect(canaryRes.body.data.currentVersion).toBe('2.1.0');
    expect(ordinaryRes.body.data.currentVersion).toBe('2.2.0');
  });
});

// ─── POST /override — admin only ────────────────────────────────────

describe('Skills API — POST /override', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    cacheMocks.invalidateDashboardCoordinationCaches.mockClear();
  });
  afterEach(() => {
    delete process.env.OWNER_TELEGRAM_ID;
    testDb?.close();
  });

  it('returns 403 for non-owner caller', async () => {
    getOrCreateUser(2001, { username: 'pro' }); // defaults to pro
    getOrCreateUser(2002, { username: 'target' });
    const res = await dispatch('POST', '/override', callerId(2001), {
      targetUserId: 2002,
      skillId: 'triathlon.gym',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for missing body fields', async () => {
    getOrCreateUser(2003, { username: 'owner' });
    configureCanonicalOwner(2003);
    const res = await dispatch('POST', '/override', callerId(2003), {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when target user does not exist', async () => {
    getOrCreateUser(2004, { username: 'owner' });
    configureCanonicalOwner(2004);
    const res = await dispatch('POST', '/override', callerId(2004), {
      targetUserId: 99999,
      skillId: 'triathlon.gym',
    });
    expect(res.statusCode).toBe(404);
  });

  it('owner can grant an override, unblocking a free user for a pro skill', async () => {
    const owner = getOrCreateUser(2005, { username: 'owner' });
    configureCanonicalOwner(2005);
    const target = getOrCreateUser(2006, { username: 'free' });
    setUserTier(2006, 'free');

    // Before: free user can't access triathlon.gym
    const beforeRes = await dispatch('GET', '/catalog', callerId(2006));
    const beforeTri = beforeRes.body.data.skills.find((s: any) => s.name === 'triathlon');
    const beforeGym = beforeTri.subSkills.find((s: any) => s.name === 'gym');
    expect(beforeGym.accessible).toBe(false);

    // Owner grants override
    const grantRes = await dispatch('POST', '/override', callerId(2005), {
      targetUserId: 2006,
      skillId: 'triathlon.gym',
      reason: 'beta tester',
    });
    expect(grantRes.statusCode).toBe(200);
    expect(grantRes.body.data.granted).toBe(true);
    expect(cacheMocks.invalidateDashboardCoordinationCaches).toHaveBeenCalledWith(target.id);

    // After: free user CAN access triathlon.gym via override
    const afterRes = await dispatch('GET', '/catalog', callerId(2006));
    const afterTri = afterRes.body.data.skills.find((s: any) => s.name === 'triathlon');
    const afterGym = afterTri.subSkills.find((s: any) => s.name === 'gym');
    expect(afterGym.accessible).toBe(true);
    expect(afterGym.accessReason).toBe('user_grant');
  });

  it('sanitizes override grant failures instead of leaking persistence internals', async () => {
    getOrCreateUser(2007, { username: 'owner' });
    configureCanonicalOwner(2007);
    getOrCreateUser(2008, { username: 'target' });

    const originalPrepare = testDb.prepare.bind(testDb);
    const prepareSpy = vi.spyOn(testDb, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('INSERT INTO user_skill_tier_overrides')) {
        throw new Error('skill override sqlite exploded');
      }
      return originalPrepare(sql);
    }) as typeof testDb.prepare);

    const res = await dispatch('POST', '/override', callerId(2007), {
      targetUserId: 2008,
      skillId: 'triathlon.gym',
    });

    prepareSpy.mockRestore();

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to grant override');
    expect(JSON.stringify(res.body)).not.toContain('skill override sqlite exploded');
  });
});

// ─── DELETE /override ───────────────────────────────────────────────

describe('Skills API — DELETE /override', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => {
    delete process.env.OWNER_TELEGRAM_ID;
    testDb?.close();
  });

  it('returns 403 for non-owner caller', async () => {
    getOrCreateUser(3001, { username: 'pro' });
    const res = await dispatch('DELETE', '/override', callerId(3001), {
      targetUserId: 3002,
      skillId: 'triathlon.gym',
    });
    expect(res.statusCode).toBe(403);
  });

  it('owner can revoke an existing override', async () => {
    const owner = getOrCreateUser(3003, { username: 'owner' });
    configureCanonicalOwner(3003);
    const target = getOrCreateUser(3004, { username: 'free' });
    setUserTier(3004, 'free');

    // Grant then revoke
    await dispatch('POST', '/override', callerId(3003), {
      targetUserId: 3004,
      skillId: 'triathlon.gym',
    });
    const revokeRes = await dispatch('DELETE', '/override', callerId(3003), {
      targetUserId: 3004,
      skillId: 'triathlon.gym',
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.body.data.revoked).toBe(true);
    expect(cacheMocks.invalidateDashboardCoordinationCaches).toHaveBeenCalledWith(target.id);

    // Target user should now be blocked again
    const afterRes = await dispatch('GET', '/catalog', callerId(3004));
    const afterTri = afterRes.body.data.skills.find((s: any) => s.name === 'triathlon');
    const afterGym = afterTri.subSkills.find((s: any) => s.name === 'gym');
    expect(afterGym.accessible).toBe(false);
  });

  it('DELETE accepts query params (iOS DELETE-no-body path)', async () => {
    // The iOS NexusHTTPClient.delete doesn't carry a body, so the iOS
    // SkillsService encodes targetUserId + skillId as query params.
    // The backend route must accept both forms. This test locks that.
    getOrCreateUser(3005, { username: 'owner' });
    configureCanonicalOwner(3005);
    const target = getOrCreateUser(3006, { username: 'free' });
    setUserTier(3006, 'free');

    await dispatch('POST', '/override', callerId(3005), {
      targetUserId: 3006,
      skillId: 'triathlon.swim',
    });

    // Dispatch with NO body — identifiers come via `req.query` only.
    const router = skillsRoutes();
    const req = { userId: callerId(3005), body: {}, query: { targetUserId: '3006', skillId: 'triathlon.swim' } } as any;
    req.method = 'DELETE';
    req.url = '/override';
    req.originalUrl = '/override';
    req.baseUrl = '';
    req.path = '/override';
    req.params = {};
    req.headers = {};
    const res = mockRes();
    await new Promise<void>((resolve) => {
      (router as any).handle(req, res, () => resolve());
      setImmediate(resolve);
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.revoked).toBe(true);
  });
});
