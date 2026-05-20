import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOrphanedOwnerships: vi.fn(),
  findOwnershipsNeedingReconciliation: vi.fn(),
  markCalendarOwnershipDeleted: vi.fn(),
  deleteEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  findOrphanedOwnerships: mocks.findOrphanedOwnerships,
  findOwnershipsNeedingReconciliation: mocks.findOwnershipsNeedingReconciliation,
  markCalendarOwnershipDeleted: mocks.markCalendarOwnershipDeleted,
}));

vi.mock('../../src/services/unified-calendar', () => ({
  deleteEvent: mocks.deleteEvent,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { reconcileOrphanedTrainingAgendaEvents } from '../../src/services/training-agenda-reconciliation';

describe('training-agenda-reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrphanedOwnerships.mockReturnValue([]);
    mocks.findOwnershipsNeedingReconciliation.mockReturnValue([]);
    mocks.markCalendarOwnershipDeleted.mockReturnValue({ ok: true, rowsAffected: 1 });
    mocks.deleteEvent.mockResolvedValue(undefined);
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

    const result = await reconcileOrphanedTrainingAgendaEvents(42);

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

    const result = await reconcileOrphanedTrainingAgendaEvents(42);

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

    const result = await reconcileOrphanedTrainingAgendaEvents(42);

    expect(result).toEqual({ attempted: 1, deleted: 0, failed: 1 });
    expect(mocks.markCalendarOwnershipDeleted).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-still-there', source: 'outlook' }),
      'Failed to reconcile orphaned training calendar event',
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

    const result = await reconcileOrphanedTrainingAgendaEvents(42);

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

    const result = await reconcileOrphanedTrainingAgendaEvents(42);

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

    const result = await reconcileOrphanedTrainingAgendaEvents(42);

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
});
