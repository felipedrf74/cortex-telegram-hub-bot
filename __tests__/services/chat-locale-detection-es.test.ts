// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Product-locale contract: Nexus replies in English, pt-BR, or pt-PT.
// Legacy Spanish locale signals remain accepted for compatibility but must
// resolve to English. They must never re-enable Spanish response copy.

import { describe, expect, it } from 'vitest';
import { detectLanguageFromTelegram, normalizeSupportedLang } from '../../src/utils/i18n';
import { normalizeLangHeader } from '../../src/services/secretary-fastpath';

describe('supported chat locale boundaries', () => {
  it('maps legacy Telegram es-* locale signals to the English fallback', () => {
    expect(detectLanguageFromTelegram('es')).toBe('en-US');
    expect(detectLanguageFromTelegram('es-ES')).toBe('en-US');
    expect(detectLanguageFromTelegram('es-MX')).toBe('en-US');
    expect(detectLanguageFromTelegram('ES-es')).toBe('en-US');
  });

  it('detectLanguageFromTelegram still preserves Portuguese and English', () => {
    expect(detectLanguageFromTelegram('pt')).toBe('pt-BR');
    expect(detectLanguageFromTelegram('pt-BR')).toBe('pt-BR');
    expect(detectLanguageFromTelegram('pt-PT')).toBe('pt-PT');
    expect(detectLanguageFromTelegram('pt_PT')).toBe('pt-PT');
    expect(detectLanguageFromTelegram('en')).toBe('en-US');
    expect(detectLanguageFromTelegram('en-GB')).toBe('en-US');
  });

  it('canonicalizes supported language labels without reviving Spanish output', () => {
    expect(normalizeSupportedLang('European Portuguese', 'en-US')).toBe('pt-PT');
    expect(normalizeSupportedLang('Português de Portugal', 'en-US')).toBe('pt-PT');
    expect(normalizeSupportedLang('Brazilian Portuguese', 'en-US')).toBe('pt-BR');
    expect(normalizeSupportedLang('English', 'pt-BR')).toBe('en-US');
    expect(normalizeSupportedLang('Spanish', 'pt-BR')).toBe('en-US');
    expect(normalizeSupportedLang('Español', 'pt-BR')).toBe('en-US');
  });

  it('does not treat arbitrary words beginning with a locale prefix as language codes', () => {
    expect(normalizeSupportedLang('engineering', 'pt-BR')).toBe('pt-BR');
    expect(normalizeSupportedLang('ptolemy', 'en-US')).toBe('en-US');
  });

  it('detectLanguageFromTelegram falls back to en-US for unknown codes', () => {
    expect(detectLanguageFromTelegram('fr')).toBe('en-US');
    expect(detectLanguageFromTelegram('de')).toBe('en-US');
    expect(detectLanguageFromTelegram(undefined)).toBe('pt-BR');
  });

  it('maps legacy HTTP es-* locale signals to the English fallback', () => {
    expect(normalizeLangHeader('es')).toBe('en-US');
    expect(normalizeLangHeader('es-ES')).toBe('en-US');
    expect(normalizeLangHeader('es-419')).toBe('en-US');
    expect(normalizeLangHeader('ES-MX')).toBe('en-US');
  });

  it('normalizeLangHeader still preserves Portuguese and English', () => {
    expect(normalizeLangHeader('pt-BR')).toBe('pt-BR');
    expect(normalizeLangHeader('pt-PT')).toBe('pt-PT');
    expect(normalizeLangHeader('en-US')).toBe('en-US');
    expect(normalizeLangHeader('en-GB')).toBe('en-US');
  });

  it('normalizeLangHeader falls back to pt-BR for missing or unknown headers', () => {
    expect(normalizeLangHeader(undefined)).toBe('pt-BR');
    expect(normalizeLangHeader('')).toBe('pt-BR');
    expect(normalizeLangHeader('fr-FR')).toBe('pt-BR');
  });

  it('first-array element wins for normalizeLangHeader (multi-value header)', () => {
    expect(normalizeLangHeader(['es-ES', 'en-US'])).toBe('en-US');
    expect(normalizeLangHeader(['pt-BR', 'es-ES'])).toBe('pt-BR');
  });
});
