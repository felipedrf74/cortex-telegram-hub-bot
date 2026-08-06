#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCriticalModule, parseAddedLines } from './mutation-gate.mjs';
import { cleanGitEnv, resolveExactCommit } from './lib/git-ref.mjs';
import { loadTestPolicy, root } from './lib/test-policy.mjs';

export { parseAddedLines, resolveExactCommit };

function runGit(args) {
  return execFileSync('git', args, {
    cwd: root,
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function branchMetricSummary(label, coverage) {
  const branches = coverage?.branches;
  return branches
    ? `${label}=${branches.covered}/${branches.total} (${branches.pct}%)`
    : `${label}=n/a`;
}

export function formatCoverageGateSummary(result, evidencePath) {
  const lines = [
    `Changed coverage gate: ${result.verdict}`
      + ` selectedTests=${result.selectedTestCount}`
      + ` ${branchMetricSummary('changedBranches', result.changedCoverage)}`
      + ` ${branchMetricSummary('criticalBranches', result.criticalCoverage)}`
      + ` evidence=${evidencePath}`,
  ];
  for (const failure of result.failures ?? []) lines.push(`- ${failure}`);
  return `${lines.join('\n')}\n`;
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

  const metric = (hits) => ({
    total: hits.length,
    covered: hits.filter((value) => Number(value) > 0).length,
  });
  const lines = [...lineHits.values()];
  return {
    lines: metric(lines),
    branches: metric(branchHits),
    functions: metric(functionHits),
    statements: metric(lines),
  };
}

export function fullFileCoverage(record) {
  const lineHits = new Map();
  for (const [id, location] of Object.entries(record?.statementMap ?? {})) {
    if (!location?.start) continue;
    const line = location.start.line;
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, Number(record?.s?.[id] ?? 0)));
  }
  const metric = (hits) => ({
    total: hits.length,
    covered: hits.filter((value) => Number(value) > 0).length,
  });
  const statements = Object.values(record?.s ?? {}).map(Number);
  const branches = Object.values(record?.b ?? {}).flat().map(Number);
  const functions = Object.values(record?.f ?? {}).map(Number);
  return {
    lines: metric([...lineHits.values()]),
    branches: metric(branches),
    functions: metric(functions),
    statements: metric(statements),
  };
}

export function analyzeExistingCoverage({
  base,
  head,
  files,
  coverageRequiredFiles = files,
  criticalFiles,
  coverageByFile,
  changedLineSets,
  policy,
  selectedTests,
}) {
  const exceptionErrors = policy.coverage.exceptions
    .flatMap((exception) => validateCoverageException(exception));
  const exceptionByFile = new Map(policy.coverage.exceptions.map((exception) => [exception.file, exception]));
  const usedExceptions = coverageRequiredFiles.filter((file) => exceptionByFile.has(file));
  const governedFiles = coverageRequiredFiles.filter((file) => !exceptionByFile.has(file));
  const governedCriticalFiles = criticalFiles
    .filter((file) => coverageRequiredFiles.includes(file) && !exceptionByFile.has(file));
  const missing = coverageRequiredFiles.filter((file) => !coverageByFile.has(file));
  const changedCoverageByFile = Object.fromEntries(governedFiles.map((file) => [
    file,
    changedExecutableCoverage(coverageByFile.get(file), changedLineSets.get(file) ?? new Set()),
  ]));
  const changedCoverage = aggregateCoverage(Object.values(changedCoverageByFile));
  const criticalCoverage = aggregateCoverage(
    governedCriticalFiles.map((file) => changedCoverageByFile[file]),
  );
  const exceptionRatchetFailures = usedExceptions.flatMap((file) => {
    const record = coverageByFile.get(file);
    return record
      ? thresholdFailures(
        `coverage exception ${file}`,
        aggregateCoverage([fullFileCoverage(record)]),
        exceptionByFile.get(file).minimum,
      )
      : [];
  });
  const failures = [
    ...exceptionErrors,
    ...missing.map((file) => `Changed source missing from selected-test coverage output: ${file}`),
    ...thresholdFailures('changed production code', changedCoverage, policy.coverage.changed),
    ...(governedCriticalFiles.length > 0
      ? thresholdFailures('critical changed modules', criticalCoverage, policy.coverage.critical)
      : []),
    ...exceptionRatchetFailures,
  ];
  return {
    schema: 'nexus.changed-coverage-result.v3',
    analysisOnly: true,
    base,
    head,
    files,
    coverageRequiredFiles,
    criticalFiles,
    selectedTestCount: selectedTests.length,
    testSelectionDigest: createHash('sha256').update(JSON.stringify(selectedTests)).digest('hex'),
    governedFiles,
    governedCriticalFiles,
    usedExceptions: usedExceptions.map((file) => exceptionByFile.get(file)),
    changedCoverageByFile,
    changedCoverage,
    criticalCoverage: governedCriticalFiles.length > 0 ? criticalCoverage : null,
    missing,
    failures,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };
}

function normalizeCoveragePath(file) {
  let candidate = file;
  if (candidate.startsWith('file:')) candidate = fileURLToPath(candidate);
  return (path.isAbsolute(candidate) ? path.relative(root, candidate) : candidate)
    .split(path.sep)
    .join('/');
}

function valueOf(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function hasPotentialExecutableAddition(file, changedLines) {
  if (changedLines.size === 0) return false;
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  return [...changedLines].some((lineNumber) => {
    const line = (lines[lineNumber - 1] ?? '').trim();
    return line.length > 0
      && !/^(?:\/\/|\/\*|\*|\*\/)/.test(line)
      && !/^(?:import(?:\s+type)?|export\s+type|type|interface|declare)\b/.test(line)
      && !/^[{}()[\],;]+$/.test(line);
  });
}

function main() {
  const args = process.argv.slice(2);
  const base = valueOf(args, '--base');
  const classifierPath = valueOf(args, '--classifier');
  const selectionPath = valueOf(args, '--selection');
  const coverageDir = path.resolve(root, valueOf(args, '--coverage-dir', '.local/coverage/selected'));
  if (!base || !classifierPath || !selectionPath) {
    console.error(
      'Usage: changed-coverage-gate.mjs --base <sha> --classifier <json> '
      + '--selection <json> [--coverage-dir .local/coverage/selected]',
    );
    process.exit(64);
  }

  const exactBase = resolveExactCommit(root, base);
  if (!exactBase) {
    console.error(`Coverage base does not resolve: ${base}`);
    process.exit(2);
  }
  const classifier = JSON.parse(fs.readFileSync(classifierPath, 'utf8'));
  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  if (!Array.isArray(classifier.changedFiles) || !Array.isArray(selection.selected)) {
    throw new Error('Classifier changedFiles and selection selected arrays are required');
  }
  const files = classifier.changedFiles
    .filter((file) => /^src\/.+\.ts$/.test(file) && fs.existsSync(path.join(root, file)))
    .sort();
  const policy = loadTestPolicy();
  const criticalFiles = files.filter((file) => (
    isCriticalModule(file, policy.mutation.criticalModulePatterns)
  ));
  const detailedPath = path.join(coverageDir, 'coverage-final.json');
  const detailed = files.length === 0
    ? {}
    : JSON.parse(fs.readFileSync(detailedPath, 'utf8'));
  const coverageByFile = new Map(
    Object.entries(detailed).map(([file, record]) => [normalizeCoveragePath(file), record]),
  );
  const changedLineSets = new Map(files.map((file) => {
    const diff = runGit(['diff', '--unified=0', '--no-color', exactBase, '--', file]);
    return [file, parseAddedLines(diff)];
  }));
  const coverageRequiredFiles = files.filter((file) => (
    hasPotentialExecutableAddition(file, changedLineSets.get(file))
  ));
  const result = analyzeExistingCoverage({
    base: exactBase,
    head: resolveExactCommit(root, 'HEAD'),
    files,
    coverageRequiredFiles,
    criticalFiles,
    coverageByFile,
    changedLineSets,
    policy,
    selectedTests: selection.selected,
  });
  fs.mkdirSync(coverageDir, { recursive: true });
  const evidencePath = path.join(coverageDir, 'changed-lines.json');
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  const summary = formatCoverageGateSummary(
    result,
    path.relative(root, evidencePath).split(path.sep).join('/'),
  );
  if (result.failures.length > 0) {
    process.stderr.write(summary);
    process.exitCode = 1;
  } else {
    process.stdout.write(summary);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
