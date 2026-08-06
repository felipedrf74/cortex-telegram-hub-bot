// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Decision Center facade.
 *
 * Notification Orchestrator remains the durable substrate for intents,
 * in-app items, preferences, device tokens, and APNs delivery attempts.
 * This module is the stricter Decision Center layer: it filters intent noise
 * down to true decisions, exposes fast Home summaries, and executes actions
 * only when a deterministic backend verifier can prove the expected effect.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { getDb } from './database';
import { emitDomainEvent } from './event-outbox';
import { incrementTrainingGenerationCounter } from './training-generation-observability';
import { trainingOperationLockPublicError } from './training-operation-locks';
import {
  buildSkillNotificationFixtureIntent,
  createNotificationIntent,
  ensureNotificationTables,
  getNotificationProfileIfExists,
  getOrCreateNotificationProfile,
  getNotificationReliabilityDashboard,
  listNotificationCenterItems,
  markNotificationCenterItemRead,
  updateNotificationProfile,
  type NotificationActionButton,
  type NotificationCenterItem,
  type NotificationIntentInput,
  type NotificationIntentType,
  type NotificationPriority,
  type NotificationPrivacyPolicy,
  type NotificationProfile,
  type NotificationSourceSkill,
} from './notification-orchestrator';
import { listNotificationApnsActionExposures } from './notification-contracts';
import {
  decideContentWorkspaceReview as decideContentApproval,
  getContentDecisionWorkspaceObject as getContentWorkflowObject,
} from './content-workspace-decision-adapter';
import {
  getSecretaryAgendaItemById,
  type ReasoningTrailNode,
  type SecretaryAgendaItem,
} from './secretary-scheduling-arbitrator';
import { secretaryAgendaStateRevision } from './secretary-agenda-state-revision';
import {
  getMealPlan,
  setMealPlan,
} from './cooking-chef';
import {
  getTaxEvents,
  markTaxPaid,
} from './finance-tracker';
import { listTasksForUser } from './task-store/task-service';
import { priorityToImportance } from './task-store/task-priority';
import type { NormalizedTask } from './task-store/types';
import {
  clearPendingChatConfirmation,
  getPendingChatConfirmation,
} from './chat-pending-confirmations';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';
import { normalizeSupportedLang } from '../utils/i18n';
import { getDecisionConflictPolicyV1Mode, isDecisionCenterCommandBusEnabled, isDecisionCenterFatigueCapsEnabled, isDecisionCenterGuidanceSkillEnabled, isDecisionCenterGuidanceV1Enabled, isDecisionChoiceOptionsEnabled, isDecisionConflictPolicyV1Enabled, isDecisionEvidenceFreshnessGateEnabled, isDecisionFeedbackSuppressionEnabled, isDecisionFlowV1EnforceEnabled, isDecisionHumanReviewGateEnabled, isDecisionLowRiskAutoResolutionEnabled, isDecisionReconnectAffordanceEnabled, isDecisionRefreshEnabled, isDecisionRollbackSnapshotProtectionEnabled, isDecisionSemanticDedupEnabled, isDecisionSemanticSupersedeEnabled, isDecisionSkillCardsEnabled, isDecisionStreakV1Enabled, isDecisionTypeSuppressionEnabled, isTrainingDecisionFlowV1EnforceEnabled } from './runtime-flags';
import { buildDecisionConflictSummary, type ConflictEvaluation, type DecisionConflictSummary } from './decision-conflict-evaluator';
import {
  buildNormalizedDecisionAction,
  logicalActionAttemptHash,
  normalizeDecisionAction,
  type NormalizedDecisionAction,
} from './decision-action-contract';
import { isLowRiskAutoReflowEligible, revalidateNormalizedDecisionAction } from './decision-preexecution-revalidator';
import { directOwnedContentObjectForDecision } from './decision-command-effects';
import {
  contentWorkflowStateRevision,
  cookingMealSlotStateRevision,
  financeTaxEventStateRevision,
} from './decision-domain-state-revision';
import { decisionRelationshipSemantics, type DecisionRelationshipKind, type DecisionRelationshipType } from './decision-relationship-types';
import { buildDecisionDedupKey, classifyDecisionDedup } from './decision-center-semantic-dedup';
import type { SecretaryTodaySummaryModel } from './secretary-orchestrator';
import { secretaryTodayLabels } from './secretary-today-copy';
import {
  buildDecisionActionTruthTableEntry,
  isDecisionActionAllowedFromApns,
  isDecisionActionExecutable,
  type DecisionActionTruthTableEntry,
} from './decision-center-action-truth-table';
import { computeSharedNotificationActionEffectiveStatus } from './notification-action-state';
import {
  getLearningCase,
  learningReviewApprovalReferenceForExecution,
  recordLearningCaseReviewApproval,
} from './product-learning';
import {
  adviseSecretaryDecision,
  buildDecisionLogicV2,
  formatDecisionWindow,
  rankDecision,
  type AutomationEligibility,
  type DecisionFrontendActionState,
  type DecisionFrontendDisplayMode,
  type DecisionLogicContext,
  type DecisionLogicV2,
  type DecisionQualityGateResult,
  type SecretaryAvailableSlot,
  type SecretaryDecisionAdvice,
  type DecisionVisibilityScope,
  type DecisionWhatWillChange,
  type DecisionWhy,
} from './decision-center-logic-v2';

export type DecisionClassification = 'decision' | 'notification' | 'task' | 'insight' | 'ignore';
export type DecisionUrgency = 'urgent' | 'today' | 'this_week' | 'optional';
export type DecisionActionStatus = 'succeeded' | 'failed' | 'blocked' | 'idempotent';

// ── Layered status model (Foundation) ──────────────────────────────────────
// The legacy flat `status` (NotificationCenterStatus) stays authoritative for
// back-compat; these express the distinct concerns it conflated. Effective
// statuses are COMPUTED, never persisted as the source of truth.
/** Where the decision is in its lifecycle (distinct from the action outcome). */
export type DecisionLifecycleStatus =
  | 'created' | 'surfaced' | 'viewed' | 'snoozed' | 'dismissed' | 'expired' | 'superseded' | 'completed';
/** Durable review state. NULL on legacy rows means derive from the legacy notification status. */
export type DurableDecisionState =
  | 'proposed' | 'needs_input' | 'blocked' | 'ready_for_review' | 'approved'
  | 'rejected' | 'deferred' | 'superseded' | 'expired' | 'cancelled';
/** Item-level outcome of the decision's action. Distinct from the per-execution DecisionActionStatus above. */
export type DecisionActionOutcomeStatus =
  | 'none' | 'started' | 'succeeded' | 'failed' | 'partially_failed' | 'rolled_back';
export type DecisionApprovalLevel = 'none' | 'user_confirmation' | 'strong_confirmation' | 'admin_review' | 'unavailable';
export interface DecisionEffectResult {
  effectId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'compensated' | 'unknown';
  reasonCode?: string;
}
export interface DecisionExecutionSummary {
  status: DecisionActionOutcomeStatus;
  lastAttemptId?: string;
  effectResults: DecisionEffectResult[];
  recoveryActions: NotificationActionButton[];
  message?: string;
}
/** Computed: how the client should render the item. Never persisted as source of truth. */
export type DecisionEffectiveStatus =
  | 'needs_action' | 'waiting_on_dependency' | 'waiting_on_system' | 'snoozed'
  | 'in_progress' | 'completed' | 'failed_retryable' | 'failed_terminal'
  | 'expired' | 'superseded' | 'dismissed' | 'unavailable';
/** Computed per-action render state. */
export interface DecisionActionEffectiveStatus {
  actionId: string;
  effective:
    | 'enabled' | 'disabled_unsupported' | 'disabled_not_implemented' | 'disabled_blocked_by_dependency'
    | 'disabled_expired' | 'disabled_superseded' | 'disabled_already_actioned' | 'disabled_missing_details'
    // A2: an unwired sync-retry on a connection/sync_failure decision — disabled, but the client should
    // route to connection settings (reconnect) rather than show a dead retry. Emitted only under the
    // DECISION_RECONNECT_AFFORDANCE flag; OFF falls back to disabled_not_implemented (byte-identical).
    | 'disabled_requires_reconnect';
  implemented: boolean;
  capabilityReason: string | null;
}

/** What kind of item this is, for differentiated client rendering. */
export type DecisionKind =
  | 'insight' | 'recommendation' | 'action_proposal' | 'choice_required'
  | 'risk_alert' | 'blocked_action' | 'status_update';
/** How the client should treat acting on this decision (computed; never persisted). */
export type Actionability =
  | 'read_only' | 'preview_available' | 'confirmation_required' | 'execute_with_undo'
  | 'requires_human_review' | 'blocked' | 'unavailable';

/** Priority tier — deliberately separate from confidence. */
export type DecisionPriorityTier = 'critical' | 'high' | 'normal' | 'low';
/** Multi-signal priority (separate from confidence). Computed live for now; persistence is a follow-up. */
export interface DecisionPrioritySnapshot {
  priorityTier: DecisionPriorityTier;
  priorityScore: number;
  reasonCodes: string[];
  computedAt: string;
  rankingVersion: number;
}

/** "Evidence strength" — confidence promoted to an explanation. label/sourceFreshness are always safe;
 *  basis/uncertainty are privacy-gated (only when decision evidence is exposable). */
export interface ConfidenceExplanation {
  value: number;
  label: 'high' | 'medium' | 'low';
  basis: string[];
  uncertainty: string[];
  sourceFreshness: 'live' | 'fresh' | 'stale' | 'unknown';
}

/**
 * Compact list/overview card (API v2). Projected from the full DecisionApiItem so list
 * surfaces ship ~22 fields/item instead of ~70. Full item is served only on detail.
 */
/** Compact evidence-strength signal for the v2 list card — derived ONLY from the always-safe
 *  confidence label + source freshness (never the privacy-gated basis/uncertainty). */
export type EvidenceStrengthLabel = 'strong' | 'moderate' | 'weak' | 'stale' | 'unverified';

export interface DecisionCardSummary {
  schemaVersion: string;
  decisionId: string;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  status: string;
  effectiveStatus?: DecisionEffectiveStatus;
  decisionKind?: DecisionKind;
  actionability?: Actionability;
  prioritySnapshot?: DecisionPrioritySnapshot;
  urgency: DecisionUrgency;
  timingLabel: string | null;
  priorityScore: number;
  sectionKey: DecisionTimelineSectionKey;
  groupKey: string;
  displayMode: DecisionFrontendDisplayMode;
  frontendActionState: DecisionFrontendActionState;
  impactLevel: 'low' | 'medium' | 'high';
  safePreviewTitle: string;
  safePreviewBody: string;
  recommendedActionLabel: string | null;
  primaryActionLabel: string;
  deadlineAt: string | null;
  expiresAt: string | null;
  badgeContribution: boolean;
  confidence: number;
  /** Optional compact evidence-strength label (omitted when the item has no confidenceExplanation). */
  evidenceStrengthLabel?: EvidenceStrengthLabel;
  /** Additive conflict-policy summary. Omitted unless the v1 policy flag is enabled for this scope. */
  conflictSummary?: DecisionConflictSummary;
  /** Version of the authoritative context used to evaluate the proposal. */
  contextVersion?: string;
  contextObservedAt?: string;
  contextFreshness?: DecisionAnalysisBundle['sourceFreshness'];
  mutualExclusionGroupId?: string;
  supersededByDecisionId?: string;
  requiredPermissions?: string[];
  approvalLevel?: DecisionApprovalLevel;
  /** True only when the versioned review endpoint is enabled for this scope and this proposal can be reviewed. */
  reviewSupported?: boolean;
  /** Structured proposal fields the backend permits this client to edit. */
  editableProposalFields?: string[];
  reversibility?: NormalizedDecisionAction['reversibility'];
  execution?: DecisionExecutionSummary;
  /** Whether the token-zero refresh/revalidation route is available for this scope. */
  refreshSupported?: boolean;
  /** Optimistic concurrency version for proposal/lifecycle mutations. */
  recordVersion?: number;
  /** Durable review state; legacy rows are projected without rewriting them. */
  decisionState?: DurableDecisionState;
}

/** Paginated list envelope (API v2 cursor mode — always compact cards). nextCursor omitted when no further page. */
export interface DecisionListResponse {
  schemaVersion: string;
  count: number;
  openCount: number;
  items: DecisionCardSummary[];
  nextCursor?: string;
  pageSize: number;
}

export const DECISION_OUTCOME_LEDGER_RETENTION_POLICY = Object.freeze({
  rawOutcomeRetentionDays: 180,
  aggregateRetentionDays: 730,
  adminReportingScope: 'aggregate_only',
  privateTextPolicy: 'never_store_raw_private_text',
});

export interface DecisionOutcomeMetrics {
  userId: number;
  tenantId: number;
  totalOutcomes: number;
  decisionQualityScore: number | null;
  decisionSpecificityScore: number | null;
  decisionActionabilityScore: number | null;
  acceptedCount: number;
  dismissedCount: number;
  deferredCount: number;
  snoozedCount: number;
  askedNexusCount: number;
  explanationOpenCount: number;
  genericBlockedCount: number;
  totalQualityGateEvents: number;
  qualityGateByStatus: Record<string, number>;
  undoUsedCount: number;
  primaryActionCount: number;
  failedActionCount: number;
  partialFailureCount: number;
  autoHandledCount: number;
  averageTimeToActionMs: number | null;
  primaryActionRate: number;
  dismissRate: number;
  deferRate: number;
  snoozeRate: number;
  explanationOpenRate: number;
  genericBlockedRate: number;
  failedActionRate: number;
  partialFailureRate: number;
  bySourceSkill: Record<string, number>;
  bySourceSkillOutcome: Record<string, {
    total: number;
    accepted: number;
    dismissed: number;
    deferred: number;
  }>;
}

export interface DecisionEligibilityPolicyInput {
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  priority: NotificationPriority;
  requiresUserAction?: boolean;
  actionButtons?: NotificationActionButton[];
  deliveryPolicy?: string | null;
}

export interface DecisionEligibilityResult {
  classification: DecisionClassification;
  reasons: string[];
  apnsEligible: boolean;
  urgency: DecisionUrgency;
}

export interface DecisionApiItem {
  decisionId: string;
  itemId: string;
  id: string;
  intentId: string;
  decisionLogId: string | null;
  userId: number;
  tenantId: number;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  status: string;
  lifecycleStatus?: DecisionLifecycleStatus;
  actionOutcomeStatus?: DecisionActionOutcomeStatus;
  effectiveStatus?: DecisionEffectiveStatus;
  actionEffectiveStatuses?: DecisionActionEffectiveStatus[];
  decisionKind?: DecisionKind;
  actionability?: Actionability;
  prioritySnapshot?: DecisionPrioritySnapshot;
  urgency: DecisionUrgency;
  timingLabel: string | null;
  priorityScore: number;
  title: string;
  summary: string;
  deeplink: string | null;
  safePreviewTitle: string;
  safePreviewBody: string;
  recommendedActionLabel: string | null;
  recommendedAction: NotificationActionButton | null;
  alternativeActions: NotificationActionButton[];
  whySummary: string;
  whyDetails: Array<{ label: string; value: string }>;
  explanation?: DecisionExplanation | null;
  problemStatement: string;
  recommendation: string;
  expectedEffect: string;
  impactIfIgnored: string;
  impactLevel: 'low' | 'medium' | 'high';
  primaryActionLabel: string;
  secondaryActionLabels: string[];
  urgencyReason: string;
  why: DecisionWhy;
  actionPreview: DecisionWhatWillChange[];
  whatWillChange: DecisionWhatWillChange[];
  alternatives: DecisionAlternativeOption[];
  /** D — structured domain choices (e.g. secretary slot picks) with tradeoffs. Optional + flag-gated:
   *  undefined (omitted from JSON) unless DECISION_CHOICE_OPTIONS is enabled AND the decision has real
   *  options, so existing clients see a byte-identical payload. */
  options?: DecisionOption[];
  /** D — skill-specific cards (content / training / finance). All optional + flag-gated (DECISION_SKILL_CARDS);
   *  each is undefined/omitted unless enabled AND the decision has a real backing domain object. */
  contentCard?: DecisionContentCard;
  trainingCard?: DecisionTrainingCard;
  financeCard?: DecisionFinanceCard;
  automationEligibility: AutomationEligibility;
  autopilotPolicy: string;
  readBackVerifier: string | null;
  handledByNexus: boolean;
  handledAt: string | null;
  outcomeSummary: string | null;
  failureReason: string | null;
  retryActions: NotificationActionButton[];
  notificationEligibility: string;
  apnsInterruptionLevel: 'passive' | 'active' | 'time-sensitive';
  collapseKey: string | null;
  badgeContribution: boolean;
  quality: DecisionQualityGateResult;
  relatedEntities: Array<{ type: string; id: string }>;
  relatedEntitiesSafe: Array<{ type: string; label: string }>;
  sourceTraceSummary: string | null;
  sourceTrace: DecisionSourceTrace | null;
  dependencyGraphSummary: string | null;
  actionTruthTableEntry: DecisionActionTruthTableEntry | null;
  askNexusContext: DecisionAskNexusContext | null;
  deadlineAt: string | null;
  expiresAt: string | null;
  confidence: number;
  analysis: DecisionAnalysisBundle;
  confidenceExplanation?: ConfidenceExplanation;
  conflictSummary?: DecisionConflictSummary;
  contextVersion?: string;
  contextObservedAt?: string;
  contextFreshness?: DecisionAnalysisBundle['sourceFreshness'];
  /** Stable privacy-safe grouping identity for decisions competing for the same exclusivity resource. */
  mutualExclusionGroupId?: string;
  /** Canonical replacement when this decision has been superseded. */
  supersededByDecisionId?: string;
  requiredPermissions: string[];
  approvalLevel: DecisionApprovalLevel;
  reviewSupported: boolean;
  editableProposalFields: string[];
  reversibility: NormalizedDecisionAction['reversibility'] | null;
  execution: DecisionExecutionSummary;
  /** Whether the token-zero refresh/revalidation route is available for this scope. */
  refreshSupported: boolean;
  recordVersion: number;
  decisionState: DurableDecisionState;
  riskLevel: 'low' | 'medium' | 'high';
  groupKey: string;
  sectionKey: DecisionTimelineSectionKey;
  displayMode: DecisionFrontendDisplayMode;
  frontendActionState: DecisionFrontendActionState;
  privacyClassification: NotificationPrivacyPolicy;
  visibilityScope: 'user_private' | 'tenant_shared' | 'tenant_admin' | 'system_admin';
  createdAt: string;
  updatedAt: string;
  snoozedUntil: string | null;
  actions: NotificationActionButton[];
  dependsOnDecisionIds: string[];
  blockedByDecisionIds: string[];
  /** C6: typed relationship edges to other decisions (only `blocks` is action-preventing; the rest are advisory). */
  relationships: DecisionRelationship[];
  rollbackAvailable: boolean;
  rollbackActionId: string | null;
}

/** A typed relationship edge surfaced to the client (C6). `type` is the raw stored relationship; `kind`/`label` come from decisionRelationshipSemantics. */
export interface DecisionRelationship {
  decisionId: string;
  type: string;
  kind: DecisionRelationshipKind;
  label: string;
}

export type DecisionExplanationStepStatus = 'done' | 'needs_user' | 'pending' | 'blocked';
export type DecisionExplanationDisplaySection = 'decision_needed' | 'what_will_change' | 'why_it_matters' | 'options' | 'verification' | 'debug';

export interface DecisionExplanationStep {
  label: string;
  detail: string;
  status: DecisionExplanationStepStatus;
}

export interface DecisionExplanationActionLabels {
  primary: string;
  secondary: string[];
}

export interface DecisionExplanation {
  headline: string;
  whatHappened: string;
  whyItMatters: string;
  nexusAction: string;
  userAction: string;
  result: string;
  verification: string;
  nextStep: string;
  steps: DecisionExplanationStep[];
  recommendedMove?: string;
  ifIgnored?: string;
  actionLabels?: DecisionExplanationActionLabels;
  displaySections?: DecisionExplanationDisplaySection[];
}

export interface DecisionAnalysisBundle {
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  sourceFreshness: 'live' | 'fresh' | 'stale' | 'unknown';
  freshnessLabel: string;
  whyNow: string;
  expectedOutcome: string;
  costOfDelay: string;
  tradeoffs: string[];
  uncertainty: string[];
  rollbackConfidence: 'high' | 'medium' | 'low' | 'none';
}

export type DecisionTimelineSectionKey = 'urgent' | 'today' | 'tomorrow' | 'this_week' | 'waiting_on_systems' | 'handled' | 'history';

export interface DecisionAlternativeOption {
  id: string;
  label: string;
  rank: 'best' | 'good' | 'not_recommended';
  reason: string;
  actionId: string | null;
  available: boolean;
  source: 'recipe' | 'system_default';
}

/**
 * A structured CHOICE option for a `choice_required`-style decision (e.g. secretary "move to which slot?").
 * Distinct from DecisionAlternativeOption (which-button): an option is a domain choice carrying its own
 * tradeoffs + a LIGHTWEIGHT intent (which existing action + payload to invoke). It deliberately carries NO
 * baked command preview — that goes stale — so the client requests a fresh confirmation at selection time
 * through the normal performDecisionAction path. Additive/optional on the item (Codable-backward-compatible).
 */
export interface DecisionOption {
  optionId: string;
  title: string;
  summary: string;
  tradeoffs: string[];
  recommended: boolean;
  risk: 'low' | 'medium' | 'high';
  /** Lightweight intent: the existing decision action this option maps to (e.g. 'choose_another_time'). */
  actionId: string;
  /** Optional payload the action needs at selection time (e.g. the chosen window). Not a baked preview. */
  actionPayload?: { startAt?: string; endAt?: string };
}

/**
 * D (content) — a skill-specific card surfacing the content pipeline state a content decision is about, so
 * the client can render "Script · Drafted · Review required · [Approve]" instead of inferring it. Every
 * field is read straight from the content workflow object (objectType / editorialState / approvalState /
 * reviewRequired) — no free text — so it cannot be tainted by injected evidence. Additive/optional on the
 * item (Codable-backward-compatible); flag-gated.
 */
export interface DecisionContentCard {
  objectType: string;
  pipelineStage: string;
  approvalState: string;
  reviewRequired: boolean;
  nextActionLabel: string | null;
}

/**
 * D (training) — a structured before/after card for a training-origin reflow decision: the current
 * (before) and recommended (after) schedule windows, a conservative risk label derived ONLY from the
 * agenda's structured decisionReasonCodes (never free text, so injected evidence can't move it), and undo
 * availability. Read-only; flag-gated; undefined (no hollow card) unless the decision truly anchors a
 * training agenda item with a real before window.
 */
export interface DecisionTrainingCard {
  beforeWindowLabel: string | null;
  afterWindowLabel: string | null;
  beforeStartAt: string | null;
  beforeEndAt: string | null;
  afterStartAt: string | null;
  afterEndAt: string | null;
  risk: 'low' | 'medium' | 'high';
  undoAvailable: boolean;
}

/**
 * D (finance) — a READ-ONLY, privacy-safe card for a finance tax-event decision. Surfaces ONLY safe
 * labels: the tax month, the payment status enum, a freshness label, and the next action. It NEVER
 * carries any amount (tax_due / inss_due / gross_income / taxable_income) and uses no overconfident copy.
 * Flag-gated; undefined (no hollow card) unless a real matching tax event exists.
 */
export interface DecisionFinanceCard {
  taxMonth: string;
  paymentStatus: string;
  freshnessLabel: string;
  nextActionLabel: string | null;
}

export interface DecisionSourceTrace {
  originatingSkill: NotificationSourceSkill;
  originatingSignal: NotificationIntentType;
  sourceEntityIds: string[];
  sourceTimestamp: string;
  enrichmentService: string;
  orchestrator: string;
  executor: string | null;
  verifier: string | null;
  relatedStateReadModels: string[];
  confidenceSource: string;
  dataFreshness: 'live' | 'cached' | 'unknown';
  /**
   * C2 workstream: ordered reasoning breadcrumbs from the Secretary
   * scheduling arbitrator. Only populated for `secretary_agenda_item`
   * related entities; empty for non-secretary decisions. iOS Codable
   * decoder treats this as optional.
   *
   * Privacy: nodes carry ONLY enum codes + ISO slot strings + numeric
   * weights. Never user copy. Pinned by W-E privacy test.
   */
  reasoningTrail?: ReasoningTrailNode[];
}

export interface DecisionAskNexusContext {
  decisionId: string;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  prompt: string;
}

export interface DecisionSummary {
  openCount: number;
  urgentCount: number;
  todayCount: number;
  handledTodayCount: number;
  topDecisionTitle: string | null;
  topDecisionSourceSkill: NotificationSourceSkill | null;
  topDecisionUrgency: DecisionUrgency | null;
  topDecisionWhy: string | null;
  topSuggestion: DecisionCenterTopSuggestion | null;
  ctaLabel: string;
  previewItems: DecisionApiItem[];
  badgeCount: number;
  gamification: DecisionGamificationSummary | null;
}

export interface DecisionCenterTopSuggestion {
  decisionId: string;
  title: string;
  actionLabel: string | null;
  whyNow: string;
  expectedOutcome: string;
  riskIfIgnored: string;
  sourceSkill: NotificationSourceSkill;
  urgency: DecisionUrgency;
}

export interface DecisionCenterOverview {
  count: number;
  openCount: number;
  handledCount: number;
  staleCount: number;
  supersededCount: number;
  generatedAt: string;
  summary: DecisionSummary;
  topSuggestion: DecisionCenterTopSuggestion | null;
  partial: {
    items: boolean;
    handled: boolean;
    summary: boolean;
  };
  secretaryToday: SecretaryTodaySummaryModel;
  /** C5: present ONLY when fatigue caps are active — lets the client split `items` into pinned primary cards + a "More" bucket. */
  fatigue?: { primaryCount: number; moreCount: number; cappedCount: number };
  /**
   * BE-1 (Content Studio): present ONLY when the overview was requested with a
   * `sourceSkill` filter. `items` is then the skill-scoped open slice and
   * `sourceSkillTotalCount` is the pre-limit open total for that skill (the
   * client's "+N more" overflow count). Counters, summary and secretaryToday
   * stay GLOBAL; unfiltered responses are byte-identical to before.
   */
  sourceSkillFilter?: NotificationSourceSkill;
  sourceSkillTotalCount?: number;
  items: DecisionApiItem[];
  handled: HandledByNexusItem[];
}

export interface DecisionGamificationSummary {
  currentStreakDays: number;
  bestStreakDays: number;
  last14Days: Array<{
    date: string;
    cleared: boolean;
    reachedZeroAt: string | null;
  }>;
  decisionsLeft: number;
  hoursLeftToday: number;
  atRisk: boolean;
}

export interface DecisionActionResult {
  actionId: string;
  status: DecisionActionStatus;
  idempotent: boolean;
  item: DecisionApiItem;
  verification: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
    message: string;
  };
}

export interface HandledByNexusItem {
  itemId: string;
  /** Originating Decision Center ID used for scoped lifecycle/conflict history. */
  decisionId: string;
  userId: number;
  tenantId: number;
  sourceSkill: NotificationSourceSkill;
  title: string;
  summary: string;
  explanation?: DecisionExplanation | null;
  actionTaken: string;
  whyBrief: string;
  relatedEntities: Array<{ type: string; id: string }>;
  rollbackAvailable: boolean;
  /** Fresh versioned command contract; absent for legacy/unsupported handled rows. */
  rollbackAction?: {
    actionId: string;
    recordVersion: number;
    contextVersion: string | null;
  };
  execution?: DecisionExecutionSummary;
  reconciliationAvailable?: boolean;
  changedRuleOption: string | null;
  createdAt: string;
  privacyClassification: NotificationPrivacyPolicy;
}

interface DecisionRecord extends NotificationCenterItem {
  relatedEntityId: string | null;
  relatedEntityType: string | null;
  decisionContext: DecisionLogicContext | null;
  requiresUserAction: boolean;
  decisionDeadline: string | null;
  privacyPolicy: NotificationPrivacyPolicy;
  deliveryPolicy: string | null;
  snoozedUntil: string | null;
  priorityScore: number | null;
  actionedAt: string | null;
  decisionLogActionTaken: string | null;
  actionResult: Record<string, unknown> | null;
  recordVersion: number;
  decisionState: DurableDecisionState | null;
  updatedAt: string;
  supersededByItemId: string | null;
  contextObservedAt: string | null;
}

function decisionFlowV1EnforcedForIntent(input: NotificationIntentInput): boolean {
  const scope = { userId: input.userId, tenantId: input.tenantId ?? input.userId };
  return input.sourceSkill === 'training'
    ? isTrainingDecisionFlowV1EnforceEnabled(process.env, scope)
    : isDecisionFlowV1EnforceEnabled(process.env, scope);
}

function decisionFlowV1EnforcedForRecord(record: DecisionRecord): boolean {
  const scope = { userId: record.userId, tenantId: record.tenantId };
  return record.sourceSkill === 'training'
    ? isTrainingDecisionFlowV1EnforceEnabled(process.env, scope)
    : isDecisionFlowV1EnforceEnabled(process.env, scope);
}

const DECISION_TYPES = new Set<NotificationIntentType>([
  'decision_required',
  'conflict_detected',
  'reflow_suggestion',
  'approval_required',
  'sync_failure',
  'security_account',
]);

const NON_DECISION_TYPES = new Set<NotificationIntentType>([
  'reminder',
  'missed_item',
  'daily_digest',
  'weekly_review',
  'insight',
]);

const MUTATING_ACTIONS = new Set([
  'approve_script',
  'request_rewrite',
  'accept_reflow',
  'choose_another_time',
  'retry',
  'option_a',
  'option_b',
  'mark_paid',
  'add_meal',
  'undo_reflow',
  'accept_chat_action_fix',
  'activate_training_plan_revision',
  'approve_product_learning_case',
]);
const VERSIONED_DECISION_ACTIONS = new Set([
  ...MUTATING_ACTIONS,
  'dismiss',
  'reject_reflow',
  'not_now',
  'snooze',
]);
const DECISION_EXECUTION_LEASE_SECONDS = 300;
const CONTENT_APPROVAL_ACTION_IDS = new Set(['approve_script', 'request_rewrite']);
const SECRETARY_REFLOW_ACTION_IDS = new Set(['accept_reflow', 'choose_another_time']);
const FINANCE_PAYMENT_ACTION_IDS = new Set(['mark_paid']);

function appNowIso(): string {
  return new Date(Date.now()).toISOString();
}

const DECISION_VERIFICATION_STATE_FIELDS: Record<string, string[]> = {
  content: ['contentApprovalState', 'approvalState', 'workflowState'],
  secretary: ['lifecycleState', 'agendaState', 'providerSyncState'],
  finance: ['paymentStatus', 'financeStatus', 'taxEventStatus'],
  training: ['planState', 'lifecycleState', 'trainingState'],
  cooking: ['mealPlanState', 'mealState'],
  sync: ['syncState'],
  system: ['systemState'],
  security: ['securityState'],
  connections: ['syncState', 'connectionState'],
};

type DecisionUserFacingFilterReason =
  | 'visible'
  | 'guidance_disabled'
  | 'admin_visibility_scope'
  | 'internal_only'
  | 'smoke_decision'
  | 'unsafe_quality'
  | 'unsafe_frontend_action'
  | 'stale_action_source'
  | 'incomplete_guidance';

interface DecisionUserFacingFilterVerdict {
  visible: boolean;
  reason: DecisionUserFacingFilterReason;
}

const GUIDANCE_DISPLAY_SECTIONS: DecisionExplanationDisplaySection[] = [
  'decision_needed',
  'what_will_change',
  'why_it_matters',
  'options',
  'verification',
];

const GUIDANCE_BANNED_TERMS: Array<{ pattern: RegExp; label: string; replacement?: string }> = [
  { pattern: /\[smoke\]/gi, label: '[SMOKE]' },
  { pattern: /decision\s+center\s+(?:v|version\s*)?\d+/gi, label: 'Decision Center version' },
  { pattern: /source[\s_-]?trace/gi, label: 'source_trace' },
  { pattern: /read[\s_-]?back/gi, label: 'read-back', replacement: 'source confirmation' },
  { pattern: /\bverifies\b/gi, label: 'verifier', replacement: 'checks' },
  { pattern: /\b(verifier|verified by verifier)\b/gi, label: 'verifier' },
  { pattern: /secretary[\s_]agenda[\s_]items?(?:[\s_]state)?/gi, label: 'secretary_agenda_items' },
  { pattern: /workflow\s+object/gi, label: 'workflow object' },
  { pattern: /\b(enum|table|model)[\s_-]?name\b/gi, label: 'schema field' },
  { pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+_(?:id|pk|fk|ref|json|table|enum|model)\b/gi, label: 'raw identifier' },
];

const decisionHandledHistoryStats = {
  writeFailures: 0,
  backfillRuns: 0,
  backfilled: 0,
  backfillFailures: 0,
};

const decisionGuidanceStats = {
  emitted: 0,
  nullGuidance: 0,
  partial: 0,
  bannedTermsCaught: 0,
  bannedTermsByTerm: {} as Record<string, number>,
  filteredFromUserView: 0,
  filteredByReason: {} as Record<string, number>,
};

export interface DecisionHandledHistoryStats {
  writeFailures: number;
  backfillRuns: number;
  backfilled: number;
  backfillFailures: number;
}

export interface DecisionGuidanceStats {
  emitted: number;
  nullGuidance: number;
  partial: number;
  bannedTermsCaught: number;
  bannedTermsByTerm: Record<string, number>;
  filteredFromUserView: number;
  filteredByReason: Record<string, number>;
}

export interface DecisionHandledHistoryBackfillResult {
  inspected: number;
  backfilled: number;
  skipped: number;
  failed: number;
}

export interface DecisionCenterSmokeCleanupResult {
  inspected: number;
  expired: number;
  dryRun: boolean;
  countsByStatus: Record<string, number>;
  countsByVisibilityScope: Record<string, number>;
}

export function getDecisionHandledHistoryStats(): DecisionHandledHistoryStats {
  return { ...decisionHandledHistoryStats };
}

export function getDecisionGuidanceStats(): DecisionGuidanceStats {
  return {
    ...decisionGuidanceStats,
    bannedTermsByTerm: { ...decisionGuidanceStats.bannedTermsByTerm },
    filteredByReason: { ...decisionGuidanceStats.filteredByReason },
  };
}

const ensuredDecisionCenterDatabases = new WeakSet<object>();

export function ensureDecisionCenterTables(): void {
  const db = getDb();
  if (ensuredDecisionCenterDatabases.has(db) && decisionFlowSchemaReady(db)) return;
  ensureNotificationTables();
  ensureColumn('notification_center_items', 'snoozed_until', 'TEXT');
  ensureColumn('notification_center_items', 'action_result_json', 'TEXT');
  ensureColumn('notification_center_items', 'priority_score', 'INTEGER');
  ensureColumn('notification_center_items', 'decision_state', 'TEXT');
  ensureColumn('notification_center_items', 'record_version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('notification_center_items', 'updated_at', 'TEXT');
  ensureColumn('notification_intents', 'context_version', 'TEXT');
  ensureColumn('notification_intents', 'context_observed_at', 'TEXT');
  ensureColumn('notification_intents', 'candidate_fingerprint', 'TEXT');
  ensureColumn('notification_intents', 'normalized_action_json', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_action_executions (
      action_execution_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      executor_skill TEXT NOT NULL,
      status TEXT NOT NULL,
      expected_effect_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      failed_at TEXT,
      error_code TEXT,
      UNIQUE(decision_id, action_id, user_id, tenant_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_action_scope
      ON decision_action_executions(user_id, tenant_id, decision_id, action_id);
    CREATE INDEX IF NOT EXISTS idx_notification_center_decision_home
      ON notification_center_items(user_id, tenant_id, status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_notification_center_decision_rank
      ON notification_center_items(user_id, tenant_id, status, priority_score DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_center_active_expiry
      ON notification_center_items(status, expires_at) WHERE expires_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS decision_dependencies (
      dependency_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      depends_on_decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'blocks',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(decision_id, depends_on_decision_id, user_id, tenant_id, relationship)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_dependencies_scope
      ON decision_dependencies(user_id, tenant_id, decision_id, relationship);
    CREATE INDEX IF NOT EXISTS idx_decision_dependencies_blocker
      ON decision_dependencies(user_id, tenant_id, depends_on_decision_id, relationship);
    CREATE TABLE IF NOT EXISTS handled_by_nexus_items (
      handled_item_id TEXT PRIMARY KEY,
      decision_id TEXT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      why_brief TEXT NOT NULL,
      explanation_json TEXT,
      related_entities_json TEXT NOT NULL DEFAULT '[]',
      rollback_available INTEGER NOT NULL DEFAULT 0,
      changed_rule_option TEXT,
      privacy_classification TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_handled_by_nexus_scope_created
      ON handled_by_nexus_items(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_outcome_ledger (
      outcome_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      automation_eligibility TEXT NOT NULL DEFAULT 'never',
      action_shown TEXT,
      action_taken TEXT,
      accepted INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      snoozed INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      asked_nexus INTEGER NOT NULL DEFAULT 0,
      manually_corrected INTEGER NOT NULL DEFAULT 0,
      undo_used INTEGER NOT NULL DEFAULT 0,
      time_to_action_ms INTEGER,
      action_succeeded INTEGER NOT NULL DEFAULT 0,
      partial_failure INTEGER NOT NULL DEFAULT 0,
      failed_reason TEXT,
      feature_snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_outcome_scope_created
      ON decision_outcome_ledger(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_quality_gate_events (
      event_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      quality_status TEXT NOT NULL,
      quality_score INTEGER NOT NULL DEFAULT 0,
      missing_fields_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL,
      generic_blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_quality_gate_scope_created
      ON decision_quality_gate_events(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      action_id TEXT,
      reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_lifecycle_events_scope_created
      ON decision_lifecycle_events(user_id, tenant_id, decision_id, created_at);
    CREATE TABLE IF NOT EXISTS decision_metrics_daily (
      metric_date TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL DEFAULT '*',
      created_count INTEGER NOT NULL DEFAULT 0,
      surfaced_count INTEGER NOT NULL DEFAULT 0,
      viewed_count INTEGER NOT NULL DEFAULT 0,
      dismissed_count INTEGER NOT NULL DEFAULT 0,
      snoozed_count INTEGER NOT NULL DEFAULT 0,
      action_succeeded_count INTEGER NOT NULL DEFAULT 0,
      action_failed_count INTEGER NOT NULL DEFAULT 0,
      expired_count INTEGER NOT NULL DEFAULT 0,
      gate_blocked_count INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (metric_date, tenant_id, source_skill)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_metrics_daily_tenant
      ON decision_metrics_daily(tenant_id, metric_date);
    CREATE TABLE IF NOT EXISTS decision_queue_daily_rollups (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      reached_zero_at TEXT,
      final_open_count INTEGER NOT NULL DEFAULT 0,
      best_observed_open_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, local_date)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_queue_daily_rollups_scope_date
      ON decision_queue_daily_rollups(user_id, tenant_id, local_date DESC);
    CREATE TABLE IF NOT EXISTS decision_type_suppressions (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      mode TEXT NOT NULL,
      until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, source_skill, type)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_type_suppressions_scope
      ON decision_type_suppressions(user_id, tenant_id);
    CREATE TABLE IF NOT EXISTS decision_recipe_suppressions (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      recipe TEXT NOT NULL,
      mode TEXT NOT NULL,
      until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, source_skill, type, recipe)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_recipe_suppressions_scope
      ON decision_recipe_suppressions(user_id, tenant_id, source_skill, type);
  `);
  ensureColumn('decision_action_executions', 'logical_action_hash', 'TEXT');
  ensureColumn('decision_action_executions', 'expected_record_version', 'INTEGER');
  ensureColumn('decision_action_executions', 'context_version', 'TEXT');
  ensureColumn('decision_action_executions', 'lease_expires_at', 'TEXT');
  ensureColumn('decision_action_executions', 'effect_results_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('decision_action_executions', 'recovery_json', "TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    UPDATE notification_center_items
       SET updated_at = COALESCE(updated_at, created_at),
           record_version = COALESCE(record_version, 1)
     WHERE updated_at IS NULL OR record_version IS NULL;
    CREATE TABLE IF NOT EXISTS decision_conflict_evaluations (
      conflict_evaluation_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      policy_version TEXT NOT NULL,
      context_version TEXT NOT NULL,
      disposition TEXT NOT NULL,
      hard_conflict_count INTEGER NOT NULL DEFAULT 0,
      soft_conflict_count INTEGER NOT NULL DEFAULT 0,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      related_decision_ids_json TEXT NOT NULL DEFAULT '[]',
      precedence_trace_json TEXT NOT NULL DEFAULT '[]',
      winner_decision_id TEXT,
      resolution TEXT,
      automatically_resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS decision_exclusivity_claims (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      exclusivity_key TEXT NOT NULL,
      action_execution_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      context_version TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, exclusivity_key)
    );
    CREATE TABLE IF NOT EXISTS decision_flow_preferences (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      allow_low_risk_auto_reflow INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_intents_candidate_fingerprint
      ON notification_intents(user_id, tenant_id, candidate_fingerprint, created_at DESC)
      WHERE candidate_fingerprint IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_decision_conflict_scope_created
      ON decision_conflict_evaluations(user_id, tenant_id, decision_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_exclusivity_lease
      ON decision_exclusivity_claims(user_id, tenant_id, lease_expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_execution_active_logical_action
      ON decision_action_executions(user_id, tenant_id, logical_action_hash)
      WHERE logical_action_hash IS NOT NULL AND status IN ('started', 'succeeded', 'partially_failed');
  `);
  ensureColumn('decision_conflict_evaluations', 'precedence_trace_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('decision_conflict_evaluations', 'winner_decision_id', 'TEXT');
  ensureColumn('handled_by_nexus_items', 'explanation_json', 'TEXT');
  ensuredDecisionCenterDatabases.add(db);
}

function decisionFlowSchemaReady(db: ReturnType<typeof getDb>): boolean {
  try {
    const preferenceTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'decision_flow_preferences'
       LIMIT 1
    `).get();
    if (!preferenceTable) return false;
    const itemColumns = new Set((db.prepare('PRAGMA table_info(notification_center_items)').all() as Array<{ name: string }>).map((row) => row.name));
    return itemColumns.has('decision_state') && itemColumns.has('record_version') && itemColumns.has('updated_at');
  } catch {
    return false;
  }
}

export function evaluateDecisionEligibility(input: DecisionEligibilityPolicyInput): DecisionEligibilityResult {
  const reasons: string[] = [];
  const requiresUserAction = input.requiresUserAction === true;
  const urgency = urgencyForPriority(input.priority);

  if (NON_DECISION_TYPES.has(input.type) && !requiresUserAction) {
    reasons.push(`${input.type} is routine notification/insight, not a user decision`);
    if ((input.actionButtons ?? []).some((action) => action.id !== 'open_detail')) {
      reasons.push('notification action buttons do not imply a user decision without explicit requiresUserAction');
    }
    return { classification: input.type === 'insight' ? 'insight' : 'notification', reasons, apnsEligible: false, urgency };
  }

  if (input.type === 'schedule_changed' && !requiresUserAction) {
    reasons.push('schedule_changed without a required choice is a notification');
    return { classification: 'notification', reasons, apnsEligible: false, urgency };
  }

  if (DECISION_TYPES.has(input.type) || requiresUserAction) {
    reasons.push('requires judgment, approval, correction, or meaningful choice');
    return {
      classification: 'decision',
      reasons,
      apnsEligible: isVisiblePushEligible(input.priority, input.type, requiresUserAction),
      urgency,
    };
  }

  reasons.push('no user action required');
  return { classification: 'ignore', reasons, apnsEligible: false, urgency };
}

/** Active decisions' dedup-key fields, used to detect semantic conflicts at creation time (B3 acting). */
function listActiveDedupCandidates(userId: number, tenantId: number, excludeId: string): Array<{
  decisionId: string; sourceSkill: NotificationSourceSkill; type: NotificationIntentType; relatedEntityId: string | null; dedupeKey: string | null; createdAt: string;
}> {
  // Active AND not-yet-expired (mirrors the A1 expiry predicate so we never link to an expired-but-unswept
  // decision), bounded + recency-ordered so this stays cheap on the hot creation path even past the
  // ~50-active-per-user product ceiling (recent decisions are the ones that can share a time window).
  return getDb().prepare(`
    SELECT items.item_id AS decisionId, items.source_skill AS sourceSkill, items.type AS type,
           intents.related_entity_id AS relatedEntityId, items.dedupe_key AS dedupeKey, items.created_at AS createdAt
      FROM notification_center_items items
      LEFT JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.user_id = ? AND items.tenant_id = ? AND items.item_id != ?
       AND items.status IN ('unread', 'read', 'snoozed', 'failed', 'open')
       AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))
     ORDER BY items.created_at DESC
     LIMIT 200
  `).all(userId, tenantId, excludeId, appNowIso()) as Array<{ decisionId: string; sourceSkill: NotificationSourceSkill; type: NotificationIntentType; relatedEntityId: string | null; dedupeKey: string | null; createdAt: string }>;
}

/**
 * B3 acting (first slice): when a newly-created decision SEMANTICALLY conflicts with an existing active
 * decision (overlapping target entity + same window, both unresolved asks), record a `conflicts_with`
 * relationship between them. ADDITIVE + advisory — only `blocks` prevents action, so a conflict link
 * never hides or blocks a decision; the hiding verdicts (same_recommendation / supersedes) are a
 * deliberate later slice. Non-fatal: any failure must never break decision creation. Uses the new
 * decision's stored created_at (DB clock) so candidate and existing windows are compared consistently.
 */
function linkConflictingDecisionsOnCreate(newId: string, input: NotificationIntentInput, userId: number, tenantId: number, createdAt: string): { collapsedToExistingId?: string } {
  // B3 hiding (flag-gated, decoupled from linking): when ON, the two collapsing verdicts mutate state —
  // newer_recommendation_supersedes_old supersedes the OLDER same-recipe decision; same_recommendation_
  // update_existing drops the new duplicate and returns the existing (collapsedToExistingId tells the
  // caller to return the existing item). Both NEVER touch a policy-floored or a different decision.
  const supersedeEnabled = isDecisionSemanticSupersedeEnabled(process.env, { userId, tenantId });
  let collapsedToExistingId: string | undefined;
  try {
    const timezone = getOrCreateNotificationProfile(userId, tenantId).timezone;
    const candidate = buildDecisionDedupKey({
      sourceSkill: input.sourceSkill,
      type: input.type,
      relatedEntityId: input.relatedEntityId == null ? null : String(input.relatedEntityId),
      dedupeKey: input.dedupeKey ?? null,
      createdAt,
      timezone,
    });
    for (const existing of listActiveDedupCandidates(userId, tenantId, newId)) {
      // Per-candidate isolation: a single pairing that throws (e.g. addDecisionDependency racing a
      // candidate that was swept/dismissed between the scan and its record check) must NOT abandon the
      // remaining candidates — otherwise a user with several same-entity decisions would see only the
      // ones before the failure linked. Each iteration fails independently; the outer catch still guards
      // candidate-key building and the iterator so linking can never break decision creation.
      try {
        const existingKey = buildDecisionDedupKey({
          sourceSkill: existing.sourceSkill,
          type: existing.type,
          relatedEntityId: existing.relatedEntityId,
          dedupeKey: existing.dedupeKey,
          createdAt: existing.createdAt,
          timezone,
        });
        const verdict = classifyDecisionDedup(candidate, [existingKey]).verdict;
        // Map the dedup verdict to an ADVISORY relationship type (only `blocks` prevents action, so
        // neither hides nor blocks a decision): a cross-skill conflict on the same entity+window =>
        // conflicts_with (warns the user); a cross-skill, non-conflicting decision on the same
        // entity+window => affects_same_entity (groups them for context). Written reciprocally so BOTH
        // decisions surface the link; idempotent via addDecisionDependency's INSERT OR IGNORE.
        const linkType: DecisionRelationshipType | null = verdict === 'conflicting_recommendation_link' ? 'conflicts_with'
          : verdict === 'same_issue_cluster' ? 'affects_same_entity'
          : null;
        if (linkType) {
          addDecisionDependency({ decisionId: newId, dependsOnDecisionId: existing.decisionId, userId, tenantId, relationship: linkType });
          addDecisionDependency({ decisionId: existing.decisionId, dependsOnDecisionId: newId, userId, tenantId, relationship: linkType });
        } else if (supersedeEnabled && (verdict === 'newer_recommendation_supersedes_old' || verdict === 'same_recommendation_update_existing')) {
          // HIDING slice. The matched `existing` is the OLDER same-recipe row (listActiveDedupCandidates
          // excludes newId and orders newest-first; the new row's createdAt is the latest by DB clock).
          const existingRecord = getDecisionRecord(existing.decisionId, userId, tenantId);
          if (existingRecord && isDecisionRecord(existingRecord)) {
            const existingFloored = isDecisionItemPolicyFloored(formatDecisionItemForApi(existingRecord));
            if (verdict === 'newer_recommendation_supersedes_old') {
              // Supersede the OLDER decision — but NEVER a policy-floored one (fail open: keep both).
              // (A later same-skill candidate may additionally same_recommendation-collapse this new row into
              // a third existing one in the same pass; the result — oldest hidden, newest kept — is invariant-safe.)
              if (!existingFloored) {
                supersedeDecision(existingRecord, 'semantic_superseded_by_newer_recommendation');
                addDecisionDependency({ decisionId: newId, dependsOnDecisionId: existing.decisionId, userId, tenantId, relationship: 'supersedes' });
              }
            } else {
              // same_recommendation: drop the NEW duplicate and return the existing — UNLESS the new is
              // floored and the existing is not (then fail open — never hide the floored new one).
              const newRecord = getDecisionRecord(newId, userId, tenantId);
              const newFloored = newRecord && isDecisionRecord(newRecord) ? isDecisionItemPolicyFloored(formatDecisionItemForApi(newRecord)) : false;
              if (!(newFloored && !existingFloored) && newRecord && isDecisionRecord(newRecord)) {
                supersedeDecision(newRecord, 'semantic_duplicate_of_existing');
                collapsedToExistingId = existing.decisionId;
                break; // the new row is now superseded — stop scanning further candidates for it
              }
            }
          }
        }
      } catch (pairErr) {
        logger.warn({ err: pairErr instanceof Error ? pairErr.message : String(pairErr), newId, existingId: existing.decisionId }, 'B3 conflict-linking pair failed (non-fatal; other pairs continue)');
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), newId }, 'B3 conflict-linking failed (non-fatal)');
  }
  return { collapsedToExistingId };
}

export async function createDecisionIntent(input: NotificationIntentInput): Promise<{ item: DecisionApiItem | null; eligibility: DecisionEligibilityResult }> {
  assertScope(input.userId, input.tenantId ?? input.userId, 'create_decision_intent', { sourceSkill: input.sourceSkill, type: input.type });
  ensureDecisionCenterTables();
  input = applyConflictPolicyToIntentInput(input);
  const eligibility = evaluateDecisionEligibility({
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority: input.priority,
    requiresUserAction: input.requiresUserAction,
    actionButtons: input.actionButtons,
    deliveryPolicy: input.deliveryPolicy,
  });
  if (eligibility.classification !== 'decision') {
    return { item: null, eligibility };
  }

  const conflictEvaluation = decisionContextForIntentInput(input).conflictEvaluation;
  const flowEnforced = decisionFlowV1EnforcedForIntent(input);
  const conflictPolicyEnforced = getDecisionConflictPolicyV1Mode(process.env, {
    userId: input.userId,
    tenantId: input.tenantId ?? input.userId,
  }) === 'active' || flowEnforced;
  if (conflictEvaluation?.disposition === 'suppress_duplicate'
    && conflictPolicyEnforced) {
    logger.info({
      event: 'decision.candidate_suppressed',
      userId: input.userId,
      tenantId: input.tenantId ?? input.userId,
      sourceSkill: input.sourceSkill,
      reason: 'exact_duplicate',
      canonicalDecisionId: conflictEvaluation.winnerDecisionId ?? null,
    }, 'Suppressed duplicate Decision Center candidate');
    return {
      item: null,
      eligibility: {
        ...eligibility,
        apnsEligible: false,
        reasons: [...eligibility.reasons, 'conflict_policy:duplicate'],
      },
    };
  }

  if (shouldSuppressRepeatedRejectedCandidate(input)) {
    return {
      item: null,
      eligibility: {
        ...eligibility,
        apnsEligible: false,
        reasons: [...eligibility.reasons, 'candidate_rejection_cooldown'],
      },
    };
  }

  const quality = decisionLogicForIntentInput(input).quality;
  if (!quality.safeToShowUser) {
    // C4: a blocked decision is a distinct quality-gate outcome — always record it.
    recordDecisionQualityGateEvent(input, quality);
    return {
      item: null,
      eligibility: {
        ...eligibility,
        reasons: [...eligibility.reasons, `quality_gate:${quality.status}:${quality.missingFields.join(',')}`],
        apnsEligible: false,
      },
    };
  }

  const result = await createNotificationIntent({
    ...input,
    requiresUserAction: true,
    deliveryPolicy: input.deliveryPolicy ?? (eligibility.apnsEligible ? 'auto' : 'in_app_only'),
  });
  // C4: record the passing evaluation only for a genuinely new decision, not for a
  // deduped retry of an already-active decision (which would inflate the rejection-rate denominator).
  if (result.intent.status !== 'deduped') {
    recordDecisionQualityGateEvent(input, quality);
  }
  if (result.item && result.intent.status !== 'deduped') {
    try {
      persistDecisionFlowMetadata(result.item.itemId, result.item.intentId, input);
    } catch (err) {
      logger.error({
        event: 'decision.flow_metadata_persistence_failed',
        err,
        decisionId: result.item.itemId,
        intentId: result.item.intentId,
        userId: input.userId,
        tenantId: input.tenantId ?? input.userId,
      }, 'Decision proposal was retired because its durable policy metadata could not be persisted');
      failClosedDecisionFlowMetadata(result.item.itemId, result.item.intentId, input);
      return {
        item: null,
        eligibility: {
          ...eligibility,
          apnsEligible: false,
          reasons: [...eligibility.reasons, 'decision_flow_metadata_persistence_failed'],
        },
      };
    }
    // Supersession is independent from the new proposal's own disposition.
    // A refreshed candidate can legitimately supersede an older unapproved
    // proposal while still needing review for a separate commitment conflict.
    if (conflictEvaluation && conflictPolicyEnforced) {
      for (const priorDecisionId of [...new Set(conflictEvaluation.findings
        .filter((finding) => finding.class === 'supersedes')
        .map((finding) => finding.conflictingDecisionId)
        .filter((value): value is string => !!value))]) {
        const prior = getDecisionRecord(priorDecisionId, input.userId, input.tenantId ?? input.userId);
        if (prior && !isDecisionItemPolicyFloored(formatDecisionItemForApi(prior))) {
          supersedeDecision(prior, 'normalized_action_superseded_by_newer_context');
          addDecisionDependency({
            decisionId: result.item.itemId,
            dependsOnDecisionId: priorDecisionId,
            userId: input.userId,
            tenantId: input.tenantId ?? input.userId,
            relationship: 'supersedes',
          });
          resolveDecisionConflictAudit(priorDecisionId, input.userId, input.tenantId ?? input.userId, 'superseded');
        }
      }
    }
    emitDecisionLifecycleEvent({ decisionId: result.item.itemId, userId: input.userId, tenantId: input.tenantId ?? input.userId, event: 'created', toStatus: result.item.status });
  }
  let item = result.item ? getDecisionItem(result.item.itemId, input.userId, input.tenantId ?? input.userId, { recordExposure: false }) : null;
  if (result.item && result.intent.status !== 'deduped') {
    // B3 acting: flag-gated conflict-linking (advisory edges) + optional hiding slice (supersede/collapse).
    if (item && isDecisionSemanticDedupEnabled(process.env, { userId: input.userId, tenantId: input.tenantId ?? input.userId })) {
      const linkResult = linkConflictingDecisionsOnCreate(result.item.itemId, input, input.userId, input.tenantId ?? input.userId, item.createdAt);
      // same_recommendation collapse: the new row was dropped — return the existing decision it folded into.
      if (linkResult.collapsedToExistingId) {
        item = getDecisionItem(linkResult.collapsedToExistingId, input.userId, input.tenantId ?? input.userId, { recordExposure: false });
      }
    }
  }
  if (item && result.intent.status !== 'deduped') {
    item = await maybeAutoResolveLowRiskSecretaryDecision(item) ?? item;
  }
  return { item, eligibility };
}

async function maybeAutoResolveLowRiskSecretaryDecision(item: DecisionApiItem): Promise<DecisionApiItem | null> {
  if (item.sourceSkill !== 'secretary') return null;
  const record = getDecisionRecord(item.decisionId, item.userId, item.tenantId);
  if (!record || record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) return null;
  const context = decisionContextForRecord(record);
  if (getDecisionConflictPolicyV1Mode(process.env, {
    userId: record.userId,
    tenantId: record.tenantId,
  }) !== 'active') return null;
  const action = normalizeDecisionAction(context.normalizedAction);
  const conflict = context.conflictEvaluation;
  const actionButton = actionsForRecord(record).find((candidate) => candidate.id === 'accept_reflow');
  const agenda = getSecretaryAgendaItemById({
    agendaItemId: record.relatedEntityId,
    ownerUserId: record.userId,
    tenantId: record.tenantId,
  });
  if (!action || !conflict || !actionButton || !agenda) return null;
  if (!isLowRiskAutoReflowEligible({
    action,
    conflictEvaluation: conflict,
    persistedUserOptIn: lowRiskAutoResolutionPreference(record.userId, record.tenantId),
    runtimeEnabled: isDecisionLowRiskAutoResolutionEnabled(process.env, {
      userId: record.userId,
      tenantId: record.tenantId,
    }),
    undoAvailable: agenda.agendaItemId === record.relatedEntityId
      && typeof secretaryAgendaStateRevision(agenda) === 'string',
  })) return null;

  try {
    const result = await performDecisionAction(record.itemId, 'accept_reflow', record.userId, record.tenantId, {
      idempotencyKey: `auto_reflow:${action.candidateFingerprint}:${action.contextVersion}`,
      expectedVersion: record.recordVersion,
      contextVersion: action.contextVersion,
      automaticResolution: true,
    });
    return result.item;
  } catch (err) {
    logger.error({
      event: 'decision.auto_resolution_failed',
      err,
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      policyVersion: conflict.policyVersion,
    }, 'Opted-in low-risk Secretary auto-resolution failed safely');
    const current = getDecisionRecord(record.itemId, record.userId, record.tenantId);
    return current ? formatDecisionItemForApi(current) : null;
  }
}

function lowRiskAutoResolutionAuthorized(userId: number, tenantId: number): boolean {
  return isDecisionLowRiskAutoResolutionEnabled(process.env, { userId, tenantId })
    && lowRiskAutoResolutionPreference(userId, tenantId);
}

function lowRiskAutoResolutionPreference(userId: number, tenantId: number): boolean {
  try {
    const row = getDb().prepare(`
      SELECT allow_low_risk_auto_reflow AS enabled
        FROM decision_flow_preferences
       WHERE user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(userId, tenantId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  } catch {
    return false;
  }
}

function applyConflictPolicyToIntentInput(input: NotificationIntentInput): NotificationIntentInput {
  const tenantId = input.tenantId ?? input.userId;
  const mode = getDecisionConflictPolicyV1Mode(process.env, { userId: input.userId, tenantId });
  const flowEnforced = decisionFlowV1EnforcedForIntent(input);
  if (mode === 'off' && !flowEnforced) return input;
  const initialContext = decisionContextForIntentInput(input);
  const derivedAction = normalizeDecisionAction(initialContext.normalizedAction)
    ?? deriveNormalizedActionForKnownProducer(input, initialContext);
  const context: DecisionLogicContext = derivedAction
    ? {
        ...initialContext,
        normalizedAction: derivedAction,
        contextObservedAt: initialContext.contextObservedAt ?? appNowIso(),
      }
    : initialContext;
  const action = normalizeDecisionAction(context.normalizedAction);
  if (!action) {
    if (knownProducerMutationRequiresSourceContract(input)) {
      return {
        ...input,
        actionButtons: (input.actionButtons ?? []).filter((button) => button.id === 'open_detail'),
        decisionContext: {
          ...initialContext,
          reasonCodes: [...new Set([...(initialContext.reasonCodes ?? []), 'authoritative_source_contract_unavailable'])],
        },
      };
    }
    return input;
  }
  const revalidation = revalidateNormalizedDecisionAction({
    scope: { userId: input.userId, tenantId },
    action,
    additionalExisting: context.conflictComparisons ?? undefined,
    contextExpiresAt: context.contextExpiresAt ?? input.expiresAt ?? undefined,
    candidateCreatedAt: context.contextObservedAt ?? context.providerSyncUpdatedAt ?? undefined,
    confidence: context.candidateConfidence ?? undefined,
    allowLowRiskAutoResolution: mode === 'active'
      && lowRiskAutoResolutionAuthorized(input.userId, tenantId),
  });
  const producerEvaluation = context.conflictEvaluation;
  // Current deterministic authorization, preconditions, source health, and
  // persisted comparison actions are authoritative. A producer evaluation is
  // retained only as drift telemetry; choosing by finding count could let two
  // advisory soft findings erase one hard permission/precondition failure.
  const evaluation = revalidation.conflictEvaluation;
  const producerDrift = producerEvaluation?.contextVersion === action.contextVersion
    && conflictMaterialKey(producerEvaluation) !== conflictMaterialKey(evaluation);
  logger.info({
    event: 'decision.conflict_evaluated',
    mode,
    userScope: `${input.userId}:${tenantId}`,
    sourceSkill: input.sourceSkill,
    disposition: evaluation.disposition,
    conflictClasses: evaluation.findings.map((finding) => finding.class),
    producerDrift,
    policyVersion: evaluation.policyVersion,
  }, 'Decision conflict policy evaluated candidate');
  if (mode === 'shadow' && !flowEnforced) return input;
  return {
    ...input,
    decisionContext: {
      ...context,
      normalizedAction: action,
      conflictEvaluation: evaluation,
    },
  };
}

function knownProducerMutationRequiresSourceContract(input: NotificationIntentInput): boolean {
  const relatedEntityType = typeof input.relatedEntityType === 'string' ? input.relatedEntityType : null;
  const relatedEntityId = input.relatedEntityId == null ? null : String(input.relatedEntityId);
  const actionIds = new Set((input.actionButtons ?? []).map((action) => action.id));
  return (input.sourceSkill === 'finance'
      && relatedEntityType === 'finance_tax_event'
      && !!relatedEntityId
      && /^\d{4}-(0[1-9]|1[0-2])$/.test(relatedEntityId)
      && actionIds.has('mark_paid'))
    || (input.sourceSkill === 'content'
      && relatedEntityType === 'content_workflow_object'
      && !!relatedEntityId
      && /^\d+$/.test(relatedEntityId)
      && (actionIds.has('approve_script') || actionIds.has('request_rewrite')))
    || (input.sourceSkill === 'cooking'
      && relatedEntityType === 'meal_plan'
      && !!relatedEntityId
      && /^\d{4}-\d{2}-\d{2}:[a-z][a-z0-9_-]{0,39}$/i.test(relatedEntityId)
      && actionIds.has('add_meal'));
}

/**
 * Deterministically normalize only serving actions that already have a scoped
 * executor and read-back verifier. This adapter cannot authorize a mutation:
 * execution still passes lifecycle, permission, source-state, conflict, and
 * domain ownership checks. Unknown producer/action combinations remain
 * unnormalized and therefore cannot accidentally become executable.
 */
function deriveNormalizedActionForKnownProducer(
  input: NotificationIntentInput,
  context: DecisionLogicContext,
): NormalizedDecisionAction | null {
  const tenantId = input.tenantId ?? input.userId;
  const relatedEntityType = typeof input.relatedEntityType === 'string' ? input.relatedEntityType : null;
  const relatedEntityId = input.relatedEntityId == null ? null : String(input.relatedEntityId);
  const actionIds = new Set((input.actionButtons ?? []).map((action) => action.id));

  if (input.sourceSkill === 'finance'
      && relatedEntityType === 'finance_tax_event'
      && relatedEntityId && /^\d{4}-(0[1-9]|1[0-2])$/.test(relatedEntityId)
      && actionIds.has('mark_paid')) {
    const sourceVersion = financeTaxEventStateRevision({ userId: input.userId, tenantId }, relatedEntityId);
    if (!sourceVersion) return null;
    return buildNormalizedDecisionAction({
      intent: 'finance.mark_tax_paid',
      targetEntities: [{ type: 'finance_tax_event', id: relatedEntityId, version: sourceVersion }],
      affectedResources: [{ type: 'finance_tax_event', id: relatedEntityId }],
      preconditions: [{
        type: 'finance_tax_state',
        ref: relatedEntityId,
        expectedVersion: sourceVersion,
        required: true,
      }],
      expectedEffects: [{ type: 'mark_tax_paid', targetRef: `finance_tax_event:${relatedEntityId}` }],
      prohibitedEffects: [{ type: 'modify_different_tax_event', targetRef: `finance_tax_event:${relatedEntityId}` }],
      dependencies: [],
      exclusivityKeys: [`finance_tax_event:${tenantId}:${relatedEntityId}`],
      authorizationScope: ['decision_center:write'],
      risk: 'high',
      reversibility: 'irreversible',
      contextVersion: producerContextVersion('finance', relatedEntityType, relatedEntityId, sourceVersion, context),
    });
  }

  const contentAction = actionIds.has('approve_script')
    ? 'approve_script'
    : actionIds.has('request_rewrite') ? 'request_rewrite' : null;
  if (input.sourceSkill === 'content'
      && relatedEntityType === 'content_workflow_object'
      && relatedEntityId && /^\d+$/.test(relatedEntityId)
      && contentAction) {
    const sourceVersion = contentWorkflowStateRevision({ userId: input.userId, tenantId }, relatedEntityId);
    if (!sourceVersion) return null;
    const targetApproval = contentAction === 'approve_script' ? 'approved' : 'rewrite_requested';
    return buildNormalizedDecisionAction({
      intent: `content.${contentAction}`,
      targetEntities: [{ type: 'content_workflow_object', id: relatedEntityId, version: sourceVersion }],
      affectedResources: [{ type: 'content_workflow_object', id: relatedEntityId }],
      preconditions: [{
        type: 'content_workflow_state',
        ref: relatedEntityId,
        expectedVersion: sourceVersion,
        required: true,
      }],
      expectedEffects: [{
        type: 'set_content_approval_state',
        targetRef: `content_workflow_object:${relatedEntityId}`,
        value: targetApproval,
      }],
      prohibitedEffects: [{
        type: 'set_content_approval_state',
        targetRef: `content_workflow_object:${relatedEntityId}`,
        value: targetApproval === 'approved' ? 'rewrite_requested' : 'approved',
      }],
      dependencies: [],
      exclusivityKeys: [`content_workflow_object:${tenantId}:${relatedEntityId}`],
      authorizationScope: ['decision_center:write'],
      risk: 'medium',
      reversibility: 'compensatable',
      contextVersion: producerContextVersion('content', relatedEntityType, relatedEntityId, sourceVersion, context),
    });
  }

  if (input.sourceSkill === 'cooking'
      && relatedEntityType === 'meal_plan'
      && relatedEntityId && /^\d{4}-\d{2}-\d{2}:[a-z][a-z0-9_-]{0,39}$/i.test(relatedEntityId)
      && actionIds.has('add_meal')) {
    const sourceVersion = cookingMealSlotStateRevision({ userId: input.userId, tenantId }, relatedEntityId);
    if (!sourceVersion) return null;
    return buildNormalizedDecisionAction({
      intent: 'cooking.add_meal',
      targetEntities: [{ type: 'meal_plan', id: relatedEntityId, version: sourceVersion }],
      affectedResources: [{ type: 'meal_plan', id: relatedEntityId }],
      preconditions: [{
        type: 'meal_plan_slot_state',
        ref: relatedEntityId,
        expectedVersion: sourceVersion,
        required: true,
      }],
      expectedEffects: [{ type: 'upsert_meal_plan_slot', targetRef: `meal_plan:${relatedEntityId}` }],
      prohibitedEffects: [{ type: 'modify_different_meal_slot', targetRef: `meal_plan:${relatedEntityId}` }],
      dependencies: [],
      exclusivityKeys: [`meal_plan:${tenantId}:${relatedEntityId}`],
      authorizationScope: ['decision_center:write'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: producerContextVersion('cooking', relatedEntityType, relatedEntityId, sourceVersion, context),
    });
  }

  return null;
}

function producerContextVersion(
  sourceSkill: string,
  relatedEntityType: string,
  relatedEntityId: string,
  sourceVersion: string,
  context: DecisionLogicContext,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    sourceSkill,
    relatedEntityType,
    relatedEntityId,
    sourceVersion,
    sourceState: context.sourceState ?? null,
    providerSyncState: context.providerSyncState ?? null,
    providerSyncUpdatedAt: context.providerSyncUpdatedAt ?? null,
  })).digest('hex').slice(0, 32);
  return `ctx_${sourceSkill}_${digest}`;
}

function shouldSuppressRepeatedRejectedCandidate(input: NotificationIntentInput): boolean {
  const tenantId = input.tenantId ?? input.userId;
  if (!isDecisionFeedbackSuppressionEnabled(process.env, { userId: input.userId, tenantId })) return false;
  if (input.priority === 'critical' || input.priority === 'time_sensitive') return false;
  const action = normalizeDecisionAction(decisionContextForIntentInput(input).normalizedAction);
  if (!action || action.risk === 'high' || action.risk === 'critical') return false;
  const rawDays = Number(process.env.DECISION_CANDIDATE_REJECTION_COOLDOWN_DAYS ?? 0);
  if (!Number.isSafeInteger(rawDays) || rawDays < 1 || rawDays > 90) return false;
  const cooldownDays = rawDays;
  try {
    const currentMaterialKey = rejectionMaterialKey(input, action);
    const priors = getDb().prepare(`
      SELECT items.item_id AS itemId, items.priority,
             intents.normalized_action_json AS normalizedActionJson,
             intents.decision_context_json AS decisionContextJson
        FROM notification_intents intents
        JOIN notification_center_items items
          ON items.intent_id = intents.intent_id
         AND items.user_id = intents.user_id
         AND items.tenant_id = intents.tenant_id
         WHERE intents.user_id = ? AND intents.tenant_id = ?
         AND intents.candidate_fingerprint = ?
         AND (items.decision_state = 'rejected' OR items.status = 'dismissed')
         AND datetime(items.updated_at) >= datetime(?, ?)
       ORDER BY items.updated_at DESC
       LIMIT 25
    `).all(
      input.userId,
      tenantId,
      action.candidateFingerprint,
      appNowIso(),
      `-${cooldownDays} days`,
    ) as Array<{
      itemId: string;
      priority: NotificationPriority;
      normalizedActionJson: string | null;
      decisionContextJson: string | null;
    }>;
    const repeated = priors.some((prior) => {
      const priorAction = normalizeDecisionAction(safeParseJson(prior.normalizedActionJson, null));
      if (!priorAction) return false;
      const priorContext = safeParseJson<DecisionLogicContext>(prior.decisionContextJson, {});
      return rejectionMaterialKey({
        ...input,
        priority: prior.priority,
        decisionContext: priorContext,
      }, priorAction) === currentMaterialKey;
    });
    if (!repeated) return false;
    logger.info({
      userId: input.userId,
      tenantId,
      sourceSkill: input.sourceSkill,
      type: input.type,
      cooldownDays,
    }, 'Suppressed repeated rejected Decision Center candidate');
    return true;
  } catch (err) {
    logger.warn({ err, userId: input.userId, tenantId }, 'Candidate rejection cooldown check failed open');
    return false;
  }
}

function rejectionMaterialKey(input: NotificationIntentInput, action: NormalizedDecisionAction): string {
  const conflict = decisionContextForIntentInput(input).conflictEvaluation;
  const material = {
    candidateFingerprint: action.candidateFingerprint,
    targetEntities: action.targetEntities,
    requestedWindow: action.requestedWindow ?? null,
    preconditions: action.preconditions,
    expectedEffects: action.expectedEffects,
    prohibitedEffects: action.prohibitedEffects,
    authorizationScope: action.authorizationScope,
    risk: action.risk,
    reversibility: action.reversibility,
    priority: input.priority,
    conflict: conflict ? conflictMaterialShape(conflict) : null,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function persistDecisionFlowMetadata(itemId: string, intentId: string, input: NotificationIntentInput): void {
  const tenantId = input.tenantId ?? input.userId;
  const context = decisionContextForIntentInput(input);
  const normalizedAction = normalizeDecisionAction(context.normalizedAction);
  const conflict = context.conflictEvaluation;
  if (!normalizedAction && !conflict) return;
  ensureDecisionCenterTables();
  getDb().transaction(() => {
      const intentUpdate = getDb().prepare(`
        UPDATE notification_intents
           SET context_version = ?,
               context_observed_at = ?,
               candidate_fingerprint = ?,
               normalized_action_json = ?
         WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
      `).run(
        normalizedAction?.contextVersion ?? conflict?.contextVersion ?? null,
        context.contextObservedAt ?? conflict?.evaluatedAt ?? appNowIso(),
        normalizedAction?.candidateFingerprint ?? null,
        normalizedAction ? JSON.stringify(normalizedAction) : null,
        intentId,
        input.userId,
        tenantId,
      );
      assertDecisionScopedUpdateApplied(intentUpdate, 'persist_decision_flow_intent_metadata', {
        itemId,
        intentId,
        userId: input.userId,
        tenantId,
      });
      const itemUpdate = getDb().prepare(`
        UPDATE notification_center_items
           SET decision_state = COALESCE(decision_state, ?),
               updated_at = COALESCE(updated_at, created_at)
         WHERE item_id = ? AND user_id = ? AND tenant_id = ?
      `).run(decisionStateForConflictEvaluation(conflict), itemId, input.userId, tenantId);
      assertDecisionScopedUpdateApplied(itemUpdate, 'persist_decision_flow_item_metadata', {
        itemId,
        intentId,
        userId: input.userId,
        tenantId,
      });
      if (conflict && normalizedAction && conflict.contextVersion === normalizedAction.contextVersion) {
        const relatedDecisionIds = [...new Set(conflict.findings
          .map((finding) => finding.conflictingDecisionId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
        const conflictInsert = getDb().prepare(`
          INSERT INTO decision_conflict_evaluations (
            conflict_evaluation_id, decision_id, user_id, tenant_id, policy_version,
            context_version, disposition, hard_conflict_count, soft_conflict_count,
            reason_codes_json, related_decision_ids_json, precedence_trace_json,
            winner_decision_id, automatically_resolved
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `dce_${randomUUID()}`,
          itemId,
          input.userId,
          tenantId,
          conflict.policyVersion,
          conflict.contextVersion,
          conflict.disposition,
          conflict.findings.filter((finding) => finding.severity === 'hard').length,
          conflict.findings.filter((finding) => finding.severity === 'soft').length,
          JSON.stringify([...new Set(conflict.reasonCodes)].sort()),
          JSON.stringify(relatedDecisionIds),
          JSON.stringify(conflict.precedenceTrace ?? []),
          conflict.winnerDecisionId ?? null,
          conflict.autoResolved ? 1 : 0,
        );
        assertDecisionScopedUpdateApplied(conflictInsert, 'persist_decision_conflict_evaluation', {
          itemId,
          intentId,
          userId: input.userId,
          tenantId,
        });
      }
  })();
}

function failClosedDecisionFlowMetadata(itemId: string, intentId: string, input: NotificationIntentInput): void {
  const tenantId = input.tenantId ?? input.userId;
  ensureDecisionCenterTables();
  getDb().transaction(() => {
    const intentUpdate = getDb().prepare(`
      UPDATE notification_intents
         SET status = 'failed', requires_user_action = 0,
             action_buttons_json = '[]', delivery_policy = 'in_app_only'
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
    `).run(intentId, input.userId, tenantId);
    assertDecisionScopedUpdateApplied(intentUpdate, 'fail_closed_decision_flow_intent', {
      itemId,
      intentId,
      userId: input.userId,
      tenantId,
    });
    const itemUpdate = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'failed', decision_state = 'blocked', requires_user_action = 0,
             actions_json = '[]', action_result_json = ?,
             record_version = record_version + 1, updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(
      JSON.stringify({ errorCode: 'DECISION_FLOW_METADATA_PERSISTENCE_FAILED', retryRequiresNewProposal: true }),
      itemId,
      input.userId,
      tenantId,
    );
    assertDecisionScopedUpdateApplied(itemUpdate, 'fail_closed_decision_flow_item', {
      itemId,
      intentId,
      userId: input.userId,
      tenantId,
    });
  })();
  emitDecisionLifecycleEvent({
    decisionId: itemId,
    userId: input.userId,
    tenantId,
    event: 'blocked',
    toStatus: 'blocked',
    reason: 'decision_flow_metadata_persistence_failed',
  });
}

function decisionStateForConflictEvaluation(conflict?: ConflictEvaluation | null): DurableDecisionState {
  if (!conflict) return 'ready_for_review';
  if (conflict.disposition === 'block' || conflict.disposition === 'stale') return 'blocked';
  if (conflict.disposition === 'suppress_duplicate') return 'superseded';
  if (conflict.disposition === 'needs_confirmation') return 'ready_for_review';
  if (conflict.disposition === 'supersede') return 'ready_for_review';
  return 'ready_for_review';
}

export function buildSkillDecisionFixtureIntent(
  sourceSkill: NotificationSourceSkill,
  userId: number,
  overrides: Partial<NotificationIntentInput> = {},
): NotificationIntentInput {
  const base = buildSkillNotificationFixtureIntent(sourceSkill, userId, overrides);
  if (sourceSkill === 'training') {
    return {
      ...base,
      type: 'decision_required',
      title: 'Training plan needs race date',
      body: 'Add a race date or switch to continuous training before the next plan update.',
      actionButtons: [
        { id: 'open_detail', label: 'Review', style: 'primary' },
      ],
      requiresUserAction: true,
      decisionDeadline: overrides.decisionDeadline ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
      decisionContext: {
        ...(base.decisionContext ?? {}),
        entityTitle: 'Race date',
        sourceState: 'missing_required_input',
        deadlineAt: overrides.decisionDeadline ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
      },
      dedupeKey: overrides.dedupeKey ?? `training:missing-race-date:${userId}:demo`,
      ...overrides,
    };
  }
  return {
    ...base,
    requiresUserAction: overrides.requiresUserAction ?? true,
    ...overrides,
  };
}

export function listDecisionItems(
  userId: number,
  tenantId = userId,
  opts: {
    status?: string;
    sourceSkill?: NotificationSourceSkill;
    type?: NotificationIntentType;
    urgency?: DecisionUrgency;
    limit?: number;
    maxLimit?: number;
    recordExposure?: boolean;
    materializePriorityScore?: boolean;
  } = {},
): DecisionApiItem[] {
  assertScope(userId, tenantId, 'list_decision_items', opts);
  ensureDecisionCenterTables();
  const clauses = ['items.user_id = ?', 'items.tenant_id = ?'];
  const params: unknown[] = [userId, tenantId];
  if (opts.status && opts.status !== 'all') {
    clauses.push('items.status = ?');
    params.push(opts.status);
  } else if (opts.status === 'all') {
    clauses.push("items.status NOT IN ('expired')");
  } else {
    clauses.push("items.status IN ('unread', 'read', 'failed', 'snoozed')");
  }
  if (opts.sourceSkill) {
    clauses.push('items.source_skill = ?');
    params.push(opts.sourceSkill);
  }
  if (opts.type) {
    clauses.push('items.type = ?');
    params.push(opts.type);
  }
  if (opts.status !== 'expired') {
    // A1: keep hard-expired and future-snoozed rows out of the SQL window, not just the in-memory
    // projection, so a backlog of stale rows cannot consume LIMIT and starve valid active decisions.
    clauses.push('(items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))');
    params.push(appNowIso());
    clauses.push('(items.snoozed_until IS NULL OR datetime(items.snoozed_until) <= datetime(?))');
    params.push(appNowIso());
  }
  const maxLimit = Math.min(Math.max(opts.maxLimit ?? 200, 1), 500);
  const requestedLimit = Math.min(Math.max(opts.limit ?? 80, 1), maxLimit);
  const shouldMaterializePriorityScore = opts.materializePriorityScore === true;
  params.push(maxLimit);

  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       COALESCE(items.priority_score, CASE items.priority WHEN 'critical' THEN 100 WHEN 'time_sensitive' THEN 90 WHEN 'active' THEN 70 ELSE 35 END) DESC,
       COALESCE(intents.decision_deadline, items.expires_at, items.created_at) ASC,
       items.created_at DESC
     LIMIT ?
  `).all(...params) as any[];

  const records = rows
    .map(mapDecisionRecord)
    .filter((item) => isDecisionRecord(item))
    .map((item) => supersedeIfSourceStateStale(item) ? null : item)
    .filter((item): item is DecisionRecord => item !== null)
    .filter((item) => isUserFacingDecision(item, decisionLogicForRecord(item)).visible)
    .filter((item) => !isSnoozedUntilFuture(item))
    .filter((item) => opts.status === 'expired' || !isDecisionExpired(item))
    .filter((item) => !opts.urgency || urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt) === opts.urgency);
  return records
    .map((record) => ({
      record,
      item: formatDecisionItemForApi(record, { materializePriorityScore: false }),
    }))
    .sort((a, b) => compareDecisionApiItemsByRank(a.item, b.item))
    .slice(0, requestedLimit)
    .map(({ record, item }) => {
      if (shouldMaterializePriorityScore) materializeDecisionPriorityScore(record, item.priorityScore);
      if (opts.recordExposure === true) recordDecisionExposure(record, item);
      return item;
    });
}

function isUserFacingDecision(record: DecisionRecord, logic: DecisionLogicV2): DecisionUserFacingFilterVerdict {
  const verdict = evaluateUserFacingDecision(record, logic);
  if (!verdict.visible) {
    decisionGuidanceStats.filteredFromUserView += 1;
    decisionGuidanceStats.filteredByReason[verdict.reason] = (decisionGuidanceStats.filteredByReason[verdict.reason] ?? 0) + 1;
  }
  return verdict;
}

function evaluateUserFacingDecision(record: DecisionRecord, logic: DecisionLogicV2): DecisionUserFacingFilterVerdict {
  const context = decisionContextForRecord(record);
  const visibilityScope = visibilityScopeForItem(record);
  if (visibilityScope === 'system_admin' || visibilityScope === 'tenant_admin') {
    return { visible: false, reason: 'admin_visibility_scope' };
  }
  if (context.internalOnly === true) return { visible: false, reason: 'internal_only' };
  if (context.smoke === true) return { visible: false, reason: 'smoke_decision' };
  if (record.dedupeKey?.startsWith('smoke:')) return { visible: false, reason: 'smoke_decision' };
  if (record.relatedEntityType === 'decision_center_smoke') return { visible: false, reason: 'smoke_decision' };
  if (!logic.quality.safeToShowUser) return { visible: false, reason: 'unsafe_quality' };
  if (!guidanceEnabledForRecord(record)) return { visible: true, reason: 'guidance_disabled' };

  const actionQueue = ['unread', 'read', 'failed', 'open'].includes(record.status);
  if (actionQueue
      && sourceFreshnessForRecord(record, context) === 'stale'
      && record.contextObservedAt == null) {
    return { visible: false, reason: 'stale_action_source' };
  }
  if (actionQueue && record.requiresUserAction && !logic.quality.safeForFrontendAction) {
    return { visible: false, reason: 'unsafe_frontend_action' };
  }
  if (actionQueue && !hasMinimumVisibleGuidance(record, logic)) {
    return { visible: false, reason: 'incomplete_guidance' };
  }
  return { visible: true, reason: 'visible' };
}

function hasMinimumVisibleGuidance(record: DecisionRecord, logic: DecisionLogicV2): boolean {
  const headline = firstConcreteOrNull([logic.safePreviewTitle, logic.title]);
  const whatHappened = firstConcreteOrNull([logic.problemStatement, logic.safePreviewBody, record.safeBody]);
  const userAction = firstConcreteOrNull([openDecisionUserAction(record, logic)]);
  const labels = guidanceActionLabelsForRecord(record, logic);
  if (!headline || !whatHappened || !userAction) return false;
  if (record.requiresUserAction && record.type !== 'sync_failure' && !labels?.primary) return false;
  return true;
}

export function getDecisionItem(
  decisionId: string,
  userId: number,
  tenantId = userId,
  opts: { recordExposure?: boolean } = {},
): DecisionApiItem | null {
  let record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) return null;
  record = refreshSourceStateForRead(record);
  const logic = decisionLogicForRecord(record);
  if (!isUserFacingDecision(record, logic).visible) return null;
  if (isDecisionExpired(record)) return null;
  return formatDecisionItemForApiWithExposure(record, opts);
}

/** Explicit token-zero revalidation against current local authoritative state. */
export function refreshDecisionItem(decisionId: string, userId: number, tenantId = userId): { item: DecisionApiItem; refreshedAt: string } | null {
  assertScope(userId, tenantId, 'refresh_decision_item', { decisionId });
  ensureDecisionCenterTables();
  reclaimExpiredExecutionLeases(userId, tenantId);
  let record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record) || isDecisionExpired(record)) return null;
  guardDecisionLifecycleMutation(record, 'refresh', { allowPartialRecovery: true });
  const executionReconciliation = reconcilePartialDecisionExecution(record);
  if (executionReconciliation !== 'none') {
    record = getDecisionRecord(decisionId, userId, tenantId);
    if (!record) return null;
    if (executionReconciliation === 'applied' || executionReconciliation === 'unknown') {
      return { item: formatDecisionItemForApi(record), refreshedAt: DateTime.utc().toISO()! };
    }
  }
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  if (!decisionRefreshSupportedForRecord(record) || !action) {
    throw new DecisionActionError(
      'DECISION_REFRESH_NOT_SUPPORTED',
      'This decision does not have a registered source-state refresh contract.',
      409,
    );
  }
  const materialContextExpiry = decisionContextExpiresAt(record);
  if (materialContextExpiry && Date.parse(materialContextExpiry) <= Date.now()) {
    const expired = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'expired', decision_state = 'expired',
             record_version = record_version + 1, updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(decisionId, userId, tenantId, record.recordVersion);
    if (expired.changes !== 1) {
      throw new DecisionActionError(
        'DECISION_VERSION_CONFLICT',
        'Decision changed while its expired context was being retired.',
        409,
        decisionVersionConflictDetails(getDecisionRecord(decisionId, userId, tenantId)),
      );
    }
    expireTrainingPlanRevisionForDecision(getDb(), decisionId, userId, tenantId);
    emitDecisionLifecycleEvent({
      decisionId,
      userId,
      tenantId,
      event: 'expired',
      toStatus: 'expired',
      reason: 'material_context_expired_refresh_requires_new_proposal',
    });
    record = getDecisionRecord(decisionId, userId, tenantId);
    if (!record) return null;
    return { item: formatDecisionItemForApi(record), refreshedAt: DateTime.utc().toISO()! };
  }
  const mode = getDecisionConflictPolicyV1Mode(process.env, { userId, tenantId });
  if (action) {
    const priorContext = decisionContextForRecord(record);
    const priorConflict = priorContext.conflictEvaluation;
    const initialRevalidation = revalidateNormalizedDecisionAction({
      scope: { userId, tenantId },
      action,
      additionalExisting: priorContext.conflictComparisons ?? undefined,
      decisionId,
      decisionApproved: durableDecisionStateForRecord(record) === 'approved',
      replacementApproved: hasApprovedReplacementForContext(record, action.contextVersion),
      // Approval only covers the conflict set the user actually reviewed.
      // A refresh must surface newly discovered soft conflicts instead of
      // treating the prior approval as blanket confirmation.
      confirmationApproved: false,
      confidence: priorContext.candidateConfidence ?? undefined,
      contextExpiresAt: decisionContextExpiresAt(record),
      candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
    });
    const observedPreconditionVersions = observePreconditionVersions(initialRevalidation.preconditions);
    const sourceVersionMismatch = action.preconditions.some((precondition) => {
      const currentVersion = observedPreconditionVersions.get(precondition.ref);
      return !!currentVersion && currentVersion !== precondition.expectedVersion;
    });
    const initialConflictChanged = conflictMaterialKey(priorConflict) !== conflictMaterialKey(initialRevalidation.conflictEvaluation);
    let refreshedAction = action;
    if (sourceVersionMismatch || initialConflictChanged) {
      refreshedAction = rebuildNormalizedActionForContext(
        refreshedAction,
        nextDecisionContextVersion(refreshedAction, initialRevalidation.conflictEvaluation, observedPreconditionVersions),
      );
    }
    let finalRevalidation = refreshedAction.contextVersion === action.contextVersion
      ? initialRevalidation
      : revalidateNormalizedDecisionAction({
        scope: { userId, tenantId },
        action: refreshedAction,
        additionalExisting: priorContext.conflictComparisons ?? undefined,
        decisionId,
        decisionApproved: durableDecisionStateForRecord(record) === 'approved',
        replacementApproved: hasApprovedReplacementForContext(record, refreshedAction.contextVersion),
        confirmationApproved: false,
        confidence: priorContext.candidateConfidence ?? undefined,
        contextExpiresAt: decisionContextExpiresAt(record),
        candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
      });
    let conflict = finalRevalidation.conflictEvaluation;
    let materialChanged = refreshedAction.contextVersion !== action.contextVersion
      || conflictMaterialKey(priorConflict) !== conflictMaterialKey(conflict);
    if (materialChanged) {
      const stableContextVersion = nextDecisionContextVersion(refreshedAction, conflict, observedPreconditionVersions);
      if (refreshedAction.contextVersion !== stableContextVersion) {
        refreshedAction = rebuildNormalizedActionForContext(refreshedAction, stableContextVersion);
        finalRevalidation = revalidateNormalizedDecisionAction({
          scope: { userId, tenantId },
          action: refreshedAction,
          additionalExisting: priorContext.conflictComparisons ?? undefined,
          decisionId,
          decisionApproved: durableDecisionStateForRecord(record) === 'approved',
          replacementApproved: hasApprovedReplacementForContext(record, refreshedAction.contextVersion),
          confirmationApproved: false,
          confidence: priorContext.candidateConfidence ?? undefined,
          contextExpiresAt: decisionContextExpiresAt(record),
          candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
        });
        conflict = finalRevalidation.conflictEvaluation;
        materialChanged = refreshedAction.contextVersion !== action.contextVersion
          || conflictMaterialKey(priorConflict) !== conflictMaterialKey(conflict);
      }
    }
    if (decisionRefreshSupportedForRecord(record)) {
      const context: DecisionLogicContext = {
        ...priorContext,
        normalizedAction: refreshedAction,
        conflictEvaluation: conflict,
      };
      const priorState = durableDecisionStateForRecord(record);
      const nextState = !materialChanged && priorState === 'approved'
        ? 'approved'
        : decisionStateForConflictEvaluation(conflict);
      getDb().transaction(() => {
        const intentUpdate = getDb().prepare(`
          UPDATE notification_intents
             SET decision_context_json = ?, context_version = ?, context_observed_at = ?,
                 candidate_fingerprint = ?, normalized_action_json = ?
           WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
        `).run(
          JSON.stringify(context),
          refreshedAction.contextVersion,
          appNowIso(),
          refreshedAction.candidateFingerprint,
          JSON.stringify(refreshedAction),
          record!.intentId,
          userId,
          tenantId,
        );
        if (intentUpdate.changes !== 1) {
          throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision context could not be refreshed.', 409);
        }
        const itemUpdate = materialChanged
          ? getDb().prepare(`
              UPDATE notification_center_items
                 SET decision_state = ?,
                     status = CASE WHEN ? = 'superseded' THEN 'superseded' ELSE status END,
                     record_version = record_version + 1, updated_at = datetime('now')
               WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
                 AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
            `).run(nextState, nextState, decisionId, userId, tenantId, record!.recordVersion)
          : getDb().prepare(`
              UPDATE notification_center_items
                 SET decision_state = ?,
                     status = CASE WHEN ? = 'superseded' THEN 'superseded' ELSE status END
               WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
                 AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
            `).run(nextState, nextState, decisionId, userId, tenantId, record!.recordVersion);
        if (itemUpdate.changes !== 1) {
          const current = getDecisionRecord(decisionId, userId, tenantId);
          throw new DecisionActionError(
            'DECISION_VERSION_CONFLICT',
            'Decision changed while it was being refreshed.',
            409,
            decisionVersionConflictDetails(current),
          );
        }
      })();
      resolveDecisionConflictAudit(decisionId, userId, tenantId, materialChanged ? 'refreshed_context_changed' : 'refreshed_unchanged');
      recordDecisionConflictEvaluation(record, conflict);
      record = getDecisionRecord(decisionId, userId, tenantId);
      if (!record) return null;
    } else {
      logger.info({
        event: 'decision.revalidation_shadowed',
        decisionId,
        userId,
        tenantId,
        materialChanged,
        priorContextVersion: action.contextVersion,
        refreshedContextVersion: refreshedAction.contextVersion,
        disposition: conflict.disposition,
      }, 'Decision refresh conflict revalidation completed in shadow mode');
    }
  }
  return { item: formatDecisionItemForApi(record), refreshedAt: DateTime.utc().toISO()! };
}

function observePreconditionVersions(
  preconditions: Array<{ ref: string; currentVersion?: string }>,
): Map<string, string> {
  return new Map(preconditions
    .filter((precondition): precondition is { ref: string; currentVersion: string } => !!precondition.currentVersion)
    .map((precondition) => [precondition.ref, precondition.currentVersion]));
}

function rebuildNormalizedActionForContext(
  action: NormalizedDecisionAction,
  contextVersion: string,
): NormalizedDecisionAction {
  return buildNormalizedDecisionAction({
    intent: action.intent,
    targetEntities: action.targetEntities,
    affectedResources: action.affectedResources,
    ...(action.requestedWindow ? { requestedWindow: action.requestedWindow } : {}),
    preconditions: action.preconditions,
    expectedEffects: action.expectedEffects,
    prohibitedEffects: action.prohibitedEffects,
    dependencies: action.dependencies,
    exclusivityKeys: action.exclusivityKeys,
    authorizationScope: action.authorizationScope,
    risk: action.risk,
    reversibility: action.reversibility,
    contextVersion,
  });
}

function nextDecisionContextVersion(
  action: NormalizedDecisionAction,
  conflict: ConflictEvaluation,
  observedPreconditionVersions: Map<string, string>,
): string {
  const shape = {
    candidateFingerprint: action.candidateFingerprint,
    targetEntities: action.targetEntities,
    preconditions: action.preconditions,
    affectedResources: action.affectedResources,
    requestedWindow: action.requestedWindow ?? null,
    observedPreconditionVersions: [...observedPreconditionVersions.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right)),
    conflict: conflictMaterialShape(conflict),
  };
  return `ctx_${createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32)}`;
}

function conflictMaterialKey(conflict: ConflictEvaluation | null | undefined): string {
  return JSON.stringify(conflict ? conflictMaterialShape(conflict) : null);
}

function conflictMaterialShape(conflict: ConflictEvaluation): Record<string, unknown> {
  return {
    policyVersion: conflict.policyVersion,
    disposition: conflict.disposition,
    findings: conflict.findings.map((finding) => ({
      class: finding.class,
      severity: finding.severity,
      reasonCode: finding.reasonCode,
      conflictingDecisionId: finding.conflictingDecisionId ?? null,
      resourceKey: finding.resourceKey ?? null,
    })).sort((left, right) => compareCodeUnits(JSON.stringify(left), JSON.stringify(right))),
    winnerDecisionId: conflict.winnerDecisionId ?? null,
    autoResolved: conflict.autoResolved,
  };
}

export function findDecisionByRelatedEntity(
  userId: number,
  tenantId: number,
  relatedEntityType: string,
  relatedEntityId: string,
): DecisionApiItem | null {
  assertScope(userId, tenantId, 'find_decision_by_related_entity', { relatedEntityType, relatedEntityId });
  ensureDecisionCenterTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND intents.related_entity_type = ?
       AND intents.related_entity_id = ?
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
     ORDER BY items.created_at DESC
     LIMIT 1
  `).get(userId, tenantId, relatedEntityType, relatedEntityId) as any;
  if (!row) return null;
  const record = mapDecisionRecord(row);
  if (!isDecisionRecord(record)) return null;
  if (isDecisionExpired(record)) return null;
  const logic = decisionLogicForRecord(record);
  return isUserFacingDecision(record, logic).visible ? formatDecisionItemForApi(record) : null;
}

export function getDecisionSummary(userId: number, tenantId = userId, limit = 3): DecisionSummary {
  const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 80, recordExposure: false });
  const handled = listHandledByNexusItems(userId, tenantId, 25);
  const summary = buildDecisionSummaryFromSections(userId, tenantId, items, handled, limit);
  return summary;
}

function buildDecisionSummaryFromSections(
  userId: number,
  tenantId: number,
  items: DecisionApiItem[],
  handled: HandledByNexusItem[],
  limit = 3,
): DecisionSummary {
  const activeItems = items.filter((item) => ['unread', 'read', 'snoozed', 'failed', 'open'].includes(item.status));
  const openItems = activeItems.filter((item) => item.status !== 'snoozed' || !item.snoozedUntil);
  // C3: COUNTS (openCount/urgentCount/todayCount/badgeCount/gamification) are INTEGRITY reads computed on the
  // raw open set so they stay accurate and consistent with the overview. The RENDERED fields (top pick +
  // preview list + their derived titles/CTA) are USER-FACING, so they respect type-suppression — a muted
  // type must never peek through previewItems/topSuggestion on ANY summary consumer (overview, /summary,
  // portal, secretary fastpath, chat). Flag OFF => presentationItems === openItems (byte-identical). Floored
  // decisions are never suppressed.
  const presentationItems = applyDecisionTypeSuppression(openItems, userId, tenantId);
  const urgentCount = openItems.filter((item) => item.urgency === 'urgent').length;
  const todayCount = openItems.filter((item) => item.urgency === 'urgent' || item.urgency === 'today').length;
  const top = presentationItems[0] ?? null;
  const locale = userDecisionContextDefaults(userId).locale;
  const timezone = userDecisionContextDefaults(userId).timezone ?? 'UTC';
  const handledTodayCount = handled
    .filter((item) => isTimestampInLocalDay(item.createdAt, timezone, DateTime.utc()))
    .length;
  const gamification = isDecisionStreakV1Enabled(process.env, { userId, tenantId })
    ? readDecisionGamification(userId, tenantId, openItems.length)
    : null;
  return {
    openCount: openItems.length,
    urgentCount,
    todayCount,
    handledTodayCount,
    topDecisionTitle: top?.safePreviewTitle ?? null,
    topDecisionSourceSkill: top?.sourceSkill ?? null,
    topDecisionUrgency: top?.urgency ?? null,
    topDecisionWhy: top?.whySummary ?? top?.analysis?.whyNow ?? null,
    topSuggestion: top ? topSuggestionForItem(top) : null,
    ctaLabel: ctaLabelForSummary(openItems.length, urgentCount, top, locale),
    previewItems: presentationItems.slice(0, Math.min(Math.max(limit, 0), 3)),
    badgeCount: todayCount,
    gamification,
  };
}

function emptyDecisionSummary(userId: number): DecisionSummary {
  const locale = userDecisionContextDefaults(userId).locale;
  return {
    openCount: 0,
    urgentCount: 0,
    todayCount: 0,
    handledTodayCount: 0,
    topDecisionTitle: null,
    topDecisionSourceSkill: null,
    topDecisionUrgency: null,
    topDecisionWhy: null,
    topSuggestion: null,
    ctaLabel: ctaLabelForSummary(0, 0, null, locale),
    previewItems: [],
    badgeCount: 0,
    gamification: null,
  };
}

function shouldRethrowDecisionOverviewError(err: unknown): boolean {
  return err instanceof DecisionActionError;
}

function logDecisionOverviewSectionFailure(section: 'items' | 'handled' | 'summary', err: unknown, userId: number, tenantId: number): void {
  logger.warn({ err, userId, tenantId, section }, 'Decision Center overview section failed');
}

function openDecisionItemsForOverview(items: DecisionApiItem[]): DecisionApiItem[] {
  return items.filter((item) => ['unread', 'read', 'snoozed', 'failed', 'open'].includes(item.status));
}

export function getDecisionOverview(
  userId: number,
  tenantId = userId,
  opts: { limit?: number; handledLimit?: number; sourceSkill?: NotificationSourceSkill } = {},
): DecisionCenterOverview {
  const limit = Math.min(Math.max(opts.limit ?? 80, 0), 100);
  const handledLimit = Math.min(Math.max(opts.handledLimit ?? 10, 0), 25);
  const itemReadLimit = Math.max(limit, 80);
  const handledReadLimit = Math.max(handledLimit, 25);
  let allItems: DecisionApiItem[] = [];
  let handledForSummary: HandledByNexusItem[] = [];
  let itemsAvailable = true;
  let handledAvailable = true;
  let summaryAvailable = true;

  try {
    allItems = listDecisionItems(userId, tenantId, { status: 'all', limit: itemReadLimit, recordExposure: false });
  } catch (err) {
    if (shouldRethrowDecisionOverviewError(err)) throw err;
    itemsAvailable = false;
    summaryAvailable = false;
    logDecisionOverviewSectionFailure('items', err, userId, tenantId);
  }

  // BE-1 (Content Studio): when a sourceSkill filter is requested, the rendered
  // `items` come from a dedicated skill-scoped read so skill items buried past
  // the global read limit are never silently dropped. The global `allItems`
  // read above still feeds counters/summary/secretaryToday unchanged.
  let skillOpenItems: DecisionApiItem[] | null = null;
  if (opts.sourceSkill != null && itemsAvailable) {
    try {
      const skillItems = listDecisionItems(userId, tenantId, {
        status: 'all',
        sourceSkill: opts.sourceSkill,
        limit: itemReadLimit,
        recordExposure: false,
      });
      skillOpenItems = applyDecisionTypeSuppression(openDecisionItemsForOverview(skillItems), userId, tenantId);
    } catch (err) {
      if (shouldRethrowDecisionOverviewError(err)) throw err;
      itemsAvailable = false;
      logDecisionOverviewSectionFailure('items', err, userId, tenantId);
    }
  }

  try {
    handledForSummary = listHandledByNexusItems(userId, tenantId, handledReadLimit);
  } catch (err) {
    if (shouldRethrowDecisionOverviewError(err)) throw err;
    handledAvailable = false;
    summaryAvailable = false;
    logDecisionOverviewSectionFailure('handled', err, userId, tenantId);
  }

  // C3: type-suppression is a PRESENTATION filter. `openItemsRaw` is the true open partition and feeds the
  // numeric counts (openCount/staleCount) so they stay consistent with `summary.openCount` (an integrity
  // read built from `allItems`). `allOpenItems` is the user-facing, suppression-filtered set that feeds the
  // rendered list, the top suggestion, and the today narrative. Floored decisions are never suppressed.
  // Flag-gated; OFF makes the two sets identical (byte-identical overview).
  const openItemsRaw = openDecisionItemsForOverview(allItems);
  const allOpenItems = applyDecisionTypeSuppression(openItemsRaw, userId, tenantId);
  let items: DecisionApiItem[] = [];
  let fatigueMeta: DecisionCenterOverview['fatigue'];
  // BE-1: the rendered list draws from the skill-scoped set when a filter was
  // requested; otherwise behavior is unchanged.
  const renderSource = skillOpenItems ?? allOpenItems;
  if (itemsAvailable) {
    if (isDecisionCenterFatigueCapsEnabled(process.env, { userId, tenantId })) {
      // C5: flag-gated, post-ranking selection. Floored decisions bypass the cap; non-floored items
      // are bounded per-domain and to the visible budget. The cap reshapes the already-ranked `items`
      // array (then honors the caller's limit); `fatigue` advertises the primary/More split + how many
      // open decisions were capped out, so the client can render the hierarchy without re-deriving it.
      const { primaryItems, moreItems } = applyDecisionFatigueCaps(renderSource);
      items = [...primaryItems, ...moreItems].slice(0, limit);
      const primaryCount = Math.min(primaryItems.length, items.length);
      fatigueMeta = { primaryCount, moreCount: items.length - primaryCount, cappedCount: Math.max(renderSource.length - items.length, 0) };
    } else {
      items = renderSource.slice(0, limit);
    }
  }
  const handled = handledAvailable ? handledForSummary.slice(0, handledLimit) : [];
  let summary = emptyDecisionSummary(userId);
  if (summaryAvailable) {
    try {
      summary = buildDecisionSummaryFromSections(userId, tenantId, allItems, handledForSummary, 3);
    } catch (err) {
      if (shouldRethrowDecisionOverviewError(err)) throw err;
      summaryAvailable = false;
      logDecisionOverviewSectionFailure('summary', err, userId, tenantId);
    }
  }
  const staleCount = openItemsRaw.filter((item) => item.analysis.sourceFreshness === 'stale' || item.sourceTrace?.dataFreshness === 'cached').length;
  const supersededCount = allItems.filter((item) => ['superseded', 'dismissed', 'actioned'].includes(item.status)).length;
  const topSuggestion = summary.topSuggestion ?? (allOpenItems[0] ? topSuggestionForItem(allOpenItems[0]) : null);
  const language = userDecisionContextDefaults(userId).locale ?? 'en';
  const secretaryToday = buildDecisionCenterSecretaryTodaySummary(allOpenItems, handledForSummary, language);
  return {
    count: items.length,
    openCount: openItemsRaw.filter((item) => ['unread', 'read', 'failed', 'open'].includes(item.status)).length,
    handledCount: handled.length,
    staleCount,
    supersededCount,
    generatedAt: DateTime.utc().toISO()!,
    summary,
    topSuggestion,
    partial: {
      items: itemsAvailable,
      handled: handledAvailable,
      summary: summaryAvailable,
    },
    secretaryToday,
    fatigue: fatigueMeta,
    ...(opts.sourceSkill != null
      ? { sourceSkillFilter: opts.sourceSkill, sourceSkillTotalCount: skillOpenItems?.length ?? 0 }
      : {}),
    items,
    handled,
  };
}

export function buildDecisionCenterReportDocument(userId: number, tenantId = userId): Record<string, unknown> {
  const overview = getDecisionOverview(userId, tenantId, { limit: 20, handledLimit: 10 });
  return {
    type: 'decision_briefing',
    generatedAt: overview.generatedAt,
    summary: {
      openCount: overview.openCount,
      urgentCount: overview.summary.urgentCount,
      handledCount: overview.handledCount,
      staleCount: overview.staleCount,
      supersededCount: overview.supersededCount,
      ctaLabel: overview.summary.ctaLabel,
    },
    topSuggestion: overview.topSuggestion,
    openDecisions: overview.items.slice(0, 8).map((item) => ({
      decisionId: item.decisionId,
      title: item.safePreviewTitle || item.title,
      whyNow: item.analysis.whyNow,
      expectedOutcome: item.analysis.expectedOutcome,
      costOfDelay: item.analysis.costOfDelay,
      confidenceLabel: item.analysis.confidenceLabel,
      sourceFreshness: item.analysis.sourceFreshness,
      actionLabel: item.recommendedActionLabel,
      urgency: item.urgency,
      sourceSkill: item.sourceSkill,
    })),
    handledByNexus: overview.handled.slice(0, 8).map((item) => ({
      itemId: item.itemId,
      title: item.title,
      summary: item.summary,
      explanation: item.explanation,
      actionTaken: item.actionTaken,
      whyBrief: item.whyBrief,
      rollbackAvailable: item.rollbackAvailable,
    })),
    secretaryToday: overview.secretaryToday,
    unresolvedRisk: overview.topSuggestion?.riskIfIgnored ?? null,
  };
}

function buildDecisionCenterSecretaryTodaySummary(
  openItems: DecisionApiItem[],
  handledItems: HandledByNexusItem[],
  language: string,
): SecretaryTodaySummaryModel {
  // Decision Center's Secretary Today view is intentionally queue-centric:
  // /plan/today owns the richer daily operational scan, while this endpoint
  // mirrors the live decisions/handled source of truth the user is viewing.
  const copy = secretaryTodayLabels(language);
  const secretaryOpen = openItems.filter((item) => item.sourceSkill === 'secretary');
  const secretaryHandled = handledItems.filter((item) => item.sourceSkill === 'secretary');
  const stale = secretaryOpen.filter((item) => item.analysis.sourceFreshness === 'stale' || item.sourceTrace?.dataFreshness === 'cached');
  const checked = [{
    id: 'decision-center-read',
    label: copy.decisionCenterCheckedLabel,
    detail: copy.decisionCenterCheckedDetail,
    status: 'checked' as const,
    source: 'decision_center' as const,
  }];
  const handled = secretaryHandled.slice(0, 3).map((item, index) => ({
    id: `secretary-handled-${index}`,
    label: copy.handledByNexus,
    detail: item.explanation?.result ?? item.summary,
    status: 'handled' as const,
    source: 'decision_center' as const,
  }));
  const needsUser = secretaryOpen.slice(0, 3).map((item, index) => ({
    id: `secretary-needs-user-${index}`,
    label: copy.needsYou,
    detail: item.explanation?.userAction ?? item.recommendedActionLabel ?? item.summary,
    status: 'needs_user' as const,
    source: 'decision_center' as const,
  }));
  const waitingOnSource = stale.slice(0, 3).map((item, index) => ({
    id: `secretary-waiting-source-${index}`,
    label: copy.waitingOnSource,
    detail: item.analysis.freshnessLabel ?? item.summary,
    status: 'waiting_on_source' as const,
    source: 'source_health' as const,
  }));
  const nextBestMove = secretaryOpen[0]?.explanation?.userAction
    ?? secretaryOpen[0]?.recommendedActionLabel
    ?? null;
  const summary = needsUser.length > 0
    ? copy.summaryNeedsUser(needsUser.length)
    : handled.length > 0
      ? copy.summaryHandled(handled.length)
      : waitingOnSource.length > 0
        ? copy.summaryWaitingOnSource
        : copy.summaryAllClear;
  return {
    title: copy.title,
    summary,
    checked,
    handled,
    needsUser,
    waitingOnSource,
    nextBestMove,
    counts: {
      checked: checked.length,
      handled: handled.length,
      needsUser: needsUser.length,
      waitingOnSource: waitingOnSource.length,
    },
  };
}

export function countOpenUrgentDecisionsForUser(userId: number, tenantId = userId): number {
  return getDecisionSummary(userId, tenantId).badgeCount;
}

function readDecisionGamification(userId: number, tenantId: number, openCount: number): DecisionGamificationSummary {
  ensureDecisionCenterTables();
  const defaults = userDecisionContextDefaults(userId);
  const timezone = defaults.timezone || 'UTC';
  const now = DateTime.now().setZone(timezone);
  const today = now.toISODate()!;

  const since = now.minus({ days: 13 }).toISODate()!;
  const rows = getDb().prepare(`
    SELECT local_date, reached_zero_at
      FROM decision_queue_daily_rollups
     WHERE user_id = ? AND tenant_id = ? AND local_date >= ?
     ORDER BY local_date ASC
  `).all(userId, tenantId, since) as Array<{ local_date: string; reached_zero_at: string | null }>;
  const rowByDate = new Map(rows.map((row) => [row.local_date, row]));
  const last14Days = Array.from({ length: 14 }, (_, idx) => {
    const date = now.minus({ days: 13 - idx }).toISODate()!;
    const row = rowByDate.get(date);
    const cleared = !!row?.reached_zero_at || (date === today && openCount === 0);
    return {
      date,
      cleared,
      reachedZeroAt: row?.reached_zero_at ?? (cleared ? now.toUTC().toISO() : null),
    };
  });
  const allRows = getDb().prepare(`
    SELECT local_date, reached_zero_at
      FROM decision_queue_daily_rollups
     WHERE user_id = ? AND tenant_id = ?
     ORDER BY local_date ASC
  `).all(userId, tenantId) as Array<{ local_date: string; reached_zero_at: string | null }>;
  const clearedByDate = new Map<string, boolean>();
  for (const row of allRows) {
    clearedByDate.set(row.local_date, !!row.reached_zero_at);
  }
  // The live queue is authoritative for today even before the asynchronous
  // daily rollup writer persists its row. A zero open count therefore extends
  // today's streak immediately; historical days still require durable rows.
  if (openCount === 0) clearedByDate.set(today, true);
  // Phase 17 hostile-QA fix (2026-05-18): walk back over the full clearedByDate
  // index, not a fixed 14-day window. The previous code silently capped
  // currentStreakDays at 14 because last14Days has exactly 14 entries —
  // a user with a 30-day clear streak saw 14 forever. Cap at 365 days as
  // a safety bound; a streak longer than a year would re-engage the cap
  // intentionally.
  let currentStreakDays = 0;
  for (let i = 0; i < 365; i += 1) {
    const date = now.minus({ days: i }).toISODate();
    if (date && clearedByDate.get(date) === true) {
      currentStreakDays += 1;
    } else {
      break;
    }
  }
  // Phase 17 hostile-QA fix (2026-05-18): treat missing rollup rows as
  // streak breaks. The previous loop iterated only existing rows, so a
  // user who skipped the app for a week then cleared decisions appeared
  // to have a contiguous streak across the gap. Walk a contiguous date
  // range from the earliest row through today.
  let bestStreakDays = 0;
  if (allRows.length > 0) {
    const startDate = DateTime.fromISO(allRows[0].local_date, { zone: timezone }).startOf('day');
    const endDate = now.startOf('day');
    let cursor = startDate;
    let running = 0;
    while (cursor <= endDate) {
      const dateKey = cursor.toISODate()!;
      if (clearedByDate.get(dateKey) === true) {
        running += 1;
        if (running > bestStreakDays) bestStreakDays = running;
      } else {
        running = 0;
      }
      cursor = cursor.plus({ days: 1 });
    }
  }
  const hoursLeftToday = Math.max(0, Math.round(now.endOf('day').diff(now, 'hours').hours * 10) / 10);
  return {
    currentStreakDays,
    bestStreakDays,
    last14Days,
    decisionsLeft: openCount,
    hoursLeftToday,
    atRisk: openCount > 0 && hoursLeftToday <= 4,
  };
}

export function listHandledByNexusItems(userId: number, tenantId = userId, limit = 25): HandledByNexusItem[] {
  assertScope(userId, tenantId, 'list_handled_by_nexus_items', { limit });
  ensureDecisionCenterTables();
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const wideLimit = Math.min(boundedLimit * 2, 100);
  const explicitRows = getDb().prepare(`
    SELECT *
      FROM handled_by_nexus_items
     WHERE user_id = ?
       AND tenant_id = ?
     ORDER BY created_at DESC
     LIMIT ?
  `).all(userId, tenantId, wideLimit) as any[];
  const explicitDecisionIds = new Set(
    explicitRows
      .map((row) => typeof row.decision_id === 'string' ? row.decision_id : null)
      .filter((value): value is string => !!value),
  );
  const explicitItems = explicitRows
    .map((row) => {
      const item = mapHandledByNexusItem(row);
      const record = getDecisionRecord(item.decisionId, userId, tenantId);
      return record ? withHandledRollbackAction(item, record) : item;
    })
    .filter(isHandledByNexusItemUserFacing);

  const actionedRows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           logs.action_taken AS decision_log_action_taken
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
      LEFT JOIN notification_decision_logs logs ON logs.decision_log_id = items.decision_log_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.status = 'actioned'
     ORDER BY COALESCE(items.actioned_at, items.created_at) DESC
     LIMIT ?
  `).all(userId, tenantId, wideLimit) as any[];
  const actionedItems = actionedRows
    .map(mapDecisionRecord)
    .filter((record) => !explicitDecisionIds.has(record.itemId))
    .filter((record) => isUserFacingDecision(record, decisionLogicForRecord(record)).visible)
    .map(mapActionedDecisionToHandledItem);

  return [...explicitItems, ...actionedItems]
    .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt))
    .slice(0, boundedLimit);
}

function isHandledByNexusItemUserFacing(item: HandledByNexusItem): boolean {
  const haystack = [
    item.title,
    item.summary,
    item.actionTaken,
    item.whyBrief,
    item.explanation?.headline,
    item.explanation?.whatHappened,
    item.explanation?.result,
  ].filter((value): value is string => typeof value === 'string');
  const hidden = haystack.some((value) => /\[smoke\]|decision_center_smoke|source[\s_-]?trace|decision\s+center\s+(?:v|version\s*)?\d+/i.test(value));
  if (hidden) {
    decisionGuidanceStats.filteredFromUserView += 1;
    decisionGuidanceStats.filteredByReason.smoke_decision = (decisionGuidanceStats.filteredByReason.smoke_decision ?? 0) + 1;
  }
  return !hidden;
}

export function runDecisionHandledHistoryBackfillJob(input: {
  userId?: number;
  tenantId?: number;
  limit?: number;
} = {}): DecisionHandledHistoryBackfillResult {
  ensureDecisionCenterTables();
  if (input.tenantId !== undefined && input.userId === undefined) {
    throw new Error('Decision handled-history backfill requires userId when tenantId is scoped.');
  }
  const tenantId = input.userId !== undefined ? input.tenantId ?? input.userId : undefined;
  if (input.userId !== undefined && tenantId !== undefined) {
    assertScope(input.userId, tenantId, 'decision_handled_history_backfill', { limit: input.limit });
  }
  const boundedLimit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const scopeClause = input.userId !== undefined && tenantId !== undefined
    ? 'AND items.user_id = ? AND items.tenant_id = ?'
    : '';
  const params: Array<number | string> = [];
  if (input.userId !== undefined && tenantId !== undefined) {
    params.push(input.userId, tenantId);
  }
  params.push(boundedLimit);
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           logs.action_taken AS decision_log_action_taken
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
      LEFT JOIN notification_decision_logs logs ON logs.decision_log_id = items.decision_log_id
      LEFT JOIN handled_by_nexus_items handled
        ON handled.decision_id = items.item_id
       AND handled.user_id = items.user_id
       AND handled.tenant_id = items.tenant_id
     WHERE items.status = 'actioned'
       AND handled.handled_item_id IS NULL
       ${scopeClause}
     ORDER BY COALESCE(items.actioned_at, items.created_at) DESC
     LIMIT ?
  `).all(...params) as any[];

  decisionHandledHistoryStats.backfillRuns += 1;
  const result: DecisionHandledHistoryBackfillResult = {
    inspected: rows.length,
    backfilled: 0,
    skipped: 0,
    failed: 0,
  };
  const existsStmt = getDb().prepare(`
    SELECT handled_item_id
      FROM handled_by_nexus_items
     WHERE decision_id = ?
       AND user_id = ?
       AND tenant_id = ?
     LIMIT 1
  `);
  for (const row of rows) {
    try {
      const record = mapDecisionRecord(row);
      const existing = existsStmt.get(record.itemId, record.userId, record.tenantId);
      if (existing) {
        result.skipped += 1;
        continue;
      }
      const item = mapActionedDecisionToHandledItem(record);
      recordHandledByNexus(record, {
        actionTaken: item.actionTaken,
        summary: item.summary,
        whyBrief: item.whyBrief,
        explanation: item.explanation,
        rollbackAvailable: item.rollbackAvailable,
        changedRuleOption: item.changedRuleOption,
        createdAt: item.createdAt,
      });
      result.backfilled += 1;
      decisionHandledHistoryStats.backfilled += 1;
    } catch (err) {
      result.failed += 1;
      decisionHandledHistoryStats.backfillFailures += 1;
      logger.error({
        err,
        decisionId: typeof row.item_id === 'string' ? row.item_id : null,
        userId: row.user_id,
        tenantId: row.tenant_id,
      }, 'Decision handled history backfill failed');
    }
  }
  return result;
}

export function cleanupDecisionCenterSmokeItems(input: {
  userId: number;
  tenantId?: number;
  dryRun: boolean;
  limit?: number;
}): DecisionCenterSmokeCleanupResult {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'decision_center_smoke_cleanup', { dryRun: input.dryRun, limit: input.limit });
  return runDecisionCenterSmokeCleanup({
    userId: input.userId,
    tenantId,
    dryRun: input.dryRun,
    limit: input.limit,
  });
}

export function runDecisionCenterSmokeCleanupJob(input: {
  olderThanHours?: number;
  limit?: number;
} = {}): DecisionCenterSmokeCleanupResult {
  const olderThanHours = Math.max(input.olderThanHours ?? 24, 1);
  const cutoff = DateTime.utc().minus({ hours: olderThanHours }).toISO()!;
  return runDecisionCenterSmokeCleanup({
    dryRun: false,
    limit: input.limit,
    olderThanIso: cutoff,
  });
}

function runDecisionCenterSmokeCleanup(input: {
  userId?: number;
  tenantId?: number;
  dryRun: boolean;
  limit?: number;
  olderThanIso?: string;
}): DecisionCenterSmokeCleanupResult {
  ensureDecisionCenterTables();
  const boundedLimit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const clauses = [
    "items.status != 'expired'",
    `(
      items.dedupe_key LIKE 'smoke:decision-center:%'
      OR intents.dedupe_key LIKE 'smoke:decision-center:%'
      OR intents.related_entity_type = 'decision_center_smoke'
      OR lower(items.title) LIKE '%[smoke]%'
      OR lower(items.body) LIKE '%[smoke]%'
      OR lower(intents.title) LIKE '%[smoke]%'
      OR lower(intents.body) LIKE '%[smoke]%'
      OR intents.decision_context_json LIKE '%"smoke":true%'
      OR intents.decision_context_json LIKE '%"internalOnly":true%'
    )`,
  ];
  const params: Array<string | number> = [];
  if (input.userId !== undefined && input.tenantId !== undefined) {
    clauses.push('items.user_id = ?', 'items.tenant_id = ?');
    params.push(input.userId, input.tenantId);
  }
  if (input.olderThanIso) {
    clauses.push('items.created_at <= ?');
    params.push(input.olderThanIso);
  }
  params.push(boundedLimit);
  const rows = getDb().prepare(`
    SELECT items.item_id,
           items.status,
           intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY items.created_at ASC
     LIMIT ?
  `).all(...params) as Array<{ item_id: string; status: string; decision_context_json: string | null }>;
  const countsByStatus: Record<string, number> = {};
  const countsByVisibilityScope: Record<string, number> = {};
  for (const row of rows) {
    countsByStatus[row.status] = (countsByStatus[row.status] ?? 0) + 1;
    const context = safeParseJson(row.decision_context_json, {}) as DecisionLogicContext;
    const scope = visibilityScopeFromContext(context) ?? 'unknown';
    countsByVisibilityScope[scope] = (countsByVisibilityScope[scope] ?? 0) + 1;
  }
  if (input.dryRun || rows.length === 0) {
    return { inspected: rows.length, expired: 0, dryRun: input.dryRun, countsByStatus, countsByVisibilityScope };
  }
    const update = getDb().prepare(`
      UPDATE notification_center_items
       SET status = 'expired', decision_state = 'expired',
           record_version = record_version + 1, updated_at = datetime('now')
     WHERE item_id = ?
  `);
  const txn = getDb().transaction((ids: string[]) => {
    for (const id of ids) update.run(id);
  });
  txn(rows.map((row) => row.item_id));
  return { inspected: rows.length, expired: rows.length, dryRun: false, countsByStatus, countsByVisibilityScope };
}

export interface DecisionExpirySweepResult {
  inspected: number;
  expired: number;
  remaining: number;
  batches: number;
  durationMs: number;
}

/**
 * Statuses that can still surface a decision to the user and therefore must be
 * expired once their deadline passes. Matches the authoritative active set used
 * by listDecisionItems(); 'open' is intentionally excluded (it is not a member
 * of NotificationCenterStatus and never matches a real row).
 */
const DECISION_EXPIRY_ACTIVE_STATUSES = ['unread', 'read', 'failed', 'snoozed'] as const;

/**
 * Proactively expire decisions whose hard deadline (expires_at) has passed.
 *
 * Decision lists already hide expired items in-memory (isDecisionExpired), so
 * this sweep is hygiene: it flips lingering active rows to 'expired' so DB
 * state, counts, and dedup lookups stay accurate instead of waiting for the
 * reactive flip in guardActionable() when a user taps an already-dead decision.
 *
 * Batched (LIMIT per pass, capped pass count) so a large backlog never runs as
 * a single long transaction. The comparison uses SQLite datetime() on both
 * sides so it is robust to ISO-with-Z vs 'YYYY-MM-DD HH:MM:SS' storage formats.
 * expires_at is expected to carry an explicit zone (the codebase convention,
 * matching the findActiveDuplicate guard in notification-orchestrator); a naive
 * timestamp is read as UTC by datetime(), so writers should store ISO-with-Z.
 */
export function runDecisionExpiryJob(input: { batchSize?: number; maxBatches?: number } = {}): DecisionExpirySweepResult {
  ensureDecisionCenterTables();
  const start = Date.now();
  const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 1000);
  const maxBatches = Math.min(Math.max(input.maxBatches ?? 20, 1), 200);
  const db = getDb();
  const statuses = [...DECISION_EXPIRY_ACTIVE_STATUSES];
  const placeholders = statuses.map(() => '?').join(', ');
  const selectExpired = db.prepare(`
    SELECT item_id, user_id, tenant_id
       FROM notification_center_items
     WHERE status IN (${placeholders})
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime(?)
     ORDER BY expires_at ASC
     LIMIT ?
  `);
  const countExpired = db.prepare(`
    SELECT COUNT(*) AS n
      FROM notification_center_items
     WHERE status IN (${placeholders})
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime(?)
  `);
  const update = db.prepare("UPDATE notification_center_items SET status = 'expired', decision_state = 'expired', record_version = record_version + 1, updated_at = datetime('now') WHERE item_id = ?");
  const expireBatch = db.transaction((rows: Array<{ item_id: string; user_id: number; tenant_id: number }>) => {
    for (const row of rows) {
      update.run(row.item_id);
      expireTrainingPlanRevisionForDecision(db, row.item_id, row.user_id, row.tenant_id);
    }
  });

  let expired = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const rows = selectExpired.all(...statuses, appNowIso(), batchSize) as Array<{ item_id: string; user_id: number; tenant_id: number }>;
    if (rows.length === 0) break;
    const ignoredRecords = rows.flatMap((row) => {
      const record = getDecisionRecord(row.item_id, row.user_id, row.tenant_id);
      if (!record) return [];
      const interacted = db.prepare(`
        SELECT 1 FROM decision_lifecycle_events
         WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
           AND event IN ('viewed', 'detail_opened', 'approved', 'rejected', 'deferred',
                         'snoozed', 'dismissed', 'action_started', 'action_succeeded')
         LIMIT 1
      `).get(row.item_id, row.user_id, row.tenant_id);
      return interacted ? [] : [record];
    });
    expireBatch(rows);
    for (const row of rows) {
      resolveDecisionConflictAudit(row.item_id, row.user_id, row.tenant_id, 'expired');
      emitDecisionLifecycleEvent({ decisionId: row.item_id, userId: row.user_id, tenantId: row.tenant_id, event: 'expired', toStatus: 'expired' });
    }
    for (const record of ignoredRecords) {
      recordDecisionOutcome(record, {
        actionShown: recommendedAction(actionsForRecord(record))?.id ?? null,
        ignored: true,
        timeToActionMs: timeToActionMs(record),
      });
    }
    emitUnblockedDependentsForBlockers(
      rows.map((row) => ({ decisionId: row.item_id, userId: row.user_id, tenantId: row.tenant_id })),
      'blocker_expired',
    );
    expired += rows.length;
    batches += 1;
    if (rows.length < batchSize) break;
  }

  const remaining = (countExpired.get(...statuses, appNowIso()) as { n: number }).n;
  return { inspected: expired, expired, remaining, batches, durationMs: Date.now() - start };
}

export interface DecisionLedgerRetentionPruneResult {
  outcomeLedgerPruned: number;
  qualityGateEventsPruned: number;
  conflictEvaluationsPruned: number;
  terminalExclusivityClaimsPruned: number;
  outcomeLedgerRemaining: number;
  qualityGateEventsRemaining: number;
  conflictEvaluationsRemaining: number;
  terminalExclusivityClaimsRemaining: number;
  /** Combined bounded batch-pass count across every raw table. */
  batches: number;
  durationMs: number;
}

/**
 * Enforce the declared retention horizon for the Decision Center's write-heavy raw telemetry tables by
 * age-pruning rows older than DECISION_OUTCOME_LEDGER_RETENTION_POLICY.rawOutcomeRetentionDays. Without
 * this the policy is only declarative: outcome, quality-gate, conflict-evaluation, and terminal
 * exclusivity rows grow
 * unbounded and getDecisionOutcomeMetrics materializes an ever-larger per-user partition on the request
 * path (the very scan that gates the T14 dashboard at scale).
 *
 * GLOBAL (tenant-agnostic) age-based prune. Batched (LIMIT per pass, capped pass count) so a large
 * backlog never runs as one long transaction. Portable batched DELETE: select a batch of primary keys
 * matching the age predicate, then delete that batch in a transaction (SQLite has no DELETE ... LIMIT by
 * default). The created_at predicate rides the existing (user_id, tenant_id, created_at) indexes; the
 * datetime() comparison is robust to ISO-with-Z vs space-separated storage formats. Table + PK names
 * are compile-time literals (not input), so the dynamic SQL carries no injection surface.
 *
 * These raw tables intentionally share rawOutcomeRetentionDays (same class of raw event; the 730-day
 * aggregateRetentionDays tier is for derived rollups, not these). No VACUUM/ANALYZE is run — a frequent
 * cron must not take SQLite's whole-DB write lock, and freed pages are reused by the steady stream of
 * new inserts, so disk stays flat in steady state without reclaiming on each pass.
 */
export function runDecisionLedgerRetentionPruneJob(
  input: { retentionDays?: number; batchSize?: number; maxBatches?: number } = {},
): DecisionLedgerRetentionPruneResult {
  ensureDecisionCenterTables();
  const start = Date.now();
  const retentionDays = Math.max(input.retentionDays ?? DECISION_OUTCOME_LEDGER_RETENTION_POLICY.rawOutcomeRetentionDays, 1);
  const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 1000);
  const maxBatches = Math.min(Math.max(input.maxBatches ?? 50, 1), 500);
  const db = getDb();
  const cutoff = `-${Math.floor(retentionDays)} days`;

  const pruneTable = (
    table: string,
    pkColumn: string,
    extraPredicate = '1 = 1',
  ): { pruned: number; remaining: number; batches: number } => {
    const selectOld = db.prepare(`
      SELECT ${pkColumn} AS id FROM ${table}
       WHERE datetime(created_at) < datetime('now', ?) AND ${extraPredicate}
       ORDER BY created_at ASC
       LIMIT ?
    `);
    const del = db.prepare(`DELETE FROM ${table} WHERE ${pkColumn} = ?`);
    const delBatch = db.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    let pruned = 0;
    let batches = 0;
    while (batches < maxBatches) {
      const rows = selectOld.all(cutoff, batchSize) as Array<{ id: string }>;
      if (rows.length === 0) break;
      delBatch(rows.map((row) => row.id));
      pruned += rows.length;
      batches += 1;
      if (rows.length < batchSize) break;
    }
    const remaining = (db.prepare(`
      SELECT COUNT(*) AS n FROM ${table}
       WHERE datetime(created_at) < datetime('now', ?) AND ${extraPredicate}
    `).get(cutoff) as { n: number }).n;
    return { pruned, remaining, batches };
  };

  const outcome = pruneTable('decision_outcome_ledger', 'outcome_id');
  const gate = pruneTable('decision_quality_gate_events', 'event_id');
  const conflicts = pruneTable('decision_conflict_evaluations', 'conflict_evaluation_id');
  // Recovery-held claims (`started` and `partially_failed`) remain durable so
  // retry/reconciliation can never reopen a duplicate side effect.
  const exclusivity = pruneTable(
    'decision_exclusivity_claims',
    'rowid',
    "status IN ('failed', 'expired', 'succeeded')",
  );
  return {
    outcomeLedgerPruned: outcome.pruned,
    qualityGateEventsPruned: gate.pruned,
    conflictEvaluationsPruned: conflicts.pruned,
    terminalExclusivityClaimsPruned: exclusivity.pruned,
    outcomeLedgerRemaining: outcome.remaining,
    qualityGateEventsRemaining: gate.remaining,
    conflictEvaluationsRemaining: conflicts.remaining,
    terminalExclusivityClaimsRemaining: exclusivity.remaining,
    batches: outcome.batches + gate.batches + conflicts.batches + exclusivity.batches,
    durationMs: Date.now() - start,
  };
}

/**
 * Record a typed dependency edge from `decisionId` to `dependsOnDecisionId`. With the canonical
 * `blocks` relationship the target (`dependsOnDecisionId`) blocks `decisionId`: while the target is
 * unresolved, `decisionId` is reported in `blockedByDecisionIds` and its mutating actions are refused.
 *
 * Directionality matters and only `blocks` prevents action. `blocked_by` is a DISPLAY-ONLY inverse
 * label (kind `inverse_blocked`, blocksAction=false) — writing a `blocked_by` edge blocks NOTHING; to
 * actually block `decisionId`, store a forward `blocks` edge to its blocker as above, never a lone
 * `blocked_by` on the decision itself. Every other type (conflicts_with / duplicate_of / related* /
 * supersedes / caused_by / ...) is advisory (see decisionRelationshipSemantics).
 */
export function addDecisionDependency(input: {
  decisionId: string;
  dependsOnDecisionId: string;
  userId: number;
  tenantId?: number;
  relationship?: DecisionRelationshipType;
}): void {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'add_decision_dependency', {
    decisionId: input.decisionId,
    dependsOnDecisionId: input.dependsOnDecisionId,
  });
  ensureDecisionCenterTables();
  const current = getDecisionRecord(input.decisionId, input.userId, tenantId);
  const blocker = getDecisionRecord(input.dependsOnDecisionId, input.userId, tenantId);
  if (!current || !blocker) {
    throw new DecisionActionError('DECISION_NOT_FOUND', 'Dependency decisions must both belong to the authenticated scope', 404);
  }
  getDb().prepare(`
    INSERT OR IGNORE INTO decision_dependencies (
      dependency_id, decision_id, depends_on_decision_id, user_id, tenant_id, relationship
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `dep_${randomUUID()}`,
    input.decisionId,
    input.dependsOnDecisionId,
    input.userId,
    tenantId,
    input.relationship ?? 'blocks',
  );
}

export function listDecisionDependencies(decisionId: string, userId: number, tenantId = userId): Array<{
  decisionId: string;
  dependsOnDecisionId: string;
  relationship: string;
  blockerStatus: string | null;
}> {
  assertScope(userId, tenantId, 'list_decision_dependencies', { decisionId });
  ensureDecisionCenterTables();
  const rows = getDb().prepare(`
    SELECT deps.decision_id,
           deps.depends_on_decision_id,
           deps.relationship,
           blocker.status AS blocker_status
      FROM decision_dependencies deps
      LEFT JOIN notification_center_items blocker
        ON blocker.item_id = deps.depends_on_decision_id
       AND blocker.user_id = deps.user_id
       AND blocker.tenant_id = deps.tenant_id
     WHERE deps.decision_id = ?
       AND deps.user_id = ?
       AND deps.tenant_id = ?
     ORDER BY deps.created_at ASC
  `).all(decisionId, userId, tenantId) as Array<{
    decision_id: string;
    depends_on_decision_id: string;
    relationship: string;
    blocker_status: string | null;
  }>;
  return rows.map((row) => ({
    decisionId: row.decision_id,
    dependsOnDecisionId: row.depends_on_decision_id,
    relationship: row.relationship,
    blockerStatus: row.blocker_status,
  }));
}

export function runDecisionSourceStateSupersessionJob(opts: { userId?: number; tenantId?: number } = {}): {
  scannedCount: number;
  supersededCount: number;
  reasons: Record<string, number>;
} {
  ensureDecisionCenterTables();
  if (opts.userId != null || opts.tenantId != null) {
    const scopedUserId = opts.userId ?? opts.tenantId!;
    assertScope(scopedUserId, opts.tenantId ?? scopedUserId, 'decision_source_state_supersession_job', {});
  }
  const clauses = ["items.status IN ('unread', 'read', 'failed', 'snoozed')"];
  const params: unknown[] = [];
  if (opts.userId != null) {
    clauses.push('items.user_id = ?');
    params.push(opts.userId);
  }
  if (opts.tenantId != null) {
    clauses.push('items.tenant_id = ?');
    params.push(opts.tenantId);
  }
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE ${clauses.join(' AND ')}
  `).all(...params) as any[];

  const reasons: Record<string, number> = {};
  let supersededCount = 0;
  for (const row of rows) {
    const record = mapDecisionRecord(row);
    const reason = sourceStateSupersessionReason(record);
    if (!reason) continue;
    supersedeDecision(record, reason);
    supersededCount += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  if (supersededCount > 0) {
    logger.info({ supersededCount, reasons }, 'Decision Center source-state supersession job closed stale decisions');
  }
  return { scannedCount: rows.length, supersededCount, reasons };
}

export function supersedeDecisionSourceStateForEntity(input: {
  userId: number;
  tenantId?: number;
  sourceSkill: NotificationSourceSkill;
  relatedEntityType: string;
  relatedEntityId: string;
}): {
  scannedCount: number;
  supersededCount: number;
  reasons: Record<string, number>;
} {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'supersede_decision_source_state_for_entity', {
    sourceSkill: input.sourceSkill,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
  });
  ensureDecisionCenterTables();
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.source_skill = ?
       AND intents.related_entity_type = ?
       AND intents.related_entity_id = ?
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
  `).all(input.userId, tenantId, input.sourceSkill, input.relatedEntityType, input.relatedEntityId) as any[];

  const reasons: Record<string, number> = {};
  let supersededCount = 0;
  for (const row of rows) {
    const record = mapDecisionRecord(row);
    const reason = sourceStateSupersessionReason(record);
    if (!reason) continue;
    supersedeDecision(record, reason);
    supersededCount += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  if (supersededCount > 0) {
    logger.info({
      userId: input.userId,
      tenantId,
      sourceSkill: input.sourceSkill,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      supersededCount,
      reasons,
    }, 'Decision Center targeted source-state supersession closed stale decisions');
  }
  return { scannedCount: rows.length, supersededCount, reasons };
}

export function getDecisionOutcomeMetrics(userId: number, tenantId = userId): DecisionOutcomeMetrics {
  assertScope(userId, tenantId, 'get_decision_outcome_metrics');
  ensureDecisionCenterTables();
  const outcomeRows = getDb().prepare(`
    SELECT
      source_skill AS sourceSkill,
      confidence,
      automation_eligibility AS automationEligibility,
      action_shown AS actionShown,
      action_taken AS actionTaken,
      accepted,
      dismissed,
      snoozed,
      asked_nexus AS askedNexus,
      undo_used AS undoUsed,
      time_to_action_ms AS timeToActionMs,
      action_succeeded AS actionSucceeded,
      partial_failure AS partialFailure,
      feature_snapshot_json AS featureSnapshotJson
    FROM decision_outcome_ledger
    WHERE user_id = ? AND tenant_id = ?
  `).all(userId, tenantId) as Array<{
    sourceSkill: string;
    confidence: number;
    automationEligibility: string;
    actionShown: string | null;
    actionTaken: string | null;
    accepted: number;
    dismissed: number;
    snoozed: number;
    askedNexus: number;
    undoUsed: number;
    timeToActionMs: number | null;
    actionSucceeded: number;
    partialFailure: number;
    featureSnapshotJson: string;
  }>;
  const gateTotals = getDb().prepare(`
    SELECT
      COUNT(*) AS totalQualityGateEvents,
      COALESCE(SUM(generic_blocked), 0) AS genericBlockedCount
    FROM decision_quality_gate_events
    WHERE user_id = ? AND tenant_id = ?
  `).get(userId, tenantId) as { totalQualityGateEvents: number; genericBlockedCount: number };
  const gateStatusRows = getDb().prepare(`
    SELECT quality_status AS status, COUNT(*) AS count
    FROM decision_quality_gate_events
    WHERE user_id = ? AND tenant_id = ?
    GROUP BY quality_status
  `).all(userId, tenantId) as Array<{ status: string; count: number }>;
  const qualityGateByStatus: Record<string, number> = {};
  for (const row of gateStatusRows) qualityGateByStatus[row.status] = Number(row.count ?? 0);
  const bySourceRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, COUNT(*) AS count
    FROM decision_outcome_ledger
    WHERE user_id = ? AND tenant_id = ?
    GROUP BY source_skill
  `).all(userId, tenantId) as Array<{ sourceSkill: string; count: number }>;
  const totalOutcomes = outcomeRows.length;
  const acceptedCount = outcomeRows.filter((row) => !!row.accepted).length;
  const dismissedCount = outcomeRows.filter((row) => !!row.dismissed).length;
  const isDeferredOutcome = (row: { snoozed: number; actionTaken: string | null }): boolean => {
    return !!row.snoozed || row.actionTaken === 'snooze';
  };
  const snoozedCount = outcomeRows.filter((row) => !!row.snoozed).length;
  const deferredCount = outcomeRows.filter(isDeferredOutcome).length;
  const askedNexusCount = outcomeRows.filter((row) => !!row.askedNexus).length;
  const undoUsedCount = outcomeRows.filter((row) => !!row.undoUsed).length;
  const primaryActionCount = outcomeRows.filter((row) => !!row.actionTaken).length;
  const failedActionCount = outcomeRows.filter((row) => row.actionSucceeded === 0 && !!row.actionTaken).length;
  const partialFailureCount = outcomeRows.filter((row) => !!row.partialFailure).length;
  const autoHandledCount = outcomeRows.filter((row) => row.actionTaken === 'superseded' || row.actionTaken === 'auto_dismiss_stale_decision').length;
  const timeToActionValues = outcomeRows
    .map((row) => row.timeToActionMs)
    .filter((value): value is number => typeof value === 'number');
  const average = (values: number[]): number | null => {
    if (values.length === 0) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  };
  const qualityScores = outcomeRows
    .map((row) => Number((safeParseJson(row.featureSnapshotJson, {}) as Record<string, unknown>).qualityScore))
    .filter((value) => Number.isFinite(value));
  const specificityScores = outcomeRows.map((row) => {
    const snapshot = safeParseJson(row.featureSnapshotJson, {}) as Record<string, unknown>;
    let score = 20;
    if (typeof snapshot.sourceSkill === 'string') score += 20;
    if (typeof snapshot.decisionType === 'string') score += 20;
    if (typeof snapshot.riskLevel === 'string') score += 15;
    if (typeof snapshot.deadlineDistance === 'string' && snapshot.deadlineDistance !== 'none') score += 15;
    if (Number(snapshot.relatedEntitiesCount ?? 0) > 0) score += 10;
    return Math.min(score, 100);
  });
  const actionabilityScores = outcomeRows.map((row) => {
    let score = row.actionShown ? 65 : 25;
    if (row.actionTaken) score += 20;
    if (row.automationEligibility && row.automationEligibility !== 'never') score += 10;
    if (row.actionSucceeded === 1 || row.partialFailure === 1) score += 5;
    return Math.min(score, 100);
  });
  const rate = (count: number): number => totalOutcomes > 0 ? Number((count / totalOutcomes).toFixed(4)) : 0;
  const bySourceSkill: Record<string, number> = {};
  for (const row of bySourceRows) {
    bySourceSkill[row.sourceSkill] = Number(row.count ?? 0);
  }
  const bySourceSkillOutcome: DecisionOutcomeMetrics['bySourceSkillOutcome'] = {};
  for (const row of outcomeRows) {
    const bucket = bySourceSkillOutcome[row.sourceSkill] ?? {
      total: 0,
      accepted: 0,
      dismissed: 0,
      deferred: 0,
    };
    bucket.total += 1;
    if (row.accepted) bucket.accepted += 1;
    if (row.dismissed) bucket.dismissed += 1;
    if (isDeferredOutcome(row)) bucket.deferred += 1;
    bySourceSkillOutcome[row.sourceSkill] = bucket;
  }
  // C4: every quality-gate evaluation (pass and fail) is recorded, so the gate-event
  // count is the true denominator for the rejection rate (no double-counting outcomes).
  const totalDecisionQualityAttempts = Number(gateTotals.totalQualityGateEvents ?? 0);
  const genericBlockedCount = Number(gateTotals.genericBlockedCount ?? 0);
  return {
    userId,
    tenantId,
    totalOutcomes,
    decisionQualityScore: average(qualityScores),
    decisionSpecificityScore: average(specificityScores),
    decisionActionabilityScore: average(actionabilityScores),
    acceptedCount,
    dismissedCount,
    deferredCount,
    snoozedCount,
    askedNexusCount,
    explanationOpenCount: askedNexusCount,
    genericBlockedCount,
    totalQualityGateEvents: Number(gateTotals.totalQualityGateEvents ?? 0),
    qualityGateByStatus,
    undoUsedCount,
    primaryActionCount,
    failedActionCount,
    partialFailureCount,
    autoHandledCount,
    averageTimeToActionMs: average(timeToActionValues),
    primaryActionRate: rate(primaryActionCount),
    dismissRate: rate(dismissedCount),
    deferRate: rate(deferredCount),
    snoozeRate: rate(snoozedCount),
    explanationOpenRate: rate(askedNexusCount),
    genericBlockedRate: totalDecisionQualityAttempts > 0 ? Number((genericBlockedCount / totalDecisionQualityAttempts).toFixed(4)) : 0,
    failedActionRate: rate(failedActionCount),
    partialFailureRate: rate(partialFailureCount),
    bySourceSkill,
    bySourceSkillOutcome,
  };
}

export async function performDecisionAction(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId = userId,
  opts: {
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
    channel?: string;
    expectedVersion?: number;
    contextVersion?: string;
    /** Internal-only signal set by the two-key, opted-in low-risk resolver. */
    automaticResolution?: boolean;
  } = {},
): Promise<DecisionActionResult> {
  assertScope(userId, tenantId, 'perform_decision_action', { decisionId, actionId });
  ensureDecisionCenterTables();
  reclaimExpiredExecutionLeases(userId, tenantId);
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found for authenticated user', 404);
  const idempotencyKey = opts.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_REQUIRED', 'Decision actions require an idempotency key', 400);
  }
  if (opts.channel === 'apns' && !isDecisionActionAllowedFromApns(actionId)) {
    throw new DecisionActionError(
      'APNS_ACTION_NOT_ALLOWED',
      'This notification action must be confirmed inside Nexus before it can change source data.',
      409,
      { channel: 'apns', actionId },
    );
  }
  // Idempotency short-circuits BEFORE re-validating availability: a key we have already seen is replayed
  // based on its prior outcome regardless of whether the action is still "available" now. This matters for
  // a dynamically-surfaced action whose availability precondition is consumed by its own execution —
  // choose_another_time stops being injected once the agenda is reflowed — so a client retry of a write
  // that already succeeded must return the original result, not a spurious DECISION_ACTION_NOT_ALLOWED.
  const existing = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  if (existing && existing.status === 'succeeded') {
    return idempotentActionResult(decisionId, actionId, userId, tenantId, existing);
  }
  if (existing && existing.status === 'started') {
    return waitForExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  }
  if (existing && existing.status === 'partially_failed') {
    const reconciliation = reconcilePartialDecisionExecution(record);
    const reconciled = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
    if (reconciliation === 'applied' && reconciled?.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, reconciled);
    }
    throw executionReplayError(reconciled ?? existing, reconciliation === 'unknown'
      ? 'Prior decision action outcome still requires recovery review'
      : 'Prior decision action attempt was verified as not applied');
  }
  if (existing && existing.status === 'failed') {
    throw executionReplayError(existing, 'Prior decision action attempt failed');
  }
  if (opts.contextVersion && opts.contextVersion !== decisionContextVersion(record)) {
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed and must be reviewed again.', 409, {
      currentContextVersion: decisionContextVersion(record),
    });
  }
  const actionPayload = validatedDecisionActionPayload(record, actionId, opts.payload ?? {});
  const logicalActionHash = logicalActionHashForAttempt(record, actionId, actionPayload);
  const existingLogical = getExistingLogicalExecution(userId, tenantId, logicalActionHash);
  if (existingLogical?.status === 'started') {
    logger.info({
      event: 'decision.logical_duplicate_blocked',
      decisionId,
      canonicalDecisionId: existingLogical.decision_id,
      userId,
      tenantId,
    }, 'Decision logical duplicate joined an active execution');
    return waitForExecutionById(decisionId, actionId, userId, tenantId, existingLogical.action_execution_id);
  }
  if (existingLogical?.status === 'succeeded' && actionId !== 'undo_reflow') {
    guardActionable(record, actionId);
    return idempotentActionResult(decisionId, actionId, userId, tenantId, existingLogical);
  }
  if (existingLogical?.status === 'partially_failed') {
    throw executionReplayError(existingLogical, 'An equivalent decision action requires recovery review');
  }
  guardDecisionLifecycleMutation(record, 'perform_action', {
    allowExecution: { actionId, idempotencyKey },
  });
  // A verified replay is returned above even if the source has since changed.
  // Only genuinely new attempts are evaluated against current state.
  const supersededReason = supersedeIfSourceStateStale(record);
  if (supersededReason) {
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'Decision context changed because the source item is no longer actionable.',
      409,
      { reason: supersededReason },
    );
  }
  // New attempt (unseen key): now validate that the action is actually available + actionable.
  const availableActions = actionsForRecord(record);
  const systemLifecycleAction: NotificationActionButton | null = actionId === 'snooze'
    ? { id: 'snooze', label: 'Snooze', style: 'secondary' }
    : actionId === 'dismiss'
      ? { id: 'dismiss', label: 'Dismiss', style: 'secondary' }
      : null;
  const selectedAction = availableActions.find((candidate) => candidate.id === actionId) ?? systemLifecycleAction;
  if (!selectedAction) {
    throw new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'That action is not available for this decision', 400);
  }
  guardActionable(record, actionId);
  guardDecisionDependencies(record, actionId);
  // Direct API callers may act before the client has posted its card exposure.
  // Keep audit ordering deterministic by recording the selected preview once
  // before the execution claim.
  emitDecisionActionPreviewedIfFirst(record, actionId);

  const action = selectedAction;
  const requiresVersionClaim = MUTATING_ACTIONS.has(actionId);
  const requiresExpectedVersion = VERSIONED_DECISION_ACTIONS.has(actionId);
  if (requiresVersionClaim) {
    const approvalLevel = approvalLevelForRecord(record);
    if (approvalLevel === 'unavailable') {
      throw new DecisionActionError('DECISION_PERMISSION_REQUIRED', 'Current permissions do not allow this action.', 403);
    }
    if (approvalLevel === 'admin_review') {
      throw new DecisionActionError('DECISION_ADMIN_REVIEW_REQUIRED', 'This action requires an authorized administrator review.', 403);
    }
    if (approvalLevel === 'strong_confirmation'
        && decisionFlowV1EnforcedForRecord(record)
        && !hasStrongApprovalForCurrentVersion(record)) {
      throw new DecisionActionError(
        'DECISION_STRONG_CONFIRMATION_REQUIRED',
        'This high-impact action requires a current strong approval before execution.',
        409,
        { currentItem: formatDecisionItemForApi(record) },
      );
    }
    if (approvalLevel === 'strong_confirmation'
        && !decisionFlowV1EnforcedForRecord(record)) {
      emitDecisionLifecycleEvent({
        decisionId,
        userId,
        tenantId,
        event: 'strong_confirmation_legacy_bypass',
        actionId,
        reason: 'decision_flow_v1_enforcement_disabled',
        metadata: { approvalLevel, recordVersion: record.recordVersion },
      });
    }
    revalidateDecisionActionForExecution(record, actionId, opts.contextVersion, actionPayload);
  }
  validateExpectedDecisionVersion(record, opts.expectedVersion, requiresExpectedVersion);
  const claimed = claimExecution(
    record,
    actionId,
    idempotencyKey,
    executorSkillForAction(actionId, record),
    {
      logicalActionHash: requiresVersionClaim ? logicalActionHash : null,
      expectedVersion: opts.expectedVersion ?? record.recordVersion,
      contextVersion: decisionContextVersion(record),
      mutateRecordVersion: requiresVersionClaim,
      expectedEffect: expectedExecutionStateForAttempt(record, actionId, actionPayload),
    },
  );
  if (!claimed.isNew) {
    if (claimed.execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, claimed.execution);
    }
    if (claimed.execution.status === 'started') {
      return waitForExecutionById(decisionId, actionId, userId, tenantId, claimed.execution.action_execution_id);
    }
    throw executionReplayError(claimed.execution, 'Prior decision action attempt failed');
  }

  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'action_started', actionId });
  let sourceEffectCompleted = false;
  let completedExecution: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
    message: string;
  } | null = null;
  try {
    const claimedRecord = getDecisionRecord(decisionId, userId, tenantId);
    if (!claimedRecord) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing before execution', 404);
    if (requiresVersionClaim) {
      await refreshTrainingCapacityForDecisionExecution(
        claimedRecord,
        actionId,
        claimed.execution.action_execution_id,
      );
      revalidateDecisionActionForExecution(claimedRecord, actionId, opts.contextVersion, actionPayload);
    }
    const changedReason = actionId === 'undo_reflow' ? null : sourceStateSupersessionReason(claimedRecord);
    if (changedReason) {
      throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed before execution and needs review.', 409, {
        reason: changedReason,
        recordVersion: claimedRecord.recordVersion,
      });
    }
    const execution = await executeDecisionAction(
      record,
      action,
      userId,
      tenantId,
      idempotencyKey,
      actionPayload,
      opts.expectedVersion,
      claimed.execution.action_execution_id,
    );
    completedExecution = execution;
    // From this point onward the authoritative domain executor returned after its read-back.
    // Post-success projection/audit errors must never rewrite that completed effect as failed.
    sourceEffectCompleted = true;
    markExecutionSucceeded(
      claimed.execution.action_execution_id,
      userId,
      tenantId,
      execution.expectedEffect,
      execution.actualEffect,
    );
    if (actionId === 'approve_product_learning_case'
        && record.relatedEntityType === 'product_learning_case'
        && record.relatedEntityId) {
      recordLearningCaseReviewApproval({
        tenantId,
        userId,
        caseId: record.relatedEntityId,
        actionExecutionId: claimed.execution.action_execution_id,
      });
    }
    // Post-action: format the just-actioned decision directly from its record. The active-inbox visibility
    // filter (getDecisionItem → isUserFacingDecision) must NOT apply here — a successfully actioned decision
    // belongs to handled history and must be returned as the action result even when a live re-read would
    // hide it. This matters for actions that mutate their own source state: choose_another_time moves the
    // agenda so the recomputed advice degrades and the filtered read would drop the decision, throwing a
    // spurious "Decision missing" after a write that actually succeeded.
    const updatedRecord = getDecisionRecord(decisionId, userId, tenantId);
    const updated = updatedRecord && isDecisionRecord(updatedRecord) ? formatDecisionItemForApi(updatedRecord) : null;
    if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after action execution', 500);
    try {
      recordVerifiedDecisionAction(record, action, actionId, execution);
      resolveDecisionConflictAudit(
        decisionId,
        userId,
        tenantId,
        opts.automaticResolution === true ? 'automatic_low_risk_reflow' : 'execution_succeeded',
        opts.automaticResolution === true,
      );
      emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'action_succeeded', actionId, toStatus: updated.status });
      if (execution.readBackOk) emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'verified', actionId });
      if (actionId === 'undo_reflow') emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'rolled_back', actionId, toStatus: updated.status });
      if (opts.automaticResolution === true) {
        emitDecisionLifecycleEvent({
          decisionId,
          userId,
          tenantId,
          event: 'auto_resolved',
          actionId,
          toStatus: updated.status,
          reason: 'persisted_user_opt_in_low_risk_reversible',
        });
      }
      if (actionId !== 'snooze'
          && execution.actualEffect.decisionOutcomeRecorded !== true) {
        recordDecisionOutcome(record, {
          actionShown: action.id,
          actionTaken: actionId,
          ...decisionOutcomeFlagsForAction(actionId, action),
          actionSucceeded: true,
          timeToActionMs: timeToActionMs(record),
        });
      }
    } catch (postSuccessError) {
      logger.error({
        event: 'decision.post_success_audit_failed',
        err: postSuccessError,
        decisionId,
        actionId,
        userId,
        tenantId,
        actionExecutionId: claimed.execution.action_execution_id,
      }, 'Decision action succeeded but post-success audit projection failed');
    }
    return {
      actionId,
      status: 'succeeded',
      idempotent: false,
      item: updated,
      verification: {
        readBackOk: execution.readBackOk,
        expectedEffect: execution.expectedEffect,
        actualEffect: execution.actualEffect,
        message: execution.message,
      },
    };
  } catch (err) {
    if (sourceEffectCompleted && completedExecution) {
      const reconciliationStatus = reconcileCompletedExecutionAfterResponseFailure(
        claimed.execution.action_execution_id,
        userId,
        tenantId,
        completedExecution,
      );
      logger.error({
        event: 'decision.post_success_response_failed',
        err,
        decisionId,
        actionId,
        userId,
        tenantId,
        actionExecutionId: claimed.execution.action_execution_id,
        reconciliationStatus,
      }, 'Decision action completed but the success response could not be finalized');
      if (reconciliationStatus === 'succeeded') {
        try {
          return idempotentActionResult(decisionId, actionId, userId, tenantId, {
            ...claimed.execution,
            status: 'succeeded',
            expected_effect_json: JSON.stringify(completedExecution.expectedEffect),
            result_json: JSON.stringify(completedExecution.actualEffect),
          });
        } catch (replayProjectionError) {
          logger.error({
            event: 'decision.post_success_replay_projection_failed',
            err: replayProjectionError,
            decisionId,
            actionId,
            actionExecutionId: claimed.execution.action_execution_id,
          }, 'Completed decision action could not be projected for the immediate replay response');
        }
      }
      throw new DecisionActionError(
        'DECISION_POST_SUCCESS_RESPONSE_FAILED',
        'The action completed, but Nexus could not finish the response. Retry with the same idempotency key.',
        500,
        {
          actionCompleted: true,
          actionExecutionId: claimed.execution.action_execution_id,
          retryWithSameIdempotencyKey: reconciliationStatus === 'succeeded',
          reconciliationStatus,
        },
      );
    }
    const error = err instanceof DecisionActionError
      ? err
      : new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action failed verification', 500, {
          ...privacySafeTransportErrorDetails(err),
          originalErrorLogged: true,
        });
    if (actionId === 'activate_training_plan_revision'
        && isRetryableTrainingOperationDecisionError(error)
        && releaseRetryableTrainingActivationExecution(
          record,
          claimed.execution.action_execution_id,
        )) {
      logger.warn({
        event: 'decision.training_activation_lock_retryable',
        decisionId,
        actionId,
        operation: error.details?.operation,
        errorCode: error.code,
      }, 'Training activation deferred without consuming its Decision attempt');
      emitDecisionLifecycleEvent({
        decisionId,
        userId,
        tenantId,
        event: 'action_retryable',
        actionId,
        toStatus: record.status,
        reason: error.code,
      });
      throw error;
    }
    logger.error(
      { err, decisionId, actionId, userId, tenantId },
      'Decision action failed',
    );
    const failureOutcome = markExecutionFailed(
      claimed.execution.action_execution_id,
      userId,
      tenantId,
      error.code,
      error.details,
    );
    resolveDecisionConflictAudit(
      decisionId,
      userId,
      tenantId,
      failureOutcome === 'partially_failed' ? 'execution_partially_failed' : 'execution_failed',
    );
    const failureRecord = getDecisionRecord(record.itemId, record.userId, record.tenantId);
    if (failureRecord && ['unread', 'read', 'failed'].includes(failureRecord.status)) {
      markDecisionFailed(failureRecord, actionId, error.code);
    }
    emitDecisionLifecycleEvent({
      decisionId,
      userId,
      tenantId,
      event: failureOutcome === 'partially_failed' ? 'action_partially_failed' : 'action_failed',
      actionId,
      reason: error.code,
    });
    recordDecisionOutcome(record, {
      actionShown: actionId,
      actionTaken: actionId,
      actionSucceeded: false,
      failedReason: error.code,
      partialFailure: failureOutcome === 'partially_failed',
      timeToActionMs: timeToActionMs(record),
    });
    throw error;
  }
}

export type DecisionReviewOutcome = 'approve' | 'reject' | 'defer';
export type DecisionReplacementChoice = 'keep_existing_commitment' | 'replace_with_candidate' | 'choose_another_time' | 'review_tradeoff';

export function reviewDecision(
  decisionId: string,
  userId: number,
  tenantId: number,
  input: {
    outcome: DecisionReviewOutcome;
    expectedVersion?: number;
    idempotencyKey?: string;
    deferUntil?: string;
    reasonCode?: string;
    replacementChoiceId?: DecisionReplacementChoice;
    strongConfirmationText?: string;
  },
): DecisionApiItem {
  assertScope(userId, tenantId, 'review_decision', { decisionId });
  ensureDecisionCenterTables();
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_REQUIRED', 'Decision reviews require an idempotency key', 400);
  }
  if (input.expectedVersion == null) {
    throw new DecisionActionError('DECISION_VERSION_REQUIRED', 'Decision reviews require the current record version', 428);
  }
  const expectedVersion = input.expectedVersion;
  const reviewAttemptHash = logicalActionAttemptHash(`review:${decisionId}`, input.outcome, {
    expectedVersion,
    idempotencyKey,
  });
  const prior = getDb().prepare(`
    SELECT 1 FROM decision_lifecycle_events
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND action_id = ?
     LIMIT 1
  `).get(decisionId, userId, tenantId, `review:${reviewAttemptHash}`);
  if (prior) {
    const replay = getDecisionRecord(decisionId, userId, tenantId);
    if (!replay) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
    return formatDecisionItemForApi(replay);
  }
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!(record && decisionFlowV1EnforcedForRecord(record))) {
    throw new DecisionActionError('DECISION_REVIEW_UNAVAILABLE', 'Versioned decision review is not enabled for this account.', 409);
  }
  guardDecisionLifecycleMutation(record, `review_${input.outcome}`);
  const approvalLevel = approvalLevelForRecord(record);
  if (input.outcome === 'approve') {
    if (approvalLevel === 'none') {
      throw new DecisionActionError(
        'DECISION_REVIEW_NOT_APPLICABLE',
        'This item is review-only and cannot be approved for execution',
        409,
      );
    }
    if (approvalLevel === 'unavailable') {
      throw new DecisionActionError('DECISION_PERMISSION_REQUIRED', 'Current permissions do not allow this proposal to be approved.', 403);
    }
    if (approvalLevel === 'admin_review') {
      throw new DecisionActionError('DECISION_ADMIN_REVIEW_REQUIRED', 'This proposal requires an authorized administrator review.', 403);
    }
    if (approvalLevel === 'strong_confirmation' && input.strongConfirmationText !== 'CONFIRM') {
      throw new DecisionActionError('DECISION_STRONG_CONFIRMATION_REQUIRED', 'Type CONFIRM to approve this high-impact proposal.', 409);
    }
    const currentState = durableDecisionStateForRecord(record);
    if (currentState !== 'ready_for_review' && currentState !== 'proposed') {
      throw new DecisionActionError('DECISION_TRANSITION_NOT_ALLOWED', 'This decision is not ready for approval.', 409, {
        decisionState: currentState,
        currentItem: formatDecisionItemForApi(record),
      });
    }
    const dependencyState = dependencyStateForRecord(record);
    if (dependencyState.blockedByDecisionIds.length > 0) {
      throw new DecisionActionError('DECISION_DEPENDENCY_BLOCKED', 'Resolve blocking decisions before approval.', 409, {
        blockedByDecisionIds: dependencyState.blockedByDecisionIds,
      });
    }
  }
  if (!reviewSupportedForRecord(record)) {
    throw new DecisionActionError(
      'DECISION_REVIEW_NOT_SUPPORTED',
      'This decision does not support the versioned review workflow.',
      409,
      { currentItem: formatDecisionItemForApi(record) },
    );
  }
  validateExpectedDecisionVersion(record, expectedVersion, true);
  guardActionable(record, 'review');
  if (input.outcome === 'approve') {
    const storedConflict = decisionContextForRecord(record).conflictEvaluation;
    const requiresReplacementChoice = storedConflict?.findings.some((finding) => finding.class === 'approved_commitment') === true;
    if (requiresReplacementChoice && input.replacementChoiceId !== 'replace_with_candidate') {
      throw new DecisionActionError(
        'DECISION_REPLACEMENT_CONFIRMATION_REQUIRED',
        'Choose the proposed replacement explicitly before approving it.',
        409,
        {
          contextVersion: decisionContextVersion(record),
          alternatives: storedConflict?.alternatives ?? [],
        },
      );
    }
    revalidateDecisionContext(record, decisionContextVersion(record) ?? undefined, {
      confirmationGranted: true,
      replacementApproved: input.replacementChoiceId === 'replace_with_candidate',
    });
  }
  const reasonCode = normalizeClosedReasonCode(input.reasonCode);
  const nextState: DurableDecisionState = input.outcome === 'approve'
    ? 'approved'
    : input.outcome === 'reject'
      ? 'rejected'
      : 'deferred';
  const deferUntil = input.outcome === 'defer'
    ? normalizeFutureTimestamp(input.deferUntil) ?? DateTime.utc().plus({ days: 1 }).toISO()
    : null;
  const nextLegacyStatus = input.outcome === 'reject' ? 'dismissed'
    : input.outcome === 'defer' ? 'snoozed'
      : record.status === 'unread' ? 'read' : record.status;

  getDb().transaction(() => {
    const update = getDb().prepare(`
      UPDATE notification_center_items
         SET decision_state = ?,
             status = ?,
             snoozed_until = CASE WHEN ? = 'deferred' THEN ? ELSE snoozed_until END,
             dismissed_at = CASE WHEN ? = 'rejected' THEN datetime('now') ELSE dismissed_at END,
             record_version = record_version + 1,
             updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(
      nextState,
      nextLegacyStatus,
      nextState,
      deferUntil,
      nextState,
      decisionId,
      userId,
      tenantId,
      expectedVersion,
    );
    if (update.changes !== 1) {
      const current = getDecisionRecord(decisionId, userId, tenantId);
      throw new DecisionActionError(
        'DECISION_VERSION_CONFLICT',
        'Decision changed before the review was recorded.',
        409,
        decisionVersionConflictDetails(current),
      );
    }
    getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `dle_${randomUUID()}`,
      decisionId,
      userId,
      tenantId,
      input.outcome === 'approve' ? 'approved' : input.outcome === 'reject' ? 'rejected' : 'deferred',
      nextState,
      `review:${reviewAttemptHash}`,
      reasonCode,
      JSON.stringify({
        previousVersion: expectedVersion,
        nextVersion: expectedVersion + 1,
        contextVersion: decisionContextVersion(record),
        replacementChoiceId: input.replacementChoiceId ?? null,
        confirmationStrength: approvalLevel === 'strong_confirmation' ? 'strong' : 'standard',
      }),
    );
    if (input.outcome === 'reject'
        && record.sourceSkill === 'training'
        && record.relatedEntityType === 'training_plan_revision'
        && record.relatedEntityId
        && tableExists('training_plan_revisions')) {
      getDb().prepare(`
        UPDATE training_plan_revisions
           SET lifecycle_state = 'EXPIRED', approval_state = 'REJECTED',
               expired_at = datetime('now')
         WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
           AND decision_id = ? AND lifecycle_state = 'PENDING_REVIEW'
           AND approval_state = 'PENDING'
      `).run(record.relatedEntityId, userId, tenantId, decisionId);
    }
    syncTrainingAdaptationProposalForDecisionState(
      getDb(),
      decisionId,
      userId,
      tenantId,
      input.outcome === 'reject' ? 'REJECTED' : input.outcome === 'defer' ? 'DEFERRED' : 'PENDING_REVIEW',
    );
  })();

  const updated = getDecisionRecord(decisionId, userId, tenantId);
  if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after review', 500);
  resolveDecisionConflictAudit(decisionId, userId, tenantId, `review_${input.outcome}`);
  return formatDecisionItemForApi(updated);
}

export function reviseDecisionProposal(
  decisionId: string,
  userId: number,
  tenantId: number,
  input: { expectedVersion?: number; recommendedStartAt?: string; recommendedEndAt?: string },
): DecisionApiItem {
  assertScope(userId, tenantId, 'revise_decision_proposal', { decisionId });
  ensureDecisionCenterTables();
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!(record && decisionFlowV1EnforcedForRecord(record))) {
    throw new DecisionActionError('DECISION_EDIT_UNAVAILABLE', 'Versioned proposal editing is not enabled for this account.', 409);
  }
  guardDecisionLifecycleMutation(record, 'edit_proposal');
  if (input.expectedVersion == null) {
    throw new DecisionActionError('DECISION_VERSION_REQUIRED', 'Proposal edits require the current record version', 428);
  }
  validateExpectedDecisionVersion(record, input.expectedVersion, true);
  guardActionable(record, 'edit_proposal');

  const context = decisionContextForRecord(record);
  const action = normalizeDecisionAction(context.normalizedAction);
  if (!action) throw new DecisionActionError('DECISION_EDIT_UNSUPPORTED', 'This proposal does not support structured edits.', 409);
  if (editableProposalFieldsForRecord(record).length === 0) {
    throw new DecisionActionError(
      'DECISION_EDIT_UNSUPPORTED',
      'This proposal type is not allowlisted for structured edits.',
      409,
    );
  }
  const start = normalizeTimestamp(input.recommendedStartAt ?? context.recommendedStartAt);
  const end = normalizeTimestamp(input.recommendedEndAt ?? context.recommendedEndAt);
  if (!start || !end || Date.parse(start) >= Date.parse(end)) {
    throw new DecisionActionError('DECISION_EDIT_INVALID', 'Proposal edit requires a valid start and end window.', 400);
  }
  const contextVersion = `ctx_revision_${input.expectedVersion + 1}_${Date.now()}`;
  const revisedAction = buildNormalizedDecisionAction({
    intent: action.intent,
    targetEntities: action.targetEntities,
    affectedResources: action.affectedResources,
    requestedWindow: { start, end, timezone: action.requestedWindow?.timezone ?? context.timezone ?? 'UTC' },
    preconditions: action.preconditions,
    expectedEffects: action.expectedEffects,
    prohibitedEffects: action.prohibitedEffects,
    dependencies: action.dependencies,
    exclusivityKeys: action.exclusivityKeys,
    authorizationScope: action.authorizationScope,
    risk: action.risk,
    reversibility: action.reversibility,
    contextVersion,
  });
  const conflictMode = getDecisionConflictPolicyV1Mode(process.env, { userId, tenantId });
  const flowEnforced = decisionFlowV1EnforcedForRecord(record);
  const revisedRevalidation = conflictMode === 'off' && !flowEnforced ? null : revalidateNormalizedDecisionAction({
    scope: { userId, tenantId },
    action: revisedAction,
    decisionId,
    additionalExisting: context.conflictComparisons ?? undefined,
    contextExpiresAt: decisionContextExpiresAt(record),
    candidateCreatedAt: appNowIso(),
    confidence: context.candidateConfidence ?? undefined,
  });
  const revisedConflict = revisedRevalidation?.conflictEvaluation ?? null;
  const nextDecisionState = conflictMode === 'active' || flowEnforced
    ? decisionStateForConflictEvaluation(revisedConflict)
    : 'ready_for_review';
  const revisedContext: DecisionLogicContext = {
    ...context,
    recommendedStartAt: start,
    recommendedEndAt: end,
    normalizedAction: revisedAction,
    conflictEvaluation: conflictMode === 'active' || flowEnforced ? revisedConflict : null,
    reasonCodes: [...new Set([...(context.reasonCodes ?? []), 'user_revised_proposal'])],
  };

  getDb().transaction(() => {
    const update = getDb().prepare(`
      UPDATE notification_center_items
         SET decision_state = ?,
             status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
             record_version = record_version + 1,
             updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(nextDecisionState, decisionId, userId, tenantId, input.expectedVersion);
    if (update.changes !== 1) {
      const current = getDecisionRecord(decisionId, userId, tenantId);
      throw new DecisionActionError(
        'DECISION_VERSION_CONFLICT',
        'Decision changed before the proposal edit was saved.',
        409,
        decisionVersionConflictDetails(current),
      );
    }
    const intentUpdate = getDb().prepare(`
      UPDATE notification_intents
         SET decision_context_json = ?, context_version = ?, context_observed_at = ?,
             candidate_fingerprint = ?, normalized_action_json = ?
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
    `).run(
      JSON.stringify(revisedContext),
      contextVersion,
      appNowIso(),
      revisedAction.candidateFingerprint,
      JSON.stringify(revisedAction),
      record.intentId,
      userId,
      tenantId,
    );
    if (intentUpdate.changes !== 1) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Proposal source row was not updated.', 409);
    }
  })();
  emitDecisionLifecycleEvent({
    decisionId,
    userId,
    tenantId,
    event: 'revised',
    toStatus: nextDecisionState,
    metadata: { previousVersion: input.expectedVersion, nextVersion: input.expectedVersion + 1, fields: ['recommended_window'] },
  });
  resolveDecisionConflictAudit(decisionId, userId, tenantId, 'proposal_revised');
  if (revisedConflict) recordDecisionConflictEvaluation(record, revisedConflict);
  const updated = getDecisionRecord(decisionId, userId, tenantId);
  if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after proposal edit', 500);
  return formatDecisionItemForApi(updated);
}

function editableProposalFieldsForRecord(record: DecisionRecord): string[] {
  const context = decisionContextForRecord(record);
  const action = normalizeDecisionAction(context.normalizedAction);
  if (!action || approvalLevelForRecord(record) === 'none') return [];
  const editableSecretaryReflow = record.sourceSkill === 'secretary'
    && record.relatedEntityType === 'secretary_agenda_item'
    && context.recipe === 'secretary_reflow_window_v1'
    && action.requestedWindow != null
    && action.affectedResources.some((resource) => resource.type === 'calendar_timeline')
    && /reflow|reschedule/.test(action.intent);
  return editableSecretaryReflow ? ['recommendedStartAt', 'recommendedEndAt'] : [];
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeFutureTimestamp(value: unknown): string | null {
  const normalized = normalizeTimestamp(value);
  return normalized && Date.parse(normalized) > Date.now() ? normalized : null;
}

function normalizeClosedReasonCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : 'other';
}

export function snoozeDecision(
  decisionId: string,
  userId: number,
  tenantId = userId,
  minutes = 60,
  expectedVersion?: number,
  activeExecution?: { actionId: string; idempotencyKey: string },
): DecisionApiItem {
  assertScope(userId, tenantId, 'snooze_decision', { decisionId });
  ensureDecisionCenterTables();
  const before = getDecisionRecord(decisionId, userId, tenantId);
  if (!before) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  guardDecisionLifecycleMutation(before, 'snooze', { allowExecution: activeExecution });
  validateExpectedDecisionVersion(before, expectedVersion, true);
  const until = DateTime.utc().plus({ minutes: Math.min(Math.max(minutes, 5), 10_080) }).toISO();
  const update = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'snoozed', decision_state = 'deferred', snoozed_until = ?,
           read_at = COALESCE(read_at, datetime('now')),
           record_version = record_version + 1, updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND record_version = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(until, decisionId, userId, tenantId, expectedVersion ?? before.recordVersion);
  if (update.changes !== 1) {
    const current = getDecisionRecord(decisionId, userId, tenantId);
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision changed before it could be snoozed.',
      409,
      decisionVersionConflictDetails(current),
    );
  }
  syncTrainingAdaptationProposalForDecisionState(
    getDb(), decisionId, userId, tenantId, 'DEFERRED',
  );
  const item = getDecisionItem(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after snooze', 404);
  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'snoozed', toStatus: item.status });
  resolveDecisionConflictAudit(decisionId, userId, tenantId, 'deferred');
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (record) {
    recordDecisionOutcome(record, {
      actionShown: 'snooze',
      actionTaken: 'snooze',
      snoozed: true,
      actionSucceeded: true,
      timeToActionMs: timeToActionMs(record),
    });
  }
  return item;
}

/** Closed vocabulary for dismiss feedback (C3) — never store free user text; unknown → 'other'. */
export const DECISION_DISMISS_REASONS = ['already_handled', 'not_relevant', 'wrong_data', 'bad_timing', 'too_risky', 'duplicate', 'dont_show_type', 'other'] as const;
export type DecisionDismissReason = typeof DECISION_DISMISS_REASONS[number];

function normalizeDismissReason(reason?: string | null): DecisionDismissReason | null {
  if (reason == null || reason.trim() === '') return null;
  const value = reason.trim().toLowerCase();
  return (DECISION_DISMISS_REASONS as readonly string[]).includes(value) ? (value as DecisionDismissReason) : 'other';
}

export function dismissDecision(
  decisionId: string,
  userId: number,
  tenantId = userId,
  reason?: string,
  expectedVersion?: number,
  activeExecution?: { actionId: string; idempotencyKey: string },
): DecisionApiItem {
  const before = getDecisionRecord(decisionId, userId, tenantId);
  if (!before) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  guardDecisionLifecycleMutation(before, 'dismiss', { allowExecution: activeExecution });
  validateExpectedDecisionVersion(before, expectedVersion, true);
  if (!['unread', 'read', 'failed', 'snoozed'].includes(before.status)) {
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision is no longer in a dismissible state.',
      409,
      decisionVersionConflictDetails(before, { currentStatus: before.status }),
    );
  }
  const stateUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'dismissed', dismissed_at = datetime('now'),
           decision_state = 'rejected', record_version = record_version + 1,
           updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND record_version = ?
  `).run(decisionId, userId, tenantId, expectedVersion ?? before.recordVersion);
  if (stateUpdate.changes !== 1) {
    const current = getDecisionRecord(decisionId, userId, tenantId);
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision changed before it could be dismissed.',
      409,
      decisionVersionConflictDetails(current),
    );
  }
  expireTrainingPlanRevisionForDecision(getDb(), decisionId, userId, tenantId, 'REJECTED');
  const dismissedRecord = getDecisionRecord(decisionId, userId, tenantId);
  const decision = dismissedRecord ? formatDecisionItemForApi(dismissedRecord) : null;
  if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after dismiss', 404);
  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'dismissed', toStatus: decision.status, reason: normalizeDismissReason(reason) });
  resolveDecisionConflictAudit(decisionId, userId, tenantId, 'rejected');
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (record) {
    recordDecisionOutcome(record, {
      actionShown: 'dismiss',
      actionTaken: 'dismiss',
      dismissed: true,
      actionSucceeded: true,
      timeToActionMs: timeToActionMs(record),
    });
  }
  return decision;
}

export function markDecisionViewed(decisionId: string, userId: number, tenantId = userId): DecisionApiItem {
  const item = markNotificationCenterItemRead(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  const decision = getDecisionItem(decisionId, userId, tenantId);
  if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after viewed', 404);
  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'detail_opened', toStatus: decision.status });
  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'viewed', toStatus: decision.status });
  return decision;
}

export function getDecisionPreferences(userId: number, tenantId = userId): Record<string, unknown> {
  assertScope(userId, tenantId, 'get_decision_preferences');
  ensureDecisionCenterTables();
  const profile = getNotificationProfileIfExists(userId, tenantId) ?? defaultDecisionNotificationProfile(userId, tenantId);
  const flow = getDb().prepare(`
    SELECT allow_low_risk_auto_reflow AS allowLowRiskAutoReflow
      FROM decision_flow_preferences
     WHERE user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(userId, tenantId) as { allowLowRiskAutoReflow: number } | undefined;
  return {
    profile,
    decisionPreferences: {
      homePreviewMode: 'urgent_and_today',
      autoHideResolved: true,
      askBeforeScheduleChanges: true,
      askBeforeContentPublishing: true,
      askBeforeTrainingReflow: true,
      pushEnabled: profile.pushEnabled,
      urgentDecisionPushEnabled: profile.allowTimeSensitive,
      timeSensitiveAllowed: profile.allowTimeSensitive,
      backgroundRefreshPushEnabled: profile.pushEnabled,
      allowLowRiskAutoReflow: flow?.allowLowRiskAutoReflow === 1,
    },
  };
}

function defaultDecisionNotificationProfile(userId: number, tenantId: number): NotificationProfile {
  const now = appNowIso();
  return {
    userId,
    tenantId,
    quietHours: { start: '22:00', end: '07:00' },
    timezone: userDecisionContextDefaults(userId).timezone || 'UTC',
    pushEnabled: true,
    // Promotional consent defaults OFF even in the read-side fallback, so a
    // missing profile row can never be read as marketing consent.
    marketingPushEnabled: false,
    localEnabled: true,
    emailEnabled: false,
    portalEnabled: true,
    inAppEnabled: true,
    skillPreferences: {
      secretary: true,
      training: true,
      content: true,
      cooking: true,
      finance: true,
      chat: true,
      system: true,
      security: true,
    },
    defaultReminderMinutes: 30,
    workoutReminderMinutes: 60,
    contentReminderMinutes: 120,
    financeReminderDays: 1,
    allowTimeSensitive: true,
    allowCritical: false,
    digestPassiveItems: true,
    dailyDigestTime: '08:30',
    weeklyReviewDay: 1,
    weeklyReviewTime: '09:00',
    morningBriefingTime: null,
    coachBriefingTime: null,
    endOfDayTime: null,
    weeklyReviewReportDay: null,
    weeklyReviewReportTime: null,
    doNotNotifyRules: [],
    updatedAt: now,
    createdAt: now,
  };
}

export function updateDecisionPreferences(userId: number, tenantId: number, patch: Record<string, unknown>): Record<string, unknown> {
  assertScope(userId, tenantId, 'update_decision_preferences');
  ensureDecisionCenterTables();
  const { allowLowRiskAutoReflow, ...profilePatch } = patch;
  if (allowLowRiskAutoReflow !== undefined && typeof allowLowRiskAutoReflow !== 'boolean') {
    throw new DecisionActionError('VALIDATION', 'allowLowRiskAutoReflow must be a boolean', 400);
  }
  if (typeof allowLowRiskAutoReflow === 'boolean') {
    getDb().prepare(`
      INSERT INTO decision_flow_preferences
        (user_id, tenant_id, allow_low_risk_auto_reflow, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, tenant_id) DO UPDATE SET
        allow_low_risk_auto_reflow = excluded.allow_low_risk_auto_reflow,
        updated_at = excluded.updated_at
    `).run(userId, tenantId, allowLowRiskAutoReflow ? 1 : 0);
  }
  if (Object.keys(profilePatch).length > 0) updateNotificationProfile(userId, tenantId, profilePatch);
  else getOrCreateNotificationProfile(userId, tenantId);
  return getDecisionPreferences(userId, tenantId);
}

function decisionOutcomeFlagsForAction(
  actionId: string,
  action: NotificationActionButton,
): Pick<Parameters<typeof recordDecisionOutcome>[1], 'accepted' | 'dismissed' | 'snoozed' | 'askedNexus'> {
  if (actionId === 'open_detail') return { askedNexus: true };
  if (actionId === 'dismiss' || actionId === 'reject_reflow' || actionId === 'not_now') {
    return { dismissed: true };
  }
  if (actionId === 'snooze') return { snoozed: true };
  return { accepted: action.style === 'primary' };
}

export class DecisionActionError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DecisionActionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assertDecisionScopedUpdateApplied(
  result: { changes: number },
  operation: string,
  details: Record<string, unknown>,
): void {
  if (result.changes > 0) return;
  throw new DecisionActionError(
    'DECISION_READBACK_MISMATCH',
    'Decision scoped update did not affect any rows',
    409,
    { operation, ...details },
  );
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function isDecisionRecord(item: DecisionRecord): boolean {
  const eligibility = evaluateDecisionEligibility({
    sourceSkill: item.sourceSkill,
    type: item.type,
    priority: item.priority,
    requiresUserAction: item.requiresUserAction,
    actionButtons: item.actions,
    deliveryPolicy: item.deliveryPolicy,
  });
  return eligibility.classification === 'decision';
}

function urgencyForPriority(priority: NotificationPriority, deadlineAt?: string | null, expiresAt?: string | null): DecisionUrgency {
  if (priority === 'critical' || priority === 'time_sensitive') return 'urgent';
  const deadline = deadlineAt ?? expiresAt;
  if (deadline) {
    const ms = Date.parse(deadline);
    if (Number.isFinite(ms) && ms - Date.now() <= 24 * 3_600_000) return 'today';
  }
  if (priority === 'active') return 'today';
  return 'optional';
}

function isVisiblePushEligible(priority: NotificationPriority, type: NotificationIntentType, requiresUserAction: boolean): boolean {
  if (!requiresUserAction) return false;
  if (priority === 'passive') return false;
  return type === 'conflict_detected'
    || type === 'approval_required'
    || type === 'sync_failure'
    || type === 'security_account'
    || priority === 'time_sensitive'
    || priority === 'critical';
}

function priorityScoreFor(item: DecisionRecord): number {
  const logic = decisionLogicForRecord(item);
  const ranked = rankDecision(decisionLogicInputForRecord(item), logic, logic.quality);
  if (ranked.priorityScore > 0) return ranked.priorityScore;
  const urgencyScore = item.priority === 'critical' ? 100 : item.priority === 'time_sensitive' ? 90 : item.priority === 'active' ? 70 : 35;
  const deadline = item.decisionDeadline ?? item.expiresAt;
  const deadlineBoost = deadline && Date.parse(deadline) - Date.now() <= 24 * 3_600_000 ? 10 : 0;
  return urgencyScore + deadlineBoost;
}

function compareDecisionApiItemsByRank(a: DecisionApiItem, b: DecisionApiItem): number {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  const aDeadline = Date.parse(a.deadlineAt ?? a.expiresAt ?? a.createdAt);
  const bDeadline = Date.parse(b.deadlineAt ?? b.expiresAt ?? b.createdAt);
  const safeADeadline = Number.isFinite(aDeadline) ? aDeadline : Number.MAX_SAFE_INTEGER;
  const safeBDeadline = Number.isFinite(bDeadline) ? bDeadline : Number.MAX_SAFE_INTEGER;
  if (safeADeadline !== safeBDeadline) return safeADeadline - safeBDeadline;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function materializeDecisionPriorityScore(item: DecisionRecord, priorityScore: number): void {
  if (item.priorityScore === priorityScore) return;
  try {
    const result = getDb().prepare(`
      UPDATE notification_center_items
         SET priority_score = ?
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).run(priorityScore, item.itemId, item.userId, item.tenantId);
    assertScopedMutation(result, 'materialize_decision_priority_score', {
      itemId: item.itemId,
      userId: item.userId,
      tenantId: item.tenantId,
    });
    item.priorityScore = priorityScore;
  } catch (error) {
    logger.warn?.({ error, itemId: item.itemId }, 'Failed to materialize Decision Center priority score');
  }
}

function assertScopedMutation(
  result: { changes?: number | bigint },
  operation: string,
  details: { itemId: string; userId: number; tenantId: number },
): void {
  if (Number(result.changes ?? 0) === 1) return;
  recordTenantScopeAnomaly({
    layer: 'orchestration',
    operation,
    reason: 'invalid_user_scope',
    userId: isValidTenantUserId(details.userId) ? details.userId : null,
    details,
  });
  throw new DecisionActionError('INVALID_SCOPE', 'Scoped mutation did not affect the expected decision row', 404, details);
}

function formatDecisionItemForApi(
  item: DecisionRecord,
  opts: { materializePriorityScore?: boolean } = {},
): DecisionApiItem {
  const logic = decisionLogicForRecord(item);
  const structuredContext = decisionContextForRecord(item);
  const safeTitle = logic.safePreviewTitle || safeTitleForItem(item);
  const actions = actionsForRecord(item);
  const dependencies = dependencyStateForRecord(item);
  const action = recommendedAction(actions);
  const urgency = urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt);
  const outcome = outcomeSummaryForRecord(item, logic);
  const riskLevel = riskLevelForItem(item);
  const sectionKey = sectionKeyForRecord(item, urgency, logic);
  const rollback = rollbackContractForRecord(item);
  const exposeDebugEvidence = shouldExposeDecisionDebugEvidence(item);
  const visibleWhatWillChange = userVisibleWhatWillChangeForApi(item, logic);
  const execution = executionSummaryForRecord(item);
  const effectiveStatus = computeEffectiveStatus(item, {
    dependencies,
    logic,
    retryAvailable: outcome.retryActions.length > 0 || execution.recoveryActions.length > 0,
    executionStatus: execution.status,
  });
  const decisionKind = computeDecisionKind(item, logic, dependencies, action);
  let actionability = computeActionability(item, logic, effectiveStatus, action);
  if (durableDecisionStateForRecord(item) === 'blocked') actionability = 'blocked';
  if (isSecretaryReviewOnlyPreview(item, structuredContext.normalizedAction ?? null)) actionability = 'read_only';
  if (execution.status === 'started' || execution.status === 'partially_failed') actionability = 'blocked';
  const rankDeadline = item.decisionDeadline ?? item.expiresAt;
  const prioritySnapshot = rankDecisionPriority({
    priority: item.priority,
    sourceSkill: item.sourceSkill,
    type: item.type,
    status: item.status,
    deadlineSoon: !!rankDeadline && Number.isFinite(Date.parse(rankDeadline)) && Date.parse(rankDeadline) - Date.now() <= 24 * 3_600_000,
    riskLevel,
    actionCount: actions.length,
    dependencyBlocked: dependencies.blockedByDecisionIds.length > 0,
  });
  const priorityScore = priorityScoreFor(item);
  if (opts.materializePriorityScore === true) {
    materializeDecisionPriorityScore(item, priorityScore);
  }
  const analysisBundle = analysisForRecord(item, logic);
  // F2: gate actionability on stale evidence (flag-gated; only lowers write-capable actionability so the
  // client offers Refresh instead of acting on stale data). OFF or fresh => unchanged.
  if (analysisBundle.sourceFreshness === 'stale'
      && isDecisionEvidenceFreshnessGateEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })) {
    actionability = gateActionabilityForStaleEvidence(actionability);
  }
  // F human-review fallback: a requires_human_review decision with no live review queue is gated to
  // unavailable (manual-only). Composes AFTER F2; both only ever lower. OFF/no-review-value => unchanged.
  if (isDecisionHumanReviewGateEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })) {
    actionability = gateActionabilityForHumanReview(actionability, isHumanReviewQueueAvailable(process.env));
  }
  const confidenceExplanation = computeConfidenceExplanation(logic.confidence, logic.why, analysisBundle, exposeDebugEvidence);
  const conflictPolicyActive = isDecisionConflictPolicyV1Enabled(process.env, { userId: item.userId, tenantId: item.tenantId })
    || decisionFlowV1EnforcedForRecord(item);
  const conflictSummary = conflictPolicyActive
    ? buildDecisionConflictSummary(structuredContext.conflictEvaluation, structuredContext.locale)
    : null;
  const requiredPermissions = requiredPermissionsForRecord(item);
  const approvalLevel = approvalLevelForRecord(item);
  const normalizedAction = normalizeDecisionAction(structuredContext.normalizedAction);
  const reviewSupported = reviewSupportedForRecord(item, normalizedAction, approvalLevel);
  const editableProposalFields = reviewSupported ? editableProposalFieldsForRecord(item) : [];
  const mutualExclusionGroupId = conflictPolicyActive
    ? mutualExclusionGroupIdForRecord(item, structuredContext.conflictEvaluation)
    : null;
  return {
    decisionId: item.itemId,
    itemId: item.itemId,
    id: item.itemId,
    intentId: item.intentId,
    decisionLogId: item.decisionLogId,
    userId: item.userId,
    tenantId: item.tenantId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    status: item.status,
    lifecycleStatus: legacyStatusToLifecycle(item.status),
    actionOutcomeStatus: execution.status === 'none' ? actionOutcomeFromRecord(item) : execution.status,
    effectiveStatus,
    actionEffectiveStatuses: actions.map((candidate) => computeActionEffectiveStatus(item, candidate, {
      dependencies,
      logic,
      reconnectAffordance: isDecisionReconnectAffordanceEnabled(process.env, { userId: item.userId, tenantId: item.tenantId }),
      executionStatus: execution.status,
    })),
    decisionKind,
    actionability,
    prioritySnapshot,
    urgency,
    timingLabel: timingLabelForRecord(item, urgency),
    priorityScore,
    title: logic.title,
    summary: logic.problemStatement,
    deeplink: item.deeplink,
    safePreviewTitle: safeTitle,
    safePreviewBody: logic.safePreviewBody || item.safeBody,
    recommendedActionLabel: logic.primaryActionLabel || (action?.label ?? null),
    recommendedAction: action,
    alternativeActions: actions.filter((candidate) => candidate.id !== action?.id),
    whySummary: logic.whySummary,
    whyDetails: exposeDebugEvidence ? whyDetailsForItem(item, logic) : [],
    explanation: explanationForDecisionItem(item, logic),
    problemStatement: logic.problemStatement,
    recommendation: logic.recommendation,
    expectedEffect: logic.expectedEffect,
    impactIfIgnored: logic.impactIfIgnored,
    impactLevel: riskLevel,
    primaryActionLabel: logic.primaryActionLabel,
    secondaryActionLabels: logic.secondaryActionLabels,
    urgencyReason: logic.urgencyReason,
    why: exposeDebugEvidence ? logic.why : emptyDecisionWhy(),
    actionPreview: visibleWhatWillChange,
    whatWillChange: visibleWhatWillChange,
    alternatives: alternativesForRecord(item, logic, actions),
    options: isDecisionChoiceOptionsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildSecretaryChoiceOptions(item, logic)
      : undefined,
    contentCard: isDecisionSkillCardsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildContentDecisionCard(item, logic, action)
      : undefined,
    trainingCard: isDecisionSkillCardsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildTrainingDecisionCard(item, rollback)
      : undefined,
    financeCard: isDecisionSkillCardsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildFinanceDecisionCard(item, logic, analysisBundle, action)
      : undefined,
    automationEligibility: logic.automationEligibility,
    autopilotPolicy: logic.autopilotPolicy,
    readBackVerifier: exposeDebugEvidence ? logic.readBackVerifier : null,
    handledByNexus: false,
    handledAt: null,
    outcomeSummary: outcome.outcomeSummary,
    failureReason: outcome.failureReason,
    retryActions: outcome.retryActions,
    notificationEligibility: logic.notificationEligibility,
    apnsInterruptionLevel: logic.apnsInterruptionLevel,
    collapseKey: logic.collapseKey,
    badgeContribution: logic.badgeContribution,
    quality: logic.quality,
    relatedEntities: item.relatedEntityId && item.relatedEntityType
      ? [{ type: item.relatedEntityType, id: item.relatedEntityId }]
      : [],
    relatedEntitiesSafe: relatedEntitiesSafeForRecord(item, logic),
    sourceTraceSummary: exposeDebugEvidence ? sourceTraceSummaryForRecord(item, logic) : null,
    sourceTrace: exposeDebugEvidence ? sourceTraceForRecord(item, logic) : null,
    dependencyGraphSummary: dependencyGraphSummaryForRecord(dependencies, userDecisionContextDefaults(item.userId).locale),
    actionTruthTableEntry: exposeDebugEvidence && action ? actionTruthTableEntryForRecord(item, action, logic, rollback) : null,
    askNexusContext: null,
    deadlineAt: item.decisionDeadline,
    expiresAt: item.expiresAt,
    confidence: logic.confidence,
    analysis: analysisBundle,
    confidenceExplanation,
    ...(conflictSummary ? { conflictSummary } : {}),
    ...(structuredContext.normalizedAction?.contextVersion
      ? { contextVersion: structuredContext.normalizedAction.contextVersion }
      : {}),
    ...(item.contextObservedAt ? { contextObservedAt: item.contextObservedAt } : {}),
    contextFreshness: analysisBundle.sourceFreshness,
    ...(mutualExclusionGroupId ? { mutualExclusionGroupId } : {}),
    ...(item.supersededByItemId ? { supersededByDecisionId: item.supersededByItemId } : {}),
    requiredPermissions,
    approvalLevel,
    reviewSupported,
    editableProposalFields,
    reversibility: normalizedAction?.reversibility ?? null,
    execution,
    refreshSupported: decisionRefreshSupportedForRecord(item),
    recordVersion: item.recordVersion,
    decisionState: durableDecisionStateForRecord(item),
    riskLevel,
    groupKey: groupKeyForRecord(item),
    sectionKey,
    displayMode: displayModeForRecord(item, logic),
    frontendActionState: frontendActionStateForRecord(item, logic, dependencies, action),
    privacyClassification: item.privacyPolicy,
    visibilityScope: visibilityScopeForItem(item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    snoozedUntil: item.snoozedUntil,
    actions,
    dependsOnDecisionIds: dependencies.dependsOnDecisionIds,
    relationships: dependencies.relationships,
    blockedByDecisionIds: dependencies.blockedByDecisionIds,
    rollbackAvailable: rollback.available,
    rollbackActionId: rollback.actionId,
  };
}

function mutualExclusionGroupIdForRecord(
  record: DecisionRecord,
  evaluation: ConflictEvaluation | null | undefined,
): string | null {
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  if (!action || action.exclusivityKeys.length === 0 || !evaluation) return null;
  const groupingConflict = evaluation.findings.some((finding) =>
    finding.class === 'mutually_exclusive_effects'
      || finding.class === 'time_overlap'
      || finding.class === 'resource_competition'
      || finding.class === 'concurrent_mutation');
  if (!groupingConflict) return null;
  const digest = createHash('sha256')
    .update(JSON.stringify({
      tenantId: record.tenantId,
      userId: record.userId,
      exclusivityKeys: [...action.exclusivityKeys].sort(),
    }))
    .digest('hex')
    .slice(0, 24);
  return `mxg_${digest}`;
}

function formatDecisionItemForApiWithExposure(
  item: DecisionRecord,
  opts: { recordExposure?: boolean; materializePriorityScore?: boolean } = {},
): DecisionApiItem {
  const apiItem = formatDecisionItemForApi(item, { materializePriorityScore: opts.materializePriorityScore });
  if (opts.recordExposure === true) recordDecisionExposure(item, apiItem);
  return apiItem;
}

function displayModeForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionFrontendDisplayMode {
  if (!logic.quality.safeToShowUser) return 'details_unavailable';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'actioned') return 'handled';
  if (item.status === 'superseded' || item.status === 'dismissed') return 'handled';
  if (item.type === 'sync_failure') return 'waiting_on_system';
  return 'needs_input';
}

function frontendActionStateForRecord(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  dependencies: { blockedByDecisionIds: string[] },
  action: NotificationActionButton | null = recommendedAction(actionsForRecord(item)),
): DecisionFrontendActionState {
  if (!logic.quality.safeForFrontendAction) return 'disabled_missing_details';
  if (!action || !isDecisionActionExecutable(action.id)) return 'disabled_missing_details';
  if (item.status === 'expired') return 'disabled_expired';
  if (item.status === 'superseded' || item.status === 'dismissed' || item.status === 'actioned') return 'disabled_superseded';
  if (durableDecisionStateForRecord(item) === 'blocked') return 'disabled_missing_details';
  if (dependencies.blockedByDecisionIds.length > 0) return 'disabled_missing_details';
  return 'enabled';
}

function safeTitleForItem(item: DecisionRecord): string {
  if (item.privacyPolicy === 'financial' || item.sourceSkill === 'finance') return 'Finance decision';
  if (item.privacyPolicy === 'health' || item.sourceSkill === 'training') return item.type === 'decision_required' ? 'Training decision' : 'Training update';
  if (item.privacyPolicy === 'private_content' || item.sourceSkill === 'content') return 'Content review';
  if (item.privacyPolicy === 'sensitive') return sourceLabel(item.sourceSkill);
  return item.title;
}

function shouldExposeDecisionDebugEvidence(item: DecisionRecord): boolean {
  void item;
  return process.env.DECISION_CENTER_DEBUG_EVIDENCE === '1';
}

function emptyDecisionWhy(): DecisionWhy {
  return {
    facts: [],
    preferences: [],
    rules: [],
    tradeoffs: [],
    uncertainty: [],
  };
}

function userVisibleWhatWillChangeForApi(item: DecisionRecord, logic: DecisionLogicV2): DecisionWhatWillChange[] {
  if (logic.whatWillChange.length === 0) return [];
  return logic.whatWillChange.slice(0, 3).map((change) => ({
    ...change,
    verificationMethod: openVerificationTextForRecord(item, logic),
  }));
}

function whyDetailsForItem(item: DecisionRecord, logic: DecisionLogicV2): Array<{ label: string; value: string }> {
  const details = [
    { label: 'Source', value: sourceLabel(item.sourceSkill) },
    { label: 'Recommendation', value: logic.recommendation },
    { label: 'Expected effect', value: logic.expectedEffect },
    { label: 'Rule', value: logic.why.rules[0] ?? 'Decision Center only shows items that require user judgment or approval.' },
  ];
  for (const fact of logic.why.facts.slice(0, 3)) {
    details.push({ label: 'Fact', value: fact });
  }
  for (const tradeoff of logic.why.tradeoffs.slice(0, 2)) {
    details.push({ label: 'Tradeoff', value: tradeoff });
  }
  if (item.decisionDeadline) {
    details.push({ label: 'Deadline', value: item.decisionDeadline });
  }
  if (item.privacyPolicy !== 'public') {
    details.push({ label: 'Privacy', value: 'Home and notifications use a safe preview; details require authenticated access.' });
  }
  return details;
}

function timingLabelForRecord(item: DecisionRecord, urgency: DecisionUrgency): string | null {
  const timestamp = item.decisionDeadline ?? item.expiresAt ?? null;
  if (!timestamp) {
    if (urgency === 'urgent') return 'Urgent';
    if (urgency === 'today') return 'Today';
    if (urgency === 'this_week') return 'This week';
    return null;
  }
  const parsed = DateTime.fromISO(timestamp, { zone: 'utc' });
  if (!parsed.isValid) return urgency === 'urgent' ? 'Urgent' : null;
  const now = DateTime.utc();
  if (parsed.hasSame(now, 'day')) return 'Today';
  if (parsed.hasSame(now.plus({ days: 1 }), 'day')) return 'Tomorrow';
  if (parsed <= now.plus({ days: 7 })) return 'This week';
  return parsed.toFormat('LLL d');
}

function sectionKeyForRecord(item: DecisionRecord, urgency: DecisionUrgency, logic: DecisionLogicV2): DecisionTimelineSectionKey {
  const displayMode = displayModeForRecord(item, logic);
  if (displayMode === 'waiting_on_system') return 'waiting_on_systems';
  if (displayMode === 'handled' || item.status === 'actioned' || item.status === 'superseded' || item.status === 'dismissed') return 'handled';
  if (urgency === 'urgent') return 'urgent';
  const timestamp = item.decisionDeadline ?? item.expiresAt ?? null;
  if (timestamp) {
    const parsed = DateTime.fromISO(timestamp, { zone: 'utc' });
    if (parsed.isValid) {
      const now = DateTime.utc();
      if (parsed.hasSame(now, 'day')) return 'today';
      if (parsed.hasSame(now.plus({ days: 1 }), 'day')) return 'tomorrow';
      if (parsed <= now.plus({ days: 7 })) return 'this_week';
    }
  }
  if (urgency === 'today') return 'today';
  return 'this_week';
}

function groupKeyForRecord(item: DecisionRecord): string {
  if (item.relatedEntityType && item.relatedEntityId) return `${item.sourceSkill}:${item.relatedEntityType}:${item.relatedEntityId}`;
  return `${item.sourceSkill}:${item.type}:${item.dedupeKey ?? item.itemId}`;
}

function alternativesForRecord(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  actions: NotificationActionButton[],
): DecisionAlternativeOption[] {
  const alternatives: DecisionAlternativeOption[] = [];
  const primary = recommendedAction(actions);
  if (primary) {
    alternatives.push({
      id: `${item.itemId}:recommended`,
      label: logic.primaryActionLabel || primary.label,
      rank: 'best',
      reason: logic.whySummary,
      actionId: primary.id,
      available: frontendActionStateForRecord(item, logic, dependencyStateForRecord(item), primary) === 'enabled',
      source: 'recipe',
    });
  }
  for (const action of actions.filter((candidate) => candidate.id !== primary?.id && candidate.id !== 'open_detail')) {
    alternatives.push({
      id: `${item.itemId}:${action.id}`,
      label: action.label,
      rank: action.style === 'destructive' ? 'not_recommended' : 'good',
      reason: action.style === 'destructive'
        ? 'This option changes or rejects the recommendation, so Nexus keeps it explicit.'
        : 'Available as a lower-friction alternative if the recommendation does not fit.',
      actionId: action.id,
      available: frontendActionStateForRecord(item, logic, dependencyStateForRecord(item), action) === 'enabled',
      source: 'recipe',
    });
  }
  if (!alternatives.some((option) => option.actionId === 'snooze')) {
    alternatives.push({
      id: `${item.itemId}:snooze`,
      label: 'Snooze',
      rank: 'good',
      reason: 'Use this if the decision is real but not worth interrupting this window.',
      actionId: 'snooze',
      available: item.status === 'unread' || item.status === 'read' || item.status === 'failed',
      source: 'system_default',
    });
  }
  if (!alternatives.some((option) => option.actionId === 'dismiss')) {
    alternatives.push({
      id: `${item.itemId}:dismiss`,
      label: 'Dismiss',
      rank: 'not_recommended',
      reason: 'Dismiss only when the recommendation no longer matters; Nexus records that outcome for future ranking.',
      actionId: 'dismiss',
      available: item.status === 'unread' || item.status === 'read' || item.status === 'failed',
      source: 'system_default',
    });
  }
  return alternatives.slice(0, 5);
}

/**
 * Shared (D) — the advisor's feasible slot recommendation for a SECRETARY REFLOW decision, or null when this
 * is not a secretary reflow (carries `accept_reflow`) with candidate slots and a feasible recommendation.
 * Pure: decisionContextForRecord + adviseSecretaryDecision are read-only and do NOT call back into
 * actionsForRecord / decisionLogicForRecord, so this is safe to call from actionsForRecord without recursion.
 */
function secretaryReflowChoiceAdvice(record: DecisionRecord): SecretaryDecisionAdvice | null {
  if (record.sourceSkill !== 'secretary') return null;
  if (!record.actions.some((candidate) => candidate.id === 'accept_reflow')) return null;
  const context = decisionContextForRecord(record);
  const slots = context.candidateSlots ?? [];
  if (slots.length === 0) return null;
  const advice = adviseSecretaryDecision({
    title: context.entityTitle ?? '',
    currentStartAt: context.currentStartAt,
    currentEndAt: context.currentEndAt,
    availableSlots: slots,
    reasonCodes: context.reasonCodes ?? [],
    timezone: context.timezone,
    locale: context.locale,
  });
  return advice.recommendedStartAt && advice.recommendedEndAt ? advice : null;
}

/**
 * D (secretary choose-a-time) — surface the slot CHOICES the advisor already computes (recommended slot +
 * ranked feasible alternatives, each a concrete window + tradeoff) as structured DecisionOptions the client
 * can render as a choice UI. Every option maps to the (fully-wired) `choose_another_time` action with its
 * window as the payload — a lightweight intent, NOT a baked preview (the client confirms freshly at
 * selection time). The action is surfaced under the same flag by actionsForRecord, so the options are
 * genuinely invokable. Returns undefined — never [] — when this is unsafe to act on or there is no feasible
 * recommendation, so no hollow choice UI is ever shown.
 */
function buildSecretaryChoiceOptions(item: DecisionRecord, logic: DecisionLogicV2): DecisionOption[] | undefined {
  if (!logic.quality.safeForFrontendAction) return undefined; // never offer actionable options on an unsafe decision
  const advice = secretaryReflowChoiceAdvice(item);
  if (!advice) return undefined;
  const options: DecisionOption[] = [{
    optionId: `${item.itemId}:opt:recommended`,
    title: advice.bestAction,
    summary: advice.scheduleImpact,
    tradeoffs: advice.whyTradeoffs,
    recommended: true,
    risk: 'low', // schedule reflow is reversible (undo_reflow), so choosing a window is low-risk
    actionId: 'choose_another_time',
    actionPayload: { startAt: advice.recommendedStartAt!, endAt: advice.recommendedEndAt! },
  }];
  for (const alt of advice.alternatives) {
    if (!alt.startAt || !alt.endAt) continue;
    options.push({
      optionId: `${item.itemId}:opt:${alt.startAt}`,
      title: alt.label,
      summary: alt.tradeoff,
      tradeoffs: [alt.tradeoff],
      recommended: false,
      risk: 'low',
      actionId: 'choose_another_time',
      actionPayload: { startAt: alt.startAt, endAt: alt.endAt },
    });
  }
  return options;
}

/**
 * D (content) — surface the content pipeline state for a content decision as a structured card. Pure +
 * read-only (getContentWorkflowObject is scope-checked by userId/tenantId). Returns undefined — never a
 * partial card — for non-content decisions or when the backing workflow object is missing, so the field is
 * only present when every value is real.
 */
function buildContentDecisionCard(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  primaryAction: NotificationActionButton | null,
): DecisionContentCard | undefined {
  if (item.sourceSkill !== 'content') return undefined;
  const objectId = contentWorkflowObjectIdForDecision(item);
  if (!objectId) return undefined;
  const object = getContentWorkflowObject(item.userId, objectId, item.tenantId);
  if (!object) return undefined;
  return {
    objectType: object.objectType,
    pipelineStage: object.editorialState,
    approvalState: object.approvalState,
    reviewRequired: object.reviewRequired,
    nextActionLabel: logic.primaryActionLabel || (primaryAction?.label ?? null),
  };
}

/**
 * Conservative training-risk label derived ONLY from the agenda's structured decisionReasonCodes (enum
 * tokens, never free text), so injected evidence in a title/body can never move the risk. Defaults to
 * 'low' and only escalates on explicit risk tokens — never overconfident.
 */
function trainingRiskFromReasonCodes(codes: string[]): 'low' | 'medium' | 'high' {
  const set = codes.map((code) => code.toLowerCase());
  const has = (...needles: string[]): boolean => set.some((code) => needles.some((needle) => code.includes(needle)));
  if (has('compression', 'deload', 'conflict', 'injury', 'overreach')) return 'high';
  if (has('peak', 'race', 'taper')) return 'medium';
  return 'low';
}

/**
 * D (training) — before/after window + risk + undo card for a training-origin reflow decision. Reads the
 * anchoring secretary agenda item (owner/tenant-scoped) for the BEFORE window + structured reason codes,
 * and the already-computed recommended window (context) for the AFTER. Pure-ish (one scoped read). Returns
 * undefined (no hollow card) for non-training decisions, a non-training agenda, or a missing before window.
 */
function buildTrainingDecisionCard(
  item: DecisionRecord,
  rollback: { available: boolean; actionId: string | null },
): DecisionTrainingCard | undefined {
  // Gate on the ANCHORING AGENDA's skill, not the decision's: a training-session reflow is surfaced under
  // sourceSkill 'secretary' (the scheduler) while the agenda is source_skill 'training'. The cheap
  // relatedEntityType check first avoids a DB read for non-reflow decisions.
  if (item.relatedEntityType !== 'secretary_agenda_item' || !item.relatedEntityId) return undefined;
  const agenda = getSecretaryAgendaItemById({ agendaItemId: item.relatedEntityId, ownerUserId: item.userId, tenantId: item.tenantId });
  if (!agenda || agenda.sourceSkill !== 'training') return undefined; // true training origin only
  const beforeStartAt = agenda.startAt ?? null;
  const beforeEndAt = agenda.endAt ?? null;
  if (!beforeStartAt || !beforeEndAt) return undefined; // no hollow card without a real before window
  const context = decisionContextForRecord(item);
  const afterStartAt = context.recommendedStartAt ?? null;
  const afterEndAt = context.recommendedEndAt ?? null;
  return {
    beforeWindowLabel: formatDecisionWindow(beforeStartAt, beforeEndAt, context.timezone, context.locale),
    afterWindowLabel: afterStartAt && afterEndAt ? formatDecisionWindow(afterStartAt, afterEndAt, context.timezone, context.locale) : null,
    beforeStartAt,
    beforeEndAt,
    afterStartAt,
    afterEndAt,
    risk: trainingRiskFromReasonCodes(agenda.decisionReasonCodes ?? []),
    undoAvailable: rollback.available,
  };
}

/**
 * D (finance) — READ-ONLY, privacy-safe card for a finance tax-event decision. Surfaces ONLY the tax month
 * + payment-status enum + freshness label + next action; NEVER any amount field. Same owner/tenant-scoped
 * tax-event derivation the executor already trusts. Returns undefined (no hollow card) unless a real
 * matching tax event exists.
 */
function buildFinanceDecisionCard(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  analysisBundle: DecisionAnalysisBundle,
  primaryAction: NotificationActionButton | null,
): DecisionFinanceCard | undefined {
  if (item.sourceSkill !== 'finance') return undefined;
  const month = item.relatedEntityType === 'finance_tax_event' ? item.relatedEntityId : null;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return undefined; // same gate as the finance executor
  const year = Number(month.slice(0, 4));
  const event = getTaxEvents(item.userId, { year, tenantId: item.tenantId }).find((candidate) => candidate.month === month);
  if (!event) return undefined; // no hollow card
  return {
    // Safe labels only — month + status enum + freshness; no amount/currency/due value ever.
    taxMonth: event.month,
    paymentStatus: event.status,
    freshnessLabel: analysisBundle.freshnessLabel,
    nextActionLabel: logic.primaryActionLabel || (primaryAction?.label ?? null),
  };
}

function relatedEntitiesSafeForRecord(item: DecisionRecord, logic: DecisionLogicV2): Array<{ type: string; label: string }> {
  if (!item.relatedEntityType || !item.relatedEntityId) {
    return logic.relatedEntityReason ? [{ type: 'reason', label: logic.relatedEntityReason }] : [];
  }
  const sensitive = item.privacyPolicy === 'financial' || item.privacyPolicy === 'sensitive';
  return [{
    type: item.relatedEntityType,
    label: sensitive ? `${sourceLabel(item.sourceSkill)} item` : `${sourceLabel(item.sourceSkill)} ${item.relatedEntityType.replace(/_/g, ' ')}`,
  }];
}

function sourceTraceSummaryForRecord(item: DecisionRecord, logic: DecisionLogicV2): string {
  const entity = item.relatedEntityType ? item.relatedEntityType.replace(/_/g, ' ') : 'source state';
  const verifier = logic.readBackVerifier ?? 'non-mutating decision';
  return `${sourceLabel(item.sourceSkill)} ${entity} -> Decision Center v2 -> ${verifier}`;
}

function sourceTraceForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionSourceTrace {
  const sourceEntityIds = item.relatedEntityType && item.relatedEntityId
    ? [`${item.relatedEntityType}:${item.relatedEntityId}`]
    : [];
  // C2: when the decision is anchored on a Secretary agenda item, surface
  // its persisted reasoning trail. Use the same owner-scoped read used by
  // `decisionContextForRecord` so cross-tenant leaks are impossible
  // (lookup tuple = agendaItemId + ownerUserId + tenantId).
  const reasoningTrail = reasoningTrailForRecord(item);
  return {
    originatingSkill: item.sourceSkill,
    originatingSignal: item.type,
    sourceEntityIds,
    sourceTimestamp: item.createdAt,
    enrichmentService: 'decision-center-logic-v2',
    orchestrator: item.sourceSkill === 'secretary' || item.type === 'conflict_detected'
      ? 'secretary-decision-advisor'
      : 'decision-center-facade',
    executor: actionsForRecord(item).length > 0 ? executorSkillForAction(actionsForRecord(item)[0].id, item) : null,
    verifier: logic.readBackVerifier,
    relatedStateReadModels: relatedStateReadModelsForRecord(item),
    confidenceSource: logic.confidence >= 0.8 ? 'structured-state-and-readback' : 'partial-structured-state',
    dataFreshness: item.status === 'snoozed' ? 'cached' : 'live',
    ...(reasoningTrail && reasoningTrail.length > 0 ? { reasoningTrail } : {}),
  };
}

function analysisForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionAnalysisBundle {
  const context = decisionContextForRecord(item);
  const sourceFreshness = sourceFreshnessForRecord(item, context);
  const confidenceLabel = logic.confidence >= 0.8 ? 'high' : logic.confidence >= 0.6 ? 'medium' : 'low';
  const rollbackConfidence = !rollbackContractForRecord(item).available
    ? 'none'
    : logic.readBackVerifier
      ? 'high'
      : logic.confidence >= 0.7
        ? 'medium'
        : 'low';
  return {
    confidence: logic.confidence,
    confidenceLabel,
    sourceFreshness,
    freshnessLabel: freshnessLabel(sourceFreshness, context),
    whyNow: logic.urgencyReason || logic.whySummary,
    expectedOutcome: logic.expectedEffect,
    costOfDelay: logic.impactIfIgnored,
    tradeoffs: logic.why.tradeoffs.slice(0, 3),
    uncertainty: logic.why.uncertainty.slice(0, 3),
    rollbackConfidence,
  };
}

function sourceFreshnessForRecord(item: DecisionRecord, context: DecisionLogicContext): DecisionAnalysisBundle['sourceFreshness'] {
  if (item.status === 'snoozed') return 'stale';
  if (context.contextExpiresAt) {
    const contextExpiry = Date.parse(context.contextExpiresAt);
    if (!Number.isFinite(contextExpiry)) return 'unknown';
    if (contextExpiry <= Date.now()) return 'stale';
  }
  const state = String(context.providerSyncState ?? '').toLowerCase();
  if (state && state !== 'synced' && state !== 'deleted') {
    const updatedAt = Date.parse(String(context.providerSyncUpdatedAt ?? ''));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    const ageMinutes = (Date.now() - updatedAt) / 60_000;
    return ageMinutes > 15 ? 'stale' : 'fresh';
  }
  if (context.providerSyncUpdatedAt) {
    const updatedAt = Date.parse(String(context.providerSyncUpdatedAt));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    return (Date.now() - updatedAt) / 60_000 <= 15 ? 'fresh' : 'live';
  }
  return item.relatedEntityId ? 'live' : 'unknown';
}

function freshnessLabel(freshness: DecisionAnalysisBundle['sourceFreshness'], context: DecisionLogicContext): string {
  switch (freshness) {
    case 'live':
      return 'Live read model';
    case 'fresh':
      return context.providerSyncUpdatedAt ? `Fresh as of ${context.providerSyncUpdatedAt}` : 'Fresh provider state';
    case 'stale':
      return context.providerSyncUpdatedAt ? `Provider state may be stale since ${context.providerSyncUpdatedAt}` : 'Stale state; refresh before acting';
    case 'unknown':
    default:
      return 'Freshness unknown';
  }
}

function topSuggestionForItem(item: DecisionApiItem): DecisionCenterTopSuggestion {
  return {
    decisionId: item.decisionId,
    title: item.explanation?.headline ?? item.safePreviewTitle ?? item.title,
    actionLabel: item.explanation?.actionLabels?.primary ?? item.recommendedActionLabel ?? item.primaryActionLabel ?? null,
    whyNow: item.explanation?.whyItMatters ?? item.analysis?.whyNow ?? item.whySummary ?? item.urgencyReason,
    expectedOutcome: item.explanation?.result ?? item.analysis?.expectedOutcome ?? item.expectedEffect,
    riskIfIgnored: item.explanation?.ifIgnored ?? item.analysis?.costOfDelay ?? item.impactIfIgnored,
    sourceSkill: item.sourceSkill,
    urgency: item.urgency,
  };
}

/**
 * Read the persisted Secretary reasoning trail for a decision record.
 *
 * Returns `null` when:
 * - the record isn't anchored on a `secretary_agenda_item`, OR
 * - the agenda item is missing / doesn't match the owner+tenant scope, OR
 * - the persisted column is empty (e.g. legacy rows from before W-E).
 *
 * The owner+tenant scope is enforced by `getSecretaryAgendaItemById` itself,
 * so a cross-tenant decisionId cannot leak another user's trail.
 */
function reasoningTrailForRecord(item: DecisionRecord): ReasoningTrailNode[] | null {
  if (item.relatedEntityType !== 'secretary_agenda_item' || !item.relatedEntityId) return null;
  const agenda = getSecretaryAgendaItemById({
    agendaItemId: item.relatedEntityId,
    ownerUserId: item.userId,
    tenantId: item.tenantId,
  });
  if (!agenda) return null;
  return agenda.reasoningTrail.length > 0 ? agenda.reasoningTrail : null;
}

function relatedStateReadModelsForRecord(item: DecisionRecord): string[] {
  const models = ['notification_center_items', 'notification_intents'];
  if (item.sourceSkill === 'secretary') models.push('secretary_agenda_items');
  if (item.sourceSkill === 'content') models.push('content_workflow_objects');
  if (item.sourceSkill === 'cooking') models.push('cooking_meal_plans');
  if (item.sourceSkill === 'finance') models.push('finance_tax_events');
  return models;
}

function dependencyGraphSummaryForRecord(
  dependencies: { dependsOnDecisionIds: string[]; blockedByDecisionIds: string[] },
  locale?: string | null,
): string | null {
  const pt = String(locale ?? '').toLowerCase().startsWith('pt');
  if (dependencies.blockedByDecisionIds.length > 0) {
    if (pt) {
      const count = dependencies.blockedByDecisionIds.length;
      return `Bloqueado por ${count} decisão${count === 1 ? '' : 'ões'} por resolver.`;
    }
    return `Blocked by ${dependencies.blockedByDecisionIds.length} unresolved decision${dependencies.blockedByDecisionIds.length === 1 ? '' : 's'}.`;
  }
  if (dependencies.dependsOnDecisionIds.length > 0) {
    if (pt) {
      const count = dependencies.dependsOnDecisionIds.length;
      return `Relacionado com ${count} decisão${count === 1 ? '' : 'ões'} anterior${count === 1 ? '' : 'es'}.`;
    }
    return `Related to ${dependencies.dependsOnDecisionIds.length} upstream decision${dependencies.dependsOnDecisionIds.length === 1 ? '' : 's'}.`;
  }
  return null;
}

function actionTruthTableEntryForRecord(
  item: DecisionRecord,
  action: NotificationActionButton,
  logic: DecisionLogicV2,
  rollback: { available: boolean },
): DecisionActionTruthTableEntry {
  return buildDecisionActionTruthTableEntry({
    actionId: action.id,
    sourceSkill: item.sourceSkill,
    expectedEffect: logic.expectedEffect,
    readBackVerifier: logic.readBackVerifier,
    outcomeSummary: outcomeSummaryForRecord({ ...item, status: 'actioned' }, logic).outcomeSummary,
    rollbackAvailable: rollback.available,
    notificationCanAct: logic.notificationEligibility === 'visible' && logic.quality.safeForAPNs,
    riskIfIgnored: logic.riskIfIgnored,
    priority: item.priority,
  });
}

function askNexusContextForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionAskNexusContext {
  return {
    decisionId: item.itemId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    prompt: `Explain this ${sourceLabel(item.sourceSkill)} decision, the recommendation, and what changes if I approve: ${logic.safePreviewTitle || logic.title}`,
  };
}

function decisionLogicForIntentInput(input: NotificationIntentInput): DecisionLogicV2 {
  return buildDecisionLogicV2({
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority: input.priority,
    title: input.title,
    body: input.body,
    safeBody: input.body,
    actions: input.actionButtons ?? [],
    relatedEntityType: input.relatedEntityType ?? null,
    relatedEntityId: input.relatedEntityId == null ? null : String(input.relatedEntityId),
    deadlineAt: input.decisionDeadline ?? null,
    expiresAt: input.expiresAt ?? null,
    privacyClassification: input.privacyPolicy ?? privacyPolicyForSource(input.sourceSkill),
    visibilityScope: visibilityScopeForIntentInput(input),
    context: decisionContextForIntentInput(input),
  });
}

function decisionLogicForRecord(record: DecisionRecord): DecisionLogicV2 {
  return buildDecisionLogicV2(decisionLogicInputForRecord(record));
}

function decisionLogicInputForRecord(record: DecisionRecord): Parameters<typeof buildDecisionLogicV2>[0] {
  return {
    sourceSkill: record.sourceSkill,
    type: record.type,
    priority: record.priority,
    title: record.title,
    body: record.body,
    safeBody: record.safeBody,
    actions: actionsForRecord(record),
    relatedEntityType: record.relatedEntityType,
    relatedEntityId: record.relatedEntityId,
    deadlineAt: record.decisionDeadline,
    expiresAt: record.expiresAt,
    privacyClassification: record.privacyPolicy,
    visibilityScope: visibilityScopeForItem(record),
    context: decisionContextForRecord(record),
  };
}

function decisionContextForIntentInput(input: NotificationIntentInput): DecisionLogicContext {
  const suppliedRaw = input.decisionContext ?? null;
  const supplied = withUserDecisionContextDefaults(input.userId, suppliedRaw);
  const relatedEntityType = input.relatedEntityType ?? null;
  if (input.sourceSkill === 'secretary' && relatedEntityType === 'secretary_agenda_item' && input.relatedEntityId != null) {
    const tenantId = input.tenantId ?? input.userId;
    let agenda: SecretaryAgendaItem | null = null;
    try {
      agenda = getSecretaryAgendaItemById({
        agendaItemId: String(input.relatedEntityId),
        ownerUserId: input.userId,
        tenantId,
      });
    } catch (error) {
      if (!hasDecisionContextPayload(suppliedRaw)) throw error;
      logger.warn({
        event: 'decision.secretary_agenda_context_unavailable',
        userId: input.userId,
        tenantId,
      }, 'Using supplied structured decision context while Secretary agenda read model is unavailable');
    }
    if (agenda) return secretaryAgendaDecisionContext(agenda, supplied);
  }
  if (hasDecisionContextPayload(suppliedRaw)) return supplied;
  if (input.sourceSkill === 'training' && isMissingRaceDateRecipe(input.dedupeKey)) {
    return withUserDecisionContextDefaults(input.userId, { explicitNoRelatedEntityReason: 'training profile is the affected entity' });
  }
  return supplied;
}

/**
 * True when a decision's dedupeKey marks it as the training "missing race date" RECIPE. Gated on the
 * recipe (dedupeKey prefix), NOT free-text title/body — so untrusted evidence text that happens to
 * contain the phrase "race date" can never trip race-date context/supersession handling and wrongly
 * hide an unrelated training decision. The missing-race-date fixtures/recipe use a dedupeKey like
 * `training:missing-race-date:<userId>:demo`.
 */
function isMissingRaceDateRecipe(dedupeKey: string | null | undefined): boolean {
  return /(^|:)missing[- ]race[- ]date/i.test(dedupeKey ?? '');
}

function decisionContextForRecord(record: DecisionRecord): DecisionLogicContext {
  const hasStoredContext = hasDecisionContextPayload(record.decisionContext);
  const storedContext = withUserDecisionContextDefaults(record.userId, record.decisionContext);
  if (record.sourceSkill === 'secretary' && record.relatedEntityType === 'secretary_agenda_item' && record.relatedEntityId) {
    let agenda: SecretaryAgendaItem | null = null;
    try {
      agenda = getSecretaryAgendaItemById({
        agendaItemId: record.relatedEntityId,
        ownerUserId: record.userId,
        tenantId: record.tenantId,
      });
    } catch (error) {
      if (!hasStoredContext) throw error;
      logger.warn({
        event: 'decision.secretary_agenda_context_unavailable',
        userId: record.userId,
        tenantId: record.tenantId,
      }, 'Using stored structured decision context while Secretary agenda read model is unavailable');
    }
    if (agenda) return secretaryAgendaDecisionContext(agenda, storedContext);
    if (hasStoredContext) return storedContext;
    return withUserDecisionContextDefaults(record.userId, { explicitNoRelatedEntityReason: 'secretary agenda item is missing' });
  }
  if (hasStoredContext) return storedContext;
  if (record.sourceSkill === 'content') {
    const contentObjectId = contentWorkflowObjectIdForDecision(record);
    if (contentObjectId) {
      const object = getContentWorkflowObject(record.userId, contentObjectId, record.tenantId);
      if (object) return withUserDecisionContextDefaults(record.userId, { entityTitle: object.title, sourceState: object.approvalState });
    }
  }
  if (record.sourceSkill === 'training' && isMissingRaceDateRecipe(record.dedupeKey)) {
    return withUserDecisionContextDefaults(record.userId, { explicitNoRelatedEntityReason: 'training profile is the affected entity' });
  }
  if (record.type === 'sync_failure') {
    return withUserDecisionContextDefaults(record.userId, { providerName: sourceLabel(record.sourceSkill), explicitNoRelatedEntityReason: 'sync failure is scoped to provider state' });
  }
  return storedContext;
}

function secretaryAgendaDecisionContext(agenda: SecretaryAgendaItem, supplied?: DecisionLogicContext | null): DecisionLogicContext {
  const candidateSlots = secretaryCandidateSlots(agenda, supplied);
  const currentStartAt = supplied?.currentStartAt ?? agenda.startAt ?? null;
  const currentEndAt = supplied?.currentEndAt ?? agenda.endAt ?? null;
  const advice = adviseSecretaryDecision({
    title: agenda.title,
    currentStartAt,
    currentEndAt,
    availableSlots: candidateSlots,
    reasonCodes: supplied?.reasonCodes ?? agenda.decisionReasonCodes,
    timezone: supplied?.timezone,
    locale: supplied?.locale,
  });
  const normalizedAction = normalizeDecisionAction(supplied?.normalizedAction)
    ?? buildSecretaryAgendaReflowAction(agenda, supplied, advice.recommendedStartAt, advice.recommendedEndAt);
  const suppliedTitle = supplied?.entityTitle?.trim() ?? '';
  return {
    ...(supplied ?? {}),
    // Producers may deliberately supply a privacy-safe fixed label. Preserve
    // it rather than re-inserting user-authored agenda copy into policy JSON.
    entityTitle: suppliedTitle && !isGenericDecisionCopy(suppliedTitle) ? suppliedTitle : agenda.title,
    currentStartAt,
    currentEndAt,
    recommendedStartAt: advice.recommendedStartAt,
    recommendedEndAt: advice.recommendedEndAt,
    candidateSlots,
    reasonCodes: supplied?.reasonCodes ?? agenda.decisionReasonCodes,
    sourceState: supplied?.sourceState ?? agenda.lifecycleState,
    providerSyncState: agenda.providerSyncState,
    providerSyncUpdatedAt: agenda.updatedAt,
    recipe: supplied?.recipe ?? 'secretary_reflow_window_v1',
    normalizedAction,
  };
}

function buildSecretaryAgendaReflowAction(
  agenda: SecretaryAgendaItem,
  context: DecisionLogicContext | null | undefined,
  recommendedStartAt: string | null,
  recommendedEndAt: string | null,
): NormalizedDecisionAction {
  const revision = secretaryAgendaStateRevision(agenda);
  const timezone = context?.timezone ?? 'UTC';
  const requestedWindow = recommendedStartAt && recommendedEndAt
    && Number.isFinite(Date.parse(recommendedStartAt))
    && Number.isFinite(Date.parse(recommendedEndAt))
    && Date.parse(recommendedStartAt) < Date.parse(recommendedEndAt)
    ? { start: recommendedStartAt, end: recommendedEndAt, timezone }
    : undefined;
  const localDay = requestedWindow
    ? DateTime.fromISO(requestedWindow.start, { setZone: true }).setZone(timezone).toISODate()
    : null;
  return buildNormalizedDecisionAction({
    intent: 'reflow_secretary_agenda',
    targetEntities: [{ type: 'secretary_agenda_item', id: agenda.agendaItemId, version: revision }],
    affectedResources: [
      { type: 'secretary_agenda_item', id: agenda.agendaItemId },
      { type: 'calendar_timeline', id: `${agenda.tenantId}:${localDay ?? 'unscheduled'}` },
    ],
    ...(requestedWindow ? { requestedWindow } : {}),
    preconditions: [{
      type: 'agenda_state',
      ref: agenda.agendaItemId,
      expectedVersion: revision,
      required: true,
    }],
    expectedEffects: [{ type: 'move_agenda_window', targetRef: `secretary_agenda_item:${agenda.agendaItemId}` }],
    prohibitedEffects: [{ type: 'overwrite_changed_agenda_state', targetRef: `secretary_agenda_item:${agenda.agendaItemId}` }],
    dependencies: [],
    exclusivityKeys: [
      `secretary_agenda_item:${agenda.tenantId}:${agenda.agendaItemId}`,
      `calendar_timeline:${agenda.tenantId}:${localDay ?? 'unscheduled'}`,
    ],
    authorizationScope: ['decision_center:write'],
    risk: 'medium',
    reversibility: 'reversible',
    contextVersion: `ctx_secretary_agenda_${revision}`,
  });
}

function withUserDecisionContextDefaults(userId: number, context?: DecisionLogicContext | null): DecisionLogicContext {
  const merged: DecisionLogicContext = { ...(context ?? {}) };
  const defaults = userDecisionContextDefaults(userId);
  if (!merged.timezone && defaults.timezone) merged.timezone = defaults.timezone;
  if (!merged.locale && defaults.locale) merged.locale = defaults.locale;
  return merged;
}

function hasDecisionContextPayload(context?: DecisionLogicContext | null): boolean {
  if (!context || typeof context !== 'object') return false;
  return Object.keys(context).some((key) => key !== 'timezone' && key !== 'locale');
}

function userDecisionContextDefaults(userId: number): Pick<DecisionLogicContext, 'timezone' | 'locale'> {
  if (!Number.isFinite(userId) || userId <= 0) return {};
  try {
    const row = getDb().prepare('SELECT language, timezone FROM users WHERE id = ?').get(userId) as {
      language?: string | null;
      timezone?: string | null;
    } | undefined;
    const timezone = validateDecisionTimezone(row?.timezone);
    const locale = validateDecisionLocale(row?.language);
    return {
      ...(timezone ? { timezone } : {}),
      ...(locale ? { locale } : {}),
    };
  } catch {
    return {};
  }
}

function validateDecisionTimezone(timezone?: string | null): string | undefined {
  if (typeof timezone !== 'string' || !timezone.trim()) return undefined;
  const trimmed = timezone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return undefined;
  }
}

function validateDecisionLocale(locale?: string | null): string | undefined {
  if (typeof locale !== 'string' || !locale.trim()) return undefined;
  return normalizeSupportedLang(locale, 'en-US');
}

function secretaryCandidateSlots(
  agenda: SecretaryAgendaItem,
  supplied?: DecisionLogicContext | null,
): SecretaryAvailableSlot[] {
  const slots: SecretaryAvailableSlot[] = [];
  const addSlot = (
    startAt?: string | null,
    endAt?: string | null,
    label?: string | null,
    metadata?: Partial<SecretaryAvailableSlot> | null,
  ) => {
    if (!startAt || !endAt) return;
    if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt)) || Date.parse(startAt) >= Date.parse(endAt)) return;
    if (slots.some((slot) => Date.parse(slot.startAt) === Date.parse(startAt) && Date.parse(slot.endAt) === Date.parse(endAt))) return;
    slots.push({
      ...(metadata ?? {}),
      startAt,
      endAt,
      label: label ?? metadata?.label ?? undefined,
    });
  };

  for (const slot of supplied?.candidateSlots ?? []) {
    addSlot(slot.startAt, slot.endAt, slot.label ?? 'Candidate slot', slot);
  }
  addSlot(supplied?.recommendedStartAt, supplied?.recommendedEndAt, 'Recommended slot');
  for (const segment of agenda.scheduledSegments ?? []) {
    addSlot(segment.start, segment.end, segment.label ?? 'Secretary candidate');
  }
  addSlot(agenda.startAt, agenda.endAt, 'Proposed slot');
  return slots;
}

function outcomeSummaryForRecord(record: DecisionRecord, logic: DecisionLogicV2): {
  outcomeSummary: string | null;
  failureReason: string | null;
  retryActions: NotificationActionButton[];
} {
  if (!record.actionResult) return { outcomeSummary: null, failureReason: null, retryActions: [] };
  const actionId = typeof record.actionResult.actionId === 'string' ? record.actionResult.actionId : null;
  const errorCode = typeof record.actionResult.errorCode === 'string' ? record.actionResult.errorCode : null;
  if (record.status === 'failed' || errorCode) {
    return {
      outcomeSummary: 'Action failed. You can retry.',
      failureReason: errorCode ?? 'Decision action failed.',
      retryActions: actionsForRecord(record).filter((action) => action.style === 'primary' || action.id !== 'open_detail'),
    };
  }
  if (record.status === 'actioned') {
    if (record.sourceSkill === 'secretary') {
      const startAt = typeof record.actionResult.startAt === 'string' ? record.actionResult.startAt : null;
      const endAt = typeof record.actionResult.endAt === 'string' ? record.actionResult.endAt : null;
      const context = decisionContextForRecord(record);
      const window = formatDecisionWindow(startAt, endAt, context.timezone, context.locale) ?? 'the proposed window';
      return { outcomeSummary: `Done — Secretary applied ${window} and verified the agenda item.`, failureReason: null, retryActions: [] };
    }
    if (record.sourceSkill === 'content') {
      const state = typeof record.actionResult.approvalState === 'string' ? record.actionResult.approvalState : 'updated';
      return { outcomeSummary: `Done — content workflow is ${state}.`, failureReason: null, retryActions: [] };
    }
    return { outcomeSummary: `Done — ${logic.expectedEffect}`, failureReason: null, retryActions: [] };
  }
  return { outcomeSummary: null, failureReason: null, retryActions: [] };
}

function explanationForDecisionItem(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanation {
  if (record.status === 'failed') return finalizeDecisionExplanation(record, failedDecisionExplanation(record, logic));
  if (record.status === 'actioned') {
    const actionId = actionIdForRecord(record) ?? 'completed';
    return finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
      actionId,
      actualEffect: record.actionResult ?? {},
      message: outcomeSummaryForRecord(record, logic).outcomeSummary ?? null,
    }));
  }
  return finalizeDecisionExplanation(record, openDecisionExplanation(record, logic));
}

function openDecisionExplanation(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanation {
  const entity = entityLabelForRecord(record, logic);
  const source = sourceLabel(record.sourceSkill);
  const userAction = openDecisionUserAction(record, logic);
  const verification = openVerificationTextForRecord(record, logic);
  const actionLabels = guidanceActionLabelsForRecord(record, logic);
  const result = guidanceWhatWillChangeForRecord(record, logic);
  const base: DecisionExplanation = {
    headline: `${source} needs a decision on ${entity}.`,
    whatHappened: firstConcrete([logic.problemStatement, logic.safePreviewBody, record.safeBody, record.body], `${source} found an item that needs review.`),
    whyItMatters: firstConcrete([logic.whySummary, logic.impactIfIgnored], `This affects ${source} orchestration and should stay explicit.`),
    nexusAction: firstConcrete([logic.recommendation], `Nexus prepared the safest available ${source} move and is waiting for your choice.`),
    userAction,
    result,
    verification,
    nextStep: userAction,
    recommendedMove: firstConcrete([logic.recommendation, userAction], userAction),
    ifIgnored: firstConcrete([logic.impactIfIgnored, logic.whySummary], `This ${source} item stays unresolved.`),
    actionLabels,
    displaySections: GUIDANCE_DISPLAY_SECTIONS,
    steps: [
      { label: 'Signal reviewed', detail: firstConcrete([logic.problemStatement], `${source} evaluated the source signal.`), status: 'done' },
      { label: 'User decision needed', detail: userAction, status: 'needs_user' },
      { label: 'Nexus action', detail: result, status: 'pending' },
      { label: 'Verification', detail: verification, status: logic.readBackVerifier ? 'pending' : 'done' },
    ],
  };
  if (record.type === 'sync_failure') {
    return {
      ...base,
      headline: `${source} sync needs attention.`,
      whatHappened: firstConcrete([logic.problemStatement], `${source} sync did not finish cleanly.`),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], `Recent ${source} data may stay stale until the sync is retried.`),
      nexusAction: firstConcrete([logic.recommendation], `Nexus can retry the sync without changing your plan.`),
      userAction: openDecisionUserAction(record, logic),
      result: firstConcrete([logic.expectedEffect], `Nexus retries ${source} sync and checks provider status.`),
      nextStep: openDecisionUserAction(record, logic),
    };
  }
  if (record.sourceSkill === 'content') {
    return {
      ...base,
      headline: `${entity} needs content review.`,
      whatHappened: firstConcrete([logic.problemStatement], `${entity} is ready for approval or rewrite feedback.`),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Publishing stays paused until you approve it or request changes.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus can advance the workflow or keep quality control open for a rewrite.'),
      userAction: openDecisionUserAction(record, logic),
      result: firstConcrete([logic.expectedEffect], 'The content state changes only after Nexus confirms the updated state.'),
      verification: openVerificationTextForRecord(record, logic),
    };
  }
  if (record.sourceSkill === 'secretary') {
    return {
      ...base,
      headline: `${entity} needs schedule judgment.`,
      whatHappened: firstConcrete([logic.problemStatement], `Secretary found a schedule conflict or reflow option for ${entity}.`),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Leaving it open can keep the day plan conflicted or stale.'),
      nexusAction: firstConcrete([logic.recommendation], 'Secretary prepared the safest schedule change and is waiting for approval.'),
      result: firstConcrete([logic.expectedEffect], guidanceWhatWillChangeForRecord(record, logic)),
      verification: openVerificationTextForRecord(record, logic),
    };
  }
  if (record.sourceSkill === 'finance') {
    return {
      ...base,
      headline: `${source} needs confirmation.`,
      whatHappened: firstConcrete([logic.problemStatement], 'A finance item needs explicit confirmation.'),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Keeping financial state accurate prevents stale reminders and bad planning pressure.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus will update only the scoped finance item after your confirmation.'),
      result: firstConcrete([logic.expectedEffect], 'Finance state is updated and verified without exposing private values in previews.'),
      verification: openVerificationTextForRecord(record, logic),
    };
  }
  if (record.sourceSkill === 'cooking') {
    return {
      ...base,
      headline: `${source} needs a meal choice.`,
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Meal and fueling choices change the plan only when you confirm them.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus prepared the safest meal-plan update and is waiting for your choice.'),
      result: firstConcrete([logic.expectedEffect], 'Cooking updates the meal plan after the choice is verified.'),
    };
  }
  if (record.sourceSkill === 'training') {
    return {
      ...base,
      headline: `${entity} needs training judgment.`,
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Training changes can affect load, recovery, and protected work later in the week.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus prepared the safest coach move and is waiting for approval.'),
      result: firstConcrete([logic.expectedEffect], 'Training state changes only after the relevant plan state is verified.'),
    };
  }
  return base;
}

function failedDecisionExplanation(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanation {
  const source = sourceLabel(record.sourceSkill);
  const failure = outcomeSummaryForRecord(record, logic);
  const retry = actionsForRecord(record).find((action) => action.style === 'primary')?.label ?? 'Retry or review the decision';
  return {
    headline: `${source} action needs retry.`,
    whatHappened: firstConcrete([logic.problemStatement], `${source} could not complete the last action.`),
    whyItMatters: firstConcrete([failure.failureReason, logic.impactIfIgnored], 'The decision remains open until Nexus can verify the result.'),
    nexusAction: 'Nexus stopped before closing the decision because it could not confirm a safe result.',
    userAction: retry,
    result: firstConcrete([failure.outcomeSummary], 'No verified state change was recorded.'),
    verification: firstConcrete([failure.failureReason], 'The final source check failed or returned an error.'),
    nextStep: retry,
    recommendedMove: retry,
    ifIgnored: firstConcrete([logic.impactIfIgnored], 'The decision stays open until the result is confirmed.'),
    actionLabels: guidanceActionLabelsForRecord(record, logic),
    displaySections: GUIDANCE_DISPLAY_SECTIONS,
    steps: [
      { label: 'Action attempted', detail: 'Nexus tried to perform the selected action.', status: 'done' },
      { label: 'Verification blocked', detail: firstConcrete([failure.failureReason], 'The resulting state could not be verified.'), status: 'blocked' },
      { label: 'Needs review', detail: retry, status: 'needs_user' },
    ],
  };
}

function handledDecisionExplanation(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  input: {
    actionId: string;
    actualEffect?: Record<string, unknown> | null;
    message?: string | null;
  },
): DecisionExplanation {
  const actionLabel = actionLabelForRecord(record, input.actionId);
  const humanActionLabel = humanActionLabelForRecord(
    record,
    logic,
    record.actions.find((action) => action.id === input.actionId) ?? null,
  ) ?? actionLabel;
  const entity = entityLabelForRecord(record, logic);
  const source = sourceLabel(record.sourceSkill);
  const actualEffect = input.actualEffect ?? {};
  const result = handledResultForRecord(record, logic, input.actionId, actualEffect, input.message);
  const verification = handledVerificationTextForRecord(record, logic, input.actionId, actualEffect);
  const nextStep = rollbackContractForRecord({ ...record, status: 'actioned' }).available
    ? 'No action is needed now. Undo is available if this change no longer works.'
    : 'No action is needed in Decision Center right now.';
  const base: DecisionExplanation = {
    headline: `${source} handled ${entity}.`,
    whatHappened: firstConcrete([logic.problemStatement], `${source} had an actionable Decision Center item.`),
    whyItMatters: handledBenefitForRecord(record, logic, input.actionId),
    nexusAction: `Nexus performed ${humanActionLabel} for ${entity}.`,
    userAction: 'No user action needed now.',
    result,
    verification,
    nextStep,
    recommendedMove: nextStep,
    ifIgnored: handledBenefitForRecord(record, logic, input.actionId),
    actionLabels: guidanceActionLabelsForRecord(record, logic),
    displaySections: ['what_will_change', 'why_it_matters', 'verification'],
    steps: [
      { label: 'Decision cleared', detail: `${source} item left the active queue.`, status: 'done' },
      { label: 'Action performed', detail: `Nexus performed ${humanActionLabel}.`, status: 'done' },
      { label: 'Verification checked', detail: verification, status: 'done' },
      { label: 'Next step', detail: nextStep, status: 'done' },
    ],
  };
  if (input.actionId === 'auto_dismiss_stale_decision') {
    return {
      ...base,
      headline: `${source} removed a resolved decision.`,
      nexusAction: `Nexus removed ${entity} from the active queue because the source state already changed.`,
      result: `The Decision Center no longer asks you to handle ${entity}.`,
      verification: firstConcrete([input.message], 'Nexus confirmed the source item was no longer actionable.'),
      nextStep: 'No action is needed unless the source item reopens.',
      steps: [
        { label: 'Source checked', detail: firstConcrete([input.message], 'The source state no longer requires this decision.'), status: 'done' },
        { label: 'Queue cleaned', detail: `${entity} was removed from active decisions.`, status: 'done' },
        { label: 'User spared', detail: 'No duplicate decision remains for you to clear.', status: 'done' },
      ],
    };
  }
  if (record.sourceSkill === 'content') {
    const state = stringOrNull(actualEffect.contentApprovalState) ?? stringOrNull(actualEffect.approvalState);
    const isRewrite = input.actionId === 'request_rewrite' || state === 'rewrite_requested';
    return {
      ...base,
      headline: isRewrite ? `Rewrite requested for ${entity}.` : `${entity} approved.`,
      nexusAction: isRewrite
        ? `Nexus requested changes on ${entity} and kept publishing paused.`
        : `Nexus approved ${entity} and moved the content workflow forward.`,
      result: isRewrite
        ? 'The content workflow is marked for rewrite, so quality control continues before publishing.'
        : 'The content workflow is approved and ready for its next downstream step.',
      nextStep: isRewrite
        ? 'Review the rewritten draft in Content when it is ready.'
        : 'Continue from Content when you are ready to publish or schedule it.',
    };
  }
  if (record.sourceSkill === 'secretary') {
    const context = decisionContextForRecord(record);
    const window = formatDecisionWindow(
      stringOrNull(actualEffect.startAt),
      stringOrNull(actualEffect.endAt),
      context.timezone,
      context.locale,
    );
    return {
      ...base,
      headline: `Secretary rescheduled ${entity}.`,
      nexusAction: `Secretary applied ${humanActionLabel} for ${entity}.`,
      result: window
        ? `${entity} was placed in ${window} and removed from active decisions.`
        : `${entity} was reflowed and removed from active decisions.`,
      nextStep: actualEffect.rollbackAvailable === true
        ? 'No action needed now. Undo remains available if the new timing no longer works.'
        : nextStep,
    };
  }
  if (record.sourceSkill === 'finance') {
    return {
      ...base,
      headline: `Finance updated ${entity}.`,
      nexusAction: `Nexus performed ${actionLabel} on the scoped finance item.`,
      result: 'Finance state is updated, so stale payment or tax reminders can stay out of the queue.',
      nextStep: 'No Decision Center action is needed unless Finance opens a new item.',
    };
  }
  return base;
}

function handledBenefitForRecord(record: DecisionRecord, logic: DecisionLogicV2, actionId: string): string {
  if (actionId === 'auto_dismiss_stale_decision') {
    return 'This prevents you from clearing a decision that the source system already resolved.';
  }
  if (record.sourceSkill === 'content') {
    return 'The content workflow has a verified next state instead of staying blocked in review.';
  }
  if (record.sourceSkill === 'secretary') {
    return 'Your active queue is quieter because the schedule change was applied and verified.';
  }
  if (record.sourceSkill === 'finance') {
    return 'Financial reminders stay aligned with the verified source of truth.';
  }
  if (record.sourceSkill === 'training') {
    return 'Training coordination can continue from a verified plan state.';
  }
  if (record.sourceSkill === 'cooking') {
    return 'Meal planning can continue from a verified choice instead of another prompt.';
  }
  return firstConcrete([logic.expectedEffect, logic.whySummary], 'Nexus verified the result and removed the item from active decisions.');
}

function handledResultForRecord(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  actionId: string,
  actualEffect: Record<string, unknown>,
  message?: string | null,
): string {
  if (message && !isGenericDecisionCopy(message)) return message;
  const outcome = outcomeSummaryForRecord({ ...record, status: 'actioned', actionResult: { actionId, ...actualEffect } }, logic).outcomeSummary;
  if (outcome && !isGenericDecisionCopy(outcome)) return outcome;
  if (record.sourceSkill === 'content') {
    const state = stringOrNull(actualEffect.contentApprovalState) ?? stringOrNull(actualEffect.approvalState);
    if (!state) return 'Content action completed; source confirmation is still pending.';
    return `Content workflow is now ${state}.`;
  }
  const state = concreteVerificationStateForRecord(record, actualEffect);
  if (state) return `${sourceLabel(record.sourceSkill)} state is now ${state}.`;
  return `${sourceLabel(record.sourceSkill)} action completed; source confirmation is still pending.`;
}

function openDecisionUserAction(record: DecisionRecord, logic: DecisionLogicV2): string {
  const primary = firstConcreteOrNull([logic.primaryActionLabel, recommendedAction(actionsForRecord(record))?.label]);
  if (primary) return primary;
  if (record.requiresUserAction) return `Choose how Nexus should handle this ${sourceLabel(record.sourceSkill)} item.`;
  return `Review this ${sourceLabel(record.sourceSkill)} item when you are ready.`;
}

function concreteVerificationStateForRecord(
  record: DecisionRecord,
  actualEffect: Record<string, unknown>,
): string | null {
  const fieldNames = DECISION_VERIFICATION_STATE_FIELDS[record.sourceSkill]
    ?? ['decisionStatus', 'state', 'status', 'lifecycleState', 'syncState'];
  for (const fieldName of fieldNames) {
    const value = stringOrNull(actualEffect[fieldName]);
    if (value) return value;
  }
  return null;
}

function guidanceEnabledForRecord(record: DecisionRecord): boolean {
  const scope = { userId: record.userId, tenantId: record.tenantId };
  return isDecisionCenterGuidanceV1Enabled(process.env, scope)
    && isDecisionCenterGuidanceSkillEnabled(record.sourceSkill, process.env, scope);
}

function isPortugueseRecord(record: DecisionRecord): boolean {
  return isPortugueseLocale(decisionContextForRecord(record).locale);
}

function guidanceActionLabelsForRecord(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanationActionLabels | undefined {
  const actions = actionsForRecord(record);
  const primary = recommendedAction(actions);
  const primaryLabel = humanActionLabelForRecord(record, logic, primary);
  if (!primaryLabel) return undefined;
  const secondary = actions
    .filter((action) => action.id !== primary?.id && action.id !== 'open_detail')
    .map((action) => humanActionLabelForRecord(record, logic, action))
    .filter((label): label is string => !!label)
    .slice(0, 2);
  return { primary: primaryLabel, secondary };
}

function humanActionLabelForRecord(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  action?: NotificationActionButton | null,
): string | null {
  const pt = isPortugueseRecord(record);
  const context = decisionContextForRecord(record);
  const recommendedWindow = formatDecisionWindow(
    context.recommendedStartAt,
    context.recommendedEndAt,
    context.timezone,
    context.locale,
  );
  if (record.sourceSkill === 'secretary') {
    if (action?.id === 'accept_reflow' || /reflow/i.test(action?.label ?? logic.primaryActionLabel)) {
      return recommendedWindow
        ? (pt ? `Mover para ${recommendedWindow}` : `Move to ${recommendedWindow}`)
        : (pt ? 'Remarcar' : 'Reschedule');
    }
    if (action?.id === 'choose_another_time') {
      return pt ? 'Escolher outro horário' : 'Choose another time';
    }
    if (action?.id === 'undo_reflow') {
      return pt ? 'Desfazer mudança' : 'Undo change';
    }
  }
  const label = firstConcreteOrNull([action?.label, logic.primaryActionLabel]);
  if (!label) return null;
  if (/^reflow$/i.test(label)) return pt ? 'Remarcar' : 'Reschedule';
  if (/^open detail$/i.test(label)) return pt ? 'Rever' : 'Review';
  return label;
}

function guidanceWhatWillChangeForRecord(record: DecisionRecord, logic: DecisionLogicV2): string {
  const change = logic.whatWillChange[0];
  if (change?.effect) return change.effect;
  return firstConcrete([logic.expectedEffect], `Nexus will update ${sourceLabel(record.sourceSkill)} after your choice.`);
}

function openVerificationTextForRecord(record: DecisionRecord, logic: DecisionLogicV2): string {
  const source = sourceLabel(record.sourceSkill);
  if (record.sourceSkill === 'secretary') return 'Nexus will check the calendar item after the change before closing this.';
  if (record.sourceSkill === 'content') return 'Nexus will check the content state after your choice before closing this.';
  if (record.sourceSkill === 'finance') return 'Nexus will check Finance after your confirmation before closing this.';
  if (record.sourceSkill === 'training') return 'Nexus will check the training plan state after your choice before closing this.';
  if (record.sourceSkill === 'cooking') return 'Nexus will check the meal plan after your choice before closing this.';
  if (logic.readBackVerifier) return `Nexus will check ${source} after your choice before closing this.`;
  return `Nexus will keep this item in ${source} until the source state changes.`;
}

function handledVerificationTextForRecord(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  actionId: string,
  actualEffect: Record<string, unknown>,
): string {
  const concreteState = concreteVerificationStateForRecord(record, actualEffect);
  const source = sourceLabel(record.sourceSkill);
  if (concreteState) return `Nexus checked ${source} and found the state is ${concreteState}.`;
  if (logic.readBackVerifier) return `Nexus checked ${source}; full source confirmation is still pending.`;
  return `${source} action ${actionLabelForRecord(record, actionId)} completed; Nexus will keep watching for source confirmation.`;
}

export interface DecisionGuidanceSanitizationResult {
  sanitized: string;
  rejectedTerms: string[];
}

export function sanitizeGuidanceString(
  value: string,
  context: { decisionId?: string; sourceSkill?: NotificationSourceSkill } = {},
): DecisionGuidanceSanitizationResult {
  let sanitized = value;
  const rejectedTerms: string[] = [];
  for (const term of GUIDANCE_BANNED_TERMS) {
    if (!term.pattern.test(sanitized)) {
      term.pattern.lastIndex = 0;
      continue;
    }
    term.pattern.lastIndex = 0;
    rejectedTerms.push(term.label);
    sanitized = sanitized.replace(term.pattern, term.replacement ?? '[redacted]');
  }
  if (rejectedTerms.length > 0) {
    decisionGuidanceStats.bannedTermsCaught += rejectedTerms.length;
    for (const term of rejectedTerms) {
      decisionGuidanceStats.bannedTermsByTerm[term] = (decisionGuidanceStats.bannedTermsByTerm[term] ?? 0) + 1;
    }
    logger.warn({
      decisionId: context.decisionId ?? 'unknown',
      sourceSkill: context.sourceSkill ?? 'unknown',
      rejectedTerms,
    }, 'Decision Center guidance copy redacted technical terms');
  }
  return { sanitized, rejectedTerms };
}

function sanitizeDecisionExplanation(record: DecisionRecord, explanation: DecisionExplanation): DecisionExplanation {
  const context = { decisionId: record.itemId, sourceSkill: record.sourceSkill };
  const sanitize = (value: string) => sanitizeGuidanceString(value, context).sanitized;
  const sanitized: DecisionExplanation = {
    ...explanation,
    headline: sanitize(explanation.headline),
    whatHappened: sanitize(explanation.whatHappened),
    whyItMatters: sanitize(explanation.whyItMatters),
    nexusAction: sanitize(explanation.nexusAction),
    userAction: sanitize(explanation.userAction),
    result: sanitize(explanation.result),
    verification: sanitize(explanation.verification),
    nextStep: sanitize(explanation.nextStep),
    recommendedMove: explanation.recommendedMove ? sanitize(explanation.recommendedMove) : undefined,
    ifIgnored: explanation.ifIgnored ? sanitize(explanation.ifIgnored) : undefined,
    actionLabels: explanation.actionLabels
      ? {
        primary: sanitize(explanation.actionLabels.primary),
        secondary: explanation.actionLabels.secondary.map(sanitize),
      }
      : undefined,
    displaySections: explanation.displaySections,
    steps: explanation.steps.map((step) => ({
      ...step,
      label: sanitize(step.label),
      detail: sanitize(step.detail),
    })),
  };
  if (!sanitized.recommendedMove || !sanitized.ifIgnored || !sanitized.actionLabels?.primary) {
    decisionGuidanceStats.partial += 1;
  } else {
    decisionGuidanceStats.emitted += 1;
  }
  return sanitized;
}

function finalizeDecisionExplanation(record: DecisionRecord, explanation: DecisionExplanation): DecisionExplanation {
  if (!guidanceEnabledForRecord(record)) {
    decisionGuidanceStats.nullGuidance += 1;
    const {
      recommendedMove,
      ifIgnored,
      actionLabels,
      displaySections,
      ...legacy
    } = explanation;
    void recommendedMove;
    void ifIgnored;
    void actionLabels;
    void displaySections;
    return sanitizeDecisionExplanation(record, legacy);
  }
  return sanitizeDecisionExplanation(record, explanation);
}

function actionIdForRecord(record: DecisionRecord): string | null {
  return record.decisionLogActionTaken
    ?? stringOrNull(record.actionResult?.actionId)
    ?? null;
}

function actionLabelForRecord(record: DecisionRecord, actionId: string): string {
  return record.actions.find((action) => action.id === actionId)?.label
    ?? humanizeActionId(actionId);
}

function entityLabelForRecord(record: DecisionRecord, logic: DecisionLogicV2): string {
  const context = decisionContextForRecord(record);
  return firstConcrete([
    context.entityTitle,
    logic.safePreviewTitle,
    logic.title,
    record.title,
  ], `${sourceLabel(record.sourceSkill)} item`);
}

function firstConcrete(candidates: Array<string | null | undefined>, fallback: string | null): string {
  return firstConcreteOrNull(candidates) ?? fallback ?? 'Decision details are available in Nexus.';
}

function firstConcreteOrNull(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || isGenericDecisionCopy(trimmed)) continue;
    return trimmed;
  }
  return null;
}

function isGenericDecisionCopy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'secretary'
    || normalized === 'review'
    || normalized === 'completed'
    || normalized === 'action saved'
    || normalized.startsWith('secretary needs your attention')
    || normalized.startsWith('nexus needs your attention')
    || normalized.startsWith('nexus completed the requested action')
    || normalized.startsWith('nexus completed:')
    || normalized.startsWith('nexus found a schedule or capacity conflict')
    || normalized.startsWith('demo schedule conflict')
    || normalized.startsWith('open nexus to view details');
}

function normalizeDecisionExplanation(value: unknown): DecisionExplanation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const headline = stringOrNull(record.headline);
  const whatHappened = stringOrNull(record.whatHappened);
  const whyItMatters = stringOrNull(record.whyItMatters);
  const nexusAction = stringOrNull(record.nexusAction);
  const userAction = stringOrNull(record.userAction);
  const result = stringOrNull(record.result);
  const verification = stringOrNull(record.verification);
  const nextStep = stringOrNull(record.nextStep);
  if (!headline || !whatHappened || !whyItMatters || !nexusAction || !userAction || !result || !verification || !nextStep) {
    return null;
  }
  const recommendedMove = stringOrNull(record.recommendedMove) ?? undefined;
  const ifIgnored = stringOrNull(record.ifIgnored) ?? undefined;
  const actionLabels = normalizeDecisionExplanationActionLabels(record.actionLabels);
  const displaySections = normalizeDecisionExplanationDisplaySections(record.displaySections);
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps = rawSteps
    .map((step) => normalizeDecisionExplanationStep(step))
    .filter((step): step is DecisionExplanationStep => !!step);
  return {
    headline,
    whatHappened,
    whyItMatters,
    nexusAction,
    userAction,
    result,
    verification,
    nextStep,
    steps,
    recommendedMove,
    ifIgnored,
    actionLabels,
    displaySections,
  };
}

function normalizeDecisionExplanationActionLabels(value: unknown): DecisionExplanationActionLabels | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const primary = stringOrNull(record.primary);
  if (!primary) return undefined;
  const secondary = Array.isArray(record.secondary)
    ? record.secondary.map((item) => stringOrNull(item)).filter((item): item is string => !!item)
    : [];
  return { primary, secondary };
}

function normalizeDecisionExplanationDisplaySections(value: unknown): DecisionExplanationDisplaySection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.filter((section): section is DecisionExplanationDisplaySection => isDecisionExplanationDisplaySection(section));
  return sections.length > 0 ? sections : undefined;
}

function isDecisionExplanationDisplaySection(value: unknown): value is DecisionExplanationDisplaySection {
  return value === 'decision_needed'
    || value === 'what_will_change'
    || value === 'why_it_matters'
    || value === 'options'
    || value === 'verification'
    || value === 'debug';
}

function normalizeDecisionExplanationStep(value: unknown): DecisionExplanationStep | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const label = stringOrNull(record.label);
  const detail = stringOrNull(record.detail);
  const status = stringOrNull(record.status);
  if (!label || !detail || !isDecisionExplanationStepStatus(status)) return null;
  return { label, detail, status };
}

function isDecisionExplanationStepStatus(value: string | null): value is DecisionExplanationStepStatus {
  return value === 'done' || value === 'needs_user' || value === 'pending' || value === 'blocked';
}

function privacyPolicyForSource(sourceSkill: NotificationSourceSkill): NotificationPrivacyPolicy {
  if (sourceSkill === 'finance') return 'financial';
  if (sourceSkill === 'training') return 'health';
  if (sourceSkill === 'content') return 'private_content';
  if (sourceSkill === 'security') return 'sensitive';
  return 'standard';
}

function sourceLabel(source: NotificationSourceSkill): string {
  switch (source) {
    case 'secretary': return 'Secretary';
    case 'training': return 'Training';
    case 'content': return 'Content';
    case 'cooking': return 'Cooking';
    case 'finance': return 'Finance';
    case 'chat': return 'Chat';
    case 'system': return 'System';
    case 'security': return 'Security';
  }
}

function recommendedAction(actions: NotificationActionButton[]): NotificationActionButton | null {
  return actions.find((action) => action.style === 'primary')
    ?? actions.find((action) => action.id !== 'open_detail')
    ?? actions[0]
    ?? null;
}

function confidenceForItem(item: DecisionRecord): number {
  if (item.type === 'decision_required') return 0.72;
  if (item.type === 'conflict_detected' || item.type === 'approval_required') return 0.86;
  if (item.type === 'sync_failure') return 0.8;
  return 0.75;
}

function riskLevelForItem(item: DecisionRecord): 'low' | 'medium' | 'high' {
  const normalizedRisk = normalizeDecisionAction(decisionContextForRecord(item).normalizedAction)?.risk;
  if (normalizedRisk === 'critical' || normalizedRisk === 'high') return 'high';
  if (normalizedRisk === 'medium') return 'medium';
  if (normalizedRisk === 'low') return 'low';
  if (item.priority === 'critical' || item.priority === 'time_sensitive') return 'high';
  if (item.type === 'approval_required' || item.type === 'sync_failure') return 'medium';
  return 'low';
}

function visibilityScopeForItem(item: DecisionRecord): DecisionApiItem['visibilityScope'] {
  return visibilityScopeFromContext(item.decisionContext) ?? 'user_private';
}

function visibilityScopeForIntentInput(input: NotificationIntentInput): DecisionVisibilityScope {
  const candidate = input.visibilityScope ?? input.decisionContext?.visibilityScope;
  return normalizeVisibilityScope(candidate) ?? 'user_private';
}

function visibilityScopeFromContext(context: DecisionLogicContext | null | undefined): DecisionVisibilityScope | null {
  return normalizeVisibilityScope(context?.visibilityScope);
}

function normalizeVisibilityScope(value: unknown): DecisionVisibilityScope | null {
  return value === 'user_private'
    || value === 'tenant_shared'
    || value === 'tenant_admin'
    || value === 'system_admin'
    ? value
    : null;
}

function ctaLabelForSummary(openCount: number, urgentCount: number, top: DecisionApiItem | null, locale?: string | null): string {
  const pt = isPortugueseLocale(locale);
  if (openCount === 0) return pt ? 'Tudo certo' : 'All Clear';
  if (urgentCount > 0) return pt ? 'Decisão urgente' : 'Urgent Decision';
  if (top?.type === 'conflict_detected') return pt ? 'Conflito de agenda' : 'Schedule Conflict';
  if (openCount === 1) return pt ? '1 decisão' : '1 Decision';
  return pt ? `${openCount} decisões` : `${openCount} Decisions`;
}

function isPortugueseLocale(locale?: string | null): boolean {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('pt');
}

function getDecisionRecord(decisionId: string, userId: number, tenantId = userId): DecisionRecord | null {
  assertScope(userId, tenantId, 'get_decision_record', { decisionId });
  ensureDecisionCenterTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_observed_at
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.item_id = ? AND items.user_id = ? AND items.tenant_id = ?
     LIMIT 1
  `).get(decisionId, userId, tenantId) as any;
  return row ? mapDecisionRecord(row) : null;
}

function mapDecisionRecord(row: any): DecisionRecord {
  return {
    itemId: row.item_id,
    intentId: row.intent_id,
    decisionLogId: row.decision_log_id ?? null,
    userId: row.user_id,
    tenantId: row.tenant_id,
    title: row.title,
    body: row.body,
    safeBody: row.safe_body,
    sensitiveBody: row.sensitive_body ?? null,
    sourceSkill: row.source_skill,
    type: row.type,
    priority: row.priority,
    status: row.status,
    deeplink: row.deeplink,
    actions: safeParseJson(row.actions_json, []),
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    relatedEntityId: row.related_entity_id,
    relatedEntityType: row.related_entity_type,
    decisionContext: safeParseJson(row.decision_context_json, null),
    requiresUserAction: !!row.requires_user_action,
    // Carried through so the badge can exclude it. A Decision Center row is
    // never promotional today, but the field is required by the shared type
    // and defaulting it silently would reintroduce the gap it closes.
    promotional: !!row.promotional,
    decisionDeadline: row.decision_deadline,
    privacyPolicy: row.privacy_policy ?? 'standard',
    deliveryPolicy: row.delivery_policy,
    snoozedUntil: row.snoozed_until ?? null,
    priorityScore: row.priority_score ?? null,
    actionedAt: row.actioned_at ?? null,
    decisionLogActionTaken: row.decision_log_action_taken ?? null,
    actionResult: row.action_result_json ? safeParseJson(row.action_result_json, null) : null,
    recordVersion: Number.isSafeInteger(Number(row.record_version)) && Number(row.record_version) > 0
      ? Number(row.record_version)
      : 1,
    decisionState: isDurableDecisionState(row.decision_state) ? row.decision_state : null,
    updatedAt: row.updated_at ?? row.created_at,
    supersededByItemId: row.superseded_by_item_id ?? null,
    contextObservedAt: row.context_observed_at ?? null,
  };
}

function isDurableDecisionState(value: unknown): value is DurableDecisionState {
  return value === 'proposed' || value === 'needs_input' || value === 'blocked'
    || value === 'ready_for_review' || value === 'approved' || value === 'rejected'
    || value === 'deferred' || value === 'superseded' || value === 'expired'
    || value === 'cancelled';
}

function durableDecisionStateForRecord(record: DecisionRecord): DurableDecisionState {
  if (record.decisionState === 'deferred' && !isSnoozedUntilFuture(record)) return 'ready_for_review';
  if (record.decisionState) return record.decisionState;
  switch (record.status) {
    case 'snoozed': return 'deferred';
    case 'actioned': return 'approved';
    case 'dismissed': return 'rejected';
    case 'superseded': return 'superseded';
    case 'expired': return 'expired';
    case 'unread':
    case 'read':
    case 'viewed':
    case 'failed':
    default:
      return 'ready_for_review';
  }
}

function isSnoozedUntilFuture(item: DecisionRecord): boolean {
  if (item.status !== 'snoozed' || !item.snoozedUntil) return false;
  const untilMs = Date.parse(item.snoozedUntil);
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

/**
 * A decision whose hard deadline (expires_at) has already passed must never be
 * surfaced as actionable. This uses the same Date.parse semantics as the
 * action-time guard in guardActionable(), so the display filter and the
 * action guard agree on "expired". A null/unparseable expires_at is treated as
 * non-expiring (matches guardActionable, which only flips on a finite past ms).
 */
function isDecisionExpired(item: DecisionRecord): boolean {
  if (!item.expiresAt) return false;
  const expiresMs = Date.parse(item.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
}

/** Map the legacy flat status onto the lifecycle layer (read implies viewed). */
export function legacyStatusToLifecycle(status: string): DecisionLifecycleStatus {
  switch (status) {
    case 'unread': return 'surfaced';
    case 'read': return 'viewed';
    case 'viewed': return 'viewed';
    case 'snoozed': return 'snoozed';
    case 'actioned': return 'completed';
    case 'dismissed': return 'dismissed';
    case 'expired': return 'expired';
    case 'superseded': return 'superseded';
    case 'failed': return 'surfaced'; // still actionable/retryable — outcome lives in actionOutcomeStatus
    default: return 'created';
  }
}

/** Item-level action outcome. Failed rows stay lifecycle 'surfaced' but carry a 'failed' outcome. */
export function actionOutcomeFromRecord(record: DecisionRecord): DecisionActionOutcomeStatus {
  if (record.status === 'actioned' && record.actionResult?.actionId === 'undo_reflow') return 'rolled_back';
  switch (record.status) {
    case 'actioned': return 'succeeded';
    case 'failed': return 'failed';
    default: return 'none';
  }
}

function requiredPermissionsForRecord(record: DecisionRecord): string[] {
  return normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)?.authorizationScope ?? [];
}

function approvalLevelForRecord(record: DecisionRecord): DecisionApprovalLevel {
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const conflict = decisionContextForRecord(record).conflictEvaluation;
  if (conflict?.findings.some((finding) => finding.class === 'permission_policy')) return 'unavailable';
  if (isSecretaryReviewOnlyPreview(record, action)) return 'none';
  const visibilityScope = visibilityScopeForItem(record);
  if (record.sourceSkill === 'security' || visibilityScope === 'tenant_admin' || visibilityScope === 'system_admin') {
    return 'admin_review';
  }
  // Finance remains a strong-confirmation class even before its normalized
  // domain adapter exists. Under flow enforcement that intentionally fails
  // closed: no structured review means no current strong approval token.
  if (record.sourceSkill === 'finance') return 'strong_confirmation';
  if (!action) return record.requiresUserAction ? 'user_confirmation' : 'none';
  if (action.risk === 'critical' || action.risk === 'high' || action.reversibility === 'irreversible'
  ) return 'strong_confirmation';
  return record.requiresUserAction ? 'user_confirmation' : 'none';
}

function reviewSupportedForRecord(
  record: DecisionRecord,
  action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction),
  approvalLevel = approvalLevelForRecord(record),
): boolean {
  if (!decisionFlowV1EnforcedForRecord(record)) return false;
  if (!action || approvalLevel === 'none' || approvalLevel === 'unavailable' || approvalLevel === 'admin_review') return false;
  const state = durableDecisionStateForRecord(record);
  return (state === 'proposed' || state === 'ready_for_review' || state === 'blocked' || state === 'needs_input')
    && !['actioned', 'dismissed', 'expired', 'superseded'].includes(record.status);
}

function isSecretaryReviewOnlyPreview(
  record: DecisionRecord,
  action: NormalizedDecisionAction | null,
): boolean {
  if (record.sourceSkill !== 'secretary') return false;
  const context = decisionContextForRecord(record);
  const reasons = new Set(context.reasonCodes ?? []);
  return reasons.has('preview_only')
    && record.actions.length > 0
    && record.actions.every((candidate) => candidate.id === 'open_detail')
    && !!action?.prohibitedEffects.some((effect) =>
      effect.type === 'automatic_execution'
      || effect.type === 'automatic_external_mutation'
      || effect.type === 'automatic_calendar_mutation');
}

/**
 * Refresh is a first-class recovery operation whenever either its dedicated
 * rollout is enabled or flow-v1 enforcement depends on fresh revalidation.
 * Keeping this decision in one helper prevents the API contract from
 * advertising a recovery action whose route would return 404.
 */
export function decisionRefreshSupportedForScope(userId: number, tenantId = userId): boolean {
  return isDecisionRefreshEnabled(process.env, { userId, tenantId })
    || isDecisionFlowV1EnforceEnabled(process.env, { userId, tenantId })
    || getDecisionConflictPolicyV1Mode(process.env, { userId, tenantId }) === 'active';
}

/** Route-level gate that adds only Training-personal v1 enforcement. */
export function decisionRefreshSupportedForDecision(
  decisionId: string,
  userId: number,
  tenantId = userId,
): boolean {
  if (decisionRefreshSupportedForScope(userId, tenantId)) return true;
  const record = getDecisionRecord(decisionId, userId, tenantId);
  return Boolean(record && record.sourceSkill === 'training' && decisionFlowV1EnforcedForRecord(record));
}

function decisionRefreshSupportedForRecord(record: DecisionRecord): boolean {
  return (decisionRefreshSupportedForScope(record.userId, record.tenantId)
    || decisionFlowV1EnforcedForRecord(record))
    && ['unread', 'read', 'failed', 'snoozed'].includes(record.status)
    && normalizeDecisionAction(decisionContextForRecord(record).normalizedAction) !== null;
}

function executionSummaryForRecord(record: DecisionRecord): DecisionExecutionSummary {
  let row: {
    action_execution_id: string;
    action_id: string;
    status: string;
    effect_results_json: string | null;
    recovery_json: string | null;
    error_code: string | null;
  } | undefined;
  try {
    row = getDb().prepare(`
      SELECT action_execution_id, action_id, status, effect_results_json, recovery_json, error_code
        FROM decision_action_executions
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(record.itemId, record.userId, record.tenantId) as typeof row;
  } catch {
    row = undefined;
  }
  if (!row) return { status: actionOutcomeFromRecord(record), effectResults: [], recoveryActions: [] };
  const rawStatus = row.status === 'partially_failed' ? 'partially_failed'
    : row.status === 'succeeded' && row.action_id === 'undo_reflow' ? 'rolled_back'
      : row.status === 'succeeded' ? 'succeeded'
      : row.status === 'failed' ? 'failed'
        : row.status === 'started' ? 'started' : 'none';
  const effectResults = safeParseJson<DecisionEffectResult[]>(row.effect_results_json, [])
    .filter((effect) => effect && typeof effect.effectId === 'string'
      && ['pending', 'succeeded', 'failed', 'compensated', 'unknown'].includes(effect.status));
  const recovery = safeParseJson<{ message?: string; actions?: NotificationActionButton[] }>(row.recovery_json, {});
  const recoveryActions = (Array.isArray(recovery.actions) ? recovery.actions : [])
    .filter((action) => action?.id !== 'refresh'
      || decisionRefreshSupportedForRecord(record)
      || (row?.status === 'partially_failed'
        && decisionRefreshSupportedForScope(record.userId, record.tenantId)))
    .slice(0, 4);
  const recoveryMessage = recovery.message && recoveryActions.length === 0
    && /refresh/i.test(recovery.message)
    ? 'Review the current source state before choosing a recovery action.'
    : recovery.message;
  return {
    status: rawStatus,
    lastAttemptId: row.action_execution_id,
    effectResults,
    recoveryActions,
    ...(recoveryMessage ? { message: recoveryMessage } : row.error_code ? { message: row.error_code } : {}),
  };
}

/**
 * Fold the legacy status + expiry + dependency state + capability into the single
 * effective status the client renders. Precedence is deliberate (expired wins over
 * everything; needs_action is the fallthrough). Pure — no DB writes. Expiry uses the
 * same isDecisionExpired() helper as the action guard so display and action agree.
 */
export function computeEffectiveStatus(
  record: DecisionRecord,
  ctx: {
    dependencies: { blockedByDecisionIds: string[] };
    logic: DecisionLogicV2;
    retryAvailable?: boolean;
    executionStatus?: DecisionActionOutcomeStatus;
  },
): DecisionEffectiveStatus {
  if (isDecisionExpired(record) || record.status === 'expired') return 'expired';
  if (record.status === 'superseded') return 'superseded';
  if (record.status === 'dismissed') return 'dismissed';
  if (ctx.executionStatus === 'started') return 'in_progress';
  if (ctx.executionStatus === 'partially_failed') return ctx.retryAvailable ? 'failed_retryable' : 'failed_terminal';
  if (record.status === 'actioned') return 'completed';
  if (record.status === 'failed') return ctx.retryAvailable ? 'failed_retryable' : 'failed_terminal';
  if (!ctx.logic.quality.safeToShowUser) return 'unavailable';
  if (isSnoozedUntilFuture(record)) return 'snoozed';
  if (ctx.dependencies.blockedByDecisionIds.length > 0) return 'waiting_on_dependency';
  if (record.type === 'sync_failure') return 'waiting_on_system';
  return 'needs_action';
}

/**
 * A2 — a "reconnect-class" action is an unwired sync-retry on a connection/sync_failure decision.
 * It has no deterministic executor (the truth table marks `retry` implemented:false), so rather than a
 * dead retry the client should route the user to connection settings. Narrow on purpose: only the
 * `retry` action on a `sync_failure` decision. Once a real provider-sync executor is wired, `retry`
 * becomes implemented and this never fires — the affordance exists only to replace the fake retry.
 */
function isReconnectClassAction(record: DecisionRecord, action: NotificationActionButton): boolean {
  return record.type === 'sync_failure' && action.id === 'retry';
}

/** Per-action render state: capability (truth-table implemented) + lifecycle gating. */
export function computeActionEffectiveStatus(
  record: DecisionRecord,
  action: NotificationActionButton,
  ctx: {
    dependencies: { blockedByDecisionIds: string[] };
    logic: DecisionLogicV2;
    reconnectAffordance?: boolean;
    executionStatus?: DecisionActionOutcomeStatus;
  },
): DecisionActionEffectiveStatus {
  const base = computeSharedNotificationActionEffectiveStatus({
    actionId: action.id,
    status: record.status,
    expiresAt: record.expiresAt,
    safeForFrontendAction: ctx.logic.quality.safeForFrontendAction,
    blockedByDependency: ctx.dependencies.blockedByDecisionIds.length > 0
      || durableDecisionStateForRecord(record) === 'blocked',
    reconnectRequired: Boolean(ctx.reconnectAffordance && isReconnectClassAction(record, action)),
  }) as DecisionActionEffectiveStatus;
  if (ctx.executionStatus === 'started' || ctx.executionStatus === 'partially_failed') {
    return {
      ...base,
      effective: 'disabled_missing_details',
      capabilityReason: ctx.executionStatus === 'started'
        ? 'execution_in_progress'
        : 'partial_execution_requires_recovery',
    };
  }
  return base;
}

/** Classify the decision for differentiated client rendering. Pure; precedence is deliberate. */
export function computeDecisionKind(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  deps: { blockedByDecisionIds: string[] },
  primaryAction: NotificationActionButton | null,
): DecisionKind {
  if (deps.blockedByDecisionIds.length > 0) return 'blocked_action';
  if (record.type === 'sync_failure') return 'status_update';
  if (!record.requiresUserAction) return 'insight';
  if (record.type === 'conflict_detected' || record.sourceSkill === 'finance') return 'risk_alert';
  if (record.type === 'approval_required' || logic.automationEligibility === 'user_opt_in_required') return 'choice_required';
  if (primaryAction && isDecisionActionExecutable(primaryAction.id)) return 'action_proposal';
  return 'recommendation';
}

/** Decide how the client may act on the decision. Pure; derives from effectiveStatus + capability. */
export function computeActionability(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  effectiveStatus: DecisionEffectiveStatus,
  primaryAction: NotificationActionButton | null,
): Actionability {
  if (effectiveStatus === 'unavailable') return 'unavailable';
  if (effectiveStatus === 'waiting_on_dependency') return 'blocked';
  if (effectiveStatus === 'expired' || effectiveStatus === 'superseded' || effectiveStatus === 'dismissed' || effectiveStatus === 'completed') return 'read_only';
  if (!record.requiresUserAction || !logic.quality.safeForFrontendAction) return 'read_only';
  if (!primaryAction || !isDecisionActionExecutable(primaryAction.id)) return 'read_only';
  return 'confirmation_required';
}

/**
 * F2 — evidence-freshness gate. When a decision's evidence is STALE, downgrade a write-capable
 * actionability to `preview_available` so the client surfaces a Refresh affordance (from the item's
 * `sourceFreshness` signal) rather than letting the user act on stale data. Pure; this only ever LOWERS
 * actionability — read-only / already-preview / blocked / unavailable states pass through unchanged, so
 * it can never escalate a decision.
 */
export function gateActionabilityForStaleEvidence(actionability: Actionability): Actionability {
  switch (actionability) {
    case 'execute_with_undo':
    case 'confirmation_required':
    case 'requires_human_review':
      return 'preview_available';
    default:
      return actionability;
  }
}

/**
 * True only when a live human-review queue is registered (env opt-in). No in-repo review queue exists today,
 * so this defaults FALSE — a `requires_human_review` decision must not show a review affordance that can't be
 * submitted. Flipping DECISION_HUMAN_REVIEW_QUEUE_AVAILABLE re-enables review once a real queue is wired.
 */
export function isHumanReviewQueueAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DECISION_HUMAN_REVIEW_QUEUE_AVAILABLE ?? '').trim().toLowerCase();
  return raw === 'true' || raw === 'on' || raw === '1';
}

/**
 * F human-review fallback — when the review queue is down, a `requires_human_review` decision is gated to
 * `unavailable` (manual-only). Only ever LOWERS that single value; every other actionability passes through
 * unchanged (cannot escalate), mirroring gateActionabilityForStaleEvidence's contract.
 */
export function gateActionabilityForHumanReview(actionability: Actionability, queueAvailable: boolean): Actionability {
  if (actionability === 'requires_human_review' && !queueAvailable) return 'unavailable';
  return actionability;
}

export const DECISION_RANKING_VERSION = 1;

/**
 * Versioned baseline extracted from the existing ranker. Values are intentionally unchanged;
 * changing them requires corpus/shadow evidence and a ranking-version bump.
 */
export const DECISION_RANKING_POLICY = Object.freeze({
  policyVersion: 'decision_ranking.v1',
  weights: Object.freeze({ urgency: 0.35, impact: 0.25, costOfDelay: 0.2, domainPriority: 0.2 }),
  effortPenaltyMax: 0.15,
  snoozePenalty: 0.25,
  blockedPenalty: 0.2,
  tierThresholds: Object.freeze({ critical: 80, high: 60, normal: 35 }),
  domainPriorityWeights: Object.freeze({
    security: 1, finance: 0.9, secretary: 0.7, training: 0.7, chat: 0.6, content: 0.5, cooking: 0.4,
  } as Record<string, number>),
});

const PRIORITY_TIER_ORDER: DecisionPriorityTier[] = ['low', 'normal', 'high', 'critical'];

export interface DecisionRankingInputs {
  priority: NotificationPriority;
  sourceSkill: string;
  type: string;
  status: string;
  deadlineSoon: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  actionCount: number;
  dependencyBlocked: boolean;
}

/**
 * Compute a multi-signal priority SEPARATE from confidence, then apply raise-only policy floors so
 * finance-risk / connection-blocking / critical-deadline / training-safety can never be buried.
 * Floor reason codes mark the item as feedback-suppression-exempt. Pure — no DB, no confidence input.
 */
export function rankDecisionPriority(input: DecisionRankingInputs): DecisionPrioritySnapshot {
  const reasonCodes: string[] = [];
  const urgency = input.priority === 'critical' ? 1 : input.priority === 'time_sensitive' ? 0.85 : input.priority === 'active' ? 0.55 : 0.25;
  const impact = input.riskLevel === 'high' ? 1 : input.riskLevel === 'medium' ? 0.6 : 0.3;
  const costOfDelay = input.deadlineSoon ? 0.9 : 0.3;
  const domainPriority = DECISION_RANKING_POLICY.domainPriorityWeights[input.sourceSkill] ?? 0.5;
  const effortPenalty = (Math.min(Math.max(input.actionCount, 0), 4) / 4) * DECISION_RANKING_POLICY.effortPenaltyMax;
  const snoozePenalty = input.status === 'snoozed' ? DECISION_RANKING_POLICY.snoozePenalty : 0;
  const blockedPenalty = input.dependencyBlocked ? DECISION_RANKING_POLICY.blockedPenalty : 0;

  const raw = (DECISION_RANKING_POLICY.weights.urgency * urgency)
    + (DECISION_RANKING_POLICY.weights.impact * impact)
    + (DECISION_RANKING_POLICY.weights.costOfDelay * costOfDelay)
    + (DECISION_RANKING_POLICY.weights.domainPriority * domainPriority)
    - effortPenalty - snoozePenalty - blockedPenalty;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

  if (urgency >= 0.85) reasonCodes.push('high_urgency');
  if (impact >= 1) reasonCodes.push('high_impact');
  if (input.deadlineSoon) reasonCodes.push('deadline_soon');
  if (input.dependencyBlocked) reasonCodes.push('blocked_by_dependency');
  if (input.status === 'snoozed') reasonCodes.push('snoozed');

  let tier: DecisionPriorityTier = score >= DECISION_RANKING_POLICY.tierThresholds.critical
    ? 'critical'
    : score >= DECISION_RANKING_POLICY.tierThresholds.high
      ? 'high'
      : score >= DECISION_RANKING_POLICY.tierThresholds.normal ? 'normal' : 'low';
  const floorTo = (floor: DecisionPriorityTier, code: string): void => {
    if (PRIORITY_TIER_ORDER.indexOf(floor) > PRIORITY_TIER_ORDER.indexOf(tier)) tier = floor;
    reasonCodes.push(code); // suppression-exempt marker, even if it did not raise the tier
  };
  if (input.priority === 'critical' || input.priority === 'time_sensitive') floorTo('critical', 'floor_critical_deadline');
  else if (input.deadlineSoon) floorTo('high', 'floor_deadline_soon');
  if (input.sourceSkill === 'finance' && input.riskLevel !== 'low') floorTo('high', 'floor_finance_risk');
  if (input.type === 'sync_failure' || input.dependencyBlocked) floorTo('high', 'floor_connection_blocking');
  if (input.sourceSkill === 'training' && input.riskLevel === 'high') floorTo('high', 'floor_training_safety');

  return {
    priorityTier: tier,
    priorityScore: score,
    reasonCodes: [...new Set(reasonCodes)],
    computedAt: new Date().toISOString(),
    rankingVersion: DECISION_RANKING_VERSION,
  };
}

/** C5 fatigue policy — bounds on how many decisions the overview surfaces. */
export interface DecisionFatiguePolicy {
  /**
   * Total visible budget the overview targets. Floored items occupy slots FIRST and are never
   * dropped (so the result can exceed this when floored.length > visibleCap); whatever budget remains
   * (visibleCap − floored.length, clamped at 0) bounds the NON-floored items. The cap is on the TOTAL
   * card count — criticals count toward it — which is the point: a flood of critical items must not
   * also drag in a full page of regular ones.
   */
  visibleCap: number;
  /** Size of the pinned "primary" set; the remainder is the "More" bucket. Floored items sit at the head, so they occupy these slots first. */
  topPrimaryCount: number;
  /** Max NON-floored items per sourceSkill domain, so one noisy domain can't crowd out the rest. Floored items bypass this cap entirely. */
  perDomainCap: number;
}

const DECISION_FATIGUE_DEFAULT_POLICY: DecisionFatiguePolicy = { visibleCap: 20, topPrimaryCount: 5, perDomainCap: 10 };

/**
 * True when a decision carries a non-suppressible policy floor and therefore must NEVER be hidden
 * under "More" or capped away by fatigue logic. Detection is the floor_* reason-code marker emitted
 * by rankDecisionPriority (pushed even when it does not raise the tier — see floorTo), with a
 * defensive priorityTier==='critical' fallback. Pure; no DB/env access. Conservative on missing
 * snapshot (returns false => under-floors rather than over-caps).
 */
export function isDecisionItemPolicyFloored(item: DecisionApiItem): boolean {
  const snapshot = item.prioritySnapshot;
  if (!snapshot) return false;
  return snapshot.reasonCodes.some((code) => code.startsWith('floor_')) || snapshot.priorityTier === 'critical';
}

/**
 * C5 fatigue selection — a PURE, post-ranking selection layer (never a re-rank): it preserves the
 * input order and only chooses which already-ranked items to surface. Floored decisions
 * (isDecisionItemPolicyFloored) bypass the PER-DOMAIN cap and are NEVER dropped — every floored item
 * survives into the result even when floored.length exceeds visibleCap. They are placed at the head
 * of the combined list in their original rank order, so they occupy the first primary slots and DO
 * count toward the total visible budget (visibleCap). Non-floored items are then bounded per-domain
 * (by sourceSkill) and to the REMAINING budget (visibleCap − floored.length, clamped at 0), and the
 * combined list is split into primaryItems (the first topPrimaryCount) + moreItems. No DB/env access;
 * exported for isolated unit testing.
 */
export function applyDecisionFatigueCaps(
  rankedItems: DecisionApiItem[],
  policy: DecisionFatiguePolicy = DECISION_FATIGUE_DEFAULT_POLICY,
): { primaryItems: DecisionApiItem[]; moreItems: DecisionApiItem[] } {
  const floored: DecisionApiItem[] = [];
  const regular: DecisionApiItem[] = [];
  for (const item of rankedItems) (isDecisionItemPolicyFloored(item) ? floored : regular).push(item);

  const perDomain = new Map<string, number>();
  const domainCapped: DecisionApiItem[] = [];
  for (const item of regular) {
    const key = item.sourceSkill;
    const seen = perDomain.get(key) ?? 0;
    if (seen >= policy.perDomainCap) continue;
    perDomain.set(key, seen + 1);
    domainCapped.push(item);
  }

  const regularBudget = Math.max(policy.visibleCap - floored.length, 0);
  const combined = [...floored, ...domainCapped.slice(0, regularBudget)];
  return {
    primaryItems: combined.slice(0, Math.max(policy.topPrimaryCount, 0)),
    moreItems: combined.slice(Math.max(policy.topPrimaryCount, 0)),
  };
}

/**
 * Promote the bare confidence number to an "evidence strength" explanation. label + sourceFreshness
 * are always safe to surface; basis/uncertainty inherit the decision's privacy gate (they come from
 * DecisionWhy, which can carry sensitive specifics).
 */
export function computeConfidenceExplanation(
  confidence: number,
  why: DecisionWhy,
  analysis: Pick<DecisionAnalysisBundle, 'confidenceLabel' | 'sourceFreshness'>,
  exposeEvidence: boolean,
): ConfidenceExplanation {
  const basis = exposeEvidence ? [...why.facts, ...why.rules].filter(Boolean).slice(0, 4) : [];
  const uncertainty = exposeEvidence ? why.uncertainty.filter(Boolean).slice(0, 4) : [];
  return {
    value: Number((Number.isFinite(confidence) ? confidence : 0).toFixed(2)),
    label: analysis.confidenceLabel,
    basis,
    uncertainty,
    sourceFreshness: analysis.sourceFreshness,
  };
}

/** Ordered decision lifecycle events. 'surfaced' records the first list/get exposure for an active decision. */
export type DecisionLifecycleEvent =
  | 'created' | 'surfaced' | 'detail_opened' | 'viewed' | 'snoozed' | 'dismissed'
  | 'approved' | 'rejected' | 'deferred' | 'revised' | 'blocked'
  | 'revalidation_failed' | 'strong_confirmation_legacy_bypass'
  | 'action_previewed' | 'action_started' | 'action_retryable' | 'action_succeeded' | 'action_failed' | 'action_partially_failed' | 'verified'
  | 'expired' | 'superseded' | 'rolled_back' | 'unblocked' | 'execution_reconciled' | 'auto_resolved';

let decisionLifecycleEventWriteFailures = 0;

/** Returns how many lifecycle-event writes have been swallowed (observability for the kill-switch path). */
export function getDecisionLifecycleEventWriteFailures(): number {
  return decisionLifecycleEventWriteFailures;
}

/**
 * Append a lifecycle event. Fire-and-forget: guarded by a kill-switch
 * (DECISION_LIFECYCLE_EVENTS_ENABLED=0) and a try/catch so a write failure can NEVER break the
 * user action it accompanies (mirrors the recordVerifiedDecisionAction write-failure pattern).
 */
function emitDecisionLifecycleEvent(input: {
  decisionId: string;
  userId: number;
  tenantId: number;
  event: DecisionLifecycleEvent;
  toStatus?: string | null;
  actionId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0') return;
  try {
    getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `dle_${randomUUID()}`,
      input.decisionId,
      input.userId,
      input.tenantId,
      input.event,
      input.toStatus ?? null,
      input.actionId ?? null,
      input.reason ?? null,
      JSON.stringify(input.metadata ?? {}),
    );
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, decisionId: input.decisionId, event: input.event }, 'Decision lifecycle event write failed (non-fatal)');
  }
}

function emitUnblockedDependentsForBlockers(
  blockers: Array<{ decisionId: string; userId: number; tenantId: number }>,
  reason: string,
): void {
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0' || blockers.length === 0) return;
  try {
    const db = getDb();
    const blockerIds = [...new Set(blockers.map((blocker) => blocker.decisionId))];
    const placeholders = blockerIds.map(() => '?').join(', ');
    const activeStatuses = [...DECISION_EXPIRY_ACTIVE_STATUSES];
    const activePlaceholders = activeStatuses.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT deps.decision_id,
             deps.depends_on_decision_id,
             deps.user_id,
             deps.tenant_id,
             dependent.status AS dependent_status
        FROM decision_dependencies deps
        JOIN notification_center_items dependent
          ON dependent.item_id = deps.decision_id
         AND dependent.user_id = deps.user_id
         AND dependent.tenant_id = deps.tenant_id
       WHERE deps.depends_on_decision_id IN (${placeholders})
         AND deps.relationship = 'blocks'
         AND dependent.status IN (${activePlaceholders})
    `).all(...blockerIds, ...activeStatuses) as Array<{
      decision_id: string;
      depends_on_decision_id: string;
      user_id: number;
      tenant_id: number;
      dependent_status: string;
    }>;
    const grouped = new Map<string, {
      decisionId: string;
      userId: number;
      tenantId: number;
      blockerDecisionIds: Set<string>;
      status: string;
    }>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.tenant_id}:${row.decision_id}`;
      let group = grouped.get(key);
      if (!group) {
        group = {
          decisionId: row.decision_id,
          userId: row.user_id,
          tenantId: row.tenant_id,
          blockerDecisionIds: new Set(),
          status: row.dependent_status,
        };
        grouped.set(key, group);
      }
      group.blockerDecisionIds.add(row.depends_on_decision_id);
    }
    const unresolved = db.prepare(`
      SELECT COUNT(*) AS n
        FROM decision_dependencies deps
        JOIN notification_center_items blocker
          ON blocker.item_id = deps.depends_on_decision_id
         AND blocker.user_id = deps.user_id
         AND blocker.tenant_id = deps.tenant_id
       WHERE deps.decision_id = ?
         AND deps.user_id = ?
         AND deps.tenant_id = ?
         AND deps.relationship = 'blocks'
         AND blocker.status IN (${activePlaceholders})
    `);
    for (const group of grouped.values()) {
      const remaining = unresolved.get(group.decisionId, group.userId, group.tenantId, ...activeStatuses) as { n: number };
      if ((remaining?.n ?? 0) > 0) continue;
      emitDecisionLifecycleEvent({
        decisionId: group.decisionId,
        userId: group.userId,
        tenantId: group.tenantId,
        event: 'unblocked',
        toStatus: group.status,
        reason,
        metadata: {
          blockerDecisionIds: [...group.blockerDecisionIds].sort(),
        },
      });
    }
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, reason }, 'Decision dependency unblocked lifecycle check failed (non-fatal)');
  }
}

function shouldEmitSurfaced(record: DecisionRecord): boolean {
  return ['unread', 'read', 'failed', 'snoozed'].includes(record.status);
}

function recordDecisionExposure(record: DecisionRecord, item: DecisionApiItem): void {
  emitDecisionSurfacedIfFirst(record);
  emitDecisionActionPreviewedForVisibleActions(record, item);
}

export function recordDecisionItemExposures(items: DecisionApiItem[]): void {
  for (const item of items) {
    const record = getDecisionRecord(item.decisionId, item.userId, item.tenantId);
    if (!record || !isDecisionRecord(record)) continue;
    materializeDecisionPriorityScore(record, item.priorityScore);
    recordDecisionExposure(record, item);
  }
}

/**
 * Explicit write-side exposure recorder used by clients when a card actually
 * becomes visible. Decision Center GET routes intentionally remain pure.
 * Unknown, expired, filtered, or cross-scope IDs are ignored and never reveal
 * whether another tenant owns a row.
 */
export function recordDecisionItemExposuresByIds(
  decisionIds: string[],
  userId: number,
  tenantId = userId,
): { recordedCount: number } {
  assertScope(userId, tenantId, 'record_decision_item_exposures');
  const uniqueIds = [...new Set(decisionIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  const items = uniqueIds
    .map((decisionId) => getDecisionItem(decisionId, userId, tenantId, { recordExposure: false }))
    .filter((item): item is DecisionApiItem => item !== null);
  recordDecisionItemExposures(items);
  return { recordedCount: items.length };
}

function emitDecisionSurfacedIfFirst(record: DecisionRecord): void {
  if (!shouldEmitSurfaced(record)) return;
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0') return;
  try {
    const existing = getDb().prepare(`
      SELECT 1
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'surfaced'
       LIMIT 1
    `).get(record.itemId, record.userId, record.tenantId);
    if (existing) return;
    emitDecisionLifecycleEvent({
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      event: 'surfaced',
      toStatus: record.status,
    });
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, decisionId: record.itemId }, 'Decision surfaced lifecycle check failed (non-fatal)');
  }
}

function previewableActionIdsForItem(item: DecisionApiItem): string[] {
  const enabled = new Set(
    (item.actionEffectiveStatuses ?? [])
      .filter((status) => status.effective === 'enabled')
      .map((status) => status.actionId),
  );
  const candidates = [
    item.recommendedAction?.id,
    ...item.alternativeActions.map((action) => action.id),
  ];
  return [...new Set(candidates.filter((actionId): actionId is string => !!actionId && enabled.has(actionId)))];
}

function emitDecisionActionPreviewedForVisibleActions(record: DecisionRecord, item: DecisionApiItem): void {
  if (!shouldEmitSurfaced(record)) return;
  for (const actionId of previewableActionIdsForItem(item)) {
    emitDecisionActionPreviewedIfFirst(record, actionId);
  }
}

function emitDecisionActionPreviewedIfFirst(record: DecisionRecord, actionId: string): void {
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0') return;
  try {
    const existing = getDb().prepare(`
      SELECT 1
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'action_previewed' AND action_id = ?
       LIMIT 1
    `).get(record.itemId, record.userId, record.tenantId, actionId);
    if (existing) return;
    emitDecisionLifecycleEvent({
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      event: 'action_previewed',
      actionId,
      toStatus: record.status,
    });
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, decisionId: record.itemId, actionId }, 'Decision action-preview lifecycle check failed (non-fatal)');
  }
}

export interface DecisionLifecycleEventRow {
  event: string;
  toStatus: string | null;
  actionId: string | null;
  reason: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Read the ordered lifecycle event stream for a decision (tests + observability). */
export function getDecisionLifecycleEvents(decisionId: string, userId: number, tenantId = userId): DecisionLifecycleEventRow[] {
  ensureDecisionCenterTables();
  return getDb().prepare(`
    SELECT event, to_status AS toStatus, action_id AS actionId, reason,
           metadata_json AS metadataJson, created_at AS createdAt
      FROM decision_lifecycle_events
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     ORDER BY rowid ASC
  `).all(decisionId, userId, tenantId).map((row: any) => ({
    event: row.event,
    toStatus: row.toStatus ?? null,
    actionId: row.actionId ?? null,
    reason: row.reason ?? null,
    createdAt: row.createdAt,
    metadata: safeParseJson(row.metadataJson, {}),
  })) as DecisionLifecycleEventRow[];
}

export function getDecisionAuditHistory(decisionId: string, userId: number, tenantId = userId): {
  events: DecisionLifecycleEventRow[];
  conflicts: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
} {
  assertScope(userId, tenantId, 'decision_audit_history', { decisionId });
  ensureDecisionCenterTables();
  const exists = getDb().prepare(`
    SELECT 1 FROM notification_center_items
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? LIMIT 1
  `).get(decisionId, userId, tenantId);
  if (!exists) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  const conflicts = getDb().prepare(`
    SELECT policy_version AS policyVersion, context_version AS contextVersion,
           disposition, hard_conflict_count AS hardConflictCount,
           soft_conflict_count AS softConflictCount, reason_codes_json AS reasonCodesJson,
           related_decision_ids_json AS relatedDecisionIdsJson,
           precedence_trace_json AS precedenceTraceJson, winner_decision_id AS winnerDecisionId,
           resolution, automatically_resolved AS automaticallyResolved,
           created_at AS createdAt, resolved_at AS resolvedAt
      FROM decision_conflict_evaluations
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     ORDER BY created_at ASC
  `).all(decisionId, userId, tenantId).map((row: any) => ({
    policyVersion: row.policyVersion,
    contextVersion: row.contextVersion,
    disposition: row.disposition,
    hardConflictCount: row.hardConflictCount,
    softConflictCount: row.softConflictCount,
    reasonCodes: safeParseJson(row.reasonCodesJson, []),
    relatedDecisionIds: safeParseJson(row.relatedDecisionIdsJson, []),
    precedenceTrace: safeParseJson(row.precedenceTraceJson, []),
    winnerDecisionId: row.winnerDecisionId ?? null,
    resolution: row.resolution ?? null,
    automaticallyResolved: !!row.automaticallyResolved,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  }));
  const executions = getDb().prepare(`
    SELECT action_execution_id AS attemptId, action_id AS actionId, status,
           effect_results_json AS effectResultsJson, recovery_json AS recoveryJson,
           error_code AS errorCode, created_at AS createdAt,
           completed_at AS completedAt, failed_at AS failedAt
      FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     ORDER BY created_at ASC
  `).all(decisionId, userId, tenantId).map((row: any) => ({
    attemptId: row.attemptId,
    actionId: row.actionId,
    status: row.status,
    effectResults: safeParseJson(row.effectResultsJson, []),
    recovery: safeParseJson(row.recoveryJson, {}),
    errorCode: row.errorCode ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
    failedAt: row.failedAt ?? null,
  }));
  return { events: getDecisionLifecycleEvents(decisionId, userId, tenantId), conflicts, executions };
}

function resolveDecisionConflictAudit(
  decisionId: string,
  userId: number,
  tenantId: number,
  resolution: string,
  automaticallyResolved = false,
): void {
  try {
    getDb().prepare(`
      UPDATE decision_conflict_evaluations
         SET resolution = ?, automatically_resolved = CASE WHEN ? THEN 1 ELSE automatically_resolved END,
             resolved_at = COALESCE(resolved_at, datetime('now'))
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND resolved_at IS NULL
    `).run(resolution, automaticallyResolved ? 1 : 0, decisionId, userId, tenantId);
    logger.info({ event: 'decision.conflict_resolved', decisionId, resolution, automaticallyResolved }, 'Decision conflict resolved');
  } catch (err) {
    logger.warn({ err, decisionId, resolution }, 'Decision conflict resolution audit failed');
  }
}

function recordDecisionConflictEvaluation(
  record: Pick<DecisionRecord, 'itemId' | 'userId' | 'tenantId'>,
  conflict: ConflictEvaluation,
): void {
  try {
    const relatedDecisionIds = [...new Set(conflict.findings
      .map((finding) => finding.conflictingDecisionId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
    getDb().prepare(`
      INSERT INTO decision_conflict_evaluations (
        conflict_evaluation_id, decision_id, user_id, tenant_id, policy_version,
        context_version, disposition, hard_conflict_count, soft_conflict_count,
        reason_codes_json, related_decision_ids_json, precedence_trace_json,
        winner_decision_id, automatically_resolved
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `dce_${randomUUID()}`,
      record.itemId,
      record.userId,
      record.tenantId,
      conflict.policyVersion,
      conflict.contextVersion,
      conflict.disposition,
      conflict.findings.filter((finding) => finding.severity === 'hard').length,
      conflict.findings.filter((finding) => finding.severity === 'soft').length,
      JSON.stringify([...new Set(conflict.reasonCodes)].sort()),
      JSON.stringify(relatedDecisionIds),
      JSON.stringify(conflict.precedenceTrace ?? []),
      conflict.winnerDecisionId ?? null,
      conflict.autoResolved ? 1 : 0,
    );
    logger.info({
      event: 'decision.conflict_evaluated',
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      disposition: conflict.disposition,
      hardConflictCount: conflict.findings.filter((finding) => finding.severity === 'hard').length,
      softConflictCount: conflict.findings.filter((finding) => finding.severity === 'soft').length,
    }, 'Decision conflict evaluation recorded');
  } catch (err) {
    logger.warn({ err, decisionId: record.itemId }, 'Decision conflict evaluation audit failed');
  }
}

export interface DecisionMetricsDailyRow {
  metricDate: string;
  tenantId: number;
  sourceSkill: string;
  createdCount: number;
  surfacedCount: number;
  viewedCount: number;
  dismissedCount: number;
  snoozedCount: number;
  actionSucceededCount: number;
  actionFailedCount: number;
  expiredCount: number;
  gateBlockedCount: number;
  computedAt: string;
}

/**
 * Aggregate one day's lifecycle events + generic-blocked quality-gate events into tenant-total
 * rows in decision_metrics_daily so dashboards read pre-aggregated counters, never the hot tables.
 * Idempotent (INSERT OR REPLACE per (date, tenant, '*')). Defaults to today (UTC).
 */
export function runDecisionMetricsRollupJob(input: { date?: string } = {}): { date: string; tenants: number } {
  ensureDecisionCenterTables();
  const db = getDb();
  const date = input.date ?? DateTime.utc().toISODate() ?? '1970-01-01';
  const eventRows = db.prepare(`
    SELECT tenant_id AS tenantId, event, COUNT(*) AS n
      FROM decision_lifecycle_events
     WHERE date(created_at) = ?
     GROUP BY tenant_id, event
  `).all(date) as Array<{ tenantId: number; event: string; n: number }>;
  const gateRows = db.prepare(`
    SELECT tenant_id AS tenantId, COUNT(*) AS n
      FROM decision_quality_gate_events
     WHERE date(created_at) = ? AND generic_blocked = 1
     GROUP BY tenant_id
  `).all(date) as Array<{ tenantId: number; n: number }>;

  const byTenant = new Map<number, Record<string, number>>();
  const bucket = (tenantId: number): Record<string, number> => {
    let row = byTenant.get(tenantId);
    if (!row) { row = {}; byTenant.set(tenantId, row); }
    return row;
  };
  for (const row of eventRows) bucket(row.tenantId)[row.event] = row.n;
  for (const row of gateRows) bucket(row.tenantId).gate_blocked = row.n;

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO decision_metrics_daily
      (metric_date, tenant_id, source_skill, created_count, surfaced_count, viewed_count,
       dismissed_count, snoozed_count, action_succeeded_count, action_failed_count,
       expired_count, gate_blocked_count, computed_at)
    VALUES (?, ?, '*', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const writeAll = db.transaction(() => {
    for (const [tenantId, c] of byTenant) {
      upsert.run(
        date, tenantId,
        c.created ?? 0, c.surfaced ?? 0, c.viewed ?? 0, c.dismissed ?? 0, c.snoozed ?? 0,
        c.action_succeeded ?? 0, c.action_failed ?? 0, c.expired ?? 0, c.gate_blocked ?? 0,
      );
    }
  });
  writeAll();
  return { date, tenants: byTenant.size };
}

/** Read a tenant's daily metrics row (dashboard + tests). Defaults to today (UTC). */
export function getDecisionMetricsDaily(tenantId: number, opts: { date?: string } = {}): DecisionMetricsDailyRow | null {
  ensureDecisionCenterTables();
  const date = opts.date ?? DateTime.utc().toISODate() ?? '1970-01-01';
  const row = getDb().prepare(`
    SELECT metric_date AS metricDate, tenant_id AS tenantId, source_skill AS sourceSkill,
           created_count AS createdCount, surfaced_count AS surfacedCount, viewed_count AS viewedCount,
           dismissed_count AS dismissedCount, snoozed_count AS snoozedCount,
           action_succeeded_count AS actionSucceededCount, action_failed_count AS actionFailedCount,
           expired_count AS expiredCount, gate_blocked_count AS gateBlockedCount, computed_at AS computedAt
      FROM decision_metrics_daily
     WHERE metric_date = ? AND tenant_id = ? AND source_skill = '*'
  `).get(date, tenantId) as DecisionMetricsDailyRow | undefined;
  return row ?? null;
}

export interface DecisionReleaseGateStatus {
  /** Active rows whose hard deadline has passed but the expiry sweep has not yet flipped them. Sweep-health signal. */
  expiredButVisible: number;
  /** Decisions presented as actionable whose primary action has no deterministic executor. Must be 0 (invariant tripwire). */
  unimplementedActionableCtas: number;
  /** Generic Notification Center attempts blocked because the action belongs to a Decision Center/domain executor. */
  unsupportedNotificationActions: number;
  /** Active notification rows whose deeplink cannot route to a supported destination. */
  deadDeeplinks: number;
  /** Latest client-reported badge drift. Null means no client badge report has been observed in the window. */
  badgeDrift: number | null;
  /** Mutating generic notification actions that incorrectly reported success. Must be 0. */
  genericMutatingActionSuccesses: number;
  /** APNs categories/contracts exposing actions that the truth table disallows from lock screen. */
  apnsMutatingActionsExposed: number;
  /** Stale action-source decisions still visible through the Notification Center inbox path. */
  staleSourceVisibleInInbox: number;
  pass: boolean;
}

/**
 * Release-gate invariants for the Decision Center (per the plan's "expired-visible = 0 /
 * unimplemented-primary-CTA = 0"). expiredButVisible measures sweep health (SQL sees unswept rows
 * the in-memory list filter hides); unimplementedActionableCtas is a tripwire — computeActionability
 * downgrades not-implemented primaries to read_only, so this is 0 unless that invariant regresses.
 */
export function getDecisionReleaseGateStatus(userId: number, tenantId = userId): DecisionReleaseGateStatus {
  assertScope(userId, tenantId, 'decision_release_gate_status', {});
  ensureDecisionCenterTables();
  const expiredButVisible = (getDb().prepare(`
    SELECT COUNT(*) AS n
      FROM notification_center_items
     WHERE user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime(?)
  `).get(userId, tenantId, appNowIso()) as { n: number }).n;

  const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 200, recordExposure: false });
  const unimplementedActionableCtas = items.filter((item) => {
    const actionable = item.actionability != null && !['read_only', 'blocked', 'unavailable'].includes(item.actionability);
    const primary = item.recommendedAction;
    return Boolean(actionable && primary && !isDecisionActionExecutable(primary.id));
  }).length;
  const notificationReliability = getNotificationReliabilityDashboard(userId, tenantId);
  const unsupportedNotificationActions = notificationReliability.quality.unsupportedActionBlockedCount;
  const deadDeeplinks = notificationReliability.quality.deadDeeplinkCount;
  const badgeDrift = notificationReliability.badge.drift;
  const genericMutatingActionSuccesses = notificationReliability.quality.genericMutatingActionSuccessCount;
  const apnsMutatingActionsExposed = listNotificationApnsActionExposures()
    .filter((entry) => !isDecisionActionAllowedFromApns(entry.actionId))
    .length;
  const staleSourceVisibleInInbox = countStaleSourceVisibleInInbox(userId, tenantId);

  return {
    expiredButVisible,
    unimplementedActionableCtas,
    unsupportedNotificationActions,
    deadDeeplinks,
    badgeDrift,
    genericMutatingActionSuccesses,
    apnsMutatingActionsExposed,
    staleSourceVisibleInInbox,
    pass: expiredButVisible === 0
      && unimplementedActionableCtas === 0
      && unsupportedNotificationActions === 0
      && deadDeeplinks === 0
      && (badgeDrift == null || badgeDrift === 0)
      && genericMutatingActionSuccesses === 0
      && apnsMutatingActionsExposed === 0
      && staleSourceVisibleInInbox === 0,
  };
}

function countStaleSourceVisibleInInbox(userId: number, tenantId: number): number {
  const visibleDecisionIds = listNotificationCenterItems(userId, tenantId, { status: 'all', limit: 200 })
    .filter((item) => DECISION_TYPES.has(item.type))
    .map((item) => item.itemId);
  if (visibleDecisionIds.length === 0) return 0;
  const placeholders = visibleDecisionIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.item_id IN (${placeholders})
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
       AND COALESCE(intents.requires_user_action, items.requires_user_action) = 1
  `).all(userId, tenantId, ...visibleDecisionIds) as any[];
  return rows.filter((row) => {
    const record = mapDecisionRecord(row);
    const logic = decisionLogicForRecord(record);
    return analysisForRecord(record, logic).sourceFreshness === 'stale';
  }).length;
}

/** Active-decision breakdowns for the operator dashboard (counts by domain / persisted type / status). */
export interface DecisionActiveBreakdowns {
  total: number;
  byDomain: Record<string, number>;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}

/**
 * One bounded GROUP BY over the active partition for the admin dashboard. `active` is the SAME status+expiry
 * PREFILTER the read paths start from (status in the active set AND not past expires_at) — so the count is
 * an upper bound on the active partition, not the fully-surfaced set (which additionally drops rows hidden
 * by quality/visibility logic). byType is the persisted `type` column (NotificationIntentType) — NOT the computed
 * DecisionKind (which would require formatting every row), so the field is honestly named byType. Admin +
 * flag-gated + low-frequency, so the single GROUP BY on the indexed partition is acceptable.
 */
export function getDecisionActiveBreakdowns(userId: number, tenantId = userId): DecisionActiveBreakdowns {
  assertScope(userId, tenantId, 'decision_active_breakdowns', {});
  ensureDecisionCenterTables();
  const rows = getDb().prepare(`
    SELECT source_skill AS domain, type, status, COUNT(*) AS n
      FROM notification_center_items
     WHERE user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
     GROUP BY source_skill, type, status
  `).all(userId, tenantId, appNowIso()) as Array<{ domain: string; type: string; status: string; n: number }>;
  const byDomain: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    total += row.n;
    byDomain[row.domain] = (byDomain[row.domain] ?? 0) + row.n;
    byType[row.type] = (byType[row.type] ?? 0) + row.n;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.n;
  }
  return { total, byDomain, byType, byStatus };
}

export type DecisionTypeSuppressionMode = 'dont_show_type' | 'snooze_type';

export interface DecisionTypeSuppression {
  sourceSkill: string;
  type: string;
  recipe: string | null;
  mode: DecisionTypeSuppressionMode;
  until: string | null;
  createdAt: string;
}

/**
 * C3 — mute a (sourceSkill, type) recipe: permanently (dont_show_type) or until a timestamp (snooze_type).
 * Re-suppressing the same type replaces the prior mode (PK is user+tenant+skill+type). Scoped write.
 */
export function suppressDecisionType(
  userId: number,
  tenantId: number,
  sourceSkill: string,
  type: string,
  mode: DecisionTypeSuppressionMode,
  until: string | null = null,
  recipe: string | null = null,
): void {
  assertScope(userId, tenantId, 'suppress_decision_type', { sourceSkill, type, mode, recipe });
  // A snooze with no `until` would persist a row that listActiveDecisionTypeSuppressionKeys can never
  // activate (it requires `until > now`) — a silent no-op. Reject it so the caller's intent can't be dropped.
  if (mode === 'snooze_type' && !until) {
    throw new DecisionActionError('VALIDATION', 'snooze_type suppression requires a non-null until timestamp', 400);
  }
  ensureDecisionCenterTables();
  const normalizedRecipe = normalizeDecisionRecipe(recipe);
  if (normalizedRecipe) {
    getDb().prepare(`
      INSERT OR REPLACE INTO decision_recipe_suppressions (user_id, tenant_id, source_skill, type, recipe, mode, until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(userId, tenantId, sourceSkill, type, normalizedRecipe, mode, mode === 'snooze_type' ? until : null);
    return;
  }
  getDb().prepare(`
    INSERT OR REPLACE INTO decision_type_suppressions (user_id, tenant_id, source_skill, type, mode, until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(userId, tenantId, sourceSkill, type, mode, mode === 'snooze_type' ? until : null);
}

/** C3 — remove a (sourceSkill, type) suppression. */
export function unsuppressDecisionType(userId: number, tenantId: number, sourceSkill: string, type: string, recipe: string | null = null): void {
  assertScope(userId, tenantId, 'unsuppress_decision_type', { sourceSkill, type, recipe });
  ensureDecisionCenterTables();
  const normalizedRecipe = normalizeDecisionRecipe(recipe);
  if (normalizedRecipe) {
    getDb().prepare(`
      DELETE FROM decision_recipe_suppressions
      WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND type = ? AND recipe = ?
    `).run(userId, tenantId, sourceSkill, type, normalizedRecipe);
    return;
  }
  getDb().prepare(`DELETE FROM decision_type_suppressions WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND type = ?`)
    .run(userId, tenantId, sourceSkill, type);
}

/** C3 — all suppression rows for the user (for the preferences GET; includes lapsed snoozes so the client can show state). */
export function listDecisionTypeSuppressions(userId: number, tenantId = userId): DecisionTypeSuppression[] {
  assertScope(userId, tenantId, 'list_decision_type_suppressions', {});
  ensureDecisionCenterTables();
  const broad = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type, NULL AS recipe, mode, until, created_at AS createdAt
      FROM decision_type_suppressions WHERE user_id = ? AND tenant_id = ?
  `).all(userId, tenantId) as DecisionTypeSuppression[];
  const recipeRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type, recipe, mode, until, created_at AS createdAt
      FROM decision_recipe_suppressions WHERE user_id = ? AND tenant_id = ?
  `).all(userId, tenantId) as DecisionTypeSuppression[];
  const recipes = recipeRows.map((row) => ({
    ...row,
    recipe: displayDecisionRecipe(row.sourceSkill, row.recipe),
  }));
  return [...broad, ...recipes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** ACTIVE suppression keys (`${sourceSkill}:${type}`): dont_show_type always; snooze_type only while until > now. */
function listActiveDecisionTypeSuppressionKeys(userId: number, tenantId: number): { broad: Set<string>; recipes: Set<string> } {
  const broadRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type
     FROM decision_type_suppressions
     WHERE user_id = ? AND tenant_id = ?
       AND (mode = 'dont_show_type' OR (mode = 'snooze_type' AND until IS NOT NULL AND datetime(until) > datetime(?)))
  `).all(userId, tenantId, appNowIso()) as Array<{ sourceSkill: string; type: string }>;
  const recipeRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type, recipe
      FROM decision_recipe_suppressions
     WHERE user_id = ? AND tenant_id = ?
       AND (mode = 'dont_show_type' OR (mode = 'snooze_type' AND until IS NOT NULL AND datetime(until) > datetime(?)))
  `).all(userId, tenantId, appNowIso()) as Array<{ sourceSkill: string; type: string; recipe: string }>;
  return {
    broad: new Set(broadRows.map((row) => `${row.sourceSkill}:${row.type}`)),
    recipes: new Set(recipeRows
      .map((row) => {
        const recipe = normalizeDecisionRecipe(row.recipe);
        return recipe ? `${row.sourceSkill}:${row.type}:${recipe}` : null;
      })
      .filter((key): key is string => !!key)),
  };
}

/**
 * C3 read-path filter (USER-FACING list + overview ONLY). Drops decisions whose (sourceSkill, type) the user
 * has actively suppressed — EXCEPT policy-floored decisions, which are never suppressible (mirrors the C5/B3
 * floor discipline). Flag-gated; OFF or no-suppressions returns the input unchanged. Read-only. NEVER applied
 * to integrity/admin reads (release gate, dashboard breakdowns, summary counts) so those stay accurate.
 */
export function applyDecisionTypeSuppression(items: DecisionApiItem[], userId: number, tenantId: number): DecisionApiItem[] {
  let filtered = items;
  if (isDecisionTypeSuppressionEnabled(process.env, { userId, tenantId })) {
    let suppressed: { broad: Set<string>; recipes: Set<string> };
    try {
      suppressed = listActiveDecisionTypeSuppressionKeys(userId, tenantId);
    } catch (err) {
      // Presentation filter: a transient suppression-read fault (locked DB, table not yet self-healed) must
      // NEVER hide the decision queue or 500 a survivable read. Fail OPEN to the full set; the preference
      // re-applies on the next successful read. (Write paths keep throwing — a dropped write must surface.)
      logger.warn({ err, userId, tenantId }, 'decision type-suppression read failed; showing all items (fail-open)');
      return items;
    }
    if (suppressed.broad.size > 0 || suppressed.recipes.size > 0) {
      filtered = filtered.filter((item) => {
        if (isDecisionItemPolicyFloored(item)) return true;
        const broadKey = `${item.sourceSkill}:${item.type}`;
        if (suppressed.broad.has(broadKey)) return false;
        const recipe = recipeForDecisionItem(item);
        return !recipe || !suppressed.recipes.has(`${broadKey}:${recipe}`);
      });
    }
  }
  if (!isDecisionFeedbackSuppressionEnabled(process.env, { userId, tenantId })) return filtered;
  const noisyTypes = feedbackSuppressedTypeKeys(userId, tenantId);
  if (noisyTypes.size === 0) return filtered;
  return filtered.filter((item) => isDecisionItemPolicyFloored(item) || !noisyTypes.has(`${item.sourceSkill}:${item.type}`));
}

function feedbackSuppressedTypeKeys(userId: number, tenantId: number): Set<string> {
  try {
    return new Set(
      getDecisionFeedbackSignals(userId, tenantId, { sinceDays: 14 })
        .filter((signal) => signal.type && signal.surfaced >= 5 && (
          signal.dontShowTypeCount >= 2
          || (signal.dismissed >= 4 && signal.dismissRate >= 0.8)
          || (signal.snoozed >= 4 && signal.snoozed / Math.max(1, signal.surfaced) >= 0.8)
        ))
        .map((signal) => `${signal.sourceSkill}:${signal.type}`),
    );
  } catch (err) {
    logger.warn({ err, userId, tenantId }, 'decision feedback suppression read failed; showing all items (fail-open)');
    return new Set();
  }
}

function normalizeDecisionRecipe(recipe: string | null | undefined): string | null {
  if (typeof recipe !== 'string') return null;
  const normalized = recipe.trim();
  if (!normalized) return null;
  const sourceSkill = normalized.split(':', 1)[0];
  const sourcePrefix = `${sourceSkill}:`;
  return isDecisionSourceSkillPrefix(sourceSkill) && normalized.startsWith(sourcePrefix)
    ? normalized.slice(sourcePrefix.length).slice(0, 160)
    : normalized.slice(0, 160);
}

function displayDecisionRecipe(sourceSkill: string, recipe: string | null): string | null {
  if (!recipe) return null;
  const normalized = recipe.trim();
  if (!normalized) return null;
  const sourcePrefix = `${sourceSkill}:`;
  return normalized.startsWith(sourcePrefix) ? normalized.slice(0, 160) : `${sourcePrefix}${normalized}`.slice(0, 160);
}

function recipeForDecisionItem(item: DecisionApiItem): string | null {
  const group = item.groupKey?.trim();
  if (!group) return null;
  const prefix = `${item.sourceSkill}:`;
  return group.startsWith(prefix) ? group.slice(prefix.length).slice(0, 160) : group.slice(0, 160);
}

function isDecisionSourceSkillPrefix(value: string): value is NotificationSourceSkill {
  return value === 'secretary'
    || value === 'training'
    || value === 'content'
    || value === 'cooking'
    || value === 'finance'
    || value === 'chat'
    || value === 'system'
    || value === 'security';
}

export interface DecisionFeedbackSignal {
  sourceSkill: string;
  type: string | null;
  surfaced: number;
  dismissed: number;
  snoozed: number;
  actionSucceeded: number;
  dismissRate: number;
  dontShowTypeCount: number;
  topDismissReasons: Array<{ reason: string; count: number }>;
}

/**
 * Aggregate the lifecycle event stream (incl. C3a dismiss reasons) into per-source-skill feedback
 * signals (C3b). READ-ONLY substrate for a future calibration/suppression pass — it does NOT alter
 * ranking yet (bounded suppression is a deliberate follow-up; floored categories stay exempt). Joins
 * events to notification_center_items for the source_skill dimension.
 *
 * Scope: per-user read, filtered by (user_id, tenant_id) and rides idx_decision_lifecycle_events_
 * scope_created — bounded by the caller's own event count, never a hot-table-wide scan. The JOIN
 * carries a redundant (user_id, tenant_id) guard as defense-in-depth so a future per-tenant item_id
 * scheme can never bleed another tenant's source_skill in.
 *
 * `opts.sinceDays` bounds the window so the signal can decay (a year-old dismissal must not weigh
 * like today's); omitted => all-time. The window uses the SQLite clock (`datetime('now')`), which
 * is NOT affected by vi.setSystemTime — tests pin determinism by back/forward-dating event rows
 * directly rather than moving the JS clock.
 *
 * `dontShowTypeCount` deliberately re-surfaces the 'dont_show_type' tally that also appears in
 * `topDismissReasons`; it is the single strongest suppression signal and callers act on it directly
 * without scanning the reason breakdown.
 */
export function getDecisionFeedbackSignals(
  userId: number,
  tenantId = userId,
  opts: { sinceDays?: number } = {},
): DecisionFeedbackSignal[] {
  assertScope(userId, tenantId, 'decision_feedback_signals', {});
  ensureDecisionCenterTables();
  const db = getDb();
  const windowClause =
    typeof opts.sinceDays === 'number' && opts.sinceDays > 0 ? `AND e.created_at >= datetime('now', ?)` : '';
  const windowArg: string[] = windowClause ? [`-${Math.floor(opts.sinceDays as number)} days`] : [];
  const eventRows = db.prepare(`
    SELECT i.source_skill AS sourceSkill, i.type AS type, e.event AS event, COUNT(*) AS n
      FROM decision_lifecycle_events e
      JOIN notification_center_items i
        ON i.item_id = e.decision_id AND i.user_id = e.user_id AND i.tenant_id = e.tenant_id
     WHERE e.user_id = ? AND e.tenant_id = ? ${windowClause}
     GROUP BY i.source_skill, i.type, e.event
  `).all(userId, tenantId, ...windowArg) as Array<{ sourceSkill: string; type: string; event: string; n: number }>;
  const reasonRows = db.prepare(`
    SELECT i.source_skill AS sourceSkill, i.type AS type, e.reason AS reason, COUNT(*) AS n
      FROM decision_lifecycle_events e
      JOIN notification_center_items i
        ON i.item_id = e.decision_id AND i.user_id = e.user_id AND i.tenant_id = e.tenant_id
     WHERE e.user_id = ? AND e.tenant_id = ? AND e.event = 'dismissed' AND e.reason IS NOT NULL ${windowClause}
     GROUP BY i.source_skill, i.type, e.reason
  `).all(userId, tenantId, ...windowArg) as Array<{ sourceSkill: string; type: string; reason: string; n: number }>;

  const buckets = new Map<string, { sourceSkill: string; type: string; events: Record<string, number>; reasons: Array<{ reason: string; count: number }> }>();
  const bucket = (skill: string, type: string): { sourceSkill: string; type: string; events: Record<string, number>; reasons: Array<{ reason: string; count: number }> } => {
    const key = `${skill}:${type}`;
    let b = buckets.get(key);
    if (!b) { b = { sourceSkill: skill, type, events: {}, reasons: [] }; buckets.set(key, b); }
    return b;
  };
  for (const row of eventRows) bucket(row.sourceSkill, row.type).events[row.event] = row.n;
  for (const row of reasonRows) bucket(row.sourceSkill, row.type).reasons.push({ reason: row.reason, count: row.n });

  return [...buckets.values()]
    .map((b) => {
      const surfaced = b.events.surfaced ?? b.events.created ?? 0;
      const dismissed = b.events.dismissed ?? 0;
      return {
        sourceSkill: b.sourceSkill,
        type: b.type,
        surfaced,
        dismissed,
        snoozed: b.events.snoozed ?? 0,
        actionSucceeded: b.events.action_succeeded ?? 0,
        // Guard the zero-denominator case (matches the file's blessed rate() convention at :~1714):
        // a skill with dismissed>0 but surfaced=0 (lifecycle tracking enabled after creation, or
        // post-retention pruning) must report 0, never the raw count — a rate > 1.0 would mis-fire a
        // future "suppress if rate > 0.8" consumer on a skill that has no recorded surfacing at all.
        dismissRate: surfaced === 0 ? 0 : Number((dismissed / surfaced).toFixed(4)),
        dontShowTypeCount: b.reasons.find((r) => r.reason === 'dont_show_type')?.count ?? 0,
        topDismissReasons: [...b.reasons].sort((a, c) => c.count - a.count).slice(0, 3),
      };
    })
    .sort((a, c) => c.dismissed - a.dismissed);
}

function actionsForRecord(record: DecisionRecord): NotificationActionButton[] {
  const actions = [...record.actions];
  const rollback = rollbackContractForRecord(record);
  if (
    rollback.available
    && rollback.actionId
    && !actions.some((action) => action.id === rollback.actionId)
  ) {
    actions.unshift({
      id: rollback.actionId,
      label: 'Undo reflow',
      style: 'secondary',
    });
  }
  // D: expose the fully-wired (truth-table implemented) `choose_another_time` action on a secretary reflow
  // that has feasible alternative slots, so the user can pick a specific window via the structured
  // DecisionOptions. Flag-gated and pushed (not unshifted, never primary). OFF or no-feasible-slot leaves
  // the action set byte-identical. The flag check short-circuits the advisor call when off.
  if (
    !actions.some((action) => action.id === 'choose_another_time')
    && isDecisionChoiceOptionsEnabled(process.env, { userId: record.userId, tenantId: record.tenantId })
    && secretaryReflowChoiceAdvice(record)
  ) {
    actions.push({ id: 'choose_another_time', label: 'Choose another time', style: 'secondary' });
  }
  return actions;
}

function rollbackContractForRecord(record: DecisionRecord): { available: boolean; actionId: string | null } {
  const actionId = typeof record.actionResult?.rollbackActionId === 'string'
    ? record.actionResult.rollbackActionId
    : null;
  const expectedRevision = typeof record.actionResult?.rollbackExpectedRevision === 'string'
    ? record.actionResult.rollbackExpectedRevision
    : null;
  return {
    available: record.status === 'actioned'
      && record.actionResult?.rollbackAvailable === true
      && !!actionId
      && !!expectedRevision,
    actionId,
  };
}

function dependencyStateForRecord(record: DecisionRecord): { dependsOnDecisionIds: string[]; blockedByDecisionIds: string[]; relationships: DecisionRelationship[] } {
  const dependencies = listDecisionDependencies(record.itemId, record.userId, record.tenantId);
  const unresolved = new Set(['unread', 'read', 'failed', 'snoozed']);
  return {
    dependsOnDecisionIds: dependencies.map((dependency) => dependency.dependsOnDecisionId),
    // C6: typed relationship edges (raw type + semantics) for the client. Read-only projection.
    relationships: dependencies.map((dependency) => {
      const semantics = decisionRelationshipSemantics(dependency.relationship);
      return { decisionId: dependency.dependsOnDecisionId, type: dependency.relationship, kind: semantics.kind, label: semantics.label };
    }),
    blockedByDecisionIds: dependencies
      // C6: only a 'blocks' relationship prevents action (decisionRelationshipSemantics is the single
      // source of truth). Every other typed relationship — conflicts_with / duplicate_of / related_to /
      // requires_same_slot / affects_same_entity / alternative_to / blocked_by / supersedes / caused_by /
      // related — is advisory and never contributes to blockedByDecisionIds.
      .filter((dependency) => decisionRelationshipSemantics(dependency.relationship).blocksAction && dependency.blockerStatus && unresolved.has(dependency.blockerStatus))
      .map((dependency) => dependency.dependsOnDecisionId),
  };
}

function guardActionable(record: DecisionRecord, actionId: string): void {
  if (durableDecisionStateForRecord(record) === 'blocked' && MUTATING_ACTIONS.has(actionId)) {
    throw new DecisionActionError('DECISION_CONFLICT_BLOCKED', 'Decision is blocked until its conflict or precondition is resolved.', 409);
  }
  if (record.status === 'expired') throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    const expire = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'expired', decision_state = 'expired',
             record_version = record_version + 1, updated_at = datetime('now')
      WHERE item_id = ? AND user_id = ? AND tenant_id = ?
        AND status != 'expired'
    `).run(record.itemId, record.userId, record.tenantId);
    if ((expire.changes ?? 0) > 0) {
      expireTrainingPlanRevisionForDecision(getDb(), record.itemId, record.userId, record.tenantId);
      emitDecisionLifecycleEvent({ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId, event: 'expired', toStatus: 'expired' });
      emitUnblockedDependentsForBlockers(
        [{ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId }],
        'blocker_expired',
      );
    }
    throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  }
  if (record.status === 'superseded') throw new DecisionActionError('DECISION_SUPERSEDED', 'Decision was superseded by newer state', 409);
  if (record.status === 'dismissed') throw new DecisionActionError('DECISION_DISMISSED', 'Decision was dismissed', 409);
  if (record.status === 'actioned' && rollbackContractForRecord(record).actionId !== actionId) {
    throw new DecisionActionError('DECISION_ALREADY_ACTIONED', 'Decision was already actioned', 409);
  }
}

function expireTrainingPlanRevisionForDecision(
  db: ReturnType<typeof getDb>,
  decisionId: string,
  userId: number,
  tenantId: number,
  approvalState: 'EXPIRED' | 'REJECTED' = 'EXPIRED',
): void {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_plan_revisions'
  `).get();
  if (!table) return;
  db.prepare(`
    UPDATE training_plan_revisions
       SET lifecycle_state = 'EXPIRED', approval_state = ?,
           expired_at = datetime('now')
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       AND lifecycle_state = 'PENDING_REVIEW' AND approval_state = 'PENDING'
  `).run(approvalState, decisionId, userId, tenantId);
  syncTrainingAdaptationProposalForDecisionState(
    db,
    decisionId,
    userId,
    tenantId,
    approvalState === 'REJECTED' ? 'REJECTED' : 'EXPIRED',
  );
}

function syncTrainingAdaptationProposalForDecisionState(
  db: ReturnType<typeof getDb>,
  decisionId: string,
  userId: number,
  tenantId: number,
  state: 'PENDING_REVIEW' | 'DEFERRED' | 'REJECTED' | 'EXPIRED',
): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_adaptation_proposals'").get()) {
    return;
  }
  const proposal = db.prepare(`
    SELECT proposal_id AS proposalId, status, material_fingerprint AS materialFingerprint
      FROM training_adaptation_proposals
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(decisionId, userId, tenantId) as {
    proposalId: string;
    status: string;
    materialFingerprint: string;
  } | undefined;
  if (!proposal) return;
  let update;
  if (state === 'PENDING_REVIEW') {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'PENDING_REVIEW'
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ? AND status = 'DEFERRED'
    `).run(proposal.proposalId, userId, tenantId);
  } else if (state === 'DEFERRED') {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'DEFERRED', deferred_at = datetime('now')
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ? AND status = 'PENDING_REVIEW'
    `).run(proposal.proposalId, userId, tenantId);
  } else if (state === 'REJECTED') {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'REJECTED', rejected_at = datetime('now')
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ?
         AND status IN ('PENDING_REVIEW', 'DEFERRED')
    `).run(proposal.proposalId, userId, tenantId);
  } else {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'EXPIRED', expired_at = datetime('now')
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ?
         AND status IN ('CANDIDATE', 'PENDING_REVIEW', 'DEFERRED')
    `).run(proposal.proposalId, userId, tenantId);
  }
  if ((update.changes ?? 0) !== 1) return;
  if (state === 'REJECTED') {
    emitDomainEvent({
      tenantId,
      userId,
      sourceSkill: 'training',
      eventType: 'training.adaptation.rejected.v1',
      entityType: 'training_adaptation_proposal',
      entityId: proposal.proposalId,
      schemaVersion: 'training-adaptation-rejection.v1',
      payload: {
        action: 'REJECT',
        proposalId: proposal.proposalId,
        materialFingerprint: proposal.materialFingerprint,
      },
      privacyClassification: 'health',
      idempotencyKey: `training.adaptation.rejected:${proposal.proposalId}`,
      causationId: decisionId,
    }, db);
  }
  if (state === 'DEFERRED') incrementTrainingGenerationCounter('adaptation_deferred_total');
  else if (state === 'REJECTED') incrementTrainingGenerationCounter('adaptation_rejected_total');
  else if (state === 'EXPIRED') incrementTrainingGenerationCounter('adaptation_expired_total');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_adaptation_lifecycle_events'").get()) {
    db.prepare(`
      INSERT INTO training_adaptation_lifecycle_events (
        event_id, proposal_id, tenant_id, user_id, event_type, reason_code, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, '{}')
    `).run(
      `tale_${randomUUID()}`,
      proposal.proposalId,
      tenantId,
      userId,
      state === 'PENDING_REVIEW' ? 'REVIEW_REQUESTED' : state,
      `DECISION_${state}`,
    );
  }
}

function guardDecisionLifecycleMutation(
  record: DecisionRecord,
  operation: string,
  options: {
    allowPartialRecovery?: boolean;
    allowExecution?: { actionId: string; idempotencyKey: string };
  } = {},
): void {
  const blockingStatuses = options.allowPartialRecovery ? ['started'] : ['started', 'partially_failed'];
  const placeholders = blockingStatuses.map(() => '?').join(', ');
  const execution = getDb().prepare(`
    SELECT action_execution_id AS executionId, action_id AS actionId, idempotency_key AS idempotencyKey,
           status, lease_expires_at AS leaseExpiresAt
      FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN (${placeholders})
       AND NOT (action_id = ? AND idempotency_key = ?)
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `).get(
    record.itemId,
    record.userId,
    record.tenantId,
    ...blockingStatuses,
    options.allowExecution?.actionId ?? '',
    options.allowExecution?.idempotencyKey ?? '',
  ) as { executionId: string; actionId: string; idempotencyKey: string; status: string; leaseExpiresAt: string | null } | undefined;
  if (!execution) return;
  throw new DecisionActionError(
    execution.status === 'partially_failed'
      ? 'DECISION_EXECUTION_RECOVERY_REQUIRED'
      : 'DECISION_ACTION_IN_PROGRESS',
    execution.status === 'partially_failed'
      ? 'This decision has an uncertain partial execution. Reconcile it before changing the proposal lifecycle.'
      : 'This decision is currently executing. Wait for the verified outcome before changing it.',
    409,
    {
      operation,
      actionExecutionId: execution.executionId,
      actionId: execution.actionId,
      executionStatus: execution.status,
      leaseExpiresAt: execution.leaseExpiresAt,
    },
  );
}

function guardDecisionDependencies(record: DecisionRecord, actionId: string): void {
  if (actionId === 'open_detail' || actionId === 'dismiss' || actionId === 'snooze' || actionId === 'not_now' || actionId === 'undo_reflow') {
    return;
  }
  const blockedByDecisionIds = dependencyStateForRecord(record).blockedByDecisionIds;
  if (blockedByDecisionIds.length === 0) return;
  throw new DecisionActionError('DECISION_DEPENDENCY_BLOCKED', 'Resolve the blocking decision before running this action.', 409, {
    blockedByDecisionIds,
  });
}

function decisionContextVersion(record: DecisionRecord): string | null {
  return normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)?.contextVersion ?? null;
}

function decisionContextExpiresAt(record: DecisionRecord): string | undefined {
  const contextExpiry = decisionContextForRecord(record).contextExpiresAt;
  if (typeof contextExpiry === 'string' && Number.isFinite(Date.parse(contextExpiry))) return contextExpiry;
  return record.expiresAt ?? record.decisionDeadline ?? undefined;
}

function logicalActionHashForAttempt(
  record: DecisionRecord,
  actionId: string,
  payload: Record<string, unknown>,
): string {
  const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  return logicalActionAttemptHash(normalized?.logicalActionHash ?? `legacy:${record.itemId}`, actionId, payload);
}

/**
 * Bind client-supplied action parameters to the proposal the user actually
 * reviewed. Transport payloads can select an advertised option or provide an
 * explicitly editable value, but they cannot silently retarget a decision.
 */
function validatedDecisionActionPayload(
  record: DecisionRecord,
  actionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (actionId === 'choose_another_time') {
    const startAt = normalizeTimestamp(typeof payload.startAt === 'string' ? payload.startAt : null);
    const endAt = normalizeTimestamp(typeof payload.endAt === 'string' ? payload.endAt : null);
    if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_REQUIRED',
        'Choosing another time requires a valid advertised start and end window.',
        400,
      );
    }
    const advice = secretaryReflowChoiceAdvice(record);
    const advertised = advice ? [
      { startAt: advice.recommendedStartAt, endAt: advice.recommendedEndAt },
      ...advice.alternatives,
    ] : [];
    const selectedWasAdvertised = advertised.some((candidate) =>
      candidate.startAt && candidate.endAt
      && Date.parse(candidate.startAt) === Date.parse(startAt)
      && Date.parse(candidate.endAt) === Date.parse(endAt));
    if (!selectedWasAdvertised) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_MISMATCH',
        'The selected window is not part of the current reviewed proposal. Refresh or edit the proposal first.',
        409,
      );
    }
    return { startAt, endAt };
  }

  if (actionId === 'mark_paid') {
    const relatedMonth = record.relatedEntityType === 'finance_tax_event'
      && typeof record.relatedEntityId === 'string'
      && /^\d{4}-\d{2}$/.test(record.relatedEntityId)
      ? record.relatedEntityId
      : null;
    const suppliedMonth = typeof payload.month === 'string' ? payload.month : null;
    if (!relatedMonth || (suppliedMonth != null && suppliedMonth !== relatedMonth)) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_MISMATCH',
        'The payment action must target the tax event attached to this decision.',
        409,
      );
    }
    // Canonicalize absent and explicitly supplied values to one logical action.
    return { month: relatedMonth };
  }

  if (actionId === 'add_meal') {
    const target = record.relatedEntityType === 'meal_plan' && typeof record.relatedEntityId === 'string'
      ? record.relatedEntityId.match(/^(\d{4}-\d{2}-\d{2}):([^:]+)$/)
      : null;
    const date = typeof payload.date === 'string' ? payload.date : null;
    const mealType = typeof payload.mealType === 'string'
      ? payload.mealType
      : typeof payload.meal_type === 'string' ? payload.meal_type : null;
    if (!target || date !== target[1] || mealType !== target[2]) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_MISMATCH',
        'The meal action must target the date and meal slot attached to this decision.',
        409,
      );
    }
    return {
      date,
      mealType,
      title: payload.title,
      ...(typeof payload.notes === 'string' ? { notes: payload.notes } : {}),
    };
  }

  return payload;
}

function validateExpectedDecisionVersion(
  record: DecisionRecord,
  expectedVersion: number | undefined,
  requiredForAction: boolean,
): void {
  if (expectedVersion != null && (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0)) {
    throw new DecisionActionError('DECISION_VERSION_INVALID', 'expectedVersion must be a positive integer', 400);
  }
  const enforced = requiredForAction && decisionFlowV1EnforcedForRecord(record);
  if (expectedVersion == null && enforced) {
    throw new DecisionActionError('DECISION_VERSION_REQUIRED', 'This decision action requires the current record version.', 428, {
      ...decisionVersionConflictDetails(record),
    });
  }
  if (expectedVersion != null && expectedVersion !== record.recordVersion) {
    logger.info({
      event: 'decision.version_conflict',
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      expectedVersion,
      currentVersion: record.recordVersion,
    }, 'Decision optimistic-concurrency conflict');
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision changed in another session. Refresh before acting.',
      409,
      decisionVersionConflictDetails(record),
    );
  }
}

function decisionVersionConflictDetails(
  record: DecisionRecord | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  let currentItem: DecisionApiItem | null = null;
  if (record) {
    try {
      currentItem = formatDecisionItemForApi(record);
    } catch (err) {
      logger.warn({
        event: 'decision.version_conflict_projection_failed',
        err,
        decisionId: record.itemId,
        userId: record.userId,
        tenantId: record.tenantId,
      }, 'Could not include the current safe Decision Center item in a version-conflict response');
    }
  }
  return {
    currentVersion: record?.recordVersion ?? null,
    decisionState: record ? durableDecisionStateForRecord(record) : null,
    updatedAt: record?.updatedAt ?? null,
    currentItem,
    ...extra,
  };
}

function revalidateDecisionActionForExecution(
  record: DecisionRecord,
  actionId: string,
  expectedContextVersion?: string,
  payload: Record<string, unknown> = {},
): ConflictEvaluation | null {
  const actionOverride = actionId === 'undo_reflow'
    ? secretaryRollbackActionForRecord(record)
    : actionId === 'choose_another_time'
      ? secretarySelectedWindowActionForRecord(record, payload)
      : undefined;
  return revalidateDecisionContext(record, expectedContextVersion, {
    confirmationGranted: true,
    ...(actionOverride ? { actionOverride } : {}),
  });
}

async function refreshTrainingCapacityForDecisionExecution(
  record: DecisionRecord,
  actionId: string,
  executionId: string,
): Promise<void> {
  if (actionId !== 'activate_training_plan_revision') return;
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const capacity = action?.preconditions.find((precondition) =>
    precondition.type === 'training_capacity_context' && precondition.required);
  if (!capacity) return;
  const expectedContextVersion = capacity.expectedVersion;
  if (!expectedContextVersion) {
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'Calendar capacity approval context is incomplete. Refresh the plan before activation.',
      409,
      { reasonCode: 'TRAINING_M4_CAPACITY_EXPECTED_VERSION_MISSING' },
    );
  }
  try {
    const snapshots = await import('./training-m4-capacity-snapshots');
    const refreshed = await snapshots.refreshTrainingM4CapacityContextForDecision({
      scope: { userId: record.userId, tenantId: record.tenantId },
      expectedContextVersion,
      executionId,
    });
    if (refreshed.contextVersion !== expectedContextVersion) {
      throw new Error('TRAINING_M4_CAPACITY_CHANGED_AFTER_REVIEW');
    }
  } catch (error) {
    const reasonCode = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'TRAINING_M4_CAPACITY_REFRESH_FAILED')
      : error instanceof Error ? error.message : 'TRAINING_M4_CAPACITY_REFRESH_FAILED';
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'Calendar capacity changed or could not be freshly verified after review. Refresh the plan before activation.',
      409,
      { reasonCode },
    );
  }
}

function secretarySelectedWindowActionForRecord(
  record: DecisionRecord,
  payload: Record<string, unknown>,
): NormalizedDecisionAction {
  const stored = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const start = typeof payload.startAt === 'string' ? normalizeTimestamp(payload.startAt) : null;
  const end = typeof payload.endAt === 'string' ? normalizeTimestamp(payload.endAt) : null;
  if (!stored || !start || !end || Date.parse(start) >= Date.parse(end)) {
    throw new DecisionActionError(
      'DECISION_ACTION_PAYLOAD_MISMATCH',
      'The selected Secretary window is not bound to a current normalized proposal.',
      409,
    );
  }
  return buildNormalizedDecisionAction({
    intent: stored.intent,
    targetEntities: stored.targetEntities,
    affectedResources: stored.affectedResources,
    requestedWindow: {
      start,
      end,
      timezone: stored.requestedWindow?.timezone ?? decisionContextForRecord(record).timezone ?? 'UTC',
    },
    preconditions: stored.preconditions,
    expectedEffects: stored.expectedEffects,
    prohibitedEffects: stored.prohibitedEffects,
    dependencies: stored.dependencies,
    exclusivityKeys: stored.exclusivityKeys,
    authorizationScope: stored.authorizationScope,
    risk: stored.risk,
    reversibility: stored.reversibility,
    contextVersion: stored.contextVersion,
  });
}

function secretaryRollbackActionForRecord(record: DecisionRecord): NormalizedDecisionAction {
  const storedAction = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const rollback = record.actionResult?.rollback;
  const expectedRevision = typeof record.actionResult?.rollbackExpectedRevision === 'string'
    ? record.actionResult.rollbackExpectedRevision
    : null;
  const previous = rollback && typeof rollback === 'object' && !Array.isArray(rollback)
    ? (rollback as Record<string, unknown>).previous
    : null;
  if (record.sourceSkill !== 'secretary'
      || record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId
      || !expectedRevision || !previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new DecisionActionError(
      'DECISION_ROLLBACK_UNAVAILABLE',
      'This rollback does not have a complete, current Secretary state contract.',
      409,
    );
  }
  const prior = previous as Record<string, unknown>;
  const priorStart = stringOrNull(prior.startAt);
  const priorEnd = stringOrNull(prior.endAt);
  const timezone = storedAction?.requestedWindow?.timezone
    ?? decisionContextForRecord(record).timezone
    ?? 'UTC';
  const requestedWindow = priorStart && priorEnd
    && Number.isFinite(Date.parse(priorStart)) && Number.isFinite(Date.parse(priorEnd))
    && Date.parse(priorStart) < Date.parse(priorEnd)
    ? { start: priorStart, end: priorEnd, timezone }
    : undefined;
  const localDay = requestedWindow
    ? DateTime.fromISO(requestedWindow.start, { setZone: true }).setZone(timezone).toISODate()
    : null;
  return buildNormalizedDecisionAction({
    intent: 'undo_secretary_reflow',
    targetEntities: [{ type: 'secretary_agenda_item', id: record.relatedEntityId, version: expectedRevision }],
    affectedResources: storedAction?.affectedResources.length
      ? storedAction.affectedResources
      : [{ type: 'secretary_agenda_item', id: record.relatedEntityId }],
    ...(requestedWindow ? { requestedWindow } : {}),
    preconditions: [{
      type: 'agenda_state',
      ref: record.relatedEntityId,
      expectedVersion: expectedRevision,
      required: true,
    }],
    expectedEffects: [{ type: 'restore_prior_agenda_state', targetRef: `secretary_agenda_item:${record.relatedEntityId}` }],
    prohibitedEffects: [{ type: 'overwrite_changed_agenda_state', targetRef: `secretary_agenda_item:${record.relatedEntityId}` }],
    dependencies: storedAction?.dependencies ?? [],
    exclusivityKeys: storedAction?.exclusivityKeys.length
      ? storedAction.exclusivityKeys
      : [localDay
          ? `calendar_timeline:${record.tenantId}:${localDay}`
          : `secretary_agenda_item:${record.tenantId}:${record.relatedEntityId}`],
    authorizationScope: storedAction?.authorizationScope.length
      ? storedAction.authorizationScope
      : ['calendar:write'],
    risk: storedAction?.risk ?? 'medium',
    reversibility: 'reversible',
    contextVersion: storedAction?.contextVersion ?? `rollback:${record.itemId}:${expectedRevision}`,
  });
}

function revalidateDecisionContext(
  record: DecisionRecord,
  expectedContextVersion?: string,
  options: {
    confirmationGranted?: boolean;
    replacementApproved?: boolean;
    actionOverride?: NormalizedDecisionAction;
  } = {},
): ConflictEvaluation | null {
  const storedAction = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  if (expectedContextVersion && storedAction?.contextVersion !== expectedContextVersion) {
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed and must be reviewed again.', 409, {
      currentContextVersion: storedAction?.contextVersion ?? null,
    });
  }
  const action = options.actionOverride ?? storedAction;
  if (!action) return null;
  const mode = getDecisionConflictPolicyV1Mode(process.env, { userId: record.userId, tenantId: record.tenantId });
  const approved = durableDecisionStateForRecord(record) === 'approved' || options.confirmationGranted === true;
  const replacementApproved = options.replacementApproved === true
    || hasApprovedReplacementForContext(record, action.contextVersion);
  const revalidation = revalidateNormalizedDecisionAction({
    scope: { userId: record.userId, tenantId: record.tenantId },
    action,
    decisionId: record.itemId,
    additionalExisting: decisionContextForRecord(record).conflictComparisons ?? undefined,
    decisionApproved: approved,
    replacementApproved,
    confirmationApproved: approved,
    confidence: decisionContextForRecord(record).candidateConfidence ?? undefined,
    contextExpiresAt: decisionContextExpiresAt(record),
    candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
  });
  logger.info({
    event: 'decision.revalidation_changed',
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    mode,
    disposition: revalidation.conflictEvaluation.disposition,
    reasonCodes: revalidation.conflictEvaluation.reasonCodes,
    missingPermissionCount: revalidation.missingPermissions.length,
    failedPreconditionCount: revalidation.preconditions.filter((precondition) => !precondition.ok).length,
    contextSourcesHealthy: revalidation.contextSourcesHealthy,
  }, 'Decision context revalidated');
  const enforce = mode === 'active' || decisionFlowV1EnforcedForRecord(record);
  if (!enforce) return revalidation.conflictEvaluation;

  const conflict = revalidation.conflictEvaluation;
  const storedConflict = decisionContextForRecord(record).conflictEvaluation;
  const storedFindingKeys = conflictFindingKeys(storedConflict);
  const currentFindingKeys = conflictFindingKeys(conflict);
  if (options.confirmationGranted === true
    && currentFindingKeys.length > 0
    && (storedFindingKeys.length === 0 || storedFindingKeys.join('|') !== currentFindingKeys.join('|'))) {
    persistRevalidationFailure(record, conflict, 'conflicts_changed_after_review', 'ready_for_review');
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'The conflicts changed after this proposal was shown and require fresh review.', 409, {
      previousReasonCodes: storedConflict?.reasonCodes ?? [],
      currentReasonCodes: conflict.reasonCodes,
      contextVersion: conflict.contextVersion,
    });
  }
  if (conflict.disposition === 'allow' || conflict.disposition === 'auto_resolve') return conflict;
  if (conflict.disposition === 'needs_confirmation' && options.confirmationGranted !== true) {
    persistRevalidationFailure(record, conflict, 'current_tradeoff_requires_confirmation');
    throw new DecisionActionError('DECISION_CONFIRMATION_REQUIRED', 'The proposal has current tradeoffs that require confirmation.', 409, {
      reasonCodes: conflict.reasonCodes,
      contextVersion: conflict.contextVersion,
    });
  }
  if (conflict.disposition === 'stale') {
    persistRevalidationFailure(record, conflict, 'material_context_stale');
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed and must be reviewed again.', 409, {
      reasonCodes: conflict.reasonCodes,
      contextVersion: conflict.contextVersion,
    });
  }
  if (conflict.disposition === 'supersede') {
    persistRevalidationFailure(record, conflict, 'newer_decision_supersedes_proposal');
    throw new DecisionActionError('DECISION_SUPERSEDED', 'A newer decision supersedes this proposal.', 409, {
      winnerDecisionId: conflict.winnerDecisionId ?? null,
      reasonCodes: conflict.reasonCodes,
    });
  }
  const changedPreconditions = revalidation.preconditions.filter((precondition) =>
    !precondition.ok
    && precondition.reasonCode !== 'unsupported_required_precondition'
    && precondition.reasonCode !== 'precondition_source_unavailable');
  if (changedPreconditions.length > 0) {
    persistRevalidationFailure(record, conflict, 'authoritative_source_state_changed', 'ready_for_review');
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'The authoritative source state changed and this proposal requires fresh review.',
      409,
      {
        reasonCodes: conflict.reasonCodes,
        contextVersion: conflict.contextVersion,
        preconditions: changedPreconditions,
      },
    );
  }
  persistRevalidationFailure(
    record,
    conflict,
    conflict.disposition === 'suppress_duplicate' ? 'equivalent_decision_exists' : 'current_policy_blocks_action',
  );
  throw new DecisionActionError(
    conflict.disposition === 'suppress_duplicate' ? 'DECISION_DUPLICATE' : 'DECISION_CONFLICT_BLOCKED',
    conflict.disposition === 'suppress_duplicate'
      ? 'An equivalent decision already exists.'
      : 'The action is blocked by current policy, permissions, commitments, or preconditions.',
    409,
    {
      winnerDecisionId: conflict.winnerDecisionId ?? null,
      reasonCodes: conflict.reasonCodes,
      missingPermissions: revalidation.missingPermissions,
      preconditions: revalidation.preconditions.filter((precondition) => !precondition.ok),
    },
  );
}

/**
 * A failed current-state check must revoke any durable approval, not merely
 * reject one request while leaving the UI on an apparently approved version.
 * The state/context/version change and privacy-safe audit event are committed
 * together; a concurrent winner returns the normal version-conflict response.
 */
function persistRevalidationFailure(
  record: DecisionRecord,
  conflict: ConflictEvaluation,
  reason: string,
  nextStateOverride?: DurableDecisionState,
): void {
  const currentContext = decisionContextForRecord(record);
  const nextContext: DecisionLogicContext = {
    ...currentContext,
    conflictEvaluation: conflict,
  };
  const nextState: DurableDecisionState = nextStateOverride ?? (conflict.disposition === 'supersede'
    || conflict.disposition === 'suppress_duplicate'
    ? 'superseded'
    : conflict.disposition === 'needs_confirmation'
      ? 'ready_for_review'
      : 'blocked');
  const contextChanged = conflictMaterialKey(currentContext.conflictEvaluation) !== conflictMaterialKey(conflict);
  const stateChanged = durableDecisionStateForRecord(record) !== nextState;
  if (!contextChanged && !stateChanged) return;

  const now = appNowIso();
  getDb().transaction(() => {
    const intentUpdate = getDb().prepare(`
      UPDATE notification_intents
         SET decision_context_json = ?, context_version = ?
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
    `).run(
      JSON.stringify(nextContext),
      conflict.contextVersion,
      record.intentId,
      record.userId,
      record.tenantId,
    );
    if (intentUpdate.changes !== 1) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision context could not be invalidated safely.', 409);
    }
    const itemUpdate = getDb().prepare(`
      UPDATE notification_center_items
         SET decision_state = ?,
             status = CASE WHEN ? = 'superseded' THEN 'superseded'
                           WHEN status = 'actioned' THEN 'read'
                           ELSE status END,
             record_version = record_version + 1,
             updated_at = ?
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('dismissed', 'expired', 'superseded')
    `).run(
      nextState,
      nextState,
      now,
      record.itemId,
      record.userId,
      record.tenantId,
      record.recordVersion,
    );
    if (itemUpdate.changes !== 1) {
      throw new DecisionActionError('DECISION_VERSION_CONFLICT', 'Decision changed during revalidation.', 409, {
        ...decisionVersionConflictDetails(getDecisionRecord(record.itemId, record.userId, record.tenantId)),
      });
    }
    getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, 'revalidation_failed', ?, ?, ?, ?)
    `).run(
      `dle_${randomUUID()}`,
      record.itemId,
      record.userId,
      record.tenantId,
      nextState,
      reason,
      JSON.stringify({
        policyVersion: conflict.policyVersion,
        contextVersion: conflict.contextVersion,
        disposition: conflict.disposition,
        reasonCodes: conflict.reasonCodes,
        previousVersion: record.recordVersion,
        nextVersion: record.recordVersion + 1,
      }),
      now,
    );
  })();
}

function hasApprovedReplacementForContext(record: DecisionRecord, contextVersion: string): boolean {
  try {
    const rows = getDb().prepare(`
      SELECT metadata_json AS metadataJson
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'approved'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 10
    `).all(record.itemId, record.userId, record.tenantId) as Array<{ metadataJson: string | null }>;
    return rows.some((row) => {
      const metadata = safeParseJson<Record<string, unknown>>(row.metadataJson, {});
      return metadata.contextVersion === contextVersion
        && metadata.replacementChoiceId === 'replace_with_candidate';
    });
  } catch {
    return false;
  }
}

function hasStrongApprovalForCurrentVersion(record: DecisionRecord): boolean {
  try {
    const rows = getDb().prepare(`
      SELECT metadata_json AS metadataJson
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'approved'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 10
    `).all(record.itemId, record.userId, record.tenantId) as Array<{ metadataJson: string | null }>;
    return rows.some((row) => {
      const metadata = safeParseJson<Record<string, unknown>>(row.metadataJson, {});
      return metadata.confirmationStrength === 'strong'
        && metadata.nextVersion === record.recordVersion
        && metadata.contextVersion === decisionContextVersion(record);
    });
  } catch {
    return false;
  }
}

function conflictFindingKeys(conflict: ConflictEvaluation | null | undefined): string[] {
  if (!conflict) return [];
  return conflict.findings.map((finding) => [
    finding.class,
    finding.severity,
    finding.reasonCode,
    finding.conflictingDecisionId ?? '',
    finding.resourceKey ?? '',
  ].join(':')).sort();
}

function getExistingExecution(decisionId: string, actionId: string, userId: number, tenantId: number, idempotencyKey: string): any | null {
  return getDb().prepare(`
    SELECT * FROM decision_action_executions
     WHERE decision_id = ? AND action_id = ? AND user_id = ? AND tenant_id = ? AND idempotency_key = ?
     LIMIT 1
  `).get(decisionId, actionId, userId, tenantId, idempotencyKey) as any ?? null;
}

function getExistingLogicalExecution(userId: number, tenantId: number, logicalActionHash: string): any | null {
  return getDb().prepare(`
    SELECT * FROM decision_action_executions
     WHERE user_id = ? AND tenant_id = ? AND logical_action_hash = ?
       AND (status IN ('succeeded', 'partially_failed')
         OR (status = 'started' AND (lease_expires_at IS NULL OR datetime(lease_expires_at) > datetime('now'))))
     ORDER BY created_at ASC
     LIMIT 1
  `).get(userId, tenantId, logicalActionHash) as any ?? null;
}

type DecisionExecutionReconciliationOutcome = 'applied' | 'not_applied' | 'unknown' | 'none';

function expectedExecutionStateForAttempt(
  record: DecisionRecord,
  actionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (actionId === 'choose_another_time') {
    return {
      verifier: 'secretary_agenda_state',
      expectedLifecycleState: 'reflowed',
      targetStateHash: privacySafeStateHash({ startAt: payload.startAt, endAt: payload.endAt }),
    };
  }
  if (actionId === 'accept_reflow') {
    const context = decisionContextForRecord(record);
    return {
      verifier: 'secretary_agenda_state',
      expectedLifecycleState: 'reflowed',
      targetStateHash: privacySafeStateHash({
        startAt: context.recommendedStartAt ?? null,
        endAt: context.recommendedEndAt ?? null,
      }),
    };
  }
  if (actionId === 'undo_reflow') {
    return {
      verifier: 'secretary_rollback_state',
      expectedStateHash: privacySafeStateHash(record.actionResult?.rollback ?? null),
    };
  }
  if (actionId === 'mark_paid') {
    return { verifier: 'finance_tax_event', targetRef: record.relatedEntityId, expectedStatus: 'paid' };
  }
  if (actionId === 'add_meal') {
    return {
      verifier: 'cooking_meal_plan',
      targetRef: record.relatedEntityId,
      titleHash: privacySafeStateHash(typeof payload.title === 'string' ? payload.title.trim() : null),
    };
  }
  if (actionId === 'approve_script' || actionId === 'request_rewrite') {
    return {
      verifier: 'content_workflow_object',
      targetRef: contentWorkflowObjectIdForDecision(record),
      expectedApprovalState: actionId === 'approve_script' ? 'approved' : 'rejected',
    };
  }
  if (actionId === 'option_a' || actionId === 'option_b') {
    return { verifier: 'chat_pending_confirmation', targetRef: record.relatedEntityId, expectedStatus: 'cleared' };
  }
  if (actionId === 'accept_chat_action_fix') {
    return { verifier: 'decision_projection_only', expectedStatus: 'actioned' };
  }
  if (actionId === 'activate_training_plan_revision') {
    return {
      verifier: 'training_active_plan_reference',
      targetRef: record.relatedEntityId,
      expectedStatus: 'ACTIVE',
    };
  }
  return { verifier: 'registered_executor_readback', actionId };
}

function privacySafeStateHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function reconcilePartialDecisionExecution(record: DecisionRecord): DecisionExecutionReconciliationOutcome {
  const execution = getDb().prepare(`
    SELECT action_execution_id AS executionId, action_id AS actionId,
           expected_effect_json AS expectedEffectJson
      FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `).get(record.itemId, record.userId, record.tenantId) as {
    executionId: string;
    actionId: string;
    expectedEffectJson: string | null;
  } | undefined;
  if (!execution) return 'none';

  const expected = safeParseJson<Record<string, unknown>>(execution.expectedEffectJson, {});
  const verification = verifyUncertainDecisionExecution(record, execution.actionId, expected);
  if (verification.outcome === 'unknown') {
    getDb().prepare(`
      UPDATE decision_action_executions
         SET error_code = 'DECISION_MANUAL_RECONCILIATION_REQUIRED',
             recovery_json = ?
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
    `).run(JSON.stringify({
      message: 'Nexus could not prove whether the external effect completed. The action remains blocked to prevent a duplicate; review the source system before contacting support.',
      actions: [{ id: 'open_detail', label: 'Review details', style: 'secondary' }],
    }), execution.executionId, record.userId, record.tenantId);
    logger.warn({
      event: 'decision.execution_reconciliation_required',
      decisionId: record.itemId,
      actionExecutionId: execution.executionId,
      actionId: execution.actionId,
      userId: record.userId,
      tenantId: record.tenantId,
    }, 'Decision execution remains blocked because authoritative state is indeterminate');
    return 'unknown';
  }

  const reconciledAt = appNowIso();
  getDb().transaction(() => {
    if (verification.outcome === 'applied') {
      const effects = expectedEffectResultsForExecution(execution.executionId, 'succeeded');
      const executionUpdate = getDb().prepare(`
        UPDATE decision_action_executions
           SET status = 'succeeded', result_json = ?, effect_results_json = ?,
               recovery_json = '{}', error_code = NULL, completed_at = ?, failed_at = NULL
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(
        JSON.stringify(verification.actualEffect),
        JSON.stringify(effects),
        reconciledAt,
        execution.executionId,
        record.userId,
        record.tenantId,
      );
      assertDecisionScopedUpdateApplied(executionUpdate, 'reconcile_partial_execution_succeeded', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
      getDb().prepare(`
        UPDATE decision_exclusivity_claims
           SET status = 'succeeded', updated_at = ?
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(reconciledAt, execution.executionId, record.userId, record.tenantId);
      const itemUpdate = getDb().prepare(`
        UPDATE notification_center_items
           SET status = 'actioned', actioned_at = COALESCE(actioned_at, ?),
               action_result_json = CASE WHEN status = 'actioned' THEN action_result_json ELSE ? END,
               record_version = record_version + 1, updated_at = ?
         WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
           AND status NOT IN ('dismissed', 'expired', 'superseded')
      `).run(
        reconciledAt,
        JSON.stringify({ actionId: execution.actionId, reconciled: true, ...verification.actualEffect }),
        reconciledAt,
        record.itemId,
        record.userId,
        record.tenantId,
        record.recordVersion,
      );
      assertDecisionScopedUpdateApplied(itemUpdate, 'reconcile_partial_execution_item_succeeded', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
    } else {
      const effects = expectedEffectResultsForExecution(execution.executionId, 'failed', 'authoritative_state_not_applied');
      const executionUpdate = getDb().prepare(`
        UPDATE decision_action_executions
           SET status = 'failed', result_json = ?, effect_results_json = ?, recovery_json = '{}',
               error_code = 'DECISION_EXECUTION_RECONCILED_NOT_APPLIED', failed_at = ?
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(
        JSON.stringify(verification.actualEffect),
        JSON.stringify(effects),
        reconciledAt,
        execution.executionId,
        record.userId,
        record.tenantId,
      );
      assertDecisionScopedUpdateApplied(executionUpdate, 'reconcile_partial_execution_not_applied', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
      getDb().prepare(`
        UPDATE decision_exclusivity_claims
           SET status = 'failed', updated_at = ?
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(reconciledAt, execution.executionId, record.userId, record.tenantId);
      const itemUpdate = getDb().prepare(`
        UPDATE notification_center_items
           SET status = 'failed', decision_state = 'ready_for_review', action_result_json = ?,
               record_version = record_version + 1, updated_at = ?
         WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
           AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
      `).run(
        JSON.stringify({ actionId: execution.actionId, errorCode: 'DECISION_EXECUTION_RECONCILED_NOT_APPLIED' }),
        reconciledAt,
        record.itemId,
        record.userId,
        record.tenantId,
        record.recordVersion,
      );
      assertDecisionScopedUpdateApplied(itemUpdate, 'reconcile_partial_execution_item_not_applied', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
    }
  })();
  emitDecisionLifecycleEvent({
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    event: 'execution_reconciled',
    actionId: execution.actionId,
    toStatus: verification.outcome === 'applied' ? 'actioned' : 'ready_for_review',
    reason: verification.outcome === 'applied' ? 'authoritative_state_applied' : 'authoritative_state_not_applied',
  });
  logger.info({
    event: 'decision.execution_recovered',
    decisionId: record.itemId,
    actionExecutionId: execution.executionId,
    actionId: execution.actionId,
    outcome: verification.outcome,
    userId: record.userId,
    tenantId: record.tenantId,
  }, 'Decision partial execution was reconciled against authoritative source state');
  return verification.outcome;
}

function verifyUncertainDecisionExecution(
  record: DecisionRecord,
  actionId: string,
  expected: Record<string, unknown>,
): { outcome: Exclude<DecisionExecutionReconciliationOutcome, 'none'>; actualEffect: Record<string, unknown> } {
  if (record.status === 'actioned' && record.actionResult?.actionId === actionId) {
    return { outcome: 'applied', actualEffect: { decisionProjectionAlreadyActioned: true } };
  }
  if (actionId === 'activate_training_plan_revision'
      && record.relatedEntityType === 'training_plan_revision'
      && record.relatedEntityId) {
    const evidence = getDb().prepare(`
      SELECT revisions.lifecycle_state AS revisionState,
             revisions.approval_state AS approvalState,
             refs.active_revision_id AS activeRevisionId,
             refs.projection_plan_id AS projectionPlanId,
             refs.pointer_version AS pointerVersion,
             plans.status AS planStatus,
             plans.source_revision_id AS planSourceRevisionId,
             approvals.action_execution_id AS approvalExecutionId,
             approvals.approved_content_hash AS approvedContentHash
        FROM training_plan_revisions revisions
        LEFT JOIN training_active_plan_references refs
          ON refs.tenant_id = revisions.tenant_id
         AND refs.user_id = revisions.user_id
         AND refs.family_id = revisions.family_id
         AND refs.active_revision_id = revisions.revision_id
        LEFT JOIN fitness_training_plans plans
          ON plans.id = refs.projection_plan_id
         AND plans.tenant_id = revisions.tenant_id
         AND plans.user_id = revisions.user_id
        LEFT JOIN training_plan_revision_approvals approvals
          ON approvals.tenant_id = revisions.tenant_id
         AND approvals.user_id = revisions.user_id
         AND approvals.revision_id = revisions.revision_id
         AND approvals.decision_id = ?
       WHERE revisions.revision_id = ?
         AND revisions.user_id = ? AND revisions.tenant_id = ?
       LIMIT 1
    `).get(
      record.itemId,
      record.relatedEntityId,
      record.userId,
      record.tenantId,
    ) as {
      revisionState: string;
      approvalState: string;
      activeRevisionId: string | null;
      projectionPlanId: number | null;
      pointerVersion: number | null;
      planStatus: string | null;
      planSourceRevisionId: string | null;
      approvalExecutionId: string | null;
      approvedContentHash: string | null;
    } | undefined;
    const outbox = getDb().prepare(`
      SELECT idempotency_key AS idempotencyKey
        FROM event_outbox
       WHERE tenant_id = ? AND user_id = ?
         AND event_type = 'training.plan_revision.activated.v1'
         AND entity_id = ?
         AND idempotency_key = ?
       LIMIT 1
    `).get(
      record.tenantId,
      record.userId,
      record.relatedEntityId,
      `training.plan_revision.activated:${record.relatedEntityId}`,
    ) as { idempotencyKey: string } | undefined;
    const applied = evidence?.revisionState === 'ACTIVE'
      && evidence.approvalState === 'APPROVED'
      && evidence.activeRevisionId === record.relatedEntityId
      && evidence.projectionPlanId != null
      && evidence.planStatus === 'active'
      && evidence.planSourceRevisionId === record.relatedEntityId
      && !!evidence.approvalExecutionId
      && !!evidence.approvedContentHash
      && !!outbox;
    if (applied) {
      return {
        outcome: 'applied',
        actualEffect: {
          trainingState: 'ACTIVE',
          activeRevisionId: record.relatedEntityId,
          projectionPlanId: evidence.projectionPlanId,
          pointerVersion: evidence.pointerVersion,
          activationOutboxPresent: true,
        },
      };
    }
    const cleanlyNotApplied = !!evidence
      && evidence.revisionState === 'PENDING_REVIEW'
      && evidence.approvalState === 'PENDING'
      && evidence.activeRevisionId == null
      && evidence.projectionPlanId == null
      && evidence.approvalExecutionId == null
      && !outbox;
    return cleanlyNotApplied
      ? { outcome: 'not_applied', actualEffect: { trainingState: 'PENDING_REVIEW' } }
      : { outcome: 'unknown', actualEffect: { trainingState: evidence?.revisionState ?? 'missing', partialEvidence: true } };
  }
  if (actionId === 'mark_paid' && record.relatedEntityType === 'finance_tax_event' && record.relatedEntityId) {
    const year = Number(record.relatedEntityId.slice(0, 4));
    const event = getTaxEvents(record.userId, { year, tenantId: record.tenantId })
      .find((candidate) => candidate.month === record.relatedEntityId);
    if (!event) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    return event.status === 'paid'
      ? { outcome: 'applied', actualEffect: { paymentStatus: 'paid', targetRef: record.relatedEntityId } }
      : { outcome: 'not_applied', actualEffect: { paymentStatus: event.status, targetRef: record.relatedEntityId } };
  }
  if ((actionId === 'approve_script' || actionId === 'request_rewrite')) {
    const objectId = contentWorkflowObjectIdForDecision(record);
    const object = objectId ? getContentWorkflowObject(record.userId, objectId, record.tenantId) : null;
    if (!object) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    const expectedState = actionId === 'approve_script' ? 'approved' : 'rewrite_requested';
    const sourceMatches = actionId === 'approve_script'
      ? object.productionState === 'approved' && object.approvalState === 'approved'
      : object.productionState === 'active'
        && object.approvalState === 'not_required'
        && hasContentRewriteDecisionEvidence(record, object.id);
    if (sourceMatches) {
      return { outcome: 'applied', actualEffect: { contentObjectId: object.id, contentApprovalState: expectedState } };
    }
    // `active`/`not_required` is also the ordinary state after a user resumes
    // editing. Without the deterministic Decision receipt and its matching
    // audit event, recovery cannot attribute that state to request_rewrite.
    // Keep the execution uncertain so a retry cannot overwrite newer work.
    if (actionId === 'request_rewrite'
        && object.productionState === 'active'
        && object.approvalState === 'not_required') {
      return {
        outcome: 'unknown',
        actualEffect: {
          contentObjectId: object.id,
          contentApprovalState: object.approvalState,
          explicitDecisionEvidence: false,
        },
      };
    }
    if (!['approved', 'rejected'].includes(object.approvalState)) {
      return { outcome: 'not_applied', actualEffect: { contentObjectId: object.id, contentApprovalState: object.approvalState } };
    }
    return { outcome: 'unknown', actualEffect: { contentObjectId: object.id, contentApprovalState: object.approvalState } };
  }
  if ((actionId === 'accept_reflow' || actionId === 'choose_another_time')
      && record.relatedEntityType === 'secretary_agenda_item' && record.relatedEntityId) {
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (!agenda) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    if (agenda.lifecycleState === 'reflowed' && agenda.decisionAction === 'reflowed') {
      const selectedHash = privacySafeStateHash({ startAt: agenda.startAt, endAt: agenda.endAt });
      if (typeof expected.targetStateHash !== 'string' || expected.targetStateHash === selectedHash) {
        return { outcome: 'applied', actualEffect: { lifecycleState: 'reflowed', targetStateHash: selectedHash } };
      }
      return { outcome: 'unknown', actualEffect: { lifecycleState: agenda.lifecycleState, targetStateHash: selectedHash } };
    }
    const expectedRevision = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)
      ?.preconditions.find((precondition) => precondition.type === 'agenda_state' && precondition.ref === record.relatedEntityId)
      ?.expectedVersion;
    return expectedRevision && secretaryAgendaStateRevision(agenda) === expectedRevision
      ? { outcome: 'not_applied', actualEffect: { lifecycleState: agenda.lifecycleState } }
      : { outcome: 'unknown', actualEffect: { lifecycleState: agenda.lifecycleState } };
  }
  if (actionId === 'undo_reflow'
      && record.relatedEntityType === 'secretary_agenda_item'
      && record.relatedEntityId) {
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (!agenda) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    const rollback = record.actionResult?.rollback;
    const previous = rollback && typeof rollback === 'object' && !Array.isArray(rollback)
      ? (rollback as Record<string, unknown>).previous
      : null;
    const redactExplanation = !!previous && typeof previous === 'object' && !Array.isArray(previous)
      && !Object.prototype.hasOwnProperty.call(previous, 'explanation');
    const actualStateHash = privacySafeStateHash(secretaryAgendaRollbackSnapshot(agenda, { redactExplanation }));
    if (typeof expected.expectedStateHash === 'string' && expected.expectedStateHash === actualStateHash) {
      return { outcome: 'applied', actualEffect: { rollbackStateHash: actualStateHash } };
    }
    return { outcome: 'unknown', actualEffect: { rollbackStateHash: actualStateHash } };
  }
  if (actionId === 'add_meal' && record.relatedEntityType === 'meal_plan' && record.relatedEntityId) {
    const target = record.relatedEntityId.match(/^(\d{4}-\d{2}-\d{2}):([^:]+)$/);
    if (!target) return { outcome: 'unknown', actualEffect: { sourceState: 'invalid_target' } };
    const meal = getMealPlan(record.userId, target[1], target[1], record.tenantId)
      .find((candidate) => candidate.meal_type === target[2]);
    if (!meal) return { outcome: 'not_applied', actualEffect: { mealPlanState: 'missing' } };
    const titleHash = privacySafeStateHash(meal.title);
    return typeof expected.titleHash !== 'string' || expected.titleHash === titleHash
      ? { outcome: 'applied', actualEffect: { mealPlanId: meal.id, mealPlanState: 'present', titleHash } }
      : { outcome: 'unknown', actualEffect: { mealPlanId: meal.id, mealPlanState: 'different_value', titleHash } };
  }
  if (actionId === 'accept_chat_action_fix') {
    return { outcome: 'applied', actualEffect: { providerActionExecuted: false, freshConfirmationRequired: true } };
  }
  if (actionId === 'option_a' || actionId === 'option_b') {
    const pending = getPendingChatConfirmation(record.userId, record.tenantId);
    if (pending && (!record.relatedEntityId || pending.id === record.relatedEntityId)) {
      return { outcome: 'not_applied', actualEffect: { pendingConfirmationState: 'present' } };
    }
    return { outcome: 'applied', actualEffect: { pendingConfirmationState: 'cleared' } };
  }
  return { outcome: 'unknown', actualEffect: { verifier: expected.verifier ?? 'unavailable' } };
}

/**
 * Proves that the canonical review-to-active transition was the exact rewrite
 * action for this Decision, rather than an unrelated user or agent edit.
 * Both durable records are required: the receipt gives idempotent mutation
 * identity and the workflow event gives human-auditable action provenance.
 */
function hasContentRewriteDecisionEvidence(record: DecisionRecord, objectId: number): boolean {
  const parentKey = `decision-content:${record.itemId}:request_rewrite`;
  const compactKey = `${parentKey}:rewrite_requested`;
  const receiptKey = compactKey.length <= 200
    ? compactKey
    : `${parentKey.slice(0, 180)}:rewrite_requested`;
  const receipt = getDb().prepare(`
    SELECT resource_id AS resourceId, result_metadata_json AS resultMetadataJson
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
     LIMIT 1
  `).get(
    record.tenantId,
    record.userId,
    `transition_item:${objectId}`,
    receiptKey,
  ) as { resourceId: string; resultMetadataJson: string } | undefined;
  if (!receipt || String(receipt.resourceId) !== String(objectId)) return false;
  const receiptMetadata = safeParseJson<Record<string, unknown>>(receipt.resultMetadataJson, {});
  if (receiptMetadata.changed !== true) return false;

  const events = getDb().prepare(`
    SELECT metadata_json AS metadataJson, reason_codes_json AS reasonCodesJson
      FROM content_workflow_events
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND object_id = ? AND action = 'workspace_changes_requested'
       AND from_state = 'review' AND to_state = 'active'
       AND approval_state = 'not_required' AND review_required = 0
     ORDER BY id DESC
     LIMIT 20
  `).all(record.tenantId, record.userId, String(objectId)) as Array<{
    metadataJson: string;
    reasonCodesJson: string;
  }>;
  return events.some((event) => {
    const reasonCodes = safeParseJson<unknown[]>(event.reasonCodesJson, []);
    if (!reasonCodes.includes('changes_requested')) return false;
    const metadata = safeParseJson<Record<string, unknown>>(event.metadataJson, {});
    const audit = metadata.auditContext;
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return false;
    const context = audit as Record<string, unknown>;
    return context.action === 'request_rewrite'
      && context.decisionId === record.itemId
      && (context.source === 'decision_center' || context.source === 'decision_center_command_bus');
  });
}

function reclaimExpiredExecutionLeases(userId: number, tenantId: number): void {
  const reclaimed = getDb().transaction(() => {
    const executions = getDb().prepare(`
      UPDATE decision_action_executions
         SET status = 'partially_failed', error_code = 'DECISION_EXECUTION_LEASE_EXPIRED',
             failed_at = COALESCE(failed_at, datetime('now')),
             effect_results_json = ?,
             recovery_json = ?
       WHERE user_id = ? AND tenant_id = ? AND status = 'started'
         AND ((lease_expires_at IS NOT NULL AND datetime(lease_expires_at) <= datetime('now'))
           OR (lease_expires_at IS NULL AND datetime(created_at, ?) <= datetime('now')))
    `).run(
      JSON.stringify([{
        effectId: 'decision_action',
        status: 'unknown',
        reasonCode: 'execution_lease_expired',
      }]),
      JSON.stringify({
        message: 'The previous execution lease expired with an uncertain external outcome. Refresh source state before any recovery.',
        actions: [{ id: 'refresh', label: 'Refresh', style: 'secondary' }],
      }),
      userId,
      tenantId,
      `+${DECISION_EXECUTION_LEASE_SECONDS} seconds`,
    ).changes;
    getDb().prepare(`
      UPDATE decision_exclusivity_claims
         SET status = 'partially_failed', updated_at = datetime('now')
       WHERE user_id = ? AND tenant_id = ? AND status = 'started'
         AND datetime(lease_expires_at) <= datetime('now')
    `).run(userId, tenantId);
    return executions;
  })();
  if (reclaimed > 0) {
    logger.warn({ event: 'decision.execution_lease_uncertain', userId, tenantId, count: reclaimed }, 'Expired execution leases require source reconciliation');
  }
}

function claimExecution(
  record: DecisionRecord,
  actionId: string,
  idempotencyKey: string,
  executorSkill: string,
  options: {
    logicalActionHash: string | null;
    expectedVersion: number;
    contextVersion: string | null;
    mutateRecordVersion: boolean;
    expectedEffect: Record<string, unknown>;
  },
): { isNew: boolean; execution: any } {
  const db = getDb();
  return db.transaction(() => {
    const existing = getExistingExecution(record.itemId, actionId, record.userId, record.tenantId, idempotencyKey);
    if (existing) return { isNew: false, execution: existing };

    if (options.logicalActionHash) {
      const logical = getExistingLogicalExecution(record.userId, record.tenantId, options.logicalActionHash);
      if (logical) return { isNew: false, execution: logical };
    }

    const executionId = `dae_${randomUUID()}`;
    const leaseExpiresAt = DateTime.utc().plus({ seconds: DECISION_EXECUTION_LEASE_SECONDS }).toISO()!;
    const normalizedAction = options.logicalActionHash
      ? normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)
      : null;

    if (options.mutateRecordVersion) {
      const versionClaim = db.prepare(`
        UPDATE notification_center_items
           SET record_version = record_version + 1,
               decision_state = 'approved',
               updated_at = datetime('now')
         WHERE item_id = ? AND user_id = ? AND tenant_id = ?
           AND record_version = ?
           AND (status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
                OR (? = 1 AND status = 'actioned'))
      `).run(record.itemId, record.userId, record.tenantId, options.expectedVersion, actionId === 'undo_reflow' ? 1 : 0);
      if (versionClaim.changes !== 1) {
        const current = getDecisionRecord(record.itemId, record.userId, record.tenantId);
        throw new DecisionActionError(
          'DECISION_VERSION_CONFLICT',
          'Decision changed before execution could be claimed.',
          409,
          decisionVersionConflictDetails(current),
        );
      }
    }

    for (const exclusivityKey of normalizedAction?.exclusivityKeys ?? []) {
      const exclusivityClaim = db.prepare(`
        INSERT INTO decision_exclusivity_claims (
          user_id, tenant_id, exclusivity_key, action_execution_id, decision_id,
          context_version, status, lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, datetime('now'), datetime('now'))
        ON CONFLICT(user_id, tenant_id, exclusivity_key) DO UPDATE SET
          action_execution_id = excluded.action_execution_id,
          decision_id = excluded.decision_id,
          context_version = excluded.context_version,
          status = 'started',
          lease_expires_at = excluded.lease_expires_at,
          updated_at = datetime('now')
        WHERE decision_exclusivity_claims.status IN ('succeeded', 'failed', 'expired')
      `).run(
        record.userId,
        record.tenantId,
        exclusivityKey,
        executionId,
        record.itemId,
        options.contextVersion,
        leaseExpiresAt,
      );
      if (exclusivityClaim.changes !== 1) {
        const owner = db.prepare(`
          SELECT decision_id AS decisionId, lease_expires_at AS leaseExpiresAt
            FROM decision_exclusivity_claims
           WHERE user_id = ? AND tenant_id = ? AND exclusivity_key = ?
           LIMIT 1
        `).get(record.userId, record.tenantId, exclusivityKey) as { decisionId: string; leaseExpiresAt: string } | undefined;
        throw new DecisionActionError('DECISION_RESOURCE_BUSY', 'Another decision is already modifying the same resource.', 409, {
          exclusivityKey,
          conflictingDecisionId: owner?.decisionId ?? null,
          leaseExpiresAt: owner?.leaseExpiresAt ?? null,
        });
      }
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id, idempotency_key,
        executor_skill, status, expected_effect_json, result_json, logical_action_hash,
        expected_record_version, context_version, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, '{}', ?, ?, ?, ?)
    `).run(
      executionId,
      record.itemId,
      actionId,
      record.userId,
      record.tenantId,
      idempotencyKey,
      executorSkill,
      JSON.stringify(options.expectedEffect),
      options.logicalActionHash,
      options.expectedVersion,
      options.contextVersion,
      leaseExpiresAt,
    );

    const execution = getExistingExecution(record.itemId, actionId, record.userId, record.tenantId, idempotencyKey)
      ?? (options.logicalActionHash ? getExistingLogicalExecution(record.userId, record.tenantId, options.logicalActionHash) : null);
    if (!execution) {
      throw new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action execution could not be claimed', 500);
    }
    if (insert.changes === 1) {
      logger.info({
        event: 'decision.execution_claimed',
        decisionId: record.itemId,
        actionId,
        userId: record.userId,
        tenantId: record.tenantId,
        exclusivityKeyCount: normalizedAction?.exclusivityKeys.length ?? 0,
      }, 'Decision execution claimed');
    }
    return { isNew: insert.changes === 1, execution };
  })();
}

function idempotentActionResult(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  execution: any,
): DecisionActionResult {
  if (typeof execution.decision_id === 'string' && execution.decision_id !== decisionId) {
    retireLogicalDuplicateDecision(decisionId, execution.decision_id, userId, tenantId);
  }
  // Same direct-record path as performDecisionAction's success branch: a duplicate (idempotent) replay of
  // an action that mutated its own source state — e.g. choose_another_time moving the agenda — must return
  // the actioned decision, not be hidden by getDecisionItem's active-inbox visibility filter (which would
  // throw a spurious 404 on a replay of a write that already succeeded).
  const replayRecord = getDecisionRecord(decisionId, userId, tenantId);
  if (actionId === 'approve_product_learning_case'
      && replayRecord?.relatedEntityType === 'product_learning_case'
      && replayRecord.relatedEntityId
      && typeof execution.action_execution_id === 'string') {
    recordLearningCaseReviewApproval({
      tenantId,
      userId,
      caseId: replayRecord.relatedEntityId,
      actionExecutionId: execution.action_execution_id,
    });
  }
  const current = replayRecord && isDecisionRecord(replayRecord) ? formatDecisionItemForApi(replayRecord) : null;
  if (!current) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after idempotent action', 404);
  return {
    actionId,
    status: 'idempotent',
    idempotent: true,
    item: current,
    verification: {
      readBackOk: true,
      expectedEffect: safeParseJson(execution.expected_effect_json, {}),
      actualEffect: safeParseJson(execution.result_json, {}),
      message: 'Duplicate action returned the original verified result.',
    },
  };
}

function retireLogicalDuplicateDecision(
  decisionId: string,
  canonicalDecisionId: string,
  userId: number,
  tenantId: number,
): void {
  const update = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'superseded', decision_state = 'superseded',
           superseded_by_item_id = ?,
           action_result_json = ?,
           record_version = record_version + 1,
           updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(
    canonicalDecisionId,
    JSON.stringify({ supersededReason: 'logical_action_completed_by_related_decision' }),
    decisionId,
    userId,
    tenantId,
  );
  if (update.changes === 1) {
    resolveDecisionConflictAudit(decisionId, userId, tenantId, 'superseded_by_verified_execution');
    emitDecisionLifecycleEvent({
      decisionId,
      userId,
      tenantId,
      event: 'superseded',
      toStatus: 'superseded',
      reason: 'logical_action_completed_by_related_decision',
      metadata: { canonicalDecisionId },
    });
  }
}

async function waitForExistingExecution(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): Promise<DecisionActionResult> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const execution = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
    if (!execution || execution.status === 'started') continue;
    if (execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, execution);
    }
    throw executionReplayError(execution, 'Prior decision action attempt failed');
  }

  throw new DecisionActionError('DECISION_ACTION_IN_PROGRESS', 'Decision action is already in progress', 409);
}

async function waitForExecutionById(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  executionId: string,
): Promise<DecisionActionResult> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const execution = getDb().prepare(`
      SELECT * FROM decision_action_executions
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(executionId, userId, tenantId) as any;
    if (!execution || execution.status === 'started') continue;
    if (execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, execution);
    }
    throw executionReplayError(execution, 'Prior logical decision action attempt failed');
  }
  throw new DecisionActionError('DECISION_ACTION_IN_PROGRESS', 'Decision action is already in progress', 409);
}

function executionReplayError(execution: any, message: string): DecisionActionError {
  const partial = execution?.status === 'partially_failed';
  return new DecisionActionError(
    partial ? 'DECISION_PARTIALLY_FAILED' : execution?.error_code || 'DECISION_ACTION_FAILED',
    partial ? 'The prior attempt partially completed and requires recovery review.' : message,
    409,
    {
      ...safeParseJson(execution?.result_json, {}),
      effectResults: safeParseJson(execution?.effect_results_json, []),
      recovery: safeParseJson(execution?.recovery_json, {}),
      originalErrorCode: execution?.error_code ?? null,
    },
  );
}

async function executeDecisionAction(
  record: DecisionRecord,
  action: NotificationActionButton,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  expectedVersion?: number,
  actionExecutionId?: string,
): Promise<{
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
}> {
  if (action.id === 'open_detail') {
    markNotificationCenterItemRead(record.itemId, userId, tenantId);
    return verifiedStatusEffect(record, 'read', 'Decision was marked viewed.');
  }

  const commandBusExecution = await maybeExecuteDecisionActionViaCommandBus(record, action, userId, tenantId, idempotencyKey);
  if (commandBusExecution) return commandBusExecution;

  if (action.id === 'dismiss' || action.id === 'reject_reflow' || action.id === 'not_now') {
    const item = dismissDecision(record.itemId, userId, tenantId, undefined, expectedVersion, {
      actionId: action.id,
      idempotencyKey,
    });
    markDecisionAction(record.decisionLogId, action.id);
    return {
      readBackOk: item.status === 'dismissed',
      expectedEffect: { decisionStatus: 'dismissed' },
      actualEffect: { decisionStatus: item.status, decisionOutcomeRecorded: true },
      message: 'Decision was declined/dismissed.',
    };
  }

  if (action.id === 'snooze') {
    const item = snoozeDecision(record.itemId, userId, tenantId, Number(payload.minutes ?? 60), expectedVersion, {
      actionId: action.id,
      idempotencyKey,
    });
    markDecisionAction(record.decisionLogId, action.id);
    return {
      readBackOk: item.status === 'snoozed',
      expectedEffect: { decisionStatus: 'snoozed' },
      actualEffect: { decisionStatus: item.status, snoozedUntil: item.snoozedUntil },
      message: 'Decision was snoozed.',
    };
  }

  if (action.id === 'approve_script' || action.id === 'request_rewrite') {
    return executeContentApprovalDecision(record, action.id, userId, tenantId);
  }

  if (action.id === 'accept_reflow' || action.id === 'choose_another_time') {
    return executeSecretaryAgendaDecision(record, action.id, userId, tenantId, payload);
  }

  if (action.id === 'undo_reflow') {
    return executeSecretaryReflowRollback(record, userId, tenantId);
  }

  if (action.id === 'mark_paid') {
    return executeFinancePaymentDecision(record, userId, tenantId, payload);
  }

  if (action.id === 'add_meal') {
    return executeCookingMealDecision(record, userId, tenantId, payload);
  }

  if (action.id === 'option_a' || action.id === 'option_b') {
    return executeChatClarificationDecision(record, action.id, userId, tenantId);
  }

  if (action.id === 'accept_chat_action_fix') {
    return executeChatFixerDecision(record, userId, tenantId);
  }

  if (action.id === 'activate_training_plan_revision') {
    if (record.sourceSkill !== 'training'
        || record.relatedEntityType !== 'training_plan_revision'
        || !record.relatedEntityId
        || !actionExecutionId) {
      throw new DecisionActionError(
        'TRAINING_REVISION_DECISION_CONTRACT_INVALID',
        'This Training activation decision is missing its immutable revision contract.',
        409,
      );
    }
    const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
    const target = normalized?.targetEntities.find((entry) =>
      entry.type === 'training_plan_revision' && entry.id === record.relatedEntityId);
    if (!normalized || !target?.version) {
      throw new DecisionActionError(
        'TRAINING_REVISION_DECISION_CONTRACT_INVALID',
        'This Training activation decision cannot prove the approved revision version.',
        409,
      );
    }
    const activation = await import('./training-plan-revision-activation');
    try {
      const result = await activation.activateApprovedTrainingPlanRevision({
        scope: { userId, tenantId },
        revisionId: record.relatedEntityId,
        approval: {
          decisionId: record.itemId,
          decisionRecordVersion: expectedVersion ?? record.recordVersion,
          actionExecutionId,
          approvedContentHash: target.version,
          approvedContextVersion: normalized.contextVersion,
        },
      });
      const readBackOk = result.activeReference.activeRevisionId === record.relatedEntityId
        && result.projection.planId === result.activeReference.projectionPlanId;
      return persistProjectionAfterVerifiedSourceEffect('training_activation_effect', () => {
        const projection = markDecisionActioned(record, action.id, {
          trainingState: 'ACTIVE',
          planState: 'active',
          activeRevisionId: result.revisionId,
          familyId: result.familyId,
          projectionPlanId: result.projection.planId,
          pointerVersion: result.activeReference.pointerVersion,
          rollbackAvailable: false,
        }, 'The approved Training plan revision was activated and verified.');
        return {
          readBackOk: readBackOk && projection.readBackOk,
        expectedEffect: {
          trainingState: 'ACTIVE',
          activeRevisionId: record.relatedEntityId,
          decisionStatus: 'actioned',
        },
        actualEffect: {
          ...projection.actualEffect,
          trainingState: 'ACTIVE',
          planState: 'active',
          activeRevisionId: result.revisionId,
          familyId: result.familyId,
          projectionPlanId: result.projection.planId,
          pointerVersion: result.activeReference.pointerVersion,
          rollbackAvailable: false,
        },
        message: 'The approved Training plan revision was activated and verified.',
        };
      });
    } catch (error) {
      const lockError = trainingOperationLockPublicError(error);
      if (lockError) {
        throw new DecisionActionError(
          lockError.code,
          lockError.message,
          lockError.status,
          lockError.details,
        );
      }
      if (error instanceof activation.TrainingPlanRevisionError) {
        throw new DecisionActionError(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  }

  if (action.id === 'approve_product_learning_case') {
    if (record.sourceSkill !== 'training'
        || record.relatedEntityType !== 'product_learning_case'
        || !record.relatedEntityId
        || !actionExecutionId) {
      throw new DecisionActionError(
        'PRODUCT_LEARNING_REVIEW_CONTRACT_INVALID',
        'This learning review decision is missing its exact scoped case contract.',
        409,
      );
    }
    const learningCase = getLearningCase(tenantId, userId, record.relatedEntityId);
    if (!learningCase || learningCase.lifecycle !== 'candidate') {
      throw new DecisionActionError(
        'PRODUCT_LEARNING_CASE_NOT_CANDIDATE',
        'This learning case is no longer a reviewable candidate.',
        409,
      );
    }
    return markDecisionActioned(record, action.id, {
      productLearningCaseId: learningCase.id,
      approved: true,
      approvalReference: learningReviewApprovalReferenceForExecution(actionExecutionId),
    }, 'The exact product learning case review was approved and durably recorded.');
  }

  // Navigation-only: acknowledge and route the client to connection settings.
  // No provider state changes here, so there is nothing to read back — the
  // user completes re-auth in the app. This replaces `retry`, whose executor
  // never existed and which therefore always rendered disabled.
  if (action.id === 'reconnect') {
    return markDecisionActioned(
      record,
      action.id,
      { navigatedTo: 'nexus://connections', providerReauthRequired: true },
      'Opening connection settings.',
    );
  }

  if (MUTATING_ACTIONS.has(action.id)) {
    throw new DecisionActionError(
      'UNSUPPORTED_DECISION_EXECUTOR',
      'This decision action needs a deterministic executor before Nexus can run it.',
      409,
      { actionId: action.id, sourceSkill: record.sourceSkill, relatedEntityType: record.relatedEntityType },
    );
  }

  throw new DecisionActionError('UNSUPPORTED_DECISION_ACTION', 'This decision action is not supported yet.', 409, { actionId: action.id });
}

async function maybeExecuteDecisionActionViaCommandBus(
  record: DecisionRecord,
  action: NotificationActionButton,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): Promise<{
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} | null> {
  if (!isDecisionCenterCommandBusEnabled(process.env, { userId, tenantId })) return null;
  const item = getDecisionItem(record.itemId, userId, tenantId);
  if (!item) return null;

  const adapter = await import('./decision-command-adapter');
  if (!adapter.isDecisionActionBusEligible({ actionId: action.id, item })) return null;
  if ((action.id === 'approve_script' || action.id === 'request_rewrite')
      && !directOwnedContentObjectForDecision(item, userId, tenantId)) return null;

  try {
    const result = await adapter.runDecisionActionViaCommandBus({
      item,
      actionId: action.id,
      userId,
      tenantId,
      idempotencyKey,
      locale: decisionContextForRecord(record).locale,
    });
    markDecisionAction(record.decisionLogId, action.id);
    return result;
  } catch (err) {
    if (err instanceof adapter.DecisionCommandAdapterError) {
      throw new DecisionActionError(err.code, err.message, err.status, err.details);
    }
    throw err;
  }
}

function verifiedStatusEffect(record: DecisionRecord, expected: string, message: string): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const actual = getDecisionRecord(record.itemId, record.userId, record.tenantId)?.status ?? null;
  const readBackOk = actual === expected;
  if (!readBackOk) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision action read-back verification failed', 409, {
      expectedStatus: expected,
      actualStatus: actual,
    });
  }
  return {
    readBackOk,
    expectedEffect: { decisionStatus: expected },
    actualEffect: { decisionStatus: actual },
    message,
  };
}

function executeSecretaryAgendaDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'secretary' || record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) {
    throw new DecisionActionError(
      'UNSUPPORTED_DECISION_EXECUTOR',
      'Secretary reflow actions require a persisted Secretary agenda item before Nexus can run them.',
      409,
      { relatedEntityType: record.relatedEntityType },
    );
  }

  const initialAgenda = getSecretaryAgendaItemById({ agendaItemId: record.relatedEntityId, ownerUserId: userId, tenantId });
  if (!initialAgenda) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Secretary agenda item was not found for this user.', 404);
  }
  const expectedAgendaRevision = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)
    ?.preconditions.find((precondition) =>
      precondition.type === 'agenda_state' && precondition.ref === record.relatedEntityId)?.expectedVersion;
  const applied = getDb().transaction(() => {
    const agenda = getSecretaryAgendaItemById({ agendaItemId: record.relatedEntityId!, ownerUserId: userId, tenantId });
    if (!agenda) {
      throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Secretary agenda item was not found for this user.', 404);
    }
    if (expectedAgendaRevision && secretaryAgendaStateRevision(agenda) !== expectedAgendaRevision) {
      throw new DecisionActionError(
        'DECISION_CONTEXT_CHANGED',
        'The Secretary agenda item changed before the reflow could be applied.',
        409,
        { reason: 'agenda_state_changed' },
      );
    }
    const rollback = secretaryAgendaRollbackSnapshot(agenda, {
      redactExplanation: isDecisionRollbackSnapshotProtectionEnabled(process.env, { userId, tenantId })
        && (record.privacyPolicy === 'financial' || record.privacyPolicy === 'sensitive'),
    });
    const updates = buildSecretaryAgendaUpdates(actionId, agenda, payload);
    const agendaUpdate = getDb().prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = ?,
             decision_action = ?,
             decision_reason_codes_json = ?,
             decision_explanation = ?,
             start_at = COALESCE(?, start_at),
             end_at = COALESCE(?, end_at),
             scheduled_segments_json = ?,
             updated_at = datetime('now')
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
    `).run(
      updates.lifecycleState,
      updates.decisionAction,
      JSON.stringify(updates.reasonCodes),
      updates.explanation,
      updates.startAt,
      updates.endAt,
      JSON.stringify(updates.startAt && updates.endAt ? [{ start: updates.startAt, end: updates.endAt, label: 'Decision Center choice' }] : agenda.scheduledSegments),
      agenda.agendaItemId,
      userId,
      String(tenantId),
    );
    assertDecisionScopedUpdateApplied(agendaUpdate, 'secretary_agenda_decision_update', {
      agendaItemId: agenda.agendaItemId,
      userId,
      tenantId,
    });

    const verified = getSecretaryAgendaItemById({ agendaItemId: agenda.agendaItemId, ownerUserId: userId, tenantId });
    const readBackOk = verified?.lifecycleState === updates.lifecycleState
      && verified.decisionAction === updates.decisionAction
      && (!updates.startAt || verified.startAt === updates.startAt)
      && (!updates.endAt || verified.endAt === updates.endAt);
    if (!readBackOk) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Secretary reflow read-back verification failed', 409, {
        expectedLifecycleState: updates.lifecycleState,
        actualLifecycleState: verified?.lifecycleState ?? null,
        expectedDecisionAction: updates.decisionAction,
        actualDecisionAction: verified?.decisionAction ?? null,
      });
    }
    return { agenda, rollback, updates, verified: verified! };
  }).immediate();
  const { agenda, rollback, verified } = applied;

  return persistProjectionAfterVerifiedSourceEffect('secretary_agenda_effect', () => (
    markDecisionActioned(record, actionId, {
      secretaryAgendaItemId: agenda.agendaItemId,
      lifecycleState: verified.lifecycleState,
      decisionAction: verified.decisionAction,
      startAt: verified.startAt,
      endAt: verified.endAt,
      rollbackAvailable: true,
      rollbackActionId: 'undo_reflow',
      rollbackExpectedRevision: secretaryAgendaStateRevision(verified),
      rollback,
    }, 'Secretary agenda decision was applied.')
  ));
}

function executeSecretaryReflowRollback(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const rollback = record.actionResult?.rollback;
  if (!rollback || typeof rollback !== 'object' || Array.isArray(rollback)) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'This decision does not have a reversible Secretary reflow.', 409);
  }
  const snapshot = rollback as Record<string, unknown>;
  if (snapshot.type !== 'secretary_agenda_item' || typeof snapshot.agendaItemId !== 'string') {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'This rollback contract is not valid for Secretary reflow.', 409);
  }
  if (snapshot.agendaItemId !== record.relatedEntityId) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'Rollback target no longer matches the decision related entity.', 409);
  }
  const previous = snapshot.previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'Rollback is missing the prior Secretary state.', 409);
  }
  const prior = previous as Record<string, unknown>;
  const expectedRevision = typeof record.actionResult?.rollbackExpectedRevision === 'string'
    ? record.actionResult.rollbackExpectedRevision
    : null;
  const expectedLifecycleState = stringOrDefault(prior.lifecycleState, 'proposed');
  const verified = getDb().transaction(() => {
    const currentAgenda = getSecretaryAgendaItemById({
      agendaItemId: snapshot.agendaItemId as string,
      ownerUserId: userId,
      tenantId,
    });
    if (!expectedRevision || !currentAgenda
        || secretaryAgendaStateRevision(currentAgenda) !== expectedRevision) {
      throw new DecisionActionError(
        'DECISION_CONTEXT_CHANGED',
        'The Secretary agenda item changed after reflow and cannot be safely restored without fresh review.',
        409,
        { reason: currentAgenda ? 'rollback_target_changed' : 'rollback_target_missing' },
      );
    }
    const agendaUpdate = getDb().prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = ?,
             decision_action = ?,
             decision_reason_codes_json = ?,
             decision_explanation = ?,
             start_at = ?,
             end_at = ?,
             scheduled_segments_json = ?,
             updated_at = datetime('now')
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
    `).run(
      expectedLifecycleState,
      stringOrNull(prior.decisionAction),
      JSON.stringify(Array.isArray(prior.reasonCodes) ? prior.reasonCodes : []),
      stringOrNull(prior.explanation),
      stringOrNull(prior.startAt),
      stringOrNull(prior.endAt),
      JSON.stringify(Array.isArray(prior.scheduledSegments) ? prior.scheduledSegments : []),
      snapshot.agendaItemId,
      userId,
      String(tenantId),
    );
    assertDecisionScopedUpdateApplied(agendaUpdate, 'secretary_reflow_rollback_agenda_update', {
      agendaItemId: snapshot.agendaItemId,
      userId,
      tenantId,
    });

    const readBack = getSecretaryAgendaItemById({ agendaItemId: snapshot.agendaItemId as string, ownerUserId: userId, tenantId });
    if (!readBack || readBack.lifecycleState !== expectedLifecycleState) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Secretary rollback read-back verification failed', 409, {
        expectedLifecycleState,
        actualLifecycleState: readBack?.lifecycleState ?? null,
      });
    }
    return readBack;
  }).immediate();

  return persistProjectionAfterVerifiedSourceEffect('secretary_rollback_effect', () => {
    const decisionUpdate = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'actioned', decision_state = 'cancelled', action_result_json = ?,
             record_version = record_version + 1, updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND EXISTS (
           SELECT 1 FROM decision_action_executions executions
            WHERE executions.decision_id = notification_center_items.item_id
              AND executions.user_id = notification_center_items.user_id
              AND executions.tenant_id = notification_center_items.tenant_id
              AND executions.action_id = 'undo_reflow'
              AND executions.status = 'started'
         )
    `).run(JSON.stringify({
      actionId: 'undo_reflow',
      rollbackApplied: true,
      rollbackAvailable: false,
      secretaryAgendaItemId: snapshot.agendaItemId,
      lifecycleState: verified.lifecycleState,
      decisionAction: verified.decisionAction,
    }), record.itemId, userId, tenantId, record.recordVersion + 1);
    assertDecisionScopedUpdateApplied(decisionUpdate, 'secretary_reflow_rollback_decision_update', {
      decisionId: record.itemId,
      userId,
      tenantId,
    });
    markDecisionAction(record.decisionLogId, 'undo_reflow');

    return {
      readBackOk: true,
      expectedEffect: { secretaryAgendaLifecycleState: expectedLifecycleState, decisionStatus: 'actioned', executionStatus: 'rolled_back' },
      actualEffect: {
        secretaryAgendaItemId: snapshot.agendaItemId,
        lifecycleState: verified.lifecycleState,
        decisionAction: verified.decisionAction,
        decisionStatus: 'actioned',
        executionStatus: 'rolled_back',
        rollbackAvailable: false,
      },
      message: 'Secretary reflow was undone. This decision is complete; any new change requires a fresh proposal.',
    };
  });
}

function secretaryAgendaRollbackSnapshot(agenda: SecretaryAgendaItem, opts: { redactExplanation?: boolean } = {}): Record<string, unknown> {
  // The machine fields below are exactly what executeSecretaryReflowRollback restores. `explanation` is the
  // free-text display copy — the most sensitive field; B2 (redactExplanation) omits it for financial/sensitive
  // decisions so it is not persisted in plaintext at rest. The rollback reader tolerates a missing explanation
  // (stringOrNull -> null), so omitting it never breaks undo. OFF keeps the snapshot byte-identical.
  const previous: Record<string, unknown> = {
    lifecycleState: agenda.lifecycleState,
    decisionAction: agenda.decisionAction,
    reasonCodes: agenda.decisionReasonCodes,
    explanation: agenda.decisionExplanation,
    startAt: agenda.startAt,
    endAt: agenda.endAt,
    scheduledSegments: agenda.scheduledSegments,
  };
  // Delete (not skip) so the OFF path keeps the original key order — byte-identical stored snapshot.
  if (opts.redactExplanation) delete previous.explanation;
  return { type: 'secretary_agenda_item', agendaItemId: agenda.agendaItemId, previous };
}

function buildSecretaryAgendaUpdates(
  actionId: string,
  agenda: SecretaryAgendaItem,
  payload: Record<string, unknown>,
): {
  lifecycleState: string;
  decisionAction: string;
  reasonCodes: string[];
  explanation: string;
  startAt: string | null;
  endAt: string | null;
} {
  if (actionId === 'choose_another_time') {
    const startAt = typeof payload.startAt === 'string' ? payload.startAt : null;
    const endAt = typeof payload.endAt === 'string' ? payload.endAt : null;
    if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) {
      throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Choosing another time requires valid startAt and endAt values.', 400);
    }
    return {
      lifecycleState: 'reflowed',
      decisionAction: 'reflowed',
      reasonCodes: ['decision_center_user_selected_alternative_time'],
      explanation: 'User selected an alternate time in Decision Center.',
      startAt,
      endAt,
    };
  }

  if (!agenda.startAt || !agenda.endAt) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Accepting reflow requires a Secretary agenda item with a proposed time.', 400);
  }
  return {
    lifecycleState: 'reflowed',
    decisionAction: 'reflowed',
    reasonCodes: ['decision_center_user_accepted_reflow'],
    explanation: 'User accepted Secretary reflow in Decision Center.',
    startAt: null,
    endAt: null,
  };
}

function executeFinancePaymentDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'finance') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Finance payment action can only run for Finance decisions.', 409);
  }
  const month = typeof payload.month === 'string'
    ? payload.month
    : record.relatedEntityType === 'finance_tax_event'
      ? record.relatedEntityId
      : null;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Finance payment decisions require a YYYY-MM tax event month.', 400);
  }
  if (record.relatedEntityType !== 'finance_tax_event' || month !== record.relatedEntityId) {
    throw new DecisionActionError(
      'DECISION_ACTION_PAYLOAD_MISMATCH',
      'Finance payment target no longer matches the reviewed tax event.',
      409,
    );
  }

  if (!markTaxPaid(userId, month, { tenantId })) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Finance tax event was not found for this user.', 404);
  }
  const year = Number(month.slice(0, 4));
  const verified = getTaxEvents(userId, { year, tenantId }).find((event) => event.month === month);
  if (verified?.status !== 'paid') {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Finance payment read-back verification failed', 409, {
      expectedStatus: 'paid',
      actualStatus: verified?.status ?? null,
    });
  }

  return persistProjectionAfterVerifiedSourceEffect('finance_payment_effect', () => (
    markDecisionActioned(record, 'mark_paid', {
      financeTaxMonth: month,
      paymentStatus: verified.status,
      paidAt: verified.paid_at,
    }, 'Finance payment was confirmed.')
  ));
}

function executeCookingMealDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'cooking') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Cooking meal action can only run for Cooking decisions.', 409);
  }
  const date = typeof payload.date === 'string' ? payload.date : null;
  const mealType = typeof payload.mealType === 'string' ? payload.mealType : typeof payload.meal_type === 'string' ? payload.meal_type : null;
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !mealType || !title) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Cooking decisions require date, mealType, and title before Nexus can update the meal plan.', 400);
  }

  const meal = setMealPlan(userId, date, mealType, title, {
    tenantId,
    notes: typeof payload.notes === 'string' ? payload.notes : 'Added from Decision Center',
  });
  const verified = getMealPlan(userId, date, date, tenantId).find((candidate) => candidate.id === meal.id);
  if (!verified || verified.title !== title || verified.meal_type !== mealType) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Cooking meal read-back verification failed', 409, {
      mealFound: !!verified,
      titleMatched: verified?.title === title,
      mealTypeMatched: verified?.meal_type === mealType,
    });
  }

  return persistProjectionAfterVerifiedSourceEffect('cooking_meal_effect', () => (
    markDecisionActioned(record, 'add_meal', {
      mealPlanId: verified.id,
      date: verified.date,
      mealType: verified.meal_type,
      title: verified.title,
    }, 'Cooking meal plan was updated.')
  ));
}

function executeChatClarificationDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'chat') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Chat clarification action can only run for Chat decisions.', 409);
  }
  const pending = getPendingChatConfirmation(userId, tenantId);
  if (!pending || (record.relatedEntityId && pending.id !== record.relatedEntityId)) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Chat clarification was not found or already expired.', 404);
  }
  clearPendingChatConfirmation(userId, tenantId);
  if (getPendingChatConfirmation(userId, tenantId)) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Chat clarification read-back verification failed', 409);
  }

  return persistProjectionAfterVerifiedSourceEffect('chat_confirmation_effect', () => (
    markDecisionActioned(record, actionId, {
      chatConfirmationId: pending.id,
      selectedOption: actionId,
      involvedSkills: pending.involvedSkills,
    }, 'Chat clarification was recorded.')
  ));
}

function executeChatFixerDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'chat' || record.relatedEntityType !== 'chat_action_fixer_review') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Chat fixer decision is missing a scoped fixer review.', 409);
  }
  if (record.userId !== userId || record.tenantId !== tenantId) {
    throw new DecisionActionError('DECISION_SCOPE_MISMATCH', 'Decision scope mismatch.', 403);
  }
  return markDecisionActioned(record, 'accept_chat_action_fix', {
    fixerReviewId: record.relatedEntityId,
    providerActionExecuted: false,
    freshConfirmationRequired: true,
  }, 'Chat action correction accepted. Nexus will require a fresh confirmation before any provider write.');
}

function markDecisionActioned(
  record: DecisionRecord,
  actionId: string,
  actualEffect: Record<string, unknown>,
  message: string,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const claimedVersion = record.recordVersion + 1;
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'actioned', decision_state = 'completed', actioned_at = datetime('now'), action_result_json = ?,
           updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
       AND EXISTS (
         SELECT 1 FROM decision_action_executions executions
          WHERE executions.decision_id = notification_center_items.item_id
            AND executions.user_id = notification_center_items.user_id
            AND executions.tenant_id = notification_center_items.tenant_id
            AND executions.action_id = ?
            AND executions.status = 'started'
       )
  `).run(
    JSON.stringify({ actionId, ...actualEffect }),
    record.itemId,
    record.userId,
    record.tenantId,
    claimedVersion,
    actionId,
  );
  assertDecisionScopedUpdateApplied(decisionUpdate, 'mark_decision_actioned', {
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    actionId,
    claimedVersion,
  });
  markDecisionAction(record.decisionLogId, actionId);
  const actualStatus = getDecisionRecord(record.itemId, record.userId, record.tenantId)?.status ?? null;
  if (actualStatus !== 'actioned') {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision status read-back verification failed', 409, {
      expectedStatus: 'actioned',
      actualStatus,
    });
  }
  return {
    readBackOk: true,
    expectedEffect: { decisionStatus: 'actioned' },
    actualEffect: { decisionStatus: actualStatus, ...actualEffect },
    message,
  };
}

function persistProjectionAfterVerifiedSourceEffect<T>(effectId: string, projection: () => T): T {
  try {
    return projection();
  } catch (error) {
    const transport = privacySafeTransportErrorDetails(error);
    throw new DecisionActionError(
      'DECISION_SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED',
      'The source effect completed, but Decision Center recovery is required before any retry.',
      500,
      {
        ...transport,
        outcomeState: 'source_effect_verified_projection_failed',
        effectResults: [
          { effectId, status: 'succeeded' },
          { effectId: 'decision_center_projection', status: 'unknown', reasonCode: 'projection_write_failed' },
        ],
      },
    );
  }
}

function executeContentApprovalDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'content') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Content approval decision is missing a content object.', 409);
  }
  const contentObjectId = contentWorkflowObjectIdForDecision(record);
  if (!contentObjectId) {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Content approval decision is missing a content object.', 409);
  }
  const object = getContentWorkflowObject(userId, contentObjectId, tenantId);
  if (!object) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Content object was not found for this user.', 404);
  }
  const decision = actionId === 'approve_script' ? 'approved' : 'rewrite_requested';
  const result = decideContentApproval({
    userId,
    tenantId,
    objectId: object.id,
    approvalType: 'content_review',
    expectedWorkflowVersion: object.workflowVersion,
    idempotencyKey: `decision-content:${record.itemId}:${actionId}`,
    decision,
    reason: actionId === 'request_rewrite' ? 'Requested changes from Decision Center' : null,
    metadata: { source: 'decision_center', decisionId: record.itemId, actionId },
  });
  if (!result.ok || !result.object) {
    throw new DecisionActionError('DECISION_ACTION_FAILED', 'Content approval could not be applied.', 409, { status: result.status });
  }

  const verified = getContentWorkflowObject(userId, object.id, tenantId);
  const expectedContentState = decision;
  const readBackOk = decision === 'approved'
    ? verified?.productionState === 'approved' && verified.approvalState === 'approved'
    : verified?.productionState === 'active' && verified.approvalState === 'not_required';
  if (!readBackOk) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Content approval read-back verification failed', 409, {
      expectedContentState,
      actualApprovalState: verified?.approvalState ?? null,
      actualProductionState: verified?.productionState ?? null,
    });
  }

  return persistProjectionAfterVerifiedSourceEffect('content_approval_effect', () => (
    markDecisionActioned(record, actionId, {
      contentObjectId: object.id,
      contentApprovalState: expectedContentState,
      workflowState: verified?.productionState,
    }, decision === 'approved' ? 'Content was approved.' : 'Changes were requested.')
  ));
}

function markExecutionSucceeded(
  executionId: string,
  userId: number,
  tenantId: number,
  expectedEffect: Record<string, unknown>,
  actualEffect: Record<string, unknown>,
): void {
  const effects = expectedEffectResultsForExecution(executionId, 'succeeded');
  getDb().transaction(() => {
    const executionUpdate = getDb().prepare(`
      UPDATE decision_action_executions
         SET status = 'succeeded',
             expected_effect_json = ?,
             result_json = ?,
             effect_results_json = ?,
             recovery_json = '{}',
             completed_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ?
         AND status = 'started'
    `).run(JSON.stringify(expectedEffect), JSON.stringify(actualEffect), JSON.stringify(effects), executionId, userId, tenantId);
    if (executionUpdate.changes !== 1) {
      throw new DecisionActionError(
        'DECISION_EXECUTION_STATE_CONFLICT',
        'Decision execution was no longer claimable when success was recorded.',
        409,
        { actionExecutionId: executionId },
      );
    }
    getDb().prepare(`
      UPDATE decision_exclusivity_claims
         SET status = 'succeeded', updated_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(executionId, userId, tenantId);
  })();
}

function reconcileCompletedExecutionAfterResponseFailure(
  executionId: string,
  userId: number,
  tenantId: number,
  execution: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
  },
): 'succeeded' | 'partially_failed' | 'unknown' {
  try {
    markExecutionSucceeded(executionId, userId, tenantId, execution.expectedEffect, execution.actualEffect);
    return 'succeeded';
  } catch (retryError) {
    logger.warn({
      event: 'decision.execution_success_reconciliation_retry_failed',
      err: retryError,
      executionId,
    }, 'Retrying the completed execution success write did not complete');
  }
  try {
    const current = getDb().prepare(`
      SELECT status FROM decision_action_executions
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? LIMIT 1
    `).get(executionId, userId, tenantId) as { status: string } | undefined;
    if (current?.status === 'succeeded') return 'succeeded';
    if (current?.status === 'partially_failed') return 'partially_failed';

    const successfulEffects = expectedEffectResultsForExecution(executionId, execution.readBackOk ? 'succeeded' : 'unknown');
    const effectResults: DecisionEffectResult[] = [
      ...successfulEffects,
      {
        effectId: 'nexus_execution_reconciliation',
        status: 'unknown',
        reasonCode: 'success_ledger_write_unconfirmed',
      },
    ];
    const recovery = {
      message: 'The external effect completed, but Nexus could not fully persist the success response. Refresh before any retry.',
      actions: [{ id: 'refresh', label: 'Refresh', style: 'secondary' }],
    };
    getDb().transaction(() => {
      const update = getDb().prepare(`
        UPDATE decision_action_executions
           SET status = 'partially_failed',
               error_code = 'DECISION_SUCCESS_RECONCILIATION_REQUIRED',
               expected_effect_json = ?, result_json = ?, effect_results_json = ?,
               recovery_json = ?, failed_at = datetime('now')
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
      `).run(
        JSON.stringify(execution.expectedEffect),
        JSON.stringify(execution.actualEffect),
        JSON.stringify(effectResults),
        JSON.stringify(recovery),
        executionId,
        userId,
        tenantId,
      );
      if (update.changes !== 1) {
        throw new Error('DECISION_EXECUTION_RECONCILIATION_STATE_CHANGED');
      }
      getDb().prepare(`
        UPDATE decision_exclusivity_claims
           SET status = 'partially_failed', updated_at = datetime('now')
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
      `).run(executionId, userId, tenantId);
    })();
    logger.warn({
      event: 'decision.execution_reconciliation_required',
      executionId,
    }, 'Completed effect retained as partially failed pending source reconciliation');
    return 'partially_failed';
  } catch (reconciliationError) {
    logger.error({
      event: 'decision.execution_reconciliation_persistence_failed',
      err: reconciliationError,
      executionId,
    }, 'Completed effect could not be moved out of the active execution state');
    return 'unknown';
  }
}

function isRetryableTrainingOperationDecisionError(error: DecisionActionError): boolean {
  return (error.code === 'TRAINING_OPERATION_LOCKED'
      || error.code === 'TRAINING_OPERATION_LOCK_UNAVAILABLE')
    && error.details?.operation === 'plan_activate'
    && typeof error.details.retryAfterSeconds === 'number'
    && Number.isFinite(error.details.retryAfterSeconds);
}

/**
 * Lock acquisition fails before the Training activation writes anything, so
 * consuming the Decision claim would turn a retryable 409/503 into a terminal
 * failed card. Restore the exact pre-claim row and remove only this execution
 * and its exclusivity claims. The version-qualified transaction refuses to
 * overwrite any concurrent Decision mutation.
 */
function releaseRetryableTrainingActivationExecution(
  record: DecisionRecord,
  executionId: string,
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const restored = db.prepare(`
      UPDATE notification_center_items
         SET status = ?, decision_state = ?, record_version = ?, updated_at = ?
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
         AND status = ? AND decision_state = 'approved' AND record_version = ?
    `).run(
      record.status,
      record.decisionState,
      record.recordVersion,
      record.updatedAt,
      record.itemId,
      record.userId,
      record.tenantId,
      record.status,
      record.recordVersion + 1,
    );
    if (restored.changes !== 1) return false;

    const removedExecution = db.prepare(`
      DELETE FROM decision_action_executions
       WHERE action_execution_id = ? AND decision_id = ?
         AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(executionId, record.itemId, record.userId, record.tenantId);
    if (removedExecution.changes !== 1) {
      throw new Error('DECISION_RETRYABLE_TRAINING_EXECUTION_RELEASE_FAILED');
    }
    db.prepare(`
      DELETE FROM decision_exclusivity_claims
       WHERE action_execution_id = ? AND decision_id = ?
         AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(executionId, record.itemId, record.userId, record.tenantId);
    return true;
  })();
}

function markExecutionFailed(
  executionId: string,
  userId: number,
  tenantId: number,
  errorCode: string,
  details?: Record<string, unknown>,
): 'failed' | 'partially_failed' {
  const uncertainOutcome = isUncertainDecisionExecutionOutcome(errorCode, details);
  const suppliedEffects = normalizeEffectResults(details?.effectResults);
  const inferredEffects = suppliedEffects.length > 0
    ? suppliedEffects
    : expectedEffectResultsForExecution(
      executionId,
      errorCode === 'DECISION_READBACK_MISMATCH' || uncertainOutcome ? 'unknown' : 'failed',
      errorCode,
    );
  const partiallyFailed = errorCode === 'DECISION_READBACK_MISMATCH'
    || uncertainOutcome
    || (
      inferredEffects.some((effect) => effect.status === 'succeeded' || effect.status === 'compensated')
      && inferredEffects.some((effect) => effect.status === 'failed' || effect.status === 'unknown')
    );
  const status = partiallyFailed ? 'partially_failed' : 'failed';
  const recovery = {
    message: partiallyFailed
      ? 'Some effects may have completed. Refresh source state before choosing a recovery action.'
      : 'The action did not complete. Refresh the decision before retrying.',
    actions: [{ id: 'refresh', label: 'Refresh', style: 'secondary' }],
  };
  getDb().transaction(() => {
    getDb().prepare(`
      UPDATE decision_action_executions
         SET status = ?,
             error_code = ?,
             result_json = ?,
             effect_results_json = ?,
             recovery_json = ?,
             failed_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ?
         AND status = 'started'
    `).run(
      status,
      errorCode,
      JSON.stringify(details ?? {}),
      JSON.stringify(inferredEffects),
      JSON.stringify(recovery),
      executionId,
      userId,
      tenantId,
    );
    getDb().prepare(`
      UPDATE decision_exclusivity_claims
         SET status = ?, updated_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(status, executionId, userId, tenantId);
  })();
  if (partiallyFailed) {
    logger.warn({ event: 'decision.execution_partially_failed', executionId, errorCode }, 'Decision execution partially failed');
  }
  return status;
}

export function isUncertainDecisionExecutionOutcome(
  errorCode: string,
  details?: Record<string, unknown>,
): boolean {
  const values = [
    errorCode,
    typeof details?.originalCode === 'string' ? details.originalCode : '',
    typeof details?.providerCode === 'string' ? details.providerCode : '',
    typeof details?.causeCode === 'string' ? details.causeCode : '',
    typeof details?.dispatchState === 'string' ? details.dispatchState : '',
    typeof details?.outcomeState === 'string' ? details.outcomeState : '',
  ].join(':').toUpperCase();
  return /TIMEOUT|TIMED_OUT|ETIMEDOUT|NETWORK|PROVIDER_NETWORK_ERROR|FETCH_FAILED|CONNECTION_(RESET|ABORTED|CLOSED)|ECONNRESET|ECONNABORTED|EPIPE|SOCKET_HANG_UP|UNKNOWN_PROVIDER_OUTCOME|DISPATCHED_OUTCOME_UNKNOWN|SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED/.test(values);
}

/**
 * Collapse a provider/network error chain into closed, non-sensitive codes.
 * Node fetch commonly exposes only `TypeError: fetch failed` at the top and a
 * transport code in `cause`; persisting neither raw message nor provider body
 * still lets the execution ledger fail safely as an uncertain outcome.
 */
function privacySafeTransportErrorDetails(error: unknown): {
  originalCode: string;
  causeCode?: string;
} {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string') codes.push(normalizeTransportCode(record.code));
    if (typeof record.message === 'string' && /fetch\s+failed/i.test(record.message)) codes.push('FETCH_FAILED');
    if (typeof record.name === 'string' && /timeout/i.test(record.name)) codes.push('TIMEOUT');
    current = record.cause;
  }
  const normalized = codes.filter((code) => code !== 'UNKNOWN');
  return {
    originalCode: normalized[0] ?? 'UNKNOWN',
    ...(normalized[1] ? { causeCode: normalized[1] } : {}),
  };
}

function normalizeTransportCode(value: string): string {
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9_:-]+/g, '_').slice(0, 80);
  return code || 'UNKNOWN';
}

function expectedEffectResultsForExecution(
  executionId: string,
  status: DecisionEffectResult['status'],
  reasonCode?: string,
): DecisionEffectResult[] {
  const row = getDb().prepare(`
    SELECT intents.normalized_action_json AS normalizedActionJson
      FROM decision_action_executions executions
      JOIN notification_center_items items
        ON items.item_id = executions.decision_id
       AND items.user_id = executions.user_id AND items.tenant_id = executions.tenant_id
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id AND intents.tenant_id = items.tenant_id
     WHERE executions.action_execution_id = ?
     LIMIT 1
  `).get(executionId) as { normalizedActionJson: string | null } | undefined;
  const action = row?.normalizedActionJson
    ? normalizeDecisionAction(safeParseJson(row.normalizedActionJson, null))
    : null;
  const effects = action?.expectedEffects ?? [];
  if (effects.length === 0) {
    return [{ effectId: 'decision_action', status, ...(reasonCode ? { reasonCode } : {}) }];
  }
  return effects.map((effect) => ({
    effectId: `${effect.type}:${effect.targetRef}`,
    status,
    ...(reasonCode ? { reasonCode } : {}),
  }));
}

function normalizeEffectResults(value: unknown): DecisionEffectResult[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.effectId !== 'string'
      || !['pending', 'succeeded', 'failed', 'compensated', 'unknown'].includes(String(candidate.status))) return [];
    return [{
      effectId: candidate.effectId,
      status: candidate.status as DecisionEffectResult['status'],
      ...(typeof candidate.reasonCode === 'string' ? { reasonCode: candidate.reasonCode } : {}),
    }];
  });
}

function markDecisionFailed(record: DecisionRecord, actionId: string, errorCode: string): void {
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'failed', decision_state = 'ready_for_review', action_result_json = ?,
           record_version = record_version + 1, updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed') AND record_version = ?
  `).run(
    JSON.stringify({ actionId, errorCode }),
    record.itemId,
    record.userId,
    record.tenantId,
    record.recordVersion,
  );
  if (decisionUpdate.changes !== 1) {
    logger.warn({
      event: 'decision.failure_projection_version_conflict',
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      actionId,
      errorCode,
      expectedVersion: record.recordVersion,
    }, 'Decision failure projection did not overwrite a concurrent lifecycle change');
    return;
  }
  logger.warn({ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId, actionId, errorCode }, 'Decision action failed without closing decision as actioned');
}

function markDecisionAction(decisionLogId: string | null, actionId: string): void {
  if (!decisionLogId) return;
  getDb().prepare(`
    UPDATE notification_decision_logs
       SET action_taken = ?, opened_at = COALESCE(opened_at, datetime('now'))
     WHERE decision_log_id = ?
  `).run(actionId, decisionLogId);
}

function sourceStateSupersessionReason(record: DecisionRecord): string | null {
  if (record.sourceSkill === 'content' && recordHasAction(record, CONTENT_APPROVAL_ACTION_IDS)) {
    const contentObjectId = contentWorkflowObjectIdForDecision(record);
    if (!contentObjectId) return 'content_object_missing';
    const object = getContentWorkflowObject(record.userId, contentObjectId, record.tenantId);
    if (!object) return 'content_object_missing';
    if (object.approvalState === 'approved' || object.approvalState === 'rejected') {
      return 'content_approval_resolved_elsewhere';
    }
  }
  if (record.sourceSkill === 'secretary' && record.relatedEntityType === 'task_attention_day') {
    const reason = secretaryDailyTaskAttentionSupersessionReason(record);
    if (reason) return reason;
  }
  if (record.sourceSkill === 'secretary' && recordHasAction(record, SECRETARY_REFLOW_ACTION_IDS)) {
    if (record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) {
      return 'secretary_reflow_missing_agenda_item';
    }
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (!agenda) return 'secretary_agenda_missing';
    if (['reflowed', 'scheduled', 'completed', 'canceled', 'superseded'].includes(agenda.lifecycleState)) {
      return 'calendar_conflict_resolved_elsewhere';
    }
  }
  if (record.sourceSkill === 'training') {
    if (record.relatedEntityType === 'training_plan_revision' && record.relatedEntityId
        && tableExists('training_plan_revisions')) {
      const revision = getDb().prepare(`
        SELECT lifecycle_state AS lifecycleState, approval_state AS approvalState,
               decision_id AS decisionId, content_hash AS contentHash,
               creation_context_version AS contextVersion
          FROM training_plan_revisions
         WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(record.relatedEntityId, record.userId, record.tenantId) as {
        lifecycleState: string;
        approvalState: string;
        decisionId: string | null;
        contentHash: string;
        contextVersion: string;
      } | undefined;
      if (!revision) return 'training_plan_revision_missing';
      if (revision.lifecycleState === 'ACTIVE') return 'training_plan_revision_activated_elsewhere';
      // During createDecisionIntent the Decision row exists a few statements
      // before the producer CAS-binds its ID to the immutable candidate. This
      // narrow initial state is safe because no action can execute before the
      // producer finishes the bind and returns the candidate response.
      if (revision.lifecycleState === 'CANDIDATE'
          && revision.approvalState === 'UNREVIEWED'
          && revision.decisionId == null) return null;
      if (revision.lifecycleState !== 'PENDING_REVIEW'
          || revision.approvalState !== 'PENDING'
          || revision.decisionId !== record.itemId) return 'training_plan_revision_changed_elsewhere';
      const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
      const targetVersion = normalized?.targetEntities.find((entry) =>
        entry.type === 'training_plan_revision' && entry.id === record.relatedEntityId)?.version;
      if (!normalized || targetVersion !== revision.contentHash
          || normalized.contextVersion !== revision.contextVersion) {
        return 'training_plan_revision_changed_elsewhere';
      }
    }
    if (record.relatedEntityType === 'training_plan' && tableExists('fitness_training_plans')) {
      const plan = getDb().prepare(`
        SELECT status, updated_at FROM fitness_training_plans
         WHERE id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(record.relatedEntityId, record.userId, record.tenantId) as { status?: string; updated_at?: string } | undefined;
      if (!plan) return 'training_plan_missing';
      if (plan.status && ['superseded', 'cancelled', 'canceled', 'completed'].includes(plan.status)) {
        return 'training_plan_changed_elsewhere';
      }
      if (plan.updated_at && Date.parse(plan.updated_at) > Date.parse(record.createdAt)) {
        return 'training_plan_changed_elsewhere';
      }
    }
    if (record.relatedEntityType === 'training_profile' && trainingRaceDatePresent(record.userId, record.tenantId)) {
      return 'training_race_date_added_elsewhere';
    }
    if (isMissingRaceDateRecipe(record.dedupeKey) && trainingRaceDatePresent(record.userId, record.tenantId)) {
      return 'training_race_date_added_elsewhere';
    }
  }
  if (record.sourceSkill === 'finance' && recordHasAction(record, FINANCE_PAYMENT_ACTION_IDS)) {
    if (record.relatedEntityType !== 'finance_tax_event' || !record.relatedEntityId) {
      return 'finance_tax_event_missing';
    }
    if (!/^\d{4}-\d{2}$/.test(record.relatedEntityId)) return 'finance_tax_event_missing';
    const year = Number(record.relatedEntityId.slice(0, 4));
    const event = getTaxEvents(record.userId, { year, tenantId: record.tenantId })
      .find((candidate) => candidate.month === record.relatedEntityId);
    if (!event) return 'finance_tax_event_missing';
    if (event.status === 'paid') return 'finance_payment_resolved_elsewhere';
  }
  return null;
}

function secretaryDailyTaskAttentionSupersessionReason(record: DecisionRecord): string | null {
  if (!record.relatedEntityId || !/^\d{4}-\d{2}-\d{2}$/.test(record.relatedEntityId)) return null;
  // Daily task-attention decisions are intentionally personal-tenant only.
  // The producer rejects tenant != user because the current task read model is
  // user-scoped. Preserve that invariant for malformed or legacy rows before
  // making any user-only task read; an unverifiable row must remain open.
  if (record.tenantId !== record.userId) return null;
  let tasks: NormalizedTask[];
  try {
    tasks = listTasksForUser(record.userId, { status: 'pending' });
  } catch {
    return null;
  }
  const hasAttentionNeed = tasks.some((task) => secretaryTaskStillNeedsAttention(task, record.relatedEntityId!));
  return hasAttentionNeed ? null : 'secretary_daily_attention_resolved_elsewhere';
}

function secretaryTaskStillNeedsAttention(task: NormalizedTask, localDate: string): boolean {
  if (task.status !== 'pending') return false;
  // M10 P-scale (NEX-17): high-importance means the P1/P2 bucket.
  if (priorityToImportance(task.priority) === 'high') return true;
  const dueKey = secretaryTaskDueDateKey(task);
  return Boolean(dueKey && dueKey <= localDate);
}

function secretaryTaskDueDateKey(task: NormalizedTask): string | null {
  if (!task.dueDate) return null;
  const parsed = DateTime.fromISO(task.dueDate, { setZone: true });
  if (parsed.isValid) return parsed.toISODate();
  const prefix = task.dueDate.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(prefix) ? prefix : null;
}

function supersedeIfSourceStateStale(record: DecisionRecord): string | null {
  if (!['unread', 'read', 'failed', 'snoozed'].includes(record.status)) return null;
  const uncertainExecution = getDb().prepare(`
    SELECT 1 FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('started', 'partially_failed')
     LIMIT 1
  `).get(record.itemId, record.userId, record.tenantId);
  // A potentially committed source effect must be reconciled before normal
  // stale-source retirement. Reads remain available and cannot supersede away
  // the recovery contract.
  if (uncertainExecution) return null;
  const reason = sourceStateSupersessionReason(record);
  if (!reason) return null;
  supersedeDecision(record, reason);
  return reason;
}

function refreshSourceStateForRead(record: DecisionRecord): DecisionRecord {
  if (!supersedeIfSourceStateStale(record)) return record;
  return getDecisionRecord(record.itemId, record.userId, record.tenantId) ?? record;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function supersedeDecision(record: DecisionRecord, reason: string): void {
  guardDecisionLifecycleMutation(record, 'supersede');
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'superseded',
           decision_state = 'superseded',
           action_result_json = ?,
           record_version = record_version + 1,
           updated_at = datetime('now')
     WHERE item_id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(JSON.stringify({ supersededReason: reason, supersededAt: DateTime.utc().toISO() }), record.itemId, record.userId, record.tenantId);
  assertDecisionScopedUpdateApplied(decisionUpdate, 'supersede_decision', {
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    reason,
  });
  emitDecisionLifecycleEvent({ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId, event: 'superseded', reason });
  if (record.decisionLogId) {
    getDb().prepare(`
      UPDATE notification_decision_logs
         SET action_taken = COALESCE(action_taken, 'superseded')
       WHERE decision_log_id = ?
    `).run(record.decisionLogId);
  }
  const logic = decisionLogicForRecord(record);
  const explanation = finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
    actionId: 'auto_dismiss_stale_decision',
    actualEffect: { supersededReason: reason },
    message: reason,
  }));
  recordHandledByNexus(record, {
    actionTaken: 'auto_dismiss_stale_decision',
    summary: explanation.result,
    whyBrief: explanation.verification,
    explanation,
    rollbackAvailable: false,
  });
  recordDecisionOutcome(record, {
    actionShown: 'auto_dismiss_stale_decision',
    actionTaken: 'superseded',
    actionSucceeded: true,
    timeToActionMs: timeToActionMs(record),
  });
}

function recordHandledByNexus(record: DecisionRecord, input: {
  actionTaken: string;
  summary: string;
  whyBrief: string;
  explanation?: DecisionExplanation | null;
  rollbackAvailable: boolean;
  changedRuleOption?: string | null;
  createdAt?: string | null;
}): void {
  ensureDecisionCenterTables();
  const logic = decisionLogicForRecord(record);
  const explanation = input.explanation ?? finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
    actionId: input.actionTaken,
    actualEffect: record.actionResult ?? {},
    message: input.summary,
  }));
  getDb().prepare(`
    INSERT INTO handled_by_nexus_items (
      handled_item_id, decision_id, user_id, tenant_id, source_skill, title, summary,
      action_taken, why_brief, explanation_json, related_entities_json, rollback_available, changed_rule_option,
      privacy_classification, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    `hbn_${randomUUID()}`,
    record.itemId,
    record.userId,
    record.tenantId,
    record.sourceSkill,
    logic.safePreviewTitle,
    input.summary,
    input.actionTaken,
    input.whyBrief,
    explanation ? JSON.stringify(explanation) : null,
    JSON.stringify(record.relatedEntityId && record.relatedEntityType ? [{ type: record.relatedEntityType, id: record.relatedEntityId }] : []),
    input.rollbackAvailable ? 1 : 0,
    input.changedRuleOption ?? null,
    record.privacyPolicy,
    input.createdAt ?? null,
  );
}

function recordVerifiedDecisionAction(
  record: DecisionRecord,
  action: NotificationActionButton,
  actionId: string,
  execution: {
    actualEffect: Record<string, unknown>;
    message: string;
  },
): void {
  if (!MUTATING_ACTIONS.has(actionId)) return;
  try {
    const logic = decisionLogicForRecord(record);
    const explanation = finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
      actionId,
      actualEffect: execution.actualEffect,
      message: execution.message,
    }));
    recordHandledByNexus(record, {
      actionTaken: actionId,
      summary: explanation.result,
      whyBrief: explanation.verification,
      explanation,
      rollbackAvailable: execution.actualEffect.rollbackAvailable === true,
      changedRuleOption: stringOrNull(execution.actualEffect.changedRuleOption),
    });
  } catch (err) {
    decisionHandledHistoryStats.writeFailures += 1;
    logger.error({ err, decisionId: record.itemId, actionId, userId: record.userId, tenantId: record.tenantId }, 'Decision handled history write failed');
  }
}

function mapActionedDecisionToHandledItem(record: DecisionRecord): HandledByNexusItem {
  const logic = decisionLogicForRecord(record);
  const actionTaken = record.decisionLogActionTaken
    ?? stringOrNull(record.actionResult?.actionId)
    ?? 'completed';
  const actionLabel = record.actions.find((action) => action.id === actionTaken)?.label ?? humanizeActionId(actionTaken);
  const outcome = outcomeSummaryForRecord({ ...record, status: 'actioned' }, logic);
  const rollback = rollbackContractForRecord({ ...record, status: 'actioned' });
  const explanation = finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
    actionId: actionTaken,
    actualEffect: record.actionResult ?? {},
    message: outcome.outcomeSummary,
  }));
  return withHandledRollbackAction({
    itemId: `actioned_${record.itemId}`,
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    sourceSkill: record.sourceSkill,
    title: logic.safePreviewTitle,
    summary: explanation.result || outcome.outcomeSummary || `${sourceLabel(record.sourceSkill)} completed ${actionLabel}.`,
    actionTaken,
    explanation,
    whyBrief: explanation.verification,
    relatedEntities: record.relatedEntityId && record.relatedEntityType
      ? [{ type: record.relatedEntityType, id: record.relatedEntityId }]
      : [],
    rollbackAvailable: rollback.available,
    changedRuleOption: null,
    createdAt: record.actionedAt ?? record.createdAt,
    privacyClassification: record.privacyPolicy,
  }, record);
}

function withHandledRollbackAction(item: HandledByNexusItem, record: DecisionRecord): HandledByNexusItem {
  const rollback = rollbackContractForRecord(record);
  const execution = executionSummaryForRecord(record);
  const reconciliationAvailable = execution.status === 'partially_failed'
    && (decisionRefreshSupportedForScope(record.userId, record.tenantId)
      || decisionFlowV1EnforcedForRecord(record));
  if (!rollback.available || !rollback.actionId) {
    return {
      ...item,
      rollbackAvailable: false,
      execution,
      ...(reconciliationAvailable ? { reconciliationAvailable: true } : {}),
    };
  }
  return {
    ...item,
    rollbackAvailable: true,
    execution,
    ...(reconciliationAvailable ? { reconciliationAvailable: true } : {}),
    rollbackAction: {
      actionId: rollback.actionId,
      recordVersion: record.recordVersion,
      contextVersion: decisionContextVersion(record),
    },
  };
}

function humanizeActionId(actionId: string): string {
  return actionId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Completed';
}

function recordDecisionOutcome(record: DecisionRecord, input: {
  actionShown?: string | null;
  actionTaken?: string | null;
  accepted?: boolean;
  dismissed?: boolean;
  snoozed?: boolean;
  ignored?: boolean;
  askedNexus?: boolean;
  manuallyCorrected?: boolean;
  undoUsed?: boolean;
  timeToActionMs?: number | null;
  actionSucceeded?: boolean;
  partialFailure?: boolean;
  failedReason?: string | null;
}): void {
  ensureDecisionCenterTables();
  const logic = decisionLogicForRecord(record);
  const featureSnapshot = {
    urgency: urgencyForPriority(record.priority, record.decisionDeadline, record.expiresAt),
    deadlineDistance: deadlineDistanceBucket(record.decisionDeadline ?? record.expiresAt),
    riskLevel: logic.riskIfIgnored,
    confidence: logic.confidence,
    sourceSkill: record.sourceSkill,
    decisionType: record.type,
    privacyClassification: record.privacyPolicy,
    relatedEntitiesCount: record.relatedEntityId ? 1 : 0,
    optional: record.priority === 'passive',
    qualityScore: logic.quality.qualityScore,
  };
  getDb().prepare(`
    INSERT INTO decision_outcome_ledger (
      outcome_id, decision_id, user_id, tenant_id, source_skill, type, priority_score,
      confidence, automation_eligibility, action_shown, action_taken, accepted, dismissed,
      snoozed, ignored, asked_nexus, manually_corrected, undo_used, time_to_action_ms,
      action_succeeded, partial_failure, failed_reason, feature_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `dol_${randomUUID()}`,
    record.itemId,
    record.userId,
    record.tenantId,
    record.sourceSkill,
    record.type,
    priorityScoreFor(record),
    logic.confidence,
    logic.automationEligibility,
    input.actionShown ?? null,
    input.actionTaken ?? null,
    input.accepted ? 1 : 0,
    input.dismissed ? 1 : 0,
    input.snoozed ? 1 : 0,
    input.ignored ? 1 : 0,
    input.askedNexus ? 1 : 0,
    input.manuallyCorrected ? 1 : 0,
    input.undoUsed ? 1 : 0,
    input.timeToActionMs ?? null,
    input.actionSucceeded ? 1 : 0,
    input.partialFailure ? 1 : 0,
    input.failedReason ?? null,
    JSON.stringify(featureSnapshot),
  );
}

function recordDecisionQualityGateEvent(input: NotificationIntentInput, quality: DecisionQualityGateResult): void {
  ensureDecisionCenterTables();
  const genericBlocked = quality.status === 'blocked'
    || quality.status === 'needs_enrichment'
    || quality.reason.toLowerCase().includes('generic')
    || quality.missingFields.some((field) => field.toLowerCase().includes('concrete'));
  getDb().prepare(`
    INSERT INTO decision_quality_gate_events (
      event_id, user_id, tenant_id, source_skill, type, quality_status,
      quality_score, missing_fields_json, reason, generic_blocked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `dqg_${randomUUID()}`,
    input.userId,
    input.tenantId ?? input.userId,
    input.sourceSkill,
    input.type,
    quality.status,
    quality.qualityScore,
    JSON.stringify(quality.missingFields),
    quality.reason,
    genericBlocked ? 1 : 0,
  );
}

function mapHandledByNexusItem(row: any): HandledByNexusItem {
  return {
    itemId: row.handled_item_id,
    decisionId: row.decision_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    sourceSkill: row.source_skill,
    title: row.title,
    summary: row.summary,
    explanation: normalizeDecisionExplanation(safeParseJson(row.explanation_json, null)),
    actionTaken: row.action_taken,
    whyBrief: row.why_brief,
    relatedEntities: safeParseJson(row.related_entities_json, []),
    rollbackAvailable: !!row.rollback_available,
    changedRuleOption: row.changed_rule_option,
    createdAt: row.created_at,
    privacyClassification: row.privacy_classification,
  };
}

function parseDecisionTimestamp(value: string): DateTime {
  const trimmed = value.trim();
  if (!trimmed) return DateTime.invalid('empty decision timestamp');
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const iso = hasExplicitZone ? normalized : `${normalized}Z`;
  const parsed = DateTime.fromISO(iso, { setZone: true });
  if (parsed.isValid) return parsed.toUTC();
  return DateTime.fromSQL(trimmed, { zone: 'utc' });
}

function timestampMillis(value: string): number {
  const parsed = parseDecisionTimestamp(value);
  return parsed.isValid ? parsed.toMillis() : 0;
}

function isTimestampInLocalDay(value: string, timezone: string, now: DateTime): boolean {
  const zone = validateDecisionTimezone(timezone) ?? 'UTC';
  const parsed = parseDecisionTimestamp(value);
  if (!parsed.isValid) return false;
  return parsed.setZone(zone).hasSame(now.setZone(zone), 'day');
}

function timeToActionMs(record: DecisionRecord): number | null {
  const createdMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return Math.max(0, Date.now() - createdMs);
}

function deadlineDistanceBucket(deadline: string | null): string {
  if (!deadline) return 'none';
  const delta = Date.parse(deadline) - Date.now();
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta <= 3_600_000) return 'within_1h';
  if (delta <= 24 * 3_600_000) return 'within_24h';
  if (delta <= 7 * 24 * 3_600_000) return 'within_week';
  return 'later';
}

function trainingRaceDatePresent(userId: number, tenantId: number): boolean {
  if (!tableExists('user_profiles')) return false;
  // Legacy user_profiles has no tenant_id column. It is safe only for the
  // repository's personal-tenant convention; shared tenants fail closed.
  if (tenantId !== userId) return false;
  const rows = getDb().prepare(`
    SELECT data
      FROM user_profiles
     WHERE user_id = ?
       AND profile_type IN ('fitness', 'training', 'triathlon-running')
  `).all(userId) as Array<{ data: string }>;
  for (const row of rows) {
    const data = safeParseJson<Record<string, unknown>>(row.data, {});
    const targetRaceDate = data.target_race_date ?? data.race_date;
    if (typeof targetRaceDate === 'string' && /\d{4}-\d{2}-\d{2}/.test(targetRaceDate)) return true;
  }
  return false;
}

function tableExists(table: string): boolean {
  const row = getDb().prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1
  `).get(table) as { name: string } | undefined;
  return !!row;
}

function recordHasAction(record: DecisionRecord, actionIds: Set<string>): boolean {
  return record.actions.some((action) => actionIds.has(action.id));
}

function contentWorkflowObjectIdForDecision(record: DecisionRecord): string | null {
  if (record.relatedEntityType === 'content_workflow_object' && record.relatedEntityId) {
    return record.relatedEntityId;
  }
  if (record.relatedEntityType !== 'content_notification' || !record.relatedEntityId || !tableExists('content_notifications')) {
    return null;
  }
  const row = getDb().prepare(`
    SELECT data
      FROM content_notifications
     WHERE id = ?
       AND user_id = ?
     LIMIT 1
  `).get(record.relatedEntityId, record.userId) as { data?: string } | undefined;
  const data = safeParseJson<Record<string, unknown>>(row?.data, {});
  return firstWorkflowObjectId(data);
}

function firstWorkflowObjectId(data: Record<string, unknown>): string | null {
  for (const key of ['contentObjectId', 'workflowObjectId', 'objectId', 'draftId', 'ideaId']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function executorSkillForAction(actionId: string, record: DecisionRecord): string {
  if (actionId === 'approve_script' || actionId === 'request_rewrite') return 'content';
  if (record.type === 'conflict_detected' || actionId.includes('reflow')) return 'secretary';
  return record.sourceSkill;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function assertScope(userId: number, tenantId: number, operation: string, details?: Record<string, unknown>): void {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return;
  recordTenantScopeAnomaly({
    layer: 'orchestration',
    operation,
    reason: 'invalid_user_scope',
    userId: isValidTenantUserId(userId) ? userId : null,
    details,
  });
  throw new DecisionActionError('INVALID_SCOPE', 'Invalid user or tenant scope', 401);
}
