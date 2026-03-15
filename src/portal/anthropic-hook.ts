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
 */
export async function trackedCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  category: string,
): Promise<Anthropic.Message> {
  const start = Date.now();
  const response = await client.messages.create(params);
  const durationMs = Date.now() - start;
  const usage = response.usage;
  const cost = computeCost(params.model, usage);

  // Persist to SQLite (non-critical — swallow errors)
  try {
    getDb().prepare(`
      INSERT INTO api_usage
        (category, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      category,
      params.model,
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
