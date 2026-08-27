#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  TEN_SCRIPT_ACCEPTANCE_REVISION,
  TEN_SCRIPT_ACCEPTANCE_SCENARIOS,
  TEN_SCRIPT_ACCEPTANCE_SCHEMA,
  TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA,
  validateAcceptanceStateShape,
  validateCompletedReleaseView,
} from './content-ten-script-acceptance.mjs';

export { validateCompletedReleaseView };

export const CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA = 'nexus.content-ten-script-evidence.v6';
export const CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA =
  'nexus.content-ten-script-quality-review.v1';
export const CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA =
  'nexus.content-script-runtime-release.v1';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const RELEASE_ID = /^[0-9a-f]{32}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DELIVERY_COUNTS = Object.freeze({ standard: 4, scheduled: 3, priority: 3 });
export const OPERATION_USAGE_EVIDENCE_SCHEMA = 'nexus.production-operation-usage.v3';
export const OPERATION_USAGE_CLASSIFICATION_VERSION = '2026-08-26.v3';
export const ACCEPTANCE_SOURCE_BINDING_SCHEMA = 'nexus.acceptance-source-binding.v2';
export const IMMUTABLE_TOOL_SOURCE_SCHEMA = 'nexus.immutable-tool-source.v1';
export const IMMUTABLE_TOOL_SOURCE_BINDING_SCHEMA = 'nexus.immutable-tool-source-binding.v1';
export const CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES = Object.freeze([
  'scripts/content-ten-script-acceptance.mjs',
  'scripts/content-ten-script-evidence.mjs',
]);
export const CONTENT_SCRIPT_JOB_EVIDENCE_KEYS_SCHEMA =
  'nexus.content-script-job-evidence-keys.v1';
const CONTENT_TEN_SCRIPT_EVIDENCE_ENTRYPOINT = 'scripts/content-ten-script-evidence.mjs';
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAX_TOOL_MODULE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_CLOSURE_BYTES = 16 * 1024 * 1024;
export const OPERATION_USAGE_BASE_CATEGORIES = Object.freeze({
  standardOp: Object.freeze(['ios_chat_message', 'ios_websocket_chat']),
  // The separately-priced deep credit surface is still reserved. Existing
  // deep Content research is the conservative production-token proxy until
  // that surface is deliberately activated.
  deepOp: Object.freeze(['content_engine_script_deep', 'content_engine_deepsearch']),
});
const OPERATION_USAGE_CATEGORIES = Object.freeze(
  Object.values(OPERATION_USAGE_BASE_CATEGORIES).flat(),
);
const OPERATION_USAGE_CATEGORY_SQL = OPERATION_USAGE_CATEGORIES
  .map((category) => `'${category}'`).join(', ');
const OPERATION_USAGE_WINDOW_DAYS = 90;
export const EXPECTED_SCRIPT_PROVIDER = 'openai';
export const EXPECTED_SCRIPT_MODEL = 'gpt-5.6-luna';
const CONTENT_SCRIPT_USAGE_CATEGORIES = Object.freeze([
  'content_script_job_script_outline',
  'content_script_job_script_outline_final_repair',
  'content_script_job_script_outline_repair',
  'content_script_job_script_section',
  'content_script_job_script_section_final_repair',
  'content_script_job_script_section_repair',
  'content_script_job_script_section_continuation',
]);
const CONTENT_SCRIPT_USAGE_CATEGORY_SQL = CONTENT_SCRIPT_USAGE_CATEGORIES
  .map((category) => `'${category}'`).join(', ');

function refuse(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

export function safeEvidenceCliFailureMessage(error) {
  if (Number.isInteger(error?.exitCode) && typeof error?.message === 'string') {
    return error.message;
  }
  return error instanceof Error ? error.name : typeof error;
}

function option(name, required = false) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if ((index >= 0 && (!value || value.startsWith('--'))) || (required && index < 0)) {
    refuse(`${name} requires a value`, 64);
  }
  return value;
}

function sameFileSnapshot(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    refuse(`${label} fields do not match the governed schema`, 65);
  }
  return value;
}

function canonicalParentPath(filename, label, { create = false, privateLeaf = false } = {}) {
  const absolute = path.resolve(filename);
  const requestedParent = path.dirname(absolute);
  const missing = [];
  let existing = requestedParent;
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) {
        refuse(`${label} parent is not accessible`, 77);
      }
      const next = path.dirname(existing);
      if (next === existing) refuse(`${label} parent is not accessible`, 77);
      missing.unshift(path.basename(existing));
      existing = next;
    }
  }

  let current;
  try {
    // Resolve any platform-owned aliases (for example macOS /var) once, then
    // use only the canonical path for every subsequent open/link operation.
    current = fs.realpathSync.native(existing);
  } catch {
    refuse(`${label} parent cannot be resolved safely`, 77);
  }
  for (const component of missing) {
    current = path.join(current, component);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') refuse(`${label} parent cannot be created safely`, 77);
    }
    const created = fs.lstatSync(current, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) {
      refuse(`${label} parent contains an unsafe path component`, 77);
    }
  }
  const parent = fs.lstatSync(current, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    refuse(`${label} parent must be a real directory`, 77);
  }
  if (privateLeaf) {
    const effectiveUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : parent.uid;
    if ((parent.mode & 0o777n) !== 0o700n || parent.uid !== effectiveUid) {
      refuse(`${label} parent must be an owner-controlled mode-0700 directory`, 77);
    }
  }
  return path.join(current, path.basename(absolute));
}

function assertPrivateFileStat(stat, label) {
  const effectiveUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : stat.uid;
  if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n
      || stat.uid !== effectiveUid) {
    refuse(`${label} must be an owner-controlled mode-0600, single-link regular file`, 77);
  }
  return stat;
}

export function assertPrivateRegularFile(filename, label) {
  const canonical = canonicalParentPath(filename, label, { privateLeaf: true });
  let descriptor;
  try {
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return assertPrivateFileStat(fs.fstatSync(descriptor, { bigint: true }), label);
  } catch (error) {
    if (error?.exitCode) throw error;
    refuse(`${label} is not a no-follow regular file`, 77);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertRegularFileNoSymlink(filename, label) {
  const canonical = canonicalParentPath(filename, label);
  let descriptor;
  try {
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) refuse(`${label} must be a regular file and not a symbolic link`, 77);
    return { dev: stat.dev, ino: stat.ino, canonical };
  } catch (error) {
    if (error?.exitCode) throw error;
    refuse(`${label} is not a no-follow regular file`, 77);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function acceptanceSourceBindingSha256(
  workloadSourceSha,
  producerSourceSha,
  producerToolBindingSha256,
) {
  if (!FULL_SHA.test(workloadSourceSha) || !FULL_SHA.test(producerSourceSha)) {
    refuse('acceptance source binding requires exact workload and producer commits', 65);
  }
  if (workloadSourceSha === producerSourceSha) {
    refuse('acceptance workload and evidence-producer commits must be distinct', 65);
  }
  if (!SHA256.test(producerToolBindingSha256 ?? '')) {
    refuse('acceptance source binding requires the immutable evidence-producer tool binding', 65);
  }
  return sha256(Buffer.from(
    `${ACCEPTANCE_SOURCE_BINDING_SCHEMA}\n${workloadSourceSha}\n${producerSourceSha}\n${producerToolBindingSha256}\n`,
  ));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function cleanGitEnvironment() {
  const environment = {
    ...process.env,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE',
    'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_CONFIG', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  ]) delete environment[key];
  return environment;
}

function git(repositoryRoot, args, { encoding = 'utf8' } = {}) {
  try {
    return execFileSync('/usr/bin/git', args, {
      cwd: repositoryRoot,
      encoding,
      env: cleanGitEnvironment(),
      maxBuffer: MAX_TOOL_CLOSURE_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    refuse('immutable producer tool source could not be resolved from Git', 78);
  }
}

function safeRepositoryRelativePath(value, label) {
  if (typeof value !== 'string' || value.length < 1 || !/^[A-Za-z0-9._/-]+$/u.test(value)
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
      || value === '..' || value.startsWith('../')) {
    refuse(`${label} is not a safe repository-relative path`, 65);
  }
  return value;
}

function governedModulePaths(modulePaths) {
  if (!Array.isArray(modulePaths) || modulePaths.length < 1 || modulePaths.length > 32) {
    refuse('immutable producer tool requires a bounded governed module list', 65);
  }
  const paths = modulePaths.map((modulePath) => (
    safeRepositoryRelativePath(modulePath, 'immutable tool module path')
  ));
  if (new Set(paths).size !== paths.length) {
    refuse('immutable producer tool governed module list contains duplicates', 65);
  }
  return paths.sort();
}

function immutableToolModulePayload(module) {
  return {
    path: module.path,
    gitMode: module.gitMode,
    gitBlobObjectId: module.gitBlobObjectId,
    sha256: module.sha256,
    byteLength: module.byteLength,
  };
}

function immutableToolClosureSha256(producerSourceSha, entrypoint, modules) {
  return sha256(Buffer.from(stableJson({
    schemaVersion: IMMUTABLE_TOOL_SOURCE_SCHEMA,
    producerSourceSha,
    entrypoint,
    modules: modules.map(immutableToolModulePayload),
  })));
}

function immutableToolBindingSha256(producerSourceSha, entrypoint, closureSha256) {
  return sha256(Buffer.from(
    `${IMMUTABLE_TOOL_SOURCE_BINDING_SCHEMA}\n${producerSourceSha}\n${entrypoint}\n${closureSha256}\n`,
  ));
}

export function buildImmutableToolSourceBinding({ producerSourceSha, entrypoint, modules }) {
  if (!FULL_SHA.test(producerSourceSha ?? '')) {
    refuse('immutable producer tool source requires an exact commit', 65);
  }
  const safeEntrypoint = safeRepositoryRelativePath(entrypoint, 'immutable tool entrypoint');
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > 32) {
    refuse('immutable producer tool source requires a bounded module closure', 65);
  }
  const normalized = modules.map((module, index) => {
    assertExactKeys(module, [
      'path', 'gitMode', 'gitBlobObjectId', 'sha256', 'byteLength',
    ], `immutable tool module ${index + 1}`);
    const modulePath = safeRepositoryRelativePath(
      module.path,
      `immutable tool module ${index + 1} path`,
    );
    if (!['100644', '100755'].includes(module.gitMode)
        || !GIT_OBJECT_ID.test(module.gitBlobObjectId ?? '')
        || !SHA256.test(module.sha256 ?? '')
        || !Number.isSafeInteger(module.byteLength) || module.byteLength < 1
        || module.byteLength > MAX_TOOL_MODULE_BYTES) {
      refuse(`immutable tool module ${modulePath} identity is invalid`, 65);
    }
    return immutableToolModulePayload({ ...module, path: modulePath });
  }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (new Set(normalized.map((module) => module.path)).size !== normalized.length
      || !normalized.some((module) => module.path === safeEntrypoint)
      || normalized.reduce((sum, module) => sum + module.byteLength, 0) > MAX_TOOL_CLOSURE_BYTES) {
    refuse('immutable producer tool module closure is duplicate, incomplete, or oversized', 65);
  }
  const closureSha256 = immutableToolClosureSha256(
    producerSourceSha,
    safeEntrypoint,
    normalized,
  );
  return {
    schemaVersion: IMMUTABLE_TOOL_SOURCE_SCHEMA,
    producerSourceSha,
    entrypoint: safeEntrypoint,
    modules: normalized,
    closureSha256,
    bindingSha256: immutableToolBindingSha256(
      producerSourceSha,
      safeEntrypoint,
      closureSha256,
    ),
  };
}

export function validateImmutableToolSourceBinding(
  value,
  { producerSourceSha, entrypoint, modulePaths },
) {
  assertExactKeys(value, [
    'schemaVersion', 'producerSourceSha', 'entrypoint', 'modules',
    'closureSha256', 'bindingSha256',
  ], 'immutable producer tool source');
  if (value.schemaVersion !== IMMUTABLE_TOOL_SOURCE_SCHEMA
      || value.producerSourceSha !== producerSourceSha || value.entrypoint !== entrypoint) {
    refuse('immutable producer tool source identity is invalid', 65);
  }
  const rebuilt = buildImmutableToolSourceBinding({
    producerSourceSha: value.producerSourceSha,
    entrypoint: value.entrypoint,
    modules: value.modules,
  });
  const expectedPaths = governedModulePaths(modulePaths);
  if (stableJson(rebuilt) !== stableJson(value)
      || stableJson(rebuilt.modules.map((module) => module.path)) !== stableJson(expectedPaths)) {
    refuse('immutable producer tool source closure or digest is invalid', 65);
  }
  return rebuilt;
}

function readStableToolModule(filename, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n
        || before.size > BigInt(MAX_TOOL_MODULE_BYTES)) {
      refuse(`${label} must be a bounded, single-link regular file`, 78);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after) || bytes.length !== Number(after.size)) {
      refuse(`${label} changed while its immutable identity was read`, 78);
    }
    return bytes;
  } catch (error) {
    if (error?.exitCode) throw error;
    refuse(`${label} is not a stable no-follow file`, 78);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function resolveImmutableToolSourceBinding({
  producerSourceSha,
  entrypoint,
  modulePaths,
  sourceRoot,
  repositoryPath = sourceRoot,
}) {
  if (!FULL_SHA.test(producerSourceSha ?? '')) {
    refuse('immutable producer tool source requires an exact commit', 65);
  }
  let canonicalSourceRoot;
  let repositoryRoot;
  try {
    canonicalSourceRoot = fs.realpathSync.native(path.resolve(sourceRoot));
    const requestedRepository = fs.realpathSync.native(path.resolve(repositoryPath));
    repositoryRoot = fs.realpathSync.native(String(git(
      requestedRepository,
      ['rev-parse', '--show-toplevel'],
    )).trim());
  } catch (error) {
    if (error?.exitCode) throw error;
    refuse('immutable producer tool source roots cannot be resolved safely', 78);
  }
  const resolvedCommit = String(git(repositoryRoot, [
    'rev-parse', '--verify', '--end-of-options', `${producerSourceSha}^{commit}`,
  ])).trim();
  if (resolvedCommit !== producerSourceSha) {
    refuse('producer source SHA does not resolve to the exact receipt-bound commit', 78);
  }

  const expectedPaths = governedModulePaths(modulePaths);
  const modules = expectedPaths.map((modulePath) => {
    const expectedFile = path.join(canonicalSourceRoot, ...modulePath.split('/'));
    let canonicalFile;
    try {
      canonicalFile = fs.realpathSync.native(expectedFile);
    } catch {
      refuse(`immutable producer tool module ${modulePath} is missing`, 78);
    }
    if (canonicalFile !== expectedFile) {
      refuse(`immutable producer tool module ${modulePath} traverses a symbolic link`, 78);
    }
    const bytes = readStableToolModule(canonicalFile, `immutable producer tool module ${modulePath}`);
    const treeOutput = String(git(repositoryRoot, [
      'ls-tree', '-z', producerSourceSha, '--', modulePath,
    ]));
    const records = treeOutput.split('\0').filter(Boolean);
    const match = records.length === 1
      ? /^(\d{6}) (\S+) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([\s\S]+)$/u.exec(records[0])
      : null;
    if (!match || match[2] !== 'blob' || match[4] !== modulePath
        || !['100644', '100755'].includes(match[1])) {
      refuse(`producer commit does not contain the governed module ${modulePath}`, 78);
    }
    const committedBytes = git(repositoryRoot, ['cat-file', 'blob', match[3]], { encoding: 'buffer' });
    if (!Buffer.isBuffer(committedBytes) || !bytes.equals(committedBytes)) {
      refuse(`executing module ${modulePath} differs from producer commit ${producerSourceSha}`, 78);
    }
    return {
      path: modulePath,
      gitMode: match[1],
      gitBlobObjectId: match[3],
      sha256: sha256(bytes),
      byteLength: bytes.length,
    };
  });
  return buildImmutableToolSourceBinding({ producerSourceSha, entrypoint, modules });
}

function countWords(value) {
  return String(value ?? '').trim().split(/\s+/u).filter(Boolean).length;
}

function contentJobDerivedKey(secret, info) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from('nexushub-content-script-jobs-v2', 'utf8'),
    Buffer.from(info, 'utf8'),
    32,
  ));
}

function contentJobKeyVersion(secret) {
  return crypto.createHash('sha256')
    .update(contentJobDerivedKey(secret, 'key-version'))
    .digest('hex')
    .slice(0, 16);
}

function validateContentJobEvidenceKeys(value) {
  assertExactKeys(value, ['schemaVersion', 'keys'], 'content script evidence keys');
  if (value.schemaVersion !== CONTENT_SCRIPT_JOB_EVIDENCE_KEYS_SCHEMA
      || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 8
      || value.keys.some((key) => typeof key !== 'string'
        || Buffer.byteLength(key, 'utf8') < 32)
      || new Set(value.keys).size !== value.keys.length) {
    refuse('content script evidence keys do not match the governed schema', 65);
  }
  return value.keys;
}

function decryptContentJobEvidenceJson(stored, userId, keys, label) {
  let envelope;
  try {
    envelope = JSON.parse(stored);
  } catch {
    refuse(`${label} is not a valid encrypted envelope`, 78);
  }
  assertExactKeys(envelope, ['schema', 'keyVersion', 'ciphertext'], label);
  if (envelope.schema !== 'nexus.content-script-job-encrypted.v3'
      || !/^[0-9a-f]{16}$/u.test(envelope.keyVersion)
      || !/^[0-9a-f]+$/u.test(envelope.ciphertext)
      || envelope.ciphertext.length % 2 !== 0) {
    refuse(`${label} is not an authenticated v3 envelope`, 78);
  }
  const packed = Buffer.from(envelope.ciphertext, 'hex');
  if (packed.length < 28) refuse(`${label} ciphertext is truncated`, 78);
  const matchingKeys = keys.filter((secret) => contentJobKeyVersion(secret) === envelope.keyVersion);
  if (matchingKeys.length !== 1) refuse(`${label} key identity is unavailable or ambiguous`, 78);
  try {
    const secret = matchingKeys[0];
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      contentJobDerivedKey(secret, `user:${userId}`),
      packed.subarray(0, 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(`${envelope.schema}\u0000${envelope.keyVersion}`, 'utf8'));
    decipher.setAuthTag(packed.subarray(12, 28));
    const plaintext = decipher.update(packed.subarray(28), undefined, 'utf8')
      + decipher.final('utf8');
    return JSON.parse(plaintext);
  } catch {
    refuse(`${label} authentication or JSON decoding failed`, 78);
  }
}

function expectedScenarioRequest(scenario) {
  return {
    topic: scenario.topic,
    niche: 'general education',
    format: 'YouTube',
    mode: 'deep',
    deliveryMode: scenario.deliveryMode,
    language: scenario.language,
    renderMode: 'structured',
    scriptStyle: 'detailed',
    maxDurationMinutes: 15,
    targetDurationSeconds: 900,
    forceRefresh: true,
  };
}

function expectedScenarioRequestHash(scenario) {
  const request = expectedScenarioRequest(scenario);
  const { language, ...languageIndependent } = request;
  return crypto.createHash('sha256').update(stableJson({
    ...languageIndependent,
    languageIntent: { source: 'explicit', value: language },
    pinnedSources: [],
  })).digest('hex');
}

function validatePersistedScenarioPayloads(job, definition, acceptedScenario, keys) {
  const expected = expectedScenarioRequest(definition);
  const expectedTier = definition.deliveryMode === 'standard'
    ? 'flex' : definition.deliveryMode === 'scheduled' ? 'batch' : 'default';
  const expectedIdempotencyKey =
    `hybrid-plan-acceptance-${definition.id}-${TEN_SCRIPT_ACCEPTANCE_REVISION}`;
  if (job.idempotency_key !== expectedIdempotencyKey
      || job.request_hash !== expectedScenarioRequestHash(definition)
      || Number(job.target_duration_seconds) !== expected.targetDurationSeconds) {
    refuse(`persisted public request identity is invalid for ${definition.id}`, 78);
  }
  const request = decryptContentJobEvidenceJson(
    job.request_json,
    Number(job.owner_user_id),
    keys,
    `${definition.id} request`,
  );
  assertExactKeys(request, [
    ...Object.keys(expected),
    'pinnedScriptRoute', 'pinnedCloudProvider', 'pinnedCloudModel',
    'pinnedCloudServiceTier', 'pinnedCreatorVoice', 'pinnedSources',
  ], `${definition.id} persisted request`);
  if (Object.entries(expected).some(([key, value]) => request[key] !== value)
      || request.pinnedScriptRoute !== 'cloud_primary'
      || request.pinnedCloudProvider !== EXPECTED_SCRIPT_PROVIDER
      || request.pinnedCloudModel !== EXPECTED_SCRIPT_MODEL
      || request.pinnedCloudServiceTier !== expectedTier
      || (request.pinnedCreatorVoice !== null && typeof request.pinnedCreatorVoice !== 'string')
      || !Array.isArray(request.pinnedSources) || request.pinnedSources.length !== 0) {
    refuse(`persisted encrypted request is invalid for ${definition.id}`, 78);
  }
  const result = decryptContentJobEvidenceJson(
    job.result_json,
    Number(job.owner_user_id),
    keys,
    `${definition.id} result`,
  );
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.script !== 'string') {
    refuse(`persisted encrypted result is invalid for ${definition.id}`, 78);
  }
  const scriptSha256 = sha256(Buffer.from(result.script, 'utf8'));
  const wordCount = countWords(result.script);
  if (scriptSha256 !== acceptedScenario.output.scriptSha256
      || wordCount !== acceptedScenario.output.wordCount) {
    refuse(`persisted script result does not match reviewed state for ${definition.id}`, 78);
  }
  return { scriptSha256, wordCount };
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function assertCanonicalTimestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const normalized = typeof value === 'string' && !value.includes('.')
    ? value.replace(/Z$/u, '.000Z') : value;
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)
      || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    refuse(`${label} must be a canonical UTC timestamp`, 65);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    refuse(`${label} must be a lowercase sha256 digest`, 65);
  }
  return value;
}

function assertFiniteNumber(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || value < minimum || value > maximum) {
    refuse(`${label} must be a finite number between ${minimum} and ${maximum}`, 65);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    refuse(`${label} must be a positive safe integer`, 65);
  }
  return value;
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse(`${label} must be a nonnegative safe integer`, 65);
  }
  return value;
}

function boundedString(value, label, maximumBytes) {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    refuse(`${label} must be a non-empty bounded string`, 65);
  }
  return value;
}

function scopeSha256(tenantId, userId) {
  return sha256(Buffer.from(`nexus-tenant-user-scope-v1\n${tenantId}\n${userId}\n`));
}

function roundUpUsd(value) {
  return Number((Math.ceil((value - Number.EPSILON) * 1_000_000) / 1_000_000).toFixed(6));
}

function usageP95(rows, label) {
  if (!Array.isArray(rows) || rows.length < 1) {
    refuse(`${label} has no scoped production api_usage samples in the 90-day window`, 78);
  }
  const normalized = rows.map((row, index) => ({
    inputTokens: assertNonnegativeInteger(Number(row.input_tokens), `${label} sample ${index + 1} inputTokens`),
    outputTokens: assertNonnegativeInteger(Number(row.output_tokens), `${label} sample ${index + 1} outputTokens`),
    modelCostUsd: assertFiniteNumber(Number(row.model_cost_usd), `${label} sample ${index + 1} modelCostUsd`, {
      maximum: 1_000_000,
    }),
    toolCostUsd: assertFiniteNumber(Number(row.tool_cost_usd), `${label} sample ${index + 1} toolCostUsd`, {
      maximum: 1_000_000,
    }),
    unresolvedRows: Number(row.unresolved_rows),
    completedAttempts: Number(row.completed_attempts),
  }));
  if (normalized.some((row) => !Number.isSafeInteger(row.unresolvedRows) || row.unresolvedRows !== 0)) {
    refuse(`${label} includes api_usage rows without resolved pricing`, 78);
  }
  if (normalized.some((row) => !Number.isSafeInteger(row.completedAttempts)
      || row.completedAttempts < 0)) {
    refuse(`${label} includes an invalid completed-attempt count`, 78);
  }
  const completed = normalized.filter((row) => row.completedAttempts > 0);
  const failedOnly = normalized.filter((row) => row.completedAttempts === 0);
  if (completed.length < 1) {
    refuse(`${label} has no completed production operation to receive failed-only overhead`, 78);
  }
  const failedOnlyTotals = failedOnly.reduce((total, row) => ({
    inputTokens: total.inputTokens + row.inputTokens,
    outputTokens: total.outputTokens + row.outputTokens,
    modelCostUsd: total.modelCostUsd + row.modelCostUsd,
    toolCostUsd: total.toolCostUsd + row.toolCostUsd,
  }), { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCostUsd: 0 });
  // Failed-only operations consume provider budget without consuming user
  // credits. Amortize their complete measured overhead across completed
  // operations in the same governed class. Integer tokens and six-decimal USD
  // are rounded upward so the allocation can never improve projected margin.
  const failedOnlyAllocation = {
    inputTokens: Math.ceil(failedOnlyTotals.inputTokens / completed.length),
    outputTokens: Math.ceil(failedOnlyTotals.outputTokens / completed.length),
    modelCostUsd: roundUpUsd(failedOnlyTotals.modelCostUsd / completed.length),
    toolCostUsd: roundUpUsd(failedOnlyTotals.toolCostUsd / completed.length),
  };
  const allocated = completed.map((row) => ({
    inputTokens: row.inputTokens + failedOnlyAllocation.inputTokens,
    outputTokens: row.outputTokens + failedOnlyAllocation.outputTokens,
    modelCostUsd: row.modelCostUsd + failedOnlyAllocation.modelCostUsd,
    toolCostUsd: row.toolCostUsd + failedOnlyAllocation.toolCostUsd,
  }));
  return {
    sampleCount: completed.length,
    failedOnlyOperationCount: failedOnly.length,
    failedOnlyInputTokensAllocated: failedOnlyAllocation.inputTokens,
    failedOnlyOutputTokensAllocated: failedOnlyAllocation.outputTokens,
    failedOnlyModelCostUsdAllocated: failedOnlyAllocation.modelCostUsd,
    failedOnlyToolCostUsdAllocated: failedOnlyAllocation.toolCostUsd,
    inputTokens: assertPositiveInteger(p95(allocated.map((row) => row.inputTokens)), `${label} p95 inputTokens`),
    outputTokens: assertPositiveInteger(p95(allocated.map((row) => row.outputTokens)), `${label} p95 outputTokens`),
    modelCostUsd: Number(p95(allocated.map((row) => row.modelCostUsd)).toFixed(6)),
    toolCostUsd: Number(p95(allocated.map((row) => row.toolCostUsd)).toFixed(6)),
  };
}

export function readPrivateBytes(filename, label) {
  const canonical = canonicalParentPath(filename, label, { privateLeaf: true });
  let descriptor;
  try {
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = assertPrivateFileStat(fs.fstatSync(descriptor, { bigint: true }), label);
    const bytes = fs.readFileSync(descriptor);
    const after = assertPrivateFileStat(fs.fstatSync(descriptor, { bigint: true }), label);
    if (!sameFileSnapshot(before, after)) refuse(`${label} changed while it was read`, 75);
    return bytes;
  } catch (error) {
    if (error?.exitCode) throw error;
    refuse(`${label} is not readable through a no-follow descriptor`, 77);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function parsePrivateJson(filename, label) {
  const bytes = readPrivateBytes(filename, label);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse(`${label} is not valid JSON`, 65);
  }
  return { bytes, value };
}

export function atomicPrivateWrite(filename, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) refuse('private output must be nonempty bytes', 65);
  const canonical = canonicalParentPath(filename, 'evidence output', { create: true, privateLeaf: true });
  try {
    fs.lstatSync(canonical);
    refuse('refusing to replace existing evidence output', 73);
  } catch (error) {
    if (error?.exitCode) throw error;
    if (error?.code !== 'ENOENT') refuse('evidence output path is unsafe', 77);
  }
  const parent = path.dirname(canonical);
  const temporary = `${canonical}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // link(2) refuses EEXIST and therefore cannot replace an output created
    // after the initial check. Temp and destination share a filesystem.
    fs.linkSync(temporary, canonical);
    fs.unlinkSync(temporary);
    const directoryDescriptor = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  assertPrivateRegularFile(canonical, 'evidence output');
}

export function validateQualityReview(review, { state, stateSha256, workloadSourceSha }) {
  assertExactKeys(review, [
    'schemaVersion', 'acceptanceRevision', 'reviewedAt', 'workloadSourceSha', 'stateSha256',
    'reviewType', 'attestation', 'scenarios',
  ], 'quality review');
  if (!review || typeof review !== 'object' || Array.isArray(review)
      || review.schemaVersion !== CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA
      || review.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
      || review.workloadSourceSha !== workloadSourceSha || review.stateSha256 !== stateSha256
      || review.reviewType !== 'independent'
      || review.attestation !== 'no_critical_quality_regression'
      || !Array.isArray(review.scenarios) || review.scenarios.length !== 10) {
    refuse('quality review is not an independent, state-bound no-regression attestation', 78);
  }
  assertCanonicalTimestamp(review.reviewedAt, 'quality review reviewedAt');
  const ids = new Set();
  for (let index = 0; index < review.scenarios.length; index += 1) {
    const row = review.scenarios[index];
    const accepted = state.scenarios[index];
    assertExactKeys(row, [
      'id', 'scriptSha256', 'verdict', 'criticalRegressionCount',
    ], `quality review scenario ${accepted.id}`);
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || row.id !== accepted.id || row.scriptSha256 !== accepted.output?.scriptSha256
        || row.verdict !== 'pass' || row.criticalRegressionCount !== 0) {
      refuse(`quality review does not prove a clean pass for ${accepted.id}`, 78);
    }
    assertDigest(row.scriptSha256, `quality review ${accepted.id} scriptSha256`);
    ids.add(row.id);
  }
  if (ids.size !== 10) refuse('quality review scenario identities are not unique', 78);
  return review;
}

function validateAcceptanceState(state, workloadSourceSha, workloadRelease, workloadViewSha256) {
  try {
    validateAcceptanceStateShape(state);
  } catch (error) {
    refuse(error instanceof Error ? error.message : 'acceptance state shape is invalid', 65);
  }
  if (state?.schemaVersion !== TEN_SCRIPT_ACCEPTANCE_SCHEMA
      || state.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
      || !Array.isArray(state.scenarios) || state.scenarios.length !== 10) {
    refuse('acceptance state schema or inventory is invalid', 65);
  }
  if (state.scenarios.some((row, index) => {
    const expected = TEN_SCRIPT_ACCEPTANCE_SCENARIOS[index];
    return !expected || row.id !== expected.id || row.phase !== expected.phase
      || row.deliveryMode !== expected.deliveryMode || row.language !== expected.language
      || row.topicSha256 !== sha256(expected.topic);
  })) refuse('acceptance state differs from the immutable ten-scenario inventory', 65);
  const ids = new Set(state.scenarios.map((row) => row.id));
  const jobIds = new Set(state.scenarios.map((row) => row.jobId));
  if (ids.size !== 10 || jobIds.size !== 10
      || state.scenarios.some((row) => typeof row.jobId !== 'string' || row.jobId.length < 1)
      || state.scenarios.some((row) => row.status !== 'completed'
        || row.output?.contractPass !== true || row.output?.sourceConsistent !== true)) {
    refuse('all ten unique jobs must be completed and contract-valid', 78);
  }
  for (const scenario of state.scenarios) {
    assertDigest(scenario.output.scriptSha256, `${scenario.id} scriptSha256`);
    assertPositiveInteger(scenario.output.wordCount, `${scenario.id} wordCount`);
  }
  const binding = state.productionSmokeSource;
  if (!binding || binding.schemaVersion !== TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA
      || binding.sourceSha !== workloadSourceSha
      || binding.releaseViewSha256 !== workloadViewSha256
      || binding.releaseId !== workloadRelease.releaseId
      || binding.releasePayloadDigest !== workloadRelease.releasePayloadDigest
      || binding.receiptCompletedAt !== workloadRelease.receiptCompletedAt
      || binding.viewCapturedAt !== workloadRelease.capturedAt) {
    refuse('production-smoke source identity does not match --workload-source-sha', 78);
  }
  return state;
}

function productionSmokeRuntimeRelease(job, workloadRelease, workloadReleaseView) {
  const backendImageDigest = workloadReleaseView?.active?.images?.backend?.digest;
  if (!SHA256.test(backendImageDigest ?? '')) {
    refuse('workload release view does not bind the active backend image digest', 78);
  }
  const creation = {
    releaseId: job.created_release_id,
    sourceSha: job.created_release_source_sha,
    backendImageDigest: job.created_release_backend_digest,
  };
  const completion = {
    releaseId: job.completed_release_id,
    sourceSha: job.completed_release_source_sha,
    backendImageDigest: job.completed_release_backend_digest,
  };
  for (const [label, identity] of Object.entries({ creation, completion })) {
    if (!RELEASE_ID.test(identity.releaseId ?? '')
        || !FULL_SHA.test(identity.sourceSha ?? '')
        || !SHA256.test(identity.backendImageDigest ?? '')
        || identity.releaseId !== workloadRelease.releaseId
        || identity.sourceSha !== workloadRelease.sourceSha
        || identity.backendImageDigest !== backendImageDigest) {
      refuse(`production smoke ${label} runtime release does not match the bound workload receipt`, 78);
    }
  }
  return {
    schemaVersion: CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA,
    jobId: job.job_id,
    creation,
    completion,
  };
}

export async function main() {
  const statePath = path.resolve(option('--state', true));
  const qualityReviewPath = path.resolve(option('--quality-review', true));
  const workloadReleaseViewPath = path.resolve(option('--workload-release-view', true));
  const releaseViewPath = path.resolve(option('--release-view', true));
  const outputPath = path.resolve(option('--output', true));
  const workloadSourceSha = option('--workload-source-sha', true);
  const producerSourceSha = option('--producer-source-sha', true);
  const producerSourceRepository = option('--producer-source-repository', false);
  const scriptJobKeyPath = path.resolve(option('--script-job-key-file', true));
  if (!FULL_SHA.test(workloadSourceSha)) {
    refuse('--workload-source-sha must be an exact 40-character commit', 64);
  }
  if (!FULL_SHA.test(producerSourceSha)) {
    refuse('--producer-source-sha must be an exact 40-character commit', 64);
  }
  if (workloadSourceSha === producerSourceSha) {
    refuse('workload and evidence-producer commits must be distinct', 64);
  }
  const scriptJobKeyInput = parsePrivateJson(
    scriptJobKeyPath,
    'content script evidence keys',
  );
  const scriptJobKeys = validateContentJobEvidenceKeys(scriptJobKeyInput.value);

  const workloadReleaseViewInput = parsePrivateJson(
    workloadReleaseViewPath,
    'workload release state view',
  );
  const workloadRelease = validateCompletedReleaseView(
    workloadReleaseViewInput.value,
    workloadSourceSha,
  );
  const workloadReleaseViewSha256 = sha256(workloadReleaseViewInput.bytes);
  const stateInput = parsePrivateJson(statePath, 'acceptance state');
  const state = validateAcceptanceState(
    stateInput.value,
    workloadSourceSha,
    workloadRelease,
    workloadReleaseViewSha256,
  );
  const stateDigest = sha256(stateInput.bytes);
  const qualityInput = parsePrivateJson(qualityReviewPath, 'quality review evidence');
  const qualityReview = validateQualityReview(qualityInput.value, {
    state,
    stateSha256: stateDigest,
    workloadSourceSha,
  });
  const releaseViewInput = parsePrivateJson(releaseViewPath, 'release state view');
  const release = validateCompletedReleaseView(releaseViewInput.value, producerSourceSha);
  const sourceRoot = fs.realpathSync.native(
    path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  );
  let invokedEntrypoint;
  try {
    invokedEntrypoint = fs.realpathSync.native(path.resolve(process.argv[1] ?? ''));
  } catch {
    refuse('evidence producer entrypoint identity cannot be resolved', 78);
  }
  if (invokedEntrypoint !== path.join(sourceRoot, CONTENT_TEN_SCRIPT_EVIDENCE_ENTRYPOINT)) {
    refuse('evidence producer must execute its receipt-bound entrypoint directly', 78);
  }
  const producerToolSource = resolveImmutableToolSourceBinding({
    producerSourceSha,
    entrypoint: CONTENT_TEN_SCRIPT_EVIDENCE_ENTRYPOINT,
    modulePaths: CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
    sourceRoot,
    ...(producerSourceRepository ? { repositoryPath: producerSourceRepository } : {}),
  });
  const sourceBindingSha256 = acceptanceSourceBindingSha256(
    workloadSourceSha,
    producerSourceSha,
    producerToolSource.bindingSha256,
  );

  const databasePath = path.resolve(option('--database', false) || process.env.DATABASE_PATH || './data/bot.db');
  const databaseBefore = assertRegularFileNoSymlink(databasePath, 'database');
  const db = new Database(databaseBefore.canonical, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 5000');
  const jobQuery = db.prepare(`SELECT job_id, operation_id, tenant_id, owner_user_id,
      idempotency_key, request_hash, request_json, target_duration_seconds, result_json,
      status, delivery_mode, warning_codes_json, route, model_digest, created_at, completed_at,
      created_release_id, created_release_source_sha, created_release_backend_digest,
      completed_release_id, completed_release_source_sha, completed_release_backend_digest
    FROM content_script_jobs WHERE job_id = ?`);
  const usageQuery = db.prepare(`SELECT
      COALESCE(SUM(usage.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(usage.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(MAX(COALESCE(usage.cost_usd, 0)
        - COALESCE(usage.provider_tool_cost_usd, 0), 0)), 0) AS model_cost_usd,
      COALESCE(SUM(usage.provider_tool_cost_usd), 0) AS tool_cost_usd,
      SUM(CASE WHEN COALESCE(usage.input_tokens, 0) > 0
        OR COALESCE(usage.output_tokens, 0) > 0 OR COALESCE(usage.cost_usd, 0) > 0
        OR COALESCE(usage.provider_tool_cost_usd, 0) > 0 THEN 1 ELSE 0 END) AS usage_rows,
      SUM(CASE WHEN (COALESCE(usage.input_tokens, 0) > 0
          OR COALESCE(usage.output_tokens, 0) > 0 OR COALESCE(usage.cost_usd, 0) > 0
          OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)
        AND COALESCE(usage.pricing_status, '') <> 'resolved' THEN 1 ELSE 0 END) AS unresolved_rows,
      SUM(CASE WHEN inference.status = 'completed' AND (COALESCE(usage.input_tokens, 0) > 0
          OR COALESCE(usage.output_tokens, 0) > 0 OR COALESCE(usage.cost_usd, 0) > 0
          OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)
        AND (COALESCE(lower(trim(usage.provider)), '') <> ?
          OR COALESCE(trim(usage.model), '') <> ?)
        THEN 1 ELSE 0 END) AS routing_mismatch_rows
    FROM skill_inference_runs AS inference
    INNER JOIN api_usage AS usage ON usage.run_id = inference.run_id
      AND usage.tenant_id = inference.tenant_id AND usage.user_id = inference.user_id
    WHERE inference.operation_id = ?
      AND inference.tenant_id = ? AND inference.user_id = ?
      AND inference.evaluation_mode = 'production'
      AND (COALESCE(usage.input_tokens, 0) > 0 OR COALESCE(usage.output_tokens, 0) > 0
        OR COALESCE(usage.cost_usd, 0) > 0
        OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)`);
  const inferenceQuery = db.prepare(`SELECT run_id, status, evaluation_mode, final_route,
      provider, model_id, validation_status
    FROM skill_inference_runs
    WHERE operation_id = ? AND tenant_id = ? AND user_id = ?
      AND evaluation_mode = 'production'
      AND status = 'completed'
    ORDER BY created_at, run_id`);
  const inferenceUsageCoverageQuery = db.prepare(`SELECT COUNT(*) AS inference_rows,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM api_usage AS usage
        WHERE usage.run_id = inference.run_id
          AND usage.tenant_id = inference.tenant_id AND usage.user_id = inference.user_id
          AND usage.request_source = 'automation'
          AND usage.job_name = 'content_script_job_stage'
          AND COALESCE(NULLIF(TRIM(usage.base_category), ''), NULLIF(TRIM(usage.category), ''))
            IN (${CONTENT_SCRIPT_USAGE_CATEGORY_SQL})
          AND usage.pricing_status = 'resolved'
          AND lower(trim(usage.provider)) = ? AND trim(usage.model) = ?
          AND (COALESCE(usage.input_tokens, 0) > 0 OR COALESCE(usage.output_tokens, 0) > 0
            OR COALESCE(usage.cost_usd, 0) > 0
            OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)
      ) THEN 0 ELSE 1 END) AS missing_usage_runs
    FROM skill_inference_runs AS inference
    WHERE inference.operation_id = ? AND inference.tenant_id = ? AND inference.user_id = ?
      AND inference.evaluation_mode = 'production' AND inference.status = 'completed'`);
  const acceptedRunUsageAuditQuery = db.prepare(`SELECT COUNT(*) AS invalid_rows
    FROM skill_inference_runs AS inference
    INNER JOIN api_usage AS usage ON usage.run_id = inference.run_id
    WHERE inference.operation_id = ? AND inference.tenant_id = ? AND inference.user_id = ?
      AND inference.evaluation_mode = 'production'
      AND (COALESCE(usage.input_tokens, 0) > 0 OR COALESCE(usage.output_tokens, 0) > 0
        OR COALESCE(usage.cost_usd, 0) > 0 OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)
      AND (usage.tenant_id IS NOT inference.tenant_id OR usage.user_id IS NOT inference.user_id
        OR COALESCE(usage.request_source, '') <> 'automation'
        OR COALESCE(usage.job_name, '') <> 'content_script_job_stage'
        OR COALESCE(NULLIF(TRIM(usage.base_category), ''), NULLIF(TRIM(usage.category), ''), '')
          NOT IN (${CONTENT_SCRIPT_USAGE_CATEGORY_SQL})
        OR julianday(usage.ts) IS NULL
        OR COALESCE(usage.pricing_status, '') <> 'resolved'
        OR typeof(usage.input_tokens) <> 'integer' OR usage.input_tokens < 0
        OR typeof(usage.output_tokens) <> 'integer' OR usage.output_tokens < 0
        OR typeof(usage.cost_usd) NOT IN ('integer', 'real') OR usage.cost_usd < 0
        OR typeof(usage.provider_tool_cost_usd) NOT IN ('integer', 'real')
          OR usage.provider_tool_cost_usd < 0
        OR (inference.status = 'completed'
          AND (COALESCE(lower(trim(usage.provider)), '') <> ?
            OR COALESCE(trim(usage.model), '') <> ?)))`);
  const automationUsageAttributionQuery = db.prepare(`SELECT COUNT(*) AS invalid_rows
    FROM api_usage AS usage
    LEFT JOIN skill_inference_runs AS inference ON inference.run_id = usage.run_id
      AND inference.tenant_id = usage.tenant_id AND inference.user_id = usage.user_id
    WHERE usage.tenant_id = ? AND usage.user_id = ?
      AND usage.request_source = 'automation'
      AND usage.job_name = 'content_script_job_stage'
      AND COALESCE(NULLIF(TRIM(usage.base_category), ''), NULLIF(TRIM(usage.category), ''))
        IN (${CONTENT_SCRIPT_USAGE_CATEGORY_SQL})
      AND julianday(usage.ts) >= julianday(?) AND julianday(usage.ts) <= julianday(?)
      AND (usage.run_id IS NULL OR length(trim(usage.run_id)) = 0
        OR inference.run_id IS NULL
        OR inference.evaluation_mode NOT IN ('production', 'shadow'))`);
  const invalidAutomationCategoryUsageQuery = db.prepare(`SELECT COUNT(*) AS invalid_rows
    FROM api_usage AS usage
    WHERE usage.tenant_id = ? AND usage.user_id = ?
      AND usage.request_source = 'automation'
      AND usage.job_name = 'content_script_job_stage'
      AND julianday(usage.ts) >= julianday(?) AND julianday(usage.ts) <= julianday(?)
      AND COALESCE(NULLIF(TRIM(usage.base_category), ''), NULLIF(TRIM(usage.category), ''), '')
        NOT IN (${CONTENT_SCRIPT_USAGE_CATEGORY_SQL})
      AND (COALESCE(usage.input_tokens, 0) > 0 OR COALESCE(usage.output_tokens, 0) > 0
        OR COALESCE(usage.cost_usd, 0) > 0 OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)`);
  const invalidAutomationTimestampUsageQuery = db.prepare(`SELECT COUNT(*) AS invalid_rows
    FROM api_usage AS usage
    WHERE usage.tenant_id = ? AND usage.user_id = ?
      AND usage.request_source = 'automation'
      AND usage.job_name = 'content_script_job_stage'
      AND julianday(usage.ts) IS NULL
      AND (COALESCE(usage.input_tokens, 0) > 0 OR COALESCE(usage.output_tokens, 0) > 0
        OR COALESCE(usage.cost_usd, 0) > 0 OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)`);
  const operationUsageQuery = Object.fromEntries(
    Object.entries(OPERATION_USAGE_BASE_CATEGORIES).map(([operationClass, categories]) => {
      const placeholders = categories.map(() => '?').join(', ');
      return [operationClass, db.prepare(`SELECT inference.operation_id,
          SUM(usage.input_tokens) AS input_tokens,
          SUM(usage.output_tokens) AS output_tokens,
          SUM(MAX(COALESCE(usage.cost_usd, 0)
            - COALESCE(usage.provider_tool_cost_usd, 0), 0)) AS model_cost_usd,
          SUM(usage.provider_tool_cost_usd) AS tool_cost_usd,
          SUM(CASE WHEN COALESCE(usage.pricing_status, '') <> 'resolved'
            THEN 1 ELSE 0 END) AS unresolved_rows,
          MAX(CASE WHEN inference.status = 'completed' THEN 1 ELSE 0 END) AS completed_attempts
        FROM api_usage AS usage
        INNER JOIN skill_inference_runs AS inference ON inference.run_id = usage.run_id
          AND inference.tenant_id = usage.tenant_id AND inference.user_id = usage.user_id
        WHERE usage.tenant_id = ? AND usage.user_id = ?
          AND inference.evaluation_mode = 'production'
          AND usage.request_source = 'interactive'
          AND COALESCE(usage.job_name, '') NOT GLOB 'chat_live_eval:*'
          AND COALESCE(usage.job_name, '') NOT GLOB 'content_live_eval:*'
          AND usage.run_id IS NOT NULL AND length(trim(usage.run_id)) > 0
          AND COALESCE(NULLIF(TRIM(usage.base_category), ''), NULLIF(TRIM(usage.category), ''))
            IN (${placeholders})
          AND julianday(usage.ts) >= julianday(?) AND julianday(usage.ts) < julianday(?)
        GROUP BY inference.operation_id
        ORDER BY inference.operation_id`)];
    }),
  );
  const operationUsageAttributionQuery = Object.fromEntries(
    Object.entries(OPERATION_USAGE_BASE_CATEGORIES).map(([operationClass, categories]) => {
      const placeholders = categories.map(() => '?').join(', ');
      return [operationClass, db.prepare(`SELECT COUNT(*) AS invalid_rows
        FROM api_usage AS usage
        LEFT JOIN skill_inference_runs AS inference ON inference.run_id = usage.run_id
          AND inference.tenant_id = usage.tenant_id AND inference.user_id = usage.user_id
        WHERE usage.tenant_id = ? AND usage.user_id = ?
          AND usage.request_source = 'interactive'
          AND COALESCE(usage.job_name, '') NOT GLOB 'chat_live_eval:*'
          AND COALESCE(usage.job_name, '') NOT GLOB 'content_live_eval:*'
          AND COALESCE(NULLIF(TRIM(usage.base_category), ''), NULLIF(TRIM(usage.category), ''))
            IN (${placeholders})
          AND julianday(usage.ts) >= julianday(?) AND julianday(usage.ts) < julianday(?)
          AND (usage.run_id IS NULL OR length(trim(usage.run_id)) = 0
            OR inference.run_id IS NULL
            OR inference.evaluation_mode NOT IN ('production', 'shadow'))`)];
    }),
  );
  const unclassifiedOperationUsageQuery = db.prepare(`SELECT COUNT(*) AS invalid_rows
    FROM api_usage AS usage
    WHERE usage.tenant_id = ? AND usage.user_id = ?
      AND usage.request_source = 'interactive'
      AND COALESCE(usage.job_name, '') NOT GLOB 'chat_live_eval:*'
      AND COALESCE(usage.job_name, '') NOT GLOB 'content_live_eval:*'
      AND julianday(usage.ts) >= julianday(?) AND julianday(usage.ts) < julianday(?)
      AND COALESCE(NULLIF(TRIM(usage.base_category), ''), NULLIF(TRIM(usage.category), ''), '')
        NOT IN (${OPERATION_USAGE_CATEGORY_SQL})
      AND (COALESCE(usage.input_tokens, 0) > 0 OR COALESCE(usage.output_tokens, 0) > 0
        OR COALESCE(usage.cost_usd, 0) > 0 OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)`);
  const invalidOperationTimestampUsageQuery = db.prepare(`SELECT COUNT(*) AS invalid_rows
    FROM api_usage AS usage
    WHERE usage.tenant_id = ? AND usage.user_id = ?
      AND usage.request_source = 'interactive'
      AND COALESCE(usage.job_name, '') NOT GLOB 'chat_live_eval:*'
      AND COALESCE(usage.job_name, '') NOT GLOB 'content_live_eval:*'
      AND julianday(usage.ts) IS NULL
      AND (COALESCE(usage.input_tokens, 0) > 0 OR COALESCE(usage.output_tokens, 0) > 0
        OR COALESCE(usage.cost_usd, 0) > 0 OR COALESCE(usage.provider_tool_cost_usd, 0) > 0)`);
  const evidenceRows = [];
  const operationIds = new Set();
  let acceptanceScope = null;
  let operationUsageEvidence = null;
  let smokeRuntimeRelease = null;
  const operationWindowEnd = new Date().toISOString();
  const operationWindowStart = new Date(
    Date.parse(operationWindowEnd) - OPERATION_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  try {
    // A read transaction gives all ten job/usage queries one SQLite snapshot
    // while ordinary production writes continue through WAL.
    db.exec('BEGIN DEFERRED TRANSACTION');
    for (const scenario of state.scenarios) {
      const job = jobQuery.get(scenario.jobId);
      if (!job || job.status !== 'completed' || job.delivery_mode !== scenario.deliveryMode) {
        refuse(`job identity/status mismatch for ${scenario.id}`, 78);
      }
      const expectedOperationId = `content-script:${job.job_id}`;
      if (job.operation_id !== expectedOperationId || operationIds.has(job.operation_id)) {
        refuse(`job operation identity is invalid or duplicated for ${scenario.id}`, 78);
      }
      operationIds.add(job.operation_id);
      const persisted = validatePersistedScenarioPayloads(
        job,
        TEN_SCRIPT_ACCEPTANCE_SCENARIOS.find((candidate) => candidate.id === scenario.id),
        scenario,
        scriptJobKeys,
      );
      const jobScope = { tenantId: Number(job.tenant_id), userId: Number(job.owner_user_id) };
      if (!Number.isSafeInteger(jobScope.tenantId) || jobScope.tenantId < 1
          || !Number.isSafeInteger(jobScope.userId) || jobScope.userId < 1) {
        refuse(`job scope is invalid for ${scenario.id}`, 78);
      }
      if (acceptanceScope === null) acceptanceScope = jobScope;
      else if (acceptanceScope.tenantId !== jobScope.tenantId
          || acceptanceScope.userId !== jobScope.userId) {
        refuse('accepted jobs do not share one tenant/user scope', 78);
      }
      if (scenario.output.route !== 'cloud' || job.route !== 'cloud'
          || scenario.output.modelDigest !== null || job.model_digest !== null
          || scenario.output.modelDigest !== job.model_digest) {
        refuse(`job route/model identity mismatch for ${scenario.id}`, 78);
      }
      let warnings;
      try {
        warnings = JSON.parse(job.warning_codes_json);
      } catch {
        refuse(`job warnings are invalid for ${scenario.id}`, 78);
      }
      if (!Array.isArray(warnings) || warnings.length !== 0) {
        refuse(`job warnings are not empty for ${scenario.id}`, 78);
      }
      assertCanonicalTimestamp(job.created_at, `${scenario.id} createdAt`);
      assertCanonicalTimestamp(job.completed_at, `${scenario.id} completedAt`);
      if (Date.parse(job.completed_at) < Date.parse(job.created_at)) {
        refuse(`job completion precedes creation for ${scenario.id}`, 78);
      }
      if (scenario.phase === 'production-smoke'
          && (Date.parse(job.created_at) <= Date.parse(state.productionSmokeSource.boundAt)
            || Date.parse(job.created_at) <= Date.parse(workloadRelease.receiptCompletedAt))) {
        refuse('production smoke predates its authoritative workload release binding', 78);
      }
      if (scenario.phase === 'production-smoke') {
        smokeRuntimeRelease = productionSmokeRuntimeRelease(
          job,
          workloadRelease,
          workloadReleaseViewInput.value,
        );
      }
      const inferenceRows = inferenceQuery.all(
        job.operation_id,
        job.tenant_id,
        job.owner_user_id,
      );
      if (inferenceRows.length < 1 || inferenceRows.some((row) => (
        row.status !== 'completed'
        || row.evaluation_mode !== 'production'
        || row.final_route !== 'cloud'
        || String(row.provider ?? '').trim().toLowerCase() !== EXPECTED_SCRIPT_PROVIDER
        || row.model_id !== EXPECTED_SCRIPT_MODEL
        || row.validation_status === 'invalid'
      ))) {
        refuse(`production cloud inference identity is invalid for ${scenario.id}`, 78);
      }
      const models = [...new Set(inferenceRows.map((row) => row.model_id.trim()))];
      if (models.length !== 1) {
        refuse(`production cloud inference model is not stable for ${scenario.id}`, 78);
      }
      const acceptedRunUsageAudit = acceptedRunUsageAuditQuery.get(
        job.operation_id,
        job.tenant_id,
        job.owner_user_id,
        EXPECTED_SCRIPT_PROVIDER,
        EXPECTED_SCRIPT_MODEL,
      );
      if (!acceptedRunUsageAudit || Number(acceptedRunUsageAudit.invalid_rows) !== 0) {
        refuse(`accepted inference usage attribution is incomplete for ${scenario.id}`, 78);
      }
      const inferenceCoverage = inferenceUsageCoverageQuery.get(
        EXPECTED_SCRIPT_PROVIDER,
        EXPECTED_SCRIPT_MODEL,
        job.operation_id,
        job.tenant_id,
        job.owner_user_id,
      );
      if (!inferenceCoverage
          || Number(inferenceCoverage.inference_rows) !== inferenceRows.length
          || Number(inferenceCoverage.missing_usage_runs) !== 0) {
        refuse(`completed inference usage coverage is incomplete for ${scenario.id}`, 78);
      }
      const usage = usageQuery.get(
        EXPECTED_SCRIPT_PROVIDER,
        EXPECTED_SCRIPT_MODEL,
        job.operation_id,
        job.tenant_id,
        job.owner_user_id,
      );
      if (!usage || !Number.isSafeInteger(Number(usage.usage_rows))
          || Number(usage.usage_rows) < 1) {
        refuse(`attributed provider usage is missing for ${scenario.id}`, 78);
      }
      if (Number(usage.unresolved_rows) !== 0) {
        refuse(`attributed provider usage has unresolved pricing for ${scenario.id}`, 78);
      }
      if (Number(usage.routing_mismatch_rows) !== 0) {
        refuse(`attributed provider usage route/model is invalid for ${scenario.id}`, 78);
      }
      const inputTokens = assertPositiveInteger(Number(usage.input_tokens), `${scenario.id} inputTokens`);
      const outputTokens = assertPositiveInteger(Number(usage.output_tokens), `${scenario.id} outputTokens`);
      const modelCostUsd = assertFiniteNumber(Number(usage.model_cost_usd), `${scenario.id} modelCostUsd`, {
        maximum: 1_000_000,
      });
      const toolCostUsd = assertFiniteNumber(Number(usage.tool_cost_usd), `${scenario.id} toolCostUsd`, {
        maximum: 1_000_000,
      });
      evidenceRows.push({
        id: scenario.id,
        phase: scenario.phase,
        deliveryMode: scenario.deliveryMode,
        language: scenario.language,
        topicSha256: scenario.topicSha256,
        jobId: scenario.jobId,
        scriptSha256: persisted.scriptSha256,
        wordCount: persisted.wordCount,
        sourceConsistent: scenario.output.sourceConsistent,
        route: job.route,
        modelDigest: job.model_digest,
        provider: EXPECTED_SCRIPT_PROVIDER,
        model: models[0],
        createdAt: job.created_at,
        completedAt: job.completed_at,
        inputTokens,
        outputTokens,
        modelCostUsd: Number(modelCostUsd.toFixed(6)),
        toolCostUsd: Number(toolCostUsd.toFixed(6)),
      });
    }
    if (!acceptanceScope) refuse('acceptance scope is missing', 78);
    const acceptanceWindowStart = new Date(Math.min(
      ...evidenceRows.map((row) => Date.parse(row.createdAt)),
    )).toISOString();
    const acceptanceWindowEnd = operationWindowEnd;
    const automationAttribution = automationUsageAttributionQuery.get(
      acceptanceScope.tenantId,
      acceptanceScope.userId,
      acceptanceWindowStart,
      acceptanceWindowEnd,
    );
    if (!automationAttribution || Number(automationAttribution.invalid_rows) !== 0) {
      refuse('acceptance-stage provider usage has missing or cross-scope inference attribution', 78);
    }
    const invalidAutomationCategory = invalidAutomationCategoryUsageQuery.get(
      acceptanceScope.tenantId,
      acceptanceScope.userId,
      acceptanceWindowStart,
      acceptanceWindowEnd,
    );
    if (!invalidAutomationCategory || Number(invalidAutomationCategory.invalid_rows) !== 0) {
      refuse('acceptance-stage provider usage has an invalid governed category', 78);
    }
    const invalidAutomationTimestamp = invalidAutomationTimestampUsageQuery.get(
      acceptanceScope.tenantId,
      acceptanceScope.userId,
    );
    if (!invalidAutomationTimestamp || Number(invalidAutomationTimestamp.invalid_rows) !== 0) {
      refuse('acceptance-stage provider usage has an invalid timestamp', 78);
    }
    const unclassifiedOperations = unclassifiedOperationUsageQuery.get(
      acceptanceScope.tenantId,
      acceptanceScope.userId,
      operationWindowStart,
      operationWindowEnd,
    );
    if (!unclassifiedOperations || Number(unclassifiedOperations.invalid_rows) !== 0) {
      refuse('paid interactive usage has no governed operation category', 78);
    }
    const invalidOperationTimestamp = invalidOperationTimestampUsageQuery.get(
      acceptanceScope.tenantId,
      acceptanceScope.userId,
    );
    if (!invalidOperationTimestamp || Number(invalidOperationTimestamp.invalid_rows) !== 0) {
      refuse('paid interactive usage has an invalid timestamp', 78);
    }
    const classifiedOperationIds = new Map();
    const operationClasses = Object.fromEntries(
      Object.entries(OPERATION_USAGE_BASE_CATEGORIES).map(([operationClass, categories]) => {
        const attribution = operationUsageAttributionQuery[operationClass].get(
          acceptanceScope.tenantId,
          acceptanceScope.userId,
          ...categories,
          operationWindowStart,
          operationWindowEnd,
        );
        if (!attribution || Number(attribution.invalid_rows) !== 0) {
          refuse(`${operationClass} provider usage has missing or cross-scope inference attribution`, 78);
        }
        const rows = operationUsageQuery[operationClass].all(
          acceptanceScope.tenantId,
          acceptanceScope.userId,
          ...categories,
          operationWindowStart,
          operationWindowEnd,
        );
        for (const row of rows) {
          const operationId = boundedString(
            row.operation_id,
            `${operationClass} operation identity`,
            240,
          );
          const previousClass = classifiedOperationIds.get(operationId);
          if (previousClass) {
            refuse(`operation usage identity belongs to both ${previousClass} and ${operationClass}`, 78);
          }
          classifiedOperationIds.set(operationId, operationClass);
        }
        return [operationClass, usageP95(rows, operationClass)];
      }),
    );
    operationUsageEvidence = {
      schemaVersion: OPERATION_USAGE_EVIDENCE_SCHEMA,
      classificationVersion: OPERATION_USAGE_CLASSIFICATION_VERSION,
      capturedAt: operationWindowEnd,
      windowStart: operationWindowStart,
      windowEnd: operationWindowEnd,
      scopeSha256: scopeSha256(acceptanceScope.tenantId, acceptanceScope.userId),
      classes: operationClasses,
    };
    db.exec('COMMIT');
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
  const databaseAfter = assertRegularFileNoSymlink(databaseBefore.canonical, 'database');
  if (databaseBefore.dev !== databaseAfter.dev || databaseBefore.ino !== databaseAfter.ino) {
    refuse('database path identity changed while evidence was collected', 75);
  }
  const latestCompletion = Math.max(...evidenceRows.map((row) => Date.parse(row.completedAt)));
  if (Date.parse(qualityReview.reviewedAt) < latestCompletion) {
    refuse('quality review predates a completed script and cannot attest the final inventory', 78);
  }
  const productionSmokeCompletion = Date.parse(
    evidenceRows.find((row) => row.phase === 'production-smoke')?.completedAt ?? '',
  );
  const workloadEvidenceTime = Math.max(
    productionSmokeCompletion,
    Date.parse(state.productionSmokeSource.boundAt),
    Date.parse(workloadRelease.capturedAt),
  );
  if (!Number.isFinite(workloadEvidenceTime)
      || Date.parse(release.receiptCompletedAt) <= workloadEvidenceTime) {
    refuse('evidence-producer release must complete after workload smoke evidence', 78);
  }

  const delivery = Object.fromEntries(Object.keys(DELIVERY_COUNTS).map((mode) => [
    mode, evidenceRows.filter((row) => row.deliveryMode === mode).length,
  ]));
  const languages = Object.fromEntries(['en', 'pt-BR'].map((language) => [
    language, evidenceRows.filter((row) => row.language === language).length,
  ]));
  const acceptancePass = Object.entries(DELIVERY_COUNTS)
    .every(([mode, count]) => delivery[mode] === count)
    && languages.en === 5 && languages['pt-BR'] === 5
    && evidenceRows.every((row) => row.wordCount >= 1900 && row.wordCount <= 2400)
    && evidenceRows.filter((row) => row.phase === 'pre-release').length === 9
    && evidenceRows.filter((row) => row.phase === 'production-smoke').length === 1
    && qualityReview.attestation === 'no_critical_quality_regression';
  if (!acceptancePass || !smokeRuntimeRelease) {
    refuse('ten-script contract, quality-review, or smoke runtime-release gate failed', 78);
  }

  const p95ByDeliveryMode = Object.fromEntries(Object.keys(DELIVERY_COUNTS).map((mode) => {
    const rows = evidenceRows.filter((row) => row.deliveryMode === mode);
    return [mode, {
      sampleCount: rows.length,
      inputTokens: p95(rows.map((row) => row.inputTokens)),
      outputTokens: p95(rows.map((row) => row.outputTokens)),
      modelCostUsd: p95(rows.map((row) => row.modelCostUsd)),
      toolCostUsd: p95(rows.map((row) => row.toolCostUsd)),
    }];
  }));
  const artifact = {
    schemaVersion: CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    generatedAt: new Date().toISOString(),
    workloadSourceSha,
    producerSourceSha,
    producerToolSource,
    sourceBindingSha256,
    stateSha256: stateDigest,
    scopeSha256: operationUsageEvidence.scopeSha256,
    workloadRelease: {
      ...workloadRelease,
      backendImageDigest: smokeRuntimeRelease.creation.backendImageDigest,
      boundAt: state.productionSmokeSource.boundAt,
      viewSha256: workloadReleaseViewSha256,
    },
    productionSmokeRuntimeRelease: smokeRuntimeRelease,
    qualityReview: {
      schemaVersion: qualityReview.schemaVersion,
      sha256: sha256(qualityInput.bytes),
      reviewedAt: qualityReview.reviewedAt,
      reviewType: qualityReview.reviewType,
      attestation: qualityReview.attestation,
    },
    release: {
      ...release,
      viewSha256: sha256(releaseViewInput.bytes),
    },
    acceptancePass,
    inventory: { count: 10, delivery, languages, preRelease: 9, productionSmoke: 1 },
    p95Tokens: {
      input: p95(evidenceRows.map((row) => row.inputTokens)),
      output: p95(evidenceRows.map((row) => row.outputTokens)),
    },
    p95ByDeliveryMode,
    operationUsage: operationUsageEvidence,
    totalModelCostUsd: Number(evidenceRows.reduce((sum, row) => sum + row.modelCostUsd, 0).toFixed(6)),
    totalToolCostUsd: Number(evidenceRows.reduce((sum, row) => sum + row.toolCostUsd, 0).toFixed(6)),
    scripts: evidenceRows,
  };
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  atomicPrivateWrite(outputPath, bytes);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    acceptancePass: artifact.acceptancePass,
    workloadSourceSha: artifact.workloadSourceSha,
    producerSourceSha: artifact.producerSourceSha,
    producerToolBindingSha256: artifact.producerToolSource.bindingSha256,
    sourceBindingSha256: artifact.sourceBindingSha256,
    artifactSha256: sha256(bytes),
    stateSha256: artifact.stateSha256,
    qualityReviewSha256: artifact.qualityReview.sha256,
    releaseViewSha256: artifact.release.viewSha256,
  }, null, 2)}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(
      `content acceptance evidence refused: ${safeEvidenceCliFailureMessage(error)}\n`,
    );
    process.exitCode = error.exitCode || 1;
  });
}
