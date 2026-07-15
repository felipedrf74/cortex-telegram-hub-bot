import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  getFiscalCollectionProfile,
  getOrCreateFiscalCollectionProfile,
  listActiveFiscalCollectionProfiles,
  updateFiscalCollectionProfile,
} from '../../src/state/fiscal-collection-profiles';

const INVALID_USER_IDS = [0, -1, null, undefined, Number.NaN, '0', '1', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1] as const;
const VALID_USER_IDS = [1, 2, 100, Number.MAX_SAFE_INTEGER] as const;
const REQUIRED_USER_ID_ERROR = /userId required: must be a positive integer/;


function seedUser(userId: number): void {
  testDb.prepare(`
    INSERT OR IGNORE INTO users (id, telegram_id, username)
    VALUES (?, ?, ?)
  `).run(userId, userId, `user-${userId}`);
}

describe('state/fiscal-collection-profiles isolation contract', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    for (const userId of VALID_USER_IDS) {
      seedUser(userId);
    }
  });

  afterEach(() => {
    testDb?.close();
  });

  describe.each(INVALID_USER_IDS)('invalid userId %s', (userId) => {
    it('getFiscalCollectionProfile rejects', () => {
      expect(() => getFiscalCollectionProfile(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('getOrCreateFiscalCollectionProfile rejects', () => {
      expect(() => getOrCreateFiscalCollectionProfile(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('updateFiscalCollectionProfile rejects', () => {
      expect(() => updateFiscalCollectionProfile(userId as number, { enabled: true })).toThrow(REQUIRED_USER_ID_ERROR);
    });
  });

  describe.each(VALID_USER_IDS)('valid userId %s', (userId) => {
    it('round-trips in its own scope', () => {
      updateFiscalCollectionProfile(userId, { destination_email: `user-${userId}@example.com` });

      expect(getFiscalCollectionProfile(userId)?.destination_email).toBe(`user-${userId}@example.com`);
    });
  });

  it('user A cannot read user B profile', () => {
    updateFiscalCollectionProfile(1, { destination_email: 'a@example.com' });
    updateFiscalCollectionProfile(2, { destination_email: 'b@example.com' });

    expect(getFiscalCollectionProfile(1)?.destination_email).toBe('a@example.com');
    expect(getFiscalCollectionProfile(2)?.destination_email).toBe('b@example.com');
  });

  it('updates are scoped to the requested user only', () => {
    updateFiscalCollectionProfile(1, { destination_email: 'a@example.com' });
    updateFiscalCollectionProfile(2, { destination_email: 'b@example.com' });
    updateFiscalCollectionProfile(1, { destination_email: 'a2@example.com' });

    expect(getFiscalCollectionProfile(1)?.destination_email).toBe('a2@example.com');
    expect(getFiscalCollectionProfile(2)?.destination_email).toBe('b@example.com');
  });

  it('system scheduler listing sees active profiles without changing user scope', () => {
    updateFiscalCollectionProfile(1, { enabled: true });
    updateFiscalCollectionProfile(2, { enabled: false });

    expect(listActiveFiscalCollectionProfiles().map((row) => row.user_id)).toEqual([1]);
  });
});
