// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  AthleteState,
  AvailabilityWindow,
  DayOfWeek,
  FatigueCost,
  IntensityZone,
  Session,
  Sport,
} from './types';

export const DAY_ORDER: DayOfWeek[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function dayIndex(day: DayOfWeek): number {
  return DAY_ORDER.indexOf(day);
}

export function nextDaysFrom(day: DayOfWeek): DayOfWeek[] {
  const start = dayIndex(day);
  return DAY_ORDER.map((_, offset) => DAY_ORDER[(start + offset) % DAY_ORDER.length]);
}

export function durationToLoad(
  durationMinutes: number,
  intensityZone: IntensityZone,
  fatigueCost: FatigueCost,
): number {
  const intensityMultiplier: Record<IntensityZone, number> = {
    recovery: 0.6,
    aerobic: 1.0,
    tempo: 1.15,
    threshold: 1.3,
    vo2: 1.5,
    neuromuscular: 1.2,
  };
  const fatigueMultiplier: Record<FatigueCost, number> = {
    low: 0.85,
    medium: 1.0,
    high: 1.15,
    very_high: 1.3,
  };

  return Math.round(durationMinutes * intensityMultiplier[intensityZone] * fatigueMultiplier[fatigueCost]);
}

export function sumMinutes(sessions: Session[], sport?: Sport): number {
  return sessions
    .filter((session) => !sport || session.sport === sport)
    .reduce((total, session) => total + session.durationMinutes, 0);
}

export function findWindowsForDay(
  availability: AthleteState['availability'],
  dayOfWeek: DayOfWeek,
  sport?: Sport,
): AvailabilityWindow[] {
  return availability.weeklyWindows
    .filter((window) => window.dayOfWeek === dayOfWeek && (!sport || !window.sports || window.sports.includes(sport)))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function minutesToTime(totalMinutes: number): string {
  const safeMinutes = clamp(totalMinutes, 0, 23 * 60 + 59);
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function resolvePreferredStartTime(
  athlete: AthleteState,
  sport: Sport,
  window: AvailabilityWindow,
): string {
  const preferred = athlete.availability.preferredTimesBySport?.[sport];
  if (!preferred) return window.start;
  const preferredMinutes = timeToMinutes(preferred);
  const windowStart = timeToMinutes(window.start);
  const windowEnd = timeToMinutes(window.end);
  return preferredMinutes >= windowStart && preferredMinutes <= windowEnd ? preferred : window.start;
}

export function withDuration(startTime: string, durationMinutes: number): string {
  return minutesToTime(timeToMinutes(startTime) + durationMinutes);
}

export function createSessionId(prefix: string, dayOfWeek: DayOfWeek, title: string): string {
  return `${prefix}_${dayOfWeek}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

export function isKeyEnduranceSession(session: Session): boolean {
  return session.keySession && (session.sport === 'running' || session.sport === 'cycling' || session.sport === 'swimming');
}

export function isLowerBodyStrength(session: Session): boolean {
  if (session.sport !== 'strength') return false;
  return session.tags.includes('lower_body') || session.tags.includes('full_body');
}

export function cloneSessions<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

