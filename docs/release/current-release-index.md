# Current Release Index

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-21
Update policy: update when the current RC identity, deploy-gate evidence, or canonical-doc cross-references change. Run engine/scripts/release-identity.sh --persist to refresh auto-generated identity fields.

Date: 2026-05-21

## Current Status

Active production package:

- source branch: `main`
- production HEAD: `ae4e1421` (version-bump for 4.14.181)
- production version: `4.14.181`
- runtime source commit: `67287399` (`fix(deploy): keep promotion smoke from dirtying worktree`)
- latest `origin/main`: `4b490d4a` (post-deploy deploy/pre-push read-only evidence guard)
- release state: `docs/release/CURRENT_RELEASE_STATE.md` (backend) and `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/CURRENT_RELEASE_STATE.md` (workspace)
- official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

Commits in this release (4.14.173 -> 4.14.181):

- `3ab03654 merge: nexus points qa2 hardening`
- `c04200c9 chore(edge): add Cloudflare AI crawler unblock tooling`
- `dcf1e05a docs(release): add staging smoke evidence for qa2 hardening`
- `6bcf76f6 docs(release): add promotion smoke evidence`
- `67287399 fix(deploy): keep promotion smoke from dirtying worktree`
- `994fa7aa chore: bump version to 4.14.180 [deploy]`
- `ae4e1421 chore: bump version to 4.14.181 [deploy]`
- `4b490d4a fix(deploy): keep verification from dirtying parity evidence` (on `origin/main`; script/hook guard, not part of the running runtime bundle)

Scope:

- Nexus Points QA2 hardening: pricing fallback observability, legacy
  `api_usage` pricing status/key handling, fallback overage settlement,
  unresolved pricing alert pruning, refund-after-consumption operator alerts,
  canonical Apple transaction keying, transfer helper, chat runtime assertions,
  and deployment provenance guardrails.
- Cloudflare edge unblock foundation: public `/public-status` API contract,
  Cloudflare AI-crawler unblock/apply script, verifier script, and updated
  tunnel runbook documenting the asymmetric marketing/API posture.
- Release transport hardening: promotion smoke no longer dirties the tree, and
  deploy/pre-push verification now suppresses tracked shadow-parity evidence
  writes.

Validated through promotion:

- staging deploy: exit 0
- staging smoke: 17 passed / 0 failed / 17 total
- promote-time staging smoke: 17 passed / 0 failed / 17 total
- full backend verify: 632 files / 9,407 tests (multiple deploy/pre-push runs)
- deploy-time typecheck and build passed
- deploy.sh production promote completed at `4.14.181`
- post-deploy: PM2 `nexus-hub` and `content-engine` online; `/public-status`
  returns the minimal public API payload
- production `/health` (`api.nexushub.me/health`): healthy after deploy
- still-open operator gate: Cloudflare dashboard/API mutation is pending
  because this shell has no `CLOUDFLARE_API_TOKEN`; live verifier still shows
  Cloudflare edge 403s for Claude/Anthropic/ChatGPT/Perplexity fetchers.

## Previous Production Versions On This Branch

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
