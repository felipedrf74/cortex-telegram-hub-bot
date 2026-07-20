// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildClaimLedger,
  buildContentAgentSignalDigest,
  buildContentArtifactRefs,
  buildContentNextActions,
  buildContentOperationTrace,
  buildCreatorVoiceCard,
  buildSourcePackage,
  budgetStateFromQuota,
  compileContentOperationPrompt,
  compileContentPrompt,
  estimateContentGenerationCost,
  estimateContentOperationCost,
  lintSourcePackage,
  noveltyCheck,
  qualityGateContent,
  routeContentResearch,
} from '../../src/services/content-token-economy';
import {
  classifyContentClaimRisk,
  extractReviewableContentClaims,
} from '../../src/services/content-claim-safety';

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
    expect(card.updatedAt).not.toBe('1970-01-01T00:00:00.000Z');
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
          url: 'https://www.usatriathlon.org/safety/open-water-swimming',
          source_type: 'article',
          relevance_note: 'x'.repeat(600),
        },
        {
          title: 'A duplicate',
          url: 'https://www.usatriathlon.org/safety/open-water-swimming',
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

  it.each([
    ['hook_pack', 700, 'low'],
    ['title_pack', 750, 'low'],
    ['caption_pack', 950, 'low'],
    ['thumbnail_pack', 850, 'low'],
    ['repurpose', 1900, 'medium'],
    ['competitor_insight', 2600, 'medium'],
    ['seo_insight', 2300, 'medium'],
    ['gap_insight', 2400, 'medium'],
    ['book_source', 4200, 'high'],
  ] as const)('compiles %s with operation-specific budget and stable prefix', (operation, maxTokens, costTier) => {
    const voiceCard = buildCreatorVoiceCard({
      tenantId: 42,
      userId: 7,
      language: 'en-US',
      niche: 'creator ops',
      voiceMemory: '[brand_voice] Short practical sentences.',
    });
    const sourcePackage = buildSourcePackage({
      topic: 'token-smart content',
      language: 'en-US',
      format: 'YouTube',
      mode: 'draft',
      sources: [{ title: 'Source A', relevance_note: 'Reuse source evidence.', source_type: 'article' }],
    });
    const compiled = compileContentOperationPrompt({
      operation,
      topic: 'token-smart content',
      language: 'en-US',
      reusableContext: { voiceCard, sourcePackage },
    });
    const compiledAgain = compileContentOperationPrompt({
      operation,
      topic: 'token-smart content',
      language: 'en-US',
      reusableContext: { voiceCard, sourcePackage },
    });
    const estimate = estimateContentOperationCost({ operation, promptTokens: compiled.tokenEstimate });

    expect(compiled.maxTokens).toBe(maxTokens);
    expect(compiled.cacheablePrefixHash).toBe(compiledAgain.cacheablePrefixHash);
    expect(compiled.prompt).toContain('[source_package]');
    expect(estimate.costTier).toBe(costTier);
  });

  it('builds artifact refs, next actions, operation traces, and compact agent signals', () => {
    const voiceCard = buildCreatorVoiceCard({
      tenantId: 5,
      userId: 9,
      language: 'pt-BR',
      niche: 'content ops',
      voiceMemory: '[hook_style] Open with the constraint.',
    });
    const sourcePackage = buildSourcePackage({
      topic: 'artifact reuse',
      language: 'pt-BR',
      format: 'YouTube',
      mode: 'draft',
      sources: [{ title: 'Reuse memo', relevance_note: 'Artifacts reduce repeated research.', source_type: 'memo' }],
    });
    const prompt = compileContentOperationPrompt({
      operation: 'title_pack',
      topic: 'artifact reuse',
      language: 'pt-BR',
      reusableContext: {
        voiceCard,
        sourcePackage,
        agentDigest: buildContentAgentSignalDigest({
          recentHooks: ['Stop rebuilding the same prompt'],
          recentAngles: ['artifact reuse', 'artifact reuse'],
        }),
      },
    });
    const trace = buildContentOperationTrace({
      operation: 'title_pack',
      prompt,
      userId: 9,
      tenantId: 5,
      cacheStatus: 'miss',
    });
    const refs = buildContentArtifactRefs({ voiceCard, sourcePackage });
    const actions = buildContentNextActions({ mode: 'draft', budgetState: 'healthy', hasSourcePackage: true });

    expect(trace).toMatchObject({ operation: 'title_pack', costTier: 'low', userId: 9, tenantId: 5 });
    expect(refs.map((ref) => ref.type)).toEqual(expect.arrayContaining(['voice_card', 'source_package', 'research_artifact']));
    expect(actions.map((action) => action.action)).toEqual(expect.arrayContaining(['hook_pack', 'title_pack', 'caption_pack', 'thumbnail_pack']));
    expect(prompt.prompt).not.toMatch(/raw agent log|debug/i);
  });

  it('classifies claims and flags repeated hooks or angles without full history prompts', () => {
    const sourcePackage = buildSourcePackage({
      topic: 'proof-first scripts',
      language: 'en-US',
      format: 'YouTube',
      mode: 'draft',
      sources: [{ title: 'Proof memo', relevance_note: 'Creators who reuse artifacts cut repeated research work.', source_type: 'memo' }],
    });
    const ledger = buildClaimLedger({
      text: 'Creators who reuse artifacts cut repeated research work. This always doubles retention.',
      sourcePackage,
    });
    const novelty = noveltyCheck({
      hook: 'Stop rebuilding the same prompt',
      angle: 'Artifact reuse',
      recentHooks: ['Stop rebuilding the same prompt'],
      recentAngles: ['Artifact reuse'],
    });

    expect(ledger.map((entry) => entry.support)).toEqual(expect.arrayContaining(['source_backed', 'unverified']));
    expect(novelty.repeated).toBe(true);
    expect(novelty.warnings).toEqual(expect.arrayContaining(['repeated_hook_detected', 'repeated_angle_detected']));
  });

  it('prioritizes multilingual and obfuscated regulated claims in the bounded server ledger', () => {
    const ordinaryClaims = Array.from({ length: 12 }, (_, index) => (
      `A neutral benchmark ${index} changed by ${index + 1} percent.`
    ));
    const highRiskClaims = [
      'Skip the doctor because this herb reverses high blood sugar in seven days.',
      'Esta inversión duplica tu dinero sin posibilidad de pérdida.',
      'Você não precisa declarar este rendimento; a Receita Federal nunca vai cobrar impostos.',
      'This m3d.i.c.a.ti0n c.u.r.e is 100% safe without a doctor.',
    ];
    const ledger = buildClaimLedger({
      text: [...ordinaryClaims, ...highRiskClaims].join(' '),
    });

    expect(ledger).toHaveLength(12);
    for (const claim of highRiskClaims) {
      expect(ledger).toContainEqual({ claim, support: 'unverified', sourceRef: null });
    }
  });

  it('does not create compact-word false positives for ordinary syntax and secure-content sentences', () => {
    const text = 'A secure U.S.A. content plan explains syntax patterns and class settings without factual promises.';

    expect(classifyContentClaimRisk(text)).toBe('standard');
    expect(buildClaimLedger({ text })).toEqual([]);
  });

  it.each([
    ['This tea makes you lose 10 pounds in seven days.', 'regulated'],
    ['Turn $100 into $10,000 overnight.', 'regulated'],
    ['You can ignore a subpoena and nothing will happen.', 'regulated'],
    ['My doctor enjoys jazz.', 'standard'],
    ['Our financial literacy class meets Tuesday.', 'standard'],
    ['The contract template has blue headings.', 'standard'],
    ['A healthy content workflow saves time.', 'standard'],
    ['The cancer treatment schedule is on Tuesday.', 'standard'],
    ['A tax deduction worksheet template has blue headings.', 'standard'],
    ['The court contract hearing starts Monday.', 'standard'],
    ['I always draft an outline before recording.', 'standard'],
    ['Never leave the B-roll list until filming day.', 'standard'],
    ['My doctor enjoys jazz, and I always start with a hook.', 'standard'],
    ['This product is 100% safe.', 'sensitive'],
    ['This supplement melts belly fat in 7 days.', 'regulated'],
    ['One capsule removes diabetes permanently.', 'regulated'],
    ['Stop insulin after taking this herb.', 'regulated'],
    ['Throw away the court summons; it has no effect.', 'regulated'],
    ['Your crypto investment earns 50% every day.', 'regulated'],
    ['Este té te hace perder 5 kilos en una semana.', 'regulated'],
    ['Puedes ignorar una citación judicial.', 'regulated'],
    ['Este chá faz perder 5 quilos em uma semana.', 'regulated'],
    ['The doctor guarantees the appointment starts Tuesday.', 'standard'],
    ['The lawyer guarantees the contract template has blue headings.', 'standard'],
    ['We guarantee our tax workshop meets Tuesday.', 'standard'],
    ['This treatment guarantees recovery.', 'regulated'],
    ['This supplement guarantees weight loss.', 'regulated'],
    ['This legal service guarantees you will win the lawsuit.', 'regulated'],
    ['This capsule removes diabetes.', 'regulated'],
    ['This crypto returns 50% daily.', 'regulated'],
    ['Guaranteed legal win.', 'regulated'],
    ['This is an investment. Returns double overnight.', 'regulated'],
    ['This 1nvestment will double overnight.', 'regulated'],
    ['This in-vestment will double overnight.', 'regulated'],
    ['Esta inver-sión duplica todo en una noche.', 'regulated'],
  ] as const)('balances safety recall and ordinary-domain precision for %s', (text, expected) => {
    expect(classifyContentClaimRisk(text)).toBe(expected);
  });

  it('extracts ordinary factual statements for warning without treating creative direction as a claim', () => {
    expect(extractReviewableContentClaims([
      'Start with a visual hook and keep the pacing conversational.',
      'Independent research found that 42% of creators revise the hook.',
      'According to the 2025 report, users saved three hours per week.',
    ].join(' '))).toEqual([
      'Independent research found that 42% of creators revise the hook.',
      'According to the 2025 report, users saved three hours per week.',
    ]);
  });

  it('joins referential and claim-bearing continuations across formatting and sentence boundaries', () => {
    expect(extractReviewableContentClaims('This is an investment. It will double overnight.'))
      .toEqual(['This is an investment. It will double overnight.']);
    expect(extractReviewableContentClaims('A court sent a subpoena. You can safely ignore it.'))
      .toEqual(['A court sent a subpoena. You can safely ignore it.']);
    expect(extractReviewableContentClaims('This investment\nwill double it overnight.'))
      .toEqual(['This investment will double it overnight.']);
    expect(extractReviewableContentClaims('This is an investment. Returns double overnight.'))
      .toEqual(['This is an investment. Returns double overnight.']);

    for (const benign of [
      'Our investment workshop is Tuesday. The team will double the chairs.',
      'The doctor arrives Monday. We will lower the camera.',
      'The contract template is ready. Please ignore the blue heading.',
      'The cancer fundraiser is Tuesday. We will raise the stage lights.',
    ]) {
      expect(classifyContentClaimRisk(benign), benign).toBe('standard');
      expect(extractReviewableContentClaims(benign), benign).toEqual([]);
    }
  });

  it('flags near-duplicate hooks even when the similarity bucket changes', () => {
    const novelty = noveltyCheck({
      hook: 'Stop making content no one remembers',
      recentHooks: ['Stop making content nobody remembers'],
    });

    expect(novelty.repeated).toBe(true);
    expect(novelty.warnings).toContain('repeated_hook_detected');
  });
});
