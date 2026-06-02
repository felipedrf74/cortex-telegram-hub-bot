// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Shared policy for detecting model text that claims, or promises, app-side
 * mutation without a verifier/readback result. This intentionally focuses on
 * first-person app-action language so ordinary content like recipes ("cook
 * until done") is not treated as a false success claim.
 */
const APP_ACTION_OBJECT_RE_SOURCE = [
  'it',
  'this',
  'that',
  'task',
  'event',
  'meeting',
  'reminder',
  'recipe',
  'draft',
  'script',
  'post',
  'content',
  'workout',
  'training',
  'plan',
  'isso',
  'isto',
  'aquilo',
  'tarefa',
  'evento',
  'reuni[aã]o',
  'lembrete',
  'receita',
  'rascunho',
  'roteiro',
  'conte[uú]do',
  'treino',
  'plano',
  'eso',
  'esto',
  'aquello',
  'tarea',
  'reuni[oó]n',
  'recordatorio',
  'receta',
  'borrador',
  'guion',
  'contenido',
  'entrenamiento',
].join('|');

const APP_ACTION_OBJECT_PHRASE_RE_SOURCE = `(?:the|a|an|o|a|os|as|um|uma|el|la|los|las|un|una)?\\s*(?:${APP_ACTION_OBJECT_RE_SOURCE})`;

export const WRITE_SUCCESS_CLAIM_RE = new RegExp(
  [
    // English first-person past-tense success claims.
    "\\bi(?:['’]ve|\\s+have|\\s+just|\\s+already)*\\s+(?:marked|completed|scheduled|sent|deleted|removed|updated|published|posted|paid|transferred|cancell?ed|uploaded|moved|changed|modified|rescheduled)\\b",
    `\\bi(?:['’]ve|\\s+have|\\s+just|\\s+already)*\\s+(?:created|added|saved)\\s+${APP_ACTION_OBJECT_PHRASE_RE_SOURCE}\\b`,
    // English first-person intent-to-act.
    "\\bi(?:['’]ll|\\s+will)\\s+(?:cancel|move|reschedule|delete|create|schedule|send|mark|complete|update|add|remove|save|upload|publish|post|change|modify)\\b",
    // Portuguese first-person preterite.
    '\\b(?:marquei|conclu[ií]|agendei|enviei|apaguei|deletei|removi|atualizei|publiquei|postei|paguei|transferi|cancelei|alterei|mudei|remarquei|subi)(?=$|\\s|[.!?,;:])',
    `\\b(?:criei|adicionei|guardei|salvei)\\s+${APP_ACTION_OBJECT_PHRASE_RE_SOURCE}\\b`,
    // Portuguese intent-to-act.
    '\\bvou\\s+(?:cancelar|mudar|adiar|mover|apagar|deletar|criar|agendar|enviar|marcar|concluir|atualizar|adicionar|remover|guardar|salvar|publicar|postar|subir|remarcar|alterar)\\b',
    // Portuguese "cancelled" participle as a common model shortcut.
    '\\bcancelad[oa]\\b',
    // Spanish first-person preterite. Prefer accented forms; unaccented
    // variants are accepted only with an explicit "yo" to avoid treating
    // imperative/instructional text like "cree una receta" as a success claim.
    '(?:^|\\s)(?:marqué|completé|programé|envié|eliminé|actualicé|pagué|cancelé|sub[ií]|publiqué|cambié|modifiqué|reprogramé)(?=$|\\s|[.!?,;:])',
    `(?:^|\\s)(?:creé|guardé|a[ñn]ad[ií])\\s+${APP_ACTION_OBJECT_PHRASE_RE_SOURCE}\\b`,
    '\\byo\\s+(?:marque|cree|complete|programe|envie|elimine|actualice|pague|cancele|guarde|a[ñn]adi|subi|publique|cambie|modifique|reprograme)\\b',
  ].join('|'),
  'i',
);

const BARE_APP_SUCCESS_MARKER_RE = new RegExp(
  [
    '^\\s*✅',
    '^\\s*(?:done|created|scheduled|booked|moved|updated|completed|sent|deleted|removed|cancell?ed|cleared|eliminated)(?:\\s*[.!:—-]|\\s*$)',
    '^\\s*(?:deleted|removed|cancell?ed|cleared|eliminated)\\b[^.!?\\n]{0,120}\\b(?:tasks?|events?|meetings?|reminders?|recipes?|drafts?|scripts?|posts?|content|workouts?|training|plans?)\\b',
    '^\\s*(?:task|event|meeting|reminder|recipe|draft|script|post)\\s+(?:created|scheduled|booked|moved|updated|completed|sent|deleted|removed|cancell?ed|cleared|published|posted)(?:\\s*[.!:—-]|\\s*$)',
    '^\\s*(?:pronto|criado|criada|agendado|agendada|marcado|marcada|movido|movida|atualizado|atualizada|conclu[ií]do|conclu[ií]da|enviado|enviada|apagado|apagada|removido|removida|cancelado|cancelada|limpo|limpa|eliminado|eliminada|exclu[ií]do|exclu[ií]da)(?:\\s*[.!:—-]|\\s*$)',
    '^\\s*(?:apagad[oa]s?|removid[oa]s?|cancelad[oa]s?|limp[oa]s?|eliminad[oa]s?|exclu[ií]d[oa]s?)\\b[^.!?\\n]{0,120}\\b(?:tarefas?|eventos?|reuni[oõ]es?|lembretes?|receitas?|rascunhos?|roteiros?|posts?|conte[uú]do|treinos?|planos?)\\b',
    '^\\s*(?:tarefa|evento|reuni[aã]o|lembrete|receita|rascunho|roteiro|post)\\s+(?:criad[oa]|agendad[oa]|marcad[oa]|movid[oa]|atualizad[oa]|conclu[ií]d[oa]|enviad[oa]|apagad[oa]|removid[oa]|cancelad[oa]|publicad[oa]|postad[oa])(?:\\s*[.!:—-]|\\s*$)',
  ].join('|'),
  'i',
);

const ACTION_CLAUSE_SPLIT_RE = /(?:[.!?;:]\s+|,\s+|\s+[—–-]\s+|\n+)/u;
const DIACRITIC_RE = /\p{Diacritic}/gu;

const NEGATED_ACTION_PARTICIPLE_RE = /\b(?:not|never|no|nao|nunca|jamais|jamas|ainda\s+nao|todavia\s+no|todavia\s+nao|aun\s+no)\b\s+(?:(?:yet|already|been|being|be|is|are|was|were|has|have|had|foi|foram|esta|estao|estava|estavam|sido|ya|todavia|aun|fue|fueron|esta|estan|estaba|estaban|sido)\s+){0,5}\b(?:completed|cancelled|canceled|created|saved|added|marked|scheduled|sent|deleted|removed|updated|published|posted|paid|transferred|uploaded|moved|changed|modified|rescheduled|concluid[ao]s?|cancelad[ao]s?|criad[ao]s?|guardad[ao]s?|salv[ao]s?|adicionad[ao]s?|marcad[ao]s?|agendad[ao]s?|enviad[ao]s?|apagado?s?|removid[ao]s?|atualizad[ao]s?|publicad[ao]s?|postad[ao]s?|pag[ao]s?|transferid[ao]s?|subid[ao]s?|movid[ao]s?|alterad[ao]s?|modificad[ao]s?|remarcad[ao]s?|completad[ao]s?|programad[ao]s?|eliminad[ao]s?|actualizad[ao]s?|publicad[ao]s?|cambiad[ao]s?|reprogramad[ao]s?)\b/i;

const NEGATED_ACTION_VERB_RE = /\b(?:not|never|no|nao|nunca|jamais|jamas)\s+(?:marked|completed|created|saved|added|scheduled|sent|deleted|removed|updated|published|posted|paid|transferred|cancelled|canceled|uploaded|moved|changed|modified|rescheduled|marquei|conclui|criei|guardei|salvei|adicionei|agendei|enviei|apaguei|deletei|removi|atualizei|publiquei|postei|paguei|transferi|cancelei|alterei|mudei|remarquei|subi|marque|cree|complete|programe|envie|elimine|actualice|pague|cancele|guarde|anadi|subi|publique|cambie|modifique|reprograme)\b/i;

const NEGATED_INTENT_TO_ACT_RE = /\b(?:not|never|no|nao|nunca|jamais|jamas)\s+(?:(?:i\s+will|i'll)\s+(?:cancel|move|reschedule|delete|create|schedule|send|mark|complete|update|add|remove|save|upload|publish|post|change|modify)|vou\s+(?:cancelar|mudar|adiar|mover|apagar|deletar|criar|agendar|enviar|marcar|concluir|atualizar|adicionar|remover|guardar|salvar|publicar|postar|subir|remarcar|alterar)|voy\s+a\s+(?:cancelar|mover|reprogramar|eliminar|crear|programar|enviar|marcar|completar|actualizar|anadir|añadir|remover|guardar|subir|publicar|cambiar|modificar))\b/i;

export function textClaimsUnverifiedAction(text: string): boolean {
  return splitActionClauses(text).some((clause) =>
    WRITE_SUCCESS_CLAIM_RE.test(clause) && !containsNegatedActionClaim(clause),
  );
}

export function textHasBareAppSuccessMarker(text: string): boolean {
  return BARE_APP_SUCCESS_MARKER_RE.test(text);
}

function splitActionClauses(text: string): string[] {
  return text
    .split(ACTION_CLAUSE_SPLIT_RE)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function containsNegatedActionClaim(clause: string): boolean {
  const folded = clause
    .normalize('NFD')
    .replace(DIACRITIC_RE, '')
    .toLowerCase();
  return NEGATED_ACTION_PARTICIPLE_RE.test(folded)
    || NEGATED_ACTION_VERB_RE.test(folded)
    || NEGATED_INTENT_TO_ACT_RE.test(folded);
}
