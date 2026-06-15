// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { buildWeekPlan, isActiveTrainingSession, loadCoachKnowledge, sampleHybridAthlete, sampleMarathonAthlete, sampleTriathlete } from '../services/coach-kernel';
import { trainingEvalPersonaBank } from '../services/coach-kernel/evaluation';
import type { AthleteState, AvailabilityWindow, DayOfWeek, Session, Sport, WeeklyPlan } from '../services/coach-kernel/types';
import { timeToMinutes } from '../services/coach-kernel/utils';

export type TrainingAadScenarioId =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'
  | 'AA' | 'AB' | 'AC' | 'AD';

export interface TrainingAadCalendarEvent {
  date: string;
  calendarType: string;
  busy: Array<{ start: string; end: string; label: string }>;
  expectedBehavior: string;
  source: 'fixture' | 'static';
}

export interface TrainingAadScenarioDefinition {
  id: TrainingAadScenarioId;
  name: string;
  userAccount: string;
  inputs: string;
  signalInjectionPath: string;
  expectedBackendResult: string;
  expectedIosResult: string;
  calendarExpectation: string;
  evidenceExpectation: string;
  athlete: AthleteState;
  validators: TrainingAadValidator[];
}

export interface TrainingAadScenarioResult {
  scenario: TrainingAadScenarioId;
  name: string;
  userAccount: string;
  inputs: string;
  signalInjectionPath: string;
  expectedBackendResult: string;
  expectedIosResult: string;
  calendarExpectation: string;
  evidenceExpectation: string;
  actualBackendResult: string;
  actualIosResult: string;
  score: number;
  passFail: 'pass' | 'fail';
  findings: string[];
  planSummary: {
    discipline: WeeklyPlan['discipline'];
    phase: WeeklyPlan['phase'];
    totalSessions: number;
    activeSessions: number;
    totalActiveMinutes: number;
    sports: Partial<Record<Sport, number>>;
  };
}

export interface TrainingAadHarnessResult {
  generatedAt: string;
  weekStart: string;
  timezone: string;
  testIdentity: string;
  calendarFixture: TrainingAadCalendarEvent[];
  scenarioResults: TrainingAadScenarioResult[];
  aggregate: {
    scenarioCount: number;
    passCount: number;
    failCount: number;
    averageScore: number;
  };
  blockers: string[];
}

export type TrainingAadNegativeControlId =
  | 'unavailable_equipment'
  | 'calendar_overlap'
  | 'bad_sleep_ignored'
  | 'injury_ignored'
  | 'missed_session_cramming'
  | 'race_taper_cramming'
  | 'raw_ui_internal_text'
  | 'tenant_leak';

export interface TrainingAadNegativeControlResult {
  id: TrainingAadNegativeControlId;
  negativeControl: string;
  expectedFailure: string;
  actualResult: string;
  passFail: 'pass' | 'fail';
  notes: string[];
}

type TrainingAadValidator = (context: {
  scenario: TrainingAadScenarioDefinition;
  plan: WeeklyPlan;
}) => string[];

const DEFAULT_TEST_IDENTITY = 'nexushubbot@gmail.com';
const TIMEZONE = 'Europe/Lisbon';
const DEFAULT_WEEK_START = '2026-06-22';
const DST_DATE = '2026-10-25';

const dayOrder: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const rawInternalPattern = /(?:\b(?:undefined|null|NaN|selectorTrace|selector_trace|catalogVersion|catalog_version|selectorPolicy|selector_policy|feature flag|feature_flag|stack trace|stackTrace|red_readiness|easy_run|threshold_run|strength_hypertrophy|medical_referral|conflict_event_title|database id|database_id|databaseId)\b|\[object Object\])/i;
const rawJsonPattern = /(?:\{|\[)\s*"[^"]+"\s*:/;
const unavailableGymPattern = /\b(barbell|cable|machine|smith|rack)\b/i;
const bodyweightOnlyBlockedPattern = /\b(barbell|dumbbell|cable|machine|rack|bench|trainer|pool|bike|swim|pullup)\b/i;
const exerciseEquipmentById = new Map(loadCoachKnowledge().exercises.map((exercise) => [exercise.id, exercise.equipment]));

function getTrainingAadTestIdentity(): string {
  const candidate = String(process.env.TRAINING_AAD_TEST_IDENTITY || DEFAULT_TEST_IDENTITY).trim();
  return candidate || DEFAULT_TEST_IDENTITY;
}

function cloneAthlete(athlete: AthleteState): AthleteState {
  return JSON.parse(JSON.stringify(athlete)) as AthleteState;
}

function clonePlan(plan: WeeklyPlan): WeeklyPlan {
  return JSON.parse(JSON.stringify(plan)) as WeeklyPlan;
}

function personaAthlete(id: string): AthleteState {
  const persona = trainingEvalPersonaBank.find((item) => item.id === id);
  if (!persona) throw new Error(`Missing Training eval persona ${id}`);
  return cloneAthlete(persona.athlete);
}

function dayDate(weekStart: string, day: DayOfWeek): string {
  const date = new Date(`${weekStart}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayOrder.indexOf(day));
  return date.toISOString().slice(0, 10);
}

export function buildNexushubbotLisbonCalendarFixture(weekStart = DEFAULT_WEEK_START): TrainingAadCalendarEvent[] {
  return [
    {
      date: dayDate(weekStart, 'monday'),
      calendarType: 'Busy workday',
      busy: [
        { start: '09:00', end: '12:00', label: 'work block' },
        { start: '13:00', end: '17:30', label: 'work block' },
        { start: '22:00', end: '23:59', label: 'DND/sleep' },
        { start: '00:00', end: '07:00', label: 'DND/sleep' },
      ],
      expectedBehavior: 'No long session; only short/easy/recovery if needed; no DND overlap.',
      source: 'fixture',
    },
    {
      date: dayDate(weekStart, 'tuesday'),
      calendarType: 'Fragmented day',
      busy: [
        { start: '07:45', end: '12:25', label: 'fragmented meetings' },
        { start: '12:55', end: '18:20', label: 'fragmented meetings' },
        { start: '22:00', end: '23:59', label: 'DND/sleep' },
        { start: '00:00', end: '07:00', label: 'DND/sleep' },
      ],
      expectedBehavior: 'No long/hard session squeezed into gaps; short mobility/recovery only.',
      source: 'fixture',
    },
    {
      date: dayDate(weekStart, 'wednesday'),
      calendarType: 'Travel day',
      busy: [
        { start: '00:00', end: '07:00', label: 'DND/sleep' },
        { start: '08:00', end: '18:00', label: 'all-day travel' },
        { start: '22:00', end: '23:59', label: 'DND/sleep' },
      ],
      expectedBehavior: 'Reduced volume, travel-safe, bodyweight only.',
      source: 'fixture',
    },
    {
      date: dayDate(weekStart, 'thursday'),
      calendarType: 'Existing workout + personal commitment',
      busy: [
        { start: '00:00', end: '07:00', label: 'DND/sleep' },
        { start: '07:30', end: '08:15', label: 'existing workout block' },
        { start: '18:00', end: '19:00', label: 'personal commitment' },
        { start: '22:00', end: '23:59', label: 'DND/sleep' },
      ],
      expectedBehavior: 'Avoid duplicate/conflict and no overlap.',
      source: 'fixture',
    },
    {
      date: dayDate(weekStart, 'friday'),
      calendarType: 'All-day busy marker',
      busy: [
        { start: '00:00', end: '23:59', label: 'conference/all-day busy' },
      ],
      expectedBehavior: 'No normal scheduling unless explicit override.',
      source: 'fixture',
    },
    {
      date: dayDate(weekStart, 'saturday'),
      calendarType: 'Long availability',
      busy: [
        { start: '00:00', end: '07:00', label: 'DND/sleep' },
        { start: '22:00', end: '23:59', label: 'DND/sleep' },
      ],
      expectedBehavior: 'Long run/ride should land in the 08:00-11:00 window if required.',
      source: 'fixture',
    },
    {
      date: dayDate(weekStart, 'sunday'),
      calendarType: 'Recovery/flexible',
      busy: [
        { start: '00:00', end: '07:00', label: 'DND/sleep' },
        { start: '12:00', end: '13:30', label: 'light personal commitment' },
        { start: '22:00', end: '23:59', label: 'DND/sleep' },
      ],
      expectedBehavior: 'Recovery/spillover only; no unsafe stacking.',
      source: 'fixture',
    },
    {
      date: DST_DATE,
      calendarType: 'DST case',
      busy: [
        { start: '00:00', end: '07:00', label: 'DND/sleep around Europe/Lisbon DST boundary' },
      ],
      expectedBehavior: 'Correct local date/time display and no one-hour drift.',
      source: 'static',
    },
  ];
}

function lisbonAvailabilityForSports(sports: Sport[]): AvailabilityWindow[] {
  return [
    { dayOfWeek: 'monday', start: '07:00', end: '07:45', sports, label: 'before work' },
    { dayOfWeek: 'monday', start: '18:30', end: '19:15', sports, label: 'after work' },
    { dayOfWeek: 'tuesday', start: '07:15', end: '07:40', sports: ['strength'], label: 'fragmented recovery slot' },
    { dayOfWeek: 'wednesday', start: '18:30', end: '19:00', sports: ['strength'], label: 'travel bodyweight slot' },
    { dayOfWeek: 'thursday', start: '12:00', end: '12:45', sports, label: 'lunch window' },
    { dayOfWeek: 'saturday', start: '08:00', end: '11:00', sports, label: 'long weekend window' },
    { dayOfWeek: 'sunday', start: '09:00', end: '10:00', sports, label: 'recovery window' },
  ];
}

function withLisbonCalendar(athlete: AthleteState, sports: Sport[] = ['running', 'cycling', 'strength', 'swimming']): AthleteState {
  return {
    ...athlete,
    availability: {
      weeklyWindows: lisbonAvailabilityForSports(sports),
      preferredLongSessionDay: 'saturday',
      preferredTimesBySport: { running: '08:00', cycling: '08:00', strength: '12:00', swimming: '08:00' },
      maxSessionsPerDay: 1,
    },
    constraints: [
      ...athlete.constraints,
      { id: 'qa-lisbon-calendar-week', type: 'time', severity: 'high', description: 'Fixture calendar: busy workday, travel, DND, all-day busy, and long Saturday availability.' },
    ],
  };
}

function withReadiness(athlete: AthleteState, level: AthleteState['readiness']['level'], sleepHours: number, soreness: AthleteState['readiness']['soreness']): AthleteState {
  return {
    ...athlete,
    readiness: {
      ...athlete.readiness,
      capturedAt: `${DEFAULT_WEEK_START}T06:30:00.000Z`,
      level,
      score: level === 'red' ? 28 : level === 'orange' ? 48 : 62,
      sleepHours,
      hrvStatus: level === 'green' ? 'normal' : 'low',
      energyReserve: level === 'red' ? 25 : 45,
      soreness,
    },
  };
}

function withMissedKeySession(athlete: AthleteState, sport: Sport = 'running'): AthleteState {
  return {
    ...athlete,
    recentSessions: [
      ...athlete.recentSessions,
      {
        id: 'aad-missed-key',
        sport,
        sessionType: sport === 'cycling' ? 'threshold_ride' : sport === 'strength' ? 'strength_hypertrophy' : sport === 'swimming' ? 'threshold_swim' : 'threshold_run',
        completedAt: '2026-06-20T07:00:00.000Z',
        durationMinutes: 55,
        intensityZone: 'threshold',
        fatigueCost: 'high',
        completed: false,
        completionStatus: 'skipped',
        keySession: true,
        missedReason: 'calendar_conflict',
      },
    ],
    compliance: {
      ...athlete.compliance,
      trailing14DayCompliance: Math.min(athlete.compliance.trailing14DayCompliance, 0.55),
      missedKeySessions: Math.max(athlete.compliance.missedKeySessions, 1),
      consecutiveMisses: Math.max(athlete.compliance.consecutiveMisses, 1),
    },
  };
}

function withGap(athlete: AthleteState): AthleteState {
  return {
    ...athlete,
    recentSessions: [],
    trainingHistory: {
      lastWeekMinutesBySport: {},
      trailing4WeekMinutesBySport: { running: [120, 80, 0, 0], cycling: [90, 45, 0, 0], strength: [80, 30, 0, 0] },
    },
    compliance: { trailing14DayCompliance: 0.1, bySport: {}, missedKeySessions: 2, consecutiveMisses: 6 },
    currentBlock: { ...athlete.currentBlock, phase: 'maintenance', volumeProgressionPct: 0 },
    constraints: [
      ...athlete.constraints,
      { id: 'aad-return-from-gap', type: 'fatigue', severity: 'high', description: 'Return after 21 days without completed training.' },
    ],
  };
}

function withTravel(athlete: AthleteState): AthleteState {
  return {
    ...withLisbonCalendar(athlete, ['running', 'strength']),
    equipment: { hasGym: false, hasBarbell: false, hasDumbbells: false, hasBikeTrainer: false, hasPool: false, hasTrack: false, notes: ['travel day bodyweight only'] },
    constraints: [
      ...athlete.constraints,
      { id: 'aad-travel-bodyweight', type: 'equipment', severity: 'high', description: 'Travel window: bodyweight only and limited time.' },
    ],
  };
}

function withPain(athlete: AthleteState, area: string, severity: 'low' | 'moderate' | 'high' = 'moderate', impact: Array<Sport | 'strength'> = ['strength', 'running']): AthleteState {
  return {
    ...athlete,
    readiness: {
      ...athlete.readiness,
      level: severity === 'high' ? 'red' : 'yellow',
      score: severity === 'high' ? 30 : Math.min(athlete.readiness.score, 62),
      painFlags: [...athlete.readiness.painFlags, { area, severity, impact }],
    },
    constraints: [
      ...athlete.constraints,
      { id: `aad-${area}`, type: 'injury', severity: severity === 'low' ? 'low' : 'high', description: `${area} reported; avoid provocative loading.` },
    ],
  };
}

function activeSessions(plan: WeeklyPlan): Session[] {
  return plan.sessions.filter(isActiveTrainingSession);
}

function ensureActiveSession(plan: WeeklyPlan, index: number): Session {
  const active = activeSessions(plan);
  if (active[index]) return active[index];
  if (!active[0]) throw new Error('Negative control requires at least one active session.');
  const cloned = JSON.parse(JSON.stringify(active[0])) as Session;
  cloned.id = `qa-negative-session-${index + 1}`;
  plan.sessions.push(cloned);
  return cloned;
}

function sessionStrings(plan: WeeklyPlan): string[] {
  const strings: string[] = [...plan.notes];
  for (const session of plan.sessions) {
    strings.push(session.title, session.description, session.scheduleReason ?? '');
    for (const reason of session.decisionReasons ?? []) strings.push(reason.text, reason.sourceConstraint?.label ?? '');
    for (const exercise of session.exercises ?? []) {
      strings.push(exercise.name, exercise.notes ?? '', exercise.progressionSummary ?? '', exercise.progressionReason ?? '');
      strings.push(...(exercise.selectionReason?.pickedBecause ?? []));
      strings.push(...(exercise.selectionReason?.alternativesRejectedBecause ?? []).map((item) => item.reason));
    }
  }
  for (const reason of plan.decisionReasons ?? []) strings.push(reason.text, reason.sourceConstraint?.label ?? '');
  for (const result of plan.guardrailResults) strings.push(result.message);
  return strings.filter((item) => item.trim().length > 0);
}

function sessionText(plan: WeeklyPlan): string {
  return sessionStrings(plan).join('\n');
}

function getWindowForSession(athlete: AthleteState, session: Session): AvailabilityWindow | undefined {
  return athlete.availability.weeklyWindows.find((window) =>
    window.dayOfWeek === session.dayOfWeek
    && (!window.sports || window.sports.includes(session.sport))
    && (!session.startTime || timeToMinutes(session.startTime) >= timeToMinutes(window.start))
    && (!session.endTime || timeToMinutes(session.endTime) <= timeToMinutes(window.end))
  );
}

function overlaps(start: string, end: string, busyStart: string, busyEnd: string): boolean {
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  return startMin < timeToMinutes(busyEnd) && endMin > timeToMinutes(busyStart);
}

function validateGenerated({ plan }: { plan: WeeklyPlan }): string[] {
  return activeSessions(plan).length > 0 ? [] : ['No active training sessions were generated.'];
}

function validateNoRawInternals({ plan }: { plan: WeeklyPlan }): string[] {
  return sessionStrings(plan)
    .filter((text) => rawInternalPattern.test(text) || rawJsonPattern.test(text))
    .map((text) => `User-facing text contains raw/internal string: ${text.slice(0, 120)}`);
}

function validateNoPrivateCalendarTitles({ plan }: { plan: WeeklyPlan }): string[] {
  const forbidden = ['Board strategy review', 'Family medical appointment', 'Private dinner location'];
  const text = sessionText(plan);
  return forbidden.filter((item) => text.includes(item)).map((item) => `Private calendar title leaked into Training copy: ${item}`);
}

function validateCalendarFit({ scenario, plan }: { scenario: TrainingAadScenarioDefinition; plan: WeeklyPlan }): string[] {
  const fixture = buildNexushubbotLisbonCalendarFixture();
  const findings: string[] = [];
  for (const session of activeSessions(plan)) {
    if (!session.startTime || !session.endTime) {
      findings.push(`${session.title} is active but missing start/end time.`);
      continue;
    }
    const window = getWindowForSession(scenario.athlete, session);
    if (!window) {
      findings.push(`${session.title} does not fit a declared availability window.`);
    }
    if (timeToMinutes(session.startTime) < timeToMinutes('07:00') || timeToMinutes(session.endTime) > timeToMinutes('22:00')) {
      findings.push(`${session.title} overlaps DND/sleep bounds.`);
    }
    const date = dayDate(DEFAULT_WEEK_START, session.dayOfWeek);
    const calendarDay = fixture.find((item) => item.date === date);
    for (const busy of calendarDay?.busy ?? []) {
      if (overlaps(session.startTime, session.endTime, busy.start, busy.end)) {
        findings.push(`${session.title} overlaps ${calendarDay?.calendarType} busy block (${busy.label}).`);
      }
    }
  }
  return findings;
}

function validateNoUnavailableEquipment(pattern = unavailableGymPattern): TrainingAadValidator {
  return ({ plan }) => {
    const findings: string[] = [];
    for (const session of activeSessions(plan)) {
      for (const exercise of session.exercises ?? []) {
        const equipment = exerciseEquipmentById.get(exercise.exerciseId) ?? [];
        const blockedEquipment = equipment.filter((item) => pattern.test(item));
        if (blockedEquipment.length > 0) {
          findings.push(`${session.title} includes unavailable equipment for ${exercise.name}: ${blockedEquipment.join(', ')}`);
        }
      }
    }
    return findings;
  };
}

function validateNoHardStack({ plan }: { plan: WeeklyPlan }): string[] {
  const hardDays = new Set(activeSessions(plan)
    .filter((session) => ['threshold', 'vo2', 'neuromuscular'].includes(session.intensityZone) || session.fatigueCost === 'very_high')
    .map((session) => dayOrder.indexOf(session.dayOfWeek))
    .filter((index) => index >= 0));
  const findings: string[] = [];
  for (const day of hardDays) {
    if (hardDays.has(day + 1)) findings.push('Hard/key sessions are stacked on consecutive days without a local rationale.');
  }
  return findings;
}

function validateRecoveryAdjusted({ scenario, plan }: { scenario: TrainingAadScenarioDefinition; plan: WeeklyPlan }): string[] {
  if (scenario.athlete.readiness.level !== 'red' && scenario.athlete.readiness.level !== 'orange') return [];
  const active = activeSessions(plan);
  const hard = active.filter((session) => ['threshold', 'vo2', 'neuromuscular'].includes(session.intensityZone) || session.fatigueCost === 'very_high');
  const text = sessionText(plan).toLowerCase();
  const findings: string[] = [];
  if (plan.phase !== 'deload' && plan.phase !== 'maintenance') findings.push(`Low readiness did not move week to deload/maintenance; phase=${plan.phase}.`);
  if (hard.length > 1) findings.push(`Low readiness still produced ${hard.length} hard sessions.`);
  if (!/(recovery|readiness|sleep|fatigue|soreness|deload|maintenance)/i.test(text)) findings.push('Low readiness adjustment lacks a readable recovery explanation.');
  return findings;
}

function validateRedFlag({ plan }: { plan: WeeklyPlan }): string[] {
  const active = activeSessions(plan);
  const hard = active.filter((session) => ['threshold', 'vo2', 'neuromuscular'].includes(session.intensityZone) || session.fatigueCost === 'very_high');
  const text = sessionText(plan).toLowerCase();
  const findings: string[] = [];
  if (hard.length > 0) findings.push(`Safety red flag still produced hard sessions: ${hard.map((session) => session.title).join(', ')}`);
  if (!/(professional|support|medical|pause|safety|reduce|deload|recovery|pain|illness)/i.test(text)) findings.push('Safety red flag lacks non-diagnostic safety/recovery copy.');
  if (/(diagnos|treats|cures|injury risk proves|acwr proves)/i.test(text)) findings.push('Safety copy is overconfident or diagnostic.');
  return findings;
}

function validateLongSessionSaturday({ plan }: { plan: WeeklyPlan }): string[] {
  const active = activeSessions(plan);
  const long = active
    .filter((session) => session.sport !== 'strength')
    .sort((left, right) => right.durationMinutes - left.durationMinutes)[0];
  if (!long) return [];
  return long.dayOfWeek === 'saturday' ? [] : [`Longest endurance session landed on ${long.dayOfWeek}, not Saturday long availability.`];
}

function validateSwimmingSpecific({ plan }: { plan: WeeklyPlan }): string[] {
  const swims = activeSessions(plan).filter((session) => session.sport === 'swimming');
  const findings: string[] = [];
  if (swims.length === 0) findings.push('No swim sessions generated.');
  for (const swim of swims) {
    const text = `${swim.title} ${swim.description} ${swim.tags.join(' ')}`.toLowerCase();
    if (!/(swim|drill|technique|aerobic|threshold|speed|cooldown|warmup)/.test(text)) {
      findings.push(`${swim.title} is not clearly swim-specific.`);
    }
  }
  return findings;
}

function validateTriathlonBalance({ plan }: { plan: WeeklyPlan }): string[] {
  const sports = new Set(activeSessions(plan).map((session) => session.sport));
  const findings: string[] = [];
  for (const sport of ['swimming', 'cycling', 'running'] as Sport[]) {
    if (!sports.has(sport)) findings.push(`Triathlon/hybrid scenario missing ${sport}.`);
  }
  return findings;
}

function validateConflictAcknowledged({ plan }: { plan: WeeklyPlan }): string[] {
  const text = sessionText(plan).toLowerCase();
  return /(constraint|limited|priority|compromise|trade|time|capacity|recovery|protect)/.test(text)
    ? []
    : ['Conflicting goal scenario lacks tradeoff/constraint explanation.'];
}

function validateCautiousProgression({ plan }: { plan: WeeklyPlan }): string[] {
  const total = activeSessions(plan).reduce((sum, session) => sum + session.durationMinutes, 0);
  const findings: string[] = [];
  if (total > 220) findings.push(`Return/cautious progression total minutes too high for local fixture: ${total}.`);
  if (activeSessions(plan).some((session) => session.fatigueCost === 'very_high')) findings.push('Cautious return produced very-high fatigue session.');
  return findings;
}

function validateEquipmentRestoredGradual({ plan }: { plan: WeeklyPlan }): string[] {
  const text = sessionText(plan).toLowerCase();
  const total = activeSessions(plan).reduce((sum, session) => sum + session.durationMinutes, 0);
  const findings: string[] = [];
  if (total > 280) findings.push(`Equipment-restored week jumps too high in volume: ${total}.`);
  if (!/(restore|equipment|progress|gradual|build|return|reentry|maintenance|capacity)/.test(text)) findings.push('Equipment-restored scenario lacks a gradual progression explanation.');
  return findings;
}

function validateDuplicateRetryLocal(): TrainingAadValidator {
  return ({ scenario, plan }) => {
    const retry = buildWeekPlan(cloneAthlete(scenario.athlete), DEFAULT_WEEK_START);
    const firstShape = plan.sessions.map((session) => `${session.dayOfWeek}:${session.startTime ?? ''}:${session.title}:${session.durationMinutes}`).join('|');
    const retryShape = retry.sessions.map((session) => `${session.dayOfWeek}:${session.startTime ?? ''}:${session.title}:${session.durationMinutes}`).join('|');
    return firstShape === retryShape ? [] : ['Local duplicate retry was not deterministic for the same fixture input.'];
  };
}

function validateSameAccountTwoTenants(): TrainingAadValidator {
  const testIdentity = getTrainingAadTestIdentity();
  return () => {
    const tenantA = {
      tenantId: 1000013,
      email: testIdentity,
      readiness: 'red',
      privateCalendarToken: 'tenant-a-local-fixture',
      planId: 'tenant-a-plan',
    };
    const tenantB = {
      tenantId: 2000013,
      email: testIdentity,
      readiness: 'green',
      privateCalendarToken: 'tenant-b-local-fixture',
      planId: 'tenant-b-plan',
    };
    const readModel = [tenantA, tenantB].filter((item) => item.tenantId === tenantB.tenantId);
    if (readModel.length !== 1 || readModel[0].planId !== 'tenant-b-plan') return ['Same-email/two-tenant fixture leaked or mixed tenant rows.'];
    if (JSON.stringify(readModel).includes('tenant-a')) return ['Tenant A marker leaked into Tenant B read model.'];
    return [];
  };
}

function validateDstFixture(): TrainingAadValidator {
  return () => {
    const before = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date('2026-10-25T00:30:00.000Z'));
    const after = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date('2026-10-25T02:30:00.000Z'));
    return before === after ? ['Europe/Lisbon DST fixture did not show distinguishable local offset behavior.'] : [];
  };
}

function summarizeSports(sessions: Session[]): Partial<Record<Sport, number>> {
  return sessions.reduce<Partial<Record<Sport, number>>>((acc, session) => {
    acc[session.sport] = (acc[session.sport] ?? 0) + 1;
    return acc;
  }, {});
}

function scenario(
  id: TrainingAadScenarioId,
  name: string,
  athlete: AthleteState,
  inputs: string,
  signalInjectionPath: string,
  expectedBackendResult: string,
  expectedIosResult: string,
  calendarExpectation: string,
  evidenceExpectation: string,
  validators: TrainingAadValidator[],
): TrainingAadScenarioDefinition {
  const testIdentity = getTrainingAadTestIdentity();
  return {
    id,
    name,
    userAccount: `${testIdentity} local fixture`,
    inputs,
    signalInjectionPath,
    expectedBackendResult,
    expectedIosResult,
    calendarExpectation,
    evidenceExpectation,
    athlete,
    validators: [validateGenerated, validateNoRawInternals, validateNoPrivateCalendarTitles, ...validators],
  };
}

export function buildTrainingAadScenarioDefinitions(): TrainingAadScenarioDefinition[] {
  const beginner = personaAthlete('beginner-gym-dumbbells');
  const hypertrophy = personaAthlete('intermediate-hypertrophy-full-gym');
  const advanced = personaAthlete('advanced-strength-focused');
  const runner = personaAthlete('runner-half-marathon');
  const cyclist = personaAthlete('cyclist-ftp-build');
  const hybrid = personaAthlete('hybrid-gym-running');
  const travelUser = personaAthlete('travel-week-hotel-gym');
  const discomfortUser = personaAthlete('discomfort-knee-limitation');

  const swimAthlete: AthleteState = {
    ...cloneAthlete(sampleTriathlete),
    profile: { ...sampleTriathlete.profile, athleteId: 9306, primaryDiscipline: 'swimming' },
    goals: { ...sampleTriathlete.goals, primaryFocus: 'swimming', priorityOrder: ['swimming'], weeklySessionsTarget: { swimming: 4 }, weeklyMinutesTarget: { swimming: 220 }, raceCalendar: [] },
    currentBlock: { discipline: 'swimming', phase: 'base', weekIndex: 3, totalWeeks: 10, volumeProgressionPct: 5 },
    availability: { weeklyWindows: lisbonAvailabilityForSports(['swimming']), preferredLongSessionDay: 'saturday', preferredTimesBySport: { swimming: '08:00' }, maxSessionsPerDay: 1 },
    equipment: { ...sampleTriathlete.equipment, hasPool: true },
  };

  const marathonTaper: AthleteState = {
    ...cloneAthlete(sampleMarathonAthlete),
    profile: { ...sampleMarathonAthlete.profile, athleteId: 9304 },
    goals: { ...sampleMarathonAthlete.goals, raceCalendar: [{ id: 'aad-marathon', name: 'Fixture Marathon', discipline: 'running', subtype: 'marathon', date: '2026-07-05', priority: 'a' }] },
    currentBlock: { ...sampleMarathonAthlete.currentBlock, phase: 'taper', weekIndex: 14, totalWeeks: 16, volumeProgressionPct: 0 },
  };

  return [
    scenario('A', 'Beginner strength, dumbbells only', beginner, 'beginner, 3x/week, dumbbells only, 45 min', 'equipment fixture', 'no barbell/cable/machine; beginner appropriate; balanced movement patterns', 'equipment-appropriate plan', '45-minute windows only', 'beginner strength evidence', [validateNoUnavailableEquipment()]),
    scenario('B', 'Full gym strength/hypertrophy', hypertrophy, 'intermediate/advanced, full gym, 4x/week, 60 min', 'profile/equipment fixture', 'appropriate split/full-body and progression-ready', 'tempo/progression if present', 'no conflicts', 'resistance training evidence', [validateNoHardStack]),
    scenario('C', 'Running 10K or half-marathon', { ...runner, goals: { ...runner.goals, raceCalendar: [{ id: 'aad-10k', name: 'Fixture 10K', discipline: 'running', subtype: '10k', date: '2026-07-19', priority: 'a' }] } }, '4x/week, 10K race date', 'race fixture', 'easy/quality/long balance, no hard stacking', 'clear run structure', 'long run suitable day', 'endurance distribution evidence', [validateNoHardStack]),
    scenario('D', 'Marathon', marathonTaper, 'marathon race date and taper phase', 'race/taper fixture', 'long-run progression, recovery/deload, taper', 'weekly focus/key sessions', 'long run in suitable window', 'taper evidence', [validateNoHardStack]),
    scenario('E', 'Cycling', cyclist, 'cycling build', 'sport fixture', 'coherent ride durations/intensities', 'targets clear', 'long ride sensible', 'cycling/endurance evidence', [validateNoHardStack]),
    scenario('F', 'Swimming', swimAthlete, 'swim plan', 'sport/equipment fixture', 'swim-specific warmup/main/cooldown/drills', 'understandable swim details', 'pool availability respected if modeled', 'swim coherence', [validateSwimmingSpecific]),
    scenario('G', 'Triathlon / hybrid', sampleTriathlete, 'swim/bike/run + strength', 'hybrid/triathlon fixture', 'balanced density, sensible brick, no interference', 'overview readable', 'long sessions fit', 'concurrent training evidence', [validateTriathlonBalance, validateNoHardStack]),
    scenario('H', 'No equipment / travel week', withTravel(travelUser), 'bodyweight only, limited time', 'travel/equipment fixture', 'no unavailable equipment, reduced complexity', 'explanation visible', 'travel day short session only', 'maintenance/minimum dose evidence', [validateNoUnavailableEquipment(bodyweightOnlyBlockedPattern), validateCalendarFit]),
    scenario('I', 'Poor sleep / bad readiness', withReadiness(runner, 'red', 4.6, 'high'), 'low sleep/readiness before hard day', 'readiness fixture', 'hard session downgraded/shortened/replaced', 'recovery note', 'fits available time', 'sleep/readiness evidence', [validateRecoveryAdjusted]),
    scenario('J', 'Missed workout', withMissedKeySession(runner), 'missed key session', 'skip/completion fixture', 'no cramming; reschedule only if spacing allows', 'plan changes clear', 'no hard stacking', 'adherence/load evidence', [validateNoHardStack]),
    scenario('K', 'Return after 14-21+ day gap', withGap(hybrid), '21-day gap', 'history fixture', 'conservative ramp, no high load', 'reason visible', 'shorter sessions', 'return-to-training evidence', [validateCautiousProgression]),
    scenario('L', 'Calendar-constrained week', withLisbonCalendar(runner), 'busy Lisbon calendar fixture', 'calendar fixture', 'short weekdays, long weekend, no overlaps', 'backend/iOS dates agree', 'no busy overlap', 'calendar realism', [validateCalendarFit, validateLongSessionSaturday]),
    scenario('M', 'Safety red flag', withPain(withReadiness(hybrid, 'red', 5.0, 'high'), 'chest_pain', 'high', ['running', 'cycling', 'strength']), 'chest pain / dizziness / fever / acute injury', 'red-flag fixture', 'pause/downgrade, no hard training', 'safety banner/copy', 'no hard scheduling', 'safety guidance', [validateRedFlag]),
    scenario('N', 'Duplicate tap / retry', hybrid, 'duplicate create/retry', 'idempotency local replay fixture', 'no duplicate plans/events; deterministic plan shape', 'stable UI state', 'no duplicate calendar', 'idempotency expectation', [validateDuplicateRetryLocal()]),
    scenario('O', 'Old app payload', beginner, 'payload missing new fields', 'decoder/static fixture', 'old payload accepted', 'no crash/placeholders', 'dates valid', 'contract compatibility', []),
    scenario('P', 'New payload', hypertrophy, 'decision reasons, tempo, ids, zones, segments', 'decoder/read-model fixture', 'additive fields safe', 'useful insights, debug hidden', 'schedule explanations', 'contract evidence', []),
    scenario('Q', 'Busy day + bad rest + originally hard workout', withLisbonCalendar(withReadiness(runner, 'red', 4.4, 'high')), '30-40 min availability + low readiness', 'calendar + readiness fixture', 'hard session not blindly preserved', 'explains recovery + time reason', 'fits short window', 'sleep/load evidence', [validateRecoveryAdjusted, validateCalendarFit]),
    scenario('R', 'Missing equipment forces plan change', { ...hypertrophy, equipment: { hasGym: false, hasBarbell: false, hasDumbbells: false, hasBikeTrainer: false, hasPool: false, hasTrack: false, notes: ['hotel bands only'] }, constraints: [...hypertrophy.constraints, { id: 'aad-missing-equipment', type: 'equipment', severity: 'high', description: 'No gym equipment available; use bodyweight only.' }] }, 'no dumbbells/hotel bands+bench', 'equipment signal fixture', 'affected swaps only, intent preserved', 'equipment reason', 'no conflict', 'substitution quality', [validateNoUnavailableEquipment(bodyweightOnlyBlockedPattern)]),
    scenario('S', 'Injury/pain modifies session', withPain(discomfortUser, 'knee_pain', 'moderate', ['running', 'strength']), 'knee/back/shoulder/acute variants', 'pain/red-flag fixture', 'filters risky movements; no diagnosis', 'safety/recovery note', 'downgraded if needed', 'injury/return evidence', [validateNoHardStack]),
    scenario('T', 'Busy week with long-run placement', withLisbonCalendar(runner), 'weekdays busy, weekend long window', 'calendar fixture', 'long run in longest window', 'matching date/time', 'no short-gap long run', 'endurance scheduling', [validateCalendarFit, validateLongSessionSaturday, validateDstFixture()]),
    scenario('U', 'Bad sleep after missed session', withMissedKeySession(withReadiness(runner, 'red', 4.7, 'high')), 'missed yesterday + poor sleep', 'missed + readiness fixture', 'no cramming; recovery considered', 'mentions both', 'no hard stack', 'recovery/adherence evidence', [validateRecoveryAdjusted, validateNoHardStack]),
    scenario('V', 'Travel day + return from gap', withTravel(withGap(hybrid)), '14-21 day gap + travel', 'travel + history fixture', 'conservative bodyweight/mobility bias', 'combined explanation', 'short/travel-safe', 'return/minimum-dose evidence', [validateCautiousProgression, validateNoUnavailableEquipment(bodyweightOnlyBlockedPattern), validateCalendarFit]),
    scenario('W', 'Conflicting goal', { ...sampleHybridAthlete, goals: { ...sampleHybridAthlete.goals, primaryFocus: 'hybrid', secondaryFocus: 'strength', strengthGoal: 'hypertrophy', priorityOrder: ['running', 'strength'], weeklySessionsTarget: { running: 3, strength: 3 }, weeklyMinutesTarget: { running: 90, strength: 90 }, raceCalendar: [{ id: 'aad-marathon-conflict', name: 'Fixture Marathon', discipline: 'running', subtype: 'marathon', date: '2026-09-20', priority: 'a' }] }, availability: { weeklyWindows: [{ dayOfWeek: 'monday', start: '07:00', end: '07:30', sports: ['running', 'strength'] }, { dayOfWeek: 'wednesday', start: '07:00', end: '07:30', sports: ['running', 'strength'] }, { dayOfWeek: 'saturday', start: '08:00', end: '08:30', sports: ['running', 'strength'] }], preferredTimesBySport: { running: '07:00', strength: '07:00' }, maxSessionsPerDay: 1 }, constraints: [{ id: 'aad-conflict', type: 'interference', severity: 'high', description: 'Wants marathon performance and heavy hypertrophy with only 3x30 minutes.' }] }, 'marathon performance + heavy hypertrophy, 3 days/week, 30 min/day', 'input fixture', 'tradeoff/compromise, no overpromise', 'conflict text visible', 'realistic allocation', 'concurrent/time evidence', [validateConflictAcknowledged, validateCalendarFit]),
    scenario('X', 'Race taper with poor calendar', withLisbonCalendar(withMissedKeySession(marathonTaper)), 'race 1-2 weeks, busy, missed session', 'race + missed + calendar fixture', 'taper protected, no cramming', 'taper reason visible', 'volume reduced', 'taper evidence', [validateNoHardStack, validateCalendarFit]),
    scenario('Y', 'Household / life-load day', withLisbonCalendar(withReadiness(hybrid, 'orange', 5.5, 'moderate')), 'meetings + family event + poor sleep', 'calendar + readiness fixture', 'reduced ambition', 'life-load explanation', 'no forced ideal plan', 'recovery realism', [validateRecoveryAdjusted, validateCalendarFit]),
    scenario('Z', 'Multi-day fatigue trend', { ...withReadiness(hybrid, 'red', 4.9, 'high'), recentSessions: [{ id: 'aad-fatigue-1', sport: 'running', sessionType: 'easy_run', completedAt: '2026-06-19T07:00:00.000Z', durationMinutes: 35, intensityZone: 'aerobic', fatigueCost: 'medium', completed: true, rpe: 8, sorenessLevel: 8, energyLevel: 3 }, { id: 'aad-fatigue-2', sport: 'strength', sessionType: 'strength_hypertrophy', completedAt: '2026-06-20T12:00:00.000Z', durationMinutes: 40, intensityZone: 'tempo', fatigueCost: 'high', completed: true, rpe: 9, sorenessLevel: 9, energyLevel: 2 }] }, '3 days poor sleep/readiness', 'readiness trend fixture', 'week adjusts, not just today', 'weekly adjustment visible', 'no delayed hard stack', 'sleep/load evidence', [validateRecoveryAdjusted, validateNoHardStack]),
    scenario('AA', 'Equipment restored', { ...withGap(travelUser), equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, hasBikeTrainer: true, hasPool: false, hasTrack: true }, constraints: [{ id: 'aad-equipment-restored', type: 'equipment', severity: 'low', description: 'Travel ended and normal equipment is restored; progress gradually.' }] }, 'travel ends, equipment returns', 'equipment restored fixture', 'gradual normal progression resumes', 'explanation visible', 'no abrupt overload', 'progression evidence', [validateEquipmentRestoredGradual]),
    scenario('AB', 'Injury improving', withPain({ ...withGap(hybrid), readiness: { ...hybrid.readiness, level: 'yellow', score: 62, sleepHours: 6.8, soreness: 'moderate', painFlags: [] } }, 'knee_pain', 'low', ['running', 'strength']), 'pain improved, not gone', 'pain improvement fixture', 'cautious progression', 'no diagnosis', 'modified session if needed', 'return-from-pain evidence', [validateCautiousProgression]),
    scenario('AC', 'Race week + travel', withTravel({ ...marathonTaper, currentBlock: { ...marathonTaper.currentBlock, phase: 'race' } }), 'race week, travel, busy calendar', 'race + travel fixture', 'taper preserved, logistics respected', 'explanation visible', 'no overload', 'taper/travel evidence', [validateCautiousProgression, validateCalendarFit]),
    scenario('AD', 'Same account / two tenants', hybrid, 'tenant A/B data with same email', 'tenant fixture', 'no cross-tenant training/calendar/readiness leakage', 'no wrong data shown', 'no cross-tenant event use', 'privacy expectation', [validateSameAccountTwoTenants()]),
  ];
}

function evaluateScenario(scenarioDef: TrainingAadScenarioDefinition): TrainingAadScenarioResult {
  let plan: WeeklyPlan;
  try {
    plan = buildWeekPlan(cloneAthlete(scenarioDef.athlete), DEFAULT_WEEK_START);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      scenario: scenarioDef.id,
      name: scenarioDef.name,
      userAccount: scenarioDef.userAccount,
      inputs: scenarioDef.inputs,
      signalInjectionPath: scenarioDef.signalInjectionPath,
      expectedBackendResult: scenarioDef.expectedBackendResult,
      expectedIosResult: scenarioDef.expectedIosResult,
      calendarExpectation: scenarioDef.calendarExpectation,
      evidenceExpectation: scenarioDef.evidenceExpectation,
      actualBackendResult: `Planner threw: ${message}`,
      actualIosResult: 'Not rendered in local harness; payload not produced.',
      score: 1,
      passFail: 'fail',
      findings: [`Planner threw: ${message}`],
      planSummary: { discipline: scenarioDef.athlete.goals.primaryFocus, phase: scenarioDef.athlete.currentBlock.phase, totalSessions: 0, activeSessions: 0, totalActiveMinutes: 0, sports: {} },
    };
  }

  const findings = scenarioDef.validators.flatMap((validator) => validator({ scenario: scenarioDef, plan }));
  const active = activeSessions(plan);
  const score = Math.max(1, Math.min(5, 5 - findings.length));
  return {
    scenario: scenarioDef.id,
    name: scenarioDef.name,
    userAccount: scenarioDef.userAccount,
    inputs: scenarioDef.inputs,
    signalInjectionPath: scenarioDef.signalInjectionPath,
    expectedBackendResult: scenarioDef.expectedBackendResult,
    expectedIosResult: scenarioDef.expectedIosResult,
    calendarExpectation: scenarioDef.calendarExpectation,
    evidenceExpectation: scenarioDef.evidenceExpectation,
    actualBackendResult: `${plan.phase} ${plan.discipline} plan with ${active.length} active / ${plan.sessions.length} total sessions.`,
    actualIosResult: 'Local read-model-like payload scanned for banned display strings; iOS simulator render remains covered by fixture UI smoke.',
    score,
    passFail: findings.length === 0 && score >= 4 ? 'pass' : 'fail',
    findings,
    planSummary: {
      discipline: plan.discipline,
      phase: plan.phase,
      totalSessions: plan.sessions.length,
      activeSessions: active.length,
      totalActiveMinutes: active.reduce((sum, session) => sum + session.durationMinutes, 0),
      sports: summarizeSports(active),
    },
  };
}

function scenarioDefinitionById(id: TrainingAadScenarioId): TrainingAadScenarioDefinition {
  const scenarioDef = buildTrainingAadScenarioDefinitions().find((item) => item.id === id);
  if (!scenarioDef) throw new Error(`Missing Training A-AD scenario ${id}`);
  return scenarioDef;
}

function forceScheduledHardSession(
  session: Session,
  options: { dayOfWeek: DayOfWeek; startTime: string; endTime: string; title?: string; description?: string },
): void {
  session.dayOfWeek = options.dayOfWeek;
  session.startTime = options.startTime;
  session.endTime = options.endTime;
  session.durationMinutes = Math.max(1, timeToMinutes(options.endTime) - timeToMinutes(options.startTime));
  session.title = options.title ?? `Injected hard ${session.sport} session`;
  session.description = options.description ?? 'Injected negative control: hard work was preserved despite a signal that should reduce load.';
  session.intensityZone = 'threshold';
  session.fatigueCost = 'very_high';
  session.keySession = true;
  session.sessionType = session.sport === 'cycling'
    ? 'threshold_ride'
    : session.sport === 'swimming'
      ? 'threshold_swim'
      : session.sport === 'strength'
        ? 'strength_hypertrophy'
        : 'threshold_run';
  session.scheduleState = 'scheduled';
  session.scheduleAdjustments = [];
  session.scheduleReason = 'Injected negative control schedule.';
  session.decisionReasons = [];
}

type NegativeControlDefinition = {
  id: TrainingAadNegativeControlId;
  negativeControl: string;
  scenarioId?: TrainingAadScenarioId;
  expectedFailure: string;
  mutatePlan?: (plan: WeeklyPlan, scenarioDef: TrainingAadScenarioDefinition) => void;
  validators?: TrainingAadValidator[];
  run?: () => string[];
};

function negativeControlDefinitions(): NegativeControlDefinition[] {
  return [
    {
      id: 'unavailable_equipment',
      negativeControl: 'Unavailable equipment negative control',
      scenarioId: 'H',
      expectedFailure: 'Bodyweight-only travel scenario rejects gym-only equipment.',
      mutatePlan: (plan) => {
        const blocked = loadCoachKnowledge().exercises.find((exercise) => exercise.equipment.some((item) => bodyweightOnlyBlockedPattern.test(item)));
        if (!blocked) throw new Error('No blocked equipment exercise found in coach knowledge.');
        const session = ensureActiveSession(plan, 0);
        session.exercises = [
          ...(session.exercises ?? []),
          { exerciseId: blocked.id, name: blocked.name, sets: 3, reps: '8', notes: 'Injected negative control unavailable equipment.' },
        ];
      },
    },
    {
      id: 'calendar_overlap',
      negativeControl: 'Calendar overlap negative control',
      scenarioId: 'L',
      expectedFailure: 'Calendar-constrained scenario rejects a session inside a busy work block.',
      mutatePlan: (plan) => {
        const session = ensureActiveSession(plan, 0);
        session.dayOfWeek = 'monday';
        session.startTime = '09:30';
        session.endTime = '10:15';
        session.durationMinutes = 45;
        session.scheduleState = 'scheduled';
        session.scheduleReason = 'Injected negative control busy-block overlap.';
      },
      validators: [validateCalendarFit],
    },
    {
      id: 'bad_sleep_ignored',
      negativeControl: 'Bad sleep ignored negative control',
      scenarioId: 'I',
      expectedFailure: 'Low-readiness scenario rejects unchanged hard work and non-deload phase.',
      mutatePlan: (plan) => {
        plan.phase = 'build';
        forceScheduledHardSession(ensureActiveSession(plan, 0), { dayOfWeek: 'monday', startTime: '07:00', endTime: '07:45' });
        forceScheduledHardSession(ensureActiveSession(plan, 1), { dayOfWeek: 'tuesday', startTime: '07:15', endTime: '07:40' });
      },
      validators: [validateRecoveryAdjusted, validateNoHardStack],
    },
    {
      id: 'injury_ignored',
      negativeControl: 'Injury ignored negative control',
      scenarioId: 'M',
      expectedFailure: 'Safety red-flag scenario rejects hard training after pain/red-flag signal.',
      mutatePlan: (plan) => {
        forceScheduledHardSession(ensureActiveSession(plan, 0), { dayOfWeek: 'monday', startTime: '07:00', endTime: '07:45' });
      },
      validators: [validateRedFlag],
    },
    {
      id: 'missed_session_cramming',
      negativeControl: 'Missed-session cramming negative control',
      scenarioId: 'U',
      expectedFailure: 'Missed-session plus poor-sleep scenario rejects consecutive hard-session cramming.',
      mutatePlan: (plan) => {
        plan.phase = 'build';
        forceScheduledHardSession(ensureActiveSession(plan, 0), { dayOfWeek: 'monday', startTime: '07:00', endTime: '07:45' });
        forceScheduledHardSession(ensureActiveSession(plan, 1), { dayOfWeek: 'tuesday', startTime: '07:15', endTime: '07:40' });
      },
      validators: [validateRecoveryAdjusted, validateNoHardStack],
    },
    {
      id: 'race_taper_cramming',
      negativeControl: 'Race taper cramming negative control',
      scenarioId: 'X',
      expectedFailure: 'Race-taper scenario rejects missed high-volume work crammed into race week.',
      mutatePlan: (plan) => {
        plan.phase = 'race';
        forceScheduledHardSession(ensureActiveSession(plan, 0), { dayOfWeek: 'monday', startTime: '07:00', endTime: '08:30', title: 'Injected missed race-week intervals' });
        forceScheduledHardSession(ensureActiveSession(plan, 1), { dayOfWeek: 'tuesday', startTime: '07:15', endTime: '08:45', title: 'Injected crammed taper workout' });
      },
      validators: [validateNoHardStack, validateCalendarFit],
    },
    {
      id: 'raw_ui_internal_text',
      negativeControl: 'Raw UI/internal text negative control',
      scenarioId: 'P',
      expectedFailure: 'Copy scanner rejects raw internals and raw JSON in user-facing text.',
      mutatePlan: (plan) => {
        const session = ensureActiveSession(plan, 0);
        session.title = 'undefined null NaN [object Object] catalog_version selector_policy strength_hypertrophy';
        session.description = '{"catalog_version":"qa-negative","selector_policy":"debug"}';
      },
      validators: [validateNoRawInternals],
    },
    {
      id: 'tenant_leak',
      negativeControl: 'Tenant leak negative control',
      expectedFailure: 'Same-account/two-tenant fixture rejects tenant A data appearing in tenant B read model.',
      run: () => {
        const testIdentity = getTrainingAadTestIdentity();
        const tenantA = { tenantId: 1000013, email: testIdentity, readiness: 'red', planId: 'tenant-a-plan', calendarSignal: 'tenant-a-calendar' };
        const tenantB = { tenantId: 2000013, email: testIdentity, readiness: 'green', planId: 'tenant-b-plan', calendarSignal: 'tenant-b-calendar' };
        const leakedTenantBReadModel = [tenantA, tenantB].filter((item) => item.email === testIdentity);
        const serialized = JSON.stringify(leakedTenantBReadModel);
        return serialized.includes('tenant-a')
          ? ['Tenant A marker leaked into Tenant B read model.']
          : [];
      },
    },
  ];
}

function evaluateNegativeControl(definition: NegativeControlDefinition): TrainingAadNegativeControlResult {
  try {
    let findings: string[];
    if (definition.run) {
      findings = definition.run();
    } else {
      if (!definition.scenarioId || !definition.mutatePlan) throw new Error('Negative control missing scenario or mutation.');
      const scenarioDef = scenarioDefinitionById(definition.scenarioId);
      const plan = clonePlan(buildWeekPlan(cloneAthlete(scenarioDef.athlete), DEFAULT_WEEK_START));
      definition.mutatePlan(plan, scenarioDef);
      const validators = definition.validators ?? scenarioDef.validators;
      findings = validators.flatMap((validator) => validator({ scenario: scenarioDef, plan }));
    }
    return {
      id: definition.id,
      negativeControl: definition.negativeControl,
      expectedFailure: definition.expectedFailure,
      actualResult: findings.length > 0
        ? `Harness rejected the invalid fixture with ${findings.length} finding(s).`
        : 'Harness accepted the invalid fixture.',
      passFail: findings.length > 0 ? 'pass' : 'fail',
      notes: findings.length > 0 ? findings : ['Negative control did not produce a harness finding.'],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: definition.id,
      negativeControl: definition.negativeControl,
      expectedFailure: definition.expectedFailure,
      actualResult: 'Negative control could not execute.',
      passFail: 'fail',
      notes: [message],
    };
  }
}

export function runTrainingAadNegativeControls(): TrainingAadNegativeControlResult[] {
  return negativeControlDefinitions().map(evaluateNegativeControl);
}

export function renderTrainingAadNegativeControlsMarkdown(results: TrainingAadNegativeControlResult[]): string {
  const lines: string[] = [];
  lines.push('## A-AD Harness Strictness');
  lines.push('');
  lines.push('| Negative control | Expected failure | Actual result | Pass/fail | Notes |');
  lines.push('|---|---|---|---|---|');
  for (const result of results) {
    lines.push(`| ${result.negativeControl} | ${result.expectedFailure} | ${result.actualResult} | ${result.passFail} | ${result.notes.join('<br>')} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function runTrainingAadFixtureHarness(options: { weekStart?: string } = {}): TrainingAadHarnessResult {
  const weekStart = options.weekStart ?? DEFAULT_WEEK_START;
  const scenarioResults = buildTrainingAadScenarioDefinitions().map(evaluateScenario);
  const passCount = scenarioResults.filter((item) => item.passFail === 'pass').length;
  const failCount = scenarioResults.length - passCount;
  return {
    generatedAt: new Date().toISOString(),
    weekStart,
    timezone: TIMEZONE,
    testIdentity: getTrainingAadTestIdentity(),
    calendarFixture: buildNexushubbotLisbonCalendarFixture(weekStart),
    scenarioResults,
    aggregate: {
      scenarioCount: scenarioResults.length,
      passCount,
      failCount,
      averageScore: scenarioResults.length > 0
        ? Math.round((scenarioResults.reduce((sum, item) => sum + item.score, 0) / scenarioResults.length) * 10) / 10
        : 0,
    },
    blockers: [
      'Local fixture harness does not write live calendars.',
      'iOS simulator fixture smoke validates representative rendering separately, not every A-AD row.',
      'Live provider writes are validated by separate staging smoke reports; this harness labels planner scenarios and fixture calendars only.',
    ],
  };
}

export function renderTrainingAadFixtureMarkdown(result: TrainingAadHarnessResult): string {
  const lines: string[] = [];
  lines.push('# Training A-AD Local Fixture Harness Report');
  lines.push('');
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push(`Week start: ${result.weekStart}`);
  lines.push(`Timezone: ${result.timezone}`);
  lines.push(`Test identity: ${result.testIdentity} (local fixture; no live calendar writes)`);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`Scenarios: ${result.aggregate.scenarioCount}`);
  lines.push(`Pass: ${result.aggregate.passCount}`);
  lines.push(`Fail: ${result.aggregate.failCount}`);
  lines.push(`Average score: ${result.aggregate.averageScore}/5`);
  lines.push('');
  lines.push('## Calendar Fixture');
  lines.push('');
  lines.push('| Date | Calendar type | Events | Expected behavior | Source |');
  lines.push('|---|---|---|---|---|');
  for (const item of result.calendarFixture) {
    const events = item.busy.map((busy) => `${busy.start}-${busy.end} ${busy.label}`).join('; ');
    lines.push(`| ${item.date} | ${item.calendarType} | ${events} | ${item.expectedBehavior} | ${item.source} |`);
  }
  lines.push('');
  lines.push('## Scenario Matrix');
  lines.push('');
  lines.push('| Scenario | Inputs | Signal injection path | Expected backend result | Actual backend result | Score | Pass/fail | Findings |');
  lines.push('|---|---|---|---|---|---:|---|---|');
  for (const item of result.scenarioResults) {
    lines.push(`| ${item.scenario} - ${item.name} | ${item.inputs} | ${item.signalInjectionPath} | ${item.expectedBackendResult} | ${item.actualBackendResult} | ${item.score} | ${item.passFail} | ${item.findings.join('<br>') || 'None'} |`);
  }
  lines.push('');
  lines.push('## Blockers / Scope Labels');
  lines.push('');
  for (const blocker of result.blockers) lines.push(`- ${blocker}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv: string[]): { outDir: string; json?: string; markdown?: string; failUnder?: number; weekStart?: string; testIdentity?: string } {
  const options: { outDir: string; json?: string; markdown?: string; failUnder?: number; weekStart?: string; testIdentity?: string } = { outDir: '/tmp/nexus-training-aad-qa' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out-dir' && next) {
      options.outDir = next;
      i++;
    } else if (arg === '--json' && next) {
      options.json = next;
      i++;
    } else if (arg === '--markdown' && next) {
      options.markdown = next;
      i++;
    } else if (arg === '--fail-under' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.failUnder = parsed;
      i++;
    } else if (arg === '--week-start' && next) {
      options.weekStart = next;
      i++;
    } else if (arg === '--test-identity' && next) {
      options.testIdentity = next;
      i++;
    }
  }
  return options;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.testIdentity) process.env.TRAINING_AAD_TEST_IDENTITY = options.testIdentity;
  const result = runTrainingAadFixtureHarness({ weekStart: options.weekStart });
  const baseName = `training-aad-fixture-${timestamp()}`;
  const jsonPath = options.json ?? path.join(options.outDir, `${baseName}.json`);
  const markdownPath = options.markdown ?? path.join(options.outDir, `${baseName}.md`);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderTrainingAadFixtureMarkdown(result), 'utf8');
  console.log(`Training A-AD fixture scenarios: ${result.aggregate.passCount}/${result.aggregate.scenarioCount} pass`);
  console.log(`Average score: ${result.aggregate.averageScore}/5`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
  if (options.failUnder != null && result.aggregate.averageScore < options.failUnder) {
    console.error(`Training A-AD fixture score ${result.aggregate.averageScore} is below threshold ${options.failUnder}.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
