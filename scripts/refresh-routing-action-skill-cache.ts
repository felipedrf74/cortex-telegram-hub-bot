#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 7 — separately governed action-skill classifier cache population.
 *
 * `--inspect` is read-only and provider-free. It emits a canonical plan whose
 * digest binds the exact corpus, manifest prompt bytes, per-item flag-on
 * request digests, deployed runtime/artifact, Gemini model, limit, and hard
 * budget. `--apply` needs owner authorization plus that exact digest, creates
 * and verifies an owner-only SQLite backup, then performs a resumable bounded
 * pass through Gemini directly (never TaskRoutingProvider/fallback).
 *
 * Raw corpus text and raw provider responses are deliberately absent from
 * plans, results, and the prediction cache. A structured prediction is cached
 * only after exactly one successful api_usage row proves the exact provider,
 * model, category, run, and governed attribution.
 */

import crypto, { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

import type { AIProvider, ClassifyOptions } from '../src/services/ai-provider';
import type { AiBudgetRequest } from '../src/services/cost-guardrail';
import { computeProviderCallCostUpperBoundUsd } from '../src/services/model-pricing';
import { getRoutingLabelCandidates } from '../src/services/routing-corpus';
import {
  buildRoutingActionSkillCorpusIdentity,
  buildRoutingActionSkillRequestIdentity,
  buildRoutingActionSkillSourceIdentity,
  ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY,
  ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
  ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE,
  ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
  ROUTING_ACTION_SKILL_USAGE_USER_ID,
  storeRoutingActionSkillPrediction,
} from '../src/services/routing-action-skill-accuracy';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const PROVIDER = 'gemini';
const MODEL = 'gemini-2.5-flash-lite';
const USAGE_CATEGORY = 'gemini_classify';
const REQUEST_SOURCE = ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE;
const BASE_CATEGORY = ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY;
const CLASSIFIER_MAX_OUTPUT_TOKENS = 256;
const MAX_BUDGET_USD = 0.50;
const PROTECTED_DIRECTORY_MODE = 0o700;
const PROTECTED_BACKUP_MODE = 0o600;
const PLAN_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const INVALID_CLASSIFICATION_MESSAGE =
  'Gemini action-skill classification was invalid; no cache row was written';
const PREDICTION_NOT_RETAINED_MESSAGE =
  'Gemini action-skill prediction could not be retained; no cache row was written';

interface PendingPlanRow {
  corpusItemId: number;
  utteranceHash: string;
  requestSha256: string;
  providerAttemptCostCeilingUsd: number;
}

export interface InspectRoutingActionSkillCacheRefreshOptions {
  dbPath: string;
  promptPath: string;
  runtimeSha: string;
  artifactDigest: string;
  model: string;
  limit: number;
  budgetUsd: number;
}

export interface RoutingActionSkillCacheRefreshPlan {
  schemaVersion: 'routing_action_skill_cache_refresh_plan.v1';
  operation: 'populate_manifest_action_skill_classify_cache';
  dbPath: string;
  runtimeSha: string;
  artifactDigest: string;
  releaseRunId: string;
  planSequence: number;
  provider: typeof PROVIDER;
  model: typeof MODEL;
  usageCategory: typeof USAGE_CATEGORY;
  requestSource: typeof REQUEST_SOURCE;
  baseCategory: typeof BASE_CATEGORY;
  jobName: typeof ROUTING_ACTION_SKILL_USAGE_JOB_NAME;
  requestBuilderVersion: string;
  maxOutputTokens: typeof CLASSIFIER_MAX_OUTPUT_TOKENS;
  promptArtifact: {
    path: string;
    sha256: string;
  };
  corpusIdentityDigest: string;
  limit: number;
  budgetUsd: number;
  providerAttemptCostCeilingUsd: number;
  labeledItemCount: number;
  cachedItemCount: number;
  pendingItemCount: number;
  selectedItemCount: number;
  pendingRows: PendingPlanRow[];
  integrity: 'ok';
  planDigest: string;
}

export interface RunRoutingActionSkillCacheRefreshOptions
  extends InspectRoutingActionSkillCacheRefreshOptions {
  backupDir: string;
  ownerAuthorized: boolean;
  acknowledgedPlanDigest: string;
}

interface ProviderBoundary {
  readonly name: string;
  classify(
    message: string,
    activeContext?: undefined,
    options?: ClassifyOptions,
  ): ReturnType<AIProvider['classify']>;
}

type BudgetReservation = <T>(request: AiBudgetRequest, callback: () => Promise<T>) => Promise<T>;

export interface RoutingActionSkillRefreshDependencies {
  /** Test seam; production resolves getProvider('gemini') directly. */
  resolveProvider?: () => ProviderBoundary | null | Promise<ProviderBoundary | null>;
  /** Test seam; production reads the model the Gemini adapter will actually use. */
  readConfiguredClassifierModel?: () => string | Promise<string>;
  /** Test seam; production uses the canonical serialized budget boundary. */
  withBudgetReservation?: BudgetReservation;
  /** Test seam; production enables the flag and executes the boot guard. */
  enterManifestPromptScope?: () => Promise<() => void>;
  /** Test seam for proving the provider will consume the inspected prompt. */
  readActiveClassifierSystemPrompt?: () => string | Promise<string>;
}

export interface RoutingActionSkillCacheRefreshResult {
  schemaVersion: 'routing_action_skill_cache_refresh_apply.v1';
  status: 'completed';
  dbPath: string;
  runtimeSha: string;
  artifactDigest: string;
  planDigest: string;
  planSequence: number;
  runId: string;
  hardBudgetUsd: number;
  attempted: number;
  cached: number;
  remaining: number;
  spentUsd: number;
  backupPath: string;
  backupIntegrity: 'ok';
  integrity: 'ok';
}

interface UsageRow {
  id: number;
  category: string;
  model: string;
  provider: string;
  runId: string | null;
  pricingStatus: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requestSource: string | null;
  baseCategory: string | null;
  jobName: string | null;
  userId: number | null;
  tenantId: number | null;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function assertReleaseIdentity(runtimeSha: string, artifactDigest: string): void {
  if (!/^[a-f0-9]{40}$/.test(runtimeSha)) {
    throw new Error('A full lowercase deployed runtime SHA is required');
  }
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
    throw new Error('A full lowercase deployed artifact SHA-256 is required');
  }
}

function assertRefreshBounds(model: string, limit: number, budgetUsd: number): void {
  if (model !== MODEL) {
    throw new Error(`Routing action-skill refresh permits only ${MODEL}`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 300) {
    throw new Error('Refresh limit must be an integer between 1 and 300');
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > MAX_BUDGET_USD) {
    throw new Error(`--budget-usd must be greater than zero and at most ${MAX_BUDGET_USD}`);
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) !== undefined;
}

function exactCacheExists(
  db: Database.Database,
  input: {
    utteranceHash: string;
    promptSha256: string;
    requestBuilderVersion: string;
    requestSha256: string;
    runtimeSha: string;
    artifactDigest: string;
    releaseRunId: string;
    corpusIdentityDigest: string;
    allowActiveClaim?: boolean;
  },
): boolean {
  return db.prepare(`
    SELECT 1
    FROM routing_manifest_skill_classify_cache c
    JOIN api_usage u ON u.id = c.api_usage_id
    JOIN routing_manifest_skill_refresh_runs r
      ON r.runtime_sha = c.runtime_sha
     AND r.artifact_digest = c.artifact_digest
     AND r.run_id = c.run_id
    JOIN routing_manifest_skill_refresh_plan_claims p
      ON p.plan_digest = c.plan_digest
     AND p.corpus_identity_digest = c.corpus_identity_digest
     AND p.runtime_sha = c.runtime_sha
     AND p.artifact_digest = c.artifact_digest
     AND p.run_id = c.run_id
    WHERE c.utterance_hash = ?
      AND c.runtime_sha = ?
      AND c.artifact_digest = ?
      AND c.run_id = ?
      AND c.corpus_identity_digest = ?
      AND c.prompt_sha256 = ?
      AND c.request_builder_version = ?
      AND c.request_sha256 = ?
      AND c.provider = ?
      AND c.model = ?
      AND c.usage_category = ?
      AND u.category = c.usage_category
      AND u.provider = c.provider
      AND u.model = c.model
      AND u.run_id = c.run_id
      AND u.pricing_status = 'resolved'
      AND u.input_tokens > 0
      AND u.output_tokens > 0
      AND u.cost_usd >= 0
      AND u.request_source = ?
      AND u.base_category = ?
      AND u.job_name = ?
      AND u.user_id = ?
      AND u.tenant_id = ?
      AND r.prompt_sha256 = c.prompt_sha256
      AND r.request_builder_version = c.request_builder_version
      AND r.provider = c.provider
      AND r.model = c.model
      AND r.usage_category = c.usage_category
      AND r.request_source = ?
      AND r.base_category = ?
      AND r.job_name = ?
      AND r.user_id = ?
      AND r.tenant_id = ?
      AND (p.status IN ('failed', 'completed') OR (? = 1 AND p.status = 'active'))
    LIMIT 1
  `).get(
    input.utteranceHash,
    input.runtimeSha,
    input.artifactDigest,
    input.releaseRunId,
    input.corpusIdentityDigest,
    input.promptSha256,
    input.requestBuilderVersion,
    input.requestSha256,
    PROVIDER,
    MODEL,
    USAGE_CATEGORY,
    REQUEST_SOURCE,
    BASE_CATEGORY,
    ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
    ROUTING_ACTION_SKILL_USAGE_USER_ID,
    ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
    REQUEST_SOURCE,
    BASE_CATEGORY,
    ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
    ROUTING_ACTION_SKILL_USAGE_USER_ID,
    ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
    input.allowActiveClaim === true ? 1 : 0,
  ) !== undefined;
}

/** Provider-free, mutation-free canonical plan for one bounded refresh pass. */
export function inspectRoutingActionSkillCacheRefresh(
  options: InspectRoutingActionSkillCacheRefreshOptions,
): RoutingActionSkillCacheRefreshPlan {
  assertReleaseIdentity(options.runtimeSha, options.artifactDigest);
  assertRefreshBounds(options.model, options.limit, options.budgetUsd);
  if (!fs.existsSync(options.dbPath)) throw new Error(`Database does not exist: ${options.dbPath}`);
  if (!fs.existsSync(options.promptPath)) {
    throw new Error(`Manifest classifier prompt does not exist: ${options.promptPath}`);
  }
  const dbPath = fs.realpathSync(options.dbPath);
  const promptPath = fs.realpathSync(options.promptPath);
  const promptStat = fs.lstatSync(promptPath);
  if (!promptStat.isFile() || promptStat.isSymbolicLink()) {
    throw new Error('Manifest classifier prompt must be a regular non-symlink file');
  }

  const sourceIdentity = buildRoutingActionSkillSourceIdentity({
    runtimeSha: options.runtimeSha,
    artifactDigest: options.artifactDigest,
    provider: PROVIDER,
    model: MODEL,
    usageCategory: USAGE_CATEGORY,
  });
  const promptArtifactText = fs.readFileSync(promptPath, 'utf8');
  const promptSha256 = sha256(promptArtifactText);
  if (promptSha256 !== sourceIdentity.promptSha256) {
    throw new Error(
      'Selected prompt artifact differs from the checked-in manifest classifier prompt',
    );
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Database integrity check failed before refresh planning');
    }
    for (const table of [
      'routing_corpus_items',
      'routing_manifest_skill_classify_cache',
      'routing_manifest_skill_refresh_runs',
      'routing_manifest_skill_refresh_plan_claims',
      'api_usage',
    ]) {
      if (!tableExists(db, table)) throw new Error(`Required routing refresh table is missing: ${table}`);
    }

    const existingReleaseRun = db.prepare(`
      SELECT run_id AS runId, budget_usd AS budgetUsd,
             prompt_sha256 AS promptSha256,
             request_builder_version AS requestBuilderVersion,
             provider, model, usage_category AS usageCategory,
             request_source AS requestSource, base_category AS baseCategory,
             job_name AS jobName, user_id AS userId, tenant_id AS tenantId
      FROM routing_manifest_skill_refresh_runs
      WHERE runtime_sha = ? AND artifact_digest = ?
    `).get(options.runtimeSha, options.artifactDigest) as {
      runId: string;
      budgetUsd: number;
      promptSha256: string;
      requestBuilderVersion: string;
      provider: string;
      model: string;
      usageCategory: string;
      requestSource: string;
      baseCategory: string;
      jobName: string;
      userId: number;
      tenantId: number;
    } | undefined;
    if (existingReleaseRun) {
      if (Math.abs(existingReleaseRun.budgetUsd - options.budgetUsd) > Number.EPSILON) {
        throw new Error(
          `Existing release refresh hard budget is ${existingReleaseRun.budgetUsd}; `
          + `new plans must retain that shared cap instead of ${options.budgetUsd}`,
        );
      }
      if (
        existingReleaseRun.runId !== sourceIdentity.releaseRunId
        || existingReleaseRun.promptSha256 !== sourceIdentity.promptSha256
        || existingReleaseRun.requestBuilderVersion !== sourceIdentity.requestBuilderVersion
        || existingReleaseRun.provider !== sourceIdentity.provider
        || existingReleaseRun.model !== sourceIdentity.model
        || existingReleaseRun.usageCategory !== sourceIdentity.usageCategory
        || existingReleaseRun.requestSource !== sourceIdentity.requestSource
        || existingReleaseRun.baseCategory !== sourceIdentity.baseCategory
        || existingReleaseRun.jobName !== sourceIdentity.jobName
        || existingReleaseRun.userId !== sourceIdentity.userId
        || existingReleaseRun.tenantId !== sourceIdentity.tenantId
      ) {
        throw new Error('Existing release refresh run has incompatible provenance');
      }
    }
    const planSequence = Number((db.prepare(`
      SELECT COALESCE(MAX(plan_sequence), 0) + 1 AS planSequence
      FROM routing_manifest_skill_refresh_plan_claims
      WHERE runtime_sha = ? AND artifact_digest = ?
    `).get(options.runtimeSha, options.artifactDigest) as { planSequence: number }).planSequence);
    if (!Number.isSafeInteger(planSequence) || planSequence < 1) {
      throw new Error('Could not derive the next release refresh plan sequence');
    }

    const corpusIdentity = buildRoutingActionSkillCorpusIdentity(db);
    const items = db.prepare(`
      SELECT id, utterance_hash AS utteranceHash, utterance_text AS utteranceText
      FROM routing_corpus_items
      WHERE label_status = 'labeled' AND utterance_text IS NOT NULL
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{
      id: number;
      utteranceHash: string;
      utteranceText: string;
    }>;
    const pending: Array<PendingPlanRow & { providerAttemptCostCeilingUsd: number }> = [];
    let cachedItemCount = 0;
    for (const item of items) {
      if (!item.utteranceText) continue;
      const request = buildRoutingActionSkillRequestIdentity(
        item.utteranceText,
        sourceIdentity.promptSha256,
      );
      if (exactCacheExists(db, {
        utteranceHash: item.utteranceHash,
        promptSha256: sourceIdentity.promptSha256,
        requestBuilderVersion: sourceIdentity.requestBuilderVersion,
        requestSha256: request.requestSha256,
        runtimeSha: sourceIdentity.runtimeSha,
        artifactDigest: sourceIdentity.artifactDigest,
        releaseRunId: sourceIdentity.releaseRunId,
        corpusIdentityDigest: corpusIdentity.digest,
      })) {
        cachedItemCount += 1;
        continue;
      }
      const providerAttemptCostCeilingUsd = computeProviderCallCostUpperBoundUsd({
        provider: PROVIDER,
        model: MODEL,
        payload: {
          classifierSystemPrompt: promptArtifactText,
          userContent: request.requestText,
        },
        maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      });
      if (
        !Number.isFinite(providerAttemptCostCeilingUsd)
        || providerAttemptCostCeilingUsd <= 0
      ) {
        throw new Error(
          `Provider-attempt cost ceiling is unavailable for routing corpus item ${item.id}`,
        );
      }
      pending.push({
        corpusItemId: item.id,
        utteranceHash: item.utteranceHash,
        requestSha256: `sha256:${request.requestSha256}`,
        providerAttemptCostCeilingUsd,
      });
    }
    const selectedPending = pending.slice(0, options.limit);
    const providerAttemptCostCeilingNanousd = selectedPending.reduce((sum, row) => (
      sum + Math.round(row.providerAttemptCostCeilingUsd * 1_000_000_000)
    ), 0);
    const providerAttemptCostCeilingUsd = providerAttemptCostCeilingNanousd / 1_000_000_000;
    if (providerAttemptCostCeilingUsd > options.budgetUsd + Number.EPSILON) {
      throw new Error(
        `Aggregate provider-attempt cost ceiling ${providerAttemptCostCeilingUsd.toFixed(9)} exceeds --budget-usd ${options.budgetUsd.toFixed(8)}`,
      );
    }
    const pendingRows: PendingPlanRow[] = selectedPending.map((row) => ({
      corpusItemId: row.corpusItemId,
      utteranceHash: row.utteranceHash,
      requestSha256: row.requestSha256,
      providerAttemptCostCeilingUsd:
        Math.round(row.providerAttemptCostCeilingUsd * 1_000_000_000) / 1_000_000_000,
    }));
    const payload = {
      schemaVersion: 'routing_action_skill_cache_refresh_plan.v1' as const,
      operation: 'populate_manifest_action_skill_classify_cache' as const,
      dbPath,
      runtimeSha: options.runtimeSha,
      artifactDigest: options.artifactDigest,
      releaseRunId: sourceIdentity.releaseRunId,
      planSequence,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      requestSource: REQUEST_SOURCE,
      baseCategory: BASE_CATEGORY,
      jobName: ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
      requestBuilderVersion: sourceIdentity.requestBuilderVersion,
      maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      promptArtifact: {
        path: promptPath,
        sha256: `sha256:${sourceIdentity.promptSha256}`,
      },
      corpusIdentityDigest: corpusIdentity.digest,
      limit: options.limit,
      budgetUsd: Number(options.budgetUsd.toFixed(8)),
      providerAttemptCostCeilingUsd,
      labeledItemCount: corpusIdentity.itemCount,
      cachedItemCount,
      pendingItemCount: pending.length,
      selectedItemCount: pendingRows.length,
      pendingRows,
      integrity: 'ok' as const,
    };
    return {
      ...payload,
      planDigest: `sha256:${sha256(canonicalJson(payload))}`,
    };
  } finally {
    db.close();
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnedByCurrentUser(targetPath: string, stat: fs.Stats, kind: string): void {
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Protected ${kind} must be owned by the current user: ${targetPath}`);
  }
}

function assertProtectedBackupDirectory(backupDir: string): void {
  const stat = fs.lstatSync(backupDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Protected backup directory must be a regular directory: ${backupDir}`);
  }
  assertOwnedByCurrentUser(backupDir, stat, 'backup directory');
  if ((stat.mode & 0o777) !== PROTECTED_DIRECTORY_MODE) {
    throw new Error(`Protected backup directory permissions must be 0700: ${backupDir}`);
  }
  fs.accessSync(backupDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function prepareProtectedBackupDirectory(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    fs.lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(resolved, { recursive: true, mode: PROTECTED_DIRECTORY_MODE });
    fs.chmodSync(resolved, PROTECTED_DIRECTORY_MODE);
  }
  assertProtectedBackupDirectory(resolved);
  const canonical = fs.realpathSync(resolved);
  assertProtectedBackupDirectory(canonical);
  return canonical;
}

function assertProtectedBackupFile(backupPath: string): void {
  const stat = fs.lstatSync(backupPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Routing action-skill backup must be a regular non-symlink file: ${backupPath}`);
  }
  assertOwnedByCurrentUser(backupPath, stat, 'backup file');
  if ((stat.mode & 0o777) !== PROTECTED_BACKUP_MODE) {
    throw new Error(`Routing action-skill backup permissions must be 0600: ${backupPath}`);
  }
}

function verifySqliteIntegrity(dbPath: string): 'ok' {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Protected routing action-skill backup integrity check failed');
    }
    return 'ok';
  } finally {
    db.close();
  }
}

async function createProtectedBackup(
  db: Database.Database,
  backupDir: string,
): Promise<{ backupPath: string; backupIntegrity: 'ok' }> {
  assertProtectedBackupDirectory(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    backupDir,
    `routing-action-skill-before-refresh-${stamp}-${process.pid}.db`,
  );
  if (fs.existsSync(backupPath)) throw new Error(`Refusing to overwrite backup: ${backupPath}`);
  const previousUmask = process.umask(0o077);
  try {
    await db.backup(backupPath);
  } finally {
    process.umask(previousUmask);
  }
  fs.chmodSync(backupPath, PROTECTED_BACKUP_MODE);
  assertProtectedBackupDirectory(backupDir);
  assertProtectedBackupFile(backupPath);
  return { backupPath, backupIntegrity: verifySqliteIntegrity(backupPath) };
}

async function defaultResolveProvider(): Promise<ProviderBoundary | null> {
  // The only production provider resolution path: direct Gemini, never the
  // task-routing provider and therefore never an OpenAI/Anthropic fallback.
  const { getProvider } = await import('../src/services/provider-registry');
  return getProvider(PROVIDER);
}

async function defaultReadConfiguredClassifierModel(): Promise<string> {
  const { config } = await import('../src/config');
  return config.gemini.classifierModel;
}

async function defaultBudgetReservation<T>(
  request: AiBudgetRequest,
  callback: () => Promise<T>,
): Promise<T> {
  const { withAiBudgetReservation } = await import('../src/services/cost-guardrail');
  return withAiBudgetReservation(request, callback);
}

async function defaultReadActiveClassifierSystemPrompt(): Promise<string> {
  const { getClassifierSystemPrompt } = await import('../src/services/anthropic');
  return getClassifierSystemPrompt();
}

async function enterManifestPromptEvaluationScope(): Promise<() => void> {
  const previousFlag = process.env.AI_CLASSIFY_MANIFEST_PROMPT;
  const masterKill = String(process.env.AI_ROUTING_MANIFEST_KILL ?? '').trim().toLowerCase();
  if (masterKill === '1' || masterKill === 'true' || masterKill === 'yes') {
    throw new Error('Manifest routing master kill is active; action-skill refresh is refused');
  }
  process.env.AI_CLASSIFY_MANIFEST_PROMPT = 'true';
  const restore = (): void => {
    if (previousFlag === undefined) delete process.env.AI_CLASSIFY_MANIFEST_PROMPT;
    else process.env.AI_CLASSIFY_MANIFEST_PROMPT = previousFlag;
  };
  try {
    const {
      isManifestClassifierPromptEnabled,
    } = await import('../src/router/classifier-prompt-builder');
    const { enforceManifestClassifierRuntimeGuard } = await import(
      '../src/router/classifier-manifest-runtime-guard'
    );
    const guard = enforceManifestClassifierRuntimeGuard();
    if (guard.forcedOff || !isManifestClassifierPromptEnabled()) {
      throw new Error('Manifest classifier runtime guard refused action-skill refresh');
    }
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

function maxApiUsageId(db: Database.Database): number {
  return Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM api_usage').get() as { id: number }).id);
}

function usageRowsAfter(db: Database.Database, afterId: number, runId: string): UsageRow[] {
  return db.prepare(`
    SELECT id, category, model, provider, run_id AS runId,
           pricing_status AS pricingStatus,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cost_usd AS costUsd, request_source AS requestSource,
           base_category AS baseCategory, job_name AS jobName,
           user_id AS userId, tenant_id AS tenantId
    FROM api_usage
    WHERE id > ? AND run_id = ?
    ORDER BY id ASC
  `).all(afterId, runId) as UsageRow[];
}

function requireExactSuccessfulUsage(rows: UsageRow[], runId: string): UsageRow {
  if (rows.length !== 1) {
    throw new Error(
      'Expected exactly one successful api_usage row for the Gemini classifier attempt; no cache row was written',
    );
  }
  const row = rows[0];
  if (
    row.category !== USAGE_CATEGORY
    || row.provider !== PROVIDER
    || row.model !== MODEL
    || row.runId !== runId
    || row.pricingStatus !== 'resolved'
    || !Number.isFinite(row.inputTokens)
    || row.inputTokens <= 0
    || !Number.isFinite(row.outputTokens)
    || row.outputTokens <= 0
    || !Number.isFinite(row.costUsd)
    || row.costUsd < 0
    || row.requestSource !== REQUEST_SOURCE
    || row.baseCategory !== BASE_CATEGORY
    || row.jobName !== ROUTING_ACTION_SKILL_USAGE_JOB_NAME
    || row.userId !== ROUTING_ACTION_SKILL_USAGE_USER_ID
    || row.tenantId !== ROUTING_ACTION_SKILL_USAGE_TENANT_ID
  ) {
    throw new Error(
      'Gemini classifier api_usage attribution did not match the authorized run; no cache row was written',
    );
  }
  return row;
}

function loadExactCorpusRequest(
  db: Database.Database,
  row: PendingPlanRow,
  promptSha256: string,
): { utteranceText: string; requestText: string } {
  const item = db.prepare(`
    SELECT utterance_text AS utteranceText
    FROM routing_corpus_items
    WHERE id = ? AND utterance_hash = ?
      AND label_status = 'labeled' AND utterance_text IS NOT NULL
  `).get(row.corpusItemId, row.utteranceHash) as { utteranceText: string } | undefined;
  if (!item) throw new Error('Routing corpus state changed after the authorized plan');
  const request = buildRoutingActionSkillRequestIdentity(item.utteranceText, promptSha256);
  if (`sha256:${request.requestSha256}` !== row.requestSha256) {
    throw new Error('Routing action-skill request changed after the authorized plan');
  }
  return { utteranceText: item.utteranceText, requestText: request.requestText };
}

interface RefreshPlanClaim {
  claimToken: string;
  runId: string;
  budgetUsd: number;
}

function claimRefreshPlan(
  db: Database.Database,
  plan: RoutingActionSkillCacheRefreshPlan,
): RefreshPlanClaim {
  const claimToken = crypto.randomUUID();
  const claim = db.transaction((): RefreshPlanClaim => {
    db.prepare(`
      INSERT OR IGNORE INTO routing_manifest_skill_refresh_runs (
        runtime_sha, artifact_digest, run_id, budget_usd,
        prompt_sha256, request_builder_version, provider, model,
        usage_category, request_source, base_category, job_name, user_id, tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.runtimeSha,
      plan.artifactDigest,
      plan.releaseRunId,
      plan.budgetUsd,
      plan.promptArtifact.sha256.slice('sha256:'.length),
      plan.requestBuilderVersion,
      plan.provider,
      plan.model,
      plan.usageCategory,
      plan.requestSource,
      plan.baseCategory,
      plan.jobName,
      ROUTING_ACTION_SKILL_USAGE_USER_ID,
      ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
    );
    const releaseRun = db.prepare(`
      SELECT run_id AS runId, budget_usd AS budgetUsd,
             prompt_sha256 AS promptSha256,
             request_builder_version AS requestBuilderVersion,
             provider, model, usage_category AS usageCategory,
             request_source AS requestSource, base_category AS baseCategory,
             job_name AS jobName, user_id AS userId, tenant_id AS tenantId
      FROM routing_manifest_skill_refresh_runs
      WHERE runtime_sha = ? AND artifact_digest = ?
    `).get(plan.runtimeSha, plan.artifactDigest) as {
      runId: string;
      budgetUsd: number;
      promptSha256: string;
      requestBuilderVersion: string;
      provider: string;
      model: string;
      usageCategory: string;
      requestSource: string;
      baseCategory: string;
      jobName: string;
      userId: number;
      tenantId: number;
    } | undefined;
    if (
      !releaseRun
      || releaseRun.runId !== plan.releaseRunId
      || Math.abs(releaseRun.budgetUsd - plan.budgetUsd) > Number.EPSILON
      || releaseRun.promptSha256 !== plan.promptArtifact.sha256.slice('sha256:'.length)
      || releaseRun.requestBuilderVersion !== plan.requestBuilderVersion
      || releaseRun.provider !== plan.provider
      || releaseRun.model !== plan.model
      || releaseRun.usageCategory !== plan.usageCategory
      || releaseRun.requestSource !== plan.requestSource
      || releaseRun.baseCategory !== plan.baseCategory
      || releaseRun.jobName !== plan.jobName
      || releaseRun.userId !== ROUTING_ACTION_SKILL_USAGE_USER_ID
      || releaseRun.tenantId !== ROUTING_ACTION_SKILL_USAGE_TENANT_ID
    ) {
      throw new Error('Release refresh run conflicts with the exact authorized provenance or hard budget');
    }

    const existingClaim = db.prepare(`
      SELECT plan_sequence AS planSequence,
             corpus_identity_digest AS corpusIdentityDigest,
             runtime_sha AS runtimeSha, artifact_digest AS artifactDigest,
             run_id AS runId, status
      FROM routing_manifest_skill_refresh_plan_claims
      WHERE plan_digest = ?
    `).get(plan.planDigest) as {
      planSequence: number;
      corpusIdentityDigest: string;
      runtimeSha: string;
      artifactDigest: string;
      runId: string;
      status: 'active' | 'failed' | 'completed';
    } | undefined;
    if (existingClaim) {
      if (
        existingClaim.planSequence !== plan.planSequence
        || existingClaim.corpusIdentityDigest !== plan.corpusIdentityDigest
        || existingClaim.runtimeSha !== plan.runtimeSha
        || existingClaim.artifactDigest !== plan.artifactDigest
        || existingClaim.runId !== plan.releaseRunId
      ) {
        throw new Error('Refresh plan digest is already bound to a different release identity');
      }
      throw new Error(`Refresh plan is already ${existingClaim.status}; exact replay is refused`);
    }
    const activeReleaseClaim = db.prepare(`
      SELECT plan_sequence AS planSequence
      FROM routing_manifest_skill_refresh_plan_claims
      WHERE runtime_sha = ? AND artifact_digest = ? AND status = 'active'
      LIMIT 1
    `).get(plan.runtimeSha, plan.artifactDigest) as { planSequence: number } | undefined;
    if (activeReleaseClaim) {
      throw new Error(
        `Release refresh plan sequence ${activeReleaseClaim.planSequence} is already active; `
        + 'concurrent apply is refused',
      );
    }
    const sequenceClaim = db.prepare(`
      SELECT plan_digest AS planDigest, status
      FROM routing_manifest_skill_refresh_plan_claims
      WHERE runtime_sha = ? AND artifact_digest = ? AND plan_sequence = ?
    `).get(plan.runtimeSha, plan.artifactDigest, plan.planSequence) as {
      planDigest: string;
      status: string;
    } | undefined;
    if (sequenceClaim) {
      throw new Error(
        `Release refresh plan sequence ${plan.planSequence} is already ${sequenceClaim.status}; `
        + 'inspect and authorize the next plan',
      );
    }
    db.prepare(`
      INSERT INTO routing_manifest_skill_refresh_plan_claims (
        plan_digest, plan_sequence, corpus_identity_digest,
        runtime_sha, artifact_digest, run_id, status, claim_token
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      plan.planDigest,
      plan.planSequence,
      plan.corpusIdentityDigest,
      plan.runtimeSha,
      plan.artifactDigest,
      plan.releaseRunId,
      claimToken,
    );
    return {
      claimToken,
      runId: releaseRun.runId,
      budgetUsd: releaseRun.budgetUsd,
    };
  });
  return claim.immediate();
}

function finishRefreshPlanClaim(
  db: Database.Database,
  planDigest: string,
  claimToken: string,
  status: 'failed' | 'completed',
): void {
  const result = db.prepare(`
    UPDATE routing_manifest_skill_refresh_plan_claims
    SET status = ?, claim_token = NULL, updated_at = datetime('now')
    WHERE plan_digest = ? AND status = 'active' AND claim_token = ?
  `).run(status, planDigest, claimToken);
  if (result.changes !== 1) {
    throw new Error(`Refresh plan claim could not be marked ${status}`);
  }
}

function normalizeManifestPrediction(
  prediction: Awaited<ReturnType<ProviderBoundary['classify']>>,
): { predictedDomain: string; predictedSkill: string | null } {
  const predictedDomain = prediction.domain;
  const predictedSkill = typeof prediction.skill === 'string' && prediction.skill.trim()
    ? prediction.skill.trim()
    : null;
  const candidates = getRoutingLabelCandidates();
  if (
    (
      !candidates.domains.includes(predictedDomain)
      && !candidates.specialLabels.includes(predictedDomain)
    )
    || (
      candidates.specialLabels.includes(predictedDomain)
      && predictedSkill !== null
    )
    || (
      !candidates.specialLabels.includes(predictedDomain)
      && predictedSkill !== null
      && !(candidates.skillsByDomain[predictedDomain] ?? []).includes(predictedSkill)
    )
  ) {
    // Do not include either provider-supplied value. The canonical store repeats
    // this validation as defense in depth, but its diagnostic includes the
    // rejected value and therefore must not become operator-facing output.
    throw new Error(INVALID_CLASSIFICATION_MESSAGE);
  }
  return { predictedDomain, predictedSkill };
}

/** Apply one acknowledged, backed-up, hard-budgeted, resumable refresh pass. */
export async function runRoutingActionSkillCacheRefresh(
  options: RunRoutingActionSkillCacheRefreshOptions,
  dependencies: RoutingActionSkillRefreshDependencies = {},
): Promise<RoutingActionSkillCacheRefreshResult> {
  const plan = inspectRoutingActionSkillCacheRefresh(options);
  if (options.ownerAuthorized !== true) {
    throw new Error('Routing action-skill provider refresh requires explicit owner authorization');
  }
  if (
    !PLAN_DIGEST_RE.test(options.acknowledgedPlanDigest)
    || options.acknowledgedPlanDigest !== plan.planDigest
  ) {
    throw new Error(
      `Routing action-skill provider refresh requires acknowledgement of exact plan digest ${plan.planDigest}`,
    );
  }

  const configuredClassifierModel = String(await (
    dependencies.readConfiguredClassifierModel ?? defaultReadConfiguredClassifierModel
  )()).trim();
  if (configuredClassifierModel !== plan.model) {
    throw new Error(
      `Configured classifier model must be ${plan.model}; provider access is refused`,
    );
  }

  // Authorization, acknowledgement, and exact-model validation precede even
  // backup-directory creation or provider resolution.
  const backupDir = prepareProtectedBackupDirectory(options.backupDir);
  const db = new Database(plan.dbPath);
  db.pragma('foreign_keys = ON');
  let activeClaim: RefreshPlanClaim | null = null;
  try {
    const { backupPath, backupIntegrity } = await createProtectedBackup(db, backupDir);
    const currentPlan = inspectRoutingActionSkillCacheRefresh(options);
    if (currentPlan.planDigest !== options.acknowledgedPlanDigest) {
      throw new Error(
        `Routing action-skill refresh state changed after backup; inspect and authorize ${currentPlan.planDigest}`,
      );
    }
    const claim = claimRefreshPlan(db, currentPlan);
    activeClaim = claim;
    const runId = claim.runId;

    // Provider resolution and flag-on runtime validation happen only after the
    // verified backup and atomic plan claim exist. Neither is reachable from
    // --inspect, and an exact concurrent/replayed claim fails before this line.
    const provider = await (dependencies.resolveProvider ?? defaultResolveProvider)();
    if (!provider || provider.name !== PROVIDER) {
      throw new Error('Gemini 2.5 Flash-Lite provider is unavailable; refresh aborted');
    }
    const restoreManifestPrompt = await (
      dependencies.enterManifestPromptScope ?? enterManifestPromptEvaluationScope
    )();
    const withBudgetReservation = dependencies.withBudgetReservation ?? defaultBudgetReservation;
    const promptSha256 = currentPlan.promptArtifact.sha256.slice('sha256:'.length);
    let attempted = 0;
    let cached = 0;
    try {
      const activeClassifierPrompt = await (
        dependencies.readActiveClassifierSystemPrompt
        ?? defaultReadActiveClassifierSystemPrompt
      )();
      const inspectedPrompt = fs.readFileSync(currentPlan.promptArtifact.path, 'utf8');
      if (
        activeClassifierPrompt !== inspectedPrompt
        || `sha256:${sha256(activeClassifierPrompt)}` !== currentPlan.promptArtifact.sha256
      ) {
        throw new Error(
          'Active classifier system prompt does not equal the inspected manifest prompt artifact; provider access refused',
        );
      }
      const { withStandaloneToolDatabaseAsync } = await import(
        '../src/services/standalone-tool-database'
      );
      await withStandaloneToolDatabaseAsync(db, async () => {
        for (const pending of currentPlan.pendingRows) {
          await withBudgetReservation({
            userId: ROUTING_ACTION_SKILL_USAGE_USER_ID,
            requestSource: REQUEST_SOURCE,
            baseCategory: BASE_CATEGORY,
            jobName: ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
            runId,
            estimatedCostUsd: pending.providerAttemptCostCeilingUsd,
            hardRunCostLimitUsd: claim.budgetUsd,
          }, async () => {
            const exact = loadExactCorpusRequest(db, pending, promptSha256);
            if (exactCacheExists(db, {
              utteranceHash: pending.utteranceHash,
              promptSha256,
              requestBuilderVersion: currentPlan.requestBuilderVersion,
              requestSha256: pending.requestSha256.slice('sha256:'.length),
              runtimeSha: currentPlan.runtimeSha,
              artifactDigest: currentPlan.artifactDigest,
              releaseRunId: runId,
              corpusIdentityDigest: currentPlan.corpusIdentityDigest,
              allowActiveClaim: true,
            })) {
              return;
            }
            const beforeUsageId = maxApiUsageId(db);
            attempted += 1;
            let prediction: Awaited<ReturnType<ProviderBoundary['classify']>>;
            try {
              prediction = await provider.classify(exact.requestText, undefined, {
                userId: ROUTING_ACTION_SKILL_USAGE_USER_ID,
                tenantId: ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
                requestId: runId,
                source: 'evaluation',
                maxProviderAttempts: 1,
                failClosedOnError: true,
              });
            } catch {
              throw new Error('Gemini action-skill classification failed; no cache row was written');
            }
            if (
              !prediction
              || typeof prediction.domain !== 'string'
              || !Number.isFinite(prediction.confidence)
            ) {
              throw new Error('Gemini action-skill classification was malformed; no cache row was written');
            }
            const normalizedPrediction = normalizeManifestPrediction(prediction);
            const usage = requireExactSuccessfulUsage(
              usageRowsAfter(db, beforeUsageId, runId),
              runId,
            );
            try {
              storeRoutingActionSkillPrediction({
                runtimeSha: currentPlan.runtimeSha,
                artifactDigest: currentPlan.artifactDigest,
                planDigest: currentPlan.planDigest,
                corpusIdentityDigest: currentPlan.corpusIdentityDigest,
                utteranceHash: pending.utteranceHash,
                utteranceText: exact.utteranceText,
                provider: PROVIDER,
                model: MODEL,
                usageCategory: USAGE_CATEGORY,
                predictedDomain: normalizedPrediction.predictedDomain,
                predictedSkill: normalizedPrediction.predictedSkill,
                confidence: prediction.confidence,
                apiUsageId: usage.id,
                runId,
              }, db);
            } catch {
              // The store deliberately keeps precise diagnostics for trusted
              // local callers. This provider-facing boundary must not let any
              // rejected model value or database detail reach CLI stderr.
              throw new Error(PREDICTION_NOT_RETAINED_MESSAGE);
            }
            cached += 1;
          });
        }
      });
    } finally {
      restoreManifestPrompt();
    }

    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Database integrity check failed after routing action-skill refresh');
    }
    const spentUsd = Number((db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS spentUsd
      FROM api_usage
      WHERE run_id = ? AND request_source = ? AND base_category = ?
        AND job_name = ? AND user_id = ? AND tenant_id = ?
    `).get(
      runId,
      REQUEST_SOURCE,
      BASE_CATEGORY,
      ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
      ROUTING_ACTION_SKILL_USAGE_USER_ID,
      ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
    ) as { spentUsd: number }).spentUsd);
    finishRefreshPlanClaim(db, currentPlan.planDigest, claim.claimToken, 'completed');
    activeClaim = null;
    const postRefreshPlan = inspectRoutingActionSkillCacheRefresh(options);
    return {
      schemaVersion: 'routing_action_skill_cache_refresh_apply.v1',
      status: 'completed',
      dbPath: plan.dbPath,
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      planDigest: plan.planDigest,
      planSequence: plan.planSequence,
      runId,
      hardBudgetUsd: claim.budgetUsd,
      attempted,
      cached,
      remaining: postRefreshPlan.pendingItemCount,
      spentUsd: Number(spentUsd.toFixed(8)),
      backupPath,
      backupIntegrity,
      integrity: 'ok',
    };
  } catch (error) {
    if (activeClaim) {
      try {
        finishRefreshPlanClaim(db, plan.planDigest, activeClaim.claimToken, 'failed');
      } catch (claimError) {
        throw new AggregateError(
          [error, claimError],
          'Routing action-skill refresh failed and its plan claim could not be released',
        );
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

function readArg(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  const joined = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return joined?.slice(name.length + 1);
}

/**
 * A hard-killed apply (SIGKILL, power loss) never reaches its cleanup, so the
 * claim stays `active` and blocks every future plan for that release identity —
 * with no TTL, recovery previously meant undocumented SQL against the deployed
 * database. This releases exactly one stuck claim under the same owner gate as
 * `--apply`, and marks it `failed` rather than reopening it: an interrupted
 * apply consumes its digest, so the operator must inspect for the next
 * `planSequence`. It never touches a claim from a different release identity.
 */
export function releaseStaleRefreshPlanClaim(options: {
  dbPath: string;
  runtimeSha: string;
  artifactDigest: string;
  planDigest: string;
  ownerAuthorized: boolean;
}): Record<string, unknown> {
  if (!options.ownerAuthorized) {
    throw new Error('Releasing a stale plan claim requires NEXUS_RELEASE_OWNER_AUTHORIZED=1');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(options.planDigest)) {
    throw new Error('--ack-plan must be the exact sha256:<digest> of the stuck claim');
  }
  const db = new Database(options.dbPath);
  try {
    const claim = db.prepare(`
      SELECT plan_sequence AS planSequence, plan_digest AS planDigest, status
      FROM routing_manifest_skill_refresh_plan_claims
      WHERE runtime_sha = ? AND artifact_digest = ? AND status = 'active'
      LIMIT 1
    `).get(options.runtimeSha, options.artifactDigest) as
      { planSequence: number; planDigest: string; status: string } | undefined;
    if (!claim) throw new Error('No active plan claim exists for that exact release identity');
    if (claim.planDigest !== options.planDigest) {
      throw new Error('The acknowledged digest does not match the active plan claim');
    }
    db.prepare(`
      UPDATE routing_manifest_skill_refresh_plan_claims
      SET status = 'failed', claim_token = NULL
      WHERE runtime_sha = ? AND artifact_digest = ? AND plan_sequence = ? AND status = 'active'
    `).run(options.runtimeSha, options.artifactDigest, claim.planSequence);
    return {
      released: true,
      planSequence: claim.planSequence,
      planDigest: claim.planDigest,
      status: 'failed',
      note: 'Digest consumed. Re-run --inspect for the next planSequence and obtain fresh approval.',
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const inspect = process.argv.includes('--inspect');
  const apply = process.argv.includes('--apply');
  const releaseStale = process.argv.includes('--release-stale-claim');
  if (releaseStale) {
    if (inspect || apply) throw new Error('--release-stale-claim cannot combine with --inspect or --apply');
    console.log(JSON.stringify(releaseStaleRefreshPlanClaim({
      dbPath: readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db',
      runtimeSha: readArg('--runtime-sha') ?? '',
      artifactDigest: readArg('--artifact-digest') ?? '',
      planDigest: readArg('--ack-plan') ?? '',
      ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1',
    }), null, 2));
    return;
  }
  if (inspect === apply) throw new Error('Choose exactly one --inspect or --apply mode');

  const { config } = await import('../src/config');
  const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
  const promptPath = readArg('--prompt') ?? path.resolve('prompts/classifier-manifest.md');
  const runtimeSha = readArg('--runtime-sha') ?? '';
  const artifactDigest = readArg('--artifact-digest') ?? '';
  const limit = Number(readArg('--limit'));
  const budgetUsd = Number(readArg('--budget-usd'));
  const baseOptions = {
    dbPath,
    promptPath,
    runtimeSha,
    artifactDigest,
    model: config.gemini.classifierModel,
    limit,
    budgetUsd,
  };
  if (inspect) {
    console.log(JSON.stringify(inspectRoutingActionSkillCacheRefresh(baseOptions), null, 2));
    return;
  }
  const backupDir = readArg('--backup-dir');
  if (!backupDir) throw new Error('--apply requires --backup-dir=<owner-only-directory>');
  const result = await runRoutingActionSkillCacheRefresh({
    ...baseOptions,
    backupDir,
    ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1',
    acknowledgedPlanDigest: readArg('--ack-plan') ?? '',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    // Never print provider response bodies or raw prompts from this boundary.
    console.error(error instanceof Error ? error.message : 'Routing action-skill refresh failed');
    process.exitCode = 1;
  });
}
