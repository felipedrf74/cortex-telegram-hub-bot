// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import path from 'node:path';
import Database from 'better-sqlite3';
import { getProvider } from '../services/provider-registry';
import type { AIProvider } from '../services/ai-provider';
import { inspectContentScriptTerminalBatchDiagnostics } from '../services/content-script-terminal-batch-diagnostics';

function readRequiredArgument(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : '';
  if (!value) throw new Error(`content_script_terminal_batch_diagnostic_missing_${name.slice(2).replaceAll('-', '_')}`);
  return value;
}

async function readStdin(maxBytes = 4096): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error('content_script_terminal_batch_diagnostic_job_identity_invalid');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJobIdentities(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('content_script_terminal_batch_diagnostic_job_identity_invalid');
  }
  return parsed;
}

const SAFE_FAILURE_CODES = new Set([
  'content_script_terminal_batch_diagnostic_expected_count_invalid',
  'content_script_terminal_batch_diagnostic_since_invalid',
  'content_script_terminal_batch_diagnostic_job_identity_invalid',
  'content_script_terminal_batch_diagnostic_provider_unavailable',
  'content_script_terminal_batch_diagnostic_candidate_count_mismatch',
  'content_script_terminal_batch_diagnostic_status_mismatch',
  'content_script_terminal_batch_diagnostic_missing_expected_count',
  'content_script_terminal_batch_diagnostic_missing_since',
  'content_script_terminal_batch_diagnostic_provider_missing',
]);

function safeFailureCode(error: unknown): string {
  return error instanceof Error && SAFE_FAILURE_CODES.has(error.message)
    ? error.message
    : 'content_script_terminal_batch_diagnostic_failed';
}

function canonicalUtcTimestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new Error('content_script_terminal_batch_diagnostic_since_invalid');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('content_script_terminal_batch_diagnostic_since_invalid');
  }
  return parsed;
}

export async function runContentScriptTerminalBatchDiagnosticCli(input: {
  args?: string[];
  databasePath?: string;
  jobIdentitiesJson?: string;
  providerFactory?: () => AIProvider | null;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
} = {}): Promise<number> {
  const args = input.args ?? process.argv.slice(2);
  const writeStdout = input.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = input.writeStderr ?? ((value) => process.stderr.write(value));
  try {
    const expectedCount = Number(readRequiredArgument(args, '--expected-count'));
    const since = canonicalUtcTimestamp(readRequiredArgument(args, '--since'));
    const jobIds = parseJobIdentities(input.jobIdentitiesJson ?? await readStdin());
    const databasePath = path.resolve(
      input.databasePath ?? process.env.DATABASE_PATH ?? './data/bot.db',
    );
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const provider = (input.providerFactory ?? (() => getProvider('openai')))();
      if (!provider) throw new Error('content_script_terminal_batch_diagnostic_provider_missing');
      const result = await inspectContentScriptTerminalBatchDiagnostics({
        db,
        provider,
        expectedCount,
        jobIds,
        since,
      });
      writeStdout(`${JSON.stringify(result)}\n`);
      return 0;
    } finally {
      db.close();
    }
  } catch (error: unknown) {
    writeStderr(`${JSON.stringify({ ok: false, error: safeFailureCode(error) })}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runContentScriptTerminalBatchDiagnosticCli()
    .then((status) => { process.exitCode = status; });
}
