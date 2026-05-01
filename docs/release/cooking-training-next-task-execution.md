# Cooking + Training Next-Task Execution

Date: 2026-05-01

## Selected Task

Selected task: P2 release evidence/doc drift.

Reason: Current validation found no safe P0/P1 code issue in Cooking or Training. The next highest-priority safe task was preventing release confusion by updating stale Cooking evidence and creating consolidated Cooking/Training readiness docs.

## Reproduction / Evidence

- `docs/cooking/cooking-final-report.md` still said full `npm run verify` passed `427 files / 6398 tests`.
- Current branch evidence from commit `c8dca78` and this pass says full backend verify passed `429 files / 6426 tests`.
- The same file described the portal runtime smoke before the forged-tenant stale-data clear was added.
- The requested consolidated release docs under `docs/release/cooking-training-*` did not exist.

## Implementation

Files created/updated:

- `docs/cooking/cooking-final-report.md`
- `docs/release/cooking-training-readiness-summary.md`
- `docs/release/cooking-training-open-items.md`
- `docs/release/cooking-training-next-task-execution.md`
- `docs/release/cooking-training-main-prod-go-no-go.md`

No product code changed in this task.

## Validation Before Docs

| Check | Result |
| --- | --- |
| Cooking backend typecheck | PASS |
| Cooking focused backend tests | PASS, 6 files / 61 tests |
| Cooking full backend verify | PASS in pre-commit for `c8dca78`, 429 files / 6426 tests |
| Training iOS build-for-testing | PASS |
| Training focused iOS tests | PASS, 59 unit + 4 UI tests |
| Cooking iOS focused tests | PASS, 13 tests |

## Validation After Docs

- `git diff --check`: PASS.
- Ports `8200` and `8326`: clear.
- Simulators: `xcrun simctl shutdown all` run; no booted devices remain.
- DB files: no `cooking-*.db` files remain.
- Runtime retest: not required for docs-only edits.

## Not Selected

- Cooking substitution apply workflow: P2 product feature, not a release-safety fix.
- Portal deep recipe/meal-plan/grocery editors: P2 product feature.
- Training provider-backed calendar smoke: requires non-production external provider credentials and should run on the exact RC/staging environment, not as a local code patch.
- Signed TestFlight/device smoke: requires physical/device distribution context, not a local code patch.

## Follow-Up Execution: Hardened Portal Auth Probe

Selected task: `CT-P2-003` hardened Cooking portal auth/session browser probe.

Reason: after the consolidated release docs landed, this was the next safe,
local release-evidence gap. The prior portal smoke proved scoped Cooking UI
behavior under the local token path, but did not prove that the browser login
fails closed when loopback bypass is disabled and signed portal sessions are
required.

Implementation:

- Updated `scripts/cooking-portal-browser-smoke.ts` to accept
  `--auth-token`, `--invalid-auth-token`, and `--probe-invalid-auth`.
- The new invalid-auth probe submits the invalid token through the real portal
  login form, waits for `/api/snapshot`, requires a `401`, verifies the visible
  `Invalid token` error, and verifies the login overlay remains visible.
- The same run then signs in with a valid `ps_` session, loads Cooking,
  writes scoped preference/pantry data, and verifies forged tenant `9002`
  still fails closed with `Load failed`.

Validation:

```bash
PORTAL_REQUIRE_SESSION_AUTH=true \
PORTAL_SESSION_SECRET=local-cooking-portal-session-secret-000000000000000000000000 \
PORTAL_ADMIN_ACTORS=local-cooking-smoke@nexushub.me \
PORTAL_ALLOW_LOCAL_BYPASS=false \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
FULL_NEXUS_STATE_DIR=.local/full-nexus-cooking-auth \
scripts/full-nexus-local-engine.sh up

PORTAL_SESSION_SECRET=local-cooking-portal-session-secret-000000000000000000000000 \
npx tsx src/tools/portal-session-token.ts \
  --actor local-cooking-smoke@nexushub.me \
  --scope admin \
  --ttl-ms 600000 \
  --json

NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npm run smoke:cooking:portal -- \
  --base-url http://127.0.0.1:8200 \
  --auth-token '<minted ps_ session>' \
  --probe-invalid-auth \
  --user-id 2 \
  --tenant-id 2 \
  --forged-tenant-id 9002
```

Result: PASS. The invalid `ps_` session returned `401` with visible
`Invalid token`, the valid signed session loaded user/tenant `2`, forged tenant
`9002` failed closed, and `providerCallsAllowed:false`.
