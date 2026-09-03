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
import { assertContentScriptPublicOutputLanguage } from '../../src/services/content-output-language';

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
    expect(resolveScriptTargetLanguage(undefined, 12, () => 'en')).toBe('en-US');
    expect(resolveScriptTargetLanguage('es-ES', 12, () => 'pt-BR')).toBe('en-US');
    expect(resolveScriptTargetLanguage(undefined, 12, () => 'es-419')).toBe('en-US');
    expect(resolveScriptTargetLanguage('de-DE', 12, () => 'pt-BR')).toBe('en-US');
    expect(resolveScriptTargetLanguage(undefined, 12, () => null)).toBe('en-US');
    expect(resolveScriptTargetLanguage(undefined, 12, () => {
      throw new Error('user preferences unavailable');
    })).toBe('en-US');
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

  it('does not infer a Portuguese variant when creator-profile language is missing', () => {
    const profile = buildScriptCreatorProfile({
      language: '',
      niche: 'general',
      voiceMemory: null,
    });

    expect(profile).toContain('Primary output language: en-US');
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
        agent_signals_used: [
          { type: 'hook_effectiveness', source: 'reaction-radar-agent' },
          { type: 'invalid signal type', source: 'untrusted source' },
        ],
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
      script: 'Open with the constraint.',
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
        suggestedActions: expect.any(Array),
        appliedChanges: [],
        blockers: expect.any(Array),
      },
      scriptSafety: {
        blocked: false,
        blockers: [],
      },
      scriptStructure: {
        firstThreeSeconds: expect.stringContaining('Stop treating content as captions'),
        cta: expect.any(String),
      },
      generation: {
        mode: 'deep',
        cacheHit: false,
        provider: 'content-engine',
        providerSemantics: 'service_boundary',
        durationMs: 3000,
        researchUsed: true,
      },
      generationMode: 'deep',
      cacheHit: false,
      usageImpact: 'high',
      agentSignalsUsed: [{ type: 'hook_effectiveness', source: 'reaction-radar-agent' }],
    });
  });

  it('publishes only the TypeScript-owned stored Voice Card version', () => {
    const base = {
      format: 'Reel' as const,
      renderMode: 'structured' as const,
      scriptStyle: 'detailed' as const,
      generationMode: 'draft' as const,
      startMs: Date.now() - 50,
      cacheHit: false,
    };
    const result = {
      topic: 'Creator workflow',
      script: 'Open with one concrete constraint, show the evidence, and end with one measurable action.',
      voice_card_version: 'python-unverified-hash',
    };
    const creatorVoiceCard = {
      creatorId: 7,
      tenantId: 70,
      voiceCardVersion: 'voice-stored-v1',
      tone: 'user_scoped',
      pacing: 'direct',
      phrasesToUse: [],
      phrasesToAvoid: [],
      contentPillars: [],
      audience: 'general',
      formatPreferences: [],
      ctaStyle: 'single clear next action',
      examplesCompressed: 'Direct examples.',
      sourceHash: 'source-hash',
      updatedAt: '2026-08-31T00:00:00.000Z',
      promptText: 'Stored voice guidance.',
    };

    expect(buildScriptSuccessResponse({ ...base, result, creatorVoiceCard }).voiceCardVersion)
      .toBe('voice-stored-v1');
    expect(buildScriptSuccessResponse({ ...base, result }).voiceCardVersion).toBeNull();
  });

  it('treats authenticated source metadata as an input echo for durable jobs only', () => {
    const result = {
      topic: 'Creator workflow',
      script: 'Start with one concrete constraint. Show the evidence, then finish with one useful action.',
      hook: 'Build the argument from evidence.',
      title_options: ['An evidence-led workflow'],
      sources_used: [{
        title: 'Fonte externa em português',
        url: 'https://example.test/source',
        source_type: 'user_supplied',
        relevance_note: 'Esta fonte explica o contexto e preserva a descrição original do utilizador.',
      }],
    };
    const build = (sourceMetadataIsRequestEcho?: boolean) => buildScriptSuccessResponse({
      result,
      language: 'en-US',
      sourceMetadataIsRequestEcho,
      format: 'YouTube',
      renderMode: 'structured',
      scriptStyle: 'detailed',
      generationMode: 'standard',
      startMs: Date.now() - 10,
      cacheHit: false,
    });

    expect(() => build()).toThrow(expect.objectContaining({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
    }));
    expect(build(true).sourcesUsed).toContainEqual(expect.objectContaining({
      title: 'Fonte externa em português',
      relevanceNote: 'Esta fonte explica o contexto e preserva a descrição original do utilizador.',
    }));
  });

  it('preserves every engine-generated script character beyond the bounded quality structure', () => {
    const longScript = [
      ...Array.from({ length: 24 }, (_, index) => `Section ${index + 1}: detailed user-owned script body.`),
      'TAIL_SENTINEL_MUST_SURVIVE_7A6F',
    ].join('\n');

    const response = buildScriptSuccessResponse({
      result: {
        topic: 'Lossless script integrity',
        script: longScript,
        hook: 'Keep the whole generated document.',
        title_options: ['Lossless generation'],
        sources_used: [],
      },
      format: 'YouTube',
      renderMode: 'structured',
      scriptStyle: 'detailed',
      generationMode: 'standard',
      startMs: Date.now() - 10,
      cacheHit: false,
    });

    expect(response.script).toBe(longScript);
    expect(response.script).toContain('TAIL_SENTINEL_MUST_SURVIVE_7A6F');
    expect(response.scriptStructure.beatByBeatScript.length).toBeLessThan(24);
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

  it('does not present an in-memory research package as a stored or reused artifact', () => {
    const sourcePackage = {
      sourcePackageId: 'sp_generated',
      researchArtifactId: 'ra_generated',
      topicHash: 'topic-hash',
      freshnessClass: 'fresh' as const,
      language: 'en-US',
      format: 'YouTube',
      sources: [{
        title: 'Primary reference',
        url: 'https://www.w3.org/TR/WCAG22/',
        source_type: 'article',
        relevance_note: 'Grounds the workflow example.',
      }],
      sourceSummaries: ['Primary reference — Grounds the workflow example.'],
      claims: ['The workflow follows the cited reference.'],
      unsafeOrUnverifiedClaims: [],
      expiresAt: '2026-04-23T10:00:00.000Z',
      tokenEstimate: 20,
    };
    const build = (publicSourcePackageIds?: {
      sourcePackageId: string;
      researchArtifactId: string;
    }) => buildScriptSuccessResponse({
      result: {
        topic: 'Research persistence truth',
        script: 'Use the cited reference to verify the workflow before publishing.',
        hook: 'A source package is useful only when its storage state is honest.',
        title_options: ['Research persistence truth'],
        sources_used: sourcePackage.sources,
      },
      format: 'YouTube',
      renderMode: 'structured',
      scriptStyle: 'detailed',
      generationMode: 'standard',
      startMs: Date.now() - 10,
      cacheHit: false,
      sourcePackage,
      publicSourcePackageIds,
    });

    const generatedOnly = build();
    expect(generatedOnly.reuseStatus).toBe('fresh');
    expect(generatedOnly.artifactRefs.map((ref) => ref.type)).not.toContain('source_package');
    expect(generatedOnly.artifactRefs.map((ref) => ref.type)).not.toContain('research_artifact');
    expect(generatedOnly.research).not.toHaveProperty('sourcePackageId');
    expect(generatedOnly.research).not.toHaveProperty('researchArtifactId');

    const stored = build({ sourcePackageId: 'sp_stored', researchArtifactId: 'ra_stored' });
    expect(stored.reuseStatus).toBe('reused');
    expect(stored.research).toMatchObject({
      sourcePackageId: 'sp_stored',
      researchArtifactId: 'ra_stored',
    });
    expect(stored.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'source_package', id: 'sp_stored', source: 'stored' }),
      expect.objectContaining({ type: 'research_artifact', id: 'ra_stored', source: 'stored' }),
    ]));
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

  it('keeps every deterministic public response field in Portuguese', () => {
    const response = buildScriptSuccessResponse({
      result: {
        topic: 'Rotina de conteúdo',
        script: 'Comece pelo resultado concreto.\nMostre uma fonte e um exemplo.\nTermine com uma ação simples.',
        hook: '',
        title_options: ['Uma rotina de conteúdo fiável'],
        sources_used: [],
        warnings: [
          'compact_research_used',
          'script_metadata_recovered',
          'provider_fallback_voice_dna_not_applied',
          'provider_fallback_research_claims_withheld',
        ],
      },
      language: 'pt-BR',
      format: 'Reel',
      renderMode: 'structured',
      scriptStyle: 'detailed',
      generationMode: 'draft',
      startMs: Date.now() - 100,
      cacheHit: false,
      qualityGate: {
        qualityScore: 88,
        qualityWarnings: ['needs_expansion'],
        needsExpansion: true,
        needsResearchRefresh: false,
      },
    });

    expect(response.cta).not.toMatch(/\b(?:save|pick)\b/i);
    expect(response.expandOptions.map((option) => option.label).join(' ')).not.toMatch(
      /\b(?:expand|rewrite|title|caption|refresh|thumbnail)\b/i,
    );
    expect(response.nextActions.map((option: any) => option.label).join(' ')).not.toMatch(
      /\b(?:expand|hook|title|caption|refresh|thumbnail)\b/i,
    );
    expect(response.nextActions.map((option: any) => option.label).join(' ')).toContain('roteiro');
    expect(response.nextActions.map((option: any) => option.label).join(' ')).not.toContain('guião');
    expect(response.warnings.join(' ')).not.toMatch(
      /\b(?:compact research|script metadata|fallback output|review its tone|fallback research claims)\b/i,
    );
    expect(response.warnings).toContain(
      'As alegações da pesquisa alternativa foram ocultadas; revise as fontes antes de usar o roteiro.',
    );
    expect(JSON.stringify(response.scriptStructure)).not.toContain('First frame');
    expect(response.qualityWarnings.join(' ')).not.toContain('Draft needs expansion');
    expect(assertContentScriptPublicOutputLanguage(
      'pt-BR',
      response,
      'content-script-public-test',
    )).toBe('pt-BR');
  });
});
