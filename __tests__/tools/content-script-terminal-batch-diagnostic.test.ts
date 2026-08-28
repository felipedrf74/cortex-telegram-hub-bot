import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '../../src/services/ai-provider';
import { runContentScriptTerminalBatchDiagnosticCli } from '../../src/tools/content-script-terminal-batch-diagnostic';

const JOB_ID = 'script_job_00000000-0000-4000-8000-00000000000a';
const temporaryDirectories: string[] = [];

function databaseFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'nexus-terminal-batch-diagnostic-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'bot.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE content_script_jobs (
      job_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_error_code TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE content_script_provider_batches (
      job_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      stage_key TEXT NOT NULL,
      provider_batch_id TEXT,
      status TEXT NOT NULL,
      last_error_code TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO content_script_jobs
      (job_id, tenant_id, owner_user_id, status, last_error_code, completed_at, updated_at)
      VALUES ('${JOB_ID}', 42, 42, 'failed', 'OPENAI_BATCH_FAILED',
        '2026-08-28T16:00:00.000Z', '2026-08-28T16:00:00.000Z');
    INSERT INTO content_script_provider_batches
      (job_id, tenant_id, owner_user_id, stage_key, provider_batch_id, status,
       last_error_code, completed_at, updated_at)
      VALUES ('${JOB_ID}', 42, 42, '${'a'.repeat(64)}', 'batch_private_identity',
        'failed', 'invalid_request', '2026-08-28T16:00:00.000Z',
        '2026-08-28T16:00:00.000Z');`);
  db.close();
  return file;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('content-script terminal Batch diagnostic CLI', () => {
  it('keeps the database unchanged and emits no job or provider identity', async () => {
    const file = databaseFile();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const inspect = vi.fn().mockResolvedValue({
      status: 'failed',
      errorCode: 'invalid_request',
      errorLine: 1,
      errorParam: 'body.messages[0].role',
    });

    const status = await runContentScriptTerminalBatchDiagnosticCli({
      args: ['--expected-count', '1', '--since', '2026-08-28T00:00:00.000Z'],
      databasePath: file,
      jobIdentitiesJson: JSON.stringify([JOB_ID]),
      providerFactory: () => ({ inspectStructuredGenerationBatch: inspect } as unknown as AIProvider),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });

    expect(status).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toEqual({
      schema: 'nexus.content-script-terminal-batch-diagnostic.v1',
      selected: 1,
      diagnostics: [{
        errorCode: 'invalid_request',
        errorLine: 1,
        errorParam: 'body.messages[].role',
      }],
    });
    expect(stdout.join('')).not.toContain('script_job_');
    expect(stdout.join('')).not.toContain('batch_private_identity');

    const db = new Database(file, { readonly: true, fileMustExist: true });
    expect(db.prepare('SELECT status, last_error_code FROM content_script_jobs').get()).toEqual({
      status: 'failed',
      last_error_code: 'OPENAI_BATCH_FAILED',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_script_provider_batches').get()).toEqual({ count: 1 });
    db.close();
  });

  it('replaces unknown provider failures with a fixed content-free stderr code', async () => {
    const file = databaseFile();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = await runContentScriptTerminalBatchDiagnosticCli({
      args: ['--expected-count', '1', '--since', '2026-08-28T00:00:00.000Z'],
      databasePath: file,
      jobIdentitiesJson: JSON.stringify([JOB_ID]),
      providerFactory: () => ({
        inspectStructuredGenerationBatch: vi.fn().mockRejectedValue(
          new Error('content_script_terminal_batch_diagnostic_batch_private_identity'),
        ),
      } as unknown as AIProvider),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });

    expect(status).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([`${JSON.stringify({
      ok: false,
      error: 'content_script_terminal_batch_diagnostic_failed',
    })}\n`]);
    expect(stderr.join('')).not.toContain('private');
  });

  it('rejects a noncanonical recency timestamp before provider inspection', async () => {
    const file = databaseFile();
    const stderr: string[] = [];
    const providerFactory = vi.fn();
    const status = await runContentScriptTerminalBatchDiagnosticCli({
      args: ['--expected-count', '1', '--since', '2026-08-28'],
      databasePath: file,
      jobIdentitiesJson: JSON.stringify([JOB_ID]),
      providerFactory,
      writeStdout: vi.fn(),
      writeStderr: (value) => stderr.push(value),
    });

    expect(status).toBe(1);
    expect(providerFactory).not.toHaveBeenCalled();
    expect(stderr).toEqual([`${JSON.stringify({
      ok: false,
      error: 'content_script_terminal_batch_diagnostic_since_invalid',
    })}\n`]);
  });

  it('keeps a real SDK debug session silent outside the content-free JSON result', async () => {
    const file = databaseFile();
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'batch_private_identity',
        object: 'batch',
        endpoint: '/v1/chat/completions',
        status: 'failed',
        errors: {
          object: 'list',
          data: [{
            code: 'invalid_request',
            line: 1,
            param: 'body.messages[0].role',
            message: 'private provider validation message',
          }],
        },
      }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      path.join(process.cwd(), 'src/tools/content-script-terminal-batch-diagnostic.ts'),
      '--expected-count', '1',
      '--since', '2026-08-28T00:00:00.000Z',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_PATH: file,
        OPENAI_API_KEY: 'sk-local-test-only',
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_LOG: 'debug',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(JSON.stringify([JOB_ID]));
    const [exitCode] = await once(child, 'close') as [number];
    server.close();
    await once(server, 'close');

    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const stderrText = Buffer.concat(stderr).toString('utf8');
    expect(exitCode).toBe(0);
    expect(requests).toEqual(['/v1/batches/batch_private_identity']);
    expect(stderrText).toBe('');
    expect(JSON.parse(stdoutText)).toEqual({
      schema: 'nexus.content-script-terminal-batch-diagnostic.v1',
      selected: 1,
      diagnostics: [{
        errorCode: 'invalid_request',
        errorLine: 1,
        errorParam: 'body.messages[].role',
      }],
    });
    expect(`${stdoutText}${stderrText}`).not.toContain('batch_private_identity');
    expect(`${stdoutText}${stderrText}`).not.toContain('private provider validation message');
  });

  it('keeps real SDK HTTP-error logging content-free under debug logging', async () => {
    const file = databaseFile();
    const server = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_request',
          message: 'private provider HTTP error batch_private_identity',
        },
      }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      path.join(process.cwd(), 'src/tools/content-script-terminal-batch-diagnostic.ts'),
      '--expected-count', '1',
      '--since', '2026-08-28T00:00:00.000Z',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_PATH: file,
        OPENAI_API_KEY: 'sk-local-test-only',
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_LOG: 'debug',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(JSON.stringify([JOB_ID]));
    const [exitCode] = await once(child, 'close') as [number];
    server.close();
    await once(server, 'close');

    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const stderrText = Buffer.concat(stderr).toString('utf8');
    expect(exitCode).toBe(1);
    expect(stdoutText).toBe('');
    expect(stderrText).toBe(`${JSON.stringify({
      ok: false,
      error: 'content_script_terminal_batch_diagnostic_failed',
    })}\n`);
    expect(stderrText).not.toContain('batch_private_identity');
    expect(stderrText).not.toContain('private provider HTTP error');
  });
});
