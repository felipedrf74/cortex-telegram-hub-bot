// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary Tool Selection — Layer 3 of the 4-layer token optimization.
 *
 * Problem: callDomain('secretary') sends all 25+ secretary tools on every
 * call. Tool definitions consume ~3,750 input tokens per message — about
 * 39% of the per-call input cost. When a user asks "what time is my
 * meeting?", the AI receives schemas for ms_todo_create_list, send_email,
 * delete_calendar_event, etc. — none of which are needed.
 *
 * Solution: classify the message intent with a lightweight keyword check
 * (zero AI overhead) and send only the tool packs the message could
 * plausibly need. Falls back to the full tool set on ambiguous queries.
 *
 * The same `analyzeIntent` function powers Layer 2 (smart context loading),
 * so the keyword logic lives in one place. If you change a keyword pattern
 * here, both layers update automatically.
 *
 * Token economics:
 *   - Before: 25 tools × ~150 tokens each = ~3,750 tokens per call
 *   - After:  3-8 tools × ~150 tokens each = ~450-1,200 tokens per call
 *   - Saving: ~2,500-3,300 tokens per call (~25-30% of the input bill)
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { DomainName } from '../domains/types';

// ─── Tool Packs ─────────────────────────────────────────────────────
//
// Tool packs group related tools by user intent. The keys (task_read,
// task_write, calendar_read, etc.) are the unit of selection — we either
// send all tools in a pack or none. This is coarser than per-tool
// selection but matches how users actually phrase requests, and the
// coarseness leaves headroom for the AI to chain multiple operations
// (e.g. "list tasks then mark the third one done" needs both task_read
// and task_write).
//
// Tool names MUST match the actual `name` field in TOOLS in anthropic.ts.
// The Layer 3 test suite cross-checks that every name here exists in TOOLS
// at runtime, so renaming a tool will break tests rather than silently
// dropping it from the filter.

export const SECRETARY_TOOL_PACKS: Record<string, string[]> = {
  task_read: [
    'ms_todo_get_tasks',
    'ms_todo_search_tasks',
    'ms_todo_get_due_tasks',
    'ms_todo_get_lists',
    'ms_todo_get_checklist',
  ],
  task_write: [
    'ms_todo_create_task',
    'ms_todo_update_task',
    'ms_todo_complete_task',
    'ms_todo_uncomplete_task',
    'ms_todo_delete_task',
    'ms_todo_move_task',
    'ms_todo_add_checklist_item',
    'ms_todo_create_list',
    'ms_todo_delete_list',
  ],
  calendar_read: ['get_calendar_events'],
  calendar_write: [
    'create_calendar_event',
    'update_calendar_event',
    'delete_calendar_event',
  ],
  email: [
    'search_outlook_emails',
    'read_outlook_email',
    'send_outlook_email',
    'reply_outlook_email',
    'get_outlook_unread',
  ],
  reminders: ['set_reminder'],
  notes: ['save_note', 'search_notes'],
  // Memory is special — it's always included so the AI can record
  // cross-domain facts ("marathon: April 15") regardless of intent.
  memory: ['shared_memory_set', 'shared_memory_remove'],
};

// ─── Intent Classifier (also reused by Layer 2) ─────────────────────

/**
 * The intent of a secretary message — which features the user is asking
 * about. Used by both Layer 3 (tool selection) and Layer 2 (state context
 * loading) so the keyword logic lives in exactly one place.
 *
 * `ambiguous` is the safety net — when the message doesn't trigger any
 * specific intent, both layers fall back to "load everything", matching
 * the pre-optimization behavior. This means a missed keyword pattern
 * degrades to slower-and-more-expensive, NEVER to broken.
 */
export interface SecretaryIntent {
  tasks: boolean;
  taskWrite: boolean;
  calendar: boolean;
  calendarWrite: boolean;
  email: boolean;
  reminders: boolean;
  notes: boolean;
  garmin: boolean;
  /** True when no specific intent matched — caller should use full fallback. */
  ambiguous: boolean;
}

// Centralized regex constants — kept here so Layer 2 + Layer 3 + the tests
// share the exact same matching logic. Don't inline these in callers.
//
// IMPORTANT: every word stem that has a plural form must use `s?` (or the
// full form list) — `\btask\b` does NOT match "tasks" because of the word
// boundary. This is the #1 source of false negatives in keyword classifiers
// and the regex tests should re-catch any regression.
const RE = {
  // Use \w* suffixes for stems that have many inflected forms (training,
  // trains, trainer, ...). The leading \b still anchors the match to a
  // word start so "constraint" won't trigger "train".
  tasks: /\b(tasks?|todos?|tarefas?|pendentes?|overdue|atrasad[ao]s?|done|complet\w*|lists?|criar|adds?|nova|novas|editar|mover|deletar|apagar|marcar|priorit\w*)\b/i,
  taskWrite: /\b(create|adds?|done|complet\w*|edits?|update|delete|moves?|criar|nova|novas|editar|mover|deletar|apagar|marcar|finaliz\w*)\b/i,
  calendar: /\b(calendars?|events?|meetings?|agenda|schedules?|reuni[aã]o|reuni[oõ]es|eventos?|dia|day|week|semana|today|hoje|amanh[aã]|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|marcar)\b/i,
  calendarWrite: /\b(create|schedules?|moves?|cancel|reschedule|marcar|agendar|cancelar|remarcar)\b/i,
  email: /\b(emails?|e-mails?|mail|inbox|unread|sends?|reply|replies|n[aã]o lid[oa]s?|enviar|responder|caixa de entrada)\b/i,
  reminders: /\b(reminds?|reminder|reminders|lembr\w*|aviso|avisos|alarmes?)\b/i,
  notes: /\b(notes?|notas?|anota\w*|anotations?|memos?)\b/i,
  garmin: /\b(train\w*|treino\w*|gym|academia|runs?|corrida\w*|bike|sleep|sono|readiness|prontid[aã]o|body.?battery|hrv|workout\w*)\b/i,
};

/**
 * Analyze a secretary message and classify what data sources / tool packs
 * it could need. Pure function — no AI calls, no I/O, no side effects.
 * Safe to call on every message.
 *
 * Heuristic: if no specific intent triggers, mark `ambiguous: true` so
 * callers know to load the full set instead of nothing.
 */
export function analyzeIntent(message: string): SecretaryIntent {
  const msg = message.trim();

  const tasks = RE.tasks.test(msg);
  const taskWrite = tasks && RE.taskWrite.test(msg);
  const calendar = RE.calendar.test(msg);
  const calendarWrite = calendar && RE.calendarWrite.test(msg);
  const email = RE.email.test(msg);
  const reminders = RE.reminders.test(msg);
  const notes = RE.notes.test(msg);
  const garmin = RE.garmin.test(msg);

  // Ambiguous = the message is too short OR triggered no domain keyword.
  // Short messages are often follow-ups ("yes", "no", "sim", "ok") that
  // continue a previous conversation — without history we can't know what
  // they're about, so loading everything is the safe default.
  const anyMatched = tasks || calendar || email || reminders || notes || garmin;
  const ambiguous = !anyMatched || msg.length < 8;

  return {
    tasks,
    taskWrite,
    calendar,
    calendarWrite,
    email,
    reminders,
    notes,
    garmin,
    ambiguous,
  };
}

// ─── Tool Pack Selection ────────────────────────────────────────────

/**
 * Determine which tool packs are needed for a given message intent.
 * Memory is ALWAYS included (cross-domain facts). Ambiguous messages
 * get all packs as a safety net.
 *
 * Returns the set of pack keys; resolution to actual tool names happens
 * in `getFilteredToolsForMessage` so callers can also use the pack list
 * for metrics and debugging.
 */
export function getToolPacksForMessage(message: string): string[] {
  const intent = analyzeIntent(message);
  const packs = new Set<string>();

  // Memory is always present so the AI can record cross-domain facts
  packs.add('memory');

  if (intent.ambiguous) {
    // Safety net — return all packs (matches pre-optimization behavior)
    return Object.keys(SECRETARY_TOOL_PACKS);
  }

  if (intent.tasks) {
    packs.add('task_read');
    if (intent.taskWrite) packs.add('task_write');
  }
  if (intent.calendar) {
    packs.add('calendar_read');
    if (intent.calendarWrite) packs.add('calendar_write');
  }
  if (intent.email) packs.add('email');
  if (intent.reminders) packs.add('reminders');
  if (intent.notes) packs.add('notes');

  return [...packs];
}

/**
 * Filter the full tool array down to only the tools needed for this
 * message. For non-secretary domains, returns the input array unchanged
 * (other domains use the existing per-domain filtering at the skill layer).
 *
 * `allTools` should be the already-domain-filtered tool array — we don't
 * re-apply domain filtering here, we only narrow further by intent.
 */
export function getFilteredToolsForMessage(
  domain: DomainName,
  message: string,
  allTools: Anthropic.Tool[],
): Anthropic.Tool[] {
  if (domain !== 'secretary') return allTools;

  const packs = getToolPacksForMessage(message);
  const allowed = new Set<string>();
  for (const pack of packs) {
    for (const tool of SECRETARY_TOOL_PACKS[pack] || []) {
      allowed.add(tool);
    }
  }

  return allTools.filter((t) => allowed.has(t.name));
}

// ─── Layer 4: Adaptive Model Selection ──────────────────────────────
//
// Secretary historically used Sonnet 4.6 for ALL queries because the
// system prompt is full of "use tool X to do Y" reasoning that Haiku
// occasionally botches. But "show my tasks" doesn't need tool-use
// reasoning at all — Haiku formats lists just as well as Sonnet at 1/3
// the cost. The trick is identifying which queries genuinely need
// Sonnet's reasoning and routing only those to the expensive model.
//
// The classifier here is a list of complexity markers — if any of them
// match, we keep the query on Sonnet. Otherwise it goes to Haiku.
// Errs on the side of Sonnet (false positives = pay more, false
// negatives = bad answer), so the patterns are intentionally generous.

const COMPLEX_PATTERNS: RegExp[] = [
  // Planning verbs — "plan", "organize", "schedule out", "structure"
  /\b(plan(?:ej[ao]r?|ej[ae])?|organiz\w*|structure|estrutur\w*|orquestr\w*)\b/i,
  // Decision verbs — "should I", "what if", "help me decide"
  /\b(should i|do you think|recommend|suggest|sugest\w*|recomend\w*|deveria|will i|might i)\b/i,
  // Prioritization — "what's most important", "prioritize", "rank"
  /\b(prioriti[sz]e?|prioridade|rank|most important|mais importante|primeiro)\b/i,
  // Analysis — "analyze", "review", "explain why"
  /\b(analyz\w*|analis\w*|review|revis\w*|explain why|por que|porque)\b/i,
  // Composition — "write", "draft", "compose"
  /\b(write|draft|compose|redigi\w*|escrev\w*|elabor\w*)\b/i,
  // Conditional reasoning — "if X then Y", "considering", "given that"
  /\b(considering|levando em conta|dado que|given that|tendo em vista|assuming)\b/i,
  // Help-me cluster — open-ended assistance
  /\b(help me (?:decide|think|plan|figure|understand|choose)|me ajud[ea] (?:a|com))\b/i,
  // Multi-constraint — "considering my training and content"
  /\band\s+(?:my|the|a)\s+\w+\s+and\s+/i,
];

/**
 * Decide whether a secretary message needs Sonnet's deeper reasoning, or
 * whether Haiku is enough. Pure function — no AI calls.
 *
 * Heuristic: if ANY complexity marker matches, return true (use Sonnet).
 * Otherwise return false (use Haiku, save 2/3 the cost).
 *
 * Errs on the side of Sonnet — a false-positive costs ~$0.05 extra, a
 * false-negative might give a bad answer that the user has to retry.
 */
export function secretaryNeedsSonnet(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return true; // empty/unknown → safer to keep on Sonnet
  return COMPLEX_PATTERNS.some((p) => p.test(trimmed));
}
