// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentArtifact,
  getContentWorkspaceItem,
  transitionContentWorkspaceItem,
  type ContentArtifact,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from './content-workspace';
import {
  getContentAgencyRulesByCategory,
  listContentAgencyRules,
  validateContentAgencyRuleCoverage,
  validateContentAgencyRuntimeRuleCoverage,
} from './content-agency-rules';
import { assertContentWorkspaceWriteEnabled } from './content-workspace-capabilities';

/**
 * Bump this contract whenever package-generation rules or serialized output
 * can change for the same material inputs. It is part of package identity,
 * so old immutable packages never collide with a newer generator contract.
 */
export const CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION = 'content-agency-package.v3';

export type ContentAgencyPlatform =
  | 'youtube'
  | 'youtube_shorts'
  | 'tiktok'
  | 'instagram_reel'
  | 'carousel'
  | 'blog'
  | 'newsletter'
  | 'generic';

export type ContentAgencyVisibilityScope = 'user_private' | 'tenant_shared' | 'platform_internal';

const CONTENT_AGENCY_MAX_TEXT_CHARS = 600;
const CONTENT_AGENCY_MAX_TRANSCRIPT_CHARS = 50_000;
const CONTENT_AGENCY_MAX_COMPETITORS = 12;
const CONTENT_AGENCY_MAX_LIST_ITEMS = 20;
const CONTENT_AGENCY_MAX_METRICS = 32;
const CONTENT_AGENCY_MAX_ARTIFACT_ID_CHARS = 200;
const CONTENT_AGENCY_ALLOWED_VISIBILITY_SCOPES = new Set<ContentAgencyVisibilityScope>([
  'user_private',
  'tenant_shared',
  'platform_internal',
]);
const CONTENT_AGENCY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNSUPPORTED_CONTENT_AGENCY_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

export class ContentAgencyValidationError extends TypeError {
  readonly code = 'CONTENT_AGENCY_VALIDATION_FAILED';
  readonly status = 400;

  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = 'ContentAgencyValidationError';
  }
}

export class ContentAgencyIntegrityError extends Error {
  readonly code = 'CONTENT_AGENCY_INTEGRITY_FAILED';
  readonly status = 409;

  constructor(message = 'The Content Agency artifact could not be verified.') {
    super(message);
    this.name = 'ContentAgencyIntegrityError';
  }
}

export class ContentAgencyPackageVersionError extends Error {
  readonly code = 'CONTENT_AGENCY_PACKAGE_VERSION_UNSUPPORTED';
  readonly status = 409;

  constructor() {
    super('This Content Agency package version is not supported by the current workflow.');
    this.name = 'ContentAgencyPackageVersionError';
  }
}

export interface ContentAgencyBriefInput {
  userId: number;
  tenantId: number;
  visibilityScope?: ContentAgencyVisibilityScope;
  goal?: string | null;
  audience?: string | null;
  offer?: string | null;
  platform?: string | null;
  format?: string | null;
  objective?: string | null;
  constraints?: string[] | null;
  currentMetrics?: Record<string, unknown> | null;
  brandVoice?: string | null;
  notes?: string | null;
}

export interface ContentAgencyBrief {
  id: string;
  tenantId: number;
  userId: number;
  visibilityScope: ContentAgencyVisibilityScope;
  goal: string;
  audience: string;
  offer: string | null;
  platform: ContentAgencyPlatform;
  format: string;
  objective: string;
  constraints: string[];
  currentMetrics: Record<string, unknown>;
  brandVoice: string | null;
  missingFacts: string[];
  confidence: number;
  sourceTrace: string[];
  nextBestActions: string[];
}

export interface ContentAgencyCompetitorInput {
  userId: number;
  tenantId: number;
  brief?: ContentAgencyBriefInput | ContentAgencyBrief | null;
  competitors?: Array<{
    title?: string | null;
    creator?: string | null;
    platform?: string | null;
    transcript?: string | null;
    metrics?: Record<string, unknown> | null;
    url?: string | null;
  }> | null;
}

export interface ContentAgencyCompetitorPatternStudy {
  id: string;
  tenantId: number;
  userId: number;
  patterns: string[];
  hookMechanisms: string[];
  emotionalDrivers: string[];
  pacingPatterns: string[];
  originalityConstraints: string[];
  opportunityGaps: string[];
  sourceTrace: string[];
  warnings: string[];
}

export interface ContentAgencyTranscriptStudy {
  id: string;
  tenantId: number;
  userId: number;
  structure: string[];
  emotionalBeats: string[];
  proofMoments: string[];
  retentionDevices: string[];
  ctaDiagnosis: string;
  sourceTrace: string[];
  warnings: string[];
}

export interface ContentAgencyHook {
  mechanism: string;
  hook: string;
  whyItWorks: string;
  risk: string | null;
}

export interface ContentAgencyScriptVariant {
  id: string;
  title: string;
  coldOpen: string;
  promise: string;
  beats: string[];
  payoff: string;
  cta: string;
  retentionDevices: string[];
  originalityNote: string;
}

export interface ContentAgencyCreativeDirection {
  firstFrame: string;
  shotList: string[];
  broll: string[];
  captions: string[];
  soundDirection: string;
  editingPlan: string[];
  productionComplexity: 'low' | 'medium' | 'high';
}

export interface ContentAgencyComplianceReview {
  status: 'pass' | 'warning' | 'blocked';
  blockers: string[];
  warnings: string[];
  disclosureRequired: boolean;
  copyrightRisk: 'low' | 'medium' | 'high';
  originalityRisk: 'low' | 'medium' | 'high';
  notes: string[];
}

export interface ContentAgencyExperimentPlan {
  hypothesis: string;
  variables: string[];
  primaryMetric: string;
  secondaryMetrics: string[];
  interpretation: string[];
}

export interface ContentAgencyPerformanceDiagnosis {
  summary: string;
  likelyBottleneck: string;
  evidence: string[];
  recommendedTest: string;
  metricsToWatch: string[];
  uncertainty: string;
}

export interface ContentAgencyQualityResult {
  score: number;
  status: 'pass' | 'warning' | 'blocked';
  blockers: string[];
  warnings: string[];
  dimensions: Record<string, number>;
}

export interface ContentAgencyCriticalUserReview {
  canExtractNextStep: boolean;
  canExplainWhy: boolean;
  seesEvidence: boolean;
  seesOriginality: boolean;
  seesRisks: boolean;
  rejectsAsGeneric: boolean;
  issues: string[];
}

export interface ContentAgencyPackageInput {
  userId: number;
  tenantId: number;
  brief?: ContentAgencyBriefInput | ContentAgencyBrief | null;
  competitors?: ContentAgencyCompetitorInput['competitors'];
  transcript?: string | null;
  brandedContent?: boolean | null;
  references?: string[] | null;
  requestedOutput?: 'brief' | 'script' | 'rewrite' | null;
}

export interface ContentAgencyPackageBuildOptions {
  generatorContractVersion?: string;
}

export interface ContentAgencyPackage {
  id: string;
  contentHash: string;
  generatorContractVersion: string;
  tenantId: number;
  userId: number;
  visibilityScope: ContentAgencyVisibilityScope;
  platform: ContentAgencyPlatform;
  format: string;
  objective: string;
  brief: ContentAgencyBrief;
  audienceInsight: string;
  positioning: {
    category: string;
    strategicEnemy: string;
    promise: string;
    proofLibrary: string[];
    brandVoice: string;
  };
  competitorStudy: ContentAgencyCompetitorPatternStudy;
  transcriptStudy: ContentAgencyTranscriptStudy;
  hookBank: ContentAgencyHook[];
  scriptVariants: ContentAgencyScriptVariant[];
  creativeDirection: ContentAgencyCreativeDirection;
  complianceReview: ContentAgencyComplianceReview;
  experimentPlan: ContentAgencyExperimentPlan;
  performanceDiagnosis: ContentAgencyPerformanceDiagnosis;
  quality: ContentAgencyQualityResult;
  criticalUserReview: ContentAgencyCriticalUserReview;
  sourceTrace: string[];
  referenceIds: string[];
  confidence: number;
  warnings: string[];
  blockers: string[];
  reviewRequired: boolean;
  nextBestActions: string[];
  createdAt: string;
}

export interface ContentAgencyWorkspaceHandoffResult {
  packageId: string;
  packageHash: string | null;
  status: 'created' | 'already_exists' | 'blocked' | 'not_found';
  /** True only when this call changed the canonical workspace projection. */
  changed: boolean;
  /**
   * Deprecated response alias retained for old REST/chat clients. It is the
   * canonical workspace item ID; migration 246 creates no content_pipeline
   * row. Remove after compatibility telemetry is zero for the agreed window.
   */
  pipelineId: number | null;
  workspaceItemId: number | null;
  workspaceArtifactId: number | null;
  workspaceRevisionId: number | null;
  persistence: 'content_workspace';
  blockers: string[];
  warnings: string[];
  nextBestActions: string[];
  sourceTrace: string[];
}

export interface ContentAgencyPackagePersistenceResult {
  package: ContentAgencyPackage;
  created: boolean;
}

interface ContentAgencyArtifactPersistenceResult {
  id: number | null;
  created: boolean;
}

type PersistKind =
  | 'brief'
  | 'competitor_study'
  | 'transcript_study'
  | 'package'
  | 'compliance_review'
  | 'experiment_run'
  | 'quality_review';

const RAW_ARTIFACT_PATTERNS = [
  /\bCOACH_RECS_START\b/i,
  /\bPROMPT\b/i,
  /\bSYSTEM:\b/i,
  /\bINTERNAL_ID\b/i,
  /\bviral guarantee\b/i,
  /\bguaranteed to go viral\b/i,
  /```json/i,
  /{\s*"[^"]+"\s*:/,
];

const PROMPT_INJECTION_PATTERNS = [
  /ignore (?:the |all |previous |above )*instructions/i,
  /disregard (the|all|previous|above)/i,
  /you are now/i,
  /<\|im_start\|>/i,
  /<system>/i,
];

export function normalizeAgencyPlatform(value?: string | null): ContentAgencyPlatform {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new ContentAgencyValidationError('platform must be a string.', 'platform');
  }
  const raw = (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return 'generic';
  if (raw.includes('short')) return 'youtube_shorts';
  if (raw.includes('youtube')) return 'youtube';
  if (raw.includes('tiktok')) return 'tiktok';
  if (raw.includes('reel') || raw.includes('instagram')) return 'instagram_reel';
  if (raw.includes('carousel')) return 'carousel';
  if (raw.includes('blog')) return 'blog';
  if (raw.includes('newsletter')) return 'newsletter';
  return 'generic';
}

export function buildContentAgencyBrief(input: ContentAgencyBriefInput): ContentAgencyBrief {
  const normalized = normalizeBriefInput(input);
  const platform = normalizeAgencyPlatform(normalized.platform ?? normalized.format);
  const format = normalizeAgencyFormat(normalized.format, platform);
  const goal = cleanText(normalized.goal, 'Clarify the creator goal');
  const audience = cleanText(normalized.audience, 'Define the target audience');
  const objective = cleanText(normalized.objective, goal !== 'Clarify the creator goal' ? goal : 'Build a useful content package');
  const missingFacts = [
    goal === 'Clarify the creator goal' ? 'goal' : null,
    audience === 'Define the target audience' ? 'audience' : null,
    platform === 'generic' ? 'platform' : null,
    !normalized.offer ? 'offer_or_call_to_action' : null,
  ].filter(Boolean) as string[];
  const sourceTrace = [
    normalized.goal || normalized.audience || normalized.offer || normalized.objective || normalized.notes
      ? 'user_supplied_brief'
      : null,
    normalized.brandVoice ? 'user_supplied_brand_voice' : null,
    normalized.constraints.length > 0 ? 'user_supplied_constraints' : null,
    Object.keys(normalized.currentMetrics).length > 0 ? 'user_supplied_current_metrics' : null,
    normalized.platform || normalized.format ? 'user_selected_platform_or_format' : null,
  ].filter((entry): entry is string => entry !== null);
  const confidence = Math.max(0.35, Math.min(0.92, 0.9 - missingFacts.length * 0.12));

  return {
    id: stableId('brief', normalized.tenantId, normalized.userId, {
      visibilityScope: normalized.visibilityScope,
      goal,
      audience,
      offer: normalized.offer,
      platform,
      format,
      objective,
      constraints: normalized.constraints,
      currentMetrics: normalized.currentMetrics,
      brandVoice: normalized.brandVoice,
    }),
    tenantId: normalized.tenantId,
    userId: normalized.userId,
    visibilityScope: normalized.visibilityScope,
    goal,
    audience,
    offer: normalized.offer,
    platform,
    format,
    objective,
    constraints: normalized.constraints,
    currentMetrics: normalized.currentMetrics,
    brandVoice: normalized.brandVoice,
    missingFacts,
    confidence,
    sourceTrace,
    nextBestActions: missingFacts.length > 0
      ? missingFacts.map((fact) => `Add ${fact.replace(/_/g, ' ')} before requesting final creative.`)
      : ['Generate an agency package and review compliance/originality before moving to pipeline.'],
  };
}

export function buildContentAgencyCompetitorStudy(input: ContentAgencyCompetitorInput): ContentAgencyCompetitorPatternStudy {
  const scope = normalizeAgencyScope(input, 'competitorStudy');
  const competitors = normalizeCompetitors(input.competitors, 'competitors');
  const brief = input.brief == null
    ? null
    : buildContentAgencyBrief({
      ...(requireRecord(input.brief, 'brief') as unknown as ContentAgencyBriefInput),
      userId: scope.userId,
      tenantId: scope.tenantId,
    });
  const transcriptText = competitors.map((item) => item.transcript ?? '').join('\n');
  const warnings = [];
  if (competitors.length === 0) warnings.push('competitor_context_missing');
  if (competitors.some((item) => (
    Boolean(item.url || item.title)
    && !item.transcript
    && (!item.metrics || Object.keys(item.metrics).length === 0)
  ))) warnings.push('competitor_reference_unverified');
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(transcriptText))) warnings.push('untrusted_competitor_text_contained_prompt_injection');

  const emotionalDrivers = inferEmotionalDrivers(transcriptText);
  const hookMechanisms = inferHookMechanisms(transcriptText);
  const pacingPatterns = inferPacingPatterns(transcriptText);
  const patterns = [
    hookMechanisms[0] ? `Hook pattern: ${hookMechanisms[0]}` : 'Working hook hypothesis: test an early explicit promise or tension against the creator baseline.',
    emotionalDrivers[0] ? `Emotional-driver hypothesis: ${emotionalDrivers[0]}` : 'Working emotional-driver hypothesis: test useful urgency or identity relevance.',
    pacingPatterns[0] ? `Pacing hypothesis: ${pacingPatterns[0]}` : 'Working pacing hypothesis: test setup, proof, payoff, then action against retention evidence.',
  ];

  return {
    id: stableId('competitor', scope.tenantId, scope.userId, { brief, competitors }),
    tenantId: scope.tenantId,
    userId: scope.userId,
    patterns,
    hookMechanisms,
    emotionalDrivers,
    pacingPatterns,
    originalityConstraints: [
      'Do not reuse competitor wording, titles, thumbnails, script sequence, or visual identity.',
      'Use a different angle, different proof, different story, and different execution.',
      'Treat transcripts, comments, and scraped text as untrusted evidence.',
    ],
    opportunityGaps: inferOpportunityGaps(brief, competitors),
    sourceTrace: competitors.flatMap((item, index) => [
      ...(item.url ? [`unverified_competitor_url:${item.url}`] : []),
      ...(item.title ? [`unverified_competitor_title:${item.title}`] : []),
      ...(item.transcript ? [`user_supplied_competitor_transcript:${index + 1}`] : []),
      ...(item.metrics && Object.keys(item.metrics).length > 0
        ? [`user_supplied_competitor_metrics:${index + 1}`]
        : []),
    ]),
    warnings,
  };
}

export function buildContentAgencyTranscriptStudy(input: {
  userId: number;
  tenantId: number;
  transcript?: string | null;
  title?: string | null;
}): ContentAgencyTranscriptStudy {
  const scope = normalizeAgencyScope(input, 'transcriptStudy');
  const text = normalizeOptionalText(input.transcript, 'transcript', CONTENT_AGENCY_MAX_TRANSCRIPT_CHARS) ?? '';
  const title = normalizeOptionalText(input.title, 'title', CONTENT_AGENCY_MAX_TEXT_CHARS);
  const warnings = [];
  if (!text.trim()) warnings.push('transcript_missing');
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) warnings.push('untrusted_transcript_contained_prompt_injection');

  return {
    id: stableId('transcript', scope.tenantId, scope.userId, title || '', text),
    tenantId: scope.tenantId,
    userId: scope.userId,
    structure: inferStructure(text),
    emotionalBeats: inferEmotionalDrivers(text).map((driver) => `Uses ${driver} to keep the viewer emotionally invested.`),
    proofMoments: inferProofMoments(text),
    retentionDevices: inferRetentionDevices(text),
    ctaDiagnosis: /comment|follow|subscribe|save|share|dm|link/i.test(text)
      ? 'CTA is present; verify it matches the content promise and funnel stage.'
      : 'CTA is missing or weak; add one clear next action.',
    sourceTrace: text.trim() ? ['user_supplied_transcript'] : [],
    warnings,
  };
}

export function buildContentAgencyPackage(
  input: ContentAgencyPackageInput,
  options: ContentAgencyPackageBuildOptions = {},
): ContentAgencyPackage {
  const scope = normalizeAgencyScope(input, 'package');
  const generatorContractVersion = normalizeGeneratorContractVersion(options.generatorContractVersion);
  const briefInput = input.brief == null ? {} : requireRecord(input.brief, 'brief');
  const brief = buildContentAgencyBrief({
    ...(briefInput as unknown as ContentAgencyBriefInput),
    userId: scope.userId,
    tenantId: scope.tenantId,
  });
  const competitors = normalizeCompetitors(input.competitors, 'competitors');
  const transcript = normalizeOptionalText(input.transcript, 'transcript', CONTENT_AGENCY_MAX_TRANSCRIPT_CHARS);
  const references = normalizeStringList(input.references, 'references', CONTENT_AGENCY_MAX_LIST_ITEMS, CONTENT_AGENCY_MAX_TEXT_CHARS);
  const requestedOutput = normalizeOptionalText(input.requestedOutput, 'requestedOutput', CONTENT_AGENCY_MAX_TEXT_CHARS);
  if (requestedOutput != null && !['brief', 'script', 'rewrite'].includes(requestedOutput)) {
    throw new ContentAgencyValidationError(
      'requestedOutput must be one of: brief, script, rewrite.',
      'requestedOutput',
    );
  }
  if (input.brandedContent !== undefined && input.brandedContent !== null && typeof input.brandedContent !== 'boolean') {
    throw new ContentAgencyValidationError('brandedContent must be a boolean.', 'brandedContent');
  }
  const competitorStudy = buildContentAgencyCompetitorStudy({
    userId: scope.userId,
    tenantId: scope.tenantId,
    brief,
    competitors,
  });
  const transcriptStudy = buildContentAgencyTranscriptStudy({
    userId: scope.userId,
    tenantId: scope.tenantId,
    transcript: transcript ?? competitors[0]?.transcript ?? '',
    title: competitors[0]?.title ?? brief.goal,
  });
  const referenceIds = references;
  const hookBank = buildHookBank(brief, competitorStudy);
  const scriptVariants = buildScriptVariants(brief, hookBank, competitorStudy);
  const creativeDirection = buildCreativeDirection(brief);
  const complianceReview = buildComplianceReview({
    brandedContent: input.brandedContent === true,
    outputText: flattenPackageText({ hookBank, scriptVariants, creativeDirection }),
    untrustedSourceText: [
      brief.goal,
      brief.audience,
      brief.offer ?? '',
      brief.objective,
      brief.brandVoice ?? '',
      ...brief.constraints,
      transcript ?? '',
      ...competitors.flatMap((item) => [item.title ?? '', item.transcript ?? '']),
    ].join('\n'),
    warnings: [...competitorStudy.warnings, ...transcriptStudy.warnings],
  });
  const experimentPlan = buildExperimentPlan(brief);
  const performanceDiagnosis = buildPerformanceDiagnosis(brief);
  const sourceTrace = [
    ...brief.sourceTrace,
    ...competitorStudy.sourceTrace,
    ...transcriptStudy.sourceTrace,
    ...referenceIds.map((referenceId) => `user_reference:${referenceId}`),
    ...matchedRuleIds(brief),
  ];
  const quality = evaluateContentAgencyPackage({
    brief,
    competitorStudy,
    transcriptStudy,
    hookBank,
    scriptVariants,
    creativeDirection,
    complianceReview,
    sourceTrace,
  });
  const criticalUserReview = buildCriticalUserReview({
    brief,
    quality,
    competitorStudy,
    transcriptStudy,
    hooks: hookBank,
    scripts: scriptVariants,
    complianceReview,
  });
  const blockers = [...new Set([...quality.blockers, ...complianceReview.blockers])];
  const warnings = [...new Set([
    ...quality.warnings,
    ...complianceReview.warnings,
    ...brief.missingFacts.map((fact) => `missing_${fact}`),
    ...competitorStudy.warnings,
    ...transcriptStudy.warnings,
  ])];
  const nextBestActions = blockers.length > 0
    ? blockers.map((blocker) => `Resolve blocker: ${humanize(blocker)}.`)
    : [
      `Film or draft variant "${scriptVariants[0]?.title ?? 'Agency Variant A'}" first.`,
      `Track ${experimentPlan.primaryMetric} and review ${experimentPlan.secondaryMetrics.join(', ')} after publishing.`,
      'Run the compliance/originality review again before approval if sponsor, claims, or competitor references change.',
    ];

  const packageId = stableId('package', scope.tenantId, scope.userId, {
    generatorContractVersion,
    brief: {
      goal: brief.goal,
      audience: brief.audience,
      offer: brief.offer,
      platform: brief.platform,
      format: brief.format,
      objective: brief.objective,
      constraints: brief.constraints,
      currentMetrics: brief.currentMetrics,
      brandVoice: brief.brandVoice,
      visibilityScope: brief.visibilityScope,
    },
    competitors,
    transcript: transcript ?? '',
    brandedContent: input.brandedContent === true,
    references: referenceIds,
    requestedOutput,
  });
  const packageWithoutHash: Omit<ContentAgencyPackage, 'contentHash'> = {
    id: packageId,
    generatorContractVersion,
    tenantId: scope.tenantId,
    userId: scope.userId,
    visibilityScope: brief.visibilityScope,
    platform: brief.platform,
    format: brief.format,
    objective: brief.objective,
    brief,
    audienceInsight: buildAudienceInsight(brief),
    positioning: buildPositioning(brief),
    competitorStudy,
    transcriptStudy,
    hookBank,
    scriptVariants,
    creativeDirection,
    complianceReview,
    experimentPlan,
    performanceDiagnosis,
    quality,
    criticalUserReview,
    // Keep the persisted package inside the closed 64-entry contract even
    // when the caller supplies the maximum competitors and references. The
    // ordering preserves brief and concrete competitor evidence before
    // lower-priority rule annotations.
    sourceTrace: [...new Set(sourceTrace)].slice(0, 64),
    referenceIds,
    confidence: Math.max(0.35, Math.min(0.95, (brief.confidence + quality.score / 100) / 2)),
    warnings,
    blockers,
    reviewRequired: blockers.length > 0 || warnings.length > 0 || complianceReview.status !== 'pass',
    nextBestActions,
    createdAt: new Date().toISOString(),
  };
  return {
    ...packageWithoutHash,
    contentHash: computeContentAgencyArtifactHash(packageWithoutHash),
  };
}

export function evaluateContentAgencyPackage(input: {
  brief: ContentAgencyBrief;
  competitorStudy: ContentAgencyCompetitorPatternStudy;
  transcriptStudy: ContentAgencyTranscriptStudy;
  hookBank: ContentAgencyHook[];
  scriptVariants: ContentAgencyScriptVariant[];
  creativeDirection: ContentAgencyCreativeDirection;
  complianceReview: ContentAgencyComplianceReview;
  sourceTrace: string[];
}): ContentAgencyQualityResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const hasCurrentMetrics = Object.keys(input.brief.currentMetrics).length > 0;
  const hasCompetitorEvidence = hasConcreteContentAgencyCompetitorEvidence(input.competitorStudy);
  const hasTranscriptEvidence = input.transcriptStudy.sourceTrace.length > 0
    && !input.transcriptStudy.warnings.includes('transcript_missing');
  const hasReferenceEvidence = input.sourceTrace.some((entry) => entry.startsWith('user_reference:'));
  const hasSourceEvidence = hasCompetitorEvidence || hasTranscriptEvidence || hasReferenceEvidence;
  const hasConcreteEvidence = hasCurrentMetrics || hasSourceEvidence;
  const dimensions: Record<string, number> = {
    audienceSpecificity: input.brief.missingFacts.includes('audience') ? 35 : 82,
    platformNativeFit: input.brief.platform === 'generic' ? 40 : 86,
    hookStrength: input.hookBank.length >= 4 ? 86 : 55,
    firstFrameClarity: input.creativeDirection.firstFrame.length >= 18 ? 84 : 52,
    narrativeTension: input.scriptVariants[0]?.beats.length >= 4 ? 82 : 58,
    emotionalArousalShareability: input.competitorStudy.emotionalDrivers.length > 0 ? 82 : 58,
    proofDensity: input.transcriptStudy.proofMoments.length > 0 ? 82 : hasSourceEvidence ? 52 : 30,
    originality: input.competitorStudy.originalityConstraints.length >= 3 ? 88 : 60,
    brandConsistency: input.brief.brandVoice || input.brief.audience !== 'Define the target audience' ? 82 : 55,
    complianceSafety: input.complianceReview.status === 'blocked' ? 20 : input.complianceReview.status === 'warning' ? 68 : 90,
    editability: input.creativeDirection.shotList.length >= 3 ? 84 : 58,
    productionFeasibility: input.creativeDirection.productionComplexity === 'high' ? 64 : 86,
    claimGrounding: input.complianceReview.blockers.includes('unsupported_or_overconfident_claim_blocked')
      ? 20
      : hasCurrentMetrics
        ? 82
        : hasSourceEvidence
          ? 60
          : 30,
    experimentClarity: hasCurrentMetrics ? 82 : 45,
    actionability: input.scriptVariants[0]?.cta ? 86 : 40,
  };

  for (const fact of input.brief.missingFacts) {
    warnings.push(`missing_${fact}`);
  }
  if (input.brief.platform === 'generic') blockers.push('platform_required_for_agency_package');
  if (input.complianceReview.status === 'blocked') blockers.push(...input.complianceReview.blockers);
  if (input.competitorStudy.warnings.includes('untrusted_competitor_text_contained_prompt_injection')) {
    blockers.push('competitor_prompt_injection_blocked');
  }
  if (input.transcriptStudy.warnings.includes('untrusted_transcript_contained_prompt_injection')) {
    blockers.push('transcript_prompt_injection_blocked');
  }
  if (!hasConcreteEvidence) warnings.push('source_evidence_missing');
  if (input.transcriptStudy.proofMoments.length === 0) warnings.push('proof_evidence_missing');
  if (!hasCurrentMetrics) warnings.push('experiment_baseline_missing');

  const packageText = flattenPackageText({
    hookBank: input.hookBank,
    scriptVariants: input.scriptVariants,
    creativeDirection: input.creativeDirection,
  });
  if (RAW_ARTIFACT_PATTERNS.some((pattern) => pattern.test(packageText))) blockers.push('raw_prompt_artifact_blocked');
  if (/post consistently/i.test(packageText) && !/because|metric|retention|audience/i.test(packageText)) {
    blockers.push('generic_post_consistently_advice_blocked');
  }
  if (/viral guarantee|guaranteed to go viral/i.test(packageText)) blockers.push('viral_guarantee_blocked');
  if (input.hookBank.some((hook) => !hook.mechanism.trim() || !hook.whyItWorks.trim())) {
    warnings.push('hook_hypothesis_incomplete');
  }
  if (!hasCompetitorEvidence) warnings.push('competitor_evidence_missing');

  const score = Math.max(0, Math.min(100, Math.round(
    Object.values(dimensions).reduce((sum, value) => sum + value, 0) / Object.keys(dimensions).length
      - blockers.length * 12
      - warnings.length * 2,
  )));
  return {
    score,
    status: blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'pass',
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    dimensions,
  };
}

export function persistContentAgencyArtifact(kind: PersistKind, artifact: unknown): number | null {
  const db = getDb();
  ensureContentAgencyTables(db);
  return persistContentAgencyArtifactOnDb(db, kind, artifact).id;
}

function persistContentAgencyArtifactOnDb(
  db: Database.Database,
  kind: PersistKind,
  artifact: unknown,
): ContentAgencyArtifactPersistenceResult {
  const table = tableForKind(kind);
  const source = requireRecord(artifact, 'artifact');
  const scope = normalizeAgencyScope(source, 'artifact');
  const id = normalizeContentAgencyArtifactId(source.id, 'artifact.id');
  const visibilityValue = source.visibilityScope ?? 'user_private';
  if (typeof visibilityValue !== 'string'
    || !CONTENT_AGENCY_ALLOWED_VISIBILITY_SCOPES.has(visibilityValue as ContentAgencyVisibilityScope)) {
    throw new ContentAgencyValidationError('artifact.visibilityScope is invalid.', 'artifact.visibilityScope');
  }
  let artifactToPersist: Record<string, unknown> = {
    ...source,
    id,
    userId: scope.userId,
    tenantId: scope.tenantId,
    visibilityScope: visibilityValue,
  };
  if (kind === 'package') {
    const suppliedHash = artifactToPersist.contentHash;
    let incomingHash: string;
    try {
      incomingHash = computeContentAgencyArtifactHash(artifactToPersist);
    } catch {
      throw new ContentAgencyValidationError('artifact must be a bounded JSON object.', 'artifact');
    }
    if (typeof suppliedHash === 'string' && suppliedHash !== incomingHash) {
      // Validate before the immutable INSERT. A poisoned first row cannot be
      // repaired through the package store's deliberate DO NOTHING contract.
      throw new ContentAgencyIntegrityError('Content agency package integrity check failed for incoming payload.');
    }
    const pkg = validateContentAgencyPackageArtifact(artifactToPersist, scope, {
      requirePrivate: true,
      expectedId: id,
    });
    artifactToPersist = { ...pkg, contentHash: incomingHash };
  }
  let payload: string;
  try {
    const encoded = JSON.stringify(artifactToPersist);
    if (typeof encoded !== 'string') {
      throw new ContentAgencyValidationError('artifact must be JSON serializable.', 'artifact');
    }
    payload = encoded;
  } catch {
    throw new ContentAgencyValidationError('artifact must be JSON serializable.', 'artifact');
  }
  if (payload.length > 1_000_000) {
    throw new ContentAgencyValidationError('artifact exceeds the 1000000 character storage limit.', 'artifact');
  }
  const storedBrief = isStoredRecord(artifactToPersist.brief) ? artifactToPersist.brief : null;
  const storedQuality = isStoredRecord(artifactToPersist.quality) ? artifactToPersist.quality : null;
  const storedCompliance = isStoredRecord(artifactToPersist.complianceReview) ? artifactToPersist.complianceReview : null;
  const sourceTrace = JSON.stringify(artifactToPersist.sourceTrace ?? []);
  const warnings = JSON.stringify(artifactToPersist.warnings ?? storedQuality?.warnings ?? []);
  const blockers = JSON.stringify(artifactToPersist.blockers ?? storedQuality?.blockers ?? []);
  const conflictAction = kind === 'package'
    ? 'DO NOTHING'
    : `DO UPDATE SET
      visibility_scope = excluded.visibility_scope,
      platform = excluded.platform,
      format = excluded.format,
      status = excluded.status,
      source_trace_json = excluded.source_trace_json,
      quality_score = excluded.quality_score,
      warnings_json = excluded.warnings_json,
      blockers_json = excluded.blockers_json,
      payload_json = excluded.payload_json,
      updated_at = datetime('now')`;
  const write = db.prepare(`
    INSERT INTO ${table} (
      agency_id, user_id, tenant_id, visibility_scope, platform, format, status,
      source_trace_json, quality_score, warnings_json, blockers_json, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, agency_id) ${conflictAction}
  `).run(
    artifactToPersist.id,
    artifactToPersist.userId,
    artifactToPersist.tenantId,
    artifactToPersist.visibilityScope ?? 'user_private',
    artifactToPersist.platform ?? storedBrief?.platform ?? null,
    artifactToPersist.format ?? storedBrief?.format ?? null,
    artifactToPersist.status ?? storedQuality?.status ?? storedCompliance?.status ?? 'draft',
    sourceTrace,
    storedQuality?.score ?? artifactToPersist.qualityScore ?? null,
    warnings,
    blockers,
    payload,
  );
  const persisted = db.prepare(`
    SELECT id, payload_json
      FROM ${table}
     WHERE agency_id = ?
       AND user_id = ?
       AND tenant_id = ?
     LIMIT 1
  `).get(artifactToPersist.id, artifactToPersist.userId, artifactToPersist.tenantId) as { id: number; payload_json: string } | undefined;
  if (!persisted) return { id: null, created: false };
  if (kind === 'package') {
    const persistedArtifact = parseContentAgencyArtifactPayload(persisted.payload_json);
    const persistedHash = computeContentAgencyArtifactHash(persistedArtifact);
    const incomingHash = computeContentAgencyArtifactHash(artifactToPersist);
    if (persistedArtifact.contentHash && persistedArtifact.contentHash !== persistedHash) {
      throw new ContentAgencyIntegrityError('Content agency package integrity check failed for persisted payload.');
    }
    if (artifactToPersist.contentHash && artifactToPersist.contentHash !== incomingHash) {
      throw new ContentAgencyIntegrityError('Content agency package integrity check failed for incoming payload.');
    }
    if (persistedHash !== incomingHash) {
      throw new ContentAgencyIntegrityError('Content agency package identity conflict: immutable package payload differs.');
    }
  }
  return { id: Number(persisted.id), created: Number(write.changes ?? 0) === 1 };
}

/** Persist the package plus its derived reviews as one all-or-nothing unit. */
export function persistContentAgencyPackageBundle(
  pkg: ContentAgencyPackage,
): ContentAgencyPackagePersistenceResult {
  const db = getDb();
  ensureContentAgencyTables(db);
  const validated = validateContentAgencyPackageArtifact(pkg, {
    userId: pkg.userId,
    tenantId: pkg.tenantId,
  }, { requirePrivate: true, expectedId: pkg.id });
  const packagePersistence = db.transaction(() => {
    const persistedPackage = persistContentAgencyArtifactOnDb(db, 'package', validated);
    if (persistedPackage.id == null) {
      throw new ContentAgencyIntegrityError('Content agency package could not be read after persistence.');
    }
    persistContentAgencyArtifactOnDb(db, 'compliance_review', {
      id: `${validated.id}_compliance`,
      userId: validated.userId,
      tenantId: validated.tenantId,
      visibilityScope: validated.visibilityScope,
      platform: validated.platform,
      format: validated.format,
      status: validated.complianceReview.status,
      complianceReview: validated.complianceReview,
      warnings: validated.complianceReview.warnings,
      blockers: validated.complianceReview.blockers,
      sourceTrace: validated.sourceTrace,
    });
    persistContentAgencyArtifactOnDb(db, 'experiment_run', {
      id: `${validated.id}_experiment`,
      userId: validated.userId,
      tenantId: validated.tenantId,
      visibilityScope: validated.visibilityScope,
      platform: validated.platform,
      format: validated.format,
      status: 'planned',
      experimentPlan: validated.experimentPlan,
      warnings: [],
      blockers: [],
      sourceTrace: validated.sourceTrace,
    });
    persistContentAgencyArtifactOnDb(db, 'quality_review', {
      id: `${validated.id}_quality`,
      userId: validated.userId,
      tenantId: validated.tenantId,
      visibilityScope: validated.visibilityScope,
      platform: validated.platform,
      format: validated.format,
      quality: validated.quality,
      warnings: validated.quality.warnings,
      blockers: validated.quality.blockers,
      sourceTrace: validated.sourceTrace,
    });
    return persistedPackage;
  }).immediate();
  const persisted = getContentAgencyPackage({
    userId: validated.userId,
    tenantId: validated.tenantId,
    id: validated.id,
  });
  if (!persisted) {
    throw new ContentAgencyIntegrityError('Content agency package could not be read after persistence.');
  }
  return { package: persisted, created: packagePersistence.created };
}

function parseContentAgencyArtifactPayload(payload: string): Record<string, unknown> {
  if (payload.length > 1_000_000) {
    throw new ContentAgencyIntegrityError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new ContentAgencyIntegrityError();
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ContentAgencyIntegrityError();
  }
  return decoded as Record<string, unknown>;
}

function validateContentAgencyPackageArtifact(
  value: unknown,
  expectedScope: { userId: number; tenantId: number },
  options: { requirePrivate: boolean; expectedId: string; requireCurrentVersion?: boolean },
): ContentAgencyPackage {
  const fail = (): never => {
    throw new ContentAgencyIntegrityError();
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const pkg = value as Record<string, unknown>;
  if (pkg.id !== options.expectedId
    || typeof pkg.id !== 'string'
    || !/^package_[a-f0-9]{16}$/.test(pkg.id)
    || !Number.isSafeInteger(pkg.userId)
    || Number(pkg.userId) <= 0
    || !Number.isSafeInteger(pkg.tenantId)
    || Number(pkg.tenantId) <= 0
    || pkg.userId !== expectedScope.userId
    || pkg.tenantId !== expectedScope.tenantId
    || typeof pkg.visibilityScope !== 'string'
    || !CONTENT_AGENCY_ALLOWED_VISIBILITY_SCOPES.has(pkg.visibilityScope as ContentAgencyVisibilityScope)
    || (options.requirePrivate && pkg.visibilityScope !== 'user_private')
    || typeof pkg.generatorContractVersion !== 'string'
    || !/^content-agency-package\.v[1-9][0-9]*$/.test(pkg.generatorContractVersion)
    || typeof pkg.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(pkg.contentHash)
    || typeof pkg.platform !== 'string'
    || !['youtube', 'youtube_shorts', 'tiktok', 'instagram_reel', 'carousel', 'blog', 'newsletter', 'generic'].includes(pkg.platform)
    || !isSafeStoredString(pkg.format, 80)
    || !isSafeStoredString(pkg.objective, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isSafeStoredString(pkg.createdAt, 64)
    || typeof pkg.confidence !== 'number'
    || !Number.isFinite(pkg.confidence)
    || pkg.confidence < 0
    || pkg.confidence > 1
    || typeof pkg.reviewRequired !== 'boolean') {
    return fail();
  }
  if (options.requireCurrentVersion
    && pkg.generatorContractVersion !== CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION) {
    throw new ContentAgencyPackageVersionError();
  }

  const brief = isStoredRecord(pkg.brief) ? pkg.brief : null;
  const competitorStudy = isStoredRecord(pkg.competitorStudy) ? pkg.competitorStudy : null;
  const transcriptStudy = isStoredRecord(pkg.transcriptStudy) ? pkg.transcriptStudy : null;
  const positioning = isStoredRecord(pkg.positioning) ? pkg.positioning : null;
  const quality = isStoredRecord(pkg.quality) ? pkg.quality : null;
  const compliance = isStoredRecord(pkg.complianceReview) ? pkg.complianceReview : null;
  const creative = isStoredRecord(pkg.creativeDirection) ? pkg.creativeDirection : null;
  const experiment = isStoredRecord(pkg.experimentPlan) ? pkg.experimentPlan : null;
  const performance = isStoredRecord(pkg.performanceDiagnosis) ? pkg.performanceDiagnosis : null;
  if (!brief || brief.userId !== expectedScope.userId || brief.tenantId !== expectedScope.tenantId
    || brief.visibilityScope !== pkg.visibilityScope
    || !isSafeStoredString(brief.id, 200)
    || !isSafeStoredString(brief.goal, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isSafeStoredString(brief.audience, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || brief.platform !== pkg.platform
    || !isSafeStoredString(brief.format, 80)
    || brief.format !== pkg.format
    || !isSafeStoredString(brief.objective, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || brief.objective !== pkg.objective
    || (brief.offer !== null && !isSafeStoredString(brief.offer, CONTENT_AGENCY_MAX_TEXT_CHARS))
    || (brief.brandVoice !== null && !isSafeStoredString(brief.brandVoice, CONTENT_AGENCY_MAX_TEXT_CHARS))
    || typeof brief.confidence !== 'number'
    || !Number.isFinite(brief.confidence)
    || brief.confidence < 0
    || brief.confidence > 1
    || !isStoredStringList(brief.constraints, CONTENT_AGENCY_MAX_LIST_ITEMS, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isStoredStringList(brief.missingFacts, CONTENT_AGENCY_MAX_LIST_ITEMS, 120)
    || !isStoredStringList(brief.sourceTrace, 64, 2_048)
    || !isStoredStringList(brief.nextBestActions, CONTENT_AGENCY_MAX_LIST_ITEMS, 2_000)
    || !competitorStudy
    || competitorStudy.userId !== expectedScope.userId
    || competitorStudy.tenantId !== expectedScope.tenantId
    || !isSafeStoredString(competitorStudy.id, 200)
    || !isStoredStringList(competitorStudy.patterns, 30, 2_000)
    || !isStoredStringList(competitorStudy.hookMechanisms, 30, 2_000)
    || !isStoredStringList(competitorStudy.emotionalDrivers, 30, 2_000)
    || !isStoredStringList(competitorStudy.pacingPatterns, 30, 2_000)
    || !isStoredStringList(competitorStudy.originalityConstraints, 30, 2_000)
    || !isStoredStringList(competitorStudy.opportunityGaps, 30, 2_000)
    || !isStoredStringList(competitorStudy.sourceTrace, CONTENT_AGENCY_MAX_COMPETITORS * 4, 2_048)
    || !isStoredStringList(competitorStudy.warnings, 30, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !transcriptStudy
    || transcriptStudy.userId !== expectedScope.userId
    || transcriptStudy.tenantId !== expectedScope.tenantId
    || !isSafeStoredString(transcriptStudy.id, 200)
    || !isStoredStringList(transcriptStudy.structure, 30, 2_000)
    || !isStoredStringList(transcriptStudy.emotionalBeats, 30, 2_000)
    || !isStoredStringList(transcriptStudy.proofMoments, 30, 2_000)
    || !isStoredStringList(transcriptStudy.retentionDevices, 30, 2_000)
    || !isSafeStoredString(transcriptStudy.ctaDiagnosis, 2_000)
    || !isStoredStringList(transcriptStudy.sourceTrace, 30, 2_048)
    || !isStoredStringList(transcriptStudy.warnings, 30, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !positioning
    || !isSafeStoredString(positioning.category, 2_000)
    || !isSafeStoredString(positioning.strategicEnemy, 2_000)
    || !isSafeStoredString(positioning.promise, 2_000)
    || !isStoredStringList(positioning.proofLibrary, 30, 2_000)
    || !isSafeStoredString(positioning.brandVoice, 2_000)
    || !quality
    || !['pass', 'warning', 'blocked'].includes(String(quality.status))
    || typeof quality.score !== 'number'
    || !Number.isFinite(quality.score)
    || quality.score < 0
    || quality.score > 100
    || !isStoredStringList(quality.warnings, 64, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isStoredStringList(quality.blockers, 64, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isStoredFiniteNumberRecord(quality.dimensions, 64, 0, 100)
    || !compliance
    || !['pass', 'warning', 'blocked'].includes(String(compliance.status))
    || !isStoredStringList(compliance.warnings, 64, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isStoredStringList(compliance.blockers, 64, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || typeof compliance.disclosureRequired !== 'boolean'
    || !['low', 'medium', 'high'].includes(String(compliance.copyrightRisk))
    || !['low', 'medium', 'high'].includes(String(compliance.originalityRisk))
    || !isStoredStringList(compliance.notes, 30, 2_000)
    || !creative
    || !isSafeStoredString(creative.firstFrame, 2_000)
    || !isStoredStringList(creative.shotList, 30, 2_000)
    || !isStoredStringList(creative.broll, 30, 2_000)
    || !isStoredStringList(creative.captions, 30, 2_000)
    || !isSafeStoredString(creative.soundDirection, 2_000)
    || !isStoredStringList(creative.editingPlan, 30, 2_000)
    || !['low', 'medium', 'high'].includes(String(creative.productionComplexity))
    || !experiment
    || !isSafeStoredString(experiment.hypothesis, 2_000)
    || !isStoredStringList(experiment.variables, 30, 2_000)
    || !isSafeStoredString(experiment.primaryMetric, 2_000)
    || !isStoredStringList(experiment.secondaryMetrics, 30, 2_000)
    || !isStoredStringList(experiment.interpretation, 30, 2_000)
    || !performance
    || !isSafeStoredString(performance.summary, 2_000)
    || !isSafeStoredString(performance.likelyBottleneck, 2_000)
    || !isStoredStringList(performance.evidence, 30, 2_000)
    || !isSafeStoredString(performance.recommendedTest, 2_000)
    || !isStoredStringList(performance.metricsToWatch, 30, 2_000)
    || !isSafeStoredString(performance.uncertainty, 2_000)
    || !isSafeStoredString(pkg.audienceInsight, 2_000)
    || !Array.isArray(pkg.hookBank)
    || pkg.hookBank.length > CONTENT_AGENCY_MAX_LIST_ITEMS
    || !pkg.hookBank.every(isStoredAgencyHook)
    || !Array.isArray(pkg.scriptVariants)
    || pkg.scriptVariants.length > CONTENT_AGENCY_MAX_LIST_ITEMS
    || !pkg.scriptVariants.every(isStoredAgencyScriptVariant)
    || !isStoredStringList(pkg.sourceTrace, 64, 2_048)
    || !isStoredStringList(pkg.referenceIds, CONTENT_AGENCY_MAX_LIST_ITEMS, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isStoredStringList(pkg.warnings, 64, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isStoredStringList(pkg.blockers, 64, CONTENT_AGENCY_MAX_TEXT_CHARS)
    || !isStoredStringList(pkg.nextBestActions, CONTENT_AGENCY_MAX_LIST_ITEMS, 2_000)) {
    return fail();
  }
  const typed = pkg as unknown as ContentAgencyPackage;
  if (computeContentAgencyArtifactHash(typed) !== typed.contentHash) return fail();
  return typed;
}

function isStoredAgencyHook(value: unknown): boolean {
  if (!isStoredRecord(value)) return false;
  return isSafeStoredString(value.mechanism, CONTENT_AGENCY_MAX_TEXT_CHARS)
    && isSafeStoredString(value.hook, 2_000)
    && isSafeStoredString(value.whyItWorks, 2_000)
    && (value.risk === null || isSafeStoredString(value.risk, 2_000));
}

function isStoredAgencyScriptVariant(value: unknown): boolean {
  if (!isStoredRecord(value)) return false;
  return isSafeStoredString(value.id, 200)
    && isSafeStoredString(value.title, CONTENT_AGENCY_MAX_TEXT_CHARS)
    && isSafeStoredString(value.coldOpen, 2_000)
    && isSafeStoredString(value.promise, 2_000)
    && isStoredStringList(value.beats, 30, 2_000)
    && isSafeStoredString(value.payoff, 4_000)
    && isSafeStoredString(value.cta, 2_000)
    && isStoredStringList(value.retentionDevices, 30, 2_000)
    && isSafeStoredString(value.originalityNote, 2_000);
}

function isStoredStringList(value: unknown, maxItems: number, maxChars: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((entry) => isSafeStoredString(entry, maxChars));
}

function isStoredFiniteNumberRecord(
  value: unknown,
  maxEntries: number,
  min: number,
  max: number,
): boolean {
  if (!isStoredRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maxEntries && entries.every(([key, entry]) => (
    key.length > 0
    && key.length <= 120
    && !UNSUPPORTED_CONTENT_AGENCY_CONTROL_CHARACTERS.test(key)
    && typeof entry === 'number'
    && Number.isFinite(entry)
    && entry >= min
    && entry <= max
  ));
}

function isSafeStoredString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxChars
    && !UNSUPPORTED_CONTENT_AGENCY_CONTROL_CHARACTERS.test(value);
}

function isStoredRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getContentAgencyProject(input: {
  userId: number;
  tenantId: number;
  id: string;
}): { kind: string; artifact: any } | null {
  const db = getDb();
  ensureContentAgencyTables(db);
  const scope = normalizeAgencyScope(input, 'project');
  const id = normalizeContentAgencyArtifactId(input.id, 'project.id');
  for (const [kind, table] of Object.entries(TABLE_BY_KIND)) {
    const row = db.prepare(`
      SELECT visibility_scope, payload_json
        FROM ${table}
       WHERE agency_id = ?
         AND user_id = ?
         AND tenant_id = ?
       ORDER BY id DESC
       LIMIT 1
    `).get(id, scope.userId, scope.tenantId) as { visibility_scope: string; payload_json: string } | undefined;
    if (row) {
      const artifact = parseContentAgencyArtifactPayload(row.payload_json);
      if (artifact.id !== id
        || artifact.userId !== scope.userId
        || artifact.tenantId !== scope.tenantId
        || (artifact.visibilityScope !== undefined && artifact.visibilityScope !== row.visibility_scope)
        || !CONTENT_AGENCY_ALLOWED_VISIBILITY_SCOPES.has(row.visibility_scope as ContentAgencyVisibilityScope)) {
        throw new ContentAgencyIntegrityError();
      }
      if (kind === 'package') {
        return {
          kind,
          artifact: validateContentAgencyPackageArtifact(artifact, scope, {
            requirePrivate: false,
            expectedId: id,
          }),
        };
      }
      return { kind, artifact: { ...artifact, visibilityScope: row.visibility_scope } };
    }
  }
  return null;
}

export function getContentAgencyPackage(input: {
  userId: number;
  tenantId: number;
  id: string;
}): ContentAgencyPackage | null {
  const db = getDb();
  ensureContentAgencyTables(db);
  const scope = normalizeAgencyScope(input, 'package');
  const id = normalizeContentAgencyArtifactId(input.id, 'package.id');
  const row = db.prepare(`
    SELECT payload_json
      FROM content_agency_packages
     WHERE agency_id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND visibility_scope = 'user_private'
     LIMIT 1
  `).get(id, scope.userId, scope.tenantId) as { payload_json: string } | undefined;
  if (!row) return null;
  return validateContentAgencyPackageArtifact(
    parseContentAgencyArtifactPayload(row.payload_json),
    scope,
    { requirePrivate: true, expectedId: id, requireCurrentVersion: true },
  );
}

export function handoffContentAgencyPackageToWorkspace(input: {
  userId: number;
  tenantId: number;
  packageId: string;
}): ContentAgencyWorkspaceHandoffResult {
  const db = getDb();
  ensureContentAgencyTables(db);
  const scope = normalizeAgencyHandoffScope(input);
  const packageId = normalizeContentAgencyArtifactId(input.packageId, 'packageId');
  const pkg = getContentAgencyPackage({
    userId: scope.userId,
    tenantId: scope.tenantId,
    id: packageId,
  });
  if (!pkg) {
    return {
      packageId,
      packageHash: null,
      status: 'not_found',
      changed: false,
      pipelineId: null,
      workspaceItemId: null,
      workspaceArtifactId: null,
      workspaceRevisionId: null,
      persistence: 'content_workspace',
      blockers: ['content_agency_package_not_found'],
      warnings: [],
      nextBestActions: ['Generate or reopen the agency package before adding it to the Content workspace.'],
      sourceTrace: ['Content Agency package store'],
    };
  }
  // A package handoff atomically crosses all three slices. Requiring each
  // kill switch here prevents an alternate transport from creating a partial
  // item/revision/lineage chain when one slice is paused.
  assertContentWorkspaceWriteEnabled(scope, 'core');
  assertContentWorkspaceWriteEnabled(scope, 'revisions');
  assertContentWorkspaceWriteEnabled(scope, 'lineage');
  const packageHash = pkg.contentHash;
  const blockers = [...new Set([
    ...(Array.isArray(pkg.blockers) ? pkg.blockers : []),
    ...(pkg.visibilityScope === 'user_private' ? [] : ['content_agency_workspace_requires_private_scope']),
  ])];
  if (blockers.length > 0 || pkg.quality?.status === 'blocked') {
    const effectiveBlockers = blockers.length > 0 ? blockers : ['content_agency_quality_blocked'];
    return {
      packageId: pkg.id,
      packageHash,
      status: 'blocked',
      changed: false,
      pipelineId: null,
      workspaceItemId: null,
      workspaceArtifactId: null,
      workspaceRevisionId: null,
      persistence: 'content_workspace',
      blockers: effectiveBlockers,
      warnings: Array.isArray(pkg.warnings) ? pkg.warnings : [],
      nextBestActions: effectiveBlockers.map((blocker) => `Resolve blocker: ${humanize(blocker)}.`),
      sourceTrace: [...(pkg.sourceTrace ?? []), 'Content workspace handoff gate'],
    };
  }

  return db.transaction(() => {
    const existing = findAgencyWorkspaceBinding(db, scope, pkg.id);
    if (existing) {
      return reuseAgencyWorkspaceBinding(db, scope, pkg, packageHash, existing);
    }

    const itemMutation = createContentWorkspaceItem({
      scope,
      itemType: 'content_item',
      title: truncate(pkg.objective || pkg.brief?.goal || 'Creator package', 240),
      summary: truncate(
        `${pkg.brief?.audience || 'Target audience'} · ${pkg.platform || 'generic'} · ${pkg.format || 'content'}`,
        20_000,
      ),
      platformId: pkg.platform || null,
      formatId: pkg.format || null,
      idempotencyKey: agencyWorkspaceIdempotencyKey('item', pkg.id, packageHash),
    }, db);
    const item = itemMutation.value;
    const artifactMutation = createAgencyWorkspaceArtifact(db, scope, item, pkg, packageHash, true);
    const artifact = artifactMutation.value;
    const current = getContentWorkspaceItem(scope, item.id, db);
    if (!current) throw new Error('Content agency workspace handoff item read-back failed');
    const reviewMutation = transitionContentWorkspaceItem({
      scope,
      itemId: current.id,
      targetState: 'review',
      expectedWorkflowVersion: current.workflowVersion,
      idempotencyKey: agencyWorkspaceIdempotencyKey('review', pkg.id, packageHash),
    }, db);
    const reviewed = reviewMutation.value;
    if (reviewed.productionState !== 'review') {
      throw new Error('Content agency workspace handoff review-state verification failed');
    }
    const revisionId = requireAgencyArtifactRevision(artifact, pkg.id, packageHash);
    db.prepare(`
      INSERT INTO content_workspace_ingress_bindings (
        tenant_id, owner_user_id, source_kind, source_id, source_hash,
        item_id, artifact_id, revision_id, content_parity_status, ingress_origin
      ) VALUES (?, ?, 'content_agency_package', ?, ?, ?, ?, ?, 'artifact_pinned', 'content_agency_handoff')
    `).run(
      scope.tenantId,
      scope.userId,
      pkg.id,
      packageHash,
      reviewed.id,
      artifact.id,
      revisionId,
    );
    const binding = findAgencyWorkspaceBinding(db, scope, pkg.id);
    if (!binding) throw new Error('Content agency workspace handoff binding read-back failed');
    verifyAgencyWorkspaceBinding(db, scope, pkg, packageHash, binding);
    return agencyWorkspaceHandoffResult(pkg, packageHash, binding, 'created', {
      changed: (itemMutation.created && !itemMutation.replayed)
        || (artifactMutation.created && !artifactMutation.replayed)
        || (!reviewMutation.replayed && current.productionState !== reviewed.productionState),
    });
  }).immediate();
}

type AgencyWorkspaceBindingRow = {
  id: number;
  source_hash: string | null;
  item_id: number;
  artifact_id: number | null;
  revision_id: number | null;
  content_parity_status: 'metadata_only' | 'artifact_pinned';
  ingress_origin: 'legacy_pipeline_backfill' | 'content_agency_handoff';
};

function normalizeAgencyHandoffScope(input: { userId: number; tenantId: number }): ContentWorkspaceScope {
  return normalizeAgencyScope(input, 'handoff');
}

function findAgencyWorkspaceBinding(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  packageId: string,
): AgencyWorkspaceBindingRow | undefined {
  return db.prepare(`
    SELECT id, source_hash, item_id, artifact_id, revision_id, content_parity_status, ingress_origin
      FROM content_workspace_ingress_bindings
     WHERE tenant_id = ?
       AND owner_user_id = ?
       AND source_kind = 'content_agency_package'
       AND source_id = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, packageId) as AgencyWorkspaceBindingRow | undefined;
}

function reuseAgencyWorkspaceBinding(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  pkg: ContentAgencyPackage,
  packageHash: string,
  candidate: AgencyWorkspaceBindingRow,
): ContentAgencyWorkspaceHandoffResult {
  let binding = candidate;
  let workspaceChanged = false;
  if (binding.source_hash == null) {
    db.prepare(`
      UPDATE content_workspace_ingress_bindings
         SET source_hash = ?, updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND owner_user_id = ?
         AND source_kind = 'content_agency_package'
         AND source_id = ?
         AND source_hash IS NULL
    `).run(packageHash, new Date().toISOString(), binding.id, scope.tenantId, scope.userId, pkg.id);
    binding = findAgencyWorkspaceBinding(db, scope, pkg.id)
      ?? (() => { throw new Error('Content agency workspace hash pin read-back failed'); })();
  }
  if (binding.source_hash !== packageHash) {
    throw new Error('Content agency workspace handoff integrity conflict: pinned package hash differs');
  }

  const rawItem = db.prepare(`
    SELECT scope_status
      FROM content_domain_objects
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND object_type = 'content_item'
     LIMIT 1
  `).get(binding.item_id, scope.tenantId, scope.userId) as { scope_status: string } | undefined;
  if (!rawItem) throw new Error('Content agency workspace handoff binding points to a missing item');
  if (rawItem.scope_status !== 'active') {
    return agencyWorkspaceHandoffResult(pkg, packageHash, binding, 'already_exists', {
      changed: false,
      warnings: ['content_workspace_item_requires_restore'],
      nextBestActions: ['Restore the existing Content workspace item before continuing editorial review.'],
      sourceTrace: ['Existing recoverable Content workspace item'],
    });
  }

  let item = getContentWorkspaceItem(scope, binding.item_id, db);
  if (!item) throw new Error('Content agency workspace handoff item read-back failed');
  if (binding.artifact_id == null || binding.revision_id == null) {
    const makeCurrent = ['inbox', 'active', 'review'].includes(item.productionState);
    const artifactMutation = createAgencyWorkspaceArtifact(db, scope, item, pkg, packageHash, makeCurrent);
    const artifact = artifactMutation.value;
    workspaceChanged ||= artifactMutation.created && !artifactMutation.replayed;
    const revisionId = requireAgencyArtifactRevision(artifact, pkg.id, packageHash);
    db.prepare(`
      UPDATE content_workspace_ingress_bindings
         SET artifact_id = ?, revision_id = ?, content_parity_status = 'artifact_pinned', updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND owner_user_id = ?
         AND artifact_id IS NULL
         AND revision_id IS NULL
    `).run(
      artifact.id,
      revisionId,
      new Date().toISOString(),
      binding.id,
      scope.tenantId,
      scope.userId,
    );
    binding = findAgencyWorkspaceBinding(db, scope, pkg.id)
      ?? (() => { throw new Error('Content agency workspace artifact pin read-back failed'); })();
    item = getContentWorkspaceItem(scope, binding.item_id, db)
      ?? (() => { throw new Error('Content agency workspace item read-back failed after artifact attach'); })();
  }
  if (item.productionState === 'inbox' || item.productionState === 'active') {
    const transition = transitionContentWorkspaceItem({
      scope,
      itemId: item.id,
      targetState: 'review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: agencyWorkspaceIdempotencyKey('review', pkg.id, packageHash),
    }, db);
    workspaceChanged ||= !transition.replayed && transition.value.productionState === 'review';
  }
  verifyAgencyWorkspaceBinding(db, scope, pkg, packageHash, binding);
  return agencyWorkspaceHandoffResult(pkg, packageHash, binding, 'already_exists', { changed: workspaceChanged });
}

function createAgencyWorkspaceArtifact(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  item: ContentWorkspaceItem,
  pkg: ContentAgencyPackage,
  packageHash: string,
  makeCurrent: boolean,
): ReturnType<typeof createContentArtifact> {
  const selectedVariant = pkg.scriptVariants[0] ?? null;
  return createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    title: truncate(selectedVariant?.title || `${pkg.objective} script`, 240),
    platformId: pkg.platform,
    formatId: pkg.format,
    metadata: {
      sourceKind: 'content_agency_package',
      sourcePackageId: pkg.id,
      sourcePackageHash: packageHash,
      generatorContractVersion: pkg.generatorContractVersion,
      qualityStatus: pkg.quality?.status ?? 'warning',
      qualityScore: pkg.quality?.score ?? null,
      reviewRequired: true,
    },
    initialContent: {
      format: 'structured_json',
      document: {
        schemaVersion: 'content-agency-workspace-handoff-v1',
        objective: pkg.objective,
        platform: pkg.platform,
        format: pkg.format,
        brief: pkg.brief,
        hooks: pkg.hookBank,
        scriptVariants: pkg.scriptVariants,
        selectedVariantId: selectedVariant?.id ?? null,
        creativeDirection: pkg.creativeDirection,
        complianceReview: pkg.complianceReview,
        experimentPlan: pkg.experimentPlan,
        quality: pkg.quality,
        sourcePackage: {
          id: pkg.id,
          contentHash: packageHash,
          generatorContractVersion: pkg.generatorContractVersion,
        },
      },
    },
    changeSummary: 'Imported immutable Content Agency package for editorial review',
    actorType: 'agent',
    actorId: 'content_agency',
    provenance: {
      sourceKind: 'content_agency_package',
      packageId: pkg.id,
      packageHash,
      generatorContractVersion: pkg.generatorContractVersion,
      sourceTrace: pkg.sourceTrace ?? [],
      referenceIds: pkg.referenceIds ?? [],
      approvalGranted: false,
    },
    makeCurrent,
    idempotencyKey: agencyWorkspaceIdempotencyKey('artifact', pkg.id, packageHash),
  }, db);
}

function requireAgencyArtifactRevision(
  artifact: ContentArtifact,
  packageId: string,
  packageHash: string,
): number {
  const revision = artifact.currentRevision;
  if (!revision || revision.actorType !== 'agent'
    || revision.provenance.packageId !== packageId
    || revision.provenance.packageHash !== packageHash) {
    throw new Error('Content agency workspace artifact provenance verification failed');
  }
  return revision.id;
}

function verifyAgencyWorkspaceBinding(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  pkg: ContentAgencyPackage,
  packageHash: string,
  binding: AgencyWorkspaceBindingRow,
): void {
  if (binding.source_hash !== packageHash
    || binding.content_parity_status !== 'artifact_pinned'
    || binding.artifact_id == null
    || binding.revision_id == null) {
    throw new Error('Content agency workspace handoff binding verification failed');
  }
  const artifact = getContentArtifact(scope, binding.artifact_id, db);
  const revisionId = artifact ? requireAgencyArtifactRevision(artifact, pkg.id, packageHash) : null;
  if (!artifact || artifact.itemId !== binding.item_id || revisionId !== binding.revision_id) {
    throw new Error('Content agency workspace handoff read-back failed');
  }
}

function agencyWorkspaceHandoffResult(
  pkg: ContentAgencyPackage,
  packageHash: string,
  binding: AgencyWorkspaceBindingRow,
  status: 'created' | 'already_exists',
  overrides: {
    changed: boolean;
    warnings?: string[];
    nextBestActions?: string[];
    sourceTrace?: string[];
  },
): ContentAgencyWorkspaceHandoffResult {
  return {
    packageId: pkg.id,
    packageHash,
    status,
    changed: overrides.changed,
    pipelineId: binding.item_id,
    workspaceItemId: binding.item_id,
    workspaceArtifactId: binding.artifact_id,
    workspaceRevisionId: binding.revision_id,
    persistence: 'content_workspace',
    blockers: [],
    warnings: [...new Set([...(pkg.warnings ?? []), ...(overrides.warnings ?? [])])],
    nextBestActions: overrides.nextBestActions
      ?? ['Open the Content workspace item, review the pinned package revision, and approve it separately.'],
    sourceTrace: [
      ...(pkg.sourceTrace ?? []),
      ...(overrides.sourceTrace ?? ['Canonical Content workspace read-back verified']),
    ],
  };
}

function agencyWorkspaceIdempotencyKey(kind: string, packageId: string, packageHash: string): string {
  return `agency-${kind}:${crypto.createHash('sha256').update(`${packageId}:${packageHash}`).digest('hex')}`;
}

export function buildCriticalUserReview(input: {
  brief: ContentAgencyBrief;
  quality: ContentAgencyQualityResult;
  competitorStudy: ContentAgencyCompetitorPatternStudy;
  transcriptStudy: ContentAgencyTranscriptStudy;
  hooks: ContentAgencyHook[];
  scripts: ContentAgencyScriptVariant[];
  complianceReview: ContentAgencyComplianceReview;
}): ContentAgencyCriticalUserReview {
  const issues: string[] = [];
  const canExtractNextStep = input.quality.blockers.length === 0 && input.scripts.some((script) => Boolean(script.cta));
  const canExplainWhy = input.hooks.every((hook) => hook.whyItWorks.length > 10);
  const seesEvidence = Object.keys(input.brief.currentMetrics).length > 0
    || hasConcreteContentAgencyCompetitorEvidence(input.competitorStudy)
    || input.transcriptStudy.sourceTrace.length > 0;
  const seesOriginality = input.scripts.every((script) => /different angle|original|not copy/i.test(script.originalityNote));
  const seesRisks = input.complianceReview.warnings.length > 0 || input.complianceReview.blockers.length > 0 || input.brief.missingFacts.length > 0;
  const rejectsAsGeneric = input.hooks.some((hook) => /post consistently|be authentic|add value/i.test(hook.hook));

  if (!canExtractNextStep) issues.push('I cannot tell what to do next.');
  if (!canExplainWhy) issues.push('The recommendation lacks evidence or reasoning.');
  if (!seesEvidence) issues.push('No concrete source material or measured result is visible.');
  if (!seesOriginality) issues.push('The idea is not meaningfully different from the competitor.');
  if (rejectsAsGeneric) issues.push('This sounds generic.');
  if (input.quality.blockers.includes('raw_prompt_artifact_blocked')) issues.push('The output has raw codes or prompt artifacts.');

  return {
    canExtractNextStep,
    canExplainWhy,
    seesEvidence,
    seesOriginality,
    seesRisks,
    rejectsAsGeneric,
    issues,
  };
}

export function ensureContentAgencyTables(db: any = getDb()): void {
  for (const table of Object.values(TABLE_BY_KIND)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agency_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        visibility_scope TEXT NOT NULL DEFAULT 'user_private',
        platform TEXT,
        format TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        source_trace_json TEXT NOT NULL DEFAULT '[]',
        quality_score INTEGER,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_${table}_scope ON ${table}(tenant_id, user_id, agency_id);
    `);
    db.exec(`
      DELETE FROM ${table}
       WHERE id NOT IN (
         SELECT MAX(id)
           FROM ${table}
          GROUP BY tenant_id, user_id, agency_id
       );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_${table}_scope
        ON ${table}(tenant_id, user_id, agency_id);
    `);
  }
}

export function validateContentAgencyReadiness(): { valid: boolean; errors: string[] } {
  const coverage = validateContentAgencyRuleCoverage();
  const runtimeCoverage = validateContentAgencyRuntimeRuleCoverage();
  const errors = [
    ...coverage.missingCategories.map((category) => `missing_rule_category:${category}`),
    ...runtimeCoverage.missingCategories.map((category) => `missing_runtime_quality_rule_category:${category}`),
  ];
  const rules = listContentAgencyRules();
  if (!rules.some((rule) => rule.category === 'compliance_policy' && rule.blockedFailureModes.includes('sponsored_or_branded_content_requires_clear_disclosure'))) {
    errors.push('compliance_rules_do_not_block_missing_disclosure');
  }
  if (!rules.some((rule) => rule.category === 'human_behavior_story' && /arousal|story/i.test(rule.principle))) {
    errors.push('human_behavior_rules_not_connected_to_hook_scoring');
  }
  if (!rules.some((rule) => rule.category === 'editing_production' && /first-frame|shot|caption/i.test(rule.productBehavior))) {
    errors.push('editing_rules_not_connected_to_creative_direction');
  }
  return { valid: errors.length === 0, errors };
}

function normalizeAgencyScope(
  value: unknown,
  field: string,
): { userId: number; tenantId: number } {
  const input = requireRecord(value, field);
  const userId = input.userId;
  const tenantId = input.tenantId;
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0) {
    throw new ContentAgencyValidationError(`${field}.userId must be a positive safe integer.`, `${field}.userId`);
  }
  if (!Number.isSafeInteger(tenantId) || Number(tenantId) <= 0) {
    throw new ContentAgencyValidationError(`${field}.tenantId must be a positive safe integer.`, `${field}.tenantId`);
  }
  return { userId: Number(userId), tenantId: Number(tenantId) };
}

function normalizeBriefInput(input: ContentAgencyBriefInput): {
  userId: number;
  tenantId: number;
  visibilityScope: ContentAgencyVisibilityScope;
  goal: string | null;
  audience: string | null;
  offer: string | null;
  platform: string | null;
  format: string | null;
  objective: string | null;
  constraints: string[];
  currentMetrics: Record<string, number | string>;
  brandVoice: string | null;
  notes: string | null;
} {
  const source = requireRecord(input, 'brief');
  const scope = normalizeAgencyScope(source, 'brief');
  const visibilityValue = source.visibilityScope ?? 'user_private';
  if (typeof visibilityValue !== 'string'
    || !CONTENT_AGENCY_ALLOWED_VISIBILITY_SCOPES.has(visibilityValue as ContentAgencyVisibilityScope)) {
    throw new ContentAgencyValidationError(
      'visibilityScope must be one of: user_private, tenant_shared, platform_internal.',
      'visibilityScope',
    );
  }
  return {
    ...scope,
    visibilityScope: visibilityValue as ContentAgencyVisibilityScope,
    goal: normalizeOptionalText(source.goal, 'goal', CONTENT_AGENCY_MAX_TEXT_CHARS),
    audience: normalizeOptionalText(source.audience, 'audience', CONTENT_AGENCY_MAX_TEXT_CHARS),
    offer: normalizeOptionalText(source.offer, 'offer', CONTENT_AGENCY_MAX_TEXT_CHARS),
    platform: normalizeOptionalText(source.platform, 'platform', 80),
    format: normalizeOptionalText(source.format, 'format', 80),
    objective: normalizeOptionalText(source.objective, 'objective', CONTENT_AGENCY_MAX_TEXT_CHARS),
    constraints: normalizeStringList(
      source.constraints,
      'constraints',
      CONTENT_AGENCY_MAX_LIST_ITEMS,
      CONTENT_AGENCY_MAX_TEXT_CHARS,
    ),
    currentMetrics: normalizeMetrics(source.currentMetrics, 'currentMetrics'),
    brandVoice: normalizeOptionalText(source.brandVoice, 'brandVoice', CONTENT_AGENCY_MAX_TEXT_CHARS),
    notes: normalizeOptionalText(source.notes, 'notes', CONTENT_AGENCY_MAX_TEXT_CHARS),
  };
}

function normalizeCompetitors(
  value: unknown,
  field: string,
): NonNullable<ContentAgencyCompetitorInput['competitors']> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ContentAgencyValidationError(`${field} must be an array.`, field);
  }
  if (value.length > CONTENT_AGENCY_MAX_COMPETITORS) {
    throw new ContentAgencyValidationError(
      `${field} must contain at most ${CONTENT_AGENCY_MAX_COMPETITORS} entries.`,
      field,
    );
  }
  return value.map((candidate, index) => {
    const itemField = `${field}[${index}]`;
    const item = requireRecord(candidate, itemField);
    const url = normalizeOptionalText(item.url, `${itemField}.url`, 2_048);
    if (url != null) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ContentAgencyValidationError(`${itemField}.url must be a valid http(s) URL.`, `${itemField}.url`);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new ContentAgencyValidationError(`${itemField}.url must use http or https.`, `${itemField}.url`);
      }
      if (parsed.username || parsed.password) {
        throw new ContentAgencyValidationError(`${itemField}.url must not contain credentials.`, `${itemField}.url`);
      }
    }
    return {
      title: normalizeOptionalText(item.title, `${itemField}.title`, CONTENT_AGENCY_MAX_TEXT_CHARS),
      creator: normalizeOptionalText(item.creator, `${itemField}.creator`, CONTENT_AGENCY_MAX_TEXT_CHARS),
      platform: normalizeOptionalText(item.platform, `${itemField}.platform`, 80),
      transcript: normalizeOptionalText(item.transcript, `${itemField}.transcript`, CONTENT_AGENCY_MAX_TRANSCRIPT_CHARS),
      metrics: normalizeMetrics(item.metrics, `${itemField}.metrics`),
      url,
    };
  });
}

function normalizeMetrics(value: unknown, field: string): Record<string, number | string> {
  if (value === undefined || value === null) return {};
  const input = requireRecord(value, field);
  const entries = Object.entries(input);
  if (entries.length > CONTENT_AGENCY_MAX_METRICS) {
    throw new ContentAgencyValidationError(
      `${field} must contain at most ${CONTENT_AGENCY_MAX_METRICS} metrics.`,
      field,
    );
  }
  const normalized: Record<string, number | string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = normalizeRequiredText(rawKey, `${field}.key`, 80);
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new ContentAgencyValidationError(`${field} contains an unsupported metric key.`, field);
    }
    if (typeof rawValue === 'number') {
      if (!Number.isFinite(rawValue)) {
        throw new ContentAgencyValidationError(`${field}.${key} must be finite.`, `${field}.${key}`);
      }
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === 'string') {
      const metric = normalizeRequiredText(rawValue, `${field}.${key}`, 64);
      const numericText = metric.endsWith('%') ? metric.slice(0, -1).trim() : metric;
      const numeric = Number(numericText);
      if (!numericText || !Number.isFinite(numeric)) {
        throw new ContentAgencyValidationError(`${field}.${key} must be numeric.`, `${field}.${key}`);
      }
      normalized[key] = metric;
      continue;
    }
    throw new ContentAgencyValidationError(
      `${field}.${key} must be a finite number or numeric string.`,
      `${field}.${key}`,
    );
  }
  return normalized;
}

function normalizeStringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxItemChars: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ContentAgencyValidationError(`${field} must be an array of strings.`, field);
  }
  if (value.length > maxItems) {
    throw new ContentAgencyValidationError(`${field} must contain at most ${maxItems} entries.`, field);
  }
  const normalized = value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ContentAgencyValidationError(`${field}[${index}] must be a string.`, `${field}[${index}]`);
    }
    return normalizeRequiredText(entry, `${field}[${index}]`, maxItemChars);
  });
  return [...new Set(normalized)];
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maxChars: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ContentAgencyValidationError(`${field} must be a string.`, field);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  return normalizeRequiredText(normalized, field, maxChars);
}

function normalizeRequiredText(value: string, field: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ContentAgencyValidationError(`${field} must not be empty.`, field);
  }
  if (normalized.length > maxChars) {
    throw new ContentAgencyValidationError(`${field} must contain at most ${maxChars} characters.`, field);
  }
  if (UNSUPPORTED_CONTENT_AGENCY_CONTROL_CHARACTERS.test(normalized)) {
    throw new ContentAgencyValidationError(`${field} contains unsupported control characters.`, field);
  }
  return normalized;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentAgencyValidationError(`${field} must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

export function normalizeContentAgencyArtifactId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string') {
    throw new ContentAgencyValidationError(`${field} must be a string.`, field);
  }
  const normalized = value.trim();
  if (!normalized
    || normalized.length > CONTENT_AGENCY_MAX_ARTIFACT_ID_CHARS
    || !CONTENT_AGENCY_ID_PATTERN.test(normalized)) {
    throw new ContentAgencyValidationError(
      `${field} must contain 1-${CONTENT_AGENCY_MAX_ARTIFACT_ID_CHARS} URL-safe identifier characters.`,
      field,
    );
  }
  return normalized;
}

function normalizeAgencyFormat(value: string | null | undefined, platform: ContentAgencyPlatform): string {
  if (value && value.trim()) {
    const normalized = normalizeAgencyFormatAlias(value);
    if (normalized) return normalized;
  }
  switch (platform) {
    case 'youtube': return 'youtube_long_form';
    case 'youtube_shorts': return 'youtube_shorts';
    case 'tiktok': return 'tiktok';
    case 'instagram_reel': return 'instagram_reel';
    case 'carousel': return 'carousel';
    case 'blog': return 'blog';
    case 'newsletter': return 'newsletter';
    default: return 'generic_script';
  }
}

function normalizeAgencyFormatAlias(value: string): string {
  const underscored = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const start = underscored.startsWith('_') ? 1 : 0;
  const end = underscored.endsWith('_') ? underscored.length - 1 : underscored.length;
  const normalized = underscored.slice(start, Math.max(start, end));
  const aliases: Record<string, string> = {
    youtube: 'youtube_long_form',
    youtube_video: 'youtube_long_form',
    long_form: 'youtube_long_form',
    shorts: 'youtube_shorts',
    youtube_shorts: 'youtube_shorts',
    short_form: 'short_form_video',
    reel: 'instagram_reel',
    reels: 'instagram_reel',
    instagram_reel: 'instagram_reel',
    tiktok: 'tiktok',
    tik_tok: 'tiktok',
    carousel: 'carousel',
    blog: 'blog',
    newsletter: 'newsletter',
  };
  return aliases[normalized] ?? normalized;
}

function normalizeGeneratorContractVersion(value?: string): string {
  if (value !== undefined && typeof value !== 'string') {
    throw new ContentAgencyValidationError('generatorContractVersion must be a string.', 'generatorContractVersion');
  }
  const version = value?.trim() || CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION;
  if (!/^content-agency-package\.v[1-9][0-9]*$/.test(version)) {
    throw new ContentAgencyValidationError(
      'generatorContractVersion must use the content-agency-package.vN form.',
      'generatorContractVersion',
    );
  }
  return version;
}

function cleanText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 600) : fallback;
}

function stableId(prefix: string, ...parts: unknown[]): string {
  const hash = crypto.createHash('sha256').update(canonicalJson(parts)).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}

export function computeContentAgencyArtifactHash(artifact: unknown): string {
  const material = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
    ? Object.fromEntries(
      Object.entries(artifact as Record<string, unknown>)
        .filter(([key]) => key !== 'contentHash' && key !== 'createdAt'),
    )
    : artifact;
  return crypto.createHash('sha256').update(canonicalJson(material)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function numericMetric(metrics: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = metrics[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace('%', '').trim()) : NaN;
    if (Number.isFinite(value)) {
      return value > 1 && value <= 100 ? value / 100 : value;
    }
  }
  return null;
}

function formatMetric(value: number): string {
  return value <= 1 ? `${Math.round(value * 100)}%` : String(value);
}

function inferEmotionalDrivers(text: string): string[] {
  const drivers: string[] = [];
  if (/fear|risk|mistake|avoid|danger|lost|wrong|failure/i.test(text)) drivers.push('loss aversion / risk avoidance');
  if (/surprise|nobody|secret|hidden|unexpected|truth/i.test(text)) drivers.push('surprise / curiosity');
  if (/proud|identity|people like us|creator|founder|athlete/i.test(text)) drivers.push('identity and status');
  if (/relief|simple|finally|easy|clear/i.test(text)) drivers.push('relief and simplicity');
  return drivers;
}

function inferHookMechanisms(text: string): string[] {
  const mechanisms: string[] = [];
  if (/\?/.test(text)) mechanisms.push('direct question');
  if (/not|never|wrong|mistake|myth|contrary/i.test(text)) mechanisms.push('contradiction');
  if (/\b\d+[%x]?\b/.test(text)) mechanisms.push('specific proof or number');
  const normalized = text.toLowerCase();
  const hasFromToTransformation = normalized.split(/[\n\r\u2028\u2029]/u).some((line) => {
    const fromIndex = line.indexOf('from ');
    return fromIndex >= 0 && line.indexOf(' to', fromIndex + 5) >= 0;
  });
  if (normalized.includes('before')
    || normalized.includes('after')
    || normalized.includes('transformation')
    || hasFromToTransformation) {
    mechanisms.push('before/after transformation');
  }
  return mechanisms;
}

function inferPacingPatterns(text: string): string[] {
  const sentenceCount = text.split(/[.!?]+/).filter((part) => part.trim().length > 0).length;
  if (sentenceCount > 18) return ['dense transcript; test visual-reset cadence against the creator retention curve'];
  if (sentenceCount > 7) return ['medium-density transcript; test earlier and later proof placement'];
  if (sentenceCount > 0) return ['short transcript; test payoff-first and context-first variants'];
  return [];
}

function inferOpportunityGaps(
  brief: ContentAgencyBrief | null | undefined,
  competitors: ContentAgencyCompetitorInput['competitors'],
): string[] {
  const platform = brief?.platform ?? 'generic';
  const hasMetrics = competitors?.some((item) => item.metrics && Object.keys(item.metrics).length > 0) ?? false;
  return [
    `Make the ${platform} execution more specific to ${brief?.audience || 'the target audience'}.`,
    hasMetrics ? 'Use competitor metric shape as diagnosis only; do not claim the same result.' : 'Add public performance clues or first-party metrics before making growth claims.',
    'Use a different story and proof point so the idea feels inspired, not copied.',
  ];
}

function inferStructure(text: string): string[] {
  if (!text.trim()) return ['hook', 'promise', 'proof', 'payoff', 'CTA needed'];
  const structure = ['hook'];
  if (/because|why|context|story/i.test(text)) structure.push('context');
  if (/example|proof|data|result|case/i.test(text)) structure.push('proof');
  if (/but|however|turn|then/i.test(text)) structure.push('turn');
  structure.push('payoff');
  structure.push(/comment|follow|subscribe|save|share|dm|link/i.test(text) ? 'CTA' : 'CTA missing');
  return [...new Set(structure)];
}

function inferProofMoments(text: string): string[] {
  const moments = [];
  if (/\b\d+[%x]?\b/.test(text)) moments.push('Specific number or metric appears; verify source before using.');
  if (/example|case|client|I tested|we tested|data/i.test(text)) moments.push('Example/proof language appears; connect it to the audience pain.');
  return moments;
}

function inferRetentionDevices(text: string): string[] {
  const devices = [];
  if (/wait|but|however|then|until|before/i.test(text)) devices.push('open-loop transition');
  if (/\?/.test(text)) devices.push('question reset');
  if (/\b\d+\b/.test(text)) devices.push('specific-number anchor');
  if (devices.length === 0) {
    devices.push('test a pattern interrupt at a creator-selected transition against the retention curve');
  }
  return devices;
}

function hasConcreteContentAgencyCompetitorEvidence(
  study: ContentAgencyCompetitorPatternStudy,
): boolean {
  return study.sourceTrace.some((entry) => (
    entry.startsWith('user_supplied_competitor_transcript:')
    || entry.startsWith('user_supplied_competitor_metrics:')
  ));
}

function buildAudienceInsight(brief: ContentAgencyBrief): string {
  if (brief.missingFacts.includes('audience')) {
    return 'Audience is under-specified. Ask who this is for before finalizing creative.';
  }
  return `${brief.audience} likely needs a clear reason to care now, proof that the advice fits their situation, and a next step that feels achievable.`;
}

function buildPositioning(brief: ContentAgencyBrief): ContentAgencyPackage['positioning'] {
  const audience = brief.missingFacts.includes('audience') ? 'the intended audience' : brief.audience;
  return {
    category: `${brief.platform} ${brief.format} for ${audience}`,
    strategicEnemy: 'generic advice that sounds polished but does not change behavior',
    promise: brief.goal === 'Clarify the creator goal'
      ? 'Clarify the promise before publishing.'
      : `Help ${audience} move toward: ${brief.goal}.`,
    proofLibrary: [
      'first-party creator experience',
      'authorized references',
      'platform-specific performance signals',
    ],
    brandVoice: brief.brandVoice ?? 'clear, specific, useful, and accountable',
  };
}

function buildHookBank(brief: ContentAgencyBrief, study: ContentAgencyCompetitorPatternStudy): ContentAgencyHook[] {
  const audience = brief.missingFacts.includes('audience') ? 'your audience' : brief.audience;
  const goal = brief.goal === 'Clarify the creator goal' ? 'this problem' : brief.goal;
  return [
    {
      mechanism: 'contradiction',
      hook: `If ${goal} feels backwards for ${audience}, test this alternative path.`,
      whyItWorks: 'Working hypothesis: a contradiction may create useful tension; validate it against the creator baseline.',
      risk: brief.missingFacts.includes('audience') ? 'Audience is too broad; sharpen before publishing.' : null,
    },
    {
      mechanism: 'proof',
      hook: `I would not start with more content. I would fix this one bottleneck first.`,
      whyItWorks: 'Working hypothesis: a specific operating recommendation may outperform generic consistency advice for this audience.',
      risk: 'Needs one concrete proof point before final script approval.',
    },
    {
      mechanism: 'identity',
      hook: `If you are building like ${audience}, this is the content system I would protect.`,
      whyItWorks: 'Working hypothesis: identity framing may make the intended audience recognize the relevance sooner.',
      risk: null,
    },
    {
      mechanism: study.hookMechanisms[0] ?? 'open loop',
      hook: 'Test this operating hypothesis: the bottleneck may be the gap between an idea and publishable proof.',
      whyItWorks: 'Working hypothesis: naming an execution gap may create an open loop without claiming it is universally causal.',
      risk: null,
    },
  ];
}

function buildScriptVariants(
  brief: ContentAgencyBrief,
  hooks: ContentAgencyHook[],
  study: ContentAgencyCompetitorPatternStudy,
): ContentAgencyScriptVariant[] {
  return [
    {
      id: stableId('script_a', brief.id),
      title: 'Proof-first original angle',
      coldOpen: hooks[0].hook,
      promise: `Show ${brief.audience} the specific decision that improves ${brief.objective}, with timing chosen for the requested format.`,
      beats: [
        'Name the tension in one sentence.',
        'Show the mistake or old way.',
        'Give one proof point or example.',
        'Reveal the operating rule.',
        'Show the first action to take today.',
      ],
      payoff: 'Viewer leaves with one concrete system, not just motivation.',
      cta: 'Save this and test the first step before making more content.',
      retentionDevices: ['opening contradiction to test', 'proof-placement test', 'checklist payoff'],
      originalityNote: 'Uses a different angle, proof, and execution from competitor inputs; do not copy source phrasing.',
    },
    {
      id: stableId('script_b', brief.id),
      title: 'Audience pain to transformation',
      coldOpen: hooks[2].hook,
      promise: `Turn the audience pain into a small, visible transformation.`,
      beats: [
        `Start with the audience identity: ${brief.audience}.`,
        `Name the practical obstacle.`,
        'Contrast the common approach with the proposed approach.',
        `Add a visual proof moment.`,
        `Close with one action and one metric to watch.`,
      ],
      payoff: 'Viewer understands what changed, why it matters, and what to do next.',
      cta: 'Comment with the bottleneck you want diagnosed next.',
      retentionDevices: [...study.pacingPatterns, 'visual before/after'],
      originalityNote: 'Original concept generated from pattern-level study, not copied wording or visual identity.',
    },
  ];
}

function buildCreativeDirection(brief: ContentAgencyBrief): ContentAgencyCreativeDirection {
  const platformRules = getContentAgencyRulesByCategory(
    brief.platform === 'tiktok' ? 'tiktok_native_creative'
      : brief.platform === 'instagram_reel' ? 'instagram_meta_ranking'
        : brief.platform === 'youtube' || brief.platform === 'youtube_shorts' ? 'youtube_discovery_analytics'
          : 'editing_production',
  );
  const vertical = brief.platform === 'tiktok' || brief.platform === 'instagram_reel' || brief.platform === 'youtube_shorts';
  return {
    firstFrame: vertical
      ? 'Test a first frame with the creator on screen, a problem text overlay, and a visible proof object.'
      : 'Open with the core tension in the title/thumbnail and test how early the spoken promise should be repeated against retention data.',
    shotList: [
      'Creator states the tension directly.',
      'Cut to proof, screen, product, notebook, or real example.',
      'Show the recommended system or transformation.',
      'Close with the one action the viewer should take.',
    ],
    broll: ['before/after proof', 'process detail', 'audience-context visual'],
    captions: ['test a legible first-frame promise', 'caption rhythm matched to the selected format', 'highlight the action step'],
    soundDirection: platformRules[0]?.category === 'tiktok_native_creative'
      ? 'Use native sound or trend-adjacent rhythm only when it supports the message.'
      : 'Use subtle sound design to mark transitions; avoid music that distracts from proof.',
    editingPlan: [
      'Compare a concise setup with the current cut.',
      'Place attention resets at transitions selected from the creator retention curve.',
      'Move proof earlier when creator evidence shows the setup is losing attention.',
      'Test one primary CTA unless the brief explicitly requires multiple actions.',
    ],
    productionComplexity: vertical ? 'low' : 'medium',
  };
}

function buildComplianceReview(input: {
  brandedContent: boolean;
  outputText: string;
  untrustedSourceText: string;
  warnings: string[];
}): ContentAgencyComplianceReview {
  const blockers: string[] = [];
  const warnings = [...input.warnings];
  if (input.brandedContent) blockers.push('sponsored_or_branded_content_requires_clear_disclosure');
  if (/copy this|same script|same words|use exact/i.test(input.outputText)) blockers.push('copying_competitor_creative_blocked');
  if (/guaranteed|always works|will go viral|fair use guaranteed/i.test(input.outputText)) blockers.push('unsupported_or_overconfident_claim_blocked');
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(input.untrustedSourceText))) blockers.push('untrusted_source_instruction_blocked');
  if (/copyrighted song|use their thumbnail|same visual/i.test(input.outputText)) warnings.push('copyright_or_visual_identity_review_required');
  return {
    status: blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'pass',
    blockers,
    warnings,
    disclosureRequired: input.brandedContent,
    copyrightRisk: warnings.includes('copyright_or_visual_identity_review_required') ? 'medium' : 'low',
    originalityRisk: blockers.includes('copying_competitor_creative_blocked') ? 'high' : 'low',
    notes: [
      'This is product risk screening, not legal advice.',
      'Use competitor inputs for pattern study only; final creative needs distinct wording, story, proof, and execution.',
    ],
  };
}

function buildExperimentPlan(brief: ContentAgencyBrief): ContentAgencyExperimentPlan {
  const metric = brief.platform === 'youtube'
    ? 'intro retention and average view duration'
    : brief.platform === 'carousel'
      ? 'saves and shares'
      : brief.platform === 'blog'
        ? 'qualified clicks and scroll depth'
        : 'hold rate and shares';
  return {
    hypothesis: `If the first frame names a concrete ${brief.audience} pain and proves the payoff early, ${metric} should improve.`,
    variables: ['hook mechanism', 'first-frame visual', 'proof timing'],
    primaryMetric: metric,
    secondaryMetrics: ['comments quality', 'follow/conversion rate', 'saves or shares'],
    interpretation: [
      'Above-baseline CTR with below-baseline retention is a hypothesis that packaging overpromised or the intro underdelivered.',
      'Below-baseline CTR with above-baseline retention is a hypothesis that title, thumbnail, first frame, or search language needs work.',
      'Above-baseline retention with below-baseline conversion is a hypothesis that CTA, offer, or positioning needs review.',
    ],
  };
}

function buildPerformanceDiagnosis(brief: ContentAgencyBrief): ContentAgencyPerformanceDiagnosis {
  const metrics = brief.currentMetrics ?? {};
  const ctr = numericMetric(metrics, ['ctr', 'clickThroughRate', 'thumbnailCtr']);
  const retention = numericMetric(metrics, ['retention', 'holdRate', 'averageViewPercentage']);
  const conversion = numericMetric(metrics, ['conversionRate', 'signupRate', 'leadRate']);
  const ctrBaseline = numericMetric(metrics, ['ctrBaseline', 'baselineCtr', 'channelCtrBaseline']);
  const retentionBaseline = numericMetric(metrics, [
    'retentionBaseline',
    'baselineRetention',
    'channelRetentionBaseline',
  ]);
  const conversionBaseline = numericMetric(metrics, [
    'conversionBaseline',
    'baselineConversionRate',
    'channelConversionBaseline',
  ]);

  if (ctr != null && retention != null && ctrBaseline != null && retentionBaseline != null
      && ctr > ctrBaseline && retention < retentionBaseline) {
    return {
      summary: 'Packaging is above the supplied comparison baseline, while retention is below it.',
      likelyBottleneck: 'high CTR with low retention',
      evidence: [
        `CTR ${formatMetric(ctr)} vs baseline ${formatMetric(ctrBaseline)}`,
        `retention ${formatMetric(retention)} vs baseline ${formatMetric(retentionBaseline)}`,
      ],
      recommendedTest: 'Keep the title/first-frame direction, but test a proof-before-context opening against the current version.',
      metricsToWatch: ['opening hold at the selected checkpoint', 'retention curve', 'average view duration'],
      uncertainty: 'This is a user-supplied baseline comparison, not a universal platform benchmark; confirm comparable format, audience, sample size, and traffic source.',
    };
  }
  if (ctr != null && retention != null && ctrBaseline != null && retentionBaseline != null
      && ctr < ctrBaseline && retention > retentionBaseline) {
    return {
      summary: 'Retention is above the supplied comparison baseline, while packaging response is below it.',
      likelyBottleneck: 'low CTR with high retention',
      evidence: [
        `CTR ${formatMetric(ctr)} vs baseline ${formatMetric(ctrBaseline)}`,
        `retention ${formatMetric(retention)} vs baseline ${formatMetric(retentionBaseline)}`,
      ],
      recommendedTest: 'Run a packaging test with a more specific pain, proof, or consequence in the first frame.',
      metricsToWatch: ['CTR', 'first-frame hold', 'qualified comments'],
      uncertainty: 'This is a user-supplied baseline comparison; verify comparable format, audience segment, sample size, and traffic source.',
    };
  }
  if (retention != null && conversion != null && retentionBaseline != null && conversionBaseline != null
      && retention > retentionBaseline && conversion < conversionBaseline) {
    return {
      summary: 'Retention is above the supplied comparison baseline, while conversion is below it.',
      likelyBottleneck: 'high retention with low conversion',
      evidence: [
        `retention ${formatMetric(retention)} vs baseline ${formatMetric(retentionBaseline)}`,
        `conversion ${formatMetric(conversion)} vs baseline ${formatMetric(conversionBaseline)}`,
      ],
      recommendedTest: 'Make the CTA more concrete and tie the offer to the payoff demonstrated in the content.',
      metricsToWatch: ['CTA click rate', 'qualified replies', 'conversion rate'],
      uncertainty: 'This is a user-supplied baseline comparison and does not establish revenue or attribution.',
    };
  }
  return {
    summary: 'Not enough comparable performance evidence is available for a directional diagnosis.',
    likelyBottleneck: 'insufficient or incomparable metrics',
    evidence: Object.keys(metrics).length > 0
      ? ['Metrics were supplied without a comparable baseline or did not show an opposing baseline pattern.']
      : ['No current metrics supplied.'],
    recommendedTest: 'Run one controlled variant and review CTR, retention, saves/shares, comments, and conversion in a user-selected window against a comparable baseline.',
    metricsToWatch: [brief.platform === 'youtube' ? 'CTR' : 'first-frame hold', 'retention', 'saves or shares', 'conversion'],
    uncertainty: 'No universal platform threshold was inferred; diagnosis needs comparable format, audience, sample-size, and traffic-source context.',
  };
}

function matchedRuleIds(brief: ContentAgencyBrief): string[] {
  const platformCategory = brief.platform === 'tiktok'
    ? 'tiktok_native_creative'
    : brief.platform === 'instagram_reel' || brief.platform === 'carousel'
      ? 'instagram_meta_ranking'
      : brief.platform === 'youtube' || brief.platform === 'youtube_shorts'
        ? 'youtube_discovery_analytics'
        : brief.platform === 'blog' || brief.platform === 'newsletter'
          ? 'google_search_helpful_content'
          : 'editing_production';
  return [
    ...getContentAgencyRulesByCategory(platformCategory),
    ...getContentAgencyRulesByCategory('human_behavior_story'),
    ...getContentAgencyRulesByCategory('compliance_policy'),
    ...getContentAgencyRulesByCategory('brand_positioning'),
  ].map((rule) => `candidate_rule:${rule.id}`);
}

function flattenPackageText(input: {
  hookBank: ContentAgencyHook[];
  scriptVariants: ContentAgencyScriptVariant[];
  creativeDirection: ContentAgencyCreativeDirection;
}): string {
  return [
    ...input.hookBank.map((hook) => `${hook.mechanism} ${hook.hook} ${hook.whyItWorks}`),
    ...input.scriptVariants.map((script) => `${script.title} ${script.coldOpen} ${script.promise} ${script.beats.join(' ')} ${script.payoff} ${script.cta}`),
    input.creativeDirection.firstFrame,
    input.creativeDirection.shotList.join(' '),
  ].join('\n');
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

const TABLE_BY_KIND: Record<PersistKind, string> = {
  brief: 'content_agency_briefs',
  competitor_study: 'content_competitor_studies',
  transcript_study: 'content_transcript_studies',
  package: 'content_agency_packages',
  compliance_review: 'content_compliance_reviews',
  experiment_run: 'content_experiment_runs',
  quality_review: 'content_agency_quality_reviews',
};

function tableForKind(kind: PersistKind): string {
  return TABLE_BY_KIND[kind];
}
