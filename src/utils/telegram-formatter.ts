import { Todo, Note, Reminder } from '../domains/types';
import { TodoList, TodoTask, ChecklistItem } from '../services/microsoft-todo';
import { formatDate, formatDateTime, formatTime } from './date-parser';

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
}

export function formatDailyBriefing(data: DailyBriefingData): string {
  let msg = `☀️ Good morning, Felipe! <b>${data.date}</b>\n`;

  // ── Schedule ──
  if (data.events.length > 0) {
    msg += `\n📅 <b>Schedule</b> (${data.events.length})\n`;
    for (const e of data.events) {
      msg += `  ${formatTime(e.start)} – ${formatTime(e.end)}  ${escapeHtml(e.summary)}\n`;
    }
  } else {
    msg += `\n📅 No events today — open schedule!\n`;
  }

  // ── Training ──
  if (data.training) msg += `🏋️ ${escapeHtml(data.training)}\n`;

  // ── Tasks summary (only today-relevant: due today + overdue + high priority) ──
  const totalOverdue = data.overdueTasks.length + (data.overdueExtra || 0);
  const todayTaskCount = data.dueTodayTasks.length + totalOverdue;

  if (todayTaskCount > 0 || data.highPriorityTasks.length > 0) {
    const parts: string[] = [];
    if (data.dueTodayTasks.length > 0) parts.push(`${data.dueTodayTasks.length} due today`);
    if (totalOverdue > 0) parts.push(`${totalOverdue} overdue`);
    if (data.highPriorityTasks.length > 0) parts.push(`${data.highPriorityTasks.length} high priority`);
    msg += `\n📋 <b>Tasks:</b> ${parts.join('  ·  ')}`;
  } else {
    msg += `\n📋 No tasks due today`;
  }
  if (data.yesterdayCompleted > 0) msg += `  ·  ✅ ${data.yesterdayCompleted} done yesterday`;
  msg += '\n';

  // ── High priority ──
  if (data.highPriorityTasks.length > 0) {
    msg += `\n🔴 <b>High priority</b>\n`;
    for (const t of data.highPriorityTasks) {
      msg += `  • ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
  }

  // ── Due today ──
  if (data.dueTodayTasks.length > 0) {
    msg += `\n📌 <b>Due today</b>\n`;
    for (const t of data.dueTodayTasks) {
      msg += `  • ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
  }

  // ── Overdue (capped, with days late) ──
  if (data.overdueTasks.length > 0) {
    msg += `\n⚠️ <b>Overdue</b> (${totalOverdue})\n`;
    for (const t of data.overdueTasks) {
      msg += `  • ${escapeHtml(t.title)} — ${t.daysLate}d late <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
    if (data.overdueExtra) {
      msg += `  <i>...and ${data.overdueExtra} more</i>\n`;
    }
  }

  // ── Reminders ──
  if (data.reminders.length > 0) {
    msg += `\n⏰ <b>Reminders</b>\n`;
    for (const r of data.reminders) {
      msg += `  • ${escapeHtml(r.message)} at ${r.time}\n`;
    }
  }

  // ── Email ──
  if (data.unreadEmails < 0) {
    msg += `\n📧 ⚠️ Could not check emails\n`;
  } else if (data.unreadEmails > 0) {
    msg += `\n📧 ${data.unreadEmails} unread emails\n`;
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

export function formatMsTodoLists(lists: TodoList[]): string {
  if (lists.length === 0) return '📋 No task lists found.';

  let msg = `<b>📋 Your Task Lists (${lists.length})</b>\n\n`;
  for (const list of lists) {
    const shared = list.isShared ? ' 👥' : '';
    msg += `• ${escapeHtml(list.displayName)}${shared}\n`;
  }
  return msg.trim();
}

export function formatMsTodoTasks(tasks: TodoTask[], listName: string): string {
  if (tasks.length === 0) return `📋 <b>${escapeHtml(listName)}</b> is empty. Use /newtask to add something!`;

  let msg = `<b>📋 ${escapeHtml(listName)} (${tasks.length} tasks)</b>\n\n`;

  for (const task of tasks) {
    const status = STATUS_EMOJI[task.status] || '⬜';
    const imp = task.importance !== 'normal' ? ` ${IMPORTANCE_EMOJI[task.importance] || ''}` : '';
    msg += `${status}${imp} ${escapeHtml(task.title)}`;
    if (task.dueDateTime) {
      const isOverdue = task.status !== 'completed' && new Date(task.dueDateTime) < new Date();
      msg += isOverdue ? ` ⚠️ due ${formatDate(task.dueDateTime)}` : ` — due ${formatDate(task.dueDateTime)}`;
    }
    msg += '\n';
  }

  return msg.trim();
}

export function formatMsTodoTaskCreated(task: TodoTask): string {
  let msg = `✅ Task created: "<b>${escapeHtml(task.title)}</b>"\n`;
  msg += `     List: ${escapeHtml(task.listName)} | Importance: ${task.importance}`;
  if (task.dueDateTime) msg += ` | Due: ${formatDateTime(task.dueDateTime)}`;
  if (task.isReminderOn && task.reminderDateTime) msg += `\n     Reminder: ${formatDateTime(task.reminderDateTime)}`;
  return msg;
}

export function formatMsTodoSummary(data: {
  pendingCount: number;
  overdueCount: number;
  dueTodayCount: number;
  highPriorityCount: number;
  overdueTasks: TodoTask[];
  dueTodayTasks: TodoTask[];
}): string {
  let msg = '<b>📊 Task Summary</b>\n\n';
  msg += `📋 Pending: ${data.pendingCount}\n`;
  msg += `🔴 High priority: ${data.highPriorityCount}\n`;
  msg += `📅 Due today: ${data.dueTodayCount}\n`;
  msg += `⚠️ Overdue: ${data.overdueCount}\n`;

  if (data.overdueTasks.length > 0) {
    msg += '\n<b>⚠️ Overdue:</b>\n';
    for (const t of data.overdueTasks.slice(0, 5)) {
      msg += `- ${escapeHtml(t.title)} (was due: ${formatDate(t.dueDateTime!)}) [${escapeHtml(t.listName)}]\n`;
    }
  }

  if (data.dueTodayTasks.length > 0) {
    msg += '\n<b>📅 Due Today:</b>\n';
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

export function formatChecklistItems(items: ChecklistItem[], taskTitle: string): string {
  if (items.length === 0) return `📝 <b>${escapeHtml(taskTitle)}</b> has no checklist items.`;

  let msg = `<b>📝 Checklist: ${escapeHtml(taskTitle)} (${items.length} steps)</b>\n\n`;
  for (const item of items) {
    const check = item.isChecked ? '☑️' : '⬜';
    msg += `${check} ${escapeHtml(item.displayName)}\n`;
  }
  return msg.trim();
}

export function formatAllTasks(tasks: TodoTask[]): string {
  if (tasks.length === 0) return '📋 No pending tasks across any list. Nice work!';

  // Group by list name
  const grouped: Record<string, TodoTask[]> = {};
  for (const task of tasks) {
    if (!grouped[task.listName]) grouped[task.listName] = [];
    grouped[task.listName].push(task);
  }

  let msg = `<b>📋 All Pending Tasks (${tasks.length})</b>\n`;

  for (const [listName, listTasks] of Object.entries(grouped)) {
    msg += `\n<b>${escapeHtml(listName)}</b> (${listTasks.length})\n`;
    for (const task of listTasks) {
      const imp = task.importance !== 'normal' ? ` ${IMPORTANCE_EMOJI[task.importance] || ''}` : '';
      msg += `${STATUS_EMOJI[task.status] || '⬜'}${imp} ${escapeHtml(task.title)}`;
      if (task.dueDateTime) {
        const isOverdue = task.status !== 'completed' && new Date(task.dueDateTime) < new Date();
        msg += isOverdue ? ` ⚠️ due ${formatDate(task.dueDateTime)}` : ` — due ${formatDate(task.dueDateTime)}`;
      }
      msg += '\n';
    }
  }

  return msg.trim();
}

export function formatCompletedTasks(tasks: TodoTask[], listName?: string): string {
  if (tasks.length === 0) {
    return listName
      ? `✅ No recently completed tasks in <b>${escapeHtml(listName)}</b>.`
      : '✅ No recently completed tasks.';
  }

  const header = listName
    ? `<b>✅ Completed: ${escapeHtml(listName)} (${tasks.length})</b>`
    : `<b>✅ Recently Completed (${tasks.length})</b>`;

  let msg = `${header}\n\n`;
  for (const task of tasks) {
    msg += `✅ ${escapeHtml(task.title)}`;
    if (task.completedDateTime) msg += ` — ${formatDate(task.completedDateTime)}`;
    if (!listName) msg += ` <i>[${escapeHtml(task.listName)}]</i>`;
    msg += '\n';
  }

  return msg.trim();
}
