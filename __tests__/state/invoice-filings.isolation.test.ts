import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  deleteAmazonFilings,
  deleteUberFilings,
  getFilingsForPeriod,
  getFilingsForMonth,
  getRecentFilings,
  isDuplicate,
  isEmailAlreadyFiled,
  recordFiling,
} from '../../src/state/invoice-filings';

const INVALID_USER_IDS = [0, -1, null, undefined, Number.NaN, '0', '1', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1] as const;
const VALID_USER_IDS = [1, 2, 100, Number.MAX_SAFE_INTEGER] as const;
const REQUIRED_USER_ID_ERROR = /userId required: must be a positive integer/;


function filing(userId: number, overrides: Partial<Parameters<typeof recordFiling>[0]> = {}): Parameters<typeof recordFiling>[0] {
  return {
    vendor: 'Amazon.es',
    amount: '12.34',
    document_date: '2026-05-06',
    invoice_number: `INV-${userId}`,
    source: 'amazon',
    source_ref: `message-${userId}`,
    user_id: userId,
    ...overrides,
  };
}

describe('state/invoice-filings isolation contract', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe.each(INVALID_USER_IDS)('invalid userId %s', (userId) => {
    it('recordFiling rejects', () => {
      expect(() => recordFiling(filing(userId as number))).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('read helpers reject', () => {
      expect(() => isDuplicate('Amazon.es', 'INV', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => isEmailAlreadyFiled('message', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getFilingsForMonth(2026, 5, userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getFilingsForPeriod(1, userId as number, '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z')).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getRecentFilings(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('delete helpers reject', () => {
      expect(() => deleteAmazonFilings(2026, 5, userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => deleteUberFilings(2026, 5, userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });
  });

  describe.each(VALID_USER_IDS)('valid userId %s', (userId) => {
    it('round-trips in its own scope', () => {
      recordFiling(filing(userId));
      expect(getRecentFilings(userId)).toHaveLength(1);
      expect(isDuplicate('Amazon.es', `INV-${userId}`, userId)).toBe(true);
    });
  });

  it('user A cannot read user B filings', () => {
    recordFiling(filing(1, { invoice_number: 'A', source_ref: 'a' }));
    recordFiling(filing(2, { invoice_number: 'B', source_ref: 'b' }));

    expect(getRecentFilings(1).map((row) => row.invoice_number)).toEqual(['A']);
    expect(getRecentFilings(2).map((row) => row.invoice_number)).toEqual(['B']);
    expect(isDuplicate('Amazon.es', 'B', 1)).toBe(false);
    expect(isEmailAlreadyFiled('b', 1)).toBe(false);
  });

  it('includes filed invoices dated on an end-of-day period boundary', () => {
    recordFiling(filing(1, {
      document_date: '2026-04-30',
      invoice_number: 'APR-END',
      source_ref: 'apr-end',
      object_key: 'invoices/1/1/2026/Abr-2026/apr-end.pdf',
      checksum: 'apr-checksum',
      mime: 'application/pdf',
      bytes: 7,
      storage_backend: 'filesystem',
    }));
    recordFiling(filing(1, {
      document_date: '2026-05-01',
      invoice_number: 'MAY-START',
      source_ref: 'may-start',
    }));

    const finalDayEnd = getFilingsForPeriod(
      1,
      1,
      '2026-04-01T00:00:00.000Z',
      '2026-04-30T23:59:59.999Z',
    );
    const firstOfNextMonthExclusive = getFilingsForPeriod(
      1,
      1,
      '2026-04-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    );

    expect(finalDayEnd.map((row) => row.invoice_number)).toEqual(['APR-END']);
    expect(firstOfNextMonthExclusive.map((row) => row.invoice_number)).toEqual(['APR-END']);
    expect(finalDayEnd[0]).toMatchObject({
      object_key: 'invoices/1/1/2026/Abr-2026/apr-end.pdf',
      checksum: 'apr-checksum',
      bytes: 7,
      storage_backend: 'filesystem',
    });
  });

  it('delete helpers are scoped and idempotent', () => {
    recordFiling(filing(1, { source: 'amazon', invoice_number: 'A1', source_ref: 'a1' }));
    recordFiling(filing(2, { source: 'amazon', invoice_number: 'B1', source_ref: 'b1' }));
    recordFiling(filing(2, { source: 'uber', vendor: 'Uber', invoice_number: 'B2', source_ref: 'b2' }));

    expect(deleteAmazonFilings(2026, 5, 1)).toBe(1);
    expect(deleteAmazonFilings(2026, 5, 1)).toBe(0);
    expect(getRecentFilings(1)).toHaveLength(0);
    expect(getRecentFilings(2)).toHaveLength(2);
    expect(deleteUberFilings(2026, 5, 2)).toBe(1);
    expect(getRecentFilings(2)).toHaveLength(1);
  });
});
