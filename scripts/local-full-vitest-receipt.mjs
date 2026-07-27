#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTestPolicy,
  partitionTestFiles,
  root as repositoryRoot,
  walkTestFiles,
} from './lib/test-policy.mjs';

export const LOCAL_FULL_VITEST_RECEIPT_SCHEMA = 'nexus.local-full-vitest-receipt.v1';
export const LOCAL_FULL_VITEST_SNAPSHOT_SCHEMA = 'nexus.local-full-vitest-snapshot.v1';
export const LOCAL_FULL_VITEST_SCOPE = 'full-unsharded-deterministic-vitest';
export const LOCAL_FULL_VITEST_MAX_AGE_SECONDS = 30 * 60;

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAXIMUM_JSON_BYTES = 256 * 1024 * 1024;
const TEST_ENVIRONMENT_EXCLUDED_NAMES = new Set([
  '_',
  'NEXUS_PRECOMMIT_FULL_VITEST',
  'NEXUS_PRECOMMIT_SKIP_IDENTITY_REFRESH',
  'NEXUS_PRECOMMIT_SKIP_SANDBOX_NUDGE',
  'NEXUS_PRECOMMIT_SKIP_SCIENCE_POLICY',
  'NEXUS_PREPUSH_FULL_VITEST',
  'NEXUS_RISK_GATE_ASSERT_CANNOT_SKIP_DASHBOARD',
  'NEXUS_RISK_GATE_JSON_OUTPUT',
  'NEXUS_SKIP_SHADOW_PARITY_WRITE',
  'OLDPWD',
  'PWD',
  'SHLVL',
]);
const TEST_CODE_INJECTION_ENV_NAMES = Object.freeze([
  'BASH_ENV',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONHOME',
  'PYTHONPATH',
]);
const DOTENV_INPUTS = Object.freeze(['.env', '.env.local', '.env.test', '.env.test.local']);
// Receipt-producing runs use Vitest --no-cache, so this mutable result-order
// cache is neither an input nor an output of the reusable full-suite result.
const INSTALLED_DEPENDENCY_CACHE_PATHS = new Set(['.vite']);
const RUNNER_CONTRACT_FILES = Object.freeze([
  '.husky/pre-commit',
  '.husky/pre-push',
  '.nvmrc',
  '__tests__/setup.ts',
  'package.json',
  'scripts/build-migrated-test-database-template.ts',
  'scripts/lib/migrated-test-database-template-runner.mjs',
  'scripts/lib/test-policy.mjs',
  'scripts/local-full-vitest-receipt.mjs',
  'scripts/risk-gate.sh',
  'scripts/run-test-tier.mjs',
  'src/testing/migrated-test-database-template.ts',
  'tsconfig.json',
  'vitest.config.ts',
]);

const args = process.argv.slice(2);
const command = args[0] ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function isCiEnvironment() {
  return ['CI', 'GITHUB_ACTIONS'].some((name) => {
    const value = String(process.env[name] ?? '').trim().toLowerCase();
    return value && !['0', 'false', 'no', 'off'].includes(value);
  });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

function git(rootDir, gitArgs, options = {}) {
  return execFileSync('git', gitArgs, {
    cwd: rootDir,
    env: cleanGitEnvironment(),
    encoding: 'utf8',
    ...options,
  }).trim();
}

function gitStatus(rootDir, gitArgs) {
  return spawnSync('git', gitArgs, {
    cwd: rootDir,
    env: cleanGitEnvironment(),
    encoding: 'utf8',
  });
}

function fileSha(rootDir, relativePath) {
  const absolute = path.join(rootDir, relativePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`receipt contract path must be a regular file: ${relativePath}`);
  }
  return sha256(fs.readFileSync(absolute));
}

function executablePath(commandName, rootDir) {
  if (commandName.includes(path.sep)) {
    const candidate = path.isAbsolute(commandName)
      ? commandName
      : path.resolve(rootDir, commandName);
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.realpathSync(candidate);
  }
  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, commandName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  fail(`required tool is not executable: ${commandName}`);
}

const executableDigestCache = new Map();
function executableIdentity(commandName, versionArgs, rootDir) {
  const absolute = executablePath(commandName, rootDir);
  let digest = executableDigestCache.get(absolute);
  if (!digest) {
    digest = sha256(fs.readFileSync(absolute));
    executableDigestCache.set(absolute, digest);
  }
  const version = execFileSync(absolute, versionArgs, {
    cwd: rootDir,
    env: cleanGitEnvironment(),
    encoding: 'utf8',
  }).trim();
  return { path: absolute, sha256: digest, version };
}

function optionalExecutableIdentity(name, commandName, versionArgs, rootDir) {
  try {
    executablePath(commandName, rootDir);
  } catch {
    return { name, present: false };
  }
  return {
    name,
    present: true,
    ...executableIdentity(commandName, versionArgs, rootDir),
  };
}

function selectedPython(rootDir) {
  if (process.env.CONTENT_ENGINE_PYTHON) return process.env.CONTENT_ENGINE_PYTHON;
  for (const relative of [
    'content-engine/.venv-codex313/bin/python',
    'content-engine/.venv313/bin/python',
    'content-engine/.venv/bin/python',
  ]) {
    const absolute = path.join(rootDir, relative);
    if (fs.existsSync(absolute)) return absolute;
  }
  return 'python3';
}

function privateDirectory(directory) {
  const parent = path.dirname(directory);
  for (const candidate of [parent, directory]) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`local receipt directory must not be a symlink: ${candidate}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(candidate, { mode: 0o700 });
    }
    fs.chmodSync(candidate, 0o700);
  }
  fs.chmodSync(directory, 0o700);
}

function assertPrivateDirectory(directory) {
  for (const candidate of [path.dirname(directory), directory]) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`local receipt directory must not be a symlink: ${candidate}`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      fail(`local receipt directory permissions must be 0700: ${candidate}`);
    }
  }
}

export function receiptPaths(rootDir = repositoryRoot) {
  const directory = path.join(rootDir, '.local', 'risk-gate');
  return {
    directory,
    receipt: path.join(directory, 'full-vitest-receipt.json'),
    report: path.join(directory, 'full-vitest-results.json'),
    snapshot: path.join(directory, 'full-vitest-snapshot.json'),
  };
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writePrivateJsonAtomic(file, value) {
  const directory = path.dirname(file);
  privateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function resetPrivateReport(file) {
  const directory = path.dirname(file);
  privateDirectory(directory);
  try {
    const existing = fs.lstatSync(file);
    if (existing.isDirectory()) fail('local full Vitest report path is a directory');
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const descriptor = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  fs.closeSync(descriptor);
  fs.chmodSync(file, 0o600);
}

function readPrivateJson(file, label) {
  assertPrivateDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  if ((stat.mode & 0o777) !== 0o600) fail(`${label} permissions must be 0600`);
  if (stat.size <= 0 || stat.size > MAXIMUM_JSON_BYTES) fail(`${label} size is invalid`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gitBlobSha(raw) {
  const hash = createHash('sha1');
  hash.update(`blob ${raw.length}\0`);
  hash.update(raw);
  return hash.digest('hex');
}

function assertRawWorktreeMatchesIndex(rootDir) {
  if (git(rootDir, ['rev-parse', '--show-object-format']) !== 'sha1') {
    fail('local receipt supports only the repository SHA-1 object format');
  }
  const records = git(rootDir, ['ls-files', '--stage', '-z', '--'])
    .split('\0')
    .filter(Boolean);
  if (records.length === 0) fail('candidate index has no tracked paths');
  const rootPrefix = `${path.resolve(rootDir)}${path.sep}`;
  for (const record of records) {
    const match = /^([0-7]{6}) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/u.exec(record);
    if (!match) fail('candidate index entry is malformed');
    const [, mode, expectedBlob, stage, relativePath] = match;
    if (stage !== '0') fail('index contains unresolved paths');
    const absolute = path.resolve(rootDir, relativePath);
    if (!absolute.startsWith(rootPrefix)) fail('candidate index path escapes the repository');
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') fail(`tracked worktree path is missing: ${relativePath}`);
      throw error;
    }
    let raw;
    if (mode === '100644' || mode === '100755') {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail(`tracked worktree path type drifted: ${relativePath}`);
      }
      const executable = (stat.mode & 0o111) !== 0;
      if (executable !== (mode === '100755')) {
        fail(`tracked worktree executable mode drifted: ${relativePath}`);
      }
      raw = fs.readFileSync(absolute);
    } else if (mode === '120000') {
      if (!stat.isSymbolicLink()) fail(`tracked symlink type drifted: ${relativePath}`);
      raw = fs.readlinkSync(absolute, { encoding: 'buffer' });
    } else if (mode === '160000') {
      fail('submodule worktrees are not eligible for a local full Vitest receipt');
    } else {
      fail(`unsupported tracked index mode ${mode}: ${relativePath}`);
    }
    if (gitBlobSha(raw) !== expectedBlob) {
      fail(`tracked worktree bytes differ from the staged index: ${relativePath}`);
    }
  }
}

function assertCandidateClean(rootDir) {
  const indexFlags = git(rootDir, ['ls-files', '-v', '--']);
  const hiddenIndexEntry = indexFlags
    .split('\n')
    .find((line) => /^[a-zS]\s/u.test(line));
  if (hiddenIndexEntry) {
    fail('index contains assume-unchanged or skip-worktree paths');
  }
  assertRawWorktreeMatchesIndex(rootDir);
  const untracked = git(rootDir, ['ls-files', '--others', '--exclude-standard']);
  if (untracked) fail('working tree contains untracked nonignored files');
  const unresolved = git(rootDir, ['diff', '--name-only', '--diff-filter=U']);
  if (unresolved) fail('index contains unresolved paths');
}

function deterministicFiles(rootDir) {
  const policy = loadTestPolicy(rootDir);
  return partitionTestFiles(walkTestFiles(rootDir), policy).deterministic;
}

function buildRunnerIdentity(rootDir) {
  const files = RUNNER_CONTRACT_FILES.map((relativePath) => ({
    path: relativePath,
    sha256: fileSha(rootDir, relativePath),
  }));
  return {
    files,
    digest: sha256(canonicalJson(files)),
  };
}

function buildToolchainIdentity(rootDir) {
  const vitestPackagePath = 'node_modules/vitest/package.json';
  const vitestPackage = JSON.parse(fs.readFileSync(path.join(rootDir, vitestPackagePath), 'utf8'));
  const node = executableIdentity(process.execPath, ['--version'], rootDir);
  const python = executableIdentity(selectedPython(rootDir), ['--version'], rootDir);
  const externalTools = [
    ['bash', 'bash', ['--version']],
    ['git', 'git', ['--version']],
    ['jq', 'jq', ['--version']],
    ['openssl', 'openssl', ['version']],
    ['tar', 'tar', ['--version']],
  ].map(([name, executable, versionArgs]) => ({
    name,
    present: true,
    ...executableIdentity(executable, versionArgs, rootDir),
  })).concat([
    optionalExecutableIdentity('python3-path', 'python3', ['--version'], rootDir),
    optionalExecutableIdentity(
      'nexus-test-python',
      process.env.NEXUS_TEST_PYTHON || 'python3',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'nexus-dr-python',
      process.env.NEXUS_DR_PYTHON_BIN || 'python3',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'python3-homebrew',
      '/opt/homebrew/bin/python3',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'python3-system',
      '/usr/bin/python3',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity('cfn-guard-path', 'cfn-guard', ['--version'], rootDir),
    optionalExecutableIdentity('cfn-lint-path', 'cfn-lint', ['--version'], rootDir),
    optionalExecutableIdentity(
      'cfn-guard-homebrew',
      '/opt/homebrew/bin/cfn-guard',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'cfn-guard-local',
      '/usr/local/bin/cfn-guard',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'cfn-guard-system',
      '/usr/bin/cfn-guard',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'cfn-lint-homebrew',
      '/opt/homebrew/bin/cfn-lint',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'cfn-lint-local',
      '/usr/local/bin/cfn-lint',
      ['--version'],
      rootDir,
    ),
    optionalExecutableIdentity(
      'cfn-lint-system',
      '/usr/bin/cfn-lint',
      ['--version'],
      rootDir,
    ),
    ...(process.env.CFN_GUARD_BIN ? [optionalExecutableIdentity(
      'cfn-guard-override',
      process.env.CFN_GUARD_BIN,
      ['--version'],
      rootDir,
    )] : []),
    ...(process.env.CFN_LINT_BIN ? [optionalExecutableIdentity(
      'cfn-lint-override',
      process.env.CFN_LINT_BIN,
      ['--version'],
      rootDir,
    )] : []),
  ]);
  const identity = {
    externalTools,
    node,
    python,
    vitest: {
      entrypointSha256: fileSha(rootDir, 'node_modules/vitest/vitest.mjs'),
      packageSha256: fileSha(rootDir, vitestPackagePath),
      version: String(vitestPackage.version ?? ''),
    },
  };
  if (!identity.vitest.version) fail('Vitest version is missing');
  return {
    ...identity,
    digest: sha256(canonicalJson(identity)),
  };
}

function hashFrame(hash, label, value) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(`${label}:${raw.length}:`);
  hash.update(raw);
}

function scanInstalledDependencies(rootDir) {
  const configuredRoot = path.join(rootDir, 'node_modules');
  const configuredStat = fs.lstatSync(configuredRoot);
  if (!configuredStat.isDirectory() && !configuredStat.isSymbolicLink()) {
    fail('node_modules must be a directory or one explicit directory symlink');
  }
  const resolvedRoot = fs.realpathSync(configuredRoot);
  const resolvedStat = fs.lstatSync(resolvedRoot);
  if (!resolvedStat.isDirectory() || resolvedStat.isSymbolicLink()) {
    fail('resolved node_modules must be a real directory');
  }
  const configuredTarget = configuredStat.isSymbolicLink()
    ? fs.readlinkSync(configuredRoot)
    : '.';
  const hash = createHash('sha256');
  hashFrame(hash, 'configured-type', configuredStat.isSymbolicLink() ? 'symlink' : 'directory');
  hashFrame(hash, 'configured-target', configuredTarget);
  hashFrame(hash, 'resolved-root', resolvedRoot);
  let entriesCount = 0;
  let filesCount = 0;
  let totalBytes = 0;

  const walk = (directory, prefix = '') => {
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (INSTALLED_DEPENDENCY_CACHE_PATHS.has(relativePath)) continue;
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      entriesCount += 1;
      hashFrame(hash, 'path', relativePath);
      hashFrame(hash, 'mode', String(stat.mode & 0o7777));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        hashFrame(hash, 'type', 'directory');
        walk(absolute, relativePath);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        const raw = fs.readFileSync(absolute);
        filesCount += 1;
        totalBytes += raw.length;
        hashFrame(hash, 'type', 'file');
        hashFrame(hash, 'contents', raw);
      } else if (stat.isSymbolicLink()) {
        const resolvedTarget = fs.realpathSync(absolute);
        const targetRelativeToRoot = path.relative(resolvedRoot, resolvedTarget);
        if (targetRelativeToRoot === '..'
            || targetRelativeToRoot.startsWith(`..${path.sep}`)
            || path.isAbsolute(targetRelativeToRoot)) {
          fail(`installed dependency symlink escapes node_modules: ${relativePath}`);
        }
        hashFrame(hash, 'type', 'symlink');
        hashFrame(hash, 'target', fs.readlinkSync(absolute, { encoding: 'buffer' }));
      } else {
        fail(`installed dependency entry type is unsupported: ${relativePath}`);
      }
    }
  };
  walk(resolvedRoot);
  const finalConfiguredStat = fs.lstatSync(configuredRoot);
  const finalResolvedRoot = fs.realpathSync(configuredRoot);
  const finalResolvedStat = fs.lstatSync(finalResolvedRoot);
  const finalConfiguredTarget = finalConfiguredStat.isSymbolicLink()
    ? fs.readlinkSync(configuredRoot)
    : '.';
  if ((configuredStat.isSymbolicLink() !== finalConfiguredStat.isSymbolicLink())
      || finalResolvedRoot !== resolvedRoot
      || finalConfiguredTarget !== configuredTarget
      || finalResolvedStat.dev !== resolvedStat.dev
      || finalResolvedStat.ino !== resolvedStat.ino) {
    fail('installed dependency root changed while it was hashed');
  }
  if (entriesCount <= 0 || filesCount <= 0 || totalBytes <= 0) {
    fail('installed dependency tree is empty');
  }
  return {
    digest: hash.digest('hex'),
    entriesCount,
    filesCount,
    totalBytes,
  };
}

function buildInstalledDependenciesIdentity(rootDir) {
  const first = scanInstalledDependencies(rootDir);
  const second = scanInstalledDependencies(rootDir);
  if (canonicalJson(first) !== canonicalJson(second)) {
    fail('installed dependency bytes changed while the local test contract was built');
  }
  return second;
}

function buildPlatformIdentity() {
  const identity = {
    arch: process.arch,
    osRelease: os.release(),
    platform: process.platform,
  };
  return {
    ...identity,
    digest: sha256(canonicalJson(identity)),
  };
}

function scanTestEnvironmentIdentity(rootDir) {
  for (const name of TEST_CODE_INJECTION_ENV_NAMES) {
    if (String(process.env[name] ?? '').trim()) {
      fail(`receipt-eligible tests forbid external code-injection environment: ${name}`);
    }
  }
  const names = Object.keys(process.env)
    .filter((name) => !TEST_ENVIRONMENT_EXCLUDED_NAMES.has(name)
      && name !== 'HUSKY'
      && !name.startsWith('HUSKY_'))
    .sort();
  const hashedValues = Object.fromEntries(
    names.map((name) => [name, sha256(String(process.env[name] ?? ''))]),
  );
  const dotenvInputs = Object.fromEntries(DOTENV_INPUTS.map((relativePath) => {
    const absolute = path.join(rootDir, relativePath);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail(`dotenv input must be an ordinary file: ${relativePath}`);
      }
      return [relativePath, { present: true, sha256: sha256(fs.readFileSync(absolute)) }];
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return [relativePath, { present: false }];
    }
  }));
  return {
    digest: sha256(canonicalJson({
      dotenvInputs,
      variables: hashedValues,
    })),
  };
}

function buildTestEnvironmentIdentity(rootDir) {
  const first = scanTestEnvironmentIdentity(rootDir);
  const second = scanTestEnvironmentIdentity(rootDir);
  if (canonicalJson(first) !== canonicalJson(second)) {
    fail('test environment changed while the local test contract was built');
  }
  return second;
}

export function buildLocalFullVitestContract(rootDir = repositoryRoot) {
  const governedFiles = deterministicFiles(rootDir);
  const lockfiles = {
    installedPackageLockSha256: fileSha(rootDir, 'node_modules/.package-lock.json'),
    packageLockSha256: fileSha(rootDir, 'package-lock.json'),
    pythonRequirementsSha256: fileSha(rootDir, 'content-engine/requirements.txt'),
  };
  return {
    testPolicySha256: fileSha(rootDir, 'config/test-policy.json'),
    lockfiles: {
      ...lockfiles,
      digest: sha256(canonicalJson(lockfiles)),
    },
    runner: buildRunnerIdentity(rootDir),
    toolchain: buildToolchainIdentity(rootDir),
    installedDependencies: buildInstalledDependenciesIdentity(rootDir),
    platform: buildPlatformIdentity(),
    environment: buildTestEnvironmentIdentity(rootDir),
    vitestSelection: {
      filesCount: governedFiles.length,
      filesDigest: sha256(canonicalJson(governedFiles)),
    },
  };
}

function currentCandidateGitIdentity(rootDir = repositoryRoot) {
  assertCandidateClean(rootDir);
  const baseHeadSha = git(rootDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const indexTreeSha = git(rootDir, ['write-tree']);
  if (!SHA1_PATTERN.test(baseHeadSha) || !SHA1_PATTERN.test(indexTreeSha)) {
    fail('candidate Git identity is invalid');
  }
  return {
    baseHeadSha,
    indexTreeSha,
  };
}

export function currentCandidateIdentity(rootDir = repositoryRoot) {
  const before = currentCandidateGitIdentity(rootDir);
  const contract = buildLocalFullVitestContract(rootDir);
  const after = currentCandidateGitIdentity(rootDir);
  if (canonicalJson(before) !== canonicalJson(after)) {
    fail('candidate Git identity changed while the local test contract was built');
  }
  return {
    ...after,
    contract,
  };
}

function validateContract(contract) {
  exactKeys(contract, [
    'testPolicySha256',
    'lockfiles',
    'runner',
    'toolchain',
    'installedDependencies',
    'platform',
    'environment',
    'vitestSelection',
  ], 'local full Vitest contract');
  exactKeys(contract.lockfiles, [
    'installedPackageLockSha256',
    'packageLockSha256',
    'pythonRequirementsSha256',
    'digest',
  ], 'local full Vitest lockfiles');
  exactKeys(contract.runner, ['files', 'digest'], 'local full Vitest runner');
  exactKeys(
    contract.toolchain,
    ['externalTools', 'node', 'python', 'vitest', 'digest'],
    'local full Vitest toolchain',
  );
  exactKeys(contract.toolchain.node, ['path', 'sha256', 'version'], 'local Node identity');
  exactKeys(contract.toolchain.python, ['path', 'sha256', 'version'], 'local Python identity');
  exactKeys(
    contract.toolchain.vitest,
    ['entrypointSha256', 'packageSha256', 'version'],
    'local Vitest identity',
  );
  if (!Array.isArray(contract.toolchain.externalTools)
      || contract.toolchain.externalTools.length < 5) {
    fail('local external test-tool identities are missing');
  }
  for (const tool of contract.toolchain.externalTools) {
    if (tool?.present === false) {
      exactKeys(tool, ['name', 'present'], 'local optional external test tool');
      if (typeof tool.name !== 'string' || !tool.name) {
        fail('local optional external test-tool identity is invalid');
      }
      continue;
    }
    exactKeys(
      tool,
      ['name', 'present', 'path', 'sha256', 'version'],
      'local external test tool',
    );
    if (tool.present !== true
        || typeof tool.name !== 'string' || !tool.name
        || typeof tool.path !== 'string' || !tool.path
        || typeof tool.version !== 'string' || !tool.version
        || !SHA256_PATTERN.test(tool.sha256 ?? '')) {
      fail('local external test-tool identity is invalid');
    }
  }
  exactKeys(
    contract.installedDependencies,
    ['digest', 'entriesCount', 'filesCount', 'totalBytes'],
    'local installed dependency identity',
  );
  exactKeys(contract.platform, ['arch', 'osRelease', 'platform', 'digest'], 'local platform identity');
  exactKeys(contract.environment, ['digest'], 'local test environment identity');
  exactKeys(contract.vitestSelection, ['filesCount', 'filesDigest'], 'local Vitest selection');
  for (const digest of [
    contract.testPolicySha256,
    contract.lockfiles.installedPackageLockSha256,
    contract.lockfiles.packageLockSha256,
    contract.lockfiles.pythonRequirementsSha256,
    contract.lockfiles.digest,
    contract.runner.digest,
    contract.toolchain.node.sha256,
    contract.toolchain.python.sha256,
    ...contract.toolchain.externalTools
      .filter((tool) => tool.present)
      .map((tool) => tool.sha256),
    contract.toolchain.vitest.entrypointSha256,
    contract.toolchain.vitest.packageSha256,
    contract.toolchain.digest,
    contract.installedDependencies.digest,
    contract.platform.digest,
    contract.environment.digest,
    contract.vitestSelection.filesDigest,
  ]) {
    if (!SHA256_PATTERN.test(digest ?? '')) fail('local full Vitest contract digest is invalid');
  }
  if (!Array.isArray(contract.runner.files) || contract.runner.files.length === 0) {
    fail('local full Vitest runner files are missing');
  }
  for (const entry of contract.runner.files) {
    exactKeys(entry, ['path', 'sha256'], 'local full Vitest runner file');
    if (typeof entry.path !== 'string' || !entry.path || !SHA256_PATTERN.test(entry.sha256 ?? '')) {
      fail('local full Vitest runner file identity is invalid');
    }
  }
  if (contract.runner.digest !== sha256(canonicalJson(contract.runner.files))) {
    fail('local full Vitest runner digest mismatch');
  }
  const lockfiles = {
    installedPackageLockSha256: contract.lockfiles.installedPackageLockSha256,
    packageLockSha256: contract.lockfiles.packageLockSha256,
    pythonRequirementsSha256: contract.lockfiles.pythonRequirementsSha256,
  };
  if (contract.lockfiles.digest !== sha256(canonicalJson(lockfiles))) {
    fail('local full Vitest lockfile digest mismatch');
  }
  const toolchain = {
    externalTools: contract.toolchain.externalTools,
    node: contract.toolchain.node,
    python: contract.toolchain.python,
    vitest: contract.toolchain.vitest,
  };
  if (contract.toolchain.digest !== sha256(canonicalJson(toolchain))) {
    fail('local full Vitest toolchain digest mismatch');
  }
  if (!Number.isSafeInteger(contract.installedDependencies.entriesCount)
      || contract.installedDependencies.entriesCount <= 0
      || !Number.isSafeInteger(contract.installedDependencies.filesCount)
      || contract.installedDependencies.filesCount <= 0
      || !Number.isSafeInteger(contract.installedDependencies.totalBytes)
      || contract.installedDependencies.totalBytes <= 0) {
    fail('local installed dependency counts are invalid');
  }
  const platform = {
    arch: contract.platform.arch,
    osRelease: contract.platform.osRelease,
    platform: contract.platform.platform,
  };
  if (contract.platform.digest !== sha256(canonicalJson(platform))) {
    fail('local full Vitest platform digest mismatch');
  }
  if (!Number.isSafeInteger(contract.vitestSelection.filesCount)
      || contract.vitestSelection.filesCount <= 0) {
    fail('local full Vitest governed file count is invalid');
  }
  return contract;
}

function validateCandidate(candidate) {
  exactKeys(candidate, ['baseHeadSha', 'indexTreeSha', 'contract'], 'local Vitest candidate');
  if (!SHA1_PATTERN.test(candidate.baseHeadSha ?? '')
      || !SHA1_PATTERN.test(candidate.indexTreeSha ?? '')) {
    fail('local Vitest candidate Git identity is invalid');
  }
  validateContract(candidate.contract);
  return candidate;
}

export function createLocalFullVitestSnapshot({
  rootDir = repositoryRoot,
  nowMs = Date.now(),
} = {}) {
  const snapshot = {
    schema: LOCAL_FULL_VITEST_SNAPSHOT_SCHEMA,
    scope: LOCAL_FULL_VITEST_SCOPE,
    startedAt: new Date(nowMs).toISOString(),
    candidate: currentCandidateIdentity(rootDir),
  };
  validateLocalFullVitestSnapshot(snapshot);
  const paths = receiptPaths(rootDir);
  resetPrivateReport(paths.report);
  writePrivateJsonAtomic(paths.snapshot, snapshot);
  return snapshot;
}

export function validateLocalFullVitestSnapshot(snapshot) {
  exactKeys(snapshot, ['schema', 'scope', 'startedAt', 'candidate'], 'local full Vitest snapshot');
  if (snapshot.schema !== LOCAL_FULL_VITEST_SNAPSHOT_SCHEMA
      || snapshot.scope !== LOCAL_FULL_VITEST_SCOPE) {
    fail('local full Vitest snapshot schema or scope is invalid');
  }
  if (!Number.isFinite(Date.parse(snapshot.startedAt))) {
    fail('local full Vitest snapshot timestamp is invalid');
  }
  validateCandidate(snapshot.candidate);
  return snapshot;
}

function normalizeTestPath(rootDir, file) {
  const raw = String(file ?? '');
  let normalized;
  if (path.isAbsolute(raw)) {
    const relative = path.relative(path.resolve(rootDir), path.resolve(raw));
    if (!relative
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
      fail(`Vitest result path escapes the repository: ${file}`);
    }
    normalized = relative.split(path.sep).join('/');
  } else {
    normalized = raw.split(path.sep).join('/');
  }
  if (normalized.startsWith('__tests__/')) return normalized;
  fail(`Vitest result does not identify a repository test file: ${file}`);
}

function countVitestTests(value) {
  if (!value || typeof value !== 'object') return 0;
  if (typeof value.numTotalTests === 'number') return value.numTotalTests;
  if (typeof value.totalTestCount === 'number') return value.totalTestCount;
  if (Array.isArray(value.assertionResults)) return value.assertionResults.length;
  let total = 0;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) total += child.reduce((sum, item) => sum + countVitestTests(item), 0);
    else if (child && typeof child === 'object') total += countVitestTests(child);
  }
  return total;
}

function validateVitestReport(rootDir, reportPath, expectedContract) {
  const reportStat = fs.lstatSync(reportPath);
  if (!reportStat.isFile() || reportStat.isSymbolicLink()
      || (reportStat.mode & 0o777) !== 0o600
      || reportStat.size <= 0 || reportStat.size > MAXIMUM_JSON_BYTES) {
    fail('local full Vitest JSON report is not a bounded regular file');
  }
  const raw = fs.readFileSync(reportPath);
  const report = JSON.parse(raw.toString('utf8'));
  if (report.success !== true
      || (typeof report.numFailedTests === 'number' && report.numFailedTests !== 0)
      || (typeof report.numFailedTestSuites === 'number' && report.numFailedTestSuites !== 0)) {
    fail('local full Vitest JSON report did not pass');
  }
  if (!Array.isArray(report.testResults) || report.testResults.length === 0) {
    fail('local full Vitest JSON report has no test files');
  }
  const reportedFiles = [...new Set(
    report.testResults.map((entry) => normalizeTestPath(rootDir, entry?.name)),
  )].sort();
  const expectedFiles = deterministicFiles(rootDir);
  if (canonicalJson(reportedFiles) !== canonicalJson(expectedFiles)
      || expectedContract.vitestSelection.filesCount !== expectedFiles.length
      || expectedContract.vitestSelection.filesDigest !== sha256(canonicalJson(expectedFiles))) {
    fail('local full Vitest JSON report does not cover the governed deterministic file set');
  }
  const testCount = countVitestTests(report);
  if (!Number.isSafeInteger(testCount) || testCount <= 0) {
    fail('local full Vitest JSON report test count is invalid');
  }
  return {
    filesCount: reportedFiles.length,
    filesDigest: sha256(canonicalJson(reportedFiles)),
    reportSha256: sha256(raw),
    testCount,
  };
}

export function recordLocalFullVitestReceipt({
  rootDir = repositoryRoot,
  nowMs = Date.now(),
} = {}) {
  const paths = receiptPaths(rootDir);
  const snapshot = validateLocalFullVitestSnapshot(
    readPrivateJson(paths.snapshot, 'local full Vitest snapshot'),
  );
  const current = currentCandidateIdentity(rootDir);
  if (canonicalJson(current) !== canonicalJson(snapshot.candidate)) {
    fail('local full Vitest candidate changed while the suite was running');
  }
  fs.chmodSync(paths.report, 0o600);
  const vitest = validateVitestReport(rootDir, paths.report, current.contract);
  const completedAt = new Date(nowMs).toISOString();
  if (Date.parse(completedAt) < Date.parse(snapshot.startedAt)) {
    fail('local full Vitest completion predates its snapshot');
  }
  const receipt = {
    schema: LOCAL_FULL_VITEST_RECEIPT_SCHEMA,
    status: 'passed',
    scope: LOCAL_FULL_VITEST_SCOPE,
    startedAt: snapshot.startedAt,
    completedAt,
    maxAgeSeconds: LOCAL_FULL_VITEST_MAX_AGE_SECONDS,
    candidate: current,
    vitest: {
      mode: 'full',
      shard: null,
      ...vitest,
    },
  };
  validateLocalFullVitestReceipt(receipt, { nowMs, requireFresh: true });
  writePrivateJsonAtomic(paths.receipt, receipt);
  return receipt;
}

export function validateLocalFullVitestReceipt(receipt, {
  nowMs = Date.now(),
  requireFresh = true,
} = {}) {
  exactKeys(receipt, [
    'schema',
    'status',
    'scope',
    'startedAt',
    'completedAt',
    'maxAgeSeconds',
    'candidate',
    'vitest',
  ], 'local full Vitest receipt');
  exactKeys(receipt.vitest, [
    'mode',
    'shard',
    'filesCount',
    'filesDigest',
    'reportSha256',
    'testCount',
  ], 'local full Vitest result');
  if (receipt.schema !== LOCAL_FULL_VITEST_RECEIPT_SCHEMA
      || receipt.status !== 'passed'
      || receipt.scope !== LOCAL_FULL_VITEST_SCOPE
      || receipt.maxAgeSeconds !== LOCAL_FULL_VITEST_MAX_AGE_SECONDS) {
    fail('local full Vitest receipt schema, status, scope, or max age is invalid');
  }
  validateCandidate(receipt.candidate);
  if (receipt.vitest.mode !== 'full' || receipt.vitest.shard !== null) {
    fail('local full Vitest receipt is not an unsharded full result');
  }
  for (const digest of [receipt.vitest.filesDigest, receipt.vitest.reportSha256]) {
    if (!SHA256_PATTERN.test(digest ?? '')) fail('local full Vitest result digest is invalid');
  }
  if (!Number.isSafeInteger(receipt.vitest.filesCount) || receipt.vitest.filesCount <= 0
      || !Number.isSafeInteger(receipt.vitest.testCount) || receipt.vitest.testCount <= 0
      || receipt.vitest.filesCount !== receipt.candidate.contract.vitestSelection.filesCount
      || receipt.vitest.filesDigest !== receipt.candidate.contract.vitestSelection.filesDigest) {
    fail('local full Vitest result does not match its governed selection');
  }
  const startedAt = Date.parse(receipt.startedAt);
  const completedAt = Date.parse(receipt.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
      || completedAt < startedAt || completedAt > nowMs + 5_000) {
    fail('local full Vitest receipt timestamps are invalid');
  }
  if (requireFresh && completedAt < nowMs - LOCAL_FULL_VITEST_MAX_AGE_SECONDS * 1_000) {
    fail('local full Vitest receipt is stale');
  }
  return receipt;
}

function isAncestor(rootDir, ancestor, descendant) {
  const result = gitStatus(rootDir, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.status === 0;
}

export function verifyExactPushedCandidate({
  rootDir = repositoryRoot,
  pushedSha = '',
} = {}) {
  if (!SHA1_PATTERN.test(pushedSha)) fail('exact pushed candidate requires one non-delete SHA');
  const current = currentCandidateGitIdentity(rootDir);
  const pushedCommit = git(rootDir, ['rev-parse', '--verify', `${pushedSha}^{commit}`]);
  const pushedTree = git(rootDir, ['rev-parse', '--verify', `${pushedCommit}^{tree}`]);
  if (pushedCommit !== pushedSha
      || current.baseHeadSha !== pushedSha
      || current.indexTreeSha !== pushedTree) {
    fail('working tree and index do not bind the exact pushed HEAD');
  }
  return {
    pushedSha,
    pushedTree,
  };
}

export function verifyLocalFullVitestReceipt({
  rootDir = repositoryRoot,
  context,
  pushedSha = '',
  nowMs = Date.now(),
} = {}) {
  if (!['pre-commit', 'pre-push'].includes(context)) {
    fail('local full Vitest receipt context is invalid');
  }
  const receipt = validateLocalFullVitestReceipt(
    readPrivateJson(receiptPaths(rootDir).receipt, 'local full Vitest receipt'),
    { nowMs, requireFresh: true },
  );
  const currentGit = currentCandidateGitIdentity(rootDir);
  if (currentGit.indexTreeSha !== receipt.candidate.indexTreeSha) {
    fail('local full Vitest receipt does not match the current candidate');
  }
  if (context === 'pre-commit') {
    if (currentGit.baseHeadSha !== receipt.candidate.baseHeadSha) {
      fail('local full Vitest receipt does not match the pre-commit HEAD');
    }
  } else {
    if (!SHA1_PATTERN.test(pushedSha)) fail('pre-push receipt requires one exact non-delete SHA');
    const pushedCommit = git(rootDir, ['rev-parse', '--verify', `${pushedSha}^{commit}`]);
    const currentHead = git(rootDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const pushedTree = git(rootDir, ['rev-parse', '--verify', `${pushedCommit}^{tree}`]);
    if (pushedCommit !== pushedSha || currentHead !== pushedSha
        || pushedTree !== receipt.candidate.indexTreeSha
        || currentGit.indexTreeSha !== pushedTree
        || !isAncestor(rootDir, receipt.candidate.baseHeadSha, pushedSha)) {
      fail('local full Vitest receipt does not bind the exact pushed commit tree');
    }
  }
  const current = currentCandidateIdentity(rootDir);
  if (canonicalJson(current.contract) !== canonicalJson(receipt.candidate.contract)
      || current.indexTreeSha !== receipt.candidate.indexTreeSha) {
    fail('local full Vitest receipt does not match the current candidate');
  }
  const observedVitest = validateVitestReport(
    rootDir,
    receiptPaths(rootDir).report,
    current.contract,
  );
  const recordedVitest = {
    filesCount: receipt.vitest.filesCount,
    filesDigest: receipt.vitest.filesDigest,
    reportSha256: receipt.vitest.reportSha256,
    testCount: receipt.vitest.testCount,
  };
  if (canonicalJson(observedVitest) !== canonicalJson(recordedVitest)) {
    fail('local full Vitest JSON report does not match its receipt');
  }
  if (context === 'pre-commit') {
    if (current.baseHeadSha !== receipt.candidate.baseHeadSha) {
      fail('local full Vitest receipt does not match the pre-commit HEAD');
    }
    return receipt;
  }
  if (!SHA1_PATTERN.test(pushedSha)) fail('pre-push receipt requires one exact non-delete SHA');
  const pushedCommit = git(rootDir, ['rev-parse', '--verify', `${pushedSha}^{commit}`]);
  const currentHead = git(rootDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const pushedTree = git(rootDir, ['rev-parse', '--verify', `${pushedCommit}^{tree}`]);
  if (pushedCommit !== pushedSha || currentHead !== pushedSha
      || pushedTree !== receipt.candidate.indexTreeSha
      || current.indexTreeSha !== pushedTree
      || !isAncestor(rootDir, receipt.candidate.baseHeadSha, pushedSha)) {
    fail('local full Vitest receipt does not bind the exact pushed commit tree');
  }
  return receipt;
}

function runCli() {
  try {
    if (['snapshot', 'record', 'check'].includes(command) && isCiEnvironment()) {
      fail('local full Vitest receipts are disabled in CI');
    }
    if (command === 'snapshot') {
      createLocalFullVitestSnapshot();
      process.stdout.write('local full Vitest candidate snapshot recorded\n');
      return;
    }
    if (command === 'record') {
      recordLocalFullVitestReceipt();
      process.stdout.write('local full Vitest receipt recorded\n');
      return;
    }
    if (command === 'check') {
      verifyLocalFullVitestReceipt({
        context: valueOf('--context'),
        pushedSha: valueOf('--pushed-sha'),
      });
      process.stdout.write('local full Vitest receipt is reusable\n');
      return;
    }
    if (command === 'check-pushed-candidate') {
      verifyExactPushedCandidate({ pushedSha: valueOf('--pushed-sha') });
      process.stdout.write('local pushed candidate is exact and clean\n');
      return;
    }
    fail('Usage: local-full-vitest-receipt.mjs <snapshot|record|check|check-pushed-candidate> [--context pre-commit|pre-push] [--pushed-sha SHA]');
  } catch (error) {
    process.stderr.write(`local full Vitest receipt unavailable: ${error.message}\n`);
    process.exitCode = command === 'record' ? 1 : 3;
  }
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  runCli();
}
