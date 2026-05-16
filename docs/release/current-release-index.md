# Current Release Index

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-15
Update policy: update when the current RC identity, deploy-gate evidence, or canonical-doc cross-references change. Run engine/scripts/release-identity.sh --persist to refresh auto-generated identity fields.

Date: 2026-05-15

## Current Status

Active production package:

- source branch: `main`
- production HEAD: `f03fccd8` (version-bump for 4.14.164)
- production version: `4.14.164`
- runtime source commit: `cc17b75c` (`Harden hybrid chat action release gates`)
- latest `origin/main`: `f1247c8c` (docs/evidence-only after deploy)
- release state: `docs/release/CURRENT_RELEASE_STATE.md` (backend) and `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/CURRENT_RELEASE_STATE.md` (workspace)
- official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

Commits in this release (4.14.163 -> 4.14.164):

- `cc17b75c Harden hybrid chat action release gates`
- `f03fccd8 chore: bump version to 4.14.164 [deploy]`
- `797ac7c5 docs: record 4.14.164 release evidence`
- `f1247c8c docs: refresh release identity mirror`

Scope:

- Nexus Chat Hybrid Action Intelligence hardening across planner, action
  state store, run-store, registry, evaluation harness, and hybrid metrics:
  honest macro-action precision math, real planner smoke-corpus feeder,
  derived safety metrics, refusal false-positive gate, non-vacuous
  gate-positive bypass assertions, planner exception/null-return fail-loud
  tests.
- LLM-output trust boundary hardening: recursive arg sanitization,
  prototype-pollution defense, identity/provider/tool/object-ID stripping,
  provider readiness/risk/confirmation/read-back validation, atomic
  action-run claim/executing transition, late-write reconciliation, zombie
  reaper, retention prune, bounded pending-expiry sweep, PII-safe
  action-run result summaries, shadow telemetry and prediction hashes, UTC
  datetime hash canonicalization with parity tests, provider write/read-back
  timeouts with AbortSignal forwarding.
- New pending-action REST handoff endpoint with auth/tenant scope and
  no-store headers; app-level route/header/error tests.
- iOS source push at `835a985` delivers Plan Builder direct REST handoff,
  prefill reducer, dismissal cleanup, stale-fetch guard, unknown
  `verificationStatus` fallback, source pins, and structured metadata
  rendering safeguards.
- This release also bundles `src/adapters/whatsapp-adapter.ts` (369 lines)
  as a NON-RUNTIME scaffold: not exported from `src/adapters/index.ts`, no
  imports, no portal/config wiring, no tests. Treat as inert reference
  surface, not shipped functionality, until a future release explicitly
  wires it.

Validated through promotion:

- staging deploy: exit 0
- staging smoke: 17 passed / 0 failed / 17 total (pre-promote and
  post-promote realignment both green)
- deploy-time typecheck and build passed
- full backend verify: 536 files / 7,610 tests
- iOS scheme tests: 117 executed / 15 skipped / 0 failures on the iPhone 17
  Pro simulator
- promote-to-prod.sh: `PROMOTE COMPLETE`
- post-deploy: PM2 `nexus-hub` and `content-engine` online, production
  snapshot reports `4.14.164`
- production `/health` (`api.nexushub.me/health`): healthy after deploy
- iOS `main` pushed at `835a985`
- workspace `docs:audit` after mirror refresh: no workspace-mirror-stale
  findings beyond baseline warnings
- still-open operator/device gates: signed TestFlight two-account
  walkthrough, real Gmail/Outlook/Google Calendar/Health provider mutation
  and read-back validation, APNs token + safe delivery proof,
  Garmin MFA/live-session window, HealthKit/Apple Watch device truth,
  App Store metadata review, and an honest labeled-canary/production
  telemetry window before declaring the ≥98% macro-precision target as
  measured production truth

## Previous Production Versions On This Branch

- 4.14.163 (`fbb2c607`) — split unauthenticated portal rate limits (source commit `a2587caa`)
- 4.14.162 (`633d37a6`) — chat general action intelligence production promote (source commit `feb1b022`)
- 4.14.161 (`38c0e071`) — chat general action intelligence local implementation bump (source commit `feb1b022`)
- 4.14.160 (`f3f6ac43`) — SSRF + access control hardening: `url-guard`, dependabot, security workflow, threat model, redaction tests (source commit `bd7284d9`)
- 4.14.159 (`87d86ff8`) — content creator agency orchestration + script quality evaluation: new `content-agency.ts`, `content-agency-rules.ts`, content-agency routes, migrations 128/129 (source commits `6ea51eb8`, `86f5366b`, `b2f5691a`)
- 4.14.158 (`ed545867`) — training coaching quality hardening: `coach-rules`, plan-linter, idempotency service, migration 127 (source commit `de29158d`)
- 4.14.149 (`d46aa107`) — Round E launch blockers, Decision Center Round D' fixes, Apple revocation, GDPR deletion/revocation, prompt-injection hardening, Sentry redaction, api_cache safety valve, onboarding isolation hardening
- 4.14.126 (`cf1e5de`) — closed-beta content identity + iOS fixture isolation release
- 4.14.125 (`f974cb6`) — closed-beta readiness hardening release
- 4.14.124 (`9f503a0`) — Training coach profile/equipment hardening release
- 4.14.123 (`396b8f0`) — Training poor-recovery coherence + catalog v2 release
- 4.14.122 (`a172a9f`) — `fix(training): use rolling week window for volume enforcement` (source commit `e5181fe`)
- 4.14.121 (`ba2089b`) — version bump
- 4.14.120 (`eaf98f3`) — P0 readiness/Garmin/task-list isolation fix (source commit `6549934`)

## Process References

The release-process audit remains the canonical process reference:

- active process source: `docs/release/README.md`
- proposed process: `docs/release/streamlined-release-process-v2.md`
- risk matrix: `docs/release/risk-based-release-gate-matrix.md`
- promotion checklist: `docs/release/production-promotion-checklist-v2.md`
- identity helper: `scripts/release-identity.sh`
- docs audit: `npm run docs:audit`
- local-only Training hardening report: `docs/training/training-final-deep-audit-report.md`

## Active Gate Rule

Future release decisions should be added here first, with:

- release candidate identity generated by `scripts/release-identity.sh`;
- changed-file risk classification;
- required checks from `risk-based-release-gate-matrix.md`;
- smoke artifacts and exact commands;
- owner approval status for production promotion.

Historical docs under `docs/release/archive/` are not active blockers unless
this index links them explicitly.
