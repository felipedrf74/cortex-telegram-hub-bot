// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { getDb } from './database';
import {
  drainLocalInferenceWaitingQueueForRuntimeOff,
  getLocalInferenceRuntimeControl,
  setLocalInferenceRuntimeControl,
  tripLocalInferenceEmergencyOffLatch,
} from './local-inference-runtime-control';
import { getOwnerBootstrapTarget } from './user-service';

export type CriticalLocalInferenceSafetyIncidentCode =
  | 'post_delivery_fallback_attempt'
  | 'tenant_isolation_escape'
  | 'secret_exposure'
  | 'prompt_injection_escape'
  | 'confirmation_bypass'
  | 'unsafe_output_served';

function fiveMinuteDedupeBucket(now = new Date()): string {
  const bucketed = new Date(now);
  bucketed.setUTCMinutes(Math.floor(bucketed.getUTCMinutes() / 5) * 5, 0, 0);
  return bucketed.toISOString().slice(0, 16);
}

function resolveIncidentAuditActor(
  db: Database.Database,
  environment: 'staging' | 'production',
): number | null {
  const owner = getOwnerBootstrapTarget();
  const ownerTenantId = owner?.tenantId;
  if (Number.isSafeInteger(ownerTenantId) && Number(ownerTenantId) > 0) {
    return Number(ownerTenantId);
  }
  const row = db.prepare(`SELECT updated_by FROM local_inference_runtime_control WHERE environment = ?`)
    .get(environment) as { updated_by: number | null } | undefined;
  return Number.isSafeInteger(row?.updated_by) && Number(row?.updated_by) > 0
    ? Number(row?.updated_by)
    : null;
}

function optionalPositiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/**
 * Persist content-free critical evidence and immediately stop new local
 * admission. Callers must only use this for a boundary that escaped or for an
 * invariant violation that would have escaped without the final guard.
 */
export function recordCriticalLocalInferenceSafetyIncident(input: {
  code: CriticalLocalInferenceSafetyIncidentCode;
  source: string;
  tenantId?: number;
  userId?: number;
  runId?: string;
  blocked: boolean;
}, db: Database.Database = getDb()): { routingDisabled: boolean } {
  const source = input.source.trim().slice(0, 120);
  if (!source) throw new Error('local_inference_safety_incident_source_required');
  let environment: 'staging' | 'production' = 'staging';
  let routingDisabled = false;
  let routingJustDisabled = false;
  let actorId: number | null = null;
  try {
    db.transaction(() => {
      const control = getLocalInferenceRuntimeControl(db);
      environment = control.environment;
      db.prepare(`INSERT OR IGNORE INTO local_inference_safety_incidents (
          environment, incident_code, source, tenant_id, user_id, run_id, blocked, dedupe_bucket
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          control.environment,
          input.code,
          source,
          optionalPositiveId(input.tenantId),
          optionalPositiveId(input.userId),
          input.runId?.trim().slice(0, 160) || null,
          input.blocked ? 1 : 0,
          fiveMinuteDedupeBucket(),
        );

      const durableControl = db.prepare(`SELECT mode FROM local_inference_runtime_control
        WHERE environment = ?`).get(control.environment) as { mode?: string } | undefined;
      if (durableControl?.mode === 'off') {
        routingDisabled = true;
        return;
      }
      actorId = resolveIncidentAuditActor(db, control.environment);
      setLocalInferenceRuntimeControl({
        mode: 'off',
        rolloutPercent: 0,
        reason: `critical_safety_incident:${input.code}`.slice(0, 240),
        updatedBy: actorId,
        actorType: 'system_monitor',
        evidenceReference: `local-inference-safety-incident:${input.code}`.slice(0, 240),
      }, db, { deferInMemoryQueueDrain: true });
      routingDisabled = true;
      routingJustDisabled = true;
    }).immediate();
  } catch (error) {
    const latchReason = `critical_safety_incident_storage_failed:${input.code}`;
    tripLocalInferenceEmergencyOffLatch(latchReason);
    drainLocalInferenceWaitingQueueForRuntimeOff();
    logger.error(
      {
        incidentCode: input.code,
        environment,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'Critical local inference safety incident persistence failed; process-local routing latch is OFF',
    );
    throw error;
  }

  if (!routingJustDisabled) return { routingDisabled };
  if (!actorId) {
    logger.error(
      { incidentCode: input.code, environment },
      'Critical local inference safety incident is disabling routing without a user actor',
    );
  }
  drainLocalInferenceWaitingQueueForRuntimeOff();
  logger.error(
    { incidentCode: input.code, environment, blocked: input.blocked },
    'Critical local inference safety incident disabled local routing',
  );
  return { routingDisabled: true };
}

export function listRecentCriticalLocalInferenceSafetyIncidents(
  environment: 'staging' | 'production',
  hours: number,
  db: Database.Database = getDb(),
): Array<{ code: CriticalLocalInferenceSafetyIncidentCode; count: number }> {
  const boundedHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
  return db.prepare(`SELECT incident_code AS code, COUNT(*) AS count
    FROM local_inference_safety_incidents
    WHERE environment = ?
      AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    GROUP BY incident_code ORDER BY incident_code`)
    .all(environment, `-${boundedHours} hours`) as Array<{
      code: CriticalLocalInferenceSafetyIncidentCode;
      count: number;
    }>;
}
