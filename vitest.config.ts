import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: '.',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'content-engine'],
    setupFiles: ['./__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/portal/portal.html',
        'src/**/*.d.ts',
      ],
      thresholds: {
        // Start conservative, increase as we add tests
        lines: 30,
        functions: 30,
        branches: 20,
        statements: 30,
      },
    },
    // Timeout for AI-related tests that might need more time
    testTimeout: 10000,
    // Run tests sequentially (SQLite doesn't support concurrent writes)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
