// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../config';
import { logger } from '../utils/logger';
import { generateRequestId, getCurrentRequestId } from '../utils/request-context';
import { isProviderRequestCancellation } from './ai-provider';
import { safeContentLogErrorFields } from './content-log-safety';
import {
  ForwardedAiBudgetError,
  ForwardedContentPolicyError,
  ForwardedLocalInferenceError,
  parseForwardedContentEngineError,
} from './content-engine-error-contract';

let lastHealthCheck = 0;
let healthy = true;
let consecutiveFailures = 0;
type ContentEngineCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
type ContentEngineCircuitPermit =
  | { kind: 'closed' }
  | { kind: 'half_open'; probeId: number };

let circuitState: ContentEngineCircuitState = 'CLOSED';
let circuitOpenedAt = 0;
let halfOpenProbeInFlight = false;
let halfOpenProbeId = 0;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000;

export function contentEngineApiBaseUrl(rawBaseUrl = config.contentEngine.baseUrl): string {
  const trimmed = (rawBaseUrl || `http://localhost:${config.contentEngine.port}`)
    .trim()
    .replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}

const BASE_URL = contentEngineApiBaseUrl();

function contentEngineCircuitOpenError(): Error {
  return new Error('Content engine circuit breaker OPEN — too many consecutive failures. Cooling down.');
}

export class ContentEngineHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Content Engine request failed with HTTP ${status}.`);
    this.name = 'ContentEngineHttpError';
    this.status = status;
  }
}

function isRetryableContentEngineFailure(error: unknown): boolean {
  return !(error instanceof ContentEngineHttpError)
    || (error.status >= 500 && error.status < 600);
}

function acquireContentEngineCircuitPermit(): ContentEngineCircuitPermit {
  if (circuitState === 'CLOSED') return { kind: 'closed' };

  if (circuitState === 'OPEN') {
    const elapsed = Date.now() - circuitOpenedAt;
    if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS && !halfOpenProbeInFlight) {
      circuitState = 'HALF_OPEN';
      halfOpenProbeInFlight = true;
      halfOpenProbeId += 1;
      logger.info(
        { elapsed },
        'Content engine circuit breaker HALF_OPEN — probing recovery',
      );
      return { kind: 'half_open', probeId: halfOpenProbeId };
    }
  }

  throw contentEngineCircuitOpenError();
}

function isCurrentHalfOpenProbe(permit: ContentEngineCircuitPermit): boolean {
  return permit.kind === 'half_open'
    && circuitState === 'HALF_OPEN'
    && halfOpenProbeInFlight
    && permit.probeId === halfOpenProbeId;
}

function recordContentEngineCircuitSuccess(permit: ContentEngineCircuitPermit): void {
  if (permit.kind === 'half_open') {
    if (!isCurrentHalfOpenProbe(permit)) return;
    logger.info('Content engine circuit breaker CLOSED — recovery probe succeeded');
    halfOpenProbeInFlight = false;
    circuitState = 'CLOSED';
    circuitOpenedAt = 0;
    consecutiveFailures = 0;
    return;
  }

  // A request admitted before another concurrent request opened the breaker
  // must not close an active recovery circuit. Only the half-open probe owns
  // that transition.
  if (circuitState !== 'CLOSED') return;
  consecutiveFailures = 0;
}

function recordContentEngineCircuitFailure(permit: ContentEngineCircuitPermit): void {
  if (permit.kind === 'half_open') {
    if (!isCurrentHalfOpenProbe(permit)) return;
    consecutiveFailures = Math.max(CIRCUIT_BREAKER_THRESHOLD, consecutiveFailures + 1);
    circuitOpenedAt = Date.now();
    halfOpenProbeInFlight = false;
    circuitState = 'OPEN';
    logger.warn('Content engine circuit breaker OPEN — recovery probe failed');
    return;
  }

  // Ignore late results from requests admitted before another request opened
  // the circuit. They cannot take ownership away from the recovery probe.
  if (circuitState !== 'CLOSED') return;
  consecutiveFailures += 1;
  if (consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return;

  circuitOpenedAt = Date.now();
  circuitState = 'OPEN';
  logger.warn(
    { failures: consecutiveFailures },
    'Content engine circuit breaker OPEN — failure threshold reached',
  );
}

function releaseUnsettledHalfOpenProbe(permit: ContentEngineCircuitPermit): void {
  if (!isCurrentHalfOpenProbe(permit)) return;

  // Cancellation and forwarded policy denials do not prove the engine healthy.
  // Return ownership to OPEN without extending the cooldown so another caller
  // may perform the already-due recovery probe. Stable HTTP responses settle
  // through recordContentEngineCircuitSuccess before reaching this cleanup.
  halfOpenProbeInFlight = false;
  circuitState = 'OPEN';
}

export async function isContentEngineHealthy(): Promise<boolean> {
  if (
    circuitState === 'CLOSED'
    && Date.now() - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS
  ) return healthy;

  try {
    await runContentEngineRequest(async () => {
      const response = await fetch(`${BASE_URL.replace('/api/v1', '')}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new ContentEngineHttpError(response.status);
    }, 0);
    healthy = true;
  } catch {
    healthy = false;
  } finally {
    lastHealthCheck = Date.now();
  }
  return healthy;
}

function contentEngineRequestCancelledError(): Error {
  return Object.assign(new Error('content_engine_request_cancelled'), {
    name: 'AbortError',
    code: 'CONTENT_ENGINE_CLIENT_DISCONNECTED',
  });
}

export function throwIfContentEngineRequestCancelled(
  abortSignal?: AbortSignal,
  error?: unknown,
): void {
  if (!abortSignal?.aborted) return;
  if (abortSignal.reason instanceof Error) throw abortSignal.reason;
  if (error !== undefined && isProviderRequestCancellation(error)) throw error;
  throw contentEngineRequestCancelledError();
}

function waitForContentEngineRetry(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return new Promise(resolve => setTimeout(resolve, ms));
  throwIfContentEngineRequestCancelled(abortSignal);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      try {
        throwIfContentEngineRequestCancelled(abortSignal);
      } catch (error) {
        reject(error);
      }
    };
    timer = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runContentEngineRequest<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  throwIfContentEngineRequestCancelled(abortSignal);
  const permit = acquireContentEngineCircuitPermit();
  let settled = false;

  let lastError: Error = new Error('Unknown');
  // HALF_OPEN is intentionally a single probe. Retrying it would let one
  // recovery window send multiple HTTP requests and defeat the breaker.
  const retries = permit.kind === 'half_open' ? 0 : maxRetries;
  try {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      throwIfContentEngineRequestCancelled(abortSignal);
      // Another concurrent request may have opened the circuit while this
      // call was backing off. Do not start a stale retry through an OPEN gate.
      if (attempt > 0 && circuitState !== 'CLOSED') break;
      try {
        const result = await operation();
        throwIfContentEngineRequestCancelled(abortSignal);
        recordContentEngineCircuitSuccess(permit);
        settled = true;
        return result;
      } catch (error) {
        throwIfContentEngineRequestCancelled(abortSignal, error);
        if (error instanceof ForwardedAiBudgetError
            || error instanceof ForwardedContentPolicyError
            || (error instanceof ForwardedLocalInferenceError && error.status < 500)) {
          // A forwarded policy/validation denial is still a stable response
          // from the Content Engine. It proves transport health and resets a
          // prior failure streak (or closes the half-open recovery probe).
          recordContentEngineCircuitSuccess(permit);
          settled = true;
          throw error;
        }
        if (!isRetryableContentEngineFailure(error)) {
          // A stable 4xx proves the engine responded and must break the streak
          // of retryable transport/5xx failures. Otherwise intermittent valid
          // request rejections can incorrectly accumulate into an OPEN circuit.
          recordContentEngineCircuitSuccess(permit);
          settled = true;
          throw error;
        }
        lastError = error as Error;
        recordContentEngineCircuitFailure(permit);
        settled = true;

        // Stop the triggering call as soon as the breaker opens. The error
        // that caused the transition remains the caller-visible failure.
        if (circuitState !== 'CLOSED') break;
        if (attempt < retries) {
          const delayMs = 2 ** (attempt + 1) * 1_000;
          logger.warn({
            attempt,
            delayMs,
            ...safeContentLogErrorFields(lastError),
          }, 'Content engine call failed, retrying');
          await waitForContentEngineRetry(delayMs, abortSignal);
        }
      }
    }
    throw lastError;
  } finally {
    if (!settled) releaseUnsettledHalfOpenProbe(permit);
  }
}

async function fetchContentEngineOnce<T>(
  apiPath: string,
  options: RequestInit | undefined,
  timeoutMs: number,
  requestId: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error('content_engine_request_timed_out'),
    { name: 'TimeoutError', code: 'CONTENT_ENGINE_TIMEOUT' },
  )), timeoutMs);
  const externalSignal = options?.signal ?? undefined;
  const abortFromCaller = () => controller.abort(
    externalSignal?.reason instanceof Error
      ? externalSignal.reason
      : contentEngineRequestCancelledError(),
  );
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    throwIfContentEngineRequestCancelled(externalSignal);
    const response = await fetch(`${BASE_URL}${apiPath}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        'X-Internal-Secret': config.contentEngine.internalApiSecret,
        ...options?.headers,
      },
    });
    throwIfContentEngineRequestCancelled(externalSignal);
    if (!response.ok) {
      const body = (await response.text()).slice(0, 8_192);
      const forwardedError = parseForwardedContentEngineError(response, body);
      if (forwardedError) throw forwardedError;
      throw new ContentEngineHttpError(response.status);
    }
    const body = await response.json() as T;
    throwIfContentEngineRequestCancelled(externalSignal);
    return body;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function engineFetch<T>(
  apiPath: string,
  options?: RequestInit,
  timeoutMs = 30_000,
  maxRetries = 0,
): Promise<T> {
  const requestId = getCurrentRequestId() || generateRequestId();
  return runContentEngineRequest(
    () => fetchContentEngineOnce<T>(apiPath, options, timeoutMs, requestId),
    maxRetries,
    options?.signal ?? undefined,
  );
}
