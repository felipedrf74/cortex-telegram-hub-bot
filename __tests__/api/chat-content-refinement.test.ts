// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildContentRefinementSystemPrompt,
  buildContentRefinementUnavailableResponse,
  buildContentRefinementUserPrompt,
  buildHeuristicContentRefinementFallback,
  extractContentRefinementSourceText,
  isContentRefinementFollowUp,
  isRetryableAIProviderError,
  sanitizeScriptBody,
} from '../../src/api/routes/chat-content-refinement';

describe('chat content refinement helpers', () => {
  it('classifies retryable AI provider failures without treating all errors as retryable', () => {
    expect(isRetryableAIProviderError({ retryable: true })).toBe(true);
    expect(isRetryableAIProviderError({ status: 429 })).toBe(true);
    expect(isRetryableAIProviderError({ status: 503 })).toBe(true);
    expect(isRetryableAIProviderError({ status: 400 })).toBe(false);
    expect(isRetryableAIProviderError(null)).toBe(false);
  });

  it('detects content refinement follow-ups in English and Portuguese', () => {
    expect(isContentRefinementFollowUp('make it shorter')).toBe(true);
    expect(isContentRefinementFollowUp('reescreve numa versão mais curta')).toBe(true);
    expect(isContentRefinementFollowUp('what should I publish next?')).toBe(false);
  });

  it('extracts the editable script body from prior assistant responses', () => {
    const source = [
      'Roteiro curto • Reel',
      '',
      'HOOK:',
      'Most athletes waste recovery because they do not plan it.',
      '[SFX: hit]',
      '',
      'Títulos possíveis:',
      'Recovery mistake',
    ].join('\n');

    expect(extractContentRefinementSourceText(source)).toBe('Most athletes waste recovery because they do not plan it.');
  });

  it('builds language-aware prompt text for refinement requests', () => {
    expect(buildContentRefinementSystemPrompt('pt-PT')).toContain('português europeu');
    expect(buildContentRefinementSystemPrompt('en-US')).toContain('Reply in English');

    const prompt = buildContentRefinementUserPrompt('Draft body', 'Trim this', 'en-US');
    expect(prompt).toContain('User instruction:');
    expect(prompt).toContain('Trim this');
    expect(prompt).toContain('Current draft:');
    expect(prompt).toContain('Draft body');
  });

  it('provides localized unavailable and heuristic fallback responses', () => {
    expect(buildContentRefinementUnavailableResponse('pt-BR')).toContain('revisar');
    expect(buildContentRefinementUnavailableResponse('pt-PT')).toContain('rever');
    expect(buildContentRefinementUnavailableResponse('en-US')).toContain('could not revise');

    expect(buildHeuristicContentRefinementFallback('One. Two. Three.', 'make it shorter', 'en-US')).toContain('conservative shorter version');
    expect(buildHeuristicContentRefinementFallback('Um. Dois. Três.', 'encurta', 'pt-PT')).toContain('versão mais curta');
    expect(buildHeuristicContentRefinementFallback('One. Two. Three.', 'translate to English', 'en-US')).toBeNull();
  });

  it('sanitizes generated script bodies before chat delivery', () => {
    const script = [
      'HOOK:',
      'Say this  now [SHOW ON SCREEN: chart]',
      '',
      'CTA:',
      'Buy today',
      '',
      'Caption:',
      'Post caption',
    ].join('\n');

    expect(sanitizeScriptBody(script)).toBe('Say this now');
  });
});
