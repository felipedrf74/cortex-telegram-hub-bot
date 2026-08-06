// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as trainingPlans from '../../services/training-plans';
import { DateTime } from 'luxon';
import { getDb } from '../../services/database';
import {
  buildRichSessionDescription,
  type AthleteProfiles,
  type SessionDescriptionInput,
} from '../../services/training-session-description';
import { getPlanVersion } from '../../services/training-plan-lifecycle';
import { emitDomainEvent } from '../../services/event-outbox';
import {
  TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
  type TrainingPlanCalendarSyncSummary,
} from '../../services/training-plan-calendar-sync-worker';
import {
  buildTrainingSessionIdentityKey,
  computeTrainingSessionShapeHash,
} from '../../services/training-session-identity';
import {
  lintPlan,
  type EquipmentProfileLabel,
  type PlanLintFinding,
  type PlanLintInput,
  type PlanLintSession,
  type PlanLintWeek,
  type PlanLintResult,
} from '../../services/coach-kernel/plan-linter';
import type { MovementPattern, MuscleGroup } from '../../services/coach-kernel/training-taxonomy';
import type { TrainingSessionSection } from '../../services/coach-kernel/training-plan-quality-gate';
import type { TrainingPlanSpec } from '../../services/training-plan-spec';
import type { TrainingDecisionReason } from '../../services/coach-kernel/types';
import { logger } from '../../utils/logger';
import {
  withTrainingCalendarOperationLock,
  type TrainingOperationLockLease,
} from '../../services/training-operation-locks';
import { requireTenantIdParam } from '../../services/tenant-scope';
import { getTrainingExerciseIdentityV1Mode } from '../../services/runtime-flags';
import {
  preferredTimeForSessionType,
  scheduleSessionWindow,
  type BusyWindow,
  type ScheduleSessionResult,
} from './training-schedule-utils';
import type { CalendarSource } from '../../services/unified-calendar';
import {
  flattenTrainingExerciseTokens,
  inferTrainingSessionIsLongRun,
  inferTrainingSessionIsLowerHeavy,
} from '../../services/training-session-classification';
import { incrementTrainingGenerationCounter } from '../../services/training-generation-observability';
import {
  normalizeTrainingTimezone,
  resolveTrainingTimezone,
} from '../../services/training-date-utils';
import {
  assertTrainingPlanGenerationIdempotencyLease,
  completeTrainingPlanGenerationIdempotency,
  TrainingPlanGenerationLeaseLostError,
  type TrainingPlanGenerationLeaseIdentity,
} from '../../services/training-plan-generation-idempotency';
export { TrainingPlanReplacementConflictError } from '../../services/training-plans';

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

type GeneratedTrainingPlan = {
  planName?: string;
  sport?: string;
  periodization?: string;
  weeks?: Array<{
    weekNumber?: number;
    focus?: string;
    intensityPct?: number;
    notes?: string[];
    decisionReasons?: TrainingDecisionReason[];
    sessions?: Array<GeneratedTrainingSession>;
  }>;
};

type GeneratedTrainingSession = {
  sport?: string;
  dayOfWeek?: string;
  sessionType?: string;
  title?: string;
  description?: string;
  exercises?: Array<Record<string, any>>;
  durationMinutes?: number;
  preferredStartTime?: string;
  scheduleState?: string;
  scheduleAdjustments?: string[];
  scheduleReason?: string;
  decisionReasons?: TrainingDecisionReason[];
  sessionRole?: string;
  sessionRoleLabel?: string;
  sessionRoleSummary?: string;
  keySessionLabel?: string;
  scheduleFinalizedBy?: string;
  finalizedScheduledStart?: string;
  finalizedScheduledEnd?: string;
  finalizedPreferredTimeUnavailable?: boolean;
  splitCode?: string;
  splitSlot?: string;
  focus?: string;
  primaryMuscles?: MuscleGroup[];
  secondaryMuscles?: MuscleGroup[];
  movementPatterns?: MovementPattern[];
  estimatedDurationMinutes?: number;
  sections?: TrainingSessionSection[];
  intensitySummary?: SessionDescriptionInput['session']['intensitySummary'];
  intensityProfile?: Record<string, unknown>;
  tags?: string[];
};

type PersistableSessionScheduleState =
  | 'pending'
  | 'scheduled'
  | 'reflowed'
  | 'compressed'
  | 'capped'
  | 'unscheduled'
  | 'deferred'
  | 'dropped';

const ACTIVE_SCHEDULE_STATES = new Set<PersistableSessionScheduleState>([
  'scheduled',
  'reflowed',
  'compressed',
  'capped',
]);

const INACTIVE_SCHEDULE_STATES = new Set<PersistableSessionScheduleState>([
  'unscheduled',
  'deferred',
  'dropped',
]);

const PRE_PERSIST_SCHEDULE_FINALIZER_VERSION = 'training_pre_persist_schedule_finalizer_v1';

/**
 * Persist only the coach kernel's string-note contract. JSON encoding keeps
 * note boundaries unambiguous for downstream readers and prevents malformed
 * runtime values from being coerced into user-facing evidence.
 */
function serializeGeneratedWeekNotes(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes = value
    .filter((note): note is string => typeof note === 'string')
    .map((note) => note.trim())
    .filter(Boolean);
  return JSON.stringify(notes);
}

export interface PersistGeneratedTrainingPlanInput {
  /** Compatibility generation replaces the predecessor in this transaction. */
  replaceExistingActivePlan?: boolean;
  /** Active-plan snapshot captured before candidate construction; exact CAS. */
  expectedActivePlanIds?: number[];
  /** F1 owner/fencing identity asserted at activation + outbox boundaries. */
  generationIdempotencyLease?: TrainingPlanGenerationLeaseIdentity;
  /**
   * Pure response projection used to store the exact replay payload in the
   * same commit as activation. No I/O is permitted in this callback.
   */
  buildCommittedIdempotencyResponse?: (
    result: PersistGeneratedTrainingPlanResult,
  ) => Record<string, unknown>;
  /**
   * F6 (Phase 1A-2): persist the plan as `pending_activation` instead of
   * `active`. Readers all filter `status = 'active'`, so the replacement is
   * durable but invisible until the caller activates it — which is what lets
   * generation write the replacement BEFORE removing the plan it replaces.
   * Defaults to false so every other caller keeps the released behaviour.
   */
  persistAsPending?: boolean;
  userId: number;
  tenantId: number;
  objective: string;
  durationWeeks: number;
  startDate: string;
  endDate: string;
  now: Date;
  /**
   * Trusted scheduling zone resolved by the server. New plans also persist
   * this value in preferences_json so later calendar work keeps creation-zone
   * semantics even after the user's current timezone changes.
   */
  schedulingTimezone?: string;
  planData: GeneratedTrainingPlan;
  preferencesJson: string;
  normalizedPreferredTime: string;
  normalizedPreferredCardioTime: string;
  normalizedPreferredStrengthTime: string;
  busyWindows: BusyWindow[];
  /**
   * Optional athlete profile data. When present, the rich session
   * description includes pace/HR/power zones derived from threshold
   * pace, FTP, max HR, etc. When absent, the description gracefully
   * omits the per-zone block and uses generic effort cues.
   */
  athleteProfiles?: AthleteProfiles;
  calendarSource?: CalendarSource;
  // ─── Optional plan-linter context ──────────────────────────────────
  // training-expert-coach-knowledge-engine (2026-05-03):
  // The persister runs the deterministic plan-linter AFTER all sessions
  // are written so it can validate cross-week + cross-session
  // invariants no per-session check sees. These optional fields enrich
  // the lint context — when absent, the relevant rules gracefully no-op.
  /** Equipment profile vocabulary as resolved by the equipment-adaptation pass. */
  equipmentProfile?: EquipmentProfileLabel;
  /** Race date if the plan is event-based; enables the taper / race-specific rules. */
  raceDate?: string | Date | null;
  /** True when the plan was generated for a specific event (marathon, 5k, etc.). */
  isRaceSpecific?: boolean;
  /** Request goal mode; `event_based` enables strict race-date semantics. */
  goalMode?: string | null;
  /** F7 (Phase 3): athlete two-a-day stance; 'never' arms the per-day cap lint rule. */
  twoADayPreference?: string | null;
  /** Explicit swim access from profile/intake; false blocks swim prescriptions. */
  hasPoolAccess?: boolean | null;
  /** True when FTP, threshold power, or equivalent cycling benchmark is known. */
  cyclingBenchmarkAvailable?: boolean | null;
  /** True when request/profile is triathlon-specific. */
  triathlonMode?: boolean | null;
  /** Deterministic training generation contract used by the strict quality gate. */
  trainingPlanSpec?: TrainingPlanSpec;
}

export interface PersistGeneratedTrainingPlanResult {
  planId: number;
  totalSessions: number;
  /**
   * Phase 1B: provider calendar work no longer runs inline, so persistence
   * can never report created/linked events — both are always 0 here. They
   * remain on the result so released callers keep a stable shape;
   * `calendarSyncQueued` + `syncableSessions` describe what was actually
   * requested through the outbox.
   */
  eventsCreated: number;
  sessionsLinked: number;
  /** True when a `training.plan_calendar_sync.requested.v1` event was emitted in the plan-graph transaction. */
  calendarSyncQueued: boolean;
  /** Count of persisted sessions eligible for a provider calendar event. */
  syncableSessions: number;
  weekSummaries: Array<{
    weekNumber: number | undefined;
    focus: string | undefined;
    sessionCount: number;
  }>;
  /**
   * Plan-linter verdict + findings. Always populated; in advisor mode
   * (the default), `status === 'fail'` does NOT prevent the plan from
   * being persisted — the API caller decides what to surface.
   */
  lint: PlanLintResult;
}

/**
 * Pure schedule finalizer for the app-facing plan generation route.
 * Persistence must not be the first place session placement is decided:
 * final validation needs to see the exact schedule/status shape that will
 * be written. This helper computes the same deterministic scheduling
 * decisions formerly made inside the write loop, annotates a cloned plan,
 * and leaves DB rows untouched.
 */
export function finalizeGeneratedTrainingPlanForPersistence(
  input: PersistGeneratedTrainingPlanInput,
): PersistGeneratedTrainingPlanInput {
  const normalizedInput = {
    ...input,
    schedulingTimezone: schedulingTimezoneForPersistence(input),
  };
  if (isPlanScheduleFinalized(normalizedInput.planData)) return normalizedInput;

  const scheduledWindows: BusyWindow[] = [];
  const planData: GeneratedTrainingPlan = {
    ...normalizedInput.planData,
    weeks: (normalizedInput.planData.weeks ?? []).map((weekData) => ({
      ...weekData,
      sessions: (weekData.sessions ?? []).map((sessionData) => finalizeGeneratedTrainingSessionSchedule({
        input: normalizedInput,
        weekData,
        sessionData,
        scheduledWindows,
      })),
    })),
  };
  return { ...normalizedInput, planData };
}

function schedulingTimezoneForPersistence(input: PersistGeneratedTrainingPlanInput): string {
  const explicit = normalizeTrainingTimezone(input.schedulingTimezone);
  if (explicit) return explicit;
  try {
    const parsed = JSON.parse(input.preferencesJson) as Record<string, unknown>;
    const persisted = normalizeTrainingTimezone(
      typeof parsed?.schedulingTimezone === 'string' ? parsed.schedulingTimezone : null,
    );
    if (persisted) return persisted;
  } catch {
    // Malformed preferences are preserved by the existing persistence path;
    // scheduling still gets a safe canonical fallback for this operation.
  }
  return resolveTrainingTimezone();
}

/**
 * Strict, write-free Training quality gate for the app-facing plan
 * generation route. This reuses the canonical plan-linter + the same
 * generated-plan-to-lint-week mapper as persistence, and now validates
 * the finalized deterministic schedule before any old plan is cancelled
 * or any new plan row is persisted.
 */
export function lintGeneratedTrainingPlanPreflight(
  input: PersistGeneratedTrainingPlanInput,
): PlanLintResult {
  const finalizedInput = finalizeGeneratedTrainingPlanForPersistence(input);
  return runPlanLintGuarded({
    input: finalizedInput,
    weeks: finalizedInput.planData.weeks ?? [],
    calendarEvents: collectFinalizedCalendarEventsForLint(finalizedInput.planData),
    mode: 'strict_preflight',
  });
}

export async function persistGeneratedTrainingPlan(
  input: PersistGeneratedTrainingPlanInput,
): Promise<PersistGeneratedTrainingPlanResult> {
  const tenantId = requireTenantIdParam(input.tenantId, 'persistGeneratedTrainingPlan');
  const finalizedInput = finalizeGeneratedTrainingPlanForPersistence(input);
  return withTrainingCalendarOperationLock(
    {
      userId: finalizedInput.userId,
      tenantId,
      operation: 'calendar_generate',
    },
    (lease) => persistGeneratedTrainingPlanLocked(finalizedInput, lease),
  );
}

async function persistGeneratedTrainingPlanLocked(
  input: PersistGeneratedTrainingPlanInput,
  lease: TrainingOperationLockLease,
): Promise<PersistGeneratedTrainingPlanResult> {
  const tenantId = requireTenantIdParam(input.tenantId, 'persistGeneratedTrainingPlanLocked');
  const preferencesJson = appendSelectorSupportDebugTraces(input.preferencesJson, input.planData, input.now, input.userId);

  // F4 (Phase 1B) — plan + weeks + sessions commit atomically or not at all.
  //
  // These were previously independent inserts: `createPlan`, then a
  // `createWeek` per week, then a `createSession` per session. A throw or
  // SQLITE_BUSY partway through left a committed plan row with a partial
  // week/session graph and no rollback — and because generation used to
  // delete the prior plan first, that partial state was all the user had.
  //
  // Only the synchronous DB phase is wrapped. Provider calls never run in
  // this module at all (Phase 1B): the transaction emits a
  // `training.plan_calendar_sync.requested.v1` outbox event — durable if and
  // only if the plan graph commits — and the dedicated
  // training_plan_calendar_sync worker performs provider HTTP after commit,
  // once the plan is actually active.
  const db = getDb();
  const persistPlanGraph = db.transaction(() => {
  lease.assertActive();
  const plan = trainingPlans.createPlan({
    user_id: input.userId,
    tenant_id: tenantId,
    name: input.planData.planName || `${input.objective} Plan`,
    sport: input.planData.sport || 'hybrid',
    goal: input.objective,
    duration_weeks: input.durationWeeks,
    periodization: input.planData.periodization || 'undulating',
    start_date: input.startDate,
    end_date: input.endDate,
    preferences_json: preferencesJson,
    status: input.replaceExistingActivePlan || input.persistAsPending
      ? 'pending_activation'
      : 'active',
  });

  let totalSessions = 0;
  // Phase 1B: this array only carries the identity + finalized window needed
  // by the lint mapper and the outbox payload. Provider titles/descriptions
  // are rebuilt from persisted rows by the calendar-sync worker.
  const calendarEvents: Array<{
    sessionId: number;
    sessionIdentityKey: string;
    sessionShapeHash: string;
    start: string;
    end: string;
  }> = [];
  for (const weekData of input.planData.weeks || []) {
    const sessionOrdinals = new Map<string, number>();
    const week = trainingPlans.createWeek({
      plan_id: plan.id,
      week_number: weekData.weekNumber || 1,
      focus: weekData.focus || 'base',
      intensity_pct: weekData.intensityPct || 70,
      volume_sessions: weekData.sessions?.filter(isCalendarSchedulableTrainingSession).length || 0,
      notes: serializeGeneratedWeekNotes(weekData.notes),
    });

    for (const sessionData of weekData.sessions || []) {
      const explicitInactiveState = inactiveScheduleState(sessionData);
      if (!explicitInactiveState && isStandaloneRestOrMobilitySession(sessionData)) continue;

      const dayIndex = DAY_NAMES.indexOf(sessionData.dayOfWeek?.toLowerCase() || '');
      if (dayIndex < 0) continue;

      const durationMinutes = sessionData.durationMinutes ?? (explicitInactiveState ? 0 : 60);
      const persistedExercises = stripSupportDebugExerciseFields(sessionData.exercises || []);

      const richDescription = buildRichSessionDescription(
        buildSessionDescriptionInput({
          input,
          weekData,
          sessionData,
          durationMinutes,
        }),
      );
      const intensityText = `RPE ${weekData.intensityPct || 70}%`;
      const ordinalKey = [
        String(sessionData.dayOfWeek || '').trim().toLowerCase(),
        String(sessionData.sessionType || 'training').trim().toLowerCase(),
      ].join('|');
      const ordinal = (sessionOrdinals.get(ordinalKey) ?? 0) + 1;
      sessionOrdinals.set(ordinalKey, ordinal);
      const sessionIdentityKey = buildTrainingSessionIdentityKey({
        planId: plan.id,
        weekNumber: weekData.weekNumber || 1,
        dayOfWeek: sessionData.dayOfWeek || '',
        sessionType: sessionData.sessionType || 'training',
        ordinal,
      });
      const sessionShapeHash = computeTrainingSessionShapeHash({
        sessionType: sessionData.sessionType || 'training',
        title: sessionData.title || 'Training session',
        durationMinutes,
        intensityText,
        exercises: persistedExercises,
        descriptionSections: richDescription.sections,
      });

      if (explicitInactiveState) {
        if (
          explicitInactiveState === 'unscheduled'
          && sessionData.finalizedPreferredTimeUnavailable === true
        ) {
          logger.warn(
            {
              userId: input.userId,
              tenantId,
              planId: plan.id,
              weekNumber: weekData.weekNumber || 1,
              dayOfWeek: sessionData.dayOfWeek || '',
              sessionType: sessionData.sessionType || 'training',
              reasonCode: 'finalized_schedule_unavailable',
            },
            'persistGeneratedTrainingPlan: no calendar slot was available for finalized unscheduled session',
          );
        }
        trainingPlans.createSession({
          week_id: week.id,
          plan_id: plan.id,
          day_of_week: sessionData.dayOfWeek || '',
          session_type: sessionData.sessionType || 'training',
          title: sessionData.title || 'Training session',
          description: appendScheduleReason(richDescription.text, sessionData.scheduleReason),
          description_json: JSON.stringify(richDescription.sections),
          exercises_json: JSON.stringify(persistedExercises),
          duration_minutes: durationMinutes,
          intensity_text: intensityText,
          session_identity_key: sessionIdentityKey,
          session_shape_hash: sessionShapeHash,
          preferred_time_unavailable: true,
          status: explicitInactiveState,
        });
        continue;
      }

      const activeScheduleState = activeScheduleStateFor(sessionData);
      const activeDescription = appendScheduleReason(richDescription.text, sessionData.scheduleReason);

      const finalizedWindow = finalizedScheduleWindowForSession(sessionData);
      if (!finalizedWindow) {
        const reason = 'No finalized Training schedule slot was available before persistence.';
        trainingPlans.createSession({
          week_id: week.id,
          plan_id: plan.id,
          day_of_week: sessionData.dayOfWeek || '',
          session_type: sessionData.sessionType || 'training',
          title: sessionData.title || 'Training session',
          description: appendScheduleReason(activeDescription, reason),
          description_json: JSON.stringify(richDescription.sections),
          exercises_json: JSON.stringify(persistedExercises),
          duration_minutes: durationMinutes,
          intensity_text: intensityText,
          session_identity_key: sessionIdentityKey,
          session_shape_hash: sessionShapeHash,
          preferred_time_unavailable: true,
          status: 'unscheduled',
        });
        logger.warn(
          {
            userId: input.userId,
            planId: plan.id,
            weekNumber: weekData.weekNumber || 1,
            dayOfWeek: sessionData.dayOfWeek || '',
            sessionType: sessionData.sessionType || 'training',
            reasonCode: 'missing_finalized_schedule_slot',
          },
          'persistGeneratedTrainingPlan: session persisted as unscheduled because final schedule slot was missing',
        );
        continue;
      }

      const session = trainingPlans.createSession({
        week_id: week.id,
        plan_id: plan.id,
        day_of_week: sessionData.dayOfWeek || '',
        session_type: sessionData.sessionType || 'training',
        title: sessionData.title || 'Training session',
        description: activeDescription,
        description_json: JSON.stringify(richDescription.sections),
        exercises_json: JSON.stringify(persistedExercises),
        duration_minutes: durationMinutes,
        intensity_text: intensityText,
        session_identity_key: sessionIdentityKey,
        session_shape_hash: sessionShapeHash,
        preferred_time_unavailable: finalizedWindow.preferredTimeUnavailable,
        status: activeScheduleState,
        // Phase 1B: persist the finalized window so the calendar-sync worker
        // can rebuild provider event times from the row after commit.
        scheduled_start_at: finalizedWindow.start.toISOString(),
        scheduled_end_at: finalizedWindow.end.toISOString(),
      });

      calendarEvents.push({
        sessionId: session.id,
        sessionIdentityKey,
        sessionShapeHash,
        start: finalizedWindow.start.toISOString(),
        end: finalizedWindow.end.toISOString(),
      });

      totalSessions++;
    }
  }

    const calendarWriteSource = effectiveTrainingCalendarWriteSource(input);
    let calendarSyncQueued = false;
    const lint = runPlanLintGuarded({
      input,
      planId: plan.id,
      weeks: input.planData.weeks ?? [],
      calendarEvents,
      mode: 'advisor',
    });
    if (lint.status === 'fail') {
      incrementTrainingGenerationCounter('final_validation_failure_total');
    }

    if (input.replaceExistingActivePlan) {
      lease.assertActive();
      if (input.generationIdempotencyLease) {
        assertTrainingPlanGenerationIdempotencyLease(
          input.userId,
          tenantId,
          input.generationIdempotencyLease,
          db,
        );
      }

      trainingPlans.activateCompatibilityPlanReplacement({
        planId: plan.id,
        userId: input.userId,
        tenantId,
        expectedActivePlanIds: input.expectedActivePlanIds ?? [],
      });
    }

    // Phase 1B — the calendar-sync request is durable exactly when the plan
    // graph + compatibility activation are. Provider work remains strictly
    // post-commit in the dedicated worker.
    if (calendarWriteSource !== null && calendarEvents.length > 0) {
      const planVersion = getPlanVersion(plan.id) ?? 1;
      emitDomainEvent({
        tenantId,
        userId: input.userId,
        sourceSkill: 'training',
        eventType: TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
        entityType: 'training_plan',
        entityId: plan.id,
        entityVersion: planVersion,
        schemaVersion: 'training-plan-calendar-sync.v1',
        payload: {
          planId: plan.id,
          planVersion,
          // Ids only: the outbox payload sanitizer redacts keys matching
          // /calendar|title|description/i and truncates long strings, so the
          // worker re-reads full session rows instead of trusting payload.
          sessionIds: calendarEvents.map((event) => event.sessionId),
          syncTarget: calendarWriteSource ?? 'auto',
          requestedSessions: calendarEvents.length,
        },
        privacyClassification: 'health',
        // Distinct prefix: the outbox idempotency index is NOT scoped by
        // event_type, so this must never collide with the activation event.
        idempotencyKey: `training.plan_calendar_sync.requested:${plan.id}:${planVersion}`,
      }, db);
      calendarSyncQueued = true;
    }

    persistPlanValidationSummary({
      planId: plan.id,
      preferencesJson,
      lint,
      now: input.now,
      strict: input.replaceExistingActivePlan === true,
      calendarSync: {
        schemaVersion: 1,
        state: 'not_synced',
        pending: calendarSyncQueued,
        provider: calendarWriteSource ?? null,
        requestedSessions: calendarEvents.length,
        eventsCreated: 0,
        eventsAttached: 0,
        eventsUpdated: 0,
        eventsAlreadyOwned: 0,
        eventsFailed: 0,
        eventsSkipped: 0,
        lastErrorCode: null,
        updatedAt: input.now.toISOString(),
      },
    });

    const result: PersistGeneratedTrainingPlanResult = {
      planId: plan.id,
      totalSessions,
      eventsCreated: 0,
      sessionsLinked: 0,
      calendarSyncQueued,
      syncableSessions: calendarEvents.length,
      weekSummaries: (input.planData.weeks || []).map((weekData) => ({
        weekNumber: weekData.weekNumber,
        focus: weekData.focus,
        sessionCount: weekData.sessions?.filter(isCalendarSchedulableTrainingSession).length || 0,
      })),
      lint,
    };

    // Re-check at the final durable boundary. Within this write transaction
    // SQLite prevents another connection from stealing the row between the
    // activation and outbox writes; expiry itself is still fail-closed.
    if (input.generationIdempotencyLease) {
      assertTrainingPlanGenerationIdempotencyLease(
        input.userId,
        tenantId,
        input.generationIdempotencyLease,
        db,
      );
    }
    lease.assertActive();

    // F1 + F6 crash boundary: the exact replay payload becomes `succeeded`
    // in the same commit as graph activation and outbox emission. A process
    // death after COMMIT but before the HTTP response therefore replays this
    // result instead of claiming a second replacement attempt.
    if (input.generationIdempotencyLease && input.buildCommittedIdempotencyResponse) {
      const completed = completeTrainingPlanGenerationIdempotency(
        input.userId,
        tenantId,
        input.generationIdempotencyLease,
        input.buildCommittedIdempotencyResponse(result),
        201,
        db,
      );
      if (!completed) {
        throw new TrainingPlanGenerationLeaseLostError();
      }
    }

    return result;
  });

  // Throws propagate with nothing committed — including the calendar-sync
  // outbox event; the caller (generation) then discards the pending
  // replacement and the athlete's existing plan stands.
  return persistPlanGraph();
}

function isPlanScheduleFinalized(planData: GeneratedTrainingPlan): boolean {
  const sessions = (planData.weeks ?? []).flatMap((week) => week.sessions ?? []);
  if (sessions.length === 0) return false;
  return sessions.every((session) => session.scheduleFinalizedBy === PRE_PERSIST_SCHEDULE_FINALIZER_VERSION);
}

function finalizeGeneratedTrainingSessionSchedule(args: {
  input: PersistGeneratedTrainingPlanInput;
  weekData: NonNullable<GeneratedTrainingPlan['weeks']>[number];
  sessionData: GeneratedTrainingSession;
  scheduledWindows: BusyWindow[];
}): GeneratedTrainingSession {
  const { input, weekData, sessionData } = args;
  const base: GeneratedTrainingSession = {
    ...sessionData,
    scheduleAdjustments: sessionData.scheduleAdjustments ? [...sessionData.scheduleAdjustments] : undefined,
    exercises: sessionData.exercises ? [...sessionData.exercises] : undefined,
    decisionReasons: sessionData.decisionReasons ? [...sessionData.decisionReasons] : undefined,
    scheduleFinalizedBy: PRE_PERSIST_SCHEDULE_FINALIZER_VERSION,
  };
  if (inactiveScheduleState(base) || isStandaloneRestOrMobilitySession(base)) {
    return base;
  }

  const dayIndex = DAY_NAMES.indexOf(base.dayOfWeek?.toLowerCase() || '');
  if (dayIndex < 0) return base;
  const durationMinutes = base.durationMinutes ?? 60;
  const scheduledWindow = scheduleSessionForPlan({
    weekNumber: weekData.weekNumber || 1,
    dayIndex,
    planStartDate: input.startDate,
    now: input.now,
    schedulingTimezone: input.schedulingTimezone,
    durationMinutes,
    sessionType: base.sessionType || '',
    preferredStartTime: base.preferredStartTime,
    normalizedPreferredTime: input.normalizedPreferredTime,
    normalizedPreferredCardioTime: input.normalizedPreferredCardioTime,
    normalizedPreferredStrengthTime: input.normalizedPreferredStrengthTime,
    busyWindows: input.busyWindows,
    scheduledWindows: args.scheduledWindows,
    title: base.title || 'Training session',
  });
  const preferredTimeShiftedBeforeFinalization = hasKernelShiftedPreferredTime(base, input);

  if (scheduledWindow.noAvailableSlot) {
    return {
      ...base,
      scheduleState: 'unscheduled',
      scheduleReason: joinScheduleReasons(
        base.scheduleReason,
        scheduledWindow.unavailableReason ?? 'No valid calendar slot remained for this session.',
      ),
      finalizedPreferredTimeUnavailable: true,
    };
  }

  return {
    ...base,
    scheduleState: activeScheduleStateFor(base),
    finalizedScheduledStart: scheduledWindow.start.toISOString(),
    finalizedScheduledEnd: scheduledWindow.end.toISOString(),
    finalizedPreferredTimeUnavailable: scheduledWindow.preferredTimeUnavailable || preferredTimeShiftedBeforeFinalization,
  };
}

function hasKernelShiftedPreferredTime(
  session: GeneratedTrainingSession,
  input: PersistGeneratedTrainingPlanInput,
): boolean {
  const explicit = typeof session.preferredStartTime === 'string' && /^\d{2}:\d{2}$/.test(session.preferredStartTime)
    ? session.preferredStartTime
    : null;
  if (!explicit) return false;
  const modalityPreferred = preferredTimeForSessionType(
    session.sessionType || '',
    input.normalizedPreferredTime,
    input.normalizedPreferredCardioTime,
    input.normalizedPreferredStrengthTime,
  );
  return explicit !== modalityPreferred;
}

function finalizedScheduleWindowForSession(session: GeneratedTrainingSession): {
  start: Date;
  end: Date;
  preferredTimeUnavailable: boolean;
} | null {
  const startMs = Date.parse(String(session.finalizedScheduledStart || ''));
  const endMs = Date.parse(String(session.finalizedScheduledEnd || ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    preferredTimeUnavailable: session.finalizedPreferredTimeUnavailable === true,
  };
}

function collectFinalizedCalendarEventsForLint(
  planData: GeneratedTrainingPlan,
): ReadonlyArray<{ sessionId: number; start: string; sessionIdentityKey: string }> {
  const events: Array<{ sessionId: number; start: string; sessionIdentityKey: string }> = [];
  for (const week of planData.weeks ?? []) {
    for (const session of week.sessions ?? []) {
      if (inactiveScheduleState(session) || isStandaloneRestOrMobilitySession(session)) continue;
      const state = activeScheduleStateFor(session);
      if (!ACTIVE_SCHEDULE_STATES.has(state)) continue;
      if (!session.finalizedScheduledStart) continue;
      events.push({
        sessionId: 0,
        start: session.finalizedScheduledStart,
        sessionIdentityKey: '',
      });
    }
  }
  return events;
}

function joinScheduleReasons(...reasons: Array<string | null | undefined>): string | undefined {
  const unique = Array.from(new Set(
    reasons
      .map((reason) => String(reason || '').trim())
      .filter(Boolean),
  ));
  return unique.length > 0 ? unique.join(' ') : undefined;
}

function appendSelectorSupportDebugTraces(
  preferencesJson: string,
  planData: GeneratedTrainingPlan,
  now: Date,
  userId?: number,
): string {
  const selectorTraces: Array<Record<string, unknown>> = [];
  for (const week of planData.weeks ?? []) {
    for (const session of week.sessions ?? []) {
      for (const exercise of session.exercises ?? []) {
        const trace = exercise?.selectorTrace;
        if (!trace || typeof trace !== 'object' || Array.isArray(trace)) continue;
        selectorTraces.push({
          weekNumber: week.weekNumber ?? null,
          dayOfWeek: session.dayOfWeek ?? null,
          sessionType: session.sessionType ?? null,
          sessionTitle: session.title ?? null,
          exerciseId: typeof exercise.exerciseId === 'string' ? exercise.exerciseId : null,
          selectorTrace: trace,
        });
      }
    }
  }
  if (selectorTraces.length === 0) return preferencesJson;

  try {
    const parsed = JSON.parse(preferencesJson) as unknown;
    const preferences = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    preferences.trainingSelectorSupportDebug = {
      presentationLevel: 'support_debug',
      schemaVersion: 1,
      capturedAt: now.toISOString(),
      traces: selectorTraces,
    };
    return JSON.stringify(preferences);
  } catch (err) {
    // F28 (Phase 3): support-debug traces are strictly additive. Replacing a
    // malformed payload with a traces-only object silently destroyed
    // requestedTargets, the spec, and the learning path — the original
    // string, however malformed, is the athlete's payload and survives.
    logger.warn(
      { err, userId },
      'appendSelectorSupportDebugTraces: malformed preferences payload; persisting it unchanged without traces',
    );
    return preferencesJson;
  }
}

function stripSupportDebugExerciseFields(
  exercises: Array<Record<string, any>>,
): Array<Record<string, any>> {
  return exercises.map((exercise) => {
    const { selectorTrace: _selectorTrace, ...userSafeExercise } = exercise;
    return userSafeExercise;
  });
}

function persistPlanValidationSummary(input: {
  planId: number;
  preferencesJson: string;
  lint: PlanLintResult;
  now: Date;
  strict?: boolean;
  /**
   * Phase 1B: initial plan-level calendar consistency state, written in the
   * same preferences pass as the lint summary so neither write clobbers the
   * other's field.
   */
  calendarSync?: TrainingPlanCalendarSyncSummary;
}): void {
  try {
    const parsed = JSON.parse(input.preferencesJson) as unknown;
    const preferences = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    preferences.finalValidationResult = {
      status: input.lint.status,
      blockerRuleIds: input.lint.blockers.map((finding) => finding.ruleId),
      warningRuleIds: input.lint.warnings.map((finding) => finding.ruleId),
      validatedAt: input.now.toISOString(),
    };
    if (input.calendarSync) {
      preferences.calendarSync = input.calendarSync;
    }
    trainingPlans.updatePlanPreferences(input.planId, JSON.stringify(preferences));
  } catch (err) {
    logger.warn(
      { err, planId: input.planId },
      'persistGeneratedTrainingPlan: failed to persist compact final validation summary',
    );
    // F6 stronger guarantee: compatibility replacement executes inside the
    // activation transaction. It may not commit without its validation and
    // calendar consistency state. Legacy standalone persistence preserves
    // the released fail-soft behavior for malformed caller-owned JSON.
    if (input.strict) throw err;
  }
}

function buildPlanLintWeeks(
  weeks: NonNullable<GeneratedTrainingPlan['weeks']>,
  calendarEvents: ReadonlyArray<{ sessionId: number; start: string; sessionIdentityKey: string }>,
): PlanLintWeek[] {
  let calendarEventCursor = 0;
  return weeks.map((weekData) => buildPlanLintWeek(weekData, () => {
    const event = calendarEvents[calendarEventCursor];
    calendarEventCursor += 1;
    return event?.start;
  }));
}

function buildPlanLintWeek(
  weekData: NonNullable<GeneratedTrainingPlan['weeks']>[number],
  nextActiveScheduledDate: () => string | undefined,
): PlanLintWeek {
  const sessions: PlanLintSession[] = [];
  for (const sessionData of weekData.sessions ?? []) {
    if (!inactiveScheduleState(sessionData) && isStandaloneRestOrMobilitySession(sessionData)) continue;
    const dayOfWeek = String(sessionData.dayOfWeek || '').toLowerCase();
    if (!dayOfWeek) continue;
    const sessionType = String(sessionData.sessionType || '').toLowerCase();
    const exerciseTokens = flattenTrainingExerciseTokens(sessionData.exercises);
    const status: PlanLintSession['status'] = (() => {
      // The persister has decided per session. We re-derive the status
      // family from the input rather than carrying it through the loop:
      //   • explicit inactiveScheduleState → pass-through.
      //   • activeScheduleStateFor → 'scheduled' / 'reflowed' / etc.
      //   • neither → 'pending' (our default; linter ignores).
      const inactive = inactiveScheduleState(sessionData);
      if (inactive) return inactive;
      const active = activeScheduleStateFor(sessionData);
      if (active) return active;
      return 'pending';
    })();
    const scheduledDate = status && ACTIVE_SCHEDULE_STATES.has(status as any)
      ? nextActiveScheduledDate()
      : undefined;
    sessions.push({
      // session id can't be looked up here without more wiring; use the
      // calendar-event sessionId when available so iOS can correlate
      // findings back to a row.
      id: undefined,
      sport: typeof sessionData.sport === 'string' ? sessionData.sport : undefined,
      dayOfWeek,
      sessionType,
      title: String(sessionData.title || 'Training session'),
      durationMinutes: typeof sessionData.durationMinutes === 'number'
        ? sessionData.durationMinutes
        : undefined,
      description: typeof sessionData.description === 'string'
        ? sessionData.description
        : undefined,
      status,
      // scheduledDate is best resolved from the calendarEvents list when
      // the persister produced an event, since that's the actual date
      // we wrote. For unscheduled rows, leave undefined; the linter's
      // past-day rule deliberately ignores non-active rows.
      scheduledDate,
      exerciseTokens,
      intensity: sessionIntensityText(sessionData),
      tags: Array.isArray(sessionData.tags)
        ? sessionData.tags.filter((tag): tag is string => typeof tag === 'string')
        : undefined,
      isLowerHeavy: inferTrainingSessionIsLowerHeavy(sessionData, exerciseTokens),
      isLongRun: inferTrainingSessionIsLongRun(sessionData),
      isKey: inferTrainingSessionIsLongRun(sessionData) || /\b(threshold|interval|race pace)\b/i.test(
        String(sessionData.title || ''),
      ),
    });
  }
  return {
    weekNumber: weekData.weekNumber || 1,
    focus: weekData.focus,
    intensityPct: weekData.intensityPct,
    sessions,
  };
}

function sessionIntensityText(sessionData: GeneratedTrainingSession): string | undefined {
  const parts: string[] = [];
  const summary = sessionData.intensitySummary;
  if (summary && typeof summary === 'object') {
    for (const value of Object.values(summary as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      if (typeof value === 'number' && Number.isFinite(value)) parts.push(String(value));
    }
  }
  const profile = sessionData.intensityProfile;
  if (profile && typeof profile === 'object') {
    for (const value of Object.values(profile)) {
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      if (typeof value === 'number' && Number.isFinite(value)) parts.push(String(value));
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function inferPoolAccessFromProfiles(profiles?: AthleteProfiles): boolean | null {
  const swimProfile = profileRecord(profiles?.swimProfile ?? profiles?.fitnessProfile?.swim ?? profiles?.fitnessProfile?.swimming);
  const text = [
    profiles?.fitnessProfile?.pool_access,
    profiles?.fitnessProfile?.has_pool,
    profiles?.fitnessProfile?.available_equipment,
    swimProfile?.pool_access,
    swimProfile?.open_water_access,
  ].filter((value) => value != null).join(' ').toLowerCase();
  if (!text.trim()) return null;
  if (/\b(no|none|without|unavailable|false)\b/.test(text)) return false;
  if (/\b(?:25m|50m)\s+(?:indoor|outdoor)\b/.test(text)) return true;
  if (/\b(pool|open water|open-water|access|yes|true|available)\b/.test(text)) return true;
  return null;
}

function inferCyclingBenchmarkFromProfiles(profiles?: AthleteProfiles): boolean | null {
  const values = [
    profiles?.cyclingProfile?.ftp_watts,
    profiles?.cyclingProfile?.cycling_ftp_watts,
    profiles?.cyclingProfile?.cycling_threshold_power,
    profiles?.runProfile?.ftp_watts,
    profiles?.runProfile?.cycling_ftp_watts,
    profiles?.fitnessProfile?.ftp_watts,
    profiles?.fitnessProfile?.cycling_ftp_watts,
    profiles?.fitnessProfile?.cycling_threshold_power,
    profiles?.fitnessProfile?.cycling_benchmark,
  ];
  if (values.some((value) => numericProfileValue(value) != null)) return true;
  const text = values.filter((value) => typeof value === 'string').join(' ').toLowerCase();
  if (/\b(no|unknown|unsure|none)\b/.test(text)) return false;
  return null;
}

function inferTriathlonModeFromInput(input: PersistGeneratedTrainingPlanInput): boolean | null {
  const text = [
    input.objective,
    input.planData.sport,
    input.athleteProfiles?.fitnessProfile?.target_race,
    input.athleteProfiles?.runProfile?.target_race,
    input.athleteProfiles?.cyclingProfile?.target_event,
    input.athleteProfiles?.swimProfile?.target_event,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(triathlon|triatlo|tríatlo|ironman|70\.3|olympic tri|sprint tri)\b/.test(text)) return true;
  return null;
}

function profileRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numericProfileValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function runPlanLintGuarded(args: {
  input: PersistGeneratedTrainingPlanInput;
  planId?: number;
  weeks: NonNullable<GeneratedTrainingPlan['weeks']>;
  calendarEvents: ReadonlyArray<{ sessionId: number; start: string; sessionIdentityKey: string }>;
  mode?: 'advisor' | 'strict_preflight';
}): PlanLintResult {
  try {
    const mode = args.mode ?? 'advisor';
    const lintInput: PlanLintInput = {
      now: args.input.now,
      timezone: args.input.schedulingTimezone,
      planId: args.planId,
      startDate: args.input.startDate,
      durationWeeks: args.input.durationWeeks,
      isRaceSpecific: args.input.isRaceSpecific,
      goalMode: args.input.goalMode,
      twoADayPreference: args.input.twoADayPreference ?? null,
      raceDate: args.input.raceDate ?? null,
      equipmentProfile: args.input.equipmentProfile,
      hasPoolAccess: args.input.hasPoolAccess ?? inferPoolAccessFromProfiles(args.input.athleteProfiles),
      cyclingBenchmarkAvailable: args.input.cyclingBenchmarkAvailable ?? inferCyclingBenchmarkFromProfiles(args.input.athleteProfiles),
      triathlonMode: args.input.triathlonMode ?? inferTriathlonModeFromInput(args.input),
      weeks: buildPlanLintWeeks(args.weeks, args.calendarEvents),
    };
    const lint = lintPlan(lintInput);
    // TR-EC-O13 follow-up (2026-05-12): the write-free app-facing route
    // now treats blockers as strict before any side effects. Persistence
    // still logs in advisor mode for residual schedule-date evidence.
    if (lint.status === 'fail') {
      logger.warn(
        {
          event: mode === 'strict_preflight'
            ? 'plan_linter.preflight_blocker_present'
            : 'plan_linter.blocker_present',
          userId: args.input.userId,
          planId: args.planId,
          mode,
          status: lint.status,
          blockerCount: lint.blockers.length,
          blockerRuleIds: lint.blockers.map((b) => b.ruleId),
          warningCount: lint.warnings.length,
          warningRuleIds: lint.warnings.map((w) => w.ruleId),
        },
        mode === 'strict_preflight'
          ? 'plan-linter: blocker(s) present before persistence; route must block writes'
          : 'plan-linter: blocker(s) present (advisor mode; surfaced on response)',
      );
    } else if (lint.blockers.length > 0 || lint.warnings.length > 0) {
      logger.warn(
        {
          event: mode === 'strict_preflight'
            ? 'plan_linter.preflight_findings'
            : 'plan_linter.findings',
          userId: args.input.userId,
          planId: args.planId,
          mode,
          status: lint.status,
          blockerRuleIds: lint.blockers.map((b) => b.ruleId),
          warningRuleIds: lint.warnings.map((w) => w.ruleId),
        },
        mode === 'strict_preflight'
          ? 'training-plan-generation: preflight plan-linter findings'
          : 'persistGeneratedTrainingPlan: plan-linter findings (advisor mode)',
      );
    }
    return lint;
  } catch (err) {
    const mode = args.mode ?? 'advisor';
    logger.warn(
      {
        event: 'plan_linter.threw',
        err,
        userId: args.input.userId,
        planId: args.planId,
        mode,
      },
      mode === 'strict_preflight'
        ? 'plan-linter threw during strict preflight; blocking persistence until the plan can be verified'
        : 'plan-linter threw during advisor pass; surfacing warning instead of hiding the failure',
    );
    const finding: PlanLintFinding = {
      ruleId: 'plan_linter_exception',
      severity: mode === 'strict_preflight' ? 'blocker' : 'warning',
      message: 'The training quality gate could not verify this plan. Try again before saving it.',
      affectedSessions: [],
      evidence: {
        errorClass: err instanceof Error ? err.name : typeof err,
      },
    };
    return mode === 'strict_preflight'
      ? {
          status: 'fail',
          blockers: [finding],
          warnings: [],
          suggestedFixes: [{
            findingRuleId: 'plan_linter_exception',
            action: 'Regenerate the plan after the linter failure is resolved.',
          }],
        }
      : {
          status: 'pass_with_warnings',
          blockers: [],
          warnings: [finding],
          suggestedFixes: [{
            findingRuleId: 'plan_linter_exception',
            action: 'Review the plan manually because the advisor linter could not complete.',
          }],
        };
  }
}



function effectiveTrainingCalendarWriteSource(
  input: PersistGeneratedTrainingPlanInput,
): CalendarSource | undefined | null {
  const provider = input.trainingPlanSpec?.calendarPreference.provider;
  if (provider === 'google' || provider === 'outlook') return provider;
  if (provider === 'none' || provider === 'apple') return null;
  return input.calendarSource;
}






function inactiveScheduleState(session: GeneratedTrainingSession): PersistableSessionScheduleState | null {
  const scheduleState = normalizedScheduleState(session);
  if (scheduleState && INACTIVE_SCHEDULE_STATES.has(scheduleState)) {
    return scheduleState;
  }
  return null;
}

function activeScheduleStateFor(session: GeneratedTrainingSession): PersistableSessionScheduleState {
  const scheduleState = normalizedScheduleState(session);
  if (scheduleState && ACTIVE_SCHEDULE_STATES.has(scheduleState)) return scheduleState;
  return 'scheduled';
}

function normalizedScheduleState(session: GeneratedTrainingSession): PersistableSessionScheduleState | null {
  const direct = normalizeScheduleStateValue(session.scheduleState);
  if (direct) return direct;
  if (Array.isArray(session.scheduleAdjustments)) {
    const normalizedAdjustments = session.scheduleAdjustments
      .map((value) => normalizeScheduleStateValue(value))
      .filter((value): value is PersistableSessionScheduleState => Boolean(value));
    if (normalizedAdjustments.includes('reflowed')) return 'reflowed';
    if (normalizedAdjustments.includes('compressed')) return 'compressed';
    if (normalizedAdjustments.includes('capped')) return 'capped';
    if (normalizedAdjustments.includes('scheduled')) return 'scheduled';
    if (normalizedAdjustments.includes('unscheduled')) return 'unscheduled';
    if (normalizedAdjustments.includes('deferred')) return 'deferred';
    if (normalizedAdjustments.includes('dropped')) return 'dropped';
  }
  return null;
}

function normalizeScheduleStateValue(value: unknown): PersistableSessionScheduleState | null {
  const normalized = String(value || '').trim().toLowerCase();
  switch (normalized) {
    case 'pending':
    case 'scheduled':
    case 'reflowed':
    case 'compressed':
    case 'capped':
    case 'unscheduled':
    case 'deferred':
    case 'dropped':
      return normalized;
    default:
      return null;
  }
}

function isCalendarSchedulableTrainingSession(session: GeneratedTrainingSession): boolean {
  if (inactiveScheduleState(session)) return false;
  return !isStandaloneRestOrMobilitySession(session);
}

function isStandaloneRestOrMobilitySession(session: GeneratedTrainingSession): boolean {
  const type = String(session.sessionType || '').trim().toLowerCase();
  if (type === 'rest' || type === 'mobility') return true;
  const combined = `${type} ${session.title || ''}`.toLowerCase();
  const exerciseCount = Array.isArray(session.exercises) ? session.exercises.length : 0;
  return combined.includes('mobility') && exerciseCount === 0;
}

function appendScheduleReason(description: string, reason: string | null | undefined): string {
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) return description;
  return `${description}\n\nSCHEDULE:\n${trimmedReason}`.trim();
}

/**
 * Computes the calendar date for a (weekNumber, dayIndex) slot relative
 * to the resolved plan start date and decides whether the slot is legal
 * (i.e. not in the past for week 1).
 *
 * Week 1 is anchored at the actual persisted start date, not at the
 * request timestamp. If the user explicitly picks "start today", that
 * start date may be mid-week and earlier days in week 1 are rejected
 * honestly. If the default `next_full_week` resolves to a future Monday,
 * Monday-Thursday must remain usable even when the plan is generated on
 * a Friday. This was the root cause of the "one current-week session +
 * one next-week session, then full weeks later" regression.
 * The historical bug: the legacy code added +7 days when `daysUntil`
 * went negative, which produced a forward-looking date but landed
 * "Week 1 Monday" on the SAME calendar day as "Week 2 Monday" — users
 * lost Mon/Tue of week 1 silently and a generated plan that claimed
 * "starts today" actually started two days in the future.
 *
 * For weekNumber >= 2 the additive offset is correct: each subsequent
 * week is 7 days after the prior, so the rolling weekStart anchor is
 * always at least 7 days in the future — there is no past-day risk
 * downstream.
 *
 * Returns either:
 *   { kind: 'usable', sessionDate }  → call scheduleSessionWindow
 *   { kind: 'past_day_in_week_1', dayName, generatedOn } → caller marks
 *     as `unscheduled` with a clear reason.
 */
type PlanSlotResolution =
  | { kind: 'usable'; sessionDate: Date }
  | {
      kind: 'past_day_in_week_1';
      dayName: string;
      generatedOnDayName: string;
    };

export function resolvePlanSlotDate(input: {
  weekNumber: number;
  dayIndex: number; // 0=Mon, 1=Tue, ..., 6=Sun (matches DAY_NAMES at top of file)
  planStartDate?: string;
  now: Date;
  schedulingTimezone?: string | null;
}): PlanSlotResolution {
  const timezone = resolveTrainingTimezone(input.schedulingTimezone);
  const today = DateTime.fromJSDate(input.now, { zone: timezone }).startOf('day');
  const anchor = parsePlanStartDate(input.planStartDate, input.now, timezone)
    .plus({ weeks: input.weekNumber - 1 });

  const anchorDayIndex = anchor.weekday - 1; // Luxon: Mon=1 ... Sun=7.
  const anchorIsSunday = anchorDayIndex === 6;
  let daysUntil = input.dayIndex - anchorDayIndex;
  if (anchorIsSunday && input.weekNumber === 1) {
    daysUntil = input.dayIndex === 6 ? 0 : input.dayIndex + 1;
  } else if (daysUntil < 0) {
    if (input.weekNumber === 1) {
      const pastDate = anchor.plus({ days: daysUntil });
      return {
        kind: 'past_day_in_week_1',
        dayName: pastDate.setLocale('en-US').toFormat('cccc'),
        generatedOnDayName: today.setLocale('en-US').toFormat('cccc'),
      };
    }
    daysUntil += 7;
  }

  const sessionDate = anchor.plus({ days: daysUntil }).startOf('day');

  // PAST-DAY FLOOR: only relevant for week 1.
  //
  // For week 1 (weekStart === now's calendar week), targetDate < today means
  // the user is generating a plan AFTER the named day already passed
  // (e.g. now=Wed, target=Mon). The legacy code
  // added +7 here; we now mark this as a past-day rejection so the
  // session is persisted with status='unscheduled' and surfaced honestly
  // to iOS instead of silently sliding to next week's Monday.
  if (input.weekNumber === 1 && sessionDate < today) {
    return {
      kind: 'past_day_in_week_1',
      dayName: sessionDate.setLocale('en-US').toFormat('cccc'),
      generatedOnDayName: today.setLocale('en-US').toFormat('cccc'),
    };
  }

  return { kind: 'usable', sessionDate: sessionDate.toUTC().toJSDate() };
}

function scheduleSessionForPlan(input: {
  weekNumber: number;
  dayIndex: number;
  planStartDate: string;
  now: Date;
  schedulingTimezone?: string | null;
  durationMinutes: number;
  sessionType: string;
  preferredStartTime: unknown;
  normalizedPreferredTime: string;
  normalizedPreferredCardioTime: string;
  normalizedPreferredStrengthTime: string;
  busyWindows: BusyWindow[];
  scheduledWindows: BusyWindow[];
  title: string;
}): ScheduleSessionResult {
  const slot = resolvePlanSlotDate({
    weekNumber: input.weekNumber,
    dayIndex: input.dayIndex,
    planStartDate: input.planStartDate,
    now: input.now,
    schedulingTimezone: input.schedulingTimezone,
  });

  if (slot.kind === 'past_day_in_week_1') {
    // Reuse the `noAvailableSlot` plumbing that already drives the
    // `status: 'unscheduled'` persistence path. The reason string is
    // intentionally human-readable — it surfaces in the session
    // description and helps iOS render an honest "Mon/Tue skipped
    // because plan was created on Wednesday" explanation.
    const fallback = new Date(input.now);
    return {
      start: fallback,
      end: new Date(fallback.getTime() + input.durationMinutes * 60 * 1000),
      preferredTimeUnavailable: true,
      noAvailableSlot: true,
      unavailableReason:
        `${slot.dayName} of week 1 has already passed this calendar week ` +
        `(plan created on ${slot.generatedOnDayName}). Look for the equivalent ` +
        `session in week 2 or adjust your start day.`,
    };
  }

  const sessionDate = slot.sessionDate;

  const resolvedPreferredTime = typeof input.preferredStartTime === 'string' && /^\d{2}:\d{2}$/.test(input.preferredStartTime)
    ? input.preferredStartTime
    : preferredTimeForSessionType(
      input.sessionType,
      input.normalizedPreferredTime,
      input.normalizedPreferredCardioTime,
      input.normalizedPreferredStrengthTime,
    );

  const scheduledWindow = scheduleSessionWindow(
    sessionDate,
    input.durationMinutes,
    resolvedPreferredTime,
    input.busyWindows,
    input.scheduledWindows,
    { notBefore: input.now, timezone: input.schedulingTimezone },
  );

  // Don't pollute the busy-window guard with a past-day fallback marker
  // (start time = `now`); only push the window when the slot is real.
  if (!scheduledWindow.noAvailableSlot) {
    input.scheduledWindows.push({
      startMs: scheduledWindow.start.getTime(),
      endMs: scheduledWindow.end.getTime(),
      title: input.title,
    });
  }

  return scheduledWindow;
}

function parsePlanStartDate(
  raw: string | undefined,
  fallback: Date,
  timezone: string,
): DateTime {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = DateTime.fromISO(raw, { zone: timezone }).startOf('day');
    if (parsed.isValid) return parsed;
  }
  return DateTime.fromJSDate(fallback, { zone: timezone }).startOf('day');
}

/**
 * Adapts the persister's loop-local context (plan + week + session
 * input) into the `SessionDescriptionInput` shape consumed by
 * `buildRichSessionDescription`. Kept inline so the loop body stays
 * readable and the description module has no knowledge of how the
 * persister's plan-generation pipeline shapes its data.
 */
function buildSessionDescriptionInput(args: {
  input: PersistGeneratedTrainingPlanInput;
  weekData: NonNullable<GeneratedTrainingPlan['weeks']>[number];
  sessionData: GeneratedTrainingSession;
  durationMinutes: number;
}): SessionDescriptionInput {
  const { input, weekData, sessionData, durationMinutes } = args;
  const allWeeks = (input.planData.weeks ?? []).map((week) => ({
    weekNumber: typeof week.weekNumber === 'number' ? week.weekNumber : 0,
    focus: week.focus,
    intensityPct: week.intensityPct,
    sessions: (week.sessions ?? []).map((s) => ({
      sessionType: s.sessionType,
      title: s.title,
      durationMinutes: s.durationMinutes,
      dayOfWeek: s.dayOfWeek,
    })),
  }));

  return {
    planName: input.planData.planName || `${input.objective} Plan`,
    objective: input.objective,
    totalWeeks: input.durationWeeks,
    startDate: input.startDate,
    sport: input.planData.sport || 'hybrid',
    periodization: input.planData.periodization,
    weekNumber: weekData.weekNumber || 1,
    weekFocus: weekData.focus,
    weekIntensityPct: weekData.intensityPct,
    allWeeks,
    session: {
      sessionType: sessionData.sessionType || 'training',
      title: sessionData.title || 'Training session',
      durationMinutes,
      description: sessionData.description,
      exercises: sessionData.exercises,
      dayOfWeek: sessionData.dayOfWeek || 'Monday',
      sessionRole: sessionData.sessionRole,
      sessionRoleLabel: sessionData.sessionRoleLabel,
      sessionRoleSummary: sessionData.sessionRoleSummary,
      keySessionLabel: sessionData.keySessionLabel,
      splitCode: sessionData.splitCode,
      splitSlot: sessionData.splitSlot,
      focus: sessionData.focus,
      primaryMuscles: sessionData.primaryMuscles,
      secondaryMuscles: sessionData.secondaryMuscles,
      movementPatterns: sessionData.movementPatterns,
      sections: sessionData.sections,
      intensitySummary: sessionData.intensitySummary,
      decisionReasons: sessionData.decisionReasons,
    },
    profiles: input.athleteProfiles,
    exerciseIdentityMode: getTrainingExerciseIdentityV1Mode(process.env, {
      userId: input.userId,
      tenantId: input.tenantId,
    }),
  };
}
