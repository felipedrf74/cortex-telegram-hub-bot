import { describe, expect, it, vi } from 'vitest';

import { ensureMigrationSqlFunctions } from '../../src/services/migration-runner';

describe('migration runner SQL function registration', () => {
  it('registers deterministic functions once and preserves exact null and text hashes', () => {
    const functions = new Map<string, (value: unknown) => string>();
    const register = vi.fn((
      name: string,
      options: { deterministic: boolean },
      fn: (value: unknown) => string,
    ) => {
      functions.set(name, fn);
      return database;
    });
    const database = { function: register } as unknown as Parameters<typeof ensureMigrationSqlFunctions>[0];

    ensureMigrationSqlFunctions(database);
    ensureMigrationSqlFunctions(database);

    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls.map(([name, options]) => ({ name, options }))).toEqual([
      { name: 'nexus_sha256', options: { deterministic: true } },
      { name: 'nexus_plain_text_revision_hash', options: { deterministic: true } },
    ]);
    expect(functions.get('nexus_sha256')?.('workspace')).toBe(
      '21a3230e03772a58aff1b3709a9e232850916337e1fba95c434076b6668c6e08',
    );
    expect(functions.get('nexus_sha256')?.(null)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(functions.get('nexus_plain_text_revision_hash')?.('draft')).toBe(
      'fa5cac9f93c978aa9495c0d5ffd1e21fafa000ee9e3789feefa51e26092f7b8f',
    );
    expect(functions.get('nexus_plain_text_revision_hash')?.(undefined)).toBe(
      'dd91df5f966e14dba2201811fe8d45d3ff365cc3944ae212479347caa1055445',
    );
  });
});
