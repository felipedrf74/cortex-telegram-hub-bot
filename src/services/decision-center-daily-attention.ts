// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { createDecisionIntent } from './decision-center';
import { getDb } from './database';
import { isDecisionCenterDailyAttentionEnabled } from './runtime-flags';
import { listTasksForUser } from './task-store/task-service';
import type { NormalizedTask } from './task-store/types';
import { getUserTimezoneById } from './user-service';
import { logger } from '../utils/logger';

export type DailyAttentionStatus = 'materialized' | 'skipped' | 'failed';
export type DailyAttentionSkipReason =
  | 'flag_disabled'
  | 'already_materialized'
  | 'non_canonical_task_tenant_scope'
  | 'no_task_attention_needed'
  | 'invalid_scope'
  | 'task_read_failed'
  | 'decision_create_failed';

export interface DailyTaskAttentionCounts {
  pending: number;
  overdue: number;
  dueToday: number;
  highPriority: number;
}

export interface DailyAttentionMaterializeInput {
  userId: number;
  tenantId: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface DailyAttentionMaterializeResult {
  status: DailyAttentionStatus;
  reason?: DailyAttentionSkipReason;
  localDate: string | null;
  timezone: string;
  counts: DailyTaskAttentionCounts;
  dedupeKey: string | null;
  decisionId: string | null;
}

const EMPTY_COUNTS: DailyTaskAttentionCounts = Object.freeze({
  pending: 0,
  overdue: 0,
  dueToday: 0,
  highPriority: 0,
});

const HIGH_PRIORITY_THRESHOLD = 3;

export async function materializeDecisionCenterDailyAttention(
  input: DailyAttentionMaterializeInput,
): Promise<DailyAttentionMaterializeResult> {
  if (!Number.isInteger(input.userId) || input.userId <= 0 || !Number.isInteger(input.tenantId) || input.tenantId <= 0) {
    return {
      status: 'skipped',
      reason: 'invalid_scope',
      localDate: null,
      timezone: 'Europe/Lisbon',
      counts: EMPTY_COUNTS,
      dedupeKey: null,
      decisionId: null,
    };
  }

  if (!isDecisionCenterDailyAttentionEnabled(input.env ?? process.env, { userId: input.userId, tenantId: input.tenantId })) {
    return {
      status: 'skipped',
      reason: 'flag_disabled',
      localDate: null,
      timezone: 'Europe/Lisbon',
      counts: EMPTY_COUNTS,
      dedupeKey: null,
      decisionId: null,
    };
  }

  const timezone = getUserTimezoneById(input.userId);
  const localDate = localDateFor(input.now ?? new Date(), timezone);
  const base = (overrides: Partial<DailyAttentionMaterializeResult>): DailyAttentionMaterializeResult => ({
    status: 'skipped',
    localDate,
    timezone,
    counts: EMPTY_COUNTS,
    dedupeKey: null,
    decisionId: null,
    ...overrides,
  });

  if (input.tenantId !== input.userId) {
    logger.warn(
      { userId: input.userId, tenantId: input.tenantId, surface: 'decision_center_daily_attention' },
      'Skipped Decision Center task attention because task read model is user-private in this tenant scope',
    );
    return base({ reason: 'non_canonical_task_tenant_scope' });
  }

  let tasks: NormalizedTask[];
  try {
    tasks = listTasksForUser(input.userId, { status: 'pending' });
  } catch (err) {
    logger.warn(
      { errType: err instanceof Error ? err.name : typeof err, userId: input.userId, tenantId: input.tenantId },
      'Decision Center daily task attention read failed',
    );
    return base({ status: 'failed', reason: 'task_read_failed' });
  }

  const counts = summarizeTaskAttention(tasks, localDate, timezone);
  if (counts.overdue === 0 && counts.dueToday === 0 && counts.highPriority === 0) {
    return base({ reason: 'no_task_attention_needed', counts });
  }

  const sourceState = counts.overdue > 0 ? 'overdue_tasks' : counts.highPriority > 0 ? 'important_tasks' : 'task_pressure';
  const dedupeKey = `secretary:daily-attention:tasks:${input.tenantId}:${input.userId}:${localDate}`;
  if (dailyAttentionIntentAlreadyExists(input.userId, input.tenantId, dedupeKey)) {
    return base({ reason: 'already_materialized', counts, dedupeKey });
  }
  const { title, body, primaryActionLabel, deeplink } = taskAttentionCopy(counts);

  try {
    const created = await createDecisionIntent({
      userId: input.userId,
      tenantId: input.tenantId,
      sourceSkill: 'secretary',
      type: 'decision_required',
      priority: 'active',
      relatedEntityType: 'task_attention_day',
      relatedEntityId: localDate,
      title,
      body,
      sensitiveBody: null,
      actionButtons: [
        { id: 'open_detail', label: primaryActionLabel, style: 'primary', deeplink },
        { id: 'open_today_plan', label: 'Open today\'s plan', style: 'secondary', deeplink: 'nexushub://today' },
      ],
      deeplink,
      expiresAt: localDayEndIso(localDate, timezone),
      quietHoursPolicy: 'respect',
      dedupeKey,
      requiresUserAction: true,
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'standard',
      decisionContext: {
        recipe: 'daily_task_attention',
        sourceState,
        entityTitle: 'Daily task attention',
        reasonCodes: taskAttentionReasonCodes(counts),
        taskCounts: {
          pending: counts.pending,
          overdue: counts.overdue,
          dueToday: counts.dueToday,
          highPriority: counts.highPriority,
        },
        timezone,
        visibilityScope: 'user_private',
      },
      visibilityScope: 'user_private',
    });
    if (!created.item) {
      if (created.eligibility.classification === 'decision') {
        return base({ reason: 'already_materialized', counts, dedupeKey });
      }
      logger.warn(
        { userId: input.userId, tenantId: input.tenantId, dedupeKey, eligibility: created.eligibility.classification },
        'Decision Center daily task attention was not created',
      );
      return base({ status: 'failed', reason: 'decision_create_failed', counts, dedupeKey });
    }
    return base({
      status: 'materialized',
      counts,
      dedupeKey,
      decisionId: created.item.decisionId,
    });
  } catch (err) {
    logger.warn(
      { errType: err instanceof Error ? err.name : typeof err, userId: input.userId, tenantId: input.tenantId, dedupeKey },
      'Decision Center daily task attention create failed',
    );
    return base({ status: 'failed', reason: 'decision_create_failed', counts, dedupeKey });
  }
}

function dailyAttentionIntentAlreadyExists(userId: number, tenantId: number, dedupeKey: string): boolean {
  try {
    const row = getDb().prepare(`
      SELECT 1
        FROM notification_intents
       WHERE user_id = ?
         AND tenant_id = ?
         AND source_skill = 'secretary'
         AND dedupe_key = ?
         AND status != 'expired'
       LIMIT 1
    `).get(userId, tenantId, dedupeKey) as unknown | undefined;
    return !!row;
  } catch {
    return false;
  }
}

export function summarizeTaskAttention(
  tasks: NormalizedTask[],
  localDate: string,
  timezone: string,
): DailyTaskAttentionCounts {
  let pending = 0;
  let overdue = 0;
  let dueToday = 0;
  let highPriority = 0;

  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    pending += 1;
    if (task.priority >= HIGH_PRIORITY_THRESHOLD) highPriority += 1;

    const dueKey = taskDueDateKey(task, timezone);
    if (!dueKey) continue;
    if (dueKey < localDate) overdue += 1;
    if (dueKey === localDate) dueToday += 1;
  }

  return { pending, overdue, dueToday, highPriority };
}

function taskAttentionCopy(counts: DailyTaskAttentionCounts): {
  title: string;
  body: string;
  primaryActionLabel: string;
  deeplink: string;
} {
  if (counts.overdue > 0) {
    const title = 'Clear overdue tasks';
    const phrases = [
      countPhrase(counts.overdue, 'overdue task'),
      counts.dueToday > 0 ? countPhrase(counts.dueToday, 'task due today', 'tasks due today') : null,
      counts.highPriority > 0 ? countPhrase(counts.highPriority, 'high-priority task') : null,
    ];
    const body = `${joinCountPhrases(phrases)} ${attentionVerb(phrases)} a short review.`;
    return { title, body, primaryActionLabel: 'Open overdue tasks', deeplink: 'nexushub://tasks?filter=overdue' };
  }

  const title = 'Choose today\'s task focus';
  const phrases = [
    counts.dueToday > 0 ? countPhrase(counts.dueToday, 'task due today', 'tasks due today') : null,
    counts.highPriority > 0 ? countPhrase(counts.highPriority, 'high-priority task') : null,
  ];
  const body = `${joinCountPhrases(phrases)} ${attentionVerb(phrases)} a focus choice.`;
  return { title, body, primaryActionLabel: 'Open today\'s tasks', deeplink: 'nexushub://tasks?filter=dueToday' };
}

function taskAttentionReasonCodes(counts: DailyTaskAttentionCounts): string[] {
  const codes = ['daily_attention'];
  if (counts.overdue > 0) codes.push('overdue_tasks');
  if (counts.dueToday > 0) codes.push('tasks_due_today');
  if (counts.highPriority > 0) codes.push('high_priority_tasks');
  return codes;
}

function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinCountPhrases(values: Array<string | null>): string {
  const parts = values.filter((value): value is string => Boolean(value));
  if (parts.length === 0) return 'Open tasks';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function attentionVerb(values: Array<string | null>): 'need' | 'needs' {
  const parts = values.filter((value): value is string => Boolean(value));
  return parts.length === 1 && /^1\b/.test(parts[0]) ? 'needs' : 'need';
}

function localDateFor(now: Date, timezone: string): string {
  return DateTime.fromJSDate(now).setZone(timezone).toISODate() ?? now.toISOString().slice(0, 10);
}

function localDayEndIso(localDate: string, timezone: string): string | null {
  return DateTime.fromISO(localDate, { zone: timezone }).plus({ days: 1 }).toUTC().toISO();
}

function taskDueDateKey(task: NormalizedTask, timezone: string): string | null {
  const raw = task.dueDate?.trim();
  if (!raw) return null;
  const isoDate = raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  if (!task.dueIsDatetime && isoDate) return isoDate;

  const parsed = DateTime.fromISO(raw, { zone: timezone });
  if (!parsed.isValid) return isoDate;
  return parsed.setZone(timezone).toISODate() ?? isoDate;
}
