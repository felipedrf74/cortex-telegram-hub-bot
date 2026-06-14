import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { vi } from 'vitest';
import { listCanonicalMigrationFiles } from '../utils/migrations';

const dbState = vi.hoisted(() => ({
  db: null as Database.Database | null,
}));

const calendarMocks = vi.hoisted(() => {
  let eventSeq = 0;
  const makeEvent = (data: any, source: 'outlook' | 'google' = 'outlook') => ({
    id: `${source}-training-${++eventSeq}`,
    summary: String(data?.title ?? 'Training session'),
    start: String(data?.start ?? '2026-05-25T07:00:00.000Z'),
    end: String(data?.end ?? '2026-05-25T08:00:00.000Z'),
    description: data?.description,
    categories: data?.categories,
    source,
  });
  return {
    reset: () => {
      eventSeq = 0;
    },
    getEvents: vi.fn(async () => []),
    getEventsForSources: vi.fn(async () => []),
    getEventsWithDiagnostics: vi.fn(async () => ({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: {
        configured: ['outlook', 'google'],
        fulfilled: ['outlook', 'google'],
        failed: [],
      },
    })),
    createEvent: vi.fn(async (data: any, target?: 'outlook' | 'google') => makeEvent(data, target ?? 'outlook')),
    updateEvent: vi.fn(async (data: any, source: 'outlook' | 'google' = 'outlook') => ({
      id: String(data?.event_id ?? `${source}-updated`),
      summary: String(data?.new_title ?? 'Updated training session'),
      start: String(data?.new_start ?? '2026-05-25T07:00:00.000Z'),
      end: String(data?.new_end ?? '2026-05-25T08:00:00.000Z'),
      description: data?.new_description,
      source,
    })),
    deleteEvent: vi.fn(async () => undefined),
    googleGetEvents: vi.fn(async () => []),
    googleCreateEvent: vi.fn(async (data: any) => makeEvent(data, 'google')),
    googleUpdateEvent: vi.fn(async (data: any) => ({
      id: String(data?.event_id ?? 'google-updated'),
      summary: String(data?.new_title ?? 'Updated training session'),
      start: String(data?.new_start ?? '2026-05-25T07:00:00.000Z'),
      end: String(data?.new_end ?? '2026-05-25T08:00:00.000Z'),
    })),
    googleDeleteEvent: vi.fn(async () => undefined),
    outlookGetEvents: vi.fn(async () => []),
    outlookCreateEvent: vi.fn(async (data: any) => makeEvent(data, 'outlook')),
    outlookUpdateEvent: vi.fn(async (data: any) => ({
      id: String(data?.event_id ?? 'outlook-updated'),
      summary: String(data?.new_title ?? 'Updated training session'),
      start: String(data?.new_start ?? '2026-05-25T07:00:00.000Z'),
      end: String(data?.new_end ?? '2026-05-25T08:00:00.000Z'),
    })),
    outlookDeleteEvent: vi.fn(async () => undefined),
  };
});

export { calendarMocks };

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!dbState.db) throw new Error('Test DB not initialized');
    return dbState.db;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  isAnyCalendarConfigured: vi.fn(() => true),
  hasConnectedCalendarForUser: vi.fn(() => true),
  hasWritableCalendarForUser: vi.fn(() => true),
  getConfiguredSources: vi.fn(() => ['outlook', 'google']),
  getEvents: (...args: any[]) => calendarMocks.getEvents(...args),
  getEventsForSources: (...args: any[]) => calendarMocks.getEventsForSources(...args),
  getEventsWithDiagnostics: (...args: any[]) => calendarMocks.getEventsWithDiagnostics(...args),
  createEvent: (...args: any[]) => calendarMocks.createEvent(...args),
  updateEvent: (...args: any[]) => calendarMocks.updateEvent(...args),
  deleteEvent: (...args: any[]) => calendarMocks.deleteEvent(...args),
  eventFingerprint: (event: any) => `${String(event?.summary ?? '').toLowerCase()}|${String(event?.start ?? '')}`,
  deduplicateEvents: (events: any[]) => events,
}));

vi.mock('../../src/services/google-calendar', () => ({
  setGoogleCalendarUserId: vi.fn(),
  isGoogleCalendarConfigured: vi.fn(() => true),
  getEvents: (...args: any[]) => calendarMocks.googleGetEvents(...args),
  createEvent: (...args: any[]) => calendarMocks.googleCreateEvent(...args),
  updateEvent: (...args: any[]) => calendarMocks.googleUpdateEvent(...args),
  deleteEvent: (...args: any[]) => calendarMocks.googleDeleteEvent(...args),
  withGoogleCategoryTags: (description: string | undefined) => description,
  sanitizeGoogleCalendarErrorForLog: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
  toGoogleCalendarApiError: (err: unknown) => err instanceof Error ? err : new Error(String(err)),
}));

vi.mock('../../src/services/outlook-calendar', () => ({
  isOutlookCalendarConfigured: vi.fn(() => true),
  getMasterCategories: vi.fn(async () => []),
  getCategoryNameForColor: vi.fn(async (color: string) => `${color} category`),
  getEvents: (...args: any[]) => calendarMocks.outlookGetEvents(...args),
  createEvent: (...args: any[]) => calendarMocks.outlookCreateEvent(...args),
  updateEvent: (...args: any[]) => calendarMocks.outlookUpdateEvent(...args),
  deleteEvent: (...args: any[]) => calendarMocks.outlookDeleteEvent(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { trainingRoutes } from '../../src/api/routes/training';
import { setDbProvider } from '../../src/services/intelligence-bus';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  getHeader(name: string): string | undefined;
  end(): MockRes;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = listCanonicalMigrationFiles(fs.readdirSync(MIGRATIONS_DIR));

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

function mockReq(
  method: string,
  routePath: string,
  body?: any,
  userId = 12,
  tenantId = userId,
  headers: Record<string, string> = {},
): Request {
  return {
    method,
    url: routePath,
    originalUrl: routePath,
    baseUrl: '',
    path: routePath,
    query: {},
    params: {},
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
    body,
    userId,
    tenantId,
  } as any;
}

function mockRes(onFinish: (res: MockRes) => void): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; onFinish(r); return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    getHeader(name: string) { return r.headers[name]; },
    end() { onFinish(r); return r; },
  };
  return r;
}

export interface TrainingE2EHarness {
  db: Database.Database;
  seedTrainingUser(input?: { userId?: number; tenantId?: number }): void;
  dispatch(method: 'GET' | 'POST', routePath: string, body?: any, userId?: number, tenantId?: number): Promise<MockRes>;
  close(): void;
}

export function createTrainingE2EHarness(): TrainingE2EHarness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  dbState.db = db;
  setDbProvider(() => db as any);
  resetCalendarMocks();

  return {
    db,
    seedTrainingUser(input = {}) {
      seedTrainingUser(db, input.userId ?? 12, input.tenantId ?? input.userId ?? 12);
    },
    dispatch(method, routePath, body, userId = 12, tenantId = userId) {
      const router = trainingRoutes();
      const req = mockReq(method, routePath, body, userId, tenantId);
      return new Promise<MockRes>((resolve, reject) => {
        const res = mockRes(resolve);
        (router as any).handle(req, res, (err: any) => {
          if (err) {
            reject(err);
            return;
          }
          if (res.body == null) {
            resolve(res);
          }
        });
      });
    },
    close() {
      db.close();
      if (dbState.db === db) dbState.db = null;
      setDbProvider(null);
    },
  };
}

export function resetCalendarMocks(): void {
  calendarMocks.reset();
  for (const value of Object.values(calendarMocks)) {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as any).mockClear();
    }
  }
}

function seedTrainingUser(db: Database.Database, userId: number, tenantId: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, telegram_id, first_name, language, timezone, tier, status,
      daily_message_limit, daily_token_limit, daily_cost_limit_usd
    ) VALUES (?, ?, 'Training Test', 'en-US', 'Europe/Lisbon', 'max', 'active', 1000, 1000000, 10)
  `).run(userId, 900000 + userId);

  const profiles = [
    ['fitness', {
      experience_level: 'Advanced (3+ years)',
      weekly_frequency: '6+ days',
      training_goals: ['Endurance', 'Strength'],
      injuries: 'none',
      available_equipment: 'Full gym',
    }],
    ['triathlon-gym', {
      training_age: '5+ years',
      current_split: 'Upper/Lower',
      primary_goal: 'Support other sports',
      squat_1rm_kg: 140,
      bench_1rm_kg: 100,
      deadlift_1rm_kg: 180,
      sessions_per_week: '5+',
      equipment_access: 'Full commercial gym',
    }],
    ['triathlon-running', {
      weekly_mileage_km: 55,
      longest_recent_run_km: 24,
      easy_pace_min_per_km: '5:20',
      target_race: 'Marathon',
      target_race_date: '2026-10-18',
      preferred_workouts: ['Easy runs', 'Tempo', 'Long runs'],
      injury_history: 'none',
      weekly_availability_days: '6+',
    }],
  ] as const;

  for (const [profileType, data] of profiles) {
    db.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, profile_type) DO UPDATE SET
        data = excluded.data,
        updated_at = datetime('now')
    `).run(userId, profileType, JSON.stringify(data));
  }

  for (const provider of ['outlook', 'google']) {
    db.prepare(`
      INSERT INTO user_oauth_tokens (
        user_id, provider, access_token, refresh_token, token_type, scopes, updated_at
      ) VALUES (?, ?, 'test-access-token', 'test-refresh-token', 'Bearer', '[]', datetime('now'))
      ON CONFLICT(user_id, provider) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        updated_at = datetime('now')
    `).run(userId, provider);
  }

  if (tenantId !== userId) {
    db.prepare(`
      INSERT OR IGNORE INTO users (
        id, telegram_id, first_name, language, timezone, tier, status,
        daily_message_limit, daily_token_limit, daily_cost_limit_usd
      ) VALUES (?, ?, 'Tenant Test', 'en-US', 'Europe/Lisbon', 'max', 'active', 1000, 1000000, 10)
    `).run(tenantId, 910000 + tenantId);
  }
}
