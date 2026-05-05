import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  loggerDebug: vi.fn(),
}));

let rows: any[] = [];
const all = vi.fn(() => rows);
const prepare = vi.fn(() => ({ all }));

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
  isTrainingCalendarEventUnclaimed,
} from '../../src/services/training-calendar-scope';

describe('training-calendar-scope', () => {
  beforeEach(() => {
    rows = [];
    all.mockClear();
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
        userId: 29,
        planStatus: 'active',
      },
      {
        eventId: 'current-training',
        source: 'google',
        sessionId: 269,
        planId: 12,
        userId: 30,
        planStatus: 'active',
      },
      {
        eventId: 'cancelled-training',
        source: 'google',
        sessionId: 201,
        planId: 10,
        userId: 30,
        planStatus: 'cancelled',
      },
    ];

    const result = filterCalendarEventsForTrainingScope([
      { id: 'foreign-training', source: 'google' },
      { id: 'current-training', source: 'google' },
      { id: 'cancelled-training', source: 'google' },
      { id: 'manual-workout', source: 'google' },
    ], 30);

    expect(result.map((event) => event.id)).toEqual(['current-training', 'manual-workout']);
  });

  it('treats matching events as claimed when a training session owns the calendar id', () => {
    rows = [
      {
        eventId: 'evt-linked',
        source: 'google',
        sessionId: 1,
        planId: 2,
        userId: 3,
        planStatus: 'active',
      },
    ];

    expect(isTrainingCalendarEventUnclaimed('evt-linked', 'google')).toBe(false);
    expect(getTrainingCalendarEventOwners('evt-linked', 'google')).toEqual([
      {
        eventId: 'evt-linked',
        source: 'google',
        sessionId: 1,
        planId: 2,
        userId: 3,
        planStatus: 'active',
      },
    ]);
  });

  it('treats ownership-table orphan rows as claimed so new plans do not adopt stale events', () => {
    rows = [
      {
        eventId: 'evt-orphaned',
        source: 'google',
        sessionId: 0,
        planId: 22,
        userId: 30,
        planStatus: 'orphaned',
      },
    ];

    expect(isTrainingCalendarEventUnclaimed('evt-orphaned', 'google')).toBe(false);
    expect(filterCalendarEventsForTrainingScope([
      { id: 'evt-orphaned', source: 'google' },
      { id: 'manual-workout', source: 'google' },
    ], 30).map((event) => event.id)).toEqual(['manual-workout']);
  });

  it('fails open if the database is unavailable so calendar reads still render', () => {
    mocks.getDb.mockImplementationOnce(() => {
      throw new Error('Database not initialized');
    });

    const events = [{ id: 'evt-1', source: 'google' }];

    expect(filterCalendarEventsForTrainingScope(events, 30)).toEqual(events);
    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 30 }),
      'Training calendar scope filtering failed',
    );
  });
});
