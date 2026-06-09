# Current Release Index

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-09
Update policy: update when the current RC identity, deploy-gate evidence, or canonical-doc cross-references change. Run engine/scripts/release-identity.sh --persist to refresh auto-generated identity fields.

Date: 2026-06-09

## Current Status

Active production package:

- source branch: `main`
- production HEAD: `4f2927c1`
- production version: `4.14.207`
- runtime source commits: `bc7aacc2` (Training/coach remediation) and
  `770ac929` (catalog seed write initialization fix)
- latest runtime deploy commit: `4f2927c1`; post-deploy docs-only closeout may
  sit ahead of production runtime
- release state: `docs/release/CURRENT_RELEASE_STATE.md` (backend) and `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/CURRENT_RELEASE_STATE.md` (workspace)
- official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

Commits in this release (4.14.205 -> 4.14.207):

- `bc7aacc2 feat(training): harden coach generation pipeline`
- `4d4e14cc docs(release): add training staging smoke evidence`
- `770ac929 fix(training): initialize database for catalog seed writes`
- `4f2927c1 docs(release): add catalog seed fix staging smoke evidence`
- iOS companion: `49ce035 feat(training): present coach decision insights`

Scope:

- Training / Coach remediation:
  - tenant-scope hardening, tenant-aware idempotency/locks, Training safety
    guardrail plumbing, canonical equipment vocabulary, conservative
    unknown-equipment defaults, DB catalog schema/seed/validation, selector
    scaffolding, completion feedback substrate, endurance coherence, upstream
    calendar-capacity inputs, audit/version pins, observability counters, and
    additive iOS/read-model coach insight fields.
  - production catalog `repo-seed-1.0.0` is active and immutable for
    `__global__`, with 131 exercises and 24 equipment items.
  - behavior-changing flags remain in rollout/soak state; production `.env`
    has no explicit `TRAINING_*` or `COACH_KERNEL_*` behavior flags set.

Validated through promotion:

- backend local `npm run verify`: 841 files / 12,307 tests
- deploy-time backend verification: typecheck, science-policy check, and full
  Vitest passed with 841 files / 12,307 tests
- migration safety: 200 migrations passed
- catalog dry-run/write validation: `repo-seed-1.0.0`, 131 exercises, 24
  equipment items, 0 issues; staging and production activation both passed
- staging smoke: 26/26 passed standalone and again during promotion
- focused iOS Training/contract/presentation suites: 49/49 plus onboarding
  scope wrapper 2/2
- full iOS wrapper: 1,482 tests passed
- `promote-to-prod.sh` completed cleanly for 4.14.207
- post-deploy: PM2 `nexus-hub` and `content-engine` online
- production readiness passed: SQLite integrity, `/health`, content-engine
  readiness, better-sqlite3 native binding, and PM2 stability

## Previous Production Versions On This Branch

- 4.14.207 (`4f2927c1`) — Training/Coach remediation production promote with active immutable Training catalog (source commits `bc7aacc2`, `770ac929`)
- 4.14.205 (`24a22f3c`) — release-hardening candidate and event-based training plan linting hardening catch-up
- 4.14.202 (`6438553d`) — Training remediation round-3 no-oracle, safety, docs, and iOS freshness fast-follow (source commit `870ca09f`)
- 4.14.201 (`ddb8eec4`) — Training remediation and coach/iOS contract hardening (source commit `3aac49b4`)
- 4.14.200 (`30285bb3`) — Decision Center execution gates + iOS local smoke harness (source commit `c7f049e1`)
- 4.14.195 (`0682b34b`) — Training Outlook calendar default-enabled (source commit `0bae01cb`)
- 4.14.194 (`fb1f844e`) — Training bug-fix triplet: cancel-orphan + two-a-day/Auto + calendar body Stage 1 (source commit `d94c2d1a`)
- 4.14.193 (`fb1ca66d`) — Coach Periodization v2.1 + deploy dirty-tree stop fix (source commits `99992ddc`, `256aa591`)
- 4.14.190 (`bac44816`) — beta-hardening confirmation contract production promote
- 4.14.186 (`05960637`) — Decision Center Human Guidance v2 production promote
- 4.14.183 (`17c35872`) — Decision Center clarity + Secretary intelligence production promote
- 4.14.181 (`ae4e1421`) — Nexus Points QA2 hardening + Cloudflare edge unblock foundation + deploy guard fixes (source commits `3ab03654`, `c04200c9`, `67287399`)
- 4.14.180 (`994fa7aa`) — aborted recovery bump before final successful deploy
- 4.14.173 (`93ed02d0`) — Content Token Phase 2 + Training Skill Hardening production promote
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
- signed evidence contract: `docs/release/release-evidence-contract.md`
- release-test container: `Dockerfile.release-test` plus
  `scripts/release-verify-container.sh` and
  `scripts/release-evidence-container.sh`
- rollback drill freshness gate: `scripts/rollback-drill-check.mjs`
- version preparation now happens before staging via `scripts/release-prep.sh`;
  production deploy must not create a new version bump after staging evidence.
- legacy `.github/workflows/cd-production.yml` is owner-review-only; local
  scripts remain canonical for production deployment.
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
