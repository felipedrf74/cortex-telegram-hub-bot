// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export interface TrainingSessionClassificationInput {
  sessionType?: string;
  title?: string;
  exercises?: Array<Record<string, any>>;
}

const LOWER_BODY_EXERCISE_TOKENS = [
  'squat',
  'deadlift',
  'rdl',
  'lunge',
  'split squat',
  'leg press',
  'leg extension',
  'leg curl',
  'hip thrust',
  'glute bridge',
  'good morning',
  'step up',
  'box jump',
];

export function flattenTrainingExerciseTokens(exercises: Array<Record<string, any>> | undefined): string[] {
  if (!exercises?.length) return [];
  const tokens: string[] = [];
  for (const ex of exercises) {
    if (!ex || typeof ex !== 'object') continue;
    for (const key of ['name', 'exercise', 'movement', 'equipment', 'tags']) {
      const val = (ex as any)[key];
      if (typeof val === 'string' && val.trim()) tokens.push(val.toLowerCase().trim());
      if (Array.isArray(val)) {
        for (const v of val) {
          if (typeof v === 'string' && v.trim()) tokens.push(v.toLowerCase().trim());
        }
      }
    }
  }
  return tokens;
}

export function inferTrainingSessionIsLowerHeavy(
  sessionData: TrainingSessionClassificationInput,
  exerciseTokens = flattenTrainingExerciseTokens(sessionData.exercises),
): boolean {
  const sessionType = String(sessionData.sessionType || '').toLowerCase();
  if (sessionType !== 'gym' && !sessionType.startsWith('strength') && sessionType !== 'lift') {
    return false;
  }

  const title = String(sessionData.title || '').toLowerCase();
  if (title.includes('lower') || title.includes('squat') || title.includes('deadlift')) {
    return true;
  }

  return LOWER_BODY_EXERCISE_TOKENS.some((tok) =>
    exerciseTokens.some((existing) => existing.includes(tok)),
  );
}

export function inferTrainingSessionIsLongRun(sessionData: TrainingSessionClassificationInput): boolean {
  const sessionType = String(sessionData.sessionType || '').toLowerCase();
  if (sessionType === 'long_run') return true;
  const title = String(sessionData.title || '').toLowerCase();
  return /\blong\s+run\b/.test(title);
}
