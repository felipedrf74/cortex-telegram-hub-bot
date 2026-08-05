import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scheduledJobStateMigration = readFileSync(
  resolve(process.cwd(), 'migrations/275_scheduled_job_execution_state.sql'),
  'utf8',
);

const mocks = vi.hoisted(() => ({
  findOrphanedOwnerships: vi.fn(),
  findOwnershipsNeedingReconciliation: vi.fn(),
  markCalendarOwnershipDeleted: vi.fn(),
  deleteEvent: vi.fn(),
  getEvents: vi.fn(),
  getPlanById: vi.fn(),
  getUserTimezoneById: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  findOrphanedOwnerships: mocks.findOrphanedOwnerships,
  findOwnershipsNeedingReconciliation: mocks.findOwnershipsNeedingReconciliation,
  markCalendarOwnershipDeleted: mocks.markCalendarOwnershipDeleted,
}));

vi.mock('../../src/services/unified-calendar', () => ({
  deleteEvent: mocks.deleteEvent,
  getEvents: mocks.getEvents,
}));

vi.mock('../../src/services/training-plans', () => ({
  getPlanById: mocks.getPlanById,
}));

vi.mock('../../src/services/user-service', () => ({
  getUserTimezoneById: mocks.getUserTimezoneById,
}));

vi.mock('../../src/services/database', () => ({
  getDb: mocks.getDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: mocks.loggerWarn,
    debug: mocks.loggerDebug,
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { reconcileOrphanedTrainingAgendaEvents, _resetLegacyMarkerScanGateForTests } from '../../src/services/training-agenda-reconciliation';

function legacyTrainingMarkerEvent(id: string, planId = 43) {
  return {
    id,
    source: 'google',
    summary: 'Recovery Run',
    start: '2026-06-02T12:00:00.000Z',
    end: '2026-06-02T12:40:00.000Z',
    description: `[NEXUS_TRAINING_IDENTITY plan=${planId};version=1;session=1099;key=x;shape=y]`,
  };
}

describe('training-agenda-reconciliation', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Reset one-shot implementations as well as call history. The isolated-
    // runtime overlap test intentionally leaves its second getEvents response
    // unused when the durable lease works; mockClear would leak that response
    // into the following tenant-ownership case.
    vi.resetAllMocks();
    db = new Database(':memory:');
    db.exec(scheduledJobStateMigration);
    mocks.getDb.mockReturnValue(db);
    _resetLegacyMarkerScanGateForTests();
    mocks.findOrphanedOwnerships.mockReturnValue([]);
    mocks.findOwnershipsNeedingReconciliation.mockReturnValue([]);
    mocks.markCalendarOwnershipDeleted.mockReturnValue({ ok: true, rowsAffected: 1 });
    mocks.deleteEvent.mockResolvedValue(undefined);
    mocks.getEvents.mockResolvedValue([]);
    mocks.getPlanById.mockReturnValue(null);
    mocks.getUserTimezoneById.mockReturnValue('UTC');
  });

  afterEach(() => {
    db.close();
  });

  it('deletes orphaned agenda events by exact ownership and marks them reconciled', async () => {
    mocks.findOwnershipsNeedingReconciliation.mockReturnValue([
      {
        id: 1,
        plan_id: 10,
        plan_version: 1,
        session_id: 100,
        user_id: 42,
        calendar_event_id: 'evt-old',
        calendar_source: 'google',
        status: 'orphaned',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: '2026-04-20T01:00:00Z',
        delete_reason: 'plan_cancelled_external_delete_failed',
      },
    ]);

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 1, failed: 0 });
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-old', 'google', 42);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-old',
      source: 'google',
      reason: 'orphan_reconciled',
      status: 'deleted',
      userId: 42,
      tenantId: 42,
      planId: 10,
      ownershipId: 1,
    });
  });

  it('also reconciles active ownership rows whose session was already hard-deleted', async () => {
    mocks.findOrphanedOwnerships.mockReturnValue([
      {
        id: 3,
        plan_id: 11,
        plan_version: 1,
        session_id: 111,
        user_id: 42,
        calendar_event_id: 'evt-active-orphan',
        calendar_source: 'google',
        status: 'active',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: null,
        delete_reason: null,
      },
    ]);

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 1, failed: 0 });
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-active-orphan', 'google', 42);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-active-orphan',
      source: 'google',
      reason: 'orphan_reconciled',
      status: 'deleted',
      userId: 42,
      tenantId: 42,
      planId: 11,
      ownershipId: 3,
    });
  });

  it('keeps failed provider deletes queued as failures without broad fallback deletion', async () => {
    mocks.findOwnershipsNeedingReconciliation.mockReturnValue([
      {
        id: 2,
        plan_id: 10,
        plan_version: 1,
        session_id: 101,
        user_id: 42,
        calendar_event_id: 'evt-still-there',
        calendar_source: 'outlook',
        status: 'orphaned',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: '2026-04-20T01:00:00Z',
        delete_reason: 'plan_cancelled_external_delete_failed',
      },
    ]);
    mocks.deleteEvent.mockRejectedValueOnce(new Error('provider timeout'));

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 0, failed: 1 });
    expect(mocks.markCalendarOwnershipDeleted).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-still-there', source: 'outlook' }),
      'Failed to reconcile orphaned training calendar event',
    );
  });

  it('retries provider rate limits before leaving an orphan queued', async () => {
    mocks.findOwnershipsNeedingReconciliation.mockReturnValue([
      {
        id: 9,
        plan_id: 18,
        plan_version: 1,
        session_id: 118,
        user_id: 42,
        calendar_event_id: 'evt-rate-limited-once',
        calendar_source: 'google',
        status: 'orphaned',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: '2026-04-20T01:00:00Z',
        delete_reason: 'plan_cancelled_external_delete_failed',
      },
    ]);
    mocks.deleteEvent
      .mockRejectedValueOnce(Object.assign(new Error('Rate Limit Exceeded'), {
        status: 403,
        code: 403,
        reason: 'rateLimitExceeded',
        errors: [{ reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
      }))
      .mockResolvedValueOnce(undefined);

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 1, failed: 0 });
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(2);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-rate-limited-once',
      source: 'google',
      reason: 'orphan_reconciled',
      status: 'deleted',
      userId: 42,
      tenantId: 42,
      planId: 18,
      ownershipId: 9,
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt-rate-limited-once',
        source: 'google',
        attempt: 1,
        ownershipId: 9,
      }),
      'Training calendar delete rate-limited - retrying',
    );
  });

  it.each([
    ['status 404', { status: 404, message: 'not found' }],
    ['status 410', { status: 410, message: 'gone' }],
    ['provider code', { code: 'event_not_found' }],
    ['message only', new Error('Event not found')],
  ])('treats provider %s as already gone and marks the ownership deleted', async (_label, providerError) => {
    mocks.findOwnershipsNeedingReconciliation.mockReturnValue([
      {
        id: 5,
        plan_id: 13,
        plan_version: 1,
        session_id: 113,
        user_id: 42,
        calendar_event_id: 'evt-already-gone',
        calendar_source: 'google',
        status: 'orphaned',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: '2026-04-20T01:00:00Z',
        delete_reason: 'plan_cancelled_external_delete_failed',
      },
    ]);
    mocks.deleteEvent.mockRejectedValueOnce(providerError);

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 1, failed: 0 });
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-already-gone',
      source: 'google',
      reason: 'orphan_reconciled_event_gone_upstream',
      status: 'deleted',
      userId: 42,
      tenantId: 42,
      planId: 13,
      ownershipId: 5,
    });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('does not treat non-event not-found provider errors as already gone', async () => {
    mocks.findOwnershipsNeedingReconciliation.mockReturnValue([
      {
        id: 6,
        plan_id: 14,
        plan_version: 1,
        session_id: 114,
        user_id: 42,
        calendar_event_id: 'evt-user-scope-failed',
        calendar_source: 'outlook',
        status: 'orphaned',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: '2026-04-20T01:00:00Z',
        delete_reason: 'plan_cancelled_external_delete_failed',
      },
    ]);
    mocks.deleteEvent.mockRejectedValueOnce(new Error('User not found'));

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 0, failed: 1 });
    expect(mocks.markCalendarOwnershipDeleted).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-user-scope-failed', source: 'outlook' }),
      'Failed to reconcile orphaned training calendar event',
    );
  });

  it('marks active orphan rows as queued when the provider delete fails', async () => {
    mocks.findOrphanedOwnerships.mockReturnValue([
      {
        id: 4,
        plan_id: 12,
        plan_version: 1,
        session_id: 112,
        user_id: 42,
        calendar_event_id: 'evt-active-fail',
        calendar_source: 'outlook',
        status: 'active',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: null,
        delete_reason: null,
      },
    ]);
    mocks.deleteEvent.mockRejectedValueOnce(new Error('provider timeout'));

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 0, failed: 1 });
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-active-fail',
      source: 'outlook',
      reason: 'orphan_reconcile_delete_failed',
      status: 'orphaned',
      userId: 42,
      tenantId: 42,
      planId: 12,
      ownershipId: 4,
    });
  });

  it('deletes stale legacy Secretary training marker events when no active plan owns them', async () => {
    mocks.getEvents.mockResolvedValue([
      {
        id: 'legacy-secretary-event',
        source: 'google',
        summary: 'Runner Lower Body Strength A',
        start: '2026-06-02T12:00:00.000Z',
        end: '2026-06-02T12:42:00.000Z',
        description: [
          'NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_abc',
          'NEXUS_SECRETARY_SOURCE_INTENT:training:43:1:1099',
          'NEXUS_SECRETARY_SOURCE_SKILL:training',
          'NEXUS_SECRETARY_SOURCE_ENTITY:training_session:1099',
        ].join('\n'),
      },
    ]);
    mocks.getPlanById.mockReturnValue(null);

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 1, failed: 0 });
    expect(mocks.deleteEvent).toHaveBeenCalledWith('legacy-secretary-event', 'google', 42);
    expect(mocks.markCalendarOwnershipDeleted).not.toHaveBeenCalled();
  });

  it('keeps legacy marker events when the matching plan is still active for the user', async () => {
    mocks.getEvents.mockResolvedValue([
      {
        id: 'active-plan-event',
        source: 'google',
        summary: 'Recovery Run',
        start: '2026-06-02T12:00:00.000Z',
        end: '2026-06-02T12:40:00.000Z',
        description: '[NEXUS_TRAINING_IDENTITY plan=43;version=1;session=1099;key=x;shape=y]',
      },
    ]);
    mocks.getPlanById.mockReturnValue({ id: 43, user_id: 42, tenant_id: 42, status: 'active' });

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 0, deleted: 0, failed: 0 });
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
  });

  // Stronger guarantee: a failed provider read must not consume the durable
  // daily checkpoint; the next reconciliation tick must be allowed to retry.
  it('checkpoints a legacy scan only after the provider read succeeds', async () => {
    mocks.getEvents
      .mockRejectedValueOnce(new Error('calendar provider unavailable'))
      .mockResolvedValueOnce([legacyTrainingMarkerEvent('retry-after-read-failure')]);
    mocks.getPlanById.mockReturnValue(null);

    await expect(reconcileOrphanedTrainingAgendaEvents(42, 42)).resolves.toEqual({
      attempted: 0,
      deleted: 0,
      failed: 0,
    });
    await expect(reconcileOrphanedTrainingAgendaEvents(42, 42)).resolves.toEqual({
      attempted: 1,
      deleted: 1,
      failed: 0,
    });

    expect(mocks.getEvents).toHaveBeenCalledTimes(2);
    expect(mocks.deleteEvent).toHaveBeenCalledWith(
      'retry-after-read-failure',
      'google',
      42,
    );
  });

  // Stronger guarantee: scan cadence is keyed by the complete tenant/user
  // boundary, so one tenant cannot suppress another tenant's cleanup window.
  it('keeps legacy scan checkpoints isolated by tenant and user', async () => {
    await reconcileOrphanedTrainingAgendaEvents(42, 100);
    await reconcileOrphanedTrainingAgendaEvents(42, 200);

    expect(mocks.findOwnershipsNeedingReconciliation).toHaveBeenNthCalledWith(1, 42, 100);
    expect(mocks.findOwnershipsNeedingReconciliation).toHaveBeenNthCalledWith(2, 42, 200);
    expect(mocks.getEvents).toHaveBeenCalledTimes(2);
  });

  // Stronger guarantee: a completed scan is a durable checkpoint and remains
  // effective when another process/module instance starts on the same data.
  it('retains a successful legacy scan checkpoint across runtime restart', async () => {
    await reconcileOrphanedTrainingAgendaEvents(42, 42);

    vi.resetModules();
    const restarted = await import('../../src/services/training-agenda-reconciliation');
    await restarted.reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(mocks.getEvents).toHaveBeenCalledTimes(1);
  });

  // Stronger guarantee: the wide provider scan uses a cluster-safe lease, so
  // isolated runtimes cannot execute the same tenant/user sweep concurrently.
  it('allows only one in-flight legacy scan across isolated runtimes', async () => {
    let releaseFirstScan!: (events: unknown[]) => void;
    const firstScan = new Promise<unknown[]>((resolve) => {
      releaseFirstScan = resolve;
    });
    mocks.getEvents
      .mockImplementationOnce(() => firstScan)
      .mockResolvedValueOnce([]);

    const firstRun = reconcileOrphanedTrainingAgendaEvents(42, 42);
    await Promise.resolve();
    expect(mocks.getEvents).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const secondRuntime = await import('../../src/services/training-agenda-reconciliation');
    await secondRuntime.reconcileOrphanedTrainingAgendaEvents(42, 42);

    releaseFirstScan([]);
    await firstRun;
    expect(mocks.getEvents).toHaveBeenCalledTimes(1);
  });

  // Stronger guarantee: a foreign tenant's active plan cannot protect a stale
  // marker in the current tenant's calendar from reconciliation.
  it('does not treat an active plan from another tenant as marker ownership', async () => {
    mocks.getEvents.mockResolvedValue([
      legacyTrainingMarkerEvent('foreign-tenant-plan-marker'),
    ]);
    mocks.getPlanById.mockReturnValue({
      id: 43,
      user_id: 42,
      tenant_id: 999,
      status: 'active',
    });

    const result = await reconcileOrphanedTrainingAgendaEvents(42, 42);

    expect(result).toEqual({ attempted: 1, deleted: 1, failed: 0 });
    expect(mocks.deleteEvent).toHaveBeenCalledWith(
      'foreign-tenant-plan-marker',
      'google',
      42,
    );
  });
});
