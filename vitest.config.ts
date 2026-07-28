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
    // Process-heavy release/rollback fixtures spawn nested shell children.
    // A single fork keeps their fixed safety deadlines reliable even while
    // desktop file indexing and local release containers are active.
    maxWorkers: 1,
  },
});
