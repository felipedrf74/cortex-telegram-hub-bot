# Staged CLAUDE.md Update After 2026-05 Deploy

Status: current
Owner: release lead (Felipe)
Last verified: 2026-05-07
Update policy: staged text only. Apply to `CLAUDE.md` only after Felipe confirms
the post-sweep deploy commit and production version.

## Placeholder Values

- Production version: `<NEXT_VERSION>`
- Production deploy commit: `<DEPLOY_COMMIT>`
- Sweep closeout dossier:
  `engine/docs/archive/2026-05/tech-debt-validation/sweep-closeout-dossier.md`

## Proposed Current Production Truth Text

The 2026-05 tech-debt sweep is source-closed on local main and ready for Felipe's
deployment window. The sweep addressed the original P0/P1 backend source
findings, closed the major P2 engineering-safety cluster, and left only
operator-gated carryovers documented in `docs/release/OPEN_ITEMS.md`.

Production after deploy should be recorded as version `<NEXT_VERSION>` at commit
`<DEPLOY_COMMIT>`. Do not replace these placeholders until staging, production
promote, and production health have passed.

Source-side guarantees after the sweep:

- State isolation: the high-risk state modules now enforce positive, safe
  integer user identifiers at state-layer entry points, with the six-module
  isolation pack and the 23-case P0 chat identity suite as regression contracts.
- JWT rotation: iOS API JWT signing supports `kid`-based key rotation with
  overlap verification and a documented rotation runbook.
- PM2 recovery: supervisor health and restart-count signals are observable via
  `src/services/pm2-health.ts` and `/health/detailed`.
- Gemini SDK migration: production Gemini code uses `@google/genai` through the
  Nexus adapter boundary; `@google/generative-ai` has been removed from runtime
  dependencies.
- Mock hygiene: strict `vi.mock` completeness lint is enforceable at the 827
  partial-mock ceiling.
- Docs hygiene: docs:audit is at 480 issues / 423 audited files before deploy.

Verification floor after the source sweep:

- `npm run verify`: 467 files / 6973 tests.
- `content-engine/.venv313/bin/python -m pytest content-engine/tests/`: 135
  tests.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: 23/23.
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: 23/23.
- `node scripts/vi-mock-completeness-lint.mjs --strict`: 827/827.

## Post-Deploy Verification Template

Run and paste results into the current release state before changing
`CLAUDE.md`:

```bash
cd /Users/felipedominguez/Desktop/Nexus\ Hub/engine
npx tsc --noEmit
npm run verify
content-engine/.venv313/bin/python -m pytest content-engine/tests/ -q
node scripts/vi-mock-completeness-lint.mjs --strict
npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts
bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence
npm run docs:audit
```

Deployment evidence to capture:

- Staging deploy: `<STAGING_DEPLOY_RESULT>`.
- Staging smoke: `<STAGING_SMOKE_RESULT>`.
- Production promote: `<PRODUCTION_PROMOTE_RESULT>`.
- Production health: `<PRODUCTION_HEALTH_RESULT>`.
- PM2 process health: `<PM2_HEALTH_RESULT>`.

## Remaining Beta Gates

These remain outside Codex's source-only closeout:

- Push local main to origin.
- Staging deploy and smoke.
- Production promote and health.
- Signed TestFlight and two-account walkthrough.
- APNs validation.
- Real Gmail/Outlook/Health provider-state checks.
- Non-prod Google/Outlook OAuth credentials.
- Garmin MFA/live-session validation.
- Content portal smoke window.
- iOS fastlane setup, if Felipe chooses to pursue it.
- Self-hosted runner provisioning, only if SSH-only promote workflows require it.

## Apply Guidance

After deployment, update `CLAUDE.md` with the production version, deploy commit,
and verified production status. Keep this staged document as evidence of the
source-side text that was prepared before deployment.
