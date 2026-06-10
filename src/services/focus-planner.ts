// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { logger } from '../utils/logger';
import { calculateReadiness } from './readiness-scorer';
import { getEvents, type UnifiedCalendarEvent } from './unified-calendar';
import {
  readScheduledTrainingSessions,
  readTrainingContextAll,
} from './training-signals';
import {
  getActivePlans,
  getSessionsForWeek,
  getWeeksForPlan,
  type TrainingPlan,
  type TrainingSession,
  type TrainingWeek,
} from './training-plans';
import { getUserTimezone } from './user-service';

type TrainingLoad = 'hard' | 'moderate' | 'light' | 'rest' | 'unknown';
type CalendarLoad = 'busy' | 'moderate' | 'light' | 'unknown';

export interface FocusTrainingCoordination {
  status: 'already_protected' | 'needs_adjustment';
  sessionDate: string;
  sessionTitle: string | null;
  sessionLoad: TrainingLoad;
}

export interface FocusBlockRecommendation {
  start: string;
  end: string;
  date: string; // YYYY-MM-DD in app timezone
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  reasons: string[];
  focusWindow: 'peak' | 'late_morning' | 'midday' | 'afternoon';
  readinessScore: number | null;
  trainingLoad: TrainingLoad;
  calendarLoad: CalendarLoad;
  trainingCoordination?: FocusTrainingCoordination | null;
}

interface TrainingDaySummary {
  load: TrainingLoad;
  reasons: string[];
  title: string | null;
}

interface FocusCandidate {
  start: DateTime;
  end: DateTime;
  score: number;
  reasons: string[];
  focusWindow: FocusBlockRecommendation['focusWindow'];
  readinessScore: number | null;
  trainingLoad: TrainingLoad;
  calendarLoad: CalendarLoad;
}

interface DatedFocusCandidate extends FocusCandidate {
  date: string;
  offset: number;
}

export async function getFocusBlockRecommendation(
  userId: number,
  opts?: {
    durationMinutes?: number;
    horizonDays?: number;
    preferredDate?: string;
  },
): Promise<FocusBlockRecommendation | null> {
  const zone = getUserTimezone(userId);
  const now = DateTime.now().setZone(zone);
  const durationMinutes = clamp(Math.round(opts?.durationMinutes ?? 90), 30, 180);
  const preferredDate = typeof opts?.preferredDate === 'string'
    ? DateTime.fromISO(opts.preferredDate, { zone }).startOf('day')
    : null;
  const horizonDays = preferredDate?.isValid
    ? 1
    : clamp(Math.round(opts?.horizonDays ?? 4), 1, 7);
  const startDate = preferredDate?.isValid ? preferredDate : now.startOf('day');
  const endDate = startDate.plus({ days: horizonDays - 1 }).endOf('day');

  const [calendarResult, readinessResult] = await Promise.allSettled([
    getEvents(startDate.toUTC().toISO()!, endDate.toUTC().toISO()!, userId),
    calculateReadiness(userId),
  ]);

  const events = calendarResult.status === 'fulfilled' ? calendarResult.value : [];
  const readiness = readinessResult.status === 'fulfilled' ? readinessResult.value : null;
  const trainingContext = readTrainingContextAll({ userId });
  const scheduledTraining = readScheduledTrainingSessions({
    userId,
    windowStartIso: startDate.toUTC().toISO()!,
    windowEndIso: endDate.toUTC().toISO()!,
  });
  const trainingSchedule = buildTrainingSchedule(userId, startDate, horizonDays, zone);

  const hadCalendarData = calendarResult.status === 'fulfilled';
  const hadReadinessData = readiness?.score != null;
  const hadTrainingData = trainingSchedule.size > 0 || trainingContext.signals.length > 0;

  if (!hadCalendarData && !hadReadinessData && !hadTrainingData) {
    return null;
  }

  const candidates: FocusCandidate[] = [];

  for (let offset = 0; offset < horizonDays; offset += 1) {
    const day = startDate.plus({ days: offset });
    const isoDate = day.toISODate()!;
    const dayEvents = eventsForDate(events, isoDate, zone);
    const calendarSummary = summarizeCalendarLoad(dayEvents);
    const trainingSummary = trainingSchedule.get(isoDate) ?? fallbackTrainingSummary(hadTrainingData);
    const windows = enumerateCandidateWindows(day, dayEvents, durationMinutes, now, zone);

    for (const window of windows) {
      const focusWindow = classifyFocusWindow(window.start);
      const score = scoreWindow({
        windowStart: window.start,
        offset,
        focusWindow,
        readinessScore: readiness?.score ?? null,
        trainingLoad: trainingSummary.load,
        calendarLoad: calendarSummary.load,
        trainingContextFlags: trainingContext.flags,
        hasTrainingAdjacency: hasTrainingAdjacency(window.start, window.end, dayEvents, scheduledTraining, zone),
      });

      const reasons = dedupePreservingOrder([
        ...timeWindowReasons(focusWindow),
        ...readinessReasons(offset, readiness?.score ?? null, trainingContext.flags),
        ...trainingSummary.reasons,
        ...calendarSummary.reasons,
        ...(hasTrainingAdjacency(window.start, window.end, dayEvents, scheduledTraining, zone)
          ? ['This slot stays free, but training sits close enough that the block could feel interrupted.']
          : []),
      ]);

      candidates.push({
        start: window.start,
        end: window.end,
        score,
        reasons,
        focusWindow,
        readinessScore: readiness?.score ?? null,
        trainingLoad: trainingSummary.load,
        calendarLoad: calendarSummary.load,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((lhs, rhs) => {
    if (lhs.score !== rhs.score) return rhs.score - lhs.score;
    return lhs.start.toMillis() - rhs.start.toMillis();
  });

  const best = selectRecommendedCandidate(candidates, {
    startDate,
    now,
    prefersSingleDay: Boolean(preferredDate?.isValid),
  });
  const dataSources = [hadCalendarData, hadReadinessData, hadTrainingData].filter(Boolean).length;
  const confidence: FocusBlockRecommendation['confidence'] =
    dataSources >= 3 ? 'high' : dataSources === 2 ? 'medium' : 'low';

  const recommendation: FocusBlockRecommendation = {
    start: best.start.toUTC().toISO()!,
    end: best.end.toUTC().toISO()!,
    date: best.start.toISODate()!,
    confidence,
    reason: best.reasons[0] ?? 'This is the cleanest block to protect for deep work.',
    reasons: best.reasons,
    focusWindow: best.focusWindow,
    readinessScore: best.readinessScore,
    trainingLoad: best.trainingLoad,
    calendarLoad: best.calendarLoad,
    trainingCoordination: buildTrainingCoordination(best.start, best.trainingLoad, trainingSchedule),
  };

  logger.info(
    {
      userId,
      start: recommendation.start,
      end: recommendation.end,
      readinessScore: recommendation.readinessScore,
      trainingLoad: recommendation.trainingLoad,
      calendarLoad: recommendation.calendarLoad,
      confidence: recommendation.confidence,
    },
    'Focus block recommendation generated',
  );

  return recommendation;
}

function selectRecommendedCandidate(
  candidates: FocusCandidate[],
  opts: {
    startDate: DateTime;
    now: DateTime;
    prefersSingleDay: boolean;
  },
): FocusCandidate {
  if (opts.prefersSingleDay || candidates.length === 1) {
    return candidates[0];
  }

  const bestByDay = buildBestCandidatesByDay(candidates, opts.startDate);
  const actionable = bestByDay.find((candidate) => isActionableFocusDayCandidate(candidate, opts.now));
  return actionable ?? candidates[0];
}

function buildBestCandidatesByDay(
  candidates: FocusCandidate[],
  startDate: DateTime,
): DatedFocusCandidate[] {
  const bestByDay = new Map<string, DatedFocusCandidate>();

  for (const candidate of candidates) {
    const date = candidate.start.toISODate()!;
    if (bestByDay.has(date)) continue;
    bestByDay.set(date, {
      ...candidate,
      date,
      offset: Math.max(0, Math.floor(candidate.start.startOf('day').diff(startDate.startOf('day'), 'days').days)),
    });
  }

  return Array.from(bestByDay.values()).sort((lhs, rhs) => lhs.start.toMillis() - rhs.start.toMillis());
}

function isActionableFocusDayCandidate(candidate: DatedFocusCandidate, now: DateTime): boolean {
  if (candidate.score < 18) return false;
  if (candidate.calendarLoad === 'busy') return false;
  if (candidate.trainingLoad === 'hard') return false;
  if (candidate.offset === 0 && candidate.readinessScore != null && candidate.readinessScore < 55) return false;
  if (candidate.offset === 0 && candidate.start < now.plus({ minutes: 45 })) return false;
  return true;
}

function buildTrainingSchedule(
  userId: number,
  startDate: DateTime,
  windowDays: number,
  zone: string,
): Map<string, TrainingDaySummary> {
  const byDate = new Map<string, TrainingDaySummary>();
  const plans = getActivePlans(userId, userId);

  if (plans.length > 0) {
    for (let offset = 0; offset < windowDays; offset += 1) {
      byDate.set(startDate.plus({ days: offset }).toISODate()!, {
        load: 'rest',
        reasons: ['No hard training is planned around this day, so your focus hours are easier to protect.'],
        title: null,
      });
    }
  }

  for (const plan of plans) {
    const weeks = getWeeksForPlan(plan.id);
    for (let offset = 0; offset < windowDays; offset += 1) {
      const date = startDate.plus({ days: offset });
      const week = weekForDate(plan, weeks, date, zone);
      if (!week) continue;
      const weekday = date.toFormat('EEEE');
      const sessions = getSessionsForWeek(week.id).filter((session) => session.day_of_week === weekday);
      if (sessions.length === 0) continue;

      const summary = summarizeTrainingSessions(sessions);
      const existing = byDate.get(date.toISODate()!);
      if (!existing || trainingLoadRank(summary.load) > trainingLoadRank(existing.load)) {
        byDate.set(date.toISODate()!, summary);
      }
    }
  }

  return byDate;
}

function weekForDate(plan: TrainingPlan, weeks: TrainingWeek[], date: DateTime, zone: string): TrainingWeek | null {
  const planStart = DateTime.fromISO(plan.start_date, { zone }).startOf('day');
  const diffDays = Math.floor(date.startOf('day').diff(planStart, 'days').days);
  if (diffDays < 0) return null;
  const weekNumber = Math.floor(diffDays / 7) + 1;
  if (weekNumber < 1 || weekNumber > Math.max(1, plan.duration_weeks || 1)) return null;
  return weeks.find((week) => week.week_number === weekNumber) ?? null;
}

function summarizeTrainingSessions(sessions: TrainingSession[]): TrainingDaySummary {
  const hardSession = sessions.find(isHardSession);
  const moderateSession = sessions.find(isModerateSession);

  if (hardSession) {
    return {
      load: 'hard',
      reasons: ['A hard training day would compete with your best mental energy, so it is safer not to protect focus here first.'],
      title: hardSession.title || null,
    };
  }

  if (moderateSession) {
    return {
      load: 'moderate',
      reasons: ['Training is planned, but this still looks manageable if you protect a clean block early enough.'],
      title: moderateSession.title || null,
    };
  }

  return {
    load: 'light',
    reasons: ['Only light training is planned, so there is less interference with focused work.'],
    title: sessions[0]?.title || null,
  };
}

function fallbackTrainingSummary(hadTrainingData: boolean): TrainingDaySummary {
  if (hadTrainingData) {
    return {
      load: 'rest',
      reasons: ['There is no hard training planned around this slot, which makes it easier to protect focus.'],
      title: null,
    };
  }
  return {
    load: 'unknown',
    reasons: ['Calendar availability is clear here, even though training data is limited right now.'],
    title: null,
  };
}

function buildTrainingCoordination(
  focusStart: DateTime,
  focusLoad: TrainingLoad,
  trainingSchedule: Map<string, TrainingDaySummary>,
): FocusTrainingCoordination | null {
  const focusDate = focusStart.toISODate()!;
  const focusDay = trainingSchedule.get(focusDate);

  if (focusLoad === 'hard' || focusLoad === 'moderate') {
    return {
      status: 'needs_adjustment',
      sessionDate: focusDate,
      sessionTitle: focusDay?.title ?? null,
      sessionLoad: focusLoad,
    };
  }

  const strongerDay = Array.from(trainingSchedule.entries())
    .filter(([date, summary]) => date !== focusDate && (summary.load === 'hard' || summary.load === 'moderate'))
    .sort((lhs, rhs) => {
      const loadDelta = trainingLoadRank(rhs[1].load) - trainingLoadRank(lhs[1].load);
      if (loadDelta !== 0) return loadDelta;
      const lhsDistance = Math.abs(DateTime.fromISO(lhs[0]).diff(focusStart.startOf('day'), 'days').days);
      const rhsDistance = Math.abs(DateTime.fromISO(rhs[0]).diff(focusStart.startOf('day'), 'days').days);
      return lhsDistance - rhsDistance;
    })[0];

  if (!strongerDay) return null;

  return {
    status: 'already_protected',
    sessionDate: strongerDay[0],
    sessionTitle: strongerDay[1].title,
    sessionLoad: strongerDay[1].load,
  };
}

function isHardSession(session: TrainingSession): boolean {
  const blob = `${session.session_type} ${session.title} ${session.intensity_text ?? ''} ${session.description ?? ''}`.toLowerCase();
  return /\b(interval|vo2|threshold|tempo|race|long ride|long run|heavy|max|squat|deadlift|track|ftp)\b/.test(blob);
}

function isModerateSession(session: TrainingSession): boolean {
  const blob = `${session.session_type} ${session.title} ${session.intensity_text ?? ''} ${session.description ?? ''}`.toLowerCase();
  return /\b(run|ride|swim|gym|strength|endurance|cycling|running|muscula|corrida|pedal|natação|natacao)\b/.test(blob);
}

function trainingLoadRank(load: TrainingLoad): number {
  switch (load) {
    case 'hard': return 4;
    case 'moderate': return 3;
    case 'light': return 2;
    case 'rest': return 1;
    default: return 0;
  }
}

function eventsForDate(events: UnifiedCalendarEvent[], isoDate: string, zone: string): UnifiedCalendarEvent[] {
  return events.filter((event) => {
    const localDay = DateTime.fromISO(event.start, { zone: 'utc' }).setZone(zone).toISODate();
    return localDay === isoDate;
  });
}

function summarizeCalendarLoad(events: UnifiedCalendarEvent[]): { load: CalendarLoad; reasons: string[] } {
  const dayEvents = events.filter((event) =>
    !looksLikeTrainingEvent(event.summary || '') && !looksLikeFocusProtectionEvent(event.summary || '')
  );
  if (dayEvents.length === 0) {
    return {
      load: 'light',
      reasons: ['Your calendar is clear enough to protect a focused block without collisions.'],
    };
  }

  const totalHours = dayEvents.reduce((sum, event) => {
    const start = DateTime.fromISO(event.start, { zone: 'utc' });
    const end = DateTime.fromISO(event.end, { zone: 'utc' });
    return sum + Math.max(0, end.diff(start, 'hours').hours);
  }, 0);

  if (dayEvents.length >= 4 || totalHours >= 5) {
    return {
      load: 'busy',
      reasons: ['This day is already fragmented by meetings, so protecting deep work is harder here.'],
    };
  }

  if (dayEvents.length >= 2 || totalHours >= 2.5) {
    return {
      load: 'moderate',
      reasons: ['You have a few calendar commitments, but this block still stays relatively clean.'],
    };
  }

  return {
    load: 'light',
    reasons: ['The calendar is light enough that this block should stay protected once you add it.'],
  };
}

function enumerateCandidateWindows(
  day: DateTime,
  events: UnifiedCalendarEvent[],
  durationMinutes: number,
  now: DateTime,
  zone: string,
): Array<{ start: DateTime; end: DateTime }> {
  const dayStart = day.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  const dayEnd = day.set({ hour: 18, minute: 30, second: 0, millisecond: 0 });

  const busyWindows = events
    .filter((event) => !looksLikeTrainingEvent(event.summary || ''))
    .map((event) => ({
      start: DateTime.fromISO(event.start, { zone: 'utc' }).setZone(zone),
      end: DateTime.fromISO(event.end, { zone: 'utc' }).setZone(zone),
    }))
    .filter((window) => window.end > dayStart && window.start < dayEnd)
    .sort((lhs, rhs) => lhs.start.toMillis() - rhs.start.toMillis());

  const candidates: Array<{ start: DateTime; end: DateTime }> = [];
  let cursor = dayStart;

  if (day.hasSame(now, 'day')) {
    cursor = cursor < now.plus({ minutes: 15 }) ? roundUpToThirtyMinutes(now.plus({ minutes: 15 })) : cursor;
  }

  for (const busy of busyWindows) {
    const gapEnd = busy.start < dayEnd ? busy.start : dayEnd;
    candidates.push(...windowsWithinGap(cursor, gapEnd, durationMinutes));
    if (busy.end > cursor) cursor = roundUpToThirtyMinutes(busy.end);
    if (cursor >= dayEnd) break;
  }

  if (cursor < dayEnd) {
    candidates.push(...windowsWithinGap(cursor, dayEnd, durationMinutes));
  }

  return candidates;
}

function windowsWithinGap(
  gapStart: DateTime,
  gapEnd: DateTime,
  durationMinutes: number,
): Array<{ start: DateTime; end: DateTime }> {
  const windows: Array<{ start: DateTime; end: DateTime }> = [];
  let start = roundUpToThirtyMinutes(gapStart);

  while (start.plus({ minutes: durationMinutes }) <= gapEnd) {
    windows.push({
      start,
      end: start.plus({ minutes: durationMinutes }),
    });
    start = start.plus({ minutes: 30 });
  }

  return windows;
}

function roundUpToThirtyMinutes(date: DateTime): DateTime {
  const minute = date.minute;
  const roundedMinutes = minute === 0 ? 0 : Math.ceil(minute / 30) * 30;
  const withZeroSeconds = date.set({ second: 0, millisecond: 0 });
  if (roundedMinutes >= 60) {
    return withZeroSeconds.plus({ hours: 1 }).set({ minute: 0 });
  }
  return withZeroSeconds.set({ minute: roundedMinutes });
}

function classifyFocusWindow(date: DateTime): FocusBlockRecommendation['focusWindow'] {
  if (date.hour < 10) return 'peak';
  if (date.hour < 12) return 'late_morning';
  if (date.hour < 15) return 'midday';
  return 'afternoon';
}

function scoreWindow(opts: {
  windowStart: DateTime;
  offset: number;
  focusWindow: FocusBlockRecommendation['focusWindow'];
  readinessScore: number | null;
  trainingLoad: TrainingLoad;
  calendarLoad: CalendarLoad;
  trainingContextFlags: {
    lowSleep: boolean;
    lowHrv: boolean;
    lowReadiness: boolean;
    highLegLoad: boolean;
  };
  hasTrainingAdjacency: boolean;
}): number {
  let score = 0;

  switch (opts.focusWindow) {
    case 'peak': score += 38; break;
    case 'late_morning': score += 28; break;
    case 'midday': score += 16; break;
    case 'afternoon': score += 6; break;
  }

  switch (opts.trainingLoad) {
    case 'rest': score += 18; break;
    case 'light': score += 10; break;
    case 'moderate': score -= 4; break;
    case 'hard': score -= 18; break;
    case 'unknown': score += 2; break;
  }

  switch (opts.calendarLoad) {
    case 'light': score += 14; break;
    case 'moderate': score += 4; break;
    case 'busy': score -= 16; break;
    case 'unknown': break;
  }

  if (opts.offset === 0 && opts.readinessScore != null) {
    if (opts.readinessScore >= 75) score += 20;
    else if (opts.readinessScore >= 65) score += 12;
    else if (opts.readinessScore >= 55) score += 5;
    else score -= 24;
  }

  if (opts.offset === 0 && (opts.trainingContextFlags.lowSleep || opts.trainingContextFlags.lowHrv || opts.trainingContextFlags.lowReadiness)) {
    score -= 12;
  } else if (opts.offset === 1 && (opts.trainingContextFlags.lowSleep || opts.trainingContextFlags.lowHrv || opts.trainingContextFlags.lowReadiness)) {
    score -= 3;
  }

  if (opts.offset === 0 && opts.trainingContextFlags.highLegLoad) {
    score -= 8;
  }

  if (opts.hasTrainingAdjacency) {
    score -= 10;
  }

  return score;
}

function readinessReasons(
  offset: number,
  readinessScore: number | null,
  flags: {
    lowSleep: boolean;
    lowHrv: boolean;
    lowReadiness: boolean;
    highLegLoad: boolean;
  },
): string[] {
  const reasons: string[] = [];

  if (offset === 0 && readinessScore != null) {
    if (readinessScore >= 75) {
      reasons.push(`Today's readiness is strong at ${readinessScore}/100, which makes this a good day to protect high-focus work.`);
    } else if (readinessScore < 55) {
      reasons.push(`Today's readiness is only ${readinessScore}/100, so later or lighter days are safer for real deep work.`);
    }
  }

  if (offset === 0 && (flags.lowSleep || flags.lowHrv || flags.lowReadiness)) {
    reasons.push('Recent recovery signals suggest being selective about which hours you protect today.');
  } else if (offset === 1 && (flags.lowSleep || flags.lowHrv || flags.lowReadiness)) {
    reasons.push('Waiting one more day gives the current recovery dip a better chance to settle.');
  }

  if (offset === 0 && flags.highLegLoad) {
    reasons.push('Recent high leg load suggests keeping today cleaner rather than stacking too much cognitive work around training.');
  }

  return reasons;
}

function timeWindowReasons(window: FocusBlockRecommendation['focusWindow']): string[] {
  switch (window) {
    case 'peak':
      return ['This sits inside your clearest morning hours, so it is the strongest slot to protect.'];
    case 'late_morning':
      return ['Late morning still preserves a strong focus window without pushing too far into the day.'];
    case 'midday':
      return ['This is the cleanest midday slot available once the morning is already occupied.'];
    case 'afternoon':
      return ['This is the best open slot left after higher-energy hours are already spoken for.'];
  }
}

function hasTrainingAdjacency(
  start: DateTime,
  end: DateTime,
  dayEvents: UnifiedCalendarEvent[],
  scheduledTraining: Array<{ payload?: Record<string, unknown> }>,
  zone: string,
): boolean {
  const windows: Array<{ start: DateTime; end: DateTime }> = [];

  for (const signal of scheduledTraining) {
    const rawStart = typeof signal.payload?.start === 'string' ? signal.payload.start : null;
    const rawEnd = typeof signal.payload?.end === 'string' ? signal.payload.end : null;
    if (!rawStart || !rawEnd) continue;
    windows.push({
      start: DateTime.fromISO(rawStart, { zone: 'utc' }).setZone(zone),
      end: DateTime.fromISO(rawEnd, { zone: 'utc' }).setZone(zone),
    });
  }

  for (const event of dayEvents) {
    if (!looksLikeTrainingEvent(event.summary || '')) continue;
    windows.push({
      start: DateTime.fromISO(event.start, { zone: 'utc' }).setZone(zone),
      end: DateTime.fromISO(event.end, { zone: 'utc' }).setZone(zone),
    });
  }

  const paddedStart = start.minus({ minutes: 90 });
  const paddedEnd = end.plus({ minutes: 90 });

  return windows.some((window) => window.end > paddedStart && window.start < paddedEnd);
}

function looksLikeTrainingEvent(summary: string): boolean {
  return /\b(workout|training|run|ride|swim|strength|gym|interval|tempo|recovery|corrida|treino|pedal|natação|natacao|musculação|musculacao)\b/i.test(summary);
}

function looksLikeFocusProtectionEvent(summary: string): boolean {
  return /\b(focus time|focus block|deep work|protected focus|focus work|no meetings|do not disturb|tempo de foco|bloco de foco|trabalho profundo)\b/i.test(summary);
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
