// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Internal routes — service-to-service endpoints used by the Python
 * content-engine to report data back to the TS backend.
 *
 * These routes are NOT behind JWT auth. Instead they validate a shared
 * secret (`INTERNAL_API_SECRET`) that both processes read from the same
 * .env file. If the secret is unset, the routes reject all requests.
 *
 * Mount BEFORE authMiddleware in router.ts.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { sendError } from '../response-helpers';
import { secureSecretMatches } from '../secret-guards';
import {
  internalAiCompleteRateLimitMiddleware,
  internalRateLimitMiddleware,
} from '../rate-limiter';
import { getOwnerBootstrapTarget } from '../../services/user-service';
import { getPerformanceSummary } from '../../services/content-learning-store';
import { isAnthropicRuntimeEnabled } from '../../services/runtime-flags';

function resolveInternalAiTimeoutMs(category: string, maxTokens: number): number | undefined {
  const normalized = String(category || '').toLowerCase();
  if (normalized.startsWith('content_engine_script')) return 180_000;
  if (normalized.startsWith('content_engine_deepsearch')) return 180_000;
  if (normalized.startsWith('content_engine')) return Math.max(90_000, Math.min(180_000, maxTokens * 25));
  return undefined;
}

export function internalRoutes(): Router {
  const router = Router();

  // Abuse protection comes BEFORE shared-secret validation so bad callers
  // cannot brute-force the secret or flood the expensive internal proxy
  // endpoints without spending a bounded IP budget.
  router.use(internalRateLimitMiddleware);

  // ── Shared-secret auth gate ───────────────────────────────────────
  const secret = process.env.INTERNAL_API_SECRET || '';

  router.use((req: Request, res: Response, next) => {
    const provided = req.headers['x-internal-secret'] as string | undefined;
    if (!secret || !secureSecretMatches(secret, provided)) {
      // Canonical error envelope. Python content-engine only checks
      // status code and logs raw response text, so the body shape here
      // only needs to match the iOS contract used everywhere else.
      sendError(res, 'FORBIDDEN', 'Missing or invalid internal API secret', 403);
      return;
    }
    next();
  });

  // ── POST /api/v1/internal/report-usage ────────────────────────────
  //
  // Called by the Python content-engine after each Anthropic API call
  // so usage appears in the same api_usage + usage_metering tables as
  // TS-originated calls.
  //
  // Body: {
  //   category: string,   // e.g. "content_engine_script", "content_engine_book"
  //   model: string,      // e.g. "claude-haiku-4-5-20251001"
  //   inputTokens: number,
  //   outputTokens: number,
  //   cacheReadTokens?: number,
  //   cacheWriteTokens?: number,
  //   durationMs: number,
  //   requestId?: string, // for tracing
  // }
  router.post('/report-usage', (req: Request, res: Response) => {
    try {
      const {
        category, model,
        inputTokens, outputTokens,
        cacheReadTokens = 0, cacheWriteTokens = 0,
        durationMs,
      } = req.body;

      if (!category || !model || inputTokens == null || outputTokens == null) {
        sendError(res, 'BAD_REQUEST', 'missing required fields', 400);
        return;
      }

      // Compute cost using the same pricing table as anthropic-hook.ts
      const COST_PER_MTK: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
        'claude-sonnet-4-6':         { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
        'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00,  cacheRead: 0.08, cacheWrite: 1.00 },
      };

      const rates = COST_PER_MTK[model] ?? COST_PER_MTK['claude-sonnet-4-6'];
      const cost =
        (inputTokens / 1_000_000) * rates.in +
        (outputTokens / 1_000_000) * rates.out +
        (cacheReadTokens / 1_000_000) * rates.cacheRead +
        (cacheWriteTokens / 1_000_000) * rates.cacheWrite;

      // Write to api_usage table (same as anthropic-hook.ts)
      const { getDb } = require('../../services/database');
      getDb().prepare(`
        INSERT INTO api_usage
          (category, model, user_id, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        category, model,
        inputTokens, outputTokens,
        cacheReadTokens, cacheWriteTokens,
        cost, durationMs ?? 0,
      );

      // Write to usage_metering aggregate (user_id=0 for system/content-engine calls)
      const { recordUsage } = require('../../services/usage-metering');
      recordUsage(0, inputTokens, outputTokens, cost, false);

      // Push telemetry event
      const { pushEvent } = require('../../portal/telemetry');
      const totalTokens = inputTokens + outputTokens;
      pushEvent({
        ts: new Date().toISOString(),
        type: 'api_call',
        summary: `py:${category}: ${totalTokens.toLocaleString()} tok, $${cost.toFixed(4)}, ${durationMs ?? 0}ms`,
        durationMs: durationMs ?? 0,
      });

      logger.info(
        { category, model, inputTokens, outputTokens, cost: cost.toFixed(4) },
        'Python usage reported',
      );

      res.json({ ok: true, costUsd: cost });
    } catch (err: any) {
      logger.error({ err }, 'Internal report-usage failed');
      sendError(res, 'INTERNAL', 'Internal report-usage failure', 500);
    }
  });

  // ── POST /api/v1/internal/ai-complete ──────────────────────────────
  //
  // AI completion proxy — the Python content-engine calls this instead
  // of hitting Anthropic directly. This routes through the TS backend's
  // Gemini→OpenAI→Anthropic cascade (completeOneShotWithFallback),
  // giving Python automatic provider selection, usage metering, and
  // kill switch coverage.
  //
  // Body: {
  //   prompt: string,        // user prompt text
  //   system?: string,       // system prompt (optional)
  //   category: string,      // call site ID for cost attribution
  //   maxTokens?: number,    // default 4096
  //   temperature?: number,  // default 0.7
  //   jsonMode?: boolean,    // if true, instructs model to return JSON
  // }
  //
  // Response: { text: string, provider: string }
  router.post('/ai-complete', internalAiCompleteRateLimitMiddleware, async (req: Request, res: Response) => {
    try {
      const {
        prompt, system = '', category,
        maxTokens = 4096, temperature = 0.7,
        jsonMode = false,
      } = req.body;

      if (!prompt || !category) {
        sendError(res, 'BAD_REQUEST', 'missing required fields: prompt, category', 400);
        return;
      }

      const userPrompt = jsonMode
        ? `${prompt}\n\nReturn ONLY valid JSON. No markdown fences, no extra text.`
        : prompt;

      const { completeOneShotWithFallback } = require('../../services/gemini-provider');
      const { trackedCreate } = require('../../portal/anthropic-hook');
      const Anthropic = require('@anthropic-ai/sdk');

      const client = new Anthropic.default({ apiKey: config.anthropic?.apiKey || '', maxRetries: 2 });

      const { text, provider } = await completeOneShotWithFallback(
        system,
        userPrompt,
        category,
        // Anthropic fallback thunk — only fires if ANTHROPIC_ENABLED=true
        async () => {
          const response = await trackedCreate(client, {
            model: 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
            system: system || undefined,
            messages: [{ role: 'user', content: userPrompt }],
          }, category);
          return response.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
        },
        {
          maxTokens,
          temperature,
          timeoutMs: resolveInternalAiTimeoutMs(category, maxTokens),
          jsonMode,
        },
      );

      logger.info({ category, provider, chars: text.length }, 'AI completion for Python engine');
      res.json({ text, provider });
    } catch (err: any) {
      logger.error({ err }, 'Internal ai-complete failed');
      sendError(res, 'AI_COMPLETE_FAILED', 'AI completion failed', 500);
    }
  });

  // ── GET /api/v1/internal/anthropic-enabled ────────────────────────
  //
  // Lets the Python engine check whether Anthropic is enabled before
  // making a call. Mirrors the kill switch in anthropic-hook.ts.
  router.get('/anthropic-enabled', (_req: Request, res: Response) => {
    res.json({ enabled: isAnthropicRuntimeEnabled() });
  });

  // ── GET /api/v1/internal/performance-summary ──────────────────────
  //
  // Returns performance feedback entries for the Python report generator.
  // Query param: ?days=7 (default 30)
  router.get('/performance-summary', (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string, 10) || 30;
      const ownerTarget = getOwnerBootstrapTarget();
      if (!ownerTarget?.tenantId) {
        sendError(res, 'SERVICE_UNAVAILABLE', 'Owner bootstrap target unavailable', 503);
        return;
      }
      const summary = getPerformanceSummary(ownerTarget.tenantId, days);
      res.json({
        entries: summary.entries.map((e: any) => ({
          views: e.views,
          retentionPct: e.retentionPct,
          likes: e.likes,
          comments: e.comments,
          subsGained: e.subsGained,
          hookUsed: e.hookUsed,
          notes: e.notes,
          loggedAt: e.loggedAt,
          videoUrl: e.videoUrl,
        })),
        count: summary.count,
        avgViews: summary.avgViews,
        avgRetention: summary.avgRetention,
      });
    } catch (err: any) {
      logger.error({ err }, 'Internal performance-summary failed');
      sendError(res, 'INTERNAL', 'Internal performance-summary failure', 500);
    }
  });

  return router;
}
