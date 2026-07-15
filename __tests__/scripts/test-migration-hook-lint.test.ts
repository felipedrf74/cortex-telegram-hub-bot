import { describe, expect, it } from 'vitest';
import { findMigrationReplayViolations } from '../../scripts/test-migration-hook-lint.mjs';

describe('migration replay guard', () => {
  it('rejects a direct full replay outside the governed rehearsal allowlist', () => {
    const failures = findMigrationReplayViolations(
      '__tests__/services/unapproved.test.ts',
      `it('replays', () => { runMigrationsForTest(db); });`,
      new Map(),
    );
    expect(failures).toEqual([
      expect.stringContaining('unapproved full migration replay (runMigrationsForTest)'),
    ]);
  });

  it('traces a raw migration-directory helper into per-test hooks', () => {
    const failures = findMigrationReplayViolations(
      '__tests__/services/hooked.test.ts',
      `
        function rebuild(db) {
          for (const file of readdirSync(MIGRATIONS_DIR)) {
            db.exec(readFileSync(join(MIGRATIONS_DIR, file)));
          }
        }
        beforeEach(() => rebuild(db));
      `,
      new Map(),
    );
    expect(failures).toEqual(expect.arrayContaining([
      expect.stringContaining('full migration replay inside beforeEach'),
      expect.stringContaining('unapproved full migration replay (helper:rebuild)'),
    ]));
  });

  it('rejects inline raw migration-directory replay inside a per-test hook', () => {
    const failures = findMigrationReplayViolations(
      '__tests__/services/inline-hook.test.ts',
      `
        beforeEach(() => {
          for (const file of readdirSync(MIGRATIONS_DIR)) {
            db.exec(readFileSync(join(MIGRATIONS_DIR, file)));
          }
        });
      `,
      new Map(),
    );
    expect(failures).toEqual(expect.arrayContaining([
      expect.stringContaining('full migration replay inside beforeEach'),
      expect.stringContaining('inline-raw-migration-loop'),
    ]));
  });

  it('recognizes an imported migration helper even when it is aliased', () => {
    const failures = findMigrationReplayViolations(
      '__tests__/services/imported-helper.test.ts',
      `
        import { applyMigrations as replayEverything } from '../helpers/apply-migrations';
        it('replays', () => replayEverything(db));
      `,
      new Map(),
    );
    expect(failures).toEqual([
      expect.stringContaining('unapproved full migration replay (replayEverything)'),
    ]);
  });

  it('accepts a template copy and no production runner invocation', () => {
    expect(findMigrationReplayViolations(
      '__tests__/services/template.test.ts',
      `it('copies', () => { const db = createMigratedTestDatabase(); db.close(); });`,
      new Map(),
    )).toEqual([]);
  });

  it('requires an approved rehearsal to keep its exact call budget', () => {
    const approvals = new Map([
      ['__tests__/migrations/example.test.ts', { expectedCalls: 1, reason: 'one empty-db rehearsal' }],
    ]);
    expect(findMigrationReplayViolations(
      '__tests__/migrations/example.test.ts',
      `it('replays twice', () => { runMigrationsForTest(a); runMigrationsForTest(b); });`,
      approvals,
    )).toEqual([
      expect.stringContaining('count is 2; expected 1'),
    ]);
  });
});
