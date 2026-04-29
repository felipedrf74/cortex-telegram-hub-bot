// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type { SecretaryAgendaItem, SecretarySchedulingIntent } from '../services/secretary-scheduling-arbitrator';
import type {
  SecretaryAgendaProviderAdapter,
  SecretaryProviderEventInput,
} from '../services/secretary-agenda-provider-sync';

type Provider = 'google' | 'outlook';
type OperationStatus = 'pass' | 'fail' | 'blocked' | 'cleanup_failed';

interface SmokeOperation {
  provider: Provider;
  operation: string;
  expected: string;
  actual: string;
  status: OperationStatus;
  agendaItemIds: string[];
  providerEventIds: string[];
  cleanupStatus: 'not_needed' | 'pending' | 'cleaned' | 'failed';
}

interface SmokeReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  userId: number | null;
  tenantId: string;
  providersRequested: Provider[];
  providersRun: Provider[];
  prerequisites: {
    ok: boolean;
    missing: string[];
    warnings: string[];
  };
  operations: SmokeOperation[];
  cleanupFailures: Array<{ provider: Provider; agendaItemId?: string; providerEventId?: string; error: string }>;
}

const TITLE_PREFIX = '[NEXUS SECRETARY STAGING]';
const DEFAULT_RESULTS_PATH = 'docs/calendar/secretary-calendar-staging-smoke-results.md';
const DEFAULT_TENANT_ID = 'secretary-calendar-staging-smoke';

function parseProviders(raw: string | undefined): Provider[] {
  const providers = (raw || 'google,outlook')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is Provider => item === 'google' || item === 'outlook');
  return [...new Set(providers)].length > 0 ? [...new Set(providers)] : ['google', 'outlook'];
}

function buildRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `secretary-calendar-smoke-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadEnvFile(): void {
  const envFile = process.env.SECRETARY_CALENDAR_STAGING_ENV_FILE;
  if (envFile) {
    dotenv.config({ path: envFile, override: false });
  }
}

function evaluatePrerequisites(env: NodeJS.ProcessEnv, providers: Provider[]): SmokeReport['prerequisites'] {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!(env.STAGING === 'true' || env.NODE_ENV === 'staging')) {
    missing.push('STAGING=true or NODE_ENV=staging');
  }
  if (env.NODE_ENV === 'production') {
    missing.push('NODE_ENV must not be production');
  }
  if (env.SECRETARY_CALENDAR_STAGING_SMOKE !== '1') {
    missing.push('SECRETARY_CALENDAR_STAGING_SMOKE=1');
  }
  if (env.SECRETARY_CALENDAR_STAGING_ALLOW_LIVE_WRITES !== '1') {
    missing.push('SECRETARY_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1');
  }
  const userId = Number(env.SECRETARY_CALENDAR_STAGING_USER_ID);
  if (!Number.isInteger(userId) || userId <= 0) {
    missing.push('SECRETARY_CALENDAR_STAGING_USER_ID=<staging user id>');
  }
  if (!env.DATABASE_PATH) {
    missing.push('DATABASE_PATH=<staging database path>');
  } else if (!/staging|stage|test/i.test(env.DATABASE_PATH) && env.SECRETARY_CALENDAR_STAGING_ALLOW_NON_STAGING_DB !== '1') {
    missing.push('DATABASE_PATH must look like a staging/test database or set SECRETARY_CALENDAR_STAGING_ALLOW_NON_STAGING_DB=1');
  }
  if (!env.OAUTH_ENCRYPTION_KEY) {
    missing.push('OAUTH_ENCRYPTION_KEY');
  }
  if (providers.includes('google') && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
    missing.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }
  if (providers.includes('outlook') && (!env.OUTLOOK_CLIENT_ID || !env.OUTLOOK_CLIENT_SECRET || !env.OUTLOOK_TENANT_ID)) {
    missing.push('OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, and OUTLOOK_TENANT_ID');
  }
  if (env.SECRETARY_CALENDAR_STAGING_ALLOW_NON_STAGING_DB === '1') {
    warnings.push('Non-staging-looking DATABASE_PATH allowed explicitly. Verify this is not production.');
  }
  return { ok: missing.length === 0, missing, warnings };
}

async function runSmoke(): Promise<SmokeReport> {
  loadEnvFile();
  const startedAt = new Date().toISOString();
  const providers = parseProviders(process.env.SECRETARY_CALENDAR_STAGING_PROVIDERS);
  const runId = process.env.SECRETARY_CALENDAR_STAGING_RUN_ID || buildRunId();
  const userId = Number(process.env.SECRETARY_CALENDAR_STAGING_USER_ID);
  const tenantId = process.env.SECRETARY_CALENDAR_STAGING_TENANT_ID || DEFAULT_TENANT_ID;
  const prerequisites = evaluatePrerequisites(process.env, providers);
  const operations: SmokeOperation[] = [];
  const cleanupFailures: SmokeReport['cleanupFailures'] = [];
  const providersRun: Provider[] = [];

  if (!prerequisites.ok) {
    for (const provider of providers) {
      operations.push({
        provider,
        operation: 'prerequisites',
        expected: 'Staging-only env, explicit live-write gate, OAuth secrets, and staging DB are available.',
        actual: `Blocked: ${prerequisites.missing.join(', ')}`,
        status: 'blocked',
        agendaItemIds: [],
        providerEventIds: [],
        cleanupStatus: 'not_needed',
      });
    }
    return { runId, startedAt, finishedAt: new Date().toISOString(), userId: Number.isFinite(userId) ? userId : null, tenantId, providersRequested: providers, providersRun, prerequisites, operations, cleanupFailures };
  }

  const { initDatabase, closeDatabase } = await import('../services/database');
  const { createUnifiedCalendarSecretaryProviderAdapter } = await import('../services/secretary-unified-calendar-provider-adapter');
  const { submitSecretarySchedulingIntent, cancelSecretaryAgendaItem, getSecretaryAgendaItemById } = await import('../services/secretary-scheduling-arbitrator');
  const { syncSecretaryAgendaItemToProvider } = await import('../services/secretary-agenda-provider-sync');
  const google = await import('../services/google-calendar');
  const outlook = await import('../services/outlook-calendar');

  initDatabase();
  try {
    for (const provider of providers) {
      const connected = provider === 'google'
        ? google.isGoogleCalendarConfigured(userId)
        : outlook.isOutlookCalendarConfigured(userId);
      if (!connected) {
        operations.push({
          provider,
          operation: 'provider_connection',
          expected: `${provider} OAuth tokens exist for the staging smoke user.`,
          actual: `${provider} is not connected for user ${userId}.`,
          status: 'blocked',
          agendaItemIds: [],
          providerEventIds: [],
          cleanupStatus: 'not_needed',
        });
        continue;
      }
      providersRun.push(provider);
      const adapter = createUnifiedCalendarSecretaryProviderAdapter(provider);
      const createdAgendaIds: string[] = [];
      try {
        await runProviderLifecycle({
          provider,
          adapter,
          runId,
          userId,
          tenantId,
          createdAgendaIds,
          operations,
          submitSecretarySchedulingIntent,
          cancelSecretaryAgendaItem,
          getSecretaryAgendaItemById,
          syncSecretaryAgendaItemToProvider,
        });
      } finally {
        await cleanupAgendaItems({
          provider,
          adapter,
          userId,
          tenantId,
          agendaItemIds: createdAgendaIds,
          cleanupFailures,
          cancelSecretaryAgendaItem,
          getSecretaryAgendaItemById,
          syncSecretaryAgendaItemToProvider,
        });
      }
    }
  } finally {
    closeDatabase();
  }

  return { runId, startedAt, finishedAt: new Date().toISOString(), userId, tenantId, providersRequested: providers, providersRun, prerequisites, operations, cleanupFailures };
}

async function runProviderLifecycle(input: {
  provider: Provider;
  adapter: SecretaryAgendaProviderAdapter;
  runId: string;
  userId: number;
  tenantId: string;
  createdAgendaIds: string[];
  operations: SmokeOperation[];
  submitSecretarySchedulingIntent: typeof import('../services/secretary-scheduling-arbitrator').submitSecretarySchedulingIntent;
  cancelSecretaryAgendaItem: typeof import('../services/secretary-scheduling-arbitrator').cancelSecretaryAgendaItem;
  getSecretaryAgendaItemById: typeof import('../services/secretary-scheduling-arbitrator').getSecretaryAgendaItemById;
  syncSecretaryAgendaItemToProvider: typeof import('../services/secretary-agenda-provider-sync').syncSecretaryAgendaItemToProvider;
}): Promise<void> {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 21 + (input.provider === 'outlook' ? 2 : 0));
  base.setUTCHours(input.provider === 'google' ? 9 : 12, 0, 0, 0);

  const first = input.submitSecretarySchedulingIntent(buildIntent(input, 'create', base, 45));
  input.createdAgendaIds.push(first.agendaItem.agendaItemId);
  await syncAndVerify(input, first.agendaItem.agendaItemId, 'create', 'Agenda item creates one provider event with read-back verification.');

  patchAgendaTiming(first.agendaItem.agendaItemId, new Date(base.getTime() + 30 * 60_000), 45, `${TITLE_PREFIX} ${input.runId} ${input.provider} moved`);
  await syncAndVerify(input, first.agendaItem.agendaItemId, 'update_move', 'Existing provider event updates/moves by exact event ID without duplication.');

  await syncAndVerify(input, first.agendaItem.agendaItemId, 'retry', 'Retry sync is idempotent and does not create a duplicate event.');

  const duplicate = await input.adapter.createEvent(toProviderInput(requireAgenda(input, first.agendaItem.agendaItemId)));
  await syncAndVerify(input, first.agendaItem.agendaItemId, 'stale_duplicate_cleanup', `Duplicate provider event ${duplicate.eventId} is cleaned up by exact event ID.`);

  const currentBeforeExternalDelete = requireAgenda(input, first.agendaItem.agendaItemId);
  if (currentBeforeExternalDelete.providerEventId) {
    await input.adapter.deleteEvent(currentBeforeExternalDelete.providerEventId, toProviderInput(currentBeforeExternalDelete));
    await syncAndVerify(input, first.agendaItem.agendaItemId, 'external_provider_deletion_repair', 'Externally deleted provider event is recreated and remapped.');
  }

  const replacement = input.submitSecretarySchedulingIntent(buildIntent(input, 'replace', new Date(base.getTime() + 2 * 60 * 60_000), 50, {
    intentId: first.agendaItem.sourceIntentId,
    title: `${TITLE_PREFIX} ${input.runId} ${input.provider} replacement`,
    sourceEntityId: first.agendaItem.sourceEntityId,
  }));
  input.createdAgendaIds.push(replacement.agendaItem.agendaItemId);
  await syncAndVerify(input, first.agendaItem.agendaItemId, 'regenerate_delete_superseded', 'Superseded agenda item deletes its old provider event precisely.');
  await syncAndVerify(input, replacement.agendaItem.agendaItemId, 'replace_create_new', 'Replacement agenda item creates its own provider event.');

  input.cancelSecretaryAgendaItem({
    agendaItemId: replacement.agendaItem.agendaItemId,
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    reason: 'staging smoke cancel',
  });
  await syncAndVerify(input, replacement.agendaItem.agendaItemId, 'cancel', 'Canceled agenda item deletes provider event by exact event ID.');
}

function buildIntent(input: {
  provider: Provider;
  runId: string;
  userId: number;
  tenantId: string;
}, label: string, start: Date, durationMinutes: number, overrides: Partial<SecretarySchedulingIntent> = {}): SecretarySchedulingIntent {
  return {
    intentId: `${input.runId}:${input.provider}:${label}`,
    sourceSkill: 'secretary',
    sourceAction: 'calendar_staging_smoke',
    sourceEntityId: `${input.provider}-${label}`,
    sourceEntityType: 'calendar_staging_smoke',
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    title: `${TITLE_PREFIX} ${input.runId} ${input.provider} ${label}`,
    requestedDurationMinutes: durationMinutes,
    preferredWindows: [{ start: start.toISOString(), end: new Date(start.getTime() + 2 * 60 * 60_000).toISOString(), label }],
    priority: 'high',
    flexibility: 'fixed',
    reason: 'Secretary calendar lifecycle staging smoke. Safe to delete.',
    ...overrides,
  };
}

async function syncAndVerify(input: {
  provider: Provider;
  adapter: SecretaryAgendaProviderAdapter;
  userId: number;
  tenantId: string;
  operations: SmokeOperation[];
  getSecretaryAgendaItemById: typeof import('../services/secretary-scheduling-arbitrator').getSecretaryAgendaItemById;
  syncSecretaryAgendaItemToProvider: typeof import('../services/secretary-agenda-provider-sync').syncSecretaryAgendaItemToProvider;
}, agendaItemId: string, operation: string, expected: string): Promise<void> {
  try {
    const before = requireAgenda(input, agendaItemId);
    const result = await input.syncSecretaryAgendaItemToProvider({ agendaItemId, ownerUserId: input.userId, tenantId: input.tenantId }, input.adapter);
    const after = requireAgenda(input, agendaItemId);
    const events = after.startAt && after.endAt && input.adapter.findEventsByAgendaItemId
      ? await input.adapter.findEventsByAgendaItemId(agendaItemId, toProviderInput(after))
      : [];
    const shouldBeDeleted = ['canceled', 'superseded', 'completed', 'unscheduled', 'deferred'].includes(after.lifecycleState);
    const pass = shouldBeDeleted
      ? events.length === 0 && ['deleted', 'skipped'].includes(result.action)
      : events.length === 1 && after.providerSyncState === 'synced';
    input.operations.push({
      provider: input.provider,
      operation,
      expected,
      actual: pass
        ? `syncAction=${result.action}; providerEventId=${result.providerEventId ?? after.providerEventId ?? 'none'}; readBackCount=${events.length}`
        : `syncAction=${result.action}; beforeState=${before.providerSyncState}; afterState=${after.providerSyncState}; lifecycle=${after.lifecycleState}; readBackCount=${events.length}; reason=${result.reasonCode}`,
      status: pass ? 'pass' : 'fail',
      agendaItemIds: [agendaItemId],
      providerEventIds: [...new Set([result.providerEventId, after.providerEventId, ...events.map((event) => event.eventId)].filter(Boolean) as string[])],
      cleanupStatus: shouldBeDeleted || pass ? 'cleaned' : 'pending',
    });
  } catch (error) {
    input.operations.push({
      provider: input.provider,
      operation,
      expected,
      actual: error instanceof Error ? error.message : String(error),
      status: 'fail',
      agendaItemIds: [agendaItemId],
      providerEventIds: [],
      cleanupStatus: 'pending',
    });
  }
}

async function cleanupAgendaItems(input: {
  provider: Provider;
  adapter: SecretaryAgendaProviderAdapter;
  userId: number;
  tenantId: string;
  agendaItemIds: string[];
  cleanupFailures: SmokeReport['cleanupFailures'];
  cancelSecretaryAgendaItem: typeof import('../services/secretary-scheduling-arbitrator').cancelSecretaryAgendaItem;
  getSecretaryAgendaItemById: typeof import('../services/secretary-scheduling-arbitrator').getSecretaryAgendaItemById;
  syncSecretaryAgendaItemToProvider: typeof import('../services/secretary-agenda-provider-sync').syncSecretaryAgendaItemToProvider;
}): Promise<void> {
  for (const agendaItemId of [...new Set(input.agendaItemIds)]) {
    try {
      const item = input.getSecretaryAgendaItemById({ agendaItemId, ownerUserId: input.userId, tenantId: input.tenantId });
      if (!item) continue;
      if (!['canceled', 'superseded', 'completed', 'unscheduled', 'deferred'].includes(item.lifecycleState)) {
        input.cancelSecretaryAgendaItem({ agendaItemId, ownerUserId: input.userId, tenantId: input.tenantId, reason: 'staging smoke cleanup' });
      }
      await input.syncSecretaryAgendaItemToProvider({ agendaItemId, ownerUserId: input.userId, tenantId: input.tenantId }, input.adapter);
      const latest = input.getSecretaryAgendaItemById({ agendaItemId, ownerUserId: input.userId, tenantId: input.tenantId });
      if (latest?.startAt && latest.endAt && input.adapter.findEventsByAgendaItemId) {
        const leftovers = await input.adapter.findEventsByAgendaItemId(agendaItemId, toProviderInput(latest));
        for (const event of leftovers) {
          await input.adapter.deleteEvent(event.eventId, toProviderInput(latest));
        }
      }
    } catch (error) {
      input.cleanupFailures.push({
        provider: input.provider,
        agendaItemId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function patchAgendaTiming(agendaItemId: string, start: Date, durationMinutes: number, title: string): void {
  const { getDb } = require('../services/database') as typeof import('../services/database');
  getDb().prepare(`
    UPDATE secretary_agenda_items
    SET start_at = ?,
        end_at = ?,
        title = ?,
        lifecycle_state = 'reflowed',
        provider_sync_state = 'not_synced',
        updated_at = ?
    WHERE agenda_item_id = ?
  `).run(
    start.toISOString(),
    new Date(start.getTime() + durationMinutes * 60_000).toISOString(),
    title,
    new Date().toISOString(),
    agendaItemId,
  );
}

function requireAgenda(input: {
  userId: number;
  tenantId: string;
  getSecretaryAgendaItemById: typeof import('../services/secretary-scheduling-arbitrator').getSecretaryAgendaItemById;
}, agendaItemId: string): SecretaryAgendaItem {
  const item = input.getSecretaryAgendaItemById({ agendaItemId, ownerUserId: input.userId, tenantId: input.tenantId });
  if (!item) throw new Error(`Agenda item ${agendaItemId} not found`);
  return item;
}

function toProviderInput(item: SecretaryAgendaItem): SecretaryProviderEventInput {
  if (!item.startAt || !item.endAt) {
    throw new Error(`Agenda item ${item.agendaItemId} has no scheduled time`);
  }
  return {
    agendaItemId: item.agendaItemId,
    sourceIntentId: item.sourceIntentId,
    sourceSkill: item.sourceSkill,
    sourceEntityId: item.sourceEntityId,
    sourceEntityType: item.sourceEntityType,
    ownerUserId: item.ownerUserId,
    tenantId: item.tenantId,
    version: item.version,
    title: item.title,
    startAt: item.startAt,
    endAt: item.endAt,
    durationMinutes: item.durationMinutes,
    lifecycleState: item.lifecycleState,
    decisionReasonCodes: item.decisionReasonCodes,
    sourceShapeHash: item.sourceShapeHash,
  };
}

function writeReport(report: SmokeReport, resultsPath: string): void {
  const lines: string[] = [];
  const passCount = report.operations.filter((operation) => operation.status === 'pass').length;
  const failCount = report.operations.filter((operation) => operation.status === 'fail' || operation.status === 'cleanup_failed').length;
  const blockedCount = report.operations.filter((operation) => operation.status === 'blocked').length;
  const verdict = failCount > 0 || report.cleanupFailures.length > 0
    ? 'FAIL'
    : blockedCount > 0 || report.providersRun.length < report.providersRequested.length
      ? 'PASS WITH CONDITIONS'
      : 'PASS';

  lines.push('# Secretary Calendar Staging Smoke Results');
  lines.push('');
  lines.push(`Date: ${report.finishedAt}`);
  lines.push('');
  lines.push(`Run ID: \`${report.runId}\``);
  lines.push('');
  lines.push(`Verdict: **${verdict}**`);
  lines.push('');
  lines.push(`User ID: \`${report.userId ?? 'missing'}\``);
  lines.push('');
  lines.push(`Tenant ID: \`${report.tenantId}\``);
  lines.push('');
  lines.push(`Providers requested: ${report.providersRequested.join(', ') || 'none'}`);
  lines.push('');
  lines.push(`Providers run: ${report.providersRun.join(', ') || 'none'}`);
  lines.push('');
  lines.push(`Operation summary: ${passCount} pass, ${failCount} fail, ${blockedCount} blocked.`);
  lines.push('');
  lines.push('## Prerequisites');
  lines.push('');
  lines.push(`Status: ${report.prerequisites.ok ? 'pass' : 'blocked'}`);
  lines.push('');
  lines.push(`Missing: ${report.prerequisites.missing.length > 0 ? report.prerequisites.missing.join(', ') : 'none'}`);
  lines.push('');
  lines.push(`Warnings: ${report.prerequisites.warnings.length > 0 ? report.prerequisites.warnings.join(', ') : 'none'}`);
  lines.push('');
  lines.push('## Operations');
  lines.push('');
  lines.push('| Provider | Operation | Expected | Actual | Status | Agenda items | Provider events | Cleanup |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const operation of report.operations) {
    lines.push(`| ${operation.provider} | ${operation.operation} | ${escapeMd(operation.expected)} | ${escapeMd(operation.actual)} | ${operation.status} | ${operation.agendaItemIds.map((id) => `\`${id}\``).join('<br>') || 'none'} | ${operation.providerEventIds.map((id) => `\`${id}\``).join('<br>') || 'none'} | ${operation.cleanupStatus} |`);
  }
  lines.push('');
  lines.push('## Cleanup');
  lines.push('');
  if (report.cleanupFailures.length === 0) {
    lines.push('Cleanup passed. No known staging provider events were left behind by this smoke run.');
  } else {
    lines.push('| Provider | Agenda item | Provider event | Error |');
    lines.push('| --- | --- | --- | --- |');
    for (const failure of report.cleanupFailures) {
      lines.push(`| ${failure.provider} | ${failure.agendaItemId ?? 'n/a'} | ${failure.providerEventId ?? 'n/a'} | ${escapeMd(failure.error)} |`);
    }
  }
  lines.push('');
  lines.push('## Safety Notes');
  lines.push('');
  lines.push('- This smoke requires `SECRETARY_CALENDAR_STAGING_SMOKE=1` and `SECRETARY_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`.');
  lines.push('- The harness rejects `NODE_ENV=production` and requires a staging/test-looking `DATABASE_PATH` unless an explicit non-staging override is set.');
  lines.push('- Provider cleanup uses exact provider event IDs and Secretary agenda markers only.');
  lines.push('- Test events are clearly titled with `[NEXUS SECRETARY STAGING]` and the run ID.');
  lines.push('');

  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, `${lines.join('\n')}\n`);
}

function escapeMd(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

if (require.main === module) {
  runSmoke()
    .then((report) => {
      const resultsPath = process.env.SECRETARY_CALENDAR_STAGING_RESULTS_PATH || DEFAULT_RESULTS_PATH;
      writeReport(report, resultsPath);
      const failures = report.operations.some((operation) => operation.status === 'fail' || operation.status === 'cleanup_failed') || report.cleanupFailures.length > 0;
      const blocked = report.operations.some((operation) => operation.status === 'blocked');
      process.stdout.write(`Secretary calendar staging smoke wrote ${resultsPath}\n`);
      process.stdout.write(`runId=${report.runId} providersRun=${report.providersRun.join(',') || 'none'} failures=${failures ? 'yes' : 'no'} blocked=${blocked ? 'yes' : 'no'}\n`);
      process.exitCode = failures ? 1 : 0;
    })
    .catch((error) => {
      process.stderr.write(`Secretary calendar staging smoke failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
