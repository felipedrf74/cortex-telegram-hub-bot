import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import fs from 'fs';
import path from 'path';

const mockGetScript = vi.fn(async () => ({
  topic: 'Test topic',
  script: '[0:00] Test script',
  hook: 'Test hook',
  title_options: ['Title A', 'Title B', 'Title C'],
  sources_used: [],
  estimated_duration: '10:00',
  duration_ms: 1200,
  hashtags: ['#test'],
  caption: 'Caption',
  cta: 'CTA',
  degraded: false,
  warnings: [],
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

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: vi.fn(() => ({
    over: false,
    spentUsd: 0,
    capUsd: 0.2,
    plan: 'pro',
    resetAt: '2026-04-15T00:00:00.000Z',
  })),
  buildQuotaExceededMessage: vi.fn(() => 'quota exceeded'),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: vi.fn(() => 'pt-BR'),
}));

vi.mock('../../src/state/content-references', () => ({
  getKnowledgeByCategory: vi.fn(() => null),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: vi.fn(() => null),
      all: vi.fn(() => []),
      run: vi.fn(),
    }),
  }),
}));

vi.mock('../../src/services/content-engine', () => ({
  getScript: (...args: unknown[]) => mockGetScript(...args),
}));

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(body: any): Request {
  return {
    method: 'POST',
    url: '/script',
    originalUrl: '/script',
    baseUrl: '',
    path: '/script',
    query: {},
    params: {},
    headers: {},
    body,
    userId: 12,
  } as any;
}

async function dispatch(body: any): Promise<MockRes> {
  const { contentRoutes } = await import('../../src/api/routes/content');
  const router = contentRoutes();
  const req = mockReq(body);
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

describe('Content API — script duration presets', () => {
  beforeEach(() => {
    mockGetScript.mockClear();
  });

  it('rejects unsupported short durations', async () => {
    const response = await dispatch({
      topic: 'Fast AI automation tip',
      format: 'Reel',
      targetDurationSeconds: 20,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toContain('15, 30, 45, or 60 seconds');
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('rejects unsupported YouTube duration presets', async () => {
    const response = await dispatch({
      topic: 'Build a SaaS product solo',
      format: 'YouTube',
      maxDurationMinutes: 12,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toContain('8, 10, or 15');
    expect(mockGetScript).not.toHaveBeenCalled();
  });

  it('content route resolves and forwards first-party topic context into canonical script generation', async () => {
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content.ts'),
      'utf8',
    );

    expect(routeSource).toContain('function resolveScriptTopicContext(');
    expect(routeSource).toContain('parseOptionalPositiveId(raw.pipelineId)');
    expect(routeSource).toContain('parseOptionalPositiveId(raw.topicFeedbackId)');
    expect(routeSource).toContain('parseOptionalPositiveId(raw.ideaId)');
    expect(routeSource).toContain('const scriptTopicContext = resolveScriptTopicContext(userId, req.body || {});');
    expect(routeSource).toContain("scriptTopicContext?.niche || niche || 'general'");
    expect(routeSource).toContain('durationPreset.targetDurationSeconds,');
    expect(routeSource).toContain('scriptTopicContext,');
  });
});
