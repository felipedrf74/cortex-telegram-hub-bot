// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Standardized iOS API response envelope.
 *
 * Every `/api/v1/*` route returns one of three shapes:
 *   - { ok: true, data, cached, timestamp }            ← success
 *   - { ok: true, data, pagination, timestamp }        ← paginated success
 *   - { ok: false, error: { code, message }, timestamp } ← error
 *
 * The `ok` discriminator lets the iOS client decode every response with a
 * single Swift enum (.success(T) / .failure(ApiError)) — no try/catch on
 * polymorphic shapes, no per-endpoint Decodable types for the wrapper.
 *
 * Use the helpers in this file (`apiSuccess`, `apiError`, `apiPaginated`)
 * instead of constructing the JSON inline. They guarantee:
 *   - the discriminator is set correctly
 *   - `timestamp` is always populated (server clock — useful for cache QA)
 *   - error codes are uppercase, messages are human-readable
 */

import type { Response } from 'express';
import { logger } from '../utils/logger';
import { captureError } from '../services/error-monitor';
import { recordOperatorAlert } from '../services/operator-alerts';
import { getCurrentRequestId } from '../utils/request-context';
import {
  AiBudgetError,
  buildQuotaExceededPayload,
  type AiBudgetDecision,
} from '../services/cost-guardrail';
import { ApiUsagePersistenceError } from '../services/api-usage-fallback';

// ── Types ────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  cached: boolean;
  timestamp: string;
}

export interface ApiPaginated<T> {
  ok: true;
  data: T[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    hasMore: boolean;
  };
  timestamp: string;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  timestamp: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface StableAiBudgetErrorResponse {
  code: Exclude<AiBudgetDecision['code'], 'OK'>;
  message: string;
  status: 403 | 429;
  details: Record<string, unknown>;
}

// ── Builders ─────────────────────────────────────────────────────────

/**
 * Build a successful response envelope.
 *
 * @param data    The payload to return.
 * @param options.cached  Set to true when returning a cached response.
 *                        Lets the iOS client annotate stale-while-revalidate UI.
 */
export function apiSuccess<T>(data: T, options?: { cached?: boolean }): ApiSuccess<T> {
  return {
    ok: true,
    data,
    cached: options?.cached ?? false,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build an error response envelope.
 *
 * @param code    Uppercase machine-readable error code (e.g. "BAD_REQUEST").
 * @param message Human-readable description (safe to show to end users).
 */
export function apiError(code: string, message: string, details?: Record<string, unknown>): ApiError {
  return {
    ok: false,
    error: details ? { code, message, details } : { code, message },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a paginated response envelope.
 *
 * @param data    Page of items.
 * @param page    1-based page number.
 * @param total   Total items across all pages.
 * @param perPage Items per page (default 20).
 */
export function apiPaginated<T>(
  data: T[],
  page: number,
  total: number,
  perPage = 20,
): ApiPaginated<T> {
  return {
    ok: true,
    data,
    pagination: {
      page,
      perPage,
      total,
      hasMore: page * perPage < total,
    },
    timestamp: new Date().toISOString(),
  };
}

// ── Express helpers ──────────────────────────────────────────────────

/**
 * Convenience: send a success envelope with optional HTTP status.
 *
 * Usage:
 *   sendSuccess(res, { user });                  // 200
 *   sendSuccess(res, { user }, { status: 201 }); // 201 Created
 *   sendSuccess(res, snapshot, { cached: true });
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  options?: { status?: number; cached?: boolean },
): void {
  res.status(options?.status ?? 200).json(apiSuccess(data, { cached: options?.cached }));
}

/**
 * Convenience: send an error envelope. Defaults to 400 Bad Request.
 *
 * Common status codes:
 *   400 BAD_REQUEST       — invalid client input
 *   401 UNAUTHORIZED      — missing/invalid token
 *   403 FORBIDDEN         — authenticated but not authorized
 *   404 NOT_FOUND         — resource doesn't exist
 *   409 CONFLICT          — state conflict (e.g. already exists)
 *   429 RATE_LIMITED      — rate limit hit
 *   500 INTERNAL          — server-side bug or unhandled exception
 *   503 SERVICE_UNAVAILABLE — upstream dependency down
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  status = 400,
  details?: Record<string, unknown>,
): void {
  const carriesRetryAfter = status === 429
    || (status === 409 && code === 'TRAINING_OPERATION_LOCKED')
    || (status === 503 && code === 'TRAINING_OPERATION_LOCK_UNAVAILABLE');
  if (carriesRetryAfter && typeof details?.retryAfterSeconds === 'number' && Number.isFinite(details.retryAfterSeconds)) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(details.retryAfterSeconds))));
  }
  const existingCacheControl = typeof res.getHeader === 'function'
    ? res.getHeader('Cache-Control')
    : undefined;
  const existingPragma = typeof res.getHeader === 'function'
    ? res.getHeader('Pragma')
    : undefined;
  const existingExpires = typeof res.getHeader === 'function'
    ? res.getHeader('Expires')
    : undefined;
  if (!existingCacheControl && !existingPragma && !existingExpires && typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  if (status >= 500 || code === 'SERVICE_UNAVAILABLE') {
    const reqId = getCurrentRequestId();
    logger.warn?.(
      {
        event: 'backend_degraded_response',
        reqId,
        code,
        status,
      },
      'Backend returned degraded API response',
    );
    try {
      recordOperatorAlert({
        severity: 'warning',
        source: 'api_degraded_response',
        dedupeKey: `api_degraded:${code}:${status}`,
        title: 'Backend degraded API response',
        detail: `${code} response returned with HTTP ${status}`,
        owner: 'ops',
        suspectedArea: 'backend_degraded_response',
        userImpact: 'The iOS app may show a degraded or retryable error state for this backend surface.',
        runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#error-monitor-alerts',
        metadata: {
          code,
          status,
          reqId,
        },
      });
    } catch (alertErr) {
      logger.warn?.(
        { err: alertErr, reqId, code, status },
        'Failed to record degraded API response operator alert',
      );
    }
  }
  res.status(status).json(apiError(code, message, details));
}

/** Convert a thrown budget denial into the public, dollar-free API contract. */
export function toStableAiBudgetError(error: unknown): StableAiBudgetErrorResponse | null {
  const forwarded = error as {
    name?: string;
    code?: unknown;
    status?: unknown;
    publicMessage?: unknown;
    details?: unknown;
  } | null;
  const forwardedCodes = new Set([
    'AI_PLAN_REQUIRED',
    'AI_DAILY_LIMIT_REACHED',
    'AI_MONTHLY_LIMIT_REACHED',
    'SERVICE_DEGRADED',
  ]);
  if (
    forwarded?.name === 'ForwardedAiBudgetError'
    && typeof forwarded.code === 'string'
    && forwardedCodes.has(forwarded.code)
    && (forwarded.status === 403 || forwarded.status === 429)
    && typeof forwarded.publicMessage === 'string'
  ) {
    const expectedStatus = forwarded.code === 'AI_PLAN_REQUIRED' ? 403 : 429;
    if (forwarded.status !== expectedStatus) return null;
    const details = forwarded.details && typeof forwarded.details === 'object' && !Array.isArray(forwarded.details)
      ? { ...(forwarded.details as Record<string, unknown>) }
      : {};
    if (forwarded.status === 429 && !(typeof details.retryAfterSeconds === 'number' && Number.isFinite(details.retryAfterSeconds))) {
      details.retryAfterSeconds = 60;
    }
    return {
      code: forwarded.code as StableAiBudgetErrorResponse['code'],
      message: forwarded.publicMessage,
      status: forwarded.status,
      details,
    };
  }
  if (error instanceof ApiUsagePersistenceError
    || (error as { name?: string })?.name === 'ApiUsagePersistenceError'
    || (error as { code?: string })?.code === 'AI_USAGE_PERSISTENCE_FAILED') {
    return {
      code: 'SERVICE_DEGRADED',
      message: 'AI-backed features are temporarily degraded because usage metering is unavailable. Token-zero reads remain available.',
      status: 429,
      details: {
        serviceDegraded: true,
        window: 'global',
        unblocksAt: null,
        // Persistence recovery has no deterministic reset, but clients still
        // need a bounded retry cadence and HTTP Retry-After on every stable
        // 429 response. Match the dedicated AI-budget response mapper.
        retryAfterSeconds: 60,
        error: 'rate_limited',
        retryable: true,
      },
    };
  }
  const candidate = error as { name?: string; decision?: AiBudgetDecision } | null;
  if (!(error instanceof AiBudgetError) && candidate?.name !== 'AiBudgetError') return null;
  const decision = candidate?.decision;
  if (!decision || decision.allowed || decision.code === 'OK') return null;
  if (decision.status !== 403 && decision.status !== 429) return null;
  return {
    code: decision.code as Exclude<AiBudgetDecision['code'], 'OK'>,
    message: decision.message,
    status: decision.status,
    details: {
      ...buildQuotaExceededPayload(decision.quota),
      window: decision.window,
      unblocksAt: decision.unblocksAt,
      // Lock/metering/marker degradation has no deterministic reset. Keep a
      // bounded client retry cadence (and HTTP Retry-After) instead of
      // emitting a stable 429 with no retry guidance.
      retryAfterSeconds: decision.code === 'SERVICE_DEGRADED'
        ? decision.retryAfterSeconds ?? 60
        : decision.retryAfterSeconds,
      error: decision.status === 403 ? 'plan_required' : 'rate_limited',
      retryable: decision.status === 429,
    },
  };
}

/** Send a stable AiBudgetError response, including Retry-After for 429s. */
export function sendAiBudgetError(res: Response, error: unknown): boolean {
  const stable = toStableAiBudgetError(error);
  if (!stable) return false;
  sendError(res, stable.code, stable.message, stable.status, stable.details);
  return true;
}

/**
 * Convenience: send a stable, client-safe internal error envelope.
 *
 * Routes should log or capture the underlying exception separately and then
 * respond with a user-facing message that does not leak internal details.
 */
export function sendInternalError(
  res: Response,
  message = 'Internal server error',
  options?: {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
  },
): void {
  sendError(
    res,
    options?.code ?? 'INTERNAL',
    message,
    options?.status ?? 500,
    options?.details,
  );
}

/**
 * Convenience: wrap an async handler so any thrown error becomes a
 * standardized 500 response. Eliminates the boilerplate try/catch in
 * every route, while still letting routes throw with a specific code/status
 * via `sendError(res, ...)` followed by `return`.
 *
 * Hardening-audit fix (2026-04-20): previously this wrapper silently
 * swallowed every unhandled route throw — no Sentry, no errorMonitor,
 * no log — and leaked `err.message` to the client. Route-level
 * failures were invisible outside raw 500 metrics. The wrapper now:
 *   - captures the error via `errorMonitor` so it persists to
 *     `error_log` + reaches Sentry + operator alert channels
 *   - logs with the current request context so `reqId` correlates
 *   - emits a stable client-safe `INTERNAL` message while preserving
 *     the real cause in telemetry
 *
 * Any route that wants to surface a specific status/code to the client
 * should still use `sendError(res, ...)` and `return` — only truly
 * unexpected throws land here.
 */
export function asyncHandler<T extends (req: any, res: Response) => Promise<void>>(handler: T) {
  return async (req: any, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err: any) {
      // Provider wrappers throw AiBudgetError after entitlement/budget checks.
      // Map it before generic 500 capture so every REST surface preserves the
      // stable paid-AI contract and Retry-After semantics.
      if (!res.headersSent && sendAiBudgetError(res, err)) return;

      // 2026-05-18 (skill-hardening QA P1 follow-up): TenantScopeError
      // thrown by `assertTenantScope` / `requireTenantIdParam` is a
      // *client* error (the request lacked a valid tenant tuple), not a
      // server fault. Translate to a stable 401 with the original code
      // BEFORE the captureError telemetry path, so we don't pollute
      // error_log + Sentry with auth-shape failures.
      //
      // Detect by class name only — checking instanceof would create a
      // circular import with `src/services/tenant-scope.ts`.
      if (err?.name === 'TenantScopeError' && typeof err?.status === 'number') {
        if (!res.headersSent) {
          sendError(res, err.code ?? 'UNAUTHORIZED', err.message ?? 'Invalid tenant scope', err.status);
        }
        return;
      }

      // Record in error_log + Sentry + operator alert channels before responding. We
      // intentionally swallow errors from `captureError` itself to avoid
      // an observability bug blocking a normal error response.
      try {
        const reqId = getCurrentRequestId();
        const userId = (req as { userId?: number | null } | undefined)?.userId ?? null;
        const route = (req as { method?: string; originalUrl?: string; path?: string } | undefined);
        const method = typeof route?.method === 'string' ? route.method : undefined;
        const url = typeof route?.originalUrl === 'string'
          ? route.originalUrl
          : (typeof route?.path === 'string' ? route.path : undefined);
        captureError({
          level: 'error',
          source: 'api',
          message: err?.message || 'Unhandled route exception',
          stack: typeof err?.stack === 'string' ? err.stack : undefined,
          context: {
            reqId,
            userId,
            method,
            url,
          },
        });
      } catch (captureErr) {
        logger.warn({ err: captureErr }, 'asyncHandler: failed to record error via errorMonitor');
      }

      // Avoid double-send if the handler already responded (e.g. via sendError)
      if (res.headersSent) return;
      // Return a stable client-safe message. The real error details live
      // in error_log + Sentry keyed by reqId; do not leak err.message.
      sendInternalError(res);
    }
  };
}
