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
import { runContentDiscovery } from './content-discovery';
import { collectMonthlyInvoices, formatCollectionNotification } from './invoice-collector';
import { isInvoiceFilingConfigured } from './invoice-filer';
import { collectAmazonInvoices, formatAmazonNotification, isAmazonConfigured } from './amazon-collector';

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

  // End-of-day task summary at 21:00 — due today recap + overdue
  cron.schedule('0 21 * * *', async () => {
    if (!msTodo.isOutlookTodoConfigured()) return;

    try {
      const pendingResult = await msTodo.getAllPendingTasks();
      if (!pendingResult.success) return;

      const tasks = pendingResult.data;
      const nowDate = new Date();
      const todayStart = new Date(startOfDay()).getTime();
      const todayEnd = new Date(endOfDay()).getTime();

      const dueToday = tasks.filter((t) => {
        if (!t.dueDateTime) return false;
        const due = new Date(t.dueDateTime).getTime();
        return due >= todayStart && due <= todayEnd;
      });

      const overdue = tasks.filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);

      if (dueToday.length === 0 && overdue.length === 0) return;

      let msg = `🌙 <b>End-of-Day Task Summary</b>\n\n`;

      if (dueToday.length > 0) {
        msg += `📅 <b>Due today (${dueToday.length}):</b>\n`;
        for (const t of dueToday) {
          msg += `• ${t.title} <i>[${t.listName}]</i>\n`;
        }
        msg += '\n';
      }

      if (overdue.length > 0) {
        msg += `⚠️ <b>Overdue (${overdue.length}):</b>\n`;
        for (const t of overdue) {
          const daysLate = Math.ceil((nowDate.getTime() - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
          msg += `• ${t.title} — ${daysLate}d late <i>[${t.listName}]</i>\n`;
        }
      }

      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, msg.trim(), { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send end-of-day summary');
        }
      }
    } catch (err) {
      logger.error({ err }, 'End-of-day task summary failed');
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

  // Shared list task notifications — every 5 min during day, every 15 min overnight (22:00-07:00)
  // First run: seed known IDs (no notifications). Subsequent runs: notify on new tasks.
  cron.schedule('*/5 * * * *', async () => {
    if (!msTodo.isOutlookTodoConfigured()) return;

    // Reduce polling overnight: skip non-15-minute marks between 22:00-07:00
    const currentHour = new Date().getHours();
    const currentMinute = new Date().getMinutes();
    if ((currentHour >= 22 || currentHour < 7) && currentMinute % 15 !== 0) return;

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

  // Daily content discovery at 16:43 (runs ~2min, delivers by 16:45)
  cron.schedule('43 16 * * *', async () => {
    try {
      const result = await runContentDiscovery();

      let msg = `🎬 <b>Daily Content Ideas Ready</b>\n\n`;
      if (result.ideas.length > 0) {
        for (let i = 0; i < result.ideas.length; i++) {
          msg += `${i + 1}. ${result.ideas[i]}\n`;
        }
      } else {
        msg += `Ideas generated but couldn't parse titles — check the file.\n`;
      }
      msg += `\n📁 <code>${result.filePath}</code>`;
      msg += `\n🔍 ${result.searchCount} web searches used`;

      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send content discovery notification');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Daily content discovery failed');
      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, '⚠️ Daily content discovery failed. Check logs.', { parse_mode: 'HTML' });
        } catch (sendErr) {
          logger.error({ err: sendErr, userId }, 'Failed to send content discovery failure alert');
        }
      }
    }
  }, { timezone: config.app.timezone });

  // Monthly invoice collection — 1st of each month at 09:00
  // Collects previous month's email invoices from configured vendors
  cron.schedule('0 9 1 * *', async () => {
    if (!config.invoices.monthlyCollectionEnabled || !isInvoiceFilingConfigured()) return;

    try {
      const prev = now().minus({ months: 1 });
      const result = await collectMonthlyInvoices(prev.year, prev.month);
      const notification = formatCollectionNotification(result);

      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, notification, { parse_mode: 'Markdown' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send invoice collection notification');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Monthly invoice collection failed');
      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, '⚠️ Recolha mensal de faturas falhou. Verificar logs.');
        } catch (sendErr) {
          logger.error({ err: sendErr, userId }, 'Failed to send invoice collection failure alert');
        }
      }
    }
  }, { timezone: config.app.timezone });

  // Monthly Amazon.es invoice collection — 1st of each month at 09:15
  // Runs 15 min after email vendor collection. No interactive 2FA in cron mode.
  cron.schedule('15 9 1 * *', async () => {
    if (!config.invoices.amazonEnabled || !isAmazonConfigured() || !isInvoiceFilingConfigured()) return;

    try {
      const prev = now().minus({ months: 1 });

      // Cron mode: no Telegram callbacks for 2FA
      const result = await collectAmazonInvoices(prev.year, prev.month);

      let notification: string;
      if (result.twoFactorRequired && result.totalFiled === 0) {
        // Session expired + couldn't complete 2FA automatically
        notification = formatAmazonNotification(result);
      } else {
        notification = formatAmazonNotification(result);
      }

      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, notification, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send Amazon collection notification');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Monthly Amazon invoice collection failed');
      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, '⚠️ Recolha mensal Amazon falhou. Verificar logs.');
        } catch (sendErr) {
          logger.error({ err: sendErr, userId }, 'Failed to send Amazon collection failure alert');
        }
      }
    }
  }, { timezone: config.app.timezone });

  // Proactive conflict detection — check tomorrow's calendar at 19:30 for overlapping events
  cron.schedule('30 19 * * *', async () => {
    if (!isAnyCalendarConfigured()) return;

    try {
      const tomorrow = now().plus({ days: 1 });
      const events = await getEvents(
        tomorrow.startOf('day').toISO()!,
        tomorrow.endOf('day').toISO()!
      );

      if (events.length < 2) return;

      // Sort by start time and check for overlaps
      const sorted = [...events].sort((a, b) =>
        new Date(a.start).getTime() - new Date(b.start).getTime()
      );

      const conflicts: { a: typeof sorted[0]; b: typeof sorted[0] }[] = [];
      for (let i = 0; i < sorted.length - 1; i++) {
        const endA = new Date(sorted[i].end).getTime();
        const startB = new Date(sorted[i + 1].start).getTime();
        if (endA > startB) {
          conflicts.push({ a: sorted[i], b: sorted[i + 1] });
        }
      }

      if (conflicts.length === 0) return;

      let msg = `⚠️ <b>Calendar Conflicts Tomorrow</b> (${tomorrow.toFormat('cccc, LLL dd')})\n\n`;
      for (const { a, b } of conflicts) {
        msg += `🔴 <b>${a.summary}</b> (${formatTime(a.start)}-${formatTime(a.end)})\n`;
        msg += `   overlaps with <b>${b.summary}</b> (${formatTime(b.start)}-${formatTime(b.end)})\n\n`;
      }
      msg += 'Consider rescheduling one of these events.';

      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, msg.trim(), { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send conflict alert');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Conflict detection failed');
    }
  }, { timezone: config.app.timezone });

  logger.info(
    `Scheduler started: reminders (every min), daily briefing (${config.todo.digestTime}), end-of-day summary (21:00), weekly review (Fri 17:00), shared list check (every 5 min), content discovery (16:43), invoice collection (1st 09:00), Amazon collection (1st 09:15), conflict detection (19:30)`
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

        // Overdue — capped at 20 to avoid exceeding Telegram's 4096 char limit
        const MAX_OVERDUE_DISPLAY = 20;
        const allOverdue = tasks
          .filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate)
          .map((t) => {
            const daysLate = Math.ceil((nowDate.getTime() - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
            return { title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance, daysLate };
          })
          .sort((a, b) => a.daysLate - b.daysLate);
        data.overdueTasks = allOverdue.slice(0, MAX_OVERDUE_DISPLAY);
        if (allOverdue.length > MAX_OVERDUE_DISPLAY) {
          data.overdueExtra = allOverdue.length - MAX_OVERDUE_DISPLAY;
        }
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
    } catch (err) {
      logger.warn({ err }, 'Daily briefing: failed to fetch Outlook unread count');
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

  // Fetch all data in parallel
  const [todoData, calendarEvents] = await Promise.all([
    msTodo.isOutlookTodoConfigured()
      ? Promise.all([
          msTodo.getCompletedTasksInRange(startOfWeek(), endOfWeek()),
          msTodo.getAllPendingTasks(),
        ]).catch((err) => { logger.error({ err }, 'Failed to fetch MS Todo data for weekly review'); return null; })
      : Promise.resolve(null),
    isAnyCalendarConfigured()
      ? getEvents(startOfWeek(), endOfWeek()).catch((err) => { logger.warn({ err }, 'Weekly review: failed to fetch calendar events'); return [] as any[]; })
      : Promise.resolve([] as any[]),
  ]);

  if (todoData) {
    const [completedResult, pendingResult] = todoData;
    const completedCount = completedResult.success ? completedResult.data.length : 0;
    msg += `✅ Completed: ${completedCount} tasks\n`;

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
  } else if (msTodo.isOutlookTodoConfigured()) {
    msg += '📋 Tasks: unable to fetch\n';
  }

  if (calendarEvents.length > 0) {
    msg += `\n📅 Meetings this week: ${calendarEvents.length}\n`;
  }

  for (const userId of config.telegram.allowedUserIds) {
    try {
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ err, userId }, 'Failed to send weekly review');
    }
  }
}
