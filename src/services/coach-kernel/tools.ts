// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  AthleteState,
  ComplianceEvent,
  DailyRecommendation,
  ParsedFitFile,
  ParsedGpxFile,
  RaceEvent,
  RecentSession,
  Session,
  WeeklyPlan,
  ZoneSet,
} from './types';
import { loadCoachKnowledge } from './knowledge-loader';
import { buildDayPlan, buildWeekPlan, adjustForFatigue, progressStrengthBlock, replaceSession, resolveScheduleConflicts } from './planner-engine';
import { durationToLoad } from './utils';
import { isActiveTrainingSession } from './capacity-reconciliation';
import { runningEngine } from './engines/running-engine';
import { cyclingEngine } from './engines/cycling-engine';
import { swimmingEngine } from './engines/swimming-engine';
import { strengthEngine } from './engines/strength-engine';
import { InMemoryCoachPlanStore, type CoachPlanStore } from './stores/in-memory-plan-store';
import { requireTenantIdParam } from '../tenant-scope';

export const defaultCoachPlanStore = new InMemoryCoachPlanStore();

export function getAthleteProfile(state: AthleteState): AthleteState['profile'] {
  return state.profile;
}

export function getRecentSessions(state: AthleteState): RecentSession[] {
  return state.recentSessions;
}

export function getGoalStack(state: AthleteState): AthleteState['goals'] {
  return state.goals;
}

export function getReadinessSnapshot(state: AthleteState): AthleteState['readiness'] {
  return state.readiness;
}

export function calculateZones(state: AthleteState): ZoneSet {
  const runningThreshold = state.profile.thresholdPaceSecondsPerKm ?? 300;
  const swimCss = state.profile.swimCssSecondsPer100m ?? 110;
  const ftp = state.profile.cyclingFtpWatts ?? 220;
  const thresholdHeartRate = state.profile.thresholdHeartRate ?? Math.round((state.profile.maxHeartRate ?? 185) * 0.88);

  return {
    runningPaceSecondsPerKm: {
      recovery: { min: Math.round(runningThreshold * 1.25), max: Math.round(runningThreshold * 1.35) },
      aerobic: { min: Math.round(runningThreshold * 1.14), max: Math.round(runningThreshold * 1.24) },
      tempo: { min: Math.round(runningThreshold * 1.04), max: Math.round(runningThreshold * 1.12) },
      threshold: { min: Math.round(runningThreshold * 0.98), max: Math.round(runningThreshold * 1.03) },
      vo2: { min: Math.round(runningThreshold * 0.92), max: Math.round(runningThreshold * 0.97) },
      neuromuscular: { min: Math.round(runningThreshold * 0.8), max: Math.round(runningThreshold * 0.91) },
    },
    bikePowerWatts: {
      recovery: { min: Math.round(ftp * 0.4), max: Math.round(ftp * 0.55) },
      aerobic: { min: Math.round(ftp * 0.56), max: Math.round(ftp * 0.75) },
      tempo: { min: Math.round(ftp * 0.76), max: Math.round(ftp * 0.87) },
      threshold: { min: Math.round(ftp * 0.88), max: Math.round(ftp * 1.0) },
      vo2: { min: Math.round(ftp * 1.01), max: Math.round(ftp * 1.15) },
      neuromuscular: { min: Math.round(ftp * 1.16), max: Math.round(ftp * 1.5) },
    },
    swimPaceSecondsPer100m: {
      recovery: { min: Math.round(swimCss * 1.18), max: Math.round(swimCss * 1.3) },
      aerobic: { min: Math.round(swimCss * 1.1), max: Math.round(swimCss * 1.17) },
      tempo: { min: Math.round(swimCss * 1.04), max: Math.round(swimCss * 1.09) },
      threshold: { min: Math.round(swimCss * 0.99), max: Math.round(swimCss * 1.03) },
      vo2: { min: Math.round(swimCss * 0.94), max: Math.round(swimCss * 0.98) },
      neuromuscular: { min: Math.round(swimCss * 0.88), max: Math.round(swimCss * 0.93) },
    },
    heartRateBpm: {
      recovery: { min: Math.round(thresholdHeartRate * 0.65), max: Math.round(thresholdHeartRate * 0.77) },
      aerobic: { min: Math.round(thresholdHeartRate * 0.78), max: Math.round(thresholdHeartRate * 0.86) },
      tempo: { min: Math.round(thresholdHeartRate * 0.87), max: Math.round(thresholdHeartRate * 0.92) },
      threshold: { min: Math.round(thresholdHeartRate * 0.93), max: thresholdHeartRate },
      vo2: { min: thresholdHeartRate + 1, max: Math.round(thresholdHeartRate * 1.08) },
      neuromuscular: { min: Math.round(thresholdHeartRate * 1.08), max: Math.round(thresholdHeartRate * 1.14) },
    },
  };
}

export function computeTrainingLoad(sessions: Session[]): { totalLoad: number; bySport: Record<string, number> } {
  return sessions.reduce<{ totalLoad: number; bySport: Record<string, number> }>((acc, session) => {
    const load = durationToLoad(session.durationMinutes, session.intensityZone, session.fatigueCost);
    acc.totalLoad += load;
    acc.bySport[session.sport] = (acc.bySport[session.sport] ?? 0) + load;
    return acc;
  }, { totalLoad: 0, bySport: {} });
}

export function selectRunWorkout(state: AthleteState, weekStart: string): Session {
  return runningEngine.buildCandidateSessions({ athlete: state, phase: state.currentBlock.phase, knowledge: loadCoachKnowledge(), weekStart })[0];
}

export function selectBikeWorkout(state: AthleteState, weekStart: string): Session {
  return cyclingEngine.buildCandidateSessions({ athlete: state, phase: state.currentBlock.phase, knowledge: loadCoachKnowledge(), weekStart })[0];
}

export function selectSwimWorkout(state: AthleteState, weekStart: string): Session {
  return swimmingEngine.buildCandidateSessions({ athlete: state, phase: state.currentBlock.phase, knowledge: loadCoachKnowledge(), weekStart })[0];
}

export function selectStrengthWorkout(state: AthleteState, weekStart: string): Session {
  return strengthEngine.buildCandidateSessions({ athlete: state, phase: state.currentBlock.phase, knowledge: loadCoachKnowledge(), weekStart })[0];
}

export function buildWeekPlanTool(state: AthleteState, weekStart: string): WeeklyPlan {
  return buildWeekPlan(state, weekStart);
}

export function buildDayPlanTool(state: AthleteState, weeklyPlan: WeeklyPlan, dayOfWeek: Session['dayOfWeek']): DailyRecommendation {
  return buildDayPlan(state, weeklyPlan, dayOfWeek);
}

export function adjustForFatigueTool(state: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  return adjustForFatigue(state, weeklyPlan);
}

export function replaceSessionTool(weeklyPlan: WeeklyPlan, sessionId: string, replacement: Session): WeeklyPlan {
  return replaceSession(weeklyPlan, sessionId, replacement);
}

export function resolveScheduleConflictsTool(state: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  return resolveScheduleConflicts(state, weeklyPlan);
}

export function progressStrengthBlockTool(state: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  return progressStrengthBlock(state, weeklyPlan);
}

export function parseFitFile(buffer: Buffer): ParsedFitFile {
  const headerSize = buffer.readUInt8(0);
  const protocolVersion = buffer.readUInt8(1);
  const profileVersion = buffer.readUInt16LE(2);
  const dataSize = buffer.readUInt32LE(4);
  const signature = buffer.subarray(8, 12).toString('ascii');
  if (signature !== '.FIT') throw new Error('Invalid FIT file signature');
  return { fileType: 'fit', headerSize, protocolVersion, profileVersion, dataSize, signature };
}

export function parseGpxFile(xml: string): ParsedGpxFile {
  const trackPointCount = (xml.match(/<trkpt\b/g) ?? []).length;
  const times = [...xml.matchAll(/<time>([^<]+)<\/time>/g)].map((match) => match[1]);
  const startTime = times[0];
  const endTime = times[times.length - 1];
  const totalSeconds = startTime && endTime
    ? Math.max(0, Math.round((Date.parse(endTime) - Date.parse(startTime)) / 1000))
    : undefined;
  return { fileType: 'gpx', trackPointCount, startTime, endTime, totalSeconds };
}

export function logSessionFeedback(state: AthleteState, event: ComplianceEvent): AthleteState {
  const existingSession = state.recentSessions.find((session) => session.id === event.sessionId);
  const nextRecent = existingSession
    ? state.recentSessions.map((session) =>
        session.id === event.sessionId
          ? { ...session, completed: event.status === 'completed', missedReason: event.reason }
          : session
      )
    : state.recentSessions;
  return { ...state, recentSessions: nextRecent };
}

export function scoreCompliance(weeklyPlan: WeeklyPlan, recentSessions: RecentSession[]): AthleteState['compliance'] {
  const plannedIds = new Set(weeklyPlan.sessions.map((session) => session.id));
  const completed = recentSessions.filter((session) => plannedIds.has(session.id) && session.completed);
  const keyMisses = recentSessions.filter((session) => plannedIds.has(session.id) && !session.completed && session.keySession).length;
  const ratio = weeklyPlan.sessions.length > 0 ? completed.length / weeklyPlan.sessions.length : 1;
  return {
    trailing14DayCompliance: ratio,
    bySport: completed.reduce<Record<string, number>>((acc, session) => {
      acc[session.sport] = (acc[session.sport] ?? 0) + 1;
      return acc;
    }, {}),
    missedKeySessions: keyMisses,
    consecutiveMisses: recentSessions.slice(-3).filter((session) => !session.completed).length,
  };
}

export function savePlan(
  plan: WeeklyPlan,
  athleteState: AthleteState,
  tenantId: number,
  store: CoachPlanStore = defaultCoachPlanStore,
): WeeklyPlan {
  const scopedTenantId = requireTenantIdParam(tenantId, 'coachKernel.savePlan');
  return store.save({ tenantId: scopedTenantId, plan, athleteState }).plan;
}

export function generateDailyBrief(state: AthleteState, weeklyPlan: WeeklyPlan, dayOfWeek: Session['dayOfWeek']): string {
  const daily = buildDayPlanTool(state, weeklyPlan, dayOfWeek);
  if (!daily.session) {
    return `No primary training is scheduled for ${dayOfWeek}. Keep recovery high and stay available for a replacement if readiness improves.`;
  }

  return [
    `${daily.session.title} at ${daily.session.startTime ?? 'your next available window'}.`,
    `Keep the session ${daily.session.intensityZone} and respect the current readiness state (${daily.readinessLevel}).`,
    ...daily.guardrailResults.map((result) => result.message),
  ].join(' ');
}

export function syncCalendar(plan: WeeklyPlan): Array<{ title: string; start: string; end: string; sport: string }> {
  return plan.sessions
    .filter((session) => isActiveTrainingSession(session) && session.startTime && session.endTime)
    .map((session) => ({
      title: session.title,
      start: `${plan.weekStart}:${session.dayOfWeek}:${session.startTime}`,
      end: `${plan.weekStart}:${session.dayOfWeek}:${session.endTime}`,
      sport: session.sport,
    }));
}

export function listRaceEvents(state: AthleteState): RaceEvent[] {
  return state.goals.raceCalendar;
}
