// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CoordinatedTrainingPlan, CoordinatedTrainingSession } from './training-plan-coordination';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import { buildStrengthSupportVariant } from './coach-kernel/support-session-builder';
import type { CoachKnowledgeBase } from './coach-kernel/types';
import {
  inferTrainingSessionIsLongRun,
  inferTrainingSessionIsLowerHeavy,
} from './training-session-classification';

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABEL: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};
const MAX_STRENGTH_SESSIONS_PER_WEEK = 6;

export interface TrainingPlanVolumeRequest {
  sessionsPerWeek: number;
  runSessionsPerWeek?: number;
  strengthSessionsPerWeek: number;
  preferredCardioTime: string;
  preferredStrengthTime: string;
  startDate: string;
  longWorkoutDay?: string | null;
}

export function enforceRequestedTrainingPlanVolume(
  plan: CoordinatedTrainingPlan,
  request: TrainingPlanVolumeRequest,
): CoordinatedTrainingPlan {
  const cloned: CoordinatedTrainingPlan = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;

  const planSport = String(cloned.sport || '').toLowerCase();
  const requestedPrimarySessions = planSport === 'running'
    ? clamp(Math.round((request.runSessionsPerWeek ?? request.sessionsPerWeek) || 5), 1, 7)
    : clamp(Math.round(request.sessionsPerWeek || 5), 3, 7);
  const requestedStrength = clamp(Math.round(request.strengthSessionsPerWeek || 0), 0, MAX_STRENGTH_SESSIONS_PER_WEEK);
  // 2026-05-25 Bug #2 fix — when the user provides BOTH explicit
  // `runSessionsPerWeek` AND `strengthSessionsPerWeek`, the total
  // active sessions for the week must be the sum, regardless of
  // `planSport`. Pre-fix the enforcer only summed for `planSport ==
  // 'running'` and silently dropped the strength count from the
  // total for hybrid/gym plans, which capped weeks at the primary
  // count and prevented true two-a-day scheduling. The math still
  // respects MAX_STRENGTH_SESSIONS_PER_WEEK on the strength side
  // and the existing `allowedDays.length * 2` ceiling below.
  const hasExplicitRunRequest = typeof request.runSessionsPerWeek === 'number' && request.runSessionsPerWeek > 0;
  const hasExplicitStrengthRequest = requestedStrength > 0;
  const requestedTotal = (hasExplicitRunRequest && hasExplicitStrengthRequest)
    ? clamp(Math.round(request.runSessionsPerWeek!), 1, 7) + requestedStrength
    : planSport === 'running'
      ? requestedPrimarySessions + requestedStrength
      : requestedPrimarySessions;
  const defaultStrengthForGymPlan = planSport === 'gym'
    ? Math.min(MAX_STRENGTH_SESSIONS_PER_WEEK, requestedPrimarySessions)
    : 0;

  cloned.weeks = cloned.weeks.map((week) => {
    const weekNumber = typeof week.weekNumber === 'number' ? week.weekNumber : 1;
    const allowedDays = constrainTrainingDays(
      allowedDaysForWeek(request.startDate, weekNumber),
      requestedPrimarySessions,
      request.longWorkoutDay,
    );
    const activeTarget = Math.min(requestedTotal, Math.max(1, allowedDays.length * 2));
    const strengthTarget = Math.min(
      activeTarget,
      requestedStrength > 0 ? requestedStrength : defaultStrengthForGymPlan,
    );

    let sessions = (week.sessions ?? [])
      .filter(isScheduledSession)
      .map((session) => normalizeSessionDay(session))
      .filter((session): session is CoordinatedTrainingSession => Boolean(session));

    sessions = convertExtraStrengthToCardio(sessions, strengthTarget, cloned.sport, request);
    sessions = spreadSameTypeCollisions(sessions, allowedDays);
    sessions = trimToActiveTarget(sessions, activeTarget, strengthTarget);
    // Slice 4.C — pass weekNumber so the support-session-builder
    // rotation shifts each week (0-based shift = weekNumber - 1).
    sessions = fillMissingStrength(sessions, strengthTarget, allowedDays, cloned.sport, request, weekNumber);
    sessions = fillMissingActiveSessions(sessions, activeTarget, allowedDays, cloned.sport, request);
    sessions = protectHeavyLowerBeforeLongRun(sessions, request, cloned.sport, weekNumber);

    return {
      ...week,
      sessions: sortSessions(applyPreferredTimes(sessions, request)),
    };
  });

  return cloned;
}

function allowedDaysForWeek(startDate: string, weekNumber: number): string[] {
  if (weekNumber !== 1) return [...DAY_ORDER];
  const startIndex = dayIndexFromIsoDate(startDate);
  if (startIndex < 0) return [...DAY_ORDER];
  return DAY_ORDER.slice(startIndex);
}

function constrainTrainingDays(
  allowedDays: readonly string[],
  requestedTrainingDays: number,
  longWorkoutDay: unknown,
): string[] {
  const budget = clamp(Math.round(requestedTrainingDays || 5), 1, 7);
  const normalizedAllowed = allowedDays.filter((day) => DAY_ORDER.includes(day as typeof DAY_ORDER[number]));
  if (normalizedAllowed.length <= budget) return [...normalizedAllowed];

  const protectedLongDay = normalizeDay(longWorkoutDay);
  const restPreference = ['sunday', 'monday', 'friday', 'thursday', 'tuesday', 'wednesday', 'saturday'];
  const days = [...normalizedAllowed];
  for (const restDay of restPreference) {
    if (days.length <= budget) break;
    if (restDay === protectedLongDay) continue;
    const index = days.indexOf(restDay);
    if (index >= 0) days.splice(index, 1);
  }
  return days.slice(0, budget);
}

function dayIndexFromIsoDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return -1;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return -1;
  const mondayIndex = (parsed.getUTCDay() + 6) % 7;
  return mondayIndex >= 0 && mondayIndex < DAY_ORDER.length ? mondayIndex : -1;
}

function normalizeSessionDay(session: CoordinatedTrainingSession): CoordinatedTrainingSession | null {
  const day = normalizeDay(session.dayOfWeek);
  if (!day) return null;
  return {
    ...session,
    dayOfWeek: DAY_LABEL[day],
  };
}

function isScheduledSession(session: CoordinatedTrainingSession): boolean {
  const type = String(session.sessionType || '').toLowerCase();
  if (type === 'rest' || type === 'mobility') return false;
  if (isStandaloneMobilitySession(session)) return false;
  return true;
}

function isStandaloneMobilitySession(session: CoordinatedTrainingSession): boolean {
  const combined = `${session.sessionType || ''} ${session.title || ''}`.toLowerCase();
  const exerciseCount = Array.isArray(session.exercises) ? session.exercises.length : 0;
  return combined.includes('mobility') && exerciseCount === 0;
}

function convertExtraStrengthToCardio(
  sessions: CoordinatedTrainingSession[],
  strengthTarget: number,
  sport: string | undefined,
  request: TrainingPlanVolumeRequest,
): CoordinatedTrainingSession[] {
  let strengthCount = sessions.filter(isStrengthSession).length;
  if (strengthCount <= strengthTarget) return sessions;

  return sessions.map((session, index) => {
    if (!isStrengthSession(session) || strengthCount <= strengthTarget) return session;
    const converted = buildCardioSupportSession(normalizeDay(session.dayOfWeek) ?? 'tuesday', sport, request, index);
    strengthCount -= 1;
    return converted;
  });
}

function trimToActiveTarget(
  sessions: CoordinatedTrainingSession[],
  activeTarget: number,
  strengthTarget: number,
): CoordinatedTrainingSession[] {
  const next = [...sessions];
  while (next.length > activeTarget) {
    const removableIndex = next
      .map((session, index) => ({ session, index }))
      .sort((left, right) => removableScore(left.session) - removableScore(right.session))
      .find(({ session }) => !isStrengthSession(session) || countStrength(next) > strengthTarget)
      ?.index;
    if (removableIndex == null) break;
    next.splice(removableIndex, 1);
  }
  return next;
}

function spreadSameTypeCollisions(
  sessions: CoordinatedTrainingSession[],
  allowedDays: string[],
): CoordinatedTrainingSession[] {
  const next = [...sessions];
  const seen = new Set<string>();

  for (let index = 0; index < next.length; index += 1) {
    const session = next[index];
    const bucket = isStrengthSession(session) ? 'strength' : 'cardio';
    const currentDay = normalizeDay(session.dayOfWeek);
    const key = `${currentDay}:${bucket}`;
    if (currentDay && !seen.has(key)) {
      seen.add(key);
      continue;
    }

    const replacementDay = chooseDayWithoutBucket(next, allowedDays, bucket);
    if (!replacementDay) continue;
    next[index] = {
      ...session,
      dayOfWeek: DAY_LABEL[replacementDay] ?? replacementDay,
    };
    seen.add(`${replacementDay}:${bucket}`);
  }

  return next;
}

function chooseDayWithoutBucket(
  sessions: CoordinatedTrainingSession[],
  allowedDays: string[],
  bucket: 'strength' | 'cardio',
): string | null {
  const candidates = allowedDays.length > 0 ? allowedDays : [...DAY_ORDER];
  return candidates.find((day) => {
    const daySessions = sessions.filter((session) => normalizeDay(session.dayOfWeek) === day);
    if (daySessions.length >= 2) return false;
    return !daySessions.some((session) => (isStrengthSession(session) ? 'strength' : 'cardio') === bucket);
  }) ?? null;
}

function fillMissingStrength(
  sessions: CoordinatedTrainingSession[],
  strengthTarget: number,
  allowedDays: string[],
  sport: string | undefined,
  request: TrainingPlanVolumeRequest,
  weekNumber: number = 1,
): CoordinatedTrainingSession[] {
  const next = [...sessions];
  while (countStrength(next) < strengthTarget) {
    const day = chooseInsertionDay(next, allowedDays, 'strength');
    if (!day) break;
    next.push(buildStrengthSupportSession(day, sport, request, countStrength(next), weekNumber));
  }
  return next;
}

function fillMissingActiveSessions(
  sessions: CoordinatedTrainingSession[],
  activeTarget: number,
  allowedDays: string[],
  sport: string | undefined,
  request: TrainingPlanVolumeRequest,
): CoordinatedTrainingSession[] {
  const next = [...sessions];
  while (next.length < activeTarget) {
    const day = chooseInsertionDay(next, allowedDays, 'cardio');
    if (!day) break;
    next.push(buildCardioSupportSession(day, sport, request, next.length));
  }
  return next;
}

function protectHeavyLowerBeforeLongRun(
  sessions: CoordinatedTrainingSession[],
  request: TrainingPlanVolumeRequest,
  sport: string | undefined,
  weekNumber: number,
): CoordinatedTrainingSession[] {
  const longRunDay = resolveLongRunDayForWeek(sessions, request.longWorkoutDay);
  if (!longRunDay) return sessions;

  const dayBeforeLongRun = previousDay(longRunDay);
  const next = sessions.map((session) => ({ ...session }));

  for (let index = 0; index < next.length; index += 1) {
    const session = next[index];
    if (normalizeDay(session.dayOfWeek) !== dayBeforeLongRun) continue;
    if (!inferTrainingSessionIsLowerHeavy(session)) continue;

    const swapIndex = findUpperStrengthSwapTarget(next, index, dayBeforeLongRun, longRunDay);
    if (swapIndex >= 0) {
      const originalDay = next[index].dayOfWeek;
      const replacementDay = next[swapIndex].dayOfWeek;
      next[index] = withScheduleAdjustment({
        ...next[index],
        dayOfWeek: replacementDay,
      }, `Moved away from the day before the long run to avoid heavy lower-body work before ${DAY_LABEL[longRunDay]}.`);
      next[swapIndex] = withScheduleAdjustment({
        ...next[swapIndex],
        dayOfWeek: originalDay,
      }, 'Moved into the pre-long-run strength slot as an upper-body-safe replacement.');
      continue;
    }

    next[index] = buildUpperBodyReplacementSession(next[index], sport, request, weekNumber);
  }

  return next;
}

function resolveLongRunDayForWeek(
  sessions: CoordinatedTrainingSession[],
  requestedLongWorkoutDay: unknown,
): string | null {
  const requested = normalizeDay(requestedLongWorkoutDay);
  const longSessions = sessions
    .map((session) => ({ session, day: normalizeDay(session.dayOfWeek) }))
    .filter((entry): entry is { session: CoordinatedTrainingSession; day: string } =>
      Boolean(entry.day) && inferTrainingSessionIsLongRun(entry.session)
    );

  return longSessions.find((entry) => !requested || entry.day === requested)?.day
    ?? longSessions[0]?.day
    ?? null;
}

function findUpperStrengthSwapTarget(
  sessions: CoordinatedTrainingSession[],
  offenderIndex: number,
  dayBeforeLongRun: string,
  longRunDay: string,
): number {
  const candidates = sessions
    .map((session, index) => ({ session, index, day: normalizeDay(session.dayOfWeek) }))
    .filter((entry): entry is { session: CoordinatedTrainingSession; index: number; day: string } =>
      entry.index !== offenderIndex
      && Boolean(entry.day)
      && entry.day !== dayBeforeLongRun
      && entry.day !== longRunDay
      && isStrengthSession(entry.session)
      && !inferTrainingSessionIsLowerHeavy(entry.session)
    )
    .sort((left, right) => {
      const leftScore = longRunSwapScore(left.day, longRunDay);
      const rightScore = longRunSwapScore(right.day, longRunDay);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return daySortIndex(left.day) - daySortIndex(right.day);
    });

  return candidates[0]?.index ?? -1;
}

function longRunSwapScore(day: string, longRunDay: string): number {
  if (day === longRunDay) return 0;
  if (previousDay(longRunDay) === day || nextDay(longRunDay) === day) return 1;
  return 3;
}

function buildUpperBodyReplacementSession(
  original: CoordinatedTrainingSession,
  sport: string | undefined,
  request: TrainingPlanVolumeRequest,
  weekNumber: number,
): CoordinatedTrainingSession {
  const knowledge = safeLoadCoachKnowledge();
  const weekShift = Math.max(0, weekNumber - 1);
  const upperVariant = [1, 3]
    .map((slot) => buildStrengthSupportVariant(slot, knowledge, weekShift))
    .find((variant) => !inferTrainingSessionIsLowerHeavy({
      sessionType: 'gym',
      title: variant.title,
      exercises: variant.exercises as Array<Record<string, any>>,
    }));

  const planSport = String(sport || '').toLowerCase();
  const replacement = upperVariant
    ? {
        title: planSport === 'running' ? `Runner ${upperVariant.title}` : upperVariant.title,
        durationMinutes: upperVariant.durationMinutes,
        exercises: upperVariant.exercises as Array<Record<string, any>>,
      }
    : {
        title: planSport === 'running' ? 'Runner Upper Body Strength' : 'Upper Body Strength',
        durationMinutes: Math.min(Math.max(original.durationMinutes || 45, 35), 50),
        exercises: [
          { name: 'Dumbbell Bench Press', sets: 3, reps: '8-10', rir: 2, restSec: 75 },
          { name: 'Lat Pulldown', sets: 3, reps: '8-10', rir: 2, restSec: 75 },
          { name: 'One-Arm Dumbbell Row', sets: 3, reps: '10 each side', rir: 2, restSec: 60 },
          { name: 'Dead Bug', sets: 3, reps: '10 each side', rir: 3, restSec: 30 },
        ],
      };

  return withScheduleAdjustment({
    ...original,
    sessionType: 'gym',
    title: replacement.title,
    durationMinutes: replacement.durationMinutes,
    preferredStartTime: original.preferredStartTime ?? request.preferredStrengthTime,
    description: 'Upper-body strength slot substituted to avoid heavy lower-body work the day before the long run.',
    exercises: replacement.exercises,
  }, 'Converted from lower-body strength to upper-body strength before the long run.');
}

function withScheduleAdjustment(
  session: CoordinatedTrainingSession,
  adjustment: string,
): CoordinatedTrainingSession {
  return {
    ...session,
    scheduleAdjustments: [...(session.scheduleAdjustments ?? []), adjustment],
    scheduleReason: session.scheduleReason ?? adjustment,
  };
}

function chooseInsertionDay(
  sessions: CoordinatedTrainingSession[],
  allowedDays: string[],
  kind: 'strength' | 'cardio',
): string | null {
  const normalizedAllowed = allowedDays.length > 0 ? allowedDays : [...DAY_ORDER];
  const preferredOrder = kind === 'strength'
    ? ['monday', 'wednesday', 'friday', 'saturday', 'tuesday', 'thursday', 'sunday']
    : ['tuesday', 'thursday', 'sunday', 'saturday', 'friday', 'wednesday', 'monday'];
  const orderedDays = preferredOrder.filter((day) => normalizedAllowed.includes(day));
  const fallbackDays = normalizedAllowed.filter((day) => !orderedDays.includes(day));
  const candidates = [...orderedDays, ...fallbackDays];

  for (const maxCount of [0, 1]) {
    const day = candidates.find((candidate) => {
      const daySessions = sessions.filter((session) => normalizeDay(session.dayOfWeek) === candidate);
      if (daySessions.length !== maxCount) return false;
      if (daySessions.length >= 2) return false;
      if (kind === 'strength') return !daySessions.some(isStrengthSession);
      return !daySessions.some((session) => !isStrengthSession(session));
    });
    if (day) return day;
  }

  if (kind === 'strength') return null;

  return candidates.find((candidate) =>
    sessions.filter((session) => normalizeDay(session.dayOfWeek) === candidate).length < 2
  ) ?? null;
}

function buildStrengthSupportSession(
  dayOfWeek: string,
  sport: string | undefined,
  request: TrainingPlanVolumeRequest,
  index: number,
  weekNumber: number = 1,
): CoordinatedTrainingSession {
  const knowledge = safeLoadCoachKnowledge();
  // Slice 4.C — weekNumber is 1-based in the volume-enforcement
  // loop; convert to 0-based for the rotation shift so week 1 has
  // shift 0 (matches strengthVariantFor's macro-rotation anchor).
  const weekShift = Math.max(0, weekNumber - 1);
  const variant = buildStrengthSupportVariant(index, knowledge, weekShift);
  const planSport = String(sport || '').toLowerCase();
  return {
    dayOfWeek: DAY_LABEL[dayOfWeek] ?? dayOfWeek,
    sessionType: 'gym',
    title: planSport === 'running' ? `Runner ${variant.title}` : variant.title,
    durationMinutes: variant.durationMinutes,
    preferredStartTime: request.preferredStrengthTime,
    description: 'Strength slot added to preserve the requested weekly gym volume while keeping the load controlled.',
    exercises: variant.exercises,
  };
}

/**
 * Defensive loader. The coach knowledge files ship with the package
 * so the happy path never fails, but if a constrained test
 * environment can't reach them we let `buildStrengthSupportVariant`
 * fall back to its `MIN_CREDIBLE_STRENGTH_MINUTES` floor instead of
 * crashing the volume-enforcement pass.
 */
function safeLoadCoachKnowledge(): CoachKnowledgeBase | undefined {
  try {
    return loadCoachKnowledge();
  } catch {
    return undefined;
  }
}

function buildCardioSupportSession(
  dayOfWeek: string,
  sport: string | undefined,
  request: TrainingPlanVolumeRequest,
  index: number,
): CoordinatedTrainingSession {
  const normalizedSport = String(sport || '').toLowerCase();
  const sessionType = normalizedSport === 'cycling'
    ? 'ride'
    : normalizedSport === 'swimming'
      ? 'swim'
      : 'run';
  const title = sessionType === 'ride'
    ? 'Easy Aerobic Ride'
    : sessionType === 'swim'
      ? 'Easy Technique Swim'
      : index % 2 === 0
        ? 'Easy Aerobic Run'
        : 'Recovery Run';
  return {
    dayOfWeek: DAY_LABEL[dayOfWeek] ?? dayOfWeek,
    sessionType,
    title,
    durationMinutes: sessionType === 'swim' ? 35 : 40,
    preferredStartTime: request.preferredCardioTime,
    description: 'Aerobic support added to reach the requested weekly frequency without turning recovery days into hard sessions.',
    exercises: [],
  };
}

function sortSessions(sessions: CoordinatedTrainingSession[]): CoordinatedTrainingSession[] {
  return [...sessions].sort((left, right) => {
    const dayDelta = daySortIndex(normalizeDay(left.dayOfWeek)) - daySortIndex(normalizeDay(right.dayOfWeek));
    if (dayDelta !== 0) return dayDelta;
    return timeToMinutes(left.preferredStartTime) - timeToMinutes(right.preferredStartTime);
  });
}

function applyPreferredTimes(
  sessions: CoordinatedTrainingSession[],
  request: TrainingPlanVolumeRequest,
): CoordinatedTrainingSession[] {
  return sessions.map((session) => ({
    ...session,
    preferredStartTime: session.preferredStartTime
      ?? (isStrengthSession(session) ? request.preferredStrengthTime : request.preferredCardioTime),
  }));
}

function removableScore(session: CoordinatedTrainingSession): number {
  if (isStandaloneMobilitySession(session)) return -1;
  if (/recovery|easy|support/i.test(session.title || '')) return 1;
  if (isStrengthSession(session)) return 3;
  return 2;
}

function isStrengthSession(session: CoordinatedTrainingSession): boolean {
  return String(session.sessionType || '').toLowerCase() === 'gym';
}

function countStrength(sessions: CoordinatedTrainingSession[]): number {
  return sessions.filter(isStrengthSession).length;
}

function normalizeDay(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return DAY_ORDER.includes(normalized as typeof DAY_ORDER[number]) ? normalized : null;
}

function previousDay(day: string): string {
  const index = DAY_ORDER.indexOf(day as typeof DAY_ORDER[number]);
  if (index < 0) return day;
  return DAY_ORDER[(index + DAY_ORDER.length - 1) % DAY_ORDER.length];
}

function nextDay(day: string): string {
  const index = DAY_ORDER.indexOf(day as typeof DAY_ORDER[number]);
  if (index < 0) return day;
  return DAY_ORDER[(index + 1) % DAY_ORDER.length];
}

function daySortIndex(day: string | null): number {
  if (!day) return 99;
  const index = DAY_ORDER.indexOf(day as typeof DAY_ORDER[number]);
  return index >= 0 ? index : 99;
}

function timeToMinutes(value: unknown): number {
  const text = typeof value === 'string' ? value : '';
  if (!/^\d{2}:\d{2}$/.test(text)) return 12 * 60;
  const [hours, minutes] = text.split(':').map(Number);
  return (hours * 60) + minutes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
