// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Script Generation Pipeline (v1, local-only by default).
 *
 * Two structured-output passes:
 *   Step 1 — Plan: ask the local model for a structured plan and risk
 *            classification. Schema validated; one local retry on invalid
 *            JSON; then fail.
 *   Step 2 — Artifacts: ask the local model for an artifact bundle
 *            (path/kind/content). Schema validated; one local retry on
 *            invalid JSON; then fail.
 *
 * Then deterministic validation runs inside an isolated sandbox dir:
 *   - Artifact paths are checked with `isSafeRelativeArtifactPath`.
 *   - The resolved absolute path must stay inside the sandbox root.
 *   - Symlinks in the parent chain are rejected.
 *   - Validators are derived from artifact `kind` (NOT from the model's
 *     advisory `validation_steps` field).
 *   - All validators run via `execFile(cmd, args, { shell: false, cwd:
 *     sandboxRoot, timeout })`. Never `exec()` / `execSync()` / `spawn
 *     shell:true`.
 *
 * Run records persist into `script_generation_runs`. The artifact files
 * stay under `data/script-gen-runs/<runId>/artifacts/` for review.
 *
 * SCHEMA VALIDATION: this file deliberately uses hand-written validators
 * instead of pulling in `zod`. Per the pre-impl repo audit, no
 * validation library is currently a dep; the operator preference is to
 * skip dependency churn for short, stable schemas (plan A1).
 *
 * See plan Revision 4, items 10 + 11 + 12 + A3 + A4.
 */

import { promises as fs, statSync, lstatSync } from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

import { config } from '../config';
import { logger } from '../utils/logger';
import { getDb } from './database';
import { LocalLLMError } from './local-llm-error';
import type {
  GeneratedArtifact,
  OllamaProvider,
  ScriptGenPlan,
  ScriptGenResult,
  ScriptGenTask,
} from './ollama-provider';
import { stripThinkBlocks } from './ollama-provider';

const execFileAsync = promisify(execFile);

// ─── Schemas ────────────────────────────────────────────────────────

const SCRIPT_GEN_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'array', minItems: 1, items: { type: 'string' } },
    files_to_create: { type: 'array', items: { type: 'string' } },
    files_to_modify: { type: 'array', items: { type: 'string' } },
    commands_to_run: { type: 'array', items: { type: 'string' } },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
    requires_cloud_reasoning: { type: 'boolean' },
    requires_human_approval: { type: 'boolean' },
  },
  required: ['plan', 'files_to_create', 'files_to_modify', 'commands_to_run', 'risk_level', 'requires_cloud_reasoning', 'requires_human_approval'],
} as const;

const ARTIFACT_KINDS = ['shell_script', 'typescript', 'sql_migration', 'markdown', 'json', 'patch'] as const;

const SCRIPT_GEN_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SCRIPT_GEN_PLAN_SCHEMA.properties,
    artifacts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ARTIFACT_KINDS as unknown as string[] },
          content: { type: 'string' },
          executable: { type: 'boolean' },
        },
        required: ['path', 'kind', 'content'],
      },
    },
    validation_steps: { type: 'array', items: { type: 'string' } },
  },
  required: [...SCRIPT_GEN_PLAN_SCHEMA.required, 'artifacts', 'validation_steps'],
} as const;

// ─── Validators (hand-written) ─────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

// v2.7 (angry-QA-found): the previous validator accepted
//   - U+2024 ONE DOT LEADER (looks like '.')
//   - U+202E RIGHT-TO-LEFT OVERRIDE (bidi spoofing of file extension)
//   - U+200B ZERO-WIDTH SPACE (invisible suffix)
//   - %2e%2e (URL-encoded `..`)
//   - 4097+ char paths (hit ENAMETOOLONG at FS layer)
// Tighten to ASCII-only printable characters, explicit length cap,
// no percent-encoding, no control/bidi/zero-width chars. This is a
// generated-artifact path, not a user filesystem path — operators name
// their files with plain ASCII.
const MAX_PATH_LENGTH = 256;        // total path length
const MAX_SEGMENT_LENGTH = 64;      // each segment between slashes
const ALLOWED_PATH_CHARS = /^[A-Za-z0-9._\-\/]+$/;

// v2.8 (angry-QA-found): the model's artifact paths must not look like
// repo paths — Codex correctly noted that `src/services/ollama-provider.ts`
// was accepted, which would let a model write under
// `sandbox/src/services/ollama-provider.ts`. While that's still inside
// the sandbox (no real escape), it's confusing and operator could mistake
// it for a real source edit. Reject paths whose first segment is a
// reserved repo top-level.
const RESERVED_TOP_SEGMENTS = new Set([
  'src', 'migrations', 'scripts', '__tests__', 'docs',
  'node_modules', 'data', 'dist', 'logs', '.github', '.git',
  '.claude', '.husky', 'coverage',
]);

function isSafeRelativeArtifactPath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (p.length < 1 || p.length > MAX_PATH_LENGTH) return false;
  if (p.startsWith('/') || p.startsWith('~')) return false;
  if (p.includes('..')) return false;
  if (p.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  // Reject percent-encoding entirely (no encoded traversal, no encoded
  // separators). If a generated filename legitimately needs a literal
  // '%', that's a smell — reject and require the model to rename.
  if (p.includes('%')) return false;
  // Reject anything that isn't ASCII alphanum + dot/dash/underscore/slash.
  // This catches every Unicode trick (dot leader, RTLO, zero-width, etc.)
  // by simply not being in the allowed set.
  if (!ALLOWED_PATH_CHARS.test(p)) return false;
  // No leading dot on basename (no hidden files). Also reject `.`-only
  // segments.
  const segments = p.split('/');
  for (const seg of segments) {
    if (!seg) return false;                       // empty segment ('//')
    if (seg === '.' || seg === '..') return false;
    if (seg.startsWith('.')) return false;        // hidden file
    if (seg.length > MAX_SEGMENT_LENGTH) return false;
  }
  // v2.8: reject reserved repo top-level segments (case-insensitive,
  // so 'SRC/...' doesn't sneak through).
  if (RESERVED_TOP_SEGMENTS.has(segments[0].toLowerCase())) return false;
  return true;
}

function validatePlanPayload(parsed: unknown): { ok: true; plan: ScriptGenPlan } | { ok: false; reason: string } {
  if (!isObject(parsed)) return { ok: false, reason: 'not_object' };
  for (const required of SCRIPT_GEN_PLAN_SCHEMA.required) {
    if (!(required in parsed)) return { ok: false, reason: `missing_${required}` };
  }
  if (!isStringArray(parsed.plan) || parsed.plan.length === 0) return { ok: false, reason: 'plan_must_be_nonempty_string_array' };
  if (!isStringArray(parsed.files_to_create)) return { ok: false, reason: 'files_to_create_must_be_string_array' };
  if (!isStringArray(parsed.files_to_modify)) return { ok: false, reason: 'files_to_modify_must_be_string_array' };
  if (!isStringArray(parsed.commands_to_run)) return { ok: false, reason: 'commands_to_run_must_be_string_array' };
  if (typeof parsed.risk_level !== 'string' || !['low', 'medium', 'high'].includes(parsed.risk_level)) return { ok: false, reason: 'risk_level_invalid' };
  if (typeof parsed.requires_cloud_reasoning !== 'boolean') return { ok: false, reason: 'requires_cloud_reasoning_must_be_boolean' };
  if (typeof parsed.requires_human_approval !== 'boolean') return { ok: false, reason: 'requires_human_approval_must_be_boolean' };
  return {
    ok: true,
    plan: parsed as unknown as ScriptGenPlan,
  };
}

function validateArtifactsPayload(parsed: unknown): { ok: true; full: ScriptGenResult } | { ok: false; reason: string } {
  const planValid = validatePlanPayload(parsed);
  if (!planValid.ok) return planValid;
  if (!isObject(parsed)) return { ok: false, reason: 'not_object' };
  const artifactsRaw = parsed.artifacts;
  if (!Array.isArray(artifactsRaw) || artifactsRaw.length === 0) return { ok: false, reason: 'artifacts_must_be_nonempty_array' };
  const validation_steps = parsed.validation_steps;
  if (!isStringArray(validation_steps)) return { ok: false, reason: 'validation_steps_must_be_string_array' };

  const artifacts: GeneratedArtifact[] = [];
  for (const a of artifactsRaw) {
    if (!isObject(a)) return { ok: false, reason: 'artifact_must_be_object' };
    if (typeof a.path !== 'string' || !isSafeRelativeArtifactPath(a.path)) return { ok: false, reason: 'artifact_path_unsafe' };
    if (typeof a.kind !== 'string' || !ARTIFACT_KINDS.includes(a.kind as typeof ARTIFACT_KINDS[number])) return { ok: false, reason: 'artifact_kind_invalid' };
    if (typeof a.content !== 'string') return { ok: false, reason: 'artifact_content_must_be_string' };
    artifacts.push({
      path: a.path,
      kind: a.kind as GeneratedArtifact['kind'],
      content: a.content,
      executable: typeof a.executable === 'boolean' ? a.executable : false,
    });
  }

  return {
    ok: true,
    full: {
      ...planValid.plan,
      artifacts,
      validation_steps,
      validation_status: 'skipped',
      validation_details: [],
      run_id: '',
    },
  };
}

// ─── Sandbox & path-safety ──────────────────────────────────────────

function sandboxRootFor(runId: string): string {
  const root = path.resolve(process.cwd(), 'data', 'script-gen-runs', runId, 'sandbox');
  return root;
}

async function ensureSandbox(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
}

function assertPathInsideSandbox(absPath: string, sandboxRoot: string): void {
  const normAbs = path.resolve(absPath);
  const normRoot = path.resolve(sandboxRoot) + path.sep;
  if (!normAbs.startsWith(normRoot)) {
    throw new Error(`unsafe artifact path escapes sandbox: ${absPath}`);
  }
}

function assertNoSymlinkAncestors(absPath: string, sandboxRoot: string): void {
  // Walk from sandboxRoot down to the parent of absPath, ensuring no
  // ancestor is a symlink.
  const rel = path.relative(sandboxRoot, path.dirname(absPath));
  if (!rel) return;
  const parts = rel.split(path.sep);
  let cursor = sandboxRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fsSync.existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`unsafe artifact path crosses symlink: ${cursor}`);
      }
    }
  }
}

// ─── Validators (allowlisted; shell:false) ─────────────────────────

interface ValidationDetail { command: string; ok: boolean; output?: string }

async function runValidator(cmd: string, args: string[], cwd: string): Promise<ValidationDetail> {
  const command = `${cmd} ${args.join(' ')}`.trim();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, shell: false, timeout: 60_000 });
    return { command, ok: true, output: (stdout || stderr || '').slice(0, 1200) };
  } catch (err) {
    const msg = (err as { stdout?: string; stderr?: string; message?: string });
    return { command, ok: false, output: ((msg.stderr || msg.stdout || msg.message || '') as string).slice(0, 1200) };
  }
}

async function commandAvailable(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('command', ['-v', cmd], { shell: false });
    return true;
  } catch {
    // `command` is a shell builtin and not always present as a binary;
    // fall back to `which`.
    try {
      await execFileAsync('which', [cmd], { shell: false });
      return true;
    } catch {
      return false;
    }
  }
}

async function validateArtifactsDeterministically(artifacts: GeneratedArtifact[], sandboxRoot: string): Promise<ValidationDetail[]> {
  const details: ValidationDetail[] = [];
  for (const a of artifacts) {
    const absPath = path.resolve(sandboxRoot, a.path);
    // Defensive: path safety has already been Zod-validated, but recheck
    // after resolve to catch any normalization tricks.
    assertPathInsideSandbox(absPath, sandboxRoot);
    assertNoSymlinkAncestors(absPath, sandboxRoot);

    if (a.kind === 'shell_script') {
      details.push(await runValidator('bash', ['-n', absPath], sandboxRoot));
      if (await commandAvailable('shellcheck')) {
        details.push(await runValidator('shellcheck', [absPath], sandboxRoot));
      } else {
        details.push({ command: `shellcheck ${a.path}`, ok: true, output: 'shellcheck not installed; skipped (advisory)' });
      }
    } else if (a.kind === 'typescript') {
      // Project-aware typecheck would require copying the whole repo; v1
      // does a syntactic check using --noEmit on the single file with
      // --allowJs to be lenient. Surfaces obvious parse errors only.
      details.push(await runValidator('npx', ['--no-install', 'tsc', '--noEmit', '--allowJs', '--target', 'es2020', absPath], sandboxRoot));
    } else if (a.kind === 'sql_migration') {
      const checker = path.resolve(process.cwd(), 'scripts', 'check-migrations.js');
      if (fsSync.existsSync(checker)) {
        details.push(await runValidator('node', [checker], sandboxRoot));
      } else {
        details.push({ command: 'check-migrations.js', ok: true, output: 'checker not present; skipped (advisory)' });
      }
    } else {
      details.push({ command: `validate(${a.kind}) ${a.path}`, ok: true, output: 'no validator registered for this kind' });
    }
  }
  return details;
}

// ─── Persist run record ─────────────────────────────────────────────

function persistRunRecord(args: {
  runId: string;
  task: ScriptGenTask;
  result: ScriptGenResult;
  durationMs: number;
  modelDigest?: string;
  metaJson?: unknown;
}): void {
  try {
    const db = getDb();
    // Guard 1: skip if table doesn't exist yet (migration not applied).
    const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='script_generation_runs'`).get();
    if (!has) {
      logger.warn({ runId: args.runId }, 'script-generation: script_generation_runs table missing; skip persist');
      return;
    }
    // Guard 2 (v2.6 angry-QA-found): if a legacy table with the same
    // name but a different shape exists, CREATE TABLE IF NOT EXISTS in
    // the migration was a no-op and the INSERT below will fail with a
    // confusing column-mismatch error. Verify required columns before
    // INSERT; refuse to persist if shape is wrong.
    if (!assertScriptGenerationRunsSchema(db)) {
      logger.error(
        { runId: args.runId },
        'script-generation: script_generation_runs schema mismatch — legacy table needs manual DROP+re-create',
      );
      return;
    }
    // v2.6 (angry-QA-found): respect LOCAL_LLM_STORE_PROMPTS=false. The
    // previous code always wrote a 200-char excerpt of task.description
    // into task_label, which violates the operator's no-prompts setting.
    const storePrompts = config.ollama.artifacts.storePrompts;
    const taskLabel = storePrompts
      ? args.task.description.slice(0, 200)
      : `[hash:${hashShort(args.task.description)}]`;

    db.prepare(`
      INSERT INTO script_generation_runs (
        ts, user_id, tenant_id, provider, model, model_digest,
        task_label, prompt_tokens, completion_tokens, duration_ms, load_duration_ms,
        validation_status, fallback_used, requires_cloud_reasoning, requires_human_approval,
        risk_level, artifact_count, meta_json
      )
      VALUES (?, ?, ?, 'ollama', ?, ?, ?, NULL, NULL, ?, NULL, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      Math.floor(Date.now() / 1000),
      args.task.userId ?? 0,
      args.task.tenantId ?? 0,
      config.ollama.model,
      args.modelDigest ?? null,
      taskLabel,
      args.durationMs,
      args.result.validation_status,
      args.result.requires_cloud_reasoning ? 1 : 0,
      args.result.requires_human_approval ? 1 : 0,
      args.result.risk_level,
      args.result.artifacts.length,
      args.metaJson ? JSON.stringify(args.metaJson).slice(0, 4000) : null,
    );
  } catch (err) {
    logger.warn({ err }, 'script-generation: failed to persist run record');
  }
}

/**
 * v2.6 (angry-QA-found): assert the live table has the columns this
 * code inserts. Returns true if compatible; false if any required
 * column is missing. Cached per-DB handle to avoid PRAGMA on every
 * insert.
 */
const SCHEMA_CHECK_CACHE = new WeakMap<object, boolean>();
const REQUIRED_SGR_COLUMNS = [
  'ts', 'user_id', 'tenant_id', 'provider', 'model', 'model_digest',
  'task_label', 'prompt_tokens', 'completion_tokens', 'duration_ms',
  'load_duration_ms', 'validation_status', 'fallback_used',
  'requires_cloud_reasoning', 'requires_human_approval', 'risk_level',
  'artifact_count', 'meta_json',
];

function assertScriptGenerationRunsSchema(db: ReturnType<typeof getDb>): boolean {
  const cached = SCHEMA_CHECK_CACHE.get(db as unknown as object);
  if (cached !== undefined) return cached;
  try {
    const rows = (db as unknown as { prepare: (sql: string) => { all: () => Array<{ name: string }> } })
      .prepare('PRAGMA table_info(script_generation_runs)')
      .all();
    const cols = new Set(rows.map(r => r.name));
    const missing = REQUIRED_SGR_COLUMNS.filter(c => !cols.has(c));
    const ok = missing.length === 0;
    if (!ok) {
      logger.error(
        { missing, present: [...cols] },
        'script_generation_runs schema mismatch — required columns missing',
      );
    }
    SCHEMA_CHECK_CACHE.set(db as unknown as object, ok);
    return ok;
  } catch (err) {
    logger.warn({ err }, 'assertScriptGenerationRunsSchema: PRAGMA failed');
    return false;
  }
}

/** Short non-cryptographic hash for task_label privacy bucketing. */
function hashShort(text: string): string {
  // FNV-1a over UTF-16 code units, base36. 8 chars is enough to bucket
  // distinct tasks for analytics without storing prompt content.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(8, '0').slice(0, 8);
}

// ─── Main pipeline ──────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = [
  'You are a senior engineer planning a focused implementation task.',
  'You will receive a short task description.',
  'Produce a JSON plan that matches this schema exactly:',
  JSON.stringify(SCRIPT_GEN_PLAN_SCHEMA, null, 2),
  '',
  'Rules:',
  '- Set requires_cloud_reasoning=true only when the task genuinely needs a frontier reasoning model.',
  '- Set requires_human_approval=true for any change with risk_level=high.',
  '- File paths must be repo-relative, no ".." segments, no absolute paths.',
  '- commands_to_run is advisory only; do not include destructive commands.',
  '',
  'Return ONLY the JSON object. No prose, no markdown, no backticks.',
].join('\n');

const RESULT_SYSTEM_PROMPT_HEADER = [
  'You are a senior engineer producing the artifacts implied by the plan you just made.',
  'You will receive the prior plan and the original task.',
  'Produce a JSON result that matches this schema exactly:',
  JSON.stringify(SCRIPT_GEN_RESULT_SCHEMA, null, 2),
  '',
  'Rules:',
  '- Each artifact path is a repo-relative path that does NOT escape the sandbox.',
  '- artifact.kind classifies the file so the validator picks the right tool.',
  '- Do NOT include destructive commands in validation_steps; that field is advisory.',
  '- For shell_script artifacts, write strict, defensive bash with `set -euo pipefail`.',
  '- For typescript artifacts, use the project conventions (CommonJS, no top-level await).',
  '',
  'Return ONLY the JSON object. No prose, no markdown, no backticks.',
].join('\n');

export async function runScriptGenerationPipeline(
  task: ScriptGenTask,
  ollama: OllamaProvider,
): Promise<ScriptGenResult> {
  const runId = task.runId || randomUUID();
  const t0 = Date.now();
  const userId = task.userId ?? 0;
  const tenantId = task.tenantId ?? 0;

  // ── Step 1: plan ────────────────────────────────────────────────
  const planSystem = task.domainContext
    ? `${PLAN_SYSTEM_PROMPT}\n\n[Domain context]\n${task.domainContext}`
    : PLAN_SYSTEM_PROMPT;

  const plan = await runStructuredCall<ScriptGenPlan>({
    ollama,
    taskType: 'scriptGeneration',
    category: 'script_gen_plan',
    userId, tenantId,
    request: {
      model: config.ollama.model,
      messages: [
        { role: 'system', content: planSystem },
        { role: 'user', content: task.description },
      ],
      think: true,
      format: SCRIPT_GEN_PLAN_SCHEMA,
      stream: false,
      keep_alive: -1,
      options: {
        num_ctx: 8192,
        // v1.1: bumped 1200→3000 because Qwen3.6 think:true uses up
        // num_predict for chain-of-thought BEFORE emitting JSON, and the
        // smoke (2026-05-26) truncated 5/6 of the think:true cases at
        // the old budget.
        num_predict: 3000,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 20,
      },
    },
    validate: (parsed) => validatePlanPayload(parsed).ok
      ? { ok: true, value: parsed as ScriptGenPlan }
      : { ok: false, reason: (validatePlanPayload(parsed) as { ok: false; reason: string }).reason },
    step: 'plan',
  });

  // Early-return path: if the plan says it needs cloud reasoning and we're
  // in evaluation mode, return the plan + recommendation without invoking
  // the script-gen step (no silent cloud).
  if (plan.requires_cloud_reasoning && config.localLLMEvaluation.requireLocalForScriptGen) {
    const result: ScriptGenResult = {
      ...plan,
      artifacts: [],
      validation_steps: [],
      validation_status: 'skipped',
      validation_details: [{ command: 'plan-only', ok: true, output: 'requires_cloud_reasoning=true; evaluation mode declined to escalate' }],
      run_id: runId,
    };
    persistRunRecord({
      runId,
      task,
      result,
      durationMs: Date.now() - t0,
      metaJson: { reason: 'requires_cloud_reasoning_in_evaluation_mode' },
    });
    return result;
  }

  // ── Step 2: artifacts ───────────────────────────────────────────
  const artifactsSystem = `${RESULT_SYSTEM_PROMPT_HEADER}\n\n[Prior plan]\n${JSON.stringify(plan, null, 2)}`;
  const full = await runStructuredCall<ScriptGenResult>({
    ollama,
    taskType: 'scriptGeneration',
    category: 'script_gen_artifacts',
    userId, tenantId,
    request: {
      model: config.ollama.model,
      messages: [
        { role: 'system', content: artifactsSystem },
        { role: 'user', content: task.description },
      ],
      think: true,
      format: SCRIPT_GEN_RESULT_SCHEMA,
      stream: false,
      keep_alive: -1,
      options: {
        num_ctx: 8192,
        // v1.1: bumped 1800→4096 — see plan step 1 above. Artifacts step
        // produces the largest JSON (multiple file contents) so it gets
        // the highest budget.
        num_predict: 4096,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 20,
      },
    },
    validate: (parsed) => {
      const v = validateArtifactsPayload(parsed);
      return v.ok ? { ok: true, value: v.full } : { ok: false, reason: v.reason };
    },
    step: 'script',
  });

  // ── Step 3: sandboxed validation ───────────────────────────────
  const sandboxRoot = sandboxRootFor(runId);
  await ensureSandbox(sandboxRoot);

  for (const a of full.artifacts) {
    const absPath = path.resolve(sandboxRoot, a.path);
    assertPathInsideSandbox(absPath, sandboxRoot);

    // v2.6 (angry-QA-found): symlink check MUST run before mkdir.
    // Previously mkdir(recursive) ran first, which would happily traverse
    // a sandbox-internal symlink (e.g. `sandbox/link → /tmp/outside`)
    // and create `created_outside/` at the symlink target — outside the
    // sandbox — before the symlink check rejected the WRITE. The
    // directory leak persisted even though the write was refused.
    //
    // Reorder: (1) check every ancestor of absPath for symlinks; (2)
    // only then mkdir; (3) re-verify after mkdir via realpath
    // containment in case anything races.
    assertNoSymlinkAncestors(absPath, sandboxRoot);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // Defense-in-depth: realpath check after mkdir. If mkdir somehow
    // traversed a symlink the ancestor check missed (e.g., race), this
    // catches it before the write happens.
    try {
      const realParent = fsSync.realpathSync(path.dirname(absPath));
      assertPathInsideSandbox(path.join(realParent, path.basename(absPath)), sandboxRoot);
    } catch (err) {
      throw new Error(`unsafe artifact path failed realpath containment check: ${a.path}`);
    }

    // `wx` flag = exclusive create. Refuses to overwrite an existing
    // file (including through a pre-existing symlink at the leaf).
    await fs.writeFile(absPath, a.content, { flag: 'wx', mode: a.executable ? 0o755 : 0o644 });
  }

  const details = await validateArtifactsDeterministically(full.artifacts, sandboxRoot);
  const allOk = details.every(d => d.ok);
  const validation_status: ScriptGenResult['validation_status'] = details.length === 0
    ? 'skipped'
    : (allOk ? 'passed' : 'failed');

  const result: ScriptGenResult = {
    ...full,
    validation_status,
    validation_details: details,
    sandbox_path: sandboxRoot,
    run_id: runId,
  };

  // ── Step 4: persist run record ─────────────────────────────────
  persistRunRecord({
    runId,
    task,
    result,
    durationMs: Date.now() - t0,
  });

  return result;
}

// ─── Internal: structured call with one-shot retry on invalid JSON ─

async function runStructuredCall<T>(args: {
  ollama: OllamaProvider;
  taskType: 'scriptGeneration';
  category: string;
  userId: number;
  tenantId: number;
  request: Parameters<OllamaProvider['chatPrimitive']>[0]['request'];
  validate: (parsed: unknown) => { ok: true; value: T } | { ok: false; reason: string };
  step: 'plan' | 'script';
}): Promise<T> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt === 0
      ? args.request.messages
      : [
          ...args.request.messages,
          { role: 'assistant' as const, content: 'My previous reply was not valid JSON. I will try again, returning only JSON.' },
          { role: 'user' as const, content: `Reason: ${lastError ?? 'invalid_json'}. Return ONLY the JSON object — no prose, no backticks.` },
        ];

    const { response } = await args.ollama.chatPrimitive({
      taskType: args.taskType,
      category: args.category,
      userId: args.userId,
      tenantId: args.tenantId,
      request: { ...args.request, messages },
    });

    // v2.7 (angry-QA-found): the previous local regex
    //   `text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()`
    // was the same bug class as the original ollama-provider.ts strip
    // (case-insensitive, unclosed, and nested tag leaks). Codex's repro
    // showed nested `<think>OUTER<think>INNER</think>STILL_SECRET</think>{...}`
    // emitting `STILL_SECRET</think>{...}` which then failed JSON parse —
    // but the SECRET text WAS visible briefly and could have leaked to
    // logs in any future code path that touched it.
    //
    // Use the centralized depth-tracking parser from ollama-provider so
    // there's only one implementation to harden.
    const raw = response.message?.content ?? '';
    const text = stripThinkBlocks(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      lastError = 'json_parse_failure';
      continue;
    }
    const v = args.validate(parsed);
    if (v.ok) return v.value;
    lastError = v.reason;
  }
  throw new LocalLLMError('invalid_json', { taskType: 'scriptGeneration', step: args.step, reason: lastError });
}
