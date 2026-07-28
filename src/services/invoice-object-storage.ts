// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config } from '../config';
import { getPortugueseMonthFolder } from './invoice-filer';

export type InvoiceStorageBackend = 'filesystem';

export interface StoredInvoiceObject {
  objectKey: string;
  checksum: string;
  mime: string;
  bytes: number;
  storageBackend: InvoiceStorageBackend;
}

export function isInvoiceObjectStorageConfigured(): boolean {
  return config.invoiceObjectStorage.enabled;
}

function safeKeyPart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9€.,\-_àáãâéêíóôõúçÀÁÃÂÉÊÍÓÔÕÚÇ]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 160);
  return cleaned || fallback;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertSafeObjectKey(objectKey: string): void {
  if (
    objectKey.startsWith('/') ||
    objectKey.includes('\\') ||
    objectKey.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error('Unsafe invoice object key');
  }
}

function filesystemPathForKey(objectKey: string): string {
  assertSafeObjectKey(objectKey);
  const root = path.resolve(process.cwd(), config.invoiceObjectStorage.filesystemDir);
  const resolved = path.resolve(root, objectKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invoice object key escapes storage root');
  }
  return resolved;
}

function tenantPrefixForKey(objectKey: string): string | null {
  const parts = objectKey.split('/');
  if (parts.length < 3 || parts[0] !== 'invoices') return null;
  return path.join('invoices', parts[1]);
}

function directorySizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySizeBytes(fullPath);
    } else if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

function assertFilesystemGuardrails(objectKey: string, bytesToWrite: number): void {
  const root = path.resolve(process.cwd(), config.invoiceObjectStorage.filesystemDir);
  fs.mkdirSync(root, { recursive: true });

  if (config.invoiceObjectStorage.minFreeBytes > 0) {
    const stats = fs.statfsSync(root);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if ((availableBytes - bytesToWrite) < config.invoiceObjectStorage.minFreeBytes) {
      throw new Error('Invoice object storage free-space guardrail would be violated.');
    }
  }

  if (config.invoiceObjectStorage.tenantMaxBytes > 0) {
    const tenantPrefix = tenantPrefixForKey(objectKey);
    if (tenantPrefix) {
      const tenantDir = path.resolve(root, tenantPrefix);
      const tenantBytes = directorySizeBytes(tenantDir);
      if ((tenantBytes + bytesToWrite) > config.invoiceObjectStorage.tenantMaxBytes) {
        throw new Error('Invoice object storage tenant byte cap would be exceeded.');
      }
    }
  }
}

export function buildInvoiceObjectKey(input: {
  tenantId: number;
  userId: number;
  documentDate: string | null | undefined;
  filename: string;
}): string {
  assertPositiveId(input.tenantId, 'tenantId');
  assertPositiveId(input.userId, 'userId');
  const parsed = input.documentDate
    ? DateTime.fromISO(input.documentDate, { zone: config.app.timezone })
    : null;
  const effectiveDate = parsed?.isValid ? parsed : DateTime.now().setZone(config.app.timezone);
  const monthFolder = getPortugueseMonthFolder(effectiveDate);
  return [
    'invoices',
    String(input.tenantId),
    String(input.userId),
    String(effectiveDate.year),
    monthFolder,
    safeKeyPart(input.filename, `invoice-${Date.now()}`),
  ].join('/');
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function putInvoiceObject(
  buffer: Buffer,
  objectKey: string,
  mime: string,
): Promise<StoredInvoiceObject> {
  if (!isInvoiceObjectStorageConfigured()) {
    throw new Error('Invoice object storage is not configured.');
  }
  if (buffer.length > config.invoiceObjectStorage.maxObjectBytes) {
    throw new Error(`Invoice object exceeds ${config.invoiceObjectStorage.maxObjectBytes} bytes.`);
  }
  assertSafeObjectKey(objectKey);

  const checksum = sha256Hex(buffer);
  assertFilesystemGuardrails(objectKey, buffer.length);
  const targetPath = filesystemPathForKey(objectKey);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);

  return {
    objectKey,
    checksum,
    mime,
    bytes: buffer.length,
    storageBackend: 'filesystem',
  };
}

export async function getInvoiceObjectBuffer(
  objectKey: string,
  storageBackend: string | null | undefined = 'filesystem',
): Promise<Buffer> {
  assertSafeObjectKey(objectKey);
  // Historical `legacy_scp` rows were always resolved through the local
  // filesystem fallback. Preserve that read compatibility while retiring only
  // the unused MinIO/S3 implementation.
  if (storageBackend != null
      && storageBackend !== 'filesystem'
      && storageBackend !== 'legacy_scp') {
    throw new Error(`Unsupported invoice object storage backend: ${storageBackend}`);
  }
  return fs.readFileSync(filesystemPathForKey(objectKey));
}

export async function verifyInvoiceObjectChecksum(
  objectKey: string,
  expectedChecksum: string | null | undefined,
  storageBackend?: string | null,
): Promise<Buffer> {
  const buffer = await getInvoiceObjectBuffer(objectKey, storageBackend);
  // Legacy filings may not have a checksum; new stored objects always should.
  if (expectedChecksum && sha256Hex(buffer) !== expectedChecksum) {
    throw new Error('Invoice object checksum mismatch');
  }
  return buffer;
}
