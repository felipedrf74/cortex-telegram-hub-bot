// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Past-tense detector for mutation intents. Phase 3 batch 12 (2026-05-15).
//
// Motivation: the Phase 2 batch 9 negative examples documented lookalike
// phrases that the deterministic gates already filtered ("I drafted my
// thoughts earlier and just need feedback" — gate already rejects). But
// several common past-tense phrasings trip the gates:
//
//   • "I scheduled my dentist yesterday" — schedule + calendar object
//   • "Já paguei essa fatura"             — pay + finance object (PT-BR)
//   • "Já comi jantar ontem"              — cooking object (PT-BR)
//   • "Maria me lembrou ontem"            — reminder object (PT-BR)
//   • "Acabei de mandar o email"          — mail action (PT-BR)
//
// All five are descriptions of past events, NOT requests for the engine to
// act. The deterministic mutation gates must consult this helper before
// claiming the message; if past-tense signals fire, the gate returns false
// and the message falls through to conversational tiers (or to the LLM
// classifier with a "this looks like a past-event description" hint).
//
// The heuristic is intentionally conservative: it only trips when BOTH a
// past-tense verb form (English -ed, irregular pasts; Portuguese 1st-person
// preterite or perfect) AND a past-anchor adverb (yesterday, last week, já,
// ontem, ...) appear in the SAME message. A standalone past-tense verb is
// not enough ("I drafted my thoughts" is ambiguous and the regex gates
// already filter it through other paths). A standalone past anchor is also
// not enough ("Show me what's on my agenda for yesterday" is a read query
// over a past date, not a past-event description).
//
// Exception: the explicit construction "já + past-verb" / "acabei de +
// infinitive" / "I just [verb-past]" / "I already [verb-past]" trips on
// its own because the modifier itself anchors past time strongly.

import { foldCalendarText } from '../calendar-natural-language-parser';

/**
 * Returns true when the message reads as a description of a past mutation
 * event rather than a request to perform a new mutation. Mutation parsers
 * SHOULD consult this BEFORE claiming the message; read parsers MAY ignore
 * it (a "what did I do yesterday" query is legitimate).
 *
 * Phase 5 batch 23 (2026-05-15): sentence-level scope. The function now
 * splits multi-sentence messages on `.!?` boundaries and trips only when
 * EVERY non-trivial sentence is past-tense AND no sentence carries a
 * forward-looking action verb. This fixes:
 *
 *   "Já paguei a fatura. Agenda uma reunião pra sexta."
 *
 * — the past-tense first half does not block the calendar-write second
 * half. The detector now returns false because the second sentence has
 * forward action intent.
 */
export function hasPastTenseSignal(text: string): boolean {
  const sentences = splitIntoSentences(text);
  if (sentences.length <= 1) return hasPastTenseInSingleScope(text);
  // Multi-sentence: trip only if every "actionable" sentence is past-tense.
  // A sentence is actionable when it contains an action-verb-like token
  // (create/cancel/send/etc.) or a mutation noun (task/event/email/...).
  let anyActionableSentence = false;
  for (const sentence of sentences) {
    if (!isActionable(sentence)) continue;
    anyActionableSentence = true;
    if (!hasPastTenseInSingleScope(sentence)) return false;
  }
  // If there are no actionable sentences at all, fall back to the single-
  // scope check on the whole text (the original behavior).
  return anyActionableSentence ? true : hasPastTenseInSingleScope(text);
}

function hasPastTenseInSingleScope(text: string): boolean {
  const folded = foldCalendarText(text);

  // Strong constructs — past-tense modifier directly attached to a verb.
  // "I just paid the bill" / "I already paid the bill" / "Já paguei a fatura" /
  // "Acabei de pagar a fatura".
  if (/\bi\s+(?:just|already)\s+(?:paid|sent|scheduled|emailed|drafted|cancelled|canceled|deleted|created|added|moved|rewrote|wrote|made|set\s+up|booked|blocked\s+off|completed|finished|published|posted|uploaded)\b/.test(folded)) {
    return true;
  }
  if (/\bj[aá]\s+(?:paguei|enviei|mandei|marquei|agendei|criei|coloquei|adicionei|deletei|exclu[ií]|cancelei|apaguei|comi|fiz|terminei|conclu[ií])\b/.test(folded)) {
    return true;
  }
  if (/\bacabei\s+de\s+(?:pagar|enviar|mandar|marcar|agendar|criar|colocar|adicionar|deletar|excluir|cancelar|apagar|fazer)\b/.test(folded)) {
    return true;
  }
  // Phase 14 batch 75 (2026-05-16): Spanish "ya + past-tense" construction.
  // ES preterites differ from PT — verbs end in -é instead of -ei
  // (paguei → pagué, envié, marqué, agendé, creé, añadí, completé, hice).
  if (/\bya\s+(?:pagu[eé]|envi[eé]|mand[eé]|marqu[eé]|agend[eé]|cre[eé]|coloqu[eé]|a[nñ]ad[ií]|adicion[eé]|borr[eé]|elimin[eé]|cancel[eé]|borr[eé]|com[ií]|hice|hic[ie]ron|termin[eé]|complet[eé])\b/.test(folded)) {
    return true;
  }
  // Phase 14 batch 75: Spanish "acabo de" / "acabé de" past-recency markers.
  if (/\bacab(?:o|[eé])\s+de\s+(?:pagar|enviar|mandar|marcar|agendar|crear|colocar|a[nñ]adir|adicionar|borrar|eliminar|cancelar|hacer|completar|terminar)\b/.test(folded)) {
    return true;
  }
  // Phase 7 close-out (2026-05-15): PT-PT perfect-compound past — "tenho pago",
  // "tenho marcado", "tenho enviado" etc. This is a continuous past construct
  // used more in PT-EU than PT-BR; documents an event that happened over a
  // period leading up to now. Treated as past-event description, not request
  // for new action.
  if (/\bten[hh][oa]\s+(?:pago|enviado|mandado|marcado|agendado|criado|colocado|adicionado|deletado|exclu[ií]do|cancelado|apagado|comido|feito|terminado|conclu[ií]do|escrito|reescrito)\b/.test(folded)) {
    return true;
  }
  // PT-BR alternative "andei + gerund" continuous past — "andei mandando",
  // "andei marcando" — common BR construct documenting recent ongoing past.
  if (/\bandei\s+\w+(?:ando|endo|indo)\b/.test(folded)) {
    return true;
  }

  // Combined construct — past-tense verb AND past-anchor adverb in the same
  // message. Either order, separated by up to ~60 chars of intervening text.
  const hasEnglishPastVerb = /\b(?:scheduled|emailed|sent|paid|drafted|rewrote|wrote|cancelled|canceled|deleted|created|added|moved|booked|blocked\s+off|set\s+up|completed|finished|marked|crossed\s+off|tackled)\b/.test(folded);
  const hasEnglishPastAnchor = /\b(?:yesterday|last\s+(?:week|month|year|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|sprint|quarter)|earlier(?:\s+today|\s+this\s+week)?|previously|two\s+(?:days?|weeks?|months?)\s+ago|a\s+(?:few|couple)\s+(?:days?|weeks?|months?)\s+ago|\d+\s+(?:days?|weeks?|months?)\s+ago)\b/.test(folded);
  if (hasEnglishPastVerb && hasEnglishPastAnchor) return true;

  const hasPortuguesePastVerb = /\b(?:paguei|enviei|mandei|marquei|agendei|criei|coloquei|adicionei|deletei|exclu[ií]|cancelei|apaguei|comi|fiz|terminei|conclu[ií]|escrevi|reescrevi|bloqueei|marcou|enviou|mandou|criou|cancelou|apagou|lembrou|lembrei|recebi|recebeu)\b/.test(folded);
  // Phase 4 batch 18: PT past-anchor extended to include number-words (dois,
  // três, ...) inside the "há N dias|semanas|..." pattern. JS regex \b is
  // ASCII-only so we use word-character boundaries around the number-word.
  const hasPortuguesePastAnchor = /\b(?:ontem|(?:semana|m[eê]s|ano|noite|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\s+passad[ao]|anteriormente|h[aá]\s+(?:\d+|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez)\s+(?:dias?|semanas?|meses?|anos?)|h[aá]\s+(?:dias?|semanas?|meses?))\b/.test(folded);
  if (hasPortuguesePastVerb && hasPortuguesePastAnchor) return true;

  // Phase 14 batch 75 (2026-05-16): Spanish past-verb + anchor combined check.
  // Spanish preterite endings differ from Portuguese — `-é` (1st sing) and
  // `-aron`/`-ieron` (3rd plural) are the most common past markers for the
  // verbs the planner cares about.
  const hasSpanishPastVerb = /\b(?:pagu[eé]|envi[eé]|mand[eé]|marqu[eé]|agend[eé]|cre[eé]|coloqu[eé]|a[nñ]ad[ií]|adicion[eé]|borr[eé]|elimin[eé]|cancel[eé]|com[ií]|hice|hic[ie]ron|termin[eé]|complet[eé]|escrib[ií]|reescrib[ií]|bloque[eé]|recib[ií])\b/.test(folded);
  const hasSpanishPastAnchor = /\b(?:ayer|(?:semana|mes|a[nñ]o|noche|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+pasad[ao]|anteriormente|hace\s+(?:\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:d[ií]as?|semanas?|meses?|a[nñ]os?)|hace\s+(?:d[ií]as?|semanas?|meses?))\b/.test(folded);
  if (hasSpanishPastVerb && hasSpanishPastAnchor) return true;

  return false;
}

/**
 * Splits a message into sentence-like chunks on `.!?` boundaries. The split
 * is conservative — we keep adjacent punctuation with the preceding sentence
 * and drop empty fragments. Used by hasPastTenseSignal to scope the
 * past-tense check per sentence.
 */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Returns true when a sentence carries action-verb or mutation-noun intent
 * — i.e., it's a candidate for the planner to claim. Used by
 * hasPastTenseSignal to identify sentences whose past-tense status matters.
 */
function isActionable(sentence: string): boolean {
  const folded = foldCalendarText(sentence);
  // Forward action verbs (any tense, but typically imperative/present).
  // Phase 14 batch 75: Spanish verbs added (crea/añade/elige/manda/...).
  // "manda" added in present-tense imperative (most common Spanish form).
  const hasForwardVerb = /\b(?:cria|criar|create|add|adiciona|adicionar|bota[r]?|coloca[r]?|schedule|agenda[r]?|marca[r]?|book|delete|remove|apaga[r]?|cancel|cancela[r]?|update|change|atualiza[r]?|altera[r]?|muda[r]?|send|enviar|mandar|draft|reply|responder|move|reschedule|reagenda[r]?|push|drop|pay|paga[r]?|process|categori[zs][ae][r]?|tag|classifica[r]?|snooze|adiar|dismiss|dispens[ae][r]?|ignor[ae]r?|choose|pick|escolhe[r]?|follow\s+up|notify|alert|reflow|adjust|ajusta[r]?|build|generate|make|monta[r]?|faz(?:er)?|set\s+up|block\s+off|rewrite|reescreve[r]?|compose|esbo[cç]a[r]?|plan|plane[ja]r|crea[r]?|a[nñ]ade|elig[eo]|env[ií]a|manda|borra[r]?|cambia[r]?|programa[r]?|reescribe[r]?|reorganiza[r]?|mueve[r]?|reprograma[r]?|reconect[aoe]|paga|publica|categoriza|descart[ae]r?|pospon[ae])\b/.test(folded);
  // Mutation nouns or skill-anchor nouns that imply action intent.
  // Phase 14 batch 75: Spanish nouns added (correo/mensaje/factura/cita/tarea/reunion).
  const hasActionNoun = /\b(?:task|tarefa|tarea|todo|lembrete|reminder|recordatorio|event|evento|meeting|reuni[aã]o|reuni[oó]n|appointment|cita|email|e-?mail|mail|correo|mensaje|inbox|caixa|bandeja|recibo|receipt|fatura|factura|invoice|payment|pagamento|stripe|notification|notifica[cç][aã]o|notificaci[oó]n|decis[aã]o|decisi[oó]n|decision|conex[aã]o|conexi[oó]n|connection|training|entrenamiento|treino|workout|run|content|contenido|script|guion|roteiro|reel|brief|meal|refei[cç][aã]o|jantar|almo[cç]o|comida|cena|almuerzo|grocery|compras)\b/.test(folded);
  return hasForwardVerb || hasActionNoun;
}
