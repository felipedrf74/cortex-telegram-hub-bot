import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_ARTIFACT_SCHEMA = 'nexus.release-artifact-manifest.v1';

export const RELEASE_RUNTIME_ROOTS = Object.freeze([
  'dist',
  'catalog',
  'migrations',
  'prompts',
  'config',
  'content-engine/models',
  'content-engine/routers',
  'content-engine/searchers',
  'content-engine/services',
]);

export const RELEASE_RUNTIME_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'ecosystem.config.js',
  'ecosystem.staging.config.js',
  'ecosystem.release.config.js',
  'content-engine/main.py',
  'content-engine/config.py',
  'content-engine/requirements.txt',
  'content-engine/requirements-dev.txt',
  'content-engine/pyproject.toml',
  'scripts/release-installed-tree-attestation.mjs',
  'scripts/env-parity-check.sh',
  'scripts/lib/release-gates.sh',
  'scripts/promote-exact-release.sh',
  'scripts/remote-release-preflight.sh',
  'scripts/remote-release-readiness.sh',
  'scripts/release-operator.sh',
  'scripts/remote-create-release-backup.sh',
  'scripts/remote-prepare-release-backup.sh',
  'scripts/remote-start-sanitized-pm2.sh',
  'scripts/restore.sh',
  'scripts/rollback.sh',
]);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) delete env[key];
  return env;
}

function gitValue(root, commandArgs) {
  try {
    return execFileSync('git', commandArgs, {
      cwd: root,
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function shouldSkip(relativePath) {
  return [
    '/.venv',
    '/__pycache__/',
    '/.pytest_cache/',
    '/data/',
    '/tests/',
  ].some((needle) => `/${relativePath}`.includes(needle));
}

function safeRelativePath(relativePath) {
  return typeof relativePath === 'string'
    && relativePath.length > 0
    && relativePath === relativePath.split(path.sep).join('/')
    && !path.posix.isAbsolute(relativePath)
    && !relativePath.split('/').includes('..')
    && relativePath !== '.';
}

function walkRuntime(root, dir, files) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
    if (shouldSkip(relativePath)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`release artifact cannot contain a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) walkRuntime(root, fullPath, files);
    else if (entry.isFile()) files.add(relativePath);
    else throw new Error(`release artifact contains an unsupported entry: ${relativePath}`);
  }
}

export function releaseArtifactDigest(files) {
  const digestInput = JSON.stringify({
    schema: RELEASE_ARTIFACT_SCHEMA,
    files: files.map(({ path: filePath, size, sha256: fileSha }) => ({
      path: filePath,
      size,
      sha256: fileSha,
    })),
  });
  return sha256(Buffer.from(digestInput));
}

export function buildReleaseArtifactManifest(rootInput = process.cwd()) {
  const root = path.resolve(rootInput);
  const fileSet = new Set();
  for (const relativePath of RELEASE_RUNTIME_FILES) {
    const fullPath = path.join(root, relativePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) fileSet.add(relativePath);
  }
  for (const relativeDir of RELEASE_RUNTIME_ROOTS) {
    const fullPath = path.join(root, relativeDir);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      walkRuntime(root, fullPath, fileSet);
    }
  }
  const files = [...fileSet].sort().map((relativePath) => {
    if (!safeRelativePath(relativePath)) throw new Error(`unsafe release artifact path: ${relativePath}`);
    const content = fs.readFileSync(path.join(root, relativePath));
    return { path: relativePath, size: content.length, sha256: sha256(content) };
  });
  return {
    schema: RELEASE_ARTIFACT_SCHEMA,
    generatedAt: new Date().toISOString(),
    root,
    git: {
      sha: gitValue(root, ['rev-parse', 'HEAD']),
      shortSha: gitValue(root, ['rev-parse', '--short', 'HEAD']),
      branch: gitValue(root, ['branch', '--show-current']),
    },
    digest: releaseArtifactDigest(files),
    fileCount: files.length,
    files,
  };
}

export function verifyReleaseBundle(bundleRootInput, expectedRuntimeSha = '') {
  const bundleRoot = path.resolve(bundleRootInput);
  const manifestPath = path.join(bundleRoot, 'artifact-manifest.json');
  const markerPath = path.join(bundleRoot, '.complete.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(markerPath)) {
    throw new Error('release bundle manifest or completion marker is missing');
  }
  const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (declared.schema !== RELEASE_ARTIFACT_SCHEMA || !Array.isArray(declared.files)) {
    throw new Error('release bundle artifact manifest schema is invalid');
  }
  const seen = new Set();
  const files = declared.files.map((entry) => {
    const relativePath = entry?.path;
    if (!safeRelativePath(relativePath) || seen.has(relativePath)) {
      throw new Error(`release bundle artifact path is unsafe or duplicated: ${relativePath}`);
    }
    seen.add(relativePath);
    const fullPath = path.resolve(bundleRoot, relativePath);
    if (!fullPath.startsWith(`${bundleRoot}${path.sep}`)) {
      throw new Error(`release bundle artifact escapes its root: ${relativePath}`);
    }
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`release bundle artifact is not a regular file: ${relativePath}`);
    }
    const body = fs.readFileSync(fullPath);
    if (entry.size !== body.length || entry.sha256 !== sha256(body)) {
      throw new Error(`release bundle artifact byte identity mismatch: ${relativePath}`);
    }
    return { path: relativePath, size: body.length, sha256: sha256(body) };
  });
  if (canonicalJson(files) !== canonicalJson([...files].sort((a, b) => a.path.localeCompare(b.path)))) {
    throw new Error('release bundle artifact file list is not sorted');
  }
  const digest = releaseArtifactDigest(files);
  if (declared.digest !== digest || declared.fileCount !== files.length) {
    throw new Error('release bundle artifact digest or file count mismatch');
  }
  if (marker.schema !== 'nexus.release-bundle.v1'
      || marker.artifactDigest !== digest
      || marker.fileCount !== files.length
      || (expectedRuntimeSha && marker.runtimeSha !== expectedRuntimeSha)) {
    throw new Error('release bundle completion marker identity mismatch');
  }
  const actualEntries = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(bundleRoot, fullPath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`release bundle contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) actualEntries.add(relativePath);
      else throw new Error(`release bundle contains an unsupported entry: ${relativePath}`);
    }
  };
  walk(bundleRoot);
  const expectedEntries = new Set([...files.map((entry) => entry.path), 'artifact-manifest.json', '.complete.json']);
  if (canonicalJson([...actualEntries].sort()) !== canonicalJson([...expectedEntries].sort())) {
    throw new Error('release bundle contains undeclared or missing files');
  }
  return { manifest: { ...declared, files }, marker, digest, bundleRoot };
}
