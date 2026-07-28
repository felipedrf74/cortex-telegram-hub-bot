// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deterministic response-language detector for the chat locale-fidelity gate.
 *
 * Zero-LLM by design: the only live chat-eval evidence ever collected showed
 * es-419 prompts answered in Portuguese (the recurring failure class already
 * modeled as `portugueseLocalizationLeakage` in chat-hybrid-metrics). This
 * module gives the scorer and staging smoke a discriminative-feature detector
 * that is pt-vs-es confusable-aware and FAILS OPEN on uncertainty: short
 * strings ("OK", "Sí.") and balanced mixed content degrade to 'unknown' with
 * low confidence instead of guessing, so the gate cannot false-positive on
 * one-word answers.
 *
 * Complementary to reply-language-normalizer.ts, which rewrites pt-PT → pt-BR
 * within Portuguese; this module discriminates BETWEEN languages.
 */

export type DetectedResponseLanguage = 'es' | 'pt' | 'en' | 'unknown';

export interface ResponseLanguageDetection {
  language: DetectedResponseLanguage;
  confidence: number;
}

export interface ResponseLocaleFidelityResult {
  ok: boolean;
  expected: DetectedResponseLanguage;
  detected: DetectedResponseLanguage;
  confidence: number;
}

export interface StagingLocaleWritePreviewResult {
  ok: boolean;
  httpStatusAccepted: boolean;
  actionStatus: string | null;
  actionStatusAccepted: boolean;
  replyText: string;
  replyTextPresent: boolean;
  localeFidelity: ResponseLocaleFidelityResult;
}

export interface ResponseLanguageTelemetry {
  expected: DetectedResponseLanguage;
  detected: DetectedResponseLanguage;
  confidence: number;
  /** Null means either side was undecidable; it is never fabricated as a match. */
  matchesExpected: boolean | null;
}

/** Aggregate-safe per-turn telemetry: categorical language + confidence only. */
export function buildResponseLanguageTelemetry(
  promptLocale: string | null | undefined,
  responseText: string,
): ResponseLanguageTelemetry {
  const expected = expectedLanguageForLocale(promptLocale);
  const detection = detectResponseLanguage(responseText);
  return {
    expected,
    detected: detection.language,
    confidence: detection.confidence,
    matchesExpected: expected === 'unknown' || detection.language === 'unknown'
      ? null
      : expected === detection.language,
  };
}

// ── Discriminative features ────────────────────────────────────────────────
// Weights: 3 = orthography impossible in the sibling language,
//          2 = exclusive high-frequency word / suffix,
//          1 = weak but still discriminative.
// Shared es/pt forms (está, para, semana, completada, eliminada, lista, no,
// pronto, ...) are deliberately ABSENT from every list.

// Portuguese-only orthography: ã/õ never occur in Spanish; ç never occurs in
// modern Spanish; â/ê/ô circumflex vowels likewise.
const PT_ORTHOGRAPHY = /[ãõçâêô]/g;

// Spanish-only orthography: ñ and inverted punctuation.
const ES_ORTHOGRAPHY = /[ñ¿¡]/g;

// Suffix discriminators for the classic confusable pairs (-ción vs -ção,
// -sión vs -são, plural -ciones vs -ções). The pt side is already covered by
// PT_ORTHOGRAPHY (ã/ç), so only the es side needs suffix rules.
const ES_SUFFIXES = [/(?:ción|ciones|sión|siones|cción|cciones)$/];

// Portuguese hyphenated enclitics (fazê-lo, criá-la, lembrar-me). Spanish
// attaches clitics without a hyphen (hacerlo), so a hyphenated clitic is a
// strong pt signal.
const PT_CLITIC = /^[a-záéíóúàâêôãõç]{2,}-(?:lo|la|los|las|me|te|se|lhe|lhes|nos)$/;

const PT_WORDS_STRONG = new Set([
  'não', 'você', 'vocês', 'também', 'obrigado', 'obrigada', 'amanhã', 'hoje',
  'tarefa', 'tarefas', 'reunião', 'reuniões', 'feito', 'feita', 'criei',
  'concluída', 'concluído', 'muito', 'muita', 'bem', 'então', 'são', 'até',
  'às', 'é', 'já', 'sexta-feira', 'segunda-feira', 'terça-feira',
  'quarta-feira', 'quinta-feira', 'agendei', 'marquei', 'adicionei',
  'lembrete', 'atrasadas', 'atrasados', 'depois', 'fazer', 'pode', 'quer',
  'encontrei', 'nenhuma', 'nenhum', 'seu', 'sua', 'seus', 'suas', 'leite',
  'almoço', 'manhã', 'têm', 'possui', 'ligar', 'esse', 'essa', 'isso',
]);

const PT_WORDS_WEAK = new Set([
  'com', 'em', 'uma', 'um', 'dia', 'dos', 'das', 'da', 'os', 'as', 'ou',
  'tem', 'sim', 'sem', 'mais', 'duas', 'dois', 'criada', 'criado', 'livre',
  'e', 'o', 'a',
]);

const ES_WORDS_STRONG = new Set([
  'usted', 'ustedes', 'también', 'aquí', 'hoy', 'mañana', 'tarea', 'tareas',
  'hecho', 'hecha', 'creé', 'agregué', 'agregado', 'agregar', 'listo',
  'muy', 'pero', 'hasta', 'cómo', 'qué', 'sí', 'gracias', 'buenos', 'buenas',
  'puede', 'puedes', 'hacer', 'hice', 'tienes', 'tiene', 'quieres', 'quiere',
  'reunión', 'reuniones', 'leche', 'almuerzo', 'después', 'viernes', 'lunes',
  'martes', 'miércoles', 'jueves', 'sábado', 'domingo', 'agendé', 'marqué',
  'encontré', 'ninguna', 'ningún', 'recordatorio', 'atrasadas', 'llamada',
  'llamado', 'llamar', 'con', 'del', 'una', 'y', 'ya', 'eso', 'esa', 'ese',
]);

const ES_WORDS_WEAK = new Set([
  'el', 'los', 'las', 'la', 'al', 'es', 'le', 'lo', 'su', 'sus', 'dos',
  'libre', 'creado', 'creada', 'más', 'sin',
]);

const EN_WORDS_STRONG = new Set([
  'the', 'and', 'is', 'are', 'was', 'were', 'you', 'your', 'have', 'has',
  'with', 'task', 'tasks', 'done', 'added', 'created', 'tomorrow', 'today',
  'meeting', 'meetings', 'i', "i've", "i'll", 'will', 'would', 'this', 'that',
  'here', 'week', 'reminder', 'overdue', 'scheduled', 'schedule', 'free',
  'morning', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'like', 'buy', 'milk', 'call', 'pay', 'after', 'well',
]);

const EN_WORDS_WEAK = new Set([
  'to', 'of', 'in', 'on', 'for', 'at', 'it', 'as', 'me', 'my', 'an', 'or',
  'not', 'do', 'can', 'also', 'am', 'pm',
]);

// Words that appear in both strong sets on purpose (e.g. "también" is es-only
// while "também" is pt-only — no overlap), but "atrasadas" is genuinely shared
// es/pt. Shared entries in both lists cancel out, which is exactly the neutral
// behavior we want for true cognates.

interface LanguageScores {
  es: number;
  pt: number;
  en: number;
}

function scoreText(text: string): { scores: LanguageScores; wordCount: number } {
  const lower = text.toLowerCase();
  const scores: LanguageScores = { es: 0, pt: 0, en: 0 };

  scores.pt += (lower.match(PT_ORTHOGRAPHY) ?? []).length * 3;
  scores.es += (lower.match(ES_ORTHOGRAPHY) ?? []).length * 3;

  const words = lower.match(/[a-záéíóúàâêôãõçñü'’-]+/g) ?? [];
  for (const rawWord of words) {
    const word = rawWord.replace(/’/g, "'");
    if (PT_WORDS_STRONG.has(word)) scores.pt += 2;
    else if (PT_WORDS_WEAK.has(word)) scores.pt += 1;
    else if (PT_CLITIC.test(word)) scores.pt += 2;

    if (ES_WORDS_STRONG.has(word)) scores.es += 2;
    else if (ES_WORDS_WEAK.has(word)) scores.es += 1;
    else if (ES_SUFFIXES.some((suffix) => suffix.test(word))) scores.es += 2;

    if (EN_WORDS_STRONG.has(word)) scores.en += 2;
    else if (EN_WORDS_WEAK.has(word)) scores.en += 1;
  }

  return { scores, wordCount: words.length };
}

const UNKNOWN: ResponseLanguageDetection = { language: 'unknown', confidence: 0 };

// Minimum evidence before we are willing to name a language at all.
const MIN_SIGNAL = 2;
// Short strings need MORE evidence, not less: a one/two-word answer must show
// unambiguous orthography+vocabulary before we stop failing open.
const SHORT_TEXT_WORD_LIMIT = 3;
const SHORT_TEXT_MIN_SIGNAL = 5;
// Mixed-content guard: if the runner-up holds a substantial share of the
// signal, the text is bilingual and we refuse to pick a side.
const MIXED_RUNNER_UP_RATIO = 0.6;
const MIXED_RUNNER_UP_MIN = 3;

export function detectResponseLanguage(text: string): ResponseLanguageDetection {
  if (!text || !text.trim()) return { ...UNKNOWN };

  const { scores, wordCount } = scoreText(text);
  if (wordCount === 0) return { ...UNKNOWN };

  const ranked = (Object.entries(scores) as Array<[DetectedResponseLanguage, number]>)
    .sort((left, right) => right[1] - left[1]);
  const [topLanguage, topScore] = ranked[0];
  const runnerUpScore = ranked[1][1];
  const signal = scores.es + scores.pt + scores.en;

  const lowConfidence = signal === 0
    ? 0
    : Math.min(0.4, (topScore / signal) * 0.4);

  if (topScore < MIN_SIGNAL) return { language: 'unknown', confidence: lowConfidence };
  if (wordCount <= SHORT_TEXT_WORD_LIMIT && topScore < SHORT_TEXT_MIN_SIGNAL) {
    return { language: 'unknown', confidence: lowConfidence };
  }
  if (runnerUpScore >= MIXED_RUNNER_UP_MIN && runnerUpScore >= topScore * MIXED_RUNNER_UP_RATIO) {
    return { language: 'unknown', confidence: lowConfidence };
  }

  const purity = topScore / signal;
  const density = Math.min(1, topScore / 8);
  const confidence = Math.min(0.98, purity * (0.6 + 0.4 * density));
  return { language: topLanguage, confidence };
}

export function expectedLanguageForLocale(locale: string | null | undefined): DetectedResponseLanguage {
  if (!locale) return 'unknown';
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === 'es') return 'es';
  if (primary === 'pt') return 'pt';
  if (primary === 'en') return 'en';
  return 'unknown';
}

/**
 * Blocking-check core for the locale-fidelity gate.
 *
 * Returns ok:true whenever detection (or the locale mapping) is 'unknown' —
 * the gate must fail open on uncertainty so one-word answers like "OK" never
 * trip it. It only returns ok:false when the detector confidently names a
 * language that contradicts the prompt locale.
 */
export function checkResponseLocaleFidelity(
  promptLocale: string | null | undefined,
  responseText: string,
): ResponseLocaleFidelityResult {
  const expected = expectedLanguageForLocale(promptLocale);
  const detection = detectResponseLanguage(responseText);
  const ok = expected === 'unknown'
    || detection.language === 'unknown'
    || detection.language === expected;
  return {
    ok,
    expected,
    detected: detection.language,
    confidence: detection.confidence,
  };
}

/**
 * Contract used by the staging locale smoke's canned task-create turns.
 * Both 200 and 202 are valid transport outcomes across the legacy/preview
 * routing seams, but the semantic envelope must still prove this is a safe
 * confirmation preview. A missing status or any success/mutation claim fails
 * closed even when the response language is correct.
 */
export function checkStagingLocaleWritePreview(
  promptLocale: string | null | undefined,
  httpStatus: number,
  responseBody: unknown,
): StagingLocaleWritePreviewResult {
  const body = asRecord(responseBody);
  const data = asRecord(body?.data);
  const metadata = asRecord(body?.metadata) ?? asRecord(data?.metadata);
  const replyText = typeof body?.text === 'string'
    ? body.text
    : typeof data?.text === 'string'
      ? data.text
      : '';
  const rawActionStatus = metadata?.actionStatus;
  const actionStatus = typeof rawActionStatus === 'string' && rawActionStatus.trim()
    ? rawActionStatus.trim()
    : null;
  const httpStatusAccepted = httpStatus === 200 || httpStatus === 202;
  const actionStatusAccepted = actionStatus === 'needs_confirmation';
  const replyTextPresent = replyText.trim().length > 0;
  const localeFidelity = checkResponseLocaleFidelity(promptLocale, replyText);

  return {
    ok: httpStatusAccepted
      && actionStatusAccepted
      && replyTextPresent
      && localeFidelity.ok,
    httpStatusAccepted,
    actionStatus,
    actionStatusAccepted,
    replyText,
    replyTextPresent,
    localeFidelity,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
