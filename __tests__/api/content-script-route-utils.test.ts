// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScriptSuccessResponse,
  resolveScriptGenerationMode,
  resolveScriptRenderMode,
  resolveScriptTargetLanguage,
} from '../../src/api/routes/content-script-route-utils';

describe('content script route contract utilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes generation and render modes without trusting arbitrary client values', () => {
    expect(resolveScriptGenerationMode('quick')).toBe('quick');
    expect(resolveScriptGenerationMode('standard')).toBe('standard');
    expect(resolveScriptGenerationMode('deep')).toBe('deep');
    expect(resolveScriptGenerationMode('deep ')).toBe('standard');
    expect(resolveScriptGenerationMode('expensive')).toBe('standard');
    expect(resolveScriptGenerationMode(undefined)).toBe('standard');

    expect(resolveScriptRenderMode('chat')).toBe('chat');
    expect(resolveScriptRenderMode(' STRUCTURED ')).toBe('structured');
    expect(resolveScriptRenderMode('cards')).toBe('structured');
    expect(resolveScriptRenderMode(null)).toBe('structured');
  });

  it('prefers explicit language and safely falls back to the user preference', () => {
    expect(resolveScriptTargetLanguage('pt-PT', 12, () => 'en')).toBe('pt-PT');
    expect(resolveScriptTargetLanguage('  pt-BR  ', 12, () => 'en')).toBe('pt-BR');
    expect(resolveScriptTargetLanguage(undefined, 12, () => 'en')).toBe('en');
    expect(resolveScriptTargetLanguage(undefined, 12, () => null)).toBe('pt-BR');
    expect(resolveScriptTargetLanguage(undefined, 12, () => {
      throw new Error('user preferences unavailable');
    })).toBe('pt-BR');
  });

  it('builds the script response contract with defensive source normalization', () => {
    vi.setSystemTime(new Date('2026-04-22T10:00:03.000Z'));
    const response = buildScriptSuccessResponse({
      result: {
        topic: 'Creator OS',
        script: 'Open with the constraint.',
        hook: 'Stop treating content as captions.',
        title_options: ['A', 'B'],
        sources_used: [
          {
            title: 'Reference',
            url: 'https://example.com',
            source_type: 'article',
            relevance_note: 'Used for framing',
          },
        ],
        estimated_duration: '8:00',
        duration_ms: 1200,
      },
      format: 'YouTube',
      renderMode: 'structured',
      generationMode: 'deep',
      startMs: new Date('2026-04-22T10:00:00.000Z').getTime(),
      cacheHit: false,
    });

    expect(response).toMatchObject({
      topic: 'Creator OS',
      script: 'Open with the constraint.',
      hook: 'Stop treating content as captions.',
      titleOptions: ['A', 'B'],
      sourcesUsed: [{
        title: 'Reference',
        url: 'https://example.com',
        sourceType: 'article',
        relevanceNote: 'Used for framing',
      }],
      estimatedDuration: '8:00',
      format: 'YouTube',
      renderMode: 'structured',
      durationMs: 1200,
      hashtags: [],
      caption: '',
      cta: '',
      degraded: false,
      warnings: [],
      generation: {
        mode: 'deep',
        cacheHit: false,
        provider: 'content-engine',
        durationMs: 3000,
        researchUsed: true,
      },
      generationMode: 'deep',
      cacheHit: false,
      usageImpact: 'high',
    });
  });

  it('keeps cache-hit responses cheap and tolerates missing optional engine fields', () => {
    vi.setSystemTime(new Date('2026-04-22T10:00:01.000Z'));
    const response = buildScriptSuccessResponse({
      result: {
        topic: 'Fast topic',
        script: 'Cached script',
        sources_used: null,
        degraded: true,
        warnings: ['cached fallback'],
      },
      format: 'Reel',
      renderMode: 'chat',
      generationMode: 'standard',
      startMs: new Date('2026-04-22T10:00:00.000Z').getTime(),
      cacheHit: true,
    });

    expect(response.sourcesUsed).toEqual([]);
    expect(response.generation.researchUsed).toBe(false);
    expect(response.usageImpact).toBe('none');
    expect(response.hashtags).toEqual([]);
    expect(response.caption).toBe('');
    expect(response.cta).toBe('');
    expect(response.degraded).toBe(true);
    expect(response.warnings).toEqual(['cached fallback']);
  });
});
