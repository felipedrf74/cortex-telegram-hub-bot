// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * In-process rolling 1-hour counter of ChatCoreV2 composer-mode (answer
 * composition) usage, used to detect "composer-mode drift" — i.e. the share of
 * turns served by the `model_constrained` composer creeping above its budget.
 *
 * Why a process-scoped counter (WP-04): drift is a system-level aggregate
 * signal. It is NOT a per-tenant/per-user metric, so this module deliberately
 * keeps only `{mode, ts}` and never the requesting tenant/user identity. The
 * drift event is emitted pino-only via `buildChatCoreV2FailureObservabilityEvent`
 * (which carries no tenantId/userId and allowlists metadata) and intentionally
 * does NOT write a trace span — attaching the last turn's identity to a
 * system-level aggregate would be a tenant-attribution leak.
 *
 * Like the other ChatCoreV2 runtime helpers (e.g. the local-inference
 * concurrency gate) the state is module-scoped; tests must call
 * `_resetComposerModeCounterForTests()` in `beforeEach`.
 *
 * Risk note: prune is O(N) over the window. At very high turn volume (> ~10k
 * turns/hour) this should become a circular buffer; tracked as a TODO.
 */

import { logger } from '../../utils/logger';
import type { AnswerCompositionMode } from './answer-composition';
import { ANSWER_COMPOSITION_MODE_BUDGETS } from './answer-composition';
import { resolveChatCoreV2ActivationConfig } from './activation-flags';
import { buildChatCoreV2FailureObservabilityEvent } from './failure-observability';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface ComposerModeTurnSample {
  mode: AnswerCompositionMode;
  ts: number;
}

/** Rolling 1-hour window length in milliseconds (3.6e6 = 60 * 60 * 1000). */
const COMPOSER_MODE_WINDOW_MS = 3.6e6;

/**
 * Minimum number of turns in the window before drift can fire. Guards against
 * divide-by-zero and against a single early `model_constrained` turn (1/1 =
 * 1.0) tripping the alarm before there is a meaningful sample.
 */
const COMPOSER_MODE_MIN_WINDOW_SAMPLES = 20;

/**
 * Drift threshold = the `model_constrained` budget's targetMaxShare.
 * NOTE: code value 0.35; spec cites 0.30. Using code value; peer resolution required before Phase 3.
 */
const MODEL_CONSTRAINED_DRIFT_THRESHOLD =
  ANSWER_COMPOSITION_MODE_BUDGETS.find((budget) => budget.mode === 'model_constrained')?.targetMaxShare ?? 0.35;

/** Module-scoped rolling window of composer-mode turns (no tenant/user identity). */
let samples: ComposerModeTurnSample[] = [];

/**
 * De-dupe latch: true while the window is currently over threshold, so we log
 * the `composer_mode_drift` event only on the transition INTO drift (and again
 * after it has recovered below threshold and crossed back up), never on every
 * turn while sustained over threshold.
 */
let inDrift = false;

/**
 * Records one composer-mode turn into the rolling 1h window and evaluates drift.
 *
 * No-op (records nothing, evaluates nothing) when the orchestrator is off, i.e.
 * `resolveChatCoreV2ActivationConfig(env).mode === 'off'`. This is default-off:
 * an absent OR an explicit `off` mode both resolve to `'off'`, so no counting
 * happens unless the orchestrator is actively in shadow/canary/on.
 *
 * Observability-only: this never throws into the caller and never affects the
 * response or any control flow.
 */
export function recordComposerModeTurn(mode: AnswerCompositionMode, env: EnvLike = process.env): void {
  // Default-off + explicit-off kill-switch: parseMode collapses both to 'off'.
  if (resolveChatCoreV2ActivationConfig(env as NodeJS.ProcessEnv).mode === 'off') {
    return;
  }

  const now = Date.now(); // Runtime code path; Date.now() is acceptable here.
  samples.push({ mode, ts: now });
  pruneExpired(now);
  evaluateDrift();
}

/** Drops samples older than the 1h window relative to `now`. */
function pruneExpired(now: number): void {
  const cutoff = now - COMPOSER_MODE_WINDOW_MS;
  // O(N) prune. TODO: switch to a circular buffer if window size grows > ~10k.
  samples = samples.filter((sample) => sample.ts >= cutoff);
}

/**
 * Evaluates `model_constrained` share over the current window and logs a
 * `composer_mode_drift` failure-observability event (pino-only) on the
 * transition into drift. Drift fires when the share STRICTLY EXCEEDS the
 * threshold (0.35), so an exact 0.35 share does not fire.
 */
function evaluateDrift(): void {
  const windowCount = samples.length;
  // Guard against divide-by-zero and an unstable tiny sample.
  if (windowCount < COMPOSER_MODE_MIN_WINDOW_SAMPLES) {
    inDrift = false;
    return;
  }

  const modelConstrainedCount = samples.reduce(
    (total, sample) => (sample.mode === 'model_constrained' ? total + 1 : total),
    0,
  );
  const modelConstrainedShare = modelConstrainedCount / windowCount;
  const overThreshold = modelConstrainedShare > MODEL_CONSTRAINED_DRIFT_THRESHOLD;

  if (overThreshold && !inDrift) {
    // Transition into drift: emit once. Wrapped so a logging failure is never
    // fatal to the (already-completed) turn that triggered this evaluation.
    emitDriftEvent(modelConstrainedShare, windowCount);
  }
  inDrift = overThreshold;
}

/**
 * Builds and logs the `composer_mode_drift` event. Aggregate-only metadata
 * (numbers); no tenantId/userId, no raw strings, and NO trace span — this is a
 * system-level signal and attaching the last turn's identity would be a
 * tenant-attribution leak.
 */
function emitDriftEvent(modelConstrainedShare: number, windowCount: number): void {
  try {
    const event = buildChatCoreV2FailureObservabilityEvent({
      failureMode: 'composer_mode_drift',
      reasonCode: 'model_constrained_share_over_budget',
      metricValue: modelConstrainedShare,
      metadata: {
        // Aggregate enums/numbers only; passes the failure-observability
        // allowlist (numbers are always kept; no sensitive/raw string keys).
        mode_share: modelConstrainedShare,
        window_count: windowCount,
        threshold: MODEL_CONSTRAINED_DRIFT_THRESHOLD,
      },
    });
    // pino-only, system-level aggregate. No tenantId/userId attached.
    logger.warn({ event }, 'Chat Core v2 composer-mode drift detected');
  } catch {
    // Non-fatal: observability must never throw into the response path.
  }
}

/** Test-only: clears the module-scoped rolling window and drift latch. */
export function _resetComposerModeCounterForTests(): void {
  samples = [];
  inDrift = false;
}
