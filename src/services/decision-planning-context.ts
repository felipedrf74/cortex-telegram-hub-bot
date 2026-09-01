// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import {
  createDecisionPlanningContext as createCanonicalDecisionPlanningContext,
} from './decision-center/planning-context';
import type { DecisionClock } from './decision-center/contracts';
import { getUserLanguageById, getUserTimezoneById } from './user-service';

/**
 * One immutable calendar interpretation for a Decision Center request/job.
 *
 * Reading the clock once prevents a long orchestration from mixing two local
 * days or ISO weeks when it crosses midnight. Callers may inject both the
 * clock and the user settings in tests; production defaults come from the
 * canonical by-id user resolvers.
 */
export interface DecisionPlanningContext {
  readonly userId: number;
  readonly tenantId: number;
  readonly timezone: string;
  readonly locale: string;
  readonly nowUtc: string;
  readonly localDate: string;
  readonly isoWeek: string;
  readonly isoWeekYear: number;
  readonly isoWeekNumber: number;
  readonly localDayStartUtc: string;
  readonly localDayEndUtc: string;
}

export interface DecisionPlanningClock {
  now(): Date;
}

export interface CreateDecisionPlanningContextInput {
  userId: number;
  tenantId: number;
  timezone?: string;
  locale?: string;
  now?: Date;
  clock?: DecisionPlanningClock;
}

export function createDecisionPlanningContext(
  input: CreateDecisionPlanningContextInput,
): DecisionPlanningContext {
  const timezone = input.timezone ?? getUserTimezoneById(input.userId);
  const locale = input.locale ?? getUserLanguageById(input.userId);
  // The scoped Decision Center context is the single owner of clock capture,
  // scope validation, timezone validation, local-date, and ISO-week math.
  // This file remains a compatibility adapter for pre-rewrite consumers.
  const clock: DecisionClock | undefined = input.now
    ? { now: () => new Date(input.now!.getTime()) }
    : input.clock;
  const canonical = createCanonicalDecisionPlanningContext({
    scope: { userId: input.userId, tenantId: input.tenantId },
    timezone,
    locale,
    ...(clock ? { clock } : {}),
  });

  const utc = DateTime.fromISO(canonical.capturedAt, { zone: 'utc' });
  const localDayStart = DateTime.fromISO(canonical.localDate, { zone: canonical.timezone }).startOf('day');
  const localDayEnd = localDayStart.plus({ days: 1 });

  return Object.freeze({
    userId: canonical.scope.userId,
    tenantId: canonical.scope.tenantId,
    timezone: canonical.timezone,
    locale: canonical.locale,
    nowUtc: utc.toISO()!,
    localDate: canonical.localDate,
    isoWeek: canonical.isoWeek.key,
    isoWeekYear: canonical.isoWeek.weekYear,
    isoWeekNumber: canonical.isoWeek.weekNumber,
    localDayStartUtc: localDayStart.toUTC().toISO()!,
    localDayEndUtc: localDayEnd.toUTC().toISO()!,
  });
}
