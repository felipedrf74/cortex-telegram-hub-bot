// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import path from 'path';
import cron from 'node-cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDueReminders, markReminderFired, getRemindersForToday } from '../state/reminders';
import * as msTodo from './microsoft-todo';
import { getEvents, isAnyCalendarConfigured } from './unified-calendar';
import { isOutlookMailConfigured, getUnreadCount, sendEmail } from './outlook-mail';
import { formatDailyBriefing, DailyBriefingData, escapeHtml, splitMessage } from '../utils/telegram-formatter';
import { now, startOfDay, endOfDay, startOfWeek, endOfWeek, formatTime, formatDateTime } from '../utils/date-parser';
// content-discovery.ts still exists for manual /discover but removed from scheduler
import { collectMonthlyInvoices, formatCollectionNotification } from './invoice-collector';
import { isInvoiceFilingConfigured } from './invoice-filer';
import { collectAmazonInvoices, formatAmazonNotification, isAmazonConfigured } from './amazon-collector';
import { collectUberInvoices, formatUberNotification, isUberConfigured } from './uber-collector';
import { generateCoachBriefing } from './garmin-coach';
import { isGarminConfigured, keepAlive as garminKeepAlive, ensureAuthenticated as garminEnsureAuth } from './garmin';
import { registerJob, wrapJob, recordGarminRefresh, setJobFailureNotifier, setJobEnabledChecker, getJobMap, seedJobLastRunFromHistory } from '../portal/telemetry';
import { isCronJobEnabled } from '../skills/skill-manager';
import { CronExpressionParser } from 'cron-parser';
import { flushQueue, getPendingCount } from './invoice-queue';
import { setLastCoachState } from '../domains/domain-handler';
import { setLastActiveDomain } from '../bot';
import { addToConversation } from '../state/conversation';
import { processAllChannels, seedDefaultChannels } from './channel-learner';
import { sendTopicCandidates, sendWeeklyPackage } from './content-workflow';
import { runPipelineAgent } from '../agents/pipeline-agent';
import { runSEOAgent, seedKeywordsIfEmpty } from '../agents/seo-agent';
import { runReactionRadar } from '../agents/reaction-radar-agent';
import { runPerformanceAgent } from '../agents/performance-agent';
import { runVoiceEvolutionAgent } from '../agents/voice-evolution-agent';
import { expireStaleSignals } from './intelligence-bus';
import { seedBooksIfEmpty } from '../commands/books';
import { runAutoresearch, getScheduledTarget } from './autoresearch';
import { runDatabaseBackup, weeklyRestoreTest } from './backup';
import { getDb } from './database';

/**
 * Get all active user Telegram IDs from the database.
 * Falls back to config.telegram.allowedUserIds if users table doesn't exist yet.
 */
function getActiveUserIds(): number[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT telegram_id FROM users WHERE status = 'active'"
    ).all() as { telegram_id: number }[];
    if (rows.length > 0) return rows.map(r => r.telegram_id);
  } catch { /* users table might not exist yet */ }
  return config.telegram.allowedUserIds;
}

/**
 * Get only owner-tier user IDs (for admin-only notifications).
 */
function getOwnerUserIds(): number[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT telegram_id FROM users WHERE tier = 'owner' AND status = 'active'"
    ).all() as { telegram_id: number }[];
    if (rows.length > 0) return rows.map(r => r.telegram_id);
  } catch { /* users table might not exist yet */ }
  return config.telegram.allowedUserIds;
}

export { getActiveUserIds, getOwnerUserIds };

// Track known shared list task IDs — seeded on first run, new IDs trigger notifications
const knownSharedTaskIds = new Set<string>();
let sharedListSeeded = false; // first run seeds without notifying

// Track automated notifications for the morning briefing (cleared daily at midnight)
const todayNotifications: string[] = [];
export function getTodayNotifications(): string[] { return todayNotifications; }

export function startScheduler(bot: Bot): void {
  // Register sub-skill gating so disabled sub-skills skip their cron jobs
  setJobEnabledChecker(isCronJobEnabled);

  // Register failure notifier so wrapJob sends Telegram alerts on job failures
  setJobFailureNotifier(async (jobLabel, errorMessage) => {
    const short = errorMessage.slice(0, 120);
    for (const userId of getOwnerUserIds()) {
      try {
        await bot.api.sendMessage(userId,
          `⚠️ <b>${escapeHtml(jobLabel)} failed</b>\n\n<code>${escapeHtml(short)}</code>\n\n<i>Check logs for details.</i>`,
          { parse_mode: 'HTML' });
      } catch {
        // swallow — avoid cascading failures
      }
    }
  });

  const tz = config.app.timezone;
  const dailyCron = (() => {
    const [h, m] = config.todo.digestTime.split(':').map(Number);
    return `${m ?? 0} ${h ?? 8} * * *`;
  })();
  const coachCron = (() => {
    const [h, m] = config.garmin.coachTime.split(':').map(Number);
    return `${m ?? 0} ${h ?? 21} * * *`;
  })();
  const backupCron = (() => {
    const [h, m] = config.backup.time.split(':').map(Number);
    return `${m ?? 0} ${h ?? 3} * * *`;
  })();

  // ── Register all jobs for portal tracking ──────────────────────────
  registerJob('reminders',          'Reminders',             '* * * * *',       'secretary');
  registerJob('end_of_day',         'End-of-Day Summary',    '0 21 * * *',      'secretary');
  registerJob('daily_briefing',     'Morning Briefing',      dailyCron,         'secretary');
  registerJob('weekly_review',      'Weekly Review',         '0 17 * * 5',      'secretary');
  registerJob('shared_list',        'Shared List Check',     '*/5 * * * *',     'secretary');
  registerJob('midnight_cleanup',   'Midnight Cleanup',      '0 0 * * *',       'system');
  // content_discovery removed — replaced by content-workflow (tue/thu/fri topic candidates)
  registerJob('invoice_collection', 'Invoice Collection',    '0 9 1 * *',       'invoices');
  registerJob('amazon_collection',  'Amazon Collection',     '15 9 1 * *',      'invoices');
  registerJob('uber_collection',    'Uber Collection',       '30 9 1 * *',      'invoices');
  registerJob('fossa_email',        'Fossa Email',           '30 7 * * 1',      'secretary');
  registerJob('conflict_detection', 'Conflict Detection',    '30 19 * * *',     'secretary');
  registerJob('garmin_keepalive',   'Garmin Keep-Alive',     '*/30 * * * *',    'triathlon');
  registerJob('garmin_coach',       'Garmin Coach',          coachCron,         'triathlon');
  registerJob('invoice_queue',      'Invoice Queue Flush',   '*/15 * * * *',    'invoices');
  registerJob('channel_relearn',   'Channel Re-Learn',      '0 3 * * 0',       'content');
  registerJob('tuesday_reels',     'Tuesday Reel Topics',   '0 9 * * 2',       'content');
  registerJob('thursday_youtube',  'Thursday YT Topic',     '0 9 * * 4',       'content');
  registerJob('friday_weekly',     'Friday Weekly Package',  '30 18 * * 5',     'content');
  registerJob('pipeline_agent',   'Pipeline Tracker',       '0 20 * * *',      'content');
  registerJob('performance_agent','Performance Intel',        '0 6 * * 0',       'content');
  registerJob('voice_evolution', 'Voice Evolution',          '0 4 1 * *',       'content');
  registerJob('reaction_radar',   'Reaction Radar',          '0 8,14,20 * * *', 'content');
  registerJob('seo_agent',        'SEO Tracking',           '0 6 * * 1',       'content');
  registerJob('expire_signals',   'Signal Cleanup',         '0 * * * *',       'content');
  registerJob('training_plan_adjust', 'Training Plan Auto-Adjust', '0 19 * * 0', 'triathlon');
  registerJob('autoresearch',     'Autoresearch',           '0 1 * * 0',       'system');
  registerJob('db_backup',        'Database Backup',        backupCron,        'system');
  registerJob('db_restore_test', 'Weekly Restore Test',   '0 4 * * 0',       'system');

  // Seed lastRunAt from DB so the DST watchdog doesn't re-fire jobs after a restart
  seedJobLastRunFromHistory();

  // ── Reminder checker (every minute) ────────────────────────────────
  cron.schedule('* * * * *', wrapJob('reminders', async () => {
    const dueReminders = getDueReminders();
    for (const reminder of dueReminders) {
      const targetUserId = (reminder as any).user_id as number;
      try {
        let msg = `⏰ <b>Reminder:</b> ${escapeHtml(reminder.message)}`;
        if (reminder.recurring) msg += `\n<i>(Recurring: ${reminder.recurring})</i>`;
        await bot.api.sendMessage(targetUserId, msg, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId: targetUserId }, 'Failed to send reminder');
      }
      markReminderFired(reminder.id);
    }
  }));

  // ── End-of-day task summary (21:00) ────────────────────────────────
  cron.schedule('0 21 * * *', wrapJob('end_of_day', async () => {
    if (!msTodo.isOutlookTodoConfigured()) return;

    const pendingResult = await msTodo.getAllPendingTasks();
    if (!pendingResult.success) return;

    const tasks = pendingResult.data;
    const todayStart = new Date(startOfDay()).getTime();
    const todayEnd = new Date(endOfDay()).getTime();

    const dueToday = tasks.filter((t) => {
      if (!t.dueDateTime) return false;
      const due = new Date(t.dueDateTime).getTime();
      return due >= todayStart && due <= todayEnd;
    });

    const overdue = tasks.filter((t) => t.dueDateTime && new Date(t.dueDateTime).getTime() < todayStart);

    if (dueToday.length === 0 && overdue.length === 0) return;

    let msg = `🌙 <b>End-of-Day Task Summary</b>\n\n`;

    if (dueToday.length > 0) {
      msg += `📅 <b>Due today (${dueToday.length}):</b>\n`;
      for (const t of dueToday) {
        msg += `• ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
      }
      msg += '\n';
    }

    if (overdue.length > 0) {
      msg += `⚠️ <b>Overdue (${overdue.length}):</b>\n`;
      for (const t of overdue) {
        const daysLate = Math.ceil((todayStart - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
        msg += `• ${escapeHtml(t.title)} — ${daysLate}d late <i>[${escapeHtml(t.listName)}]</i>\n`;
      }
    }

    for (const userId of getActiveUserIds()) {
      try {
        await bot.api.sendMessage(userId, msg.trim(), { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send end-of-day summary');
      }
    }
  }), { timezone: tz });

  // ── Daily briefing (configurable time) ─────────────────────────────
  cron.schedule(dailyCron, wrapJob('daily_briefing', async () => {
    if (!config.todo.digestEnabled) return;
    await sendDailyBriefing(bot);
  }), { timezone: tz });

  // ── Weekly review (Friday 17:00) ───────────────────────────────────
  cron.schedule('0 17 * * 5', wrapJob('weekly_review', async () => {
    await sendWeeklyReview(bot);
  }), { timezone: tz });

  // ── Shared list task notifications (every 5 min) ───────────────────
  cron.schedule('*/5 * * * *', wrapJob('shared_list', async () => {
    if (!msTodo.isOutlookTodoConfigured()) return;

    const { hour: currentHour, minute: currentMinute } = now();
    if ((currentHour >= 22 || currentHour < 7) && currentMinute % 15 !== 0) return;

    const result = await msTodo.getSharedListPendingTasks();
    if (!result.success) return;

    const currentIds = new Set(result.data.map((t) => t.id));

    if (!sharedListSeeded) {
      for (const id of currentIds) knownSharedTaskIds.add(id);
      sharedListSeeded = true;
      logger.info({ seededCount: currentIds.size }, 'Shared list checker seeded');
      return;
    }

    const newTasks = result.data.filter((t) => {
      if (knownSharedTaskIds.has(t.id)) return false;
      if (msTodo.isSelfCreatedTask(t.id)) return false;
      return true;
    });

    for (const id of currentIds) knownSharedTaskIds.add(id);
    for (const id of knownSharedTaskIds) {
      if (!currentIds.has(id)) knownSharedTaskIds.delete(id);
    }

    if (newTasks.length === 0) return;

    // Categorize: due today vs other new tasks
    const todayStr = new Date().toISOString().slice(0, 10);
    const dueToday = newTasks.filter((t) => t.dueDateTime && t.dueDateTime.slice(0, 10) === todayStr);
    const otherNew = newTasks.filter((t) => !t.dueDateTime || t.dueDateTime.slice(0, 10) !== todayStr);

    let msg = '';

    if (dueToday.length > 0) {
      msg += `📋 <b>Due today</b> (shared)\n`;
      for (const t of dueToday) {
        msg += `  ▸ ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
      }
    }

    if (otherNew.length > 0) {
      if (msg) msg += '\n';
      msg += `🆕 <b>New tasks assigned</b>\n`;
      for (const t of otherNew.slice(0, 8)) {
        const due = t.dueDateTime ? ` 📅 ${t.dueDateTime.slice(0, 10)}` : '';
        msg += `  ▸ ${escapeHtml(t.title)}${due} <i>[${escapeHtml(t.listName)}]</i>\n`;
      }
      if (otherNew.length > 8) msg += `  ... +${otherNew.length - 8} more\n`;
    }

    for (const userId of getActiveUserIds()) {
      try {
        await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send shared list notification');
      }
    }
  }), { timezone: tz });

  // ── Midnight cleanup ───────────────────────────────────────────────
  cron.schedule('0 0 * * *', wrapJob('midnight_cleanup', async () => {
    msTodo.clearSelfCreatedTasks();
    todayNotifications.length = 0;
    logger.info('Cleared self-created task cache and daily notifications');
  }), { timezone: tz });

  // Old content_discovery (16:43) removed — replaced by content-workflow (Tue/Thu/Fri)

  // ── Monthly invoice collection (1st at 09:00) ─────────────────────
  cron.schedule('0 9 1 * *', wrapJob('invoice_collection', async () => {
    if (!config.invoices.monthlyCollectionEnabled || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const result = await collectMonthlyInvoices(prev.year, prev.month);
    const notification = formatCollectionNotification(result);

    for (const userId of getOwnerUserIds()) {
      try {
        await bot.api.sendMessage(userId, notification, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send invoice collection notification');
      }
    }
  }), { timezone: tz });

  // ── Amazon collection (1st at 09:15) ──────────────────────────────
  cron.schedule('15 9 1 * *', wrapJob('amazon_collection', async () => {
    if (!config.invoices.amazonEnabled || !isAmazonConfigured() || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const result = await collectAmazonInvoices(prev.year, prev.month);
    const notification = formatAmazonNotification(result);

    for (const userId of getOwnerUserIds()) {
      try {
        await bot.api.sendMessage(userId, notification, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send Amazon collection notification');
      }
    }
  }), { timezone: tz });

  // ── Uber collection (1st at 09:30) ────────────────────────────────
  cron.schedule('30 9 1 * *', wrapJob('uber_collection', async () => {
    if (!config.invoices.uberEnabled || !isUberConfigured() || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const result = await collectUberInvoices(prev.year, prev.month);
    const notification = formatUberNotification(result);

    for (const userId of getOwnerUserIds()) {
      try {
        await bot.api.sendMessage(userId, notification, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send Uber collection notification');
      }
    }
  }), { timezone: tz });

  // ── Bi-weekly fossa email (Monday 07:30) ───────────────────────────
  const fossaTo = process.env.FOSSA_EMAIL_TO || 'smas.fossas@mun-montijo.pt';
  if (isOutlookMailConfigured()) {
    cron.schedule('30 7 * * 1', wrapJob('fossa_email', async () => {
      const today = now();
      const refDate = today.set({ year: 2026, month: 3, day: 23, hour: 0, minute: 0, second: 0, millisecond: 0 });
      const daysDiff = Math.round(today.diff(refDate, 'days').days);
      const weeksDiff = Math.floor(daysDiff / 7);
      if (weeksDiff % 2 !== 0) {
        logger.info({ weeksDiff }, 'Fossa email: skipping — not a send week');
        return;
      }

      await sendEmail({
        to: fossaTo,
        subject: 'Limpeza Fossa Septica',
        body: `Exmos. Senhores,\nVenho por este meio solicitar a limpeza da fossa séptica do seguinte imóvel:\n\nMorada: Rua José Quendera Miranda L4, 2870-684 Alto-Estanqueiro/Jardia\nNome: Felipe Dominguez Rodriguez Ferreira\nNúmero de Cliente: 3895417\nTelefone: 912 874 680\n\nAgradeço, por favor, que me informem sobre a disponibilidade para a realização do serviço.\n\nCom os melhores cumprimentos,\nFelipe Dominguez`,
        source: 'fossa_email',
      });

      todayNotifications.push(`📧 Email automático "Limpeza Fossa Séptica" enviado para ${fossaTo}`);
      logger.info({ to: fossaTo }, 'Fossa email sent successfully');

      for (const userId of getOwnerUserIds()) {
        try {
          await bot.api.sendMessage(userId,
            `📧 <b>Email automático enviado</b>\n\n<b>Para:</b> ${fossaTo}\n<b>Assunto:</b> Limpeza Fossa Septica\n\n<i>Próximo envio em 2 semanas.</i>`,
            { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send fossa email notification');
        }
      }
    }), { timezone: tz });
  }

  // ── Conflict detection (19:30) ─────────────────────────────────────
  cron.schedule('30 19 * * *', wrapJob('conflict_detection', async () => {
    if (!isAnyCalendarConfigured()) return;

    const tomorrow = now().plus({ days: 1 });
    const events = await getEvents(
      tomorrow.startOf('day').toISO()!,
      tomorrow.endOf('day').toISO()!
    );

    if (events.length < 2) return;

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
      msg += `🔴 <b>${escapeHtml(a.summary)}</b> (${formatTime(a.start)}-${formatTime(a.end)})\n`;
      msg += `   overlaps with <b>${escapeHtml(b.summary)}</b> (${formatTime(b.start)}-${formatTime(b.end)})\n\n`;
    }
    msg += 'Consider rescheduling one of these events.';

    for (const userId of getActiveUserIds()) {
      try {
        await bot.api.sendMessage(userId, msg.trim(), { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send conflict alert');
      }
    }
  }), { timezone: tz });

  // ── Garmin keep-alive (every 30 min) ───────────────────────────────
  if (isGarminConfigured()) {
    cron.schedule('5,35 * * * *', wrapJob('garmin_keepalive', async () => {
      const ok = await garminKeepAlive();
      recordGarminRefresh(ok);
      if (!ok) {
        throw new Error('All refresh attempts failed — session may be dead');
      }
    }), { timezone: tz });
  }

  // ── Garmin coach briefing (configurable time) ──────────────────────
  if (config.garmin.coachEnabled && isGarminConfigured()) {
    cron.schedule(coachCron, wrapJob('garmin_coach', async () => {
      logger.info('Daily coach briefing starting — pre-authenticating Garmin');
      await garminEnsureAuth();
      const result = await generateCoachBriefing();

      if (result.errors.length > 0) {
        logger.warn({ errors: result.errors }, 'Coach briefing completed with data gaps');
      }

      // Store recommendations so triathlon domain can reference them in follow-up chat
      if (result.recommendations.length > 0) {
        for (const userId of getOwnerUserIds()) {
          setLastCoachState(userId, result.recommendations, result.message.substring(0, 500));
        }
      }

      const chunks = splitMessage(result.message);

      // Save coach briefing to triathlon conversation history so follow-up replies have context
      // Uses userId 0 (default/owner) — scheduler doesn't have per-user context yet
      addToConversation(0, 'triathlon', 'assistant', result.message);

      for (const userId of getOwnerUserIds()) {
        // Set conversation continuity to triathlon so follow-up replies stay in context
        setLastActiveDomain(userId, 'triathlon');
        try {
          for (const chunk of chunks) {
            await bot.api.sendMessage(userId, chunk, { parse_mode: 'HTML' });
          }
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send coach briefing');
        }
      }

      logger.info(
        { dataMs: result.dataCollectionMs, analysisMs: result.analysisMs, errors: result.errors.length },
        'Daily coach briefing completed'
      );
    }), { timezone: tz });
  }

  // ── Training Plan weekly auto-adjust (Sunday 19:00) ─────────────────
  cron.schedule('0 19 * * 0', wrapJob('training_plan_adjust', async () => {
    const { getActivePlan, getCurrentWeek, getWeeklyAdherence, computeAdjustmentRecommendation, updateWeekAdjustment, getWeeksForPlan } = require('./training-plans');
    const { calculateReadiness, persistReadinessScore } = require('./readiness-scorer');

    for (const userId of getActiveUserIds()) {
      const plan = getActivePlan(userId);
      if (!plan) continue;

      const currentWeek = getCurrentWeek(plan.id);
      if (!currentWeek) continue;

      const stats = getWeeklyAdherence(plan.id, currentWeek.id);
      if (stats.completedSessions === 0 && stats.skippedSessions === 0) continue; // no data yet

      // Calculate and persist readiness score
      let readinessScore: number | null = null;
      let readinessRec = '';
      try {
        const readiness = await calculateReadiness(userId);
        persistReadinessScore(userId, readiness);
        readinessScore = readiness.score;
        readinessRec = readiness.recommendation;
      } catch (err) {
        logger.warn({ err, userId }, 'Readiness calculation failed — using adherence only');
      }

      const recommendation = computeAdjustmentRecommendation(stats);

      // Factor readiness into adjustment:
      // Low readiness + good adherence = fatigue, not laziness → force deload
      if (readinessScore != null && readinessScore < 50 && stats.adherenceRate > 70) {
        recommendation.adjustIntensity = Math.min(recommendation.adjustIntensity, 70);
        recommendation.reason += ` + Low readiness (${readinessScore}/100): ${readinessRec}`;
      }

      // Find next week and apply adjustment if needed
      const allWeeks = getWeeksForPlan(plan.id);
      const nextWeek = allWeeks.find((w: any) => w.week_number === currentWeek.week_number + 1);

      if (nextWeek && recommendation.adjustIntensity !== 100) {
        updateWeekAdjustment(nextWeek.id, recommendation.adjustIntensity, recommendation.reason);

        const emoji = recommendation.adjustIntensity < 100 ? '📉' : '📈';
        let msg = `${emoji} <b>Training Plan Auto-Adjust</b>\n\n`;
        msg += `<b>${plan.name}</b> — Week ${currentWeek.week_number} review:\n`;
        msg += `• Adherence: ${stats.adherenceRate}%  (${stats.completedSessions}/${stats.totalSessions})\n`;
        if (stats.avgRpe != null) msg += `• Avg RPE: ${stats.avgRpe}\n`;
        if (stats.avgSoreness != null) msg += `• Avg Soreness: ${stats.avgSoreness}/10\n`;
        if (stats.avgEnergy != null) msg += `• Avg Energy: ${stats.avgEnergy}/10\n`;
        if (readinessScore != null) msg += `• Readiness: ${readinessScore}/100 (${readinessRec})\n`;
        msg += `\n<b>Week ${currentWeek.week_number + 1} adjusted:</b> ${recommendation.adjustIntensity}% intensity\n`;
        msg += `<i>Reason: ${recommendation.reason}</i>`;

        try {
          await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send training adjustment notification');
        }
      }
    }
  }), { timezone: tz });

  // ── Invoice queue flush (every 15 min) ──────────────────────────────
  cron.schedule('*/15 * * * *', wrapJob('invoice_queue', async () => {
    const pending = getPendingCount();
    if (pending === 0) return; // nothing to flush — skip silently

    const result = await flushQueue();

    if (result.flushed > 0) {
      // Notify user that queued invoices were filed
      let msg = `📤 <b>Fila de faturas processada!</b>\n\n`;
      msg += `✅ ${result.flushed} fatura${result.flushed > 1 ? 's' : ''} arquivada${result.flushed > 1 ? 's' : ''} com sucesso`;
      if (result.failed > 0) msg += `\n❌ ${result.failed} falharam permanentemente`;
      if (result.remaining > 0) msg += `\n🔄 ${result.remaining} ainda na fila`;
      msg += `\n\n<i>O Mac voltou a estar disponível.</i>`;

      for (const userId of getOwnerUserIds()) {
        try {
          await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send invoice queue flush notification');
        }
      }
    }
  }), { timezone: tz });

  // ── Weekly channel re-analysis (Sunday 03:00) ─────────────────
  cron.schedule('0 3 * * 0', wrapJob('channel_relearn', async () => {
    const result = await processAllChannels();
    if (result.analyzed > 0 || result.failed > 0) {
      const msg = `📚 <b>Weekly Channel Re-Learn</b>\n\n` +
        `✅ ${result.analyzed} analyzed · ❌ ${result.failed} failed · 🧠 ${result.synthesized ? 'Knowledge updated' : 'No changes'}`;
      for (const userId of getOwnerUserIds()) {
        try {
          await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send channel relearn notification');
        }
      }
    }
  }), { timezone: tz });

  // ── Content Workflow: Tuesday Reel Topics (09:00) ──────────────────
  cron.schedule('0 9 * * 2', wrapJob('tuesday_reels', async () => {
    for (const userId of getOwnerUserIds()) {
      try {
        await sendTopicCandidates(bot, userId, 'reel', 'tuesday_reels');
      } catch (err) {
        logger.error({ err, userId }, 'Tuesday reel topics failed');
      }
    }
  }), { timezone: tz });

  // ── Content Workflow: Thursday YT Topic (09:00) ───────────────────
  cron.schedule('0 9 * * 4', wrapJob('thursday_youtube', async () => {
    for (const userId of getOwnerUserIds()) {
      try {
        await sendTopicCandidates(bot, userId, 'youtube', 'thursday_youtube');
      } catch (err) {
        logger.error({ err, userId }, 'Thursday YouTube topics failed');
      }
    }
  }), { timezone: tz });

  // ── Content Workflow: Friday Weekly Package (18:30) ────────────────
  cron.schedule('30 18 * * 5', wrapJob('friday_weekly', async () => {
    for (const userId of getOwnerUserIds()) {
      try {
        await sendWeeklyPackage(bot, userId);
      } catch (err) {
        logger.error({ err, userId }, 'Friday weekly package failed');
      }
    }
  }), { timezone: tz });

  // ── Pipeline Agent (daily 20:00) ───────────────────────────────────
  cron.schedule('0 20 * * *', wrapJob('pipeline_agent', async () => {
    await runPipelineAgent();
  }), { timezone: tz });

  // ── Performance Agent (Sunday 06:00, after channel relearn) ──────
  cron.schedule('0 6 * * 0', wrapJob('performance_agent', async () => {
    await runPerformanceAgent();
  }), { timezone: tz });

  // ── Voice Evolution Agent (1st of month, 04:00) ─────────────────
  cron.schedule('0 4 1 * *', wrapJob('voice_evolution', async () => {
    await runVoiceEvolutionAgent();
  }), { timezone: tz });

  // ── Reaction Radar Agent (every 4 hours) ─────────────────────────
  cron.schedule('0 8,14,20 * * *', wrapJob('reaction_radar', async () => {
    await runReactionRadar();
  }), { timezone: tz });

  // ── SEO Tracking Agent (Monday 06:00) ────────────────────────────
  cron.schedule('0 6 * * 1', wrapJob('seo_agent', async () => {
    await runSEOAgent();
    const msg = '🔍 <b>SEO Agent</b> — weekly keyword rank check complete. Use <code>/seorank</code> to see results.';
    for (const userId of getOwnerUserIds()) {
      try { await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }); } catch {}
    }
  }), { timezone: tz });

  // ── Autoresearch (Sunday 01:00 — rotates through targets) ────────
  cron.schedule('0 1 * * 0', wrapJob('autoresearch', async () => {
    const targetId = getScheduledTarget();
    const onProgress = async (msg: string) => {
      for (const userId of getOwnerUserIds()) {
        try { await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }); } catch {}
      }
    };
    try {
      const result = await runAutoresearch(targetId, 3, false, onProgress);
      const kept = result.rounds.filter(r => r.decision === 'kept').length;
      const summary = `🔬 <b>Autoresearch: ${targetId}</b>\n\n` +
        `Score: <b>${(result.finalScore * 100).toFixed(1)}%</b>\n` +
        `Kept ${kept}/${result.rounds.length} mutations\n` +
        `Duration: ${(result.totalDurationMs / 1000).toFixed(0)}s`;
      for (const userId of getOwnerUserIds()) {
        try { await bot.api.sendMessage(userId, summary, { parse_mode: 'HTML' }); } catch {}
      }
    } catch (err) {
      logger.error({ err, targetId }, 'Scheduled autoresearch failed');
    }
  }), { timezone: tz });

  // ── Database Backup (daily, configurable — default 03:00) ─────────
  if (config.backup.enabled) {
    cron.schedule(backupCron, wrapJob('db_backup', async () => {
      const backupPath = await runDatabaseBackup();
      const short = path.basename(backupPath);
      for (const userId of getOwnerUserIds()) {
        try {
          await bot.api.sendMessage(userId,
            `💾 <b>Database Backup</b>\n\nBackup complete: <code>${escapeHtml(short)}</code>`,
            { parse_mode: 'HTML' });
        } catch {
          // swallow — notification is best-effort
        }
      }
    }), { timezone: tz });

    // ── Weekly Restore Test (Sunday 04:00) ─────────────────────────
    cron.schedule('0 4 * * 0', wrapJob('db_restore_test', async () => {
      const result = await weeklyRestoreTest();
      if (!result.success) {
        logger.error({ details: result.details }, 'Weekly restore test FAILED');
        for (const userId of getOwnerUserIds()) {
          try {
            await bot.api.sendMessage(userId,
              `🚨 <b>Weekly Restore Test FAILED</b>\n\n<code>${escapeHtml(result.details.slice(0, 200))}</code>`,
              { parse_mode: 'HTML' });
          } catch {}
        }
      } else {
        logger.info({ details: result.details }, 'Weekly restore test passed');
      }
    }), { timezone: tz });
  }

  // ── Signal Expiry Cleanup (hourly) ────────────────────────────────
  cron.schedule('0 * * * *', wrapJob('expire_signals', async () => {
    const expired = expireStaleSignals();
    if (expired > 0) logger.info({ expired }, 'Expired stale intelligence bus signals');
  }));

  // Run signal expiry on startup
  expireStaleSignals();

  // Seed SEO keywords (only if table is empty)
  try {
    seedKeywordsIfEmpty();
  } catch (err) {
    logger.warn({ err }, 'Failed to seed SEO keywords');
  }

  // Seed default reference channels (only if table is empty)
  try {
    seedDefaultChannels();
  } catch (err) {
    logger.warn({ err }, 'Failed to seed default content reference channels');
  }

  // Seed book library (only if table is empty)
  try {
    seedBooksIfEmpty(async (msg) => {
      for (const userId of getOwnerUserIds()) {
        try { await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }); } catch {}
      }
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to seed book library');
  }

  // ── DST Watchdog (every 15 min) — recovers jobs missed during clock changes ──
  // Runs at minute 2/17/32/47 to avoid racing with normal crons that fire at :00/:15/:30/:45.
  const DST_SKIP_JOBS = new Set([
    'reminders', 'shared_list', 'garmin_keepalive', 'invoice_queue', 'expire_signals',
  ]);
  cron.schedule('2,17,32,47 * * * *', async () => {
    const jobMap = getJobMap();
    const nowMs = Date.now();
    for (const [name, status] of jobMap) {
      if (DST_SKIP_JOBS.has(name)) continue;     // interval jobs don't need recovery
      if (!status.wrappedFn) continue;            // no callback stored
      if (status.lastResult === 'running') continue;

      try {
        const expr = CronExpressionParser.parse(status.cronExpression, { tz });
        const expectedPrev = expr.prev().toDate().getTime();
        const lastRan = status.lastRunAt ? new Date(status.lastRunAt).getTime() : 0;

        // Job was expected to run since last execution but didn't — fire it now
        // Min 2 min overdue: avoids racing with the normal cron that should fire the job
        // Max 3 hour window: avoids re-firing stale jobs after a restart
        const overdueMs = nowMs - expectedPrev;
        if (expectedPrev > lastRan && overdueMs >= 2 * 60 * 1000 && overdueMs < 3 * 60 * 60 * 1000) {
          logger.warn({ job: name, label: status.label, expectedAt: new Date(expectedPrev).toISOString() },
            'DST watchdog: recovering missed job');
          status.wrappedFn().catch((err) => {
            logger.error({ err, job: name }, 'DST watchdog: recovered job failed');
          });
        }
      } catch {
        // ignore parse errors for unusual cron expressions
      }
    }
  });

  logger.info(
    `Scheduler started: reminders, daily briefing (${config.todo.digestTime}), end-of-day (21:00), weekly (Fri 17:00), shared list (*/5), content (16:43), invoices (1st 09:00/09:15/09:30), conflict (19:30), fossa (bi-weekly Mon 07:30), garmin-keepalive (*/30), coach (${config.garmin.coachTime}), invoice-queue (*/15), channel-relearn (Sun 03:00), tue-reels (Tue 09:00), thu-youtube (Thu 09:00), fri-weekly (Fri 18:30), pipeline-agent (20:00), expire-signals (hourly), db-backup (${config.backup.time}), dst-watchdog (*/15)`
  );
}

// ── Exported for portal quick actions ─────────────────────────────────

export async function sendDailyBriefing(bot: Bot): Promise<void> {
  const today = now();
  const data: DailyBriefingData = {
    date: today.toFormat('cccc, LLLL dd'),
    events: [],
    highPriorityTasks: [],
    dueTodayTasks: [],
    overdueTasks: [],
    reminders: [],
    unreadEmails: 0,
    yesterdayCompleted: 0,
  };

  // Calendar events
  if (isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfDay(), endOfDay());
      data.events = events.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
      }));
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

  // Microsoft To Do tasks
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
        const todayStart = new Date(startOfDay()).getTime();
        const todayEnd = new Date(endOfDay()).getTime();

        data.highPriorityTasks = tasks
          .filter((t) => t.importance === 'high')
          .map((t) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

        data.dueTodayTasks = tasks
          .filter((t) => {
            if (!t.dueDateTime) return false;
            const due = new Date(t.dueDateTime).getTime();
            return due >= todayStart && due <= todayEnd;
          })
          .map((t) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

        const MAX_OVERDUE_DISPLAY = 20;
        const allOverdue = tasks
          .filter((t) => t.dueDateTime && new Date(t.dueDateTime).getTime() < todayStart)
          .map((t) => {
            const daysLate = Math.ceil((todayStart - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
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

  // Use userId 0 (default/owner) for the daily briefing — per-user briefings in v1.1
  const reminders = getRemindersForToday(0);
  data.reminders = reminders.map((r) => ({
    message: r.message,
    time: formatTime(r.remind_at),
  }));

  if (isOutlookMailConfigured()) {
    try {
      data.unreadEmails = await getUnreadCount();
    } catch (err) {
      logger.warn({ err }, 'Daily briefing: failed to fetch Outlook unread count');
    }
  }

  if (todayNotifications.length > 0) {
    data.automatedNotifications = [...todayNotifications];
  }

  const msg = formatDailyBriefing(data);
  const chunks = splitMessage(msg);

  for (const userId of getActiveUserIds()) {
    try {
      for (const chunk of chunks) {
        await bot.api.sendMessage(userId, chunk, { parse_mode: 'HTML' });
      }
    } catch (err) {
      logger.error({ err, userId }, 'Failed to send daily briefing');
    }
  }
}

async function sendWeeklyReview(bot: Bot): Promise<void> {
  let msg = `<b>📊 Week in Review</b>\n`;
  msg += `${now().startOf('week').toFormat('LLL dd')} - ${now().endOf('week').toFormat('LLL dd yyyy')}\n\n`;

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
          msg += `- ${escapeHtml(t.title)}`;
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

  for (const userId of getActiveUserIds()) {
    try {
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ err, userId }, 'Failed to send weekly review');
    }
  }
}
