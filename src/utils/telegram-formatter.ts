// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Todo, Note, Reminder } from '../domains/types';
import { TodoList, TodoTask, ChecklistItem } from '../services/microsoft-todo';
import { formatDate, formatDateTime, formatTime } from './date-parser';
import type { Lang } from './i18n';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const PRIORITY_EMOJI: Record<string, string> = {
  urgent: '🔴',
  high: '🔴',
  medium: '🟡',
  low: '🟢',
};

export function formatTodos(todos: Todo[]): string {
  if (todos.length === 0) return '📋 No pending to-dos. Nice work!';

  const grouped: Record<string, Todo[]> = {};
  for (const todo of todos) {
    const p = todo.priority || 'medium';
    if (!grouped[p]) grouped[p] = [];
    grouped[p].push(todo);
  }

  let msg = `<b>📋 Your To-Do List (${todos.length} items)</b>\n\n`;
  const order = ['urgent', 'high', 'medium', 'low'];

  for (const priority of order) {
    const items = grouped[priority];
    if (!items?.length) continue;
    msg += `${PRIORITY_EMOJI[priority]} <b>${priority.toUpperCase()}</b>\n`;
    for (const item of items) {
      msg += `${item.id}. ${escapeHtml(item.title)}`;
      if (item.due_date) msg += ` — due ${formatDate(item.due_date)}`;
      msg += ` <i>[${item.domain}]</i>\n`;
    }
    msg += '\n';
  }

  return msg.trim();
}

export function formatTodoCreated(todo: Todo): string {
  let msg = `✅ To-do created: "<b>${escapeHtml(todo.title)}</b>"\n`;
  msg += `     Domain: ${todo.domain} | Priority: ${todo.priority}`;
  if (todo.due_date) msg += ` | Due: ${formatDate(todo.due_date)}`;
  else msg += ' | No due date';
  return msg;
}

export function formatReminders(reminders: Reminder[]): string {
  if (reminders.length === 0) return '⏰ No active reminders.';

  let msg = '<b>⏰ Active Reminders</b>\n\n';
  for (const r of reminders) {
    msg += `${r.id}. ${escapeHtml(r.message)} — ${formatDateTime(r.remind_at)}`;
    if (r.recurring) msg += ` (${r.recurring})`;
    msg += '\n';
  }
  return msg.trim();
}

export function formatNotes(notes: Note[]): string {
  if (notes.length === 0) return '📝 No notes found.';

  let msg = '<b>📝 Notes</b>\n\n';
  for (const n of notes) {
    msg += `${n.id}. ${escapeHtml(n.content)}`;
    if (n.tags) msg += ` <i>[${n.tags}]</i>`;
    msg += ` — ${formatDate(n.created_at)}\n`;
  }
  return msg.trim();
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
  automatedNotifications?: string[]; // e.g. fossa email, other scheduled emails
}

export function formatDailyBriefing(
  data: DailyBriefingData,
  language?: FormatterLanguage,
  recipientDisplayName?: string,
): string {
  const copy = todoCopy(language);
  // Identity-safety: NEVER substitute a hardcoded founder/owner name. Greet
  // by the authenticated recipient's saved display name, or fall back to a
  // name-less greeting. The caller is responsible for resolving the name
  // from the authenticated user/tenant scope.
  const trimmedName = typeof recipientDisplayName === 'string' ? recipientDisplayName.trim() : '';
  let msg = `${copy.goodMorning(trimmedName)} <b>${data.date}</b>\n`;

  // ── Schedule ──
  if (data.events.length > 0) {
    msg += `\n${copy.schedule} (${data.events.length})\n`;
    for (const e of data.events) {
      msg += `  ${formatTime(e.start)} – ${formatTime(e.end)}  ${escapeHtml(e.summary)}\n`;
    }
  } else {
    msg += `\n${copy.noEventsToday}\n`;
  }

  // ── Training ──
  if (data.training) msg += `🏋️ ${escapeHtml(data.training)}\n`;

  // ── Tasks summary (only today-relevant: due today + overdue + high priority) ──
  const totalOverdue = data.overdueTasks.length + (data.overdueExtra || 0);
  const todayTaskCount = data.dueTodayTasks.length + totalOverdue;

  if (todayTaskCount > 0 || data.highPriorityTasks.length > 0) {
    const parts: string[] = [];
    if (data.dueTodayTasks.length > 0) parts.push(copy.dueTodayCount(data.dueTodayTasks.length));
    if (totalOverdue > 0) parts.push(copy.overdueCount(totalOverdue));
    if (data.highPriorityTasks.length > 0) parts.push(copy.highPriorityCount(data.highPriorityTasks.length));
    msg += `\n${copy.tasksLabel} ${parts.join('  ·  ')}`;
  } else {
    msg += `\n${copy.noTasksDueToday}`;
  }
  if (data.yesterdayCompleted > 0) msg += `  ·  ${copy.doneYesterday(data.yesterdayCompleted)}`;
  msg += '\n';

  // ── High priority ──
  if (data.highPriorityTasks.length > 0) {
    msg += `\n${copy.highPriority}\n`;
    for (const t of data.highPriorityTasks) {
      msg += `  • ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
  }

  // ── Due today ──
  if (data.dueTodayTasks.length > 0) {
    msg += `\n${copy.dueToday}\n`;
    for (const t of data.dueTodayTasks) {
      msg += `  • ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
  }

  // ── Overdue (capped, with days late) ──
  if (data.overdueTasks.length > 0) {
    msg += `\n${copy.overdue(totalOverdue)}\n`;
    for (const t of data.overdueTasks) {
      msg += `  • ${escapeHtml(t.title)} — ${copy.daysLate(t.daysLate)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
    if (data.overdueExtra) {
      msg += `  <i>${copy.andMore(data.overdueExtra)}</i>\n`;
    }
  }

  // ── Reminders ──
  if (data.reminders.length > 0) {
    msg += `\n${copy.reminders}\n`;
    for (const r of data.reminders) {
      msg += `  • ${escapeHtml(r.message)} ${copy.reminderAt} ${r.time}\n`;
    }
  }

  // ── Email ──
  if (data.unreadEmails < 0) {
    msg += `\n${copy.couldNotCheckEmails}\n`;
  } else if (data.unreadEmails > 0) {
    msg += `\n${copy.unreadEmails(data.unreadEmails)}\n`;
  }

  // ── Automated notifications (fossa email, etc.) ──
  if (data.automatedNotifications && data.automatedNotifications.length > 0) {
    msg += `\n🤖 <b>Automações de hoje</b>\n`;
    for (const n of data.automatedNotifications) {
      msg += `  ${escapeHtml(n)}\n`;
    }
  }

  // ── Quick actions ──
  msg += `\n/todos · /done · /day`;
  return msg;
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
    goodMorning: (name?: string) => (name ? `☀️ Good morning, ${escapeHtml(name)}!` : '☀️ Good morning!'),
    schedule: '📅 <b>Schedule</b>',
    noEventsToday: '📅 No events today — open schedule!',
    tasksLabel: '📋 <b>Tasks:</b>',
    dueTodayCount: (count: number) => `${count} due today`,
    overdueCount: (count: number) => `${count} overdue`,
    highPriorityCount: (count: number) => `${count} high priority`,
    noTasksDueToday: '📋 No tasks due today',
    doneYesterday: (count: number) => `✅ ${count} done yesterday`,
    highPriority: '🔴 <b>High priority</b>',
    dueToday: '📌 <b>Due today</b>',
    overdue: (count: number) => `⚠️ <b>Overdue</b> (${count})`,
    daysLate: (daysLate: number) => `${daysLate}d late`,
    andMore: (count: number) => `...and ${count} more`,
    reminders: '⏰ <b>Reminders</b>',
    reminderAt: 'at',
    couldNotCheckEmails: '📧 ⚠️ Could not check emails',
    unreadEmails: (count: number) => `📧 ${count} unread emails`,
    noTaskLists: '📋 No task lists found.',
    taskListsHeader: (count: number) => `<b>📋 Your Task Lists (${count})</b>`,
    listEmpty: (listName: string) => `📋 <b>${escapeHtml(listName)}</b> is empty. Use /newtask to add something!`,
    taskListHeader: (listName: string, count: number) => `<b>📋 ${escapeHtml(listName)} (${count} tasks)</b>`,
    duePrefix: 'due',
    overduePrefix: '⚠️ due',
    taskCreated: (title: string) => `✅ Task created: "<b>${escapeHtml(title)}</b>"`,
    listLabel: 'List',
    importanceLabel: 'Importance',
    dueLabel: 'Due',
    noDueDate: 'No due date',
    reminderLabel: 'Reminder',
    taskSummary: '<b>📊 Task Summary</b>',
    pendingLabel: '📋 Pending',
    highPriorityLabel: '🔴 High priority',
    dueTodayLabel: '📅 Due today',
    overdueLabel: '⚠️ Overdue',
    overdueSection: '<b>⚠️ Overdue:</b>',
    wasDue: 'was due',
    dueTodaySection: '<b>📅 Due Today:</b>',
    checklistEmpty: (taskTitle: string) => `📝 <b>${escapeHtml(taskTitle)}</b> has no checklist items.`,
    checklistHeader: (taskTitle: string, count: number) => `<b>📝 Checklist: ${escapeHtml(taskTitle)} (${count} steps)</b>`,
    noPendingTasks: '📋 No pending tasks across any list. Nice work!',
    allPendingHeader: (count: number) => `<b>📋 All Pending Tasks (${count})</b>`,
    completedEmpty: (listName?: string) => listName
      ? `✅ No recently completed tasks in <b>${escapeHtml(listName)}</b>.`
      : '✅ No recently completed tasks.',
    completedHeader: (count: number, listName?: string) => listName
      ? `<b>✅ Completed: ${escapeHtml(listName)} (${count})</b>`
      : `<b>✅ Recently Completed (${count})</b>`,
  },
  pt: {
    goodMorning: (name?: string) => (name ? `☀️ Bom dia, ${escapeHtml(name)}!` : '☀️ Bom dia!'),
    schedule: '📅 <b>Agenda</b>',
    noEventsToday: '📅 Sem eventos hoje — agenda aberta!',
    tasksLabel: '📋 <b>Tarefas:</b>',
    dueTodayCount: (count: number) => `${count} para hoje`,
    overdueCount: (count: number) => `${count} atrasadas`,
    highPriorityCount: (count: number) => `${count} prioritárias`,
    noTasksDueToday: '📋 Sem tarefas para hoje',
    doneYesterday: (count: number) => `✅ ${count} concluídas ontem`,
    highPriority: '🔴 <b>Alta prioridade</b>',
    dueToday: '📌 <b>Para hoje</b>',
    overdue: (count: number) => `⚠️ <b>Atrasadas</b> (${count})`,
    daysLate: (daysLate: number) => `${daysLate} d de atraso`,
    andMore: (count: number) => `...e mais ${count}`,
    reminders: '⏰ <b>Lembretes</b>',
    reminderAt: 'às',
    couldNotCheckEmails: '📧 ⚠️ Não foi possível verificar os emails',
    unreadEmails: (count: number) => `📧 ${count} emails não lidos`,
    noTaskLists: '📋 Nenhuma lista de tarefas encontrada.',
    taskListsHeader: (count: number) => `<b>📋 As tuas listas de tarefas (${count})</b>`,
    listEmpty: (listName: string) => `📋 <b>${escapeHtml(listName)}</b> está vazia. Usa /newtask para adicionar algo!`,
    taskListHeader: (listName: string, count: number) => `<b>📋 ${escapeHtml(listName)} (${count} tarefas)</b>`,
    duePrefix: 'vence',
    overduePrefix: '⚠️ venceu',
    taskCreated: (title: string) => `✅ Tarefa criada: "<b>${escapeHtml(title)}</b>"`,
    listLabel: 'Lista',
    importanceLabel: 'Prioridade',
    dueLabel: 'Prazo',
    noDueDate: 'Sem prazo',
    reminderLabel: 'Lembrete',
    taskSummary: '<b>📊 Resumo das tarefas</b>',
    pendingLabel: '📋 Pendentes',
    highPriorityLabel: '🔴 Alta prioridade',
    dueTodayLabel: '📅 Para hoje',
    overdueLabel: '⚠️ Atrasadas',
    overdueSection: '<b>⚠️ Atrasadas:</b>',
    wasDue: 'estava prevista para',
    dueTodaySection: '<b>📅 Para hoje:</b>',
    checklistEmpty: (taskTitle: string) => `📝 <b>${escapeHtml(taskTitle)}</b> não tem itens na checklist.`,
    checklistHeader: (taskTitle: string, count: number) => `<b>📝 Checklist: ${escapeHtml(taskTitle)} (${count} passos)</b>`,
    noPendingTasks: '📋 Não há tarefas pendentes em nenhuma lista. Bom trabalho!',
    allPendingHeader: (count: number) => `<b>📋 Todas as tarefas pendentes (${count})</b>`,
    completedEmpty: (listName?: string) => listName
      ? `✅ Sem tarefas concluídas recentemente em <b>${escapeHtml(listName)}</b>.`
      : '✅ Sem tarefas concluídas recentemente.',
    completedHeader: (count: number, listName?: string) => listName
      ? `<b>✅ Concluídas: ${escapeHtml(listName)} (${count})</b>`
      : `<b>✅ Concluídas recentemente (${count})</b>`,
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

export function formatMsTodoTaskCreated(task: TodoTask, language?: FormatterLanguage): string {
  const copy = todoCopy(language);
  let msg = `${copy.taskCreated(task.title)}\n`;
  msg += `     ${copy.listLabel}: ${escapeHtml(task.listName)} | ${copy.importanceLabel}: ${task.importance}`;
  if (task.dueDateTime) msg += ` | ${copy.dueLabel}: ${formatDateTime(task.dueDateTime)}`;
  else msg += ` | ${copy.noDueDate}`;
  if (task.isReminderOn && task.reminderDateTime) msg += `\n     ${copy.reminderLabel}: ${formatDateTime(task.reminderDateTime)}`;
  return msg;
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

// ─── Extended To Do Formatters ─────────────────────────────────────

export function formatChecklistItems(items: ChecklistItem[], taskTitle: string, language?: FormatterLanguage): string {
  const copy = todoCopy(language);
  if (items.length === 0) return copy.checklistEmpty(taskTitle);

  let msg = `${copy.checklistHeader(taskTitle, items.length)}\n\n`;
  for (const item of items) {
    const check = item.isChecked ? '☑️' : '⬜';
    msg += `${check} ${escapeHtml(item.displayName)}\n`;
  }
  return msg.trim();
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

export function formatCompletedTasks(tasks: TodoTask[], listName?: string, language?: FormatterLanguage): string {
  const copy = todoCopy(language);
  if (tasks.length === 0) return copy.completedEmpty(listName);

  const header = copy.completedHeader(tasks.length, listName);

  let msg = `${header}\n\n`;
  for (const task of tasks) {
    msg += `✅ ${escapeHtml(task.title)}`;
    if (task.completedDateTime) msg += ` — ${formatDate(task.completedDateTime)}`;
    if (!listName) msg += ` <i>[${escapeHtml(task.listName)}]</i>`;
    msg += '\n';
  }

  return msg.trim();
}
