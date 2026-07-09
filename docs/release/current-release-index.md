# Current Release Index

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-07-09
Update policy: update when the current RC identity, deploy-gate evidence, or canonical-doc cross-references change. Run `scripts/release-identity.sh --persist` to refresh auto-generated identity fields.

Date: 2026-07-09

## Current Status

Active production package:

- source branch: `main` (pushed to origin)
- production HEAD: `cdfe9388`
- production version: `4.14.215`
- runtime source commits: `32114d72` (Training calendar ownership through
  Secretary sync), `81b90b87` (Training split title/structure alignment),
  `f8737377` (version `4.14.215`), `e700826f` (fresh-sync duplicate
  reconciliation), `0f532094` (missing fresh provider event repair), and
  `cdfe9388` (pre-promote staging smoke evidence)
- latest runtime deploy commit: `cdfe9388`; post-deploy docs-only closeout may
  sit ahead of production runtime
- full deploy evidence: see the Active Production Release section in
  `docs/release/CURRENT_RELEASE_STATE.md`
- release state: `docs/release/CURRENT_RELEASE_STATE.md` (backend)
- backend workspace root: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`

Commits in this release (2026-07-09 Training/Secretary calendar ownership promote):

- `32114d72 fix(secretary): preserve training calendar ownership`
- `81b90b87 fix(training): align split titles with assigned structure`
- `f8737377 chore: prepare release 4.14.215`
- `e700826f fix(secretary): reconcile duplicate events on fresh sync`
- `0f532094 fix(secretary): repair missing fresh provider events`
- `cdfe9388 docs(release): record 4.14.215 staging smoke`
- iOS companion main: `8d2ff0a` (clean, no source change required for this
  backend contract)

Scope:

- Training/Secretary calendar ownership and QA hardening:
  - Training-owned Outlook calendar events remain canonical when Secretary
    agenda sync observes the same agenda item;
  - stale Secretary duplicates are deleted, missing fresh provider events are
    recreated or reattached, and canonical Training calendar titles/bodies are
    reused across direct and agenda sync paths;
  - Training split titles now match the actual ABCDE structure shown in session
    details, so lower-body sessions do not display upper-body rationale.

Validated through promotion:

- Local focused Secretary sync suites, `npx tsc --noEmit`,
  `scripts/risk-gate.sh`, and full `npx vitest run` passed through the final
  source commit; final source verification included full Vitest 867 files /
  12,742 tests.
- `deploy-staging.sh` passed; 5-minute soak completed; staging smoke passed
  21/21 with
  `docs/release/smoke-evidence/staging-smoke-0f532094-20260709T093359Z.json`.
- Live Outlook staging provider checks passed: Training calendar lifecycle
  9/9, Secretary calendar lifecycle 8/8, and selected-provider duplicate/cancel
  checks in the broader Training flow. One broader plan-shape assertion in
  that Training flow remained a non-release-blocking QA-profile expectation
  mismatch.
- `promote-to-prod.sh` completed cleanly for 4.14.215 at `cdfe9388`; promote
  gate smoke passed 21/21 before production mutation.
- Deploy-time validation passed migration safety (216 migrations), typecheck,
  science-policy check, build, and full Vitest with 867 files / 12,742 tests.
- Post-deploy: public `/health` healthy, public `/public-status` ok, PM2
  `nexus-hub` and `content-engine` online on `4.14.215`, authenticated
  Decision Center overview returned HTTP 200 with `ok: true`, and the
  post-restart scheduler/log sample showed a completed `secretary_agenda_sync`
  tick with no high-severity application log lines in the sampled window.
- TestFlight/App Store upload, physical-device proof, signed-device smoke,
  HealthKit, Garmin, APNs, Google live calendar proof for the Outlook-only
  staging QA account, two-account provider proof, production live calendar
  writes, and production provider-state validation were not authorized/run.

## Previous Production Versions On This Branch

- 4.14.215 (`cdfe9388`) — Training/Secretary calendar ownership promote:
  Training-owned calendar events remain canonical through agenda sync,
  duplicate/missing fresh provider event repair, and Training split
  title/structure alignment (source commits `32114d72`, `81b90b87`,
  `e700826f`, `0f532094`; no iOS source change required).
- 4.14.214 (`df21fd04`) — P3 release-tooling promote: explicit patch-version policy, PM2 smoke-evidence status checks, and iOS local-export default (source commits `dd7afaf8`, `113b83a5`; iOS companion `3030c71` pushed, no TestFlight upload).
- 4.14.213 (`b1916a76`) — Training Skill QA calendar lifecycle promote (source commit `b28a47b6`; iOS companion `e1d1ca0` pushed, no TestFlight upload).
- 4.14.210 (`b8bd0c29`) — Offline-first Tasks provider-missing hotfix for Microsoft To Do provider reappearance.
- 4.14.208 (`636910e2`) — Content Studio backend contract promote for source-skill overview filtering, capture provenance, and idempotent topic create (source commit `6651085e`)
- 4.14.208 (`910b6d72`) — Training/Coach tenant and health-signal hotfix for fresh safety reads, tenant-gated mutations/reflow, and tenant-scoped adherence/missed-session reads (source commit `9c226007`)
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
