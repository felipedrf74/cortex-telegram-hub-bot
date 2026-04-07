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

import { getEvents, isAnyCalendarConfigured } from './unified-calendar';
import {
  isOutlookTodoConfigured,
  getAllPendingTasks,
  getDefaultList,
  createTask,
  type TodoTask,
} from './microsoft-todo';
import { getUnreadCount, isOutlookMailConfigured } from './outlook-mail';
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
  /** Returns the formatted response. May throw — caller catches and falls through to AI. */
  handler: (userId: number, match: RegExpMatchArray) => Promise<DomainResponse>;
  /** Optional sub-skill the pattern depends on. If disabled, the pattern is skipped. */
  requires?: 'tasks' | 'calendar' | 'email' | 'reminders';
}

// ─── Helpers ────────────────────────────────────────────────────────

const SECRETARY: DomainName = 'secretary';

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
    pattern: /^(?:what(?:'s| is) my day|(?:o que|como)(?: está| é)?(?: o)? meu dia|(?:show|mostra) (?:my |meu |o )?(?:day|dia)|\/day|today|hoje|o que tenho hoje|qual(?:'s)? minha agenda(?: hoje)?)[\s?!.]*$/i,
    handler: async (userId) => {
      const tasksOk = isSubmoduleEnabled('secretary', 'tasks');
      const calOk = isSubmoduleEnabled('secretary', 'calendar');
      const emailOk = isSubmoduleEnabled('secretary', 'email');
      const remOk = isSubmoduleEnabled('secretary', 'reminders');

      const [events, todoResult, reminders] = await Promise.all([
        calOk && isAnyCalendarConfigured()
          ? getEvents(startOfDay(), endOfDay()).catch(() => [])
          : Promise.resolve([]),
        tasksOk && isOutlookTodoConfigured()
          ? getAllPendingTasks().catch(() => ({ success: false as const, data: [], error: 'API error' }))
          : Promise.resolve({ success: false as const, data: [], error: 'disabled' }),
        remOk ? Promise.resolve(getRemindersForToday(userId)) : Promise.resolve([]),
      ]);

      const todayStr = now().toFormat('cccc, dd LLLL yyyy');
      let msg = `📅 <b>${todayStr}</b>\n\n`;

      // Calendar events block
      if (events.length > 0) {
        msg += `📋 <b>AGENDA:</b>\n`;
        for (const e of events) {
          msg += `▸ ${formatTime(e.start)}–${formatTime(e.end)}  ${escapeHtml(e.summary)}\n`;
        }
      } else if (calOk && isAnyCalendarConfigured()) {
        msg += `📋 <b>AGENDA:</b> Sem eventos hoje\n`;
      }

      // Tasks block
      if (todoResult.success && todoResult.data.length > 0) {
        const tasks = todoResult.data;
        const overdue = filterOverdue(tasks);
        const dueToday = filterDueToday(tasks);

        msg += `\n📌 <b>TAREFAS:</b> ${tasks.length} pendentes`;
        if (overdue.length > 0) msg += ` | ⚠️ ${overdue.length} atrasadas`;
        if (dueToday.length > 0) {
          msg += `\n<b>Para hoje:</b>\n`;
          for (const t of dueToday.slice(0, 5)) {
            msg += `▸ ${escapeHtml(t.title)}\n`;
          }
        } else {
          msg += `\n`;
        }
      }

      // Reminders block
      if (reminders.length > 0) {
        msg += `\n⏰ <b>LEMBRETES:</b>\n`;
        for (const r of reminders.slice(0, 5)) {
          msg += `▸ ${formatTime(r.remind_at)} ${escapeHtml(r.message)}\n`;
        }
      }

      // Unread emails (best-effort, non-fatal)
      if (emailOk && isOutlookMailConfigured()) {
        try {
          const unread = await getUnreadCount();
          if (unread && unread > 0) msg += `\n📧 <b>E-MAILS:</b> ${unread} não lidos\n`;
        } catch { /* silent */ }
      }

      return { text: msg.trim(), domain: SECRETARY };
    },
  },

  // ── Week Overview ───────────────────────────────────────────────
  // "what's my week", "show my week", "/week", "esta semana", "minha semana"
  {
    id: 'week_overview',
    pattern: /^(?:what(?:'s| is) my week|(?:show|mostra) (?:my |a |minha )?(?:week|semana)|(?:como|o que)(?: está)? (?:a |minha )?semana|\/week|this week|esta semana)[\s?!.]*$/i,
    requires: 'calendar',
    handler: async (_userId) => {
      const events = isAnyCalendarConfigured()
        ? await getEvents(startOfWeek(), endOfWeek()).catch(() => [])
        : [];

      const dayNames = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
      let msg = `📅 <b>SEMANA</b>\n\n`;

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
        const dayLabel = dayNames[i];
        const dateLabel = d.toFormat('dd/MM');

        if (dayEvents.length > 0) {
          msg += `<b>${dayLabel} ${dateLabel}</b>\n`;
          for (const e of dayEvents) {
            msg += `  ▸ ${formatTime(e.start)} ${escapeHtml(e.summary)}\n`;
          }
        } else {
          msg += `<b>${dayLabel} ${dateLabel}</b> — livre\n`;
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
    handler: async (_userId) => {
      const result = await getAllPendingTasks().catch(() => ({
        success: false as const,
        data: [],
        error: 'API error',
      }));

      if (!result.success) {
        return { text: '⚠️ Erro ao buscar tarefas. Tente novamente em instantes.', domain: SECRETARY };
      }
      if (result.data.length === 0) {
        return { text: '✅ Sem tarefas pendentes!', domain: SECRETARY };
      }

      let msg = `📋 <b>Tarefas Pendentes</b> (${result.data.length})\n\n`;
      const byList = new Map<string, TodoTask[]>();
      for (const t of result.data) {
        if (!byList.has(t.listName)) byList.set(t.listName, []);
        byList.get(t.listName)!.push(t);
      }

      for (const [listName, tasks] of byList) {
        msg += `<b>${escapeHtml(listName)}</b> (${tasks.length})\n`;
        for (const t of tasks.slice(0, 10)) {
          const dueLabel = t.dueDateTime
            ? ` 📅 ${new Date(t.dueDateTime).toLocaleDateString('pt-BR')}`
            : '';
          msg += `  ▸ ${escapeHtml(t.title)}${dueLabel}\n`;
        }
        if (tasks.length > 10) msg += `  ... +${tasks.length - 10} mais\n`;
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
    handler: async (_userId) => {
      if (!isOutlookMailConfigured()) {
        return {
          text: '⚠️ Email não configurado. Use /connect outlook para vincular.',
          domain: SECRETARY,
        };
      }
      const count = await getUnreadCount();
      const msg = count > 0
        ? `📧 Você tem <b>${count}</b> e-mail${count > 1 ? 's' : ''} não lido${count > 1 ? 's' : ''}.`
        : `📧 Caixa de entrada limpa! ✨`;
      return { text: msg, domain: SECRETARY };
    },
  },

  // ── Overdue Tasks ───────────────────────────────────────────────
  // "overdue", "show overdue", "atrasadas", "tarefas atrasadas"
  {
    id: 'overdue_tasks',
    pattern: /^(?:overdue|show overdue|atrasad[ao]s?|tarefas? atrasad[ao]s?|\/overdue)[\s?!.]*$/i,
    requires: 'tasks',
    handler: async (_userId) => {
      const result = await getAllPendingTasks().catch(() => ({
        success: false as const,
        data: [],
        error: 'API error',
      }));
      if (!result.success) {
        return { text: '⚠️ Erro ao buscar tarefas.', domain: SECRETARY };
      }

      const overdue = filterOverdue(result.data);
      if (overdue.length === 0) {
        return { text: '✅ Nenhuma tarefa atrasada!', domain: SECRETARY };
      }

      let msg = `⚠️ <b>${overdue.length} Tarefa${overdue.length > 1 ? 's' : ''} Atrasada${overdue.length > 1 ? 's' : ''}</b>\n\n`;
      for (const t of overdue.slice(0, 10)) {
        const d = new Date(t.dueDateTime!).toLocaleDateString('pt-BR');
        msg += `▸ ${escapeHtml(t.title)} <i>(prazo: ${d})</i>\n`;
      }
      if (overdue.length > 10) msg += `\n... +${overdue.length - 10} mais`;

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
    handler: async (userId, match) => {
      const timeStr = match[1].replace('.', ':');
      const message = match[2].trim();
      const [h, m] = timeStr.split(':').map(Number);

      if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        return { text: `❌ Horário inválido: ${timeStr}`, domain: SECRETARY };
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
        return { text: '⚠️ Erro ao salvar lembrete.', domain: SECRETARY };
      }

      const dayLabel = remindAt.toFormat('dd/MM') === now().toFormat('dd/MM') ? 'hoje' : 'amanhã';
      return {
        text: `⏰ Lembrete definido para <b>${timeStr}</b> (${dayLabel}): ${escapeHtml(message)}`,
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
    handler: async (_userId, match) => {
      const title = match[1].trim();
      if (!title) {
        return { text: '❌ Título da tarefa não pode estar vazio.', domain: SECRETARY };
      }

      try {
        const list = await getDefaultList();
        if (!list) {
          return {
            text: '⚠️ Lista padrão do Microsoft To Do não encontrada. Configure em /settings.',
            domain: SECRETARY,
          };
        }
        const result = await createTask(list.id, list.displayName, { title });
        if (!result.success) {
          return {
            text: `⚠️ Erro ao criar tarefa: ${result.error || 'desconhecido'}`,
            domain: SECRETARY,
          };
        }
        return {
          text: `✅ Tarefa criada em <b>${escapeHtml(list.displayName)}</b>: ${escapeHtml(title)}`,
          domain: SECRETARY,
        };
      } catch (err) {
        logger.warn({ err }, 'fastpath quick_add_task failed');
        return { text: `⚠️ Erro ao criar tarefa. Tente novamente.`, domain: SECRETARY };
      }
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────

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
 */
export async function tryFastpath(userId: number, message: string): Promise<FastpathResult> {
  _metrics.totalAttempts++;
  const trimmed = message.trim();
  if (!trimmed) return { matched: false };

  const startedAt = Date.now();

  for (const entry of FASTPATH_PATTERNS) {
    const match = trimmed.match(entry.pattern);
    if (!match) continue;

    // Sub-skill gate — skip patterns whose required sub-skill is off
    if (entry.requires && !isSubmoduleEnabled('secretary', entry.requires)) {
      logger.debug({ pattern: entry.id, requires: entry.requires }, 'Fastpath pattern skipped — sub-skill disabled');
      continue;
    }

    try {
      const response = await entry.handler(userId, match);
      const latency = Date.now() - startedAt;
      _metrics.totalHits++;
      _metrics.totalLatencyMs += latency;
      _metrics.hitsByPattern[entry.id] = (_metrics.hitsByPattern[entry.id] || 0) + 1;
      logger.info(
        { userId, pattern: entry.id, latencyMs: latency },
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
