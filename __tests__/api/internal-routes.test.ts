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
import { computeModelUsageCostUsd } from '../../src/services/model-pricing';

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
    expect(routesSrc).toContain('withAiBudgetReservation');
    expect(routesSrc).toContain('withSignedOuterAiBudgetReservation');
    expect(routesSrc).toContain('sendAiBudgetError');
  });

  it('bounds internal generation and usage inputs before quota truth or provider calls', () => {
    expect(routesSrc).toContain('normalizeInternalCategory');
    expect(routesSrc).toContain('normalizeNonNegativeInteger');
    expect(routesSrc).toContain('normalizePositiveInteger(rawMaxTokens, 32_768)');
    expect(routesSrc).toContain('normalizeFiniteNumber(rawTemperature, 0, 2)');
    expect(routesSrc).toContain("sendError(res, 'BAD_REQUEST', 'invalid usage fields', 400)");
  });

  it('ai-complete passes long-running content timeouts and JSON mode into the provider cascade', () => {
    expect(routesSrc).toContain('function resolveInternalAiTimeoutMs');
    expect(routesSrc).toContain("content_engine_script");
    expect(routesSrc).toContain("content_engine_deepsearch");
    expect(routesSrc).toContain('timeoutMs: resolveInternalAiTimeoutMs(category, maxTokens)');
    expect(routesSrc).toContain('jsonMode,');
  });

  it('binds both local-primary and legacy cloud completions to the Content Engine connection', () => {
    expect(routesSrc).toContain('const requestAbortController = new AbortController();');
    expect(routesSrc).toContain("req.once('aborted', abortForDisconnectedContentEngine);");
    expect(routesSrc).toContain("res.once('close', abortForDisconnectedContentEngine);");
    expect(routesSrc).toContain('abortSignal: activeAbortSignal');
    expect(routesSrc).toContain('runWithSkillInferenceAccountAdmission({');
    expect(routesSrc).toContain('isProviderRequestCancellation(err)');
  });

  it('keeps mixed-trust content-engine guidance out of the provider system instruction', () => {
    expect(routesSrc).toContain('INTERNAL_AI_PROXY_SYSTEM_INSTRUCTION');
    expect(routesSrc).toContain('buildInternalAiProxyUserPrompt(system, prompt, jsonMode)');
    expect(routesSrc).toContain('applicationGuidance: system || null');
    expect(routesSrc).toContain('system: INTERNAL_AI_PROXY_SYSTEM_INSTRUCTION');
    expect(routesSrc).not.toContain('system: system || undefined');
    expect(routesSrc).not.toContain('system, // lgtm[js/system-prompt-injection]');
  });

  it('fails signed live-evaluation traffic outside its fixed input/output envelope before provider routing', () => {
    expect(routesSrc).toContain("outerReservation?.baseCategory === 'content_live_eval'");
    expect(routesSrc).toContain('contentLiveEvalInternalEnvelopeWithinLimits');
    expect(routesSrc).toContain('No model call was made.');
  });

  it('ai-complete strips body-supplied user and tenant metadata before provider usage attribution', () => {
    expect(routesSrc).toContain('userId?: number');
    expect(routesSrc).toContain('tenantId?: number');
    expect(routesSrc).toContain('attributionToken?: string');
    expect(routesSrc).toContain('verifyInternalAttributionToken');
    expect(routesSrc).toContain('const scopedUserId = verifiedAttribution?.userId ?? 0;');
    expect(routesSrc).toContain('const scopedTenantId = verifiedAttribution?.tenantId ?? 0;');
    expect(routesSrc).toContain('Ignoring body-supplied internal AI attribution; billing as system usage');
    expect(routesSrc).toContain('body scope ignored in favor of signed claims');
    expect(routesSrc).toContain('userId: scopedUserId');
    expect(routesSrc).toContain('tenantId: scopedTenantId');
  });

  it('defines anthropic-enabled endpoint', () => {
    expect(routesSrc).toContain("router.get('/anthropic-enabled'");
    expect(routesSrc).toContain('canUseAnthropicRuntimeFallback');
  });

  it('defines performance-summary endpoint', () => {
    expect(routesSrc).toContain("router.get('/performance-summary'");
  });

  it('validates x-internal-secret header', () => {
    expect(routesSrc).toContain('x-internal-secret');
    expect(routesSrc).toContain('403');
  });

  it('requires loopback origin by default before internal secret auth', () => {
    expect(routesSrc).toContain("INTERNAL_REQUIRE_LOOPBACK !== 'false'");
    expect(routesSrc).toContain('isLoopbackRequest(req)');
    expect(routesSrc).toContain('Internal API requires loopback origin');
  });

  it('records usage via recordUsage from usage-metering', () => {
    expect(routesSrc).toContain('recordUsage');
  });

  it('report-usage uses signed attribution instead of hardcoding system billing', () => {
    expect(routesSrc).toContain('verifyInternalAttributionToken(attributionToken, category)');
    expect(routesSrc).toContain('category, model, tenant_id, user_id, input_tokens, output_tokens');
    expect(routesSrc).toContain('category, model, scopedTenantId, scopedUserId');
    expect(routesSrc).toContain('insertApiUsageFallback');
    expect(routesSrc).toContain('recordUsage(scopedUserId');
    expect(routesSrc).not.toContain('VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)');
    expect(routesSrc).not.toContain('recordUsage(0, inputTokens');
  });

  it('pushes telemetry events', () => {
    expect(routesSrc).toContain('pushEvent');
  });
});

describe('Internal Routes — cost computation logic', () => {
  function computeCost(model: string, inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0): number {
    return computeModelUsageCostUsd(model, {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    }, 'anthropic').costUsd;
  }

  it('computes Haiku cost correctly', () => {
    // 1M input × $1.00 + 1M output × $5.00 = $6.00
    expect(computeCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBeCloseTo(6.00);
  });

  it('computes Sonnet cost correctly', () => {
    // 1M input × $3.00 + 1M output × $15.00 = $18.00
    expect(computeCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18.00);
  });

  it('includes cache token costs', () => {
    const withoutCache = computeCost('claude-sonnet-4-6', 500_000, 500_000);
    const withCache = computeCost('claude-sonnet-4-6', 500_000, 500_000, 100_000, 50_000);
    expect(withoutCache).toBeCloseTo(9.00);
    expect(withCache).toBeCloseTo(8.7675);
    expect(withCache).toBeLessThan(withoutCache);
  });

  it('charges the unresolved sentinel instead of silently falling back to another model key', () => {
    const unknown = computeCost('unknown-model', 1_000_000, 1_000_000);
    expect(unknown).toBeCloseTo(18.00);
  });
});

describe('Router registration', () => {
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'api', 'router.ts'),
    'utf-8',
  );
  const internalRoutesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'api', 'routes', 'internal.ts'),
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

  it('mounts internal abuse controls before every expensive internal handler', () => {
    const sharedLimiter = internalRoutesSrc.indexOf('router.use(internalRateLimitMiddleware);');
    const secretGuard = internalRoutesSrc.indexOf('router.use((req: Request, res: Response, next) =>');
    const reportUsage = internalRoutesSrc.indexOf("router.post('/report-usage'");
    const aiComplete = internalRoutesSrc.indexOf("router.post('/ai-complete', internalAiCompleteRateLimitMiddleware");
    const performanceSummary = internalRoutesSrc.indexOf("router.get('/performance-summary'");

    expect(sharedLimiter).toBeGreaterThan(0);
    expect(secretGuard).toBeGreaterThan(sharedLimiter);
    expect(reportUsage).toBeGreaterThan(secretGuard);
    expect(aiComplete).toBeGreaterThan(secretGuard);
    expect(performanceSummary).toBeGreaterThan(secretGuard);
  });
});
