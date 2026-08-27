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
  addVendor,
  getActiveVendors,
  removeVendor,
  vendorExists,
} from '../../src/state/invoice-vendors';
import {
  recordFiling,
  isDuplicate,
  isEmailAlreadyFiled,
  getFilingsForMonth,
} from '../../src/state/invoice-filings';

describe('invoice state isolation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    testDb.prepare("INSERT INTO users (id, status) VALUES (11, 'active'), (22, 'active')").run();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('scopes vendor inventory and deletion by canonical user id', () => {
    const vendorUserOne = addVendor('Via Verde', 'viaverde.pt', 11);
    const vendorUserTwo = addVendor('Via Verde', 'viaverde.pt', 22);

    expect(vendorExists('viaverde.pt', 11)).toBe(true);
    expect(vendorExists('viaverde.pt', 22)).toBe(true);
    expect(getActiveVendors(11).map((row) => row.id)).toEqual([vendorUserOne.id]);
    expect(getActiveVendors(22).map((row) => row.id)).toEqual([vendorUserTwo.id]);

    expect(removeVendor(vendorUserOne.id, 22)).toBe(false);
    expect(getActiveVendors(11).map((row) => row.id)).toEqual([vendorUserOne.id]);

    expect(removeVendor(vendorUserOne.id, 11)).toBe(true);
    expect(getActiveVendors(11)).toEqual([]);
  });

  it('normalizes sender patterns so equivalent casing does not create duplicate vendors', () => {
    const initial = addVendor('Via Verde', 'ViaVerde.PT', 11, ' Fatura , Recibo ');
    const updated = addVendor('Via Verde', 'viaverde.pt', 11, 'fatura,recibo');

    expect(updated.id).toBe(initial.id);
    expect(updated.sender_pattern).toBe('viaverde.pt');
    expect(updated.subject_patterns).toBe('fatura,recibo');
    expect(vendorExists('VIAVERDE.PT', 11)).toBe(true);
    expect(getActiveVendors(11)).toHaveLength(1);
  });

  it('scopes invoice duplicate and monthly filing queries by canonical user id', () => {
    recordFiling({
      vendor: 'Amazon.es',
      invoice_number: 'INV-001',
      document_date: '2026-04-15',
      source: 'amazon',
      source_ref: 'order-1',
      status: 'filed',
      user_id: 11,
    });

    expect(isDuplicate('Amazon.es', 'INV-001', 11)).toBe(true);
    expect(isDuplicate('Amazon.es', 'INV-001', 22)).toBe(false);
    expect(isEmailAlreadyFiled('order-1', 11)).toBe(false);

    recordFiling({
      vendor: 'NOS',
      invoice_number: 'NOS-APR-01',
      document_date: '2026-04-10',
      source: 'email',
      source_ref: 'msg-123',
      status: 'filed',
      user_id: 11,
    });

    expect(isEmailAlreadyFiled('msg-123', 11)).toBe(true);
    expect(isEmailAlreadyFiled('msg-123', 22)).toBe(false);
    expect(getFilingsForMonth(2026, 4, 11)).toHaveLength(2);
    expect(getFilingsForMonth(2026, 4, 22)).toEqual([]);
  });
});
