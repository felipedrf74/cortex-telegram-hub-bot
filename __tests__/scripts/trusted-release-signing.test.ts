import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backendIosContractDigest,
  IOS_CONTRACT_TEST_SELECTORS,
  isGitAncestor,
  resolveTrustedIosBinding,
  validateCandidateManifestTiming,
  validateGitHubIdentity,
  validateIosContractAttestation,
  validateNightlyGitHubIdentity,
  validateRecomputedSelection,
  validateTestEvidence,
} from '../../scripts/trusted-release-signer.mjs';
import { validateIosDistributionAttestation } from '../../scripts/lib/ios-distribution-attestation.mjs';
import { partitionTestFiles } from '../../scripts/lib/test-policy.mjs';

const runtimeSha = 'a'.repeat(40);
const repository = 'felipedrf74/cortex-telegram-hub-bot';
const candidateRunId = '123456789';
const roots: string[] = [];

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function fullIdentitySelection() {
  return { tier: 'full-sharded', fullRequired: true };
}

function defaultIdentitySelection() {
  return { tier: 'changed-critical-cannot-skip', fullRequired: false };
}

function successfulIdentity(selection = fullIdentitySelection()) {
  const runStartedAt = new Date(Date.now() - 120_000).toISOString();
  const runUpdatedAt = new Date(Date.now() - 30_000).toISOString();
  const tierJobs = selection.fullRequired
    ? [1, 2, 3, 4].map((shard) => `🧪 Full Vitest shard ${shard}/4`)
    : ['🧪 Policy-selected Vitest'];
  return {
    run: {
      id: Number(candidateRunId),
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      head_sha: runtimeSha,
      path: '.github/workflows/release-candidate-evidence.yml',
      event: 'workflow_dispatch',
      run_started_at: runStartedAt,
      updated_at: runUpdatedAt,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
    },
    jobs: {
      jobs: [
        '🔗 Validate release contract binding',
        '🧭 Resolve release test tier',
        ...tierJobs,
        '🐍 Content Engine full pytest',
        '📦 Write unsigned release candidate',
      ].map((name, index) => ({ id: index + 1, name, conclusion: 'success' })),
    },
    artifacts: {
      artifacts: [{
        id: 987654,
        name: `release-candidate-v2-${runtimeSha}`,
        expired: false,
        size_in_bytes: 1024,
        digest: `sha256:${'b'.repeat(64)}`,
        workflow_run: { id: Number(candidateRunId), head_sha: runtimeSha },
      }],
    },
  };
}

function iosEvidenceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ios-contract-evidence-'));
  roots.push(root);
  const trustedRoot = path.join(root, 'trusted');
  const evidenceRoot = path.join(root, 'evidence');
  const distributionEvidenceRoot = path.join(root, 'distribution-evidence');
  fs.mkdirSync(path.join(trustedRoot, 'docs/release/evidence'), { recursive: true });
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(distributionEvidenceRoot, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(
    path.join(trustedRoot, 'docs/release/evidence/ios-contract-evidence-public-key.pem'),
    publicKey.export({ format: 'pem', type: 'spki' }),
  );
  const iosEvidenceRunId = '24681012';
  const iosSha = 'c'.repeat(40);
  const artifactDigest = 'd'.repeat(64);
  const fixtureDocument = {
    schema: 'nexus.backend-ios-contract-fixtures.v1',
    contracts: [
      { id: 'dashboard.home.v1', method: 'GET', path: '/api/v1/dashboard/home', decoder: 'HomeViewState', payload: {} },
      { id: 'training.home.v1', method: 'GET', path: '/api/v1/training/home', decoder: 'TrainingHomeViewState', payload: {} },
      { id: 'content.home.v1', method: 'GET', path: '/api/v1/content/home', decoder: 'ContentHomeViewState', payload: {} },
    ],
  };
  const fixtureBytes = Buffer.from(`${JSON.stringify(fixtureDocument)}\n`);
  const fixtureIdentity = {
    fixture: fixtureDocument,
    bytes: fixtureBytes,
    digest: createHash('sha256').update(fixtureBytes).digest('hex'),
    base64: fixtureBytes.toString('base64'),
    path: path.join(root, 'fixture.json'),
    relativePath: 'dist/release/backend-ios-contract-fixture.v1.json',
  };
  const generatedAt = new Date(Date.now() - 60_000);
  const contractDigest = backendIosContractDigest({
    runtimeSha,
    artifactDigest,
    fixtureDigest: fixtureIdentity.digest,
  });
  const selectionDigest = createHash('sha256')
    .update(canonicalJson(IOS_CONTRACT_TEST_SELECTORS))
    .digest('hex');
  const payload = {
    schema: 'nexus.ios-contract-attestation-payload.v2',
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 24 * 3_600_000).toISOString(),
    ios: { repository: 'felipedrf74/nexus-hub-ios', sha: iosSha, buildNumber: '59' },
    backend: {
      repository,
      runtimeSha,
      artifactDigest,
      contractDigest,
      fixture: {
        schema: 'nexus.backend-ios-contract-fixtures.v1',
        path: 'dist/release/backend-ios-contract-fixture.v1.json',
        digest: fixtureIdentity.digest,
      },
    },
    contractSuite: {
      name: 'Nexus Hub contract decoder suite',
      result: 'passed',
      testCount: 27,
      passedCount: 27,
      failedCount: 0,
      skippedCount: 0,
      testSelectors: IOS_CONTRACT_TEST_SELECTORS,
      selectionDigest,
    },
    ci: {
      provider: 'github-actions',
      workflow: 'iOS Contract Evidence',
      runId: iosEvidenceRunId,
      runAttempt: '3',
    },
  };
  const attestation = {
    schema: 'nexus.ios-contract-attestation.v2',
    keyId: 'ios-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
  };
  fs.writeFileSync(path.join(evidenceRoot, 'ios-contract-attestation.json'), JSON.stringify(attestation));
  const distributionKeyPair = generateKeyPairSync('ed25519');
  const rawDistributionPublicKey = Buffer.from(
    distributionKeyPair.publicKey.export({ format: 'der', type: 'spki' }),
  ).subarray(-32);
  fs.writeFileSync(
    path.join(trustedRoot, 'docs/release/evidence/ios-distribution-public-key.b64'),
    `${rawDistributionPublicKey.toString('base64')}\n`,
  );
  const digestValue = (value: string, semantics = 'nexus.raw-file.v1') => ({
    algorithm: 'sha256', semantics, value,
  });
  const appIdentity = {
    bundleId: 'me.nexushub.app',
    marketingVersion: '1.5.0',
    buildNumber: '59',
  };
  const artifactBlock = (seed: string, pathKind: string, semantics: string) => ({
    artifactDigest: digestValue(seed.repeat(64), semantics),
    appDigest: digestValue(String.fromCharCode(seed.charCodeAt(0) + 1).repeat(64), 'nexus.canonical-tree.v1'),
    infoPlistDigest: digestValue(String.fromCharCode(seed.charCodeAt(0) + 2).repeat(64)),
    executableDigest: digestValue(String.fromCharCode(seed.charCodeAt(0) + 3).repeat(64)),
    identity: appIdentity,
    pathKind,
    signing: {
      identifier: 'me.nexushub.app',
      teamIdentifier: 'B6885R8NWM',
      cdHash: 'e'.repeat(40),
      authorities: [
        'Apple Distribution: Nexus Hub (B6885R8NWM)',
        'Apple Worldwide Developer Relations Certification Authority',
        'Apple Root CA',
      ],
      entitlementsSha256: 'f'.repeat(64),
      verification: 'codesign-deep-strict',
    },
  });
  const distributionPayload = {
    schema: 'nexus.ios-distribution-attestation-payload.v1',
    generatedAt: generatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: new Date(generatedAt.getTime() + 24 * 3_600_000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      repository: 'felipedrf74/nexus-hub-ios',
      commit: iosSha,
      tree: 'd'.repeat(40),
      ref: 'refs/heads/main',
      clean: true,
    },
    release: {
      bundleId: 'me.nexushub.app',
      teamId: 'B6885R8NWM',
      marketingVersion: '1.5.0',
      buildNumber: '59',
      configuration: 'Release',
    },
    archive: artifactBlock('1', 'xcarchive-directory', 'nexus.canonical-tree.v1'),
    distribution: artifactBlock('5', 'ipa-file', 'nexus.raw-file.v1'),
    toolchain: {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '26.4',
      xcodeBuild: '17E300',
      sdkName: 'iphoneos26.4',
      hostVersion: '26.4',
      hostBuild: '25E100',
      archiveXcode: '2640',
      archiveXcodeBuild: '17E300',
      archiveSDK: 'iphoneos26.4',
      archiveHostBuild: '25E100',
    },
    ci: {
      provider: 'xcode-cloud',
      buildId: '123e4567-e89b-12d3-a456-426614174000',
      buildNumber: '17',
      buildUrl: 'https://appstoreconnect.apple.com/teams/502b7720-ce21-4a3a-bced-bf176ed4a127/apps/6762022696/ci/builds/123e4567-e89b-12d3-a456-426614174000',
      workflow: 'App Store Release',
      workflowId: '20e0adf7-2854-4207-98eb-8f3b5afcac60',
      startCondition: 'manual',
      action: 'archive',
    },
  };
  const signDistribution = (payloadValue: typeof distributionPayload) => ({
    schema: 'nexus.ios-distribution-attestation.v1',
    keyId: 'ios-distribution-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload: payloadValue,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payloadValue)),
      distributionKeyPair.privateKey,
    ).toString('base64'),
  });
  const distributionAttestation = signDistribution(distributionPayload);
  fs.writeFileSync(
    path.join(distributionEvidenceRoot, 'ios-distribution-attestation.json'),
    JSON.stringify(distributionAttestation),
  );
  return {
    trustedRoot,
    evidenceRoot,
    distributionEvidenceRoot,
    privateKey,
    iosEvidenceRunId,
    iosSha,
    artifactDigest,
    fixtureIdentity,
    contractDigest,
    attestation,
    distributionPayload,
    distributionAttestation,
    signDistribution,
  };
}

function recomputationFixture({
  full = false,
  removed = [] as string[],
  unresolved = [] as string[],
} = {}) {
  const changed = ['__tests__/services/changed.test.ts'];
  const critical = ['__tests__/security/critical.test.ts'];
  const cannotSkip = ['__tests__/scope/tenant.test.ts'];
  const selectedFiles = [...new Set([...changed, ...critical, ...cannotSkip])].sort();
  const allFiles = [...selectedFiles, '__tests__/services/other.test.ts'].sort();
  const impactResolved = unresolved.length === 0;
  const classifier = {
    baseRef: runtimeSha,
    flags: { impactResolved: true, fullSuiteTrigger: false },
    cannotSkip: ['tenant-isolation'],
  };
  const selected = {
    base: runtimeSha,
    changed,
    critical,
    cannotSkip,
    removed,
    unresolved,
    impactResolved: impactResolved && removed.length === 0,
    selected: selectedFiles,
  };
  const files = full ? allFiles : selectedFiles;
  const selection = {
    baseSha: runtimeSha,
    selected: {
      changed,
      critical,
      cannotSkip,
      removed,
      removedDigest: digest(removed),
      unresolved,
      unresolvedDigest: digest(unresolved),
      files,
      filesDigest: digest(files),
    },
    classifier: {
      impactResolved: impactResolved && removed.length === 0,
      fullSuiteTrigger: false,
      cannotSkip: ['tenant-isolation'],
    },
    fullRequired: full,
  };
  return { selection, classifier, selected, allFiles };
}

function workflowRunBlocks(raw: string) {
  const lines = raw.split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const currentIndent = line.length - line.trimStart().length;
      if (line.trim() && currentIndent <= indent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('trusted release signing boundary', () => {
  it('derives a shared iOS binding only from exact signed candidate-fixture evidence', () => {
    expect(resolveTrustedIosBinding({ contractScope: 'backend_only' })).toEqual({
      binding: null,
      evidence: null,
    });
    const fixture = iosEvidenceFixture();
    const resolved = resolveTrustedIosBinding({
      contractScope: 'shared_backend_ios',
      runtimeSha,
      artifactDigest: fixture.artifactDigest,
      fixtureIdentity: fixture.fixtureIdentity,
      evidenceRoot: fixture.evidenceRoot,
      distributionEvidenceRoot: fixture.distributionEvidenceRoot,
      trustedRoot: fixture.trustedRoot,
    });

    expect(resolved).toMatchObject({
      binding: {
        sha: fixture.iosSha,
        buildNumber: 59,
        contractTestResult: 'passed',
        fixtureDigest: fixture.fixtureIdentity.digest,
        contractDigest: fixture.contractDigest,
        distribution: {
          result: 'passed',
          sourceCommit: fixture.iosSha,
          release: { buildNumber: '59' },
          ci: { buildId: '123e4567-e89b-12d3-a456-426614174000' },
        },
      },
      evidence: {
        runId: fixture.iosEvidenceRunId,
        runAttempt: '3',
        contractDigest: fixture.contractDigest,
        fixtureDigest: fixture.fixtureIdentity.digest,
      },
    });
    expect(resolved.evidence?.attestationDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(() => resolveTrustedIosBinding({ contractScope: '' }))
      .toThrow('release contract scope is invalid');
    expect(() => resolveTrustedIosBinding({
      contractScope: 'backend_only',
      evidenceRoot: fixture.evidenceRoot,
    })).toThrow('backend-only release must not include iOS evidence');
    expect(() => resolveTrustedIosBinding({
      contractScope: 'shared_backend_ios',
    })).toThrow('requires signed iOS evidence');
    expect(() => resolveTrustedIosBinding({
      contractScope: 'shared_backend_ios',
      evidenceRoot: fixture.evidenceRoot,
    })).toThrow('requires signed iOS distribution evidence');
  });

  it('fails closed on mismatched fixture, source, backend, timing, signature, and partial suites', () => {
    const fixture = iosEvidenceFixture();
    expect(validateIosContractAttestation({
      attestation: fixture.attestation,
      runtimeSha,
      artifactDigest: fixture.artifactDigest,
      fixtureIdentity: fixture.fixtureIdentity,
      trustedRoot: fixture.trustedRoot,
    })).toMatchObject({ binding: { buildNumber: 59, contractTestResult: 'passed' } });

    const wrongSource = structuredClone(fixture.attestation);
    wrongSource.payload.ios.sha = 'not-a-sha';
    expect(() => validateIosContractAttestation({
      attestation: wrongSource,
      runtimeSha,
      artifactDigest: fixture.artifactDigest,
      fixtureIdentity: fixture.fixtureIdentity,
      trustedRoot: fixture.trustedRoot,
    })).toThrow('source identity is invalid');

    const wrongBackend = structuredClone(fixture.attestation);
    wrongBackend.payload.backend.artifactDigest = 'f'.repeat(64);
    expect(() => validateIosContractAttestation({
      attestation: wrongBackend,
      runtimeSha,
      artifactDigest: fixture.artifactDigest,
      fixtureIdentity: fixture.fixtureIdentity,
      trustedRoot: fixture.trustedRoot,
    })).toThrow('backend release identity is invalid or mismatched');

    const wrongFixtureIdentity = {
      ...fixture.fixtureIdentity,
      digest: 'f'.repeat(64),
    };
    expect(() => validateIosContractAttestation({
      attestation: fixture.attestation,
      runtimeSha,
      artifactDigest: fixture.artifactDigest,
      fixtureIdentity: wrongFixtureIdentity,
      trustedRoot: fixture.trustedRoot,
    })).toThrow('backend release identity is invalid or mismatched');

    for (const mutate of [
      (value: any) => { value.contractSuite.passedCount = value.contractSuite.testCount - 1; },
      (value: any) => { value.contractSuite.skippedCount = 1; },
      (value: any) => { value.contractSuite.testSelectors = value.contractSuite.testSelectors.slice(1); },
      (value: any) => { value.contractSuite.selectionDigest = '0'.repeat(64); },
    ]) {
      const incompleteSuite = structuredClone(fixture.attestation);
      mutate(incompleteSuite.payload);
      expect(() => validateIosContractAttestation({
        attestation: incompleteSuite,
        runtimeSha,
        artifactDigest: fixture.artifactDigest,
        fixtureIdentity: fixture.fixtureIdentity,
        trustedRoot: fixture.trustedRoot,
      })).toThrow('suite evidence is invalid');
    }

    const expired = structuredClone(fixture.attestation);
    const oldGeneratedAt = new Date(Date.now() - 48 * 3_600_000);
    expired.payload.generatedAt = oldGeneratedAt.toISOString();
    expired.payload.expiresAt = new Date(oldGeneratedAt.getTime() + 24 * 3_600_000).toISOString();
    expect(() => validateIosContractAttestation({
      attestation: expired,
      runtimeSha,
      artifactDigest: fixture.artifactDigest,
      fixtureIdentity: fixture.fixtureIdentity,
      trustedRoot: fixture.trustedRoot,
    })).toThrow('timing is invalid');

    const tamperedSignature = structuredClone(fixture.attestation);
    tamperedSignature.signature = Buffer.alloc(64).toString('base64');
    expect(() => validateIosContractAttestation({
      attestation: tamperedSignature,
      runtimeSha,
      artifactDigest: fixture.artifactDigest,
      fixtureIdentity: fixture.fixtureIdentity,
      trustedRoot: fixture.trustedRoot,
    })).toThrow('signature is invalid');
  });

  it('requires a separately signed exact Xcode Cloud distribution proof', () => {
    const fixture = iosEvidenceFixture();
    expect(validateIosDistributionAttestation({
      attestation: fixture.distributionAttestation,
      iosSha: fixture.iosSha,
      buildNumber: 59,
      trustedRoot: fixture.trustedRoot,
    })).toMatchObject({
      binding: {
        result: 'passed',
        sourceCommit: fixture.iosSha,
        release: { buildNumber: '59' },
        exportedArtifact: { artifactSemantics: 'nexus.raw-file.v1' },
        ci: { buildId: '123e4567-e89b-12d3-a456-426614174000' },
      },
    });

    for (const [label, mutate, message] of [
      [
        'source',
        (payload: any) => { payload.source.commit = 'f'.repeat(40); },
        'source identity is invalid or mismatched',
      ],
      [
        'build',
        (payload: any) => { payload.release.buildNumber = '60'; },
        'release identity is invalid or mismatched',
      ],
      [
        'dirty checkout',
        (payload: any) => { payload.source.clean = false; },
        'source identity is invalid or mismatched',
      ],
      [
        'workflow',
        (payload: any) => { payload.ci.workflow = 'Untrusted archive'; },
        'CI identity is invalid or mismatched',
      ],
      [
        'unbound App Store URL',
        (payload: any) => { payload.ci.buildUrl = 'https://example.com/build'; },
        'CI identity is invalid or mismatched',
      ],
      [
        'incomplete certificate chain',
        (payload: any) => { payload.distribution.signing.authorities = ['Apple Distribution: Fake']; },
        'signing identity is invalid',
      ],
      [
        'reused archive toolchain',
        (payload: any) => { payload.toolchain.archiveXcodeBuild = 'OLD'; },
        'toolchain identity is invalid or mismatched',
      ],
    ] as const) {
      const payload = structuredClone(fixture.distributionPayload);
      mutate(payload);
      const attestation = fixture.signDistribution(payload as typeof fixture.distributionPayload);
      expect(() => validateIosDistributionAttestation({
        attestation,
        iosSha: fixture.iosSha,
        buildNumber: 59,
        trustedRoot: fixture.trustedRoot,
      }), label).toThrow(message);
    }

    const badSignature = structuredClone(fixture.distributionAttestation);
    badSignature.signature = Buffer.alloc(64).toString('base64');
    expect(() => validateIosDistributionAttestation({
      attestation: badSignature,
      iosSha: fixture.iosSha,
      buildNumber: 59,
      trustedRoot: fixture.trustedRoot,
    })).toThrow('signature is invalid');
  });

  it('binds candidate-generated time and nightly freshness to the trusted GitHub run', () => {
    const nowMs = Date.now();
    const runStartedAtMs = nowMs - 120_000;
    const runUpdatedAtMs = nowMs - 30_000;
    const generatedAtMs = nowMs - 60_000;
    expect(validateCandidateManifestTiming({
      generatedAtMs,
      expiresAtMs: generatedAtMs + 72 * 3_600_000,
      runStartedAtMs,
      runUpdatedAtMs,
      nowMs,
    })).toBe(runUpdatedAtMs);

    const backdatedGeneratedAtMs = nowMs - 48 * 3_600_000;
    expect(() => validateCandidateManifestTiming({
      generatedAtMs: backdatedGeneratedAtMs,
      expiresAtMs: backdatedGeneratedAtMs + 72 * 3_600_000,
      runStartedAtMs,
      runUpdatedAtMs,
      nowMs,
    })).toThrow('outside the trusted candidate GitHub run');
  });

  it('accepts only runtime commits reachable from protected main history', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(isGitAncestor(process.cwd(), head)).toBe(true);
    expect(isGitAncestor(process.cwd(), 'f'.repeat(40))).toBe(false);

    const workflow = fs.readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
    expect(workflow).toContain('fetch-depth: 0');
    expect(fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8'))
      .toContain("fail('candidate runtime SHA is not reachable from protected main')");
  });

  it.each([
    ['full-sharded', fullIdentitySelection()],
    ['changed plus critical plus cannot-skip', defaultIdentitySelection()],
  ])('accepts the exact successful %s job identity', (_label, selection) => {
    const identity = successfulIdentity(selection);
    expect(validateGitHubIdentity({
      ...identity,
      runtimeSha,
      repository,
      candidateRunId,
      selection,
    })).toMatchObject({
      runAttempt: '2',
      expectedArtifactName: `release-candidate-v2-${runtimeSha}`,
      artifact: { id: 987654 },
    });
  });

  it('does not use a raw release test-count floor', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8'));
    const signer = fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8');
    expect(policy.releaseEvidence.minimumTestCounts).toBeUndefined();
    expect(policy.releaseEvidence.defaultTier).toBe('changed-critical-cannot-skip');
    expect(signer).not.toContain('validateTestCountFloors');
    expect(signer).not.toContain('9000');
  });

  it.each([
    ['run id', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.id += 1; }, 'run id mismatch'],
    ['head SHA', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.head_sha = 'c'.repeat(40); }, 'head SHA mismatch'],
    ['workflow path', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.path = '.github/workflows/other.yml'; }, 'workflow path mismatch'],
    ['artifact run', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].workflow_run.id += 1; }, 'not bound'],
    ['artifact head', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].workflow_run.head_sha = 'd'.repeat(40); }, 'not bound'],
    ['artifact digest', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].digest = ''; }, 'digest is missing'],
    ['tier job', (identity: ReturnType<typeof successfulIdentity>) => { identity.jobs.jobs.splice(1, 1); }, 'missing, duplicated, or unsuccessful'],
    ['run timestamps', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.updated_at = 'invalid'; }, 'run timestamps are invalid'],
  ])('fails closed on mismatched %s candidate evidence', (_label, mutate, message) => {
    const selection = fullIdentitySelection();
    const identity = successfulIdentity(selection);
    mutate(identity);
    expect(() => validateGitHubIdentity({
      ...identity,
      runtimeSha,
      repository,
      candidateRunId,
      selection,
    })).toThrow(message);
  });

  it('independently rejects tampered selection arrays, digests, and classifier flags', () => {
    const fixture = recomputationFixture();
    expect(() => validateRecomputedSelection(fixture)).not.toThrow();

    const changed = structuredClone(fixture);
    changed.selection.selected.changed = [];
    expect(() => validateRecomputedSelection(changed)).toThrow('changed tests');

    const flags = structuredClone(fixture);
    flags.selection.classifier.impactResolved = false;
    expect(() => validateRecomputedSelection(flags)).toThrow('classifier flags');

    const fileDigest = structuredClone(fixture);
    fileDigest.selection.selected.filesDigest = 'f'.repeat(64);
    expect(() => validateRecomputedSelection(fileDigest)).toThrow('selected test digest');

    const removed = recomputationFixture({ full: true, removed: ['__tests__/services/retired.test.ts'] });
    expect(() => validateRecomputedSelection(removed)).not.toThrow();
    removed.selection.selected.removedDigest = '0'.repeat(64);
    expect(() => validateRecomputedSelection(removed)).toThrow('removed test digest');
  });

  it('recomputes missing-nightly full plans and binds unresolved impact paths', () => {
    const missingNightly = recomputationFixture({ full: true });
    expect(() => validateRecomputedSelection(missingNightly)).not.toThrow();

    const unresolved = recomputationFixture({ full: true, unresolved: ['src/services/unmapped.ts'] });
    expect(() => validateRecomputedSelection(unresolved)).not.toThrow();
    unresolved.selection.selected.unresolvedDigest = '0'.repeat(64);
    expect(() => validateRecomputedSelection(unresolved)).toThrow('unresolved dependency digest');
  });

  it('validates the actual qualifying-nightly run, artifact, evidence, and Git test-file digest', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-nightly-identity-'));
    roots.push(temp);
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const discoveredTestFiles = execFileSync('git', [
      'ls-tree', '-r', '--name-only', actualHead, '--', '__tests__',
    ], { encoding: 'utf8' }).trim().split(/\r?\n/)
      .filter((file) => /^__tests__\/.+\.test\.ts$/.test(file)).sort();
    const policyAtHead = JSON.parse(execFileSync('git', [
      'show', `${actualHead}:config/test-policy.json`,
    ], { encoding: 'utf8' }));
    const testFiles = partitionTestFiles(discoveredTestFiles, policyAtHead).deterministic;
    const policyDocument = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8'));
    const policy = policyDocument.releaseEvidence.qualifyingNightly;
    const policyDigest = createHash('sha256').update(fs.readFileSync('config/test-policy.json')).digest('hex');
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    const identity = { headSha: actualHead, completedAt, runId: '54321', runAttempt: '2' };
    const selection = { fullRequiredReason: null, nightlyEvidence: identity };
    const evidence = {
      schema: 'nexus.nightly-full-suite-evidence.v1',
      status: 'passed',
      tier: 'full-sharded',
      headSha: actualHead,
      completedAt,
      testPolicyDigest: policyDigest,
      counts: { vitest: 1 },
      testFiles: { count: testFiles.length, digest: digest(testFiles) },
      ci: { runId: '54321', runAttempt: '2', workflow: policy.workflowName },
    };
    fs.writeFileSync(path.join(temp, 'nightly-full-suite-evidence.json'), JSON.stringify(evidence));
    const run = {
      id: 54321,
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      path: policy.workflowPath,
      name: policy.workflowName,
      event: 'schedule',
      head_branch: 'main',
      head_sha: actualHead,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      run_started_at: new Date(Date.now() - 120_000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    const artifacts = { artifacts: [{
      id: 77,
      name: `${policy.artifactPrefix}54321-2`,
      expired: false,
      size_in_bytes: 512,
      digest: `sha256:${'e'.repeat(64)}`,
      workflow_run: { id: 54321, head_sha: actualHead },
    }] };
    const input = {
      selection,
      policy,
      policyDigest,
      run,
      artifacts,
      evidenceRoot: temp,
      repository,
      runtimeSha: actualHead,
      trustedReferenceTimeMs: Date.now(),
      candidateSourceRoot: process.cwd(),
    };
    expect(validateNightlyGitHubIdentity(input)).toMatchObject({ artifact: { id: 77 } });

    const wrongWorkflow = structuredClone(input);
    wrongWorkflow.run.path = '.github/workflows/other.yml';
    expect(() => validateNightlyGitHubIdentity(wrongWorkflow)).toThrow('workflow path or name');

    const wrongArtifact = structuredClone(input);
    wrongArtifact.artifacts.artifacts[0].workflow_run.id = 999;
    expect(() => validateNightlyGitHubIdentity(wrongArtifact)).toThrow('not bound');

    const tamperedEvidence = { ...evidence, testFiles: { ...evidence.testFiles, digest: '0'.repeat(64) } };
    fs.writeFileSync(path.join(temp, 'nightly-full-suite-evidence.json'), JSON.stringify(tamperedEvidence));
    expect(() => validateNightlyGitHubIdentity(input)).toThrow('Git test-file tree');
  });

  it('accepts stale-nightly identity only when a full result carries the stale reason', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stale-nightly-result-'));
    roots.push(temp);
    const resultsRoot = path.join(temp, '.local/release/rc-test-results');
    fs.mkdirSync(resultsRoot, { recursive: true });
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8'));
    const policyDigest = createHash('sha256').update(fs.readFileSync('config/test-policy.json')).digest('hex');
    const trustedReferenceTimeMs = Date.now();
    const staleAt = new Date(trustedReferenceTimeMs - 37 * 3_600_000).toISOString();
    const files = execFileSync('git', [
      'ls-tree', '-r', '--name-only', actualHead, '--', '__tests__',
    ], { encoding: 'utf8' }).trim().split(/\r?\n/)
      .filter((file) => /^__tests__\/.+\.test\.ts$/.test(file)).sort().slice(0, 4);
    const selection = {
      schema: 'nexus.release-test-selection.v1',
      tier: 'full-sharded',
      headSha: actualHead,
      baseSha: actualHead,
      policyDigest,
      fullRequired: true,
      fullRequiredReason: 'qualifying_nightly_evidence_stale',
      selected: {
        changed: [],
        critical: [],
        cannotSkip: [],
        removed: [],
        removedDigest: digest([]),
        unresolved: [],
        unresolvedDigest: digest([]),
        files,
        filesDigest: digest(files),
      },
      classifier: { impactResolved: true, fullSuiteTrigger: false, cannotSkip: [] },
      nightlyEvidence: {
        headSha: actualHead,
        completedAt: staleAt,
        runId: '54321',
        runAttempt: '1',
      },
    };
    for (let index = 0; index < files.length; index += 1) {
      fs.writeFileSync(path.join(resultsRoot, `vitest-results-${index + 1}.json`), JSON.stringify({
        success: true,
        numTotalTests: 1,
        testResults: [{ name: path.resolve(files[index]), assertionResults: [{ status: 'passed' }] }],
      }));
    }
    fs.writeFileSync(path.join(resultsRoot, 'pytest-results.log'), '1 passed in 0.01s\n');
    fs.writeFileSync(path.join(temp, '.local/release/test-results.json'), JSON.stringify({
      schema: 'nexus.release-test-results.v2',
      status: 'passed',
      runtimeSha: actualHead,
      completedAt: new Date(trustedReferenceTimeMs - 60_000).toISOString(),
      tier: 'full-sharded',
      selection,
      testPolicyDigest: policyDigest,
      toolchain: { node: 'v22.23.1', python: 'Python 3.12.0' },
      counts: { vitest: files.length, pytest: 1 },
      ci: { runId: '12345', runAttempt: '1' },
    }));

    expect(validateTestEvidence({
      candidateArtifactRoot: temp,
      runtimeSha: actualHead,
      runId: '12345',
      runAttempt: '1',
      trustedReferenceTimeMs,
      selection,
      trustedPolicy: policy,
      trustedPolicyDigest: policyDigest,
      candidateSourceRoot: process.cwd(),
    })).toMatchObject({ status: 'passed', tier: 'full-sharded' });
  });

  it('keeps candidate source inert while trusted tooling recomputes selection and fetches nightly proof', () => {
    const workflowsRoot = path.resolve('.github/workflows');
    const rc = fs.readFileSync(path.join(workflowsRoot, 'release-candidate-evidence.yml'), 'utf8');
    const manifestSigner = fs.readFileSync(path.join(workflowsRoot, 'sign-release-manifest.yml'), 'utf8');
    const stagingSigner = fs.readFileSync(path.join(workflowsRoot, 'sign-staging-attestation.yml'), 'utf8');
    const trustedSigner = fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8');
    const selector = fs.readFileSync('scripts/select-vitest-files.mjs', 'utf8');
    const staticMapper = fs.readFileSync('scripts/lib/static-test-dependency-map.mjs', 'utf8');
    const allWorkflows = fs.readdirSync(workflowsRoot)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => fs.readFileSync(path.join(workflowsRoot, name), 'utf8'))
      .join('\n');

    expect(rc).not.toContain('NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM');
    expect(allWorkflows.match(/secrets\.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM/g)).toHaveLength(2);
    for (const signer of [manifestSigner, stagingSigner]) {
      expect(signer).toContain('environment: release-signing');
      expect(signer).toContain("github.ref == 'refs/heads/main'");
      expect(signer).toContain('path: trusted-tooling');
      expect(signer).not.toMatch(/(?:node|bash|sh|npm|npx|\.\/)\s+candidate-(?:source|artifact)/);
      expect(signer).not.toContain('cd candidate-');
    }
    expect(selector).toContain('staticTestDependencyImpact');
    expect(selector).not.toContain('node_modules');
    expect(selector).not.toContain('vitest.config');
    expect(staticMapper).not.toMatch(/\beval\s*\(|new Function/);
    expect(manifestSigner).not.toMatch(/working-directory:\s*candidate-source/);
    expect(manifestSigner).toContain('nightly-request');
    expect(manifestSigner).toContain('/actions/runs/${NEXUS_NIGHTLY_RUN_ID}');
    expect(manifestSigner).toContain('--name "$NEXUS_NIGHTLY_ARTIFACT_NAME"');
    expect(trustedSigner).toContain('NEXUS_CLASSIFIER_REPO_ROOT: candidateSourceRoot');
    expect(trustedSigner).toContain('delete commandEnv.NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM');
  });

  it('validates dispatch identities and treats the compact signed iOS attestation as untrusted input', () => {
    const signer = fs.readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
    const runBlocks = workflowRunBlocks(signer).join('\n');
    const maliciousRunId = '29407618419?x=$(printf exfiltrate)';

    expect(Number.parseInt(maliciousRunId, 10)).toBe(29407618419);
    expect(/^[0-9]+$/.test(maliciousRunId)).toBe(false);
    expect(signer).toContain('[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(signer).toContain('[[ "$CANDIDATE_RUN_ID" =~ ^[0-9]+$ ]]');
    expect(signer).toContain('[[ -n "$IOS_ATTESTATION_BASE64" && ${#IOS_ATTESTATION_BASE64} -le 32768 ]]');
    expect(signer).toContain('[[ "$IOS_ATTESTATION_BASE64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]');
    expect(signer).toContain('[[ -n "$IOS_DISTRIBUTION_ATTESTATION_BASE64" && ${#IOS_DISTRIBUTION_ATTESTATION_BASE64} -le 131072 ]]');
    expect(signer).toContain('[[ "$IOS_DISTRIBUTION_ATTESTATION_BASE64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]');
    expect(signer).not.toContain('NEXUS_IOS_RELEASE_EVIDENCE_READ_TOKEN');
    expect(signer).not.toContain('repos/felipedrf74/nexus-hub-ios/actions/runs/');
    expect(signer).not.toContain('inputs.ios_sha');
    expect(signer).not.toContain('inputs.ios_build_number');
    expect(signer).not.toContain('inputs.ios_contract_result');
    expect(runBlocks).not.toContain('${{ inputs.');
    expect(runBlocks).toContain('--runtime-sha "$RUNTIME_SHA"');
    expect(runBlocks).toContain('--candidate-run-id "$CANDIDATE_RUN_ID"');
    expect(runBlocks).toContain('--contract-scope "$CONTRACT_SCOPE"');
    expect(runBlocks).toContain('--ios-evidence-root trusted-input/ios-evidence');
    expect(runBlocks).toContain('--ios-distribution-evidence-root trusted-input/ios-distribution-evidence');
    expect(runBlocks).not.toContain('--ios-evidence-run-id');
    expect(runBlocks).not.toContain('--ios-sha');
  });

  it('does not resolve artifact helpers from the candidate root', () => {
    const manifest = fs.readFileSync('scripts/release-manifest-v2.mjs', 'utf8');
    const trustedSigner = fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8');

    expect(manifest).toContain("from './lib/release-artifact-manifest.mjs'");
    expect(manifest).not.toContain("path.join(root, 'scripts/release-artifact-manifest.mjs')");
    expect(trustedSigner).toContain('verifyReleaseBundle(bundleRoot, runtimeSha)');
    expect(trustedSigner).not.toMatch(/execFileSync\([^)]*candidate/i);
  });
});
