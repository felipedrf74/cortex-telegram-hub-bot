// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DomainResponse } from './types';
import { callDomain, continueWithToolResults } from '../services/anthropic';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { getActiveReminders, getRemindersForToday } from '../state/reminders';
import { getEvents, isAnyCalendarConfigured } from '../services/unified-calendar';
import { isOutlookMailConfigured, getUnreadCount } from '../services/outlook-mail';
import { isOutlookTodoConfigured, getAllPendingTasks } from '../services/microsoft-todo';
import { now, startOfDay, endOfDay, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import { getSharedMemorySummary } from '../state/shared-memory';
import { isGarminConfigured, getActivitiesByDate, getBodyBatteryEvents, GarminActivity } from '../services/garmin';
import { logger } from '../utils/logger';
import { isSubmoduleEnabled } from '../skills/registry';
import Anthropic from '@anthropic-ai/sdk';

const DOMAIN: DomainName = 'secretary';

// Short-lived cache for state context — avoids redundant API calls on rapid messages
let _stateContextCache: { value: string; expiresAt: number } | null = null;
const STATE_CONTEXT_TTL = 30_000; // 30 seconds

async function buildStateContext(): Promise<string> {
  if (_stateContextCache && Date.now() < _stateContextCache.expiresAt) {
    return _stateContextCache.value;
  }

  const parts: string[] = [];
  parts.push(`Today: ${now().toFormat('cccc, LLLL dd yyyy, HH:mm')} (Europe/Lisbon)`);

  // Check which sub-skills are enabled to skip unnecessary API calls
  const tasksEnabled = isSubmoduleEnabled('secretary', 'tasks');
  const calendarEnabled = isSubmoduleEnabled('secretary', 'calendar');
  const emailEnabled = isSubmoduleEnabled('secretary', 'email');
  const remindersEnabled = isSubmoduleEnabled('secretary', 'reminders');

  // Build date range for Garmin: last 3 days
  const today = now();
  const threeDaysAgo = today.minus({ days: 3 }).toFormat('yyyy-MM-dd');
  const todayStr = today.toFormat('yyyy-MM-dd');

  // Fetch all data sources in parallel (skip disabled sub-skills)
  const [todoResult, reminders, calendarResult, unreadResult, garminActivities, garminBodyBattery] = await Promise.all([
    tasksEnabled && isOutlookTodoConfigured()
      ? getAllPendingTasks().catch(() => ({ success: false as const, data: [], error: 'API error' }))
      : Promise.resolve(null),
    remindersEnabled ? Promise.resolve(getRemindersForToday(0)) : Promise.resolve([]),
    calendarEnabled && isAnyCalendarConfigured()
      ? getEvents(startOfDay(), endOfDay()).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    emailEnabled && isOutlookMailConfigured()
      ? getUnreadCount().catch(() => null)
      : Promise.resolve(null),
    isGarminConfigured()
      ? getActivitiesByDate(threeDaysAgo, todayStr).catch(() => [] as GarminActivity[])
      : Promise.resolve([] as GarminActivity[]),
    isGarminConfigured()
      ? getBodyBatteryEvents(todayStr).catch(() => null)
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

  // Garmin training summary (last 3 days)
  if (garminActivities.length > 0 || garminBodyBattery) {
    parts.push('\n[GARMIN TRAINING SUMMARY]');

    if (garminActivities.length > 0) {
      // Group by date
      const byDate = new Map<string, GarminActivity[]>();
      for (const a of garminActivities) {
        const date = a.startTimeLocal?.substring(0, 10) || 'unknown';
        const list = byDate.get(date) || [];
        list.push(a);
        byDate.set(date, list);
      }

      for (const [date, activities] of [...byDate.entries()].sort()) {
        const summaries = activities.map((a) => {
          const type = a.activityType?.typeKey || a.activityName || 'activity';
          const dur = a.duration ? `${Math.round(a.duration / 60)}min` : '';
          const dist = a.distance ? `${(a.distance / 1000).toFixed(1)}km` : '';
          const hr = a.averageHR ? `avgHR:${a.averageHR}` : '';
          const cal = a.calories ? `${a.calories}cal` : '';
          return `${type} ${[dur, dist, hr, cal].filter(Boolean).join(' ')}`;
        });
        parts.push(`  ${date}: ${summaries.join(' | ')}`);
      }

      // Check for missing training days
      const activityDates = new Set(byDate.keys());
      for (let i = 0; i < 3; i++) {
        const d = today.minus({ days: i }).toFormat('yyyy-MM-dd');
        if (!activityDates.has(d)) {
          parts.push(`  ${d}: No training logged`);
        }
      }
    } else {
      parts.push('  No activities in the last 3 days');
    }

    // Body battery
    if (garminBodyBattery && typeof garminBodyBattery === 'object') {
      const bb = garminBodyBattery as Record<string, unknown>;
      const events = bb.bodyBatteryValuesArray ?? bb.bodyBatteryEvents;
      if (Array.isArray(events) && events.length > 0) {
        // Get the latest value
        const latest = events[events.length - 1];
        const val = Array.isArray(latest) ? latest[1] : (latest as Record<string, unknown>)?.bodyBatteryLevel;
        if (val != null) parts.push(`  Body Battery: ${val}/100`);
      }
      // Try charged/drained from daily summary fields
      const charged = bb.bodyBatteryChargedValue ?? bb.totalCharged;
      const drained = bb.bodyBatteryDrainedValue ?? bb.totalDrained;
      if (charged != null || drained != null) {
        parts.push(`  Charged: ${charged ?? '?'} | Drained: ${drained ?? '?'}`);
      }
    }
  }

  // Cross-domain shared context
  const sharedCtx = getSharedMemorySummary(0); // TODO: pass userId when buildStateContext receives it
  if (sharedCtx) parts.push(sharedCtx);

  const result = parts.join('\n');
  _stateContextCache = { value: result, expiresAt: Date.now() + STATE_CONTEXT_TTL };
  return result;
}

export async function handleSecretary(message: string, userId?: number): Promise<DomainResponse> {
  const uid = userId ?? 0;
  const history = getConversationHistory(uid, DOMAIN);
  const stateContext = await buildStateContext();

  let result = await callDomain(DOMAIN, history, message, stateContext, undefined, userId);
  let finalText = result.text;

  // Accumulate full tool conversation chain across iterations
  const toolConversation: Anthropic.MessageParam[] = [];
  const toolsUsed: string[] = [];

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
      toolsUsed.push(tc.name);
    }

    // Execute all tool calls in parallel, truncate large results
    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc) => {
        const toolResult = await executeToolCall(tc.name, tc.input as Record<string, any>, userId);
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
    result = await continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation, userId);
    finalText = result.text;
    logger.debug({ iteration: iterations, hasText: !!finalText, toolCalls: result.toolCalls.length }, 'Continue result');
  }

  // Guard against empty response (can happen after errors exhaust tool iterations)
  if (!finalText || !finalText.trim()) {
    finalText = '⚠️ I processed your request but encountered some issues. Some actions may have completed partially. Please check your task list and try again if needed.';
  }

  // Store conversation — include tool summary so future turns have context
  addToConversation(uid, DOMAIN, 'user', message);
  const storedText = toolsUsed.length > 0
    ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
    : finalText;
  addToConversation(uid, DOMAIN, 'assistant', storedText);

  return { text: finalText, domain: DOMAIN };
}
