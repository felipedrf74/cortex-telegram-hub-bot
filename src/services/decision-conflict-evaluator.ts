// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  normalizeDecisionAction,
  type NormalizedDecisionAction,
} from './decision-action-contract';

export const DECISION_CONFLICT_POLICY_VERSION = 'decision_conflict_policy.v1' as const;

export type ConflictDisposition =
  | 'allow'
  | 'suppress_duplicate'
  | 'auto_resolve'
  | 'needs_confirmation'
  | 'block'
  | 'supersede'
  | 'stale';

export type ConflictClass =
  | 'mutually_exclusive_effects'
  | 'time_overlap'
  | 'resource_competition'
  | 'explicit_instruction'
  | 'approved_commitment'
  | 'permission_policy'
  | 'missing_precondition'
  | 'duplicate'
  | 'supersedes'
  | 'stale_context'
  | 'preference_conflict'
  | 'inferred_goal_conflict'
  | 'low_confidence_high_impact'
  | 'unsafe_combination'
  | 'concurrent_mutation';

export type ConflictAuthority =
  | 'system_policy'
  | 'explicit_user_instruction'
  | 'approved_commitment'
  | 'data_integrity'
  | 'configured_preference'
  | 'inferred_goal'
  | 'optimization';

export interface ConflictComparisonAction {
  action: NormalizedDecisionAction;
  decisionId?: string;
  authority: ConflictAuthority;
  approved: boolean;
  createdAt: string;
  updatedAt?: string;
  validUntil?: string;
}

export interface ConflictFinding {
  class: ConflictClass;
  severity: 'hard' | 'soft';
  reasonCode: string;
  conflictingDecisionId?: string;
  resourceKey?: string;
}

export interface ConflictAlternative {
  id: string;
  label: string;
  tradeoff: string;
  startAt?: string;
  endAt?: string;
}

export interface ConflictEvaluation {
  schemaVersion: 'decision_conflict_evaluation.v1';
  policyVersion: typeof DECISION_CONFLICT_POLICY_VERSION;
  disposition: ConflictDisposition;
  findings: ConflictFinding[];
  reasonCodes: string[];
  alternatives: ConflictAlternative[];
  contextVersion: string;
  evaluatedAt: string;
  autoResolved: boolean;
  /** Closed-vocabulary explanation of deterministic precedence/tie-break steps. */
  precedenceTrace: string[];
  /** Existing decision selected by precedence, when one controls the result. */
  winnerDecisionId?: string;
}

export interface DecisionConflictSummary {
  schemaVersion: 'decision_conflict_summary.v1';
  disposition: ConflictDisposition;
  severity: 'none' | 'soft' | 'hard';
  title: string;
  explanation: string;
  reasonCodes: string[];
  requiresConfirmation: boolean;
  blocking: boolean;
  alternatives: ConflictAlternative[];
  contextVersion: string;
  evaluatedAt: string;
}

export interface EvaluateDecisionConflictsInput {
  candidate: NormalizedDecisionAction;
  existing?: ConflictComparisonAction[];
  now?: Date;
  confidence?: 'low' | 'medium' | 'high';
  authorizationAllowed?: boolean;
  missingRequiredPreconditions?: string[];
  /** False only after a deterministic combination-safety rule rejects the candidate set. */
  combinationSafetyAllowed?: boolean;
  /** Exclusivity keys currently held by an executing mutation in this scope. */
  activeExecutionExclusivityKeys?: string[];
  /** Explicit authorization for one deterministic low-risk reversible resolver rule. */
  allowLowRiskAutoResolution?: boolean;
  candidateAuthority?: ConflictAuthority;
  candidateApproved?: boolean;
  candidateDecisionId?: string;
  candidateCreatedAt?: string;
  contextFreshness?: 'fresh' | 'aging' | 'stale' | 'unknown';
  contextExpiresAt?: string;
  entityVersionsMatch?: boolean;
  /** True only after the current proposal version explicitly approved replacing a commitment. */
  replacementApproved?: boolean;
  /** Explicit confirmation for soft tradeoffs that do not replace an approved commitment. */
  confirmationApproved?: boolean;
}

const HARD_AUTHORITIES = new Set<ConflictAuthority>([
  'system_policy',
  'explicit_user_instruction',
  'data_integrity',
]);

const AUTHORITY_PRECEDENCE: Record<ConflictAuthority, number> = {
  system_policy: 0,
  explicit_user_instruction: 1,
  approved_commitment: 2,
  data_integrity: 3,
  configured_preference: 4,
  inferred_goal: 5,
  optimization: 6,
};

/**
 * Pure deterministic conflict evaluation. It intentionally has no database, model, or provider access;
 * callers must supply already-scoped authoritative comparisons. Ambiguous conflicts require review.
 */
export function evaluateDecisionConflicts(input: EvaluateDecisionConflictsInput): ConflictEvaluation {
  const now = input.now ?? new Date();
  const findings: ConflictFinding[] = [];

  if (input.authorizationAllowed === false) {
    findings.push({ class: 'permission_policy', severity: 'hard', reasonCode: 'authorization_or_policy_denied' });
  }
  for (const ref of input.missingRequiredPreconditions ?? []) {
    findings.push({ class: 'missing_precondition', severity: 'hard', reasonCode: `missing_precondition:${safeCode(ref)}` });
  }
  if (input.combinationSafetyAllowed === false) {
    findings.push({ class: 'unsafe_combination', severity: 'hard', reasonCode: 'combined_effects_violate_safety_rule' });
  }
  const activeExecutionKeys = new Set(input.activeExecutionExclusivityKeys ?? []);
  const claimedKey = input.candidate.exclusivityKeys.find((key) => activeExecutionKeys.has(key));
  if (claimedKey) {
    findings.push({
      class: 'concurrent_mutation',
      severity: 'hard',
      reasonCode: 'resource_has_active_execution',
      resourceKey: claimedKey,
    });
  }
  if (isMateriallyStale(input, now)) {
    findings.push({
      class: 'stale_context',
      severity: input.candidate.risk === 'low' ? 'soft' : 'hard',
      reasonCode: 'candidate_context_stale',
    });
  }
  if (input.confidence === 'low'
      && (input.candidate.risk === 'high' || input.candidate.risk === 'critical')) {
    findings.push({
      class: 'low_confidence_high_impact',
      severity: 'soft',
      reasonCode: 'low_confidence_high_impact_requires_review',
    });
  }

  const activeExisting = (input.existing ?? []).filter((existing) => !existing.validUntil
    || Date.parse(existing.validUntil) > now.getTime());
  for (const existing of activeExisting) {
    findings.push(...compareActions(input.candidate, existing));
  }

  const normalizedFindings = dedupeFindings(findings);
  const precedence = evaluatePrecedence(input, activeExisting, normalizedFindings, now);
  const disposition = dispositionFor(input, normalizedFindings, precedence);
  const alternatives = alternativesFor(disposition, input.candidate, normalizedFindings);
  return {
    schemaVersion: 'decision_conflict_evaluation.v1',
    policyVersion: DECISION_CONFLICT_POLICY_VERSION,
    disposition,
    findings: normalizedFindings,
    reasonCodes: [...new Set(normalizedFindings.map((finding) => finding.reasonCode))].sort(),
    alternatives,
    contextVersion: input.candidate.contextVersion,
    evaluatedAt: now.toISOString(),
    autoResolved: disposition === 'auto_resolve',
    precedenceTrace: precedence.trace,
    ...(precedence.winnerDecisionId ? { winnerDecisionId: precedence.winnerDecisionId } : {}),
  };
}

export function normalizeConflictEvaluation(value: unknown): ConflictEvaluation | null {
  if (!isRecord(value)
    || value.schemaVersion !== 'decision_conflict_evaluation.v1'
    || value.policyVersion !== DECISION_CONFLICT_POLICY_VERSION
    || !isDisposition(value.disposition)
    || typeof value.contextVersion !== 'string'
    || !validIso(value.evaluatedAt)
    || typeof value.autoResolved !== 'boolean') return null;

  const findings = Array.isArray(value.findings)
    ? value.findings.slice(0, 32).flatMap((item): ConflictFinding[] => {
      if (!isRecord(item) || !isConflictClass(item.class) || (item.severity !== 'hard' && item.severity !== 'soft')) return [];
      const reasonCode = safeToken(item.reasonCode);
      if (!reasonCode) return [];
      const conflictingDecisionId = safeToken(item.conflictingDecisionId);
      const resourceKey = safeToken(item.resourceKey);
      return [{
        class: item.class,
        severity: item.severity,
        reasonCode,
        ...(conflictingDecisionId ? { conflictingDecisionId } : {}),
        ...(resourceKey ? { resourceKey } : {}),
      }];
    })
    : [];
  const alternatives = normalizeAlternatives(value.alternatives);
  const contextVersion = safeToken(value.contextVersion);
  if (!contextVersion) return null;
  return {
    schemaVersion: 'decision_conflict_evaluation.v1',
    policyVersion: DECISION_CONFLICT_POLICY_VERSION,
    disposition: value.disposition,
    findings: dedupeFindings(findings),
    reasonCodes: [...new Set(findings.map((finding) => finding.reasonCode))].sort(),
    alternatives,
    contextVersion,
    evaluatedAt: new Date(String(value.evaluatedAt)).toISOString(),
    autoResolved: value.autoResolved,
    precedenceTrace: Array.isArray(value.precedenceTrace)
      ? value.precedenceTrace.map(safeToken).filter((item): item is string => !!item).slice(0, 16)
      : [],
    ...(safeToken(value.winnerDecisionId) ? { winnerDecisionId: safeToken(value.winnerDecisionId)! } : {}),
  };
}

/**
 * Restore one privacy-safe producer comparison from persisted decision context.
 * Action hashes are recomputed by normalizeDecisionAction, so corrupted or
 * model-authored identities fail closed instead of influencing precedence.
 */
export function normalizeConflictComparisonAction(value: unknown): ConflictComparisonAction | null {
  if (!isRecord(value)
    || !isConflictAuthority(value.authority)
    || typeof value.approved !== 'boolean'
    || !validIso(value.createdAt)
    || (value.updatedAt != null && !validIso(value.updatedAt))
    || (value.validUntil != null && !validIso(value.validUntil))) return null;
  const action = normalizeDecisionAction(value.action);
  if (!action) return null;
  const decisionId = safeToken(value.decisionId);
  if (value.decisionId != null && !decisionId) return null;
  const updatedAt = validIso(value.updatedAt) ? new Date(String(value.updatedAt)).toISOString() : undefined;
  const validUntil = validIso(value.validUntil) ? new Date(String(value.validUntil)).toISOString() : undefined;
  return {
    action,
    authority: value.authority,
    approved: value.approved,
    createdAt: new Date(String(value.createdAt)).toISOString(),
    ...(decisionId ? { decisionId } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(validUntil ? { validUntil } : {}),
  };
}

export function buildDecisionConflictSummary(
  evaluation: ConflictEvaluation | null | undefined,
  locale?: string | null,
): DecisionConflictSummary | null {
  if (!evaluation) return null;
  const pt = String(locale ?? '').toLowerCase().startsWith('pt');
  const severity = evaluation.findings.some((finding) => finding.severity === 'hard')
    ? 'hard'
    : evaluation.findings.length > 0 ? 'soft' : 'none';
  const hasTimeConflict = evaluation.findings.some((finding) => finding.class === 'time_overlap');
  const blocking = evaluation.disposition === 'block' || evaluation.disposition === 'stale';
  const requiresConfirmation = evaluation.disposition === 'needs_confirmation';

  const title = hasTimeConflict
    ? (pt ? 'Dois compromissos sobrepõem-se' : 'Two calendar commitments overlap')
    : blocking
      ? (pt ? 'Esta ação está bloqueada' : 'This action is blocked')
      : (pt ? 'Decisões relacionadas precisam de revisão' : 'Related decisions need review');
  const explanation = hasTimeConflict
    ? (pt
      ? 'Esta ação proposta sobrepõe-se a um compromisso confirmado. O Nexus não vai alterar nenhum deles automaticamente.'
      : 'This proposed action overlaps a confirmed commitment. Nexus will not change either one automatically.')
    : blocking
      ? (pt
        ? 'Uma regra, permissão, pré-condição ou compromisso atual impede esta ação.'
        : 'A policy, permission, precondition, or current commitment prevents this action.')
      : (pt
        ? 'Revê as opções antes de o Nexus alterar o estado atual.'
        : 'Review the options before Nexus changes the current state.');

  return {
    schemaVersion: 'decision_conflict_summary.v1',
    disposition: evaluation.disposition,
    severity,
    title,
    explanation,
    reasonCodes: evaluation.reasonCodes,
    requiresConfirmation,
    blocking,
    alternatives: localizeConflictAlternatives(evaluation.alternatives, pt),
    contextVersion: evaluation.contextVersion,
    evaluatedAt: evaluation.evaluatedAt,
  };
}

function localizeConflictAlternatives(
  alternatives: ConflictAlternative[],
  portuguese: boolean,
): ConflictAlternative[] {
  if (!portuguese) return alternatives;
  const copy: Record<string, Pick<ConflictAlternative, 'label' | 'tradeoff'>> = {
    keep_existing_commitment: {
      label: 'Manter o compromisso atual',
      tradeoff: 'A ação proposta mantém-se inalterada ou é adiada.',
    },
    replace_with_candidate: {
      label: 'Usar a ação proposta',
      tradeoff: 'Requer aprovação explícita para substituir o compromisso atual.',
    },
    choose_another_time: {
      label: 'Escolher outro horário',
      tradeoff: 'Preserva ambos os compromissos, mas requer uma nova janela viável.',
    },
    review_tradeoff: {
      label: 'Rever a escolha',
      tradeoff: 'Nada muda até confirmares qual resultado deve ser protegido.',
    },
  };
  return alternatives.map((alternative) => ({
    ...alternative,
    ...(copy[alternative.id] ?? {}),
  }));
}

function compareActions(candidate: NormalizedDecisionAction, existing: ConflictComparisonAction): ConflictFinding[] {
  const result: ConflictFinding[] = [];
  const decisionFields = existing.decisionId ? { conflictingDecisionId: existing.decisionId } : {};

  if (candidate.logicalActionHash === existing.action.logicalActionHash) {
    result.push({ class: 'duplicate', severity: 'soft', reasonCode: 'exact_logical_action_duplicate', ...decisionFields });
    return result;
  }
  if (candidate.candidateFingerprint === existing.action.candidateFingerprint
      && candidate.contextVersion !== existing.action.contextVersion
      && !existing.approved) {
    result.push({ class: 'supersedes', severity: 'soft', reasonCode: 'newer_context_supersedes_unapproved_candidate', ...decisionFields });
    return result;
  }
  // An authoritative data-integrity projection is the baseline state a
  // candidate may intentionally change. When a required precondition pins
  // that exact version, it is validation evidence rather than a competing
  // action. Mismatched or unacknowledged integrity state still falls through
  // to the hard-conflict path below and can never auto-resolve.
  if ((existing.authority === 'data_integrity'
        || (existing.authority === 'approved_commitment'
          && existing.action.intent === 'preserve_active_training_plan'))
      && candidateAcknowledgesIntegrityVersion(candidate, existing.action)) {
    return result;
  }

  const sharedExclusivity = candidate.exclusivityKeys.filter((key) => existing.action.exclusivityKeys.includes(key));
  const sharedResources = candidate.affectedResources
    .map((resource) => `${resource.type}:${resource.id}`)
    .filter((key) => existing.action.affectedResources.some((resource) => `${resource.type}:${resource.id}` === key));
  const overlaps = windowsOverlap(candidate.requestedWindow, existing.action.requestedWindow);

  if (overlaps) {
    const severity: 'hard' | 'soft' = HARD_AUTHORITIES.has(existing.authority) ? 'hard' : 'soft';
    result.push({
      class: 'time_overlap',
      severity,
      reasonCode: existing.authority === 'approved_commitment'
        ? 'overlaps_approved_commitment'
        : 'requested_time_windows_overlap',
      ...decisionFields,
      ...(sharedExclusivity[0] ? { resourceKey: sharedExclusivity[0] } : {}),
    });
    if (existing.approved) {
      result.push({ class: 'approved_commitment', severity: 'soft', reasonCode: 'approved_commitment_requires_review', ...decisionFields });
    }
  }

  if (sharedExclusivity.length > 0 && !overlaps) {
    const exactTrainingTimelineOverlap = sharedResources.includes('calendar_timeline_overlap:primary');
    if (exactTrainingTimelineOverlap) {
      result.push({
        class: 'time_overlap',
        severity: 'soft',
        reasonCode: existing.approved ? 'overlaps_approved_commitment' : 'requested_time_windows_overlap',
        ...decisionFields,
        resourceKey: sharedExclusivity[0],
      });
      if (existing.approved) {
        result.push({
          class: 'approved_commitment',
          severity: 'soft',
          reasonCode: 'approved_commitment_requires_review',
          ...decisionFields,
          resourceKey: sharedExclusivity[0],
        });
      }
      return result;
    }
    result.push({
      class: 'resource_competition',
      severity: HARD_AUTHORITIES.has(existing.authority) ? 'hard' : 'soft',
      reasonCode: 'shared_exclusivity_key',
      ...decisionFields,
      resourceKey: sharedExclusivity[0],
    });
  } else if (sharedResources.length > 0 && !overlaps) {
    result.push({
      class: 'resource_competition',
      severity: 'soft',
      reasonCode: 'shared_resource',
      ...decisionFields,
      resourceKey: sharedResources[0],
    });
  }

  if (effectsConflict(candidate, existing.action)) {
    result.push({
      class: 'mutually_exclusive_effects',
      severity: existing.approved || HARD_AUTHORITIES.has(existing.authority) ? 'hard' : 'soft',
      reasonCode: 'expected_and_prohibited_effects_conflict',
      ...decisionFields,
    });
  }

  if (result.length > 0 && existing.approved
      && !result.some((finding) => finding.class === 'approved_commitment')) {
    result.push({
      class: 'approved_commitment',
      severity: 'soft',
      reasonCode: 'approved_commitment_requires_review',
      ...decisionFields,
    });
  }

  if (result.length > 0) {
    if (existing.authority === 'system_policy') {
      result.push({ class: 'permission_policy', severity: 'hard', reasonCode: 'conflicts_with_system_policy', ...decisionFields });
    } else if (existing.authority === 'explicit_user_instruction') {
      result.push({ class: 'explicit_instruction', severity: 'hard', reasonCode: 'conflicts_with_explicit_user_instruction', ...decisionFields });
    } else if (existing.authority === 'data_integrity') {
      result.push({ class: 'missing_precondition', severity: 'hard', reasonCode: 'conflicts_with_data_integrity_rule', ...decisionFields });
    } else if (existing.authority === 'configured_preference') {
      result.push({ class: 'preference_conflict', severity: 'soft', reasonCode: 'configured_preferences_cannot_both_be_satisfied', ...decisionFields });
    } else if (existing.authority === 'inferred_goal') {
      result.push({ class: 'inferred_goal_conflict', severity: 'soft', reasonCode: 'inferred_goals_compete', ...decisionFields });
    }
  }

  return result;
}

function candidateAcknowledgesIntegrityVersion(
  candidate: NormalizedDecisionAction,
  integrity: NormalizedDecisionAction,
): boolean {
  return integrity.targetEntities.some((target) => target.version
    && candidate.preconditions.some((precondition) => precondition.required
      && precondition.ref === target.id
      && precondition.expectedVersion === target.version));
}

interface PrecedenceEvaluation {
  candidateWins: boolean;
  winnerDecisionId?: string;
  trace: string[];
}

function evaluatePrecedence(
  input: EvaluateDecisionConflictsInput,
  existing: ConflictComparisonAction[],
  findings: ConflictFinding[],
  now: Date,
): PrecedenceEvaluation {
  const relevantIds = new Set(findings.map((finding) => finding.conflictingDecisionId).filter(Boolean));
  if (relevantIds.size === 0) {
    return { candidateWins: true, trace: ['no_identified_competing_decision'] };
  }
  const relevant = existing.filter((item) => !!item.decisionId && relevantIds.has(item.decisionId));
  if (relevant.length === 0) return { candidateWins: true, trace: ['candidate_has_no_competing_authority'] };

  const candidate: ConflictComparisonAction & { decisionId: string } = {
    authority: input.candidateAuthority ?? 'optimization',
    approved: input.candidateApproved === true,
    createdAt: input.candidateCreatedAt ?? now.toISOString(),
    decisionId: input.candidateDecisionId ?? 'candidate',
    action: input.candidate,
  };
  const ordered: Array<ConflictComparisonAction & { decisionId: string }> = [
    candidate,
    ...relevant.map((item) => ({
      ...item,
      decisionId: item.decisionId ?? `logical:${item.action.logicalActionHash}`,
    })),
  ].sort(comparePrecedence);
  const winner = ordered[0];
  const candidateWins = winner === candidate;
  return {
    candidateWins,
    ...(candidateWins || !winner.decisionId ? {} : { winnerDecisionId: winner.decisionId }),
    trace: [
      `authority:${winner.authority}`,
      winner.approved ? 'approved_wins' : 'unapproved',
      `freshness:${winner.updatedAt ?? winner.createdAt}`,
      `risk:${winner.action.risk}`,
      `reversibility:${winner.action.reversibility}`,
      `stable_id:${winner.decisionId ?? 'candidate'}`,
    ],
  };
}

function comparePrecedence(
  left: ConflictComparisonAction & { decisionId: string },
  right: ConflictComparisonAction & { decisionId: string },
): number {
  const authority = AUTHORITY_PRECEDENCE[left.authority] - AUTHORITY_PRECEDENCE[right.authority];
  if (authority !== 0) return authority;
  if (left.approved !== right.approved) return left.approved ? -1 : 1;
  const comparableVersionOrder = compareDeclaredComparableEntityVersions(left.action, right.action);
  if (comparableVersionOrder !== 0) return comparableVersionOrder;
  const leftFreshness = Date.parse(left.updatedAt ?? left.createdAt);
  const rightFreshness = Date.parse(right.updatedAt ?? right.createdAt);
  if (leftFreshness !== rightFreshness) return rightFreshness - leftFreshness;
  const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  if (riskOrder[left.action.risk] !== riskOrder[right.action.risk]) {
    return riskOrder[left.action.risk] - riskOrder[right.action.risk];
  }
  const reversibleOrder = { reversible: 0, compensatable: 1, irreversible: 2 } as const;
  if (reversibleOrder[left.action.reversibility] !== reversibleOrder[right.action.reversibility]) {
    return reversibleOrder[left.action.reversibility] - reversibleOrder[right.action.reversibility];
  }
  return compareCodeUnits(left.decisionId, right.decisionId);
}

/**
 * Versions only participate when both actions target the same entity and both
 * adapters supplied canonical decimal revisions. Opaque/HMAC/provider versions
 * are identities, not orderable counters, and therefore fall through to the
 * authoritative observation timestamp and stable decision ID.
 */
function compareDeclaredComparableEntityVersions(
  left: NormalizedDecisionAction,
  right: NormalizedDecisionAction,
): number {
  const rightByEntity = new Map(right.targetEntities.map((entity) => [`${entity.type}:${entity.id}`, entity.version]));
  const shared = left.targetEntities
    .map((entity) => ({ key: `${entity.type}:${entity.id}`, left: entity.version, right: rightByEntity.get(`${entity.type}:${entity.id}`) }))
    .filter((entry) => entry.left != null && entry.right != null)
    .sort((a, b) => compareCodeUnits(a.key, b.key));
  for (const entry of shared) {
    if (!isCanonicalDecimalRevision(entry.left) || !isCanonicalDecimalRevision(entry.right)) continue;
    const leftRevision = BigInt(entry.left);
    const rightRevision = BigInt(entry.right);
    if (leftRevision !== rightRevision) return leftRevision > rightRevision ? -1 : 1;
  }
  return 0;
}

function isCanonicalDecimalRevision(value: string | undefined): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dispositionFor(
  input: EvaluateDecisionConflictsInput,
  findings: ConflictFinding[],
  precedence: PrecedenceEvaluation,
): ConflictDisposition {
  if (findings.some((finding) => finding.class === 'permission_policy' || finding.class === 'missing_precondition')) return 'block';
  if (findings.some((finding) => finding.class === 'stale_context')) return 'stale';
  if (findings.some((finding) => finding.severity === 'hard')) return 'block';
  if (findings.some((finding) => finding.class === 'duplicate')) return 'suppress_duplicate';
  if (findings.length > 0 && findings.every((finding) => finding.class === 'supersedes')) {
    return precedence.candidateWins ? 'supersede' : 'suppress_duplicate';
  }
  if (input.replacementApproved === true && precedence.candidateWins && findings.length > 0) return 'allow';
  if (input.confirmationApproved === true
      && findings.length > 0
      && findings.every((finding) => finding.severity === 'soft')
      && !findings.some((finding) => finding.class === 'approved_commitment')) return 'allow';
  if (
    input.allowLowRiskAutoResolution === true
    && input.candidate.risk === 'low'
    && input.candidate.reversibility === 'reversible'
    && findings.length > 0
    && findings.every((finding) => finding.severity === 'soft' && finding.class === 'resource_competition')
  ) return 'auto_resolve';
  if (findings.length > 0) return 'needs_confirmation';
  if (input.candidate.risk === 'critical' || input.candidate.reversibility === 'irreversible') return 'needs_confirmation';
  return 'allow';
}

function alternativesFor(
  disposition: ConflictDisposition,
  candidate: NormalizedDecisionAction,
  findings: ConflictFinding[],
): ConflictAlternative[] {
  if (disposition !== 'needs_confirmation') return [];
  const window = candidate.requestedWindow;
  if (findings.some((finding) => finding.class === 'time_overlap' || finding.class === 'approved_commitment')) {
    return [
      { id: 'keep_existing_commitment', label: 'Keep current commitment', tradeoff: 'The proposed action stays unchanged or is deferred.' },
      {
        id: 'replace_with_candidate',
        label: 'Use proposed action',
        tradeoff: 'Requires explicit approval to replace the current commitment.',
        ...(window ? { startAt: window.start, endAt: window.end } : {}),
      },
      { id: 'choose_another_time', label: 'Choose another time', tradeoff: 'Preserves both commitments but requires a new feasible window.' },
    ];
  }
  return [{ id: 'review_tradeoff', label: 'Review the tradeoff', tradeoff: 'No state changes until you confirm which outcome to protect.' }];
}

function effectsConflict(candidate: NormalizedDecisionAction, existing: NormalizedDecisionAction): boolean {
  const candidateExpected = new Set(candidate.expectedEffects.map(effectKey));
  const existingExpected = new Set(existing.expectedEffects.map(effectKey));
  return candidate.prohibitedEffects.some((effect) => existingExpected.has(effectKey(effect)))
    || existing.prohibitedEffects.some((effect) => candidateExpected.has(effectKey(effect)));
}

function effectKey(effect: { type: string; targetRef: string; value?: string }): string {
  return `${effect.type}:${effect.targetRef}:${effect.value ?? ''}`;
}

function windowsOverlap(
  left?: NormalizedDecisionAction['requestedWindow'],
  right?: NormalizedDecisionAction['requestedWindow'],
): boolean {
  if (!left || !right) return false;
  return Date.parse(left.start) < Date.parse(right.end) && Date.parse(right.start) < Date.parse(left.end);
}

function isMateriallyStale(input: EvaluateDecisionConflictsInput, now: Date): boolean {
  if (input.contextFreshness === 'stale' || input.entityVersionsMatch === false) return true;
  if (input.contextExpiresAt && Date.parse(input.contextExpiresAt) <= now.getTime()) return true;
  if (!input.candidate.requestedWindow) return false;
  return Date.parse(input.candidate.requestedWindow.end) <= now.getTime();
}

function dedupeFindings(findings: ConflictFinding[]): ConflictFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.class}:${finding.severity}:${finding.reasonCode}:${finding.conflictingDecisionId ?? ''}:${finding.resourceKey ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => compareCodeUnits(
    `${a.severity}:${a.class}:${a.reasonCode}`,
    `${b.severity}:${b.class}:${b.reasonCode}`,
  ));
}

function normalizeAlternatives(value: unknown): ConflictAlternative[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item): ConflictAlternative[] => {
    if (!isRecord(item)) return [];
    const id = safeToken(item.id);
    const label = safeToken(item.label);
    const tradeoff = safeToken(item.tradeoff);
    if (!id || !label || !tradeoff) return [];
    const startAt = validIso(item.startAt) ? new Date(String(item.startAt)).toISOString() : undefined;
    const endAt = validIso(item.endAt) ? new Date(String(item.endAt)).toISOString() : undefined;
    return [{ id, label, tradeoff, ...(startAt ? { startAt } : {}), ...(endAt ? { endAt } : {}) }];
  });
}

function safeCode(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 80) || 'unknown';
}

function safeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

function validIso(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isDisposition(value: unknown): value is ConflictDisposition {
  return value === 'allow' || value === 'suppress_duplicate' || value === 'auto_resolve'
    || value === 'needs_confirmation' || value === 'block' || value === 'supersede' || value === 'stale';
}

function isConflictClass(value: unknown): value is ConflictClass {
  return value === 'mutually_exclusive_effects' || value === 'time_overlap' || value === 'resource_competition'
    || value === 'explicit_instruction' || value === 'approved_commitment' || value === 'permission_policy'
    || value === 'missing_precondition' || value === 'duplicate' || value === 'supersedes'
    || value === 'stale_context' || value === 'preference_conflict' || value === 'inferred_goal_conflict'
    || value === 'low_confidence_high_impact' || value === 'unsafe_combination' || value === 'concurrent_mutation';
}

function isConflictAuthority(value: unknown): value is ConflictAuthority {
  return value === 'system_policy' || value === 'explicit_user_instruction'
    || value === 'approved_commitment' || value === 'data_integrity'
    || value === 'configured_preference' || value === 'inferred_goal'
    || value === 'optimization';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow helper used by JSON-context normalization. */
export function normalizeConflictAction(value: unknown): NormalizedDecisionAction | null {
  return normalizeDecisionAction(value);
}
