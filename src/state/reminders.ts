import { getDb } from '../services/database';
import { Reminder } from '../domains/types';
import { DateTime } from 'luxon';
import { now } from '../utils/date-parser';
import { config } from '../config';

export function setReminder(data: {
  message: string;
  remind_at: string;
  recurring?: string;
}): Reminder {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO reminders (message, remind_at, recurring) VALUES (?, ?, ?)
  `);
  const result = stmt.run(data.message, data.remind_at, data.recurring || null);
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(result.lastInsertRowid) as Reminder;
}

export function getActiveReminders(): Reminder[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM reminders WHERE status = 'active' ORDER BY remind_at ASC
  `).all() as Reminder[];
}

export function getDueReminders(): Reminder[] {
  const db = getDb();
  // Compare in JS using Luxon (timezone-aware) instead of SQLite's datetime('now') which is always UTC
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
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | undefined;
  if (!reminder) return;

  if (reminder.recurring) {
    // Use Luxon for DST-safe date arithmetic (naive Date.setDate drifts across DST transitions)
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
        // For cron or unknown, just mark as fired
        db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ?").run(id);
        return;
    }

    db.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run(next.toISO()!, id);
  } else {
    db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ?").run(id);
  }
}

export function cancelReminder(id: number): boolean {
  const db = getDb();
  db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(id);
  return true;
}

export function getRemindersForToday(): Reminder[] {
  const db = getDb();
  // Use Luxon for timezone-aware "today" comparison instead of SQLite's date('now') (UTC)
  const todayDate = now().toFormat('yyyy-MM-dd');
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'active'
    AND date(remind_at) = ?
    ORDER BY remind_at ASC
  `).all(todayDate) as Reminder[];
}
