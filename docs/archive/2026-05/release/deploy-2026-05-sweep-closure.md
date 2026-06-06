Status: archive
Owner: Codex
Deployed: 2026-05-07
Evidence level: E2 - deploy gates + staging smoke + production health

# 2026-05 Tech-Debt Sweep Closure Deploy

## Headline

- Production version: `4.14.134`
- Production deploy commit: `7edf9eb389bb0808893ef2fd038b7e706f567a1e`
- Production truth update commit: `310048cd50e02be5f882c4125f7c1a387bd5fbc8`
- Production tag: `v4.14.134-prod`
- Initial push delta: `88` commits ahead of `origin/main` before the release push
- Source delta vs pre-sweep origin tip `ed53f84a`: `346` files changed
- Required staging soak: `5` minutes before promote
- Final staging alignment: redeployed and smoke-tested after production tag so staging also reports `4.14.134`

## Pre-Deploy Verification

Final source verification before push/deploy:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm run verify` | PASS - `467` files / `6,973` tests |
| `content-engine/.venv313/bin/python -m pytest tests/ -v` | PASS - `135 passed` |
| `node scripts/vi-mock-completeness-lint.mjs --strict --top 5` | PASS - baseline `827` |
| `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts` | PASS - `23/23` |
| `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` | PASS - `23/23` |
| `npm run docs:audit -- --json` | PASS - `480` issues / `427` audited markdown files |

## Push Delta

The deploy began from local `main` after the Batch 24 closure merge. Local `main`
was `88` commits ahead of `origin/main`. The first release push fast-forwarded
`origin/main` from `ed53f84a` to `c8eeecd0`, then the deploy script created and
pushed the final deploy bump commit `7edf9eb3` for `4.14.134`. The post-health
CLAUDE.md production-truth update landed at `310048cd`.

## Staging Smoke

Staging deploy and smoke passed before production promote:

- Initial staging deploy: `4.14.133` at `c8eeecd0`
- Required soak: `5` minutes
- Initial smoke: `17/17` PASS
- Evidence:
  - `docs/release/smoke-evidence/staging-smoke-c8eeecd0-20260507T003724Z.json`
  - `docs/release/smoke-evidence/staging-smoke-c8eeecd0-20260507T003743Z.json`

Additional staging smokes were captured during the production promote retry
window and all stayed green:

- `docs/release/smoke-evidence/staging-smoke-c8eeecd0-20260507T094555Z.json`
- `docs/release/smoke-evidence/staging-smoke-c8eeecd0-20260507T094623Z.json`
- `docs/release/smoke-evidence/staging-smoke-c8eeecd0-20260507T094929Z.json`

After production was tagged, staging was redeployed from current `main` and
re-smoked so it aligned with production:

- Final staging deploy: `4.14.134` at `310048cd`
- Final staging smoke: `17/17` PASS
- Evidence: `docs/release/smoke-evidence/staging-smoke-310048cd-20260507T100315Z.json`

## Promote To Production

`./scripts/promote-to-prod.sh` completed successfully after one transient SSH
timeout during pre-production environment validation. The timeout happened before
production was modified; the retry completed the normal deploy path.

Production deploy script evidence:

- Full backend verify inside deploy: PASS - `467` files / `6,973` tests
- Build: PASS
- Production environment validation: PASS
- Version bump: `4.14.133` -> `4.14.134`
- Production services: restarted under PM2 and online
- Script output: `Deploy complete! v4.14.134 (7edf9eb3)`

## Production Health

Production health verification after promote:

- Public `/health`: HTTP 200, `status=healthy`, database connected
- Authenticated local `/health/detailed`: `status=healthy`
- Authenticated local `/api/snapshot`: `version=4.14.134`
- Snapshot commit field: `null` in the current production snapshot schema

Because `/api/snapshot` does not currently expose the running commit, the deploy
commit is recorded from the pushed deploy bump commit and deploy script output:
`7edf9eb389bb0808893ef2fd038b7e706f567a1e`.

## CLAUDE.md Update

Applied the staged Batch 24 production-truth text after production health passed.
Placeholders were replaced with the deployed version and commit truth.

- Commit: `310048cd50e02be5f882c4125f7c1a387bd5fbc8`
- File: `CLAUDE.md`
- Verification: `npx tsc --noEmit` PASS before commit; full pre-push Vitest
  hook PASS on push

## Production Tag

Created and pushed annotated tag `v4.14.134-prod`.

Tag message records:

- Sweep dossier: `docs/archive/2026-05/tech-debt-validation/sweep-closeout-dossier.md`
- Final test count: `6,973`
- Final mock baseline: `827`
- Final docs audit: `480` issues / `427` audited
- Production health verified at: `2026-05-07T10:00:25Z`

## Sweep Closure

The deploy shipped the 2026-05 tech-debt sweep closure. Canonical closeout:

- `docs/archive/2026-05/tech-debt-validation/sweep-closeout-dossier.md`
- `docs/archive/2026-05/tech-debt-validation/INDEX.md`
- `docs/archive/2026-05/tech-debt-validation/codex-batch-24-remediation.md`

## Remaining Beta Gates

These are operator-only and were not blockers for this backend production deploy:

- Signed TestFlight + two-account walkthrough on physical device
- APNs token + delivery validation
- Real Gmail/Outlook/Health provider-state checks
- Non-prod OAuth credentials provisioning
- Garmin MFA session
- Content portal smoke window
