// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { MinimalChatPlannerInput } from './simple-task';

type TaskSubtaskAction = 'create_task_with_subtasks' | 'add_subtasks_to_task';

interface MinimalTaskSubtasksStep {
  action: TaskSubtaskAction;
  risk: 'safe_write';
  requiredArgsPresent: boolean;
  args: Record<string, unknown>;
  idempotencyKey: string;
}

interface MinimalTaskSubtasksPlan {
  steps: MinimalTaskSubtasksStep[];
}

export function parseTaskWithSubtasksIntent(input: MinimalChatPlannerInput): MinimalTaskSubtasksPlan | null {
  const parsed = extractTaskWithSubtasks(input.text);
  if (!parsed) return null;
  const action: TaskSubtaskAction = parsed.mode === 'add' ? 'add_subtasks_to_task' : 'create_task_with_subtasks';
  return {
    steps: [{
      action,
      risk: 'safe_write',
      requiredArgsPresent: Boolean(parsed.title && parsed.subtasks.length > 0),
      args: {
        title: parsed.title,
        subtasks: parsed.subtasks,
      },
      idempotencyKey: stableTaskSubtasksKey(input, action, parsed.title, parsed.subtasks),
    }],
  };
}

function extractTaskWithSubtasks(text: string): { mode: 'create' | 'add'; title: string; subtasks: string[] } | null {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const inline = trimmed.match(/^\s*(?:create|make|cria|criar|crie|crear|crea)\s+(?:a\s+|uma?\s+|una?\s+)?(?:task|tarefa|tarea)\s+(?:(?:called|named|chamada?|chamado|llamada?|llamado|para|for)\s+)?(.+?)\s+(?:with|com|con)\s+(?:sub\s*tasks?|subtasks?|subtarefas?|subtareas?)\s+(.+)$/i);
  if (inline?.[1] && inline?.[2]) {
    const title = inline[1].trim().replace(/[.!?]+$/g, '');
    const subtasks = splitSubtaskItems(inline[2]);
    if (title && subtasks.length > 0) {
      return { mode: 'create', title: title.slice(0, 180), subtasks };
    }
  }
  if (lines.length < 2 && !trimmed.includes(':')) return null;

  const header = lines[0] ?? trimmed;
  const mode: 'create' | 'add' = /\b(?:add|adicionar|adicione|agregar|añadir|anadir)\b.*\b(?:subtasks|subtarefas|subtareas)\b/i.test(header)
    ? 'add'
    : 'create';
  const titleMatch = header.match(/(?:task|tarefa|tarea)\s+(?:(?:called|named|chamada?|chamado|llamada?|llamado|for|para)\s+)?(.+?)(?:\s*:\s*|$)/i)
    ?? header.match(/(?:create|crie|criar|cria|crear|crea)\s+(?:a\s+|uma?\s+|una?\s+)?(?:task|tarefa|tarea)\s+(?:(?:called|named|chamada?|chamado|llamada?|llamado|for|para)\s+)?(.+?)(?:\s*:\s*|$)/i);
  const title = titleMatch?.[1]?.trim().replace(/[.!?]+$/g, '');
  if (!title) return null;

  const tail = lines.length > 1
    ? lines.slice(1).join('\n')
    : trimmed.slice(header.length).replace(/^[:\s]+/, '');
  const subtasks = splitSubtaskItems(tail);
  if (subtasks.length === 0) return null;
  return { mode, title: title.slice(0, 180), subtasks };
}

function splitSubtaskItems(value: string): string[] {
  const trimmed = value.trim().replace(/[.!?]+$/g, '');
  const separator = /[\r\n,;]|(?:\s+\band\b\s+)|(?:\s+\be\b\s+)|(?:\s+\by\b\s+)/i.test(trimmed)
    ? /\r?\n|[,;]|\s+\band\b\s+|\s+\be\b\s+|\s+\by\b\s+/i
    : /\s+/;
  return trimmed
    .split(separator)
    .map((item) => item.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((item) => item.length > 0)
    .slice(0, 20);
}

function stableTaskSubtasksKey(
  input: MinimalChatPlannerInput,
  action: TaskSubtaskAction,
  title: string,
  subtasks: string[],
): string {
  return crypto
    .createHash('sha256')
    .update(`${input.tenantId}:${input.userId}:${input.conversationId}:${input.messageId}:${action}:${title}:${subtasks.join('|')}`)
    .digest('hex')
    .slice(0, 32);
}
