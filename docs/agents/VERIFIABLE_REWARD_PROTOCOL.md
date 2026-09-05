# Backend Verifiable Reward Protocol

Status: canonical
Owner: backend architecture lead (Felipe)
Last verified: 2026-08-10
Update policy: update when backend-local reward commands, schema, hooks,
or export behavior change.

This is the canonical policy for running the Nexus Verifiable Reward Loop
inside the backend repository.

## Scope

Applies to backend code, backend docs, release scripts, smoke scripts,
provider routing, auth/session/tenant safety, prompt/context/memory boundaries,
calendar/training/cooking/content/finance/secretary behavior, and backend
agent handoffs. Development-process authority lives in
[DEVELOPMENT_PROCESS.md](DEVELOPMENT_PROCESS.md). Read-only/planning answers
require source review, not a tracked handoff or synthetic reward artifact.

V1 is local and advisory by default. It is RLVR-inspired, but not provider-side
fine-tuning.

## Backend command contract

Default advisory run:

```bash
npm run reward:check -- --area auto --advisory
```

With JSON output:

```bash
npm run reward:check:json -- --area backend
```

With an ignored local deliverable summary:

```bash
node scripts/reward-check.mjs --area auto --handoff .local/reward-handoff.md --advisory
```

The retained enforced invocation below validates the PM2 fallback's compact
checksum manifest and completed staging transaction. It is fallback-only and
must not be presented as validation of the signed container path:

```bash
node scripts/reward-check.mjs --area release --enforce \
  --release-manifest .local/release/manifests/<sha>.json \
  --staging-attestation .local/release/transactions/staging-<sha>-<digest>.json \
  --require-staging
```

Current container evidence is the signed OCI payload plus authoritative
root-host state and immutable receipts. Until the local reward checker has an
exact receipt adapter, use advisory mode and report the live portion as
`MANUAL_REQUIRED`; never feed the old checksum shape to manufacture a pass.

## Existing signals to reuse

`scripts/reward-check.mjs` orchestrates these existing signals instead of
duplicating their logic:

- `git status --short --branch`
- `scripts/changed-area-classifier.sh --json`
- `scripts/risk-gate.sh --dry-run`
- `npm run docs:audit`
- `npm run verify` or focused evidence named by the handoff
- `scripts/verify-deliverable.mjs`
- signed OCI release-payload identity plus validated root-host state, immutable
  receipts, staging, production observation, and recovery evidence when area is
  `release`
- iOS build/test evidence on the iOS distribution cadence when an iOS surface
  is in scope; it is not a backend deployment gate

## Verdict priority

Use verdict-first semantics:

- `FAIL` for hard failures, mandatory command failures, fabricated evidence,
  unsafe operations, or failed release/security/auth/tenant/deploy checks.
- `MANUAL_REQUIRED` when proof needs human/device/staging/provider evidence or
  cannot be safely obtained by the local deterministic checker.
- `WARN` for optional-check failure or non-critical hygiene issues.
- `PASS` only when required evidence exists and mandatory checks passed.
- `NOT_APPLICABLE` when no meaningful reward check applies.

The numeric score never overrides a hard failure or missing mandatory evidence.

## Backend hard failures

Hard failures include:

- Touching `.env` or exposing secrets.
- Writing sensitive artifacts outside ignored/approved paths.
- Bypassing provider routing with direct provider APIs in runtime paths.
- Tenant/user isolation bypass.
- Unsafe deploy path or deploy without authorization.
- Missing staging smoke for deploy-critical work without explicit approval.
- `git reset --hard`, force push, shared-branch rebase, broad cleanup, or
  deletion without explicit approval.
- Prohibited `git commit --amend` or `--no-verify`.
- Unsafe production data/log handling.
- Fabricated test/evidence claims.
- Claiming tests passed without command/evidence.
- Migration changes without migration safety evidence.
- Missing required docs update.

## Result summary

Return the compact reward block in the final response or canonical current
release state. Raw JSON stays in `.local/reward-runs/`; do not create tracked
handoffs. Only reviewed, sanitized, export-eligible records may leave `.local/`.

## Export

Use `scripts/export-reward-dataset.mjs` only for reviewed, sanitized,
export-eligible reward runs. The canonical export is provider-neutral Nexus
JSONL. Provider-specific adapters may be added later. Fine-tuning/RFT remains
disabled unless Felipe explicitly approves a later milestone.

## Advisory Stop hook

The hook uses the checker's `auto` area rather than an independent area list.
Only completed PASS/WARN results with all mandatory checks passed are cached,
for at most 30 minutes. Cache identity includes proposed tracked/untracked
bytes, staged changes, verifier/configuration inputs and runtime version.
Failures, timeouts, invalid output and missing mandatory evidence are not
cached. Planning/read-only modes skip the hook. It never grants release or
integration authority and does not replace the risk-selected test run.
