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
        // Phase 0: Start low, increase as test coverage grows
        // Current: 1.82% lines, 56% branches, 29% functions
        // Target by end of Phase 0: 30% lines, 30% functions
        lines: 1,
        functions: 5,
        branches: 10,
        statements: 1,
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
