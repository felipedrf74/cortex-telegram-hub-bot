#!/usr/bin/env -S npx tsx
// Executable, provider-free §13 persona matrix for the isolated Training E2E lane.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import {
  scoreTrainingPlanQuality,
  isExplicitTrainingAdaptationRationale,
  TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS,
  type TrainingPlanQualityCandidate,
  type TrainingPlanQualityPersonaScenario,
} from '../src/services/training-plan-creation-validation';
import {
  assertResolvedTrainingE2EPath,
  assertTrainingE2EEvidenceComplete,
} from './lib/training-e2e-contract.mjs';
import { waitForTrainingE2EProfilesVisible } from './lib/training-e2e-profile-visibility.mjs';
import { assertTrainingE2ERunFreshness } from './lib/training-e2e-run-freshness.mjs';
import { withDatabaseForTest } from '../src/services/database';
import { getEffectiveEntitlement } from '../src/services/entitlement';
import { QUESTIONNAIRES } from '../src/services/onboarding';
import { loadCoachKnowledge } from '../src/services/coach-kernel/knowledge-loader';
import { resolveTrainingPlanStartDate } from '../src/services/training-date-utils';

export type ApiResult = { status: number; payload: any };
export type TrainingE2EApi = (
  method: string,
  route: string,
  body?: unknown,
  expectedStatuses?: number[],
) => Promise<ApiResult>;

type IsolationCounts = {
  providerOAuthRows: number;
  providerEventMappings: number;
  providerOwnershipRows: number;
};

type PlanAgendaInvariant = {
  planReadModelMatches: boolean;
  providerFreeAgendaIsolation: boolean;
  persistedPlanSessions: number;
  readModelSessions: number;
  secretaryAgendaRows: number;
  preferredTimeUnavailableCount: number;
  busyWindowOverlapCount: number;
  identityMismatches: string[];
  sessionIds: number[];
  weekNotes: string[];
  scheduleReasonCodes: string[];
  scheduleStatuses: string[];
};

export interface TrainingE2EPersistedSessionTruth {
  id: number;
  planId: number;
  weekNumber: number;
  lifecycleState: string;
  sessionIdentityKey: string | null;
  sessionShapeHash: string | null;
  dayOfWeek: string;
  title: string;
  sessionType: string;
  intensityText: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  scheduleTimeZone: string;
  durationMinutes: number | null;
  preferredTimeUnavailable: boolean;
  exercises: unknown;
}

export interface TrainingE2ESessionComparison {
  matches: boolean;
  mismatches: string[];
  readModelSessions: number;
  readModelSessionIds: string[];
}

export interface TrainingE2ECleanupProof {
  clean: boolean;
  planRows: number;
  weekRows: number;
  sessionRows: number;
  completionRows: number;
  agendaRows: number;
  ownershipRows: number;
}

export type AuthorizationScopeBoundary = 'foreign_user_same_tenant' | 'same_user_foreign_tenant';

export interface AuthorizationScopeProbeEvidence {
  boundary: AuthorizationScopeBoundary;
  foreignPlanId: number;
  responseStatus: number;
  responseCancelled: boolean | null;
  expectedOwnerUserId: number;
  expectedOwnerTenantId: number;
  remainedOwnedByExpectedScope: boolean;
  remainedActive: boolean;
}

export interface AuthorizationScopeIsolationEvidence {
  probes: AuthorizationScopeProbeEvidence[];
}

export interface TrainingE2EPersonaFixtureCleanupProof extends TrainingE2ECleanupProof {
  profileRows: number;
  healthRows: number;
  calendarFixtureRows: number;
  deviceRows: number;
  subscriptionRows: number;
  idempotencyRows: number;
  oauthRows: number;
  operationLockRows: number;
  outboxRows: number;
  apiCacheRows: number;
  userRows: number;
}

export type TrainingE2EPersonaSignalEvidence = Record<string, string[]>;

export interface TrainingE2EPersonaScenario {
  canonical: TrainingPlanQualityPersonaScenario;
  request: Record<string, unknown> & { calendarSource: null };
}

export interface TrainingE2EPersonaProfileFixture {
  profileType: 'fitness' | 'triathlon-gym' | 'triathlon-running' | 'triathlon-cycling' | 'triathlon-swim';
  data: Record<string, unknown>;
}

export type TrainingE2EReadinessFixture = 'none' | 'low_apple_health' | 'stale_apple_health';
export type TrainingE2EAdherenceFixture = 'none' | 'repeated_skips' | 'fatigue_overreach';
export type TrainingE2ECalendarFixture = 'none' | 'busy_windows';

export interface TrainingE2EPersonaFixtureSpec {
  readiness: TrainingE2EReadinessFixture;
  adherence: TrainingE2EAdherenceFixture;
  calendar: TrainingE2ECalendarFixture;
  equipmentState: string;
  calendarCapacityState: string;
}

export interface TrainingE2EPersonaFixtureEvidence {
  userId: number;
  profileTypes: string[];
  readiness: {
    fixture: TrainingE2EReadinessFixture;
    source: string;
    reasonCode: string | null;
    recommendation: string | null;
    reasoning: string | null;
    score: number;
    dataAsOf: string | null;
    isStale: boolean;
    healthRows: number;
  };
  adherence: {
    fixture: TrainingE2EAdherenceFixture;
    historyRows: number;
    skippedRows: number;
    completionRows: number;
  };
  calendar: {
    fixture: TrainingE2ECalendarFixture;
    eventRows: number;
  };
}

export interface TrainingE2EPersonaResult extends IsolationCounts {
  personaId: string;
  status: 'pass';
  previewStatus: 'preview';
  createStatus: 'created';
  cleanupStatus: 'cancelled';
  planReadModelMatch: true;
  providerFreeAgendaIsolation: true;
  planId: number;
  totalSessions: number;
  qualityScore: number;
  qualityVerdict: string;
  blockers: string[];
  persistedPlanSessions: number;
  readModelSessions: number;
  secretaryAgendaRows: number;
  preferredTimeUnavailableCount: number;
  busyWindowOverlapCount: number;
  identityMismatches: string[];
  cleanupProof: TrainingE2ECleanupProof;
  fixtureCleanupProof: TrainingE2EPersonaFixtureCleanupProof;
  authorizationScopeIsolation: AuthorizationScopeIsolationEvidence;
  fixtureEvidence: TrainingE2EPersonaFixtureEvidence;
  expectedSignals: string[];
  forbiddenConditions: string[];
  signalEvidence: TrainingE2EPersonaSignalEvidence;
  weekNotes: string[];
  scheduleReasonCodes: string[];
  scheduleStatuses: string[];
}

const BASE_REQUEST = {
  objective: 'General fitness with durable progression',
  durationWeeks: 4,
  preferredTime: '07:00',
  preferredCardioTime: '07:00',
  preferredStrengthTime: '18:00',
  sessionsPerWeek: 4,
  runSessionsPerWeek: 2,
  bikeSessionsPerWeek: 0,
  swimSessionsPerWeek: 0,
  strengthSessionsPerWeek: 2,
  // Quality personas compare complete weekly modality/frequency contracts.
  // A `today` start makes week one depend on the wall-clock weekday and can
  // leave fewer legal days than a valid six-day, no-two-a-day request.
  startPolicy: 'next_full_week',
  longWorkoutDay: 'Saturday',
  goalMode: 'continuous',
  trainingPriority: 'hybrid',
  twoADayPreference: 'never',
  calendarSource: null,
} as const;

const TRAINING_E2E_PERSONA_USER_ID_BASE = 1_000_010;

export function trainingE2EPersonaUserId(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.length) {
    throw new Error(`Invalid Training E2E persona index ${index}`);
  }
  return TRAINING_E2E_PERSONA_USER_ID_BASE + index;
}

function futureIsoDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Persisted `plan.endDate` is `start.plus({ weeks })`: the first day after the
 * last inclusive training day. The plan linter allows that last inclusive day
 * to equal race day, so exclusive end may be raceDate + 1 without overshooting.
 */
export function persistedPlanEndOvershootsRaceDate(
  planEndDate: string,
  raceDate: string,
): boolean {
  if (!planEndDate || !raceDate) return true;
  const end = Date.parse(`${planEndDate}T00:00:00.000Z`);
  const race = Date.parse(`${raceDate}T00:00:00.000Z`);
  if (Number.isNaN(end) || Number.isNaN(race)) return true;
  return end > race + 24 * 60 * 60 * 1000;
}

function personaRequest(personaId: string): Record<string, unknown> {
  switch (personaId) {
    case 'beginner_gym':
      return { objective: 'Beginner gym foundations', sessionsPerWeek: 3, runSessionsPerWeek: 0, strengthSessionsPerWeek: 3, trainingPriority: 'strength' };
    case 'intermediate_hypertrophy':
      return { objective: 'Intermediate hypertrophy', sessionsPerWeek: 4, runSessionsPerWeek: 0, strengthSessionsPerWeek: 4, trainingPriority: 'strength' };
    case 'hybrid_run_strength':
      return { objective: 'Hybrid running and strength consistency', sessionsPerWeek: 5, runSessionsPerWeek: 3, strengthSessionsPerWeek: 2, trainingPriority: 'hybrid' };
    case 'cycling_gym':
      return { objective: 'Cycling durability with supporting gym work', sessionsPerWeek: 4, runSessionsPerWeek: 0, bikeSessionsPerWeek: 2, strengthSessionsPerWeek: 2, trainingPriority: 'cycling' };
    case 'swim_triathlon':
      return { objective: 'Triathlon discipline balance', sessionsPerWeek: 6, runSessionsPerWeek: 2, bikeSessionsPerWeek: 1, swimSessionsPerWeek: 2, strengthSessionsPerWeek: 1, trainingPriority: 'triathlon' };
    case 'travel_week':
      return { objective: 'Travel-safe minimum effective training', sessionsPerWeek: 3, runSessionsPerWeek: 2, strengthSessionsPerWeek: 1, trainingPriority: 'hybrid' };
    case 'limited_time_week':
      return { objective: 'Limited-time priority week', sessionsPerWeek: 3, runSessionsPerWeek: 2, strengthSessionsPerWeek: 1, preferredTime: '06:30' };
    case 'injury_discomfort':
      return { objective: 'Conservative return around knee discomfort', sessionsPerWeek: 3, runSessionsPerWeek: 1, strengthSessionsPerWeek: 2, trainingPriority: 'hybrid' };
    case 'poor_adherence':
      return { objective: 'Re-entry after repeated missed sessions', sessionsPerWeek: 3, runSessionsPerWeek: 2, strengthSessionsPerWeek: 1 };
    case 'fatigue_plateau':
      return { objective: 'Recovery-led plateau reset', sessionsPerWeek: 3, runSessionsPerWeek: 2, strengthSessionsPerWeek: 1 };
    case 'stale_wearable':
      return { objective: 'Training with stale wearable inputs', sessionsPerWeek: 3, runSessionsPerWeek: 2, strengthSessionsPerWeek: 1 };
    case 'no_wearable':
      return { objective: 'RPE-led training without a wearable', sessionsPerWeek: 3, runSessionsPerWeek: 2, strengthSessionsPerWeek: 1 };
    case 'calendar_conflicted':
      return { objective: 'Calendar-constrained training week', sessionsPerWeek: 3, runSessionsPerWeek: 2, strengthSessionsPerWeek: 1, preferredTime: '06:30' };
    case 'race_prep':
      return { objective: '10K race preparation', durationWeeks: 12, sessionsPerWeek: 5, runSessionsPerWeek: 4, strengthSessionsPerWeek: 1, goalMode: 'event_based', trainingPriority: 'running', raceDate: futureIsoDate(84) };
    default:
      throw new Error(`No executable Training E2E fixture for canonical persona ${personaId}`);
  }
}

export function buildTrainingE2EPersonaScenarios(): TrainingE2EPersonaScenario[] {
  return TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.map((canonical) => ({
    canonical,
    request: {
      ...BASE_REQUEST,
      ...personaRequest(canonical.id),
      calendarSource: null,
      notes: [
        `Fixture-only canonical persona ${canonical.id}. ${canonical.requiredSignals.join(', ')}.`,
        canonical.id === 'travel_week' || canonical.id === 'limited_time_week'
          ? 'Every session must fit a 35-minute window.'
          : null,
      ].filter(Boolean).join(' '),
    },
  }));
}

export function buildTrainingE2EPersonaFixtureSpec(
  scenario: TrainingE2EPersonaScenario,
): TrainingE2EPersonaFixtureSpec {
  const personaId = scenario.canonical.id;
  return {
    readiness: personaId === 'fatigue_plateau'
      ? 'low_apple_health'
      : personaId === 'stale_wearable'
        ? 'stale_apple_health'
        : 'none',
    adherence: personaId === 'poor_adherence'
      ? 'repeated_skips'
      : personaId === 'fatigue_plateau'
        ? 'fatigue_overreach'
        : 'none',
    calendar: personaId === 'calendar_conflicted' ? 'busy_windows' : 'none',
    equipmentState: personaId === 'travel_week' ? 'limited' : 'full_gym',
    calendarCapacityState: personaId === 'calendar_conflicted' ? 'limited_capacity' : 'normal_capacity',
  };
}

export function resolveQualityReadinessState(input: {
  source: string;
  score: number;
  isStale: boolean;
  reasonCode: string | null;
  recommendation: string | null;
}): string {
  if (
    input.isStale
    || input.source === 'estimated'
    || input.reasonCode === 'WEARABLE_INTEGRATION_MISSING'
  ) return 'no_data';
  if (
    input.score < 70
    || input.recommendation === 'reduce_25pct'
    || input.recommendation === 'active_recovery'
    || input.recommendation === 'rest_day'
  ) return 'low_readiness';
  if (input.score >= 80 && input.recommendation === 'full_intensity') return 'high_readiness';
  return 'no_data';
}

export function buildTrainingE2EPersonaProfiles(
  scenario: TrainingE2EPersonaScenario,
): TrainingE2EPersonaProfileFixture[] {
  const personaId = scenario.canonical.id;
  const requestedStrengthSessions = Math.max(0, Number(scenario.request.strengthSessionsPerWeek ?? 2));
  const gymFrequency = requestedStrengthSessions <= 2
    ? '1-2'
    : requestedStrengthSessions === 3
      ? '3'
      : requestedStrengthSessions === 4
        ? '4'
        : '5+';
  const beginner = personaId === 'beginner_gym';
  const hypertrophy = personaId === 'intermediate_hypertrophy';
  const raceDate = typeof scenario.request.raceDate === 'string' ? scenario.request.raceDate : 'none';
  const constrainedSchedule = personaId === 'limited_time_week' || personaId === 'calendar_conflicted';
  const preferredTrainingDays = constrainedSchedule
    ? ['Tuesday', 'Thursday', 'Saturday']
    : ['Monday', 'Tuesday', 'Thursday', 'Saturday'];
  const blockedDays = constrainedSchedule
    ? ['Monday', 'Wednesday', 'Friday']
    : ['Friday'];
  const requestedWeeklyFrequency = Number(scenario.request.sessionsPerWeek ?? 4);
  const weeklyFrequency = requestedWeeklyFrequency <= 3
    ? '2-3 days'
    : requestedWeeklyFrequency >= 6
      ? '6+ days'
      : '4-5 days';
  const sessionDurationMinutes = personaId === 'travel_week' || constrainedSchedule ? 35 : 60;
  const travelEquipment = personaId === 'travel_week';

  return [
    {
      profileType: 'fitness',
      data: {
        experience_level: beginner ? 'Beginner (< 1 year)' : 'Intermediate (1-3 years)',
        weekly_frequency: weeklyFrequency,
        preferred_training_days: preferredTrainingDays.join(', '),
        blocked_days: blockedDays.join(', '),
        training_goals: [hypertrophy ? 'Hypertrophy' : beginner ? 'General fitness' : 'Endurance', 'Strength'].join(', '),
        injuries: personaId === 'injury_discomfort' ? 'Managed left knee discomfort.' : 'none',
        available_equipment: travelEquipment ? 'Resistance bands' : 'Full gym',
      },
    },
    {
      profileType: 'triathlon-gym',
      data: {
        training_age: beginner ? '< 1 year' : hypertrophy ? '1-3 years' : '3-5 years',
        current_split: beginner ? 'Full body' : hypertrophy ? 'Upper/Lower' : 'No preference',
        primary_goal: beginner ? 'General fitness' : hypertrophy ? 'Hypertrophy' : 'Support other sports',
        squat_1rm_kg: String(beginner ? 0 : 115),
        bench_1rm_kg: String(beginner ? 0 : 82),
        deadlift_1rm_kg: String(beginner ? 0 : 150),
        sessions_per_week: gymFrequency,
        preferred_training_days: preferredTrainingDays.join(', '),
        blocked_days: blockedDays.join(', '),
        equipment_access: travelEquipment ? 'Bodyweight only' : 'Full commercial gym',
        session_duration_minutes: String(sessionDurationMinutes),
      },
    },
    {
      profileType: 'triathlon-running',
      data: {
        weekly_mileage_km: String(personaId === 'injury_discomfort' ? 18 : 32),
        longest_recent_run_km: String(personaId === 'injury_discomfort' ? 8 : 14),
        easy_pace_min_per_km: '5:45',
        target_race: personaId === 'race_prep' ? '10k' : 'None — general fitness',
        target_race_date: raceDate,
        preferred_workouts: 'Easy runs, Tempo, Long runs',
        injury_history: personaId === 'injury_discomfort' ? 'Managed left knee discomfort.' : 'none',
        weekly_availability_days: '5',
        preferred_training_days: (constrainedSchedule
          ? preferredTrainingDays
          : ['Tuesday', 'Thursday', 'Saturday', 'Sunday']).join(', '),
        blocked_days: blockedDays.join(', '),
      },
    },
    {
      profileType: 'triathlon-cycling',
      data: {
        ftp_watts: '245',
        weekly_hours: '3-6 hours',
        primary_discipline: 'Road',
        target_event: personaId === 'swim_triathlon' ? 'Triathlon bike leg' : 'None',
        power_meter: 'Indoor only (smart trainer)',
        terrain_preference: 'Mixed',
        weekly_availability_days: '3',
        preferred_training_days: (constrainedSchedule
          ? preferredTrainingDays
          : ['Wednesday', 'Saturday', 'Sunday']).join(', '),
        blocked_days: blockedDays.join(', '),
      },
    },
    {
      profileType: 'triathlon-swim',
      data: {
        experience: 'Fitness swimmer',
        primary_stroke: 'Freestyle',
        time_400m_freestyle_min: '8:00',
        pool_access: '25m indoor',
        goal: personaId === 'swim_triathlon' ? 'Triathlon swim leg' : 'Fitness',
        sessions_per_week: '2',
        preferred_training_days: (constrainedSchedule ? preferredTrainingDays : ['Tuesday', 'Thursday']).join(', '),
        blocked_days: blockedDays.join(', '),
        equipment_access: 'Pull buoy, Fins, Kickboard',
      },
    },
  ];
}

/**
 * Prove that fixture profiles are reachable through the production
 * `answerStep(..., answer: string)` contract. Direct DB fixtures are useful for
 * speed, but they must not introduce arrays/numbers that real onboarding can
 * never persist.
 */
export function validateTrainingE2EPersonaProfiles(
  profiles: TrainingE2EPersonaProfileFixture[],
): string[] {
  const errors: string[] = [];
  for (const profile of profiles) {
    const questionnaire = QUESTIONNAIRES[profile.profileType];
    if (!questionnaire) {
      errors.push(`${profile.profileType}: questionnaire missing`);
      continue;
    }
    const questionnaireKeys = new Set(questionnaire.steps.map((step) => step.key));
    for (const key of Object.keys(profile.data)) {
      if (!questionnaireKeys.has(key)) {
        errors.push(`${profile.profileType}.${key}: field is not reachable through the questionnaire`);
      }
    }
    for (const step of questionnaire.steps) {
      const value = profile.data[step.key];
      const optional = (step as typeof step & { required?: boolean }).required === false;
      if (value == null && optional) continue;
      if (typeof value !== 'string' || value.trim().length === 0) {
        errors.push(`${profile.profileType}.${step.key}: answer must be a non-empty string`);
        continue;
      }
      if (step.validation && !step.validation.test(value)) {
        errors.push(`${profile.profileType}.${step.key}: answer fails questionnaire validation`);
      }
      if (step.type === 'choice' && Array.isArray(step.options) && !step.options.includes(value)) {
        errors.push(`${profile.profileType}.${step.key}: answer is not an allowed choice`);
      }
      if (step.type === 'multi_choice' && Array.isArray(step.options)) {
        const selected = value.split(',').map((item) => item.trim()).filter(Boolean);
        if (selected.length === 0 || selected.some((item) => !step.options!.includes(item))) {
          errors.push(`${profile.profileType}.${step.key}: answer contains an invalid multi-choice value`);
        }
      }
    }
  }
  return errors;
}

function assertProviderFree(counts: IsolationCounts, personaId: string): void {
  for (const [field, value] of Object.entries(counts)) {
    if (value !== 0) throw new Error(`${personaId} violated fixture-only isolation: ${field}=${value}`);
  }
}

function flattenWeeks(payload: any): any[] {
  return Array.isArray(payload?.data?.weeks) ? payload.data.weeks : [];
}

function canonicalComparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalComparable);
  if (!value || typeof value !== 'object') return value ?? null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalComparable(child)]),
  );
}

function comparableJson(value: unknown): string {
  return JSON.stringify(canonicalComparable(value));
}

export function comparePersistedSessionsToReadModel(
  persisted: TrainingE2EPersistedSessionTruth[],
  weeksPayload: any,
): TrainingE2ESessionComparison {
  const mismatches: string[] = [];
  const readRows = flattenWeeks(weeksPayload).flatMap((week: any, weekIndex: number) => {
    const weekNumber = Number(week?.weekNumber ?? week?.week_number ?? weekIndex + 1);
    return (Array.isArray(week?.sessions) ? week.sessions : []).map((session: any) => ({
      id: session?.id == null ? '' : String(session.id),
      planId: session?.planId == null ? '' : String(session.planId),
      weekNumber,
      lifecycleState: String(session?.lifecycleState ?? ''),
      sessionIdentityKey: session?.sessionIdentityKey == null ? null : String(session.sessionIdentityKey),
      sessionShapeHash: session?.sessionShapeHash == null ? null : String(session.sessionShapeHash),
      dayOfWeek: String(session?.day ?? session?.dayOfWeek ?? ''),
      title: String(session?.title ?? session?.type ?? ''),
      sessionType: String(session?.sessionType ?? ''),
      intensityText: session?.intensityText == null ? null : String(session.intensityText),
      scheduledStartAt: session?.scheduledStartAt == null ? null : String(session.scheduledStartAt),
      scheduledEndAt: session?.scheduledEndAt == null ? null : String(session.scheduledEndAt),
      durationMinutes: session?.duration == null ? null : Number(session.duration),
      preferredTimeUnavailable: session?.preferredTimeUnavailable === true,
      exercises: session?.exercises ?? null,
    }));
  });
  const readModelSessionIds = readRows.map((row) => row.id);
  for (const id of readModelSessionIds) {
    if (!id) mismatches.push('read-model session id is missing');
  }
  if (new Set(readModelSessionIds).size !== readModelSessionIds.length) {
    mismatches.push('read-model contains duplicate session ids');
  }

  const readById = new Map(readRows.filter((row) => row.id).map((row) => [row.id, row]));
  const persistedIds = persisted.map((row) => String(row.id));
  if (new Set(persistedIds).size !== persistedIds.length) {
    mismatches.push('persistence contains duplicate session ids');
  }
  for (const row of persisted) {
    const id = String(row.id);
    const read = readById.get(id);
    if (!read) {
      mismatches.push(`missing persisted session id ${id} from read model`);
      continue;
    }
    const expected: Record<string, string | number | null> = {
      planId: String(row.planId),
      weekNumber: row.weekNumber,
      lifecycleState: row.lifecycleState,
      sessionIdentityKey: row.sessionIdentityKey,
      sessionShapeHash: row.sessionShapeHash,
      dayOfWeek: row.dayOfWeek,
      title: row.title,
      sessionType: row.sessionType,
      intensityText: row.intensityText,
      scheduledStartAt: row.scheduledStartAt,
      scheduledEndAt: row.scheduledEndAt,
      durationMinutes: row.durationMinutes,
      preferredTimeUnavailable: row.preferredTimeUnavailable ? 1 : 0,
      exercises: comparableJson(row.exercises),
    };
    const actual: Record<string, string | number | null> = {
      planId: read.planId,
      weekNumber: read.weekNumber,
      lifecycleState: read.lifecycleState,
      sessionIdentityKey: read.sessionIdentityKey,
      sessionShapeHash: read.sessionShapeHash,
      dayOfWeek: read.dayOfWeek,
      title: read.title,
      sessionType: read.sessionType,
      intensityText: read.intensityText,
      scheduledStartAt: read.scheduledStartAt,
      scheduledEndAt: read.scheduledEndAt,
      durationMinutes: read.durationMinutes,
      preferredTimeUnavailable: read.preferredTimeUnavailable ? 1 : 0,
      exercises: comparableJson(read.exercises),
    };
    for (const field of Object.keys(expected)) {
      if (actual[field] !== expected[field]) {
        mismatches.push(
          `session id ${id} ${field} mismatch: persisted=${String(expected[field])} readModel=${String(actual[field])}`,
        );
      }
    }
  }
  for (const row of readRows) {
    if (row.id && !persistedIds.includes(row.id)) {
      mismatches.push(`unexpected read-model session id ${row.id}`);
    }
  }
  const payloadPlanId = weeksPayload?.data?.plan?.id;
  const expectedPlanIds = new Set(persisted.map((row) => String(row.planId)));
  if (expectedPlanIds.size === 1 && String(payloadPlanId ?? '') !== [...expectedPlanIds][0]) {
    mismatches.push(`read-model plan id ${String(payloadPlanId ?? 'missing')} does not match persisted plan`);
  }
  const expectedTimeZones = new Set(persisted.map((row) => row.scheduleTimeZone));
  const readModelTimeZone = String(weeksPayload?.data?.plan?.schedulingTimezone ?? '');
  if (expectedTimeZones.size !== 1 || readModelTimeZone !== [...expectedTimeZones][0]) {
    mismatches.push(
      `scheduleTimeZone mismatch: persisted=${[...expectedTimeZones].join(',') || 'missing'} readModel=${readModelTimeZone || 'missing'}`,
    );
  }
  return {
    matches: persisted.length > 0 && mismatches.length === 0 && persisted.length === readRows.length,
    mismatches,
    readModelSessions: readRows.length,
    readModelSessionIds,
  };
}

export function classifyTrainingE2ESessionSport(
  session: any,
): TrainingPlanQualityCandidate['weeks'][number]['sessions'][number]['sport'] {
  const canonicalType = String(session?.sessionType ?? session?.type ?? '').trim().toLowerCase();
  if (['swim', 'swimming'].includes(canonicalType)) return 'swimming';
  if (['ride', 'bike', 'cycling'].includes(canonicalType)) return 'cycling';
  if (['run', 'running'].includes(canonicalType)) return 'running';
  if (['gym', 'strength', 'lift'].includes(canonicalType)) return 'strength';
  if (canonicalType === 'mobility') return 'mobility';
  if (['recover', 'recovery', 'rest'].includes(canonicalType)) return 'recovery';

  const value = `${canonicalType} ${session?.title ?? ''}`.toLowerCase();
  if (/\bswim(?:ming)?\b/.test(value)) return 'swimming';
  if (/\b(?:ride|bike|cycling|cycle)\b/.test(value)) return 'cycling';
  if (/\b(?:run|running|tempo|interval|long)\b/.test(value)) return 'running';
  if (/\b(?:strength|gym|lift|squat|press)\b/.test(value)) return 'strength';
  if (/\bmobility\b/.test(value)) return 'mobility';
  if (/\b(?:recover|recovery|rest)\b/.test(value)) return 'recovery';
  return 'hybrid';
}

export function classifyTrainingE2ESessionIntensity(session: any): 'easy' | 'moderate' | 'hard' | 'recovery' {
  const coachInsights = Array.isArray(session?.descriptionSections?.coachInsights)
    ? session.descriptionSections.coachInsights
    : [];
  const structuredSummaries = coachInsights
    .filter((insight: any) => insight?.reasonCode === 'intensity_summary')
    .map((insight: any) => typeof insight?.value === 'string' ? insight.value.trim() : '')
    .filter(Boolean);
  if (structuredSummaries.length > 0) {
    const structured = structuredSummaries.join(' ').toLowerCase();
    // Keep this mapping byte-for-byte aligned with the canonical buckets in
    // coach-kernel/intensity-profile.ts. Arbitrary descriptions are not
    // trusted evidence; only the public intensity_summary insight is.
    if (/\b(?:threshold|vo2|neuromuscular|zone\s*[45])\b/.test(structured)) return 'hard';
    if (/\b(?:tempo|zone\s*3)\b/.test(structured)) return 'moderate';
    if (/\b(?:recover|recovery|zone\s*1)\b/.test(structured)) return 'recovery';
    if (/\b(?:aerobic|easy|zone\s*2)\b/.test(structured)) return 'easy';
    return 'moderate';
  }

  // Legacy rows lack structured description sections. Preserve a
  // conservative text fallback, checking hard-zone terms before broad
  // aerobic/long tokens so a title such as "Long VO2 Intervals" cannot be
  // mislabeled easy.
  const value = `${session?.intensity ?? ''} ${session?.intensityText ?? ''} ${session?.title ?? ''} ${session?.sessionType ?? ''}`.toLowerCase();
  if (/\b(?:rest|recover|recovery|mobility|zone\s*1)\b/.test(value)) return 'recovery';
  if (/\b(?:hard|threshold|interval|vo2|neuromuscular|hill repeats?|zone\s*[45])\b/.test(value)) return 'hard';
  if (/\b(?:tempo|moderate|zone\s*3)\b/.test(value)) return 'moderate';
  if (/\b(?:easy|aerobic|long|zone\s*2)\b/.test(value)) return 'easy';
  return 'moderate';
}

const COACH_EXERCISE_METADATA_BY_ID = new Map(
  loadCoachKnowledge().exercises.map((exercise) => [exercise.id, {
    equipment: exercise.equipment,
    movementPattern: exercise.movementPattern,
  }]),
);

export function sessionExerciseMetadata(session: any): { equipment: string[]; movementPatterns: string[] } {
  const exercises = Array.isArray(session?.exercises) ? session.exercises : [];
  const equipment = exercises.flatMap((exercise: any) => {
    const canonical = COACH_EXERCISE_METADATA_BY_ID.get(String(exercise?.exerciseId ?? '').trim());
    if (canonical) return canonical.equipment.length > 0 ? canonical.equipment : ['bodyweight'];
    if (Array.isArray(exercise?.equipment)) return exercise.equipment.map(String);
    if (typeof exercise?.equipment === 'string') return [exercise.equipment];
    return [];
  });
  const movementPatterns = exercises.flatMap((exercise: any) => {
    const canonical = COACH_EXERCISE_METADATA_BY_ID.get(String(exercise?.exerciseId ?? '').trim());
    if (canonical) return [canonical.movementPattern];
    if (Array.isArray(exercise?.movementPatterns)) return exercise.movementPatterns.map(String);
    if (typeof exercise?.movementPattern === 'string') return [exercise.movementPattern];
    if (typeof exercise?.selectionReason?.pattern === 'string') return [exercise.selectionReason.pattern];
    return [];
  });
  return {
    equipment: [...new Set(equipment)],
    movementPatterns: [...new Set(movementPatterns)],
  };
}

/**
 * Extract adaptation proof only from fields returned by the public plan read
 * model. Scheduler-only details and arbitrary workout descriptions are not
 * evidence that a low-readiness plan visibly changed.
 */
export function publicSessionAdaptationReason(session: any): string | null {
  const publicCandidates = [
    session?.adaptationReason,
    session?.safetyDowngradeReason,
    session?.description,
  ];
  for (const candidate of publicCandidates) {
    if (isExplicitTrainingAdaptationRationale(candidate)) return candidate.trim();
  }
  return null;
}

function qualityCandidate(
  scenario: TrainingE2EPersonaScenario,
  fixtureSpec: TrainingE2EPersonaFixtureSpec,
  fixtureEvidence: TrainingE2EPersonaFixtureEvidence,
  weeksPayload: any,
): TrainingPlanQualityCandidate {
  const weeks = flattenWeeks(weeksPayload).map((week: any, weekIndex: number) => ({
    weekNumber: Number(week?.weekNumber ?? week?.week_number ?? weekIndex + 1),
    phase: String(week?.phase ?? week?.focus ?? 'base'),
    sessions: (Array.isArray(week?.sessions) ? week.sessions : []).map((session: any) => ({
      // Missing identity must remain missing so the exact persistence/read-model
      // comparator can fail closed; synthesizing an id would fabricate proof.
      id: session?.id == null ? '' : String(session.id),
      weekNumber: Number(week?.weekNumber ?? weekIndex + 1),
      dayOfWeek: String(session?.dayOfWeek ?? session?.day_of_week ?? session?.day ?? ''),
      sport: classifyTrainingE2ESessionSport(session),
      title: String(session?.title ?? ''),
      sessionType: String(session?.sessionType ?? session?.session_type ?? session?.type ?? ''),
      durationMinutes: Number(session?.durationMinutes ?? session?.duration_minutes ?? session?.duration ?? 0),
      intensity: classifyTrainingE2ESessionIntensity(session),
      keySession: Boolean(session?.keySession ?? session?.key_session),
      startTime: session?.startTime ?? session?.start_time ?? null,
      ...sessionExerciseMetadata(session),
      adaptationReason: publicSessionAdaptationReason(session),
      safetyDowngradeReason: String(session?.safetyDowngradeReason ?? '') || null,
    })),
  }));
  return {
    objective: String(scenario.request.objective),
    goalMode: String(scenario.request.goalMode),
    engineGoal: typeof weeksPayload?.data?.plan?.goal === 'string'
      ? weeksPayload.data.plan.goal
      : null,
    readinessState: resolveQualityReadinessState(fixtureEvidence.readiness),
    equipmentState: fixtureSpec.equipmentState,
    calendarCapacityState: fixtureSpec.calendarCapacityState,
    weeks,
  };
}

function actualOutputBlockers(preview: any, candidate: TrainingPlanQualityCandidate): string[] {
  const blockers: string[] = [];
  const sessions = candidate.weeks.flatMap((week) => week.sessions);
  const titles = sessions.map((session) => session.title.trim().toLowerCase()).filter(Boolean);
  if (sessions.length === 0) blockers.push('generated plan has no sessions');
  if (preview?.data?.fallbackTemplateUsed === true) blockers.push('generic fallback template was used');
  if (Array.isArray(preview?.data?.blockers)) blockers.push(...preview.data.blockers.map((row: any) => String(row?.code ?? row?.message ?? row)));
  if (titles.length > 2 && new Set(titles).size <= 1) blockers.push('generated plan is repetitive');
  if (!Array.isArray(preview?.data?.phaseRoadmap) || preview.data.phaseRoadmap.length === 0) blockers.push('generated plan lacks phase rationale');
  return blockers;
}

function personaFixtureBlockers(
  scenario: TrainingE2EPersonaScenario,
  fixtureSpec: TrainingE2EPersonaFixtureSpec,
  evidence: TrainingE2EPersonaFixtureEvidence,
): string[] {
  const blockers: string[] = [];
  if (evidence.userId < 1_000_000 || evidence.userId > 1_099_999) {
    blockers.push(`persona user ${evidence.userId} is outside the reserved staging-fixture range`);
  }
  const expectedProfiles = ['fitness', 'triathlon-gym', 'triathlon-running', 'triathlon-cycling', 'triathlon-swim'];
  for (const profileType of expectedProfiles) {
    if (!evidence.profileTypes.includes(profileType)) blockers.push(`missing persisted ${profileType} profile`);
  }

  if (fixtureSpec.readiness === 'none') {
    if (evidence.readiness.healthRows !== 0) blockers.push(`expected no wearable rows, found ${evidence.readiness.healthRows}`);
    if (scenario.canonical.id === 'no_wearable') {
      if (evidence.readiness.source !== 'estimated') blockers.push(`no-wearable readiness source was ${evidence.readiness.source}`);
      if (evidence.readiness.reasonCode !== 'WEARABLE_INTEGRATION_MISSING') {
        blockers.push(`no-wearable reason was ${evidence.readiness.reasonCode ?? 'missing'}`);
      }
    }
  } else if (fixtureSpec.readiness === 'stale_apple_health') {
    if (evidence.readiness.source !== 'apple_health') blockers.push(`stale fixture source was ${evidence.readiness.source}`);
    if (!evidence.readiness.isStale) blockers.push('stale fixture was not older than the 36-hour freshness boundary');
  } else {
    if (evidence.readiness.source !== 'apple_health') blockers.push(`fatigue fixture source was ${evidence.readiness.source}`);
    if (evidence.readiness.isStale) blockers.push('fatigue fixture unexpectedly used stale data');
    if (evidence.readiness.score >= 70) blockers.push(`fatigue fixture readiness score ${evidence.readiness.score} was not recovery-limited`);
  }

  if (fixtureSpec.adherence === 'repeated_skips' && evidence.adherence.skippedRows < 3) {
    blockers.push(`poor-adherence fixture has only ${evidence.adherence.skippedRows} skipped sessions`);
  }
  if (fixtureSpec.adherence === 'fatigue_overreach' && evidence.adherence.completionRows < 3) {
    blockers.push(`fatigue fixture has only ${evidence.adherence.completionRows} high-strain completions`);
  }
  if (fixtureSpec.adherence === 'none' && evidence.adherence.historyRows !== 0) {
    blockers.push(`expected isolated empty history, found ${evidence.adherence.historyRows} rows`);
  }
  if (fixtureSpec.calendar === 'busy_windows' && evidence.calendar.eventRows < 2) {
    blockers.push(`calendar-conflicted fixture has only ${evidence.calendar.eventRows} busy events`);
  }
  if (fixtureSpec.calendar === 'none' && evidence.calendar.eventRows !== 0) {
    blockers.push(`expected empty fixture calendar, found ${evidence.calendar.eventRows} events`);
  }
  return blockers;
}

export function assertCalendarCapacityEvidence(input: {
  preferredTimeUnavailableCount: number;
  scheduleStatuses: string[];
  busyWindowOverlapCount: number;
}): void {
  const displaced = input.preferredTimeUnavailableCount > 0
    || input.scheduleStatuses.some((status) => /reflowed|compressed|capped|conflict|deferred|dropped/.test(status));
  if (!displaced) {
    throw new Error('calendar-conflicted output has no canonical preferred-time displacement or capacity effect');
  }
  if (input.busyWindowOverlapCount > 0) {
    throw new Error(`calendar-conflicted output overlaps ${input.busyWindowOverlapCount} fixture busy window(s)`);
  }
}

function publicTrainingPlanOutput(preview: any, weeksPayload: any): string {
  return `${JSON.stringify(weeksPayload?.data ?? {})} ${JSON.stringify(preview?.data?.decisionReasons ?? [])}`
    .toLowerCase();
}

export function hasPublicProfessionalGuidanceEvidence(preview: any, weeksPayload: any): boolean {
  return /\b(physio|physical therapist|clinician|medical|healthcare professional|qualified professional)\b/
    .test(publicTrainingPlanOutput(preview, weeksPayload));
}

function personaOutputBlockers(
  scenario: TrainingE2EPersonaScenario,
  preview: any,
  candidate: TrainingPlanQualityCandidate,
  planAgenda: PlanAgendaInvariant,
  weeksPayload: any,
): string[] {
  const blockers: string[] = [];
  const notes = planAgenda.weekNotes.join(' ').toLowerCase();
  const reasons = JSON.stringify(preview?.data?.decisionReasons ?? []).toLowerCase();
  const renderedOutput = `${JSON.stringify(weeksPayload?.data ?? {})} ${reasons} ${notes}`.toLowerCase();
  const phases = candidate.weeks.map((week) => String(week.phase).toLowerCase());
  const sessions = candidate.weeks.flatMap((week) => week.sessions);
  const sessionsBySport = (sport: TrainingPlanQualityCandidate['weeks'][number]['sessions'][number]['sport']) =>
    sessions.filter((session) => session.sport === sport);
  const requestedPerWeek = (key: string) => Math.max(0, Number(scenario.request[key] ?? 0));
  const perWeekSportShortfall = (
    sport: TrainingPlanQualityCandidate['weeks'][number]['sessions'][number]['sport'],
    expected: number,
  ) => candidate.weeks.some((week) => week.sessions.filter((session) => session.sport === sport).length < expected);
  const dayIndex = (day: string): number => [
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  ].indexOf(day.trim().toLowerCase());

  if (scenario.canonical.id === 'beginner_gym') {
    if (perWeekSportShortfall('strength', requestedPerWeek('strengthSessionsPerWeek'))) {
      blockers.push('beginner output does not preserve the requested weekly strength frequency');
    }
    if (/\b(snatch|clean and jerk|muscle[- ]?up|one[- ]rep max|1rm|max[- ]effort|depth jump)\b/.test(renderedOutput)) {
      blockers.push('beginner output prescribes an advanced or maximal lift without a novice-safe substitution');
    }
    if (!/\b(form|technique|controlled|control|safe|substitution|regress)\b/.test(renderedOutput)) {
      blockers.push('beginner output lacks visible form, control, or substitution guidance');
    }
    if (!/\b(progress|build|increase|add|reps?|load|volume)\b/.test(renderedOutput)) {
      blockers.push('beginner output lacks a simple measurable progression path');
    }
  }
  if (scenario.canonical.id === 'intermediate_hypertrophy') {
    if (!/hypertrophy|muscle|body[_ -]?composition|strength/.test(String(candidate.engineGoal ?? '').toLowerCase())) {
      blockers.push(`hypertrophy output persisted incompatible engine goal ${candidate.engineGoal ?? 'missing'}`);
    }
    if (perWeekSportShortfall('strength', requestedPerWeek('strengthSessionsPerWeek'))) {
      blockers.push('hypertrophy output breaks the requested weekly strength split');
    }
    const strengthTitles = new Set(sessionsBySport('strength').map((session) => session.title.trim().toLowerCase()).filter(Boolean));
    const exerciseNames = new Set(sessionsBySport('strength').flatMap((session: any) =>
      (Array.isArray((session as any).exercises) ? (session as any).exercises : [])
        .map((exercise: any) => String(exercise?.name ?? exercise?.title ?? '').trim().toLowerCase())
        .filter(Boolean)));
    if (strengthTitles.size < 2) blockers.push('hypertrophy output repeats one generic strength session');
    if (exerciseNames.size > 0 && exerciseNames.size < 4) blockers.push('hypertrophy output lacks exercise variety');
    if (!/\b(progress|overload|increase|load|volume|reps?|sets?)\b/.test(renderedOutput)) {
      blockers.push('hypertrophy output lacks a measurable overload path');
    }
  }
  if (scenario.canonical.id === 'hybrid_run_strength') {
    if (perWeekSportShortfall('running', requestedPerWeek('runSessionsPerWeek'))
      || perWeekSportShortfall('strength', requestedPerWeek('strengthSessionsPerWeek'))) {
      blockers.push('hybrid output does not preserve both requested run and strength frequencies');
    }
    const hardRuns = sessionsBySport('running').filter((session) => session.intensity === 'hard' || session.keySession);
    const lowerStrength = sessionsBySport('strength').filter((session) =>
      /\b(squat|deadlift|lunge|leg|lower|hinge|quad|hamstring)\b/.test(`${session.title} ${JSON.stringify(session)}`.toLowerCase()));
    const unsafeAdjacent = lowerStrength.some((strength) => hardRuns.some((run) => {
      if (strength.weekNumber !== run.weekNumber) return false;
      const strengthDay = dayIndex(strength.dayOfWeek);
      const runDay = dayIndex(run.dayOfWeek);
      return strengthDay >= 0 && runDay >= 0 && (runDay - strengthDay + 7) % 7 === 1;
    }));
    if (unsafeAdjacent) blockers.push('hybrid output places lower-body strength immediately before a key/hard run');
    const hardSessions = sessions.filter((session) => session.intensity === 'hard');
    const hardStacked = hardSessions.some((left, index) => hardSessions.slice(index + 1).some((right) => {
      if (left.weekNumber !== right.weekNumber) return false;
      const leftDay = dayIndex(left.dayOfWeek);
      const rightDay = dayIndex(right.dayOfWeek);
      if (leftDay < 0 || rightDay < 0) return false;
      const distance = Math.min((rightDay - leftDay + 7) % 7, (leftDay - rightDay + 7) % 7);
      return distance <= 1;
    }));
    if (hardStacked) blockers.push('hybrid output stacks hard sessions on the same or adjacent days');
    if (!/\b(balance|spacing|recovery|alternate|hard|easy|rationale|because)\b/.test(renderedOutput)) {
      blockers.push('hybrid output lacks visible hard/easy or weekly-spacing rationale');
    }
  }
  if (scenario.canonical.id === 'cycling_gym') {
    if (perWeekSportShortfall('cycling', requestedPerWeek('bikeSessionsPerWeek'))
      || perWeekSportShortfall('strength', requestedPerWeek('strengthSessionsPerWeek'))) {
      blockers.push('cycling output does not preserve bike and supporting-strength frequencies');
    }
    if (sessionsBySport('running').length > 0) blockers.push('cycling output substitutes running for cycling intent');
    if (!/\b(ftp|power|watts?|rpe|zone)\b/.test(renderedOutput)) {
      blockers.push('cycling output lacks an FTP, power-zone, or RPE benchmark');
    }
    if (/\b(ftp|power|watts?|zone)\b/.test(renderedOutput)
      && !/\b(245\s*w?|rpe|perceived exertion)\b/.test(renderedOutput)) {
      blockers.push('cycling output prescribes power zones without the persisted 245W FTP or an RPE fallback');
    }
  }
  if (scenario.canonical.id === 'swim_triathlon') {
    for (const [sport, key] of [
      ['running', 'runSessionsPerWeek'],
      ['cycling', 'bikeSessionsPerWeek'],
      ['swimming', 'swimSessionsPerWeek'],
      ['strength', 'strengthSessionsPerWeek'],
    ] as const) {
      const expected = requestedPerWeek(key);
      const actualByWeek = candidate.weeks.map((week) =>
        week.sessions.filter((session) => session.sport === sport).length);
      if (actualByWeek.some((actual) => actual < expected)) {
        const shortWeekSessions = candidate.weeks
          .filter((_week, index) => actualByWeek[index] < expected)
          .map((week) => `${week.weekNumber}:${week.sessions.map((session) =>
            `${session.dayOfWeek}/${session.sport}/${session.title}`).join('|')}`)
          .join(';');
        blockers.push(
          `triathlon output does not preserve requested ${sport} frequency `
          + `(expected=${expected}, actualByWeek=${actualByWeek.join(',')}, shortWeeks=${shortWeekSessions})`,
        );
      }
    }
    if (!/\b(pool|25m|swim|pull buoy|fins|kickboard)\b/.test(renderedOutput)) {
      blockers.push('triathlon output does not show pool/access-aware swim prescription');
    }
    if (!/\b(brick|transition|bike[- ]to[- ]run|multisport|discipline)\b/.test(renderedOutput)) {
      blockers.push('triathlon output lacks brick, transition, or multisport integration logic');
    }
  }

  if (scenario.canonical.id === 'poor_adherence') {
    if (!/adherence decision:.*consecutive miss/.test(notes)) {
      blockers.push('poor-adherence output does not cite consecutive misses in durable week notes');
    }
    if (!phases.some((phase) => /deload|recovery|return/.test(phase))) {
      blockers.push('poor-adherence output did not enter a recovery/re-entry phase');
    }
  }
  if (scenario.canonical.id === 'fatigue_plateau') {
    if (candidate.readinessState !== 'low_readiness') {
      blockers.push(`fatigue output readiness was ${candidate.readinessState ?? 'missing'}, not API-derived low_readiness`);
    }
    if (!/readiness decision:.*(?:orange|red)/.test(notes)) {
      blockers.push('fatigue output does not disclose recovery-limited readiness');
    }
    if (!/(recovery|readiness|fatigue|deload)/.test(reasons)) {
      blockers.push('fatigue preview has no recovery/load adaptation rationale');
    }
    if (sessions.some((session) => session.intensity === 'hard')) {
      blockers.push('fatigue output retains hard work despite recovery-limited readiness and high-strain history');
    }
  }
  if (scenario.canonical.id === 'stale_wearable' && !/readiness confidence: provider data is stale.*manual check-in/.test(notes)) {
    blockers.push('stale-wearable output lacks durable stale-state and manual-check-in copy');
  }
  if (scenario.canonical.id === 'stale_wearable'
    && candidate.weeks.some((week) => week.sessions.filter((session) => session.intensity === 'hard').length > 1)) {
    blockers.push('stale-wearable output makes an aggressive hard-session jump from degraded readiness data');
  }
  if (scenario.canonical.id === 'no_wearable' && !/readiness confidence: no fresh wearable or manual readiness data.*manual check-in/.test(notes)) {
    blockers.push('no-wearable output lacks durable missing-signal and manual-check-in copy');
  }
  if (scenario.canonical.id === 'no_wearable' && !/\b(rpe|perceived exertion|effort)\b/.test(renderedOutput)) {
    blockers.push('no-wearable output lacks an RPE/effort-based progression path');
  }
  if (scenario.canonical.id === 'calendar_conflicted') {
    try {
      assertCalendarCapacityEvidence(planAgenda);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    if (!/(calendar|capacity|available|moved|compressed|capped)/.test(reasons)) {
      blockers.push('calendar-conflicted output lacks visible reflow rationale');
    }
  }
  if (scenario.canonical.id === 'travel_week') {
    const tooLong = sessions.filter((session) => session.durationMinutes > 35);
    if (tooLong.length > 0) {
      blockers.push(
        `travel output exceeds the 35-minute window in ${tooLong.length} session(s): `
        + tooLong.map((session) =>
          `w${session.weekNumber}/${session.dayOfWeek}/${session.title}/${session.durationMinutes}m`).join(', '),
      );
    }
    if (/\b(barbell|smith machine|leg press|cable machine|power rack)\b/.test(renderedOutput)) {
      blockers.push('travel output prescribes equipment unavailable in the travel profile');
    }
    const strength = sessions.filter((session) => session.sport === 'strength');
    const strengthWithoutEquipment = strength.filter((session) => (session.equipment ?? []).length === 0);
    if (strengthWithoutEquipment.length > 0) {
      blockers.push(
        'travel strength output omits equipment/substitution metadata: '
        + strengthWithoutEquipment.map((session) =>
          `w${session.weekNumber}/${session.dayOfWeek}/${session.title}`).join(', '),
      );
    }
  }
  if (scenario.canonical.id === 'limited_time_week') {
    const expectedPerWeek = Number(scenario.request.sessionsPerWeek ?? 3);
    if (candidate.weeks.some((week) => week.sessions.length > expectedPerWeek)) {
      blockers.push('limited-time output overpacks the requested weekly session count');
    }
    if (sessions.some((session) => session.durationMinutes > 35)) {
      blockers.push('limited-time output exceeds the persisted 35-minute availability window');
    }
    if (perWeekSportShortfall('running', requestedPerWeek('runSessionsPerWeek'))
      || perWeekSportShortfall('strength', requestedPerWeek('strengthSessionsPerWeek'))) {
      blockers.push('limited-time output drops a requested priority discipline');
    }
    if (sessions.some((session) => !session.title.trim() || session.durationMinutes <= 0)) {
      blockers.push('limited-time output contains a label-only session without durable duration/content');
    }
  }
  if (scenario.canonical.id === 'injury_discomfort') {
    const publicOutput = publicTrainingPlanOutput(preview, weeksPayload);
    const hasPainBoundary = /\b(pain|discomfort|injur|stop if|pain-free|medical|physio|clinician|professional)\b/.test(publicOutput);
    const hasProfessionalGuidance = hasPublicProfessionalGuidanceEvidence(preview, weeksPayload);
    if (!hasPainBoundary) blockers.push('injury output omits a visible pain boundary or safe substitution rationale');
    if (!hasProfessionalGuidance) blockers.push('injury output omits professional-guidance copy');
  }
  if (scenario.canonical.id === 'race_prep') {
    const plan = weeksPayload?.data?.plan ?? {};
    const expectedRaceDate = String(scenario.request.raceDate ?? '');
    const persistedRaceDate = String(plan.raceDate ?? '');
    const planEndDate = String(plan.endDate ?? '');
    if (!expectedRaceDate || persistedRaceDate !== expectedRaceDate) {
      blockers.push(`race output persisted race date ${persistedRaceDate || 'missing'}, expected ${expectedRaceDate || 'missing'}`);
    }
    if (!planEndDate || persistedPlanEndOvershootsRaceDate(planEndDate, expectedRaceDate)) {
      blockers.push(`race output end date ${planEndDate || 'missing'} overshoots race date ${expectedRaceDate || 'missing'}`);
    }
    if (!phases.some((phase) => /peak|taper/.test(phase))) {
      blockers.push('race output has no persisted peak/taper phase');
    }
    if (!/\b(benchmark|goal pace|race pace|pace|time trial|10k)\b/.test(renderedOutput)) {
      blockers.push('race output lacks a benchmark or goal-pace progression signal');
    }
  }
  return blockers;
}

function buildPersonaSignalEvidence(input: {
  scenario: TrainingE2EPersonaScenario;
  candidate: TrainingPlanQualityCandidate;
  fixtureEvidence: TrainingE2EPersonaFixtureEvidence;
  planAgenda: PlanAgendaInvariant;
  preview: any;
  weeksPayload: any;
}): TrainingE2EPersonaSignalEvidence {
  const { scenario, candidate, fixtureEvidence, planAgenda, preview, weeksPayload } = input;
  const sessions = candidate.weeks.flatMap((week) => week.sessions);
  const bySport = (sport: string) => sessions.filter((session) => session.sport === sport);
  const counts = Object.fromEntries(
    ['running', 'cycling', 'swimming', 'strength', 'mobility', 'recovery', 'hybrid']
      .map((sport) => [sport, bySport(sport).length]),
  );
  const phases = [...new Set(candidate.weeks.map((week) => week.phase).filter(Boolean))];
  const titles = [...new Set(sessions.map((session) => session.title).filter(Boolean))];
  const equipment = [...new Set(sessions.flatMap((session) => session.equipment ?? []))];
  const durations = sessions.map((session) => session.durationMinutes);
  const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;
  const rendered = `${JSON.stringify(weeksPayload?.data ?? {})} ${JSON.stringify(preview?.data ?? {})} ${planAgenda.weekNotes.join(' ')}`;
  const publicRendered = publicTrainingPlanOutput(preview, weeksPayload);
  const snippet = (pattern: RegExp): string => rendered.match(pattern)?.[0] ?? 'validated by the persona-specific blocker set';
  const facts: TrainingE2EPersonaSignalEvidence = {};
  const add = (signal: string, ...values: Array<string | number>) => {
    facts[signal] = values.map(String).map((value) => value.trim()).filter(Boolean);
  };

  switch (scenario.canonical.id) {
    case 'beginner_gym':
      add('novice_safe_strength', `${counts.strength} persisted strength sessions`, 'no advanced/maximal-lift token detected');
      add('equipment_fit', `${equipment.length} distinct prescribed equipment values`, `fixture equipment=${buildTrainingE2EPersonaFixtureSpec(scenario).equipmentState}`);
      add('simple_progression', `phases=${phases.join(',')}`, snippet(/\b(progress|build|increase|add|reps?|load|volume)\b/i));
      break;
    case 'intermediate_hypertrophy':
      add('split_integrity', `${counts.strength} persisted strength sessions across ${candidate.weeks.length} weeks`, `titles=${titles.length}`);
      add('volume_progression', `weekly strength minutes=${candidate.weeks.map((week) => week.sessions.filter((s) => s.sport === 'strength').reduce((sum, s) => sum + s.durationMinutes, 0)).join(',')}`, snippet(/\b(progress|overload|increase|load|volume|reps?|sets?)\b/i));
      add('exercise_variety', `${titles.length} distinct session titles`, `${equipment.length} distinct equipment values`);
      break;
    case 'hybrid_run_strength':
      add('hard_easy_balance', `${sessions.filter((s) => s.intensity === 'hard').length} hard and ${sessions.filter((s) => s.intensity === 'easy').length} easy sessions`);
      add('lower_body_spacing', `${counts.strength} strength and ${counts.running} run sessions`, 'no lower-body session immediately precedes a key/hard run');
      add('weekly_rationale', `${planAgenda.weekNotes.length} persisted week-note rationale lines`, `${planAgenda.scheduleReasonCodes.length} schedule reason codes`);
      break;
    case 'cycling_gym':
      add('cycling_benchmark_or_rpe', snippet(/\b(ftp|power|watts?|rpe|zone)\b/i));
      add('strength_support_spacing', `${counts.strength} strength support sessions and ${counts.cycling} bike sessions`);
      add('bike_specificity', `${counts.cycling} cycling sessions`, `${counts.running} running substitutions`);
      break;
    case 'swim_triathlon': {
      const swimProfile = buildTrainingE2EPersonaProfiles(scenario).find((profile) => profile.profileType === 'triathlon-swim');
      add('pool_access_fit', `pool_access=${String(swimProfile?.data.pool_access ?? 'missing')}`, `${counts.swimming} generated swim sessions`);
      add('discipline_balance', `run=${counts.running}, bike=${counts.cycling}, swim=${counts.swimming}, strength=${counts.strength}`);
      add('brick_or_transition_logic', snippet(/\b(brick|transition|bike[- ]to[- ]run|multisport|discipline)\b/i));
      break;
    }
    case 'travel_week':
      add('limited_equipment_substitutions', `equipment=${equipment.join(',') || 'bodyweight metadata'}`, 'no unavailable full-gym token detected');
      add('compressed_duration_fit', `maximum session duration=${maxDuration} minutes`);
      add('calendar_realism', `${sessions.length} sessions with exact persisted/read-model schedule identity`, `${planAgenda.busyWindowOverlapCount} busy-window overlaps`);
      break;
    case 'limited_time_week':
      add('duration_truthfulness', `maximum session duration=${maxDuration} minutes`);
      add('minimum_viable_week', `${sessions.length} sessions across ${candidate.weeks.length} weeks`);
      add('priority_protection', `run=${counts.running}, strength=${counts.strength}`);
      break;
    case 'injury_discomfort':
      add('pain_boundary', publicRendered.match(/\b(pain|discomfort|injur|stop if|pain-free)\b/i)?.[0] ?? 'missing');
      add('safe_substitution', publicRendered.match(/\b(substitut|regress|low impact|pain-free|controlled)\b/i)?.[0] ?? 'missing');
      add('professional_guidance_copy', publicRendered.match(/\b(physio|physical therapist|clinician|medical|healthcare professional|qualified professional)\b/i)?.[0] ?? 'missing');
      break;
    case 'poor_adherence':
      add('real_compliance_signal', `${fixtureEvidence.adherence.skippedRows} persisted skipped sessions`);
      add('reentry_or_deload', `phases=${phases.join(',')}`);
      add('explanation_cites_misses', snippet(/adherence decision:.*consecutive miss/i));
      break;
    case 'fatigue_plateau':
      add('recovery_downgrade', `readiness score=${fixtureEvidence.readiness.score}`, `recommendation=${fixtureEvidence.readiness.recommendation ?? 'missing'}`);
      add('load_monitoring', `${fixtureEvidence.adherence.completionRows} persisted high-strain completions`);
      add('next_step_assessment', snippet(/\b(recovery|readiness|fatigue|deload|assessment|check-in)\b/i));
      break;
    case 'stale_wearable':
      add('degraded_state_label', `dataAsOf=${fixtureEvidence.readiness.dataAsOf ?? 'missing'}`, `stale=${fixtureEvidence.readiness.isStale}`);
      add('no_overconfident_readiness', `quality readiness state=${candidate.readinessState ?? 'missing'}`);
      add('manual_feedback_prompt', snippet(/manual check-in/i));
      break;
    case 'no_wearable':
      add('subjective_feedback_path', snippet(/manual check-in/i));
      add('rpe_based_progression', snippet(/\b(rpe|perceived exertion|effort)\b/i));
      add('missing_signal_honesty', `source=${fixtureEvidence.readiness.source}`, `reason=${fixtureEvidence.readiness.reasonCode ?? 'missing'}`);
      break;
    case 'calendar_conflicted':
      add('capacity_reflow', `${planAgenda.preferredTimeUnavailableCount} preferred-time displacements`, `${planAgenda.busyWindowOverlapCount} overlaps`);
      add('idempotent_calendar_state', `${planAgenda.secretaryAgendaRows} Secretary agenda writes`, `${planAgenda.identityMismatches.length} read-model mismatches`);
      add('repair_needed_copy', snippet(/\b(calendar|capacity|available|moved|compressed|capped|repair)\b/i));
      break;
    case 'race_prep':
      add('race_date_fit', `raceDate=${String(weeksPayload?.data?.plan?.raceDate ?? 'missing')}`, `endDate=${String(weeksPayload?.data?.plan?.endDate ?? 'missing')}`);
      add('taper_specificity', `phases=${phases.join(',')}`);
      add('benchmark_or_goal_pace_logic', snippet(/\b(benchmark|goal pace|race pace|pace|time trial|10k)\b/i));
      break;
    default:
      throw new Error(`No signal-evidence builder for ${scenario.canonical.id}`);
  }
  assertPersonaSignalEvidence(scenario.canonical.requiredSignals, facts);
  return facts;
}

export function assertTrainingE2ECleanupResult(
  response: ApiResult,
  proof: TrainingE2ECleanupProof,
): void {
  const dirtyCounts = Object.entries(proof)
    .filter(([key, value]) => key !== 'clean' && Number(value) !== 0)
    .map(([key, value]) => `${key}=${value}`);
  if (!proof.clean || dirtyCounts.length > 0) {
    throw new Error(`Training E2E cleanup proof failed: ${dirtyCounts.join(', ') || 'clean=false'}`);
  }
  const endpointConfirmed = response.status === 200 && response.payload?.data?.cancelled === true;
  const alreadyAbsentAndProven = response.status === 404 && proof.clean;
  if (!endpointConfirmed && !alreadyAbsentAndProven) {
    throw new Error(`Training E2E cancellation endpoint returned ${response.status} without durable cleanup proof`);
  }
}

function authorizationProbeDenied(evidence: AuthorizationScopeProbeEvidence): boolean {
  return [403, 404].includes(evidence.responseStatus)
    || (evidence.responseStatus === 200 && evidence.responseCancelled === false);
}

export function assertAuthorizationScopeIsolationEvidence(
  evidence: AuthorizationScopeIsolationEvidence,
): void {
  const expected = new Set<AuthorizationScopeBoundary>([
    'foreign_user_same_tenant',
    'same_user_foreign_tenant',
  ]);
  const received = new Set((evidence.probes ?? []).map((probe) => probe.boundary));
  if (evidence.probes?.length !== expected.size
    || received.size !== expected.size
    || [...expected].some((boundary) => !received.has(boundary))) {
    throw new Error('Training E2E authorization isolation requires exactly both user and tenant boundary probes');
  }
  for (const probe of evidence.probes) {
    if (
      !authorizationProbeDenied(probe)
      || probe.remainedOwnedByExpectedScope !== true
      || probe.remainedActive !== true
    ) {
      throw new Error(
        `Training E2E ${probe.boundary} isolation failed for plan ${probe.foreignPlanId}: `
        + `status=${probe.responseStatus}, cancelled=${String(probe.responseCancelled)}, `
        + `owned=${probe.remainedOwnedByExpectedScope}, active=${probe.remainedActive}`,
      );
    }
  }
}

/** Compatibility assertion for older unit fixtures; qualifying v3 evidence uses
 * `assertAuthorizationScopeIsolationEvidence` and proves both boundaries. */
export function assertCrossTenantIsolationEvidence(evidence: any): void {
  if (Array.isArray(evidence?.probes)) {
    assertAuthorizationScopeIsolationEvidence(evidence as AuthorizationScopeIsolationEvidence);
    return;
  }
  const routeDenied = [403, 404].includes(Number(evidence?.responseStatus))
    || (Number(evidence?.responseStatus) === 200 && evidence?.responseCancelled === false);
  if (!routeDenied || evidence?.remainedOwnedByForeignUser !== true || evidence?.remainedActive !== true) {
    throw new Error(`Training E2E legacy cross-tenant isolation failed for foreign plan ${String(evidence?.foreignPlanId)}`);
  }
}

export function assertTrainingE2EPersonaFixtureCleanupProof(
  proof: TrainingE2EPersonaFixtureCleanupProof,
): void {
  const requiredFields = [
    'clean',
    'planRows',
    'weekRows',
    'sessionRows',
    'completionRows',
    'agendaRows',
    'ownershipRows',
    'profileRows',
    'healthRows',
    'calendarFixtureRows',
    'deviceRows',
    'subscriptionRows',
    'idempotencyRows',
    'oauthRows',
    'operationLockRows',
    'outboxRows',
    'apiCacheRows',
    'userRows',
  ];
  const actualFields = Object.keys(proof ?? {});
  const missingFields = requiredFields.filter((field) => !actualFields.includes(field));
  const unexpectedFields = actualFields.filter((field) => !requiredFields.includes(field));
  if (missingFields.length > 0 || unexpectedFields.length > 0) {
    throw new Error(
      `Training E2E persona fixture cleanup shape failed: missing=${missingFields.join(',') || 'none'}; `
      + `unexpected=${unexpectedFields.join(',') || 'none'}`,
    );
  }
  const dirty = Object.entries(proof)
    .filter(([key, value]) => key !== 'clean' && Number(value) !== 0)
    .map(([key, value]) => `${key}=${value}`);
  if (proof.clean !== true || dirty.length > 0) {
    throw new Error(`Training E2E persona fixture cleanup failed: ${dirty.join(', ') || 'clean=false'}`);
  }
}

export function assertPersonaSignalEvidence(
  expectedSignals: string[],
  evidence: TrainingE2EPersonaSignalEvidence,
): void {
  const expected = new Set(expectedSignals);
  const received = new Set(Object.keys(evidence ?? {}));
  for (const signal of expected) {
    const facts = evidence?.[signal];
    if (!Array.isArray(facts) || facts.length === 0 || facts.some((fact) => !String(fact).trim())) {
      throw new Error(`Training E2E persona signal ${signal} lacks concrete evidence`);
    }
  }
  for (const signal of received) {
    if (!expected.has(signal)) {
      throw new Error(`Training E2E persona evidence contains unexpected signal ${signal}`);
    }
  }
}

export async function runTrainingE2EPersonaScenario(input: {
  scenario: TrainingE2EPersonaScenario;
  api: TrainingE2EApi;
  preparePersona: (scenario: TrainingE2EPersonaScenario) => Promise<TrainingE2EPersonaFixtureEvidence>;
  inspectIsolation: (planId?: number) => Promise<IsolationCounts>;
  inspectPlanAgenda: (planId: number, weeksPayload: any) => Promise<PlanAgendaInvariant>;
  inspectCleanup: (planId: number, sessionIds: number[]) => Promise<TrainingE2ECleanupProof>;
  probeAuthorizationScopeIsolation: () => Promise<AuthorizationScopeIsolationEvidence>;
  cleanupPersonaFixtures: () => Promise<TrainingE2EPersonaFixtureCleanupProof>;
}): Promise<TrainingE2EPersonaResult> {
  const {
    scenario,
    api,
    preparePersona,
    inspectIsolation,
    inspectPlanAgenda,
    inspectCleanup,
    probeAuthorizationScopeIsolation,
    cleanupPersonaFixtures,
  } = input;
  let planId: number | null = null;
  let cleanupStatus: 'cancelled' | 'failed' = 'failed';
  let cleanupProof: TrainingE2ECleanupProof | null = null;
  let fixtureCleanupProof: TrainingE2EPersonaFixtureCleanupProof | null = null;
  let sessionIdsForCleanup: number[] = [];
  let successfulResult: Omit<TrainingE2EPersonaResult, 'cleanupStatus' | 'cleanupProof' | 'fixtureCleanupProof'> | null = null;
  try {
    const fixtureSpec = buildTrainingE2EPersonaFixtureSpec(scenario);
    const fixtureEvidence = await preparePersona(scenario);
    const fixtureBlockers = personaFixtureBlockers(scenario, fixtureSpec, fixtureEvidence);
    if (fixtureBlockers.length > 0) {
      throw new Error(`${scenario.canonical.id} fixture blockers: ${fixtureBlockers.join('; ')}`);
    }
    assertProviderFree(await inspectIsolation(), scenario.canonical.id);
    const preview = await api('POST', '/api/v1/training/plan/preview', scenario.request, [200]);
    if (preview.payload?.data?.status !== 'preview') {
      if (preview.payload?.data?.needsProfile === true) {
        const questionnaire = String(
          preview.payload.data.requiredQuestionnaireId ?? 'unknown_questionnaire',
        );
        const missingKeys = Array.isArray(preview.payload.data.missingFields)
          ? preview.payload.data.missingFields
            .map((field: any) => String(
              typeof field === 'string'
                ? field
                : field?.key ?? field?.field ?? field?.id ?? field?.name ?? '',
            ).trim())
            .filter(Boolean)
          : [];
        throw new Error(
          `${scenario.canonical.id} preview needs profile ${questionnaire}; missing fields: ${missingKeys.join(', ') || 'unknown'}`,
        );
      }
      throw new Error(`${scenario.canonical.id} preview returned ${preview.payload?.data?.status ?? 'unknown'}`);
    }
    const created = await api('POST', '/api/v1/training/plan/generate', {
      ...scenario.request,
      idempotencyKey: `training-e2e-persona-${scenario.canonical.id}-${Date.now()}`,
    }, [201]);
    planId = Number(created.payload?.data?.planId);
    if (!Number.isInteger(planId) || planId <= 0) throw new Error(`${scenario.canonical.id} create returned no plan id`);
    const authorizationScopeIsolation = await probeAuthorizationScopeIsolation();
    assertAuthorizationScopeIsolationEvidence(authorizationScopeIsolation);
    const weeks = await api('GET', '/api/v1/training/plan/weeks', undefined, [200]);
    const candidate = qualityCandidate(scenario, fixtureSpec, fixtureEvidence, weeks.payload);
    const isolation = await inspectIsolation(planId);
    assertProviderFree(isolation, scenario.canonical.id);
    const planAgenda = await inspectPlanAgenda(planId, weeks.payload);
    const quality = scoreTrainingPlanQuality({
      ...candidate,
      rationaleNotes: planAgenda.weekNotes,
    });
    sessionIdsForCleanup = planAgenda.sessionIds;
    const blockers = [
      ...actualOutputBlockers(preview.payload, candidate),
      ...quality.blockers,
      ...personaOutputBlockers(scenario, preview.payload, candidate, planAgenda, weeks.payload),
    ];
    if (!planAgenda.planReadModelMatches) {
      blockers.push(
        `plan/read-model mismatch: persisted=${planAgenda.persistedPlanSessions} readModel=${planAgenda.readModelSessions}`,
      );
    }
    if (!planAgenda.providerFreeAgendaIsolation) {
      blockers.push(`provider-free agenda isolation failed: secretaryAgenda=${planAgenda.secretaryAgendaRows}`);
    }
    blockers.push(...planAgenda.identityMismatches.map((mismatch) => `read-model identity: ${mismatch}`));
    if (blockers.length > 0) throw new Error(`${scenario.canonical.id} quality blockers: ${blockers.join('; ')}`);
    const signalEvidence = buildPersonaSignalEvidence({
      scenario,
      candidate,
      fixtureEvidence,
      planAgenda,
      preview: preview.payload,
      weeksPayload: weeks.payload,
    });
    successfulResult = {
      personaId: scenario.canonical.id,
      status: 'pass',
      previewStatus: 'preview',
      createStatus: 'created',
      planReadModelMatch: planAgenda.planReadModelMatches as true,
      providerFreeAgendaIsolation: planAgenda.providerFreeAgendaIsolation as true,
      planId,
      totalSessions: candidate.weeks.reduce((sum, week) => sum + week.sessions.length, 0),
      qualityScore: quality.score,
      qualityVerdict: quality.verdict,
      blockers: [],
      persistedPlanSessions: planAgenda.persistedPlanSessions,
      readModelSessions: planAgenda.readModelSessions,
      secretaryAgendaRows: planAgenda.secretaryAgendaRows,
      preferredTimeUnavailableCount: planAgenda.preferredTimeUnavailableCount,
      busyWindowOverlapCount: planAgenda.busyWindowOverlapCount,
      identityMismatches: planAgenda.identityMismatches,
      authorizationScopeIsolation,
      fixtureEvidence,
      expectedSignals: scenario.canonical.requiredSignals,
      forbiddenConditions: scenario.canonical.failureConditions,
      signalEvidence,
      weekNotes: planAgenda.weekNotes,
      scheduleReasonCodes: planAgenda.scheduleReasonCodes,
      scheduleStatuses: planAgenda.scheduleStatuses,
      ...isolation,
    };
  } finally {
    try {
      if (planId !== null) {
        const cleanup = await api('POST', '/api/v1/training/plan/cancel', { planId }, [200, 404, 409]);
        cleanupProof = await inspectCleanup(planId, sessionIdsForCleanup);
        assertTrainingE2ECleanupResult(cleanup, cleanupProof);
        cleanupStatus = 'cancelled';
      }
    } finally {
      fixtureCleanupProof = await cleanupPersonaFixtures();
      assertTrainingE2EPersonaFixtureCleanupProof(fixtureCleanupProof);
    }
  }
  if (!successfulResult || cleanupStatus !== 'cancelled' || !cleanupProof || !fixtureCleanupProof) {
    throw new Error(`${scenario.canonical.id} did not produce complete post-cleanup evidence`);
  }
  return { ...successfulResult, cleanupStatus, cleanupProof, fixtureCleanupProof };
}

function loadLatestEnv(root: string): Record<string, string> {
  if (process.env.NEXUS_TRAINING_E2E_IN_CONTAINER === '1') {
    return Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  const latestEnvPath = path.join(root, '.local/training-e2e/latest.env');
  if (!fs.existsSync(latestEnvPath)) throw new Error(`No Training E2E env file found at ${latestEnvPath}`);
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(latestEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^export\s+([A-Z0-9_]+)='(.*)'$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function makePersonaApi(baseUrl: string, accessToken: string): TrainingE2EApi {
  return async (method, route, body, expectedStatuses = [200]) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Language': 'en-US',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 800)}`);
    }
    return { status: response.status, payload };
  };
}

function ensurePersonaFixtureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staging_fixture_calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      description TEXT,
      location TEXT,
      categories_json TEXT,
      color TEXT,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_staging_fixture_calendar_user_time
      ON staging_fixture_calendar_events(user_id, start_at, end_at);
  `);
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

function deletePersonaFixtureData(
  db: Database.Database,
  userId: number,
): TrainingE2EPersonaFixtureCleanupProof {
  const count = (sql: string, ...params: unknown[]) => Number(
    (db.prepare(sql).get(...params) as { count?: number } | undefined)?.count ?? 0,
  );
  const planIds = (db.prepare(`
    SELECT id
      FROM fitness_training_plans
     WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
  `).all(userId, userId) as Array<{ id: number }>).map((row) => Number(row.id));
  const sessionIds = planIds.length > 0
    ? (db.prepare(`SELECT id FROM training_sessions WHERE plan_id IN (${placeholders(planIds)})`)
        .all(...planIds) as Array<{ id: number }>).map((row) => Number(row.id))
    : [];

  const remove = db.transaction(() => {
    if (sessionIds.length > 0) {
      db.prepare(`
        DELETE FROM secretary_agenda_items
         WHERE source_skill = 'training'
           AND source_entity_type = 'training_session'
           AND source_entity_id IN (${placeholders(sessionIds)})
      `).run(...sessionIds.map(String));
    }
    if (planIds.length > 0) {
      const planPlaceholders = placeholders(planIds);
      db.prepare(`DELETE FROM training_completions WHERE plan_id IN (${planPlaceholders})`).run(...planIds);
      db.prepare(`DELETE FROM training_agenda_event_ownership WHERE plan_id IN (${planPlaceholders})`).run(...planIds);
      db.prepare(`DELETE FROM training_sessions WHERE plan_id IN (${planPlaceholders})`).run(...planIds);
      db.prepare(`DELETE FROM training_weeks WHERE plan_id IN (${planPlaceholders})`).run(...planIds);
      db.prepare(`DELETE FROM fitness_training_plans WHERE id IN (${planPlaceholders})`).run(...planIds);
    }
    db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM apple_health_data WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM staging_fixture_calendar_events WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_oauth_tokens WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM ios_devices WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(userId);
    if (tableExists(db, 'training_plan_generation_idempotency_scoped')) {
      db.prepare(`
        DELETE FROM training_plan_generation_idempotency_scoped
         WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
      `).run(userId, userId);
    }
    if (tableExists(db, 'training_plan_generation_idempotency')) {
      db.prepare('DELETE FROM training_plan_generation_idempotency WHERE user_id = ?').run(userId);
    }
    db.prepare(`
      DELETE FROM training_operation_locks
       WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
    `).run(userId, userId);
    db.prepare(`
      DELETE FROM event_outbox
       WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
    `).run(userId, userId);
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${userId}%`);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  remove();

  const planRows = count(`
    SELECT COUNT(*) AS count FROM fitness_training_plans
     WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
  `, userId, userId);
  const weekRows = planIds.length > 0
    ? count(`SELECT COUNT(*) AS count FROM training_weeks WHERE plan_id IN (${placeholders(planIds)})`, ...planIds)
    : 0;
  const sessionRows = planIds.length > 0
    ? count(`SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id IN (${placeholders(planIds)})`, ...planIds)
    : 0;
  const completionRows = planIds.length > 0
    ? count(`SELECT COUNT(*) AS count FROM training_completions WHERE plan_id IN (${placeholders(planIds)})`, ...planIds)
    : 0;
  const agendaRows = sessionIds.length > 0
    ? count(`
        SELECT COUNT(*) AS count FROM secretary_agenda_items
         WHERE source_skill = 'training'
           AND source_entity_type = 'training_session'
           AND source_entity_id IN (${placeholders(sessionIds)})
      `, ...sessionIds.map(String))
    : 0;
  const ownershipRows = planIds.length > 0
    ? count(`SELECT COUNT(*) AS count FROM training_agenda_event_ownership WHERE plan_id IN (${placeholders(planIds)})`, ...planIds)
    : 0;
  const idempotencyRows = (tableExists(db, 'training_plan_generation_idempotency_scoped')
    ? count(`
        SELECT COUNT(*) AS count FROM training_plan_generation_idempotency_scoped
         WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
      `, userId, userId)
    : 0) + (tableExists(db, 'training_plan_generation_idempotency')
    ? count('SELECT COUNT(*) AS count FROM training_plan_generation_idempotency WHERE user_id = ?', userId)
    : 0);
  const proof: TrainingE2EPersonaFixtureCleanupProof = {
    clean: false,
    planRows,
    weekRows,
    sessionRows,
    completionRows,
    agendaRows,
    ownershipRows,
    profileRows: count('SELECT COUNT(*) AS count FROM user_profiles WHERE user_id = ?', userId),
    healthRows: count('SELECT COUNT(*) AS count FROM apple_health_data WHERE user_id = ?', userId),
    calendarFixtureRows: count('SELECT COUNT(*) AS count FROM staging_fixture_calendar_events WHERE user_id = ?', userId),
    deviceRows: count('SELECT COUNT(*) AS count FROM ios_devices WHERE user_id = ?', userId),
    subscriptionRows: count('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ?', userId),
    idempotencyRows,
    oauthRows: count('SELECT COUNT(*) AS count FROM user_oauth_tokens WHERE user_id = ?', userId),
    operationLockRows: count(`
      SELECT COUNT(*) AS count FROM training_operation_locks
       WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
    `, userId, userId),
    outboxRows: count(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE user_id = ? OR CAST(tenant_id AS TEXT) = CAST(? AS TEXT)
    `, userId, userId),
    apiCacheRows: count('SELECT COUNT(*) AS count FROM api_cache WHERE cache_key LIKE ?', `%${userId}%`),
    userRows: count('SELECT COUNT(*) AS count FROM users WHERE id = ?', userId),
  };
  proof.clean = Object.entries(proof).every(([key, value]) => key === 'clean' || Number(value) === 0);
  return proof;
}

function resetPersonaFixtureData(db: Database.Database, userId: number): void {
  const proof = deletePersonaFixtureData(db, userId);
  assertTrainingE2EPersonaFixtureCleanupProof(proof);
}

export function ensurePersonaUser(db: Database.Database, userId: number, personaId: string): void {
  const periodStart = new Date().toISOString();
  const periodEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO users (
      id, email, email_verified, username, first_name, language, timezone,
      tier, status, auth_provider, daily_message_limit, daily_token_limit,
      daily_cost_limit_usd, created_at
    ) VALUES (?, ?, 1, ?, 'Training QA', 'en-US', 'Europe/Lisbon',
      'max', 'active', 'email', 1000, 1000000, 5, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      username = excluded.username,
      timezone = excluded.timezone,
      tier = excluded.tier,
      status = excluded.status,
      last_active_at = datetime('now')
  `).run(
    userId,
    `training-e2e-${personaId}-${userId}@example.test`,
    `training_e2e_${personaId}_${userId}`,
  );
  db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, period, status, provider,
      current_period_start, current_period_end, created_at, updated_at
    ) VALUES (?, 'max', 'monthly', 'active', 'stripe', ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = excluded.status,
      provider = excluded.provider,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      updated_at = datetime('now')
  `).run(userId, periodStart, periodEnd);
}

function assertPersonaEffectiveMaxEntitlement(db: Database.Database, userId: number): void {
  const entitlement = withDatabaseForTest(db, () => getEffectiveEntitlement(userId));
  if (
    entitlement.plan !== 'max'
    || entitlement.status !== 'active'
    || entitlement.source !== 'stripe'
    || entitlement.aiAccessAllowed !== true
    || entitlement.automationAllowed !== true
  ) {
    throw new Error(
      `Training E2E persona ${userId} effective entitlement is `
      + `${entitlement.plan}/${entitlement.status}/${entitlement.source}; expected active Stripe Max`,
    );
  }
}

function personaDeviceId(userId: number, personaId: string): string {
  const safePersonaId = personaId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return `training-e2e-persona-${safePersonaId}-${userId}`;
}

export function readPersonaUserFromFreshConnection(
  dbPath: string,
  userId: number,
): { id: number; status: string } | null {
  const freshDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    freshDb.pragma('busy_timeout = 5000');
    return (freshDb
      .prepare('SELECT id, status FROM users WHERE id = ?')
      .get(userId) as { id: number; status: string } | undefined) ?? null;
  } finally {
    freshDb.close();
  }
}

export function readPersonaAuthBindingFromFreshConnection(
  dbPath: string,
  userId: number,
  deviceId: string,
): {
  user: { id: number; status: string } | null;
  device: { userId: number; deviceId: string } | null;
} {
  const freshDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    freshDb.pragma('busy_timeout = 5000');
    const user = (freshDb
      .prepare('SELECT id, status FROM users WHERE id = ?')
      .get(userId) as { id: number; status: string } | undefined) ?? null;
    const device = (freshDb
      .prepare('SELECT user_id AS userId, device_id AS deviceId FROM ios_devices WHERE user_id = ? AND device_id = ?')
      .get(userId, deviceId) as { userId: number; deviceId: string } | undefined) ?? null;
    return { user, device };
  } finally {
    freshDb.close();
  }
}

export function ensurePersonaDevice(
  db: Database.Database,
  userId: number,
  personaId: string,
): string {
  const deviceId = personaDeviceId(userId, personaId);
  db.prepare(`
    INSERT INTO ios_devices (
      user_id, device_id, device_name, refresh_token,
      refresh_token_hash, previous_refresh_token_hash, last_active_at, created_at
    ) VALUES (?, ?, 'Training E2E persona device', NULL, NULL, NULL, datetime('now'), datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET
      user_id = excluded.user_id,
      device_name = excluded.device_name,
      refresh_token = NULL,
      refresh_token_hash = NULL,
      previous_refresh_token_hash = NULL,
      last_active_at = datetime('now')
  `).run(userId, deviceId);
  assertPersonaDeviceSessionBound(db, userId, deviceId);
  return deviceId;
}

export function assertPersonaDeviceSessionBound(
  db: Database.Database,
  userId: number,
  deviceId: string,
): void {
  const row = db.prepare(
    'SELECT user_id AS userId FROM ios_devices WHERE device_id = ?',
  ).get(deviceId) as { userId: number } | undefined;
  if (!row) {
    throw new Error(`Training E2E device session ${deviceId} is missing or revoked`);
  }
  if (Number(row.userId) !== userId) {
    throw new Error(`Training E2E device session ${deviceId} belongs to another user (device/user mismatch)`);
  }
}

function upsertPersonaHealthRow(
  db: Database.Database,
  input: { userId: number; dataType: string; date: string; data: unknown; createdAt: string },
): void {
  db.prepare(`
    INSERT INTO apple_health_data (user_id, data_type, date, data_json, source_name, created_at)
    VALUES (?, ?, ?, ?, 'training-e2e-quality', ?)
    ON CONFLICT(user_id, data_type, date, source_name) DO UPDATE SET
      data_json = excluded.data_json,
      created_at = excluded.created_at,
      encrypted_data_json = NULL
  `).run(input.userId, input.dataType, input.date, JSON.stringify(input.data), input.createdAt);
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function seedPersonaReadiness(
  db: Database.Database,
  userId: number,
  fixture: TrainingE2EReadinessFixture,
): void {
  if (fixture === 'none') return;
  const now = new Date();
  const createdAt = fixture === 'stale_apple_health'
    ? new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
    : now.toISOString();
  const today = now.toISOString().slice(0, 10);

  if (fixture === 'low_apple_health') {
    for (let daysAgo = 1; daysAgo <= 6; daysAgo += 1) {
      const date = dateDaysAgo(daysAgo);
      upsertPersonaHealthRow(db, { userId, dataType: 'hrv', date, data: { value: 62, sdnn_ms: 62 }, createdAt });
      upsertPersonaHealthRow(db, { userId, dataType: 'resting_heart_rate', date, data: { value: 52, bpm: 52 }, createdAt });
    }
    upsertPersonaHealthRow(db, { userId, dataType: 'hrv', date: today, data: { value: 12, sdnn_ms: 12 }, createdAt });
    upsertPersonaHealthRow(db, { userId, dataType: 'resting_heart_rate', date: today, data: { value: 96, bpm: 96 }, createdAt });
    upsertPersonaHealthRow(db, {
      userId,
      dataType: 'sleep',
      date: today,
      data: { totalSleepSeconds: 3.5 * 3600, deepSleepSeconds: 20 * 60, remSleepSeconds: 25 * 60 },
      createdAt,
    });
    upsertPersonaHealthRow(db, {
      userId,
      dataType: 'daily_summary',
      date: today,
      data: { steps: 26000, activeCalories: 1800, restingHeartRate: 96, totalSleepMinutes: 210 },
      createdAt,
    });
    return;
  }

  upsertPersonaHealthRow(db, { userId, dataType: 'hrv', date: today, data: { value: 60, sdnn_ms: 60 }, createdAt });
  upsertPersonaHealthRow(db, { userId, dataType: 'resting_heart_rate', date: today, data: { value: 52, bpm: 52 }, createdAt });
  upsertPersonaHealthRow(db, {
    userId,
    dataType: 'sleep',
    date: today,
    data: { totalSleepSeconds: 8 * 3600, deepSleepSeconds: 90 * 60, remSleepSeconds: 100 * 60 },
    createdAt,
  });
}

function seedPersonaHistory(
  db: Database.Database,
  userId: number,
  fixture: TrainingE2EAdherenceFixture,
): { historyRows: number; skippedRows: number; completionRows: number } {
  if (fixture === 'none') return { historyRows: 0, skippedRows: 0, completionRows: 0 };
  const now = new Date();
  const startDate = dateDaysAgo(7);
  const endDate = now.toISOString().slice(0, 10);
  const plan = db.prepare(`
    INSERT INTO fitness_training_plans (
      user_id, tenant_id, name, sport, goal, duration_weeks, status,
      start_date, end_date, preferences_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'hybrid', 'Fixture history', 1, 'completed', ?, ?, '{}', ?, ?)
  `).run(userId, userId, `Training E2E ${fixture}`, startDate, endDate, now.toISOString(), now.toISOString());
  const planId = Number(plan.lastInsertRowid);
  const week = db.prepare(`
    INSERT INTO training_weeks (plan_id, week_number, focus, intensity_pct, volume_sessions, notes, created_at)
    VALUES (?, 1, 'base', 100, 3, 'Training E2E state fixture', ?)
  `).run(planId, now.toISOString());
  const weekId = Number(week.lastInsertRowid);
  const types = fixture === 'repeated_skips'
    ? ['interval_run', 'threshold_run', 'long_run']
    : ['threshold_run', 'interval_run', 'long_run'];
  let completionRows = 0;
  for (const [index, sessionType] of types.entries()) {
    const timestamp = new Date(now.getTime() - (index + 1) * 60 * 60 * 1000).toISOString();
    const status = fixture === 'repeated_skips' ? 'skipped' : 'completed';
    const session = db.prepare(`
      INSERT INTO training_sessions (
        week_id, plan_id, tenant_id, day_of_week, session_type, title,
        duration_minutes, intensity_text, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 60, 'Hard', ?, ?, ?)
    `).run(
      weekId,
      planId,
      userId,
      ['Monday', 'Wednesday', 'Saturday'][index],
      sessionType,
      `Training E2E ${sessionType}`,
      status,
      timestamp,
      timestamp,
    );
    if (fixture === 'fatigue_overreach') {
      db.prepare(`
        INSERT INTO training_completions (
          session_id, plan_id, completed_at, rpe_overall, duration_minutes,
          completed_duration_sec, energy_level, soreness_level, notes,
          completion_state, felt_too_hard, created_at
        ) VALUES (?, ?, ?, 9, 60, 3600, 2, 8,
          'Training E2E high-strain plateau fixture', 'completed', 1, ?)
      `).run(Number(session.lastInsertRowid), planId, timestamp, timestamp);
      completionRows += 1;
    }
  }
  return {
    historyRows: types.length,
    skippedRows: fixture === 'repeated_skips' ? types.length : 0,
    completionRows,
  };
}

export function trainingE2ECalendarFixtureDays(input: {
  now: Date;
  startPolicy: 'next_full_week' | 'today';
  schedulingTimezone: string;
}): string[] {
  const startDate = resolveTrainingPlanStartDate(
    input.now,
    input.startPolicy,
    input.schedulingTimezone,
  );
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) {
    throw new Error(`Training E2E calendar fixture start date is invalid: ${startDate}`);
  }
  return Array.from({ length: 7 }, (_, dayOffset) =>
    new Date(startMs + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
}

function seedPersonaCalendar(
  db: Database.Database,
  userId: number,
  fixture: TrainingE2ECalendarFixture,
  fixtureDays: string[],
): number {
  if (fixture === 'none') return 0;
  const insert = db.prepare(`
    INSERT INTO staging_fixture_calendar_events (
      user_id, event_id, title, start_at, end_at, description,
      categories_json, is_all_day
    ) VALUES (?, ?, 'Training E2E busy window', ?, ?,
      'Synthetic local-only capacity fixture', '["training-e2e"]', 0)
  `);
  let count = 0;
  for (const day of fixtureDays) {
    for (const [suffix, start, end] of [
      ['morning', '05:30:00.000Z', '09:30:00.000Z'],
      ['evening', '16:30:00.000Z', '20:30:00.000Z'],
    ]) {
      insert.run(
        userId,
        `training-e2e-${userId}-${day}-${suffix}`,
        `${day}T${start}`,
        `${day}T${end}`,
      );
      count += 1;
    }
  }
  return count;
}

function parsePersistedWeekNotes(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()];
  } catch {
    // Legacy rows store a plain sentence. Preserve it as one evidence line.
  }
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const inContainer = process.env.NEXUS_TRAINING_E2E_IN_CONTAINER === '1';
  const env = loadLatestEnv(root);
  const stateRoot = inContainer ? root : path.resolve(root, '.local/training-e2e');
  const stateDir = assertResolvedTrainingE2EPath(stateRoot, env.NEXUS_TRAINING_E2E_ROOT, 'state directory');
  const metadata = JSON.parse(fs.readFileSync(path.join(stateDir, 'metadata.json'), 'utf8'));
  if (metadata.runPolicy?.qualifying !== true) {
    throw new Error('Training E2E quality evidence requires a fresh qualifying run; resume/debug state is ineligible');
  }
  if (metadata.runId !== env.NEXUS_TRAINING_E2E_RUN_ID) {
    throw new Error('Training E2E quality run id does not match environment metadata');
  }
  const authPath = assertResolvedTrainingE2EPath(
    stateRoot,
    env.NEXUS_TRAINING_E2E_AUTH_FILE,
    'auth file',
  );
  if (!fs.existsSync(authPath)) throw new Error(`Training E2E auth file is missing at ${authPath}`);
  const jwtSecretPath = assertResolvedTrainingE2EPath(
    stateRoot,
    env.NEXUS_TRAINING_E2E_IOS_JWT_SECRET_FILE,
    'quality JWT secret file',
  );
  const jwtSecret = fs.readFileSync(jwtSecretPath, 'utf8');
  if (Buffer.byteLength(jwtSecret, 'utf8') < 32) throw new Error('Training E2E quality JWT secret is too short');
  const flowEvidence = JSON.parse(fs.readFileSync(path.join(stateDir, 'training-flow-evidence.json'), 'utf8'));
  const baseUrl = env.NEXUS_TRAINING_E2E_BASE_URL;
  const apiBaseUrl = inContainer ? env.NEXUS_TRAINING_E2E_API_BASE_URL : baseUrl;
  const parsedBaseUrl = new URL(baseUrl);
  const parsedApiBaseUrl = new URL(apiBaseUrl);
  if (
    parsedBaseUrl.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(parsedBaseUrl.hostname)
    || baseUrl.includes(':8200')
    || parsedApiBaseUrl.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(parsedApiBaseUrl.hostname)
  ) throw new Error(`Refusing non-isolated backend URL ${baseUrl}`);
  if (flowEvidence?.schemaVersion !== 'training_e2e_flow.v2'
    || flowEvidence?.runId !== metadata.runId
    || flowEvidence?.baseUrl !== baseUrl
    || flowEvidence?.backendBaseUrl !== baseUrl) {
    throw new Error('Training E2E lifecycle evidence is not bound to this exact qualifying run and backend URL');
  }
  const recordedBackendProvenance = () => ({
    schemaVersion: 'training_e2e_backend_provenance.v1',
    environmentSchemaVersion: metadata.schemaVersion,
    verifiedAt: new Date().toISOString(),
    git: structuredClone(metadata.git),
    images: structuredClone(metadata.images),
  });
  const freshnessAtStart = inContainer
    ? recordedBackendProvenance()
    : assertTrainingE2ERunFreshness({
        metadata,
        repoRoot: root,
        gitDir: env.NEXUS_TRAINING_E2E_GIT_DIR,
      });
  for (const field of ['commit', 'baseCommit', 'dirtyTreeDiffSha256']) {
    if (flowEvidence?.backendProvenance?.git?.[field] !== freshnessAtStart.git?.[field]) {
      throw new Error(`Training E2E lifecycle source provenance ${field} does not match current qualifying run`);
    }
  }
  for (const key of ['backend', 'contentEngine']) {
    for (const field of ['name', 'builtImageId', 'actualContainerImageId']) {
      if (flowEvidence?.backendProvenance?.images?.[key]?.[field] !== freshnessAtStart.images?.[key]?.[field]) {
        throw new Error(`Training E2E lifecycle ${key} image provenance ${field} does not match current qualifying run`);
      }
    }
  }
  const dbPath = inContainer
    ? assertResolvedTrainingE2EPath(stateRoot, path.join(stateDir, 'data', 'training-e2e.db'), 'database')
    : assertResolvedTrainingE2EPath(stateRoot, metadata.dbPath, 'database');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  ensurePersonaFixtureSchema(db);

  const scenarios = buildTrainingE2EPersonaScenarios();
  const personas: TrainingE2EPersonaResult[] = [];
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const userId = trainingE2EPersonaUserId(index);
      const tenantId = userId;
      resetPersonaFixtureData(db, userId);
      ensurePersonaUser(db, userId, scenario.canonical.id);
      // Persona setup and the backend now share one Linux SQLite lock domain.
      // Read the row back before minting a token: if the write is not durable
      // and visible, the
      // first authenticated call fails with a bare
      // `401 UNAUTHORIZED "User account no longer exists"` from
      // `auth-middleware.ts:146`, which names neither the persona nor the id
      // and reads like a product auth defect rather than a fixture problem.
      const seededUser = db
        .prepare('SELECT id, status FROM users WHERE id = ?')
        .get(userId) as { id: number; status: string } | undefined;
      if (!seededUser || seededUser.status !== 'active') {
        throw new Error(
          `persona ${scenario.canonical.id} (index ${index}) user ${userId} is not active after ensurePersonaUser: `
          + `${seededUser ? `status=${seededUser.status}` : 'row missing'}`,
        );
      }
      assertPersonaEffectiveMaxEntitlement(db, userId);
      const deviceId = ensurePersonaDevice(db, userId, scenario.canonical.id);
      const accessToken = jwt.sign({
        userId,
        tenantId,
        deviceId,
        staging_fixture: true,
        fixture: `training-e2e-quality-${scenario.canonical.id}`,
      }, jwtSecret, {
        algorithm: 'HS256',
        expiresIn: '2h',
        keyid: 'ios-api-current',
      });
      const api = makePersonaApi(apiBaseUrl, accessToken);

      // Discriminate backend visibility from fixture durability before the
      // first authenticated persona call. The long-lived fixture handle above
      // is not independent evidence: after every backend 401, reopen SQLite
      // and read the exact row through a brand-new connection. A fresh-reader
      // miss points at fixture commit/call-path behavior; a hit proves
      // durability and sends the next investigation to the backend view.
      const USER_VISIBILITY_TIMEOUT_MS = 15_000;
      const USER_VISIBILITY_POLL_MS = 250;
      const visibilityDeadline = Date.now() + USER_VISIBILITY_TIMEOUT_MS;
      let lastVisibilityStatus = 0;
      let visibilityAttempts = 0;
      let firstBackendAuthMessage: string | null = null;
      let lastBackendAuthMessage: string | null = null;
      let lastFreshHostBinding: ReturnType<typeof readPersonaAuthBindingFromFreshConnection> | null = null;
      for (;;) {
        // Keep the auth discriminator cache-neutral. Probing readiness here,
        // before the persona's health rows exist, memoized an `estimated`
        // snapshot in the backend for 30 minutes and hid the later Apple
        // Health fixture from the fatigue/stale-wearable scenarios.
        const probe = await api('GET', '/api/v1/settings/status', undefined, [200, 401]);
        visibilityAttempts += 1;
        lastVisibilityStatus = probe.status;
        if (probe.status === 200) break;
        const backendAuthMessage = String(
          probe.payload?.error?.message
            ?? probe.payload?.message
            ?? probe.payload?.error
            ?? 'unknown 401 response',
        ).slice(0, 200);
        firstBackendAuthMessage ??= backendAuthMessage;
        lastBackendAuthMessage = backendAuthMessage;
        lastFreshHostBinding = readPersonaAuthBindingFromFreshConnection(dbPath, userId, deviceId);
        if (Date.now() >= visibilityDeadline) {
          const freshReaderUserView = lastFreshHostBinding?.user
            ? `id=${lastFreshHostBinding.user.id}, status=${lastFreshHostBinding.user.status}`
            : 'row missing';
          const freshReaderDeviceView = lastFreshHostBinding?.device
            ? `userId=${lastFreshHostBinding.device.userId}, deviceId=${lastFreshHostBinding.device.deviceId}`
            : 'row missing';
          throw new Error(
            `persona ${scenario.canonical.id} (index ${index}) user ${userId} never became visible to the backend `
            + `within ${USER_VISIBILITY_TIMEOUT_MS}ms after ${visibilityAttempts} attempts `
            + `(last backend status ${lastVisibilityStatus}; `
            + `backend auth message first=${JSON.stringify(firstBackendAuthMessage)} last=${JSON.stringify(lastBackendAuthMessage)}; `
            + `fresh reader user: ${freshReaderUserView}; fresh reader device: ${freshReaderDeviceView}).`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, USER_VISIBILITY_POLL_MS));
      }

      const preparePersona = async (
        currentScenario: TrainingE2EPersonaScenario,
      ): Promise<TrainingE2EPersonaFixtureEvidence> => {
        const fixtureSpec = buildTrainingE2EPersonaFixtureSpec(currentScenario);
        const upsertProfile = db.prepare(`
          INSERT INTO user_profiles (user_id, profile_type, data)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id, profile_type) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
        `);
        const profiles = buildTrainingE2EPersonaProfiles(currentScenario);
        const profileErrors = validateTrainingE2EPersonaProfiles(profiles);
        if (profileErrors.length > 0) {
          throw new Error(`${currentScenario.canonical.id} profile fixture is not onboarding-reachable: ${profileErrors.join('; ')}`);
        }
        for (const profile of profiles) {
          upsertProfile.run(userId, profile.profileType, JSON.stringify(profile.data));
        }
        await waitForTrainingE2EProfilesVisible({
          api,
          expectedProfiles: profiles,
        });
        seedPersonaReadiness(db, userId, fixtureSpec.readiness);
        const history = seedPersonaHistory(db, userId, fixtureSpec.adherence);
        const startPolicy = currentScenario.request.startPolicy === 'today'
          ? 'today'
          : 'next_full_week';
        seedPersonaCalendar(
          db,
          userId,
          fixtureSpec.calendar,
          trainingE2ECalendarFixtureDays({
            now: new Date(),
            startPolicy,
            schedulingTimezone: 'Europe/Lisbon',
          }),
        );
        db.prepare("DELETE FROM user_oauth_tokens WHERE user_id = ? AND provider IN ('google', 'outlook')").run(userId);

        const readinessResponse = await api('GET', '/api/v1/training/readiness', undefined, [200]);
        const readiness = readinessResponse.payload?.data ?? {};
        const dataAsOf = typeof readiness.dataAsOf === 'string' ? readiness.dataAsOf : null;
        const dataAsOfMs = dataAsOf ? Date.parse(dataAsOf) : NaN;
        const profileTypes = (db.prepare(`
          SELECT profile_type AS profileType FROM user_profiles WHERE user_id = ? ORDER BY profile_type
        `).all(userId) as Array<{ profileType: string }>).map((row) => row.profileType);
        const healthRows = Number((db.prepare(
          'SELECT COUNT(*) AS count FROM apple_health_data WHERE user_id = ?',
        ).get(userId) as any)?.count ?? 0);
        const eventRows = Number((db.prepare(
          'SELECT COUNT(*) AS count FROM staging_fixture_calendar_events WHERE user_id = ?',
        ).get(userId) as any)?.count ?? 0);
        return {
          userId,
          profileTypes,
          readiness: {
            fixture: fixtureSpec.readiness,
            source: String(readiness.source ?? 'unknown'),
            reasonCode: typeof readiness.reasonCode === 'string' ? readiness.reasonCode : null,
            recommendation: typeof readiness.recommendation === 'string' ? readiness.recommendation : null,
            reasoning: typeof readiness.reasoning === 'string' ? readiness.reasoning : null,
            score: Number(readiness.score ?? 0),
            dataAsOf,
            isStale: Number.isFinite(dataAsOfMs) && Date.now() - dataAsOfMs > 36 * 60 * 60 * 1000,
            healthRows,
          },
          adherence: {
            fixture: fixtureSpec.adherence,
            ...history,
          },
          calendar: {
            fixture: fixtureSpec.calendar,
            eventRows,
          },
        };
      };

      const inspectIsolation = async (planId?: number): Promise<IsolationCounts> => {
        const providerOAuthRows = Number((db.prepare(
          "SELECT COUNT(*) AS count FROM user_oauth_tokens WHERE user_id = ? AND provider IN ('google', 'outlook')",
        ).get(userId) as any)?.count ?? 0);
        const providerEventMappings = planId
          ? Number((db.prepare(
              'SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ? AND calendar_event_id IS NOT NULL',
            ).get(planId) as any)?.count ?? 0)
          : 0;
        const providerOwnershipRows = planId
          ? Number((db.prepare(`
              SELECT COUNT(*) AS count
                FROM training_agenda_event_ownership
               WHERE plan_id = ?
            `).get(planId) as any)?.count ?? 0)
          : 0;
        return { providerOAuthRows, providerEventMappings, providerOwnershipRows };
      };

      const inspectPlanAgenda = async (planId: number, weeksPayload: any): Promise<PlanAgendaInvariant> => {
        const sessionRows = db.prepare(`
          SELECT s.id,
                 s.plan_id AS planId,
                 w.week_number AS weekNumber,
                 COALESCE(s.status, 'pending') AS lifecycleState,
                 s.session_identity_key AS sessionIdentityKey,
                 s.session_shape_hash AS sessionShapeHash,
                 s.day_of_week AS dayOfWeek,
                 s.title,
                 s.session_type AS sessionType,
                 s.intensity_text AS intensityText,
                 s.scheduled_start_at AS scheduledStartAt,
                 s.scheduled_end_at AS scheduledEndAt,
                 s.duration_minutes AS durationMinutes,
                 COALESCE(s.preferred_time_unavailable, 0) AS preferredTimeUnavailable,
                 s.schedule_reason_code AS scheduleReasonCode,
                 s.exercises_json AS exercisesJson,
                 json_extract(p.preferences_json, '$.schedulingTimezone') AS scheduleTimeZone
            FROM training_sessions s
            JOIN training_weeks w ON w.id = s.week_id
            JOIN fitness_training_plans p ON p.id = s.plan_id
           WHERE s.plan_id = ?
           ORDER BY s.id
        `).all(planId) as Array<{
          id: number;
          planId: number;
          weekNumber: number;
          lifecycleState: string;
          sessionIdentityKey: string | null;
          sessionShapeHash: string | null;
          dayOfWeek: string;
          title: string;
          sessionType: string;
          intensityText: string | null;
          scheduledStartAt: string | null;
          scheduledEndAt: string | null;
          scheduleTimeZone: string | null;
          durationMinutes: number | null;
          preferredTimeUnavailable: number;
          scheduleReasonCode: string | null;
          exercisesJson: string | null;
        }>;
        const persistedTruth: TrainingE2EPersistedSessionTruth[] = sessionRows.map((row) => ({
          id: Number(row.id),
          planId: Number(row.planId),
          weekNumber: Number(row.weekNumber),
          lifecycleState: String(row.lifecycleState),
          sessionIdentityKey: row.sessionIdentityKey,
          sessionShapeHash: row.sessionShapeHash,
          dayOfWeek: String(row.dayOfWeek),
          title: String(row.title),
          sessionType: String(row.sessionType),
          intensityText: row.intensityText,
          scheduledStartAt: row.scheduledStartAt,
          scheduledEndAt: row.scheduledEndAt,
          scheduleTimeZone: String(row.scheduleTimeZone ?? ''),
          durationMinutes: row.durationMinutes == null ? null : Number(row.durationMinutes),
          preferredTimeUnavailable: Number(row.preferredTimeUnavailable) === 1,
          exercises: (() => {
            if (typeof row.exercisesJson !== 'string' || !row.exercisesJson.trim()) return null;
            try {
              return JSON.parse(row.exercisesJson);
            } catch {
              return { invalidPersistedExercisesJson: row.exercisesJson };
            }
          })(),
        }));
        const persistedPlanSessions = sessionRows.length;
        const comparison = comparePersistedSessionsToReadModel(persistedTruth, weeksPayload);
        const weekNotes = (db.prepare(
          'SELECT notes FROM training_weeks WHERE plan_id = ? ORDER BY week_number',
        ).all(planId) as Array<{ notes: string | null }>).flatMap((row) => parsePersistedWeekNotes(row.notes));
        const busyWindowOverlapCount = Number((db.prepare(`
          SELECT COUNT(*) AS count
            FROM training_sessions s
            JOIN staging_fixture_calendar_events e
              ON e.user_id = ?
             AND s.scheduled_start_at < e.end_at
             AND s.scheduled_end_at > e.start_at
           WHERE s.plan_id = ?
             AND s.scheduled_start_at IS NOT NULL
             AND s.scheduled_end_at IS NOT NULL
        `).get(userId, planId) as any)?.count ?? 0);
        // With calendarSource=null, fixture busy windows affect scheduling but
        // never authorize a provider projection or Secretary agenda write.
        const secretaryAgendaRows = Number((db.prepare(`
          SELECT COUNT(*) AS count
            FROM secretary_agenda_items
           WHERE source_skill = 'training'
             AND source_entity_type = 'training_session'
             AND source_entity_id IN (
               SELECT CAST(id AS TEXT) FROM training_sessions WHERE plan_id = ?
             )
        `).get(planId) as any)?.count ?? 0);
        return {
          planReadModelMatches: persistedPlanSessions > 0
            && comparison.matches
            && busyWindowOverlapCount === 0,
          providerFreeAgendaIsolation: secretaryAgendaRows === 0,
          persistedPlanSessions,
          readModelSessions: comparison.readModelSessions,
          secretaryAgendaRows,
          preferredTimeUnavailableCount: persistedTruth.filter((row) => row.preferredTimeUnavailable).length,
          busyWindowOverlapCount,
          identityMismatches: comparison.mismatches,
          sessionIds: persistedTruth.map((row) => row.id),
          weekNotes,
          scheduleReasonCodes: sessionRows
            .map((row) => row.scheduleReasonCode ?? '')
            .filter(Boolean),
          scheduleStatuses: sessionRows
            .map((row) => row.lifecycleState ?? '')
            .filter(Boolean),
        };
      };

      const inspectCleanup = async (
        planId: number,
        sessionIds: number[],
      ): Promise<TrainingE2ECleanupProof> => {
        const count = (sql: string, ...params: unknown[]) => Number(
          (db.prepare(sql).get(...params) as { count?: number } | undefined)?.count ?? 0,
        );
        const planRows = count('SELECT COUNT(*) AS count FROM fitness_training_plans WHERE id = ?', planId);
        const weekRows = count('SELECT COUNT(*) AS count FROM training_weeks WHERE plan_id = ?', planId);
        const sessionRowsAfterCleanup = count('SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ?', planId);
        const completionRows = count('SELECT COUNT(*) AS count FROM training_completions WHERE plan_id = ?', planId);
        const ownershipRows = count('SELECT COUNT(*) AS count FROM training_agenda_event_ownership WHERE plan_id = ?', planId);
        let agendaRows = 0;
        if (sessionIds.length > 0) {
          const placeholders = sessionIds.map(() => '?').join(', ');
          agendaRows = count(`
            SELECT COUNT(*) AS count
              FROM secretary_agenda_items
             WHERE source_skill = 'training'
               AND source_entity_type = 'training_session'
               AND source_entity_id IN (${placeholders})
          `, ...sessionIds.map(String));
        }
        return {
          clean: [planRows, weekRows, sessionRowsAfterCleanup, completionRows, agendaRows, ownershipRows]
            .every((value) => value === 0),
          planRows,
          weekRows,
          sessionRows: sessionRowsAfterCleanup,
          completionRows,
          agendaRows,
          ownershipRows,
        };
      };

      const probeAuthorizationScopeIsolation = async (): Promise<AuthorizationScopeIsolationEvidence> => {
        const foreignUserId = 1_099_999;
        const foreignTenantId = 1_099_998;
        resetPersonaFixtureData(db, foreignUserId);
        ensurePersonaUser(db, foreignUserId, 'cross_tenant_canary');
        assertPersonaEffectiveMaxEntitlement(db, foreignUserId);
        const now = new Date();
        const startDate = now.toISOString().slice(0, 10);
        const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const insertPlan = db.prepare(`
            INSERT INTO fitness_training_plans (
              user_id, tenant_id, name, sport, goal, duration_weeks, status,
              start_date, end_date, preferences_json, created_at, updated_at
            ) VALUES (?, ?, ?, 'hybrid',
              'Must remain owned by its exact scope', 1, 'active', ?, ?, '{}', ?, ?)
          `);
        const definitions: Array<{
          boundary: AuthorizationScopeBoundary;
          ownerUserId: number;
          ownerTenantId: number;
        }> = [
          {
            boundary: 'foreign_user_same_tenant',
            ownerUserId: foreignUserId,
            ownerTenantId: tenantId,
          },
          {
            boundary: 'same_user_foreign_tenant',
            ownerUserId: userId,
            ownerTenantId: foreignTenantId,
          },
        ];
        const probes: AuthorizationScopeProbeEvidence[] = [];
        try {
          for (const definition of definitions) {
            const insert = insertPlan.run(
              definition.ownerUserId,
              definition.ownerTenantId,
              `Training E2E ${definition.boundary} canary`,
              startDate,
              end.toISOString().slice(0, 10),
              now.toISOString(),
              now.toISOString(),
            );
            const foreignPlanId = Number(insert.lastInsertRowid);
            try {
              const response = await api(
                'POST',
                '/api/v1/training/plan/cancel',
                { planId: foreignPlanId },
                [200, 403, 404, 409],
              );
              const row = db.prepare(`
                SELECT user_id AS userId, tenant_id AS tenantId, status
                  FROM fitness_training_plans
                 WHERE id = ?
              `).get(foreignPlanId) as { userId: number; tenantId: number | string; status: string } | undefined;
              probes.push({
                boundary: definition.boundary,
                foreignPlanId,
                responseStatus: response.status,
                responseCancelled: typeof response.payload?.data?.cancelled === 'boolean'
                  ? response.payload.data.cancelled
                  : null,
                expectedOwnerUserId: definition.ownerUserId,
                expectedOwnerTenantId: definition.ownerTenantId,
                remainedOwnedByExpectedScope: Number(row?.userId) === definition.ownerUserId
                  && Number(row?.tenantId) === definition.ownerTenantId,
                remainedActive: row?.status === 'active',
              });
            } finally {
              db.prepare('DELETE FROM fitness_training_plans WHERE id = ?').run(foreignPlanId);
            }
          }
          const evidence = { probes };
          assertAuthorizationScopeIsolationEvidence(evidence);
          return evidence;
        } finally {
          const foreignCleanup = deletePersonaFixtureData(db, foreignUserId);
          assertTrainingE2EPersonaFixtureCleanupProof(foreignCleanup);
        }
      };

      personas.push(await runTrainingE2EPersonaScenario({
        scenario,
        api,
        preparePersona,
        inspectIsolation,
        inspectPlanAgenda,
        inspectCleanup,
        probeAuthorizationScopeIsolation,
        cleanupPersonaFixtures: async () => deletePersonaFixtureData(db, userId),
      }));
    }
    const finalProvenance = inContainer
      ? recordedBackendProvenance()
      : assertTrainingE2ERunFreshness({
          metadata,
          repoRoot: root,
          gitDir: env.NEXUS_TRAINING_E2E_GIT_DIR,
        });
    const evidence = {
      schemaVersion: 'training_e2e_contract.v3',
      runId: env.NEXUS_TRAINING_E2E_RUN_ID,
      qualifying: metadata.runPolicy?.qualifying === true,
      backendBaseUrl: baseUrl,
      backendGit: finalProvenance.git,
      images: finalProvenance.images,
      lifecycleEvidence: flowEvidence,
      personas,
      generatedAt: new Date().toISOString(),
      personaUserIds: personas.map((persona) => persona.fixtureEvidence.userId),
    };
    assertTrainingE2EEvidenceComplete(evidence, {
      personaIds: TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.map((persona) => persona.id),
    });
    const evidencePath = path.join(stateDir, 'training-e2e-contract-evidence.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, personaCount: personas.length }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
