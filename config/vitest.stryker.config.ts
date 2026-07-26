import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../vitest.config';

// Mutation testing instruments every selected source before Vitest starts.
// Keep this advisory lane deliberately single-worker. Use a fork, matching the
// stable base-suite process boundary, because native dependencies such as
// better-sqlite3 can crash when the instrumented graph runs in a worker thread.
export default mergeConfig(baseConfig, defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
  },
}));
