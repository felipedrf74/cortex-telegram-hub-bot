// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, AvailabilityWindow, DayOfWeek, Sport } from '../types';
import type { TrainingEvalPersona } from './types';

const fixedCapturedAt = '2026-04-27T07:00:00.000Z';

const standardWindows: AvailabilityWindow[] = [
  { dayOfWeek: 'monday', start: '06:30', end: '08:00', sports: ['running', 'cycling', 'strength'] },
  { dayOfWeek: 'tuesday', start: '06:30', end: '08:00', sports: ['running', 'cycling'] },
  { dayOfWeek: 'wednesday', start: '12:00', end: '13:30', sports: ['strength', 'cycling'] },
  { dayOfWeek: 'thursday', start: '06:30', end: '08:00', sports: ['running'] },
  { dayOfWeek: 'friday', start: '12:00', end: '13:30', sports: ['strength'] },
  { dayOfWeek: 'saturday', start: '08:00', end: '11:00', sports: ['running', 'cycling'] },
  { dayOfWeek: 'sunday', start: '08:00', end: '11:00', sports: ['running', 'cycling'] },
];

const gymWindows: AvailabilityWindow[] = [
  { dayOfWeek: 'monday', start: '12:00', end: '13:15', sports: ['strength'] },
  { dayOfWeek: 'wednesday', start: '12:00', end: '13:15', sports: ['strength'] },
  { dayOfWeek: 'friday', start: '12:00', end: '13:15', sports: ['strength'] },
  { dayOfWeek: 'saturday', start: '09:00', end: '10:30', sports: ['strength'] },
];

function windows(days: DayOfWeek[], sport: Sport, start = '06:30', end = '08:00'): AvailabilityWindow[] {
  return days.map((dayOfWeek) => ({ dayOfWeek, start, end, sports: [sport] }));
}

type AthleteOverrides = Omit<
  Partial<AthleteState>,
  'profile' | 'goals' | 'availability' | 'equipment' | 'trainingHistory' | 'currentBlock' | 'readiness' | 'compliance'
> & {
  profile?: Partial<AthleteState['profile']>;
  goals?: Partial<AthleteState['goals']>;
  availability?: Partial<AthleteState['availability']>;
  equipment?: Partial<AthleteState['equipment']>;
  trainingHistory?: Partial<AthleteState['trainingHistory']>;
  currentBlock?: Partial<AthleteState['currentBlock']>;
  readiness?: Partial<AthleteState['readiness']>;
  compliance?: Partial<AthleteState['compliance']>;
};

function baseAthlete(overrides: AthleteOverrides): AthleteState {
  const athlete: AthleteState = {
    profile: {
      athleteId: 9000,
      name: 'Evaluation Athlete',
      experienceLevel: 'intermediate',
      primaryDiscipline: 'hybrid',
      thresholdPaceSecondsPerKm: 300,
      thresholdHeartRate: 170,
      maxHeartRate: 190,
      cyclingFtpWatts: 220,
    },
    goals: {
      primaryFocus: 'hybrid',
      secondaryFocus: 'strength',
      strengthGoal: 'athletic',
      raceCalendar: [],
      priorityOrder: ['strength', 'running'],
      weeklySessionsTarget: { strength: 3, running: 3 },
      weeklyMinutesTarget: { strength: 150, running: 180 },
    },
    constraints: [],
    availability: {
      weeklyWindows: standardWindows.map((window) => ({ ...window })),
      preferredLongSessionDay: 'sunday',
      preferredTimesBySport: { running: '06:30', cycling: '06:30', strength: '12:00' },
      maxSessionsPerDay: 2,
    },
    equipment: {
      hasGym: true,
      hasBarbell: true,
      hasDumbbells: true,
      hasBikeTrainer: true,
      hasPool: false,
      hasTrack: true,
    },
    trainingHistory: {
      lastWeekMinutesBySport: { running: 160, cycling: 120, strength: 120 },
      trailing4WeekMinutesBySport: { running: [130, 145, 155, 160], cycling: [90, 105, 115, 120], strength: [100, 110, 115, 120] },
    },
    currentBlock: { discipline: 'hybrid', phase: 'base', weekIndex: 2, totalWeeks: 12, volumeProgressionPct: 6 },
    recentSessions: [],
    readiness: { capturedAt: fixedCapturedAt, level: 'green', score: 78, sleepHours: 7.5, hrvStatus: 'normal', energyReserve: 74, soreness: 'low', painFlags: [] },
    compliance: { trailing14DayCompliance: 0.82, bySport: { running: 0.84, cycling: 0.8, strength: 0.8 }, missedKeySessions: 0, consecutiveMisses: 0 },
  };

  return {
    ...athlete,
    ...overrides,
    profile: { ...athlete.profile, ...overrides.profile },
    goals: { ...athlete.goals, ...overrides.goals },
    availability: { ...athlete.availability, ...overrides.availability },
    equipment: { ...athlete.equipment, ...overrides.equipment },
    trainingHistory: { ...athlete.trainingHistory, ...overrides.trainingHistory },
    currentBlock: { ...athlete.currentBlock, ...overrides.currentBlock },
    readiness: { ...athlete.readiness, ...overrides.readiness },
    compliance: { ...athlete.compliance, ...overrides.compliance },
  };
}

function persona(input: Omit<TrainingEvalPersona, 'tags'> & { tags?: string[] }): TrainingEvalPersona {
  return { ...input, tags: input.tags ?? [] };
}

export const trainingEvalPersonaBank: TrainingEvalPersona[] = [
  persona({
    id: 'beginner-gym-dumbbells',
    name: 'Beginner Gym User',
    category: 'strength',
    description: 'New lifter with dumbbells and short lunch windows.',
    athlete: baseAthlete({
      profile: { athleteId: 9101, name: 'Beginner Gym', experienceLevel: 'novice', primaryDiscipline: 'strength' },
      goals: { primaryFocus: 'strength', secondaryFocus: undefined, strengthGoal: 'athletic', priorityOrder: ['strength'], weeklySessionsTarget: { strength: 3 }, weeklyMinutesTarget: { strength: 135 } },
      availability: { weeklyWindows: gymWindows.slice(0, 3), preferredTimesBySport: { strength: '12:00' }, maxSessionsPerDay: 1 },
      equipment: { hasGym: false, hasBarbell: false, hasDumbbells: true, hasBikeTrainer: false, hasPool: false, hasTrack: false },
      trainingHistory: { lastWeekMinutesBySport: { strength: 80 }, trailing4WeekMinutesBySport: { strength: [0, 45, 65, 80] } },
    }),
    expectations: { expectedSports: ['strength'], primarySport: 'strength', minTotalSessions: 2, maxTotalSessions: 4, minStrengthSessions: 2, requiredEquipmentAvoidance: ['barbell', 'rack'] },
    tags: ['beginner', 'equipment_limited', 'strength'],
  }),
  persona({
    id: 'intermediate-hypertrophy-full-gym',
    name: 'Intermediate Hypertrophy User',
    category: 'strength',
    description: 'Four-day full-gym hypertrophy plan with enough duration for real work.',
    athlete: baseAthlete({
      profile: { athleteId: 9102, name: 'Hypertrophy Builder', experienceLevel: 'intermediate', primaryDiscipline: 'strength' },
      goals: { primaryFocus: 'strength', secondaryFocus: undefined, strengthGoal: 'hypertrophy', priorityOrder: ['strength'], weeklySessionsTarget: { strength: 4 }, weeklyMinutesTarget: { strength: 220 } },
      availability: { weeklyWindows: gymWindows, preferredTimesBySport: { strength: '12:00' }, maxSessionsPerDay: 1 },
      trainingHistory: { lastWeekMinutesBySport: { strength: 190 }, trailing4WeekMinutesBySport: { strength: [160, 175, 185, 190] } },
    }),
    expectations: { expectedSports: ['strength'], primarySport: 'strength', minTotalSessions: 4, maxTotalSessions: 4, minStrengthSessions: 4 },
    tags: ['hypertrophy', 'full_gym', 'strength'],
  }),
  persona({
    id: 'advanced-strength-focused',
    name: 'Strength-Focused User',
    category: 'strength',
    description: 'Advanced user prioritizing max strength with barbell access.',
    athlete: baseAthlete({
      profile: { athleteId: 9103, name: 'Strength Focus', experienceLevel: 'advanced', primaryDiscipline: 'strength' },
      goals: { primaryFocus: 'strength', strengthGoal: 'max_strength', priorityOrder: ['strength'], weeklySessionsTarget: { strength: 4 }, weeklyMinutesTarget: { strength: 260 } },
      availability: { weeklyWindows: gymWindows.map((window) => ({ ...window, end: '13:45' })), preferredTimesBySport: { strength: '12:00' }, maxSessionsPerDay: 1 },
      trainingHistory: { lastWeekMinutesBySport: { strength: 235 }, trailing4WeekMinutesBySport: { strength: [210, 220, 230, 235] } },
    }),
    expectations: { expectedSports: ['strength'], primarySport: 'strength', minTotalSessions: 4, maxTotalSessions: 4, minStrengthSessions: 4 },
    tags: ['advanced', 'max_strength', 'full_gym'],
  }),
  persona({
    id: 'runner-half-marathon',
    name: 'Runner',
    category: 'running',
    description: 'Intermediate half-marathon runner with one maintenance strength day.',
    athlete: baseAthlete({
      profile: { athleteId: 9104, name: 'Runner', primaryDiscipline: 'running', thresholdPaceSecondsPerKm: 285 },
      goals: { primaryFocus: 'running', secondaryFocus: 'strength', strengthGoal: 'maintenance', priorityOrder: ['running', 'strength'], weeklySessionsTarget: { running: 5, strength: 1 }, weeklyMinutesTarget: { running: 280, strength: 45 }, raceCalendar: [{ id: 'hm', name: 'Half Marathon', discipline: 'running', subtype: 'half_marathon', date: '2026-07-12', priority: 'a' }] },
      availability: { weeklyWindows: [...windows(['monday', 'tuesday', 'thursday', 'saturday', 'sunday'], 'running'), { dayOfWeek: 'friday', start: '12:00', end: '13:00', sports: ['strength'] }], preferredLongSessionDay: 'sunday', preferredTimesBySport: { running: '06:30', strength: '12:00' }, maxSessionsPerDay: 1 },
      trainingHistory: { lastWeekMinutesBySport: { running: 245, strength: 45 }, trailing4WeekMinutesBySport: { running: [205, 220, 235, 245], strength: [35, 40, 45, 45] } },
    }),
    expectations: { expectedSports: ['running', 'strength'], primarySport: 'running', minRunningSessions: 4, maxStrengthSessions: 1, minTotalSessions: 5 },
    tags: ['running', 'race'],
  }),
  persona({
    id: 'cyclist-ftp-build',
    name: 'Cyclist',
    category: 'cycling',
    description: 'Cyclist building FTP with trainer access and two support strength windows.',
    athlete: baseAthlete({
      profile: { athleteId: 9105, name: 'Cyclist', primaryDiscipline: 'cycling', cyclingFtpWatts: 255 },
      goals: { primaryFocus: 'cycling', secondaryFocus: 'strength', strengthGoal: 'maintenance', priorityOrder: ['cycling', 'strength'], weeklySessionsTarget: { cycling: 4, strength: 2 }, weeklyMinutesTarget: { cycling: 300, strength: 80 } },
      availability: { weeklyWindows: [...windows(['monday', 'wednesday', 'friday', 'saturday'], 'cycling'), { dayOfWeek: 'tuesday', start: '12:00', end: '13:00', sports: ['strength'] }, { dayOfWeek: 'thursday', start: '12:00', end: '13:00', sports: ['strength'] }], preferredLongSessionDay: 'saturday', preferredTimesBySport: { cycling: '06:30', strength: '12:00' }, maxSessionsPerDay: 1 },
      trainingHistory: { lastWeekMinutesBySport: { cycling: 260, strength: 70 }, trailing4WeekMinutesBySport: { cycling: [220, 235, 250, 260], strength: [60, 60, 65, 70] } },
    }),
    expectations: { expectedSports: ['cycling', 'strength'], primarySport: 'cycling', minCyclingSessions: 3, maxStrengthSessions: 2, minTotalSessions: 4 },
    tags: ['cycling', 'ftp'],
  }),
  persona({
    id: 'hybrid-gym-running',
    name: 'Hybrid Gym + Running User',
    category: 'hybrid',
    description: 'Hybrid user who likes morning runs and lunch strength.',
    athlete: baseAthlete({ profile: { athleteId: 9106, name: 'Hybrid Run Strength', primaryDiscipline: 'hybrid' } }),
    expectations: { expectedSports: ['running', 'strength'], minRunningSessions: 2, minStrengthSessions: 2, maxSessionsPerDay: 2, minTotalSessions: 5 },
    tags: ['hybrid', 'two_a_day'],
  }),
  persona({
    id: 'hybrid-gym-cycling',
    name: 'Hybrid Gym + Cycling User',
    category: 'hybrid',
    description: 'Hybrid user mixing rides with strength work.',
    athlete: baseAthlete({
      profile: { athleteId: 9107, name: 'Hybrid Bike Strength', primaryDiscipline: 'hybrid' },
      goals: { primaryFocus: 'hybrid', secondaryFocus: 'strength', strengthGoal: 'athletic', priorityOrder: ['cycling', 'strength'], weeklySessionsTarget: { cycling: 3, strength: 3 }, weeklyMinutesTarget: { cycling: 210, strength: 150 } },
      trainingHistory: { lastWeekMinutesBySport: { cycling: 190, strength: 130 }, trailing4WeekMinutesBySport: { cycling: [150, 170, 180, 190], strength: [110, 120, 125, 130] } },
    }),
    expectations: { expectedSports: ['cycling', 'strength'], minCyclingSessions: 2, minStrengthSessions: 2, maxSessionsPerDay: 2, minTotalSessions: 5 },
    tags: ['hybrid', 'cycling'],
  }),
  persona({
    id: 'triathlon-swim-bike-run-race-prep',
    name: 'Swim / Triathlon Race-Prep User',
    category: 'triathlon',
    description: 'Sprint-triathlon user with pool access, bike/run targets, and one support strength window.',
    athlete: baseAthlete({
      profile: {
        athleteId: 9114,
        name: 'Triathlon Prep',
        primaryDiscipline: 'triathlon',
        thresholdPaceSecondsPerKm: 305,
        cyclingFtpWatts: 235,
        swimCssSecondsPer100m: 112,
      },
      goals: {
        primaryFocus: 'triathlon',
        secondaryFocus: 'strength',
        strengthGoal: 'maintenance',
        priorityOrder: ['swimming', 'cycling', 'running', 'strength'],
        weeklySessionsTarget: { swimming: 2, cycling: 2, running: 2, strength: 1 },
        weeklyMinutesTarget: { swimming: 90, cycling: 180, running: 150, strength: 45 },
        raceCalendar: [{
          id: 'sprint-tri',
          name: 'Sprint Triathlon',
          discipline: 'triathlon',
          subtype: 'sprint',
          date: '2026-06-28',
          priority: 'a',
          disciplines: ['swimming', 'cycling', 'running'],
          raceFormat: 'multisport',
        }],
      },
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '06:30', end: '07:45', sports: ['swimming'] },
          { dayOfWeek: 'tuesday', start: '06:30', end: '08:00', sports: ['running'] },
          { dayOfWeek: 'wednesday', start: '06:30', end: '08:00', sports: ['cycling'] },
          { dayOfWeek: 'thursday', start: '06:30', end: '07:45', sports: ['swimming'] },
          { dayOfWeek: 'friday', start: '12:00', end: '13:00', sports: ['strength'] },
          { dayOfWeek: 'saturday', start: '08:00', end: '10:30', sports: ['cycling', 'running'] },
          { dayOfWeek: 'sunday', start: '08:00', end: '10:00', sports: ['running'] },
        ],
        preferredLongSessionDay: 'saturday',
        preferredTimesBySport: { swimming: '06:30', cycling: '08:00', running: '06:30', strength: '12:00' },
        maxSessionsPerDay: 2,
      },
      equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, hasBikeTrainer: true, hasPool: true, hasTrack: true },
      trainingHistory: {
        lastWeekMinutesBySport: { swimming: 75, cycling: 145, running: 125, strength: 45 },
        trailing4WeekMinutesBySport: {
          swimming: [55, 60, 70, 75],
          cycling: [110, 125, 135, 145],
          running: [95, 105, 115, 125],
          strength: [40, 45, 45, 45],
        },
      },
      currentBlock: { discipline: 'triathlon', phase: 'build', weekIndex: 8, totalWeeks: 12, volumeProgressionPct: 5 },
    }),
    expectations: {
      expectedSports: ['swimming', 'cycling', 'running', 'strength'],
      primarySport: 'swimming',
      minRunningSessions: 1,
      minCyclingSessions: 1,
      maxStrengthSessions: 1,
      minTotalSessions: 5,
      maxSessionsPerDay: 2,
    },
    tags: ['triathlon', 'swimming', 'race_prep', 'multisport'],
  }),
  persona({
    id: 'low-time-user',
    name: 'Low-Time User',
    category: 'constraints',
    description: 'Busy user with three 35-minute windows.',
    athlete: baseAthlete({
      profile: { athleteId: 9108, name: 'Low Time', experienceLevel: 'intermediate', primaryDiscipline: 'hybrid' },
      availability: { weeklyWindows: [{ dayOfWeek: 'monday', start: '07:00', end: '07:35', sports: ['running'] }, { dayOfWeek: 'wednesday', start: '12:00', end: '12:35', sports: ['strength'] }, { dayOfWeek: 'friday', start: '07:00', end: '07:35', sports: ['running', 'strength'] }], preferredTimesBySport: { running: '07:00', strength: '12:00' }, maxSessionsPerDay: 1 },
      goals: { primaryFocus: 'hybrid', strengthGoal: 'maintenance', priorityOrder: ['running', 'strength'], weeklySessionsTarget: { running: 2, strength: 2 }, weeklyMinutesTarget: { running: 70, strength: 70 } },
      constraints: [{ id: 'low-time', type: 'time', severity: 'high', description: 'Only short windows this week.' }],
    }),
    expectations: { expectedSports: ['running', 'strength'], maxTotalSessions: 4, maxSessionsPerDay: 1 },
    tags: ['low_time', 'compressed'],
  }),
  persona({
    id: 'inconsistent-adherence-user',
    name: 'Inconsistent-Adherence User',
    category: 'adherence',
    description: 'User with recent missed sessions requiring realistic simplification.',
    athlete: baseAthlete({
      profile: { athleteId: 9109, name: 'Inconsistent', primaryDiscipline: 'hybrid' },
      compliance: { trailing14DayCompliance: 0.42, bySport: { running: 0.35, strength: 0.5 }, missedKeySessions: 3, consecutiveMisses: 2 },
      recentSessions: [{ id: 'missed-run', sport: 'running', sessionType: 'threshold_run', completedAt: '2026-04-24T06:30:00.000Z', durationMinutes: 45, intensityZone: 'threshold', fatigueCost: 'high', completed: false, keySession: true, missedReason: 'work' }],
      readiness: { capturedAt: fixedCapturedAt, level: 'yellow', score: 64, sleepHours: 6.4, hrvStatus: 'low', energyReserve: 55, soreness: 'moderate', painFlags: [] },
    }),
    expectations: { expectedSports: ['running', 'strength'], maxTotalSessions: 6, maxSessionsPerDay: 1 },
    tags: ['adherence', 'missed_sessions'],
  }),
  persona({
    id: 'equipment-limited-home',
    name: 'Equipment-Limited User',
    category: 'equipment',
    description: 'Home user with no gym, no barbell, and only dumbbells.',
    athlete: baseAthlete({
      profile: { athleteId: 9110, name: 'Home Equipment', experienceLevel: 'intermediate', primaryDiscipline: 'strength' },
      goals: { primaryFocus: 'strength', strengthGoal: 'hypertrophy', priorityOrder: ['strength'], weeklySessionsTarget: { strength: 3 }, weeklyMinutesTarget: { strength: 150 } },
      equipment: { hasGym: false, hasBarbell: false, hasDumbbells: true, hasBikeTrainer: false, hasPool: false, hasTrack: false },
      availability: { weeklyWindows: gymWindows.slice(0, 3), preferredTimesBySport: { strength: '12:00' }, maxSessionsPerDay: 1 },
    }),
    expectations: { expectedSports: ['strength'], minStrengthSessions: 2, requiredEquipmentAvoidance: ['barbell', 'rack'] },
    tags: ['equipment_limited', 'home'],
  }),
  persona({
    id: 'travel-week-hotel-gym',
    name: 'Travel-Week User',
    category: 'travel',
    description: 'Hybrid user traveling with a small hotel gym and reduced windows.',
    athlete: baseAthlete({
      profile: { athleteId: 9111, name: 'Travel Week', primaryDiscipline: 'hybrid' },
      equipment: { hasGym: false, hasBarbell: false, hasDumbbells: true, hasBikeTrainer: false, hasPool: false, hasTrack: false, notes: ['hotel gym only'] },
      availability: { weeklyWindows: [{ dayOfWeek: 'monday', start: '06:30', end: '07:15', sports: ['running'] }, { dayOfWeek: 'wednesday', start: '18:00', end: '18:45', sports: ['strength'] }, { dayOfWeek: 'friday', start: '06:30', end: '07:15', sports: ['running', 'strength'] }], preferredTimesBySport: { running: '06:30', strength: '18:00' }, maxSessionsPerDay: 1 },
      constraints: [{ id: 'travel', type: 'equipment', severity: 'high', description: 'Hotel gym only.' }],
    }),
    expectations: { expectedSports: ['running', 'strength'], maxTotalSessions: 4, maxSessionsPerDay: 1, requiredEquipmentAvoidance: ['barbell', 'rack'] },
    tags: ['travel', 'hotel_gym'],
  }),
  persona({
    id: 'discomfort-knee-limitation',
    name: 'Discomfort / Limitation User',
    category: 'safety',
    description: 'Strength user with explicit knee discomfort requiring substitution care.',
    athlete: baseAthlete({
      profile: { athleteId: 9112, name: 'Knee Discomfort', primaryDiscipline: 'strength' },
      goals: { primaryFocus: 'strength', strengthGoal: 'athletic', priorityOrder: ['strength'], weeklySessionsTarget: { strength: 3 }, weeklyMinutesTarget: { strength: 150 } },
      readiness: { capturedAt: fixedCapturedAt, level: 'yellow', score: 66, soreness: 'moderate', painFlags: [{ area: 'knee_pain', severity: 'moderate', impact: ['strength', 'running'] }] },
      constraints: [{ id: 'knee', type: 'injury', severity: 'medium', description: 'Knee discomfort during deep flexion.', sport: 'strength' }],
      availability: { weeklyWindows: gymWindows.slice(0, 3), preferredTimesBySport: { strength: '12:00' }, maxSessionsPerDay: 1 },
    }),
    expectations: { expectedSports: ['strength'], minStrengthSessions: 2, shouldAvoidPainAreas: ['knee_pain'] },
    tags: ['pain_flag', 'biomechanics'],
  }),
  persona({
    id: 'explicit-cycle-aware-user',
    name: 'Explicit Sex/Gender-Aware Context User',
    category: 'personalization',
    description: 'Advanced runner who explicitly opted into cycle-aware planning context.',
    athlete: baseAthlete({
      profile: { athleteId: 9113, name: 'Cycle Aware Runner', primaryDiscipline: 'running', experienceLevel: 'advanced', thresholdPaceSecondsPerKm: 270 },
      goals: { primaryFocus: 'running', secondaryFocus: 'strength', strengthGoal: 'maintenance', priorityOrder: ['running', 'strength'], weeklySessionsTarget: { running: 5, strength: 2 }, weeklyMinutesTarget: { running: 310, strength: 75 } },
      constraints: [{ id: 'cycle-aware', type: 'fatigue', severity: 'low', description: 'User explicitly opted into cycle-aware load context this week.' }],
      readiness: { capturedAt: fixedCapturedAt, level: 'yellow', score: 70, sleepHours: 7.0, hrvStatus: 'normal', energyReserve: 64, soreness: 'moderate', painFlags: [] },
    }),
    expectations: { expectedSports: ['running', 'strength'], primarySport: 'running', minRunningSessions: 4, explicitSexGenderContext: true },
    tags: ['explicit_gender_context', 'running', 'personalization'],
  }),
];
