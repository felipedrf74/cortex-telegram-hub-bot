#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadTestPolicy,
  matchFiles,
  partitionTestFiles,
  resolveTestDisposition,
  root as repositoryRoot,
  walkTestFiles,
} from './lib/test-policy.mjs';

const INVENTORY_SCHEMA = 'nexus.test-inventory.v4';
const TIMING_IDENTITY_SCHEMA = 'nexus.test-timing-identity.v1';
const MAX_HISTORY_CANDIDATES = 10;
const MAX_HISTORY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_DEPTH = 4;
const MAX_HISTORY_ENTRIES = 64;
const args = process.argv.slice(2);
const valueOf = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const root = path.resolve(valueOf('--root', repositoryRoot));
const timingsPath = valueOf('--timings');
const timingScope = timingsPath ? valueOf('--timing-scope', 'all') : 'none';
const timingHistoryDir = valueOf('--timing-history-dir');
const enforceEvidence = args.includes('--enforce-evidence');
const timingMode = valueOf('--timing-mode', 'enforce');
const policy = loadTestPolicy(root);
const files = walkTestFiles(root);
const partitions = partitionTestFiles(files, policy);
const currentTimingSamplesByFile = new Map();

if (!['none', 'all', 'deterministic', 'evaluate'].includes(timingScope)) {
  console.error('--timing-scope must be one of all, deterministic, or evaluate when --timings is supplied.');
  process.exit(64);
}
if (!['advisory', 'enforce'].includes(timingMode)) {
  console.error('--timing-mode must be advisory or enforce.');
  process.exit(64);
}
if (timingHistoryDir && !timingsPath) {
  console.error('--timing-history-dir requires --timings.');
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
    const samples = currentTimingSamplesByFile.get(file) ?? [];
    samples.push(Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)));
    currentTimingSamplesByFile.set(file, samples);
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readVitestVersion() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    return lock.packages?.['node_modules/vitest']?.version ?? null;
  } catch {
    return null;
  }
}

const policyDigest = sha256(fs.readFileSync(path.join(root, 'config/test-policy.json')));
const timingIdentity = {
  schema: TIMING_IDENTITY_SCHEMA,
  policyDigest,
  scope: timingScope,
  toolchain: {
    node: process.versions.node,
    vitest: readVitestVersion(),
    platform: process.platform,
    arch: process.arch,
  },
  source: {
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    headSha: process.env.GITHUB_SHA ?? null,
  },
};

const tierSets = Object.fromEntries(Object.entries(policy.tiers).map(([tier, config]) => [
  tier,
  new Set(config.include ? matchFiles(files, config.include) : []),
]));
const timingExceptions = new Map((policy.timingExceptions ?? []).map((exception) => [exception.file, exception]));
const evidencePolicy = policy.inventoryEvidence ?? {};
const minimumPercentileSamples = evidencePolicy.timing?.minimumSamplesForPercentiles ?? 5;
const maximumPercentileSamples = evidencePolicy.timing?.maximumSamplesForPercentiles ?? 5;
if (!Number.isInteger(minimumPercentileSamples) || minimumPercentileSamples < 1
    || !Number.isInteger(maximumPercentileSamples)
    || maximumPercentileSamples < minimumPercentileSamples) {
  console.error('Inventory timing sample policy is invalid.');
  process.exit(1);
}
const maximumHistoryArtifacts = Math.max(0, maximumPercentileSamples - 1);

function collectInventoryFiles(directory) {
  const inventoryFiles = [];
  const rejectionReasons = {};
  let namedCandidates = 0;
  let visitedEntries = 0;
  let failure = null;
  const reject = (reason) => {
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  };
  const rootStat = fs.lstatSync(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {
      inventoryFiles: [],
      namedCandidates: 0,
      rejectionReasons: { 'history-root-type': 1 },
      failure: 'history-root-type',
      visitedEntries: 0,
    };
  }
  const walk = (current, depth) => {
    if (failure) return;
    if (depth > MAX_HISTORY_DEPTH) {
      failure = 'discovery-depth';
      return;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    visitedEntries += entries.length;
    if (visitedEntries > MAX_HISTORY_ENTRIES) {
      failure = 'discovery-entries';
      return;
    }
    for (const entry of entries) {
      if (failure) return;
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (entry.name === 'test-inventory.json') {
        namedCandidates += 1;
        if (namedCandidates > MAX_HISTORY_CANDIDATES) {
          failure = 'candidate-limit';
          return;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) reject('candidate-type');
        else inventoryFiles.push(absolute);
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(absolute, depth + 1);
      }
    }
  };
  walk(directory, 0);
  return {
    inventoryFiles: failure ? [] : inventoryFiles,
    namedCandidates,
    rejectionReasons,
    failure,
    visitedEntries,
  };
}

function sameToolchain(candidate) {
  return candidate?.node === timingIdentity.toolchain.node
    && candidate?.vitest === timingIdentity.toolchain.vitest
    && candidate?.platform === timingIdentity.toolchain.platform
    && candidate?.arch === timingIdentity.toolchain.arch;
}

function validCiSource(source) {
  return source?.workflow === timingIdentity.source.workflow
    && /^[1-9]\d*$/.test(String(source?.runId ?? ''))
    && /^[1-9]\d*$/.test(String(source?.runAttempt ?? ''))
    && /^[0-9a-f]{40}$/.test(source?.headSha ?? '');
}

function inspectHistoryCandidate(candidatePath) {
  let inventory;
  try {
    const stat = fs.lstatSync(candidatePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { compatible: false, reason: 'candidate-type' };
    }
    if (stat.size < 1 || stat.size > MAX_HISTORY_FILE_BYTES) {
      return { compatible: false, reason: 'inventory-size' };
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const descriptor = fs.openSync(candidatePath, fs.constants.O_RDONLY | noFollow);
    try {
      const openedStat = fs.fstatSync(descriptor);
      if (!openedStat.isFile() || openedStat.size !== stat.size
          || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
        return { compatible: false, reason: 'candidate-type' };
      }
      const bytes = Buffer.alloc(openedStat.size);
      const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (read !== bytes.length) return { compatible: false, reason: 'short-read' };
      inventory = JSON.parse(bytes.toString('utf8'));
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { compatible: false, reason: 'malformed-json' };
  }
  const { summary, records } = inventory ?? {};
  if (summary?.schema !== INVENTORY_SCHEMA) {
    return { compatible: false, reason: 'inventory-schema' };
  }
  if (summary.timingIdentity?.schema !== TIMING_IDENTITY_SCHEMA) {
    return { compatible: false, reason: 'timing-identity-schema' };
  }
  if (summary.timingIdentity.policyDigest !== policyDigest) {
    return { compatible: false, reason: 'test-policy-digest' };
  }
  if (summary.timingIdentity.scope !== timingScope) {
    return { compatible: false, reason: 'timing-scope' };
  }
  if (!sameToolchain(summary.timingIdentity.toolchain)) {
    return { compatible: false, reason: 'toolchain' };
  }
  if (timingIdentity.source.workflow !== null
      && !validCiSource(summary.timingIdentity.source)) {
    return { compatible: false, reason: 'ci-source' };
  }
  const generatedAtMs = Date.parse(summary.generatedAt ?? '');
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > Date.now() + 5 * 60_000) {
    return { compatible: false, reason: 'generated-at' };
  }
  if (summary.evidenceCompleteness?.timing?.complete !== true) {
    return { compatible: false, reason: 'incomplete-timing-scope' };
  }
  if (!Array.isArray(records) || records.length !== summary.testFiles) {
    return { compatible: false, reason: 'record-count' };
  }
  const recordFiles = new Set();
  for (const record of records) {
    if (typeof record?.file !== 'string' || recordFiles.has(record.file)
        || (record.runtimeMs !== null
          && (!Number.isFinite(record.runtimeMs) || record.runtimeMs < 0))) {
      return { compatible: false, reason: 'records' };
    }
    recordFiles.add(record.file);
  }
  return {
    compatible: true,
    generatedAtMs,
    records,
    source: summary.timingIdentity.source,
  };
}

function loadTimingHistory() {
  const diagnostics = {
    requested: timingHistoryDir !== null,
    status: timingHistoryDir === null ? 'not-requested' : 'unavailable',
    candidateArtifacts: 0,
    compatibleArtifacts: 0,
    selectedArtifacts: 0,
    unusedCompatibleArtifacts: 0,
    rejectedArtifacts: 0,
    maximumArtifacts: maximumHistoryArtifacts,
    maximumSamplesPerFile: maximumPercentileSamples,
    discoveryLimits: {
      maximumCandidates: MAX_HISTORY_CANDIDATES,
      maximumFileBytes: MAX_HISTORY_FILE_BYTES,
      maximumDepth: MAX_HISTORY_DEPTH,
      maximumEntries: MAX_HISTORY_ENTRIES,
    },
    discoveryFailure: null,
    visitedEntries: 0,
    rejectionReasons: {},
    selectedSources: [],
  };
  const samplesByFile = new Map();
  if (!timingHistoryDir) return { diagnostics, samplesByFile };
  const absoluteHistoryDir = path.resolve(root, timingHistoryDir);
  if (!fs.existsSync(absoluteHistoryDir)) return { diagnostics, samplesByFile };

  let discovery;
  try {
    discovery = collectInventoryFiles(absoluteHistoryDir);
  } catch {
    return { diagnostics, samplesByFile };
  }
  diagnostics.candidateArtifacts = discovery.namedCandidates;
  diagnostics.visitedEntries = discovery.visitedEntries;
  diagnostics.discoveryFailure = discovery.failure;
  Object.assign(diagnostics.rejectionReasons, discovery.rejectionReasons);
  diagnostics.rejectedArtifacts = Object.values(discovery.rejectionReasons)
    .reduce((total, count) => total + count, 0);
  if (discovery.failure) {
    diagnostics.rejectionReasons[discovery.failure] = 1;
    return { diagnostics, samplesByFile };
  }
  const compatible = [];
  for (const candidatePath of discovery.inventoryFiles) {
    const result = inspectHistoryCandidate(candidatePath);
    if (!result.compatible) {
      diagnostics.rejectedArtifacts += 1;
      diagnostics.rejectionReasons[result.reason] = (
        diagnostics.rejectionReasons[result.reason] ?? 0
      ) + 1;
      continue;
    }
    compatible.push(result);
  }
  compatible.sort((left, right) => right.generatedAtMs - left.generatedAtMs);
  diagnostics.compatibleArtifacts = compatible.length;

  const selected = [];
  const seenSources = new Set();
  for (const candidate of maximumHistoryArtifacts === 0 ? [] : compatible) {
    const source = candidate.source;
    const sourceKey = source?.runId && source?.runAttempt
      ? `${source.workflow}:${source.runId}:${source.runAttempt}`
      : null;
    if (sourceKey && seenSources.has(sourceKey)) {
      diagnostics.rejectedArtifacts += 1;
      diagnostics.rejectionReasons['duplicate-source'] = (
        diagnostics.rejectionReasons['duplicate-source'] ?? 0
      ) + 1;
      continue;
    }
    if (sourceKey) seenSources.add(sourceKey);
    selected.push(candidate);
    if (selected.length >= maximumHistoryArtifacts) break;
  }

  for (const candidate of selected) {
    diagnostics.selectedSources.push(candidate.source);
    for (const record of candidate.records) {
      if (record.runtimeMs === null) continue;
      const samples = samplesByFile.get(record.file) ?? [];
      samples.push(record.runtimeMs);
      samplesByFile.set(record.file, samples);
    }
  }
  diagnostics.selectedArtifacts = selected.length;
  diagnostics.unusedCompatibleArtifacts = compatible.length - selected.length;
  diagnostics.status = selected.length >= maximumHistoryArtifacts
    ? 'window-qualified'
    : selected.length > 0 ? 'partial' : 'unavailable';
  return { diagnostics, samplesByFile };
}

const {
  diagnostics: timingHistory,
  samplesByFile: historicalTimingSamplesByFile,
} = loadTimingHistory();

const records = files.map((file) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const dependencies = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((value) => value.includes('/src/'));
  const resolution = resolveTestDisposition(file, policy);
  const currentRuntimeMs = currentTimingSamplesByFile.get(file)?.at(-1) ?? null;
  const timingSamples = [
    ...(historicalTimingSamplesByFile.get(file) ?? []),
    ...(currentRuntimeMs === null ? [] : [currentRuntimeMs]),
  ].slice(-maximumPercentileSamples);
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
    runtimeMs: currentRuntimeMs,
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
const observedTimingFiles = [...currentTimingSamplesByFile.keys()].filter((file) => expectedTimingSet.has(file));
const unexpectedTimingFiles = [...currentTimingSamplesByFile.keys()]
  .filter((file) => !expectedTimingSet.has(file))
  .sort();
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
  schema: INVENTORY_SCHEMA,
  policyVersion: policy.version,
  generatedAt: new Date().toISOString(),
  timingIdentity,
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
      maximumSamplesForPercentiles: maximumPercentileSamples,
      percentileQualifiedFiles: records.filter((record) => record.runtimeEvidence === 'percentiles-qualified').length,
      history: timingHistory,
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

if (timingHistory.requested && timingHistory.status !== 'window-qualified') {
  console.error(
    `Timing history advisory: selected ${timingHistory.selectedArtifacts}`
    + ` of ${timingHistory.maximumArtifacts} compatible prior nightly artifact(s);`
    + ' percentile fields remain null until each file has the governed sample minimum.',
  );
}

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
