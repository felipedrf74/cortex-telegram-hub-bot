// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * End-to-end tests for the PUBLIC /waitlist/* router
 * (src/api/routes/waitlist.ts — mounted at the root of the Express
 * app so random internet visitors can POST).
 *
 * Scope of this file:
 *   - GET /waitlist/stats returns `beta` AND `founder` (OI-WAITLIST-101).
 *   - POST /waitlist/profile happy path (updates an existing row,
 *     latest-wins, idempotent same-value no-op).
 *   - POST /waitlist/profile defense: unknown profile → 400 with
 *     allowed-list echo; bad email → 400; no matching row → 404;
 *     rate-limit → 429.
 *
 * Uses a real in-memory SQLite DB running every migration, a real
 * Express app, and http.request — same pattern as
 * portal-owner-router.test.ts. No supertest dependency.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

// Prevent this file's vi.mock('services/database') from polluting
// later test files in the singleFork pool. Mirror the pattern used
// by portal-owner-router.test.ts.
afterAll(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  vi.resetModules();
});

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY,
       filename TEXT UNIQUE,
       applied_at TEXT DEFAULT (datetime('now'))
     )`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch {
      // Skip incompatible migrations in isolated harness.
    }
  }
}

async function req(
  app: express.Express,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const payload = body ? JSON.stringify(body) : undefined;

      const http = require('http');
      const request = http.request(
        { host: '127.0.0.1', port, path: urlPath, method, headers },
        (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        },
      );
      request.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      if (payload) request.write(payload);
      request.end();
    });
  });
}

async function makeApp(): Promise<express.Express> {
  // Lazy-require so the vi.mock above intercepts the getDb call that
  // the router captures at module-import time.
  const { createWaitlistRouter, _resetRateLimiterForTests } = await import('../../src/api/routes/waitlist');
  _resetRateLimiterForTests();
  const app = express();
  app.use('/waitlist', createWaitlistRouter());
  return app;
}

function seedWaitlist(email: string, intent: 'founder' | 'general' = 'general'): number {
  const info = testDb.prepare(
    `INSERT INTO waitlist (email, intent, status) VALUES (?, ?, 'pending')`,
  ).run(email, intent);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

describe('GET /waitlist/stats (OI-WAITLIST-101)', () => {
  it('returns a `beta` key alongside the legacy `founder` key', async () => {
    const app = await makeApp();
    const r = await req(app, 'GET', '/waitlist/stats');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.founder).toBeDefined();
    expect(r.body.beta).toBeDefined();
  });

  it('beta and founder are byte-identical (beta is an alias, not a divergent counter)', async () => {
    seedWaitlist('a@example.com', 'founder');
    seedWaitlist('b@example.com', 'founder');
    seedWaitlist('c@example.com', 'general');

    const app = await makeApp();
    const r = await req(app, 'GET', '/waitlist/stats');
    expect(r.body.founder).toEqual(r.body.beta);
    // Sanity: the 2 founder signups are reflected in `filled`.
    expect(r.body.beta.filled).toBe(2);
    expect(r.body.beta.max).toBe(100);
    expect(r.body.beta.remaining).toBe(98);
  });

  it('general total is still returned (social-proof counter)', async () => {
    seedWaitlist('a@example.com', 'general');
    seedWaitlist('b@example.com', 'general');
    const app = await makeApp();
    const r = await req(app, 'GET', '/waitlist/stats');
    expect(r.body.general.total).toBe(2);
  });
});

describe('POST /waitlist/profile (OI-WAITLIST-101)', () => {
  it('happy path: updates an existing row and returns {ok, profile}', async () => {
    seedWaitlist('felipe@example.com', 'founder');
    const app = await makeApp();
    const r = await req(app, 'POST', '/waitlist/profile', {
      email: 'felipe@example.com',
      profile: 'entrepreneur',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.profile).toBe('entrepreneur');
    expect(r.body.previous).toBeNull();
    // DB row should be updated.
    const row = testDb.prepare('SELECT profile FROM waitlist WHERE email = ?')
      .get('felipe@example.com') as { profile: string | null };
    expect(row.profile).toBe('entrepreneur');
  });

  it('latest-wins: re-POSTing a different profile replaces the stored one', async () => {
    seedWaitlist('felipe@example.com');
    const app = await makeApp();
    await req(app, 'POST', '/waitlist/profile', { email: 'felipe@example.com', profile: 'creator' });
    const r = await req(app, 'POST', '/waitlist/profile', { email: 'felipe@example.com', profile: 'athlete' });
    expect(r.body.profile).toBe('athlete');
    expect(r.body.previous).toBe('creator');
  });

  it('idempotent same-value no-op returns {ok, unchanged:true}', async () => {
    seedWaitlist('felipe@example.com');
    const app = await makeApp();
    await req(app, 'POST', '/waitlist/profile', { email: 'felipe@example.com', profile: 'creator' });
    const r = await req(app, 'POST', '/waitlist/profile', { email: 'felipe@example.com', profile: 'creator' });
    expect(r.status).toBe(200);
    expect(r.body.unchanged).toBe(true);
  });

  it('case-insensitive email: uppercase input matches a lowercase-stored row', async () => {
    // POST / lowercases on write; profile endpoint lowercases on lookup.
    seedWaitlist('felipe@example.com');
    const app = await makeApp();
    const r = await req(app, 'POST', '/waitlist/profile', {
      email: 'FELIPE@EXAMPLE.COM',
      profile: 'all',
    });
    expect(r.status).toBe(200);
    expect(r.body.profile).toBe('all');
  });

  it('unknown profile → 400 with allowed-list echo (lets frontend diagnose drift)', async () => {
    seedWaitlist('felipe@example.com');
    const app = await makeApp();
    const r = await req(app, 'POST', '/waitlist/profile', {
      email: 'felipe@example.com',
      profile: 'influencer',  // not in the allow-list
    });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.allowed).toEqual(expect.arrayContaining(['entrepreneur', 'creator', 'athlete', 'all']));
    // DB row untouched.
    const row = testDb.prepare('SELECT profile FROM waitlist WHERE email = ?')
      .get('felipe@example.com') as { profile: string | null };
    expect(row.profile).toBeNull();
  });

  it('invalid email → 400 (not 422 — public form, user-friendly)', async () => {
    const app = await makeApp();
    const r = await req(app, 'POST', '/waitlist/profile', { email: 'not-an-email', profile: 'creator' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/valid email/i);
  });

  it('no matching waitlist row → 404 (distinguishable from bad input)', async () => {
    const app = await makeApp();
    const r = await req(app, 'POST', '/waitlist/profile', {
      email: 'ghost@example.com',
      profile: 'creator',
    });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('no_waitlist_entry');
  });

  it('shares the same rate-limit bucket as POST / — 4th call in a window → 429', async () => {
    seedWaitlist('felipe@example.com');
    const app = await makeApp();
    // MAX_PER_WINDOW is 3; 4th call within the window must 429.
    for (let i = 0; i < 3; i++) {
      const r = await req(app, 'POST', '/waitlist/profile', {
        email: 'felipe@example.com',
        profile: i % 2 === 0 ? 'creator' : 'athlete',
      });
      expect(r.status).toBe(200);
    }
    const r4 = await req(app, 'POST', '/waitlist/profile', {
      email: 'felipe@example.com',
      profile: 'entrepreneur',
    });
    expect(r4.status).toBe(429);
  });
});

describe('POST /waitlist — inline profile capture (OI-WAITLIST-101)', () => {
  it('first-submit with profile persists it in-place (no second round-trip)', async () => {
    const app = await makeApp();
    const r = await req(app, 'POST', '/waitlist', {
      email: 'new@example.com',
      intent: 'general',
      profile: 'creator',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const row = testDb.prepare('SELECT profile FROM waitlist WHERE email = ?')
      .get('new@example.com') as { profile: string | null };
    expect(row.profile).toBe('creator');
  });

  it('unknown inline profile is silently dropped (signup still succeeds)', async () => {
    const app = await makeApp();
    const r = await req(app, 'POST', '/waitlist', {
      email: 'new@example.com',
      intent: 'general',
      profile: 'influencer',   // not in the allow-list
    });
    // User is not blocked from signing up just because of a profile
    // drift — we stash them with profile=NULL and the dedicated
    // /profile endpoint surfaces the real error when they retry.
    expect(r.status).toBe(200);
    const row = testDb.prepare('SELECT profile FROM waitlist WHERE email = ?')
      .get('new@example.com') as { profile: string | null };
    expect(row.profile).toBeNull();
  });

  it('re-submit with empty profile does NOT wipe a prior profile (COALESCE semantics)', async () => {
    const app = await makeApp();
    await req(app, 'POST', '/waitlist', {
      email: 'felipe@example.com',
      intent: 'general',
      profile: 'athlete',
    });
    // Second submit without a profile (user cleared it or the
    // frontend forgot to include it) must NOT clobber the prior.
    await req(app, 'POST', '/waitlist', {
      email: 'felipe@example.com',
      intent: 'founder',
    });
    const row = testDb.prepare('SELECT profile, intent FROM waitlist WHERE email = ?')
      .get('felipe@example.com') as { profile: string | null; intent: string };
    expect(row.profile).toBe('athlete');   // preserved
    expect(row.intent).toBe('founder');    // upgraded
  });
});

describe('migration 083 — waitlist.profile column + CHECK constraint', () => {
  it('profile column exists and accepts all four allowed values', () => {
    for (const p of ['entrepreneur', 'creator', 'athlete', 'all']) {
      testDb.prepare(
        `INSERT INTO waitlist (email, intent, status, profile) VALUES (?, 'general', 'pending', ?)`,
      ).run(`${p}@example.com`, p);
    }
    const count = (testDb.prepare('SELECT COUNT(*) AS c FROM waitlist WHERE profile IS NOT NULL')
      .get() as { c: number }).c;
    expect(count).toBe(4);
  });

  it('CHECK constraint rejects profiles outside the allow-list', () => {
    expect(() => testDb.prepare(
      `INSERT INTO waitlist (email, intent, status, profile) VALUES (?, 'general', 'pending', 'influencer')`,
    ).run('x@example.com')).toThrow(/CHECK constraint/i);
  });

  it('NULL profile is allowed (existing rows + users who skipped the quiz)', () => {
    expect(() => testDb.prepare(
      `INSERT INTO waitlist (email, intent, status) VALUES (?, 'general', 'pending')`,
    ).run('skipper@example.com')).not.toThrow();
  });
});
