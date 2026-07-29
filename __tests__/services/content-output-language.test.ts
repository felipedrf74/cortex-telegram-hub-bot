import { describe, expect, it } from 'vitest';
import {
  ContentOutputLanguageMismatchError,
  assertContentOutputLanguage,
  assertContentOutputLanguageFields,
  assertContentScriptOutputLanguage,
  assertContentScriptPublicOutputLanguage,
  normalizeContentOutputLanguage,
} from '../../src/services/content-output-language';

describe('content output language', () => {
  it.each([
    ['en', 'en-US'],
    ['English', 'en-US'],
    ['pt', 'pt-BR'],
    ['Brazilian Portuguese', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['European Portuguese', 'pt-PT'],
    ['es-419', 'en-US'],
    ['Spanish', 'en-US'],
    ['Español', 'en-US'],
    ['fr-FR', 'en-US'],
  ])('normalizes explicit selector %s to %s', (input, expected) => {
    expect(normalizeContentOutputLanguage(input)).toBe(expected);
  });

  it('uses a canonical request hint only when the profile selector is missing', () => {
    expect(normalizeContentOutputLanguage('', 'pt-PT')).toBe('pt-PT');
    expect(normalizeContentOutputLanguage(undefined, 'pt-BR')).toBe('pt-BR');
    expect(normalizeContentOutputLanguage('Spanish', 'pt-BR')).toBe('en-US');
    expect(normalizeContentOutputLanguage('fr-FR', 'pt-PT')).toBe('en-US');
  });

  it.each([
    ['en-US', 'Here is the complete script and the next step.'],
    ['pt-BR', 'Aqui está o roteiro completo e o próximo passo.'],
    ['pt-PT', 'Aqui está o guião completo e o próximo passo.'],
  ])('accepts generated output that matches the canonical %s contract', (language, text) => {
    expect(assertContentOutputLanguage(language, text, 'unit-test')).toBe(
      normalizeContentOutputLanguage(language),
    );
  });

  it.each([
    ['en-US', 'Aquí tienes el guion completo y la próxima tarea.'],
    ['pt-BR', 'Here is the complete script and the next task.'],
    ['pt-PT', 'Aquí tienes el guion completo y la próxima tarea.'],
  ])('rejects generated output that violates the canonical %s contract', (language, text) => {
    expect(() => assertContentOutputLanguage(language, text, 'unit-test')).toThrowError(
      expect.objectContaining<Partial<ContentOutputLanguageMismatchError>>({
        code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
        boundary: 'unit-test',
      }),
    );
  });

  it('rejects unambiguous short Spanish output under English without logging or returning raw bytes', () => {
    const error = (() => {
      try {
        assertContentOutputLanguage('en-US', 'Aquí tienes.', 'short-output-test');
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ContentOutputLanguageMismatchError);
    expect(error).toMatchObject({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      expectedLanguage: 'en',
      detectedLanguage: 'es',
      boundary: 'short-output-test',
    });
    expect(String(error)).not.toContain('Aquí tienes.');
  });

  it('rejects one Spanish field even when a much longer sibling field is English', () => {
    expect(() => assertContentOutputLanguageFields('en-US', [
      'This complete script explains the workflow in clear English with several concrete steps, examples, checks, and a final review.',
      'Cómo organizar tus tareas',
    ], 'field-level-test')).toThrowError(expect.objectContaining({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'field-level-test',
    }));
  });

  it.each([
    'Mi rutina diaria',
    'Guion inicial',
    'Plan de contenido',
    'Organiza tu día',
    'Ideas para crecer',
    'Consejos de productividad',
    'Crea mejores hábitos',
  ])('rejects short Spanish content field %s under English', (field) => {
    expect(() => assertContentOutputLanguageFields('en-US', [
      'This complete script explains the workflow in clear English with concrete steps, checks, examples, and a final review.',
      field,
    ], 'short-content-field')).toThrowError(expect.objectContaining({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'short-content-field',
    }));
  });

  it.each([
    'Draft option',
    'Content plan',
    'Review before publishing',
    'Ready to publish',
  ])('rejects short English content field %s under Portuguese', (field) => {
    expect(() => assertContentOutputLanguageFields('pt-BR', [
      'Aqui está o guião completo com tarefas, fontes, exemplos e o próximo passo para hoje.',
      field,
    ], 'short-content-field')).toThrowError(expect.objectContaining({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'short-content-field',
    }));
  });

  it.each([
    ['pt-BR', 'Organizar as tarefas diárias'],
    ['pt-PT', 'Tu podes rever o guião amanhã.'],
    ['pt-PT', 'Conteúdo para TU Delft'],
  ])('accepts Portuguese output without treating shared tokens or proper names as Spanish: %s', (language, field) => {
    expect(assertContentOutputLanguageFields(language, [field], 'portuguese-content-field')).toBe(
      language,
    );
  });

  it.each([
    'Vida saludable',
    'Estrategia digital',
    'Aprende algo nuevo',
    'Historias que inspiran',
    'Comienza hoy',
    'Negocios sin límites',
    'El futuro sostenible',
  ])('rejects Spanish-exclusive short title %s under English', (field) => {
    expect(() => assertContentOutputLanguageFields(
      'en-US',
      [field],
      'spanish-title-field',
    )).toThrowError(expect.objectContaining({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      expectedLanguage: 'en',
      detectedLanguage: 'es',
      boundary: 'spanish-title-field',
    }));
  });

  it.each([
    'Con Edison Reports Quarterly Results',
    'How El Niño Changes Global Weather',
  ])('does not reject an English title containing a proper-name Spanish signal: %s', (field) => {
    expect(assertContentOutputLanguageFields('en-US', [field], 'proper-name-field')).toBe('en-US');
  });

  it('fails closed on malformed generated field shapes', () => {
    expect(() => assertContentScriptOutputLanguage('en-US', {
      script: 'This is a complete English script with one concrete action.',
      hook: 'Start with the result.',
      title_options: ['A reliable workflow'],
      hashtags: [{ text: 'Aquí tienes etiquetas' }],
      caption: { text: 'Aquí tienes la descripción' },
    }, 'shape-test')).toThrowError(expect.objectContaining({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'shape-test',
    }));
  });

  it('validates all generated script metadata fields independently', () => {
    expect(() => assertContentScriptOutputLanguage('en-US', {
      script: 'This is a complete English script with one concrete action.',
      hook: 'Start with the result.',
      title_options: ['A reliable workflow'],
      warnings: ['Aquí tienes una advertencia importante.'],
      quality_warnings: [],
      sources_used: [{
        title: 'Raw third-party title',
        url: 'https://example.test/source',
        relevance_note: 'Aquí tienes la explicación completa.',
      }],
      expand_options: [{
        id: 'expand',
        label: 'Cómo mejorar el guion',
        action: 'expand_full',
      }],
    }, 'metadata-test')).toThrowError(expect.objectContaining({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'metadata-test',
    }));
  });

  it('exempts only exact raw topic and source-title spans in the final public response', () => {
    expect(assertContentScriptPublicOutputLanguage('en-US', {
      topic: 'Cómo organizar tus tareas',
      script: 'This complete script explains one concrete action and one reliable workflow.',
      hook: 'Start with one measurable result.',
      titleOptions: ['A reliable workflow'],
      sourcesUsed: [{
        title: 'Cómo El Niño cambia el clima',
        relevanceNote: 'Use this source as supporting context.',
      }],
      hashtags: [],
      caption: '',
      cta: 'Review one result this week.',
      warnings: [],
      qualityWarnings: [],
      expandOptions: [{ label: 'Rewrite hook' }],
      nextActions: [{ label: 'Title pack' }],
      scriptStructure: {
        titleOptions: ['Cómo organizar tus tareas: a proof-first workflow'],
        firstThreeSeconds: 'Start with Cómo organizar tus tareas as the concrete problem.',
        promise: 'Show one reliable workflow.',
        shortSetup: 'Use the authorized topic without rewriting it.',
        beatByBeatScript: ['Explain Cómo organizar tus tareas with one concrete example.'],
        visualDirection: ['Show the source Cómo El Niño cambia el clima on screen.'],
        editNotes: ['Keep the edit concise.'],
        proofSourceNotes: ['Cómo El Niño cambia el clima: Use as supporting context.'],
        cta: 'Review one result this week.',
        riskClaimNotes: ['Review factual claims before publishing.'],
      },
      qualityReport: { warnings: [] },
    }, 'raw-span-test')).toBe('en-US');
  });
});
