// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Local LLM rate limiter — call-count based.
 *
 * The dollar-based cost guardrail (`cost-guardrail.ts`) doesn't meter
 * zero-cost Ollama calls, so a single user could spam the local model
 * with no backpressure and exhaust the queue / OOM the daemon. This
 * module reads recent `api_usage` rows where `provider='ollama'` and
 * `local_request_units > 0` and applies per-user daily, hourly, and
 * script-generation-daily caps from `config.ollama.rateLimit`.
 * Local-primary and classifier shadow rows remain telemetry-only and are
 * excluded from every visible-user counter.
 *
 * Returns `{ allowed: false, reasonScope }` when over a cap; the
 * OllamaProvider raises `LocalLLMError('capacity_exceeded', { scope })`
 * on that result, which routes through `provider-fallback.ts` as a
 * non-circuit-breaking signal (busy ≠ broken).
 *
 * SAFE FALLBACK: when the `local_request_units` column doesn't exist on
 * the deployed DB (pre-migration), this module returns `allowed: true`
 * with a one-time warn log. Production stays unblocked while the
 * migration is applied.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { getDb } from './database';
import {
  CLASSIFIER_SHADOW_JOB_NAME,
  LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
  LOCAL_PRIMARY_SHADOW_JOB_NAME,
} from './local-inference-vocabulary';

export type LocalLLMRateLimitScope = 'general' | 'script';

export interface LocalLLMRateLimitResult {
  allowed: boolean;
  reasonScope?: 'user_daily' | 'user_hourly' | 'script_daily';
  retryAfterSec?: number;
}

let schemaWarningEmitted = false;
let cachedColumnPresent: boolean | null = null;

function isColumnPresent(): boolean {
  if (cachedColumnPresent !== null) return cachedColumnPresent;
  try {
    const db = getDb();
    const rows = db.prepare(`PRAGMA table_info(api_usage)`).all() as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));
    const present = ['local_request_units', 'job_name', 'base_category']
      .every((column) => columns.has(column));
    cachedColumnPresent = present;
    if (!present && !schemaWarningEmitted) {
      schemaWarningEmitted = true;
      logger.warn('local-llm-rate-limiter: governed api_usage attribution columns missing; rate limiter is permissive until migrations are applied');
    }
    return present;
  } catch {
    return false;
  }
}

export function _resetLocalLLMRateLimiterSchemaCacheForTests(): void {
  cachedColumnPresent = null;
  schemaWarningEmitted = false;
}

/**
 * Check whether the next call from `userId` would exceed the configured
 * per-user call-count caps. Does NOT consume — the OllamaProvider's
 * api_usage INSERT serves as the consume step (one row per accepted
 * call).
 */
export function checkAndConsumeLocalLLMRateLimit(
  input: { userId: number; scope: LocalLLMRateLimitScope },
): LocalLLMRateLimitResult {
  if (!isColumnPresent()) return { allowed: true };
  if (input.userId <= 0) return { allowed: true }; // unmetered for system-level callers

  const cfg = config.ollama.rateLimit;
  try {
    const db = getDb();

    // Hourly cap (general)
    if (cfg.perUserHourly > 0) {
      const row = db.prepare(`
        SELECT COUNT(*) AS n
        FROM api_usage
        WHERE provider = 'ollama'
          AND user_id = ?
          AND local_request_units > 0
          AND COALESCE(job_name, '') NOT IN (?, ?)
          AND instr(COALESCE(base_category, category), ?) <> 1
          AND COALESCE(base_category, category) <> ?
          AND ts >= datetime('now', '-1 hour')
      `).get(
        input.userId,
        LOCAL_PRIMARY_SHADOW_JOB_NAME,
        CLASSIFIER_SHADOW_JOB_NAME,
        LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
        CLASSIFIER_SHADOW_JOB_NAME,
      ) as { n: number } | undefined;
      if (row && row.n >= cfg.perUserHourly) {
        return { allowed: false, reasonScope: 'user_hourly', retryAfterSec: 3600 };
      }
    }

    // Daily cap (general)
    if (cfg.perUserDaily > 0) {
      const row = db.prepare(`
        SELECT COUNT(*) AS n
        FROM api_usage
        WHERE provider = 'ollama'
          AND user_id = ?
          AND local_request_units > 0
          AND COALESCE(job_name, '') NOT IN (?, ?)
          AND instr(COALESCE(base_category, category), ?) <> 1
          AND COALESCE(base_category, category) <> ?
          AND ts >= datetime('now', '-1 day')
      `).get(
        input.userId,
        LOCAL_PRIMARY_SHADOW_JOB_NAME,
        CLASSIFIER_SHADOW_JOB_NAME,
        LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
        CLASSIFIER_SHADOW_JOB_NAME,
      ) as { n: number } | undefined;
      if (row && row.n >= cfg.perUserDaily) {
        return { allowed: false, reasonScope: 'user_daily', retryAfterSec: 24 * 3600 };
      }
    }

    // Daily script-generation cap (separate counter on `category` field)
    if (input.scope === 'script' && cfg.scriptGenPerUserDaily > 0) {
      const row = db.prepare(`
        SELECT COUNT(*) AS n
        FROM api_usage
        WHERE provider = 'ollama'
          AND user_id = ?
          AND local_request_units > 0
          AND COALESCE(job_name, '') NOT IN (?, ?)
          AND instr(COALESCE(base_category, category), ?) <> 1
          AND COALESCE(base_category, category) <> ?
          AND category LIKE 'script_gen%'
          AND ts >= datetime('now', '-1 day')
      `).get(
        input.userId,
        LOCAL_PRIMARY_SHADOW_JOB_NAME,
        CLASSIFIER_SHADOW_JOB_NAME,
        LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
        CLASSIFIER_SHADOW_JOB_NAME,
      ) as { n: number } | undefined;
      if (row && row.n >= cfg.scriptGenPerUserDaily) {
        return { allowed: false, reasonScope: 'script_daily', retryAfterSec: 24 * 3600 };
      }
    }

    return { allowed: true };
  } catch (err) {
    // Permissive on infrastructure errors — a broken limiter must not
    // hard-block production traffic.
    logger.warn({ err, userId: input.userId, scope: input.scope }, 'local-llm-rate-limiter: query failed; allowing');
    return { allowed: true };
  }
}
