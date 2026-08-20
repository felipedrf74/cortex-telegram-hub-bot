import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertOwnerExpectedBootstrapTarget,
  createReleaseBootstrapBaseline,
  assertReleaseBootstrapQuiescent,
  resolveReleaseBootstrapBaselineOutputPolicy,
  verifyReleaseBootstrapBaseline,
  verifyReleaseBootstrapProductionBaseline,
  writeReleaseBootstrapBaseline,
} from '../../scripts/lib/release-bootstrap.mjs';
import { buildMigrationInventory } from '../../scripts/lib/migration-cd-eligibility.mjs';
import { loadProductionMigrationLineagePolicy } from '../../scripts/lib/production-migration-lineage.mjs';
const repositoryRoot = process.cwd();

function releaseMigrationPolicy() {
  return loadProductionMigrationLineagePolicy({ root: repositoryRoot });
}

function inventory() {
  const lineage = releaseMigrationPolicy();
  return buildMigrationInventory({
    readDir: (directory: string) => readdirSync(join(repositoryRoot, directory)),
    readFile: (file: string) => readFileSync(join(repositoryRoot, file)),
    compatibilityExemptions: lineage.release.compatibilityExemptions,
  });
}

function createLegacyDatabase(
  file: string,
  files: string[],
  legacyFiles: string[],
  environment: 'production' | 'staging',
) {
  mkdirSync(dirname(file), { recursive: true });
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE baseline_marker (value TEXT NOT NULL);
    CREATE TABLE plan_configs (
      plan_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE content_ref_channels (user_id INTEGER, channel_url TEXT);
    CREATE UNIQUE INDEX idx_content_ref_channels_user_url
      ON content_ref_channels(user_id, channel_url);
    CREATE TABLE invoice_vendors (user_id INTEGER, sender_pattern TEXT);
    CREATE UNIQUE INDEX idx_invoice_vendors_user_sender
      ON invoice_vendors(user_id, sender_pattern);
    CREATE TABLE video_transcripts (user_id INTEGER, video_id TEXT);
    CREATE UNIQUE INDEX idx_video_transcripts_user_video
      ON video_transcripts(user_id, video_id);
    CREATE TABLE content_idea_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      topic_hash TEXT NOT NULL,
      hook_hash TEXT NOT NULL,
      topic TEXT NOT NULL,
      hook TEXT,
      angle TEXT,
      format TEXT,
      source_package_id TEXT,
      accepted INTEGER NOT NULL DEFAULT 0,
      used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(tenant_id, user_id, topic_hash, hook_hash)
    );
    CREATE INDEX idx_content_idea_memory_recent
      ON content_idea_memory(tenant_id, user_id, used_at DESC);
    CREATE TABLE google_auth_pending_sessions (
      nonce TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      device_name TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_google_auth_pending_sessions_created_at
      ON google_auth_pending_sessions(created_at_ms);
  `);
  if (environment === 'production') {
    database.exec(`
      CREATE UNIQUE INDEX idx_ref_channels_url ON content_ref_channels(channel_url);
      CREATE UNIQUE INDEX idx_vendor_sender ON invoice_vendors(sender_pattern);
      CREATE UNIQUE INDEX idx_transcript_video ON video_transcripts(video_id);
      ALTER TABLE content_idea_memory ADD COLUMN variant_kind TEXT;
      ALTER TABLE content_idea_memory ADD COLUMN feedback_sentiment TEXT NOT NULL DEFAULT 'generated';
      ALTER TABLE content_idea_memory ADD COLUMN feedback_notes TEXT;
      ALTER TABLE google_auth_pending_sessions ADD COLUMN invite_code TEXT;
    `);
  } else {
    database.exec(`
      CREATE TABLE ai_provider_attempt_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        request_source TEXT NOT NULL,
        base_category TEXT NOT NULL,
        job_name TEXT,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_category TEXT NOT NULL,
        reserved_cost_usd REAL NOT NULL CHECK (reserved_cost_usd >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX idx_ai_provider_attempt_reservations_run
        ON ai_provider_attempt_reservations(request_source, base_category, run_id, user_id);
      CREATE INDEX idx_ai_provider_attempt_reservations_job
        ON ai_provider_attempt_reservations(request_source, base_category, run_id, job_name, user_id);
      CREATE TABLE staging_fixture_calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        title TEXT NOT NULL
      );
      CREATE INDEX idx_staging_fixture_calendar_user_time
        ON staging_fixture_calendar_events(user_id, start_at, end_at);
      INSERT INTO staging_fixture_calendar_events(user_id, start_at, end_at, title)
      VALUES (1, '2026-08-10T10:00:00Z', '2026-08-10T11:00:00Z', 'preserve me');
    `);
  }
  const insert = database.prepare('INSERT INTO _migrations (filename) VALUES (?)');
  const transaction = database.transaction(() => {
    for (const migration of files) insert.run(migration);
    for (const migration of legacyFiles) insert.run(migration);
  });
  transaction();
  database.prepare('INSERT INTO baseline_marker (value) VALUES (?)').run(environment);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
}

async function copyDatabase(source: string, destination: string) {
  mkdirSync(dirname(destination), { recursive: true });
  // Open read/write like the runbook's sqlite3 `.backup` command. A read-only
  // connection to a WAL-mode source can leave zero-byte -wal and live -shm
  // sidecars behind even after close, which correctly fails the quiescence
  // boundary but does not model the owner procedure.
  const database = new Database(source, { fileMustExist: true });
  await database.backup(destination);
  database.close();
}

const TARGET = {
  releaseId: '1'.repeat(32),
  sourceSha: 'c'.repeat(40),
  releasePayloadDigest: `sha256:${'d'.repeat(64)}`,
  manifestDigest: 'e'.repeat(64),
};

describe('first-container bootstrap baseline', () => {
  let workspace: string;
  let policy: any;
  let migrationInventory: ReturnType<typeof inventory>;
  let reconciliation: any;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'release-bootstrap-'));
    migrationInventory = inventory();
    reconciliation = releaseMigrationPolicy().releaseReconciliation;
    policy = {
      paths: { bootstrapBaselineFile: join(workspace, 'state', 'bootstrap-baseline.json') },
      bootstrap: {
        legacyProductionDatabase: join(workspace, 'legacy-production', 'bot.db'),
        legacyStagingDatabase: join(workspace, 'legacy-staging', 'bot.db'),
        maxBaselineAgeSeconds: 86_400,
        maxDatabaseBytes: 1024 * 1024 * 1024,
      },
      environments: {
        production: { dataDir: join(workspace, 'production') },
        staging: { dataDir: join(workspace, 'staging') },
      },
    };
    // The captured legacy databases predate the governed convergence
    // migration. New additive suffixes must remain pending after 283 rather
    // than making the fixture falsely claim 283 was already applied.
    const convergenceIndex = migrationInventory.findIndex(
      (entry) => entry.file === '283_release_schema_convergence.sql',
    );
    if (convergenceIndex < 0) throw new Error('release convergence migration missing from inventory');
    const files = migrationInventory.slice(0, convergenceIndex).map((entry) => entry.file);
    createLegacyDatabase(
      policy.bootstrap.legacyProductionDatabase,
      files,
      reconciliation.environments.production.legacyRows.map((entry: any) => entry.file),
      'production',
    );
    createLegacyDatabase(
      policy.bootstrap.legacyStagingDatabase,
      files,
      reconciliation.environments.staging.legacyRows.map((entry: any) => entry.file),
      'staging',
    );
    await copyDatabase(
      policy.bootstrap.legacyProductionDatabase,
      join(policy.environments.production.dataDir, 'bot.db'),
    );
    await copyDatabase(
      policy.bootstrap.legacyStagingDatabase,
      join(policy.environments.staging.dataDir, 'bot.db'),
    );
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  function createBaseline(now = () => Date.parse('2026-08-09T10:00:00.000Z')) {
    return createReleaseBootstrapBaseline({
      policy,
      root: repositoryRoot,
      manifestPayload: {
        source: { sha: TARGET.sourceSha },
        migrations: { inventory: migrationInventory, reconciliation },
      },
      productionSourceSha: 'a'.repeat(40),
      stagingSourceSha: 'b'.repeat(40),
      target: TARGET,
      now,
      quiescenceProbe: () => {},
    });
  }

  function verifyBaseline(now = () => Date.parse('2026-08-09T10:00:01.000Z')) {
    return verifyReleaseBootstrapBaseline({
      policy,
      root: repositoryRoot,
      manifestPayload: {
        source: { sha: TARGET.sourceSha },
        migrations: { inventory: migrationInventory, reconciliation },
      },
      releaseId: TARGET.releaseId,
      releasePayloadDigest: TARGET.releasePayloadDigest,
      manifestDigest: TARGET.manifestDigest,
      now,
      quiescenceProbe: () => {},
    });
  }

  async function mutateLegacyAndRefresh(
    environment: 'production' | 'staging',
    sql: string,
  ) {
    const legacy = environment === 'production'
      ? policy.bootstrap.legacyProductionDatabase
      : policy.bootstrap.legacyStagingDatabase;
    const governed = join(policy.environments[environment].dataDir, 'bot.db');
    const database = new Database(legacy);
    database.exec(sql);
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();
    rmSync(governed, { force: true });
    await copyDatabase(legacy, governed);
  }

  async function addSemanticDrift(productionSql: string, stagingSql: string) {
    await mutateLegacyAndRefresh('production', productionSql);
    await mutateLegacyAndRefresh('staging', stagingSql);
  }

  it('binds a fresh owner baseline to both exact databases and the signed inventory', () => {
    const baseline = createBaseline();
    const output = writeReleaseBootstrapBaseline({ policy, baseline });
    chmodSync(output, 0o600);

    expect(verifyBaseline()).toMatchObject({
      passed: true,
      baseline: { target: TARGET },
      baselineDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(baseline.databases.production.schemaDigest)
      .not.toBe(baseline.databases.staging.schemaDigest);
    expect(baseline.schemaProof.production.postMigrationSchemaDigest)
      .toBe(baseline.schemaProof.staging.postMigrationSchemaDigest);
    expect(baseline.schemaProof.schema)
      .toBe('nexus.release-bootstrap-semantic-schema-proof.v2');
    expect(baseline.schemaProof.staging.preservedFixture).toMatchObject({
      tableName: 'staging_fixture_calendar_events',
      rowCount: 1,
    });
    expect(baseline.databases.production.ledger.legacyRows).toHaveLength(19);
    expect(baseline.databases.staging.ledger.legacyRows).toHaveLength(23);
    expect(baseline.databases.production.ledger.pending)
      .toEqual([
        expect.objectContaining({ file: '283_release_schema_convergence.sql' }),
        expect.objectContaining({ file: '284_local_primary_inference_foundation.sql' }),
        expect.objectContaining({ file: '285_ai_credit_ledger_foundation.sql' }),
        expect.objectContaining({ file: '286_apple_notification_inbox.sql' }),
        expect.objectContaining({ file: '287_content_script_delivery_modes.sql' }),
        expect.objectContaining({ file: '288_apple_inbox_product_id.sql' }),
        expect.objectContaining({ file: '289_hybrid_runtime_hardening.sql' }),
        expect.objectContaining({ file: '290_plan_longform_script_allowance.sql' }),
        expect.objectContaining({ file: '291_ai_credit_lot_reconciliation_cursor.sql' }),
        expect.objectContaining({ file: '292_apple_reversal_transaction_index.sql' }),
        expect.objectContaining({ file: '293_commerce_storefront_kill_switches.sql' }),
      ]);
    expect(baseline.databases.production.sha256)
      .not.toBe(baseline.databases.staging.sha256);
    expect(baseline.legacyDatabases.production.snapshotDigest)
      .toBe(baseline.databases.production.snapshotDigest);
    expect(baseline.legacyDatabases.staging.snapshotDigest)
      .toBe(baseline.databases.staging.snapshotDigest);
  });

  it('accepts exact snapshots written by a different SQLite library version', () => {
    for (const environment of ['production', 'staging'] as const) {
      const target = join(policy.environments[environment].dataDir, 'bot.db');
      const bytes = readFileSync(target);
      const currentWriterVersion = bytes.readUInt32BE(96);
      const alternateWriterVersion = currentWriterVersion === 3_045_001
        ? 3_051_002
        : 3_045_001;
      bytes.writeUInt32BE(alternateWriterVersion, 96);
      writeFileSync(target, bytes);
    }

    const baseline = createBaseline();
    expect(baseline.legacyDatabases.production.sha256)
      .not.toBe(baseline.databases.production.sha256);
    expect(baseline.legacyDatabases.staging.sha256)
      .not.toBe(baseline.databases.staging.sha256);
    expect(baseline.legacyDatabases.production.snapshotDigest)
      .toBe(baseline.databases.production.snapshotDigest);
    expect(baseline.legacyDatabases.staging.snapshotDigest)
      .toBe(baseline.databases.staging.snapshotDigest);
  });

  it('still refuses application-controlled SQLite header drift', () => {
    const target = join(policy.environments.production.dataDir, 'bot.db');
    const bytes = readFileSync(target);
    bytes.writeUInt32BE(bytes.readUInt32BE(60) + 1, 60);
    writeFileSync(target, bytes);

    expect(() => createBaseline())
      .toThrow(/production target is not the exact legacy database snapshot/);
  });

  it.each([
    [
      'column order',
      'CREATE TABLE semantic_drift_probe (first TEXT, second INTEGER);',
      'CREATE TABLE semantic_drift_probe (second INTEGER, first TEXT);',
    ],
    [
      'column collation',
      'CREATE TABLE semantic_drift_probe (value TEXT COLLATE NOCASE);',
      'CREATE TABLE semantic_drift_probe (value TEXT COLLATE RTRIM);',
    ],
    [
      'generated expression',
      'CREATE TABLE semantic_drift_probe (source TEXT, derived TEXT GENERATED ALWAYS AS (lower(source)) STORED);',
      'CREATE TABLE semantic_drift_probe (source TEXT, derived TEXT GENERATED ALWAYS AS (upper(source)) STORED);',
    ],
    [
      'table constraint conflict policy',
      'CREATE TABLE semantic_drift_probe (left_value TEXT, right_value TEXT, UNIQUE(left_value, right_value) ON CONFLICT ABORT);',
      'CREATE TABLE semantic_drift_probe (left_value TEXT, right_value TEXT, UNIQUE(left_value, right_value) ON CONFLICT IGNORE);',
    ],
  ])('refuses convergent-looking schemas with divergent %s semantics', async (
    _label,
    productionSql,
    stagingSql,
  ) => {
    await addSemanticDrift(productionSql, stagingSql);
    expect(() => createBaseline()).toThrow(/post-migration semantic schemas do not converge/);
  });

  it('recreates exact tenant-safe replacements before absent obsolete-index drops', async () => {
    const drops = `
      DROP INDEX IF EXISTS idx_ref_channels_url;
      DROP INDEX IF EXISTS idx_transcript_video;
      DROP INDEX IF EXISTS idx_vendor_sender;
      DROP INDEX IF EXISTS idx_content_ref_channels_user_url;
      DROP INDEX IF EXISTS idx_video_transcripts_user_video;
      DROP INDEX IF EXISTS idx_invoice_vendors_user_sender;
    `;
    await mutateLegacyAndRefresh('production', drops);
    await mutateLegacyAndRefresh('staging', drops);
    const baseline = createBaseline();
    expect(baseline.schemaProof.production.postMigrationSchemaDigest)
      .toBe(baseline.schemaProof.staging.postMigrationSchemaDigest);
  });

  it.each([
    [
      'wrong ordered columns',
      `DROP INDEX idx_content_ref_channels_user_url;
       CREATE UNIQUE INDEX idx_content_ref_channels_user_url
         ON content_ref_channels(channel_url, user_id);`,
    ],
    [
      'non-unique replacement',
      `DROP INDEX idx_content_ref_channels_user_url;
       CREATE INDEX idx_content_ref_channels_user_url
         ON content_ref_channels(user_id, channel_url);`,
    ],
  ])('refuses a %s for a governed replacement index', async (_label, sql) => {
    await mutateLegacyAndRefresh('production', sql);
    await mutateLegacyAndRefresh('staging', sql);
    expect(() => createBaseline()).toThrow(/post-create governed index definition is unsafe/);
  });

  it('refuses a database-global obsolete name bound to an unrelated table', async () => {
    const sql = `
      DROP INDEX IF EXISTS idx_ref_channels_url;
      CREATE UNIQUE INDEX idx_ref_channels_url ON baseline_marker(value);
    `;
    await mutateLegacyAndRefresh('production', sql);
    await mutateLegacyAndRefresh('staging', sql);
    expect(() => createBaseline()).toThrow(/pre-drop governed index definition is unsafe/);
  });

  it('refuses a database changed after the owner authorized the baseline', () => {
    const baseline = createBaseline();
    writeReleaseBootstrapBaseline({ policy, baseline });
    const database = new Database(join(policy.environments.production.dataDir, 'bot.db'));
    database.prepare('INSERT INTO baseline_marker (value) VALUES (?)').run('changed');
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();

    expect(() => verifyBaseline()).toThrow(/changed after owner baseline authorization/);
  });

  it('refuses an incomplete legacy ledger instead of guessing applied bytes', () => {
    const file = join(policy.environments.staging.dataDir, 'bot.db');
    const database = new Database(file);
    database.prepare('DELETE FROM _migrations WHERE filename = ?').run(migrationInventory[0].file);
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();

    expect(() => createReleaseBootstrapBaseline({
      policy,
      root: repositoryRoot,
      manifestPayload: {
        source: { sha: TARGET.sourceSha },
        migrations: { inventory: migrationInventory, reconciliation },
      },
      productionSourceSha: 'a'.repeat(40),
      stagingSourceSha: 'b'.repeat(40),
      target: TARGET,
      quiescenceProbe: () => {},
    })).toThrow(/canonical ledger is not an ordered inventory prefix/);
  });

  it('refuses a missing environment-specific legacy row', () => {
    const file = join(policy.environments.staging.dataDir, 'bot.db');
    const missing = reconciliation.environments.staging.legacyRows.at(-1).file;
    const database = new Database(file);
    database.prepare('DELETE FROM _migrations WHERE filename = ?').run(missing);
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();

    expect(() => createBaseline()).toThrow(
      /legacy ledger does not exactly match the signed lineage.*missing:/,
    );
  });

  it('refuses live WAL bytes, stale evidence, and baseline overwrite', () => {
    const baseline = createBaseline();
    writeReleaseBootstrapBaseline({ policy, baseline });
    expect(() => writeReleaseBootstrapBaseline({ policy, baseline }))
      .toThrow(/refusing to overwrite/);
    expect(() => verifyBaseline(
      () => Date.parse('2026-08-11T10:00:00.000Z'),
    )).toThrow(/freshness window/);

    const productionFile = join(policy.environments.production.dataDir, 'bot.db');
    const writer = new Database(productionFile);
    writer.prepare('INSERT INTO baseline_marker (value) VALUES (?)').run('wal-row');
    expect(existsSync(`${productionFile}-wal`)).toBe(true);
    expect(() => createReleaseBootstrapBaseline({
      policy,
      root: repositoryRoot,
      manifestPayload: {
        source: { sha: TARGET.sourceSha },
        migrations: { inventory: migrationInventory, reconciliation },
      },
      productionSourceSha: 'a'.repeat(40),
      stagingSourceSha: 'b'.repeat(40),
      target: TARGET,
      quiescenceProbe: () => {},
    })).toThrow(/SQLite (?:wal|shm) sidecar/);
    writer.close();
  });

  it('publishes a release-id-bound candidate without changing the canonical baseline', () => {
    const baseline = createBaseline();
    const canonicalOutput = writeReleaseBootstrapBaseline({ policy, baseline });
    const canonicalBytes = readFileSync(canonicalOutput);
    const canonicalIdentity = statSync(canonicalOutput);
    const candidatePolicy = resolveReleaseBootstrapBaselineOutputPolicy({
      policy,
      expectedReleaseId: TARGET.releaseId,
      candidate: true,
    });

    expect(candidatePolicy.paths.bootstrapBaselineFile)
      .toBe(`${canonicalOutput}.next-${TARGET.releaseId}`);
    let publication: any;
    const candidateOutput = writeReleaseBootstrapBaseline({
      policy: candidatePolicy,
      baseline,
      candidateOutput: true,
      onPublication: (report: any) => { publication = report; },
    });
    expect(candidateOutput).toBe(`${canonicalOutput}.next-${TARGET.releaseId}`);
    expect(publication).toMatchObject({
      mode: 'candidate',
      disposition: 'published',
      retiredOrphanCount: 0,
    });
    expect(readFileSync(canonicalOutput)).toEqual(canonicalBytes);
    expect(statSync(canonicalOutput)).toMatchObject({
      dev: canonicalIdentity.dev,
      ino: canonicalIdentity.ino,
    });

    const candidateBytes = readFileSync(candidateOutput);
    expect(() => writeReleaseBootstrapBaseline({
      policy: candidatePolicy,
      baseline,
      candidateOutput: true,
    })).toThrow(/refusing to overwrite/);
    expect(readFileSync(candidateOutput)).toEqual(candidateBytes);
    expect(readFileSync(canonicalOutput)).toEqual(canonicalBytes);

    expect(resolveReleaseBootstrapBaselineOutputPolicy({
      policy,
      expectedReleaseId: '2'.repeat(32),
      candidate: true,
    }).paths.bootstrapBaselineFile).toBe(`${canonicalOutput}.next-${'2'.repeat(32)}`);
    expect(() => resolveReleaseBootstrapBaselineOutputPolicy({
      policy,
      expectedReleaseId: 'latest',
      candidate: true,
    })).toThrow(/owner-expected bootstrap release id is invalid/);
  });

  it('repairs the durable candidate link when interrupted before temporary unlink', () => {
    const baseline = createBaseline();
    const candidatePolicy = resolveReleaseBootstrapBaselineOutputPolicy({
      policy,
      expectedReleaseId: TARGET.releaseId,
      candidate: true,
    });
    let linkedTemporary = '';
    expect(() => writeReleaseBootstrapBaseline({
      policy: candidatePolicy,
      baseline,
      candidateOutput: true,
      afterLink: ({ output, temporary }: { output: string; temporary: string }) => {
        linkedTemporary = temporary;
        expect(statSync(output)).toMatchObject({
          dev: statSync(temporary).dev,
          ino: statSync(temporary).ino,
          nlink: 2,
        });
        throw new Error('simulated kill after link');
      },
    })).toThrow(/simulated kill after link/);

    let publication: any;
    const output = writeReleaseBootstrapBaseline({
      policy: candidatePolicy,
      baseline: createBaseline(() => Date.parse('2026-08-09T10:00:01.000Z')),
      candidateOutput: true,
      onPublication: (report: any) => { publication = report; },
    });
    expect(existsSync(linkedTemporary)).toBe(false);
    expect(statSync(output).nlink).toBe(1);
    expect(publication).toMatchObject({
      baseline: { createdAt: baseline.createdAt },
      mode: 'candidate',
      disposition: 'repaired_after_link',
      retiredOrphanCount: 0,
    });
  });

  it('retires a safe pre-link candidate orphan before publishing the retry', () => {
    const baseline = createBaseline();
    const candidatePolicy = resolveReleaseBootstrapBaselineOutputPolicy({
      policy,
      expectedReleaseId: TARGET.releaseId,
      candidate: true,
    });
    let orphan = '';
    expect(() => writeReleaseBootstrapBaseline({
      policy: candidatePolicy,
      baseline,
      candidateOutput: true,
      beforePublish: ({ temporary }: { temporary: string }) => {
        orphan = temporary;
        throw new Error('simulated kill before link');
      },
    })).toThrow(/simulated kill before link/);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(candidatePolicy.paths.bootstrapBaselineFile)).toBe(false);

    let publication: any;
    const output = writeReleaseBootstrapBaseline({
      policy: candidatePolicy,
      baseline: createBaseline(() => Date.parse('2026-08-09T10:00:01.000Z')),
      candidateOutput: true,
      onPublication: (report: any) => { publication = report; },
    });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(output)).toBe(true);
    expect(publication).toMatchObject({
      disposition: 'published',
      retiredOrphanCount: 1,
    });
  });

  it('repairs only the exact interrupted canonical link and then refuses overwrite', () => {
    const baseline = createBaseline();
    let linkedTemporary = '';
    expect(() => writeReleaseBootstrapBaseline({
      policy,
      baseline,
      afterLink: ({ output, temporary }: { output: string; temporary: string }) => {
        linkedTemporary = temporary;
        expect(statSync(output)).toMatchObject({
          dev: statSync(temporary).dev,
          ino: statSync(temporary).ino,
          nlink: 2,
        });
        throw new Error('simulated canonical kill');
      },
    })).toThrow(/simulated canonical kill/);

    const differentBaseline = structuredClone(baseline);
    differentBaseline.legacyRuntime.productionSourceSha = 'c'.repeat(40);
    expect(() => writeReleaseBootstrapBaseline({
      policy,
      baseline: differentBaseline,
    })).toThrow(/differs from this authorization/);
    expect(existsSync(linkedTemporary)).toBe(true);
    expect(statSync(policy.paths.bootstrapBaselineFile).nlink).toBe(2);

    let publication: any;
    const output = writeReleaseBootstrapBaseline({
      policy,
      baseline: createBaseline(() => Date.parse('2026-08-09T10:00:01.000Z')),
      onPublication: (report: any) => { publication = report; },
    });
    expect(existsSync(linkedTemporary)).toBe(false);
    expect(statSync(output).nlink).toBe(1);
    expect(publication).toMatchObject({
      baseline: { createdAt: baseline.createdAt },
      mode: 'canonical',
      disposition: 'repaired_after_link',
      retiredOrphanCount: 0,
    });
    expect(() => writeReleaseBootstrapBaseline({ policy, baseline }))
      .toThrow(/refusing to overwrite/);
  });

  it('binds the exact target release and rechecks legacy production at promotion', () => {
    const baseline = createBaseline();
    writeReleaseBootstrapBaseline({ policy, baseline });
    expect(() => verifyReleaseBootstrapBaseline({
      policy,
      root: repositoryRoot,
      manifestPayload: {
        source: { sha: TARGET.sourceSha },
        migrations: { inventory: migrationInventory, reconciliation },
      },
      releaseId: '2'.repeat(32),
      releasePayloadDigest: TARGET.releasePayloadDigest,
      manifestDigest: TARGET.manifestDigest,
      now: () => Date.parse('2026-08-09T10:00:01.000Z'),
      quiescenceProbe: () => {},
    })).toThrow(/different target release/);

    const legacy = new Database(policy.bootstrap.legacyProductionDatabase);
    legacy.prepare('INSERT INTO baseline_marker (value) VALUES (?)').run('late-pm2-write');
    legacy.pragma('wal_checkpoint(TRUNCATE)');
    legacy.close();
    expect(() => verifyReleaseBootstrapProductionBaseline({
      policy,
      root: repositoryRoot,
      manifestPayload: {
        source: { sha: TARGET.sourceSha },
        migrations: { inventory: migrationInventory, reconciliation },
      },
      releaseId: TARGET.releaseId,
      releasePayloadDigest: TARGET.releasePayloadDigest,
      manifestDigest: TARGET.manifestDigest,
      now: () => Date.parse('2026-08-09T10:00:01.000Z'),
      quiescenceProbe: () => {},
    })).toThrow(/changed after owner baseline authorization/);
  });

  it('requires the independently owner-expected release id and payload digest', () => {
    expect(assertOwnerExpectedBootstrapTarget({
      expectedReleaseId: TARGET.releaseId,
      expectedReleasePayloadDigest: TARGET.releasePayloadDigest,
      observedReleaseId: TARGET.releaseId,
      observedReleasePayloadDigest: TARGET.releasePayloadDigest,
    })).toEqual({
      releaseId: TARGET.releaseId,
      releasePayloadDigest: TARGET.releasePayloadDigest,
    });
    expect(() => assertOwnerExpectedBootstrapTarget({
      expectedReleaseId: '2'.repeat(32),
      expectedReleasePayloadDigest: TARGET.releasePayloadDigest,
      observedReleaseId: TARGET.releaseId,
      observedReleasePayloadDigest: TARGET.releasePayloadDigest,
    })).toThrow(/owner-expected release identity/);
    expect(() => assertOwnerExpectedBootstrapTarget({
      expectedReleaseId: TARGET.releaseId,
      expectedReleasePayloadDigest: `sha256:${'f'.repeat(64)}`,
      observedReleaseId: TARGET.releaseId,
      observedReleasePayloadDigest: TARGET.releasePayloadDigest,
    })).toThrow(/owner-expected release identity/);
    expect(() => assertOwnerExpectedBootstrapTarget({
      expectedReleaseId: 'latest',
      expectedReleasePayloadDigest: TARGET.releasePayloadDigest,
      observedReleaseId: TARGET.releaseId,
      observedReleasePayloadDigest: TARGET.releasePayloadDigest,
    })).toThrow(/owner-expected bootstrap release id is invalid/);

    const cli = readFileSync(
      join(repositoryRoot, 'scripts/release-bootstrap-baseline.mjs'),
      'utf8',
    );
    expect(cli).toContain("'--expected-release-id'");
    expect(cli).toContain("'--expected-release-payload-digest'");
    expect(cli).toContain("'--output-candidate'");
    expect(cli.indexOf('releasePayloadDigest !== expectedReleasePayloadDigest'))
      .toBeLessThan(cli.indexOf('registry.extractReleasePayload'));
    expect(cli.lastIndexOf('assertOwnerExpectedBootstrapTarget'))
      .toBeLessThan(cli.indexOf('const baseline = createReleaseBootstrapBaseline'));
  });

  it('fails closed on open handles and an occupied destination in the publication race', () => {
    expect(() => assertReleaseBootstrapQuiescent({
      policy,
      exec: (() => ({ status: 0, stdout: '4242\n', stderr: '' })) as any,
    })).toThrow(/open handles/);
    expect(() => assertReleaseBootstrapQuiescent({
      policy,
      exec: (() => ({ status: 1, stdout: '', stderr: 'lsof: permission denied\n' })) as any,
    })).toThrow(/probe could not run/);

    const baseline = createBaseline();
    expect(() => writeReleaseBootstrapBaseline({
      policy,
      baseline,
      beforePublish: ({ output }: { output: string }) => {
        writeFileSync(output, `${JSON.stringify(baseline)}\n`, { mode: 0o600, flag: 'wx' });
      },
    })).toThrow(/refusing to overwrite/);
    expect(JSON.parse(readFileSync(policy.paths.bootstrapBaselineFile, 'utf8')).target)
      .toEqual(TARGET);
  });

  it('does not pass absent SQLite sidecars to the lsof quiescence probe', () => {
    const databases = [
      policy.bootstrap.legacyProductionDatabase,
      join(policy.environments.production.dataDir, 'bot.db'),
      policy.bootstrap.legacyStagingDatabase,
      join(policy.environments.staging.dataDir, 'bot.db'),
    ];
    const calls: string[][] = [];
    const linuxLsof = ((_binary: string, args: string[]) => {
      calls.push(args);
      const missing = args.slice(2).filter((candidate) => !existsSync(candidate));
      return missing.length > 0
        ? {
            status: 1,
            stdout: '',
            stderr: missing
              .map((candidate) => `lsof: status error on ${candidate}: No such file or directory`)
              .join('\n'),
          }
        : { status: 1, stdout: '', stderr: '' };
    }) as any;

    for (const database of databases) {
      expect(existsSync(database)).toBe(true);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        expect(existsSync(`${database}${suffix}`)).toBe(false);
      }
    }

    expect(() => assertReleaseBootstrapQuiescent({ policy, exec: linuxLsof }))
      .not.toThrow();
    expect(calls).toEqual([['-t', '--', ...databases]]);
  });

  it.skipIf(!existsSync('/usr/bin/lsof') && !existsSync('/usr/sbin/lsof'))(
    'accepts the quiescent database set with the platform lsof binary',
    () => {
      const lsofBin = existsSync('/usr/bin/lsof') ? '/usr/bin/lsof' : '/usr/sbin/lsof';
      expect(() => assertReleaseBootstrapQuiescent({ policy, lsofBin })).not.toThrow();
    },
  );

  it('fails closed on a missing database and still probes an existing sidecar', () => {
    const database = policy.bootstrap.legacyProductionDatabase;
    const sidecar = `${database}-wal`;
    const calls: string[][] = [];
    const noHandles = ((_binary: string, args: string[]) => {
      calls.push(args);
      return { status: 1, stdout: '', stderr: '' };
    }) as any;

    writeFileSync(sidecar, '');
    expect(() => assertReleaseBootstrapQuiescent({ policy, exec: noHandles }))
      .toThrow(/still has a SQLite wal sidecar/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(sidecar);

    rmSync(sidecar);
    rmSync(database);
    calls.length = 0;
    expect(() => assertReleaseBootstrapQuiescent({ policy, exec: noHandles }))
      .toThrow(/database is missing before open-handle probe/);
    expect(calls).toHaveLength(0);
  });
});
