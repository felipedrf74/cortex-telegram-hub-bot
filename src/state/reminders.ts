// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../config';
import { Reminder } from '../domains/types';
import { getDb } from '../services/database';
import { now } from '../utils/date-parser';

function assertReminderSchemaReady(db: any): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
  if (!table) {
    throw new Error('REMINDERS_SCHEMA_MISSING:reminders');
  }
  const columns = db.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const missing = ['tenant_id', 'timezone', 'agenda_item_id'].filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(`REMINDERS_SCHEMA_MISSING:${missing.join(',')}`);
  }
}

function reminderSchemaReadyForOptionalCascade(db: any): boolean {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
  if (!table) return false;
  assertReminderSchemaReady(db);
  return true;
}

function resolveTenantId(userId: number, tenantId?: number | string | null): number {
  const numeric = Number(tenantId);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : userId;
}

function normalizeTimezone(timezone?: string | null): string {
  if (timezone && DateTime.now().setZone(timezone).isValid) {
    return timezone;
  }
  return config.app.timezone || 'UTC';
}

function parseReminderTime(value: string, timezone: string): DateTime | null {
  const parsed = DateTime.fromISO(value, { zone: timezone, setZone: true });
  return parsed.isValid ? parsed : null;
}

export function setReminder(userId: number, data: {
  message: string;
  remind_at: string;
  recurring?: string;
  agenda_item_id?: string | null;
  tenant_id?: number | string | null;
  timezone?: string | null;
}, options: {
  tenantId?: number | string | null;
  timezone?: string | null;
} = {}): Reminder {
  const db = getDb();
  assertReminderSchemaReady(db);
  const tenantId = resolveTenantId(userId, options.tenantId ?? data.tenant_id);
  const timezone = normalizeTimezone(options.timezone ?? data.timezone);
  const stmt = db.prepare(`
    INSERT INTO reminders (user_id, tenant_id, message, remind_at, recurring, agenda_item_id, timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    userId,
    tenantId,
    data.message,
    data.remind_at,
    data.recurring || null,
    data.agenda_item_id ?? null,
    timezone,
  );
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(result.lastInsertRowid) as Reminder;
}

export function getActiveReminders(userId: number, tenantId?: number | string | null): Reminder[] {
  const db = getDb();
  assertReminderSchemaReady(db);
  const resolvedTenantId = resolveTenantId(userId, tenantId);
  return db.prepare(`
    SELECT * FROM reminders
    WHERE tenant_id = ? AND user_id = ? AND status = 'active'
    ORDER BY remind_at ASC
  `).all(resolvedTenantId, userId) as Reminder[];
}

/**
 * Get all due reminders across ALL users (for the scheduler).
 * Returns user_id and tenant_id with each reminder so the scheduler knows who
 * to notify and which workspace owns the row.
 */
export function getDueReminders(): Reminder[] {
  const db = getDb();
  assertReminderSchemaReady(db);
  const current = now().toUTC();
  const reminders = db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'active'
    ORDER BY remind_at ASC
  `).all() as Reminder[];
  return reminders
    .filter((reminder) => {
      const timezone = normalizeTimezone(reminder.timezone);
      const reminderTime = parseReminderTime(reminder.remind_at, timezone);
      return reminderTime ? reminderTime.toUTC().toMillis() <= current.toMillis() : false;
    })
    .sort((a, b) => {
      const aTime = parseReminderTime(a.remind_at, normalizeTimezone(a.timezone))?.toUTC().toMillis() ?? Number.MAX_SAFE_INTEGER;
      const bTime = parseReminderTime(b.remind_at, normalizeTimezone(b.timezone))?.toUTC().toMillis() ?? Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
}

export function markReminderFired(id: number): void {
  const db = getDb();
  assertReminderSchemaReady(db);
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | undefined;
  if (!reminder) return;
  const tenantId = resolveTenantId(reminder.user_id, reminder.tenant_id);
  const updateReminder = (sql: string, ...params: Array<number | string>) => {
    db.prepare(sql).run(...params, id, tenantId, reminder.user_id);
  };

  if (reminder.recurring) {
    const timezone = normalizeTimezone(reminder.timezone);
    const current = parseReminderTime(reminder.remind_at, timezone);
    if (!current) {
      updateReminder("UPDATE reminders SET status = 'fired' WHERE id = ? AND tenant_id = ? AND user_id = ?");
      return;
    }
    let next: DateTime;

    switch (reminder.recurring) {
      case 'daily':
        next = current.plus({ days: 1 });
        break;
      case 'weekly':
        next = current.plus({ weeks: 1 });
        break;
      case 'monthly':
        next = current.plus({ months: 1 });
        break;
      default:
        updateReminder("UPDATE reminders SET status = 'fired' WHERE id = ? AND tenant_id = ? AND user_id = ?");
        return;
    }

    updateReminder('UPDATE reminders SET remind_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?', next.toISO()!);
  } else {
    updateReminder("UPDATE reminders SET status = 'fired' WHERE id = ? AND tenant_id = ? AND user_id = ?");
  }
}

export function cancelReminder(userId: number, id: number, tenantId?: number | string | null): boolean {
  const db = getDb();
  assertReminderSchemaReady(db);
  const resolvedTenantId = resolveTenantId(userId, tenantId);
  const result = db.prepare(`
    UPDATE reminders
       SET status = 'cancelled'
     WHERE tenant_id = ?
       AND user_id = ?
       AND id = ?
  `).run(resolvedTenantId, userId, id);
  return Number(result.changes ?? 0) > 0;
}

export function cancelRemindersForAgendaItem(
  userId: number,
  agendaItemId: string,
  tenantId?: number | string | null,
): number {
  const db = getDb();
  if (!reminderSchemaReadyForOptionalCascade(db)) return 0;
  const resolvedTenantId = resolveTenantId(userId, tenantId);
  const result = db.prepare(`
    UPDATE reminders
       SET status = 'cancelled'
     WHERE tenant_id = ?
       AND user_id = ?
       AND agenda_item_id = ?
       AND status = 'active'
  `).run(resolvedTenantId, userId, agendaItemId);
  return Number(result.changes ?? 0);
}

export function updateRemindersForAgendaItem(
  userId: number,
  agendaItemId: string,
  remindAt: string,
  tenantId?: number | string | null,
): number {
  const db = getDb();
  if (!reminderSchemaReadyForOptionalCascade(db)) return 0;
  const resolvedTenantId = resolveTenantId(userId, tenantId);
  const result = db.prepare(`
    UPDATE reminders
       SET remind_at = ?
     WHERE tenant_id = ?
       AND user_id = ?
       AND agenda_item_id = ?
       AND status = 'active'
  `).run(remindAt, resolvedTenantId, userId, agendaItemId);
  return Number(result.changes ?? 0);
}

/**
 * Get today's reminders for a specific user (for briefings).
 */
export function getRemindersForToday(
  userId: number,
  tenantId?: number | string | null,
  timezone?: string | null,
): Reminder[] {
  const db = getDb();
  assertReminderSchemaReady(db);
  const resolvedTenantId = resolveTenantId(userId, tenantId);
  const defaultTimezone = normalizeTimezone(timezone);
  const current = now();
  const reminders = db.prepare(`
    SELECT * FROM reminders
    WHERE tenant_id = ? AND user_id = ? AND status = 'active'
    ORDER BY remind_at ASC
  `).all(resolvedTenantId, userId) as Reminder[];
  return reminders.filter((reminder) => {
    const reminderTimezone = normalizeTimezone(reminder.timezone || defaultTimezone);
    const reminderTime = parseReminderTime(reminder.remind_at, reminderTimezone);
    const todayInReminderTimezone = current.setZone(reminderTimezone).toFormat('yyyy-MM-dd');
    return reminderTime?.setZone(reminderTimezone).toFormat('yyyy-MM-dd') === todayInReminderTimezone;
  });
}
