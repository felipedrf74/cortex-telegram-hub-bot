#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_DEPENDENCY_SCHEMA = 'nexus.release-runtime-dependencies.v1';
const args = process.argv.slice(2);
const command = args[0] ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const root = path.resolve(valueOf('--root', process.cwd()));
const dependencyRoot = path.join(root, 'dist/runtime-dependencies');
const lockPath = path.join(dependencyRoot, 'lock.json');

function fail(message) {
  throw new Error(message);
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function regularFileIdentity(absolute, relative) {
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`runtime dependency is not a regular file: ${relative}`);
  const body = fs.readFileSync(absolute);
  return { path: relative, size: body.length, sha256: sha256(body) };
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function inputIdentity(relative) {
  return sha256(fs.readFileSync(path.join(root, relative)));
}

export function buildRuntimeDependencyLock(rootInput, target) {
  const resolvedRoot = path.resolve(rootInput);
  const deps = path.join(resolvedRoot, 'dist/runtime-dependencies');
  const nodeArchive = regularFileIdentity(
    path.join(deps, 'node_modules.tar.gz'),
    'dist/runtime-dependencies/node_modules.tar.gz',
  );
  const wheelRoot = path.join(deps, 'python-wheelhouse');
  const wheelNames = fs.readdirSync(wheelRoot).sort(compareCodeUnits);
  if (wheelNames.length === 0) fail('Python wheelhouse is empty');
  const wheels = wheelNames.map((name) => {
    if (!/^[A-Za-z0-9_.+-]+\.whl$/.test(name)) fail(`unsafe Python wheel filename: ${name}`);
    return regularFileIdentity(
      path.join(wheelRoot, name),
      `dist/runtime-dependencies/python-wheelhouse/${name}`,
    );
  });
  return {
    schema: RUNTIME_DEPENDENCY_SCHEMA,
    target,
    inputs: {
      packageLockSha256: sha256(fs.readFileSync(path.join(resolvedRoot, 'package-lock.json'))),
      pythonRequirementsSha256: sha256(fs.readFileSync(path.join(resolvedRoot, 'content-engine/requirements.txt'))),
    },
    nodeArchive,
    pythonWheels: wheels,
  };
}

export function validateRuntimeDependencyLock(lock, rootInput) {
  const resolvedRoot = path.resolve(rootInput);
  exactKeys(lock, ['schema', 'target', 'inputs', 'nodeArchive', 'pythonWheels'], 'runtime dependency lock');
  exactKeys(lock.target, ['os', 'osVersion', 'architecture', 'node', 'python'], 'runtime dependency target');
  exactKeys(lock.inputs, ['packageLockSha256', 'pythonRequirementsSha256'], 'runtime dependency inputs');
  if (lock.schema !== RUNTIME_DEPENDENCY_SCHEMA
      || lock.target.os !== 'ubuntu'
      || lock.target.osVersion !== '24.04'
      || lock.target.architecture !== 'x86_64'
      || lock.target.node !== 'v22.23.1'
      || !/^Python 3\.12\.\d+$/.test(lock.target.python ?? '')) {
    fail('runtime dependency target is outside release policy');
  }
  const expectedInputs = {
    packageLockSha256: sha256(fs.readFileSync(path.join(resolvedRoot, 'package-lock.json'))),
    pythonRequirementsSha256: sha256(fs.readFileSync(path.join(resolvedRoot, 'content-engine/requirements.txt'))),
  };
  if (canonicalJson(lock.inputs) !== canonicalJson(expectedInputs)) fail('runtime dependency input digest mismatch');
  const identities = [lock.nodeArchive, ...(lock.pythonWheels ?? [])];
  if (identities.length < 2) fail('runtime dependency lock has no Python wheels');
  const expectedNodePath = 'dist/runtime-dependencies/node_modules.tar.gz';
  if (lock.nodeArchive?.path !== expectedNodePath) fail('runtime dependency Node archive path is invalid');
  const seen = new Set();
  for (const identity of identities) {
    exactKeys(identity, ['path', 'size', 'sha256'], 'runtime dependency file identity');
    if (seen.has(identity.path)
        || (identity.path !== expectedNodePath
          && !/^dist\/runtime-dependencies\/python-wheelhouse\/[A-Za-z0-9_.+-]+\.whl$/.test(identity.path))) {
      fail(`runtime dependency path is unsafe or duplicated: ${identity.path}`);
    }
    seen.add(identity.path);
    const absolute = path.resolve(resolvedRoot, identity.path);
    if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) fail('runtime dependency path escapes release root');
    const observed = regularFileIdentity(absolute, identity.path);
    if (canonicalJson(observed) !== canonicalJson(identity)) fail(`runtime dependency digest mismatch: ${identity.path}`);
  }
  const sortedWheels = [...lock.pythonWheels]
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  if (canonicalJson(sortedWheels) !== canonicalJson(lock.pythonWheels)) fail('runtime dependency wheels are not sorted');
  return lock;
}

function writeLock() {
  const target = {
    os: valueOf('--os'),
    osVersion: valueOf('--os-version'),
    architecture: valueOf('--architecture'),
    node: valueOf('--node'),
    python: valueOf('--python'),
  };
  const lock = buildRuntimeDependencyLock(root, target);
  validateRuntimeDependencyLock(lock, root);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, lock: lockPath, digest: sha256(canonicalJson(lock)) })}\n`);
}

function loadAndVerify() {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  validateRuntimeDependencyLock(lock, root);
  return lock;
}

function assertNodeInstallPlatform(lock) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== lock.target.node) {
    fail('installed runtime Node platform does not match the dependency artifact');
  }
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="?24\.04"?$/m.test(osRelease)) {
    fail('installed runtime OS does not match Ubuntu 24.04');
  }
}

function assertInstallPlatform(lock, pythonBin) {
  assertNodeInstallPlatform(lock);
  const python = execFileSync(pythonBin, ['--version'], { encoding: 'utf8' }).trim();
  if (python !== lock.target.python) fail('installed runtime Python patch does not match the dependency artifact');
}

function lexicalPathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function extractNodeModules(lock, destinationRoot, pythonBin = 'python') {
  const nodeModules = path.join(destinationRoot, 'node_modules');
  if (lexicalPathExists(nodeModules)) {
    fail('network-independent Node extraction requires an absent dependency tree');
  }
  const archive = path.join(destinationRoot, lock.nodeArchive.path);
  const extractionProgram = String.raw`
import pathlib, posixpath, sys, tarfile
archive, destination = sys.argv[1:]
with tarfile.open(archive, mode='r:gz') as handle:
    for member in handle.getmembers():
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'node_modules':
            raise SystemExit('unsafe node archive member')
        if member.isdev() or member.isfifo():
            raise SystemExit('unsupported node archive member')
        if member.issym() or member.islnk():
            target = pathlib.PurePosixPath(member.linkname)
            if target.is_absolute():
                raise SystemExit('absolute node archive link')
            resolved = pathlib.PurePosixPath(posixpath.normpath(str(name.parent / target)))
            if '..' in resolved.parts or not resolved.parts or resolved.parts[0] != 'node_modules':
                raise SystemExit('escaping node archive link')
    handle.extractall(destination, filter='data')
`;
  execFileSync(pythonBin, ['-c', extractionProgram, archive, destinationRoot], { stdio: 'inherit' });
  if (!fs.statSync(nodeModules).isDirectory()) fail('Node dependency archive did not create node_modules');
}

function extractNode() {
  const lock = loadAndVerify();
  assertNodeInstallPlatform(lock);
  extractNodeModules(lock, root);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: 'nexus.network-independent-node-extraction.v1',
    dependencyLockDigest: sha256(canonicalJson(lock)),
  })}\n`);
}

function install() {
  const lock = loadAndVerify();
  const pythonBin = valueOf('--python-bin', '/usr/bin/python3.12');
  assertInstallPlatform(lock, pythonBin);
  const nodeModules = path.join(root, 'node_modules');
  const venv = path.join(root, 'content-engine/.venv');
  if (lexicalPathExists(nodeModules) || lexicalPathExists(venv)) {
    fail('network-independent install requires absent dependency trees');
  }
  extractNodeModules(lock, root, pythonBin);
  execFileSync(pythonBin, ['-m', 'venv', venv], { stdio: 'inherit' });
  const pip = path.join(venv, 'bin/pip');
  const wheelhouse = path.join(root, 'dist/runtime-dependencies/python-wheelhouse');
  const pipArgs = [
    'install', '--no-index', '--only-binary=:all:', '--no-cache-dir',
    `--find-links=${wheelhouse}`, '-r', path.join(root, 'content-engine/requirements.txt'),
  ];
  const result = spawnSync(pip, pipArgs, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PIP_CONFIG_FILE: '/dev/null',
      PIP_NO_INDEX: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    },
  });
  if (result.status !== 0) fail(`offline Python dependency install failed: ${result.status ?? 'signal'}`);
  execFileSync(pip, ['check'], { cwd: root, stdio: 'inherit', env: { ...process.env, PIP_NO_INDEX: '1' } });
  const evidence = {
    schema: 'nexus.network-independent-install.v1',
    status: 'passed',
    dependencyLockDigest: sha256(canonicalJson(lock)),
    packageLockSha256: inputIdentity('package-lock.json'),
    pythonRequirementsSha256: inputIdentity('content-engine/requirements.txt'),
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, '.network-independent-install.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (command === 'write-lock') writeLock();
  else if (command === 'verify') {
    const lock = loadAndVerify();
    process.stdout.write(`${JSON.stringify({ ok: true, digest: sha256(canonicalJson(lock)) })}\n`);
  } else if (command === 'extract-node') extractNode();
  else if (command === 'install') install();
  else fail('Usage: release-runtime-dependencies.mjs <write-lock|verify|extract-node|install> --root <release>');
}
