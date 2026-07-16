import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const ownerRequest = {
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    query: vi.fn(),
    header: vi.fn(),
    option: vi.fn(),
  };
  ownerRequest.query.mockReturnValue(ownerRequest);
  ownerRequest.header.mockReturnValue(ownerRequest);
  ownerRequest.option.mockReturnValue(ownerRequest);

  const userRequest = {
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    query: vi.fn(),
    header: vi.fn(),
    option: vi.fn(),
  };
  userRequest.query.mockReturnValue(userRequest);
  userRequest.header.mockReturnValue(userRequest);
  userRequest.option.mockReturnValue(userRequest);

  const ownerClient = {
    api: vi.fn(() => ownerRequest),
  };
  const userClient = {
    api: vi.fn(() => userRequest),
  };

  return {
    ownerRequest,
    userRequest,
    ownerClient,
    userClient,
    getGraphClient: vi.fn(() => ownerClient),
    getGraphClientForUser: vi.fn(() => userClient),
    isMicrosoftConfigured: vi.fn(() => true),
  };
});

vi.mock('../../src/services/microsoft-auth', () => ({
  getGraphClient: (...args: unknown[]) => mocks.getGraphClient(...args),
  getGraphClientForUser: (...args: unknown[]) => mocks.getGraphClientForUser(...args),
  isMicrosoftConfigured: (...args: unknown[]) => mocks.isMicrosoftConfigured(...args),
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
    outlook: { clientId: 'test-outlook-client' },
  },
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

import { createEvent, updateEvent, deleteEvent, getEvents } from '../../src/services/outlook-calendar';

describe('OutlookCalendar — per-user Graph client for writes', () => {
  beforeEach(() => {
    mocks.ownerRequest.post.mockReset();
    mocks.ownerRequest.patch.mockReset();
    mocks.ownerRequest.delete.mockReset();
    mocks.ownerRequest.get.mockReset();
    mocks.ownerRequest.header.mockClear();
    mocks.ownerRequest.option.mockClear();
    mocks.ownerClient.api.mockClear();
    mocks.userRequest.post.mockReset();
    mocks.userRequest.patch.mockReset();
    mocks.userRequest.delete.mockReset();
    mocks.userRequest.get.mockReset();
    mocks.userRequest.header.mockClear();
    mocks.userRequest.option.mockClear();
    mocks.userClient.api.mockClear();
    mocks.getGraphClient.mockClear();
    mocks.getGraphClientForUser.mockClear();
  });

  it('uses the per-user Graph client when creating an event with userId', async () => {
    mocks.userRequest.post.mockResolvedValue({
      id: 'evt-1',
      subject: 'Session',
      start: { dateTime: '2026-04-16T09:00:00.000Z' },
      end: { dateTime: '2026-04-16T10:00:00.000Z' },
    });

    await createEvent({
      title: 'Session',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }, 77);

    expect(mocks.getGraphClientForUser).toHaveBeenCalledWith(77);
    expect(mocks.getGraphClient).not.toHaveBeenCalled();
    expect(mocks.userClient.api).toHaveBeenCalledWith('/me/events');
    expect(mocks.userRequest.header).toHaveBeenCalledWith('Prefer', 'IdType="ImmutableId"');
  });

  it('uses immutable ids and full body content when reading calendar events', async () => {
    mocks.userRequest.get
      .mockResolvedValueOnce({
        value: [{
          id: 'evt-read',
          subject: 'Training',
          start: { dateTime: '2026-04-16T09:00:00.000Z' },
          end: { dateTime: '2026-04-16T10:00:00.000Z' },
          bodyPreview: 'truncated',
          body: { content: 'Full training body [NEXUS_TRAINING_IDENTITY session=1]' },
          categories: [],
        }],
      })
      .mockResolvedValueOnce({ value: [] });

    const events = await getEvents('2026-04-16', '2026-04-17', 77);

    expect(mocks.userRequest.query).toHaveBeenCalledWith(expect.objectContaining({
      $select: expect.stringContaining('body'),
    }));
    expect(mocks.userRequest.header).toHaveBeenCalledWith(
      'Prefer',
      'outlook.timezone="Europe/Lisbon", IdType="ImmutableId"',
    );
    expect(events[0]).toMatchObject({
      id: 'evt-read',
      description: 'Full training body [NEXUS_TRAINING_IDENTITY session=1]',
    });
  });

  it('maps Outlook free and workingElsewhere as non-blocking while unknown values fail closed', async () => {
    mocks.userRequest.get
      .mockResolvedValueOnce({
        value: [
          {
            id: 'evt-free', subject: 'Available', showAs: 'free',
            start: { dateTime: '2026-04-16T09:00:00.000Z' },
            end: { dateTime: '2026-04-16T10:00:00.000Z' },
          },
          {
            id: 'evt-tentative', subject: 'Tentative', showAs: 'tentative',
            start: { dateTime: '2026-04-16T10:00:00.000Z' },
            end: { dateTime: '2026-04-16T11:00:00.000Z' },
          },
          {
            id: 'evt-elsewhere', subject: 'Elsewhere', showAs: 'workingElsewhere',
            start: { dateTime: '2026-04-16T11:00:00.000Z' },
            end: { dateTime: '2026-04-16T12:00:00.000Z' },
          },
          {
            id: 'evt-unknown', subject: 'Unknown',
            start: { dateTime: '2026-04-16T12:00:00.000Z' },
            end: { dateTime: '2026-04-16T13:00:00.000Z' },
          },
        ],
      })
      .mockResolvedValueOnce({ value: [] });

    const events = await getEvents('2026-04-16', '2026-04-17', 77);

    expect(mocks.userRequest.query).toHaveBeenCalledWith(expect.objectContaining({
      $select: expect.stringContaining('showAs'),
    }));
    expect(events.map((event) => [event.id, event.blocksTime])).toEqual([
      ['evt-free', false],
      ['evt-tentative', true],
      ['evt-elsewhere', false],
      ['evt-unknown', true],
    ]);
  });

  it('follows Outlook calendarView nextLink pages', async () => {
    mocks.userRequest.get
      .mockResolvedValueOnce({
        value: [{
          id: 'evt-page-1',
          subject: 'Earlier event',
          start: { dateTime: '2026-04-16T09:00:00.000Z' },
          end: { dateTime: '2026-04-16T10:00:00.000Z' },
        }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=abc',
      })
      .mockResolvedValueOnce({
        value: [{
          id: 'evt-page-2',
          subject: 'Training event',
          start: { dateTime: '2026-04-16T12:00:00.000Z' },
          end: { dateTime: '2026-04-16T13:00:00.000Z' },
          body: { content: '[NEXUS_TRAINING_IDENTITY session=2]' },
        }],
      })
      .mockResolvedValueOnce({ value: [] });

    const events = await getEvents('2026-04-16', '2026-04-17', 77);

    expect(mocks.userClient.api).toHaveBeenCalledWith('/me/calendarView');
    expect(mocks.userClient.api).toHaveBeenCalledWith('/me/calendarView?$skiptoken=abc');
    expect(events.map((event) => event.id)).toEqual(['evt-page-1', 'evt-page-2']);
    expect(events[1].description).toBe('[NEXUS_TRAINING_IDENTITY session=2]');
  });

  it('fails closed instead of returning incomplete calendar coverage at the page limit', async () => {
    mocks.userRequest.get.mockResolvedValue({
      value: [],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=more',
    });

    await expect(getEvents('2026-04-16', '2027-04-17', 77))
      .rejects.toThrow('Outlook calendar pagination page limit exceeded (10)');
    expect(mocks.userRequest.get).toHaveBeenCalledTimes(10);
  });

  it('fails closed when an Outlook calendar read stalls beyond the provider timeout', async () => {
    vi.useFakeTimers();
    mocks.userRequest.get.mockImplementation(() => new Promise(() => {}));
    try {
      const pending = getEvents('2026-04-16', '2026-04-17', 77);
      const rejection = expect(pending).rejects.toThrow('AI call timed out after 15000ms');
      await vi.advanceTimersByTimeAsync(15_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops Outlook write categories that are not present in the user master category list', async () => {
    mocks.userRequest.get.mockResolvedValue({
      value: [{ displayName: 'Client', color: 'preset7' }],
    });
    mocks.userRequest.post.mockResolvedValue({
      id: 'evt-focus',
      subject: 'Focus block',
      start: { dateTime: '2026-04-16T09:00:00.000Z' },
      end: { dateTime: '2026-04-16T10:00:00.000Z' },
    });

    const event = await createEvent({
      title: 'Focus block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
      categories: ['focus', 'pomodoro'],
    }, 88);

    expect(mocks.userClient.api).toHaveBeenCalledWith('/me/outlook/masterCategories');
    expect(mocks.userRequest.post).toHaveBeenCalledWith(expect.not.objectContaining({
      categories: expect.any(Array),
    }));
    expect(event.categories).toBeUndefined();
  });

  it('maps Outlook write categories to existing master category display names', async () => {
    mocks.userRequest.get.mockResolvedValue({
      value: [{ displayName: 'Focus', color: 'preset4' }],
    });
    mocks.userRequest.post.mockResolvedValue({
      id: 'evt-focus',
      subject: 'Focus block',
      start: { dateTime: '2026-04-16T09:00:00.000Z' },
      end: { dateTime: '2026-04-16T10:00:00.000Z' },
    });

    const event = await createEvent({
      title: 'Focus block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
      categories: ['focus'],
    }, 89);

    expect(mocks.userRequest.post).toHaveBeenCalledWith(expect.objectContaining({
      categories: ['Focus'],
    }));
    expect(event.categories).toEqual(['Focus']);
  });

  it('threads AbortSignal into per-user Graph create requests', async () => {
    const controller = new AbortController();
    const aborted = vi.fn();
    mocks.userRequest.post.mockImplementation(async () => {
      expect(mocks.userRequest.option).toHaveBeenCalledWith('signal', controller.signal);
      controller.signal.addEventListener('abort', aborted);
      controller.abort();
      throw new Error('aborted');
    });

    await expect(createEvent({
      title: 'Session',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
    }, 77, { signal: controller.signal })).rejects.toThrow('aborted');

    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('uses the per-user Graph client when updating an event with userId', async () => {
    mocks.userRequest.patch.mockResolvedValue({
      id: 'evt-2',
      subject: 'Updated session',
      start: { dateTime: '2026-04-16T11:00:00.000Z' },
      end: { dateTime: '2026-04-16T12:00:00.000Z' },
    });

    await updateEvent({
      event_id: 'evt-2',
      new_title: 'Updated session',
    }, 77);

    expect(mocks.getGraphClientForUser).toHaveBeenCalledWith(77);
    expect(mocks.getGraphClient).not.toHaveBeenCalled();
    expect(mocks.userClient.api).toHaveBeenCalledWith('/me/events/evt-2');
    expect(mocks.userRequest.header).toHaveBeenCalledWith('Prefer', 'IdType="ImmutableId"');
  });

  it('uses the per-user Graph client when deleting an event with userId', async () => {
    mocks.userRequest.delete.mockResolvedValue(undefined);

    await deleteEvent('evt-3', 77);

    expect(mocks.getGraphClientForUser).toHaveBeenCalledWith(77);
    expect(mocks.getGraphClient).not.toHaveBeenCalled();
    expect(mocks.userClient.api).toHaveBeenCalledWith('/me/events/evt-3');
    expect(mocks.userRequest.header).toHaveBeenCalledWith('Prefer', 'IdType="ImmutableId"');
  });

  it('retries Outlook deletes without immutable-id preference for legacy event ids', async () => {
    mocks.userRequest.delete
      .mockRejectedValueOnce(Object.assign(new Error("Your request can't be completed. This operation does not support binding to a non-calendar folder."), {
        statusCode: 400,
        code: 'ErrorInvalidRequest',
        body: '{"code":"ErrorInvalidRequest","message":"non-calendar folder"}',
      }))
      .mockResolvedValueOnce(undefined);

    await deleteEvent('legacy-evt', 77);

    expect(mocks.userClient.api).toHaveBeenCalledTimes(2);
    expect(mocks.userClient.api).toHaveBeenNthCalledWith(1, '/me/events/legacy-evt');
    expect(mocks.userClient.api).toHaveBeenNthCalledWith(2, '/me/events/legacy-evt');
    expect(mocks.userRequest.header).toHaveBeenCalledTimes(1);
    expect(mocks.userRequest.header).toHaveBeenCalledWith('Prefer', 'IdType="ImmutableId"');
    expect(mocks.userRequest.delete).toHaveBeenCalledTimes(2);
  });
});
