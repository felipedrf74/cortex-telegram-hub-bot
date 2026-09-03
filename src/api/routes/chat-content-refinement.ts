// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  checkResponseLocaleFidelity,
  detectStrictShortResponseLanguage,
  expectedLanguageForLocale,
} from '../../services/chat-language-detector';

export type ChatShortcutLanguage = 'pt-BR' | 'pt-PT' | 'en-US';

const CONTENT_REFINEMENT_PATTERNS = [
  /\b(make it|make this|rewrite|shorten|translate|adapt|rework|polish|trim)\b/i,
  /\b(make it shorter|make this shorter|make it punchier|make this punchier)\b/i,
  /\b(vers[aã]o mais curta|mais curto|mais curta|reescreve|reescrever|traduz|traduz isto|adapta|encurta|melhora isto)\b/i,
];

export function isRetryableAIProviderError(err: unknown): err is { retryable?: boolean; status?: number; name?: string; cause?: unknown } {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { retryable?: boolean; status?: number; name?: string; cause?: unknown };
  if (candidate.retryable) return true;
  if (candidate.status === 429) return true;
  if (typeof candidate.status === 'number' && candidate.status >= 500) return true;
  // Codex QA round 4: AI provider timeouts (withTimeout → AITimeoutError)
  // were leaking through as 500s instead of degraded responses. The
  // timeout is by definition transient — treat it as retryable so the
  // route emits a degraded answer + the iOS client can retry.
  if (candidate.name === 'AITimeoutError') return true;
  // Codex QA round 9: typed truncated-output error from provider-fallback.
  // Already exposes retryable=true via class field, but match by name
  // for safety in case the .retryable getter is lost across module
  // boundaries.
  if (candidate.name === 'AIProviderTruncatedError') return true;
  // Codex QA round 5: SDKs (e.g. anthropic-sdk) wrap inner errors in a
  // generic Error with `.cause`. Unwrap up to 3 levels so a wrapped
  // timeout doesn't slip through as a 500.
  let cause = candidate.cause;
  for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth += 1) {
    const inner = cause as { name?: string; status?: number; retryable?: boolean; cause?: unknown };
    if (inner.name === 'AITimeoutError') return true;
    if (inner.retryable) return true;
    if (inner.status === 429) return true;
    if (typeof inner.status === 'number' && inner.status >= 500) return true;
    cause = inner.cause;
  }
  return false;
}

export function isContentRefinementFollowUp(message: string): boolean {
  return CONTENT_REFINEMENT_PATTERNS.some((pattern) => pattern.test(message));
}

export function extractContentRefinementSourceText(previousAssistantMessage: string): string {
  let cleaned = previousAssistantMessage.trim();
  cleaned = cleaned.replace(/^(?:Aviso|Note):[^\n]+(?:\n\n|$)/i, '');
  cleaned = cleaned.replace(/^(?:Roteiro curto|Roteiro|Short script|Script)\s+•[^\n]+(?:\n\n|$)/i, '');
  const refinementSentinels = [
    '\n\nFecho sugerido:',
    '\n\nSuggested closing line:',
    '\n\nTítulos possíveis:',
    '\n\nPossible titles:',
    '\n\nBaseado em ',
    '\n\nGrounded in ',
  ];
  const cutoff = refinementSentinels
    .map((sentinel) => cleaned.indexOf(sentinel))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (typeof cutoff === 'number') {
    cleaned = cleaned.slice(0, cutoff).trim();
  }
  cleaned = sanitizeScriptBody(cleaned);
  return cleaned || previousAssistantMessage.trim();
}

export function buildContentRefinementSystemPrompt(language: ChatShortcutLanguage): string {
  const isPT = language.startsWith('pt');
  return [
    'You revise an existing content draft for chat delivery.',
    isPT
      ? `Responda em ${language === 'pt-PT' ? 'português europeu' : 'pt-BR'}. Este é o contrato de idioma desta resposta; não produza texto em espanhol.`
      : 'Reply in English. Spanish-authored instructions remain on the English response contract. Do not switch output languages from the draft or instruction text.',
    'Revise only the provided draft. Do not invent a new content strategy.',
    'Output only the revised final text for the user.',
    'Do not include headings like SUGGESTED TITLES, THUMBNAIL, CTA, HOOK, SCRIPT, or metadata blocks unless the user explicitly asks for them.',
    'Do not include production markers such as [SFX:], [EDIT:], [SHOW ON SCREEN:], [TAKE], or source sections.',
    'Keep the tone direct, premium, and natural. Avoid filler and assistant framing.',
  ].join('\n');
}

export function buildContentRefinementUserPrompt(
  originalText: string,
  instruction: string,
  language: ChatShortcutLanguage,
): string {
  return [
    language === 'en-US'
      ? 'Revise the draft below according to the user instruction.'
      : 'Revê o rascunho abaixo de acordo com a instrução do utilizador.',
    '',
    language === 'en-US' ? 'User instruction:' : 'Instrução do utilizador:',
    instruction.trim(),
    '',
    language === 'en-US' ? 'Current draft:' : 'Rascunho atual:',
    originalText.trim(),
  ].join('\n');
}

export function buildContentRefinementUnavailableResponse(language: ChatShortcutLanguage): string {
  if (language === 'en-US') {
    return 'I could not revise that content right now. Please try again in a moment.';
  }
  if (language === 'pt-PT') {
    return 'Não consegui rever esse conteúdo agora. Tenta novamente dentro de um momento.';
  }
  return 'Não consegui revisar esse conteúdo agora. Tenta novamente em instantes.';
}

export function buildHeuristicContentRefinementFallback(
  sourceText: string,
  instruction: string,
  language: ChatShortcutLanguage,
): string | null {
  if (!/\b(shorter|shorten|trim|condense|mais curt[ao]|encurta|resume)\b/i.test(instruction)) {
    return null;
  }

  const normalized = sourceText
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
  if (!normalized) return null;

  const expectedLanguage = expectedLanguageForLocale(language);
  const strictSourceLanguage = detectStrictShortResponseLanguage(normalized, expectedLanguage);
  if (
    (strictSourceLanguage && strictSourceLanguage !== expectedLanguage)
    || !checkResponseLocaleFidelity(language, normalized).ok
  ) {
    return null;
  }

  const sentences = normalized
    .match(/[^.!?]+[.!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [normalized];

  let compact = '';
  for (const sentence of sentences) {
    const next = compact ? `${compact} ${sentence}` : sentence;
    if (next.length > 260 && compact) break;
    compact = next;
    if (compact.length >= 170 && /[.!?]$/.test(compact)) break;
  }

  compact = compact || normalized.slice(0, 260).trim();
  compact = compact.replace(/\s+/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();

  if (language === 'en-US') {
    return `Note: live rewrite was unavailable, so this is a conservative shorter version.\n\n${compact}`;
  }
  if (language === 'pt-PT') {
    return `Aviso: a revisão em tempo real ficou indisponível, por isso deixei uma versão mais curta e conservadora.\n\n${compact}`;
  }
  return `Aviso: a revisão em tempo real ficou indisponível, então deixei uma versão mais curta e conservadora.\n\n${compact}`;
}

export function sanitizeScriptBody(script: string): string {
  let cleaned = script.trim();
  const sentinels = [
    '\n📋 SOURCE-BOUND SOURCES:',
    '\nSOURCE-BOUND SOURCES:',
    '\n📋 FONTES ASSOCIADAS:',
    '\nFONTES ASSOCIADAS:',
    '\n📋 FONTES ASSOCIADAS (NÃO VERIFICADAS):',
    '\nFONTES ASSOCIADAS (NÃO VERIFICADAS):',
    // Legacy compatibility only. New generation must never present source-ID
    // binding as factual verification.
    '\n📋 FONTES VERIFICADAS:',
    '\nFONTES VERIFICADAS:',
    '\nCTA:\n',
    '\nCAPTION:\n',
    '\nCaption:\n',
    '\nHASHTAGS:\n',
    '\nHashtags:\n',
    '\n---METADATA---',
  ];
  const cutoff = sentinels
    .map((sentinel) => cleaned.indexOf(sentinel))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (typeof cutoff === 'number') {
    cleaned = cleaned.slice(0, cutoff).trim();
  }
  const filteredLines = cleaned
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !/^\s*={3,}.*={3,}\s*$/i.test(line))
    .filter((line) => !/^\s*(hook|gancho|setup|payoff|script|roteiro|body(?:\s*[-—]\s*point\s*\d+)?|cta|caption|hashtags?|title options|titles|t[ií]tulos?)\s*:?\s*$/i.test(line))
    .filter((line) => !/^\s*(cta|caption|hashtags?|title options|titles|t[ií]tulos?)\s*:/i.test(line));
  cleaned = filteredLines.join('\n').trim();
  cleaned = cleaned
    .replace(/\[(?:SHOW ON SCREEN|ON SCREEN|VISUAL|B-ROLL):[^\]]+\]/gi, '')
    .replace(/\[(?:SFX|EDIT|CUT TO|PLAY CLIP):[^\]]+\]/gi, '')
    .replace(/\[(?:PAUSE|BEAT)\]/gi, '')
    .replace(/\[(?:TAKE)\]/gi, '')
    .replace(/\[(?:VERIFIED|NEEDS VERIFICATION):[^\]]+\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/([!?])\./g, '$1');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}
