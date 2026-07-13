import { describe, expect, it, vi } from 'vitest';

const prepareMock = vi.hoisted(() => vi.fn((sql: string) => ({ sql })));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: prepareMock,
  }),
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

describe('portal snapshot statements', () => {
  it('prepares the snapshot statement set once and reuses the cache', async () => {
    const { getPortalSnapshotStatements } = await import('../../src/portal/snapshot-statements');

    const first = getPortalSnapshotStatements();
    const second = getPortalSnapshotStatements();

    expect(second).toBe(first);
    expect(prepareMock).toHaveBeenCalledTimes(17);
    expect(Object.keys(first).sort()).toEqual([
      'byCategory',
      'domainMessagesToday',
      'domainMessagesTotal',
      'emailTodayFailed',
      'emailTodaySent',
      'jobHistory7d',
      'jobHistoryMonth',
      'jobHistoryRecent',
      'lastFailureForJob',
      'lastMonthInvoices',
      'lastSuccessForJob',
      'monthUsage',
      'recentEmailLog',
      'recentFilings',
      'thisMonthInvoices',
      'todayUsage',
      'weekUsage',
    ]);
  });
});

