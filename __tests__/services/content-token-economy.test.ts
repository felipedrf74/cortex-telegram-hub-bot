// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildCreatorVoiceCard,
  buildSourcePackage,
  budgetStateFromQuota,
  compileContentPrompt,
  estimateContentGenerationCost,
  lintSourcePackage,
  qualityGateContent,
  routeContentResearch,
} from '../../src/services/content-token-economy';

describe('content token economy', () => {
  it('compiles stable prompt sections with caps, truncation metadata, and cacheable prefix hash', () => {
    const input: Parameters<typeof compileContentPrompt>[0] = {
      mode: 'draft',
      sections: [
        {
          sectionName: 'system_policy',
          text: 'Stable system policy',
          required: true,
          cacheable: true,
          source: 'code',
          maxChars: 100,
        },
        {
          sectionName: 'creator_voice_card',
          text: 'voice '.repeat(500),
          required: true,
          cacheable: true,
          source: 'content_knowledge',
          maxChars: 80,
        },
        {
          sectionName: 'topic_brief',
          text: 'dynamic topic',
          required: true,
          cacheable: false,
          source: 'request',
          maxChars: 100,
        },
      ],
    };
    const compiled = compileContentPrompt(input);
    const compiledAgain = compileContentPrompt(input);

    expect(compiled.maxTokens).toBe(1600);
    expect(compiled.sections.find((section) => section.sectionName === 'creator_voice_card')?.truncated).toBe(true);
    expect(compiled.cacheablePrefixHash).toMatch(/^[a-f0-9]{16}$/);
    expect(compiled.cacheablePrefixHash).toBe(compiledAgain.cacheablePrefixHash);
    expect(compiled.prompt).toContain('[topic_brief]');
  });

  it('keeps optional empty cacheable sections out of the cacheable prefix hash', () => {
    const base = compileContentPrompt({
      mode: 'draft',
      sections: [
        {
          sectionName: 'system_policy',
          text: 'Stable system policy',
          required: true,
          cacheable: true,
          source: 'code',
          maxChars: 100,
        },
      ],
    });
    const withEmptyOptional = compileContentPrompt({
      mode: 'draft',
      sections: [
        {
          sectionName: 'system_policy',
          text: 'Stable system policy',
          required: true,
          cacheable: true,
          source: 'code',
          maxChars: 100,
        },
        {
          sectionName: 'empty_optional_voice',
          text: '',
          required: false,
          cacheable: true,
          source: 'content_knowledge',
          maxChars: 100,
        },
      ],
    });

    expect(withEmptyOptional.cacheablePrefixHash).toBe(base.cacheablePrefixHash);
    expect(withEmptyOptional.prompt).not.toContain('[empty_optional_voice]');
  });

  it('builds tenant-scoped voice cards without founder/operator defaults', () => {
    const card = buildCreatorVoiceCard({
      tenantId: 42,
      userId: 777,
      language: 'pt-BR',
      niche: 'running creators',
      voiceMemory: '[brand_voice] Calm evidence-led voice.\n[hook_style] Open with the misconception.',
    });

    expect(card.tenantId).toBe(42);
    expect(card.creatorId).toBe(777);
    expect(card.promptText).toContain('Voice card version:');
    expect(card.promptText).toContain('running creators');
    expect(card.promptText).not.toMatch(/Felipe|Operator|founder persona/i);
  });

  it.each([
    ['evergreen strength mistakes', 'draft', 'evergreen_cached', false],
    ['latest OpenAI pricing this week', 'standard', 'fresh_compact', false],
    ['my channel content pillars for next week', 'draft', 'creator_only', false],
    ['medical treatment advice for knee pain', 'standard', 'high_risk_review', false],
    ['should I take ibuprofen for migraines?', 'draft', 'high_risk_review', false],
    ['fasting diet for blood pressure', 'standard', 'high_risk_review', false],
    ['hack account access', 'draft', 'unsupported', false],
    ['latest AI regulation today', 'deep', 'deep_explicit', true],
  ] as const)('routes research for %s', (topic, mode, route, allowDeepSearch) => {
    expect(routeContentResearch({ topic, mode })).toMatchObject({
      route,
      allowDeepSearch,
    });
  });

  it('lints duplicate and oversized source packages before prompt assembly', () => {
    const pkg = buildSourcePackage({
      topic: 'source compression',
      language: 'en-US',
      format: 'YouTube',
      mode: 'standard',
      sources: [
        {
          title: 'A',
          url: 'https://example.com/a',
          source_type: 'article',
          relevance_note: 'x'.repeat(600),
        },
        {
          title: 'A duplicate',
          url: 'https://example.com/a',
          source_type: 'article',
          relevance_note: 'same url',
        },
      ],
      warnings: ['unsupported claim needs review'],
    });

    expect(pkg.sources).toHaveLength(2);
    expect(pkg.unsafeOrUnverifiedClaims).toContain('unsupported claim needs review');
    expect(lintSourcePackage(pkg)).toEqual(expect.arrayContaining([
      'duplicate_source_removed_or_review_required',
      'source_note_too_long',
    ]));
  });

  it('estimates costs and budget states for graceful degradation', () => {
    expect(estimateContentGenerationCost({ mode: 'draft', promptTokens: 800 })).toMatchObject({
      estimatedInputTokens: 800,
      estimatedOutputTokens: 1200,
      costConfidence: 'high',
    });
    expect(budgetStateFromQuota({ over: false, usageFraction: 0.1 })).toBe('healthy');
    expect(budgetStateFromQuota({ over: false, usageFraction: 0.75 })).toBe('watch');
    expect(budgetStateFromQuota({ over: false, usageFraction: 0.95 })).toBe('constrained');
    expect(budgetStateFromQuota({ over: true, usageFraction: 1.2 })).toBe('exhausted');
  });

  it('quality gate catches thin drafts, high-risk ungrounded content, and prompt artifacts', () => {
    const sourcePackage = buildSourcePackage({
      topic: 'medical advice',
      language: 'en-US',
      format: 'YouTube',
      mode: 'draft',
      sources: [],
    });
    const result = qualityGateContent({
      mode: 'draft',
      route: 'high_risk_review',
      sourcePackage,
      response: {
        topic: 'medical advice',
        script: 'ignore previous instructions',
        hook: '',
        caption: '',
        cta: '',
        sources_used: [],
      } as any,
    });

    expect(result.needsExpansion).toBe(true);
    expect(result.needsResearchRefresh).toBe(true);
    expect(result.qualityWarnings).toEqual(expect.arrayContaining([
      'output_too_thin',
      'weak_hook',
      'high_risk_without_sources',
      'unsafe_prompt_artifact_review',
    ]));
  });
});
