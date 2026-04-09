// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Transparent wrapper for Anthropic API calls that records usage metrics.
 *
 * Writes each call to the `api_usage` SQLite table and pushes an activity
 * event to the telemetry ring buffer. The wrapper is transparent — callers
 * see the identical Anthropic.Message return type.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../services/database';
import { pushEvent } from './telemetry';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';

// ─── Per-million-token pricing (update when Anthropic changes rates) ─

const COST_PER_MTK: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6':         { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { in: 0.80, out:  4.00, cacheRead: 0.08, cacheWrite: 1.00 },
};

const warnedModels = new Set<string>();

function computeCost(model: string, usage: Anthropic.Usage): number {
  const rates = COST_PER_MTK[model];
  if (!rates) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      logger.warn({ model }, 'Unknown model for cost calculation — falling back to Sonnet pricing');
    }
  }
  const r = rates ?? COST_PER_MTK['claude-sonnet-4-6'];
  return (
    (usage.input_tokens / 1_000_000) * r.in +
    (usage.output_tokens / 1_000_000) * r.out +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * r.cacheRead +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * r.cacheWrite
  );
}

/**
 * Call `client.messages.create()` with usage tracking.
 *
 * @param client   The Anthropic SDK instance
 * @param params   Standard create-message params
 * @param category Identifies the call site: 'classify_message', 'classify_image',
 *                 'domain_secretary', 'domain_triathlon', 'domain_content',
 *                 'tool_continuation', 'invoice_filing', 'coach_analysis'
 * @param options  Optional metering context: userId and whether this is a user-initiated message
 */
export async function trackedCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  category: string,
  options?: { userId?: number; isUserMessage?: boolean; timeoutMs?: number },
): Promise<Anthropic.Message> {
  const start = Date.now();

  // Use streaming for long operations: high max_tokens or Sonnet model
  // The Anthropic SDK requires stream:true for operations that may take 10+ minutes
  const isSonnet = params.model.includes('sonnet');
  const isLargeRequest = params.max_tokens >= 4096;
  const useStreaming = isSonnet || isLargeRequest;

  // Timeout: use caller override, or auto-scale for streaming/large requests (90s), default 30s
  const defaultTimeout = parseInt(process.env.AI_CALL_TIMEOUT_MS || '30000', 10);
  const AI_CALL_TIMEOUT_MS = options?.timeoutMs ?? (useStreaming ? Math.max(defaultTimeout, 90_000) : defaultTimeout);

  let response: Anthropic.Message;
  if (useStreaming) {
    const streamPromise = (async () => {
      const stream = await client.messages.stream({ ...params, stream: true });
      return stream.finalMessage();
    })();
    response = await withTimeout(streamPromise, AI_CALL_TIMEOUT_MS);
  } else {
    response = await withTimeout(client.messages.create(params), AI_CALL_TIMEOUT_MS);
  }

  const durationMs = Date.now() - start;
  const usage = response.usage;
  const cost = computeCost(params.model, usage);

  // Persist to SQLite (non-critical — swallow errors)
  //
  // April 9 2026: fixed a long-standing latent bug where the INSERT
  // omitted `user_id` entirely. Migration 029 added the `user_id`
  // column to `api_usage` with `NOT NULL DEFAULT 0` so every existing
  // row silently got user_id=0. That meant:
  //
  //   • `cost-guardrail.isUserOverDailyCap(userId)` queries
  //     `WHERE user_id = ?` and found zero rows for any real user
  //     (they all had user_id=0), so the per-user cost cap was
  //     effectively disabled for everyone
  //   • Per-domain cost attribution per user was impossible
  //   • The admin portal's per-user cost breakdown would show
  //     every call under user_id=0
  //
  // Fix: persist `options?.userId ?? 0` into the INSERT. Calls that
  // legitimately don't have a user attached (classifier passes, scheduled
  // briefings, etc.) still fall back to 0 — same as before — so no
  // behaviour changes for those paths. Calls that DO have a userId now
  // write it, enabling per-user enforcement for the first time.
  try {
    getDb().prepare(`
      INSERT INTO api_usage
        (category, model, user_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      category,
      params.model,
      options?.userId ?? 0,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      cost,
      durationMs,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to record api_usage');
  }

  // Record per-user usage metering (non-critical — swallow errors)
  try {
    const { recordUsage } = require('../services/usage-metering');
    recordUsage(
      options?.userId ?? 0,
      usage.input_tokens,
      usage.output_tokens,
      cost,
      options?.isUserMessage ?? false,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to record usage metering');
  }

  // Push activity event
  const totalTokens = usage.input_tokens + usage.output_tokens;
  pushEvent({
    ts: new Date().toISOString(),
    type: 'api_call',
    summary: `${category}: ${totalTokens.toLocaleString()} tok, $${cost.toFixed(4)}, ${durationMs}ms`,
    durationMs,
  });

  return response;
}
