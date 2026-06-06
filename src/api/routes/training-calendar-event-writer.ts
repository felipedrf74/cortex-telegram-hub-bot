// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  createEvent,
  type CalendarSource,
  type UnifiedCalendarEvent,
} from '../../services/unified-calendar';
import {
  assertTrainingCalendarSourceWritesEnabled,
  assertTrainingCalendarWritesEnabled,
  isTrainingOutlookCalendarWritesEnabled,
} from '../../services/training-operational-switches';
import {
  isTrainingCalendarRateLimitError,
  sleep,
  trainingCalendarRetryDelaysMs,
  trainingCalendarWriteSpacingMs,
} from '../../services/training-calendar-provider-retry';
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

export async function createTrainingCalendarEvent(
  data: CalendarEventPayload,
  target: CalendarSource | undefined,
  userId: number,
  context: WriteContext,
  options?: { signal?: AbortSignal },
): Promise<UnifiedCalendarEvent> {
  assertTrainingCalendarWritesEnabled();
  const effectiveTarget = target ?? (isTrainingOutlookCalendarWritesEnabled() ? undefined : 'google');
  if (effectiveTarget) {
    assertTrainingCalendarSourceWritesEnabled(effectiveTarget);
  }

  const retryDelays = trainingCalendarRetryDelaysMs();
  let attempt = 0;

  while (true) {
    try {
      if (options?.signal?.aborted) throw new Error('provider_write_aborted');
      const event = await createEvent(data, effectiveTarget, userId, {
        ...options,
        tenantId: context.tenantId,
      });
      await sleep(trainingCalendarWriteSpacingMs(), options?.signal);
      return event;
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
