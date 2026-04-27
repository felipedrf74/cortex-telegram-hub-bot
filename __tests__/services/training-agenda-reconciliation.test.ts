import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOwnershipsNeedingReconciliation: vi.fn(),
  markCalendarOwnershipDeleted: vi.fn(),
  deleteEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
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
}));

import { reconcileOrphanedTrainingAgendaEvents } from '../../src/services/training-agenda-reconciliation';

describe('training-agenda-reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
