// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { makeStep } from '../../skills/step-builder';
import type { ChatActionPlan, ChatPlannerInput } from '../types';
import {
  buildNeedsInputPlan,
  buildPlanFromSteps,
} from './plan-builder';

const MAX_TASK_TITLE_LENGTH = 500;
const MAX_SUBTASK_TITLE_LENGTH = 200;
const MAX_SUBTASKS = 25;
const SUBTASK_MARKER_PATTERNS = /\b(sub\s*tasks?|subtasks?|subtarefas?|subtareas?|checklist(?:\s+items?)?|steps?|itens?|elementos?)\b/i;
const SUBTASK_SECOND_ACTION = /\b(and|e|y)\s+(?:remind|schedule|reschedule|cancel|delete|move|plan|mark|create|add|lembrar|agenda|agendar|remarcar|cancela|cancelar|apaga|apagar|mover|marcar|cria|criar|crear|programar|recordar|eliminar|borrar|añade|anade)\b/i;
const TASK_DISCOURSE_TAILS = [
  /\bfor now(?:\s+that'?s\s+it)?\.?$/i,
  /\bthat'?s\s+(?:it|all)\.?$/i,
  /\band\s+that'?s\s+all\.?$/i,
  /\bjust\s+this\.?$/i,
  /\bnothing\s+else\.?$/i,
  /\bpor\s+agora(?:\s+e\s+so\s+isso)?\.?$/i,
  /\bé\s+só\s+isso\.?$/i,
  /\be\s+so\s+isso\.?$/i,
];

export function hasLegacySubtaskIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return /\b(sub\s*-?\s*tasks?|subtarefas?|check\s*-?\s*list|checklist|lista de verificacao)\b/.test(folded);
}

export function startsWithTaskWithSubtasksIntent(text: string): boolean {
  const folded = foldCalendarText(text).replace(/^(?:please|por favor|pfv)\s+/, '');
  return /^\s*(?:create|make|cria[r]?|crie|crea[r]?|agrega[r]?)\b[\s\S]{0,50}\b(?:task|todo|tarefa|tarea)\b/.test(folded)
    || /^\s*(?:add|adiciona[r]?|a[nñ]ade|a[nñ]adir|agrega[r]?)\b/.test(folded);
}

export function parseTaskWithSubtasksIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const cleaned = stripTaskDiscourseTail(input.text.trim());
  if (!cleaned) return null;
  if (SUBTASK_SECOND_ACTION.test(cleaned)) {
    return buildNeedsInputPlan(input, {
      skill: 'tasks',
      action: 'create_task_with_subtasks',
      question: input.locale?.startsWith('pt')
        ? 'Vejo mais de uma ação nesse pedido. Confirma primeiro a tarefa com subtarefas ou pede uma pré-visualização completa.'
        : 'I see more than one action in that request. Confirm the task with subtasks first, or ask me to preview the full plan.',
      args: { title: null, subtasks: [] },
      routingSignals: ['task_with_subtasks_multi_step_guard', 'deterministic_task_parser'],
      clarificationReason: 'ambiguous_intent',
      intentClass: 'multi_step_preview_required',
    });
  }

  const quoted = extractTaskQuotedSegments(cleaned);
  const addFrame = parseAddSubtasksDescriptor(cleaned, quoted);
  if (addFrame?.multiRecipient) {
    return buildNeedsInputPlan(input, {
      skill: 'tasks',
      action: 'add_subtasks_to_task',
      question: input.locale?.startsWith('pt')
        ? 'Quais subtarefas pertencem a qual tarefa? Posso atualizar uma tarefa de cada vez.'
        : 'Which subtasks belong to which task? I can update one task at a time.',
      args: { title: null, subtasks: [] },
      routingSignals: ['multi_recipient_subtask_update', 'deterministic_task_parser'],
      clarificationReason: 'ambiguous_intent',
      intentClass: 'task_update',
    });
  }
  if (addFrame) return buildTaskSubtasksActionPlan(input, 'add_subtasks_to_task', addFrame, 0.88, ['add_subtasks_to_task_intent', 'deterministic_task_parser']);

  const checklistFrame = parseChecklistTaskDescriptor(cleaned);
  if (checklistFrame) return buildTaskSubtasksActionPlan(input, 'create_task_with_subtasks', checklistFrame, 0.9, ['create_checklist_task_intent', 'deterministic_task_parser']);

  const createFrame = parseCreateTaskWithSubtasksDescriptor(cleaned, quoted)
    ?? parseImplicitTaskWithSubtasksDescriptor(cleaned);
  if (createFrame) return buildTaskSubtasksActionPlan(input, 'create_task_with_subtasks', createFrame, createFrame.confidence, ['create_task_with_subtasks_intent', 'deterministic_task_parser']);

  const multipleTasks = parseCreateMultipleTasksDescriptor(cleaned);
  if (multipleTasks) {
    return buildNeedsInputPlan(input, {
      skill: 'tasks',
      action: 'create_task',
      question: input.locale?.startsWith('pt')
        ? 'Queres criar tarefas separadas? Confirma uma de cada vez ou pede uma pré-visualização completa.'
        : 'Do you want separate tasks? Confirm them one at a time, or ask me to preview the full plan.',
      args: { tasks: multipleTasks.tasks },
      routingSignals: ['bulk_task_creation_guard', 'deterministic_task_parser'],
      clarificationReason: 'ambiguous_intent',
      intentClass: 'task_create',
    });
  }

  return null;
}

function buildTaskSubtasksActionPlan(
  input: ChatPlannerInput,
  action: 'create_task_with_subtasks' | 'add_subtasks_to_task',
  descriptor: { title: string; subtasks: string[]; language?: string },
  confidence: number,
  routingSignals: string[],
): ChatActionPlan {
  const args = {
    title: descriptor.title,
    subtasks: descriptor.subtasks,
    dueAt: null,
    reminderAt: null,
    notes: null,
    priority: null,
    list: null,
    language: descriptor.language ?? detectTaskLanguage(input.text),
    extractionConfidence: confidence,
  };
  const step = makeStep(input, {
    skill: 'tasks',
    action,
    risk: 'safe_write',
    provider: 'nexus',
    args,
    requiredArgsPresent: Boolean(descriptor.title && descriptor.subtasks.length > 0),
  });
  return buildPlanFromSteps(input, [step], routingSignals, confidence);
}

function parseCreateTaskWithSubtasksDescriptor(
  cleaned: string,
  quoted: string[],
): { title: string; subtasks: string[]; language: string; confidence: number } | null {
  if (!SUBTASK_MARKER_PATTERNS.test(removeTaskQuotedSegments(cleaned))) return null;
  const marker = /(.*?)\b(?:where\s+it\s+has|with|including|that\s+has|com|incluindo|con)?\s*(?:sub\s*tasks?|subtasks?|subtarefas?|subtareas?|checklist(?:\s+items?)?|steps?|itens?|elementos?)\s*(?:called|named|chamadas?|chamados?|llamadas?|llamados?)?\s+(.+)$/i;
  const match = cleaned.match(marker);
  if (!match) return null;

  const title = extractTaskSubtaskTitle(match[1] || '', quoted);
  const subtasks = splitTaskSubtaskItems(match[2] || '');
  if (!title || subtasks.length === 0) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned), confidence: 0.94 };
}

function parseChecklistTaskDescriptor(cleaned: string): { title: string; subtasks: string[]; language: string } | null {
  const match = cleaned.match(/^\s*(?:create|make|cria|criar|crie|crear|crea)\s+(?:a\s+|uma?\s+|una?\s+)?checklist\s+(?:called|named|chamado|chamada|llamado|llamada)?\s*(.+?)\s*:\s*(.+)$/i);
  if (!match) return null;
  const title = normalizeTaskGuidanceTitle(match[1]);
  const subtasks = splitTaskSubtaskItems(match[2]);
  if (!title || subtasks.length === 0) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned) };
}

function parseImplicitTaskWithSubtasksDescriptor(cleaned: string): { title: string; subtasks: string[]; language: string; confidence: number } | null {
  const match = cleaned.match(/^\s*(?:cria|criar|crie|crear|crea)\s+(?:uma?\s+|una?\s+)?(?:tarefa|tarea)\s+(?:chamada?|chamado|llamada?|llamado)?\s*(.+?)\s+(?:com|con)\s+(.+)$/i);
  if (!match) return null;
  const title = normalizeTaskGuidanceTitle(match[1]);
  const subtasks = splitTaskSubtaskItems(match[2]);
  if (!title || subtasks.length < 2) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned), confidence: 0.86 };
}

function parseAddSubtasksDescriptor(
  cleaned: string,
  quoted: string[],
): { title: string; subtasks: string[]; language: string; multiRecipient?: boolean } | null {
  const textWithoutQuotes = removeTaskQuotedSegments(cleaned);
  if (!/^\s*(add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\b/i.test(textWithoutQuotes)) return null;
  if (/^\s*(?:add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\s+(?:a\s+|uma?\s+|una?\s+)?(?:task|todo|tarefa|tarea)\b/i.test(textWithoutQuotes)) return null;
  if (hasMultiRecipientSubtaskIntent(textWithoutQuotes)) {
    return { title: 'multiple tasks', subtasks: [], language: detectTaskLanguage(cleaned), multiRecipient: true };
  }
  const match = cleaned.match(/^\s*(?:add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\s+(.+?)\s+(?:to|under|à|a|na|no|en|bajo)\s+(?:my\s+|minha\s+|meu\s+|mi\s+|the\s+|la\s+|el\s+)?(?:task\s+|tarefa\s+|tarea\s+)?(.+?)(?:\s+task|\s+tarefa|\s+tarea)?$/i);
  if (!match) return null;
  const subtasks = splitTaskSubtaskItems(match[1]);
  const title = normalizeTaskGuidanceTitle(stripTaskArticleAndWords(match[2], quoted));
  if (!title || subtasks.length === 0) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned) };
}

function parseCreateMultipleTasksDescriptor(cleaned: string): { tasks: string[] } | null {
  const match = cleaned.match(/^\s*(?:create|cria|criar|crie|crear|crea)\s+(?:(\d+|three|two|multiple|varias|várias|duas|tres|três|dos)\s+)?(?:tasks|tarefas|tareas)\b[:\s]*(.+)$/i);
  if (!match) return null;
  const listPart = match[2] || '';
  if (!match[1] && !/(?:,|;|\n|\u2022|•|\band\b|\be\b|\by\b)/i.test(listPart)) return null;
  const tasks = splitTaskSubtaskItems(listPart);
  return tasks.length < 2 ? null : { tasks };
}

// Phase 1 batch 4: create_checklist intent. Distinct from create_task by the
// explicit "checklist" object plus enumerated items. We route deterministically
// when the user provides items inline; otherwise we defer to broader parsers.
export function parseCreateChecklistIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Phase 12 batch 66 (2026-05-16): Spanish "crea[r]?" / "a[nñ]ade"
  // added to create-verb set. Checklist noun unchanged — Spanish uses
  // the loan word "checklist".
  if (!/\b(create|cria[r]?|crea[r]?|adiciona[r]?|a[nñ]ade|monta[r]?|fa[czc]a?[r]?|build|new)\b/.test(folded)) return null;
  if (!/\b(checklist|lista\s+de\s+verifica[cç][aã]o|sub-?tarefas?|subtarefas?)\b/.test(folded)) return null;
  const title = extractTopicFromChecklist(input.text) || 'Checklist';
  const items = extractChecklistItems(input.text);
  const step = makeStep(input, {
    skill: 'tasks',
    action: 'create_checklist',
    risk: 'safe_write',
    provider: 'nexus',
    args: { title, items },
    requiredArgsPresent: Boolean(title && items.length > 0),
  });
  return buildPlanFromSteps(input, [step], ['create_checklist_intent', 'deterministic_task_parser'], 0.74);
}

function extractTopicFromChecklist(text: string): string | null {
  // "create a checklist for trip prep with passport, tickets" -> "trip prep"
  // "cria uma checklist para a viagem com passaporte, bilhetes" -> "a viagem"
  const match = text.match(/\b(?:checklist|sub-?tarefas?|subtarefas?)\s+(?:for|para|sobre|de|do|da)\s+([^,.:;]+?)(?:\s+with\b|\s+com\b|[,.:;]|$)/i);
  return match?.[1]?.trim() || null;
}

function extractChecklistItems(text: string): string[] {
  // Items after "with" / "com" / ":" — comma-or-semicolon separated.
  // Phase 12 batch 66: Spanish "y" added as a list conjunction.
  const match = text.match(/\b(?:with|com|con)\s+(.+)$/i) || text.match(/:\s*(.+)$/);
  if (!match) return [];
  return match[1]
    .split(/[,;]\s*|\s+e\s+|\s+y\s+|\s+and\s+/i)
    .map((item) => item.trim().replace(/[.?!]+$/g, ''))
    .filter((item) => item.length > 0 && item.length < 80)
    .slice(0, 20);
}

function stripTaskDiscourseTail(value: string): string {
  let output = value.trim();
  for (const pattern of TASK_DISCOURSE_TAILS) output = output.replace(pattern, '').trim();
  return output
    .replace(/\bfor now(?:\s+that'?s\s+it)?\b/gi, ' ')
    .replace(/\bthat'?s\s+(?:it|all)\b/gi, ' ')
    .replace(/\band\s+that'?s\s+all\b/gi, ' ')
    .replace(/\bjust\s+this\b/gi, ' ')
    .replace(/\bnothing\s+else\b/gi, ' ')
    .replace(/\bpor\s+agora(?:\s+e\s+so\s+isso)?\b/gi, ' ')
    .replace(/\bé\s+só\s+isso\b/gi, ' ')
    .replace(/\be\s+so\s+isso\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.。]+$/g, '')
    .trim();
}

function extractTaskQuotedSegments(value: string): string[] {
  const matches = [...value.matchAll(/"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’/g)];
  return matches
    .map((match) => (match[1] || match[2] || match[3] || match[4] || '').trim())
    .filter(Boolean);
}

function replaceTaskQuotedSegments(value: string): string {
  let index = 0;
  return value.replace(/"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’/g, () => `__QUOTE_${index++}__`);
}

export function removeTaskQuotedSegments(value: string): string {
  return replaceTaskQuotedSegments(value);
}

function normalizeTaskGuidanceTitle(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\-–—\s]+|[:\-–—\s.!?]+$/g, '')
    .slice(0, MAX_TASK_TITLE_LENGTH)
    .trim();
}

function normalizeTaskGuidanceComparable(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function splitTaskSubtaskItems(value: string): string[] {
  const stripped = stripTaskDiscourseTail(value)
    .replace(/^\s*(called|named|chamadas?|chamados?|llamadas?|llamados?)\s+/i, '')
    .trim();
  const quoted = extractTaskQuotedSegments(stripped);
  if (quoted.length > 0) return normalizeTaskSubtaskList(quoted);

  const commaSplit = stripped
    .split(/\s*(?:,|;|\n|\u2022|•)\s*|\s+(?:and|e|y)\s+/g)
    .map(normalizeTaskGuidanceTitle)
    .filter(Boolean);
  if (commaSplit.length > 1) return normalizeTaskSubtaskList(commaSplit);

  const words = stripped.split(/\s+/).map(normalizeTaskGuidanceTitle).filter(Boolean);
  if (words.length >= 2 && words.every((word) => /^[\p{L}\p{N}][\p{L}\p{N}+.-]*$/u.test(word))) {
    return normalizeTaskSubtaskList(words);
  }
  return normalizeTaskSubtaskList([stripped]);
}

function normalizeTaskSubtaskList(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const normalized = normalizeTaskGuidanceTitle(item);
    if (!normalized) continue;
    const key = normalizeTaskGuidanceComparable(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized.slice(0, MAX_SUBTASK_TITLE_LENGTH).trim());
    if (output.length >= MAX_SUBTASKS) break;
  }
  return output;
}

function extractTaskSubtaskTitle(prefix: string, quoted: string[]): string {
  const withoutQuoted = removeTaskQuotedSegments(prefix);
  const hasQuotedTitle = quoted.length > 0 && /\b(called|named|chamada?|chamado?|llamada?|llamado?)\s+__QUOTE_0__/i.test(replaceTaskQuotedSegments(prefix));
  if (hasQuotedTitle) return normalizeTaskGuidanceTitle(quoted[0]);

  let title = prefix
    .replace(/^\s*(please\s+)?(create|add|make|cria|criar|crie|adiciona|adicionar|crear|crea|agrega|agregar|añade|anade|añadir|anadir)\s+/i, '')
    .replace(/^\s*(a|one|uma|um|una|un)\s+/i, '')
    .replace(/^\s*(tasks?|todo|to-do|tarefas?|tareas?|checklist)\s+/i, '')
    .replace(/^\s*(called|named|chamada?|chamado?|llamada?|llamado?)\s+/i, '')
    .replace(/\s+(where\s+it\s+has|with|including|that\s+has|com|incluindo|con)\s*$/i, '')
    .trim();
  if (quoted.length > 0 && replaceTaskQuotedSegments(title).trim() === '__QUOTE_0__') return normalizeTaskGuidanceTitle(quoted[0]);
  const quotedOnly = title.match(/^["“”'‘’]([^"“”'‘’]+)["“”'‘’]$/);
  if (quotedOnly?.[1]) return normalizeTaskGuidanceTitle(quotedOnly[1]);
  if (!title && quoted.length > 0 && withoutQuoted.includes('__QUOTE_0__')) title = quoted[0];
  return normalizeTaskGuidanceTitle(title.replace(/__QUOTE_\d+__/g, '').trim());
}

function stripTaskArticleAndWords(value: string, quoted: string[]): string {
  const withPlaceholders = replaceTaskQuotedSegments(value);
  const replaced = withPlaceholders.replace(/__QUOTE_(\d+)__/g, (_all, index) => quoted[Number(index)] || '');
  return replaced
    .replace(/^\s*(the|a|uma|um|una|un|minha|meu|my|mi|la|el|los|las)\s+/i, '')
    .replace(/\s*(task|tarefa|tarea)\s*$/i, '')
    .trim();
}

function detectTaskLanguage(value: string): 'en' | 'pt' | 'es' | 'mixed' | 'unknown' {
  const hasPortuguese = /\b(cria|criar|crie|tarefa|subtarefas?|adiciona|por agora|é só isso)\b/i.test(value);
  const hasSpanish = /\b(crea|crear|tarea|subtareas?|añade|anade|agrega|con|llamada?|llamado?)\b/i.test(value);
  const hasEnglish = /\b(create|task|subtasks?|add|called|for now)\b/i.test(value);
  if ([hasPortuguese, hasSpanish, hasEnglish].filter(Boolean).length > 1) return 'mixed';
  if (hasSpanish) return 'es';
  if (hasPortuguese) return 'pt';
  if (hasEnglish) return 'en';
  return 'unknown';
}

function hasMultiRecipientSubtaskIntent(value: string): boolean {
  const targetClauses = value.match(/\b(?:to|under|à|a|na|no|en|bajo)\b/gi) || [];
  return targetClauses.length > 1 && /\b(and|e|y)\b/i.test(value);
}
