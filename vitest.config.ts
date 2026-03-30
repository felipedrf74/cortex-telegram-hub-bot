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
        // Raised after 256 tests (7% growth from agents)
        // Will increase further as coverage expands
        lines: 10,
        functions: 15,
        branches: 15,
        statements: 10,
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
