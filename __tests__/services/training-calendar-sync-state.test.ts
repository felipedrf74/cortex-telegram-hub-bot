import { describe, expect, it } from 'vitest';

import {
  calendarSyncStateIsLinked,
  calendarSyncStateNeedsRepair,
  resolveCalendarSyncState,
} from '../../src/services/training-calendar-sync-state';

describe('training-calendar-sync-state', () => {
  it('treats verified ownership as linked and display-safe', () => {
    const state = resolveCalendarSyncState({
      hasStoredCalendarEventId: true,
      verifiedCalendarEventId: 'evt-verified',
    });

    expect(state).toBe('verified');
    expect(calendarSyncStateIsLinked(state)).toBe(true);
    expect(calendarSyncStateNeedsRepair(state)).toBe(false);
  });

  it('marks stored but unverified ownership as repair_needed instead of unscheduled', () => {
    const state = resolveCalendarSyncState({
      hasStoredCalendarEventId: true,
      verifiedCalendarEventId: null,
    });

    expect(state).toBe('repair_needed');
    expect(calendarSyncStateIsLinked(state)).toBe(false);
    expect(calendarSyncStateNeedsRepair(state)).toBe(true);
  });

  it('only returns unscheduled when there is no stored calendar ownership', () => {
    expect(resolveCalendarSyncState({
      hasStoredCalendarEventId: false,
      manualUnscheduled: true,
    })).toBe('unscheduled');
  });

  it('prioritizes actionable provider and operation states before ownership display', () => {
    expect(resolveCalendarSyncState({
      hasStoredCalendarEventId: true,
      verifiedCalendarEventId: 'evt-verified',
      providerDisconnected: true,
    })).toBe('provider_disconnected');

    expect(resolveCalendarSyncState({
      hasStoredCalendarEventId: true,
      verifiedCalendarEventId: 'evt-verified',
      syncFailed: true,
    })).toBe('failed');

    expect(resolveCalendarSyncState({
      hasStoredCalendarEventId: true,
      verifiedCalendarEventId: 'evt-verified',
      syncPending: true,
    })).toBe('pending');
  });

  it('keeps legacy linked and stale aliases normalized during rollout', () => {
    expect(calendarSyncStateIsLinked('synced')).toBe(true);
    expect(calendarSyncStateIsLinked('verified')).toBe(true);
    expect(calendarSyncStateNeedsRepair('stale')).toBe(true);
    expect(calendarSyncStateNeedsRepair('repair_needed')).toBe(true);
  });
});
