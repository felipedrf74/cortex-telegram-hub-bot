// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { normalizeSupportedLang, type Lang } from '../utils/i18n';
import {
  checkResponseLocaleFidelity,
  detectStrictShortResponseLanguage,
  expectedLanguageForLocale,
  type DetectedResponseLanguage,
} from './chat-language-detector';

export class ContentOutputLanguageMismatchError extends Error {
  readonly code = 'CONTENT_OUTPUT_LOCALE_MISMATCH';

  constructor(
    readonly expectedLanguage: DetectedResponseLanguage,
    readonly detectedLanguage: DetectedResponseLanguage,
    readonly boundary: string,
  ) {
    super(
      `Generated content failed the ${boundary} output-language contract `
      + `(expected ${expectedLanguage}, detected ${detectedLanguage})`,
    );
    this.name = 'ContentOutputLanguageMismatchError';
  }
}

/**
 * Canonicalize creator-controlled output selectors without invoking a provider.
 *
 * Missing values may inherit an already-supported request hint. Any explicit
 * retired or unknown value fails closed to English, so historical profile
 * labels can never become prompt instructions for unsupported output.
 */
export function normalizeContentOutputLanguage(
  value: unknown,
  missingValueFallback: Lang = 'en-US',
): Lang {
  const fallback = normalizeSupportedLang(missingValueFallback, 'en-US');
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return normalizeSupportedLang(value, 'en-US');
}

/**
 * Fail closed on deterministic evidence that provider-generated content
 * violates the authenticated EN/PT output contract.
 *
 * The error intentionally carries only categorical language metadata and the
 * named boundary. Raw provider bytes are never copied into errors or logs.
 */
export function assertContentOutputLanguage(
  language: unknown,
  generatedText: string,
  boundary: string,
): Lang {
  const normalizedLanguage = normalizeContentOutputLanguage(language);
  const expectedLanguage = expectedLanguageForLocale(normalizedLanguage);
  const fidelity = checkResponseLocaleFidelity(normalizedLanguage, generatedText);
  const strictLanguage = detectStrictShortResponseLanguage(
    generatedText,
    expectedLanguage,
  );
  const strictContentLanguage = detectStrictContentFieldLanguage(
    generatedText,
    expectedLanguage,
  );
  const detectedLanguage = strictContentLanguage ?? strictLanguage ?? fidelity.detected;
  if (
    (!fidelity.ok && strictContentLanguage !== expectedLanguage)
    || (
      detectedLanguage !== 'unknown'
      && expectedLanguage !== 'unknown'
      && detectedLanguage !== expectedLanguage
    )
  ) {
    throw new ContentOutputLanguageMismatchError(
      expectedLanguage,
      detectedLanguage,
      boundary,
    );
  }
  return normalizedLanguage;
}

/**
 * Validate each independently rendered field as well as the complete payload.
 *
 * Aggregate-only checks can hide a short field in one language beside a much
 * longer field in another. Keeping this helper at the provider boundary makes
 * the rule reusable without copying generated text into telemetry.
 */
export function assertContentOutputLanguageFields(
  language: unknown,
  generatedFields: readonly unknown[],
  boundary: string,
): Lang {
  const normalizedLanguage = normalizeContentOutputLanguage(language);
  const fields: string[] = [];
  for (const value of generatedFields) {
    if (value == null || value === '') continue;
    if (typeof value !== 'string') {
      throwContentOutputShapeMismatch(normalizedLanguage, boundary);
    }
    if (value.trim()) fields.push(value);
  }
  for (const field of fields) {
    assertContentOutputLanguage(normalizedLanguage, field, boundary);
  }
  if (fields.length > 1) {
    assertContentOutputLanguage(normalizedLanguage, fields.join('\n'), boundary);
  }
  return normalizedLanguage;
}

export interface ContentScriptLanguageFields {
  script?: unknown;
  hook?: unknown;
  title_options?: unknown;
  hashtags?: unknown;
  caption?: unknown;
  cta?: unknown;
  warnings?: unknown;
  quality_warnings?: unknown;
  sources_used?: unknown;
  expand_options?: unknown;
}

interface ContentScriptLanguageValidationOptions {
  /** Treat source title/note spans as authenticated request echoes. */
  sourceMetadataIsRequestEcho?: boolean;
}

/** Validate every independently displayed script field before use or storage. */
export function assertContentScriptOutputLanguage(
  language: unknown,
  result: ContentScriptLanguageFields,
  boundary: string,
  options: ContentScriptLanguageValidationOptions = {},
): Lang {
  const normalizedLanguage = normalizeContentOutputLanguage(language);
  if (typeof result.script !== 'string' || !result.script.trim()) {
    throwContentOutputShapeMismatch(normalizedLanguage, boundary);
  }
  const fields: unknown[] = [
    result.script,
    result.hook,
    result.caption,
    result.cta,
  ];
  appendGeneratedTextArray(fields, result.title_options, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, result.hashtags, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, result.warnings, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, result.quality_warnings, normalizedLanguage, boundary);
  if (!options.sourceMetadataIsRequestEcho) {
    appendGeneratedObjectTextField(
      fields,
      result.sources_used,
      'relevance_note',
      normalizedLanguage,
      boundary,
    );
  }
  appendGeneratedObjectTextField(
    fields,
    result.expand_options,
    'label',
    normalizedLanguage,
    boundary,
  );
  return assertContentOutputLanguageFields(normalizedLanguage, fields, boundary);
}

/**
 * Validate the final public response after deterministic response assembly.
 * Raw topic and source-title/URL spans are provenance-exempt; every generated
 * or synthesized display field is checked immediately before storage/send.
 */
export function assertContentScriptPublicOutputLanguage(
  language: unknown,
  value: unknown,
  boundary: string,
  options: ContentScriptLanguageValidationOptions = {},
): Lang {
  const normalizedLanguage = normalizeContentOutputLanguage(language);
  const response = generatedRecord(value, normalizedLanguage, boundary);
  if (typeof response.topic !== 'string' || !response.topic.trim()) {
    throwContentOutputShapeMismatch(normalizedLanguage, boundary);
  }
  const authorizedRawSpans = [
    response.topic,
    ...generatedObjectTextValues(
      response.sourcesUsed,
      'title',
      normalizedLanguage,
      boundary,
    ),
    ...(options.sourceMetadataIsRequestEcho
      ? generatedObjectTextValues(
        response.sourcesUsed,
        'relevanceNote',
        normalizedLanguage,
        boundary,
      )
      : []),
  ];
  const fields: unknown[] = [
    response.script,
    response.hook,
    response.caption,
    response.cta,
  ];
  appendGeneratedTextArray(fields, response.titleOptions, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, response.hashtags, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, response.warnings, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, response.qualityWarnings, normalizedLanguage, boundary);
  if (!options.sourceMetadataIsRequestEcho) {
    appendGeneratedObjectTextField(fields, response.sourcesUsed, 'relevanceNote', normalizedLanguage, boundary);
  }
  appendGeneratedObjectTextField(fields, response.expandOptions, 'label', normalizedLanguage, boundary);
  appendGeneratedObjectTextField(fields, response.nextActions, 'label', normalizedLanguage, boundary);

  const structure = generatedRecord(response.scriptStructure, normalizedLanguage, boundary);
  fields.push(
    structure.firstThreeSeconds,
    structure.promise,
    structure.shortSetup,
    structure.cta,
  );
  appendGeneratedTextArray(fields, structure.titleOptions, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, structure.beatByBeatScript, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, structure.visualDirection, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, structure.editNotes, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, structure.proofSourceNotes, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, structure.riskClaimNotes, normalizedLanguage, boundary);

  const qualityReport = generatedRecord(response.qualityReport, normalizedLanguage, boundary);
  appendGeneratedTextArray(fields, qualityReport.warnings, normalizedLanguage, boundary);
  return assertContentOutputLanguageFields(
    normalizedLanguage,
    maskAuthorizedRawSpans(fields, authorizedRawSpans),
    boundary,
  );
}

// `organizar` and `tu` are deliberately absent: both are valid pt-PT, and TU
// may also be a proper-name span (for example, TU Delft). Short Spanish titles
// that rely on shared vocabulary are matched as complete combinations below.
const SPANISH_CONTENT_WORDS = new Set([
  'borrador', 'borradores', 'consejo', 'consejos', 'contenido', 'contenidos',
  'crea', 'crecer', 'diaria', 'diario', 'guion', 'guiones', 'mejor', 'mejores',
  'organiza', 'productividad', 'rutina', 'rutinas', 'tarea', 'tareas',
]);

const SPANISH_EXCLUSIVE_CONTENT_TITLES = new Set([
  'aprende algo nuevo',
  'comienza hoy',
  'el futuro sostenible',
  'estrategia digital',
  'historias que inspiran',
  'negocios sin limites',
  'vida saludable',
]);

const PORTUGUESE_CONTENT_WORDS = new Set([
  'conteudo', 'fontes', 'guiao', 'hoje', 'opcao', 'proposta', 'proximo',
  'publicar', 'rascunho', 'revisao', 'roteiro', 'tarefas',
]);

const ENGLISH_CONTENT_WORDS = new Set([
  'before', 'changes', 'complete', 'concrete', 'content', 'draft', 'global',
  'how', 'option', 'publish', 'publishing', 'quarterly', 'ready', 'reliable',
  'reports', 'results', 'review', 'script', 'weather', 'workflow',
]);

function detectStrictContentFieldLanguage(
  text: string,
  expectedLanguage: DetectedResponseLanguage,
): DetectedResponseLanguage | null {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const words = normalized.match(/[a-z]+/g) ?? [];
  const count = (vocabulary: ReadonlySet<string>) =>
    words.reduce((total, word) => total + (vocabulary.has(word) ? 1 : 0), 0);
  const es = count(SPANISH_CONTENT_WORDS)
    + (/[¿¡ñ]/i.test(text) ? 1 : 0)
    + (SPANISH_EXCLUSIVE_CONTENT_TITLES.has(words.join(' ')) ? 2 : 0);
  const pt = count(PORTUGUESE_CONTENT_WORDS);
  const en = count(ENGLISH_CONTENT_WORDS);
  if (expectedLanguage === 'en') {
    if (en >= 2 && es <= 1 && pt <= 1) return 'en';
    if (es >= 1 && en < 2) return 'es';
    if (pt >= 1 && en < 2) return 'pt';
  }
  if (expectedLanguage === 'pt') {
    if (pt >= 2 && es <= 1 && en <= 1) return 'pt';
    if (es >= 1 && pt < 2) return 'es';
    if (en >= 1 && pt < 2) return 'en';
  }
  return null;
}

function throwContentOutputShapeMismatch(language: Lang, boundary: string): never {
  throw new ContentOutputLanguageMismatchError(
    expectedLanguageForLocale(language),
    'unknown',
    boundary,
  );
}

function appendGeneratedTextArray(
  target: unknown[],
  value: unknown,
  language: Lang,
  boundary: string,
): void {
  if (value == null) return;
  if (!Array.isArray(value)) throwContentOutputShapeMismatch(language, boundary);
  target.push(...value);
}

function appendGeneratedObjectTextField(
  target: unknown[],
  value: unknown,
  field: string,
  language: Lang,
  boundary: string,
): void {
  target.push(...generatedObjectTextValues(value, field, language, boundary));
}

function generatedObjectTextValues(
  value: unknown,
  field: string,
  language: Lang,
  boundary: string,
): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throwContentOutputShapeMismatch(language, boundary);
  const fields: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throwContentOutputShapeMismatch(language, boundary);
    }
    const fieldValue = (entry as Record<string, unknown>)[field];
    if (fieldValue == null || fieldValue === '') continue;
    if (typeof fieldValue !== 'string') {
      throwContentOutputShapeMismatch(language, boundary);
    }
    fields.push(fieldValue);
  }
  return fields;
}

function generatedRecord(
  value: unknown,
  language: Lang,
  boundary: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwContentOutputShapeMismatch(language, boundary);
  }
  return value as Record<string, unknown>;
}

function maskAuthorizedRawSpans(
  fields: readonly unknown[],
  rawSpans: readonly string[],
): unknown[] {
  const spans = [...new Set(rawSpans.filter((span) => span.trim()))]
    .sort((left, right) => right.length - left.length);
  return fields.map((field) => {
    if (typeof field !== 'string') return field;
    return spans.reduce(
      (masked, span) => masked.split(span).join('Nexus source'),
      field,
    );
  });
}
