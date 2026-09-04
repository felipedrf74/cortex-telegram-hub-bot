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
import { config as mockedConfig } from '../../src/config';
import { mintPortalSessionToken } from '../../src/services/portal-session-mint';
import { hashPortalPassword } from '../../src/services/portal-password';

const RELEASE_SHA = 'a'.repeat(40);
const RELEASE_ARTIFACT_DIGEST = 'b'.repeat(64);
const CHAT_CAPABILITY_FLAGS = [
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
] as const;

const runtimeGuardMock = vi.hoisted(() => ({
  value: {
    status: 'clear' as 'clear' | 'authorized' | 'forced_off',
    reason: 'no_unresolved_transaction',
    transactionId: null as string | null,
    planDigest: null as string | null,
  },
}));

vi.mock('../../src/services/chat-capability-runtime-guard', () => ({
  chatCapabilityRuntimeAllowsFlags: () => runtimeGuardMock.value.status !== 'forced_off',
  getChatCapabilityRuntimeGuardStatus: () => runtimeGuardMock.value,
}));

function stubReleaseIdentity(): void {
  vi.stubEnv('NEXUS_RELEASE_ROLE', 'staging');
  vi.stubEnv('NEXUS_RELEASE_SHA', RELEASE_SHA);
  vi.stubEnv('NEXUS_RELEASE_ARTIFACT_SHA256', RELEASE_ARTIFACT_DIGEST);
}

function stubCapabilityFlags(value: 'true' | 'false'): void {
  for (const flag of CHAT_CAPABILITY_FLAGS) vi.stubEnv(flag, value);
}

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

vi.mock('../../src/services/training-route-deprecation-telemetry', () => ({
  TRAINING_SUMMARY_ROUTE_PATH: '/api/v1/training/summary',
  recordTrainingSummaryDeprecationHit: vi.fn(),
  readTrainingSummaryDeprecationUsage: vi.fn(() => ({
    routePath: '/api/v1/training/summary',
    windowDays: 30,
    requestCount: 17,
    firstHitDate: '2026-07-15',
    lastHitDate: '2026-08-02',
  })),
}));

vi.mock('../../src/services/release-info', () => ({
  getReleaseInfo: vi.fn(() => ({
    version: '4.14.999',
    gitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    gitShortSha: 'abcdef01',
    branch: 'main',
    stampPresent: true,
    migrations: { applied: 3, available: 3, latestApplied: '003.sql', pending: [], unknownApplied: [] },
    adminExposureMode: 'signed_static',
    integrations: { sentry: true, operatorAlertWebhook: true, iosApi: true, anthropic: false, ollama: false },
  })),
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
  runWithCoachBriefingAccountAdmissions: vi.fn(async (
    _userId: number,
    _options: Record<string, unknown>,
    operation: (abortSignal: AbortSignal) => Promise<unknown>,
  ) => operation(new AbortController().signal)),
  runWithCoachBriefingAccountLifecycle: vi.fn(),
}));
vi.mock('../../src/services/content-discovery', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/content-discovery')>(
    '../../src/services/content-discovery',
  )),
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
vi.mock('../../src/utils/chat-html-formatter', () => ({
  escapeHtml: (s: string) => s,
  splitMessage: (s: string) => [s],
  formatAllTasks: vi.fn(() => ''),
  formatMsTodoLists: vi.fn(() => ''),
  formatMsTodoSummary: vi.fn(() => ''),
  formatMsTodoTasks: vi.fn(() => ''),
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
let resetManifestPromptRuntimeOverride: (() => void) | null = null;

afterEach(() => {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
  resetManifestPromptRuntimeOverride?.();
  resetManifestPromptRuntimeOverride = null;
  vi.unstubAllEnvs();
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
    // Release identity (build stamp) is surfaced so monitors can pin a deploy.
    expect(body.version).toBe('4.14.999');
    expect(body.gitShortSha).toBe('abcdef01');
    expect(body).not.toHaveProperty('release');
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
    runtimeGuardMock.value = {
      status: 'clear',
      reason: 'no_unresolved_transaction',
      transactionId: null,
      planDigest: null,
    };
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
      {
        name: 'seo_agent',
        label: 'SEO Tracking',
        cronExpression: '0 6 * * 1',
        domain: 'content',
        lastRunAt: new Date().toISOString(),
        lastResult: 'success',
        lastDurationMs: 750,
        lastError: 'historical detail must not imply an active run',
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
    expect(body.crons.length).toBe(3);
    expect(body.crons[0]).toHaveProperty('name', 'daily_briefing');
    expect(body.crons[0]).toHaveProperty('lastResult', 'success');
    expect(body.crons[1]).toHaveProperty('name', 'garmin_keepalive');
    expect(body.crons[1]).toHaveProperty('lastError', 'Connection timeout');
    expect(body.crons[2]).toMatchObject({
      name: 'seo_agent',
      lifecycle: 'paused',
      lastRunAt: null,
      lastResult: 'paused',
      lastDurationMs: null,
      lastError: null,
    });

    // Integration health
    expect(body.integrations).toBeDefined();
    expect(Array.isArray(body.integrations)).toBe(true);
    expect(body.integrations.length).toBeGreaterThan(0);
    expect(body.integrations[0]).toHaveProperty('name');
    expect(body.integrations[0]).toHaveProperty('configured');
    expect(body.integrations[0]).toHaveProperty('tokenHealth');

    // Release identity + migration state
    expect(body.release).toMatchObject({
      version: '4.14.999',
      gitShortSha: 'abcdef01',
      adminExposureMode: 'signed_static',
      migrations: { applied: 3, pending: [] },
    });

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

    // F37 stronger guarantee: collecting aggregate deprecation evidence is
    // insufficient unless an authenticated operator can actually review it.
    expect(body.deprecations).toEqual({
      trainingSummary: {
        routePath: '/api/v1/training/summary',
        windowDays: 30,
        requestCount: 17,
        firstHitDate: '2026-07-15',
        lastHitDate: '2026-08-02',
      },
    });
  });

  it('attests the exact deployed release and configured versus effective chat flags', async () => {
    stubReleaseIdentity();
    stubCapabilityFlags('false');
    vi.stubEnv('AI_ROUTING_MANIFEST_CLASSIFIER', 'true');
    vi.stubEnv('AI_ROUTING_MANIFEST_SHADOW', 'true');
    vi.stubEnv('AI_ROUTING_CLARIFY', 'true');
    vi.stubEnv('AI_CLASSIFY_MANIFEST_PROMPT', 'true');
    vi.stubEnv('AI_CROSS_SKILL_EXECUTION', 'true');
    vi.stubEnv('AI_ROUTING_MANIFEST_KILL', 'false');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_PLANNER_ENABLED', 'false');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_1000014', 'true');
    vi.stubEnv('CHAT_EVAL_DEDICATED_TENANT_ID', '424242');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_424242', 'on');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED', 'false');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_424242', 'true');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_TENANT_424242', 'shadow');
    const manifestPrompt = await import('../../src/router/classifier-prompt-builder');
    manifestPrompt.forceDisableManifestClassifierPromptForProcess();
    resetManifestPromptRuntimeOverride =
      manifestPrompt._resetManifestClassifierPromptRuntimeOverrideForTests;

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, {
      headers: { Authorization: 'Bearer test-health-secret' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.releaseAttestation).toEqual({
      schema: 'nexus.chat-capability-release-attestation.v2',
      runtimeSha: RELEASE_SHA,
      artifactDigest: RELEASE_ARTIFACT_DIGEST,
      role: 'staging',
      processId: process.pid,
      classifierPromptRuntimeForceDisabled: true,
      capabilityRuntimeGuard: {
        status: 'clear',
        reason: 'no_unresolved_transaction',
        transactionId: null,
        planDigest: null,
      },
      shadowPlannerEffective: {
        global: false,
        user1000014: true,
        tenant1000014: false,
        user1000016: false,
        tenant1000016: false,
        dedicatedEval: {
          present: true,
          user: false,
          tenant: true,
        },
      },
      shadowRouteHookEffective: {
        global: false,
        dedicatedEval: {
          present: true,
          user: true,
          tenant: true,
        },
      },
      capabilityFlags: {
        configured: {
          AI_ROUTING_MANIFEST_CLASSIFIER: true,
          AI_ROUTING_MANIFEST_ORCHESTRATOR: false,
          AI_ROUTING_MANIFEST_SHADOW: true,
          AI_ROUTING_MANIFEST_REGISTRY: false,
          AI_ROUTING_CLARIFY: true,
          AI_CLASSIFY_MANIFEST_PROMPT: true,
          AI_CROSS_SKILL_EXECUTION: true,
        },
        effective: {
          AI_ROUTING_MANIFEST_CLASSIFIER: true,
          AI_ROUTING_MANIFEST_ORCHESTRATOR: false,
          AI_ROUTING_MANIFEST_SHADOW: true,
          AI_ROUTING_MANIFEST_REGISTRY: false,
          AI_ROUTING_CLARIFY: true,
          // The boot-time safety guard wins over the configured value.
          AI_CLASSIFY_MANIFEST_PROMPT: false,
          AI_CROSS_SKILL_EXECUTION: true,
        },
        masterKill: false,
      },
    });
    expect(Object.keys(body.releaseAttestation).sort()).toEqual([
      'artifactDigest',
      'capabilityFlags',
      'capabilityRuntimeGuard',
      'classifierPromptRuntimeForceDisabled',
      'processId',
      'role',
      'runtimeSha',
      'schema',
      'shadowPlannerEffective',
      'shadowRouteHookEffective',
    ]);
    expect(Object.keys(body.releaseAttestation.capabilityFlags.configured).sort())
      .toEqual([...CHAT_CAPABILITY_FLAGS].sort());
    expect(Object.keys(body.releaseAttestation.capabilityFlags.effective).sort())
      .toEqual([...CHAT_CAPABILITY_FLAGS].sort());
    expect(JSON.stringify(body.releaseAttestation)).not.toContain('424242');
  });

  it('attests master-kill suppression without exposing deployment secrets', async () => {
    stubReleaseIdentity();
    stubCapabilityFlags('true');
    vi.stubEnv('AI_ROUTING_MANIFEST_KILL', 'true');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED', 'false');
    vi.stubEnv('CLASSIFY_SHADOW_HASH_SECRET', 'classify-shadow-secret-must-not-leak');
    vi.stubEnv('CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET', 'chat-shadow-secret-must-not-leak');
    vi.stubEnv('IOS_API_JWT_SECRET', 'jwt-secret-must-not-leak');

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, {
      headers: { Authorization: 'Bearer test-health-secret' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.releaseAttestation).toEqual({
      schema: 'nexus.chat-capability-release-attestation.v2',
      runtimeSha: RELEASE_SHA,
      artifactDigest: RELEASE_ARTIFACT_DIGEST,
      role: 'staging',
      processId: process.pid,
      classifierPromptRuntimeForceDisabled: false,
      capabilityRuntimeGuard: {
        status: 'clear',
        reason: 'no_unresolved_transaction',
        transactionId: null,
        planDigest: null,
      },
      shadowPlannerEffective: {
        global: false,
        user1000014: false,
        tenant1000014: false,
        user1000016: false,
        tenant1000016: false,
        dedicatedEval: {
          present: false,
          user: null,
          tenant: null,
        },
      },
      shadowRouteHookEffective: {
        global: false,
        dedicatedEval: {
          present: false,
          user: null,
          tenant: null,
        },
      },
      capabilityFlags: {
        configured: Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [flag, true])),
        effective: Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [flag, false])),
        masterKill: true,
      },
    });

    const serialized = JSON.stringify(body.releaseAttestation);
    expect(serialized).not.toContain('classify-shadow-secret-must-not-leak');
    expect(serialized).not.toContain('chat-shadow-secret-must-not-leak');
    expect(serialized).not.toContain('jwt-secret-must-not-leak');
    expect(serialized).not.toMatch(/(?:HASH_SECRET|HMAC_SECRET|JWT_SECRET|TOKEN|PASSWORD|API_KEY)/i);
  });

  it('attests configured flags but forces every effective flag off for an unresolved dead transaction', async () => {
    stubReleaseIdentity();
    stubCapabilityFlags('true');
    vi.stubEnv('AI_ROUTING_MANIFEST_KILL', 'false');
    runtimeGuardMock.value = {
      status: 'forced_off',
      reason: 'runtime_permit_controller_not_live',
      transactionId: '20260802T010203Z-abcdef123456',
      planDigest: null,
    };

    const { server, port } = await startServer();
    activeServer = server;
    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, {
      headers: { Authorization: 'Bearer test-health-secret' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.releaseAttestation.capabilityRuntimeGuard).toEqual(runtimeGuardMock.value);
    expect(body.releaseAttestation.capabilityFlags.configured)
      .toEqual(Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [flag, true])));
    expect(body.releaseAttestation.capabilityFlags.effective)
      .toEqual(Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [flag, false])));
  });

  it('fails closed instead of attesting malformed deployed release identity', async () => {
    stubCapabilityFlags('false');
    vi.stubEnv('AI_ROUTING_MANIFEST_KILL', 'false');
    vi.stubEnv('NEXUS_RELEASE_ROLE', 'staging');
    vi.stubEnv('NEXUS_RELEASE_SHA', 'not-a-full-runtime-sha');
    vi.stubEnv('NEXUS_RELEASE_ARTIFACT_SHA256', 'not-a-full-artifact-digest');

    const { server, port } = await startServer();
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/health/detailed`, {
      headers: { Authorization: 'Bearer test-health-secret' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.releaseAttestation).toBeNull();
    expect(JSON.stringify(body)).not.toContain('not-a-full-runtime-sha');
    expect(JSON.stringify(body)).not.toContain('not-a-full-artifact-digest');
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
    const rawBody = await res.text();
    expect(res.status, rawBody).toBe(503);
    const body = JSON.parse(rawBody);
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

// ── Cookie sign-in through the real middleware chain ─────────────────
//
// The generic portal guard is mounted on /api before the route modules. The
// sign-in POST carries its credential in the body, so when the guard ran
// first it answered 401 and no cookie session could ever be created in
// session-only deployments (production, 2026-09-04). This boots the real
// server and signs in exactly like the SPA does.
describe('POST /api/auth/session through createPortalServer()', () => {
  const SESSION_SECRET = 'portal.session.secret.for.the.middleware.order.test.0123456789abcdef';
  let previousPortal: Record<string, unknown>;

  beforeEach(() => {
    stubReleaseIdentity();
    stubCapabilityFlags('true');
    previousPortal = { ...(mockedConfig.portal as Record<string, unknown>) };
    Object.assign(mockedConfig.portal as Record<string, unknown>, {
      token: '', readToken: '', writeToken: '', adminToken: '',
      sessionSecret: SESSION_SECRET, sessionMaxAgeMs: 28_800_000, requireSessionAuth: true,
      adminRequireActor: false, adminActorAllowlist: [], adminActorSignatureSecret: '', adminActorSignatureToleranceMs: 300_000,
      allowLegacyFallback: false, allowLocalBypass: false, betaHardened: false, operatorUserScopes: {},
    });
  });

  afterEach(() => {
    const portal = mockedConfig.portal as Record<string, unknown>;
    for (const key of Object.keys(portal)) delete portal[key];
    Object.assign(portal, previousPortal);
  });

  it('adopts a body-only ps_ token as a cookie session and resumes it from the cookie', async () => {
    const { server, port } = await startServer();
    activeServer = server;
    const minted = mintPortalSessionToken({ secret: SESSION_SECRET, actorHint: 'operator@example.test', scope: 'admin', ttlMs: 600_000, maxAgeMs: 28_800_000 });

    const signIn = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: minted.token }),
    });
    expect(signIn.status).toBe(200);
    const body = await signIn.json() as { ok: boolean; scope: string; actor: string; csrf: string };
    expect(body).toMatchObject({ ok: true, scope: 'admin', actor: 'operator@example.test' });
    expect(body.csrf).toBeTruthy();
    const cookie = signIn.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('portal_session=');
    expect(cookie).toContain('HttpOnly');

    const resume = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      headers: { Cookie: cookie.split(';')[0] },
    });
    expect(resume.status).toBe(200);
    expect(await resume.json()).toMatchObject({ ok: true, scope: 'admin' });

    // Everything else under /api stays behind the guard.
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/users`);
    expect(unauthenticated.status).toBe(401);
  });

  it('signs the configured operator in with a username and password through the real chain', async () => {
    const PASSWORD = 'operator password for the e2e test 42';
    Object.assign(mockedConfig.portal as Record<string, unknown>, {
      operatorUsername: 'operator@example.test',
      operatorPasswordHash: hashPortalPassword(PASSWORD, { N: 1024 }),
      operatorActor: '',
      operatorScope: 'admin',
    });
    const { server, port } = await startServer();
    activeServer = server;

    const methods = await fetch(`http://127.0.0.1:${port}/api/auth/session/methods`);
    expect(await methods.json()).toEqual({ ok: true, token: true, password: true });

    const signIn = await fetch(`http://127.0.0.1:${port}/api/auth/session/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'operator@example.test', password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ ok: true, method: 'password', scope: 'admin', actor: 'operator@example.test' });
    const cookie = signIn.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('portal_session=');

    const resume = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: { Cookie: cookie.split(';')[0] } });
    expect(resume.status).toBe(200);

    const wrong = await fetch(`http://127.0.0.1:${port}/api/auth/session/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'operator@example.test', password: 'not the password at all' }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('still rejects a sign-in that presents no valid session token', async () => {
    const { server, port } = await startServer();
    activeServer = server;
    const rejected = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not.a.session.token' }),
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('set-cookie')).toBeNull();
  });
});
