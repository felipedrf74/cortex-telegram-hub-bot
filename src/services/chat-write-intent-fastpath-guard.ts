// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from './calendar-natural-language-parser';

const MUTATION_VERB_RE = /\b(?:create|add|make|mark|complete|finish|close|update|edit|delete|remove|cancel|reschedule|move|send|publish|pay|refund|cria|criar|crie|adiciona|adicionar|marca|marcar|conclui|concluir|finaliza|finalizar|feito|feita|edita|editar|apaga|apagar|remove|remover|cancela|cancelar|adia|adiar|move|mover|envia|enviar|publica|publicar|paga|pagar|reembolsa|reembolsar|crea|crear|agrega|agregar|marca|marcar|completa|completar|cancela|cancelar|mueve|mover|envia|enviar)\b/;
const MUTABLE_OBJECT_RE = /\b(?:task|tasks|todo|to-do|tarefa|tarefas|tarea|tareas|calendar|agenda|event|meeting|evento|reuniao|reuniao|email|mail|message|mensagem|finance|financa|financas|training|treino|notification|notificacao|decision|decisao|script|roteiro|content|conteudo|recipe|receita)\b/;
const TASK_CREATE_RE = /\b(?:create|add|make|cria|criar|crie|adiciona|adicionar|bota|botar|coloca|colocar|poe|por|mete|meter|crea|crear|agrega|agregar)\b[\s\S]{0,80}\b(?:task|todo|to-do|tarefa|tarefas|tarea|tareas)\b/;
const TASK_COMPLETE_RES = [
  /\b(?:mark|complete|finish|set|marca|marcar|conclui|concluir|finaliza|finalizar|completa|completar)\b[\s\S]{0,120}\b(?:task|tarefa|tarea|done|complete|completed|concluida|concluido|feita|feito|hecha|hecho)\b/,
  /\b(?:task|tarefa|tarea)\b[\s\S]{0,120}\b(?:done|complete|completed|concluida|concluido|feita|feito|hecha|hecho)\b/,
];
const SUBTASK_MARKER_RE = /\b(?:sub\s*-?\s*tasks?|subtasks?|subtarefas?|subtareas?|check\s*-?\s*list|checklist|steps?|itens?|items?)\b/;
const TASK_WITH_COLON_LIST_RE = /\b(?:task|todo|to-do|tarefa|tarefas|tarea|tareas)\b[\s\S]{0,120}:\s*\S+[\r\n,;]+[\s\S]*\S+/;

const NEGATED_WRITE_RE = /\b(?:do\s+not|don't|dont|never|nao|não|no)\s+(?:mark|complete|finish|create|add|delete|remove|cancel|send|publish|marque|marca|conclua|concluir|crie|criar|adicione|apague|apagar|remova|remover|cancele|cancelar|envie|enviar|publique|publicar|marques|completes|crear|agregar|canceles)\b/;
const HYPOTHETICAL_WRITE_RE = /^(?:should\s+i|how\s+do\s+i|can\s+i|could\s+i|devo|como\s+eu|como\s+posso|posso|deberia|debería|como\s+puedo)\b/;
const READ_QUESTION_RE = /^(?:what|which|how\s+many|show|list|tell\s+me|o\s+que|que\s+tenho|qual|quais|quantos|mostra|liste|diz-me|diga-me|que|cuantos|cuántos|muestra|lista)\b/;

/**
 * Natural-language write requests must not be swallowed by read-only
 * shortcuts. This guard is intentionally conservative: explicit slash/button
 * surfaces still stay token-zero, but ordinary prose with likely mutation
 * intent should reach the action/reasoning pipeline first.
 */
export function shouldBypassChatReadFastPathsForWriteIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return false;
  const folded = foldCalendarText(trimmed);
  if (NEGATED_WRITE_RE.test(folded) || HYPOTHETICAL_WRITE_RE.test(folded)) return false;
  if (READ_QUESTION_RE.test(folded) && !TASK_CREATE_RE.test(folded) && !hasTaskCompleteIntent(folded)) return false;
  if (hasTaskWithSubtasksIntent(trimmed, folded)) return true;
  if (hasTaskCompleteIntent(folded)) return true;
  return MUTATION_VERB_RE.test(folded) && MUTABLE_OBJECT_RE.test(folded);
}

function hasTaskWithSubtasksIntent(rawText: string, folded: string): boolean {
  if (!TASK_CREATE_RE.test(folded)) return false;
  if (SUBTASK_MARKER_RE.test(folded)) return true;
  return TASK_WITH_COLON_LIST_RE.test(rawText) || TASK_WITH_COLON_LIST_RE.test(folded);
}

function hasTaskCompleteIntent(folded: string): boolean {
  return TASK_COMPLETE_RES.some((pattern) => pattern.test(folded));
}
