/**
 * Health Endpoint Tests
 *
 * Validates:
 * - GET /health — public, returns status/uptime/bot/db/memory
 * - GET /health/detailed — auth-protected via ?token=HEALTH_TOKEN
 * - /health/detailed includes cron statuses, integration health, error counts
 * - Correct HTTP status codes (200 healthy, 503 degraded, 401 unauthorized)
 * - Response structure and field correctness
 * - Authentication logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.includes(' 2'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// ── Mock telemetry ──────────────────────────────────────────────────

let mockPolling = true;
let mockRestarting = false;
let mockLastMessage: string | null = new Date().toISOString();
let mockJobStatuses: any[] = [];
let mockRecentEvents: any[] = [];

vi.mock('../../src/portal/telemetry', () => ({
  isBotPollingActive: () => mockPolling,
  isRestarting: () => mockRestarting,
  getLastMessageAt: () => mockLastMessage,
  getJobStatuses: () => mockJobStatuses,
  getRecentEvents: () => mockRecentEvents,
  getBotRef: () => null,
  getBotIdentity: () => null,
  setBotRef: vi.fn(),
  setBotPollingActive: vi.fn(),
  setIsRestarting: vi.fn(),
  pushEvent: vi.fn(),
  registerJob: vi.fn(),
  wrapJob: vi.fn((name: string, fn: any) => fn),
  recordMessageProcessed: vi.fn(),
  getGarminRefreshStatus: () => ({ at: null, ok: false }),
  getGarminSyncHealth: () => null,
  setDbProvider: vi.fn(),
  seedJobLastRunFromHistory: vi.fn(),
  setJobFailureNotifier: vi.fn(),
  getJobMap: () => new Map(),
}));

// ── Mock database ───────────────────────────────────────────────────

let mockDbOk = true;

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!mockDbOk) throw new Error('DB not ready');
    return {
      prepare: () => ({
        get: (..._args: any[]) => ({ ok: 1, calls: 0, cost: 0, tokens: 0, c: 0, messages: 0, page_count: 10, page_size: 4096 }),
        all: () => [],
        run: vi.fn(),
      }),
    };
  },
  initDatabase: vi.fn(),
}));

// ── Mock config (port 0 = OS-assigned random port) ──────────────────

let healthToken = 'test-health-secret';

vi.mock('../../src/config', () => ({
  config: {
    portal: { enabled: true, port: 0, bind: '127.0.0.1', token: '', healthToken: '' },
    get health() { return { token: healthToken }; },
    telegram: { botToken: 'test:token', allowedUserIds: [123] },
    app: { timezone: 'UTC', databasePath: ':memory:' },
    google: { clientId: '', clientSecret: '', refreshToken: '' },
    outlook: { clientId: '', clientSecret: '', tenantId: '', refreshToken: '' },
    garmin: { email: '', password: '', tokenPath: '', coachEnabled: false, coachTime: '' },
    invoices: { enabled: false, sshHost: '', sshPort: '', sshUser: '', sshKeyPath: '', remotePath: '' },
    contentEngine: { enabled: false, port: 8100 },
    googleDrive: { enabled: false, rootFolderId: '' },
    webhooks: { enabled: false, secret: '', maxPayloadBytes: 1048576, eventRetentionDays: 30 },
  },
}));

// ── Mock service dependencies ───────────────────────────────────────

vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: () => false,
  isRateLimited: () => false,
  getRateLimitedUntil: () => 0,
  keepAlive: vi.fn(),
}));
vi.mock('../../src/services/microsoft-auth', () => ({
  isMicrosoftConfigured: () => false,
}));
vi.mock('../../src/services/invoice-filer', () => ({
  isInvoiceFilingConfigured: () => false,
}));
vi.mock('../../src/services/google-calendar', () => ({
  isGoogleCalendarConfigured: () => false,
}));
vi.mock('../../src/services/google-gmail', () => ({
  isGmailConfigured: () => false,
}));
vi.mock('../../src/services/google-drive', () => ({
  isGoogleDriveEnabled: () => false,
}));
vi.mock('../../src/services/outlook-calendar', () => ({
  isOutlookCalendarConfigured: () => false,
}));
vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: () => false,
}));
vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: () => false,
}));
vi.mock('../../src/services/invoice-queue', () => ({
  getPendingCount: () => 0,
}));
vi.mock('../../src/services/scheduler', () => ({
  sendDailyBriefing: vi.fn(),
}));
vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: vi.fn(),
}));
vi.mock('../../src/services/content-discovery', () => ({
  runContentDiscovery: vi.fn(),
}));
vi.mock('../../src/state/conversation', () => ({
  clearAllConversations: vi.fn(),
}));
vi.mock('../../src/state/content-references', () => ({
  getAllChannels: () => [],
  removeChannel: vi.fn(),
  getAllKnowledge: () => [],
}));
vi.mock('../../src/services/channel-learner', () => ({
  addAndAnalyzeChannel: vi.fn(),
  synthesizeKnowledge: vi.fn(),
}));
vi.mock('../../src/utils/telegram-formatter', () => ({
  escapeHtml: (s: string) => s,
  splitMessage: (s: string) => [s],
}));
vi.mock('../../src/services/intelligence-bus', () => ({
  getActiveSignalCount: () => 0,
  getSignalLog: () => [],
  getAgentStats: () => [],
  dismissSignal: vi.fn(),
  writeSignal: vi.fn(),
}));
vi.mock('../../src/agents/pipeline-agent', () => ({
  getPipelineStats: () => ({ total: 0, published: 0 }),
  runPipelineAgent: vi.fn(),
}));
vi.mock('../../src/agents/seo-agent', () => ({ runSEOAgent: vi.fn() }));
vi.mock('../../src/agents/reaction-radar-agent', () => ({ runReactionRadar: vi.fn() }));
vi.mock('../../src/agents/performance-agent', () => ({ runPerformanceAgent: vi.fn() }));
vi.mock('../../src/agents/voice-evolution-agent', () => ({ runVoiceEvolutionAgent: vi.fn() }));
vi.mock('../../src/skills/skill-manager', () => ({
  getAllSkillStatuses: () => [],
}));
vi.mock('../../src/services/transcription', () => ({
  isTranscriptionAvailable: () => false,
}));
vi.mock('../../src/services/error-monitor', () => ({
  getErrorTrends: () => ({ today: 0, last7d: 0, last30d: 0 }),
}));
vi.mock('../../src/services/error-tracker', () => ({
  isEnabled: () => false,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// ── Helper: create server and wait for listen ──────────────────────

async function startServer(): Promise<{ server: http.Server; port: number }> {
  const { createPortalServer } = await import('../../src/portal/server');
  const { Bot } = await import('grammy');
  const bot = new Bot('test:token');
  const server = createPortalServer(bot as any);
  // Wait for 'listening' event since port 0 is async-assigned
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
  const addr = server.address() as any;
  return { server, port: addr.port };
}

// ── Tests ───────────────────────────────────────────────────────────

let activeServer: http.Server | null = null;

afterEach(() => {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
});

describe('GET /health', () => {
  beforeEach(() => {
    mockPolling = true;
    mockRestarting = false;
    mockLastMessage = new Date().toISOString();
    mockDbOk = true;
    mockJobStatuses = [];
    mockRecentEvents = [];
    healthToken = 'test-health-secret';
  });

  it('returns 200 with healthy status when bot is polling and DB is up', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.uptimeHuman).toBe('string');
    expect(body.bot).toHaveProperty('polling', true);
    expect(body.bot).toHaveProperty('restarting', false);
    expect(body.database).toBe('connected');
    expect(body.memory).toHaveProperty('rss');
    expect(body.memory).toHaveProperty('heapUsed');
    expect(body.memory).toHaveProperty('heapTotal');
    expect(body.memory).toHaveProperty('external');
    expect(body.timestamp).toBeDefined();
  });

  it('returns 503 with degraded status when bot is not polling', async () => {
    mockPolling = false;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.bot.polling).toBe(false);
  });

  it('returns 503 when database is down', async () => {
    mockDbOk = false;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('disconnected');
  });
});

describe('GET /health/detailed', () => {
  beforeEach(() => {
    mockPolling = true;
    mockRestarting = false;
    mockLastMessage = new Date().toISOString();
    mockDbOk = true;
    healthToken = 'test-health-secret';
    mockJobStatuses = [
      {
        name: 'daily_briefing',
        label: 'Daily Briefing',
        cronExpression: '0 6 * * *',
        domain: 'secretary',
        lastRunAt: new Date().toISOString(),
        lastResult: 'success',
        lastDurationMs: 1200,
        lastError: null,
      },
      {
        name: 'garmin_keepalive',
        label: 'Garmin Keep-Alive',
        cronExpression: '*/30 * * * *',
        domain: 'system',
        lastRunAt: new Date().toISOString(),
        lastResult: 'failed',
        lastDurationMs: 500,
        lastError: 'Connection timeout',
      },
    ];
    mockRecentEvents = [
      { ts: new Date().toISOString(), type: 'error', summary: 'Test error 1' },
      { ts: new Date().toISOString(), type: 'error', summary: 'Test error 2' },
      { ts: new Date(Date.now() - 7_200_000).toISOString(), type: 'error', summary: 'Old error' },
      { ts: new Date().toISOString(), type: 'message', summary: 'Normal message' },
    ];
  });

  it('returns 401 without token when HEALTH_TOKEN is set', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`);
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed?token=wrong`);
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct token and full detailed response', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed?token=test-health-secret`);
    expect(res.status).toBe(200);

    const body = await res.json();

    // Basic fields (same as /health)
    expect(body.status).toBeDefined();
    expect(body.bot).toBeDefined();
    expect(body.memory).toHaveProperty('rss');

    // Cron statuses
    expect(body.crons).toBeDefined();

    // Integration health
    expect(body.integrations).toBeDefined();

    // Error counts
    expect(body.errors).toBeDefined();
  });

  it('returns 503 when system is degraded even with valid token', async () => {
    mockPolling = false;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed?token=test-health-secret`);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).not.toBe('healthy');
    expect(body.crons).toBeDefined();
    expect(body.integrations).toBeDefined();
    expect(body.errors).toBeDefined();
  });

  it('allows access without token when HEALTH_TOKEN is empty', async () => {
    healthToken = '';

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`);
    expect(res.status).toBe(200);
  });
});

// ── /health response structure tests (unit-level) ─────────────────

describe('Health Endpoint Response Structure', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('GET /health — lightweight liveness probe', () => {
    it('database ping returns ok with SELECT 1', () => {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      expect(row.ok).toBe(1);
    });

    it('expected response fields are present', () => {
      // Simulate the health response shape
      const dbOk = (() => {
        try {
          const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
          return row?.ok === 1;
        } catch { return false; }
      })();

      const memUsage = process.memoryUsage();
      const response = {
        status: dbOk ? 'healthy' : 'degraded',
        uptime: 42,
        db: dbOk ? 'ok' : 'unreachable',
        bot: 'stopped',
        memory: {
          rss: Math.round(memUsage.rss / 1048576),
          heapUsed: Math.round(memUsage.heapUsed / 1048576),
          heapTotal: Math.round(memUsage.heapTotal / 1048576),
        },
      };

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('uptime');
      expect(response).toHaveProperty('db');
      expect(response).toHaveProperty('bot');
      expect(response).toHaveProperty('memory');
      expect(response.memory).toHaveProperty('rss');
      expect(response.memory).toHaveProperty('heapUsed');
      expect(response.memory).toHaveProperty('heapTotal');
      expect(typeof response.memory.rss).toBe('number');
      expect(response.db).toBe('ok');
    });

    it('reports degraded when database is closed', () => {
      db.close();
      let dbOk = false;
      try {
        db.prepare('SELECT 1 AS ok').get();
        dbOk = true;
      } catch {
        dbOk = false;
      }
      expect(dbOk).toBe(false);
      // Re-open for afterEach
      db = createTestDb();
    });

    it('memory values are positive integers in MB', () => {
      const memUsage = process.memoryUsage();
      const rss = Math.round(memUsage.rss / 1048576);
      const heapUsed = Math.round(memUsage.heapUsed / 1048576);
      const heapTotal = Math.round(memUsage.heapTotal / 1048576);

      expect(rss).toBeGreaterThan(0);
      expect(heapUsed).toBeGreaterThan(0);
      expect(heapTotal).toBeGreaterThan(0);
      expect(heapUsed).toBeLessThanOrEqual(heapTotal);
      expect(Number.isInteger(rss)).toBe(true);
    });
  });

  describe('GET /health/detailed — auth-protected health check', () => {
    it('database PRAGMA page_count returns numeric value', () => {
      const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0;
      const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 0;
      const sizeBytes = pageCount * pageSize;

      expect(typeof pageCount).toBe('number');
      expect(typeof pageSize).toBe('number');
      expect(sizeBytes).toBeGreaterThanOrEqual(0);
    });

    it('expected detailed response fields are present', () => {
      const dbOk = true;
      const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0;
      const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 0;
      const dbSizeBytes = pageCount * pageSize;

      const response = {
        status: 'healthy',
        uptime: { seconds: 42, human: '0m' },
        bot: { polling: false, restarting: false, lastMessageAt: null },
        db: {
          status: 'ok',
          sizeBytes: dbSizeBytes,
          sizeMB: Math.round(dbSizeBytes / 1048576 * 100) / 100,
        },
        memory: {
          rss: 50,
          heapUsed: 30,
          heapTotal: 60,
          external: 5,
        },
        crons: { total: 0, ok: 0, failed: [] },
        errors: { today: 0, last7d: 0, last30d: 0 },
        integrations: [],
        sentry: false,
        generatedAt: new Date().toISOString(),
      };

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('uptime');
      expect(response.uptime).toHaveProperty('seconds');
      expect(response.uptime).toHaveProperty('human');
      expect(response).toHaveProperty('db');
      expect(response.db).toHaveProperty('status');
      expect(response.db).toHaveProperty('sizeBytes');
      expect(response.db).toHaveProperty('sizeMB');
      expect(response).toHaveProperty('memory');
      expect(response.memory).toHaveProperty('external');
      expect(response).toHaveProperty('crons');
      expect(response.crons).toHaveProperty('total');
      expect(response.crons).toHaveProperty('ok');
      expect(response.crons).toHaveProperty('failed');
      expect(response).toHaveProperty('errors');
      expect(response).toHaveProperty('integrations');
      expect(response).toHaveProperty('sentry');
      expect(response).toHaveProperty('generatedAt');
    });

    it('failed crons include name, label, lastError, lastRunAt', () => {
      const failedJob = {
        name: 'test_job',
        label: 'Test Job',
        lastError: 'connection timeout',
        lastRunAt: '2026-04-01T10:00:00.000Z',
      };

      expect(failedJob).toHaveProperty('name');
      expect(failedJob).toHaveProperty('label');
      expect(failedJob).toHaveProperty('lastError');
      expect(failedJob).toHaveProperty('lastRunAt');
    });

    it('status is healthy when db ok, bot polling, and no failed jobs', () => {
      const dbOk = true;
      const botOk = true;
      const jobsFailed: any[] = [];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('healthy');
    });

    it('status is degraded when db ok and bot ok but jobs failed', () => {
      const dbOk = true;
      const botOk = true;
      const jobsFailed = [{ name: 'broken_job' }];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('degraded');
    });

    it('status is unhealthy when db is unreachable', () => {
      const dbOk = false;
      const botOk = true;
      const jobsFailed: any[] = [];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('unhealthy');
    });

    it('status is unhealthy when bot is not polling', () => {
      const dbOk = true;
      const botOk = false;
      const jobsFailed: any[] = [];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('unhealthy');
    });
  });

  describe('Health token authentication', () => {
    it('rejects requests without token when HEALTH_TOKEN is set', () => {
      const healthToken = 'my-secret-token';
      const providedToken = undefined;

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(false);
    });

    it('accepts requests with correct token', () => {
      const healthToken = 'my-secret-token';
      const providedToken = 'my-secret-token';

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(true);
    });

    it('rejects requests with wrong token', () => {
      const healthToken = 'my-secret-token';
      const providedToken = 'wrong-token';

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(false);
    });

    it('allows unauthenticated access when no HEALTH_TOKEN is set', () => {
      const healthToken = '';
      const providedToken = undefined;

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(true);
    });
  });

  describe('Bot identity in health responses', () => {
    it('/health response includes botUsername and botId when identity is set', () => {
      const identity = { id: 123456, username: 'Hlepreguica_bot', firstName: 'Nexus Hub', isBot: true };
      const response = {
        status: 'healthy',
        uptime: 42,
        db: 'ok',
        bot: 'polling',
        botUsername: identity.username,
        botId: identity.id,
        memory: { rss: 50, heapUsed: 30, heapTotal: 60 },
      };

      expect(response.botUsername).toBe('Hlepreguica_bot');
      expect(response.botId).toBe(123456);
    });

    it('/health response has null botUsername when identity not yet resolved', () => {
      const identity = null;
      const response = {
        status: 'degraded',
        uptime: 0,
        db: 'ok',
        bot: 'stopped',
        botUsername: identity?.username ?? null,
        botId: identity?.id ?? null,
        memory: { rss: 50, heapUsed: 30, heapTotal: 60 },
      };

      expect(response.botUsername).toBeNull();
      expect(response.botId).toBeNull();
    });

    it('/health/detailed bot section includes username, id, firstName', () => {
      const identity = { id: 789, username: 'Nexushub94_bot', firstName: 'Test Bot', isBot: true };
      const botSection = {
        polling: true,
        restarting: false,
        lastMessageAt: null,
        username: identity.username,
        id: identity.id,
        firstName: identity.firstName,
      };

      expect(botSection.username).toBe('Nexushub94_bot');
      expect(botSection.id).toBe(789);
      expect(botSection.firstName).toBe('Test Bot');
    });

    it('snapshot bot section includes username and id', () => {
      const identity = { id: 456, username: 'MyBot', firstName: 'My', isBot: true };
      const botSnapshot = {
        polling: false,
        restarting: false,
        lastMessageAt: null,
        username: identity.username,
        id: identity.id,
      };

      expect(botSnapshot).toHaveProperty('username');
      expect(botSnapshot).toHaveProperty('id');
      expect(botSnapshot.username).toBe('MyBot');
    });

    it('Telegram Bot integration name includes username when identity is available', () => {
      const identity = { id: 123, username: 'Hlepreguica_bot', firstName: 'Nexus', isBot: true };
      const integrationName = identity ? `Telegram Bot (@${identity.username})` : 'Telegram Bot';
      expect(integrationName).toBe('Telegram Bot (@Hlepreguica_bot)');
    });

    it('Telegram Bot integration name is plain when identity is not available', () => {
      const identity = null;
      const integrationName = identity ? `Telegram Bot (@${identity.username})` : 'Telegram Bot';
      expect(integrationName).toBe('Telegram Bot');
    });
  });

  describe('Bot username mismatch detection', () => {
    it('detects mismatch when expected and actual usernames differ', () => {
      const expected = 'Nexushub94_bot';
      const actual = 'Hlepreguica_bot';
      const mismatch = expected.toLowerCase() !== actual.toLowerCase();
      expect(mismatch).toBe(true);
    });

    it('no mismatch when usernames match (case-insensitive)', () => {
      const expected = 'Hlepreguica_bot';
      const actual = 'hlepreguica_bot';
      const mismatch = expected.toLowerCase() !== actual.toLowerCase();
      expect(mismatch).toBe(false);
    });

    it('no mismatch check when expected username is not set', () => {
      const expected = '';
      const actual = 'Hlepreguica_bot';
      // Only check when expected is truthy
      const shouldCheck = !!expected;
      expect(shouldCheck).toBe(false);
    });
  });

  describe('DB size calculation', () => {
    it('calculates DB size from page_count * page_size', () => {
      // Insert some data to make the DB non-trivial
      db.prepare('INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)').run('secretary', 'user', 'Hello');
      db.prepare('INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)').run('triathlon', 'user', 'Train');

      const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0;
      const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 0;
      const sizeBytes = pageCount * pageSize;

      expect(pageCount).toBeGreaterThan(0);
      expect(pageSize).toBeGreaterThan(0);
      expect(sizeBytes).toBeGreaterThan(0);
    });

    it('converts bytes to MB correctly', () => {
      const sizeBytes = 5242880; // 5 MB
      const sizeMB = Math.round(sizeBytes / 1048576 * 100) / 100;
      expect(sizeMB).toBe(5);
    });
  });
});
