// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Distributed tracing — request context store (Quarter audit item).
 *
 * This module is the central pillar of the bot's request tracing strategy.
 * Every "unit of work" (a Telegram message, an HTTP request, a cron tick,
 * a webhook delivery) gets a short requestId that follows it through the
 * entire system: into log lines via a pino mixin, across HTTP boundaries
 * via the X-Request-Id header, and ultimately into the Python content-engine
 * which threads it through its own logging via a contextvars-backed filter.
 *
 * Why AsyncLocalStorage and not request.locals or a parameter?
 *   - Telegram handlers, cron jobs, and HTTP handlers all share the same
 *     downstream services (database, AI clients, content-engine HTTP client).
 *     Threading a parameter through every function call would require
 *     touching hundreds of call sites — and would likely miss helper
 *     functions deep in the stack (logging, tool execution, etc.).
 *   - AsyncLocalStorage propagates automatically through async boundaries
 *     (await, Promise.all, setImmediate, even setTimeout). The handler
 *     just calls runWithContext() once at the entry point and every
 *     downstream getCurrentContext() / getCurrentRequestId() call sees
 *     the same store, no parameter passing required.
 *   - It's a Node.js core API since v13.10.0 — no dependency.
 *
 * Threading model assumption: this is a single-process Node app. If we
 * ever switch to clustering, AsyncLocalStorage still works inside each
 * worker but requestIds will collide across workers. At that point we
 * should add a worker prefix to generateRequestId().
 */

import { AsyncLocalStorage } from 'async_hooks';

/**
 * The "source" of a request — used by log filters to slice traffic by
 * entry point. Not an enum because new sources may be added (a future
 * WhatsApp adapter, a SQS poller, etc.) without modifying this file.
 *
 * Convention: prefix with the entry-point name. Cron jobs use "cron:<name>"
 * so you can grep for all reminders ticks vs all keepalive ticks.
 */
export type RequestSource =
  | 'http'                  // iOS API or admin portal
  | 'telegram'              // Telegram message ingest
  | 'webhook'               // External webhook (Todoist, etc.)
  | `cron:${string}`        // Scheduled job
  | 'startup'               // Boot-time work (cache warmup, migrations)
  | 'manual';               // Manually invoked from REPL or admin panel

export interface RequestContext {
  /** Short, sortable, unique-per-process requestId. ~12 chars, URL safe. */
  requestId: string;
  /** Where this request entered the system. */
  source: RequestSource;
  /** Telegram user ID or iOS user ID, when applicable. */
  userId?: number;
  /**
   * Garmin reads in non-interactive contexts must never start credentials
   * login, because Garmin sends an MFA/security passcode email for each SSO
   * attempt. This is request-scoped so overlapping HTTP requests cannot race
   * a process-global flag.
   */
  garminSilent?: boolean;
  /** When the request started — used for log-friendly elapsed times. */
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Generate a short, sortable, URL-safe requestId.
 *
 * Format: `<base36-time>-<base36-rand>` — 11-13 chars depending on the
 * current epoch. Example: `1ksaif8-x3y2k`. The time prefix makes IDs
 * lexicographically sortable (so logs grouped by reqId stay in time
 * order without a separate timestamp). The random suffix avoids
 * collisions between concurrent requests landing in the same millisecond.
 *
 * NOT cryptographically random — this is not a secret. It's a log key.
 * Math.random() is fine and ~10× faster than crypto.randomBytes().
 */
export function generateRequestId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${t}-${r}`;
}

/**
 * Run a function inside a fresh request context. Inside the callback (and
 * any async work it spawns), `getCurrentContext()` returns the stored
 * context. Once `fn` resolves/throws, the context is automatically cleared
 * by AsyncLocalStorage's teardown — no manual cleanup required.
 *
 * If the caller already has a requestId (e.g. propagated from an upstream
 * service via X-Request-Id header), pass it in `ctx.requestId` and we'll
 * preserve it instead of generating a new one. This is what makes the
 * "trace bot → portal → content-engine" story work end-to-end: portal
 * receives a request with X-Request-Id header X, runs everything under
 * that ID, then engineFetch() sends X to content-engine in its own
 * X-Request-Id header, and content-engine logs the same ID.
 */
export function runWithContext<T>(
  ctx: { requestId?: string; source: RequestSource; userId?: number; garminSilent?: boolean },
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const full: RequestContext = {
    requestId: ctx.requestId || generateRequestId(),
    source: ctx.source,
    userId: ctx.userId,
    garminSilent: ctx.garminSilent,
    startedAt: Date.now(),
  };
  return storage.run(full, fn);
}

/** Returns the current request context, or undefined if outside any. */
export function getCurrentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Returns just the current requestId, or undefined if outside any context.
 * Most callers want this rather than the full context object — use the
 * fuller form when you need the source or userId fields too.
 */
export function getCurrentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
