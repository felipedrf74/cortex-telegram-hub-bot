import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  calendar: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    calendar: (...args: unknown[]) => mocks.calendar(...args),
  },
}));

vi.mock('../../src/services/google-auth', () => ({
  buildGoogleOAuth2Client: vi.fn(() => ({ kind: 'owner-client' })),
  buildGoogleOAuth2ClientForUser: vi.fn(() => ({ kind: 'user-client' })),
  isGoogleConfigured: vi.fn(() => true),
  registerGoogleClientReset: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

describe('google calendar pagination', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.list.mockReset();
    mocks.get.mockReset();
    mocks.calendar.mockReset();
    mocks.calendar.mockReturnValue({ events: { list: mocks.list, get: mocks.get } });
  });

  it('reads every Google Calendar page in the requested window', async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: {
          items: [
            { id: 'evt-1', summary: 'First', start: { dateTime: '2026-06-22T12:00:00+01:00' }, end: { dateTime: '2026-06-22T12:45:00+01:00' } },
          ],
          nextPageToken: 'page-2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            { id: 'evt-2', summary: 'Second', start: { dateTime: '2026-06-23T12:00:00+01:00' }, end: { dateTime: '2026-06-23T12:45:00+01:00' } },
          ],
        },
      });

    const { getEvents } = await import('../../src/services/google-calendar');
    const events = await getEvents('2026-06-22', '2026-06-24', 42);

    expect(events.map((event) => event.id)).toEqual(['evt-1', 'evt-2']);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenNthCalledWith(1, expect.objectContaining({
      maxResults: 2500,
      pageToken: undefined,
    }));
    expect(mocks.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
      maxResults: 2500,
      pageToken: 'page-2',
    }));
  });

  it('preserves Google transparency as explicit free/busy intent', async () => {
    mocks.list.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt-free', summary: 'Available', transparency: 'transparent',
            start: { dateTime: '2026-06-22T12:00:00+01:00' },
            end: { dateTime: '2026-06-22T12:45:00+01:00' },
          },
          {
            id: 'evt-busy', summary: 'Busy', transparency: 'opaque',
            start: { dateTime: '2026-06-22T13:00:00+01:00' },
            end: { dateTime: '2026-06-22T13:45:00+01:00' },
          },
          {
            id: 'evt-unknown', summary: 'Unknown',
            start: { dateTime: '2026-06-22T14:00:00+01:00' },
            end: { dateTime: '2026-06-22T14:45:00+01:00' },
          },
        ],
      },
    });

    const { getEvents } = await import('../../src/services/google-calendar');
    const events = await getEvents('2026-06-22', '2026-06-24', 42);

    expect(events.map((event) => [event.id, event.blocksTime])).toEqual([
      ['evt-free', false],
      ['evt-busy', true],
      ['evt-unknown', true],
    ]);
  });

  it('stops if Google Calendar pagination keeps returning a next page token', async () => {
    mocks.list.mockResolvedValue({
      data: {
        items: [],
        nextPageToken: 'still-more',
      },
    });

    const { getEvents } = await import('../../src/services/google-calendar');

    await expect(getEvents('2026-06-22', '2026-06-24', 42)).rejects.toMatchObject({
      safeDetails: {
        message: expect.stringContaining('pagination page limit exceeded'),
      },
    });
    expect(mocks.list).toHaveBeenCalledTimes(20);
  });

  it('reads a Google event by exact provider id', async () => {
    mocks.get.mockResolvedValue({
      data: {
        id: 'evt-exact',
        summary: 'Moved session',
        start: { dateTime: '2026-06-27T12:00:00+01:00' },
        end: { dateTime: '2026-06-27T12:45:00+01:00' },
        description: 'NEXUS_SECRETARY_AGENDA_ITEM:agenda-1',
      },
    });
    const { getEventById } = await import('../../src/services/google-calendar');

    await expect(getEventById('evt-exact', 42)).resolves.toMatchObject({
      id: 'evt-exact',
      summary: 'Moved session',
    });
    expect(mocks.get).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'evt-exact' });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('returns null only for a provider-confirmed Google 404', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const { getEventById } = await import('../../src/services/google-calendar');

    await expect(getEventById('evt-gone', 42)).resolves.toBeNull();
  });

  it('propagates an unknown Google exact-read failure', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
    const { getEventById } = await import('../../src/services/google-calendar');

    await expect(getEventById('evt-unknown', 42)).rejects.toMatchObject({
      safeDetails: expect.objectContaining({ code: 'ECONNRESET' }),
    });
  });
});
