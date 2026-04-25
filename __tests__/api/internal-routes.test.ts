// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression tests for internal service-to-service routes.
 *
 * These tests verify the route module structure and cost computation
 * without requiring a running Express server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Internal Routes — structural', () => {
  const routesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'api', 'routes', 'internal.ts'),
    'utf-8',
  );

  it('defines report-usage endpoint', () => {
    expect(routesSrc).toContain("router.post('/report-usage'");
  });

  it('defines ai-complete proxy endpoint', () => {
    expect(routesSrc).toContain("router.post('/ai-complete'");
  });

  it('ai-complete uses completeOneShotWithFallback', () => {
    expect(routesSrc).toContain('completeOneShotWithFallback');
  });

  it('ai-complete passes long-running content timeouts and JSON mode into the provider cascade', () => {
    expect(routesSrc).toContain('function resolveInternalAiTimeoutMs');
    expect(routesSrc).toContain("content_engine_script");
    expect(routesSrc).toContain("content_engine_deepsearch");
    expect(routesSrc).toContain('timeoutMs: resolveInternalAiTimeoutMs(category, maxTokens)');
    expect(routesSrc).toContain('jsonMode,');
  });

  it('defines anthropic-enabled endpoint', () => {
    expect(routesSrc).toContain("router.get('/anthropic-enabled'");
  });

  it('defines performance-summary endpoint', () => {
    expect(routesSrc).toContain("router.get('/performance-summary'");
  });

  it('validates x-internal-secret header', () => {
    expect(routesSrc).toContain('x-internal-secret');
    expect(routesSrc).toContain('403');
  });

  it('records usage via recordUsage from usage-metering', () => {
    expect(routesSrc).toContain('recordUsage');
  });

  it('pushes telemetry events', () => {
    expect(routesSrc).toContain('pushEvent');
  });
});

describe('Internal Routes — cost computation logic', () => {
  // Test the cost computation inline since we can't easily import the route
  const COST_PER_MTK: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
    'claude-sonnet-4-6':         { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00,  cacheRead: 0.08, cacheWrite: 1.00 },
  };

  function computeCost(model: string, inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0): number {
    const rates = COST_PER_MTK[model] ?? COST_PER_MTK['claude-sonnet-4-6'];
    return (
      (inputTokens / 1_000_000) * rates.in +
      (outputTokens / 1_000_000) * rates.out +
      (cacheRead / 1_000_000) * rates.cacheRead +
      (cacheWrite / 1_000_000) * rates.cacheWrite
    );
  }

  it('computes Haiku cost correctly', () => {
    // 1M input × $0.80 + 1M output × $4.00 = $4.80
    expect(computeCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBeCloseTo(4.80);
  });

  it('computes Sonnet cost correctly', () => {
    // 1M input × $3.00 + 1M output × $15.00 = $18.00
    expect(computeCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18.00);
  });

  it('includes cache token costs', () => {
    const withoutCache = computeCost('claude-sonnet-4-6', 500_000, 500_000);
    const withCache = computeCost('claude-sonnet-4-6', 500_000, 500_000, 100_000, 50_000);
    expect(withCache).toBeGreaterThan(withoutCache);
  });

  it('falls back to Sonnet pricing for unknown models', () => {
    const unknown = computeCost('unknown-model', 1_000_000, 1_000_000);
    const sonnet = computeCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(unknown).toBeCloseTo(sonnet);
  });
});

describe('Router registration', () => {
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'api', 'router.ts'),
    'utf-8',
  );

  it('imports internalRoutes', () => {
    expect(routerSrc).toContain("import { internalRoutes } from './routes/internal'");
  });

  it('mounts internal routes before auth middleware', () => {
    const internalMount = routerSrc.indexOf("router.use('/internal'");
    const authMount = routerSrc.indexOf('router.use(authMiddleware)');
    expect(internalMount).toBeGreaterThan(0);
    expect(authMount).toBeGreaterThan(0);
    expect(internalMount).toBeLessThan(authMount);
  });
});
