import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  addVendor,
  getActiveVendors,
  getAllVendors,
  removeVendor,
  removeVendorByName,
  vendorExists,
} from '../../src/state/invoice-vendors';

const INVALID_USER_IDS = [0, -1, null, undefined, Number.NaN, '0', '1', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1] as const;
const VALID_USER_IDS = [1, 2, 100, Number.MAX_SAFE_INTEGER] as const;
const REQUIRED_USER_ID_ERROR = /userId required: must be a positive integer/;


describe('state/invoice-vendors isolation contract', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe.each(INVALID_USER_IDS)('invalid userId %s', (userId) => {
    it('addVendor rejects', () => {
      expect(() => addVendor('Unsafe Vendor', 'billing@example.com', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('read helpers reject', () => {
      expect(() => getActiveVendors(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getAllVendors(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => vendorExists('billing@example.com', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('delete helpers reject', () => {
      expect(() => removeVendor(1, userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => removeVendorByName('Unsafe Vendor', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });
  });

  describe.each(VALID_USER_IDS)('valid userId %s', (userId) => {
    it('round-trips in its own scope', () => {
      addVendor(`Vendor ${userId}`, `billing-${userId}@example.com`, userId, 'invoice,receipt');

      expect(getActiveVendors(userId)).toHaveLength(1);
      expect(getActiveVendors(userId)[0]).toMatchObject({
        name: `Vendor ${userId}`,
        sender_pattern: `billing-${userId}@example.com`,
        subject_patterns: 'invoice,receipt',
      });
      expect(vendorExists(`BILLING-${userId}@EXAMPLE.COM`, userId)).toBe(true);
    });
  });

  it('user A cannot read user B vendors', () => {
    addVendor('Alpha Vendor', 'alpha@example.com', 1);
    addVendor('Beta Vendor', 'beta@example.com', 2);

    expect(getActiveVendors(1).map((row) => row.name)).toEqual(['Alpha Vendor']);
    expect(getActiveVendors(2).map((row) => row.name)).toEqual(['Beta Vendor']);
    expect(vendorExists('beta@example.com', 1)).toBe(false);
  });

  it('removeVendor is scoped and idempotent', () => {
    const userVendor = addVendor('Scoped Vendor', 'scoped@example.com', 1);
    addVendor('Other Vendor', 'other@example.com', 2);

    expect(removeVendor(userVendor.id, 2)).toBe(false);
    expect(getActiveVendors(1)).toHaveLength(1);
    expect(removeVendor(userVendor.id, 1)).toBe(true);
    expect(() => removeVendor(userVendor.id, 1)).not.toThrow();
    expect(getActiveVendors(1)).toHaveLength(0);
    expect(getActiveVendors(2)).toHaveLength(1);
  });

  it('removeVendorByName is scoped and preserves other users', () => {
    addVendor('Shared Name', 'a@example.com', 1);
    addVendor('Shared Name', 'b@example.com', 2);

    expect(removeVendorByName('shared name', 1)).toBe(true);

    expect(getActiveVendors(1)).toHaveLength(0);
    expect(getActiveVendors(2)).toHaveLength(1);
    expect(getAllVendors(1)).toMatchObject([{ enabled: 0 }]);
  });

  it('re-adding a disabled sender re-enables only the requesting user row', () => {
    const original = addVendor('Original', 'shared@example.com', 1);
    addVendor('Other', 'shared@example.com', 2);
    removeVendor(original.id, 1);

    const reenabled = addVendor('Reenabled', 'shared@example.com', 1, 'updated');

    expect(reenabled.id).toBe(original.id);
    expect(getActiveVendors(1)).toMatchObject([{ name: 'Reenabled', subject_patterns: 'updated' }]);
    expect(getActiveVendors(2)).toMatchObject([{ name: 'Other' }]);
  });

  it('round-trips multiple sender patterns for a single vendor', () => {
    addVendor('Multi Sender', 'billing@example.com', 1, 'invoice', 1, [
      'billing@example.com',
      'receipts@example.com',
      'example.org',
    ]);

    const [vendor] = getActiveVendors(1);
    expect(vendor.sender_pattern).toBe('billing@example.com');
    expect(vendor.sender_patterns).toEqual([
      'billing@example.com',
      'receipts@example.com',
      'example.org',
    ]);
    expect(vendorExists('receipts@example.com', 1)).toBe(true);
    expect(vendorExists('example.org', 1)).toBe(true);
  });
});
