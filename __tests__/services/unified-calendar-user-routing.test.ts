import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  googleCreateEvent: vi.fn(),
  googleUpdateEvent: vi.fn(),
  googleDeleteEvent: vi.fn(),
  googleConfigured: vi.fn(),
  googleEvents: vi.fn(),
  outlookCreateEvent: vi.fn(),
  outlookUpdateEvent: vi.fn(),
  outlookDeleteEvent: vi.fn(),
  outlookConfigured: vi.fn(),
  outlookEvents: vi.fn(),
  fixtureConfigured: vi.fn(),
  fixtureEvents: vi.fn(),
  resolveCalendarWritePreference: vi.fn(),
}));

vi.mock('../../src/services/google-calendar', () => ({
  createEvent: (...args: unknown[]) => mocks.googleCreateEvent(...args),
  updateEvent: (...args: unknown[]) => mocks.googleUpdateEvent(...args),
  deleteEvent: (...args: unknown[]) => mocks.googleDeleteEvent(...args),
  isGoogleCalendarConfigured: (...args: unknown[]) => mocks.googleConfigured(...args),
  getEvents: (...args: unknown[]) => mocks.googleEvents(...args),
}));

vi.mock('../../src/services/outlook-calendar', () => ({
  createEvent: (...args: unknown[]) => mocks.outlookCreateEvent(...args),
  updateEvent: (...args: unknown[]) => mocks.outlookUpdateEvent(...args),
  deleteEvent: (...args: unknown[]) => mocks.outlookDeleteEvent(...args),
  isOutlookCalendarConfigured: (...args: unknown[]) => mocks.outlookConfigured(...args),
  getEvents: (...args: unknown[]) => mocks.outlookEvents(...args),
}));

vi.mock('../../src/services/staging-fixture-calendar', () => ({
  hasStagingFixtureCalendarEventsForUser: (...args: unknown[]) => mocks.fixtureConfigured(...args),
  getStagingFixtureCalendarEvents: (...args: unknown[]) => mocks.fixtureEvents(...args),
}));

vi.mock('../../src/services/provider-preferences', () => ({
  resolveCalendarWritePreference: (...args: unknown[]) => mocks.resolveCalendarWritePreference(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  createEvent,
  getEvents,
  getEventsWithDiagnostics,
  hasConnectedCalendarForUser,
  updateEvent,
  deleteEvent,
} from '../../src/services/unified-calendar';

describe('UnifiedCalendar — per-user routing for calendar writes', () => {
  beforeEach(() => {
    mocks.googleCreateEvent.mockReset();
    mocks.googleUpdateEvent.mockReset();
    mocks.googleDeleteEvent.mockReset();
    mocks.googleConfigured.mockReset();
    mocks.googleEvents.mockReset();
    mocks.outlookCreateEvent.mockReset();
    mocks.outlookUpdateEvent.mockReset();
    mocks.outlookDeleteEvent.mockReset();
    mocks.outlookConfigured.mockReset();
    mocks.outlookEvents.mockReset();
    mocks.fixtureConfigured.mockReset();
    mocks.fixtureEvents.mockReset();
    mocks.resolveCalendarWritePreference.mockReset();

    mocks.outlookConfigured.mockReturnValue(true);
    mocks.googleConfigured.mockReturnValue(false);
    mocks.fixtureConfigured.mockReturnValue(false);
    mocks.resolveCalendarWritePreference.mockReturnValue({
      source: null,
      requested: 'auto',
      warningCode: 'CALENDAR_INTEGRATION_MISSING',
      warning: 'No writable calendar provider is connected.',
      availability: { google: false, outlook: false },
    });
  });

  it('passes userId through when creating an Outlook event', async () => {
    mocks.outlookCreateEvent.mockResolvedValue({
      id: 'evt-outlook-1',
      summary: 'Coach call',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    });

    await createEvent({
      title: 'Coach call',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }, 'outlook', 42);

    expect(mocks.outlookCreateEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Coach call',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }), 42, undefined);
  });

  it('passes userId through when updating an Outlook event', async () => {
    mocks.outlookUpdateEvent.mockResolvedValue({
      id: 'evt-outlook-2',
      summary: 'Updated title',
      start: '2026-04-16T11:00:00.000Z',
      end: '2026-04-16T12:00:00.000Z',
    });

    await updateEvent({
      event_id: 'evt-outlook-2',
      new_title: 'Updated title',
    }, 'outlook', 42);

    expect(mocks.outlookUpdateEvent).toHaveBeenCalledWith({
      event_id: 'evt-outlook-2',
      new_title: 'Updated title',
    }, 42, undefined);
  });

  it('passes userId through when deleting an Outlook event', async () => {
    mocks.outlookDeleteEvent.mockResolvedValue(undefined);

    await deleteEvent('evt-outlook-3', 'outlook', 42);

    expect(mocks.outlookDeleteEvent).toHaveBeenCalledWith('evt-outlook-3', 42, undefined);
  });

  it('passes userId through when creating a Google event', async () => {
    mocks.outlookConfigured.mockReturnValue(false);
    mocks.googleConfigured.mockReturnValue(true);
    mocks.googleCreateEvent.mockResolvedValue({
      id: 'evt-google-1',
      summary: 'Strength block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    });

    await createEvent({
      title: 'Strength block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }, 'google', 42);

    expect(mocks.googleCreateEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Strength block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }), 42, undefined);
  });

  it('uses tenant-scoped provider preferences for implicit calendar writes', async () => {
    mocks.outlookConfigured.mockReturnValue(false);
    mocks.googleConfigured.mockReturnValue(true);
    mocks.resolveCalendarWritePreference.mockReturnValue({
      source: 'google',
      requested: 'google',
      warningCode: null,
      warning: null,
      availability: { google: true, outlook: false },
    });
    mocks.googleCreateEvent.mockResolvedValue({
      id: 'evt-tenant-pref',
      summary: 'Tenant preference focus',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    });

    await createEvent({
      title: 'Tenant preference focus',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }, undefined, 42, { tenantId: 7 });

    expect(mocks.resolveCalendarWritePreference).toHaveBeenCalledWith(42, 7);
    expect(mocks.googleCreateEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Tenant preference focus',
    }), 42, { tenantId: 7 });
  });

  it('passes userId through when updating a Google event', async () => {
    mocks.outlookConfigured.mockReturnValue(false);
    mocks.googleConfigured.mockReturnValue(true);
    mocks.googleUpdateEvent.mockResolvedValue({
      id: 'evt-google-2',
      summary: 'Updated session',
      start: '2026-04-16T11:00:00.000Z',
      end: '2026-04-16T12:00:00.000Z',
    });

    await updateEvent({
      event_id: 'evt-google-2',
      new_title: 'Updated session',
    }, 'google', 42);

    expect(mocks.googleUpdateEvent).toHaveBeenCalledWith({
      event_id: 'evt-google-2',
      new_title: 'Updated session',
    }, 42, undefined);
  });

  it('passes userId through when deleting a Google event', async () => {
    mocks.outlookConfigured.mockReturnValue(false);
    mocks.googleConfigured.mockReturnValue(true);
    mocks.googleDeleteEvent.mockResolvedValue(undefined);

    await deleteEvent('evt-google-3', 'google', 42);

    expect(mocks.googleDeleteEvent).toHaveBeenCalledWith('evt-google-3', 42, undefined);
  });

  it('does not fall back to owner calendar providers for an authenticated user with no connected calendar', async () => {
    mocks.outlookConfigured.mockImplementation((userId?: number) => userId == null);
    mocks.googleConfigured.mockReturnValue(false);

    await expect(createEvent({
      title: 'Strength block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }, undefined, 42)).rejects.toThrow('No calendar provider is connected');

    expect(mocks.outlookCreateEvent).not.toHaveBeenCalled();
    expect(mocks.googleCreateEvent).not.toHaveBeenCalled();
  });

  it('returns degraded diagnostics when one configured calendar provider fails', async () => {
    mocks.googleConfigured.mockReturnValue(true);
    mocks.outlookConfigured.mockReturnValue(true);
    mocks.googleEvents.mockResolvedValue([
      {
        id: 'g-1',
        summary: 'Gym',
        start: '2026-04-27T11:30:00.000Z',
        end: '2026-04-27T12:30:00.000Z',
      },
    ]);
    mocks.outlookEvents.mockRejectedValue(new Error('outlook down'));

    const result = await getEventsWithDiagnostics(
      '2026-04-27T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      42,
    );

    expect(result.status).toBe('degraded');
    expect(result.events).toHaveLength(1);
    expect(result.warningCodes).toEqual(['OUTLOOK_CALENDAR_UNAVAILABLE']);
    expect(result.sources).toMatchObject({
      configured: ['google', 'outlook'],
      fulfilled: ['google'],
      failed: ['outlook'],
    });
  });

  it('throws from the legacy array API when every configured provider fails', async () => {
    mocks.googleConfigured.mockReturnValue(true);
    mocks.outlookConfigured.mockReturnValue(true);
    mocks.googleEvents.mockRejectedValue(new Error('google down'));
    mocks.outlookEvents.mockRejectedValue(new Error('outlook down'));

    await expect(getEvents(
      '2026-04-27T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      42,
    )).rejects.toThrow('Google Calendar is unavailable right now.');
  });

  it('reports unavailable instead of ready when no calendar provider is connected', async () => {
    mocks.googleConfigured.mockReturnValue(false);
    mocks.outlookConfigured.mockReturnValue(false);

    const result = await getEventsWithDiagnostics(
      '2026-04-27T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      42,
    );

    expect(result).toMatchObject({
      events: [],
      status: 'unavailable',
      warningCodes: ['CALENDAR_INTEGRATION_MISSING'],
      sources: { configured: [], fulfilled: [], failed: [] },
    });
  });

  it('uses staging fixture calendar events as a read-only source for synthetic users', async () => {
    mocks.googleConfigured.mockReturnValue(false);
    mocks.outlookConfigured.mockReturnValue(false);
    mocks.fixtureConfigured.mockImplementation((userId?: number) => userId === 1_000_001);
    mocks.fixtureEvents.mockReturnValue([
      {
        id: 'staging-fixture-cal-1000001-001',
        summary: 'Fixture calendar volume event 001',
        start: '2026-04-27T09:00:00.000Z',
        end: '2026-04-27T09:15:00.000Z',
        source: 'outlook',
      },
    ]);

    expect(hasConnectedCalendarForUser(1_000_001)).toBe(true);

    const result = await getEventsWithDiagnostics(
      '2026-04-27T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      1_000_001,
    );

    expect(result.status).toBe('ready');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('staging-fixture-cal-1000001-001');
    expect(mocks.googleEvents).not.toHaveBeenCalled();
    expect(mocks.outlookEvents).not.toHaveBeenCalled();
    expect(mocks.fixtureEvents).toHaveBeenCalledWith(
      '2026-04-27T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      1_000_001,
    );
  });
});
