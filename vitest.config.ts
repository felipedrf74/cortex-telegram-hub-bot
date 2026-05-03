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
        // Current main: 1.82% lines, 56% branches, 29% functions
        // Lines/statements low because tests only cover router + database (2 of 60+ files)
        // Raise these AFTER merging feature/test-expansion branch
        lines: 1,
        functions: 15,
        branches: 15,
        statements: 1,
      },
    },
    testTimeout: 10000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // singleFork lifted on 2026-05-03 (release-pipeline-risk-based-
        // optimization) after the empirical experiment showed:
        //   - full vitest wall clock: 9 m 35.63 s → 1 m 19.76 s (7.22× speedup)
        //   - 6,563 / 6,563 tests pass (vs 6,562 / 6,563 with singleFork=true)
        //   - the singleFork flake was actually caused by the shared
        //     module cache, not despite it; per-file fork isolation
        //     eliminated it
        // Re-enable singleFork: true ONLY if vi.mock partial-pollution
        // returns. The vi.mock-completeness lint (scripts/vi-mock-
        // completeness-lint.mjs) is the diagnostic tool for that case.
        singleFork: false,
      },
    },
  },
});
