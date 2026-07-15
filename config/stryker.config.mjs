const mutate = JSON.parse(process.env.NEXUS_MUTATE_FILES ?? '[]');

if (!Array.isArray(mutate) || mutate.length === 0) {
  throw new Error('NEXUS_MUTATE_FILES must contain at least one governed source file');
}

export default {
  testRunner: 'vitest',
  mutate,
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: {
    fileName: '.local/mutation/mutation-report.json',
  },
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },
  tempDirName: '.local/stryker-tmp',
  cleanTempDir: true,
  concurrency: 2,
};
