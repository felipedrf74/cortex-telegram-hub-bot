# Current Release Index

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-18
Update policy: update when the current RC identity, deploy-gate evidence, or canonical-doc cross-references change. Run engine/scripts/release-identity.sh --persist to refresh auto-generated identity fields.

Date: 2026-05-18

## Current Status

Active production package:

- source branch: `main`
- production HEAD: `1587fc5d` (version-bump for 4.14.171)
- production version: `4.14.171`
- runtime source commit: `0df40622` (`feat(beta): add double opt-in registry and Stripe checkout`)
- latest `origin/main`: `e5b29a69` (release evidence after deploy)
- release state: `docs/release/CURRENT_RELEASE_STATE.md` (backend) and `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/CURRENT_RELEASE_STATE.md` (workspace)
- official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

Commits in this release (4.14.170 -> 4.14.171):

- `0df40622 feat(beta): add double opt-in registry and Stripe checkout`
- `1587fc5d chore: bump version to 4.14.171 [deploy]`

Scope:

- Double opt-in beta registry: normalized email, syntax/disposable/MX
  validation, hashed expiring confirmation tokens, confirmed-only portal
  approval, 30-day invite emails, DB invite redemption, and long-lived static
  reviewer-code policy.
- Billing launch foundation: public website checkout endpoint, authenticated
  checkout endpoint hardening, server-side plan/currency to Stripe Price
  mapping for Pro/Max monthly USD/BRL, webhook idempotency, unknown-price
  fail-closed behavior, and verified-user claim flow for public checkout
  ownership.
- Email and logging hardening from hostile QA: transactional names and reset
  URLs are escaped; raw names/emails/invite codes are not logged.
- Static landing source and deploy folder are synced locally with real
  waitlist fetch handling, pricing copy, and Cloudflare Pages `_headers`.
  The live `nexushub.me` direct upload is still pending a
  `CLOUDFLARE_API_TOKEN` in the deploy shell.

Validated through promotion:

- staging deploy: exit 0
- five-minute staging soak: completed
- staging smoke: 18 passed / 0 failed / 18 total
- promote-time staging smoke: 18 passed / 0 failed / 18 total
- deploy-time typecheck and build passed
- full backend verify: 618 files / 9,172 tests
- deploy-time pre-push full Vitest after version bump also passed
- promote-to-prod.sh: `PROMOTE COMPLETE`
- post-deploy: PM2 `nexus-hub` and `content-engine` online, production
  snapshot reports `4.14.171`
- production `/health` (`api.nexushub.me/health`): healthy after deploy
- still-open operator gate: Cloudflare Pages direct upload for
  `https://nexushub.me` needs non-interactive Cloudflare credentials

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
