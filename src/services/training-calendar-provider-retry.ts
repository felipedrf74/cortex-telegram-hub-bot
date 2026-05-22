// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  deleteEvent,
  type CalendarSource,
} from './unified-calendar';
import { logger } from '../utils/logger';

type RetryContext = {
  userId: number;
  tenantId?: number;
  planId?: number;
  sessionId?: number;
  ownershipId?: number;
  eventId?: string;
  source?: CalendarSource;
  title?: string;
};

const DEFAULT_WRITE_SPACING_MS = 350;
const DEFAULT_RETRY_DELAYS_MS = [1_500, 4_000, 8_000];

export async function deleteTrainingCalendarEventWithRetry(
  eventId: string,
  source: CalendarSource,
  userId: number,
  context: RetryContext = { userId },
  options?: { signal?: AbortSignal },
): Promise<void> {
  const retryDelays = trainingCalendarRetryDelaysMs();
  let attempt = 0;

  while (true) {
    try {
      if (options?.signal?.aborted) throw new Error('provider_write_aborted');
      if (options) {
        await deleteEvent(eventId, source, userId, options);
      } else {
        await deleteEvent(eventId, source, userId);
      }
      await sleep(trainingCalendarWriteSpacingMs(), options?.signal);
      return;
    } catch (err) {
      if (!isTrainingCalendarRateLimitError(err) || attempt >= retryDelays.length) {
        throw err;
      }

      const retryDelayMs = retryDelays[attempt];
      attempt += 1;
      logger.warn(
        {
          err,
          userId,
          tenantId: context.tenantId,
          planId: context.planId,
          sessionId: context.sessionId,
          ownershipId: context.ownershipId,
          eventId,
          source,
          attempt,
          retryDelayMs,
        },
        'Training calendar delete rate-limited - retrying',
      );
      await sleep(retryDelayMs, options?.signal);
    }
  }
}

export function trainingCalendarWriteSpacingMs(): number {
  if (isTestRuntime()) return 0;
  return readNonNegativeInteger(
    process.env.TRAINING_CALENDAR_WRITE_SPACING_MS,
    DEFAULT_WRITE_SPACING_MS,
  );
}

export function trainingCalendarRetryDelaysMs(): number[] {
  if (isTestRuntime()) return [0, 0, 0];
  const raw = process.env.TRAINING_CALENDAR_RETRY_DELAYS_MS;
  if (!raw) return DEFAULT_RETRY_DELAYS_MS;
  const parsed = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS;
}

export function isTrainingCalendarRateLimitError(err: unknown): boolean {
  const candidate = err as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    response?: {
      status?: unknown;
      headers?: Record<string, unknown>;
      data?: {
        error?: {
          code?: unknown;
          message?: unknown;
          errors?: Array<{ reason?: unknown; message?: unknown }>;
        };
      };
    };
    headers?: Record<string, unknown>;
    errors?: Array<{ reason?: unknown; message?: unknown }>;
    reason?: unknown;
  };

  const status = Number(candidate.status ?? candidate.statusCode ?? candidate.code ?? candidate.response?.status);
  if (status === 429) return true;

  const googleError = candidate.response?.data?.error;
  const googleCode = Number(googleError?.code);
  const codes = [
    candidate.code,
    googleError?.code,
  ].map((code) => String(code ?? '').toLowerCase()).filter(Boolean);
  if (codes.includes('toomanyrequests') || codes.includes('too_many_requests')) return true;

  const retryAfterHeader = headerValue(candidate.headers, 'retry-after')
    ?? headerValue(candidate.response?.headers, 'retry-after');
  if (retryAfterHeader != null && retryAfterHeader !== '') return true;

  const reasons = [
    candidate.reason,
    ...(candidate.errors?.map((item) => item.reason) ?? []),
    ...(googleError?.errors?.map((item) => item.reason) ?? []),
  ].map((reason) => String(reason ?? '').toLowerCase()).filter(Boolean);
  if ((status === 403 || googleCode === 403) && reasons.some((reason) => reason.includes('ratelimit'))) {
    return true;
  }

  const message = [
    candidate.message,
    candidate.reason,
    ...(candidate.errors?.map((item) => item.message) ?? []),
    googleError?.message,
    ...(googleError?.errors?.map((item) => item.message) ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return message.includes('rate limit') || message.includes('ratelimit');
}

function headerValue(headers: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[key] ?? headers[key.toLowerCase()];
  if (direct != null) return String(direct);
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return match ? String(match[1]) : undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('provider_write_aborted'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('provider_write_aborted'));
    }, { once: true });
  });
}

function readNonNegativeInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST_WORKER_ID);
}
