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
import { getUserById, getUserByTelegramId, isOwner } from './user-service';
import { checkSkillAccess } from './skill-tiers';

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

/**
 * Beta gap 3 (2026-04-24): raised when a client sends `stepIndex`
 * greater than the server's current step — i.e. trying to answer a
 * question that hasn't been reached yet. Carries the server's real
 * `currentStep` so the route can return it and the client can reconcile.
 *
 * The symmetric "client is BEHIND the server" case (retry of an
 * already-answered step) is NOT an error — `answerStep` handles it
 * idempotently by returning the current state unchanged.
 */
export class OnboardingStepMismatchError extends Error {
  constructor(public readonly expectedStepIndex: number, public readonly currentStepIndex: number) {
    super(`Step mismatch: client sent stepIndex=${expectedStepIndex} but server is on step ${currentStepIndex}`);
    this.name = 'OnboardingStepMismatchError';
  }
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

  // ─── Phase 2 Slice B — Per-sport profiling questionnaires ────────
  //
  // Each sport coach (gym/running/cycling/swim) needs specific baseline
  // data before it can generate useful prescriptions. These are 6-8
  // questions each, 5-10 per the Phase 1 decision 1.5 anchor range.
  // They're OPT-IN — the user only answers a sport's questionnaire
  // when they care about that sport. Running-only users never see
  // FTP questions; gym-only users never see 400m swim times.
  //
  // The existing `fitness` questionnaire stays as-is for backwards
  // compatibility — users who filled it out before Phase 2 keep that
  // data. The new sport-specific profiles layer on top.

  'triathlon-gym': {
    id: 'triathlon-gym',
    title: '🏋️ Strength Training Profile',
    description: 'Tell the gym coach about your lifting background',
    steps: [
      {
        key: 'training_age',
        prompt: 'How long have you been seriously strength training?',
        type: 'choice',
        options: ['< 1 year', '1-3 years', '3-5 years', '5+ years'],
      },
      {
        key: 'current_split',
        prompt: 'What training split do you prefer?',
        type: 'choice',
        options: ['Full body', 'Upper/Lower', 'Push-Pull-Legs', 'Body part split', 'No preference'],
      },
      {
        key: 'primary_goal',
        prompt: 'What is your primary gym goal right now?',
        type: 'choice',
        options: ['Strength (1RM)', 'Hypertrophy', 'Powerlifting', 'General fitness', 'Support other sports'],
      },
      {
        key: 'squat_1rm_kg',
        prompt: 'Approximate squat 1RM in kg (estimate if unsure, 0 if new)',
        type: 'number',
        validation: /^\d{1,3}(\.\d)?$/,
      },
      {
        key: 'bench_1rm_kg',
        prompt: 'Approximate bench press 1RM in kg (estimate if unsure, 0 if new)',
        type: 'number',
        validation: /^\d{1,3}(\.\d)?$/,
      },
      {
        key: 'deadlift_1rm_kg',
        prompt: 'Approximate deadlift 1RM in kg (estimate if unsure, 0 if new)',
        type: 'number',
        validation: /^\d{1,3}(\.\d)?$/,
      },
      {
        key: 'sessions_per_week',
        prompt: 'How many gym sessions can you realistically do per week?',
        type: 'choice',
        options: ['1-2', '3', '4', '5+'],
      },
      {
        key: 'equipment_access',
        prompt: 'What equipment do you have access to?',
        type: 'choice',
        options: ['Full commercial gym', 'Garage gym (barbell + rack)', 'Home gym (basic)', 'Bodyweight only'],
      },
    ],
  },

  'triathlon-running': {
    id: 'triathlon-running',
    title: '🏃 Running Profile',
    description: 'Tell the running coach about your running background',
    steps: [
      {
        key: 'weekly_mileage_km',
        prompt: 'Current weekly mileage in km (0 if just starting)',
        type: 'number',
        validation: /^\d{1,3}(\.\d)?$/,
      },
      {
        key: 'longest_recent_run_km',
        prompt: 'Longest run in the past month (km)',
        type: 'number',
        validation: /^\d{1,3}(\.\d)?$/,
      },
      {
        key: 'easy_pace_min_per_km',
        prompt: 'Comfortable easy pace in min/km (e.g. 6:00)',
        type: 'text',
        validation: /^\d{1,2}:\d{2}$/,
      },
      {
        key: 'target_race',
        prompt: 'What is your next target race?',
        type: 'choice',
        options: ['5k', '10k', 'Half marathon', 'Marathon', 'Ultra', 'None — general fitness'],
      },
      {
        key: 'target_race_date',
        prompt: 'Target race date (YYYY-MM-DD) or "none"',
        type: 'text',
      },
      {
        key: 'preferred_workouts',
        prompt: 'Which workout types do you enjoy most?',
        type: 'multi_choice',
        options: ['Easy runs', 'Tempo', 'Intervals', 'Long runs', 'Hills', 'Trail'],
      },
      {
        key: 'injury_history',
        prompt: 'Any running-related injuries in the past 12 months? (type "none" if none)',
        type: 'text',
      },
      {
        key: 'weekly_availability_days',
        prompt: 'How many days per week can you run?',
        type: 'choice',
        options: ['2', '3', '4', '5', '6+'],
      },
    ],
  },

  'triathlon-cycling': {
    id: 'triathlon-cycling',
    title: '🚴 Cycling Profile',
    description: 'Tell the cycling coach about your riding background',
    steps: [
      {
        key: 'ftp_watts',
        prompt: 'Current FTP in watts (0 if unknown — we can estimate)',
        type: 'number',
        validation: /^\d{1,3}$/,
      },
      {
        key: 'weekly_hours',
        prompt: 'How many hours per week do you typically ride?',
        type: 'choice',
        options: ['< 3 hours', '3-6 hours', '6-10 hours', '10+ hours'],
      },
      {
        key: 'primary_discipline',
        prompt: 'What kind of riding do you do most?',
        type: 'choice',
        options: ['Road', 'Gravel', 'MTB', 'Indoor trainer', 'Commute', 'Mixed'],
      },
      {
        key: 'target_event',
        prompt: 'Next target event?',
        type: 'choice',
        options: ['Road race', 'Time trial', 'Gran fondo', 'Gravel event', 'Triathlon bike leg', 'None'],
      },
      {
        key: 'power_meter',
        prompt: 'Do you train with a power meter?',
        type: 'choice',
        options: ['Yes — outdoor + indoor', 'Indoor only (smart trainer)', 'No — HR + RPE'],
      },
      {
        key: 'terrain_preference',
        prompt: 'Terrain preference?',
        type: 'choice',
        options: ['Flat', 'Rolling hills', 'Mountains', 'Mixed'],
      },
      {
        key: 'weekly_availability_days',
        prompt: 'How many days per week can you ride?',
        type: 'choice',
        options: ['2', '3', '4', '5', '6+'],
      },
    ],
  },

  'triathlon-swim': {
    id: 'triathlon-swim',
    title: '🏊 Swim Profile',
    description: 'Tell the swim coach about your swimming background',
    steps: [
      {
        key: 'experience',
        prompt: 'What is your swimming background?',
        type: 'choice',
        options: ['Total beginner', 'Recreational', 'Fitness swimmer', 'Competitive (past or current)'],
      },
      {
        key: 'primary_stroke',
        prompt: 'Your most comfortable stroke?',
        type: 'choice',
        options: ['Freestyle', 'Backstroke', 'Breaststroke', 'Butterfly', 'Equally comfortable'],
      },
      {
        key: 'time_400m_freestyle_min',
        prompt: 'Approximate 400m freestyle time (mm:ss, "unknown" if new)',
        type: 'text',
      },
      {
        key: 'pool_access',
        prompt: 'What pool access do you have?',
        type: 'choice',
        options: ['25m indoor', '50m indoor', '25m outdoor', '50m outdoor', 'Open water', 'Limited/none'],
      },
      {
        key: 'goal',
        prompt: 'Primary swim goal?',
        type: 'choice',
        options: ['Fitness', 'Technique improvement', 'Distance event', 'Triathlon swim leg', 'Competition'],
      },
      {
        key: 'sessions_per_week',
        prompt: 'How many swim sessions per week can you do?',
        type: 'choice',
        options: ['1', '2', '3', '4+'],
      },
      {
        key: 'equipment_access',
        prompt: 'Swim equipment available?',
        type: 'multi_choice',
        options: ['Pull buoy', 'Paddles', 'Fins', 'Snorkel', 'Kickboard', 'Tempo trainer', 'None yet'],
      },
    ],
  },
};

// ── Session Management ─────────────────────────────────────────────

/**
 * Start or resume an onboarding session. Returns the current step.
 * Sport aliases ('running', …) are canonicalized at entry so session
 * rows and the eventual profile row always use the canonical id.
 */
export function startOrResume(userId: number, rawQuestionnaireId: string): OnboardingSession {
  const db = getDb();
  const questionnaireId = canonicalProfileType(rawQuestionnaireId);
  const def = QUESTIONNAIRES[questionnaireId];
  if (!def) throw new Error(`Unknown questionnaire: ${rawQuestionnaireId}`);

  // Check for existing in-progress session
  const existing = db.prepare(
    "SELECT * FROM onboarding_sessions WHERE user_id = ? AND questionnaire = ? AND status = 'in_progress'",
  ).get(userId, questionnaireId) as any;

  if (existing) {
    return parseSession(existing);
  }

  // Beta gap 3 (2026-04-24) — self-heal divergence between
  // `onboarding_sessions.status='completed'` and `user_profiles`.
  //
  // Pre-fix, `answerStep` updated the session row and then wrote the
  // profile in two separate statements. A crash (or a DB-locked retry)
  // between them could leave the session marked completed with no
  // matching profile row. The user then got stuck: getPendingOnboardings
  // saw "no profile" and treated the questionnaire as pending, but
  // startOrResume below would CLOBBER the completed session back to
  // step 0 — erasing the answers the user had just finished giving.
  //
  // Going forward answerStep runs inside a transaction so this class
  // of divergence can't reappear. The self-heal here covers existing
  // users whose sessions were broken before the fix landed.
  //
  // We intentionally PRESERVE the legacy "reset to step 0 on re-entry"
  // behavior for completed sessions — tests + handlers rely on it for
  // the re-take flow. The heal just makes sure the profile row is
  // written (so pending/completed lookups converge) BEFORE the reset
  // discards the answers on the session row.
  const completedRow = db.prepare(
    "SELECT answers FROM onboarding_sessions WHERE user_id = ? AND questionnaire = ? AND status = 'completed'",
  ).get(userId, questionnaireId) as { answers?: string | Record<string, string> } | undefined;
  if (completedRow) {
    const hasProfile = Boolean(
      db.prepare(
        'SELECT 1 FROM user_profiles WHERE user_id = ? AND profile_type = ?',
      ).get(userId, questionnaireId),
    );
    if (!hasProfile) {
      let answers: Record<string, string> = {};
      try {
        answers = typeof completedRow.answers === 'string'
          ? JSON.parse(completedRow.answers)
          : (completedRow.answers ?? {});
      } catch {
        answers = {};
      }
      if (Object.keys(answers).length > 0) {
        saveProfile(userId, questionnaireId, answers);
        logger.warn(
          { userId, questionnaire: questionnaireId, recoveredFields: Object.keys(answers).length },
          'Onboarding self-heal: re-saved profile from completed session missing a profile row',
        );
      }
    }
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

/**
 * Record an answer for the current step and advance. Returns `nextStep:null`
 * when the questionnaire is complete.
 *
 * Beta gap 3 (2026-04-24):
 *
 *  1. `options.expectedStepIndex` makes the answer write idempotent under
 *     retry. iOS sends the stepIndex it believes it's answering. If the
 *     server is ALREADY past that step — e.g. a previous request succeeded
 *     but the client didn't see the 200 — we return the current state as
 *     a no-op success instead of double-writing the answer. If the client
 *     is AHEAD of the server we throw OnboardingStepMismatchError so the
 *     route can return a 409 with the server's real step and the client
 *     can reconcile. When `expectedStepIndex` is omitted, behavior is
 *     unchanged (used by Telegram handlers that drive the flow linearly).
 *
 *  2. The session UPDATE + profile INSERT now run in a single SQLite
 *     transaction. Previously a crash between the two statements could
 *     leave the session marked completed with no profile row, a state
 *     the startOrResume self-heal recovers from.
 */
export function answerStep(
  userId: number,
  rawQuestionnaireId: string,
  answer: string,
  options: { expectedStepIndex?: number } = {},
): { nextStep: QuestionStep | null; session: OnboardingSession; idempotentReplay?: boolean } {
  const db = getDb();
  // Canonicalize like startOrResume so an alias-id answer addresses
  // the same session row the canonical start created.
  const questionnaireId = canonicalProfileType(rawQuestionnaireId);
  const def = QUESTIONNAIRES[questionnaireId];
  if (!def) throw new Error(`Unknown questionnaire: ${rawQuestionnaireId}`);

  const session = getActiveSession(userId, questionnaireId);
  if (!session) throw new Error('No active session');

  const { expectedStepIndex } = options;
  if (typeof expectedStepIndex === 'number') {
    if (expectedStepIndex < session.current_step) {
      // Client is re-sending a step the server already advanced past.
      // Treat as an idempotent no-op — DO NOT overwrite the already-
      // stored answer or advance the cursor. Return the current state
      // so the client converges on the server's view.
      const isComplete = session.current_step >= def.steps.length;
      logger.info(
        {
          userId,
          questionnaire: questionnaireId,
          clientStep: expectedStepIndex,
          serverStep: session.current_step,
        },
        'Onboarding answer replay suppressed (idempotent retry)',
      );
      return {
        nextStep: isComplete ? null : def.steps[session.current_step],
        session,
        idempotentReplay: true,
      };
    }
    if (expectedStepIndex > session.current_step) {
      // Client thinks we're further ahead than we actually are —
      // skipping a step we haven't answered yet. Surface a typed
      // error so the route can 409 with the real cursor.
      throw new OnboardingStepMismatchError(expectedStepIndex, session.current_step);
    }
  }

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

  // Transactional write: the session advancement and the terminal
  // saveProfile upsert must either both commit or both roll back.
  // Without this, a crash between UPDATE and INSERT leaves the user
  // with a status='completed' session and no profile row — the stuck
  // state the startOrResume self-heal now recovers from, but should
  // not be allowed to recur for users running the fixed code path.
  const commit = db.transaction(() => {
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

    if (isComplete) {
      saveProfile(userId, questionnaireId, answers);
    }
  });
  commit();

  if (isComplete) {
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
export function getCurrentStep(userId: number, rawQuestionnaireId: string): QuestionStep | null {
  const questionnaireId = canonicalProfileType(rawQuestionnaireId);
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
  ).get(userId, canonicalProfileType(questionnaireId)) as any;
  return row ? parseSession(row) : null;
}

/** Abandon an active session. */
export function abandonSession(userId: number, questionnaireId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE onboarding_sessions SET status = 'abandoned' WHERE user_id = ? AND questionnaire = ? AND status = 'in_progress'",
  ).run(userId, canonicalProfileType(questionnaireId));
  return result.changes > 0;
}

// ── Profile Management ─────────────────────────────────────────────

// Profile-type equivalence. The canonical questionnaire ids double as
// profile_type values ('triathlon-running', …), but rows under bare
// sport keys exist in real databases (manual ops, legacy writers —
// decision-center already special-cases a legacy 'training' type).
// `user_profiles.profile_type` is free text with no FK, so reads must
// treat an alias row as the same profile and writes must land on the
// canonical key, or the plan-generation profile gate silently ignores
// a completed profile (rerun-7 B2). Mirrors SPORT_TO_PROFILE_TYPE in
// domains/domain-handler.ts.
const PROFILE_TYPE_ALIASES: Record<string, string> = {
  running: 'triathlon-running',
  gym: 'triathlon-gym',
  cycling: 'triathlon-cycling',
  swim: 'triathlon-swim',
};

/** Map a profile type / questionnaire id to its canonical form. */
export function canonicalProfileType(profileType: string): string {
  return PROFILE_TYPE_ALIASES[profileType] ?? profileType;
}

/** Every stored key that means the same profile, canonical first. */
function profileTypeEquivalents(profileType: string): string[] {
  const canonical = canonicalProfileType(profileType);
  const aliases = Object.keys(PROFILE_TYPE_ALIASES)
    .filter((alias) => PROFILE_TYPE_ALIASES[alias] === canonical);
  return [canonical, ...aliases];
}

/** Save a completed questionnaire as a user profile. */
function saveProfile(userId: number, profileType: string, data: Record<string, string>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_profiles (user_id, profile_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, profile_type) DO UPDATE SET
      data = excluded.data,
      updated_at = datetime('now')
  `).run(userId, canonicalProfileType(profileType), JSON.stringify(data));
}

// ── Phase 3 Slice A — Chat-triggered onboarding helpers ──
//
// The existing questionnaire engine (startOrResume → answerStep → save)
// runs the user through a fixed-order Q&A and saves the profile only
// when every step is complete. That works for the iOS onboarding
// wizard, but it's too rigid for chat: the user might volunteer their
// squat 1RM while you're asking about training age. The chat coach
// needs to ingest answers in any order.
//
// These helpers bypass the session state machine and operate directly
// on the user_profiles row:
//
//   upsertProfileField      → write a single field
//   getMissingProfileFields → list fields the user hasn't answered yet
//   isProfileComplete       → boolean "we have everything we need"
//
// The coach LLM calls `upsertProfileField` via a new tool
// (`save_athlete_profile_field`) and the state context injection
// tells it which fields are still missing on every turn.

/**
 * Upsert a single profile field. Creates the profile row if it
 * doesn't exist, otherwise merges the new value into existing `data`.
 * Used by the chat coach to persist answers one at a time.
 */
export function upsertProfileField(
  userId: number,
  profileType: string,
  fieldKey: string,
  value: string,
): void {
  const db = getDb();
  // Read merges across the alias equivalence class; the write always
  // lands on the canonical key so alias rows stop accumulating.
  const canonicalType = canonicalProfileType(profileType);
  const existing = getProfile(userId, profileType);
  const data: Record<string, string> = { ...(existing?.data ?? {}) };
  data[fieldKey] = value;
  db.prepare(`
    INSERT INTO user_profiles (user_id, profile_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, profile_type) DO UPDATE SET
      data = excluded.data,
      updated_at = datetime('now')
  `).run(userId, canonicalType, JSON.stringify(data));
  logger.info({ userId, profileType: canonicalType, fieldKey }, 'Profile field upserted via chat');
}

/**
 * Return the questionnaire steps whose field key is NOT yet present
 * in the user's stored profile. Order matches the questionnaire
 * definition so the coach can ask questions in a stable sequence.
 */
export function getMissingProfileFields(
  userId: number,
  profileType: string,
): QuestionStep[] {
  const def = getQuestionnaire(profileType);
  if (!def) return [];
  const profile = getProfile(userId, profileType);
  const answered = new Set(Object.keys(profile?.data ?? {}));
  return def.steps.filter((step) => !answered.has(step.key));
}

/**
 * True when every question in the questionnaire has an answer in the
 * user's stored profile. Used to decide whether to inject the
 * onboarding-pending block into the triathlon coach's state context.
 */
export function isProfileComplete(
  userId: number,
  profileType: string,
): boolean {
  return getMissingProfileFields(userId, profileType).length === 0;
}

/**
 * Get a user profile. Returns null if not found. Matches the whole
 * equivalence class of the requested type (canonical + sport aliases),
 * preferring the canonical row, then the most recently updated — so a
 * profile stored under 'running' satisfies a 'triathlon-running' read
 * and vice versa.
 */
export function getProfile(userId: number, profileType: string): UserProfile | null {
  const db = getDb();
  const equivalents = profileTypeEquivalents(profileType);
  const placeholders = equivalents.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT * FROM user_profiles
      WHERE user_id = ? AND profile_type IN (${placeholders})
      ORDER BY CASE WHEN profile_type = ? THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
  ).get(userId, ...equivalents, equivalents[0]) as any;
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

/** Get a questionnaire definition by ID. Accepts sport aliases. */
export function getQuestionnaire(id: string): QuestionnaireDefinition | undefined {
  return QUESTIONNAIRES[canonicalProfileType(id)];
}

/** Alias kept for the iOS API route (onboarding.ts line 103). */
export function getAllQuestionnaires(): QuestionnaireDefinition[] {
  return Object.values(QUESTIONNAIRES);
}

// ── Phase 2 Slice B — Profile formatter for coach prompt injection ──

/**
 * The labels used when rendering a profile as a prompt block. We keep
 * these here (rather than in the coach persona files) so the formatter
 * owns the whole output — the coach just reads the block.
 *
 * Friendly labels matter: the coach LLM reads "Squat 1RM: 140 kg", not
 * "squat_1rm_kg: 140". Without humanizing the keys, the prompt would
 * look like a database dump.
 */
const PROFILE_FIELD_LABELS: Record<string, string> = {
  // Shared fitness
  experience_level: 'Training experience',
  weekly_frequency: 'Weekly frequency',
  training_goals: 'Goals',
  injuries: 'Injuries / limitations',
  available_equipment: 'Equipment access',
  // Gym
  training_age: 'Strength training experience',
  current_split: 'Preferred split',
  primary_goal: 'Gym goal',
  squat_1rm_kg: 'Squat 1RM (kg)',
  bench_1rm_kg: 'Bench 1RM (kg)',
  deadlift_1rm_kg: 'Deadlift 1RM (kg)',
  sessions_per_week: 'Sessions per week',
  equipment_access: 'Equipment access',
  // Running
  weekly_mileage_km: 'Weekly mileage (km)',
  longest_recent_run_km: 'Longest recent run (km)',
  easy_pace_min_per_km: 'Easy pace (min/km)',
  target_race: 'Target race',
  target_race_date: 'Target race date',
  preferred_workouts: 'Preferred workout types',
  injury_history: 'Injury history',
  weekly_availability_days: 'Days available per week',
  // Cycling
  ftp_watts: 'FTP (watts)',
  weekly_hours: 'Weekly hours',
  primary_discipline: 'Primary discipline',
  target_event: 'Target event',
  power_meter: 'Power meter',
  terrain_preference: 'Terrain preference',
  // Swim
  experience: 'Swim experience',
  primary_stroke: 'Primary stroke',
  time_400m_freestyle_min: '400m freestyle time',
  pool_access: 'Pool access',
  goal: 'Swim goal',
  // Diet
  diet_type: 'Diet',
  weight_kg: 'Weight (kg)',
  height_cm: 'Height (cm)',
  allergies: 'Allergies',
  meal_frequency: 'Meal frequency',
  nutrition_goal: 'Nutrition goal',
};

/** Map profile types to their header label for the prompt block. */
const PROFILE_TYPE_HEADERS: Record<string, string> = {
  fitness: 'Fitness basics',
  'triathlon-gym': 'Strength profile',
  'triathlon-running': 'Running profile',
  'triathlon-cycling': 'Cycling profile',
  'triathlon-swim': 'Swim profile',
  diet: 'Nutrition profile',
};

/** Humanize a snake_case field name, falling back when no label is defined. */
function labelFor(key: string): string {
  return PROFILE_FIELD_LABELS[key] ?? key.replace(/_/g, ' ');
}

/**
 * Render a single profile as a prompt-friendly block. Used by
 * formatAthleteProfileBlock but also exported for tests.
 *
 * Example output:
 *   [Strength profile]
 *   - Strength training experience: 3-5 years
 *   - Squat 1RM (kg): 150
 *   - Bench 1RM (kg): 100
 */
export function renderProfile(profile: UserProfile): string {
  const header = PROFILE_TYPE_HEADERS[profile.profile_type] ?? profile.profile_type;
  const lines: string[] = [`[${header}]`];
  for (const [key, value] of Object.entries(profile.data)) {
    // Skip empty, "none", or zero-valued numeric answers for clarity.
    // profile.data is typed as Record<string, string>, so all numeric
    // answers arrive as their string representation ("0", "0.0").
    if (value === '' || value == null) continue;
    if (value === 'none' || value === 'None') continue;
    if (value === '0' || value === '0.0') continue;
    lines.push(`- ${labelFor(key)}: ${value}`);
  }
  return lines.join('\n');
}

/**
 * Build the athlete profile block to inject into the triathlon coach
 * state context. Returns an empty string when the user has no profiles
 * (so the caller can conditionally prepend without adding whitespace).
 *
 * Only profiles under the triathlon umbrella are returned — we don't
 * want to leak the cooking `diet` profile into the triathlon prompt.
 * The sport-specific profiles are always included; the generic
 * `fitness` profile is included as supplemental context.
 */
export function formatAthleteProfileBlock(userId: number): string {
  const profiles = getAllProfiles(userId);
  const relevant = profiles.filter((p) =>
    p.profile_type === 'fitness' ||
    p.profile_type.startsWith('triathlon-'),
  );
  if (relevant.length === 0) return '';

  // Sort so the display is deterministic: core fitness first, then
  // sport profiles alphabetical. A stable ordering makes diffs easy.
  relevant.sort((a, b) => {
    if (a.profile_type === 'fitness') return -1;
    if (b.profile_type === 'fitness') return 1;
    return a.profile_type.localeCompare(b.profile_type);
  });

  const blocks = relevant.map(renderProfile);
  return `<athlete_profile>\n${blocks.join('\n\n')}\n</athlete_profile>`;
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

/**
 * Maps skills to their onboarding questionnaire IDs.
 *
 * Phase 2 Slice B: triathlon now maps to an ARRAY of questionnaires —
 * the core `fitness` sheet from Phase 1 plus 4 sport-specific sheets.
 * A user who only cares about running can answer `triathlon-running`
 * and skip the swim questions entirely. The old single-string form
 * is still accepted for domains that don't need multiple sheets.
 */
export const SKILL_ONBOARDING_MAP: Record<string, string | string[] | null> = {
  secretary: null,
  triathlon: ['fitness', 'triathlon-gym', 'triathlon-running', 'triathlon-cycling', 'triathlon-swim'],
  content: null,
  cooking: 'diet',
  finance: null,
};

/** Reverse: which skill does this questionnaire serve? */
export const QUESTIONNAIRE_SKILL_MAP: Record<string, string> = {
  fitness: 'triathlon',
  'triathlon-gym': 'triathlon',
  'triathlon-running': 'triathlon',
  'triathlon-cycling': 'triathlon',
  'triathlon-swim': 'triathlon',
  diet: 'cooking',
};

/** Normalize the polymorphic mapping value to an array of questionnaire IDs. */
function questionnairesForSkill(skill: string): string[] {
  const mapped = SKILL_ONBOARDING_MAP[skill];
  if (!mapped) return [];
  if (Array.isArray(mapped)) return mapped;
  return [mapped];
}

/**
 * Get questionnaire IDs enabled for a user based on their skill access.
 * Owner sees all questionnaires.
 */
export function getEnabledQuestionnaires(userId: number): string[] {
  try {
    if (isOwner(userId)) {
      return getAvailableQuestionnaires();
    }

    const user = getUserById(userId) || getUserByTelegramId(userId);
    if (!user) return [];

    const enabled: string[] = [];
    for (const [skill] of Object.entries(SKILL_ONBOARDING_MAP)) {
      if (!checkSkillAccess({ id: userId, tier: user.tier }, skill).allowed) continue;
      for (const qId of questionnairesForSkill(skill)) {
        if (getQuestionnaire(qId)) enabled.push(qId);
      }
    }
    return enabled;
  } catch (err) {
    logger.warn({ err, userId }, 'Onboarding skill access lookup failed — failing closed');
    return [];
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
