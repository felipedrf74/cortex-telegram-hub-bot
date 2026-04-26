import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockGetEvents = vi.fn();
const mockGetEventsWithDiagnostics = vi.fn();
const mockCreateEvent = vi.fn();
const mockUpdateEvent = vi.fn();
const mockDeleteEvent = vi.fn();
const mockIsAnyCalendarConfigured = vi.fn();
const mockHasConnectedCalendarForUser = vi.fn();
const mockHasWritableCalendarForUser = vi.fn();
const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockGetFocusBlockRecommendation = vi.fn();

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  getEventsWithDiagnostics: (...args: unknown[]) => mockGetEventsWithDiagnostics(...args),
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
  deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
  isAnyCalendarConfigured: (...args: unknown[]) => mockIsAnyCalendarConfigured(...args),
  hasConnectedCalendarForUser: (...args: unknown[]) => mockHasConnectedCalendarForUser(...args),
  hasWritableCalendarForUser: (...args: unknown[]) => mockHasWritableCalendarForUser(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
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

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { calendarRoutes } from '../../src/api/routes/calendar';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
    setHeader() { return response; },
    end() { return response; },
  };
  return response;
}

function mockReq(method: string, url: string, body?: Record<string, unknown>, userId = 12): Request {
  const parsed = new URL(url, 'http://test.local');
  return {
    method,
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    params: {},
    headers: {},
    body: body ?? {},
    userId,
  } as any;
}

async function dispatch(method: string, url: string, body?: Record<string, unknown>, userId = 12): Promise<MockRes> {
  const router = calendarRoutes();
  const req = mockReq(method, url, body, userId);
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
    mockCreateEvent.mockReset();
    mockUpdateEvent.mockReset();
    mockDeleteEvent.mockReset();
    mockIsAnyCalendarConfigured.mockReset();
    mockHasConnectedCalendarForUser.mockReset();
    mockHasWritableCalendarForUser.mockReset();
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockGetFocusBlockRecommendation.mockReset();

    mockGetCached.mockReturnValue(null);
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

  it('updates a calendar event through the unified service and clears per-user cache', async () => {
    mockUpdateEvent.mockResolvedValue({
      id: 'evt-1',
      summary: 'Updated block',
      start: '2026-04-16T09:00:00.000Z',
      end: '2026-04-16T10:00:00.000Z',
      source: 'outlook',
    });

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
    }, 'outlook', 12);
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('u:12:calendar:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('calendar:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:week:u:12:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:today:u:12:');
  });

  it('rejects event updates without a valid source', async () => {
    const res = await dispatch('PATCH', '/events/evt-1', {
      title: 'Updated block',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('deletes a calendar event through the unified service and clears cache', async () => {
    mockDeleteEvent.mockResolvedValue(undefined);

    const res = await dispatch('DELETE', '/events/evt-2?source=google');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
    expect(mockDeleteEvent).toHaveBeenCalledWith('evt-2', 'google', 12);
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('u:12:calendar:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:week:u:12:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:today:u:12:');
  });

  it('rejects deletes without a valid source query', async () => {
    const res = await dispatch('DELETE', '/events/evt-2');

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });
});
