// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CoordinatedTrainingPlan, CoordinatedTrainingSession } from './training-plan-coordination';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import { buildStrengthSupportVariant } from './coach-kernel/support-session-builder';
import type { CoachKnowledgeBase } from './coach-kernel/types';

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

export interface TrainingPlanVolumeRequest {
  sessionsPerWeek: number;
  strengthSessionsPerWeek: number;
  preferredCardioTime: string;
  preferredStrengthTime: string;
  startDate: string;
}

export function enforceRequestedTrainingPlanVolume(
  plan: CoordinatedTrainingPlan,
  request: TrainingPlanVolumeRequest,
): CoordinatedTrainingPlan {
  const cloned: CoordinatedTrainingPlan = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;

  const requestedTotal = clamp(Math.round(request.sessionsPerWeek || 5), 3, 7);
  const requestedStrength = clamp(Math.round(request.strengthSessionsPerWeek || 0), 0, 4);
  const defaultStrengthForGymPlan = String(cloned.sport || '').toLowerCase() === 'gym'
    ? Math.min(4, requestedTotal)
    : 0;

  cloned.weeks = cloned.weeks.map((week) => {
    const weekNumber = typeof week.weekNumber === 'number' ? week.weekNumber : 1;
    const allowedDays = allowedDaysForWeek(request.startDate, weekNumber);
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

function normalizeDay(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return DAY_ORDER.includes(normalized as typeof DAY_ORDER[number]) ? normalized : null;
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
