import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildMigrationInventory,
} from '../../scripts/lib/migration-cd-eligibility.mjs';
import {
  canonicalJson,
  sha256,
} from '../../scripts/lib/release-canonical.mjs';
import {
  RELEASE_CONTROL_PLANE_SCHEMA,
} from '../../scripts/lib/release-control-plane.mjs';
import {
  buildReleaseManifestPayload,
  loadContinuousDeploymentPolicy,
  migrationVerdictDigest,
} from '../../scripts/lib/release-manifest.mjs';
import {
  RELEASE_MANIFEST_SCHEMA_POLICY_PATH,
  loadReleaseManifestSchemaPolicy,
} from '../../scripts/lib/release-manifest-schema-policy.mjs';
import {
  loadProductionMigrationLineagePolicy,
  releaseMigrationReconciliationProjection,
} from '../../scripts/lib/production-migration-lineage.mjs';
import {
  RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH,
  RELEASE_MANIFEST_POINTER_DECISIONS,
  RELEASE_MANIFEST_POINTER_GUARD_MODES,
  RELEASE_MANIFEST_POINTER_GUARD_RESULT_SCHEMA,
  decideReleaseManifestPointer,
  parseReleaseManifestPointerGuardArgs,
  runReleaseManifestPointerGuardCli,
  verifyReleaseManifestPointer,
} from '../../scripts/release-manifest-pointer-guard.mjs';

type Json = Record<string, any>;

const repoRoot = resolve(process.cwd());
const policy = loadContinuousDeploymentPolicy(repoRoot);
const schemaPolicy = loadReleaseManifestSchemaPolicy(repoRoot);
const lineagePolicy = loadProductionMigrationLineagePolicy({ root: repoRoot });
const reconciliation = releaseMigrationReconciliationProjection(lineagePolicy);
const inventory = buildMigrationInventory({
  readDir: (directory: string) => readdirSync(join(repoRoot, directory)),
  readFile: (file: string) => readFileSync(join(repoRoot, file)),
  compatibilityExemptions: lineagePolicy.release.compatibilityExemptions,
});

const CANDIDATE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const CONTROL_PLANE_DIGEST = 'c'.repeat(64);
const OTHER_CONTROL_PLANE_DIGEST = 'd'.repeat(64);
const CANDIDATE_NOW = Date.parse('2026-08-11T12:00:00.000Z');
const CANDIDATE_CREATED_AT = '2026-08-11T12:00:00.000Z';
const RETAINED_CREATED_AT = '2025-01-02T03:04:05.000Z';
const temporaryRoots: string[] = [];

let publicKeyPath: string;
let publicKeyPem: string;
let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-pointer-guard-'));
  temporaryRoots.push(root);
  return root;
}

function manifestPayload({
  createdAt = CANDIDATE_CREATED_AT,
  sha = CANDIDATE_SHA,
  activeSchemaPolicy = schemaPolicy,
}: {
  createdAt?: string;
  sha?: string;
  activeSchemaPolicy?: Json;
} = {}) {
  const cdEligibility = {
    eligible: true,
    predecessorCompatible: true,
    reasons: [] as string[],
  };
  const migrations = {
    digest: migrationVerdictDigest(cdEligibility, inventory, reconciliation),
    upFileCount: inventory.length,
    downFileCount: 41,
    cdEligibility,
    inventory,
    reconciliation,
  };
  return buildReleaseManifestPayload({
    createdAt,
    source: {
      repository: policy.trust.repository,
      ref: policy.trust.protectedRef,
      sha,
      workflow: policy.trust.workflow,
      runId: '1234',
      runAttempt: '1',
    },
    images: {
      backend: {
        repository: policy.registry.backendImage,
        digest: `sha256:${'1'.repeat(64)}`,
      },
      contentEngine: {
        repository: policy.registry.contentEngineImage,
        digest: `sha256:${'2'.repeat(64)}`,
      },
    },
    compose: {
      path: policy.compose.file,
      digest: sha256('services:\n  backend: {}\n'),
    },
    controlPlane: {
      schema: RELEASE_CONTROL_PLANE_SCHEMA,
      digest: CONTROL_PLANE_DIGEST,
    },
    migrations,
    policy,
    schemaPolicy: activeSchemaPolicy,
  });
}

function envelopeForPayload(payload: Json, activeSchemaPolicy: Json = schemaPolicy) {
  const generation = activeSchemaPolicy.generations.find(
    (row: Json) => row.generation === payload.schemaVersion,
  );
  if (!generation) throw new Error('test generation is missing');
  return {
    schema: generation.envelopeSchema,
    keyId: policy.trust.signingKeyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString('base64'),
  };
}

function v3Envelope(options: Parameters<typeof manifestPayload>[0] = {}) {
  return envelopeForPayload(manifestPayload(options));
}

function v2Envelope({
  createdAt = RETAINED_CREATED_AT,
  sha = OTHER_SHA,
}: { createdAt?: string; sha?: string } = {}) {
  const payload = clone(manifestPayload({ createdAt, sha }));
  payload.schema = 'nexus.release-manifest-payload.v2';
  payload.schemaVersion = 2;
  delete payload.controlPlane;
  return envelopeForPayload(payload);
}

function pointerVerification(overrides: Json = {}) {
  return verifyReleaseManifestPointer({
    candidateEnvelope: overrides.candidateEnvelope ?? v3Envelope(),
    currentEnvelope: overrides.currentEnvelope ?? v3Envelope({
      createdAt: RETAINED_CREATED_AT,
      sha: OTHER_SHA,
    }),
    expectedCandidateSha: overrides.expectedCandidateSha ?? CANDIDATE_SHA,
    policy,
    schemaPolicy: overrides.schemaPolicy ?? schemaPolicy,
    publicKeyPath,
    mode: overrides.mode ?? RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC,
    expectedInstalledControlPlaneDigest: overrides.expectedInstalledControlPlaneDigest,
    nowMs: overrides.nowMs ?? CANDIDATE_NOW,
  });
}

function writeCliFixture(root: string, {
  candidateEnvelope = v3Envelope(),
  currentEnvelope = v2Envelope(),
  maxManifestBytes = policy.trust.maxManifestBytes,
}: {
  candidateEnvelope?: Json;
  currentEnvelope?: Json;
  maxManifestBytes?: number;
} = {}) {
  const fixturePolicy = clone(policy);
  fixturePolicy.trust.maxManifestBytes = maxManifestBytes;
  writeJson(join(root, 'config/continuous-deployment.json'), fixturePolicy);
  writeJson(join(root, RELEASE_MANIFEST_SCHEMA_POLICY_PATH), schemaPolicy);
  const key = join(root, RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH);
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, publicKeyPem);
  writeJson(join(root, 'manifests/candidate.json'), candidateEnvelope);
  writeJson(join(root, 'manifests/current.json'), currentEnvelope);
}

beforeEach(() => {
  const keys = generateKeyPairSync('ed25519');
  privateKey = keys.privateKey;
  publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const root = fixtureRoot();
  publicKeyPath = join(root, 'release-signing.pem');
  writeFileSync(publicKeyPath, publicKeyPem);
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release manifest pointer decision', () => {
  it('moves automatically only when both verified generations are equal', () => {
    expect(pointerVerification()).toEqual({
      schema: RELEASE_MANIFEST_POINTER_GUARD_RESULT_SCHEMA,
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC,
      decision: RELEASE_MANIFEST_POINTER_DECISIONS.MOVE_MAIN,
      currentGeneration: 3,
      candidateGeneration: 3,
      ownerObservation: null,
    });
  });

  it('holds a newer candidate and accepts an old signed current pointer in retained mode', () => {
    expect(pointerVerification({ currentEnvelope: v2Envelope() })).toMatchObject({
      decision: RELEASE_MANIFEST_POINTER_DECISIONS.HOLD_GENERATION_MISMATCH,
      currentGeneration: 2,
      candidateGeneration: 3,
    });
  });

  it('activates only a newer generation with a matching owner observation', () => {
    expect(pointerVerification({
      currentEnvelope: v2Envelope(),
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION,
      expectedInstalledControlPlaneDigest: CONTROL_PLANE_DIGEST,
    })).toEqual({
      schema: RELEASE_MANIFEST_POINTER_GUARD_RESULT_SCHEMA,
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION,
      decision: RELEASE_MANIFEST_POINTER_DECISIONS.ACTIVATE_MAIN,
      currentGeneration: 2,
      candidateGeneration: 3,
      ownerObservation: {
        evidence: 'owner observation, not machine attestation',
        installedControlPlaneDigest: CONTROL_PLANE_DIGEST,
      },
    });
  });

  it('rejects a downgrade even when both generations are policy-readable', () => {
    const downgradePolicy = clone(schemaPolicy);
    downgradePolicy.candidateReaders = [2, 3];
    expect(() => pointerVerification({
      candidateEnvelope: v2Envelope({
        createdAt: CANDIDATE_CREATED_AT,
        sha: CANDIDATE_SHA,
      }),
      currentEnvelope: v3Envelope({
        createdAt: RETAINED_CREATED_AT,
        sha: OTHER_SHA,
      }),
      schemaPolicy: downgradePolicy,
    })).toThrow(/would downgrade current generation/i);
  });

  it('rejects equal-generation activation and missing or mismatched control-plane proof', () => {
    expect(() => pointerVerification({
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION,
      expectedInstalledControlPlaneDigest: CONTROL_PLANE_DIGEST,
    })).toThrow(/activation requires.*newer/i);

    expect(() => pointerVerification({
      currentEnvelope: v2Envelope(),
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION,
    })).toThrow(/owner-observed installed control-plane digest/i);

    expect(() => pointerVerification({
      currentEnvelope: v2Envelope(),
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION,
      expectedInstalledControlPlaneDigest: OTHER_CONTROL_PLANE_DIGEST,
    })).toThrow(/does not match the signed candidate/i);

    expect(() => decideReleaseManifestPointer({
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION,
      expectedCandidateSha: CANDIDATE_SHA,
      candidateSourceSha: CANDIDATE_SHA,
      currentGeneration: 2,
      candidateGeneration: 3,
      expectedInstalledControlPlaneDigest: CONTROL_PLANE_DIGEST,
    })).toThrow(/signed candidate control-plane digest/i);
  });

  it('keeps the pure decision surface closed to wrong SHA, unknown mode, and automatic proof input', () => {
    expect(() => decideReleaseManifestPointer({
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC,
      expectedCandidateSha: CANDIDATE_SHA,
      candidateSourceSha: OTHER_SHA,
      currentGeneration: 3,
      candidateGeneration: 3,
    })).toThrow(/does not match the exact expected candidate sha/i);
    expect(() => decideReleaseManifestPointer({
      mode: 'future',
      expectedCandidateSha: CANDIDATE_SHA,
      candidateSourceSha: CANDIDATE_SHA,
      currentGeneration: 3,
      candidateGeneration: 3,
    })).toThrow(/mode is unsupported/i);
    expect(() => decideReleaseManifestPointer({
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC,
      expectedCandidateSha: CANDIDATE_SHA,
      candidateSourceSha: CANDIDATE_SHA,
      currentGeneration: 3,
      candidateGeneration: 3,
      expectedInstalledControlPlaneDigest: CONTROL_PLANE_DIGEST,
    })).toThrow(/automatic mode must not receive/i);
  });
});

describe('release manifest pointer verification', () => {
  it('rejects invalid signatures, envelope/schema mismatch, and wrong signed source SHA', () => {
    const invalidSignature = v3Envelope();
    invalidSignature.signature = `${invalidSignature.signature[0] === 'A' ? 'B' : 'A'}${invalidSignature.signature.slice(1)}`;
    expect(() => pointerVerification({ candidateEnvelope: invalidSignature }))
      .toThrow(/signature is invalid/i);

    const schemaMismatch = v3Envelope();
    schemaMismatch.schema = 'nexus.release-manifest.v2';
    expect(() => pointerVerification({ candidateEnvelope: schemaMismatch }))
      .toThrow(/envelope and payload schema generations do not match/i);

    expect(() => pointerVerification({
      candidateEnvelope: v3Envelope({ sha: OTHER_SHA }),
    })).toThrow(/does not match the exact expected candidate sha/i);
  });

  it('rejects an invalid candidate verification time instead of bypassing freshness', () => {
    expect(() => pointerVerification({ nowMs: Number.NaN }))
      .toThrow(/candidate verification time is invalid/i);
  });
});

describe('release manifest pointer CLI boundary', () => {
  it('parses the exact automatic and activation contracts and rejects unknown or ambiguous args', () => {
    expect(parseReleaseManifestPointerGuardArgs([
      '--candidate-manifest', 'candidate.json',
      '--current-manifest', 'current.json',
      '--expected-candidate-sha', CANDIDATE_SHA,
    ], { defaultRoot: repoRoot })).toMatchObject({
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC,
      publicKey: RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH,
    });
    expect(parseReleaseManifestPointerGuardArgs([
      '--activation',
      '--candidate-manifest', 'candidate.json',
      '--current-manifest', 'current.json',
      '--expected-candidate-sha', CANDIDATE_SHA,
      '--expected-installed-control-plane-digest', CONTROL_PLANE_DIGEST,
    ], { defaultRoot: repoRoot })).toMatchObject({
      mode: RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION,
    });

    expect(() => parseReleaseManifestPointerGuardArgs(['--future']))
      .toThrow(/unknown argument/i);
    expect(() => parseReleaseManifestPointerGuardArgs([
      '--candidate-manifest', 'one',
      '--candidate-manifest', 'two',
    ])).toThrow(/must not be repeated/i);
    expect(() => parseReleaseManifestPointerGuardArgs([
      '--candidate-manifest', 'candidate.json',
      '--current-manifest', 'current.json',
      '--expected-candidate-sha', CANDIDATE_SHA,
      '--expected-installed-control-plane-digest', CONTROL_PLANE_DIGEST,
    ])).toThrow(/requires --activation/i);
    expect(() => parseReleaseManifestPointerGuardArgs([
      '--activation',
      '--candidate-manifest', 'candidate.json',
      '--current-manifest', 'current.json',
      '--expected-candidate-sha', CANDIDATE_SHA,
    ])).toThrow(/owner-observed installed control-plane digest/i);
  });

  it('loads only bounded regular inputs and the exact committed public-key path', () => {
    const root = fixtureRoot();
    writeCliFixture(root);
    const args = [
      '--root', root,
      '--candidate-manifest', 'manifests/candidate.json',
      '--current-manifest', 'manifests/current.json',
      '--expected-candidate-sha', CANDIDATE_SHA,
      '--public-key', RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH,
    ];
    const output = runReleaseManifestPointerGuardCli(args, { nowMs: CANDIDATE_NOW });
    expect(JSON.parse(output.stdout)).toMatchObject({
      decision: RELEASE_MANIFEST_POINTER_DECISIONS.HOLD_GENERATION_MISMATCH,
      currentGeneration: 2,
      candidateGeneration: 3,
    });

    symlinkSync(
      join(root, 'manifests/candidate.json'),
      join(root, 'manifests/candidate-link.json'),
    );
    expect(() => runReleaseManifestPointerGuardCli([
      ...args.slice(0, 3),
      'manifests/candidate-link.json',
      ...args.slice(4),
    ], { nowMs: CANDIDATE_NOW })).toThrow(/candidate manifest.*regular file.*symbolic/i);

    expect(() => runReleaseManifestPointerGuardCli([
      ...args.slice(0, -1),
      'uncommitted-public-key.pem',
    ], { nowMs: CANDIDATE_NOW })).toThrow(/public key must be the committed/i);

    expect(() => runReleaseManifestPointerGuardCli([
      ...args.slice(0, 3),
      join(root, 'manifests/candidate.json'),
      ...args.slice(4),
    ], { nowMs: CANDIDATE_NOW })).toThrow(/candidate manifest path must be repository-relative/i);
    expect(() => runReleaseManifestPointerGuardCli([
      ...args.slice(0, 3),
      '../candidate.json',
      ...args.slice(4),
    ], { nowMs: CANDIDATE_NOW })).toThrow(/candidate manifest path must remain within/i);

    const outside = fixtureRoot();
    writeJson(join(outside, 'candidate.json'), v3Envelope());
    symlinkSync(outside, join(root, 'outside-manifests'));
    expect(() => runReleaseManifestPointerGuardCli([
      ...args.slice(0, 3),
      'outside-manifests/candidate.json',
      ...args.slice(4),
    ], { nowMs: CANDIDATE_NOW })).toThrow(/parent directory escapes the repository root/i);
  });

  it('enforces the governed manifest byte bound before parsing', () => {
    const root = fixtureRoot();
    writeCliFixture(root, { maxManifestBytes: 100 });
    expect(() => runReleaseManifestPointerGuardCli([
      '--root', root,
      '--candidate-manifest', 'manifests/candidate.json',
      '--current-manifest', 'manifests/current.json',
      '--expected-candidate-sha', CANDIDATE_SHA,
    ], { nowMs: CANDIDATE_NOW })).toThrow(/candidate manifest must be a bounded regular file/i);
  });
});
