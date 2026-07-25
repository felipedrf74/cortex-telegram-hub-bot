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

function fixture() {
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
  const manifestPayload = {
    runtimeSha,
    packageVersion: '4.14.999',
    artifact: { digest: artifactDigest, fileCount: 0, files: [] },
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
  const verifiedAt = new Date(Date.now() - 10_000).toISOString();
  const releaseDir =
    `/srv/nexus-release/staging/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;
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
      services: [
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
      ],
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
        authenticatedContentEngine: true,
        pm2ExactIdentity: true,
        pm2RestartStable: true,
      },
    },
    smoke: {
      status: 'passed',
      command: 'scripts/staging-smoke.sh',
      logSha256: 'f'.repeat(64),
    },
    verifiedAt,
    expiresAt: new Date(Date.parse(verifiedAt) + 60 * 60_000).toISOString(),
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

describe('drill-staging operator entry', () => {
  it('requires acknowledgement and remains disabled before the v2 adapter review', () => {
    const missingAcknowledgement = spawnSync('bash', [
      releaseOperator,
      'drill-staging',
      '--dry-run',
    ], { encoding: 'utf8' });
    expect(missingAcknowledgement.status).toBe(64);
    expect(missingAcknowledgement.stderr)
      .toContain('--acknowledge-first-drill-bootstrap');

    const disabled = spawnSync('bash', [
      releaseOperator,
      'drill-staging',
      '--dry-run',
      '--acknowledge-first-drill-bootstrap',
    ], { encoding: 'utf8' });
    expect(disabled.status).toBe(78);
    expect(disabled.stderr)
      .toContain('disabled until the governed control-v2 legacy-base adapter is installed');
    expect(JSON.parse(disabled.stdout)).toMatchObject({
      ok: false,
      promotable: false,
      rollbackDrillEligible: false,
      featureEnabled: false,
      reason: 'governed_control_v2_legacy_base_adapter_required',
    });
  });
});
