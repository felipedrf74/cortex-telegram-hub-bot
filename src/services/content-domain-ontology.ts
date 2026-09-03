// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ContentVisibilityScope } from './content-tenant-scope';

export const CONTENT_ONTOLOGY_SCHEMA_VERSION = 'content-ontology-v1';

export const CONTENT_OBJECT_TYPES = [
  'idea',
  'topic',
  'hook',
  'outline',
  'script',
  'caption',
  'carousel',
  'thread',
  'newsletter',
  'blog',
  'video_concept',
  'radar_signal',
  'reference',
  'content_calendar_item',
  'campaign',
  'content_series',
  'content_pillar',
  'audience_segment',
] as const;

export type ContentObjectType = typeof CONTENT_OBJECT_TYPES[number];

export const CONTENT_LIFECYCLE_STATES = [
  'captured',
  'triaged',
  'planned',
  'researching',
  'outlining',
  'drafting',
  'reviewing',
  'approved',
  'scheduled',
  'published',
  'repurposed',
  'archived',
  'rejected',
  'cancelled',
] as const;

export type ContentLifecycleState = typeof CONTENT_LIFECYCLE_STATES[number];

export const CONTENT_PLATFORMS = [
  'youtube',
  'youtube_shorts',
  'instagram',
  'tiktok',
  'linkedin',
  'x_twitter',
  'newsletter',
  'blog',
  'podcast',
  'generic',
] as const;

export type ContentPlatformId = typeof CONTENT_PLATFORMS[number];

export const CONTENT_FORMAT_IDS = [
  'youtube_long_form',
  'youtube_shorts',
  'instagram_reel',
  'tiktok',
  'linkedin_post',
  'x_thread',
  'newsletter',
  'blog',
  'podcast_outline',
  'carousel',
  'generic_script',
  'caption',
] as const;

export type ContentFormatId = typeof CONTENT_FORMAT_IDS[number];

export const CONTENT_SOURCE_TYPES = [
  'book',
  'link',
  'channel',
  'note',
  'previous_content',
  'radar_signal',
  'external_research_result',
  'user_uploaded_source',
] as const;

export type ContentSourceType = typeof CONTENT_SOURCE_TYPES[number];

export const CONTENT_TRUST_LEVELS = [
  'unverified',
  'observed',
  'curated',
  'first_party',
  'published',
  'deprecated',
] as const;

export type ContentTrustLevel = typeof CONTENT_TRUST_LEVELS[number];

export const CONTENT_EXTRACTION_STATUSES = [
  'pending',
  'extracting',
  'indexed',
  'ready',
  'failed',
  'stale',
  'quarantined',
] as const;

export type ContentExtractionStatus = typeof CONTENT_EXTRACTION_STATUSES[number];

export interface ContentObjectSchema {
  objectType: ContentObjectType | string;
  label: string;
  purpose: string;
  allowedLifecycleStates: readonly (ContentLifecycleState | string)[];
  requiredFields: readonly string[];
  requiredMetadata: readonly string[];
  supportsPlatformFormat: boolean;
  supportsSourceAttribution: boolean;
  supportsReuseLineage: boolean;
}

export interface PlatformFormatDefinition {
  formatId: ContentFormatId | string;
  platforms: readonly (ContentPlatformId | string)[];
  label: string;
  primaryObjectType: ContentObjectType | string;
  structure: readonly string[];
  lengthExpectation: string;
  pacing: string;
  hookStyle: readonly string[];
  productionRequirements: readonly string[];
  sourceUsagePattern: string;
  editingReviewNeeds: readonly string[];
  requiredMetadata: readonly string[];
  extensibleViaTenantConfig: boolean;
}

export interface ReferenceSourceDefinition {
  sourceType: ContentSourceType | string;
  label: string;
  requiredMetadata: readonly string[];
  recommendedMetadata: readonly string[];
  freshnessPolicy: string;
  defaultTrustLevel: ContentTrustLevel;
  supportsExtraction: boolean;
}

export interface ContentStrategyModel {
  pillars: readonly string[];
  audienceSegments: readonly string[];
  voiceAttributes: readonly string[];
  requiredStrategyMetadata: readonly string[];
  optionalStrategyMetadata: readonly string[];
}

export interface ContentReferenceMetadata {
  sourceType: ContentSourceType | string;
  tenantId?: number | null;
  ownerUserId?: number | null;
  visibilityScope?: ContentVisibilityScope | string | null;
  freshness?: number | null;
  confidence?: number | null;
  trustLevel?: ContentTrustLevel | string | null;
  extractionStatus?: ContentExtractionStatus | string | null;
  topicTags?: readonly string[] | null;
  usedByOutputIds?: readonly string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface ContentClaim {
  id: string;
  text: string;
  evidenceIds?: readonly string[];
  confidence?: number;
}

export interface ContentEvidence {
  id: string;
  sourceId: string;
  summary: string;
  confidence?: number;
}

export interface ContentDomainObjectInput {
  objectType: ContentObjectType | string;
  title?: string | null;
  tenantId?: number | null;
  ownerUserId?: number | null;
  visibilityScope?: ContentVisibilityScope | string | null;
  lifecycleState?: ContentLifecycleState | string | null;
  platformId?: ContentPlatformId | string | null;
  formatId?: ContentFormatId | string | null;
  pillarIds?: readonly (number | string)[] | null;
  audienceSegmentIds?: readonly (number | string)[] | null;
  sourceReferences?: readonly ContentReferenceMetadata[] | null;
  claims?: readonly ContentClaim[] | null;
  evidence?: readonly ContentEvidence[] | null;
  reuseOfObjectId?: number | string | null;
  repurposeParentId?: number | string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ContentSourceOutputLinkInput {
  tenantId?: number | null;
  ownerUserId?: number | null;
  visibilityScope?: ContentVisibilityScope | string | null;
  sourceType: ContentSourceType | string;
  sourceId: string;
  outputObjectType: ContentObjectType | string;
  outputId: string;
  usageType?: 'citation' | 'inspiration' | 'evidence' | 'repurpose_source' | 'performance_learning' | string;
  confidence?: number | null;
}

export interface ContentOntologyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ContentOntologyValidationOptions {
  customObjectSchemas?: readonly ContentObjectSchema[];
  customFormatDefinitions?: readonly PlatformFormatDefinition[];
  customReferenceDefinitions?: readonly ReferenceSourceDefinition[];
  requireTenantScope?: boolean;
}

export const CONTENT_OBJECT_SCHEMAS: Record<ContentObjectType, ContentObjectSchema> = {
  idea: {
    objectType: 'idea',
    label: 'Idea',
    purpose: 'Raw creative possibility that may become a planned topic or output.',
    allowedLifecycleStates: ['captured', 'triaged', 'planned', 'rejected', 'archived'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['contentGoal'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  topic: {
    objectType: 'topic',
    label: 'Topic',
    purpose: 'Approved subject with planning, scheduling, and execution metadata.',
    allowedLifecycleStates: ['captured', 'planned', 'researching', 'outlining', 'drafting', 'scheduled', 'published', 'cancelled'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['contentGoal', 'audienceNeed'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  hook: {
    objectType: 'hook',
    label: 'Hook',
    purpose: 'Opening angle or first-beat promise for a specific audience and format.',
    allowedLifecycleStates: ['captured', 'triaged', 'reviewing', 'approved', 'rejected'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['targetEmotion', 'promise'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  outline: {
    objectType: 'outline',
    label: 'Outline',
    purpose: 'Sequenced argument, beats, or sections before writing.',
    allowedLifecycleStates: ['outlining', 'reviewing', 'approved', 'archived'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['sections', 'contentGoal'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  script: {
    objectType: 'script',
    label: 'Script',
    purpose: 'Production-ready spoken or written draft with claims, evidence, and source lineage.',
    allowedLifecycleStates: ['drafting', 'reviewing', 'approved', 'scheduled', 'published', 'repurposed', 'archived'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['contentGoal', 'voiceProfileId', 'productionIntent'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  caption: {
    objectType: 'caption',
    label: 'Caption',
    purpose: 'Platform caption, description, or supporting post copy.',
    allowedLifecycleStates: ['drafting', 'reviewing', 'approved', 'scheduled', 'published'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['cta', 'platformIntent'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  carousel: {
    objectType: 'carousel',
    label: 'Carousel',
    purpose: 'Slide-based content object with a hook, teaching path, and CTA.',
    allowedLifecycleStates: ['outlining', 'drafting', 'reviewing', 'approved', 'scheduled', 'published'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['slideCount', 'visualDirection'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  thread: {
    objectType: 'thread',
    label: 'Thread',
    purpose: 'Sequenced social text with claim/evidence flow.',
    allowedLifecycleStates: ['outlining', 'drafting', 'reviewing', 'approved', 'scheduled', 'published'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['threadPromise', 'postCount'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  newsletter: {
    objectType: 'newsletter',
    label: 'Newsletter',
    purpose: 'Email-native editorial output with subject, sections, and reader promise.',
    allowedLifecycleStates: ['outlining', 'drafting', 'reviewing', 'approved', 'scheduled', 'published'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['readerPromise', 'sectionPlan'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  blog: {
    objectType: 'blog',
    label: 'Blog',
    purpose: 'Searchable long-form written article.',
    allowedLifecycleStates: ['researching', 'outlining', 'drafting', 'reviewing', 'approved', 'scheduled', 'published'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['searchIntent', 'outline'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  video_concept: {
    objectType: 'video_concept',
    label: 'Video Concept',
    purpose: 'Video-native concept with promise, production ask, and packaging angle.',
    allowedLifecycleStates: ['captured', 'triaged', 'planned', 'researching', 'outlining', 'approved', 'scheduled'],
    requiredFields: ['title', 'tenantId', 'ownerUserId', 'formatId'],
    requiredMetadata: ['visualPremise', 'viewerPromise'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  radar_signal: {
    objectType: 'radar_signal',
    label: 'Radar Signal',
    purpose: 'Trend, audience pull, timely hook, or opportunity signal.',
    allowedLifecycleStates: ['captured', 'triaged', 'planned', 'archived', 'rejected'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['signalSource', 'whyNow'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: false,
  },
  reference: {
    objectType: 'reference',
    label: 'Reference',
    purpose: 'Source object that can ground or inspire outputs.',
    allowedLifecycleStates: ['captured', 'researching', 'approved', 'archived', 'rejected'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['sourceType', 'trustLevel', 'extractionStatus'],
    supportsPlatformFormat: false,
    supportsSourceAttribution: true,
    supportsReuseLineage: false,
  },
  content_calendar_item: {
    objectType: 'content_calendar_item',
    label: 'Content Calendar Item',
    purpose: 'Planned or scheduled execution object tied to date, platform, and stage.',
    allowedLifecycleStates: ['planned', 'scheduled', 'published', 'cancelled', 'archived'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['scheduledWindow', 'contentGoal'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  campaign: {
    objectType: 'campaign',
    label: 'Campaign',
    purpose: 'Coordinated sequence of content against a business or creator goal.',
    allowedLifecycleStates: ['planned', 'scheduled', 'published', 'archived', 'cancelled'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['campaignGoal', 'successMetric'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: false,
  },
  content_series: {
    objectType: 'content_series',
    label: 'Content Series',
    purpose: 'Recurring editorial container with cadence and format rules.',
    allowedLifecycleStates: ['planned', 'scheduled', 'published', 'archived', 'cancelled'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['cadence', 'seriesPromise'],
    supportsPlatformFormat: true,
    supportsSourceAttribution: true,
    supportsReuseLineage: true,
  },
  content_pillar: {
    objectType: 'content_pillar',
    label: 'Content Pillar',
    purpose: 'Strategic topic lane that controls consistency and novelty.',
    allowedLifecycleStates: ['planned', 'approved', 'archived'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['pillarPromise'],
    supportsPlatformFormat: false,
    supportsSourceAttribution: true,
    supportsReuseLineage: false,
  },
  audience_segment: {
    objectType: 'audience_segment',
    label: 'Audience Segment',
    purpose: 'Audience group with needs, objections, and desired outcomes.',
    allowedLifecycleStates: ['planned', 'approved', 'archived'],
    requiredFields: ['title', 'tenantId', 'ownerUserId'],
    requiredMetadata: ['audienceNeed', 'desiredOutcome'],
    supportsPlatformFormat: false,
    supportsSourceAttribution: false,
    supportsReuseLineage: false,
  },
};

// These format definitions retain stable taxonomy IDs for transport and stored
// objects. Their prose is candidate generation guidance, not a universal
// platform-performance policy. Timing, length, cadence, and count controls come
// from an explicit request or tenant format configuration; otherwise the model
// may propose a bounded scope only as a reviewable hypothesis.
export const PLATFORM_FORMATS: Record<ContentFormatId, PlatformFormatDefinition> = {
  youtube_long_form: {
    formatId: 'youtube_long_form',
    platforms: ['youtube'],
    label: 'YouTube Long Form',
    primaryObjectType: 'script',
    structure: ['cold_open', 'context', 'stakes', 'teaching_beats', 'proof', 'payoff', 'cta'],
    lengthExpectation: 'Use the explicit request or tenant duration/word budget; without one, keep runtime open and propose a bounded draft scope for review.',
    pacing: 'Derive pacing from the request, saved creator evidence, and production plan; any attention-reset pattern is a reviewable hypothesis.',
    hookStyle: ['open_loop', 'contrarian_promise', 'specific_problem'],
    productionRequirements: ['title_options', 'thumbnail_angle', 'b_roll_notes', 'source_attribution'],
    sourceUsagePattern: 'Use sources as evidence, frameworks, and examples; do not copy phrasing.',
    editingReviewNeeds: ['claim_check', 'retention_pass', 'voice_pass', 'source_pass'],
    requiredMetadata: ['viewerPromise', 'thumbnailAngle', 'productionIntent'],
    extensibleViaTenantConfig: true,
  },
  youtube_shorts: {
    formatId: 'youtube_shorts',
    platforms: ['youtube_shorts', 'youtube'],
    label: 'YouTube Shorts',
    primaryObjectType: 'script',
    structure: ['first_second_hook', 'one_point', 'example', 'payoff'],
    lengthExpectation: 'Use the explicit request or tenant runtime; without one, choose a bounded single-idea draft scope and label it as a review hypothesis.',
    pacing: 'Adapt opening, line, and setup density to the request and saved creator evidence; legacy first-second labels are compatibility names, not timing promises.',
    hookStyle: ['pattern_interrupt', 'one_sentence_problem', 'curiosity_gap'],
    productionRequirements: ['visual_beats', 'caption_safe_lines', 'single_take_or_fast_cut_plan'],
    sourceUsagePattern: 'Use one source-backed insight at most unless the short is a list.',
    editingReviewNeeds: ['first_second_check', 'caption_readability', 'no_overexplaining'],
    requiredMetadata: ['viewerPromise', 'visualBeatPlan'],
    extensibleViaTenantConfig: true,
  },
  instagram_reel: {
    formatId: 'instagram_reel',
    platforms: ['instagram'],
    label: 'Instagram Reel',
    primaryObjectType: 'script',
    structure: ['visual_hook', 'micro_story', 'takeaway', 'soft_cta'],
    lengthExpectation: 'Use the explicit request or tenant runtime; without one, choose a bounded draft scope and label it as a review hypothesis.',
    pacing: 'Choose pacing and visual density from the request and saved creator evidence; do not assume speed or save/share behavior improves performance.',
    hookStyle: ['relatable_tension', 'before_after', 'specific_result'],
    productionRequirements: ['on_screen_text', 'caption', 'saveable_takeaway'],
    sourceUsagePattern: 'Sources usually shape the takeaway or credibility line.',
    editingReviewNeeds: ['visual_fit', 'caption_fit', 'platform_native_tone'],
    requiredMetadata: ['visualBeatPlan', 'platformIntent'],
    extensibleViaTenantConfig: true,
  },
  tiktok: {
    formatId: 'tiktok',
    platforms: ['tiktok'],
    label: 'TikTok',
    primaryObjectType: 'script',
    structure: ['native_hook', 'tension', 'turn', 'payoff'],
    lengthExpectation: 'Use the explicit request or tenant runtime; without one, choose a bounded draft scope and label it as a review hypothesis.',
    pacing: 'Choose voice, pacing, and production polish from the request and saved creator evidence rather than a universal platform style.',
    hookStyle: ['direct_address', 'story_interruption', 'unexpected_truth'],
    productionRequirements: ['native_line_breaks', 'visual_context', 'retention_turn'],
    sourceUsagePattern: 'Translate sources into a native insight, not a citation-heavy monologue.',
    editingReviewNeeds: ['native_voice', 'retention_turn', 'no_generic_advice'],
    requiredMetadata: ['platformIntent', 'targetEmotion'],
    extensibleViaTenantConfig: true,
  },
  linkedin_post: {
    formatId: 'linkedin_post',
    platforms: ['linkedin'],
    label: 'LinkedIn Post',
    primaryObjectType: 'caption',
    structure: ['scroll_stop_line', 'context', 'insight', 'specific_example', 'discussion_prompt'],
    lengthExpectation: 'Use an explicit request or tenant word budget; otherwise choose a bounded draft scope and label it as a review hypothesis.',
    pacing: 'Choose paragraphing and line breaks for the supplied idea, request, and saved creator voice; the legacy scroll-stop label is not a performance promise.',
    hookStyle: ['workplace_tension', 'earned_lesson', 'specific_observation'],
    productionRequirements: ['professional_voice', 'claim_check', 'discussion_prompt'],
    sourceUsagePattern: 'Use sources to support a point without sounding academic.',
    editingReviewNeeds: ['credibility_pass', 'brevity_pass', 'comment_prompt_pass'],
    requiredMetadata: ['audienceNeed', 'professionalContext'],
    extensibleViaTenantConfig: true,
  },
  x_thread: {
    formatId: 'x_thread',
    platforms: ['x_twitter'],
    label: 'X/Twitter Thread',
    primaryObjectType: 'thread',
    structure: ['thread_hook', 'promise', 'numbered_beats', 'receipts', 'closing_prompt'],
    lengthExpectation: 'Use an explicit request or tenant post count; otherwise propose a bounded thread scope for review.',
    pacing: 'Make each included post coherent in sequence and derive continuation cues from the request; do not claim a universal retention effect.',
    hookStyle: ['strong_claim', 'specific_result', 'curiosity_gap'],
    productionRequirements: ['post_count', 'quote_safe_claims', 'source_receipts'],
    sourceUsagePattern: 'Map source claims to specific posts and cite or paraphrase carefully.',
    editingReviewNeeds: ['claim_density', 'thread_flow', 'quote_safety'],
    requiredMetadata: ['threadPromise', 'postCount'],
    extensibleViaTenantConfig: true,
  },
  newsletter: {
    formatId: 'newsletter',
    platforms: ['newsletter'],
    label: 'Newsletter',
    primaryObjectType: 'newsletter',
    structure: ['subject_line', 'opening_note', 'main_sections', 'reader_action', 'closing'],
    lengthExpectation: 'Use an explicit request or tenant word budget and cadence context; otherwise propose a bounded draft scope for review.',
    pacing: 'Derive sectioning and density from the request, saved editorial voice, and available source material.',
    hookStyle: ['reader_problem', 'curated_observation', 'timely_question'],
    productionRequirements: ['subject_options', 'section_plan', 'reader_action'],
    sourceUsagePattern: 'Curate and attribute sources clearly.',
    editingReviewNeeds: ['subject_pass', 'source_pass', 'skimmability_pass'],
    requiredMetadata: ['readerPromise', 'sectionPlan'],
    extensibleViaTenantConfig: true,
  },
  blog: {
    formatId: 'blog',
    platforms: ['blog'],
    label: 'Blog',
    primaryObjectType: 'blog',
    structure: ['search_intent_intro', 'argument', 'sections', 'examples', 'summary', 'next_step'],
    lengthExpectation: 'Use an explicit request or tenant word budget; otherwise propose a bounded draft scope for review.',
    pacing: 'Derive structure and density from search intent, supplied evidence, and the requested reader experience.',
    hookStyle: ['search_problem', 'specific_outcome', 'comparison'],
    productionRequirements: ['seo_title', 'meta_description', 'internal_links', 'source_attribution'],
    sourceUsagePattern: 'Sources support claims, examples, and comparative framing.',
    editingReviewNeeds: ['seo_pass', 'claim_check', 'source_pass', 'scanability_pass'],
    requiredMetadata: ['searchIntent', 'outline'],
    extensibleViaTenantConfig: true,
  },
  podcast_outline: {
    formatId: 'podcast_outline',
    platforms: ['podcast'],
    label: 'Podcast Outline',
    primaryObjectType: 'outline',
    structure: ['episode_promise', 'segments', 'questions', 'transitions', 'closing'],
    lengthExpectation: 'Use an explicit request or tenant episode runtime; otherwise keep segment timing open and propose a bounded outline scope for review.',
    pacing: 'Derive conversational arcs and segment density from the request, guest/topic evidence, and production context.',
    hookStyle: ['episode_question', 'guest_tension', 'timely_theme'],
    productionRequirements: ['segment_timing', 'question_bank', 'transition_notes'],
    sourceUsagePattern: 'Sources become prompts, examples, or fact checks.',
    editingReviewNeeds: ['flow_pass', 'question_quality', 'fact_check'],
    requiredMetadata: ['episodePromise', 'segmentPlan'],
    extensibleViaTenantConfig: true,
  },
  carousel: {
    formatId: 'carousel',
    platforms: ['instagram', 'linkedin'],
    label: 'Carousel',
    primaryObjectType: 'carousel',
    structure: ['cover_hook', 'slide_sequence', 'saveable_summary', 'cta'],
    lengthExpectation: 'Use an explicit request or tenant slide count; otherwise propose a bounded sequence for review.',
    pacing: 'Choose slide density and visual hierarchy from the requested teaching path, evidence, and design context.',
    hookStyle: ['save_this', 'mistake_list', 'framework'],
    productionRequirements: ['slide_count', 'visual_direction', 'design_notes'],
    sourceUsagePattern: 'Distill sources into frameworks or examples.',
    editingReviewNeeds: ['slide_density', 'visual_consistency', 'source_safety'],
    requiredMetadata: ['slideCount', 'visualDirection'],
    extensibleViaTenantConfig: true,
  },
  generic_script: {
    formatId: 'generic_script',
    platforms: ['generic'],
    label: 'Generic Script',
    primaryObjectType: 'script',
    structure: ['hook', 'setup', 'beats', 'payoff', 'cta'],
    lengthExpectation: 'Depends on requested channel and production context.',
    pacing: 'Use explicit production metadata rather than guessing.',
    hookStyle: ['specific_problem', 'story_tension', 'clear_promise'],
    productionRequirements: ['format_intent', 'voice_profile', 'review_pass'],
    sourceUsagePattern: 'Use authorized references only; cite or attribute where needed.',
    editingReviewNeeds: ['voice_pass', 'claim_check', 'format_fit'],
    requiredMetadata: ['productionIntent', 'voiceProfileId'],
    extensibleViaTenantConfig: true,
  },
  caption: {
    formatId: 'caption',
    platforms: ['instagram', 'tiktok', 'youtube', 'linkedin', 'x_twitter', 'generic'],
    label: 'Caption',
    primaryObjectType: 'caption',
    structure: ['context_line', 'supporting_copy', 'cta'],
    lengthExpectation: 'Use the explicit request, tenant format, and linked output; otherwise propose a bounded copy scope for review.',
    pacing: 'Derive tone, density, and next-action language from the request and saved creator voice rather than a universal caption pattern.',
    hookStyle: ['contextual_hook', 'benefit_line', 'question'],
    productionRequirements: ['cta', 'hashtags_or_keywords', 'linked_output'],
    sourceUsagePattern: 'Usually references the output rather than raw sources.',
    editingReviewNeeds: ['platform_fit', 'cta_clarity', 'duplication_check'],
    requiredMetadata: ['cta', 'platformIntent'],
    extensibleViaTenantConfig: true,
  },
};

export const REFERENCE_SOURCE_DEFINITIONS: Record<ContentSourceType, ReferenceSourceDefinition> = {
  book: {
    sourceType: 'book',
    label: 'Book',
    requiredMetadata: ['title', 'author', 'trustLevel', 'extractionStatus'],
    recommendedMetadata: ['coreThesis', 'keyFrameworks', 'topicTags'],
    freshnessPolicy: 'Stable source; freshness depends on extracted notes and user updates.',
    defaultTrustLevel: 'curated',
    supportsExtraction: true,
  },
  link: {
    sourceType: 'link',
    label: 'Link',
    requiredMetadata: ['url', 'trustLevel', 'extractionStatus'],
    recommendedMetadata: ['title', 'publisher', 'publishedAt', 'topicTags'],
    freshnessPolicy: 'Refresh when content changes, link ages, or extraction confidence drops.',
    defaultTrustLevel: 'unverified',
    supportsExtraction: true,
  },
  channel: {
    sourceType: 'channel',
    label: 'Channel',
    requiredMetadata: ['channelUrl', 'trustLevel', 'extractionStatus'],
    recommendedMetadata: ['channelName', 'topicTags', 'lastAnalyzedAt'],
    freshnessPolicy: 'Refresh on schedule or when reference channel uploads new relevant work.',
    defaultTrustLevel: 'observed',
    supportsExtraction: true,
  },
  note: {
    sourceType: 'note',
    label: 'Note',
    requiredMetadata: ['noteId', 'trustLevel'],
    recommendedMetadata: ['topicTags', 'createdAt'],
    freshnessPolicy: 'User-authored; stale only after user correction or topic drift.',
    defaultTrustLevel: 'first_party',
    supportsExtraction: false,
  },
  previous_content: {
    sourceType: 'previous_content',
    label: 'Previous Content',
    requiredMetadata: ['contentId', 'trustLevel'],
    recommendedMetadata: ['platform', 'performanceSummary', 'topicTags'],
    freshnessPolicy: 'Freshness depends on performance window and current strategy.',
    defaultTrustLevel: 'published',
    supportsExtraction: false,
  },
  radar_signal: {
    sourceType: 'radar_signal',
    label: 'Radar Signal',
    requiredMetadata: ['signalId', 'trustLevel', 'freshness'],
    recommendedMetadata: ['whyNow', 'topicTags'],
    freshnessPolicy: 'Short-lived; downgrade when the opportunity window closes.',
    defaultTrustLevel: 'observed',
    supportsExtraction: false,
  },
  external_research_result: {
    sourceType: 'external_research_result',
    label: 'External Research Result',
    requiredMetadata: ['urlOrQuery', 'trustLevel', 'extractionStatus'],
    recommendedMetadata: ['publisher', 'retrievedAt', 'topicTags'],
    freshnessPolicy: 'Time-sensitive; refresh before factual or trend claims.',
    defaultTrustLevel: 'unverified',
    supportsExtraction: true,
  },
  user_uploaded_source: {
    sourceType: 'user_uploaded_source',
    label: 'User Uploaded Source',
    requiredMetadata: ['fileId', 'trustLevel', 'extractionStatus'],
    recommendedMetadata: ['filename', 'topicTags', 'uploadPurpose'],
    freshnessPolicy: 'Stable unless user replaces or corrects the file.',
    defaultTrustLevel: 'first_party',
    supportsExtraction: true,
  },
};

export const CONTENT_STRATEGY_MODEL: ContentStrategyModel = {
  pillars: ['content_pillars'],
  audienceSegments: ['audience_segments'],
  voiceAttributes: ['tone', 'cadence', 'point_of_view', 'lexicon', 'prohibited_phrases', 'proof_style'],
  requiredStrategyMetadata: ['contentGoal', 'targetAudience', 'pillarId', 'voiceProfileId'],
  optionalStrategyMetadata: ['cadence', 'campaignId', 'seriesId', 'preferredFormats', 'dislikedFormats', 'platformPriorities', 'prohibitedTopics'],
};

function isPositiveId(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMetadataKey(metadata: Record<string, unknown> | null | undefined, key: string): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const value = metadata[key];
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function scoreInRange(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function buildObjectSchemaMap(customSchemas?: readonly ContentObjectSchema[]): Map<string, ContentObjectSchema> {
  const map = new Map<string, ContentObjectSchema>();
  for (const schema of Object.values(CONTENT_OBJECT_SCHEMAS)) {
    map.set(schema.objectType, schema);
  }
  for (const schema of customSchemas ?? []) {
    map.set(schema.objectType, schema);
  }
  return map;
}

function buildFormatMap(customFormats?: readonly PlatformFormatDefinition[]): Map<string, PlatformFormatDefinition> {
  const map = new Map<string, PlatformFormatDefinition>();
  for (const definition of Object.values(PLATFORM_FORMATS)) {
    map.set(definition.formatId, definition);
  }
  for (const definition of customFormats ?? []) {
    map.set(definition.formatId, definition);
  }
  return map;
}

function buildReferenceMap(customReferences?: readonly ReferenceSourceDefinition[]): Map<string, ReferenceSourceDefinition> {
  const map = new Map<string, ReferenceSourceDefinition>();
  for (const definition of Object.values(REFERENCE_SOURCE_DEFINITIONS)) {
    map.set(definition.sourceType, definition);
  }
  for (const definition of customReferences ?? []) {
    map.set(definition.sourceType, definition);
  }
  return map;
}

export function listContentObjectSchemas(): ContentObjectSchema[] {
  return Object.values(CONTENT_OBJECT_SCHEMAS);
}

export function listPlatformFormatDefinitions(): PlatformFormatDefinition[] {
  return Object.values(PLATFORM_FORMATS);
}

export function listReferenceSourceDefinitions(): ReferenceSourceDefinition[] {
  return Object.values(REFERENCE_SOURCE_DEFINITIONS);
}

export function getPlatformFormatDefinition(
  formatId: string,
  customFormats?: readonly PlatformFormatDefinition[],
): PlatformFormatDefinition | null {
  return buildFormatMap(customFormats).get(formatId) ?? null;
}

export function validatePlatformFormatDefinition(
  definition: PlatformFormatDefinition,
): ContentOntologyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!hasText(definition.formatId)) errors.push('formatId is required');
  if (!hasText(definition.label)) errors.push('label is required');
  if (definition.platforms.length === 0) errors.push('at least one platform is required');
  if (definition.structure.length === 0) errors.push('structure is required');
  if (!hasText(definition.lengthExpectation)) errors.push('lengthExpectation is required');
  if (!hasText(definition.pacing)) errors.push('pacing is required');
  if (definition.hookStyle.length === 0) warnings.push('hookStyle is empty');
  if (definition.productionRequirements.length === 0) errors.push('productionRequirements are required');
  if (!hasText(definition.sourceUsagePattern)) errors.push('sourceUsagePattern is required');
  if (definition.editingReviewNeeds.length === 0) errors.push('editingReviewNeeds are required');
  if (definition.requiredMetadata.length === 0) warnings.push('requiredMetadata is empty; generation readiness may be weak');

  return { valid: errors.length === 0, errors, warnings };
}

export function validateReferenceMetadata(
  reference: ContentReferenceMetadata,
  options: ContentOntologyValidationOptions = {},
): ContentOntologyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const definitions = buildReferenceMap(options.customReferenceDefinitions);
  const definition = definitions.get(reference.sourceType);
  const visibilityScope = reference.visibilityScope ?? 'user_private';

  if (!definition) {
    errors.push(`unknown sourceType: ${reference.sourceType}`);
  }
  if (options.requireTenantScope !== false) {
    if (!isPositiveId(reference.tenantId)) errors.push('tenantId is required for reference metadata');
    if (visibilityScope === 'user_private' && !isPositiveId(reference.ownerUserId)) {
      errors.push('ownerUserId is required for user-private references');
    }
  }
  if (!scoreInRange(reference.freshness)) warnings.push('freshness should be a number between 0 and 1');
  if (!scoreInRange(reference.confidence)) errors.push('confidence is required and must be between 0 and 1');
  if (!reference.trustLevel || !CONTENT_TRUST_LEVELS.includes(reference.trustLevel as ContentTrustLevel)) {
    errors.push('trustLevel is required and must be known');
  }
  if (!reference.extractionStatus || !CONTENT_EXTRACTION_STATUSES.includes(reference.extractionStatus as ContentExtractionStatus)) {
    errors.push('extractionStatus is required and must be known');
  }
  if (reference.extractionStatus === 'failed' || reference.extractionStatus === 'quarantined') {
    warnings.push(`reference extractionStatus is ${reference.extractionStatus}`);
  }
  if (!reference.topicTags || reference.topicTags.length === 0) {
    warnings.push('topicTags are recommended for retrieval and novelty checks');
  }

  for (const key of definition?.requiredMetadata ?? []) {
    if (!hasMetadataKey(reference.metadata, key)) {
      errors.push(`missing reference metadata: ${key}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateContentDomainObject(
  object: ContentDomainObjectInput,
  options: ContentOntologyValidationOptions = {},
): ContentOntologyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const schemas = buildObjectSchemaMap(options.customObjectSchemas);
  const formats = buildFormatMap(options.customFormatDefinitions);
  const schema = schemas.get(object.objectType);
  const lifecycleState = object.lifecycleState ?? 'captured';
  const visibilityScope = object.visibilityScope ?? 'user_private';
  const metadata = object.metadata ?? {};

  if (!schema) {
    errors.push(`unknown content object type: ${object.objectType}`);
  }
  if (options.requireTenantScope !== false) {
    if (!isPositiveId(object.tenantId)) errors.push('tenantId is required');
    if (visibilityScope === 'user_private' && !isPositiveId(object.ownerUserId)) {
      errors.push('ownerUserId is required for user-private content objects');
    }
  }
  if (schema && !schema.allowedLifecycleStates.includes(lifecycleState)) {
    errors.push(`invalid lifecycleState "${lifecycleState}" for ${schema.objectType}`);
  }
  for (const field of schema?.requiredFields ?? []) {
    if (field === 'title' && !hasText(object.title)) errors.push('title is required');
    if (field === 'tenantId' && !isPositiveId(object.tenantId)) errors.push('tenantId is required');
    if (field === 'ownerUserId' && visibilityScope === 'user_private' && !isPositiveId(object.ownerUserId)) {
      errors.push('ownerUserId is required');
    }
    if (field === 'formatId' && !hasText(object.formatId)) errors.push('formatId is required');
  }
  for (const key of schema?.requiredMetadata ?? []) {
    if (!hasMetadataKey(metadata, key)) {
      errors.push(`missing object metadata: ${key}`);
    }
  }

  const format = object.formatId ? formats.get(object.formatId) : null;
  if (object.formatId && !format) {
    errors.push(`unknown content format: ${object.formatId}`);
  }
  if (format) {
    if (object.platformId && !format.platforms.includes(object.platformId)) {
      errors.push(`format ${format.formatId} does not support platform ${object.platformId}`);
    }
    for (const key of format.requiredMetadata) {
      if (!hasMetadataKey(metadata, key)) {
        errors.push(`missing format metadata: ${key}`);
      }
    }
  }
  if (schema?.supportsSourceAttribution && object.sourceReferences) {
    for (const [index, reference] of object.sourceReferences.entries()) {
      const result = validateReferenceMetadata(reference, options);
      errors.push(...result.errors.map((error) => `sourceReferences[${index}]: ${error}`));
      warnings.push(...result.warnings.map((warning) => `sourceReferences[${index}]: ${warning}`));
    }
  }
  if (object.claims && object.claims.some((claim) => !hasText(claim.id) || !hasText(claim.text))) {
    errors.push('claims must include id and text');
  }
  if (object.evidence && object.evidence.some((evidence) => !hasText(evidence.id) || !hasText(evidence.sourceId) || !hasText(evidence.summary))) {
    errors.push('evidence must include id, sourceId, and summary');
  }
  if (schema?.supportsReuseLineage && object.repurposeParentId && object.reuseOfObjectId) {
    warnings.push('object has both repurposeParentId and reuseOfObjectId; verify lineage semantics');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateGenerationReadiness(
  object: ContentDomainObjectInput,
  options: ContentOntologyValidationOptions = {},
): ContentOntologyValidationResult {
  const base = validateContentDomainObject(object, options);
  const errors = [...base.errors];
  const warnings = [...base.warnings];
  const generationTypes = new Set<string>(['hook', 'outline', 'script', 'caption', 'carousel', 'thread', 'newsletter', 'blog', 'video_concept']);

  if (generationTypes.has(object.objectType)) {
    if (!object.pillarIds || object.pillarIds.length === 0) {
      errors.push('at least one content pillar is required for generation');
    }
    if (!object.audienceSegmentIds || object.audienceSegmentIds.length === 0) {
      errors.push('at least one audience segment is required for generation');
    }
    if (!object.sourceReferences || object.sourceReferences.length === 0) {
      warnings.push('no sourceReferences supplied; generation will be less grounded');
    }
    if (!hasMetadataKey(object.metadata, 'contentGoal')) {
      errors.push('contentGoal is required for generation');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateSourceOutputLink(
  link: ContentSourceOutputLinkInput,
): ContentOntologyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const visibilityScope = link.visibilityScope ?? 'user_private';

  if (!isPositiveId(link.tenantId)) errors.push('tenantId is required');
  if (visibilityScope === 'user_private' && !isPositiveId(link.ownerUserId)) {
    errors.push('ownerUserId is required for user-private source-output links');
  }
  if (!CONTENT_SOURCE_TYPES.includes(link.sourceType as ContentSourceType)) {
    errors.push(`unknown sourceType: ${link.sourceType}`);
  }
  if (!CONTENT_OBJECT_TYPES.includes(link.outputObjectType as ContentObjectType)) {
    errors.push(`unknown outputObjectType: ${link.outputObjectType}`);
  }
  if (!hasText(link.sourceId)) errors.push('sourceId is required');
  if (!hasText(link.outputId)) errors.push('outputId is required');
  if (link.confidence != null && !scoreInRange(link.confidence)) {
    errors.push('confidence must be between 0 and 1');
  }
  if (!hasText(link.usageType)) warnings.push('usageType is recommended for reuse and attribution logic');

  return { valid: errors.length === 0, errors, warnings };
}
