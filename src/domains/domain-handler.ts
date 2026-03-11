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
      parts.push(`\n[LAST COACH BRIEFING — ${new Date(coachState.timestamp).toISOString()}]`);
      parts.push('The athlete received these coach recommendations. They can ask to apply them via calendar tools:');
      for (const rec of coachState.recommendations) {
        parts.push(`- ${rec.action}: "${rec.originalTitle}" (eventId: ${rec.eventId}, source: ${rec.source})${rec.newTitle ? ` → "${rec.newTitle}"` : ''}${rec.newStart ? ` time: ${rec.newStart}–${rec.newEnd}` : ''} | ${rec.summary}`);
      }
      parts.push('When the athlete asks to apply a recommendation, use the update_calendar_event tool with the eventId above. For REST actions, update the title to the cancelled version.');
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
): Promise<DomainResponse> {
  const history = getConversationHistory(domain);
  const stateContext = await buildSimpleStateContext(domain, userId);

  let result = await callDomain(domain, history, message, stateContext);
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
