import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-owner-bootstrap-'));
let dbPath: string;

import { getOwnerBootstrapPreflightStatus } from '../../src/services/owner-bootstrap-preflight';

function createUsersDb(targetPath: string): Database.Database {
  const db = new Database(targetPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free'
    );
  `);
  return db;
}

describe('owner-bootstrap-preflight', () => {
  beforeEach(() => {
    dbPath = path.join(tempRoot, `owner-bootstrap-${Date.now()}-${Math.random()}.db`);
    vi.unstubAllEnvs();
    vi.stubEnv('OWNER_TELEGRAM_ID', '');
    vi.stubEnv('DATABASE_PATH', dbPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it('fails when neither explicit env nor persisted owner exists', () => {
    const status = getOwnerBootstrapPreflightStatus();
    expect(status.ok).toBe(false);
    expect(status.errors).toContain(
      'No explicit OWNER_TELEGRAM_ID and no persisted owner-tier user row were found.',
    );
  });

  it('passes and reports seed when OWNER_TELEGRAM_ID exists without a persisted owner row', () => {
    vi.stubEnv('OWNER_TELEGRAM_ID', '111111');

    const status = getOwnerBootstrapPreflightStatus();

    expect(status.ok).toBe(true);
    expect(status.seedAction).toBe('seed');
    expect(status.configuredOwnerTelegramId).toBe(111111);
  });

  it('passes and reports upgrade when OWNER_TELEGRAM_ID matches an existing non-owner Telegram user', () => {
    vi.stubEnv('OWNER_TELEGRAM_ID', '111111');
    const db = createUsersDb(dbPath);
    db.prepare(`INSERT INTO users (telegram_id, tier) VALUES (?, 'pro')`).run(111111);
    db.close();

    const status = getOwnerBootstrapPreflightStatus();

    expect(status.ok).toBe(true);
    expect(status.seedAction).toBe('upgrade');
  });

  it('passes when a persisted owner row already exists', () => {
    const db = createUsersDb(dbPath);
    db.prepare(`INSERT INTO users (telegram_id, tier) VALUES (?, 'owner')`).run(222222);
    db.close();

    const status = getOwnerBootstrapPreflightStatus();

    expect(status.ok).toBe(true);
    expect(status.persistedOwnerTelegramId).toBe(222222);
    expect(status.seedAction).toBe('none');
  });

  it('fails when explicit env and persisted owner disagree', () => {
    vi.stubEnv('OWNER_TELEGRAM_ID', '111111');
    const db = createUsersDb(dbPath);
    db.prepare(`INSERT INTO users (telegram_id, tier) VALUES (?, 'owner')`).run(222222);
    db.close();

    const status = getOwnerBootstrapPreflightStatus();

    expect(status.ok).toBe(false);
    expect(status.errors).toContain(
      'OWNER_TELEGRAM_ID=111111 does not match persisted owner telegram_id=222222.',
    );
  });

  it('warns when multiple persisted owner rows exist', () => {
    const db = createUsersDb(dbPath);
    db.prepare(`INSERT INTO users (telegram_id, tier) VALUES (?, 'owner')`).run(111111);
    db.prepare(`INSERT INTO users (telegram_id, tier) VALUES (?, 'owner')`).run(222222);
    db.close();

    const status = getOwnerBootstrapPreflightStatus();

    expect(status.ok).toBe(true);
    expect(status.warnings[0]).toContain('Multiple persisted owner rows detected');
  });
});
