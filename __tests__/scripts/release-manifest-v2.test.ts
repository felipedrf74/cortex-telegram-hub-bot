import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReleaseArtifactManifest } from '../../scripts/lib/release-artifact-manifest.mjs';

const roots: string[] = [];
const script = path.resolve('scripts/release-manifest-v2.mjs');
const governedLocalCommands = [
  'typecheck',
  'build',
  'migration-rehearsal',
  'changed-critical-union',
  'content-engine-pytest',
  'artifact-validation',
];
const localFixtureEnv = {
  ...process.env,
  NODE_ENV: 'test',
  GITHUB_ACTIONS: 'false',
  GITHUB_RUN_ID: '',
  GITHUB_RUN_ATTEMPT: '',
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function validDistributionBinding(iosSha: string, buildNumber: number) {
  return {
    result: 'passed',
    attestationDigest: '1'.repeat(64),
    payloadDigest: '2'.repeat(64),
    sourceCommit: iosSha,
    sourceTree: '3'.repeat(40),
    release: {
      bundleId: 'me.nexushub.app',
      teamId: 'B6885R8NWM',
      marketingVersion: '1.5.0',
      buildNumber: String(buildNumber),
      configuration: 'Release',
    },
    archive: { artifactDigest: '4'.repeat(64), appDigest: '5'.repeat(64) },
    exportedArtifact: {
      artifactDigest: '6'.repeat(64),
      artifactSemantics: 'nexus.raw-file.v1',
      appDigest: '7'.repeat(64),
    },
    toolchain: { xcodeVersion: '26.4', xcodeBuild: '17E300', sdkName: 'iphoneos26.4' },
    ci: {
      buildId: '123e4567-e89b-12d3-a456-426614174000',
      buildNumber: '17',
      workflow: 'App Store Release',
      workflowId: '20e0adf7-2854-4207-98eb-8f3b5afcac60',
    },
  };
}

function ciReleaseResults({
  runtimeSha,
  policyDigest,
  completedAt = new Date().toISOString(),
  counts = { vitest: 1, pytest: 1 },
  runId = '12345',
  runAttempt = '1',
  artifactDigest,
}: {
  runtimeSha: string;
  policyDigest: string;
  completedAt?: string;
  counts?: { vitest: number; pytest: number };
  runId?: string;
  runAttempt?: string;
  artifactDigest?: string;
}) {
  const testFile = '__tests__/scripts/release-manifest-v2.test.ts';
  const files = [testFile];
  const selection = {
    schema: 'nexus.release-test-selection.v1',
    tier: 'changed-critical-cannot-skip',
    headSha: runtimeSha,
    baseSha: runtimeSha,
    policyDigest,
    fullRequired: false,
    fullRequiredReason: null,
    selected: {
      changed: files,
      critical: [],
      cannotSkip: [],
      removed: [],
      removedDigest: createHash('sha256').update('[]').digest('hex'),
      unresolved: [],
      unresolvedDigest: createHash('sha256').update('[]').digest('hex'),
      files,
      filesDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    },
    classifier: { impactResolved: true, fullSuiteTrigger: false, cannotSkip: [] },
    nightlyEvidence: { headSha: runtimeSha, completedAt, runId: '777', runAttempt: '1' },
  };
  return {
    schema: 'nexus.release-test-results.v2',
    status: 'passed',
    runtimeSha,
    completedAt,
    tier: selection.tier,
    selection,
    testPolicyDigest: policyDigest,
    toolchain: { node: process.version, python: 'Python 3.12.0' },
    counts,
    ci: { runId, runAttempt },
    ...(artifactDigest ? { artifactDigest } : {}),
  };
}

function createSharedManifestFixtureRoot(parent: string) {
  const root = path.join(parent, 'source');
  const fixture = {
    schema: 'nexus.backend-ios-contract-fixtures.v1',
    contracts: [
      { id: 'dashboard.home.v1', method: 'GET', path: '/api/v1/dashboard/home', decoder: 'HomeViewState', payload: {} },
      { id: 'training.home.v1', method: 'GET', path: '/api/v1/training/home', decoder: 'TrainingHomeViewState', payload: {} },
      { id: 'content.home.v1', method: 'GET', path: '/api/v1/content/home', decoder: 'ContentHomeViewState', payload: {} },
    ],
  };
  fs.mkdirSync(path.join(root, 'dist/release'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'catalog/training/exercise-media/v1/authored-content'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"4.14.224"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3}\n');
  fs.copyFileSync('config/test-policy.json', path.join(root, 'config/test-policy.json'));
  fs.writeFileSync(path.join(root, 'dist/index.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(root, 'dist/release/backend-ios-contract-fixture.v1.json'),
    `${JSON.stringify(fixture)}\n`,
  );
  fs.writeFileSync(path.join(root, 'migrations/001_fixture.sql'), 'SELECT 1;\n');
  fs.writeFileSync(
    path.join(root, 'catalog/training/exercise-media/v1/materialization-attestation.json'),
    '{"releaseSubjectHash":"fixture-release-subject","status":"inactive"}\n',
  );
  fs.writeFileSync(
    path.join(root, 'catalog/training/exercise-media/v1/authored-content/materialization-policy.json'),
    '{"approvedOrigin":"fixture","activationState":"inactive"}\n',
  );
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'release-fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Release Fixture'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ReleaseManifestV2', () => {
  it('validates the sealed immutable bundle and rejects undeclared files', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-bundle-validation-'));
    roots.push(temp);
    const bundleRoot = path.join(temp, 'bundle');
    const manifestPath = path.join(temp, 'manifest.json');
    const publicPath = path.join(temp, 'public.pem');
    const runtimeSha = 'a'.repeat(40);
    const policyBody = `${JSON.stringify({
      releaseEvidence: {
        defaultTier: 'changed-critical-cannot-skip',
        fullTier: 'full-sharded',
        qualifyingNightly: {
          workflowPath: '.github/workflows/nightly.yml',
          workflowName: 'Nightly — Full regression + coverage',
          artifactPrefix: 'nightly-full-suite-evidence-',
          maxAgeHours: 36,
        },
      },
    })}\n`;
    fs.mkdirSync(path.join(bundleRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), '{"version":"4.14.220"}\n');
    fs.writeFileSync(path.join(bundleRoot, 'config/test-policy.json'), policyBody);

    const artifact = buildReleaseArtifactManifest(bundleRoot);
    artifact.git.sha = runtimeSha;
    fs.writeFileSync(
      path.join(bundleRoot, 'artifact-manifest.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(bundleRoot, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha,
      artifactDigest: artifact.digest,
      fileCount: artifact.fileCount,
    }, null, 2)}\n`);

    const policyDigest = createHash('sha256').update(policyBody).digest('hex');
    const generatedAt = new Date().toISOString();
    const payload = {
      schema: 'nexus.release-manifest-payload.v2',
      runtimeSha,
      docsHead: runtimeSha,
      source: { dirty: false },
      packageVersion: '4.14.220',
      generatedAt,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      artifact: {
        schema: artifact.schema,
        digest: artifact.digest,
        fileCount: artifact.fileCount,
        files: artifact.files,
      },
      testPolicy: {
        digest: policyDigest,
        results: ciReleaseResults({
          runtimeSha,
          policyDigest,
          completedAt: generatedAt,
          counts: { vitest: 13_310, pytest: 208 },
          artifactDigest: artifact.digest,
        }),
      },
      ios: null,
    };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }));
    const envelope = {
      schema: 'nexus.release-manifest.v2',
      keyId: 'fixture-key',
      signatureAlgorithm: 'ed25519',
      payload,
      signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
    };
    const manifestBody = `${JSON.stringify(envelope, null, 2)}\n`;
    fs.writeFileSync(manifestPath, manifestBody);

    const args = [script, 'validate',
      '--manifest', manifestPath,
      '--root', bundleRoot,
      '--verify-bundle',
      '--public-key', publicPath,
      '--allow-test-key',
      '--expect-runtime-sha', runtimeSha,
    ];
    const validated = JSON.parse(execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    }));
    expect(validated).toMatchObject({ ok: true, promotable: true, artifactDigest: artifact.digest });

    const unboundEnvelope = structuredClone(envelope);
    delete unboundEnvelope.payload.ios;
    unboundEnvelope.signature = sign(
      null,
      Buffer.from(canonicalJson(unboundEnvelope.payload)),
      privateKey,
    ).toString('base64');
    fs.writeFileSync(manifestPath, `${JSON.stringify(unboundEnvelope, null, 2)}\n`);
    const unbound = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(unbound.status).toBe(1);
    expect(JSON.parse(unbound.stdout).reasons).toContain('ios_contract_binding_missing');
    fs.writeFileSync(manifestPath, manifestBody);

    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...envelope, signature: 'AA==' }, null, 2)}\n`);
    const invalidSignature = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(invalidSignature.status).toBe(1);
    expect(JSON.parse(invalidSignature.stdout).reasons).toContain('signature_invalid');
    fs.writeFileSync(manifestPath, manifestBody);

    fs.writeFileSync(path.join(bundleRoot, 'package.json'), '{"version":"tampered"}\n');
    const changedByte = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(changedByte.status).toBe(1);
    expect(changedByte.stderr).toContain('release bundle artifact byte identity mismatch');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), '{"version":"4.14.220"}\n');

    fs.writeFileSync(path.join(bundleRoot, '.npmrc'), 'ignore-scripts=false\n');
    const injected = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(injected.status).toBe(1);
    expect(injected.stderr).toContain('release bundle contains undeclared or missing files');
  });

  it('writes and validates a non-promotable unsigned RC payload without a private key', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-unsigned-'));
    roots.push(temp);
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.unsigned.json');
    const fixtureRoot = createSharedManifestFixtureRoot(temp);
    const runtimeSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    }).trim();
    fs.writeFileSync(resultsPath, JSON.stringify({
      schema: 'nexus.release-test-results.v1',
      status: 'passed',
      runtimeSha,
      completedAt: new Date().toISOString(),
      toolchain: { node: process.version, python: 'Python 3.12.0' },
      commands: governedLocalCommands,
    }));

    const unclassified = spawnSync(process.execPath, [script, 'write',
      '--root', fixtureRoot,
      '--allow-unsigned',
      '--allow-dirty',
      '--key-id', 'unsigned-release-candidate',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: localFixtureEnv });
    expect(unclassified.status).not.toBe(0);
    expect(unclassified.stderr).toContain('release contract scope must be explicit');
    expect(fs.existsSync(manifestPath)).toBe(false);

    const contradictory = spawnSync(process.execPath, [script, 'write',
      '--root', fixtureRoot,
      '--backend-only',
      '--ios-sha', 'b'.repeat(40),
      '--allow-unsigned',
      '--allow-dirty',
      '--key-id', 'unsigned-release-candidate',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: localFixtureEnv });
    expect(contradictory.status).not.toBe(0);
    expect(contradictory.stderr).toContain('backend-only release must not include iOS contract fields');
    expect(fs.existsSync(manifestPath)).toBe(false);

    execFileSync(process.execPath, [script, 'write',
      '--root', fixtureRoot,
      '--backend-only',
      '--allow-unsigned',
      '--allow-dirty',
      '--key-id', 'unsigned-release-candidate',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
    ], { cwd: process.cwd(), env: localFixtureEnv });
    const validation = JSON.parse(execFileSync(process.execPath, [script, 'validate-payload',
      '--root', fixtureRoot,
      '--allow-dirty',
      '--manifest', manifestPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }));

    expect(validation).toMatchObject({ ok: true, promotable: false, unsignedCandidate: true });
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toMatchObject({
      keyId: 'unsigned-release-candidate',
      signature: null,
      payload: { ios: null },
    });
  });

  it('binds passing release tests, source identities, policy, artifact, and an Ed25519 signature', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-'));
    roots.push(temp);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'private.pem');
    const publicPath = path.join(temp, 'public.pem');
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.json');
    const fixtureRoot = createSharedManifestFixtureRoot(temp);
    const runtimeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' }).trim();
    const policyDigest = createHash('sha256')
      .update(fs.readFileSync(path.join(fixtureRoot, 'config/test-policy.json')))
      .digest('hex');
    fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }));
    fs.writeFileSync(resultsPath, JSON.stringify(ciReleaseResults({
      runtimeSha,
      policyDigest,
      counts: { vitest: 13_512, pytest: 194 },
    })));

    const incompleteIos = spawnSync(process.execPath, [script, 'write',
      '--includes-ios',
      '--root', fixtureRoot,
      '--ios-sha', 'b'.repeat(40),
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
      '--key-id', 'test-key',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });
    expect(incompleteIos.status).not.toBe(0);
    expect(incompleteIos.stderr).toContain('iOS build number must be a positive integer');
    expect(fs.existsSync(manifestPath)).toBe(false);

    execFileSync(process.execPath, [script, 'write',
      '--includes-ios',
      '--root', fixtureRoot,
      '--ios-sha', 'b'.repeat(40),
      '--ios-build-number', '59',
      '--ios-contract-result', 'passed',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
      '--key-id', 'test-key',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });
    const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(envelope.payload.ios.distribution).toBeNull();
    const missingDistribution = spawnSync(process.execPath, [script, 'validate',
      '--manifest', manifestPath,
      '--root', fixtureRoot,
      '--public-key', publicPath,
      '--allow-dirty',
      '--allow-test-key',
      '--require-ios-contract',
      '--expect-ios-sha', 'b'.repeat(40),
      '--expect-ios-build-number', '59',
      '--expect-ios-contract-result', 'passed',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect(missingDistribution.status).toBe(1);
    expect(JSON.parse(missingDistribution.stdout).reasons)
      .toContain('ios_distribution_evidence_missing');

    envelope.payload.ios.distribution = validDistributionBinding('b'.repeat(40), 59);
    envelope.signature = sign(
      null,
      Buffer.from(canonicalJson(envelope.payload)),
      privateKey,
    ).toString('base64');
    fs.writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
    const validated = JSON.parse(execFileSync(process.execPath, [script, 'validate',
      '--manifest', manifestPath,
      '--root', fixtureRoot,
      '--public-key', publicPath,
      '--allow-dirty',
      '--allow-test-key',
      '--require-ios-contract',
      '--expect-ios-sha', 'b'.repeat(40),
      '--expect-ios-build-number', '59',
      '--expect-ios-contract-result', 'passed',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }));

    expect(validated).toMatchObject({ ok: true, promotable: true });
    expect(JSON.parse(execFileSync(process.execPath, [script, 'validate',
      '--manifest', manifestPath,
      '--root', fixtureRoot,
      '--public-key', publicPath,
      '--allow-dirty',
      '--allow-test-key',
      '--require-ios-contract',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } })))
      .toMatchObject({ ok: true, contractScope: 'shared_backend_ios' });
    expect(envelope.schema).toBe('nexus.release-manifest.v2');
    expect(envelope.payload.runtimeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(envelope.payload.artifact.files.length).toBeGreaterThan(5);
    expect(envelope.payload.migration.latestId).toMatch(/^\d{3}_/);
    expect(envelope.payload.trainingCatalog.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.payload.testPolicy.results.status).toBe('passed');
    expect(envelope.payload.testPolicy.results.runtimeSha).toBe(envelope.payload.runtimeSha);
    expect(envelope.payload.testPolicy.results.artifactDigest).toBe(envelope.payload.artifact.digest);
    expect(envelope.payload.testPolicy.results.testPolicyDigest).toBe(envelope.payload.testPolicy.digest);
    expect(envelope.payload.ios).toEqual({
      sha: 'b'.repeat(40),
      buildNumber: 59,
      contractTestResult: 'passed',
      fixtureDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      contractDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      distribution: validDistributionBinding('b'.repeat(40), 59),
    });

    const tamperedIos = structuredClone(envelope);
    tamperedIos.payload.ios.buildNumber = '59';
    tamperedIos.signature = sign(
      null,
      Buffer.from(canonicalJson(tamperedIos.payload)),
      privateKey,
    ).toString('base64');
    fs.writeFileSync(manifestPath, `${JSON.stringify(tamperedIos, null, 2)}\n`);
    const invalidIos = spawnSync(process.execPath, [script, 'validate',
      '--manifest', manifestPath,
      '--root', fixtureRoot,
      '--public-key', publicPath,
      '--allow-dirty',
      '--allow-test-key',
      '--require-ios-contract',
      '--expect-ios-sha', 'b'.repeat(40),
      '--expect-ios-build-number', '59',
      '--expect-ios-contract-result', 'passed',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect(invalidIos.status).toBe(1);
    expect(JSON.parse(invalidIos.stdout).reasons).toContain('ios_contract_build_number_invalid');

    for (const [field, expectedReason] of [
      ['fixtureDigest', 'ios_contract_fixture_digest_mismatch'],
      ['contractDigest', 'ios_contract_digest_mismatch'],
    ] as const) {
      const drifted = structuredClone(envelope);
      drifted.payload.ios[field] = '0'.repeat(64);
      drifted.signature = sign(
        null,
        Buffer.from(canonicalJson(drifted.payload)),
        privateKey,
      ).toString('base64');
      fs.writeFileSync(manifestPath, `${JSON.stringify(drifted, null, 2)}\n`);
      const result = spawnSync(process.execPath, [script, 'validate',
        '--manifest', manifestPath,
        '--root', fixtureRoot,
        '--public-key', publicPath,
        '--allow-dirty',
        '--allow-test-key',
        '--require-ios-contract',
      ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).reasons).toContain(expectedReason);
    }

    for (const [mutate, expectedReason] of [
      [
        (value: any) => { value.sourceCommit = 'c'.repeat(40); },
        'ios_distribution_sha_mismatch',
      ],
      [
        (value: any) => { value.release.buildNumber = '60'; },
        'ios_distribution_release_identity_mismatch',
      ],
      [
        (value: any) => { value.ci.buildId = 'not-a-uuid'; },
        'ios_distribution_ci_identity_invalid',
      ],
    ] as const) {
      const drifted = structuredClone(envelope);
      mutate(drifted.payload.ios.distribution);
      drifted.signature = sign(
        null,
        Buffer.from(canonicalJson(drifted.payload)),
        privateKey,
      ).toString('base64');
      fs.writeFileSync(manifestPath, `${JSON.stringify(drifted, null, 2)}\n`);
      const result = spawnSync(process.execPath, [script, 'validate',
        '--manifest', manifestPath,
        '--root', fixtureRoot,
        '--public-key', publicPath,
        '--allow-dirty',
        '--allow-test-key',
        '--require-ios-contract',
      ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).reasons).toContain(expectedReason);
    }

    envelope.keyId = 'github-environment-release-signing-2026-07';
    envelope.signature = sign(
      null,
      Buffer.from(canonicalJson(envelope.payload)),
      privateKey,
    ).toString('base64');
    fs.writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
    const override = spawnSync(process.execPath, [script, 'validate',
      '--manifest', manifestPath,
      '--root', fixtureRoot,
      '--public-key', publicPath,
      '--allow-dirty',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect(override.status).toBe(1);
    expect(JSON.parse(override.stdout).reasons).toContain('public_key_identity_mismatch');
  });

  it('refuses to sign vague passed results without the governed evidence schema', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-vague-'));
    roots.push(temp);
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'private.pem');
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.json');
    fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(resultsPath, JSON.stringify({ status: 'passed' }));

    const result = spawnSync(process.execPath, [script, 'write',
      '--backend-only',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release_test_schema_invalid');
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('rejects arbitrary local command labels', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-local-command-'));
    roots.push(temp);
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'private.pem');
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.json');
    fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(resultsPath, JSON.stringify({
      schema: 'nexus.release-test-results.v1',
      status: 'passed',
      runtimeSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      completedAt: new Date().toISOString(),
      toolchain: { node: process.version, python: 'Python 3.12.0' },
      commands: ['fixture-verifier'],
    }));

    const result = spawnSync(process.execPath, [script, 'write',
      '--backend-only',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release_test_local_commands_mismatch');
  });

  it('rejects CI results copied from another run and non-positive suite counts', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-ci-identity-'));
    roots.push(temp);
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'private.pem');
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.json');
    const runtimeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const policyDigest = createHash('sha256').update(fs.readFileSync('config/test-policy.json')).digest('hex');
    fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(resultsPath, JSON.stringify(ciReleaseResults({
      runtimeSha,
      policyDigest,
      counts: { vitest: 0, pytest: 0 },
      runId: 'copied-run',
      runAttempt: '9',
    })));

    const result = spawnSync(process.execPath, [script, 'write',
      '--backend-only',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_RUN_ID: 'current-run', GITHUB_RUN_ATTEMPT: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release_test_ci_identity_mismatch');
    expect(result.stderr).toContain('release_test_vitest_count_invalid');
    expect(result.stderr).toContain('release_test_pytest_count_invalid');
  });

  it.each([
    ['future', new Date(Date.now() + 60_000).toISOString(), 'release_test_completed_at_future'],
    ['stale', new Date(Date.now() - (7 * 60 * 60 * 1_000)).toISOString(), 'release_test_completed_at_stale'],
  ])('rejects %s release-test timestamps', (_label, completedAt, reason) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-time-'));
    roots.push(temp);
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'private.pem');
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.json');
    fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(resultsPath, JSON.stringify({
      schema: 'nexus.release-test-results.v1',
      status: 'passed',
      runtimeSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      completedAt,
      toolchain: { node: process.version, python: 'Python 3.12.0' },
      commands: governedLocalCommands,
    }));

    const result = spawnSync(process.execPath, [script, 'write',
      '--backend-only',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(reason);
  });

  it('keeps old unbound v2 evidence readable but rejects it for promotion', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-legacy-'));
    roots.push(temp);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'private.pem');
    const publicPath = path.join(temp, 'public.pem');
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.json');
    const runtimeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }));
    fs.writeFileSync(resultsPath, JSON.stringify({
      schema: 'nexus.release-test-results.v1',
      status: 'passed',
      runtimeSha,
      completedAt: new Date().toISOString(),
      toolchain: { node: process.version, python: 'Python 3.12.0' },
      commands: governedLocalCommands,
    }));
    execFileSync(process.execPath, [script, 'write',
      '--backend-only',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
    ], { cwd: process.cwd(), env: localFixtureEnv });

    const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    envelope.keyId = 'github-actions-release-manifest-2026-07';
    delete envelope.payload.testPolicy.results.artifactDigest;
    delete envelope.payload.testPolicy.results.testPolicyDigest;
    envelope.signature = sign(
      null,
      Buffer.from(canonicalJson(envelope.payload)),
      privateKey,
    ).toString('base64');
    fs.writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);

    const result = spawnSync(process.execPath, [script, 'validate',
      '--manifest', manifestPath,
      '--public-key', publicPath,
      '--allow-dirty',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    const validation = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(validation).toMatchObject({ ok: false, promotable: false, legacyReadable: true });
    expect(validation.reasons).toEqual(expect.arrayContaining([
      'legacy_signing_key_non_reusable',
      'release_test_artifact_digest_mismatch',
      'release_test_policy_digest_mismatch',
    ]));
  });
});
