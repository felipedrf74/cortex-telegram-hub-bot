// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from './calendar-natural-language-parser';

export type ChatMultiStepSplitConfidence = 'single' | 'low_confidence_multi' | 'multi';

export interface ChatMultiStepSegment {
  index: number;
  text: string;
  connective: string | null;
  languageHint?: 'en' | 'pt' | 'es';
  pronounMentions: string[];
}

export interface ChatMultiStepSplitResult {
  classification: ChatMultiStepSplitConfidence;
  confidence: number;
  segments: ChatMultiStepSegment[];
  reason: string;
  /**
   * M16: number of actionable segments beyond MAX_SEGMENTS that were found
   * but NOT included in `segments`. The response layer must disclose the
   * overflow instead of silently dropping the extra requests.
   */
  overflowCount: number;
}

const MAX_SEGMENTS = 5;
// M16 adversarial fix: '&' is live splitter vocabulary (relaxed semantics,
// matching the DAG's RELAXED_CONNECTIVES) — 'A & B' must actually split.
const CONNECTIVE_PATTERN = /\s*(?:;|,|\+|&|\b(?:and then|then|also|plus|and|e depois|depois|tamb[eé]m|e|y luego|luego|tambi[eé]n|y)\b)\s*/gi;
const CONNECTIVE_CAPTURE_PATTERN = /^(?:;|,|\+|&|and then|then|also|plus|and|e depois|depois|tamb[eé]m|e|y luego|luego|tambi[eé]n|y)$/i;

export function splitChatMultiStepRequest(text: string): ChatMultiStepSplitResult {
  const original = text.trim();
  if (!original) return { classification: 'single', confidence: 0, segments: [], reason: 'empty', overflowCount: 0 };

  const quoted = liftQuotedSpans(original);
  const sentenceParts = splitSentenceScopes(quoted.masked);
  const pieces: Array<{ text: string; connective: string | null }> = [];
  for (const sentence of sentenceParts) {
    pieces.push(...splitScopeOnActionConnectives(sentence));
  }

  const restored = pieces
    .map((piece) => ({
      ...piece,
      text: restoreQuotedSpans(piece.text, quoted.spans).trim(),
    }))
    .filter((piece) => piece.text.length > 0);

  const actionableAll = restored.filter((piece) => (
    isActionableSegment(piece.text) && !isNegatedSafetyBoundary(piece.text)
  ));
  const actionable = actionableAll.slice(0, MAX_SEGMENTS);
  // M16: segments beyond the cap are DISCLOSED, never silently dropped.
  const overflowCount = Math.max(0, actionableAll.length - actionable.length);
  if (actionable.length < 2) {
    return {
      classification: 'single',
      confidence: 0.35,
      segments: segmentRecords(restored.length > 0 ? [restored[0]] : [{ text: original, connective: null }]),
      reason: 'fewer_than_two_actionable_segments',
      overflowCount: 0,
    };
  }

  const strongSequential = actionable.some((piece) => /\b(?:then|and then|depois|e depois|luego|y luego)\b/i.test(piece.connective ?? ''));
  const relaxedSibling = actionable.some((piece) => /^(?:,|\+|also|plus|tamb[eé]m|tambi[eé]n)$/i.test(piece.connective ?? ''));
  const crossSkillHint = countSkillHints(actionable.map((piece) => piece.text)) > 1;
  const confidence = Math.min(0.96, 0.72
    + (strongSequential ? 0.12 : 0)
    + (relaxedSibling ? 0.05 : 0)
    + (crossSkillHint ? 0.08 : 0)
    + (actionable.length >= 3 ? 0.05 : 0));

  return {
    classification: confidence >= 0.78 ? 'multi' : 'low_confidence_multi',
    confidence,
    segments: segmentRecords(actionable),
    reason: strongSequential ? 'sequential_connective' : crossSkillHint ? 'cross_skill_action_segments' : 'action_connective',
    overflowCount,
  };
}

function liftQuotedSpans(text: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  const masked = text.replace(/(["“”'‘’])([^"“”'‘’]{1,240})\1/g, (match) => {
    const token = `__QUOTE_${spans.length}__`;
    spans.push(match);
    return token;
  });
  return { masked, spans };
}

function restoreQuotedSpans(text: string, spans: string[]): string {
  return text.replace(/__QUOTE_(\d+)__/g, (_match, rawIndex) => spans[Number(rawIndex)] ?? '');
}

function splitSentenceScopes(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitScopeOnActionConnectives(scope: string): Array<{ text: string; connective: string | null }> {
  const tokens: Array<{ value: string; isConnector: boolean }> = [];
  let cursor = 0;
  for (const match of scope.matchAll(CONNECTIVE_PATTERN)) {
    const index = match.index ?? 0;
    const before = scope.slice(cursor, index);
    if (before.trim()) tokens.push({ value: before.trim(), isConnector: false });
    const rawConnector = match[0].trim();
    if (rawConnector && CONNECTIVE_CAPTURE_PATTERN.test(rawConnector)) tokens.push({ value: rawConnector, isConnector: true });
    cursor = index + match[0].length;
  }
  const tail = scope.slice(cursor).trim();
  if (tail) tokens.push({ value: tail, isConnector: false });
  if (tokens.filter((token) => !token.isConnector).length <= 1) return [{ text: scope, connective: null }];

  const out: Array<{ text: string; connective: string | null }> = [];
  let pendingConnector: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.isConnector) {
      pendingConnector = token.value;
      continue;
    }
    if (out.length === 0 || hasForwardActionVerb(token.value)) {
      out.push({ text: token.value, connective: out.length === 0 ? null : pendingConnector });
      pendingConnector = null;
      continue;
    }
    const previous = out[out.length - 1];
    if (previous) previous.text = `${previous.text} ${pendingConnector ?? ''} ${token.value}`.replace(/\s+/g, ' ').trim();
    pendingConnector = null;
  }
  return out.length > 0 ? out : [{ text: scope, connective: null }];
}

function segmentRecords(pieces: Array<{ text: string; connective: string | null }>): ChatMultiStepSegment[] {
  return pieces.slice(0, MAX_SEGMENTS).map((piece, index) => ({
    index,
    text: piece.text,
    connective: piece.connective,
    languageHint: inferLanguageHint(piece.text),
    pronounMentions: extractPronounMentions(piece.text),
  }));
}

function inferLanguageHint(text: string): 'en' | 'pt' | 'es' | undefined {
  const folded = foldCalendarText(text);
  if (/\b(?:amanha|amanhã|tarefa|reuniao|reunião|lembrete|jantar|almoço|almoco|compras|treino)\b/.test(folded)) return 'pt';
  if (/\b(?:mañana|manana|tarea|reunion|reunión|recordatorio|cena|almuerzo|entrenamiento)\b/.test(folded)) return 'es';
  if (/\b(?:tomorrow|task|meeting|reminder|dinner|lunch|workout|email)\b/.test(folded)) return 'en';
  return undefined;
}

// M16 adversarial fix: relaxed connectives ('and'/'e'/'y') only stay
// independent when NO anaphora links the segments, so the extraction
// vocabulary must cover the common PT contracted forms ('nela', 'dele', …),
// ES clitics ('la'/'lo'/'le' standalone plus 'agrégale'-style verb+clitic),
// and EN definite anaphora phrases ('the list', 'that one'). All patterns
// are word-boundary safe; over-matching (e.g. an ES article 'la') is
// accepted as CONSERVATIVE — an extracted mention can only cause chaining
// or $ref wiring, never an unsafe independent execution.
const FOLDED_ANAPHORA_PATTERN = new RegExp(
  [
    // EN pronouns + definite anaphora phrases (longer phrases first).
    String.raw`that one`,
    String.raw`the (?:list|task|event|reminder)`,
    String.raw`it|that|this`,
    // PT pronouns + contracted anaphora.
    String.raw`isso|isto|essa|esta|ele|ela|nela|nele|dela|dele|nisso|nisto`,
    // ES demonstratives + standalone clitics.
    String.raw`eso|esto|ese|esa|la|lo|le`,
  ].map((part) => `\\b(?:${part})\\b`).join('|'),
  'g',
);
// ES verb+enclitic ('agrégale', 'bórrala', 'complétalo', …): detected on the
// RAW lowercased text because the stressed-stem accent is the conservative
// signal that the trailing la/lo/le is a clitic and not a word ending —
// foldCalendarText strips accents, so this cannot run on the folded text.
const ES_VERB_CLITIC_SUFFIX_PATTERN = /\b[a-zñ]*[áéíóú][a-zñ]*(?:la|lo|le|las|los|les)\b/g;

function extractPronounMentions(text: string): string[] {
  const folded = foldCalendarText(text);
  const matches = folded.match(FOLDED_ANAPHORA_PATTERN) ?? [];
  const cliticMatches = text.normalize('NFC').toLowerCase().match(ES_VERB_CLITIC_SUFFIX_PATTERN) ?? [];
  return [...new Set([...matches, ...cliticMatches])];
}

function countSkillHints(texts: string[]): number {
  const skills = new Set<string>();
  for (const text of texts) {
    const folded = foldCalendarText(text);
    if (/\b(?:task|tarefa|tarea|todo|checklist|subtask|subtarefa)\b/.test(folded)) skills.add('tasks');
    if (/\b(?:event|meeting|agenda|calendar|evento|reuniao|reunião|cita|reunion|reunión)\b/.test(folded)) skills.add('calendar');
    if (/\b(?:email|mail|inbox|correo|mensaje)\b/.test(folded)) skills.add('mail');
    if (/\b(?:content|conteudo|conteúdo|reel|script|brief|roteiro|guion)\b/.test(folded)) skills.add('content');
    if (/\b(?:meal|dinner|lunch|jantar|almoco|almoço|cena|almuerzo|recipe|receita)\b/.test(folded)) skills.add('cooking');
    if (/\b(?:finance|fatura|invoice|payment|pagamento|receipt|recibo|factura)\b/.test(folded)) skills.add('finance');
    if (/\b(?:training|treino|workout|run|entrenamiento)\b/.test(folded)) skills.add('training');
  }
  return skills.size;
}

function isActionableSegment(text: string): boolean {
  const folded = foldCalendarText(text);
  const hasActionNoun = /\b(?:task|tarefa|tarea|todo|reminder|lembrete|recordatorio|event|evento|meeting|reuni[aã]o|reuni[oó]n|appointment|cita|email|mail|correo|mensaje|receipt|recibo|fatura|factura|invoice|payment|pagamento|notification|notifica[cç][aã]o|decision|decis[aã]o|decisi[oó]n|connection|conex[aã]o|training|treino|workout|run|content|conte[uú]do|script|roteiro|reel|brief|meal|refei[cç][aã]o|jantar|almo[cç]o|cena|almuerzo|grocery|compras|ingredient|ingrediente)\b/.test(folded);
  return hasForwardActionVerb(text) || hasActionNoun;
}

function isNegatedSafetyBoundary(text: string): boolean {
  const folded = foldCalendarText(text).trim();
  const match = folded.match(/^(?:do not|don't|never|nao|nunca|no)\s+(.+)$/);
  return match ? hasForwardActionVerb(match[1]) : false;
}

function hasForwardActionVerb(text: string): boolean {
  const folded = foldCalendarText(text);
  return /\b(?:create|add|schedule|agenda[r]?|book|delete|remove|cancel|update|change|send|draft|reply|move|reschedule|pay|categorize|snooze|dismiss|choose|pick|notify|alert|reflow|adjust|build|generate|make|set\s+up|block\s+off|rewrite|compose|plan|mark|complete|publish|post|upload|queue|cria[r]?|adiciona[r]?|marca[r]?|agendar|apaga[r]?|cancela[r]?|atualiza[r]?|muda[r]?|envia[r]?|manda[r]?|mover|remarca[r]?|paga[r]?|classifica[r]?|escolhe[r]?|notifica[r]?|ajusta[r]?|faz(?:er)?|plane[ja]r|reescreve[r]?|criar|crear|a[nñ]ade|programa[r]?|borra[r]?|cambia[r]?|env[ií]a|elige|mueve|reprograma|publica[r]?|postar|postea[r]?|subir|categoriza|sustituye|substitui|replace|substitute)\b/.test(folded);
}
