import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockGetPendingOnboardings = vi.fn();
const mockGetAllQuestionnaires = vi.fn();
const mockGetQuestionnaire = vi.fn();
const mockGetProfile = vi.fn();
const mockStartOrResume = vi.fn();
const mockAnswerStep = vi.fn();
const mockUpsertProfileField = vi.fn();
const mockGetMissingProfileFields = vi.fn();

vi.mock('../../src/services/onboarding', () => ({
  getPendingOnboardings: (...args: unknown[]) => mockGetPendingOnboardings(...args),
  getAllQuestionnaires: (...args: unknown[]) => mockGetAllQuestionnaires(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  startOrResume: (...args: unknown[]) => mockStartOrResume(...args),
  answerStep: (...args: unknown[]) => mockAnswerStep(...args),
  upsertProfileField: (...args: unknown[]) => mockUpsertProfileField(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
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

import { onboardingRoutes } from '../../src/api/routes/onboarding';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
  };
  return res;
}

async function dispatch(method: 'GET' | 'POST', url: string, userId = 22, body?: any): Promise<MockRes> {
  const router = onboardingRoutes();
  const req = {
    userId,
    body: body ?? {},
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    query: {},
    params: {},
    headers: {},
  } as unknown as Request;

  if (url !== '/pending' && !url.startsWith('/profile')) {
    const [questionnaireId] = url.split('/').filter(Boolean);
    (req as any).params.questionnaireId = questionnaireId;
  }

  const res = mockRes();
  await new Promise<void>((resolve) => {
    (router as any).handle(req, res as unknown as Response, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });
  return res;
}

describe('Onboarding degraded route support', () => {
  beforeEach(() => {
    mockGetPendingOnboardings.mockReset();
    mockGetAllQuestionnaires.mockReset();
    mockGetQuestionnaire.mockReset();
    mockGetProfile.mockReset();
    mockStartOrResume.mockReset();
    mockAnswerStep.mockReset();
    mockUpsertProfileField.mockReset();
    mockGetMissingProfileFields.mockReset();
  });

  it('returns a degraded pending state instead of a misleading empty-success when pending onboarding fails', async () => {
    mockGetPendingOnboardings.mockImplementation(() => {
      throw new Error('onboarding store unavailable');
    });

    const res = await dispatch('GET', '/pending');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({
      questionnaires: [],
      status: 'degraded',
      warningCodes: ['ONBOARDING_PENDING_UNAVAILABLE'],
      warnings: ['Unable to load pending onboarding right now.'],
    });
  });

  it('returns a degraded profile inventory state instead of pretending the user has no profiles', async () => {
    mockGetAllQuestionnaires.mockImplementation(() => {
      throw new Error('questionnaire registry unavailable');
    });

    const res = await dispatch('GET', '/profile');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({
      profiles: [],
      status: 'degraded',
      warningCodes: ['ONBOARDING_PROFILE_UNAVAILABLE'],
      warnings: ['Unable to load onboarding profiles right now.'],
    });
  });
});
