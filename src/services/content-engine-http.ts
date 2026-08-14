// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../config';
import { logger } from '../utils/logger';
import { generateRequestId, getCurrentRequestId } from '../utils/request-context';
import { isProviderRequestCancellation } from './ai-provider';
import {
  ForwardedAiBudgetError,
  ForwardedLocalInferenceError,
  parseForwardedContentEngineError,
} from './content-engine-error-contract';

let lastHealthCheck = 0;
let healthy = true;
let consecutiveFailures = 0;
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

export async function isContentEngineHealthy(): Promise<boolean> {
  if (Date.now() - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return healthy;
  try {
    const response = await fetch(`${BASE_URL.replace('/api/v1', '')}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    healthy = response.ok;
    consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
  } catch {
    healthy = false;
    consecutiveFailures += 1;
  }
  lastHealthCheck = Date.now();
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

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  abortSignal?: AbortSignal,
): Promise<T> {
  throwIfContentEngineRequestCancelled(abortSignal);
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    if (Date.now() - lastHealthCheck < CIRCUIT_BREAKER_COOLDOWN_MS) {
      throw new Error('Content engine circuit breaker OPEN — too many consecutive failures. Cooling down.');
    }
    consecutiveFailures = 0;
  }

  let lastError: Error = new Error('Unknown');
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfContentEngineRequestCancelled(abortSignal);
    try {
      const result = await operation();
      throwIfContentEngineRequestCancelled(abortSignal);
      consecutiveFailures = 0;
      return result;
    } catch (error) {
      throwIfContentEngineRequestCancelled(abortSignal, error);
      if (error instanceof ForwardedAiBudgetError || error instanceof ForwardedLocalInferenceError) {
        throw error;
      }
      lastError = error as Error;
      consecutiveFailures += 1;
      if (attempt < maxRetries) {
        const delayMs = 2 ** (attempt + 1) * 1_000;
        logger.warn({ attempt, delayMs, error: lastError.message }, 'Content engine call failed, retrying');
        await waitForContentEngineRetry(delayMs, abortSignal);
      }
    }
  }
  throw lastError;
}

export async function engineFetch<T>(
  apiPath: string,
  options?: RequestInit,
  timeoutMs = 30_000,
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

  const requestId = getCurrentRequestId() || generateRequestId();
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
      const body = await response.text();
      const forwardedError = parseForwardedContentEngineError(response, body);
      if (forwardedError) throw forwardedError;
      throw new Error(`Content Engine ${response.status}: ${body}`);
    }
    const body = await response.json() as T;
    throwIfContentEngineRequestCancelled(externalSignal);
    return body;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}
