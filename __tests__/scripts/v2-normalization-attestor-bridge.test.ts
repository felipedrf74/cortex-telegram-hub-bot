import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const BRIDGE = join(
  ROOT,
  'scripts',
  'trusted-release-runtime-attestation-v2-bridge.mjs',
);
const INSTALLER = join(
  ROOT,
  'scripts',
  'remote-v2-normalization-attestor-install.sh',
);
const DIGEST = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function canonicalJson(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

interface Fixture {
  root: string;
  base: string;
  payload: Record<string, any>;
  authorization: string;
  ownerPublicKey: string;
  machineIdFile: string;
  controlSha256: string;
  replacedAttestorSha256: string;
  bridgeSha256: string;
  writeAuthorization: (
    nextPayload?: Record<string, any>,
    signaturePayload?: Record<string, any>,
  ) => void;
}
const fixtures: Fixture[] = [];

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'nexus-v2-attestor-')),
  );
  const base = join(root, 'production');
  const releases = join(base, 'releases');
  mkdirSync(releases, { recursive: true });
  const owner = generateKeyPairSync('ed25519');
  const ownerPublicKey = join(root, 'owner.pem');
  const machineIdFile = join(root, 'machine-id');
  const authorization = join(root, 'authorization.json');
  writeFileSync(
    ownerPublicKey,
    owner.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  writeFileSync(machineIdFile, 'fixture-machine\n', { mode: 0o644 });
  const controlSha256 = DIGEST('exact-v2-control');
  const replacedAttestorSha256 = DIGEST('exact-e168-attestor');
  const bridgeSha256 = DIGEST(readFileSync(BRIDGE));
  const now = Date.now();
  const payload = {
    schema: 'nexus.v2-normalization-attestor-bridge-request.v1',
    purpose: 'v2_layout_normalization',
    authorizationId: '4db0406b-a76e-4ca3-82c1-0758a0e46862',
    nonce: DIGEST('single-use-nonce'),
    role: 'production',
    serverIdentity: {
      machineIdSha256: DIGEST(readFileSync(machineIdFile)),
    },
    transaction: {
      transactionId: '20260725T120000Z-1234-abcdef123456',
      requestSha256: DIGEST('request'),
      requestEnvelopeSha256: DIGEST('request-envelope'),
    },
    control: {
      version: 'nexus-release-promotion-control.v2',
      sha256: controlSha256,
    },
    attestors: {
      bridgeSha256,
      replacedAttestorSha256,
      strictRestoreSha256: replacedAttestorSha256,
    },
    runtime: {
      base,
      predecessor: {
        runtime: join(releases, 'predecessor'),
        sha: 'a'.repeat(40),
        artifactDigest: DIGEST('predecessor-artifact'),
        installedRuntimeDigest: DIGEST('predecessor-installed'),
      },
      target: {
        runtime: join(releases, 'target'),
        sha: 'b'.repeat(40),
        artifactDigest: DIGEST('target-artifact'),
        installedRuntimeDigest: DIGEST('target-installed'),
      },
    },
    environment: {
      legacy: {
        ownerUid: Math.max(1, process.getuid()),
        groupId: Math.max(1, process.getgid()),
        mode: '0600',
      },
      modern: {
        ownerUid: 0,
        groupId: Math.max(1, process.getgid()),
        mode: '0440',
      },
    },
    mode: {
      legacyPredecessor: 'owner_signed_active_request_only',
      target: 'strict_network_independent',
      strictRestore: 'completed_escrowed_soaked',
      selectorAdoption: 'post_terminal_only',
    },
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 20 * 60_000).toISOString(),
  };

  const writeAuthorization = (
    nextPayload: Record<string, any> = payload,
    signaturePayload: Record<string, any> = nextPayload,
  ) => {
    const envelope = {
      schema: 'nexus.v2-normalization-attestor-bridge-envelope.v1',
      keyId: 'nexus-owner-promotion-2026',
      signatureAlgorithm: 'ed25519',
      payload: nextPayload,
      signature: sign(
        null,
        Buffer.from(canonicalJson(signaturePayload)),
        owner.privateKey,
      ).toString('base64'),
    };
    writeFileSync(authorization, `${JSON.stringify(envelope, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(authorization, 0o600);
  };
  writeAuthorization();
  const created = {
    root,
    base,
    payload,
    authorization,
    ownerPublicKey,
    machineIdFile,
    controlSha256,
    replacedAttestorSha256,
    bridgeSha256,
    writeAuthorization,
  };
  fixtures.push(created);
  return created;
}

function inspect(state: Fixture) {
  return spawnSync(process.execPath, [
    BRIDGE,
    'inspect-authorizations',
    '--production-authorization',
    state.authorization,
    '--owner-public-key',
    state.ownerPublicKey,
    '--machine-id-file',
    state.machineIdFile,
    '--bridge-sha256',
    state.bridgeSha256,
    '--replaced-attestor-sha256',
    state.replacedAttestorSha256,
    '--control-sha256',
    state.controlSha256,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXUS_V2_NORMALIZATION_TEST_MODE: '1',
      NEXUS_V2_NORMALIZATION_EXPECTED_CONTROL_SHA256:
        state.controlSha256,
      NEXUS_V2_NORMALIZATION_EXPECTED_REPLACED_ATTESTOR_SHA256:
        state.replacedAttestorSha256,
    },
  });
}

function writeJson(file: string, value: unknown, mode = 0o600) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(file, mode);
}

function treeIdentity(root: string, relativeRoot: string) {
  const absoluteRoot = join(root, relativeRoot);
  const entries: Array<Record<string, unknown>> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relative = absolute.slice(absoluteRoot.length + 1);
      const stat = lstatSync(absolute);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const body = readFileSync(absolute);
        entries.push({
          path: relative,
          type: 'file',
          size: body.length,
          executable: Boolean(stat.mode & 0o111),
          sha256: DIGEST(body),
        });
      } else {
        throw new Error(`unsupported fixture entry: ${absolute}`);
      }
    }
  };
  walk(absoluteRoot);
  entries.sort((left, right) => String(left.path) < String(right.path) ? -1 : 1);
  return {
    path: relativeRoot,
    digest: DIGEST(canonicalJson(entries)),
    entryCount: entries.length,
    totalBytes: entries.reduce(
      (sum, entry) => sum + Number(entry.size ?? 0),
      0,
    ),
  };
}

function runtimeTree(
  base: string,
  name: string,
  runtimeSha: string,
  modern: boolean,
) {
  const runtime = join(base, 'releases', name);
  mkdirSync(join(runtime, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(
    join(runtime, 'content-engine', '.venv', 'bin'),
    { recursive: true },
  );
  mkdirSync(
    join(runtime, 'content-engine', '.venv', 'lib', 'python3.12', 'site-packages', 'pkg'),
    { recursive: true },
  );
  mkdirSync(join(runtime, 'dist', 'runtime-dependencies'), { recursive: true });
  writeFileSync(join(runtime, 'package.json'), '{"version":"4.14.231"}\n');
  writeFileSync(join(runtime, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(
    join(runtime, 'content-engine', 'requirements.txt'),
    'fastapi==1.0.0\n',
  );
  writeFileSync(
    join(runtime, 'node_modules', 'pkg', 'index.js'),
    'module.exports = 1;\n',
  );
  writeFileSync(
    join(runtime, 'content-engine', '.venv', 'bin', 'python3.12'),
    '#!/bin/sh\necho Python 3.12.0\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(
      runtime,
      'content-engine',
      '.venv',
      'lib',
      'python3.12',
      'site-packages',
      'pkg',
      'core.py',
    ),
    'VALUE = 1\n',
  );
  const artifactPaths = [
    'content-engine/requirements.txt',
    'package-lock.json',
    'package.json',
  ];
  let networkIndependentInstall: Record<string, unknown> | undefined;
  if (modern) {
    const lock = {
      schema: 'nexus.release-runtime-dependencies.v1',
      fixture: true,
      target: { node: process.version, python: 'Python 3.12.0' },
    };
    writeJson(
      join(runtime, 'dist', 'runtime-dependencies', 'lock.json'),
      lock,
      0o644,
    );
    artifactPaths.push('dist/runtime-dependencies/lock.json');
    const evidence = {
      schema: 'nexus.network-independent-install.v1',
      status: 'passed',
      dependencyLockDigest: DIGEST(canonicalJson(lock)),
      packageLockSha256: DIGEST(readFileSync(join(runtime, 'package-lock.json'))),
      pythonRequirementsSha256: DIGEST(
        readFileSync(join(runtime, 'content-engine', 'requirements.txt')),
      ),
      installedAt: '2026-07-25T00:00:00.000Z',
    };
    writeJson(
      join(runtime, '.network-independent-install.json'),
      evidence,
      0o644,
    );
    networkIndependentInstall = {
      schema: evidence.schema,
      status: evidence.status,
      dependencyLockDigest: evidence.dependencyLockDigest,
      evidenceSha256: DIGEST(
        readFileSync(join(runtime, '.network-independent-install.json')),
      ),
    };
  } else {
    rmSync(join(runtime, 'dist'), { recursive: true, force: true });
  }
  artifactPaths.sort();
  const files = artifactPaths.map((relative) => {
    const body = readFileSync(join(runtime, relative));
    return { path: relative, size: body.length, sha256: DIGEST(body) };
  });
  const artifactDigest = DIGEST(JSON.stringify({
    schema: 'nexus.release-artifact-manifest.v1',
    files,
  }));
  writeJson(join(runtime, 'artifact-manifest.json'), {
    schema: 'nexus.release-artifact-manifest.v1',
    git: { sha: runtimeSha },
    files,
    fileCount: files.length,
    digest: artifactDigest,
  }, 0o644);
  writeJson(join(runtime, '.complete.json'), {
    schema: 'nexus.release-bundle.v1',
    runtimeSha,
    artifactDigest,
    fileCount: files.length,
  }, 0o644);
  const identity: Record<string, unknown> = {
    schema: 'nexus.installed-runtime-identity.v1',
    runtimeSha,
    artifactDigest,
    packageVersion: '4.14.231',
    inputs: {
      packageLockSha256: DIGEST(
        readFileSync(join(runtime, 'package-lock.json')),
      ),
      requirementsSha256: DIGEST(
        readFileSync(join(runtime, 'content-engine', 'requirements.txt')),
      ),
      node: process.version,
      python: 'Python 3.12.0',
    },
    ...(modern ? { networkIndependentInstall } : {}),
    trees: [
      treeIdentity(runtime, 'node_modules'),
      treeIdentity(runtime, 'content-engine/.venv'),
    ],
  };
  const installedRuntimeDigest = DIGEST(canonicalJson(identity));
  writeJson(join(runtime, '.nexus-installed-runtime.json'), {
    schema: 'nexus.installed-runtime-attestation.v1',
    identity,
    aggregateDigest: installedRuntimeDigest,
  }, 0o644);
  symlinkSync(join(base, '.env'), join(runtime, '.env'));
  symlinkSync(join(base, 'data'), join(runtime, 'data'));
  symlinkSync(join(base, 'logs'), join(runtime, 'logs'));
  return {
    runtime,
    sha: runtimeSha,
    artifactDigest,
    installedRuntimeDigest,
  };
}

function runtimeAuthorityFixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'nexus-v2-runtime-')),
  );
  const base = join(root, 'production');
  const stateRoot = join(root, 'state');
  const bridgeState = join(stateRoot, 'v2-normalization-attestor-bridge');
  mkdirSync(join(base, 'releases'), { recursive: true });
  mkdirSync(join(base, 'data'));
  mkdirSync(join(base, 'logs'));
  mkdirSync(bridgeState, { recursive: true, mode: 0o700 });
  chmodSync(bridgeState, 0o700);
  writeFileSync(join(base, '.env'), 'FIXTURE_SECRET=value\n', { mode: 0o600 });
  chmodSync(join(base, '.env'), 0o600);
  const predecessor = runtimeTree(base, 'predecessor', 'a'.repeat(40), false);
  const target = runtimeTree(base, 'target', 'b'.repeat(40), true);
  const owner = generateKeyPairSync('ed25519');
  const release = generateKeyPairSync('ed25519');
  const ownerPublicKey = join(root, 'owner.pem');
  const releasePublicKey = join(root, 'release.pem');
  const machineIdFile = join(root, 'machine-id');
  const control = join(root, 'control');
  writeFileSync(
    ownerPublicKey,
    owner.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  writeFileSync(
    releasePublicKey,
    release.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  writeFileSync(machineIdFile, 'runtime-machine\n', { mode: 0o644 });
  writeFileSync(control, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(control, 0o700);
  const recoveryRuntimeDigest = DIGEST('recovery-runtime');
  const manifestPayload = {
    schema: 'nexus.release-manifest-payload.v2',
    runtimeSha: target.sha,
    generatedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    source: { dirty: false },
    artifact: { digest: target.artifactDigest },
  };
  const manifest = {
    schema: 'nexus.release-manifest.v2',
    keyId: 'github-environment-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload: manifestPayload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(manifestPayload)),
      release.privateKey,
    ).toString('base64'),
  };
  const manifestBody = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const stagingPayload = {
    schema: 'nexus.staging-attestation-request.v1',
    requestId: 'aaae7966-f164-49b7-b3be-087a20374f01',
    runtimeSha: target.sha,
    artifactDigest: target.artifactDigest,
    releaseManifestSha256: DIGEST(manifestBody),
    installedRuntimeDigest: target.installedRuntimeDigest,
    recoveryRuntimeDigest,
    releaseDir: `/srv/nexus-release/staging/releases/${target.sha}`,
    remoteReadiness: {
      schema: 'nexus.release-readiness.v1',
      role: 'staging',
      runtimeSha: target.sha,
    },
    smoke: { status: 'passed', logSha256: DIGEST('smoke') },
    protectedSigning: {
      workflow: '.github/workflows/sign-staging-attestation.yml',
      runId: '123',
      runAttempt: '1',
      signedAt: new Date(Date.now() - 30_000).toISOString(),
    },
    verifiedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  const staging = {
    schema: 'nexus.staging-attestation.v1',
    keyId: 'github-environment-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload: stagingPayload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(stagingPayload)),
      release.privateKey,
    ).toString('base64'),
  };
  const stagingBody = Buffer.from(`${JSON.stringify(staging)}\n`);
  const transactionId = '20260725T130000Z-1234-abcdef123456';
  const request = {
    schema: 'nexus.promotion-transaction-request.v1',
    transactionId,
    ownerAuthorization: 'explicit',
    transition: 'v2_layout_normalization',
    productionBase: base,
    predecessor,
    target: {
      ...target,
      sentryRelease: target.sha,
      recoveryRuntimeDigest,
    },
    releaseEvidence: {
      releaseManifestBase64: manifestBody.toString('base64'),
      releaseManifestSha256: DIGEST(manifestBody),
      stagingAttestationBase64: stagingBody.toString('base64'),
      stagingAttestationSha256: DIGEST(stagingBody),
    },
  };
  const requestEnvelope = {
    schema: 'nexus.promotion-transaction-request-envelope.v1',
    keyId: 'nexus-owner-promotion-2026',
    signatureAlgorithm: 'ed25519',
    payload: request,
    signature: sign(
      null,
      Buffer.from(canonicalJson(request)),
      owner.privateKey,
    ).toString('base64'),
  };
  const requestSha256 = DIGEST(canonicalJson(request));
  const requestEnvelopeSha256 = DIGEST(canonicalJson(requestEnvelope));
  const authorizationPayload = {
    schema: 'nexus.v2-normalization-attestor-bridge-request.v1',
    purpose: 'v2_layout_normalization',
    authorizationId: '0f55b12f-b603-4115-b325-4b91bbb9bbf3',
    nonce: DIGEST('runtime-nonce'),
    role: 'production',
    serverIdentity: {
      machineIdSha256: DIGEST(readFileSync(machineIdFile)),
    },
    transaction: { transactionId, requestSha256, requestEnvelopeSha256 },
    control: {
      version: 'nexus-release-promotion-control.v2',
      sha256: DIGEST(readFileSync(control)),
    },
    attestors: {
      bridgeSha256: DIGEST(readFileSync(BRIDGE)),
      replacedAttestorSha256: DIGEST('replaced-attestor'),
      strictRestoreSha256: DIGEST('replaced-attestor'),
    },
    runtime: { base, predecessor, target },
    environment: {
      legacy: {
        ownerUid: Math.max(1, process.getuid()),
        groupId: Math.max(1, process.getgid()),
        mode: '0600',
      },
      modern: {
        ownerUid: 0,
        groupId: Math.max(1, process.getgid()),
        mode: '0440',
      },
    },
    mode: {
      legacyPredecessor: 'owner_signed_active_request_only',
      target: 'strict_network_independent',
      strictRestore: 'completed_escrowed_soaked',
      selectorAdoption: 'post_terminal_only',
    },
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  };
  const authorization = {
    schema: 'nexus.v2-normalization-attestor-bridge-envelope.v1',
    keyId: 'nexus-owner-promotion-2026',
    signatureAlgorithm: 'ed25519',
    payload: authorizationPayload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(authorizationPayload)),
      owner.privateKey,
    ).toString('base64'),
  };
  const authorizationFile = join(
    bridgeState,
    'production-authorization.envelope.json',
  );
  writeJson(authorizationFile, authorization);
  const requestsRoot = join(stateRoot, 'requests');
  const transactionRoot = join(stateRoot, 'transactions', transactionId);
  mkdirSync(join(transactionRoot, 'state'), { recursive: true });
  mkdirSync(requestsRoot, { recursive: true });
  writeJson(join(requestsRoot, `${transactionId}.json`), request, 0o644);
  writeJson(
    join(requestsRoot, `${transactionId}.envelope.json`),
    requestEnvelope,
  );
  writeJson(join(transactionRoot, 'authority.json'), {
    schema: 'nexus.promotion-authority.v1',
    transactionId,
    requestSha256,
    envelopeSha256: requestEnvelopeSha256,
  });
  writeJson(join(stateRoot, 'active.json'), {
    schema: 'nexus.promotion-active.v1',
    transactionId,
    requestSha256,
    envelopeSha256: requestEnvelopeSha256,
    activatedAt: new Date().toISOString(),
  });
  writeJson(join(bridgeState, 'receipt.v1.json'), {
    schema: 'nexus.v2-normalization-attestor-install-receipt.v1',
    status: 'active',
    source: {
      sourceRoot: root,
      sourceSha: 'c'.repeat(40),
      archiveSha256: DIGEST('archive'),
    },
    installed: {
      controlSha256: DIGEST(readFileSync(control)),
      bridgeSha256: DIGEST(readFileSync(BRIDGE)),
      replacedAttestorSha256: DIGEST('replaced-attestor'),
      strictRestoreSha256: DIGEST('replaced-attestor'),
    },
    authorizations: {
      productionSha256: DIGEST(readFileSync(authorizationFile)),
    },
    transaction: { transactionId, requestSha256, requestEnvelopeSha256 },
    environmentPolicy: {
      legacyMode: 'worker:worker:0600',
      modernMode: 'root:worker:0440',
    },
    installedAt: new Date().toISOString(),
  });
  const env = {
    ...process.env,
    NEXUS_V2_NORMALIZATION_TEST_MODE: '1',
    NEXUS_V2_NORMALIZATION_STATE_ROOT: stateRoot,
    NEXUS_V2_NORMALIZATION_CONTROL_BIN: control,
    NEXUS_V2_NORMALIZATION_OWNER_PUBLIC_KEY: ownerPublicKey,
    NEXUS_V2_NORMALIZATION_RELEASE_EVIDENCE_PUBLIC_KEY: releasePublicKey,
    NEXUS_V2_NORMALIZATION_MACHINE_ID_FILE: machineIdFile,
    NEXUS_V2_NORMALIZATION_EXPECTED_CONTROL_SHA256:
      DIGEST(readFileSync(control)),
    NEXUS_V2_NORMALIZATION_EXPECTED_REPLACED_ATTESTOR_SHA256:
      DIGEST('replaced-attestor'),
  };
  const execute = (
    command: 'seal' | 'verify',
    runtime: typeof predecessor,
    overrides: NodeJS.ProcessEnv = {},
  ) => spawnSync(process.execPath, [
    BRIDGE,
    command,
    '--root',
    runtime.runtime,
    '--base',
    base,
    '--runtime-sha',
    runtime.sha,
    '--artifact-digest',
    runtime.artifactDigest,
    '--installed-runtime-digest',
    runtime.installedRuntimeDigest,
    '--group-id',
    String(Math.max(1, process.getgid())),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...env, ...overrides },
  });
  const recover = () => spawnSync(process.execPath, [
    BRIDGE,
    'recover-normalization',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
  const created = {
    root,
    base,
    stateRoot,
    transactionRoot,
    transactionId,
    requestSha256,
    predecessor,
    target,
    execute,
    recover,
  };
  fixtures.push(created as unknown as Fixture);
  return created;
}

function metadata(paths: string[]) {
  return paths.map((absolute) => {
    const stat = lstatSync(absolute);
    return {
      absolute,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o7777,
    };
  });
}

function runtimeMetadataPaths(base: string, runtime: string) {
  const paths = [base, join(base, 'releases'), runtime, join(base, '.env')];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      paths.push(absolute);
    }
  };
  walk(runtime);
  return [...new Set(paths)];
}

afterEach(() => {
  for (const state of fixtures.splice(0)) {
    const makeWritable = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) makeWritable(absolute);
        if (!entry.isSymbolicLink()) chmodSync(absolute, entry.isDirectory() ? 0o700 : 0o600);
      }
      chmodSync(directory, 0o700);
    };
    makeWritable(state.root);
    rmSync(state.root, { recursive: true, force: true });
  }
});

describe('v2 normalization attestor bridge', () => {
  it('accepts one exact production authorization and exposes no staging authority', () => {
    const state = fixture();
    const result = inspect(state);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      transactionId: state.payload.transaction.transactionId,
      productionBase: state.base,
      targetRuntimeSha: state.payload.runtime.target.sha,
      legacyEnvironmentMode: '0600',
      modernEnvironmentMode: '0440',
    });
    expect(parsed.stagingBase).toBeUndefined();
    expect(parsed.stagingAuthorizationSha256).toBeUndefined();
  });

  it.each([
    ['staging role', (state: Fixture) => ({
      ...state.payload,
      role: 'staging',
    })],
    ['wrong bridge digest', (state: Fixture) => ({
      ...state.payload,
      attestors: {
        ...state.payload.attestors,
        bridgeSha256: DIGEST('different-bridge'),
      },
    })],
    ['expired authority', (state: Fixture) => ({
      ...state.payload,
      issuedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    })],
    ['legacy environment ambiguity', (state: Fixture) => ({
      ...state.payload,
      environment: {
        ...state.payload.environment,
        legacy: {
          ...state.payload.environment.legacy,
          mode: '0640',
        },
      },
    })],
  ])('rejects %s even when the altered payload is owner-signed', (_name, alter) => {
    const state = fixture();
    const changed = alter(state) as typeof state.payload;
    state.writeAuthorization(changed);
    const result = inspect(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'trusted_release_runtime_attestation_v2_bridge_failed:',
    );
  });

  it('rejects a valid payload whose signature covers different bytes', () => {
    const state = fixture();
    state.writeAuthorization(state.payload, {
      ...state.payload,
      nonce: DIGEST('different-nonce'),
    });
    const result = inspect(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('signature is invalid');
  });

  it('pins read-only verification before metadata mutation and rollback on seal failure', () => {
    const bridge = readFileSync(BRIDGE, 'utf8');
    const seal = bridge.slice(
      bridge.indexOf('function sealRuntime('),
      bridge.indexOf('function environmentPhase('),
    );
    expect(seal).toContain('assertRootExclusiveParent(base)');
    expect(seal.indexOf('verifyRuntime({')).toBeGreaterThan(-1);
    expect(seal.indexOf('verifyRuntime({')).toBeLessThan(
      seal.indexOf("checkpointNormalization(journal, 'prepared')"),
    );
    expect(seal).toContain('rematerializeRuntime(journal)');
    expect(seal).toContain('reproveEntry(runtimeRoot');
    expect(seal).toContain('postMutationVerify()');
    expect(bridge).toContain('fs.constants.O_NOFOLLOW');
    expect(bridge).toContain('fs.fstatSync(descriptor');
    expect(bridge).toContain('assertNormalizationAuthority(journal)');
    expect(bridge).not.toContain('fs.chownSync(base,');
    expect(bridge).toContain(
      "'production release evidence public key'",
    );
    expect(bridge).toContain(
      "'github-environment-release-signing-2026-07'",
    );
    expect(bridge).toContain(
      "'strict target verification requires root:worker 0440 environment'",
    );
    expect(bridge).toContain(
      "'expired bridge authorization requires a durable nonterminal journal'",
    );
    expect(bridge).toContain("journal.phase === 'recovering'");
  });

  it('refuses normalization when the base parent is not root-exclusive', () => {
    const state = runtimeAuthorityFixture();
    chmodSync(state.root, 0o777);
    const rejected = state.execute('seal', state.target);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'normalization base parent is not root-exclusive',
    );
    expect(() => lstatSync(join(
      state.stateRoot,
      'v2-normalization-attestor-bridge',
      'normalization-journal.v1.json',
    ))).toThrow();
    expect(lstatSync(state.target.runtime).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(state.base, '.env')).mode & 0o777).toBe(0o600);
  });

  it.each([
    'rename_regular',
    'rename_symlink',
  ])('fails closed when an adversary performs a %s replacement', (attack) => {
    const state = runtimeAuthorityFixture();
    const environment = join(state.base, '.env');
    const expectedEnvironment = readFileSync(environment);
    const rejected = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_ATTACK: attack,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'normalization failed and durable recovery is required',
    );
    expect(rejected.stderr).toContain(
      'normalization path-to-inode binding changed',
    );
    expect(readFileSync(environment)).toEqual(expectedEnvironment);
    expect(lstatSync(environment).mode & 0o777).toBe(0o600);
    expect(
      lstatSync(join(
        state.stateRoot,
        'v2-normalization-attestor-bridge',
        'normalization-journal.v1.json',
      )).mode & 0o777,
    ).toBe(0o600);
  });

  it('rejects a directory-to-symlink race before traversing or mutating the target', () => {
    const state = runtimeAuthorityFixture();
    const external = join(state.root, 'root-private-external');
    const secret = join(external, 'secret.txt');
    mkdirSync(external, { mode: 0o700 });
    chmodSync(external, 0o700);
    writeFileSync(secret, 'root-private-secret\n', { mode: 0o600 });
    chmodSync(secret, 0o600);
    const expectedExternal = metadata([external, secret]);
    const expectedSecret = readFileSync(secret);
    const raced = join(state.target.runtime, 'node_modules');
    const displaced = join(
      state.target.runtime,
      '.nexus-v2-test-displaced-node_modules',
    );

    const rejected = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_ATTACK: 'directory_to_symlink',
      NEXUS_V2_NORMALIZATION_TEST_RACE_RELATIVE: 'node_modules',
      NEXUS_V2_NORMALIZATION_TEST_RACE_TARGET: external,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'normalization entry kind changed during traversal',
    );
    expect(metadata([external, secret])).toEqual(expectedExternal);
    expect(readFileSync(secret)).toEqual(expectedSecret);
    expect(() => lstatSync(join(
      state.stateRoot,
      'v2-normalization-attestor-bridge',
      'normalization-journal.v1.json',
    ))).toThrow();

    rmSync(raced, { force: true });
    renameSync(displaced, raced);
  });

  it('rejects a prepared-crash relocated subtree before recovery mutates it', () => {
    const state = runtimeAuthorityFixture();
    const crashed = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_CRASH_PHASE: 'prepared',
    });
    expect(crashed.status).toBeNull();
    expect(crashed.signal).toBe('SIGKILL');

    const raced = join(state.target.runtime, 'node_modules');
    const external = join(state.root, 'relocated-node_modules');
    const externalPackage = join(external, 'pkg');
    const externalFile = join(externalPackage, 'index.js');
    renameSync(raced, external);
    chmodSync(external, 0o700);
    chmodSync(externalPackage, 0o711);
    chmodSync(externalFile, 0o600);
    symlinkSync(external, raced, 'dir');
    const expectedExternal = metadata([
      external,
      externalPackage,
      externalFile,
    ]);

    const rejected = state.recover();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'normalization path-to-inode binding changed',
    );
    expect(metadata([
      external,
      externalPackage,
      externalFile,
    ])).toEqual(expectedExternal);
  });

  it('preflights a relocated environment before rollback mutates runtime metadata', () => {
    const state = runtimeAuthorityFixture();
    const crashed = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_CRASH_PHASE: 'prepared',
    });
    expect(crashed.status).toBeNull();
    expect(crashed.signal).toBe('SIGKILL');

    const environment = join(state.base, '.env');
    const external = join(state.root, 'relocated-environment');
    const stableRuntimePaths = runtimeMetadataPaths(
      state.base,
      state.target.runtime,
    ).filter((absolute) => absolute !== environment);
    const expectedRuntime = metadata(stableRuntimePaths);
    renameSync(environment, external);
    writeFileSync(environment, 'ADVERSARIAL_REPLACEMENT=value\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const expectedExternal = metadata([external]);
    const expectedBody = readFileSync(external);

    const rejected = state.recover();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'normalization path-to-inode binding changed',
    );
    expect(metadata(stableRuntimePaths)).toEqual(expectedRuntime);
    expect(metadata([external])).toEqual(expectedExternal);
    expect(readFileSync(external)).toEqual(expectedBody);
  });

  it('rejects descriptor detachment before mutating the detached release tree', () => {
    const state = runtimeAuthorityFixture();
    const releases = join(state.base, 'releases');
    const external = join(state.root, 'descriptor-detached-releases');
    const expectedUnrelated = metadata([
      state.base,
      join(state.base, '.env'),
    ]);
    const releasePaths = runtimeMetadataPaths(
      state.base,
      state.target.runtime,
    ).filter(
      (absolute) => absolute === releases
        || absolute.startsWith(`${releases}/`),
    );
    const snapshot = (root: string, paths: string[]) => paths.map((absolute) => {
      const stat = lstatSync(absolute);
      return {
        relative: relative(root, absolute),
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        uid: stat.uid,
        gid: stat.gid,
        mode: stat.mode & 0o7777,
      };
    });
    const expected = snapshot(releases, releasePaths);

    const rejected = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_ATTACK: 'descriptor_detachment',
      NEXUS_V2_NORMALIZATION_TEST_RACE_IDENTITY: 'releases:.',
      NEXUS_V2_NORMALIZATION_TEST_RACE_TARGET: external,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'normalization failed and durable recovery is required',
    );
    expect(rejected.stderr).toContain(
      'normalization path-to-inode binding changed',
    );
    expect(snapshot(
      external,
      releasePaths.map(
        (absolute) => join(external, relative(releases, absolute)),
      ),
    )).toEqual(expected);
    expect(metadata([
      state.base,
      join(state.base, '.env'),
    ])).toEqual(expectedUnrelated);
  });

  it('rejects journal descendants recorded below a symlink parent', () => {
    const state = runtimeAuthorityFixture();
    const crashed = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_CRASH_PHASE: 'prepared',
    });
    expect(crashed.status).toBeNull();
    expect(crashed.signal).toBe('SIGKILL');
    const journalPath = join(
      state.stateRoot,
      'v2-normalization-attestor-bridge',
      'normalization-journal.v1.json',
    );
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const parent = journal.metadata.find(
      (record: Record<string, unknown>) =>
        record.scope === 'runtime' && record.relative === 'node_modules',
    );
    expect(parent).toBeDefined();
    Object.assign(parent, {
      kind: 'symlink',
      nlink: '1',
      contentSha256: DIGEST('adversarial symlink target'),
      size: '27',
    });
    writeJson(journalPath, journal);

    const rejected = state.recover();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'contains a descendant below a non-directory parent',
    );
    expect(lstatSync(journalPath).mode & 0o777).toBe(0o600);
  });

  it('executes the environment transition, exact rollback, and recovery-only legacy exception', () => {
    const state = runtimeAuthorityFixture();
    const predecessorSeal = state.execute('seal', state.predecessor);
    expect(predecessorSeal.status, predecessorSeal.stderr).toBe(0);
    const predecessorVerify = state.execute('verify', state.predecessor);
    expect(predecessorVerify.status, predecessorVerify.stderr).toBe(0);
    expect(lstatSync(join(state.base, '.env')).mode & 0o777).toBe(0o600);

    const touched = runtimeMetadataPaths(state.base, state.target.runtime);
    const beforeFailure = metadata(touched);
    const failedTargetSeal = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_FAIL_AFTER_MUTATION: '1',
    });
    expect(failedTargetSeal.status).toBe(1);
    expect(failedTargetSeal.stderr).toContain(
      'injected post-mutation seal failure',
    );
    expect(metadata(touched)).toEqual(beforeFailure);
    expect(lstatSync(join(state.base, '.env')).mode & 0o777).toBe(0o600);

    const retainedPath = join(state.target.runtime, 'package.json');
    const retained = openSync(retainedPath, 'r+');
    const retainedEnvironmentPath = join(state.base, '.env');
    const retainedEnvironment = openSync(retainedEnvironmentPath, 'r+');
    const expectedTargetBody = readFileSync(retainedPath);
    const expectedEnvironmentBody = readFileSync(retainedEnvironmentPath);
    const targetSeal = state.execute('seal', state.target);
    expect(targetSeal.status, targetSeal.stderr).toBe(0);
    expect(JSON.parse(targetSeal.stdout)).toMatchObject({
      ok: true,
      sealed: true,
      verifierMode: 'strict',
    });
    expect(lstatSync(join(state.base, '.env')).mode & 0o777).toBe(0o440);
    expect(lstatSync(state.target.runtime).mode & 0o777).toBe(0o550);
    expect(lstatSync(join(state.target.runtime, 'package.json')).mode & 0o777)
      .toBe(0o440);
    writeSync(retained, Buffer.from('{"version":"attacker"}\n'), 0);
    closeSync(retained);
    writeSync(
      retainedEnvironment,
      Buffer.from('ATTACKER_RETAINED_FD=value\n'),
      0,
    );
    closeSync(retainedEnvironment);
    expect(readFileSync(retainedPath)).toEqual(expectedTargetBody);
    expect(readFileSync(retainedEnvironmentPath)).toEqual(
      expectedEnvironmentBody,
    );
    const targetVerify = state.execute('verify', state.target);
    expect(targetVerify.status, targetVerify.stderr).toBe(0);

    const legacyOutsideRecovery = state.execute('verify', state.predecessor);
    expect(legacyOutsideRecovery.status).toBe(1);
    expect(legacyOutsideRecovery.stderr).toContain(
      'allowed only during exact recovery',
    );
    writeJson(join(state.transactionRoot, 'state', 'journal.json'), {
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: state.transactionId,
      requestSha256: state.requestSha256,
      phase: 'recovering',
      status: 'running',
    });
    const legacyDuringRecovery = state.execute('verify', state.predecessor);
    expect(legacyDuringRecovery.status, legacyDuringRecovery.stderr).toBe(0);
    expect(JSON.parse(legacyDuringRecovery.stdout)).toMatchObject({
      ok: true,
      verifierMode: 'legacy',
    });

    writeJson(join(state.transactionRoot, 'state', 'journal.json'), {
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: state.transactionId,
      requestSha256: state.requestSha256,
      phase: 'recovered',
      status: 'recovered',
    });
    const terminalLegacy = state.execute('verify', state.predecessor);
    expect(terminalLegacy.status).toBe(1);
    expect(terminalLegacy.stderr).toContain(
      'terminal or its journal is invalid',
    );
  });

  it.each([
    'prepared',
    'frozen',
    'staged',
    'source_moved',
    'target_installed',
    'environment_moved',
    'environment_installed',
    'committed',
  ])('recovers an exact normalization transaction after SIGKILL at %s', (phase) => {
    const state = runtimeAuthorityFixture();
    const crashed = state.execute('seal', state.target, {
      NEXUS_V2_NORMALIZATION_TEST_CRASH_PHASE: phase,
    });
    expect(crashed.status).toBeNull();
    expect(crashed.signal).toBe('SIGKILL');
    expect(
      lstatSync(join(
        state.stateRoot,
        'v2-normalization-attestor-bridge',
        'normalization-journal.v1.json',
      )).mode & 0o777,
    ).toBe(0o600);

    const recovered = state.recover();
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      recovered: true,
      disposition: phase === 'committed' ? 'finished' : 'restored',
    });
    expect(() => lstatSync(join(
      state.stateRoot,
      'v2-normalization-attestor-bridge',
      'normalization-journal.v1.json',
    ))).toThrow();
    expect(readFileSync(join(state.target.runtime, 'package.json'), 'utf8'))
      .toBe('{"version":"4.14.231"}\n');
    expect(lstatSync(join(state.base, '.env')).mode & 0o777)
      .toBe(phase === 'committed' ? 0o440 : 0o600);
    expect(lstatSync(state.target.runtime).mode & 0o777)
      .toBe(phase === 'committed' ? 0o550 : 0o755);
  });

  it('keeps installation inactive, exact-e168 bound, and transactionally recoverable', () => {
    const syntax = spawnSync('bash', ['-n', INSTALLER], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    const installer = readFileSync(INSTALLER, 'utf8');
    expect(installer).toContain(
      'EXPECTED_CONTROL_SHA256="${NEXUS_V2_NORMALIZATION_EXPECTED_CONTROL_SHA256:-fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1}"',
    );
    expect(installer).toContain(
      'EXPECTED_REPLACED_ATTESTOR_SHA256="${NEXUS_V2_NORMALIZATION_EXPECTED_REPLACED_ATTESTOR_SHA256:-c337fb11211b0db1f18a19e31d7f6383a62b2842994725b3c2b2f24c8c5df96d}"',
    );
    expect(installer).toContain('trap install_failure_trap EXIT');
    expect(installer).toContain(
      'rollback_install post_mutation_validation_failed',
    );
    expect(lstatSync(INSTALLER).mode & 0o777).toBe(0o755);
    expect(installer).toContain('assert_idle');
    expect(installer).toContain('acquire_maintenance_locks');
    expect(installer).toContain('verify_open_lock 7 "$CONTROL_LOCK"');
    expect(installer).toContain('verify_open_lock 6 "$SONAR_LOCK"');
    expect(installer).toContain('write_maintenance_marker install');
    expect(installer).toContain('write_maintenance_marker restore');
    expect(installer).toContain('write_strict_restore_journal');
    expect(installer).toContain('strict_restore_checkpoint prepared');
    expect(installer).toContain('recover_strict_restore');
    expect(installer).toContain(
      'test mode may not cross a privileged uid boundary',
    );
    expect(readFileSync(BRIDGE, 'utf8')).toContain(
      'test mode may not cross a privileged uid boundary',
    );
    expect(installer).toContain(
      'promotion recovery unit state cannot be proved',
    );
    expect(installer).not.toMatch(
      /systemctl\s+(?:enable|start)|\/etc\/sudoers|pm2\s+(?:start|save)/u,
    );
    expect(installer).not.toContain('staging-authorization');
  });
});
