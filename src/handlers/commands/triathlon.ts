// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Triathlon command handlers — extracted from bot.ts.
 *
 * Registers: /garminmfa, /coach
 * Callback: coach: (apply / all / dismiss)
 */

import { Bot, Context, InlineKeyboard } from 'grammy';
import { logger } from '../../utils/logger';
import { storeCallback, getCallback } from '../../utils/callback-store';
import { splitMessage, escapeHtml } from '../../utils/telegram-formatter';
import { addToConversation } from '../../state/conversation';
import { isGarminConfigured, isMfaPending, submitMfaCode } from '../../services/garmin';
import { generateCoachBriefing, CoachRecommendation } from '../../services/garmin-coach';
import { updateEvent as updateCalendarEvent } from '../../services/unified-calendar';
import { setLastCoachState } from '../../domains/domain-handler';
import { enqueue, lastActiveDomain, isHtmlParseError } from '../shared-state';
import {
  getActivePlan, getCurrentWeek, getSessionsForWeek, getWeeklyAdherence,
  markSessionCompleted, logCompletion, getPlanStats, updateSession,
} from '../../services/training-plans';
import { calculateReadiness, persistReadinessScore } from '../../services/readiness-scorer';
import { comparePlannedVsActual, formatComparison } from '../../services/training-comparison';

type Lang = 'pt-BR' | 'en-US';

/**
 * Apply a single coach recommendation to the calendar.
 * - MODIFY / SWAP -> updateEvent with new title/times
 * - REST -> updateEvent with cancelled title (keeps the slot visible but marked)
 * - KEEP -> no-op (shouldn't be called for KEEP)
 */
async function applyCoachRecommendation(rec: CoachRecommendation): Promise<void> {
  if (rec.action === 'KEEP') return; // No change needed

  if (rec.action === 'REST') {
    // Mark the event as cancelled (don't delete — athlete sees it on calendar)
    await updateCalendarEvent(
      {
        event_id: rec.eventId,
        new_title: rec.newTitle || `\u274C CANCELLED \u2014 ${rec.originalTitle}`,
      },
      rec.source,
    );
    return;
  }

  // MODIFY or SWAP — update title and optionally times
  const updateData: { event_id: string; new_title?: string; new_start?: string; new_end?: string } = {
    event_id: rec.eventId,
  };
  if (rec.newTitle && rec.newTitle !== rec.originalTitle) {
    updateData.new_title = rec.newTitle;
  }
  if (rec.newStart) updateData.new_start = rec.newStart;
  if (rec.newEnd) updateData.new_end = rec.newEnd;

  await updateCalendarEvent(updateData, rec.source);
}

export function registerTriathlonCommands(bot: Bot): void {
  // ── Garmin MFA Code Submission ──
  bot.command('garminmfa', async (ctx) => {
    const code = ctx.message?.text?.replace(/^\/garminmfa\s*/, '').trim();
    if (!code || !/^\d{4,8}$/.test(code)) {
      await ctx.reply('\u26A0\uFE0F Usage: <code>/garminmfa 123456</code>\n\nProvide the numeric code from your email.', { parse_mode: 'HTML' });
      return;
    }
    if (!isMfaPending()) {
      await ctx.reply('\u2139\uFE0F No MFA challenge pending. Garmin may not need a code right now.');
      return;
    }
    const accepted = submitMfaCode(code);
    if (accepted) {
      await ctx.reply('\u2705 MFA code submitted \u2014 Garmin login completing\u2026');
    } else {
      await ctx.reply('\u26A0\uFE0F MFA code was not accepted \u2014 the challenge may have expired.');
    }
  });

  // ── Garmin Daily Coach ──
  bot.command('coach', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isGarminConfigured()) {
        const { getUserLanguage } = require('../../services/user-service');
        const { t } = require('../../utils/i18n');
        await ctx.reply(t('garmin_not_connected', getUserLanguage(ctx.from!.id)));
        return;
      }

      await ctx.replyWithChatAction('typing');
      await ctx.reply('\u{1F3CB}\uFE0F Running coach analysis\u2026 collecting Garmin data + Claude analysis (~30s).', { parse_mode: 'HTML' });

      // Keep typing indicator alive during the long-running analysis
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const result = await generateCoachBriefing();
        clearInterval(typingInterval);

        // Store recommendations so triathlon domain can reference them in follow-up chat
        if (result.recommendations.length > 0) {
          setLastCoachState(ctx.from!.id, result.recommendations, result.message.substring(0, 500));
        }

        // Set conversation continuity to triathlon so follow-up replies stay in context
        if (ctx.from?.id) {
          lastActiveDomain.set(ctx.from.id, { domain: 'triathlon', timestamp: Date.now() });
        }

        // Save to triathlon conversation history so follow-ups have context
        addToConversation(ctx.from?.id ?? 0, 'triathlon', 'assistant', result.message);

        // Send the human-readable briefing
        const chunks = splitMessage(result.message);
        for (const chunk of chunks) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            // If HTML parsing fails, send without formatting
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }

        // Send interactive recommendation buttons (if any non-KEEP recommendations exist)
        const actionableRecs = result.recommendations.filter((r) => r.action !== 'KEEP');
        if (actionableRecs.length > 0) {
          const keyboard = new InlineKeyboard();
          const recRefs: string[] = [];
          for (const rec of actionableRecs) {
            const ref = storeCallback({ recommendation: rec });
            recRefs.push(ref);
            const emoji = rec.action === 'MODIFY' ? '\u26A0\uFE0F' : rec.action === 'SWAP' ? '\u{1F504}' : '\u274C';
            const label = `${emoji} ${rec.summary}`.substring(0, 60);
            keyboard.text(label, `coach:apply:${ref}`).row();
          }
          // Add "Apply all" if more than one
          const { getUserLanguage: getCoachLang } = require('../../services/user-service');
          const { t: tCoach } = require('../../utils/i18n');
          const coachLang = getCoachLang(ctx.from!.id);
          if (actionableRecs.length > 1) {
            const allRef = storeCallback({ recommendations: actionableRecs });
            keyboard.text(`\u2705 ${tCoach('apply_all', coachLang)}`, `coach:all:${allRef}`).row();
          }
          // Add dismiss button
          keyboard.text(`\u{1F44D} ${tCoach('keep_all', coachLang)}`, `coach:dismiss`);

          await ctx.reply(
            '\u{1F3CB}\uFE0F <b>A\u00E7\u00F5es do Coach:</b>\n\nQueres aplicar alguma destas altera\u00E7\u00F5es ao calend\u00E1rio de amanh\u00E3?',
            { parse_mode: 'HTML', reply_markup: keyboard },
          );
        }
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Coach briefing failed (manual)');
        await ctx.reply(`\u26A0\uFE0F Coach briefing failed: ${escapeHtml(err.message || 'Unknown error')}`, { parse_mode: 'HTML' });
      }
    });
  });

  // ── Coach Recommendation Callback Handler (apply / all / dismiss) ──
  bot.callbackQuery(/^coach:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1]; // 'apply' | 'all' | 'dismiss'
    const ref = parts[2];

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    if (action === 'dismiss') {
      const { getUserLanguage } = require('../../services/user-service');
      const { t } = require('../../utils/i18n');
      const dismissLang = getUserLanguage(ctx.from!.id);
      await ctx.editMessageText(`${t('coach_dismissed', dismissLang)} ${t('coach_good_training', dismissLang)}`, { parse_mode: 'HTML' });
      return;
    }

    if (action === 'apply') {
      // Apply a single recommendation
      const cbData = getCallback(ref);
      if (!cbData?.recommendation) {
        await ctx.editMessageText('\u26A0\uFE0F A\u00E7\u00E3o expirada. Usa /coach novamente.');
        return;
      }
      const rec = cbData.recommendation as CoachRecommendation;
      await ctx.editMessageText(`\u23F3 Aplicando: ${escapeHtml(rec.summary)}...`, { parse_mode: 'HTML' });
      try {
        await applyCoachRecommendation(rec);
        await ctx.editMessageText(
          `\u2705 <b>Altera\u00E7\u00E3o aplicada:</b>\n${escapeHtml(rec.summary)}\n\n\u{1F4C5} O evento <b>${escapeHtml(rec.originalTitle)}</b> foi atualizado no calend\u00E1rio.`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.error({ err, rec }, 'Coach: failed to apply recommendation');
        await ctx.editMessageText(`\u26A0\uFE0F Falha ao aplicar: ${escapeHtml((err as Error).message)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (action === 'all') {
      // Apply all actionable recommendations
      const cbData = getCallback(ref);
      if (!cbData?.recommendations) {
        await ctx.editMessageText('\u26A0\uFE0F A\u00E7\u00E3o expirada. Usa /coach novamente.');
        return;
      }
      const recs = cbData.recommendations as CoachRecommendation[];
      await ctx.editMessageText(`\u23F3 Aplicando ${recs.length} altera\u00E7\u00F5es ao calend\u00E1rio...`, { parse_mode: 'HTML' });

      let successCount = 0;
      const appliedSummaries: string[] = [];
      for (const rec of recs) {
        try {
          await applyCoachRecommendation(rec);
          successCount++;
          appliedSummaries.push(rec.summary);
        } catch (err) {
          logger.error({ err, rec }, 'Coach: failed to apply recommendation (batch)');
        }
      }

      if (successCount === 0) {
        await ctx.editMessageText('\u26A0\uFE0F Nenhuma altera\u00E7\u00E3o aplicada. Verifica o calend\u00E1rio.', { parse_mode: 'HTML' });
      } else {
        let msg = `\u2705 <b>${successCount}/${recs.length} altera\u00E7\u00F5es aplicadas:</b>\n`;
        for (const s of appliedSummaries) {
          msg += `\n  \u2022 ${escapeHtml(s)}`;
        }
        msg += '\n\n\u{1F4C5} Calend\u00E1rio de amanh\u00E3 atualizado.';
        try {
          await ctx.editMessageText(msg, { parse_mode: 'HTML' });
        } catch (err) {
          if (isHtmlParseError(err)) await ctx.editMessageText(msg.replace(/<[^>]*>/g, ''));
          else throw err;
        }
      }
      return;
    }
  });

  // ── /training <subcommand> — training plan interaction ──

  bot.command('training', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const { getUserLanguage } = require('../../services/user-service');
    const { t } = require('../../utils/i18n');
    const lang: Lang = getUserLanguage(userId);
    const args = ctx.message?.text?.split(' ').slice(1).join(' ').trim() || '';

    enqueue(userId, async () => {
      try {
        switch (args) {
          case 'plan':      return await handleTrainingPlan(ctx, userId, lang);
          case 'today':     return await handleTrainingToday(ctx, userId, lang);
          case 'done':      return await handleTrainingDone(ctx, userId, lang);
          case 'readiness': return await handleTrainingReadiness(ctx, userId, lang);
          case 'compare':   return await handleTrainingCompare(ctx, userId, lang);
          case 'history':   return await handleTrainingHistory(ctx, userId, lang);
          default:
            if (args.startsWith('feedback')) {
              return await handleTrainingFeedback(ctx, userId, lang, args.replace('feedback', '').trim());
            }
            await ctx.reply(t('training_help', lang), { parse_mode: 'HTML' });
        }
      } catch (err: any) {
        logger.error({ err, userId, args }, 'Training command failed');
        await ctx.reply(`⚠️ ${escapeHtml(err.message || 'Training command failed')}`);
      }
    });
  });

  // Training feedback callback (easy/perfect/hard inline buttons)
  bot.callbackQuery(/^tf:/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const { getUserLanguage } = require('../../services/user-service');
    const { t } = require('../../utils/i18n');
    const lang: Lang = getUserLanguage(userId);

    const parts = ctx.callbackQuery.data.split(':');
    const sessionId = parseInt(parts[1], 10);
    const rating = parts[2]; // easy | perfect | hard

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    const rpeMap: Record<string, number> = { easy: 4, perfect: 7, hard: 9 };
    const rpe = rpeMap[rating] || 7;

    try {
      logCompletion({
        session_id: sessionId,
        plan_id: 0,
        rpe_overall: rpe,
        notes: `User feedback: ${rating}`,
      });

      await ctx.editMessageText(t('training_feedback_saved', lang, { rating }));
    } catch (err) {
      logger.warn({ err, sessionId, rating }, 'Failed to save training feedback');
      await ctx.editMessageText('⚠️ Failed to save feedback.');
    }
  });
}

// ── Training Sub-command Handlers ──────────────────────────────────

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_LABELS_PT = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const DAY_LABELS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getTodayName(): string {
  const d = new Date().getDay(); // 0=Sun
  return DAY_NAMES[d === 0 ? 6 : d - 1];
}

async function handleTrainingPlan(ctx: Context, userId: number, lang: Lang): Promise<void> {
  const { t } = require('../../utils/i18n');
  const plan = getActivePlan(userId);
  if (!plan) { await ctx.reply(t('training_no_plan', lang)); return; }

  const currentWeek = getCurrentWeek(plan.id);
  if (!currentWeek) { await ctx.reply(t('training_no_week', lang)); return; }

  const sessions = getSessionsForWeek(currentWeek.id);
  const dayLabels = lang === 'pt-BR' ? DAY_LABELS_PT : DAY_LABELS_EN;

  let msg = `📋 <b>${escapeHtml(plan.name)}</b> — ${t('week', lang)} ${currentWeek.week_number}\n`;
  msg += `<i>${escapeHtml(currentWeek.focus || plan.goal || '')}</i>`;
  if (currentWeek.intensity_pct !== 100) msg += ` (${currentWeek.intensity_pct}%)`;
  msg += '\n\n';

  for (const session of sessions) {
    const dayIdx = DAY_NAMES.indexOf(session.day_of_week);
    const dayLabel = dayIdx >= 0 ? dayLabels[dayIdx] : session.day_of_week;
    const statusEmoji = session.status === 'completed' ? '✅' : session.status === 'skipped' ? '⏭️' : '⬜';
    msg += `${statusEmoji} <b>${dayLabel}</b> — ${escapeHtml(session.title)} (${session.duration_minutes || '?'}min)\n`;
  }

  const adherence = getWeeklyAdherence(plan.id, currentWeek.id);
  msg += `\n📊 ${adherence.completedSessions}/${adherence.totalSessions} ${t('completed', lang)}`;

  const planParts = splitMessage(msg);
  for (const part of planParts) {
    await ctx.reply(part, { parse_mode: 'HTML' });
  }
}

async function handleTrainingToday(ctx: Context, userId: number, lang: Lang): Promise<void> {
  const { t } = require('../../utils/i18n');
  const plan = getActivePlan(userId);
  if (!plan) { await ctx.reply(t('training_no_plan', lang)); return; }

  const currentWeek = getCurrentWeek(plan.id);
  if (!currentWeek) { await ctx.reply(t('training_no_week', lang)); return; }

  const sessions = getSessionsForWeek(currentWeek.id);
  const todayName = getTodayName();
  const todaySession = sessions.find(s => s.day_of_week === todayName && s.status === 'pending');

  if (!todaySession) {
    const doneSession = sessions.find(s => s.day_of_week === todayName && s.status === 'completed');
    if (doneSession) {
      await ctx.reply(`✅ ${t('training_already_done', lang)}: ${escapeHtml(doneSession.title)}`);
    } else {
      await ctx.reply(`🛌 ${t('training_rest_day', lang)}`);
    }
    return;
  }

  let msg = `🏋️ <b>${escapeHtml(todaySession.title)}</b>\n`;
  msg += `<i>${todaySession.session_type} · ${todaySession.duration_minutes || '?'}min`;
  if (todaySession.intensity_text) msg += ` · ${escapeHtml(todaySession.intensity_text)}`;
  msg += '</i>\n\n';

  // Parse exercises
  try {
    const exercises = JSON.parse(todaySession.exercises_json || '[]');
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      msg += `<b>${i + 1}. ${escapeHtml(ex.name)}</b>\n`;
      msg += `   ${ex.sets}×${ex.reps}`;
      if (ex.weight) msg += ` @ ${escapeHtml(ex.weight)}`;
      msg += ` · ${ex.restSeconds || ex.rest_sec || 90}s rest\n`;
    }
  } catch { /* no exercises JSON */ }

  msg += `\n✅ ${t('training_done_hint', lang)}: /training done`;

  // Readiness hint
  try {
    const readiness = await calculateReadiness(userId);
    if (readiness.score < 50) {
      msg += `\n\n⚠️ ${t('training_low_readiness', lang, { score: String(readiness.score), rec: readiness.recommendation })}`;
    }
  } catch { /* Garmin not configured */ }

  const todayParts = splitMessage(msg);
  for (const part of todayParts) {
    await ctx.reply(part, { parse_mode: 'HTML' });
  }
}

async function handleTrainingDone(ctx: Context, userId: number, lang: Lang): Promise<void> {
  const { t } = require('../../utils/i18n');
  const plan = getActivePlan(userId);
  if (!plan) { await ctx.reply(t('training_no_plan', lang)); return; }

  const currentWeek = getCurrentWeek(plan.id);
  if (!currentWeek) { await ctx.reply(t('training_no_week', lang)); return; }

  const sessions = getSessionsForWeek(currentWeek.id);
  const todayName = getTodayName();
  const todaySession = sessions.find(s => s.day_of_week === todayName && s.status === 'pending');

  if (!todaySession) {
    await ctx.reply(t('training_no_session_today', lang));
    return;
  }

  markSessionCompleted(todaySession.id);

  await ctx.reply(t('training_marked_done', lang, { title: todaySession.title }), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '😴 ' + t('too_easy', lang), callback_data: `tf:${todaySession.id}:easy` },
        { text: '👌 ' + t('perfect', lang), callback_data: `tf:${todaySession.id}:perfect` },
        { text: '🥵 ' + t('too_hard', lang), callback_data: `tf:${todaySession.id}:hard` },
      ]],
    },
  });
}

async function handleTrainingReadiness(ctx: Context, userId: number, lang: Lang): Promise<void> {
  const { t } = require('../../utils/i18n');
  await ctx.replyWithChatAction('typing');

  const readiness = await calculateReadiness(userId);
  persistReadinessScore(userId, readiness);

  const f = readiness.factors;
  let msg = `📊 <b>${t('readiness_score', lang)}: ${readiness.score}/100</b>\n\n`;
  msg += `❤️ HRV: ${f.hrv.todayMs}ms (avg: ${f.hrv.sevenDayAvgMs}ms) — ${f.hrv.trend}\n`;
  msg += `😴 ${t('sleep', lang)}: ${f.sleep.durationHours.toFixed(1)}h (score: ${f.sleep.qualityScore})\n`;
  msg += `🔋 Body Battery: ${f.bodyBattery.current}/100\n`;
  msg += `📈 ACWR: ${f.trainingLoad.acwr.toFixed(2)}\n\n`;

  const recEmoji: Record<string, string> = {
    full_intensity: '🟢', reduce_10pct: '🟡', reduce_25pct: '🟠',
    active_recovery: '🔴', rest_day: '⛔',
  };
  msg += `${recEmoji[readiness.recommendation] || '⚪'} <b>${t('recommendation', lang)}:</b> ${t(`readiness_${readiness.recommendation}`, lang)}`;

  await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function handleTrainingCompare(ctx: Context, userId: number, lang: Lang): Promise<void> {
  await ctx.replyWithChatAction('typing');
  const result = await comparePlannedVsActual(userId);
  const msg = formatComparison(result);
  const compareParts = splitMessage(msg);
  for (const part of compareParts) {
    await ctx.reply(part, { parse_mode: 'HTML' });
  }
}

async function handleTrainingHistory(ctx: Context, userId: number, lang: Lang): Promise<void> {
  const { t } = require('../../utils/i18n');
  const stats = getPlanStats(userId);

  if (!stats.currentPlanName) {
    await ctx.reply(t('training_no_plan', lang));
    return;
  }

  let msg = `📊 <b>${escapeHtml(stats.currentPlanName)}</b>\n\n`;
  msg += `🏋️ Total sessions completed: ${stats.totalCompletedSessions}\n`;
  msg += `📈 Current week adherence: ${stats.currentWeekAdherence ?? 0}%\n`;
  msg += `📋 Active plans: ${stats.activePlans}\n`;

  const histParts = splitMessage(msg);
  for (const part of histParts) {
    await ctx.reply(part, { parse_mode: 'HTML' });
  }
}

async function handleTrainingFeedback(ctx: Context, userId: number, lang: Lang, rating: string): Promise<void> {
  const { t } = require('../../utils/i18n');
  const validRatings = ['easy', 'perfect', 'hard'];
  if (!validRatings.includes(rating)) {
    await ctx.reply('Usage: /training feedback easy|perfect|hard');
    return;
  }

  const plan = getActivePlan(userId);
  if (!plan) { await ctx.reply(t('training_no_plan', lang)); return; }

  const currentWeek = getCurrentWeek(plan.id);
  if (!currentWeek) return;

  // Find most recently completed session
  const sessions = getSessionsForWeek(currentWeek.id);
  const completed = sessions.filter(s => s.status === 'completed');
  const lastCompleted = completed[completed.length - 1];

  if (!lastCompleted) {
    await ctx.reply('No completed session to rate. Complete a session first with /training done.');
    return;
  }

  const rpeMap: Record<string, number> = { easy: 4, perfect: 7, hard: 9 };
  logCompletion({
    session_id: lastCompleted.id,
    plan_id: plan.id,
    rpe_overall: rpeMap[rating] || 7,
    notes: `Feedback: ${rating}`,
  });

  await ctx.reply(t('training_feedback_saved', lang, { rating }));
}
