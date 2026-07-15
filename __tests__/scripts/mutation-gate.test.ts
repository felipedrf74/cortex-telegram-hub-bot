import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractRelativeImports,
  isCriticalModule,
  resolveImportedSourcePaths,
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
});
