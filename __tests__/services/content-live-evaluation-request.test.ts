import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CONTENT_LIVE_EVAL_CORPUS,
  CONTENT_LIVE_EVAL_OPT_IN,
} from '../../src/services/content-live-evaluation-artifact';
import {
  assertContentLiveEvalSyntheticRuntimeScope,
  ContentLiveEvalRequestError,
  resolveContentLiveEvalRequest,
} from '../../src/services/content-live-evaluation-request';

const scenario = CONTENT_LIVE_EVAL_CORPUS[0];

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: scenario.topic,
    niche: scenario.niche,
    format: scenario.format,
    targetDurationSeconds: scenario.targetDurationSeconds,
    language: scenario.language,
    mode: 'standard',
    renderMode: 'structured',
    scriptStyle: 'detailed',
    forceRefresh: true,
    saveToIdeas: false,
    ...overrides,
  };
}

function headers(overrides: Record<string, string> = {}): (name: string) => string | undefined {
  const values: Record<string, string> = {
    'x-nexus-content-live-eval-opt-in': CONTENT_LIVE_EVAL_OPT_IN,
    'x-nexus-content-live-eval-run-id': 'content-live-eval-request-20260719',
    'x-nexus-content-live-eval-budget-usd': '1.00',
    'x-nexus-content-live-eval-scenario-id': scenario.id,
    ...overrides,
  };
  return (name) => values[name.toLowerCase()];
}

const enabledEnv = {
  NODE_ENV: 'test',
  NEXUS_CONTENT_LIVE_EVAL_RUNTIME: '1',
  CONTENT_LIVE_EVAL_ENABLED: '1',
} as NodeJS.ProcessEnv;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe('Content live-evaluation request boundary', () => {
  it('accepts only the exact fixed synthetic request on enabled loopback', () => {
    expect(resolveContentLiveEvalRequest({
      readHeader: headers(),
      body: body(),
      isLoopback: true,
      env: enabledEnv,
    })).toMatchObject({ scenario: { id: scenario.id }, budgetUsd: 1 });
  });

  it('rejects missing opt-in, production, remote, and non-fixed payloads', () => {
    const attempts = [
      () => resolveContentLiveEvalRequest({ readHeader: headers({ 'x-nexus-content-live-eval-opt-in': '' }), body: body(), isLoopback: true, env: enabledEnv }),
      () => resolveContentLiveEvalRequest({ readHeader: headers(), body: body(), isLoopback: true, env: { ...enabledEnv, NODE_ENV: 'production' } }),
      () => resolveContentLiveEvalRequest({ readHeader: headers(), body: body(), isLoopback: true, env: { ...enabledEnv, NEXUS_CONTENT_LIVE_EVAL_RUNTIME: '0' } }),
      () => resolveContentLiveEvalRequest({ readHeader: headers(), body: body(), isLoopback: false, env: enabledEnv }),
      () => resolveContentLiveEvalRequest({ readHeader: headers(), body: body({ topic: 'operator supplied topic' }), isLoopback: true, env: enabledEnv }),
      () => resolveContentLiveEvalRequest({ readHeader: headers(), body: body({ extraContext: 'private content' }), isLoopback: true, env: enabledEnv }),
      () => resolveContentLiveEvalRequest({ readHeader: headers(), body: body({ saveToIdeas: true }), isLoopback: true, env: enabledEnv }),
    ];

    for (const attempt of attempts) expect(attempt).toThrow(ContentLiveEvalRequestError);
  });

  it('does not activate when no evaluation header is present', () => {
    expect(resolveContentLiveEvalRequest({
      readHeader: () => undefined,
      body: { topic: 'normal user topic' },
      isLoopback: false,
      env: { NODE_ENV: 'production' },
    })).toBeNull();
  });

  it('accepts only the sole .invalid user in a content-empty disposable database', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'content-live-eval-server-scope-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'content-live-eval-server-test.db');
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        request_source TEXT,
        base_category TEXT,
        run_id TEXT
      );
      CREATE TABLE content_domain_objects (id INTEGER PRIMARY KEY);
      INSERT INTO users (id, email) VALUES (44, 'content-live-eval@synthetic.invalid');
    `);
    const input = {
      db,
      userId: 44,
      tenantId: 44,
      runId: 'content-live-eval-server-20260719',
      cwd: directory,
      env: { TMPDIR: directory } as NodeJS.ProcessEnv,
    };

    expect(() => assertContentLiveEvalSyntheticRuntimeScope(input)).not.toThrow();
    db.prepare('INSERT INTO content_domain_objects (id) VALUES (1)').run();
    expect(() => assertContentLiveEvalSyntheticRuntimeScope(input)).toThrowError(ContentLiveEvalRequestError);
    db.close();
  });

  it('rejects real-looking accounts and unrelated prior usage in the evaluator database', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'content-live-eval-server-negative-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'content-live-eval-server-negative.db');
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        request_source TEXT,
        base_category TEXT,
        run_id TEXT
      );
      INSERT INTO users (id, email) VALUES (45, 'real-user@example.com');
    `);
    const input = {
      db,
      userId: 45,
      tenantId: 45,
      runId: 'content-live-eval-server-negative-20260719',
      cwd: directory,
      env: { TMPDIR: directory } as NodeJS.ProcessEnv,
    };

    expect(() => assertContentLiveEvalSyntheticRuntimeScope(input)).toThrowError(ContentLiveEvalRequestError);
    db.prepare("UPDATE users SET email = 'content-live-eval@synthetic.invalid' WHERE id = 45").run();
    db.prepare(`
      INSERT INTO api_usage (id, user_id, request_source, base_category, run_id)
      VALUES (1, 45, 'interactive', 'chat_secretary', 'unrelated-run')
    `).run();
    expect(() => assertContentLiveEvalSyntheticRuntimeScope(input)).toThrowError(ContentLiveEvalRequestError);
    db.close();
  });
});
