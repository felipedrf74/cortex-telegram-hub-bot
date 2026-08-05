import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/config', () => ({
  config: {
    health: { allowUnauthenticatedDetailed: false },
    portal: {
      token: '',
      readToken: '',
      writeToken: '',
      adminToken: 'event-backbone-admin-test-token',
      adminRequireActor: false,
      adminActorAllowlist: [],
      adminActorSignatureSecret: '',
      adminActorSignatureToleranceMs: 300000,
      sessionSecret: '',
      sessionMaxAgeMs: 28800000,
      requireSessionAuth: false,
      allowLegacyFallback: false,
      allowLocalBypass: false,
    },
  },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/audit-trail', () => ({
  getAuditTrail: vi.fn(() => []),
  logAudit: vi.fn(),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  _setOperatorAlertDeliveryConfigForTests: vi.fn(),
  _setOperatorAlertDeliverySenderForTests: vi.fn(),
  acknowledgeOperatorAlert: vi.fn(),
  deliverOperatorAlert: vi.fn(),
  getOperatorAlertDeliverySummary: vi.fn(),
  listOperatorAlerts: vi.fn(),
  processDueOperatorAlertDeliveries: vi.fn(),
  recordOperatorAlert: vi.fn(),
  resolveOperatorAlert: vi.fn(),
  retryOperatorAlertDelivery: vi.fn(),
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

import { eventBackboneAdminRoutes } from '../../src/api/routes/event-backbone-admin';
import {
  claimPendingEvents,
  emitDomainEvent,
  ensureEventOutboxTables,
  markEventFailed,
  markEventProcessed,
} from '../../src/services/event-outbox';
import {
  claimPendingJobs,
  enqueueJob,
  ensureBackgroundJobTables,
  markJobFailed,
} from '../../src/services/background-job-queue';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string | number | string[]>;
  status(code: number): MockRes;
  setHeader(name: string, value: string | number | string[]): MockRes;
  json(body: any): MockRes;
}

function mockRes(onSend: () => void): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { res.statusCode = code; return res; },
    setHeader(name: string, value: string | number | string[]) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    json(body: any) {
      res.body = body;
      onSend();
      return res;
    },
  };
  return res;
}

function req(
  method: 'GET' | 'POST',
  url: string,
  query: Record<string, unknown> = {},
  token = 'event-backbone-admin-test-token',
): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url,
    params: {},
    query,
    body: {},
    headers,
    ip: '203.0.113.7',
    socket: { remoteAddress: '203.0.113.7' },
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as any;
}

async function dispatch(request: Request): Promise<MockRes> {
  let done!: () => void;
  const responseDone = new Promise<void>((resolve) => { done = resolve; });
  const res = mockRes(done);
  eventBackboneAdminRoutes().handle(request, res, done);
  await responseDone;
  return res;
}

function eventStatus(eventId: string): { status: string; attempts: number; tenant_id: number } {
  return testDb.prepare('SELECT status, attempts, tenant_id FROM event_outbox WHERE event_id = ?').get(eventId) as any;
}

function jobStatus(jobId: string): { status: string; attempts: number; tenant_id: number } {
  return testDb.prepare('SELECT status, attempts, tenant_id FROM background_jobs WHERE job_id = ?').get(jobId) as any;
}

// Migration 279 makes pending -> terminal fixture rewrites invalid for the
// same reason they are unsafe in production: only a fenced processing lease
// may publish an outcome. Keep admin-route fixtures on that stronger path.
function moveEventToDeadLetter(eventId: string): void {
  const lease = claimPendingEvents(1, `admin-event-fixture-${eventId}`, testDb)[0];
  if (!lease || lease.eventId !== eventId) throw new Error(`failed to claim event fixture ${eventId}`);
  testDb.prepare('UPDATE event_outbox SET attempts = 3 WHERE event_id = ?').run(eventId);
  expect(markEventFailed(lease, new Error('boom'), testDb)).toBe('dead_letter');
}

function moveEventToProcessed(eventId: string): void {
  const lease = claimPendingEvents(1, `admin-event-fixture-${eventId}`, testDb)[0];
  if (!lease || lease.eventId !== eventId) throw new Error(`failed to claim event fixture ${eventId}`);
  expect(markEventProcessed(lease, testDb)).toBe(true);
}

function moveJobToDeadLetter(jobId: string): void {
  const lease = claimPendingJobs(1, `admin-job-fixture-${jobId}`, testDb, undefined, [jobId])[0];
  if (!lease || lease.jobId !== jobId) throw new Error(`failed to claim job fixture ${jobId}`);
  testDb.prepare('UPDATE background_jobs SET attempts = max_attempts WHERE job_id = ?').run(jobId);
  expect(markJobFailed(lease, new Error('boom'), testDb)).toBe('dead_letter');
}

describe('event backbone admin routes', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    ensureEventOutboxTables();
    ensureBackgroundJobTables();
  });

  afterEach(() => {
    testDb.close();
  });

  it('requires the dedicated portal admin token', async () => {
    const res = await dispatch(req('GET', '/events/dead-letter', { tenantId: '7' }, ''));
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('lists only dead-letter events for the requested tenant scope', async () => {
    const tenantA = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'training',
      eventType: 'training.session.updated',
      entityType: 'training_session',
      entityId: 'admin-event-a',
      idempotencyKey: 'admin-event-a',
    });
    moveEventToDeadLetter(tenantA.eventId);
    const tenantB = emitDomainEvent({
      tenantId: 8,
      userId: 8,
      sourceSkill: 'finance',
      eventType: 'finance.expense.created',
      entityType: 'finance_transaction',
      entityId: 'admin-event-b',
      idempotencyKey: 'admin-event-b',
    });
    moveEventToDeadLetter(tenantB.eventId);

    const res = await dispatch(req('GET', '/events/dead-letter', { tenantId: '7' }));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.events.map((event: any) => event.eventId)).toEqual([tenantA.eventId]);
    expect(JSON.stringify(res.body)).not.toContain(tenantB.eventId);
  });

  it('replays only matching-tenant events and resets attempts', async () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'content',
      eventType: 'content.idea.updated',
      entityType: 'content_topic',
      entityId: 'admin-replay-event',
      idempotencyKey: 'admin-replay-event',
    });
    moveEventToDeadLetter(event.eventId);

    const wrongTenant = await dispatch(req('POST', `/events/${event.eventId}/replay`, { tenantId: '8' }));
    expect(wrongTenant.statusCode).toBe(200);
    expect(wrongTenant.body.data.replayed).toBe(false);
    expect(eventStatus(event.eventId)).toMatchObject({ status: 'dead_letter', attempts: 3, tenant_id: 7 });

    const ok = await dispatch(req('POST', `/events/${event.eventId}/replay`, { tenantId: '7' }));
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.replayed).toBe(true);
    expect(eventStatus(event.eventId)).toMatchObject({ status: 'pending', attempts: 0, tenant_id: 7 });
  });

  it('does not cancel already processed events', async () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'secretary',
      eventType: 'secretary.reflow.suggested',
      entityType: 'agenda_item',
      entityId: 'processed-event',
      idempotencyKey: 'processed-event',
    });
    moveEventToProcessed(event.eventId);

    const res = await dispatch(req('POST', `/events/${event.eventId}/cancel`, { tenantId: '7' }));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.canceled).toBe(false);
    expect(eventStatus(event.eventId).status).toBe('processed');
  });

  it('lists, replays, and cancels jobs with tenant scoping', async () => {
    const tenantA = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'project_read_models',
      idempotencyKey: 'job-a',
    });
    moveJobToDeadLetter(tenantA.jobId);
    const tenantB = enqueueJob({
      tenantId: 8,
      userId: 8,
      jobType: 'project_read_models',
      idempotencyKey: 'job-b',
    });
    moveJobToDeadLetter(tenantB.jobId);

    const list = await dispatch(req('GET', '/jobs/dead-letter', { tenantId: '7' }));
    expect(list.statusCode).toBe(200);
    expect(list.body.data.count).toBe(1);
    expect(list.body.data.jobs.map((job: any) => job.jobId)).toEqual([tenantA.jobId]);
    expect(JSON.stringify(list.body)).not.toContain(tenantB.jobId);

    const wrongTenantReplay = await dispatch(req('POST', `/jobs/${tenantA.jobId}/replay`, { tenantId: '8' }));
    expect(wrongTenantReplay.body.data.replayed).toBe(false);
    expect(jobStatus(tenantA.jobId)).toMatchObject({ status: 'dead_letter', attempts: 3, tenant_id: 7 });

    const replay = await dispatch(req('POST', `/jobs/${tenantA.jobId}/replay`, { tenantId: '7' }));
    expect(replay.body.data.replayed).toBe(true);
    expect(jobStatus(tenantA.jobId)).toMatchObject({ status: 'pending', attempts: 0, tenant_id: 7 });

    const cancelWrongTenant = await dispatch(req('POST', `/jobs/${tenantA.jobId}/cancel`, { tenantId: '8' }));
    expect(cancelWrongTenant.body.data.canceled).toBe(false);
    expect(jobStatus(tenantA.jobId).status).toBe('pending');

    const cancel = await dispatch(req('POST', `/jobs/${tenantA.jobId}/cancel`, { tenantId: '7' }));
    expect(cancel.body.data.canceled).toBe(true);
    expect(jobStatus(tenantA.jobId).status).toBe('canceled');
  });
});
