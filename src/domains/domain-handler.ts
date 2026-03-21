import { DomainName, DomainResponse } from './types';
import { callDomain, continueWithToolResults } from '../services/anthropic';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { listTodos } from '../state/todos';
import { getSharedMemorySummary } from '../state/shared-memory';
import { now, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import Anthropic from '@anthropic-ai/sdk';
import type { CoachRecommendation } from '../services/garmin-coach';

// ─── Last Coach Briefing State (per-user, in-memory) ─────────────────

interface LastCoachState {
  recommendations: CoachRecommendation[];
  briefingSummary: string;
  timestamp: number;
}

const lastCoachStates = new Map<number, LastCoachState>();
const COACH_STATE_TTL = 12 * 60 * 60 * 1000; // 12 hours

/** Store the latest coach briefing so the triathlon domain can reference it */
export function setLastCoachState(userId: number, recs: CoachRecommendation[], summary: string): void {
  lastCoachStates.set(userId, { recommendations: recs, briefingSummary: summary, timestamp: Date.now() });
}

/** Get the last coach state if it's still fresh */
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

  const todos = listTodos({ domain, status: 'pending' });
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

  // Cross-domain shared context
  const sharedCtx = getSharedMemorySummary();
  if (sharedCtx) parts.push(sharedCtx);

  return parts.join('\n');
}

/**
 * Shared tool-use loop for non-secretary domains.
 * Runs up to `maxIterations` rounds of tool calls, collecting results.
 */
export async function handleSimpleDomain(
  domain: DomainName,
  message: string,
  maxIterations = 5,
  userId?: number,
  maxTokensOverride?: number,
): Promise<DomainResponse> {
  const history = getConversationHistory(domain);
  const stateContext = await buildSimpleStateContext(domain, userId);

  let result = await callDomain(domain, history, message, stateContext, maxTokensOverride);
  let finalText = result.text;

  const toolConversation: Anthropic.MessageParam[] = [];
  const toolsUsed: string[] = [];
  let iterations = 0;
  while (result.toolCalls.length > 0 && iterations < maxIterations) {
    iterations++;
    const assistantContent: Anthropic.ContentBlock[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text } as Anthropic.ContentBlock);
    for (const tc of result.toolCalls) {
      assistantContent.push(tc);
      toolsUsed.push(tc.name);
    }
    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc) => ({
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content: JSON.stringify(await executeToolCall(tc.name, tc.input as Record<string, any>)),
      }))
    );
    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: toolResults },
    );
    result = await continueWithToolResults(domain, history, message, stateContext, toolConversation);
    finalText = result.text;
  }

  addToConversation(domain, 'user', message);
  const storedText = toolsUsed.length > 0
    ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
    : finalText;
  addToConversation(domain, 'assistant', storedText);

  return { text: finalText, domain };
}
