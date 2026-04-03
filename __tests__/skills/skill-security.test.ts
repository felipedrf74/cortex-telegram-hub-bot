/**
 * Skill Security Audit Tests
 *
 * Verifies:
 * 1. SQLite table namespacing (skill_id foreign keys, cascade deletes)
 * 2. Cross-skill data access is blocked (credential isolation, submodule isolation)
 * 3. Credential encryption at rest (AES-256-GCM, no plaintext leaks)
 * 4. Malformed manifest handling (graceful failures, injection resistance)
 * 5. Missing/circular dependency handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// ── Test helpers ───────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// ── Mock getDb ────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER mocks
import { install, uninstall, getByName, getSubmodules } from '../../src/skills/registry';
import {
  encrypt,
  decrypt,
  setCredential,
  getCredential,
  deleteCredential,
  listCredentialKeys,
  clearCredentials,
} from '../../src/skills/credentials';
import { validateManifest, resolveDependencies, loadManifest } from '../../src/skills/loader';
import type { DependencyNode } from '../../src/skills/types';

// ═══════════════════════════════════════════════════════════════════
// 1. TABLE NAMESPACING — skill_id foreign keys
// ═══════════════════════════════════════════════════════════════════

describe('Security: Table namespacing', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('skill_submodules requires valid skill_id (foreign key)', () => {
    expect(() => {
      testDb.prepare(
        'INSERT INTO skill_submodules (skill_id, module_name) VALUES (?, ?)'
      ).run(99999, 'rogue-module');
    }).toThrow();
  });

  it('skill_credentials requires valid skill_id (foreign key)', () => {
    expect(() => {
      testDb.prepare(
        'INSERT INTO skill_credentials (skill_id, key_name, encrypted_value) VALUES (?, ?, ?)'
      ).run(99999, 'api-key', 'fake-encrypted');
    }).toThrow();
  });

  it('skill_migrations requires valid skill_id (foreign key)', () => {
    expect(() => {
      testDb.prepare(
        'INSERT INTO skill_migrations (skill_id, migration_name) VALUES (?, ?)'
      ).run(99999, 'init');
    }).toThrow();
  });

  it('cascade-deletes credentials when skill is uninstalled', () => {
    const skill = install({ name: 'temp-skill' });
    // Insert credential directly
    testDb.prepare(
      'INSERT INTO skill_credentials (skill_id, key_name, encrypted_value) VALUES (?, ?, ?)'
    ).run(skill.id, 'secret', 'enc-value');

    const before = testDb.prepare(
      'SELECT COUNT(*) as c FROM skill_credentials WHERE skill_id = ?'
    ).get(skill.id) as any;
    expect(before.c).toBe(1);

    uninstall('temp-skill');

    const after = testDb.prepare(
      'SELECT COUNT(*) as c FROM skill_credentials WHERE skill_id = ?'
    ).get(skill.id) as any;
    expect(after.c).toBe(0);
  });

  it('cascade-deletes migrations when skill is uninstalled', () => {
    const skill = install({ name: 'migrated-skill' });
    testDb.prepare(
      'INSERT INTO skill_migrations (skill_id, migration_name) VALUES (?, ?)'
    ).run(skill.id, '001_init');

    uninstall('migrated-skill');

    const rows = testDb.prepare(
      'SELECT * FROM skill_migrations WHERE skill_id = ?'
    ).all(skill.id);
    expect(rows).toHaveLength(0);
  });

  it('skill_submodules UNIQUE constraint prevents duplicate module per skill', () => {
    const skill = install({ name: 'unique-test' });
    testDb.prepare(
      'INSERT INTO skill_submodules (skill_id, module_name) VALUES (?, ?)'
    ).run(skill.id, 'mod-a');

    expect(() => {
      testDb.prepare(
        'INSERT INTO skill_submodules (skill_id, module_name) VALUES (?, ?)'
      ).run(skill.id, 'mod-a');
    }).toThrow();
  });

  it('skill_credentials composite PK prevents duplicate key per skill', () => {
    const skill = install({ name: 'cred-unique-test' });
    testDb.prepare(
      'INSERT INTO skill_credentials (skill_id, key_name, encrypted_value) VALUES (?, ?, ?)'
    ).run(skill.id, 'api-key', 'enc1');

    expect(() => {
      testDb.prepare(
        'INSERT INTO skill_credentials (skill_id, key_name, encrypted_value) VALUES (?, ?, ?)'
      ).run(skill.id, 'api-key', 'enc2');
    }).toThrow();
  });

  it('different skills can have same-named submodules (namespaced by skill_id)', () => {
    const skillA = install({ name: 'skill-a' });
    const skillB = install({ name: 'skill-b' });

    testDb.prepare(
      'INSERT INTO skill_submodules (skill_id, module_name) VALUES (?, ?)'
    ).run(skillA.id, 'shared-memory');
    testDb.prepare(
      'INSERT INTO skill_submodules (skill_id, module_name) VALUES (?, ?)'
    ).run(skillB.id, 'shared-memory');

    const subsA = testDb.prepare(
      'SELECT * FROM skill_submodules WHERE skill_id = ?'
    ).all(skillA.id);
    const subsB = testDb.prepare(
      'SELECT * FROM skill_submodules WHERE skill_id = ?'
    ).all(skillB.id);
    expect(subsA).toHaveLength(1);
    expect(subsB).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. CROSS-SKILL DATA ACCESS — isolation enforcement
// ═══════════════════════════════════════════════════════════════════

describe('Security: Cross-skill data access blocked', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('credential API scopes reads to the owning skill', () => {
    install({ name: 'skill-alpha' });
    install({ name: 'skill-beta' });

    setCredential('skill-alpha', 'api-key', 'alpha-secret-123');
    setCredential('skill-beta', 'api-key', 'beta-secret-456');

    // Each skill only sees its own credential
    expect(getCredential('skill-alpha', 'api-key')).toBe('alpha-secret-123');
    expect(getCredential('skill-beta', 'api-key')).toBe('beta-secret-456');

    // skill-beta cannot read skill-alpha's credential
    // (there's no cross-skill read — the API requires the owner's name)
    const betaKeys = listCredentialKeys('skill-beta');
    expect(betaKeys).toEqual(['api-key']);
    expect(betaKeys).not.toContain('alpha-secret-123');
  });

  it('credential deletion is scoped — cannot delete another skill\'s credential', () => {
    install({ name: 'skill-x' });
    install({ name: 'skill-y' });

    setCredential('skill-x', 'token', 'x-token');
    setCredential('skill-y', 'token', 'y-token');

    // Attempt to delete skill-x's credential using skill-y's name — should not affect skill-x
    deleteCredential('skill-y', 'token');

    expect(getCredential('skill-x', 'token')).toBe('x-token');
    expect(getCredential('skill-y', 'token')).toBeUndefined();
  });

  it('clearCredentials only clears the target skill', () => {
    install({ name: 'keeper' });
    install({ name: 'clearer' });

    setCredential('keeper', 'secret-a', 'value-a');
    setCredential('keeper', 'secret-b', 'value-b');
    setCredential('clearer', 'secret-c', 'value-c');

    clearCredentials('clearer');

    expect(listCredentialKeys('keeper')).toEqual(['secret-a', 'secret-b']);
    expect(listCredentialKeys('clearer')).toEqual([]);
  });

  it('submodule queries are scoped by skill_id', () => {
    const skillA = install({
      name: 'domain-a',
      submodules: [{ module_name: 'tasks' }, { module_name: 'calendar' }],
    });
    const skillB = install({
      name: 'domain-b',
      submodules: [{ module_name: 'training' }],
    });

    const subsA = getSubmodules(skillA.id);
    const subsB = getSubmodules(skillB.id);

    expect(subsA).toHaveLength(2);
    expect(subsB).toHaveLength(1);
    // Ensure no cross-contamination
    expect(subsA.map(s => s.module_name)).not.toContain('training');
    expect(subsB.map(s => s.module_name)).not.toContain('tasks');
  });

  it('uninstalling one skill does not affect another skill\'s data', () => {
    install({ name: 'survivor' });
    install({ name: 'doomed' });

    setCredential('survivor', 'key', 'safe-value');
    setCredential('doomed', 'key', 'doomed-value');

    uninstall('doomed');

    expect(getCredential('survivor', 'key')).toBe('safe-value');
    expect(getByName('survivor')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. CREDENTIAL ENCRYPTION — at-rest security
// ═══════════════════════════════════════════════════════════════════

describe('Security: Credential encryption', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('encrypt/decrypt round-trips correctly', () => {
    const secret = 'my-super-secret-api-key-12345';
    const encrypted = encrypt(secret);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('encrypted output differs from plaintext', () => {
    const secret = 'plaintext-value';
    const encrypted = encrypt(secret);
    expect(encrypted).not.toBe(secret);
    expect(encrypted).not.toContain(secret);
  });

  it('encrypting same value twice produces different ciphertext (random IV)', () => {
    const secret = 'same-value';
    const enc1 = encrypt(secret);
    const enc2 = encrypt(secret);
    expect(enc1).not.toBe(enc2);
    // Both still decrypt to the same value
    expect(decrypt(enc1)).toBe(secret);
    expect(decrypt(enc2)).toBe(secret);
  });

  it('tampered ciphertext fails to decrypt (GCM auth tag)', () => {
    const encrypted = encrypt('sensitive-data');
    const buf = Buffer.from(encrypted, 'base64');
    // Flip a byte in the ciphertext portion (after IV + authTag)
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('truncated ciphertext fails to decrypt', () => {
    const encrypted = encrypt('data');
    const truncated = encrypted.slice(0, 10);
    expect(() => decrypt(truncated)).toThrow();
  });

  it('empty string ciphertext fails to decrypt', () => {
    expect(() => decrypt('')).toThrow();
  });

  it('credential values are stored encrypted in the database', () => {
    install({ name: 'enc-test-skill' });
    const plaintext = 'super-secret-token-xyz';
    setCredential('enc-test-skill', 'api-token', plaintext);

    // Read raw value from DB — should NOT be plaintext
    const row = testDb.prepare(
      `SELECT encrypted_value FROM skill_credentials
       WHERE skill_id = (SELECT id FROM installed_skills WHERE name = ?) AND key_name = ?`
    ).get('enc-test-skill', 'api-token') as { encrypted_value: string };

    expect(row.encrypted_value).not.toBe(plaintext);
    expect(row.encrypted_value).not.toContain(plaintext);

    // But the API returns decrypted value
    expect(getCredential('enc-test-skill', 'api-token')).toBe(plaintext);
  });

  it('handles special characters in credential values', () => {
    install({ name: 'special-char-skill' });
    const specials = 'p@$$w0rd!#%^&*()\n\ttab "quotes" \'apos\' 日本語 🔐';
    setCredential('special-char-skill', 'password', specials);
    expect(getCredential('special-char-skill', 'password')).toBe(specials);
  });

  it('handles empty string credential value', () => {
    install({ name: 'empty-val-skill' });
    setCredential('empty-val-skill', 'optional-key', '');
    expect(getCredential('empty-val-skill', 'optional-key')).toBe('');
  });

  it('handles long credential values', () => {
    install({ name: 'long-val-skill' });
    const longValue = 'x'.repeat(10000);
    setCredential('long-val-skill', 'big-secret', longValue);
    expect(getCredential('long-val-skill', 'big-secret')).toBe(longValue);
  });

  it('setCredential throws for non-existent skill', () => {
    expect(() => setCredential('ghost-skill', 'key', 'value')).toThrow('Skill not found: ghost-skill');
  });

  it('getCredential returns undefined for non-existent skill', () => {
    expect(getCredential('ghost-skill', 'key')).toBeUndefined();
  });

  it('getCredential returns undefined for non-existent key', () => {
    install({ name: 'exists-skill' });
    expect(getCredential('exists-skill', 'missing-key')).toBeUndefined();
  });

  it('deleteCredential returns false for non-existent skill', () => {
    expect(deleteCredential('ghost-skill', 'key')).toBe(false);
  });

  it('listCredentialKeys returns empty for non-existent skill', () => {
    expect(listCredentialKeys('ghost-skill')).toEqual([]);
  });

  it('setCredential updates existing credential (upsert)', () => {
    install({ name: 'upsert-skill' });
    setCredential('upsert-skill', 'token', 'original');
    setCredential('upsert-skill', 'token', 'updated');
    expect(getCredential('upsert-skill', 'token')).toBe('updated');

    // Only one row in DB
    const count = testDb.prepare(
      `SELECT COUNT(*) as c FROM skill_credentials
       WHERE skill_id = (SELECT id FROM installed_skills WHERE name = ?)`
    ).get('upsert-skill') as any;
    expect(count.c).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. MALFORMED MANIFEST — graceful failure & injection resistance
// ═══════════════════════════════════════════════════════════════════

describe('Security: Malformed manifest handling', () => {
  it('rejects null manifest', () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('non-null object');
  });

  it('rejects undefined manifest', () => {
    const result = validateManifest(undefined);
    expect(result.valid).toBe(false);
  });

  it('rejects string manifest', () => {
    const result = validateManifest('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects array manifest', () => {
    const result = validateManifest([1, 2, 3]);
    expect(result.valid).toBe(false);
  });

  it('rejects numeric manifest', () => {
    const result = validateManifest(42);
    expect(result.valid).toBe(false);
  });

  it('rejects empty object manifest (missing required fields)', () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'name')).toBe(true);
    expect(result.errors.some(e => e.field === 'version')).toBe(true);
  });

  it('rejects name with SQL injection attempt', () => {
    const result = validateManifest({
      name: "'; DROP TABLE installed_skills; --",
      version: '1.0.0',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects name with path traversal attempt', () => {
    const result = validateManifest({
      name: '../../../etc/passwd',
      version: '1.0.0',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    const result = validateManifest({
      name: '-bad-name',
      version: '1.0.0',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects name with uppercase letters', () => {
    const result = validateManifest({
      name: 'BadName',
      version: '1.0.0',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects name with spaces', () => {
    const result = validateManifest({
      name: 'bad name',
      version: '1.0.0',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects version with non-semver format', () => {
    const result = validateManifest({ name: 'valid-name', version: 'latest' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'version')).toBe(true);
  });

  it('rejects version with extra segments', () => {
    const result = validateManifest({ name: 'valid-name', version: '1.2.3.4' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-string description', () => {
    const result = validateManifest({
      name: 'valid-name',
      version: '1.0.0',
      description: { malicious: true },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'description')).toBe(true);
  });

  it('rejects non-array dependencies', () => {
    const result = validateManifest({
      name: 'valid-name',
      version: '1.0.0',
      dependencies: 'not-an-array',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects non-string items in dependencies', () => {
    const result = validateManifest({
      name: 'valid-name',
      version: '1.0.0',
      dependencies: [123, null, { obj: true }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects submodules with missing module_name', () => {
    const result = validateManifest({
      name: 'valid-name',
      version: '1.0.0',
      submodules: [{ notModuleName: 'bad' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes('module_name'))).toBe(true);
  });

  it('rejects duplicate submodule names', () => {
    const result = validateManifest({
      name: 'valid-name',
      version: '1.0.0',
      submodules: [
        { module_name: 'dupe' },
        { module_name: 'dupe' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects submodule referencing non-existent dependency', () => {
    const result = validateManifest({
      name: 'valid-name',
      version: '1.0.0',
      submodules: [
        { module_name: 'real-mod', dependencies: ['ghost-mod'] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('unknown submodule'))).toBe(true);
  });

  it('accepts a fully valid manifest', () => {
    const result = validateManifest({
      name: 'valid-skill',
      version: '1.0.0',
      description: 'A valid skill',
      author: 'test',
      domain: 'secretary',
      dependencies: ['other-skill'],
      submodules: [
        { module_name: 'tasks', dependencies: [] },
        { module_name: 'calendar', dependencies: ['tasks'] },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collects ALL validation errors (does not short-circuit)', () => {
    const result = validateManifest({
      name: '',
      version: '',
      description: 42,
      author: 123,
      domain: true,
      dependencies: 'not-array',
      submodules: 'not-array',
    });
    expect(result.valid).toBe(false);
    // Should have errors for name, version, description, author, domain, dependencies, submodules
    expect(result.errors.length).toBeGreaterThanOrEqual(7);
  });

  it('handles __proto__ pollution attempt in manifest', () => {
    const result = validateManifest({
      name: 'legit-skill',
      version: '1.0.0',
      __proto__: { isAdmin: true },
    });
    // Should still validate fine — __proto__ is ignored since it's not a checked field
    expect(result.valid).toBe(true);
  });

  it('handles constructor pollution attempt in manifest', () => {
    const result = validateManifest({
      name: 'legit-skill',
      version: '1.0.0',
      constructor: { prototype: { isAdmin: true } },
    });
    // Extra keys are ignored by validation
    expect(result.valid).toBe(true);
  });
});

describe('Security: Filesystem manifest loading', () => {
  it('throws for non-existent directory', () => {
    expect(() => loadManifest('/tmp/nonexistent-skill-dir-99999')).toThrow('Manifest not found');
  });

  it('throws for invalid JSON in manifest file', () => {
    const tmpDir = fs.mkdtempSync('/tmp/skill-test-');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{invalid json!!!}');
    try {
      expect(() => loadManifest(tmpDir)).toThrow('Invalid JSON');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('throws for valid JSON but invalid manifest structure', () => {
    const tmpDir = fs.mkdtempSync('/tmp/skill-test-');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({ foo: 'bar' }));
    try {
      expect(() => loadManifest(tmpDir)).toThrow('Invalid manifest');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('loads a valid manifest from disk', () => {
    const tmpDir = fs.mkdtempSync('/tmp/skill-test-');
    const manifest = { name: 'disk-skill', version: '2.0.0', description: 'From disk' };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    try {
      const loaded = loadManifest(tmpDir);
      expect(loaded.name).toBe('disk-skill');
      expect(loaded.version).toBe('2.0.0');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. MISSING & CIRCULAR DEPENDENCIES — safe resolution
// ═══════════════════════════════════════════════════════════════════

describe('Security: Dependency resolution safety', () => {
  it('detects missing dependencies', () => {
    const nodes: DependencyNode[] = [
      { name: 'skill-a', dependencies: ['skill-missing'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.missing).toContain('skill-missing');
    expect(result.order).toEqual([]);
  });

  it('detects multiple missing dependencies', () => {
    const nodes: DependencyNode[] = [
      { name: 'skill-a', dependencies: ['missing-1', 'missing-2'] },
      { name: 'skill-b', dependencies: ['missing-3'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.missing).toContain('missing-1');
    expect(result.missing).toContain('missing-2');
    expect(result.missing).toContain('missing-3');
  });

  it('detects circular dependencies (A → B → A)', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['a'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.circular.length).toBeGreaterThan(0);
    expect(result.circular[0]).toContain('a');
    expect(result.circular[0]).toContain('b');
  });

  it('detects 3-node circular dependency (A → B → C → A)', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['c'] },
      { name: 'c', dependencies: ['a'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.circular.length).toBeGreaterThan(0);
  });

  it('resolves valid dependency chain in correct order', () => {
    const nodes: DependencyNode[] = [
      { name: 'base', dependencies: [] },
      { name: 'mid', dependencies: ['base'] },
      { name: 'top', dependencies: ['mid'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toEqual(['base', 'mid', 'top']);
    expect(result.missing).toEqual([]);
    expect(result.circular).toEqual([]);
  });

  it('handles already-installed dependencies (in available set)', () => {
    const nodes: DependencyNode[] = [
      { name: 'new-skill', dependencies: ['pre-installed'] },
    ];
    const available = new Set(['pre-installed']);
    const result = resolveDependencies(nodes, available);
    expect(result.resolved).toBe(true);
    expect(result.order).toEqual(['new-skill']);
  });

  it('handles empty dependency list', () => {
    const nodes: DependencyNode[] = [
      { name: 'standalone', dependencies: [] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toEqual(['standalone']);
  });

  it('handles empty node list', () => {
    const result = resolveDependencies([], new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toEqual([]);
  });

  it('deduplicates missing dependencies', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['shared-missing'] },
      { name: 'b', dependencies: ['shared-missing'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    // 'shared-missing' should appear only once
    const count = result.missing.filter(m => m === 'shared-missing').length;
    expect(count).toBe(1);
  });

  it('self-dependency is detected as circular', () => {
    const nodes: DependencyNode[] = [
      { name: 'self-ref', dependencies: ['self-ref'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.circular.length).toBeGreaterThan(0);
  });
});
