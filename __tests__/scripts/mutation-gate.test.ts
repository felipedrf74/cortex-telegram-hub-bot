import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildStrykerInvocation,
  extractReferencedSourceLiterals,
  extractRelativeImports,
  isCriticalModule,
  resolveImportedSourcePaths,
  resolveReferencedSourcePaths,
  resolveDeletedTestCleanupMappings,
  validateCleanupMapping,
} from '../../scripts/mutation-gate.mjs';

describe('changed-critical mutation gate', () => {
  it('extracts static, dynamic, and require imports without package imports', () => {
    expect(extractRelativeImports(`
      import { authenticate } from '../../src/middleware/auth';
      const provider = await import('../../src/services/provider-router');
      const database = require('../../src/services/database');
      import { describe } from 'vitest';
    `)).toEqual([
      '../../src/middleware/auth',
      '../../src/services/database',
      '../../src/services/provider-router',
    ]);
  });

  it('matches only explicitly governed critical modules', () => {
    const patterns = ['src/services/*auth*.ts', 'src/services/database.ts'];
    expect(isCriticalModule('src/services/google-auth.ts', patterns)).toBe(true);
    expect(isCriticalModule('src/services/database.ts', patterns)).toBe(true);
    expect(isCriticalModule('src/services/content-scheduler.ts', patterns)).toBe(false);
  });

  it('governs root API authentication and tenant-scope modules', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8')) as {
      mutation: { criticalModulePatterns: string[] };
    };

    expect(isCriticalModule('src/api/auth-middleware.ts', policy.mutation.criticalModulePatterns)).toBe(true);
    expect(isCriticalModule('src/api/tenant-route-scope.ts', policy.mutation.criticalModulePatterns)).toBe(true);
  });

  it('maps deleted-test source text back to repository source dependencies', () => {
    const existing = new Set([
      path.resolve('src/services/database.ts'),
      path.resolve('src/services/provider-router.ts'),
    ]);
    const resolved = resolveImportedSourcePaths(
      '__tests__/scripts/deleted-cleanup.test.ts',
      `
        import '../../src/services/database';
        import('../../src/services/provider-router');
      `,
      (candidate) => existing.has(candidate),
    );
    expect(resolved).toEqual([
      'src/services/database.ts',
      'src/services/provider-router.ts',
    ]);
  });

  it('maps source files read through fs/path helpers instead of treating them as unowned deletions', () => {
    const source = `
      const direct = read('src/api/routes/training-plan-generation.ts');
      const resolved = fs.readFileSync(path.resolve(__dirname, '../../src/portal/health-routes.ts'));
    `;
    expect(extractReferencedSourceLiterals(source)).toEqual([
      'src/api/routes/training-plan-generation.ts',
      'src/portal/health-routes.ts',
    ]);

    const existing = new Set([
      path.resolve('src/api/routes/training-plan-generation.ts'),
      path.resolve('src/portal/health-routes.ts'),
    ]);
    expect(resolveReferencedSourcePaths(
      '__tests__/scripts/deleted-source-read.test.ts',
      source,
      (candidate) => existing.has(candidate),
    )).toEqual([
      'src/api/routes/training-plan-generation.ts',
      'src/portal/health-routes.ts',
    ]);
  });

  it('requires deleted-test mappings to retained tests and real governed sources', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8')) as {
      mutation: { cleanupMappings: Array<Record<string, unknown>> };
    };
    expect(policy.mutation.cleanupMappings.length).toBeGreaterThan(0);
    for (const mapping of policy.mutation.cleanupMappings) {
      expect(validateCleanupMapping(mapping), JSON.stringify(mapping)).toEqual([]);
    }

    const missing = resolveDeletedTestCleanupMappings(
      [{ status: 'D', file: '__tests__/security/removed-contract.test.ts', previous: null }],
      policy.mutation.cleanupMappings,
    );
    expect(missing.unmapped).toEqual(['__tests__/security/removed-contract.test.ts']);
    expect(missing.resolved).toEqual([]);

    const mapped = policy.mutation.cleanupMappings[0];
    const resolved = resolveDeletedTestCleanupMappings(
      [{ status: 'D', file: mapped.test, previous: null }],
      policy.mutation.cleanupMappings,
    );
    expect(resolved.unmapped).toEqual([]);
    expect(resolved.invalid).toEqual([]);
    expect(resolved.resolved).toEqual([mapped]);
  });

  it('passes Stryker 9 thresholds through config environment instead of removed CLI flags', () => {
    const invocation = buildStrykerInvocation({
      config: '/repo/config/stryker.config.mjs',
      targets: ['src/services/database.ts'],
      thresholds: { high: 80, low: 70, break: 70 },
    });

    expect(invocation.args).toEqual(['run', '/repo/config/stryker.config.mjs']);
    expect(invocation.args.join(' ')).not.toContain('--thresholds.');
    expect(JSON.parse(invocation.env.NEXUS_MUTATE_FILES)).toEqual(['src/services/database.ts']);
    expect(JSON.parse(invocation.env.NEXUS_MUTATION_THRESHOLDS)).toEqual({
      high: 80,
      low: 70,
      break: 70,
    });
  });

  it('excludes all ignored local evidence and credentials from mutation sandboxes', () => {
    const config = fs.readFileSync('config/stryker.config.mjs', 'utf8');

    expect(config).toContain("ignorePatterns: ['/.local', '/.local/**']");
  });
});
