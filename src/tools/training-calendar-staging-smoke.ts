// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type { CalendarSource, UnifiedCalendarEvent } from '../services/unified-calendar';
import { appendTrainingIdentityMarker } from '../services/training-session-identity';

const TITLE_PREFIX = '[NEXUS TRAINING STAGING]';
const DEFAULT_RESULTS_PATH = 'docs/training/calendar-staging-smoke-results.md';
const DEFAULT_WINDOW_OFFSET_DAYS = 14;

type SmokeProvider = CalendarSource;
type SmokeStatus = 'pass' | 'fail' | 'blocked' | 'cleanup_failed';

export interface SmokeOperationResult {
  provider: SmokeProvider;
  operation: string;
  expected: string;
  actual: string;
  status: SmokeStatus;
  eventIds: string[];
  cleanupStatus?: 'not_needed' | 'pending' | 'cleaned' | 'failed';
  error?: string;
}

export interface SmokeReport {
  runId: string;
  userId?: number;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  providersRequested: SmokeProvider[];
  providersRun: SmokeProvider[];
  prerequisites: SmokePrerequisiteReport;
  operations: SmokeOperationResult[];
  cleanupFailures: Array<{ provider: SmokeProvider; eventId: string; error: string }>;
}

export interface SmokePrerequisiteReport {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

export interface SmokeHarnessOptions {
  userId?: number;
  providers: SmokeProvider[];
  runId: string;
  dryRun: boolean;
  now: Date;
  env: NodeJS.ProcessEnv;
}

export interface SmokeCalendarClient {
  isConnected(userId: number, provider: SmokeProvider): boolean;
  createEvent(
    data: {
      title: string;
      start: string;
      end: string;
      description?: string;
    },
    target: SmokeProvider,
    userId: number,
  ): Promise<UnifiedCalendarEvent>;
  updateEvent(
    data: { event_id: string; new_start?: string; new_end?: string; new_title?: string },
    source: SmokeProvider,
    userId: number,
  ): Promise<UnifiedCalendarEvent>;
  deleteEvent(eventId: string, source: SmokeProvider, userId: number): Promise<void>;
  getEvents(startDate: string, endDate: string, userId: number): Promise<UnifiedCalendarEvent[]>;
}

interface SmokeEventSpec {
  provider: SmokeProvider;
  runId: string;
  planId: number;
  planVersion: number;
  sessionId: number;
  sessionIdentityKey: string;
  sessionShapeHash: string;
  label: string;
  start: Date;
  durationMinutes: number;
}

interface TrackedEvent {
  provider: SmokeProvider;
  id: string;
}

export function buildSmokeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `training-calendar-smoke-${stamp}-${random}`;
}

export function parseProviders(raw: string | undefined): SmokeProvider[] {
  const value = (raw || 'google,outlook').trim();
  const providers = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const unique = new Set<SmokeProvider>();
  for (const provider of providers) {
    if (provider === 'google' || provider === 'outlook') unique.add(provider);
  }
  return unique.size > 0 ? [...unique] : ['google', 'outlook'];
}

export function evaluateStagingSmokePrerequisites(
  env: NodeJS.ProcessEnv,
  providers: SmokeProvider[],
): SmokePrerequisiteReport {
  const missing: string[] = [];
  const warnings: string[] = [];

  const stagingMode = env.STAGING === 'true' || env.NODE_ENV === 'staging';
  if (!stagingMode) {
    missing.push('STAGING=true or NODE_ENV=staging');
  }

  if (env.NODE_ENV === 'production') {
    missing.push('NODE_ENV must not be production');
  }

  if (env.TRAINING_CALENDAR_STAGING_SMOKE !== '1') {
    missing.push('TRAINING_CALENDAR_STAGING_SMOKE=1');
  }

  if (env.TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES !== '1') {
    missing.push('TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1');
  }

  const userId = Number(env.TRAINING_CALENDAR_STAGING_USER_ID);
  if (!Number.isInteger(userId) || userId <= 0) {
    missing.push('TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>');
  }

  if (!env.OAUTH_ENCRYPTION_KEY) {
    missing.push('OAUTH_ENCRYPTION_KEY');
  }

  if (!env.DATABASE_PATH) {
    missing.push('DATABASE_PATH=<staging database path>');
  } else if (!/staging|stage|test/i.test(env.DATABASE_PATH) && env.TRAINING_CALENDAR_STAGING_ALLOW_NON_STAGING_DB !== '1') {
    missing.push('DATABASE_PATH must look like a staging/test database or set TRAINING_CALENDAR_STAGING_ALLOW_NON_STAGING_DB=1');
  }

  if (providers.includes('google') && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
    missing.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }

  if (providers.includes('outlook') && (!env.OUTLOOK_CLIENT_ID || !env.OUTLOOK_CLIENT_SECRET)) {
    missing.push('OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET');
  }

  if (env.TRAINING_CALENDAR_STAGING_ALLOW_NON_STAGING_DB === '1') {
    warnings.push('Non-staging-looking DATABASE_PATH allowed explicitly; verify this is not production.');
  }

  return { ok: missing.length === 0, missing, warnings };
}

export function buildSmokeEventPayload(spec: SmokeEventSpec): {
  title: string;
  start: string;
  end: string;
  description: string;
} {
  const end = new Date(spec.start.getTime() + spec.durationMinutes * 60_000);
  const description = [
    'Nexus Hub Training calendar lifecycle staging smoke.',
    `Run ID: ${spec.runId}`,
    `Provider: ${spec.provider}`,
    `Plan ID: ${spec.planId}`,
    `Plan version: ${spec.planVersion}`,
    `Session ID: ${spec.sessionId}`,
    `Session identity key: ${spec.sessionIdentityKey}`,
    `Session shape hash: ${spec.sessionShapeHash}`,
    'This is a staging/test event. It should be deleted by the smoke harness.',
  ].join('\n');

  return {
    title: `${TITLE_PREFIX} ${spec.runId} ${spec.label}`,
    start: spec.start.toISOString(),
    end: end.toISOString(),
    description: appendTrainingIdentityMarker(description, {
      planId: spec.planId,
      planVersion: spec.planVersion,
      sessionId: spec.sessionId,
      sessionIdentityKey: spec.sessionIdentityKey,
      sessionShapeHash: spec.sessionShapeHash,
    }),
  };
}

export function eventBelongsToSmokeRun(event: UnifiedCalendarEvent, runId: string): boolean {
  const title = String(event.summary || '');
  const description = String(event.description || '');
  return title.startsWith(`${TITLE_PREFIX} ${runId}`) || description.includes(`Run ID: ${runId}`);
}

export async function runTrainingCalendarStagingSmoke(
  options: SmokeHarnessOptions,
  client: SmokeCalendarClient,
): Promise<SmokeReport> {
  const startedAt = new Date().toISOString();
  const prerequisites = evaluateStagingSmokePrerequisites(options.env, options.providers);
  const operations: SmokeOperationResult[] = [];
  const cleanupFailures: Array<{ provider: SmokeProvider; eventId: string; error: string }> = [];
  const providersRun: SmokeProvider[] = [];
  const tracked: TrackedEvent[] = [];

  if (options.dryRun || !prerequisites.ok || !options.userId) {
    const blockedProviders = options.providers.length > 0 ? options.providers : ['google' as const];
    for (const provider of blockedProviders) {
      operations.push({
        provider,
        operation: options.dryRun ? 'dry_run' : 'prerequisites',
        expected: 'All staging credentials and explicit live-write guardrails are present.',
        actual: options.dryRun
          ? 'Blocked: dry run requested; no provider writes attempted.'
          : `Blocked: ${prerequisites.missing.join(', ')}`,
        status: 'blocked',
        eventIds: [],
        cleanupStatus: 'not_needed',
      });
    }
    return {
      runId: options.runId,
      userId: options.userId,
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: options.dryRun,
      providersRequested: options.providers,
      providersRun,
      prerequisites,
      operations,
      cleanupFailures,
    };
  }

  const windowStart = addDays(startOfDay(options.now), DEFAULT_WINDOW_OFFSET_DAYS);
  const windowEnd = addDays(windowStart, 2);

  try {
    for (const provider of options.providers) {
      if (!client.isConnected(options.userId, provider)) {
        operations.push({
          provider,
          operation: 'provider_connection',
          expected: `${provider} OAuth tokens exist for the staging smoke user.`,
          actual: `${provider} is not connected for user ${options.userId}.`,
          status: 'blocked',
          eventIds: [],
          cleanupStatus: 'not_needed',
        });
        continue;
      }
      providersRun.push(provider);
      await runProviderLifecycle({
        provider,
        options,
        client,
        windowStart,
        windowEnd,
        operations,
        tracked,
      });
    }
  } finally {
    await cleanupTrackedEvents({
      client,
      userId: options.userId,
      tracked,
      cleanupFailures,
      operations,
    });
  }

  return {
    runId: options.runId,
    userId: options.userId,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    providersRequested: options.providers,
    providersRun,
    prerequisites,
    operations,
    cleanupFailures,
  };
}

async function runProviderLifecycle(input: {
  provider: SmokeProvider;
  options: SmokeHarnessOptions & { userId?: number };
  client: SmokeCalendarClient;
  windowStart: Date;
  windowEnd: Date;
  operations: SmokeOperationResult[];
  tracked: TrackedEvent[];
}): Promise<void> {
  const { provider, options, client, windowStart, windowEnd, operations, tracked } = input;
  const userId = options.userId!;
  const planId = syntheticPlanId(options.runId, provider);
  const baseKey = `plan:${planId}|week:1|day:monday|type:gym|slot:1`;
  const baseStart = new Date(windowStart);
  baseStart.setHours(provider === 'google' ? 9 : 11, 0, 0, 0);

  const created = await createAndVerify({
    client,
    provider,
    userId,
    windowStart,
    windowEnd,
    operations,
    tracked,
    spec: {
      provider,
      runId: options.runId,
      planId,
      planVersion: 1,
      sessionId: syntheticSessionId(planId, 1),
      sessionIdentityKey: baseKey,
      sessionShapeHash: 'shape-strength-a-v1',
      label: 'create v1',
      start: baseStart,
      durationMinutes: 35,
    },
    operation: 'create_plan',
    expected: 'Training event is created and visible on read-back.',
  });
  if (!created) return;

  const updatedStart = new Date(baseStart.getTime() + 30 * 60_000);
  await updateAndVerify({
    client,
    provider,
    userId,
    eventId: created.id,
    runId: options.runId,
    windowStart,
    windowEnd,
    operations,
    title: `${TITLE_PREFIX} ${options.runId} update time`,
    start: updatedStart,
    durationMinutes: 35,
    operation: 'sync_update_time',
    expected: 'Existing event updates in place; no duplicate event appears.',
  });

  const sameShapeStart = new Date(baseStart.getTime() + 60 * 60_000);
  await updateAndVerify({
    client,
    provider,
    userId,
    eventId: created.id,
    runId: options.runId,
    windowStart,
    windowEnd,
    operations,
    title: `${TITLE_PREFIX} ${options.runId} regenerate same shape`,
    start: sameShapeStart,
    durationMinutes: 35,
    operation: 'regenerate_same_shape',
    expected: 'Same-shape regeneration reuses the event identity and updates time/title only.',
  });

  const changedShape = await createAndVerify({
    client,
    provider,
    userId,
    windowStart,
    windowEnd,
    operations,
    tracked,
    spec: {
      provider,
      runId: options.runId,
      planId,
      planVersion: 2,
      sessionId: syntheticSessionId(planId, 2),
      sessionIdentityKey: baseKey,
      sessionShapeHash: 'shape-strength-b-v2',
      label: 'regenerate changed shape',
      start: new Date(baseStart.getTime() + 90 * 60_000),
      durationMinutes: 45,
    },
    operation: 'regenerate_changed_shape_create_replacement',
    expected: 'Changed-shape regeneration creates the replacement event.',
  });
  if (changedShape) {
    await deleteAndVerify({
      client,
      provider,
      userId,
      eventId: created.id,
      runId: options.runId,
      windowStart,
      windowEnd,
      operations,
      tracked,
      operation: 'regenerate_changed_shape_delete_old',
      expected: 'Old shape event is precisely deleted after replacement.',
    });
  }

  await verifyNoDuplicateRunEvents({
    client,
    provider,
    userId,
    runId: options.runId,
    windowStart,
    windowEnd,
    operations,
    operation: 'retry_sync_no_duplicate',
    expected: 'Retry/read-back sees the single current replacement event, not duplicates.',
  });

  const replacementPlan = await createAndVerify({
    client,
    provider,
    userId,
    windowStart,
    windowEnd,
    operations,
    tracked,
    spec: {
      provider,
      runId: options.runId,
      planId: planId + 1,
      planVersion: 1,
      sessionId: syntheticSessionId(planId + 1, 1),
      sessionIdentityKey: `plan:${planId + 1}|week:1|day:tuesday|type:run|slot:1`,
      sessionShapeHash: 'shape-run-threshold-v1',
      label: 'replacement plan new',
      start: addDays(baseStart, 1),
      durationMinutes: 40,
    },
    operation: 'replace_plan_create_new',
    expected: 'Replacement plan creates its own event with distinct plan identity.',
  });

  if (changedShape) {
    await deleteAndVerify({
      client,
      provider,
      userId,
      eventId: changedShape.id,
      runId: options.runId,
      windowStart,
      windowEnd,
      operations,
      tracked,
      operation: 'cancel_plan_delete_current',
      expected: 'Cancel/delete removes the current plan event by exact event ID.',
    });
  }

  if (replacementPlan) {
    await deleteAndVerify({
      client,
      provider,
      userId,
      eventId: replacementPlan.id,
      runId: options.runId,
      windowStart,
      windowEnd,
      operations,
      tracked,
      operation: 'replace_plan_delete_old_scope',
      expected: 'Replacement cleanup removes only the event owned by this smoke plan.',
    });
  }
}

async function createAndVerify(input: {
  client: SmokeCalendarClient;
  provider: SmokeProvider;
  userId: number;
  windowStart: Date;
  windowEnd: Date;
  operations: SmokeOperationResult[];
  tracked: TrackedEvent[];
  spec: SmokeEventSpec;
  operation: string;
  expected: string;
}): Promise<UnifiedCalendarEvent | null> {
  const payload = buildSmokeEventPayload(input.spec);
  try {
    const event = await input.client.createEvent(payload, input.provider, input.userId);
    if (event.id) input.tracked.push({ provider: input.provider, id: event.id });
    const visible = await readBackById(input.client, input.userId, input.provider, event.id, input.windowStart, input.windowEnd);
    input.operations.push({
      provider: input.provider,
      operation: input.operation,
      expected: input.expected,
      actual: visible ? `Read-back found event ${event.id}.` : `Create returned ${event.id}, but read-back did not find it.`,
      status: visible ? 'pass' : 'fail',
      eventIds: event.id ? [event.id] : [],
      cleanupStatus: event.id ? 'pending' : 'not_needed',
    });
    return visible ? event : null;
  } catch (err) {
    input.operations.push(failedOperation(input.provider, input.operation, input.expected, err));
    return null;
  }
}

async function updateAndVerify(input: {
  client: SmokeCalendarClient;
  provider: SmokeProvider;
  userId: number;
  eventId: string;
  runId: string;
  windowStart: Date;
  windowEnd: Date;
  operations: SmokeOperationResult[];
  title: string;
  start: Date;
  durationMinutes: number;
  operation: string;
  expected: string;
}): Promise<void> {
  try {
    const end = new Date(input.start.getTime() + input.durationMinutes * 60_000);
    await input.client.updateEvent(
      {
        event_id: input.eventId,
        new_title: input.title,
        new_start: input.start.toISOString(),
        new_end: end.toISOString(),
      },
      input.provider,
      input.userId,
    );
    const visible = await readBackById(input.client, input.userId, input.provider, input.eventId, input.windowStart, input.windowEnd);
    const duplicates = await countSmokeRunEvents(input.client, input.userId, input.provider, input.runId, input.windowStart, input.windowEnd);
    input.operations.push({
      provider: input.provider,
      operation: input.operation,
      expected: input.expected,
      actual: visible && duplicates === 1
        ? `Event ${input.eventId} updated in place; run event count is 1.`
        : `visible=${Boolean(visible)} runEventCount=${duplicates}`,
      status: visible && duplicates === 1 ? 'pass' : 'fail',
      eventIds: [input.eventId],
      cleanupStatus: 'pending',
    });
  } catch (err) {
    input.operations.push(failedOperation(input.provider, input.operation, input.expected, err, [input.eventId]));
  }
}

async function deleteAndVerify(input: {
  client: SmokeCalendarClient;
  provider: SmokeProvider;
  userId: number;
  eventId: string;
  runId: string;
  windowStart: Date;
  windowEnd: Date;
  operations: SmokeOperationResult[];
  tracked: TrackedEvent[];
  operation: string;
  expected: string;
}): Promise<void> {
  try {
    await input.client.deleteEvent(input.eventId, input.provider, input.userId);
    removeTracked(input.tracked, input.provider, input.eventId);
    const visible = await readBackById(input.client, input.userId, input.provider, input.eventId, input.windowStart, input.windowEnd);
    input.operations.push({
      provider: input.provider,
      operation: input.operation,
      expected: input.expected,
      actual: visible ? `Event ${input.eventId} is still visible after delete.` : `Event ${input.eventId} was deleted and absent on read-back.`,
      status: visible ? 'fail' : 'pass',
      eventIds: [input.eventId],
      cleanupStatus: visible ? 'pending' : 'cleaned',
    });
  } catch (err) {
    input.operations.push(failedOperation(input.provider, input.operation, input.expected, err, [input.eventId]));
  }
}

async function verifyNoDuplicateRunEvents(input: {
  client: SmokeCalendarClient;
  provider: SmokeProvider;
  userId: number;
  runId: string;
  windowStart: Date;
  windowEnd: Date;
  operations: SmokeOperationResult[];
  operation: string;
  expected: string;
}): Promise<void> {
  try {
    const count = await countSmokeRunEvents(input.client, input.userId, input.provider, input.runId, input.windowStart, input.windowEnd);
    input.operations.push({
      provider: input.provider,
      operation: input.operation,
      expected: input.expected,
      actual: `Read-back found ${count} active event(s) for this provider/run.`,
      status: count === 1 ? 'pass' : 'fail',
      eventIds: [],
      cleanupStatus: 'not_needed',
    });
  } catch (err) {
    input.operations.push(failedOperation(input.provider, input.operation, input.expected, err));
  }
}

async function cleanupTrackedEvents(input: {
  client: SmokeCalendarClient;
  userId?: number;
  tracked: TrackedEvent[];
  cleanupFailures: Array<{ provider: SmokeProvider; eventId: string; error: string }>;
  operations: SmokeOperationResult[];
}): Promise<void> {
  if (!input.userId) return;
  const remaining = [...input.tracked];
  for (const event of remaining) {
    try {
      await input.client.deleteEvent(event.id, event.provider, input.userId);
      removeTracked(input.tracked, event.provider, event.id);
      markCleanup(input.operations, event.provider, event.id, 'cleaned');
    } catch (err) {
      const message = errorMessage(err);
      input.cleanupFailures.push({ provider: event.provider, eventId: event.id, error: message });
      markCleanup(input.operations, event.provider, event.id, 'failed');
    }
  }
}

async function readBackById(
  client: SmokeCalendarClient,
  userId: number,
  provider: SmokeProvider,
  eventId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<UnifiedCalendarEvent | null> {
  if (!eventId) return null;
  const events = await client.getEvents(windowStart.toISOString(), windowEnd.toISOString(), userId);
  return events.find((event) => event.source === provider && event.id === eventId) ?? null;
}

async function countSmokeRunEvents(
  client: SmokeCalendarClient,
  userId: number,
  provider: SmokeProvider,
  runId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const events = await client.getEvents(windowStart.toISOString(), windowEnd.toISOString(), userId);
  return events.filter((event) => event.source === provider && eventBelongsToSmokeRun(event, runId)).length;
}

function failedOperation(
  provider: SmokeProvider,
  operation: string,
  expected: string,
  err: unknown,
  eventIds: string[] = [],
): SmokeOperationResult {
  return {
    provider,
    operation,
    expected,
    actual: errorMessage(err),
    status: 'fail',
    eventIds,
    cleanupStatus: eventIds.length > 0 ? 'pending' : 'not_needed',
    error: errorMessage(err),
  };
}

function removeTracked(tracked: TrackedEvent[], provider: SmokeProvider, eventId: string): void {
  const index = tracked.findIndex((event) => event.provider === provider && event.id === eventId);
  if (index >= 0) tracked.splice(index, 1);
}

function markCleanup(
  operations: SmokeOperationResult[],
  provider: SmokeProvider,
  eventId: string,
  status: 'cleaned' | 'failed',
): void {
  for (const operation of operations) {
    if (operation.provider === provider && operation.eventIds.includes(eventId)) {
      operation.cleanupStatus = status;
    }
  }
}

function syntheticPlanId(runId: string, provider: SmokeProvider): number {
  const seed = `${runId}:${provider}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return 900_000 + Math.abs(hash % 50_000);
}

function syntheticSessionId(planId: number, ordinal: number): number {
  return planId * 10 + ordinal;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function renderSmokeReportMarkdown(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push('# Training Calendar Staging Smoke Results');
  lines.push('');
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Started: \`${report.startedAt}\``);
  lines.push(`- Finished: \`${report.finishedAt}\``);
  lines.push(`- Dry run: \`${report.dryRun}\``);
  lines.push(`- Staging user ID: \`${report.userId ?? 'not configured'}\``);
  lines.push(`- Providers requested: \`${report.providersRequested.join(', ') || 'none'}\``);
  lines.push(`- Providers run: \`${report.providersRun.join(', ') || 'none'}\``);
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
  lines.push('| Provider | Operation | Expected | Actual | Status | Event IDs | Cleanup |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const op of report.operations) {
    lines.push([
      op.provider,
      op.operation,
      op.expected,
      op.actual,
      op.status,
      op.eventIds.map((id) => `\`${id}\``).join('<br>') || '-',
      op.cleanupStatus ?? '-',
    ].map(escapeMarkdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  lines.push('## Cleanup Failures');
  lines.push('');
  if (report.cleanupFailures.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Provider | Event ID | Error |');
    lines.push('| --- | --- | --- |');
    for (const failure of report.cleanupFailures) {
      lines.push(`| ${failure.provider} | \`${failure.eventId}\` | ${escapeMarkdownCell(failure.error)} |`);
    }
  }
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');
  if (report.dryRun) {
    lines.push('Real calendar staging validation was **not** run because this was a dry run. No provider write/read-back/delete proof exists from this run.');
  } else if (!report.prerequisites.ok) {
    lines.push('Real calendar staging validation was **not** run because prerequisites are missing. Do not treat this report as provider lifecycle proof.');
  } else if (report.operations.some((operation) => operation.status === 'fail' || operation.status === 'cleanup_failed')) {
    lines.push('Calendar staging validation ran but at least one operation failed. Treat this as a release blocker until fixed and rerun.');
  } else if (report.operations.some((operation) => operation.status === 'blocked')) {
    lines.push('Calendar staging validation is partially blocked. See the operation table for the exact provider/prerequisite gap.');
  } else {
    lines.push('All requested provider lifecycle operations passed with read-back and cleanup proof.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function escapeMarkdownCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

async function main(): Promise<void> {
  const envFile = process.env.TRAINING_CALENDAR_STAGING_ENV_FILE;
  dotenv.config(envFile ? { path: envFile } : undefined);

  const providers = parseProviders(process.env.TRAINING_CALENDAR_STAGING_PROVIDERS);
  const userId = Number(process.env.TRAINING_CALENDAR_STAGING_USER_ID);
  const runId = process.env.TRAINING_CALENDAR_STAGING_RUN_ID || buildSmokeRunId();
  const dryRun = process.argv.includes('--dry-run') || process.env.TRAINING_CALENDAR_STAGING_DRY_RUN === '1';
  const resultsPath = process.env.TRAINING_CALENDAR_STAGING_RESULTS_PATH || DEFAULT_RESULTS_PATH;
  const normalizedUserId = Number.isInteger(userId) && userId > 0 ? userId : undefined;
  const prerequisites = evaluateStagingSmokePrerequisites(process.env, providers);
  const client = !dryRun && prerequisites.ok && normalizedUserId
    ? loadRuntimeCalendarClient()
    : unavailableCalendarClient();

  const report = await runTrainingCalendarStagingSmoke(
    {
      userId: normalizedUserId,
      providers,
      runId,
      dryRun,
      now: new Date(),
      env: process.env,
    },
    client,
  );

  const markdown = renderSmokeReportMarkdown(report);
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, markdown);
  process.stdout.write(markdown);

  const failed = report.operations.some((operation) => operation.status === 'fail' || operation.status === 'cleanup_failed');
  const blocked = report.operations.some((operation) => operation.status === 'blocked');
  if (failed || blocked || report.cleanupFailures.length > 0) {
    process.exitCode = blocked && !failed ? 2 : 1;
  }
}

function loadRuntimeCalendarClient(): SmokeCalendarClient {
  // Lazy requires keep dotenv/env-file loading before config and provider
  // modules initialize. This script is intentionally not imported by runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const database = require('../services/database') as typeof import('../services/database');
  database.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const unified = require('../services/unified-calendar') as typeof import('../services/unified-calendar');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oauthStore = require('../services/oauth-store') as typeof import('../services/oauth-store');
  return {
    isConnected(userId, provider) {
      return oauthStore.isConnected(userId, provider);
    },
    createEvent: unified.createEvent,
    updateEvent: unified.updateEvent,
    deleteEvent: unified.deleteEvent,
    getEvents: unified.getEvents,
  };
}

function unavailableCalendarClient(): SmokeCalendarClient {
  const fail = async () => {
    throw new Error('Calendar client not loaded because staging smoke prerequisites are not satisfied.');
  };
  return {
    isConnected: () => false,
    createEvent: fail,
    updateEvent: fail,
    deleteEvent: fail,
    getEvents: fail,
  };
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Training calendar staging smoke failed: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
