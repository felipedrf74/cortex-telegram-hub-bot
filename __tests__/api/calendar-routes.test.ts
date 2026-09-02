import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockGetEvents = vi.fn();
const mockGetEventsWithDiagnostics = vi.fn();
const mockGetEventById = vi.fn();
const mockCreateEvent = vi.fn();
const mockUpdateEvent = vi.fn();
const mockDeleteEvent = vi.fn();
const mockGetEventsForSources = vi.fn();
const mockIsAnyCalendarConfigured = vi.fn();
const mockHasConnectedCalendarForUser = vi.fn();
const mockHasWritableCalendarForUser = vi.fn();
const mockGetCachedSWR = vi.fn();
const mockSetCacheSWR = vi.fn();
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockGetFocusBlockRecommendation = vi.fn();
const mockFilterCalendarEventsForTrainingScope = vi.fn();
const mockExecuteSecretaryCalendarCommand = vi.fn();
const mockInspectSecretaryCalendarCommandReplay = vi.fn();
const mockExecuteSecretaryCalendarMutation = vi.fn();
const mockInspectSecretaryCalendarMutationReplay = vi.fn();

function expectCachePrefixesCleared(...prefixes: string[]) {
  const cleared = mockClearCacheByPrefix.mock.calls.flatMap(([prefix]) => (
    Array.isArray(prefix) ? prefix : [prefix]
  ));
  for (const prefix of prefixes) {
    expect(cleared).toContain(prefix);
  }
}

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  getEventsWithDiagnostics: (...args: unknown[]) => mockGetEventsWithDiagnostics(...args),
  getEventById: (...args: unknown[]) => mockGetEventById(...args),
  getEventsForSources: (...args: unknown[]) => mockGetEventsForSources(...args),
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
  deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
  isAnyCalendarConfigured: (...args: unknown[]) => mockIsAnyCalendarConfigured(...args),
  hasConnectedCalendarForUser: (...args: unknown[]) => mockHasConnectedCalendarForUser(...args),
  hasWritableCalendarForUser: (...args: unknown[]) => mockHasWritableCalendarForUser(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCachedSWR: (...args: unknown[]) => mockGetCachedSWR(...args),
  setCacheSWR: (...args: unknown[]) => mockSetCacheSWR(...args),
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
    garmin: { tokenPath: '/tmp' },
  },
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: (...args: unknown[]) => mockGetFocusBlockRecommendation(...args),
}));

vi.mock('../../src/services/training-calendar-scope', () => ({
  filterCalendarEventsForTrainingScope: (...args: unknown[]) => mockFilterCalendarEventsForTrainingScope(...args),
}));

vi.mock('../../src/services/secretary-calendar-command-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/secretary-calendar-command-service')>(
    '../../src/services/secretary-calendar-command-service',
  );
  return {
    ...actual,
    executeSecretaryCalendarCommand: (...args: unknown[]) => mockExecuteSecretaryCalendarCommand(...args),
    inspectSecretaryCalendarCommandReplay: (...args: unknown[]) => mockInspectSecretaryCalendarCommandReplay(...args),
    executeSecretaryCalendarMutation: (...args: unknown[]) => mockExecuteSecretaryCalendarMutation(...args),
    inspectSecretaryCalendarMutationReplay: (...args: unknown[]) => mockInspectSecretaryCalendarMutationReplay(...args),
  };
});

vi.mock('../../src/services/health-sleep-agenda', () => ({
  getAppleHealthSleepAgendaEvents: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { calendarRoutes } from '../../src/api/routes/calendar';
import { SecretaryCalendarCommandError } from '../../src/services/secretary-calendar-command-service';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
    setHeader(name: string, value: string) { response.headers[name] = value; return response; },
    end() { return response; },
  };
  return response;
}

function mockReq(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  userId = 12,
  headers: Record<string, string> = {},
): Request {
  const parsed = new URL(url, 'http://test.local');
  return {
    method,
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    params: {},
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    body: body ?? {},
    userId,
    tenantId: userId,
  } as any;
}

async function dispatch(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  userId = 12,
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const router = calendarRoutes();
  const req = mockReq(method, url, body, userId, headers);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Calendar API — mutation routes', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    mockGetEvents.mockReset();
    mockGetEventsWithDiagnostics.mockReset();
    mockGetEventById.mockReset();
    mockGetEventsForSources.mockReset();
    mockCreateEvent.mockReset();
    mockUpdateEvent.mockReset();
    mockDeleteEvent.mockReset();
    mockIsAnyCalendarConfigured.mockReset();
    mockHasConnectedCalendarForUser.mockReset();
    mockHasWritableCalendarForUser.mockReset();
    mockGetCachedSWR.mockReset();
    mockSetCacheSWR.mockReset();
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockGetFocusBlockRecommendation.mockReset();
    mockFilterCalendarEventsForTrainingScope.mockReset();
    mockExecuteSecretaryCalendarCommand.mockReset();
    mockInspectSecretaryCalendarCommandReplay.mockReset();
    mockExecuteSecretaryCalendarMutation.mockReset();
    mockInspectSecretaryCalendarMutationReplay.mockReset();

    mockGetCachedSWR.mockReturnValue(null);
    mockIsAnyCalendarConfigured.mockReturnValue(true);
    mockHasConnectedCalendarForUser.mockReturnValue(true);
    mockHasWritableCalendarForUser.mockReturnValue(true);
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    mockGetEventsForSources.mockResolvedValue([]);
    mockFilterCalendarEventsForTrainingScope.mockImplementation((events) => events);
    mockInspectSecretaryCalendarCommandReplay.mockReturnValue(null);
    mockInspectSecretaryCalendarMutationReplay.mockReturnValue(null);
    mockExecuteSecretaryCalendarCommand.mockImplementation(async (input: any) => {
      try {
        const event = await mockCreateEvent({
          title: input.title,
          start: input.start,
          end: input.end,
          description: input.description,
          categories: input.categories,
          attendees: input.attendees,
          location: input.location,
          recurrence: input.recurrence,
        }, input.source, input.userId, { tenantId: Number(input.tenantId) });
        return { status: 'succeeded', replayed: false, event, warningCodes: [] };
      } catch {
        throw new SecretaryCalendarCommandError(
          'CALENDAR_PROVIDER_WRITE_FAILED',
          'The calendar provider rejected the command and no event was created.',
          502,
          ['CALENDAR_PROVIDER_WRITE_FAILED'],
        );
      }
    });
    mockExecuteSecretaryCalendarMutation.mockImplementation(async (input: any) => {
      if (input.operation === 'delete') {
        await mockDeleteEvent(input.eventId, input.source, input.userId, undefined);
        return { status: 'succeeded', replayed: false, deleted: true, warningCodes: [] };
      }
      const event = await mockUpdateEvent({
        event_id: input.eventId,
        new_title: input.title,
        new_start: input.start,
        new_end: input.end,
        new_description: input.description,
      }, input.source, input.userId, undefined);
      return { status: 'succeeded', replayed: false, event, warningCodes: [] };
    });
  });

  it('returns an empty events list when the authenticated user has no connected calendar', async () => {
    mockHasConnectedCalendarForUser.mockReturnValue(false);

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.events).toEqual([]);
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('returns event colors when the unified calendar provides them', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'evt-1',
          summary: 'Content block',
          start: '2026-04-19T16:00:00.000Z',
          end: '2026-04-19T16:30:00.000Z',
          source: 'outlook',
          categories: ['Content'],
          color: '#8E44AD',
        },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.events[0]).toMatchObject({
      id: 'evt-1',
      source: 'outlook',
      color: '#8E44AD',
    });
  });

  it('preserves deduplicated provider membership in the public calendar event', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'evt-shared',
          summary: 'Shared meeting',
          start: '2026-04-19T16:00:00.000Z',
          end: '2026-04-19T16:30:00.000Z',
          source: 'outlook',
          syncedSources: ['outlook', 'google', 'outlook', 'unknown'],
        },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google', 'outlook'], failed: [] },
    });

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.events[0].syncedSources).toEqual(['outlook', 'google']);
  });

  it('serves cached calendar events without touching the provider and honors If-None-Match', async () => {
    mockGetCachedSWR.mockReturnValue({
      fresh: true,
      value: {
        events: [
          {
            id: 'cached-evt',
            title: 'Cached block',
            start: '2026-04-19T16:00:00.000Z',
            end: '2026-04-19T16:30:00.000Z',
            source: 'outlook',
          },
        ],
        status: 'ready',
        warningCodes: [],
        warnings: [],
        sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
      },
    });

    const first = await dispatch('GET', '/events?start=2026-04-19T00:00:00.000Z&end=2026-04-20T00:00:00.000Z');
    const secondReq = mockReq('GET', '/events?start=2026-04-19T00:00:00.000Z&end=2026-04-20T00:00:00.000Z');
    (secondReq as any).headers = { 'if-none-match': first.headers.ETag };
    (secondReq as any).header = (name: string) => (secondReq as any).headers[name.toLowerCase()] ?? (secondReq as any).headers[name];
    const router = calendarRoutes();
    const second = mockRes();
    await new Promise<void>((resolve) => {
      (router as any).handle(secondReq, second, (err: any) => {
        if (err) throw err;
        resolve();
      });
      setImmediate(resolve);
    });

    expect(first.statusCode).toBe(200);
    expect(first.body.cached).toBe(true);
    expect(first.body.data.events[0].id).toBe('cached-evt');
    expect(first.headers.ETag).toBeTruthy();
    expect(second.statusCode).toBe(304);
    expect(mockGetEventsWithDiagnostics).not.toHaveBeenCalled();
  });

  it('serves stale today events immediately and refreshes them in the background', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
    mockGetCachedSWR.mockReturnValueOnce({
      fresh: false,
      value: {
        events: [],
        status: 'ready',
        warningCodes: [],
        warnings: [],
        sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
      },
    });
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'refreshed-event',
          summary: 'Refreshed',
          start: `${today}T16:00:00.000Z`,
          end: `${today}T16:30:00.000Z`,
          source: 'outlook',
        },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });

    const res = await dispatch('GET', '/today', undefined, 34);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.data.events).toEqual([]);
    expect(mockGetEventsWithDiagnostics).toHaveBeenCalled();
    expect(mockSetCacheSWR).toHaveBeenCalledWith(
      expect.stringMatching(/^t:34:u:34:calendar:today:/),
      expect.objectContaining({
        events: [expect.objectContaining({ id: 'refreshed-event' })],
      }),
      120,
      300,
    );
  });

  it('bypasses cached today events when refresh is requested', async () => {
    mockGetCachedSWR.mockReturnValue({
      fresh: true,
      value: {
        events: [
          {
            id: 'deleted-google-training',
            title: 'Runner Upper Body Strength',
            start: '2026-06-05T12:00:00.000Z',
            end: '2026-06-05T12:48:00.000Z',
            source: 'google',
          },
        ],
        status: 'ready',
        warningCodes: [],
        warnings: [],
      },
    });
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });

    const res = await dispatch('GET', '/today?refresh=true');

    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.data.events).toEqual([]);
    expect(mockGetEventsWithDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('filters training calendar events linked outside the authenticated user scope', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'foreign-training',
          summary: '🏋️ Mobility + Recovery (29min)',
          start: '2026-04-27T11:00:00.000Z',
          end: '2026-04-27T11:29:00.000Z',
          source: 'google',
        },
        {
          id: 'manual-event',
          summary: 'Manual focus block',
          start: '2026-04-27T12:00:00.000Z',
          end: '2026-04-27T12:30:00.000Z',
          source: 'google',
        },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    mockFilterCalendarEventsForTrainingScope.mockImplementation((events: any[], userId: number) => {
      expect(userId).toBe(12);
      return events.filter((event) => event.id !== 'foreign-training');
    });

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].id).toBe('manual-event');
    expect(mockFilterCalendarEventsForTrainingScope).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'foreign-training' })]),
      12,
      12,
    );
  });

  it('normalizes absent optional event fields to explicit nulls for iOS decoding', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'evt-optional',
          summary: 'No extras',
          description: '   ',
          start: '2026-04-19T16:00:00.000Z',
          end: '2026-04-19T16:30:00.000Z',
          location: undefined,
          source: 'unknown',
          categories: undefined,
          color: undefined,
        },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.events[0]).toEqual({
      id: 'evt-optional',
      title: 'No extras',
      description: null,
      start: '2026-04-19T16:00:00.000Z',
      end: '2026-04-19T16:30:00.000Z',
      location: null,
      source: null,
      categories: null,
      color: null,
      isAllDay: false,
    });
  });

  it('does not leak raw provider errors when event loading fails', async () => {
    mockGetEventsWithDiagnostics.mockRejectedValueOnce(new Error('outlook token refresh failed with raw upstream body'));

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('CALENDAR_FETCH_FAILED');
    expect(res.body.error.message).toBe('Failed to fetch calendar events');
    expect(JSON.stringify(res.body)).not.toContain('outlook token refresh failed');
  });

  it('surfaces partial calendar provider failure without hiding surviving events', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'evt-google',
          summary: 'Strength',
          start: '2026-04-27T11:30:00.000Z',
          end: '2026-04-27T12:30:00.000Z',
          source: 'google',
        },
      ],
      status: 'degraded',
      warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'],
      warnings: ['Outlook Calendar is unavailable right now.'],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google'], failed: ['outlook'] },
    });

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.warningCodes).toEqual(['OUTLOOK_CALENDAR_UNAVAILABLE']);
  });

  it('returns an unavailable error when all configured calendar providers fail', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'unavailable',
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE', 'OUTLOOK_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.', 'Outlook Calendar is unavailable right now.'],
      sources: { configured: ['google', 'outlook'], fulfilled: [], failed: ['google', 'outlook'] },
    });

    const res = await dispatch('GET', '/events');

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('CALENDAR_FETCH_FAILED');
    expect(res.body.error.details.warningCodes).toEqual([
      'GOOGLE_CALENDAR_UNAVAILABLE',
      'OUTLOOK_CALENDAR_UNAVAILABLE',
    ]);
  });

  it('fails closed on invalid tenant scope before loading events', async () => {
    const res = await dispatch('GET', '/events', undefined, 0);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockHasConnectedCalendarForUser).not.toHaveBeenCalled();
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'calendar_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('returns an empty today payload when the authenticated user has no connected calendar', async () => {
    mockHasConnectedCalendarForUser.mockReturnValue(false);

    const res = await dispatch('GET', '/today');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.events).toEqual([]);
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('updates a calendar event through the deterministic Secretary mutation service', async () => {
    const current = {
      id: 'evt-1',
      summary: 'Original block',
      start: '2026-04-16T08:00:00.000Z',
      end: '2026-04-16T09:00:00.000Z',
      source: 'outlook',
    };
    const updated = {
      id: 'evt-1',
      summary: 'Updated block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
      source: 'outlook',
    };
    mockGetEventById.mockResolvedValueOnce(current).mockResolvedValueOnce(updated);
    mockUpdateEvent.mockResolvedValue(updated);

    const res = await dispatch('PATCH', '/events/evt-1', {
      title: 'Updated block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
      source: 'outlook',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.event.title).toBe('Updated block');
    expect(mockUpdateEvent).toHaveBeenCalledWith({
      event_id: 'evt-1',
      new_title: 'Updated block',
      new_start: '2026-04-16T09:00:00.000Z',
      new_end: '2026-04-16T10:00:00.000Z',
      new_description: undefined,
    }, 'outlook', 12, undefined);
    expect(mockExecuteSecretaryCalendarMutation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      operation: 'update',
      source: 'outlook',
      eventId: 'evt-1',
    }));
  });

  it('rejects event updates without a valid source', async () => {
    const res = await dispatch('PATCH', '/events/evt-1', {
      title: 'Updated block',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('deletes a calendar event through the deterministic Secretary mutation service', async () => {
    mockGetEventById
      .mockResolvedValueOnce({
        id: 'evt-2',
        summary: 'Delete me',
        start: '2026-04-16T09:00:00.000Z',
        end: '2026-04-16T10:00:00.000Z',
        source: 'google',
      })
      .mockResolvedValueOnce(null);
    mockDeleteEvent.mockResolvedValue(undefined);

    const res = await dispatch('DELETE', '/events/evt-2?source=google');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
    expect(mockDeleteEvent).toHaveBeenCalledWith('evt-2', 'google', 12, undefined);
    expect(mockExecuteSecretaryCalendarMutation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      operation: 'delete',
      source: 'google',
      eventId: 'evt-2',
    }));
  });

  it('rejects deletes without a valid source query', async () => {
    const res = await dispatch('DELETE', '/events/evt-2');

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  it('rejects a new keyed mutation before provider I/O when no writable calendar is connected', async () => {
    mockHasWritableCalendarForUser.mockReturnValue(false);

    const res = await dispatch('PATCH', '/events/evt-no-write', {
      title: 'No write',
      source: 'google',
    }, 12, { 'idempotency-key': 'calendar-no-write-key' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('CALENDAR_NOT_CONFIGURED');
    expect(mockGetEventById).not.toHaveBeenCalled();
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('replays a completed keyed mutation after write capability is disconnected', async () => {
    const current = {
      id: 'evt-replay-after-disconnect',
      summary: 'Original',
      start: '2026-04-16T08:00:00.000Z',
      end: '2026-04-16T09:00:00.000Z',
      source: 'google',
    };
    const updated = { ...current, summary: 'Updated' };
    mockGetEventById.mockResolvedValueOnce(current).mockResolvedValueOnce(updated);
    mockUpdateEvent.mockResolvedValue(updated);
    const body = { title: 'Updated', source: 'google' };
    const headers = { 'idempotency-key': 'calendar-replay-after-disconnect' };

    const first = await dispatch('PATCH', '/events/evt-replay-after-disconnect', body, 12, headers);
    expect(first.statusCode).toBe(200);
    expect(first.body.data.replayed).toBe(false);

    mockInspectSecretaryCalendarMutationReplay.mockReturnValue({
      result: {
        status: 'succeeded',
        replayed: true,
        event: updated,
        warningCodes: [],
      },
    });
    mockHasWritableCalendarForUser.mockReturnValue(false);
    mockGetEventById.mockClear();
    mockUpdateEvent.mockClear();
    const replay = await dispatch('PATCH', '/events/evt-replay-after-disconnect', body, 12, headers);

    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(mockGetEventById).not.toHaveBeenCalled();
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('guards duplicate in-flight focus block creates from rapid double taps', async () => {
    let releaseCreate!: () => void;
    mockCreateEvent.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCreate = () => resolve({
        id: 'focus-1',
        summary: 'Focus time',
        start: '2026-05-18T14:00:00.000Z',
        end: '2026-05-18T14:30:00.000Z',
        source: 'google',
      });
    }));

    const body = {
      source: 'google',
      start: '2026-05-18T14:00:00.000Z',
      durationMinutes: 30,
      mode: 'focus',
    };
    const headers = { 'idempotency-key': 'focus-double-tap-key' };
    const first = dispatch('POST', '/focus-blocks', body, 12, headers);
    for (let i = 0; i < 5 && mockCreateEvent.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    mockExecuteSecretaryCalendarCommand.mockRejectedValueOnce(new SecretaryCalendarCommandError(
      'CALENDAR_SYNC_PENDING',
      'This command is already being processed; no duplicate write was issued.',
      409,
      ['CALENDAR_SYNC_PENDING', 'CALENDAR_COMMAND_LEASE_HELD'],
    ));
    const duplicate = await dispatch('POST', '/focus-blocks', body, 12, headers);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.error.code).toBe('CALENDAR_SYNC_PENDING');

    releaseCreate();
    const created = await first;
    expect(created.statusCode).toBe(200);
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized 502 when focus block provider create fails', async () => {
    mockCreateEvent.mockRejectedValueOnce(new Error('raw upstream token refresh body'));

    const res = await dispatch('POST', '/focus-blocks', {
      source: 'google',
      start: '2026-05-18T14:00:00.000Z',
      durationMinutes: 30,
      mode: 'focus',
    }, 12, { 'idempotency-key': 'focus-provider-failure-key' });

    expect(res.statusCode).toBe(502);
    expect(res.body.error.code).toBe('CALENDAR_PROVIDER_WRITE_FAILED');
    expect(res.body.error.message).toBe(
      'The calendar provider rejected the command and no event was created.',
    );
    expect(JSON.stringify(res.body)).not.toContain('raw upstream');
  });
});
