// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type RequestTimerModule = typeof import('../../src/api/request-timer');

let requestTimer: RequestTimerModule;
let clockMs: number;

async function recordRequest(input: {
  path: string;
  statusCode: number;
  durationMs: number;
}): Promise<void> {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = input.statusCode;
  const startedAt = clockMs;
  vi.spyOn(Date, 'now')
    .mockReturnValueOnce(startedAt)
    .mockReturnValueOnce(startedAt + input.durationMs);

  requestTimer.requestTimerMiddleware(
    { path: input.path, method: 'GET' } as never,
    response as never,
    () => undefined,
  );
  response.emit('finish');
  vi.restoreAllMocks();
  clockMs += 1_000;
}

describe('request timer local-inference rollout evidence', () => {
  beforeEach(async () => {
    vi.resetModules();
    requestTimer = await import('../../src/api/request-timer');
    clockMs = Date.parse('2026-08-12T10:00:00.000Z');
  });

  it('separates collateral non-AI latency from public end-user 5xx evidence', async () => {
    await recordRequest({ path: '/api/v1/tasks/1', statusCode: 200, durationMs: 10 });
    await recordRequest({ path: '/api/v1/tasks/2', statusCode: 500, durationMs: 20 });
    await recordRequest({ path: '/api/v1/chat/message', statusCode: 500, durationMs: 30 });
    await recordRequest({ path: '/api/v1/internal/ai-complete', statusCode: 500, durationMs: 40 });
    await recordRequest({ path: '/api/v1/admin/local-inference/summary', statusCode: 500, durationMs: 50 });
    await recordRequest({ path: '/api/v1/content/script', statusCode: 429, durationMs: 60 });

    expect(requestTimer.getNonAiLatencySnapshot()).toMatchObject({
      sampleCount: 3,
      p95Ms: 50,
    });
    expect(requestTimer.getEndUserApiErrorSnapshot()).toMatchObject({
      sampleCount: 4,
      serverErrorCount: 2,
      serverErrorRatePercent: 50,
    });
  });

  it('applies the rollout-window timestamp boundary', async () => {
    await recordRequest({ path: '/api/v1/tasks/1', statusCode: 500, durationMs: 25 });
    const boundary = new Date(clockMs).toISOString();
    await recordRequest({ path: '/api/v1/dashboard', statusCode: 200, durationMs: 15 });

    expect(requestTimer.getNonAiLatencySnapshot(boundary)).toMatchObject({
      sampleCount: 1,
      p95Ms: 15,
    });
    expect(requestTimer.getEndUserApiErrorSnapshot(boundary)).toMatchObject({
      sampleCount: 1,
      serverErrorCount: 0,
      serverErrorRatePercent: 0,
    });
  });
});
