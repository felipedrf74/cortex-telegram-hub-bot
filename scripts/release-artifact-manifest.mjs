#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

const root = path.resolve(readArg('--root', process.cwd()));
const output = readArg('--format', args.includes('--digest') ? 'digest' : 'json');
const writePath = readArg('--write', '');

const runtimeRoots = [
  'dist',
  'catalog',
  'migrations',
  'prompts',
  'config',
  'content-engine/models',
  'content-engine/routers',
  'content-engine/searchers',
  'content-engine/services',
];

const runtimeFiles = [
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
];

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
  ]) {
    delete env[key];
  }
  return env;
}

function gitValue(commandArgs) {
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

function walk(dir, files) {
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
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile()) {
      files.add(relativePath);
    }
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const fileSet = new Set();
for (const relativePath of runtimeFiles) {
  const fullPath = path.join(root, relativePath);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    fileSet.add(relativePath);
  }
}
for (const relativeDir of runtimeRoots) {
  const fullPath = path.join(root, relativeDir);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    walk(fullPath, fileSet);
  }
}

const files = [...fileSet].sort().map((relativePath) => {
  const fullPath = path.join(root, relativePath);
  const content = fs.readFileSync(fullPath);
  return {
    path: relativePath,
    size: content.length,
    sha256: sha256(content),
  };
});

const digestInput = JSON.stringify({
  schema: 'nexus.release-artifact-manifest.v1',
  files: files.map(({ path: filePath, size, sha256: fileSha }) => ({
    path: filePath,
    size,
    sha256: fileSha,
  })),
});

const manifest = {
  schema: 'nexus.release-artifact-manifest.v1',
  generatedAt: new Date().toISOString(),
  root,
  git: {
    sha: gitValue(['rev-parse', 'HEAD']),
    shortSha: gitValue(['rev-parse', '--short', 'HEAD']),
    branch: gitValue(['branch', '--show-current']),
  },
  digest: sha256(Buffer.from(digestInput)),
  fileCount: files.length,
  files,
};

const body = output === 'digest' ? `${manifest.digest}\n` : `${JSON.stringify(manifest, null, 2)}\n`;
if (writePath) {
  fs.mkdirSync(path.dirname(path.resolve(writePath)), { recursive: true });
  fs.writeFileSync(path.resolve(writePath), body);
} else {
  process.stdout.write(body);
}
