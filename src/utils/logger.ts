// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import pino from 'pino';
import { getCurrentContext } from './request-context';

/**
 * Pino logger with a context-aware mixin (Quarter: distributed tracing).
 *
 * The `mixin` function runs on every log call. When the call is happening
 * inside a request context (set up by runWithContext at the entry point),
 * we automatically attach `reqId`, `src`, and `userId` to the log line.
 * Outside any context (e.g. boot-time logs before the first request, or
 * background work that wasn't wrapped) the mixin returns an empty object
 * and the log line looks the same as before — fully backward compatible.
 *
 * Why a mixin instead of pino's child logger pattern? A child logger would
 * require every handler to call `logger.child({ reqId })` and pass the new
 * instance through every downstream call — defeating the purpose of using
 * AsyncLocalStorage. The mixin reads from storage on each call, so it
 * "just works" without touching any caller.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
  mixin() {
    const ctx = getCurrentContext();
    if (!ctx) return {};
    return {
      reqId: ctx.requestId,
      src: ctx.source,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
    };
  },
});
