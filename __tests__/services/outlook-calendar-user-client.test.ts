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

import { createEvent, updateEvent, deleteEvent } from '../../src/services/outlook-calendar';

describe('OutlookCalendar — per-user Graph client for writes', () => {
  beforeEach(() => {
    mocks.ownerRequest.post.mockReset();
    mocks.ownerRequest.patch.mockReset();
    mocks.ownerRequest.delete.mockReset();
    mocks.ownerRequest.option.mockClear();
    mocks.ownerClient.api.mockClear();
    mocks.userRequest.post.mockReset();
    mocks.userRequest.patch.mockReset();
    mocks.userRequest.delete.mockReset();
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
  });

  it('uses the per-user Graph client when deleting an event with userId', async () => {
    mocks.userRequest.delete.mockResolvedValue(undefined);

    await deleteEvent('evt-3', 77);

    expect(mocks.getGraphClientForUser).toHaveBeenCalledWith(77);
    expect(mocks.getGraphClient).not.toHaveBeenCalled();
    expect(mocks.userClient.api).toHaveBeenCalledWith('/me/events/evt-3');
  });
});
