import { DomainName, DomainResponse } from './types';
import { callDomain, continueWithToolResults } from '../services/anthropic';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { listTodos } from '../state/todos';
import { getSharedMemorySummary } from '../state/shared-memory';
import { now, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Shared state context builder for simple domains (triathlon, content).
 * Only fetches local to-dos — no external API calls needed.
 */
export async function buildSimpleStateContext(domain: DomainName): Promise<string> {
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
  maxIterations = 5
): Promise<DomainResponse> {
  const history = getConversationHistory(domain);
  const stateContext = await buildSimpleStateContext(domain);

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
