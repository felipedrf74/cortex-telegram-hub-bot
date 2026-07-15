/**
 * Health Endpoint Tests
 *
 * Validates:
 * - GET /health — public, returns status/uptime/bot/db/memory
 * - GET /health/detailed — auth-protected via ?token=HEALTH_TOKEN
 * - /health/detailed includes cron statuses, integration health, error counts
 * - Correct HTTP status codes (200 healthy, 503 degraded, 401 unauthorized)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

// ── Mock telemetry ──────────────────────────────────────────────────

let mockPolling = true;
let mockRestarting = false;
let mockLastMessage: string | null = new Date().toISOString();
let mockJobStatuses: any[] = [];
let mockRecentEvents: any[] = [];
let mockCacheStats = {
  initCalls: 2,
  initFailures: 0,
  readCount: 11,
  swrReadCount: 4,
  hitCount: 9,
  missCount: 2,
  staleHitCount: 1,
  writeCount: 5,
  clearCount: 3,
  clearByPrefixCount: 4,
  expireSweepCount: 1,
  expiredEntriesCleared: 7,
  readErrors: 0,
  writeErrors: 0,
  parseErrors: 0,
  lastErrorAt: null,
  lastErrorOperation: null,
  lastErrorKey: null,
};
let mockDashboardCacheInvalidationStats = {
  requestCount: 6,
  userScopedRequestCount: 5,
  globalRequestCount: 1,
  clearCountRequested: 5,
  clearByPrefixCountRequested: 11,
  lastInvalidatedAt: '2026-04-22T11:00:00.000Z',
  lastUserId: 42,
};

vi.mock('../../src/portal/telemetry', () => ({
  isBotPollingActive: () => mockPolling,
  isRestarting: () => mockRestarting,
  getLastMessageAt: () => mockLastMessage,
  getJobStatuses: () => mockJobStatuses,
  getRecentEvents: () => mockRecentEvents,
  getBotRef: () => null,
  setBotRef: vi.fn(),
  setBotPollingActive: vi.fn(),
  setIsRestarting: vi.fn(),
  pushEvent: vi.fn(),
  registerJob: vi.fn(),
  wrapJob: vi.fn((name: string, fn: any) => fn),
  recordMessageProcessed: vi.fn(),
  getGarminRefreshStatus: () => ({ at: null, ok: false }),
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
        get: (..._args: any[]) => ({ ok: 1, calls: 0, cost: 0, tokens: 0, c: 0, messages: 0 }),
        all: () => [],
        run: vi.fn(),
      }),
    };
  },
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

vi.mock('../../src/services/cache-store', () => ({
  initCacheStore: vi.fn(),
  clearExpired: vi.fn(),
  getCacheStoreStats: () => mockCacheStats,
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
  getDashboardCacheInvalidationStats: () => mockDashboardCacheInvalidationStats,
}));

vi.mock('../../src/services/pm2-health', () => ({
  getPm2SupervisorHealth: vi.fn(async () => ({
    available: true,
    processes: [{
      name: 'nexus-hub',
      pmId: 0,
      status: 'online',
      restartCount: 0,
      unstableRestarts: 0,
      uptimeMs: 120_000,
      lastCrashReason: null,
    }],
  })),
  recordPm2SupervisorAlerts: vi.fn(() => 0),
}));

// ── Mock config (port 0 = OS-assigned random port) ──────────────────

let healthToken = 'test-health-secret';
let allowUnauthenticatedDetailed = false;

vi.mock('../../src/config', () => ({
  config: {
    portal: { enabled: true, port: 0, bind: '127.0.0.1', token: '' },
    get health() { return { token: healthToken, allowUnauthenticatedDetailed }; },
    telegram: { botToken: 'test:token', allowedUserIds: [123] },
    app: { timezone: 'UTC', databasePath: ':memory:' },
    webhooks: { enabled: false, secret: '', maxPayloadBytes: 1048576, eventRetentionDays: 30 },
    financeEncryption: { enabled: false, masterKey: '' },
    google: { clientId: '', clientSecret: '', refreshToken: '' },
    outlook: { clientId: '', clientSecret: '', tenantId: '', refreshToken: '' },
    garmin: { email: '', password: '', tokenPath: '', coachEnabled: false, coachTime: '' },
    invoices: { enabled: false, sshHost: '', sshPort: '', sshUser: '', sshKeyPath: '', remotePath: '' },
    contentEngine: { enabled: false, port: 8100 },
    googleDrive: { enabled: false, rootFolderId: '' },
  },
}));

// ── Mock service dependencies ───────────────────────────────────────

vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: () => false,
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
  writeGovernedSignal: vi.fn(() => 1),
}));
vi.mock('../../src/agents/pipeline-agent', () => ({
  getPipelineStats: () => ({ total: 0, published: 0 }),
  runPipelineAgent: vi.fn(),
}));
vi.mock('../../src/agents/seo-agent', () => ({ runSEOAgent: vi.fn() }));
vi.mock('../../src/agents/reaction-radar-agent', () => ({ runReactionRadar: vi.fn() }));
vi.mock('../../src/agents/performance-agent', () => ({ runPerformanceAgent: vi.fn() }));
vi.mock('../../src/agents/voice-evolution-agent', () => ({
  runVoiceEvolutionAgent: vi.fn(),
  runScheduledVoiceEvolutionAgent: vi.fn(),
}));
vi.mock('../../src/skills/skill-manager', () => ({
  getAllSkillStatuses: () => [],
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

// ── Helper: create server and wait for listen ──────────────────────

async function startServer(): Promise<{ server: http.Server; port: number }> {
  const { createPortalServer } = await import('../../src/portal/server');
  const server = createPortalServer();
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
    mockCacheStats = {
      initCalls: 2,
      initFailures: 0,
      readCount: 11,
      swrReadCount: 4,
      hitCount: 9,
      missCount: 2,
      staleHitCount: 1,
      writeCount: 5,
      clearCount: 3,
      clearByPrefixCount: 4,
      expireSweepCount: 1,
      expiredEntriesCleared: 7,
      readErrors: 0,
      writeErrors: 0,
      parseErrors: 0,
      lastErrorAt: null,
      lastErrorOperation: null,
      lastErrorKey: null,
    };
    mockDashboardCacheInvalidationStats = {
      requestCount: 6,
      userScopedRequestCount: 5,
      globalRequestCount: 1,
      clearCountRequested: 5,
      clearByPrefixCountRequested: 11,
      lastInvalidatedAt: '2026-04-22T11:00:00.000Z',
      lastUserId: 42,
    };
    healthToken = 'test-health-secret';
    allowUnauthenticatedDetailed = false;
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
    expect(body.databaseProbe).toMatchObject({ status: 'connected' });
    expect(typeof body.databaseProbe.latencyMs).toBe('number');
    expect(body.memory).toHaveProperty('rss');
    expect(body.memory).toHaveProperty('heapUsed');
    expect(body.memory).toHaveProperty('heapTotal');
    expect(body.memory).toHaveProperty('external');
    expect(body.timestamp).toBeDefined();

    // The public readiness endpoint is intentionally credential-free. Keep
    // this as a response contract instead of a brittle source-substring scan.
    expect(Object.keys(body.bot).sort()).toEqual(['lastMessageAt', 'polling', 'restarting']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('test:token');
    expect(serialized).not.toContain('test-health-secret');
    expect(serialized).not.toMatch(/"(?:password|secret|token|botToken)"\s*:/i);
  });

  it('returns 200 and keeps server healthy when bot is not polling', async () => {
    mockPolling = false;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.server.status).toBe('online');
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
    expect(body.databaseProbe).toMatchObject({
      status: 'disconnected',
      errorCode: 'DB_PROBE_FAILED',
    });
  });
});

describe('GET /health/detailed', () => {
  beforeEach(() => {
    mockPolling = true;
    mockRestarting = false;
    mockLastMessage = new Date().toISOString();
    mockDbOk = true;
    healthToken = 'test-health-secret';
    allowUnauthenticatedDetailed = false;
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

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, { headers: { Authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct token and full detailed response', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, { headers: { Authorization: 'Bearer test-health-secret' } });
    expect(res.status).toBe(200);

    const body = await res.json();

    // Basic fields (same as /health)
    expect(body.status).toBe('healthy');
    expect(typeof body.uptime).toBe('number');
    expect(body.bot.polling).toBe(true);
    expect(body.database).toBe('connected');
    expect(body.databaseProbe).toMatchObject({ status: 'connected' });
    expect(body.memory).toHaveProperty('rss');

    // Cron statuses
    expect(body.crons).toBeDefined();
    expect(Array.isArray(body.crons)).toBe(true);
    expect(body.crons.length).toBe(2);
    expect(body.crons[0]).toHaveProperty('name', 'daily_briefing');
    expect(body.crons[0]).toHaveProperty('lastResult', 'success');
    expect(body.crons[1]).toHaveProperty('name', 'garmin_keepalive');
    expect(body.crons[1]).toHaveProperty('lastError', 'Connection timeout');

    // Integration health
    expect(body.integrations).toBeDefined();
    expect(Array.isArray(body.integrations)).toBe(true);
    expect(body.integrations.length).toBeGreaterThan(0);
    expect(body.integrations[0]).toHaveProperty('name');
    expect(body.integrations[0]).toHaveProperty('configured');
    expect(body.integrations[0]).toHaveProperty('tokenHealth');

    // Error counts
    expect(body.errors).toBeDefined();
    expect(body.errors.total).toBe(3); // 3 error events
    expect(body.errors.lastHour).toBe(2); // 2 within last hour

    // Cache observability
    expect(body.cache).toBeDefined();
    expect(body.cache.store).toMatchObject({
      readCount: 11,
      hitCount: 9,
      missCount: 2,
      staleHitCount: 1,
      expiredEntriesCleared: 7,
    });
    expect(body.cache.dashboardInvalidation).toMatchObject({
      requestCount: 6,
      userScopedRequestCount: 5,
      globalRequestCount: 1,
      lastUserId: 42,
    });

    expect(body.pm2).toMatchObject({
      available: true,
      alertsRecorded: 0,
      processes: [expect.objectContaining({
        name: 'nexus-hub',
        status: 'online',
        restartCount: 0,
      })],
    });
  });

  it('returns 200 when only Telegram bot polling is degraded', async () => {
    mockPolling = false;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, { headers: { Authorization: 'Bearer test-health-secret' } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.server.status).toBe('online');
    expect(body.bot.polling).toBe(false);
    expect(body.crons).toBeDefined();
    expect(body.integrations).toBeDefined();
    expect(body.errors).toBeDefined();
  });

  it('returns 503 with detailed diagnostics when the live database probe fails', async () => {
    mockDbOk = false;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, { headers: { Authorization: 'Bearer test-health-secret' } });
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.server.database).toBe('disconnected');
    expect(body.databaseProbe).toMatchObject({
      status: 'disconnected',
      errorCode: 'DB_PROBE_FAILED',
    });
    expect(body.crons).toBeDefined();
    expect(body.integrations).toBeDefined();
  });

  it('rejects access without token when HEALTH_TOKEN is empty and bypass is disabled', async () => {
    healthToken = '';

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`);
    expect(res.status).toBe(401);
  });

  it('allows loopback access without token only when explicit bypass is enabled', async () => {
    healthToken = '';
    allowUnauthenticatedDetailed = true;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`);
    expect(res.status).toBe(200);
  });
});

describe('GET /public-status', () => {
  beforeEach(() => {
    mockPolling = true;
    mockRestarting = false;
    mockLastMessage = new Date().toISOString();
    mockDbOk = true;
  });

  it('returns 200 with minimal payload when service is healthy', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/public-status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      status: 'ok',
      service: 'nexushub-api',
      timestamp: expect.any(String),
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('still returns 200 with the same payload when the database is down', async () => {
    mockDbOk = false;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/public-status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ok',
      service: 'nexushub-api',
    });
  });

  it('does not leak memory, bot internals, database state, or providers', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/public-status`);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(['service', 'status', 'timestamp']);
    expect(body).not.toHaveProperty('memory');
    expect(body).not.toHaveProperty('bot');
    expect(body).not.toHaveProperty('database');
    expect(body).not.toHaveProperty('databaseProbe');
    expect(body).not.toHaveProperty('uptime');
    expect(body).not.toHaveProperty('server');
    expect(body).not.toHaveProperty('providers');
    expect(body).not.toHaveProperty('integrations');
    expect(body).not.toHaveProperty('crons');
    expect(body).not.toHaveProperty('errors');
    expect(body).not.toHaveProperty('pm2');
    expect(body).not.toHaveProperty('cache');
    expect(body).not.toHaveProperty('sentry');
  });

  it('sets permissive cache, CORS, and robots headers for AI fetchers', async () => {
    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/public-status`);

    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-robots-tag')).toBe('all');
  });

  it('does not require authentication', async () => {
    healthToken = 'a-non-empty-token';

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/public-status`);
    expect(res.status).toBe(200);
  });
});
