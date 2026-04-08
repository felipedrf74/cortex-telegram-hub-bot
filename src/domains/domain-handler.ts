// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DomainResponse } from './types';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { listTodos } from '../state/todos';
import { getSharedMemorySummary } from '../state/shared-memory';
import { now, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import { getActivePlanSummary } from '../services/training-plans';
import { getActiveProvider } from '../services/provider-registry';
import { getDailyContext } from '../services/context-engine';
import type { AIToolResultMessage } from '../services/ai-provider';
import { logger } from '../utils/logger';
import type { CoachRecommendation } from '../services/garmin-coach';
import { LRUMap } from '../utils/lru-map';

// ─── Last Coach Briefing State (per-user, in-memory) ─────────────────

interface LastCoachState {
  recommendations: CoachRecommendation[];
  briefingSummary: string;
  timestamp: number;
}

// LRU-bounded at 500 users. At 1 user that's ~1 entry; at multi-user scale
// (up to 500 active) it's naturally bounded and the oldest user's coach
// state gets evicted when a 501st arrives. Audit Month 2 #3.
//
// Size chosen: 500 > any plausible active-user count for a single-server
// deployment. Each entry is ~a few KB (recommendations array + summary
// string truncated to 500 chars), so 500 × ~2KB = ~1MB max footprint.
const lastCoachStates = new LRUMap<number, LastCoachState>(500);
const COACH_STATE_TTL = 12 * 60 * 60 * 1000; // 12 hours

/** Store the latest coach briefing so the triathlon domain can reference it */
export function setLastCoachState(userId: number, recs: CoachRecommendation[], summary: string): void {
  lastCoachStates.set(userId, { recommendations: recs, briefingSummary: summary, timestamp: Date.now() });
}

/** Get the last coach state if it's still fresh (within TTL). */
export function getLastCoachState(userId: number): LastCoachState | null {
  const state = lastCoachStates.get(userId);
  if (!state || Date.now() - state.timestamp > COACH_STATE_TTL) return null;
  return state;
}

/**
 * Shared state context builder for simple domains (triathlon, content).
 * Only fetches local to-dos — no external API calls needed.
 */
export async function buildSimpleStateContext(domain: DomainName, userId?: number): Promise<string> {
  const parts: string[] = [];
  parts.push(`Today: ${now().toFormat('cccc, LLLL dd yyyy, HH:mm')} (Europe/Lisbon)`);

  const todos = listTodos(userId ?? 0, { domain, status: 'pending' });
  if (todos.length > 0) {
    const label = domain.charAt(0).toUpperCase() + domain.slice(1);
    parts.push(`\n${label} to-dos (${todos.length}):`);
    for (const t of todos) {
      let line = `- [${t.priority}] ${t.title}`;
      if (t.due_date) line += ` (due: ${formatDateTime(t.due_date)})`;
      parts.push(line);
    }
  }

  // Inject last coach recommendations for triathlon domain
  if (domain === 'triathlon' && userId) {
    const coachState = getLastCoachState(userId);
    if (coachState && coachState.recommendations.length > 0) {
      parts.push(`\n[COACH RECOMMENDATIONS — ${new Date(coachState.timestamp).toISOString()}]`);
      parts.push('CRITICAL: These are recommendations for EXISTING calendar events based on Garmin data already analyzed (sleep, HRV, body battery, stress, training readiness).');
      parts.push('When the athlete asks to "apply recommendations" or "apply changes" or similar:');
      parts.push('- IMMEDIATELY apply the recommendations below using tool calls — do NOT ask for additional information');
      parts.push('- The analysis was already done with real Garmin biometric data — all decisions are already made');
      parts.push('- NEVER use create_calendar_event — the events ALREADY EXIST on the calendar');
      parts.push('- For KEEP: do nothing (no tool call needed)');
      parts.push('- For MODIFY/SWAP: use update_calendar_event with the exact event_id and calendar_source below');
      parts.push('- For REST/cancel: use delete_calendar_event with the exact event_id and calendar_source below');
      parts.push('- Always include calendar_source in your tool call');
      parts.push('- After applying, confirm what was changed in a brief summary\n');
      for (const rec of coachState.recommendations) {
        const details = [
          `action: ${rec.action}`,
          `event_id: "${rec.eventId}"`,
          `calendar_source: "${rec.source}"`,
          `current_title: "${rec.originalTitle}"`,
        ];
        if (rec.newTitle && rec.action !== 'KEEP') details.push(`new_title: "${rec.newTitle}"`);
        if (rec.newStart) details.push(`new_start: "${rec.newStart}"`);
        if (rec.newEnd) details.push(`new_end: "${rec.newEnd}"`);
        details.push(`summary: ${rec.summary}`);
        parts.push(`  ${details.join(' | ')}`);
      }
      parts.push('\nCorrect tool usage examples:');
      parts.push('- MODIFY/SWAP → update_calendar_event(event_id="...", calendar_source="outlook", new_title="...", new_start="...", new_end="...")');
      parts.push('- REST/cancel → delete_calendar_event(event_id="...", calendar_source="outlook")');
    }
  }

  // Active training plan context for triathlon domain
  if (domain === 'triathlon' && userId) {
    try {
      const planSummary = getActivePlanSummary(userId);
      if (planSummary) parts.push(`\n${planSummary}`);
    } catch {
      // Training plan tables may not exist yet — skip silently
    }
  }

  // Cross-domain shared context
  const sharedCtx = getSharedMemorySummary(userId ?? 0);
  if (sharedCtx) parts.push(sharedCtx);

  // Daily cross-domain context summary (TASK-16a).
  // Pre-built at 5 AM and refreshed on every task write — replaces the
  // 5+ speculative tool calls the AI used to make to gather "what's my
  // day looking like?" before answering. Cost: ~500 tokens per message
  // instead of ~1350. See src/services/context-engine.ts.
  if (userId) {
    const dailyContext = getDailyContext(userId);
    if (dailyContext) {
      parts.push('\n--- Daily Context ---\n' + dailyContext);
    }
  }

  return parts.join('\n');
}

/**
 * Shared tool-use loop for non-secretary domains.
 * Routes through the active AI provider (Anthropic, Gemini, or OpenAI)
 * via the TaskRoutingProvider, which handles fallback and circuit breaker.
 *
 * IMPORTANT: This function is PROVIDER-AGNOSTIC. It uses the AIProvider
 * interface, not Anthropic-specific types. The provider routing layer
 * decides which AI backend handles each domain.
 */
export async function handleSimpleDomain(
  domain: DomainName,
  message: string,
  maxIterations = 5,
  userId?: number,
  maxTokensOverride?: number,
): Promise<DomainResponse> {
  const history = getConversationHistory(userId ?? 0, domain);
  const stateContext = await buildSimpleStateContext(domain, userId);

  try {
    // Get the active routing provider (handles fallback + circuit breaker)
    const provider = getActiveProvider();
    if (!provider) {
      // Fallback to direct Anthropic if routing provider not initialized
      const { callDomain, continueWithToolResults } = require('../services/anthropic');
      return await handleWithDirectCalls(domain, history, message, stateContext, maxIterations, userId, maxTokensOverride, callDomain, continueWithToolResults);
    }

    // Route through the provider-agnostic interface
    let result = await provider.callDomain(domain, history, message, stateContext, maxTokensOverride);
    let finalText = result.text;

    logger.debug({ domain, provider: provider.name, hasTools: result.toolCalls.length > 0 }, 'Domain call completed via routing provider');

    // Provider-agnostic tool conversation (no Anthropic-specific types)
    const toolConversation: AIToolResultMessage[] = [];
    const toolsUsed: string[] = [];
    let iterations = 0;

    while (result.toolCalls.length > 0 && iterations < maxIterations) {
      iterations++;

      // Build assistant content (provider-agnostic format)
      const assistantContent: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
      if (result.text) assistantContent.push({ type: 'text', text: result.text });
      for (const tc of result.toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        toolsUsed.push(tc.name);
      }

      // Execute tool calls in parallel
      const toolResults = await Promise.all(
        result.toolCalls.map(async (tc) => {
          const toolResult = await executeToolCall(tc.name, tc.input as Record<string, any>, userId);
          let content = JSON.stringify(toolResult);
          if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
          return { type: 'tool_result' as const, tool_use_id: tc.id, content };
        }),
      );

      // Build tool conversation in provider-agnostic format
      toolConversation.push(
        { role: 'assistant' as const, content: assistantContent as any },
        { role: 'user' as const, content: toolResults },
      );

      // Continue with tool results via the routing provider
      result = await provider.continueWithToolResults(domain, history, message, stateContext, toolConversation);
      finalText = result.text;
    }

    // Store conversation
    addToConversation(userId ?? 0, domain, 'user', message);
    const storedText = toolsUsed.length > 0
      ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
      : finalText;
    addToConversation(userId ?? 0, domain, 'assistant', storedText);

    return { text: finalText, domain };
  } catch (err: unknown) {
    const { AITimeoutError } = require('../utils/timeout');
    if (err instanceof AITimeoutError) {
      return { text: '⏱ Sorry, I took too long to respond. Please try again with a simpler question.', domain };
    }
    throw err;
  }
}

/**
 * Fallback: direct Anthropic calls when routing provider isn't initialized.
 * This preserves backward compatibility during startup or if routing fails to init.
 */
async function handleWithDirectCalls(
  domain: DomainName, history: any[], message: string, stateContext: string,
  maxIterations: number, userId: number | undefined, maxTokensOverride: number | undefined,
  callDomainFn: (...args: any[]) => Promise<any>, continueWithToolResultsFn: (...args: any[]) => Promise<any>,
): Promise<DomainResponse> {
  let result = await callDomainFn(domain, history, message, stateContext, maxTokensOverride, userId);
  let finalText = result.text;

  const toolConversation: any[] = [];
  const toolsUsed: string[] = [];
  let iterations = 0;

  while (result.toolCalls.length > 0 && iterations < maxIterations) {
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
        // Truncate large results (consistent with primary path)
        if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
        return { type: 'tool_result' as const, tool_use_id: tc.id, content };
      }),
    );
    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: toolResults },
    );
    result = await continueWithToolResultsFn(domain, history, message, stateContext, toolConversation, userId);
    finalText = result.text;
  }

  addToConversation(userId ?? 0, domain, 'user', message);
  const storedText = toolsUsed.length > 0
    ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
    : finalText;
  addToConversation(userId ?? 0, domain, 'assistant', storedText);

  return { text: finalText, domain };
}
