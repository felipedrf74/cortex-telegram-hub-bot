import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IOS_CONTRACT_TEST_SELECTORS,
  validateIosContractAttestation,
} from '../../scripts/lib/ios-contract-attestation.mjs';
import {
  backendIosContractDigest,
  canonicalJson,
  sha256,
} from '../../scripts/lib/backend-ios-contract-fixture.mjs';
import { releaseArtifactDigest } from '../../scripts/lib/release-artifact-manifest.mjs';
import {
  evaluateSharedIosReleaseGate,
  readPrivateReleaseJson,
  withCanonicalCheckpointSnapshots,
  writeSharedIosReleaseGateReceipt,
} from '../../scripts/shared-ios-release-gate.mjs';

const roots: string[] = [];
const RELEASE_BASE_FIXTURE = '/tmp/nexus-release-fixture/telegram-hub-bot';
const originalReleaseBase = process.env.NEXUS_RELEASE_BASE_DIR;

beforeEach(() => {
  process.env.NEXUS_RELEASE_BASE_DIR = RELEASE_BASE_FIXTURE;
});

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  if (originalReleaseBase === undefined) delete process.env.NEXUS_RELEASE_BASE_DIR;
  else process.env.NEXUS_RELEASE_BASE_DIR = originalReleaseBase;
});

function signedContractAttestation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ios-contract-gate-'));
  roots.push(root);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyPath = path.join(root, 'docs/release/evidence/ios-contract-evidence-public-key.pem');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, publicKey.export({ format: 'pem', type: 'spki' }));
  const runtimeSha = 'a'.repeat(40);
  const artifactDigest = 'b'.repeat(64);
  const fixtureDigest = 'c'.repeat(64);
  const iosSha = 'd'.repeat(40);
  const payload = {
    schema: 'nexus.ios-contract-attestation-payload.v2',
    // The protected iOS producer uses Date.toISOString(), which includes
    // milliseconds. The backend verifier must accept those canonical bytes.
    generatedAt: '2026-08-06T10:00:00.123Z',
    expiresAt: '2026-08-07T10:00:00.123Z',
    ios: { repository: 'felipedrf74/nexus-hub-ios', sha: iosSha, buildNumber: '301' },
    backend: {
      repository: 'felipedrf74/cortex-telegram-hub-bot',
      runtimeSha,
      artifactDigest,
      contractDigest: backendIosContractDigest({ runtimeSha, artifactDigest, fixtureDigest }),
      fixture: {
        schema: 'nexus.backend-ios-contract-fixtures.v1',
        path: 'dist/release/backend-ios-contract-fixture.v1.json',
        digest: fixtureDigest,
      },
    },
    contractSuite: {
      name: 'Nexus Hub contract decoder suite',
      result: 'passed',
      testCount: 17,
      passedCount: 17,
      failedCount: 0,
      skippedCount: 0,
      testSelectors: IOS_CONTRACT_TEST_SELECTORS,
      selectionDigest: sha256(canonicalJson(IOS_CONTRACT_TEST_SELECTORS)),
    },
    ci: {
      provider: 'github-actions',
      workflow: 'iOS Contract Evidence',
      runId: '1234',
      runAttempt: '1',
    },
  };
  const attestation = {
    schema: 'nexus.ios-contract-attestation.v2',
    keyId: 'ios-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
  };
  return { root, runtimeSha, artifactDigest, fixtureDigest, iosSha, attestation };
}

function digest(value: string, semantics: 'nexus.canonical-tree.v1' | 'nexus.raw-file.v1') {
  return { algorithm: 'sha256', semantics, value };
}

function sharedReleaseEvidence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shared-ios-release-'));
  roots.push(root);
  const trustedRoot = path.join(root, 'trusted');
  const bundleRoot = path.join(root, 'bundle');
  fs.mkdirSync(bundleRoot, { recursive: true });
  const runtimeSha = '1'.repeat(40);
  const iosSha = '2'.repeat(40);
  const buildNumber = '301';
  const fixture = {
    schema: 'nexus.backend-ios-contract-fixtures.v1',
    contracts: [
      { id: 'dashboard.home.v1', method: 'GET', path: '/api/v1/dashboard/home', decoder: 'HomeViewState', payload: { hero: {} } },
      { id: 'training.home.v1', method: 'GET', path: '/api/v1/training/home', decoder: 'TrainingHomeViewState', payload: { hero: {} } },
      { id: 'content.home.v1', method: 'GET', path: '/api/v1/content/home', decoder: 'ContentHomeViewState', payload: { hero: {} } },
      { id: 'training.plan.generate.created.v1', method: 'POST', path: '/api/v1/training/plan/generate', decoder: 'PlanGenerateResponse', payload: { schemaVersion: 'training_plan_generation_response.v1', status: 'created' } },
      { id: 'training.plan.generate.needs-clarification.v1', method: 'POST', path: '/api/v1/training/plan/generate', decoder: 'PlanGenerateResponse', payload: { schemaVersion: 'training_plan_generation_response.v1', status: 'needs_clarification' } },
      { id: 'training.plan.generation-attempt-status.created.v1', method: 'POST', path: '/api/v1/training/plan/generation-attempt/status', decoder: 'TrainingPlanGenerationAttemptStatus', payload: { schemaVersion: 'training_plan_generation_attempt_status.v1', state: 'created' } },
    ],
  };
  const fixtureBytes = Buffer.from(`${JSON.stringify(fixture)}\n`);
  const fixturePath = path.join(bundleRoot, 'dist/release/backend-ios-contract-fixture.v1.json');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, fixtureBytes);
  const files = [{
    path: 'dist/release/backend-ios-contract-fixture.v1.json',
    size: fixtureBytes.length,
    sha256: sha256(fixtureBytes),
  }];
  const artifactDigest = releaseArtifactDigest(files);
  fs.writeFileSync(path.join(bundleRoot, 'artifact-manifest.json'), `${JSON.stringify({
    schema: 'nexus.release-artifact-manifest.v1',
    digest: artifactDigest,
    fileCount: files.length,
    files,
  })}\n`);
  fs.writeFileSync(path.join(bundleRoot, '.complete.json'), `${JSON.stringify({
    schema: 'nexus.release-bundle.v1',
    runtimeSha,
    artifactDigest,
    fileCount: files.length,
    packageVersion: '1.2.3',
  })}\n`);
  const manifest = {
    schema: 'nexus.release-checksum-manifest.v1',
    sourceSha: runtimeSha,
    version: '1.2.3',
    createdAt: '2026-08-06T09:00:00Z',
    artifact: {
      name: `release-bundle-${runtimeSha}-${artifactDigest}`,
      sha256: artifactDigest,
    },
    releaseImpact: { deployedSha: '3'.repeat(40), groups: ['training'] },
  };
  const productionState = {
    schema: 'nexus.lean-release-transaction.v1',
    role: 'production',
    transactionId: `20260806T115800Z-${'4'.repeat(12)}`,
    runtimeSha,
    artifactDigest,
    releaseDir: `${RELEASE_BASE_FIXTURE}/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`,
    predecessor: `${RELEASE_BASE_FIXTURE}/releases/previous`,
    predecessorSha: manifest.releaseImpact.deployedSha,
    predecessorDigest: '5'.repeat(64),
    phase: 'completed',
    status: 'passed',
    message: null,
    startedAt: '2026-08-06T11:58:00Z',
    soakStartedAt: '2026-08-06T11:58:30Z',
    soakCompletedAt: '2026-08-06T11:59:30Z',
    completedAt: '2026-08-06T12:00:00Z',
    updatedAt: '2026-08-06T12:00:01Z',
    healthResult: 'passed',
    rollbackResult: 'not_required',
    rollbackDurationMs: null,
    stabilitySeconds: 60,
    candidateHealthBudgetSeconds: 45,
    rollbackHealthBudgetSeconds: 45,
    rollbackObjectiveSeconds: 120,
    faultInjection: null,
    candidateRemoved: false,
    checks: {
      artifactParity: 'passed',
      migrationStartup: 'passed',
      authenticatedSmoke: 'passed',
      databaseIntegrity: 'passed',
      prePromotionBackup: 'passed',
      rollbackReadiness: 'passed',
    },
  };

  const contractKeys = generateKeyPairSync('ed25519');
  const contractKeyPath = path.join(trustedRoot, 'docs/release/evidence/ios-contract-evidence-public-key.pem');
  fs.mkdirSync(path.dirname(contractKeyPath), { recursive: true });
  fs.writeFileSync(contractKeyPath, contractKeys.publicKey.export({ format: 'pem', type: 'spki' }));
  const fixtureDigest = sha256(fixtureBytes);
  const contractPayload = {
    schema: 'nexus.ios-contract-attestation-payload.v2',
    generatedAt: '2026-08-06T10:00:00Z',
    expiresAt: '2026-08-07T10:00:00Z',
    ios: { repository: 'felipedrf74/nexus-hub-ios', sha: iosSha, buildNumber },
    backend: {
      repository: 'felipedrf74/cortex-telegram-hub-bot',
      runtimeSha,
      artifactDigest,
      contractDigest: backendIosContractDigest({ runtimeSha, artifactDigest, fixtureDigest }),
      fixture: {
        schema: 'nexus.backend-ios-contract-fixtures.v1',
        path: 'dist/release/backend-ios-contract-fixture.v1.json',
        digest: fixtureDigest,
      },
    },
    contractSuite: {
      name: 'Nexus Hub contract decoder suite', result: 'passed',
      testCount: 17, passedCount: 17, failedCount: 0, skippedCount: 0,
      testSelectors: IOS_CONTRACT_TEST_SELECTORS,
      selectionDigest: sha256(canonicalJson(IOS_CONTRACT_TEST_SELECTORS)),
    },
    ci: { provider: 'github-actions', workflow: 'iOS Contract Evidence', runId: '1234', runAttempt: '1' },
  };
  const contractAttestation = {
    schema: 'nexus.ios-contract-attestation.v2', keyId: 'ios-release-signing-2026-07',
    signatureAlgorithm: 'ed25519', payload: contractPayload,
    signature: sign(null, Buffer.from(canonicalJson(contractPayload)), contractKeys.privateKey).toString('base64'),
  };

  const distributionKeys = generateKeyPairSync('ed25519');
  const distributionKeyPath = path.join(trustedRoot, 'docs/release/evidence/ios-distribution-public-key.b64');
  const distributionDer = distributionKeys.publicKey.export({ format: 'der', type: 'spki' });
  fs.writeFileSync(distributionKeyPath, distributionDer.subarray(distributionDer.length - 32).toString('base64'));
  const release = {
    bundleId: 'me.nexushub.app', teamId: 'B6885R8NWM', marketingVersion: '1.2.3',
    sourceBuildNumber: buildNumber, distributedBuildNumber: '901', configuration: 'Release',
  };
  const archive = {
    artifactDigest: digest('6'.repeat(64), 'nexus.canonical-tree.v1'),
    appDigest: digest('7'.repeat(64), 'nexus.canonical-tree.v1'),
    infoPlistDigest: digest('8'.repeat(64), 'nexus.raw-file.v1'),
    executableDigest: digest('9'.repeat(64), 'nexus.raw-file.v1'),
    identity: { bundleId: release.bundleId, marketingVersion: release.marketingVersion, buildNumber },
    pathKind: 'xcarchive-directory',
    signing: {
      kind: 'ad-hoc', identifier: release.bundleId, teamIdentifier: null,
      cdHash: 'a'.repeat(40), authorities: [], entitlementsSha256: 'b'.repeat(64),
      verification: 'codesign-deep-strict',
    },
  };
  const distribution = {
    artifactDigest: digest('c'.repeat(64), 'nexus.raw-file.v1'),
    appDigest: digest('d'.repeat(64), 'nexus.canonical-tree.v1'),
    infoPlistDigest: digest('e'.repeat(64), 'nexus.raw-file.v1'),
    executableDigest: digest('f'.repeat(64), 'nexus.raw-file.v1'),
    identity: { bundleId: release.bundleId, marketingVersion: release.marketingVersion, buildNumber: '901' },
    pathKind: 'ipa-file',
    signing: {
      kind: 'apple-distribution', identifier: release.bundleId, teamIdentifier: release.teamId,
      cdHash: '1'.repeat(40),
      authorities: [
        'Apple Distribution: Nexus Hub (B6885R8NWM)',
        'Apple Worldwide Developer Relations Certification Authority',
        'Apple Root CA',
      ],
      entitlementsSha256: '2'.repeat(64), verification: 'codesign-deep-strict',
    },
  };
  const distributionPayload = {
    schema: 'nexus.ios-distribution-attestation-payload.v2',
    generatedAt: '2026-08-06T12:05:00Z',
    expiresAt: '2026-08-07T12:05:00Z',
    source: { repository: 'felipedrf74/nexus-hub-ios', commit: iosSha, tree: '3'.repeat(40), ref: 'refs/heads/main', clean: true },
    release,
    archive,
    distribution,
    toolchain: {
      developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '16.4',
      xcodeBuild: '16F6', sdkName: 'iphoneos18.5', hostVersion: '15.5', hostBuild: '24F74',
      archiveXcode: '16.4', archiveXcodeBuild: '16F6', archiveSDK: 'iphoneos18.5', archiveHostBuild: '24F74',
    },
    ci: {
      provider: 'xcode-cloud', buildId: '12345678-1234-1234-1234-123456789abc', buildNumber: '901',
      buildUrl: 'https://appstoreconnect.apple.com/teams/00000000-0000-4000-8000-000000000001/apps/6762022696/ci/builds/12345678-1234-1234-1234-123456789abc',
      workflow: 'App Store Release', workflowId: '20e0adf7-2854-4207-98eb-8f3b5afcac60',
      startCondition: 'manual', action: 'archive',
    },
  };
  const distributionAttestation = {
    schema: 'nexus.ios-distribution-attestation.v2', keyId: 'ios-distribution-signing-2026-07',
    signatureAlgorithm: 'ed25519', payload: distributionPayload,
    signature: sign(null, Buffer.from(canonicalJson(distributionPayload)), distributionKeys.privateKey).toString('base64'),
  };

  return {
    trustedRoot, bundleRoot, runtimeSha, iosSha, buildNumber, manifest,
    productionState, contractAttestation, contractPrivateKey: contractKeys.privateKey,
    distributionAttestation,
  };
}

describe('shared backend/iOS release gate', () => {
  it('accepts a signed governed iOS compatibility attestation for the exact backend fixture', () => {
    const value = signedContractAttestation();

    expect(validateIosContractAttestation({
      attestation: value.attestation,
      backendRuntimeSha: value.runtimeSha,
      backendArtifactDigest: value.artifactDigest,
      backendFixtureDigest: value.fixtureDigest,
      iosSha: value.iosSha,
      buildNumber: '301',
      trustedRoot: value.root,
      nowMs: Date.parse('2026-08-06T11:00:00Z'),
    })).toMatchObject({
      binding: {
        result: 'passed',
        iosSha: value.iosSha,
        buildNumber: '301',
        backendRuntimeSha: value.runtimeSha,
      },
    });
  });

  it('binds the exact backend promotion to matching signed compatibility and distribution evidence', () => {
    const value = sharedReleaseEvidence();

    expect(evaluateSharedIosReleaseGate({
      ...value,
      expectedBackendRuntimeSha: value.runtimeSha,
      expectedIosSha: value.iosSha,
      expectedIosBuildNumber: value.buildNumber,
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toMatchObject({
      schema: 'nexus.shared-ios-release-gate.v1',
      result: 'passed',
      generatedAt: '2026-08-06T13:00:00.000Z',
      backend: { runtimeSha: value.runtimeSha },
      ios: { sourceSha: value.iosSha, sourceBuildNumber: value.buildNumber },
      chronology: {
        productionCompletedAt: '2026-08-06T12:00:00Z',
        distributionGeneratedAt: '2026-08-06T12:05:00Z',
      },
    });
  });

  it('rejects forged or expired compatibility evidence', () => {
    const forged = sharedReleaseEvidence();
    forged.contractAttestation.signature = Buffer.alloc(64).toString('base64');
    expect(() => evaluateSharedIosReleaseGate({
      ...forged,
      expectedBackendRuntimeSha: forged.runtimeSha,
      expectedIosSha: forged.iosSha,
      expectedIosBuildNumber: forged.buildNumber,
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow('iOS contract attestation signature is invalid');

    const expired = sharedReleaseEvidence();
    expect(() => evaluateSharedIosReleaseGate({
      ...expired,
      expectedBackendRuntimeSha: expired.runtimeSha,
      expectedIosSha: expired.iosSha,
      expectedIosBuildNumber: expired.buildNumber,
      nowMs: Date.parse('2026-08-07T12:06:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow(/attestation timing is invalid/);
  });

  it('rejects iOS SHA/build drift and backend fixture substitution', () => {
    const shaMismatch = sharedReleaseEvidence();
    expect(() => evaluateSharedIosReleaseGate({
      ...shaMismatch,
      expectedBackendRuntimeSha: shaMismatch.runtimeSha,
      expectedIosSha: 'e'.repeat(40),
      expectedIosBuildNumber: shaMismatch.buildNumber,
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow('iOS contract source identity is invalid or mismatched');

    const buildMismatch = sharedReleaseEvidence();
    expect(() => evaluateSharedIosReleaseGate({
      ...buildMismatch,
      expectedBackendRuntimeSha: buildMismatch.runtimeSha,
      expectedIosSha: buildMismatch.iosSha,
      expectedIosBuildNumber: '302',
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow('iOS contract source identity is invalid or mismatched');

    const substituted = sharedReleaseEvidence();
    fs.appendFileSync(
      path.join(substituted.bundleRoot, 'dist/release/backend-ios-contract-fixture.v1.json'),
      ' ',
    );
    expect(() => evaluateSharedIosReleaseGate({
      ...substituted,
      expectedBackendRuntimeSha: substituted.runtimeSha,
      expectedIosSha: substituted.iosSha,
      expectedIosBuildNumber: substituted.buildNumber,
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow('release bundle artifact byte identity mismatch');
  });

  it('rejects a failed production transaction or an iOS distribution created before promotion', () => {
    const failed = sharedReleaseEvidence();
    failed.productionState.status = 'failed';
    expect(() => evaluateSharedIosReleaseGate({
      ...failed,
      expectedBackendRuntimeSha: failed.runtimeSha,
      expectedIosSha: failed.iosSha,
      expectedIosBuildNumber: failed.buildNumber,
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow('production release transaction is not a passing exact-manifest promotion');

    const reversed = sharedReleaseEvidence();
    reversed.productionState.completedAt = '2026-08-06T12:10:00Z';
    reversed.productionState.updatedAt = '2026-08-06T12:10:01Z';
    expect(() => evaluateSharedIosReleaseGate({
      ...reversed,
      expectedBackendRuntimeSha: reversed.runtimeSha,
      expectedIosSha: reversed.iosSha,
      expectedIosBuildNumber: reversed.buildNumber,
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow('iOS distribution attestation predates the completed backend production promotion');
  });

  it('rejects compatibility evidence created after backend promotion began', () => {
    const reversed = sharedReleaseEvidence();
    reversed.contractAttestation.payload.generatedAt = '2026-08-06T12:02:00Z';
    reversed.contractAttestation.payload.expiresAt = '2026-08-07T12:02:00Z';
    reversed.contractAttestation.signature = sign(
      null,
      Buffer.from(canonicalJson(reversed.contractAttestation.payload)),
      reversed.contractPrivateKey,
    ).toString('base64');

    expect(() => evaluateSharedIosReleaseGate({
      ...reversed,
      expectedBackendRuntimeSha: reversed.runtimeSha,
      expectedIosSha: reversed.iosSha,
      expectedIosBuildNumber: reversed.buildNumber,
      nowMs: Date.parse('2026-08-06T13:00:00Z'),
      canonicalCheckpointValidator: () => undefined,
    })).toThrow('iOS compatibility attestation postdates the start of backend production promotion');
  });

  it('keeps iOS evidence out of the backend checkpoint manifest boundary', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github/workflows/release-candidate-evidence.yml'),
      'utf8',
    );
    const manifestWriter = fs.readFileSync(
      path.join(process.cwd(), 'scripts/release-checksum-manifest.mjs'),
      'utf8',
    );
    const forbiddenPrerequisite = /ios[_-]?(?:contract|distribution)[_-]?attestation/i;

    expect(workflow).not.toMatch(forbiddenPrerequisite);
    expect(manifestWriter).not.toMatch(forbiddenPrerequisite);
  });

  it('pins production signature trust to the reviewed backend checkout', () => {
    const gateSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts/shared-ios-release-gate.mjs'),
      'utf8',
    );

    expect(gateSource).not.toContain("'--trusted-root'");
    expect(gateSource).toContain('const resolvedTrustedRoot = assertRegularDirectory(root');
    expect(gateSource).toContain('trustedRoot: resolvedTrustedRoot');
  });

  it('rejects symlinked parents or outputs, hard links, and unsafe receipt modes', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shared-receipt-')));
    roots.push(root);
    const receipt = { schema: 'nexus.shared-ios-release-gate.v1', result: 'passed' };
    const realParent = path.join(root, 'real-parent');
    const linkedParent = path.join(root, 'linked-parent');
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, linkedParent, 'dir');
    expect(() => writeSharedIosReleaseGateReceipt(
      path.join(linkedParent, 'receipt.json'),
      receipt,
    )).toThrow(/symbolic link/);

    const safeParent = path.join(root, 'safe-parent');
    fs.mkdirSync(safeParent, { mode: 0o700 });
    const target = path.join(safeParent, 'target.json');
    fs.writeFileSync(target, 'target', { mode: 0o600 });
    const linkedOutput = path.join(safeParent, 'linked-output.json');
    fs.symlinkSync(target, linkedOutput);
    expect(() => writeSharedIosReleaseGateReceipt(linkedOutput, receipt)).toThrow(/symbolic link/);

    const hardLinkOutput = path.join(safeParent, 'hard-link.json');
    fs.linkSync(target, hardLinkOutput);
    expect(() => writeSharedIosReleaseGateReceipt(hardLinkOutput, receipt)).toThrow(/hard-linked/);

    const unsafeModeOutput = path.join(safeParent, 'unsafe-mode.json');
    fs.writeFileSync(
      unsafeModeOutput,
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o644 },
    );
    expect(() => writeSharedIosReleaseGateReceipt(unsafeModeOutput, receipt)).toThrow(/mode or owner/);

    const createdParent = path.join(root, 'created-parent');
    fs.mkdirSync(createdParent, { mode: 0o755 });
    const createdOutput = path.join(createdParent, 'receipt.json');
    expect(writeSharedIosReleaseGateReceipt(createdOutput, receipt)).toBe(createdOutput);
    expect(writeSharedIosReleaseGateReceipt(createdOutput, receipt)).toBe(createdOutput);
    expect(fs.statSync(createdParent).mode & 0o777).toBe(0o700);
    expect(fs.statSync(createdOutput).mode & 0o777).toBe(0o600);
    expect(fs.statSync(createdOutput).nlink).toBe(1);
  });

  it('reads release inputs once and validates immutable private canonical snapshots', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shared-input-')));
    roots.push(root);
    fs.chmodSync(root, 0o700);
    const manifestPath = path.join(root, 'manifest.json');
    const productionPath = path.join(root, 'production.json');
    const manifest = { schema: 'manifest', sourceSha: 'a'.repeat(40) };
    const production = { schema: 'production', transactionId: 'tx-1' };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(productionPath, `${JSON.stringify(production, null, 2)}\n`, { mode: 0o600 });

    const manifestInput = readPrivateReleaseJson(manifestPath, 'manifest', 1024);
    const productionInput = readPrivateReleaseJson(productionPath, 'production', 1024);
    expect(manifestInput.digest).toBe(sha256(canonicalJson(manifest)));
    expect(productionInput.digest).toBe(sha256(canonicalJson(production)));

    withCanonicalCheckpointSnapshots({ manifestInput, productionInput }, ({
      manifestPath: manifestSnapshot,
      productionStatePath: productionSnapshot,
    }) => {
      // A mutable caller path changing after the one read must not alter the
      // exact bytes consumed by the canonical child validators.
      fs.writeFileSync(manifestPath, '{"schema":"substituted"}\n');
      fs.writeFileSync(productionPath, '{"schema":"substituted"}\n');
      expect(JSON.parse(fs.readFileSync(manifestSnapshot, 'utf8'))).toEqual(manifest);
      expect(JSON.parse(fs.readFileSync(productionSnapshot, 'utf8'))).toEqual(production);
      expect(fs.statSync(path.dirname(manifestSnapshot)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(manifestSnapshot).mode & 0o777).toBe(0o600);
      expect(fs.statSync(productionSnapshot).mode & 0o777).toBe(0o600);
    });
  });

  it('rejects non-private, symbolic, parent-symbolic, or hard-linked release inputs', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shared-input-')));
    roots.push(root);
    fs.chmodSync(root, 0o700);
    const unsafeMode = path.join(root, 'unsafe-mode.json');
    fs.writeFileSync(unsafeMode, '{}\n', { mode: 0o644 });
    expect(() => readPrivateReleaseJson(unsafeMode, 'input', 1024)).toThrow(/mode or owner/);

    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, '{}\n', { mode: 0o600 });
    const symbolic = path.join(root, 'symbolic.json');
    fs.symlinkSync(target, symbolic);
    expect(() => readPrivateReleaseJson(symbolic, 'input', 1024)).toThrow(/symbolic link/);

    const hardLinked = path.join(root, 'hard-linked.json');
    fs.linkSync(target, hardLinked);
    expect(() => readPrivateReleaseJson(hardLinked, 'input', 1024)).toThrow(/hard-linked/);

    const realParent = path.join(root, 'real-parent');
    const linkedParent = path.join(root, 'linked-parent');
    fs.mkdirSync(realParent, { mode: 0o700 });
    const nested = path.join(realParent, 'nested.json');
    fs.writeFileSync(nested, '{}\n', { mode: 0o600 });
    fs.symlinkSync(realParent, linkedParent, 'dir');
    expect(() => readPrivateReleaseJson(
      path.join(linkedParent, 'nested.json'),
      'input',
      1024,
    )).toThrow(/symbolic link/);
  });
});
