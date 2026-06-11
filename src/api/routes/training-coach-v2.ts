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

import { Router, type Response, type Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import type { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError } from '../response-helpers';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import {
  getCoachPlanPolicy,
  setCoachPlanPolicy,
} from '../../services/coach-plan-policy';
import {
  ReflowMissingIdempotencyKeyError,
  executeWeekReflow,
} from '../../services/training-week-reflow';
import { recordTravelWindow, findTravelWindowsInRange } from '../../services/travel-windows';
import { recordHealthSignal, type HealthConsentScope, type InjuryStatus, type EnergyAvailabilityRisk } from '../../services/health-signals';
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
import { getLatestHealthSignal } from '../../services/health-signals';
import {
  deriveSafetyTriggerFromSignal,
  wireHealthSignalToSafety,
} from '../../services/coach-kernel/safety-wiring';
import { hashOwnerIdForLog } from './_ownership-audit';
import { isStrictIsoDate } from '../../services/training-date-utils';
import {
  dbRowToSession,
  inferSportFromSessionType,
  resolveAthleteLevelFromPlan,
  resolveRaceCalendarFromPlanWithReport,
  type DbSessionRow,
} from './training-coach-v2-hydration';
import { requireTenantIdParam } from '../../services/tenant-scope';

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
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.', retryAfter },
      });
    },
  });

  // ── C2 — POST /week/travel ─────────────────────────────────────
  v2.post('/week/travel', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const auth = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const startDate = typeof body.startDate === 'string' ? body.startDate : '';
    const endDate = typeof body.endDate === 'string' ? body.endDate : '';
    if (!startDate || !endDate) {
      sendError(res, 'BAD_INPUT', 'startDate and endDate are required (ISO 8601).', 400);
      return;
    }
    // R4 P2 fix — same strict YYYY-MM-DD gate the red-flag endpoint
    // now applies. The travel-window writer feeds these into indexed
    // SQLite columns, so we must reject "tomorrow", "2026-13-01",
    // and injection-shaped strings before they reach the writer.
    if (!isStrictIsoDate(startDate)) {
      sendError(res, 'BAD_INPUT', 'startDate must be a valid YYYY-MM-DD calendar date.', 400);
      return;
    }
    if (!isStrictIsoDate(endDate)) {
      sendError(res, 'BAD_INPUT', 'endDate must be a valid YYYY-MM-DD calendar date.', 400);
      return;
    }
    if (endDate < startDate) {
      // Lexicographic comparison is valid on strict YYYY-MM-DD.
      sendError(res, 'BAD_INPUT', 'endDate must be on or after startDate.', 400);
      return;
    }
    try {
      const result = recordTravelWindow({
        userId: auth.userId,
        startDate,
        endDate,
        equipmentProfile: typeof body.equipmentProfile === 'string' ? body.equipmentProfile : undefined,
        timeZoneShiftHours: typeof body.timeZoneShiftHours === 'number' ? body.timeZoneShiftHours : undefined,
        flightDurationHours: typeof body.flightDurationHours === 'number' ? body.flightDurationHours : undefined,
        sleepDisruptionExpected: body.sleepDisruptionExpected === true,
        walkingLoadExpected: body.walkingLoadExpected === true,
        heatStress: body.heatStress === true,
        availableSessionDurationMinutes:
          typeof body.availableSessionDurationMinutes === 'number' ? body.availableSessionDurationMinutes : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      });
      sendSuccess(res, { id: result.id }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('startDate')) {
        sendError(res, 'BAD_INPUT', message, 400);
        return;
      }
      logger.error({ err, userId: auth.userId }, 'travel_window.write_failed');
      sendError(res, 'INTERNAL', 'Failed to record travel window.', 500);
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
    const date = typeof body.date === 'string' ? body.date : '';
    if (!date) {
      sendError(res, 'BAD_INPUT', 'date is required (ISO YYYY-MM-DD).', 400);
      return;
    }
    // R4 P2 fix — Codex caught that the prior validation accepted
    // any non-empty string (e.g. "tomorrow", "2026-13-99",
    // "1970-01-01' OR 1=1"). The DB write feeds `date` straight into
    // an indexed column, so we must reject anything that doesn't
    // round-trip as a real calendar date in YYYY-MM-DD form. Strict
    // regex + UTC Date round-trip rules out bogus months/days,
    // bracketed Date strings, and timezone-suffixed inputs.
    if (!isStrictIsoDate(date)) {
      sendError(res, 'BAD_INPUT', 'date must be a valid YYYY-MM-DD calendar date.', 400);
      return;
    }
    const consentScopeRaw = Array.isArray(body.consentScope) ? body.consentScope : [];
    const consentScope = consentScopeRaw.filter((s): s is HealthConsentScope =>
      s === 'pain' || s === 'illness' || s === 'injury' || s === 'menstrual' || s === 'red_s_screening',
    );
    if (consentScope.length === 0) {
      sendError(res, 'BAD_INPUT', 'consentScope must include at least one of pain/illness/injury/red_s_screening.', 400);
      return;
    }
    try {
      const result = recordHealthSignal({
        userId: auth.userId,
        tenantId: auth.tenantId,
        date,
        painScore: typeof body.painScore === 'number' ? body.painScore : undefined,
        painLocation: typeof body.painLocation === 'string' ? body.painLocation : undefined,
        illnessSymptoms: Array.isArray(body.illnessSymptoms)
          ? (body.illnessSymptoms as unknown[]).filter((v): v is string => typeof v === 'string')
          : undefined,
        injuryStatus: typeof body.injuryStatus === 'string' && (
          body.injuryStatus === 'none' || body.injuryStatus === 'acute' ||
          body.injuryStatus === 'chronic_managed' || body.injuryStatus === 'returning' ||
          body.injuryStatus === 'post_exertional_symptom_risk'
        ) ? body.injuryStatus as InjuryStatus : undefined,
        energyAvailabilityRisk: typeof body.energyAvailabilityRisk === 'string' && (
          body.energyAvailabilityRisk === 'low' || body.energyAvailabilityRisk === 'moderate' ||
          body.energyAvailabilityRisk === 'high'
        ) ? body.energyAvailabilityRisk as EnergyAvailabilityRisk : undefined,
        // R3 P1 — the canonical `structured_intake` marker that the
        // safety derivation reads. Without this, A4 hard-pause is
        // unreachable from the runtime endpoint.
        source: 'structured_intake',
        consentScope,
      });
      sendSuccess(res, { id: result.id, droppedFields: result.droppedFields }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/empty|consentScope|no fields/.test(message)) {
        sendError(res, 'BAD_INPUT', message, 400);
        return;
      }
      logger.error({ err, userId: auth.userId }, 'health_intake_red_flag.failed');
      sendError(res, 'INTERNAL', 'Failed to record structured health intake.', 500);
    }
  });

  // ── C6 — POST /week/:weekId/reflow ─────────────────────────────
  v2.post('/week/:weekId/reflow', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const rawWeekId = resolveWeekId(req, res);
    if (rawWeekId === null) return;
    // Codex R2 P0 fix — ownership-scoped resolution.
    const owned = resolveOwnedWeek(req, res, rawWeekId);
    if (!owned) return;
    const { weekId, planId: ownedPlanId } = owned;
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
    const sessionsToPreserve = Array.isArray(body.sessionsToPreserve)
      ? (body.sessionsToPreserve as unknown[]).filter((v): v is number => typeof v === 'number')
      : undefined;
    const knowledge = loadCoachKnowledge();
    const principles = knowledge.principles;
    const sciencePolicyVersion = getSciencePolicyVersion(principles);
    const auth = req as AuthenticatedRequest;

    try {
      // Codex R2 P1 fix — compute the CoachAction[] for the week
      // here so apply mode actually mutates something. The classifier
      // takes (sessions, conditions, weekIntent + safetyOutput) and
      // returns typed actions; we hydrate each input from real DB
      // state, not hardcoded placeholders.
      const db = getDb();
      const planMeta = db.prepare(`
        SELECT id, user_id, start_date, duration_weeks, sport
        FROM fitness_training_plans WHERE id = ?
      `).get(planId) as { id: number; user_id: number; start_date: string; duration_weeks: number; sport: string };

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
      const healthSignal = getLatestHealthSignal(auth.userId, auth.tenantId);
      const safetyOutput = healthSignal
        ? (() => {
            // R8 P2-11 — single decode at the route boundary
            // narrows enum fields + parses illness JSON once, with
            // logger.warn-rejects for unknown values. The two
            // downstream consumers (deriveSafetyTriggerFromSignal,
            // wireHealthSignalToSafety) see typed inputs only.
            const decoded = decodeHealthSignalRow(healthSignal);
            const trig = deriveSafetyTriggerFromSignal({
              source: decoded.source,
              illnessSymptoms: decoded.illnessSymptoms,
              injuryStatus: decoded.injuryStatus,
              energyAvailabilityRisk: decoded.energyAvailabilityRisk,
              painScore: decoded.painScore,
              painLocation: decoded.painLocation,
            });
            return wireHealthSignalToSafety({
              signal: decoded,
              source: trig.source,
              triggerType: trig.triggerType,
            });
          })()
        : undefined;

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

      // R6 P2 fix — Codex caught that the reflow apply path always
      // wrote an adaptation ledger row + bumped the revision, even
      // when the classifier returned zero actions because the
      // anti-churn rate limit fired. That no-op ledger row then
      // *counted as churn* on the next request — bootstrapping the
      // limiter into a tighter and tighter state.
      //
      // The new rule: if the classifier is rate-limited AND we're
      // in apply mode, short-circuit BEFORE executeWeekReflow. No
      // session mutations, no ledger row, no revision bump. The
      // response uses the same serializer shape so iOS decodes it
      // with one Codable. `mutated: false`, `mutatedRows: 0`, and
      // `scenario.rateLimited: true` tell the caller exactly what
      // happened. Preview mode falls through normally — previews
      // never bump revision and never count toward the limit, so
      // the user can still see the suppressed plan.
      //
      // BUT — the idempotency replay path must take precedence over
      // the rate-limit short-circuit. A second apply with the same
      // key is a *retry of the same intent*, not new churn, so we
      // let it through to `executeWeekReflow` which routes it into
      // the conflict-replay branch and surfaces the canonical
      // alreadyExisted=true response.
      if (mode === 'apply' && scenario.rateLimited) {
        const existingForKey =
          idempotencyKey !== undefined
            ? findAdaptationByIdempotencyKey(planId, idempotencyKey)
            : null;
        if (existingForKey) {
          // R8 P1-4 — Codex caught that the (plan_id, idempotency_key)
          // UNIQUE index is per-plan, NOT per-week. A naive replay
          // would happily return the existing row's data even when
          // the caller meant a different week. That means a client
          // who reuses an idempotency key across weeks gets a 200
          // for week B when only week A was applied. Reject 409
          // here so the client knows the key is occupied by a
          // different week — they need to mint a fresh key.
          const existingWeekId = extractWeekIdFromTriggerPayload(existingForKey.trigger_payload_json);
          if (existingWeekId !== null && existingWeekId !== weekId) {
            sendError(
              res,
              'IDEMPOTENCY_KEY_REUSED_DIFFERENT_WEEK',
              `Idempotency key already used on week ${existingWeekId} for this plan; use a fresh key for week ${weekId}.`,
              409,
            );
            return;
          }
          // Same week → fall through to executeWeekReflow so the
          // conflict-replay path emits the canonical response.
        } else {
          sendSuccess(
            res,
            serializeReflowResponse({
              // Synthetic result — no revision, no adaptation row.
              // We deliberately reuse buildReplayReflowResult's
              // shape because it already encodes "we didn't mutate
              // anything for you" semantics.
              result: {
                mode: 'apply',
                adaptationId: 0,
                adaptationRevision: null,
                alreadyExisted: false,
                mutated: false,
                mutatedRows: 0,
              },
              scenario,
              perActionResults: [],
              sciencePolicyVersion,
            }),
          );
          return;
        }
      }

      // R3 P2 fix — capture the per-action breakdown so the response
      // and the ledger both surface skipped/deferred actions. Before:
      // a deferred swap_exercise vanished silently from the apply
      // response.
      //
      // R8 P3 fix — Codex caught that for rate-limited PREVIEWs the
      // ledger row wrote empty `afterPatch.actions` and empty
      // `decisionReasonCodes`, even though `scenario.suppressedActions`
      // held the would-have plan. That made the audit trail blind to
      // what the classifier wanted to do — support couldn't
      // reconstruct "we'd have moved Tuesday → Thursday but waited."
      // Fix: source the ledger's actions + decision codes from
      // `scenario.suppressedActions` when `scenario.rateLimited` is
      // true; otherwise use the canonical `scenario.actions` as
      // before. The response surface (`serializeReflowResponse`) is
      // unchanged — iOS still sees the suppressed actions inside
      // `scenario` and `actions: []` at the top level.
      //
      // The apply rate-limit synthetic-200 branch above ALREADY
      // short-circuits before this code path, so no ledger row is
      // written for apply-rate-limited (the no-ledger contract from
      // R6 P2 is preserved). Only the *preview* path falls through
      // and writes a `scope='preview'` row that now carries the
      // suppressed actions for audit.
      const ledgerActions =
        scenario.rateLimited === true
          ? scenario.suppressedActions ?? []
          : scenario.actions;
      const ledgerDecisionReasonCodes = ledgerActions.map((a) => a.reasonCode);
      const result = executeWeekReflow({
        planId,
        weekId,
        mode,
        trigger,
        idempotencyKey,
        sessionsToPreserve,
        sciencePolicyVersion,
        featureFlagSnapshot: { periodizationV2Enabled: true },
        actor: 'user',
        beforePatch: { sessions: sessionsRows },
        afterPatch: {
          // Canonical actions surface — populated even on
          // rate-limited preview so the audit row reflects intent.
          actions: ledgerActions,
          // R8 P3 — explicit flag so a ledger reader can tell at a
          // glance whether this row's `actions` array is the
          // executed plan or the suppressed-by-rate-limit plan.
          rateLimitedSuppressed: scenario.rateLimited === true,
          // R8 P0-1 — perActionResults gets merged into this object
          // by executeWeekReflow from the structured applyMutation
          // return value. No getter / no closure-over-let.
        },
        decisionReasonCodes: ledgerDecisionReasonCodes,
        applyMutation: mode === 'apply'
          ? (db) => {
              const r = executeCoachActions(db, { planId, actions: scenario.actions });
              return { mutatedRows: r.mutatedRows, perActionResults: r.perActionResults };
            }
          : undefined,
      });
      const perActionResults =
        (Array.isArray(result.perActionResults)
          ? result.perActionResults
          : []) as ReturnType<typeof executeCoachActions>['perActionResults'];
      // R4 P2 fix — route the happy-path response through the shared
      // serializer so the conflict-replay branch below can produce
      // exactly the same shape (Codex caught the two responses had
      // drifted and clients saw a half-payload on retry).
      sendSuccess(
        res,
        serializeReflowResponse({
          result,
          scenario,
          perActionResults,
          sciencePolicyVersion,
        }),
      );
    } catch (err) {
      if (err instanceof ReflowMissingIdempotencyKeyError) {
        sendError(res, 'IDEMPOTENCY_REQUIRED', err.message, 400);
        return;
      }
      if (err instanceof AdaptationIdempotencyConflictError) {
        // Codex R2 P2 fix — re-fetch the winning row instead of 500.
        if (idempotencyKey) {
          const existing = findAdaptationByIdempotencyKey(planId, idempotencyKey);
          if (existing) {
            // R8 P1-4 — same cross-week guard the rate-limit branch
            // applies: if the existing row's weekId is different
            // from the requested weekId, reject 409 so the client
            // knows the key is occupied by a different week's row.
            const existingWeekId = extractWeekIdFromTriggerPayload(existing.trigger_payload_json);
            if (existingWeekId !== null && existingWeekId !== weekId) {
              sendError(
                res,
                'IDEMPOTENCY_KEY_REUSED_DIFFERENT_WEEK',
                `Idempotency key already used on week ${existingWeekId} for this plan; use a fresh key for week ${weekId}.`,
                409,
              );
              return;
            }
            // R4 P2 fix — emit the SAME shape the happy path emits.
            // Replay carries `alreadyExisted: true, mutated: false`
            // but iOS can decode it with the same Codable as a fresh
            // apply. Actions + perActionResults are intentionally
            // empty here (the canonical record is in the ledger via
            // /coach-analysis); we never re-run the classifier on a
            // dedup.
            sendSuccess(
              res,
              serializeReflowResponse({
                result: buildReplayReflowResult({
                  adaptationId: existing.id,
                  adaptationRevision: existing.adaptation_revision,
                }),
                sciencePolicyVersion,
              }),
            );
            return;
          }
        }
        sendError(res, 'IDEMPOTENCY_CONFLICT', err.message, 409);
        return;
      }
      if (err instanceof AdaptationPlanNotFoundError) {
        sendError(res, 'PLAN_NOT_FOUND', err.message, 404);
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
    const policy = getCoachPlanPolicy(owned.planId);
    if (!policy) {
      sendError(res, 'PLAN_NOT_FOUND', `Plan ${owned.planId} not found.`, 404);
      return;
    }
    sendSuccess(res, { planId: owned.planId, policy });
  });

  // ── A5 — PATCH /plans/:planId/coach-policy ─────────────────────
  v2.patch('/plans/:planId/coach-policy', coachV2RateLimitMiddleware, (req: Request, res: Response) => {
    if (!v2EnabledOrShortCircuit(res)) return;
    const rawPlanId = resolvePlanId(req, res);
    if (rawPlanId === null) return;
    // Codex R2 P0 fix — ownership-scoped write.
    const owned = resolveOwnedPlan(req, res, rawPlanId);
    if (!owned) return;
    const planId = owned.planId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const updated = setCoachPlanPolicy(planId, body);
      sendSuccess(res, { planId, policy: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      const travelWindows = findTravelWindowsInRange(auth.userId, weekStart, weekEnd);

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
      const healthSignal = getLatestHealthSignal(auth.userId, auth.tenantId);
      const safetyOutput = healthSignal
        ? (() => {
            // R8 P2-11 — single decode at the route boundary
            // narrows enum fields + parses illness JSON once, with
            // logger.warn-rejects for unknown values. The two
            // downstream consumers (deriveSafetyTriggerFromSignal,
            // wireHealthSignalToSafety) see typed inputs only.
            const decoded = decodeHealthSignalRow(healthSignal);
            const trig = deriveSafetyTriggerFromSignal({
              source: decoded.source,
              illnessSymptoms: decoded.illnessSymptoms,
              injuryStatus: decoded.injuryStatus,
              energyAvailabilityRisk: decoded.energyAvailabilityRisk,
              painScore: decoded.painScore,
              painLocation: decoded.painLocation,
            });
            return wireHealthSignalToSafety({
              signal: decoded,
              source: trig.source,
              triggerType: trig.triggerType,
            });
          })()
        : undefined;

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
        planId,
        weekIndex: safeWeekIndex,
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
