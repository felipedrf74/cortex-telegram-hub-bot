// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Option 3 — Classify shadow-eval service.
 *
 * Fire-and-forget Ollama classify alongside the live Gemini path. Lets
 * us validate a small dedicated classifier model's behavior against
 * the production baseline without affecting user-facing latency or
 * cost. Cutover from Gemini to Ollama is gated on this comparison plus
 * a synthetic golden set.
 *
 * Operator amendments (BINDING):
 *
 * O3-A1 — NEVER blocks the live response. Live classify returns to
 *   the user first; this runs as a void Promise.
 *
 * O3-A17 — Uses `getProvider('ollama')` explicitly (NOT
 *   `getActiveProvider()`). During shadow mode `AI_CLASSIFY_PRIMARY=gemini`
 *   so `getActiveProvider()` would return Gemini → would shadow Gemini
 *   against itself → useless agreement signal.
 *
 * O3-A18 — Timeout cancels via AbortController so the underlying
 *   Ollama fetch is actually terminated (not just the local promise).
 *
 * O3-A19 — No recursion: when the live path is Ollama (post-cutover),
 *   skip shadow entirely. Belt+suspenders: the live classifier also
 *   sets `source: 'live'` explicitly.
 *
 * O3-A12 OPTION 1 — Shadow calls write ZERO `api_usage` rows and
 *   bypass `local-llm-rate-limiter` (no quota burn). All telemetry
 *   flows via `classify_shadow_runs`.
 *
 * O3-A21 — Row schema includes `request_id`, `ollama_model`,
 *   `ollama_prompt_version`, `gemini_model`, `schema_version`.
 *
 * O3-A24 — Gemini is BASELINE, not GROUND TRUTH. `agree=1` means the
 *   two providers happened to agree; the operator manually labels
 *   disagreements before the cutover gate evaluates pass/fail.
 *
 * Shadow concurrency cap (`LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT` /
 *   `_MAX_QUEUE`): defaults 1/4. Over-capacity calls dropped silently
 *   with debug log — shadow is best-effort.
 */

import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { getProvider, getActiveProvider } from './provider-registry';
import { hmacSha256 } from '../utils/hmac';
import { generateRequestId } from '../utils/request-context';
import type { ClassificationResult, DomainName } from '../domains/types';

// ─── Knobs ────────────────────────────────────────────────────────

function readPositiveInt(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const SHADOW_TIMEOUT_MS = readPositiveInt('OLLAMA_CLASSIFY_TIMEOUT_MS', 5000);
const MAX_IN_FLIGHT = readPositiveInt('LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT', 1);
const MAX_QUEUE = readPositiveInt('LOCAL_LLM_CLASSIFY_SHADOW_MAX_QUEUE', 4);

const PROMPT_VERSION_DEFAULT = 'v1';
const SCHEMA_VERSION = 1;

// ─── Concurrency state ────────────────────────────────────────────
// Module-scoped semaphore. Single-instance (PM2 runs nexus-hub at
// instances=1; the OllamaProvider startup guard enforces that for the
// memory queue backend). If we ever go multi-instance, the cap becomes
// per-process — total concurrent shadow runs = instances × MAX_IN_FLIGHT.

let inFlight = 0;
let queued = 0;

let warnedNoSecret = false;
let warnedNoProvider = false;

// ─── Public API ───────────────────────────────────────────────────

export interface ShadowClassifyInput {
  message: string;
  activeContext?: { domain: DomainName; lastAssistantMessage: string };
  userId?: number;
  tenantId?: number;
  requestId?: string;
  geminiResult: ClassificationResult;
  geminiModel?: string;
  geminiDurationMs: number;
}

/**
 * Fire-and-forget shadow classify. Callers wrap with:
 *
 *   void runOllamaShadowClassification({...}).catch(err =>
 *     logger.warn({ err }, 'classify shadow failed')
 *   );
 *
 * Never throws to the caller. All failure modes log and return.
 */
export async function runOllamaShadowClassification(input: ShadowClassifyInput): Promise<void> {
  if (!config.localLLM?.classifyShadow) return;
  if (MAX_IN_FLIGHT === 0) return;

  const requestId = input.requestId ?? generateRequestId();
  const geminiModel = input.geminiModel ?? 'unknown';

  // O3-A19: do not recurse when the live path is already Ollama. If
  // AI_CLASSIFY_PRIMARY=ollama, the live call already produced an
  // Ollama result; running another shadow Ollama call would be a
  // self-comparison (useless) and would risk an infinite chain if the
  // call site ever propagated the trigger by accident.
  const active = getActiveProvider();
  if (active?.name === 'ollama' || active?.name?.startsWith('routing(ollama')) {
    logger.debug({ requestId }, 'classify-shadow skipped — live path already ollama');
    return;
  }

  // Concurrency cap — drop silently when over capacity.
  if (inFlight >= MAX_IN_FLIGHT && queued >= MAX_QUEUE) {
    logger.debug(
      { requestId, inFlight, queued, maxInFlight: MAX_IN_FLIGHT, maxQueue: MAX_QUEUE },
      'classify-shadow dropped — over capacity',
    );
    return;
  }

  queued++;

  const secret = process.env.CLASSIFY_SHADOW_HASH_SECRET || '';
  if (!secret) {
    queued--;
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      logger.warn(
        { requestId },
        'classify-shadow: CLASSIFY_SHADOW_HASH_SECRET not set — shadow rows will not be written until the secret is generated',
      );
    }
    return;
  }

  // O3-A17: explicit Ollama provider lookup. NOT getActiveProvider().
  const ollama = getProvider('ollama');
  if (!ollama) {
    queued--;
    if (!warnedNoProvider) {
      warnedNoProvider = true;
      logger.warn(
        { requestId },
        'classify-shadow: ollama provider unavailable — skipping (set OLLAMA_ENABLED=true if you want shadow eval)',
      );
    }
    return;
  }

  const messageHash = hmacSha256(secret, input.message.trim().toLowerCase());
  const db = getDb();

  // O3-A21: row inserted upfront with Gemini baseline + model metadata.
  // The Ollama columns get UPDATEd below when the shadow call returns
  // (or fails / times out). Inserting upfront ensures we have a row to
  // diagnose against even if the shadow call dies for any reason.
  let rowId: number | bigint;
  try {
    const insert = db.prepare(`
      INSERT INTO classify_shadow_runs (
        ts, request_id, user_id, tenant_id, message_hash, schema_version,
        ollama_model, ollama_prompt_version, gemini_model,
        gemini_domain, gemini_confidence, gemini_duration_ms
      ) VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      input.userId ?? 0,
      input.tenantId ?? 0,
      messageHash,
      SCHEMA_VERSION,
      config.ollama?.classifierModel ?? null,
      process.env.OLLAMA_CLASSIFIER_PROMPT_VERSION || PROMPT_VERSION_DEFAULT,
      geminiModel,
      input.geminiResult.domain,
      input.geminiResult.confidence,
      input.geminiDurationMs,
    );
    rowId = insert.lastInsertRowid;
  } catch (err) {
    queued--;
    logger.warn({ err: err instanceof Error ? err.message : String(err), requestId }, 'classify-shadow: insert baseline row failed');
    return;
  }

  // Wait for an in-flight slot (bounded by MAX_QUEUE check above so
  // this loop runs at most MAX_QUEUE iterations of 50ms each).
  while (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  queued--;
  inFlight++;

  // O3-A18: AbortController so timeout cancels the underlying fetch.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort('shadow_timeout'), SHADOW_TIMEOUT_MS);

  const start = Date.now();
  let ollamaResult: ClassificationResult | null = null;
  let ollamaError: string | null = null;
  try {
    ollamaResult = await ollama.classify(input.message, input.activeContext, {
      userId: input.userId,
      tenantId: input.tenantId,
      requestId,
      source: 'shadow',         // O3-A19: opt-in to shadow path
      recordUsage: false,       // O3-A12 OPTION 1: skip api_usage / rate-limit
      timeoutMs: SHADOW_TIMEOUT_MS,
      abortSignal: controller.signal,  // O3-A18: real cancellation
    });
  } catch (err) {
    ollamaError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeoutHandle);
    inFlight--;
  }

  const durationMs = Date.now() - start;
  const ollamaDomain = ollamaResult?.domain ?? null;
  const ollamaConfidence = ollamaResult?.confidence ?? null;
  // `agree=1` is just "the two providers produced the same domain
  // string". Manual review (O3-A24) reclassifies disagreements before
  // the cutover gate evaluates pass/fail.
  const agree = ollamaResult && ollamaResult.domain === input.geminiResult.domain ? 1 : 0;

  try {
    db.prepare(`
      UPDATE classify_shadow_runs
      SET ollama_domain = ?, ollama_confidence = ?, ollama_duration_ms = ?,
          ollama_error = ?, agree = ?
      WHERE id = ?
    `).run(
      ollamaDomain,
      ollamaConfidence,
      durationMs,
      ollamaError,
      agree,
      rowId as number,
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), rowId, requestId },
      'classify-shadow: UPDATE failed (row inserted but never updated)',
    );
  }
}
