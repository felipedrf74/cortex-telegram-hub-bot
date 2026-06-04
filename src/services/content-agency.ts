// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import {
  getContentAgencyRulesByCategory,
  listContentAgencyRules,
  validateContentAgencyRuleCoverage,
  validateContentAgencyRuntimeRuleCoverage,
} from './content-agency-rules';

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
  requestedOutput?: string | null;
}

export interface ContentAgencyPackage {
  id: string;
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

export interface ContentAgencyPipelineHandoffResult {
  packageId: string;
  status: 'created' | 'already_exists' | 'blocked' | 'not_found';
  pipelineId: number | null;
  blockers: string[];
  warnings: string[];
  nextBestActions: string[];
  sourceTrace: string[];
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
  /ignore (the|all|previous|above) instructions/i,
  /disregard (the|all|previous|above)/i,
  /you are now/i,
  /<\|im_start\|>/i,
  /<system>/i,
];

export function normalizeAgencyPlatform(value?: string | null): ContentAgencyPlatform {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
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
  const platform = normalizeAgencyPlatform(input.platform ?? input.format);
  const format = normalizeAgencyFormat(input.format, platform);
  const goal = cleanText(input.goal, 'Clarify the creator goal');
  const audience = cleanText(input.audience, 'Define the target audience');
  const objective = cleanText(input.objective, goal !== 'Clarify the creator goal' ? goal : 'Build a useful content package');
  const missingFacts = [
    goal === 'Clarify the creator goal' ? 'goal' : null,
    audience === 'Define the target audience' ? 'audience' : null,
    platform === 'generic' ? 'platform' : null,
    !input.offer ? 'offer_or_call_to_action' : null,
  ].filter(Boolean) as string[];
  const sourceTrace = [
    'Content creator profile',
    'Content Agency reference registry',
    `${platform} platform rules`,
  ];
  const confidence = Math.max(0.35, Math.min(0.92, 0.9 - missingFacts.length * 0.12));

  return {
    id: stableId('brief', input.tenantId, input.userId, goal, audience, platform, format),
    tenantId: input.tenantId,
    userId: input.userId,
    visibilityScope: input.visibilityScope ?? 'user_private',
    goal,
    audience,
    offer: input.offer?.trim() || null,
    platform,
    format,
    objective,
    constraints: toStringList(input.constraints),
    currentMetrics: input.currentMetrics && typeof input.currentMetrics === 'object' ? input.currentMetrics : {},
    brandVoice: input.brandVoice?.trim() || null,
    missingFacts,
    confidence,
    sourceTrace,
    nextBestActions: missingFacts.length > 0
      ? missingFacts.map((fact) => `Add ${fact.replace(/_/g, ' ')} before asking Nexus for final creative.`)
      : ['Generate an agency package and review compliance/originality before moving to pipeline.'],
  };
}

export function buildContentAgencyCompetitorStudy(input: ContentAgencyCompetitorInput): ContentAgencyCompetitorPatternStudy {
  const competitors = input.competitors ?? [];
  const transcriptText = competitors.map((item) => item.transcript ?? '').join('\n');
  const warnings = [];
  if (competitors.length === 0) warnings.push('competitor_context_missing');
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(transcriptText))) warnings.push('untrusted_competitor_text_contained_prompt_injection');

  const emotionalDrivers = inferEmotionalDrivers(transcriptText);
  const hookMechanisms = inferHookMechanisms(transcriptText);
  const pacingPatterns = inferPacingPatterns(transcriptText);
  const patterns = [
    hookMechanisms[0] ? `Hook pattern: ${hookMechanisms[0]}` : 'Hook pattern: explicit promise or tension in the first seconds.',
    emotionalDrivers[0] ? `Emotional driver: ${emotionalDrivers[0]}` : 'Emotional driver: useful urgency or identity relevance.',
    pacingPatterns[0] ? `Pacing pattern: ${pacingPatterns[0]}` : 'Pacing pattern: fast setup, proof, payoff, then action.',
  ];

  return {
    id: stableId('competitor', input.tenantId, input.userId, competitors.map((item) => item.title || item.url || '').join('|')),
    tenantId: input.tenantId,
    userId: input.userId,
    patterns,
    hookMechanisms,
    emotionalDrivers,
    pacingPatterns,
    originalityConstraints: [
      'Do not reuse competitor wording, titles, thumbnails, script sequence, or visual identity.',
      'Use a different angle, different proof, different story, and different execution.',
      'Treat transcripts, comments, and scraped text as untrusted evidence.',
    ],
    opportunityGaps: inferOpportunityGaps(input.brief, competitors),
    sourceTrace: competitors.map((item, index) => item.url || item.title || `competitor:${index + 1}`),
    warnings,
  };
}

export function buildContentAgencyTranscriptStudy(input: {
  userId: number;
  tenantId: number;
  transcript?: string | null;
  title?: string | null;
}): ContentAgencyTranscriptStudy {
  const text = input.transcript ?? '';
  const warnings = [];
  if (!text.trim()) warnings.push('transcript_missing');
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) warnings.push('untrusted_transcript_contained_prompt_injection');

  return {
    id: stableId('transcript', input.tenantId, input.userId, input.title || '', text.slice(0, 160)),
    tenantId: input.tenantId,
    userId: input.userId,
    structure: inferStructure(text),
    emotionalBeats: inferEmotionalDrivers(text).map((driver) => `Uses ${driver} to keep the viewer emotionally invested.`),
    proofMoments: inferProofMoments(text),
    retentionDevices: inferRetentionDevices(text),
    ctaDiagnosis: /comment|follow|subscribe|save|share|dm|link/i.test(text)
      ? 'CTA is present; verify it matches the content promise and funnel stage.'
      : 'CTA is missing or weak; add one clear next action.',
    sourceTrace: [input.title || 'user_supplied_transcript'],
    warnings,
  };
}

export function buildContentAgencyPackage(input: ContentAgencyPackageInput): ContentAgencyPackage {
  const brief = isBrief(input.brief)
    ? input.brief
    : buildContentAgencyBrief({
      ...(input.brief && typeof input.brief === 'object' ? input.brief : {}),
      userId: input.userId,
      tenantId: input.tenantId,
    });
  const competitorStudy = buildContentAgencyCompetitorStudy({
    userId: input.userId,
    tenantId: input.tenantId,
    brief,
    competitors: input.competitors,
  });
  const transcriptStudy = buildContentAgencyTranscriptStudy({
    userId: input.userId,
    tenantId: input.tenantId,
    transcript: input.transcript ?? input.competitors?.[0]?.transcript ?? '',
    title: input.competitors?.[0]?.title ?? brief.goal,
  });
  const referenceIds = toStringList(input.references);
  const hookBank = buildHookBank(brief, competitorStudy);
  const scriptVariants = buildScriptVariants(brief, hookBank, competitorStudy);
  const creativeDirection = buildCreativeDirection(brief);
  const complianceReview = buildComplianceReview({
    brandedContent: input.brandedContent === true,
    outputText: flattenPackageText({ hookBank, scriptVariants, creativeDirection }),
    competitorText: input.competitors?.map((item) => item.transcript ?? item.title ?? '').join('\n') ?? '',
    warnings: [...competitorStudy.warnings, ...transcriptStudy.warnings],
  });
  const experimentPlan = buildExperimentPlan(brief);
  const performanceDiagnosis = buildPerformanceDiagnosis(brief);
  const sourceTrace = [
    ...brief.sourceTrace,
    ...competitorStudy.sourceTrace,
    ...transcriptStudy.sourceTrace,
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

  return {
    id: stableId('package', input.tenantId, input.userId, brief.id, JSON.stringify(input.competitors ?? []), input.transcript ?? ''),
    tenantId: input.tenantId,
    userId: input.userId,
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
    sourceTrace: [...new Set(sourceTrace)],
    referenceIds,
    confidence: Math.max(0.35, Math.min(0.95, (brief.confidence + quality.score / 100) / 2)),
    warnings,
    blockers,
    reviewRequired: blockers.length > 0 || warnings.length > 0 || complianceReview.status !== 'pass',
    nextBestActions,
    createdAt: new Date().toISOString(),
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
  const dimensions: Record<string, number> = {
    audienceSpecificity: input.brief.missingFacts.includes('audience') ? 35 : 82,
    platformNativeFit: input.brief.platform === 'generic' ? 40 : 86,
    hookStrength: input.hookBank.length >= 4 ? 86 : 55,
    firstFrameClarity: input.creativeDirection.firstFrame.length >= 18 ? 84 : 52,
    narrativeTension: input.scriptVariants[0]?.beats.length >= 4 ? 82 : 58,
    emotionalArousalShareability: input.competitorStudy.emotionalDrivers.length > 0 ? 82 : 58,
    proofDensity: input.transcriptStudy.proofMoments.length > 0 ? 82 : 55,
    originality: input.competitorStudy.originalityConstraints.length >= 3 ? 88 : 60,
    brandConsistency: input.brief.brandVoice || input.brief.audience !== 'Define the target audience' ? 82 : 55,
    complianceSafety: input.complianceReview.status === 'blocked' ? 20 : input.complianceReview.status === 'warning' ? 68 : 90,
    editability: input.creativeDirection.shotList.length >= 3 ? 84 : 58,
    productionFeasibility: input.creativeDirection.productionComplexity === 'high' ? 64 : 86,
    claimGrounding: input.complianceReview.blockers.includes('unsupported_or_overconfident_claim_blocked') ? 30 : 88,
    experimentClarity: input.sourceTrace.length >= 3 ? 82 : 55,
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
  if (input.hookBank.some((hook) => hook.hook.length < 18)) warnings.push('weak_hook_detail');
  if (input.competitorStudy.sourceTrace.length === 0) warnings.push('competitor_evidence_missing');

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

export function persistContentAgencyArtifact(kind: PersistKind, artifact: any): number | null {
  const db = getDb();
  ensureContentAgencyTables(db);
  const table = tableForKind(kind);
  const payload = JSON.stringify(artifact);
  const sourceTrace = JSON.stringify(artifact.sourceTrace ?? []);
  const warnings = JSON.stringify(artifact.warnings ?? artifact.quality?.warnings ?? []);
  const blockers = JSON.stringify(artifact.blockers ?? artifact.quality?.blockers ?? []);
  const result = db.prepare(`
    INSERT INTO ${table} (
      agency_id, user_id, tenant_id, visibility_scope, platform, format, status,
      source_trace_json, quality_score, warnings_json, blockers_json, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, agency_id) DO UPDATE SET
      visibility_scope = excluded.visibility_scope,
      platform = excluded.platform,
      format = excluded.format,
      status = excluded.status,
      source_trace_json = excluded.source_trace_json,
      quality_score = excluded.quality_score,
      warnings_json = excluded.warnings_json,
      blockers_json = excluded.blockers_json,
      payload_json = excluded.payload_json,
      updated_at = datetime('now')
  `).run(
    artifact.id,
    artifact.userId,
    artifact.tenantId,
    artifact.visibilityScope ?? 'user_private',
    artifact.platform ?? artifact.brief?.platform ?? null,
    artifact.format ?? artifact.brief?.format ?? null,
    artifact.status ?? artifact.quality?.status ?? artifact.complianceReview?.status ?? 'draft',
    sourceTrace,
    artifact.quality?.score ?? artifact.qualityScore ?? null,
    warnings,
    blockers,
    payload,
  );
  return Number(result.lastInsertRowid ?? null);
}

export function getContentAgencyProject(input: {
  userId: number;
  tenantId: number;
  id: string;
}): { kind: string; artifact: any } | null {
  const db = getDb();
  ensureContentAgencyTables(db);
  for (const [kind, table] of Object.entries(TABLE_BY_KIND)) {
    const row = db.prepare(`
      SELECT payload_json
        FROM ${table}
       WHERE agency_id = ?
         AND user_id = ?
         AND tenant_id = ?
       ORDER BY id DESC
       LIMIT 1
    `).get(input.id, input.userId, input.tenantId) as { payload_json: string } | undefined;
    if (row) return { kind, artifact: JSON.parse(row.payload_json) };
  }
  return null;
}

export function handoffContentAgencyPackageToPipeline(input: {
  userId: number;
  tenantId: number;
  packageId: string;
}): ContentAgencyPipelineHandoffResult {
  const db = getDb();
  ensureContentAgencyTables(db);
  ensureAgencyPipelineHandoffSchema(db);

  const project = getContentAgencyProject({
    userId: input.userId,
    tenantId: input.tenantId,
    id: input.packageId,
  });
  if (!project || project.kind !== 'package') {
    return {
      packageId: input.packageId,
      status: 'not_found',
      pipelineId: null,
      blockers: ['content_agency_package_not_found'],
      warnings: [],
      nextBestActions: ['Generate or reopen the agency package before moving it to the pipeline.'],
      sourceTrace: ['Content Agency package store'],
    };
  }

  const pkg = project.artifact as ContentAgencyPackage;
  const blockers = Array.isArray(pkg.blockers) ? pkg.blockers : [];
  if (blockers.length > 0 || pkg.quality?.status === 'blocked') {
    return {
      packageId: pkg.id,
      status: 'blocked',
      pipelineId: null,
      blockers: blockers.length > 0 ? blockers : ['content_agency_quality_blocked'],
      warnings: Array.isArray(pkg.warnings) ? pkg.warnings : [],
      nextBestActions: blockers.map((blocker) => `Resolve blocker: ${humanize(blocker)}.`),
      sourceTrace: [...(pkg.sourceTrace ?? []), 'Content pipeline handoff gate'],
    };
  }

  const existing = db.prepare(`
    SELECT id
      FROM content_pipeline
     WHERE source_agency_package_id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND scope_status = 'active'
     ORDER BY id DESC
     LIMIT 1
  `).get(pkg.id, input.userId, input.tenantId) as { id: number } | undefined;
  if (existing) {
    return {
      packageId: pkg.id,
      status: 'already_exists',
      pipelineId: Number(existing.id),
      blockers: [],
      warnings: Array.isArray(pkg.warnings) ? pkg.warnings : [],
      nextBestActions: ['Open the existing pipeline item and continue editorial review.'],
      sourceTrace: [...(pkg.sourceTrace ?? []), 'Existing content pipeline item'],
    };
  }

  const now = new Date().toISOString();
  const topicTitle = truncate(`Agency: ${pkg.objective || pkg.brief?.goal || 'Creator package'}`, 180);
  const niche = truncate(`${pkg.platform || 'content'} · ${pkg.brief?.audience || 'target audience'}`, 160);
  const warnings = Array.isArray(pkg.warnings) ? pkg.warnings : [];
  const reviewRequired = Boolean(pkg.reviewRequired)
    || warnings.length > 0
    || pkg.quality?.status === 'warning'
    || pkg.complianceReview?.status === 'warning';
  const pipelineStage = reviewRequired ? 'review' : 'approved';
  const editorialState = reviewRequired ? 'review' : 'selected';
  const approvalState = reviewRequired ? 'pending' : 'approved';
  const approvedBy = reviewRequired ? null : input.userId;
  const approvedAt = reviewRequired ? null : now;
  const stageHistory = JSON.stringify([
    {
      at: now,
      action: 'content_agency_handoff',
      from: 'content_agency_package',
      to: reviewRequired ? 'content_pipeline_review' : 'content_pipeline',
      agencyPackageId: pkg.id,
      qualityScore: pkg.quality?.score ?? null,
      platform: pkg.platform,
      reviewRequired,
    },
  ]);

  const result = db.prepare(`
    INSERT INTO content_pipeline (
      topic_title, niche, stage, stage_history, user_id, tenant_id, owner_user_id,
      visibility_scope, scope_status, editorial_state, approval_state, review_required,
      approved_by, approved_at, source_agency_package_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    topicTitle,
    niche,
    pipelineStage,
    stageHistory,
    input.userId,
    input.tenantId,
    input.userId,
    pkg.visibilityScope ?? 'user_private',
    editorialState,
    approvalState,
    reviewRequired ? 1 : 0,
    approvedBy,
    approvedAt,
    pkg.id,
    now,
    now,
  );
  const pipelineId = Number(result.lastInsertRowid);
  const readBack = db.prepare(`
    SELECT id, user_id, tenant_id, owner_user_id, visibility_scope, approval_state,
           review_required, approved_by, approved_at, source_agency_package_id
      FROM content_pipeline
     WHERE id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND owner_user_id = ?
       AND source_agency_package_id = ?
       AND scope_status = 'active'
       AND approval_state = ?
       AND review_required = ?
     LIMIT 1
  `).get(
    pipelineId,
    input.userId,
    input.tenantId,
    input.userId,
    pkg.id,
    approvalState,
    reviewRequired ? 1 : 0,
  ) as {
    id: number;
    user_id: number;
    tenant_id: number;
    owner_user_id: number;
    visibility_scope: string;
    approval_state: string;
    review_required: number;
    approved_by: number | null;
    approved_at: string | null;
    source_agency_package_id: string;
  } | undefined;
  if (readBack && reviewRequired && (readBack.approved_by != null || readBack.approved_at != null)) {
    throw new Error('Content agency pipeline handoff read-back failed');
  }
  if (!readBack) {
    throw new Error('Content agency pipeline handoff read-back failed');
  }
  return {
    packageId: pkg.id,
    status: 'created',
    pipelineId: Number(readBack.id),
    blockers: [],
    warnings,
    nextBestActions: reviewRequired
      ? ['Open the pipeline item, complete editorial review, and approve only after resolving warnings.']
      : ['Open the pipeline item, approve filming/script work, and keep the experiment metric attached.'],
    sourceTrace: [...(pkg.sourceTrace ?? []), 'content_pipeline read-back verified'],
  };
}

export function buildCriticalUserReview(input: {
  brief: ContentAgencyBrief;
  quality: ContentAgencyQualityResult;
  hooks: ContentAgencyHook[];
  scripts: ContentAgencyScriptVariant[];
  complianceReview: ContentAgencyComplianceReview;
}): ContentAgencyCriticalUserReview {
  const issues: string[] = [];
  const canExtractNextStep = input.quality.blockers.length === 0 && input.scripts.some((script) => Boolean(script.cta));
  const canExplainWhy = input.hooks.every((hook) => hook.whyItWorks.length > 10);
  const seesEvidence = input.brief.sourceTrace.length > 0;
  const seesOriginality = input.scripts.every((script) => /different angle|original|not copy/i.test(script.originalityNote));
  const seesRisks = input.complianceReview.warnings.length > 0 || input.complianceReview.blockers.length > 0 || input.brief.missingFacts.length > 0;
  const rejectsAsGeneric = input.hooks.some((hook) => /post consistently|be authentic|add value/i.test(hook.hook));

  if (!canExtractNextStep) issues.push('I cannot tell what to do next.');
  if (!canExplainWhy) issues.push('The recommendation lacks evidence or reasoning.');
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

function ensureAgencyPipelineHandoffSchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_pipeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_feedback_id INTEGER,
      topic_title TEXT NOT NULL,
      niche TEXT,
      stage TEXT NOT NULL DEFAULT 'approved',
      script_path TEXT,
      drive_url TEXT,
      youtube_video_id TEXT,
      stage_history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const columns = new Set((db.prepare(`PRAGMA table_info(content_pipeline)`).all() as Array<{ name: string }>).map((row) => row.name));
  const addColumn = (name: string, definition: string) => {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE content_pipeline ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    }
  };
  addColumn('user_id', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('tenant_id', 'INTEGER');
  addColumn('owner_user_id', 'INTEGER');
  addColumn('visibility_scope', 'TEXT');
  addColumn('scope_status', "TEXT DEFAULT 'active'");
  addColumn('editorial_state', "TEXT DEFAULT 'selected'");
  addColumn('approval_state', "TEXT DEFAULT 'not_required'");
  addColumn('review_required', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('approved_by', 'INTEGER');
  addColumn('approved_at', 'TEXT');
  addColumn('source_agency_package_id', 'TEXT');
  addColumn('published_url', 'TEXT');
  addColumn('published_at', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_content_pipeline_agency_package
      ON content_pipeline(tenant_id, user_id, source_agency_package_id, scope_status);
  `);
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

function normalizeAgencyFormat(value: string | null | undefined, platform: ContentAgencyPlatform): string {
  if (value && value.trim()) return normalizeAgencyFormatAlias(value);
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
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function cleanText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 600) : fallback;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 20);
}

function stableId(prefix: string, ...parts: unknown[]): string {
  const hash = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
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

function isBrief(value: unknown): value is ContentAgencyBrief {
  return Boolean(value && typeof value === 'object' && typeof (value as any).id === 'string' && Array.isArray((value as any).missingFacts));
}

function inferEmotionalDrivers(text: string): string[] {
  const drivers: string[] = [];
  if (/fear|risk|mistake|avoid|danger|lost|wrong|failure/i.test(text)) drivers.push('loss aversion / risk avoidance');
  if (/surprise|nobody|secret|hidden|unexpected|truth/i.test(text)) drivers.push('surprise / curiosity');
  if (/proud|identity|people like us|creator|founder|athlete/i.test(text)) drivers.push('identity and status');
  if (/relief|simple|finally|easy|clear/i.test(text)) drivers.push('relief and simplicity');
  return drivers.length ? drivers : ['curiosity and useful urgency'];
}

function inferHookMechanisms(text: string): string[] {
  const mechanisms: string[] = [];
  if (/\?/.test(text)) mechanisms.push('direct question');
  if (/not|never|wrong|mistake|myth|contrary/i.test(text)) mechanisms.push('contradiction');
  if (/\b\d+[%x]?\b/.test(text)) mechanisms.push('specific proof or number');
  if (/before|after|from .* to|transformation/i.test(text)) mechanisms.push('before/after transformation');
  return mechanisms.length ? mechanisms : ['clear promise with an open loop'];
}

function inferPacingPatterns(text: string): string[] {
  const sentenceCount = text.split(/[.!?]+/).filter((part) => part.trim().length > 0).length;
  if (sentenceCount > 18) return ['dense pacing that needs visual resets every 2–3 beats'];
  if (sentenceCount > 7) return ['medium pacing with proof before the midpoint'];
  return ['short pacing; lead with the payoff and add one proof beat'];
}

function inferOpportunityGaps(
  brief: ContentAgencyBriefInput | ContentAgencyBrief | null | undefined,
  competitors: ContentAgencyCompetitorInput['competitors'],
): string[] {
  const platform = isBrief(brief) ? brief.platform : normalizeAgencyPlatform(brief?.platform);
  const hasMetrics = competitors?.some((item) => item.metrics && Object.keys(item.metrics).length > 0) ?? false;
  return [
    `Make the ${platform} execution more specific to ${isBrief(brief) ? brief.audience : brief?.audience || 'the target audience'}.`,
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
  if (moments.length === 0) moments.push('Proof is thin; add one concrete example, before/after, or source-backed insight.');
  return moments;
}

function inferRetentionDevices(text: string): string[] {
  const devices = [];
  if (/wait|but|however|then|until|before/i.test(text)) devices.push('open-loop transition');
  if (/\?/.test(text)) devices.push('question reset');
  if (/\b\d+\b/.test(text)) devices.push('specific-number anchor');
  if (devices.length === 0) devices.push('add pattern interrupt before the midpoint');
  return devices;
}

function buildAudienceInsight(brief: ContentAgencyBrief): string {
  if (brief.missingFacts.includes('audience')) {
    return 'Audience is under-specified. Nexus should ask who this is for before finalizing creative.';
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
      hook: `Most ${audience} solve ${goal} backwards. Here is the cleaner path.`,
      whyItWorks: 'Contradiction creates tension while promising a useful correction.',
      risk: brief.missingFacts.includes('audience') ? 'Audience is too broad; sharpen before publishing.' : null,
    },
    {
      mechanism: 'proof',
      hook: `I would not start with more content. I would fix this one bottleneck first.`,
      whyItWorks: 'A specific operating recommendation feels more useful than generic consistency advice.',
      risk: 'Needs one concrete proof point before final script approval.',
    },
    {
      mechanism: 'identity',
      hook: `If you are building like ${audience}, this is the content system I would protect.`,
      whyItWorks: 'Identity framing makes the viewer feel the advice was made for them.',
      risk: null,
    },
    {
      mechanism: study.hookMechanisms[0] ?? 'open loop',
      hook: `The hidden cost is not the idea. It is the gap between idea and publishable proof.`,
      whyItWorks: 'Creates an open loop and moves the story from inspiration to execution.',
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
      promise: `In the next minute, show ${brief.audience} the specific decision that improves ${brief.objective}.`,
      beats: [
        'Name the tension in one sentence.',
        'Show the mistake or old way.',
        'Give one proof point or example.',
        'Reveal the operating rule.',
        'Show the first action to take today.',
      ],
      payoff: 'Viewer leaves with one concrete system, not just motivation.',
      cta: 'Save this and test the first step before making more content.',
      retentionDevices: ['cold-open contradiction', 'midpoint proof', 'final checklist payoff'],
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
        `Contrast the common approach with Nexus's recommended approach.`,
        `Add a visual proof moment.`,
        `Close with one action and one metric to watch.`,
      ],
      payoff: 'Viewer understands what changed, why it matters, and what to do next.',
      cta: 'Comment with the bottleneck you want Nexus to diagnose next.',
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
      ? 'Start with the creator on screen, problem text overlay, and visible proof object in the first frame.'
      : 'Open with the core tension in the title/thumbnail and repeat that promise in the first 30 seconds.',
    shotList: [
      'Creator states the tension directly.',
      'Cut to proof, screen, product, notebook, or real example.',
      'Show the recommended system or transformation.',
      'Close with the one action the viewer should take.',
    ],
    broll: ['before/after proof', 'process detail', 'audience-context visual'],
    captions: ['large first-frame promise', 'short beat captions', 'highlight the action step'],
    soundDirection: platformRules[0]?.category === 'tiktok_native_creative'
      ? 'Use native sound or trend-adjacent rhythm only when it supports the message.'
      : 'Use subtle sound design to mark transitions; avoid music that distracts from proof.',
    editingPlan: [
      'Keep setup short.',
      'Reset attention every 2–3 beats.',
      'Bring proof earlier if the first third feels abstract.',
      'End with one CTA, not three.',
    ],
    productionComplexity: vertical ? 'low' : 'medium',
  };
}

function buildComplianceReview(input: {
  brandedContent: boolean;
  outputText: string;
  competitorText: string;
  warnings: string[];
}): ContentAgencyComplianceReview {
  const blockers: string[] = [];
  const warnings = [...input.warnings];
  if (input.brandedContent) blockers.push('sponsored_or_branded_content_requires_clear_disclosure');
  if (/copy this|same script|same words|use exact/i.test(input.outputText)) blockers.push('copying_competitor_creative_blocked');
  if (/guaranteed|always works|will go viral|fair use guaranteed/i.test(input.outputText)) blockers.push('unsupported_or_overconfident_claim_blocked');
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(input.competitorText))) blockers.push('untrusted_source_instruction_blocked');
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
      'High CTR with low retention means packaging overpromised or the intro underdelivered.',
      'Low CTR with high retention means title, thumbnail, first frame, or search language needs work.',
      'High retention with low conversion means CTA, offer, or positioning is weak.',
    ],
  };
}

function buildPerformanceDiagnosis(brief: ContentAgencyBrief): ContentAgencyPerformanceDiagnosis {
  const metrics = brief.currentMetrics ?? {};
  const ctr = numericMetric(metrics, ['ctr', 'clickThroughRate', 'thumbnailCtr']);
  const retention = numericMetric(metrics, ['retention', 'holdRate', 'averageViewPercentage']);
  const conversion = numericMetric(metrics, ['conversionRate', 'signupRate', 'leadRate']);
  const saves = numericMetric(metrics, ['saves', 'saveRate']);
  const comments = numericMetric(metrics, ['comments', 'commentRate']);
  const shares = numericMetric(metrics, ['shares', 'shareRate']);

  if (ctr != null && retention != null && ctr >= 0.08 && retention < 0.35) {
    return {
      summary: 'Packaging is earning the tap, but the intro is not paying off the promise quickly enough.',
      likelyBottleneck: 'high CTR with low retention',
      evidence: [`CTR ${formatMetric(ctr)}`, `retention ${formatMetric(retention)}`],
      recommendedTest: 'Keep the title/first frame direction, but rewrite the first 5 seconds around proof before context.',
      metricsToWatch: ['first 3-second hold', '30-second retention', 'average view duration'],
      uncertainty: 'Diagnosis uses user-supplied metrics only; confirm with platform retention curves before scaling.',
    };
  }
  if (ctr != null && retention != null && ctr < 0.03 && retention >= 0.55) {
    return {
      summary: 'People who start tend to stay, so the package likely needs a sharper title, thumbnail, or first-frame promise.',
      likelyBottleneck: 'low CTR with high retention',
      evidence: [`CTR ${formatMetric(ctr)}`, `retention ${formatMetric(retention)}`],
      recommendedTest: 'Run a packaging test with a more specific pain, proof, or consequence in the first frame.',
      metricsToWatch: ['CTR', 'first-frame hold', 'qualified comments'],
      uncertainty: 'Diagnosis assumes the retention sample is large enough; verify audience segment and traffic source.',
    };
  }
  if (retention != null && conversion != null && retention >= 0.55 && conversion < 0.02) {
    return {
      summary: 'The content is holding attention, but the CTA or offer is not converting that attention into action.',
      likelyBottleneck: 'high retention with low conversion',
      evidence: [`retention ${formatMetric(retention)}`, `conversion ${formatMetric(conversion)}`],
      recommendedTest: 'Make the CTA more concrete and tie the offer to the payoff demonstrated in the content.',
      metricsToWatch: ['CTA click rate', 'qualified replies', 'conversion rate'],
      uncertainty: 'Diagnosis does not infer revenue or attribution beyond the supplied metrics.',
    };
  }
  if (saves != null && comments != null && saves > comments * 2) {
    return {
      summary: 'The idea appears useful enough to save, but it may need a stronger discussion prompt.',
      likelyBottleneck: 'strong saves with low comments',
      evidence: [`saves ${formatMetric(saves)}`, `comments ${formatMetric(comments)}`],
      recommendedTest: 'Keep the educational utility and add a specific question that invites the audience to reveal their situation.',
      metricsToWatch: ['save rate', 'comment quality', 'shares'],
      uncertainty: 'Save/comment shape is directional; compare against platform and format baseline.',
    };
  }
  if (comments != null && shares != null && comments > shares * 2) {
    return {
      summary: 'The idea creates conversation, but it may not yet carry enough utility, status, or surprise to share.',
      likelyBottleneck: 'strong comments with low shares',
      evidence: [`comments ${formatMetric(comments)}`, `shares ${formatMetric(shares)}`],
      recommendedTest: 'Add a sharper takeaway, status-relevant insight, or shareable checklist moment.',
      metricsToWatch: ['share rate', 'sends', 'saves'],
      uncertainty: 'Interpretation should be validated against audience size and post age.',
    };
  }
  return {
    summary: 'Not enough reliable performance data yet; use this package as a clean experiment baseline.',
    likelyBottleneck: 'insufficient or stale metrics',
    evidence: Object.keys(metrics).length > 0 ? ['Metrics were supplied but did not match a clear diagnostic pattern.'] : ['No current metrics supplied.'],
    recommendedTest: 'Publish one controlled variant and review CTR, retention, saves/shares, comments, and conversion after the first normal traffic window.',
    metricsToWatch: [brief.platform === 'youtube' ? 'CTR' : 'first-frame hold', 'retention', 'saves or shares', 'conversion'],
    uncertainty: 'Nexus is not inventing analytics; diagnosis will sharpen after real platform metrics arrive.',
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
  ].map((rule) => rule.id);
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
