import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTECTED_MAIN_REUSE_SCOPE,
  RELEASE_OBSERVATION_WINDOW_SCHEMA,
  RELEASE_SHADOW_CHECKS,
  RELEASE_SHADOW_COMPARISON_SCHEMA,
  RELEASE_SHADOW_LEDGER_SCHEMA,
  buildProtectedMainReuseServerPayload,
  evaluateReleaseObservationWindow,
  evaluateReleaseShadowReadiness,
} from '../../scripts/lib/release-plan-evaluation.mjs';
import {
  PROTECTED_MAIN_CI_SCHEMA,
  PROTECTED_MAIN_WORKFLOW,
  canonicalJson as canonicalEvidenceJson,
  compareProtectedMainToRelease,
  sha256 as evidenceSha256,
} from '../../scripts/protected-main-ci-evidence.mjs';
import {
  SERVER_ACTIVATION_PAYLOAD_SCHEMA,
  protectedMainReusePolicyDigest,
} from '../../scripts/protected-main-reuse-activation.mjs';

const cli = path.resolve('scripts/release-plan-evaluator.mjs');
const DAY_MS = 24 * 60 * 60 * 1_000;
const BASE_MS = Date.UTC(2026, 0, 1, 12);
const hex = '0123456789abcdef';
let evidenceRoot = '';
let promotionRoot = '';
let publicKeyPath = '';
let signingPrivateKey: KeyObject | null = null;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function ensureEvidenceRoot() {
  if (evidenceRoot) return;
  evidenceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-authority-')));
  promotionRoot = path.join(evidenceRoot, 'promotion-root');
  fs.mkdirSync(promotionRoot);
  const pair = generateKeyPairSync('ed25519');
  signingPrivateKey = pair.privateKey;
  publicKeyPath = path.join(evidenceRoot, 'release-evidence-public-key.pem');
  fs.writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }));
}

afterEach(() => {
  if (evidenceRoot) fs.rmSync(evidenceRoot, { recursive: true, force: true });
  evidenceRoot = '';
  promotionRoot = '';
  publicKeyPath = '';
  signingPrivateKey = null;
});

function writeEvidenceJson(relativePath: string, value: unknown) {
  ensureEvidenceRoot();
  const file = path.join(evidenceRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { path: relativePath, sha256: sha256(bytes) };
}

function writeEvidenceBytes(relativePath: string, bytes: string) {
  ensureEvidenceRoot();
  const file = path.join(evidenceRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { path: relativePath, sha256: sha256(bytes) };
}

function writePromotionBytes(relativePath: string, bytes: string) {
  ensureEvidenceRoot();
  const file = path.join(promotionRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { path: relativePath, sha256: sha256(bytes) };
}

function writePromotionJson(relativePath: string, value: unknown) {
  return writePromotionBytes(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function signedEnvelope(schema: string, payload: Record<string, unknown>) {
  if (!signingPrivateKey) throw new Error('test signing key was not initialized');
  return {
    schema,
    keyId: 'github-environment-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload,
    signature: cryptoSign(null, Buffer.from(canonicalJson(payload)), signingPrivateKey).toString('base64'),
  };
}

function evidenceOptions() {
  ensureEvidenceRoot();
  return {
    evidenceRoot,
    promotionEvidenceRoot: promotionRoot,
    trustedPublicKeyPath: publicKeyPath,
    allowTestKey: true,
    allowTestPromotionRoot: true,
  };
}

function evaluateWindow(window: ReturnType<typeof makeWindow>) {
  return evaluateReleaseObservationWindow(window, evidenceOptions());
}

type RecordOptions = {
  outcome?: 'passed' | 'recovered' | 'failed_before_stop' | 'recovery_failed';
  readinessMs?: number;
  unattendedMs?: number;
  approvalMs?: number;
  soakMs?: number;
  recoveryMs?: number;
  parityMismatch?: boolean;
  escapedReleaseDefects?: number;
  explicitSoak?: boolean;
  soakObservedSeconds?: number;
  unavailabilityReportedSeconds?: number;
  recoveryReportedSeconds?: number;
};

function iso(value: number) {
  return new Date(value).toISOString();
}

function makeRelease(index: number, options: RecordOptions = {}) {
  const outcome = options.outcome ?? 'passed';
  const startedAt = BASE_MS + index * DAY_MS;
  const readinessMs = options.readinessMs ?? 300_000 + index * 20_000;
  const firstUnattendedMs = options.unattendedMs ?? 15_000 + index * 1_000;
  const secondUnattendedMs = options.unattendedMs ?? 25_000 + index * 1_000;
  const approvalMs = options.approvalMs ?? 435_000;
  const readinessCompletedAt = startedAt + readinessMs;
  const firstStartedAt = readinessCompletedAt + firstUnattendedMs;
  const approvalStartedAt = firstStartedAt + approvalMs;
  const secondStartedAt = approvalStartedAt + secondUnattendedMs;
  const cutoverStartedAt = secondStartedAt + 60_000;
  const unavailableAt = cutoverStartedAt + 1_000;
  const runtimeSha = hex[index].repeat(40);
  const artifactDigest = hex[15 - index].repeat(64);
  const installedRuntimeDigest = hex[(index + 3) % hex.length].repeat(64);
  let cutover: Record<string, string | null> | null;
  let rollback: Record<string, string | null> | null = null;
  let completedAt: number;
  let promotionCompletedAt: number;

  if (outcome === 'failed_before_stop') {
    cutover = null;
    completedAt = secondStartedAt + 1_000;
    promotionCompletedAt = completedAt;
  } else if (outcome === 'recovered') {
    const triggeredAt = cutoverStartedAt + 2_000;
    const healthyAt = triggeredAt + (options.recoveryMs ?? 90_000);
    cutover = {
      startedAt: iso(cutoverStartedAt),
      serviceUnavailableAt: iso(unavailableAt),
      serviceAvailableAt: iso(healthyAt),
      soakStartedAt: null,
      soakCompletedAt: null,
      completedAt: iso(healthyAt + 1_000),
    };
    rollback = {
      triggeredAt: iso(triggeredAt),
      healthyAt: iso(healthyAt),
      status: 'passed',
    };
    completedAt = healthyAt + 1_000;
    promotionCompletedAt = completedAt;
  } else if (outcome === 'recovery_failed') {
    const triggeredAt = cutoverStartedAt + 2_000;
    cutover = {
      startedAt: iso(cutoverStartedAt),
      serviceUnavailableAt: iso(unavailableAt),
      serviceAvailableAt: null,
      soakStartedAt: null,
      soakCompletedAt: null,
      completedAt: null,
    };
    rollback = {
      triggeredAt: iso(triggeredAt),
      healthyAt: null,
      status: 'failed',
    };
    completedAt = triggeredAt + 1_000;
    promotionCompletedAt = completedAt;
  } else {
    const availableAt = cutoverStartedAt + 6_000;
    const soakCompletedAt = availableAt + (options.soakMs ?? 60_000);
    cutover = {
      startedAt: iso(cutoverStartedAt),
      serviceUnavailableAt: iso(unavailableAt),
      serviceAvailableAt: iso(availableAt),
      soakStartedAt: iso(availableAt),
      soakCompletedAt: iso(soakCompletedAt),
      completedAt: iso(soakCompletedAt + 1_000),
    };
    completedAt = soakCompletedAt + 1_000;
    promotionCompletedAt = completedAt;
  }

  const ciDurationMs = 100_000 + index * 10_000;
  const releaseCandidateDurationMs = 80_000 + index * 5_000;
  const signingDurationMs = 30_000 + index * 2_000;
  const firstInternalHandoffMs = options.unattendedMs ?? 2_000;
  const secondInternalHandoffMs = options.unattendedMs ?? 3_000;
  const ciCompletedAt = startedAt + ciDurationMs;
  const releaseCandidateStartedAt = ciCompletedAt + firstInternalHandoffMs;
  const releaseCandidateCompletedAt = releaseCandidateStartedAt + releaseCandidateDurationMs;
  const signingStartedAt = releaseCandidateCompletedAt + 60_000;
  const signingCompletedAt = signingStartedAt + signingDurationMs;
  const stagingStartedAt = signingCompletedAt + secondInternalHandoffMs;

  const reachedProduction = outcome === 'passed';
  const record = {
    releaseId: `v4.14.${230 + index}`,
    completedAt: iso(completedAt),
    identity: {
      evidenceRuntimeSha: runtimeSha,
      manifestRuntimeSha: runtimeSha,
      stagingRuntimeSha: runtimeSha,
      productionRuntimeSha: reachedProduction ? runtimeSha : null,
      evidenceArtifactDigest: artifactDigest,
      manifestArtifactDigest: artifactDigest,
      stagingArtifactDigest: options.parityMismatch ? 'e'.repeat(64) : artifactDigest,
      productionArtifactDigest: reachedProduction ? artifactDigest : null,
      stagingInstalledRuntimeDigest: installedRuntimeDigest,
      productionInstalledRuntimeDigest: reachedProduction ? installedRuntimeDigest : null,
    },
    timing: {
      automatedReadinessStartedAt: iso(startedAt),
      automatedReadinessCompletedAt: iso(readinessCompletedAt),
      automatedStages: [
        {
          phase: 'protected_main_ci',
          startedAt: iso(startedAt),
          completedAt: iso(ciCompletedAt),
        },
        {
          phase: 'release_candidate',
          startedAt: iso(releaseCandidateStartedAt),
          completedAt: iso(releaseCandidateCompletedAt),
        },
        {
          phase: 'protected_signing',
          startedAt: iso(signingStartedAt),
          completedAt: iso(signingCompletedAt),
        },
        {
          phase: 'staging_validation',
          startedAt: iso(stagingStartedAt),
          completedAt: iso(readinessCompletedAt),
        },
        {
          phase: 'promotion',
          startedAt: iso(secondStartedAt),
          completedAt: iso(promotionCompletedAt),
        },
      ],
      handoffs: [
        {
          phase: 'protected-main-to-rc',
          readyAt: iso(ciCompletedAt),
          startedAt: iso(releaseCandidateStartedAt),
          approvalKind: null,
        },
        {
          phase: 'release-signing-approval',
          readyAt: iso(releaseCandidateCompletedAt),
          startedAt: iso(signingStartedAt),
          approvalKind: 'release_signing',
        },
        {
          phase: 'signing-to-staging',
          readyAt: iso(signingCompletedAt),
          startedAt: iso(stagingStartedAt),
          approvalKind: null,
        },
        {
          phase: 'protected-signing-request',
          readyAt: iso(readinessCompletedAt),
          startedAt: iso(firstStartedAt),
          approvalKind: null,
        },
        {
          phase: 'production-owner-approval',
          readyAt: iso(firstStartedAt),
          startedAt: iso(approvalStartedAt),
          approvalKind: 'production_owner',
        },
        {
          phase: 'promotion-submit',
          readyAt: iso(approvalStartedAt),
          startedAt: iso(secondStartedAt),
          approvalKind: null,
        },
      ],
      cutover,
    },
    promotion: { outcome, rollback },
    escapedReleaseDefects: options.escapedReleaseDefects ?? 0,
    authoritativeEvidence: {} as Record<string, { path: string; sha256: string }>,
  };

  ensureEvidenceRoot();
  const releaseDirectory = `release-${index}`;
  const manifestPayload = {
    schema: 'nexus.release-manifest-payload.v2',
    runtimeSha,
    packageVersion: record.releaseId.slice(1),
    generatedAt: record.timing.automatedStages[2].completedAt,
    expiresAt: iso(Date.parse(record.completedAt) + 3_600_000),
    source: { dirty: false },
    artifact: { digest: artifactDigest },
    testPolicy: {
      results: {
        schema: 'nexus.release-test-results.v3',
        status: 'passed',
        runtimeSha,
        artifactDigest,
        completedAt: record.timing.automatedStages[1].completedAt,
        protectedMainShadow: {
          evidence: {
            schema: 'nexus.protected-main-ci-evidence.v1',
            status: 'passed',
            headSha: runtimeSha,
            completedAt: record.timing.automatedStages[0].completedAt,
            build: { artifactDigest },
          },
        },
      },
    },
  };
  const releaseManifest = writeEvidenceJson(
    `${releaseDirectory}/manifest.json`,
    signedEnvelope('nexus.release-manifest.v2', manifestPayload),
  );
  const stagingPayload = {
    schema: 'nexus.staging-attestation-request.v1',
    requestId: `staging-${index}`,
    runtimeSha,
    artifactDigest: record.identity.stagingArtifactDigest,
    releaseManifestSha256: releaseManifest.sha256,
    installedRuntimeDigest,
    smoke: { status: 'passed' },
    verifiedAt: record.timing.automatedReadinessCompletedAt,
    expiresAt: iso(Date.parse(record.completedAt) + 3_600_000),
  };
  const stagingAttestation = writeEvidenceJson(
    `${releaseDirectory}/staging.json`,
    signedEnvelope('nexus.staging-attestation.v1', stagingPayload),
  );
  const transactionId = `202601${String(index + 1).padStart(2, '0')}T120000Z-${1000 + index}-${hex[index].repeat(12)}`;
  const requestSha256 = hex[(index + 7) % hex.length].repeat(64);
  const target = {
    runtime: `/home/dominguez/telegram-hub-bot/releases/${runtimeSha}`,
    sha: runtimeSha,
    sentryRelease: runtimeSha,
    artifactDigest: record.identity.stagingArtifactDigest,
    installedRuntimeDigest,
    version: record.releaseId.slice(1),
  };
  let promotionResultValue: Record<string, unknown>;
  let promotionResultEnv = '';
  if (outcome === 'passed') {
    promotionResultValue = {};
    const resultLines = [
      `NEXUS_TRANSACTION_ID=${transactionId}`,
      `NEXUS_RUNTIME_SHA=${runtimeSha}`,
      `NEXUS_SENTRY_RELEASE=${runtimeSha}`,
      `NEXUS_ARTIFACT_DIGEST=${record.identity.stagingArtifactDigest}`,
      `NEXUS_INSTALLED_RUNTIME_DIGEST=${installedRuntimeDigest}`,
      `NEXUS_CUTOVER_STARTED_AT=${record.timing.cutover?.startedAt}`,
      `NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=${record.timing.cutover?.serviceUnavailableAt}`,
      `NEXUS_CANDIDATE_AVAILABLE_AT=${record.timing.cutover?.serviceAvailableAt}`,
      `NEXUS_FINAL_UNAVAILABILITY_SECONDS=${options.unavailabilityReportedSeconds ?? (
        Date.parse(record.timing.cutover!.serviceAvailableAt!)
        - Date.parse(record.timing.cutover!.serviceUnavailableAt)
      ) / 1_000}`,
      'NEXUS_VERIFICATION_SOAK_SECONDS=60',
      `NEXUS_SOAK_OBSERVED_SECONDS=${options.soakObservedSeconds ?? (
        Date.parse(record.timing.cutover!.soakCompletedAt!)
        - Date.parse(record.timing.cutover!.soakStartedAt!)
      ) / 1_000}`,
    ];
    if (options.explicitSoak !== false) {
      resultLines.push(
        `NEXUS_SOAK_STARTED_AT=${record.timing.cutover?.soakStartedAt}`,
        `NEXUS_SOAK_COMPLETED_AT=${record.timing.cutover?.soakCompletedAt}`,
      );
    }
    promotionResultEnv = `${resultLines.join('\n')}\n`;
  } else if (outcome === 'recovered') {
    promotionResultValue = {
      schema: 'nexus.promotion-recovery-result.v1',
      outageStartedAt: record.timing.cutover?.serviceUnavailableAt,
      predecessorHealthyAt: record.timing.cutover?.serviceAvailableAt,
      outageToHealthySeconds: options.recoveryReportedSeconds ?? (
        Date.parse(record.timing.cutover!.serviceAvailableAt!)
        - Date.parse(record.timing.cutover!.serviceUnavailableAt)
      ) / 1_000,
      targetSeconds: 120,
      targetMet: (options.recoveryReportedSeconds ?? (
        Date.parse(record.timing.cutover!.serviceAvailableAt!)
        - Date.parse(record.timing.cutover!.serviceUnavailableAt)
      ) / 1_000) <= 120,
      timingSource: 'monotonic',
    };
  } else {
    promotionResultValue = {};
  }
  const journalValue = {
    schema: 'nexus.promotion-transaction-journal.v1',
    transactionId,
    requestSha256,
    phase: outcome === 'passed' ? 'completed' : 'recovery_complete',
    status: outcome === 'passed' ? 'completed' : outcome,
    startedAt: record.timing.automatedStages[4].startedAt,
    updatedAt: record.completedAt,
    completedAt: record.completedAt,
    target,
    sentryRelease: runtimeSha,
    ...(outcome === 'recovered' ? { recovery: promotionResultValue } : {}),
  };
  const transactionState = `transactions/${transactionId}/state`;
  const promotionJournal = writePromotionJson(`${transactionState}/journal.json`, journalValue);
  const promotionResult = outcome !== 'passed' && outcome !== 'recovered'
    ? promotionJournal
    : outcome === 'passed'
      ? writePromotionBytes(`${transactionState}/result.env`, promotionResultEnv)
      : writePromotionJson(`${transactionState}/recovery-result.json`, promotionResultValue);
  record.authoritativeEvidence = {
    releaseManifest,
    stagingAttestation,
    promotionJournal,
    promotionResult,
  };
  return record;
}

function makeWindow(options: RecordOptions[] = [{}, {}, {}, {}, {}, {}, {}, {}, {}, { outcome: 'recovered' }]) {
  const releases = Array.from({ length: 10 }, (_, index) => makeRelease(index, options[index] ?? {}));
  return {
    schema: RELEASE_OBSERVATION_WINDOW_SCHEMA,
    generatedAt: iso(Date.parse(releases[9].completedAt) + 1_000),
    baseline: {
      releaseCount: 10,
      failedPromotions: releases.filter((release) => release.promotion.outcome !== 'passed').length,
      escapedReleaseDefects: releases.reduce((sum, release) => sum + release.escapedReleaseDefects, 0),
    },
    releases,
  };
}

function makeComparison(index: number, exact = true) {
  const checks = Object.fromEntries(RELEASE_SHADOW_CHECKS.map((name) => [name, true]));
  if (!exact) checks.runtimeArtifactMatch = false;
  return {
    schema: RELEASE_SHADOW_COMPARISON_SCHEMA,
    status: exact ? 'eligible' : 'ineligible',
    reason: exact ? null : 'protected_main_evidence_mismatch',
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    runtimeSha: hex[index + 1].repeat(40),
    comparedAt: iso(BASE_MS + index * DAY_MS),
    mainCi: {
      runId: String(10_000 + index),
      runAttempt: '1',
      artifactDigest: hex[15 - index].repeat(64),
    },
    releaseCi: {
      runId: String(20_000 + index),
      runAttempt: '1',
    },
    checks,
  };
}

function makeShadowLedger(mismatchIndex = -1) {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    productionSequence: 41 + index,
    productionReleaseId: `v4.14.${241 + index}`,
    productionRuntimeSha: hex[index + 1].repeat(40),
    productionCompletedAt: iso(BASE_MS + index * DAY_MS + 60_000),
    manifestSha256: hex[index + 5].repeat(64),
    comparison: makeComparison(index, index !== mismatchIndex),
  }));
  return {
    schema: RELEASE_SHADOW_LEDGER_SCHEMA,
    generatedAt: iso(Date.parse(entries[4].productionCompletedAt) + 1_000),
    entries,
  };
}

function addFullProtectedMainBindings(window: ReturnType<typeof makeWindow>) {
  const files = ['__tests__/scripts/protected-main-ci-evidence.test.ts'];
  const policyDigest = 'c'.repeat(64);
  for (let index = 5; index < 10; index += 1) {
    const record = window.releases[index];
    const manifestRef = record.authoritativeEvidence.releaseManifest;
    const manifestPath = path.join(evidenceRoot, manifestRef.path);
    const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const artifactDigest = record.identity.evidenceArtifactDigest;
    const runtimeSha = record.identity.evidenceRuntimeSha;
    const releaseResults = {
      schema: 'nexus.release-test-results.v3',
      status: 'passed',
      runtimeSha,
      completedAt: record.timing.automatedStages[1].completedAt,
      tier: 'full-sharded',
      selection: { selected: { files } },
      testPolicyDigest: policyDigest,
      artifactDigest,
      lockfiles: {
        packageLockSha256: 'd'.repeat(64),
        pythonRequirementsSha256: 'e'.repeat(64),
      },
      toolchain: { node: 'v22.23.1', python: 'Python 3.12.11' },
      counts: { vitest: 10, pytest: 10 },
      ci: { runId: String(20_000 + index), runAttempt: '1' },
      protectedMainShadow: null,
    };
    const mainEvidence = {
      schema: PROTECTED_MAIN_CI_SCHEMA,
      status: 'passed',
      reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
      headSha: runtimeSha,
      baseSha: 'a'.repeat(40),
      completedAt: record.timing.automatedStages[0].completedAt,
      testPolicyDigest: policyDigest,
      lockfiles: releaseResults.lockfiles,
      toolchain: releaseResults.toolchain,
      vitest: {
        mode: 'full',
        files,
        filesDigest: evidenceSha256(canonicalEvidenceJson(files)),
        tests: 10,
      },
      build: {
        artifactName: `release-bundle-${runtimeSha}-${artifactDigest}`,
        artifactDigest,
      },
      ci: {
        repository: 'felipedrf74/cortex-telegram-hub-bot',
        workflow: PROTECTED_MAIN_WORKFLOW,
        runId: String(10_000 + index),
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
    const comparison = compareProtectedMainToRelease(mainEvidence, releaseResults);
    comparison.comparedAt = releaseResults.completedAt;
    releaseResults.protectedMainShadow = {
      mode: 'shadow',
      comparison,
      evidence: mainEvidence,
    };
    envelope.payload.testPolicy = { digest: policyDigest, results: releaseResults };
    const rewrittenManifest = `${JSON.stringify(
      signedEnvelope('nexus.release-manifest.v2', envelope.payload),
      null,
      2,
    )}\n`;
    fs.writeFileSync(manifestPath, rewrittenManifest, { mode: 0o600 });
    manifestRef.sha256 = sha256(rewrittenManifest);

    const stagingRef = record.authoritativeEvidence.stagingAttestation;
    const stagingPath = path.join(evidenceRoot, stagingRef.path);
    const stagingEnvelope = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
    stagingEnvelope.payload.releaseManifestSha256 = manifestRef.sha256;
    const rewrittenStaging = `${JSON.stringify(
      signedEnvelope('nexus.staging-attestation.v1', stagingEnvelope.payload),
      null,
      2,
    )}\n`;
    fs.writeFileSync(stagingPath, rewrittenStaging, { mode: 0o600 });
    stagingRef.sha256 = sha256(rewrittenStaging);
  }
  return window;
}

describe('release plan observation evaluation', () => {
  it('uses authority-bound metrics and refuses to certify operator-authored timing or quality claims', () => {
    const window = makeWindow();
    const result = evaluateWindow(window);

    expect(result).toEqual(evaluateWindow(structuredClone(window)));
    expect(result).toMatchObject({
      verdict: 'MANUAL_REQUIRED',
      releaseCount: 10,
      metrics: {
        automatedReadiness: {
          sampleCount: 0,
          medianMs: null,
          p50Ms: null,
          p95Ms: null,
          status: 'manual_required',
        },
        automatedStageTimings: {
          protected_main_ci: { sampleCount: 0, status: 'manual_required' },
          release_candidate: { sampleCount: 0, status: 'manual_required' },
          protected_signing: { sampleCount: 0, status: 'manual_required' },
          staging_validation: { sampleCount: 0, status: 'manual_required' },
          promotion: { sampleCount: 10, p50Ms: 127_000, p95Ms: 141_300, status: 'observed' },
        },
        unattendedHandoffDelay: {
          sampleCount: 0,
          medianMs: null,
          excludedExplicitApprovalSampleCount: 0,
          excludedExplicitApprovalTotalMs: 0,
          status: 'manual_required',
        },
        actualUnavailability: { sampleCount: 10, p50Ms: 5_000, maxMs: 91_000 },
        totalCutoverIncludingSoak: {
          sampleCount: 9,
          p50Ms: 67_000,
          maxMs: 67_000,
          status: 'manual_required',
        },
        successfulPromotionSoak: { sampleCount: 9, p50Ms: 60_000, status: 'pass' },
        rollbackRecovery: {
          sampleCount: 1,
          maxMs: 91_000,
          measurement: 'service_unavailable_to_healthy_predecessor',
          triggerToHealthy: { maxMs: null, sampleCount: 0 },
          triggerToHealthyStatus: 'manual_required',
          status: 'pass',
        },
        exactShaAndDigestParity: { exactMatchCount: 10, status: 'pass' },
        failedPromotions: { baselineCount: 1, currentCount: 1, delta: 0, status: 'manual_required' },
        escapedReleaseDefects: { baselineCount: 0, currentCount: 0, delta: 0, status: 'manual_required' },
      },
      reasons: [
        'authoritative_automated_readiness_start_evidence_required',
        'authoritative_handoff_timestamps_required',
        'authoritative_total_cutover_start_required',
        'authoritative_failed_promotion_baseline_required',
        'authoritative_sentry_defect_evidence_required',
      ],
    });
  });

  it('requires manual recovery evidence when all ten releases pass without a rollback', () => {
    const window = makeWindow(Array.from({ length: 10 }, () => ({})));
    const result = evaluateWindow(window);

    expect(result.verdict).toBe('MANUAL_REQUIRED');
    expect(result.metrics.rollbackRecovery).toMatchObject({
      sampleCount: 0,
      maxMs: null,
      status: 'manual_required',
    });
    expect(result.reasons).toContain('rollback_recovery_not_observed');
  });

  it('fails the declared targets without conflating them with malformed evidence', () => {
    const options: RecordOptions[] = Array.from({ length: 10 }, (_, index) => ({
      readinessMs: 600_000,
      unattendedMs: 70_000,
      escapedReleaseDefects: index === 1 ? 1 : 0,
      outcome: index === 9 ? 'recovered' : 'passed',
      recoveryMs: index === 9 ? 130_000 : undefined,
    }));
    const window = makeWindow(options);
    window.baseline.failedPromotions = 0;
    window.baseline.escapedReleaseDefects = 0;
    const result = evaluateWindow(window);

    expect(result.verdict).toBe('FAIL');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'rollback_recovery_failed_or_above_120_seconds',
      'authoritative_automated_readiness_start_evidence_required',
      'authoritative_handoff_timestamps_required',
      'authoritative_failed_promotion_baseline_required',
      'authoritative_sentry_defect_evidence_required',
    ]));
  });

  it('fails closed on malformed counts, unknown fields, chronology, and contradictory outcomes', () => {
    const wrongCount = makeWindow();
    wrongCount.releases.pop();
    expect(() => evaluateWindow(wrongCount)).toThrow('exactly 10');

    const unknown = makeWindow();
    Object.assign(unknown.releases[0], { unsupportedClaim: true });
    expect(() => evaluateWindow(unknown)).toThrow('fields do not match');

    const badTimestamp = makeWindow();
    badTimestamp.releases[0].completedAt = '2026-01-01';
    expect(() => evaluateWindow(badTimestamp)).toThrow('canonical UTC timestamp');

    const duplicate = makeWindow();
    duplicate.releases[1].releaseId = duplicate.releases[0].releaseId;
    expect(() => evaluateWindow(duplicate)).toThrow('duplicate release IDs');

    const overlapping = makeWindow();
    overlapping.releases[1].timing.automatedReadinessStartedAt = iso(
      Date.parse(overlapping.releases[0].completedAt) - 1_000,
    );
    overlapping.releases[1].timing.automatedStages[0].startedAt =
      overlapping.releases[1].timing.automatedReadinessStartedAt;
    expect(() => evaluateWindow(overlapping)).toThrow('overlapping release lanes');

    const overlappingStages = makeWindow();
    overlappingStages.releases[0].timing.automatedStages[1].startedAt = iso(
      Date.parse(overlappingStages.releases[0].timing.automatedStages[0].completedAt) - 1_000,
    );
    expect(() => evaluateWindow(overlappingStages)).toThrow('cannot overlap');

    const reorderedStages = makeWindow();
    reorderedStages.releases[0].timing.automatedStages[1].phase = 'staging_validation';
    expect(() => evaluateWindow(reorderedStages)).toThrow('canonical stage order');

    const handoffDuringStage = makeWindow();
    handoffDuringStage.releases[0].timing.handoffs[0].readyAt = iso(
      Date.parse(handoffDuringStage.releases[0].timing.automatedStages[0].completedAt) - 1_000,
    );
    expect(() => evaluateWindow(handoffDuringStage)).toThrow(
      'handoffs cannot overlap automated stage execution',
    );

    const contradictory = makeWindow();
    contradictory.releases[9].identity.productionRuntimeSha = 'a'.repeat(40);
    expect(() => evaluateWindow(contradictory)).toThrow('must be null');
  });

  it('fails closed when evidence bytes, signed identity, or Sentry identity are rewritten', () => {
    const missingReference = makeWindow();
    delete (missingReference.releases[0] as Record<string, unknown>).authoritativeEvidence;
    expect(() => evaluateWindow(missingReference)).toThrow('fields do not match');

    const changedBytes = makeWindow();
    const manifestRef = changedBytes.releases[0].authoritativeEvidence.releaseManifest;
    fs.appendFileSync(path.join(evidenceRoot, manifestRef.path), ' ');
    expect(() => evaluateWindow(changedBytes)).toThrow('SHA-256 does not match');

    const changedSentry = makeWindow();
    const resultRef = changedSentry.releases[0].authoritativeEvidence.promotionResult;
    const resultPath = path.join(promotionRoot, resultRef.path);
    const resultBytes = fs.readFileSync(resultPath, 'utf8').replace(
      /^NEXUS_SENTRY_RELEASE=.*$/mu,
      `NEXUS_SENTRY_RELEASE=${'f'.repeat(40)}`,
    );
    fs.writeFileSync(resultPath, resultBytes);
    resultRef.sha256 = sha256(resultBytes);
    expect(() => evaluateWindow(changedSentry)).toThrow(
      'promotionResult.NEXUS_SENTRY_RELEASE does not match the authoritative evidence',
    );

    const changedRecord = makeWindow();
    changedRecord.releases[0].identity.productionInstalledRuntimeDigest = 'd'.repeat(64);
    expect(() => evaluateWindow(changedRecord)).toThrow(
      'identity.productionInstalledRuntimeDigest does not match the authoritative evidence',
    );
  });

  it('binds signed/root endpoints and never computes speed from forged local starts', () => {
    const changedMainCompletion = makeWindow();
    changedMainCompletion.releases[0].timing.automatedStages[0].completedAt = iso(
      Date.parse(changedMainCompletion.releases[0].timing.automatedStages[0].completedAt) - 1_000,
    );
    expect(() => evaluateWindow(changedMainCompletion)).toThrow(
      'timing.protected_main_ci.completedAt does not match the authoritative evidence',
    );

    const changedRcCompletion = makeWindow();
    changedRcCompletion.releases[0].timing.automatedStages[1].completedAt = iso(
      Date.parse(changedRcCompletion.releases[0].timing.automatedStages[1].completedAt) - 1_000,
    );
    expect(() => evaluateWindow(changedRcCompletion)).toThrow(
      'timing.release_candidate.completedAt does not match the authoritative evidence',
    );

    const changedSoakStart = makeWindow();
    changedSoakStart.releases[0].timing.cutover!.soakStartedAt = iso(
      Date.parse(changedSoakStart.releases[0].timing.cutover!.soakStartedAt!) + 2_000,
    );
    expect(() => evaluateWindow(changedSoakStart)).toThrow(
      'timing.cutover.soakStartedAt does not match the authoritative evidence',
    );

    const forgedStart = makeWindow();
    forgedStart.releases[0].timing.automatedReadinessStartedAt = iso(
      Date.parse(forgedStart.releases[0].timing.automatedReadinessStartedAt) + 30_000,
    );
    forgedStart.releases[0].timing.automatedStages[0].startedAt =
      forgedStart.releases[0].timing.automatedReadinessStartedAt;
    const result = evaluateWindow(forgedStart);
    expect(result.verdict).toBe('MANUAL_REQUIRED');
    expect(result.metrics.automatedReadiness).toMatchObject({
      sampleCount: 0,
      p50Ms: null,
      status: 'manual_required',
    });
  });

  it('requires explicit root soak timestamps and rejects copied promotion roots in production mode', () => {
    const withoutExplicitSoak = makeWindow(Array.from({ length: 10 }, (_, index) => (
      index === 9 ? { outcome: 'recovered' } : { explicitSoak: false }
    )));
    const result = evaluateWindow(withoutExplicitSoak);
    expect(result.metrics.successfulPromotionSoak.status).toBe('manual_required');
    expect(result.reasons).toContain('authoritative_soak_start_and_completion_required');

    const copied = makeWindow();
    const options = evidenceOptions();
    expect(() => evaluateReleaseObservationWindow(copied, {
      ...options,
      allowTestPromotionRoot: false,
    })).toThrow('promotion evidence must be evaluated on ServerDominguez');
  });

  it('uses root monotonic seconds with a one-second wall-clock consistency tolerance', () => {
    const withinBoundary: RecordOptions[] = Array.from({ length: 10 }, (_, index) => (
      index === 0
        ? { soakMs: 61_000, soakObservedSeconds: 60, unavailabilityReportedSeconds: 4 }
        : index === 9
          ? { outcome: 'recovered', recoveryMs: 90_000, recoveryReportedSeconds: 90 }
          : { unavailabilityReportedSeconds: 4 }
    ));
    const result = evaluateWindow(makeWindow(withinBoundary));
    expect(result.metrics.actualUnavailability).toMatchObject({ p50Ms: 4_000 });
    expect(result.metrics.successfulPromotionSoak).toMatchObject({ p50Ms: 60_000, status: 'pass' });
    expect(result.metrics.rollbackRecovery).toMatchObject({ maxMs: 90_000, status: 'pass' });

    const outsideSoakBoundary = makeWindow(Array.from({ length: 10 }, (_, index) => (
      index === 0 ? { soakMs: 62_000, soakObservedSeconds: 60 }
        : index === 9 ? { outcome: 'recovered' } : {}
    )));
    expect(() => evaluateWindow(outsideSoakBoundary)).toThrow(
      'explicit soak timestamps contradict its duration',
    );

    const outsideRecoveryBoundary = makeWindow(Array.from({ length: 10 }, (_, index) => (
      index === 9
        ? { outcome: 'recovered', recoveryMs: 90_000, recoveryReportedSeconds: 89 }
        : {}
    )));
    expect(() => evaluateWindow(outsideRecoveryBoundary)).toThrow(
      'recovery timing or outcome is inconsistent',
    );
  });
});

describe('release shadow-readiness evaluation', () => {
  it('keeps five consecutive exact matches shadow-only pending independent GitHub provenance', () => {
    const result = evaluateReleaseShadowReadiness(makeShadowLedger());

    expect(result).toEqual({
      schema: 'nexus.release-shadow-readiness.v1',
      verdict: 'MANUAL_REQUIRED',
      mode: 'shadow_only',
      generatedAt: expect.any(String),
      entryCount: 5,
      fiveConsecutiveExactMatches: true,
      shadowRequirementMet: true,
      independentGithubProvenanceVerified: false,
      activationAllowed: false,
      reasons: ['independent_github_provenance_required'],
    });
  });

  it('reports an exact-match gap while still requiring independent provenance', () => {
    const result = evaluateReleaseShadowReadiness(makeShadowLedger(2));

    expect(result).toMatchObject({
      verdict: 'MANUAL_REQUIRED',
      fiveConsecutiveExactMatches: false,
      shadowRequirementMet: false,
      independentGithubProvenanceVerified: false,
      activationAllowed: false,
      reasons: [
        'five_consecutive_exact_matches_required',
        'independent_github_provenance_required',
      ],
    });
  });

  it('fails closed on incomplete, nonconsecutive, or inconsistent shadow ledgers', () => {
    const incomplete = makeShadowLedger();
    incomplete.entries.pop();
    expect(() => evaluateReleaseShadowReadiness(incomplete)).toThrow('exactly 5');

    const nonconsecutive = makeShadowLedger();
    nonconsecutive.entries[3].productionSequence += 1;
    expect(() => evaluateReleaseShadowReadiness(nonconsecutive)).toThrow('sequence must be consecutive');

    const duplicateManifest = makeShadowLedger();
    duplicateManifest.entries[1].manifestSha256 = duplicateManifest.entries[0].manifestSha256;
    expect(() => evaluateReleaseShadowReadiness(duplicateManifest)).toThrow('duplicate manifest digests');

    const mismatchedRuntime = makeShadowLedger();
    mismatchedRuntime.entries[0].productionRuntimeSha = 'f'.repeat(40);
    expect(() => evaluateReleaseShadowReadiness(mismatchedRuntime)).toThrow(
      'runtimeSha does not match its ledger entry',
    );

    const inconsistent = makeShadowLedger();
    inconsistent.entries[0].comparison.status = 'ineligible';
    inconsistent.entries[0].comparison.reason = 'protected_main_evidence_mismatch';
    expect(() => evaluateReleaseShadowReadiness(inconsistent)).toThrow('status and checks are inconsistent');
  });
});

describe('protected-main reuse authoritative activation request', () => {
  it('derives five entries only from the latest signed manifests, staging attestations, and root journals', () => {
    const window = addFullProtectedMainBindings(makeWindow(
      Array.from({ length: 10 }, () => ({})),
    ));
    const payload = buildProtectedMainReuseServerPayload(window, evidenceOptions(), {
      requestId: 'protected-main-reuse-window-1',
    });
    expect(payload).toMatchObject({
      schema: SERVER_ACTIVATION_PAYLOAD_SCHEMA,
      activationPolicyDigest: protectedMainReusePolicyDigest(),
      entries: [
        expect.objectContaining({ productionSequence: 6, exactAgreement: true }),
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ productionSequence: 10, exactAgreement: true }),
      ],
    });

    const omittedLatest = structuredClone(window);
    omittedLatest.releases[9] = structuredClone(omittedLatest.releases[8]);
    expect(() => buildProtectedMainReuseServerPayload(
      omittedLatest,
      evidenceOptions(),
      { requestId: 'forged-window' },
    )).toThrow();

    const staleComparison = addFullProtectedMainBindings(makeWindow(
      Array.from({ length: 10 }, () => ({})),
    ));
    const staleRecord = staleComparison.releases[6];
    const staleManifestRef = staleRecord.authoritativeEvidence.releaseManifest;
    const staleManifestPath = path.join(evidenceRoot, staleManifestRef.path);
    const staleManifest = JSON.parse(fs.readFileSync(staleManifestPath, 'utf8'));
    staleManifest.payload.testPolicy.results.protectedMainShadow.comparison.comparedAt =
      staleComparison.releases[5].completedAt;
    const rewrittenManifest = `${JSON.stringify(
      signedEnvelope('nexus.release-manifest.v2', staleManifest.payload),
      null,
      2,
    )}\n`;
    fs.writeFileSync(staleManifestPath, rewrittenManifest, { mode: 0o600 });
    staleManifestRef.sha256 = sha256(rewrittenManifest);
    const staleStagingRef = staleRecord.authoritativeEvidence.stagingAttestation;
    const staleStagingPath = path.join(evidenceRoot, staleStagingRef.path);
    const staleStaging = JSON.parse(fs.readFileSync(staleStagingPath, 'utf8'));
    staleStaging.payload.releaseManifestSha256 = staleManifestRef.sha256;
    const rewrittenStaging = `${JSON.stringify(
      signedEnvelope('nexus.staging-attestation.v1', staleStaging.payload),
      null,
      2,
    )}\n`;
    fs.writeFileSync(staleStagingPath, rewrittenStaging, { mode: 0o600 });
    staleStagingRef.sha256 = sha256(rewrittenStaging);
    expect(() => buildProtectedMainReuseServerPayload(
      staleComparison,
      evidenceOptions(),
      { requestId: 'stale-comparison-window' },
    )).toThrow('comparisons must follow the preceding production release');
  });
});

describe('release plan evaluator CLI', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function temporaryFile(name: string, value: unknown) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-plan-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return { directory, file };
  }

  it('uses stable exit codes and writes a mode-0600 result', () => {
    const passing = temporaryFile('window.json', makeWindow());
    const output = path.join(passing.directory, 'evaluation.json');
    const pass = spawnSync(process.execPath, [cli, 'evaluate', '--input', passing.file,
      '--evidence-root', evidenceRoot, '--promotion-evidence-root', promotionRoot,
      '--public-key', publicKeyPath, '--allow-test-key',
      '--output', output], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });

    expect(pass.status).toBe(3);
    expect(JSON.parse(pass.stdout).verdict).toBe('MANUAL_REQUIRED');
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(JSON.parse(pass.stdout));
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);

    const shadow = temporaryFile('shadow.json', makeShadowLedger());
    const manual = spawnSync(process.execPath, [cli, 'shadow-readiness', '--input', shadow.file], {
      encoding: 'utf8',
    });
    expect(manual.status).toBe(3);
    expect(JSON.parse(manual.stdout)).toMatchObject({
      verdict: 'MANUAL_REQUIRED',
      activationAllowed: false,
    });
  });

  it('returns two for threshold failure and one for malformed input', () => {
    const options: RecordOptions[] = Array.from({ length: 10 }, (_, index) => ({
      readinessMs: 700_000,
      outcome: index === 9 ? 'recovered' : 'passed',
      recoveryMs: index === 9 ? 130_000 : undefined,
    }));
    const failing = temporaryFile('failing.json', makeWindow(options));
    const failed = spawnSync(process.execPath, [cli, 'evaluate', '--input', failing.file,
      '--evidence-root', evidenceRoot, '--promotion-evidence-root', promotionRoot,
      '--public-key', publicKeyPath, '--allow-test-key'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(failed.status).toBe(2);
    expect(JSON.parse(failed.stdout).verdict).toBe('FAIL');

    const malformedWindow = makeWindow();
    malformedWindow.releases.pop();
    const malformed = temporaryFile('malformed.json', malformedWindow);
    const rejected = spawnSync(process.execPath, [cli, 'evaluate', '--input', malformed.file,
      '--evidence-root', evidenceRoot, '--promotion-evidence-root', promotionRoot,
      '--public-key', publicKeyPath, '--allow-test-key'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe('');
    expect(rejected.stderr).toContain('exactly 10 production records');
  });
});
