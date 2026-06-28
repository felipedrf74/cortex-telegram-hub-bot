// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as trainingPlans from '../../services/training-plans';
import {
  buildRichSessionDescription,
  type AthleteProfiles,
  type SessionDescriptionInput,
} from '../../services/training-session-description';
import {
  findExistingOwnership,
  getPlanVersion,
  recordCalendarOwnership,
} from '../../services/training-plan-lifecycle';
import {
  markSecretaryAgendaProviderCleanupRequired,
  markSecretaryAgendaProviderSyncSatisfied,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySchedulingIntent,
} from '../../services/secretary-scheduling-arbitrator';
import { loadLiveCalendarBusyWindowsForSecretaryIntent } from '../../services/secretary-live-calendar-busy';
import {
  appendTrainingIdentityMarker,
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
import { withTrainingCalendarOperationLock } from '../../services/training-operation-locks';
import { requireTenantIdParam } from '../../services/tenant-scope';
import {
  preferredTimeForSessionType,
  scheduleSessionWindow,
  type BusyWindow,
  type ScheduleSessionResult,
} from './training-schedule-utils';
import { createTrainingCalendarEvent } from './training-calendar-event-writer';
import { deleteEvent, type CalendarSource } from '../../services/unified-calendar';
import {
  flattenTrainingExerciseTokens,
  inferTrainingSessionIsLongRun,
  inferTrainingSessionIsLowerHeavy,
} from '../../services/training-session-classification';
import { incrementTrainingGenerationCounter } from '../../services/training-generation-observability';

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

type GeneratedTrainingPlan = {
  planName?: string;
  sport?: string;
  periodization?: string;
  weeks?: Array<{
    weekNumber?: number;
    focus?: string;
    intensityPct?: number;
    sessions?: Array<GeneratedTrainingSession>;
  }>;
};

type GeneratedTrainingSession = {
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

export interface PersistGeneratedTrainingPlanInput {
  userId: number;
  tenantId: number;
  objective: string;
  durationWeeks: number;
  startDate: string;
  endDate: string;
  now: Date;
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
  /** Deterministic training generation contract used by the strict quality gate. */
  trainingPlanSpec?: TrainingPlanSpec;
}

export interface PersistGeneratedTrainingPlanResult {
  planId: number;
  totalSessions: number;
  eventsCreated: number;
  sessionsLinked: number;
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
  if (isPlanScheduleFinalized(input.planData)) return input;

  const scheduledWindows: BusyWindow[] = [];
  const planData: GeneratedTrainingPlan = {
    ...input.planData,
    weeks: (input.planData.weeks ?? []).map((weekData) => ({
      ...weekData,
      sessions: (weekData.sessions ?? []).map((sessionData) => finalizeGeneratedTrainingSessionSchedule({
        input,
        weekData,
        sessionData,
        scheduledWindows,
      })),
    })),
  };
  return { ...input, planData };
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
    () => persistGeneratedTrainingPlanLocked(finalizedInput),
  );
}

async function persistGeneratedTrainingPlanLocked(
  input: PersistGeneratedTrainingPlanInput,
): Promise<PersistGeneratedTrainingPlanResult> {
  const tenantId = requireTenantIdParam(input.tenantId, 'persistGeneratedTrainingPlanLocked');
  const preferencesJson = appendSelectorSupportDebugTraces(input.preferencesJson, input.planData, input.now);
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
  });

  let totalSessions = 0;
  const calendarEvents: Array<{
    sessionId: number;
    sessionIdentityKey: string;
    sessionShapeHash: string;
    title: string;
    start: string;
    end: string;
    description: string;
  }> = [];
  for (const weekData of input.planData.weeks || []) {
    const sessionOrdinals = new Map<string, number>();
    const week = trainingPlans.createWeek({
      plan_id: plan.id,
      week_number: weekData.weekNumber || 1,
      focus: weekData.focus || 'base',
      intensity_pct: weekData.intensityPct || 70,
      volume_sessions: weekData.sessions?.filter(isCalendarSchedulableTrainingSession).length || 0,
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
      });

      calendarEvents.push({
        sessionId: session.id,
        sessionIdentityKey,
        sessionShapeHash,
        title: `${emojiForTrainingSession(sessionData.sessionType)} ${sessionData.title || 'Training session'} (${durationMinutes}min)`,
        start: finalizedWindow.start.toISOString(),
        end: finalizedWindow.end.toISOString(),
        description: appendTrainingIdentityMarker(activeDescription, {
          planId: plan.id,
          planVersion: getPlanVersion(plan.id) ?? 1,
          sessionId: session.id,
          sessionIdentityKey,
          sessionShapeHash,
        }),
      });

      totalSessions++;
    }
  }

  // Slice 4.D — idempotent calendar create. Capture the plan_version
  // once at the top of the loop; any retry of this persistence pass
  // (e.g. a network blip + client retry) will see the same version
  // and the (plan_id, plan_version, session_id) ownership row, so
  // we can skip event re-creation cleanly. The DB-level unique index
  // on (plan_id, plan_version, event_id, source) is the safety
  // backstop for concurrent races we can't detect at the app layer.
  const planVersionForOwnership = getPlanVersion(plan.id) ?? 1;
  const calendarWriteSource = effectiveTrainingCalendarWriteSource(input);
  let eventsCreated = 0;
  let eventsAlreadyOwned = 0;
  const createCalendarEventWithOwnership = async (
    eventPayload: (typeof calendarEvents)[number],
  ): Promise<'created' | 'already_owned' | 'skipped' | 'failed'> => {
    if (calendarWriteSource === null) {
      return 'skipped';
    }
    const existing = findExistingOwnership({
      planId: plan.id,
      planVersion: planVersionForOwnership,
      sessionId: eventPayload.sessionId,
      tenantId,
      userId: input.userId,
    });
    if (existing) {
      // A previous run of this loop already created + recorded the
      // event for this session. Skip to avoid duplicate calendar
      // entries on retry. The session row was already linked then.
      return 'already_owned';
    }
    let secretaryDecision: SecretarySchedulingDecision | null = null;
    try {
      const secretaryIntent = buildTrainingSecretaryIntent({
        userId: input.userId,
        tenantId,
        planId: plan.id,
        planVersion: planVersionForOwnership,
        eventPayload,
      });
      const liveBusyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(secretaryIntent);
      if (liveBusyWindows.degraded) {
        throw new Error('TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED');
      }
      secretaryDecision = submitSecretarySchedulingIntent(
        secretaryIntent,
        {
          now: input.now.toISOString(),
          additionalBusyWindows: liveBusyWindows.windows,
        },
      );
      const selectedWindow = selectedTrainingSecretaryWindow(secretaryDecision, { notBefore: input.now });
      if (!selectedWindow) {
        logger.warn(
          {
            userId: input.userId,
            planId: plan.id,
            planVersion: planVersionForOwnership,
            sessionId: eventPayload.sessionId,
            secretaryStatus: secretaryDecision.status,
            reasonCodes: secretaryDecision.reasonCodes,
        },
        'Secretary did not return a schedulable Training slot; skipping calendar event create',
      );
        return 'skipped';
      }
      const event = await withTrainingCalendarSyncTimeout(
        createTrainingCalendarEvent(
          {
            title: eventPayload.title,
            start: selectedWindow.start,
            end: selectedWindow.end,
            description: eventPayload.description,
          },
          calendarWriteSource,
          input.userId,
          {
            userId: input.userId,
            tenantId,
            sessionId: eventPayload.sessionId,
            title: eventPayload.title,
          },
        ),
        'provider_event_create',
      );
      trainingPlans.linkSessionToCalendar(eventPayload.sessionId, event.id, event.source);
      // Record ownership AFTER the session linkage write so we never
      // record an audit row for an event whose local linkage failed.
      // The recorder is idempotent; concurrent races degrade to a
      // safe no-op.
      const ownership = recordCalendarOwnership({
        planId: plan.id,
        planVersion: planVersionForOwnership,
        sessionId: eventPayload.sessionId,
        tenantId,
        userId: input.userId,
        eventId: event.id,
        source: event.source,
        calendarId: input.trainingPlanSpec?.calendarPreference.calendarId ?? null,
        sessionIdentityKey: eventPayload.sessionIdentityKey,
        sessionShapeHash: eventPayload.sessionShapeHash,
      });
      if (!ownership.ok) {
        trainingPlans.updateSession(eventPayload.sessionId, {
          status: 'unscheduled',
          calendar_event_id: null,
          calendar_source: null,
        });
        const providerDeleteSucceeded = await deleteCreatedTrainingProviderEventAfterOwnershipFailure({
          eventId: event.id,
          source: event.source,
          userId: input.userId,
        });
        markSecretaryAgendaProviderCleanupRequired({
          agendaItemId: secretaryDecision.agendaItem.agendaItemId,
          ownerUserId: input.userId,
          tenantId,
          providerEventId: providerDeleteSucceeded ? null : event.id,
          providerSource: providerDeleteSucceeded ? null : event.source,
          providerSyncState: providerDeleteSucceeded ? 'deleted' : 'delete_failed',
          lifecycleState: 'unscheduled',
          reason: 'training_provider_ownership_record_failed',
          clearProviderMapping: providerDeleteSucceeded,
          now: input.now.toISOString(),
        });
        logger.warn(
          {
            userId: input.userId,
            planId: plan.id,
            planVersion: planVersionForOwnership,
            sessionId: eventPayload.sessionId,
            providerEventId: event.id,
            providerSource: event.source,
          },
          'Failed to record Training calendar ownership after provider create; session marked unscheduled',
        );
        return 'failed';
      }
      markSecretaryAgendaProviderSyncSatisfied({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: input.userId,
        tenantId,
        providerEventId: event.id,
        providerSource: event.source,
        now: input.now.toISOString(),
      });
      return 'created';
    } catch (err) {
      if (secretaryDecision?.agendaItem?.agendaItemId) {
        markSecretaryAgendaProviderCleanupRequired({
          agendaItemId: secretaryDecision.agendaItem.agendaItemId,
          ownerUserId: input.userId,
          tenantId,
          providerSyncState: 'create_failed',
          lifecycleState: 'unscheduled',
          reason: 'training_provider_event_create_failed',
          clearProviderMapping: true,
          now: input.now.toISOString(),
        });
      }
      trainingPlans.updateSession(eventPayload.sessionId, {
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
      logger.warn(
        {
          err,
          userId: input.userId,
          planId: plan.id,
          planVersion: planVersionForOwnership,
          sessionId: eventPayload.sessionId,
        },
        'Failed to create calendar event for session',
      );
      return 'failed';
    }
  };

  const calendarEventBatches = chunkArray(calendarEvents, trainingCalendarCreateBatchSize());
  for (const batch of calendarEventBatches) {
    const settled = await Promise.allSettled(batch.map(createCalendarEventWithOwnership));
    for (const result of settled) {
      if (result.status === 'rejected') {
        logger.warn(
          {
            err: result.reason,
            userId: input.userId,
            planId: plan.id,
            planVersion: planVersionForOwnership,
          },
          'Unexpected failure while batching training calendar event creation',
        );
        continue;
      }
      if (result.value === 'created') eventsCreated++;
      if (result.value === 'already_owned') eventsAlreadyOwned++;
    }
  }
  if (eventsAlreadyOwned > 0) {
    logger.info(
      {
        planId: plan.id,
        planVersion: planVersionForOwnership,
        eventsCreated,
        eventsAlreadyOwned,
      },
      'persistGeneratedTrainingPlan: idempotent retry — some events already owned',
    );
  }

  // training-expert-coach-knowledge-engine (2026-06-09):
  // Plan-level deterministic lint. The app-facing generation route now
  // finalizes deterministic session placement before the strict,
  // write-free preflight. This post-persist pass remains defense-in-depth
  // and should match the preflight shape unless an external calendar write
  // fails or provider/Secretary availability changes after persistence.
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
  persistPlanValidationSummary({
    planId: plan.id,
    preferencesJson,
    lint,
    now: input.now,
  });

  return {
    planId: plan.id,
    totalSessions,
    eventsCreated,
    sessionsLinked: eventsCreated + eventsAlreadyOwned,
    weekSummaries: (input.planData.weeks || []).map((weekData) => ({
      weekNumber: weekData.weekNumber,
      focus: weekData.focus,
      sessionCount: weekData.sessions?.filter(isCalendarSchedulableTrainingSession).length || 0,
    })),
    lint,
  };
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
  } catch {
    return JSON.stringify({
      trainingSelectorSupportDebug: {
        presentationLevel: 'support_debug',
        schemaVersion: 1,
        capturedAt: now.toISOString(),
        traces: selectorTraces,
      },
    });
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
    trainingPlans.updatePlanPreferences(input.planId, JSON.stringify(preferences));
  } catch (err) {
    logger.warn(
      { err, planId: input.planId },
      'persistGeneratedTrainingPlan: failed to persist compact final validation summary',
    );
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
      planId: args.planId,
      startDate: args.input.startDate,
      durationWeeks: args.input.durationWeeks,
      isRaceSpecific: args.input.isRaceSpecific,
      goalMode: args.input.goalMode,
      raceDate: args.input.raceDate ?? null,
      equipmentProfile: args.input.equipmentProfile,
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

function buildTrainingSecretaryIntent(input: {
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  eventPayload: {
    sessionId: number;
    title: string;
    start: string;
    end: string;
    sessionIdentityKey: string;
    sessionShapeHash: string;
  };
}): SecretarySchedulingIntent {
  const durationMinutes = Math.max(1, Math.round((Date.parse(input.eventPayload.end) - Date.parse(input.eventPayload.start)) / 60_000));
  return {
    intentId: `training:${input.planId}:${input.planVersion}:${input.eventPayload.sessionId}`,
    sourceSkill: 'training',
    sourceAction: 'schedule_training_session',
    sourceEntityId: input.eventPayload.sessionId,
    sourceEntityType: 'training_session',
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    title: input.eventPayload.title,
    requestedDurationMinutes: durationMinutes,
    minimumDurationMinutes: Math.min(durationMinutes, Math.max(20, Math.round(durationMinutes * 0.75))),
    preferredWindows: [{
      start: input.eventPayload.start,
      end: input.eventPayload.end,
      label: 'training plan slot',
      hard: true,
    }],
    priority: 'high',
    flexibility: 'fixed',
    reason: 'Training generated a scheduleable workout session.',
    context: `plan_id=${input.planId}; plan_version=${input.planVersion}; session_identity_key=${input.eventPayload.sessionIdentityKey}; session_shape_hash=${input.eventPayload.sessionShapeHash}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function selectedTrainingSecretaryWindow(
  decision: SecretarySchedulingDecision,
  options: { notBefore?: Date } = {},
): { start: string; end: string } | null {
  if (!['scheduled', 'reflowed', 'compressed'].includes(decision.status)) return null;
  if (!decision.selectedSlot?.start || !decision.selectedSlot?.end) return null;
  const start = Date.parse(decision.selectedSlot.start);
  const end = Date.parse(decision.selectedSlot.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (options.notBefore && start < options.notBefore.getTime()) return null;
  return { start: decision.selectedSlot.start, end: decision.selectedSlot.end };
}

function effectiveTrainingCalendarWriteSource(
  input: PersistGeneratedTrainingPlanInput,
): CalendarSource | undefined | null {
  const provider = input.trainingPlanSpec?.calendarPreference.provider;
  if (provider === 'google' || provider === 'outlook') return provider;
  if (provider === 'none' || provider === 'apple') return null;
  return input.calendarSource;
}

async function deleteCreatedTrainingProviderEventAfterOwnershipFailure(input: {
  eventId: string;
  source: CalendarSource;
  userId: number;
}): Promise<boolean> {
  try {
    await withTrainingCalendarSyncTimeout(
      deleteEvent(input.eventId, input.source, input.userId),
      'provider_event_delete_after_ownership_failure',
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        err,
        userId: input.userId,
        providerEventId: input.eventId,
        providerSource: input.source,
      },
      'Failed to delete Training calendar event after ownership failure; agenda cleanup will retry provider deletion',
    );
    return false;
  }
}

export function trainingCalendarCreateBatchSize(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRAINING_CALENDAR_CREATE_BATCH_SIZE;
  if (raw == null || raw.trim() === '') return 5;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(5, Math.max(1, parsed));
}

function trainingCalendarSyncTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRAINING_CALENDAR_SYNC_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') return 15_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 15_000;
  return Math.min(30_000, Math.max(3_000, parsed));
}

async function withTrainingCalendarSyncTimeout<T>(
  promise: Promise<T>,
  operation: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`TRAINING_CALENDAR_SYNC_TIMEOUT:${operation}`));
    }, trainingCalendarSyncTimeoutMs());
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
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

const DAY_NAMES_SUN_FIRST = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function resolvePlanSlotDate(input: {
  weekNumber: number;
  dayIndex: number; // 0=Mon, 1=Tue, ..., 6=Sun (matches DAY_NAMES at top of file)
  planStartDate?: string;
  now: Date;
}): PlanSlotResolution {
  const anchor = parsePlanStartDate(input.planStartDate, input.now);
  anchor.setDate(anchor.getDate() + ((input.weekNumber - 1) * 7));

  const anchorDayIndex = (anchor.getDay() + 6) % 7; // Mon=0, ..., Sun=6.
  const anchorIsSunday = anchorDayIndex === 6;
  let daysUntil = input.dayIndex - anchorDayIndex;
  if (anchorIsSunday && input.weekNumber === 1) {
    daysUntil = input.dayIndex === 6 ? 0 : input.dayIndex + 1;
  } else if (daysUntil < 0) {
    if (input.weekNumber === 1) {
      const pastDate = new Date(anchor);
      pastDate.setDate(pastDate.getDate() + daysUntil);
      return {
        kind: 'past_day_in_week_1',
        dayName: DAY_NAMES_SUN_FIRST[pastDate.getDay()],
        generatedOnDayName: DAY_NAMES_SUN_FIRST[input.now.getDay()],
      };
    }
    daysUntil += 7;
  }

  const sessionDate = new Date(anchor);
  sessionDate.setDate(sessionDate.getDate() + daysUntil);

  // PAST-DAY FLOOR: only relevant for week 1.
  //
  // For week 1 (weekStart === now's calendar week), targetDate < today means
  // the user is generating a plan AFTER the named day already passed
  // (e.g. now=Wed, target=Mon). The legacy code
  // added +7 here; we now mark this as a past-day rejection so the
  // session is persisted with status='unscheduled' and surfaced honestly
  // to iOS instead of silently sliding to next week's Monday.
  const sessionDayStart = startOfLocalDay(sessionDate);
  const todayStart = startOfLocalDay(input.now);
  if (input.weekNumber === 1 && sessionDayStart.getTime() < todayStart.getTime()) {
    return {
      kind: 'past_day_in_week_1',
      dayName: DAY_NAMES_SUN_FIRST[sessionDate.getDay()],
      generatedOnDayName: DAY_NAMES_SUN_FIRST[input.now.getDay()],
    };
  }

  return { kind: 'usable', sessionDate };
}

function scheduleSessionForPlan(input: {
  weekNumber: number;
  dayIndex: number;
  planStartDate: string;
  now: Date;
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
    { notBefore: input.now },
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

function parsePlanStartDate(raw: string | undefined, fallback: Date): Date {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
      // Use local midday for date-only anchors. Midnight crosses back to
      // the prior UTC date in Europe/Lisbon during DST, which makes
      // date-only tests and provider payloads unnecessarily brittle while
      // preserving the intended local calendar day for downstream setHours().
      return new Date(year, month - 1, day, 12, 0, 0, 0);
    }
  }
  return new Date(fallback);
}

function startOfLocalDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
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
  };
}

function emojiForTrainingSession(sessionType: unknown): string {
  switch (sessionType) {
    case 'gym':
      return '💪';
    case 'run':
      return '🏃';
    case 'ride':
      return '🚴';
    case 'swim':
      return '🏊';
    default:
      return '🏋️';
  }
}
