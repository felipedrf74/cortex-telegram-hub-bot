import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  assertHexSha256,
  canonicalJson,
  exactKeys,
  fail,
  sha256,
} from './release-canonical.mjs';

export const RELEASE_CONTROL_PLANE_INPUTS_PATH =
  'ops/nexus-release/release-control-plane-inputs.json';
export const RELEASE_CONTROL_PLANE_INPUTS_SCHEMA =
  'nexus.release-control-plane-inputs.v1';
export const RELEASE_CONTROL_PLANE_SCHEMA =
  'nexus.release-control-plane.v1';

const MAX_GOVERNED_FILE_BYTES = 4 * 1024 * 1024;
const NODE_VERSION = /^\d+\.\d+\.\d+$/;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;

function immutableTreeEntryType(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return fail('release control-plane tree contains an unsupported object');
}

function assertStableTreeEntry(before, after, label) {
  if (after.dev !== before.dev || after.ino !== before.ino
      || after.mode !== before.mode || after.uid !== before.uid
      || after.gid !== before.gid || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    fail(`release control-plane tree entry changed while inspected: ${label}`);
  }
}

// Keep this record format byte-for-byte aligned with the independent §1a
// finalization verifier in ops/nexus-release/README.md. The recorded digest
// file is the only excluded entry because it stores the digest itself.
export function computeImmutableControlPlaneTreeDigest(root = process.cwd(), {
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0
      || !Number.isSafeInteger(expectedGid) || expectedGid < 0) {
    return fail('release control-plane tree owner identity is invalid');
  }
  const normalizedRoot = path.resolve(root);
  const rootBefore = fs.lstatSync(normalizedRoot);
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    return fail('release control-plane tree root is not a directory');
  }
  const digest = createHash('sha256');
  const visit = (relative = '') => {
    const absolute = relative
      ? path.join(normalizedRoot, ...relative.split('/'))
      : normalizedRoot;
    const before = fs.lstatSync(absolute);
    const type = immutableTreeEntryType(before);
    if (before.uid !== expectedUid || before.gid !== expectedGid
        || (type !== 'symlink' && (before.mode & 0o222) !== 0)) {
      fail(`release control-plane tree entry is mutable or unowned: ${relative || '.'}`);
    }
    if (relative !== '.nexus-control-plane-tree.sha256') {
      let value = '';
      if (type === 'file') value = sha256(fs.readFileSync(absolute));
      else if (type === 'symlink') value = fs.readlinkSync(absolute);
      digest.update(`${JSON.stringify({
        path: relative || '.',
        type,
        mode: before.mode & 0o7777,
        value,
      })}\n`);
    }
    if (type === 'directory') {
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(relative ? `${relative}/${name}` : name);
      }
    }
    assertStableTreeEntry(before, fs.lstatSync(absolute), relative || '.');
  };
  visit();
  assertStableTreeEntry(rootBefore, fs.lstatSync(normalizedRoot), '.');
  return digest.digest('hex');
}

export function assertReleaseControlPlaneNativeRuntime(root = process.cwd(), {
  load = createRequire(path.join(path.resolve(root), 'package.json')),
} = {}) {
  const Database = load('better-sqlite3');
  const database = new Database(':memory:');
  try {
    database.prepare('SELECT 1').get();
  } finally {
    database.close();
  }
  return true;
}

function requireStringList(value, label, { packageNames = false } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    fail(`${label} must be a bounded non-empty array`);
  }
  const pattern = packageNames ? NPM_PACKAGE : null;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256
        || (pattern && !pattern.test(entry))) {
      fail(`${label} contains an unsafe value`);
    }
  }
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || canonicalJson(value) !== canonicalJson(sorted)) {
    fail(`${label} must be unique and sorted`);
  }
  return value;
}

function requireRelativeFile(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
      || value.startsWith('/') || value.includes('\\') || value.includes('\0')
      || path.posix.normalize(value) !== value || value === '..' || value.startsWith('../')) {
    fail(`${label} must be a normalized repository-relative path`);
  }
  return value;
}

function readRegularFile(root, relative, label) {
  requireRelativeFile(relative, label);
  const absolute = path.join(root, ...relative.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    fail(`${label} is missing: ${relative}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
      || stat.size > MAX_GOVERNED_FILE_BYTES) {
    fail(`${label} must be a bounded non-symbolic regular file: ${relative}`);
  }
  return { absolute, bytes: fs.readFileSync(absolute), executable: Boolean(stat.mode & 0o111) };
}

export function loadReleaseControlPlaneInputs(root = process.cwd()) {
  const normalizedRoot = path.resolve(root);
  const { bytes } = readRegularFile(
    normalizedRoot,
    RELEASE_CONTROL_PLANE_INPUTS_PATH,
    'release control-plane input descriptor',
  );
  let descriptor;
  try {
    descriptor = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('release control-plane input descriptor is not valid JSON');
  }
  exactKeys(descriptor, [
    'schema', 'nodeVersion', 'entrypoints', 'staticFiles', 'npmDependencies',
  ], 'release control-plane input descriptor');
  if (descriptor.schema !== RELEASE_CONTROL_PLANE_INPUTS_SCHEMA) {
    fail('release control-plane input descriptor schema is unsupported');
  }
  if (typeof descriptor.nodeVersion !== 'string' || !NODE_VERSION.test(descriptor.nodeVersion)) {
    fail('release control-plane Node version is invalid');
  }
  requireStringList(descriptor.entrypoints, 'release control-plane entrypoints');
  requireStringList(descriptor.staticFiles, 'release control-plane static files');
  requireStringList(descriptor.npmDependencies, 'release control-plane npm dependencies', {
    packageNames: true,
  });
  for (const [label, values] of [
    ['release control-plane entrypoint', descriptor.entrypoints],
    ['release control-plane static file', descriptor.staticFiles],
  ]) {
    for (const value of values) requireRelativeFile(value, label);
  }
  return descriptor;
}

function packageRoot(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function importSpecifiers(bytes) {
  const source = bytes.toString('utf8');
  const found = [];
  const staticImport = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      found.push(match[1]);
    }
  }
  return found;
}

function resolveLocalImport(root, fromRelative, specifier) {
  const fromDirectory = path.posix.dirname(fromRelative);
  const unresolved = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  const candidates = path.posix.extname(unresolved)
    ? [unresolved]
    : [`${unresolved}.mjs`, `${unresolved}.js`, `${unresolved}/index.mjs`, `${unresolved}/index.js`];
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(path.join(root, ...candidate.split('/')));
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {
      // Try the next governed module form.
    }
  }
  return fail(`release control-plane local import is missing: ${fromRelative} -> ${specifier}`);
}

function runtimeFileClosure(root, entrypoints) {
  const pending = [...entrypoints];
  const visited = new Set();
  const externalPackages = new Set();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    const { bytes } = readRegularFile(root, relative, 'release control-plane runtime file');
    visited.add(relative);
    if (!/\.(?:mjs|js)$/.test(relative)) continue;
    for (const specifier of importSpecifiers(bytes)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        pending.push(resolveLocalImport(root, relative, specifier));
        continue;
      }
      externalPackages.add(packageRoot(specifier));
    }
  }
  return {
    files: [...visited].sort(),
    externalPackages: [...externalPackages].sort(),
  };
}

function parentPackagePath(packagePath) {
  const marker = packagePath.lastIndexOf('/node_modules/');
  return marker === -1 ? '' : packagePath.slice(0, marker);
}

function resolveLockedPackage(packages, fromPackagePath, dependency) {
  let parent = fromPackagePath;
  for (;;) {
    const candidate = parent
      ? `${parent}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (parent === '') break;
    parent = parentPackagePath(parent);
  }
  return null;
}

function lockedDependencyClosure({ packageJson, packageLock, roots }) {
  if (!packageLock || packageLock.lockfileVersion !== 3
      || !packageLock.packages || typeof packageLock.packages !== 'object'
      || Array.isArray(packageLock.packages)) {
    fail('release control-plane requires package-lock v3 packages metadata');
  }
  const rootLock = packageLock.packages[''];
  if (!rootLock || typeof rootLock !== 'object' || Array.isArray(rootLock)) {
    fail('release control-plane package-lock root is missing');
  }
  const rootSpecs = {};
  const pending = [];
  for (const dependency of roots) {
    const packageSpec = packageJson.dependencies?.[dependency];
    const lockSpec = rootLock.dependencies?.[dependency];
    if (typeof packageSpec !== 'string' || lockSpec !== packageSpec) {
      fail(`release control-plane dependency spec drifted: ${dependency}`);
    }
    const packagePath = resolveLockedPackage(packageLock.packages, '', dependency);
    if (!packagePath) fail(`release control-plane dependency is absent from package-lock: ${dependency}`);
    rootSpecs[dependency] = packageSpec;
    pending.push(packagePath);
  }

  const locked = new Map();
  while (pending.length > 0) {
    const packagePath = pending.pop();
    if (locked.has(packagePath)) continue;
    const entry = packageLock.packages[packagePath];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.dev === true) {
      fail(`release control-plane dependency lock entry is unsafe: ${packagePath}`);
    }
    locked.set(packagePath, entry);
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies).sort()) {
      const resolved = resolveLockedPackage(packageLock.packages, packagePath, dependency);
      if (!resolved) {
        fail(`release control-plane transitive dependency is absent: ${packagePath} -> ${dependency}`);
      }
      pending.push(resolved);
    }
    for (const dependency of Object.keys(entry.peerDependencies ?? {}).sort()) {
      const optional = entry.peerDependenciesMeta?.[dependency]?.optional === true;
      const resolved = resolveLockedPackage(packageLock.packages, packagePath, dependency);
      if (!resolved && !optional) {
        fail(`release control-plane peer dependency is absent: ${packagePath} -> ${dependency}`);
      }
      if (resolved) pending.push(resolved);
    }
  }
  return {
    packageJson: {
      engines: packageJson.engines ?? null,
      dependencies: rootSpecs,
    },
    packageLock: {
      lockfileVersion: packageLock.lockfileVersion,
      packages: [...locked.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([packagePath, entry]) => ({ path: packagePath, entry })),
    },
  };
}

function parseGovernedJson(root, relative, label) {
  const { bytes } = readRegularFile(root, relative, label);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail(`${label} is not valid JSON`);
  }
}

export function releaseControlPlaneFingerprint(
  root = process.cwd(),
  { runtimeVersion = process.versions.node } = {},
) {
  const normalizedRoot = path.resolve(root);
  const descriptor = loadReleaseControlPlaneInputs(normalizedRoot);
  if (runtimeVersion !== descriptor.nodeVersion) {
    fail(
      `release control-plane runtime Node version ${runtimeVersion} does not match `
      + `the governed ${descriptor.nodeVersion}`,
    );
  }
  const closure = runtimeFileClosure(normalizedRoot, descriptor.entrypoints);
  if (canonicalJson(closure.externalPackages) !== canonicalJson(descriptor.npmDependencies)) {
    fail('release control-plane npm dependency declaration does not match runtime imports');
  }
  const allFiles = [...new Set([
    ...closure.files,
    ...descriptor.staticFiles,
  ])].sort();
  const files = allFiles.map((relative) => {
    const { bytes, executable } = readRegularFile(
      normalizedRoot,
      relative,
      'release control-plane governed file',
    );
    return { path: relative, executable, sha256: sha256(bytes) };
  });
  const dependencies = lockedDependencyClosure({
    packageJson: parseGovernedJson(normalizedRoot, 'package.json', 'package.json'),
    packageLock: parseGovernedJson(normalizedRoot, 'package-lock.json', 'package-lock.json'),
    roots: descriptor.npmDependencies,
  });
  return {
    schema: RELEASE_CONTROL_PLANE_SCHEMA,
    descriptor,
    files,
    dependencies,
  };
}

export function assertReleaseControlPlaneShape(value, label = 'release control plane') {
  const controlPlane = exactKeys(value, ['schema', 'digest'], label);
  if (controlPlane.schema !== RELEASE_CONTROL_PLANE_SCHEMA) {
    fail(`${label} schema is unsupported`);
  }
  assertHexSha256(controlPlane.digest, `${label} digest`);
  return controlPlane;
}

export function computeReleaseControlPlaneIdentity(root = process.cwd(), options = {}) {
  const fingerprint = releaseControlPlaneFingerprint(root, options);
  return assertReleaseControlPlaneShape({
    schema: RELEASE_CONTROL_PLANE_SCHEMA,
    digest: sha256(canonicalJson(fingerprint)),
  });
}
