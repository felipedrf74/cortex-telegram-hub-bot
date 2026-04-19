// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, AvailabilityWindow } from '../types';

const standardWindows: AvailabilityWindow[] = [
  { dayOfWeek: 'monday', start: '06:30', end: '08:00', sports: ['running', 'cycling', 'swimming', 'strength'] },
  { dayOfWeek: 'tuesday', start: '06:30', end: '08:00', sports: ['running', 'cycling', 'swimming'] },
  { dayOfWeek: 'wednesday', start: '12:00', end: '13:30', sports: ['cycling', 'strength'] },
  { dayOfWeek: 'thursday', start: '06:30', end: '08:00', sports: ['running', 'swimming'] },
  { dayOfWeek: 'friday', start: '12:00', end: '13:30', sports: ['strength', 'swimming'] },
  { dayOfWeek: 'saturday', start: '08:00', end: '11:00', sports: ['running', 'cycling', 'swimming'] },
  { dayOfWeek: 'sunday', start: '08:00', end: '11:00', sports: ['running', 'cycling'] },
];

export const sampleMarathonAthlete: AthleteState = {
  profile: {
    athleteId: 101,
    name: 'Marathon Runner',
    experienceLevel: 'intermediate',
    primaryDiscipline: 'marathon',
    thresholdPaceSecondsPerKm: 290,
    thresholdHeartRate: 172,
    maxHeartRate: 192,
  },
  goals: {
    primaryFocus: 'marathon',
    secondaryFocus: 'strength',
    strengthGoal: 'maintenance',
    raceCalendar: [{ id: 'race-berlin', name: 'Berlin Marathon', discipline: 'running', subtype: 'marathon', date: '2026-09-20', priority: 'a' }],
    priorityOrder: ['running', 'strength'],
    weeklySessionsTarget: { running: 6, strength: 4 },
    weeklyMinutesTarget: { running: 360, strength: 150 },
  },
  constraints: [{ id: 'c1', type: 'time', severity: 'medium', description: 'Lunch is the only reliable gym window.', sport: 'strength' }],
  availability: {
    weeklyWindows: standardWindows.map((window) => ({ ...window })),
    preferredLongSessionDay: 'sunday',
    preferredTimesBySport: { running: '06:30', strength: '12:00' },
    maxSessionsPerDay: 2,
  },
  equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, hasBikeTrainer: false, hasPool: false, hasTrack: true },
  trainingHistory: { lastWeekMinutesBySport: { running: 320, strength: 140 }, trailing4WeekMinutesBySport: { running: [280, 300, 310, 320], strength: [120, 130, 140, 140] } },
  currentBlock: { discipline: 'marathon', phase: 'build', weekIndex: 5, totalWeeks: 16, volumeProgressionPct: 8, lastDeloadWeekIndex: 4 },
  recentSessions: [],
  readiness: { capturedAt: new Date().toISOString(), level: 'yellow', score: 68, sleepHours: 7.2, energyReserve: 64, soreness: 'moderate', painFlags: [] },
  compliance: { trailing14DayCompliance: 0.83, bySport: { running: 0.86, strength: 0.75 }, missedKeySessions: 0, consecutiveMisses: 0 },
};

export const sampleTriathlete: AthleteState = {
  ...sampleMarathonAthlete,
  profile: {
    athleteId: 202,
    name: 'Triathlete',
    experienceLevel: 'advanced',
    primaryDiscipline: 'triathlon',
    thresholdPaceSecondsPerKm: 280,
    cyclingFtpWatts: 265,
    swimCssSecondsPer100m: 104,
    thresholdHeartRate: 168,
    maxHeartRate: 188,
  },
  goals: {
    primaryFocus: 'triathlon',
    secondaryFocus: 'strength',
    strengthGoal: 'maintenance',
    raceCalendar: [{ id: '70.3-cascais', name: 'Cascais 70.3', discipline: 'triathlon', subtype: '70.3', date: '2026-07-12', priority: 'a' }],
    priorityOrder: ['running', 'cycling', 'swimming', 'strength'],
    weeklySessionsTarget: { running: 4, cycling: 3, swimming: 3, strength: 2 },
  },
  equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, hasBikeTrainer: true, hasPool: true, hasTrack: true },
  trainingHistory: { lastWeekMinutesBySport: { running: 210, cycling: 180, swimming: 120, strength: 90 }, trailing4WeekMinutesBySport: { running: [180, 190, 200, 210], cycling: [150, 160, 170, 180], swimming: [90, 100, 110, 120], strength: [80, 85, 85, 90] } },
  currentBlock: { discipline: 'triathlon', phase: 'build', weekIndex: 7, totalWeeks: 18, volumeProgressionPct: 7, lastDeloadWeekIndex: 4 },
  readiness: { capturedAt: new Date().toISOString(), level: 'green', score: 81, sleepHours: 8.0, energyReserve: 80, soreness: 'low', painFlags: [] },
};

export const sampleHybridAthlete: AthleteState = {
  ...sampleMarathonAthlete,
  profile: {
    athleteId: 303,
    name: 'Hybrid Athlete',
    experienceLevel: 'intermediate',
    primaryDiscipline: 'hybrid',
    thresholdPaceSecondsPerKm: 300,
    thresholdHeartRate: 170,
    maxHeartRate: 190,
  },
  goals: {
    primaryFocus: 'hybrid',
    secondaryFocus: 'strength',
    strengthGoal: 'hypertrophy',
    raceCalendar: [],
    priorityOrder: ['strength', 'running'],
    weeklySessionsTarget: { running: 4, strength: 4 },
  },
  currentBlock: { discipline: 'hybrid', phase: 'base', weekIndex: 2, totalWeeks: 12, volumeProgressionPct: 6 },
  readiness: { capturedAt: new Date().toISOString(), level: 'green', score: 76, sleepHours: 7.8, energyReserve: 72, soreness: 'low', painFlags: [] },
};
