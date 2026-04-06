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
  };
  timestamp: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

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
export function apiError(code: string, message: string): ApiError {
  return {
    ok: false,
    error: { code, message },
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
): void {
  res.status(status).json(apiError(code, message));
}

/**
 * Convenience: wrap an async handler so any thrown error becomes a
 * standardized 500 response. Eliminates the boilerplate try/catch in
 * every route, while still letting routes throw with a specific code/status
 * via `sendError(res, ...)` followed by `return`.
 */
export function asyncHandler<T extends (req: any, res: Response) => Promise<void>>(handler: T) {
  return async (req: any, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err: any) {
      // Avoid double-send if the handler already responded (e.g. via sendError)
      if (res.headersSent) return;
      res.status(500).json(apiError('INTERNAL', err?.message || 'Internal server error'));
    }
  };
}
