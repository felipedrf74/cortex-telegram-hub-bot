#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isCriticalModule } from './mutation-gate.mjs';
import { cleanGitEnv, resolveExactCommit } from './lib/git-ref.mjs';
import { loadTestPolicy, root } from './lib/test-policy.mjs';

export { resolveExactCommit } from './lib/git-ref.mjs';

const MAX_COVERAGE_SHARDS = 4;
const TESTS_PER_COVERAGE_SHARD = 200;

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
}

function runGit(args) {
  return run('git', args, { env: cleanGitEnv() });
}

export function coverageShardCount(testCount) {
  if (!Number.isSafeInteger(testCount) || testCount < 1) {
    throw new Error('coverage sharding requires a positive integer test count');
  }
  return Math.min(MAX_COVERAGE_SHARDS, Math.ceil(testCount / TESTS_PER_COVERAGE_SHARD));
}

function processFailure(result, label) {
  if (result.status === 0) return null;
  if (result.signal) return `${label} terminated by ${result.signal}`;
  return `${label} exited with status ${result.status ?? 'unknown'}`;
}

export function aggregateCoverage(records) {
  const result = {};
  for (const metric of ['lines', 'branches', 'functions', 'statements']) {
    const total = records.reduce((sum, record) => sum + Number(record?.[metric]?.total ?? 0), 0);
    const covered = records.reduce((sum, record) => sum + Number(record?.[metric]?.covered ?? 0), 0);
    result[metric] = {
      total,
      covered,
      pct: total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100,
    };
  }
  return result;
}

export function thresholdFailures(label, coverage, thresholds) {
  return ['lines', 'branches']
    .filter((metric) => coverage[metric].pct < thresholds[metric])
    .map((metric) => `${label} ${metric} ${coverage[metric].pct}% is below ${thresholds[metric]}%`);
}

export function validateCoverageException(exception, now = new Date()) {
  const errors = [];
  for (const field of ['file', 'owner', 'reason', 'expires']) {
    if (typeof exception?.[field] !== 'string' || exception[field].trim() === '') {
      errors.push(`coverage exception missing ${field}`);
    }
  }
  if (!exception?.minimum || !Number.isFinite(exception.minimum.lines) || !Number.isFinite(exception.minimum.branches)) {
    errors.push(`coverage exception ${exception?.file ?? '<unknown>'} missing numeric line/branch minimum`);
  }
  const expiry = Date.parse(`${exception?.expires ?? ''}T23:59:59Z`);
  if (!Number.isFinite(expiry)) errors.push(`coverage exception ${exception?.file ?? '<unknown>'} has invalid expiry`);
  else if (expiry < now.getTime()) errors.push(`coverage exception expired: ${exception.file} (${exception.expires})`);
  return errors;
}

function changedProductionFiles(base) {
  const result = runGit(['diff', '--name-only', '--diff-filter=ACMRT', base, 'HEAD', '--', 'src']);
  if (result.status !== 0) throw new Error(result.stderr || `Unable to diff ${base}..HEAD`);
  return result.stdout.trim().split('\n').filter((file) => file.endsWith('.ts') && fs.existsSync(path.join(root, file))).sort();
}

export function parseAddedLines(diff) {
  const lines = new Set();
  for (const line of String(diff).split('\n')) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
  }
  return lines;
}

function changedLinesForFile(base, file) {
  const result = runGit(['diff', '--unified=0', '--no-color', base, 'HEAD', '--', file]);
  if (result.status !== 0) throw new Error(result.stderr || `Unable to diff ${base}..HEAD for ${file}`);
  return parseAddedLines(result.stdout);
}

function locationStartsOnChangedLine(location, changedLines) {
  return Boolean(location?.start && changedLines.has(location.start.line));
}

export function changedExecutableCoverage(record, changedLines) {
  const lineHits = new Map();
  for (const [id, location] of Object.entries(record?.statementMap ?? {})) {
    if (!location?.start || !location?.end) continue;
    for (let line = location.start.line; line <= location.end.line; line += 1) {
      if (!changedLines.has(line)) continue;
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, Number(record?.s?.[id] ?? 0)));
    }
  }

  const branchHits = [];
  for (const [id, branch] of Object.entries(record?.branchMap ?? {})) {
    const locations = Array.isArray(branch?.locations) ? branch.locations : [];
    const hits = Array.isArray(record?.b?.[id]) ? record.b[id] : [];
    if (locationStartsOnChangedLine(branch?.loc, changedLines)) {
      branchHits.push(...hits);
    } else {
      locations.forEach((location, index) => {
        if (locationStartsOnChangedLine(location, changedLines)) branchHits.push(hits[index] ?? 0);
      });
    }
  }

  const functionHits = [];
  for (const [id, fn] of Object.entries(record?.fnMap ?? {})) {
    if (locationStartsOnChangedLine(fn?.decl ?? fn?.loc, changedLines)) {
      functionHits.push(Number(record?.f?.[id] ?? 0));
    }
  }

  const lines = [...lineHits.values()];
  const metric = (hits) => ({
    total: hits.length,
    covered: hits.filter((hitsForItem) => Number(hitsForItem) > 0).length,
  });
  return {
    lines: metric(lines),
    branches: metric(branchHits),
    functions: metric(functionHits),
    statements: metric(lines),
  };
}

function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--base');
  const base = index === -1 ? null : args[index + 1];
  const planOnly = args.includes('--plan');
  if (!base) {
    console.error('Usage: changed-coverage-gate.mjs --base <sha> [--plan]');
    process.exit(64);
  }
  const exactBase = resolveExactCommit(root, base);
  if (!exactBase) {
    console.error(`Coverage base does not resolve: ${base}`);
    process.exit(2);
  }

  const policy = loadTestPolicy();
  const files = changedProductionFiles(exactBase);
  const criticalFiles = files.filter((file) => isCriticalModule(file, policy.mutation.criticalModulePatterns));
  const outputDir = path.join(root, '.local/coverage/changed');
  fs.mkdirSync(outputDir, { recursive: true });
  const planPath = path.join(outputDir, 'plan.json');
  const plan = {
    schema: 'nexus.changed-coverage-plan.v1',
    base: exactBase,
    head: resolveExactCommit(root, 'HEAD'),
    measurement: 'changed-executable-lines-and-branches',
    files,
    criticalFiles,
    thresholds: policy.coverage,
  };
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify(plan, null, 2));
  if (planOnly || files.length === 0) {
    if (files.length === 0) console.log('No changed production TypeScript resolved; changed coverage skipped.');
    return;
  }

  const classifierPath = path.join(outputDir, 'classifier.json');
  const classifier = run('bash', ['scripts/changed-area-classifier.sh', '--json', '--base', exactBase]);
  if (classifier.status !== 0) {
    process.stderr.write(classifier.stderr || classifier.stdout);
    process.exit(classifier.status ?? 1);
  }
  fs.writeFileSync(classifierPath, classifier.stdout);
  const selected = run(process.execPath, [
    'scripts/select-vitest-files.mjs', '--base', exactBase, '--classifier', classifierPath,
    '--coverage',
  ]);
  if (selected.status !== 0) {
    process.stderr.write(selected.stderr || selected.stdout);
    process.exit(selected.status ?? 1);
  }
  const tests = selected.stdout.trim().split('\n').filter(Boolean);
  if (tests.length === 0) {
    console.error('Changed coverage resolved production files but no tests; failing closed.');
    process.exit(1);
  }

  const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
  const shardCount = coverageShardCount(tests.length);
  const shardRoot = path.join(root, '.local/coverage/changed-shards');
  const blobDir = path.join(shardRoot, 'blobs');
  fs.rmSync(shardRoot, { recursive: true, force: true });
  fs.mkdirSync(blobDir, { recursive: true });
  const testSelection = {
    schema: 'nexus.changed-coverage-selection.v1',
    count: tests.length,
    shardCount,
    digest: createHash('sha256').update(JSON.stringify(tests)).digest('hex'),
    tests,
  };
  const selectionPath = path.join(outputDir, 'selection.json');
  fs.writeFileSync(selectionPath, `${JSON.stringify(testSelection, null, 2)}\n`);
  console.log(JSON.stringify({
    changedCoverageTests: tests.length,
    shardCount,
    selectionDigest: testSelection.digest,
  }, null, 2));

  const commonCoverageArgs = [
    '--coverage',
    '--coverage.reporter=json',
    '--coverage.thresholds.lines=0',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0',
    '--coverage.thresholds.statements=0',
    ...files.flatMap((file) => ['--coverage.include', file]),
  ];
  for (let shard = 1; shard <= shardCount; shard += 1) {
    const shardCoverageDir = path.join(shardRoot, `coverage-${shard}`);
    const shardRun = spawnSync(process.execPath, [
      vitest,
      'run',
      '--reporter=blob',
      `--outputFile=${path.join(blobDir, `blob-${shard}.json`)}`,
      `--shard=${shard}/${shardCount}`,
      `--coverage.reportsDirectory=${shardCoverageDir}`,
      ...commonCoverageArgs,
      ...tests,
    ], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    const failure = processFailure(shardRun, `Changed coverage shard ${shard}/${shardCount}`);
    if (failure) {
      console.error(failure);
      process.exit(shardRun.status ?? 1);
    }
  }

  const mergeRun = spawnSync(process.execPath, [
    vitest,
    `--merge-reports=${blobDir}`,
    '--reporter=dot',
    '--coverage',
    '--coverage.reporter=json-summary',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${outputDir}`,
    '--coverage.thresholds.lines=0',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0',
    '--coverage.thresholds.statements=0',
    ...files.flatMap((file) => ['--coverage.include', file]),
  ], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  // V8 clears its reports directory before writing. Restore the separately
  // governed selection plan so the uploaded artifact remains self-contained.
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(classifierPath, classifier.stdout);
  fs.writeFileSync(selectionPath, `${JSON.stringify(testSelection, null, 2)}\n`);
  const mergeFailure = processFailure(mergeRun, 'Changed coverage report merge');
  if (mergeFailure) {
    console.error(mergeFailure);
    process.exit(mergeRun.status ?? 1);
  }
  fs.rmSync(shardRoot, { recursive: true, force: true });

  const summaryPath = path.join(outputDir, 'coverage-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const byFile = new Map(Object.entries(summary)
    .filter(([file]) => file !== 'total')
    .map(([file, record]) => [path.relative(root, file).split(path.sep).join('/'), record]));
  const missing = files.filter((file) => !byFile.has(file));
  const detailedPath = path.join(outputDir, 'coverage-final.json');
  const detailed = JSON.parse(fs.readFileSync(detailedPath, 'utf8'));
  const detailedByFile = new Map(Object.entries(detailed)
    .map(([file, record]) => [path.relative(root, file).split(path.sep).join('/'), record]));
  const missingDetailed = files.filter((file) => !detailedByFile.has(file));
  const changedLineSets = new Map(files.map((file) => [file, changedLinesForFile(exactBase, file)]));
  const exceptionErrors = policy.coverage.exceptions.flatMap((exception) => validateCoverageException(exception));
  const exceptionByFile = new Map(policy.coverage.exceptions.map((exception) => [exception.file, exception]));
  const usedExceptions = files.filter((file) => exceptionByFile.has(file));
  const governedFiles = files.filter((file) => !exceptionByFile.has(file));
  const governedCriticalFiles = criticalFiles.filter((file) => !exceptionByFile.has(file));
  const changedCoverageByFile = Object.fromEntries(governedFiles.map((file) => [
    file,
    changedExecutableCoverage(detailedByFile.get(file), changedLineSets.get(file)),
  ]));
  const changedCoverage = aggregateCoverage(Object.values(changedCoverageByFile));
  const criticalCoverage = aggregateCoverage(governedCriticalFiles
    .map((file) => changedCoverageByFile[file]));
  const exceptionRatchetFailures = usedExceptions.flatMap((file) => {
    const record = byFile.get(file);
    return record
      ? thresholdFailures(`coverage exception ${file}`, aggregateCoverage([record]), exceptionByFile.get(file).minimum)
      : [];
  });
  const failures = [
    ...exceptionErrors,
    ...missing.map((file) => `Changed source missing from coverage output: ${file}`),
    ...missingDetailed.map((file) => `Changed source missing from detailed coverage output: ${file}`),
    ...thresholdFailures('changed production code', changedCoverage, policy.coverage.changed),
    ...(governedCriticalFiles.length > 0
      ? thresholdFailures('critical changed modules', criticalCoverage, policy.coverage.critical)
      : []),
    ...exceptionRatchetFailures,
  ];
  const result = {
    ...plan,
    schema: 'nexus.changed-coverage-result.v2',
    tests: tests.length,
    shardCount,
    testSelectionDigest: testSelection.digest,
    governedFiles,
    governedCriticalFiles,
    usedExceptions: usedExceptions.map((file) => exceptionByFile.get(file)),
    changedCoverageByFile,
    changedCoverage,
    criticalCoverage: governedCriticalFiles.length > 0 ? criticalCoverage : null,
    missing: [...new Set([...missing, ...missingDetailed])],
    failures,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.writeFileSync(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
