#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UV_VERSION = '0.10.9';
export const PYTHON_RELEASE_PLATFORM = 'x86_64-manylinux_2_36';
export const PYTHON_RELEASE_EXCLUDE_NEWER = '2026-08-10T00:00:00Z';
export const PYTHON_RELEASE_INDEX = 'https://pypi.org/simple';
const RESOLUTION_ENVIRONMENT = Object.freeze([
  'PIP_CONFIG_FILE',
  'PIP_CONSTRAINT',
  'PIP_EXTRA_INDEX_URL',
  'PIP_FIND_LINKS',
  'PIP_INDEX_URL',
  'PIP_NO_BINARY',
  'PIP_NO_INDEX',
  'PIP_ONLY_BINARY',
  'PIP_PRE',
  'PIP_REQUIREMENT',
  'UV_BUILD_CONSTRAINT',
  'UV_CONFIG_FILE',
  'UV_CONSTRAINT',
  'UV_DEFAULT_INDEX',
  'UV_EXCLUDE_NEWER',
  'UV_EXCLUDE_NEWER_PACKAGE',
  'UV_EXTRA_INDEX_URL',
  'UV_FIND_LINKS',
  'UV_FORK_STRATEGY',
  'UV_INDEX',
  'UV_INDEX_STRATEGY',
  'UV_INDEX_URL',
  'UV_NO_BINARY',
  'UV_NO_INDEX',
  'UV_NO_SOURCES',
  'UV_ONLY_BINARY',
  'UV_OVERRIDE',
  'UV_PRERELEASE',
  'UV_PYTHON',
  'UV_RESOLUTION',
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_LOCK = Object.freeze({
  label: 'Python release lock',
  sourceRelativePath: 'content-engine/requirements.txt',
  outputRelativePath: 'content-engine/requirements-release.txt',
});
const AUDIT_TOOL_LOCK = Object.freeze({
  label: 'Python audit-tool lock',
  sourceRelativePath: 'content-engine/requirements-audit-tool.in',
  outputRelativePath: 'content-engine/requirements-audit-tool.txt',
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyCommittedPythonLock(spec) {
  const sourcePath = path.join(root, spec.sourceRelativePath);
  const outputPath = path.join(root, spec.outputRelativePath);
  const sourceStat = fs.lstatSync(sourcePath);
  const outputStat = fs.lstatSync(outputPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
      || !outputStat.isFile() || outputStat.isSymbolicLink()
      || sourceStat.size > 64 * 1024 || outputStat.size > 2 * 1024 * 1024) {
    throw new Error(`${spec.label} source or output is unsafe`);
  }
  const sourceBytes = fs.readFileSync(sourcePath);
  const output = fs.readFileSync(outputPath, 'utf8');
  const sourceDigest = sha256(sourceBytes);
  for (const header of [
    `# generator: uv ${UV_VERSION}`,
    `# source: ${spec.sourceRelativePath}`,
    `# source-sha256: ${sourceDigest}`,
    '# target: CPython 3.12 on x86_64 glibc 2.36 or newer',
    `# index: ${PYTHON_RELEASE_INDEX}`,
    '# resolution: highest; prerelease: disallow; fork-strategy: requires-python',
    `# exclude-newer: ${PYTHON_RELEASE_EXCLUDE_NEWER}`,
  ]) {
    if (!output.includes(`${header}\n`)) {
      throw new Error(`${spec.label} is missing governed metadata: ${header}`);
    }
  }
  const sourceRequirements = sourceBytes.toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const blocks = output
    .split(/(?=^[a-z0-9_.-]+==)/gim)
    .filter((block) => /^[a-z0-9_.-]+==/i.test(block));
  const locked = new Map();
  for (const block of blocks) {
    const match = block.match(/^([a-z0-9_.-]+)==([^\\\s]+)/i);
    if (!match || !/--hash=sha256:[a-f0-9]{64}/.test(block)) {
      throw new Error(`${spec.label} contains a non-exact or unhashed requirement`);
    }
    const name = match[1].toLowerCase();
    if (locked.has(name)) throw new Error(`${spec.label} duplicates ${name}`);
    locked.set(name, match[2]);
  }
  const requirementLines = output
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (/(?:git\+|https?:\/\/|--(?:extra-)?index-url)/i.test(requirementLines)) {
    throw new Error(`${spec.label} contains a non-governed package source`);
  }
  for (const requirement of sourceRequirements) {
    const match = requirement.match(/^([a-z0-9_.-]+)(?:\[[^\]]+\])?==([^\s]+)$/i);
    if (!match) throw new Error(`${spec.label} source requirement is not exact: ${requirement}`);
    if (locked.get(match[1].toLowerCase()) !== match[2]) {
      throw new Error(`${spec.label} does not contain the exact direct pin: ${requirement}`);
    }
  }
  if (locked.size <= sourceRequirements.length) {
    throw new Error(`${spec.label} does not contain a resolved transitive closure`);
  }
  return { outputPath, sourceDigest, packageCount: locked.size };
}

export function verifyCommittedPythonLocks() {
  return {
    release: verifyCommittedPythonLock(RELEASE_LOCK),
    auditTool: verifyCommittedPythonLock(AUDIT_TOOL_LOCK),
  };
}

export function assertHermeticUvEnvironment(environment = process.env) {
  const forbidden = RESOLUTION_ENVIRONMENT
    .filter((key) => Object.hasOwn(environment, key))
    .sort();
  if (forbidden.length > 0) {
    throw new Error(`release lock generation refuses ambient package policy: ${forbidden.join(', ')}`);
  }
}

function runUv(args, options = {}) {
  const result = spawnSync('uv', args, {
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => !key.startsWith('UV_') && !key.startsWith('PIP_')),
    ),
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout).trim()}` : '';
    throw new Error(`uv ${args[0]} failed with status ${result.status}${detail}`);
  }
  return result.stdout?.trim() ?? '';
}

function generatePythonLock(spec, { check = false } = {}) {
  assertHermeticUvEnvironment();
  const installedVersion = runUv(['--version'], { capture: true });
  if (installedVersion !== `uv ${UV_VERSION}`
      && !installedVersion.startsWith(`uv ${UV_VERSION} `)) {
    throw new Error(`expected uv ${UV_VERSION}, received ${installedVersion || 'no version'}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-python-release-lock-'));
  const sourcePath = path.join(root, spec.sourceRelativePath);
  const outputPath = path.join(root, spec.outputRelativePath);
  const generatedPath = path.join(temporaryRoot, path.basename(spec.outputRelativePath));
  const publicationStage = `${outputPath}.next-${process.pid}`;
  try {
    runUv([
      '--no-config', '--no-cache', '--quiet',
      'pip', 'compile', spec.sourceRelativePath,
      '--output-file', generatedPath,
      '--python-version', '3.12',
      '--python-platform', PYTHON_RELEASE_PLATFORM,
      '--only-binary=:all:',
      '--generate-hashes',
      '--no-annotate',
      '--default-index', PYTHON_RELEASE_INDEX,
      '--index-strategy', 'first-index',
      '--resolution', 'highest',
      '--prerelease', 'disallow',
      '--fork-strategy', 'requires-python',
      '--no-sources',
      '--exclude-newer', PYTHON_RELEASE_EXCLUDE_NEWER,
      '--upgrade',
    ]);

    const generated = fs.readFileSync(generatedPath, 'utf8');
    const firstRequirement = generated.search(/^[a-z0-9_.-]+==/im);
    if (firstRequirement === -1) throw new Error('uv did not produce an exact requirements lock');
    const sourceDigest = sha256(fs.readFileSync(sourcePath));
    const header = [
      '# This file is generated by scripts/generate-python-release-lock.mjs.',
      `# generator: uv ${UV_VERSION}`,
      `# source: ${spec.sourceRelativePath}`,
      `# source-sha256: ${sourceDigest}`,
      '# target: CPython 3.12 on x86_64 glibc 2.36 or newer',
      `# index: ${PYTHON_RELEASE_INDEX}`,
      '# resolution: highest; prerelease: disallow; fork-strategy: requires-python',
      `# exclude-newer: ${PYTHON_RELEASE_EXCLUDE_NEWER}`,
      '',
    ].join('\n');
    const bytes = `${header}${generated.slice(firstRequirement)}`;
    if (check) {
      const current = fs.readFileSync(outputPath, 'utf8');
      if (current !== bytes) {
        throw new Error(`${spec.label} drift: run node scripts/generate-python-release-lock.mjs`);
      }
      return {
        checked: true,
        outputPath,
        sourceDigest,
        packageCount: bytes.match(/^[a-z0-9_.-]+==/gim)?.length ?? 0,
      };
    }
    const file = fs.openSync(publicationStage, 'wx', 0o644);
    try {
      fs.writeFileSync(file, bytes);
      fs.fsyncSync(file);
    } finally {
      fs.closeSync(file);
    }
    fs.renameSync(publicationStage, outputPath);
    const directory = fs.openSync(path.dirname(outputPath), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    return { outputPath, sourceDigest, packageCount: bytes.match(/^[a-z0-9_.-]+==/gim)?.length ?? 0 };
  } finally {
    if (fs.existsSync(publicationStage)) fs.unlinkSync(publicationStage);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function generatePythonReleaseLock(options = {}) {
  return generatePythonLock(RELEASE_LOCK, options);
}

export function generatePythonAuditToolLock(options = {}) {
  return generatePythonLock(AUDIT_TOOL_LOCK, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  const supportedArgs = new Set(['--check', '--verify-committed']);
  if (cliArgs.some((arg) => !supportedArgs.has(arg))
      || cliArgs.some((arg) => cliArgs.filter((value) => value === arg).length > 1)
      || (cliArgs.includes('--check') && cliArgs.includes('--verify-committed'))) {
    throw new Error('Usage: generate-python-release-lock.mjs [--check|--verify-committed]');
  }
  const result = cliArgs.includes('--verify-committed')
    ? verifyCommittedPythonLocks()
    : {
      release: generatePythonReleaseLock({ check: cliArgs.includes('--check') }),
      auditTool: generatePythonAuditToolLock({ check: cliArgs.includes('--check') }),
    };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
