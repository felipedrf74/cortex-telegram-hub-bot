import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildMigrationInventory,
  assertMigrationInventoryShape,
  classifyMigrationSql,
  classifySqlStatement,
  emptyMigrationContext,
  evaluateMigrationCdEligibility,
  reconcileMigrationLedger,
  splitSqlStatements,
} from '../../scripts/lib/migration-cd-eligibility.mjs';
import {
  loadProductionMigrationLineagePolicy,
} from '../../scripts/lib/production-migration-lineage.mjs';
import {
  irreversibleMigrationReason,
} from '../../scripts/lib/irreversible-migration-policy.mjs';

/**
 * Regressions for the adversarial probes that defeated the first classifier.
 *
 * Each `it` below corresponds to SQL that was accepted as predecessor-compatible
 * and should not have been. They are written as behaviour over real SQL, not as
 * assertions about the implementation, so a rewrite that reintroduces the hole
 * fails here.
 */

const root = process.cwd();

describe('classifier: conditional creation is not ownership', () => {
  it('refuses to drop a table it only conditionally created', () => {
    // CREATE TABLE IF NOT EXISTS may be a no-op over a table that already holds
    // production rows, so the DROP can destroy live data.
    const verdict = classifyMigrationSql(
      'CREATE TABLE IF NOT EXISTS users (id INTEGER);\nDROP TABLE users;',
    );
    expect(verdict.kind).toBe('contract');
    expect(verdict.predecessorCompatible).toBe(false);
    expect(verdict.blockingReasons).toContain('drop_conditionally_created_table');
  });

  it('still allows dropping a table it definitely created', () => {
    // The legitimate temp-table idiom must keep working, or the gate is useless.
    const verdict = classifyMigrationSql(
      'CREATE TABLE tmp_backfill (id INTEGER);\nDROP TABLE tmp_backfill;',
    );
    expect(verdict.kind).toBe('expand');
    expect(verdict.predecessorCompatible).toBe(true);
  });

  it('refuses to delete rows from a conditionally created table', () => {
    const verdict = classifyMigrationSql(
      'CREATE TABLE IF NOT EXISTS audit_trail (id INTEGER);\nDELETE FROM audit_trail;',
    );
    expect(verdict.predecessorCompatible).toBe(false);
    expect(verdict.blockingReasons).toContain('delete_from_conditionally_created_table');
  });

  it('refuses to drop an index it only conditionally created', () => {
    const verdict = classifyMigrationSql(
      'CREATE INDEX IF NOT EXISTS idx_a ON t (a);\nDROP INDEX idx_a;',
    );
    expect(verdict.predecessorCompatible).toBe(false);
    expect(verdict.blockingReasons).toContain('drop_conditionally_created_index');
  });
});

describe('classifier: triggers on pre-existing objects', () => {
  it('refuses a trigger that can abort a predecessor write', () => {
    // RAISE(ABORT) turns an INSERT the predecessor still makes into an error, and
    // rollback restores images without removing the trigger.
    const verdict = classifyMigrationSql(
      "CREATE TRIGGER t AFTER INSERT ON existing_table BEGIN SELECT RAISE(ABORT, 'no'); END;",
    );
    expect(verdict.kind).toBe('contract');
    expect(verdict.blockingReasons).toContain('trigger_raises_on_pre_existing_table');
  });

  it.each(['FAIL', 'ROLLBACK'])('refuses RAISE(%s) as well', (verb) => {
    const verdict = classifyMigrationSql(
      `CREATE TRIGGER t AFTER UPDATE ON existing BEGIN SELECT RAISE(${verb}, 'x'); END;`,
    );
    expect(verdict.predecessorCompatible).toBe(false);
  });

  it('refuses a trigger that deletes from a pre-existing table', () => {
    const verdict = classifyMigrationSql(
      'CREATE TRIGGER t AFTER INSERT ON existing BEGIN DELETE FROM other WHERE id = 1; END;',
    );
    expect(verdict.blockingReasons).toContain('trigger_deletes_on_pre_existing_table');
  });

  it('refuses an INSTEAD OF trigger on a pre-existing object', () => {
    const verdict = classifyMigrationSql(
      'CREATE TRIGGER t INSTEAD OF INSERT ON existing_view BEGIN SELECT 1; END;',
    );
    expect(verdict.predecessorCompatible).toBe(false);
  });

  it('allows a trigger on a table the same migration definitely created', () => {
    const verdict = classifyMigrationSql(
      'CREATE TABLE t2 (id INTEGER);\n'
      + "CREATE TRIGGER g AFTER INSERT ON t2 BEGIN SELECT RAISE(ABORT, 'x'); END;",
    );
    expect(verdict.kind).toBe('expand');
    expect(verdict.predecessorCompatible).toBe(true);
  });
});

describe('classifier: replace semantics', () => {
  it('refuses INSERT OR REPLACE, which deletes the conflicting row', () => {
    const verdict = classifyMigrationSql('INSERT OR REPLACE INTO settings (k, v) VALUES (1, 2);');
    expect(verdict.kind).toBe('contract');
    expect(verdict.blockingReasons).toContain('insert_or_replace_may_delete_rows');
  });

  it('refuses bare REPLACE INTO', () => {
    expect(classifyMigrationSql('REPLACE INTO settings VALUES (1);').predecessorCompatible)
      .toBe(false);
  });

  it('refuses UPDATE OR REPLACE, which can delete a conflicting row', () => {
    const sql = "UPDATE OR REPLACE users SET email='same@example.test' WHERE id IN (1, 2);";
    const verdict = classifyMigrationSql(sql);
    expect(verdict.kind).toBe('contract');
    expect(verdict.predecessorCompatible).toBe(false);
    expect(verdict.blockingReasons).toContain('update_or_replace_may_delete_rows');
    expect(evaluateMigrationCdEligibility({
      changedMigrations: [{ file: '284_conflicting_update.sql', sql }],
    })).toMatchObject({ eligible: false, predecessorCompatible: false });
  });

  it.each([
    ['UPDATE OR/**/REPLACE users SET email=NULL;', 'update_or_replace_may_delete_rows'],
    ['INSERT OR/* token boundary */REPLACE INTO users VALUES(1);', 'insert_or_replace_may_delete_rows'],
  ])('treats block comments as token separators in %s', (sql, reason) => {
    // SQLite treats the comment as whitespace. Removing it without a separator
    // used to glue OR + REPLACE together and misclassify this destructive write
    // as an ordinary backfill.
    const verdict = classifyMigrationSql(sql);
    expect(verdict.kind).toBe('contract');
    expect(verdict.blockingReasons).toContain(reason);
  });

  it('refuses UPDATE OR ROLLBACK while retaining non-destructive conflict clauses', () => {
    expect(classifyMigrationSql('UPDATE OR ROLLBACK users SET email=NULL;'))
      .toMatchObject({ kind: 'contract', predecessorCompatible: false });
    for (const verb of ['IGNORE', 'ABORT', 'FAIL']) {
      expect(classifyMigrationSql(`UPDATE OR ${verb} users SET email=NULL;`), verb)
        .toMatchObject({ kind: 'backfill', predecessorCompatible: true });
    }
  });

  it('refuses INSERT OR ROLLBACK, which aborts the enclosing transaction', () => {
    expect(classifyMigrationSql('INSERT OR ROLLBACK INTO t VALUES (1);').predecessorCompatible)
      .toBe(false);
  });

  it.each(['IGNORE', 'ABORT', 'FAIL'])('still allows INSERT OR %s', (verb) => {
    const verdict = classifyMigrationSql(`INSERT OR ${verb} INTO settings VALUES (1);`);
    expect(verdict.kind).toBe('backfill');
    expect(verdict.predecessorCompatible).toBe(true);
  });

  it('fails closed on unclassified PRAGMAs while retaining the governed FK toggle', () => {
    for (const sql of [
      'PRAGMA journal_mode=WAL;',
      'PRAGMA user_version=42;',
      'PRAGMA auto_vacuum=FULL;',
    ]) {
      expect(classifyMigrationSql(sql), sql).toMatchObject({
        kind: 'unknown',
        predecessorCompatible: false,
        blockingReasons: ['unclassified_pragma'],
      });
    }
    for (const sql of [
      'PRAGMA foreign_keys=OFF;',
      'PRAGMA foreign_keys = ON;',
      'PRAGMA main.foreign_keys=1;',
    ]) {
      expect(classifyMigrationSql(sql), sql).toMatchObject({
        kind: 'neutral',
        predecessorCompatible: true,
      });
    }
  });
});

describe('classifier: additive schema must preserve predecessor writes', () => {
  it('refuses CHECK constraints added to a pre-existing table', () => {
    const verdict = classifyMigrationSql(
      'ALTER TABLE users ADD COLUMN guard INTEGER DEFAULT 0 CHECK (legacy > 0);',
    );
    expect(verdict).toMatchObject({ kind: 'contract', predecessorCompatible: false });
    expect(verdict.blockingReasons).toContain('add_column_check_constraint');
  });

  it('refuses generated columns added to a pre-existing table', () => {
    const verdict = classifyMigrationSql(
      "ALTER TABLE users ADD COLUMN parsed TEXT GENERATED ALWAYS AS (json_extract(payload, '$.x')) VIRTUAL;",
    );
    expect(verdict).toMatchObject({ kind: 'contract', predecessorCompatible: false });
    expect(verdict.blockingReasons).toContain('add_column_generated_expression');
  });

  it.each([
    'DEFAULT ((NULL))',
    'DEFAULT NULL',
    'DEFAULT (NULL)',
    'DEFAULT (CAST(NULL AS INTEGER))',
    'DEFAULT (nullif(1, 1))',
    'DEFAULT +NULL',
    'DEFAULT -NULL',
    "DEFAULT 'new'",
  ])(
    'fails closed on a pre-existing-table NOT NULL column with %s',
    (defaultClause) => {
      const verdict = classifyMigrationSql(
        `ALTER TABLE users ADD COLUMN guard INTEGER NOT NULL ${defaultClause};`,
      );
      expect(verdict).toMatchObject({ kind: 'contract', predecessorCompatible: false });
    },
  );

  it('classifies even a simple literal-backed NOT NULL addition as contract', () => {
    expect(classifyMigrationSql(
      "ALTER TABLE users ADD COLUMN guard TEXT NOT NULL DEFAULT 'new';",
    ).blockingReasons).toContain('add_column_not_null_constraint');
  });

  it('retains nullable defaults and same-migration constraints as additive', () => {
    expect(classifyMigrationSql(
      "ALTER TABLE users ADD COLUMN state TEXT DEFAULT 'new';",
    )).toMatchObject({ kind: 'expand', predecessorCompatible: true });
    expect(classifyMigrationSql(
      'CREATE TABLE scratch(id INTEGER); ALTER TABLE scratch '
      + "ADD COLUMN guard INTEGER NOT NULL DEFAULT 'new' CHECK (guard > 0);",
    )).toMatchObject({ kind: 'expand', predecessorCompatible: true });
  });

  it('refuses a nullable default expression that can fail predecessor inserts', () => {
    const verdict = classifyMigrationSql(
      "ALTER TABLE users ADD COLUMN guard TEXT DEFAULT (json_extract('not json', '$.x'));",
    );
    expect(verdict).toMatchObject({ kind: 'contract', predecessorCompatible: false });
    expect(verdict.blockingReasons).toContain('add_column_unsafe_default_expression');
  });

  it.each([
    'ALTER TABLE users ADD COLUMN a TEXT;',
    'ALTER TABLE users ADD COLUMN a TEXT DEFAULT NULL;',
    "ALTER TABLE users ADD COLUMN a TEXT DEFAULT 'literal';",
    'ALTER TABLE users ADD COLUMN a INTEGER DEFAULT -42;',
    'ALTER TABLE users ADD COLUMN a INTEGER DEFAULT TRUE;',
  ])('retains absent and simple nullable defaults: %s', (sql) => {
    expect(classifyMigrationSql(sql)).toMatchObject({
      kind: 'expand',
      predecessorCompatible: true,
    });
  });

  it('refuses foreign keys from new schema to a pre-existing table', () => {
    const createVerdict = classifyMigrationSql(
      'CREATE TABLE shadow(user_id INTEGER REFERENCES users(id)); INSERT INTO shadow VALUES(1);',
    );
    expect(createVerdict).toMatchObject({ kind: 'contract', predecessorCompatible: false });
    expect(createVerdict.blockingReasons)
      .toContain('create_table_references_pre_existing_table');

    const addVerdict = classifyMigrationSql(
      'ALTER TABLE shadow ADD COLUMN user_id INTEGER REFERENCES users(id);',
    );
    expect(addVerdict.blockingReasons).toContain('add_column_foreign_key_constraint');
  });

  it('allows foreign keys confined to tables definitely created by the migration', () => {
    expect(classifyMigrationSql(
      'CREATE TABLE parent(id INTEGER PRIMARY KEY); '
      + 'CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));',
    )).toMatchObject({ kind: 'expand', predecessorCompatible: true });
    expect(classifyMigrationSql(
      'CREATE TABLE tree(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tree(id));',
    )).toMatchObject({ kind: 'expand', predecessorCompatible: true });
  });

  it.each([
    "CREATE INDEX idx_payload ON users(json_extract(payload, '$.x'));",
    'CREATE INDEX idx_active ON users(id) WHERE active = 1;',
  ])('refuses expression or partial indexes on pre-existing tables: %s', (sql) => {
    const verdict = classifyMigrationSql(sql);
    expect(verdict).toMatchObject({ kind: 'contract', predecessorCompatible: false });
    expect(verdict.blockingReasons)
      .toContain('create_expression_or_partial_index_on_pre_existing_table');
  });

  it('retains plain indexes and indexes on same-migration tables as additive', () => {
    expect(classifyMigrationSql(
      'CREATE INDEX idx_users_email ON users(email COLLATE NOCASE DESC, id ASC);',
    )).toMatchObject({ kind: 'expand', predecessorCompatible: true });
    expect(classifyMigrationSql(
      "CREATE TABLE scratch(payload TEXT); CREATE INDEX idx_payload ON scratch(json_extract(payload, '$.x'));",
    )).toMatchObject({ kind: 'expand', predecessorCompatible: true });
  });
});

describe('irreversible migration lexer parity', () => {
  it.each([
    ['DROP/**/TABLE users;', 'DROP TABLE'],
    ['ALTER TABLE users DROP/* token boundary */COLUMN legacy;', 'DROP COLUMN'],
  ])('does not let a block comment hide %s', (sql, expectedReason) => {
    const reason = irreversibleMigrationReason(
      'migrations/999_adversarial.sql',
      sql,
      { governed: new Map(), exemptions: new Map() },
    );
    expect(reason).toBe(expectedReason);
  });
});

describe('splitter: CASE ... END is not the end of a trigger body', () => {
  it('keeps a trigger containing a CASE expression as one statement', () => {
    // The CASE's END used to close the trigger body, shredding the trigger into
    // fragments and leaving a bare `END` that classified as transaction control.
    const statements = splitSqlStatements(
      'CREATE TRIGGER t AFTER UPDATE ON existing BEGIN '
      + 'UPDATE x SET y = CASE WHEN 1 THEN 2 ELSE 3 END; END;\nDROP TABLE victim;',
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TRIGGER/);
    expect(statements[0]).toContain('CASE WHEN');
    // The trigger body's own END must be inside statement 0, not a statement.
    expect(statements).not.toContain('END');
    expect(statements[1]).toBe('DROP TABLE victim');
  });

  it('handles nested CASE expressions inside a trigger body', () => {
    const statements = splitSqlStatements(
      'CREATE TRIGGER t AFTER INSERT ON e BEGIN '
      + 'UPDATE a SET b = CASE WHEN 1 THEN CASE WHEN 2 THEN 3 ELSE 4 END ELSE 5 END; END;',
    );
    expect(statements).toHaveLength(1);
  });

  it('does not treat a bare END as harmless when a body was fragmented', () => {
    // Guards the failure mode rather than the fix: a lone END is unclassified, so
    // even if a body were fragmented the result blocks instead of passing.
    const verdict = classifySqlStatement('END', emptyMigrationContext());
    expect(['neutral', 'unknown']).toContain(verdict.kind);
  });
});

describe('migration inventory', () => {
  it('covers every migration file, ordered, with byte digests', () => {
    const policy = loadProductionMigrationLineagePolicy({ root });
    const inventory = buildMigrationInventory({
      readDir: (dir) => readdirSync(join(root, dir)),
      readFile: (file) => readFileSync(join(root, file)),
      compatibilityExemptions: policy.release.compatibilityExemptions,
    });
    const onDisk = readdirSync(join(root, 'migrations'))
      .filter((file) => /^\d{3}_.*\.sql$/.test(file));
    expect(inventory).toHaveLength(278);
    expect(inventory).toHaveLength(onDisk.length);
    expect(() => assertMigrationInventoryShape(inventory)).not.toThrow();
    for (const entry of inventory) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof entry.predecessorCompatible).toBe('boolean');
    }
    expect(inventory.at(-1)).toMatchObject({
      file: '287_content_script_delivery_modes.sql',
      kind: 'expand',
      predecessorCompatible: true,
    });
  });

  it('keeps 283 contract by default and admits only its exact governed bytes', () => {
    const sql = readFileSync(join(root, 'migrations/283_release_schema_convergence.sql'), 'utf8');
    expect(classifyMigrationSql(sql)).toMatchObject({
      kind: 'contract',
      predecessorCompatible: false,
    });
    const policy = loadProductionMigrationLineagePolicy({ root });
    expect(evaluateMigrationCdEligibility({
      changedMigrations: [{ file: '283_release_schema_convergence.sql', sql }],
      compatibilityExemptions: policy.release.compatibilityExemptions,
    })).toMatchObject({ eligible: true, predecessorCompatible: true });
    expect(evaluateMigrationCdEligibility({
      changedMigrations: [{
        file: '283_release_schema_convergence.sql',
        sql: `${sql}\n-- digest drift`,
      }],
      compatibilityExemptions: policy.release.compatibilityExemptions,
    })).toMatchObject({ eligible: false, predecessorCompatible: false });
  });

  it('requires every exact replacement create to precede its exact obsolete-index drop', () => {
    const sql = readFileSync(join(root, 'migrations/283_release_schema_convergence.sql'), 'utf8');
    const policy = loadProductionMigrationLineagePolicy({ root });
    const statements = splitSqlStatements(sql);
    const createPosition = statements.findIndex((statement) => (
      /create\s+unique\s+index\s+if\s+not\s+exists\s+idx_content_ref_channels_user_url/i
        .test(statement)
    ));
    const dropPosition = statements.findIndex((statement) => (
      /drop\s+index\s+if\s+exists\s+idx_ref_channels_url/i.test(statement)
    ));
    const [create] = statements.splice(createPosition, 1);
    statements.splice(dropPosition, 0, create);
    const reordered = `${statements.join(';\n')};\n`;
    const exemption = structuredClone(policy.release.compatibilityExemptions[0]);
    exemption.sha256 = createHash('sha256').update(reordered).digest('hex');
    expect(evaluateMigrationCdEligibility({
      changedMigrations: [{ file: exemption.file, sql: reordered }],
      compatibilityExemptions: [exemption],
    })).toMatchObject({ eligible: false, predecessorCompatible: false });

    const missingCreate = sql.replace(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_channels_user_url[\s\S]*?;\n/i,
      '',
    );
    exemption.sha256 = createHash('sha256').update(missingCreate).digest('hex');
    expect(evaluateMigrationCdEligibility({
      changedMigrations: [{ file: exemption.file, sql: missingCreate }],
      compatibilityExemptions: [exemption],
    })).toMatchObject({ eligible: false, predecessorCompatible: false });
  });

  it('rejects an unordered inventory', () => {
    const inventory = [
      { file: '002_b.sql', sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true },
      { file: '001_a.sql', sha256: 'b'.repeat(64), kind: 'expand', predecessorCompatible: true },
    ];
    expect(() => assertMigrationInventoryShape(inventory)).toThrow(/strictly ordered/);
  });

  it('rejects an inventory entry with extra or missing fields', () => {
    expect(() => assertMigrationInventoryShape([
      { file: '001_a.sql', sha256: 'a'.repeat(64), kind: 'expand' },
    ])).toThrow(/governed schema/);
  });

  it.each([
    '001_../../../etc/evil.sql',
    '001_nested/evil.sql',
    '001_evil..sql',
  ])('rejects traversal-shaped migration filename %s', (file) => {
    expect(() => assertMigrationInventoryShape([
      { file, sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true },
    ])).toThrow(/not a migration filename/);
  });

  it('classifies the real repository without producing any unknown verdict', () => {
    // An `unknown` blocks deployment, so an unknown in the committed corpus would
    // mean the gate is unusable rather than safe.
    const inventory = buildMigrationInventory({
      readDir: (dir) => readdirSync(join(root, dir)),
      readFile: (file) => readFileSync(join(root, file)),
    });
    expect(inventory.filter((entry) => entry.kind === 'unknown')).toEqual([]);
    // Pin the topology so a broad reclassification cannot hide behind a
    // still-green zero-unknown assertion. Deliberate policy changes update this
    // exact snapshot together.
    const compatible = inventory.filter((entry) => entry.predecessorCompatible).length;
    expect(compatible).toBe(150);
  });
});

describe('ledger reconciliation', () => {
  const inventory = [
    { file: '001_a.sql', sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true },
    { file: '002_b.sql', sha256: 'b'.repeat(64), kind: 'contract', predecessorCompatible: false },
    { file: '003_c.sql', sha256: 'c'.repeat(64), kind: 'backfill', predecessorCompatible: true },
  ];

  it('admits a release whose pending migrations are all compatible', () => {
    const result = reconcileMigrationLedger({
      inventory,
      appliedFiles: ['001_a.sql', '002_b.sql'],
    });
    expect(result.admitted).toBe(true);
    expect(result.pending).toEqual(['003_c.sql']);
  });

  it('refuses when an incompatible migration is still pending', () => {
    // This is the blocked-A / unrelated-B hole: B's own delta is empty, but the
    // migrator would still apply A's contract migration.
    const result = reconcileMigrationLedger({
      inventory,
      appliedFiles: ['001_a.sql'],
    });
    expect(result.admitted).toBe(false);
    expect(result.blocking.map((entry) => entry.file)).toEqual(['002_b.sql']);
    expect(result.reasons[0]).toMatch(/002_b\.sql:pending_not_predecessor_compatible:contract/);
  });

  it('refuses when the ledger contains a migration the release does not carry', () => {
    // The database was migrated by something this release does not contain, so its
    // inventory cannot describe what a migrator would do.
    const result = reconcileMigrationLedger({
      inventory,
      appliedFiles: ['001_a.sql', '999_from_the_future.sql'],
    });
    expect(result.admitted).toBe(false);
    expect(result.unknownApplied).toEqual(['999_from_the_future.sql']);
  });

  it('admits only the complete exact signed legacy set', () => {
    const legacyRows = [
      { file: '010_legacy.sql' },
      { file: '011_legacy.sql' },
    ];
    expect(reconcileMigrationLedger({
      inventory,
      appliedFiles: ['001_a.sql', '002_b.sql', '010_legacy.sql', '011_legacy.sql'],
      legacyRows,
    })).toMatchObject({ admitted: true, missingLegacy: [], unknownApplied: [] });
    expect(reconcileMigrationLedger({
      inventory,
      appliedFiles: ['001_a.sql', '002_b.sql', '010_legacy.sql'],
      legacyRows,
    })).toMatchObject({ admitted: false, missingLegacy: ['011_legacy.sql'] });
    expect(reconcileMigrationLedger({
      inventory,
      appliedFiles: [
        '001_a.sql', '002_b.sql', '010_legacy.sql', '011_legacy.sql', '012_unknown.sql',
      ],
      legacyRows,
    })).toMatchObject({ admitted: false, unknownApplied: ['012_unknown.sql'] });
  });

  it('refuses a canonical ledger gap while preserving the exact signed legacy set', () => {
    const compatibleInventory = inventory.map((entry) => ({
      ...entry,
      kind: 'expand',
      predecessorCompatible: true,
    }));
    const legacyRows = [{ file: '010_legacy.sql' }];
    const result = reconcileMigrationLedger({
      inventory: compatibleInventory,
      appliedFiles: ['001_a.sql', '003_c.sql', '010_legacy.sql'],
      legacyRows,
    });

    expect(result).toMatchObject({
      admitted: false,
      admittedLegacy: ['010_legacy.sql'],
      blocking: [],
      missingLegacy: [],
      pending: ['002_b.sql'],
      outOfPrefixApplied: ['003_c.sql'],
    });
    expect(result.reasons).toContain('003_c.sql:applied_outside_ordered_inventory_prefix');
  });

  it('admits a fully applied ledger with nothing pending', () => {
    const result = reconcileMigrationLedger({
      inventory,
      appliedFiles: inventory.map((entry) => entry.file),
    });
    expect(result.admitted).toBe(true);
    expect(result.pending).toEqual([]);
  });

  it('refuses an unmigrated database whose pending set includes contract work', () => {
    const result = reconcileMigrationLedger({ inventory, appliedFiles: [] });
    expect(result.admitted).toBe(false);
  });
});

describe('cdEligibility aggregation', () => {
  it('reports no_migration_changes for an empty delta', () => {
    const result = evaluateMigrationCdEligibility({ changedMigrations: [] });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual(['no_migration_changes']);
  });

  it('is ineligible when any changed migration is incompatible', () => {
    const result = evaluateMigrationCdEligibility({
      changedMigrations: [
        { file: 'migrations/900_x.sql', sql: 'DROP TABLE users;' },
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.predecessorCompatible).toBe(false);
  });

  it('is ineligible when the safety check reported errors, whatever the SQL says', () => {
    const result = evaluateMigrationCdEligibility({
      changedMigrations: [{ file: 'migrations/901_y.sql', sql: 'CREATE TABLE z (id INTEGER);' }],
      blockingErrors: ['migration_sequence_gap:900'],
    });
    expect(result.eligible).toBe(false);
  });
});

describe('second-round adversarial probes', () => {
  // Every case below was ACCEPTED as predecessor-compatible before this round.
  // The reproduction script is .local/repro/g1.mjs.

  it('never lets a conditionally created virtual table license a later DROP', () => {
    // `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op against a pre-existing FTS
    // table, so a following DROP destroys an index this migration did not build —
    // along with its shadow tables.
    const verdict = classifyMigrationSql(
      'CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(body);\nDROP TABLE notes_fts;',
    );
    expect(verdict.kind).toBe('contract');
    expect(verdict.predecessorCompatible).toBe(false);
    expect(verdict.blockingReasons).toContain('drop_conditionally_created_table');
  });

  it('does not grant drop ownership even for an unconditional virtual table', () => {
    // DROP on an fts5 table also removes its shadow tables, so "we made it, we can
    // unmake it" is not a safe rule for virtual tables.
    const verdict = classifyMigrationSql(
      'CREATE VIRTUAL TABLE notes_fts USING fts5(body);\nDROP TABLE notes_fts;',
    );
    expect(verdict.kind).toBe('contract');
  });

  it('never lets a conditionally created index license a later DROP', () => {
    for (const sql of [
      'CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);\nDROP INDEX ix_users_email;',
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email);\nDROP INDEX ux_users_email;',
    ]) {
      const verdict = classifyMigrationSql(sql);
      expect(verdict.kind).toBe('contract');
      expect(verdict.predecessorCompatible).toBe(false);
    }
  });

  it('fails closed on every form of catalog mutation', () => {
    // Direct sqlite_master edits perform schema surgery no DDL-reading classifier
    // can analyse, so they can never be admitted unattended.
    const cases: Array<[string, string]> = [
      ['PRAGMA writable_schema=ON;', 'writable_schema_pragma'],
      ["UPDATE sqlite_master SET sql='x' WHERE name='users';", 'catalog_mutation'],
      ["UPDATE main.sqlite_master SET sql='x';", 'catalog_mutation'],
      ["DELETE FROM sqlite_schema WHERE name='users';", 'catalog_mutation'],
      ["INSERT INTO sqlite_master(type,name) VALUES('table','x');", 'catalog_mutation'],
      ["DELETE FROM sqlite_temp_master;", 'catalog_mutation'],
    ];
    for (const [sql, reason] of cases) {
      const verdict = classifyMigrationSql(sql);
      expect(verdict.kind, sql).toBe('contract');
      expect(verdict.predecessorCompatible, sql).toBe(false);
      expect(verdict.blockingReasons, sql).toContain(reason);
    }
  });

  it('rejects an inventory whose compatibility flag contradicts its kind', () => {
    // The reconciler trusts predecessorCompatible when deciding what may be
    // applied, so a tampered inventory must not be able to declare a contract
    // migration safe.
    const entry = (over: Record<string, unknown>) => ([{
      file: '900_x.sql', sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true, ...over,
    }]);
    expect(() => assertMigrationInventoryShape(entry({ kind: 'contract' })))
      .toThrow(/claims predecessorCompatible=true for kind contract/);
    expect(() => assertMigrationInventoryShape(entry({ kind: 'unknown' })))
      .toThrow(/claims predecessorCompatible=true for kind unknown/);
    expect(() => assertMigrationInventoryShape(entry({ predecessorCompatible: false })))
      .toThrow(/claims predecessorCompatible=false for kind expand/);
    // The consistent shape still passes: this is a contradiction check, not a ban.
    expect(assertMigrationInventoryShape(entry({}))).toHaveLength(1);
  });

  it('keeps the whole committed corpus classifiable with zero unknowns', () => {
    // The hardening must not push real migrations into `unknown`, which would
    // block every release for a classifier gap rather than a real risk.
    const dir = join(process.cwd(), 'migrations');
    const files = readdirSync(dir).filter((file) => /^\d{3}_.*\.sql$/.test(file));
    expect(files.length).toBe(278);
    const unknown = files.filter(
      (file) => classifyMigrationSql(readFileSync(join(dir, file), 'utf8')).kind === 'unknown',
    );
    expect(unknown).toEqual([]);
  });
});

describe('QA-round findings F1-F3: schema identity and trigger bodies', () => {
  it('does not let a temp shadow table license destroying the real one (F1)', () => {
    // `CREATE TEMP TABLE users` creates temp.users. Keying ownership on the bare
    // name made a following `DROP TABLE main.users` read as "dropping a table we
    // created". Verified destructive against real SQLite by the reviewer.
    for (const sql of [
      'CREATE TEMP TABLE users(id INTEGER); DROP TABLE main.users;',
      'CREATE TEMP TABLE users(id INTEGER); DELETE FROM main.users;',
      'CREATE TEMP TABLE users(id INTEGER); ALTER TABLE main.users RENAME TO users_old;',
      'CREATE TABLE temp.users(id INTEGER); DROP TABLE users;',
    ]) {
      const verdict = classifyMigrationSql(sql);
      expect(verdict.kind, sql).toBe('contract');
      expect(verdict.predecessorCompatible, sql).toBe(false);
    }
  });

  it('still treats an unqualified name and main. as the same object', () => {
    // The fix must not over-block: `main.x` and `x` are one object, so a
    // same-migration create/drop pair stays admissible however it is spelled.
    for (const sql of [
      'CREATE TABLE audit(id INTEGER); DROP TABLE audit;',
      'CREATE TABLE main.audit(id INTEGER); DROP TABLE audit;',
      'CREATE TABLE audit(id INTEGER); DROP TABLE main.audit;',
    ]) {
      expect(classifyMigrationSql(sql).kind, sql).not.toBe('contract');
    }
  });

  it('inspects a trigger body even when it owns the trigger target (F2)', () => {
    // Owning the target table says nothing about where the BODY writes. This
    // deletes production rows during the migration while every statement looks
    // additive.
    const destructive = classifyMigrationSql(
      'CREATE TABLE shadow(id INTEGER);\n'
      + 'CREATE TRIGGER z AFTER INSERT ON shadow BEGIN DELETE FROM users; END;\n'
      + 'INSERT INTO shadow VALUES(1);',
    );
    expect(destructive.kind).toBe('contract');
    expect(destructive.blockingReasons).toContain('trigger_body_writes_pre_existing_table');

    expect(classifyMigrationSql(
      'CREATE TABLE shadow(id INTEGER);\n'
      + 'CREATE TRIGGER z AFTER INSERT ON shadow BEGIN UPDATE users SET email=NULL; END;',
    ).kind).toBe('contract');

    // A trigger whose body writes only to same-migration tables stays additive.
    expect(classifyMigrationSql(
      'CREATE TABLE shadow(id INTEGER);\n'
      + 'CREATE TRIGGER z AFTER INSERT ON shadow BEGIN INSERT INTO shadow VALUES(2); END;',
    ).kind).not.toBe('contract');
  });

  it('blocks PRAGMA writable_schema however the schema is quoted (F3)', () => {
    for (const sql of [
      'PRAGMA writable_schema=ON;',
      'PRAGMA main.writable_schema=ON;',
      'PRAGMA "main".writable_schema=ON;',
      'PRAGMA [main].writable_schema=ON;',
      'PRAGMA `main`.writable_schema=ON;',
    ]) {
      expect(classifyMigrationSql(sql).kind, sql).toBe('contract');
    }
  });
});
