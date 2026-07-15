#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadTestPolicy, globToRegExp, matchFiles, root, walkTestFiles } from './lib/test-policy.mjs';

const args = process.argv.slice(2);
const timingsIndex = args.indexOf('--timings');
const timingsPath = timingsIndex === -1 ? null : args[timingsIndex + 1];
const policy = loadTestPolicy();
const files = walkTestFiles();
const timingSamplesByFile = new Map();

if (timingsPath && fs.existsSync(timingsPath)) {
  const report = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
  for (const result of report.testResults ?? []) {
    const file = path.relative(root, result.name).split(path.sep).join('/');
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

const tierSets = Object.fromEntries(Object.entries(policy.tiers).map(([tier, config]) => [
  tier,
  new Set(matchFiles(files, config.include)),
]));
const dispositionRules = policy.dispositionRules.map((rule) => ({ ...rule, matcher: globToRegExp(rule.pattern) }));
const timingExceptions = new Map((policy.timingExceptions ?? []).map((exception) => [exception.file, exception]));

const records = files.map((file) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const dependencies = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((value) => value.includes('/src/'));
  const disposition = dispositionRules.find((rule) => rule.matcher.test(file));
  const timingSamples = timingSamplesByFile.get(file) ?? [];
  const tiers = Object.entries(tierSets).filter(([, set]) => set.has(file)).map(([tier]) => tier);
  if (tiers.length === 0) tiers.push(policy.defaultTier);
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
    runtimeP50Ms: percentile(timingSamples, 0.50),
    runtimeP95Ms: percentile(timingSamples, 0.95),
    timingException: timingExceptions.get(file) ?? null,
    uniqueCoverage: null,
    lastFailure: null,
    disposition: disposition?.disposition ?? null,
    dispositionReason: disposition?.reason ?? null,
  };
});

const missing = records.filter((record) => !record.disposition);
if (missing.length > 0) {
  console.error(`Test policy left ${missing.length} files without a disposition.`);
  process.exit(1);
}

const outputDir = path.join(root, '.local/test-inventory');
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'test-inventory.json');
const summary = {
  policyVersion: policy.version,
  generatedAt: new Date().toISOString(),
  testFiles: records.length,
  byDisposition: Object.fromEntries(['keep', 'merge', 'convert', 'eval', 'delete'].map((value) => [
    value,
    records.filter((record) => record.disposition === value).length,
  ])),
  timedFiles: records.filter((record) => record.runtimeMs !== null).length,
  slowNonExemptFiles: records.filter((record) => record.runtimeMs > 10_000 && !record.timingException).length,
};
fs.writeFileSync(outputPath, `${JSON.stringify({ summary, records }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath: path.relative(root, outputPath), ...summary }, null, 2));
if (timingsPath && summary.slowNonExemptFiles > 0) process.exit(1);
