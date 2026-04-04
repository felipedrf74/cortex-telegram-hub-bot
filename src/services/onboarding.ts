// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Onboarding Questionnaire Engine
 *
 * Manages multi-step profiling questionnaires for different domains.
 * Each questionnaire is a sequence of steps with typed answers.
 * Sessions persist across bot restarts via SQLite.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { isOwner } from './user-service';
import { isSkillEnabled } from './user-skill-access';

// ── Types ──────────────────────────────────────────────────────────

export type AnswerType = 'choice' | 'text' | 'number' | 'multi_choice';

export interface QuestionStep {
  key: string;
  prompt: string;
  type: AnswerType;
  options?: string[];       // For choice/multi_choice types
  validation?: RegExp;      // For text/number types
  required?: boolean;       // Default true
}

export interface QuestionnaireDefinition {
  id: string;
  title: string;
  description: string;
  steps: QuestionStep[];
}

export interface OnboardingSession {
  id: number;
  user_id: number;
  questionnaire: string;
  current_step: number;
  answers: Record<string, string>;
  status: 'in_progress' | 'completed' | 'abandoned';
  created_at: string;
  completed_at: string | null;
}

export interface UserProfile {
  id: number;
  user_id: number;
  profile_type: string;
  data: Record<string, string>;
  created_at: string;
  updated_at: string;
}

// ── Questionnaire Definitions ──────────────────────────────────────

export const QUESTIONNAIRES: Record<string, QuestionnaireDefinition> = {
  fitness: {
    id: 'fitness',
    title: '🏋️ Fitness Profile',
    description: 'Set up your training profile for personalized coaching',
    steps: [
      {
        key: 'experience_level',
        prompt: 'What is your training experience level?',
        type: 'choice',
        options: ['Beginner (< 1 year)', 'Intermediate (1-3 years)', 'Advanced (3+ years)'],
      },
      {
        key: 'weekly_frequency',
        prompt: 'How many days per week do you train?',
        type: 'choice',
        options: ['2-3 days', '4-5 days', '6+ days'],
      },
      {
        key: 'training_goals',
        prompt: 'What are your primary training goals?',
        type: 'multi_choice',
        options: ['Strength', 'Hypertrophy', 'Endurance', 'Weight loss', 'General fitness'],
      },
      {
        key: 'injuries',
        prompt: 'Any current injuries or limitations? (type "none" if no injuries)',
        type: 'text',
      },
      {
        key: 'available_equipment',
        prompt: 'What equipment do you have access to?',
        type: 'choice',
        options: ['Full gym', 'Home gym (basic)', 'Bodyweight only', 'Resistance bands'],
      },
    ],
  },

  diet: {
    id: 'diet',
    title: '🥩 Diet Profile',
    description: 'Configure your nutrition preferences for meal guidance',
    steps: [
      {
        key: 'diet_type',
        prompt: 'What is your dietary approach?',
        type: 'choice',
        options: ['Carnivore', 'Keto', 'Low-carb', 'Balanced', 'Vegetarian', 'Other'],
      },
      {
        key: 'weight_kg',
        prompt: 'What is your current weight in kg?',
        type: 'number',
        validation: /^\d{2,3}(\.\d)?$/,
      },
      {
        key: 'height_cm',
        prompt: 'What is your height in cm?',
        type: 'number',
        validation: /^\d{2,3}$/,
      },
      {
        key: 'allergies',
        prompt: 'Any food allergies or intolerances? (type "none" if none)',
        type: 'text',
      },
      {
        key: 'meal_frequency',
        prompt: 'How many meals per day do you prefer?',
        type: 'choice',
        options: ['2 meals (IF/OMAD)', '3 meals', '4-5 meals', '6+ meals'],
      },
      {
        key: 'nutrition_goal',
        prompt: 'What is your primary nutrition goal?',
        type: 'choice',
        options: ['Muscle gain', 'Fat loss', 'Maintenance', 'Performance', 'Health optimization'],
      },
    ],
  },

  homeschool: {
    id: 'homeschool',
    title: '📚 Homeschool Profile',
    description: 'Set up your homeschool learning profile',
    steps: [
      {
        key: 'child_age',
        prompt: 'How old is the child?',
        type: 'number',
        validation: /^\d{1,2}$/,
      },
      {
        key: 'grade_level',
        prompt: 'Current grade level or equivalent?',
        type: 'choice',
        options: ['Pre-K', 'K-2', '3-5', '6-8', '9-12'],
      },
      {
        key: 'learning_style',
        prompt: 'What learning style works best?',
        type: 'choice',
        options: ['Visual', 'Auditory', 'Hands-on/Kinesthetic', 'Reading/Writing', 'Mixed'],
      },
      {
        key: 'subjects_focus',
        prompt: 'Which subjects need the most focus?',
        type: 'multi_choice',
        options: ['Math', 'Reading', 'Science', 'History', 'Languages', 'Arts', 'Physical Ed'],
      },
      {
        key: 'schedule_preference',
        prompt: 'What is your preferred daily schedule?',
        type: 'choice',
        options: ['Morning only (8-12)', 'Full day (8-15)', 'Afternoon (13-17)', 'Flexible'],
      },
    ],
  },
};

// ── Session Management ─────────────────────────────────────────────

/** Start or resume an onboarding session. Returns the current step. */
export function startOrResume(userId: number, questionnaireId: string): OnboardingSession {
  const db = getDb();
  const def = QUESTIONNAIRES[questionnaireId];
  if (!def) throw new Error(`Unknown questionnaire: ${questionnaireId}`);

  // Check for existing in-progress session
  const existing = db.prepare(
    "SELECT * FROM onboarding_sessions WHERE user_id = ? AND questionnaire = ? AND status = 'in_progress'",
  ).get(userId, questionnaireId) as any;

  if (existing) {
    return parseSession(existing);
  }

  // Create new session (upsert — may replace an abandoned/completed one)
  db.prepare(`
    INSERT INTO onboarding_sessions (user_id, questionnaire, current_step, answers, status)
    VALUES (?, ?, 0, '{}', 'in_progress')
    ON CONFLICT(user_id, questionnaire) DO UPDATE SET
      current_step = 0,
      answers = '{}',
      status = 'in_progress',
      completed_at = NULL,
      created_at = datetime('now')
  `).run(userId, questionnaireId);

  const row = db.prepare(
    'SELECT * FROM onboarding_sessions WHERE user_id = ? AND questionnaire = ?',
  ).get(userId, questionnaireId) as any;

  logger.info({ userId, questionnaire: questionnaireId }, 'Onboarding session started');
  return parseSession(row);
}

/** Record an answer for the current step and advance. Returns null if completed. */
export function answerStep(
  userId: number,
  questionnaireId: string,
  answer: string,
): { nextStep: QuestionStep | null; session: OnboardingSession } {
  const db = getDb();
  const def = QUESTIONNAIRES[questionnaireId];
  if (!def) throw new Error(`Unknown questionnaire: ${questionnaireId}`);

  const session = getActiveSession(userId, questionnaireId);
  if (!session) throw new Error('No active session');

  const currentStep = def.steps[session.current_step];
  if (!currentStep) throw new Error('Session already at last step');

  // Validate answer
  if (currentStep.validation && !currentStep.validation.test(answer)) {
    throw new Error(`Invalid answer format for ${currentStep.key}`);
  }

  // Store answer
  const answers = { ...session.answers, [currentStep.key]: answer };
  const nextStepIdx = session.current_step + 1;
  const isComplete = nextStepIdx >= def.steps.length;

  db.prepare(`
    UPDATE onboarding_sessions
    SET answers = ?, current_step = ?, status = ?, completed_at = ?
    WHERE user_id = ? AND questionnaire = ? AND status = 'in_progress'
  `).run(
    JSON.stringify(answers),
    nextStepIdx,
    isComplete ? 'completed' : 'in_progress',
    isComplete ? new Date().toISOString() : null,
    userId,
    questionnaireId,
  );

  // If completed, save profile
  if (isComplete) {
    saveProfile(userId, questionnaireId, answers);
    logger.info({ userId, questionnaire: questionnaireId }, 'Onboarding completed');
  }

  const updatedSession: OnboardingSession = {
    ...session,
    answers,
    current_step: nextStepIdx,
    status: isComplete ? 'completed' : 'in_progress',
  };

  return {
    nextStep: isComplete ? null : def.steps[nextStepIdx],
    session: updatedSession,
  };
}

/** Get the current question step for an active session. Returns null if no active session. */
export function getCurrentStep(userId: number, questionnaireId: string): QuestionStep | null {
  const def = QUESTIONNAIRES[questionnaireId];
  if (!def) return null;

  const session = getActiveSession(userId, questionnaireId);
  if (!session) return null;

  return def.steps[session.current_step] || null;
}

/** Get an active (in-progress) session. */
export function getActiveSession(userId: number, questionnaireId: string): OnboardingSession | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM onboarding_sessions WHERE user_id = ? AND questionnaire = ? AND status = 'in_progress'",
  ).get(userId, questionnaireId) as any;
  return row ? parseSession(row) : null;
}

/** Abandon an active session. */
export function abandonSession(userId: number, questionnaireId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE onboarding_sessions SET status = 'abandoned' WHERE user_id = ? AND questionnaire = ? AND status = 'in_progress'",
  ).run(userId, questionnaireId);
  return result.changes > 0;
}

// ── Profile Management ─────────────────────────────────────────────

/** Save a completed questionnaire as a user profile. */
function saveProfile(userId: number, profileType: string, data: Record<string, string>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_profiles (user_id, profile_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, profile_type) DO UPDATE SET
      data = excluded.data,
      updated_at = datetime('now')
  `).run(userId, profileType, JSON.stringify(data));
}

/** Get a user profile. Returns null if not found. */
export function getProfile(userId: number, profileType: string): UserProfile | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM user_profiles WHERE user_id = ? AND profile_type = ?',
  ).get(userId, profileType) as any;
  if (!row) return null;
  return {
    ...row,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
  };
}

/** Get all profiles for a user. */
export function getAllProfiles(userId: number): UserProfile[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM user_profiles WHERE user_id = ? ORDER BY profile_type',
  ).all(userId) as any[];
  return rows.map(r => ({
    ...r,
    data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
  }));
}

/** Get available questionnaire IDs. */
export function getAvailableQuestionnaires(): string[] {
  return Object.keys(QUESTIONNAIRES);
}

/** Get a questionnaire definition by ID. */
export function getQuestionnaire(id: string): QuestionnaireDefinition | undefined {
  return QUESTIONNAIRES[id];
}

// ── Helpers ────────────────────────────────────────────────────────

function parseSession(row: any): OnboardingSession {
  return {
    id: row.id,
    user_id: row.user_id,
    questionnaire: row.questionnaire,
    current_step: row.current_step,
    answers: typeof row.answers === 'string' ? JSON.parse(row.answers) : row.answers,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

// ── Skill → Questionnaire Mapping ───────────────────────────────────

/** Maps skills to their onboarding questionnaire IDs */
export const SKILL_ONBOARDING_MAP: Record<string, string | null> = {
  secretary: null,
  triathlon: 'fitness',
  content: null,
  cooking: 'diet',
  finance: null,
};

/** Reverse: which skill does this questionnaire serve? */
export const QUESTIONNAIRE_SKILL_MAP: Record<string, string> = {
  fitness: 'triathlon',
  diet: 'cooking',
};

/**
 * Get questionnaire IDs enabled for a user based on their skill access.
 * Owner sees all questionnaires.
 */
export function getEnabledQuestionnaires(userId: number): string[] {
  try {
    if (isOwner(userId)) {
      return getAvailableQuestionnaires();
    }

    return Object.entries(SKILL_ONBOARDING_MAP)
      .filter(([skill, qId]) => qId !== null && isSkillEnabled(userId, skill))
      .map(([, qId]) => qId!)
      .filter(qId => !!getQuestionnaire(qId));
  } catch {
    return getAvailableQuestionnaires(); // fallback to all if skill system not loaded
  }
}

/**
 * Get questionnaire IDs that are enabled but not yet completed.
 */
export function getPendingOnboardings(userId: number): string[] {
  return getEnabledQuestionnaires(userId).filter(qId => {
    const profile = getProfile(userId, qId);
    return !profile;
  });
}
