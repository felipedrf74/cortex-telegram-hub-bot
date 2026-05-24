// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  foldCalendarText,
  hasCalendarReadIntent,
  hasCalendarWriteIntent,
  hasMailReadIntent,
} from '../../calendar-natural-language-parser';
import { messageHasActionCandidate } from '../registry';
import { hasLegacySubtaskIntent } from './task-subtasks';

function hasSimpleTaskWriteIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return !hasLegacySubtaskIntent(text)
    // Phase 2 batch 10: PT-BR "bota" (colloquial) and "coloca" (BR + PT)
    // join the create-verb set so "Bota uma tarefa..." routes correctly.
    // Phase 8 batch 43 (2026-05-15): Spanish "crea"/"crear" added.
    && /\b(cria|criar|adiciona|adicionar|create|add|bota[r]?|coloca[r]?|p[oõ]e[r]?|mete[r]?|crea[r]?)\b/.test(folded)
    && /\b(task|tarefa|todo|lembrete|tarea[s]?)\b/.test(folded);
}

export function shouldRunActionPlannerBeforeReadOnlyFastPaths(text: string): boolean {
  if (!text.trim()) return false;
  if (hasLegacySubtaskIntent(text)) return true;
  if (hasCalendarWriteIntent(text)) return true;
  // Calendar read intent (e.g., "What's on my agenda today", "Mostra a agenda
  // de domingo", "agenda do Gmail") routes to summarize_agenda via the new
  // parseSummarizeAgendaIntent path; let the planner run.
  if (hasCalendarReadIntent(text)) return true;
  if (hasSimpleTaskWriteIntent(text)) return true;
  const folded = foldCalendarText(text);
  if (hasMailReadIntent(text) && !messageHasActionCandidate(text)) return false;
  return messageHasActionCandidate(text) && (
    /\b(send|enviar|draft|reply|responder|publish|publicar|delete|apaga|apagar|cancel|cancelar|remove|remover|paga|pay|stripe|refund|reembolso|admin|security|seguranca|revoga|revogar|revoke|reconnect)\b/.test(folded)
    || /\b(script|roteiro|brief|conteudo|content|meal|refeicao|jantar|almoco|ceia|lanche|compras|grocery|fueling|finance|financeiro|financeira|orcamento|budget|receipt|categorize|conexao|connection|sync|notificacao|notificacoes|notification|decision|decisao|treino|training)\b/.test(folded)
  );
}
