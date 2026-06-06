// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { Reminder } from '../domains/types';
import { DateTime } from 'luxon';
import { now } from '../utils/date-parser';
import { config } from '../config';

function ensureReminderAgendaLinkColumn(db: any): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'agenda_item_id')) {
    db.exec('ALTER TABLE reminders ADD COLUMN agenda_item_id TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_agenda_item
      ON reminders(user_id, agenda_item_id, remind_at)
      WHERE agenda_item_id IS NOT NULL
  `);
}

export function setReminder(userId: number, data: {
  message: string;
  remind_at: string;
  recurring?: string;
  agenda_item_id?: string | null;
}): Reminder {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  const stmt = db.prepare(`
    INSERT INTO reminders (user_id, message, remind_at, recurring, agenda_item_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(userId, data.message, data.remind_at, data.recurring || null, data.agenda_item_id ?? null);
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(result.lastInsertRowid) as Reminder;
}

export function getActiveReminders(userId: number): Reminder[] {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  return db.prepare(`
    SELECT * FROM reminders WHERE user_id = ? AND status = 'active' ORDER BY remind_at ASC
  `).all(userId) as Reminder[];
}

/**
 * Get all due reminders across ALL users (for the scheduler).
 * Returns user_id with each reminder so the scheduler knows who to notify.
 */
export function getDueReminders(): Reminder[] {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  const currentISO = now().toISO()!;
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'active'
    AND remind_at <= ?
    ORDER BY remind_at ASC
  `).all(currentISO) as Reminder[];
}

export function markReminderFired(id: number): void {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | undefined;
  if (!reminder) return;

  if (reminder.recurring) {
    const current = DateTime.fromISO(reminder.remind_at, { zone: config.app.timezone });
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
        db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ?").run(id);
        return;
    }

    db.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run(next.toISO()!, id);
  } else {
    db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ?").run(id);
  }
}

export function cancelReminder(userId: number, id: number): boolean {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  db.prepare("UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND id = ?").run(userId, id);
  return true;
}

export function cancelRemindersForAgendaItem(userId: number, agendaItemId: string): number {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
  if (!table) return 0;
  const result = db.prepare(`
    UPDATE reminders
       SET status = 'cancelled'
     WHERE user_id = ?
       AND agenda_item_id = ?
       AND status = 'active'
  `).run(userId, agendaItemId);
  return Number(result.changes ?? 0);
}

export function updateRemindersForAgendaItem(userId: number, agendaItemId: string, remindAt: string): number {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
  if (!table) return 0;
  const result = db.prepare(`
    UPDATE reminders
       SET remind_at = ?
     WHERE user_id = ?
       AND agenda_item_id = ?
       AND status = 'active'
  `).run(remindAt, userId, agendaItemId);
  return Number(result.changes ?? 0);
}

/**
 * Get today's reminders for a specific user (for briefings).
 */
export function getRemindersForToday(userId: number): Reminder[] {
  const db = getDb();
  ensureReminderAgendaLinkColumn(db);
  const todayDate = now().toFormat('yyyy-MM-dd');
  return db.prepare(`
    SELECT * FROM reminders
    WHERE user_id = ? AND status = 'active'
    AND date(remind_at) = ?
    ORDER BY remind_at ASC
  `).all(userId, todayDate) as Reminder[];
}
