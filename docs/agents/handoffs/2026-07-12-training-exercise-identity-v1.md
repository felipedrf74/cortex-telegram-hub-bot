# Training Exercise Identity V1 — Local Engineering Handoff

Date: 2026-07-12
Repository: `cortex-telegram-hub-bot`
Worktree: `/Users/felipedominguez/.codex/worktrees/training-exercise-identity-v1`
Branch: `feature/training-exercise-identity-v1-20260712`
Stack base: Milestone 1 backend commit `87dd89fc6f6772b8bfe24abb67815812f606d60b`
Status: locally implemented and verified; local commit pending at the time of this evidence record

## Scope delivered

- Added `TRAINING_EXERCISE_IDENTITY_V1_MODE=off|shadow|active`, defaulting to `off` with the shared user/tenant override convention.
- Added an immutable, source-hash-pinned identity catalog containing 158 canonical IDs: the 131 active repository-seed IDs, 26 reviewed emergency-only promotions after canonical collision handling, and the resolved `jumping_lunge` template identity.
- Removed `floor_press` as a canonical identity and retained only the reviewed stable-ID compatibility mapping `floor_press -> dumbbell_floor_press`.
- Added exact-only resolution outcomes: `canonical`, `ambiguous`, `unknown`, and `historical_text`. Historical unknown text remains readable but is neither newly prescribable nor media eligible.
- Added the reviewed safe name aliases and explicit ambiguity set. Tempo Air Squat and Tempo Split Squat resolve to canonical IDs with structured `3-1-1-0` tempo; no fuzzy matching is used.
- Closed new-prescription identity at deterministic fallback, coordination, equipment adaptation, M1 candidate construction, chat tool, and final session persistence boundaries.
- Active mode prevents dynamic `Banded ...` output and composite exercise persistence. A finite, reviewed equipment-context table preserves movement role for vertical push, vertical pull, horizontal pull, and unilateral hinge substitutions; unreviewed active band substitutions fail closed instead of guessing.
- Preserved the legacy dynamic band-name function solely for `off`/`shadow` rollback compatibility. It remains physically present because deleting it would violate the required flag-off behavior; active mode never calls it and focused tests pin that boundary.
- Pinned M1 candidate and generated-plan context to the identity catalog version and source hash in active mode. Activation rebuild/revalidation therefore detects catalog drift. Off and shadow preserve the historical five-key generation-pin and persisted-preferences shape exactly.
- Corrected identity-catalog mobility classification before name heuristics, including Jefferson Curl and Open-Book Thoracic Rotation, and added genuine mobility candidates to the active identity quality gate. The legacy exercise-library taxonomy and candidate tiers remain byte-for-byte behaviorally unchanged in off and shadow modes.
- Replaced the loaded-carry quality candidate that incorrectly pointed at Pallof Press with Farmer Carry, Suitcase Carry, Sandbag Hold, Overhead Carry, and Yoke / Front-Rack Carry only in active identity mode. Off and shadow retain the historical Pallof Press tier.
- Added the instructional-text rule: generated warm-up/cooldown prose is not a catalog exercise, newly prescribable identity, or media candidate. Off mode preserves the former serialized section shape.
- Left the existing 131-entry active catalog, schemas, migrations, historical reads, media platform, and production runtime untouched while the mode is off.
- Preserved exact off/shadow output and enumerable object shape at generation pins, revision candidates, fallback planning, coordination, equipment adaptation, session descriptions, and quality validation. Runtime-only mode context is held outside serialized plan/adaptation objects.
- Kept `jumping_lunge` unavailable to the legacy strength selector and added it to the scoped authoritative identity library only when active mode is explicitly selected.

## Immutable contract pins

- Identity policy: `training-exercise-identity-policy.v1`
- Identity catalog: `training-exercise-identity-catalog.v1`
- Source hash: `50ed5bdd523af02dcd36cd258f195d144e3a4ee86aaed8dcf057fe45532e0ed8`
- Canonical identities: 158
- Reviewed emergency promotions: 26
- Stable-ID aliases: one (`floor_press` only)
- Reviewed exact name aliases: 12
- Explicit ambiguous names: nine

## Verification

- Focused identity/dependency matrix passed with zero failures; exact counts remain in the task execution evidence.
- Updated hardening source contract passed with zero failures.
- Final risk gate from `HEAD`:
  - TypeScript typecheck passed.
  - Selected Training/provider/entitlement matrix passed.
  - Changed-dependency matrix passed.
  - Verdict: complete with zero failures.
- `npm run build`: passed.
- `git diff --check`: passed before documentation closeout and must be rerun before commit.
- `npm run docs:audit`: exited zero with 601 pre-existing workspace warnings; no warning was treated as new release evidence.
- Nexus Verifiable Reward Loop: PASS, score 100, run `9c84be37-c6a0-4da6-af11-db9fa0f0011f`; five mandatory checks passed with no hard failure or skipped check.

## Limits and safety boundaries

- No migration was added or executed.
- No media catalog/platform or generated image was added.
- No runtime flag was enabled.
- No existing active plan was changed or rescheduled.
- No provider, HealthKit, calendar, analytics, or external write was performed.
- No push, staging deploy, production deploy, or production-readiness claim is included.
- The Anthropic tool registry is process-global in the existing architecture, so its instructional schema copy reflects the process-level mode at startup. User/tenant-scoped enforcement remains authoritative at both tool execution and persistence boundaries; a later provider-contract refactor may make the guidance copy scope-specific without weakening enforcement.

## Integration and next checkpoint

1. Independently review the local commit and confirm the intended integration base for the stacked Milestone 1 branch.
2. Keep the mode `off` through integration. If explicitly authorized later, use `shadow` first to measure unresolved/ambiguous new-prescription paths without rewrites.
3. Do not activate until the separate exercise-media platform, content/anatomy review, rights, accessibility, delivery, and removal-policy gates are complete.
4. Treat any catalog, alias, ambiguity, or instructional-text-policy change as a new reviewed catalog version/hash change; activation revalidation must fail on unpinned drift.

## Verifiable Reward Summary

- Verdict: PASS, score 100, backend area.
- Run ID: `9c84be37-c6a0-4da6-af11-db9fa0f0011f`
- Claim level: L2 local code/build/test evidence only
- Evidence: focused Vitest, final risk gate, typecheck, build, unchanged-baseline docs audit, catalog integrity/hash tests, emitter closure tests, and this handoff.
- Hard failures: none.
- Skipped checks: no local backend check was skipped. Staging smoke, production health, deployment, activation, and media validation are outside this authorized L2 implementation claim and remain separately gated.
- Export eligibility: manual human review required; no export requested
- Prompt/process improvement: keep identity resolution exact and emitter-local; never turn a context-specific substitution choice into a global alias.
