// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { canonicalTrainingDay } from './training-schedule-utils';
import { materializeCanonicalTrainingExercise } from '../../services/training-exercise-identity';
import {
  getTrainingExerciseIdentityV1Mode,
  type RuntimeFlagScope,
  type TrainingExerciseIdentityV1Mode,
} from '../../services/runtime-flags';

type FallbackPlanOptions = {
  sessionsPerWeek?: number;
  strengthSessionsPerWeek?: number;
  longWorkoutDay?: string | null;
  exerciseIdentityMode?: TrainingExerciseIdentityV1Mode;
  env?: NodeJS.ProcessEnv;
  scope?: RuntimeFlagScope;
};

const FALLBACK_EMITTER_CANONICAL_IDS: Readonly<Record<string, string>> = Object.freeze({
  'Push-Up / DB Press': 'push_up',
  'One-Arm Row': 'one_arm_dumbbell_row',
  'Lateral Raise': 'dumbbell_lateral_raise',
  'Cable / Band Triceps Pressdown': 'cable_triceps_pressdown',
  'Leg Curl': 'seated_leg_curl',
  'Hanging Knee Raise': 'dead_bug',
  'Overhead Press': 'barbell_overhead_press',
  'Lat Pulldown / Pull-Up': 'lat_pulldown',
  'Incline Curl': 'dumbbell_curl',
  'Hip Thrust': 'barbell_hip_thrust',
  'Seated Calf Raise': 'calf_raise',
});

export function buildDeterministicTrainingPlan(
  objective: string,
  durationWeeks: number,
  options: FallbackPlanOptions = {},
) {
  const template = inferTrainingTemplate(objective.toLowerCase(), options);
  const weeks = Array.from({ length: durationWeeks }, (_, index) => {
    const weekNumber = index + 1;
    const isDeload = weekNumber === durationWeeks;
    const durationScale = isDeload ? 0.8 : 1 + Math.min(index, 2) * 0.05;

    return {
      weekNumber,
      focus: isDeload ? 'deload' : template.focuses[Math.min(index, template.focuses.length - 1)],
      intensityPct: isDeload ? 58 : 66 + Math.min(index, 2) * 6,
      sessions: template.sessions.map((session: any) => ({
        ...session,
        durationMinutes: Math.max(35, Math.round(session.durationMinutes * durationScale)),
        description: isDeload
          ? `${session.description} Keep the effort controlled and finish feeling fresh.`
          : session.description,
        exercises: Array.isArray(session.exercises)
          ? session.exercises.map((exercise: any) => ({
              ...exercise,
              sets: typeof exercise.sets === 'number'
                ? Math.max(2, Math.round(exercise.sets * (isDeload ? 0.75 : 1)))
                : exercise.sets,
            }))
          : [],
      })),
    };
  });

  const plan = {
    planName: `${objective.trim()} — ${durationWeeks} Week Plan`,
    sport: template.sport,
    periodization: 'undulating',
    weeks,
  };
  const identityMode = options.exerciseIdentityMode
    ?? getTrainingExerciseIdentityV1Mode(options.env ?? process.env, options.scope);
  return normalizeFallbackExerciseIdentities(plan, identityMode);
}

function inferTrainingTemplate(
  lowerObjective: string,
  options: FallbackPlanOptions = {},
) {
  const targetSessionsPerWeek = Math.max(3, Math.min(7, options.sessionsPerWeek || 5));
  const targetStrengthSessions = Math.max(0, Math.min(6, options.strengthSessionsPerWeek || 0));

  if (/(triathlon|triatlo|70\.3|ironman|half ironman)/i.test(lowerObjective)) {
    return {
      sport: 'hybrid',
      focuses: ['base', 'endurance', 'speed'],
      sessions: [
        {
          dayOfWeek: 'monday',
          sessionType: 'swim',
          title: 'Swim Technique + Aerobic Base',
          durationMinutes: 45,
          description: 'Easy technical swim with drills, relaxed breathing, and smooth aerobic work.',
          exercises: [],
        },
        {
          dayOfWeek: 'tuesday',
          sessionType: 'ride',
          title: 'Bike Endurance',
          durationMinutes: 60,
          description: 'Steady zone 2 ride focused on cadence and sustained aerobic work.',
          exercises: [],
        },
        {
          dayOfWeek: 'wednesday',
          sessionType: 'gym',
          title: 'Strength + Core',
          durationMinutes: 50,
          description: 'Full-body strength session with controlled form and core stability.',
          exercises: [],
        },
        {
          dayOfWeek: 'thursday',
          sessionType: 'run',
          title: 'Run Tempo / Intervals',
          durationMinutes: 50,
          description: 'Quality run with warm-up, focused work, and a calm cooldown.',
          exercises: [],
        },
        {
          dayOfWeek: 'saturday',
          sessionType: 'ride',
          title: 'Long Ride',
          durationMinutes: 95,
          description: 'Long aerobic ride with nutrition practice and steady pacing.',
          exercises: [],
        },
        {
          dayOfWeek: 'sunday',
          sessionType: 'run',
          title: 'Long Run',
          durationMinutes: 65,
          description: 'Comfortable long run focused on endurance and consistency.',
          exercises: [],
        },
      ],
    };
  }

  if (/(marathon|meia maratona|half marathon|10k|5k|corrida|running|run)/i.test(lowerObjective)) {
    return {
      sport: 'running',
      focuses: ['base', 'endurance', 'speed'],
      sessions: buildRunnerFallbackSessions(
        targetSessionsPerWeek,
        targetStrengthSessions,
        options.longWorkoutDay ?? null,
      ),
    };
  }

  if (/(hipertrofia|hypertrophy|muscle|strength|gym|massa|bodybuilding)/i.test(lowerObjective)) {
    const gymSessionCount = targetStrengthSessions > 0
      ? targetStrengthSessions
      : typeof options.sessionsPerWeek === 'number'
        ? targetSessionsPerWeek
        : 4;

    return {
      sport: 'gym',
      focuses: ['hypertrophy', 'strength', 'strength'],
      sessions: [
        {
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Upper Body A',
          durationMinutes: 60,
          description: 'Push and pull hypertrophy with controlled tempo and full range of motion.',
          exercises: upperBodyExercises(),
        },
        {
          dayOfWeek: 'tuesday',
          sessionType: 'gym',
          title: 'Lower Body A',
          durationMinutes: 65,
          description: 'Squat-dominant lower-body strength with core work.',
          exercises: lowerBodyExercises(),
        },
        {
          dayOfWeek: 'thursday',
          sessionType: 'gym',
          title: 'Upper Body B',
          durationMinutes: 60,
          description: 'Secondary upper-body day with vertical press, rows, and arms.',
          exercises: upperBodyBExercises(),
        },
        {
          dayOfWeek: 'friday',
          sessionType: 'gym',
          title: 'Lower Body B',
          durationMinutes: 65,
          description: 'Hinge-dominant lower-body session with posterior-chain emphasis.',
          exercises: lowerBodyBExercises(),
        },
        {
          dayOfWeek: 'saturday',
          sessionType: 'gym',
          title: 'Upper Body C',
          durationMinutes: 55,
          description: 'Accessory upper-body hypertrophy with shoulders, arms, back volume, and trunk control.',
          exercises: upperBodyCExercises(),
        },
        {
          dayOfWeek: 'sunday',
          sessionType: 'gym',
          title: 'Lower Body C',
          durationMinutes: 55,
          description: 'Lower-body accessory day that builds glutes, hamstrings, calves, and trunk durability.',
          exercises: lowerBodyCExercises(),
        },
      ].slice(0, Math.max(1, Math.min(gymSessionCount, 6))),
    };
  }

  return {
    sport: 'hybrid',
    focuses: ['base', 'strength', 'endurance'],
    sessions: [
      {
        dayOfWeek: 'monday',
        sessionType: 'gym',
        title: 'Full Body Strength',
        durationMinutes: 50,
        description: 'Balanced full-body strength work with moderate volume and controlled effort.',
        exercises: baseStrengthExercises(),
      },
      {
        dayOfWeek: 'wednesday',
        sessionType: 'run',
        title: 'Zone 2 Cardio',
        durationMinutes: 45,
        description: 'Easy aerobic session to build conditioning and recovery capacity.',
        exercises: [],
      },
      {
        dayOfWeek: 'friday',
        sessionType: 'gym',
        title: 'Full Body Strength B',
        durationMinutes: 50,
        description: 'Second strength session focused on movement quality and progression.',
        exercises: lowerBodyBExercises(),
      },
      {
        dayOfWeek: 'saturday',
        sessionType: 'ride',
        title: 'Long Conditioning Session',
        durationMinutes: 60,
        description: 'Steady conditioning block — bike, brisk walk, or easy jog depending on context.',
        exercises: [],
      },
    ],
  };
}

function normalizeFallbackExerciseIdentities<T extends { weeks: any[] }>(
  plan: T,
  mode: TrainingExerciseIdentityV1Mode,
): T {
  if (mode === 'off') return plan;
  plan.weeks = plan.weeks.map((week) => ({
    ...week,
    sessions: Array.isArray(week.sessions)
      ? week.sessions.map((session: any) => ({
          ...session,
          exercises: Array.isArray(session.exercises)
            ? session.exercises.map((exercise: any) => {
                const name = typeof exercise?.name === 'string' ? exercise.name.trim() : '';
                return materializeCanonicalTrainingExercise(exercise, {
                  canonicalId: FALLBACK_EMITTER_CANONICAL_IDS[name],
                  env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: mode },
                  source: 'training-fallback-plan',
                });
              })
            : [],
        }))
      : [],
  }));
  return plan;
}

function buildRunnerFallbackSessions(
  sessionsPerWeek: number,
  strengthSessionsPerWeek: number,
  longWorkoutDay: string | null,
) {
  const canonicalLongDay = canonicalTrainingDay(longWorkoutDay?.trim() || 'Saturday').toLowerCase();
  const runTemplates = [
    {
      dayOfWeek: 'monday',
      sessionType: 'run',
      title: 'Recovery Run',
      durationMinutes: 40,
      description: 'Easy aerobic run with relaxed mechanics and a short cooldown.',
      exercises: [],
    },
    {
      dayOfWeek: 'tuesday',
      sessionType: 'run',
      title: 'Threshold Session',
      durationMinutes: 55,
      description: 'Warm-up, controlled threshold work, and cooldown to build marathon durability.',
      exercises: [],
    },
    {
      dayOfWeek: 'wednesday',
      sessionType: 'run',
      title: 'Base Run',
      durationMinutes: 45,
      description: 'Steady zone 2 run to reinforce aerobic consistency.',
      exercises: [],
    },
    {
      dayOfWeek: 'thursday',
      sessionType: 'run',
      title: 'Intervals / Economy',
      durationMinutes: 50,
      description: 'Quality run with faster segments, full warm-up, and relaxed cooldown.',
      exercises: [],
    },
    {
      dayOfWeek: 'friday',
      sessionType: 'run',
      title: 'Easy Shakeout',
      durationMinutes: 35,
      description: 'Short easy run focused on rhythm and low fatigue.',
      exercises: [],
    },
    {
      dayOfWeek: canonicalLongDay,
      sessionType: 'run',
      title: 'Long Run',
      durationMinutes: 85,
      description: 'Aerobic long run at conversational effort with fueling practice.',
      exercises: [],
    },
    {
      dayOfWeek: canonicalLongDay === 'sunday' ? 'saturday' : 'sunday',
      sessionType: 'run',
      title: 'Base + Strides',
      durationMinutes: 50,
      description: 'Easy aerobic run finished with relaxed strides and mobility.',
      exercises: [],
    },
  ];

  const strengthTemplates = [
    {
      dayOfWeek: 'monday',
      sessionType: 'gym',
      title: 'Runner Strength A',
      durationMinutes: 40,
      description: 'Runner-supportive strength focused on hips, posterior chain, and trunk stability.',
      exercises: runnerStrengthExercises(),
    },
    {
      dayOfWeek: 'wednesday',
      sessionType: 'gym',
      title: 'Runner Strength B',
      durationMinutes: 40,
      description: 'Single-leg strength, calf durability, and controlled trunk work.',
      exercises: runnerStrengthExercises(),
    },
    {
      dayOfWeek: 'friday',
      sessionType: 'gym',
      title: 'Runner Strength C',
      durationMinutes: 35,
      description: 'Short lower-load durability lift that keeps the legs fresh for key run work.',
      exercises: runnerStrengthExercises(),
    },
    {
      dayOfWeek: 'sunday',
      sessionType: 'gym',
      title: 'Mobility + Strength Support',
      durationMinutes: 30,
      description: 'Short support lift with mobility and tissue resilience work.',
      exercises: runnerStrengthExercises(),
    },
    {
      dayOfWeek: 'tuesday',
      sessionType: 'gym',
      title: 'Runner Strength D',
      durationMinutes: 35,
      description: 'Upper-body and trunk support that preserves posture without adding heavy leg fatigue.',
      exercises: runnerUpperSupportExercises(),
    },
    {
      dayOfWeek: 'thursday',
      sessionType: 'gym',
      title: 'Runner Strength E',
      durationMinutes: 35,
      description: 'Calf, hip, and trunk durability work kept controlled for high-frequency running weeks.',
      exercises: runnerDurabilityExercises(),
    },
  ];

  const runSessionCount = Math.max(1, Math.min(runTemplates.length, sessionsPerWeek));
  const selectedRunTemplates = runTemplates.slice(0, runSessionCount);
  const longRunTemplate = runTemplates.find((session) => session.title === 'Long Run');

  // Even lean running plans need a true long run; otherwise the requested long-workout day is ignored.
  if (
    longRunTemplate &&
    selectedRunTemplates.length > 0 &&
    !selectedRunTemplates.some((session) => session.title === 'Long Run')
  ) {
    selectedRunTemplates[selectedRunTemplates.length - 1] = longRunTemplate;
  }

  return [
    ...selectedRunTemplates,
    ...strengthTemplates.slice(0, Math.max(0, Math.min(strengthTemplates.length, strengthSessionsPerWeek))),
  ];
}

function baseStrengthExercises() {
  return [
    { name: 'Goblet Squat', sets: 4, reps: 8, rpe: '7', restSec: 90 },
    { name: 'Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 90 },
    { name: 'Push-Up / DB Press', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'One-Arm Row', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Front Plank', sets: 3, reps: 45, rpe: '6', restSec: 45 },
  ];
}

function runnerStrengthExercises() {
  return [
    { name: 'Split Squat', sets: 3, reps: 8, rpe: '7', restSec: 75 },
    { name: 'Single-Leg RDL', sets: 3, reps: 8, rpe: '7', restSec: 75 },
    { name: 'Step-Up', sets: 3, reps: 10, rpe: '7', restSec: 60 },
    { name: 'Calf Raise', sets: 3, reps: 15, rpe: '7', restSec: 45 },
    { name: 'Dead Bug', sets: 3, reps: 10, rpe: '6', restSec: 45 },
  ];
}

function runnerUpperSupportExercises() {
  return [
    { name: 'Incline DB Press', sets: 3, reps: 10, rpe: '7', restSec: 60 },
    { name: 'One-Arm Row', sets: 3, reps: 10, rpe: '7', restSec: 60 },
    { name: 'Pallof Press', sets: 3, reps: 12, rpe: '6', restSec: 45 },
    { name: 'Suitcase Carry', sets: 3, reps: 40, rpe: '7', restSec: 45 },
  ];
}

function runnerDurabilityExercises() {
  return [
    { name: 'Calf Raise', sets: 4, reps: 12, rpe: '7', restSec: 45 },
    { name: 'Glute Bridge', sets: 3, reps: 12, rpe: '7', restSec: 60 },
    { name: 'Lateral Lunge', sets: 3, reps: 8, rpe: '7', restSec: 60 },
    { name: 'Dead Bug', sets: 3, reps: 10, rpe: '6', restSec: 45 },
  ];
}

function upperBodyExercises() {
  return [
    { name: 'Bench Press', sets: 4, reps: 8, rpe: '7-8', restSec: 90 },
    { name: 'Chest-Supported Row', sets: 4, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Incline DB Press', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Lateral Raise', sets: 3, reps: 15, rpe: '8', restSec: 45 },
    { name: 'Cable / Band Triceps Pressdown', sets: 3, reps: 12, rpe: '8', restSec: 45 },
  ];
}

function lowerBodyExercises() {
  return [
    { name: 'Back Squat', sets: 4, reps: 6, rpe: '7-8', restSec: 120 },
    { name: 'Walking Lunge', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Leg Curl', sets: 3, reps: 12, rpe: '8', restSec: 60 },
    { name: 'Hanging Knee Raise', sets: 3, reps: 12, rpe: '7', restSec: 45 },
  ];
}

function upperBodyBExercises() {
  return [
    { name: 'Overhead Press', sets: 4, reps: 6, rpe: '7-8', restSec: 90 },
    { name: 'Lat Pulldown / Pull-Up', sets: 4, reps: 8, rpe: '7', restSec: 75 },
    { name: 'Seated Cable Row', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Incline Curl', sets: 3, reps: 12, rpe: '8', restSec: 45 },
    { name: 'Face Pull', sets: 3, reps: 15, rpe: '8', restSec: 45 },
  ];
}

function lowerBodyBExercises() {
  return [
    { name: 'Romanian Deadlift', sets: 4, reps: 6, rpe: '7-8', restSec: 105 },
    { name: 'Leg Press', sets: 3, reps: 10, rpe: '7', restSec: 90 },
    { name: 'Bulgarian Split Squat', sets: 3, reps: 8, rpe: '8', restSec: 75 },
    { name: 'Seated Calf Raise', sets: 3, reps: 15, rpe: '8', restSec: 45 },
    { name: 'Pallof Press', sets: 3, reps: 12, rpe: '6', restSec: 45 },
  ];
}

function upperBodyCExercises() {
  return [
    { name: 'Machine Chest Press', sets: 3, reps: 10, rpe: '7-8', restSec: 75 },
    { name: 'Lat Pulldown / Pull-Up', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Seated Cable Row', sets: 3, reps: 12, rpe: '7', restSec: 60 },
    { name: 'Lateral Raise', sets: 3, reps: 15, rpe: '8', restSec: 45 },
    { name: 'Incline Curl', sets: 3, reps: 12, rpe: '8', restSec: 45 },
  ];
}

function lowerBodyCExercises() {
  return [
    { name: 'Hip Thrust', sets: 4, reps: 8, rpe: '7-8', restSec: 90 },
    { name: 'Single-Leg RDL', sets: 3, reps: 8, rpe: '7', restSec: 75 },
    { name: 'Leg Curl', sets: 3, reps: 12, rpe: '8', restSec: 60 },
    { name: 'Calf Raise', sets: 4, reps: 12, rpe: '8', restSec: 45 },
    { name: 'Side Plank', sets: 3, reps: 40, rpe: '6', restSec: 45 },
  ];
}
