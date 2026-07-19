// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CONTENT_QUALITY_RUBRIC } from '../src/services/content-day-to-day-evaluation';
import {
  bindContentLiveEvalInvocation,
  CONTENT_LIVE_EVAL_ABSOLUTE_MAX_BUDGET_USD,
  CONTENT_LIVE_EVAL_CORPUS,
  CONTENT_LIVE_EVAL_HARD_MAX_USD_PER_SAMPLE,
  CONTENT_LIVE_EVAL_MINIMUM_USABLE_BUDGET_USD,
  CONTENT_LIVE_EVAL_OPT_IN,
  CONTENT_LIVE_EVAL_ROUTING_PATH,
  contentLiveEvalModelResolutionAllowed,
  contentEvalSha256,
  createContentLiveEvaluationArtifact,
  readContentLiveEvalAttestationKeyFile,
  resolveContentLiveEvalSourceIdentity,
  validateContentLiveEvaluationArtifact,
  type ContentLiveEvalProviderInvocation,
  type ContentLiveEvalScenario,
} from '../src/services/content-live-evaluation-artifact';

export interface ContentLiveEvalCliOptions {
  optIn: string;
  budgetUsd: number;
  baseUrl: string;
  authFile: string;
  databasePath: string;
  outputPath: string;
  attestationKeyFile: string;
  trustedAttestationKeyFingerprint?: string;
}

interface UsageRow {
  id: number;
  ts: string;
  category: string;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  pricing_status: string | null;
}

interface AttemptRow {
  id: number;
  created_at: string;
  provider: string;
  model: string;
  provider_category: string;
  reserved_cost_usd: number;
}

interface UsageReader {
  assertSyntheticUserIsContentEmpty(userId: number): void;
  spentUsd(runId: string): number;
  reservedUsd(runId: string): number;
  rowsForScenario(runId: string, scenarioId: string): UsageRow[];
  attemptsForScenario(runId: string, scenarioId: string): AttemptRow[];
  close(): void;
}

export interface ContentLiveEvalRuntimeDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomUUID?: () => string;
  openUsageReader?: (databasePath: string) => UsageReader;
  monotonicNow?: () => number;
}

export class ContentLiveEvalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ContentLiveEvalError';
  }
}

export const CONTENT_LIVE_EVAL_SAMPLE_TIMEOUT_MS = 90_000;
export const CONTENT_LIVE_EVAL_WHOLE_RUN_TIMEOUT_MS = 8 * 60_000;

export function assertContentLiveEvalRunnerRuntime(env: NodeJS.ProcessEnv): void {
  if (
    env.NODE_ENV === 'production'
    || env.NEXUS_CONTENT_LIVE_EVAL_RUNTIME !== '1'
    || env.CONTENT_LIVE_EVAL_ENABLED !== '1'
    || env.NEXUS_LOCAL_ALLOW_MODEL_CALLS !== '1'
    || env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED !== 'true'
  ) {
    throw new ContentLiveEvalError(
      'unsafe_runtime',
      'Use the isolated Content live-evaluation runtime with its exact provider and cost-control flags.',
    );
  }
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new ContentLiveEvalError('invalid_arguments', `${flag} requires a value`);
  return value;
}

function numberValue(flag: string, value: string | undefined): number {
  const parsed = Number(requireValue(flag, value));
  if (!Number.isFinite(parsed)) throw new ContentLiveEvalError('invalid_arguments', `${flag} must be a finite number`);
  return parsed;
}

export function parseContentLiveEvalArgs(args: string[], env: NodeJS.ProcessEnv = process.env): ContentLiveEvalCliOptions {
  const options: Partial<ContentLiveEvalCliOptions> = {
    optIn: env.CONTENT_LIVE_EVAL_OPT_IN,
    budgetUsd: env.CONTENT_LIVE_EVAL_BUDGET_USD ? Number(env.CONTENT_LIVE_EVAL_BUDGET_USD) : undefined,
    baseUrl: env.CONTENT_LIVE_EVAL_BASE_URL || 'http://127.0.0.1:8200',
    authFile: env.CONTENT_LIVE_EVAL_AUTH_FILE,
    databasePath: env.CONTENT_LIVE_EVAL_DATABASE_PATH,
    outputPath: env.CONTENT_LIVE_EVAL_ARTIFACT || '.local/content-eval/content-live-eval-artifact.json',
    attestationKeyFile: env.CONTENT_LIVE_EVAL_ATTESTATION_KEY_FILE,
    trustedAttestationKeyFingerprint: env.CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--opt-in') {
      options.optIn = requireValue(arg, next);
      index++;
    } else if (arg === '--budget-usd') {
      options.budgetUsd = numberValue(arg, next);
      index++;
    } else if (arg === '--base-url') {
      options.baseUrl = requireValue(arg, next);
      index++;
    } else if (arg === '--auth-file') {
      options.authFile = requireValue(arg, next);
      index++;
    } else if (arg === '--database-path') {
      options.databasePath = requireValue(arg, next);
      index++;
    } else if (arg === '--output') {
      options.outputPath = requireValue(arg, next);
      index++;
    } else if (arg === '--attestation-key-file') {
      options.attestationKeyFile = requireValue(arg, next);
      index++;
    } else {
      throw new ContentLiveEvalError('invalid_arguments', `Unknown argument ${arg}`);
    }
  }

  if (options.optIn !== CONTENT_LIVE_EVAL_OPT_IN) {
    throw new ContentLiveEvalError('missing_opt_in', `Live provider evaluation requires --opt-in ${CONTENT_LIVE_EVAL_OPT_IN}`);
  }
  if (
    !Number.isFinite(options.budgetUsd)
    || Number(options.budgetUsd) < CONTENT_LIVE_EVAL_MINIMUM_USABLE_BUDGET_USD
    || Number(options.budgetUsd) > CONTENT_LIVE_EVAL_ABSOLUTE_MAX_BUDGET_USD
  ) {
    throw new ContentLiveEvalError(
      'invalid_budget',
      `--budget-usd is mandatory and must be between ${CONTENT_LIVE_EVAL_MINIMUM_USABLE_BUDGET_USD.toFixed(2)} and ${CONTENT_LIVE_EVAL_ABSOLUTE_MAX_BUDGET_USD.toFixed(2)}. The minimum reserves a signed ${CONTENT_LIVE_EVAL_HARD_MAX_USD_PER_SAMPLE.toFixed(2)} local accounting slice for each of ${CONTENT_LIVE_EVAL_CORPUS.length} fixed samples under the reviewed pricing snapshot.`,
    );
  }
  if (!options.authFile || !options.databasePath || !options.attestationKeyFile) {
    throw new ContentLiveEvalError('missing_isolated_runtime', '--auth-file, --database-path, and --attestation-key-file are mandatory. The key must be a separately provisioned 0600 file.');
  }
  if (options.trustedAttestationKeyFingerprint && !/^[a-f0-9]{64}$/i.test(options.trustedAttestationKeyFingerprint)) {
    throw new ContentLiveEvalError('invalid_trusted_attestation_fingerprint', 'CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256 must be a 64-character SHA-256 fingerprint supplied independently by the release environment.');
  }
  return options as ContentLiveEvalCliOptions;
}

function assertLoopbackBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ContentLiveEvalError('unsafe_runtime', 'Live Content evaluation requires a valid loopback backend URL.');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new ContentLiveEvalError('unsafe_runtime', 'Live Content evaluation refuses non-loopback or HTTPS-remote backends.');
  }
  return url;
}

interface CanonicalAllowedRoot {
  lexical: string;
  real: string;
}

function canonicalAllowedRoots(roots: string[]): CanonicalAllowedRoot[] {
  return roots.flatMap((root) => {
    const lexical = path.resolve(root);
    try {
      return [{ lexical, real: fs.realpathSync(lexical) }];
    } catch {
      return [];
    }
  });
}

function pathWithin(pathValue: string, root: string): boolean {
  return pathValue === root || pathValue.startsWith(`${root}${path.sep}`);
}

function assertNoNestedSymlink(target: string, root: string, code: string): void {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new ContentLiveEvalError(code, 'Live evaluation refuses symlinked runtime or artifact paths.');
    }
  }
}

function assertExistingIsolatedFile(raw: string, roots: string[], code: string): string {
  const resolved = path.resolve(raw);
  const allowedRoots = canonicalAllowedRoots(roots);
  const lexicalRoot = allowedRoots.find((root) => pathWithin(resolved, root.lexical));
  if (!lexicalRoot || !fs.existsSync(resolved)) {
    throw new ContentLiveEvalError(code, 'Live evaluation requires an existing isolated regular file under an approved temporary root.');
  }
  assertNoNestedSymlink(resolved, lexicalRoot.lexical, code);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ContentLiveEvalError(code, 'Live evaluation refuses non-regular or symlinked runtime files.');
  }
  const real = fs.realpathSync(resolved);
  if (!pathWithin(real, lexicalRoot.real)) {
    throw new ContentLiveEvalError(code, 'Live evaluation resolved outside its approved temporary root.');
  }
  return real;
}

function isolatedRoots(): string[] {
  return [
    path.resolve(process.cwd(), '.local', 'content-eval'),
    path.resolve('/tmp'),
    path.resolve('/private/tmp'),
    path.resolve(process.env.TMPDIR || '/tmp'),
  ];
}

function assertLocalArtifactPath(raw: string): string {
  const resolved = path.resolve(raw);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const allowedRoots = canonicalAllowedRoots(isolatedRoots());
  const lexicalRoot = allowedRoots.find((root) => pathWithin(resolved, root.lexical));
  if (!lexicalRoot) {
    throw new ContentLiveEvalError('unsafe_artifact_path', 'Live evaluation artifacts must stay under .local/content-eval/ or a temporary directory.');
  }
  assertNoNestedSymlink(path.dirname(resolved), lexicalRoot.lexical, 'unsafe_artifact_path');
  const realParent = fs.realpathSync(path.dirname(resolved));
  if (!pathWithin(realParent, lexicalRoot.real)) throw new ContentLiveEvalError('unsafe_artifact_path', 'Artifact path resolved outside its approved root.');
  if (fs.existsSync(resolved)) {
    throw new ContentLiveEvalError('unsafe_artifact_path', 'Live evaluation refuses to overwrite an existing artifact target. Choose a fresh path.');
  }
  return path.join(realParent, path.basename(resolved));
}

export function writeContentLiveEvalArtifactExclusive(outputPath: string, artifact: unknown): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(outputPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST' || code === 'ELOOP') {
      throw new ContentLiveEvalError(
        'artifact_target_changed',
        'The artifact target appeared or became a symlink during evaluation; no output was overwritten.',
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function assertContentLiveEvalDatabasePath(raw: string): string {
  const resolved = assertExistingIsolatedFile(raw, isolatedRoots(), 'unsafe_database_path');
  if (/(?:^|[/_.-])(prod|production)(?:$|[/_.-])/i.test(resolved) || path.basename(resolved) === 'bot.db') {
    throw new ContentLiveEvalError('unsafe_database_path', 'Live Content evaluation refuses a production-shaped database path.');
  }
  if (!/^content-live-eval-[a-z0-9._-]+\.db$/i.test(path.basename(resolved))) {
    throw new ContentLiveEvalError('unsafe_database_path', 'Use a disposable database named content-live-eval-<run>.db under .local/content-eval/ or a temporary directory.');
  }
  return resolved;
}

export function assertContentLiveEvalAuthPath(authFile: string, databasePath: string): string {
  const resolvedAuthFile = assertExistingIsolatedFile(authFile, isolatedRoots(), 'unsafe_auth_path');
  if (path.dirname(resolvedAuthFile) !== path.dirname(databasePath) || path.basename(resolvedAuthFile) !== 'content-live-eval-auth.json') {
    throw new ContentLiveEvalError('unsafe_auth_path', 'The synthetic auth file must be named content-live-eval-auth.json beside the disposable evaluation database.');
  }
  return resolvedAuthFile;
}

function readAuth(resolvedAuthFile: string): { accessToken: string; userId: number } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedAuthFile, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new ContentLiveEvalError('invalid_auth', 'The local synthetic auth file could not be read.');
  }
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data as Record<string, unknown> : parsed;
  const user = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : {};
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  const userId = Number(user.id);
  if (!accessToken || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new ContentLiveEvalError('invalid_auth', 'The local auth file is missing its access token or synthetic user ID.');
  }
  return { accessToken, userId };
}

function openSqliteUsageReader(databasePath: string): UsageReader {
  if (!fs.existsSync(databasePath)) throw new ContentLiveEvalError('invalid_database', 'The local evaluation database does not exist.');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const columns = new Set((db.prepare('PRAGMA table_info(api_usage)').all() as Array<{ name: string }>).map((row) => row.name));
  const required = [
    'id', 'ts', 'category', 'provider', 'model', 'user_id',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'cost_usd', 'pricing_status', 'request_source', 'base_category', 'job_name', 'run_id',
  ];
  if (required.some((column) => !columns.has(column))) {
    db.close();
    throw new ContentLiveEvalError('invalid_database', 'The local api_usage table is missing governed provenance columns.');
  }
  const attemptTableColumns = (required: boolean): Set<string> => {
    const attemptColumns = new Set((db.prepare('PRAGMA table_info(ai_provider_attempt_reservations)').all() as Array<{ name: string }>).map((row) => row.name));
    const requiredAttemptColumns = [
      'id', 'user_id', 'request_source', 'base_category', 'job_name', 'run_id',
      'provider', 'model', 'provider_category', 'reserved_cost_usd', 'created_at',
    ];
    if (required && requiredAttemptColumns.some((column) => !attemptColumns.has(column))) {
      throw new ContentLiveEvalError('usage_unavailable', 'Durable provider-attempt reservations could not be read safely.');
    }
    return attemptColumns;
  };

  return {
    assertSyntheticUserIsContentEmpty(userId: number): void {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((row) => row.name));
      if (!tableNames.has('users')) throw new ContentLiveEvalError('invalid_database', 'The disposable database is missing its migrated users table.');
      const users = db.prepare(`
        SELECT id, COALESCE(email, '') AS email, COALESCE(username, '') AS username
          FROM users
      `).all() as Array<{ id: number; email: string; username: string }>;
      const selectedUser = users.find((row) => Number(row.id) === userId);
      if (
        users.length !== 1
        || !selectedUser
        || !selectedUser.email.toLowerCase().endsWith('.invalid')
      ) {
        throw new ContentLiveEvalError('production_data_risk', 'The disposable database must contain exactly one explicitly synthetic .invalid Content evaluation user.');
      }
      const priorUsage = db.prepare('SELECT COUNT(*) AS count FROM api_usage').get() as { count: number };
      if (Number(priorUsage.count) !== 0) {
        throw new ContentLiveEvalError('production_data_risk', 'The disposable database already contains AI usage. Create a fresh isolated database for this run.');
      }
      if (attemptTableColumns(false).size > 0) {
        const priorAttempts = db.prepare('SELECT COUNT(*) AS count FROM ai_provider_attempt_reservations').get() as { count: number };
        if (Number(priorAttempts.count) !== 0) {
          throw new ContentLiveEvalError('production_data_risk', 'The disposable database already contains provider-attempt reservations. Create a fresh isolated database for this run.');
        }
      }
      const scopedTables = [
        'content_knowledge',
        'content_domain_objects',
        'content_references',
        'content_topics',
        'content_pipeline',
      ];
      for (const table of scopedTables) {
        if (!tableNames.has(table)) continue;
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        if (row.count > 0) {
          throw new ContentLiveEvalError('production_data_risk', 'The selected local user already has Content records; use a fresh synthetic account and database.');
        }
      }
    },
    spentUsd(runId: string): number {
      const row = db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) AS cost
          FROM api_usage
         WHERE request_source = 'interactive'
           AND base_category = 'content_live_eval'
           AND run_id = ?
      `).get(runId) as { cost: number };
      const cost = Number(row.cost);
      if (!Number.isFinite(cost) || cost < 0) throw new ContentLiveEvalError('usage_unavailable', 'Durable live-evaluation usage could not be read safely.');
      return cost;
    },
    reservedUsd(runId: string): number {
      if (attemptTableColumns(false).size === 0) return 0;
      attemptTableColumns(true);
      const row = db.prepare(`
        SELECT COALESCE(SUM(reserved_cost_usd), 0) AS cost
          FROM ai_provider_attempt_reservations
         WHERE request_source = 'interactive'
           AND base_category = 'content_live_eval'
           AND run_id = ?
      `).get(runId) as { cost: number };
      const cost = Number(row.cost);
      if (!Number.isFinite(cost) || cost < 0) throw new ContentLiveEvalError('usage_unavailable', 'Durable live-evaluation reservations could not be read safely.');
      return cost;
    },
    rowsForScenario(runId: string, scenarioId: string): UsageRow[] {
      return db.prepare(`
        SELECT id, ts, category, provider, model,
               COALESCE(input_tokens, 0) AS input_tokens,
               COALESCE(output_tokens, 0) AS output_tokens,
               COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
               COALESCE(cache_write_tokens, 0) AS cache_write_tokens,
               COALESCE(cost_usd, 0) AS cost_usd,
               COALESCE(pricing_status, '') AS pricing_status
          FROM api_usage
         WHERE request_source = 'interactive'
           AND base_category = 'content_live_eval'
           AND run_id = ?
           AND job_name = ?
         ORDER BY id ASC
      `).all(runId, `content_live_eval:${scenarioId}`) as UsageRow[];
    },
    attemptsForScenario(runId: string, scenarioId: string): AttemptRow[] {
      attemptTableColumns(true);
      return db.prepare(`
        SELECT id, created_at, provider, model, provider_category, reserved_cost_usd
          FROM ai_provider_attempt_reservations
         WHERE request_source = 'interactive'
           AND base_category = 'content_live_eval'
           AND run_id = ?
           AND job_name = ?
         ORDER BY id ASC
      `).all(runId, `content_live_eval:${scenarioId}`) as AttemptRow[];
    },
    close(): void {
      db.close();
    },
  };
}

export function assertContentLiveEvalBudgetPreflight(input: {
  budgetUsd: number;
  spentUsd: number;
  remainingSamples: number;
}): void {
  const reserveForRemainingCorpus = CONTENT_LIVE_EVAL_HARD_MAX_USD_PER_SAMPLE * input.remainingSamples;
  if (
    !Number.isFinite(input.budgetUsd)
    || !Number.isFinite(input.spentUsd)
    || input.spentUsd < 0
    || input.remainingSamples <= 0
    || input.spentUsd + reserveForRemainingCorpus > input.budgetUsd + Number.EPSILON
  ) {
    throw new ContentLiveEvalError('budget_exhausted_preflight', 'The hard live-evaluation budget cannot safely reserve every remaining fixed corpus sample. No provider call was made.');
  }
}

function providerModelMatches(provider: string, attemptModel: string, usageModel: string): boolean {
  return contentLiveEvalModelResolutionAllowed(provider, attemptModel, usageModel);
}

export function bindContentLiveEvalAttemptInvocations(
  attempts: AttemptRow[],
  rows: UsageRow[],
  runId: string,
  scenario: ContentLiveEvalScenario,
): ContentLiveEvalProviderInvocation[] {
  if (attempts.length === 0) {
    throw new ContentLiveEvalError('missing_attempt_provenance', 'The canonical script returned without a durable pre-network provider-attempt reservation.');
  }
  const unmatchedAttempts = attempts.map((attempt, index) => ({ attempt, index }));
  const usageByAttemptIndex = new Map<number, UsageRow>();
  // Match newest-to-newest so a usage-less failed retry cannot steal the
  // successful row from a later concrete attempt. Exact provider/category and
  // compatible provider snapshot model names are mandatory.
  for (const row of [...rows].reverse()) {
    let matchPosition = -1;
    for (let index = unmatchedAttempts.length - 1; index >= 0; index--) {
      const candidate = unmatchedAttempts[index].attempt;
      if (
        candidate.provider.trim().toLowerCase() === String(row.provider || '').trim().toLowerCase()
        && candidate.provider_category === row.category
        && providerModelMatches(candidate.provider, candidate.model, row.model)
      ) {
        matchPosition = index;
        break;
      }
    }
    if (matchPosition < 0) {
      throw new ContentLiveEvalError('unbound_usage_provenance', 'Durable provider usage did not bind to a pre-network attempt reservation.');
    }
    const [matched] = unmatchedAttempts.splice(matchPosition, 1);
    usageByAttemptIndex.set(matched.index, row);
  }

  return attempts.map((attempt, index) => {
    const row = usageByAttemptIndex.get(index);
    const inputTokens = Math.max(0, Math.floor(Number(row?.input_tokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(row?.output_tokens) || 0));
    const cacheReadTokens = Math.max(0, Math.floor(Number(row?.cache_read_tokens) || 0));
    const cacheWriteTokens = Math.max(0, Math.floor(Number(row?.cache_write_tokens) || 0));
    const reservedCostUsd = Math.max(0, Number(attempt.reserved_cost_usd) || 0);
    const costUsd = Math.max(0, Number(row?.cost_usd) || 0);
    if (!Number.isFinite(reservedCostUsd) || !Number.isFinite(costUsd) || costUsd > reservedCostUsd + 1e-8) {
      throw new ContentLiveEvalError('attempt_cost_invariant_broken', 'Durable provider usage exceeded its pessimistic pre-network reservation.');
    }
    return bindContentLiveEvalInvocation({
      invocationId: `content-live:${contentEvalSha256(`${runId}:attempt:${attempt.id}`).slice(0, 24)}`,
      scenarioId: scenario.id,
      provider: String(attempt.provider || ''),
      model: String(attempt.model || ''),
      resolvedModel: String(row?.model || attempt.model || ''),
      tier: 'chat',
      category: 'content_day_to_day_eval',
      providerCategory: String(attempt.provider_category || ''),
      status: row && row.pricing_status !== 'timeout-estimate' ? 'succeeded' : 'failed',
      capturedAt: new Date(attempt.created_at).toISOString(),
      routingPath: CONTENT_LIVE_EVAL_ROUTING_PATH,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      costUsd,
      reservedCostUsd,
      pricingStatus: String(row?.pricing_status || 'attempt-reserved-no-usage'),
    });
  });
}

export async function requestContentLiveEvalScenario(input: {
  baseUrl: URL;
  accessToken: string;
  runId: string;
  budgetUsd: number;
  scenario: ContentLiveEvalScenario;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<unknown> {
  const endpoint = new URL('/api/v1/content/script', input.baseUrl).toString();
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new Error('content_live_eval_sample_timeout'));
      reject(new ContentLiveEvalError('sample_timeout', 'The canonical Content scenario exceeded its bounded timeout. The run was stopped and no artifact was emitted.'));
    }, input.timeoutMs);
    timeout.unref?.();
  });
  const requestAndBody = (async () => {
    const response = await input.fetchImpl(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
        'x-nexus-content-live-eval-opt-in': CONTENT_LIVE_EVAL_OPT_IN,
        'x-nexus-content-live-eval-run-id': input.runId,
        'x-nexus-content-live-eval-budget-usd': input.budgetUsd.toFixed(8),
        'x-nexus-content-live-eval-scenario-id': input.scenario.id,
      },
      body: JSON.stringify({
        topic: input.scenario.topic,
        niche: input.scenario.niche,
        format: input.scenario.format,
        targetDurationSeconds: input.scenario.targetDurationSeconds,
        language: input.scenario.language,
        mode: 'standard',
        renderMode: 'structured',
        scriptStyle: 'detailed',
        forceRefresh: true,
        saveToIdeas: false,
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { response, payload };
  })();
  const { response, payload } = await Promise.race([requestAndBody, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  if (!response.ok) {
    const error = payload?.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
    const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
    throw new ContentLiveEvalError(
      code === 'SERVICE_DEGRADED' ? 'budget_or_provider_blocked' : 'canonical_script_failed',
      `Canonical Content script evaluation failed safely (${code}).`,
    );
  }
  if (!payload || typeof payload !== 'object') throw new ContentLiveEvalError('invalid_script_response', 'Canonical Content script response was not valid JSON.');
  return payload;
}

export function assertContentLiveEvalRunDeadline(remainingMs: number): void {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new ContentLiveEvalError('whole_run_timeout', 'The live-evaluation run exceeded its bounded deadline. No artifact was emitted.');
  }
}

export async function runContentLiveEvaluation(
  options: ContentLiveEvalCliOptions,
  deps: ContentLiveEvalRuntimeDeps = {},
): Promise<ReturnType<typeof createContentLiveEvaluationArtifact>> {
  assertContentLiveEvalRunnerRuntime(process.env);
  const baseUrl = assertLoopbackBaseUrl(options.baseUrl);
  const databasePath = assertContentLiveEvalDatabasePath(options.databasePath);
  const outputPath = assertLocalArtifactPath(options.outputPath);
  const authPath = assertContentLiveEvalAuthPath(options.authFile, databasePath);
  const attestationKey = readContentLiveEvalAttestationKeyFile(options.attestationKeyFile);
  const sourceIdentity = resolveContentLiveEvalSourceIdentity(path.resolve(__dirname, '..'), {
    requireCleanGeneratorSurface: true,
  });
  const auth = readAuth(authPath);
  const usageReader = (deps.openUsageReader ?? openSqliteUsageReader)(databasePath);
  const now = deps.now ?? (() => new Date());
  const monotonicNow = deps.monotonicNow ?? Date.now;
  const startedAt = now();
  const wholeRunDeadline = monotonicNow() + CONTENT_LIVE_EVAL_WHOLE_RUN_TIMEOUT_MS;
  const runId = `content-live-eval-${startedAt.toISOString().replace(/[^0-9TZ]/g, '')}-${(deps.randomUUID ?? crypto.randomUUID)().slice(0, 12)}`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const samples: Array<{ scenario: ContentLiveEvalScenario; response: unknown; invocations: ContentLiveEvalProviderInvocation[] }> = [];

  try {
    usageReader.assertSyntheticUserIsContentEmpty(auth.userId);
    for (let index = 0; index < CONTENT_LIVE_EVAL_CORPUS.length; index++) {
      const remainingRunMs = wholeRunDeadline - monotonicNow();
      assertContentLiveEvalRunDeadline(remainingRunMs);
      const scenario = CONTENT_LIVE_EVAL_CORPUS[index];
      const reservedBefore = usageReader.reservedUsd(runId);
      assertContentLiveEvalBudgetPreflight({
        budgetUsd: options.budgetUsd,
        spentUsd: reservedBefore,
        remainingSamples: CONTENT_LIVE_EVAL_CORPUS.length - index,
      });
      const response = await requestContentLiveEvalScenario({
        baseUrl,
        accessToken: auth.accessToken,
        runId,
        budgetUsd: options.budgetUsd,
        scenario,
        fetchImpl,
        timeoutMs: Math.min(CONTENT_LIVE_EVAL_SAMPLE_TIMEOUT_MS, remainingRunMs),
      });
      const rows = usageReader.rowsForScenario(runId, scenario.id);
      if (rows.length === 0) throw new ContentLiveEvalError('missing_usage_provenance', 'The canonical script returned without durable provider usage provenance.');
      const attempts = usageReader.attemptsForScenario(runId, scenario.id);
      const invocations = bindContentLiveEvalAttemptInvocations(attempts, rows, runId, scenario);
      if (!invocations.some((invocation) => invocation.status === 'succeeded')) {
        throw new ContentLiveEvalError('missing_successful_provider_call', 'The canonical script did not record a successful real-provider invocation.');
      }
      const spentAfter = usageReader.spentUsd(runId);
      const reservedAfter = usageReader.reservedUsd(runId);
      if (spentAfter > options.budgetUsd + Number.EPSILON) {
        throw new ContentLiveEvalError('budget_invariant_broken', 'Durable recorded usage exceeded the configured local run limit; artifact emission was refused.');
      }
      if (
        reservedAfter > options.budgetUsd + Number.EPSILON
        || invocations.reduce((sum, invocation) => sum + invocation.reservedCostUsd, 0)
          > CONTENT_LIVE_EVAL_HARD_MAX_USD_PER_SAMPLE + Number.EPSILON
      ) {
        throw new ContentLiveEvalError('budget_invariant_broken', 'Durable provider-attempt reservations exceeded the signed local accounting limit; artifact emission was refused.');
      }
      samples.push({ scenario, response, invocations });
    }

    const rubricDigest = contentEvalSha256(CONTENT_QUALITY_RUBRIC);
    const generatedAt = now();
    const artifact = createContentLiveEvaluationArtifact({
      runId,
      startedAt: startedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      rubricDigest,
      budgetLimitUsd: options.budgetUsd,
      sourceIdentity,
      attestationKey,
      trustedAttestationKeyFingerprint: options.trustedAttestationKeyFingerprint,
      samples,
    });
    const validation = validateContentLiveEvaluationArtifact(artifact, {
      rubricDigest,
      attestationKey,
      trustedAttestationKeyFingerprint: options.trustedAttestationKeyFingerprint,
      expectedSourceIdentity: sourceIdentity,
      now: generatedAt,
    });
    if (!validation.valid) throw new ContentLiveEvalError('artifact_validation_failed', `Live evaluation artifact failed closed (${validation.reason}).`);
    // The path was checked before the paid run, but another process could
    // create it while provider calls are in flight. O_EXCL closes that target
    // race and refuses both regular files and symlinks without overwriting.
    writeContentLiveEvalArtifactExclusive(outputPath, artifact);
    return artifact;
  } finally {
    usageReader.close();
  }
}

async function main(): Promise<void> {
  const options = parseContentLiveEvalArgs(process.argv.slice(2));
  const artifact = await runContentLiveEvaluation(options);
  console.log(`[content-live-eval] ${artifact.summary.failCount === 0 ? 'PASS' : 'FAIL'} runId=${artifact.runId} score=${artifact.summary.score} samples=${artifact.summary.sampleCount}`);
  console.log(`[content-live-eval] spentUsd=${artifact.budget.spentUsd.toFixed(8)} hardMaxUsd=${artifact.budget.limitUsd.toFixed(2)}`);
  console.log(`[content-live-eval] artifact=${path.resolve(options.outputPath)}`);
  if (artifact.summary.failCount > 0 || artifact.summary.score < 90) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    const code = error instanceof ContentLiveEvalError ? error.code : 'unexpected_error';
    const message = error instanceof Error ? error.message : 'Unexpected live evaluation failure.';
    console.error(`[content-live-eval] ${code}: ${message}`);
    process.exitCode = 1;
  });
}
