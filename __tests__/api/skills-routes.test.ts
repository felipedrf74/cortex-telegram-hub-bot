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
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import { skillsRoutes } from '../../src/api/routes/skills';
import { getOrCreateUser, setUserTier } from '../../src/services/user-service';

// ─── Mock req/res helpers ───────────────────────────────────────────

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(userId: number, body?: any): Request {
  return { userId, body } as any;
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

// ─── Tests ──────────────────────────────────────────────────────────

describe('Skills API — GET /catalog', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns 404 for unknown user', async () => {
    const res = await dispatch('GET', '/catalog', 99999);
    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('returns the full catalog for a pro user with all parents accessible', async () => {
    const user = getOrCreateUser(1001, { username: 'pro' });
    expect(user.tier).toBe('pro'); // Phase 1 default

    const res = await dispatch('GET', '/catalog', 1001);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const data = res.body.data;
    expect(data.userTier).toBe('pro');
    expect(data.skills).toHaveLength(5); // secretary, content, cooking, finance, triathlon

    // Every parent should be accessible for pro
    for (const skill of data.skills) {
      expect(skill.accessible, `pro should access parent ${skill.name}`).toBe(true);
    }
  });

  it('secretary sorts first in the response (free tier anchor)', async () => {
    getOrCreateUser(1002, { username: 'pro2' });
    const res = await dispatch('GET', '/catalog', 1002);
    expect(res.body.data.skills[0].name).toBe('secretary');
  });

  it('triathlon exposes 4 sport persona sub-skills + 6 capability sub-skills', async () => {
    getOrCreateUser(1003, { username: 'pro3' });
    const res = await dispatch('GET', '/catalog', 1003);
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

    const res = await dispatch('GET', '/catalog', 1004);
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
    const res = await dispatch('GET', '/catalog', 1005);
    expect(res.body.data.catalogRowCount).toBeGreaterThan(20);
  });
});

// ─── POST /override — admin only ────────────────────────────────────

describe('Skills API — POST /override', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns 403 for non-owner caller', async () => {
    getOrCreateUser(2001, { username: 'pro' }); // defaults to pro
    getOrCreateUser(2002, { username: 'target' });
    const res = await dispatch('POST', '/override', 2001, {
      targetUserId: 2002,
      skillId: 'triathlon.gym',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for missing body fields', async () => {
    getOrCreateUser(2003, { username: 'owner' });
    setUserTier(2003, 'owner');
    const res = await dispatch('POST', '/override', 2003, {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when target user does not exist', async () => {
    getOrCreateUser(2004, { username: 'owner' });
    setUserTier(2004, 'owner');
    const res = await dispatch('POST', '/override', 2004, {
      targetUserId: 99999,
      skillId: 'triathlon.gym',
    });
    expect(res.statusCode).toBe(404);
  });

  it('owner can grant an override, unblocking a free user for a pro skill', async () => {
    const owner = getOrCreateUser(2005, { username: 'owner' });
    setUserTier(2005, 'owner');
    const target = getOrCreateUser(2006, { username: 'free' });
    setUserTier(2006, 'free');

    // Before: free user can't access triathlon.gym
    const beforeRes = await dispatch('GET', '/catalog', 2006);
    const beforeTri = beforeRes.body.data.skills.find((s: any) => s.name === 'triathlon');
    const beforeGym = beforeTri.subSkills.find((s: any) => s.name === 'gym');
    expect(beforeGym.accessible).toBe(false);

    // Owner grants override
    const grantRes = await dispatch('POST', '/override', 2005, {
      targetUserId: 2006,
      skillId: 'triathlon.gym',
      reason: 'beta tester',
    });
    expect(grantRes.statusCode).toBe(200);
    expect(grantRes.body.data.granted).toBe(true);

    // After: free user CAN access triathlon.gym via override
    const afterRes = await dispatch('GET', '/catalog', 2006);
    const afterTri = afterRes.body.data.skills.find((s: any) => s.name === 'triathlon');
    const afterGym = afterTri.subSkills.find((s: any) => s.name === 'gym');
    expect(afterGym.accessible).toBe(true);
    expect(afterGym.accessReason).toBe('override');
  });
});

// ─── DELETE /override ───────────────────────────────────────────────

describe('Skills API — DELETE /override', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns 403 for non-owner caller', async () => {
    getOrCreateUser(3001, { username: 'pro' });
    const res = await dispatch('DELETE', '/override', 3001, {
      targetUserId: 3002,
      skillId: 'triathlon.gym',
    });
    expect(res.statusCode).toBe(403);
  });

  it('owner can revoke an existing override', async () => {
    const owner = getOrCreateUser(3003, { username: 'owner' });
    setUserTier(3003, 'owner');
    const target = getOrCreateUser(3004, { username: 'free' });
    setUserTier(3004, 'free');

    // Grant then revoke
    await dispatch('POST', '/override', 3003, {
      targetUserId: 3004,
      skillId: 'triathlon.gym',
    });
    const revokeRes = await dispatch('DELETE', '/override', 3003, {
      targetUserId: 3004,
      skillId: 'triathlon.gym',
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.body.data.revoked).toBe(true);

    // Target user should now be blocked again
    const afterRes = await dispatch('GET', '/catalog', 3004);
    const afterTri = afterRes.body.data.skills.find((s: any) => s.name === 'triathlon');
    const afterGym = afterTri.subSkills.find((s: any) => s.name === 'gym');
    expect(afterGym.accessible).toBe(false);
  });

  it('DELETE accepts query params (iOS DELETE-no-body path)', async () => {
    // The iOS NexusHTTPClient.delete doesn't carry a body, so the iOS
    // SkillsService encodes targetUserId + skillId as query params.
    // The backend route must accept both forms. This test locks that.
    getOrCreateUser(3005, { username: 'owner' });
    setUserTier(3005, 'owner');
    const target = getOrCreateUser(3006, { username: 'free' });
    setUserTier(3006, 'free');

    await dispatch('POST', '/override', 3005, {
      targetUserId: 3006,
      skillId: 'triathlon.swim',
    });

    // Dispatch with NO body — identifiers come via `req.query` only.
    const router = skillsRoutes();
    const req = { userId: 3005, body: {}, query: { targetUserId: '3006', skillId: 'triathlon.swim' } } as any;
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
