# Nexus Hub Production Deployment Checklist

Generated: 2026-04-29

## Deployment Status

Deployment package prepared only. **Do not deploy until every required checkbox is complete.**

Final go/no-go verdict: **GO WITH CONDITIONS**.

## 1. Branch And Commit Hygiene

- [ ] Backend is on `release/nexus-hub-production-candidate`.
- [ ] iOS is on `release/nexus-hub-production-candidate`.
- [ ] Backend release branch is committed.
- [ ] iOS release branch is committed.
- [ ] Backend release branch is pushed.
- [ ] iOS release branch is pushed.
- [ ] No unrelated local-only debug flags are included.
- [ ] Release docs are committed.

Reference validation commits at package creation:

- Backend: `34add9aa8b05c100b28a116fa12b920e118e4d15`
- iOS: `dd7e3e0163e5e3ee37360d3f0ffbaca54fdfb7a2`

## 2. Required Local Verification

- [ ] Backend `npm run verify` passes.
- [ ] Backend `npm run build` passes.
- [ ] iOS full scheme tests pass.
- [ ] Local full-product smoke passes or all conditions are accepted.
- [ ] Local cleanup confirms no backend/workers/ports/provider loops remain.

Latest recorded results:

- Backend verify: 398 test files / 6,137 tests passed.
- Backend build: passed.
- iOS tests: 922 / 922 passed.
- Local full-product smoke: PASS WITH CONDITIONS.
- Cleanup: no backend listener on port 8200; local smoke DB removed.

## 3. Release Scope Confirmation

- [ ] Release copy does not claim fixed GPT/Gemini/Claude runtime default.
- [ ] Release copy does not claim complete WebSocket streaming.
- [ ] Release copy does not claim complete true same-user workspace switching.
- [ ] Release copy does not claim universal Secretary ownership across all calendar/skill write paths.
- [ ] Release copy does not claim full multi-tenant shared-context mesh safety.
- [ ] Release copy does not claim live-provider fallback quality without bounded provider proof.

## 4. Database And Migration Preflight

- [ ] Review migrations in the release branch.
- [ ] Confirm migrations were rehearsed in local/staging clone where applicable.
- [ ] Take fresh production DB snapshot immediately before deployment.
- [ ] Record snapshot path.
- [ ] Record snapshot size.
- [ ] Record checksum if available.
- [ ] Run integrity check on the snapshot.
- [ ] Confirm rollback owner knows the snapshot path.

Deployment must stop if the fresh snapshot is missing or unreadable.

## 5. Environment And Feature Flags

- [ ] Confirm production database path.
- [ ] Confirm production OAuth/provider credentials remain unchanged unless intentionally rotated.
- [ ] Confirm model provider keys are present only where intended.
- [ ] Confirm Anthropic gate status (`ANTHROPIC_ENABLED`) matches operator intent.
- [ ] Confirm iOS WebSocket/streaming flag is disabled unless streaming is explicitly in scope and smoked.
- [ ] Confirm local-only flags are not set in production:
  - `NEXUS_LOCAL_ALLOW_MODEL_CALLS`
  - `SECRETARY_LOCAL_AGENDA_FIXTURES`
  - `SECRETARY_LOCAL_CALENDAR_MOCK`
  - local fixture DB paths
- [ ] Confirm operator model overrides remain valid and provider-agnostic.

## 6. Staging Deployment Gate

- [ ] Merge or deploy the exact backend RC commit to staging.
- [ ] Confirm staging service booted cleanly.
- [ ] Run focused staging Chat smoke.
- [ ] Run scoped Secretary/calendar smoke if release claims include provider lifecycle.
- [ ] Confirm no staging test calendar events are left behind.
- [ ] Confirm staging logs do not expose raw prompts, private messages, provider tokens, or tenant-private context.
- [ ] Confirm staging model-routing metadata is present without raw prompt leakage.

Required staging smoke result: **PASS**.

If staging result is partial, deployment owner must either fix and rerun or explicitly narrow release scope before production.

## 7. iOS Deployment Gate

- [ ] Confirm iOS production build does not retain local backend override.
- [ ] Confirm app reaches intended staging/production backend.
- [ ] Confirm Chat history loads.
- [ ] Confirm Home/dashboard loads.
- [ ] Confirm Training rich payloads decode.
- [ ] Confirm unknown/future message/block states fall back safely.
- [ ] Confirm no stale tenant cache appears after auth/session changes.
- [ ] Confirm TestFlight/App Store path follows normal signing and release controls.

## 8. Production Promotion

Do not begin this section until staging smoke passes.

- [ ] Fresh production DB snapshot completed immediately before deploy.
- [ ] Production deploy command reviewed by operator.
- [ ] Backend promoted to production.
- [ ] Production service restart/reload completed.
- [ ] PM2/process manager shows expected services online.
- [ ] No migration errors in production logs.
- [ ] No provider-call loop or runaway worker observed.

## 9. Production Health Checks

- [ ] `/api/v1/health` passes.
- [ ] Auth/session endpoint passes.
- [ ] Dashboard/Home endpoint passes.
- [ ] Chat history endpoint passes.
- [ ] Safe Chat send or deterministic fast path passes.
- [ ] Plan today/week passes.
- [ ] Tasks/list endpoints pass.
- [ ] Training summary/today passes.
- [ ] Cooking meal plan passes.
- [ ] Finance summary passes.
- [ ] Content surface passes.
- [ ] Calendar/provider status returns safely.
- [ ] Tenant isolation spot check passes.
- [ ] iOS app reaches production backend.

## 10. Monitoring Activation

- [ ] Monitoring checklist reviewed.
- [ ] Chat errors watched.
- [ ] Tenant auth failures watched.
- [ ] Provider/model routing metadata watched.
- [ ] Calendar duplicate/stale event signals watched.
- [ ] iOS decode/render errors watched.
- [ ] Provider cost/latency/fallback watched.
- [ ] Rollback owner is available.

## Final Deployment Rule

Production promotion is allowed only after:

- all P0 triggers remain false,
- staging smoke passes,
- fresh DB snapshot exists,
- monitoring is active,
- rollback path is ready.
