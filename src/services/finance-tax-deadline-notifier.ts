// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Notify before a tax payment falls due.
 *
 * Until now the only producer for `finance_tax_event` fired from
 * `POST /tax/events/:month/calculate` — i.e. only if the user themselves
 * opened Finance and pressed calculate. A statutory deadline with a real
 * financial penalty had no scheduled reminder at all, and
 * `notification_profiles.finance_reminder_days` had zero readers.
 *
 * Two stages:
 *   FIN-01  due in `financeReminderDays` (default 1) → active
 *   FIN-02  due today                                → time_sensitive
 *
 * DEVIATION from the catalog, deliberate: the catalog gives both stages the
 * same dedupe key "so they collapse". They cannot share one — the dedupe index
 * matches on any unresolved row, so the due-today escalation would be swallowed
 * by the still-open due-soon item and the user would never get the last
 * recoverable warning. Instead each stage has its own key, and the due-soon
 * item expires at the start of the due day so it retires as the escalation
 * lands rather than sitting in the inbox alongside it.
 *
 * Amounts never reach the payload. `privacyPolicy: 'financial'` routes the
 * lock screen through the privacy-safe body; the reference and the figures
 * stay behind authenticated app access.
 */

import { getDb } from './database';
import { createNotificationIntent, notificationDecisionReachedUser, notificationDeliveryFailed, getNotificationProfileIfExists } from './notification-orchestrator';
import { logger } from '../utils/logger';

/**
 * Canonical tax due date for a `YYYY-MM` period: the 20th of that month at
 * 09:00 UTC. Single definition — `financeTaxReminderWindow` in the finance
 * route derives its Secretary reminder window from this, so the scheduled
 * notification and the in-app reminder can never drift apart.
 */
export function financeTaxDueAt(month: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return null;
  return new Date(Date.UTC(year, monthNumber - 1, 20, 9, 0, 0, 0));
}

export type TaxDeadlineStage = 'due_soon' | 'due_today';

export interface TaxDeadlineSummary {
  inspected: number;
  notified: number;
  failed: number;
}

interface TaxEventRow {
  month: string;
  status: string;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

/**
 * Which stage, if any, this event is in right now.
 * Returns null when the deadline is further out than the user's lead time, or
 * already past — a missed statutory deadline is a different product problem
 * and is not solved by a notification after the fact.
 */
export function resolveTaxDeadlineStage(
  dueAt: Date,
  now: Date,
  reminderDays: number,
): TaxDeadlineStage | null {
  const dueDay = startOfUtcDay(dueAt).getTime();
  const today = startOfUtcDay(now).getTime();
  const daysOut = Math.round((dueDay - today) / 86_400_000);
  if (daysOut === 0) return 'due_today';
  if (daysOut > 0 && daysOut <= Math.max(1, reminderDays)) return 'due_soon';
  return null;
}

export async function runFinanceTaxDeadlineNotices(
  userIds: number[],
  now = new Date(),
): Promise<TaxDeadlineSummary> {
  const summary: TaxDeadlineSummary = { inspected: 0, notified: 0, failed: 0 };
  const db = getDb();

  for (const userId of userIds) {
    const profile = getNotificationProfileIfExists(userId);
    if (!profile) continue;
    if (!profile.skillPreferences.finance) continue;

    const reminderDays = Number.isFinite(profile.financeReminderDays) && profile.financeReminderDays > 0
      ? profile.financeReminderDays
      : 1;

    let rows: TaxEventRow[] = [];
    try {
      rows = db.prepare(`
        SELECT month, status
          FROM finance_tax_events
         WHERE user_id = ?
           AND status != 'paid'
           -- Match the calculation route's eligibility contract. A pending
           -- row is not necessarily a bill: zero-liability months are stored
           -- for history and must never become "payment due" alerts.
           AND (tax_due > 0 OR inss_due > 0)
         ORDER BY month DESC
         LIMIT 24
      `).all(userId) as TaxEventRow[];
    } catch (err) {
      logger.warn({ err, userId }, 'tax deadline read failed');
      summary.failed += 1;
      continue;
    }

    for (const row of rows) {
      const dueAt = financeTaxDueAt(row.month);
      if (!dueAt) continue;
      const stage = resolveTaxDeadlineStage(dueAt, now, reminderDays);
      if (!stage) continue;

      summary.inspected += 1;
      const dueToday = stage === 'due_today';
      try {
        const result = await createNotificationIntent({
          userId,
          tenantId: userId,
          sourceSkill: 'finance',
          type: 'decision_required',
          priority: dueToday ? 'time_sensitive' : 'active',
          relatedEntityId: row.month,
          relatedEntityType: 'finance_tax_event',
          title: dueToday ? 'Tax payment due today' : 'Tax payment due soon',
          body: dueToday
            ? 'Open Nexus for the payment reference.'
            : `Due ${dueAt.toISOString().slice(0, 10)}.`,
          // Amounts and references are deliberately absent from body/title;
          // they live only behind authenticated access.
          sensitiveBody: `Tax event ${row.month}: amounts and reference are available in Finance.`,
          actionButtons: [
            { id: 'mark_paid', label: 'Mark paid', style: 'primary' },
            { id: 'open_detail', label: 'Open', style: 'secondary' },
          ],
          deeplink: `nexus://finance/reminder/${encodeURIComponent(row.month)}`,
          // Stage-scoped — see the module note on why these must NOT collapse.
          dedupeKey: `finance:tax_deadline:${stage}:${row.month}`,
          requiresUserAction: true,
          decisionDeadline: dueAt.toISOString(),
          // due_soon retires as the escalation lands; due_today dies with the day.
          expiresAt: dueToday ? endOfUtcDay(dueAt).toISOString() : startOfUtcDay(dueAt).toISOString(),
          privacyPolicy: 'financial',
        });
        if (notificationDecisionReachedUser(result.decisionLog?.decision)) summary.notified += 1;
        // A push that was attempted and rejected is an outage signal, not a
        // quiet tick. Counting only thrown exceptions here let a 100%-failing
        // sweep report failed: 0 and the scheduler mark the job green.
        if (notificationDeliveryFailed(result.deliveryAttempts)) summary.failed += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn({ err, userId, month: row.month, stage }, 'tax deadline notice failed');
      }
    }
  }

  return summary;
}
