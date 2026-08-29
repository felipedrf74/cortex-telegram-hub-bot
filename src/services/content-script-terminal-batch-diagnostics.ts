// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import type { AIProvider } from './ai-provider';

export const CONTENT_SCRIPT_TERMINAL_BATCH_DIAGNOSTIC_SCHEMA =
  'nexus.content-script-terminal-batch-diagnostic.v1' as const;

export interface ContentScriptTerminalBatchDiagnostic {
  errorCode: string | null;
  errorLine: number | null;
  errorParam: string | null;
}

interface TerminalBatchCandidate {
  provider_batch_id: string;
}

const ACCEPTANCE_JOB_ID =
  /^script_job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const DIRECT_DIAGNOSTIC_PARAMS = new Set([
  'custom_id',
  'method',
  'url',
  'body',
  'body.model',
  'body.messages',
  'body.max_completion_tokens',
  'body.reasoning_effort',
  'body.response_format',
  'body.response_format.type',
  'body.response_format.json_schema',
  'body.response_format.json_schema.name',
  'body.response_format.json_schema.strict',
  'body.response_format.json_schema.schema',
  'body.service_tier',
  'model',
  'messages',
  'max_completion_tokens',
  'reasoning_effort',
  'response_format',
  'service_tier',
]);

function normalizedDiagnosticParam(value: string | undefined): string | null {
  if (!value) return null;
  if (DIRECT_DIAGNOSTIC_PARAMS.has(value)) return value;

  const messageField = /^(?:body\.)?messages(?:\[(?:0|[1-9]\d?)\]|\.(?:0|[1-9]\d?))\.(role|content|name)(?:\..*|\[.*\])?$/u
    .exec(value)?.[1];
  if (messageField) return `body.messages[].${messageField}`;

  if (/^(?:body\.)?response_format\.json_schema\.schema(?:\..*|\[.*\])$/u.test(value)) {
    return 'body.response_format.json_schema.schema';
  }
  return null;
}

export async function inspectContentScriptTerminalBatchDiagnostics(input: {
  db: Database.Database;
  provider: AIProvider;
  expectedCount: number;
  jobIds: string[];
  since: Date;
}): Promise<{
  schema: typeof CONTENT_SCRIPT_TERMINAL_BATCH_DIAGNOSTIC_SCHEMA;
  selected: number;
  diagnostics: ContentScriptTerminalBatchDiagnostic[];
}> {
  if (!Number.isSafeInteger(input.expectedCount)
      || input.expectedCount < 1 || input.expectedCount > 10) {
    throw new Error('content_script_terminal_batch_diagnostic_expected_count_invalid');
  }
  if (!Number.isFinite(input.since.getTime())) {
    throw new Error('content_script_terminal_batch_diagnostic_since_invalid');
  }
  if (input.jobIds.length !== input.expectedCount
      || new Set(input.jobIds).size !== input.expectedCount
      || input.jobIds.some((jobId) => !ACCEPTANCE_JOB_ID.test(jobId))) {
    throw new Error('content_script_terminal_batch_diagnostic_job_identity_invalid');
  }
  if (!input.provider.inspectStructuredGenerationBatch) {
    throw new Error('content_script_terminal_batch_diagnostic_provider_unavailable');
  }

  const jobPlaceholders = input.jobIds.map(() => '?').join(', ');
  const candidates = input.db.prepare(`WITH ranked AS (
      SELECT batch.provider_batch_id,
        batch.status AS batch_status,
        batch.last_error_code AS batch_error_code,
        ROW_NUMBER() OVER (
          PARTITION BY batch.job_id
          ORDER BY julianday(COALESCE(batch.completed_at, batch.updated_at)) DESC,
            batch.stage_key DESC
        ) AS recency_rank
      FROM content_script_provider_batches AS batch
      JOIN content_script_jobs AS job ON job.job_id = batch.job_id
        AND job.tenant_id = batch.tenant_id
        AND job.owner_user_id = batch.owner_user_id
      WHERE job.status = 'failed'
        AND job.last_error_code = 'OPENAI_BATCH_FAILED'
        AND job.job_id IN (${jobPlaceholders})
        AND julianday(COALESCE(job.completed_at, job.updated_at)) >= julianday(?)
    )
    SELECT provider_batch_id
    FROM ranked
    WHERE recency_rank = 1
      AND batch_status = 'failed'
      AND batch_error_code = 'invalid_request'
      AND provider_batch_id IS NOT NULL
    ORDER BY provider_batch_id`).all(...input.jobIds, input.since.toISOString()) as TerminalBatchCandidate[];

  if (candidates.length !== input.expectedCount) {
    throw new Error('content_script_terminal_batch_diagnostic_candidate_count_mismatch');
  }

  const diagnostics: ContentScriptTerminalBatchDiagnostic[] = [];
  for (const candidate of candidates) {
    const result = await input.provider.inspectStructuredGenerationBatch({
      providerBatchId: candidate.provider_batch_id,
    });
    if (result.status !== 'failed') {
      throw new Error('content_script_terminal_batch_diagnostic_status_mismatch');
    }
    diagnostics.push({
      errorCode: result.errorCode === 'invalid_request' ? 'invalid_request' : null,
      errorLine: result.errorLine === 1 ? 1 : null,
      errorParam: normalizedDiagnosticParam(result.errorParam),
    });
  }

  return {
    schema: CONTENT_SCRIPT_TERMINAL_BATCH_DIAGNOSTIC_SCHEMA,
    selected: candidates.length,
    diagnostics,
  };
}
