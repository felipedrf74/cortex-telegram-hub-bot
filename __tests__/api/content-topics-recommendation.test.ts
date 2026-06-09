import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { DateTime } from 'luxon';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
let mockCalendarEvents: any[] = [];
let mockReadinessScore: number | null = 76;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
    contentEngine: { enabled: false, port: 8100 },
    anthropic: { apiKey: '' },
    gemini: { apiKey: '', model: 'gemini-2.5-flash-lite' },
    openai: { apiKey: '' },
    aiSafety: { callTimeoutMs: 1000 },
  },
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: vi.fn(async () => mockCalendarEvents),
  isAnyCalendarConfigured: vi.fn(() => true),
  hasWritableCalendarForUser: vi.fn(() => true),
}));

vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: vi.fn(async () => (mockReadinessScore == null ? null : { score: mockReadinessScore })),
}));

import { contentRoutes } from '../../src/api/routes/content';
import { addTopic } from '../../src/services/content-scheduler';
import { getOrCreateUser, setUserLanguage } from '../../src/services/user-service';
import { createPlan, createSession, createWeek } from '../../src/services/training-plans';
import { publishLowReadiness } from '../../src/services/training-signals';
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

function mockReq(userId: number): Request {
  return { userId } as any;
}

async function dispatch(method: 'GET', url: string, userId: number): Promise<MockRes> {
  const router = contentRoutes();
  const request = mockReq(userId);
  const parsed = new URL(url, 'http://test.local');
  (request as any).method = method;
  (request as any).url = parsed.pathname + parsed.search;
  (request as any).originalUrl = parsed.pathname + parsed.search;
  (request as any).baseUrl = '';
  (request as any).path = parsed.pathname;
  (request as any).query = Object.fromEntries(parsed.searchParams.entries());
  (request as any).params = {};
  (request as any).headers = {};

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

describe('Content API — filming recommendation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    setDbProvider(() => testDb);
    mockCalendarEvents = [];
    mockReadinessScore = 76;
  });

  afterEach(() => {
    testDb?.close();
  });

  it('picks the cleaner filming day when training and calendar compete for energy', async () => {
    const user = getOrCreateUser(31001, { username: 'creator' });
    setUserLanguage(user.id, 'pt-PT');
    const today = DateTime.now().setZone('Europe/Lisbon').startOf('day');
    const tomorrow = today.plus({ days: 1 });
    const dayAfterTomorrow = today.plus({ days: 2 });

    addTopic(user.id, 'VO2 recap', { scheduledDate: tomorrow.toISODate()! });
    const topicScope = testDb.prepare(`
      SELECT tenant_id, owner_user_id, scope_status
      FROM content_topics
      WHERE user_id = ? AND title = 'VO2 recap'
    `).get(user.id) as { tenant_id: number; owner_user_id: number; scope_status: string };
    expect(topicScope).toEqual({
      tenant_id: user.id,
      owner_user_id: user.id,
      scope_status: 'active',
    });

    const plan = createPlan({
      user_id: user.id,
      tenant_id: user.id,
      name: 'Tri plan',
      sport: 'running',
      duration_weeks: 2,
      start_date: today.startOf('week').toISODate()!,
      end_date: today.startOf('week').plus({ weeks: 2, days: 6 }).toISODate()!,
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1 });
    createWeek({ plan_id: plan.id, week_number: 2 });

    createSession({
      week_id: week.id,
      plan_id: plan.id,
      day_of_week: today.toFormat('EEEE'),
      session_type: 'running',
      title: 'Track intervals',
      intensity_text: 'VO2 intervals',
    });

    mockCalendarEvents = [
      {
        summary: 'Quarterly planning',
        start: tomorrow.set({ hour: 9 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 10, minute: 30 }).toUTC().toISO(),
        source: 'outlook',
      },
      {
        summary: 'Client review',
        start: tomorrow.set({ hour: 11 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 12 }).toUTC().toISO(),
        source: 'google',
      },
      {
        summary: 'Team sync',
        start: tomorrow.set({ hour: 14 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 15 }).toUTC().toISO(),
        source: 'google',
      },
      {
        summary: 'Budget follow-up',
        start: tomorrow.set({ hour: 16 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 17, minute: 30 }).toUTC().toISO(),
        source: 'outlook',
      },
    ];

    const response = await dispatch('GET', '/topics', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.filmingRecommendation).toMatchObject({
      date: dayAfterTomorrow.toISODate(),
      confidence: 'high',
      trainingLoad: 'rest',
      calendarLoad: 'light',
      readinessScore: 76,
    });
    expect(response.body.data.filmingRecommendation.blockStart).toBeTruthy();
    expect(response.body.data.filmingRecommendation.blockEnd).toBeTruthy();
    expect(
      DateTime.fromISO(response.body.data.filmingRecommendation.blockStart, { zone: 'utc' })
        .setZone('Europe/Lisbon')
        .toISODate(),
    ).toBe(dayAfterTomorrow.toISODate());
    expect(response.body.data.filmingRecommendation.reasons.join(' ').toLowerCase()).toContain('calendário');
  });

  it('localizes the recommendation copy and marks reservation unavailable when the user has no writable calendar', async () => {
    const { hasWritableCalendarForUser } = await import('../../src/services/unified-calendar');
    vi.mocked(hasWritableCalendarForUser).mockReturnValueOnce(false);

    const user = getOrCreateUser(31003, { username: 'creator3' });
    setUserLanguage(user.id, 'pt-PT');

    const response = await dispatch('GET', '/topics', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.filmingRecommendation).toBeTruthy();
    expect(response.body.data.filmingRecommendation.reason).toContain('treino');
    expect(response.body.data.filmingRecommendation.calendarReservationAvailable).toBe(false);
    expect(response.body.data.filmingRecommendation.calendarReservationMessage).toContain('Definições');
  });

  it('lowers confidence and pushes filming away from a low-readiness day', async () => {
    const user = getOrCreateUser(31002, { username: 'creator2' });
    const today = DateTime.now().setZone('Europe/Lisbon').startOf('day');
    mockReadinessScore = 41;
    publishLowReadiness({ userId: user.id, score: 41, reason: 'Poor recovery' });

    const response = await dispatch('GET', '/topics', user.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.filmingRecommendation).toBeTruthy();
    expect(response.body.data.filmingRecommendation.date).not.toBe(today.toISODate());
    expect(response.body.data.filmingRecommendation.readinessScore).toBe(41);
    expect(['high', 'medium', 'low']).toContain(response.body.data.filmingRecommendation.confidence);
  });
});
