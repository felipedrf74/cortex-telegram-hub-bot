#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  loadTestPolicy,
  matchFiles,
  partitionTestFiles,
  resolveTestDisposition,
  root,
  walkTestFiles,
} from './lib/test-policy.mjs';

const args = process.argv.slice(2);
const valueOf = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const timingsPath = valueOf('--timings');
const timingScope = timingsPath ? valueOf('--timing-scope', 'all') : 'none';
const enforceEvidence = args.includes('--enforce-evidence');
const timingMode = valueOf('--timing-mode', 'enforce');
const policy = loadTestPolicy();
const files = walkTestFiles();
const partitions = partitionTestFiles(files, policy);
const timingSamplesByFile = new Map();

if (!['none', 'all', 'deterministic', 'evaluate'].includes(timingScope)) {
  console.error('--timing-scope must be one of all, deterministic, or evaluate when --timings is supplied.');
  process.exit(64);
}
if (!['advisory', 'enforce'].includes(timingMode)) {
  console.error('--timing-mode must be advisory or enforce.');
  process.exit(64);
}

function normalizeTestPath(value) {
  const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
  return path.relative(root, absolute).split(path.sep).join('/');
}

if (timingsPath) {
  if (!fs.existsSync(timingsPath)) {
    console.error(`Timing report does not exist: ${timingsPath}`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
  for (const result of report.testResults ?? []) {
    const file = normalizeTestPath(result.name);
    const samples = timingSamplesByFile.get(file) ?? [];
    samples.push(Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)));
    timingSamplesByFile.set(file, samples);
  }
}

function percentile(samples, fraction) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function percentage(numerator, denominator) {
  if (denominator === 0) return 100;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

const tierSets = Object.fromEntries(Object.entries(policy.tiers).map(([tier, config]) => [
  tier,
  new Set(config.include ? matchFiles(files, config.include) : []),
]));
const timingExceptions = new Map((policy.timingExceptions ?? []).map((exception) => [exception.file, exception]));
const evidencePolicy = policy.inventoryEvidence ?? {};
const minimumPercentileSamples = evidencePolicy.timing?.minimumSamplesForPercentiles ?? 5;

const records = files.map((file) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const dependencies = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((value) => value.includes('/src/'));
  const resolution = resolveTestDisposition(file, policy);
  const timingSamples = timingSamplesByFile.get(file) ?? [];
  const tiers = Object.entries(tierSets).filter(([, set]) => set.has(file)).map(([tier]) => tier);
  if (resolution?.disposition === 'eval' && !tiers.includes('evaluate')) tiers.push('evaluate');
  if (tiers.length === 0) tiers.push(policy.defaultTier);
  const qualifiedPercentiles = timingSamples.length >= minimumPercentileSamples;
  return {
    file,
    owner: file.split('/')[1] ?? 'unknown',
    tiers,
    risks: [
      file.includes('/security/') || file.includes('/scope/') ? 'tenant-security' : null,
      file.includes('migration') ? 'migration' : null,
      file.includes('billing') || file.includes('cost-guardrail') ? 'billing' : null,
      file.includes('provider') ? 'provider-routing' : null,
      file.includes('release') || file.includes('deploy') || file.includes('rollback') ? 'release' : null,
    ].filter(Boolean),
    sourceDependencies: [...new Set(dependencies)].sort(),
    runtimeMs: timingSamples.at(-1) ?? null,
    runtimeSampleCount: timingSamples.length,
    runtimeP50Ms: qualifiedPercentiles ? percentile(timingSamples, 0.50) : null,
    runtimeP95Ms: qualifiedPercentiles ? percentile(timingSamples, 0.95) : null,
    runtimeEvidence: timingSamples.length === 0
      ? 'not-collected'
      : qualifiedPercentiles ? 'percentiles-qualified' : 'insufficient-history-for-percentiles',
    timingException: timingExceptions.get(file) ?? null,
    uniqueCoverage: null,
    uniqueCoverageEvidence: 'not-collected',
    lastFailure: null,
    lastFailureEvidence: 'not-collected',
    disposition: resolution?.disposition ?? null,
    dispositionReason: resolution?.reason ?? null,
    dispositionProvenance: resolution?.provenance ?? null,
  };
});

const missing = records.filter((record) => !record.disposition);
if (missing.length > 0) {
  console.error(`Test policy left ${missing.length} files without a disposition.`);
  process.exit(1);
}

const expectedTimingFiles = timingScope === 'all'
  ? files
  : timingScope === 'deterministic'
    ? partitions.deterministic
    : timingScope === 'evaluate'
      ? partitions.evaluation
      : [];
const expectedTimingSet = new Set(expectedTimingFiles);
const observedTimingFiles = [...timingSamplesByFile.keys()].filter((file) => expectedTimingSet.has(file));
const unexpectedTimingFiles = [...timingSamplesByFile.keys()].filter((file) => !expectedTimingSet.has(file)).sort();
const timingScopePercent = timingScope === 'none'
  ? null
  : percentage(observedTimingFiles.length, expectedTimingFiles.length);
const uniqueCoverageFiles = records.filter((record) => record.uniqueCoverage !== null).length;
const lastFailureFiles = records.filter((record) => record.lastFailure !== null).length;
const resolvedDispositionFiles = records.filter((record) => record.disposition !== null).length;
const patternFallbackFiles = records.filter((record) => record.dispositionProvenance?.kind === 'pattern').length;
const maximumPatternFallbackFiles = evidencePolicy.disposition?.maximumPatternFallbackFiles ?? records.length;

const configuredOutput = valueOf('--output');
const outputDir = configuredOutput
  ? path.dirname(path.resolve(root, configuredOutput))
  : path.join(root, '.local/test-inventory');
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = configuredOutput
  ? path.resolve(root, configuredOutput)
  : path.join(outputDir, 'test-inventory.json');
const summary = {
  schema: 'nexus.test-inventory.v3',
  policyVersion: policy.version,
  generatedAt: new Date().toISOString(),
  testFiles: records.length,
  deterministicFiles: partitions.deterministic.length,
  evaluationFiles: partitions.evaluation.length,
  byDisposition: Object.fromEntries(['keep', 'merge', 'convert', 'eval', 'delete'].map((value) => [
    value,
    records.filter((record) => record.disposition === value).length,
  ])),
  byDispositionProvenance: Object.fromEntries(['exact', 'pattern'].map((value) => [
    value,
    records.filter((record) => record.dispositionProvenance?.kind === value).length,
  ])),
  timedFiles: records.filter((record) => record.runtimeMs !== null).length,
  slowNonExemptFiles: records.filter((record) => record.runtimeMs > 10_000 && !record.timingException).length,
  timingGovernance: {
    mode: timingMode,
    thresholdMs: 10_000,
  },
  evidenceCompleteness: {
    disposition: {
      observedFiles: resolvedDispositionFiles,
      expectedFiles: records.length,
      percent: percentage(resolvedDispositionFiles, records.length),
      provenanceRecorded: records.every((record) => record.dispositionProvenance !== null),
      patternFallbackFiles,
      maximumPatternFallbackFiles,
      withinPatternFallbackBudget: patternFallbackFiles <= maximumPatternFallbackFiles,
    },
    timing: {
      requested: timingScope !== 'none',
      scope: timingScope,
      observedFiles: observedTimingFiles.length,
      expectedFiles: expectedTimingFiles.length,
      percent: timingScopePercent,
      complete: timingScope !== 'none' && timingScopePercent === 100 && unexpectedTimingFiles.length === 0,
      unexpectedFiles: unexpectedTimingFiles,
      minimumSamplesForPercentiles: minimumPercentileSamples,
      percentileQualifiedFiles: records.filter((record) => record.runtimeEvidence === 'percentiles-qualified').length,
    },
    uniqueCoverage: {
      collectionStatus: uniqueCoverageFiles === 0 ? 'not-collected' : 'partial',
      observedFiles: uniqueCoverageFiles,
      expectedFiles: records.length,
      percent: percentage(uniqueCoverageFiles, records.length),
    },
    lastFailure: {
      collectionStatus: lastFailureFiles === 0 ? 'not-collected' : 'partial',
      observedFiles: lastFailureFiles,
      expectedFiles: records.length,
      percent: percentage(lastFailureFiles, records.length),
    },
  },
};
fs.writeFileSync(outputPath, `${JSON.stringify({ summary, records }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath: path.relative(root, outputPath), ...summary }, null, 2));

if (patternFallbackFiles > maximumPatternFallbackFiles) {
  console.error(`Pattern-fallback dispositions increased to ${patternFallbackFiles}; maximum is ${maximumPatternFallbackFiles}.`);
  process.exit(1);
}

if (enforceEvidence) {
  const requiredTimingPercent = evidencePolicy.timing?.minimumScopePercent ?? 100;
  const requiredUniqueCoveragePercent = evidencePolicy.uniqueCoverage?.minimumPercent ?? 0;
  const requiredLastFailurePercent = evidencePolicy.lastFailure?.minimumPercent ?? 0;
  if (timingScope === 'none') {
    console.error('--enforce-evidence requires --timings and an explicit timing scope.');
    process.exit(1);
  }
  if (unexpectedTimingFiles.length > 0 || timingScopePercent < requiredTimingPercent) {
    console.error(`Timing evidence covers ${timingScopePercent}% of ${timingScope}; required ${requiredTimingPercent}%.`);
    process.exit(1);
  }
  if (summary.evidenceCompleteness.uniqueCoverage.percent < requiredUniqueCoveragePercent
      || summary.evidenceCompleteness.lastFailure.percent < requiredLastFailurePercent) {
    console.error('Inventory evidence is below the governed incremental minimum.');
    process.exit(1);
  }
}

if (timingsPath && summary.slowNonExemptFiles > 0) {
  const slow = records
    .filter((record) => record.runtimeMs > 10_000 && !record.timingException)
    .sort((a, b) => b.runtimeMs - a.runtimeMs);
  const label = timingMode === 'enforce' ? 'Slow-test governance' : 'Slow-test advisory';
  console.error(`${label}: ${slow.length} file(s) exceed 10s without a timingExceptions entry in config/test-policy.json:`);
  for (const record of slow) {
    console.error(`  ${Math.round(record.runtimeMs)}ms ${record.file}`);
  }
  if (timingMode === 'enforce') process.exit(1);
}
