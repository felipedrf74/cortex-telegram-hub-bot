const mutate = JSON.parse(process.env.NEXUS_MUTATE_FILES ?? '[]');
const thresholds = JSON.parse(process.env.NEXUS_MUTATION_THRESHOLDS ?? '{"high":80,"low":70,"break":70}');
const mutationScope = process.env.NEXUS_MUTATION_SCOPE ?? 'changed-critical';
const testFiles = process.env.NEXUS_MUTATION_TEST_FILES === undefined
  ? undefined
  : JSON.parse(process.env.NEXUS_MUTATION_TEST_FILES);

if (!Array.isArray(mutate) || mutate.length === 0) {
  throw new Error('NEXUS_MUTATE_FILES must contain at least one governed source file');
}
for (const key of ['high', 'low', 'break']) {
  if (!Number.isFinite(thresholds?.[key])) {
    throw new Error(`NEXUS_MUTATION_THRESHOLDS.${key} must be a finite number`);
  }
}
if (testFiles !== undefined && (!Array.isArray(testFiles) || testFiles.length === 0)) {
  throw new Error('NEXUS_MUTATION_TEST_FILES must contain governed retained tests');
}

export default {
  testRunner: 'vitest',
  mutate,
  ...(testFiles === undefined ? {} : { testFiles }),
  vitest: {
    related: true,
    configFile: 'config/vitest.stryker.config.ts',
  },
  // Static module-initialization mutants require the entire related suite for
  // every candidate and dominated more than 90% of the measured cleanup-lane
  // runtime. Keep them in the non-release weekly lane; the PR gate still
  // scores all covered runtime mutants owned by removed assertions.
  ignoreStatic: mutationScope === 'test-cleanup',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: {
    fileName: '.local/mutation/mutation-report.json',
  },
  thresholds,
  // `.local` contains ignored evidence, operator state, and may temporarily
  // contain credentials. Mutation sandboxes must never copy any of it into
  // candidate-controlled test execution.
  ignorePatterns: ['/.local', '/.local/**'],
  tempDirName: '.local/stryker-tmp',
  cleanTempDir: true,
  // The weekly lane is advisory and intentionally sequential. The gate runs
  // one source per Stryker process: a combined 40-source instrumented graph
  // crashed Vitest even with one worker, while the bounded source processes
  // retain every changed range and complete without duplicating runners.
  concurrency: 1,
  // GitHub's shared runner can take longer than five minutes for Stryker's
  // instrumented correctness baseline even though the ordinary four-shard
  // suite is healthy. This only widens the pre-mutation dry-run allowance;
  // mutant timeouts and the 70% break threshold remain unchanged.
  dryRunTimeoutMinutes: 10,
};
