// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  CONTENT_LIVE_EVAL_ABSOLUTE_MAX_BUDGET_USD,
  CONTENT_LIVE_EVAL_CORPUS,
  CONTENT_LIVE_EVAL_MINIMUM_USABLE_BUDGET_USD,
  CONTENT_LIVE_EVAL_OPT_IN,
  type ContentLiveEvalScenario,
} from './content-live-evaluation-artifact';

export interface ContentLiveEvalRequestContext {
  runId: string;
  budgetUsd: number;
  scenario: ContentLiveEvalScenario;
}

function pathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function contentEvalRuntimeRoots(cwd: string, env: NodeJS.ProcessEnv): string[] {
  return [
    path.resolve(cwd, '.local', 'content-eval'),
    path.resolve('/tmp'),
    path.resolve('/private/tmp'),
    path.resolve(env.TMPDIR || '/tmp'),
  ].flatMap((root) => {
    try { return [fs.realpathSync(root)]; } catch { return []; }
  });
}

/**
 * Server-side defense in depth. The loopback opt-in headers are accepted only
 * when the process itself is connected to the disposable evaluator database
 * and authenticated as its sole synthetic `.invalid` user. This runs before
 * any Content memory/context/provider work.
 */
export function assertContentLiveEvalSyntheticRuntimeScope(input: {
  db: Database.Database;
  userId: number;
  tenantId: number;
  runId: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const fail = (): never => {
    throw new ContentLiveEvalRequestError(
      'CONTENT_LIVE_EVAL_INVALID',
      'Live Content evaluation requires its disposable synthetic database and account.',
      403,
    );
  };
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || input.tenantId !== input.userId) fail();
  try {
    const databaseRow = input.db.prepare('PRAGMA database_list').all()
      .find((row: any) => row.name === 'main') as { file?: string } | undefined;
    const lexicalDatabasePath = path.resolve(String(databaseRow?.file || ''));
    if (!fs.existsSync(lexicalDatabasePath)) fail();
    const stat = fs.lstatSync(lexicalDatabasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail();
    const databasePath = fs.realpathSync(lexicalDatabasePath);
    const roots = contentEvalRuntimeRoots(input.cwd ?? process.cwd(), input.env ?? process.env);
    if (
      !roots.some((root) => pathWithin(databasePath, root))
      || !/^content-live-eval-[a-z0-9._-]+\.db$/i.test(path.basename(databasePath))
      || /(?:^|[/_.-])(prod|production)(?:$|[/_.-])/i.test(databasePath)
    ) fail();

    const tableNames = new Set((input.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    if (!tableNames.has('users') || !tableNames.has('api_usage')) fail();
    const users = input.db.prepare(`
      SELECT id, lower(COALESCE(email, '')) AS email
        FROM users
    `).all() as Array<{ id: number; email: string }>;
    const syntheticUser = users.length === 1 ? users[0] : null;
    if (
      !syntheticUser
      || Number(syntheticUser.id) !== input.userId
      || !syntheticUser.email.endsWith('.invalid')
    ) fail();

    const scopedTables = [
      'content_knowledge', 'content_domain_objects', 'content_references',
      'content_topics', 'content_pipeline', 'content_artifacts', 'content_revisions',
    ];
    for (const table of scopedTables) {
      if (!tableNames.has(table)) continue;
      const row = input.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number };
      if (Number(row?.count ?? 0) !== 0) fail();
    }

    const foreignUsage = input.db.prepare(`
      SELECT COUNT(*) AS count
       FROM api_usage
       WHERE user_id <> ?
          OR COALESCE(request_source, '') <> 'interactive'
          OR COALESCE(base_category, '') <> 'content_live_eval'
          OR COALESCE(run_id, '') <> ?
    `).get(input.userId, input.runId) as { count?: number };
    if (Number(foreignUsage?.count ?? 0) !== 0) fail();
    if (tableNames.has('ai_provider_attempt_reservations')) {
      const foreignAttempts = input.db.prepare(`
        SELECT COUNT(*) AS count
         FROM ai_provider_attempt_reservations
         WHERE user_id <> ?
            OR COALESCE(request_source, '') <> 'interactive'
            OR COALESCE(base_category, '') <> 'content_live_eval'
            OR COALESCE(run_id, '') <> ?
      `).get(input.userId, input.runId) as { count?: number };
      if (Number(foreignAttempts?.count ?? 0) !== 0) fail();
    }
  } catch (error) {
    if (error instanceof ContentLiveEvalRequestError) throw error;
    fail();
  }
}

export class ContentLiveEvalRequestError extends Error {
  constructor(
    readonly code: 'CONTENT_LIVE_EVAL_DISABLED' | 'CONTENT_LIVE_EVAL_INVALID',
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
    this.name = 'ContentLiveEvalRequestError';
  }
}

type HeaderReader = (name: string) => string | undefined;

function normalizedHeader(readHeader: HeaderReader, name: string): string {
  return String(readHeader(name) || '').trim();
}

function hasAnyEvalHeader(readHeader: HeaderReader): boolean {
  return [
    'x-nexus-content-live-eval-opt-in',
    'x-nexus-content-live-eval-run-id',
    'x-nexus-content-live-eval-budget-usd',
    'x-nexus-content-live-eval-scenario-id',
  ].some((name) => normalizedHeader(readHeader, name).length > 0);
}

export function resolveContentLiveEvalRequest(input: {
  readHeader: HeaderReader;
  body: unknown;
  isLoopback: boolean;
  env?: NodeJS.ProcessEnv;
}): ContentLiveEvalRequestContext | null {
  const env = input.env ?? process.env;
  if (!hasAnyEvalHeader(input.readHeader)) return null;
  if (
    env.NODE_ENV === 'production'
    || env.NEXUS_CONTENT_LIVE_EVAL_RUNTIME !== '1'
    || env.CONTENT_LIVE_EVAL_ENABLED !== '1'
    || !input.isLoopback
  ) {
    throw new ContentLiveEvalRequestError(
      'CONTENT_LIVE_EVAL_DISABLED',
      'Live Content evaluation is available only in an explicitly enabled loopback non-production runtime.',
      403,
    );
  }

  const optIn = normalizedHeader(input.readHeader, 'x-nexus-content-live-eval-opt-in');
  const runId = normalizedHeader(input.readHeader, 'x-nexus-content-live-eval-run-id');
  const budgetUsd = Number(normalizedHeader(input.readHeader, 'x-nexus-content-live-eval-budget-usd'));
  const scenarioId = normalizedHeader(input.readHeader, 'x-nexus-content-live-eval-scenario-id');
  const scenario = CONTENT_LIVE_EVAL_CORPUS.find((entry) => entry.id === scenarioId);
  if (
    optIn !== CONTENT_LIVE_EVAL_OPT_IN
    || !/^content-live-eval-[a-zA-Z0-9._:-]{8,120}$/.test(runId)
    || !Number.isFinite(budgetUsd)
    || budgetUsd < CONTENT_LIVE_EVAL_MINIMUM_USABLE_BUDGET_USD
    || budgetUsd > CONTENT_LIVE_EVAL_ABSOLUTE_MAX_BUDGET_USD
    || !scenario
  ) {
    throw new ContentLiveEvalRequestError(
      'CONTENT_LIVE_EVAL_INVALID',
      'Live Content evaluation headers did not match the governed run, budget, and corpus contract.',
      400,
    );
  }

  const body = input.body && typeof input.body === 'object'
    ? input.body as Record<string, unknown>
    : {};
  const allowedBodyKeys = new Set([
    'topic', 'niche', 'format', 'targetDurationSeconds', 'language', 'mode',
    'renderMode', 'scriptStyle', 'forceRefresh', 'saveToIdeas',
  ]);
  const bodyMatchesScenario = body.topic === scenario.topic
    && body.niche === scenario.niche
    && body.format === scenario.format
    && body.targetDurationSeconds === scenario.targetDurationSeconds
    && body.language === scenario.language
    && body.mode === 'standard'
    && body.renderMode === 'structured'
    && body.scriptStyle === 'detailed'
    && body.forceRefresh === true
    && body.saveToIdeas === false
    && Object.keys(body).every((key) => allowedBodyKeys.has(key));
  if (!bodyMatchesScenario) {
    throw new ContentLiveEvalRequestError(
      'CONTENT_LIVE_EVAL_INVALID',
      'Live Content evaluation accepts only the fixed synthetic corpus and never persists generated content.',
      400,
    );
  }

  return { runId, budgetUsd, scenario };
}
