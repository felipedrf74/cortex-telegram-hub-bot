import { describe, expect, it, vi } from 'vitest';
import {
  _downloadRidesReceiptForTests,
  isUberTransientDownloadError,
  parseUberDate,
  shouldRecordTerminalUberDownloadFailure,
  UberTransientDownloadError,
} from '../../src/services/uber-collector';

describe('Uber collector date parsing', () => {
  it('keeps yearless December dates out of a January target window', () => {
    expect(parseUberDate('Dec 31', 2026, 1)).toBe('2025-12-31');
  });

  it('keeps target-month yearless dates in the requested year', () => {
    expect(parseUberDate('Dec 31', 2026, 12)).toBe('2026-12-31');
  });

  it('treats transient receipt download failures as non-terminal filing failures', () => {
    const transient = new UberTransientDownloadError('Uber receipt download failed with transient HTTP 503');

    expect(isUberTransientDownloadError(transient)).toBe(true);
    expect(shouldRecordTerminalUberDownloadFailure(transient)).toBe(false);
    expect(shouldRecordTerminalUberDownloadFailure(new Error('No receipt PDF found'))).toBe(true);
  });

  it('retries transient direct receipt downloads and throws instead of returning null', async () => {
    const pdfLink = {
      isVisible: vi.fn().mockResolvedValue(true),
      getAttribute: vi.fn().mockResolvedValue('/receipt.pdf'),
      click: vi.fn(),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://riders.uber.com/trips/trip-1'),
      locator: vi.fn().mockReturnValue({
        first: vi.fn(() => pdfLink),
      }),
      request: {
        get: vi.fn().mockResolvedValue({
          ok: () => false,
          status: () => 503,
        }),
      },
      waitForEvent: vi.fn(),
    };

    await expect(
      _downloadRidesReceiptForTests(page as any, 'https://riders.uber.com/trips/trip-1'),
    ).rejects.toBeInstanceOf(UberTransientDownloadError);

    expect(page.request.get).toHaveBeenCalledTimes(3);
    expect(page.waitForEvent).not.toHaveBeenCalled();
  });
});
