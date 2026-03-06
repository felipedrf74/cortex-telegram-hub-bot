import { DomainName, DomainResponse } from './types';
import { callDomain, continueWithToolResults } from '../services/anthropic';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { listTodos } from '../state/todos';
import { now, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import Anthropic from '@anthropic-ai/sdk';

const DOMAIN: DomainName = 'triathlon';

async function buildStateContext(): Promise<string> {
  const parts: string[] = [];
  parts.push(`Today: ${now().toFormat('cccc, LLLL dd yyyy, HH:mm')} (Europe/Lisbon)`);

  const todos = listTodos({ domain: 'triathlon', status: 'pending' });
  if (todos.length > 0) {
    parts.push(`\nTriathlon to-dos (${todos.length}):`);
    for (const t of todos) {
      let line = `- [${t.priority}] ${t.title}`;
      if (t.due_date) line += ` (due: ${formatDateTime(t.due_date)})`;
      parts.push(line);
    }
  }

  return parts.join('\n');
}

export async function handleTriathlon(message: string): Promise<DomainResponse> {
  const history = getConversationHistory(DOMAIN);
  const stateContext = await buildStateContext();

  let result = await callDomain(DOMAIN, history, message, stateContext);
  let finalText = result.text;

  const toolConversation: Anthropic.MessageParam[] = [];
  let iterations = 0;
  while (result.toolCalls.length > 0 && iterations < 5) {
    iterations++;
    const assistantContent: Anthropic.ContentBlock[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text } as Anthropic.ContentBlock);
    for (const tc of result.toolCalls) {
      assistantContent.push(tc);
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
    result = await continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation);
    finalText = result.text;
  }

  addToConversation(DOMAIN, 'user', message);
  addToConversation(DOMAIN, 'assistant', finalText);

  return { text: finalText, domain: DOMAIN };
}
