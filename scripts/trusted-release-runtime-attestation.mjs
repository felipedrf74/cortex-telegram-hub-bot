#!/usr/bin/env node
// Root-installed verifier for a finalized production runtime. This file uses
// only Node built-ins and never executes candidate bytes, so a candidate
// cannot replace or run code that authorizes its own execution.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() || '';
const value = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
};
const root = path.resolve(value('--root'));
const base = path.resolve(value('--base'));
const expectedRuntimeSha = value('--runtime-sha');
const expectedArtifactDigest = value('--artifact-digest');
const expectedInstalledDigest = value('--installed-runtime-digest');
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function canonicalJson(input) {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} is not a canonical non-symlink directory`);
  }
}

function safeRelative(relative) {
  return typeof relative === 'string'
    && relative.length > 0
    && relative.length <= 4096
    && !path.posix.isAbsolute(relative)
    && !relative.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(relative)
    && path.posix.normalize(relative) === relative
    && relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function regularFile(relative, label = relative) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return absolute;
}

function readJson(relative) {
  const file = regularFile(relative);
  const stat = fs.statSync(file);
  if (stat.size > 16 * 1024 * 1024) throw new Error(`${relative} is unreasonably large`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fileDigest(relative) {
  return sha256(fs.readFileSync(regularFile(relative)));
}

function assertSafeDependencySymlink(relative, absolute) {
  const resolved = fs.realpathSync(absolute);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return;
  // A venv created with the locked Ubuntu Python may link its interpreter
  // launchers to the root-owned system binary. No other dependency symlink may
  // escape the sealed runtime.
  if (/^content-engine\/\.venv\/bin\/python(?:3|3\.12)?$/u.test(relative)
      && resolved === '/usr/bin/python3.12') return;
  throw new Error(`installed dependency symlink escapes the runtime: ${relative}`);
}

function treeIdentity(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`installed dependency tree is unsafe: ${relativeRoot}`);
  }
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(absoluteRoot, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isSymbolicLink()) {
        assertSafeDependencySymlink(`${relativeRoot}/${relative}`, absolute);
        entries.push({ path: relative, type: 'symlink', target: fs.readlinkSync(absolute) });
      }
      else if (stat.isFile()) {
        const body = fs.readFileSync(absolute);
        entries.push({
          path: relative,
          type: 'file',
          size: body.length,
          executable: Boolean(stat.mode & 0o111),
          sha256: sha256(body),
        });
      } else throw new Error(`unsupported installed dependency entry: ${relativeRoot}/${relative}`);
    }
  };
  walk(absoluteRoot);
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    path: relativeRoot,
    digest: sha256(canonicalJson(entries)),
    entryCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
  };
}

function networkIdentity() {
  const evidenceBytes = fs.readFileSync(regularFile('.network-independent-install.json'));
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const lock = readJson('dist/runtime-dependencies/lock.json');
  const dependencyLockDigest = sha256(canonicalJson(lock));
  if (evidence.schema !== 'nexus.network-independent-install.v1' || evidence.status !== 'passed'
      || evidence.dependencyLockDigest !== dependencyLockDigest
      || evidence.packageLockSha256 !== fileDigest('package-lock.json')
      || evidence.pythonRequirementsSha256 !== fileDigest('content-engine/requirements.txt')
      || lock.target?.node !== process.version
      || !/^Python 3\.12\.\d+$/u.test(lock.target?.python ?? '')) {
    throw new Error('network-independent install evidence is invalid');
  }
  return {
    identity: {
      schema: evidence.schema,
      status: evidence.status,
      dependencyLockDigest,
      evidenceSha256: sha256(evidenceBytes),
    },
    node: lock.target.node,
    python: lock.target.python,
  };
}

function installedIdentity() {
  const packageJson = readJson('package.json');
  const networkIndependentInstall = networkIdentity();
  return {
    schema: 'nexus.installed-runtime-identity.v1',
    runtimeSha: expectedRuntimeSha,
    artifactDigest: expectedArtifactDigest,
    packageVersion: packageJson.version,
    inputs: {
      packageLockSha256: fileDigest('package-lock.json'),
      requirementsSha256: fileDigest('content-engine/requirements.txt'),
      node: networkIndependentInstall.node,
      python: networkIndependentInstall.python,
    },
    networkIndependentInstall: networkIndependentInstall.identity,
    trees: [treeIdentity('node_modules'), treeIdentity('content-engine/.venv')],
  };
}

function assertSealedPermissions(groupId) {
  const anchors = [
    [base, 0o1770, 'production base'],
    [path.join(base, 'releases'), 0o750, 'production releases directory'],
    [root, 0o550, 'release root'],
  ];
  for (const [absolute, expectedMode, label] of anchors) {
    const stat = fs.lstatSync(absolute);
    if (stat.uid !== 0 || stat.gid !== groupId || (stat.mode & 0o7777) !== expectedMode) {
      throw new Error(`${label} ownership or immutable mode is invalid`);
    }
  }
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.uid !== 0 || stat.gid !== groupId) throw new Error(`sealed runtime ownership mismatch: ${relative}`);
      if (stat.isDirectory()) {
        if ((stat.mode & 0o7777) !== 0o550) throw new Error(`sealed runtime directory is writable: ${relative}`);
        walk(absolute);
      } else if (stat.isSymbolicLink()) {
        // Symlink permissions are not portable; ownership and the separately
        // verified target are the immutable contract.
      } else if (stat.isFile()) {
        const mode = stat.mode & 0o7777;
        if (mode !== 0o440 && mode !== 0o550) throw new Error(`sealed runtime file mode is invalid: ${relative}`);
      } else throw new Error(`unsupported sealed runtime entry: ${relative}`);
    }
  };
  walk(root);
}

function verify(requireSealed = false, groupId = null) {
  if (!SHA.test(expectedRuntimeSha) || !DIGEST.test(expectedArtifactDigest)
      || !DIGEST.test(expectedInstalledDigest)) throw new Error('expected runtime identity is invalid');
  assertCanonicalDirectory(base, 'production base');
  assertCanonicalDirectory(path.join(base, 'releases'), 'production releases directory');
  assertCanonicalDirectory(root, 'release root');
  if (!root.startsWith(`${base}${path.sep}releases${path.sep}`)) throw new Error('release root is outside production releases');

  const artifact = readJson('artifact-manifest.json');
  const marker = readJson('.complete.json');
  if (artifact.schema !== 'nexus.release-artifact-manifest.v1' || !Array.isArray(artifact.files)) {
    throw new Error('artifact manifest schema is invalid');
  }
  const files = [];
  const declared = new Set();
  let previous = null;
  for (const entry of artifact.files) {
    if (!safeRelative(entry?.path) || declared.has(entry.path) || (previous !== null && previous >= entry.path)
        || !Number.isSafeInteger(entry?.size) || entry.size < 0 || !DIGEST.test(entry?.sha256 ?? '')) {
      throw new Error(`unsafe artifact declaration: ${String(entry?.path)}`);
    }
    previous = entry.path;
    declared.add(entry.path);
    const body = fs.readFileSync(regularFile(entry.path, `artifact ${entry.path}`));
    const observed = sha256(body);
    if (body.length !== entry.size || observed !== entry.sha256) throw new Error(`artifact byte mismatch: ${entry.path}`);
    files.push({ path: entry.path, size: body.length, sha256: observed });
  }
  const aggregate = sha256(Buffer.from(JSON.stringify({ schema: artifact.schema, files })));
  if (artifact.digest !== aggregate || artifact.fileCount !== files.length || aggregate !== expectedArtifactDigest
      || artifact.git?.sha !== expectedRuntimeSha || marker.schema !== 'nexus.release-bundle.v1'
      || marker.runtimeSha !== expectedRuntimeSha || marker.artifactDigest !== expectedArtifactDigest
      || marker.fileCount !== files.length) throw new Error('artifact aggregate identity mismatch');

  const installed = readJson('.nexus-installed-runtime.json');
  const current = installedIdentity();
  const installedAggregate = sha256(canonicalJson(current));
  if (installed.schema !== 'nexus.installed-runtime-attestation.v1'
      || canonicalJson(installed.identity) !== canonicalJson(current)
      || installed.aggregateDigest !== installedAggregate || installedAggregate !== expectedInstalledDigest) {
    throw new Error('installed runtime identity mismatch');
  }

  const known = new Set([
    ...declared,
    'artifact-manifest.json',
    '.complete.json',
    '.network-independent-install.json',
    '.nexus-installed-runtime.json',
    '.nexus-release-readiness-staging.json',
    '.nexus-release-readiness-production.json',
  ]);
  const expectedLinks = new Map([
    ['.env', path.join(base, '.env')],
    ['data', path.join(base, 'data')],
    ['logs', path.join(base, 'logs')],
  ]);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isSymbolicLink()) {
        if (expectedLinks.has(relative)) {
          if (fs.readlinkSync(absolute) !== expectedLinks.get(relative)) throw new Error(`runtime link target mismatch: ${relative}`);
        } else if (relative.startsWith('node_modules/') || relative.startsWith('content-engine/.venv/')) {
          assertSafeDependencySymlink(relative, absolute);
        } else throw new Error(`undeclared runtime symlink: ${relative}`);
      } else if (stat.isFile()) {
        if (!known.has(relative) && !relative.startsWith('node_modules/')
            && !relative.startsWith('content-engine/.venv/')) throw new Error(`undeclared runtime file: ${relative}`);
      } else throw new Error(`unsupported runtime entry: ${relative}`);
    }
  };
  walk(root);
  if (requireSealed) assertSealedPermissions(groupId);
  return { runtimeSha: expectedRuntimeSha, artifactDigest: aggregate, installedRuntimeDigest: installedAggregate };
}

function seal() {
  const groupId = Number(value('--group-id'));
  if (!Number.isSafeInteger(groupId) || groupId < 0) throw new Error('invalid application group id');
  // Protect the release entry against rename/replacement before inspecting
  // app-owned candidate bytes. Sticky group-write on the base keeps the
  // worker's atomic `current` switch legal without allowing it to replace the
  // root-owned releases directory.
  fs.chownSync(base, 0, groupId);
  fs.chmodSync(base, 0o1770);
  fs.chownSync(path.join(base, 'releases'), 0, groupId);
  fs.chmodSync(path.join(base, 'releases'), 0o750);
  verify();
  const entries = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(absolute);
      entries.push(absolute);
    }
  };
  collect(root);
  for (const absolute of entries) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fs.lchownSync(absolute, 0, groupId);
    else {
      fs.chownSync(absolute, 0, groupId);
      fs.chmodSync(absolute, stat.isDirectory() ? 0o550 : ((stat.mode & 0o111) ? 0o550 : 0o440));
    }
  }
  fs.chownSync(root, 0, groupId);
  fs.chmodSync(root, 0o550);
  return verify(true, groupId);
}

try {
  const verifyGroupId = command === 'verify' ? Number(value('--group-id')) : null;
  if (command === 'verify' && (!Number.isSafeInteger(verifyGroupId) || verifyGroupId < 0)) {
    throw new Error('invalid application group id');
  }
  const result = command === 'verify' ? verify(true, verifyGroupId) : command === 'seal' ? seal() : null;
  if (!result) throw new Error('Usage: trusted-release-runtime-attestation.mjs <verify|seal> --root <release> --base <base> --runtime-sha <sha> --artifact-digest <sha256> --installed-runtime-digest <sha256> --group-id <gid>');
  process.stdout.write(`${JSON.stringify({ ok: true, sealed: command === 'seal', ...result })}\n`);
} catch (error) {
  process.stderr.write(`trusted_release_runtime_attestation_failed:${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
