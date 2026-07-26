import { execFileSync, spawnSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/rollback-drill-staging-attestation.mjs');
const ordinaryStaging = path.resolve('scripts/release-staging-attestation.mjs');
const releaseOperator = path.resolve('scripts/release-operator.sh');
const roots: string[] = [];
const runtimeSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);
const installedRuntimeDigest = 'c'.repeat(64);
const recoveryRuntimeDigest = 'd'.repeat(64);
const requestId = '11111111-1111-4111-8111-111111111111';
const ordinaryKeyId = 'github-environment-release-signing-2026-07';
const legacyBase = '/home/dominguez/telegram-hub-bot-staging';
const controlSha =
  'fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1';

function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture({ legacy = false } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rollback-drill-staging-')),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const production = generateKeyPairSync('ed25519');
  const drill = generateKeyPairSync('ed25519');
  const files = {
    sourceManifest: path.join(root, 'source-manifest.json'),
    stagingRequest: path.join(root, 'staging-request.json'),
    signingRequest: path.join(root, 'signing-request.json'),
    signingRun: path.join(root, 'signing-run.json'),
    signedBundle: path.join(root, 'signed'),
    productionPublic: path.join(root, 'production-public.pem'),
    drillPublic: path.join(root, 'drill-public.pem'),
    drillPrivate: path.join(root, 'drill-private.pem'),
  };
  fs.writeFileSync(
    files.productionPublic,
    production.publicKey.export({ format: 'pem', type: 'spki' }),
  );
  fs.writeFileSync(
    files.drillPublic,
    drill.publicKey.export({ format: 'pem', type: 'spki' }),
  );
  fs.writeFileSync(
    files.drillPrivate,
    drill.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600 },
  );
  const generatedAt = new Date(Date.now() - 60_000).toISOString();
  const manifestPayload = {
    schema: 'nexus.release-manifest-payload.v2',
    runtimeSha,
    packageVersion: '4.14.999',
    artifact: { digest: artifactDigest, fileCount: 0, files: [] },
    source: { dirty: false },
    ci: { runId: '40001' },
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 60 * 60_000).toISOString(),
  };
  const sourceManifest = {
    schema: 'nexus.release-manifest.v2',
    keyId: ordinaryKeyId,
    signatureAlgorithm: 'ed25519',
    payload: manifestPayload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(manifestPayload)),
      production.privateKey,
    ).toString('base64'),
  };
  const sourceManifestBody = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
  fs.writeFileSync(files.sourceManifest, sourceManifestBody);
  const sourceProvenance = {
    rootRequestSha256: '9'.repeat(64),
    releaseManifestSha256: sha256(sourceManifestBody),
    releaseManifestPayloadSha256: sha256(canonicalJson(manifestPayload)),
    releaseManifestSignatureSha256:
      sha256(Buffer.from(sourceManifest.signature, 'base64')),
    releaseManifestSigningRunId: String(manifestPayload.ci.runId),
    releaseManifestSigningRunSha256:
      sha256(canonicalJson(manifestPayload.ci)),
  };
  const verifiedAt = new Date(Date.now() - 10_000).toISOString();
  const base = legacy ? legacyBase : '/srv/nexus-release/staging';
  const releaseDir =
    `${base}/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;
  const predecessor =
    `${base}/releases/${'1'.repeat(40)}-${'2'.repeat(12)}`;
  const selector = (target: string) => ({
    path: `${base}/current`,
    target,
    dev: '10',
    ino: target === predecessor ? '20' : '21',
    uid: 1000,
    gid: 1000,
    mode: 0o777,
  });
  const publishedAt = new Date(Date.now() - 11_000).toISOString();
  const remoteServices = [
    {
      name: 'nexus-hub-staging',
      status: 'online',
      cwd: releaseDir,
      executable: `${releaseDir}/dist/index.js`,
      interpreter: 'node',
      releaseSha: runtimeSha,
      sentryRelease: runtimeSha,
    },
    {
      name: 'content-engine-staging',
      status: 'online',
      cwd: `${releaseDir}/content-engine`,
      executable: `${releaseDir}/content-engine/.venv/bin/python3.12`,
      interpreter: 'none',
      releaseSha: runtimeSha,
      sentryRelease: runtimeSha,
    },
  ];
  const endpoint = (uptime: number) => ({
    backendSnapshotSha256: 'e'.repeat(64),
    backendVersion: '4.14.999',
    backendUptime: uptime,
    contentReadySha256: 'f'.repeat(64),
    contentStatus: 'ready',
    internalAuthConfigured: true,
  });
  const stagingRequest = {
    schema: 'nexus.staging-attestation-request.v1',
    requestId,
    runtimeSha,
    artifactDigest,
    releaseManifestSha256: sha256(sourceManifestBody),
    installedRuntimeDigest,
    recoveryRuntimeDigest,
    releaseDir,
    remoteIdentity: {
      schema: 'nexus.pm2-release-identity.v1',
      services: remoteServices,
    },
    remoteReadiness: {
      schema: 'nexus.release-readiness.v1',
      role: 'staging',
      runtimeSha,
      checks: {
        nativeBinding: true,
        sqliteIntegrity: true,
        sqliteForeignKeys: true,
        backendHealth: true,
        ...(legacy ? { authenticatedBackendSnapshot: true } : {}),
        authenticatedContentEngine: true,
        pm2ExactIdentity: true,
        pm2RestartStable: true,
      },
      ...(legacy ? {
        checkedAt: new Date(Date.now() - 10_000).toISOString(),
        readinessAttempts: 1,
        services: remoteServices,
        stabilitySeconds: 60,
        stabilityStartedAt: new Date(Date.now() - 75_000).toISOString(),
        stabilityCompletedAt: new Date(Date.now() - 15_000).toISOString(),
        stabilityObservedSeconds: 60,
        soak: {
          schema: 'nexus.release-readiness-soak.v1',
          clock: 'monotonic',
          requiredSeconds: 60,
          startedMonotonicNs: '1000000000',
          completedMonotonicNs: '61000000000',
          observedNanoseconds: '60000000000',
          initial: endpoint(100),
          final: endpoint(160),
        },
      } : {}),
    },
    smoke: {
      status: 'passed',
      command: legacy
        ? 'scripts/remote-release-readiness.sh'
        : 'scripts/staging-smoke.sh',
      logSha256: 'f'.repeat(64),
    },
    verifiedAt,
    expiresAt: new Date(Date.parse(verifiedAt) + 60 * 60_000).toISOString(),
    ...(legacy ? {
      drillBootstrap: {
        schema: 'nexus.rollback-drill-legacy-staging-bootstrap.v1',
        profile: 'isolated-kvm-first-drill',
        promotionAllowed: false,
        transactionId: requestId,
        base,
        broker: {
          version: 'nexus-rollback-drill-legacy-staging-broker.v1',
          sha256: '3'.repeat(64),
          adapterSha256: '4'.repeat(64),
        },
        control: {
          version: 'nexus-release-promotion-control.v2',
          sha256: controlSha,
        },
        predecessor: {
          runtime: predecessor,
          runtimeSha: '1'.repeat(40),
          artifactDigest: '2'.repeat(64),
          markerSha256: '5'.repeat(64),
          installedAttestationSha256: 'a'.repeat(64),
          recoveryAttestationSha256: 'b'.repeat(64),
          metadataSha256: 'c'.repeat(64),
          runtimeIdentity: {
            dev: '10',
            ino: '30',
            uid: 0,
            gid: 0,
            mode: 0o555,
          },
          selector: selector(predecessor),
        },
        currentSelector: selector(releaseDir),
        brokerReceiptSha256: '6'.repeat(64),
        sourceProvenance,
        transaction: {
          databaseBackupSha256: '8'.repeat(64),
          databaseBackupSizeBytes: 4096,
          journalSha256: '7'.repeat(64),
          preparedAt: new Date(Date.now() - 20_000).toISOString(),
          selectorSwitchedAt: new Date(Date.now() - 15_000).toISOString(),
          readinessCompletedAt: new Date(Date.now() - 12_000).toISOString(),
          publishedAt,
          stabilitySeconds: 60,
          recoveryTargetSeconds: 120,
        },
      },
    } : {}),
  };
  fs.writeFileSync(files.stagingRequest, `${JSON.stringify(stagingRequest, null, 2)}\n`);
  execFileSync(process.execPath, [
    script,
    'request',
    '--root', root,
    '--staging-request', files.stagingRequest,
    '--manifest', files.sourceManifest,
    '--manifest-signing-run-id', '40001',
    '--production-public-key', files.productionPublic,
    '--output', files.signingRequest,
    '--expect-runtime-sha', runtimeSha,
  ], { env: { ...process.env, NODE_ENV: 'test' } });
  const signingRequestBody = fs.readFileSync(files.signingRequest);
  const toolingSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(files.signingRun, `${JSON.stringify({
    id: 50001,
    run_attempt: 2,
    path: '.github/workflows/sign-staging-attestation.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: toolingSha,
    status: 'in_progress',
    conclusion: null,
    display_title:
      `Sign rollback_drill_staging ${requestId} digest ${sha256(signingRequestBody)}`,
    created_at: verifiedAt,
    run_started_at: verifiedAt,
    repository: { full_name: 'felipedrf74/cortex-telegram-hub-bot' },
    head_repository: { full_name: 'felipedrf74/cortex-telegram-hub-bot' },
  }, null, 2)}\n`);
  execFileSync(process.execPath, [
    script,
    'sign',
    '--root', root,
    '--request', files.signingRequest,
    '--manifest', files.sourceManifest,
    '--private-key', files.drillPrivate,
    '--drill-public-key', files.drillPublic,
    '--production-public-key', files.productionPublic,
    '--signing-run-metadata', files.signingRun,
    '--output-dir', files.signedBundle,
    '--expect-runtime-sha', runtimeSha,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GITHUB_RUN_ID: '50001',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_REPOSITORY: 'felipedrf74/cortex-telegram-hub-bot',
      GITHUB_SHA: toolingSha,
    },
  });
  return {
    root,
    files,
    production,
    drill,
    sourceManifest,
    sourceManifestBody,
    stagingRequest,
  };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('rollback-drill ordinary release-evidence bundle', () => {
  it('preserves the ordinary schemas/keyId and allows only the required staging rebind', () => {
    const state = fixture();
    const result = JSON.parse(execFileSync(process.execPath, [
      script,
      'validate',
      '--root', state.root,
      '--bundle', state.files.signedBundle,
      '--request', state.files.signingRequest,
      '--source-manifest', state.files.sourceManifest,
      '--drill-public-key', state.files.drillPublic,
      '--production-public-key', state.files.productionPublic,
      '--expect-runtime-sha', runtimeSha,
      '--allow-test-key',
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    }));
    const manifest = JSON.parse(fs.readFileSync(
      path.join(state.files.signedBundle, 'release-manifest.json'),
      'utf8',
    ));
    const staging = JSON.parse(fs.readFileSync(
      path.join(state.files.signedBundle, 'staging-attestation.json'),
      'utf8',
    ));
    const binding = JSON.parse(fs.readFileSync(
      path.join(state.files.signedBundle, 'drill-binding.json'),
      'utf8',
    ));

    expect(result).toMatchObject({
      ok: true,
      promotable: false,
      rollbackDrillEligible: true,
      runtimeSha,
      artifactDigest,
    });
    expect(manifest).toMatchObject({
      schema: 'nexus.release-manifest.v2',
      keyId: ordinaryKeyId,
    });
    expect(canonicalJson(manifest.payload))
      .toBe(canonicalJson(state.sourceManifest.payload));
    expect(staging).toMatchObject({
      schema: 'nexus.staging-attestation.v1',
      keyId: ordinaryKeyId,
      payload: {
        runtimeSha,
        artifactDigest,
        releaseManifestSha256: sha256(
          fs.readFileSync(path.join(state.files.signedBundle, 'release-manifest.json')),
        ),
        protectedSigning: {
          workflow: '.github/workflows/sign-staging-attestation.yml',
          runId: '50001',
          runAttempt: '2',
        },
      },
    });
    const { protectedSigning: _signing, ...stagingWithoutSigning } = staging.payload;
    expect(canonicalJson(stagingWithoutSigning)).toBe(canonicalJson({
      ...state.stagingRequest,
      releaseManifestSha256: staging.payload.releaseManifestSha256,
    }));
    expect(binding).toMatchObject({
      schema: 'nexus.rollback-drill-staging-bundle.v1',
      payload: {
        scope: 'isolated-kvm-first-drill',
        promotionAllowed: false,
        source: {
          releaseManifestSha256: sha256(state.sourceManifestBody),
          stagingRequestSha256: sha256(fs.readFileSync(state.files.stagingRequest)),
        },
      },
    });
  });

  it('is drill-key-valid while both ordinary inner envelopes reject the production key', () => {
    const state = fixture();
    for (const file of ['release-manifest.json', 'staging-attestation.json']) {
      const envelope = JSON.parse(fs.readFileSync(
        path.join(state.files.signedBundle, file),
        'utf8',
      ));
      const signature = Buffer.from(envelope.signature, 'base64');
      expect(verify(
        null,
        Buffer.from(canonicalJson(envelope.payload)),
        state.drill.publicKey,
        signature,
      )).toBe(true);
      expect(verify(
        null,
        Buffer.from(canonicalJson(envelope.payload)),
        state.production.publicKey,
        signature,
      )).toBe(false);
    }
    const productionValidation = spawnSync(process.execPath, [
      ordinaryStaging,
      'validate-signed',
      '--root', state.root,
      '--attestation', path.join(state.files.signedBundle, 'staging-attestation.json'),
      '--public-key', state.files.productionPublic,
      '--allow-test-key',
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(productionValidation.status).not.toBe(0);
    expect(`${productionValidation.stdout}${productionValidation.stderr}`)
      .toContain('staging attestation signature is invalid');
  });

  it('rejects source drift and any mutation of the signed outer binding', () => {
    const state = fixture();
    const source = JSON.parse(fs.readFileSync(state.files.sourceManifest, 'utf8'));
    source.payload.runtimeSha = '1'.repeat(40);
    fs.writeFileSync(state.files.sourceManifest, `${JSON.stringify(source, null, 2)}\n`);
    const sourceResult = spawnSync(process.execPath, [
      script,
      'validate',
      '--root', state.root,
      '--bundle', state.files.signedBundle,
      '--request', state.files.signingRequest,
      '--source-manifest', state.files.sourceManifest,
      '--drill-public-key', state.files.drillPublic,
      '--production-public-key', state.files.productionPublic,
      '--allow-test-key',
    ], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect(sourceResult.status).not.toBe(0);

    const bindingPath = path.join(state.files.signedBundle, 'drill-binding.json');
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    binding.payload.promotionAllowed = true;
    fs.writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    const bindingResult = spawnSync(process.execPath, [
      script,
      'validate-signed',
      '--root', state.root,
      '--bundle', state.files.signedBundle,
      '--drill-public-key', state.files.drillPublic,
      '--production-public-key', state.files.productionPublic,
      '--allow-test-key',
    ], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect(bindingResult.status).not.toBe(0);
    expect(`${bindingResult.stdout}${bindingResult.stderr}`)
      .toContain('binding signature is invalid');
  });
});

describe('rollback-drill legacy staging bootstrap binding', () => {
  it('accepts only the governed five-second protected-signing chronology', async () => {
    const state = fixture({ legacy: true });
    const { validateLegacyStagingRequest } = await import(
      '../../scripts/rollback-drill-legacy-staging-adapter.mjs'
    );
    const verifiedAtMs = Date.parse(state.stagingRequest.verifiedAt);
    const request = structuredClone(state.stagingRequest);
    request.protectedSigning = {
      workflow: '.github/workflows/sign-staging-attestation.yml',
      runId: '50001',
      runAttempt: '2',
      requestedAt: new Date(verifiedAtMs - 5_000).toISOString(),
      signedAt: new Date(verifiedAtMs + 1_000).toISOString(),
    };
    expect(() => validateLegacyStagingRequest(request, runtimeSha))
      .not.toThrow();

    request.protectedSigning.requestedAt =
      new Date(verifiedAtMs - 5_001).toISOString();
    expect(() => validateLegacyStagingRequest(request, runtimeSha))
      .toThrow('protected signing identity is invalid');

    request.protectedSigning.requestedAt =
      new Date(verifiedAtMs - 1_000).toISOString();
    request.protectedSigning.signedAt =
      new Date(verifiedAtMs - 1).toISOString();
    expect(() => validateLegacyStagingRequest(request, runtimeSha))
      .toThrow('protected signing identity is invalid');
  });

  it('binds the bootstrap in protected drill evidence while ordinary staging rejects it', () => {
    const state = fixture({ legacy: true });
    const result = JSON.parse(execFileSync(process.execPath, [
      script,
      'validate',
      '--root', state.root,
      '--bundle', state.files.signedBundle,
      '--request', state.files.signingRequest,
      '--source-manifest', state.files.sourceManifest,
      '--drill-public-key', state.files.drillPublic,
      '--production-public-key', state.files.productionPublic,
      '--expect-runtime-sha', runtimeSha,
      '--allow-test-key',
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    }));
    const signingRequest = JSON.parse(
      fs.readFileSync(state.files.signingRequest, 'utf8'),
    );
    const signedStaging = JSON.parse(fs.readFileSync(
      path.join(state.files.signedBundle, 'staging-attestation.json'),
      'utf8',
    ));
    expect(result).toMatchObject({
      ok: true,
      promotable: false,
      rollbackDrillEligible: true,
      scope: 'isolated-kvm-first-drill',
    });
    expect(signingRequest.drillBootstrapSha256).toBe(
      sha256(canonicalJson(state.stagingRequest.drillBootstrap)),
    );
    expect(signedStaging.payload).toMatchObject({
      drillBootstrap: {
        profile: 'isolated-kvm-first-drill',
        promotionAllowed: false,
        base: legacyBase,
      },
    });

    const rawOrdinary = spawnSync(process.execPath, [
      ordinaryStaging,
      'validate-request',
      '--root', state.root,
      '--request', state.files.stagingRequest,
      '--expect-runtime-sha', runtimeSha,
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(rawOrdinary.status).not.toBe(0);
    expect(`${rawOrdinary.stdout}${rawOrdinary.stderr}`)
      .toContain('drill-only legacy staging evidence cannot satisfy');

    const productionSignedPath = path.join(
      state.root,
      'production-signed-legacy-staging.json',
    );
    const productionEnvelope = {
      schema: 'nexus.staging-attestation.v1',
      keyId: ordinaryKeyId,
      signatureAlgorithm: 'ed25519',
      payload: state.stagingRequest,
      signature: cryptoSign(
        null,
        Buffer.from(canonicalJson(state.stagingRequest)),
        state.production.privateKey,
      ).toString('base64'),
    };
    fs.writeFileSync(
      productionSignedPath,
      `${JSON.stringify(productionEnvelope, null, 2)}\n`,
    );
    const signedOrdinary = spawnSync(process.execPath, [
      ordinaryStaging,
      'validate-signed',
      '--root', state.root,
      '--attestation', productionSignedPath,
      '--public-key', state.files.productionPublic,
      '--allow-test-key',
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(signedOrdinary.status).not.toBe(0);
    expect(`${signedOrdinary.stdout}${signedOrdinary.stderr}`)
      .toContain('drill-only legacy staging evidence cannot satisfy');
  });

  it('rejects any mutation of the drill-only bootstrap binding', () => {
    const state = fixture({ legacy: true });
    const request = JSON.parse(
      fs.readFileSync(state.files.signingRequest, 'utf8'),
    );
    request.drillBootstrapSha256 = '9'.repeat(64);
    fs.writeFileSync(
      state.files.signingRequest,
      `${JSON.stringify(request, null, 2)}\n`,
    );
    const result = spawnSync(process.execPath, [
      script,
      'validate-request',
      '--root', state.root,
      '--request', state.files.signingRequest,
      '--expect-runtime-sha', runtimeSha,
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`)
      .toContain('bootstrap digest mismatch');
  });
});

describe('drill-staging operator entry', () => {
  it('requires acknowledgement and exposes only a non-promotable dry-run', () => {
    const missingAcknowledgement = spawnSync('bash', [
      releaseOperator,
      'drill-staging',
      '--dry-run',
    ], { encoding: 'utf8' });
    expect(missingAcknowledgement.status).toBe(64);
    expect(missingAcknowledgement.stderr)
      .toContain('--acknowledge-first-drill-bootstrap');

    const dryRun = spawnSync('bash', [
      releaseOperator,
      'drill-staging',
      '--dry-run',
      '--acknowledge-first-drill-bootstrap',
    ], { encoding: 'utf8' });
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      ok: true,
      dryRun: true,
      promotable: false,
      rollbackDrillEligible: false,
      featureEnabled: true,
      reason: 'execution_and_protected_drill_signature_required',
      base: legacyBase,
      broker:
        '/usr/local/sbin/nexus-rollback-drill-legacy-staging-broker',
    });
  });
});
