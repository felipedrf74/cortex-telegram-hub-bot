// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import type { AuditAction } from './audit-trail';
import {
  CONTENT_SCRIPT_JOB_PRUNED_SCHEMA,
  contentScriptJobPrunedTombstone,
} from './content-script-job-encryption';

export const CONTENT_SCRIPT_JOB_RETENTION_DAYS = 30;
export const SKILL_INFERENCE_TELEMETRY_RETENTION_DAYS = 90;
export const SECURITY_ADMIN_AUDIT_RETENTION_MONTHS = 12;
export const LOCAL_INFERENCE_SAFETY_INCIDENT_RETENTION_DAYS = 365;

/** Fail-closed allowlist for the generic security/admin retention class. */
export const SECURITY_ADMIN_AUDIT_RETENTION_ACTIONS = [
  'create', 'update', 'export', 'delete', 'access', 'mutation_scope',
  'encrypt', 'decrypt', 'admin_mutation',
] as const satisfies readonly AuditAction[];

/** Statutory fiscal/billing evidence is governed separately and never pruned here. */
export const STATUTORY_BILLING_AUDIT_ACTIONS = [
  'billing.nexus_points.checkout_started', 'nexus_points.transfer',
  'nexus_points.cutover', 'fiscal_profile_update', 'fiscal_bundle_send',
  'invoice_vendor_create', 'invoice_vendor_disable', 'invoice_scan_on_demand',
  'invoice_scraper_mfa_reply', 'ai_credit_admin_grant',
] as const satisfies readonly AuditAction[];

/** Legal-proof actions are not ordinary security/admin telemetry. */
export const LEGAL_PROOF_AUDIT_ACTIONS = [
  'privacy_consent',
] as const satisfies readonly AuditAction[];

/** Generic actions on these resources still carry billing or legal proof. */
export const GENERIC_AUDIT_RETENTION_EXCLUDED_RESOURCE_GLOBS = [
  'account', 'account.*', 'billing.*', 'fiscal*', 'invoice_*',
  'nexus_points*', 'ai_credit*',
] as const;

const CONTENT_SCRIPT_TERMINAL = ['completed', 'failed', 'cancelled'] as const;
const INFERENCE_TERMINAL = ['completed', 'failed', 'cancelled'] as const;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES = 100;

export interface RetentionBacklog {
  eligible: number;
  oldestEligibleAt: string | null;
  oldestEligibleAgeDays: number | null;
}

export interface RetentionDrain<T> {
  pruned: T;
  pages: number;
  backlog: RetentionBacklog;
}

function cutoff(now: Date, days: number): string {
  if (!Number.isFinite(now.getTime())) throw new Error('retention_now_invalid');
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Subtract whole UTC calendar months, clamping month-end dates explicitly. */
function calendarMonthCutoff(now: Date, months: number): string {
  if (!Number.isFinite(now.getTime())) throw new Error('retention_now_invalid');
  if (!Number.isSafeInteger(months) || months <= 0) throw new Error('retention_months_invalid');
  const targetMonthStart = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - months,
    1,
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
  const targetMonthEnd = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  targetMonthStart.setUTCDate(Math.min(now.getUTCDate(), targetMonthEnd));
  return targetMonthStart.toISOString();
}

function limit(value?: number): number {
  const result = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('retention_limit_invalid');
  return Math.min(result, MAX_LIMIT);
}

function maxPages(value?: number): number {
  const result = value ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('retention_max_pages_invalid');
  return Math.min(result, MAX_PAGES);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function backlog(
  row: { eligible: number; oldest: string | null; oldest_jd: number | null },
  now: Date,
): RetentionBacklog {
  if (!row.oldest || row.oldest_jd === null) {
    return { eligible: row.eligible, oldestEligibleAt: null, oldestEligibleAgeDays: null };
  }
  const oldestMs = Math.round((row.oldest_jd - 2_440_587.5) * 86_400_000);
  const oldestEligibleAgeDays = Number.isFinite(oldestMs)
    ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 86_400_000))
    : null;
  return { eligible: row.eligible, oldestEligibleAt: row.oldest, oldestEligibleAgeDays };
}

function scriptEligibility(alias: string): string {
  return `${alias}.status IN (${CONTENT_SCRIPT_TERMINAL.map((value) => `'${value}'`).join(', ')})
    AND julianday(COALESCE(${alias}.completed_at, ${alias}.updated_at)) < julianday(?)
    AND COALESCE(json_extract(${alias}.request_json, '$.schema'), '') != ?
    AND NOT EXISTS (
      SELECT 1 FROM content_script_provider_batches AS batch
      WHERE batch.job_id = ${alias}.job_id
        AND batch.provider_files_deleted_at IS NULL
        AND (batch.provider_batch_id IS NOT NULL OR batch.input_file_id IS NOT NULL
          OR batch.output_file_id IS NOT NULL OR batch.error_file_id IS NOT NULL
          OR batch.input_file_intent_filename IS NOT NULL
          OR batch.batch_create_intent_at IS NOT NULL)
    )`;
}

function scriptArgs(scriptCutoff: string): unknown[] {
  return [scriptCutoff, CONTENT_SCRIPT_JOB_PRUNED_SCHEMA];
}

function pruneScriptPage(db: Database.Database, now: Date, pageLimit: number) {
  const scriptCutoff = cutoff(now, CONTENT_SCRIPT_JOB_RETENTION_DAYS);
  // Candidate selection is read-only. The writer lock below covers only this
  // page's revalidation and atomic checkpoint/parent mutation.
  const candidates = db.prepare(`SELECT job.job_id FROM content_script_jobs AS job
    WHERE ${scriptEligibility('job')}
    ORDER BY julianday(COALESCE(job.completed_at, job.updated_at)), job.job_id LIMIT ?`)
    .all(...scriptArgs(scriptCutoff), pageLimit) as Array<{ job_id: string }>;
  if (candidates.length === 0) return { jobsPruned: 0, checkpoints: 0, selected: 0 };
  const candidateIds = candidates.map((row) => row.job_id);
  const result = db.transaction(() => {
    const candidateList = placeholders(candidateIds.length);
    const eligible = db.prepare(`SELECT job.job_id FROM content_script_jobs AS job
      WHERE job.job_id IN (${candidateList}) AND ${scriptEligibility('job')}`)
      .all(...candidateIds, ...scriptArgs(scriptCutoff)) as Array<{ job_id: string }>;
    if (eligible.length === 0) return { jobsPruned: 0, checkpoints: 0 };
    const jobIds = eligible.map((row) => row.job_id);
    const jobList = placeholders(jobIds.length);
    const checkpoints = db.prepare(`DELETE FROM content_script_job_checkpoints
      WHERE job_id IN (${jobList})`).run(...jobIds).changes;
    const tombstone = contentScriptJobPrunedTombstone(now);
    const jobsPruned = db.prepare(`UPDATE content_script_jobs
      SET request_json = ?, result_json = CASE WHEN result_json IS NULL THEN NULL ELSE ? END,
        warning_codes_json = CASE WHEN EXISTS (
          SELECT 1 FROM json_each(content_script_jobs.warning_codes_json)
          WHERE value = 'content_script_private_material_expired'
        ) THEN warning_codes_json
        ELSE json_insert(warning_codes_json, '$[#]', 'content_script_private_material_expired') END
      WHERE job_id IN (${jobList}) AND ${scriptEligibility('content_script_jobs')}`)
      .run(tombstone, tombstone, ...jobIds, ...scriptArgs(scriptCutoff)).changes;
    if (jobsPruned !== jobIds.length) throw new Error('content_script_retention_parent_changed');
    return { jobsPruned, checkpoints };
  }).immediate();
  return { ...result, selected: candidates.length };
}

function scriptBacklog(db: Database.Database, now: Date): RetentionBacklog {
  const scriptCutoff = cutoff(now, CONTENT_SCRIPT_JOB_RETENTION_DAYS);
  const row = db.prepare(`SELECT COUNT(*) AS eligible,
      MIN(julianday(COALESCE(job.completed_at, job.updated_at))) AS oldest_jd,
      strftime('%Y-%m-%dT%H:%M:%fZ',
        MIN(julianday(COALESCE(job.completed_at, job.updated_at)))) AS oldest
    FROM content_script_jobs AS job WHERE ${scriptEligibility('job')}`)
    .get(...scriptArgs(scriptCutoff)) as {
      eligible: number; oldest: string | null; oldest_jd: number | null;
    };
  return backlog(row, now);
}

export function pruneExpiredContentScriptJobPrivateMaterial(
  db: Database.Database,
  input: { now?: Date; limit?: number } = {},
): { jobsPruned: number; checkpoints: number } {
  const page = pruneScriptPage(db, input.now ?? new Date(), limit(input.limit));
  return { jobsPruned: page.jobsPruned, checkpoints: page.checkpoints };
}

export function drainExpiredContentScriptJobPrivateMaterial(
  db: Database.Database,
  input: { now?: Date; limit?: number; maxPages?: number } = {},
): RetentionDrain<{ jobsPruned: number; checkpoints: number }> {
  const now = input.now ?? new Date();
  const pageLimit = limit(input.limit);
  const pageCap = maxPages(input.maxPages);
  let jobsPruned = 0;
  let checkpoints = 0;
  let pages = 0;
  while (pages < pageCap) {
    const page = pruneScriptPage(db, now, pageLimit);
    if (page.selected === 0) break;
    pages += 1;
    jobsPruned += page.jobsPruned;
    checkpoints += page.checkpoints;
    if (page.selected < pageLimit) break;
  }
  return { pruned: { jobsPruned, checkpoints }, pages, backlog: scriptBacklog(db, now) };
}

function inferenceEligibility(alias: string): string {
  return `${alias}.status IN (${INFERENCE_TERMINAL.map((value) => `'${value}'`).join(', ')})
    AND julianday(COALESCE(${alias}.completed_at, ${alias}.updated_at, ${alias}.created_at)) < julianday(?)`;
}

function pruneInferencePage(db: Database.Database, now: Date, pageLimit: number) {
  const inferenceCutoff = cutoff(now, SKILL_INFERENCE_TELEMETRY_RETENTION_DAYS);
  const candidates = db.prepare(`SELECT run_id FROM skill_inference_runs
    WHERE ${inferenceEligibility('skill_inference_runs')}
    ORDER BY julianday(COALESCE(completed_at, updated_at, created_at)), run_id LIMIT ?`)
    .all(inferenceCutoff, pageLimit) as Array<{ run_id: string }>;
  if (candidates.length === 0) return { runs: 0, attempts: 0, selected: 0 };
  const candidateIds = candidates.map((row) => row.run_id);
  const result = db.transaction(() => {
    const candidateList = placeholders(candidateIds.length);
    const eligible = db.prepare(`SELECT run_id FROM skill_inference_runs
      WHERE run_id IN (${candidateList}) AND ${inferenceEligibility('skill_inference_runs')}`)
      .all(...candidateIds, inferenceCutoff) as Array<{ run_id: string }>;
    if (eligible.length === 0) return { runs: 0, attempts: 0 };
    const runIds = eligible.map((row) => row.run_id);
    const runList = placeholders(runIds.length);
    const attempts = db.prepare(`DELETE FROM skill_inference_attempts
      WHERE run_id IN (${runList})`).run(...runIds).changes;
    const runs = db.prepare(`DELETE FROM skill_inference_runs WHERE run_id IN (${runList})
      AND ${inferenceEligibility('skill_inference_runs')}`)
      .run(...runIds, inferenceCutoff).changes;
    if (runs !== runIds.length) throw new Error('skill_inference_retention_parent_changed');
    return { runs, attempts };
  }).immediate();
  return { ...result, selected: candidates.length };
}

export function pruneExpiredSkillInferenceTelemetry(
  db: Database.Database,
  input: { now?: Date; limit?: number } = {},
): { runs: number; attempts: number } {
  const page = pruneInferencePage(db, input.now ?? new Date(), limit(input.limit));
  return { runs: page.runs, attempts: page.attempts };
}

export function drainExpiredSkillInferenceTelemetry(
  db: Database.Database,
  input: { now?: Date; limit?: number; maxPages?: number } = {},
): RetentionDrain<{ runs: number; attempts: number }> {
  const now = input.now ?? new Date();
  const pageLimit = limit(input.limit);
  const pageCap = maxPages(input.maxPages);
  let runs = 0;
  let attempts = 0;
  let pages = 0;
  while (pages < pageCap) {
    const page = pruneInferencePage(db, now, pageLimit);
    if (page.selected === 0) break;
    pages += 1;
    runs += page.runs;
    attempts += page.attempts;
    if (page.selected < pageLimit) break;
  }
  const inferenceCutoff = cutoff(now, SKILL_INFERENCE_TELEMETRY_RETENTION_DAYS);
  const row = db.prepare(`SELECT COUNT(*) AS eligible,
      MIN(julianday(COALESCE(completed_at, updated_at, created_at))) AS oldest_jd,
      strftime('%Y-%m-%dT%H:%M:%fZ',
        MIN(julianday(COALESCE(completed_at, updated_at, created_at)))) AS oldest
    FROM skill_inference_runs WHERE ${inferenceEligibility('skill_inference_runs')}`)
    .get(inferenceCutoff) as {
      eligible: number; oldest: string | null; oldest_jd: number | null;
    };
  return {
    pruned: { runs, attempts }, pages,
    backlog: backlog(row, now),
  };
}

function auditActions(): string {
  return SECURITY_ADMIN_AUDIT_RETENTION_ACTIONS.map((value) => `'${value}'`).join(', ');
}

function genericAuditResourceExclusion(): string {
  return GENERIC_AUDIT_RETENTION_EXCLUDED_RESOURCE_GLOBS
    .map(() => 'resource NOT GLOB ?').join(' AND ');
}

function pruneAuditPage(db: Database.Database, now: Date, pageLimit: number) {
  const auditCutoff = calendarMonthCutoff(now, SECURITY_ADMIN_AUDIT_RETENTION_MONTHS);
  const rows = db.prepare(`SELECT id FROM audit_trail
    WHERE action IN (${auditActions()})
      AND ${genericAuditResourceExclusion()}
      AND julianday(ts) < julianday(?)
    ORDER BY julianday(ts), id LIMIT ?`)
    .all(
      ...GENERIC_AUDIT_RETENTION_EXCLUDED_RESOURCE_GLOBS,
      auditCutoff,
      pageLimit,
    ) as Array<{ id: number }>;
  if (rows.length === 0) return { deleted: 0, selected: 0 };
  const ids = rows.map((row) => row.id);
  const deleted = db.prepare(`DELETE FROM audit_trail WHERE id IN (${placeholders(ids.length)})
    AND action IN (${auditActions()})
    AND ${genericAuditResourceExclusion()}
    AND julianday(ts) < julianday(?)`)
    .run(
      ...ids,
      ...GENERIC_AUDIT_RETENTION_EXCLUDED_RESOURCE_GLOBS,
      auditCutoff,
    ).changes;
  return { deleted, selected: rows.length };
}

/** One-page entrypoint for the governed security/admin audit subset. */
export function pruneExpiredSecurityAdminAuditTrail(
  db: Database.Database,
  input: { now?: Date; limit?: number } = {},
): number {
  return pruneAuditPage(db, input.now ?? new Date(), limit(input.limit)).deleted;
}

export function drainExpiredSecurityAdminAuditTrail(
  db: Database.Database,
  input: { now?: Date; limit?: number; maxPages?: number } = {},
): RetentionDrain<{ deleted: number }> {
  const now = input.now ?? new Date();
  const pageLimit = limit(input.limit);
  const pageCap = maxPages(input.maxPages);
  let deleted = 0;
  let pages = 0;
  while (pages < pageCap) {
    const page = pruneAuditPage(db, now, pageLimit);
    if (page.selected === 0) break;
    pages += 1;
    deleted += page.deleted;
    if (page.selected < pageLimit) break;
  }
  const auditCutoff = calendarMonthCutoff(now, SECURITY_ADMIN_AUDIT_RETENTION_MONTHS);
  const row = db.prepare(`SELECT COUNT(*) AS eligible,
      MIN(julianday(ts)) AS oldest_jd,
      strftime('%Y-%m-%dT%H:%M:%fZ', MIN(julianday(ts))) AS oldest
    FROM audit_trail
    WHERE action IN (${auditActions()})
      AND ${genericAuditResourceExclusion()}
      AND julianday(ts) < julianday(?)`)
    .get(
      ...GENERIC_AUDIT_RETENTION_EXCLUDED_RESOURCE_GLOBS,
      auditCutoff,
    ) as {
      eligible: number; oldest: string | null; oldest_jd: number | null;
    };
  return {
    pruned: { deleted }, pages,
    backlog: backlog(row, now),
  };
}

function pruneSafetyPage(db: Database.Database, now: Date, pageLimit: number) {
  const safetyCutoff = cutoff(now, LOCAL_INFERENCE_SAFETY_INCIDENT_RETENTION_DAYS);
  const rows = db.prepare(`SELECT id FROM local_inference_safety_incidents
    WHERE julianday(created_at) < julianday(?)
    ORDER BY julianday(created_at), id LIMIT ?`)
    .all(safetyCutoff, pageLimit) as Array<{ id: number }>;
  if (rows.length === 0) return { deleted: 0, selected: 0 };
  const ids = rows.map((row) => row.id);
  const deleted = db.prepare(`DELETE FROM local_inference_safety_incidents
    WHERE id IN (${placeholders(ids.length)}) AND julianday(created_at) < julianday(?)`)
    .run(...ids, safetyCutoff).changes;
  return { deleted, selected: rows.length };
}

export function pruneExpiredLocalInferenceSafetyIncidents(
  db: Database.Database,
  input: { now?: Date; limit?: number } = {},
): number {
  return pruneSafetyPage(db, input.now ?? new Date(), limit(input.limit)).deleted;
}

export function drainExpiredLocalInferenceSafetyIncidents(
  db: Database.Database,
  input: { now?: Date; limit?: number; maxPages?: number } = {},
): RetentionDrain<{ deleted: number }> {
  const now = input.now ?? new Date();
  const pageLimit = limit(input.limit);
  const pageCap = maxPages(input.maxPages);
  let deleted = 0;
  let pages = 0;
  while (pages < pageCap) {
    const page = pruneSafetyPage(db, now, pageLimit);
    if (page.selected === 0) break;
    pages += 1;
    deleted += page.deleted;
    if (page.selected < pageLimit) break;
  }
  const safetyCutoff = cutoff(now, LOCAL_INFERENCE_SAFETY_INCIDENT_RETENTION_DAYS);
  const row = db.prepare(`SELECT COUNT(*) AS eligible,
      MIN(julianday(created_at)) AS oldest_jd,
      strftime('%Y-%m-%dT%H:%M:%fZ', MIN(julianday(created_at))) AS oldest
    FROM local_inference_safety_incidents WHERE julianday(created_at) < julianday(?)`)
    .get(safetyCutoff) as {
      eligible: number; oldest: string | null; oldest_jd: number | null;
    };
  return {
    pruned: { deleted }, pages,
    backlog: backlog(row, now),
  };
}
