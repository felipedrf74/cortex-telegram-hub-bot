// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  routeContentResearch,
  type ExtendedScriptGenerationMode,
  type ResearchRoute,
} from './content-token-economy';

export type ContentResearchPolicyCode =
  | 'CONTENT_UNSUPPORTED_TOPIC'
  | 'CONTENT_HIGH_RISK_REVIEW_REQUIRED'
  | 'CONTENT_SCRIPT_RESEARCH_QUERY_TOO_LARGE'
  | 'CONTENT_SCRIPT_RESEARCH_QUERY_MISMATCH';

export const CONTENT_SCRIPT_RESEARCH_QUERY_MAX_CHARS = 2_000;

export interface ContentResearchSubjectPart {
  label: string;
  value: string | null | undefined;
}

/**
 * Build one deterministic classifier/retrieval subject from every semantic
 * field that can shape generated output. Callers must bound fields first.
 */
export function buildContentResearchSubject(
  parts: readonly ContentResearchSubjectPart[],
): string {
  return parts
    .map(({ label, value }) => {
      const normalized = typeof value === 'string' ? value.trim() : '';
      return normalized ? `${label}: ${normalized}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export class ContentResearchPolicyError extends Error {
  readonly status = 422;

  constructor(
    readonly code: ContentResearchPolicyCode,
    message: string,
    readonly route: Extract<ResearchRoute, 'unsupported' | 'high_risk_review'> | null,
    readonly reason: string,
    readonly extraDetails: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ContentResearchPolicyError';
  }

  get details(): Record<string, unknown> {
    if (this.route === null) {
      return { reason: this.reason, ...this.extraDetails };
    }
    if (this.route === 'unsupported') {
      return { route: this.route, reason: this.reason, ...this.extraDetails };
    }
    return {
      route: this.route,
      reason: this.reason,
      reviewAuthority: 'not_supported',
      requiredEvidence: 'reviewer_attested_source_package',
      retryable: false,
      ...this.extraDetails,
    };
  }
}

function normalizeResearchQueryPart(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Canonical query contract shared with the Python script engine. */
export function buildContentScriptResearchQuery(topic: string, niche: string): string {
  const normalizedTopic = normalizeResearchQueryPart(topic);
  const normalizedNiche = normalizeResearchQueryPart(niche);
  const query = normalizedNiche && normalizedNiche.toLowerCase() !== 'general'
    ? `TOPIC: ${normalizedTopic} | NICHE: ${normalizedNiche}`
    : normalizedTopic;
  if (query.length > CONTENT_SCRIPT_RESEARCH_QUERY_MAX_CHARS) {
    throw new ContentResearchPolicyError(
      'CONTENT_SCRIPT_RESEARCH_QUERY_TOO_LARGE',
      'The combined topic and niche exceed the safe research-query limit. Neither field was truncated.',
      null,
      'combined_topic_niche_limit_exceeded',
      {
        maxChars: CONTENT_SCRIPT_RESEARCH_QUERY_MAX_CHARS,
        actualChars: query.length,
        truncated: false,
      },
    );
  }
  return query;
}

export function assertContentScriptResearchQueryMatches(
  supplied: string | null | undefined,
  canonical: string,
): void {
  if (supplied == null || supplied.trim().length === 0) return;
  if (normalizeResearchQueryPart(supplied) === canonical) return;
  throw new ContentResearchPolicyError(
    'CONTENT_SCRIPT_RESEARCH_QUERY_MISMATCH',
    'The script research query must be derived by the server from the topic and niche.',
    null,
    'server_research_query_mismatch',
    { retryable: false },
  );
}

export function assertContentResearchGenerationAllowed(input: {
  subject: string;
  semanticValues?: readonly (string | null | undefined)[];
  mode: ExtendedScriptGenerationMode;
  forceRefresh?: boolean;
}): ReturnType<typeof routeContentResearch> {
  const decision = routeContentResearchWithSemanticSafety({
    ...input,
    semanticValues: input.semanticValues ?? [input.subject],
  });
  if (decision.route === 'unsupported') {
    throw new ContentResearchPolicyError(
      'CONTENT_UNSUPPORTED_TOPIC',
      'This content request is not supported. Reframe it with a safe, legitimate goal.',
      decision.route,
      decision.reason,
    );
  }
  if (decision.route === 'high_risk_review') {
    throw new ContentResearchPolicyError(
      'CONTENT_HIGH_RISK_REVIEW_REQUIRED',
      'This topic requires a human-reviewed source package before generation. That review authority is not supported yet.',
      decision.route,
      decision.reason,
    );
  }
  return decision;
}

/**
 * Classify every raw semantic field and their normalized space-joined meaning.
 * Labels and separators in a retrieval subject must not split a policy phrase
 * such as "insider trading" or "pump and dump" across fields.
 */
export function contentResearchSafetyDecision(
  values: readonly (string | null | undefined)[],
  mode: ExtendedScriptGenerationMode,
  forceRefresh?: boolean,
): ReturnType<typeof routeContentResearch> | null {
  const semanticValues = values
    .map((value) => typeof value === 'string' ? normalizeResearchQueryPart(value) : '')
    .filter(Boolean);
  const candidates = semanticValues.map((topic) => routeContentResearch({ topic, mode, forceRefresh }));
  if (semanticValues.length > 1) {
    candidates.push(routeContentResearch({
      topic: semanticValues.join(' '),
      mode,
      forceRefresh,
    }));
    for (let left = 0; left < semanticValues.length - 1; left += 1) {
      for (let right = left + 1; right < semanticValues.length; right += 1) {
        candidates.push(routeContentResearch({
          topic: `${semanticValues[left]} ${semanticValues[right]}`,
          mode,
          forceRefresh,
        }));
      }
    }
  }
  return candidates.find((candidate) => candidate.route === 'unsupported')
    ?? candidates.find((candidate) => candidate.route === 'high_risk_review')
    ?? null;
}

export function routeContentResearchWithSemanticSafety(input: {
  subject: string;
  semanticValues: readonly (string | null | undefined)[];
  mode: ExtendedScriptGenerationMode;
  forceRefresh?: boolean;
}): ReturnType<typeof routeContentResearch> {
  return contentResearchSafetyDecision(input.semanticValues, input.mode, input.forceRefresh)
    ?? routeContentResearch({
      topic: input.subject,
      mode: input.mode,
      forceRefresh: input.forceRefresh,
    });
}
