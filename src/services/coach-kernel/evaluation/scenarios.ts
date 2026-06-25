// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, AvailabilityWindow, Sport } from '../types';
import type { TrainingEvalScenario, TrainingEvalScenarioContext } from './types';

function cloneAthlete(athlete: AthleteState): AthleteState {
  return JSON.parse(JSON.stringify(athlete)) as AthleteState;
}

function mapWindows(
  athlete: AthleteState,
  mapper: (window: AvailabilityWindow) => AvailabilityWindow,
): AthleteState {
  return {
    ...athlete,
    availability: {
      ...athlete.availability,
      weeklyWindows: athlete.availability.weeklyWindows.map(mapper),
    },
  };
}

function shortEnd(start: string, minutes: number): string {
  const [hoursRaw, minutesRaw] = start.split(':').map(Number);
  const total = hoursRaw * 60 + minutesRaw + minutes;
  const hours = Math.floor(total / 60).toString().padStart(2, '0');
  const mins = (total % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}

function withScenarioConstraint(athlete: AthleteState, id: string, description: string, type: AthleteState['constraints'][number]['type'], severity: AthleteState['constraints'][number]['severity'] = 'medium'): AthleteState {
  return {
    ...athlete,
    constraints: [
      ...athlete.constraints.filter((constraint) => constraint.id !== id),
      { id, type, severity, description },
    ],
  };
}

export const trainingEvalScenarioBank: TrainingEvalScenario[] = [
  {
    id: 'baseline-current-profile',
    name: 'Baseline Current Profile',
    category: 'baseline',
    description: 'Generate the current week from the persona without stressors. This is the control case.',
    tags: ['baseline'],
    apply: ({ persona }: TrainingEvalScenarioContext) => cloneAthlete(persona.athlete),
  },
  {
    id: 'missed-key-session',
    name: 'Missed Key Session',
    category: 'adaptation',
    description: 'The user missed a recent key session; the coach should not blindly stack catch-up load.',
    tags: ['missed_session', 'adherence'],
    expectations: { shouldReduceLoad: true, maxSessionsPerDay: 1 },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      const primarySport: Sport = persona.expectations.primarySport ?? persona.expectations.expectedSports[0] ?? 'running';
      return {
        ...athlete,
        recentSessions: [
          ...athlete.recentSessions,
          {
            id: 'eval-missed-key',
            sport: primarySport,
            sessionType: primarySport === 'cycling' ? 'threshold_ride' : primarySport === 'strength' ? 'strength_hypertrophy' : 'threshold_run',
            completedAt: '2026-04-24T06:30:00.000Z',
            durationMinutes: 50,
            intensityZone: 'threshold',
            fatigueCost: 'high',
            completed: false,
            keySession: true,
            missedReason: 'schedule_conflict',
          },
        ],
        compliance: {
          trailing14DayCompliance: Math.min(athlete.compliance.trailing14DayCompliance, 0.58),
          bySport: athlete.compliance.bySport,
          missedKeySessions: Math.max(athlete.compliance.missedKeySessions, 1),
          consecutiveMisses: Math.max(athlete.compliance.consecutiveMisses, 1),
        },
      };
    },
  },
  {
    id: 'reduced-available-time',
    name: 'Reduced Available Time',
    category: 'schedule',
    description: 'All availability windows shrink to 35 minutes. The plan should compress rather than overfill.',
    tags: ['low_time', 'schedule'],
    expectations: { shouldRespectShortWindows: true, maxSessionsPerDay: 1, maxTotalSessions: 5 },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = mapWindows(cloneAthlete(persona.athlete), (window) => ({
        ...window,
        end: shortEnd(window.start, 35),
      }));
      return withScenarioConstraint({ ...athlete, availability: { ...athlete.availability, maxSessionsPerDay: 1 } }, 'eval-short-windows', 'This week only has 35-minute training windows.', 'time', 'high');
    },
  },
  {
    id: 'plan-cancel-regenerate',
    name: 'Plan Cancellation And Regeneration',
    category: 'calendar_lifecycle',
    description: 'Simulate a regenerate after cancellation by changing the block week. The benchmark checks stable identity and duplicate-safe agenda readiness.',
    tags: ['agenda_lifecycle', 'regeneration'],
    expectations: { compareWithNextVersion: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => cloneAthlete(persona.athlete),
  },
  {
    id: 'plateau-signals',
    name: 'Plateau Signals',
    category: 'adaptation',
    description: 'Four-week history is flat and recent sessions feel hard. The coach should progress carefully and explain guardrails.',
    tags: ['plateau', 'progression'],
    expectations: { shouldReduceLoad: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return {
        ...athlete,
        trainingHistory: {
          lastWeekMinutesBySport: athlete.trainingHistory.lastWeekMinutesBySport,
          trailing4WeekMinutesBySport: Object.fromEntries(
            Object.entries(athlete.trainingHistory.lastWeekMinutesBySport).map(([sport, minutes]) => [sport, [minutes, minutes, minutes, minutes]]),
          ),
        },
        readiness: { ...athlete.readiness, level: 'yellow', score: Math.min(athlete.readiness.score, 65), soreness: 'moderate', hrvStatus: 'low' },
      };
    },
  },
  {
    id: 'poor-recovery',
    name: 'Poor Recovery',
    category: 'adaptation',
    description: 'Red readiness, low sleep, and high soreness should downshift the week.',
    tags: ['readiness', 'fatigue'],
    expectations: { requiredPhase: 'deload', shouldReduceLoad: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => ({
      ...cloneAthlete(persona.athlete),
      readiness: {
        ...persona.athlete.readiness,
        capturedAt: '2026-04-27T07:00:00.000Z',
        level: 'red',
        score: 34,
        sleepHours: 4.8,
        hrvStatus: 'low',
        energyReserve: 32,
        soreness: 'high',
        painFlags: persona.athlete.readiness.painFlags,
      },
    }),
  },
  {
    id: 'travel-hotel-gym',
    name: 'Travel / Hotel Gym',
    category: 'travel',
    description: 'Only hotel gym equipment and short windows are available.',
    tags: ['travel', 'equipment'],
    expectations: { shouldUseHotelGym: true, maxSessionsPerDay: 1, maxTotalSessions: 4 },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return withScenarioConstraint({
        ...athlete,
        equipment: {
          hasGym: false,
          hasBarbell: false,
          hasDumbbells: true,
          hasBikeTrainer: false,
          hasPool: false,
          hasTrack: false,
          notes: ['hotel gym only'],
        },
        availability: {
          ...athlete.availability,
          weeklyWindows: [
            { dayOfWeek: 'monday', start: '06:30', end: '07:15', sports: ['running'] },
            { dayOfWeek: 'wednesday', start: '18:00', end: '18:45', sports: ['strength'] },
            { dayOfWeek: 'friday', start: '06:30', end: '07:15', sports: ['running', 'strength'] },
          ],
          maxSessionsPerDay: 1,
        },
      }, 'eval-travel', 'Travel week: hotel gym only, no barbell/rack.', 'equipment', 'high');
    },
  },
  {
    id: 'schedule-change-one-session-per-day',
    name: 'Schedule Change',
    category: 'schedule',
    description: 'The user can only tolerate one session per day this week.',
    tags: ['schedule', 'two_a_day'],
    expectations: { maxSessionsPerDay: 1 },
    apply: ({ persona }: TrainingEvalScenarioContext) => ({
      ...cloneAthlete(persona.athlete),
      availability: { ...persona.athlete.availability, maxSessionsPerDay: 1 },
      constraints: [
        ...persona.athlete.constraints,
        { id: 'eval-one-session-day', type: 'time', severity: 'high', description: 'No two-a-days this week.' },
      ],
    }),
  },
  {
    id: 'feedback-too-hard-easy-long',
    name: 'Feedback: Too Hard / Too Easy / Too Long',
    category: 'feedback',
    description: 'Recent feedback indicates poor calibration; future prescriptions should be conservative and explain why.',
    tags: ['feedback', 'autoregulation'],
    expectations: { shouldReduceLoad: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return withScenarioConstraint({
        ...athlete,
        readiness: { ...athlete.readiness, level: 'yellow', score: Math.min(athlete.readiness.score, 62), soreness: 'moderate' },
        compliance: { ...athlete.compliance, trailing14DayCompliance: Math.min(athlete.compliance.trailing14DayCompliance, 0.68) },
      }, 'eval-calibration-feedback', 'User reported the last session was too hard, too easy, or too long; calibration should be explicit.', 'fatigue', 'medium');
    },
  },
  {
    id: 'missing-fueling-coverage',
    name: 'Missing Fueling Coverage',
    category: 'feedback',
    description: 'Long/key endurance work should not ship with no fueling awareness.',
    tags: ['fueling', 'cross_skill'],
    expectations: { shouldShowFuelingGuidance: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return withScenarioConstraint(athlete, 'eval-fueling-gap', 'Fueling context missing for key endurance work.', 'fatigue', 'low');
    },
  },
  {
    id: 'weak-profile-completeness',
    name: 'Weak Profile Completeness',
    category: 'profile_completeness',
    description: 'Profile lacks key thresholds/equipment notes; benchmark expects graceful conservative output plus gap surfacing.',
    tags: ['profile', 'questionnaire'],
    expectations: { shouldSurfaceProfileGap: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return {
        ...athlete,
        profile: {
          athleteId: athlete.profile.athleteId,
          name: athlete.profile.name,
          experienceLevel: athlete.profile.experienceLevel,
          primaryDiscipline: athlete.profile.primaryDiscipline,
        },
        equipment: { ...athlete.equipment, notes: ['equipment confidence low'] },
        constraints: [
          ...athlete.constraints,
          { id: 'eval-profile-gap', type: 'time', severity: 'low', description: 'Profile completeness is weak; ask follow-up questions before aggressive progression.' },
        ],
      };
    },
  },
  {
    id: 'stale-wearable-readiness',
    name: 'Stale Wearable Readiness',
    category: 'profile_completeness',
    description: 'Wearable readiness exists but is stale; the coach should not present it as fresh truth.',
    tags: ['wearable', 'stale_provider', 'readiness'],
    expectations: { shouldSurfaceProfileGap: true, shouldReduceLoad: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return withScenarioConstraint({
        ...athlete,
        readiness: {
          ...athlete.readiness,
          capturedAt: '2026-04-24T07:00:00.000Z',
          level: 'yellow',
          score: Math.min(athlete.readiness.score, 62),
          confidence: 'stale_provider',
          dataSource: 'wearable',
          isStale: true,
          reasonCode: 'wearable_sync_stale',
          notes: ['Wearable readiness data is stale; use conservative planning and ask for a check-in.'],
        },
      }, 'eval-stale-wearable', 'Wearable readiness is stale; explain confidence and avoid aggressive progression.', 'fatigue', 'medium');
    },
  },
  {
    id: 'no-wearable-readiness',
    name: 'No Wearable Readiness',
    category: 'profile_completeness',
    description: 'No wearable or manual readiness data is available; output should stay useful but transparent.',
    tags: ['wearable', 'no_data', 'readiness'],
    expectations: { shouldSurfaceProfileGap: true },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return withScenarioConstraint({
        ...athlete,
        readiness: {
          capturedAt: '2026-04-27T07:00:00.000Z',
          level: 'green',
          score: 70,
          confidence: 'no_data',
          dataSource: 'fallback',
          reasonCode: 'wearable_not_connected',
          painFlags: athlete.readiness.painFlags,
          notes: ['No wearable data connected; use manual check-in or conservative defaults.'],
        },
      }, 'eval-no-wearable', 'No wearable data is connected; surface the confidence gap instead of pretending precision.', 'time', 'low');
    },
  },
  {
    id: 'calendar-conflicted-week',
    name: 'Calendar-Conflicted Week',
    category: 'schedule',
    description: 'Calendar pressure removes most normal windows; the coach should produce a schedule-compatible minimum effective week.',
    tags: ['calendar', 'schedule_conflict', 'minimum_effective_dose'],
    expectations: { shouldRespectShortWindows: true, maxSessionsPerDay: 1, maxTotalSessions: 4 },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return withScenarioConstraint({
        ...athlete,
        availability: {
          ...athlete.availability,
          weeklyWindows: [
            { dayOfWeek: 'monday', start: '06:45', end: '07:25', sports: ['running', 'cycling'] },
            { dayOfWeek: 'wednesday', start: '12:10', end: '12:50', sports: ['strength'] },
            { dayOfWeek: 'saturday', start: '08:00', end: '09:00', sports: ['running', 'cycling', 'swimming'] },
          ],
          maxSessionsPerDay: 1,
        },
      }, 'eval-calendar-conflict', 'Calendar conflicts leave only three short windows; avoid duplicate or impossible scheduling.', 'interference', 'high');
    },
  },
  {
    id: 'discomfort-substitution',
    name: 'Discomfort Requires Substitution',
    category: 'safety',
    description: 'Explicit pain flags should affect exercise selection instead of being ignored.',
    tags: ['pain_flag', 'biomechanics'],
    expectations: { shouldAvoidPainAreas: ['knee_pain', 'low_back_strain'] },
    apply: ({ persona }: TrainingEvalScenarioContext) => {
      const athlete = cloneAthlete(persona.athlete);
      return {
        ...athlete,
        readiness: {
          ...athlete.readiness,
          level: 'yellow',
          score: Math.min(athlete.readiness.score, 66),
          painFlags: [
            ...athlete.readiness.painFlags,
            { area: 'knee_pain', severity: 'moderate', impact: ['strength', 'running'] },
            { area: 'low_back_strain', severity: 'low', impact: ['strength'] },
          ],
        },
      };
    },
  },
];
