// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { loadCoachKnowledge } from './knowledge-loader';
import { trimOverstuffedStrengthSessionToDuration } from './session-coherence';
import type {
  AthleteState,
  AvailabilityWindow,
  DayOfWeek,
  GuardrailResult,
  Session,
  SessionScheduleState,
  TrainingDecisionReason,
} from './types';
import { dayIndex, durationToLoad, resolvePreferredStartTime, timeToMinutes, withDuration } from './utils';

interface CapacitySlot {
  id: string;
  window: AvailabilityWindow;
  capacityMinutes: number;
  usedMinutes: number;
}

export interface WeeklyCapacityReconciliation {
  sessions: Session[];
  guardrailResults: GuardrailResult[];
  decisionReasons: TrainingDecisionReason[];
}

const INACTIVE_SCHEDULE_STATES = new Set<SessionScheduleState>(['deferred', 'unscheduled', 'dropped']);
const HIGH_FATIGUE = new Set<Session['fatigueCost']>(['high', 'very_high']);

export function isActiveTrainingSession(session: Session): boolean {
  return session.sessionType !== 'rest' && !INACTIVE_SCHEDULE_STATES.has(session.scheduleState as SessionScheduleState);
}

export function reconcileWeeklyCapacity(
  athlete: AthleteState,
  sessions: Session[],
): WeeklyCapacityReconciliation {
  const slots = buildCapacitySlots(athlete);
  const scheduledByDay: Partial<Record<DayOfWeek, number>> = {};
  const scheduledHighFatigueDays = new Set<DayOfWeek>();
  const results: GuardrailResult[] = [];
  const decisionReasons: TrainingDecisionReason[] = [];
  const originalIndex = new Map(sessions.map((session, index) => [session.id, index]));
  const byPriority = sessions
    .map((session, index) => ({ session, index, priority: sessionPriority(athlete, session) }))
    .sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.index - right.index;
    });

  const reconciledById = new Map<string, Session>();
  for (const { session } of byPriority) {
    if (session.sessionType === 'rest') {
      reconciledById.set(session.id, clearScheduleForInactiveSession(session, 'Rest day does not need an agenda slot.', 'deferred'));
      continue;
    }

    const slot = chooseSlot({
      athlete,
      session,
      slots,
      scheduledByDay,
      scheduledHighFatigueDays,
    });

    if (!slot) {
      const reason = buildUnscheduledDecisionReason(
        athlete,
        session,
        slots.length === 0
          ? 'Marked unscheduled because no feasible training windows exist this week.'
          : 'Marked unscheduled because no feasible slot remained after preserving higher-priority sessions.',
      );
      const unscheduled = markSessionUnscheduled(session, reason.text, reason);
      decisionReasons.push(reason);
      reconciledById.set(session.id, unscheduled);
      results.push({
        ruleId: `capacity_unscheduled_${session.id}`,
        status: 'warn',
        adjusted: true,
        message: reason.text,
        metadata: {
          sessionId: session.id,
          sport: session.sport,
          originalDayOfWeek: session.dayOfWeek,
          scheduleState: unscheduled.scheduleState,
        },
        decisionReasons: [reason],
      });
      continue;
    }

    const placed = placeSessionInSlot(athlete, session, slot);
    const placedDecisionReasons = placed.decisionReasons ?? [];
    decisionReasons.push(...placedDecisionReasons);
    slot.usedMinutes += placed.durationMinutes;
    scheduledByDay[slot.window.dayOfWeek] = (scheduledByDay[slot.window.dayOfWeek] ?? 0) + 1;
    if (HIGH_FATIGUE.has(session.fatigueCost)) {
      scheduledHighFatigueDays.add(slot.window.dayOfWeek);
    }
    reconciledById.set(session.id, placed);
    if (placed.scheduleState && placed.scheduleState !== 'scheduled') {
      results.push({
        ruleId: `capacity_${placed.scheduleState}_${session.id}`,
        status: placed.scheduleState === 'reflowed' || placed.scheduleState === 'capped' || placed.scheduleState === 'compressed' ? 'warn' : 'pass',
        adjusted: true,
        message: placed.scheduleReason ?? `${placed.title} was adjusted to fit weekly capacity.`,
        decisionReasons: placedDecisionReasons,
        metadata: {
          sessionId: placed.id,
          sport: placed.sport,
          originalDayOfWeek: placed.originalDayOfWeek ?? session.dayOfWeek,
          dayOfWeek: placed.dayOfWeek,
          scheduleState: placed.scheduleState,
          scheduleAdjustments: placed.scheduleAdjustments,
          capacityMinutes: placed.capacityWindow?.capacityMinutes,
          decisionReasons: placedDecisionReasons,
        },
      });
    }
  }

  const output = [...reconciledById.values()].sort((left, right) => {
    const leftIndex = originalIndex.get(left.id) ?? 0;
    const rightIndex = originalIndex.get(right.id) ?? 0;
    return leftIndex - rightIndex;
  });

  const activeCount = output.filter(isActiveTrainingSession).length;
  if (activeCount < sessions.filter((session) => session.sessionType !== 'rest').length) {
    const reason = buildWeeklyCapDecisionReason({
      athlete,
      activeCount,
      originalActiveCount: sessions.filter((session) => session.sessionType !== 'rest').length,
      availableSlotCount: slots.length,
    });
    decisionReasons.push(reason);
    results.push({
      ruleId: 'capacity_weekly_active_session_cap',
      status: 'warn',
      adjusted: true,
      message: reason.text,
      decisionReasons: [reason],
      metadata: {
        activeCount,
        originalActiveCount: sessions.filter((session) => session.sessionType !== 'rest').length,
        availableSlotCount: slots.length,
        decisionReasons: [reason],
      },
    });
  }

  return { sessions: output, guardrailResults: results, decisionReasons: dedupeDecisionReasons(decisionReasons) };
}

function buildCapacitySlots(athlete: AthleteState): CapacitySlot[] {
  return athlete.availability.weeklyWindows
    .map((window, index): CapacitySlot | null => {
      const capacityMinutes = windowCapacityMinutes(window);
      if (capacityMinutes == null || capacityMinutes < 10) return null;
      return {
        id: `${window.dayOfWeek}:${window.start}:${window.end}:${index}`,
        window,
        capacityMinutes,
        usedMinutes: 0,
      };
    })
    .filter((slot): slot is CapacitySlot => Boolean(slot))
    .sort((left, right) => {
      const dayDelta = dayIndex(left.window.dayOfWeek) - dayIndex(right.window.dayOfWeek);
      return dayDelta !== 0 ? dayDelta : left.window.start.localeCompare(right.window.start);
    });
}

function chooseSlot(args: {
  athlete: AthleteState;
  session: Session;
  slots: CapacitySlot[];
  scheduledByDay: Partial<Record<DayOfWeek, number>>;
  scheduledHighFatigueDays: Set<DayOfWeek>;
}): CapacitySlot | null {
  const eligible = args.slots
    .filter((slot) => slotAllowsSession(slot, args.session))
    .filter((slot) => slotRemainingMinutes(slot) >= minimumExecutableMinutes(args.session, args.athlete))
    .filter((slot) => (args.scheduledByDay[slot.window.dayOfWeek] ?? 0) < args.athlete.availability.maxSessionsPerDay)
    .sort((left, right) => slotScore(args.athlete, args.session, right, args.scheduledHighFatigueDays) - slotScore(args.athlete, args.session, left, args.scheduledHighFatigueDays));

  if (eligible.length === 0) return null;
  const recoveryRespecting = eligible.filter((slot) => respectsHighFatigueSpacing(args.session, slot.window.dayOfWeek, args.scheduledHighFatigueDays));
  return recoveryRespecting[0] ?? eligible[0];
}

function placeSessionInSlot(athlete: AthleteState, session: Session, slot: CapacitySlot): Session {
  const originalDayOfWeek = session.originalDayOfWeek ?? session.dayOfWeek;
  const adjustments = new Set<SessionScheduleState>();
  const remainingCapacityMinutes = slotRemainingMinutes(slot);
  let next: Session = {
    ...session,
    originalDayOfWeek,
    dayOfWeek: slot.window.dayOfWeek,
    capacityWindow: {
      dayOfWeek: slot.window.dayOfWeek,
      start: slot.window.start,
      end: slot.window.end,
      label: slot.window.label,
      capacityMinutes: remainingCapacityMinutes,
    },
  };

  if (slot.window.dayOfWeek !== originalDayOfWeek) {
    adjustments.add('reflowed');
  }

  if (next.durationMinutes > remainingCapacityMinutes) {
    const cappedDuration = Math.max(minimumExecutableMinutes(next, athlete), remainingCapacityMinutes);
    next = {
      ...next,
      durationMinutes: cappedDuration,
      plannedLoad: durationToLoad(cappedDuration, next.intensityZone, next.fatigueCost),
    };
    adjustments.add('capped');
    if (session.durationMinutes - cappedDuration >= 10 || cappedDuration <= 35 || isTravelWeek(athlete)) {
      adjustments.add('compressed');
    }
  }

  if (next.sport === 'strength' && next.exercises?.length) {
    next = trimOverstuffedStrengthSessionToDuration(next, loadCoachKnowledge(), {
      tag: 'capacity_duration_coherent',
      alternative: 'Capacity reconciliation trimmed trailing strength volume so the session matches the available slot.',
    }).session;
  }

  const preferredStartTime = resolvePreferredStartTime(athlete, next.sport, slot.window);
  const windowEnd = timeToMinutes(slot.window.end);
  const earliestAvailableStart = withDuration(slot.window.start, slot.usedMinutes);
  const preferredEnd = timeToMinutes(preferredStartTime) + next.durationMinutes;
  const earliestEnd = timeToMinutes(earliestAvailableStart) + next.durationMinutes;
  const startTime = slot.usedMinutes > 0
    ? earliestEnd <= windowEnd ? earliestAvailableStart : slot.window.start
    : preferredEnd <= windowEnd ? preferredStartTime : slot.window.start;
  const scheduleAdjustments = adjustments.size > 0 ? [...adjustments] : ['scheduled' as const];
  const scheduleState = primaryScheduleState(scheduleAdjustments);
  const reason = scheduleReason(next, session, slot, scheduleAdjustments);
  const decisionReasons = buildScheduleDecisionReasons(athlete, next, session, slot, scheduleAdjustments);

  return {
    ...next,
    startTime,
    endTime: withDuration(startTime, next.durationMinutes),
    scheduleState,
    scheduleAdjustments,
    scheduleReason: reason,
    decisionReasons: dedupeDecisionReasons([...(next.decisionReasons ?? []), ...decisionReasons]),
    tags: [...new Set([
      ...next.tags.filter((tag) => !tag.startsWith('availability_')),
      ...scheduleAdjustments.filter((state) => state !== 'scheduled').map((state) => `availability_${state}`),
    ])],
    alternatives: reason
      ? [...new Set([...(next.alternatives ?? []), reason])]
      : next.alternatives,
  };
}

function markSessionUnscheduled(session: Session, reason: string, decisionReason: TrainingDecisionReason): Session {
  return {
    ...clearScheduleForInactiveSession(session, reason, 'unscheduled', decisionReason),
    title: `Unscheduled: ${session.title}`,
    description: `${session.description} ${reason}`.trim(),
  };
}

function clearScheduleForInactiveSession(
  session: Session,
  reason: string,
  state: Extract<SessionScheduleState, 'deferred' | 'unscheduled' | 'dropped'>,
  decisionReason?: TrainingDecisionReason,
): Session {
  const { startTime: _startTime, endTime: _endTime, capacityWindow: _capacityWindow, ...rest } = session;
  return {
    ...rest,
    plannedLoad: 0,
    keySession: false,
    scheduleState: state,
    scheduleAdjustments: [state],
    scheduleReason: reason,
    decisionReasons: decisionReason
      ? dedupeDecisionReasons([...(rest.decisionReasons ?? []), decisionReason])
      : rest.decisionReasons,
    tags: [...new Set([...session.tags.filter((tag) => !tag.startsWith('availability_')), `availability_${state}`])],
    alternatives: [...new Set([...(session.alternatives ?? []), reason])],
  };
}

function slotScore(
  athlete: AthleteState,
  session: Session,
  slot: CapacitySlot,
  scheduledHighFatigueDays: Set<DayOfWeek>,
): number {
  const dayDistance = Math.abs(dayIndex(slot.window.dayOfWeek) - dayIndex(session.dayOfWeek));
  const sameDayBonus = slot.window.dayOfWeek === session.dayOfWeek ? 40 : 0;
  const exactSportBonus = slot.window.sports?.includes(session.sport) ? 8 : 0;
  const remainingMinutes = slotRemainingMinutes(slot);
  const capacityFitPenalty = Math.max(0, session.durationMinutes - remainingMinutes) * 0.4;
  const recoveryPenalty = respectsHighFatigueSpacing(session, slot.window.dayOfWeek, scheduledHighFatigueDays) ? 0 : 18;
  const travelShortSlotBonus = isTravelWeek(athlete) && remainingMinutes <= 45 ? 5 : 0;
  return sameDayBonus + exactSportBonus + travelShortSlotBonus - (dayDistance * 7) - capacityFitPenalty - recoveryPenalty;
}

function sessionPriority(athlete: AthleteState, session: Session): number {
  if (session.sessionType === 'rest') return -100;
  const order = athlete.goals.priorityOrder ?? [];
  const priorityIndex = order.indexOf(session.sport);
  const sportPriority = priorityIndex >= 0 ? (order.length - priorityIndex) * 8 : 0;
  const primaryBonus = athlete.goals.primaryFocus === session.sport || (athlete.goals.primaryFocus === 'strength' && session.sport === 'strength') ? 16 : 0;
  const keyBonus = session.keySession ? 28 : 0;
  const fatiguePenalty = isConstrainedWeek(athlete) && HIGH_FATIGUE.has(session.fatigueCost) ? 6 : 0;
  const supportPenalty = session.sessionType === 'mobility' || session.sessionType === 'strength_maintenance' ? 8 : 0;
  const continuityBonus = session.tags.some((tag) => tag.startsWith('key_')) ? 6 : 0;
  return 50 + sportPriority + primaryBonus + keyBonus + continuityBonus - fatiguePenalty - supportPenalty;
}

function slotAllowsSession(slot: CapacitySlot, session: Session): boolean {
  if (!slot.window.sports || slot.window.sports.length === 0 || slot.window.sports.includes(session.sport)) {
    return true;
  }
  return session.sessionType === 'brick' && slot.window.sports.includes('cycling');
}

function windowCapacityMinutes(window: AvailabilityWindow): number | null {
  const start = timeToMinutes(window.start);
  const end = timeToMinutes(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return end - start;
}

function minimumExecutableMinutes(session: Session, athlete: AthleteState): number {
  const travel = isTravelWeek(athlete);
  if (session.sport === 'strength') return travel ? 20 : 25;
  if (session.sessionType === 'long_run' || session.sessionType === 'endurance_ride') return travel ? 30 : 35;
  if (session.intensityZone === 'threshold' || session.intensityZone === 'vo2') return travel ? 25 : 30;
  return 20;
}

function isConstrainedWeek(athlete: AthleteState): boolean {
  const windows = athlete.availability.weeklyWindows;
  const totalCapacity = windows.reduce((sum, window) => sum + (windowCapacityMinutes(window) ?? 0), 0);
  const targetMinutes = Object.values(athlete.goals.weeklyMinutesTarget ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);
  const targetSessions = Object.values(athlete.goals.weeklySessionsTarget ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);
  return isTravelWeek(athlete)
    || athlete.constraints.some((constraint) => constraint.type === 'time' && constraint.severity === 'high')
    || windows.length < targetSessions
    || (targetMinutes > 0 && totalCapacity < targetMinutes * 0.8);
}

function isTravelWeek(athlete: AthleteState): boolean {
  const haystack = [
    ...athlete.constraints.map((constraint) => `${constraint.id} ${constraint.description}`),
    ...(athlete.equipment.notes ?? []),
  ].join(' ').toLowerCase();
  return /travel|hotel|trip|limited equipment|away/.test(haystack);
}

function respectsHighFatigueSpacing(
  session: Session,
  day: DayOfWeek,
  scheduledHighFatigueDays: Set<DayOfWeek>,
): boolean {
  if (!HIGH_FATIGUE.has(session.fatigueCost)) return true;
  const index = dayIndex(day);
  for (const scheduled of scheduledHighFatigueDays) {
    const distance = Math.abs(index - dayIndex(scheduled));
    if (distance <= 1 || distance >= 6) return false;
  }
  return true;
}

function primaryScheduleState(adjustments: SessionScheduleState[]): SessionScheduleState {
  if (adjustments.includes('reflowed')) return 'reflowed';
  if (adjustments.includes('compressed')) return 'compressed';
  if (adjustments.includes('capped')) return 'capped';
  return 'scheduled';
}

function scheduleReason(
  scheduled: Session,
  original: Session,
  slot: CapacitySlot,
  adjustments: SessionScheduleState[],
): string | undefined {
  if (adjustments.includes('reflowed') && adjustments.includes('compressed')) {
    return `${scheduled.title} moved from ${original.dayOfWeek} to ${slot.window.dayOfWeek} and was compressed because only ${scheduled.capacityWindow?.capacityMinutes ?? slot.capacityMinutes} minutes were available.`;
  }
  if (adjustments.includes('reflowed')) {
    return `${scheduled.title} moved from ${original.dayOfWeek} to ${slot.window.dayOfWeek} because the original day had no valid training window.`;
  }
  if (adjustments.includes('compressed')) {
    return `${scheduled.title} was compressed because only ${scheduled.capacityWindow?.capacityMinutes ?? slot.capacityMinutes} minutes were available.`;
  }
  if (adjustments.includes('capped')) {
    return `${scheduled.title} was capped to the ${scheduled.capacityWindow?.capacityMinutes ?? slot.capacityMinutes}-minute availability window.`;
  }
  return undefined;
}

function slotRemainingMinutes(slot: CapacitySlot): number {
  return Math.max(0, slot.capacityMinutes - slot.usedMinutes);
}

function buildScheduleDecisionReasons(
  athlete: AthleteState,
  scheduled: Session,
  original: Session,
  slot: CapacitySlot,
  adjustments: SessionScheduleState[],
): TrainingDecisionReason[] {
  const reasons: TrainingDecisionReason[] = [];
  const sourceConstraint = sourceConstraintFor(athlete, 'capacity');
  const capacityMinutes = scheduled.capacityWindow?.capacityMinutes ?? slot.capacityMinutes;

  if (adjustments.includes('reflowed')) {
    reasons.push({
      code: 'session_reflowed',
      text: `${scheduled.title} moved from ${original.dayOfWeek} to ${slot.window.dayOfWeek} because the selected ${slot.window.label ?? 'training window'} was the valid slot for this week.`,
      severity: 'notice',
      affectedEntity: {
        type: 'session',
        id: scheduled.id,
        title: scheduled.title,
        dayOfWeek: scheduled.dayOfWeek,
      },
      sourceConstraint,
      before: {
        dayOfWeek: original.dayOfWeek,
        startTime: original.startTime,
        endTime: original.endTime,
      },
      after: {
        dayOfWeek: scheduled.dayOfWeek,
        startTime: scheduled.startTime,
        endTime: scheduled.endTime,
      },
      preservedIntent: sessionIntent(original),
      evidence: [
        `original_day=${original.dayOfWeek}`,
        `scheduled_day=${scheduled.dayOfWeek}`,
        `slot=${slot.window.start}-${slot.window.end}`,
      ],
    });
  }

  if (adjustments.includes('compressed')) {
    reasons.push({
      code: 'session_compressed',
      text: `${scheduled.title} was compressed from ${original.durationMinutes} to ${scheduled.durationMinutes} minutes because only ${capacityMinutes} minutes were available in the selected window.`,
      severity: 'warning',
      affectedEntity: {
        type: 'session',
        id: scheduled.id,
        title: scheduled.title,
        dayOfWeek: scheduled.dayOfWeek,
      },
      sourceConstraint,
      before: {
        durationMinutes: original.durationMinutes,
        plannedLoad: original.plannedLoad,
      },
      after: {
        durationMinutes: scheduled.durationMinutes,
        plannedLoad: scheduled.plannedLoad,
        capacityMinutes,
      },
      preservedIntent: sessionIntent(original),
      evidence: [
        `available_minutes=${capacityMinutes}`,
        `planned_minutes=${original.durationMinutes}`,
        `scheduled_minutes=${scheduled.durationMinutes}`,
      ],
    });
  } else if (adjustments.includes('capped')) {
    reasons.push({
      code: 'session_capped',
      text: `${scheduled.title} was capped to ${scheduled.durationMinutes} minutes to stay inside the ${capacityMinutes}-minute availability window.`,
      severity: 'notice',
      affectedEntity: {
        type: 'session',
        id: scheduled.id,
        title: scheduled.title,
        dayOfWeek: scheduled.dayOfWeek,
      },
      sourceConstraint,
      before: { durationMinutes: original.durationMinutes },
      after: { durationMinutes: scheduled.durationMinutes, capacityMinutes },
      preservedIntent: sessionIntent(original),
      evidence: [
        `available_minutes=${capacityMinutes}`,
        `planned_minutes=${original.durationMinutes}`,
      ],
    });
  }

  return reasons;
}

function buildUnscheduledDecisionReason(
  athlete: AthleteState,
  session: Session,
  text: string,
): TrainingDecisionReason {
  return {
    code: 'session_unscheduled',
    text,
    severity: 'block',
    affectedEntity: {
      type: 'session',
      id: session.id,
      title: session.title,
      dayOfWeek: session.dayOfWeek,
    },
    sourceConstraint: sourceConstraintFor(athlete, 'capacity'),
    before: {
      dayOfWeek: session.dayOfWeek,
      durationMinutes: session.durationMinutes,
      startTime: session.startTime,
      endTime: session.endTime,
    },
    after: {
      scheduleState: 'unscheduled',
      durationMinutes: 0,
    },
    preservedIntent: sessionIntent(session),
    evidence: [
      `planned_day=${session.dayOfWeek}`,
      `planned_minutes=${session.durationMinutes}`,
    ],
  };
}

function buildWeeklyCapDecisionReason(args: {
  athlete: AthleteState;
  activeCount: number;
  originalActiveCount: number;
  availableSlotCount: number;
}): TrainingDecisionReason {
  return {
    code: 'weekly_frequency_capped',
    text: `${args.activeCount} of ${args.originalActiveCount} planned sessions fit this constrained week; the rest were deferred or marked unscheduled instead of being forced into invalid slots.`,
    severity: 'warning',
    affectedEntity: { type: 'week' },
    sourceConstraint: sourceConstraintFor(args.athlete, 'capacity'),
    before: {
      plannedActiveSessions: args.originalActiveCount,
    },
    after: {
      scheduledActiveSessions: args.activeCount,
      availableSlotCount: args.availableSlotCount,
    },
    preservedIntent: 'Highest-priority sessions were kept before lower-priority work was deferred.',
    evidence: [
      `active_sessions=${args.activeCount}`,
      `planned_sessions=${args.originalActiveCount}`,
      `available_slots=${args.availableSlotCount}`,
    ],
  };
}

function sourceConstraintFor(
  athlete: AthleteState,
  fallbackType: NonNullable<TrainingDecisionReason['sourceConstraint']>['type'],
): NonNullable<TrainingDecisionReason['sourceConstraint']> {
  const travel = athlete.constraints.find((constraint) => /travel|hotel|trip|away/i.test(constraint.description))
    ?? athlete.constraints.find((constraint) => constraint.type === 'equipment' && /limited equipment|hotel/i.test(constraint.description));
  if (travel) {
    return { type: 'travel', id: travel.id, label: travel.description };
  }

  const time = athlete.constraints.find((constraint) => constraint.type === 'time' && constraint.severity === 'high')
    ?? athlete.constraints.find((constraint) => constraint.type === 'time');
  if (time) {
    return { type: 'time', id: time.id, label: time.description };
  }

  const fatigue = athlete.constraints.find((constraint) => constraint.type === 'fatigue');
  if (fatigue) {
    return { type: 'fatigue', id: fatigue.id, label: fatigue.description };
  }

  if (athlete.readiness.level === 'orange' || athlete.readiness.level === 'red') {
    return { type: 'recovery', label: `${athlete.readiness.level} readiness` };
  }

  return { type: fallbackType, label: 'weekly capacity reconciliation' };
}

function sessionIntent(session: Session): string {
  const role = session.sessionType.replace(/_/g, ' ');
  return session.keySession
    ? `Preserved the key ${session.sport} ${role} intent.`
    : `Preserved the ${session.sport} ${role} intent at a feasible dose.`;
}

function dedupeDecisionReasons(reasons: TrainingDecisionReason[]): TrainingDecisionReason[] {
  const seen = new Set<string>();
  const output: TrainingDecisionReason[] = [];
  for (const reason of reasons) {
    const key = [
      reason.code,
      reason.affectedEntity.type,
      reason.affectedEntity.id ?? '',
      reason.text.trim().toLowerCase().replace(/\s+/g, ' '),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(reason);
  }
  return output;
}
