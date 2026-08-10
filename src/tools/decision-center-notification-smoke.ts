// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import type {
  NotificationDeliveryObservabilityMetrics,
  NotificationEvaluationResult,
  NotificationIntentInput,
} from '../services/notification-orchestrator';

type SmokeMode = 'visible' | 'low-rank' | 'both';
type OperationStatus = 'pass' | 'fail' | 'blocked' | 'dry_run';

interface SmokePrerequisites {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

interface SmokeOperation {
  name: string;
  expected: string;
  actual: string;
  status: OperationStatus;
  intent?: Pick<NotificationIntentInput, 'sourceSkill' | 'type' | 'priority' | 'deliveryPolicy' | 'dedupeKey' | 'decisionDeadline'>;
  itemId?: string | null;
  decision?: string;
  decisionLogId?: string;
  deliveryAttempts?: Array<{ provider: string; status: string; errorCode: string | null }>;
  pushPayload?: { title: string; bodyLength: number; bodyHash: string; interruptionLevel?: string };
}

interface SmokeReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  userId: number | null;
  tenantId: number | null;
  mode: SmokeMode;
  prerequisites: SmokePrerequisites;
  operations: SmokeOperation[];
  observability?: NotificationDeliveryObservabilityMetrics;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(name: string, fallback?: number): number | undefined {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseMode(raw: string | undefined): SmokeMode {
  if (raw === 'visible' || raw === 'low-rank' || raw === 'both') return raw;
  if (raw === undefined) return 'both';
  throw new Error('--mode must be visible, low-rank, or both');
}

export function buildDecisionCenterNotificationSmokeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `decision-center-notification-smoke-${stamp}-${suffix}`;
}

export function evaluateDecisionCenterNotificationSmokePrerequisites(input: {
  env: NodeJS.ProcessEnv;
  userId?: number | null;
  tenantId?: number | null;
  dryRun: boolean;
  confirmed: boolean;
}): SmokePrerequisites {
  const missing: string[] = [];
  const warnings: string[] = [];
  const { env, userId, tenantId, dryRun, confirmed } = input;

  if (!Number.isInteger(userId) || Number(userId) <= 0) {
    missing.push('--user <id>');
  }
  if (!Number.isInteger(tenantId) || Number(tenantId) <= 0) {
    missing.push('--tenant <id> or tenant default from --user');
  }
  if (!dryRun && !confirmed) {
    missing.push('--confirm for non-dry-run smoke');
  }
  if (!dryRun && env.DECISION_CENTER_NOTIFICATION_SMOKE !== '1') {
    missing.push('DECISION_CENTER_NOTIFICATION_SMOKE=1');
  }
  if (!env.DATABASE_PATH) {
    missing.push('DATABASE_PATH');
  } else if (!/staging|stage|prod|production|nexus|bot/i.test(env.DATABASE_PATH)
      && env.DECISION_CENTER_NOTIFICATION_SMOKE_ALLOW_LOCAL_DB !== '1') {
    missing.push('DATABASE_PATH must look like a Nexus/staging/production DB or set DECISION_CENTER_NOTIFICATION_SMOKE_ALLOW_LOCAL_DB=1');
  }
  if (env.NOTIFICATION_DELIVERY_MODE !== 'apns') {
    warnings.push('NOTIFICATION_DELIVERY_MODE is not apns; visible smoke may use mock/local delivery instead of real APNs.');
  }
  if (env.APNS_ENABLED !== 'true') {
    warnings.push('APNS_ENABLED is not true; real APNs delivery cannot be proven.');
  }
  if (tenantId !== undefined && userId !== undefined && tenantId !== userId) {
    warnings.push('tenantId differs from userId; verify this is an intentional scoped tenant smoke.');
  }
  return { ok: missing.length === 0, missing, warnings };
}

export function buildDecisionCenterNotificationSmokeIntents(input: {
  userId: number;
  tenantId: number;
  runId: string;
  mode: SmokeMode;
  now?: Date;
}): NotificationIntentInput[] {
  const now = input.now ?? new Date();
  const currentStart = new Date(now.getTime() + 15 * 60_000).toISOString();
  const currentEnd = new Date(now.getTime() + 45 * 60_000).toISOString();
  const recommendedStart = new Date(now.getTime() + 60 * 60_000).toISOString();
  const recommendedEnd = new Date(now.getTime() + 90 * 60_000).toISOString();
  const deadline = new Date(now.getTime() + 30 * 60_000).toISOString();
  const intents: NotificationIntentInput[] = [];

  if (input.mode === 'visible' || input.mode === 'both') {
    intents.push({
      userId: input.userId,
      tenantId: input.tenantId,
      intentId: `ni_smoke_visible_${input.runId}`,
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      relatedEntityId: input.runId,
      relatedEntityType: 'secretary_agenda_item',
      title: '[SMOKE] Decision Center review',
      body: 'Decision Center smoke needs your review.',
      sensitiveBody: null,
      actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
      deeplink: `nexus://notifications/decision-center-smoke/${input.runId}`,
      dedupeKey: `smoke:decision-center:visible:${input.userId}:${input.runId}`,
      deliveryPolicy: 'auto',
      quietHoursPolicy: 'send_now',
      requiresUserAction: true,
      decisionDeadline: deadline,
      decisionContext: {
        entityTitle: '[SMOKE] Decision Center notification proof',
        currentStartAt: currentStart,
        currentEndAt: currentEnd,
        recommendedStartAt: recommendedStart,
        recommendedEndAt: recommendedEnd,
        candidateSlots: [{
          startAt: recommendedStart,
          endAt: recommendedEnd,
          label: '[SMOKE] Recommended recovery window',
          classification: 'recovery',
        }],
        reasonCodes: ['same_day_conflict'],
        sourceState: 'smoke_pending',
        deadlineAt: deadline,
        timezone: 'Europe/Lisbon',
        locale: 'en-US',
        visibilityScope: 'system_admin',
        internalOnly: true,
        smoke: true,
      },
      visibilityScope: 'system_admin',
      privacyPolicy: 'standard',
    });
  }

  if (input.mode === 'low-rank' || input.mode === 'both') {
    intents.push({
      userId: input.userId,
      tenantId: input.tenantId,
      intentId: `ni_smoke_low_rank_${input.runId}`,
      sourceSkill: 'system',
      type: 'insight',
      priority: 'passive',
      relatedEntityId: input.runId,
      relatedEntityType: 'decision_center_smoke',
      title: '[SMOKE] Low-rank Decision Center note',
      body: 'Low-rank smoke should remain in Nexus.',
      sensitiveBody: null,
      actionButtons: [{ id: 'open_detail', label: 'Open', style: 'secondary' }],
      deeplink: `nexus://notifications/decision-center-smoke/${input.runId}`,
      dedupeKey: `smoke:decision-center:low-rank:${input.userId}:${input.runId}`,
      deliveryPolicy: 'auto',
      quietHoursPolicy: 'respect',
      requiresUserAction: false,
      decisionDeadline: null,
      decisionContext: {
        entityTitle: '[SMOKE] Low-rank Decision Center note',
        sourceState: 'informational',
        visibilityScope: 'system_admin',
        internalOnly: true,
        smoke: true,
      },
      visibilityScope: 'system_admin',
      privacyPolicy: 'standard',
    });
  }

  return intents;
}

function operationFromDryRun(intent: NotificationIntentInput): SmokeOperation {
  return {
    name: intent.priority === 'passive' ? 'low-rank-in-app-gate' : 'visible-decision-push',
    expected: intent.priority === 'passive'
      ? 'Low-rank item remains in-app or digest only.'
      : 'Urgent scoped Decision Center item attempts a privacy-safe visible push.',
    actual: 'Dry run only; no database row or push attempt was created.',
    status: 'dry_run',
    intent: smokeIntentSummary(intent),
  };
}

function operationFromResult(result: NotificationEvaluationResult): SmokeOperation {
  const isLowRank = result.intent.priority === 'passive' || result.intent.type === 'insight';
  const deliveryAttempts = result.deliveryAttempts.map((attempt) => ({
    provider: attempt.provider,
    status: attempt.status,
    errorCode: attempt.errorCode,
  }));
  const visiblePassed = result.decisionLog.decision === 'sent_push'
    && deliveryAttempts.some((attempt) => attempt.status === 'sent');
  const lowRankPassed = result.decisionLog.decision === 'in_app_only'
    || result.decisionLog.decision === 'digest'
    || result.deliveryAttempts.length === 0;
  const blocked = result.decisionLog.decision === 'blocked_missing_device_token'
    || result.decisionLog.reason.includes('credentials missing')
    || deliveryAttempts.some((attempt) => attempt.status.startsWith('blocked_'));

  return {
    name: isLowRank ? 'low-rank-in-app-gate' : 'visible-decision-push',
    expected: isLowRank
      ? 'Low-rank item remains in-app or digest only.'
      : 'Urgent scoped Decision Center item attempts a privacy-safe visible push.',
    actual: `${result.decisionLog.decision}: ${result.decisionLog.reason}`,
    status: isLowRank
      ? (lowRankPassed ? 'pass' : 'fail')
      : (visiblePassed ? 'pass' : blocked ? 'blocked' : 'fail'),
    intent: smokeIntentSummary(result.intent),
    itemId: result.item?.itemId ?? null,
    decision: result.decisionLog.decision,
    decisionLogId: result.decisionLog.decisionLogId,
    deliveryAttempts,
    pushPayload: result.pushPayload ? summarizeSmokePushPayload(result.pushPayload) : undefined,
  };
}

export function summarizeSmokePushPayload(pushPayload: NonNullable<NotificationEvaluationResult['pushPayload']>): SmokeOperation['pushPayload'] {
  return {
    title: pushPayload.title.startsWith('[SMOKE]') ? pushPayload.title : '[redacted]',
    bodyLength: pushPayload.body.length,
    bodyHash: createHash('sha256').update(pushPayload.body).digest('hex').slice(0, 8),
    interruptionLevel: pushPayload.interruptionLevel,
  };
}

function smokeIntentSummary(intent: NotificationIntentInput): SmokeOperation['intent'] {
  return {
    sourceSkill: intent.sourceSkill,
    type: intent.type,
    priority: intent.priority,
    deliveryPolicy: intent.deliveryPolicy,
    dedupeKey: intent.dedupeKey,
    decisionDeadline: intent.decisionDeadline,
  };
}

function printHelp(): void {
  console.log(`
Decision Center notification smoke

Usage:
  node dist/tools/decision-center-notification-smoke.js --user <id> [--tenant <id>] [--mode visible|low-rank|both] [--json] --confirm
  node dist/tools/decision-center-notification-smoke.js --user <id> --dry-run --json

Environment:
  DECISION_CENTER_NOTIFICATION_SMOKE=1 is required for non-dry-run execution.
  DATABASE_PATH must point at the target engine database.
  NOTIFICATION_DELIVERY_MODE=apns and APNS_ENABLED=true are required to prove real APNs delivery.

The helper uses the normal Notification Orchestrator and Decision Center rank gates.
It never prints device tokens, APNs credentials, sensitive bodies, or explanation JSON.
`);
}

function loadEnv(): void {
  const envFile = argValue('--env-file') ?? process.env.DECISION_CENTER_NOTIFICATION_SMOKE_ENV_FILE ?? '.env';
  dotenv.config({ path: envFile, override: false });
}

async function runSmoke(): Promise<SmokeReport> {
  loadEnv();
  const startedAt = new Date().toISOString();
  const runId = argValue('--run-id') ?? buildDecisionCenterNotificationSmokeRunId();
  const userId = parsePositiveInt('--user');
  const tenantId = parsePositiveInt('--tenant', userId);
  const mode = parseMode(argValue('--mode'));
  const dryRun = hasFlag('--dry-run');
  const prerequisites = evaluateDecisionCenterNotificationSmokePrerequisites({
    env: process.env,
    userId,
    tenantId,
    dryRun,
    confirmed: hasFlag('--confirm'),
  });

  if (!prerequisites.ok || !userId || !tenantId) {
    return {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun,
      userId: userId ?? null,
      tenantId: tenantId ?? null,
      mode,
      prerequisites,
      operations: [],
    };
  }

  const intents = buildDecisionCenterNotificationSmokeIntents({ userId, tenantId, runId, mode });
  if (dryRun) {
    return {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun,
      userId,
      tenantId,
      mode,
      prerequisites,
      operations: intents.map(operationFromDryRun),
    };
  }

  const [{ initDatabase }, { closeDatabase }, notificationOrchestrator] = await Promise.all([
    import('../services/database-bootstrap'),
    import('../services/database'),
    import('../services/notification-orchestrator'),
  ]);

  initDatabase();
  try {
    const operations: SmokeOperation[] = [];
    for (const intent of intents) {
      const result = await notificationOrchestrator.createNotificationIntent(intent);
      operations.push(operationFromResult(result));
    }
    return {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun,
      userId,
      tenantId,
      mode,
      prerequisites,
      operations,
      observability: notificationOrchestrator.getNotificationDeliveryObservabilityMetrics(userId, tenantId),
    };
  } finally {
    closeDatabase();
  }
}

function printReport(report: SmokeReport): void {
  if (hasFlag('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Decision Center notification smoke: ${report.runId}`);
  console.log(`- userId: ${report.userId ?? 'missing'}`);
  console.log(`- tenantId: ${report.tenantId ?? 'missing'}`);
  console.log(`- mode: ${report.mode}`);
  console.log(`- dryRun: ${report.dryRun}`);
  if (!report.prerequisites.ok) {
    console.log(`- blocked: ${report.prerequisites.missing.join(', ')}`);
  }
  for (const warning of report.prerequisites.warnings) {
    console.log(`- warning: ${warning}`);
  }
  for (const op of report.operations) {
    console.log(`- ${op.name}: ${op.status} (${op.actual})`);
    if (op.itemId) console.log(`  itemId: ${op.itemId}`);
    if (op.decisionLogId) console.log(`  decisionLogId: ${op.decisionLogId}`);
  }
}

function exitCode(report: SmokeReport): number {
  if (!report.prerequisites.ok) return 2;
  if (report.dryRun) return 0;
  return report.operations.every((op) => op.status === 'pass') ? 0 : 2;
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }
  const report = await runSmoke();
  printReport(report);
  process.exit(exitCode(report));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`decision-center-notification-smoke fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
