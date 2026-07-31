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
  'das', 'fontes', 'atuais', 'notícias', 'mais', 'resumo',
  'conteúdo', 'conteúdos',
]);

const PT_WORDS_WEAK = new Set([
  'com', 'em', 'uma', 'um', 'dia', 'dos', 'da', 'os', 'as', 'ou',
  'tem', 'sim', 'sem', 'duas', 'dois', 'criada', 'criado', 'livre',
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

function scoreText(text: string): {
  scores: LanguageScores;
  strongScores: LanguageScores;
  wordCount: number;
} {
  const lower = text.toLowerCase();
  const scores: LanguageScores = { es: 0, pt: 0, en: 0 };
  const strongScores: LanguageScores = { es: 0, pt: 0, en: 0 };

  const ptOrthographyScore = (lower.match(PT_ORTHOGRAPHY) ?? []).length * 3;
  const esOrthographyScore = (lower.match(ES_ORTHOGRAPHY) ?? []).length * 3;
  scores.pt += ptOrthographyScore;
  strongScores.pt += ptOrthographyScore;
  scores.es += esOrthographyScore;
  strongScores.es += esOrthographyScore;

  const words = lower.match(/[a-záéíóúàâêôãõçñü'’-]+/g) ?? [];
  for (const rawWord of words) {
    const word = rawWord.replace(/’/g, "'");
    if (PT_WORDS_STRONG.has(word)) {
      scores.pt += 2;
      strongScores.pt += 2;
    }
    else if (PT_WORDS_WEAK.has(word)) scores.pt += 1;
    else if (PT_CLITIC.test(word)) {
      scores.pt += 2;
      strongScores.pt += 2;
    }

    if (ES_WORDS_STRONG.has(word)) {
      scores.es += 2;
      strongScores.es += 2;
    }
    else if (ES_WORDS_WEAK.has(word)) scores.es += 1;
    else if (ES_SUFFIXES.some((suffix) => suffix.test(word))) {
      scores.es += 2;
      strongScores.es += 2;
    }

    if (EN_WORDS_STRONG.has(word)) {
      scores.en += 2;
      strongScores.en += 2;
    }
    else if (EN_WORDS_WEAK.has(word)) scores.en += 1;
  }

  return { scores, strongScores, wordCount: words.length };
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

/**
 * Input-only compatibility signal for short Spanish requests. Unlike the
 * response detector, this may use a small exact vocabulary because choosing
 * English is a safe compatibility fallback and does not rewrite user data.
 */
export function detectRetiredSpanishInputSignal(text: string): boolean {
  if (!text || !text.trim()) return false;
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¿¡!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (
    /[¿¡ñ]/i.test(text)
    || /^(?:hola|buenos dias|buenas tardes|buenas noches|gracias|quiero ayuda)$/.test(normalized)
    || /\b(?:crea|cancela|elimina)\s+(?:(?:un|una|el|la|los|las|mi|mis|tu|tus|este|esta)\s+)?(?:tarea|tareas|evento|eventos|recordatorio|recordatorios|cita|citas|correo|correos|notificacion|notificaciones)\b/.test(normalized)
  ) {
    return true;
  }
  const tokens = new Set(normalized.match(/\b[a-z0-9-]+\b/g) ?? []);
  const exclusiveHits = [
    'hola',
    'gracias',
    'quiero',
    'necesito',
    'ayuda',
    'tengo',
    'tienes',
    'puedes',
    'dame',
    'dime',
    'muestra',
    'busca',
    'crea',
    'cancela',
    'elimina',
  ].reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0);
  return exclusiveHits >= 2;
}

export function detectResponseLanguage(text: string): ResponseLanguageDetection {
  if (!text || !text.trim()) return { ...UNKNOWN };

  const { scores, strongScores, wordCount } = scoreText(text);
  if (wordCount === 0) return { ...UNKNOWN };

  const ranked = (Object.entries(scores) as Array<[keyof LanguageScores, number]>)
    .sort((left, right) => right[1] - left[1]);
  const [topLanguage, topScore] = ranked[0];
  const runnerUpScore = ranked[1][1];
  const signal = scores.es + scores.pt + scores.en;

  const lowConfidence = signal === 0
    ? 0
    : Math.min(0.4, (topScore / signal) * 0.4);

  if (topScore < MIN_SIGNAL) return { language: 'unknown', confidence: lowConfidence };
  // Weak articles/prepositions can repeat in text from another language.
  // Never name a language unless its winning score includes at least one
  // discriminative feature; callers may then safely block any named mismatch.
  if (strongScores[topLanguage] === 0) {
    return { language: 'unknown', confidence: lowConfidence };
  }
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

/**
 * Exact unambiguous acknowledgements that are intentionally too short for
 * the statistical detector. Terminal output boundaries use this zero-spend
 * seam to contain obvious cross-locale replies while general telemetry keeps
 * failing open on arbitrary short text.
 */
export function detectStrictShortResponseLanguage(
  text: string,
  expectedLanguage?: DetectedResponseLanguage,
): Exclude<DetectedResponseLanguage, 'unknown'> | null {
  const sentences = text
    .trim()
    .toLowerCase()
    .split(/[.!?…]+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (sentences.some((sentence) =>
    /^(?:aquí (?:tienes|está)|listo|hech[oa]|sí(?:,? claro)?|claro,? aquí (?:tienes|está)|hola|buenos días|buenas tardes|buenas noches|gracias(?: por esperar)?|quiero ayuda)$/.test(sentence)
  )) {
    return 'es';
  }
  if (
    expectedLanguage === 'en'
    && sentences.some((sentence) => /^(?:entendid[oa]|de acuerdo)$/.test(sentence))
  ) {
    // These acknowledgements are shared across Spanish and Portuguese. They
    // are safe under a Portuguese contract but are definitely not English.
    return 'es';
  }
  if (sentences.some((sentence) =>
    /^(?:aqui está|pront[oa]|feit[oa]|sim(?:,? claro)?|claro,? aqui está)$/.test(sentence)
  )) {
    return 'pt';
  }
  if (sentences.some((sentence) =>
    /^(?:here you go|done|ready|yes(?:,? of course)?|of course,? here it is)$/.test(sentence)
  )) {
    return 'en';
  }
  return null;
}

export function expectedLanguageForLocale(locale: string | null | undefined): DetectedResponseLanguage {
  if (!locale) return 'unknown';
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  // Spanish is no longer a supported response locale. Old clients may still
  // send es-* during the compatibility window, so the observable contract is
  // the same English fallback used at the request boundary.
  if (primary === 'es') return 'en';
  if (primary === 'pt') return 'pt';
  if (primary === 'en') return 'en';
  return 'unknown';
}

/**
 * Blocking-check core for the locale-fidelity gate.
 *
 * Returns ok:true whenever detection (or the locale mapping) is 'unknown'.
 * The detector itself fails open on one-word answers and weak-only lexical
 * coincidences; once it names a language from discriminative evidence, any
 * contradiction is a blocking mismatch.
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
