// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;
const encryptionConfig = vi.hoisted(() => ({
  scriptJobEncryptionKey: 'privacy-export-key-00000000000000000000000000000000',
  scriptJobPreviousEncryptionKeys: [] as string[],
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: () => testDb,
}));
vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: encryptionConfig,
}));
vi.mock('../../src/utils/logger', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger')),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deleteAllUserData,
  exportContentWorkspaceData,
  exportSkillInferenceData,
} from '../../src/services/user-data-export';
import {
  contentScriptJobPrunedTombstone,
  encryptContentScriptJobJson,
} from '../../src/services/content-script-job-encryption';

describe('local inference privacy export', () => {
  beforeEach(() => {
    encryptionConfig.scriptJobEncryptionKey = 'privacy-export-key-00000000000000000000000000000000';
    encryptionConfig.scriptJobPreviousEncryptionKeys = [];
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, telegram_id INTEGER
      );
      CREATE TABLE kv_store (
        key TEXT PRIMARY KEY, value TEXT
      );
      CREATE TABLE content_script_jobs (
        job_id TEXT PRIMARY KEY, tenant_id INTEGER, owner_user_id INTEGER,
        plan_id TEXT, request_json TEXT, result_json TEXT,
        lease_token TEXT, lease_expires_at TEXT, cancellation_requested_at TEXT
      );
      CREATE TABLE content_script_job_checkpoints (
        id INTEGER PRIMARY KEY,
        job_id TEXT REFERENCES content_script_jobs(job_id) ON DELETE CASCADE,
        section_index INTEGER, section_key TEXT,
        state TEXT, word_budget INTEGER, output_json TEXT, validation_json TEXT,
        route TEXT, model_digest TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE skill_inference_runs (
        run_id TEXT PRIMARY KEY, operation_id TEXT, tenant_id INTEGER, user_id INTEGER,
        plan_id TEXT, skill_id TEXT, task_type TEXT, risk_class TEXT, execution_class TEXT,
        evaluation_mode TEXT DEFAULT 'production',
        local_admission_requested INTEGER, profile_version TEXT, status TEXT,
        final_route TEXT, provider TEXT, model_id TEXT,
        model_digest TEXT, validation_status TEXT, fallback_reason TEXT, input_tokens INTEGER,
        output_tokens INTEGER, queue_wait_ms INTEGER, first_token_ms INTEGER,
        generation_tokens_per_second REAL, duration_ms INTEGER, created_at TEXT,
        started_at TEXT, completed_at TEXT
      );
      CREATE TABLE skill_inference_attempts (
        id INTEGER PRIMARY KEY,
        run_id TEXT REFERENCES skill_inference_runs(run_id) ON DELETE CASCADE,
        attempt_number INTEGER, route TEXT,
        provider TEXT, model_id TEXT, model_digest TEXT, outcome TEXT,
        failure_reason TEXT, input_tokens INTEGER, output_tokens INTEGER,
        queue_wait_ms INTEGER, first_token_ms INTEGER,
        generation_tokens_per_second REAL, duration_ms INTEGER, created_at TEXT
      );
      CREATE TABLE local_inference_safety_incidents (
        id INTEGER PRIMARY KEY, environment TEXT, incident_code TEXT, source TEXT,
        tenant_id INTEGER, user_id INTEGER, run_id TEXT, blocked INTEGER, created_at TEXT
      );
    `);
  });

  afterEach(() => testDb.close());

  it('exports decrypted tenant-owned script artifacts while withholding ciphertext and lease state', () => {
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'job-42', 42, 42, 'pro',
        encryptContentScriptJobJson({ topic: 'private topic' }, 42),
        encryptContentScriptJobJson({ script: 'private script' }, 42),
        'lease-secret', '2026-08-12T00:00:00.000Z', null,
      );
    testDb.prepare(`INSERT INTO content_script_job_checkpoints VALUES
      (1, 'job-42', 1, 'section_1', 'validated', 250, ?, '{"valid":true}',
       'local', 'sha256:model', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`)
      .run(encryptContentScriptJobJson({ text: 'checkpoint text' }, 42));
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'job-7', 7, 7, 'max',
        encryptContentScriptJobJson({ topic: 'other tenant' }, 7), null, null, null, null,
      );

    const jobs = exportContentWorkspaceData(42, 42).tables
      .find((table) => table.name === 'content_script_jobs')!.records;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_id: 'job-42',
      request: { topic: 'private topic' },
      result: { script: 'private script' },
      checkpoints: [{ output: { text: 'checkpoint text' }, validation: { valid: true } }],
    });
    expect(jobs[0]).not.toHaveProperty('request_json');
    expect(jobs[0]).not.toHaveProperty('result_json');
    expect(jobs[0]).not.toHaveProperty('lease_token');
  });

  it('exports retained job identity without trying to decrypt retention tombstones', () => {
    const tombstone = contentScriptJobPrunedTombstone(new Date('2026-08-26T12:00:00.000Z'));
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job-pruned', 42, 42, 'pro', tombstone, tombstone, null, null, null,
    );

    const job = exportContentWorkspaceData(42, 42).tables
      .find((table) => table.name === 'content_script_jobs')!.records[0];
    expect(job).toMatchObject({
      job_id: 'job-pruned',
      request: null,
      result: null,
      checkpoints: [],
      privateMaterialRetention: {
        status: 'pruned',
        prunedAt: '2026-08-26T12:00:00.000Z',
      },
    });
    expect(job).not.toHaveProperty('request_json');
    expect(job).not.toHaveProperty('result_json');
  });

  it('returns a partial archive warning for only the job whose historical key is unavailable', () => {
    const oldKey = 'privacy-export-old-key-0000000000000000000000000000000';
    const currentKey = 'privacy-export-new-key-000000000000000000000000000000';
    encryptionConfig.scriptJobEncryptionKey = oldKey;
    const oldRequest = encryptContentScriptJobJson({ topic: 'old private topic' }, 42);
    encryptionConfig.scriptJobEncryptionKey = currentKey;

    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job-old-key', 42, 42, 'pro', oldRequest, null, null, null, null,
    );
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job-current-key', 42, 42, 'pro',
      encryptContentScriptJobJson({ topic: 'current private topic' }, 42),
      null, null, null, null,
    );

    const exported = exportContentWorkspaceData(42, 42);
    const jobs = exported.tables.find((table) => table.name === 'content_script_jobs')!.records;

    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        job_id: 'job-old-key',
        request: null,
        decryptionStatus: 'partial_historical_key_unavailable',
        unavailableEncryptedFields: ['request'],
      }),
      expect.objectContaining({
        job_id: 'job-current-key',
        request: { topic: 'current private topic' },
      }),
    ]));
    expect(exported.warnings).toEqual([{
      code: 'CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE',
      table: 'content_script_jobs',
      recordId: 'job-old-key',
      unavailableFields: ['request'],
    }]);
    expect(JSON.stringify(exported)).not.toContain('old private topic');
  });

  it('still fails the archive when current-key script ciphertext is corrupt', () => {
    const envelope = JSON.parse(encryptContentScriptJobJson({ topic: 'must not disappear' }, 42)) as {
      ciphertext: string;
    };
    const replacement = envelope.ciphertext.endsWith('00') ? 'ff' : '00';
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}${replacement}`;
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job-corrupt', 42, 42, 'pro', JSON.stringify(envelope), null, null, null, null,
    );

    expect(() => exportContentWorkspaceData(42, 42)).toThrow(expect.objectContaining({
      code: 'CONTENT_SCRIPT_JOB_DECRYPTION_FAILED',
    }));
  });

  it('still fails the archive when encrypted envelope key metadata is corrupt', () => {
    const envelope = JSON.parse(encryptContentScriptJobJson({ topic: 'must remain attributable' }, 42)) as {
      keyVersion: string;
    };
    envelope.keyVersion = envelope.keyVersion === '0000000000000000'
      ? '1111111111111111'
      : '0000000000000000';
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job-corrupt-metadata', 42, 42, 'pro', JSON.stringify(envelope), null, null, null, null,
    );

    expect(() => exportContentWorkspaceData(42, 42)).toThrow(expect.objectContaining({
      code: 'CONTENT_SCRIPT_JOB_ENVELOPE_AUTHENTICATION_FAILED',
    }));
  });

  it('returns an explicit degraded archive when no script-job decryption key is configured', () => {
    const encrypted = encryptContentScriptJobJson({ topic: 'temporarily unavailable' }, 42);
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job-no-key', 42, 42, 'pro', encrypted, null, null, null, null,
    );
    encryptionConfig.scriptJobEncryptionKey = '';

    const exported = exportContentWorkspaceData(42, 42);
    expect(exported.tables.find((table) => table.name === 'content_script_jobs')?.records[0])
      .toMatchObject({
        request: null,
        decryptionStatus: 'partial_encryption_key_unavailable',
        unavailableEncryptedFields: ['request'],
      });
    expect(exported.warnings).toEqual([expect.objectContaining({
      code: 'CONTENT_SCRIPT_JOB_ENCRYPTION_KEY_UNAVAILABLE',
      recordId: 'job-no-key',
      unavailableFields: ['request'],
    })]);
  });

  it('exports only content-free inference metadata for the authenticated tenant/user pair', () => {
    testDb.prepare(`INSERT INTO skill_inference_runs VALUES
      ('run-42', 'operation-42', 42, 42, 'pro', 'content', 'script_section', 'low',
       'background', 'production', 1, 'v1', 'completed', 'local', 'ollama', 'winner', 'sha256:model',
       'valid', NULL, 100, 200, 10, 20, 5, 1000,
       '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z'),
      ('run-7', 'operation-7', 7, 7, 'max', 'content', 'script_section', 'low',
       'background', 'production', 1, 'v1', 'completed', 'local', 'ollama', 'winner', 'sha256:model',
       'valid', NULL, 100, 200, 10, 20, 5, 1000,
       '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z')`).run();
    testDb.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'run-42', 1, 'local', 'ollama', 'winner', 'sha256:model', 'success',
       NULL, 100, 200, 10, 20, 5, 1000, '2026-08-12T00:00:00.000Z')`).run();
    testDb.prepare(`INSERT INTO local_inference_safety_incidents VALUES
      (1, 'staging', 'post_delivery_fallback_attempt', 'test', 42, 42, 'run-42', 1,
       '2026-08-12T00:00:00.000Z'),
      (2, 'staging', 'tenant_isolation_escape', 'test', 7, 7, 'run-7', 1,
       '2026-08-12T00:00:00.000Z')`).run();

    const exported = exportSkillInferenceData(42, 42);
    expect(exported.runs).toEqual([expect.objectContaining({
      runId: 'run-42', planId: 'pro', tenantId: 42, skillId: 'content',
    })]);
    expect(exported.attempts).toEqual([expect.objectContaining({ runId: 'run-42', route: 'local' })]);
    expect(exported.safetyIncidents).toEqual([expect.objectContaining({
      incidentCode: 'post_delivery_fallback_attempt', tenantId: 42, userId: 42,
    })]);
    expect(JSON.stringify(exported)).not.toContain('private topic');
  });

  it('fails a skill-inference archive instead of silently omitting a failed query', () => {
    testDb.exec('DROP TABLE skill_inference_attempts');
    expect(() => exportSkillInferenceData(42, 42)).toThrow();
  });

  it('erases owned artifacts and pseudonymizes retained safety evidence', () => {
    testDb.prepare('INSERT INTO users (id, telegram_id) VALUES (?, ?), (?, ?)')
      .run(42, 42, 7, 7);
    testDb.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?)')
      .run('config:42:local-inference', 'enabled');
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'job-42', 42, 42, 'pro',
        encryptContentScriptJobJson({ topic: 'private topic' }, 42), null,
        null, null, null,
      );
    testDb.prepare(`INSERT INTO content_script_job_checkpoints VALUES
      (1, 'job-42', 1, 'section_1', 'validated', 250, ?, '{"valid":true}',
       'local', 'sha256:model', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`)
      .run(encryptContentScriptJobJson({ text: 'checkpoint text' }, 42));
    testDb.prepare(`INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'job-7', 7, 7, 'max',
        encryptContentScriptJobJson({ topic: 'other tenant' }, 7), null,
        null, null, null,
      );
    testDb.prepare(`INSERT INTO skill_inference_runs VALUES
      ('run-42', 'operation-42', 42, 42, 'pro', 'content', 'script_section', 'low',
       'background', 'production', 1, 'v1', 'completed', 'local', 'ollama', 'winner', 'sha256:model',
       'valid', NULL, 100, 200, 10, 20, 5, 1000,
       '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z'),
      ('run-7', 'operation-7', 7, 7, 'max', 'content', 'script_section', 'low',
       'background', 'production', 1, 'v1', 'completed', 'local', 'ollama', 'winner', 'sha256:model',
       'valid', NULL, 100, 200, 10, 20, 5, 1000,
       '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z')`).run();
    testDb.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'run-42', 1, 'local', 'ollama', 'winner', 'sha256:model', 'success',
       NULL, 100, 200, 10, 20, 5, 1000, '2026-08-12T00:00:00.000Z')`).run();
    testDb.prepare(`INSERT INTO local_inference_safety_incidents VALUES
      (1, 'staging', 'post_delivery_fallback_attempt', 'test', 42, 42, 'run-42', 1,
       '2026-08-12T00:00:00.000Z'),
      (2, 'staging', 'tenant_isolation_escape', 'test', 7, 7, 'run-7', 1,
       '2026-08-12T00:00:00.000Z')`).run();

    const deleted = deleteAllUserData(42);

    expect(deleted).toMatchObject({
      content_script_jobs: 1,
      content_script_job_checkpoints: 1,
      skill_inference_runs: 1,
      skill_inference_attempts: 1,
      local_inference_safety_incidents_pseudonymized: 1,
      kv_store_settings: 1,
      users: 1,
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_script_job_checkpoints').get())
      .toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM skill_inference_attempts').get())
      .toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_script_jobs').get())
      .toEqual({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM skill_inference_runs').get())
      .toEqual({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM local_inference_safety_incidents').get())
      .toEqual({ count: 2 });
    expect(testDb.prepare(`SELECT tenant_id, user_id, run_id
      FROM local_inference_safety_incidents WHERE id = 1`).get()).toEqual({
      tenant_id: null,
      user_id: null,
      run_id: 'erased-subject:1',
    });
    expect(testDb.prepare(`SELECT tenant_id, user_id, run_id
      FROM local_inference_safety_incidents WHERE id = 2`).get()).toEqual({
      tenant_id: 7,
      user_id: 7,
      run_id: 'run-7',
    });
  });
});
