// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  foldCalendarText,
  hasCalendarReadIntent,
  hasCalendarWriteIntent,
  hasMailReadIntent,
} from '../../calendar-natural-language-parser';
import { messageHasActionCandidate } from '../registry';
import { hasLegacySubtaskIntent } from './task-subtasks';
import { isCookingLegacyToolIntent } from '../../skills/cooking/parser';

function hasSimpleTaskWriteIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return !hasLegacySubtaskIntent(text)
    // Phase 2 batch 10: PT-BR "bota" (colloquial) and "coloca" (BR + PT)
    // join the create-verb set so "Bota uma tarefa..." routes correctly.
    // Phase 8 batch 43 (2026-05-15): Spanish "crea"/"crear" added.
    && /\b(cria|criar|adiciona|adicionar|create|add|bota[r]?|coloca[r]?|p[oõ]e[r]?|mete[r]?|crea[r]?)\b/.test(folded)
    && /\b(task|tarefa|todo|lembrete|tarea[s]?)\b/.test(folded);
}

function hasReminderWriteIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return /\b(remind\s+me|reminder|lembrete|lembra-?me|lembre-?me|lembrar|avisa-?me|avise-?me|avisame|alerta-?me|recordatorio|recuerdame|recu[eé]rdame)\b/.test(folded)
    || /^\s*(?:avisa|alerta)\b(?!\s+(?:que|es)\b)/.test(folded);
}

export function shouldRunActionPlannerBeforeReadOnlyFastPaths(text: string): boolean {
  if (!text.trim()) return false;
  const folded = foldCalendarText(text);
  const explicitCrossSkillOwner = /\b(?:task|tarefa|notification|notificacao|reminder|lembrete|event|evento|meeting|reuniao|calendar|calendario|agenda)\b/.test(folded);
  if (isCookingLegacyToolIntent(text) && !explicitCrossSkillOwner) return false;
  if (hasLegacySubtaskIntent(text)) return true;
  if (hasCalendarWriteIntent(text)) return true;
  if (hasReminderWriteIntent(text)) return true;
  // Calendar read intent (e.g., "What's on my agenda today", "Mostra a agenda
  // de domingo", "agenda do Gmail") routes to summarize_agenda via the new
  // parseSummarizeAgendaIntent path; let the planner run.
  if (hasCalendarReadIntent(text)) return true;
  if (hasSimpleTaskWriteIntent(text)) return true;
  if (isCookingLegacyToolIntent(text)) return false;
  if (hasMailReadIntent(text) && !messageHasActionCandidate(text)) return false;
  if (/\b(?:plan|schedule|set|save|add|planejar|planeja[r]?|planeia[r]?|agenda[r]?|programa[r]?|cria[r]?|faz(?:er)?|planea[r]?|crea[r]?)\b/.test(folded)
    && /\b(?:meal|refeicao|jantar|almoco|ceia|lanche|comida|breakfast|lunch|dinner|supper|snack|brunch|cardapio|ementa|cena|almuerzo|desayuno|menu)\b/.test(folded)) {
    return true;
  }
  return messageHasActionCandidate(text) && (
    /\b(send|enviar|draft|reply|responder|publish|publicar|post|postar|postea|upload|subir|queue|delete|apaga|apagar|cancel|cancelar|remove|remover|elimina|eliminar|paga|pay|stripe|refund|reembolso|admin|security|seguranca|revoga|revogar|revoke|reconnect)\b/.test(folded)
    || /\b(script|roteiro|brief|conteudo|content|meal|refeicao|jantar|almoco|ceia|lanche|comida|breakfast|lunch|dinner|supper|snack|brunch|cardapio|ementa|compras?|grocery|fueling|recipe|receita|receta|pantry|despensa|cena|almuerzo|desayuno|menu|ingrediente|finance|financeiro|financeira|orcamento|budget|receipt|categorize|conexao|connection|sync|notificacao|notificacoes|notification|decision|decisao|treino|training)\b/.test(folded)
  );
}
