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
  'ecosystem.release.config.js',
  'content-engine/main.py',
  'content-engine/config.py',
  'content-engine/requirements.txt',
  'content-engine/requirements-dev.txt',
  'content-engine/pyproject.toml',
  'scripts/release-artifact-manifest.mjs',
  'scripts/chat-capability-flag-operator.sh',
  'scripts/run-routing-synthetic-qa.mjs',
  'scripts/lib/chat-capability-flag-transaction.mjs',
  'scripts/lib/release-artifact-manifest.mjs',
  'scripts/lib/routing-synthetic-qa-manifest.mjs',
  'scripts/release-runtime-dependencies.mjs',
  'scripts/remote-chat-capability-flag-transaction.sh',
  'scripts/remote-user-release-transaction.sh',
  'scripts/routing-divergence-report.mjs',
  'scripts/staging-smoke-ollama.sh',
  'scripts/staging-smoke.sh',
  'scripts/training-cross-skill-staging-smoke.sh',
  'scripts/with-smoke-evidence.sh',
]);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
  if (relativePath.startsWith('dist/')
      && (relativePath.endsWith('.d.ts') || relativePath.endsWith('.d.ts.map'))) {
    return true;
  }
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

function addCapabilitySchemaReferenceFiles(root, files) {
  const manifestPath = path.join(root, 'config/capability-manifest.json');
  if (!fs.existsSync(manifestPath)) return;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read capability schema references: ${error.message}`);
  }

  const references = manifest?.schemaReferences;
  if (!references || typeof references !== 'object' || Array.isArray(references)) {
    throw new Error('capability manifest schema references are missing or invalid');
  }

  for (const [schemaId, reference] of Object.entries(references)) {
    const relativePath = reference?.path;
    if (!safeRelativePath(relativePath)) {
      throw new Error(`unsafe capability schema reference path: ${schemaId}/${relativePath}`);
    }
    const fullPath = path.resolve(root, relativePath);
    if (!fullPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`capability schema reference escapes release root: ${schemaId}/${relativePath}`);
    }

    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      throw new Error(`capability schema source is missing from release input: ${schemaId}/${relativePath}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`capability schema source is not a regular file: ${schemaId}/${relativePath}`);
    }
    files.add(relativePath);
  }
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

function staticRelativeEsmModuleSpecifiers(source, importer) {
  const parser = [
    "const fs = require('node:fs');",
    "const vm = require('node:vm');",
    'try {',
    '  const source = fs.readFileSync(0, \'utf8\');',
    `  const parsed = new vm.SourceTextModule(source, { identifier: ${JSON.stringify(importer)} });`,
    '  process.stdout.write(JSON.stringify(parsed.moduleRequests.map((request) => request.specifier)));',
    '} catch {',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  let parsed;
  try {
    parsed = JSON.parse(execFileSync(process.execPath, [
      '--no-warnings',
      '--experimental-vm-modules',
      '-e',
      parser,
    ], {
      input: source,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw new Error(`release runtime script cannot be parsed: ${importer}`);
  }
  const relative = new Set();
  for (const specifier of parsed) {
    if (/^\.\.?\//.test(specifier)) {
      relative.add(specifier);
      continue;
    }
    if (path.posix.isAbsolute(specifier)
        || (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) && !specifier.startsWith('node:'))) {
      throw new Error(`release runtime dependency is unsafe: ${importer} -> ${specifier}`);
    }
  }
  return [...relative];
}

function resolveRelativeRuntimeDependency(root, importer, specifier) {
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (!safeRelativePath(unresolved)) {
    throw new Error(`release runtime dependency escapes its root: ${importer} -> ${specifier}`);
  }
  const candidates = path.posix.extname(unresolved)
    ? [unresolved]
    : [
      unresolved,
      `${unresolved}.js`,
      `${unresolved}.mjs`,
      `${unresolved}.cjs`,
      `${unresolved}.json`,
      `${unresolved}/index.js`,
      `${unresolved}/index.mjs`,
      `${unresolved}/index.cjs`,
      `${unresolved}/index.json`,
    ];
  for (const candidate of candidates) {
    const fullPath = path.resolve(root, candidate);
    if (!fullPath.startsWith(`${root}${path.sep}`)) continue;
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`release runtime dependency is not a regular file: ${importer} -> ${specifier}`);
    }
    return candidate;
  }
  throw new Error(`release runtime dependency is missing: ${importer} -> ${specifier}`);
}

function validateReleaseScriptStaticEsmDependencyClosure(root, files) {
  for (const importer of files) {
    if (!/^scripts\/.*\.mjs$/.test(importer)) continue;
    const source = fs.readFileSync(path.join(root, importer), 'utf8');
    for (const specifier of staticRelativeEsmModuleSpecifiers(source, importer)) {
      const dependency = resolveRelativeRuntimeDependency(root, importer, specifier);
      if (!files.has(dependency)) {
        throw new Error(`release runtime dependency is not declared: ${importer} -> ${dependency}`);
      }
    }
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
  addCapabilitySchemaReferenceFiles(root, fileSet);
  for (const relativeDir of RELEASE_RUNTIME_ROOTS) {
    const fullPath = path.join(root, relativeDir);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      walkRuntime(root, fullPath, fileSet);
    }
  }
  validateReleaseScriptStaticEsmDependencyClosure(root, fileSet);
  const files = [...fileSet].sort(compareCodeUnits).map((relativePath) => {
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

function verifyDeclaredReleaseFiles(bundleRootInput, expectedRuntimeSha = '') {
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
    const bodySha256 = sha256(body);
    if (entry.size !== body.length || entry.sha256 !== bodySha256) {
      throw new Error(`release bundle artifact byte identity mismatch: ${relativePath}`);
    }
    return { path: relativePath, size: body.length, sha256: bodySha256 };
  });
  validateReleaseScriptStaticEsmDependencyClosure(bundleRoot, seen);
  if (canonicalJson(files) !== canonicalJson(
    [...files].sort((a, b) => compareCodeUnits(a.path, b.path)),
  )) {
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
  return {
    manifest: { ...declared, files },
    marker,
    digest,
    bundleRoot,
  };
}

export function verifyInstalledReleaseSource(releaseRootInput, expectedRuntimeSha = '') {
  return verifyDeclaredReleaseFiles(releaseRootInput, expectedRuntimeSha);
}

export function verifyReleaseBundle(bundleRootInput, expectedRuntimeSha = '') {
  const verified = verifyDeclaredReleaseFiles(bundleRootInput, expectedRuntimeSha);
  const {
    bundleRoot,
    digest,
    marker,
    manifest,
  } = verified;
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
  const expectedEntries = new Set([
    ...manifest.files.map((entry) => entry.path),
    'artifact-manifest.json',
    '.complete.json',
  ]);
  if (canonicalJson([...actualEntries].sort(compareCodeUnits))
      !== canonicalJson([...expectedEntries].sort(compareCodeUnits))) {
    throw new Error('release bundle contains undeclared or missing files');
  }
  return { manifest, marker, digest, bundleRoot };
}
