// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ContentAgencyRuleCategory =
  | 'youtube_discovery_analytics'
  | 'tiktok_native_creative'
  | 'instagram_meta_ranking'
  | 'google_search_helpful_content'
  | 'human_behavior_story'
  | 'brand_positioning'
  | 'scripting_storytelling'
  | 'editing_production'
  | 'creator_economy_agency'
  | 'compliance_policy'
  | 'agent_eval_architecture';

export interface ContentAgencyRule {
  id: string;
  category: ContentAgencyRuleCategory;
  sourceAnchors: string[];
  principle: string;
  productBehavior: string;
  qualityGateImpact: string;
  blockedFailureModes: string[];
  exampleUserFacingEffect: string;
}

export const CONTENT_AGENCY_RULE_CATEGORIES: ContentAgencyRuleCategory[] = [
  'youtube_discovery_analytics',
  'tiktok_native_creative',
  'instagram_meta_ranking',
  'google_search_helpful_content',
  'human_behavior_story',
  'brand_positioning',
  'scripting_storytelling',
  'editing_production',
  'creator_economy_agency',
  'compliance_policy',
  'agent_eval_architecture',
];

export const CONTENT_AGENCY_RULES: ContentAgencyRule[] = [
  {
    id: 'youtube-viewer-matching-retention-loop',
    category: 'youtube_discovery_analytics',
    sourceAnchors: [
      'YouTube Search & Discovery tips',
      'YouTube Analytics overview',
      'YouTube audience retention / key moments',
      'YouTube engagement analytics',
      'YouTube Trends and Inspiration tabs',
      'YouTube Data API and Analytics API metrics',
    ],
    principle: 'YouTube discovery is a viewer-matching and performance-feedback system, not a universal algorithm hack.',
    productBehavior: 'YouTube outputs diagnose audience expectation, title/thumbnail fit, intro retention, dips, spikes, top moments, traffic source, and returning/new viewer fit.',
    qualityGateImpact: 'Rejects generic algorithm advice and requires measurable packaging, retention, and engagement hypotheses.',
    blockedFailureModes: ['generic_algorithm_hack', 'unsupported_ranking_claim', 'fake_analytics', 'missing_retention_diagnosis'],
    exampleUserFacingEffect: 'Nexus says whether the problem is packaging, the first 30 seconds, payoff timing, or audience fit.',
  },
  {
    id: 'tiktok-first-structure-stimulation-sound',
    category: 'tiktok_native_creative',
    sourceAnchors: [
      'TikTok Creative Center',
      'TikTok Top Ads',
      'TikTok Creative Codes',
      'TikTok For You recommendations',
      'TikTok split testing and measurement docs',
      'TikTok Research API',
    ],
    principle: 'TikTok creative must feel native to the feed: trend-aware, structured, visually stimulating, sound-aware, and fast to reward attention.',
    productBehavior: 'TikTok outputs include first-frame action, sound direction, caption rhythm, pattern interrupts, native proof, and a testable creative variable.',
    qualityGateImpact: 'Blocks repurposed long-form scripts that lack TikTok-native pacing, structure, or sensory hooks.',
    blockedFailureModes: ['platform_mismatch', 'slow_open', 'missing_sound_direction', 'weak_split_test_hypothesis'],
    exampleUserFacingEffect: 'Nexus gives one clear TikTok test, such as hook mechanism A vs proof-first hook B.',
  },
  {
    id: 'instagram-surface-specific-ranking',
    category: 'instagram_meta_ranking',
    sourceAnchors: [
      'Instagram algorithms and ranking for creators',
      'Instagram ranking explained',
      'Instagram search explained',
      'Instagram Insights',
      'Instagram Explore recommendations',
      'Meta Transparency Center Feed and Explore ranking',
      'Meta A/B testing',
    ],
    principle: 'Instagram is not one algorithm: Feed, Explore, Search, Reels, and recommendations reward different user intents and signals.',
    productBehavior: 'Instagram outputs name the target surface and optimize for saves, shares, sends, comments, search language, or follow conversion as appropriate.',
    qualityGateImpact: 'Rejects one-size-fits-all Instagram advice and requires surface-specific success metrics.',
    blockedFailureModes: ['single_algorithm_claim', 'wrong_surface_metric', 'vague_instagram_strategy'],
    exampleUserFacingEffect: 'A carousel gets save/share logic, while a Reel gets first-frame and replay logic.',
  },
  {
    id: 'people-first-search-content',
    category: 'google_search_helpful_content',
    sourceAnchors: [
      'Google helpful, reliable, people-first content',
      'Google SEO Starter Guide',
      'Google video SEO best practices',
      'Google image SEO best practices',
      'Google guidance on AI-generated content',
      'Google Trends',
      'Google Search Console',
    ],
    principle: 'Search content should satisfy a real audience need with reliable, useful, people-first information rather than existing only to manipulate ranking.',
    productBehavior: 'SEO/blog/newsletter outputs include search intent, useful answer depth, evidence, originality, and trend context without keyword stuffing.',
    qualityGateImpact: 'Flags thin SEO output, unsupported expertise claims, and content that lacks a human-useful payoff.',
    blockedFailureModes: ['thin_seo_content', 'keyword_stuffing', 'unsupported_expertise_claim', 'search_intent_missing'],
    exampleUserFacingEffect: 'Nexus explains the search intent and what proof or example will make the piece genuinely useful.',
  },
  {
    id: 'arousal-story-retention',
    category: 'human_behavior_story',
    sourceAnchors: [
      'Berger & Milkman — What Makes Online Content Viral',
      'Berger — Arousal Increases Social Transmission',
      'Guo, Kim & Rubin — How Video Production Affects Student Engagement',
      'Narrative transportation research',
      'Short-form video algorithms and attention economy reviews',
      'TikTok personalization studies',
    ],
    principle: 'Sharing, attention, and memory are shaped by emotion, arousal, pacing, production clarity, and transportation into a story.',
    productBehavior: 'Outputs label the emotional driver, stakes, story arc, pacing choice, and retention device instead of only producing captions.',
    qualityGateImpact: 'Scores hooks and scripts for tension, arousal, payoff timing, narrative clarity, and memory value.',
    blockedFailureModes: ['flat_emotional_arc', 'no_story_stakes', 'low_retention_structure', 'meaningless_hook'],
    exampleUserFacingEffect: 'Nexus says why a hook creates curiosity, status, fear, awe, relief, or useful urgency.',
  },
  {
    id: 'brand-positioning-distinctive-assets',
    category: 'brand_positioning',
    sourceAnchors: [
      'Ehrenberg-Bass distinctive brand assets',
      'How Brands Grow',
      'Binet & Field — Long and Short of It',
      'Jobs to Be Done',
      'Porter Five Forces',
      'Blue Ocean Strategy Canvas',
      'April Dunford positioning',
      'Ries positioning',
      'StoryBrand',
    ],
    principle: 'Creator growth needs both distinctive memory structures and activation, tied to a clear audience, enemy, category, promise, and proof.',
    productBehavior: 'Agency packages include positioning, strategic enemy, proof library, distinctive assets, content pillars, and a long/short balance.',
    qualityGateImpact: 'Warns when content is entertaining but does not build brand memory, POV, or trust.',
    blockedFailureModes: ['weak_positioning', 'generic_brand_voice', 'no_proof_library', 'activation_without_brand'],
    exampleUserFacingEffect: 'Nexus explains the creator POV and what the audience should remember after the piece.',
  },
  {
    id: 'script-hook-payoff-structure',
    category: 'scripting_storytelling',
    sourceAnchors: [
      'Contagious / STEPPS',
      'Made to Stick',
      'Hooked',
      'Robert McKee Story',
      'Save the Cat',
      'Building a StoryBrand',
    ],
    principle: 'Scripts need a clear promise, stakes, proof, progression, payoff, and CTA, not only clever opening lines.',
    productBehavior: 'Script variants include cold open, promise, context, stakes, proof, turns, payoff, CTA, and retention devices.',
    qualityGateImpact: 'Blocks scripts with no payoff, no proof, no audience transformation, or weak CTA.',
    blockedFailureModes: ['weak_hook', 'missing_payoff', 'proof_gap', 'unclear_cta'],
    exampleUserFacingEffect: 'Nexus highlights the first three seconds and the exact viewer reward for staying.',
  },
  {
    id: 'mobile-first-editing-direction',
    category: 'editing_production',
    sourceAnchors: [
      'TikTok Creative Codes',
      'Meta Instagram video ads best practices',
      'YouTube Shorts creator hub',
      'Adobe Premiere Pro learning guide',
      'DaVinci Resolve official training',
      'Canva social video editing basics',
      'CapCut beginner tutorial',
    ],
    principle: 'Creative direction must translate strategy into production: framing, shot list, captions, cuts, overlays, B-roll, sound, and feasibility.',
    productBehavior: 'Outputs include first-frame visual, shot list, B-roll, caption treatment, sound/music notes, edit rhythm, and production complexity.',
    qualityGateImpact: 'Warns when advice is strategically good but impossible or unclear to film/edit.',
    blockedFailureModes: ['no_first_frame', 'no_shot_list', 'production_infeasible', 'editing_notes_missing'],
    exampleUserFacingEffect: 'Nexus tells the creator exactly what to film first and what text appears on screen.',
  },
  {
    id: 'creator-agency-commercial-loop',
    category: 'creator_economy_agency',
    sourceAnchors: [
      'IAB creator economy research',
      'IAB Europe creator marketing hub',
      'Influencer marketing effectiveness meta-analysis',
      'Social media marketing activities research',
      'Creator partnerships and UGC campaign references',
      'Pew and DataReportal audience context',
    ],
    principle: 'A serious creator agency balances organic, paid, UGC, partnerships, brand lift, direct response, conversion, and trust.',
    productBehavior: 'Packages separate organic idea, paid/UGC adaptation, partnership disclosure needs, funnel stage, and measurement plan.',
    qualityGateImpact: 'Flags creative that might get attention but does not serve campaign goals, trust, or conversion.',
    blockedFailureModes: ['campaign_goal_missing', 'paid_organic_confusion', 'trust_risk', 'no_measurement_plan'],
    exampleUserFacingEffect: 'Nexus says whether the idea is for reach, trust, saves, leads, or conversion.',
  },
  {
    id: 'disclosure-copyright-claim-safety',
    category: 'compliance_policy',
    sourceAnchors: [
      'FTC endorsements, influencers, and reviews',
      'ASA influencer ad disclosure',
      'UK social media endorsements guidance',
      'Meta branded content policies',
      'YouTube fair use',
      'YouTube copyright tools',
    ],
    principle: 'Branded, sponsored, copyright, and claim-sensitive work needs disclosure and risk screening before approval.',
    productBehavior: 'Compliance review blocks missing disclosures, direct copying, unsupported regulated claims, and false fair-use certainty.',
    qualityGateImpact: 'Prevents publish/approval when sponsorship disclosure, copyright, plagiarism, or regulated-claim risk is unresolved.',
    blockedFailureModes: [
      'sponsored_or_branded_content_requires_clear_disclosure',
      'copyright_or_visual_identity_review_required',
      'copying_competitor_creative_blocked',
      'unsupported_or_overconfident_claim_blocked',
    ],
    exampleUserFacingEffect: 'Nexus says “approval blocked until #ad disclosure is added” instead of quietly producing risky copy.',
  },
  {
    id: 'agent-handoffs-evals-guardrails',
    category: 'agent_eval_architecture',
    sourceAnchors: [
      'OpenAI Codex Agent Skills',
      'OpenAI AGENTS.md instructions',
      'OpenAI Agents SDK handoffs',
      'OpenAI guardrails and human review',
      'OpenAI Evals',
      'OpenAI evaluation best practices',
    ],
    principle: 'Specialist agents should exchange structured briefs, hypotheses, evidence, risks, decisions, and next actions, then be evaluated on output usefulness.',
    productBehavior: 'The orchestrator stores specialist sections, source trace, quality gate results, critical-user review, and next actions.',
    qualityGateImpact: 'Requires structured handoff data and output-quality evaluation instead of opaque model prose.',
    blockedFailureModes: ['opaque_agent_output', 'missing_source_trace', 'no_quality_gate', 'no_critical_user_review'],
    exampleUserFacingEffect: 'Nexus shows what each specialist checked and what still needs the user’s judgment.',
  },
];

export const CONTENT_AGENCY_RUNTIME_QUALITY_RULES: Record<string, ContentAgencyRuleCategory[]> = {
  audienceSpecificity: ['brand_positioning', 'agent_eval_architecture'],
  platformNativeFit: [
    'youtube_discovery_analytics',
    'tiktok_native_creative',
    'instagram_meta_ranking',
    'google_search_helpful_content',
  ],
  hookStrength: ['human_behavior_story', 'scripting_storytelling'],
  firstFrameClarity: ['tiktok_native_creative', 'editing_production'],
  narrativeTension: ['human_behavior_story', 'scripting_storytelling'],
  emotionalArousalShareability: ['human_behavior_story'],
  proofDensity: ['google_search_helpful_content', 'creator_economy_agency'],
  originality: ['compliance_policy', 'scripting_storytelling'],
  brandConsistency: ['brand_positioning', 'creator_economy_agency'],
  complianceSafety: ['compliance_policy'],
  editability: ['editing_production'],
  productionFeasibility: ['editing_production', 'creator_economy_agency'],
  claimGrounding: ['google_search_helpful_content', 'compliance_policy'],
  experimentClarity: ['youtube_discovery_analytics', 'instagram_meta_ranking', 'creator_economy_agency'],
  actionability: ['agent_eval_architecture'],
};

export function listContentAgencyRules(): ContentAgencyRule[] {
  return CONTENT_AGENCY_RULES.map((rule) => ({
    ...rule,
    sourceAnchors: [...rule.sourceAnchors],
    blockedFailureModes: [...rule.blockedFailureModes],
  }));
}

export function getContentAgencyRule(id: string): ContentAgencyRule | null {
  const found = CONTENT_AGENCY_RULES.find((rule) => rule.id === id);
  return found ? { ...found, sourceAnchors: [...found.sourceAnchors], blockedFailureModes: [...found.blockedFailureModes] } : null;
}

export function getContentAgencyRulesByCategory(category: ContentAgencyRuleCategory): ContentAgencyRule[] {
  return listContentAgencyRules().filter((rule) => rule.category === category);
}

export function validateContentAgencyRuleCoverage(): { valid: boolean; missingCategories: ContentAgencyRuleCategory[] } {
  const categories = new Set(CONTENT_AGENCY_RULES.map((rule) => rule.category));
  const missingCategories = CONTENT_AGENCY_RULE_CATEGORIES.filter((category) => !categories.has(category));
  return { valid: missingCategories.length === 0, missingCategories };
}

export function validateContentAgencyRuntimeRuleCoverage(): {
  valid: boolean;
  missingCategories: ContentAgencyRuleCategory[];
  dimensions: string[];
} {
  const runtimeCategories = new Set(
    Object.values(CONTENT_AGENCY_RUNTIME_QUALITY_RULES).flat(),
  );
  const missingCategories = CONTENT_AGENCY_RULE_CATEGORIES.filter((category) => !runtimeCategories.has(category));
  return {
    valid: missingCategories.length === 0,
    missingCategories,
    dimensions: Object.keys(CONTENT_AGENCY_RUNTIME_QUALITY_RULES),
  };
}
