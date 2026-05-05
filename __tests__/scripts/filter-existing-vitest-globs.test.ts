import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function filterGlobs(...globs: string[]): string[] {
  const raw = execFileSync(
    process.execPath,
    ['scripts/filter-existing-vitest-globs.mjs', ...globs],
    { encoding: 'utf8' },
  );
  return raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
}

describe('filter-existing-vitest-globs', () => {
  it('keeps focused globs that match files and drops stale no-match globs', () => {
    expect(
      filterGlobs(
        '__tests__/portal/**/*.test.ts',
        '__tests__/portal/does-not-exist-*.test.ts',
      ),
    ).toEqual(['__tests__/portal/**/*.test.ts']);
  });

  it('returns no globs when every focused pattern is stale', () => {
    expect(filterGlobs('__tests__/missing-area/**/*.test.ts')).toEqual([]);
  });

  it('keeps existing literal test files', () => {
    expect(filterGlobs('__tests__/scripts/changed-area-classifier.test.ts')).toEqual([
      '__tests__/scripts/changed-area-classifier.test.ts',
    ]);
  });
});
