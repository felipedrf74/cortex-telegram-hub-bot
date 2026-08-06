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
  plannerNow: string;
  userId?: number;
  tenantId?: number;
  userEmail?: string | null;
  scenario: SmokeScenario;
  provider: CalendarSource;
  dryRun: boolean;
  prerequisites: SmokePrerequisiteReport;
  operations: SmokeOperationResult[];
  cleanupFailures: string[];
}

type SmokeScenario = 'hybrid_event' | 'strength_no_event';

interface SmokeOptions {
  userId?: number;
  tenantId?: number;
  userEmail?: string | null;
  scenario: SmokeScenario;
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
  cancelTrainingPlanForUser(userId: number, planId?: number, options?: { tenantId?: number | null }): Promise<any>;
  getActivePlans(userId: number, tenantId?: number): any[];
  getWeeksForPlan(planId: number): any[];
  getSessionsForWeek(weekId: number): any[];
  getEventsForSources(startDate: string, endDate: string, userId: number, sources: CalendarSource[]): Promise<UnifiedCalendarEvent[]>;
  syncSecretaryAgendaItemsToProvider(
    scope: { ownerUserId: number; tenantId: string | number; includeInactive?: boolean },
    adapter: any,
  ): Promise<any[]>;
  createUnifiedCalendarSecretaryProviderAdapter(source: CalendarSource): any;
  fingerprintTrainingPlanGenerationRequest(payload: Record<string, unknown>): string;
  claimTrainingPlanGenerationIdempotency(userId: number, tenantId: number, idempotencyKey: string | null, requestHash: string): any;
  completeTrainingPlanGenerationIdempotency(
    userId: number,
    tenantId: number,
    claim: any,
    responseData: Record<string, unknown>,
    statusCode: number,
  ): boolean;
  failTrainingPlanGenerationIdempotency(userId: number, tenantId: number, claim: any): boolean;
  /**
   * Phase 1B: provider calendar events are created by the background
   * calendar-sync chain, not inline in generation. The smoke drains that
   * chain (event router + dedicated worker) before asserting provider
   * events, mirroring what the scheduler crons do continuously in prod.
   */
  drainTrainingPlanCalendarSync(): Promise<void>;
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

export function parseSmokeScenario(raw: string | undefined): SmokeScenario {
  return raw?.trim().toLowerCase() === 'strength_no_event' ? 'strength_no_event' : 'hybrid_event';
}

export function validateSmokeNow(raw: string | undefined): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime())
    ? null
    : 'TRAINING_FULL_FLOW_STAGING_NOW must be an ISO-8601 date/time';
}

export function parseSmokeNow(raw: string | undefined, fallback = new Date()): Date {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return new Date(fallback);
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(fallback);
}

export function evaluateTrainingFullFlowSmokePrerequisites(
  env: NodeJS.ProcessEnv,
  provider: CalendarSource,
): SmokePrerequisiteReport {
  const missing: string[] = [];
  const warnings: string[] = [];
  const scenario = parseSmokeScenario(env.TRAINING_FULL_FLOW_STAGING_SCENARIO);

  const stagingMode = env.STAGING === 'true' || env.NODE_ENV === 'staging';
  if (!stagingMode) missing.push('STAGING=true or NODE_ENV=staging');
  if (env.NODE_ENV === 'production') missing.push('NODE_ENV must not be production');
  if (env.TRAINING_FULL_FLOW_STAGING_SMOKE !== '1') missing.push('TRAINING_FULL_FLOW_STAGING_SMOKE=1');
  if (env.TRAINING_FULL_FLOW_STAGING_ALLOW_LIVE_WRITES !== '1') missing.push('TRAINING_FULL_FLOW_STAGING_ALLOW_LIVE_WRITES=1');
  if (env.TRAINING_FULL_FLOW_STAGING_USER_IS_DEDICATED !== '1') {
    missing.push('TRAINING_FULL_FLOW_STAGING_USER_IS_DEDICATED=1');
  }
  const nowError = validateSmokeNow(env.TRAINING_FULL_FLOW_STAGING_NOW);
  if (nowError) missing.push(nowError);

  const userId = Number(env.TRAINING_FULL_FLOW_STAGING_USER_ID);
  const userEmail = String(env.TRAINING_FULL_FLOW_STAGING_USER_EMAIL || '').trim();
  if ((!Number.isInteger(userId) || userId <= 0) && !userEmail) {
    missing.push('TRAINING_FULL_FLOW_STAGING_USER_ID=<staging user id> or TRAINING_FULL_FLOW_STAGING_USER_EMAIL=<email>');
  }

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
  if (scenario === 'strength_no_event') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      missing.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for cross-provider duplicate read-back');
    }
    if (!env.OUTLOOK_CLIENT_ID || !env.OUTLOOK_CLIENT_SECRET) {
      missing.push('OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET for cross-provider duplicate read-back');
    }
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

  if (options.dryRun || !prerequisites.ok) {
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
  const resolvedUserId = options.userId ?? resolveSmokeUserIdByEmail(runtime.db(), options.userEmail ?? null);
  if (!resolvedUserId) {
    operations.push({
      operation: 'user_resolution',
      expected: 'Smoke user resolves from TRAINING_FULL_FLOW_STAGING_USER_ID or TRAINING_FULL_FLOW_STAGING_USER_EMAIL.',
      actual: `No user found for configured smoke identity.`,
      status: 'blocked',
      evidence: [
        `userId=${options.userId ?? 'missing'}`,
        `userEmail=${options.userEmail || 'missing'}`,
      ],
    });
    return finishReport(options, startedAt, prerequisites, operations, cleanupFailures);
  }
  const userId = resolvedUserId;
  const tenantId = options.tenantId ?? userId;
  options = { ...options, userId, tenantId };
  const otherProvider = options.provider === 'outlook' ? 'google' : 'outlook';
  let otherProviderConnected = false;
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
    otherProviderConnected = runtime.isConnected(userId, otherProvider);
    if (!otherProviderConnected) {
      operations.push({
        operation: 'cross_provider_connection',
        expected: `${otherProvider} OAuth tokens exist so the smoke can prove the non-selected provider stays empty.`,
        actual: `${otherProvider} is not connected for user ${userId}. Selected-provider writes will still run and clean up.`,
        status: 'blocked',
        evidence: [`userId=${userId}`, `provider=${otherProvider}`],
      });
    }

    profileBackup = backupProfiles(runtime.db(), userId);
    seedSmokeProfiles(runtime.db(), userId, options.scenario);

    await cleanupActivePlans(runtime, userId, tenantId, operations, 'pre_cleanup');

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
    const firstClaim = runtime.claimTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
    let generationResult: any = null;
    if (firstClaim.kind === 'claimed') {
      generationResult = await runtime.generateTrainingPlanForUser({
        userId,
        tenantId,
        ...generationRequest,
        generationIdempotencyLease: firstClaim,
      });
      if (generationResult.status === 'created') {
        runtime.completeTrainingPlanGenerationIdempotency(
          userId,
          tenantId,
          firstClaim,
          generationResult.data ?? generationResult,
          201,
        );
      } else {
        runtime.failTrainingPlanGenerationIdempotency(userId, tenantId, firstClaim);
      }
    }
    const secondClaim = runtime.claimTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);

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

    // Phase 1B: link provider events through the durable background chain
    // before asserting on them — generation itself no longer creates any.
    await runtime.drainTrainingPlanCalendarSync();

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

    pushPlanShapeAssert(operations, options.scenario, planShape, generationResult);

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

    const secretaryAdapter = runtime.createUnifiedCalendarSecretaryProviderAdapter(options.provider);
    const secretarySync = await runtime.syncSecretaryAgendaItemsToProvider(
      { ownerUserId: userId, tenantId, includeInactive: false },
      secretaryAdapter,
    );
    const planEventsAfterSecretarySync = await getPlanEventsWithRetry({
      deps: runtime,
      planWindow,
      userId,
      provider: options.provider,
      planId: createdPlanId,
      expectedCount: planShape.linkedSessionCount,
    });
    pushAssert(operations, {
      operation: 'secretary_sync_no_selected_provider_duplicates',
      expected: 'Secretary agenda provider sync sees Training-owned items as already mapped: selected provider remains one event per session.',
      checks: [
        ['selected provider event count unchanged', planEventsAfterSecretarySync.length === planEventsAfterSync.length],
        ['selected provider still has no duplicate session markers', hasNoDuplicateSessionMarkers(planEventsAfterSecretarySync)],
      ],
      evidence: [
        `secretaryResults=${secretarySync.length}`,
        `provider=${options.provider}`,
        `eventCountBefore=${planEventsAfterSync.length}`,
        `eventCountAfterSecretary=${planEventsAfterSecretarySync.length}`,
      ],
    });
    if (otherProviderConnected) {
      const otherProviderEvents = await getPlanEventsWithRetry({
        deps: runtime,
        planWindow,
        userId,
        provider: otherProvider,
        planId: createdPlanId,
        expectedCount: 0,
      });
      pushAssert(operations, {
        operation: 'secretary_sync_no_cross_provider_duplicates',
        expected: 'The non-selected provider has zero matching Training events for this plan.',
        checks: [
          ['other provider has no matching plan events', otherProviderEvents.length === 0],
        ],
        evidence: [
          `provider=${options.provider}`,
          `otherProvider=${otherProvider}`,
          `otherProviderEvents=${otherProviderEvents.length}`,
        ],
      });
    } else {
      operations.push({
        operation: 'secretary_sync_no_cross_provider_duplicates',
        expected: 'The non-selected provider has zero matching Training events for this plan.',
        actual: `Blocked: ${otherProvider} OAuth is not connected for read-back.`,
        status: 'blocked',
        evidence: [`provider=${options.provider}`, `otherProvider=${otherProvider}`],
      });
    }

    const cancellation = await runtime.cancelTrainingPlanForUser(userId, createdPlanId, { tenantId });
    const eventsAfterCancel = await runtime.getEventsForSources(
      planWindow.start,
      planWindow.end,
      userId,
      otherProviderConnected ? [options.provider, otherProvider] : [options.provider],
    );
    const remainingPlanEvents = eventsForPlan(eventsAfterCancel, createdPlanId);
    createdPlanId = null;
    pushAssert(operations, {
      operation: 'cancel_removes_provider_events',
      expected: 'Cancel removes active plan rows and every provider event owned by this generated plan.',
      checks: [
        ['cancel returned cancelled', cancellation.status === 'cancelled'],
        ['removed sessions', Number(cancellation.data?.removedSessions || 0) >= planShape.activeSessionCount],
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
        await deps.cancelTrainingPlanForUser(options.userId, createdPlanId, { tenantId: options.tenantId ?? options.userId });
      } catch (err) {
        cleanupFailures.push(`failed to cancel plan ${createdPlanId}: ${errorMessage(err)}`);
      }
    } else if (createdPlanId && options.userId && deps === null) {
      try {
        await (deps ?? loadRuntimeDeps()).cancelTrainingPlanForUser(options.userId, createdPlanId, { tenantId: options.tenantId ?? options.userId });
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
  if (options.scenario === 'strength_no_event') {
    return {
      objective: `Muscle Building strength-primary block (${options.runId})`,
      durationWeeks: 4,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 1,
      strengthSessionsPerWeek: 5,
      bikeSessionsPerWeek: null,
      swimSessionsPerWeek: null,
      startPolicy: 'today',
      longWorkoutDay: 'Saturday',
      notes: [
        `staging smoke run ${options.runId}`,
        'Advanced lifter profile: heavy full-gym load is acceptable.',
        'Include only short aerobic support runs around 40 minutes when recovery allows.',
      ].join(' '),
      goalMode: 'continuous',
      trainingPriority: 'strength',
      raceDate: null,
      twoADayPreference: 'auto',
      calendarSource: options.provider,
      plannerNow: options.now.toISOString(),
    };
  }

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
    plannerNow: options.now.toISOString(),
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

function seedSmokeProfiles(db: any, userId: number, scenario: SmokeScenario): void {
  const profiles: Record<ProfileType, Record<string, unknown>> = scenario === 'strength_no_event'
    ? {
      fitness: {
        experience_level: 'Advanced (3+ years)',
        weekly_frequency: '6+ days',
        training_goals: ['Hypertrophy', 'Strength', 'General fitness'],
        injuries: 'none',
        available_equipment: 'Full commercial gym',
        session_duration_minutes: '60',
      },
      'triathlon-running': {
        weekly_mileage_km: '20',
        longest_recent_run_km: '8',
        easy_pace_min_per_km: '5:45',
        target_race: 'No event scheduled',
        preferred_workouts: ['Easy aerobic support runs'],
        injury_history: 'none',
        weekly_availability_days: '2',
        session_duration_minutes: '40',
      },
      'triathlon-gym': {
        training_age: '5+ years',
        current_split: 'ABCDE hypertrophy split',
        primary_goal: 'Hypertrophy',
        squat_1rm_kg: '140',
        bench_1rm_kg: '100',
        deadlift_1rm_kg: '170',
        sessions_per_week: '5',
        equipment_access: 'Full commercial gym',
        session_duration_minutes: '60',
      },
    }
    : {
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

function resolveSmokeUserIdByEmail(db: any, email: string | null): number | null {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const row = db.prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1').get(normalized) as { id?: number } | undefined;
  const id = Number(row?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function cleanupActivePlans(
  deps: RuntimeDeps,
  userId: number,
  tenantId: number,
  operations: SmokeOperationResult[],
  operation: string,
): Promise<void> {
  const before = deps.getActivePlans(userId, tenantId).length;
  const result = before > 0 ? await deps.cancelTrainingPlanForUser(userId, undefined, { tenantId }) : null;
  const after = deps.getActivePlans(userId, tenantId).length;
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

function linkedProviderEventIdsForPlan(deps: RuntimeDeps, planId: number, provider: CalendarSource): Set<string> {
  const ids = new Set<string>();
  for (const week of deps.getWeeksForPlan(planId)) {
    for (const session of deps.getSessionsForWeek(week.id)) {
      if (String(session.calendar_source || '') === provider && session.calendar_event_id) {
        ids.add(String(session.calendar_event_id));
      }
    }
  }
  return ids;
}

function eventsForPlan(
  events: UnifiedCalendarEvent[],
  planId: number,
  linkedEventIds = new Set<string>(),
): UnifiedCalendarEvent[] {
  return events.filter((event) =>
    parseTrainingIdentityMarker(event.description)?.planId === planId
    || linkedEventIds.has(event.id)
  );
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
    const linkedEventIds = linkedProviderEventIdsForPlan(input.deps, input.planId, input.provider);
    const events = await input.deps.getEventsForSources(
      input.planWindow.start,
      input.planWindow.end,
      input.userId,
      [input.provider],
    );
    latest = eventsForPlan(events, input.planId, linkedEventIds);
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
    const key = marker
      ? `${marker.planId}:${marker.sessionId}:${marker.sessionIdentityKey}`
      : `event:${event.source}:${event.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function pushPlanShapeAssert(
  operations: SmokeOperationResult[],
  scenario: SmokeScenario,
  planShape: ReturnType<typeof snapshotPlanShape>,
  generationResult: any,
): void {
  if (scenario === 'strength_no_event') {
    pushAssert(operations, {
      operation: 'plan_shape_and_week_sync',
      expected: 'The generated no-event strength plan is strength-dominant, continuous, and links current-week and next-week sessions when real calendar capacity allows.',
      checks: [
        ['four weeks generated', planShape.weekCount === 4],
        ['week 1 has at least 3 gym sessions', (planShape.weekSummaries[0]?.gymCount ?? 0) >= 3],
        ['week 1 is strength-dominant', (planShape.weekSummaries[0]?.gymCount ?? 0) > (planShape.weekSummaries[0]?.runCount ?? 0)],
        ['week 1 has no more than 2 run sessions', (planShape.weekSummaries[0]?.runCount ?? 0) <= 2],
        ['week 2 has at least 4 gym sessions', (planShape.weekSummaries[1]?.gymCount ?? 0) >= 4],
        ['week 2 is strength-dominant', (planShape.weekSummaries[1]?.gymCount ?? 0) > (planShape.weekSummaries[1]?.runCount ?? 0)],
        ['week 2 has no more than 2 run sessions', (planShape.weekSummaries[1]?.runCount ?? 0) <= 2],
        ['week 1 has linked calendar sessions', (planShape.weekSummaries[0]?.linkedCount ?? 0) > 0],
        ['week 2 has linked calendar sessions', (planShape.weekSummaries[1]?.linkedCount ?? 0) > 0],
        ['response stayed continuous', generationResult?.data?.goalMode === 'continuous'],
        ['response has no race date', generationResult?.data?.raceDate == null],
      ],
      evidence: planShape.weekSummaries.map((week) =>
        `week${week.weekNumber}: active=${week.activeCount}, run=${week.runCount}, gym=${week.gymCount}, linked=${week.linkedCount}`
      ).concat([
        `goalMode=${generationResult?.data?.goalMode ?? 'none'}`,
        `raceDate=${generationResult?.data?.raceDate ?? 'none'}`,
      ]),
    });
    return;
  }

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
    plannerNow: options.now.toISOString(),
    userId: options.userId,
    tenantId: options.tenantId,
    userEmail: options.userEmail ?? null,
    scenario: options.scenario,
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
  lines.push(`- Planner clock: \`${report.plannerNow}\``);
  lines.push(`- Provider: \`${report.provider}\``);
  lines.push(`- Scenario: \`${report.scenario}\``);
  lines.push(`- Dry run: \`${report.dryRun}\``);
  lines.push(`- Staging user ID: \`${report.userId ?? 'not configured'}\``);
  lines.push(`- Staging user email: \`${report.userEmail ?? 'not configured'}\``);
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
    const cells = [
      operation.operation,
      operation.expected,
      operation.actual,
      operation.status,
    ].map(escapeMarkdownCell);
    cells.push(operation.evidence.map(formatMarkdownTableCodeSpan).join('<br>') || '-');
    lines.push(cells.join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  lines.push('## Cleanup Failures');
  lines.push('');
  if (report.cleanupFailures.length === 0) {
    lines.push('None.');
  } else {
    for (const failure of report.cleanupFailures) lines.push(`- ${escapeMarkdownCell(failure)}`);
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
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>');
}

function formatMarkdownTableCodeSpan(value: string): string {
  const normalized = String(value).replace(/\r\n?|\n/g, ' ');
  let content = '';
  // GFM consumes one immediately preceding backslash to protect a table pipe,
  // including inside code spans. Preserve every input backslash literally and
  // add only the structural backslash required for each pipe delimiter.
  for (const character of normalized) content += character === '|' ? '\\|' : character;
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(longestBacktickRun + 1);
  const needsPadding = content.startsWith('`')
    || content.endsWith('`')
    || (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content));
  const padding = needsPadding ? ' ' : '';
  return `${fence}${padding}${content}${padding}${fence}`;
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
      syncSecretaryAgendaItemsToProvider: require('../services/secretary-agenda-provider-sync').syncSecretaryAgendaItemsToProvider,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      createUnifiedCalendarSecretaryProviderAdapter: require('../services/secretary-unified-calendar-provider-adapter').createUnifiedCalendarSecretaryProviderAdapter,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fingerprintTrainingPlanGenerationRequest: require('../services/training-plan-generation-idempotency').fingerprintTrainingPlanGenerationRequest,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      claimTrainingPlanGenerationIdempotency: require('../services/training-plan-generation-idempotency').claimTrainingPlanGenerationIdempotency,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      completeTrainingPlanGenerationIdempotency: require('../services/training-plan-generation-idempotency').completeTrainingPlanGenerationIdempotency,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      failTrainingPlanGenerationIdempotency: require('../services/training-plan-generation-idempotency').failTrainingPlanGenerationIdempotency,
      drainTrainingPlanCalendarSync: async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        await require('../services/event-backbone-worker').runEventBackboneOnce({ lockOwner: 'training-full-flow-smoke' });
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        await require('../services/training-plan-calendar-sync-worker').runScheduledTrainingPlanCalendarSyncJobs({
          lockOwner: 'training-full-flow-smoke',
        });
      },
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
    syncSecretaryAgendaItemsToProvider: (...args) => loadAfterDatabaseInit().syncSecretaryAgendaItemsToProvider(...args),
    createUnifiedCalendarSecretaryProviderAdapter: (...args) => loadAfterDatabaseInit().createUnifiedCalendarSecretaryProviderAdapter(...args),
    fingerprintTrainingPlanGenerationRequest: (...args) => loadAfterDatabaseInit().fingerprintTrainingPlanGenerationRequest(...args),
    claimTrainingPlanGenerationIdempotency: (...args) => loadAfterDatabaseInit().claimTrainingPlanGenerationIdempotency(...args),
    completeTrainingPlanGenerationIdempotency: (...args) => loadAfterDatabaseInit().completeTrainingPlanGenerationIdempotency(...args),
    failTrainingPlanGenerationIdempotency: (...args) => loadAfterDatabaseInit().failTrainingPlanGenerationIdempotency(...args),
    drainTrainingPlanCalendarSync: (...args) => loadAfterDatabaseInit().drainTrainingPlanCalendarSync(...args),
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
  const scenario = parseSmokeScenario(process.env.TRAINING_FULL_FLOW_STAGING_SCENARIO);
  const userId = Number(process.env.TRAINING_FULL_FLOW_STAGING_USER_ID);
  const tenantId = Number(process.env.TRAINING_FULL_FLOW_STAGING_TENANT_ID || process.env.TRAINING_FULL_FLOW_STAGING_USER_ID);
  const userEmail = String(process.env.TRAINING_FULL_FLOW_STAGING_USER_EMAIL || '').trim() || null;
  const runId = process.env.TRAINING_FULL_FLOW_STAGING_RUN_ID || buildTrainingFullFlowSmokeRunId();
  const dryRun = process.argv.includes('--dry-run') || process.env.TRAINING_FULL_FLOW_STAGING_DRY_RUN === '1';
  const resultsPath = process.env.TRAINING_FULL_FLOW_STAGING_RESULTS_PATH || DEFAULT_RESULTS_PATH;
  const now = parseSmokeNow(process.env.TRAINING_FULL_FLOW_STAGING_NOW);

  const report = await runTrainingFullFlowStagingSmoke({
    userId: Number.isInteger(userId) && userId > 0 ? userId : undefined,
    tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : undefined,
    userEmail,
    scenario,
    provider,
    runId,
    dryRun,
    now,
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
