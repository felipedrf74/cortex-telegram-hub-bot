// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary Command Fastpath — Layer 1 of the 4-layer token optimization.
 *
 * Intercepts common, deterministic secretary patterns BEFORE they reach the
 * AI pipeline. Each pattern handler reads directly from the relevant service
 * (Microsoft To Do / Google Calendar / Outlook / SQLite reminders) and
 * returns a pre-formatted Telegram-HTML response. The format is identical to
 * what the AI would produce for the same query, so users cannot tell the
 * difference between a fastpath response and an AI response — the only
 * observable difference is latency (<500ms vs 3-5s) and cost ($0 vs ~$0.08).
 *
 * Token economics:
 *   - Full AI path:  ~25,000-30,000 input tokens per interaction (Sonnet)
 *   - Fastpath:      0 tokens — pure database/API reads + template formatting
 *
 * Why this lives in src/services/ and is called from handleSecretary() (NOT
 * from the Telegram message handler): three different transports call
 * handleSecretary — Telegram (bot.ts), iOS REST (api/routes/chat.ts), and
 * WebSocket (api/websocket.ts). Putting the fastpath inside the domain
 * handler itself means all three get the optimization for free.
 *
 * Pattern dictionary maintenance: each new pattern lowers the average token
 * cost per secretary message. Watch the portal's "Secretary Optimization"
 * card — when the fastpath hit rate drops below ~30% it usually means there
 * are common phrasings missing from the dictionary that should be added.
 */

import { getEvents, hasConnectedCalendarForUser } from './unified-calendar';
import type { TodoTask } from './microsoft-todo';
import { getRemindersForToday, setReminder } from '../state/reminders';
import {
  now,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  formatTime,
} from '../utils/date-parser';
import { escapeHtml } from '../utils/telegram-formatter';
import type { DomainName, DomainResponse } from '../domains/types';
import { logger } from '../utils/logger';
import { isSubmoduleEnabled } from '../skills/registry';
import type { Lang } from '../utils/i18n';
import { getUserLanguage } from './user-service';
import { getTaskProviderForUser } from './task-store/task-router';
import { composeDailyBrief } from './daily-brief-orchestrator';
import { getUnreadMailSummaryForUser, isAnyMailConfiguredForUser } from './unified-mail-pressure';

// ─── Types ──────────────────────────────────────────────────────────

export interface FastpathResult {
  matched: boolean;
  /** The formatted response, if matched. */
  response?: DomainResponse;
  /** Which pattern matched (for metrics). */
  patternId?: string;
}

interface PatternEntry {
  id: string;
  pattern: RegExp;
  /**
   * Returns the formatted response. Receives `lang` so the handler can
   * pick localized copy. May throw — caller catches and falls through
   * to the AI pipeline.
   */
  handler: (userId: number, match: RegExpMatchArray, lang: Lang) => Promise<DomainResponse>;
  /** Optional sub-skill the pattern depends on. If disabled, the pattern is skipped. */
  requires?: 'tasks' | 'calendar' | 'email' | 'reminders';
}

// ─── Helpers ────────────────────────────────────────────────────────

const SECRETARY: DomainName = 'secretary';

function getScopedTaskProvider(userId: number) {
  if (!userId) return null;
  return getTaskProviderForUser(userId);
}

// ─── Bilingual copy table ───────────────────────────────────────────
//
// Added April 2026 to support the iOS LanguageRouter + Telegram
// per-user language preference. Every user-facing string the fastpath
// emits flows through this table so a single switch on `lang` picks
// the correct template.
//
// Adding a new key: add it to BOTH 'pt-BR' and 'en-US' columns. The
// `Copy` type is exhaustive so a missing key is a compile error, not
// a runtime fallthrough.

type CopyKey =
  | 'agendaHeader'
  | 'agendaEmpty'
  | 'tasksHeader'
  | 'tasksPending'
  | 'tasksOverdue'
  | 'tasksDueToday'
  | 'trainingHeader'
  | 'trainingEmpty'
  | 'remindersHeader'
  | 'emailsHeader'
  | 'emailsUnreadSuffix'
  | 'weekHeader'
  | 'weekFree'
  | 'pendingTasksHeader'
  | 'pendingTasksEmpty'
  | 'moreTasksSuffix'
  | 'tasksErrorFetch'
  | 'overdueHeader'
  | 'overdueHeaderPlural'
  | 'overdueEmpty'
  | 'overdueDueLabel'
  | 'emailConfigMissing'
  | 'priorityHeader'
  | 'inboxClean'
  | 'emailUnreadLine'
  | 'reminderInvalidTime'
  | 'reminderSavedError'
  | 'reminderSetPrefix'
  | 'reminderDayToday'
  | 'reminderDayTomorrow'
  | 'taskCreated'
  | 'taskCreateError'
  | 'taskCreateErrorDetail'
  | 'taskCreateNoList'
  | 'taskEmptyTitle';

interface DayNamesCopy {
  dayNames: readonly [string, string, string, string, string, string, string];
}

type Copy = Record<CopyKey, string> & DayNamesCopy;

const COPY: Record<Lang, Copy> = {
  'pt-BR': {
    agendaHeader: 'AGENDA:',
    agendaEmpty: 'Sem eventos hoje',
    tasksHeader: 'TAREFAS:',
    tasksPending: 'pendentes',
    tasksOverdue: 'atrasadas',
    tasksDueToday: 'Para hoje:',
    trainingHeader: 'TREINO:',
    trainingEmpty: 'Sem treino planeado hoje',
    remindersHeader: 'LEMBRETES:',
    emailsHeader: 'E-MAILS:',
    emailsUnreadSuffix: 'não lidos',
    weekHeader: 'SEMANA',
    weekFree: 'livre',
    pendingTasksHeader: 'Tarefas Pendentes',
    pendingTasksEmpty: '✅ Sem tarefas pendentes!',
    moreTasksSuffix: 'mais',
    tasksErrorFetch: '⚠️ Erro ao buscar tarefas. Tente novamente em instantes.',
    overdueHeader: 'Tarefa Atrasada',
    overdueHeaderPlural: 'Tarefas Atrasadas',
    overdueEmpty: '✅ Nenhuma tarefa atrasada!',
    overdueDueLabel: 'prazo:',
    emailConfigMissing: '⚠️ Email não configurado. Ligue Outlook ou Gmail em /settings.',
    priorityHeader: 'PRIORIDADE DE HOJE',
    inboxClean: '📧 Caixa de entrada limpa! ✨',
    emailUnreadLine: '📧 Você tem <b>%COUNT%</b> e-mail%S% não lido%S%.',
    reminderInvalidTime: '❌ Horário inválido:',
    reminderSavedError: '⚠️ Erro ao salvar lembrete.',
    reminderSetPrefix: '⏰ Lembrete definido para',
    reminderDayToday: 'hoje',
    reminderDayTomorrow: 'amanhã',
    taskCreated: '✅ Tarefa criada em',
    taskCreateError: '⚠️ Erro ao criar tarefa. Tente novamente.',
    taskCreateErrorDetail: '⚠️ Erro ao criar tarefa:',
    taskCreateNoList: '⚠️ Lista padrão do Microsoft To Do não encontrada. Configure em /settings.',
    taskEmptyTitle: '❌ Título da tarefa não pode estar vazio.',
    dayNames: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
  },
  'en-US': {
    agendaHeader: 'AGENDA:',
    agendaEmpty: 'No events today',
    tasksHeader: 'TASKS:',
    tasksPending: 'pending',
    tasksOverdue: 'overdue',
    tasksDueToday: 'Due today:',
    trainingHeader: 'TRAINING:',
    trainingEmpty: 'No training planned today',
    remindersHeader: 'REMINDERS:',
    emailsHeader: 'EMAILS:',
    emailsUnreadSuffix: 'unread',
    weekHeader: 'WEEK',
    weekFree: 'free',
    pendingTasksHeader: 'Pending Tasks',
    pendingTasksEmpty: '✅ No pending tasks!',
    moreTasksSuffix: 'more',
    tasksErrorFetch: '⚠️ Couldn\'t fetch tasks. Please try again shortly.',
    overdueHeader: 'Overdue Task',
    overdueHeaderPlural: 'Overdue Tasks',
    overdueEmpty: '✅ No overdue tasks!',
    overdueDueLabel: 'due:',
    emailConfigMissing: '⚠️ Email not configured. Connect Outlook or Gmail in /settings.',
    priorityHeader: 'TODAY\'S PRIORITY',
    inboxClean: '📧 Inbox clean! ✨',
    emailUnreadLine: '📧 You have <b>%COUNT%</b> unread email%S%.',
    reminderInvalidTime: '❌ Invalid time:',
    reminderSavedError: '⚠️ Couldn\'t save reminder.',
    reminderSetPrefix: '⏰ Reminder set for',
    reminderDayToday: 'today',
    reminderDayTomorrow: 'tomorrow',
    taskCreated: '✅ Task created in',
    taskCreateError: '⚠️ Couldn\'t create task. Try again.',
    taskCreateErrorDetail: '⚠️ Couldn\'t create task:',
    taskCreateNoList: '⚠️ Microsoft To Do default list not found. Configure in /settings.',
    taskEmptyTitle: '❌ Task title cannot be empty.',
    dayNames: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
  'pt-PT': {
    agendaHeader: 'AGENDA:',
    agendaEmpty: 'Sem eventos hoje',
    tasksHeader: 'TAREFAS:',
    tasksPending: 'pendentes',
    tasksOverdue: 'atrasadas',
    tasksDueToday: 'Para hoje:',
    trainingHeader: 'TREINO:',
    trainingEmpty: 'Sem treino planeado para hoje',
    remindersHeader: 'LEMBRETES:',
    emailsHeader: 'E-MAILS:',
    emailsUnreadSuffix: 'por ler',
    weekHeader: 'SEMANA',
    weekFree: 'livre',
    pendingTasksHeader: 'Tarefas Pendentes',
    pendingTasksEmpty: '✅ Sem tarefas pendentes!',
    moreTasksSuffix: 'mais',
    tasksErrorFetch: '⚠️ Erro ao procurar tarefas. Tenta novamente daqui a instantes.',
    overdueHeader: 'Tarefa Atrasada',
    overdueHeaderPlural: 'Tarefas Atrasadas',
    overdueEmpty: '✅ Nenhuma tarefa atrasada!',
    overdueDueLabel: 'prazo:',
    emailConfigMissing: '⚠️ Email não configurado. Liga Outlook ou Gmail em /settings.',
    priorityHeader: 'PRIORIDADE DE HOJE',
    inboxClean: '📧 Caixa de entrada limpa! ✨',
    emailUnreadLine: '📧 Tens <b>%COUNT%</b> e-mail%S% por ler.',
    reminderInvalidTime: '❌ Hora inválida:',
    reminderSavedError: '⚠️ Erro ao guardar lembrete.',
    reminderSetPrefix: '⏰ Lembrete definido para',
    reminderDayToday: 'hoje',
    reminderDayTomorrow: 'amanhã',
    taskCreated: '✅ Tarefa criada em',
    taskCreateError: '⚠️ Erro ao criar tarefa. Tenta novamente.',
    taskCreateErrorDetail: '⚠️ Erro ao criar tarefa:',
    taskCreateNoList: '⚠️ Lista padrão do Microsoft To Do não encontrada. Configura em /settings.',
    taskEmptyTitle: '❌ O título da tarefa não pode estar vazio.',
    dayNames: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
  },
};

function copyForLang(lang: Lang): Copy {
  return COPY[lang];
}

/**
 * Returns the date-fns-style locale code for a given app Lang.
 * Used for toLocaleDateString() when we want the user's language to
 * drive the numeric date formatting ("04/09/2026" vs "09/04/2026").
 */
function localeForLang(lang: Lang): string {
  if (lang === 'pt-PT') return 'pt-PT';
  if (lang === 'pt-BR') return 'pt-BR';
  return 'en-US';
}

/**
 * Filter a task list to those due today, in the configured timezone.
 * Date-only comparison (NOT timestamp comparison) so a task "due April 6"
 * is treated as due TODAY at any moment on April 6, matching MS Todo's UI.
 */
function filterDueToday(tasks: TodoTask[]): TodoTask[] {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
  return tasks.filter((t) => {
    if (!t.dueDateTime) return false;
    const d = new Date(t.dueDateTime).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
    return d === todayStr;
  });
}

function filterOverdue(tasks: TodoTask[]): TodoTask[] {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
  return tasks.filter((t) => {
    if (!t.dueDateTime) return false;
    const d = new Date(t.dueDateTime).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
    return d < todayStr;
  });
}

const TRAINING_KEYWORDS = [
  'run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength', 'hiit', 'yoga',
  'treino', 'corrida', 'academia', 'natacao', 'natação', 'musculacao', 'musculação', 'ciclismo',
  'caminhada', 'walk', 'easy run', 'interval', 'tempo', 'long run', 'cross', 'stretch',
];

function looksLikeTrainingTitle(title: string | undefined | null): boolean {
  const normalized = (title || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return TRAINING_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

async function getTodayTrainingSummary(userId: number, events: Array<{ summary?: string; start: string; end: string }>): Promise<string | null> {
  try {
    const tp = require('../../services/training-plans');
    const activePlan = tp.getActivePlan?.(userId);
    if (activePlan) {
      const currentWeek = tp.getCurrentWeek?.(activePlan.id);
      if (currentWeek) {
        const sessions = tp.getSessionsForWeek?.(currentWeek.id) || [];
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const rawSession = sessions.find((session: any) => session.day_of_week === todayName);
        if (rawSession) {
          const duration = rawSession.duration_minutes ? ` · ${rawSession.duration_minutes} min` : '';
          return `${escapeHtml(rawSession.title || rawSession.session_type || 'Workout')}${duration}`;
        }
      }
    }
  } catch (err) {
    logger.debug({ err, userId }, 'fastpath: training plan lookup failed');
  }

  const event = events.find((item) => looksLikeTrainingTitle(item.summary));
  if (event) {
    const durationMinutes = Math.max(
      0,
      Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000),
    );
    const duration = Number.isFinite(durationMinutes) && durationMinutes > 0 ? ` · ${durationMinutes} min` : '';
    return `${escapeHtml(event.summary || 'Workout')} · ${formatTime(event.start)}${duration}`;
  }

  // CHAT-M3: Third fallback — check Garmin for today's recorded activities.
  // Catches ad-hoc gym sessions that aren't in the plan or calendar.
  try {
    const { getTodayData } = require('./garmin');
    const garminData = await getTodayData(userId);
    const activities = garminData?.activities || [];
    if (activities.length > 0) {
      const act = activities[activities.length - 1];
      const dur = act.duration ? ` · ${Math.round(act.duration / 60)} min` : '';
      return `${escapeHtml(act.activityName || 'Workout')}${dur} ✅`;
    }
  } catch {
    // Garmin unavailable — return null (rest day)
  }

  return null;
}

// ─── Fastpath Metrics (in-memory; portal reads these) ────────────────

interface FastpathMetrics {
  totalAttempts: number;
  totalHits: number;
  hitsByPattern: Record<string, number>;
  totalLatencyMs: number;
}

const _metrics: FastpathMetrics = {
  totalAttempts: 0,
  totalHits: 0,
  hitsByPattern: {},
  totalLatencyMs: 0,
};

export function getFastpathMetrics(): Readonly<FastpathMetrics> & {
  hitRate: number;
  avgLatencyMs: number;
} {
  const hitRate = _metrics.totalAttempts > 0 ? _metrics.totalHits / _metrics.totalAttempts : 0;
  const avgLatencyMs = _metrics.totalHits > 0 ? _metrics.totalLatencyMs / _metrics.totalHits : 0;
  return {
    ..._metrics,
    hitsByPattern: { ..._metrics.hitsByPattern },
    hitRate,
    avgLatencyMs,
  };
}

/** Reset metrics — exposed for testing. */
export function resetFastpathMetrics(): void {
  _metrics.totalAttempts = 0;
  _metrics.totalHits = 0;
  _metrics.totalLatencyMs = 0;
  for (const k of Object.keys(_metrics.hitsByPattern)) delete _metrics.hitsByPattern[k];
}

// ─── Pattern Dictionary ─────────────────────────────────────────────
//
// Patterns are tested in order. First match wins. Each entry should have a
// pattern strict enough not to false-positive on natural-language queries
// that need AI reasoning ("plan my week considering training") while still
// matching common deterministic phrasings in BOTH PT-BR and EN.
//
// To add a new pattern:
//   1. Pick a unique id (snake_case)
//   2. Write a regex that matches the trigger phrase (anchor with ^ and end
//      with [\s?!.]*$ to avoid mid-sentence false positives)
//   3. Implement the handler — must return a DomainResponse with the same
//      Telegram HTML structure the AI would produce for that query
//   4. Add a test in __tests__/services/secretary-fastpath.test.ts

const FASTPATH_PATTERNS: PatternEntry[] = [
  // ── Day Overview ────────────────────────────────────────────────
  // "what's my day", "o que tenho hoje", "/day", "today", "hoje", "mostra meu dia"
  {
    id: 'day_overview',
    pattern: /^(?:what(?:'s| is)(?: on)? my (?:day|schedule)(?: today)?|what do i have today|(?:o que|como)(?: está| é)?(?: o)? meu dia|(?:show|mostra) (?:my |meu |o )?(?:day|dia)|\/day|today|hoje|o que tenho hoje|o que tenho na agenda hoje|qual(?:'s)? (?:my |a minha )?agenda(?: today| hoje)?)[\s?!.]*$/i,
    handler: async (userId, _match, lang) => {
      const c = copyForLang(lang);
      const tasksOk = isSubmoduleEnabled('secretary', 'tasks');
      const calOk = isSubmoduleEnabled('secretary', 'calendar');
      const emailOk = isSubmoduleEnabled('secretary', 'email');
      const remOk = isSubmoduleEnabled('secretary', 'reminders');
      const taskProvider = tasksOk ? getScopedTaskProvider(userId) : null;
      const hasCalendar = calOk && !!userId && hasConnectedCalendarForUser(userId);
      const hasMail = emailOk && !!userId && isAnyMailConfiguredForUser(userId);

      const [events, todoResult, reminders] = await Promise.all([
        hasCalendar
          ? getEvents(startOfDay(), endOfDay(), userId).catch(() => [])
          : Promise.resolve([]),
        taskProvider
          ? taskProvider.getAllPendingTasks().catch(() => ({ success: false as const, data: [], error: 'API error' }))
          : Promise.resolve({ success: false as const, data: [], error: 'disabled' }),
        remOk ? Promise.resolve(getRemindersForToday(userId)) : Promise.resolve([]),
      ]);
      const todayTraining = await getTodayTrainingSummary(userId, events);

      // Date header in the user's locale. PT-BR puts day before
      // month ("terça, 09 abril 2026"); EN puts month before day
      // ("Tuesday, April 09 2026"). Luxon reads the TOKENS but
      // the LOCALE of the formatter is set via .setLocale().
      const todayStr = now()
        .setLocale(localeForLang(lang))
        .toFormat(lang.startsWith('pt') ? 'cccc, dd LLLL yyyy' : 'cccc, LLLL dd yyyy');
      let msg = `📅 <b>${todayStr}</b>\n\n`;

      // Calendar events block
      if (events.length > 0) {
        msg += `📋 <b>${c.agendaHeader}</b>\n`;
        for (const e of events) {
          msg += `▸ ${formatTime(e.start)}–${formatTime(e.end)}  ${escapeHtml(e.summary)}\n`;
        }
      } else if (hasCalendar) {
        msg += `📋 <b>${c.agendaHeader}</b> ${c.agendaEmpty}\n`;
      }

      // Tasks block
      if (todoResult.success && todoResult.data.length > 0) {
        const tasks = todoResult.data;
        const overdue = filterOverdue(tasks);
        const dueToday = filterDueToday(tasks);

        msg += `\n📌 <b>${c.tasksHeader}</b> ${tasks.length} ${c.tasksPending}`;
        if (overdue.length > 0) msg += ` | ⚠️ ${overdue.length} ${c.tasksOverdue}`;
        if (dueToday.length > 0) {
          msg += `\n<b>${c.tasksDueToday}</b>\n`;
          for (const t of dueToday.slice(0, 5)) {
            msg += `▸ ${escapeHtml(t.title)}\n`;
          }
        } else {
          msg += `\n`;
        }
      }

      // Training block
      if (todayTraining) {
        msg += `\n🏋️ <b>${c.trainingHeader}</b>\n▸ ${todayTraining}\n`;
      } else {
        msg += `\n🏋️ <b>${c.trainingHeader}</b> ${c.trainingEmpty}\n`;
      }

      // Reminders block
      if (reminders.length > 0) {
        msg += `\n⏰ <b>${c.remindersHeader}</b>\n`;
        for (const r of reminders.slice(0, 5)) {
          msg += `▸ ${formatTime(r.remind_at)} ${escapeHtml(r.message)}\n`;
        }
      }

      // Unread emails (best-effort, non-fatal)
      if (hasMail) {
        try {
          const unread = await getUnreadMailSummaryForUser(userId);
          if (unread.totalUnread > 0) {
            msg += `\n📧 <b>${c.emailsHeader}</b> ${unread.totalUnread} ${c.emailsUnreadSuffix}\n`;
          }
        } catch { /* silent */ }
      }

      return { text: msg.trim(), domain: SECRETARY };
    },
  },

  // ── Week Overview ───────────────────────────────────────────────
  // "what's my week", "show my week", "/week", "esta semana", "minha semana"
  {
    id: 'daily_priority',
    pattern: /^(?:what(?:'s| is)? my priority(?: today)?|what should i do first(?: today)?|prioriti[sz]e my day|o que faço primeiro|o que devo fazer primeiro|o que devo priorizar(?: hoje)?|o que priorizo(?: hoje)?|qual(?: é| a)? prioridade(?: hoje)?|prioriza o meu dia|priorizar o meu dia|prioriza meu dia|priorizar meu dia)[\s?!.]*$/i,
    handler: async (_userId, _match, lang) => {
      const c = copyForLang(lang);
      const brief = await composeDailyBrief({ userId: _userId, language: lang });
      const coordination = brief.coordination;
      const topPriority = coordination?.nextBestAction?.title
        ?? coordination?.topPriority
        ?? brief.day.secretary.priorityNote;
      const executionOrder = coordination?.executionOrder?.length
        ? coordination.executionOrder
        : brief.day.secretary.sequence.slice(0, 4);
      const blockerLine = coordination?.blockers?.[0]?.summary ?? null;

      if (!topPriority && executionOrder.length === 0) {
        return { text: c.inboxClean, domain: SECRETARY };
      }

      const lines = [`🎯 <b>${c.priorityHeader}</b>`];
      if (topPriority) lines.push(`• ${escapeHtml(topPriority)}`);
      if (coordination?.nextBestAction?.summary) {
        lines.push(escapeHtml(coordination.nextBestAction.summary));
      }
      if (executionOrder.length > 0) {
        lines.push('');
        lines.push(...executionOrder.map((step, index) => `${index + 1}. ${escapeHtml(step)}`));
      }
      if (blockerLine) {
        lines.push('');
        lines.push(`⚠️ ${escapeHtml(blockerLine)}`);
      } else if ((coordination?.watchouts?.length ?? 0) > 0) {
        lines.push('');
        lines.push(`⚠️ ${escapeHtml(coordination!.watchouts.join(' | '))}`);
      }
      if ((coordination?.handoffs?.length ?? 0) > 0) {
        lines.push(`↔️ ${escapeHtml(coordination!.handoffs.join(' | '))}`);
      }
      return { text: lines.join('\n').trim(), domain: SECRETARY };
    },
  },

  {
    id: 'week_overview',
    pattern: /^(?:what(?:'s| is) my week|(?:show|mostra) (?:my |a |minha )?(?:week|semana)|(?:como|o que)(?: está)? (?:a |minha )?semana|\/week|this week|esta semana)[\s?!.]*$/i,
    requires: 'calendar',
    handler: async (_userId, _match, lang) => {
      const c = copyForLang(lang);
      const events = _userId && hasConnectedCalendarForUser(_userId)
        ? await getEvents(startOfWeek(), endOfWeek(), _userId).catch(() => [])
        : [];

      let msg = `📅 <b>${c.weekHeader}</b>\n\n`;

      // Group by yyyy-MM-dd in the configured timezone
      const byDay = new Map<string, typeof events>();
      for (const e of events) {
        const day = new Date(e.start).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(e);
      }

      // Iterate Monday through Sunday and render each day's events
      const weekStart = now().startOf('week'); // Luxon Monday-start
      for (let i = 0; i < 7; i++) {
        const d = weekStart.plus({ days: i });
        const dateStr = d.toFormat('yyyy-MM-dd');
        const dayEvents = byDay.get(dateStr) || [];
        const dayLabel = c.dayNames[i];
        const dateLabel = d.toFormat('dd/MM');

        if (dayEvents.length > 0) {
          msg += `<b>${dayLabel} ${dateLabel}</b>\n`;
          for (const e of dayEvents) {
            msg += `  ▸ ${formatTime(e.start)} ${escapeHtml(e.summary)}\n`;
          }
        } else {
          msg += `<b>${dayLabel} ${dateLabel}</b> — ${c.weekFree}\n`;
        }
      }

      return { text: msg.trim(), domain: SECRETARY };
    },
  },

  // ── Show Tasks / Todos ──────────────────────────────────────────
  // "show my tasks", "list todos", "mostra minhas tarefas", "/tasks", "/todo"
  {
    id: 'show_tasks',
    pattern: /^(?:show|list|mostra|lista) (?:my |minhas? )?(?:tasks?|todos?|tarefas?)[\s?!.]*$|^\/(?:tasks?|todos?)[\s?!.]*$/i,
    requires: 'tasks',
    handler: async (_userId, _match, lang) => {
      const c = copyForLang(lang);
      const taskProvider = getScopedTaskProvider(_userId);
      const result = taskProvider
        ? await taskProvider.getAllPendingTasks().catch(() => ({
            success: false as const,
            data: [],
            error: 'API error',
          }))
        : { success: false as const, data: [], error: 'disabled' };

      if (!result.success) {
        return { text: c.tasksErrorFetch, domain: SECRETARY };
      }
      if (result.data.length === 0) {
        return { text: c.pendingTasksEmpty, domain: SECRETARY };
      }

      let msg = `📋 <b>${c.pendingTasksHeader}</b> (${result.data.length})\n\n`;
      const byList = new Map<string, TodoTask[]>();
      for (const t of result.data) {
        if (!byList.has(t.listName)) byList.set(t.listName, []);
        byList.get(t.listName)!.push(t);
      }

      const locale = localeForLang(lang);
      for (const [listName, tasks] of byList) {
        msg += `<b>${escapeHtml(listName)}</b> (${tasks.length})\n`;
        for (const t of tasks.slice(0, 10)) {
          const dueLabel = t.dueDateTime
            ? ` 📅 ${new Date(t.dueDateTime).toLocaleDateString(locale)}`
            : '';
          msg += `  ▸ ${escapeHtml(t.title)}${dueLabel}\n`;
        }
        if (tasks.length > 10) msg += `  ... +${tasks.length - 10} ${c.moreTasksSuffix}\n`;
        msg += '\n';
      }

      return { text: msg.trim(), domain: SECRETARY };
    },
  },

  // ── Unread Email Count ──────────────────────────────────────────
  // "how many unread", "unread emails", "quantos não lidos", "inbox"
  {
    id: 'unread_emails',
    pattern: /^(?:(?:how many )?unread(?: emails?)?|(?:quantos? )?(?:e-?mails? )?não lidos?|check (?:my )?(?:e-?)?mails?|inbox|\/(?:unread|mail|inbox))[\s?!.]*$/i,
    requires: 'email',
    handler: async (_userId, _match, lang) => {
      const c = copyForLang(lang);
      if (!_userId || !isAnyMailConfiguredForUser(_userId)) {
        return { text: c.emailConfigMissing, domain: SECRETARY };
      }
      const summary = await getUnreadMailSummaryForUser(_userId);
      if (summary.totalUnread === 0) {
        return { text: c.inboxClean, domain: SECRETARY };
      }
      // The EN line doesn't need the Portuguese "email/emails" suffix
      // agreement AND the "não lido/não lidos" adjective agreement,
      // but we keep %S% in the template so a single replace handles
      // both languages cleanly.
      const text = c.emailUnreadLine
        .replace('%COUNT%', String(summary.totalUnread))
        .replace(/%S%/g, summary.totalUnread > 1 ? 's' : '');
      return { text, domain: SECRETARY };
    },
  },

  // ── Overdue Tasks ───────────────────────────────────────────────
  // "overdue", "show overdue", "atrasadas", "tarefas atrasadas"
  {
    id: 'overdue_tasks',
    pattern: /^(?:overdue|show overdue|atrasad[ao]s?|tarefas? atrasad[ao]s?|\/overdue)[\s?!.]*$/i,
    requires: 'tasks',
    handler: async (_userId, _match, lang) => {
      const c = copyForLang(lang);
      const taskProvider = getScopedTaskProvider(_userId);
      const result = taskProvider
        ? await taskProvider.getAllPendingTasks().catch(() => ({
            success: false as const,
            data: [],
            error: 'API error',
          }))
        : { success: false as const, data: [], error: 'disabled' };
      if (!result.success) {
        return { text: c.tasksErrorFetch, domain: SECRETARY };
      }

      const overdue = filterOverdue(result.data);
      if (overdue.length === 0) {
        return { text: c.overdueEmpty, domain: SECRETARY };
      }

      const header = overdue.length > 1 ? c.overdueHeaderPlural : c.overdueHeader;
      let msg = `⚠️ <b>${overdue.length} ${header}</b>\n\n`;
      const locale = localeForLang(lang);
      for (const t of overdue.slice(0, 10)) {
        const d = new Date(t.dueDateTime!).toLocaleDateString(locale);
        msg += `▸ ${escapeHtml(t.title)} <i>(${c.overdueDueLabel} ${d})</i>\n`;
      }
      if (overdue.length > 10) msg += `\n... +${overdue.length - 10} ${c.moreTasksSuffix}`;

      return { text: msg.trim(), domain: SECRETARY };
    },
  },

  // ── Set Reminder (parseable without AI) ─────────────────────────
  // "remind me at 15:30 call dentist"
  // "lembra às 15:30 ligar dentista"
  // "avisa 9:00 reunião"
  {
    id: 'set_reminder',
    pattern: /^(?:remind(?:er)?(?:\s+me)?|lembra?(?:\s+me)?|avisa?(?:\s+me)?)(?:\s+(?:at|às|as))?\s+(\d{1,2}[:.]\d{2})\s*[:-]?\s*(.+)$/i,
    requires: 'reminders',
    handler: async (userId, match, lang) => {
      const c = copyForLang(lang);
      const timeStr = match[1].replace('.', ':');
      const message = match[2].trim();
      const [h, m] = timeStr.split(':').map(Number);

      if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        return { text: `${c.reminderInvalidTime} ${timeStr}`, domain: SECRETARY };
      }

      // If the requested time has already passed today, schedule for tomorrow
      let remindAt = now().set({ hour: h, minute: m, second: 0, millisecond: 0 });
      if (remindAt < now()) {
        remindAt = remindAt.plus({ days: 1 });
      }

      try {
        setReminder(userId, { message, remind_at: remindAt.toISO()! });
      } catch (err) {
        logger.warn({ err, userId }, 'fastpath set_reminder DB write failed');
        return { text: c.reminderSavedError, domain: SECRETARY };
      }

      const dayLabel = remindAt.toFormat('dd/MM') === now().toFormat('dd/MM')
        ? c.reminderDayToday
        : c.reminderDayTomorrow;
      return {
        text: `${c.reminderSetPrefix} <b>${timeStr}</b> (${dayLabel}): ${escapeHtml(message)}`,
        domain: SECRETARY,
      };
    },
  },

  // ── Quick Task Add (parseable without AI) ───────────────────────
  // "add task: buy milk"
  // "nova tarefa: comprar leite"
  // "adicionar tarefa comprar leite"
  {
    id: 'quick_add_task',
    pattern: /^(?:add task|nova tarefa|adicionar? tarefa)[:\s]+(.+)$/i,
    requires: 'tasks',
    handler: async (_userId, match, lang) => {
      const c = copyForLang(lang);
      const title = match[1].trim();
      if (!title) {
        return { text: c.taskEmptyTitle, domain: SECRETARY };
      }

      try {
        const taskProvider = getScopedTaskProvider(_userId);
        if (!taskProvider) {
          return { text: c.taskCreateError, domain: SECRETARY };
        }
        const list = await taskProvider.getDefaultList();
        if (!list) {
          return { text: c.taskCreateNoList, domain: SECRETARY };
        }
        const result = await taskProvider.createTask(list.id, list.displayName, { title });
        if (!result.success) {
          return {
            text: `${c.taskCreateErrorDetail} ${result.error || 'unknown'}`,
            domain: SECRETARY,
          };
        }
        return {
          text: `${c.taskCreated} <b>${escapeHtml(list.displayName)}</b>: ${escapeHtml(title)}`,
          domain: SECRETARY,
        };
      } catch (err) {
        logger.warn({ err }, 'fastpath quick_add_task failed');
        return { text: c.taskCreateError, domain: SECRETARY };
      }
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Resolve the language to use for a fastpath response.
 *
 * Priority:
 *   1. Explicit `langOverride` (used by the iOS chat route after it
 *      reads the X-Language header and calls setUserLanguage as a
 *      side effect — the override avoids re-querying the DB in the
 *      hot path).
 *   2. `getUserLanguage(userId)` from the SQLite user row. This
 *      reflects both the Telegram `/language` command preference
 *      AND the iOS X-Language header (because the iOS chat route
 *      writes through to setUserLanguage at the request boundary).
 *   3. Default 'pt-BR' (legacy app default) for anonymous callers
 *      and tests that don't provide a userId.
 *
 * Wrapped in try/catch because `user-service` reads SQLite — if the
 * DB is unavailable we'd rather respond in pt-BR than crash the
 * fastpath.
 */
function resolveLang(userId: number, langOverride?: Lang): Lang {
  if (langOverride) return langOverride;
  if (!userId) return 'pt-BR';
  try {
    return getUserLanguage(userId);
  } catch (err) {
    logger.debug({ err, userId }, 'fastpath: getUserLanguage lookup failed, defaulting to pt-BR');
    return 'pt-BR';
  }
}

/**
 * Try to handle a secretary message via fastpath (zero AI tokens).
 * Returns { matched: false } if the message needs the AI pipeline.
 *
 * Behavior on errors:
 *   - Pattern matches but the handler throws → returns { matched: false }
 *     so the caller falls through to the AI path. The error is logged but
 *     never bubbled up to the user. This means the fastpath is safe to add
 *     in front of any code path: a broken fastpath degrades gracefully to
 *     the existing AI path, never to a hard failure.
 *   - Pattern requires a sub-skill that's disabled → pattern is skipped,
 *     next pattern is tried. Same fall-through to AI if nothing matches.
 *
 * Language handling:
 *   - If `langOverride` is passed (iOS route → X-Language header),
 *     that wins unconditionally.
 *   - Otherwise we read `getUserLanguage(userId)` from the DB, which
 *     is kept in sync by the iOS chat route's setUserLanguage call
 *     and by the Telegram /language command. Telegram users get
 *     their preferred language automatically.
 */
export async function tryFastpath(
  userId: number,
  message: string,
  langOverride?: Lang,
): Promise<FastpathResult> {
  _metrics.totalAttempts++;
  const trimmed = message.trim();
  if (!trimmed) return { matched: false };

  const startedAt = Date.now();
  const lang = resolveLang(userId, langOverride);

  for (const entry of FASTPATH_PATTERNS) {
    const match = trimmed.match(entry.pattern);
    if (!match) continue;

    // Sub-skill gate — skip patterns whose required sub-skill is off
    if (entry.requires && !isSubmoduleEnabled('secretary', entry.requires)) {
      logger.debug({ pattern: entry.id, requires: entry.requires }, 'Fastpath pattern skipped — sub-skill disabled');
      continue;
    }

    try {
      const response = await entry.handler(userId, match, lang);
      const latency = Date.now() - startedAt;
      _metrics.totalHits++;
      _metrics.totalLatencyMs += latency;
      _metrics.hitsByPattern[entry.id] = (_metrics.hitsByPattern[entry.id] || 0) + 1;
      logger.info(
        { userId, pattern: entry.id, lang, latencyMs: latency },
        'Secretary fastpath matched',
      );
      return { matched: true, response, patternId: entry.id };
    } catch (err) {
      logger.warn(
        { err, userId, pattern: entry.id },
        'Fastpath handler failed — falling through to AI',
      );
      return { matched: false };
    }
  }

  return { matched: false };
}

/** Get all registered fastpath pattern IDs (for portal display + tests). */
export function getFastpathPatterns(): string[] {
  return FASTPATH_PATTERNS.map((p) => p.id);
}

/**
 * Normalize an inbound `X-Language` HTTP header value into the
 * internal `Lang` type. The iOS `LanguageRouter` sends "pt-BR",
 * "pt-PT", or "en"; we also accept common aliases defensively. Unknown values
 * fall back to 'pt-BR' (the legacy app default).
 *
 * Exported so the iOS chat route can call it at the request
 * boundary without importing the full i18n layer.
 */
export function normalizeLangHeader(
  header: string | string[] | undefined,
): Lang {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return 'pt-BR';
  const lower = raw.toLowerCase();
  if (lower.startsWith('pt-pt') || lower.startsWith('pt_pt')) return 'pt-PT';
  if (lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('en')) return 'en-US';
  return 'pt-BR';
}
