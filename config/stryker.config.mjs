const mutate = JSON.parse(process.env.NEXUS_MUTATE_FILES ?? '[]');
const thresholds = JSON.parse(process.env.NEXUS_MUTATION_THRESHOLDS ?? '{"high":80,"low":70,"break":70}');

if (!Array.isArray(mutate) || mutate.length === 0) {
  throw new Error('NEXUS_MUTATE_FILES must contain at least one governed source file');
}
for (const key of ['high', 'low', 'break']) {
  if (!Number.isFinite(thresholds?.[key])) {
    throw new Error(`NEXUS_MUTATION_THRESHOLDS.${key} must be a finite number`);
  }
}

export default {
  testRunner: 'vitest',
  mutate,
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
  concurrency: 2,
};
