// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, Session, Sport, WeeklyPlan } from './types';

const AUTO_NOTE_PREFIXES = [
  'Weekly structure:',
  'Readiness decision:',
  'Adherence decision:',
  'Plan adjustment:',
];

export function dedupeDecisionLines(lines: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = decisionLineKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

export function buildWeeklyDecisionNotes(plan: WeeklyPlan, athlete: AthleteState): string[] {
  const activeSessions = plan.sessions.filter((session) => session.sessionType !== 'rest' && session.durationMinutes > 0);
  const trainingDays = new Set(activeSessions.map((session) => session.dayOfWeek)).size;
  const totalMinutes = activeSessions.reduce((sum, session) => sum + session.durationMinutes, 0);
  const sportBreakdown = formatSportBreakdown(activeSessions);
  const readinessAction = readinessActionFor(athlete);
  const staleAutoNotesRemoved = plan.notes.filter((note) => !isAutoDecisionNote(note));

  return dedupeDecisionLines([
    `Weekly structure: ${activeSessions.length} sessions across ${trainingDays} training day${trainingDays === 1 ? '' : 's'} (${sportBreakdown}, ${totalMinutes} min total) for ${plan.discipline} focus in ${plan.phase} phase.`,
    `Readiness decision: ${athlete.readiness.level}/${athlete.readiness.score} ${readinessAction}.`,
    adherenceDecisionNote(athlete),
    ...decisionReasonNotes(plan),
    ...staleAutoNotesRemoved,
  ]);
}

function adherenceDecisionNote(athlete: AthleteState): string {
  const compliancePct = Math.round(athlete.compliance.trailing14DayCompliance * 100);
  const misses = athlete.compliance.consecutiveMisses;
  if (compliancePct <= 0) {
    if (misses > 0) {
      return `Adherence decision: reset week after ${misses} consecutive miss${misses === 1 ? '' : 'es'} — restart with one short, safe session instead of chasing missed volume.`;
    }
    return 'Adherence decision: fresh tracking week — use the next short session to establish the baseline.';
  }
  return `Adherence decision: ${compliancePct}% trailing 14-day compliance with ${misses} consecutive miss${misses === 1 ? '' : 'es'}.`;
}

function decisionReasonNotes(plan: WeeklyPlan): string[] {
  return (plan.decisionReasons ?? [])
    .filter((reason) => reason.severity !== 'info')
    .map((reason) => `Plan adjustment: ${reason.text}`);
}

function decisionLineKey(value: string): string {
  return value
    .replace(/^✳\s*/u, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.!]+$/u, '')
    .trim()
    .toLowerCase();
}

function isAutoDecisionNote(value: string): boolean {
  return AUTO_NOTE_PREFIXES.some((prefix) => value.trim().startsWith(prefix));
}

function formatSportBreakdown(sessions: Session[]): string {
  if (sessions.length === 0) return 'no active sessions';
  const counts = sessions.reduce<Partial<Record<Sport, number>>>((acc, session) => {
    acc[session.sport] = (acc[session.sport] ?? 0) + 1;
    return acc;
  }, {});

  return (Object.entries(counts) as Array<[Sport, number]>)
    .map(([sport, count]) => `${count} ${sport}`)
    .join(', ');
}

function readinessActionFor(athlete: AthleteState): string {
  switch (athlete.readiness.level) {
    case 'green':
      return 'supports normal progression';
    case 'yellow':
      return 'supports the plan with normal recovery monitoring';
    case 'orange':
      return 'requires density and intensity protection before hard work';
    case 'red':
      return 'requires recovery-first substitutions or a deload';
  }
}
