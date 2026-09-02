// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Chat HTML formatter — shared HTML-block formatting helpers for chat
// responses, scheduler notifications, and fastpath task views. The
// downstream adapter (iOS/WebSocket) converts these HTML blocks into the
// client-facing representation.
//
// History: successor of the legacy messaging-platform formatter module
// (2026-07 purge, Stage A). Only the exports with live callers survived;
// output is byte-identical to the legacy module for those helpers.

import { TodoList, TodoTask } from '../services/microsoft-todo';
import { formatDate } from './date-parser';
import type { Lang } from './i18n';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface BriefingEvent {
  summary: string;
  start: string;
  end: string;
}

export interface BriefingTask {
  title: string;
  listName: string;
  dueDateTime?: string;
  importance: string;
}

export interface DailyBriefingData {
  date: string;
  events: BriefingEvent[];
  training?: string;
  highPriorityTasks: BriefingTask[];
  dueTodayTasks: BriefingTask[];
  overdueTasks: (BriefingTask & { daysLate: number })[];
  overdueExtra?: number; // count of overdue tasks beyond the display cap
  reminders: { message: string; time: string }[];
  unreadEmails: number;
  yesterdayCompleted: number;
  automatedNotifications?: string[];
}

// ─── Microsoft To Do Formatters ─────────────────────────────────────

const IMPORTANCE_EMOJI: Record<string, string> = {
  high: '🔴',
  normal: '🟡',
  low: '🟢',
};

const STATUS_EMOJI: Record<string, string> = {
  notStarted: '⬜',
  inProgress: '🔵',
  completed: '✅',
  waitingOnOthers: '⏳',
  deferred: '⏸',
};

type FormatterLanguage = Lang | string | undefined;

function formatterLocale(language?: FormatterLanguage): 'pt' | 'en' {
  return typeof language === 'string' && language.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

const TODO_COPY = {
  en: {
    noTaskLists: '📋 No task lists found.',
    taskListsHeader: (count: number) => `<b>📋 Your Task Lists (${count})</b>`,
    listEmpty: (listName: string) => `📋 <b>${escapeHtml(listName)}</b> is empty. Use /newtask to add something!`,
    taskListHeader: (listName: string, count: number) => `<b>📋 ${escapeHtml(listName)} (${count} tasks)</b>`,
    duePrefix: 'due',
    overduePrefix: '⚠️ due',
    taskSummary: '<b>📊 Task Summary</b>',
    pendingLabel: '📋 Pending',
    highPriorityLabel: '🔴 High priority',
    dueTodayLabel: '📅 Due today',
    overdueLabel: '⚠️ Overdue',
    overdueSection: '<b>⚠️ Overdue:</b>',
    wasDue: 'was due',
    dueTodaySection: '<b>📅 Due Today:</b>',
    noPendingTasks: '📋 No pending tasks across any list. Nice work!',
    allPendingHeader: (count: number) => `<b>📋 All Pending Tasks (${count})</b>`,
  },
  pt: {
    noTaskLists: '📋 Nenhuma lista de tarefas encontrada.',
    taskListsHeader: (count: number) => `<b>📋 As tuas listas de tarefas (${count})</b>`,
    listEmpty: (listName: string) => `📋 <b>${escapeHtml(listName)}</b> está vazia. Usa /newtask para adicionar algo!`,
    taskListHeader: (listName: string, count: number) => `<b>📋 ${escapeHtml(listName)} (${count} tarefas)</b>`,
    duePrefix: 'vence',
    overduePrefix: '⚠️ venceu',
    taskSummary: '<b>📊 Resumo das tarefas</b>',
    pendingLabel: '📋 Pendentes',
    highPriorityLabel: '🔴 Alta prioridade',
    dueTodayLabel: '📅 Para hoje',
    overdueLabel: '⚠️ Atrasadas',
    overdueSection: '<b>⚠️ Atrasadas:</b>',
    wasDue: 'estava prevista para',
    dueTodaySection: '<b>📅 Para hoje:</b>',
    noPendingTasks: '📋 Não há tarefas pendentes em nenhuma lista. Bom trabalho!',
    allPendingHeader: (count: number) => `<b>📋 Todas as tarefas pendentes (${count})</b>`,
  },
} as const;

function todoCopy(language?: FormatterLanguage) {
  return TODO_COPY[formatterLocale(language)];
}

export function formatMsTodoLists(lists: TodoList[], language?: FormatterLanguage): string {
  const copy = todoCopy(language);
  if (lists.length === 0) return copy.noTaskLists;

  let msg = `${copy.taskListsHeader(lists.length)}\n\n`;
  for (const list of lists) {
    const shared = list.isShared ? ' 👥' : '';
    msg += `• ${escapeHtml(list.displayName)}${shared}\n`;
  }
  return msg.trim();
}

export function formatMsTodoTasks(tasks: TodoTask[], listName: string, language?: FormatterLanguage): string {
  const copy = todoCopy(language);
  if (tasks.length === 0) return copy.listEmpty(listName);

  let msg = `${copy.taskListHeader(listName, tasks.length)}\n\n`;

  for (const task of tasks) {
    const status = STATUS_EMOJI[task.status] || '⬜';
    const imp = task.importance !== 'normal' ? ` ${IMPORTANCE_EMOJI[task.importance] || ''}` : '';
    msg += `${status}${imp} ${escapeHtml(task.title)}`;
    if (task.dueDateTime) {
      const isOverdue = task.status !== 'completed' && new Date(task.dueDateTime) < new Date();
      msg += isOverdue
        ? ` ${copy.overduePrefix} ${formatDate(task.dueDateTime)}`
        : ` — ${copy.duePrefix} ${formatDate(task.dueDateTime)}`;
    }
    msg += '\n';
  }

  return msg.trim();
}

export function formatMsTodoSummary(data: {
  pendingCount: number;
  overdueCount: number;
  dueTodayCount: number;
  highPriorityCount: number;
  overdueTasks: TodoTask[];
  dueTodayTasks: TodoTask[];
}, language?: FormatterLanguage): string {
  const copy = todoCopy(language);
  let msg = `${copy.taskSummary}\n\n`;
  msg += `${copy.pendingLabel}: ${data.pendingCount}\n`;
  msg += `${copy.highPriorityLabel}: ${data.highPriorityCount}\n`;
  msg += `${copy.dueTodayLabel}: ${data.dueTodayCount}\n`;
  msg += `${copy.overdueLabel}: ${data.overdueCount}\n`;

  if (data.overdueTasks.length > 0) {
    msg += `\n${copy.overdueSection}\n`;
    for (const t of data.overdueTasks.slice(0, 5)) {
      msg += `- ${escapeHtml(t.title)} (${copy.wasDue}: ${formatDate(t.dueDateTime!)}) [${escapeHtml(t.listName)}]\n`;
    }
  }

  if (data.dueTodayTasks.length > 0) {
    msg += `\n${copy.dueTodaySection}\n`;
    for (const t of data.dueTodayTasks) {
      msg += `- ${escapeHtml(t.title)} [${escapeHtml(t.listName)}]\n`;
    }
  }

  return msg.trim();
}

export function splitMessage(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }

    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return parts;
}

export function formatAllTasks(tasks: TodoTask[], language?: FormatterLanguage): string {
  const copy = todoCopy(language);
  if (tasks.length === 0) return copy.noPendingTasks;

  // Group by list name
  const grouped: Record<string, TodoTask[]> = {};
  for (const task of tasks) {
    if (!grouped[task.listName]) grouped[task.listName] = [];
    grouped[task.listName].push(task);
  }

  let msg = `${copy.allPendingHeader(tasks.length)}\n`;

  for (const [listName, listTasks] of Object.entries(grouped)) {
    msg += `\n<b>${escapeHtml(listName)}</b> (${listTasks.length})\n`;
    for (const task of listTasks) {
      const imp = task.importance !== 'normal' ? ` ${IMPORTANCE_EMOJI[task.importance] || ''}` : '';
      msg += `${STATUS_EMOJI[task.status] || '⬜'}${imp} ${escapeHtml(task.title)}`;
      if (task.dueDateTime) {
        const isOverdue = task.status !== 'completed' && new Date(task.dueDateTime) < new Date();
        msg += isOverdue
          ? ` ${copy.overduePrefix} ${formatDate(task.dueDateTime)}`
          : ` — ${copy.duePrefix} ${formatDate(task.dueDateTime)}`;
      }
      msg += '\n';
    }
  }

  return msg.trim();
}
