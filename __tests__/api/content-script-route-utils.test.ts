// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScriptCreatorProfile,
  buildScriptSuccessResponse,
  buildUserVoiceMemory,
  resolveScriptGenerationMode,
  resolveScriptRenderMode,
  resolveScriptStyle,
  resolveScriptTargetLanguage,
} from '../../src/api/routes/content-script-route-utils';

describe('content script route contract utilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes generation and render modes without trusting arbitrary client values', () => {
    expect(resolveScriptGenerationMode('draft')).toBe('draft');
    expect(resolveScriptGenerationMode('quick')).toBe('quick');
    expect(resolveScriptGenerationMode('standard')).toBe('standard');
    expect(resolveScriptGenerationMode('deep')).toBe('deep');
    expect(resolveScriptGenerationMode('deep ')).toBe('deep');
    expect(resolveScriptGenerationMode('expensive')).toBe('draft');
    expect(resolveScriptGenerationMode(undefined)).toBe('draft');

    expect(resolveScriptRenderMode('chat')).toBe('chat');
    expect(resolveScriptRenderMode(' STRUCTURED ')).toBe('structured');
    expect(resolveScriptRenderMode('cards')).toBe('structured');
    expect(resolveScriptRenderMode(null)).toBe('structured');

    expect(resolveScriptStyle('bullets')).toBe('bullets');
    expect(resolveScriptStyle('outline')).toBe('bullets');
    expect(resolveScriptStyle('Roteiro completo')).toBe('detailed');
    expect(resolveScriptStyle(undefined)).toBe('detailed');
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

  it('builds a scoped Voice DNA memory pack from the user content knowledge rows', () => {
    const memory = buildUserVoiceMemory(42, () => [
      { category: 'content_structure', synthesized_text: 'Use contrast, then a concrete operating rule.' },
      { category: 'brand_voice', synthesized_text: 'Direct, practical, founder-operator tone.' },
      { category: 'irrelevant', synthesized_text: 'Should be ignored.' },
      { category: 'hook_style', synthesized_text: 'Open with a sharp misconception.' },
    ]);

    expect(memory).toContain('[brand_voice] Direct, practical, founder-operator tone.');
    expect(memory).toContain('[hook_style] Open with a sharp misconception.');
    expect(memory).toContain('[content_structure] Use contrast');
    expect(memory).not.toContain('irrelevant');
  });

  it('builds a per-request creator profile without single-tenant identity assumptions', () => {
    const profile = buildScriptCreatorProfile({
      language: 'pt-BR',
      niche: 'fitness',
      voiceMemory: '[brand_voice] Quiet, evidence-led coaching voice.',
    });

    expect(profile).toContain('current authenticated Nexus Hub user only');
    expect(profile).toContain('Primary output language: pt-BR');
    expect(profile).toContain('Requested niche/context: fitness');
    expect(profile).toContain('[brand_voice] Quiet, evidence-led coaching voice.');
    expect(profile).not.toContain('The Operator');
  });

  it('uses a neutral creator profile for cold-start users without Voice DNA', () => {
    const profile = buildScriptCreatorProfile({
      language: 'en-US',
      niche: 'homeschooling',
      voiceMemory: null,
    });

    expect(profile).toContain('No stored Voice DNA exists yet');
    expect(profile).toContain('Do not borrow another creator identity');
    expect(profile).toContain('Requested niche/context: homeschooling');
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
            url: 'https://www.usatriathlon.org/safety/open-water-swimming',
            source_type: 'article',
            relevance_note: 'Used for framing',
          },
        ],
        estimated_duration: '8:00',
        duration_ms: 1200,
      },
      format: 'YouTube',
      renderMode: 'structured',
      scriptStyle: 'detailed',
      generationMode: 'deep',
      startMs: new Date('2026-04-22T10:00:00.000Z').getTime(),
      cacheHit: false,
    });

    expect(response).toMatchObject({
      topic: 'Creator OS',
      script: expect.stringContaining('FIRST 3 SECONDS:'),
      hook: 'Stop treating content as captions.',
      titleOptions: ['A', 'B'],
      sourcesUsed: [{
        title: 'Reference',
        url: 'https://www.usatriathlon.org/safety/open-water-swimming',
        sourceType: 'article',
        relevanceNote: 'Used for framing',
      }],
      estimatedDuration: '8:00',
      format: 'YouTube',
      renderMode: 'structured',
      scriptStyle: 'detailed',
      durationMs: 1200,
      hashtags: [],
      caption: '',
      cta: 'Pick one action from this video and measure the result this week.',
      degraded: false,
      warnings: [],
      scriptQuality: {
        overallScore: expect.any(Number),
        hookScore: expect.any(Number),
        retentionScore: expect.any(Number),
        proofScore: expect.any(Number),
        platformFitScore: expect.any(Number),
        voiceFitScore: expect.any(Number),
        ctaScore: expect.any(Number),
        structureScore: expect.any(Number),
        complianceWarnings: expect.any(Array),
        revisionActions: expect.any(Array),
        blockers: expect.any(Array),
      },
      scriptStructure: {
        firstThreeSeconds: expect.stringContaining('Stop treating content as captions'),
        cta: expect.any(String),
      },
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

  it('attaches draft-first cost, prompt, research, and expansion metadata', () => {
    const response = buildScriptSuccessResponse({
      result: {
        topic: 'Token-smart content',
        script: 'Draft pack body with one concrete hook and one CTA. Save this.',
        hook: 'Most content teams overpay for first drafts.',
        title_options: ['Draft first'],
        sources_used: [],
        duration_ms: 100,
      },
      format: 'YouTube',
      renderMode: 'structured',
      scriptStyle: 'bullets',
      generationMode: 'draft',
      startMs: Date.now() - 100,
      cacheHit: false,
      promptBudget: {
        prompt: 'stable',
        tokenEstimate: 900,
        maxTokens: 1600,
        overBudget: false,
        cacheablePrefixHash: 'prefix-hash',
        sections: [{
          sectionName: 'creator_voice_card',
          text: 'voice',
          required: true,
          cacheable: true,
          source: 'content_knowledge',
          maxChars: 900,
          tokenEstimate: 100,
          truncated: false,
        }],
      },
      estimatedCost: {
        estimatedInputTokens: 900,
        estimatedOutputTokens: 1200,
        estimatedCostUsd: 0.00175,
        costConfidence: 'high',
      },
      researchRoute: {
        route: 'evergreen_cached',
        reason: 'evergreen_or_draft_default',
        allowDeepSearch: false,
      },
      budgetState: 'healthy',
      qualityGate: {
        qualityScore: 88,
        qualityWarnings: ['needs_expansion'],
        needsExpansion: true,
        needsResearchRefresh: false,
      },
    });

    expect(response.generationMode).toBe('draft');
    expect(response.usageImpact).toBe('low');
    expect(response.generation.researchUsed).toBe(false);
    expect(response.contentCost.estimatedBeforeCall.estimatedCostUsd).toBe(0.00175);
    expect(response.promptBudget.cacheablePrefixHash).toBe('prefix-hash');
    expect(response.research).toMatchObject({
      route: 'evergreen_cached',
      allowDeepSearch: false,
      sourceSummary: [],
    });
    expect(response.qualityScore).toBe(88);
    expect(response.qualityWarnings).toContain('Draft needs expansion before publishing.');
    expect(response.expandOptions.map((option) => option.action)).toContain('expand_full');
    expect(response.nextActions.map((option: any) => option.action)).toEqual(expect.arrayContaining([
      'hook_pack',
      'title_pack',
      'caption_pack',
      'thumbnail_pack',
    ]));
    expect(response.operationTrace).toMatchObject({
      operation: 'script_draft',
      costTier: 'low',
      cacheStatus: 'miss',
    });
    // 2026-05-18 phase2-qa P2: previously `reuseStatus` defaulted to
    // 'reused' even when there was no source package and no cache hit —
    // misleading iOS into showing "Reused" for a fresh draft. This fixture
    // has hasReusableSourcePackage=false + cacheHit=false, so the honest
    // value is 'fresh'.
    expect(response.reuseStatus).toBe('fresh');
    expect(response.costTier).toBe('low');
    expect(response.qualityReport).toMatchObject({
      score: 88,
      needsExpansion: true,
      needsResearchRefresh: false,
    });
    expect(response.artifactRefs).toEqual([]);
    expect(response.claimLedger).toEqual(expect.any(Array));
    expect(response.agentSignalsUsed).toEqual(expect.any(Array));
    expect(response.requestedMode).toBe('draft');
    expect(response.appliedMode).toBe('draft');
    expect(response.downgradeReason).toBe('none');
    expect('sourcePackageId' in response.research).toBe(false);
    expect('researchArtifactId' in response.research).toBe(false);
  });

  it('prefers the actual engine prompt budget over the TypeScript estimate for cache metadata', () => {
    const response = buildScriptSuccessResponse({
      result: {
        topic: 'Prompt parity',
        script: 'Draft pack body with enough specific content to pass.',
        prompt_budget: {
          tokenEstimate: 111,
          maxTokens: 1600,
          overBudget: false,
          cacheablePrefixHash: 'python-prefix',
          sections: [{
            sectionName: 'creator_voice_card',
            tokenEstimate: 20,
            required: true,
            cacheable: true,
            source: 'content_knowledge',
            truncated: false,
          }],
        },
      },
      format: 'YouTube',
      renderMode: 'structured',
      scriptStyle: 'bullets',
      requestedMode: 'deep',
      generationMode: 'draft',
      downgradeReason: 'deep_research_disabled',
      startMs: Date.now() - 100,
      cacheHit: false,
      promptBudget: {
        prompt: 'ts-estimate',
        tokenEstimate: 999,
        maxTokens: 3200,
        overBudget: false,
        cacheablePrefixHash: 'ts-prefix',
        sections: [],
      },
    });

    expect(response.promptBudget.cacheablePrefixHash).toBe('python-prefix');
    expect(response.contentCost.providerCache.cacheablePrefixHash).toBe('python-prefix');
    expect(response.promptBudget.sections[0].source).toBe('voice');
    expect(response.requestedMode).toBe('deep');
    expect(response.appliedMode).toBe('draft');
    expect(response.downgradeReason).toBe('deep_research_disabled');
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
      scriptStyle: 'bullets',
      generationMode: 'standard',
      startMs: new Date('2026-04-22T10:00:00.000Z').getTime(),
      cacheHit: true,
    });

    expect(response.sourcesUsed).toEqual([]);
    expect(response.generation.researchUsed).toBe(false);
    expect(response.usageImpact).toBe('none');
    expect(response.hashtags).toEqual([]);
    expect(response.caption).toBe('');
    expect(response.cta).toContain('Save this');
    expect(response.degraded).toBe(true);
    expect(response.warnings).toEqual(['cached fallback']);
    expect(response.scriptQuality.overallScore).toBeGreaterThanOrEqual(90);
  });

  it('attaches script quality to fresh, cached, degraded, and regenerated-style responses', () => {
    const variants = [
      { name: 'fresh', cacheHit: false, generationMode: 'standard' as const, degraded: false },
      { name: 'cached', cacheHit: true, generationMode: 'standard' as const, degraded: false },
      { name: 'degraded', cacheHit: false, generationMode: 'quick' as const, degraded: true },
      { name: 'regenerated', cacheHit: false, generationMode: 'deep' as const, degraded: false },
    ];

    for (const variant of variants) {
      const response = buildScriptSuccessResponse({
        result: {
          topic: `${variant.name} script`,
          script: 'Today we are going to talk about a creator workflow.\nProof appears before the second beat.\nSave this.',
          hook: '',
          cta: '',
          degraded: variant.degraded,
          warnings: variant.degraded ? ['AI generation was unavailable; returned a templated degraded script grounded in the available research.'] : [],
        },
        format: 'Reel',
        renderMode: 'structured',
        scriptStyle: 'detailed',
        generationMode: variant.generationMode,
        startMs: Date.now() - 100,
        cacheHit: variant.cacheHit,
      });

      expect(response.scriptQuality.overallScore, variant.name).toBeGreaterThanOrEqual(90);
      expect(response.scriptQuality.revisionActions, variant.name).toContain('weak_intro_rewritten_to_first_three_seconds_hook');
      expect(response.scriptStructure.firstThreeSeconds, variant.name).not.toMatch(/^Today we are going to talk/i);
      expect(response.generation.cacheHit, variant.name).toBe(variant.cacheHit);
      expect(response.degraded, variant.name).toBe(variant.degraded);
    }
  });
});
