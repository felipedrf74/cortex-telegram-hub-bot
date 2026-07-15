#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isCriticalModule } from './mutation-gate.mjs';
import { loadTestPolicy, root } from './lib/test-policy.mjs';

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
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
  const result = run('git', ['diff', '--name-only', '--diff-filter=ACMRT', base, 'HEAD', '--', 'src']);
  if (result.status !== 0) throw new Error(result.stderr || `Unable to diff ${base}..HEAD`);
  return result.stdout.trim().split('\n').filter((file) => file.endsWith('.ts') && fs.existsSync(path.join(root, file))).sort();
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
  if (run('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    console.error(`Coverage base does not resolve: ${base}`);
    process.exit(2);
  }

  const policy = loadTestPolicy();
  const files = changedProductionFiles(base);
  const criticalFiles = files.filter((file) => isCriticalModule(file, policy.mutation.criticalModulePatterns));
  const outputDir = path.join(root, '.local/coverage/changed');
  fs.mkdirSync(outputDir, { recursive: true });
  const planPath = path.join(outputDir, 'plan.json');
  const plan = {
    schema: 'nexus.changed-coverage-plan.v1',
    base,
    head: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
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
  const classifier = run('bash', ['scripts/changed-area-classifier.sh', '--json', '--base', base]);
  if (classifier.status !== 0) {
    process.stderr.write(classifier.stderr || classifier.stdout);
    process.exit(classifier.status ?? 1);
  }
  fs.writeFileSync(classifierPath, classifier.stdout);
  const selected = run(process.execPath, [
    'scripts/select-vitest-files.mjs', '--base', base, '--classifier', classifierPath,
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
  const coverageArgs = [
    vitest,
    'run',
    '--reporter=dot',
    '--coverage',
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${outputDir}`,
    '--coverage.thresholds.lines=0',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0',
    '--coverage.thresholds.statements=0',
    ...files.flatMap((file) => ['--coverage.include', file]),
    ...tests,
  ];
  const coverageRun = spawnSync(process.execPath, coverageArgs, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (coverageRun.status !== 0) process.exit(coverageRun.status ?? 1);
  // V8 clears its reports directory before writing. Restore the separately
  // governed selection plan so the uploaded artifact remains self-contained.
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const summaryPath = path.join(outputDir, 'coverage-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const byFile = new Map(Object.entries(summary)
    .filter(([file]) => file !== 'total')
    .map(([file, record]) => [path.relative(root, file).split(path.sep).join('/'), record]));
  const missing = files.filter((file) => !byFile.has(file));
  const exceptionErrors = policy.coverage.exceptions.flatMap((exception) => validateCoverageException(exception));
  const exceptionByFile = new Map(policy.coverage.exceptions.map((exception) => [exception.file, exception]));
  const usedExceptions = files.filter((file) => exceptionByFile.has(file));
  const governedFiles = files.filter((file) => !exceptionByFile.has(file));
  const governedCriticalFiles = criticalFiles.filter((file) => !exceptionByFile.has(file));
  const changedCoverage = aggregateCoverage(governedFiles.map((file) => byFile.get(file)).filter(Boolean));
  const criticalCoverage = aggregateCoverage(governedCriticalFiles.map((file) => byFile.get(file)).filter(Boolean));
  const exceptionRatchetFailures = usedExceptions.flatMap((file) => {
    const record = byFile.get(file);
    return record
      ? thresholdFailures(`coverage exception ${file}`, aggregateCoverage([record]), exceptionByFile.get(file).minimum)
      : [];
  });
  const failures = [
    ...exceptionErrors,
    ...missing.map((file) => `Changed source missing from coverage output: ${file}`),
    ...thresholdFailures('changed production code', changedCoverage, policy.coverage.changed),
    ...(governedCriticalFiles.length > 0
      ? thresholdFailures('critical changed modules', criticalCoverage, policy.coverage.critical)
      : []),
    ...exceptionRatchetFailures,
  ];
  const result = {
    schema: 'nexus.changed-coverage-result.v1',
    ...plan,
    tests: tests.length,
    governedFiles,
    governedCriticalFiles,
    usedExceptions: usedExceptions.map((file) => exceptionByFile.get(file)),
    changedCoverage,
    criticalCoverage: governedCriticalFiles.length > 0 ? criticalCoverage : null,
    missing,
    failures,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.writeFileSync(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
