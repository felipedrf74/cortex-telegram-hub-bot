// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatCoreV2Domain,
  ChatCoreV2EntityType,
  EntityReferenceResolution,
  EntityResolutionCandidate,
  ExecutionPreconditions,
} from './types';

export const CHAT_CORE_V2_ENTITY_RESOLVER_VERSION = 'chat_core_v2_entity_resolver@1.0.0';

export interface ResolveEntityReferenceInput {
  entityType: ChatCoreV2EntityType;
  userPhrase: string;
  candidates: EntityResolutionCandidate[];
}

export interface EntityResolutionPolicy {
  minResolvedConfidence: number;
  ambiguityMargin: number;
  maxCandidates: number;
}

export const DEFAULT_ENTITY_RESOLUTION_POLICY: EntityResolutionPolicy = {
  minResolvedConfidence: 0.78,
  ambiguityMargin: 0.08,
  maxCandidates: 5,
};

const ENTITY_TYPES: ReadonlySet<ChatCoreV2EntityType> = new Set([
  'task',
  'training_session',
  'event',
  'notification',
  'decision',
  'content_item',
  'meal_plan_item',
  'finance_item',
  'connection',
]);

const DOMAINS: ReadonlySet<ChatCoreV2Domain> = new Set([
  'secretary',
  'tasks',
  'training',
  'content',
  'cooking',
  'finance',
  'connections',
  'notifications',
  'decision_center',
]);

export function resolveEntityReferenceFromCandidates(
  input: ResolveEntityReferenceInput,
  policy: EntityResolutionPolicy = DEFAULT_ENTITY_RESOLUTION_POLICY,
): EntityReferenceResolution {
  validateResolutionInput(input);
  validatePolicy(policy);

  const candidates = normalizeCandidates(input.candidates)
    .slice(0, policy.maxCandidates);

  if (candidates.length === 0) {
    return {
      entityType: input.entityType,
      userPhrase: input.userPhrase,
      candidates: [],
      status: 'not_found',
      reasonCodes: ['no_candidates'],
    };
  }

  const [top, second] = candidates;
  if (top.confidence < policy.minResolvedConfidence) {
    return unresolved(input, candidates, 'low_confidence');
  }

  if (second && top.confidence - second.confidence <= policy.ambiguityMargin) {
    return unresolved(input, candidates, 'multiple_plausible_candidates');
  }

  return {
    entityType: input.entityType,
    userPhrase: input.userPhrase,
    candidates,
    status: 'resolved',
    selectedId: top.id,
    selectedCandidate: top,
    reasonCodes: ['single_high_confidence_candidate'],
  };
}

export function buildEntityResolutionPreconditions(
  resolution: EntityReferenceResolution,
): Pick<ExecutionPreconditions, 'requiredEntityVersions'> {
  if (resolution.status !== 'resolved' || !resolution.selectedCandidate?.entityVersion) {
    return { requiredEntityVersions: {} };
  }
  return {
    requiredEntityVersions: {
      [resolution.selectedCandidate.id]: resolution.selectedCandidate.entityVersion,
    },
  };
}

function unresolved(
  input: ResolveEntityReferenceInput,
  candidates: EntityResolutionCandidate[],
  reasonCode: string,
): EntityReferenceResolution {
  return {
    entityType: input.entityType,
    userPhrase: input.userPhrase,
    candidates,
    status: 'ambiguous',
    reasonCodes: [reasonCode],
  };
}

function normalizeCandidates(candidates: EntityResolutionCandidate[]): EntityResolutionCandidate[] {
  const byId = new Map<string, EntityResolutionCandidate>();
  for (const candidate of candidates) {
    validateCandidate(candidate);
    const prior = byId.get(candidate.id);
    if (!prior || candidate.confidence > prior.confidence) {
      byId.set(candidate.id, {
        ...candidate,
        confidence: boundedConfidence(candidate.confidence),
      });
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
}

function validateResolutionInput(input: ResolveEntityReferenceInput): void {
  if (!ENTITY_TYPES.has(input.entityType)) throw new Error(`Invalid Chat Core v2 entity type: ${input.entityType}`);
  requireNonEmpty(input.userPhrase, 'userPhrase');
  if (!Array.isArray(input.candidates)) throw new Error('candidates must be an array');
}

function validateCandidate(candidate: EntityResolutionCandidate): void {
  requireNonEmpty(candidate.id, 'candidate.id');
  requireNonEmpty(candidate.label, 'candidate.label');
  requireNonEmpty(candidate.reason, 'candidate.reason');
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error('candidate.confidence must be between 0 and 1');
  }
  if (candidate.domain && !DOMAINS.has(candidate.domain)) {
    throw new Error(`Invalid Chat Core v2 candidate domain: ${candidate.domain}`);
  }
}

function validatePolicy(policy: EntityResolutionPolicy): void {
  if (!Number.isFinite(policy.minResolvedConfidence) || policy.minResolvedConfidence < 0 || policy.minResolvedConfidence > 1) {
    throw new Error('minResolvedConfidence must be between 0 and 1');
  }
  if (!Number.isFinite(policy.ambiguityMargin) || policy.ambiguityMargin < 0 || policy.ambiguityMargin > 1) {
    throw new Error('ambiguityMargin must be between 0 and 1');
  }
  if (!Number.isFinite(policy.maxCandidates) || policy.maxCandidates < 1) {
    throw new Error('maxCandidates must be at least 1');
  }
}

function boundedConfidence(confidence: number): number {
  return Math.min(Math.max(confidence, 0), 1);
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}
