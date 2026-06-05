// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { encryptValue, decryptValue } from '../utils/encryption';
import type Database from 'better-sqlite3';

type AppleHealthJsonRow = {
  data_json: string;
  encrypted_data_json?: string | null;
};

const REDACTED_HEALTH_JSON = JSON.stringify({ encrypted: true });

function healthEncryptionKey(): string {
  return process.env.HEALTH_DATA_ENCRYPTION_KEY
    || process.env.OAUTH_ENCRYPTION_KEY
    || process.env.FINANCE_ENCRYPTION_KEY
    || '';
}

export function encodeAppleHealthPayload(
  userId: number,
  payload: unknown,
): { dataJson: string; encryptedDataJson: string | null } {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const key = healthEncryptionKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('HEALTH_DATA_ENCRYPTION_KEY is required to store Apple Health data in production');
    }
    return { dataJson: plaintext, encryptedDataJson: null };
  }

  return {
    dataJson: REDACTED_HEALTH_JSON,
    encryptedDataJson: encryptValue(plaintext, key, userId),
  };
}

export function decodeAppleHealthDataJson(row: AppleHealthJsonRow, userId: number): string {
  if (row.encrypted_data_json) {
    const key = healthEncryptionKey();
    if (!key) {
      if (row.data_json !== REDACTED_HEALTH_JSON) return row.data_json;
      throw new Error('Apple Health encryption key is required to read encrypted data');
    }
    return decryptValue(row.encrypted_data_json, key, userId);
  }
  return row.data_json;
}

export function parseAppleHealthDataJson<T = any>(row: AppleHealthJsonRow, userId: number): T {
  return JSON.parse(decodeAppleHealthDataJson(row, userId)) as T;
}

export function appleHealthJsonSelectColumns(db: Database.Database, tableAlias?: string): string {
  const encryptedColumn = hasAppleHealthEncryptedColumn(db)
    ? `${tableAlias ? `${tableAlias}.` : ''}encrypted_data_json`
    : 'NULL';
  return `${tableAlias ? `${tableAlias}.` : ''}data_json, ${encryptedColumn} AS encrypted_data_json`;
}

function hasAppleHealthEncryptedColumn(db: Database.Database): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(apple_health_data)`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === 'encrypted_data_json');
  } catch {
    return false;
  }
}
