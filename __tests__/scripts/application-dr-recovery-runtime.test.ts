import { execFileSync, spawnSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const archiveHelper = path.resolve('scripts/application-dr-recovery-archive.py');
const runtimeHelper = path.resolve('scripts/application-dr-recovery-runtime.mjs');
const recoveryIdentityHelper = path.resolve('scripts/release-recovery-runtime-identity.mjs');
const installedIdentityHelper = path.resolve('scripts/release-installed-tree-attestation.mjs');
const python = process.env.NEXUS_TEST_PYTHON ?? 'python3';
const runtimeSha = 'a'.repeat(40);
const packageVersion = '4.14.231';
const currentKeyId = 'github-environment-release-signing-2026-07';
const temporaryRoots: string[] = [];

type CommandResult = ReturnType<typeof spawnSync<string>>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function privateRoot(prefix: string) {
  const created = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(created, 0o700);
  temporaryRoots.push(created);
  return created;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function runPython(args: string[]): CommandResult {
  return spawnSync(python, args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

function policyPreload(base: string) {
  const preload = path.join(base, 'linux-node22-policy.cjs');
  fs.writeFileSync(preload, [
    "Object.defineProperty(process, 'platform', {",
    "  value: 'linux', configurable: true, enumerable: true,",
    '});',
    "Object.defineProperty(process, 'arch', {",
    "  value: 'x64', configurable: true, enumerable: true,",
    '});',
    "Object.defineProperty(process, 'version', {",
    "  value: 'v22.23.1', configurable: true, enumerable: true,",
    '});',
    "if (process.env.NEXUS_TEST_FAKE_ROOT === '1') {",
    "  Object.defineProperty(process, 'getuid', {",
    '    value: () => 0, configurable: true, enumerable: true,',
    '  });',
    '}',
    '',
  ].join('\n'));
  return preload;
}

function runPolicyNode(
  preload: string,
  script: string,
  args: string[],
  inheritedOutput?: number,
): CommandResult {
  const rootTestFlag = typeof process.getuid === 'function' && process.getuid() === 0
    ? ['--allow-test-root']
    : [];
  return spawnSync(process.execPath, [script, ...args, ...rootTestFlag], {
    encoding: 'utf8',
    stdio: inheritedOutput === undefined
      ? ['ignore', 'pipe', 'pipe']
      : ['ignore', 'pipe', 'pipe', inheritedOutput],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_OPTIONS: `--require=${preload}`,
    },
  });
}

function expectPassed(result: CommandResult) {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

function buildOfflinePayload(base: string) {
  const payload = path.join(base, 'offline-payload');
  fs.mkdirSync(payload, { mode: 0o700 });
  const nodeArchive = path.join(payload, 'node_modules.tar.gz');
  const wheel = path.join(payload, 'demo_pkg-1.0.0-py3-none-any.whl');
  execFileSync(
    python,
    [
      '-c',
      String.raw`
import gzip, io, sys, tarfile
output = sys.argv[1]
with open(output, "xb") as raw:
    with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for name in ("node_modules", "node_modules/pkg"):
                info = tarfile.TarInfo(name)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.mtime = 0
                archive.addfile(info)
            body = b"module.exports = 1;\n"
            info = tarfile.TarInfo("node_modules/pkg/index.js")
            info.size = len(body)
            info.mode = 0o644
            info.mtime = 0
            archive.addfile(info, io.BytesIO(body))
`,
      nodeArchive,
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  execFileSync(
    python,
    [
      '-c',
      String.raw`
import sys, zipfile
output = sys.argv[1]
metadata = b"Metadata-Version: 2.1\nName: demo-pkg\nVersion: 1.0.0\n\n"
wheel = b"Wheel-Version: 1.0\nGenerator: nexus-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
record = (
    "demo_pkg/__init__.py,,\n"
    "demo_pkg-1.0.0.dist-info/METADATA,,\n"
    "demo_pkg-1.0.0.dist-info/WHEEL,,\n"
    "demo_pkg-1.0.0.dist-info/RECORD,,\n"
    "../../../bin/demo-cli,,\n"
).encode()
entries = [
    ("demo_pkg/__init__.py", b"VALUE = 1\n"),
    ("demo_pkg-1.0.0.dist-info/METADATA", metadata),
    ("demo_pkg-1.0.0.dist-info/WHEEL", wheel),
    ("demo_pkg-1.0.0.dist-info/RECORD", record),
]
with zipfile.ZipFile(output, mode="x", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, body in entries:
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o600 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, body)
`,
      wheel,
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  fs.chmodSync(nodeArchive, 0o600);
  fs.chmodSync(wheel, 0o600);
  return { nodeArchive, wheel };
}

function fileIdentity(root: string, relative: string) {
  const body = fs.readFileSync(path.join(root, relative));
  return { path: relative, size: body.length, sha256: sha256(body) };
}

function materializeArtifactRoot(
  base: string,
  name: string,
  payload: ReturnType<typeof buildOfflinePayload>,
) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'content-engine'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/runtime-dependencies/python-wheelhouse'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: '@nexushub/core',
    version: packageVersion,
  })}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'content-engine/requirements.txt'), 'demo-pkg==1.0.0\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = "nexus";\n');
  fs.copyFileSync(
    payload.nodeArchive,
    path.join(root, 'dist/runtime-dependencies/node_modules.tar.gz'),
  );
  fs.copyFileSync(
    payload.wheel,
    path.join(
      root,
      'dist/runtime-dependencies/python-wheelhouse/demo_pkg-1.0.0-py3-none-any.whl',
    ),
  );
  const lock = {
    schema: 'nexus.release-runtime-dependencies.v1',
    target: {
      os: 'ubuntu',
      osVersion: '24.04',
      architecture: 'x86_64',
      node: 'v22.23.1',
      python: 'Python 3.12.3',
    },
    inputs: {
      packageLockSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
      pythonRequirementsSha256: sha256(
        fs.readFileSync(path.join(root, 'content-engine/requirements.txt')),
      ),
    },
    nodeArchive: fileIdentity(
      root,
      'dist/runtime-dependencies/node_modules.tar.gz',
    ),
    pythonWheels: [
      fileIdentity(
        root,
        'dist/runtime-dependencies/python-wheelhouse/'
        + 'demo_pkg-1.0.0-py3-none-any.whl',
      ),
    ],
  };
  fs.writeFileSync(
    path.join(root, 'dist/runtime-dependencies/lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(root, '.network-independent-install.json'), `${JSON.stringify({
    schema: 'nexus.network-independent-install.v1',
    status: 'passed',
    dependencyLockDigest: sha256(canonicalJson(lock)),
    packageLockSha256: lock.inputs.packageLockSha256,
    pythonRequirementsSha256: lock.inputs.pythonRequirementsSha256,
    installedAt: '2026-07-22T00:00:00.000Z',
  }, null, 2)}\n`);
  return root;
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function installOfflineDependencies(root: string) {
  execFileSync(
    python,
    [
      '-c',
      'import sys,tarfile; '
      + "t=tarfile.open(sys.argv[1],mode='r:gz'); "
      + "t.extractall(sys.argv[2],filter='data'); t.close()",
      path.join(root, 'dist/runtime-dependencies/node_modules.tar.gz'),
      root,
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  const sitePackages = path.join(
    root,
    'content-engine/.venv/lib/python3.12/site-packages',
  );
  const bin = path.join(root, 'content-engine/.venv/bin');
  fs.mkdirSync(sitePackages, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  execFileSync(
    python,
    [
      '-c',
      'import sys,zipfile; '
      + 'z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); z.close()',
      path.join(
        root,
        'dist/runtime-dependencies/python-wheelhouse/'
        + 'demo_pkg-1.0.0-py3-none-any.whl',
      ),
      sitePackages,
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  const delegatedPython = shellSingleQuote(python);
  const wrapper = [
    '#!/bin/sh',
    'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
    '  echo "Python 3.12.3"',
    '  exit 0',
    'fi',
    `exec ${delegatedPython} "$@"`,
    '',
  ].join('\n');
  const pythonWrapper = path.join(bin, 'python3.12');
  fs.writeFileSync(pythonWrapper, wrapper);
  fs.chmodSync(pythonWrapper, 0o755);
  const consoleScript = [
    '#!/bin/sh',
    `exec ${shellSingleQuote(pythonWrapper)} -m demo_pkg "$@"`,
    '',
  ].join('\n');
  const console = path.join(bin, 'demo-cli');
  fs.writeFileSync(console, consoleScript);
  fs.chmodSync(console, 0o755);
}

function computeRecovery(preload: string, root: string, artifactDigest: string) {
  return runPolicyNode(preload, recoveryIdentityHelper, [
    'compute',
    '--root', root,
    '--runtime-sha', runtimeSha,
    '--artifact-digest', artifactDigest,
  ]);
}

function writeArtifactManifest(root: string) {
  const artifactPaths = [
    '.network-independent-install.json',
    'app.js',
    'content-engine/requirements.txt',
    'dist/runtime-dependencies/lock.json',
    'dist/runtime-dependencies/node_modules.tar.gz',
    'dist/runtime-dependencies/python-wheelhouse/demo_pkg-1.0.0-py3-none-any.whl',
    'package-lock.json',
    'package.json',
  ];
  const files = artifactPaths.map((relative) => fileIdentity(root, relative));
  const schema = 'nexus.release-artifact-manifest.v1';
  const digest = sha256(JSON.stringify({ schema, files }));
  fs.writeFileSync(path.join(root, 'artifact-manifest.json'), `${JSON.stringify({
    schema,
    git: { sha: runtimeSha },
    files,
    fileCount: files.length,
    digest,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.complete.json'), `${JSON.stringify({
    schema: 'nexus.release-bundle.v1',
    runtimeSha,
    artifactDigest: digest,
    fileCount: files.length,
  }, null, 2)}\n`);
  return { digest, files };
}

function signedEnvelope(
  schema: string,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
) {
  return {
    schema,
    keyId: currentKeyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString('base64'),
  };
}

function prepareSignedFixture() {
  const base = privateRoot('nexus-recovery-runtime-');
  const preload = policyPreload(base);
  const payload = buildOfflinePayload(base);
  const root = materializeArtifactRoot(base, 'source-runtime', payload);
  installOfflineDependencies(root);
  const artifact = writeArtifactManifest(root);
  const installedResult = runPolicyNode(preload, installedIdentityHelper, [
    'write',
    '--root', root,
    '--runtime-sha', runtimeSha,
    '--artifact-digest', artifact.digest,
  ]);
  const installed = expectPassed(installedResult);
  const recovery = expectPassed(computeRecovery(preload, root, artifact.digest));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(base, 'release-public.pem');
  fs.writeFileSync(
    publicKeyPath,
    publicKey.export({ format: 'pem', type: 'spki' }),
  );
  const manifestPath = path.join(base, 'release-manifest.json');
  const manifest = signedEnvelope(
    'nexus.release-manifest.v2',
    {
      runtimeSha,
      packageVersion,
      artifact: {
        digest: artifact.digest,
        fileCount: artifact.files.length,
        files: artifact.files,
      },
    },
    privateKey,
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const stagingPath = path.join(base, 'staging-attestation.json');
  const staging = signedEnvelope(
    'nexus.staging-attestation.v1',
    {
      runtimeSha,
      artifactDigest: artifact.digest,
      installedRuntimeDigest: installed.aggregateDigest,
      recoveryRuntimeDigest: recovery.aggregateDigest,
      releaseManifestSha256: sha256(fs.readFileSync(manifestPath)),
    },
    privateKey,
  );
  fs.writeFileSync(stagingPath, `${JSON.stringify(staging, null, 2)}\n`);
  const descriptorPath = path.join(base, 'descriptor.json');
  const descriptorFd = fs.openSync(descriptorPath, 'wx', 0o600);
  let prepare: CommandResult;
  try {
    prepare = runPolicyNode(preload, runtimeHelper, [
      'prepare',
      '--root', root,
      '--manifest', manifestPath,
      '--staging-attestation', stagingPath,
      '--public-key', publicKeyPath,
      '--recovery-identity-helper', recoveryIdentityHelper,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', artifact.digest,
      '--installed-runtime-digest', installed.aggregateDigest,
      '--recovery-runtime-digest', recovery.aggregateDigest,
      '--output-fd', '3',
    ], descriptorFd);
  } finally {
    fs.closeSync(descriptorFd);
  }
  expectPassed(prepare);
  return {
    base,
    preload,
    root,
    artifact,
    installed,
    recovery,
    privateKey,
    publicKeyPath,
    manifest,
    manifestPath,
    staging,
    stagingPath,
    descriptorPath,
  };
}

function runtimeArguments(
  fixture: ReturnType<typeof prepareSignedFixture>,
  output: string,
  overrides: { manifest?: string; staging?: string; publicKey?: string } = {},
) {
  return [
    'prepare',
    '--root', fixture.root,
    '--manifest', overrides.manifest ?? fixture.manifestPath,
    '--staging-attestation', overrides.staging ?? fixture.stagingPath,
    '--public-key', overrides.publicKey ?? fixture.publicKeyPath,
    '--recovery-identity-helper', recoveryIdentityHelper,
    '--runtime-sha', runtimeSha,
    '--artifact-digest', fixture.artifact.digest,
    '--installed-runtime-digest', fixture.installed.aggregateDigest,
    '--recovery-runtime-digest', fixture.recovery.aggregateDigest,
    '--output', output,
  ];
}

function makeHostileArchive(base: string, kind: string) {
  const output = path.join(base, `${kind}.tar.gz`);
  execFileSync(
    python,
    [
      '-c',
      String.raw`
import gzip, io, sys, tarfile
kind, output = sys.argv[1:]
if kind == "oversize-member":
    info = tarfile.TarInfo("oversize")
    info.size = 1024 * 1024 * 1024 + 1
    with gzip.open(output, "wb") as stream:
        stream.write(info.tobuf())
        stream.write(b"\0" * 1024)
    raise SystemExit(0)
with tarfile.open(output, mode="w:gz") as archive:
    if kind == "traversal":
        info = tarfile.TarInfo("../escape")
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
    elif kind == "duplicate":
        for body in (b"a", b"b"):
            info = tarfile.TarInfo("duplicate")
            info.size = 1
            archive.addfile(info, io.BytesIO(body))
    else:
        info = tarfile.TarInfo(kind)
        if kind == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = "target"
        elif kind == "hardlink":
            info.type = tarfile.LNKTYPE
            info.linkname = "target"
        elif kind == "device":
            info.type = tarfile.CHRTYPE
            info.devmajor = 1
            info.devminor = 3
        archive.addfile(info)
`,
      kind,
      output,
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  fs.chmodSync(output, 0o600);
  return output;
}

describe('relocatable recovery runtime identity', () => {
  it('produces one semantic digest from two absolute offline install roots', () => {
    const base = privateRoot('nexus-recovery-relocatable-');
    const preload = policyPreload(base);
    const payload = buildOfflinePayload(base);
    const first = materializeArtifactRoot(base, 'first-install', payload);
    const second = materializeArtifactRoot(base, 'second-install', payload);
    installOfflineDependencies(first);
    installOfflineDependencies(second);
    const artifactDigest = 'b'.repeat(64);

    const firstIdentity = expectPassed(computeRecovery(preload, first, artifactDigest));
    const secondIdentity = expectPassed(computeRecovery(preload, second, artifactDigest));

    expect(firstIdentity.aggregateDigest).toBe(secondIdentity.aggregateDigest);
    expect(firstIdentity.identity.python.distributions).toEqual(
      secondIdentity.identity.python.distributions,
    );
  });

  it('rejects untracked Node and Python dependency files', () => {
    const base = privateRoot('nexus-recovery-untracked-');
    const preload = policyPreload(base);
    const payload = buildOfflinePayload(base);
    const root = materializeArtifactRoot(base, 'runtime', payload);
    installOfflineDependencies(root);
    const artifactDigest = 'b'.repeat(64);

    fs.writeFileSync(path.join(root, 'node_modules/untracked.js'), 'unexpected\n');
    const nodeDrift = computeRecovery(preload, root, artifactDigest);
    expect(nodeDrift.status).not.toBe(0);
    expect(`${nodeDrift.stdout}${nodeDrift.stderr}`).toContain(
      'does not match the locked offline archive',
    );
    fs.unlinkSync(path.join(root, 'node_modules/untracked.js'));

    fs.writeFileSync(
      path.join(root, 'content-engine/.venv/lib/python3.12/site-packages/untracked.py'),
      'unexpected = True\n',
    );
    const pythonDrift = computeRecovery(preload, root, artifactDigest);
    expect(pythonDrift.status).not.toBe(0);
    expect(`${pythonDrift.stdout}${pythonDrift.stderr}`).toContain(
      'untracked installed Python environment file',
    );
  });
});

describe('signed application recovery descriptor', () => {
  it('round-trips the exact artifact and verifies it after an offline reinstall', () => {
    const fixture = prepareSignedFixture();
    const archive = path.join(fixture.base, 'current-runtime.tar.gz');
    const packed = runPython([
      archiveHelper,
      'pack',
      '--root', fixture.root,
      '--descriptor', fixture.descriptorPath,
      '--manifest', fixture.manifestPath,
      '--staging-attestation', fixture.stagingPath,
      '--output', archive,
    ]);
    expectPassed(packed);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    const inspected = runPython([archiveHelper, 'inspect', '--archive', archive]);
    expectPassed(inspected);

    const extracted = path.join(fixture.base, 'extracted');
    fs.mkdirSync(extracted, { mode: 0o700 });
    fs.chmodSync(extracted, 0o700);
    const extraction = runPython([
      archiveHelper,
      'extract',
      '--archive', archive,
      '--destination', extracted,
    ]);
    expectPassed(extraction);
    installOfflineDependencies(extracted);
    const verify = runPolicyNode(fixture.preload, runtimeHelper, [
      'verify',
      '--root', extracted,
      '--descriptor', path.join(extracted, '.nexus-recovery/descriptor.json'),
      '--manifest', path.join(extracted, '.nexus-recovery/release-manifest.json'),
      '--staging-attestation',
      path.join(extracted, '.nexus-recovery/staging-attestation.json'),
      '--public-key', fixture.publicKeyPath,
      '--recovery-identity-helper', recoveryIdentityHelper,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', fixture.artifact.digest,
      '--installed-runtime-digest', fixture.installed.aggregateDigest,
      '--recovery-runtime-digest', fixture.recovery.aggregateDigest,
    ]);
    expectPassed(verify);
  });

  it('rejects signed-evidence, public-key, and evidence-path tampering', () => {
    const fixture = prepareSignedFixture();
    const tamperedManifestPath = path.join(fixture.base, 'tampered-manifest.json');
    const tamperedManifest = structuredClone(fixture.manifest);
    tamperedManifest.signature = Buffer.alloc(64).toString('base64');
    fs.writeFileSync(tamperedManifestPath, JSON.stringify(tamperedManifest));
    const signatureResult = runPolicyNode(
      fixture.preload,
      runtimeHelper,
      runtimeArguments(
        fixture,
        path.join(fixture.base, 'tampered-descriptor.json'),
        { manifest: tamperedManifestPath },
      ),
    );
    expect(signatureResult.status).not.toBe(0);
    expect(`${signatureResult.stdout}${signatureResult.stderr}`).toContain(
      'release manifest signature is invalid',
    );

    const attacker = generateKeyPairSync('ed25519');
    const attackerPublic = path.join(fixture.base, 'attacker-public.pem');
    fs.writeFileSync(
      attackerPublic,
      attacker.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const keyResult = runPolicyNode(
      fixture.preload,
      runtimeHelper,
      runtimeArguments(
        fixture,
        path.join(fixture.base, 'wrong-key-descriptor.json'),
        { publicKey: attackerPublic },
      ),
    );
    expect(keyResult.status).not.toBe(0);
    expect(`${keyResult.stdout}${keyResult.stderr}`).toContain(
      'release manifest signature is invalid',
    );

    const linkedManifest = path.join(fixture.base, 'linked-manifest.json');
    fs.symlinkSync(fixture.manifestPath, linkedManifest);
    const pathResult = runPolicyNode(
      fixture.preload,
      runtimeHelper,
      runtimeArguments(
        fixture,
        path.join(fixture.base, 'linked-descriptor.json'),
        { manifest: linkedManifest },
      ),
    );
    expect(pathResult.status).not.toBe(0);
    expect(`${pathResult.stdout}${pathResult.stderr}`).toContain(
      'signed release manifest must be a bounded non-symlink regular file',
    );
  });

  it('rejects root execution unless both test mode and its dedicated flag are present', () => {
    const fixture = prepareSignedFixture();
    const fakeRoot = (
      output: string,
      nodeEnv: string,
      extraArgs: string[] = [],
    ) => spawnSync(
      process.execPath,
      [
        runtimeHelper,
        ...runtimeArguments(fixture, output),
        ...extraArgs,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: nodeEnv,
          NEXUS_TEST_FAKE_ROOT: '1',
          NODE_OPTIONS: `--require=${fixture.preload}`,
        },
      },
    );
    const noFlag = fakeRoot(path.join(fixture.base, 'root-no-flag.json'), 'test');
    expect(noFlag.status).not.toBe(0);
    expect(`${noFlag.stdout}${noFlag.stderr}`).toContain(
      'must run as an unprivileged user',
    );

    const productionFlag = fakeRoot(
      path.join(fixture.base, 'root-production-flag.json'),
      'production',
      ['--allow-test-root'],
    );
    expect(productionFlag.status).not.toBe(0);
    expect(`${productionFlag.stdout}${productionFlag.stderr}`).toContain(
      'must run as an unprivileged user',
    );

    const testOnly = fakeRoot(
      path.join(fixture.base, 'root-test-only.json'),
      'test',
      ['--allow-test-root'],
    );
    expectPassed(testOnly);
  });
});

describe('bounded recovery archive parser', () => {
  it.each([
    ['traversal', 'unsafe recovery runtime path'],
    ['symlink', 'unsupported recovery runtime archive member'],
    ['hardlink', 'unsupported recovery runtime archive member'],
    ['device', 'unsupported recovery runtime archive member'],
    ['duplicate', 'duplicate recovery runtime archive member'],
    ['oversize-member', 'archive member exceeds the size limit'],
  ])('rejects a %s archive before extraction', (kind, message) => {
    const base = privateRoot(`nexus-recovery-${kind}-`);
    const archive = makeHostileArchive(base, kind);
    const result = runPython([archiveHelper, 'inspect', '--archive', archive]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(fs.existsSync(path.join(base, 'escape'))).toBe(false);
  });

  it('rejects control characters and oversized descriptor entries', () => {
    const fixture = prepareSignedFixture();
    const descriptor = JSON.parse(fs.readFileSync(fixture.descriptorPath, 'utf8'));
    descriptor.entries[0].path = 'bad\npath';
    const controlDescriptor = path.join(fixture.base, 'control-descriptor.json');
    fs.writeFileSync(controlDescriptor, JSON.stringify(descriptor), { mode: 0o600 });
    fs.chmodSync(controlDescriptor, 0o600);
    const control = runPython([
      archiveHelper,
      'pack',
      '--root', fixture.root,
      '--descriptor', controlDescriptor,
      '--manifest', fixture.manifestPath,
      '--staging-attestation', fixture.stagingPath,
      '--output', path.join(fixture.base, 'control.tar.gz'),
    ]);
    expect(control.status).not.toBe(0);
    expect(`${control.stdout}${control.stderr}`).toContain('unsafe path');

    const oversized = JSON.parse(fs.readFileSync(fixture.descriptorPath, 'utf8'));
    oversized.entries[0].size = 1024 * 1024 * 1024 + 1;
    const oversizedDescriptor = path.join(fixture.base, 'oversized-descriptor.json');
    fs.writeFileSync(oversizedDescriptor, JSON.stringify(oversized), { mode: 0o600 });
    fs.chmodSync(oversizedDescriptor, 0o600);
    const oversizedResult = runPython([
      archiveHelper,
      'pack',
      '--root', fixture.root,
      '--descriptor', oversizedDescriptor,
      '--manifest', fixture.manifestPath,
      '--staging-attestation', fixture.stagingPath,
      '--output', path.join(fixture.base, 'oversized.tar.gz'),
    ]);
    expect(oversizedResult.status).not.toBe(0);
    expect(`${oversizedResult.stdout}${oversizedResult.stderr}`).toContain(
      'invalid recovery runtime file declaration',
    );
  });

  it('rejects an oversized compressed archive before opening its tar inventory', () => {
    const base = privateRoot('nexus-recovery-oversized-archive-');
    const archive = path.join(base, 'oversized.tar.gz');
    const descriptor = fs.openSync(archive, 'wx', 0o600);
    try {
      fs.ftruncateSync(descriptor, 2 * 1024 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(archive, 0o600);
    const result = runPython([archiveHelper, 'inspect', '--archive', archive]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'recovery runtime archive exceeds the bounded size limit',
    );
    expect(fs.readFileSync(archiveHelper, 'utf8')).not.toContain('.getmembers()');
  });
});
