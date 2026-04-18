// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';

export interface OwnerBootstrapPreflightStatus {
  ok: boolean;
  configuredOwnerTelegramId: number | null;
  persistedOwnerTelegramId: number | null;
  persistedOwnerUserId: number | null;
  persistedOwnerCount: number;
  dbPath: string;
  dbExists: boolean;
  seedAction: 'seed' | 'upgrade' | 'none';
  warnings: string[];
  errors: string[];
}

interface PersistedOwnerRow {
  id: number;
  telegram_id: number;
}

function parseConfiguredOwnerTelegramId(): number | null {
  const value = parseInt(process.env.OWNER_TELEGRAM_ID || '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getConfiguredDatabasePath(): string {
  return process.env.DATABASE_PATH || './data/bot.db';
}

function readPersistedOwnerRows(dbPath: string): PersistedOwnerRow[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const usersTableExists = db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'users'
      LIMIT 1
    `).get();

    if (!usersTableExists) {
      return [];
    }

    return db.prepare(`
      SELECT id, telegram_id
      FROM users
      WHERE tier = 'owner' AND telegram_id IS NOT NULL
      ORDER BY id ASC
    `).all() as PersistedOwnerRow[];
  } finally {
    db.close();
  }
}

function readMatchingTelegramUser(dbPath: string, telegramId: number): { id: number } | null {
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const usersTableExists = db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'users'
      LIMIT 1
    `).get();

    if (!usersTableExists) {
      return null;
    }

    return (db.prepare(`
      SELECT id
      FROM users
      WHERE telegram_id = ?
      LIMIT 1
    `).get(telegramId) as { id: number } | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function getOwnerBootstrapPreflightStatus(): OwnerBootstrapPreflightStatus {
  const configuredOwnerTelegramId = parseConfiguredOwnerTelegramId();
  const dbPath = getConfiguredDatabasePath();
  const persistedOwnerRows = readPersistedOwnerRows(dbPath);
  const persistedOwner = persistedOwnerRows[0] ?? null;
  const warnings: string[] = [];
  const errors: string[] = [];
  let seedAction: OwnerBootstrapPreflightStatus['seedAction'] = 'none';

  if (persistedOwnerRows.length > 1) {
    warnings.push(
      `Multiple persisted owner rows detected (${persistedOwnerRows.length}); runtime will use the lowest id owner row first.`,
    );
  }

  if (
    configuredOwnerTelegramId
    && persistedOwner
    && configuredOwnerTelegramId !== persistedOwner.telegram_id
  ) {
    errors.push(
      `OWNER_TELEGRAM_ID=${configuredOwnerTelegramId} does not match persisted owner telegram_id=${persistedOwner.telegram_id}.`,
    );
  } else if (!configuredOwnerTelegramId && !persistedOwner) {
    errors.push(
      'No explicit OWNER_TELEGRAM_ID and no persisted owner-tier user row were found.',
    );
  } else if (configuredOwnerTelegramId && !persistedOwner) {
    const matchingUser = readMatchingTelegramUser(dbPath, configuredOwnerTelegramId);
    seedAction = matchingUser ? 'upgrade' : 'seed';
  }

  return {
    ok: errors.length === 0,
    configuredOwnerTelegramId,
    persistedOwnerTelegramId: persistedOwner?.telegram_id ?? null,
    persistedOwnerUserId: persistedOwner?.id ?? null,
    persistedOwnerCount: persistedOwnerRows.length,
    dbPath,
    dbExists: fs.existsSync(dbPath),
    seedAction,
    warnings,
    errors,
  };
}
