import { DomainName, DomainResponse } from './types';
import { callDomain, continueWithToolResults } from '../services/anthropic';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { getActiveReminders, getRemindersForToday } from '../state/reminders';
import { getEvents, isAnyCalendarConfigured } from '../services/unified-calendar';
import { isOutlookMailConfigured, getUnreadCount } from '../services/outlook-mail';
import { isOutlookTodoConfigured, getAllPendingTasks } from '../services/microsoft-todo';
import { now, startOfDay, endOfDay, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import { logger } from '../utils/logger';
import Anthropic from '@anthropic-ai/sdk';

const DOMAIN: DomainName = 'secretary';

async function buildStateContext(): Promise<string> {
  const parts: string[] = [];
  parts.push(`Today: ${now().toFormat('cccc, LLLL dd yyyy, HH:mm')} (Europe/Lisbon)`);

  // Fetch all data sources in parallel (no redundant calls)
  const [todoResult, reminders, calendarResult, unreadResult] = await Promise.all([
    isOutlookTodoConfigured()
      ? getAllPendingTasks().catch(() => ({ success: false as const, data: [], error: 'API error' }))
      : Promise.resolve(null),
    Promise.resolve(getRemindersForToday()),
    isAnyCalendarConfigured()
      ? getEvents(startOfDay(), endOfDay()).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    isOutlookMailConfigured()
      ? getUnreadCount().catch(() => null)
      : Promise.resolve(null),
  ]);

  // Microsoft To Do — compact summary (details available via tools)
  if (todoResult) {
    if (todoResult.success && todoResult.data.length > 0) {
      const tasks = todoResult.data;
      const nowDate = new Date();
      const todayStart = new Date(startOfDay()).getTime();
      const todayEnd = new Date(endOfDay()).getTime();
      const overdue = tasks.filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);
      const dueToday = tasks.filter((t) => {
        if (!t.dueDateTime) return false;
        const due = new Date(t.dueDateTime).getTime();
        return due >= todayStart && due <= todayEnd;
      });

      // Group by list with IDs (so model can skip ms_todo_get_lists)
      const byList = new Map<string, { id: string; count: number }>();
      for (const t of tasks) {
        const entry = byList.get(t.listName) || { id: t.listId, count: 0 };
        entry.count++;
        byList.set(t.listName, entry);
      }
      const listSummary = [...byList.entries()]
        .map(([name, { id, count }]) => `${name}(${count}) list_id:${id}`)
        .join(' | ');

      parts.push(`\nTo Do: ${tasks.length} pending, ${overdue.length} overdue, ${dueToday.length} due today.\nLists: ${listSummary}`);
      if (overdue.length > 0) {
        parts.push(`Overdue: ${overdue.slice(0, 5).map((t) => t.title).join(', ')}`);
      }
    } else if (!todoResult.success) {
      parts.push('\nTo Do: API error');
    }
  }

  // Reminders & calendar — compact
  if (reminders.length > 0) {
    parts.push(`\nReminders today: ${reminders.map((r) => `${r.message} (${formatDateTime(r.remind_at)})`).join(', ')}`);
  }
  if (calendarResult.length > 0) {
    parts.push(`\nCalendar today (${calendarResult.length}): ${calendarResult.map((e) => `${formatDateTime(e.start)}-${formatDateTime(e.end)} ${e.summary}`).join(' | ')}`);
  }
  if (unreadResult !== null) {
    parts.push(`\nOutlook: ${unreadResult} unread`);
  }

  return parts.join('\n');
}

export async function handleSecretary(message: string): Promise<DomainResponse> {
  const history = getConversationHistory(DOMAIN);
  const stateContext = await buildStateContext();

  let result = await callDomain(DOMAIN, history, message, stateContext);
  let finalText = result.text;

  // Accumulate full tool conversation chain across iterations
  const toolConversation: Anthropic.MessageParam[] = [];

  let iterations = 0;
  while (result.toolCalls.length > 0 && iterations < 4) {
    iterations++;
    logger.debug({ iteration: iterations, toolCount: result.toolCalls.length }, 'Tool loop iteration');

    // Build assistant content blocks for this iteration
    const assistantContent: Anthropic.ContentBlock[] = [];
    if (result.text) {
      assistantContent.push({ type: 'text', text: result.text } as Anthropic.ContentBlock);
    }
    for (const tc of result.toolCalls) {
      assistantContent.push(tc);
    }

    // Execute all tool calls in parallel, truncate large results
    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc) => {
        const toolResult = await executeToolCall(tc.name, tc.input as Record<string, any>);
        let content = JSON.stringify(toolResult);
        if (content.length > 2000) {
          content = content.slice(0, 2000) + '...(truncated)';
        }
        return {
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content,
        };
      })
    );

    // Append this round to the full conversation chain
    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: toolResults },
    );

    logger.debug({ iteration: iterations, msgCount: toolConversation.length }, 'Calling continueWithToolResults');
    result = await continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation);
    finalText = result.text;
    logger.debug({ iteration: iterations, hasText: !!finalText, toolCalls: result.toolCalls.length }, 'Continue result');
  }

  // Guard against empty response (can happen after errors exhaust tool iterations)
  if (!finalText || !finalText.trim()) {
    finalText = '⚠️ I processed your request but encountered some issues. Some actions may have completed partially. Please check your task list and try again if needed.';
  }

  // Store conversation
  addToConversation(DOMAIN, 'user', message);
  addToConversation(DOMAIN, 'assistant', finalText);

  return { text: finalText, domain: DOMAIN };
}
