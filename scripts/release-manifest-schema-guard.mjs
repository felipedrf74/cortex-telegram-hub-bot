#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from './lib/git-ref.mjs';
import { parseGitNameStatusRecordsZ } from './lib/git-changed-paths.mjs';
import {
  RELEASE_MANIFEST_SCHEMA_POLICY_PATH,
  RELEASE_MANIFEST_SCHEMA_POLICY_SCHEMA,
  assertReleaseManifestSchemaPolicyShape,
} from './lib/release-manifest-schema-policy.mjs';

export const RELEASE_MANIFEST_SCHEMA_GUARD_RESULT_SCHEMA =
  'nexus.release-manifest-schema-guard-result.v1';

// Initial adoption is allowed only over the audited v3 reader, writer, and
// hosted publisher blobs that existed before this policy. The guard reads
// these identities from the exact base commit, never the worktree.
// A different base implementation requires an intentional guard update instead
// of silently declaring unknown code to be the initial compatibility baseline.
export const RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS = Object.freeze({
  '.github/workflows/release.yml': 'c202818c040d3dffdd19d8072a9560bd665e401d',
  'scripts/lib/release-manifest.mjs': '12305e6ae9ed92e95755ace7dee52b604817381f',
  'scripts/release-manifest-build.mjs': '42c71c10d7d311d1d54058d8e55c896686492820',
});

const INITIAL_POLICY = Object.freeze({
  schema: RELEASE_MANIFEST_SCHEMA_POLICY_SCHEMA,
  writerGeneration: 3,
  candidateReaders: Object.freeze([3]),
  retainedReaders: Object.freeze([2, 3]),
  generations: Object.freeze([
    Object.freeze({
      generation: 2,
      envelopeSchema: 'nexus.release-manifest.v2',
      payloadSchema: 'nexus.release-manifest-payload.v2',
      requiresControlPlane: false,
    }),
    Object.freeze({
      generation: 3,
      envelopeSchema: 'nexus.release-manifest.v3',
      payloadSchema: 'nexus.release-manifest-payload.v3',
      requiresControlPlane: true,
    }),
  ]),
});

const MAX_POLICY_BYTES = 64 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const POLICY_MODE = '100644';

function fail(message) {
  throw new Error(`release manifest schema guard ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactEqual(left, right) {
  return canonical(left) === canonical(right);
}

function git(root, args, { encoding = 'utf8', allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding,
      env: cleanGitEnv({ GIT_NO_REPLACE_OBJECTS: '1' }),
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function assertSafeRef(ref, label) {
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 1024 || ref.includes('\0')) {
    fail(`${label} ref is empty or unsafe`);
  }
  return ref;
}

export function resolveReleaseManifestSchemaGuardCommit(root, ref, label = 'Git') {
  const safeRef = assertSafeRef(ref, label);
  const resolved = git(root, [
    'rev-parse', '--verify', '--end-of-options', `${safeRef}^{commit}`,
  ], { allowFailure: true });
  const sha = typeof resolved === 'string' ? resolved.trim() : '';
  if (!FULL_SHA.test(sha)) fail(`${label} ref does not resolve to an exact commit`);
  return sha;
}

function readGitBlobIdentity(root, commit, file) {
  const output = git(root, ['ls-tree', '-z', commit, '--', file]);
  const records = String(output).split('\0').filter(Boolean);
  if (records.length === 0) return null;
  if (records.length !== 1) fail(`Git tree lookup for ${file} was ambiguous`);
  const match = /^(\d{6}) (\S+) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([\s\S]+)$/.exec(records[0]);
  if (!match || match[4] !== file) fail(`Git tree entry for ${file} is malformed`);
  return Object.freeze({ mode: match[1], type: match[2], objectId: match[3] });
}

function readPolicyAtCommit(root, commit) {
  const identity = readGitBlobIdentity(root, commit, RELEASE_MANIFEST_SCHEMA_POLICY_PATH);
  if (!identity) return null;
  if (identity.mode !== POLICY_MODE || identity.type !== 'blob') {
    fail(`${RELEASE_MANIFEST_SCHEMA_POLICY_PATH} must be a non-executable regular Git blob`);
  }
  const bytes = git(root, ['cat-file', 'blob', identity.objectId], { encoding: 'buffer' });
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_POLICY_BYTES) {
    fail(`${RELEASE_MANIFEST_SCHEMA_POLICY_PATH} must be a bounded JSON blob`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${RELEASE_MANIFEST_SCHEMA_POLICY_PATH} is not valid JSON at ${commit}`);
  }
  return Object.freeze({
    identity,
    policy: assertReleaseManifestSchemaPolicyShape(parsed),
  });
}

function assertChangedPaths(changedPaths) {
  if (!Array.isArray(changedPaths)
      || changedPaths.some((file) => (
        typeof file !== 'string'
        || file.length < 1
        || file.includes('\0')
        || path.posix.isAbsolute(file)
      ))) {
    fail('changed paths must be safe repository-relative strings');
  }
  return [...new Set(changedPaths)].sort();
}

/**
 * Assert the policy evolution after initial adoption. Generation definitions
 * are immutable history: a later policy may append rows but never edit,
 * reorder, or remove an existing one.
 */
export function assertReleaseManifestSchemaPolicyTransition({
  basePolicy,
  headPolicy,
  changedPaths = [],
}) {
  const base = assertReleaseManifestSchemaPolicyShape(basePolicy);
  const head = assertReleaseManifestSchemaPolicyShape(headPolicy);
  const paths = assertChangedPaths(changedPaths);

  if (head.generations.length < base.generations.length) {
    fail('generation rows are append-only and must not be removed');
  }
  for (let index = 0; index < base.generations.length; index += 1) {
    if (!exactEqual(base.generations[index], head.generations[index])) {
      fail(`generation row ${base.generations[index].generation} is immutable and append-only`);
    }
  }
  for (const generation of base.retainedReaders) {
    if (!head.retainedReaders.includes(generation)) {
      fail(`retained reader generation ${generation} is append-only and cannot be removed`);
    }
  }
  for (const generation of base.candidateReaders) {
    if (!head.candidateReaders.includes(generation)) {
      fail(
        `candidate reader generation ${generation} is append-only in policy v1 `
        + 'and cannot be removed without authoritative in-flight host evidence',
      );
    }
  }
  const appendedGenerations = head.generations
    .slice(base.generations.length)
    .map((row) => row.generation);
  for (const generation of head.candidateReaders) {
    if (!base.candidateReaders.includes(generation)
        && !appendedGenerations.includes(generation)) {
      fail(
        `candidate reader generation ${generation} was retained-only in the exact base policy; `
        + 'new candidate readers must be introduced by an appended generation row',
      );
    }
  }

  if (base.writerGeneration === head.writerGeneration) {
    return Object.freeze({
      transition: 'compatible_policy_update',
      previousWriterGeneration: base.writerGeneration,
      writerGeneration: head.writerGeneration,
      appendedGenerations: Object.freeze(appendedGenerations),
    });
  }

  if (!base.candidateReaders.includes(head.writerGeneration)) {
    fail(
      `writer generation ${head.writerGeneration} was not candidate-readable in the exact base policy`,
    );
  }
  if (head.writerGeneration <= base.writerGeneration) {
    fail(
      `writer generation must advance monotonically from ${base.writerGeneration} `
      + `to a larger generation; received ${head.writerGeneration}`,
    );
  }
  for (const field of ['schema', 'candidateReaders', 'retainedReaders', 'generations']) {
    if (!exactEqual(base[field], head[field])) {
      fail(`writer transition must change only writerGeneration; ${field} also changed`);
    }
  }
  const allowedWriterTransitionPaths = new Set([
    RELEASE_MANIFEST_SCHEMA_POLICY_PATH,
    'docs/project-map.json',
  ]);
  const forbiddenChanges = paths.filter((file) => !allowedWriterTransitionPaths.has(file));
  if (!paths.includes(RELEASE_MANIFEST_SCHEMA_POLICY_PATH)) {
    fail(`writer transition diff is missing ${RELEASE_MANIFEST_SCHEMA_POLICY_PATH}`);
  }
  if (forbiddenChanges.length > 0) {
    fail(
      'writer transition may change only the policy and generated project map: '
      + forbiddenChanges.join(', '),
    );
  }
  return Object.freeze({
    transition: 'writer_generation_change',
    previousWriterGeneration: base.writerGeneration,
    writerGeneration: head.writerGeneration,
    appendedGenerations: Object.freeze([]),
  });
}

export function assertInitialReleaseManifestSchemaPolicyAdoption({
  headPolicy,
  actualBaseBlobs,
  expectedBaseBlobs = RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS,
}) {
  const head = assertReleaseManifestSchemaPolicyShape(headPolicy);
  if (!exactEqual(head, INITIAL_POLICY)) {
    fail('initial policy must exactly describe the audited v2/v3 compatibility baseline');
  }
  if (!actualBaseBlobs || typeof actualBaseBlobs !== 'object' || Array.isArray(actualBaseBlobs)) {
    fail('initial adoption base blob evidence is missing');
  }
  const expectedPaths = Object.keys(expectedBaseBlobs).sort();
  if (expectedPaths.length < 3) {
    fail('initial adoption requires at least three trusted v3 blob anchors');
  }
  if (!exactEqual(Object.keys(actualBaseBlobs).sort(), expectedPaths)) {
    fail('initial adoption base blob evidence does not cover the exact trusted path set');
  }
  for (const file of expectedPaths) {
    const expected = expectedBaseBlobs[file];
    const actual = actualBaseBlobs[file];
    if (!GIT_OBJECT_ID.test(expected) || !GIT_OBJECT_ID.test(actual) || actual !== expected) {
      fail(`initial adoption base blob is not the audited v3 identity: ${file}`);
    }
  }
  return Object.freeze({
    transition: 'initial_policy_adoption',
    previousWriterGeneration: null,
    writerGeneration: head.writerGeneration,
    appendedGenerations: Object.freeze(head.generations.map((row) => row.generation)),
  });
}

function changedPathsBetweenCommits(root, baseSha, headSha) {
  const output = git(root, [
    'diff', '--name-status', '-z', '--find-renames', baseSha, headSha,
  ]);
  return assertChangedPaths(
    parseGitNameStatusRecordsZ(output).flatMap((record) => record.paths),
  );
}

function readInitialBaseBlobs(root, baseSha, expectedBaseBlobs) {
  return Object.freeze(Object.fromEntries(Object.keys(expectedBaseBlobs).map((file) => {
    const identity = readGitBlobIdentity(root, baseSha, file);
    if (!identity || identity.mode !== POLICY_MODE || identity.type !== 'blob') {
      fail(`initial adoption base blob is absent or unsafe: ${file}`);
    }
    return [file, identity.objectId];
  })));
}

/**
 * Verify exact committed refs. `initialAdoptionBlobs` is dependency-injected
 * for hermetic tests; the production CLI deliberately exposes no flag for it
 * and therefore always uses RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS.
 */
export function verifyReleaseManifestSchemaPolicyRefs({
  root = process.cwd(),
  baseRef,
  headRef,
  initialAdoptionBlobs = RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS,
}) {
  const repositoryRoot = path.resolve(root);
  const baseSha = resolveReleaseManifestSchemaGuardCommit(repositoryRoot, baseRef, 'base');
  const headSha = resolveReleaseManifestSchemaGuardCommit(repositoryRoot, headRef, 'head');
  if (git(repositoryRoot, [
    'merge-base', '--is-ancestor', baseSha, headSha,
  ], { allowFailure: true }) === null) {
    fail('exact base commit is not an ancestor of the exact head commit');
  }
  const headEntry = readPolicyAtCommit(repositoryRoot, headSha);
  if (!headEntry) fail(`head commit is missing ${RELEASE_MANIFEST_SCHEMA_POLICY_PATH}`);
  const baseEntry = readPolicyAtCommit(repositoryRoot, baseSha);
  const changedPaths = changedPathsBetweenCommits(repositoryRoot, baseSha, headSha);

  const transition = baseEntry
    ? assertReleaseManifestSchemaPolicyTransition({
      basePolicy: baseEntry.policy,
      headPolicy: headEntry.policy,
      changedPaths,
    })
    : assertInitialReleaseManifestSchemaPolicyAdoption({
      headPolicy: headEntry.policy,
      actualBaseBlobs: readInitialBaseBlobs(
        repositoryRoot,
        baseSha,
        initialAdoptionBlobs,
      ),
      expectedBaseBlobs: initialAdoptionBlobs,
    });

  return Object.freeze({
    schema: RELEASE_MANIFEST_SCHEMA_GUARD_RESULT_SCHEMA,
    ok: true,
    baseSha,
    headSha,
    policyPath: RELEASE_MANIFEST_SCHEMA_POLICY_PATH,
    policyBlob: headEntry.identity.objectId,
    changedPaths: Object.freeze(changedPaths),
    ...transition,
  });
}

export function parseReleaseManifestSchemaGuardArgs(argv) {
  const options = { root: process.cwd(), baseRef: '', headRef: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index] ?? '';
    else if (argument === '--base') options.baseRef = argv[++index] ?? '';
    else if (argument === '--head') options.headRef = argv[++index] ?? '';
    else if (argument === '-h' || argument === '--help') {
      return Object.freeze({ ...options, help: true });
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  if (!options.root || !options.baseRef || !options.headRef) {
    fail('--base and --head are required; --root is optional');
  }
  return Object.freeze(options);
}

function usage() {
  return `release-manifest-schema-guard — validate an exact base/head policy transition

Usage:
  node scripts/release-manifest-schema-guard.mjs --base <commit> --head <commit> [--root <path>]
`;
}

export function runReleaseManifestSchemaGuardCli(argv = process.argv.slice(2)) {
  const options = parseReleaseManifestSchemaGuardArgs(argv);
  if (options.help) return { status: 0, stdout: usage(), stderr: '' };
  const result = verifyReleaseManifestSchemaPolicyRefs(options);
  return { status: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
}

if (process.argv[1]
    && fileURLToPath(import.meta.url) === realpathSync(path.resolve(process.argv[1]))) {
  try {
    const output = runReleaseManifestSchemaGuardCli();
    process.stdout.write(output.stdout);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
