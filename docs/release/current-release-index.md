# Current Release Index

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-07-13
Update policy: update when the current RC identity, deploy-gate evidence, or canonical-doc cross-references change. Run `scripts/release-identity.sh --persist` to refresh auto-generated identity fields.

Date: 2026-07-13

## Current Status

Active production package:

- source branch: `main` (pushed to origin)
- production HEAD: `6c67c181`
- production version: `4.14.216`
- runtime source commits: `3ce20473` (paid-only AI cost controls), `fa4de82e`
  (adversarial-QA hardening), `82835940` and `3cf19dce` (verification and
  release-state records), and `6c67c181` (release preparation)
- latest runtime deploy commit: `6c67c181`; post-deploy source-only work may
  sit ahead of production runtime
- full deploy evidence: see the Active Production Release section in
  `docs/release/CURRENT_RELEASE_STATE.md`
- release state: `docs/release/CURRENT_RELEASE_STATE.md` (backend)
- backend workspace root: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`

Commits in this release (2026-07-10 paid-only AI cost controls promote):

- `3ce20473 feat(ai): add paid-only cost controls`
- `fa4de82e fix(ai): harden paid cost controls`
- `82835940 docs(ai): record cost control fix verification`
- `3cf19dce docs(release): sync paid AI open items`
- `6c67c181 chore: prepare release 4.14.216`

Scope:

- Paid-only AI cost-control implementation and adversarial-QA hardening are
  deployed in observe mode. `PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED` remains
  unset, so the new paid-plan, monthly, and automation blocking policy is not
  active.

Validated through promotion:

- The recorded release evidence in `docs/release/CURRENT_RELEASE_STATE.md`
  reports typecheck/build and full Vitest (873 files / 12,910 tests), staging
  readiness, promotion-time staging smoke (25/25), migration 226 applied once,
  and healthy post-deploy runtime probes. Those historical release checks were
  not rerun by this documentation-only update.
- TestFlight/App Store upload, physical-device proof, and signed-device smoke
  were not run for that release.

### Training M1–M5 gate — STAGING DEPLOYED/DORMANT

- `origin/main` at `032d8ffe` contains the default-off M1–M5 source and the
  external exercise-media publication gate. The exact artifact digest
  `5e4daeac8d4896895caf7a93fb904774b64b899a246aac6a2df9666cc48ce8b6`
  is deployed to staging only.
- Staging applied migrations 228–230. All Training rollout variables remained
  unset, and no media manifest reached `STAGED` or `ACTIVE`. Readiness and the
  final **24/24** smoke, including Cloudflare edge checks, passed; see
  `docs/release/smoke-evidence/staging-smoke-032d8ffe-20260713T135646Z.json`.
- Training exercise media is **not production-active**. The
  `TRAINING_EXERCISE_MEDIA_V1_ENABLED` default remains `false`; no publication,
  flag activation, media hosting, production migration, or production runtime
  deployment is authorized by the staging result.
- Production-approved catalog coverage is **0/158**. Activation/publication is
  blocked on exactly six independent gates: `DOMAIN_APPROVAL`,
  `LEGAL_LICENSE`, `ACCESSIBILITY`, `OWNER_PUBLICATION`, `LOCALIZATION`, and
  `APPROVED_HOST`.
- Until all six gates pass against the immutable reviewed assets and the owner
  authorizes rollout, the release decision is **DO NOT RELEASE Training
  exercise media**.

## Previous Production Versions On This Branch

- 4.14.216 (`6c67c181`) — paid-only AI cost controls and adversarial-QA
  hardening deployed in observe mode (source commits `3ce20473`, `fa4de82e`).
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
