// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Error Tracker — Sentry integration layer.
 *
 * Wraps @sentry/node to provide:
 *  - init() — configure Sentry with DSN, environment, release, source maps
 *  - captureException() — send exceptions with context to Sentry
 *  - captureMessage() — send messages with severity to Sentry
 *  - flush() — drain the send queue before shutdown
 *  - isEnabled() — check if Sentry is configured
 *
 * This module is designed to be called from error-monitor.ts so that
 * every error captured locally is also forwarded to Sentry for
 * cloud-based grouping, deduplication, and alerting.
 */

import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger';

let _initialized = false;

export interface ErrorTrackerConfig {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate?: number;
  debug?: boolean;
}

/**
 * Initialize Sentry. Call once at startup before any other service init.
 * No-ops gracefully if DSN is empty (local dev without Sentry).
 */
export function init(cfg: ErrorTrackerConfig): void {
  if (_initialized) return;
  if (!cfg.dsn) {
    logger.warn({ environment: cfg.environment }, 'Sentry: no DSN configured — error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: cfg.dsn,
    environment: cfg.environment,
    release: cfg.release,
    tracesSampleRate: cfg.tracesSampleRate ?? 0,
    attachStacktrace: true,
    // Keep payload small on free tier (5K errors/month)
    maxBreadcrumbs: 30,
    beforeSend(event) {
      // Strip PII: remove user IP if Sentry auto-attaches it
      if (event.user) {
        delete event.user.ip_address;
      }
      return event;
    },
  });

  _initialized = true;
  logger.info({ environment: cfg.environment, release: cfg.release }, 'Sentry: initialized');
}

/** Whether Sentry was successfully initialized with a valid DSN. */
export function isEnabled(): boolean {
  return _initialized;
}

export function getStatus(environment: string): { enabled: boolean; environment: string } {
  return {
    enabled: _initialized,
    environment,
  };
}

/**
 * Forward an exception to Sentry with structured context.
 * Safe to call even if Sentry is not initialized (no-ops).
 */
export function captureException(
  error: Error | string,
  context?: {
    level?: Sentry.SeverityLevel;
    source?: string;
    extra?: Record<string, unknown>;
    tags?: Record<string, string>;
  },
): void {
  if (!_initialized) return;

  const err = typeof error === 'string' ? new Error(error) : error;

  Sentry.withScope((scope) => {
    if (context?.level) scope.setLevel(context.level);
    if (context?.source) scope.setTag('source', context.source);
    if (context?.tags) {
      for (const [k, v] of Object.entries(context.tags)) {
        scope.setTag(k, v);
      }
    }
    if (context?.extra) {
      for (const [k, v] of Object.entries(context.extra)) {
        scope.setExtra(k, v);
      }
    }
    Sentry.captureException(err);
  });
}

/**
 * Send a message-level event to Sentry.
 * Useful for warnings or informational events that aren't exceptions.
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
  extra?: Record<string, unknown>,
): void {
  if (!_initialized) return;

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        scope.setExtra(k, v);
      }
    }
    Sentry.captureMessage(message);
  });
}

/**
 * Drain the Sentry event queue. Call during graceful shutdown
 * to ensure pending events are sent before the process exits.
 */
export async function flush(timeoutMs = 2000): Promise<void> {
  if (!_initialized) return;
  await Sentry.flush(timeoutMs);
}
