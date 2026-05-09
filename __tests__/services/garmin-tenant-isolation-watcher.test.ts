import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCaptureError = vi.fn();
const mockRecordOperatorAlert = vi.fn(() => ({ ok: true, action: 'created' }));

vi.mock('../../src/services/error-monitor', () => ({
  captureError: (...args: unknown[]) => mockCaptureError(...args),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

describe('garmin tenant isolation watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs cleanup dry-run without --yes and emits error_log + operator alert when matches exist', async () => {
    const runCleanupScript = vi.fn(async () => ({
      stdout: JSON.stringify({
        ok: true,
        mode: 'dry-run',
        matchedCount: 2,
        matchedRows: [
          { userId: 1002, reasons: ['token match'], sources: ['garmin_sessions'] },
          { userId: 1003, reasons: ['email match'], sources: ['garmin_user_tokens'] },
        ],
        remainingCount: 2,
        ranAt: '2026-05-10T00:00:00.000Z',
      }),
      stderr: '',
    }));
    const { runGarminTenantIsolationWatcher } = await import('../../src/services/garmin-tenant-isolation-watcher');

    const result = await runGarminTenantIsolationWatcher({
      nodePath: '/usr/local/bin/node',
      scriptPath: '/repo/scripts/cleanup-tainted-garmin-sessions.mjs',
      cwd: '/repo',
      runCleanupScript,
    });

    expect(runCleanupScript).toHaveBeenCalledWith(
      '/usr/local/bin/node',
      ['/repo/scripts/cleanup-tainted-garmin-sessions.mjs'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(runCleanupScript.mock.calls[0][1]).not.toContain('--yes');
    expect(result).toMatchObject({ ok: true, matchedCount: 2, alerted: true });
    expect(mockCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        source: 'job',
        message: 'Garmin tenant isolation watcher found 2 tainted row(s)',
        context: expect.objectContaining({ matchedCount: 2, remainingCount: 2 }),
      }),
      false,
    );
    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warning',
      source: 'garmin_tenant_isolation_watcher',
      dedupeKey: 'garmin:tenant-isolation:tainted-sessions',
      metadata: expect.objectContaining({ matchedCount: 2, remainingCount: 2 }),
    }));
  });

  it('keeps the alert path quiet when dry-run finds no tainted rows', async () => {
    const runCleanupScript = vi.fn(async () => ({
      stdout: JSON.stringify({
        ok: true,
        mode: 'dry-run',
        matchedCount: 0,
        matchedRows: [],
        remainingCount: 0,
      }),
      stderr: '',
    }));
    const { runGarminTenantIsolationWatcher } = await import('../../src/services/garmin-tenant-isolation-watcher');

    const result = await runGarminTenantIsolationWatcher({ runCleanupScript });

    expect(result).toMatchObject({ ok: true, matchedCount: 0, alerted: false });
    expect(mockCaptureError).not.toHaveBeenCalled();
    expect(mockRecordOperatorAlert).not.toHaveBeenCalled();
  });
});
