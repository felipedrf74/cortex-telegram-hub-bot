// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DomainResponse } from './types';
import { getActiveProvider } from '../services/provider-registry';
import { callDomain as directCallDomain, continueWithToolResults as directContinueWithToolResults } from '../services/anthropic';
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
import { tryFastpath } from '../services/secretary-fastpath';
import { analyzeIntent } from '../services/secretary-tools';
import type { AIToolResultMessage } from '../services/ai-provider';

const DOMAIN: DomainName = 'secretary';

// Short-lived cache for state context — avoids redundant API calls on rapid messages.
// SECURITY FIX (April 2026): cache is now keyed by userId + context shape to prevent
// cross-user context leakage. Previously, the cache was keyed only by shape, which
// meant user B could receive user A's cached context within the 30s TTL window.
const _stateContextCache: Map<string, { value: string; expiresAt: number }> = new Map();
const STATE_CONTEXT_TTL = 30_000; // 30 seconds
const MAX_CACHE_ENTRIES = 50; // Prevent unbounded growth

/**
 * Test-only: clear the in-process state context cache so each test starts
 * with a fresh fetch path. Production code never needs this — the cache
 * naturally expires after STATE_CONTEXT_TTL or when the shape changes.
 */
export function _resetStateContextCacheForTesting(): void {
  _stateContextCache.clear();
}

/**
 * Layer 2: Smart Context Selection.
 *
 * Instead of fetching ALL six data sources on every message, analyze the
 * message intent and only fetch what's needed. The keyword classifier is
 * the same one Layer 3 uses for tool selection (single source of truth).
 *
 * Token economics:
 *   - Before: ~2,500 tokens of state context on every call
 *   - After:  ~300-1,500 tokens depending on which sources were needed
 *   - Saving: ~1,000-2,000 tokens per call
 *
 * Cache shape key: when an ambiguous message loads everything, the cache
 * value is reusable for any subsequent intent. When a specific intent
 * loads only one source, the cache is only valid for the same shape — so
 * a "show tasks" cache hit on a follow-up "what's my week" would miss
 * (calendar wasn't loaded the first time) and re-run with calendar.
 */
async function buildStateContext(message: string = '', userId: number = 0): Promise<string> {
  // Check which sub-skills are enabled to skip unnecessary API calls
  const tasksEnabled = isSubmoduleEnabled('secretary', 'tasks');
  const calendarEnabled = isSubmoduleEnabled('secretary', 'calendar');
  const emailEnabled = isSubmoduleEnabled('secretary', 'email');
  const remindersEnabled = isSubmoduleEnabled('secretary', 'reminders');

  // Layer 2: figure out which data sources the message actually needs.
  // Ambiguous queries (short follow-ups, freeform questions) load everything
  // — same behavior as before the optimization. Specific queries load just
  // their slice. Garmin always loads if Garmin is configured because the
  // training context is cheap and useful for cross-domain reasoning.
  const intent = analyzeIntent(message);
  const needs = {
    tasks: intent.ambiguous || intent.tasks,
    calendar: intent.ambiguous || intent.calendar,
    email: intent.ambiguous || intent.email,
    reminders: intent.ambiguous || intent.reminders || intent.tasks, // reminders are cheap, often paired with tasks
    garmin: intent.ambiguous || intent.garmin,
  };

  // Cache key = userId + context shape — prevents cross-user leakage
  const shape = `${needs.tasks ? 't' : ''}${needs.calendar ? 'c' : ''}${needs.email ? 'e' : ''}${needs.reminders ? 'r' : ''}${needs.garmin ? 'g' : ''}`;
  const cacheKey = `${userId}:${shape}`;

  const cached = _stateContextCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const parts: string[] = [];
  parts.push(`Today: ${now().toFormat('cccc, LLLL dd yyyy, HH:mm')} (Europe/Lisbon)`);

  // Build date range for Garmin: last 3 days
  const today = now();
  const threeDaysAgo = today.minus({ days: 3 }).toFormat('yyyy-MM-dd');
  const todayStr = today.toFormat('yyyy-MM-dd');

  // Fetch only what `needs` says we need (skip disabled sub-skills + skip unneeded sources)
  const [todoResult, reminders, calendarResult, unreadResult, garminActivities, garminBodyBattery] = await Promise.all([
    needs.tasks && tasksEnabled && isOutlookTodoConfigured()
      ? getAllPendingTasks().catch(() => ({ success: false as const, data: [], error: 'API error' }))
      : Promise.resolve(null),
    needs.reminders && remindersEnabled ? Promise.resolve(getRemindersForToday(userId)) : Promise.resolve([]),
    needs.calendar && calendarEnabled && isAnyCalendarConfigured()
      // CHAT-M2: pass userId so unified-calendar checks per-user Outlook tokens
      ? getEvents(startOfDay(), endOfDay(), userId).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    needs.email && emailEnabled && isOutlookMailConfigured()
      ? getUnreadCount().catch(() => null)
      : Promise.resolve(null),
    needs.garmin && isGarminConfigured()
      ? getActivitiesByDate(threeDaysAgo, todayStr).catch(() => [] as GarminActivity[])
      : Promise.resolve([] as GarminActivity[]),
    needs.garmin && isGarminConfigured()
      ? getBodyBatteryEvents(todayStr).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Microsoft To Do — compact summary (details available via tools)
  if (todoResult) {
    if (todoResult.success && todoResult.data.length > 0) {
      const tasks = todoResult.data;
      // Date-only comparison in the configured timezone. A task "due April 6"
      // should be treated as due TODAY at any moment on April 6, NOT marked
      // overdue at 00:01 just because the timestamp is < now. This matches
      // MS Todo's own UI behavior and avoids double-counting today's tasks
      // as both "overdue" and "due today".
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
      const dueDateStr = (t: typeof tasks[number]): string | null => {
        if (!t.dueDateTime) return null;
        return new Date(t.dueDateTime).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
      };
      const overdue = tasks.filter((t) => {
        const d = dueDateStr(t);
        return d !== null && d < todayStr;
      });
      const dueToday = tasks.filter((t) => dueDateStr(t) === todayStr);

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

  // Cross-domain shared context — SECURITY FIX: now uses actual userId
  const sharedCtx = getSharedMemorySummary(userId);
  if (sharedCtx) parts.push(sharedCtx);

  const result = parts.join('\n');

  // Evict oldest entries if cache grows too large
  if (_stateContextCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = _stateContextCache.keys().next().value;
    if (oldest) _stateContextCache.delete(oldest);
  }
  _stateContextCache.set(cacheKey, { value: result, expiresAt: Date.now() + STATE_CONTEXT_TTL });
  return result;
}

export async function handleSecretary(message: string, userId?: number): Promise<DomainResponse> {
  const uid = userId ?? 0;

  // ── Layer 1: Command Fastpath ──────────────────────────────────
  // Intercept deterministic data-read patterns before any AI call.
  // Identical Telegram-HTML output to the AI path; users can't tell the
  // difference. Errors fall through to the AI path automatically.
  // See src/services/secretary-fastpath.ts for the pattern dictionary.
  const fastpath = await tryFastpath(uid, message);
  if (fastpath.matched && fastpath.response) {
    // Record in conversation history so the next AI turn has context
    // about what the user just asked. Tag the assistant message with the
    // pattern id so future debugging can spot fastpath responses in logs.
    addToConversation(uid, DOMAIN, 'user', message);
    addToConversation(
      uid,
      DOMAIN,
      'assistant',
      `[fastpath:${fastpath.patternId}]\n${fastpath.response.text}`,
    );
    return fastpath.response;
  }

  const history = getConversationHistory(uid, DOMAIN);
  // Layer 2: pass the message so buildStateContext can fetch only what
  // the message actually needs (saves ~1,000-2,000 input tokens on
  // intent-typed queries; ambiguous queries fall back to fetching all).
  const stateContext = await buildStateContext(message, uid);

  // ── Provider routing — TASK-17 Option B fix ────────────────────
  //
  // Previously this handler imported callDomain/continueWithToolResults
  // directly from services/anthropic.ts, which BYPASSED the
  // TaskRoutingProvider entirely — meaning the Gemini migration we
  // shipped earlier never actually applied to secretary. Despite the
  // routing config saying "secretary → gemini", every secretary call
  // was still hitting Anthropic Sonnet because handleSecretary used
  // a different code path than handleSimpleDomain.
  //
  // Fix: route through getActiveProvider() like handleSimpleDomain
  // does, with the same fallback to direct Anthropic if the routing
  // provider isn't initialized. Now secretary participates in:
  //   - Gemini routing (config-driven, portal-toggleable)
  //   - TASK-17 Layers 3/4/5 (computed by TaskRoutingProvider once
  //     and passed to whichever provider runs)
  //   - Circuit breaker fallback (if Gemini fails, falls back to
  //     Anthropic Haiku — same fallback the chat domains get)
  const provider = getActiveProvider();
  if (!provider) {
    // Fallback to direct Anthropic — same call signatures the legacy
    // path used. The Anthropic SDK client is lazy-initialized inside
    // anthropic.ts so this static import is cheap; the test suites
    // can mock the imports normally without dynamic-require gotchas.
    return await handleSecretaryWithDirectAnthropic(
      uid, message, history, stateContext, directCallDomain, directContinueWithToolResults, userId,
    );
  }

  // Provider-agnostic tool loop — same shape as handleSimpleDomain
  // but with secretary's iteration cap (4 instead of 5) and the
  // empty-response fallback message that secretary specifically needs
  // because its tool loop is more brittle than the chat domains.
  let result = await provider.callDomain(DOMAIN, history, message, stateContext);
  let finalText = result.text;

  logger.debug(
    { provider: provider.name, hasTools: result.toolCalls.length > 0 },
    'Secretary call dispatched via routing provider',
  );

  const toolConversation: AIToolResultMessage[] = [];
  const toolsUsed: string[] = [];
  let iterations = 0;

  while (result.toolCalls.length > 0 && iterations < 4) {
    iterations++;
    logger.debug({ iteration: iterations, toolCount: result.toolCalls.length }, 'Tool loop iteration');

    // Build assistant content (provider-agnostic format — matches
    // what handleSimpleDomain does for cooking/finance/etc.)
    const assistantContent: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const tc of result.toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      toolsUsed.push(tc.name);
    }

    // Execute all tool calls in parallel, truncate large results
    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc) => {
        const toolResult = await executeToolCall(tc.name, tc.input as Record<string, any>, userId);
        let content = JSON.stringify(toolResult);
        if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
        return { type: 'tool_result' as const, tool_use_id: tc.id, content };
      })
    );

    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent as any },
      { role: 'user' as const, content: toolResults },
    );

    logger.debug({ iteration: iterations, msgCount: toolConversation.length }, 'Calling continueWithToolResults');
    result = await provider.continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation);
    finalText = result.text;
    logger.debug({ iteration: iterations, hasText: !!finalText, toolCalls: result.toolCalls.length }, 'Continue result');
  }

  // Guard against empty response (can happen after errors exhaust tool iterations)
  if (!finalText || !finalText.trim()) {
    finalText = '⚠️ I processed your request but encountered some issues. Some actions may have completed partially. Please check your task list and try again if needed.';
  }

  // CHAT-M4: detect max_tokens truncation — if the AI hit the output
  // ceiling, append a note so the user knows the response is incomplete.
  // This catches the common case where a busy day's briefing exceeds
  // the token budget and gets cut mid-sentence.
  if (result?.stopReason === 'max_tokens' || result?.stopReason === 'length') {
    logger.warn({ uid, domain: DOMAIN, stopReason: result.stopReason }, 'Secretary response was truncated by max_tokens');
    finalText += '\n\n_⚠️ Response was cut short due to length. Try asking about a specific area (e.g. "just show my tasks" or "just calendar")._';
  }

  // Store conversation — include tool summary so future turns have context
  addToConversation(uid, DOMAIN, 'user', message);
  const storedText = toolsUsed.length > 0
    ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
    : finalText;
  addToConversation(uid, DOMAIN, 'assistant', storedText);

  return { text: finalText, domain: DOMAIN };
}

/**
 * Direct-Anthropic fallback for handleSecretary. Used only when the
 * routing provider isn't initialized — preserves the original
 * Anthropic-only flow as a safety net during startup or if routing
 * fails to init. Uses Anthropic SDK types directly.
 *
 * In normal operation this never runs because portal/server.ts calls
 * createRoutingProvider() at startup. It exists purely as a safety net
 * so a misconfigured deploy can never leave secretary completely
 * broken.
 */
async function handleSecretaryWithDirectAnthropic(
  uid: number,
  message: string,
  history: ReturnType<typeof getConversationHistory>,
  stateContext: string,
  callDomain: (...args: any[]) => Promise<{ text: string; toolCalls: any[]; stopReason: string }>,
  continueWithToolResults: (...args: any[]) => Promise<{ text: string; toolCalls: any[]; stopReason: string }>,
  userId: number | undefined,
): Promise<DomainResponse> {
  let result = await callDomain(DOMAIN, history, message, stateContext, undefined, userId);
  let finalText = result.text;

  const toolConversation: any[] = [];
  const toolsUsed: string[] = [];
  let iterations = 0;

  while (result.toolCalls.length > 0 && iterations < 4) {
    iterations++;
    const assistantContent: any[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const tc of result.toolCalls) {
      assistantContent.push(tc);
      toolsUsed.push(tc.name);
    }

    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc: any) => {
        const toolResult = await executeToolCall(tc.name, tc.input as Record<string, any>, userId);
        let content = JSON.stringify(toolResult);
        if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
        return { type: 'tool_result' as const, tool_use_id: tc.id, content };
      })
    );

    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: toolResults },
    );

    result = await continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation, userId);
    finalText = result.text;
  }

  if (!finalText || !finalText.trim()) {
    finalText = '⚠️ I processed your request but encountered some issues. Some actions may have completed partially. Please check your task list and try again if needed.';
  }

  addToConversation(uid, DOMAIN, 'user', message);
  const storedText = toolsUsed.length > 0
    ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
    : finalText;
  addToConversation(uid, DOMAIN, 'assistant', storedText);

  return { text: finalText, domain: DOMAIN };
}
