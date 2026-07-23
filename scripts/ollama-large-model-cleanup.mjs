#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  OLLAMA_DELETE_TAGS,
  OLLAMA_DIGEST_PATTERN,
  OLLAMA_RETAINED_TAG,
  readSecureJsonEvidence,
  validateOllamaSoakEvidence,
} from './ollama-soak-evidence.mjs';

const RESULT_SCHEMA = 'nexus.ollama-large-model-cleanup-result.v1';
const RETAINED_TAG = OLLAMA_RETAINED_TAG;
const DELETE_TAGS = OLLAMA_DELETE_TAGS;
const EXPECTED_TAGS = new Set([RETAINED_TAG, ...DELETE_TAGS]);
const DIGEST_PATTERN = OLLAMA_DIGEST_PATTERN;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function usage() {
  process.stdout.write(`Usage:
  ollama-large-model-cleanup.mjs --evidence <mode-0600.json> [--dry-run]
  ollama-large-model-cleanup.mjs --evidence <mode-0600.json> --apply \\
    --owner-authorized --ack-plan <sha256:...> --result <absolute-path>

Options:
  --expected-host <name>            Evidence host (default: serverdominguez)
  --ollama-url <loopback-url>       Ollama endpoint (default: http://127.0.0.1:11434)
  --ollama-bin <path>               Ollama CLI (default: ollama)
  --max-evidence-age-hours <1-72>   Evidence freshness (default: 24)
`);
}

function parseArgs(argv) {
  const values = {
    mode: 'dry-run',
    expectedHost: 'serverdominguez',
    ollamaUrl: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    ollamaBin: 'ollama',
    maxEvidenceAgeHours: 24,
    ownerAuthorized: false,
  };
  let explicitMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length || argv[index].startsWith('--')) fail(`missing value for ${arg}`, 64);
      return argv[index];
    };
    switch (arg) {
      case '--evidence': values.evidencePath = next(); break;
      case '--expected-host': values.expectedHost = next(); break;
      case '--ollama-url': values.ollamaUrl = next(); break;
      case '--ollama-bin': values.ollamaBin = next(); break;
      case '--max-evidence-age-hours': values.maxEvidenceAgeHours = Number(next()); break;
      case '--ack-plan': values.ackPlan = next(); break;
      case '--result': values.resultPath = next(); break;
      case '--owner-authorized': values.ownerAuthorized = true; break;
      case '--dry-run':
        if (explicitMode && values.mode !== 'dry-run') fail('--dry-run and --apply are mutually exclusive', 64);
        values.mode = 'dry-run';
        explicitMode = true;
        break;
      case '--apply':
        if (explicitMode && values.mode !== 'apply') fail('--dry-run and --apply are mutually exclusive', 64);
        values.mode = 'apply';
        explicitMode = true;
        break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: fail(`unknown argument: ${arg}`, 64);
    }
  }

  if (!values.evidencePath) fail('--evidence is required', 64);
  if (!values.expectedHost || /[\r\n]/.test(values.expectedHost)) fail('--expected-host is invalid', 64);
  if (!Number.isInteger(values.maxEvidenceAgeHours)
      || values.maxEvidenceAgeHours < 1
      || values.maxEvidenceAgeHours > 72) {
    fail('--max-evidence-age-hours must be an integer from 1 through 72', 64);
  }
  if (values.mode === 'dry-run') {
    if (values.ownerAuthorized || values.ackPlan || values.resultPath) {
      fail('authorization, acknowledgment, and result arguments are apply-only', 64);
    }
  } else {
    if (!values.ownerAuthorized) fail('--owner-authorized is required for apply', 64);
    if (!DIGEST_PATTERN.test(values.ackPlan || '')) {
      fail('--ack-plan must be the exact sha256 token printed by a fresh dry-run', 64);
    }
    if (!values.resultPath || !isAbsolute(values.resultPath)) {
      fail('--result must be a new absolute path for apply', 64);
    }
  }
  return values;
}

function normalizeRuntimeDigest(value, label) {
  if (typeof value !== 'string') fail(`${label} is missing`);
  if (/^[0-9a-f]{64}$/.test(value)) return `sha256:${value}`;
  if (DIGEST_PATTERN.test(value)) return value;
  fail(`${label} is not a full lowercase sha256 digest`);
}

function normalizeLoopbackUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('--ollama-url must be a valid loopback HTTP URL', 64);
  }
  if (parsed.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !['', '/'].includes(parsed.pathname)) {
    fail('--ollama-url must be an unauthenticated loopback HTTP origin', 64);
  }
  return parsed.origin;
}

async function fetchOllamaJson(origin, path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${origin}${path}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) fail(`Ollama ${path} returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) fail(`Ollama ${path} response is too large`);
    try {
      return JSON.parse(text);
    } catch {
      fail(`Ollama ${path} response is not valid JSON`);
    }
  } catch (error) {
    if (error?.exitCode) throw error;
    fail(`unable to read Ollama ${path}`);
  } finally {
    clearTimeout(timeout);
  }
}

function modelIdentity(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label} entry is invalid`);
  const names = [entry.name, entry.model].filter((value) => typeof value === 'string' && value.length > 0);
  if (names.length === 0 || new Set(names).size !== 1) fail(`${label} tag identity is missing or ambiguous`);
  return names[0];
}

async function readRuntimeState(origin) {
  const tagsBody = await fetchOllamaJson(origin, '/api/tags');
  const psBody = await fetchOllamaJson(origin, '/api/ps');
  if (!Array.isArray(tagsBody?.models) || !Array.isArray(psBody?.models)) {
    fail('Ollama inventory or loaded-model response is malformed');
  }
  const inventory = tagsBody.models.map((entry, index) => {
    const tag = modelIdentity(entry, `inventory[${index}]`);
    return { tag, digest: normalizeRuntimeDigest(entry.digest, `inventory digest for ${tag}`) };
  });
  const loaded = psBody.models.map((entry, index) => modelIdentity(entry, `loaded[${index}]`));
  if (new Set(inventory.map((entry) => entry.tag)).size !== inventory.length) fail('Ollama inventory contains duplicate tags');
  if (new Set(loaded).size !== loaded.length) fail('Ollama loaded-model response contains duplicate tags');
  return { inventory, loaded };
}

function validateRuntimeState(runtime, evidence) {
  if (runtime.inventory.length !== EXPECTED_TAGS.size) fail('Ollama inventory is missing an expected tag or contains an unexpected tag');
  const inventoryByTag = new Map(runtime.inventory.map((entry) => [entry.tag, entry]));
  for (const entry of runtime.inventory) {
    if (!EXPECTED_TAGS.has(entry.tag)) fail(`unexpected Ollama inventory tag: ${entry.tag}`);
  }
  const expectedModels = [evidence.retained, ...evidence.deleteModels];
  for (const expected of expectedModels) {
    const actual = inventoryByTag.get(expected.tag);
    if (!actual) fail(`expected Ollama inventory tag is missing: ${expected.tag}`);
    if (actual.digest !== expected.digest) fail(`Ollama digest mismatch for ${expected.tag}`);
  }
  for (const tag of runtime.loaded) {
    if (!EXPECTED_TAGS.has(tag)) fail(`unexpected loaded Ollama tag: ${tag}`);
    if (DELETE_TAGS.includes(tag)) fail(`deletion target is still loaded: ${tag}`);
  }
  return expectedModels;
}

function runtimeFingerprint(runtime) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({
      inventory: [...runtime.inventory].sort((a, b) => a.tag.localeCompare(b.tag)),
      loaded: [...runtime.loaded].sort(),
    }))
    .digest('hex')}`;
}

function makePlan(evidenceFile, evidence, runtime, expectedHost) {
  const fingerprint = runtimeFingerprint(runtime);
  const core = {
    schema: 'nexus.ollama-large-model-cleanup-plan.v1',
    host: expectedHost,
    evidenceDigest: evidenceFile.digest,
    inventoryFingerprint: fingerprint,
    retained: evidence.retained,
    delete: evidence.deleteModels,
  };
  return {
    ...core,
    ackPlan: `sha256:${createHash('sha256').update(JSON.stringify(core)).digest('hex')}`,
  };
}

function prepareResultPath(path) {
  const absolute = resolve(path);
  if (!isAbsolute(path)) fail('result path must be absolute', 64);
  const parent = dirname(absolute);
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail('result parent must be a non-symlink directory');
  }
  if (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid()) {
    fail('result parent must be owned by the account running the cleanup gate');
  }
  if ((parentInfo.mode & 0o022) !== 0) {
    fail('result parent must not be group- or world-writable');
  }
  try {
    lstatSync(absolute);
    fail('result path already exists; refusing to overwrite cleanup evidence');
  } catch (error) {
    if (error?.exitCode) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return absolute;
}

function writeResult(path, value, initial = false) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (initial) {
    // `wx` closes the check/create race: a competing or stale result record
    // can never be silently overwritten before mutation begins.
    writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return;
  }
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const origin = normalizeLoopbackUrl(options.ollamaUrl);
  const evidenceFile = readSecureJsonEvidence(options.evidencePath, 'cleanup evidence');
  const evidence = validateOllamaSoakEvidence(evidenceFile, {
    expectedHost: options.expectedHost,
    maxEvidenceAgeHours: options.maxEvidenceAgeHours,
  });
  const initialRuntime = await readRuntimeState(origin);
  validateRuntimeState(initialRuntime, evidence);
  const plan = makePlan(evidenceFile, evidence, initialRuntime, options.expectedHost);

  if (options.mode === 'dry-run') {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      mutationAttempted: false,
      ...plan,
    }, null, 2)}\n`);
    return;
  }

  if (options.ackPlan !== plan.ackPlan) fail('acknowledgment does not match the fresh cleanup plan');
  const resultPath = prepareResultPath(options.resultPath);

  // Re-read immediately before mutation. Any inventory, digest, or residency
  // change invalidates the dry-run-derived acknowledgment.
  const preDeleteRuntime = await readRuntimeState(origin);
  validateRuntimeState(preDeleteRuntime, evidence);
  const preDeletePlan = makePlan(evidenceFile, evidence, preDeleteRuntime, options.expectedHost);
  if (preDeletePlan.ackPlan !== options.ackPlan) fail('Ollama state changed after plan validation; run a new dry-run');

  const startedAt = new Date().toISOString();
  const result = {
    schema: RESULT_SCHEMA,
    host: options.expectedHost,
    status: 'started',
    startedAt,
    completedAt: null,
    plan,
  };
  writeResult(resultPath, result, true);

  const removal = spawnSync(options.ollamaBin, ['rm', ...DELETE_TAGS], {
    encoding: 'utf8',
    env: { ...process.env, OLLAMA_HOST: origin },
    shell: false,
    timeout: 10 * 60 * 1000,
  });
  if (removal.error || removal.status !== 0 || removal.signal) {
    writeResult(resultPath, {
      ...result,
      status: 'failed',
      completedAt: new Date().toISOString(),
      failure: 'ollama_rm_failed',
    });
    fail('Ollama refused the verified large-model removal; inspect the mode-0600 result record');
  }

  const finalRuntime = await readRuntimeState(origin);
  const expectedFinal = [{ tag: evidence.retained.tag, digest: evidence.retained.digest }];
  if (finalRuntime.inventory.length !== 1
      || finalRuntime.inventory[0].tag !== expectedFinal[0].tag
      || finalRuntime.inventory[0].digest !== expectedFinal[0].digest
      || finalRuntime.loaded.some((tag) => tag !== RETAINED_TAG)) {
    writeResult(resultPath, {
      ...result,
      status: 'failed',
      completedAt: new Date().toISOString(),
      failure: 'post_delete_verification_failed',
    });
    fail('post-delete inventory did not contain only the retained model at its verified digest');
  }

  const completed = {
    ...result,
    status: 'complete',
    completedAt: new Date().toISOString(),
    finalInventory: expectedFinal,
    retainedDigestVerifiedBeforeAndAfter: true,
  };
  writeResult(resultPath, completed);
  process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`ollama_cleanup_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
