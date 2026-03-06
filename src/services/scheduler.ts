import cron from 'node-cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDueReminders, markReminderFired, getRemindersForToday } from '../state/reminders';
import * as msTodo from './microsoft-todo';
import { getEvents, isAnyCalendarConfigured } from './unified-calendar';
import { isOutlookMailConfigured, getUnreadCount } from './outlook-mail';
import { formatDailyBriefing, DailyBriefingData } from '../utils/telegram-formatter';
import { now, startOfDay, endOfDay, startOfWeek, endOfWeek, formatTime, formatDateTime } from '../utils/date-parser';

// Track known shared list task IDs — seeded on first run, new IDs trigger notifications
const knownSharedTaskIds = new Set<string>();
let sharedListSeeded = false; // first run seeds without notifying

export function startScheduler(bot: Bot): void {
  // Check reminders every minute
  cron.schedule('* * * * *', async () => {
    try {
      const dueReminders = getDueReminders();
      for (const reminder of dueReminders) {
        for (const userId of config.telegram.allowedUserIds) {
          try {
            let msg = `⏰ <b>Reminder:</b> ${reminder.message}`;
            if (reminder.recurring) msg += `\n<i>(Recurring: ${reminder.recurring})</i>`;
            await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
          } catch (err) {
            logger.error({ err, userId }, 'Failed to send reminder');
          }
        }
        markReminderFired(reminder.id);
      }
    } catch (err) {
      logger.error({ err }, 'Reminder check failed');
    }
  });

  // Proactive task reminders — check every 15 minutes for tasks due within 1 hour
  cron.schedule('*/15 * * * *', async () => {
    if (!msTodo.isOutlookTodoConfigured()) return;

    try {
      const result = await msTodo.getTasksDueSoon(1); // due within 1 hour
      if (!result.success || result.data.length === 0) return;

      for (const task of result.data) {
        const msg = `⏰ <b>Task due soon:</b> ${task.title}\n📋 List: ${task.listName}\n📅 Due: ${formatDateTime(task.dueDateTime!)}`;
        for (const userId of config.telegram.allowedUserIds) {
          try {
            await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
          } catch (err) {
            logger.error({ err, userId }, 'Failed to send task reminder');
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Task reminder check failed');
    }
  }, { timezone: config.app.timezone });

  // Daily briefing at configurable time (default: 08:00 Lisbon time)
  const [digestHour, digestMinute] = config.todo.digestTime.split(':').map(Number);
  const dailyCron = `${digestMinute || 0} ${digestHour || 8} * * *`;

  cron.schedule(dailyCron, async () => {
    if (!config.todo.digestEnabled) return;

    try {
      await sendDailyBriefing(bot);
    } catch (err) {
      logger.error({ err }, 'Daily briefing failed');
    }
  }, { timezone: config.app.timezone });

  // Weekly review on Friday at 17:00
  cron.schedule('0 17 * * 5', async () => {
    try {
      await sendWeeklyReview(bot);
    } catch (err) {
      logger.error({ err }, 'Weekly review failed');
    }
  }, { timezone: config.app.timezone });

  // Shared list task notifications — every 5 minutes
  // First run: seed known IDs (no notifications). Subsequent runs: notify on new tasks.
  cron.schedule('*/5 * * * *', async () => {
    if (!msTodo.isOutlookTodoConfigured()) return;

    try {
      const result = await msTodo.getSharedListPendingTasks();
      if (!result.success) return;

      const currentIds = new Set(result.data.map((t) => t.id));

      // First run after startup: learn existing tasks, don't notify
      if (!sharedListSeeded) {
        for (const id of currentIds) knownSharedTaskIds.add(id);
        sharedListSeeded = true;
        logger.info({ seededCount: currentIds.size }, 'Shared list checker seeded');
        return;
      }

      // Find genuinely new tasks (not known, not self-created)
      const newTasks = result.data.filter((t) => {
        if (knownSharedTaskIds.has(t.id)) return false;
        if (msTodo.isSelfCreatedTask(t.id)) return false;
        return true;
      });

      // Add all current IDs to known set (including self-created)
      for (const id of currentIds) knownSharedTaskIds.add(id);

      // Also remove IDs no longer present (completed/deleted) to keep Set bounded
      for (const id of knownSharedTaskIds) {
        if (!currentIds.has(id)) knownSharedTaskIds.delete(id);
      }

      if (newTasks.length === 0) return;

      let msg = `👥 <b>New tasks from others</b>\n\n`;
      for (const t of newTasks.slice(0, 10)) {
        msg += `• ${t.title} <i>[${t.listName}]</i>\n`;
      }
      if (newTasks.length > 10) msg += `\n... and ${newTasks.length - 10} more`;

      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send shared list notification');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Shared list task check failed');
    }
  }, { timezone: config.app.timezone });

  // Clear self-created task cache daily at midnight
  cron.schedule('0 0 * * *', () => {
    msTodo.clearSelfCreatedTasks();
    logger.info('Cleared self-created task cache');
  }, { timezone: config.app.timezone });

  logger.info(
    `Scheduler started: reminders (every min), task alerts (every 15 min), daily briefing (${config.todo.digestTime}), weekly review (Fri 17:00), shared list check (every 5 min)`
  );
}

async function sendDailyBriefing(bot: Bot): Promise<void> {
  const today = now();
  const data: DailyBriefingData = {
    date: today.toFormat('cccc, LLLL dd'),
    events: [],
    pendingTodos: 0,
    highPriorityTasks: [],
    dueTodayTasks: [],
    overdueTasks: [],
    reminders: [],
    unreadEmails: 0,
    yesterdayCompleted: 0,
  };

  // Calendar events — full details
  if (isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfDay(), endOfDay());
      data.events = events.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
      }));
      // Check for training events
      const training = events.find((e) =>
        /gym|train|run|bike|cycling|workout|strength/i.test(e.summary)
      );
      if (training) {
        data.training = `${training.summary} at ${formatTime(training.start)}`;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch events for briefing');
    }
  }

  // Microsoft To Do tasks — fetch ONCE, derive all views
  if (msTodo.isOutlookTodoConfigured()) {
    try {
      const [pendingResult, yesterdayResult] = await Promise.all([
        msTodo.getAllPendingTasks(),
        msTodo.getCompletedTasksInRange(
          startOfDay(now().minus({ days: 1 })),
          endOfDay(now().minus({ days: 1 }))
        ),
      ]);

      if (pendingResult.success) {
        const tasks = pendingResult.data;
        data.pendingTodos = tasks.length;

        const nowDate = new Date();
        const todayStart = new Date(startOfDay()).getTime();
        const todayEnd = new Date(endOfDay()).getTime();

        // High priority
        data.highPriorityTasks = tasks
          .filter((t) => t.importance === 'high')
          .map((t) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

        // Due today
        data.dueTodayTasks = tasks
          .filter((t) => {
            if (!t.dueDateTime) return false;
            const due = new Date(t.dueDateTime).getTime();
            return due >= todayStart && due <= todayEnd;
          })
          .map((t) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

        // Overdue (all — no cap!)
        data.overdueTasks = tasks
          .filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate)
          .map((t) => {
            const daysLate = Math.ceil((nowDate.getTime() - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
            return { title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance, daysLate };
          })
          .sort((a, b) => a.daysLate - b.daysLate);
      }

      if (yesterdayResult.success) {
        data.yesterdayCompleted = yesterdayResult.data.length;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch MS Todo tasks for briefing');
    }
  }

  // Reminders — with details
  const reminders = getRemindersForToday();
  data.reminders = reminders.map((r) => ({
    message: r.message,
    time: formatTime(r.remind_at),
  }));

  // Unread emails
  if (isOutlookMailConfigured()) {
    try {
      data.unreadEmails = await getUnreadCount();
    } catch {
      // skip
    }
  }

  const msg = formatDailyBriefing(data);

  for (const userId of config.telegram.allowedUserIds) {
    try {
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ err, userId }, 'Failed to send daily briefing');
    }
  }
}

async function sendWeeklyReview(bot: Bot): Promise<void> {
  let msg = `<b>📊 Week in Review</b>\n`;
  msg += `${now().startOf('week').toFormat('LLL dd')} - ${now().endOf('week').toFormat('LLL dd yyyy')}\n\n`;

  // Microsoft To Do stats
  if (msTodo.isOutlookTodoConfigured()) {
    try {
      // Completed this week
      const completedResult = await msTodo.getCompletedTasksInRange(startOfWeek(), endOfWeek());
      const completedCount = completedResult.success ? completedResult.data.length : 0;
      msg += `✅ Completed: ${completedCount} tasks\n`;

      // Pending
      const pendingResult = await msTodo.getAllPendingTasks();
      if (pendingResult.success) {
        msg += `📋 Still pending: ${pendingResult.data.length} tasks\n`;

        const nowDate = new Date();
        const overdue = pendingResult.data.filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);
        if (overdue.length > 0) {
          msg += `\n⚠️ Overdue tasks (${overdue.length}):\n`;
          for (const t of overdue) {
            msg += `- ${t.title}`;
            if (t.dueDateTime) msg += ` (was due: ${formatDateTime(t.dueDateTime)})`;
            msg += '\n';
          }
          msg += '\nWant to reschedule or drop these?';
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch MS Todo data for weekly review');
      msg += '📋 Tasks: unable to fetch\n';
    }
  }

  if (isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfWeek(), endOfWeek());
      msg += `\n📅 Meetings this week: ${events.length}\n`;
    } catch {
      // skip
    }
  }

  for (const userId of config.telegram.allowedUserIds) {
    try {
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ err, userId }, 'Failed to send weekly review');
    }
  }
}
