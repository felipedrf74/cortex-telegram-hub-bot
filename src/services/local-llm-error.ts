// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Local LLM Error taxonomy.
 *
 * Discriminates failure modes for the local Ollama provider so the
 * routing layer can decide:
 *   1. Whether to increment the circuit-breaker failure count
 *      (capacity_exceeded and unsupported_capability MUST NOT — they're
 *      not provider faults).
 *   2. Whether and where to fall through (e.g., scriptGeneration with
 *      fallback='none' refuses to escalate; classify falls through to
 *      Gemini; localReasoning goes through the cloud-reasoning-gate).
 *
 * See plan Revision 4, items 8 + 11.
 */

export type LocalLLMErrorKind =
  /** Bounded queue rejected the request (wait timeout or queue full). NOT a circuit failure. */
  | 'capacity_exceeded'
  /** Generation exceeded OLLAMA_TIMEOUT_MS. IS a circuit failure. */
  | 'timeout'
  /** Structured-output schema validation failed (after one local retry). NOT a circuit failure on first occurrence. */
  | 'invalid_json'
  /** /api/version failed, daemon down. IS a circuit failure. */
  | 'provider_unhealthy'
  /** Governed Unix socket is absent, inaccessible, or not accepting connections. IS a circuit failure. */
  | 'transport_unavailable'
  /** Tool-use, streaming, or another capability requested but not implemented in v1. NOT a circuit failure — routes around. */
  | 'unsupported_capability'
  /** OOM scraper detected. IS a circuit failure, severity=fatal, opens immediately. */
  | 'model_oom'
  /** Requested model not loaded / not pulled. IS a circuit failure. */
  | 'model_missing'
  /** Estimated input tokens exceeded the per-task cap. NOT a circuit failure — task-specific policy. */
  | 'input_token_overflow';

export interface LocalLLMErrorMeta {
  /** Task type that triggered the error (when applicable). */
  taskType?: 'classify' | 'chat' | 'tool-use' | 'scriptGeneration' | 'localReasoning';
  /** Capability requested but unsupported (for unsupported_capability). */
  capability?: string;
  /** Estimated input tokens (for input_token_overflow). */
  estimatedInputTokens?: number;
  /** Per-task cap that was exceeded (for input_token_overflow). */
  cap?: number;
  /** Why the cap fired (for input_token_overflow). */
  capReason?: string;
  /** Queue depth at the moment of capacity_exceeded. */
  queueDepth?: number;
  /** Rate-limit scope (user_daily, user_hourly, script_daily) when capacity_exceeded is rate-limit-driven. */
  scope?: 'user_daily' | 'user_hourly' | 'script_daily';
  /** Hint for the original cause when surfaced from a wrapped error. */
  reason?: string;
  /** Original step that failed (for invalid_json in multi-step pipelines). */
  step?: 'plan' | 'script';
  [key: string]: unknown;
}

export class LocalLLMError extends Error {
  /** HTTP-style status code so existing retryability detection treats this consistently. */
  readonly status: number;
  /** Whether the existing provider-fallback retryable detector should fire. */
  readonly retryable: boolean;

  constructor(
    public readonly kind: LocalLLMErrorKind,
    public readonly meta: LocalLLMErrorMeta = {},
  ) {
    super(`LocalLLMError: ${kind} ${JSON.stringify(meta)}`);
    this.name = 'LocalLLMError';
    // Map kind → HTTP status so isRetryableError(err) in provider-fallback
    // routes correctly. capacity_exceeded uses 503 (retryable=true → falls
    // through). timeout uses 504. unsupported_capability uses 501.
    // input_token_overflow uses 413 (Payload Too Large) — NOT retryable
    // because the prompt itself is the problem; caller policy decides.
    switch (kind) {
      case 'capacity_exceeded': this.status = 503; this.retryable = true; break;
      case 'timeout':           this.status = 504; this.retryable = true; break;
      case 'provider_unhealthy':this.status = 502; this.retryable = true; break;
      case 'transport_unavailable': this.status = 503; this.retryable = true; break;
      case 'model_oom':         this.status = 500; this.retryable = true; break;
      case 'model_missing':     this.status = 404; this.retryable = true; break;
      case 'unsupported_capability': this.status = 501; this.retryable = false; break;
      case 'invalid_json':      this.status = 502; this.retryable = false; break;
      case 'input_token_overflow': this.status = 413; this.retryable = false; break;
    }
  }
}

/**
 * Whether a LocalLLMError kind should increment the circuit breaker.
 * Busy ≠ broken: capacity_exceeded, input_token_overflow, and
 * unsupported_capability are operational signals, not faults.
 */
export function shouldIncrementCircuit(kind: LocalLLMErrorKind): boolean {
  switch (kind) {
    case 'capacity_exceeded':
    case 'unsupported_capability':
    case 'input_token_overflow':
      return false;
    case 'invalid_json':
      // First occurrence is recoverable via local retry; the OllamaProvider
      // is responsible for that. By the time invalid_json reaches
      // provider-fallback it's already a second failure — but to keep
      // accounting consistent we still don't increment the circuit on the
      // first time *the router* sees it. Callers track second-consecutive
      // separately.
      return false;
    case 'timeout':
    case 'provider_unhealthy':
    case 'transport_unavailable':
    case 'model_oom':
    case 'model_missing':
      return true;
  }
}
