// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { DecisionPlanningContext } from './decision-planning-context';

export interface PlanningSnapshotIdentity {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly userId: number;
  readonly tenantId: number;
  readonly timezone: string;
  readonly locale: string;
  readonly localDate: string;
  readonly weekStart: string;
  readonly isoWeek: string;
}

export function createPlanningSnapshotIdentity(
  context: DecisionPlanningContext,
  weekStart: string,
): PlanningSnapshotIdentity {
  const week = DateTime.fromISO(weekStart, { zone: context.timezone }).startOf('week');
  if (!week.isValid) throw new Error('PLANNING_SNAPSHOT_WEEK_INVALID');
  const normalizedWeekStart = week.toISODate()!;
  const isoWeek = `${week.weekYear}-W${String(week.weekNumber).padStart(2, '0')}`;
  const fingerprint = createHash('sha256').update(JSON.stringify({
    capturedAt: context.nowUtc,
    locale: context.locale,
    scope: { tenantId: context.tenantId, userId: context.userId },
    timezone: context.timezone,
    weekStart: normalizedWeekStart,
  })).digest('hex');
  return Object.freeze({
    snapshotId: `plan_${fingerprint}`,
    generatedAt: context.nowUtc,
    userId: context.userId,
    tenantId: context.tenantId,
    timezone: context.timezone,
    locale: context.locale,
    localDate: context.localDate,
    weekStart: normalizedWeekStart,
    isoWeek,
  });
}

export function assertPlanningSnapshotScope(
  snapshot: PlanningSnapshotIdentity,
  input: { userId: number; tenantId: number; timezone: string; weekStart: string },
): void {
  if (
    snapshot.userId !== input.userId
    || snapshot.tenantId !== input.tenantId
    || snapshot.timezone !== input.timezone
    || snapshot.weekStart !== input.weekStart
  ) {
    throw new Error('PLANNING_SNAPSHOT_SCOPE_MISMATCH');
  }
}
