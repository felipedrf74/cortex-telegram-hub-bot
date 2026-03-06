import { getDb } from '../services/database';
import { Reminder } from '../domains/types';

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
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'active'
    AND remind_at <= datetime('now')
    ORDER BY remind_at ASC
  `).all() as Reminder[];
}

export function markReminderFired(id: number): void {
  const db = getDb();
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | undefined;
  if (!reminder) return;

  if (reminder.recurring) {
    // For recurring reminders, update the next fire time
    let nextTime: string;
    const current = new Date(reminder.remind_at);

    switch (reminder.recurring) {
      case 'daily':
        current.setDate(current.getDate() + 1);
        break;
      case 'weekly':
        current.setDate(current.getDate() + 7);
        break;
      case 'monthly':
        current.setMonth(current.getMonth() + 1);
        break;
      default:
        // For cron or unknown, just mark as fired
        db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ?").run(id);
        return;
    }

    nextTime = current.toISOString();
    db.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run(nextTime, id);
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
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'active'
    AND date(remind_at) = date('now')
    ORDER BY remind_at ASC
  `).all() as Reminder[];
}
