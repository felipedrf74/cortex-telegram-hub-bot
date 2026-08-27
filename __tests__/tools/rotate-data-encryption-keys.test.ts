// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SERVICE_STOPPED_ACKNOWLEDGEMENT,
  runDataEncryptionKeyRotation,
  type DataEncryptionRotationKeys,
} from '../../src/tools/rotate-data-encryption-keys';
import { decryptValue, encryptValue } from '../../src/utils/encryption';

const roots: string[] = [];

const oldSharedKey = 'old-shared-encryption-key-000000000000000000000000';
const newOAuthKey = 'new-oauth-encryption-key-0000000000000000000000000';
const newGarminKey = 'new-garmin-encryption-key-000000000000000000000000';
const newHealthKey = 'new-health-encryption-key-000000000000000000000000';
const newFinanceKey = 'new-finance-encryption-key-00000000000000000000000';
const webhookEnvelopePrefix = 'nexus-webhook-json-v1:';

function encryptWebhookValue(value: string, key: string, userId: number): string {
  return webhookEnvelopePrefix + encryptValue(value, key, userId);
}

function rotationKeys(overrides: Partial<DataEncryptionRotationKeys> = {}): DataEncryptionRotationKeys {
  return {
    old: {
      oauth: oldSharedKey,
      garmin: oldSharedKey,
      health: oldSharedKey,
      finance: oldSharedKey,
    },
    next: {
      oauth: newOAuthKey,
      garmin: newGarminKey,
      health: newHealthKey,
      finance: newFinanceKey,
    },
    peer: {
      // The peer environment may still use one shared legacy fallback key.
      // This rotation must permit that state while preventing any new key
      // from reusing it.
      oauth: 'peer-shared-encryption-key-00000000000000000000000',
      garmin: 'peer-shared-encryption-key-00000000000000000000000',
      health: 'peer-shared-encryption-key-00000000000000000000000',
      finance: 'peer-shared-encryption-key-00000000000000000000000',
    },
    ...overrides,
  };
}

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nexus-key-rotation-'));
  roots.push(root);
  return root;
}

function createDatabase(options: { allTables?: boolean } = {}): {
  db: Database.Database;
  databasePath: string;
} {
  const root = makeRoot();
  const databasePath = path.join(root, 'bot.db');
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE user_oauth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL
    );
  `);

  if (options.allTables !== false) {
    db.exec(`
      CREATE TABLE garmin_sessions (
        user_id INTEGER PRIMARY KEY,
        oauth1_token_json TEXT,
        oauth2_token_json TEXT
      );
      CREATE TABLE garmin_user_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        garmin_email TEXT,
        tokens_json TEXT
      );
      CREATE TABLE apple_health_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        encrypted_data_json TEXT
      );
      CREATE TABLE finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        encrypted_amount TEXT,
        encrypted_description TEXT
      );
      CREATE TABLE finance_tax_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        encrypted_gross_income TEXT,
        encrypted_deductions TEXT,
        encrypted_taxable_income TEXT,
        encrypted_tax_due TEXT,
        encrypted_inss_due TEXT,
        encrypted_notes TEXT
      );
      CREATE TABLE webhook_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        secret TEXT,
        metadata TEXT
      );
      CREATE TABLE webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        headers TEXT
      );
    `);
  }
  return { db, databasePath };
}

function seedAllTables(db: Database.Database): void {
  db.prepare(`
    INSERT INTO user_oauth_tokens (user_id, access_token, refresh_token)
    VALUES (?, ?, ?)
  `).run(
    11,
    encryptValue('oauth-access', oldSharedKey, 11),
    encryptValue('oauth-refresh', oldSharedKey, 11),
  );
  db.prepare(`
    INSERT INTO webhook_subscriptions (user_id, secret, metadata)
    VALUES (?, ?, ?)
  `).run(
    17,
    encryptWebhookValue('webhook-secret', oldSharedKey, 17),
    encryptWebhookValue(JSON.stringify({ channel: 'owner' }), oldSharedKey, 17),
  );
  db.prepare(`
    INSERT INTO webhook_events (user_id, payload, headers)
    VALUES (?, ?, ?)
  `).run(
    17,
    encryptWebhookValue(JSON.stringify({ event: 'created' }), oldSharedKey, 17),
    encryptWebhookValue(JSON.stringify({ 'x-webhook-id': 'owner-event' }), oldSharedKey, 17),
  );
  db.prepare(`
    INSERT INTO garmin_sessions (user_id, oauth1_token_json, oauth2_token_json)
    VALUES (?, ?, ?)
  `).run(
    12,
    encryptValue('garmin-oauth1', oldSharedKey, 12),
    encryptValue('garmin-oauth2', oldSharedKey, 12),
  );
  db.prepare(`
    INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json)
    VALUES (?, ?, ?)
  `).run(
    13,
    encryptValue('garmin-email', oldSharedKey, 13),
    encryptValue('garmin-token-json', oldSharedKey, 13),
  );
  db.prepare(`
    INSERT INTO apple_health_data (user_id, data_json, encrypted_data_json)
    VALUES (?, ?, ?)
  `).run(
    14,
    JSON.stringify({ encrypted: true }),
    encryptValue('health-json', oldSharedKey, 14),
  );
  db.prepare(`
    INSERT INTO finance_transactions (user_id, encrypted_amount, encrypted_description)
    VALUES (?, ?, ?)
  `).run(
    15,
    encryptValue('125.5', oldSharedKey, 15),
    encryptValue('finance-description', oldSharedKey, 15),
  );
  db.prepare(`
    INSERT INTO finance_tax_events (
      user_id, encrypted_gross_income, encrypted_deductions,
      encrypted_taxable_income, encrypted_tax_due, encrypted_inss_due,
      encrypted_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    16,
    encryptValue('5000', oldSharedKey, 16),
    encryptValue('500', oldSharedKey, 16),
    encryptValue('4500', oldSharedKey, 16),
    encryptValue('900', oldSharedKey, 16),
    encryptValue('550', oldSharedKey, 16),
    encryptValue('finance-tax-notes', oldSharedKey, 16),
  );
}

function protectedBackup(databasePath: string): string {
  const backupPath = path.join(path.dirname(databasePath), `backup-${Date.now()}-${Math.random()}.db`);
  const db = new Database(databasePath, { readonly: true });
  db.pragma('wal_checkpoint(PASSIVE)');
  db.close();
  copyFileSync(databasePath, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function applyOptions(databasePath: string, backupPath: string) {
  return {
    databasePath,
    environment: 'staging' as const,
    keys: rotationKeys(),
    apply: true,
    backupPath,
    servicesStoppedAcknowledgement: SERVICE_STOPPED_ACKNOWLEDGEMENT,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('data encryption key rotation', () => {
  it('defaults to a dry run and does not mutate any encrypted table', () => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    const before = db.prepare('SELECT access_token FROM user_oauth_tokens').pluck().get();
    db.close();

    const result = runDataEncryptionKeyRotation({
      databasePath,
      environment: 'staging',
      keys: rotationKeys(),
    });

    expect(result.mode).toBe('dry-run');
    expect(result.totals).toMatchObject({
      nonempty: 19,
      needsRotation: 19,
      alreadyNew: 0,
      undecryptable: 0,
    });
    expect(result.tables.map((entry) => [entry.table, entry.present])).toEqual([
      ['user_oauth_tokens', true],
      ['webhook_subscriptions', true],
      ['webhook_events', true],
      ['garmin_sessions', true],
      ['garmin_user_tokens', true],
      ['apple_health_data', true],
      ['finance_transactions', true],
      ['finance_tax_events', true],
    ]);
    const serializedReport = JSON.stringify(result);
    expect(serializedReport).not.toContain('oauth-access');
    expect(serializedReport).not.toContain(oldSharedKey);
    expect(serializedReport).not.toContain(newOAuthKey);

    const check = new Database(databasePath, { readonly: true });
    expect(check.prepare('SELECT access_token FROM user_oauth_tokens').pluck().get()).toBe(before);
    check.close();
  });

  it('rotates every encrypted column to its dedicated destination key and verifies the result', () => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    db.close();
    const backupPath = protectedBackup(databasePath);

    const result = runDataEncryptionKeyRotation(applyOptions(databasePath, backupPath));

    expect(result.mode).toBe('apply');
    expect(result.appliedValues).toBe(19);
    expect(result.backupVerified).toBe(true);
    expect(result.postVerification).toMatchObject({
      verified: true,
      needsRotation: 0,
      undecryptable: 0,
      alreadyNew: 19,
    });

    const check = new Database(databasePath, { readonly: true });
    const oauth = check.prepare('SELECT user_id, access_token, refresh_token FROM user_oauth_tokens').get() as any;
    expect(decryptValue(oauth.access_token, newOAuthKey, oauth.user_id)).toBe('oauth-access');
    expect(decryptValue(oauth.refresh_token, newOAuthKey, oauth.user_id)).toBe('oauth-refresh');

    const webhookSubscription = check.prepare('SELECT * FROM webhook_subscriptions').get() as any;
    expect(webhookSubscription.secret).toMatch(/^nexus-webhook-json-v1:/);
    expect(webhookSubscription.metadata).toMatch(/^nexus-webhook-json-v1:/);
    expect(decryptValue(
      webhookSubscription.secret.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      webhookSubscription.user_id,
    )).toBe('webhook-secret');
    expect(JSON.parse(decryptValue(
      webhookSubscription.metadata.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      webhookSubscription.user_id,
    ))).toEqual({ channel: 'owner' });

    const webhookEvent = check.prepare('SELECT * FROM webhook_events').get() as any;
    expect(webhookEvent.payload).toMatch(/^nexus-webhook-json-v1:/);
    expect(webhookEvent.headers).toMatch(/^nexus-webhook-json-v1:/);
    expect(JSON.parse(decryptValue(
      webhookEvent.payload.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      webhookEvent.user_id,
    ))).toEqual({ event: 'created' });
    expect(JSON.parse(decryptValue(
      webhookEvent.headers.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      webhookEvent.user_id,
    ))).toEqual({ 'x-webhook-id': 'owner-event' });

    const session = check.prepare('SELECT * FROM garmin_sessions').get() as any;
    expect(decryptValue(session.oauth1_token_json, newGarminKey, session.user_id)).toBe('garmin-oauth1');
    expect(decryptValue(session.oauth2_token_json, newGarminKey, session.user_id)).toBe('garmin-oauth2');

    const garmin = check.prepare('SELECT * FROM garmin_user_tokens').get() as any;
    expect(decryptValue(garmin.garmin_email, newGarminKey, garmin.user_id)).toBe('garmin-email');
    expect(decryptValue(garmin.tokens_json, newGarminKey, garmin.user_id)).toBe('garmin-token-json');

    const health = check.prepare('SELECT * FROM apple_health_data').get() as any;
    expect(decryptValue(health.encrypted_data_json, newHealthKey, health.user_id)).toBe('health-json');

    const transaction = check.prepare('SELECT * FROM finance_transactions').get() as any;
    expect(decryptValue(transaction.encrypted_amount, newFinanceKey, transaction.user_id)).toBe('125.5');
    expect(decryptValue(transaction.encrypted_description, newFinanceKey, transaction.user_id))
      .toBe('finance-description');

    const tax = check.prepare('SELECT * FROM finance_tax_events').get() as any;
    expect(decryptValue(tax.encrypted_gross_income, newFinanceKey, tax.user_id)).toBe('5000');
    expect(decryptValue(tax.encrypted_deductions, newFinanceKey, tax.user_id)).toBe('500');
    expect(decryptValue(tax.encrypted_taxable_income, newFinanceKey, tax.user_id)).toBe('4500');
    expect(decryptValue(tax.encrypted_tax_due, newFinanceKey, tax.user_id)).toBe('900');
    expect(decryptValue(tax.encrypted_inss_due, newFinanceKey, tax.user_id)).toBe('550');
    expect(decryptValue(tax.encrypted_notes, newFinanceKey, tax.user_id)).toBe('finance-tax-notes');
    check.close();
  });

  it('recognizes already-new ciphertext and is idempotent', () => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    db.close();
    runDataEncryptionKeyRotation(applyOptions(databasePath, protectedBackup(databasePath)));

    const dryRun = runDataEncryptionKeyRotation({
      databasePath,
      environment: 'staging',
      keys: rotationKeys(),
    });
    expect(dryRun.totals).toMatchObject({ needsRotation: 0, alreadyNew: 19, undecryptable: 0 });

    const secondApply = runDataEncryptionKeyRotation(
      applyOptions(databasePath, protectedBackup(databasePath)),
    );
    expect(secondApply.appliedValues).toBe(0);
    expect(secondApply.postVerification.verified).toBe(true);
  });

  it('aborts before mutation when any nonempty value cannot decrypt with old or new keys', () => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    db.prepare('UPDATE apple_health_data SET encrypted_data_json = ?').run(
      encryptValue('wrong-key-health', 'unrelated-key-00000000000000000000000000000000', 14),
    );
    const before = db.prepare('SELECT access_token FROM user_oauth_tokens').pluck().get();
    db.close();

    expect(() => runDataEncryptionKeyRotation(
      applyOptions(databasePath, protectedBackup(databasePath)),
    )).toThrow(/undecryptable nonempty value/);

    const check = new Database(databasePath, { readonly: true });
    expect(check.prepare('SELECT access_token FROM user_oauth_tokens').pluck().get()).toBe(before);
    check.close();
  });

  it('adopts positive-owner legacy webhook plaintext into the preserved envelope', () => {
    const { db, databasePath } = createDatabase();
    db.prepare(`
      INSERT INTO webhook_subscriptions (user_id, secret, metadata)
      VALUES (?, ?, ?)
    `).run(22, 'legacy-secret', JSON.stringify({ channel: 'legacy' }));
    db.prepare(`
      INSERT INTO webhook_events (user_id, payload, headers)
      VALUES (?, ?, ?)
    `).run(
      22,
      JSON.stringify({ event: 'legacy' }),
      JSON.stringify({ 'x-webhook-id': 'legacy-event' }),
    );
    db.close();

    const result = runDataEncryptionKeyRotation(
      applyOptions(databasePath, protectedBackup(databasePath)),
    );

    expect(result.appliedValues).toBe(4);
    const check = new Database(databasePath, { readonly: true });
    const subscription = check.prepare('SELECT * FROM webhook_subscriptions').get() as any;
    const event = check.prepare('SELECT * FROM webhook_events').get() as any;
    for (const value of [subscription.secret, subscription.metadata, event.payload, event.headers]) {
      expect(value).toMatch(/^nexus-webhook-json-v1:/);
    }
    expect(decryptValue(
      subscription.secret.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      22,
    )).toBe('legacy-secret');
    expect(JSON.parse(decryptValue(
      event.payload.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      22,
    ))).toEqual({ event: 'legacy' });
    expect(JSON.parse(decryptValue(
      subscription.metadata.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      22,
    ))).toEqual({ channel: 'legacy' });
    expect(JSON.parse(decryptValue(
      event.headers.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      22,
    ))).toEqual({ 'x-webhook-id': 'legacy-event' });
    check.close();
  });

  it('preserves legacy, old-key, and current-key webhook arrays, scalars, and null JSON', () => {
    const { db, databasePath } = createDatabase();
    db.prepare('INSERT INTO webhook_subscriptions (user_id, metadata) VALUES (?, ?)')
      .run(31, JSON.stringify(['legacy-array']));
    db.prepare('INSERT INTO webhook_subscriptions (user_id, metadata) VALUES (?, ?)')
      .run(32, encryptWebhookValue(JSON.stringify('old-scalar'), oldSharedKey, 32));
    db.prepare('INSERT INTO webhook_subscriptions (user_id, metadata) VALUES (?, ?)')
      .run(33, encryptWebhookValue(JSON.stringify(null), newOAuthKey, 33));
    db.prepare('INSERT INTO webhook_events (user_id, payload, headers) VALUES (?, ?, ?)')
      .run(34, JSON.stringify(null), JSON.stringify('legacy-scalar'));
    db.prepare('INSERT INTO webhook_events (user_id, payload, headers) VALUES (?, ?, ?)')
      .run(
        35,
        encryptWebhookValue(JSON.stringify(['old-array']), oldSharedKey, 35),
        encryptWebhookValue(JSON.stringify(null), oldSharedKey, 35),
      );
    db.prepare('INSERT INTO webhook_events (user_id, payload, headers) VALUES (?, ?, ?)')
      .run(
        36,
        encryptWebhookValue(JSON.stringify('current-scalar'), newOAuthKey, 36),
        encryptWebhookValue(JSON.stringify(['current-array']), newOAuthKey, 36),
      );
    db.close();

    const result = runDataEncryptionKeyRotation(
      applyOptions(databasePath, protectedBackup(databasePath)),
    );
    expect(result.appliedValues).toBe(6);

    const check = new Database(databasePath, { readonly: true });
    const decode = (stored: string, userId: number): unknown => JSON.parse(decryptValue(
      stored.slice(webhookEnvelopePrefix.length),
      newOAuthKey,
      userId,
    ));
    const subscriptions = check.prepare(
      'SELECT user_id, metadata FROM webhook_subscriptions ORDER BY user_id',
    ).all() as Array<{ user_id: number; metadata: string }>;
    expect(subscriptions.map((row) => decode(row.metadata, row.user_id))).toEqual([
      ['legacy-array'],
      'old-scalar',
      null,
    ]);
    const events = check.prepare(
      'SELECT user_id, payload, headers FROM webhook_events ORDER BY user_id',
    ).all() as Array<{ user_id: number; payload: string; headers: string }>;
    expect(events.map((row) => [
      decode(row.payload, row.user_id),
      decode(row.headers, row.user_id),
    ])).toEqual([
      [null, 'legacy-scalar'],
      [['old-array'], null],
      ['current-scalar', ['current-array']],
    ]);
    check.close();
  });

  it.each(['webhook_subscriptions', 'webhook_events'] as const)(
    'fails closed on %s rows without a positive owner',
    (table) => {
      const { db, databasePath } = createDatabase();
      if (table === 'webhook_subscriptions') {
        db.prepare(`
          INSERT INTO webhook_subscriptions (user_id, secret)
          VALUES (0, 'legacy-secret')
        `).run();
      } else {
        db.prepare(`
          INSERT INTO webhook_events (user_id, payload)
          VALUES (0, '{}')
        `).run();
      }
      db.close();

      expect(() => runDataEncryptionKeyRotation({
        databasePath,
        environment: 'staging',
        keys: rotationKeys(),
      })).toThrow(new RegExp(`${table} contains a non-positive rotation owner`));
    },
  );

  it('refuses malformed legacy webhook JSON instead of adopting it as ciphertext', () => {
    const { db, databasePath } = createDatabase();
    db.prepare(`
      INSERT INTO webhook_subscriptions (user_id, metadata)
      VALUES (22, 'not-json')
    `).run();
    db.close();

    expect(() => runDataEncryptionKeyRotation({
      databasePath,
      environment: 'staging',
      keys: rotationKeys(),
    })).toThrow(/undecryptable nonempty value/);
  });

  it('rolls back every table atomically when any update fails', () => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    const before = {
      oauth: db.prepare('SELECT access_token FROM user_oauth_tokens').pluck().get(),
      webhook: db.prepare('SELECT payload FROM webhook_events').pluck().get(),
      health: db.prepare('SELECT encrypted_data_json FROM apple_health_data').pluck().get(),
      financeTransaction: db.prepare('SELECT encrypted_amount FROM finance_transactions').pluck().get(),
      financeTax: db.prepare('SELECT encrypted_notes FROM finance_tax_events').pluck().get(),
    };
    db.exec(`
      CREATE TRIGGER reject_finance_tax_rotation
      BEFORE UPDATE OF encrypted_notes ON finance_tax_events
      BEGIN
        SELECT RAISE(ABORT, 'simulated rotation failure');
      END;
    `);
    db.close();

    expect(() => runDataEncryptionKeyRotation(
      applyOptions(databasePath, protectedBackup(databasePath)),
    )).toThrow(/rotation transaction failed/);

    const check = new Database(databasePath, { readonly: true });
    expect(check.prepare('SELECT access_token FROM user_oauth_tokens').pluck().get()).toBe(before.oauth);
    expect(check.prepare('SELECT payload FROM webhook_events').pluck().get()).toBe(before.webhook);
    expect(check.prepare('SELECT encrypted_data_json FROM apple_health_data').pluck().get()).toBe(before.health);
    expect(check.prepare('SELECT encrypted_amount FROM finance_transactions').pluck().get()).toBe(before.financeTransaction);
    expect(check.prepare('SELECT encrypted_notes FROM finance_tax_events').pluck().get()).toBe(before.financeTax);
    expect(() => decryptValue(String(before.oauth), oldSharedKey, 11)).not.toThrow();
    expect(() => decryptValue(String(before.health), oldSharedKey, 14)).not.toThrow();
    expect(() => decryptValue(String(before.financeTransaction), oldSharedKey, 15)).not.toThrow();
    expect(() => decryptValue(String(before.financeTax), oldSharedKey, 16)).not.toThrow();
    check.close();
  });

  it('handles missing optional tables without inventing or mutating them', () => {
    const { db, databasePath } = createDatabase({ allTables: false });
    db.prepare(`
      INSERT INTO user_oauth_tokens (user_id, access_token, refresh_token)
      VALUES (?, ?, ?)
    `).run(
      21,
      encryptValue('access', oldSharedKey, 21),
      encryptValue('refresh', oldSharedKey, 21),
    );
    db.close();

    const result = runDataEncryptionKeyRotation({
      databasePath,
      environment: 'staging',
      keys: rotationKeys(),
    });
    expect(result.tables.filter((entry) => !entry.present).map((entry) => entry.table)).toEqual([
      'webhook_subscriptions',
      'webhook_events',
      'garmin_sessions',
      'garmin_user_tokens',
      'apple_health_data',
      'finance_transactions',
      'finance_tax_events',
    ]);
    expect(result.totals.needsRotation).toBe(2);
  });

  it('requires an explicit service-stop acknowledgement and a protected matching backup for apply', () => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    db.close();
    const backupPath = protectedBackup(databasePath);

    expect(() => runDataEncryptionKeyRotation({
      ...applyOptions(databasePath, backupPath),
      servicesStoppedAcknowledgement: undefined,
    })).toThrow(/service-stopped acknowledgement/);
    expect(() => runDataEncryptionKeyRotation({
      ...applyOptions(databasePath, backupPath),
      backupPath: undefined,
    })).toThrow(/protected backup/);

    chmodSync(backupPath, 0o644);
    expect(() => runDataEncryptionKeyRotation(applyOptions(databasePath, backupPath)))
      .toThrow(/backup permissions/);
  });

  it.each([
    ['webhook_subscriptions', 'secret'],
    ['webhook_subscriptions', 'metadata'],
    ['webhook_events', 'payload'],
    ['webhook_events', 'headers'],
  ] as const)('rejects a protected backup that omits changed %s.%s state', (table, column) => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    db.close();
    const backupPath = protectedBackup(databasePath);

    const changed = new Database(databasePath);
    changed.prepare(`UPDATE ${table} SET ${column} = ?`).run(
      encryptWebhookValue(
        column === 'secret' ? 'changed' : JSON.stringify({ changed: true }),
        oldSharedKey,
        17,
      ),
    );
    changed.close();

    expect(() => runDataEncryptionKeyRotation(applyOptions(databasePath, backupPath)))
      .toThrow(/backup does not match/);
  });

  it('rejects reused destination keys across domains or environments', () => {
    const { db, databasePath } = createDatabase();
    seedAllTables(db);
    db.close();

    expect(() => runDataEncryptionKeyRotation({
      databasePath,
      environment: 'production',
      keys: rotationKeys({
        next: {
          oauth: newOAuthKey,
          garmin: newOAuthKey,
          health: newHealthKey,
          finance: newFinanceKey,
        },
      }),
    })).toThrow(/destination keys must be distinct/);

    expect(() => runDataEncryptionKeyRotation({
      databasePath,
      environment: 'production',
      keys: rotationKeys({
        peer: {
          oauth: newOAuthKey,
          garmin: 'peer-garmin-encryption-key-00000000000000000000000',
          health: 'peer-health-encryption-key-00000000000000000000000',
          finance: 'peer-finance-encryption-key-0000000000000000000000',
        },
      }),
    })).toThrow(/peer environment/);
  });
});
