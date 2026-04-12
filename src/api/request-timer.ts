// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Request Timer Middleware — API latency tracking for iOS endpoints.
 *
 * Lightweight Express middleware that records per-request latency into
 * the portal's telemetry ring buffer. The portal snapshot endpoint
 * (`GET /api/snapshot`) includes a latency summary: p50/p95/p99 per
 * route prefix for the most recent 500 requests.
 *
 * Memory-bounded: ring buffer caps at 500 entries with FIFO eviction.
 * CPU cost: one Date.now() call per request + one on finish.
 * No external dependencies or disk I/O.
 */

import { Request, Response, NextFunction } from 'express';

// ── Ring buffer ──────────────────────────────────────────────────

interface LatencyEntry {
  route: string;       // normalized route prefix (e.g., "/dashboard", "/tasks", "/chat")
  method: string;      // GET, POST, PATCH, etc.
  statusCode: number;
  durationMs: number;
  timestamp: number;   // Date.now() at request start
}

const MAX_ENTRIES = 500;
const latencyBuffer: LatencyEntry[] = [];

// ── Route normalization ──────────────────────────────────────────
// Collapse dynamic segments into a stable prefix for aggregation.
// /api/v1/tasks/list123/task456 → "/tasks"
// /api/v1/billing/status → "/billing"

function normalizeRoute(path: string): string {
  // Strip /api/v1/ prefix
  const stripped = path.replace(/^\/api\/v1\//, '');
  // Take first segment as the route bucket
  const first = stripped.split('/')[0] || 'unknown';
  return `/${first}`;
}

// ── Middleware ────────────────────────────────────────────────────

export function requestTimerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const entry: LatencyEntry = {
      route: normalizeRoute(req.path),
      method: req.method,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      timestamp: start,
    };

    latencyBuffer.push(entry);
    if (latencyBuffer.length > MAX_ENTRIES) {
      latencyBuffer.shift(); // FIFO eviction
    }
  });

  next();
}

// ── Summary ──────────────────────────────────────────────────────

export interface RouteSummary {
  route: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;   // fraction of 4xx/5xx responses
}

/**
 * Compute latency percentiles per route for the entries in the buffer.
 * Returns one RouteSummary per unique route prefix, sorted by request count DESC.
 */
export function getLatencySummary(): RouteSummary[] {
  if (latencyBuffer.length === 0) return [];

  // Group by route
  const byRoute = new Map<string, LatencyEntry[]>();
  for (const entry of latencyBuffer) {
    const list = byRoute.get(entry.route) || [];
    list.push(entry);
    byRoute.set(entry.route, list);
  }

  const summaries: RouteSummary[] = [];
  for (const [route, entries] of byRoute) {
    const durations = entries.map(e => e.durationMs).sort((a, b) => a - b);
    const errors = entries.filter(e => e.statusCode >= 400).length;

    summaries.push({
      route,
      count: entries.length,
      p50: percentile(durations, 0.50),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      errorRate: Math.round((errors / entries.length) * 1000) / 1000,
    });
  }

  return summaries.sort((a, b) => b.count - a.count);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
