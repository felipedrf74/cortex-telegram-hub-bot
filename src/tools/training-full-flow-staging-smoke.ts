// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import type { CalendarSource, UnifiedCalendarEvent } from '../services/unified-calendar';
import { parseTrainingIdentityMarker, stripTrainingIdentityMarker } from '../services/training-session-identity';

const DEFAULT_RESULTS_PATH = 'docs/training/training-full-flow-staging-smoke-results.md';
const PROFILE_TYPES = ['fitness', 'triathlon-running', 'triathlon-gym'] as const;
const ACTIVE_SESSION_STATUSES = new Set(['pending', 'scheduled', 'reflowed', 'compressed', 'capped']);

type SmokeStatus = 'pass' | 'fail' | 'blocked';
type ProfileType = typeof PROFILE_TYPES[number];

interface SmokeOperationResult {
  operation: string;
  expected: string;
  actual: string;
  status: SmokeStatus;
  evidence: string[];
}

interface SmokePrerequisiteReport {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

interface SmokeReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  userId?: number;
  tenantId?: number;
  provider: CalendarSource;
  dryRun: boolean;
  prerequisites: SmokePrerequisiteReport;
  operations: SmokeOperationResult[];
  cleanupFailures: string[];
}

interface SmokeOptions {
  userId?: number;
  tenantId?: number;
  provider: CalendarSource;
  runId: string;
  dryRun: boolean;
  now: Date;
  env: NodeJS.ProcessEnv;
}

interface RuntimeDeps {
  initDatabase(): void;
  db(): any;
  isConnected(userId: number, provider: CalendarSource): boolean;
  generateTrainingPlanForUser(input: Record<string, unknown>): Promise<any>;
  syncTrainingPlanCalendar(userId: number, now: Date, provider: CalendarSource, tenantId: number): Promise<any>;
  cancelTrainingPlanForUser(userId: number, planId?: number): Promise<any>;
  getActivePlans(userId: number, tenantId?: number): any[];
  getWeeksForPlan(planId: number): any[];
  getSessionsForWeek(weekId: number): any[];
  getEventsForSources(startDate: string, endDate: string, userId: number, sources: CalendarSource[]): Promise<UnifiedCalendarEvent[]>;
  fingerprintTrainingPlanGenerationRequest(payload: Record<string, unknown>): string;
  claimTrainingPlanGenerationIdempotency(userId: number, idempotencyKey: string | null, requestHash: string): any;
  completeTrainingPlanGenerationIdempotency(
    userId: number,
    idempotencyKey: string | null,
    requestHash: string,
    responseData: Record<string, unknown>,
    statusCode: number,
  ): void;
  failTrainingPlanGenerationIdempotency(userId: number, idempotencyKey: string | null, requestHash: string): void;
}

type ProfileBackup = Record<ProfileType, { existed: boolean; data: string | null }>;

export function buildTrainingFullFlowSmokeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `training-full-flow-smoke-${stamp}-${random}`;
}

export function parseSmokeProvider(raw: string | undefined): CalendarSource {
  return raw?.trim().toLowerCase() === 'outlook' ? 'outlook' : 'google';
}

export function evaluateTrainingFullFlowSmokePrerequisites(
  env: NodeJS.ProcessEnv,
  provider: CalendarSource,
): SmokePrerequisiteReport {
  const missing: string[] = [];
  const warnings: string[] = [];

  const stagingMode = env.STAGING === 'true' || env.NODE_ENV === 'staging';
  if (!stagingMode) missing.push('STAGING=true or NODE_ENV=staging');
  if (env.NODE_ENV === 'production') missing.push('NODE_ENV must not be production');
  if (env.TRAINING_FULL_FLOW_STAGING_SMOKE !== '1') missing.push('TRAINING_FULL_FLOW_STAGING_SMOKE=1');
  if (env.TRAINING_FULL_FLOW_STAGING_ALLOW_LIVE_WRITES !== '1') missing.push('TRAINING_FULL_FLOW_STAGING_ALLOW_LIVE_WRITES=1');
  if (env.TRAINING_FULL_FLOW_STAGING_USER_IS_DEDICATED !== '1') {
    missing.push('TRAINING_FULL_FLOW_STAGING_USER_IS_DEDICATED=1');
  }

  const userId = Number(env.TRAINING_FULL_FLOW_STAGING_USER_ID);
  if (!Number.isInteger(userId) || userId <= 0) missing.push('TRAINING_FULL_FLOW_STAGING_USER_ID=<staging user id>');

  if (!env.OAUTH_ENCRYPTION_KEY) missing.push('OAUTH_ENCRYPTION_KEY');
  if (!env.DATABASE_PATH) {
    missing.push('DATABASE_PATH=<staging database path>');
  } else if (!/staging|stage|test/i.test(env.DATABASE_PATH) && env.TRAINING_FULL_FLOW_STAGING_ALLOW_NON_STAGING_DB !== '1') {
    missing.push('DATABASE_PATH must look like a staging/test database or set TRAINING_FULL_FLOW_STAGING_ALLOW_NON_STAGING_DB=1');
  }

  if (provider === 'google' && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
    missing.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }
  if (provider === 'outlook' && (!env.OUTLOOK_CLIENT_ID || !env.OUTLOOK_CLIENT_SECRET)) {
    missing.push('OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET');
  }
  if (env.TRAINING_FULL_FLOW_STAGING_ALLOW_NON_STAGING_DB === '1') {
    warnings.push('Non-staging-looking DATABASE_PATH allowed explicitly; verify this is not production.');
  }

  return { ok: missing.length === 0, missing, warnings };
}

export async function runTrainingFullFlowStagingSmoke(
  options: SmokeOptions,
  deps: RuntimeDeps | null = null,
): Promise<SmokeReport> {
  const startedAt = new Date().toISOString();
  const prerequisites = evaluateTrainingFullFlowSmokePrerequisites(options.env, options.provider);
  const operations: SmokeOperationResult[] = [];
  const cleanupFailures: string[] = [];

  if (options.dryRun || !prerequisites.ok || !options.userId) {
    operations.push({
      operation: options.dryRun ? 'dry_run' : 'prerequisites',
      expected: 'A staging-mode process, dedicated staging user, OAuth tokens, and explicit live-write guardrails are present.',
      actual: options.dryRun ? 'Blocked: dry run requested.' : `Blocked: ${prerequisites.missing.join(', ')}`,
      status: 'blocked',
      evidence: options.dryRun ? ['--dry-run is not full-flow proof'] : prerequisites.missing,
    });
    return finishReport(options, startedAt, prerequisites, operations, cleanupFailures);
  }

  const runtime = deps ?? loadRuntimeDeps();
  runtime.initDatabase();
  const userId = options.userId;
  const tenantId = options.tenantId ?? userId;
  let createdPlanId: number | null = null;
  let profileBackup: ProfileBackup | null = null;

  try {
    if (!runtime.isConnected(userId, options.provider)) {
      operations.push({
        operation: 'provider_connection',
        expected: `${options.provider} OAuth tokens exist for the staging smoke user.`,
        actual: `${options.provider} is not connected for user ${userId}.`,
        status: 'blocked',
        evidence: [`userId=${userId}`, `provider=${options.provider}`],
      });
      return finishReport(options, startedAt, prerequisites, operations, cleanupFailures);
    }

    profileBackup = backupProfiles(runtime.db(), userId);
    seedSmokeProfiles(runtime.db(), userId);

    await cleanupActivePlans(runtime, userId, operations, 'pre_cleanup');

    const generationRequest = buildGenerationRequest(options);
    const beforePreview = snapshotTrainingState(runtime, userId, tenantId);
    const previewOne = await runtime.generateTrainingPlanForUser({ userId, tenantId, ...generationRequest, previewOnly: true });
    const previewTwo = await runtime.generateTrainingPlanForUser({ userId, tenantId, ...generationRequest, previewOnly: true });
    const afterPreview = snapshotTrainingState(runtime, userId, tenantId);

    pushAssert(operations, {
      operation: 'preview_non_mutating',
      expected: 'Two preview calls return preview payloads and create zero plan/week/session/calendar rows.',
      checks: [
        ['first preview returned preview', previewOne.status === 'preview'],
        ['second preview returned preview', previewTwo.status === 'preview'],
        ['active plan count unchanged', afterPreview.activePlanIds.length === beforePreview.activePlanIds.length],
        ['session count unchanged', afterPreview.sessionCount === beforePreview.sessionCount],
      ],
      evidence: [
        `previewOne=${previewOne.status}`,
        `previewTwo=${previewTwo.status}`,
        `beforePlans=${beforePreview.activePlanIds.length}`,
        `afterPlans=${afterPreview.activePlanIds.length}`,
        `beforeSessions=${beforePreview.sessionCount}`,
        `afterSessions=${afterPreview.sessionCount}`,
      ],
    });

    const requestHash = runtime.fingerprintTrainingPlanGenerationRequest(generationRequest);
    const idempotencyKey = `auto:${requestHash.slice(0, 48)}`;
    const firstClaim = runtime.claimTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);
    let generationResult: any = null;
    if (firstClaim.kind === 'claimed') {
      generationResult = await runtime.generateTrainingPlanForUser({ userId, tenantId, ...generationRequest });
      if (generationResult.status === 'created') {
        runtime.completeTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash, generationResult.data, 201);
      } else {
        runtime.failTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);
      }
    }
    const secondClaim = runtime.claimTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);

    createdPlanId = Number(generationResult?.planId || generationResult?.data?.planId || 0) || null;
    pushAssert(operations, {
      operation: 'generate_idempotent_double_tap',
      expected: 'Confirmed generation creates one plan, and an immediate second identical claim replays the first response.',
      checks: [
        ['first claim acquired', firstClaim.kind === 'claimed'],
        ['generation created a plan', generationResult?.status === 'created' && Boolean(createdPlanId)],
        ['second claim replays', secondClaim.kind === 'replay'],
        ['replay returns same plan id', Number(secondClaim.responseData?.planId) === createdPlanId],
      ],
      evidence: [
        `firstClaim=${firstClaim.kind}`,
        `secondClaim=${secondClaim.kind}`,
        `planId=${createdPlanId ?? 'none'}`,
        `totalSessions=${generationResult?.totalSessions ?? 'n/a'}`,
        `eventsCreated=${generationResult?.eventsCreated ?? 'n/a'}`,
      ],
    });

    if (!createdPlanId) {
      return finishReport(options, startedAt, prerequisites, operations, cleanupFailures);
    }

    const planWindow = planWindowFor(runtime, createdPlanId);
    const planShape = snapshotPlanShape(runtime, createdPlanId);
    const planEvents = await getPlanEventsWithRetry({
      deps: runtime,
      planWindow,
      userId,
      provider: options.provider,
      planId: createdPlanId,
      expectedCount: planShape.linkedSessionCount,
    });

    pushAssert(operations, {
      operation: 'plan_shape_and_week_sync',
      expected: 'The generated 4-week hybrid plan has 6 run + 5 gym sessions per week and week 1/week 2 are fully linked.',
      checks: [
        ['four weeks generated', planShape.weekCount === 4],
        ['44 active sessions generated', planShape.activeSessionCount === 44],
        ['week 1 has 6 run sessions', planShape.weekSummaries[0]?.runCount === 6],
        ['week 1 has 5 gym sessions', planShape.weekSummaries[0]?.gymCount === 5],
        ['week 2 has 6 run sessions', planShape.weekSummaries[1]?.runCount === 6],
        ['week 2 has 5 gym sessions', planShape.weekSummaries[1]?.gymCount === 5],
        ['week 1 sessions are linked', planShape.weekSummaries[0]?.linkedCount === 11],
        ['week 2 sessions are linked', planShape.weekSummaries[1]?.linkedCount === 11],
        ['long run stays on Saturday', planShape.longRunDays.every((day) => day === 'Saturday')],
      ],
      evidence: planShape.weekSummaries.map((week) =>
        `week${week.weekNumber}: active=${week.activeCount}, run=${week.runCount}, gym=${week.gymCount}, linked=${week.linkedCount}`
      ).concat([`longRunDays=${planShape.longRunDays.join(',') || 'none'}`]),
    });

    pushAssert(operations, {
      operation: 'provider_event_body_and_times',
      expected: 'Provider events use useful workout-body content first and exact 12:00 gym time when no conflict was marked.',
      checks: [
        ['all linked sessions have provider events', planEvents.length === planShape.linkedSessionCount],
        ['at least one event body starts with useful content', planEvents.some((event) => startsWithUsefulTrainingBody(event.description))],
        ['no event body starts with Nexus metadata', planEvents.every((event) => !String(event.description || '').trimStart().startsWith('NEXUS_'))],
        ['warmup/main/cool/tips are present in a body', planEvents.some((event) => hasUsefulWorkoutSections(event.description))],
        ['gym preferred time respected unless marked unavailable', gymTimesRespectPreference(planShape.sessions, planEvents, '12:00')],
      ],
      evidence: [
        `linkedSessions=${planShape.linkedSessionCount}`,
        `providerEvents=${planEvents.length}`,
        `sampleBodyStart=${sampleBodyStart(planEvents)}`,
        `gymTimeMismatches=${gymTimeMismatches(planShape.sessions, planEvents, '12:00').join(';') || 'none'}`,
      ],
    });

    const firstSync = await runtime.syncTrainingPlanCalendar(userId, options.now, options.provider, tenantId);
    const secondSync = await runtime.syncTrainingPlanCalendar(userId, options.now, options.provider, tenantId);
    const planEventsAfterSync = await getPlanEventsWithRetry({
      deps: runtime,
      planWindow,
      userId,
      provider: options.provider,
      planId: createdPlanId,
      expectedCount: planShape.linkedSessionCount,
    });
    pushAssert(operations, {
      operation: 'sync_idempotent_no_duplicates',
      expected: 'Two sync attempts verify/link existing sessions without creating duplicate provider events.',
      checks: [
        ['first sync did not fail', firstSync.status !== 'no_calendar'],
        ['second sync did not fail', secondSync.status !== 'no_calendar'],
        ['provider event count unchanged', planEventsAfterSync.length === planEvents.length],
        ['one provider event per session identity', hasNoDuplicateSessionMarkers(planEventsAfterSync)],
      ],
      evidence: [
        `firstSync=${firstSync.status}`,
        `firstSyncEventsCreated=${firstSync.data?.eventsCreated ?? 'n/a'}`,
        `firstSyncAlready=${firstSync.data?.sessionsAlreadySynced ?? 'n/a'}`,
        `secondSync=${secondSync.status}`,
        `eventCountBefore=${planEvents.length}`,
        `eventCountAfter=${planEventsAfterSync.length}`,
      ],
    });

    const cancellation = await runtime.cancelTrainingPlanForUser(userId, createdPlanId);
    const eventsAfterCancel = await runtime.getEventsForSources(planWindow.start, planWindow.end, userId, [options.provider]);
    const remainingPlanEvents = eventsForPlan(eventsAfterCancel, createdPlanId);
    createdPlanId = null;
    pushAssert(operations, {
      operation: 'cancel_removes_provider_events',
      expected: 'Cancel removes active plan rows and every provider event owned by this generated plan.',
      checks: [
        ['cancel returned cancelled', cancellation.status === 'cancelled'],
        ['removed sessions', Number(cancellation.data?.removedSessions || 0) >= 44],
        ['removed provider events', Number(cancellation.data?.removedEvents || 0) >= planEventsAfterSync.length],
        ['no plan events remain on provider', remainingPlanEvents.length === 0],
      ],
      evidence: [
        `cancelStatus=${cancellation.status}`,
        `removedSessions=${cancellation.data?.removedSessions ?? 'n/a'}`,
        `removedEvents=${cancellation.data?.removedEvents ?? 'n/a'}`,
        `remainingProviderEvents=${remainingPlanEvents.length}`,
      ],
    });
  } catch (err) {
    operations.push({
      operation: 'unexpected_error',
      expected: 'The full-flow smoke completes without uncaught errors.',
      actual: errorMessage(err),
      status: 'fail',
      evidence: [stackOrMessage(err)],
    });
  } finally {
    if (createdPlanId && options.userId && deps !== null) {
      try {
        await deps.cancelTrainingPlanForUser(options.userId, createdPlanId);
      } catch (err) {
        cleanupFailures.push(`failed to cancel plan ${createdPlanId}: ${errorMessage(err)}`);
      }
    } else if (createdPlanId && options.userId && deps === null) {
      try {
        await (deps ?? loadRuntimeDeps()).cancelTrainingPlanForUser(options.userId, createdPlanId);
      } catch (err) {
        cleanupFailures.push(`failed to cancel plan ${createdPlanId}: ${errorMessage(err)}`);
      }
    }
    if (profileBackup && options.userId) {
      try {
        const runtime = deps ?? loadRuntimeDeps();
        restoreProfiles(runtime.db(), options.userId, profileBackup);
      } catch (err) {
        cleanupFailures.push(`failed to restore profile rows: ${errorMessage(err)}`);
      }
    }
  }

  return finishReport(options, startedAt, prerequisites, operations, cleanupFailures);
}

function buildGenerationRequest(options: SmokeOptions): Record<string, unknown> {
  const raceDate = DateTime.fromJSDate(options.now, { zone: 'Europe/Lisbon' })
    .plus({ months: 5 })
    .toISODate() ?? '2026-10-18';
  return {
    objective: `Half marathon running base plus gym strength block (${options.runId})`,
    durationWeeks: 4,
    preferredTime: '12:00',
    preferredCardioTime: '07:00',
    preferredStrengthTime: '12:00',
    sessionsPerWeek: 6,
    runSessionsPerWeek: 6,
    strengthSessionsPerWeek: 5,
    bikeSessionsPerWeek: null,
    swimSessionsPerWeek: null,
    startPolicy: 'next_full_week',
    longWorkoutDay: 'Saturday',
    notes: [
      `staging smoke run ${options.runId}`,
      'Prefer double sessions over dropping runs when 6 run days and 5 gym days are requested.',
      'Keep gym sessions exactly at 12:00 unless the calendar has a real conflict.',
    ].join(' '),
    goalMode: 'event_based',
    trainingPriority: 'running',
    raceDate,
    twoADayPreference: 'preferred',
    calendarSource: options.provider,
  };
}

function backupProfiles(db: any, userId: number): ProfileBackup {
  const out = {} as ProfileBackup;
  for (const profileType of PROFILE_TYPES) {
    const row = db.prepare('SELECT data FROM user_profiles WHERE user_id = ? AND profile_type = ?')
      .get(userId, profileType) as { data?: string } | undefined;
    out[profileType] = { existed: Boolean(row), data: row?.data ?? null };
  }
  return out;
}

function seedSmokeProfiles(db: any, userId: number): void {
  const profiles: Record<ProfileType, Record<string, unknown>> = {
    fitness: {
      experience_level: 'Intermediate (1-3 years)',
      weekly_frequency: '6+ days',
      training_goals: ['Strength', 'Endurance', 'General fitness'],
      injuries: 'none',
      available_equipment: 'Full commercial gym',
    },
    'triathlon-running': {
      weekly_mileage_km: '45',
      longest_recent_run_km: '18',
      easy_pace_min_per_km: '5:45',
      target_race: 'Half marathon',
      target_race_date: DateTime.now().plus({ months: 5 }).toISODate(),
      preferred_workouts: ['Easy runs', 'Tempo', 'Intervals', 'Long runs'],
      injury_history: 'none',
      weekly_availability_days: '6+',
    },
    'triathlon-gym': {
      training_age: '3-5 years',
      current_split: 'Upper/Lower',
      primary_goal: 'Support other sports',
      squat_1rm_kg: '130',
      bench_1rm_kg: '90',
      deadlift_1rm_kg: '160',
      sessions_per_week: '5+',
      equipment_access: 'Full commercial gym',
    },
  };

  for (const [profileType, data] of Object.entries(profiles)) {
    db.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, profile_type) DO UPDATE SET
        data = excluded.data,
        updated_at = datetime('now')
    `).run(userId, profileType, JSON.stringify(data));
  }
}

function restoreProfiles(db: any, userId: number, backup: ProfileBackup): void {
  for (const profileType of PROFILE_TYPES) {
    const row = backup[profileType];
    if (row.existed) {
      db.prepare(`
        INSERT INTO user_profiles (user_id, profile_type, data)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, profile_type) DO UPDATE SET
          data = excluded.data,
          updated_at = datetime('now')
      `).run(userId, profileType, row.data ?? '{}');
    } else {
      db.prepare('DELETE FROM user_profiles WHERE user_id = ? AND profile_type = ?').run(userId, profileType);
    }
  }
}

async function cleanupActivePlans(
  deps: RuntimeDeps,
  userId: number,
  operations: SmokeOperationResult[],
  operation: string,
): Promise<void> {
  const before = deps.getActivePlans(userId, userId).length;
  const result = before > 0 ? await deps.cancelTrainingPlanForUser(userId) : null;
  const after = deps.getActivePlans(userId, userId).length;
  operations.push({
    operation,
    expected: 'Dedicated staging user starts from a clean active Training plan state.',
    actual: before > 0
      ? `Cancelled ${result?.data?.removedPlans ?? 0} active plan(s); after=${after}.`
      : 'No active plans needed cleanup.',
    status: after === 0 ? 'pass' : 'fail',
    evidence: [`before=${before}`, `after=${after}`, `cancelStatus=${result?.status ?? 'not_needed'}`],
  });
}

function snapshotTrainingState(deps: RuntimeDeps, userId: number, tenantId: number): {
  activePlanIds: number[];
  sessionCount: number;
} {
  const activePlans = deps.getActivePlans(userId, tenantId);
  let sessionCount = 0;
  for (const plan of activePlans) {
    for (const week of deps.getWeeksForPlan(plan.id)) {
      sessionCount += deps.getSessionsForWeek(week.id).length;
    }
  }
  return {
    activePlanIds: activePlans.map((plan) => plan.id),
    sessionCount,
  };
}

function snapshotPlanShape(deps: RuntimeDeps, planId: number): {
  weekCount: number;
  activeSessionCount: number;
  linkedSessionCount: number;
  longRunDays: string[];
  sessions: any[];
  weekSummaries: Array<{ weekNumber: number; activeCount: number; runCount: number; gymCount: number; linkedCount: number }>;
} {
  const weeks = deps.getWeeksForPlan(planId);
  const sessions: any[] = [];
  const weekSummaries = weeks.map((week) => {
    const weekSessions = deps.getSessionsForWeek(week.id).filter(isActiveTrainingSession);
    sessions.push(...weekSessions);
    return {
      weekNumber: Number(week.week_number || 0),
      activeCount: weekSessions.length,
      runCount: weekSessions.filter(isRunSession).length,
      gymCount: weekSessions.filter(isGymSession).length,
      linkedCount: weekSessions.filter((session) => Boolean(session.calendar_event_id)).length,
    };
  });
  return {
    weekCount: weeks.length,
    activeSessionCount: sessions.length,
    linkedSessionCount: sessions.filter((session) => Boolean(session.calendar_event_id)).length,
    longRunDays: sessions.filter(isLongRunSession).map((session) => String(session.day_of_week || '')),
    sessions,
    weekSummaries,
  };
}

function isActiveTrainingSession(session: any): boolean {
  return ACTIVE_SESSION_STATUSES.has(String(session.status || '').toLowerCase());
}

function isRunSession(session: any): boolean {
  const type = String(session.session_type || '').toLowerCase();
  return type === 'run' || type === 'long_run' || type.includes('run');
}

function isGymSession(session: any): boolean {
  const type = String(session.session_type || '').toLowerCase();
  return type === 'gym' || type === 'strength' || type.includes('strength');
}

function isLongRunSession(session: any): boolean {
  const type = String(session.session_type || '').toLowerCase();
  const title = String(session.title || '').toLowerCase();
  return type === 'long_run' || title.includes('long run');
}

function planWindowFor(deps: RuntimeDeps, planId: number): { start: string; end: string } {
  const plan = deps.db().prepare('SELECT start_date, end_date FROM fitness_training_plans WHERE id = ?').get(planId) as {
    start_date?: string;
    end_date?: string;
  } | undefined;
  const start = plan?.start_date || new Date().toISOString().slice(0, 10);
  const end = plan?.end_date
    ? DateTime.fromISO(plan.end_date).plus({ days: 1 }).toISODate() ?? plan.end_date
    : DateTime.fromISO(start).plus({ weeks: 4, days: 1 }).toISODate() ?? start;
  return { start, end };
}

function eventsForPlan(events: UnifiedCalendarEvent[], planId: number): UnifiedCalendarEvent[] {
  return events.filter((event) => parseTrainingIdentityMarker(event.description)?.planId === planId);
}

async function getPlanEventsWithRetry(input: {
  deps: RuntimeDeps;
  planWindow: { start: string; end: string };
  userId: number;
  provider: CalendarSource;
  planId: number;
  expectedCount: number;
}): Promise<UnifiedCalendarEvent[]> {
  let latest: UnifiedCalendarEvent[] = [];
  const attempts = Math.max(1, Number(process.env.TRAINING_FULL_FLOW_STAGING_READBACK_ATTEMPTS || 5));
  const delayMs = Math.max(0, Number(process.env.TRAINING_FULL_FLOW_STAGING_READBACK_DELAY_MS || 2_000));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const events = await input.deps.getEventsForSources(
      input.planWindow.start,
      input.planWindow.end,
      input.userId,
      [input.provider],
    );
    latest = eventsForPlan(events, input.planId);
    if (latest.length >= input.expectedCount) break;
    if (attempt < attempts) await sleep(delayMs);
  }
  return latest;
}

function startsWithUsefulTrainingBody(description: string | undefined): boolean {
  const clean = stripTrainingIdentityMarker(description).trimStart();
  if (!clean || /^NEXUS_/i.test(clean)) return false;
  const firstMetadata = clean.search(/NEXUS_/i);
  const firstUsefulSection = clean.search(/\b(WEEKLY PROGRESSION|WARM-UP|MAIN WORKOUT|EXECUTION|EXERCISES)\b/i);
  return firstUsefulSection >= 0
    && firstUsefulSection <= 600
    && (firstMetadata < 0 || firstUsefulSection < firstMetadata);
}

function hasUsefulWorkoutSections(description: string | undefined): boolean {
  const clean = stripTrainingIdentityMarker(description).toUpperCase();
  return clean.includes('WARM-UP')
    && clean.includes('MAIN WORKOUT')
    && clean.includes('COOL')
    && clean.includes('TIPS / RECOMMENDATIONS');
}

function sampleBodyStart(events: UnifiedCalendarEvent[]): string {
  const sample = events.find((event) => event.description) ?? events[0];
  return stripTrainingIdentityMarker(sample?.description).trim().slice(0, 160).replace(/\s+/g, ' ') || 'none';
}

function gymTimesRespectPreference(sessions: any[], events: UnifiedCalendarEvent[], preferredTime: string): boolean {
  return gymTimeMismatches(sessions, events, preferredTime).length === 0;
}

function gymTimeMismatches(sessions: any[], events: UnifiedCalendarEvent[], preferredTime: string): string[] {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const mismatches: string[] = [];
  for (const session of sessions.filter(isGymSession)) {
    const event = eventById.get(session.calendar_event_id);
    if (!event) continue;
    const localTime = DateTime.fromISO(event.start, { setZone: true }).setZone('Europe/Lisbon').toFormat('HH:mm');
    if (localTime !== preferredTime && Number(session.preferred_time_unavailable || 0) !== 1) {
      mismatches.push(`session=${session.id} time=${localTime}`);
    }
  }
  return mismatches;
}

function hasNoDuplicateSessionMarkers(events: UnifiedCalendarEvent[]): boolean {
  const seen = new Set<string>();
  for (const event of events) {
    const marker = parseTrainingIdentityMarker(event.description);
    const key = `${marker?.planId}:${marker?.sessionId}:${marker?.sessionIdentityKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushAssert(input: SmokeOperationResult[], args: {
  operation: string;
  expected: string;
  checks: Array<[string, boolean]>;
  evidence: string[];
}): void {
  const failed = args.checks.filter(([, ok]) => !ok).map(([name]) => name);
  input.push({
    operation: args.operation,
    expected: args.expected,
    actual: failed.length === 0 ? 'All checks passed.' : `Failed checks: ${failed.join(', ')}`,
    status: failed.length === 0 ? 'pass' : 'fail',
    evidence: args.evidence,
  });
}

function finishReport(
  options: SmokeOptions,
  startedAt: string,
  prerequisites: SmokePrerequisiteReport,
  operations: SmokeOperationResult[],
  cleanupFailures: string[],
): SmokeReport {
  return {
    runId: options.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    userId: options.userId,
    tenantId: options.tenantId,
    provider: options.provider,
    dryRun: options.dryRun,
    prerequisites,
    operations,
    cleanupFailures,
  };
}

export function renderTrainingFullFlowSmokeReportMarkdown(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push('# Training Full-Flow Staging Smoke Results');
  lines.push('');
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Started: \`${report.startedAt}\``);
  lines.push(`- Finished: \`${report.finishedAt}\``);
  lines.push(`- Provider: \`${report.provider}\``);
  lines.push(`- Dry run: \`${report.dryRun}\``);
  lines.push(`- Staging user ID: \`${report.userId ?? 'not configured'}\``);
  lines.push(`- Tenant ID: \`${report.tenantId ?? report.userId ?? 'not configured'}\``);
  lines.push('');
  lines.push('## Prerequisites');
  lines.push('');
  lines.push(`- Status: **${report.prerequisites.ok ? 'ready' : 'blocked'}**`);
  if (report.prerequisites.missing.length > 0) {
    lines.push(`- Missing: ${report.prerequisites.missing.map((item) => `\`${item}\``).join(', ')}`);
  }
  if (report.prerequisites.warnings.length > 0) {
    lines.push(`- Warnings: ${report.prerequisites.warnings.join(' ')}`);
  }
  lines.push('');
  lines.push('## Operations');
  lines.push('');
  lines.push('| Operation | Expected | Actual | Status | Evidence |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const operation of report.operations) {
    lines.push([
      operation.operation,
      operation.expected,
      operation.actual,
      operation.status,
      operation.evidence.map((item) => `\`${item}\``).join('<br>') || '-',
    ].map(escapeMarkdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  lines.push('## Cleanup Failures');
  lines.push('');
  if (report.cleanupFailures.length === 0) {
    lines.push('None.');
  } else {
    for (const failure of report.cleanupFailures) lines.push(`- ${failure}`);
  }
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');
  if (report.operations.some((operation) => operation.status === 'fail') || report.cleanupFailures.length > 0) {
    lines.push('Full-flow Training staging validation ran but at least one operation failed. Treat this as a release blocker until fixed and rerun.');
  } else if (report.operations.some((operation) => operation.status === 'blocked')) {
    lines.push('Full-flow Training staging validation is blocked. See the operation table for the exact provider/prerequisite gap.');
  } else {
    lines.push('The real Training plan flow passed against the requested staging calendar provider: preview stayed read-only, generation/sync were idempotent, event bodies were useful, and cancel cleaned provider events.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function escapeMarkdownCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function loadRuntimeDeps(): RuntimeDeps {
  // Lazy requires keep dotenv/env-file loading before config and provider modules initialize.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const database = require('../services/database') as typeof import('../services/database');
  let loaded: Omit<RuntimeDeps, 'initDatabase' | 'db'> | null = null;
  const loadAfterDatabaseInit = (): Omit<RuntimeDeps, 'initDatabase' | 'db'> => {
    if (loaded) return loaded;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const oauthStore = require('../services/oauth-store') as typeof import('../services/oauth-store');
    loaded = {
      isConnected: oauthStore.isConnected,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      generateTrainingPlanForUser: require('../api/routes/training-plan-generation').generateTrainingPlanForUser,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      syncTrainingPlanCalendar: require('../api/routes/training-plan-calendar-sync').syncTrainingPlanCalendar,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cancelTrainingPlanForUser: require('../api/routes/training-plan-cancellation').cancelTrainingPlanForUser,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getActivePlans: require('../services/training-plans').getActivePlans,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getWeeksForPlan: require('../services/training-plans').getWeeksForPlan,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getSessionsForWeek: require('../services/training-plans').getSessionsForWeek,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getEventsForSources: require('../services/unified-calendar').getEventsForSources,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fingerprintTrainingPlanGenerationRequest: require('../services/training-plan-generation-idempotency').fingerprintTrainingPlanGenerationRequest,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      claimTrainingPlanGenerationIdempotency: require('../services/training-plan-generation-idempotency').claimTrainingPlanGenerationIdempotency,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      completeTrainingPlanGenerationIdempotency: require('../services/training-plan-generation-idempotency').completeTrainingPlanGenerationIdempotency,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      failTrainingPlanGenerationIdempotency: require('../services/training-plan-generation-idempotency').failTrainingPlanGenerationIdempotency,
    };
    return loaded;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return {
    initDatabase: database.initDatabase,
    db: database.getDb,
    isConnected: (...args) => loadAfterDatabaseInit().isConnected(...args),
    generateTrainingPlanForUser: (...args) => loadAfterDatabaseInit().generateTrainingPlanForUser(...args),
    syncTrainingPlanCalendar: (...args) => loadAfterDatabaseInit().syncTrainingPlanCalendar(...args),
    cancelTrainingPlanForUser: (...args) => loadAfterDatabaseInit().cancelTrainingPlanForUser(...args),
    getActivePlans: (...args) => loadAfterDatabaseInit().getActivePlans(...args),
    getWeeksForPlan: (...args) => loadAfterDatabaseInit().getWeeksForPlan(...args),
    getSessionsForWeek: (...args) => loadAfterDatabaseInit().getSessionsForWeek(...args),
    getEventsForSources: (...args) => loadAfterDatabaseInit().getEventsForSources(...args),
    fingerprintTrainingPlanGenerationRequest: (...args) => loadAfterDatabaseInit().fingerprintTrainingPlanGenerationRequest(...args),
    claimTrainingPlanGenerationIdempotency: (...args) => loadAfterDatabaseInit().claimTrainingPlanGenerationIdempotency(...args),
    completeTrainingPlanGenerationIdempotency: (...args) => loadAfterDatabaseInit().completeTrainingPlanGenerationIdempotency(...args),
    failTrainingPlanGenerationIdempotency: (...args) => loadAfterDatabaseInit().failTrainingPlanGenerationIdempotency(...args),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stackOrMessage(err: unknown): string {
  return err instanceof Error ? (err.stack || err.message) : String(err);
}

async function main(): Promise<void> {
  const envFile = process.env.TRAINING_FULL_FLOW_STAGING_ENV_FILE;
  dotenv.config(envFile ? { path: envFile } : undefined);

  const provider = parseSmokeProvider(process.env.TRAINING_FULL_FLOW_STAGING_PROVIDER);
  const userId = Number(process.env.TRAINING_FULL_FLOW_STAGING_USER_ID);
  const tenantId = Number(process.env.TRAINING_FULL_FLOW_STAGING_TENANT_ID || process.env.TRAINING_FULL_FLOW_STAGING_USER_ID);
  const runId = process.env.TRAINING_FULL_FLOW_STAGING_RUN_ID || buildTrainingFullFlowSmokeRunId();
  const dryRun = process.argv.includes('--dry-run') || process.env.TRAINING_FULL_FLOW_STAGING_DRY_RUN === '1';
  const resultsPath = process.env.TRAINING_FULL_FLOW_STAGING_RESULTS_PATH || DEFAULT_RESULTS_PATH;

  const report = await runTrainingFullFlowStagingSmoke({
    userId: Number.isInteger(userId) && userId > 0 ? userId : undefined,
    tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : undefined,
    provider,
    runId,
    dryRun,
    now: new Date(),
    env: process.env,
  });

  const markdown = renderTrainingFullFlowSmokeReportMarkdown(report);
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, markdown);
  process.stdout.write(markdown);

  const failed = report.operations.some((operation) => operation.status === 'fail') || report.cleanupFailures.length > 0;
  const blocked = report.operations.some((operation) => operation.status === 'blocked');
  if (failed || blocked) {
    process.exitCode = blocked && !failed ? 2 : 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Training full-flow staging smoke failed: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
