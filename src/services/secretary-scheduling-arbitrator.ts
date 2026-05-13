// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary scheduling arbitrator.
 *
 * This service is the first runtime layer over migration 083's
 * `secretary_agenda_items` ledger. It gives skills a typed way to ask
 * Secretary for time without writing provider events directly.
 *
 * Scope of this layer:
 * - normalize scheduling intents from skills,
 * - choose a feasible slot using explicit capacity inputs,
 * - persist agenda ownership/lifecycle state,
 * - expose source-skill feedback and decision reasons.
 *
 * Provider sync is performed by `secretary-agenda-provider-sync` using the
 * persisted agenda item and provider_sync_state fields, so retries stay
 * idempotent and the scheduling engine remains provider-agnostic.
 */

import crypto from 'crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { cancelRemindersForAgendaItem } from '../state/reminders';
import { filterKnownReasonCodes, type SecretaryReasonCode } from './secretary-reason-codes';
import { emitSecretaryFeedback } from './secretary-feedback-bus';
import './training-secretary-feedback-consumer';
import './secretary-source-skill-feedback-consumers';

export type SecretarySourceSkill = 'secretary' | 'training' | 'cooking' | 'finance' | 'content';

export type SecretarySchedulingIntentAction =
  | 'schedule_this'
  | 'reschedule_this'
  | 'cancel_this'
  | 'find_time_for_this'
  | 'protect_time_for_this'
  | 'create_reminder'
  | 'create_follow_up'
  | 'request_clarification';

export type SecretaryAgendaLifecycleState =
  | 'proposed'
  | 'scheduled'
  | 'synced'
  | 'reflowed'
  | 'compressed'
  | 'deferred'
  | 'canceled'
  | 'superseded'
  | 'unscheduled'
  | 'failed_sync'
  | 'completed';

export type SecretaryProviderSyncState =
  | 'not_synced'
  | 'synced'
  | 'create_failed'
  | 'update_failed'
  | 'delete_failed'
  | 'readback_failed'
  | 'deleted';

export type SecretarySchedulingDecisionStatus =
  | 'scheduled'
  | 'reflowed'
  | 'compressed'
  | 'deferred'
  | 'unscheduled'
  | 'rejected'
  | 'needs_more_context';

export type SecretaryIntentPriority = 'low' | 'normal' | 'high' | 'urgent' | number;
export type SecretaryIntentFlexibility = 'fixed' | 'flexible' | 'compressible' | 'splittable';

export interface SecretaryTimeWindow {
  start: string;
  end: string;
  label?: string;
  hard?: boolean;
}

/**
 * Training goal phase used for dynamic priority weighting (C3 workstream).
 * Matches the `BlockPhase` type from `coach-kernel/types.ts:5-12` but kept as
 * a string union here to avoid a Secretary→coach-kernel hard dependency at
 * the type level. Training callers should pass `inferPhase(athlete, weekStart)`
 * from `coach-kernel/planner-engine.ts:59`.
 */
export type SecretaryGoalPhase =
  | 'base'
  | 'build'
  | 'peak'
  | 'taper'
  | 'race'
  | 'deload'
  | 'maintenance';

export interface SecretarySchedulingIntent {
  intentId: string;
  action?: SecretarySchedulingIntentAction;
  sourceSkill: SecretarySourceSkill;
  sourceAction?: string | null;
  sourceEntityId?: string | number | null;
  sourceEntityType?: string | null;
  ownerUserId: number;
  tenantId: string | number;
  title: string;
  requestedDurationMinutes?: number | null;
  minimumDurationMinutes?: number | null;
  preferredWindows?: SecretaryTimeWindow[];
  hardConstraints?: {
    unavailableWindows?: SecretaryTimeWindow[];
    protectedWindows?: SecretaryTimeWindow[];
    hardCommitments?: SecretaryTimeWindow[];
  };
  softPreferences?: Record<string, unknown>;
  deadline?: string | null;
  priority?: SecretaryIntentPriority;
  flexibility?: SecretaryIntentFlexibility;
  recurrence?: unknown;
  dependencies?: string[];
  energyCost?: number | null;
  reason?: string | null;
  context?: string | null;
  /**
   * Optional goal-phase signal for dynamic priority weighting (C3 workstream).
   * When set, Secretary up-weights or down-weights the source skill's base
   * priority during arbitration:
   *  - training: build +2, peak +3, taper -2, race -4, deload -3 (else 0)
   *  - other skills: 0 (signal ignored)
   * Phase = null/undefined → boost = 0 (graceful default, no behavior change).
   * Finance deadline boost (+18) dominates phase boost so a tax deadline
   * still outranks Training in race week.
   */
  goalPhase?: SecretaryGoalPhase | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SecretaryAgendaItem {
  agendaItemId: string;
  sourceIntentId: string;
  sourceSkill: SecretarySourceSkill;
  sourceAction: string | null;
  intentAction: SecretarySchedulingIntentAction;
  sourceEntityId: string | null;
  sourceEntityType: string | null;
  ownerUserId: number;
  tenantId: string;
  lifecycleState: SecretaryAgendaLifecycleState;
  providerSyncState: SecretaryProviderSyncState;
  providerEventId: string | null;
  providerSource: string | null;
  version: number;
  title: string;
  startAt: string | null;
  endAt: string | null;
  durationMinutes: number | null;
  decisionAction: SecretarySchedulingDecisionStatus;
  decisionReasonCodes: string[];
  decisionExplanation: string | null;
  sourceShapeHash: string;
  scheduledSegments: SecretaryTimeWindow[];
  cancellationReason: string | null;
  supersededByAgendaItemId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  /**
   * Persisted reasoning trail (W-E). Read from `reasoning_trail_json`
   * column. Always an array — empty when the row predates the trail
   * column or when persistence was skipped.
   */
  reasoningTrail: ReasoningTrailNode[];
}

export interface SecretarySchedulingDecision {
  status: SecretarySchedulingDecisionStatus;
  agendaItem: SecretaryAgendaItem;
  /**
   * Reason codes for the arbitration outcome. Producers emit
   * `SecretaryReasonCode` (compiler-enforced); historical legacy rows from
   * pre-W-A persistence may contain unknown strings — consumers use
   * `isKnownReasonCode` from `./secretary-reason-codes` to branch safely.
   */
  reasonCodes: SecretaryReasonCode[];
  explanation: string;
  selectedSlot: SecretaryTimeWindow | null;
  alternativeSlots: SecretaryTimeWindow[];
  conflicts: string[];
  downstreamImplications: string[];
  confidence: 'low' | 'medium' | 'high';
  feedback: SecretarySourceSkillFeedback;
  /**
   * Ordered breadcrumbs the arbitrator left while making this decision
   * (W-E workstream). Capped at 12 nodes via `capReasoningTrail`; preserves
   * outcome markers (`chosen`/`rejected`/`deferred`/`unscheduled`) over
   * setup nodes when overflowing. Privacy: enum + slot + weight only,
   * never user copy.
   */
  reasoningTrail: ReasoningTrailNode[];
}

export interface SecretarySourceSkillFeedback {
  sourceSkill: SecretarySourceSkill;
  sourceIntentId: string;
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string;
  agendaVersion: number;
  status: SecretarySchedulingDecisionStatus;
  reasonCodes: SecretaryReasonCode[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  shouldRefreshSource: boolean;
  downstreamImplications: string[];
}

/**
 * Reasoning-trail node kinds (W-E workstream).
 *
 * Each scheduling decision emits an ordered list of breadcrumbs that
 * Secretary used to arrive at the outcome. Surfaced through Decision Center
 * detail (C2) and Telegram `/why_last` so users get a "why moved my run?"
 * answer.
 *
 * Privacy: trail nodes carry ONLY enum codes + structured slot objects +
 * numeric weights. NEVER free-text titles, NEVER user descriptions. The
 * single `detail` field is a short structured tag (e.g. `dur:60`,
 * `weight:14`) — not user copy.
 */
export type ReasoningTrailNodeKind =
  | 'validation'
  | 'candidate'
  | 'busy_block'
  | 'priority'
  | 'phase_boost'
  | 'compression'
  | 'reflow'
  | 'considered'
  | 'chosen'
  | 'rejected'
  | 'deferred'
  | 'unscheduled';

export interface ReasoningTrailNode {
  kind: ReasoningTrailNodeKind;
  reasonCode?: SecretaryReasonCode;
  slot?: { start: string; end: string };
  weight?: number;
  /**
   * Short structured tag, NOT free-text. Examples: `dur:60`, `min:45`,
   * `cand_count:3`, `busy_count:5`. Cap 32 chars; never contains user copy.
   */
  detail?: string;
}

/** Hard cap on stored trail length to bound row width. */
const REASONING_TRAIL_MAX_NODES = 12;

/**
 * Cap a trail at `REASONING_TRAIL_MAX_NODES` while preserving terminal
 * `chosen`/`rejected`/`deferred`/`unscheduled` nodes — these are the
 * outcome markers users actually want to see. Earlier `considered`/`candidate`
 * nodes are dropped first.
 */
function capReasoningTrail(trail: ReasoningTrailNode[]): ReasoningTrailNode[] {
  if (trail.length <= REASONING_TRAIL_MAX_NODES) return trail;
  const terminal = trail.filter((node) =>
    node.kind === 'chosen' || node.kind === 'rejected' || node.kind === 'deferred' || node.kind === 'unscheduled',
  );
  const remaining = REASONING_TRAIL_MAX_NODES - terminal.length;
  if (remaining <= 0) {
    // Edge case: more than 12 terminal nodes (shouldn't happen). Keep the
    // last 12 terminal nodes.
    return terminal.slice(-REASONING_TRAIL_MAX_NODES);
  }
  const nonTerminal = trail.filter((node) =>
    node.kind !== 'chosen' && node.kind !== 'rejected' && node.kind !== 'deferred' && node.kind !== 'unscheduled',
  );
  // Keep the first `remaining` non-terminal nodes (decision setup is more
  // useful than mid-flow considerations when overflowing) plus all terminal
  // nodes appended.
  return [...nonTerminal.slice(0, remaining), ...terminal];
}

export interface SecretarySchedulingBatchResult {
  decisions: SecretarySchedulingDecision[];
  scheduledCount: number;
  unscheduledCount: number;
  feedbackBySourceSkill: Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]>;
}

export interface SecretarySchedulingOptions {
  existingAgendaItems?: Array<Pick<SecretaryAgendaItem, 'startAt' | 'endAt' | 'lifecycleState' | 'title'>>;
  additionalBusyWindows?: SecretaryTimeWindow[];
  now?: string;
}

type SecretaryScheduleMode = 'persist' | 'preview';

type NormalizedWindow = {
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  label?: string;
};

type CandidateSlot = {
  startMs: number;
  endMs: number;
  durationMinutes: number;
  sourceWindow: NormalizedWindow;
};

const ACTIVE_BUSY_STATES = new Set<SecretaryAgendaLifecycleState>([
  'scheduled',
  'synced',
  'reflowed',
  'compressed',
  'failed_sync',
]);

const VALID_SOURCE_SKILLS = new Set<SecretarySourceSkill>([
  'secretary',
  'training',
  'cooking',
  'finance',
  'content',
]);

const SKILL_PRIORITY_WEIGHT: Record<SecretarySourceSkill, number> = {
  finance: 16,
  training: 12,
  secretary: 10,
  cooking: 8,
  content: 6,
};

function ensureSecretaryAgendaDecisionExplanationColumn(db = getDb()): void {
  const columns = db.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'decision_explanation')) {
    db.exec('ALTER TABLE secretary_agenda_items ADD COLUMN decision_explanation TEXT');
  }
  // W-E: reasoning trail. Idempotent PRAGMA add. Persisted as JSON-encoded
  // ReasoningTrailNode[]. NULL when row predates this column.
  if (!columns.some((column) => column.name === 'reasoning_trail_json')) {
    db.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  }
}

export function submitSecretarySchedulingIntent(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingDecision {
  ensureSecretaryAgendaDecisionExplanationColumn();
  const decision = scheduleOne(intent, options, []);
  // W-B: emit feedback to registered consumers. Synchronous emit; bad
  // consumers are caught inside the bus so arbitration is never blocked.
  emitSecretaryFeedback(decision.feedback);
  return decision;
}

/**
 * Non-persisting probe (C1 workstream). Lets callers ask Secretary
 * "what slot would you assign this intent?" without writing an agenda
 * item. Used by Training to detect conflicts BEFORE the user sees a
 * Decision Center card.
 *
 * Returns a synthetic decision shape with `noPersist: true` marker. The
 * caller MUST follow up with `submitSecretarySchedulingIntent(intent)`
 * to actually persist. Preview ≠ submit can drift if a concurrent write
 * lands between the calls — that's acceptable because preview is a HINT,
 * not a contract.
 *
 * Plan reference: Wave 1 workstream C1.
 */
export function previewSecretarySchedulingIntent(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingPreview {
  ensureSecretaryAgendaDecisionExplanationColumn();
  // Use the canonical scheduleOne machinery in read-only preview mode. The
  // decision is fully shaped (including feedback/trail), but no agenda row is
  // inserted, superseded, or canceled. Preview is a hint; submit remains the
  // contract.
  const decision = scheduleOne(intent, options, [], 'preview');
  return {
    status: decision.status,
    recommendedSlot: decision.selectedSlot,
    alternatives: decision.alternativeSlots,
    reasonCodes: decision.reasonCodes,
    confidence: decision.confidence,
    wouldReflow: decision.status === 'reflowed',
    wouldCompress: decision.status === 'compressed',
    // W-E: preview returns the trail so callers (Training, Decision Center)
    // can render "if you pick this slot, here's why" copy without a submit.
    reasoningTrail: decision.reasoningTrail,
    noPersist: true,
  };
}

export interface SecretarySchedulingPreview {
  status: SecretarySchedulingDecisionStatus;
  recommendedSlot: SecretaryTimeWindow | null;
  alternatives: SecretaryTimeWindow[];
  reasonCodes: SecretaryReasonCode[];
  confidence: 'low' | 'medium' | 'high';
  wouldReflow: boolean;
  wouldCompress: boolean;
  /**
   * W-E reasoning trail attached to the preview decision. Same shape +
   * cap as a real submit; useful for "what would Secretary explain?"
   * before the user accepts a Decision Center card.
   */
  reasoningTrail: ReasoningTrailNode[];
  /** Marker — always `true` for preview returns; absent on submit results. */
  noPersist: true;
}

export function arbitrateSecretarySchedulingIntents(
  intents: SecretarySchedulingIntent[],
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingBatchResult {
  ensureSecretaryAgendaDecisionExplanationColumn();
  const ordered = [...intents].sort(compareIntentPriority);
  const acceptedBusyWindows: SecretaryTimeWindow[] = [];
  const decisions: SecretarySchedulingDecision[] = [];

  for (const intent of ordered) {
    const decision = scheduleOne(intent, options, acceptedBusyWindows);
    decisions.push(decision);
    if (decision.selectedSlot && ['scheduled', 'reflowed', 'compressed'].includes(decision.status)) {
      acceptedBusyWindows.push(decision.selectedSlot);
    }
    // W-B: emit feedback per decision (not at end of batch) so consumers
    // can react incrementally if needed.
    emitSecretaryFeedback(decision.feedback);
  }

  const feedbackBySourceSkill = buildFeedbackBySourceSkill(decisions);
  return {
    decisions,
    scheduledCount: decisions.filter((decision) => ['scheduled', 'reflowed', 'compressed'].includes(decision.status)).length,
    unscheduledCount: decisions.filter((decision) => ['unscheduled', 'deferred', 'rejected', 'needs_more_context'].includes(decision.status)).length,
    feedbackBySourceSkill,
  };
}

export function listSecretaryAgendaItems(scope: {
  ownerUserId: number;
  tenantId: string | number;
  includeInactive?: boolean;
}): SecretaryAgendaItem[] {
  const db = getDb();
  ensureSecretaryAgendaDecisionExplanationColumn(db);
  const tenantId = normalizeTenantId(scope.tenantId);
  const rows = scope.includeInactive
    ? db.prepare(`
        SELECT * FROM secretary_agenda_items
        WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY COALESCE(start_at, updated_at) ASC, version ASC
      `).all(scope.ownerUserId, tenantId)
    : db.prepare(`
        SELECT * FROM secretary_agenda_items
        WHERE owner_user_id = ? AND tenant_id = ?
          AND lifecycle_state NOT IN ('canceled', 'superseded', 'completed')
        ORDER BY COALESCE(start_at, updated_at) ASC, version ASC
      `).all(scope.ownerUserId, tenantId);
  return rows.map(rowToAgendaItem);
}

export function getSecretaryAgendaItemById(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
}): SecretaryAgendaItem | null {
  ensureSecretaryAgendaDecisionExplanationColumn();
  const row = getDb().prepare(`
    SELECT *
    FROM secretary_agenda_items
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
  `).get(scope.agendaItemId, scope.ownerUserId, normalizeTenantId(scope.tenantId));
  return row ? rowToAgendaItem(row) : null;
}

export function cancelSecretaryAgendaItem(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  reason?: string | null;
  now?: string;
}): SecretaryAgendaItem | null {
  const nowIso = normalizeNow(scope.now);
  ensureSecretaryAgendaDecisionExplanationColumn();
  getDb().prepare(`
    UPDATE secretary_agenda_items
    SET lifecycle_state = 'canceled',
        cancellation_reason = COALESCE(?, cancellation_reason),
        updated_at = ?
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
      AND lifecycle_state NOT IN ('canceled', 'completed')
  `).run(
    scope.reason ?? null,
    nowIso,
    scope.agendaItemId,
    scope.ownerUserId,
    normalizeTenantId(scope.tenantId),
  );
  cancelRemindersForAgendaItem(scope.ownerUserId, scope.agendaItemId);
  return getSecretaryAgendaItemById(scope);
}

function scheduleOne(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions,
  acceptedBusyWindows: SecretaryTimeWindow[],
  mode: SecretaryScheduleMode = 'persist',
): SecretarySchedulingDecision {
  const nowIso = normalizeNow(options.now);
  // W-E: collect reasoning breadcrumbs as we go. Privacy-safe — only
  // enum codes, slot ISO strings, and numeric weights/counts.
  const trail: ReasoningTrailNode[] = [];
  const validation = validateIntent(intent);
  if (validation.length > 0) {
    for (const code of validation) {
      trail.push({ kind: 'validation', reasonCode: code });
    }
    const validationStatus: SecretarySchedulingDecisionStatus =
      validation.includes('invalid_source_skill') || validation.includes('invalid_owner_scope')
        ? 'rejected'
        : 'needs_more_context';
    trail.push({ kind: validationStatus === 'rejected' ? 'rejected' : 'unscheduled' });
    return persistDecision({
      intent,
      nowIso,
      status: validationStatus,
      lifecycleState: validation.includes('invalid_source_skill') || validation.includes('invalid_owner_scope')
        ? 'unscheduled'
        : 'proposed',
      reasonCodes: validation,
      explanation: explainDecision(intent, validation.includes('invalid_source_skill') ? 'rejected' : 'needs_more_context', validation),
      selectedSlot: null,
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: downstreamFor(intent, validation.includes('missing_duration') ? 'needs_more_context' : 'rejected'),
      reasoningTrail: trail,
      persist: mode === 'persist',
    });
  }

  const latest = findLatestAgendaItemForIntent(intent);
  const sourceShapeHash = computeSourceShapeHash(intent);
  const duration = Math.max(1, Math.round(Number(intent.requestedDurationMinutes)));
  const busyWindows = buildBusyWindows(intent, options, acceptedBusyWindows);
  const candidateWindows = normalizeWindows(intent.preferredWindows ?? []);
  // W-E: priority weight + phase boost are inputs to arbitration ordering;
  // log them so users can see "why this won over the cooking intent".
  trail.push({
    kind: 'priority',
    weight: SKILL_PRIORITY_WEIGHT[intent.sourceSkill],
    detail: `skill:${intent.sourceSkill}`,
  });
  const phaseBoost = phaseBoostFor(intent.sourceSkill, intent.goalPhase ?? null);
  if (phaseBoost !== 0) {
    trail.push({
      kind: 'phase_boost',
      weight: phaseBoost,
      detail: `phase:${intent.goalPhase ?? 'none'}`,
    });
  }
  trail.push({ kind: 'candidate', detail: `cand:${candidateWindows.length}` });
  if (busyWindows.length > 0) {
    trail.push({ kind: 'busy_block', detail: `busy:${busyWindows.length}` });
  }
  const exactSlot = findFirstAvailableSlot(candidateWindows, busyWindows, duration);

  if (exactSlot) {
    const reflowed = latest
      && latest.lifecycleState !== 'superseded'
      && latest.startAt
      && latest.endAt
      && (Date.parse(latest.startAt) !== exactSlot.startMs || Date.parse(latest.endAt) !== exactSlot.endMs);
    const status: SecretarySchedulingDecisionStatus = reflowed ? 'reflowed' : 'scheduled';
    const reasonCodes: SecretaryReasonCode[] = reflowed
      ? ['reflowed_to_available_window', ...slotReasonCodes(intent, exactSlot)]
      : ['scheduled_in_available_window', ...slotReasonCodes(intent, exactSlot)];

    const selectedSlot = slotToWindow(exactSlot);
    if (reflowed) {
      trail.push({ kind: 'reflow', reasonCode: 'reflowed_to_available_window' });
    }
    // Capture alternatives as `considered` before the `chosen` marker so the
    // cap-policy preserves the chosen tail.
    const alternatives = candidateWindowsToAlternatives(candidateWindows, exactSlot);
    for (const alt of alternatives) {
      trail.push({ kind: 'considered', slot: { start: alt.start, end: alt.end } });
    }
    trail.push({
      kind: 'chosen',
      slot: { start: selectedSlot.start, end: selectedSlot.end },
      reasonCode: reflowed ? 'reflowed_to_available_window' : 'scheduled_in_available_window',
      detail: `dur:${minutesBetween(selectedSlot.start, selectedSlot.end)}`,
    });

    return persistDecision({
      intent,
      nowIso,
      status,
      lifecycleState: reflowed ? 'reflowed' : 'scheduled',
      reasonCodes,
      explanation: explainDecision(intent, status, reasonCodes),
      selectedSlot,
      alternativeSlots: alternatives,
      conflicts: conflictSummaries(busyWindows),
      downstreamImplications: downstreamFor(intent, status),
      latest,
      sourceShapeHash,
      reasoningTrail: trail,
      persist: mode === 'persist',
    });
  }

  if ((intent.flexibility ?? 'flexible') === 'compressible') {
    const minimumDuration = Math.max(
      15,
      Math.min(duration, Math.round(Number(intent.minimumDurationMinutes ?? Math.ceil(duration * 0.6)))),
    );
    const compressedSlot = findLargestAvailableSlot(candidateWindows, busyWindows, minimumDuration, duration);
    if (compressedSlot) {
      const reasonCodes: SecretaryReasonCode[] = ['compressed_to_fit_capacity', ...slotReasonCodes(intent, compressedSlot)];
      const selectedSlot = slotToWindow(compressedSlot);
      trail.push({ kind: 'compression', reasonCode: 'compressed_to_fit_capacity', detail: `min:${minimumDuration}` });
      const alternatives = candidateWindowsToAlternatives(candidateWindows, compressedSlot);
      for (const alt of alternatives) {
        trail.push({ kind: 'considered', slot: { start: alt.start, end: alt.end } });
      }
      trail.push({
        kind: 'chosen',
        slot: { start: selectedSlot.start, end: selectedSlot.end },
        reasonCode: 'compressed_to_fit_capacity',
        detail: `dur:${minutesBetween(selectedSlot.start, selectedSlot.end)}`,
      });
      return persistDecision({
        intent,
        nowIso,
        status: 'compressed',
        lifecycleState: 'compressed',
        reasonCodes,
        explanation: explainDecision(intent, 'compressed', reasonCodes),
        selectedSlot,
        alternativeSlots: alternatives,
        conflicts: conflictSummaries(busyWindows),
        downstreamImplications: downstreamFor(intent, 'compressed'),
        latest,
        sourceShapeHash,
        reasoningTrail: trail,
        persist: mode === 'persist',
      });
    }
  }

  const hasFutureDeadline = hasDeadlineAfterWindows(intent.deadline, candidateWindows);
  const status: SecretarySchedulingDecisionStatus = hasFutureDeadline && (intent.flexibility ?? 'flexible') === 'flexible'
    ? 'deferred'
    : 'unscheduled';
  const reasonCodes: SecretaryReasonCode[] = [
    status === 'deferred' ? 'deferred_due_to_current_capacity' : 'unscheduled_no_capacity',
    candidateWindows.length === 0 ? 'missing_availability' : 'no_valid_slot',
    ...priorityReasonCodes(intent),
  ];
  trail.push({
    kind: status === 'deferred' ? 'deferred' : 'unscheduled',
    reasonCode: status === 'deferred' ? 'deferred_due_to_current_capacity' : 'unscheduled_no_capacity',
  });

  return persistDecision({
    intent,
    nowIso,
    status,
    lifecycleState: status,
    reasonCodes,
    explanation: explainDecision(intent, status, reasonCodes),
    selectedSlot: null,
    alternativeSlots: candidateWindows.map((window) => ({ start: window.start, end: window.end, label: window.label })),
    conflicts: conflictSummaries(busyWindows),
    downstreamImplications: downstreamFor(intent, status),
    latest,
    sourceShapeHash,
    reasoningTrail: trail,
    persist: mode === 'persist',
  });
}

function persistDecision(input: {
  intent: SecretarySchedulingIntent;
  nowIso: string;
  status: SecretarySchedulingDecisionStatus;
  lifecycleState: SecretaryAgendaLifecycleState;
  reasonCodes: SecretaryReasonCode[];
  explanation: string;
  selectedSlot: SecretaryTimeWindow | null;
  alternativeSlots: SecretaryTimeWindow[];
  conflicts: string[];
  downstreamImplications: string[];
  latest?: SecretaryAgendaItem | null;
  sourceShapeHash?: string;
  /**
   * W-E: optional reasoning trail collected by `scheduleOne`. Capped via
   * `capReasoningTrail` before persistence so row width stays bounded.
   */
  reasoningTrail?: ReasoningTrailNode[];
  /**
   * C1 preview mode: build the same decision shape without writing or
   * superseding `secretary_agenda_items`.
   */
  persist?: boolean;
}): SecretarySchedulingDecision {
  const db = getDb();
  const tenantId = normalizeTenantId(input.intent.tenantId);
  const latest = input.latest ?? findLatestAgendaItemForIntent(input.intent);
  const sourceShapeHash = input.sourceShapeHash ?? computeSourceShapeHash(input.intent);
  const cappedTrail = capReasoningTrail(input.reasoningTrail ?? []);
  const shouldPersist = input.persist !== false;

  if (
    shouldPersist
    && latest
    && latest.sourceShapeHash === sourceShapeHash
    && latest.lifecycleState !== 'superseded'
    && agendaSlotMatches(latest, input.selectedSlot)
  ) {
    return decisionFromExisting(
      input.intent, latest, input.status, input.reasonCodes, input.explanation,
      input.conflicts, input.downstreamImplications, cappedTrail,
    );
  }

  if (!shouldPersist) {
    return decisionFromPreview(input, sourceShapeHash, cappedTrail, latest);
  }

  const version = latest ? latest.version + 1 : 1;
  const agendaItemId = buildAgendaItemId(input.intent, version);
  const startAt = input.selectedSlot?.start ?? null;
  const endAt = input.selectedSlot?.end ?? null;
  const durationMinutes = input.selectedSlot
    ? minutesBetween(input.selectedSlot.start, input.selectedSlot.end)
    : input.intent.requestedDurationMinutes != null
      ? Math.round(Number(input.intent.requestedDurationMinutes))
      : null;
  const scheduledSegments = decisionScheduledSegments(input.selectedSlot, input.alternativeSlots);
  const reasoningTrailJson = cappedTrail.length > 0 ? JSON.stringify(cappedTrail) : null;

  const writeAgendaItem = db.transaction(() => {
    if (latest && latest.lifecycleState !== 'superseded') {
      db.prepare(`
        UPDATE secretary_agenda_items
        SET lifecycle_state = 'superseded',
            provider_sync_state = CASE
              WHEN provider_sync_state = 'not_synced' THEN 'not_synced'
              ELSE provider_sync_state
            END,
            superseded_by_agenda_item_id = ?,
            updated_at = ?
        WHERE agenda_item_id = ?
      `).run(agendaItemId, input.nowIso, latest.agendaItemId);
      cancelRemindersForAgendaItem(input.intent.ownerUserId, latest.agendaItemId);
    }

    db.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, provider_event_id, provider_source,
        version, title, start_at, end_at, duration_minutes, decision_action,
        decision_reason_codes_json, decision_explanation, source_shape_hash, scheduled_segments_json,
        cancellation_reason, superseded_by_agenda_item_id, created_at, updated_at,
        completed_at, source_created_at, source_updated_at, reasoning_trail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_synced', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)
    `).run(
      agendaItemId,
      input.intent.intentId,
      input.intent.sourceSkill,
      input.intent.sourceAction ?? null,
      input.intent.action ?? defaultActionForStatus(input.status),
      input.intent.sourceEntityId != null ? String(input.intent.sourceEntityId) : null,
      input.intent.sourceEntityType ?? null,
      input.intent.ownerUserId,
      tenantId,
      input.lifecycleState,
      version,
      input.intent.title.trim(),
      startAt,
      endAt,
      durationMinutes,
      input.status,
      JSON.stringify(input.reasonCodes),
      input.explanation,
      sourceShapeHash,
      JSON.stringify(scheduledSegments),
      input.nowIso,
      input.nowIso,
      input.intent.createdAt ?? null,
      input.intent.updatedAt ?? null,
      reasoningTrailJson,
    );
  });

  writeAgendaItem();

  const agendaItem = findAgendaItemById(agendaItemId);
  if (!agendaItem) {
    logger.error({ agendaItemId }, 'Secretary agenda item insert succeeded but row could not be read back');
    throw new Error('Secretary agenda item insert read-back failed');
  }

  return {
    status: input.status,
    agendaItem,
    reasonCodes: input.reasonCodes,
    explanation: input.explanation,
    selectedSlot: input.selectedSlot,
    alternativeSlots: input.alternativeSlots,
    conflicts: input.conflicts,
    downstreamImplications: input.downstreamImplications,
    confidence: confidenceFor(input.status, input.reasonCodes),
    feedback: buildFeedback(input.intent, agendaItem, input.status, input.reasonCodes, input.downstreamImplications),
    reasoningTrail: cappedTrail,
  };
}

function decisionFromPreview(
  input: {
    intent: SecretarySchedulingIntent;
    nowIso: string;
    status: SecretarySchedulingDecisionStatus;
    lifecycleState: SecretaryAgendaLifecycleState;
    reasonCodes: SecretaryReasonCode[];
    explanation: string;
    selectedSlot: SecretaryTimeWindow | null;
    alternativeSlots: SecretaryTimeWindow[];
    conflicts: string[];
    downstreamImplications: string[];
  },
  sourceShapeHash: string,
  reasoningTrail: ReasoningTrailNode[],
  latest: SecretaryAgendaItem | null,
): SecretarySchedulingDecision {
  const startAt = input.selectedSlot?.start ?? null;
  const endAt = input.selectedSlot?.end ?? null;
  const durationMinutes = input.selectedSlot
    ? minutesBetween(input.selectedSlot.start, input.selectedSlot.end)
    : input.intent.requestedDurationMinutes != null
      ? Math.round(Number(input.intent.requestedDurationMinutes))
      : null;
  const agendaItem: SecretaryAgendaItem = {
    agendaItemId: `sec_preview_${sha256(`${input.intent.ownerUserId}:${normalizeTenantId(input.intent.tenantId)}:${input.intent.sourceSkill}:${input.intent.intentId}:${sourceShapeHash}`).slice(0, 24)}`,
    sourceIntentId: input.intent.intentId,
    sourceSkill: input.intent.sourceSkill,
    sourceAction: input.intent.sourceAction ?? null,
    intentAction: input.intent.action ?? defaultActionForStatus(input.status),
    sourceEntityId: input.intent.sourceEntityId != null ? String(input.intent.sourceEntityId) : null,
    sourceEntityType: input.intent.sourceEntityType ?? null,
    ownerUserId: input.intent.ownerUserId,
    tenantId: normalizeTenantId(input.intent.tenantId),
    lifecycleState: input.lifecycleState,
    providerSyncState: 'not_synced',
    providerEventId: null,
    providerSource: null,
    version: latest ? latest.version + 1 : 1,
    title: input.intent.title.trim(),
    startAt,
    endAt,
    durationMinutes,
    decisionAction: input.status,
    decisionReasonCodes: [...input.reasonCodes],
    decisionExplanation: input.explanation,
    sourceShapeHash,
    scheduledSegments: decisionScheduledSegments(input.selectedSlot, input.alternativeSlots),
    cancellationReason: null,
    supersededByAgendaItemId: null,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    completedAt: null,
    sourceCreatedAt: input.intent.createdAt ?? null,
    sourceUpdatedAt: input.intent.updatedAt ?? null,
    reasoningTrail,
  };
  return {
    status: input.status,
    agendaItem,
    reasonCodes: input.reasonCodes,
    explanation: input.explanation,
    selectedSlot: input.selectedSlot,
    alternativeSlots: input.alternativeSlots,
    conflicts: input.conflicts,
    downstreamImplications: input.downstreamImplications,
    confidence: confidenceFor(input.status, input.reasonCodes),
    feedback: buildFeedback(input.intent, agendaItem, input.status, input.reasonCodes, input.downstreamImplications),
    reasoningTrail,
  };
}

function decisionScheduledSegments(
  selectedSlot: SecretaryTimeWindow | null,
  alternativeSlots: SecretaryTimeWindow[],
): SecretaryTimeWindow[] {
  const segments: SecretaryTimeWindow[] = [];
  const add = (slot?: SecretaryTimeWindow | null) => {
    if (!slot?.start || !slot.end) return;
    if (!Number.isFinite(Date.parse(slot.start)) || !Number.isFinite(Date.parse(slot.end)) || Date.parse(slot.start) >= Date.parse(slot.end)) return;
    if (segments.some((existing) => existing.start === slot.start && existing.end === slot.end)) return;
    segments.push({
      start: slot.start,
      end: slot.end,
      ...(slot.label ? { label: slot.label } : {}),
      ...(slot.hard != null ? { hard: slot.hard } : {}),
    });
  };
  add(selectedSlot);
  for (const slot of alternativeSlots) add(slot);
  return segments.slice(0, 6);
}

function agendaSlotMatches(agendaItem: SecretaryAgendaItem, selectedSlot: SecretaryTimeWindow | null): boolean {
  if (!selectedSlot) return agendaItem.startAt === null && agendaItem.endAt === null;
  return agendaItem.startAt === selectedSlot.start && agendaItem.endAt === selectedSlot.end;
}

function decisionFromExisting(
  intent: SecretarySchedulingIntent,
  agendaItem: SecretaryAgendaItem,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: SecretaryReasonCode[],
  explanation: string,
  conflicts: string[],
  downstreamImplications: string[],
  fallbackTrail: ReasoningTrailNode[] = [],
): SecretarySchedulingDecision {
  const selectedSlot = agendaItem.startAt && agendaItem.endAt
    ? { start: agendaItem.startAt, end: agendaItem.endAt }
    : null;
  const alternativeSlots = agendaItem.scheduledSegments.filter((segment) => (
    !selectedSlot || segment.start !== selectedSlot.start || segment.end !== selectedSlot.end
  ));
  const resolvedStatus = agendaItem.decisionAction || status;
  // Coerce legacy DB-shape `string[]` to typed reason codes at the read boundary;
  // unknown legacy values are filtered out (see secretary-reason-codes.ts W-A).
  const persistedReasonCodes = agendaItem.decisionReasonCodes.length > 0
    ? filterKnownReasonCodes(agendaItem.decisionReasonCodes)
    : reasonCodes;
  // W-E: prefer the persisted trail from the agenda item (canonical row
  // truth); fall back to the in-flight trail from this scheduleOne pass when
  // the row predates the column or persistence was skipped.
  const reasoningTrail = agendaItem.reasoningTrail.length > 0
    ? agendaItem.reasoningTrail
    : fallbackTrail;
  return {
    status: resolvedStatus,
    agendaItem,
    reasonCodes: persistedReasonCodes,
    explanation,
    selectedSlot,
    alternativeSlots,
    conflicts,
    downstreamImplications,
    confidence: confidenceFor(resolvedStatus, persistedReasonCodes),
    feedback: buildFeedback(intent, agendaItem, resolvedStatus, persistedReasonCodes, downstreamImplications),
    reasoningTrail,
  };
}

function validateIntent(intent: SecretarySchedulingIntent): SecretaryReasonCode[] {
  const reasonCodes: SecretaryReasonCode[] = [];
  if (!Number.isFinite(intent.ownerUserId) || intent.ownerUserId <= 0) reasonCodes.push('invalid_owner_scope');
  if (!normalizeTenantId(intent.tenantId)) reasonCodes.push('invalid_tenant_scope');
  if (!VALID_SOURCE_SKILLS.has(intent.sourceSkill)) reasonCodes.push('invalid_source_skill');
  if (!intent.intentId?.trim()) reasonCodes.push('missing_intent_id');
  if (!intent.title?.trim()) reasonCodes.push('missing_title');
  if (!Number.isFinite(Number(intent.requestedDurationMinutes)) || Number(intent.requestedDurationMinutes) <= 0) {
    reasonCodes.push('missing_duration');
  }
  if (!Array.isArray(intent.preferredWindows) || intent.preferredWindows.length === 0) {
    reasonCodes.push('missing_availability');
  }
  return reasonCodes;
}

function findLatestAgendaItemForIntent(intent: SecretarySchedulingIntent): SecretaryAgendaItem | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM secretary_agenda_items
    WHERE owner_user_id = ?
      AND tenant_id = ?
      AND source_skill = ?
      AND source_intent_id = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(
    intent.ownerUserId,
    normalizeTenantId(intent.tenantId),
    intent.sourceSkill,
    intent.intentId,
  );
  return row ? rowToAgendaItem(row) : null;
}

function findAgendaItemById(agendaItemId: string): SecretaryAgendaItem | null {
  const db = getDb();
  ensureSecretaryAgendaDecisionExplanationColumn(db);
  const row = db.prepare('SELECT * FROM secretary_agenda_items WHERE agenda_item_id = ?').get(agendaItemId);
  return row ? rowToAgendaItem(row) : null;
}

function buildBusyWindows(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions,
  acceptedBusyWindows: SecretaryTimeWindow[],
): NormalizedWindow[] {
  const persisted = listSecretaryAgendaItems({
    ownerUserId: intent.ownerUserId,
    tenantId: intent.tenantId,
  })
    .filter((item) => item.sourceSkill !== intent.sourceSkill || item.sourceIntentId !== intent.intentId)
    .filter((item) => ACTIVE_BUSY_STATES.has(item.lifecycleState) && item.startAt && item.endAt)
    .map((item) => ({
      start: item.startAt!,
      end: item.endAt!,
      label: item.title,
    }));
  const existing = (options.existingAgendaItems ?? [])
    .filter((item) => ACTIVE_BUSY_STATES.has(item.lifecycleState) && item.startAt && item.endAt)
    .map((item) => ({
      start: item.startAt!,
      end: item.endAt!,
      label: item.title,
    }));
  return normalizeWindows([
    ...persisted,
    ...existing,
    ...(options.additionalBusyWindows ?? []),
    ...acceptedBusyWindows,
    ...(intent.hardConstraints?.unavailableWindows ?? []),
    ...(intent.hardConstraints?.protectedWindows ?? []),
    ...(intent.hardConstraints?.hardCommitments ?? []),
  ]);
}

function normalizeWindows(windows: SecretaryTimeWindow[]): NormalizedWindow[] {
  const normalized: NormalizedWindow[] = [];
  for (const window of windows) {
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const item: NormalizedWindow = {
      startMs,
      endMs,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    };
    if (window.label) item.label = window.label;
    normalized.push(item);
  }
  return normalized.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function findFirstAvailableSlot(
  windows: NormalizedWindow[],
  busyWindows: NormalizedWindow[],
  durationMinutes: number,
): CandidateSlot | null {
  const durationMs = durationMinutes * 60_000;
  for (const window of windows) {
    const slot = findSlotInWindow(window, busyWindows, durationMs, durationMs);
    if (slot) return slot;
  }
  return null;
}

function findLargestAvailableSlot(
  windows: NormalizedWindow[],
  busyWindows: NormalizedWindow[],
  minimumDurationMinutes: number,
  requestedDurationMinutes: number,
): CandidateSlot | null {
  const minimumMs = minimumDurationMinutes * 60_000;
  const requestedMs = requestedDurationMinutes * 60_000;
  let best: CandidateSlot | null = null;
  for (const window of windows) {
    const slot = findSlotInWindow(window, busyWindows, minimumMs, requestedMs);
    if (!slot) continue;
    if (!best || slot.durationMinutes > best.durationMinutes) best = slot;
  }
  return best;
}

function findSlotInWindow(
  window: NormalizedWindow,
  busyWindows: NormalizedWindow[],
  minimumMs: number,
  preferredMs: number,
): CandidateSlot | null {
  let cursor = window.startMs;
  const overlaps = busyWindows
    .filter((busy) => busy.endMs > window.startMs && busy.startMs < window.endMs)
    .sort((left, right) => left.startMs - right.startMs);

  for (const busy of overlaps) {
    const gapEnd = Math.min(busy.startMs, window.endMs);
    const gapMs = gapEnd - cursor;
    if (gapMs >= minimumMs) {
      const durationMs = Math.min(preferredMs, gapMs);
      return {
        startMs: cursor,
        endMs: cursor + durationMs,
        durationMinutes: Math.round(durationMs / 60_000),
        sourceWindow: window,
      };
    }
    cursor = Math.max(cursor, busy.endMs);
    if (cursor >= window.endMs) break;
  }

  const tailMs = window.endMs - cursor;
  if (tailMs >= minimumMs) {
    const durationMs = Math.min(preferredMs, tailMs);
    return {
      startMs: cursor,
      endMs: cursor + durationMs,
      durationMinutes: Math.round(durationMs / 60_000),
      sourceWindow: window,
    };
  }
  return null;
}

function slotToWindow(slot: CandidateSlot): SecretaryTimeWindow {
  return {
    start: new Date(slot.startMs).toISOString(),
    end: new Date(slot.endMs).toISOString(),
    label: slot.sourceWindow.label,
  };
}

function candidateWindowsToAlternatives(
  windows: NormalizedWindow[],
  selected: CandidateSlot,
): SecretaryTimeWindow[] {
  return windows
    .filter((window) => window.startMs !== selected.sourceWindow.startMs || window.endMs !== selected.sourceWindow.endMs)
    .slice(0, 3)
    .map((window) => ({ start: window.start, end: window.end, label: window.label }));
}

function conflictSummaries(busyWindows: NormalizedWindow[]): string[] {
  return busyWindows
    .slice(0, 5)
    .map((busy) => busy.label ? `${busy.label}: ${busy.start} - ${busy.end}` : `${busy.start} - ${busy.end}`);
}

function compareIntentPriority(left: SecretarySchedulingIntent, right: SecretarySchedulingIntent): number {
  const leftScore = scoreIntent(left);
  const rightScore = scoreIntent(right);
  if (leftScore !== rightScore) return rightScore - leftScore;
  const leftDeadline = left.deadline ? Date.parse(left.deadline) : Number.POSITIVE_INFINITY;
  const rightDeadline = right.deadline ? Date.parse(right.deadline) : Number.POSITIVE_INFINITY;
  return leftDeadline - rightDeadline || left.intentId.localeCompare(right.intentId);
}

function scoreIntent(intent: SecretarySchedulingIntent): number {
  const base = typeof intent.priority === 'number'
    ? intent.priority
    : intent.priority === 'urgent'
      ? 100
      : intent.priority === 'high'
        ? 70
        : intent.priority === 'low'
          ? 20
          : 45;
  const deadlineBoost = intent.deadline && Number.isFinite(Date.parse(intent.deadline)) ? 18 : 0;
  const fixedBoost = intent.flexibility === 'fixed' ? 8 : 0;
  const phaseBoost = phaseBoostFor(intent.sourceSkill, intent.goalPhase ?? null);
  return base + SKILL_PRIORITY_WEIGHT[intent.sourceSkill] + deadlineBoost + fixedBoost + phaseBoost;
}

/**
 * Dynamic priority phase boost (C3 workstream).
 *
 * Training is the only skill that adapts to goal phase today; other skills
 * pass `goalPhase` through harmlessly with a 0 boost. Finance's deadline
 * boost (+18) remains the dominant signal so a tax deadline still outranks
 * Training even in race week (race phase = -4 + base 12 = 8 < Finance 16).
 *
 * Phase = null/undefined → 0 (graceful default; pre-C3 behavior).
 */
function phaseBoostFor(sourceSkill: SecretarySourceSkill, phase: SecretaryGoalPhase | null): number {
  if (phase == null) return 0;
  if (sourceSkill !== 'training') return 0;
  switch (phase) {
    case 'build': return 2;
    case 'peak': return 3;
    case 'taper': return -2;
    case 'race': return -4;
    case 'deload': return -3;
    case 'base':
    case 'maintenance':
      return 0;
    default: return 0;
  }
}

function priorityReasonCodes(intent: SecretarySchedulingIntent): SecretaryReasonCode[] {
  const codes: SecretaryReasonCode[] = [];
  if (intent.priority === 'urgent' || intent.priority === 'high' || Number(intent.priority) >= 70) {
    codes.push('high_priority_intent');
  }
  if (intent.deadline) codes.push('deadline_present');
  if (intent.sourceSkill === 'finance' && intent.deadline) codes.push('finance_deadline_priority');
  if (intent.sourceSkill === 'training') codes.push('training_schedule_request');
  if (intent.sourceSkill === 'cooking') codes.push('cooking_support_request');
  if (intent.sourceSkill === 'content') codes.push('content_focus_request');
  return codes;
}

function slotReasonCodes(intent: SecretarySchedulingIntent, slot: CandidateSlot): SecretaryReasonCode[] {
  const codes = priorityReasonCodes(intent);
  if (slot.durationMinutes < Number(intent.requestedDurationMinutes)) codes.push('duration_reduced');
  if (intent.flexibility === 'fixed') codes.push('fixed_intent_respected');
  return codes;
}

function hasDeadlineAfterWindows(deadline: string | null | undefined, windows: NormalizedWindow[]): boolean {
  if (!deadline || windows.length === 0) return false;
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return false;
  const latestWindowEnd = Math.max(...windows.map((window) => window.endMs));
  return deadlineMs > latestWindowEnd;
}

function explainDecision(
  intent: SecretarySchedulingIntent,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: readonly SecretaryReasonCode[],
): string {
  const title = intent.title.trim() || 'This item';
  switch (status) {
    case 'scheduled':
      return `${title} was scheduled in an available window.`;
    case 'reflowed':
      return `${title} was moved to a new available window because the previous placement no longer fit.`;
    case 'compressed':
      return `${title} was compressed to fit the available capacity.`;
    case 'deferred':
      return `${title} was deferred because current windows are full but the deadline leaves room to revisit it.`;
    case 'unscheduled':
      return `${title} was left unscheduled because no valid slot was available.`;
    case 'rejected':
      return `${title} was rejected because the scheduling request failed policy or ownership validation.`;
    case 'needs_more_context':
      return reasonCodes.includes('missing_duration')
        ? `${title} needs a duration before Secretary can schedule it.`
        : `${title} needs clearer availability before Secretary can schedule it.`;
    default:
      return `${title} produced a scheduling decision.`;
  }
}

function downstreamFor(
  intent: SecretarySchedulingIntent,
  status: SecretarySchedulingDecisionStatus,
): string[] {
  const implications: string[] = [];
  if (status === 'unscheduled') {
    implications.push(`${intent.sourceSkill} should treat this as not placed on the agenda.`);
  }
  if (status === 'deferred') {
    implications.push(`${intent.sourceSkill} should refresh the intent before the deadline window closes.`);
  }
  if (status === 'compressed') {
    implications.push(`${intent.sourceSkill} should adapt the workload to the shorter scheduled block.`);
  }
  if (status === 'reflowed') {
    implications.push(`${intent.sourceSkill} should refresh any user-facing time copy for this item.`);
  }
  if (status === 'needs_more_context') {
    implications.push(`${intent.sourceSkill} should provide the missing scheduling context or ask the user a targeted question.`);
  }
  return implications;
}

function defaultActionForStatus(status: SecretarySchedulingDecisionStatus): SecretarySchedulingIntentAction {
  if (status === 'needs_more_context') return 'request_clarification';
  if (status === 'unscheduled') return 'find_time_for_this';
  return 'schedule_this';
}

function buildFeedback(
  intent: SecretarySchedulingIntent,
  agendaItem: SecretaryAgendaItem,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: readonly SecretaryReasonCode[],
  downstreamImplications: string[],
): SecretarySourceSkillFeedback {
  return {
    sourceSkill: intent.sourceSkill,
    sourceIntentId: intent.intentId,
    agendaItemId: agendaItem.agendaItemId,
    ownerUserId: agendaItem.ownerUserId,
    tenantId: agendaItem.tenantId,
    agendaVersion: agendaItem.version,
    status,
    reasonCodes: [...reasonCodes],
    scheduledStart: agendaItem.startAt,
    scheduledEnd: agendaItem.endAt,
    shouldRefreshSource: ['reflowed', 'compressed', 'deferred', 'unscheduled', 'needs_more_context'].includes(status),
    downstreamImplications,
  };
}

function buildFeedbackBySourceSkill(decisions: SecretarySchedulingDecision[]): Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]> {
  const empty: Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]> = {
    secretary: [],
    training: [],
    cooking: [],
    finance: [],
    content: [],
  };
  for (const decision of decisions) {
    empty[decision.feedback.sourceSkill].push(decision.feedback);
  }
  return empty;
}

function confidenceFor(status: SecretarySchedulingDecisionStatus, reasonCodes: readonly SecretaryReasonCode[]): 'low' | 'medium' | 'high' {
  if (status === 'scheduled' || status === 'reflowed') return 'high';
  if (status === 'compressed' || status === 'deferred') return 'medium';
  if (reasonCodes.includes('missing_duration') || reasonCodes.includes('missing_availability')) return 'low';
  return 'medium';
}

function computeSourceShapeHash(intent: SecretarySchedulingIntent): string {
  return sha256(stableStringify({
    action: intent.action ?? 'schedule_this',
    sourceSkill: intent.sourceSkill,
    sourceEntityId: intent.sourceEntityId ?? null,
    sourceEntityType: intent.sourceEntityType ?? null,
    title: intent.title,
    requestedDurationMinutes: intent.requestedDurationMinutes ?? null,
    minimumDurationMinutes: intent.minimumDurationMinutes ?? null,
    preferredWindows: intent.preferredWindows ?? [],
    hardConstraints: intent.hardConstraints ?? {},
    deadline: intent.deadline ?? null,
    priority: intent.priority ?? 'normal',
    flexibility: intent.flexibility ?? 'flexible',
    dependencies: intent.dependencies ?? [],
    energyCost: intent.energyCost ?? null,
  })).slice(0, 32);
}

function buildAgendaItemId(intent: SecretarySchedulingIntent, version: number): string {
  return `sec_agenda_${sha256(`${intent.ownerUserId}:${normalizeTenantId(intent.tenantId)}:${intent.sourceSkill}:${intent.intentId}:${version}`).slice(0, 24)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function normalizeTenantId(value: string | number): string {
  return String(value ?? '').trim();
}

function normalizeNow(now?: string): string {
  if (now) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
}

function rowToAgendaItem(row: any): SecretaryAgendaItem {
  return {
    agendaItemId: row.agenda_item_id,
    sourceIntentId: row.source_intent_id,
    sourceSkill: row.source_skill,
    sourceAction: row.source_action ?? null,
    intentAction: row.intent_action,
    sourceEntityId: row.source_entity_id ?? null,
    sourceEntityType: row.source_entity_type ?? null,
    ownerUserId: Number(row.owner_user_id),
    tenantId: String(row.tenant_id),
    lifecycleState: row.lifecycle_state,
    providerSyncState: row.provider_sync_state,
    providerEventId: row.provider_event_id ?? null,
    providerSource: row.provider_source ?? null,
    version: Number(row.version),
    title: row.title,
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    decisionAction: row.decision_action,
    decisionReasonCodes: safeParseArray(row.decision_reason_codes_json),
    decisionExplanation: row.decision_explanation ?? null,
    sourceShapeHash: row.source_shape_hash,
    scheduledSegments: safeParseArray(row.scheduled_segments_json),
    cancellationReason: row.cancellation_reason ?? null,
    supersededByAgendaItemId: row.superseded_by_agenda_item_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    sourceCreatedAt: row.source_created_at ?? null,
    sourceUpdatedAt: row.source_updated_at ?? null,
    // W-E: legacy rows (pre-column-add) decode to []. The PRAGMA add is
    // idempotent so this is the only place that needs to be defensive.
    reasoningTrail: safeParseArray<ReasoningTrailNode>(row.reasoning_trail_json),
  };
}

function safeParseArray<T = any>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
