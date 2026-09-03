// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../config';
import { normalizeSupportedLang, type Lang } from '../utils/i18n';
import { getUserById } from './user-service';
import { isValidTenantUserId } from './tenant-scope-observability';
import { canonicalizeIanaTimezone } from './secretary-timezone';

export type PlanSourceStatus = 'ready' | 'stale' | 'degraded' | 'unavailable';

export interface PlanSourceHealth {
  status: PlanSourceStatus;
  warningCodes: string[];
  warnings: string[];
}

export type WeeklyPlanSourceKey =
  | 'calendar'
  | 'tasks'
  | 'mail'
  | 'focus'
  | 'training'
  | 'cooking'
  | 'content'
  | 'finance';

export type DailyPlanSourceKey = WeeklyPlanSourceKey | 'decision_center';

export type WeeklyPlanSourceHealth = Record<WeeklyPlanSourceKey, PlanSourceHealth>;
export type DailyPlanSourceHealth = Record<DailyPlanSourceKey, PlanSourceHealth>;

export interface SecretaryPlanningContext {
  userId: number;
  tenantId: number;
  capturedAt: string;
  timezone: string;
  language: Lang;
  targetDate: string;
  weekStart: string;
  weekEnd: string;
  // Keep the shared planning context free of profile credentials and PII. The
  // orchestrators only need the stable account identifier after scope has
  // already been verified.
  user: { id: number } | null;
  warningCodes: string[];
  warnings: string[];
}

export type SecretaryPlanningContextErrorCode =
  | 'INVALID_SCOPE'
  | 'TENANT_SCOPE_MISMATCH'
  | 'INVALID_DATE'
  | 'INVALID_WEEK_START'
  | 'DATE_OUTSIDE_WEEK';

export class SecretaryPlanningContextError extends Error {
  constructor(
    readonly code: SecretaryPlanningContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecretaryPlanningContextError';
  }
}

export function resolveSecretaryPlanningContext(input: {
  userId: number;
  tenantId?: number;
  date?: string;
  weekStart?: string;
  language?: string;
  now?: Date;
}): SecretaryPlanningContext {
  assertSecretaryPlanningScope(input.userId, input.tenantId);
  const requestedDate = parseDateOnly(input.date, 'UTC', 'INVALID_DATE');
  const requestedWeek = parseDateOnly(input.weekStart, 'UTC', 'INVALID_WEEK_START');

  // Scope is verified before the first user-owned read. This ordering is a
  // security contract: a malformed tenant can never influence cache keys or
  // cause user/profile reads under another identity.
  const userRecord = getUserById(input.userId);
  const timezoneResult = resolvePlanningTimezone(userRecord?.timezone);
  const language = normalizeSupportedLang(input.language, normalizeSupportedLang(userRecord?.language, 'pt-BR'));
  const capturedAt = DateTime.fromJSDate(input.now ?? new Date(), { zone: 'utc' });
  const requestedWeekStart = requestedWeek
    ? DateTime.fromISO(requestedWeek, { zone: timezoneResult.timezone }).startOf('week').toISODate()!
    : null;
  // A week-only recompute must derive its daily projection from that same
  // week, never from an unrelated current date outside the composed result.
  const targetDate = requestedDate
    ?? requestedWeekStart
    ?? capturedAt.setZone(timezoneResult.timezone).toISODate()!;
  const weekStart = requestedWeekStart
    ?? DateTime.fromISO(targetDate, { zone: timezoneResult.timezone }).startOf('week').toISODate()!;
  const weekEnd = DateTime.fromISO(weekStart, { zone: timezoneResult.timezone }).plus({ days: 6 }).toISODate()!;
  if (requestedDate && requestedWeek && (requestedDate < weekStart || requestedDate > weekEnd)) {
    throw new SecretaryPlanningContextError(
      'DATE_OUTSIDE_WEEK',
      'The requested date must fall within the requested planning week.',
    );
  }

  return {
    userId: input.userId,
    tenantId: input.tenantId ?? input.userId,
    capturedAt: capturedAt.toISO()!,
    timezone: timezoneResult.timezone,
    language,
    targetDate,
    weekStart,
    weekEnd,
    user: userRecord ? { id: userRecord.id } : null,
    warningCodes: timezoneResult.warningCodes,
    warnings: timezoneResult.warnings,
  };
}

export function assertSecretaryPlanningContextMatches(
  context: SecretaryPlanningContext,
  input: { userId: number; tenantId?: number },
): void {
  assertSecretaryPlanningScope(input.userId, input.tenantId);
  const tenantId = input.tenantId ?? input.userId;
  if (context.userId !== input.userId || context.tenantId !== tenantId) {
    throw new SecretaryPlanningContextError(
      'TENANT_SCOPE_MISMATCH',
      'Planning context does not match the requested account scope.',
    );
  }
}

/**
 * Retarget an already-authenticated planning context without repeating any
 * account/profile I/O. Chat planning uses this after its deterministic date
 * parser has selected a local day from the user's message.
 */
export function withSecretaryPlanningTargetDate(
  context: SecretaryPlanningContext,
  targetDate: string,
): SecretaryPlanningContext {
  const parsedDate = parseDateOnly(targetDate, context.timezone, 'INVALID_DATE');
  if (!parsedDate) {
    throw new SecretaryPlanningContextError('INVALID_DATE', 'A target planning date is required.');
  }
  const weekStart = DateTime.fromISO(parsedDate, { zone: context.timezone }).startOf('week').toISODate()!;
  const weekEnd = DateTime.fromISO(weekStart, { zone: context.timezone }).plus({ days: 6 }).toISODate()!;
  return {
    ...context,
    targetDate: parsedDate,
    weekStart,
    weekEnd,
  };
}

export function readyPlanSource(): PlanSourceHealth {
  return { status: 'ready', warningCodes: [], warnings: [] };
}

export function unavailablePlanSource(code: string, warning: string): PlanSourceHealth {
  return { status: 'unavailable', warningCodes: [code], warnings: [warning] };
}

export function degradedPlanSource(code: string, warning: string): PlanSourceHealth {
  return { status: 'degraded', warningCodes: [code], warnings: [warning] };
}

export function mergePlanWarnings(
  context: Pick<SecretaryPlanningContext, 'warningCodes' | 'warnings'>,
  sourceHealth: Partial<Record<DailyPlanSourceKey, PlanSourceHealth>>,
  extra?: { warningCodes?: string[]; warnings?: string[] },
): { warningCodes: string[]; warnings: string[] } {
  return {
    warningCodes: unique([
      ...context.warningCodes,
      ...Object.values(sourceHealth).flatMap((source) => source?.warningCodes ?? []),
      ...(extra?.warningCodes ?? []),
    ]),
    warnings: unique([
      ...context.warnings,
      ...Object.values(sourceHealth).flatMap((source) => source?.warnings ?? []),
      ...(extra?.warnings ?? []),
    ]),
  };
}

export function planLanguageLocale(language: Lang): string {
  if (language === 'pt-BR') return 'pt-BR';
  if (language === 'pt-PT') return 'pt-PT';
  return 'en-US';
}

export function assertSecretaryPlanningScope(userId: number, tenantId?: number): void {
  if (!isValidTenantUserId(userId)) {
    throw new SecretaryPlanningContextError('INVALID_SCOPE', 'Invalid authenticated user scope.');
  }
  const resolvedTenantId = tenantId ?? userId;
  if (!isValidTenantUserId(resolvedTenantId) || resolvedTenantId !== userId) {
    throw new SecretaryPlanningContextError(
      'TENANT_SCOPE_MISMATCH',
      'The active tenant does not match the authenticated user.',
    );
  }
}

function resolvePlanningTimezone(candidate: string | null | undefined): {
  timezone: string;
  warningCodes: string[];
  warnings: string[];
} {
  const fallback = canonicalizeIanaTimezone(config.app.timezone) ?? 'Europe/Lisbon';
  const timezone = canonicalizeIanaTimezone(candidate);
  if (timezone) {
    return { timezone, warningCodes: [], warnings: [] };
  }
  if (!candidate) {
    return { timezone: fallback, warningCodes: [], warnings: [] };
  }
  return {
    timezone: fallback,
    warningCodes: ['USER_TIMEZONE_INVALID'],
    warnings: ['The saved timezone is invalid; the account fallback timezone is being used.'],
  };
}

function parseDateOnly(
  value: string | undefined,
  timezone: string,
  code: 'INVALID_DATE' | 'INVALID_WEEK_START',
): string | null {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SecretaryPlanningContextError(code, 'Expected an ISO calendar date in YYYY-MM-DD format.');
  }
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid || parsed.toISODate() !== value) {
    throw new SecretaryPlanningContextError(code, 'The requested calendar date is not valid.');
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
