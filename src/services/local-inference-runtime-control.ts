// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { config } from '../config';
import { getDb } from './database';
import { localPrimaryInferenceConfig } from './local-primary-config';
import { getLocalModelManifest, tryGetLocalModelManifest } from './ollama-model-policy';
import { localInferenceScheduler } from './local-inference-scheduler';
import { SKILL_INFERENCE_PROFILE_VERSION } from './skill-inference-profiles';

export type LocalInferenceMode = 'off' | 'shadow' | 'canary' | 'active';

export interface LocalInferenceRuntimeControlView {
  mode: LocalInferenceMode;
  rolloutPercent: number;
  environment: 'staging' | 'production';
  manifestVersion: string;
  activeModelId: string;
  activeModelDigest: string;
  profileVersion: string;
  nonAiP95BaselineMs: number | null;
  nonAiBaselineSampleCount: number;
  nonAiBaselineCapturedAt: string | null;
  endUserErrorRateBaselinePercent: number | null;
  endUserErrorBaselineSampleCount: number;
  reason: string;
  updatedAt: string | null;
}

let emergencyOffLatchReason: string | null = null;

/**
 * Process-local last-resort latch for a critical incident whose durable OFF
 * transaction could not commit. Recovery requires repairing persistence and
 * restarting (or an explicit test reset); new local admission stays closed.
 */
export function tripLocalInferenceEmergencyOffLatch(reason: string): void {
  emergencyOffLatchReason = reason.trim().slice(0, 160) || 'critical_safety_incident_persistence_failed';
}

export function resetLocalInferenceEmergencyOffLatchForTests(): void {
  emergencyOffLatchReason = null;
}

export class LocalInferenceRuntimeControlError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'LocalInferenceRuntimeControlError';
  }
}

const PRODUCTION_ROLLOUT_STAGES: ReadonlyArray<{
  mode: LocalInferenceMode;
  rolloutPercent: number;
}> = [
  { mode: 'off', rolloutPercent: 0 },
  { mode: 'shadow', rolloutPercent: 0 },
  { mode: 'active', rolloutPercent: 100 },
];

function productionStageIndex(mode: LocalInferenceMode, rolloutPercent: number): number {
  return PRODUCTION_ROLLOUT_STAGES.findIndex((stage) => (
    stage.mode === mode && stage.rolloutPercent === rolloutPercent
  ));
}

function assertProductionRolloutProgression(
  before: LocalInferenceRuntimeControlView,
  mode: LocalInferenceMode,
  rolloutPercent: number,
): void {
  const targetIndex = productionStageIndex(mode, rolloutPercent);
  if (targetIndex < 0) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_PRODUCTION_STAGE_INVALID',
      'Production local inference supports OFF, optional verification-only shadow, and active/100%.',
      409,
    );
  }
  const beforeIndex = productionStageIndex(before.mode, before.rolloutPercent);
  if (beforeIndex < 0) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_PRODUCTION_STAGE_UNKNOWN',
      'The current production rollout stage is not governed; set mode OFF before continuing.',
      409,
    );
  }
  // The canonical release plan removed percentage cohorts and the 30-day
  // observation gate. Once the signed pre-release acceptance/economics
  // evidence is supplied, an owner may move directly from OFF to active/100%.
  // Shadow remains an optional zero-user verification state, never a timed
  // prerequisite. Backward movement (including emergency OFF) stays valid.
  if (targetIndex <= beforeIndex) return;
}

function runtimeEnvironment(): 'staging' | 'production' {
  return config.isStaging || process.env.NODE_ENV !== 'production' ? 'staging' : 'production';
}

function isValidPersistedRuntimeStage(
  mode: unknown,
  rolloutPercent: unknown,
  environment: 'staging' | 'production',
): mode is LocalInferenceMode {
  if (!Number.isSafeInteger(rolloutPercent)) return false;
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'canary' && mode !== 'active') return false;
  const percent = Number(rolloutPercent);
  const relationshipValid = mode === 'off' || mode === 'shadow'
    ? percent === 0
    : mode === 'active'
      ? percent === 100
      : mode === 'canary' && percent >= 1 && percent <= 99;
  if (!relationshipValid) return false;
  return environment !== 'production' || productionStageIndex(mode, percent) >= 0;
}

export function getLocalInferenceRuntimeControl(
  db?: Database.Database,
): LocalInferenceRuntimeControlView {
  let manifest: ReturnType<typeof getLocalModelManifest>;
  try {
    manifest = getLocalModelManifest({ fresh: true });
  } catch {
    return {
      mode: 'off',
      rolloutPercent: 0,
      environment: runtimeEnvironment(),
      manifestVersion: 'unavailable',
      activeModelId: 'unavailable',
      activeModelDigest: 'unavailable',
      profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
      nonAiP95BaselineMs: null,
      nonAiBaselineSampleCount: 0,
      nonAiBaselineCapturedAt: null,
      endUserErrorRateBaselinePercent: null,
      endUserErrorBaselineSampleCount: 0,
      reason: 'model_manifest_unavailable',
      updatedAt: null,
    };
  }
  const activeModelDigest = manifest.models.find((model) => model.id === manifest.activeModelId)!.digest!;
  if (emergencyOffLatchReason) {
    return {
      mode: 'off',
      rolloutPercent: 0,
      environment: runtimeEnvironment(),
      manifestVersion: manifest.manifestVersion,
      activeModelId: manifest.activeModelId,
      activeModelDigest,
      profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
      nonAiP95BaselineMs: null,
      nonAiBaselineSampleCount: 0,
      nonAiBaselineCapturedAt: null,
      endUserErrorRateBaselinePercent: null,
      endUserErrorBaselineSampleCount: 0,
      reason: emergencyOffLatchReason,
      updatedAt: null,
    };
  }
  if (localPrimaryInferenceConfig.hardKill) {
    return {
      mode: 'off',
      rolloutPercent: 0,
      environment: runtimeEnvironment(),
      manifestVersion: manifest.manifestVersion,
      activeModelId: manifest.activeModelId,
      activeModelDigest,
      profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
      nonAiP95BaselineMs: null,
      nonAiBaselineSampleCount: 0,
      nonAiBaselineCapturedAt: null,
      endUserErrorRateBaselinePercent: null,
      endUserErrorBaselineSampleCount: 0,
      reason: 'environment_hard_kill',
      updatedAt: null,
    };
  }
  try {
    // Resolve the process database inside this guarded read path. Imports that
    // occur before database initialization must observe runtime OFF instead of
    // throwing while a default argument is evaluated.
    const runtimeDb = db ?? getDb();
    const environment = runtimeEnvironment();
    const row = runtimeDb.prepare(`SELECT mode, rollout_percent, reason, updated_at,
                                    model_manifest_version, active_model_digest, skill_profile_version,
                                    non_ai_p95_baseline_ms, non_ai_baseline_sample_count,
                                    non_ai_baseline_captured_at,
                                    end_user_error_rate_baseline_percent,
                                    end_user_error_baseline_sample_count
      FROM local_inference_runtime_control WHERE environment = ?`)
      .get(environment) as {
        mode: LocalInferenceMode;
        rollout_percent: number;
        reason: string;
        updated_at: string;
        model_manifest_version: string | null;
        active_model_digest: string | null;
        skill_profile_version: string | null;
        non_ai_p95_baseline_ms: number | null;
        non_ai_baseline_sample_count: number | null;
        non_ai_baseline_captured_at: string | null;
        end_user_error_rate_baseline_percent: number | null;
        end_user_error_baseline_sample_count: number | null;
      } | undefined;
    if (row && !isValidPersistedRuntimeStage(row.mode, row.rollout_percent, environment)) {
      return {
        mode: 'off',
        rolloutPercent: 0,
        environment,
        manifestVersion: manifest.manifestVersion,
        activeModelId: manifest.activeModelId,
        activeModelDigest,
        profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
        nonAiP95BaselineMs: null,
        nonAiBaselineSampleCount: 0,
        nonAiBaselineCapturedAt: null,
        endUserErrorRateBaselinePercent: null,
        endUserErrorBaselineSampleCount: 0,
        reason: 'runtime_control_stage_invalid_requires_owner_reset',
        updatedAt: row.updated_at,
      };
    }
    if (row && row.mode !== 'off'
        && (!localPrimaryInferenceConfig.contentProxyEnabled
          || !config.ollama.enabled
          || !localPrimaryInferenceConfig.gatewaySocketPath)) {
      return {
        mode: 'off',
        rolloutPercent: 0,
        environment,
        manifestVersion: manifest.manifestVersion,
        activeModelId: manifest.activeModelId,
        activeModelDigest,
        profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
        nonAiP95BaselineMs: row.non_ai_p95_baseline_ms ?? null,
        nonAiBaselineSampleCount: row.non_ai_baseline_sample_count ?? 0,
        nonAiBaselineCapturedAt: row.non_ai_baseline_captured_at ?? null,
        endUserErrorRateBaselinePercent: row.end_user_error_rate_baseline_percent ?? null,
        endUserErrorBaselineSampleCount: row.end_user_error_baseline_sample_count ?? 0,
        reason: 'runtime_prerequisite_changed_requires_reactivation',
        updatedAt: row.updated_at,
      };
    }
    if (row && environment === 'production'
        && (row.mode === 'canary' || row.mode === 'active')
        && !localPrimaryInferenceConfig.autoRollbackEnabled) {
      return {
        mode: 'off',
        rolloutPercent: 0,
        environment,
        manifestVersion: manifest.manifestVersion,
        activeModelId: manifest.activeModelId,
        activeModelDigest,
        profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
        nonAiP95BaselineMs: row.non_ai_p95_baseline_ms ?? null,
        nonAiBaselineSampleCount: row.non_ai_baseline_sample_count ?? 0,
        nonAiBaselineCapturedAt: row.non_ai_baseline_captured_at ?? null,
        endUserErrorRateBaselinePercent: row.end_user_error_rate_baseline_percent ?? null,
        endUserErrorBaselineSampleCount: row.end_user_error_baseline_sample_count ?? 0,
        reason: 'auto_rollback_disabled_requires_reactivation',
        updatedAt: row.updated_at,
      };
    }
    const contractDriftReason = !row || row.mode === 'off'
      ? null
      : row.model_manifest_version !== manifest.manifestVersion
        ? 'manifest_version_changed_requires_reactivation'
        : row.active_model_digest !== activeModelDigest
          ? 'active_model_digest_changed_requires_reactivation'
          : row.skill_profile_version !== SKILL_INFERENCE_PROFILE_VERSION
            ? 'skill_profile_version_changed_requires_reactivation'
            : null;
    if (row && contractDriftReason) {
      return {
        mode: 'off',
        rolloutPercent: 0,
        environment,
        manifestVersion: manifest.manifestVersion,
        activeModelId: manifest.activeModelId,
        activeModelDigest,
        profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
        nonAiP95BaselineMs: null,
        nonAiBaselineSampleCount: 0,
        nonAiBaselineCapturedAt: null,
        endUserErrorRateBaselinePercent: null,
        endUserErrorBaselineSampleCount: 0,
        reason: contractDriftReason,
        updatedAt: row.updated_at,
      };
    }
    return {
      mode: row?.mode ?? 'off',
      rolloutPercent: row?.rollout_percent ?? 0,
      environment,
      manifestVersion: manifest.manifestVersion,
      activeModelId: manifest.activeModelId,
      activeModelDigest,
      profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
      nonAiP95BaselineMs: row?.non_ai_p95_baseline_ms ?? null,
      nonAiBaselineSampleCount: row?.non_ai_baseline_sample_count ?? 0,
      nonAiBaselineCapturedAt: row?.non_ai_baseline_captured_at ?? null,
      endUserErrorRateBaselinePercent: row?.end_user_error_rate_baseline_percent ?? null,
      endUserErrorBaselineSampleCount: row?.end_user_error_baseline_sample_count ?? 0,
      reason: row?.reason ?? 'runtime_control_missing',
      updatedAt: row?.updated_at ?? null,
    };
  } catch {
    return {
      mode: 'off',
      rolloutPercent: 0,
      environment: runtimeEnvironment(),
      manifestVersion: manifest.manifestVersion,
      activeModelId: manifest.activeModelId,
      activeModelDigest,
      profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
      nonAiP95BaselineMs: null,
      nonAiBaselineSampleCount: 0,
      nonAiBaselineCapturedAt: null,
      endUserErrorRateBaselinePercent: null,
      endUserErrorBaselineSampleCount: 0,
      reason: 'runtime_control_unavailable',
      updatedAt: null,
    };
  }
}

export function setLocalInferenceRuntimeControl(input: {
  mode: LocalInferenceMode;
  rolloutPercent: number;
  reason: string;
  updatedBy: number | null;
  actorType?: 'owner' | 'system_monitor';
  evidenceReference?: string;
  nonAiP95BaselineMs?: number;
  nonAiBaselineSampleCount?: number;
  nonAiBaselineCapturedAt?: string;
  endUserErrorRateBaselinePercent?: number;
  endUserErrorBaselineSampleCount?: number;
}, db: Database.Database = getDb(), options: {
  deferInMemoryQueueDrain?: boolean;
} = {}): LocalInferenceRuntimeControlView {
  const actorType = input.actorType ?? 'owner';
  const validActorId = Number.isSafeInteger(input.updatedBy) && Number(input.updatedBy) > 0;
  if ((actorType === 'owner' && !validActorId)
      || (actorType === 'system_monitor' && input.updatedBy !== null && !validActorId)) {
    throw new LocalInferenceRuntimeControlError('LOCAL_CONTROL_ACTOR_INVALID', 'An authenticated owner actor is required.', 403);
  }
  const reason = input.reason.trim().slice(0, 240);
  if (!reason) throw new LocalInferenceRuntimeControlError('LOCAL_CONTROL_REASON_REQUIRED', 'A rollout reason is required.', 400);
  if (emergencyOffLatchReason && input.mode !== 'off') {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_EMERGENCY_LATCHED',
      'Local inference is emergency-latched OFF until persistence is repaired and the process is restarted.',
      409,
    );
  }
  const expectedPercent = input.mode === 'active' ? 100 : input.mode === 'canary' ? input.rolloutPercent : 0;
  if (!Number.isSafeInteger(input.rolloutPercent)
      || input.rolloutPercent < 0
      || input.rolloutPercent > 100
      || (input.mode === 'canary' && (input.rolloutPercent < 1 || input.rolloutPercent > 99))
      || input.rolloutPercent !== expectedPercent) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_PERCENT_INVALID',
      'off/shadow require 0%, canary requires 1-99%, and active requires 100%.',
      400,
    );
  }
  const environment = runtimeEnvironment();
  const durableBefore = db.prepare(`SELECT mode, rollout_percent, model_manifest_version,
                                           active_model_digest, skill_profile_version
    FROM local_inference_runtime_control WHERE environment = ?`)
    .get(environment) as {
      mode: LocalInferenceMode;
      rollout_percent: number;
      model_manifest_version: string | null;
      active_model_digest: string | null;
      skill_profile_version: string | null;
    } | undefined;
  const manifestLoad = tryGetLocalModelManifest({ fresh: true });
  if (!manifestLoad.ok && input.mode !== 'off') {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_MODEL_MANIFEST_UNAVAILABLE',
      'Local inference cannot open while the signed model manifest is unavailable.',
      503,
    );
  }
  const manifest = manifestLoad.ok ? manifestLoad.manifest : null;
  if (input.mode !== 'off') {
    if (localPrimaryInferenceConfig.hardKill
        || !localPrimaryInferenceConfig.contentProxyEnabled
        || !config.ollama.enabled
        || !localPrimaryInferenceConfig.gatewaySocketPath) {
      throw new LocalInferenceRuntimeControlError(
        'LOCAL_CONTROL_PREREQUISITE_MISSING',
        'Local inference runtime, gateway transport, and Content proxy must be configured before admission opens.',
        409,
      );
    }
    if (environment === 'production'
        && input.mode !== 'shadow'
        && manifest!.selectionStatus !== 'production_selected') {
      throw new LocalInferenceRuntimeControlError(
        'LOCAL_MODEL_WINNER_NOT_PINNED',
        'Production canary or active routing requires a digest-pinned benchmark winner.',
        409,
      );
    }
    if (environment === 'production'
        && input.mode === 'active'
        && !localPrimaryInferenceConfig.autoRollbackEnabled) {
      throw new LocalInferenceRuntimeControlError(
        'LOCAL_CONTROL_AUTO_ROLLBACK_REQUIRED',
        'Production active routing requires the automatic rollback monitor.',
        409,
      );
    }
    if (environment === 'production'
        && input.mode === 'active'
        && !input.evidenceReference?.trim()) {
      throw new LocalInferenceRuntimeControlError(
        'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_REQUIRED',
        'Production active routing requires the signed ten-script acceptance and pre-release economics evidence reference.',
        409,
      );
    }
  }
  const before = getLocalInferenceRuntimeControl(db);
  if (input.mode !== 'off'
      && (before.reason === 'manifest_version_changed_requires_reactivation'
        || before.reason === 'active_model_digest_changed_requires_reactivation'
        || before.reason === 'skill_profile_version_changed_requires_reactivation'
        || before.reason === 'runtime_prerequisite_changed_requires_reactivation'
        || before.reason === 'model_manifest_unavailable')) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_EXPLICIT_OFF_REQUIRED',
      'Set local inference explicitly OFF before reactivating after manifest drift or outage.',
      409,
    );
  }
  if (environment === 'production') {
    assertProductionRolloutProgression(before, input.mode, input.rolloutPercent);
  }
  const suppliedBaseline = input.nonAiP95BaselineMs;
  const suppliedSampleCount = input.nonAiBaselineSampleCount;
  const suppliedCapturedAt = input.nonAiBaselineCapturedAt;
  const baselineSupplied = Number.isSafeInteger(suppliedBaseline)
    && Number(suppliedBaseline) >= 0
    && Number.isSafeInteger(suppliedSampleCount)
    && Number(suppliedSampleCount) >= 20
    && typeof suppliedCapturedAt === 'string'
    && Number.isFinite(Date.parse(suppliedCapturedAt));
  const suppliedErrorRate = input.endUserErrorRateBaselinePercent;
  const suppliedErrorSampleCount = input.endUserErrorBaselineSampleCount;
  const errorBaselineSupplied = typeof suppliedErrorRate === 'number'
    && Number.isFinite(suppliedErrorRate)
    && suppliedErrorRate >= 0
    && suppliedErrorRate <= 100
    && Number.isSafeInteger(suppliedErrorSampleCount)
    && Number(suppliedErrorSampleCount) >= 20;
  if ((suppliedBaseline !== undefined || suppliedSampleCount !== undefined || suppliedCapturedAt !== undefined)
      && !baselineSupplied) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_BASELINE_INVALID',
      'A non-AI latency baseline requires a nonnegative p95, at least 20 samples, and a valid capture time.',
      400,
    );
  }
  if ((suppliedErrorRate !== undefined || suppliedErrorSampleCount !== undefined)
      && !errorBaselineSupplied) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_ERROR_BASELINE_INVALID',
      'An end-user error baseline requires a 0-100 percent rate and at least 20 samples.',
      400,
    );
  }
  const enteringProductionVerification = environment === 'production'
    && before.mode === 'off'
    && (input.mode === 'shadow' || input.mode === 'active');
  if (environment === 'production'
      && (baselineSupplied || errorBaselineSupplied)
      && !enteringProductionVerification) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_BASELINE_STAGE_INVALID',
      'Production baselines are captured once when leaving OFF and remain immutable until rollback.',
      409,
    );
  }
  if (enteringProductionVerification && (!baselineSupplied || !errorBaselineSupplied)) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_BASELINES_REQUIRED',
      'Production activation requires at least 20 pre-activation non-AI latency and end-user error samples.',
      409,
    );
  }
  if (enteringProductionVerification
      && (Number(suppliedBaseline) > 2_000 || Number(suppliedErrorRate) > 2)) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_BASELINE_UNHEALTHY',
      'Production activation cannot start from an outage-poisoned baseline (non-AI p95 must be at most 2s and public 5xx at most 2%).',
      409,
    );
  }
  if (environment === 'production'
      && input.mode === 'active'
      && ((before.nonAiP95BaselineMs === null && !baselineSupplied)
        || (before.endUserErrorRateBaselinePercent === null && !errorBaselineSupplied))) {
    throw new LocalInferenceRuntimeControlError(
      'LOCAL_CONTROL_BASELINES_REQUIRED',
      'Production rollout requires at least 20 pre-rollout non-AI latency and end-user error samples.',
      409,
    );
  }
  const changedAt = new Date().toISOString();
  const applyDatabaseMutation = (): void => {
    const changed = db.prepare(`UPDATE local_inference_runtime_control
      SET mode = ?, rollout_percent = ?, model_manifest_version = ?,
          active_model_digest = ?, skill_profile_version = ?, reason = ?,
          updated_by = ?, updated_at = ?,
          non_ai_p95_baseline_ms = CASE
            WHEN ? = 'off' THEN NULL
            WHEN ? = 1 THEN ?
            ELSE non_ai_p95_baseline_ms END,
          non_ai_baseline_sample_count = CASE
            WHEN ? = 'off' THEN NULL
            WHEN ? = 1 THEN ?
            ELSE non_ai_baseline_sample_count END,
          non_ai_baseline_captured_at = CASE
            WHEN ? = 'off' THEN NULL
            WHEN ? = 1 THEN ?
            ELSE non_ai_baseline_captured_at END,
          end_user_error_rate_baseline_percent = CASE
            WHEN ? = 'off' THEN NULL
            WHEN ? = 1 THEN ?
            ELSE end_user_error_rate_baseline_percent END,
          end_user_error_baseline_sample_count = CASE
            WHEN ? = 'off' THEN NULL
            WHEN ? = 1 THEN ?
            ELSE end_user_error_baseline_sample_count END
      WHERE environment = ?`)
      .run(
        input.mode,
        input.rolloutPercent,
        manifest?.manifestVersion ?? durableBefore?.model_manifest_version ?? null,
        manifest?.models.find((model) => model.id === manifest.activeModelId)?.digest
          ?? durableBefore?.active_model_digest
          ?? null,
        SKILL_INFERENCE_PROFILE_VERSION,
        reason,
        input.updatedBy,
        changedAt,
        input.mode,
        baselineSupplied ? 1 : 0,
        baselineSupplied ? suppliedBaseline : null,
        input.mode,
        baselineSupplied ? 1 : 0,
        baselineSupplied ? suppliedSampleCount : null,
        input.mode,
        baselineSupplied ? 1 : 0,
        baselineSupplied ? suppliedCapturedAt : null,
        input.mode,
        errorBaselineSupplied ? 1 : 0,
        errorBaselineSupplied ? suppliedErrorRate : null,
        input.mode,
        errorBaselineSupplied ? 1 : 0,
        errorBaselineSupplied ? suppliedErrorSampleCount : null,
        environment,
      );
    if (changed.changes !== 1) {
      throw new LocalInferenceRuntimeControlError('LOCAL_CONTROL_MISSING', 'Local inference runtime control is unavailable.', 503);
    }
    db.prepare(`INSERT INTO local_inference_control_events (
      environment, previous_mode, mode, rollout_percent, actor_type,
      actor_user_id, model_manifest_version, active_model_digest,
      skill_profile_version, reason, evidence_reference
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        environment,
        durableBefore?.mode ?? before.mode,
        input.mode,
        input.rolloutPercent,
        actorType,
        input.updatedBy,
        manifest?.manifestVersion ?? durableBefore?.model_manifest_version ?? null,
        manifest?.models.find((model) => model.id === manifest.activeModelId)?.digest
          ?? durableBefore?.active_model_digest
          ?? null,
        SKILL_INFERENCE_PROFILE_VERSION,
        reason,
        input.evidenceReference?.trim().slice(0, 240) || null,
      );
    if (input.mode === 'off') {
      // Jobs are durable and will resume from validated checkpoints after
      // admission reopens. Move work that has not acquired a lease out of the
      // runnable state in the same audited state transition; an active lease
      // stops at its next governed stage boundary.
      db.prepare(`UPDATE content_script_jobs
        SET status = 'waiting_capacity', stage = 'waiting_capacity', updated_at = ?
        WHERE status = 'queued'`)
        .run(changedAt);
    }
  };
  if (db.inTransaction) applyDatabaseMutation();
  else db.transaction(applyDatabaseMutation).immediate();
  if (input.mode === 'off' && !options.deferInMemoryQueueDrain) {
    localInferenceScheduler.rejectWaitingForRuntimeOff();
  }
  return getLocalInferenceRuntimeControl(db);
}

/** Invoke only after the audited database transaction that selected OFF commits. */
export function drainLocalInferenceWaitingQueueForRuntimeOff(): number {
  return localInferenceScheduler.rejectWaitingForRuntimeOff();
}

/**
 * Persist any protective effective-OFF decision before traffic is accepted.
 * Environment drift, manifest drift, a corrupt stage relationship, or an
 * emergency latch must not leave a durable canary/active row that silently
 * reopens on a later restart.
 */
export function reconcileLocalInferenceRuntimeControlAtStartup(
  db: Database.Database = getDb(),
): { reconciled: boolean; reason: string | null } {
  const environment = runtimeEnvironment();
  const durable = db.prepare(`SELECT mode FROM local_inference_runtime_control
    WHERE environment = ?`).get(environment) as { mode: LocalInferenceMode } | undefined;
  if (!durable || durable.mode === 'off') return { reconciled: false, reason: null };

  const effective = getLocalInferenceRuntimeControl(db);
  if (effective.mode !== 'off') return { reconciled: false, reason: null };

  setLocalInferenceRuntimeControl({
    mode: 'off',
    rolloutPercent: 0,
    reason: `startup_reconcile:${effective.reason}`.slice(0, 240),
    updatedBy: null,
    actorType: 'system_monitor',
    evidenceReference: 'application_startup_protective_runtime_reconciliation',
  }, db);
  return { reconciled: true, reason: effective.reason };
}
