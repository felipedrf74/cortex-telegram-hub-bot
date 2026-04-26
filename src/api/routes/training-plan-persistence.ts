// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as trainingPlans from '../../services/training-plans';
import {
  buildRichSessionDescription,
  type AthleteProfiles,
  type SessionDescriptionInput,
} from '../../services/training-session-description';
import { logger } from '../../utils/logger';
import {
  preferredTimeForSessionType,
  scheduleSessionWindow,
  type BusyWindow,
} from './training-schedule-utils';
import { createTrainingCalendarEvent } from './training-calendar-event-writer';

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
};

export interface PersistGeneratedTrainingPlanInput {
  userId: number;
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
}

export interface PersistGeneratedTrainingPlanResult {
  planId: number;
  totalSessions: number;
  eventsCreated: number;
  weekSummaries: Array<{
    weekNumber: number | undefined;
    focus: string | undefined;
    sessionCount: number;
  }>;
}

export async function persistGeneratedTrainingPlan(
  input: PersistGeneratedTrainingPlanInput,
): Promise<PersistGeneratedTrainingPlanResult> {
  const plan = trainingPlans.createPlan({
    user_id: input.userId,
    name: input.planData.planName || `${input.objective} Plan`,
    sport: input.planData.sport || 'hybrid',
    goal: input.objective,
    duration_weeks: input.durationWeeks,
    periodization: input.planData.periodization || 'undulating',
    start_date: input.startDate,
    end_date: input.endDate,
    preferences_json: input.preferencesJson,
  });

  let totalSessions = 0;
  const calendarEvents: Array<{
    sessionId: number;
    title: string;
    start: string;
    end: string;
    description: string;
  }> = [];
  const scheduledWindows: BusyWindow[] = [];

  for (const weekData of input.planData.weeks || []) {
    const week = trainingPlans.createWeek({
      plan_id: plan.id,
      week_number: weekData.weekNumber || 1,
      focus: weekData.focus || 'base',
      intensity_pct: weekData.intensityPct || 70,
      volume_sessions: weekData.sessions?.length || 0,
    });

    for (const sessionData of weekData.sessions || []) {
      if (sessionData.sessionType === 'rest') continue;

      const dayIndex = DAY_NAMES.indexOf(sessionData.dayOfWeek?.toLowerCase() || '');
      if (dayIndex < 0) continue;

      const durationMinutes = sessionData.durationMinutes || 60;
      const scheduledWindow = scheduleSessionForPlan({
        weekNumber: weekData.weekNumber || 1,
        dayIndex,
        now: input.now,
        durationMinutes,
        sessionType: sessionData.sessionType || '',
        preferredStartTime: sessionData.preferredStartTime,
        normalizedPreferredTime: input.normalizedPreferredTime,
        normalizedPreferredCardioTime: input.normalizedPreferredCardioTime,
        normalizedPreferredStrengthTime: input.normalizedPreferredStrengthTime,
        busyWindows: input.busyWindows,
        scheduledWindows,
        title: sessionData.title || 'Training session',
      });

      const richDescription = buildRichSessionDescription(
        buildSessionDescriptionInput({
          input,
          weekData,
          sessionData,
          durationMinutes,
        }),
      );

      const session = trainingPlans.createSession({
        week_id: week.id,
        plan_id: plan.id,
        day_of_week: sessionData.dayOfWeek || '',
        session_type: sessionData.sessionType || 'training',
        title: sessionData.title || 'Training session',
        description: richDescription.text,
        description_json: JSON.stringify(richDescription.sections),
        exercises_json: JSON.stringify(sessionData.exercises || []),
        duration_minutes: durationMinutes,
        intensity_text: `RPE ${weekData.intensityPct || 70}%`,
      });

      calendarEvents.push({
        sessionId: session.id,
        title: `${emojiForTrainingSession(sessionData.sessionType)} ${sessionData.title || 'Training session'} (${durationMinutes}min)`,
        start: scheduledWindow.start.toISOString(),
        end: scheduledWindow.end.toISOString(),
        description: richDescription.text,
      });

      totalSessions++;
    }
  }

  let eventsCreated = 0;
  for (const eventPayload of calendarEvents) {
    try {
      const event = await createTrainingCalendarEvent(
        {
          title: eventPayload.title,
          start: eventPayload.start,
          end: eventPayload.end,
          description: eventPayload.description,
        },
        undefined,
        input.userId,
        {
          userId: input.userId,
          sessionId: eventPayload.sessionId,
          title: eventPayload.title,
        },
      );
      trainingPlans.linkSessionToCalendar(eventPayload.sessionId, event.id, event.source);
      eventsCreated++;
    } catch (err) {
      logger.warn({ err, title: eventPayload.title }, 'Failed to create calendar event for session');
    }
  }

  return {
    planId: plan.id,
    totalSessions,
    eventsCreated,
    weekSummaries: (input.planData.weeks || []).map((weekData) => ({
      weekNumber: weekData.weekNumber,
      focus: weekData.focus,
      sessionCount: weekData.sessions?.filter((session) => session.sessionType !== 'rest').length || 0,
    })),
  };
}

function scheduleSessionForPlan(input: {
  weekNumber: number;
  dayIndex: number;
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
}): { start: Date; end: Date } {
  const weekStart = new Date(input.now);
  weekStart.setDate(weekStart.getDate() + ((input.weekNumber - 1) * 7));

  const currentDay = weekStart.getDay();
  const targetDay = input.dayIndex + 1;
  let daysUntil = targetDay - currentDay;
  if (daysUntil < 0) daysUntil += 7;

  const sessionDate = new Date(weekStart);
  sessionDate.setDate(sessionDate.getDate() + daysUntil);

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
  );

  input.scheduledWindows.push({
    startMs: scheduledWindow.start.getTime(),
    endMs: scheduledWindow.end.getTime(),
    title: input.title,
  });

  return scheduledWindow;
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
