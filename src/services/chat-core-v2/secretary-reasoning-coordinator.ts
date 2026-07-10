// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import type { SecretaryContextSnapshot } from './secretary-context-snapshot';
import {
  secretaryCandidateMaterialEvidenceIds,
  type SecretaryCandidateFactors,
  type SecretaryReasoningBehavior,
  type SecretaryReasoningCandidate,
  type SecretaryReasoningResult,
} from './secretary-candidate-schema';
import { getChatCoreV2Capability } from './capability-registry';
import { analyzeIntent } from '../secretary-tools';

export interface SecretarySelectedOutcome {
  behavior: SecretaryReasoningBehavior;
  candidateId: string | null;
  userFacingText: string | null;
  conciseRationale: string | null;
  evidenceIds: string[];
  reasonCodes: string[];
  candidate: SecretaryReasoningCandidate | null;
}

const READ_ONLY_BEHAVIORS = new Set<SecretaryReasoningBehavior>([
  'answer', 'clarify', 'suggest', 'defer', 'suppress',
]);
const RELEVANCE_ORDER = { direct: 0, related: 1, weak: 2 } as const;
const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 } as const;
const URGENCY_ORDER = { immediate: 0, today: 1, later: 2, none: 3 } as const;
const VALUE_ORDER = { high: 0, medium: 1, low: 2, none: 3 } as const;
const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const REVERSIBILITY_ORDER = {
  not_applicable: 0,
  reversible: 0,
  compensatable: 1,
  irreversible: 2,
} as const;
const APPROVAL_ORDER = {
  none: 0,
  user_confirmation: 1,
  strong_confirmation: 2,
  admin_review: 3,
  unavailable: 4,
} as const;
const ACTIONABILITY_ORDER = { high: 0, medium: 1, passive: 2 } as const;
const USER_EFFORT_ORDER = { none: 0, low: 1, medium: 2, high: 3 } as const;

type CandidateBlocker =
  | 'candidate_evidence_invalid'
  | 'required_context_source_unavailable'
  | 'candidate_context_stale'
  | 'candidate_capability_required'
  | 'candidate_capability_unknown'
  | 'candidate_window_expired'
  | 'candidate_requires_clarification'
  | 'candidate_not_actionable'
  | 'low_value_candidate';

interface SecretaryCandidatePolicyAssessment {
  candidate: SecretaryReasoningCandidate;
  blocker: CandidateBlocker | null;
  actionability: keyof typeof ACTIONABILITY_ORDER;
  expectedUserValue: keyof typeof VALUE_ORDER;
  userEffort: keyof typeof USER_EFFORT_ORDER;
  dependencyCount: number;
  unresolvedQuestionCount: number;
  semanticTieBreak: string;
}

export interface SecretaryAuthorizedEnvelopeReference {
  capabilityId: string;
  contextVersion: string;
  permissionSnapshotVersion: string;
}

/** Deterministic selection only. It never authorizes or executes a model-proposed action. */
export function selectSecretaryReasoningOutcome(
  snapshot: SecretaryContextSnapshot,
  reasoning: SecretaryReasoningResult,
  options: {
    phase?: 'read_only' | 'decision_preview';
    now?: Date;
    authorizedEnvelope?: SecretaryAuthorizedEnvelopeReference | null;
  } = {},
): SecretarySelectedOutcome {
  if (reasoning.snapshotId !== snapshot.snapshotId || reasoning.contextHash !== snapshot.contextHash) {
    return deferOutcome('reasoning_context_mismatch');
  }
  const now = options.now ?? new Date();
  if (Date.parse(snapshot.expiresAt) <= now.getTime()) return deferOutcome('reasoning_context_expired');

  const promptInjection = snapshot.unresolvedQuestions.find((item) => item.code === 'prompt_injection_attempt');
  if (promptInjection) {
    return {
      behavior: 'answer',
      candidateId: null,
      userFacingText: 'I treated the instruction-like source content as untrusted and did not use it to change policy, permissions, or actions.',
      conciseRationale: 'Untrusted context cannot grant authority.',
      evidenceIds: [],
      reasonCodes: ['prompt_injection_attempt_blocked'],
      candidate: null,
    };
  }

  const tenantBoundary = snapshot.unresolvedQuestions.find((item) => item.code === 'tenant_boundary_requires_confirmation');
  if (tenantBoundary) {
    return {
      behavior: 'clarify',
      candidateId: null,
      userFacingText: tenantBoundary.question,
      conciseRationale: null,
      evidenceIds: ['current-turn'],
      reasonCodes: ['tenant_boundary_requires_confirmation'],
      candidate: null,
    };
  }

  const unsafeAmbiguity = snapshot.unresolvedQuestions.find((item) => item.code === 'unsafe_ambiguous_action');
  if (unsafeAmbiguity) {
    return {
      behavior: 'clarify',
      candidateId: null,
      userFacingText: unsafeAmbiguity.question,
      conciseRationale: null,
      evidenceIds: ['current-turn'],
      reasonCodes: ['unsafe_ambiguous_action'],
      candidate: null,
    };
  }

  const assessments = reasoning.candidates.map((candidate) => assessCandidate(
    applyDeterministicFactors(candidate, snapshot, now),
    snapshot,
    now,
  ));
  const sorted = assessments.filter((assessment) => !assessment.blocker).sort(compareCandidateAssessments);
  const selectedAssessment = sorted[0];
  if (!selectedAssessment) return outcomeForRejectedCandidates(assessments);
  const selected = selectedAssessment.candidate;
  if (selected.factors.confidence === 'low' && (selected.factors.risk === 'high' || selected.factors.risk === 'critical')) {
    return options.phase === 'decision_preview' && !!selected.actionDraft && !!selected.capabilityId
      ? disclosePartialPlanningCoverage(selectedOutcome(
          { ...selected, behavior: 'conflict_review' },
          ['low_confidence_high_impact_requires_review', ...selectionReasonCodes(selectedAssessment)],
        ), snapshot)
      : deferOutcome('low_confidence_high_impact');
  }
  if ((options.phase ?? 'read_only') === 'read_only' && !READ_ONLY_BEHAVIORS.has(selected.behavior)) {
    return deferOutcome('behavior_requires_deterministic_action_pipeline');
  }
  if (selected.behavior === 'authorized_execute_request' && !authorizedEnvelopeMatches(selected, snapshot, options.authorizedEnvelope)) {
    return deferOutcome('authorized_envelope_required');
  }
  return disclosePartialPlanningCoverage(
    selectedOutcome(selected, selectionReasonCodes(selectedAssessment)),
    snapshot,
  );
}

function candidateEvidenceIsValid(candidate: SecretaryReasoningCandidate, snapshot: SecretaryContextSnapshot): boolean {
  const allowed = new Set(snapshot.facts.map((fact) => fact.evidenceId));
  const materialEvidence = secretaryCandidateMaterialEvidenceIds(candidate);
  const questionEvidence = [
    ...candidate.unresolvedQuestions.flatMap((item) => item.evidenceIds),
  ];
  return candidate.evidenceIds.length > 0
    && [...materialEvidence, ...questionEvidence].every((id) => allowed.has(id));
}

function selectedOutcome(candidate: SecretaryReasoningCandidate, reasonCodes: string[]): SecretarySelectedOutcome {
  return {
    behavior: candidate.behavior,
    candidateId: candidate.candidateId,
    userFacingText: candidate.userFacingText || null,
    conciseRationale: candidate.conciseRationale,
    evidenceIds: secretaryCandidateMaterialEvidenceIds(candidate),
    reasonCodes,
    candidate,
  };
}

function deferOutcome(reasonCode: string): SecretarySelectedOutcome {
  return {
    behavior: 'defer',
    candidateId: null,
    userFacingText: null,
    conciseRationale: null,
    evidenceIds: [],
    reasonCodes: [reasonCode],
    candidate: null,
  };
}

function suppressOutcome(reasonCode: string): SecretarySelectedOutcome {
  return {
    behavior: 'suppress',
    candidateId: null,
    userFacingText: null,
    conciseRationale: null,
    evidenceIds: [],
    reasonCodes: [reasonCode],
    candidate: null,
  };
}

function applyDeterministicFactors(
  candidate: SecretaryReasoningCandidate,
  snapshot: SecretaryContextSnapshot,
  now: Date,
): SecretaryReasoningCandidate {
  const materialEvidenceIds = new Set(secretaryCandidateMaterialEvidenceIds(candidate));
  const evidence = snapshot.facts.filter((fact) => materialEvidenceIds.has(fact.evidenceId));
  const capability = candidate.capabilityId ? getChatCoreV2Capability(candidate.capabilityId) : undefined;
  const partialPlanningCoverage = planningCoverageIsPartial(snapshot);
  const freshness: SecretaryCandidateFactors['contextFreshness'] = evidence.some((fact) => fact.freshness === 'stale')
    ? 'stale'
    : evidence.some((fact) => fact.freshness === 'unknown')
      ? 'unknown'
      : evidence.some((fact) => fact.freshness === 'recent') ? 'mixed' : 'fresh';
  // Avoid inventing an unevaluated numeric production threshold. Reliability,
  // freshness, and the model's categorical estimate form an ordinal cap; the
  // labeled corpus can later justify a versioned numeric policy if needed.
  const evidenceConfidence: SecretaryCandidateFactors['confidence'] = freshness === 'stale' || freshness === 'unknown'
    || evidence.length === 0
    || evidence.some((fact) => fact.reliability === 'inferred')
    ? 'low'
    : partialPlanningCoverage
      ? 'medium'
    : evidence.every((fact) => (fact.reliability === 'authoritative' || fact.reliability === 'verified') && fact.confidence === 1)
      ? 'high'
      : 'medium';
  const confidence = CONFIDENCE_ORDER[candidate.factors.confidence] >= CONFIDENCE_ORDER[evidenceConfidence]
    ? candidate.factors.confidence
    : evidenceConfidence;
  const risk: SecretaryCandidateFactors['risk'] = capability?.risk === 'restricted'
    ? 'critical'
    : capability?.risk ?? (isActionBehavior(candidate.behavior) ? 'high' : 'low');
  const requiredApproval: SecretaryCandidateFactors['requiredApproval'] = !isActionBehavior(candidate.behavior)
    ? 'none'
    : capability?.risk === 'restricted'
        ? 'admin_review'
      : !capability || capability.confirmationPolicy === 'never_execute'
        ? 'unavailable'
        : capability.risk === 'high'
          ? 'strong_confirmation'
          : 'user_confirmation';
  const urgency = deterministicUrgency(candidate, now);
  const factors: SecretaryCandidateFactors = {
    relevance: evidence.some((fact) => fact.source === 'current_turn')
      ? 'direct'
      : evidence.some((fact) => fact.reliability === 'authoritative' || fact.reliability === 'verified')
        ? 'related'
        : 'weak',
    confidence,
    urgency,
    // Impact/value is soft model judgment. It may influence presentation and
    // ranking, but it never changes deterministic risk or authorization.
    expectedImpact: candidate.behavior === 'defer' || candidate.behavior === 'suppress'
      ? 'none'
      : candidate.factors.expectedImpact,
    risk,
    // The registry has an explicit undo contract but no compensation
    // contract. Any action without registered undo is therefore treated as
    // irreversible; model-authored "compensatable" is never trusted.
    reversibility: !isActionBehavior(candidate.behavior)
      ? 'not_applicable'
      : capability?.undoPolicy.supported
        ? 'reversible'
        : 'irreversible',
    requiredPermissions: capability ? [...capability.requiredPermissions].sort() : [],
    requiredApproval,
    dependencies: capability ? [`capability:${capability.capabilityId}`, `permission_snapshot:${snapshot.permissionSnapshotVersion}`] : [],
    contextFreshness: freshness,
  };
  return { ...candidate, factors };
}

function planningCoverageIsPartial(snapshot: SecretaryContextSnapshot): boolean {
  const currentTurn = snapshot.facts.find((fact) => fact.source === 'current_turn')?.value ?? '';
  const intent = analyzeIntent(currentTurn);
  if (!intent.tasks && !intent.calendar && !intent.reminders && !intent.garmin
      && !/\b(plan\w*|priori\w*|schedul\w*|today|day|plane\w*|hoje|dia)\b/i.test(currentTurn)) {
    return false;
  }
  return snapshot.sourceHealth.some((source) =>
    source.reasonCode === 'tasks_result_bounded'
      || source.reasonCode === 'calendar_result_bounded'
      || source.reasonCode === 'reminders_result_bounded'
      || source.reasonCode === 'garmin_result_bounded'
      || source.reasonCode === 'calendar_partial_provider_failure'
      || source.reasonCode === 'daily_coordination_degraded');
}

function disclosePartialPlanningCoverage(
  outcome: SecretarySelectedOutcome,
  snapshot: SecretaryContextSnapshot,
): SecretarySelectedOutcome {
  if (!planningCoverageIsPartial(snapshot)
      || (outcome.behavior !== 'answer' && outcome.behavior !== 'suggest' && outcome.behavior !== 'conflict_review')) {
    return outcome;
  }
  const currentTurn = snapshot.facts.find((fact) => fact.source === 'current_turn')?.value ?? '';
  const pt = /\b(hoje|dia|agenda|calend[aá]rio|plane\w*|priori\w*)\b/i.test(currentTurn);
  const caveat = pt
    ? 'Usei o resumo disponível; alguns itens ficaram fora da vista detalhada, por isso confirma as listas completas antes de agir.'
    : 'I used the available summary; some items were outside the detailed view, so confirm the full lists before acting.';
  return {
    ...outcome,
    userFacingText: outcome.userFacingText ? `${outcome.userFacingText}\n\n${caveat}` : caveat,
    reasonCodes: [...outcome.reasonCodes, 'planning_context_partially_bounded'],
  };
}

function deterministicUrgency(candidate: SecretaryReasoningCandidate, now: Date): SecretaryCandidateFactors['urgency'] {
  const window = candidate.actionDraft?.requestedWindow;
  if (!window) return candidate.behavior === 'clarify' ? 'immediate' : 'none';
  const zoneProbe = DateTime.fromJSDate(now).setZone(window.timezone);
  const start = DateTime.fromISO(window.start, { setZone: true });
  if (!zoneProbe.isValid || !start.isValid) return 'none';
  const localStart = start.setZone(window.timezone);
  const localNow = DateTime.fromJSDate(now, { zone: window.timezone });
  if (!localStart.isValid || !localNow.isValid) return 'none';
  if (localStart.toMillis() <= localNow.toMillis()) return 'immediate';
  if (localStart.hasSame(localNow, 'day')) return 'today';
  return 'later';
}

function assessCandidate(
  candidate: SecretaryReasoningCandidate,
  snapshot: SecretaryContextSnapshot,
  now: Date,
): SecretaryCandidatePolicyAssessment {
  const actionability = candidateActionability(candidate);
  const expectedUserValue = riskAdjustedExpectedValue(candidate);
  const userEffort = candidateUserEffort(candidate);
  let blocker: CandidateBlocker | null = null;

  if (!candidateEvidenceIsValid(candidate, snapshot)) {
    blocker = 'candidate_evidence_invalid';
  } else if (requiredSourceUnavailable(candidate, snapshot)
    && candidate.behavior !== 'clarify'
    && candidate.behavior !== 'defer'
    && candidate.behavior !== 'suppress') {
    blocker = 'required_context_source_unavailable';
  } else if (candidate.factors.contextFreshness === 'stale' && candidate.behavior !== 'clarify') {
    blocker = 'candidate_context_stale';
  } else if (isActionBehavior(candidate.behavior) && !candidate.capabilityId) {
    blocker = 'candidate_capability_required';
  } else if (candidate.capabilityId && !getChatCoreV2Capability(candidate.capabilityId)) {
    blocker = 'candidate_capability_unknown';
  } else if (requestedWindowExpired(candidate, now)) {
    blocker = 'candidate_window_expired';
  } else if (candidate.unresolvedQuestions.length > 0 && candidate.behavior !== 'clarify') {
    blocker = 'candidate_requires_clarification';
  } else if (candidateIsLowValue(candidate, expectedUserValue)) {
    blocker = 'low_value_candidate';
  } else if (actionability === 'passive' && candidate.behavior !== 'defer' && candidate.behavior !== 'suppress') {
    blocker = 'candidate_not_actionable';
  }

  return {
    candidate,
    blocker,
    actionability,
    expectedUserValue,
    userEffort,
    dependencyCount: candidate.factors.dependencies.length,
    unresolvedQuestionCount: candidate.unresolvedQuestions.length,
    semanticTieBreak: candidateSemanticTieBreak(candidate),
  };
}

function compareCandidateAssessments(
  left: SecretaryCandidatePolicyAssessment,
  right: SecretaryCandidatePolicyAssessment,
): number {
  return RELEVANCE_ORDER[left.candidate.factors.relevance] - RELEVANCE_ORDER[right.candidate.factors.relevance]
    || CONFIDENCE_ORDER[left.candidate.factors.confidence] - CONFIDENCE_ORDER[right.candidate.factors.confidence]
    || URGENCY_ORDER[left.candidate.factors.urgency] - URGENCY_ORDER[right.candidate.factors.urgency]
    || VALUE_ORDER[left.expectedUserValue] - VALUE_ORDER[right.expectedUserValue]
    || RISK_ORDER[left.candidate.factors.risk] - RISK_ORDER[right.candidate.factors.risk]
    || REVERSIBILITY_ORDER[left.candidate.factors.reversibility] - REVERSIBILITY_ORDER[right.candidate.factors.reversibility]
    || APPROVAL_ORDER[left.candidate.factors.requiredApproval] - APPROVAL_ORDER[right.candidate.factors.requiredApproval]
    || ACTIONABILITY_ORDER[left.actionability] - ACTIONABILITY_ORDER[right.actionability]
    || left.dependencyCount - right.dependencyCount
    || left.unresolvedQuestionCount - right.unresolvedQuestionCount
    || USER_EFFORT_ORDER[left.userEffort] - USER_EFFORT_ORDER[right.userEffort]
    || compareCodeUnits(left.semanticTieBreak, right.semanticTieBreak)
    || compareCodeUnits(left.candidate.candidateId, right.candidate.candidateId);
}

function selectionReasonCodes(assessment: SecretaryCandidatePolicyAssessment): string[] {
  const { candidate } = assessment;
  return [
    'candidate_selected',
    `relevance_${candidate.factors.relevance}`,
    `confidence_${candidate.factors.confidence}`,
    `urgency_${candidate.factors.urgency}`,
    `expected_value_${assessment.expectedUserValue}`,
    `risk_${candidate.factors.risk}`,
    `reversibility_${candidate.factors.reversibility}`,
    `approval_${candidate.factors.requiredApproval}`,
    `actionability_${assessment.actionability}`,
    `user_effort_${assessment.userEffort}`,
    assessment.dependencyCount > 0 ? 'dependencies_present' : 'dependencies_none',
  ];
}

function outcomeForRejectedCandidates(assessments: SecretaryCandidatePolicyAssessment[]): SecretarySelectedOutcome {
  if (assessments.length === 0) return suppressOutcome('no_useful_candidate');

  const clarification = assessments
    .filter((assessment) => assessment.blocker === 'candidate_requires_clarification')
    .sort(compareCandidateAssessments)[0];
  const question = clarification?.candidate.unresolvedQuestions[0];
  if (clarification && question) {
    return {
      behavior: 'clarify',
      candidateId: clarification.candidate.candidateId,
      userFacingText: question.question,
      conciseRationale: clarification.candidate.conciseRationale,
      evidenceIds: question.evidenceIds,
      reasonCodes: ['candidate_requires_clarification'],
      candidate: { ...clarification.candidate, behavior: 'clarify' },
    };
  }

  const blockerOrder: CandidateBlocker[] = [
    'candidate_evidence_invalid',
    'required_context_source_unavailable',
    'candidate_context_stale',
    'candidate_capability_required',
    'candidate_capability_unknown',
    'candidate_window_expired',
    'candidate_not_actionable',
    'low_value_candidate',
    'candidate_requires_clarification',
  ];
  const blocker = blockerOrder.find((code) => assessments.some((assessment) => assessment.blocker === code));
  return blocker === 'candidate_not_actionable'
    || blocker === 'low_value_candidate'
    || blocker === 'candidate_window_expired'
    ? suppressOutcome(blocker)
    : deferOutcome(blocker ?? 'no_useful_candidate');
}

function candidateActionability(candidate: SecretaryReasoningCandidate): keyof typeof ACTIONABILITY_ORDER {
  if (candidate.behavior === 'defer' || candidate.behavior === 'suppress') return 'passive';
  if (!candidate.userFacingText.trim()) return 'passive';
  if (candidate.behavior === 'suggest') {
    return candidate.factors.expectedImpact === 'none' ? 'passive' : 'medium';
  }
  if (isActionBehavior(candidate.behavior)) {
    return candidate.actionDraft && candidate.actionDraft.expectedEffectCodes.length > 0 ? 'high' : 'passive';
  }
  return 'high';
}

function riskAdjustedExpectedValue(
  candidate: SecretaryReasoningCandidate,
): keyof typeof VALUE_ORDER {
  let value = candidate.factors.expectedImpact;
  if (candidate.factors.confidence === 'low') value = lowerValue(value);
  if (candidate.factors.risk === 'critical' || candidate.factors.requiredApproval === 'unavailable') {
    value = lowerValue(value);
  }
  if (candidate.unresolvedQuestions.length > 0) value = 'none';
  return value;
}

function lowerValue(value: keyof typeof VALUE_ORDER): keyof typeof VALUE_ORDER {
  if (value === 'high') return 'medium';
  if (value === 'medium') return 'low';
  if (value === 'low') return 'none';
  return 'none';
}

function candidateUserEffort(candidate: SecretaryReasoningCandidate): keyof typeof USER_EFFORT_ORDER {
  if (candidate.unresolvedQuestions.length > 0
    || candidate.factors.requiredApproval === 'strong_confirmation'
    || candidate.factors.requiredApproval === 'admin_review'
    || candidate.factors.requiredApproval === 'unavailable') return 'high';
  if (candidate.behavior === 'clarify' || candidate.factors.requiredApproval === 'user_confirmation') return 'medium';
  if (candidate.behavior === 'suggest' || isActionBehavior(candidate.behavior)) return 'low';
  return 'none';
}

function candidateIsLowValue(
  candidate: SecretaryReasoningCandidate,
  expectedUserValue: keyof typeof VALUE_ORDER,
): boolean {
  if (candidate.behavior === 'defer' || candidate.behavior === 'suppress' || candidate.behavior === 'clarify') return false;
  if (candidate.behavior === 'suggest' && expectedUserValue === 'none') return true;
  return candidate.factors.relevance === 'weak'
    && candidate.factors.urgency === 'none'
    && (expectedUserValue === 'low' || expectedUserValue === 'none');
}

function requestedWindowExpired(candidate: SecretaryReasoningCandidate, now: Date): boolean {
  const end = candidate.actionDraft?.requestedWindow?.end;
  if (!end) return false;
  const endTime = DateTime.fromISO(end, { setZone: true });
  return endTime.isValid && endTime.toMillis() <= now.getTime();
}

function candidateSemanticTieBreak(candidate: SecretaryReasoningCandidate): string {
  return JSON.stringify({
    behavior: candidate.behavior,
    capabilityId: candidate.capabilityId ?? '',
    intent: candidate.actionDraft?.intent ?? '',
    evidenceIds: secretaryCandidateMaterialEvidenceIds(candidate),
    targetEvidenceIds: [...(candidate.actionDraft?.targetEvidenceIds ?? [])].sort(),
    expectedEffectCodes: [...(candidate.actionDraft?.expectedEffectCodes ?? [])].sort(),
  });
}

function requiredSourceUnavailable(candidate: SecretaryReasoningCandidate, snapshot: SecretaryContextSnapshot): boolean {
  const materialEvidenceIds = new Set(secretaryCandidateMaterialEvidenceIds(candidate));
  const evidenceSources = new Set(snapshot.facts
    .filter((fact) => materialEvidenceIds.has(fact.evidenceId))
    .map((fact) => fact.source));
  const requiredOperationalSources = new Set([
    ...operationalSourcesForCandidate(candidate),
    ...operationalSourcesForCurrentTurn(snapshot),
  ]);
  const currentTurn = snapshot.facts.find((fact) => fact.source === 'current_turn')?.value ?? '';
  const planningNeedsDailyState = /\b(plan\w*|priori\w*|organi[sz]\w*|what\s+should\s+i\s+do|plane\w*|organiza\w*|o\s+que\s+devo\s+fazer)\b/i.test(currentTurn);
  // Snapshot construction is responsible for representing a requested but
  // uncollected source as `unknown`. Absence from sourceHealth means the source
  // was not part of this bounded snapshot; treating absence as failure made
  // unrelated, evidence-complete candidates depend on every inferred domain.
  return snapshot.sourceHealth.some((source) => {
    if (planningNeedsDailyState && source.source === 'daily_context'
      && (source.status === 'failed' || source.status === 'permission_denied'
        || (source.status === 'empty' && source.reasonCode === 'daily_context_not_materialized'))) return true;
    if (planningNeedsDailyState && source.source === 'calendar'
      && (source.status === 'unknown' || source.status === 'failed' || source.status === 'permission_denied')) return true;
    if (planningNeedsDailyState && source.source === 'tasks'
      && (source.status === 'unknown' || source.status === 'failed' || source.status === 'permission_denied')) return true;
    if (requiredOperationalSources.has(source.source)) {
      if (source.status === 'failed' || source.status === 'permission_denied'
          || source.status === 'unknown' || source.status === 'stale') return true;
      if ((candidate.behavior === 'answer' || candidate.behavior === 'suggest')
          && (source.status === 'available' || source.status === 'empty')
          && !evidenceSources.has(source.source)) return true;
    }
    if (source.status !== 'failed' && source.status !== 'permission_denied') return false;
    return source.source === 'current_turn'
      || source.source === 'authenticated_profile'
      || evidenceSources.has(source.source)
      || requiredOperationalSources.has(source.source);
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function operationalSourcesForCurrentTurn(snapshot: SecretaryContextSnapshot): Set<string> {
  const currentTurn = snapshot.facts.find((fact) => fact.source === 'current_turn')?.value ?? '';
  const intent = analyzeIntent(currentTurn);
  const required = new Set<string>();
  if (intent.tasks) required.add('tasks');
  if (intent.calendar) required.add('calendar');
  if (intent.email) required.add('mail');
  if (intent.reminders) required.add('reminders');
  if (intent.garmin) required.add(/\b(readiness|recovery|sleep|hrv|prontid[aã]o|sono)\b/i.test(currentTurn)
    ? 'readiness'
    : 'garmin');
  if (/\b(plan\w*|priori\w*|organi[sz]\w*|what\s+should\s+i\s+do|plane\w*|organiza\w*|o\s+que\s+devo\s+fazer)\b/i.test(currentTurn)) {
    required.add('tasks');
    required.add('calendar');
  }
  return required;
}

function operationalSourcesForCandidate(candidate: SecretaryReasoningCandidate): Set<string> {
  const required = new Set<string>();
  const intent = `${candidate.capabilityId ?? ''} ${candidate.actionDraft?.intent ?? ''}`.toLowerCase();
  if (/schedule|calendar|event|meeting|agenda/.test(intent)) required.add('calendar');
  if (/task|todo/.test(intent)) required.add('tasks');
  if (/remind/.test(intent)) required.add('reminders');
  if (/mail|email|inbox/.test(intent)) required.add('mail');
  if (/workout|training|readiness|recovery/.test(intent)) required.add('readiness');
  if (/garmin/.test(intent)) required.add('garmin');
  return required;
}

function isActionBehavior(behavior: SecretaryReasoningBehavior): boolean {
  return behavior === 'decision_center' || behavior === 'authorized_execute_request' || behavior === 'conflict_review';
}

function authorizedEnvelopeMatches(
  candidate: SecretaryReasoningCandidate,
  snapshot: SecretaryContextSnapshot,
  envelope: SecretaryAuthorizedEnvelopeReference | null | undefined,
): boolean {
  const capability = candidate.capabilityId ? getChatCoreV2Capability(candidate.capabilityId) : undefined;
  return !!envelope
    && capability?.support.execute === 'supported'
    && envelope.capabilityId === candidate.capabilityId
    && envelope.contextVersion === snapshot.contextVersion
    && envelope.permissionSnapshotVersion === snapshot.permissionSnapshotVersion;
}
