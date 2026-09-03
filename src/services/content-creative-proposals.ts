// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import {
  getCaption,
  getHooks,
  getRepurpose,
  getSources,
  getThumbnail,
  getTitles,
  type CaptionResponse,
  type HooksResponse,
  type RepurposeOriginalFormat,
  type RepurposeResponse,
  type ThumbnailResponse,
  type TitlesResponse,
} from './content-engine';
import {
  buildSourcePackage,
  estimateContentTokens,
  routeContentResearch,
  type ContentReuseStatus,
  type ResearchRoute,
  type SourcePackage,
} from './content-token-economy';
import {
  getContentSourcePackage,
  persistContentArtifacts,
  type PublicSourcePackage,
} from './content-token-artifact-store';
import { contentResearchSafetyDecision } from './content-research-generation-policy';

export type ContentCreativeOperation = 'hooks' | 'titles' | 'thumbnail' | 'caption' | 'repurpose';
export type ContentCreativeProposal = HooksResponse | TitlesResponse | ThumbnailResponse | CaptionResponse | RepurposeResponse;
type CreativeSourceReuseStatus = Exclude<ContentReuseStatus, 'cached'> | 'none';

export interface ContentCreativeProposalInput {
  operation: ContentCreativeOperation;
  tenantId: number;
  userId: number;
  language: 'en-US' | 'pt-PT' | 'pt-BR';
  topic: string;
  niche?: string;
  sourcePackageId?: string;
  abortSignal?: AbortSignal;
  count?: number;
  format?: 'YouTube' | 'Short' | 'Reel' | 'Carousel';
  platform?: 'YouTube' | 'Instagram';
  title?: string;
  sourceContent?: string;
  originalFormat?: RepurposeOriginalFormat;
}

export interface ContentCreativeProposalResult {
  operation: ContentCreativeOperation;
  proposal: ContentCreativeProposal;
  /** True when the engine returned a bounded server fallback instead of valid provider output. */
  degraded: boolean;
  /** Bounded, server-authored reasons that the fallback requires explicit review. */
  warnings: string[];
  sourcePackage: {
    sourcePackageId: string;
    researchArtifactId: string;
    freshnessClass: SourcePackage['freshnessClass'];
    expiresAt: string;
    sourceCount: number;
  } | null;
  research: {
    /** Routing policy classification; this is not a cache-hit assertion. */
    policyRoute: ResearchRoute;
    reason: string;
    execution: 'none' | 'reused_source_context' | 'fresh_source_context';
    reuseStatus: CreativeSourceReuseStatus;
    sourceContextUsed: boolean;
    sourceBoundInputClaimCount: number;
    generatedClaimsRequireReview: boolean;
  };
  authority: {
    status: 'proposal';
    proposalPersisted: false;
    canonicalWorkspaceMutation: false;
    publicationExecution: 'not_performed';
    humanReviewRequired: boolean;
    groundingStatus: 'not_required' | 'source_context';
  };
}

export class ContentCreativeProposalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentCreativeProposalError';
  }
}

type CreativeResearchDecision = ReturnType<typeof routeContentResearch>;
type CreativeSemanticInput = {
  label: 'topic' | 'title' | 'niche' | 'source_content';
  value: string;
};
type CreativeResearchResolution = {
  decision: CreativeResearchDecision;
  groundingTopic: string;
};

type PreparedCreativeGrounding = {
  decision: CreativeResearchDecision;
  sourcePackage: PublicSourcePackage | SourcePackage | null;
  reuseStatus: CreativeSourceReuseStatus;
  sourceBoundInputClaimCount: number;
};

const RESEARCH_ROUTE_PRIORITY: Record<ResearchRoute, number> = {
  evergreen_cached: 1,
  creator_only: 2,
  deep_explicit: 3,
  fresh_compact: 4,
  high_risk_review: 5,
  unsupported: 6,
};

const SOURCE_CONTEXT_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_GROUNDING_TOPIC_CHARS = 2_000;
const MAX_CREATIVE_WARNINGS = 10;
const MAX_CREATIVE_WARNING_CHARS = 500;

function normalizeCreativeWarnings(warnings: readonly string[] | undefined): string[] {
  if (!Array.isArray(warnings)) return [];
  return [...new Set(warnings
    .filter((warning): warning is string => typeof warning === 'string')
    .map((warning) => warning.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((warning) => warning.slice(0, MAX_CREATIVE_WARNING_CHARS)))]
    .slice(0, MAX_CREATIVE_WARNINGS);
}

function hasUsableCreativeOutput(proposal: ContentCreativeProposal): boolean {
  if ('hooks' in proposal) return proposal.hooks.length > 0;
  if ('titles' in proposal) return proposal.titles.length > 0;
  if ('concepts' in proposal) return proposal.concepts.length > 0;
  if ('caption' in proposal) return proposal.caption.trim().length > 0;
  return proposal.outputs.length > 0;
}

export function resolveContentCreativeResearchDecision(
  semanticInputs: readonly string[],
): CreativeResearchDecision {
  return resolveContentCreativeResearchTarget(
    semanticInputs.map((value, index) => ({
      label: index === 0 ? 'topic' : index === 1 ? 'niche' : 'source_content',
      value,
    })),
  ).decision;
}

function resolveContentCreativeResearchTarget(
  semanticInputs: readonly CreativeSemanticInput[],
): CreativeResearchResolution {
  const seenValues = new Set<string>();
  const evaluated = semanticInputs
    .map((input) => ({
      ...input,
      value: input.value.replace(/\s+/g, ' ').trim(),
    }))
    .filter((input) => Boolean(input.value))
    .filter((input) => {
      const identity = input.value.toLocaleLowerCase('en-US');
      if (seenValues.has(identity)) return false;
      seenValues.add(identity);
      return true;
    })
    .map((input) => ({
      ...input,
      decision: routeContentResearch({ topic: input.value, mode: 'draft' }),
    }));
  if (evaluated.length === 0) {
    const decision = routeContentResearch({ topic: 'general', mode: 'draft' });
    return { decision, groundingTopic: 'general' };
  }
  const safetyDecision = contentResearchSafetyDecision(
    evaluated.map((candidate) => candidate.value),
    'draft',
  );
  if (safetyDecision) {
    return { decision: safetyDecision, groundingTopic: evaluated[0].value };
  }
  const winning = evaluated.reduce((highest, candidate) => (
    RESEARCH_ROUTE_PRIORITY[candidate.decision.route] > RESEARCH_ROUTE_PRIORITY[highest.decision.route]
      ? candidate
      : highest
  ));
  if (winning.decision.route !== 'fresh_compact') {
    return { decision: winning.decision, groundingTopic: evaluated[0].value };
  }

  const winningContributors = evaluated.filter((candidate) => candidate.decision.route === winning.decision.route);
  // The primary topic is both research context and package identity. Retain it
  // even when a secondary semantic input (for example, a timely niche or
  // repurpose draft) is what triggered fresh research; otherwise one source
  // package could be reused across unrelated topics that share that secondary
  // input.
  const primaryTopic = evaluated.find((candidate) => candidate.label === 'topic');
  const contributors = primaryTopic && !winningContributors.includes(primaryTopic)
    ? [primaryTopic, ...winningContributors]
    : winningContributors;
  const groundingTopic = contributors.length === 1 && contributors[0].label === 'topic'
    ? contributors[0].value
    : contributors
      .map((candidate) => `${candidate.label.toUpperCase()}: ${candidate.value}`)
      .join(' | ');
  if (!groundingTopic || groundingTopic.length > MAX_GROUNDING_TOPIC_CHARS) {
    throw new ContentCreativeProposalError(
      'CONTENT_GROUNDING_QUERY_TOO_LARGE',
      'The source-grounding query cannot safely represent every input that requires research.',
      422,
      {
        route: winning.decision.route,
        maxChars: MAX_GROUNDING_TOPIC_CHARS,
        fields: contributors.map((candidate) => candidate.label),
      },
    );
  }
  return { decision: winning.decision, groundingTopic };
}

export async function generateContentCreativeProposal(
  input: ContentCreativeProposalInput,
): Promise<ContentCreativeProposalResult> {
  assertCreativeScope(input);
  const topic = requireBoundedText(input.topic, 'topic', 2_000);
  const niche = input.niche == null
    ? 'general'
    : requireBoundedText(input.niche, 'niche', 160);
  const thumbnailTitle = input.operation === 'thumbnail'
    ? requireBoundedText(input.title, 'title', 2_000)
    : null;
  const semanticInputs: CreativeSemanticInput[] = [
    { label: 'topic', value: topic },
  ];
  if (thumbnailTitle) semanticInputs.push({ label: 'title', value: thumbnailTitle });
  semanticInputs.push({ label: 'niche', value: niche });
  if (input.operation === 'repurpose') {
    semanticInputs.push({
      label: 'source_content',
      value: requireBoundedText(input.sourceContent, 'sourceContent', 5_000, { allowMultiline: true }),
    });
  }
  const researchResolution = resolveContentCreativeResearchTarget(semanticInputs);
  const grounding = await prepareCreativeGrounding(
    { ...input, topic, niche },
    researchResolution,
  );
  throwIfCancelled(input.abortSignal);

  const sourcePackageId = grounding.sourcePackage?.sourcePackageId;
  const sourceSummary = grounding.sourcePackage
    ? sanitizeSourceSummary(sourceSummaryLines(grounding.sourcePackage))
    : undefined;
  const sharedOptions = {
    abortSignal: input.abortSignal,
    language: input.language,
    sourcePackageId,
    sourceSummary,
    sourceReuseStatus: grounding.reuseStatus,
  } as const;

  let proposal: ContentCreativeProposal;
  switch (input.operation) {
    case 'hooks':
      proposal = await getHooks(topic, niche, input.count ?? 8, {
        ...sharedOptions,
        format: input.format ?? 'YouTube',
      });
      break;
    case 'titles':
      proposal = await getTitles(topic, niche, input.count ?? 10, {
        ...sharedOptions,
        platform: input.platform ?? 'YouTube',
      });
      break;
    case 'thumbnail':
      proposal = await getThumbnail(
        thumbnailTitle!,
        niche,
        { ...sharedOptions, topic },
      );
      break;
    case 'caption':
      proposal = await getCaption(topic, niche, sharedOptions);
      break;
    case 'repurpose':
      proposal = await getRepurpose(
        topic,
        requireBoundedText(input.sourceContent, 'sourceContent', 5_000, { allowMultiline: true }),
        input.originalFormat ?? 'YouTube',
        sharedOptions,
      );
      break;
  }
  throwIfCancelled(input.abortSignal);

  const degraded = proposal.degraded === true;
  const warnings = normalizeCreativeWarnings(proposal.warnings);
  if (degraded && !hasUsableCreativeOutput(proposal)) {
    throw new ContentCreativeProposalError(
      'CONTENT_CREATIVE_OUTPUT_UNAVAILABLE',
      input.language.startsWith('pt')
        ? 'O fornecedor criativo não devolveu uma proposta utilizável. Nenhuma proposta criativa foi guardada ou publicada.'
        : 'The creative provider did not return a usable proposal. No creative proposal was saved or published.',
      503,
      {
        operation: input.operation,
        degraded: true,
        retryable: true,
        warnings: warnings.length > 0 ? warnings : ['content_creative_output_unavailable'],
      },
    );
  }

  const sourceContextUsed = Boolean(sourcePackageId && sourceSummary?.length);
  return {
    operation: input.operation,
    proposal,
    degraded,
    warnings: degraded && warnings.length === 0
      ? ['content_creative_degraded_fallback']
      : warnings,
    sourcePackage: grounding.sourcePackage ? {
      sourcePackageId: grounding.sourcePackage.sourcePackageId,
      researchArtifactId: grounding.sourcePackage.researchArtifactId,
      freshnessClass: grounding.sourcePackage.freshnessClass,
      expiresAt: grounding.sourcePackage.expiresAt,
      sourceCount: grounding.sourcePackage.sources.length,
    } : null,
    research: {
      policyRoute: grounding.decision.route,
      reason: grounding.decision.reason,
      execution: !sourceContextUsed
        ? 'none'
        : grounding.reuseStatus === 'reused'
          ? 'reused_source_context'
          : 'fresh_source_context',
      reuseStatus: grounding.reuseStatus,
      sourceContextUsed,
      sourceBoundInputClaimCount: grounding.sourceBoundInputClaimCount,
      generatedClaimsRequireReview: sourceContextUsed,
    },
    authority: {
      status: 'proposal',
      proposalPersisted: false,
      canonicalWorkspaceMutation: false,
      publicationExecution: 'not_performed',
      humanReviewRequired: sourceContextUsed || degraded,
      groundingStatus: sourceContextUsed
          ? 'source_context'
          : 'not_required',
    },
  };
}

async function prepareCreativeGrounding(
  input: ContentCreativeProposalInput & { topic: string; niche: string },
  resolution: CreativeResearchResolution,
): Promise<PreparedCreativeGrounding> {
  const { decision, groundingTopic } = resolution;
  if (decision.route === 'unsupported') {
    throw new ContentCreativeProposalError(
      'CONTENT_UNSUPPORTED_TOPIC',
      input.language.startsWith('pt')
        ? 'Não posso gerar conteúdo para esse pedido. Reformule com um objetivo seguro e legítimo.'
        : 'I cannot generate content for that request. Reframe it with a safe, legitimate goal.',
      422,
      { route: decision.route, reason: decision.reason },
    );
  }
  if (decision.route === 'high_risk_review') {
    throw new ContentCreativeProposalError(
      'CONTENT_HIGH_RISK_REVIEW_REQUIRED',
      input.language.startsWith('pt')
        ? 'Este pedido de alto risco exige revisão humana de fontes antes de qualquer geração criativa.'
        : 'This high-risk request requires human source review before any creative generation.',
      422,
      {
        route: decision.route,
        reason: decision.reason,
        reviewAuthority: 'not_supported',
        requiredEvidence: 'reviewer_attested_source_package',
        retryable: false,
      },
    );
  }

  const stored = input.sourcePackageId
    ? loadScopedSourcePackage(input, input.sourcePackageId)
    : null;
  if (stored && stored.topicHash !== topicHash(groundingTopic)) {
    throw new ContentCreativeProposalError(
      'CONTENT_SOURCE_PACKAGE_TOPIC_MISMATCH',
      'The source package belongs to a different topic.',
      409,
      { retryable: false },
    );
  }

  const storedIsCurrent = stored ? isCurrentSourcePackage(stored) : false;
  if (decision.route === 'fresh_compact') {
    if (stored && storedIsCurrent && isFreshSourceContext(stored)) {
      return { decision, sourcePackage: stored, reuseStatus: 'reused', sourceBoundInputClaimCount: 0 };
    }
    return buildFreshCreativeGrounding(input, decision, groundingTopic, stored ? 'refreshed' : 'fresh');
  }

  if (!stored) {
    return { decision, sourcePackage: null, reuseStatus: 'none', sourceBoundInputClaimCount: 0 };
  }
  if (!storedIsCurrent || !hasUsableSourceContext(stored)) {
    throw new ContentCreativeProposalError(
      'CONTENT_SOURCE_PACKAGE_UNUSABLE',
      'The source package is expired or does not contain usable source context.',
      409,
      { retryable: false },
    );
  }
  return { decision, sourcePackage: stored, reuseStatus: 'reused', sourceBoundInputClaimCount: 0 };
}

function loadScopedSourcePackage(
  input: Pick<ContentCreativeProposalInput, 'tenantId' | 'userId'>,
  sourcePackageId: string,
): PublicSourcePackage {
  const stored = getContentSourcePackage(
    { tenantId: input.tenantId, userId: input.userId },
    sourcePackageId,
  );
  if (!stored) {
    throw new ContentCreativeProposalError(
      'CONTENT_SOURCE_PACKAGE_NOT_FOUND',
      'Source package not found in the authenticated Content scope.',
      404,
    );
  }
  return stored;
}

async function buildFreshCreativeGrounding(
  input: ContentCreativeProposalInput & { topic: string; niche: string },
  decision: CreativeResearchDecision,
  groundingTopic: string,
  reuseStatus: Extract<ContentReuseStatus, 'fresh' | 'refreshed'>,
): Promise<PreparedCreativeGrounding> {
  throwIfCancelled(input.abortSignal);
  const research = await getSources(groundingTopic, {
    abortSignal: input.abortSignal,
    language: input.language,
  });
  if (research.degraded === true) {
    throw new ContentCreativeProposalError(
      'CONTENT_RESEARCH_UNAVAILABLE',
      input.language.startsWith('pt')
        ? 'A investigação atual devolveu um resultado degradado. Nenhuma evidência foi marcada como atual nem guardada.'
        : 'Current research returned a degraded result. No evidence was marked fresh or persisted.',
      503,
      {
        retryable: true,
        route: decision.route,
        degraded: true,
        warnings: normalizeCreativeWarnings(research.warnings),
      },
    );
  }
  const sourcePackage = buildSourcePackage({
    topic: groundingTopic,
    language: input.language,
    format: input.operation,
    mode: 'standard',
    sources: research.sources,
    warnings: research.warnings,
  });
  sourcePackage.sourceSummaries = sanitizeSourceSummary(sourcePackage.sourceSummaries);
  sourcePackage.tokenEstimate = estimateContentTokens(sourcePackage.sourceSummaries.join('\n'));
  sourcePackage.freshnessClass = 'fresh';
  sourcePackage.expiresAt = new Date(Date.now() + SOURCE_CONTEXT_TTL_MS).toISOString();
  if (!hasUsableSourceContext(sourcePackage)) {
    throw new ContentCreativeProposalError(
      'CONTENT_RESEARCH_UNAVAILABLE',
      'Fresh source context is temporarily unavailable for this timely proposal.',
      503,
      { retryable: true, route: decision.route },
    );
  }
  persistResearchOnly(input, sourcePackage, groundingTopic);
  return { decision, sourcePackage, reuseStatus, sourceBoundInputClaimCount: 0 };
}

function persistResearchOnly(
  input: Pick<ContentCreativeProposalInput, 'tenantId' | 'userId' | 'operation' | 'abortSignal'>,
  sourcePackage: SourcePackage,
  groundingTopic: string,
): void {
  throwIfCancelled(input.abortSignal);
  persistContentArtifacts({
    tenantId: input.tenantId,
    userId: input.userId,
    topic: groundingTopic,
    sourcePackage,
    format: input.operation,
    recordIdeaMemory: false,
  });
  throwIfCancelled(input.abortSignal);
}

function isFreshSourceContext(sourcePackage: PublicSourcePackage): boolean {
  return (sourcePackage.freshnessClass === 'fresh' || sourcePackage.freshnessClass === 'deep')
    && hasUsableSourceContext(sourcePackage);
}

function hasUsableSourceContext(sourcePackage: PublicSourcePackage | SourcePackage): boolean {
  return sourcePackage.sources.length > 0
    && sanitizeSourceSummary(sourceSummaryLines(sourcePackage)).length > 0;
}

function sourceSummaryLines(sourcePackage: PublicSourcePackage | SourcePackage): readonly string[] {
  return 'sourceSummary' in sourcePackage
    ? sourcePackage.sourceSummary
    : sourcePackage.sourceSummaries;
}

function isCurrentSourcePackage(sourcePackage: PublicSourcePackage): boolean {
  const expiresAt = Date.parse(sourcePackage.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function sanitizeSourceSummary(lines: readonly string[]): string[] {
  const summaries: string[] = [];
  for (const line of lines) {
    const normalized = sanitizeEvidenceFragment(line, 220);
    if (normalized && !summaries.includes(normalized)) summaries.push(normalized);
    if (summaries.length >= 8) break;
  }
  return summaries;
}

function sanitizeEvidenceFragment(value: string, maxChars: number): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>{}\[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function topicHash(topic: string): string {
  return createHash('sha256').update(topic.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function requireBoundedText(
  value: unknown,
  field: string,
  maxChars: number,
  options: { allowMultiline?: boolean } = {},
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContentCreativeProposalError('VALIDATION', `${field} must be a non-empty string.`, 400);
  }
  const normalized = value.trim();
  const forbiddenControls = options.allowMultiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
    : /[\u0000-\u001F\u007F]/;
  if (forbiddenControls.test(normalized)) {
    throw new ContentCreativeProposalError(
      'VALIDATION',
      `${field} contains unsupported control characters.`,
      400,
    );
  }
  if (normalized.length > maxChars) {
    throw new ContentCreativeProposalError('VALIDATION', `${field} must be at most ${maxChars} characters.`, 400);
  }
  return normalized;
}

function assertCreativeScope(input: Pick<ContentCreativeProposalInput, 'tenantId' | 'userId'>): void {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0
      || !Number.isSafeInteger(input.tenantId) || input.tenantId <= 0) {
    throw new ContentCreativeProposalError(
      'CONTENT_TENANT_SCOPE_MISMATCH',
      'A valid authenticated Content tenant scope is required.',
      400,
    );
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error('content_creative_proposal_cancelled'), {
    name: 'AbortError',
    code: 'CONTENT_CLIENT_DISCONNECTED',
  });
}
