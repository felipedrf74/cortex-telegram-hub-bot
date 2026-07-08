import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  loggerDebug: vi.fn(),
}));

let rows: any[] = [];
const all = vi.fn(() => rows);
// Emulates the boolean-only cross-tenant EXISTS probes: every claim query
// binds the event id first and the scoped tenant id last, so a row whose
// tenantId differs from the bound tenant is an outside-tenant claim.
const get = vi.fn((...params: unknown[]) => {
  const eventIdParam = params[0];
  const tenantParam = params[params.length - 1];
  return rows.some((row) => row.eventId === eventIdParam && row.tenantId !== tenantParam)
    ? { 1: 1 }
    : undefined;
});
const prepare = vi.fn(() => ({ all, get }));

vi.mock('../../src/services/database', () => ({
  getDb: mocks.getDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  filterCalendarEventsForTrainingScope,
  getTrainingCalendarEventOwners,
  isTrainingCalendarEventClaimedOutsideTenant,
  isTrainingCalendarEventUnclaimed,
} from '../../src/services/training-calendar-scope';

describe('training-calendar-scope', () => {
  beforeEach(() => {
    rows = [];
    all.mockClear();
    get.mockClear();
    prepare.mockClear();
    mocks.getDb.mockReset();
    mocks.loggerDebug.mockReset();
    mocks.getDb.mockReturnValue({ prepare });
  });

  it('filters provider events linked to another user or inactive plan', () => {
    rows = [
      {
        eventId: 'foreign-training',
        source: 'google',
        sessionId: 293,
        planId: 13,
        tenantId: 29,
        userId: 29,
        planStatus: 'active',
      },
      {
        eventId: 'current-training',
        source: 'google',
        sessionId: 269,
        planId: 12,
        tenantId: 30,
        userId: 30,
        planStatus: 'active',
      },
      {
        eventId: 'cancelled-training',
        source: 'google',
        sessionId: 201,
        planId: 10,
        tenantId: 30,
        userId: 30,
        planStatus: 'cancelled',
      },
    ];

    const result = filterCalendarEventsForTrainingScope([
      { id: 'foreign-training', source: 'google' },
      { id: 'current-training', source: 'google' },
      { id: 'cancelled-training', source: 'google' },
      { id: 'manual-workout', source: 'google' },
    ], 30, 30);

    expect(result.map((event) => event.id)).toEqual(['current-training', 'manual-workout']);
  });

  it('treats matching events as claimed when a training session owns the calendar id', () => {
    rows = [
      {
        eventId: 'evt-linked',
        source: 'google',
        sessionId: 1,
        planId: 2,
        tenantId: 3,
        userId: 3,
        planStatus: 'active',
      },
    ];

    expect(isTrainingCalendarEventUnclaimed('evt-linked', 'google', 3)).toBe(false);
    expect(getTrainingCalendarEventOwners('evt-linked', 'google', 3)).toEqual([
      {
        eventId: 'evt-linked',
        source: 'google',
        sessionId: 1,
        planId: 2,
        tenantId: 3,
        userId: 3,
        planStatus: 'active',
      },
    ]);
  });

  it('hides cross-tenant owner metadata but keeps the event claimed for safety', () => {
    rows = [
      {
        eventId: 'evt-cross-tenant',
        source: 'google',
        sessionId: 1,
        planId: 2,
        tenantId: 99,
        userId: 99,
        planStatus: 'active',
      },
    ];

    // Metadata isolation: another tenant's rows never leave the module.
    expect(getTrainingCalendarEventOwners('evt-cross-tenant', 'google', 3)).toEqual([]);
    // Owner lookups bind (eventId, source, tenantId) in that order.
    expect(all).toHaveBeenCalledWith('evt-cross-tenant', 'google', 3);
    // Deletion/adoption safety: a provider event claimed by another tenant
    // is NOT unclaimed — shared-calendar viewers see the same event ids, so
    // adopting or deleting it would clobber the other tenant's event.
    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-cross-tenant', 'google', 3)).toBe(true);
    expect(get).toHaveBeenCalledWith('evt-cross-tenant', 'google', 3);
    expect(isTrainingCalendarEventUnclaimed('evt-cross-tenant', 'google', 3)).toBe(false);
  });

  it('reports no outside-tenant claim when only the requesting tenant owns the event', () => {
    rows = [
      {
        eventId: 'evt-own-tenant',
        source: 'google',
        sessionId: 1,
        planId: 2,
        tenantId: 3,
        userId: 3,
        planStatus: 'active',
      },
    ];

    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-own-tenant', 'google', 3)).toBe(false);
    expect(isTrainingCalendarEventUnclaimed('evt-own-tenant', 'google', 3)).toBe(false);
  });

  it('fails closed on the cross-tenant claim check so destructive paths are vetoed when the db is unavailable', () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error('Database not initialized');
    });

    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-unknown', 'google', 3)).toBe(true);
    expect(isTrainingCalendarEventUnclaimed('evt-unknown', 'google', 3)).toBe(false);
  });

  it('treats ownership-table orphan rows as claimed so new plans do not adopt stale events', () => {
    rows = [
      {
        eventId: 'evt-orphaned',
        source: 'google',
        sessionId: 0,
        planId: 22,
        tenantId: 30,
        userId: 30,
        planStatus: 'orphaned',
      },
    ];

    expect(isTrainingCalendarEventUnclaimed('evt-orphaned', 'google', 30)).toBe(false);
    expect(filterCalendarEventsForTrainingScope([
      { id: 'evt-orphaned', source: 'google' },
      { id: 'manual-workout', source: 'google' },
    ], 30, 30).map((event) => event.id)).toEqual(['manual-workout']);
  });

  it('hides ownership-backed training events when the plan row is missing', () => {
    rows = [
      {
        eventId: 'evt-missing-plan',
        source: 'google',
        sessionId: 0,
        planId: 22,
        tenantId: 30,
        userId: 30,
        planStatus: 'missing',
      },
    ];

    expect(filterCalendarEventsForTrainingScope([
      { id: 'evt-missing-plan', source: 'google' },
      { id: 'manual-workout', source: 'google' },
    ], 30, 30).map((event) => event.id)).toEqual(['manual-workout']);
  });

  it('fails open if the database is unavailable so calendar reads still render', () => {
    mocks.getDb.mockImplementationOnce(() => {
      throw new Error('Database not initialized');
    });

    const events = [{ id: 'evt-1', source: 'google' }];

    expect(filterCalendarEventsForTrainingScope(events, 30, 30)).toEqual(events);
    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 30, tenantId: 30 }),
      'Training calendar scope filtering failed',
    );
  });
});
