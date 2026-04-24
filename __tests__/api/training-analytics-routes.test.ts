import { Router } from 'express';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockGetCardioProgression = vi.fn();
const mockGetStrengthProgression = vi.fn();
const mockGetUnifiedWeeklyActivitySummary = vi.fn();
const mockPublishAdherenceSignalsForUser = vi.fn();
const mockPublishPlanDriftSignalForUser = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/services/progression-analytics', () => ({
  getCardioProgression: (...args: unknown[]) => mockGetCardioProgression(...args),
  getStrengthProgression: (...args: unknown[]) => mockGetStrengthProgression(...args),
}));

vi.mock('../../src/services/session-analytics', () => ({
  getUnifiedWeeklyActivitySummary: (...args: unknown[]) => mockGetUnifiedWeeklyActivitySummary(...args),
}));

vi.mock('../../src/services/adherence-signals', () => ({
  publishAdherenceSignalsForUser: (...args: unknown[]) => mockPublishAdherenceSignalsForUser(...args),
  publishPlanDriftSignalForUser: (...args: unknown[]) => mockPublishPlanDriftSignalForUser(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import {
  registerTrainingAnalyticsRoutes,
  type TrainingLanguageResolver,
} from '../../src/api/routes/training-analytics-routes';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(method: string, path: string, query: Record<string, any>, userId = 12): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    headers: {},
    header: () => undefined,
    body: undefined,
    userId,
  } as any;
}

async function dispatch(
  path: string,
  query: Record<string, any> = {},
  language: ReturnType<TrainingLanguageResolver> = 'en-US',
): Promise<MockRes> {
  const router = Router();
  registerTrainingAnalyticsRoutes(router, (() => language) as TrainingLanguageResolver);
  const req = mockReq('GET', path, query);
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

describe('training analytics route registrar', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockGetCardioProgression.mockReset();
    mockGetStrengthProgression.mockReset();
    mockGetUnifiedWeeklyActivitySummary.mockReset();
    mockPublishAdherenceSignalsForUser.mockReset();
    mockPublishPlanDriftSignalForUser.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetCardioProgression.mockReturnValue({
      userId: 12,
      sport: 'running',
      windowWeeks: 8,
      weeks: [],
    });
    mockGetStrengthProgression.mockReturnValue({
      userId: 12,
      windowWeeks: 8,
      lifts: [],
    });
    mockGetUnifiedWeeklyActivitySummary.mockResolvedValue({
      userId: 12,
      totalCompletions: 2,
      totalDurationMin: 90,
      bySport: {},
    });
  });

  it('localizes cardio progression validation without touching analytics services', async () => {
    const res = await dispatch('/progression/cardio', { sport: 'swimming' }, 'pt-BR');

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'o parâmetro sport deve ser "running" ou "cycling"',
    });
    expect(mockGetCardioProgression).not.toHaveBeenCalled();
  });

  it('clamps cardio lookback and caches the report', async () => {
    const res = await dispatch('/progression/cardio', { sport: 'running', weeks: '999' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockGetCardioProgression).toHaveBeenCalledWith(12, 'running', 52);
    expect(mockSetCache).toHaveBeenCalledWith('cardio-progression:12:running:52', res.body.data, 120);
  });

  it('returns cached strength progression without recomputing', async () => {
    mockGetCached.mockReturnValueOnce({ userId: 12, windowWeeks: 4, lifts: [{ lift: 'Back Squat' }] });

    const res = await dispatch('/progression/strength', { weeks: '4' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cached).toBe(true);
    expect(res.body.data.lifts[0].lift).toBe('Back Squat');
    expect(mockGetStrengthProgression).not.toHaveBeenCalled();
  });

  it('returns weekly activity even when best-effort signal publishing fails', async () => {
    mockPublishAdherenceSignalsForUser.mockImplementation(() => {
      throw new Error('bus unavailable');
    });

    const res = await dispatch('/activity/weekly');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.totalCompletions).toBe(2);
    expect(mockGetUnifiedWeeklyActivitySummary).toHaveBeenCalledWith(12);
    expect(mockPublishAdherenceSignalsForUser).toHaveBeenCalledWith(12);
    expect(mockPublishPlanDriftSignalForUser).toHaveBeenCalledWith(12);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 12 }),
      'adherence signal publish failed — summary still returned',
    );
    expect(mockSetCache).toHaveBeenCalledWith('training-activity-weekly:12', res.body.data, 60);
  });
});
