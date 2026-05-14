// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildScriptShortcutMetadata,
  buildScriptShortcutText,
  buildScriptUnavailableResponse,
  getUserBrandVoiceForChatScript,
  localizeScriptWarning,
} from '../../src/api/routes/chat-script-shortcut-response';
import type { ScriptResponse } from '../../src/services/content-engine';

function scriptResult(overrides: Partial<ScriptResponse> = {}): ScriptResponse {
  return {
    topic: 'Recovery habits',
    script: 'HOOK:\nPlan recovery before you chase intensity.\n\nCTA:\nSave this.',
    hook: 'Plan recovery first.',
    title_options: ['Recovery wins'],
    sources_used: [{
      title: 'Reference',
      url: 'https://example.com',
      source_type: 'article',
      relevance_note: 'Grounding',
    }],
    estimated_duration: '0:45',
    duration_ms: 900,
    hashtags: ['#recovery'],
    caption: 'Caption',
    cta: 'Save this.',
    degraded: false,
    warnings: [],
    ...overrides,
  };
}

describe('chat script shortcut response helpers', () => {
  it('reads brand voice defensively without letting content-reference failures break chat', () => {
    expect(getUserBrandVoiceForChatScript(12, () => ({ synthesized_text: 'Direct, practical, warm.' }))).toBe('Direct, practical, warm.');
    expect(getUserBrandVoiceForChatScript(12, () => ({ synthesized_text: '' }))).toBeNull();
    expect(getUserBrandVoiceForChatScript(12, () => {
      throw new Error('content references unavailable');
    })).toBeNull();
  });

  it('localizes known degraded script warnings in Portuguese while preserving unknown English warnings', () => {
    expect(localizeScriptWarning('content engine unavailable', 'pt-BR')).toBe('O motor de conteúdo está temporariamente indisponível.');
    expect(localizeScriptWarning(
      'AI generation was unavailable; returned a templated degraded script grounded in the available research.',
      'pt-PT',
    )).toContain('versão conservadora');
    expect(localizeScriptWarning('custom warning', 'en-US')).toBe('custom warning');
  });

  it('builds a localized chat-ready script and promotes sanitized CTA text as the closing suggestion', () => {
    const text = buildScriptShortcutText(scriptResult(), 'pt-BR', 'Reel');

    expect(text).toContain('Roteiro curto • Duração estimada: 0:45');
    expect(text).toContain('Plan recovery before you chase intensity.');
    expect(text).toContain('FIRST 3 SECONDS:');
    expect(text).toContain('VISUAL DIRECTION:');
    expect(text).not.toContain('CTA:');
  });

  it('surfaces degraded warnings once in the requested language', () => {
    const text = buildScriptShortcutText(scriptResult({
      degraded: true,
      warnings: [
        'content engine unavailable',
        'content engine unavailable',
      ],
      script: '',
      cta: 'Follow for more.',
    }), 'en-US', 'YouTube');

    expect(text).toContain('Note: this script was generated in degraded mode.');
    expect(text).toContain('Reasons: content engine unavailable');
    expect(text.match(/content engine unavailable/g)).toHaveLength(1);
    expect(text).toContain('Script • Estimated duration: 0:45');
    expect(text).toContain('Plan recovery first.');
    expect(text).toContain('Suggested closing line: Follow for more.');
  });

  it('builds unavailable responses in supported chat languages', () => {
    expect(buildScriptUnavailableResponse('en-US')).toContain('could not generate');
    expect(buildScriptUnavailableResponse('pt-PT')).toContain('Tenta novamente');
    expect(buildScriptUnavailableResponse('pt-BR')).toContain('Tenta de novo');
  });

  it('builds defensive metadata for iOS without trusting malformed source arrays', () => {
    const metadata = buildScriptShortcutMetadata(scriptResult({
      sources_used: null,
      title_options: undefined,
      hashtags: undefined,
      caption: undefined,
      cta: undefined,
      degraded: undefined,
      warnings: undefined,
    }), 'Reel');

    expect(metadata).toMatchObject({
      type: 'content_script',
      topic: 'Recovery habits',
      format: 'Reel',
      titleOptions: [],
      hashtags: [],
      caption: '',
      cta: '',
      degraded: false,
      warnings: [],
      scriptQuality: {
        overallScore: expect.any(Number),
        revisionActions: expect.any(Array),
        complianceWarnings: expect.any(Array),
      },
      sourcesUsed: [],
    });
  });
});
