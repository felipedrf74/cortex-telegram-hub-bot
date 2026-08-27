// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drainExpiredContentScriptJobPrivateMaterial,
  drainExpiredLocalInferenceSafetyIncidents,
  drainExpiredSecurityAdminAuditTrail,
  drainExpiredSkillInferenceTelemetry,
  pruneExpiredContentScriptJobPrivateMaterial,
  pruneExpiredLocalInferenceSafetyIncidents,
  pruneExpiredSecurityAdminAuditTrail,
  pruneExpiredSkillInferenceTelemetry,
} from '../../src/services/private-data-retention';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE content_script_jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      warning_codes_json TEXT NOT NULL DEFAULT '[]',
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE content_script_job_checkpoints (
      id INTEGER PRIMARY KEY,
      job_id TEXT NOT NULL
    );
    CREATE TABLE content_script_provider_batches (
      job_id TEXT NOT NULL,
      provider_batch_id TEXT,
      input_file_id TEXT,
      output_file_id TEXT,
      error_file_id TEXT,
      input_file_intent_filename TEXT,
      batch_create_intent_at TEXT,
      provider_files_deleted_at TEXT
    );
    CREATE TABLE skill_inference_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE skill_inference_attempts (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL
    );
    CREATE TABLE audit_trail (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      resource TEXT NOT NULL DEFAULT 'auth.test',
      ts TEXT NOT NULL
    );
    CREATE TABLE local_inference_safety_incidents (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertScriptJob(
  db: Database.Database,
  jobId: string,
  status: string,
  timestamp: string,
): void {
  const encrypted = JSON.stringify({
    schema: 'nexus.content-script-job-encrypted.v3',
    keyVersion: 'test',
    ciphertext: '00',
  });
  db.prepare(`INSERT INTO content_script_jobs (
      job_id, status, request_json, result_json, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(jobId, status, encrypted, encrypted, status === 'completed' ? timestamp : null, timestamp);
  db.prepare(`INSERT INTO content_script_job_checkpoints (job_id) VALUES (?)`).run(jobId);
}

function insertInferenceRun(
  db: Database.Database,
  runId: string,
  status: string,
  timestamp: string,
): void {
  db.prepare(`INSERT INTO skill_inference_runs (
      run_id, status, created_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`)
    .run(runId, status, timestamp, status === 'completed' ? timestamp : null, timestamp);
  db.prepare(`INSERT INTO skill_inference_attempts (run_id) VALUES (?)`).run(runId);
}

describe('private data retention', () => {
  const databases: Database.Database[] = [];
  const openDatabase = (): Database.Database => {
    const db = database();
    databases.push(db);
    return db;
  };

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('atomically tombstones expired private script material while retaining content-free identity', () => {
    const db = openDatabase();
    insertScriptJob(db, 'expired-complete', 'completed', '2026-07-26T11:59:59.000Z');
    insertScriptJob(db, 'expired-failed', 'failed', '2026-07-01T00:00:00.000Z');
    insertScriptJob(db, 'boundary', 'completed', '2026-07-27T12:00:00.000Z');
    insertScriptJob(db, 'active-old', 'running', '2026-01-01T00:00:00.000Z');
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, provider_batch_id, input_file_id, provider_files_deleted_at
    ) VALUES ('expired-complete', 'batch-deleted', 'file-deleted', '2026-07-27T00:00:00.000Z')`).run();

    expect(pruneExpiredContentScriptJobPrivateMaterial(db, { now: NOW })).toEqual({
      jobsPruned: 2,
      checkpoints: 2,
    });
    expect(db.prepare('SELECT job_id FROM content_script_jobs ORDER BY job_id').all()).toEqual([
      { job_id: 'active-old' },
      { job_id: 'boundary' },
      { job_id: 'expired-complete' },
      { job_id: 'expired-failed' },
    ]);
    expect(db.prepare('SELECT job_id FROM content_script_job_checkpoints ORDER BY job_id').all()).toEqual([
      { job_id: 'active-old' },
      { job_id: 'boundary' },
    ]);
    expect(db.prepare(`SELECT job_id,
        json_extract(request_json, '$.schema') AS request_schema,
        json_extract(result_json, '$.schema') AS result_schema,
        json_extract(warning_codes_json, '$[0]') AS warning
      FROM content_script_jobs WHERE job_id LIKE 'expired-%' ORDER BY job_id`).all()).toEqual([
      {
        job_id: 'expired-complete',
        request_schema: 'nexus.content-script-job-pruned.v1',
        result_schema: 'nexus.content-script-job-pruned.v1',
        warning: 'content_script_private_material_expired',
      },
      {
        job_id: 'expired-failed',
        request_schema: 'nexus.content-script-job-pruned.v1',
        result_schema: 'nexus.content-script-job-pruned.v1',
        warning: 'content_script_private_material_expired',
      },
    ]);
    expect(db.prepare('SELECT job_id FROM content_script_provider_batches').all()).toEqual([
      { job_id: 'expired-complete' },
    ]);
    expect(pruneExpiredContentScriptJobPrivateMaterial(db, { now: NOW })).toEqual({
      jobsPruned: 0,
      checkpoints: 0,
    });
  });

  it('retains an expired script job until provider-file deletion is proven', () => {
    const db = openDatabase();
    insertScriptJob(db, 'provider-files-pending', 'cancelled', '2026-06-01T00:00:00.000Z');
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, provider_batch_id, input_file_id, provider_files_deleted_at
    ) VALUES ('provider-files-pending', 'batch-pending', 'file-pending', NULL)`).run();

    expect(pruneExpiredContentScriptJobPrivateMaterial(db, { now: NOW })).toEqual({
      jobsPruned: 0,
      checkpoints: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_script_jobs').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_script_provider_batches').get()).toEqual({ count: 1 });
  });

  it('retains expired private material while a provider intent lacks absence proof', () => {
    const db = openDatabase();
    insertScriptJob(db, 'provider-intent-pending', 'failed', '2026-06-01T00:00:00.000Z');
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, input_file_intent_filename, provider_files_deleted_at
    ) VALUES ('provider-intent-pending', 'content-free-stage.jsonl', NULL)`).run();

    expect(pruneExpiredContentScriptJobPrivateMaterial(db, { now: NOW })).toEqual({
      jobsPruned: 0,
      checkpoints: 0,
    });
  });

  it('rolls checkpoint deletion back if the parent tombstone update fails', () => {
    const db = openDatabase();
    insertScriptJob(db, 'blocked-parent', 'failed', '2026-06-01T00:00:00.000Z');
    db.exec(`CREATE TRIGGER block_script_parent_update
      BEFORE UPDATE ON content_script_jobs
      BEGIN SELECT RAISE(ABORT, 'blocked parent update'); END;`);

    expect(() => pruneExpiredContentScriptJobPrivateMaterial(db, { now: NOW }))
      .toThrow('blocked parent update');
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_script_jobs').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_script_job_checkpoints').get()).toEqual({ count: 1 });
  });

  it('removes expired terminal inference attempts with their parent runs but preserves active and boundary rows', () => {
    const db = openDatabase();
    insertInferenceRun(db, 'expired', 'completed', '2026-05-27T11:59:59.000Z');
    insertInferenceRun(db, 'boundary', 'failed', '2026-05-28T12:00:00.000Z');
    insertInferenceRun(db, 'active-old', 'running', '2026-01-01T00:00:00.000Z');

    expect(pruneExpiredSkillInferenceTelemetry(db, { now: NOW })).toEqual({ runs: 1, attempts: 1 });
    expect(db.prepare('SELECT run_id FROM skill_inference_runs ORDER BY run_id').all()).toEqual([
      { run_id: 'active-old' },
      { run_id: 'boundary' },
    ]);
    expect(db.prepare('SELECT run_id FROM skill_inference_attempts ORDER BY run_id').all()).toEqual([
      { run_id: 'active-old' },
      { run_id: 'boundary' },
    ]);
  });

  it('prunes only classified security/admin audit records after 12 calendar months', () => {
    const db = openDatabase();
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)').run(1, 'delete', '2025-08-26T11:59:59.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)').run(2, 'decrypt', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)').run(3, 'login', '2025-08-26T12:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)').run(4, 'fiscal_bundle_send', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)').run(5, 'future_unclassified_action', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)').run(6, 'admin_mutation', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, resource, ts) VALUES (?, ?, ?, ?)')
      .run(7, 'create', 'billing.apple_verify.subscription', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, resource, ts) VALUES (?, ?, ?, ?)')
      .run(8, 'delete', 'finance.transaction', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, resource, ts) VALUES (?, ?, ?, ?)')
      .run(9, 'privacy_consent', 'privacy.consent', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, resource, ts) VALUES (?, ?, ?, ?)')
      .run(10, 'export', 'account', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, resource, ts) VALUES (?, ?, ?, ?)')
      .run(11, 'delete', 'account', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, resource, ts) VALUES (?, ?, ?, ?)')
      .run(12, 'export', 'ordinary.security.export', '2024-01-01T00:00:00.000Z');

    // Personal finance-tracker audit is not statutory billing evidence and
    // remains inside the governed 12-calendar-month privacy boundary.
    expect(pruneExpiredSecurityAdminAuditTrail(db, { now: NOW })).toBe(5);
    expect(db.prepare('SELECT id FROM audit_trail ORDER BY id').all()).toEqual([
      { id: 3 }, { id: 4 }, { id: 5 }, { id: 7 },
      { id: 9 }, { id: 10 }, { id: 11 },
    ]);
  });

  it('uses a 12-calendar-month audit boundary across a leap-year interval', () => {
    const db = openDatabase();
    const leapIntervalNow = new Date('2024-08-26T12:00:00.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)')
      .run(1, 'access', '2023-08-26T11:59:59.000Z');
    db.prepare('INSERT INTO audit_trail (id, action, ts) VALUES (?, ?, ?)')
      .run(2, 'access', '2023-08-26T12:00:00.000Z');

    expect(pruneExpiredSecurityAdminAuditTrail(db, { now: leapIntervalNow })).toBe(1);
    expect(db.prepare('SELECT id FROM audit_trail ORDER BY id').all()).toEqual([{ id: 2 }]);
  });

  it('drains local retention in bounded pages and reports any remaining backlog', () => {
    const db = openDatabase();
    for (let index = 0; index < 5; index += 1) {
      insertScriptJob(db, `script-${index}`, 'failed', '2026-06-01T00:00:00.000Z');
      insertInferenceRun(db, `run-${index}`, 'failed', '2026-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO audit_trail (action, ts) VALUES (?, ?)')
        .run('access', '2024-01-01T00:00:00.000Z');
    }

    expect(drainExpiredContentScriptJobPrivateMaterial(db, {
      now: NOW, limit: 2, maxPages: 2,
    })).toMatchObject({
      pruned: { jobsPruned: 4, checkpoints: 4 }, pages: 2,
      backlog: { eligible: 1, oldestEligibleAt: '2026-06-01T00:00:00.000Z' },
    });
    expect(drainExpiredSkillInferenceTelemetry(db, {
      now: NOW, limit: 2, maxPages: 3,
    })).toMatchObject({
      pruned: { runs: 5, attempts: 5 }, pages: 3,
      backlog: { eligible: 0, oldestEligibleAt: null },
    });
    expect(drainExpiredSecurityAdminAuditTrail(db, {
      now: NOW, limit: 2, maxPages: 3,
    })).toMatchObject({
      pruned: { deleted: 5 }, pages: 3,
      backlog: { eligible: 0, oldestEligibleAt: null },
    });
  });

  it('normalizes mixed SQLite and ISO timestamps in local retention backlog', () => {
    const db = openDatabase();
    insertScriptJob(db, 'mixed-iso-oldest', 'failed', '2025-01-02T00:00:00.000Z');
    insertScriptJob(db, 'mixed-sqlite-later', 'failed', '2025-01-02 23:00:00');
    insertScriptJob(db, 'mixed-next-day', 'failed', '2025-01-03T00:00:00.000Z');

    expect(drainExpiredContentScriptJobPrivateMaterial(db, {
      now: NOW, limit: 1, maxPages: 1,
    })).toMatchObject({
      pruned: { jobsPruned: 1, checkpoints: 1 },
      backlog: {
        eligible: 2,
        oldestEligibleAt: '2025-01-02T23:00:00.000Z',
      },
    });
  });

  it('prunes local inference safety incidents after 365 days but preserves the boundary', () => {
    const db = openDatabase();
    db.prepare('INSERT INTO local_inference_safety_incidents (id, created_at) VALUES (?, ?)')
      .run(1, '2025-08-26T11:59:59.000Z');
    db.prepare('INSERT INTO local_inference_safety_incidents (id, created_at) VALUES (?, ?)')
      .run(2, '2025-08-26T12:00:00.000Z');
    db.prepare('INSERT INTO local_inference_safety_incidents (id, created_at) VALUES (?, ?)')
      .run(3, '2024-01-01T00:00:00.000Z');

    expect(pruneExpiredLocalInferenceSafetyIncidents(db, { now: NOW, limit: 1 })).toBe(1);
    expect(drainExpiredLocalInferenceSafetyIncidents(db, { now: NOW, limit: 1 })).toMatchObject({
      pruned: { deleted: 1 },
      backlog: { eligible: 0, oldestEligibleAt: null },
    });
    expect(db.prepare('SELECT id FROM local_inference_safety_incidents').all()).toEqual([{ id: 2 }]);
  });
});
