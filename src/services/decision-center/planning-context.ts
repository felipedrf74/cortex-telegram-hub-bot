// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import type {
  DecisionClock,
  DecisionPlanningContext,
  DecisionScope,
} from './contracts';
import { DecisionCenterError } from './errors';

export const SYSTEM_DECISION_CLOCK: DecisionClock = Object.freeze({
  now: () => new Date(),
});

export interface CreateDecisionPlanningContextInput {
  readonly scope: DecisionScope;
  readonly timezone: string;
  readonly locale: string;
  readonly clock?: DecisionClock;
}

/** Capture the request clock exactly once and derive every calendar key from it. */
export function createDecisionPlanningContext(
  input: CreateDecisionPlanningContextInput,
): DecisionPlanningContext {
  assertScope(input.scope);
  const timezone = assertTimezone(input.timezone);
  const locale = assertLocale(input.locale);
  const clock = input.clock ?? SYSTEM_DECISION_CLOCK;
  const captured = clock.now();
  if (!(captured instanceof Date) || !Number.isFinite(captured.getTime())) {
    throw new DecisionCenterError(
      'DECISION_PLANNING_CONTEXT_INVALID',
      'Decision planning clock returned an invalid instant.',
      500,
      { field: 'clock' },
    );
  }

  const local = DateTime.fromJSDate(captured, { zone: timezone }).setLocale(locale);
  if (!local.isValid) {
    throw new DecisionCenterError(
      'DECISION_PLANNING_CONTEXT_INVALID',
      'Decision planning context could not resolve the local calendar date.',
      400,
      { field: 'timezone' },
    );
  }

  const weekStart = local.startOf('week');
  const weekEnd = weekStart.plus({ days: 6 });
  const weekNumber = local.weekNumber;
  const weekYear = local.weekYear;

  return Object.freeze({
    scope: Object.freeze({ ...input.scope }),
    timezone,
    locale,
    localDate: local.toISODate()!,
    isoWeek: Object.freeze({
      weekYear,
      weekNumber,
      key: `${weekYear}-W${String(weekNumber).padStart(2, '0')}`,
      startsOn: weekStart.toISODate()!,
      endsOn: weekEnd.toISODate()!,
    }),
    capturedAt: captured.toISOString(),
    clock,
  });
}

function assertScope(scope: DecisionScope): void {
  if (!Number.isSafeInteger(scope.userId) || scope.userId < 1
    || !Number.isSafeInteger(scope.tenantId) || scope.tenantId < 1) {
    throw new DecisionCenterError(
      'DECISION_SCOPE_INVALID',
      'Decision planning requires positive integer user and tenant identifiers.',
      400,
    );
  }
}

function assertTimezone(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100) {
    throw new DecisionCenterError(
      'DECISION_PLANNING_CONTEXT_INVALID',
      'timezone must be a valid IANA timezone.',
      400,
      { field: 'timezone' },
    );
  }
  const timezone = value.trim();
  if (!DateTime.now().setZone(timezone).isValid) {
    throw new DecisionCenterError(
      'DECISION_PLANNING_CONTEXT_INVALID',
      'timezone must be a valid IANA timezone.',
      400,
      { field: 'timezone' },
    );
  }
  return timezone;
}

function assertLocale(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100) {
    throw new DecisionCenterError(
      'DECISION_PLANNING_CONTEXT_INVALID',
      'locale must be a valid BCP-47 locale.',
      400,
      { field: 'locale' },
    );
  }
  const locale = value.trim();
  try {
    return new Intl.Locale(locale).toString();
  } catch {
    throw new DecisionCenterError(
      'DECISION_PLANNING_CONTEXT_INVALID',
      'locale must be a valid BCP-47 locale.',
      400,
      { field: 'locale' },
    );
  }
}
