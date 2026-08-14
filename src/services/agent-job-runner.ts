// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import {
  getAgentJobManifestEntry,
  type AgentJobManifestEntry,
} from './agent-job-manifest';
import { getDb } from './database';
import { runWithSkillInferenceAccountAdmission } from './skill-inference-service';

export type AgentJobRunStatus =
  | 'success'
  | 'skipped_unchanged'
  | 'skipped_no_work'
  | 'skipped_overlap'
  | 'failed';

export interface AgentJobScope {
  tenantId: number;
  userId: number;
}

export interface PreparedAgentJobInput<Input> {
  kind: 'ready';
  input: Input;
  /**
   * Hashed immediately and never persisted or logged in raw form. Adapters may
   * include private input material because only the sha256 digest leaves this
   * process boundary.
   */
  fingerprintMaterial: unknown;
}

export interface SkippedAgentJobInput {
  kind: 'skip';
  status: 'skipped_unchanged' | 'skipped_no_work';
  reason: string;
  fingerprintMaterial?: unknown;
}

export type AgentJobPreparation<Input> = PreparedAgentJobInput<Input> | SkippedAgentJobInput;

export interface AgentJobExecutionContext<Input> {
  scope: AgentJobScope;
  input: Input;
  runId: string;
  attempt: number;
  /** Account deletion and caller cancellation for the complete governed run. */
  abortSignal?: AbortSignal;
}

export interface AgentJobOutcome<Output> {
  jobId: string;
  runId: string;
  scope: AgentJobScope;
  status: AgentJobRunStatus;
  attempt: number;
  inputFingerprint: string | null;
  outputFingerprint: string | null;
  providerCalls: number;
  costUsd: number;
  durationMs: number;
  skipReason: string | null;
  errorCode: string | null;
  output?: Output;
}

export interface GovernedAgentJobAdapter<Input, Output> {
  jobId: string;
  /** Exact AgentJobManifest routing declaration; runtime drift fails closed. */
  providerRouting: string;
  prepare(scope: AgentJobScope): Promise<AgentJobPreparation<Input>> | AgentJobPreparation<Input>;
  execute(context: AgentJobExecutionContext<Input>): Promise<Output>;
  /** Throw a bounded typed error when provider output is not safe to accept. */
  validateOutput(output: Output, input: Input): void;
  /** Allows an existing domain idempotency gate to report a zero-call skip. */
  classifyOutput?(
    output: Output,
    input: Input,
    usage: AgentJobUsageAttribution,
  ): 'success' | 'skipped_unchanged' | 'skipped_no_work';
  /** Only typed, bounded outcome metadata is supplied; provider output stays local. */
  notify?(outcome: AgentJobOutcome<Output>): Promise<void>;
  /** Retries remain opt-in even when maxAttempts is greater than one. */
  isRetryable?(error: unknown): boolean;
}

export interface AgentJobUsageAttribution {
  providerCalls: number;
  costUsd: number;
}

interface AgentJobUsageSummary extends AgentJobUsageAttribution {
  scopeViolations: number;
}

export interface AgentJobRunnerDependencies {
  db?: Database.Database;
  now?: () => Date;
  randomUUID?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam; runtime always uses the shared durable account admission. */
  accountAdmission?: typeof runWithSkillInferenceAccountAdmission;
  /** Internal signal supplied by the exported account-admitted wrapper. */
  accountAbortSignal?: AbortSignal;
  /** Test-only policy injection; runtime callers always load AgentJobManifest. */
  manifestEntry?: AgentJobManifestEntry;
}

export class AgentJobGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentJobGovernanceError';
  }
}

export class AgentJobAuditUnavailableError extends Error {
  constructor() {
    super('Agent job audit or provider attribution store is unavailable');
    this.name = 'AgentJobAuditUnavailableError';
  }
}

export class AgentJobOutputValidationError extends Error {
  constructor(message = 'Agent job output validation failed') {
    super(message);
    this.name = 'AgentJobOutputValidationError';
  }
}

export class AgentJobProviderAttributionError extends Error {
  constructor() {
    super('Provider-capable agent job completed without attributed provider usage');
    this.name = 'AgentJobProviderAttributionError';
  }
}

export class AgentJobUsageScopeError extends Error {
  constructor() {
    super('Provider usage attribution escaped the governed tenant and user scope');
    this.name = 'AgentJobUsageScopeError';
  }
}

const inFlightClaims = new Set<string>();
const MAX_REASON_LENGTH = 80;
const SAFE_REASON = /^[a-z0-9][a-z0-9_.:-]*$/;

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentJobGovernanceError('Agent job fingerprint contains a non-finite number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value !== 'object' || value === undefined) {
    throw new AgentJobGovernanceError('Agent job fingerprint contains an unsupported value');
  }
  if (seen.has(value)) throw new AgentJobGovernanceError('Agent job fingerprint contains a cycle');
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const candidate = (value as Record<string, unknown>)[key];
    if (candidate !== undefined) result[key] = canonicalize(candidate, seen);
  }
  seen.delete(value);
  return result;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function validateReason(reason: string): string {
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH || !SAFE_REASON.test(reason)) {
    throw new AgentJobGovernanceError('Agent job skip reason is not a bounded stable code');
  }
  return reason;
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.name : 'UnknownError';
  const normalized = raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
  return normalized || 'UnknownError';
}

function assertPolicyAndScope(
  entry: AgentJobManifestEntry,
  adapter: GovernedAgentJobAdapter<unknown, unknown>,
  scope: AgentJobScope,
): void {
  const policy = entry.sharedRunner;
  if (!policy || policy.implementation !== 'governed-v1') {
    throw new AgentJobGovernanceError(`AgentJobManifest shared runner policy missing: ${entry.id}`);
  }
  if (adapter.jobId !== entry.id || adapter.providerRouting !== entry.providerRouting) {
    throw new AgentJobGovernanceError(`Agent job adapter manifest parity mismatch: ${entry.id}`);
  }
  if (entry.providerUsage !== 'governed-provider-capable'
      || entry.providerRouting === 'not-applicable-no-model-provider'
      || entry.costPolicy === 'no-model-provider-cost'
      || entry.inputFingerprint.enforcement === 'not-applicable-no-provider') {
    throw new AgentJobGovernanceError(`Agent job provider governance is incomplete: ${entry.id}`);
  }

  const platformScope = scope.tenantId === 0 && scope.userId === 0;
  if (policy.scope === 'platform') {
    if (scope.tenantId !== 0 || scope.userId !== 0) {
      throw new AgentJobGovernanceError(`Platform agent job received tenant scope: ${entry.id}`);
    }
    return;
  }
  if (policy.scope === 'platform-or-tenant-user' && platformScope) return;
  if (!Number.isSafeInteger(scope.tenantId)
      || !Number.isSafeInteger(scope.userId)
      || scope.tenantId <= 0
      || scope.userId <= 0) {
    throw new AgentJobGovernanceError(`Tenant agent job scope is invalid: ${entry.id}`);
  }
}

function assertStoresAvailable(db: Database.Database): void {
  try {
    db.prepare('SELECT 1 FROM agent_job_runs LIMIT 1').get();
    db.prepare('SELECT 1 FROM api_usage LIMIT 1').get();
  } catch {
    throw new AgentJobAuditUnavailableError();
  }
}

function insertRun(
  db: Database.Database,
  input: {
    runId: string;
    entry: AgentJobManifestEntry;
    scope: AgentJobScope;
    attempt: number;
    status: 'running' | 'skipped_unchanged' | 'skipped_no_work' | 'skipped_overlap' | 'failed';
    inputFingerprint: string | null;
    skipReason: string | null;
    startedAt: string;
    completedAt: string | null;
    notificationStatus: 'not_applicable' | 'pending';
    errorCode?: string | null;
    durationMs?: number | null;
  },
): void {
  db.prepare(`
    INSERT INTO agent_job_runs (
      run_id, job_id, job_version, tenant_id, user_id, attempt, status,
      input_fingerprint, skip_reason, error_code, duration_ms, notification_status, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.entry.id,
    input.entry.jobVersion,
    input.scope.tenantId,
    input.scope.userId,
    input.attempt,
    input.status,
    input.inputFingerprint,
    input.skipReason,
    input.errorCode ?? null,
    input.durationMs ?? null,
    input.notificationStatus,
    input.startedAt,
    input.completedAt,
  );
}

function hasReusableFingerprint(
  db: Database.Database,
  entry: AgentJobManifestEntry,
  scope: AgentJobScope,
  inputFingerprint: string,
): boolean {
  const row = db.prepare(`
    SELECT 1 AS reusable
      FROM agent_job_runs
     WHERE job_id = ?
       AND job_version = ?
       AND tenant_id = ?
       AND user_id = ?
       AND input_fingerprint = ?
       AND status IN ('success', 'skipped_unchanged')
     ORDER BY id DESC
     LIMIT 1
  `).get(entry.id, entry.jobVersion, scope.tenantId, scope.userId, inputFingerprint);
  return !!row;
}

function collectUsage(
  db: Database.Database,
  runId: string,
  scope: AgentJobScope,
): AgentJobUsageSummary {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS providerCalls,
             COALESCE(SUM(cost_usd), 0) AS costUsd,
             COALESCE(SUM(CASE
               WHEN tenant_id != ? OR user_id != ? THEN 1
               ELSE 0
             END), 0) AS scopeViolations
        FROM api_usage
       WHERE run_id = ?
    `).get(scope.tenantId, scope.userId, runId) as {
      providerCalls: number;
      costUsd: number;
      scopeViolations: number;
    };
    const providerCalls = Number(row?.providerCalls ?? 0);
    const costUsd = Number(row?.costUsd ?? 0);
    const scopeViolations = Number(row?.scopeViolations ?? 0);
    if (!Number.isSafeInteger(providerCalls)
        || providerCalls < 0
        || !Number.isFinite(costUsd)
        || costUsd < 0
        || !Number.isSafeInteger(scopeViolations)
        || scopeViolations < 0) {
      throw new Error('invalid usage aggregate');
    }
    return { providerCalls, costUsd, scopeViolations };
  } catch {
    throw new AgentJobAuditUnavailableError();
  }
}

function finishRun(
  db: Database.Database,
  input: {
    runId: string;
    status: AgentJobRunStatus;
    outputFingerprint: string | null;
    skipReason: string | null;
    errorCode: string | null;
    usage: AgentJobUsageSummary;
    durationMs: number;
    completedAt: string;
  },
): void {
  const result = db.prepare(`
    UPDATE agent_job_runs
       SET status = ?,
           output_fingerprint = ?,
           skip_reason = ?,
           error_code = ?,
           provider_calls = ?,
           cost_usd = ?,
           duration_ms = ?,
           completed_at = ?
     WHERE run_id = ?
       AND status = 'running'
  `).run(
    input.status,
    input.outputFingerprint,
    input.skipReason,
    input.errorCode,
    input.usage.providerCalls,
    input.usage.costUsd,
    input.durationMs,
    input.completedAt,
    input.runId,
  );
  if (result.changes !== 1) throw new AgentJobAuditUnavailableError();
}

function updateNotificationStatus(
  db: Database.Database,
  runId: string,
  status: 'sent' | 'failed',
): void {
  const result = db.prepare(`
    UPDATE agent_job_runs
       SET notification_status = ?
     WHERE run_id = ?
  `).run(status, runId);
  if (result.changes !== 1) throw new AgentJobAuditUnavailableError();
}

async function notify<Output>(
  db: Database.Database,
  adapter: GovernedAgentJobAdapter<unknown, Output>,
  outcome: AgentJobOutcome<Output>,
): Promise<void> {
  if (!adapter.notify) return;
  try {
    await adapter.notify(outcome);
    updateNotificationStatus(db, outcome.runId, 'sent');
  } catch (error) {
    try {
      updateNotificationStatus(db, outcome.runId, 'failed');
    } catch {
      // The completed run remains authoritative; notification audit failure is
      // surfaced below without replaying provider work.
    }
    logger.warn(
      { jobId: outcome.jobId, errorCode: errorCode(error) },
      'Agent job outcome notification failed',
    );
  }
}

function completedSkipOutcome<Output>(input: {
  entry: AgentJobManifestEntry;
  runId: string;
  scope: AgentJobScope;
  status: 'skipped_unchanged' | 'skipped_no_work' | 'skipped_overlap';
  inputFingerprint: string | null;
  reason: string;
  durationMs: number;
}): AgentJobOutcome<Output> {
  return {
    jobId: input.entry.id,
    runId: input.runId,
    scope: input.scope,
    status: input.status,
    attempt: 1,
    inputFingerprint: input.inputFingerprint,
    outputFingerprint: null,
    providerCalls: 0,
    costUsd: 0,
    durationMs: input.durationMs,
    skipReason: input.reason,
    errorCode: null,
  };
}

/**
 * Execute one manifest-governed job target.
 *
 * The order is security-sensitive: validate manifest/scope and durable audit
 * stores, acquire the process claim, prepare/hash input, apply the unchanged
 * gate, then and only then enter the provider-capable adapter.
 */
export async function runGovernedAgentJob<Input, Output>(
  adapter: GovernedAgentJobAdapter<Input, Output>,
  scope: AgentJobScope,
  dependencies: AgentJobRunnerDependencies = {},
): Promise<AgentJobOutcome<Output>> {
  const entry = dependencies.manifestEntry ?? getAgentJobManifestEntry(adapter.jobId);
  // Preserve governance-error precedence before touching account state.
  assertPolicyAndScope(
    entry,
    adapter as GovernedAgentJobAdapter<unknown, unknown>,
    scope,
  );
  const db = dependencies.db ?? getDb();
  const execute = (accountAbortSignal?: AbortSignal) => runGovernedAgentJobInternal(
    adapter,
    scope,
    {
      ...dependencies,
      db,
      manifestEntry: entry,
      accountAbortSignal,
    },
  );

  // Platform-scoped evaluation has no account owner to fence. Every
  // user-attributed governed job holds the same registry entry from private
  // input preparation through output validation, persistence, usage
  // settlement, and notification.
  if (scope.userId <= 0) return execute();
  const accountAdmission = dependencies.accountAdmission
    ?? runWithSkillInferenceAccountAdmission;
  return accountAdmission(
    { userId: scope.userId },
    (accountAbortSignal) => execute(accountAbortSignal),
    db,
  );
}

async function runGovernedAgentJobInternal<Input, Output>(
  adapter: GovernedAgentJobAdapter<Input, Output>,
  scope: AgentJobScope,
  dependencies: AgentJobRunnerDependencies = {},
): Promise<AgentJobOutcome<Output>> {
  const entry = dependencies.manifestEntry ?? getAgentJobManifestEntry(adapter.jobId);
  assertPolicyAndScope(
    entry,
    adapter as GovernedAgentJobAdapter<unknown, unknown>,
    scope,
  );

  const db = dependencies.db ?? getDb();
  const now = dependencies.now ?? (() => new Date());
  const createRunId = dependencies.randomUUID ?? randomUUID;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  assertStoresAvailable(db);

  const claimKey = `${entry.id}:${scope.tenantId}:${scope.userId}`;
  if (inFlightClaims.has(claimKey)) {
    const runId = createRunId();
    const started = now();
    const reason = 'runtime_process_lock';
    insertRun(db, {
      runId,
      entry,
      scope,
      attempt: 1,
      status: 'skipped_overlap',
      inputFingerprint: null,
      skipReason: reason,
      startedAt: started.toISOString(),
      completedAt: started.toISOString(),
      notificationStatus: adapter.notify ? 'pending' : 'not_applicable',
      durationMs: 0,
    });
    const outcome = completedSkipOutcome<Output>({
      entry,
      runId,
      scope,
      status: 'skipped_overlap',
      inputFingerprint: null,
      reason,
      durationMs: 0,
    });
    await notify(db, adapter as GovernedAgentJobAdapter<unknown, Output>, outcome);
    return outcome;
  }

  inFlightClaims.add(claimKey);
  try {
    const preparationStartedAt = now();
    const preparationStarted = Date.now();
    let preparation: AgentJobPreparation<Input>;
    let inputFingerprint: string;
    try {
      preparation = await adapter.prepare(scope);
      inputFingerprint = fingerprint({
        jobId: entry.id,
        jobVersion: entry.jobVersion,
        scope,
        material: preparation.fingerprintMaterial ?? { reason: preparation.kind === 'skip' ? preparation.reason : 'ready' },
      });
    } catch (error) {
      const runId = createRunId();
      const completedAt = now();
      insertRun(db, {
        runId,
        entry,
        scope,
        attempt: 1,
        status: 'failed',
        inputFingerprint: null,
        skipReason: null,
        errorCode: errorCode(error),
        startedAt: preparationStartedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        notificationStatus: 'not_applicable',
        durationMs: Math.max(0, Date.now() - preparationStarted),
      });
      throw error;
    }

    if (preparation.kind === 'skip') {
      const reason = validateReason(preparation.reason);
      const runId = createRunId();
      const completedAt = now().toISOString();
      const durationMs = Math.max(0, Date.now() - preparationStarted);
      insertRun(db, {
        runId,
        entry,
        scope,
        attempt: 1,
        status: preparation.status,
        inputFingerprint,
        skipReason: reason,
        startedAt: preparationStartedAt.toISOString(),
        completedAt,
        notificationStatus: adapter.notify ? 'pending' : 'not_applicable',
        durationMs,
      });
      const outcome = completedSkipOutcome<Output>({
        entry,
        runId,
        scope,
        status: preparation.status,
        inputFingerprint,
        reason,
        durationMs,
      });
      await notify(db, adapter as GovernedAgentJobAdapter<unknown, Output>, outcome);
      return outcome;
    }

    if (entry.sharedRunner!.fingerprintGate === 'runner'
        && entry.inputFingerprint.enforcement === 'runtime-fingerprint'
        && hasReusableFingerprint(db, entry, scope, inputFingerprint)) {
      const runId = createRunId();
      const completedAt = now().toISOString();
      const reason = 'runtime_fingerprint_unchanged';
      const durationMs = Math.max(0, Date.now() - preparationStarted);
      insertRun(db, {
        runId,
        entry,
        scope,
        attempt: 1,
        status: 'skipped_unchanged',
        inputFingerprint,
        skipReason: reason,
        startedAt: preparationStartedAt.toISOString(),
        completedAt,
        notificationStatus: adapter.notify ? 'pending' : 'not_applicable',
        durationMs,
      });
      const outcome = completedSkipOutcome<Output>({
        entry,
        runId,
        scope,
        status: 'skipped_unchanged',
        inputFingerprint,
        reason,
        durationMs,
      });
      await notify(db, adapter as GovernedAgentJobAdapter<unknown, Output>, outcome);
      return outcome;
    }

    let finalError: unknown;
    for (let attempt = 1; attempt <= entry.sharedRunner!.maxAttempts; attempt++) {
      const runId = createRunId();
      const startedAt = now();
      const startedMonotonic = Date.now();
      insertRun(db, {
        runId,
        entry,
        scope,
        attempt,
        status: 'running',
        inputFingerprint,
        skipReason: null,
        startedAt: startedAt.toISOString(),
        completedAt: null,
        notificationStatus: 'not_applicable',
      });

      try {
        throwIfAgentJobAborted(dependencies.accountAbortSignal);
        const output = await adapter.execute({
          scope,
          input: preparation.input,
          runId,
          attempt,
          abortSignal: dependencies.accountAbortSignal,
        });
        throwIfAgentJobAborted(dependencies.accountAbortSignal);
        adapter.validateOutput(output, preparation.input);
        const usage = collectUsage(db, runId, scope);
        if (usage.scopeViolations !== 0) throw new AgentJobUsageScopeError();
        const status = adapter.classifyOutput?.(output, preparation.input, usage) ?? 'success';
        if (!['success', 'skipped_unchanged', 'skipped_no_work'].includes(status)) {
          throw new AgentJobGovernanceError('Agent job adapter returned an invalid completion status');
        }
        if (status === 'success' && usage.providerCalls === 0) {
          throw new AgentJobProviderAttributionError();
        }
        if ((status === 'skipped_unchanged' || status === 'skipped_no_work')
            && usage.providerCalls !== 0) {
          throw new AgentJobProviderAttributionError();
        }
        const outputFingerprint = fingerprint({
          jobId: entry.id,
          jobVersion: entry.jobVersion,
          output,
        });
        const durationMs = Math.max(0, Date.now() - startedMonotonic);
        const skipReason = status === 'skipped_unchanged'
          ? 'domain_fingerprint_unchanged'
          : status === 'skipped_no_work'
            ? 'domain_no_provider_work'
            : null;
        finishRun(db, {
          runId,
          status,
          outputFingerprint,
          skipReason,
          errorCode: null,
          usage,
          durationMs,
          completedAt: now().toISOString(),
        });
        const outcome: AgentJobOutcome<Output> = {
          jobId: entry.id,
          runId,
          scope,
          status,
          attempt,
          inputFingerprint,
          outputFingerprint,
          providerCalls: usage.providerCalls,
          costUsd: usage.costUsd,
          durationMs,
          skipReason,
          errorCode: null,
          output,
        };
        await notify(db, adapter as GovernedAgentJobAdapter<unknown, Output>, outcome);
        return outcome;
      } catch (error) {
        finalError = error;
        let usage: AgentJobUsageSummary = { providerCalls: 0, costUsd: 0, scopeViolations: 0 };
        try {
          usage = collectUsage(db, runId, scope);
          if (usage.scopeViolations !== 0) finalError = new AgentJobUsageScopeError();
        } catch (usageError) {
          finalError = usageError;
        }
        const durationMs = Math.max(0, Date.now() - startedMonotonic);
        finishRun(db, {
          runId,
          status: 'failed',
          outputFingerprint: null,
          skipReason: null,
          errorCode: errorCode(finalError),
          usage,
          durationMs,
          completedAt: now().toISOString(),
        });

        const retry = attempt < entry.sharedRunner!.maxAttempts
          && adapter.isRetryable?.(finalError) === true;
        if (retry) {
          if (entry.sharedRunner!.retryBackoffMs > 0) await sleep(entry.sharedRunner!.retryBackoffMs);
          continue;
        }

        throw finalError;
      }
    }
    throw finalError ?? new AgentJobGovernanceError(`Agent job attempts exhausted: ${entry.id}`);
  } finally {
    inFlightClaims.delete(claimKey);
  }
}

function throwIfAgentJobAborted(abortSignal?: AbortSignal): void {
  if (!abortSignal?.aborted) return;
  if (abortSignal.reason instanceof Error) throw abortSignal.reason;
  throw Object.assign(new Error('agent_job_cancelled'), {
    name: 'AbortError',
    code: 'ACCOUNT_DELETION_IN_PROGRESS',
  });
}

export function resetAgentJobRunnerForTests(): void {
  inFlightClaims.clear();
}
