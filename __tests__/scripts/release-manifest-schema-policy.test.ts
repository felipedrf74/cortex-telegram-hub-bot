import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RELEASE_MANIFEST_SCHEMA_POLICY_PATH,
  RELEASE_MANIFEST_VERIFICATION_MODES,
  assertReleaseManifestGenerationReadable,
  assertReleaseManifestSchemaPolicyShape,
  getReleaseManifestGeneration,
  loadReleaseManifestSchemaPolicy,
} from '../../scripts/lib/release-manifest-schema-policy.mjs';
import {
  RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS,
  assertInitialReleaseManifestSchemaPolicyAdoption,
  assertReleaseManifestSchemaPolicyTransition,
  parseReleaseManifestSchemaGuardArgs,
  verifyReleaseManifestSchemaPolicyRefs,
} from '../../scripts/release-manifest-schema-guard.mjs';

type Policy = Record<string, any>;

const repoRoot = resolve(process.cwd());
const canonicalPolicy = JSON.parse(readFileSync(
  join(repoRoot, RELEASE_MANIFEST_SCHEMA_POLICY_PATH),
  'utf8',
)) as Policy;
const guardScript = join(repoRoot, 'scripts/release-manifest-schema-guard.mjs');
const fixtureRoots: string[] = [];
const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Schema Guard Test',
  GIT_AUTHOR_EMAIL: 'schema-guard@test.invalid',
  GIT_COMMITTER_NAME: 'Schema Guard Test',
  GIT_COMMITTER_EMAIL: 'schema-guard@test.invalid',
};

function clonePolicy(policy: Policy = canonicalPolicy) {
  return JSON.parse(JSON.stringify(policy)) as Policy;
}

function makeGeneration(generation: number) {
  return {
    generation,
    envelopeSchema: `nexus.release-manifest.v${generation}`,
    payloadSchema: `nexus.release-manifest-payload.v${generation}`,
    requiresControlPlane: true,
  };
}

function fixtureRoot(prefix = 'nexus-schema-policy-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}

function writePolicy(root: string, policy: Policy) {
  const policyPath = join(root, RELEASE_MANIFEST_SCHEMA_POLICY_PATH);
  mkdirSync(dirname(policyPath), { recursive: true });
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

function loadFixture(mutate: (policy: Policy) => void = () => {}) {
  const root = fixtureRoot();
  const policy = clonePolicy();
  mutate(policy);
  writePolicy(root, policy);
  return loadReleaseManifestSchemaPolicy(root);
}

function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitIdentity,
  }).trim();
}

function initGitFixture(policy: Policy = canonicalPolicy) {
  const root = fixtureRoot('nexus-schema-git-');
  git(root, ['init', '-q', '-b', 'main']);
  writePolicy(root, policy);
  git(root, ['add', RELEASE_MANIFEST_SCHEMA_POLICY_PATH]);
  git(root, ['commit', '-q', '-m', 'base policy']);
  return { root, baseSha: git(root, ['rev-parse', 'HEAD']) };
}

function initAdoptionGitFixture() {
  const root = fixtureRoot('nexus-schema-adoption-');
  git(root, ['init', '-q', '-b', 'main']);
  const anchorPaths = [
    '.github/workflows/release.yml',
    'scripts/lib/release-manifest.mjs',
    'scripts/release-manifest-build.mjs',
  ];
  for (const [index, file] of anchorPaths.entries()) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `audited fixture blob ${index + 1}\n`);
  }
  git(root, ['add', ...anchorPaths]);
  git(root, ['commit', '-q', '-m', 'audited v3 base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  const initialAdoptionBlobs = Object.fromEntries(anchorPaths.map((file) => [
    file,
    git(root, ['rev-parse', `${baseSha}:${file}`]),
  ]));
  return { root, baseSha, initialAdoptionBlobs };
}

function commitPolicy(root: string, policy: Policy, message = 'policy update') {
  writePolicy(root, policy);
  git(root, ['add', RELEASE_MANIFEST_SCHEMA_POLICY_PATH]);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release manifest schema policy loader', () => {
  it('loads the checked-in v2/v3 reader and v3 writer contract', () => {
    const policy = loadReleaseManifestSchemaPolicy(repoRoot);
    expect(policy).toEqual(canonicalPolicy);
    expect(policy).toMatchObject({
      writerGeneration: 3,
      candidateReaders: [3],
      retainedReaders: [2, 3],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.generations)).toBe(true);
  });

  it.each([
    ['unknown root field', (policy: Policy) => { policy.future = true; }, /root fields/i],
    ['missing root field', (policy: Policy) => { delete policy.writerGeneration; }, /root fields/i],
    ['unsupported schema', (policy: Policy) => { policy.schema = 'nexus.release-manifest-schema-policy.v2'; }, /schema is unsupported/i],
    ['unknown generation field', (policy: Policy) => { policy.generations[0].future = true; }, /generations\[0\] fields/i],
    ['wrong envelope identity', (policy: Policy) => { policy.generations[0].envelopeSchema = 'nexus.release-manifest.v3'; }, /envelopeSchema/i],
    ['wrong payload identity', (policy: Policy) => { policy.generations[0].payloadSchema = 'nexus.release-manifest-payload.v3'; }, /payloadSchema/i],
    ['non-boolean control-plane flag', (policy: Policy) => { policy.generations[0].requiresControlPlane = 0; }, /requiresControlPlane/i],
    ['unknown writer', (policy: Policy) => { policy.writerGeneration = 4; }, /writerGeneration references unknown/i],
    ['writer not candidate-readable', (policy: Policy) => { policy.writerGeneration = 2; }, /must be candidate-readable/i],
    ['unknown candidate reader', (policy: Policy) => { policy.candidateReaders = [3, 4]; }, /candidateReaders references unknown/i],
    ['unknown retained reader', (policy: Policy) => { policy.retainedReaders = [2, 3, 4]; }, /retainedReaders references unknown/i],
    ['candidate not retained', (policy: Policy) => { policy.candidateReaders = [2, 3]; policy.retainedReaders = [3]; }, /candidate reader 2.*retained/i],
    ['unsorted candidates', (policy: Policy) => { policy.candidateReaders = [3, 2]; }, /candidateReaders.*sorted/i],
    ['duplicate retained reader', (policy: Policy) => { policy.retainedReaders = [2, 2, 3]; }, /retainedReaders.*sorted/i],
    ['unsorted generations', (policy: Policy) => { policy.generations.reverse(); }, /generations.*sorted/i],
  ])('rejects %s', (_label, mutate, error) => {
    expect(() => loadFixture(mutate)).toThrow(error);
  });

  it('keeps retained v2 control-plane-free and every appended generation controller-bound', () => {
    expect(() => loadFixture((policy) => {
      policy.generations[0].requiresControlPlane = true;
    })).toThrow(/requiresControlPlane must be false for retained generation 2/i);

    expect(() => loadFixture((policy) => {
      policy.generations.push({
        ...makeGeneration(4),
        requiresControlPlane: false,
      });
      policy.candidateReaders.push(4);
      policy.retainedReaders.push(4);
    })).toThrow(/requiresControlPlane must remain true after generation 2/i);
  });

  it('rejects malformed JSON, missing files, and policy symlinks', () => {
    const missing = fixtureRoot();
    expect(() => loadReleaseManifestSchemaPolicy(missing)).toThrow(/is missing/i);

    const malformed = fixtureRoot();
    const malformedPath = join(malformed, RELEASE_MANIFEST_SCHEMA_POLICY_PATH);
    mkdirSync(dirname(malformedPath), { recursive: true });
    writeFileSync(malformedPath, '{\n');
    expect(() => loadReleaseManifestSchemaPolicy(malformed)).toThrow(/not valid JSON/i);

    const symbolic = fixtureRoot();
    const target = join(symbolic, 'policy-target.json');
    writeFileSync(target, `${JSON.stringify(canonicalPolicy)}\n`);
    const symbolicPath = join(symbolic, RELEASE_MANIFEST_SCHEMA_POLICY_PATH);
    mkdirSync(dirname(symbolicPath), { recursive: true });
    symlinkSync(target, symbolicPath);
    expect(() => loadReleaseManifestSchemaPolicy(symbolic)).toThrow(/regular file.*symbolic/i);
  });

  it('resolves exact generation rows and keeps candidate versus retained modes closed', () => {
    const policy = assertReleaseManifestSchemaPolicyShape(canonicalPolicy);
    expect(getReleaseManifestGeneration(policy, 3)).toMatchObject({
      envelopeSchema: 'nexus.release-manifest.v3',
      requiresControlPlane: true,
    });
    expect(assertReleaseManifestGenerationReadable(
      policy,
      3,
      RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
    ).generation).toBe(3);
    expect(assertReleaseManifestGenerationReadable(
      policy,
      2,
      RELEASE_MANIFEST_VERIFICATION_MODES.RETAINED,
    ).generation).toBe(2);
    expect(() => assertReleaseManifestGenerationReadable(
      policy,
      2,
      RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
    )).toThrow(/not readable in candidate mode/i);
    expect(() => assertReleaseManifestGenerationReadable(policy, 3, 'future'))
      .toThrow(/verification mode is unsupported/i);
    expect(() => getReleaseManifestGeneration(policy, 4)).toThrow(/does not define generation 4/i);
  });
});

describe('release manifest schema policy transitions', () => {
  it('accepts a reader-first append while the writer remains unchanged', () => {
    const head = clonePolicy();
    head.generations.push(makeGeneration(4));
    head.candidateReaders.push(4);
    head.retainedReaders.push(4);
    expect(assertReleaseManifestSchemaPolicyTransition({
      basePolicy: canonicalPolicy,
      headPolicy: head,
      changedPaths: [
        RELEASE_MANIFEST_SCHEMA_POLICY_PATH,
        'scripts/lib/release-manifest.mjs',
        '__tests__/scripts/release-manifest-schema-policy.test.ts',
      ],
    })).toMatchObject({
      transition: 'compatible_policy_update',
      previousWriterGeneration: 3,
      writerGeneration: 3,
      appendedGenerations: [4],
    });
  });

  it('rejects generation edits, removal, and retained-reader removal', () => {
    const edited = clonePolicy();
    edited.generations[1] = makeGeneration(4);
    edited.writerGeneration = 4;
    edited.candidateReaders = [4];
    edited.retainedReaders = [2, 4];
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: canonicalPolicy,
      headPolicy: edited,
    })).toThrow(/generation row 3 is immutable/i);

    const removed = clonePolicy();
    removed.generations.shift();
    removed.retainedReaders = [3];
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: canonicalPolicy,
      headPolicy: removed,
    })).toThrow(/generation rows are append-only/i);

    const unreadableRollback = clonePolicy();
    unreadableRollback.retainedReaders = [3];
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: canonicalPolicy,
      headPolicy: unreadableRollback,
    })).toThrow(/retained reader generation 2.*cannot be removed/i);

    const unreadableInFlightCandidate = clonePolicy();
    unreadableInFlightCandidate.candidateReaders = [3];
    const baseWithLegacyCandidate = clonePolicy();
    baseWithLegacyCandidate.candidateReaders = [2, 3];
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: baseWithLegacyCandidate,
      headPolicy: unreadableInFlightCandidate,
    })).toThrow(/candidate reader generation 2.*cannot be removed/i);
  });

  it('rejects reopening a retained-only legacy generation for fresh candidates', () => {
    const head = clonePolicy();
    head.candidateReaders = [2, 3];
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: canonicalPolicy,
      headPolicy: head,
      changedPaths: [RELEASE_MANIFEST_SCHEMA_POLICY_PATH],
    })).toThrow(/candidate reader generation 2 was retained-only.*appended generation row/i);
    expect(() => assertReleaseManifestGenerationReadable(
      canonicalPolicy,
      2,
      RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
    )).toThrow(/not readable in candidate mode/i);
  });

  it('requires the future writer to have shipped in the exact base candidate reader set', () => {
    const head = clonePolicy();
    head.generations.push(makeGeneration(4));
    head.candidateReaders.push(4);
    head.retainedReaders.push(4);
    head.writerGeneration = 4;
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: canonicalPolicy,
      headPolicy: head,
      changedPaths: [RELEASE_MANIFEST_SCHEMA_POLICY_PATH],
    })).toThrow(/writer generation 4 was not candidate-readable.*base policy/i);
  });

  it('rejects a writer-generation downgrade even when the older reader is retained', () => {
    const base = clonePolicy();
    base.candidateReaders = [2, 3];
    const head = clonePolicy(base);
    head.writerGeneration = 2;
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: base,
      headPolicy: head,
      changedPaths: [RELEASE_MANIFEST_SCHEMA_POLICY_PATH],
    })).toThrow(/writer generation must advance monotonically/i);
  });

  it('accepts a dedicated writer flip with only policy and generated project-map changes', () => {
    const base = clonePolicy();
    base.generations.push(makeGeneration(4));
    base.candidateReaders.push(4);
    base.retainedReaders.push(4);
    const head = clonePolicy(base);
    head.writerGeneration = 4;
    expect(assertReleaseManifestSchemaPolicyTransition({
      basePolicy: base,
      headPolicy: head,
      changedPaths: [RELEASE_MANIFEST_SCHEMA_POLICY_PATH, 'docs/project-map.json'],
    })).toMatchObject({
      transition: 'writer_generation_change',
      previousWriterGeneration: 3,
      writerGeneration: 4,
    });
  });

  it.each([
    'scripts/lib/release-manifest.mjs',
    '.github/workflows/release.yml',
    'ops/nexus-release/README.md',
    '__tests__/scripts/release-manifest-schema-policy.test.ts',
    'docs/release/continuous-deployment.md',
  ])('rejects a writer flip combined with %s', (file) => {
    const base = clonePolicy();
    base.generations.push(makeGeneration(4));
    base.candidateReaders.push(4);
    base.retainedReaders.push(4);
    const head = clonePolicy(base);
    head.writerGeneration = 4;
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: base,
      headPolicy: head,
      changedPaths: [RELEASE_MANIFEST_SCHEMA_POLICY_PATH, file],
    })).toThrow(/may change only the policy and generated project map/i);
  });

  it('rejects any semantic co-change or a diff that does not contain the policy', () => {
    const base = clonePolicy();
    base.generations.push(makeGeneration(4));
    base.candidateReaders.push(4);
    base.retainedReaders.push(4);
    const semanticDrift = clonePolicy(base);
    semanticDrift.writerGeneration = 4;
    semanticDrift.candidateReaders = [4];
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: base,
      headPolicy: semanticDrift,
      changedPaths: [RELEASE_MANIFEST_SCHEMA_POLICY_PATH],
    })).toThrow(/candidate reader generation 3.*cannot be removed/i);

    const head = clonePolicy(base);
    head.writerGeneration = 4;
    expect(() => assertReleaseManifestSchemaPolicyTransition({
      basePolicy: base,
      headPolicy: head,
      changedPaths: ['docs/project-map.json'],
    })).toThrow(/diff is missing.*release-manifest-schema-policy\.json/i);
  });
});

describe('initial policy adoption', () => {
  it('accepts only the exact v2/v3 policy over every audited base blob', () => {
    expect(assertInitialReleaseManifestSchemaPolicyAdoption({
      headPolicy: canonicalPolicy,
      actualBaseBlobs: RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS,
    })).toMatchObject({
      transition: 'initial_policy_adoption',
      writerGeneration: 3,
      appendedGenerations: [2, 3],
    });
  });

  it('rejects an altered initial policy, a missing anchor, and a mismatched anchor', () => {
    const altered = clonePolicy();
    altered.candidateReaders = [2, 3];
    expect(() => assertInitialReleaseManifestSchemaPolicyAdoption({
      headPolicy: altered,
      actualBaseBlobs: RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS,
    })).toThrow(/exactly describe the audited v2\/v3 compatibility baseline/i);

    const missing = { ...RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS } as Record<string, string>;
    delete missing['.github/workflows/release.yml'];
    expect(() => assertInitialReleaseManifestSchemaPolicyAdoption({
      headPolicy: canonicalPolicy,
      actualBaseBlobs: missing,
    })).toThrow(/does not cover the exact trusted path set/i);

    const mismatched = {
      ...RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS,
      'scripts/lib/release-manifest.mjs': '0'.repeat(40),
    };
    expect(() => assertInitialReleaseManifestSchemaPolicyAdoption({
      headPolicy: canonicalPolicy,
      actualBaseBlobs: mismatched,
    })).toThrow(/not the audited v3 identity.*release-manifest\.mjs/i);
  });

  it('pins the verified protected-main v3 blob identities', () => {
    expect(RELEASE_MANIFEST_SCHEMA_INITIAL_V3_BLOBS).toEqual({
      '.github/workflows/release.yml': 'c202818c040d3dffdd19d8072a9560bd665e401d',
      'scripts/lib/release-manifest.mjs': '12305e6ae9ed92e95755ace7dee52b604817381f',
      'scripts/release-manifest-build.mjs': '42c71c10d7d311d1d54058d8e55c896686492820',
    });
  });
});

describe('exact Git base/head guard', () => {
  it('exercises initial adoption over exact injected fixture blobs end to end', () => {
    const { root, baseSha, initialAdoptionBlobs } = initAdoptionGitFixture();
    const headSha = commitPolicy(root, canonicalPolicy, 'adopt exact policy');
    expect(verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: baseSha,
      headRef: headSha,
      initialAdoptionBlobs,
    })).toMatchObject({
      ok: true,
      baseSha,
      headSha,
      transition: 'initial_policy_adoption',
      writerGeneration: 3,
      appendedGenerations: [2, 3],
    });

    git(root, ['checkout', '-q', '-B', 'wrong-head', baseSha]);
    const wrong = clonePolicy();
    wrong.candidateReaders = [2, 3];
    const wrongHead = commitPolicy(root, wrong, 'adopt wrong policy');
    expect(() => verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: baseSha,
      headRef: wrongHead,
      initialAdoptionBlobs,
    })).toThrow(/exactly describe the audited v2\/v3 compatibility baseline/i);

    const missingAnchorMap = { ...initialAdoptionBlobs };
    delete missingAnchorMap['scripts/release-manifest-build.mjs'];
    missingAnchorMap['scripts/missing-release-writer.mjs'] = 'a'.repeat(40);
    expect(() => verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: baseSha,
      headRef: wrongHead,
      initialAdoptionBlobs: missingAnchorMap,
    })).toThrow(/base blob is absent or unsafe.*missing-release-writer/i);

    git(root, ['checkout', '-q', '-B', 'symbolic-head', baseSha]);
    const target = join(root, 'policy-target.json');
    writeFileSync(target, `${JSON.stringify(canonicalPolicy)}\n`);
    const policyPath = join(root, RELEASE_MANIFEST_SCHEMA_POLICY_PATH);
    mkdirSync(dirname(policyPath), { recursive: true });
    symlinkSync('../../policy-target.json', policyPath);
    git(root, ['add', RELEASE_MANIFEST_SCHEMA_POLICY_PATH, 'policy-target.json']);
    git(root, ['commit', '-q', '-m', 'symbolic initial policy']);
    const symbolicHead = git(root, ['rev-parse', 'HEAD']);
    expect(() => verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: baseSha,
      headRef: symbolicHead,
      initialAdoptionBlobs,
    })).toThrow(/non-executable regular Git blob/i);
  });

  it('reads committed policy blobs, validates ancestry, and ignores dirty worktree bytes', () => {
    const { root, baseSha } = initGitFixture();
    const headPolicy = clonePolicy();
    headPolicy.generations.push(makeGeneration(4));
    headPolicy.candidateReaders.push(4);
    headPolicy.retainedReaders.push(4);
    const headSha = commitPolicy(root, headPolicy);
    writePolicy(root, { broken: true });

    expect(verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: baseSha,
      headRef: headSha,
    })).toMatchObject({
      ok: true,
      baseSha,
      headSha,
      transition: 'compatible_policy_update',
      writerGeneration: 3,
      appendedGenerations: [4],
    });
  });

  it('ignores local Git replacement refs when resolving exact committed evidence', () => {
    const { root, baseSha } = initGitFixture();
    const headPolicy = clonePolicy();
    headPolicy.generations.push(makeGeneration(4));
    headPolicy.candidateReaders.push(4);
    headPolicy.retainedReaders.push(4);
    const headSha = commitPolicy(root, headPolicy);
    git(root, ['replace', headSha, baseSha]);

    expect(verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: baseSha,
      headRef: headSha,
    })).toMatchObject({
      baseSha,
      headSha,
      appendedGenerations: [4],
    });
  });

  it('rejects a non-ancestor base even when both refs carry valid policies', () => {
    const { root, baseSha: commonSha } = initGitFixture();
    writeFileSync(join(root, 'side.txt'), 'side\n');
    git(root, ['add', 'side.txt']);
    git(root, ['commit', '-q', '-m', 'side']);
    const unrelatedBase = git(root, ['rev-parse', 'HEAD']);

    git(root, ['checkout', '-q', '-b', 'head-branch', commonSha]);
    const headPolicy = clonePolicy();
    headPolicy.generations.push(makeGeneration(4));
    const headSha = commitPolicy(root, headPolicy);

    expect(() => verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: unrelatedBase,
      headRef: headSha,
    })).toThrow(/base commit is not an ancestor.*head commit/i);
  });

  it('rejects an unresolved base and a symbolic policy blob at head', () => {
    const { root, baseSha } = initGitFixture();
    expect(() => verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: 'does-not-exist',
      headRef: baseSha,
    })).toThrow(/base ref does not resolve/i);

    const policyPath = join(root, RELEASE_MANIFEST_SCHEMA_POLICY_PATH);
    rmSync(policyPath);
    writeFileSync(join(root, 'linked-policy.json'), `${JSON.stringify(canonicalPolicy)}\n`);
    symlinkSync('../../linked-policy.json', policyPath);
    git(root, ['add', RELEASE_MANIFEST_SCHEMA_POLICY_PATH, 'linked-policy.json']);
    git(root, ['commit', '-q', '-m', 'symbolic policy']);
    const headSha = git(root, ['rev-parse', 'HEAD']);
    expect(() => verifyReleaseManifestSchemaPolicyRefs({
      root,
      baseRef: baseSha,
      headRef: headSha,
    })).toThrow(/non-executable regular Git blob/i);
  });

  it('binds the CLI to required exact refs and emits a machine-readable verdict', () => {
    const { root, baseSha } = initGitFixture();
    const headPolicy = clonePolicy();
    headPolicy.generations.push(makeGeneration(4));
    const headSha = commitPolicy(root, headPolicy);
    const run = spawnSync(process.execPath, [
      guardScript,
      '--root', root,
      '--base', baseSha,
      '--head', headSha,
    ], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      schema: 'nexus.release-manifest-schema-guard-result.v1',
      ok: true,
      baseSha,
      headSha,
      transition: 'compatible_policy_update',
    });
    const linkedGuard = join(fixtureRoot('nexus-schema-guard-link-'), 'guard.mjs');
    symlinkSync(guardScript, linkedGuard);
    const linkedRun = spawnSync(process.execPath, [
      linkedGuard,
      '--root', root,
      '--base', baseSha,
      '--head', headSha,
    ], { encoding: 'utf8' });
    expect(linkedRun.status, linkedRun.stderr).toBe(0);
    expect(JSON.parse(linkedRun.stdout)).toMatchObject({
      schema: 'nexus.release-manifest-schema-guard-result.v1',
      ok: true,
      baseSha,
      headSha,
    });
    expect(() => parseReleaseManifestSchemaGuardArgs(['--base', baseSha]))
      .toThrow(/--base and --head are required/i);
  });
});
