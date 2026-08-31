// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Coach periodization v2 routes — Codex P1 fix mounting the C2/C6/A5
 * endpoints called out in the plan v2.1.
 *
 * Surface:
 *   - POST /api/v1/training/week/travel               (C2)
 *   - POST /api/v1/training/week/:weekId/reflow       (C6)
 *   - GET  /api/v1/training/plans/:planId/coach-policy (A5 read)
 *   - PATCH /api/v1/training/plans/:planId/coach-policy (A5 write)
 *
 * **Feature-flag gated**. When `config.coaching.periodizationV2Enabled`
 * is false, every route in this module returns 404 with a clear
 * `code: 'COACH_V2_DISABLED'` body. Legacy training endpoints are
 * unaffected. Per the v2.1 build order (week 10-11 + 2-week soak),
 * the flag flips on in staging first, then production after the
 * false-positive / churn-rate gates pass.
 *
 * The parent router (src/api/router.ts:276) already wraps all
 * /api/v1/training/* with `requireEntitlement({ skill: 'training' })`,
 * so per-route auth is inherited.
 */

import { Router, type Response, type Request, type NextFunction } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import type { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError } from '../response-helpers';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import {
  getCoachPlanPolicy,
  getCoachPlanPolicySnapshot,
  previewCoachPlanPolicyPatch,
} from '../../services/coach-plan-policy';
import {
  ReflowMissingIdempotencyKeyError,
} from '../../services/training-week-reflow';
import {
  type TrainingReflowSyncTarget,
} from '../../services/training-week-reflow-propagation';
import {
  TravelWindowIdempotencyConflictError,
  TravelWindowVersionConflictError,
  deleteTravelWindowIdempotently,
  findTravelWindowsInRange,
  getTravelWindowById,
  listTravelWindows,
  recordTravelWindow,
  updateTravelWindowIdempotently,
  type RecordTravelWindowInput,
  type TravelWindowRow,
} from '../../services/travel-windows';
import {
  recordStructuredHealthIntake,
  getEffectiveHealthSafetyOutput,
  HealthDataLifecycleError,
} from '../../services/health-data-lifecycle';
import {
  AdaptationIdempotencyConflictError,
  AdaptationPlanNotFoundError,
  countNonSafetyAppliedAdaptations,
  findAdaptationByIdempotencyKey,
} from '../../services/training-plan-adaptations';
import { getSciencePolicyVersion } from '../../services/coach-kernel/training-principles';
import { loadCoachKnowledge } from '../../services/coach-kernel/knowledge-loader';
import { resolveMesocyclePlan } from '../../services/coach-kernel/mesocycle';
// recommendDeload + load-input + load-model imports are now driven via
// training-coach-v2-load-helper.ts (R5 P1 #3 refactor). Only the
// LoadModelDimensionResult type stays here for the response payload.
import { decideTaper } from '../../services/coach-kernel/taper';
import { classifyTrainingScenario } from '../../services/coach-kernel/scenario-classifier';
import { aggregateWeekConditions } from '../../services/coach-kernel/week-conditions';
import { buildSessionIntensityProfile } from '../../services/coach-kernel/intensity-profile';
import { detectMissedSessions } from '../../services/missed-session-sweep';
import { detectTrainingGap } from '../../services/gap-detector';
import { computeAdherenceTrend } from '../../services/adherence-trend';
import { findNextRace, daysToRace, normalizeRacePriority } from '../../services/race-calendar';
import { getDb } from '../../services/database';
import type { Session } from '../../services/coach-kernel/types';
import { resolveWeekIntent } from '../../services/coach-kernel/week-intent';
import {
  isActionableSessionStatus,
} from '../../services/coach-kernel/session-status';
import {
  serializeReflowResponse,
  buildReplayReflowResult,
} from './training-coach-v2-reflow-serializer';
import { computeLoadModelAndDeload } from './training-coach-v2-load-helper';
import { executeCoachActions } from '../../services/coach-kernel/coach-action-executor';
import type { LoadModelDimensionResult } from '../../services/coach-kernel/load-model';
import { hashOwnerIdForLog } from './_ownership-audit';
import { isStrictIsoDate, resolveTrainingTimezone } from '../../services/training-date-utils';
import {
  dbRowToSession,
  inferSportFromSessionType,
  resolveAthleteLevelFromPlan,
  resolveRaceCalendarFromPlanWithReport,
  type DbSessionRow,
} from './training-coach-v2-hydration';
import { requireTenantIdParam } from '../../services/tenant-scope';
import { getUserTimezoneById } from '../../services/user-service';
import { trainingOperationLockPublicError } from '../../services/training-operation-locks';
import {
  assertLegacyPlanMutationAllowed,
  assertLegacyWeekMutationAllowed,
} from '../../services/training-plan-revision-legacy-guard';
import { TrainingPlanRevisionError } from '../../services/training-plan-revision-errors';
import {
  TRAINING_COACH_V2_CONTRACT_VERSION,
  TrainingCoachV2ProposalConflictError,
  TrainingCoachV2ProposalStateError,
  bindTrainingCoachV2ProposalDecision,
  createTrainingCoachV2Proposal,
  findTrainingCoachV2ProposalByIdempotency,
} from '../../services/training-coach-v2-proposals';
import {
  TrainingCoachV2ReflowPreviewError,
  createTrainingCoachV2ReflowPreview,
  getTrainingCoachV2ReflowPreview,
} from '../../services/training-coach-v2-reflow-previews';

export { isStrictIsoDate };

/**
 * When the v2 flag is off, the v2 handler short-circuits here.
 * Called PER-HANDLER (not as router middleware) so unrelated legacy
 * routes mounted on the same parent router are unaffected. Returns
 * true when the handler should continue, false when it has already
 * responded with 404.
 */
/**
 * R8 P2-11 — narrow a stored HealthSignal row into the kernel's
 * HealthSignal shape, rejecting values that aren't in the closed
 * enum unions. Replaces the `as any` casts at the two
 * `wireHealthSignalToSafety` call sites — those casts silently
 * passed through any value, including DB rows from a stale schema.
 * Now unknown enum values get logger.warn-dropped to undefined and
 * the safety wiring sees a defensively-typed signal.
 */
const INJURY_STATUSES = new Set([
  'none', 'acute', 'chronic_managed', 'returning', 'post_exertional_symptom_risk',
] as const);
const MENSTRUAL_STATUSES = new Set([
  'menses', 'follicular', 'ovulation', 'luteal', 'amenorrhea', 'symptom_only',
] as const);
const ENERGY_RISK_VALUES = new Set(['low', 'moderate', 'high'] as const);

function narrowEnumField<T extends string>(
  fieldName: string,
  raw: string | null | undefined,
  allowed: ReadonlySet<T>,
): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  if ((allowed as ReadonlySet<string>).has(raw)) return raw as T;
  logger.warn(
    { fieldName, raw, errorId: 'health_signal.unknown_enum_value' },
    'health_signal.unknown_enum_value: dropping field to safe undefined',
  );
  return undefined;
}

/**
 * Map a `health-signals.ts` row (or compatible shape) into the
 * `HealthSignal` the kernel/safety-wiring expects. Pure + total.
 * Unknown enum values are dropped with a warn log so safety wiring
 * sees only well-typed inputs.
 *
 * Exported for testability.
 */
export interface HealthSignalRowLike {
  created_at: string;
  pain_score: number | null;
  pain_location: string | null;
  illness_symptoms_json: string | null;
  injury_status: string | null;
  menstrual_status: string | null;
  energy_availability_risk: string | null;
  consent_scope: string;
  source: string | null;
}

export function decodeHealthSignalRow(row: HealthSignalRowLike): {
  capturedAt: string;
  painScore?: number;
  painLocation?: string;
  illnessSymptoms?: readonly string[];
  injuryStatus?: 'none' | 'acute' | 'chronic_managed' | 'returning' | 'post_exertional_symptom_risk';
  menstrualStatus?: 'menses' | 'follicular' | 'ovulation' | 'luteal' | 'amenorrhea' | 'symptom_only';
  energyAvailabilityRisk?: 'low' | 'moderate' | 'high';
  consentScope: readonly string[];
  source?: string;
} {
  let illnessSymptoms: readonly string[] | undefined;
  if (row.illness_symptoms_json) {
    try {
      const parsed = JSON.parse(row.illness_symptoms_json);
      if (Array.isArray(parsed)) {
        illnessSymptoms = parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch {
      logger.warn(
        { errorId: 'health_signal.illness_json_parse_failed' },
        'health_signal.illness_json_parse_failed: dropping illness symptoms to safe undefined',
      );
    }
  }
  return {
    capturedAt: row.created_at,
    painScore: row.pain_score ?? undefined,
    painLocation: row.pain_location ?? undefined,
    illnessSymptoms,
    injuryStatus: narrowEnumField('injuryStatus', row.injury_status, INJURY_STATUSES),
    menstrualStatus: narrowEnumField('menstrualStatus', row.menstrual_status, MENSTRUAL_STATUSES),
    energyAvailabilityRisk: narrowEnumField('energyAvailabilityRisk', row.energy_availability_risk, ENERGY_RISK_VALUES),
    consentScope: (row.consent_scope ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    source: row.source ?? undefined,
  };
}

/**
 * R8 P1-4 — extract `weekId` from a stored adaptation ledger row's
 * `trigger_payload_json`. The ledger doesn't have a dedicated
 * week_id column (migration 156 stores week scope inside the JSON
 * payload), so the cross-week idempotency-key reuse guard parses
 * the JSON.
 *
 * Returns null when the payload is absent, unparseable, or doesn't
 * carry a numeric `weekId` field — callers should treat null as
 * "can't verify cross-week mismatch; proceed with the next check."
 */
export function extractWeekIdFromTriggerPayload(
  triggerPayloadJson: string | null | undefined,
): number | null {
  if (!triggerPayloadJson || triggerPayloadJson.length === 0) return null;
  try {
    const parsed = JSON.parse(triggerPayloadJson) as { weekId?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.weekId === 'number' && Number.isFinite(parsed.weekId)) {
      return parsed.weekId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strict YYYY-MM-DD date validator (R4 P2 fix).
 *
 * Accepts only:
 *   - exact `^\d{4}-\d{2}-\d{2}$` shape (rules out '2026/01/01',
 *     '20260101', '2026-01-01T00:00:00Z', "tomorrow", and injection
 *     attempts like "1970-01-01' OR 1=1").
 *   - real calendar date that round-trips via Date.UTC (rules out
 *     '2026-13-01', '2026-02-31', '2026-00-15').
 *
 * Exported so tests can hit the helper directly without spinning up
 * the route surface.
 */
function v2EnabledOrShortCircuit(res: Response): boolean {
  if (!config.coaching.periodizationV2Enabled) {
    sendError(
      res,
      'COACH_V2_DISABLED',
      'Coach periodization v2 endpoints are not enabled on this environment.',
      404,
    );
    return false;
  }
  return true;
}

function paramString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function resolvePlanId(req: Request, res: Response): number | null {
  const planId = Number.parseInt(paramString(req.params.planId), 10);
  if (!Number.isInteger(planId) || planId <= 0) {
    sendError(res, 'BAD_PLAN_ID', 'planId must be a positive integer.', 400);
    return null;
  }
  return planId;
}

function resolveWeekId(req: Request, res: Response): number | null {
  const weekId = Number.parseInt(paramString(req.params.weekId), 10);
  if (!Number.isInteger(weekId) || weekId <= 0) {
    sendError(res, 'BAD_WEEK_ID', 'weekId must be a positive integer.', 400);
    return null;
  }
  return weekId;
}

/**
 * Codex R2 P0 fix — ownership-scoped plan resolver.
 *
 * Every v2 route that accepts a caller-supplied `planId` MUST call
 * this before doing anything else with that id. Returns:
 *   - { planId, userId } when the plan exists AND belongs to the
 *     authenticated user.
 *   - null after `sendError` has already responded:
 *       * 404 PLAN_NOT_FOUND when the row is missing OR foreign-owned.
 *
 * Using a single helper guarantees the same response shape, code,
 * status, and message for missing and foreign rows. The internal
 * distinction is logged for audit only. The authenticated user is
 * read off `AuthenticatedRequest.userId`, NOT the body.
 */
function resolveOwnedPlan(
  req: Request,
  res: Response,
  planId: number,
): { planId: number; userId: number; tenantId: number } | null {
  const auth = req as AuthenticatedRequest;
  const tenantId = requireTenantIdParam(auth.tenantId, 'trainingCoachV2.resolveOwnedPlan');
  const row = getDb().prepare(
    'SELECT user_id, tenant_id FROM fitness_training_plans WHERE id = ?',
  ).get(planId) as { user_id: number; tenant_id: number } | undefined;
  if (!row) {
    sendError(res, 'PLAN_NOT_FOUND', `Plan ${planId} not found.`, 404);
    return null;
  }
  if (row.user_id !== auth.userId || row.tenant_id !== tenantId) {
    // R3 P2 fix — return IDENTICAL response (same status, same code,
    // same body) for both "missing" and "foreign owner" so the
    // status code cannot be used to enumerate plan ids. The
    // internal distinction is logged for audit but never surfaced
    // to the caller.
    logger.warn(
      {
        actor: auth.userId,
        planId,
        // R4 P3 fix — don't log the foreign owner's raw user id.
        // Audit correlation by hash; operator log can't reconstruct
        // the victim from the entry.
        ownerIdHash: hashOwnerIdForLog(row.user_id),
        reason: row.user_id !== auth.userId ? 'foreign_owner' : 'foreign_tenant',
      },
      'training_coach_v2.ownership_denied',
    );
    sendError(res, 'PLAN_NOT_FOUND', `Plan ${planId} not found.`, 404);
    return null;
  }
  return { planId, userId: auth.userId, tenantId };
}

/**
 * Codex R2 P0 fix — ownership-scoped week resolver. Loads the week
 * + parent plan and verifies the authenticated user owns the plan.
 */
function resolveOwnedWeek(
  req: Request,
  res: Response,
  weekId: number,
): { weekId: number; planId: number; userId: number; tenantId: number } | null {
  const auth = req as AuthenticatedRequest;
  const tenantId = requireTenantIdParam(auth.tenantId, 'trainingCoachV2.resolveOwnedWeek');
  const row = getDb().prepare(`
    SELECT w.id AS week_id, w.plan_id AS plan_id, p.user_id AS user_id, p.tenant_id AS tenant_id
    FROM training_weeks w
    JOIN fitness_training_plans p ON p.id = w.plan_id
    WHERE w.id = ?
  `).get(weekId) as { week_id: number; plan_id: number; user_id: number; tenant_id: number } | undefined;
  if (!row) {
    sendError(res, 'WEEK_NOT_FOUND', `Week ${weekId} not found.`, 404);
    return null;
  }
  if (row.user_id !== auth.userId || row.tenant_id !== tenantId) {
    // R3 P2 fix — uniform 404 (no status-code side channel).
    logger.warn(
      {
        actor: auth.userId,
        weekId,
        // R4 P3 fix — hashed owner id, see resolveOwnedPlan comment.
        ownerIdHash: hashOwnerIdForLog(row.user_id),
        reason: row.user_id !== auth.userId ? 'foreign_owner' : 'foreign_tenant',
      },
      'training_coach_v2.ownership_denied',
    );
    sendError(res, 'WEEK_NOT_FOUND', `Week ${weekId} not found.`, 404);
    return null;
  }
  return { weekId, planId: row.plan_id, userId: auth.userId, tenantId };
}

export function resolvePersistedTrainingReflowSyncTarget(
  preferencesJson: string | null,
): TrainingReflowSyncTarget {
  if (!preferencesJson) return 'auto';
  try {
    const preferences = JSON.parse(preferencesJson) as Record<string, unknown>;
    const spec = preferences.trainingPlanSpec;
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const calendarPreference = (spec as Record<string, unknown>).calendarPreference;
      if (calendarPreference && typeof calendarPreference === 'object' && !Array.isArray(calendarPreference)) {
        const provider = (calendarPreference as Record<string, unknown>).provider;
        if (
          provider === 'google'
          || provider === 'outlook'
          || provider === 'none'
          || provider === 'apple'
        ) return provider;
      }
    }

    if (preferences.trainingCalendarSource === 'google'
        || preferences.trainingCalendarSource === 'outlook') {
      return preferences.trainingCalendarSource;
    }
    // Newer compatibility plans persist this key even for an explicit
    // no-provider choice. Null is therefore deliberate, not permission to
    // re-resolve a provider later during reflow.
    if (Object.prototype.hasOwnProperty.call(preferences, 'trainingCalendarSource')
        && preferences.trainingCalendarSource === null) {
      return 'none';
    }
  } catch (err) {
    logger.warn({ err }, 'training_coach_v2.reflow_calendar_preference_unreadable');
  }
  return 'auto';
}

function parsePositiveRouteId(value: unknown): number | null {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : '';
  const id = Number.parseInt(String(raw), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseTravelIfMatch(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^"?travel-(\d+)"?$/.exec(value.trim());
  if (!match) return null;
  const version = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function parseCoachPolicyIfMatch(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^"?coach-policy-(\d+)"?$/.exec(value.trim());
  if (!match) return null;
  const version = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function parseTravelBody(
  body: Record<string, unknown>,
  requireDates: boolean,
): Partial<Omit<RecordTravelWindowInput, 'userId' | 'tenantId' | 'idempotencyKey'>> & {
  startDate?: string;
  endDate?: string;
} {
  const startDate = typeof body.startDate === 'string' ? body.startDate : undefined;
  const endDate = typeof body.endDate === 'string' ? body.endDate : undefined;
  if (requireDates && (!startDate || !endDate)) {
    throw new Error('BAD_TRAVEL_INPUT: startDate and endDate are required.');
  }
  if ((startDate && !isStrictIsoDate(startDate)) || (endDate && !isStrictIsoDate(endDate))) {
    throw new Error('BAD_TRAVEL_INPUT: dates must be valid YYYY-MM-DD calendar dates.');
  }
  if (startDate && endDate) {
    if (endDate < startDate) throw new Error('BAD_TRAVEL_INPUT: endDate must be on or after startDate.');
    const spanDays = Math.floor((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000);
    if (spanDays > 366) throw new Error('BAD_TRAVEL_INPUT: a travel window cannot exceed 366 days.');
  }
  const out: Partial<RecordTravelWindowInput> = {};
  if (startDate) out.startDate = startDate;
  if (endDate) out.endDate = endDate;
  if (body.equipmentProfile !== undefined) {
    if (typeof body.equipmentProfile !== 'string' || !body.equipmentProfile.trim() || body.equipmentProfile.length > 64) {
      throw new Error('BAD_TRAVEL_INPUT: equipmentProfile must contain 1 to 64 characters.');
    }
    out.equipmentProfile = body.equipmentProfile.trim();
  }
  if (body.timeZoneShiftHours !== undefined) {
    assertTravelNumber(body.timeZoneShiftHours, -14, 14, 'timeZoneShiftHours');
    out.timeZoneShiftHours = Number(body.timeZoneShiftHours);
  }
  if (body.flightDurationHours !== undefined) {
    assertTravelNumber(body.flightDurationHours, 0, 48, 'flightDurationHours');
    out.flightDurationHours = Number(body.flightDurationHours);
  }
  if (body.availableSessionDurationMinutes !== undefined) {
    assertTravelNumber(body.availableSessionDurationMinutes, 10, 360, 'availableSessionDurationMinutes', true);
    out.availableSessionDurationMinutes = Number(body.availableSessionDurationMinutes);
  }
  for (const key of ['sleepDisruptionExpected', 'walkingLoadExpected', 'heatStress'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new Error(`BAD_TRAVEL_INPUT: ${key} must be boolean.`);
    out[key] = body[key];
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string' || body.notes.length > 500) {
      throw new Error('BAD_TRAVEL_INPUT: notes cannot exceed 500 characters.');
    }
    out.notes = body.notes.trim();
  }
  return out;
}

function assertTravelNumber(value: unknown, min: number, max: number, field: string, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`BAD_TRAVEL_INPUT: ${field} must be ${integer ? 'an integer' : 'a number'} from ${min} through ${max}.`);
  }
}

function serializeTravelWindow(row: TravelWindowRow): Record<string, unknown> {
  return {
    id: row.id,
    version: row.version,
    startDate: row.start_date,
    endDate: row.end_date,
    equipmentProfile: row.equipment_profile,
    timeZoneShiftHours: row.time_zone_shift_hours,
    flightDurationHours: row.flight_duration_hours,
    sleepDisruptionExpected: row.sleep_disruption_expected === 1,
    walkingLoadExpected: row.walking_load_expected === 1,
    heatStress: row.heat_stress === 1,
    availableSessionDurationMinutes: row.available_session_duration_minutes,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sendTravelMutationError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TravelWindowVersionConflictError) {
    sendError(res, 'VERSION_CONFLICT', message, 412);
    return;
  }
  if (err instanceof TravelWindowIdempotencyConflictError) {
    const missing = /required/i.test(message);
    sendError(res, missing ? 'IDEMPOTENCY_REQUIRED' : 'IDEMPOTENCY_CONFLICT', message, missing ? 428 : 409);
    return;
  }
  if (/BAD_TRAVEL_INPUT|startDate/.test(message)) {
    sendError(res, 'BAD_INPUT', message, 400);
    return;
  }
  if (/NOT_FOUND/.test(message)) {
    sendError(res, 'TRAVEL_WINDOW_NOT_FOUND', 'Travel window not found.', 404);
    return;
  }
  logger.error({ err }, 'travel_window.mutation_failed');
  sendError(res, 'INTERNAL', 'Failed to mutate travel window.', 500);
}

function resolveActiveOwnedPlanId(req: Request, res: Response): number | null {
  if (!v2EnabledOrShortCircuit(res)) return null;
  const auth = req as AuthenticatedRequest;
  const tenantId = requireTenantIdParam(auth.tenantId, 'trainingCoachV2.resolveActiveOwnedPlanId');
  const row = getDb().prepare(`
    SELECT id FROM fitness_training_plans
    WHERE user_id = ? AND tenant_id = ? AND status = 'active'
    ORDER BY start_date DESC, id DESC LIMIT 1
  `).get(auth.userId, tenantId) as { id: number } | undefined;
  if (!row) {
    sendError(res, 'PLAN_NOT_FOUND', 'Active training plan not found.', 404);
    return null;
  }
  return row.id;
}

function dispatchCoachV2Alias(
  router: Router,
  req: Request,
  res: Response,
  next: NextFunction,
  targetUrl: string,
): void {
  req.url = targetUrl;
  (router as unknown as {
    handle: (request: Request, response: Response, callback: NextFunction) => void;
  }).handle(req, res, next);
}

function buildPrivacySafeCoachExplanations(input: {
  weekNumber: number;
  scenario: import('../../services/coach-kernel/scenario-classifier').ScenarioAssessment;
  hasSafetyOverride: boolean;
  hasTravel: boolean;
}): Array<{ code: string; text: string }> {
  const explanations: Array<{ code: string; text: string }> = [{
    code: 'selected_week',
    text: `Coach outlook is calculated for week ${input.weekNumber}.`,
  }];
  if (input.hasSafetyOverride) {
    explanations.push({
      code: 'safety_protection',
      text: 'A consented safety report is protecting this week; private symptom details are not included here.',
    });
  } else if (input.hasTravel) {
    explanations.push({
      code: 'travel_availability',
      text: 'Travel and availability are considered before any week change is proposed.',
    });
  }
  if (input.scenario.kind === 'rate_limited') {
    explanations.push({
      code: 'anti_churn',
      text: 'Another non-safety change was recently accepted, so this suggestion is waiting.',
    });
  } else if (input.scenario.primaryScenario === 'no_scenario') {
    explanations.push({ code: 'week_stable', text: 'No evidence-backed week change is currently needed.' });
  } else {
    explanations.push({
      code: 'coach_scenario',
      text: `The coach identified ${input.scenario.primaryScenario.replaceAll('_', ' ')} as the main week condition.`,
    });
  }
  return explanations;
}

/**
 * Mount the v2 routes onto an existing training Router. Builds a
 * SUB-ROUTER so the feature-flag gate doesn't accidentally apply to
 * legacy training endpoints registered on the parent.
 */
export function mountCoachV2Routes(parent: Router): Router {
  const v2 = Router({ mergeParams: true });
  const coachV2RateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: (req: Request) => {
      const readLimit = config.ios?.readRateLimit ?? Math.max(config.ios?.rateLimit ?? 60, 300);
      const writeLimit = config.ios?.rateLimit ?? 60;
      return req.method === 'GET' || req.method === 'HEAD' ? readLimit : writeLimit;
    },
    keyGenerator: (req: Request) => {
      const userId = (req as AuthenticatedRequest).userId;
      if (typeof userId === 'number' && userId > 0) return `user:${userId}`;
      return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || '0.0.0.0')}`;
    },
    legacyHeaders: true,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.ceil(options.windowMs / 1000);
      sendError(res, 'RATE_LIMITED', 'Too many requests. Slow down.', options.statusCode, {
        retryAfterSeconds: retryAfter,
        schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        outcome: 'rate_limited',
      });
    },
  });

  // Additive convenience routes used by the capability-gated iOS client.
  // They rewrite to the canonical plan/week-scoped contracts so validation,
  // ownership, rate limits, and response envelopes cannot drift.
  v2.get('/coach-policy', (req: Request, res: Response, next: NextFunction) => {
    const planId = resolveActiveOwnedPlanId(req, res);
    if (planId === null) return;
    dispatchCoachV2Alias(v2, req, res, next, `/plans/${planId}/coach-policy`);
  });
  v2.patch('/coach-policy', (req: Request, res: Response, next: NextFunction) => {
    const planId = resolveActiveOwnedPlanId(req, res);
    if (planId === null) return;
    dispatchCoachV2Alias(v2, req, res, next, `/plans/${planId}/coach-policy`);
  });
  v2.get('/coach/analysis', (req: Request, res: Response, next: NextFunction) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const weekId = Number.parseInt(typeof req.query.weekId === 'string' ? req.query.weekId : '', 10);
    if (!Number.isSafeInteger(weekId) || weekId <= 0) {
      sendError(res, 'BAD_WEEK_ID', 'weekId query parameter must be a positive integer.', 400);
      return;
    }
    const owned = resolveOwnedWeek(req, res, weekId);
    if (!owned) return;
    const week = getDb().prepare('SELECT week_number FROM training_weeks WHERE id = ? AND plan_id = ?')
      .get(weekId, owned.planId) as { week_number: number } | undefined;
    const weekIndex = Math.max(0, Number(week?.week_number ?? 1) - 1);
    dispatchCoachV2Alias(v2, req, res, next, `/plans/${owned.planId}/coach-analysis?weekIndex=${weekIndex}`);
  });
  v2.post('/week/reflow/preview', (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const weekId = Number.parseInt(String(body.weekId ?? ''), 10);
    if (!Number.isSafeInteger(weekId) || weekId <= 0) {
      sendError(res, 'BAD_WEEK_ID', 'weekId must be a positive integer.', 400);
      return;
    }
    req.body = { ...body, mode: 'preview' };
    dispatchCoachV2Alias(v2, req, res, next, `/week/${weekId}/reflow`);
  });
  v2.post('/week/reflow/proposals', (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const weekId = Number.parseInt(String(body.weekId ?? ''), 10);
    if (!Number.isSafeInteger(weekId) || weekId <= 0) {
      sendError(res, 'BAD_WEEK_ID', 'weekId must be a positive integer.', 400);
      return;
    }
    if (typeof body.previewId !== 'string' || !body.previewId.trim()) {
      sendError(res, 'PREVIEW_REQUIRED', 'previewId from a reviewed reflow preview is required.', 428);
      return;
    }
    req.body = { ...body, mode: 'apply' };
    dispatchCoachV2Alias(v2, req, res, next, `/week/${weekId}/reflow`);
  });

  // ── C2 — Travel & availability CRUD ────────────────────────────
  v2.get('/week/travel', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const auth = req as AuthenticatedRequest;
    const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined;
    const toDate = typeof req.query.toDate === 'string' ? req.query.toDate : undefined;
    if ((fromDate && !isStrictIsoDate(fromDate)) || (toDate && !isStrictIsoDate(toDate))) {
      sendError(res, 'BAD_INPUT', 'fromDate and toDate must be valid YYYY-MM-DD dates.', 400);
      return;
    }
    if (fromDate && toDate && fromDate > toDate) {
      sendError(res, 'BAD_INPUT', 'fromDate must be on or before toDate.', 400);
      return;
    }
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      sendError(res, 'BAD_INPUT', 'limit must be an integer from 1 through 100.', 400);
      return;
    }
    const windows = listTravelWindows(auth.userId, auth.tenantId, { fromDate, toDate, limit });
    sendSuccess(res, {
      schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
      windows: windows.map(serializeTravelWindow),
    });
  });

  v2.post('/week/travel', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const auth = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const travel = parseTravelBody(body, true);
      const idempotencyKey = req.header('Idempotency-Key') ?? String(body.idempotencyKey ?? '');
      if (!idempotencyKey.trim()) {
        sendError(res, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required for travel creation.', 428);
        return;
      }
      const result = recordTravelWindow({
        userId: auth.userId,
        tenantId: auth.tenantId,
        ...travel,
        startDate: travel.startDate!,
        endDate: travel.endDate!,
        idempotencyKey,
      });
      const window = getTravelWindowById(auth.userId, auth.tenantId, result.id)!;
      sendSuccess(res, {
        schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        state: result.alreadyExisted ? 'replayed' : 'created',
        alreadyExisted: result.alreadyExisted,
        window: serializeTravelWindow(window),
      }, { status: result.alreadyExisted ? 200 : 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TravelWindowIdempotencyConflictError) {
        sendError(res, 'IDEMPOTENCY_CONFLICT', message, 409);
        return;
      }
      if (/BAD_TRAVEL_INPUT|startDate/.test(message)) {
        sendError(res, 'BAD_INPUT', message, 400);
        return;
      }
      logger.error({ err, userId: auth.userId }, 'travel_window.write_failed');
      sendError(res, 'INTERNAL', 'Failed to record travel window.', 500);
    }
  });

  v2.patch('/week/travel/:id', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const auth = req as AuthenticatedRequest;
    const id = parsePositiveRouteId(req.params.id);
    if (id === null) {
      sendError(res, 'BAD_TRAVEL_ID', 'Travel window id must be a positive integer.', 400);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedVersion = parseTravelIfMatch(req.header('If-Match'))
      ?? (typeof body.expectedVersion === 'number' ? body.expectedVersion : null);
    if (expectedVersion === null) {
      sendError(res, 'PRECONDITION_REQUIRED', 'If-Match travel version is required.', 428);
      return;
    }
    try {
      if (!getTravelWindowById(auth.userId, auth.tenantId, id)) {
        sendError(res, 'TRAVEL_WINDOW_NOT_FOUND', 'Travel window not found.', 404);
        return;
      }
      const patch = parseTravelBody(body, false);
      const result = updateTravelWindowIdempotently({
        userId: auth.userId,
        tenantId: auth.tenantId,
        id,
        expectedVersion,
        patch,
        idempotencyKey: req.header('Idempotency-Key') ?? String(body.idempotencyKey ?? ''),
      });
      res.setHeader('ETag', `"travel-${result.window.version}"`);
      sendSuccess(res, {
        schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        state: result.replayed ? 'replayed' : 'updated',
        window: serializeTravelWindow(result.window),
      });
    } catch (err) {
      sendTravelMutationError(res, err);
    }
  });

  v2.delete('/week/travel/:id', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const auth = req as AuthenticatedRequest;
    const id = parsePositiveRouteId(req.params.id);
    if (id === null) {
      sendError(res, 'BAD_TRAVEL_ID', 'Travel window id must be a positive integer.', 400);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedVersion = parseTravelIfMatch(req.header('If-Match'))
      ?? (typeof body.expectedVersion === 'number' ? body.expectedVersion : null);
    if (expectedVersion === null) {
      sendError(res, 'PRECONDITION_REQUIRED', 'If-Match travel version is required.', 428);
      return;
    }
    try {
      const result = deleteTravelWindowIdempotently({
        userId: auth.userId,
        tenantId: auth.tenantId,
        id,
        expectedVersion,
        idempotencyKey: req.header('Idempotency-Key') ?? String(body.idempotencyKey ?? ''),
      });
      sendSuccess(res, {
        schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        state: result.replayed ? 'replayed' : result.deleted ? 'deleted' : 'already_absent',
        deleted: result.deleted,
      });
    } catch (err) {
      sendTravelMutationError(res, err);
    }
  });

  // ── A4 + R3 P1 — POST /health-intake/red-flag ──────────────────
  // Structured-intake endpoint for typed red-flag symptoms (chest
  // pain, fainting, fever, acute injury, severe RED-S risk). Writes
  // a HealthSignal with `source='structured_intake'` so the safety
  // wiring's hard-pause path becomes reachable end-to-end. The
  // wiring in /week/:weekId/reflow + /coach-analysis reads the
  // latest signal and uses `deriveSafetyTriggerFromSignal` to lift
  // the symptom into a HARD_PAUSE_TYPED_TRIGGER.
  //
  // Body shape:
  //   {
  //     date: 'YYYY-MM-DD',
  //     painScore?: 0-10, painLocation?: string,
  //     illnessSymptoms?: string[],  // 'chest_pain' | 'fever' | 'fainting' | etc.
  //     injuryStatus?: 'acute' | 'returning' | ...,
  //     energyAvailabilityRisk?: 'low' | 'moderate' | 'high',
  //     consentScope: ('pain' | 'illness' | 'injury' | 'red_s_screening')[]
  //   }
  v2.post('/health-intake/red-flag', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const auth = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = recordStructuredHealthIntake({
        userId: auth.userId,
        tenantId: auth.tenantId,
        payload: body,
        expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
        idempotencyKey: req.header('Idempotency-Key') ?? String(body.idempotencyKey ?? ''),
      });
      sendSuccess(res, {
        schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        state: result.replayed ? 'replayed' : 'created',
        intakeId: result.intake.id,
        intake: result.intake,
      }, { status: result.replayed ? 200 : 201 });
    } catch (err) {
      if (err instanceof HealthDataLifecycleError) {
        sendError(res, err.code, err.message, err.statusCode);
        return;
      }
      logger.error({ err, userId: auth.userId }, 'health_intake_red_flag.failed');
      sendError(res, 'INTERNAL', 'Failed to record structured health intake.', 500);
    }
  });

  // ── C6 — POST /week/:weekId/reflow ─────────────────────────────
  v2.post('/week/:weekId/reflow', coachV2RateLimitMiddleware, async (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const rawWeekId = resolveWeekId(req, res);
    if (rawWeekId === null) return;
    // Codex R2 P0 fix — ownership-scoped resolution.
    const owned = resolveOwnedWeek(req, res, rawWeekId);
    if (!owned) return;
    const { weekId, planId: ownedPlanId } = owned;
    const auth = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Body planId, if supplied, MUST match the owned plan derived
    // from the week. This prevents a caller from passing a foreign
    // planId in the body alongside an owned weekId.
    if (body.planId !== undefined) {
      const bodyPlanId = Number.parseInt(String(body.planId), 10);
      if (!Number.isInteger(bodyPlanId) || bodyPlanId !== ownedPlanId) {
        sendError(res, 'PLAN_WEEK_MISMATCH', 'Body planId does not match the week\'s parent plan.', 400);
        return;
      }
    }
    const planId = ownedPlanId;
    const mode = body.mode;
    if (mode !== 'preview' && mode !== 'apply') {
      sendError(res, 'BAD_MODE', "mode must be 'preview' or 'apply'.", 400);
      return;
    }
    const trigger = typeof body.trigger === 'string' ? body.trigger : 'manual_reflow';
    const previewId = typeof body.previewId === 'string' ? body.previewId.trim() : '';
    // R7 P2 fix — Codex caught that the R6 rate-limit short-circuit
    // fired BEFORE executeWeekReflow's IDEMPOTENCY_REQUIRED guard,
    // so an apply-mode call with no idempotency key + a rate-limited
    // plan returned 200 synthetic success instead of the documented
    // 400 IDEMPOTENCY_REQUIRED. Hoist the validation here so the
    // contract holds regardless of downstream short-circuits.
    //
    // Empty / whitespace-only keys are treated as missing — the
    // service-level guard at training-week-reflow.ts only rejects
    // `length === 0`, so `"   "` would otherwise slip through and
    // collide nondeterministically in the ledger's
    // `idempotency_key` column.
    const rawIdempotencyKey = typeof body.idempotencyKey === 'string'
      ? body.idempotencyKey
      : (typeof req.header('Idempotency-Key') === 'string' ? req.header('Idempotency-Key') ?? undefined : undefined);
    const trimmedIdempotencyKey =
      typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : undefined;
    const idempotencyKey =
      trimmedIdempotencyKey && trimmedIdempotencyKey.length > 0 ? trimmedIdempotencyKey : undefined;
    if (mode === 'apply' && idempotencyKey === undefined) {
      sendError(
        res,
        'IDEMPOTENCY_REQUIRED',
        "executeWeekReflow: 'apply' mode requires an idempotencyKey per the 24h dedup contract.",
        400,
      );
      return;
    }
    if (mode === 'apply' && !previewId) {
      sendError(res, 'PREVIEW_REQUIRED', 'previewId from a reviewed reflow preview is required.', 428);
      return;
    }
    const sessionsToPreserve = Array.isArray(body.sessionsToPreserve)
      ? (body.sessionsToPreserve as unknown[]).filter((v): v is number => typeof v === 'number')
      : undefined;
    const replayRequest = mode === 'apply'
      ? { previewId }
      : {
          trigger,
          sessionsToPreserve: [...new Set(sessionsToPreserve ?? [])].sort((a, b) => a - b),
        };
    if (mode === 'apply') {
      try {
        const replay = findTrainingCoachV2ProposalByIdempotency({
          tenantId: auth.tenantId,
          userId: auth.userId,
          kind: 'week_reflow',
          planId,
          weekId,
          idempotencyKey: idempotencyKey!,
          request: replayRequest,
        });
        if (replay) {
          const bound = replay.decisionId
            ? replay
            : await bindTrainingCoachV2ProposalDecision({
                tenantId: auth.tenantId,
                userId: auth.userId,
                proposalId: replay.proposalId,
              });
          sendSuccess(res, {
            schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
            outcome: 'replayed',
            planId,
            weekId,
            proposalId: bound.proposalId,
            adaptationId: null,
            decisionId: bound.decisionId,
            proposal: bound,
            scenario: null,
            sciencePolicyVersion: null,
          });
          return;
        }
      } catch (err) {
        if (err instanceof TrainingCoachV2ProposalConflictError) {
          sendError(res, 'IDEMPOTENCY_CONFLICT', err.message, 409);
          return;
        }
        throw err;
      }
    }
    if (mode === 'apply') {
      try {
        const material = getTrainingCoachV2ReflowPreview({
          tenantId: auth.tenantId,
          userId: auth.userId,
          planId,
          weekId,
          previewId,
        });
        const current = getDb().prepare(`
          SELECT COALESCE(adaptation_revision, 0) AS adaptationRevision
            FROM fitness_training_plans
           WHERE id = ? AND tenant_id = ? AND user_id = ?
        `).get(planId, auth.tenantId, auth.userId) as { adaptationRevision: number } | undefined;
        if (!current || current.adaptationRevision !== material.preview.expectedVersion) {
          sendError(
            res,
            'PREVIEW_VERSION_CHANGED',
            'The plan changed after this preview. Create and review a new preview.',
            412,
          );
          return;
        }
        const created = createTrainingCoachV2Proposal({
          tenantId: auth.tenantId,
          userId: auth.userId,
          kind: 'week_reflow',
          planId,
          weekId,
          expectedVersion: material.preview.expectedVersion,
          request: material.request,
          evidence: material.evidence,
          replayRequest,
          previewId,
          idempotencyKey: idempotencyKey!,
        });
        const boundProposal = await bindTrainingCoachV2ProposalDecision({
          tenantId: auth.tenantId,
          userId: auth.userId,
          proposalId: created.proposal.proposalId,
        });
        sendSuccess(res, {
          schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
          outcome: created.replayed ? 'replayed' : 'proposal_created',
          planId,
          weekId,
          previewId,
          proposalId: created.proposal.proposalId,
          adaptationId: null,
          decisionId: boundProposal.decisionId,
          proposal: boundProposal,
          scenario: material.evidence.scenario ?? null,
          sciencePolicyVersion: material.evidence.sciencePolicyVersion ?? null,
        }, { status: created.replayed ? 200 : 202 });
        return;
      } catch (err) {
        if (err instanceof TrainingCoachV2ProposalConflictError) {
          sendError(res, 'IDEMPOTENCY_CONFLICT', err.message, 409);
          return;
        }
        if (err instanceof TrainingCoachV2ReflowPreviewError) {
          sendError(res, err.code, err.message, err.statusCode);
          return;
        }
        if (err instanceof TrainingCoachV2ProposalStateError) {
          const status = err.code === 'REFLOW_PREVIEW_UNAVAILABLE' ? 410 : 400;
          sendError(res, err.code, err.message, status);
          return;
        }
        throw err;
      }
    }
    const knowledge = loadCoachKnowledge();
    const principles = knowledge.principles;
    const sciencePolicyVersion = getSciencePolicyVersion(principles);
    try {
      // Codex R2 P1 fix — compute the CoachAction[] for the week
      // here so apply mode actually mutates something. The classifier
      // takes (sessions, conditions, weekIntent + safetyOutput) and
      // returns typed actions; we hydrate each input from real DB
      // state, not hardcoded placeholders.
      const db = getDb();
      const planMeta = db.prepare(`
        SELECT id, user_id, start_date, duration_weeks, sport,
               COALESCE(plan_version, 1) AS plan_version,
               COALESCE(adaptation_revision, 0) AS adaptation_revision
        FROM fitness_training_plans WHERE id = ?
      `).get(planId) as {
        id: number;
        user_id: number;
        start_date: string;
        duration_weeks: number;
        sport: string;
        plan_version: number;
        adaptation_revision: number;
      };

      const weekRow = db.prepare(
        'SELECT week_number FROM training_weeks WHERE id = ? AND plan_id = ?',
      ).get(weekId, planId) as { week_number: number } | undefined;
      const weekNumber = weekRow?.week_number ?? 1;
      const weekIndex = Math.max(0, weekNumber - 1);

      const sessionsRows = db.prepare(`
        SELECT id, day_of_week, session_type, title, duration_minutes, intensity_text, status
        FROM training_sessions WHERE week_id = ? AND plan_id = ?
      `).all(weekId, planId) as Array<{
        id: number; day_of_week: string; session_type: string; title: string;
        duration_minutes: number; intensity_text: string; status: string;
      }>;

      // R3 P1 fix — only actionable sessions (pending/scheduled) are
      // candidates for classifier-driven mutation. Completed / skipped
      // / moved rows are athlete history and MUST NOT be rewritten by
      // an apply reflow.
      //
      // R4 P2 fix — route the check through the canonical
      // `isActionableSessionStatus` predicate from session-status.ts
      // so any change to the allowlist propagates here automatically.
      const actionableRows = sessionsRows.filter((s) =>
        isActionableSessionStatus(s.status),
      );
      const sessions: Session[] = actionableRows.map((s) =>
        dbRowToSession(s as DbSessionRow, planMeta.sport),
      );
      // Codex R2 P1 — pull real race calendar + level from the plan
      // row's preferences_json (when present); the resolver consumes
      // both to pick a race-aware mesocycle template.
      const planFull = db.prepare(
        'SELECT preferences_json FROM fitness_training_plans WHERE id = ?',
      ).get(planId) as { preferences_json: string | null };
      const reflowSyncTarget = resolvePersistedTrainingReflowSyncTarget(
        planFull.preferences_json,
      );
      let persistedSchedulingTimezone: string | null = null;
      try {
        const parsedPreferences = planFull.preferences_json
          ? JSON.parse(planFull.preferences_json) as Record<string, unknown>
          : {};
        persistedSchedulingTimezone = typeof parsedPreferences.schedulingTimezone === 'string'
          ? parsedPreferences.schedulingTimezone
          : null;
      } catch {
        persistedSchedulingTimezone = null;
      }
      const schedulingTimezone = resolveTrainingTimezone(
        persistedSchedulingTimezone ?? getUserTimezoneById(auth.userId),
      );
      // R5 P3 fix — Codex caught that reflow used the legacy wrapper
      // that discards the drop report, while coach-analysis used the
      // `WithReport` variant. So a mutating apply could silently drop
      // invalid or over-capped race entries without operator visibility.
      // Switch reflow to the report variant + emit the same warn log
      // coach-analysis does. Drops aren't surfaced on the apply
      // response payload (iOS gets that detail from /coach-analysis),
      // but operators get the full audit trail.
      const reflowRaceCalendarReport = resolveRaceCalendarFromPlanWithReport(planFull.preferences_json);
      const raceCalendar = reflowRaceCalendarReport.races;
      if (reflowRaceCalendarReport.droppedCount > 0 || reflowRaceCalendarReport.capApplied) {
        logger.warn(
          {
            planId,
            scope: 'reflow',
            droppedCount: reflowRaceCalendarReport.droppedCount,
            dropReasons: reflowRaceCalendarReport.dropReasons,
            capApplied: reflowRaceCalendarReport.capApplied,
            capTruncatedCount: reflowRaceCalendarReport.capTruncatedCount,
          },
          'race_calendar.entries_dropped_on_resolve',
        );
      }
      const weekIntent = resolveWeekIntent({
        weekStartISODate: new Date(
          Date.parse(planMeta.start_date) + weekIndex * 7 * 24 * 3600 * 1000,
        ).toISOString().slice(0, 10),
        raceCalendar,
        principles,
      });

      // A4 safety wiring — R3 P1 fix: derive {source, triggerType}
      // from the signal so a structured intake row can actually emit
      // a hard pause. Previously hardcoded `source: 'wearable'` made
      // every signal degrade to warning-only.
      const safetyOutput = getEffectiveHealthSafetyOutput({
        userId: auth.userId,
        tenantId: auth.tenantId,
        db,
      });

      // R4 P1 fix — reflow now hydrates the SAME aggregated week
      // conditions as coach-analysis (travel, gap, adherence, missed
      // sessions, deload). Before this fix, the reflow's
      // weekConditions was a bare `{ weekIndex }` so travel /
      // return-from-gap / missed-session / low-adherence policies
      // were unreachable through the mutating route — they showed
      // in analysis but never in apply.
      const reflowAsOfISODate = new Date().toISOString();
      const reflowMissed = detectMissedSessions({
        userId: auth.userId,
        tenantId: auth.tenantId,
        asOfISODate: reflowAsOfISODate,
      }).filter((s) => s.planId === planId);
      const reflowGap = detectTrainingGap({
        userId: auth.userId,
        tenantId: auth.tenantId,
        asOfISODate: reflowAsOfISODate,
      });
      const reflowAdherence = computeAdherenceTrend(auth.userId, auth.tenantId, reflowAsOfISODate);
      const reflowWeekStart = new Date(
        Date.parse(planMeta.start_date) + weekIndex * 7 * 24 * 3600 * 1000,
      ).toISOString().slice(0, 10);
      const reflowWeekEnd = new Date(
        Date.parse(planMeta.start_date) + (weekIndex + 1) * 7 * 24 * 3600 * 1000 - 1,
      ).toISOString().slice(0, 10);
      const reflowTravelWindows = findTravelWindowsInRange(
        auth.userId,
        reflowWeekStart,
        reflowWeekEnd,
        auth.tenantId,
      );
      // R5 P1 fix — Codex caught that reflow passed `deloadDue: undefined`
      // while coach-analysis passed the real `deload.triggered`. The
      // classifier only consumes `weekConditions.deloadDue`, so reflow
      // could not surface a deload modifier even when the load model
      // said one was due. Use the shared
      // `computeLoadModelAndDeload` helper so both routes agree.
      const reflowLevelInfo = resolveAthleteLevelFromPlan((db.prepare(
        'SELECT preferences_json FROM fitness_training_plans WHERE id = ?',
      ).get(planId) as { preferences_json: string | null }).preferences_json);
      const reflowMeso = resolveMesocyclePlan({
        startDate: planMeta.start_date,
        totalWeeks: planMeta.duration_weeks,
        level: reflowLevelInfo.level,
        raceCalendar,
        principles,
      });
      const reflowDeloadResult = computeLoadModelAndDeload({
        db,
        userId: auth.userId,
        tenantId: auth.tenantId,
        planSport: planMeta.sport,
        weeksSinceDeload: weekIndex,
        scheduledDeloadCadenceWeeks: reflowMeso.mesocycleLength,
        principles,
      });
      const weekConditions = aggregateWeekConditions({
        weekIndex,
        missedSessionSignals: reflowMissed,
        travelWindows: reflowTravelWindows,
        gapSignal: reflowGap,
        adherenceTrend: reflowAdherence,
        // R5 P1 fix — real deload signal flows here.
        deloadDue: reflowDeloadResult.deload.triggered,
      });

      const policy = getCoachPlanPolicy(planId);
      // R5 P1 fix — Codex caught that we passed the rate-limit
      // *thresholds* without the recent *counts*, so the limiter
      // defaulted to 0 and never tripped. Hydrate the counts from
      // the ledger so the limit is actually enforced.
      const reflowCount24h = countNonSafetyAppliedAdaptations(planId, 24);
      const reflowCount7d = countNonSafetyAppliedAdaptations(planId, 24 * 7);
      const scenario = classifyTrainingScenario({
        sessions,
        weekConditions,
        weekIntent,
        safetyOutput,
        recentReflowCount24h: reflowCount24h,
        recentReflowCount7d: reflowCount7d,
        adaptationRateLimitPerDay: policy?.adaptationRateLimits?.perDay,
        adaptationRateLimitPerWeek: policy?.adaptationRateLimits?.perWeek,
        principles,
      });

      // Manual reflow is proposal-first for both compatibility and revision
      // plans. Preview computes deterministic actions only; proposal creation
      // persists evidence but never updates sessions or adaptation_revision.
      // Decision Center later activates under an explicit `adapt` lock.
      if (scenario.rateLimited) {
        sendSuccess(res, {
          schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
          outcome: 'rate_limited',
          planId,
          weekId,
          proposalId: null,
          adaptationId: null,
          scenario,
          sciencePolicyVersion,
        });
        return;
      }
      if (scenario.actions.length === 0) {
        sendSuccess(res, {
          schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
          outcome: 'no_changes',
          planId,
          weekId,
          proposalId: null,
          adaptationId: null,
          scenario,
          sciencePolicyVersion,
        });
        return;
      }
      if (mode === 'preview') {
        const preview = createTrainingCoachV2ReflowPreview({
          tenantId: auth.tenantId,
          userId: auth.userId,
          planId,
          weekId,
          expectedVersion: planMeta.adaptation_revision,
          request: {
            trigger,
            sessionsToPreserve: sessionsToPreserve ?? [],
            actions: scenario.actions,
            schedulingTimezone,
            syncTarget: reflowSyncTarget,
          },
          evidence: {
            schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
            sciencePolicyVersion,
            reasonCodes: scenario.actions.map((action) => action.reasonCode),
            planVersion: planMeta.plan_version,
            scenario,
          },
        });
        sendSuccess(res, {
          schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
          outcome: 'preview',
          planId,
          weekId,
          previewId: preview.preview.previewId,
          previewExpiresAt: preview.preview.expiresAt,
          proposalId: null,
          adaptationId: null,
          expectedVersion: planMeta.adaptation_revision,
          actions: scenario.actions,
          scenario,
          sciencePolicyVersion,
        });
        return;
      }
    } catch (err) {
      if (err instanceof TrainingCoachV2ProposalConflictError) {
        sendError(res, 'IDEMPOTENCY_CONFLICT', err.message, 409);
        return;
      }
      if (err instanceof TrainingCoachV2ProposalStateError) {
        sendError(res, err.code, err.message, err.code === 'IDEMPOTENCY_REQUIRED' ? 428 : 400);
        return;
      }
      const lockError = trainingOperationLockPublicError(err);
      if (lockError) {
        res.setHeader('Retry-After', String(lockError.retryAfterSeconds));
        sendError(res, lockError.code, lockError.message, lockError.status, lockError.details);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) {
        sendError(res, 'WEEK_NOT_FOUND', message, 404);
        return;
      }
      logger.error({ err, planId, weekId }, 'week_reflow.failed');
      sendError(res, 'INTERNAL', 'Failed to execute reflow.', 500);
    }
  });

  // ── A5 — GET /plans/:planId/coach-policy ───────────────────────
  v2.get('/plans/:planId/coach-policy', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const rawPlanId = resolvePlanId(req, res);
    if (rawPlanId === null) return;
    // Codex R2 P0 fix — ownership-scoped read.
    const owned = resolveOwnedPlan(req, res, rawPlanId);
    if (!owned) return;
    const snapshot = getCoachPlanPolicySnapshot(owned.planId);
    if (!snapshot) {
      sendError(res, 'PLAN_NOT_FOUND', `Plan ${owned.planId} not found.`, 404);
      return;
    }
    res.setHeader('ETag', snapshot.etag);
    sendSuccess(res, {
      schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
      planId: owned.planId,
      version: snapshot.version,
      policy: snapshot.policy,
    });
  });

  // ── A5 — PATCH /plans/:planId/coach-policy ─────────────────────
  v2.patch('/plans/:planId/coach-policy', coachV2RateLimitMiddleware, async (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const rawPlanId = resolvePlanId(req, res);
    if (rawPlanId === null) return;
    // Codex R2 P0 fix — ownership-scoped write.
    const owned = resolveOwnedPlan(req, res, rawPlanId);
    if (!owned) return;
    const planId = owned.planId;
    const auth = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const expectedVersion = parseCoachPolicyIfMatch(req.header('If-Match'))
        ?? (typeof body.expectedVersion === 'number' ? body.expectedVersion : null);
      if (expectedVersion === null) {
        sendError(res, 'PRECONDITION_REQUIRED', 'If-Match coach policy version is required.', 428);
        return;
      }
      const idempotencyKey = req.header('Idempotency-Key') ?? String(body.idempotencyKey ?? '');
      if (!idempotencyKey.trim()) {
        sendError(res, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required for coach policy proposals.', 428);
        return;
      }
      const ignoredKeys = new Set(['expectedVersion', 'idempotencyKey']);
      const patch = Object.fromEntries(Object.entries(body).filter(([key]) => !ignoredKeys.has(key)));
      const replayRequest = { expectedVersion, patch };
      const replay = findTrainingCoachV2ProposalByIdempotency({
        tenantId: auth.tenantId,
        userId: auth.userId,
        kind: 'coach_policy',
        planId,
        weekId: null,
        idempotencyKey,
        request: replayRequest,
      });
      if (replay) {
        const bound = replay.decisionId
          ? replay
          : await bindTrainingCoachV2ProposalDecision({
              tenantId: auth.tenantId,
              userId: auth.userId,
              proposalId: replay.proposalId,
            });
        sendSuccess(res, {
          schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
          outcome: 'replayed',
          proposal: bound,
          decisionId: bound.decisionId,
        });
        return;
      }
      const current = getCoachPlanPolicySnapshot(planId)!;
      if (current.version !== expectedVersion) {
        sendError(res, 'VERSION_CONFLICT', 'Coach policy version does not match If-Match.', 412);
        return;
      }
      const proposed = previewCoachPlanPolicyPatch(planId, patch);
      const proposal = createTrainingCoachV2Proposal({
        tenantId: auth.tenantId,
        userId: auth.userId,
        kind: 'coach_policy',
        planId,
        expectedVersion,
        request: { patch, proposedPolicy: proposed.policy },
        evidence: {
          source: 'explicit_user_request',
          currentPolicyVersion: current.version,
          currentPolicy: current.policy,
          schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        },
        replayRequest,
        idempotencyKey,
      });
      const boundProposal = await bindTrainingCoachV2ProposalDecision({
        tenantId: auth.tenantId,
        userId: auth.userId,
        proposalId: proposal.proposal.proposalId,
      });
      sendSuccess(res, {
        schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        outcome: proposal.replayed ? 'replayed' : 'proposal_created',
        proposal: boundProposal,
        decisionId: boundProposal.decisionId,
        currentPolicy: current.policy,
        proposedPolicy: proposed.policy,
      }, { status: proposal.replayed ? 200 : 202 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TrainingCoachV2ProposalConflictError) {
        sendError(res, 'IDEMPOTENCY_CONFLICT', message, 409);
        return;
      }
      if (err instanceof TrainingCoachV2ProposalStateError) {
        sendError(res, err.code, message, err.code === 'IDEMPOTENCY_REQUIRED' ? 428 : 400);
        return;
      }
      if (/does not exist/i.test(message)) {
        sendError(res, 'PLAN_NOT_FOUND', `Plan ${planId} not found.`, 404);
        return;
      }
      if (/Invalid|non-negative/i.test(message)) {
        sendError(res, 'BAD_INPUT', message, 400);
        return;
      }
      logger.error({ err, planId }, 'coach_plan_policy.write_failed');
      sendError(res, 'INTERNAL', 'Failed to update coach plan policy.', 500);
    }
  });

  // ── GET /plans/:planId/coach-analysis ──────────────────────────
  // Read-only end-to-end coach analysis. Composes B3 mesocycle + B2
  // WeekIntent + A2b intensity profiles + B5 deload recommendation
  // + B7 taper + C7 aggregator + C8 scenario classifier. Production
  // caller for every remaining v2 service that the route layer
  // hadn't previously exercised — Codex P1 closure.
  v2.get('/plans/:planId/coach-analysis', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const rawPlanId = resolvePlanId(req, res);
    if (rawPlanId === null) return;
    // Codex R2 P0 fix — unified ownership check.
    const owned = resolveOwnedPlan(req, res, rawPlanId);
    if (!owned) return;
    const planId = owned.planId;
    const auth = req as AuthenticatedRequest;
    const weekIndex = Number.parseInt(typeof req.query.weekIndex === 'string' ? req.query.weekIndex : '0', 10);
    if (!Number.isInteger(weekIndex) || weekIndex < 0) {
      sendError(res, 'BAD_WEEK_INDEX', 'weekIndex must be a non-negative integer.', 400);
      return;
    }

    try {
      const db = getDb();
      const plan = db.prepare(`
        SELECT id, user_id, start_date, duration_weeks, sport
        FROM fitness_training_plans WHERE id = ?
      `).get(planId) as
        | { id: number; user_id: number; start_date: string; duration_weeks: number; sport: string }
        | undefined;
      if (!plan) {
        sendError(res, 'PLAN_NOT_FOUND', `Plan ${planId} not found.`, 404);
        return;
      }

      const knowledge = loadCoachKnowledge();
      const principles = knowledge.principles;
      const sciencePolicyVersion = getSciencePolicyVersion(principles);

      // Codex R2 P1 — resolve real athlete level + race calendar from
      // the plan's preferences_json (when present). Falls back to
      // 'intermediate' with `inferred: true` surfaced in the response
      // so callers (and tests) can pin whether a default was used.
      const planFull = db.prepare(
        'SELECT preferences_json FROM fitness_training_plans WHERE id = ?',
      ).get(planId) as { preferences_json: string | null };
      const levelInfo = resolveAthleteLevelFromPlan(planFull.preferences_json);
      // R4 P3 fix — surface race-calendar drops + cap reasons on the
      // response. Previously the resolver silently dropped invalid /
      // unknown entries; users / support had no signal explaining
      // "why doesn't my race show up?". The report exposes the count
      // + per-reason breakdown.
      const raceCalendarReport = resolveRaceCalendarFromPlanWithReport(planFull.preferences_json);
      const raceCalendar = raceCalendarReport.races;
      if (raceCalendarReport.droppedCount > 0 || raceCalendarReport.capApplied) {
        logger.warn(
          {
            planId,
            droppedCount: raceCalendarReport.droppedCount,
            dropReasons: raceCalendarReport.dropReasons,
            capApplied: raceCalendarReport.capApplied,
            capTruncatedCount: raceCalendarReport.capTruncatedCount,
          },
          'race_calendar.entries_dropped_on_resolve',
        );
      }

      // Mesocycle resolution (B3 → B2 → B2a chained).
      const meso = resolveMesocyclePlan({
        startDate: plan.start_date,
        totalWeeks: plan.duration_weeks,
        level: levelInfo.level,
        raceCalendar,
        principles,
      });
      if (weekIndex >= meso.weeks.length) {
        sendError(res, 'WEEK_OUT_OF_RANGE', `weekIndex ${weekIndex} is outside this plan's ${meso.weeks.length} week range.`, 400, {
          reason: 'week_out_of_range',
          requestedWeekIndex: weekIndex,
          maxWeekIndex: Math.max(0, meso.weeks.length - 1),
        });
        return;
      }
      const safeWeekIndex = weekIndex;
      const weekNumber = safeWeekIndex + 1;
      const weekIdentity = db.prepare(`
        SELECT id FROM training_weeks WHERE plan_id = ? AND week_number = ?
      `).get(planId, weekNumber) as { id: number } | undefined;
      const weekIntent = meso.weeks[safeWeekIndex];

      // Build intensity profiles for the week's sessions (A2b).
      const sessionsRows = db.prepare(`
        SELECT s.id, s.day_of_week, s.session_type, s.title, s.duration_minutes,
               s.intensity_text, s.status
        FROM training_weeks w
        JOIN training_sessions s ON s.week_id = w.id
        WHERE w.plan_id = ? AND w.week_number = ?
      `).all(planId, safeWeekIndex + 1) as Array<{
        id: number;
        day_of_week: string;
        session_type: string;
        title: string;
        duration_minutes: number;
        intensity_text: string;
        status: string;
      }>;

      // Codex R2 P1 fix — real hydration, not cosmetic placeholder.
      const sessions: Session[] = sessionsRows.map((s) =>
        dbRowToSession(s as DbSessionRow, plan.sport),
      );

      // Per-session intensity profiles (A2b) — defensive: anchors
      // may be missing for an athlete with no FTP/T-pace recorded,
      // in which case estimatedLoad is undefined and skipped.
      const intensityProfiles = sessions.map((s) => ({
        sessionId: s.id,
        profile: buildSessionIntensityProfile(
          {
            id: s.sourceTemplateId ?? 'inline',
            sport: s.sport,
            sessionType: s.sessionType,
            title: s.title,
            phaseTags: [],
            goalTags: [],
            durationOptionsMinutes: [s.durationMinutes],
            primaryZone: s.intensityZone,
            fatigueCost: s.fatigueCost,
            keySession: s.keySession,
            instructions: [],
            constraints: [],
          },
          s.durationMinutes,
          {},
        ),
      }));

      // Gap detector (C4) + adherence trend (C5) + missed sweep (C1).
      const asOfISODate = new Date().toISOString();
      const gapSignal = detectTrainingGap({ userId: auth.userId, tenantId: auth.tenantId, asOfISODate });
      const adherence = computeAdherenceTrend(auth.userId, auth.tenantId, asOfISODate);
      const missed = detectMissedSessions({ userId: auth.userId, tenantId: auth.tenantId, asOfISODate });

      // Travel windows for the week start.
      const weekStart = new Date(Date.parse(plan.start_date) + safeWeekIndex * 7 * 24 * 3600 * 1000)
        .toISOString().slice(0, 10);
      const weekEnd = new Date(Date.parse(plan.start_date) + (safeWeekIndex + 1) * 7 * 24 * 3600 * 1000 - 1)
        .toISOString().slice(0, 10);
      const travelWindows = findTravelWindowsInRange(auth.userId, weekStart, weekEnd, auth.tenantId);

      // R3/R4/R5 — load model + deload via shared helper.
      // Codex R5 P1 #3 + P2 #7 collapsed two prior inline copies of
      // this logic (one missing tonnage from V2 JSON, one missing
      // entirely from reflow). Single source of truth in
      // `training-coach-v2-load-helper.ts` now drives both routes.
      const loadResult = computeLoadModelAndDeload({
        db,
        userId: auth.userId,
        tenantId: auth.tenantId,
        planSport: plan.sport,
        weeksSinceDeload: safeWeekIndex,
        scheduledDeloadCadenceWeeks: meso.mesocycleLength,
        principles,
      });
      const loadModelByDimension = loadResult.loadModelByDimension;
      const primaryDim = loadResult.primaryDim;
      const loadModel = loadResult.loadModel;
      const deload = loadResult.deload;

      // Taper decision (B7) when a future race is near. Codex R2 P1
      // fix — use the REAL race calendar resolved above, not an
      // empty array.
      let taperDecision: ReturnType<typeof decideTaper> | null = null;
      const next = findNextRace(raceCalendar, weekStart);
      if (next) {
        const dtr = daysToRace(next, weekStart);
        if (dtr !== undefined && dtr >= 0) {
          taperDecision = decideTaper(
            { daysToRace: dtr, priority: normalizeRacePriority(next.priority) },
            principles,
          );
        }
      }

      // Codex R2 P1 fix — wire A4 safety end-to-end. Load the latest
      // consented HealthSignal and run it through the safety wiring;
      // the resulting safetyOutput is what makes C8's hard-pause
      // path actually reachable from the runtime endpoint.
      const safetyOutput = getEffectiveHealthSafetyOutput({
        userId: auth.userId,
        tenantId: auth.tenantId,
        db,
      });

      // Aggregate conditions (C7).
      const weekConditions = aggregateWeekConditions({
        weekIndex: safeWeekIndex,
        missedSessionSignals: missed,
        travelWindows,
        gapSignal,
        adherenceTrend: adherence,
        deloadDue: deload.triggered,
      });

      // Scenario classifier + CoachAction grammar (C8).
      const policy = getCoachPlanPolicy(planId);
      // R5 P1 fix — same as reflow path: hydrate the recent counts
      // so the anti-churn limiter actually fires.
      const analysisReflowCount24h = countNonSafetyAppliedAdaptations(planId, 24);
      const analysisReflowCount7d = countNonSafetyAppliedAdaptations(planId, 24 * 7);
      const scenario = classifyTrainingScenario({
        sessions,
        weekConditions,
        weekIntent,
        safetyOutput,
        recentReflowCount24h: analysisReflowCount24h,
        recentReflowCount7d: analysisReflowCount7d,
        adaptationRateLimitPerDay: policy?.adaptationRateLimits?.perDay,
        adaptationRateLimitPerWeek: policy?.adaptationRateLimits?.perWeek,
        principles,
      });

      sendSuccess(res, {
        schemaVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
        planId,
        weekId: weekIdentity?.id ?? null,
        weekIndex: safeWeekIndex,
        weekNumber,
        generatedAt: new Date().toISOString(),
        sciencePolicyVersion,
        athleteLevel: { level: levelInfo.level, inferred: levelInfo.inferred },
        raceCalendar,
        // R4 P3 — drop accounting surfaced so iOS / support can
        // detect partial acceptance + render an explanation.
        raceCalendarDrops: {
          droppedCount: raceCalendarReport.droppedCount,
          dropReasons: raceCalendarReport.dropReasons,
          capApplied: raceCalendarReport.capApplied,
          capTruncatedCount: raceCalendarReport.capTruncatedCount,
        },
        mesocycle: {
          blockTemplateName: meso.blockTemplateName,
          blockTemplate: meso.blockTemplate,
          mesocycleLength: meso.mesocycleLength,
        },
        weekIntent,
        intensityProfiles,
        loadModel,
        // R4 P1 — surface the per-dimension load models so iOS /
        // tests / downstream slices can verify the multi-dimensional
        // separation actually held (previously collapsed to one external scalar).
        loadModelByDimension,
        loadModelPrimaryDimension: primaryDim,
        deloadRecommendation: deload,
        taperDecision,
        weekConditions,
        scenario,
        explanations: buildPrivacySafeCoachExplanations({
          weekNumber,
          scenario,
          hasSafetyOverride: safetyOutput?.effectiveSeverity === 'block',
          hasTravel: travelWindows.length > 0,
        }),
      });
    } catch (err) {
      logger.error({ err, planId, weekIndex }, 'coach_analysis.failed');
      sendError(res, 'INTERNAL', 'Failed to build coach analysis.', 500);
    }
  });

  // Mount the sub-router at the root so route paths stay `/week/...`
  // and `/plans/...` (matching the plan v2.1 contract).
  parent.use('/', v2);
  return parent;
}
