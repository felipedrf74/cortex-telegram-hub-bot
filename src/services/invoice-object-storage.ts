// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DateTime } from 'luxon';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';
import { getPortugueseMonthFolder } from './invoice-filer';

export type InvoiceStorageBackend = 'minio' | 'filesystem';

export interface StoredInvoiceObject {
  objectKey: string;
  checksum: string;
  mime: string;
  bytes: number;
  storageBackend: InvoiceStorageBackend;
}

let s3Client: S3Client | null = null;

function configuredBackend(): InvoiceStorageBackend {
  return config.invoiceObjectStorage.backend === 'minio' ? 'minio' : 'filesystem';
}

export function isInvoiceObjectStorageConfigured(): boolean {
  if (!config.invoiceObjectStorage.enabled) return false;
  if (configuredBackend() !== 'minio') return true;
  const minio = config.invoiceObjectStorage.minio;
  return Boolean(minio.endpoint && minio.bucket && minio.accessKeyId && minio.secretAccessKey);
}

function getS3Client(): S3Client {
  if (s3Client) return s3Client;
  const minio = config.invoiceObjectStorage.minio;
  s3Client = new S3Client({
    endpoint: minio.endpoint,
    region: minio.region,
    forcePathStyle: minio.forcePathStyle,
    credentials: {
      accessKeyId: minio.accessKeyId,
      secretAccessKey: minio.secretAccessKey,
    },
  });
  return s3Client;
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

function sha256Base64(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('base64');
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

  const backend = configuredBackend();
  const checksum = sha256Hex(buffer);

  if (backend === 'minio') {
    const minio = config.invoiceObjectStorage.minio;
    await getS3Client().send(new PutObjectCommand({
      Bucket: minio.bucket,
      Key: objectKey,
      Body: buffer,
      ContentType: mime,
      ChecksumSHA256: sha256Base64(buffer),
    }));
    await getS3Client().send(new HeadObjectCommand({
      Bucket: minio.bucket,
      Key: objectKey,
    }));
  } else {
    assertFilesystemGuardrails(objectKey, buffer.length);
    const targetPath = filesystemPathForKey(objectKey);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, buffer);
  }

  return {
    objectKey,
    checksum,
    mime,
    bytes: buffer.length,
    storageBackend: backend,
  };
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  if (stream instanceof Uint8Array) return Buffer.from(stream);
  if (stream instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (stream && typeof (stream as any).transformToByteArray === 'function') {
    return Buffer.from(await (stream as any).transformToByteArray());
  }
  throw new Error('Unsupported invoice object stream');
}

export async function getInvoiceObjectBuffer(
  objectKey: string,
  storageBackend: string | null | undefined = configuredBackend(),
): Promise<Buffer> {
  assertSafeObjectKey(objectKey);
  const backend = storageBackend === 'minio' ? 'minio' : 'filesystem';
  if (backend === 'minio') {
    if (!isInvoiceObjectStorageConfigured()) {
      throw new Error('Invoice object storage is not configured.');
    }
    const response = await getS3Client().send(new GetObjectCommand({
      Bucket: config.invoiceObjectStorage.minio.bucket,
      Key: objectKey,
    }));
    return streamToBuffer(response.Body);
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
