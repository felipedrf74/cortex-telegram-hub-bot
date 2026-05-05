import { vi } from 'vitest';

const statement = {
  get: vi.fn(),
  all: vi.fn(() => []),
  run: vi.fn(),
  iterate: vi.fn(function* () {}),
};

const db = {
  prepare: vi.fn(() => statement),
  exec: vi.fn(),
  pragma: vi.fn(),
  transaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
  close: vi.fn(),
};

export const getDb = vi.fn(() => db);
export const initDatabase = vi.fn(() => db);
export const closeDatabase = vi.fn();
export const findUnexpectedMigrationPrefixCollisions = vi.fn(() => []);
