import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testConfig = vi.hoisted(() => ({
  storageDir: '',
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
    invoiceObjectStorage: {
      enabled: true,
      backend: 'filesystem',
      get filesystemDir() {
        return testConfig.storageDir;
      },
      maxObjectBytes: 1024 * 1024,
      minFreeBytes: 0,
      tenantMaxBytes: 0,
      minio: {
        endpoint: '',
        region: 'us-east-1',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        forcePathStyle: true,
      },
    },
  },
}));

vi.mock('../../src/services/invoice-filer', () => ({
  getPortugueseMonthFolder: (date: { month: number; year: number }) => {
    const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    return `${months[date.month - 1]}-${date.year}`;
  },
}));

import {
  buildInvoiceObjectKey,
  putInvoiceObject,
  verifyInvoiceObjectChecksum,
} from '../../src/services/invoice-object-storage';

describe('invoice object storage filesystem backend', () => {
  beforeEach(() => {
    testConfig.storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-objects-'));
  });

  afterEach(() => {
    if (testConfig.storageDir) {
      fs.rmSync(testConfig.storageDir, { recursive: true, force: true });
    }
    testConfig.storageDir = '';
  });

  it('round-trips a stored invoice and verifies its checksum', async () => {
    const buffer = Buffer.from('%PDF-1.7\ninvoice-bytes\n');
    const key = buildInvoiceObjectKey({
      tenantId: 7,
      userId: 9,
      documentDate: '2026-04-30',
      filename: 'Fatura Abril.pdf',
    });

    const stored = await putInvoiceObject(buffer, key, 'application/pdf');
    const roundTrip = await verifyInvoiceObjectChecksum(
      stored.objectKey,
      stored.checksum,
      stored.storageBackend,
    );

    expect(stored).toMatchObject({
      objectKey: 'invoices/7/9/2026/Abr-2026/Fatura_Abril.pdf',
      mime: 'application/pdf',
      bytes: buffer.length,
      storageBackend: 'filesystem',
    });
    expect(roundTrip).toEqual(buffer);
    expect(fs.existsSync(path.join(testConfig.storageDir, stored.objectKey))).toBe(true);
  });

  it('rejects unsafe object keys and checksum mismatches', async () => {
    await expect(
      putInvoiceObject(Buffer.from('x'), 'invoices/7/../escape.pdf', 'application/pdf'),
    ).rejects.toThrow(/Unsafe invoice object key/);

    const key = 'invoices/7/9/2026/Abr-2026/safe.pdf';
    const stored = await putInvoiceObject(Buffer.from('%PDF safe'), key, 'application/pdf');

    await expect(
      verifyInvoiceObjectChecksum(stored.objectKey, 'not-the-real-checksum', stored.storageBackend),
    ).rejects.toThrow(/checksum mismatch/);
  });
});
