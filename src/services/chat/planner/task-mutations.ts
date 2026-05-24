// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { makeStep } from '../../skills/step-builder';
import type { ChatActionRisk } from '../registry';
import type { ChatActionPlan, ChatPlannerInput } from '../types';
import { buildPlanFromSteps } from './plan-builder';

export function parseCompleteTaskByMarkIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Portuguese / English mark-as-done patterns that signal complete_task
  // without a "create/cria" verb. Surfaced by the registry shadow-parity
  // report 2026-05-15 — previously fell through to the generic-fallback
  // first-action-in-subset path and incorrectly emitted create_task.
  const isMarkAsDone =
    /\b(marca|marcar|marc[aá]\-?la)\s+(?:essa|esta|a|essa\s+tarefa|esta\s+tarefa|isso)\s+(?:tarefa\s+)?(?:como\s+)?(?:feita|conclu[ií]da|pronta|done|complete[da]?)\b/.test(folded)
    || /\b(mark|set)\s+(?:this|that|the)\s+task\s+(?:as\s+)?(?:done|complete[d]?)\b/.test(folded)
    || /\b(concluir|conclui|finaliza|finalizar)\s+(?:essa|esta|a)\s+tarefa\b/.test(folded)
    // Phase 7 close-out: informal "tick off" / "check off" complete verbs.
    || /\b(tick|check)\s+off\s+(?:the|this|that|my)\s+\w+\s+task\b/.test(folded)
    // Phase 9 batch 48: Spanish "marca esa tarea como hecha".
    || /\b(marca|marcar)\s+(?:esa|esta|la)\s+tarea\s+(?:como\s+)?(?:hecha|hecho|completada|completado|terminada|terminado|lista)\b/.test(folded);
  if (!isMarkAsDone) return null;
  const step = makeStep(input, {
    skill: 'tasks',
    action: 'complete_task',
    risk: 'safe_write',
    provider: 'nexus',
    // taskId resolution happens via the recent-entity follow-up plan upstream
    // (buildRecentEntityFollowUpPlan in buildChatActionPlan). Here we mark the
    // step as not-yet-resolved; the engine will ask for clarification when
    // multiple recent tasks are candidates.
    args: { taskId: null },
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(input, [step], ['task_complete_by_mark_intent', 'deterministic_task_parser'], 0.78);
}

// Phase 1 batch 4 (2026-05-15): task mutation intents — delete/update/reminder.
// Pattern mirrors parseCompleteTaskByMarkIntent: identify the mutation verb,
// claim the action with `taskId: null`, and defer resolution to the
// recent-entity follow-up path. Must run AFTER parseSimpleTaskIntent only
// when the user explicitly references an existing task — guarded by NO
// create-verb anywhere in the message so "create a task called delete all my
// tasks" continues to route to create_task.
export function parseTaskMutationIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Phase 9 batch 48 (2026-05-16): Spanish `tarea` accepted in outer gate.
  if (!/\b(task|tarefa|todo|lembrete|tarea[s]?)\b/.test(folded)) return null;
  // Defer to parseSimpleTaskIntent when a create-verb opens the message. The
  // literal-title policy (audit §10) means create wins over the embedded
  // delete/update verb inside a title span — "Create a task called delete all
  // my tasks" stays a create. We use ^-anchored detection so "delete the laundry
  // task" (no leading create) still routes here.
  if (/^\s*(?:cria[r]?|criar|adiciona[r]?|adicionar|create|add|new)\b/i.test(input.text)
    && /\b(cria[r]?|criar|adiciona[r]?|adicionar|create|add|new)\b\s+(?:um[a]?|uma|a|o|new)?\s*(?:task|tarefa|todo|lembrete)\b/.test(folded)) {
    return null;
  }

  // Set-reminder must be checked BEFORE update/delete because "definir um
  // lembrete na tarefa" contains both `lembrete` and the noun `tarefa`, and we
  // want it routed to set_task_reminder, not finance_create_reminder via the
  // broad-skill subset. Includes PT verb forms `define`/`defina`/`definir`.
  if (/\b(set\s+(?:a\s+)?reminder|defin[aeio](?:r|m|ndo)?\s+(?:um\s+)?lembrete|remind\s+me\s+(?:about|on)|lembra[r]?\s+(?:me\s+)?(?:d[aoe]|sobre|na)|pon(?:er|me)?\s+(?:un\s+)?recordatorio|programa[r]?\s+(?:un\s+)?recordatorio)\b.*\b(task|tarefa|tarea)\b/.test(folded)
    || /\b(?:task|tarefa|tarea)\b.*\b(set\s+(?:a\s+)?reminder|defin[aeio](?:r|m|ndo)?\s+(?:um\s+)?lembrete|pon(?:er|me)?\s+(?:un\s+)?recordatorio|programa[r]?\s+(?:un\s+)?recordatorio)\b/.test(folded)) {
    return buildTaskMutationPlan(input, 'set_task_reminder', 'safe_write');
  }
  // Delete: verb appears followed (anywhere) by tarefa/task.
  // Phase 2 batch 10: PT-BR "deleta"/"exclui" added to the verb set so
  // "Deleta a tarefa" routes correctly. The English verbs cover BR+PT
  // mixed usage too.
  // Phase 9 batch 48: Spanish "borra"/"borrar" added; "tarea" accepted.
  if (/\b(delete|remove|apaga[r]?|elimina[r]?|deleta[r]?|excluir?|exclui[mr]?|borra[r]?)\b[^.]*\b(tarefa|task|tarea)\b/.test(folded)) {
    return buildTaskMutationPlan(input, 'delete_task', 'destructive');
  }
  // Update / change / edit: verb followed by tarefa/task somewhere later.
  // Phase 3 batch 15: PT-BR `muda[r]?` (BR colloquial for "altera/change")
  // added so "Muda a tarefa pra terça" routes correctly.
  // Phase 9 batch 48: Spanish "cambia/cambiar" added; "tarea" accepted.
  if (/\b(update|change|edit|rename|atualiza[r]?|altera[r]?|modifica[r]?|renomeia[r]?|muda[r]?|cambia[r]?)\b[^.]*\b(tarefa|task|tarea)\b/.test(folded)) {
    return buildTaskMutationPlan(input, 'update_task', 'safe_write');
  }
  return null;
}

function buildTaskMutationPlan(
  input: ChatPlannerInput,
  action: 'delete_task' | 'update_task' | 'set_task_reminder',
  risk: ChatActionRisk,
): ChatActionPlan {
  const step = makeStep(input, {
    skill: 'tasks',
    action,
    risk,
    provider: 'nexus',
    args: action === 'set_task_reminder'
      ? { taskId: null, reminderAt: null }
      : { taskId: null },
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(input, [step], [`task_${action}_intent`, 'deterministic_task_parser'], 0.76);
}
