// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 80 (2026-05-16): Spanish locale must reach the planner.
//
// Before Batch 80, `detectLanguageFromTelegram('es')` and
// `normalizeLangHeader('Accept-Language: es-*')` both collapsed to `'pt-BR'`,
// which silently disabled every `input.locale?.startsWith('es')` branch
// added to the chat planner in Phases 10-15 for Telegram-originated and
// HTTP traffic. This file is the regression contract.

import { describe, expect, it } from 'vitest';
import { detectLanguageFromTelegram } from '../../src/utils/i18n';
import { normalizeLangHeader } from '../../src/services/secretary-fastpath';

describe('Spanish locale survives Telegram + HTTP language detection', () => {
  it('detectLanguageFromTelegram preserves es-* as es-ES (not pt-BR)', () => {
    expect(detectLanguageFromTelegram('es')).toBe('es-ES');
    expect(detectLanguageFromTelegram('es-ES')).toBe('es-ES');
    expect(detectLanguageFromTelegram('es-MX')).toBe('es-ES');
    expect(detectLanguageFromTelegram('ES-es')).toBe('es-ES');
  });

  it('detectLanguageFromTelegram still preserves Portuguese and English', () => {
    expect(detectLanguageFromTelegram('pt')).toBe('pt-BR');
    expect(detectLanguageFromTelegram('pt-BR')).toBe('pt-BR');
    expect(detectLanguageFromTelegram('pt-PT')).toBe('pt-PT');
    expect(detectLanguageFromTelegram('pt_PT')).toBe('pt-PT');
    expect(detectLanguageFromTelegram('en')).toBe('en-US');
    expect(detectLanguageFromTelegram('en-GB')).toBe('en-US');
  });

  it('detectLanguageFromTelegram falls back to en-US for unknown codes', () => {
    expect(detectLanguageFromTelegram('fr')).toBe('en-US');
    expect(detectLanguageFromTelegram('de')).toBe('en-US');
    expect(detectLanguageFromTelegram(undefined)).toBe('pt-BR');
  });

  it('normalizeLangHeader preserves Accept-Language: es-* as es-ES', () => {
    expect(normalizeLangHeader('es')).toBe('es-ES');
    expect(normalizeLangHeader('es-ES')).toBe('es-ES');
    expect(normalizeLangHeader('es-419')).toBe('es-ES');
    expect(normalizeLangHeader('ES-MX')).toBe('es-ES');
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
    expect(normalizeLangHeader(['es-ES', 'en-US'])).toBe('es-ES');
    expect(normalizeLangHeader(['pt-BR', 'es-ES'])).toBe('pt-BR');
  });
});
