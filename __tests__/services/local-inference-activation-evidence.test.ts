// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn((
  _command: string,
  _args: string[],
  options: { input: Buffer },
) => {
  const artifact = JSON.parse(options.input.toString('utf8'));
  return {
    status: 0,
    stdout: JSON.stringify({
      payloadSha256: artifact.payloadSha256,
      sourceBindingSha256: artifact.payload.sourceBindingSha256,
      workloadSourceSha: artifact.payload.workloadSourceSha,
      producerSourceSha: artifact.payload.producerSourceSha,
    }),
    stderr: '',
  };
}));

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
import {
  LOCAL_INFERENCE_ACTIVATION_EVIDENCE_SCHEMA,
  validateLocalInferenceActivationEvidence,
} from '../../src/services/local-inference-activation-evidence';

const workloadSourceSha = 'a'.repeat(40);
const producerSourceSha = 'b'.repeat(40);
const temporaryRoots: string[] = [];
const acceptanceProducerEntrypoint = 'scripts/content-ten-script-evidence.mjs';
const acceptanceProducerModules = [
  'scripts/content-ten-script-acceptance.mjs',
  'scripts/content-ten-script-evidence.mjs',
];
const economicsProducerEntrypoint = 'scripts/economics-simulation.mjs';
const economicsProducerModules = [
  'scripts/content-ten-script-acceptance.mjs',
  'scripts/content-ten-script-evidence.mjs',
  'scripts/economics-activation-verifier.mjs',
  'scripts/economics-simulation.mjs',
  'scripts/lib/economics-activation-auth.mjs',
  'scripts/lib/release-canonical.mjs',
];

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function immutableProducerToolSource(
  producerSource: string,
  entrypoint: string,
  modulePaths: string[],
) {
  const modules = modulePaths.map((modulePath, index) => ({
    path: modulePath,
    gitMode: '100644',
    gitBlobObjectId: (index + 1).toString(16).padStart(40, '0'),
    sha256: sha256(Buffer.from(`module:${modulePath}`)),
    byteLength: 100 + index,
  }));
  const closureSha256 = sha256(Buffer.from(canonicalJson({
    schemaVersion: 'nexus.immutable-tool-source.v1',
    producerSourceSha: producerSource,
    entrypoint,
    modules,
  })));
  return {
    schemaVersion: 'nexus.immutable-tool-source.v1',
    producerSourceSha: producerSource,
    entrypoint,
    modules,
    closureSha256,
    bindingSha256: sha256(Buffer.from(
      `nexus.immutable-tool-source-binding.v1\n${producerSource}\n${entrypoint}\n${closureSha256}\n`,
    )),
  };
}

function artifactFixture(options: {
  acceptancePass?: boolean;
  launchEligible?: boolean;
  producerSource?: string;
} = {}): Record<string, unknown> {
  const producerSource = options.producerSource ?? producerSourceSha;
  const acceptanceProducerToolSource = immutableProducerToolSource(
    producerSource,
    acceptanceProducerEntrypoint,
    acceptanceProducerModules,
  );
  const producerToolSource = immutableProducerToolSource(
    producerSource,
    economicsProducerEntrypoint,
    economicsProducerModules,
  );
  const acceptanceSourceBindingSha256 = sha256(Buffer.from(
    `nexus.acceptance-source-binding.v2\n${workloadSourceSha}\n${producerSource}\n${acceptanceProducerToolSource.bindingSha256}\n`,
  ));
  const sourceBindingSha256 = sha256(Buffer.from(
    `nexus.economics-source-binding.v1\n${workloadSourceSha}\n${producerSource}\n${acceptanceSourceBindingSha256}\n${producerToolSource.bindingSha256}\n`,
  ));
  const gates = {
    blendedAtLeast80: options.launchEligible ?? true,
    webHasPaidCohort: true,
    webAtLeast80: true,
    appleHasPaidCohort: true,
    appleFloor: true,
  };
  const release = {
    viewSchema: 'nexus.release-state-view.v2',
    capturedAt: '2026-08-26T11:00:00.000Z',
    releaseId: 'c'.repeat(32),
    sourceSha: producerSource,
    stateStatus: 'completed',
    receiptSchema: 'nexus.release-receipt.v3',
    receiptOutcome: 'completed',
    receiptCompletedAt: '2026-08-26T10:59:00.000Z',
    releasePayloadDigest: sha256(Buffer.from('producer-release')),
  };
  const workloadRelease = {
    ...release,
    releaseId: 'd'.repeat(32),
    sourceSha: workloadSourceSha,
    releasePayloadDigest: sha256(Buffer.from('workload-release')),
    backendImageDigest: sha256(Buffer.from('workload-backend-image')),
    boundAt: '2026-08-26T11:01:00.000Z',
    viewSha256: sha256(Buffer.from('workload-view')),
  };
  const payload = {
    generatedAt: '2026-08-26T12:00:00.000Z',
    workloadSourceSha,
    producerSourceSha: producerSource,
    producerToolSource,
    sourceBindingSha256,
    bindings: {
      rateCard: {},
      acceptance: {
        schemaVersion: 'nexus.content-ten-script-evidence.v6',
        acceptancePass: options.acceptancePass ?? true,
        workloadSourceSha,
        evidenceSha256: sha256(Buffer.from('acceptance')),
        stateSha256: sha256(Buffer.from('state')),
        producerToolSource: acceptanceProducerToolSource,
        qualityReviewSha256: sha256(Buffer.from('quality')),
        scopeSha256: sha256(Buffer.from('scope')),
        workloadReleaseViewSha256: workloadRelease.viewSha256,
        evidence: {},
      },
      operationUsage: {},
      release: {
        ...release,
        producerSourceSha: producerSource,
        viewSha256: sha256(Buffer.from('producer-view')),
      },
      workloadRelease,
    },
    measuredScriptP95: {},
    measuredOperationP95: {},
    result: {
      profiles: [],
      blendedMarginPct: 0.85,
      webMarginPct: 0.85,
      appleMarginPct: 0.75,
      gates,
      launchEligible: options.launchEligible ?? true,
    },
  };
  return {
    schemaVersion: LOCAL_INFERENCE_ACTIVATION_EVIDENCE_SCHEMA,
    digestAlgorithm: 'sha256-canonical-json-payload-v1',
    payloadSha256: sha256(Buffer.from(canonicalJson(payload))),
    authentication: {
      schemaVersion: 'nexus.pre-release-economics-auth.v1',
      algorithm: 'hmac-sha256',
      signature: sha256(Buffer.from('fixture-authentication')),
    },
    payload,
  };
}

function privateArtifactFile(artifact: Record<string, unknown>): {
  root: string;
  filename: string;
  reference: string;
} {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nexus-activation-evidence-')));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const filename = path.join(root, 'economics.json');
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(filename, bytes, { mode: 0o600 });
  chmodSync(filename, 0o600);
  return { root, filename, reference: sha256(bytes) };
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  spawnSyncMock.mockClear();
});

describe('local inference activation evidence', () => {
  it('admits only the digest-pinned passing artifact for the exact serving release', () => {
    const fixture = privateArtifactFile(artifactFixture());

    expect(validateLocalInferenceActivationEvidence({
      artifactPath: fixture.filename,
      evidenceReference: fixture.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
    })).toMatchObject({
      artifactSha256: fixture.reference,
      evidenceReference: fixture.reference,
      workloadSourceSha,
      producerSourceSha,
    });
  });

  it('rejects an arbitrary reference and a mismatched serving release', () => {
    const fixture = privateArtifactFile(artifactFixture());

    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: fixture.filename,
      evidenceReference: `sha256:${'0'.repeat(64)}`,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_DIGEST_MISMATCH',
    }));
    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: fixture.filename,
      evidenceReference: fixture.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: 'e'.repeat(40) },
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_RELEASE_MISMATCH',
    }));
  });

  it('rejects canonically redigested artifacts with either producer tool closure drift', () => {
    const artifact = artifactFixture() as any;
    artifact.payload.producerToolSource.modules[0].sha256 = sha256(Buffer.from('substituted'));
    artifact.payloadSha256 = sha256(Buffer.from(canonicalJson(artifact.payload)));
    const fixture = privateArtifactFile(artifact);

    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: fixture.filename,
      evidenceReference: fixture.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SOURCE_INVALID',
    }));

    const acceptanceDrift = artifactFixture() as any;
    acceptanceDrift.payload.bindings.acceptance.producerToolSource.modules[0].sha256 =
      sha256(Buffer.from('substituted acceptance producer'));
    acceptanceDrift.payloadSha256 = sha256(Buffer.from(canonicalJson(acceptanceDrift.payload)));
    const acceptanceFixture = privateArtifactFile(acceptanceDrift);
    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: acceptanceFixture.filename,
      evidenceReference: acceptanceFixture.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SOURCE_INVALID',
    }));
  });

  it('rejects failed acceptance, failed economics, and non-immutable file identity', () => {
    const failedAcceptance = privateArtifactFile(artifactFixture({ acceptancePass: false }));
    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: failedAcceptance.filename,
      evidenceReference: failedAcceptance.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_NOT_ACCEPTED',
    }));

    const failedEconomics = privateArtifactFile(artifactFixture({ launchEligible: false }));
    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: failedEconomics.filename,
      evidenceReference: failedEconomics.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_NOT_ELIGIBLE',
    }));

    const linked = privateArtifactFile(artifactFixture());
    linkSync(linked.filename, path.join(linked.root, 'second-link.json'));
    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: linked.filename,
      evidenceReference: linked.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_FILE_INVALID',
    }));
  });

  it('rejects an artifact refused by authenticated governed-input verification', () => {
    const fixture = privateArtifactFile(artifactFixture());
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'refused' });

    expect(() => validateLocalInferenceActivationEvidence({
      artifactPath: fixture.filename,
      evidenceReference: fixture.reference,
      env: { NEXUS_RELEASE_SOURCE_SHA: producerSourceSha },
      authenticationSecret: 'test-activation-secret-at-least-32-bytes-long',
    })).toThrowError(expect.objectContaining({
      code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_AUTHENTICATION_INVALID',
    }));
  });
});
