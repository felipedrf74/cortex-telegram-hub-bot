// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

const { runtimeConfigMock, localPrimaryConfigMock } = vi.hoisted(() => ({
  runtimeConfigMock: {
    isStaging: true,
    ollama: {
      enabled: true,
    },
  },
  localPrimaryConfigMock: {
    hardKill: false,
    contentProxyEnabled: true,
    autoRollbackEnabled: true,
    gatewaySocketPath: '/run/nexus-inference/staging/ollama.sock',
    staffUserIds: [42],
  },
}));

vi.mock('../../src/config', () => ({
  config: runtimeConfigMock,
}));

vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: localPrimaryConfigMock,
}));

vi.mock('../../src/services/ollama-model-policy', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/ollama-model-policy')>(
    '../../src/services/ollama-model-policy',
  );
  const manifest = () => ({
    manifestVersion: '2026-08-12.1',
    activeModelId: 'production-winner',
    selectionStatus: 'production_selected',
    models: [{
      id: 'production-winner',
      digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }],
  });
  return {
    ...actual,
    getLocalModelManifest: manifest,
    tryGetLocalModelManifest: () => ({ ok: true as const, manifest: manifest() }),
  };
});

const migrationSql = readFileSync(
  resolve(__dirname, '../../migrations/284_local_primary_inference_foundation.sql'),
  'utf8',
);

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plan_configs (
      plan_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      daily_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      allowed_skills_json TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE subscriptions (user_id INTEGER PRIMARY KEY, plan TEXT NOT NULL);
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO plan_configs (plan_id, display_name) VALUES ('pro', 'Pro');
  `);
  db.exec(migrationSql);
  return db;
}

describe('local inference runtime control', () => {
  it('returns OFF when the process database is not initialized instead of throwing during argument evaluation', async () => {
    const control = await import('../../src/services/local-inference-runtime-control');
    expect(control.getLocalInferenceRuntimeControl()).toMatchObject({
      mode: 'off',
      rolloutPercent: 0,
      reason: 'runtime_control_unavailable',
    });
  });

  it('starts off and persists a staging canary with actor and manifest evidence', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
      environment: 'staging', mode: 'off', rolloutPercent: 0,
    });

    expect(control.setLocalInferenceRuntimeControl({
      mode: 'canary', rolloutPercent: 25, reason: 'staff cohort evidence', updatedBy: 42,
    }, db)).toMatchObject({ environment: 'staging', mode: 'canary', rolloutPercent: 25 });
    expect(db.prepare(`SELECT reason, updated_by, model_manifest_version,
                              active_model_digest, skill_profile_version
      FROM local_inference_runtime_control WHERE environment = 'staging'`).get()).toEqual({
      reason: 'staff cohort evidence',
      updated_by: 42,
      model_manifest_version: '2026-08-12.1',
      active_model_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      skill_profile_version: 'nexus-skill-inference-v3',
    });
    expect(db.prepare(`SELECT previous_mode, mode, rollout_percent, actor_type,
      actor_user_id, reason FROM local_inference_control_events`).get()).toEqual({
      previous_mode: 'off',
      mode: 'canary',
      rollout_percent: 25,
      actor_type: 'owner',
      actor_user_id: 42,
      reason: 'staff cohort evidence',
    });
    db.close();
  });

  it('requires exact percentages for each rollout mode', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    expect(() => control.setLocalInferenceRuntimeControl({
      mode: 'active', rolloutPercent: 50, reason: 'invalid active', updatedBy: 42,
    }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_PERCENT_INVALID' }));
    expect(() => control.setLocalInferenceRuntimeControl({
      mode: 'off', rolloutPercent: 1, reason: 'invalid off', updatedBy: 42,
    }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_PERCENT_INVALID' }));
    db.close();
  });

  it('fails persisted mode and percentage relationship corruption closed', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'canary', rollout_percent = 100,
          model_manifest_version = '2026-08-12.1',
          active_model_digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          skill_profile_version = 'nexus-skill-inference-v1'
      WHERE environment = 'staging'`).run();

    expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
      mode: 'off',
      rolloutPercent: 0,
      reason: 'runtime_control_stage_invalid_requires_owner_reset',
    });
    expect(control.reconcileLocalInferenceRuntimeControlAtStartup(db)).toEqual({
      reconciled: true,
      reason: 'runtime_control_stage_invalid_requires_owner_reset',
    });
    expect(db.prepare(`SELECT mode, rollout_percent, reason
      FROM local_inference_runtime_control WHERE environment = 'staging'`).get()).toEqual({
      mode: 'off',
      rollout_percent: 0,
      reason: 'startup_reconcile:runtime_control_stage_invalid_requires_owner_reset',
    });
    expect(db.prepare(`SELECT previous_mode, mode, actor_type, actor_user_id
      FROM local_inference_control_events`).get()).toEqual({
      previous_mode: 'canary',
      mode: 'off',
      actor_type: 'system_monitor',
      actor_user_id: null,
    });
    db.close();
  });

  it('allows an actorless system emergency OFF event but never an actorless owner mutation', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    expect(control.setLocalInferenceRuntimeControl({
      mode: 'off', rolloutPercent: 0, reason: 'system emergency', updatedBy: null,
      actorType: 'system_monitor',
    }, db)).toMatchObject({ mode: 'off' });
    expect(db.prepare(`SELECT actor_type, actor_user_id FROM local_inference_control_events`).get())
      .toEqual({ actor_type: 'system_monitor', actor_user_id: null });
    expect(() => control.setLocalInferenceRuntimeControl({
      mode: 'off', rolloutPercent: 0, reason: 'invalid owner', updatedBy: null,
      actorType: 'owner',
    }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_ACTOR_INVALID' }));
    db.close();
  });

  it('keeps the emergency process latch fail-closed until restart while allowing durable OFF', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    control.tripLocalInferenceEmergencyOffLatch('critical storage failure');

    try {
      expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
        mode: 'off',
        rolloutPercent: 0,
        reason: 'critical storage failure',
      });
      expect(() => control.setLocalInferenceRuntimeControl({
        mode: 'canary', rolloutPercent: 25, reason: 'unsafe recovery', updatedBy: 42,
      }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_EMERGENCY_LATCHED' }));
      expect(db.prepare(`SELECT mode, rollout_percent
        FROM local_inference_runtime_control WHERE environment = 'staging'`).get()).toEqual({
        mode: 'off',
        rollout_percent: 0,
      });

      expect(control.setLocalInferenceRuntimeControl({
        mode: 'off', rolloutPercent: 0, reason: 'persist emergency off', updatedBy: 42,
      }, db)).toMatchObject({ mode: 'off', reason: 'critical storage failure' });
    } finally {
      control.resetLocalInferenceEmergencyOffLatchForTests();
      db.close();
    }
  });

  it('rolls back the routing mutation when its mandatory audit event cannot be written', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    db.exec(`CREATE TRIGGER reject_local_control_event
      BEFORE INSERT ON local_inference_control_events
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;`);

    expect(() => control.setLocalInferenceRuntimeControl({
      mode: 'canary', rolloutPercent: 25, reason: 'must remain audited', updatedBy: 42,
    }, db)).toThrow('audit unavailable');
    expect(db.prepare(`SELECT mode, rollout_percent, reason
      FROM local_inference_runtime_control WHERE environment = 'staging'`).get()).toEqual({
      mode: 'off',
      rollout_percent: 0,
      reason: 'migration_default_off',
    });
    db.close();
  });

  it('fails active admission closed after the signed manifest version changes', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    control.setLocalInferenceRuntimeControl({
      mode: 'canary', rolloutPercent: 25, reason: 'staff cohort evidence', updatedBy: 42,
    }, db);
    db.prepare(`UPDATE local_inference_runtime_control
      SET model_manifest_version = 'superseded-manifest'
      WHERE environment = 'staging'`).run();

    expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
      mode: 'off',
      rolloutPercent: 0,
      reason: 'manifest_version_changed_requires_reactivation',
      manifestVersion: '2026-08-12.1',
    });
    db.close();
  });

  it('invalidates shadow stability when any signed inference-contract identity changes', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    control.setLocalInferenceRuntimeControl({
      mode: 'shadow', rolloutPercent: 0, reason: 'shadow evidence', updatedBy: 42,
    }, db);

    db.prepare(`UPDATE local_inference_runtime_control
      SET active_model_digest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      WHERE environment = 'staging'`).run();
    expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
      mode: 'off',
      reason: 'active_model_digest_changed_requires_reactivation',
    });

    control.setLocalInferenceRuntimeControl({
      mode: 'off', rolloutPercent: 0, reason: 'reset changed model contract', updatedBy: 42,
    }, db);
    control.setLocalInferenceRuntimeControl({
      mode: 'shadow', rolloutPercent: 0, reason: 'restart shadow evidence', updatedBy: 42,
    }, db);
    db.prepare(`UPDATE local_inference_runtime_control
      SET skill_profile_version = 'superseded-profile'
      WHERE environment = 'staging'`).run();
    expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
      mode: 'off',
      reason: 'skill_profile_version_changed_requires_reactivation',
    });
    db.close();
  });

  it('persists a statistically meaningful non-AI latency baseline and clears it on OFF', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    const capturedAt = '2026-08-12T12:00:00.000Z';

    expect(control.setLocalInferenceRuntimeControl({
      mode: 'canary',
      rolloutPercent: 25,
      reason: 'staff cohort with baseline',
      updatedBy: 42,
      nonAiP95BaselineMs: 120,
      nonAiBaselineSampleCount: 20,
      nonAiBaselineCapturedAt: capturedAt,
      endUserErrorRateBaselinePercent: 0.5,
      endUserErrorBaselineSampleCount: 40,
    }, db)).toMatchObject({
      nonAiP95BaselineMs: 120,
      nonAiBaselineSampleCount: 20,
      nonAiBaselineCapturedAt: capturedAt,
      endUserErrorRateBaselinePercent: 0.5,
      endUserErrorBaselineSampleCount: 40,
    });

    expect(control.setLocalInferenceRuntimeControl({
      mode: 'off', rolloutPercent: 0, reason: 'rollback', updatedBy: 42,
    }, db)).toMatchObject({
      mode: 'off',
      nonAiP95BaselineMs: null,
      nonAiBaselineSampleCount: 0,
      nonAiBaselineCapturedAt: null,
      endUserErrorRateBaselinePercent: null,
      endUserErrorBaselineSampleCount: 0,
    });
    db.close();
  });

  it('allows direct evidence-bound production activation and rejects percentage canaries', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    const originalNodeEnv = process.env.NODE_ENV;
    runtimeConfigMock.isStaging = false;
    process.env.NODE_ENV = 'production';

    try {
      expect(control.setLocalInferenceRuntimeControl({
        mode: 'active', rolloutPercent: 100, reason: 'release acceptance passed', updatedBy: 42,
        evidenceReference: 'release:sha256:acceptance-and-economics',
        nonAiP95BaselineMs: 120,
        nonAiBaselineSampleCount: 25,
        nonAiBaselineCapturedAt: '2026-08-12T12:00:00.000Z',
        endUserErrorRateBaselinePercent: 0.4,
        endUserErrorBaselineSampleCount: 25,
      }, db)).toMatchObject({ environment: 'production', mode: 'active', rolloutPercent: 100 });

      expect(() => control.setLocalInferenceRuntimeControl({
        mode: 'canary', rolloutPercent: 1, reason: 'percentage cohort', updatedBy: 42,
      }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_PRODUCTION_STAGE_INVALID' }));

      expect(() => control.setLocalInferenceRuntimeControl({
        mode: 'active',
        rolloutPercent: 100,
        reason: 'attempt to replace baseline',
        updatedBy: 42,
        evidenceReference: 'release:sha256:acceptance-and-economics',
        nonAiP95BaselineMs: 1,
        nonAiBaselineSampleCount: 25,
        nonAiBaselineCapturedAt: '2026-08-12T13:00:00.000Z',
        endUserErrorRateBaselinePercent: 0,
        endUserErrorBaselineSampleCount: 25,
      }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_BASELINE_STAGE_INVALID' }));

      expect(control.setLocalInferenceRuntimeControl({
        mode: 'off', rolloutPercent: 0, reason: 'immediate rollback', updatedBy: 42,
      }, db)).toMatchObject({ mode: 'off', rolloutPercent: 0 });
    } finally {
      runtimeConfigMock.isStaging = true;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      db.close();
    }
  });

  it('requires production auto-rollback and acceptance evidence before active/100%', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    const originalNodeEnv = process.env.NODE_ENV;
    runtimeConfigMock.isStaging = false;
    process.env.NODE_ENV = 'production';

    try {
      const activeInput = {
        mode: 'active' as const,
        rolloutPercent: 100,
        reason: 'release acceptance passed',
        updatedBy: 42,
        evidenceReference: 'release:sha256:acceptance-and-economics',
        nonAiP95BaselineMs: 120,
        nonAiBaselineSampleCount: 25,
        nonAiBaselineCapturedAt: '2026-08-12T12:00:00.000Z',
        endUserErrorRateBaselinePercent: 0.4,
        endUserErrorBaselineSampleCount: 25,
      };

      localPrimaryConfigMock.autoRollbackEnabled = false;
      expect(() => control.setLocalInferenceRuntimeControl(activeInput, db))
        .toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_AUTO_ROLLBACK_REQUIRED' }));

      localPrimaryConfigMock.autoRollbackEnabled = true;
      expect(() => control.setLocalInferenceRuntimeControl({
        ...activeInput,
        evidenceReference: '',
      }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_REQUIRED' }));

      localPrimaryConfigMock.staffUserIds = [];
      expect(control.setLocalInferenceRuntimeControl(activeInput, db)).toMatchObject({
        mode: 'active', rolloutPercent: 100,
      });
    } finally {
      localPrimaryConfigMock.autoRollbackEnabled = true;
      localPrimaryConfigMock.staffUserIds = [42];
      runtimeConfigMock.isStaging = true;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      db.close();
    }
  });

  it('rejects an outage-poisoned production OFF-to-shadow baseline', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    const originalNodeEnv = process.env.NODE_ENV;
    runtimeConfigMock.isStaging = false;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => control.setLocalInferenceRuntimeControl({
        mode: 'shadow', rolloutPercent: 0, reason: 'bad outage baseline', updatedBy: 42,
        nonAiP95BaselineMs: 5_000,
        nonAiBaselineSampleCount: 25,
        nonAiBaselineCapturedAt: '2026-08-12T12:00:00.000Z',
        endUserErrorRateBaselinePercent: 10,
        endUserErrorBaselineSampleCount: 25,
      }, db)).toThrowError(expect.objectContaining({ code: 'LOCAL_CONTROL_BASELINE_UNHEALTHY' }));
    } finally {
      runtimeConfigMock.isStaging = true;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      db.close();
    }
  });

  it('makes an already-persisted production active state effectively OFF after protection env drift', async () => {
    const db = database();
    const control = await import('../../src/services/local-inference-runtime-control');
    const originalNodeEnv = process.env.NODE_ENV;
    runtimeConfigMock.isStaging = false;
    process.env.NODE_ENV = 'production';

    try {
      db.prepare(`UPDATE local_inference_runtime_control
        SET mode = 'active', rollout_percent = 100,
            model_manifest_version = '2026-08-12.1',
            active_model_digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            skill_profile_version = 'nexus-skill-inference-v3', updated_by = 42
        WHERE environment = 'production'`).run();

      localPrimaryConfigMock.autoRollbackEnabled = false;
      expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
        mode: 'off', rolloutPercent: 0,
        reason: 'auto_rollback_disabled_requires_reactivation',
      });

      localPrimaryConfigMock.autoRollbackEnabled = true;
      localPrimaryConfigMock.staffUserIds = [];
      expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({ mode: 'active', rolloutPercent: 100 });

      localPrimaryConfigMock.gatewaySocketPath = '';
      expect(control.getLocalInferenceRuntimeControl(db)).toMatchObject({
        mode: 'off', rolloutPercent: 0,
        reason: 'runtime_prerequisite_changed_requires_reactivation',
      });
      expect(control.reconcileLocalInferenceRuntimeControlAtStartup(db)).toEqual({
        reconciled: true,
        reason: 'runtime_prerequisite_changed_requires_reactivation',
      });
      expect(db.prepare(`SELECT mode, rollout_percent, reason
        FROM local_inference_runtime_control WHERE environment = 'production'`).get()).toEqual({
        mode: 'off',
        rollout_percent: 0,
        reason: 'startup_reconcile:runtime_prerequisite_changed_requires_reactivation',
      });
    } finally {
      localPrimaryConfigMock.autoRollbackEnabled = true;
      localPrimaryConfigMock.staffUserIds = [42];
      localPrimaryConfigMock.gatewaySocketPath = '/run/nexus-inference/staging/ollama.sock';
      runtimeConfigMock.isStaging = true;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      db.close();
    }
  });
});
