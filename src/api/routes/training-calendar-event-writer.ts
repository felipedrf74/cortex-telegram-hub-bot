// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  createEvent,
  type CalendarSource,
  type UnifiedCalendarEvent,
} from '../../services/unified-calendar';
import { assertTrainingCalendarWritesEnabled } from '../../services/training-operational-switches';
import { logger } from '../../utils/logger';

type CalendarEventPayload = {
  title: string;
  start: string;
  end: string;
  description?: string;
};

type WriteContext = {
  userId: number;
  tenantId: number;
  sessionId?: number;
  title?: string;
};

const DEFAULT_WRITE_SPACING_MS = 350;
const DEFAULT_RETRY_DELAYS_MS = [1_500, 4_000, 8_000];

export async function createTrainingCalendarEvent(
  data: CalendarEventPayload,
  target: CalendarSource | undefined,
  userId: number,
  context: WriteContext,
  options?: { signal?: AbortSignal },
): Promise<UnifiedCalendarEvent> {
  assertTrainingCalendarWritesEnabled();

  const retryDelays = trainingCalendarRetryDelaysMs();
  let attempt = 0;

  while (true) {
    try {
      if (options?.signal?.aborted) throw new Error('provider_write_aborted');
      const event = await createEvent(data, target, userId, {
        ...options,
        tenantId: context.tenantId,
      });
      await sleep(trainingCalendarWriteSpacingMs(), options?.signal);
      return event;
    } catch (err) {
      if (!isCalendarRateLimitError(err) || attempt >= retryDelays.length) {
        throw err;
      }

      const retryDelayMs = retryDelays[attempt];
      attempt += 1;
      logger.warn(
        {
          err,
          userId,
          sessionId: context.sessionId,
          titleLength: String(context.title ?? data.title ?? '').length,
          attempt,
          retryDelayMs,
        },
        'Training calendar write rate-limited - retrying',
      );
      await sleep(retryDelayMs, options?.signal);
    }
  }
}

function trainingCalendarWriteSpacingMs(): number {
  if (isTestRuntime()) return 0;
  return readNonNegativeInteger(
    process.env.TRAINING_CALENDAR_WRITE_SPACING_MS,
    DEFAULT_WRITE_SPACING_MS,
  );
}

function trainingCalendarRetryDelaysMs(): number[] {
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

function readNonNegativeInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function isCalendarRateLimitError(err: unknown): boolean {
  const candidate = err as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    response?: {
      status?: unknown;
      data?: {
        error?: {
          code?: unknown;
          message?: unknown;
          errors?: Array<{ reason?: unknown; message?: unknown }>;
        };
      };
    };
  };

  const status = Number(candidate.status ?? candidate.code ?? candidate.response?.status);
  if (status === 429) return true;

  const googleError = candidate.response?.data?.error;
  const googleCode = Number(googleError?.code);
  const reasons = googleError?.errors?.map((item) => String(item.reason ?? '').toLowerCase()) ?? [];
  if ((status === 403 || googleCode === 403) && reasons.some((reason) => reason.includes('ratelimit'))) {
    return true;
  }

  const message = [
    candidate.message,
    googleError?.message,
    ...(googleError?.errors?.map((item) => item.message) ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return message.includes('rate limit') || message.includes('ratelimit');
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST_WORKER_ID);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
