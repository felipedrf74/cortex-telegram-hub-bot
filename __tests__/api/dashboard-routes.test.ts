import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
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
const mockRuntimeStatus = vi.fn(() => ({
  serviceStatus: 'online',
  databaseStatus: 'connected',
  botStatus: 'offline',
  lastMessageAt: null,
}));
const mockDashboardDbAll = vi.fn(() => []);
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
  getUserLanguage: () => 'pt-BR',
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

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => mockDashboardDbAll(sql, ...args),
      get: () => ({ ok: 1 }),
    }),
  }),
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

import { dashboardRoutes, queryContentPipelineCounts } from '../../src/api/routes/dashboard';

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
    mockRuntimeStatus.mockReset();
    mockDashboardDbAll.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetCachedSWR.mockReturnValue(null);
    mockCalculateReadiness.mockRejectedValue(new Error('readiness unavailable'));
    mockGoogleCalendarConfigured.mockReturnValue(false);
    mockGoogleCalendarEvents.mockResolvedValue([]);
    mockOutlookCalendarConfigured.mockReturnValue(false);
    mockOutlookCalendarEvents.mockResolvedValue([]);
    mockGetUserById.mockImplementation((userId: number) => ({ id: userId, first_name: 'Felipe' }));
    mockRuntimeStatus.mockReturnValue({
      serviceStatus: 'online',
      databaseStatus: 'connected',
      botStatus: 'offline',
      lastMessageAt: null,
    });
    mockDashboardDbAll.mockReturnValue([]);
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
        start: '2026-04-19T16:00:00.000Z',
        end: '2026-04-19T16:30:00.000Z',
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
        start: { dateTime: '2026-04-18T10:00:00.000Z' },
        end: { dateTime: '2026-04-18T11:00:00.000Z' },
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
    expect(res.body.data.greeting).toMatch(/^(Bom dia|Boa tarde|Boa noite)(, Felipe)?$/);
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
