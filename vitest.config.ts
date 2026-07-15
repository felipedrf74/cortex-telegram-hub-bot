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
        lines: 78,
        functions: 84,
        branches: 68,
        statements: 75,
      },
    },
    testTimeout: 10000,
    pool: 'forks',
    // Cap fork fan-out so the full suite remains a reliable gate on
    // local/desktop runners. Unbounded forks can complete every assertion
    // but still fail at shutdown with Vitest worker RPC timeouts.
    maxWorkers: 4,
  },
});
