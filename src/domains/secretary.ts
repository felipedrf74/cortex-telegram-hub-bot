// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DomainResponse } from './types';
import { ensureActiveProvider, getActiveProvider } from '../services/provider-registry';
import { callDomain as directCallDomain, continueWithToolResults as directContinueWithToolResults } from '../services/anthropic';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { getActiveReminders, getRemindersForToday } from '../state/reminders';
import { getEvents, hasConnectedCalendarForUser } from '../services/unified-calendar';
import type { TodoTask } from '../services/microsoft-todo';
import { formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import { getSharedMemorySummary } from '../state/shared-memory';
import {
  getActivitiesByDateForUser,
  getBodyBatteryEventsForUser,
  isGarminConfiguredForUser,
  GarminActivity,
} from '../services/garmin';
import { logger } from '../utils/logger';
import { isSubmoduleEnabled } from '../skills/registry';
import { tryFastpath } from '../services/secretary-fastpath';
import { analyzeIntent } from '../services/secretary-tools';
import type { AICallResult, AIToolResultMessage, CallDomainOptions } from '../services/ai-provider';
import { buildAIUnavailableResponse, canUseDirectAnthropicFallback } from './ai-unavailable';
import { normalizeReplyForLanguage, normalizeReplyForUserLanguage } from '../services/reply-language-normalizer';
import {
  buildSharedDecisionContext,
  buildSharedDecisionContracts,
  type SharedDecisionContracts,
} from '../services/shared-decision-context';
import { getTaskProviderForUser } from '../services/task-store/task-router';
import { composeDailyBrief } from '../services/daily-brief-orchestrator';
import { getUnreadMailSummaryForUser, isAnyMailConfiguredForUser } from '../services/unified-mail-pressure';
import { getUserLanguage, getUserTimezone } from '../services/user-service';
import { DateTime } from 'luxon';
import { buildChatPromptContextBlock } from '../services/chat-context-engine';
import { buildChatGroundingEnvelope } from '../services/chat-grounding-layer';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import { getChatToolRisk } from '../services/chat-tool-authorization';
import { getSecretaryReasoningV1Mode, type SecretaryReasoningV1Mode } from '../services/runtime-flags';
import {
  buildSecretaryContextSnapshot,
  type SecretaryContextSnapshot,
} from '../services/chat-core-v2/secretary-context-snapshot';
import {
  buildSecretaryReasoningPrompt,
  buildSecretaryReasoningRepairPrompt,
  parseAndValidateSecretaryReasoning,
  type SecretaryActionDraft,
  type SecretaryReasoningCandidate,
  type SecretaryReasoningValidationIssue,
  type SecretaryReasoningValidationResult,
} from '../services/chat-core-v2/secretary-candidate-schema';
import { selectSecretaryReasoningOutcome } from '../services/chat-core-v2/secretary-reasoning-coordinator';
import { createSecretaryDecisionPreview } from '../services/chat-core-v2/secretary-decision-preview';
import { getCurrentChatLiveEvalSeedBlock } from '../services/chat-live-evaluation-context';
import {
  buildChatReplyLanguagePromptBlock,
  getCurrentChatRequestLocale,
} from '../services/chat-request-locale-context';
import {
  isSkillInferenceAccountDeletionError,
  runWithSkillInferenceAccountAdmission,
} from '../services/skill-inference-service';
import { markChatShadowBaselineEligible } from '../services/chat-shadow-baseline';
import type { Lang } from '../utils/i18n';

function requestLocaleToSecretaryLanguage(locale: string | null): Lang | undefined {
  if (!locale) return undefined;
  if (locale.toLowerCase() === 'pt-pt') return 'pt-PT';
  if (locale.toLowerCase().startsWith('pt')) return 'pt-BR';
  return 'en-US';
}

function normalizeSecretaryReplyForRequest(text: string, userId?: number): string {
  const requestLocale = getCurrentChatRequestLocale();
  return requestLocale
    ? normalizeReplyForLanguage(text, requestLocale)
    : normalizeReplyForUserLanguage(text, userId);
}

// Codex QA round 5: untrusted text from user-controlled sources (task
// titles, reminder messages, calendar summaries) was previously
// interpolated raw into the secretary state-context prompt. Wrap with
// the sanitizer so injection attempts are neutralized. JSON-stringify
// adds quotes but keeps the prompt readable as a data literal — fine
// for a comma-separated list. Returns the inner value without the
// outer quotes to keep the human-readable format closer to before.
function safeInline(value: unknown): string {
  const sanitized = sanitizeForPromptInterpolation(value);
  // sanitizeForPromptInterpolation returns a JSON-stringified value
  // (e.g. `"my title"`). Strip the outer quotes for cleaner inline
  // rendering — the inner content is already neutralized.
  if (sanitized.startsWith('"') && sanitized.endsWith('"')) {
    return sanitized.slice(1, -1);
  }
  return sanitized;
}

const DOMAIN: DomainName = 'secretary';

// Short-lived cache for state context — avoids redundant API calls on rapid messages.
// SECURITY FIX (April 2026): cache is now keyed by userId + context shape to prevent
// cross-user context leakage. Previously, the cache was keyed only by shape, which
// meant user B could receive user A's cached context within the 30s TTL window.
const _stateContextCache: Map<string, { value: string; expiresAt: number }> = new Map();
const STATE_CONTEXT_TTL = 30_000; // 30 seconds
const MAX_CACHE_ENTRIES = 50; // Prevent unbounded growth

interface SecretaryReasoningSession {
  mode: SecretaryReasoningV1Mode;
  snapshot: SecretaryContextSnapshot | null;
}

export interface SecretaryReasoningFinalization {
  text: string;
  valid: boolean;
  behavior: string;
  reasonCodes: string[];
  candidate: SecretaryReasoningCandidate | null;
  actionDraft: SecretaryActionDraft | null;
  snapshotId: string;
  contextVersion: string;
  repairAttempted: boolean;
}

function throwIfSecretaryAccountModelWorkAborted(abortSignal?: AbortSignal): void {
  if (!abortSignal?.aborted) return;
  if (abortSignal.reason instanceof Error) throw abortSignal.reason;
  throw Object.assign(new Error('Account-scoped Secretary model work was cancelled.'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

function rethrowSecretaryAccountModelWorkCancellation(
  error: unknown,
  abortSignal?: AbortSignal,
): void {
  if (isSkillInferenceAccountDeletionError(error) || abortSignal?.aborted) {
    if (abortSignal?.reason instanceof Error) throw abortSignal.reason;
    throw error;
  }
}

type SecretaryStructuredModelCall = (prompt: string) => Promise<AICallResult>;

function addScopedConversation(
  userId: number,
  role: 'user' | 'assistant',
  content: string,
  tenantId?: number,
): void {
  if (typeof tenantId === 'number') {
    addToConversation(userId, DOMAIN, role, content, tenantId);
    return;
  }
  addToConversation(userId, DOMAIN, role, content);
}

function executeScopedToolCall(
  name: string,
  input: Record<string, any>,
  userId?: number,
  tenantId?: number,
): Promise<unknown> {
  if (typeof tenantId === 'number') {
    return executeToolCall(name, input, userId, tenantId);
  }
  return executeToolCall(name, input, userId);
}

function isLegacySecretaryWriteTool(name: string): boolean {
  return getChatToolRisk(name) !== 'read';
}

function buildLegacyWriteBlockedToolResult(name: string): Record<string, unknown> {
  return {
    success: false,
    code: 'ACTION_CONFIRMATION_REQUIRED',
    confirmation_required: true,
    error: `${name} is a write action and must run through the chat action planner confirmation flow.`,
  };
}

function buildLegacyWriteBlockedReply(userId?: number): string {
  const isPT = typeof userId === 'number' && getUserLanguage(userId).startsWith('pt');
  return isPT
    ? 'Essa ação precisa de confirmação no app antes de eu alterar qualquer coisa.'
    : 'This action needs confirmation in the app before I change anything.';
}

/**
 * Test-only: clear the in-process state context cache so each test starts
 * with a fresh fetch path. Production code never needs this — the cache
 * naturally expires after STATE_CONTEXT_TTL or when the shape changes.
 */
export function _resetStateContextCacheForTesting(): void {
  _stateContextCache.clear();
}

/** Clear only one authenticated tenant/user cache scope for eval isolation. */
export function clearSecretaryStateContextCacheForScope(userId: number, tenantId: number): number {
  const prefix = `${tenantId}:${userId}:`;
  let cleared = 0;
  for (const key of _stateContextCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    _stateContextCache.delete(key);
    cleared += 1;
  }
  return cleared;
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
// Slim <missing_facts> block — built directly from the grounding
// envelope so the pre-call hallucination guard reaches the model on
// mutating turns that don't trigger the planner context. Returns ''
// when no fields are missing (read-only turns) so the prompt isn't
// inflated unnecessarily.
function buildMinimalMissingFactsBlock(
  message: string,
  userId: number | null,
  tenantId?: number,
): string {
  if (!message.trim() || userId === null) return '';
  try {
    const envelope = buildChatGroundingEnvelope({
      message,
      userId,
      tenantId: typeof tenantId === 'number' ? tenantId : userId,
      routedDomain: DOMAIN,
    });
    if (!envelope.missingFacts.length) return '';
    const lines = [
      `<missing_facts owner_skill="${envelope.capability.ownerSkill}" intent="${envelope.capability.intent}">`,
      'The user message does not state these fields. Do NOT invent values; ask one focused clarification (in the user language) before calling any write tool:',
      ...envelope.missingFacts.map((f) => `- ${f}`),
      '</missing_facts>',
    ];
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function buildStateContext(message: string = '', userId?: number, tenantId?: number): Promise<string> {
  const scopedUserId = typeof userId === 'number' ? userId : null;
  const hasUserScope = scopedUserId !== null;
  const contextLanguage = resolveSecretaryContextLanguage(scopedUserId);
  const copy = secretaryStateContextCopy(contextLanguage);
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
    planner: intent.ambiguous || /\b(plan|prioriti[sz]e|priority|first|focus|fit|reschedul|schedule|organi[sz]e|tradeoff|handoff|what should i do|what do i do first|how do i fit|o que faço primeiro|o que devo fazer primeiro|o que devo priorizar(?: hoje)?|o que priorizo(?: hoje)?|qual(?: é| a)? prioridade(?: hoje)?|prioriza o meu dia|priorizar o meu dia|prioriza meu dia|priorizar meu dia|organiza o meu dia|organiza meu dia|como encaixo)\b/i.test(message),
  };
  const needsSharedDecisionContext = hasUserScope && needs.planner;
  const promptBudgetChars = needs.planner
    ? 2000
    : intent.ambiguous
      ? 1500
      : 700;
  const taskProvider = hasUserScope && needs.tasks && tasksEnabled
    ? getTaskProviderForUser(scopedUserId)
    : null;
  const hasCalendar = hasUserScope && needs.calendar && calendarEnabled
    ? hasConnectedCalendarForUser(scopedUserId)
    : false;
  const hasMail = hasUserScope && needs.email && emailEnabled
    ? isAnyMailConfiguredForUser(scopedUserId)
    : false;
  const hasGarmin = hasUserScope && needs.garmin
    ? isGarminConfiguredForUser(scopedUserId)
    : false;

  // Cache key = userId + context shape — prevents cross-user leakage
  const shape = `${needs.tasks ? 't' : ''}${needs.calendar ? 'c' : ''}${needs.email ? 'e' : ''}${needs.reminders ? 'r' : ''}${needs.garmin ? 'g' : ''}${needs.planner ? 'p' : ''}`;
  const scopedTenantId = hasUserScope ? (typeof tenantId === 'number' && tenantId > 0 ? tenantId : scopedUserId) : null;
  const scopedTenantKey = scopedTenantId ?? 'anon';
  const appendPromptContext = async (baseContext: string, cacheHit: boolean): Promise<string> => {
    if (!hasUserScope) return baseContext;
    const appendEvalSeed = (value: string): string => {
      const evalSeedBlock = getCurrentChatLiveEvalSeedBlock();
      return evalSeedBlock ? `${value}\n${evalSeedBlock}` : value;
    };
    if (!needs.planner) {
      // Codex QA round 2: even when the planner context is skipped,
      // mutating turns still need the pre-call <missing_facts> block
      // so the model asks for unstated date/time/title instead of
      // inventing them. Cost: ~100-250 chars only when the grounding
      // layer actually finds missing fields.
      const minimalBlock = buildMinimalMissingFactsBlock(message, scopedUserId, scopedTenantId ?? undefined);
      const augmented = minimalBlock ? `${baseContext}\n${minimalBlock}` : baseContext;
      logger.debug({
        userId: scopedUserId,
        tenantId: scopedTenantKey,
        cacheShape: shape,
        cacheHit,
        promptBudgetChars: 0,
        promptContextAttached: false,
        missingFactsAttached: !!minimalBlock,
        estimatedContextChars: augmented.length,
        estimatedInputTokens: Math.ceil(augmented.length / 4),
      }, 'Secretary state context assembled without broad prompt context');
      return appendEvalSeed(augmented);
    }
    const promptContext = await buildChatPromptContextBlock({
      domain: DOMAIN,
      message,
      userId: scopedUserId,
      tenantId: scopedTenantId ?? undefined,
      budgetChars: promptBudgetChars,
    });
    const combined = promptContext ? `${baseContext}\n${promptContext}` : baseContext;
    logger.debug({
      userId: scopedUserId,
      tenantId: scopedTenantKey,
      cacheShape: shape,
      cacheHit,
      promptBudgetChars,
      promptContextAttached: !!promptContext,
      estimatedContextChars: combined.length,
      estimatedInputTokens: Math.ceil(combined.length / 4),
    }, 'Secretary state context assembled from cache');
    return appendEvalSeed(combined);
  };

  // Codex QA round 3: subskill toggles weren't part of the cache key,
  // so disabling `tasks` mid-conversation still let cached task context
  // ship for up to 30s. Bake the enabled-flags into the key so any
  // toggle immediately invalidates.
  const enabledFlags = `${tasksEnabled ? 't' : ''}${calendarEnabled ? 'c' : ''}${emailEnabled ? 'e' : ''}${remindersEnabled ? 'r' : ''}`;
  const cacheKey = `${scopedTenantKey}:${hasUserScope ? scopedUserId : 'anon'}:${shape}:e${enabledFlags}:${contextLanguage}`;

  const cached = _stateContextCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return appendPromptContext(cached.value, true);
  }

  const timezone = getUserTimezone(scopedUserId);
  const localNow = DateTime.now().setZone(timezone);
  const parts: string[] = [];
  parts.push(`${copy.todayLabel}: ${localNow.toFormat('cccc, LLLL dd yyyy, HH:mm')} (${timezone})`);

  // Build date range for Garmin: last 3 days
  const today = localNow;
  const threeDaysAgo = today.minus({ days: 3 }).toFormat('yyyy-MM-dd');
  const todayStr = today.toFormat('yyyy-MM-dd');

  // Fetch only what `needs` says we need (skip disabled sub-skills + skip unneeded sources)
  const [todoResult, reminders, calendarResult, unreadMail, garminActivities, garminBodyBattery, plannerBrief, decisionCtx, decisionContracts] = await Promise.all([
    taskProvider
      ? taskProvider.getAllPendingTasks().catch(() => ({ success: false as const, data: [], error: 'API error' }))
      : Promise.resolve(null),
    hasUserScope && needs.reminders && remindersEnabled
      ? Promise.resolve(getRemindersForToday(scopedUserId, scopedTenantKey, timezone))
      : Promise.resolve([]),
    hasCalendar && scopedUserId !== null
      ? getEvents(localNow.startOf('day').toISO()!, localNow.endOf('day').toISO()!, scopedUserId).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    hasMail && scopedUserId !== null
      ? getUnreadMailSummaryForUser(scopedUserId).catch(() => null)
      : Promise.resolve(null),
    hasGarmin && scopedUserId !== null
      ? getActivitiesByDateForUser(scopedUserId, threeDaysAgo, todayStr).catch(() => [] as GarminActivity[])
      : Promise.resolve([] as GarminActivity[]),
    hasGarmin && scopedUserId !== null
      ? getBodyBatteryEventsForUser(scopedUserId, todayStr).catch(() => null)
      : Promise.resolve(null),
    hasUserScope && needs.planner
      ? composeDailyBrief({ userId: scopedUserId, tenantId: scopedTenantId!, language: contextLanguage }).catch(() => null)
      : Promise.resolve(null),
    needsSharedDecisionContext ? buildSharedDecisionContext(DOMAIN, scopedUserId, scopedTenantId ?? undefined).catch(() => '') : Promise.resolve(''),
    needsSharedDecisionContext ? buildSharedDecisionContracts(DOMAIN, scopedUserId, scopedTenantId ?? undefined).catch(() => ({} as SharedDecisionContracts)) : Promise.resolve({} as SharedDecisionContracts),
  ]);

  // Microsoft To Do — compact summary (details available via tools)
  if (todoResult) {
    if (todoResult.success && todoResult.data.length > 0) {
      const tasks: TodoTask[] = todoResult.data;
      // Date-only comparison in the configured timezone. A task "due April 6"
      // should be treated as due TODAY at any moment on April 6, NOT marked
      // overdue at 00:01 just because the timestamp is < now. This matches
      // MS Todo's own UI behavior and avoids double-counting today's tasks
      // as both "overdue" and "due today".
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
      const dueDateStr = (t: typeof tasks[number]): string | null => {
        if (!t.dueDateTime) return null;
        return new Date(t.dueDateTime).toLocaleDateString('en-CA', { timeZone: timezone });
      };
      const overdue = tasks.filter((t: TodoTask) => {
        const d = dueDateStr(t);
        return d !== null && d < todayStr;
      });
      const dueToday = tasks.filter((t: TodoTask) => dueDateStr(t) === todayStr);

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

      parts.push(
        `\n${copy.todoLabel}: ${copy.pendingLabel(tasks.length)}, ${copy.overdueLabel(overdue.length)}, ${copy.dueTodayLabel(dueToday.length)}.\n${copy.listsLabel}: ${listSummary}`,
      );
      if (overdue.length > 0) {
        parts.push(`${copy.overdueOnlyLabel}: ${overdue.slice(0, 5).map((t: TodoTask) => safeInline(t.title)).join(', ')}`);
      }
    } else if (!todoResult.success) {
      parts.push(`\n${copy.todoLabel}: ${copy.apiErrorLabel}`);
    }
  }

  // Reminders & calendar — compact. Codex QA round 5: untrusted
  // strings (reminder body, event summary) now wrapped in safeInline
  // so injection patterns inside a calendar invite or reminder don't
  // reach the model as instructions.
  if (reminders.length > 0) {
    parts.push(`\n${copy.remindersTodayLabel}: ${reminders.map((r) => `${safeInline(r.message)} (${formatDateTime(r.remind_at)})`).join(', ')}`);
  }
  if (calendarResult.length > 0) {
    parts.push(`\n${copy.calendarTodayLabel(calendarResult.length)}: ${calendarResult.map((e) => `${formatDateTime(e.start)}-${formatDateTime(e.end)} ${safeInline(e.summary)}`).join(' | ')}`);
  }
  if (unreadMail) {
    const providerDetails = [
      unreadMail.outlookUnread != null ? `Outlook ${unreadMail.outlookUnread}` : null,
      unreadMail.gmailUnread != null ? `Gmail ${unreadMail.gmailUnread}` : null,
    ].filter(Boolean).join(' | ');
    parts.push(`\n${copy.mailLabel}: ${copy.unreadMailLabel(unreadMail.totalUnread)}${providerDetails ? ` (${providerDetails})` : ''}`);
  }

  // Garmin training summary (last 3 days)
  if (garminActivities.length > 0 || garminBodyBattery) {
    parts.push(`\n${copy.garminTrainingHeader}`);

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
          parts.push(`  ${d}: ${copy.noTrainingLogged}`);
        }
      }
    } else {
      parts.push(`  ${copy.noActivitiesLast3Days}`);
    }

    // Body battery
    if (garminBodyBattery && typeof garminBodyBattery === 'object') {
      const bb = garminBodyBattery as Record<string, unknown>;
      const events = bb.bodyBatteryValuesArray ?? bb.bodyBatteryEvents;
      if (Array.isArray(events) && events.length > 0) {
        // Get the latest value
        const latest = events[events.length - 1];
        const val = Array.isArray(latest) ? latest[1] : (latest as Record<string, unknown>)?.bodyBatteryLevel;
        if (val != null) parts.push(`  ${copy.bodyBatteryLabel}: ${val}/100`);
      }
      // Try charged/drained from daily summary fields
      const charged = bb.bodyBatteryChargedValue ?? bb.totalCharged;
      const drained = bb.bodyBatteryDrainedValue ?? bb.totalDrained;
      if (charged != null || drained != null) {
        parts.push(`  ${copy.chargedLabel}: ${charged ?? '?'} | ${copy.drainedLabel}: ${drained ?? '?'}`);
      }
    }
  }

  // Cross-domain shared context — SECURITY FIX: now uses actual userId
  const sharedCtx = hasUserScope ? getSharedMemorySummary(scopedUserId, tenantId) : '';
  if (sharedCtx) parts.push(sharedCtx);

  if (plannerBrief) {
    const coordination = plannerBrief.coordination;
    const plannerParts: string[] = [];
    if (coordination?.topPriority) plannerParts.push(`${copy.plannerTopPriorityLabel}: ${coordination.topPriority}`);
    if (coordination?.dayOrchestration?.title) plannerParts.push(`${copy.plannerDayPostureLabel}: ${coordination.dayOrchestration.title}`);
    if (coordination?.weekOrchestration?.title) plannerParts.push(`${copy.plannerWeekPostureLabel}: ${coordination.weekOrchestration.title}`);
    if (coordination?.nextBestAction?.summary) plannerParts.push(`${copy.plannerNextBestActionLabel}: ${coordination.nextBestAction.summary}`);
    if ((coordination?.executionOrder?.length ?? 0) > 0) plannerParts.push(`${copy.plannerExecutionOrderLabel}: ${coordination!.executionOrder.join(' → ')}`);
    if ((coordination?.blockers?.length ?? 0) > 0) plannerParts.push(`${copy.plannerBlockersLabel}: ${coordination!.blockers.map((blocker) => blocker.summary).join(' | ')}`);
    if ((coordination?.suggestedMoves?.length ?? 0) > 0) plannerParts.push(`${copy.plannerSuggestedMovesLabel}: ${coordination!.suggestedMoves.map((move) => move.title).join(' | ')}`);
    if ((coordination?.watchouts?.length ?? 0) > 0) plannerParts.push(`${copy.plannerWatchoutsLabel}: ${coordination!.watchouts.join(' | ')}`);
    if ((coordination?.handoffs?.length ?? 0) > 0) plannerParts.push(`${copy.plannerHandoffsLabel}: ${coordination!.handoffs.join(' | ')}`);
    if (plannerBrief.day.secretary.tradeoffNote) plannerParts.push(`${copy.plannerTradeoffLabel}: ${plannerBrief.day.secretary.tradeoffNote}`);
    if (plannerParts.length > 0) {
      parts.push(`\n${copy.plannerCoordinationHeader}`);
      parts.push(...plannerParts.map((entry) => `  ${entry}`));
    }
  }

  if (decisionCtx) parts.push(`\n${decisionCtx}`);
  const contractBlock = renderSharedDecisionContracts(decisionContracts);
  if (contractBlock) parts.push(`\n${contractBlock}`);

  const result = parts.join('\n');

  // Evict oldest entries if cache grows too large
  if (_stateContextCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = _stateContextCache.keys().next().value;
    if (oldest) _stateContextCache.delete(oldest);
  }
  _stateContextCache.set(cacheKey, { value: result, expiresAt: Date.now() + STATE_CONTEXT_TTL });
  const finalContext = await appendPromptContext(result, false);
  logger.debug({
    userId: scopedUserId,
    tenantId: scopedTenantKey,
    cacheShape: shape,
    cacheHit: false,
    promptBudgetChars,
    selectedSources: {
      tasks: !!taskProvider,
      calendar: hasCalendar,
      email: hasMail,
      reminders: hasUserScope && needs.reminders && remindersEnabled,
      garmin: hasGarmin,
      planner: hasUserScope && needs.planner,
      sharedDecisionContext: needsSharedDecisionContext,
    },
    estimatedContextChars: finalContext.length,
    estimatedInputTokens: Math.ceil(finalContext.length / 4),
  }, 'Secretary state context assembled');
  return finalContext;
}

function renderSharedDecisionContracts(contracts: SharedDecisionContracts): string {
  const entries = Object.entries(contracts).filter(([, contract]) => contract);
  if (entries.length === 0) return '';

  const lines = ['<shared_decision_contracts domain="secretary">'];
  for (const [peer, contract] of entries) {
    if (!contract) continue;
    const details = [
      contract.nonNegotiables.length > 0 ? `nonNegotiables=${contract.nonNegotiables.join(' | ')}` : null,
      contract.preferredWindows.length > 0 ? `preferredWindows=${contract.preferredWindows.join(' | ')}` : null,
      contract.fallbackIfDeferred.length > 0 ? `fallbackIfDeferred=${contract.fallbackIfDeferred.join(' | ')}` : null,
      contract.budgetMode ? `budgetMode=${contract.budgetMode}` : null,
      contract.publishDeadline ? `publishDeadline=${contract.publishDeadline}` : null,
      contract.notes.length > 0 ? `notes=${contract.notes.join(' | ')}` : null,
    ].filter(Boolean).join('; ');
    if (details.length > 0) {
      lines.push(`- ${peer}: ${details}`);
    }
  }
  lines.push('</shared_decision_contracts>');
  return lines.length > 2 ? lines.join('\n') : '';
}

function resolveSecretaryContextLanguage(userId: number | null): string {
  if (typeof userId !== 'number') return 'en-US';
  try {
    return getUserLanguage(userId);
  } catch {
    return 'en-US';
  }
}

function localizeSecretaryContext(language: string, ptPt: string, ptBr: string, en: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized.startsWith('pt-br')) return ptBr;
  if (normalized.startsWith('pt')) return ptPt;
  return en;
}

function secretaryStateContextCopy(language: string) {
  return {
    todayLabel: localizeSecretaryContext(language, 'Hoje', 'Hoje', 'Today'),
    todoLabel: localizeSecretaryContext(language, 'Tarefas', 'Tarefas', 'To Do'),
    listsLabel: localizeSecretaryContext(language, 'Listas', 'Listas', 'Lists'),
    overdueOnlyLabel: localizeSecretaryContext(language, 'Atrasadas', 'Atrasadas', 'Overdue'),
    remindersTodayLabel: localizeSecretaryContext(language, 'Lembretes de hoje', 'Lembretes de hoje', 'Reminders today'),
    calendarTodayLabel: (count: number) => localizeSecretaryContext(
      language,
      `Calendário de hoje (${count})`,
      `Calendário de hoje (${count})`,
      `Calendar today (${count})`,
    ),
    mailLabel: localizeSecretaryContext(language, 'Email', 'Email', 'Mail'),
    garminTrainingHeader: localizeSecretaryContext(language, '[RESUMO GARMIN DE TREINO]', '[RESUMO GARMIN DE TREINO]', '[GARMIN TRAINING SUMMARY]'),
    noTrainingLogged: localizeSecretaryContext(language, 'Sem treino registado', 'Sem treino registrado', 'No training logged'),
    noActivitiesLast3Days: localizeSecretaryContext(language, 'Sem atividades nos últimos 3 dias', 'Sem atividades nos últimos 3 dias', 'No activities in the last 3 days'),
    bodyBatteryLabel: localizeSecretaryContext(language, 'Body Battery', 'Body Battery', 'Body Battery'),
    chargedLabel: localizeSecretaryContext(language, 'Carregado', 'Carregado', 'Charged'),
    drainedLabel: localizeSecretaryContext(language, 'Gasto', 'Gasto', 'Drained'),
    apiErrorLabel: localizeSecretaryContext(language, 'erro de API', 'erro de API', 'API error'),
    plannerCoordinationHeader: localizeSecretaryContext(language, '[COORDENAÇÃO DO PLANNER]', '[COORDENAÇÃO DO PLANNER]', '[PLANNER COORDINATION]'),
    plannerTopPriorityLabel: localizeSecretaryContext(language, 'Prioridade principal', 'Prioridade principal', 'Top priority'),
    plannerDayPostureLabel: localizeSecretaryContext(language, 'Postura do dia', 'Postura do dia', 'Day posture'),
    plannerWeekPostureLabel: localizeSecretaryContext(language, 'Postura da semana', 'Postura da semana', 'Week posture'),
    plannerNextBestActionLabel: localizeSecretaryContext(language, 'Próxima melhor ação', 'Próxima melhor ação', 'Next best action'),
    plannerExecutionOrderLabel: localizeSecretaryContext(language, 'Sequência de execução', 'Sequência de execução', 'Execution order'),
    plannerBlockersLabel: localizeSecretaryContext(language, 'Bloqueios', 'Bloqueios', 'Blockers'),
    plannerSuggestedMovesLabel: localizeSecretaryContext(language, 'Movimentos sugeridos', 'Movimentos sugeridos', 'Suggested moves'),
    plannerWatchoutsLabel: localizeSecretaryContext(language, 'Atenções', 'Atenções', 'Watchouts'),
    plannerHandoffsLabel: localizeSecretaryContext(language, 'Passagens', 'Passagens', 'Handoffs'),
    plannerTradeoffLabel: localizeSecretaryContext(language, 'Trade-off', 'Trade-off', 'Tradeoff note'),
    pendingLabel: (count: number) => localizeSecretaryContext(language, `${count} pendentes`, `${count} pendentes`, `${count} pending`),
    overdueLabel: (count: number) => localizeSecretaryContext(language, `${count} atrasadas`, `${count} atrasadas`, `${count} overdue`),
    dueTodayLabel: (count: number) => localizeSecretaryContext(language, `${count} para hoje`, `${count} para hoje`, `${count} due today`),
    unreadMailLabel: (count: number) => localizeSecretaryContext(language, `${count} por ler`, `${count} não lidos`, `${count} unread`),
    // ── M8 PT-PT/PT-BR sweep over strings introduced in Wave 1 ──
    // M2 (agenda → provider sync): cron summary lines that may surface in
    // Daily Brief / Decision Center footers.
    syncedToCalendarLabel: localizeSecretaryContext(
      language,
      'Sincronizado ao calendário',
      'Sincronizado ao calendário',
      'Synced to calendar',
    ),
    awaitingCalendarSyncLabel: localizeSecretaryContext(
      language,
      'A aguardar sincronização do calendário',
      'Aguardando sincronização do calendário',
      'Awaiting calendar sync',
    ),
    calendarOfflineLabel: localizeSecretaryContext(
      language,
      'Calendário offline',
      'Calendário offline',
      'Calendar offline',
    ),
    // C2 (reasoning trail surface): user-facing rendering of trail nodes.
    secretaryReasoningHeader: localizeSecretaryContext(
      language,
      'Porque Secretary decidiu',
      'Porque Secretary decidiu',
      'Why Secretary decided',
    ),
    secretaryDecisionStatusLabel: localizeSecretaryContext(
      language,
      'Estado',
      'Estado',
      'Status',
    ),
    secretaryChoseLabel: localizeSecretaryContext(
      language,
      'Escolhido',
      'Escolhido',
      'Chosen',
    ),
    secretaryConsideredLabel: localizeSecretaryContext(
      language,
      'Considerado',
      'Considerado',
      'Considered',
    ),
    // C8 (weekly notes): one-line summary woven into coach-kernel notes.
    secretaryWeeklyContributionLabel: localizeSecretaryContext(
      language,
      'Secretary',
      'Secretary',
      'Secretary',
    ),
    secretaryCompressedSessionsLabel: (count: number) => localizeSecretaryContext(
      language,
      `comprimiu ${count} sessão${count === 1 ? '' : 'ões'}`,
      `comprimiu ${count} sessão${count === 1 ? '' : 'ões'}`,
      `compressed ${count} session${count === 1 ? '' : 's'}`,
    ),
    secretaryReflowedLabel: (count: number) => localizeSecretaryContext(
      language,
      `realocou ${count}`,
      `realocou ${count}`,
      `reflowed ${count}`,
    ),
    secretaryLongRunProtectedLabel: localizeSecretaryContext(
      language,
      'corrida longa protegida',
      'corrida longa protegida',
      'long run protected',
    ),
    // M5 (APNs anchoring): day-anchor words used by secretary-apns-anchoring.ts.
    apnsTodayAnchor: localizeSecretaryContext(language, 'Hoje', 'Hoje', 'Today'),
    apnsTomorrowAnchor: localizeSecretaryContext(language, 'Amanhã', 'Amanhã', 'Tomorrow'),
    apnsMinUnit: localizeSecretaryContext(language, 'min', 'min', 'min'),
  };
}

export async function handleSecretary(
  message: string,
  userId?: number,
  tenantId?: number,
  callerAbortSignal?: AbortSignal,
): Promise<DomainResponse> {
  const operation = (abortSignal?: AbortSignal) => handleSecretaryAdmitted(
    message,
    userId,
    tenantId,
    abortSignal,
  );
  if (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0) {
    return runWithSkillInferenceAccountAdmission({
      userId,
      abortSignal: callerAbortSignal,
    }, operation);
  }
  return operation(callerAbortSignal);
}

async function handleSecretaryAdmitted(
  message: string,
  userId: number | undefined,
  tenantId: number | undefined,
  accountAbortSignal?: AbortSignal,
): Promise<DomainResponse> {
  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
  const hasUserScope = typeof userId === 'number';
  const requestLocale = getCurrentChatRequestLocale();

  // ── Layer 1: Command Fastpath ──────────────────────────────────
  // Intercept deterministic data-read patterns before any AI call.
  // Identical Telegram-HTML output to the AI path; users can't tell the
  // difference. Errors fall through to the AI path automatically.
  // See src/services/secretary-fastpath.ts for the pattern dictionary.
  const fastpath = hasUserScope
    ? await tryFastpath(userId, message, requestLocaleToSecretaryLanguage(requestLocale), tenantId ?? userId)
    : { matched: false, response: null };
  if (fastpath.matched && fastpath.response && hasUserScope) {
    // Record in conversation history so the next AI turn has context
    // about what the user just asked. Tag the assistant message with the
    // pattern id so future debugging can spot fastpath responses in logs.
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    addScopedConversation(userId, 'user', message, tenantId);
    addScopedConversation(userId, 'assistant', `[fastpath:${fastpath.patternId}]\n${fastpath.response.text}`, tenantId);
    return fastpath.response;
  }
  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);

  const history = hasUserScope ? (getConversationHistory(userId, DOMAIN, tenantId) ?? []) : [];
  const scopedTenantId = hasUserScope ? (typeof tenantId === 'number' ? tenantId : userId) : null;
  const reasoningMode = hasUserScope
    ? getSecretaryReasoningV1Mode(process.env, { userId, tenantId: scopedTenantId })
    : 'off';
  // Layer 2: pass the message so buildStateContext can fetch only what
  // the message actually needs (saves ~1,000-2,000 input tokens on
  // intent-typed queries; ambiguous queries fall back to fetching all).
  const [baseStateContext, snapshot] = await Promise.all([
    reasoningMode === 'active' ? Promise.resolve('') : buildStateContext(message, userId, tenantId),
    reasoningMode !== 'off' && hasUserScope && scopedTenantId !== null
      ? buildSecretaryContextSnapshot({
        domain: DOMAIN,
        message,
        userId,
        tenantId: scopedTenantId,
      }).catch((err) => {
        logger.warn({ err, userId, tenantId: scopedTenantId }, 'Secretary structured context snapshot failed');
        return null;
      })
      : Promise.resolve(null),
  ]);
  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
  const reasoningSession: SecretaryReasoningSession = { mode: reasoningMode, snapshot };
  if (reasoningMode !== 'off' && snapshot) {
    logger.info({
      event: 'secretary.context_snapshot_built',
      userId,
      tenantId: scopedTenantId,
      snapshotId: snapshot.snapshotId,
      contextVersion: snapshot.contextVersion,
      evidenceCount: snapshot.facts.length,
      sourceHealth: snapshot.sourceHealth.map((source) => `${source.source}:${source.status}`),
    }, 'Secretary structured reasoning context snapshot built');
    for (const source of snapshot.sourceHealth) {
      if (source.status === 'failed' || source.status === 'permission_denied' || source.status === 'stale') {
        logger.warn({
          event: 'secretary.context_source_unavailable',
          userId,
          tenantId: scopedTenantId,
          snapshotId: snapshot.snapshotId,
          source: source.source,
          sourceStatus: source.status,
          reasonCode: source.reasonCode ?? null,
        }, 'Secretary structured context source is unavailable or stale');
      }
    }
  }
  if (reasoningMode === 'active' && !snapshot) {
    return { text: structuredReasoningUnavailableReply(userId), domain: DOMAIN };
  }
  const stateContextWithoutReplyLanguage = reasoningMode === 'active' && snapshot
    // Active v1 has one evidence authority. The legacy presentation string is
    // deliberately excluded so every factual claim must bind to snapshot IDs.
    ? buildSecretaryReasoningPrompt(snapshot)
    : baseStateContext;
  const replyLanguageBlock = buildChatReplyLanguagePromptBlock();
  const stateContext = replyLanguageBlock
    ? `${stateContextWithoutReplyLanguage}\n\n${replyLanguageBlock}`
    : stateContextWithoutReplyLanguage;

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
  const provider = getActiveProvider() || ensureActiveProvider();
  if (!provider) {
    if (!canUseDirectAnthropicFallback()) {
      return buildAIUnavailableResponse(DOMAIN, userId);
    }
    // Fallback to direct Anthropic — same call signatures the legacy
    // path used. The Anthropic SDK client is lazy-initialized inside
    // anthropic.ts so this static import is cheap; the test suites
    // can mock the imports normally without dynamic-require gotchas.
    return await handleSecretaryWithDirectAnthropic(
      userId, message, history, stateContext, directCallDomain, directContinueWithToolResults, userId, tenantId,
      reasoningSession,
      accountAbortSignal,
    );
  }

  if (reasoningMode === 'active' && snapshot && scopedTenantId !== null && typeof userId === 'number') {
    const selected = await runSecretaryStructuredReasoning({
      snapshot,
      userId,
      tenantId: scopedTenantId,
      mode: 'active',
      call: (prompt) => provider.callDomain(DOMAIN, [], message, prompt, {
        userId,
        tenantId: scopedTenantId,
        filteredTools: [],
        ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
      }),
      abortSignal: accountAbortSignal,
    });
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    const finalization = await persistSecretaryPreviewIfNeeded(selected, snapshot, userId, scopedTenantId);
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    const finalText = normalizeSecretaryReplyForRequest(finalization.text, userId);
    if (hasUserScope) {
      addScopedConversation(userId, 'user', message, tenantId);
      addScopedConversation(userId, 'assistant', finalText, tenantId);
    }
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    return { text: finalText, domain: DOMAIN };
  }

  const shadowRun = reasoningMode === 'shadow' && snapshot
    ? runSecretaryStructuredReasoning({
      snapshot,
      userId,
      tenantId: scopedTenantId ?? undefined,
      mode: 'shadow',
      call: (prompt) => provider.callDomain(DOMAIN, [], message, prompt, {
        userId,
        tenantId: scopedTenantId ?? undefined,
        filteredTools: [],
        ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
      }),
      abortSignal: accountAbortSignal,
    })
    : null;

  // Provider-agnostic tool loop — same shape as handleSimpleDomain
  // but with secretary's iteration cap (4 instead of 5) and the
  // empty-response fallback message that secretary specifically needs
  // because its tool loop is more brittle than the chat domains.
  let result = await provider.callDomain(DOMAIN, history, message, stateContext, {
    userId,
    tenantId,
    ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
  });
  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
  let finalText = result.text;

  logger.debug(
    { provider: provider.name, hasTools: result.toolCalls.length > 0 },
    'Secretary call dispatched via routing provider',
  );

  const toolConversation: AIToolResultMessage[] = [];
  const toolsUsed: string[] = [];
  let legacyWriteBlocked = false;
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
        throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
        if (reasoningSession.mode === 'active') {
          return {
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: JSON.stringify({
              ok: false,
              code: 'STRUCTURED_SNAPSHOT_IS_AUTHORITATIVE',
              message: 'Use only the evidence IDs in the current Secretary context snapshot.',
            }),
          };
        }
        if (isLegacySecretaryWriteTool(tc.name)) {
          legacyWriteBlocked = true;
          logger.warn(
            { userId, tenantId, tool: tc.name },
            'Blocked Secretary legacy chat write tool; action planner confirmation is required',
          );
          const blockedResult = buildLegacyWriteBlockedToolResult(tc.name);
          let content = JSON.stringify(blockedResult);
          if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
          return { type: 'tool_result' as const, tool_use_id: tc.id, content };
        }
        const toolResult = await executeScopedToolCall(tc.name, tc.input as Record<string, any>, userId, tenantId);
        throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
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
    // ADV-2: echo the issuing provider back so the routing layer pins the
    // continuation to it — open tool_use ids must never reach a different
    // provider (secretary is the cross-provider domain by default).
    result = await provider.continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation, {
      userId,
      tenantId,
      toolLoopProviderName: result.routedProviderName,
      ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
    });
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    finalText = result.text;
    logger.debug({ iteration: iterations, hasText: !!finalText, toolCalls: result.toolCalls.length }, 'Continue result');
  }

  if (legacyWriteBlocked) {
    finalText = buildLegacyWriteBlockedReply(userId);
  }

  // Guard against empty response (can happen after errors exhaust tool iterations)
  const providerResponsePresent = Boolean(finalText && finalText.trim());
  if (!providerResponsePresent) {
    finalText = unverifiedCompletionReply(userId);
  }
  const shadowBaselineEligible = !legacyWriteBlocked
    // Active structured reasoning returns through the dedicated branch above.
    // Fail closed if a future refactor reaches this legacy branch: finalized
    // suppress/unavailable copy is deterministic, not a model baseline.
    && reasoningSession.mode !== 'active'
    && result.toolCalls.length === 0
    && result.stopReason !== 'max_tokens'
    && result.stopReason !== 'length'
    && providerResponsePresent;

  if (!legacyWriteBlocked && reasoningSession.mode === 'active' && reasoningSession.snapshot) {
    const finalized = finalizeSecretaryReasoningText(finalText, reasoningSession.snapshot, userId);
    logger.info({
      userId,
      tenantId: scopedTenantId,
      valid: finalized.valid,
      behavior: finalized.behavior,
      reasonCodes: finalized.reasonCodes,
    }, 'Secretary structured reasoning envelope finalized');
    finalText = finalized.text;
  }

  // CHAT-M4: detect max_tokens truncation — if the AI hit the output
  // ceiling, append a note so the user knows the response is incomplete.
  // This catches the common case where a busy day's briefing exceeds
  // the token budget and gets cut mid-sentence.
  if (result?.stopReason === 'max_tokens' || result?.stopReason === 'length') {
    logger.warn({ userId, domain: DOMAIN, stopReason: result.stopReason }, 'Secretary response was truncated by max_tokens');
    finalText += '\n\n_⚠️ Response was cut short due to length. Try asking about a specific area (e.g. "just show my tasks" or "just calendar")._';
  }

  finalText = normalizeSecretaryReplyForRequest(finalText, userId);

  if (shadowRun) {
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    const shadow = await shadowRun;
    logger.info({
      event: 'secretary.shadow_outcome_compared',
      userId,
      tenantId: scopedTenantId,
      snapshotId: shadow.snapshotId,
      contextVersion: shadow.contextVersion,
      structuredValid: shadow.valid,
      structuredBehavior: shadow.behavior,
      structuredReasonCodes: shadow.reasonCodes,
      legacyResponsePresent: finalText.trim().length > 0,
      repairAttempted: shadow.repairAttempted,
    }, 'Secretary shadow reasoning outcome compared with legacy response');
  }

  // Store conversation — include tool summary so future turns have context
  if (hasUserScope) {
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    addScopedConversation(userId, 'user', message, tenantId);
    const storedText = toolsUsed.length > 0
      ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
      : finalText;
    addScopedConversation(userId, 'assistant', storedText, tenantId);
  }

  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
  return markChatShadowBaselineEligible(
    { text: finalText, domain: DOMAIN },
    shadowBaselineEligible,
  );
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
  uid: number | undefined,
  message: string,
  history: ReturnType<typeof getConversationHistory>,
  stateContext: string,
  callDomain: (...args: any[]) => Promise<{ text: string; toolCalls: any[]; stopReason: string }>,
  continueWithToolResults: (...args: any[]) => Promise<{ text: string; toolCalls: any[]; stopReason: string }>,
  userId: number | undefined,
  tenantId?: number,
  reasoningSession: SecretaryReasoningSession = { mode: 'off', snapshot: null },
  accountAbortSignal?: AbortSignal,
): Promise<DomainResponse> {
  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
  const structuredCall: SecretaryStructuredModelCall = (prompt) => callDomain(
    DOMAIN,
    [],
    message,
    prompt,
    {
      filteredTools: [],
      userId,
      tenantId,
      ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
    } satisfies CallDomainOptions,
    userId,
  );
  if (reasoningSession.mode === 'active' && reasoningSession.snapshot) {
    const selected = await runSecretaryStructuredReasoning({
      snapshot: reasoningSession.snapshot,
      userId: uid,
      tenantId,
      mode: 'active',
      call: structuredCall,
      abortSignal: accountAbortSignal,
    });
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    const finalization = typeof uid === 'number'
      ? await persistSecretaryPreviewIfNeeded(selected, reasoningSession.snapshot, uid, tenantId ?? uid)
      : selected;
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    const text = normalizeSecretaryReplyForRequest(finalization.text, uid);
    if (typeof uid === 'number') {
      addScopedConversation(uid, 'user', message, tenantId);
      addScopedConversation(uid, 'assistant', text, tenantId);
    }
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    return { text, domain: DOMAIN };
  }
  const shadowRun = reasoningSession.mode === 'shadow' && reasoningSession.snapshot
    ? runSecretaryStructuredReasoning({
      snapshot: reasoningSession.snapshot,
      userId: uid,
      tenantId,
      mode: 'shadow',
      call: structuredCall,
      abortSignal: accountAbortSignal,
    })
    : null;

  let result = await callDomain(
    DOMAIN,
    history,
    message,
    stateContext,
    {
      userId,
      tenantId,
      ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
    } satisfies CallDomainOptions,
    userId,
  );
  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
  let finalText = result.text;

  const toolConversation: any[] = [];
  const toolsUsed: string[] = [];
  let legacyWriteBlocked = false;
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
        throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
        if (reasoningSession.mode === 'active') {
          return {
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: JSON.stringify({
              ok: false,
              code: 'STRUCTURED_SNAPSHOT_IS_AUTHORITATIVE',
              message: 'Use only the evidence IDs in the current Secretary context snapshot.',
            }),
          };
        }
        if (isLegacySecretaryWriteTool(tc.name)) {
          legacyWriteBlocked = true;
          logger.warn(
            { userId, tenantId, tool: tc.name },
            'Blocked Secretary legacy direct-Anthropic write tool; action planner confirmation is required',
          );
          const blockedResult = buildLegacyWriteBlockedToolResult(tc.name);
          let content = JSON.stringify(blockedResult);
          if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
          return { type: 'tool_result' as const, tool_use_id: tc.id, content };
        }
        const toolResult = await executeScopedToolCall(tc.name, tc.input as Record<string, any>, userId, tenantId);
        throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
        let content = JSON.stringify(toolResult);
        if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
        return { type: 'tool_result' as const, tool_use_id: tc.id, content };
      })
    );

    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: toolResults },
    );

    result = await continueWithToolResults(
      DOMAIN,
      history,
      message,
      stateContext,
      toolConversation,
      userId,
      {
        userId,
        tenantId,
        ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
      } satisfies CallDomainOptions,
    );
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    finalText = result.text;
  }

  if (legacyWriteBlocked) {
    finalText = buildLegacyWriteBlockedReply(uid);
  }

  const providerResponsePresent = Boolean(finalText && finalText.trim());
  if (!providerResponsePresent) {
    finalText = unverifiedCompletionReply(uid);
  }
  const shadowBaselineEligible = !legacyWriteBlocked
    // Active structured reasoning returns through the dedicated branch above.
    // Keep any defensive legacy-path finalization out of shadow baselines.
    && reasoningSession.mode !== 'active'
    && result.toolCalls.length === 0
    && result.stopReason !== 'max_tokens'
    && result.stopReason !== 'length'
    && providerResponsePresent;

  if (!legacyWriteBlocked && reasoningSession.mode === 'active' && reasoningSession.snapshot) {
    const finalized = finalizeSecretaryReasoningText(finalText, reasoningSession.snapshot, uid);
    logger.info({
      userId: uid,
      tenantId,
      valid: finalized.valid,
      behavior: finalized.behavior,
      reasonCodes: finalized.reasonCodes,
    }, 'Secretary direct-provider structured reasoning envelope finalized');
    finalText = finalized.text;
  }

  finalText = normalizeSecretaryReplyForRequest(finalText, uid);

  if (shadowRun) {
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    const shadow = await shadowRun;
    logger.info({
      event: 'secretary.shadow_outcome_compared',
      userId: uid,
      tenantId,
      snapshotId: shadow.snapshotId,
      contextVersion: shadow.contextVersion,
      structuredValid: shadow.valid,
      structuredBehavior: shadow.behavior,
      structuredReasonCodes: shadow.reasonCodes,
      legacyResponsePresent: finalText.trim().length > 0,
      repairAttempted: shadow.repairAttempted,
    }, 'Secretary direct-provider shadow reasoning outcome compared with legacy response');
  }

  if (typeof uid === 'number') {
    throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
    addScopedConversation(uid, 'user', message, tenantId);
    const storedText = toolsUsed.length > 0
      ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
      : finalText;
    addScopedConversation(uid, 'assistant', storedText, tenantId);
  }

  throwIfSecretaryAccountModelWorkAborted(accountAbortSignal);
  return markChatShadowBaselineEligible(
    { text: finalText, domain: DOMAIN },
    shadowBaselineEligible,
  );
}

export function finalizeSecretaryReasoningText(
  raw: string,
  snapshot: SecretaryContextSnapshot,
  userId?: number,
  options: { phase?: 'read_only' | 'decision_preview'; repairAttempted?: boolean } = {},
): SecretaryReasoningFinalization {
  const parsed = parseAndValidateSecretaryReasoning(raw, snapshot);
  if (!parsed.ok || !parsed.result) {
    return {
      text: structuredReasoningUnavailableReply(userId),
      valid: false,
      behavior: 'defer',
      reasonCodes: [...new Set(parsed.issues.map((issue) => issue.code))],
      candidate: null,
      actionDraft: null,
      snapshotId: snapshot.snapshotId,
      contextVersion: snapshot.contextVersion,
      repairAttempted: options.repairAttempted === true,
    };
  }
  const outcome = selectSecretaryReasoningOutcome(snapshot, parsed.result, { phase: options.phase ?? 'read_only' });
  const isPT = typeof userId === 'number' && getUserLanguage(userId).startsWith('pt');
  if (outcome.behavior !== 'suppress' && outcome.userFacingText) {
    return {
      text: outcome.userFacingText,
      valid: true,
      behavior: outcome.behavior,
      reasonCodes: outcome.reasonCodes,
      candidate: outcome.candidate,
      actionDraft: outcome.candidate?.actionDraft ?? null,
      snapshotId: snapshot.snapshotId,
      contextVersion: snapshot.contextVersion,
      repairAttempted: options.repairAttempted === true,
    };
  }
  const text = outcome.behavior === 'suppress'
    ? (isPT
      ? 'Não encontrei uma sugestão útil e verificável para mostrar agora.'
      : 'I did not find a useful, verifiable suggestion to show right now.')
    : structuredReasoningUnavailableReply(userId);
  return {
    text,
    valid: true,
    behavior: outcome.behavior,
    reasonCodes: outcome.reasonCodes,
    candidate: outcome.candidate,
    actionDraft: outcome.candidate?.actionDraft ?? null,
    snapshotId: snapshot.snapshotId,
    contextVersion: snapshot.contextVersion,
    repairAttempted: options.repairAttempted === true,
  };
}

async function persistSecretaryPreviewIfNeeded(
  finalization: SecretaryReasoningFinalization,
  snapshot: SecretaryContextSnapshot,
  userId: number,
  tenantId: number,
): Promise<SecretaryReasoningFinalization> {
  if (!finalization.valid
    || !finalization.candidate
    || (finalization.behavior !== 'decision_center' && finalization.behavior !== 'conflict_review')) {
    return finalization;
  }
  const preview = await createSecretaryDecisionPreview({
    candidate: finalization.candidate,
    snapshot,
    userId,
    tenantId,
    locale: getUserLanguage(userId),
  });
  logger.info({
    event: 'secretary.decision_preview_processed',
    userId,
    tenantId,
    snapshotId: snapshot.snapshotId,
    contextVersion: snapshot.contextVersion,
    candidateId: finalization.candidate.candidateId,
    capabilityId: finalization.candidate.capabilityId ?? null,
    previewStatus: preview.status,
    decisionId: preview.decisionId ?? null,
    conflictDisposition: preview.conflictEvaluation?.disposition ?? null,
    reasonCodes: preview.reasonCodes,
  }, 'Secretary structured proposal processed through Decision Center');
  return {
    ...finalization,
    text: preview.userFacingText,
    reasonCodes: [...new Set([...finalization.reasonCodes, ...preview.reasonCodes])],
  };
}

async function runSecretaryStructuredReasoning(input: {
  snapshot: SecretaryContextSnapshot;
  userId?: number;
  tenantId?: number;
  mode: 'active' | 'shadow';
  call: SecretaryStructuredModelCall;
  abortSignal?: AbortSignal;
}): Promise<SecretaryReasoningFinalization> {
  let firstResult: AICallResult;
  try {
    firstResult = await input.call(buildSecretaryReasoningPrompt(input.snapshot));
  } catch (err) {
    rethrowSecretaryAccountModelWorkCancellation(err, input.abortSignal);
    logger.warn({
      event: 'secretary.candidate_schema_failed',
      failureType: err instanceof Error ? err.name : typeof err,
      userId: input.userId,
      tenantId: input.tenantId,
      snapshotId: input.snapshot.snapshotId,
      reasonCodes: ['model_call_failed'],
      mode: input.mode,
    }, 'Secretary structured candidate model call failed');
    return unavailableReasoningFinalization(input.snapshot, input.userId, ['model_call_failed'], false);
  }

  logger.info({
    event: 'secretary.candidate_generated',
    userId: input.userId,
    tenantId: input.tenantId,
    snapshotId: input.snapshot.snapshotId,
    contextVersion: input.snapshot.contextVersion,
    mode: input.mode,
    toolCallCount: firstResult.toolCalls.length,
  }, 'Secretary structured candidate response generated');

  const firstValidation: SecretaryReasoningValidationResult = firstResult.toolCalls.length > 0
    ? invalidToolCallValidation()
    : parseAndValidateSecretaryReasoning(firstResult.text, input.snapshot);
  if (firstValidation.ok && firstValidation.result) {
    const finalization = finalizeSecretaryReasoningText(firstResult.text, input.snapshot, input.userId, {
      // Shadow evaluates the same candidate policy as active mode but callers
      // never persist or execute its result. This makes parity telemetry useful
      // without changing user-visible behavior.
      phase: 'decision_preview',
    });
    emitSecretarySelectionTelemetry(finalization, input);
    return finalization;
  }

  logger.warn({
    event: 'secretary.candidate_schema_failed',
    userId: input.userId,
    tenantId: input.tenantId,
    snapshotId: input.snapshot.snapshotId,
    mode: input.mode,
    reasonCodes: [...new Set(firstValidation.issues.map((issue) => issue.code))],
    issueCount: firstValidation.issues.length,
    repairAttempted: true,
  }, 'Secretary structured candidate failed validation; one bounded repair will run');

  let repairResult: AICallResult;
  try {
    repairResult = await input.call(buildSecretaryReasoningRepairPrompt(input.snapshot, firstValidation.issues));
  } catch (err) {
    rethrowSecretaryAccountModelWorkCancellation(err, input.abortSignal);
    logger.warn({
      event: 'secretary.candidate_schema_failed',
      failureType: err instanceof Error ? err.name : typeof err,
      userId: input.userId,
      tenantId: input.tenantId,
      snapshotId: input.snapshot.snapshotId,
      mode: input.mode,
      reasonCodes: ['schema_repair_call_failed'],
      repairAttempted: true,
    }, 'Secretary structured candidate repair call failed');
    return unavailableReasoningFinalization(input.snapshot, input.userId, ['schema_repair_call_failed'], true);
  }

  const repaired = repairResult.toolCalls.length > 0
    ? unavailableReasoningFinalization(input.snapshot, input.userId, ['tool_calls_not_allowed'], true)
    : finalizeSecretaryReasoningText(repairResult.text, input.snapshot, input.userId, {
      phase: 'decision_preview',
      repairAttempted: true,
    });
  if (!repaired.valid) {
    logger.warn({
      event: 'secretary.candidate_schema_failed',
      userId: input.userId,
      tenantId: input.tenantId,
      snapshotId: input.snapshot.snapshotId,
      mode: input.mode,
      reasonCodes: repaired.reasonCodes,
      repairAttempted: true,
    }, 'Secretary structured candidate remained invalid after bounded repair');
  }
  emitSecretarySelectionTelemetry(repaired, input);
  return repaired;
}

function invalidToolCallValidation(): SecretaryReasoningValidationResult {
  return {
    ok: false,
    issues: [{ code: 'invalid_schema', path: '$.toolCalls' }],
  };
}

function unavailableReasoningFinalization(
  snapshot: SecretaryContextSnapshot,
  userId: number | undefined,
  reasonCodes: string[],
  repairAttempted: boolean,
): SecretaryReasoningFinalization {
  return {
    text: structuredReasoningUnavailableReply(userId),
    valid: false,
    behavior: 'defer',
    reasonCodes,
    candidate: null,
    actionDraft: null,
    snapshotId: snapshot.snapshotId,
    contextVersion: snapshot.contextVersion,
    repairAttempted,
  };
}

function emitSecretarySelectionTelemetry(
  finalization: SecretaryReasoningFinalization,
  input: { snapshot: SecretaryContextSnapshot; userId?: number; tenantId?: number; mode: 'active' | 'shadow' },
): void {
  logger.info({
    event: finalization.behavior === 'suppress' ? 'secretary.candidate_suppressed' : 'secretary.candidate_selected',
    userId: input.userId,
    tenantId: input.tenantId,
    snapshotId: input.snapshot.snapshotId,
    contextVersion: input.snapshot.contextVersion,
    mode: input.mode,
    valid: finalization.valid,
    behavior: finalization.behavior,
    candidateId: finalization.candidate?.candidateId ?? null,
    capabilityId: finalization.candidate?.capabilityId ?? null,
    reasonCodes: finalization.reasonCodes,
    repairAttempted: finalization.repairAttempted,
  }, 'Secretary structured reasoning candidate finalized');
}

function structuredReasoningUnavailableReply(userId?: number): string {
  const isPT = typeof userId === 'number' && getUserLanguage(userId).startsWith('pt');
  return isPT
    ? 'Não consegui verificar contexto suficiente para responder com segurança. Tenta novamente ou faz uma pergunta mais específica.'
    : 'I could not verify enough context to answer safely. Please try again or ask a more specific question.';
}

function unverifiedCompletionReply(userId?: number): string {
  const isPT = typeof userId === 'number' && getUserLanguage(userId).startsWith('pt');
  return isPT
    ? 'Não consegui concluir nem verificar o pedido. Não estou a afirmar que qualquer alteração tenha sido feita.'
    : 'I could not complete or verify the request. I am not claiming that any change was made.';
}
