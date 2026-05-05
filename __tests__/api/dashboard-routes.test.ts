import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { DateTime } from 'luxon';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockGetCachedSWR = vi.fn();
const mockSetCacheSWR = vi.fn();
const mockCalculateReadiness = vi.fn();
const mockGoogleCalendarConfigured = vi.fn();
const mockGoogleCalendarEvents = vi.fn();
const mockOutlookCalendarConfigured = vi.fn();
const mockOutlookCalendarEvents = vi.fn();
const mockGetUserById = vi.fn((userId: number) => ({ id: userId, first_name: 'Felipe' }));
const mockGetUserTimezone = vi.fn(() => 'Europe/Lisbon');
const mockRuntimeStatus = vi.fn(() => ({
  serviceStatus: 'online',
  databaseStatus: 'connected',
  botStatus: 'offline',
  lastMessageAt: null,
}));
const mockDashboardDbAll = vi.fn(() => []);
const mockGetAllPendingTasks = vi.fn();
const mockGetDailyQuotaStatus = vi.fn(() => ({
  over: false,
  spentUsd: 0.12,
  capUsd: 0.2,
  plan: 'pro',
  usageLevel: 'enhanced',
  usageFraction: 0.6,
  callsToday: 3,
  boostAvailable: false,
  limitUsd: 0.2,
  usedUsd: 0.12,
  remainingUsd: 0.08,
  resetAt: '2026-04-15T00:00:00.000Z',
}));
const mockComposeDailyBrief = vi.fn();
vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
  getCachedSWR: (...args: unknown[]) => mockGetCachedSWR(...args),
  setCacheSWR: (...args: unknown[]) => mockSetCacheSWR(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  // Identity-safety: dashboard route uses the strict by-id helpers
  // (getUserLanguageById, getPreferredDisplayNameById,
  // getUserTimezoneById). Mocks expose both legacy and *ById names.
  getUserLanguage: () => 'pt-BR',
  getUserLanguageById: () => 'pt-BR',
  getPreferredDisplayName: () => 'Test User',
  getPreferredDisplayNameById: () => 'Test User',
  getUserTimezone: (...args: unknown[]) => mockGetUserTimezone(...args),
  getUserTimezoneById: (...args: unknown[]) => mockGetUserTimezone(...args),
}));

vi.mock('../../src/services/runtime-status', () => ({
  getRuntimeStatus: (...args: unknown[]) => mockRuntimeStatus(...args),
}));

vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: (...args: unknown[]) => mockCalculateReadiness(...args),
}));

vi.mock('../../src/services/google-calendar', () => ({
  isGoogleCalendarConfigured: (...args: unknown[]) => mockGoogleCalendarConfigured(...args),
  getEvents: (...args: unknown[]) => mockGoogleCalendarEvents(...args),
}));

vi.mock('../../src/services/outlook-calendar', () => ({
  isOutlookCalendarConfigured: (...args: unknown[]) => mockOutlookCalendarConfigured(...args),
  getEvents: (...args: unknown[]) => mockOutlookCalendarEvents(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  getDailyQuotaStatus: (...args: unknown[]) => mockGetDailyQuotaStatus(...args),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: () => ({
    getAllPendingTasks: (...args: unknown[]) => mockGetAllPendingTasks(...args),
  }),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => mockDashboardDbAll(sql, ...args),
      get: () => ({ ok: 1 }),
    }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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

import { dashboardRoutes } from '../../src/api/routes/dashboard';
import {
  mapDashboardTask,
  queryContentPipelineCounts,
} from '../../src/api/routes/dashboard-data-fetchers';

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
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { return r; },
  };
  return r;
}

function mockReq(userId: number, path = '/', headers: Record<string, string> = {}): Request {
  return {
    userId,
    headers,
    method: 'GET',
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as any;
}

async function dispatch(userId = 4, headers: Record<string, string> = {}, path = '/'): Promise<MockRes> {
  const router = dashboardRoutes();
  const req = mockReq(userId, path, headers);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatchUntilResponse(userId = 4, headers: Record<string, string> = {}, path = '/'): Promise<MockRes> {
  const router = dashboardRoutes();
  const req = mockReq(userId, path, headers);
  let res!: MockRes;

  await new Promise<void>((resolve, reject) => {
    res = {
      ...mockRes(),
      json(body: any) { res.body = body; resolve(); return res; },
      end() { resolve(); return res; },
    };
    (router as any).handle(req, res, (err: any) => {
      if (err) {
        reject(err);
        return;
      }
    });
  });

  return res;
}

function todayAt(hour: number, minute = 0): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${lookup.year}-${lookup.month}-${lookup.day}`;
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

describe('Dashboard API route', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockGetCachedSWR.mockReset();
    mockSetCacheSWR.mockReset();
    mockCalculateReadiness.mockReset();
    mockGoogleCalendarConfigured.mockReset();
    mockGoogleCalendarEvents.mockReset();
    mockOutlookCalendarConfigured.mockReset();
    mockOutlookCalendarEvents.mockReset();
    mockGetUserById.mockReset();
    mockGetUserTimezone.mockReset();
    mockRuntimeStatus.mockReset();
    mockDashboardDbAll.mockReset();
    mockGetAllPendingTasks.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetCachedSWR.mockReturnValue(null);
    mockCalculateReadiness.mockRejectedValue(new Error('readiness unavailable'));
    mockGoogleCalendarConfigured.mockReturnValue(false);
    mockGoogleCalendarEvents.mockResolvedValue([]);
    mockOutlookCalendarConfigured.mockReturnValue(false);
    mockOutlookCalendarEvents.mockResolvedValue([]);
    mockGetUserById.mockImplementation((userId: number) => ({ id: userId, first_name: 'Felipe' }));
    mockGetUserTimezone.mockReturnValue('Europe/Lisbon');
    mockRuntimeStatus.mockReturnValue({
      serviceStatus: 'online',
      databaseStatus: 'connected',
      botStatus: 'offline',
      lastMessageAt: null,
    });
    mockDashboardDbAll.mockReturnValue([]);
    mockGetAllPendingTasks.mockResolvedValue({ success: false, data: null });
    mockComposeDailyBrief.mockResolvedValue({
      creativeCopy: {
        headline: 'Hoje protegemos recuperação para sustentar consistência.',
        note: 'Treino e agenda foram coordenados para reduzir atrito.',
      },
      day: {
        headline: 'Hoje protegemos recuperação',
        training: {
          title: 'Corrida base',
          durationMinutes: 45,
          reason: 'A recuperação caiu, então o treino ficou mais leve.',
        },
        meals: [
          {
            title: 'Bowl de recuperação',
            note: 'Hoje · almoço',
          },
        ],
        content: {
          title: 'Janela de gravação na sexta',
          note: 'Só há treino leve planeado, por isso deve ser mais fácil filmar bem.',
          status: 'scheduled',
        },
        secretary: {
          focusBlock: null,
          pendingTasks: 2,
          overdueTasks: 0,
          busy: false,
          travel: false,
          tradeoffNote: 'Hoje vale preservar margem para sustentar a sessão-chave.',
          sequence: [],
        },
        finance: {
          budgetNote: '€ 239 gastos',
          taxNote: '€ 88 líquido',
          subscriptionNote: null,
        },
      },
      coordination: {
        topPriority: 'Proteger recuperação',
        executionOrder: [],
        watchouts: [],
        handoffs: [],
      },
      conflicts: [],
    });
  });

  it('returns explicit unavailable states instead of silent dashboard zeroes', async () => {
    const res = await dispatch(4);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.calendar.status).toBe('unavailable');
    expect(res.body.data.calendar.warningCodes).toEqual(['CALENDAR_INTEGRATION_MISSING']);
    expect(res.body.data.tasks.status).toBe('unavailable');
    expect(res.body.data.training.status).toBe('unavailable');
    expect(res.body.data.training.readinessStatus).toBe('unavailable');
    expect(res.body.data.training.bodyBatteryStatus).toBe('unavailable');
    expect(res.body.data.training.readinessScore).toBeNull();
    expect(res.body.data.training.bodyBattery).toBeNull();
    expect(res.body.data.quota).toEqual({
      used_usd: 0.12,
      limit_usd: 0.2,
      remaining_usd: 0.08,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });

  it('passes calendar event colors through the dashboard payload', async () => {
    mockOutlookCalendarConfigured.mockReturnValue(true);
    mockOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'evt-1',
        summary: 'Content block',
        start: todayAt(16),
        end: todayAt(16, 30),
        categories: ['Content'],
        color: '#8E44AD',
      },
    ]);

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.calendar.today[0]).toMatchObject({
      id: 'evt-1',
      source: 'outlook',
      color: '#8E44AD',
    });
  });

  it('keeps multi-day events that overlap the one-day dashboard window', async () => {
    mockGoogleCalendarConfigured.mockReturnValue(true);
    const today = DateTime.now().setZone('Europe/Lisbon');
    const eventStart = today.startOf('day').minus({ hours: 1 }).toUTC().toISO();
    const eventEnd = today.startOf('day').plus({ minutes: 30 }).toUTC().toISO();
    mockGoogleCalendarEvents.mockResolvedValue([
      {
        id: 'overnight',
        summary: 'Overnight travel',
        start: eventStart,
        end: eventEnd,
      },
    ]);

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.calendar.today).toEqual([
      expect.objectContaining({
        id: 'overnight',
        title: 'Overnight travel',
      }),
    ]);
  });

  it('sanitizes malformed dashboard event and task rows before returning them to iOS', async () => {
    mockOutlookCalendarConfigured.mockReturnValue(true);
    mockOutlookCalendarEvents.mockResolvedValue([
      {
        id: null,
        summary: 42,
        start: { raw: 'invalid' },
        end: undefined,
        categories: [99],
        color: 1234,
      },
    ]);
    mockGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: null,
          title: 77,
          body: { content: 123 },
          importance: 'urgent',
          status: '',
          dueDateTime: { dateTime: 999 },
          listId: 55,
          listName: false,
          createdDateTime: 321,
        },
      ],
    });

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.calendar.today[0]).toEqual({
      id: 'outlook:42::',
      title: '42',
      start: '',
      end: '',
      source: 'outlook',
      category: '99',
      color: '1234',
      isAllDay: false,
    });
    expect(mapDashboardTask({
      id: null,
      title: 77,
      body: { content: 123 },
      importance: 'urgent',
      status: '',
      dueDateTime: { dateTime: 999 },
      listId: 55,
      listName: false,
      createdDateTime: 321,
    })).toMatchObject({
      id: 'task:77:999',
      title: '77',
      body: '123',
      importance: 'normal',
      status: 'notStarted',
      dueDateTime: '999',
      listId: '55',
      listName: 'false',
      createdDateTime: '321',
    });
  });

  it('fails closed on invalid tenant scope before building dashboard state', async () => {
    const res = await dispatch(0);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetCachedSWR).not.toHaveBeenCalled();
    expect(mockGetDailyQuotaStatus).not.toHaveBeenCalledWith(0);

    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'dashboard_route_root',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('serves stale dashboard cache immediately and refreshes in the background', async () => {
    const cachedDashboard = {
      greeting: 'Bom dia, Felipe',
      date: '2026-04-16',
      dayOfWeek: 'Quinta-feira',
      calendar: { today: [], upcoming: [], status: 'ready', warningCodes: [], warnings: [] },
      tasks: { overdue: 1, dueToday: 2, totalPending: 3, topTasks: [], status: 'ready', warningCodes: [], warnings: [] },
      training: {
        todaySession: null,
        weeklyAdherence: null,
        readinessScore: 71,
        bodyBattery: 50,
        status: 'ready',
        readinessStatus: 'ready',
        bodyBatteryStatus: 'ready',
        warningCodes: [],
        warnings: [],
      },
      content: {
        pipelineCount: { ideas: 1, scripted: 0, filmed: 0, editing: 0, published: 0 },
        nextDeadline: null,
        status: 'ready',
        warningCodes: [],
        warnings: [],
      },
      quota: {
        used_usd: 0.12,
        limit_usd: 0.2,
        remaining_usd: 0.08,
        plan: 'pro',
        resetAt: '2026-04-15T00:00:00.000Z',
      },
      system: {
        version: '4.14.38',
        uptime: '1h 0m',
        serviceStatus: 'online',
        botStatus: 'offline',
        databaseStatus: 'connected',
        lastMessageAt: null,
      },
    };
    mockGetCachedSWR.mockReturnValue({ value: cachedDashboard, fresh: false });

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.greeting).toBe('Bom dia, Felipe');
    expect(res.body.data.tasks.totalPending).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSetCacheSWR).toHaveBeenCalled();
  });

  it('returns a render-ready home contract', async () => {
    mockOutlookCalendarConfigured.mockReturnValue(true);
    mockOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'evt-1',
        subject: 'Long Conditioning Session (60min)',
        start: { dateTime: todayAt(10) },
        end: { dateTime: todayAt(11) },
      },
    ]);

    const res = await dispatch(4, {}, '/home');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.hero.state).toBe('recoveryProtected');
    expect(res.body.data.hero.primaryAction.target).toBe('training');
    expect(Array.isArray(res.body.data.insights)).toBe(true);
    expect(res.body.data.metrics).toHaveLength(4);
    expect(res.body.data.secretaryPreview.items[0]?.title).toBe('Sessão longa de condicionamento (60min)');
    expect(res.body.data.coordinatedDecision.summary).toBe('Hoje protegemos recuperação para sustentar consistência.');
    expect(res.body.data.coordinatedDecision.stateLabel).toBe('Protege consistência');
    expect(res.body.data.coordinatedDecision.confidenceText).toBe('Confiança alta');
    expect(res.body.data.coordinatedDecision.protectedLater).toBeTruthy();
    expect(res.body.data.skillQueue[0]?.domain).toBe('training');
    expect(res.body.data.skillQueue[0]?.whyNow).toBeTruthy();
  });

  it('emits Server-Timing breakdowns for uncached dashboard and home reads', async () => {
    const dashboardRes = await dispatch(4);
    const homeRes = await dispatch(4, {}, '/home');

    expect(dashboardRes.statusCode).toBe(200);
    expect(dashboardRes.headers['Server-Timing']).toEqual(expect.stringContaining('calendar;dur='));
    expect(dashboardRes.headers['Server-Timing']).toEqual(expect.stringContaining('tasks;dur='));
    expect(dashboardRes.headers['Server-Timing']).toEqual(expect.stringContaining('training;dur='));
    expect(dashboardRes.headers['Server-Timing']).toEqual(expect.stringContaining('content;dur='));

    expect(homeRes.statusCode).toBe(200);
    expect(homeRes.headers['Server-Timing']).toEqual(expect.stringContaining('dashboard;dur='));
    expect(homeRes.headers['Server-Timing']).toEqual(expect.stringContaining('daily_brief;dur='));
    expect(homeRes.headers['Server-Timing']).toEqual(expect.stringContaining('home_view_state;dur='));
  });

  it('returns a partial home contract instead of waiting forever on slow providers', async () => {
    vi.useFakeTimers();
    mockGetAllPendingTasks.mockImplementation(() => new Promise(() => {}));
    mockComposeDailyBrief.mockImplementation(() => new Promise(() => {}));

    const pending = dispatchUntilResponse(4, {}, '/home');

    await vi.advanceTimersByTimeAsync(3100);
    const res = await pending;
    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.meta.reasonCodes).toContain('TASKS_UNAVAILABLE');
    expect(res.body.data.meta.reasonCodes).toContain('DAILY_BRIEF_UNAVAILABLE');
  });

  it('returns a client-safe error when the home dashboard aggregation throws unexpectedly', async () => {
    mockGetUserById.mockImplementation(() => {
      throw new Error('users lookup failed: leaked internal detail');
    });

    const res = await dispatch(4, {}, '/home');

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Unable to load the home briefing right now.',
    });
  });

  it('surfaces missing wearable integration honestly in dashboard and home meta', async () => {
    mockGetCached.mockImplementation((key: string) => {
      if (key === 'dashboard-readiness:4') {
        return {
          score: 60,
          bodyBattery: 0,
          reasonCode: 'WEARABLE_INTEGRATION_MISSING',
        };
      }
      return null;
    });

    const dashboardRes = await dispatch(4);
    expect(dashboardRes.statusCode).toBe(200);
    expect(dashboardRes.body.data.training.warningCodes).toContain('WEARABLE_INTEGRATION_MISSING');
    expect(dashboardRes.body.data.training.warningCodes).toContain('BODY_BATTERY_UNAVAILABLE');

    const homeRes = await dispatch(4, {}, '/home');
    expect(homeRes.statusCode).toBe(200);
    expect(homeRes.body.data.meta.reasonCodes).toContain('WEARABLE_INTEGRATION_MISSING');
  });

  it('does not flag Google Calendar as unavailable when the current user has Google connected', async () => {
    mockGoogleCalendarConfigured.mockImplementation((userId?: number) => userId === 4);
    mockGoogleCalendarEvents.mockResolvedValue([]);

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.calendar.status).toBe('ready');
    expect(res.body.data.calendar.warningCodes).not.toContain('GOOGLE_CALENDAR_UNAVAILABLE');
    expect(mockGoogleCalendarConfigured).toHaveBeenCalledWith(4);
    expect(mockGoogleCalendarEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 4);
  });

  it('marks calendar unavailable when every configured provider rejects', async () => {
    mockGoogleCalendarConfigured.mockReturnValue(true);
    mockOutlookCalendarConfigured.mockReturnValue(true);
    mockGoogleCalendarEvents.mockRejectedValue(new Error('google outage'));
    mockOutlookCalendarEvents.mockRejectedValue(new Error('outlook outage'));

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.calendar.status).toBe('unavailable');
    expect(res.body.data.calendar.today).toEqual([]);
    expect(res.body.data.calendar.warningCodes).toEqual(expect.arrayContaining([
      'GOOGLE_CALENDAR_UNAVAILABLE',
      'OUTLOOK_CALENDAR_UNAVAILABLE',
    ]));
  });

  it('surfaces missing calendar integration honestly when no calendar is connected', async () => {
    mockGoogleCalendarConfigured.mockReturnValue(false);
    mockOutlookCalendarConfigured.mockReturnValue(false);

    const dashboardRes = await dispatch(4);
    expect(dashboardRes.statusCode).toBe(200);
    expect(dashboardRes.body.data.calendar.warningCodes).toContain('CALENDAR_INTEGRATION_MISSING');
    expect(dashboardRes.body.data.calendar.warningCodes).not.toContain('CALENDAR_UNAVAILABLE');

    const homeRes = await dispatch(4, {}, '/home');
    expect(homeRes.statusCode).toBe(200);
    expect(homeRes.body.data.meta.reasonCodes).toContain('CALENDAR_INTEGRATION_MISSING');
    expect(homeRes.body.data.meta.reasonCodes).not.toContain('CALENDAR_UNAVAILABLE');
  });

  it('localizes greeting and weekday when x-language is Portuguese', async () => {
    const res = await dispatch(4, { 'x-language': 'pt-BR' });

    expect(res.statusCode).toBe(200);
    // Identity-safety (May 2026 audit): the greeting must NEVER hardcode
    // "Felipe". The display-name suffix should be derived from the
    // authenticated user's saved profile (here mocked to "Test User"),
    // and the bare greeting is acceptable when the profile has no name.
    expect(res.body.data.greeting).toMatch(/^(Bom dia|Boa tarde|Boa noite)(,\s+\S.*)?$/);
    expect(res.body.data.greeting).not.toContain('Felipe');
    expect([
      'Segunda-feira',
      'Terça-feira',
      'Quarta-feira',
      'Quinta-feira',
      'Sexta-feira',
      'Sábado',
      'Domingo',
    ]).toContain(res.body.data.dayOfWeek);
  });

  it('uses the Brazilian Portuguese locale when the request language is pt-BR', async () => {
    const original = Date.prototype.toLocaleDateString;
    const localeSpy = vi.spyOn(Date.prototype, 'toLocaleDateString')
      .mockImplementation(function (
        this: Date,
        locale?: string | string[],
        options?: Intl.DateTimeFormatOptions,
      ) {
        if (options?.weekday === 'long') {
          return 'sexta-feira';
        }
        return original.call(this, locale as any, options as any);
      });

    try {
      const res = await dispatch(4, { 'x-language': 'pt-BR' });

      expect(res.statusCode).toBe(200);
      expect(localeSpy).toHaveBeenCalledWith('pt-BR', expect.objectContaining({
        weekday: 'long',
        timeZone: 'Europe/Lisbon',
      }));
    } finally {
      localeSpy.mockRestore();
    }
  });

  it('marks content as unavailable instead of returning fake zero pipeline counts on database failure', async () => {
    mockDashboardDbAll.mockImplementation((sql: string) => {
      if (sql.includes('FROM content_ideas')) {
        throw new Error('database unavailable');
      }
      return [];
    });

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.content.status).toBe('unavailable');
    expect(res.body.data.content.warningCodes).toEqual(['CONTENT_UNAVAILABLE']);
    expect(res.body.data.content.pipelineCount).toEqual({
      ideas: 0,
      scripted: 0,
      filmed: 0,
      editing: 0,
      published: 0,
    });
  });

  it('uses a dedicated dashboard readiness cache key for body battery snapshots', async () => {
    mockGetCached.mockImplementation((key: string) => {
      if (key === 'dashboard-readiness:4') {
        return { score: 71, bodyBattery: 57 };
      }
      return null;
    });

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(mockGetCached).toHaveBeenCalledWith('dashboard-readiness:4');
    expect(res.body.data.training.bodyBattery).toBe(57);
  });

  it('falls back to stage-only content counts when the legacy status column is missing', () => {
    const db = {
      prepare(sql: string) {
        return {
          all: () => {
            if (sql.includes("status != 'archived'")) {
              throw new Error('no such column: status');
            }
            return [
              { stage: 'ideas', count: 2 },
              { stage: 'published', count: 1 },
            ];
          },
        };
      },
    };

    expect(queryContentPipelineCounts(db, 4)).toEqual([
      { stage: 'ideas', count: 2 },
      { stage: 'published', count: 1 },
    ]);
  });

  it('rethrows non-schema content query failures', () => {
    const db = {
      prepare() {
        return {
          all: () => {
            throw new Error('database unavailable');
          },
        };
      },
    };

    expect(() => queryContentPipelineCounts(db, 4)).toThrow('database unavailable');
  });

  it('treats a missing content_ideas table as an empty pipeline instead of an outage', () => {
    const db = {
      prepare() {
        return {
          all: () => {
            throw new Error('no such table: content_ideas');
          },
        };
      },
    };

    expect(queryContentPipelineCounts(db, 4)).toEqual([]);
  });
});
