import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));


import {
  getFiscalCollectionProfile,
  getOrCreateFiscalCollectionProfile,
} from '../../src/state/fiscal-collection-profiles';

function seedUser(db: Database.Database, userId: number): void {
  db.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(userId, userId);
}

describe('fiscal collection profile state', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('creates a blank destination email instead of seeding from account identity', () => {
    seedUser(testDb, 41);
    const profile = getOrCreateFiscalCollectionProfile(41);

    expect(profile.user_id).toBe(41);
    expect(profile.destination_email).toBeNull();
    expect(getFiscalCollectionProfile(41)?.destination_email).toBeNull();
  });

  it('keeps profiles isolated per user id', () => {
    seedUser(testDb, 41);
    seedUser(testDb, 52);
    const userOne = getOrCreateFiscalCollectionProfile(41);
    const userTwo = getOrCreateFiscalCollectionProfile(52);

    expect(userOne.user_id).toBe(41);
    expect(userTwo.user_id).toBe(52);
    expect(userOne.destination_email).toBeNull();
    expect(userTwo.destination_email).toBeNull();
  });
});
