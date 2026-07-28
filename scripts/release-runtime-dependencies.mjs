#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_DEPENDENCY_SCHEMA = 'nexus.release-runtime-dependencies.v2';
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
  const pythonArchive = regularFileIdentity(
    path.join(deps, 'python-site-packages.tar.gz'),
    'dist/runtime-dependencies/python-site-packages.tar.gz',
  );
  return {
    schema: RUNTIME_DEPENDENCY_SCHEMA,
    target,
    inputs: {
      packageLockSha256: sha256(fs.readFileSync(path.join(resolvedRoot, 'package-lock.json'))),
      pythonRequirementsSha256: sha256(fs.readFileSync(path.join(resolvedRoot, 'content-engine/requirements.txt'))),
    },
    nodeArchive,
    pythonArchive,
  };
}

export function validateRuntimeDependencyLock(lock, rootInput) {
  const resolvedRoot = path.resolve(rootInput);
  exactKeys(
    lock,
    ['schema', 'target', 'inputs', 'nodeArchive', 'pythonArchive'],
    'runtime dependency lock',
  );
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
  const expectedNodePath = 'dist/runtime-dependencies/node_modules.tar.gz';
  const expectedPythonPath = 'dist/runtime-dependencies/python-site-packages.tar.gz';
  if (lock.nodeArchive?.path !== expectedNodePath) fail('runtime dependency Node archive path is invalid');
  if (lock.pythonArchive?.path !== expectedPythonPath) {
    fail('runtime dependency Python archive path is invalid');
  }
  const identities = [lock.nodeArchive, lock.pythonArchive];
  const seen = new Set();
  for (const identity of identities) {
    exactKeys(identity, ['path', 'size', 'sha256'], 'runtime dependency file identity');
    if (seen.has(identity.path)
        || ![expectedNodePath, expectedPythonPath].includes(identity.path)) {
      fail(`runtime dependency path is unsafe or duplicated: ${identity.path}`);
    }
    seen.add(identity.path);
    const absolute = path.resolve(resolvedRoot, identity.path);
    if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) fail('runtime dependency path escapes release root');
    const observed = regularFileIdentity(absolute, identity.path);
    if (canonicalJson(observed) !== canonicalJson(identity)) fail(`runtime dependency digest mismatch: ${identity.path}`);
  }
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

function assertRuntimePlatform(lock, pythonBin) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== lock.target.node) {
    fail('runtime Node platform does not match the dependency artifact');
  }
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="?24\.04"?$/m.test(osRelease)) {
    fail('runtime OS does not match Ubuntu 24.04');
  }
  const python = execFileSync(pythonBin, ['--version'], { encoding: 'utf8' }).trim();
  if (python !== lock.target.python) fail('runtime Python patch does not match the dependency artifact');
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

export function expandedRuntimeTreeIdentity(rootInput) {
  const resolvedRoot = path.resolve(rootInput);
  const entries = [];
  const visit = (absolute) => {
    const stat = fs.lstatSync(absolute);
    const relative = path.relative(resolvedRoot, absolute).split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      if (path.isAbsolute(target)) fail(`expanded runtime contains an absolute link: ${relative}`);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        fail(`expanded runtime link escapes its root: ${relative}`);
      }
      try {
        fs.statSync(absolute);
      } catch {
        fail(`expanded runtime contains a dangling link: ${relative}`);
      }
      entries.push({ path: relative, type: 'symlink', target });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 });
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name));
      return;
    }
    if (!stat.isFile()) fail(`expanded runtime contains an unsupported entry: ${relative}`);
    entries.push({
      path: relative,
      type: 'file',
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: sha256(fs.readFileSync(absolute)),
    });
  };
  for (const relative of ['node_modules', 'content-engine/vendor']) {
    const absolute = path.join(resolvedRoot, relative);
    if (!fs.lstatSync(absolute).isDirectory()) {
      fail(`expanded runtime dependency root is invalid: ${relative}`);
    }
    visit(absolute);
  }
  return {
    entries: entries.length,
    files: entries.filter((entry) => entry.type === 'file').length,
    links: entries.filter((entry) => entry.type === 'symlink').length,
    sha256: sha256(canonicalJson(entries)),
  };
}

export function extractRuntimeArchive(
  archive,
  destinationRoot,
  expectedPrefix,
  pythonBin = 'python3',
) {
  const extractionTarget = path.join(destinationRoot, expectedPrefix);
  if (lexicalPathExists(extractionTarget)) {
    fail(`runtime extraction requires an absent target: ${expectedPrefix}`);
  }
  const extractionProgram = String.raw`
import pathlib, posixpath, sys, tarfile
archive, destination, expected_prefix = sys.argv[1:]
prefix = pathlib.PurePosixPath(expected_prefix)
with tarfile.open(archive, mode='r:gz') as handle:
    for member in handle.getmembers():
        name = pathlib.PurePosixPath(member.name)
        if (name.is_absolute() or '..' in name.parts or not name.parts
                or name.parts[:len(prefix.parts)] != prefix.parts):
            raise SystemExit('unsafe runtime archive member')
        if member.isdev() or member.isfifo():
            raise SystemExit('unsupported runtime archive member')
        if member.issym() or member.islnk():
            target = pathlib.PurePosixPath(member.linkname)
            if target.is_absolute():
                raise SystemExit('absolute runtime archive link')
            resolved = pathlib.PurePosixPath(posixpath.normpath(str(name.parent / target)))
            if ('..' in resolved.parts or not resolved.parts
                    or resolved.parts[:len(prefix.parts)] != prefix.parts):
                raise SystemExit('escaping runtime archive link')
    handle.extractall(destination, filter='data')
`;
  execFileSync(
    pythonBin,
    ['-c', extractionProgram, archive, destinationRoot, expectedPrefix],
    { stdio: 'inherit' },
  );
  if (!fs.statSync(extractionTarget).isDirectory()) {
    fail(`runtime archive did not create ${expectedPrefix}`);
  }
}

export function extractRuntimeDependencies(
  lock,
  destinationRoot,
  pythonBin = '/usr/bin/python3.12',
) {
  assertRuntimePlatform(lock, pythonBin);
  extractRuntimeArchive(
    path.join(destinationRoot, lock.nodeArchive.path),
    destinationRoot,
    'node_modules',
    pythonBin,
  );
  extractRuntimeArchive(
    path.join(destinationRoot, lock.pythonArchive.path),
    destinationRoot,
    'content-engine/vendor',
    pythonBin,
  );
}

function extractRuntime() {
  const lock = loadAndVerify();
  const pythonBin = valueOf('--python-bin', '/usr/bin/python3.12');
  extractRuntimeDependencies(lock, root, pythonBin);
  const expandedTree = expandedRuntimeTreeIdentity(root);
  const evidence = {
    schema: 'nexus.network-independent-runtime-extraction.v1',
    status: 'passed',
    dependencyLockDigest: sha256(canonicalJson(lock)),
    packageLockSha256: inputIdentity('package-lock.json'),
    pythonRequirementsSha256: inputIdentity('content-engine/requirements.txt'),
    expandedTree,
    extractedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(root, '.network-independent-extraction.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

function verifyExtractedRuntime() {
  const lock = loadAndVerify();
  const pythonBin = valueOf('--python-bin', '/usr/bin/python3.12');
  assertRuntimePlatform(lock, pythonBin);
  const receiptPath = path.join(root, '.network-independent-extraction.json');
  const receiptStat = fs.lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 64 * 1024) {
    fail('expanded runtime receipt is unsafe');
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  exactKeys(
    receipt,
    [
      'schema', 'status', 'dependencyLockDigest', 'packageLockSha256',
      'pythonRequirementsSha256', 'expandedTree', 'extractedAt',
    ],
    'expanded runtime receipt',
  );
  if (receipt.schema !== 'nexus.network-independent-runtime-extraction.v1'
      || receipt.status !== 'passed'
      || receipt.dependencyLockDigest !== sha256(canonicalJson(lock))
      || receipt.packageLockSha256 !== inputIdentity('package-lock.json')
      || receipt.pythonRequirementsSha256 !== inputIdentity('content-engine/requirements.txt')
      || !Number.isFinite(Date.parse(receipt.extractedAt ?? ''))
      || canonicalJson(receipt.expandedTree) !== canonicalJson(expandedRuntimeTreeIdentity(root))) {
    fail('expanded runtime receipt does not match the extracted dependency tree');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: receipt.schema,
    expandedTree: receipt.expandedTree,
  })}\n`);
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (command === 'write-lock') writeLock();
  else if (command === 'verify') {
    const lock = loadAndVerify();
    process.stdout.write(`${JSON.stringify({ ok: true, digest: sha256(canonicalJson(lock)) })}\n`);
  } else if (command === 'extract-runtime') extractRuntime();
  else if (command === 'verify-extracted') verifyExtractedRuntime();
  else fail('Usage: release-runtime-dependencies.mjs <write-lock|verify|extract-runtime|verify-extracted> --root <release>');
}
