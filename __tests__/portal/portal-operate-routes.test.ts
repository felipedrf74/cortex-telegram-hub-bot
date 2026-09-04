import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
  killSwitches: [] as unknown[],
  listHybridKillSwitches: vi.fn(),
  setHybridKillSwitch: vi.fn(),
  owner: { tenantId: 1 } as { tenantId: number } | null,
  replayJob: vi.fn(() => true),
  cancelJob: vi.fn(() => true),
  replayEvent: vi.fn(() => true),
  cancelEvent: vi.fn(() => true),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db,
  applyMigrationFileForTest: vi.fn(),
  closeDatabase: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn(),
  initializeDatabaseCore: vi.fn(),
  runMigrationsForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
  withReleaseMaintenanceDatabase: vi.fn(),
}));
vi.mock('../../src/api/secret-guards', () => ({
  recordPortalAuthAudit: vi.fn(),
  requirePortalAdminToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  allowLocalHealthBypass: vi.fn(),
  allowLocalPortalBypass: vi.fn(),
  bearerTokenMatches: vi.fn(),
  computePortalActorSignature: vi.fn(),
  computePortalCsrfToken: vi.fn(),
  createPortalSessionToken: vi.fn(),
  extractBearerToken: vi.fn(),
  extractPortalActorHint: vi.fn(),
  getPortalAuthContext: vi.fn(),
  isLoopbackRequest: vi.fn(),
  rejectCookieSessionCsrf: vi.fn(),
  requirePortalToken: vi.fn(),
  requirePortalTokenByMethod: vi.fn(),
  requirePortalWriteToken: vi.fn(),
  secureSecretMatches: vi.fn(),
  verifyPortalActorSignature: vi.fn(),
}));
vi.mock('../../src/portal/admin-audit', () => ({ logPortalAdminMutation: hoisted.logPortalAdminMutation,
  buildPortalAdminAuditDetails: vi.fn(),
  insertPortalAdminMutationAuditStrict: vi.fn(),
}));
vi.mock('../../src/portal/http', () => ({ sendPortalInternalError: hoisted.sendPortalInternalError }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: vi.fn(),
}));
vi.mock('../../src/services/hybrid-runtime-kill-switches', () => ({
  HYBRID_KILL_SWITCH_KEYS: ['apple_pack_fulfillment', 'storefront'],
  listHybridKillSwitches: hoisted.listHybridKillSwitches,
  setHybridKillSwitch: hoisted.setHybridKillSwitch,
  _resetHybridKillSwitchCacheForTests: vi.fn(),
  isAppleFoundationModelsActive: vi.fn(),
  isApplePackFulfillmentActive: vi.fn(),
  isHybridKillSwitchEngaged: vi.fn(),
  isStorefrontActive: vi.fn(),
  isStripePackFulfillmentActive: vi.fn(),
  isSubscriptionCheckoutActive: vi.fn(),
}));
vi.mock('../../src/services/user-service', () => ({ getOwnerBootstrapTarget: () => hoisted.owner,
  ClosedBetaInviteRequiredError: vi.fn(),
  assertClosedBetaInviteForNewUser: vi.fn(),
  assertOptionalInviteForNewUser: vi.fn(),
  assertOwnerBootstrapReadyForRuntime: vi.fn(),
  backfillTelegramIdentityArchive: vi.fn(),
  consumeDatabaseInviteForUser: vi.fn(),
  createAppleUser: vi.fn(),
  createEmailUser: vi.fn(),
  createGoogleUser: vi.fn(),
  createInviteCode: vi.fn(),
  deleteInviteCode: vi.fn(),
  emitProviderLinkedAudit: vi.fn(),
  getActiveUserTargets: vi.fn(),
  getClosedBetaInviteStatus: vi.fn(),
  getOrCreateInviteSandboxUser: vi.fn(),
  getOrCreateUser: vi.fn(),
  getOwnerBootstrapTelegramId: vi.fn(),
  getOwnerBootstrapUser: vi.fn(),
  getOwnerBootstrapUserRefs: vi.fn(),
  getPreferredDisplayName: vi.fn(),
  getPreferredDisplayNameById: vi.fn(),
  getUserByAppleId: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByGoogleId: vi.fn(),
  getUserById: vi.fn(),
  getUserByTelegramId: vi.fn(),
  getUserLanguage: vi.fn(),
  getUserLanguageById: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserTimezoneById: vi.fn(),
  isOwner: vi.fn(),
  isOwnerBootstrapTelegramId: vi.fn(),
  isOwnerUserRef: vi.fn(),
  isUserAuthorized: vi.fn(),
  listInviteCodes: vi.fn(),
  listUsers: vi.fn(),
  listUsersInternal: vi.fn(),
  peekInviteCode: vi.fn(),
  resolveCanonicalUserId: vi.fn(),
  resolveCurrentTenantIdForUser: vi.fn(),
  resolveIosInviteRegistrationTarget: vi.fn(),
  sanitizeDisplayName: vi.fn(),
  seedOwnerUser: vi.fn(),
  setUserLanguage: vi.fn(),
  setUserLimits: vi.fn(),
  setUserStatus: vi.fn(),
  setUserStatusById: vi.fn(),
  setUserTier: vi.fn(),
  setUserTimezone: vi.fn(),
  touchUser: vi.fn(),
  validateAndConsumeInviteCode: vi.fn(),
}));
vi.mock('../../src/services/background-job-queue', () => ({ replayJob: hoisted.replayJob, cancelJob: hoisted.cancelJob,
  BackgroundJobLeaseLostError: vi.fn(),
  BackgroundJobTerminalError: vi.fn(),
  claimPendingJobs: vi.fn(),
  enqueueJob: vi.fn(),
  ensureBackgroundJobTables: vi.fn(),
  isBackgroundJobTerminalError: vi.fn(),
  listDeadLetterJobs: vi.fn(),
  listDueJobs: vi.fn(),
  markJobCompleted: vi.fn(),
  markJobFailed: vi.fn(),
  processPendingJobs: vi.fn(),
  renewJobLease: vi.fn(),
  startJobLeaseHeartbeat: vi.fn(),
}));
vi.mock('../../src/services/event-outbox', () => ({ replayEvent: hoisted.replayEvent, cancelEvent: hoisted.cancelEvent,
  EventOutboxLeaseLostError: vi.fn(),
  claimPendingEvents: vi.fn(),
  emitDomainEvent: vi.fn(),
  ensureEventOutboxTables: vi.fn(),
  getEventSequenceBounds: vi.fn(),
  listDeadLetterEvents: vi.fn(),
  listEventsForScope: vi.fn(),
  markEventFailed: vi.fn(),
  markEventProcessed: vi.fn(),
  processPendingEvents: vi.fn(),
  renewEventLease: vi.fn(),
  replayEventsForType: vi.fn(),
  runOutboxTransaction: vi.fn(),
  sanitizeEventPayload: vi.fn(),
}));

import { registerPortalOperateRoutes, summarizeProviderHealthHistory } from '../../src/portal/operate-routes';
import { RUNTIME_FLAG_CATALOG } from '../../src/services/runtime-flags-catalog';

type Handler = (req: any, res: any) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const app = {
    get: vi.fn((p: string, ...h: Handler[]) => { routes.set(`GET ${p}`, h); }),
    post: vi.fn((p: string, ...h: Handler[]) => { routes.set(`POST ${p}`, h); }),
  };
  registerPortalOperateRoutes(app as any);
  return { app, routes };
}

function call(routes: Map<string, Handler[]>, key: string, req: any = {}) {
  const handlers = routes.get(key);
  if (!handlers) throw new Error(`route ${key} not registered`);
  const payload: { statusCode: number; body?: any; headers: Record<string, string> } = { statusCode: 200, headers: {} };
  const res: any = {
    status: (c: number) => { payload.statusCode = c; return res; },
    json: (b: unknown) => { payload.body = b; return res; },
    setHeader: (k: string, v: string) => { payload.headers[k.toLowerCase()] = v; },
  };
  handlers[handlers.length - 1]({ query: {}, params: {}, body: {}, ...req }, res);
  return payload;
}

function db(): Database.Database {
  return hoisted.db as Database.Database;
}

function insertJob(id: string, status: string, tenantId = 1): void {
  db().prepare(`
    INSERT INTO background_jobs (job_id, tenant_id, job_type, idempotency_key, status, last_error)
    VALUES (?, ?, 'digest', ?, ?, ?)
  `).run(id, tenantId, `idem-${id}`, status, status === 'dead_letter' ? 'boom' : null);
}

function insertEvent(id: string, status: string, tenantId = 1): void {
  db().prepare(`
    INSERT INTO event_outbox (event_id, tenant_id, source_skill, event_type, entity_type, entity_id, idempotency_key, status)
    VALUES (?, ?, 'secretary', 'todo.created', 'todo', ?, ?, ?)
  `).run(id, tenantId, id, `idem-${id}`, status);
}

beforeEach(() => {
  hoisted.db = createMigratedTestDatabase();
  hoisted.logPortalAdminMutation.mockClear();
  hoisted.sendPortalInternalError.mockClear();
  hoisted.killSwitches = [{ controlKey: 'storefront', engaged: false, reason: 'default', actorUserId: null, updatedAt: '2026-09-04 00:00:00' }];
  hoisted.listHybridKillSwitches.mockReset().mockImplementation(() => hoisted.killSwitches);
  hoisted.setHybridKillSwitch.mockReset();
  hoisted.owner = { tenantId: 1 };
  hoisted.replayJob.mockClear().mockReturnValue(true);
  hoisted.cancelJob.mockClear().mockReturnValue(true);
  hoisted.replayEvent.mockClear().mockReturnValue(true);
  hoisted.cancelEvent.mockClear().mockReturnValue(true);
});

afterEach(() => {
  db().close();
});

describe('queues', () => {
  it('summarizes both queues', () => {
    insertJob('j1', 'pending');
    insertJob('j2', 'dead_letter');
    insertEvent('e1', 'dead_letter');
    const { routes } = makeApp();
    const payload = call(routes, 'GET /api/ops/queues');
    expect(payload.statusCode).toBe(200);
    expect(payload.headers['cache-control']).toBe('no-store');
    expect(payload.body.backgroundJobs.byStatus).toEqual({ pending: 1, dead_letter: 1 });
    expect(payload.body.eventOutbox.deadLetter).toBe(1);
  });

  it('lists dead-letter items per kind and rejects unknown kinds', () => {
    insertJob('j-dead', 'dead_letter', 7);
    insertEvent('e-dead', 'dead_letter', 8);
    const { routes } = makeApp();
    expect(call(routes, 'GET /api/ops/queues/dead-letter').body.items.map((i: any) => i.id)).toEqual(['j-dead']);
    expect(call(routes, 'GET /api/ops/queues/dead-letter', { query: { kind: 'events' } }).body.items[0]).toMatchObject({ id: 'e-dead', tenantId: 8 });
    expect(call(routes, 'GET /api/ops/queues/dead-letter', { query: { kind: 'nope' } }).statusCode).toBe(400);
  });

  it('replays and cancels through the tenant-scoped services and audits changes', () => {
    insertJob('j-dead', 'dead_letter', 7);
    insertEvent('e-dead', 'dead_letter', 8);
    const { routes } = makeApp();
    expect(routes.get('POST /api/ops/queues/:kind/:id/replay')).toHaveLength(3);

    const replay = call(routes, 'POST /api/ops/queues/:kind/:id/replay', { params: { kind: 'jobs', id: 'j-dead' } });
    expect(replay.statusCode).toBe(200);
    expect(hoisted.replayJob).toHaveBeenCalledWith('j-dead', 7);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 0, 'queue.jobs.replay', { id: 'j-dead', tenantId: 7 });

    const cancel = call(routes, 'POST /api/ops/queues/:kind/:id/cancel', { params: { kind: 'events', id: 'e-dead' } });
    expect(cancel.statusCode).toBe(200);
    expect(hoisted.cancelEvent).toHaveBeenCalledWith('e-dead', 8);

    hoisted.replayEvent.mockReturnValueOnce(false);
    expect(call(routes, 'POST /api/ops/queues/:kind/:id/replay', { params: { kind: 'events', id: 'e-dead' } }).statusCode).toBe(409);
    expect(call(routes, 'POST /api/ops/queues/:kind/:id/replay', { params: { kind: 'jobs', id: 'missing' } }).statusCode).toBe(404);
    expect(call(routes, 'POST /api/ops/queues/:kind/:id/replay', { params: { kind: 'jobs', id: 'bad id!' } }).statusCode).toBe(400);
    expect(call(routes, 'POST /api/ops/queues/:kind/:id/replay', { params: { kind: 'outbox', id: 'x' } }).statusCode).toBe(400);
  });
});

describe('flags', () => {
  it('returns the whole catalog plus kill switches without leaking env values', () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-portal-secret-marker';
    try {
      const { routes } = makeApp();
      const payload = call(routes, 'GET /api/ops/flags');
      expect(payload.statusCode).toBe(200);
      expect(payload.body.flags).toHaveLength(RUNTIME_FLAG_CATALOG.length);
      expect(payload.body.killSwitches).toEqual(hoisted.killSwitches);
      expect(JSON.stringify(payload.body)).not.toContain('sk-portal-secret-marker');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('degrades gracefully when kill switches cannot be read', () => {
    hoisted.listHybridKillSwitches.mockImplementation(() => { throw new Error('no table'); });
    const { routes } = makeApp();
    const payload = call(routes, 'GET /api/ops/flags');
    expect(payload.statusCode).toBe(200);
    expect(payload.body.killSwitches).toEqual([]);
    expect(payload.body.killSwitchError).toBe('unavailable');
  });

  it('engages a kill switch through the shared service and audits the change', () => {
    const state = { controlKey: 'storefront', engaged: true, reason: 'incident 42', actorUserId: 1, updatedAt: 'now' };
    hoisted.setHybridKillSwitch.mockReturnValue({ kind: 'updated', state });
    const { routes } = makeApp();
    expect(routes.get('POST /api/ops/flags/kill-switches/:key')).toHaveLength(3);

    const payload = call(routes, 'POST /api/ops/flags/kill-switches/:key', { params: { key: 'storefront' }, body: { engaged: true, reason: '  incident 42 ' } });
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ ok: true, killSwitch: state, changed: true });
    expect(hoisted.setHybridKillSwitch).toHaveBeenCalledWith({ controlKey: 'storefront', engaged: true, actorUserId: 1, reason: 'incident 42' });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 1, 'hybrid_kill_switch.storefront', { engaged: true, reason: 'incident 42' });
  });

  it('validates key, body, owner availability, and service rejection', () => {
    const { routes } = makeApp();
    expect(call(routes, 'POST /api/ops/flags/kill-switches/:key', { params: { key: 'unknown' }, body: { engaged: true, reason: 'x' } }).statusCode).toBe(404);
    expect(call(routes, 'POST /api/ops/flags/kill-switches/:key', { params: { key: 'storefront' }, body: { engaged: 'yes', reason: 'x' } }).statusCode).toBe(400);
    expect(call(routes, 'POST /api/ops/flags/kill-switches/:key', { params: { key: 'storefront' }, body: { engaged: true, reason: '   ' } }).statusCode).toBe(400);

    hoisted.setHybridKillSwitch.mockReturnValue({ kind: 'rejected', reason: 'nope' });
    expect(call(routes, 'POST /api/ops/flags/kill-switches/:key', { params: { key: 'storefront' }, body: { engaged: true, reason: 'x' } }).statusCode).toBe(400);

    hoisted.setHybridKillSwitch.mockReturnValue({ kind: 'unchanged', state: {} });
    const unchanged = call(routes, 'POST /api/ops/flags/kill-switches/:key', { params: { key: 'storefront' }, body: { engaged: true, reason: 'x' } });
    expect(unchanged.body.changed).toBe(false);
    expect(hoisted.logPortalAdminMutation).not.toHaveBeenCalled();

    hoisted.owner = null;
    expect(call(routes, 'POST /api/ops/flags/kill-switches/:key', { params: { key: 'storefront' }, body: { engaged: true, reason: 'x' } }).statusCode).toBe(503);
  });
});

describe('provider health history', () => {
  it('summarizes probes per provider into hourly buckets with streaks and percentiles', () => {
    const rows = [
      { ts: '2026-09-04 09:05:00', provider: 'google', status: 'ok', latency_ms: 100, error_message: null },
      { ts: '2026-09-04 09:35:00', provider: 'google', status: 'fail', latency_ms: 900, error_message: 'timeout' },
      { ts: '2026-09-04 10:05:00', provider: 'google', status: 'fail', latency_ms: null, error_message: '401 ' + 'x'.repeat(300) },
      { ts: '2026-09-04 10:05:00', provider: 'ollama', status: 'skipped', latency_ms: null, error_message: null },
    ];
    const series = summarizeProviderHealthHistory(rows);
    expect(series.map((s) => s.provider)).toEqual(['google', 'ollama']);
    const google = series[0];
    expect(google).toMatchObject({ probes: 3, failures: 2, failureRate: 0.667, lastStatus: 'fail', avgLatencyMs: 500, p95LatencyMs: 900, currentStreak: { status: 'fail', count: 2 } });
    expect(google.lastError).toHaveLength(200);
    expect(google.buckets).toEqual([
      { ts: '2026-09-04T09:00:00.000Z', probes: 2, failures: 1, avgLatencyMs: 500 },
      { ts: '2026-09-04T10:00:00.000Z', probes: 1, failures: 1, avgLatencyMs: null },
    ]);
    expect(series[1]).toMatchObject({ probes: 1, failures: 0, currentStreak: { status: 'skipped', count: 1 }, avgLatencyMs: null });
  });

  it('serves history from integration_health with provider and hours filters', () => {
    const insert = db().prepare("INSERT INTO integration_health (ts, provider, status, latency_ms, error_message) VALUES (datetime('now', ?), ?, ?, ?, ?)");
    insert.run('-1 hours', 'google', 'ok', 120, null);
    insert.run('-2 hours', 'google', 'fail', 800, 'timeout');
    insert.run('-1 hours', 'outlook', 'ok', 90, null);
    insert.run('-3 days', 'google', 'fail', 999, 'old');
    const { routes } = makeApp();

    const all = call(routes, 'GET /api/ops/provider-health-history');
    expect(all.statusCode).toBe(200);
    expect(all.body.hours).toBe(24);
    expect(all.body.providers.map((p: any) => [p.provider, p.probes])).toEqual([['google', 2], ['outlook', 1]]);

    const google = call(routes, 'GET /api/ops/provider-health-history', { query: { provider: 'google', hours: '100' } });
    expect(google.body.providers).toHaveLength(1);
    expect(google.body.providers[0]).toMatchObject({ provider: 'google', probes: 3, failures: 2 });
    expect(call(routes, 'GET /api/ops/provider-health-history', { query: { provider: 'Bad Provider' } }).body.provider).toBeNull();
  });
});

describe('notification delivery', () => {
  it('requires admin and returns attempts with a summary honoring filters', () => {
    const insert = db().prepare(`
      INSERT INTO notification_delivery_attempts (attempt_id, notification_id, user_id, tenant_id, channel, provider, status, provider_response_code, error_code, created_at)
      VALUES (?, ?, 1, 1, ?, 'apns', ?, ?, ?, datetime('now', ?))
    `);
    insert.run('a1', 'n1', 'push', 'sent', '200', null, '-1 hours');
    insert.run('a2', 'n2', 'push', 'failed', '410', 'BadDeviceToken', '-2 hours');
    insert.run('a3', 'n3', 'email', 'sent', null, null, '-3 hours');
    insert.run('a4', 'n4', 'push', 'failed', '410', 'BadDeviceToken', '-3 days');
    const { routes } = makeApp();
    expect(routes.get('GET /api/ops/notification-delivery')).toHaveLength(3);

    const payload = call(routes, 'GET /api/ops/notification-delivery');
    expect(payload.statusCode).toBe(200);
    expect(payload.body.summary.total).toBe(3);
    expect(payload.body.summary.byStatus).toEqual({ sent: 2, failed: 1 });
    expect(payload.body.summary.byChannel).toEqual({ push: 2, email: 1 });
    expect(payload.body.summary.byResponseCode).toEqual({ '200': 1, '410': 1, '(none)': 1 });
    expect(payload.body.attempts.map((a: any) => a.attemptId)).toEqual(['a1', 'a2', 'a3']);

    const failed = call(routes, 'GET /api/ops/notification-delivery', { query: { status: 'failed', hours: '96', limit: '1' } });
    expect(failed.body.summary.total).toBe(2);
    expect(failed.body.attempts).toHaveLength(1);
    expect(failed.body.attempts[0]).toMatchObject({ attemptId: 'a2', errorCode: 'BadDeviceToken' });
  });
});
