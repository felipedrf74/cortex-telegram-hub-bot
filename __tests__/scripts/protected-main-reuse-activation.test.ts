import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROTECTED_MAIN_CI_SCHEMA,
  PROTECTED_MAIN_REUSE_SCOPE,
  PROTECTED_MAIN_WORKFLOW,
  canonicalJson,
  sha256,
} from '../../scripts/protected-main-ci-evidence.mjs';
import {
  PROTECTED_MAIN_REUSE_ACTIVATION_SCHEMA,
  SERVER_ACTIVATION_PAYLOAD_SCHEMA,
  decideProtectedMainReuse,
  issueProtectedMainReuseActivation,
  protectedMainReusePolicyDigest,
  signServerActivationRequest,
  validateProtectedMainReuseActivation,
  validateServerActivationRequest,
} from '../../scripts/protected-main-reuse-activation.mjs';

const repository = 'felipedrf74/cortex-telegram-hub-bot';
const policyDigest = createHash('sha256')
  .update(fs.readFileSync('config/test-policy.json'))
  .digest('hex');
const packageLockSha256 = createHash('sha256')
  .update(fs.readFileSync('package-lock.json'))
  .digest('hex');
const pythonRequirementsSha256 = createHash('sha256')
  .update(fs.readFileSync('content-engine/requirements.txt'))
  .digest('hex');
const testFile = '__tests__/scripts/protected-main-ci-evidence.test.ts';
const baseMs = Date.now() - 10 * 24 * 60 * 60 * 1_000;
const requestGeneratedAtMs = Date.now() - 3 * 60_000;

function pem(pair: { privateKey: KeyObject; publicKey: KeyObject }) {
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function entry(index: number) {
  const runtimeSha = String(index + 1).repeat(40);
  return {
    productionSequence: 101 + index,
    productionReleaseId: `v4.14.${231 + index}`,
    runtimeSha,
    productionCompletedAt: new Date(baseMs + index * 24 * 60 * 60 * 1_000).toISOString(),
    transactionId: `202607${String(10 + index).padStart(2, '0')}T120000Z-${100 + index}-${String(index + 1).repeat(12)}`,
    manifestSha256: '23456'[index].repeat(64),
    stagingAttestationSha256: '34567'[index].repeat(64),
    promotionJournalSha256: '45678'[index].repeat(64),
    promotionResultSha256: '56789'[index].repeat(64),
    comparisonSha256: '6789a'[index].repeat(64),
    mainCi: {
      runId: String(10_000 + index),
      runAttempt: '1',
      artifactDigest: '789ab'[index].repeat(64),
    },
    releaseCi: {
      runId: String(20_000 + index),
      runAttempt: '1',
    },
    exactAgreement: true,
  };
}

function serverPayload() {
  return {
    schema: SERVER_ACTIVATION_PAYLOAD_SCHEMA,
    requestId: 'protected-main-reuse-window-1',
    generatedAt: new Date(requestGeneratedAtMs).toISOString(),
    expiresAt: new Date(requestGeneratedAtMs + 15 * 60_000).toISOString(),
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    activationPolicyDigest: protectedMainReusePolicyDigest(),
    entries: Array.from({ length: 5 }, (_, index) => entry(index)),
  };
}

function rawRun(
  item: ReturnType<typeof entry>,
  kind: 'main' | 'release',
  artifactId: number,
) {
  const runId = kind === 'main' ? item.mainCi.runId : item.releaseCi.runId;
  const runAttempt = kind === 'main' ? item.mainCi.runAttempt : item.releaseCi.runAttempt;
  const evidenceName = kind === 'main'
    ? `protected-main-ci-evidence-${runId}-${runAttempt}`
    : `release-candidate-v2-${item.runtimeSha}`;
  const artifacts = [{
    id: artifactId,
    name: evidenceName,
    expired: false,
    digest: `sha256:${String((artifactId % 8) + 1).repeat(64)}`,
    workflow_run: { id: Number(runId), head_sha: item.runtimeSha },
  }];
  if (kind === 'main') {
    artifacts.push({
      id: artifactId + 100,
      name: `release-bundle-${item.runtimeSha}-${item.mainCi.artifactDigest}`,
      expired: false,
      digest: `sha256:${'e'.repeat(64)}`,
      workflow_run: { id: Number(runId), head_sha: item.runtimeSha },
    });
  }
  return {
    run: {
      id: Number(runId),
      run_attempt: Number(runAttempt),
      path: kind === 'main'
        ? '.github/workflows/ci.yml'
        : '.github/workflows/release-candidate-evidence.yml',
      event: kind === 'main' ? 'push' : 'workflow_dispatch',
      head_branch: kind === 'main' ? 'main' : `release-${item.runtimeSha.slice(0, 8)}`,
      head_sha: item.runtimeSha,
      status: 'completed',
      conclusion: 'success',
      repository: { full_name: repository },
      head_repository: { full_name: repository },
    },
    artifacts: { artifacts },
  };
}

function githubEvidence(entries = serverPayload().entries) {
  return {
    schema: 'nexus.protected-main-reuse-github-provenance.v1',
    repository,
    entries: entries.map((item, index) => ({
      runtimeSha: item.runtimeSha,
      main: rawRun(item, 'main', 100 + index),
      release: rawRun(item, 'release', 200 + index),
    })),
  };
}

function activationFixture() {
  const serverKeys = pem(generateKeyPairSync('ed25519'));
  const releaseKeys = pem(generateKeyPairSync('ed25519'));
  const serverRequest = signServerActivationRequest(serverPayload(), serverKeys.privateKey);
  const issuedAt = new Date(Date.now() - 2 * 60_000);
  const activation = issueProtectedMainReuseActivation({
    serverRequest,
    serverPublicKeyPem: serverKeys.publicKey,
    githubEvidence: githubEvidence(),
    repository,
    signingPrivateKeyPem: releaseKeys.privateKey,
    now: issuedAt,
  });
  return { activation, serverKeys, releaseKeys, serverRequest, issuedAt };
}

function selection(headSha: string) {
  const files = [testFile];
  return {
    schema: 'nexus.release-test-selection.v1',
    tier: 'full-sharded',
    headSha,
    baseSha: 'a'.repeat(40),
    policyDigest,
    fullRequired: true,
    fullRequiredReason: 'explicit_force',
    selected: {
      changed: [],
      critical: [],
      cannotSkip: [],
      removed: [],
      removedDigest: sha256(canonicalJson([])),
      unresolved: [],
      unresolvedDigest: sha256(canonicalJson([])),
      files,
      filesDigest: sha256(canonicalJson(files)),
    },
    classifier: {
      impactResolved: true,
      fullSuiteTrigger: false,
      cannotSkip: [],
    },
    nightlyEvidence: null,
  };
}

function mainEvidence(headSha = 'f'.repeat(40), completedAt = new Date(Date.now() - 60_000).toISOString()) {
  const artifactDigest = 'b'.repeat(64);
  return {
    schema: PROTECTED_MAIN_CI_SCHEMA,
    status: 'passed',
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    headSha,
    baseSha: 'a'.repeat(40),
    completedAt,
    testPolicyDigest: policyDigest,
    lockfiles: { packageLockSha256, pythonRequirementsSha256 },
    toolchain: { node: 'v22.23.1', python: 'Python 3.12.11' },
    vitest: {
      mode: 'full',
      files: [testFile],
      filesDigest: sha256(canonicalJson([testFile])),
      tests: 12,
    },
    build: {
      artifactName: `release-bundle-${headSha}-${artifactDigest}`,
      artifactDigest,
    },
    ci: {
      repository,
      workflow: PROTECTED_MAIN_WORKFLOW,
      runId: '30000',
      runAttempt: '1',
      event: 'push',
      ref: 'refs/heads/main',
    },
    jobs: {
      classify: 'success',
      tests: 'success',
      lint: 'success',
      build: 'success',
      sciencePolicy: 'success',
      python: 'success',
      migrations: 'success',
    },
  };
}

describe('protected-main exact-SHA reuse activation', () => {
  it('requires a ServerDominguez signature over exactly five consecutive production comparisons', () => {
    const keys = pem(generateKeyPairSync('ed25519'));
    const request = signServerActivationRequest(serverPayload(), keys.privateKey);
    expect(validateServerActivationRequest(request, {
      serverPublicKeyPem: keys.publicKey,
      expectedPolicyDigest: protectedMainReusePolicyDigest(),
    })).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ productionSequence: 101, exactAgreement: true }),
      ]),
    });

    const four = serverPayload();
    four.entries.pop();
    expect(() => signServerActivationRequest(four, keys.privateKey)).toThrow('exactly 5');

    const gap = serverPayload();
    gap.entries[3].productionSequence += 1;
    expect(() => signServerActivationRequest(gap, keys.privateKey)).toThrow('not consecutive');
  });

  it('rejects operator-authored or drifted requests before protected signing', () => {
    const keys = pem(generateKeyPairSync('ed25519'));
    const unsigned = {
      schema: 'nexus.serverdominguez-protected-main-reuse-request.v1',
      keyId: 'serverdominguez-release-provenance-2026-07',
      signatureAlgorithm: 'ed25519',
      payload: serverPayload(),
      signature: Buffer.alloc(64).toString('base64'),
    };
    expect(() => validateServerActivationRequest(unsigned, {
      serverPublicKeyPem: keys.publicKey,
    })).toThrow('signature is invalid');

    const request = signServerActivationRequest(serverPayload(), keys.privateKey);
    request.payload.entries[0].manifestSha256 = 'f'.repeat(64);
    expect(() => validateServerActivationRequest(request, {
      serverPublicKeyPem: keys.publicKey,
    })).toThrow('signature is invalid');
  });

  it('binds each shadow comparison to exact protected main and RC GitHub runs', () => {
    const { activation, releaseKeys } = activationFixture();
    expect(activation.schema).toBe(PROTECTED_MAIN_REUSE_ACTIVATION_SCHEMA);
    expect(validateProtectedMainReuseActivation(activation, {
      releaseEvidencePublicKeyPem: releaseKeys.publicKey,
      expectedPolicyDigest: protectedMainReusePolicyDigest(),
      repository,
    })).toMatchObject({
      status: 'active',
      entries: expect.arrayContaining([
        expect.objectContaining({ productionReleaseId: 'v4.14.231' }),
      ]),
    });

    const serverKeys = pem(generateKeyPairSync('ed25519'));
    const releaseSigner = pem(generateKeyPairSync('ed25519'));
    const payload = serverPayload();
    const evidence = githubEvidence(payload.entries);
    evidence.entries[2].main.artifacts.artifacts.push(
      structuredClone(evidence.entries[2].main.artifacts.artifacts[0]),
    );
    expect(() => issueProtectedMainReuseActivation({
      serverRequest: signServerActivationRequest(payload, serverKeys.privateKey),
      serverPublicKeyPem: serverKeys.publicKey,
      githubEvidence: evidence,
      repository,
      signingPrivateKeyPem: releaseSigner.privateKey,
    })).toThrow('missing or ambiguous');
  });

  it('authorizes only a later exact-SHA protected-main result and otherwise falls back', () => {
    const { activation, releaseKeys } = activationFixture();
    const evidence = mainEvidence();
    expect(decideProtectedMainReuse({
      activation,
      mainEvidence: evidence,
      selection: selection(evidence.headSha),
      releaseEvidencePublicKeyPem: releaseKeys.publicKey,
      repository,
    })).toMatchObject({
      allowed: true,
      reason: null,
      runtimeSha: evidence.headSha,
      artifactDigest: evidence.build.artifactDigest,
    });

    const uncovered = selection(evidence.headSha);
    uncovered.selected.files = ['__tests__/security/not-covered.test.ts'];
    uncovered.selected.filesDigest = sha256(canonicalJson(uncovered.selected.files));
    expect(decideProtectedMainReuse({
      activation,
      mainEvidence: evidence,
      selection: uncovered,
      releaseEvidencePublicKeyPem: releaseKeys.publicKey,
      repository,
    })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('does not cover'),
    });

    const shadowWindowSha = serverPayload().entries[0].runtimeSha;
    expect(decideProtectedMainReuse({
      activation,
      mainEvidence: mainEvidence(shadowWindowSha),
      selection: selection(shadowWindowSha),
      releaseEvidencePublicKeyPem: releaseKeys.publicKey,
      repository,
    })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('own shadow window'),
    });
  });

  it('extends only the existing sequential RC and protected operational signer', () => {
    const rc = fs.readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');
    const signer = fs.readFileSync('.github/workflows/sign-staging-attestation.yml', 'utf8');
    const manifestSigner = fs.readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
    const bootstrap = fs.readFileSync('scripts/remote-promotion-systemd-install.sh', 'utf8');

    expect(rc).toContain('protected_reuse_activation_b64:');
    expect(rc).toContain('write-reused-result');
    expect(rc).toContain("needs.test-plan.outputs.reuse_allowed != 'true'");
    const selectionDownload = rc.slice(
      rc.indexOf('name: release-test-selection-${{ github.run_id }}-${{ github.run_attempt }}') - 240,
      rc.indexOf('name: release-test-selection-${{ github.run_id }}-${{ github.run_attempt }}') + 160,
    );
    expect(selectionDownload).not.toContain('reuse_allowed');
    const vitestDownload = rc.slice(
      rc.indexOf('pattern: vitest-results-*') - 240,
      rc.indexOf('pattern: vitest-results-*') + 120,
    );
    expect(vitestDownload).toContain("needs.test-plan.outputs.reuse_allowed != 'true'");
    expect(rc).toContain('matrix:\n        shard: [1, 2, 3, 4]');
    expect(rc).not.toContain('skip_release_vitest');
    expect(signer).toContain('- protected_main_reuse_activation');
    expect(signer).toContain('NEXUS_SERVERDOMINGUEZ_PROVENANCE_PUBLIC_KEY_PEM');
    expect(signer.match(/^jobs:/gmu)).toHaveLength(1);
    expect(signer.match(/^  sign:/gmu)).toHaveLength(1);
    expect(manifestSigner).toContain('Fetch exact reused protected-main GitHub identity');
    expect(bootstrap).toContain('serverdominguez-provenance-private-key.pem');
    expect(bootstrap).toContain('openssl genpkey -algorithm ED25519');
  });
});
