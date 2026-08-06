// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training production-router policy manifest (F14/F16, Phase 1A-6).
 *
 * Why this exists
 * ---------------
 * Training's surface grew to 42 routes across seven files and two runtime
 * modes, and nothing enumerated them. Two consequences:
 *
 *   1. `docs/project-map.json` — the map agents are told to start from —
 *      silently omits the six Coach V2 routes. Not a mount failure: the
 *      generator's receiver allow-list
 *      (`scripts/generate-project-map.mjs`, `/^(?:router|app|[A-Za-z][A-Za-z0-9]*Router)$/`)
 *      does not match the sub-router local `v2`, so those `v2.post(...)` calls
 *      are discarded at collection. Any route count taken from the map is
 *      therefore wrong.
 *   2. Authorization coverage was asserted per-test rather than per-route, so
 *      a route could ship with no classification and nothing would notice.
 *
 * This manifest is the denominator. `__tests__/security/training-route-policy-manifest.test.ts`
 * extracts the routes actually declared in source and fails when any of them
 * is missing here — so adding a route without classifying it breaks the build.
 *
 * What the fields mean
 * --------------------
 * - `auth`         — every Training route inherits `authMiddleware` at the
 *                    router mount, so this is `'jwt'` throughout. Recorded
 *                    explicitly so "is it authenticated?" is answerable from
 *                    the manifest rather than from mount archaeology.
 * - `entitlement`  — route-level BUSINESS entitlement, which is the part that
 *                    actually varies. `'skill:training'` = the shared mount
 *                    gate; `'coach-briefing'` = the stricter Pro/Max non-beta
 *                    check; `'self-scoped'` = the route enforces its own
 *                    entitlement internally.
 * - `capability`   — feature flag / enrollment required to reach the route.
 * - `mode`         — which runtime path the route belongs to.
 *
 * Deliberately NOT changed here: no blanket entitlement mount is added.
 * Garmin status/disconnect stay auth-only so a downgraded user can still
 * revoke, and the free-tier dashboard training section keeps working.
 */

export type TrainingRouteAuth = 'jwt';

export type TrainingRouteEntitlement =
  | 'skill:training'
  | 'coach-briefing'
  | 'self-scoped';

export type TrainingRouteCapability =
  | 'none'
  | 'coach-periodization-v2'
  | 'revision-v1-enrollment'
  | 'adaptation-v1'
  | 'exercise-media-v1';

export type TrainingRouteMode = 'both' | 'compatibility' | 'revision';

export interface TrainingRoutePolicy {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path as declared on its router, before the `/api/v1/training` mount. */
  path: string;
  auth: TrainingRouteAuth;
  entitlement: TrainingRouteEntitlement;
  capability: TrainingRouteCapability;
  mode: TrainingRouteMode;
  /** Write routes are the ones that need lock/idempotency review. */
  mutates: boolean;
}

const SKILL = 'skill:training' as const;

export const TRAINING_ROUTE_POLICY: readonly TrainingRoutePolicy[] = [
  // ── Core reads/writes (training.ts) ──
  { method: 'GET', path: '/home', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/summary', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/today', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/week', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/plan/weeks', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/readiness', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  // Stricter than the mount: Pro/Max and non-beta. Owner and beta sources are
  // deliberately DENIED coach briefings.
  { method: 'GET', path: '/coach', auth: 'jwt', entitlement: 'coach-briefing', capability: 'none', mode: 'both', mutates: false },
  { method: 'POST', path: '/coach/report', auth: 'jwt', entitlement: 'coach-briefing', capability: 'none', mode: 'both', mutates: true },
  { method: 'POST', path: '/complete', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: true },
  { method: 'POST', path: '/skip', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: true },
  { method: 'POST', path: '/today/keep-original', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: true },
  { method: 'POST', path: '/coach/apply', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: true },

  // ── Analytics (training-analytics-routes.ts) ──
  { method: 'GET', path: '/progression/cardio', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/progression/strength', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/activity/weekly', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/history', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'GET', path: '/load-snapshot', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },

  // ── Plan lifecycle (training-plan-routes.ts) ──
  // Compatibility-only: blocked with TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED
  // once the scope is enrolled in revision v1.
  { method: 'POST', path: '/plan/preview', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'compatibility', mutates: false },
  // Recovery remains reachable after revision enrollment so an in-flight
  // compatibility attempt cannot be stranded by a rollout-mode change.
  { method: 'POST', path: '/plan/generation-attempt/status', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'POST', path: '/plan/generate', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'compatibility', mutates: true },
  { method: 'POST', path: '/plan/sync-calendar', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: true },
  { method: 'POST', path: '/sessions/:id/reflow-preview', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: false },
  { method: 'POST', path: '/sessions/:id/reflow-confirm', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: true },
  { method: 'POST', path: '/plan/cancel', auth: 'jwt', entitlement: SKILL, capability: 'none', mode: 'both', mutates: true },

  // ── Revision v1 (training-plan-revision-routes.ts) ──
  // Dark by default: hidden 404 unless mode=active AND the scope is explicitly
  // enrolled AND userId === tenantId AND Decision Flow enforce is on.
  { method: 'GET', path: '/plan/revision-capabilities', auth: 'jwt', entitlement: SKILL, capability: 'revision-v1-enrollment', mode: 'revision', mutates: false },
  { method: 'GET', path: '/capabilities', auth: 'jwt', entitlement: SKILL, capability: 'revision-v1-enrollment', mode: 'revision', mutates: false },
  { method: 'POST', path: '/plan/capacity-context/refresh', auth: 'jwt', entitlement: SKILL, capability: 'revision-v1-enrollment', mode: 'revision', mutates: true },
  { method: 'POST', path: '/plan/candidates', auth: 'jwt', entitlement: SKILL, capability: 'revision-v1-enrollment', mode: 'revision', mutates: true },
  { method: 'GET', path: '/plan/revisions/:revisionId', auth: 'jwt', entitlement: SKILL, capability: 'revision-v1-enrollment', mode: 'revision', mutates: false },
  { method: 'POST', path: '/plan/revisions/:revisionId/edit-preview', auth: 'jwt', entitlement: SKILL, capability: 'revision-v1-enrollment', mode: 'revision', mutates: true },
  { method: 'GET', path: '/plan/active-revision', auth: 'jwt', entitlement: SKILL, capability: 'revision-v1-enrollment', mode: 'revision', mutates: false },

  // ── Adaptations (training-adaptation-routes.ts, migration 230) ──
  { method: 'POST', path: '/adaptations/preview', auth: 'jwt', entitlement: SKILL, capability: 'adaptation-v1', mode: 'revision', mutates: false },
  { method: 'POST', path: '/adaptations/:adaptationId/request-review', auth: 'jwt', entitlement: SKILL, capability: 'adaptation-v1', mode: 'revision', mutates: true },
  { method: 'POST', path: '/adaptations/:adaptationId/select-option', auth: 'jwt', entitlement: SKILL, capability: 'adaptation-v1', mode: 'revision', mutates: true },
  { method: 'GET', path: '/adaptations/:adaptationId', auth: 'jwt', entitlement: SKILL, capability: 'adaptation-v1', mode: 'revision', mutates: false },

  // ── Coach V2 (training-coach-v2.ts) ──
  // 404 COACH_V2_DISABLED unless config.coaching.periodizationV2Enabled.
  // Best entitlement coverage in the repo; no iOS caller (see F22 — that is a
  // product-adoption question, not a removal warrant).
  { method: 'POST', path: '/week/travel', auth: 'jwt', entitlement: SKILL, capability: 'coach-periodization-v2', mode: 'both', mutates: true },
  { method: 'POST', path: '/health-intake/red-flag', auth: 'jwt', entitlement: SKILL, capability: 'coach-periodization-v2', mode: 'both', mutates: true },
  { method: 'POST', path: '/week/:weekId/reflow', auth: 'jwt', entitlement: SKILL, capability: 'coach-periodization-v2', mode: 'both', mutates: true },
  { method: 'GET', path: '/plans/:planId/coach-policy', auth: 'jwt', entitlement: SKILL, capability: 'coach-periodization-v2', mode: 'both', mutates: false },
  { method: 'PATCH', path: '/plans/:planId/coach-policy', auth: 'jwt', entitlement: SKILL, capability: 'coach-periodization-v2', mode: 'both', mutates: true },
  { method: 'GET', path: '/plans/:planId/coach-analysis', auth: 'jwt', entitlement: SKILL, capability: 'coach-periodization-v2', mode: 'both', mutates: false },

  // ── Exercise media (training-exercise-media-routes.ts, migration 229) ──
  // Mounted WITHOUT the shared requireEntitlement; enforces flag → scope →
  // entitlement itself and collapses every failure to an identical hidden 404.
  { method: 'GET', path: '/exercises', auth: 'jwt', entitlement: 'self-scoped', capability: 'exercise-media-v1', mode: 'both', mutates: false },
  { method: 'GET', path: '/exercises/:exerciseId', auth: 'jwt', entitlement: 'self-scoped', capability: 'exercise-media-v1', mode: 'both', mutates: false },
];

/** Source files whose route declarations the manifest must cover. */
export const TRAINING_ROUTE_SOURCE_FILES: readonly string[] = [
  'training.ts',
  'training-analytics-routes.ts',
  'training-plan-routes.ts',
  'training-plan-revision-routes.ts',
  'training-adaptation-routes.ts',
  'training-coach-v2.ts',
  'training-exercise-media-routes.ts',
];

/**
 * Routes registered through an exported constant rather than a string
 * literal, so a literal scan cannot see them. Kept explicit so the manifest
 * test does not silently under-count the way `project-map.json` does.
 */
export const TRAINING_CONSTANT_REGISTERED_ROUTES: readonly string[] = [
  '/plan/revision-capabilities',
  '/plan/capacity-context/refresh',
];

export function trainingRoutePolicyKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
