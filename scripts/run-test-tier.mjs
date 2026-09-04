#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareMigratedDatabaseTemplate } from './lib/migrated-test-database-template-runner.mjs';
import {
  loadTestPolicy,
  matchFiles,
  partitionTestFiles,
  root,
  walkTestFiles,
} from './lib/test-policy.mjs';
import { loadTestGroups } from './lib/test-groups.mjs';

const [tier, ...args] = process.argv.slice(2);
const policy = loadTestPolicy();
const allFiles = walkTestFiles();
const partitions = partitionTestFiles(allFiles, policy);
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const valueOf = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];
  const assignment = args.find((argument) => argument.startsWith(`${name}=`));
  return assignment === undefined ? fallback : assignment.slice(name.length + 1);
};
const reporter = valueOf('--reporter', 'dot');
const jsonOutput = valueOf('--json-output');
const shard = valueOf('--shard');
const coverageBase = valueOf('--coverage-base');
const coverageShardsRaw = valueOf('--coverage-shards', '1');
const coverage = args.includes('--coverage');
const listOnly = args.includes('--list');
const noCache = args.includes('--no-cache');
const requestedFiles = args.filter((value) => value.startsWith('__tests__/') && value.endsWith('.test.ts'));
if (!/^[1-4]$/.test(coverageShardsRaw)) {
  throw new Error('--coverage-shards must be an integer from 1 through 4');
}
const coverageShards = Number(coverageShardsRaw);
if (coverageShards > 1 && !coverage) {
  throw new Error('--coverage-shards requires --coverage');
}
if (coverageShards > 1 && shard) {
  throw new Error('--coverage-shards cannot be combined with --shard');
}

function preparePrivateJsonOutput(requestedPath) {
  if (typeof requestedPath !== 'string'
      || requestedPath.length === 0
      || requestedPath.includes('\0')
      || requestedPath.includes('\n')
      || requestedPath.includes('\r')) {
    throw new Error('JSON output path is invalid');
  }
  const localRoot = path.join(root, '.local');
  const absolute = path.resolve(root, requestedPath);
  const relative = path.relative(localRoot, absolute);
  if (!relative
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    throw new Error('JSON output must stay strictly under .local/');
  }

  const parent = path.dirname(absolute);
  const parentRelative = path.relative(root, parent);
  let current = root;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`JSON output parent must be a real directory: ${current}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    fs.chmodSync(current, 0o700);
  }

  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('JSON output must be a regular file');
    }
    if (stat.nlink !== 1) {
      throw new Error('JSON output must not be hardlinked');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('JSON output must be owned by the current user');
    }
    fs.unlinkSync(absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const descriptor = fs.openSync(
    absolute,
    fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  fs.closeSync(descriptor);
  fs.chmodSync(absolute, 0o600);
  return absolute;
}

const jsonOutputPath = jsonOutput ? preparePrivateJsonOutput(jsonOutput) : null;

function requestedSubset(governedFiles) {
  if (requestedFiles.length === 0) return governedFiles;
  const unknown = requestedFiles.filter((file) => !allFiles.includes(file));
  if (unknown.length > 0) throw new Error(`Unknown requested test files: ${unknown.join(', ')}`);
  const outsideTier = requestedFiles.filter((file) => !governedFiles.includes(file));
  if (outsideTier.length > 0) {
    throw new Error(`Requested test files are outside tier ${tier}: ${outsideTier.join(', ')}`);
  }
  return [...new Set(requestedFiles)].sort();
}

/** Prints failed suites and unhandled errors from the merged JSON report (best effort). */
function reportMergedResultsSummary(reportPath) {
  if (!reportPath) return;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    process.stderr.write(`Merged Vitest report: success=${report.success} suites=${report.numTotalTestSuites} failedSuites=${report.numFailedTestSuites} tests=${report.numTotalTests} failedTests=${report.numFailedTests}\n`);
    const failed = (report.testResults ?? []).filter((suite) => suite.status !== 'passed');
    for (const suite of failed.slice(0, 20)) {
      const firstFailure = (suite.assertionResults ?? []).find((assertion) => assertion.status === 'failed');
      const detail = firstFailure ? ` — ${firstFailure.fullName}: ${String(firstFailure.failureMessages?.[0] ?? '').split('\n')[0].slice(0, 300)}` : suite.message ? ` — ${String(suite.message).split('\n')[0].slice(0, 300)}` : '';
      process.stderr.write(`  ${suite.status}: ${path.relative(root, suite.name)}${detail}\n`);
    }
    if (failed.length > 20) process.stderr.write(`  … ${failed.length - 20} more non-passing suites\n`);
  } catch (error) {
    process.stderr.write(`Merged Vitest report unavailable at ${reportPath}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function reporterArgs() {
  const resolved = [`--reporter=${reporter}`];
  if (jsonOutputPath) {
    if (reporter !== 'json') resolved.push('--reporter=json');
    resolved.push(`--outputFile=${jsonOutputPath}`);
  }
  return resolved;
}

function coverageArgs({
  reportsDirectory = '.local/coverage/selected',
  reporters = ['json', 'json-summary', 'lcov'],
  includeTestTimeout = true,
} = {}) {
  if (!coverage) return [];
  if (coverageBase && !/^[0-9a-f]{40}$/.test(coverageBase)) {
    throw new Error('--coverage-base must be an exact 40-character commit SHA');
  }
  return [
    '--coverage',
    ...(includeTestTimeout ? ['--testTimeout=60000'] : []),
    ...(coverageBase ? [`--coverage.changed=${coverageBase}`] : []),
    ...reporters.map((coverageReporter) => `--coverage.reporter=${coverageReporter}`),
    `--coverage.reportsDirectory=${reportsDirectory}`,
    '--coverage.processingConcurrency=1',
    '--coverage.thresholds.lines=0',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0',
    '--coverage.thresholds.statements=0',
  ];
}

function preparePrivateCoverageShardDirectory() {
  const localRoot = path.join(root, '.local');
  try {
    const stat = fs.lstatSync(localRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Coverage shard root must be a real directory');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Coverage shard root must be owned by the current user');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(localRoot, { mode: 0o700 });
  }
  fs.chmodSync(localRoot, 0o700);
  const directory = fs.mkdtempSync(path.join(localRoot, 'vitest-coverage-shards-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function privateNonemptyShardBlob(blobPath) {
  try {
    const stat = fs.lstatSync(blobPath);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && stat.nlink === 1
      && stat.size > 0
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function childStatus(code, signal) {
  if (Number.isInteger(code)) return code;
  return 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 1);
}

function waitForChild(child) {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve(childStatus(code, signal)));
  });
}

async function runVitest(files, extra = [], envOverrides = {}, { maxSeconds = null } = {}) {
  if (files.length === 0) throw new Error(`No tests resolved for tier ${tier}`);
  if (listOnly) {
    process.stdout.write(`${files.join('\n')}\n`);
    process.exit(0);
  }
  if (maxSeconds !== null
      && (!Number.isSafeInteger(maxSeconds) || maxSeconds <= 0 || maxSeconds > 300)) {
    throw new Error(`Invalid elapsed-time target for tier ${tier}`);
  }
  const startedAt = process.hrtime.bigint();
  if (coverageShards > 1) {
    const shardDirectory = preparePrivateCoverageShardDirectory();
    const blobDirectory = path.join(shardDirectory, 'blobs');
    fs.mkdirSync(blobDirectory, { mode: 0o700 });
    let status = 1;
    try {
      const template = prepareMigratedDatabaseTemplate(root);
      const shardStatuses = [];
      const blobPaths = [];
      try {
        for (let index = 1; index <= coverageShards; index += 1) {
          const blobPath = path.join(blobDirectory, `shard-${index}.blob`);
          blobPaths.push(blobPath);
          process.stdout.write(`Coverage shard ${index}/${coverageShards}\n`);
          const child = template.spawnChild(process.execPath, [
            vitest,
            'run',
            '--reporter=blob',
            `--outputFile=${blobPath}`,
            ...(noCache ? ['--no-cache'] : []),
            ...coverageArgs({
              reportsDirectory: path.join(shardDirectory, `coverage-${index}`),
              reporters: ['json-summary'],
            }),
            `--shard=${index}/${coverageShards}`,
            ...extra,
            ...files,
          ], {
            cwd: root,
            stdio: 'inherit',
            env: {
              ...process.env,
              NODE_ENV: 'test',
              ...envOverrides,
              ...template.env,
            },
          });
          shardStatuses.push(await waitForChild(child));
        }
      } finally {
        template.cleanup();
      }

      const missingBlob = blobPaths.find((blobPath) => !privateNonemptyShardBlob(blobPath));
      if (missingBlob) {
        process.stderr.write(`Coverage shard did not emit a private blob: ${missingBlob}\n`);
        status = 1;
      } else {
        const merge = spawnSync(process.execPath, [
          vitest,
          `--merge-reports=${blobDirectory}`,
          ...reporterArgs(),
          ...coverageArgs({ includeTestTimeout: false }),
        ], {
          cwd: root,
          stdio: 'inherit',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            ...envOverrides,
          },
        });
        const mergeStatus = merge.status ?? childStatus(null, merge.signal);
        status = shardStatuses.every((shardStatus) => shardStatus === 0)
          && mergeStatus === 0
          ? 0
          : 1;
        // The merged reporter output is not always captured by hosted CI logs,
        // so summarize the merge outcome from the parent process as well.
        process.stderr.write(`Coverage merge exit status=${merge.status ?? 'null'} signal=${merge.signal ?? 'none'} shards=[${shardStatuses.join(',')}]\n`);
        if (status !== 0) reportMergedResultsSummary(jsonOutputPath);
      }
    } finally {
      fs.rmSync(shardDirectory, { recursive: true, force: true });
    }
    process.exit(status);
  }
  const template = prepareMigratedDatabaseTemplate(root);
  let status = 1;
  try {
    const child = template.spawnChild(process.execPath, [
      vitest,
      'run',
      ...reporterArgs(),
      ...(noCache ? ['--no-cache'] : []),
      ...coverageArgs(),
      ...extra,
      ...files,
    ], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ...envOverrides,
        ...template.env,
      },
    });
    status = await waitForChild(child);
  } finally {
    template.cleanup();
  }
  const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
  if (maxSeconds !== null) {
    const formatted = elapsedSeconds.toFixed(3);
    if (elapsedSeconds > maxSeconds) {
      process.stderr.write(
        `Core safety pack exceeded its cold ${maxSeconds}s target: ${formatted}s\n`,
      );
      status = 1;
    } else {
      process.stdout.write(
        `Core safety pack cold duration: ${formatted}s (target <= ${maxSeconds}s)\n`,
      );
    }
  }
  process.exit(status);
}

if (tier === 'fast') {
  await runVitest(requestedSubset(matchFiles(partitions.deterministic, policy.tiers[tier].include)));
}

if (tier === 'core') {
  const groupPolicy = loadTestGroups();
  await runVitest(
    requestedSubset(groupPolicy.core.tests),
    [],
    {},
    { maxSeconds: groupPolicy.core.targetSeconds },
  );
}

if (tier === 'evaluate') {
  await runVitest(requestedSubset(partitions.evaluation));
}

if (tier === 'changed') {
  const requestedBase = valueOf('--base', 'origin/main');
  const resolvedBase = spawnSync('git', [
    'rev-parse', '--verify', `${requestedBase}^{commit}`,
  ], { cwd: root, encoding: 'utf8' });
  const base = resolvedBase.stdout.trim();
  if (resolvedBase.status !== 0 || !/^[0-9a-f]{40}$/.test(base)) {
    process.stderr.write(resolvedBase.stderr || `Test base does not resolve: ${requestedBase}\n`);
    process.exit(2);
  }
  const classifierFile = path.join(root, '.local/test-selection-classifier.json');
  fs.mkdirSync(path.dirname(classifierFile), { recursive: true });
  const classifier = spawnSync('bash', ['scripts/changed-area-classifier.sh', '--json', '--base', base], {
    cwd: root,
    encoding: 'utf8',
  });
  if (classifier.status !== 0) {
    process.stderr.write(classifier.stderr);
    process.exit(classifier.status ?? 1);
  }
  const classification = JSON.parse(classifier.stdout);
  if (classification.vitest?.mode === 'skip') {
    process.stdout.write(`Vitest skipped: ${classification.vitest.skipReason ?? 'no affected tests'}\n`);
    process.exit(0);
  }
  fs.writeFileSync(classifierFile, classifier.stdout);
  const selection = spawnSync(process.execPath, [
    'scripts/select-vitest-files.mjs', '--base', base, '--classifier', classifierFile,
  ], { cwd: root, encoding: 'utf8' });
  if (selection.status !== 0) {
    process.stderr.write(selection.stderr);
    process.exit(selection.status ?? 1);
  }
  await runVitest(selection.stdout.trim().split('\n').filter(Boolean));
}

if (tier === 'full-sharded') {
  const files = requestedSubset(partitions.deterministic);
  if (listOnly) await runVitest(files);
  if (shard) await runVitest(files, [`--shard=${shard}`]);
  const template = prepareMigratedDatabaseTemplate(root);
  let statuses;
  try {
    const children = [1, 2, 3, 4].map((shard) => template.spawnChild(
      process.execPath,
      [vitest, 'run', ...reporterArgs(), `--shard=${shard}/4`, ...files],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'test', ...template.env },
      },
    ));
    statuses = await Promise.all(children.map(waitForChild));
  } finally {
    template.cleanup();
  }
  process.exit(statuses.every((status) => status === 0) ? 0 : 1);
}

if (tier === 'deterministic') {
  await runVitest(requestedSubset(partitions.deterministic), shard ? [`--shard=${shard}`] : []);
}

if (tier === 'profile') {
  const outputDir = path.join(root, '.local/test-profile');
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, 'vitest-results.json');
  const template = prepareMigratedDatabaseTemplate(root);
  let testStatus = 1;
  try {
    const child = template.spawnChild(process.execPath, [
      vitest, 'run', '--reporter=json', `--outputFile=${output}`, ...allFiles,
    ], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test', ...template.env },
    });
    testStatus = await waitForChild(child);
  } finally {
    template.cleanup();
  }
  if (testStatus !== 0) process.exit(testStatus);
  const inventory = spawnSync(process.execPath, [
    'scripts/test-inventory.mjs', '--timings', output, '--timing-scope', 'all', '--enforce-evidence',
  ], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(inventory.status ?? 1);
}

if (tier === 'benchmark') {
  await runVitest(
    ['__tests__/services/training-m4-capacity-snapshots.test.ts'],
    [],
    { NEXUS_BENCHMARKS: '1' },
  );
}

console.error(`Unknown test tier: ${tier ?? '<missing>'}`);
process.exit(64);
