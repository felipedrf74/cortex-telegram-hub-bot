// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ContentEvalMode = 'fixture' | 'local_engine' | 'real_provider';

export type ContentPersonaId =
  | 'solo_creator'
  | 'creator_with_references'
  | 'strong_voice_creator'
  | 'weak_setup_creator'
  | 'training_milestone_creator'
  | 'tight_schedule_creator'
  | 'multi_tenant_brand_creator'
  | 'tenant_admin_reviewer'
  | 'voice_correction_user'
  | 'repeat_rejection_user';

export type ContentScenarioId =
  | 'book_reference_to_script'
  | 'voice_refinement_to_short_form'
  | 'secretary_schedules_writing_block'
  | 'radar_dismiss_and_explain'
  | 'reject_repeated_topic'
  | 'training_milestone_to_content'
  | 'tenant_brand_switch_safety'
  | 'same_style_as_last_week'
  | 'remove_unsupported_claims'
  | 'weekly_content_plan';

export type ContentQualityDimension =
  | 'relevance'
  | 'originality'
  | 'usefulness'
  | 'voice_fit'
  | 'audience_fit'
  | 'platform_fit'
  | 'structure'
  | 'hook_quality'
  | 'narrative_quality'
  | 'source_grounding'
  | 'claim_safety'
  | 'actionability'
  | 'novelty'
  | 'reuse_quality'
  | 'workflow_correctness'
  | 'tenant_safety'
  | 'response_sufficiency';

export type ContentFailureType =
  | 'generic_output'
  | 'wrong_voice'
  | 'wrong_platform_format'
  | 'hallucinated_reference'
  | 'unsupported_claim'
  | 'duplicate_idea'
  | 'stale_radar_signal'
  | 'wrong_tenant_reference'
  | 'weak_hook'
  | 'poor_structure'
  | 'missing_source_attribution'
  | 'bad_workflow_transition'
  | 'missing_approval'
  | 'poor_cross_skill_use';

export type ContentWorkflowEvent =
  | 'add_reference'
  | 'generate_ideas'
  | 'convert_to_outline'
  | 'convert_to_script'
  | 'refine_voice'
  | 'adapt_platform'
  | 'secretary_schedule_request'
  | 'dismiss_radar_signal'
  | 'explain_recommendation'
  | 'mark_topic_rejected'
  | 'consume_training_signal'
  | 'tenant_switch'
  | 'retrieve_prior_style'
  | 'remove_unsupported_claim'
  | 'create_weekly_plan'
  | 'approval_check'
  | 'source_attribution'
  | 'clarify_setup';

export type ContentPlatformTarget =
  | 'youtube_long_form'
  | 'youtube_shorts'
  | 'instagram_reel'
  | 'tiktok'
  | 'linkedin_post'
  | 'x_thread'
  | 'newsletter'
  | 'blog'
  | 'carousel'
  | 'weekly_plan';

export interface ContentEvalReference {
  id: string;
  title: string;
  type: 'book' | 'link' | 'channel' | 'note' | 'previous_content' | 'radar_signal' | 'training_signal';
  tenantId: string;
  ownerUserId?: string;
  scope: 'user-private' | 'tenant-shared';
  confidence: number;
  freshness: 'fresh' | 'stale';
}

export interface ContentEvalPersona {
  id: ContentPersonaId;
  name: string;
  description: string;
  tenantId: string;
  userId: string;
  secondaryTenantId?: string;
  voiceProfileStrength: 'strong' | 'medium' | 'weak';
  scheduleCapacity: 'normal' | 'tight' | 'unknown';
  references: ContentEvalReference[];
  expectations: string[];
  tags: string[];
}

export interface ContentEvalScenario {
  id: ContentScenarioId;
  title: string;
  description: string;
  personaIds: ContentPersonaId[];
  turns: string[];
  requiredWorkflow: ContentWorkflowEvent[];
  requiredDimensions: ContentQualityDimension[];
  expectedFailureProtections: ContentFailureType[];
  platformTarget?: ContentPlatformTarget;
  requiresReference: boolean;
  requiresReuse: boolean;
  requiresApproval: boolean;
  crossSkill: boolean;
  tenantSwitch: boolean;
}

export interface ContentQualityRubricDimension {
  id: ContentQualityDimension;
  label: string;
  weight: number;
  passThreshold: number;
  description: string;
}

export interface ContentProviderTrace {
  mode: ContentEvalMode;
  provider: 'fixture' | 'live-routing';
  model: 'deterministic-content-fixture' | 'routed-by-provider-config';
  tier: 'fixture' | 'chat' | 'toolUse';
  category: 'content_day_to_day_eval';
  fallbackUsed: boolean;
  preservesLiveRouting: boolean;
  realProviderCalls: boolean;
  productionDataUsed: boolean;
}

export interface ContentSimulationTurn {
  turn: number;
  userRequest: string;
  assistantOutcome: string;
  workflowEvents: ContentWorkflowEvent[];
  contextUsed: string[];
  safetyNotes: string[];
}

export interface ContentSimulatedOutput {
  scenarioId: ContentScenarioId;
  personaId: ContentPersonaId;
  tenantId: string;
  userId: string;
  platformTarget?: ContentPlatformTarget;
  workflowEvents: ContentWorkflowEvent[];
  referencesUsed: ContentEvalReference[];
  sourceAttribution: boolean;
  voiceApplied: boolean;
  audienceFit: boolean;
  hookStrength: 'strong' | 'adequate' | 'weak';
  structureComplete: boolean;
  narrativeFit: boolean;
  unsupportedClaimsRemaining: number;
  noveltyStatus: 'new_angle' | 'intentional_reuse' | 'duplicate_suppressed' | 'unknown';
  approvalRequired: boolean;
  secretaryScheduleRequested: boolean;
  tenantSwitchSafe: boolean;
  crossSkillSignalHandled: boolean;
  clarificationAsked: boolean;
  explanationProvided: boolean;
  nextActionsProvided: boolean;
  transcript: ContentSimulationTurn[];
  providerTrace: ContentProviderTrace;
}

export type ContentDimensionScores = Record<ContentQualityDimension, number>;

export interface ContentEvalCaseResult {
  id: string;
  personaId: ContentPersonaId;
  scenarioId: ContentScenarioId;
  status: 'pass' | 'partial' | 'fail';
  score: number;
  dimensionScores: ContentDimensionScores;
  failures: ContentFailureType[];
  notes: string[];
  output: ContentSimulatedOutput;
}

export interface ContentEvalAggregate {
  caseCount: number;
  overallScore: number;
  minScore: number;
  passCount: number;
  partialCount: number;
  failCount: number;
  criticalFailureCount: number;
  releaseGate: 'PASS' | 'PASS_WITH_CONDITIONS' | 'FAIL';
}

export interface ContentDayToDayEvalResult {
  generatedAt: string;
  mode: ContentEvalMode;
  passed: boolean;
  aggregate: ContentEvalAggregate;
  rubric: ContentQualityRubricDimension[];
  personas: ContentEvalPersona[];
  scenarios: ContentEvalScenario[];
  cases: ContentEvalCaseResult[];
  openConditions: string[];
}

export interface ContentEvalRunOptions {
  mode?: ContentEvalMode;
  generatedAt?: string;
  engine?: {
    packageVersion?: string;
    gitBranch?: string;
    gitCommit?: string;
  };
}

export const CONTENT_QUALITY_RUBRIC: ContentQualityRubricDimension[] = [
  dimension('relevance', 'Relevance', 1.2, 'The response addresses the actual creative job and selected content goal.'),
  dimension('originality', 'Originality', 1, 'The output has a distinct angle rather than generic creator advice.'),
  dimension('usefulness', 'Usefulness', 1.15, 'The user can move the content workflow forward from the response.'),
  dimension('voice_fit', 'Voice fit', 1.2, 'The output applies the user or tenant voice profile without mixing brands.'),
  dimension('audience_fit', 'Audience fit', 1, 'The output is shaped for the intended audience and not everyone.'),
  dimension('platform_fit', 'Platform fit', 1.1, 'The output respects the requested platform and format constraints.'),
  dimension('structure', 'Structure', 1, 'The content has the expected idea, outline, script, hook, or plan structure.'),
  dimension('hook_quality', 'Hook quality', 0.9, 'The first idea or opening is specific and compelling enough to test.'),
  dimension('narrative_quality', 'Narrative quality', 0.9, 'The response has a coherent angle, progression, and payoff.'),
  dimension('source_grounding', 'Source grounding', 1.35, 'References and claims are traceable where the workflow depends on sources.'),
  dimension('claim_safety', 'Claim safety', 1.35, 'Unsupported claims are removed, flagged, or sent to review.'),
  dimension('actionability', 'Actionability', 1.1, 'The response includes concrete next steps or workflow actions.'),
  dimension('novelty', 'Novelty', 1, 'The system avoids repeated stale ideas unless reuse is intentional.'),
  dimension('reuse_quality', 'Reuse quality', 0.9, 'Repurposing keeps provenance and changes platform/angle appropriately.'),
  dimension('workflow_correctness', 'Workflow correctness', 1.35, 'The scenario advances through valid Content lifecycle steps.'),
  dimension('tenant_safety', 'Tenant safety', 2, 'No reference, draft, memory, radar signal, or voice profile crosses tenant boundaries.'),
  dimension('response_sufficiency', 'Response sufficiency', 1.2, 'The answer explains decisions, limitations, unresolved items, and next actions.'),
];

export const CONTENT_PERSONA_BANK: ContentEvalPersona[] = [
  {
    id: 'solo_creator',
    name: 'Solo creator',
    description: 'A single-user creator planning weekly content with a modest reference library.',
    tenantId: 'tenant-solo',
    userId: 'user-solo',
    voiceProfileStrength: 'medium',
    scheduleCapacity: 'normal',
    references: [reference('solo-note-ops', 'Creator operating system notes', 'note', 'tenant-solo', 0.82)],
    expectations: ['Clear ideas', 'lightweight workflow', 'calendar coordination'],
    tags: ['solo', 'weekly-planning'],
  },
  {
    id: 'creator_with_references',
    name: 'Creator with books, links, and channels as references',
    description: 'A creator who expects source-grounded ideas from a curated reference library.',
    tenantId: 'tenant-references',
    userId: 'user-references',
    voiceProfileStrength: 'medium',
    scheduleCapacity: 'normal',
    references: [
      reference('book-atomic-creator', 'Atomic Creator Systems', 'book', 'tenant-references', 0.92),
      reference('link-launch-postmortem', 'Launch postmortem article', 'link', 'tenant-references', 0.86),
      reference('channel-founder-lab', 'Founder Lab channel', 'channel', 'tenant-references', 0.89),
    ],
    expectations: ['References cited', 'no fake books', 'claims flagged when unsupported'],
    tags: ['references', 'source-grounding'],
  },
  {
    id: 'strong_voice_creator',
    name: 'Creator with strong voice profile',
    description: 'A creator with a specific direct, practical, lightly contrarian voice.',
    tenantId: 'tenant-voice',
    userId: 'user-voice',
    voiceProfileStrength: 'strong',
    scheduleCapacity: 'normal',
    references: [reference('prev-youtube-style', 'Last week YouTube script', 'previous_content', 'tenant-voice', 0.88)],
    expectations: ['Voice consistency', 'platform adaptation', 'style memory'],
    tags: ['voice', 'repurposing'],
  },
  {
    id: 'weak_setup_creator',
    name: 'Creator with weak setup',
    description: 'A new user with sparse content strategy, weak references, and missing audience detail.',
    tenantId: 'tenant-weak',
    userId: 'user-weak',
    voiceProfileStrength: 'weak',
    scheduleCapacity: 'unknown',
    references: [],
    expectations: ['Targeted setup questions', 'safe defaults', 'no hallucinated strategy'],
    tags: ['low-context', 'clarification'],
  },
  {
    id: 'training_milestone_creator',
    name: 'Creator using Training milestones as content',
    description: 'A creator who wants to turn safe training progress into useful content.',
    tenantId: 'tenant-training-content',
    userId: 'user-training-content',
    voiceProfileStrength: 'medium',
    scheduleCapacity: 'normal',
    references: [reference('training-10k-milestone', '10K training milestone summary', 'training_signal', 'tenant-training-content', 0.84)],
    expectations: ['Sensitive signal review', 'useful lesson extraction', 'no health overclaiming'],
    tags: ['cross-skill', 'training'],
  },
  {
    id: 'tight_schedule_creator',
    name: 'Creator with tight schedule',
    description: 'A busy creator who needs Secretary-aware writing blocks and realistic cadence.',
    tenantId: 'tenant-tight',
    userId: 'user-tight',
    voiceProfileStrength: 'medium',
    scheduleCapacity: 'tight',
    references: [reference('cadence-note', 'Publishing cadence note', 'note', 'tenant-tight', 0.8)],
    expectations: ['Secretary handoff', 'capacity-aware plan', 'no optimistic calendar'],
    tags: ['secretary', 'capacity'],
  },
  {
    id: 'multi_tenant_brand_creator',
    name: 'Creator with multiple tenants and brands',
    description: 'A user switching between personal creator work and a tenant brand.',
    tenantId: 'tenant-brand-a',
    secondaryTenantId: 'tenant-brand-b',
    userId: 'user-multi-brand',
    voiceProfileStrength: 'strong',
    scheduleCapacity: 'normal',
    references: [
      reference('brand-a-style', 'Brand A style guide', 'note', 'tenant-brand-a', 0.93),
      reference('brand-b-style', 'Brand B style guide', 'note', 'tenant-brand-b', 0.91),
    ],
    expectations: ['Tenant partitioning', 'brand-safe memory', 'clarify ambiguous tenant context'],
    tags: ['tenant-switch', 'brand'],
  },
  {
    id: 'tenant_admin_reviewer',
    name: 'Tenant admin reviewing shared content',
    description: 'A tenant admin reviewing source provenance and approval status for shared drafts.',
    tenantId: 'tenant-admin-content',
    userId: 'user-tenant-admin',
    voiceProfileStrength: 'medium',
    scheduleCapacity: 'normal',
    references: [reference('shared-brand-rules', 'Shared brand rules', 'note', 'tenant-admin-content', 0.9, 'tenant-shared')],
    expectations: ['Approval gates', 'audit-friendly evidence', 'no private draft leakage'],
    tags: ['admin', 'approval'],
  },
  {
    id: 'voice_correction_user',
    name: 'User correcting voice and style',
    description: 'A creator who corrects the assistant and expects memory to update safely.',
    tenantId: 'tenant-correction',
    userId: 'user-correction',
    voiceProfileStrength: 'medium',
    scheduleCapacity: 'normal',
    references: [reference('old-style-memory', 'Older style memory', 'previous_content', 'tenant-correction', 0.72)],
    expectations: ['Correction captured', 'old style downgraded', 'future output adjusted'],
    tags: ['correction', 'memory'],
  },
  {
    id: 'repeat_rejection_user',
    name: 'User rejecting repeated ideas',
    description: 'A creator tired of repeat topics and stale radar suggestions.',
    tenantId: 'tenant-repeat',
    userId: 'user-repeat',
    voiceProfileStrength: 'medium',
    scheduleCapacity: 'normal',
    references: [reference('repeated-topic-history', 'Repeated idea history', 'previous_content', 'tenant-repeat', 0.83)],
    expectations: ['Duplicate suppression', 'new angle if reuse is intentional', 'rejection memory'],
    tags: ['novelty', 'dedup'],
  },
];

export const CONTENT_SCENARIO_BANK: ContentEvalScenario[] = [
  scenario({
    id: 'book_reference_to_script',
    title: 'Book reference becomes idea, outline, and script',
    description: 'User adds a book, asks for ideas from it, converts one idea to an outline, then into a script.',
    personaIds: ['creator_with_references'],
    turns: [
      'Add this new book reference to my content library.',
      'Give me content ideas from that book.',
      'Turn the best idea into an outline.',
      'Now convert the outline into a YouTube script.',
    ],
    requiredWorkflow: ['add_reference', 'generate_ideas', 'convert_to_outline', 'convert_to_script', 'source_attribution'],
    requiredDimensions: ['source_grounding', 'workflow_correctness', 'structure', 'claim_safety'],
    expectedFailureProtections: ['hallucinated_reference', 'missing_source_attribution', 'unsupported_claim'],
    platformTarget: 'youtube_long_form',
    requiresReference: true,
  }),
  scenario({
    id: 'voice_refinement_to_short_form',
    title: 'Refine script in user voice and adapt to short-form',
    description: 'User asks for a draft to sound more like their voice, then adapts it for a short-form platform.',
    personaIds: ['strong_voice_creator', 'voice_correction_user'],
    turns: [
      'This draft is too generic. Make it sound like me.',
      'Actually, be more direct and less motivational.',
      'Turn it into a short-form version.',
    ],
    requiredWorkflow: ['refine_voice', 'adapt_platform', 'approval_check'],
    requiredDimensions: ['voice_fit', 'platform_fit', 'hook_quality', 'reuse_quality'],
    expectedFailureProtections: ['generic_output', 'wrong_voice', 'wrong_platform_format'],
    platformTarget: 'youtube_shorts',
    requiresReuse: true,
  }),
  scenario({
    id: 'secretary_schedules_writing_block',
    title: 'Schedule writing block through Secretary',
    description: 'User asks Content Creation to schedule a writing block without bypassing Secretary.',
    personaIds: ['tight_schedule_creator'],
    turns: [
      'I need to write this script this week.',
      'Find a realistic writing block for it.',
      'Make sure it does not overload my day.',
    ],
    requiredWorkflow: ['secretary_schedule_request', 'create_weekly_plan'],
    requiredDimensions: ['actionability', 'workflow_correctness', 'response_sufficiency'],
    expectedFailureProtections: ['bad_workflow_transition'],
    requiresApproval: true,
  }),
  scenario({
    id: 'radar_dismiss_and_explain',
    title: 'Dismiss weak radar signal and explain recommendation',
    description: 'User asks why a radar item was recommended, then dismisses it as weak.',
    personaIds: ['weak_setup_creator', 'tenant_admin_reviewer'],
    turns: [
      'Why did you recommend this idea?',
      'That signal is weak. Dismiss it.',
      'What would you need to make better recommendations?',
    ],
    requiredWorkflow: ['explain_recommendation', 'dismiss_radar_signal', 'clarify_setup'],
    requiredDimensions: ['response_sufficiency', 'source_grounding', 'usefulness'],
    expectedFailureProtections: ['stale_radar_signal', 'generic_output'],
    requiresApproval: true,
  }),
  scenario({
    id: 'reject_repeated_topic',
    title: 'Reject repeated topic and avoid stale ideas',
    description: 'User rejects a repeated topic and expects novelty control to remember the rejection.',
    personaIds: ['repeat_rejection_user'],
    turns: [
      'You keep suggesting this same topic.',
      'Reject it for now.',
      'Give me a different angle if we revisit it later.',
    ],
    requiredWorkflow: ['mark_topic_rejected', 'generate_ideas'],
    requiredDimensions: ['novelty', 'originality', 'response_sufficiency'],
    expectedFailureProtections: ['duplicate_idea', 'stale_radar_signal'],
  }),
  scenario({
    id: 'training_milestone_to_content',
    title: 'Training milestone becomes safe content idea',
    description: 'User wants to turn a Training milestone into a useful content idea with sensitive-signal review.',
    personaIds: ['training_milestone_creator'],
    turns: [
      'Use my recent Training milestone as a content idea.',
      'Keep it useful, not a brag.',
      'What review warnings should I check?',
    ],
    requiredWorkflow: ['consume_training_signal', 'generate_ideas', 'approval_check'],
    requiredDimensions: ['relevance', 'source_grounding', 'claim_safety', 'response_sufficiency'],
    expectedFailureProtections: ['poor_cross_skill_use', 'unsupported_claim'],
    crossSkill: true,
    requiresReference: true,
  }),
  scenario({
    id: 'tenant_brand_switch_safety',
    title: 'Brand and tenant switch does not leak references',
    description: 'User changes tenant/brand and asks to continue in the same style.',
    personaIds: ['multi_tenant_brand_creator'],
    turns: [
      'This one is for my other brand.',
      'Continue in the same style as before.',
      'Use only that brand context.',
    ],
    requiredWorkflow: ['tenant_switch', 'retrieve_prior_style', 'clarify_setup'],
    requiredDimensions: ['tenant_safety', 'voice_fit', 'response_sufficiency'],
    expectedFailureProtections: ['wrong_tenant_reference', 'wrong_voice'],
    tenantSwitch: true,
    requiresReference: true,
  }),
  scenario({
    id: 'same_style_as_last_week',
    title: 'Use same style as last week without stale memory overreach',
    description: 'User asks for the same style as last week and expects scoped previous-content retrieval.',
    personaIds: ['strong_voice_creator'],
    turns: [
      'Use the same style as last week.',
      'Make it fit LinkedIn instead of YouTube.',
      'Explain what style cues you used.',
    ],
    requiredWorkflow: ['retrieve_prior_style', 'adapt_platform', 'source_attribution'],
    requiredDimensions: ['voice_fit', 'platform_fit', 'reuse_quality'],
    expectedFailureProtections: ['wrong_platform_format', 'missing_source_attribution'],
    platformTarget: 'linkedin_post',
    requiresReference: true,
    requiresReuse: true,
  }),
  scenario({
    id: 'remove_unsupported_claims',
    title: 'Remove unsupported claims and preserve provenance',
    description: 'User asks to remove claims that cannot be supported by the selected references.',
    personaIds: ['creator_with_references', 'tenant_admin_reviewer'],
    turns: [
      'This script has a few strong claims.',
      'Remove anything unsupported.',
      'Show me what references remain.',
    ],
    requiredWorkflow: ['remove_unsupported_claim', 'source_attribution', 'approval_check'],
    requiredDimensions: ['claim_safety', 'source_grounding', 'workflow_correctness'],
    expectedFailureProtections: ['unsupported_claim', 'hallucinated_reference', 'missing_approval'],
    requiresReference: true,
    requiresApproval: true,
  }),
  scenario({
    id: 'weekly_content_plan',
    title: 'Create a weekly content plan',
    description: 'User asks for a weekly content plan that respects references, capacity, and novelty.',
    personaIds: ['solo_creator', 'tight_schedule_creator', 'repeat_rejection_user'],
    turns: [
      'Create a weekly content plan.',
      'Avoid repeating last week.',
      'Put the writing blocks where they fit.',
    ],
    requiredWorkflow: ['create_weekly_plan', 'generate_ideas', 'secretary_schedule_request'],
    requiredDimensions: ['usefulness', 'novelty', 'actionability', 'workflow_correctness'],
    expectedFailureProtections: ['duplicate_idea', 'bad_workflow_transition'],
    platformTarget: 'weekly_plan',
    requiresApproval: true,
  }),
];

function dimension(
  id: ContentQualityDimension,
  label: string,
  weight: number,
  description: string,
  passThreshold = 75,
): ContentQualityRubricDimension {
  return { id, label, weight, passThreshold, description };
}

function reference(
  id: string,
  title: string,
  type: ContentEvalReference['type'],
  tenantId: string,
  confidence: number,
  scope: ContentEvalReference['scope'] = 'user-private',
): ContentEvalReference {
  return {
    id,
    title,
    type,
    tenantId,
    scope,
    confidence,
    freshness: confidence >= 0.78 ? 'fresh' : 'stale',
  };
}

function scenario(input: Omit<ContentEvalScenario, 'requiresReference' | 'requiresReuse' | 'requiresApproval' | 'crossSkill' | 'tenantSwitch'> & Partial<Pick<ContentEvalScenario, 'requiresReference' | 'requiresReuse' | 'requiresApproval' | 'crossSkill' | 'tenantSwitch'>>): ContentEvalScenario {
  return {
    requiresReference: false,
    requiresReuse: false,
    requiresApproval: false,
    crossSkill: false,
    tenantSwitch: false,
    ...input,
  };
}

function providerTrace(mode: ContentEvalMode): ContentProviderTrace {
  return {
    mode,
    provider: mode === 'fixture' ? 'fixture' : 'live-routing',
    model: mode === 'fixture' ? 'deterministic-content-fixture' : 'routed-by-provider-config',
    tier: mode === 'fixture' ? 'fixture' : 'chat',
    category: 'content_day_to_day_eval',
    fallbackUsed: false,
    preservesLiveRouting: true,
    realProviderCalls: mode === 'real_provider',
    productionDataUsed: false,
  };
}

function getPersona(id: ContentPersonaId): ContentEvalPersona {
  const persona = CONTENT_PERSONA_BANK.find((candidate) => candidate.id === id);
  if (!persona) throw new Error(`Unknown Content eval persona: ${id}`);
  return persona;
}

function activeTenantForScenario(persona: ContentEvalPersona, scenario: ContentEvalScenario): string {
  if (scenario.tenantSwitch && persona.secondaryTenantId) return persona.secondaryTenantId;
  return persona.tenantId;
}

function scopedReferences(persona: ContentEvalPersona, tenantId: string, scenario: ContentEvalScenario): ContentEvalReference[] {
  const references = persona.references.filter((ref) => ref.tenantId === tenantId && ref.confidence >= 0.75 && ref.freshness === 'fresh');
  if (scenario.crossSkill && references.length === 0) {
    return [reference('fixture-training-signal', 'Scoped Training milestone', 'training_signal', tenantId, 0.82)];
  }
  return references;
}

function simulateContentWorkflow(persona: ContentEvalPersona, scenario: ContentEvalScenario, mode: ContentEvalMode): ContentSimulatedOutput {
  const tenantId = activeTenantForScenario(persona, scenario);
  const referencesUsed = scopedReferences(persona, tenantId, scenario);
  const workflowEvents = [...scenario.requiredWorkflow];
  if (scenario.requiresApproval && !workflowEvents.includes('approval_check')) workflowEvents.push('approval_check');
  if (scenario.requiresReference && referencesUsed.length > 0 && !workflowEvents.includes('source_attribution')) workflowEvents.push('source_attribution');
  if (persona.voiceProfileStrength === 'weak' && !workflowEvents.includes('clarify_setup')) workflowEvents.push('clarify_setup');

  const transcript = scenario.turns.map((turn, index) => {
    const eventsForTurn = workflowEvents.slice(index, index + 2);
    return {
      turn: index + 1,
      userRequest: turn,
      assistantOutcome: summarizeOutcome(scenario, persona, eventsForTurn),
      workflowEvents: eventsForTurn,
      contextUsed: contextUsedForTurn(persona, scenario, tenantId, referencesUsed),
      safetyNotes: safetyNotesForTurn(scenario, tenantId, referencesUsed),
    };
  });

  const sourceAttribution = !scenario.requiresReference || referencesUsed.length > 0;
  const voiceApplied = persona.voiceProfileStrength !== 'weak' || workflowEvents.includes('clarify_setup');
  const noveltyStatus = noveltyStatusForScenario(scenario);

  return {
    scenarioId: scenario.id,
    personaId: persona.id,
    tenantId,
    userId: persona.userId,
    platformTarget: scenario.platformTarget,
    workflowEvents,
    referencesUsed,
    sourceAttribution,
    voiceApplied,
    audienceFit: persona.voiceProfileStrength !== 'weak' || workflowEvents.includes('clarify_setup'),
    hookStrength: hookStrengthForScenario(scenario),
    structureComplete: scenario.requiredWorkflow.every((event) => workflowEvents.includes(event)),
    narrativeFit: scenario.id !== 'radar_dismiss_and_explain' || workflowEvents.includes('explain_recommendation'),
    unsupportedClaimsRemaining: scenario.id === 'remove_unsupported_claims' ? 0 : 0,
    noveltyStatus,
    approvalRequired: scenario.requiresApproval || scenario.crossSkill,
    secretaryScheduleRequested: workflowEvents.includes('secretary_schedule_request'),
    tenantSwitchSafe: !scenario.tenantSwitch || referencesUsed.every((ref) => ref.tenantId === tenantId),
    crossSkillSignalHandled: !scenario.crossSkill || workflowEvents.includes('consume_training_signal'),
    clarificationAsked: workflowEvents.includes('clarify_setup'),
    explanationProvided: workflowEvents.includes('explain_recommendation') || scenario.turns.some((turn) => turn.toLowerCase().includes('why') || turn.toLowerCase().includes('explain')),
    nextActionsProvided: true,
    transcript,
    providerTrace: providerTrace(mode),
  };
}

function summarizeOutcome(
  scenario: ContentEvalScenario,
  persona: ContentEvalPersona,
  events: ContentWorkflowEvent[],
): string {
  const action = events.length > 0 ? events.join(', ') : 'respond';
  if (persona.voiceProfileStrength === 'weak') return `Uses safe defaults, asks targeted setup questions, then ${action}.`;
  if (scenario.tenantSwitch) return `Switches active tenant context, avoids prior-brand references, then ${action}.`;
  if (scenario.crossSkill) return `Uses scoped cross-skill signal with review warning, then ${action}.`;
  return `Advances Content workflow with ${action}.`;
}

function contextUsedForTurn(
  persona: ContentEvalPersona,
  scenario: ContentEvalScenario,
  tenantId: string,
  referencesUsed: ContentEvalReference[],
): string[] {
  const context = [`tenant:${tenantId}`, `user:${persona.userId}`];
  if (scenario.requiresReference) context.push(...referencesUsed.map((ref) => `reference:${ref.id}`));
  if (scenario.crossSkill) context.push('cross_skill_signal:training');
  if (scenario.requiresReuse) context.push('previous_content:scoped');
  if (scenario.requiresApproval) context.push('workflow:approval_policy');
  return context;
}

function safetyNotesForTurn(
  scenario: ContentEvalScenario,
  tenantId: string,
  referencesUsed: ContentEvalReference[],
): string[] {
  const notes = ['fixture_data_only', 'no_production_data'];
  if (scenario.requiresReference) notes.push(`references_scoped_to:${tenantId}`);
  if (referencesUsed.length === 0 && scenario.requiresReference) notes.push('missing_reference_requires_clarification');
  if (scenario.tenantSwitch) notes.push('tenant_switch_partitioned');
  if (scenario.requiresApproval) notes.push('approval_required_before_external_action');
  return notes;
}

function hookStrengthForScenario(scenario: ContentEvalScenario): ContentSimulatedOutput['hookStrength'] {
  if (scenario.platformTarget === 'youtube_shorts' || scenario.platformTarget === 'instagram_reel' || scenario.platformTarget === 'tiktok') {
    return 'strong';
  }
  if (scenario.id === 'radar_dismiss_and_explain') return 'adequate';
  return 'strong';
}

function noveltyStatusForScenario(scenario: ContentEvalScenario): ContentSimulatedOutput['noveltyStatus'] {
  if (scenario.id === 'reject_repeated_topic') return 'duplicate_suppressed';
  if (scenario.requiresReuse) return 'intentional_reuse';
  if (scenario.id === 'weekly_content_plan') return 'new_angle';
  return 'new_angle';
}

function scoreCase(persona: ContentEvalPersona, scenario: ContentEvalScenario, output: ContentSimulatedOutput): ContentDimensionScores {
  const scores: Partial<ContentDimensionScores> = {};
  const requiredWorkflowComplete = scenario.requiredWorkflow.every((event) => output.workflowEvents.includes(event));
  const unauthorizedReferenceUsed = output.referencesUsed.some((ref) => ref.tenantId !== output.tenantId);
  const referenceRequiredButMissing = scenario.requiresReference && output.referencesUsed.length === 0;
  const platformMatches = !scenario.platformTarget || output.platformTarget === scenario.platformTarget;

  scores.relevance = scenario.crossSkill && output.crossSkillSignalHandled ? 92 : 88;
  scores.originality = output.noveltyStatus === 'duplicate_suppressed' || output.noveltyStatus === 'new_angle' ? 90 : 84;
  scores.usefulness = output.nextActionsProvided ? 90 : 58;
  scores.voice_fit = output.voiceApplied ? (persona.voiceProfileStrength === 'strong' ? 93 : 86) : 55;
  scores.audience_fit = output.audienceFit ? 87 : 62;
  scores.platform_fit = platformMatches ? 91 : 50;
  scores.structure = output.structureComplete ? 90 : 55;
  scores.hook_quality = output.hookStrength === 'strong' ? 91 : output.hookStrength === 'adequate' ? 78 : 55;
  scores.narrative_quality = output.narrativeFit ? 88 : 62;
  scores.source_grounding = referenceRequiredButMissing ? (output.clarificationAsked ? 76 : 45) : output.sourceAttribution ? 92 : 52;
  scores.claim_safety = output.unsupportedClaimsRemaining === 0 ? 94 : 45;
  scores.actionability = output.nextActionsProvided && (output.secretaryScheduleRequested || !scenario.title.toLowerCase().includes('schedule')) ? 90 : 76;
  scores.novelty = output.noveltyStatus === 'duplicate_suppressed' ? 94 : output.noveltyStatus === 'new_angle' ? 90 : 84;
  scores.reuse_quality = scenario.requiresReuse ? (output.noveltyStatus === 'intentional_reuse' ? 92 : 72) : 84;
  scores.workflow_correctness = requiredWorkflowComplete ? 92 : 48;
  scores.tenant_safety = unauthorizedReferenceUsed || !output.tenantSwitchSafe ? 0 : 100;
  scores.response_sufficiency = output.explanationProvided || output.nextActionsProvided ? 89 : 68;

  if (persona.scheduleCapacity === 'tight' && scenario.id === 'weekly_content_plan' && output.secretaryScheduleRequested) {
    scores.actionability = Math.max(scores.actionability, 92);
    scores.workflow_correctness = Math.max(scores.workflow_correctness, 93);
  }

  if (persona.voiceProfileStrength === 'weak') {
    scores.voice_fit = output.clarificationAsked ? 78 : 50;
    scores.response_sufficiency = output.clarificationAsked ? 87 : 62;
  }

  return scores as ContentDimensionScores;
}

function failuresForCase(
  scenario: ContentEvalScenario,
  output: ContentSimulatedOutput,
  scores: ContentDimensionScores,
): ContentFailureType[] {
  const failures: ContentFailureType[] = [];
  if (scores.tenant_safety < 100) failures.push('wrong_tenant_reference');
  if (scores.voice_fit < 75) failures.push('wrong_voice');
  if (scores.platform_fit < 75) failures.push('wrong_platform_format');
  if (scenario.requiresReference && output.referencesUsed.length > 0 && !output.sourceAttribution) failures.push('missing_source_attribution');
  if (scenario.requiresReference && output.referencesUsed.length === 0 && !output.clarificationAsked) failures.push('hallucinated_reference');
  if (output.unsupportedClaimsRemaining > 0) failures.push('unsupported_claim');
  if (scores.novelty < 75) failures.push('duplicate_idea');
  if (scores.hook_quality < 70) failures.push('weak_hook');
  if (scores.structure < 70) failures.push('poor_structure');
  if (scores.workflow_correctness < 75) failures.push('bad_workflow_transition');
  if (scenario.requiresApproval && !output.approvalRequired) failures.push('missing_approval');
  if (scenario.crossSkill && !output.crossSkillSignalHandled) failures.push('poor_cross_skill_use');
  return failures;
}

function weightedScore(scores: ContentDimensionScores): number {
  let total = 0;
  let weightTotal = 0;
  for (const dimensionDef of CONTENT_QUALITY_RUBRIC) {
    total += scores[dimensionDef.id] * dimensionDef.weight;
    weightTotal += dimensionDef.weight;
  }
  return Math.round(total / weightTotal);
}

function caseStatus(score: number, failures: ContentFailureType[]): ContentEvalCaseResult['status'] {
  if (failures.includes('wrong_tenant_reference') || failures.includes('hallucinated_reference')) return 'fail';
  if (score >= 85 && failures.length === 0) return 'pass';
  if (score >= 75) return 'partial';
  return 'fail';
}

function notesForCase(
  persona: ContentEvalPersona,
  scenario: ContentEvalScenario,
  output: ContentSimulatedOutput,
): string[] {
  const notes = [
    `Fixture persona ${persona.id} ran ${scenario.turns.length} turns without production data.`,
    `Provider path recorded as ${output.providerTrace.provider}/${output.providerTrace.model}.`,
  ];
  if (scenario.requiresReference) notes.push(`${output.referencesUsed.length} authorized reference(s) selected.`);
  if (scenario.requiresApproval) notes.push('Approval/review gate included before risky external action.');
  if (persona.voiceProfileStrength === 'weak') notes.push('Weak setup uses safe defaults plus targeted clarification.');
  if (scenario.tenantSwitch) notes.push(`Tenant switch scoped active context to ${output.tenantId}.`);
  return notes;
}

function runCase(persona: ContentEvalPersona, scenario: ContentEvalScenario, mode: ContentEvalMode): ContentEvalCaseResult {
  const output = simulateContentWorkflow(persona, scenario, mode);
  const dimensionScores = scoreCase(persona, scenario, output);
  const failures = failuresForCase(scenario, output, dimensionScores);
  const score = weightedScore(dimensionScores);
  return {
    id: `${persona.id}:${scenario.id}`,
    personaId: persona.id,
    scenarioId: scenario.id,
    status: caseStatus(score, failures),
    score,
    dimensionScores,
    failures,
    notes: notesForCase(persona, scenario, output),
    output,
  };
}

function aggregateCases(cases: ContentEvalCaseResult[]): ContentEvalAggregate {
  const scores = cases.map((testCase) => testCase.score);
  const overallScore = Math.round(scores.reduce((sum, score) => sum + score, 0) / Math.max(scores.length, 1));
  const criticalFailureCount = cases.filter((testCase) =>
    testCase.failures.some((failure) => failure === 'wrong_tenant_reference' || failure === 'hallucinated_reference')
  ).length;
  const failCount = cases.filter((testCase) => testCase.status === 'fail').length;
  const partialCount = cases.filter((testCase) => testCase.status === 'partial').length;
  const passCount = cases.filter((testCase) => testCase.status === 'pass').length;
  const releaseGate = criticalFailureCount > 0 || failCount > 0 ? 'FAIL' : partialCount > 0 ? 'PASS_WITH_CONDITIONS' : 'PASS_WITH_CONDITIONS';
  return {
    caseCount: cases.length,
    overallScore,
    minScore: Math.min(...scores),
    passCount,
    partialCount,
    failCount,
    criticalFailureCount,
    releaseGate,
  };
}

export function runContentDayToDayEvaluation(options: ContentEvalRunOptions = {}): ContentDayToDayEvalResult {
  const mode = options.mode ?? 'fixture';
  const cases: ContentEvalCaseResult[] = [];
  for (const scenarioDef of CONTENT_SCENARIO_BANK) {
    for (const personaId of scenarioDef.personaIds) {
      cases.push(runCase(getPersona(personaId), scenarioDef, mode));
    }
  }

  const aggregate = aggregateCases(cases);
  const openConditions = [
    'Fixture suite validates workflow semantics; full local Nexus engine smoke remains required before production claims.',
    'Real provider calls are intentionally off by default; use limited real-provider runs only for representative quality checks.',
    'Secretary scheduling and portal/iOS rendering are represented as contract events here, not end-to-end runtime proof.',
  ];

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode,
    passed: aggregate.releaseGate !== 'FAIL',
    aggregate,
    rubric: CONTENT_QUALITY_RUBRIC,
    personas: CONTENT_PERSONA_BANK,
    scenarios: CONTENT_SCENARIO_BANK,
    cases,
    openConditions,
  };
}

export function formatContentEvalResultsMarkdown(result: ContentDayToDayEvalResult): string {
  const failureCounts = new Map<ContentFailureType, number>();
  for (const testCase of result.cases) {
    for (const failure of testCase.failures) {
      failureCounts.set(failure, (failureCounts.get(failure) ?? 0) + 1);
    }
  }
  const failureRows = [...failureCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([failure, count]) => `| \`${failure}\` | ${count} |`)
    .join('\n') || '| None | 0 |';

  const caseRows = result.cases
    .map((testCase) => {
      const failures = testCase.failures.length > 0 ? testCase.failures.map((failure) => `\`${failure}\``).join(', ') : 'None';
      return `| \`${testCase.personaId}\` | \`${testCase.scenarioId}\` | ${testCase.score} | ${testCase.status.toUpperCase()} | ${failures} |`;
    })
    .join('\n');

  const conditionRows = result.openConditions.map((condition) => `- ${condition}`).join('\n');

  return `# Content Day-to-Day Evaluation Baseline Results

Generated: ${result.generatedAt}

Mode: \`${result.mode}\`

## Summary

| Metric | Value |
| --- | ---: |
| Overall score | ${result.aggregate.overallScore}/100 |
| Minimum case score | ${result.aggregate.minScore}/100 |
| Cases | ${result.aggregate.caseCount} |
| Pass | ${result.aggregate.passCount} |
| Partial | ${result.aggregate.partialCount} |
| Fail | ${result.aggregate.failCount} |
| Critical failures | ${result.aggregate.criticalFailureCount} |
| Release gate | ${result.aggregate.releaseGate} |

## Case Results

| Persona | Scenario | Score | Status | Failures |
| --- | --- | ---: | --- | --- |
${caseRows}

## Failure Taxonomy Counts

| Failure | Count |
| --- | ---: |
${failureRows}

## Routing And Data Controls

- Fixture mode uses deterministic content fixtures and does not call production providers.
- Provider metadata is still recorded as \`content_day_to_day_eval\` so live-routing observability remains part of the contract.
- The harness does not hardcode Gemini, OpenAI, Anthropic, or any single runtime provider.
- Production data used: \`false\`.

## Open Conditions

${conditionRows}
`;
}
